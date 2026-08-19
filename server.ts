import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const COLUMN_IDS = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

const COLUMN_TITLES: Record<ColumnId, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

const columnIdSchema = z.enum(COLUMN_IDS);
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["standard", "personal"]),
});
const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["error", "stopping", "idle", "starting", "active"]),
  providerId: z.string(),
  branchName: z.string().nullable(),
  updatedAt: z.number(),
  isUnread: z.boolean(),
  childCount: z.number().int().nonnegative(),
});
const columnSchema = z.object({
  id: columnIdSchema,
  title: z.string(),
  cards: z.array(cardSchema),
});
const t3LifecycleSchema = z.object({
  rows: z.array(
    z.object({
      threadId: z.string(),
      settledAt: z.number().nullable(),
      snoozedUntil: z.number().nullable(),
      snoozedAt: z.number().nullable(),
    }),
  ),
});

export const rpcContract = defineRpcContract({
  getBoard: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: z.object({
      projects: z.array(projectSchema),
      selectedProjectId: z.string().nullable(),
      columns: z.array(columnSchema),
      settledCards: z.array(cardSchema),
      truncated: z.boolean(),
    }),
  },
  moveCard: {
    input: z
      .object({ threadId: z.string().min(1), columnId: columnIdSchema })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS card_state (
      thread_id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL CHECK (
        column_id IN ('backlog', 'ready', 'in_progress', 'review', 'done')
      ),
      updated_at INTEGER NOT NULL
    )`,
    // Kept as an append-only legacy migration after Linear moved to its own plugin.
    `CREATE TABLE IF NOT EXISTS linear_thread_links (
      issue_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (issue_id, thread_id)
    )`,
  ]);

  const upsertCard = db.prepare(
    `INSERT INTO card_state (thread_id, column_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       column_id = excluded.column_id,
       updated_at = excluded.updated_at`,
  );
  const getCardState = db.prepare(
    "SELECT thread_id, column_id FROM card_state WHERE thread_id = ?",
  );
  const listCardStates = db.prepare(
    "SELECT thread_id, column_id FROM card_state",
  );
  const deleteCardState = db.prepare(
    "DELETE FROM card_state WHERE thread_id = ?",
  );
  function moveCard(threadId: string, columnId: ColumnId) {
    upsertCard.run(threadId, columnId, Date.now());
    bb.realtime.publish("board-changed", { threadId, columnId });
  }

  function currentColumn(threadId: string): ColumnId {
    const row = getCardState.get(threadId) as
      | { thread_id: string; column_id: ColumnId }
      | undefined;
    return row?.column_id ?? "backlog";
  }

  async function listThreads(projectId: string) {
    const pageSize = 200;
    const maxThreads = 1_000;
    const threads = [];

    for (let offset = 0; offset < maxThreads; offset += pageSize) {
      const page = await bb.sdk.threads.list({
        projectId,
        archived: false,
        includeHidden: false,
        limit: pageSize,
        offset,
      });
      threads.push(...page);
      if (page.length < pageSize) return { threads, truncated: false };
    }

    return { threads, truncated: true };
  }

  async function settledAtByThread() {
    try {
      const lifecycle = await bb.sdk.plugins.callRpc({
        pluginId: "t3sidebar",
        method: "listLifecycle",
        input: {},
        outputSchema: t3LifecycleSchema,
      });
      return new Map(
        lifecycle.rows.flatMap(({ threadId, settledAt }) =>
          settledAt === null ? [] : ([[threadId, settledAt]] as const),
        ),
      );
    } catch {
      // T3 Sidebar is optional. Without it, Kanban simply has no settled shelf.
      return new Map<string, number>();
    }
  }

  bb.rpc.register(rpcContract, {
    async getBoard({ projectId }) {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const projectRows = projects.map(({ id, name, kind }) => ({ id, name, kind }));
      const selectedProjectId = projectRows.some(({ id }) => id === projectId)
        ? projectId
        : (projectRows.find(({ kind }) => kind === "standard")?.id ??
          projectRows[0]?.id ??
          null);

      const columns = COLUMN_IDS.map((id) => ({
        id,
        title: COLUMN_TITLES[id],
        cards: [] as Array<z.infer<typeof cardSchema>>,
      }));
      if (!selectedProjectId) {
        return {
          projects: projectRows,
          selectedProjectId,
          columns,
          settledCards: [],
          truncated: false,
        };
      }

      const [{ threads, truncated }, stateRows, settledAt] = await Promise.all([
        listThreads(selectedProjectId),
        Promise.resolve(
          listCardStates.all() as Array<{ thread_id: string; column_id: ColumnId }>,
        ),
        settledAtByThread(),
      ]);
      const stateByThread = new Map(
        stateRows.map((row) => [row.thread_id, row.column_id] as const),
      );
      const childCounts = new Map<string, number>();
      for (const thread of threads) {
        if (thread.parentThreadId) {
          childCounts.set(
            thread.parentThreadId,
            (childCounts.get(thread.parentThreadId) ?? 0) + 1,
          );
        }
      }

      const columnById = new Map(columns.map((column) => [column.id, column]));
      const settledCards: Array<z.infer<typeof cardSchema>> = [];
      for (const thread of threads.sort((a, b) => b.updatedAt - a.updatedAt)) {
        const card = {
          id: thread.id,
          title: thread.title ?? thread.titleFallback ?? "Untitled thread",
          status: thread.status,
          providerId: thread.providerId,
          branchName: thread.environmentBranchName,
          updatedAt: thread.updatedAt,
          isUnread:
            thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt,
          childCount: childCounts.get(thread.id) ?? 0,
        };
        const settledTimestamp = settledAt.get(thread.id);
        const hasLiveWork =
          thread.hasPendingInteraction ||
          thread.activity.activeWorkflowCount > 0 ||
          thread.activity.activeBackgroundAgentCount > 0 ||
          thread.activity.activeBackgroundCommandCount > 0 ||
          thread.activity.activePlanModeCount > 0 ||
          thread.activity.activeGoalCount > 0 ||
          thread.status === "active" ||
          thread.status === "starting" ||
          thread.status === "stopping";
        if (
          settledTimestamp !== undefined &&
          !hasLiveWork &&
          thread.latestAttentionAt <= settledTimestamp
        ) {
          settledCards.push(card);
          continue;
        }
        const columnId = stateByThread.get(thread.id) ?? "backlog";
        columnById.get(columnId)?.cards.push(card);
      }

      return { projects: projectRows, selectedProjectId, columns, settledCards, truncated };
    },

    async moveCard({ threadId, columnId }) {
      await bb.sdk.threads.get({ threadId });
      moveCard(threadId, columnId);
      return { ok: true as const };
    },

  });

  bb.agents.registerTool({
    name: "kanban_move_card",
    description: "Move a bb thread card to a workflow column on the Kanban board.",
    instructions:
      "Keep your own thread card current: use in_progress when starting substantive work, review when human verification is needed, done only when the requested work is genuinely complete, ready when prepared but not started, and backlog when deferred.",
    experimental_statusLabels: {
      pending: "Moving Kanban card",
      completed: "Moved Kanban card",
    },
    parameters: z.object({
      column: columnIdSchema.describe("The workflow column to move the card into."),
      threadId: z
        .string()
        .optional()
        .describe("Thread to move. Omit to move the current agent thread."),
    }),
    async execute({ column, threadId }, context) {
      const targetId = threadId ?? context.threadId;
      const target = await bb.sdk.threads.get({ threadId: targetId });
      if (target.projectId !== context.projectId) {
        return {
          content: [{ type: "text", text: "The target thread is in another project." }],
          isError: true,
        };
      }
      moveCard(targetId, column);
      return `Moved thread ${targetId} to ${COLUMN_TITLES[column]}.`;
    },
  });

  bb.agents.configure(() => ({
    tools: ["kanban_move_card"],
    skills: [],
  }));

  bb.events.on("thread.created", ({ thread }) => {
    moveCard(thread.id, "backlog");
  });
  bb.events.on("thread.active", ({ thread }) => {
    moveCard(thread.id, "in_progress");
  });
  bb.events.on("thread.failed", ({ thread }) => {
    moveCard(thread.id, "review");
  });
  bb.events.on("thread.idle", ({ thread }) => {
    // An agent or person may deliberately leave a card in Review while the
    // thread is idle awaiting verification. Preserve that explicit state;
    // otherwise a completed turn advances automatically to Done.
    if (currentColumn(thread.id) !== "review") moveCard(thread.id, "done");
  });
  bb.events.on("thread.archived", ({ thread }) => {
    moveCard(thread.id, "done");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    deleteCardState.run(thread.id);
    bb.realtime.publish("board-changed", {
      threadId: thread.id,
      event: "thread.deleted",
    });
  });

  bb.log.info("Kanban board loaded");
}
