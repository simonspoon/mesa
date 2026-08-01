# Refine watcher

`refine` is a board column that sits **before `todo`**: a task whose
description isn't sharp enough to hand to an executing agent yet. `mesa serve
--watch-refine` starts a periodic background loop that empties that column —
for one task per project per tick it starts a background `claude` session
whose prompt is "read this task, clarify it, rewrite its `description` and
`acceptance`, then move it to `todo`". The third sibling of the todo watcher
(`docs/todo-watcher.md`) and the inbox watcher (`docs/inbox-watcher.md`),
built on the same machinery over a different queue. **Off by default**, for
the same reason as both: auto-spawning agents is real API cost and real code
execution, so it must not fire just because someone ran `mesa serve`.

The three flags are **independent** — none implies another, and each drives
its own interval loop with its own tick constant (`WATCH_REFINE_TICK`, 60s;
`MESA_WATCH_REFINE_TICK_MS` is the test seam, mirroring the other two). Like
`--watch-todo` and `--watch-inbox`, the flag is re-appended when the web UI's
**Restart server** action re-execs the binary, so a restart never silently
turns the watcher off.

## The status

`Status::Refine` (`refine`) is an ordinary status in every surface that takes
one: `task create --status refine`, `task update --status refine`, `task list
--status refine`, `PATCH {"status": "refine"}`, the board column, the task
panel's status select. Two things follow from where it sits, and both are
structural rather than enforced by a rule of their own:

- **The todo watcher can never see it.** `Store::next_task` and
  `next_subtask` both filter `status = 'todo'`, so a refine task is not
  actionable, is not counted in any `next` bucket, and is never claimed by a
  dispatch. That is what lets `--watch-todo` and `--watch-refine` run together
  without contending: they read disjoint columns.
- **It still blocks dependents.** `Status::is_complete` is `done`/`cancelled`
  only, so a task waiting on a refine task reads `blocked`, exactly as it
  would for `todo` or `backlog`. `refine` is unfinished work, not a parked
  one.

`backlog` remains the "not queued at all" state and the agent-side opt-out
from auto-dispatch (`docs/todo-watcher.md`); `refine` is the opposite posture —
queued, and explicitly asking for an agent's attention first.

## How one tick works

`refine_watcher_tick` in `src/api.rs`, for every project with a `local_path`
that still exists as a directory:

- Reads the whole column once (`Store::list_refine_tasks(None)` — priority
  then id, the same rank the todo watcher dispatches in, and archived
  projects excluded exactly as they are there), then takes that project's
  first task that this process has not already dispatched.
- Spawns `agents::spawn_bg` for the **`refine-watcher`** command in the
  project's folder, with the task id as `{id}` and `<project name>: <task
  name>` as `{name}` — so the session is identifiable in the prompt box,
  `/resume` picker, terminal title and Agents sidebar, like every other
  mesa-started session.
- Two-phase, like every other spawn site here: the store lock is held only
  long enough to pick and claim, then dropped before the blocking `claude
  --bg` shell-outs. Holding it across a spawn freezes every other API request
  for the duration — a regression this codebase has shipped once already.

**The command, including the entire refinement prompt, is user-configurable**
in `~/.mesa/config.json` (`docs/config.md`). Its built-in default is the only
one of the four that is prose rather than a slash command:

```
{bin} --bg --agent {agent} --name {name} -- "First use `mesa` to get the task
info from id {id}. Then refine the task: clarify anything ambiguous and
rewrite its description and acceptance fields. When you are done change the
status to 'todo'."
```

That is deliberate: refinement needs no repo-side skill file to exist before
the feature works, so mesa ships a prompt that stands on its own. Point the
key at `/your-refine-skill {id}` if you have one. Quoting matters for the same
reason as the other defaults — the whole sentence is **one** argv entry, and
`{id}` is substituted after tokenization, so nothing about it can re-split.

## Three deliberate differences from the todo watcher

- **Dispatch is not a status claim.** The todo watcher flips its task to
  `in_progress` before spawning. There is no equivalent intermediate status
  here, and `in_progress` would be a lie twice over: nobody is *executing* the
  task, and a non-umbrella `in_progress` leaf marks its whole project busy,
  which would park the todo watcher behind a wording pass. The task therefore
  stays in `refine` for the whole session, and **the agent's own move to
  `todo` is what ends the refinement** — the same event that hands the task to
  the todo watcher.
- **A busy project is refined anyway.** Refinement is text work on a task
  nobody is running; parking it behind whatever the todo watcher happens to be
  executing would leave the column stuck for hours at a time.
- **One dispatch per project per tick.** A column holding forty vague tasks
  must not become forty concurrent agents in one working folder. The column
  drains over consecutive ticks instead, head first.

## The dedup set

With no status claim, `AppState::refine_dispatched` — an in-memory set of task
ids — is the only thing that stops a re-dispatch on the very next tick. Same
shape and same rationale as the inbox watcher's (`docs/inbox-watcher.md`):

- Ids are claimed **before** the spawn, closing the window where a second tick
  fires while `claude --bg` is still starting up, and released again only if
  the spawn failed — so a transient `claude` failure retries next tick instead
  of stranding the task in the column forever. That is this watcher's version
  of the todo watcher's revert-to-`todo`.
- The set is **pruned each tick to the ids still sitting in `refine`**, so it
  can't grow unboundedly, and a task that leaves and later returns to the
  column gets a fresh pass. It tracks the column, not the task's whole life.
- It is **not persisted**. A restart re-refines whatever is still in the
  column, which is the recoverable direction: a duplicate refinement of one
  task is cheap, a permanently skipped one is not.

The residual is the same one every status-not-liveness signal here carries: if
a dispatched agent dies before moving the task on, that task sits in `refine`
until the server restarts or someone moves it by hand. The watcher does not
detect or recover from a dead agent.

## Gate

`scripts/refine-watcher-check.sh` — flag on/off; `--watch-todo` alone proven
never to touch the column (and vice versa); the built-in prompt's cwd, session
name, `--agent swe` and one-argument-with-`{id}` shape; dispatch claiming no
status; a busy project refined anyway; one-per-tick drip with no
re-dispatch; a path-less project skipped; the move to `todo` ending it; a task
returned to the column refined again; spawn-failure retry; and archived
projects skipped until unarchived. Rust-side: `refine_watcher_tick_*` in
`src/api.rs` and `refine_tasks_are_listed_by_rank_and_never_dispatched_as_todo`
/ `list_refine_tasks_unscoped_excludes_archived_project` in
`src/core/store.rs`. `scripts/config-check.sh` covers the `refine-watcher`
config key alongside the other three.
