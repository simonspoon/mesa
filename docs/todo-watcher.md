# Todo watcher

`mesa serve --watch-todo` starts a periodic background loop (a fixed-interval
`tokio::spawn`, the first true interval loop in the codebase — everything
else in `src/api.rs` is request-driven or a one-shot fire-and-forget refresh)
that keeps every project's todo backlog moving without a human manually
running `task next` and starting an agent. **Off by default**: auto-spawning
agents is real API cost and real code execution, so it must not fire just
because someone ran `mesa serve`.

- Each tick (`todo_watcher_tick` in `src/api.rs`), for every project with a
  `local_path` that still exists as a directory: if the project has **no**
  `in_progress` task, it calls `Store::next_task` for that project and, on an
  actionable task, immediately flips that task to `in_progress` itself —
  *before* spawning — then calls `agents::spawn_bg(local_path,
  "/execute-mesa-task <task-id>")`. Claiming the task before the spawn closes
  the race window between dispatch and the agent's own `/execute-mesa-task`
  pickup step, so a later tick can't double-dispatch the same task while the
  agent is still starting up. A project with no `local_path`, or a stale one
  (the folder no longer exists), is skipped, same posture as the Agents tab.
- If `spawn_bg` fails (the `claude` CLI missing or erroring), the claimed
  task is reverted back to `todo` so the project isn't wedged — an
  unrecoverable spawn must not silently stop that project from ever being
  picked up again.
- The "in process" signal is task status, not a live-session check (no
  `claude agents` call here) — cheaper, and consistent with how a human
  would read the board. The accepted tradeoff: if a dispatched agent crashes
  before finishing, its task stays `in_progress` and that project goes quiet
  until someone intervenes; the watcher does not detect or recover from a
  dead agent.
- The tick cadence is a fixed internal constant (`WATCH_TODO_TICK`, 60s), not
  user-configurable. `MESA_WATCH_TODO_TICK_MS` overrides it, a test-only seam
  (mirrors `MESA_CLAUDE_BIN`) so `scripts/todo-watcher-check.sh` isn't stuck
  waiting a full tick per assertion.
- The flag is propagated through the web UI's **Restart Server** action the
  same way `--lan` is: `serve`'s post-shutdown relaunch re-execs the binary
  with `--watch-todo` appended when it was set, so restarting the server
  never silently turns the watcher off.
- Gate: `scripts/todo-watcher-check.sh` (flag on/off, dispatch + claim,
  busy-project skip, path-less/stale-path skip, spawn-failure revert)
  against a stub `claude` binary — no CLI surface of its own beyond the
  `serve` flag, matching the Agents tab's "no `mesa agent` CLI" precedent.
