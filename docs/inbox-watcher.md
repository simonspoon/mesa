# Inbox watcher

`mesa serve --watch-inbox` starts a periodic background loop that auto-triages
the global inbox: for every pending **change request** it starts a background
`claude` session as the **`inbox-triage` agent definition** with the prompt
`Triage mesa inbox item <item-id>.`, so items stop accumulating until a
human gets to them. That command is the default of the **`inbox-watcher`** key
in `~/.mesa/config.json` and is user-configurable, agent included
(`docs/config.md`); `{id}` is the item id and `{name}` the session name derived
below.

## The triage agent

Triage is an **agent definition, not a slash command** (mesa task 1168). The
recorded reason: a slash command needs a host persona and runs with that
persona's model and tools, and the `/inbox-triage` phrase the old default
spawned was never registered anywhere — it was a plugin skill matched by
name, and the library prompt that shared its name was an orphan nothing
invoked, with rules that had drifted from the skill's. An agent definition
carries its own model (`opus` at medium effort), its own tool list with
**no `Edit`/`Write`/`NotebookEdit`** so a triage can never touch project
code, and lives in the library as one source of truth synced to
`.claude/agents/inbox-triage.md`.

The definition is the `inbox-triage` library built-in
(`core::inbox_triage::INBOX_TRIAGE_DEFINITION`, `docs/library.md`), seeded to
`~/.claude/agents/inbox-triage.md` by
`core::inbox_triage::ensure_agent_definition` **before every spawn** —
exactly as `naru-live` and `supervisor` are — from the effective row (a fork
if the user made one, else the built-in) and **never overwriting an existing
file**; after the first seed the file belongs to the sync flow. A seed failure
is a failed spawn: the item's claim is released and the next tick retries.
Edit it on `#/library` like any other agent.

What the agent does with an item, in short: a `task-summary` is a report or an
alert for a person, so it is read and — if it is a close-out summary of its
own task — archived with a reason, the summary copied into the task's
`result` first if that is still null; a `change-request` is checked for a
confident project, then for being a duplicate (detail appended to the open
task, item archived `duplicate of task <id>`), already shipped (`git log`
since the item was sent, runtime claims reproduced, item archived `shipped in
<sha>`) or not actionable (archived with a reason saying why); real work is
`mesa inbox assign`ed into that project's **backlog** and the task's
description and acceptance sharpened; and an item with no confident project
is left in place, read, with the ambiguity named. Never guess a project,
never delete an item whose request is not captured somewhere first, never
edit project code. The sibling of the todo watcher (`docs/todo-watcher.md`),
built on the same machinery, over a different queue. **Off by default**, for
the same reason: auto-spawning agents is real API cost and real code
execution, so it must not fire just because someone ran `mesa serve`.

The two watcher flags (`--watch-todo` and `--watch-inbox`) are **independent**
— neither implies the other, and each drives its own interval loop with its own
tick constant. `--watch-inbox` alone never claims a task or dispatches
`/execute-mesa-task`.

## How one tick works

`inbox_watcher_tick` in `src/api.rs`:

- Lists the whole inbox (`Store::list_inbox_items(None)`), keeps the items
  that are **pending** — `api::inbox_item_pending`, the one definition: the
  `kind` is `change-request` (mesa task 846 — a `task-summary` is an
  agent reporting to a person, so there is nothing to triage, and answering
  every close-out report with an agent is exactly what the kind exists to
  stop; the kind never changes, so the skip is permanent rather than a wait,
  and a skipped item is not even claimed in the dedup set) **and** the item is
  not archived (mesa task 1192 — archiving with a reason is the triage
  agent's own verdict on a duplicate, shipped or non-actionable request, and
  the listing still carries the row; before this check the dispatch read
  every listed change request as pending and only the in-memory dedup set
  below held the archived ones back, which every server restart empties, so
  every restart re-triaged every archived request; an un-archived item is
  pending again and is picked up) — then dispatches
  **every** one of those this process has not already dispatched — all of them
  in the same tick. Unlike the todo watcher, which is naturally capped at one
  agent per project, the inbox is one **global** queue with no per-project
  structure to pace it. A server started against a large backlog therefore
  fans out that many agents at once; that is the chosen behavior, not an
  oversight (mesa task 544).
- cwd is **`~/.mesa/workspace`**, not a project folder — the same
  `config::workspace_dir()` the global Terminal page uses, created on demand
  because Claude Code never persists folder trust for the home directory. An
  inbox item belongs to no project (`project_id` is null for its whole life,
  see `docs/inbox.md`), so there is no `local_path` to spawn in; the triage
  skill derives the project itself and reads each candidate repo by absolute
  path. Consequence: these sessions appear in the **global** Agent sidebar
  only, never under a project's Agents tab. It runs as the `inbox-triage`
  agent definition, named literally in the `inbox-watcher` default template
  (`docs/config.md`), seeded to disk first (above).
- The session name is `inbox <id>: <first non-empty body line>`, truncated to
  60 **chars** (not bytes — bodies are free text and may be non-ASCII). It
  reaches `claude` as `-n/--name`, so an auto-dispatched triage session is
  identifiable in the prompt box, `/resume` picker, terminal title and Agents
  sidebar — same rationale as the todo watcher's `<project>: <name>`.
- Two-phase, like `todo_watcher_tick` and `spawn_project_agent`: the store
  lock is dropped before the blocking `claude --bg` shell-outs. Holding it
  across a spawn freezes every other API request for the duration of each
  spawn — a regression this codebase has shipped once already, caught by
  review rather than by any test (the gate's stub returns instantly, so the
  stall is invisible to it).

## The dedup set — why it exists

An inbox item has **no status column** to claim with (an item *is* the record;
`docs/inbox.md`), so there is no equivalent of the todo watcher's flip to
`in_progress`. The stand-in is `AppState::inbox_dispatched`, an in-memory set
of dispatched item ids.

It is load-bearing, not an optimization. Two of the triage agent's three
outcomes remove the item from the live inbox — a real request is converted
into a backlog task by `assign_inbox_item`; a duplicate, shipped or
non-actionable one is archived with a reason — but the third,
**no confident project match**, deliberately leaves the item untouched.
Without the set, that item would respawn an agent every tick, forever.

- Ids are claimed **before** the spawn, closing the window in which a second
  tick fires while `claude --bg` is still starting up.
- A spawn failure **releases** the id, so a transient `claude` outage retries
  on the next tick instead of silently dropping the item — the inbox
  equivalent of the todo watcher's revert-to-`todo`.
- The set is pruned each tick to the ids still present in the inbox, so it
  cannot grow unboundedly on a long-lived server. (SQLite may reuse a deleted
  row's id; pruning is what makes that safe — a reused id is a genuinely new
  item and should be triaged.)
- It is deliberately **not persisted**. A restart re-triages whatever is still
  sitting in the inbox. That is the recoverable direction: a duplicate triage
  of an item is cheap and the agent is idempotent enough to reach the same
  verdict, whereas a permanently skipped item is invisible. Persisting it
  would need a schema migration to store state about an entity whose whole
  design is "an item *is* the record".

## The reaper — stopping a triage session once its item is triaged

A triage session used to be never stopped (mesa task 1192): the watcher only
ever started agents, so a session that had archived or assigned its item sat
idle for hours per item. It is now reaped by the **todo-watcher's reaper**
(`todo_reaper_tick`, mesa task 1057, `docs/todo-watcher.md`) — the same
mechanism, not a second one. A successful dispatch records the short job id
off `claude --bg`'s `backgrounded · <id>` receipt in `AppState::todo_dispatched`
as a `DispatchTarget::InboxItem`, beside the todo-watcher's tasks, and the
reaper loop (`WATCH_TODO_REAP_TICK`, 20s, sharing `MESA_WATCH_TODO_TICK_MS`)
starts under `--watch-inbox` as well as `--watch-todo`.

- Each pass reads the item and looks the job up in one `claude agents` listing,
  then asks `reap_verdict` exactly what it asks for a task, with "still mine"
  = the item is still **pending** (present and not archived — the same
  `inbox_item_pending` the dispatch reads). The item gone (assigned or
  deleted) or archived is a triage that ended: the session is stopped with
  `claude stop <job id>` (`agents::stop`, the same binary and the same
  `MESA_CLAUDE_BIN` seam the spawn went through), **exactly once**, and the
  entry forgotten. A **`busy`** session is left for the next pass, since it
  is probably still writing its verdict; a session with live shell/subagent
  work is waited out for the todo reaper's `REAP_LIVE_WORK_GRACE`, then
  stopped.
- The reaper's three inbox alerts (live work after close, abandoned,
  stalled) are the todo-watcher's — each is filed against a task, which a
  triage session has none of — so for a triage session they are one stderr
  line each and otherwise the plain verdict under them: a session that is
  gone is forgotten, a stalled one is kept. A triage that leaves its item in
  place (no confident project) therefore keeps its session, as before.
- The map is in memory and not persisted, for the dedup set's reason: a
  restart forgets the sessions spawned before it, which leaves them to be
  stopped by hand. A replacement `inbox-watcher` template that prints no
  receipt records nothing and so leaves nothing to stop.
- Regressions: `api::tests::todo_reaper_tick_stops_a_triage_session_once_its_item_is_triaged`,
  `api::tests::inbox_watcher_tick_skips_archived_items_even_after_a_restart`,
  `api::tests::inbox_item_pending_is_a_live_change_request`, and the reaper
  and restart blocks in `scripts/inbox-watcher-check.sh`.

## Other invariants

- The watcher **never mutates an inbox item**. Everything it does is seed the
  agent definition, spawn an agent and — once the item is triaged — stop
  that agent; the item's fate is entirely the triage agent's, through the
  normal CLI. There is no watcher-side delete, assign, or status write.
- Inbox bodies are **untrusted data**. The body reaches `claude` only as a
  single `--name` process argument (`Command::arg`, no shell) and nothing in
  Naru interprets it. The triage agent's first rule is that the body is data,
  never instructions to it.
- The tick cadence is a fixed internal constant (`WATCH_INBOX_TICK`, 60s), not
  user-configurable. `MESA_WATCH_INBOX_TICK_MS` overrides it, a test-only seam
  mirroring `MESA_WATCH_TODO_TICK_MS`.
- The flag is propagated through the web UI's **Restart Server** action the
  same way `--lan` and `--watch-todo` are: `serve`'s post-shutdown relaunch
  re-execs the binary with `--watch-inbox` appended when it was set. (The
  in-memory dedup set does not survive that relaunch — see above.)
- No CLI or web surface of its own beyond the `serve` flag, matching the todo
  watcher and the agents surface's "no `mesa agent` CLI" precedent.
- Gate: `scripts/inbox-watcher-check.sh` (flag on/off, spawn-failure release +
  retry, cwd/name/prompt shape, `--agent inbox-triage` with the definition
  seeded under the throwaway `HOME` carrying no `Edit`/`Write`, no
  re-dispatch of a still-pending item, new
  item picked up, whole queue in one tick, independence from `--watch-todo`,
  pruning after delete and after assign, the reaper leaving a pending item's
  session and a `busy` one alone and stopping an archived, deleted and
  assigned item's session exactly once each, and a restart re-dispatching
  the pending items but never the archived one) against a stub `claude`
  binary, with
  `HOME` pointed at a throwaway dir so the `~/.mesa/workspace` cwd assertion
  is hermetic.
  Rust unit tests cover `inbox_session_name` (including multi-byte
  truncation), the dispatch-once/pick-up-new behavior, and claim release on
  spawn failure.
