# Task claims (`owner` + `claimed_at`)

A task may carry a **claim** — `owner` (opaque, caller-supplied) plus
`claimed_at` — taken by `Store::claim_task` (`mesa task claim <ID> --owner <WHO>
[--force]`, `POST /api/tasks/{id}/claim`) and dropped by `Store::release_task`
(`mesa task release <ID>`, `POST /api/tasks/{id}/release`).

## Why the pair exists

`updated_at` cannot distinguish a live holder from an abandoned run: it moves on
**any** field write, so `claimed_at` must move **only** on claim/renew — that
asymmetry is the feature, and any code that restamps `claimed_at` from an
ordinary update destroys it.

`owner` is deliberately unvalidated and opaque to `Store`. The convention (an
agent's Claude Code session id) is what makes liveness checkable out-of-band
rather than inferred from a timestamp.

mesa still enforces **no TTL and releases nothing automatically** — a claim
expires when someone says so, never when a clock says so. What it does now do
(mesa task 1017, a deliberate partial reversal of this doc's older "mesa
computes no staleness") is *derive* an age on read: precisely because
`claimed_at` moves only on claim/renew, `now - claimed_at` is exactly "how long
since anyone asserted they still hold this". That is a fact about the row that
mesa can compute and nobody else can, so it is worth reporting; acting on it
stays a decision, and `owner` remains the authoritative, out-of-band liveness
check.

## Semantics

- `claim_task` moves the task to `in_progress`, and is a **renewal** when
  re-issued with the same owner.
- A *different* owner on an `in_progress` task is `conflict` unless `--force` —
  that conflict is the only guard against two agents in one repo.
- An `in_progress` task with a null owner is **not** a live hold (a plain
  `--status in_progress` flip, or a pre-claim row), so it is claimed without
  `--force`.
- `update_task` clears the claim whenever the status leaves `in_progress`, so no
  done/cancelled row stays owned.
- `release_task` is unguarded and idempotent by design — it is the stale-claim
  breaker, so it takes no owner.
- Both fields ride on `TaskSummary` too (`task list`, `GET /api/tasks`), so one
  call scans a project for live-vs-abandoned rows.
- `task next` still never *returns* a claimed task: it only ever picks `todo`
  rows, so a claim is invisible to the selection and there is nothing for a TTL
  to skip. Its **no-actionable-task payload** does carry one extra count (see
  "Staleness on read" below).

## Staleness on read

Two read-side surfaces, no writes, no new column and no new status.

- **`mesa task list --stale-claim-minutes <MINUTES>`** /
  **`GET /api/tasks?stale_claim_minutes=<MINUTES>`** keeps only tasks that
  carry a claim *and* whose `claimed_at` is at or before the cutoff. An
  unclaimed task never matches, whatever the value. It ANDs with the existing
  `status`/`tag`/`parent`/`unblocked` filters and changes nothing when absent —
  default output is byte-identical, and no record grew a field. `0` is legal
  and means "every claimed task"; there is nothing to validate.

  The cutoff is `Store::claim_cutoff(minutes)` — `SELECT datetime('now', '-N
  minutes')`, **SQLite's clock**, the one that stamped `claimed_at`, never a
  second time source in Rust — computed once per call, before the filter chain,
  so the clock cannot move underneath a listing. Every mesa timestamp is
  fixed-width UTC text, so `claimed_at <= cutoff` is an ordinary string
  comparison.

- **The threshold is a flag argument, not a config key.** A query flag that
  silently means different things on two machines is worse than one that always
  states what it asked: `--stale-claim-minutes 30` is self-describing in a
  transcript, a script and a bug report, and nothing has asked to tune it. The
  same reasoning forbids a `watchers` key for the diagnostic below.

- **`task next`'s wedge diagnostic.** When nothing is actionable, the status
  object grows one count beside `blocked`/`in_progress`/`todo`:
  `stale_claims`, the number of `in_progress` tasks **in the same scope those
  three already use** whose claim is at least `STALE_CLAIM_MINUTES` (60, a
  fixed const in `src/core/store.rs`) old. Fixed and not configurable for the
  reason above, plus one more: nobody types a flag at a diagnostic. The shape
  is unchanged when a task *is* returned.

  It lives on `next_task` rather than in the todo-watcher because the watcher
  calls `next_task` itself — so the signal lands on the watcher's own path with
  no watcher code, no config key and no dedup state, and a person running
  `mesa task next` in a quiet project gets the same answer
  (`docs/todo-watcher.md`).

- **A read never releases.** Both surfaces only report. Breaking a stale claim
  stays the explicit, separate act it always was: `mesa task release <ID>` /
  `POST /api/tasks/{id}/release`, or `task claim --force`.

## Web UI

The task detail panel renders a `claimed by <owner> · <age>` line; a Board card
carries a `held <owner>` badge. Neither checks `status` — a non-null `owner`
*is* an `in_progress` hold, because `update_task` clears the claim on the way
out — so the badge is styled in the same amber as `status-in_progress`.

`.badge.claim-badge` must keep `text-transform: none`: `.badge` uppercases, and
an `owner` is a case-sensitive id the reader pastes into `claude attach
<owner>`. Ages come from `frontend/src/time.ts`, which exists because every mesa
timestamp is SQLite `datetime('now')` — UTC with no zone marker, which bare
`new Date()` would read as local time.

## Gate

`scripts/api-check.sh` pins the HTTP half of all of the above — including the
asymmetry itself, by sleeping past the one-second timestamp granularity and
asserting that an ordinary `PATCH` moves `updated_at` and leaves `claimed_at`
alone — and, for the read-side filter, that `?stale_claim_minutes=N` lists an
aged claim, excludes a fresh one and never lists an unclaimed task.

`scripts/cli-check.sh` pins the CLI half of the filter over the same three
cases, plus `--stale-claim-minutes 0`, that it ANDs with `--status`, that an
unflagged `task list` is unchanged, that `task next` reports `stale_claims`,
and that reading it releases nothing while `task release` does. Both scripts
age a claim with a direct `sqlite3 UPDATE` against the throwaway `MESA_DB`:
nothing in `Store` moves `claimed_at` backwards, which is the property under
test.
