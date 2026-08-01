# Inbox watcher

`mesa serve --watch-inbox` starts a periodic background loop that auto-triages
the global inbox: for every pending item it starts a background `claude`
session running `/inbox-triage <item-id>`, so items stop accumulating until a
human gets to them. That command is the default of the **`inbox-watcher`** key
in `~/.mesa/config.json` and is user-configurable, slash command included
(`docs/config.md`); `{id}` is the item id and `{name}` the session name derived
below. The sibling of the todo watcher (`docs/todo-watcher.md`),
built on the same machinery, over a different queue. **Off by default**, for
the same reason: auto-spawning agents is real API cost and real code
execution, so it must not fire just because someone ran `mesa serve`.

The three watcher flags (`--watch-todo`, `--watch-refine`,
`docs/refine-watcher.md`, and `--watch-inbox`) are **independent** — none
implies another, and each drives its own interval loop with its own tick
constant. `--watch-inbox` alone never claims a task or dispatches
`/execute-mesa-task`.

## How one tick works

`inbox_watcher_tick` in `src/api.rs`:

- Lists the whole inbox (`Store::list_inbox_items(None)`), then dispatches
  **every** pending item this process has not already dispatched — all of them
  in the same tick. Unlike the todo watcher, which is naturally capped at one
  agent per project, the inbox is one **global** queue with no per-project
  structure to pace it. A server started against a large backlog therefore
  fans out that many agents at once; that is the chosen behavior, not an
  oversight (mesa task 544).
- cwd is **`$HOME`**, not a project folder — the same
  `directories::BaseDirs::new().home_dir()` the global Terminal page uses. An
  inbox item belongs to no project (`project_id` is null for its whole life,
  see `docs/inbox.md`), so there is no `local_path` to spawn in; the triage
  skill derives the project itself and reads each candidate repo by absolute
  path. Consequence: these sessions appear in the **global** Agent sidebar
  only, never under a project's Agents tab. Like every mesa-started session it
  runs under the `swe` agent persona (`MESA_CLAUDE_AGENT`, `docs/agents.md`).
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

It is load-bearing, not an optimization. Two of the triage skill's three
outcomes remove the item — a viable request becomes a task and the item is
deleted; a non-viable one is converted by `assign_inbox_item` — but the third,
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
  of an item is cheap and the skill is idempotent enough to reach the same
  verdict, whereas a permanently skipped item is invisible. Persisting it
  would need a schema migration to store state about an entity whose whole
  design is "an item *is* the record".

## Other invariants

- The watcher **never mutates an inbox item**. Everything it does is spawn an
  agent; the item's fate is entirely the triage skill's, through the normal
  CLI. There is no watcher-side delete, assign, or status write.
- Inbox bodies are **untrusted data**. The body reaches `claude` only as a
  single `--name` process argument (`Command::arg`, no shell) and nothing in
  mesa interprets it. The triage skill has its own rule about not acting on
  body content.
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
  retry, cwd/name/prompt shape, no re-dispatch of a still-pending item, new
  item picked up, whole queue in one tick, independence from `--watch-todo`,
  pruning after delete and after assign) against a stub `claude` binary, with
  `HOME` pointed at a throwaway dir so the `$HOME` cwd assertion is hermetic.
  Rust unit tests cover `inbox_session_name` (including multi-byte
  truncation), the dispatch-once/pick-up-new behavior, and claim release on
  spawn failure.
