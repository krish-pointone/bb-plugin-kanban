import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";

type ColumnId = "backlog" | "ready" | "in_progress" | "review" | "done";

interface CardRow {
  id: string;
  title: string;
  status: "error" | "stopping" | "idle" | "starting" | "active";
  providerId: string;
  branchName: string | null;
  updatedAt: number;
  isUnread: boolean;
  childCount: number;
}

interface BoardState {
  projects: Array<{ id: string; name: string; kind: "standard" | "personal" }>;
  selectedProjectId: string | null;
  columns: Array<{ id: ColumnId; title: string; cards: CardRow[] }>;
  settledCards: CardRow[];
  truncated: boolean;
}

function ThreadStatusIcon({ status }: { status: CardRow["status"] }) {
  const props: Record<
    CardRow["status"],
    { name: "Spinner" | "CircleDashed" | "CircleX" | "CircleCheck"; className: string }
  > = {
    active: { name: "Spinner", className: "animate-spin text-primary" },
    starting: { name: "Spinner", className: "animate-spin text-warning" },
    stopping: { name: "CircleDashed", className: "text-warning" },
    error: { name: "CircleX", className: "text-destructive" },
    idle: { name: "CircleCheck", className: "text-muted-foreground" },
  };
  const icon = props[status];
  return (
    <Icon
      name={icon.name}
      className={`mt-0.5 size-4 shrink-0 ${icon.className}`}
      aria-label={status}
    />
  );
}

function ColumnIcon({ column }: { column: ColumnId }) {
  const icons: Record<
    ColumnId,
    "Archive" | "Circle" | "Spinner" | "Eye" | "CircleCheck"
  > = {
    backlog: "Archive",
    ready: "Circle",
    in_progress: "Spinner",
    review: "Eye",
    done: "CircleCheck",
  };
  return (
    <Icon
      name={icons[column]}
      className={`size-4 text-muted-foreground ${column === "in_progress" ? "animate-spin" : ""}`}
      aria-hidden
    />
  );
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function Board() {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const realtimeState = useRealtimeConnectionState();
  const [projectId, setProjectId] = useState<string | null>(context.projectId);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [movingThreadId, setMovingThreadId] = useState<string | null>(null);
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await rpc.call("getBoard", { projectId });
      setBoard(next);
      if (next.selectedProjectId !== projectId) setProjectId(next.selectedProjectId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the board");
    } finally {
      setLoading(false);
    }
  }, [projectId, rpc]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useRealtime("board-changed", () => void load());

  useEffect(() => {
    if (realtimeState === "connected") void load();
  }, [realtimeState, load]);

  // Settled state belongs to T3 Sidebar, whose realtime channel is scoped to
  // that plugin. A small foreground poll keeps this cross-plugin shelf fresh.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const totalCards = useMemo(
    () => board?.columns.reduce((sum, column) => sum + column.cards.length, 0) ?? 0,
    [board],
  );

  async function moveCard(threadId: string, columnId: ColumnId) {
    if (movingThreadId) return;
    setMovingThreadId(threadId);
    try {
      await rpc.call("moveCard", { threadId, columnId });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not move the card");
    } finally {
      setMovingThreadId(null);
      setDraggedThreadId(null);
    }
  }

  if (loading && !board) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading board…
      </div>
    );
  }

  if (!board?.projects.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="rounded-full bg-muted p-3"><Icon name="Folder" className="size-5" /></div>
        <div>
          <p className="font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a bb project, then its threads will appear here as cards.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <select
          aria-label="Board project"
          className="h-9 min-w-48 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs outline-none focus:ring-2 focus:ring-ring"
          value={board.selectedProjectId ?? ""}
          onChange={(event) => setProjectId(event.target.value || null)}
        >
          {board.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}{project.kind === "personal" ? " (Personal)" : ""}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">
          {totalCards} {totalCards === 1 ? "thread" : "threads"}
        </span>
        {board.truncated ? (
          <span className="rounded-full bg-warning/15 px-2 py-1 text-xs text-warning-foreground">
            Showing newest 1,000
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {realtimeState === "connected" ? "Live" : "Reconnecting…"}
          </span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <Icon name="RotateCcw" className="size-4" aria-hidden />
            Refresh
          </Button>
          <Button size="sm" onClick={() => navigate.toCompose({ focusPrompt: true })}>
            <Icon name="Plus" className="size-4" aria-hidden />
            New thread
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div className="grid h-full min-w-[1180px] grid-cols-5 gap-3">
          {board.columns.map((column) => (
            <section
              key={column.id}
              className={`flex min-h-0 flex-col rounded-xl border bg-muted/25 transition-colors ${draggedThreadId ? "border-primary/35" : "border-border"}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const threadId = event.dataTransfer.getData("text/plain") || draggedThreadId;
                if (threadId) void moveCard(threadId, column.id);
              }}
            >
              <header className="flex items-center justify-between px-3 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <ColumnIcon column={column.id} />
                  {column.title}
                </h2>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                  {column.cards.length}
                </span>
              </header>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {column.cards.map((card) => (
                  <article
                    key={card.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", card.id);
                      setDraggedThreadId(card.id);
                    }}
                    onDragEnd={() => setDraggedThreadId(null)}
                    onClick={() => navigate.toThread(card.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") navigate.toThread(card.id);
                    }}
                    role="button"
                    tabIndex={0}
                    className={`group cursor-grab rounded-lg border border-border bg-card p-3 shadow-xs transition hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing ${movingThreadId === card.id ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <ThreadStatusIcon status={card.status} />
                      <p className="min-w-0 flex-1 text-sm font-medium leading-5">{card.title}</p>
                      {card.isUnread ? <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" title="Unread" /> : null}
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{card.providerId}</span>
                      {card.branchName ? <><span aria-hidden>·</span><span className="min-w-0 truncate">{card.branchName}</span></> : null}
                      <span className="ml-auto shrink-0">{relativeTime(card.updatedAt)}</span>
                    </div>
                    {card.childCount > 0 ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {card.childCount} {card.childCount === 1 ? "subagent" : "subagents"}
                      </div>
                    ) : null}
                  </article>
                ))}
                {column.cards.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                    Drop a thread here
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </div>

      {board.settledCards.length > 0 ? (
        <section className="shrink-0 border-t border-border bg-muted/20" aria-label="Settled threads">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium hover:bg-muted/60"
            aria-expanded={showSettled}
            onClick={() => setShowSettled((open) => !open)}
          >
            <Icon name="Archive" className="size-4 text-muted-foreground" aria-hidden />
            Settled
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
              {board.settledCards.length}
            </span>
            <Icon
              name="ChevronDown"
              className={`ml-auto size-4 text-muted-foreground transition-transform ${showSettled ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
          {showSettled ? (
            <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto border-t border-border px-4 py-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {board.settledCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left shadow-xs transition hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => navigate.toThread(card.id)}
                >
                  <ThreadStatusIcon status={card.status} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(card.updatedAt)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "kanban-board",
    title: "Kanban",
    icon: "Columns",
    path: "board",
    component: Board,
  });
});
