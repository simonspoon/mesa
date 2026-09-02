# Cost guard

`mesa serve --watch-cost` starts a periodic background loop that watches the
Claude Code sessions running **right now** and files an inbox alert for any one
that has crossed a spending threshold. `mesa cc guard` is the same verdict on
demand, printed instead of filed.

The motivating incident is the whole design brief. One session spent
**$1,413.72 across 2.76B tokens in 7h55m**, 91.2% of it inside a single 6h14m
window that was **99.8% cache reads** with almost no output — an agent
re-reading the same context forever. Every number in that sentence was already
in `mesa cc` while it was happening. Nothing was *watching* them, so it was
found the next morning, in a bill.

mesa **reports; it never stops a session.** There is no kill switch and no
`--force`. The person decides — the guard's whole job is to make sure they get
to decide while it is still running.

It also ingests nothing new. It reads exactly what `crate::core::cc::live()`
already computes, the one sanctioned live-transcript read the CC Dashboard
already carves out (`docs/cc-dashboard.md`). No new tables, no new parse, no
second telemetry path.

**Off by default**, for the todo-watcher's reason and one of its own: it reads
Claude Code's transcripts and writes inbox items with no user request behind
it. It is independent of `--watch-todo` and `--watch-inbox` — none implies
another — and, like them, it is re-appended to the argv the web UI's **Restart
Server** action relaunches with.

## How one tick works

`cost_watcher_tick` in `src/api.rs`, every `WATCH_COST_TICK` (60s;
`MESA_WATCH_COST_TICK_MS` is the test seam, mirroring the other two watchers):

1. **Read the thresholds**, fresh from `~/.mesa/config.json`'s `guard` section
   — the `todo-concurrency` rule (`docs/config.md`): a limit changed in
   Settings takes effect without restarting `mesa serve`. A config mesa cannot
   parse **skips the tick** and logs, rather than guarding against guessed
   numbers.
2. **Read the live sessions** — `cc::live(DEFAULT_GUARD_WINDOW_MINUTES)`, an
   hour-wide window (see below).
3. **Evaluate**, with no store lock held. This and step 2 are the slow part;
   holding the lock across them would freeze every other API request, the
   two-phase shape `inbox_watcher_tick` and `todo_watcher_tick` already have.
4. **File**, taking the store lock only for the task resolution and the inbox
   write.

## Three rules, and why three

`core::guard::breaches` is a pure function over one `CcLiveSession` and the
thresholds. Every comparison is `>=` — a limit is a limit, not a number to
exceed.

| Rule | Fires when | Default |
| --- | --- | --- |
| `cost` | `est_cost_usd >= cost-usd` | $25 |
| `tokens` | `total_tokens >= total-tokens` | 100,000,000 |
| `spin` | `total_tokens >= cache-read-min-tokens` **and** `cache_read / total_tokens >= cache-read-share` | 20,000,000 and 0.98 |

They are not three spellings of one rule:

- **`cost`** is the number a person actually cares about, but it is estimated
  from a price table (`docs/config.md`'s `pricing` section) and a cheap model
  can burn enormous volume for very little money.
- **`tokens`** catches exactly that case. Volume is measured, not estimated.
- **`spin`** is the shape of the incident rather than its size. Cost and volume
  say *how much*; a 99.8% cache-read share with near-zero output says *what
  kind* — an agent looping rather than working. It is the rule that would have
  caught the motivating session hours before either of the others mattered, and
  the one whose alert tells a person what they are about to find.

The `cache-read-min-tokens` floor is what makes `spin` usable at all: a session
three messages long is trivially 100% cache reads and perfectly healthy. The
floor is also, by construction, what makes the division safe — a session with
no tokens can never reach it, so there is no divide-by-zero to guard separately.

A session can trip several rules at once, and each is reported separately
inside one alert. The **fire-once key is the pair** `(session_id, threshold)`,
not the session: a session that trips `cost` at 10:04 and then `spin` at 10:31
is telling a person something new the second time.

## The window: one hour

`cc live` totals are **window** totals, not session lifetimes, so the window is
also the unit the thresholds are denominated in — and an hour of spend is a
unit a person already thinks in. It is wider than `cc live`'s own 15-minute
default for a second reason: a session that pauses a few minutes between tool
calls must not drop out of view between ticks. It is far narrower than the
1440-minute ceiling, because a day-wide window would answer "did this cost a
lot today", which is a question the dashboard already answers after the fact.

A session must still be inside that window to be seen at all. The guard is a
watcher, not an auditor; a session that stopped an hour ago is history, and
history is `mesa cc summary`.

## The `task_id`: resolved, never fabricated

This is the load-bearing decision, and the one place the feature deliberately
does less than it could.

`Store::create_inbox_item` **requires a real task id**, because the inbox's
rule is that every item names the task it came from (mesa task 847,
`docs/inbox.md`) — that origin is what the list renders as an item's first
line. The guard does not get to loosen that signature, open a second inbox
write path, or invent a sentinel task to hang orphans on. A Claude Code session
is telemetry about a *process*; `cc_sessions` has no task or project column at
all. So `core::guard::resolve_task` asks two questions and accepts "no":

1. **Did a claim name this session?** A task whose `owner` equals the cc
   `session_id` (`Store::find_task_by_owner`, most recently claimed first).
   Exact, because the agent itself said so — the same link `docs/receipts.md`
   uses to attach a transcript to a receipt.
2. **Whose folder is it working in?** The session's `cwd` matched by **exact**
   equality against a project's `local_path` — the rule
   `cc::collect_for_project` already uses, with no prefix or subdirectory
   matching, because a worktree is not its parent repo. Then that project's
   `in_progress` tasks, oldest claim first, an unclaimed one last. A guess, but
   a narrow one: the alert names the *session*, so a wrong task is a wrong
   filing cabinet, not a wrong story.
3. **Neither** — file **nothing**. Warn once on stderr naming the session and
   the rules it tripped, and still claim the fire-once pair, so an
   unattributable runaway does not reprint that line every minute.

Rung 3 is a real, documented dead end: a runaway started outside any project
mesa knows produces no inbox item. `mesa cc guard` is the answer to that — it
reports every breaching session with `task_id: null` where the ladder ran out,
so the session is visible even when the alert is not filable. The alternatives
were worse: a sentinel task is a lie in the task list, and a nullable
`task_id` would re-open a column mesa deliberately closed.

## The fire-once set

`AppState::cost_alerted`, a `HashSet<(String, String)>` of
`(session_id, threshold)`. The direct sibling of `inbox_dispatched`
(`docs/inbox-watcher.md`), for a nearly identical reason: a cc session has no
mesa-side row to claim with, so the stand-in is in-memory state.

- Pairs are claimed **before** the write, so two ticks cannot double-file.
- A **failed** write releases the pair, so a transient store error retries next
  tick rather than silently dropping the alert. An *unattributable* session is
  not a failure — there is nothing to retry — so its pair stays claimed.
- Pruned each tick to the session ids still inside the live window, so it
  cannot grow unboundedly on a long-lived server.
- Deliberately **not persisted**. A restart re-alerting on a session that is
  *still* burning money is the recoverable direction; a permanently silenced
  runaway is exactly the failure this feature exists to prevent. Persisting it
  would also mean a migration to store state about an entity mesa does not own.

## The alert

One inbox item per session per tick, carrying every rule newly tripped.

- `kind` is **`task-summary`** — an agent reporting for a person to read. That
  is not cosmetic: the inbox-watcher triages **change requests only**
  (`docs/inbox-watcher.md`), so a cost alert can never dispatch an agent of its
  own. Answering a runaway agent by spawning another agent is precisely the
  wrong move.
- `author` is `cost-guard`, so the alerts are one identifiable stream.
- The body is **prose**, not a table. The inbox's play button may read it aloud
  through `kokoro-rs` (`docs/inbox.md`), so it says "99.8 percent were cache
  reads", not a markdown grid. It names the session (short and full id), the
  project or cwd if known, how long it has been running, the tokens, the
  estimated cost, the cache-read share, the output tokens, which rules tripped
  and what each one means — and closes by saying mesa stops nothing and
  pointing at `mesa cc guard`.
- Session ids, cwds and project names are **data**. Nothing on this path
  reaches a shell; the guard shells out to nothing and spawns nothing.

## `mesa cc guard`

```
mesa cc guard [--minutes N]
```

The read-only half. Prints one JSON object: `generated_at_unix`,
`window_minutes`, the `thresholds` in force, and a `sessions` array of every
live session currently over one of them — identity, `running_minutes`, the
token split the rules read, `est_cost_usd`, `cache_read_share`, the `breaches`
it tripped and the resolved `task_id` (or `null`).

- Reads transcripts and the mesa db; **writes nothing**, files nothing, and
  does not touch the fire-once set. Running it is not a substitute for the
  watcher and cannot silence one.
- No `cc sync`: the subject is what is running now, which is a live transcript
  read (`cc live`), not a db aggregate.
- No `--quiet` — it is neither a mutation nor a `show`, so the flag is an
  unknown argument, exit 2, like `cc live` and `live turns`.
- Deliberately **no HTTP route**. Nothing here is unsafe to serve, but the
  watcher is the surface the server offers and the CLI is the surface an agent
  drives; a third read of the same numbers over HTTP would be a route with no
  caller.

## Configuration

The `guard` section of `~/.mesa/config.json` — a seventh independent section
(`docs/config.md`), read fresh every tick:

```json
{
  "guard": {
    "cost-usd": 25.0,
    "total-tokens": 100000000,
    "cache-read-share": 0.98,
    "cache-read-min-tokens": 20000000
  }
}
```

Absent or `null` is the built-in default for that key alone. `GET`/`PUT
/api/config/guard` is the Settings-page pair: the `GET` is `require_agent_access`
and reports each value **verbatim** beside its built-in, and the `PUT` carries
that **same** gate like every other config write (mesa task 1021 — strictly
stronger than the loopback-only check it used to carry in default mode, and
relaxing rather than refusing under `--lan`; mesa task 1022 took every
remaining route onto it too). A bad
value is `validation` (422) and writes **nothing** — the whole update is
checked before the file is touched. A hand-edited value of the right type but
outside its bound falls back to the built-in *for that key*, the clamp posture
`todo-concurrency` takes: a stray `0` must not switch the guard off silently.
A value of the wrong *type* is an error on read, and the tick skips.

## Gate

`scripts/cost-guard-check.sh`, against a synthetic Claude Code transcript tree
(`MESA_CC_PROJECTS_DIR`, the seam `scripts/cc-check.sh` uses) and a throwaway
db and `HOME`: a runaway in a folder mesa knows, a healthy session beside it,
and a runaway in a folder no project claims. It asserts the flag-off silence,
exactly one alert for the runaway (task-summary, authored `cost-guard`, filed
against the claimed task), no alert and exactly one stderr warning for the
unattributable one, no re-filing on later ticks, `cc guard`'s two rows and its
`--quiet` refusal, the built-in thresholds under an absent config, that a
configured threshold actually governs the verdict with no restart, that every
bad value is a 422 that writes nothing, that `null` restores the built-in, and
that **all six** other config sections survive the guard section's save.

Rust unit tests cover the rules themselves (each threshold over and under, a
zero-token session, a small 100%-cache-read session under the floor, the
motivating incident tripping all three), the alert body, the resolution
ladder's three rungs including exact-`cwd` matching, `find_task_by_owner`, and
the config section's read/validate/save behaviour.
