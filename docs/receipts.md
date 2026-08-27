# Work receipts (task 920)

A **receipt** is a frozen record of what actually changed while a task was
claimed and open: the commits made during the claim window, a diff summary,
and a best-effort link to the Claude Code session transcript. It exists
because `artifact`/`result` are hand-filled by the closing agent — often
skipped, sometimes wrong — so a finished task frequently carried no record of
what was actually done. A receipt is generated automatically, so "what
happened" survives even when the human/agent fields don't.

Table `task_receipts` (migration index 48, `user_version` 49), keyed on
`task_id` itself (a task has at most one receipt), `ON DELETE CASCADE` — a
receipt describing a deleted task is meaningless, the same posture
`library_versions` takes on its item.

## Why stored, not derived (D1)

`blocked` and `name` are derived-never-stored — CLAUDE.md is explicit that a
receipt must not follow that pattern. Both of those are recomputable from the
*current* row at read time. A receipt cannot be: the claim window it
describes is gone the instant it closes (`Store::update_task` nulls
`owner`/`claimed_at` the moment status leaves `in_progress`), and the commits
made during that window keep receding into the branch's ordinary history as
more work lands on it. There is no way to ask "what changed while task N was
open" after the fact once the claim is gone — not a performance question, an
information one. The only honest option is to capture the answer once, at
close time, and keep that capture, so the receipt is written to its own table
and never recomputed on read.

## Why a sibling record, not fields on `Task` (D2)

`Task`/`TaskSummary`/`compact()` carry a long, heavily-specified `--quiet`
key-parity contract (CLAUDE.md's "Contracts that agents/clients depend on").
Widening either to hold a commit list and a diff stat would force a decision
across every existing projection — `task list`, every quiet echo, the
key-parity test — for a field most reads never want. So a receipt is fetched
by its own subcommand/route (`mesa task receipt`, `GET
/api/tasks/{id}/receipt`) instead. `artifact`/`result` are untouched by any of
this: they stay exactly as they are, hand-written and authoritative, and a
receipt never overwrites either — it sits beside them as a second,
machine-generated source.

## The chokepoint: `core::receipt::update_task` (D3)

Generation is **not** in `Store`. `Store` is transactional rusqlite hit by
every test in the suite; shelling out to `git` from inside it would make
every unrelated store test slower and (on a machine with no git, or a
git-less CI sandbox) hazardous. The precedent is `agents::spawn_bg`: one
chokepoint every agent-spawn site goes through instead of four separate
`Command::new("claude")` calls. Receipts get the same shape:

```
core::receipt::update_task(store: &mut Store, id: i64, patch: &TaskPatch) -> Result<Task>
```

is the *one* function `cli.rs` (`task update`) and `api.rs` (`PATCH
/api/tasks/{id}`) call for a task update — never `store.update_task`
directly. It:

1. reads the task, capturing `owner`/`claimed_at` **before** the update runs;
2. delegates to `store.update_task(id, patch)`;
3. iff the transition was into `done`, the pre-update row had a live claim
   (`owner` and `claimed_at` both set), generates a receipt and writes it.

The ordering in step 1 is load-bearing, not incidental: `store.update_task`
is the same call that nulls `owner`/`claimed_at` the instant status leaves
`in_progress`. By the time the patched `Task` comes back, the claim the
receipt is about is already gone from the row — so the claim has to be
captured on the way in, not read back out afterward.

**Generation never fails the close.** A task must always reach `done`
regardless of whether git is installed, the repo is unreadable, the project
has no `local_path`, or the `cc_*` tables are empty. `generate` degrades to
`None`/empty fields at every failure point rather than returning `Err`, and a
failure writing the receipt itself is swallowed by `update_task` — by that
point the task update has already committed, and there is no correct way to
unwind it over a receipt that is, at worst, informational.

## Attribution: claim window + repo, capped (D4)

Commits are read from the project's `local_path` with `git log
--since=<claimed_at> UTC --until=<closed_at> UTC` (`core::git::log_between`),
newest first, capped at `core::git::LOG_CAP` (100) — the same cap
`commit_log_of`/`file_log_of` already use. The branch at close time is
recorded (`core::git::status_of`) so a reader can see which line of history
the commits were read from. `files_changed`/`insertions`/`deletions` are
summed across those commits by `core::git::diff_stat`, counting **distinct
paths** across the whole set (a file touched by two commits in the window
counts once, not twice) rather than a per-commit sum.

The `--since`/`--until` bounds are suffixed `" UTC"` before reaching git.
Every mesa timestamp is SQLite `datetime('now')` text with no zone marker,
always written in UTC; `git --since`/`--until` parse a bare timestamp in the
**local** timezone of the machine running `git`. Without the suffix, git
would read `claimed_at`/`closed_at` as local time and the window would be
silently wrong by the machine's UTC offset — not a crash, just a receipt that
quietly claims no commits happened, indistinguishable from a legitimately
quiet claim window. The suffix pins the same interpretation git would give
its own timestamps if it had written `claimed_at`/`closed_at` itself.

**Documented, accepted limitation:** attribution is branch + time window, not
a per-commit author check. Two sessions working in one repo, on one branch,
in overlapping claim windows will both see the same commits in their
receipts. This is the honest first cut the task's design conversation landed
on, not a guarantee — a stronger scheme (e.g. matching commit authorship to
`owner`) was considered and rejected as more machinery than the problem
warrants for now.

## The session link is best-effort (D5)

`owner` is whatever opaque string the claimant supplied (`docs/claims.md`) —
mesa enforces no format on it. `cc_sessions.session_id` keys on the Claude
Code transcript's own UUID. This repo's own `execute-todo` skill claims tasks
with an `--owner` of the shape `session_<claude-session-id>` (its own
`session_` prefix convention) — that string is **not** the transcript UUID
and will never resolve against `cc_sessions`. So:

- `owner` is stored on the receipt **verbatim, always** — it is evidence in
  its own right even when nothing else about the session can be recovered.
- `session_id`/`transcript_path` are filled in **only** when `owner` actually
  resolves via `Store::cc_session`, and `transcript_path` is then **read**
  from `cc_node_files` (the main thread's row, `agent_id = ""`), never
  constructed by guessing a path from a naming convention.
- A null `session_id`/`transcript_path` is the common, legitimate case (any
  `session_…`-style owner takes it), not an error and not a sign generation
  failed.

## The receipt is editable, not write-only (D6)

`note` is the one field meant to be written by a human: a free-text
addendum ("re-ran once, flaky test"). `edited` is set the moment a human
writes to the record — a note, or (were one ever added) a manual field
correction — so a hand-corrected receipt can never silently present itself
as purely machine-generated. `edited` is never set by ordinary generation or
regeneration on its own.

**Regeneration recomputes the machine fields and preserves the human ones.**
`--regenerate` re-runs the D4 attribution logic from scratch (fresh
`commits`/`stat`/`branch`/`session_id`/`transcript_path`) but must carry the
existing `note`/`edited` across, rather than overwriting them with
`generate`'s fresh defaults (`None`/`false`). This was a real bug found and
fixed during implementation: `generate` always produces `note: None, edited:
false`, and `put_task_receipt` is `INSERT OR REPLACE`, so an early version of
`--regenerate` silently discarded a hand-written note on every regenerate.
`core::receipt::regenerate` fixes this by reading the existing receipt first
and copying its `note`/`edited` onto the freshly generated one before the
`put`. `scripts/receipts-check.sh` pins this as a named regression check.

`--regenerate` windows from the **existing receipt's** `claimed_at`/`owner`
when there is one, falling back to the task's own live claim only when there
is no receipt yet. This ordering matters for the same reason generation does:
closing a task is exactly what clears `Task::owner`/`claimed_at`, so
re-reading the task's own claim on an already-closed task would find
nothing — `--regenerate` on the common case (a done task that already has a
receipt) would fail every time instead of only the once, before any receipt
exists.

## CLI surface

```
mesa task receipt <ID>                            # show (not_found if none exists)
mesa task receipt <ID> --regenerate                # recompute from the claim window
mesa task receipt <ID> --note "re-ran once, flaky test"
mesa task receipt <ID> --note ""                   # clear the note
mesa task receipt <ID> --delete                    # echo the destroyed record
mesa task receipt <ID> --quiet                     # drop commits/note
```

`--regenerate`, `--note` and `--delete` are mutually exclusive
(`conflicts_with_all`, clap-enforced, exit 2 if combined). Unlike `task
update`, there is no required-field `ArgGroup`: a bare `receipt <ID>` with
none of the three is a complete, legal show, not a no-op needing rejection.
`--quiet` sits outside the group as a pure modifier, same as everywhere else.
This subcommand **never creates the first receipt** — that only happens
automatically, through `core::receipt::update_task`, when a claimed task
closes into `done`; `receipt`/`--regenerate`/`--note`/`--delete` only read or
revise one that already exists (`--regenerate` on a task that was never
claimed and has no receipt is `validation`, not a fresh generation).

## API surface

```
GET    /api/tasks/{id}/receipt
PATCH  /api/tasks/{id}/receipt              # {"note": "..."} or {"note": null} to clear
DELETE /api/tasks/{id}/receipt
POST   /api/tasks/{id}/receipt/regenerate
```

`PATCH` takes the same `double_option` convention as `TaskUpdate`'s clearable
fields: an omitted `note` key changes nothing, `"note": null` clears it,
`"note": "..."` sets it — either explicit form sets `edited = true`.

**These four routes carry no per-route gate**, matching `show_task`/
`update_task`/`delete_task` exactly — only the router-wide Host-allowlist +
Content-Type middleware applies (CLAUDE.md's "API security boundary"
section). This is a deliberate call, not an oversight: a receipt is task
metadata hanging off the same row those three task routes already serve with
no gate. It is not code execution (unlike `execute_task`, which shares the
agents' `require_agent_access` gate) and not a disk read of its own —
`local_path`/git are read once, at generation time, and the result is frozen
into the row before any of these routes ever runs. Inventing a stricter gate
for reading or annotating that already-frozen row than the task record it
belongs to would be a distinction with no security content — the mirror
image of the reasoning `docs/library.md` gives for gating *its* routes, where
the bytes served genuinely are a live disk read.

## `--quiet` projection

Drops `commits` (a git log capped at `LOG_CAP` but still unbounded as far as
one JSON line is concerned) and `note` (the one field that is free text by
design). Everything else — `task_id`, `generated_at`, `owner`, `claimed_at`,
`closed_at`, `branch`, `repo_path`, the summed `files_changed`/`insertions`/
`deletions`, `session_id`, `transcript_path`, `edited` — is already bounded
and stays. Compare with `jq 'keys'`, never byte-for-byte, per the repo-wide
`--quiet` convention.

## Gate

`scripts/receipts-check.sh` (CLI, end-to-end, over a real throwaway git
repo): a claimed task's close auto-generates a receipt with the right
commits; an unclaimed task's close generates none; the diff summary counts a
changed file once across two commits; `--note` sets the note and flips
`edited`; `--regenerate` preserves a hand-written note (the regression check
for the defect above); `--quiet` drops exactly `commits`/`note`; `--delete`
echoes the destroyed record; `--regenerate` on a project with no
`local_path` is `validation`; a usage error (mutually exclusive flags) is
exit 2.
