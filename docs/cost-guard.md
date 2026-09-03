# Cost guard

`mesa serve --watch-cost` starts a periodic background loop that watches the
Claude Code sessions running **right now**, **stops** any one that has gone
wrong, and files an inbox alert saying so. `mesa cc guard` is the same verdict
on demand, printed instead of acted on.

The motivating incident is the whole design brief. One session spent
**$1,413.72 across 2.76B tokens in 7h55m**, 91.2% of it inside a single 6h14m
window that was **99.8% cache reads** with almost no output — an agent
re-reading the same context forever. Every number in that sentence was already
in `mesa cc` while it was happening. Nothing was *watching* them, so it was
found the next morning, in a bill.

## mesa stops the session (mesa task 1054)

The guard shipped reporting only, on the reasoning that a person should decide.
Then a session ran `echo idle` **4,600 times in a row across eight hours and
about $1,373**, and two others did the same with `echo ok`. Inbox items were
filed about all three. Nobody was there to read them. A person who is not there
cannot decide, and a guard whose only power is to write something down is not a
guard.

So the built-in `action` is now **`stop`**: a session with a newly tripped rule
is stopped with `claude stop <job id>` before the alert is written, and the
alert's closing sentence says what happened.

Three things keep that proportionate:

- **`claude stop` is not a kill.** It ends the running process; the
  conversation survives, and `claude attach <job id>` picks it back up. The
  alert names that command. The destructive-sounding verb is closer to a pause
  than a delete, which is what makes stopping-by-default defensible at all.
- **Only a background session can be stopped.** The stop needs a short job id,
  and only `claude --bg` prints one. An interactive session in someone's own
  terminal has none, so mesa reports that it found nothing to stop and leaves
  it running. It never guesses an id — the job id and the session uuid share a
  prefix on most rows and slicing one out of the other would eventually stop
  the wrong session.
- **`"action": "report"` puts it back.** One config key restores the original
  behaviour exactly: alerts, no stops.

Everything is still **best-effort**. Resolving a job id and stopping shell out
twice, both off the store lock; every failure is a *reported outcome* rather
than an error, the alert is filed either way, and nothing can fail the tick.

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
4. **Act**, still with no store lock held: under the `stop` action, look the
   session's short job id up with `claude agents --json --all` and run
   `claude stop <job id>`. Two shell-outs, both best-effort. This happens
   **before** the filing and regardless of whether a task resolves — an
   unattributable runaway is exactly the one nobody else is going to stop.
5. **File**, taking the store lock only for the task resolution and the inbox
   write. The alert's last sentence is what step 4 actually did.

## Four rules, and why four

`core::guard::breaches` is a pure function over one `CcLiveSession` and the
thresholds. Every comparison is `>=` — a limit is a limit, not a number to
exceed.

| Rule | Fires when | Default |
| --- | --- | --- |
| `cost` | `est_cost_usd >= cost-usd` | $25 |
| `tokens` | `total_tokens >= total-tokens` | 100,000,000 |
| `spin` | `total_tokens >= cache-read-min-tokens` **and** `cache_read / total_tokens >= cache-read-share` | 20,000,000 and 0.98 |
| `repeat` | the newest `repeat-count` tool calls are the same trivial `Bash` command | 30 |

They are not four spellings of one rule:

- **`cost`** is the number a person actually cares about, but it is estimated
  from a price table (`docs/config.md`'s `pricing` section) and a cheap model
  can burn enormous volume for very little money.
- **`tokens`** catches exactly that case. Volume is measured, not estimated.
- **`spin`** is the shape of the incident rather than its size. Cost and volume
  say *how much*; a 99.8% cache-read share with near-zero output says *what
  kind* — an agent looping rather than working. It is the rule that would have
  caught the motivating session hours before either of the others mattered, and
  the one whose alert tells a person what they are about to find.
- **`repeat`** is the only rule that can fire before any real money is spent,
  and the only one that reads a *shape* off the transcript rather than a number
  off the meter. A wedged agent running `echo idle` costs a few tokens per call
  and can run for hours under every other line; what gives it away is that it
  is doing the same nothing over and over.

The `cache-read-min-tokens` floor is what makes `spin` usable at all: a session
three messages long is trivially 100% cache reads and perfectly healthy. The
floor is also, by construction, what makes the division safe — a session with
no tokens can never reach it, so there is no divide-by-zero to guard separately.

### The repeat rule

A **run** is consecutive `Bash` `tool_use` blocks whose `command` input is
byte-identical and whose paired `tool_result` is under
`cc::REPEAT_TRIVIAL_OUTPUT_BYTES` (**16 bytes**). Three things end a run: a
different command, a call to any other tool, and a result too long to be
trivial. The count is the length of the run the session is in *right now* —
its tail, not its longest ever.

Sixteen bytes is the whole judgement, so it is worth stating plainly. The
incident ran `echo idle` (`idle\n`, five bytes) and `echo ok` (three). A real
command — a build, a test run, a `git status`, even an `ls` — clears sixteen
bytes on its first line. The rule is not "this agent is repeating itself",
which is often legitimate; it is "this agent is repeating itself and nothing
is coming back". Thirty in a row is the count, deliberately well above the
handful of retries an honest polling loop makes and far below the 4,600 the
incident reached.

It is computed in `cc::parse_live_file` as **rolling state per session**
(`RepeatAcc`: the current command, its length so far, the calls still awaiting
results, and the ids already counted), so it costs the live read nothing
measurable. One assistant message may dispatch **several** `tool_use` blocks in
parallel, so the in-flight calls are a bounded list and not one slot: holding
only the newest id let an earlier block's real output go unmatched, and the run
kept climbing through a command that was plainly working. Results pair to calls
by `tool_use_id`, and only the result's **size** is ever read — the rule asks
one question of a result and a length answers it without a second unbounded
payload entering the process. The command reaches
`CcLiveSession::repeat` through `cc::sanitize_capped`, like every other
transcript-derived string mesa surfaces: it is untrusted model-authored text,
and it is data.

Sidechain lines are skipped. A subagent's own loop is its own transcript, and
interleaving it here would break a main-thread run that is genuinely unbroken.

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

## The already-stopped set

`AppState::cost_stopped`, a `HashSet<String>` of session ids, is the sibling
`cost_alerted` grew for task 1054. Same lifetime, same pruning, same refusal to
persist — but keyed on the **session alone**, not the `(session, threshold)`
pair. A session is stopped once whatever else it goes on to trip: `claude stop`
on a session that is already stopped is either a no-op or an error, and neither
is worth a second round trip.

Only a **successful** stop is recorded, so a transient failure retries on the
next tick that finds a fresh breach. A session mesa already stopped and then
sees breach again — the transcript stays inside the hour-wide window long after
the process is gone — gets an alert saying it was already stopped, not a second
attempt.

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
  and what each one means — and closes by saying **what mesa did about it**:
  that it was stopped and how to resume it (`claude attach <job id>`), that the
  stop failed and why, that there was no background session to stop, that it
  had already been stopped, or that mesa is configured to report only. Every
  branch says plainly whether the thing is still running, because that is the
  only thing a person woken by this alert has to decide about. Each then points
  at `mesa cc guard`.
- Session ids, cwds, project names and the repeated command are **data**.
  Nothing on this path is built into a string a shell parses: the two commands
  the guard runs are fixed argv (`claude agents --json --all`, `claude stop
  <job id>`) and the job id is one `Command::arg` mesa read out of `claude`'s
  own JSON, never out of a transcript.

## `mesa cc guard`

```
mesa cc guard [--minutes N]
```

The read-only half. Prints one JSON object: `generated_at_unix`,
`window_minutes`, the `thresholds` in force (all six, `repeat_count` and
`action` included), and a `sessions` array of every live session currently over
one of them — identity, `running_minutes`, the token split the rules read,
`est_cost_usd`, `cache_read_share`, the `repeat` run it is in (or `null`), the
`breaches` it tripped and the resolved `task_id` (or `null`).

- Reads transcripts and the mesa db; **writes nothing**, files nothing, **stops
  nothing** whatever `action` says, and does not touch the fire-once or
  already-stopped sets. Running it is not a substitute for the watcher and
  cannot silence one.
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
    "cache-read-min-tokens": 20000000,
    "repeat-count": 30,
    "action": "stop"
  }
}
```

`repeat-count` is a whole number between 1 and 100,000. `action` is exactly
`"stop"` or `"report"` — lowercase, and any other word is refused by the editor
and falls back to the built-in in a hand-edited file, the clamp posture the
numbers take. There is deliberately **no Settings UI** for this section: there
never was one, and task 1054 did not add one.

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
(`MESA_CC_PROJECTS_DIR`, the seam `scripts/cc-check.sh` uses), a throwaway db
and `HOME`, and a stub `claude` (`MESA_CLAUDE_BIN`) that answers
`agents --json --all` from a fixture and records every `stop` call to a file.
Five synthetic sessions: a runaway in a folder mesa knows, a healthy session
beside it, a runaway in a folder no project claims, a `looper` that is under
every money threshold but 35 `echo idle` calls deep, and a sibling one call
short of the count.

It asserts the flag-off silence (no alerts *and* no stops), one alert each for
the runaway and the looper (task-summary, authored `cost-guard`, filed against
their claimed tasks), that the looper's alert names `repeat` and `echo idle`
and the 29-call sibling trips nothing, that each of the three breaching
sessions is stopped **exactly once** and not again on later ticks, that the
bodies name `claude stop`/`claude attach`, no alert and exactly one stderr
warning — naming the stop — for the unattributable one, `cc guard`'s three rows
and its `--quiet` refusal, the built-in thresholds and `stop` action under an
absent config, that `"action": "report"` on a fresh server files alerts and
stops nothing, that a `MESA_CLAUDE_BIN` pointing at nothing is a reported
outcome rather than a failed tick, that a configured threshold actually governs
the verdict with no restart, that every bad value (the new `repeat-count` and
`action` included) is a 422 that writes nothing, that `null` restores the
built-in, and that **all six** other config sections survive the guard
section's save.

Rust unit tests cover the rules themselves (each threshold over and under, a
zero-token session, a small 100%-cache-read session under the floor, the
motivating incident tripping all three, `repeat` at 29/30/4,600), the run
parsing end to end through `cc::live` (a plain run, a different tool, a
different command, a non-trivial result, a re-emitted block, a subagent's own
loop), the alert body under every stop outcome, `agents::job_for_session`
(match, interactive row, no match, unknown fields, malformed JSON), the
resolution ladder's three rungs including exact-`cwd` matching,
`find_task_by_owner`, and the config section's read/validate/save behaviour for
all six keys.
