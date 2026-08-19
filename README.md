# Kanban for bb

A native board where every card is a bb thread.

- Drag cards between Backlog, Ready, In progress, Review, and Done.
- Cards move automatically as thread lifecycle events fire.
- Threads settled in T3 Sidebar move to a separate shelf that is collapsed by default.
- Agents can keep cards current with the `kanban_move_card` tool.
- Review is preserved while a thread waits for human verification.

```sh
npm install --include=dev
npm run typecheck
npm run build
bb plugin install . --yes
```
