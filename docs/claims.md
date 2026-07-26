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
rather than inferred from a timestamp, so mesa computes no staleness and
enforces no TTL.

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
- `task next` is unaffected: it only ever returns `todo` tasks, so a claim is
  already invisible to it and there is nothing for a TTL to skip.

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
alone.
