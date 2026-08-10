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
- Each tick (`todo_watcher_tick` in `src/api.rs`) reads the configured
  **per-project concurrency limit** from `~/.mesa/config.json`
  (`watchers.todo-concurrency`, `docs/config.md`) fresh — no caching, no
  restart, so a saved change takes effect on the very next tick. If the read
  fails (malformed file), the tick `eprintln!`s and returns without
  dispatching anything, rather than guessing a limit. For every
  project with a `local_path` that still exists as a directory, the tick
  counts that project's occupied slots — `max(in_progress leaves,
  live-work sessions)`, see below — and, if the count is under the limit,
  dispatches
  actionable tasks to fill the gap — up to `limit - count` in that one tick,
  not just one. Each dispatch calls `Store::next_task` for that project and, on an
  actionable task, immediately flips that task to `in_progress` itself —
  *before* spawning — then calls `agents::spawn_bg` for the **`todo-watcher`**
  command, with the task id and the session name `<project name>: <task name>`
  as its `{id}`/`{name}`. **The command line itself — including which slash
  command runs — is user-configurable** in `~/.mesa/config.json`
  (`docs/config.md`); its default is
  `{bin} --bg --agent {agent} --name {name} -- "/execute-mesa-task {id}"`, so
  by default the name reaches `claude --bg` as `-n/--name` and the
  auto-dispatched session shows up identifiably (prompt box, `/resume` picker,
  terminal title, Agents sidebar) instead of generically, running under the
  `swe` agent persona (`MESA_CLAUDE_AGENT`, `docs/agents.md`). Deriving the
  name is still mesa's job, not the template's: a template chooses whether to
  pass it. Claiming the task before the spawn closes
  the race window between dispatch and the agent's own `/execute-mesa-task`
  pickup step, so a later tick can't double-dispatch the same task while the
  agent is still starting up. A project with no `local_path`, or a stale one
  (the folder no longer exists), is skipped, matching the agents endpoint.
- **An `in_progress` task that has subtasks is an *umbrella*, not a worker,
  and does not count toward its project's limit** (mesa task 570). Before this
  rule, one epic parent held `in_progress` to "represent" its open children
  stopped the entire project from ever being dispatched again — the board
  looked correctly populated with `todo` work, nothing moved, and nothing
  anywhere said why. "Busy" is therefore counted over `in_progress` **leaves**
  (a task that is nobody's parent), not any `in_progress` row.
  - A project that still has room under its limit (counting only leaves)
    stays dispatchable, but while any of its `in_progress` tasks are
    umbrellas the pick narrows: `Store::next_subtask(&parent_ids)` instead of
    `Store::next_task(Some(project))`. `next_subtask` walks a recursive CTE
    over `parent_id` (descendants at any depth, the parents themselves
    excluded) and applies the *same* `todo`-and-not-blocked rule and the same
    priority-then-id ordering — both queries share the `BLOCKED_EXPR` /
    `PRIORITY_RANK` consts in `src/core/store.rs`, so they cannot drift on
    what "actionable" means.
  - So an open umbrella unblocks **its own children and nothing else**: the
    watcher never starts unrelated work alongside a parent someone is still
    holding. An umbrella whose subtree holds nothing actionable leaves the
    project parked exactly as before, which is the conservative half of the
    rule — the exemption is scoped to what the umbrella is for.
  - **The watcher only ever claims an actionable *leaf*.** Whatever the pick
    (`next_task` or `next_subtask`), `deepest_actionable` walks it down to
    its top-ranked actionable descendant first. This is what holds the
    at-most-`limit`-agents-per-project line, and it is not optional: claiming
    a task that still has actionable subtasks would make that very task read
    as an umbrella one tick later, and the watcher would spawn one *extra*
    agent onto one of its own children in the same repo, over the limit. An
    epic is therefore dispatched only once its subtree is exhausted — the
    roll-up moment its acceptance describes — and while it holds that claim
    its (now-empty) subtree counts toward the project's limit, exactly like
    an ordinary busy leaf.
  - The dispatched child is itself a leaf, so it counts toward the limit on
    the next tick like any other leaf.
  - Residual, inherent to the "status, not liveness" signal above: a *new*
    subtask created under an already-`in_progress` task mid-run turns that
    task into an umbrella, so the next tick dispatches the new child
    alongside whoever holds the parent. That is the feature the ticket asked
    for; it is only surprising if the parent was a leaf when its agent
    started. An agent that means to orchestrate its own children takes the
    `backlog` opt-out below rather than racing the tick.
  - Regressions: `api::tests::todo_watcher_tick_dispatches_subtask_under_in_progress_parent`
    (whole lifecycle: first child dispatched, siblings and unrelated tasks
    wait, exhausted subtree does not fall back, closing the umbrella resumes
    whole-backlog dispatch) plus
    `core::store::tests::next_subtask_scopes_to_descendants_shares_next_task_rules`,
    and the same lifecycle end-to-end in `scripts/todo-watcher-check.sh`.
- **`backlog` is the agent-side opt-out, and the only one** (mesa task 613).
  Both picks filter `status = 'todo'`, so a `backlog` task is invisible to the
  watcher on either path — an agent that authors tasks it intends to dispatch
  itself (a planner writing stories, any agent creating subtasks mid-run)
  creates them `--status backlog` and flips each to `in_progress` at the
  moment it hands the work out. Left as `todo`, they are simply unclaimed
  work in a project the watcher serves, and it will dispatch one within a
  tick — correctly, by its own rule. Note what does *not* help: a `claim`
  does not gate dispatch (`next_task` only ever returns `todo` rows, so the
  claim is already invisible to it), and `updated_at` freshness is not
  consulted at all. Regression:
  `api::tests::todo_watcher_tick_never_dispatches_backlog_tasks` (both picks,
  plus release-to-`todo` dispatching normally, so the opt-out is proven to be
  the status and nothing else).
- If `spawn_bg` fails (the `claude` CLI missing or erroring), the claimed
  task is reverted back to `todo` so the project isn't wedged — an
  unrecoverable spawn must not silently stop that project from ever being
  picked up again.
- **A project's occupied slots are `max(in_progress leaves, live-work
  sessions)`** (mesa task 802). The second signal is the number of `claude`
  sessions whose `cwd` is under this project's `local_path` (the same
  `agents::is_under` the agents endpoints use) that hold a live shell child or
  a live subagent — `pid.is_some() && liveShells + liveSubagents > 0`,
  `docs/agents.md`. Upstream buckets a session `done` as soon as its turn ends,
  while the Bash call that turn started is still running; mesa believed it, and
  filled the slot with a second agent in the same checkout. The session list is
  fetched **before** the store lock is taken — it is a `claude` shell-out, and
  holding the lock across it would freeze every other request.
  - **`max`, not a sum.** A session working a genuinely `in_progress` leaf is
    both signals at once, so adding them would count it twice and halve the
    effective limit.
  - The signal is deliberately **one-directional**: live work can only
    *withhold* dispatch, never authorize it. So a failing `claude agents`
    **fails open** — it `eprintln!`s and counts as *zero* live sessions rather
    than skipping the tick, because a broken liveness probe must not park the
    watcher, and the task-status half still stands on its own.
- Residual risks, both inherent to the two signals above:
  - Task status is a **status**, not a liveness check: if a dispatched agent
    crashes before finishing, its task stays `in_progress` and that project
    goes quiet until someone edits the row.
  - A genuinely long-running background shell (a `sleep`, a watch loop, a
    server an agent left running under its session) parks that project's slot
    until the process exits. That is intended — there really is work in
    flight, and the alternative is a second agent in the same checkout — and
    unlike a stuck `in_progress` row it is **self-clearing**: the slot frees
    itself the moment the process dies, with no db edit. Killing the agent (or
    just its shell) is the escape hatch.
- **`refine` is invisible here too, and that is the whole point of the
  column.** Both picks filter `status = 'todo'`, so a task parked in `refine`
  (`docs/refine-watcher.md`) is no more actionable than a `backlog` one. The
  two watchers therefore never contend: `--watch-refine` empties the refine
  column by moving tasks to `todo`, at which point this watcher may dispatch
  them as ordinary work.
- **Lowering the limit never touches in-flight work.** The config is read at
  the top of every tick, but a lower value only narrows how many *new* tasks
  the tick is willing to pick — an already-`in_progress` leaf stays
  `in_progress` regardless. If the current leaf count is already at or above
  the (now-lower) limit, the tick simply dispatches nothing new until enough
  of them finish to drop the count back under it.
- The tick cadence is a fixed internal constant (`WATCH_TODO_TICK`, 60s), not
  user-configurable. `MESA_WATCH_TODO_TICK_MS` overrides it, a test-only seam
  (mirrors `MESA_CLAUDE_BIN`) so `scripts/todo-watcher-check.sh` isn't stuck
  waiting a full tick per assertion.
- The flag is propagated through the web UI's **Restart Server** action the
  same way `--lan` is: `serve`'s post-shutdown relaunch re-execs the binary
  with `--watch-todo` appended when it was set, so restarting the server
  never silently turns the watcher off.
- Gate: `scripts/todo-watcher-check.sh` (flag on/off, dispatch + claim,
  at-the-limit skip, path-less/stale-path skip, spawn-failure revert,
  archived-project skip + unarchive-resumes-dispatch, umbrella
  subtask-dispatch lifecycle, a configured `todo-concurrency` filling to the
  limit in one tick and picking up the next task once one finishes, a real
  process holding a real shell child parking the slot until it is killed, and
  the fail-open path where an erroring `agents` probe still dispatches)
  against a stub `claude`
  binary — no CLI surface of its own beyond the `serve` flag, matching the
  agents surface's "no `mesa agent` CLI" precedent.
