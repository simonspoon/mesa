# Todo watcher

`mesa serve --watch-todo` starts a periodic background loop (a fixed-interval
`tokio::spawn`, the first true interval loop in the codebase — everything
else in `src/api.rs` is request-driven or a one-shot fire-and-forget refresh)
that keeps every project's todo backlog moving without a human manually
running `task next` and starting an agent. **Off by default**: auto-spawning
agents is real API cost and real code execution, so it must not fire just
because someone ran `mesa serve`.

- The per-tick fan-out is entirely driven by `Store::list_projects()`, which
  excludes archived projects (mesa task 504) — an archived project is never
  auto-dispatched onto (main-loop ruling 1), with no separate check of its
  own: it simply never appears in the list the watcher loops over. Unarchiving
  restores it starting with the next tick. Regression: a Rust unit test
  (`api::tests::todo_watcher_tick_skips_archived_project_dispatches_normal_one`)
  calls `todo_watcher_tick` directly against an archived + a normal project so
  the exclusion can't silently regress if `list_projects()` were ever swapped
  for `list_projects_all()`; `scripts/todo-watcher-check.sh` covers the same
  behavior end-to-end through the real dispatch loop.
- Each tick (`todo_watcher_tick` in `src/api.rs`), for every project with a
  `local_path` that still exists as a directory: if the project has **no**
  `in_progress` leaf task (see the umbrella rule below), it calls
  `Store::next_task` for that project and, on an
  actionable task, immediately flips that task to `in_progress` itself —
  *before* spawning — then calls `agents::spawn_bg(local_path,
  "/execute-mesa-task <task-id>", Some("<project name>: <task title>"))`. The
  name reaches `claude --bg` as `-n/--name`, so the auto-dispatched session
  shows up identifiably (prompt box, `/resume` picker, terminal title, Agents
  sidebar) instead of generically. Claiming the task before the spawn closes
  the race window between dispatch and the agent's own `/execute-mesa-task`
  pickup step, so a later tick can't double-dispatch the same task while the
  agent is still starting up. A project with no `local_path`, or a stale one
  (the folder no longer exists), is skipped, matching the agents endpoint.
- **An `in_progress` task that has subtasks is an *umbrella*, not a worker,
  and does not make its project busy** (mesa task 570). Before this rule, one
  epic parent held `in_progress` to "represent" its open children stopped the
  entire project from ever being dispatched again — the board looked
  correctly populated with `todo` work, nothing moved, and nothing anywhere
  said why. "Busy" is therefore an `in_progress` **leaf** (a task that is
  nobody's parent), not any `in_progress` row.
  - A project whose only `in_progress` tasks are umbrellas stays
    dispatchable, but the pick narrows: `Store::next_subtask(&parent_ids)`
    instead of `Store::next_task(Some(project))`. `next_subtask` walks a
    recursive CTE over `parent_id` (descendants at any depth, the parents
    themselves excluded) and applies the *same* `todo`-and-not-blocked rule
    and the same priority-then-id ordering — both queries share the
    `BLOCKED_EXPR` / `PRIORITY_RANK` consts in `src/core/store.rs`, so they
    cannot drift on what "actionable" means.
  - So an open umbrella unblocks **its own children and nothing else**: the
    watcher never starts unrelated work alongside a parent someone is still
    holding. An umbrella whose subtree holds nothing actionable leaves the
    project parked exactly as before, which is the conservative half of the
    rule — the exemption is scoped to what the umbrella is for.
  - **The watcher only ever claims an actionable *leaf*.** Whatever the pick
    (`next_task` or `next_subtask`), `deepest_actionable` walks it down to
    its top-ranked actionable descendant first. This is what holds the
    one-watcher-agent-per-project line, and it is not optional: claiming a
    task that still has actionable subtasks would make that very task read
    as an umbrella one tick later, and the watcher would spawn a *second*
    agent onto one of its own children in the same repo. An epic is
    therefore dispatched only once its subtree is exhausted — the roll-up
    moment its acceptance describes — and while it holds that claim its
    (now-empty) subtree parks the project, exactly like a busy leaf.
  - The dispatched child is itself a leaf, so it re-marks the project busy on
    the next tick: children are serialized one at a time.
  - Residual, inherent to the "status, not liveness" signal above: a *new*
    subtask created under an already-`in_progress` task mid-run turns that
    task into an umbrella, so the next tick dispatches the new child
    alongside whoever holds the parent. That is the feature the ticket asked
    for; it is only surprising if the parent was a leaf when its agent
    started.
  - Regressions: `api::tests::todo_watcher_tick_dispatches_subtask_under_in_progress_parent`
    (whole lifecycle: first child dispatched, siblings and unrelated tasks
    wait, exhausted subtree does not fall back, closing the umbrella resumes
    whole-backlog dispatch) plus
    `core::store::tests::next_subtask_scopes_to_descendants_shares_next_task_rules`,
    and the same lifecycle end-to-end in `scripts/todo-watcher-check.sh`.
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
  busy-project skip, path-less/stale-path skip, spawn-failure revert,
  archived-project skip + unarchive-resumes-dispatch, umbrella
  subtask-dispatch lifecycle) against a stub `claude`
  binary — no CLI surface of its own beyond the `serve` flag, matching the
  agents surface's "no `mesa agent` CLI" precedent.
