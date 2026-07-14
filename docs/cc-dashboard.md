# CC Dashboard (Claude Code telemetry)

An **analytics surface** over Claude Code's own session transcripts — the
newline-delimited JSON under `~/.claude/projects/**/*.jsonl` (including
subagent transcripts in `<session>/subagents/*.jsonl`). Transcripts are
**ingested** into `cc_*` tables (sessions, agent runs, messages, tool calls,
per-file cursors — migration index 10) through `Store` — the single-write-path
invariant holds here too — and **the dashboard reads only the db**, never the
files, so history survives Claude Code's own transcript cleanup and nothing is
ever double-counted. The parsing/aggregation lives in `src/core/cc.rs` so the
CLI and API share it and never diverge.

- Each transcript line is one event. Only `assistant` events carry a `model` and
  a `usage` block (`{input, output, cache_read, cache_creation}` tokens), so
  those drive token/cost/model/skill/agent/tool rollups; every timestamped line
  widens its session's start/end span. Unparseable or non-telemetry lines are
  skipped. Subagent lines carry the **parent's** `sessionId` plus an `agentId`,
  so their usage rolls into the parent session. An event's `uuid` (and a tool
  call's `tool_use_id`) is the idempotency key: all ingest writes are upserts,
  so re-ingesting any line is a no-op. Tool `input` payloads are never stored.
- A call to the built-in **`advisor`** tool doesn't get its own transcript
  line/file the way a Task-tool subagent does (no `subagents/*.jsonl`, no
  `isSidechain`): it's a `server_tool_use` content block (read like
  `tool_use`, so it still yields a `cc_tool_calls` row) on an ordinary event,
  and the advisor model's own — often large — usage is nested inside that
  same event's `usage.iterations[]` array (entries tagged
  `"type":"advisor_message"`, each carrying its own `model`) rather than the
  event's small top-level `usage` (wrapper overhead only). `fold_line` reads
  those entries and emits a **second** `cc_messages` row for them, keyed off
  the parent event's real `uuid` plus a deterministic suffix (the one
  exception to "no synthetic keys" — still idempotent, since re-ingesting the
  same line always derives the same key) and tagged agent `"advisor"`, so an
  advisor call's real tokens/cost/model show up distinctly instead of being
  folded invisibly into the caller's tiny wrapper usage.
- **Ingest is incremental**: `cc::sync(store, rebuild)` walks the tree against a
  per-file cursor (`cc_files`: mtime + size + byte offset), skipping unchanged
  files and resuming appended ones from the last complete line; each file
  commits in its own transaction (`Store::cc_ingest_file`). The cursor is only
  an optimization — correctness comes from the upsert keys. It runs
  automatically (`rebuild = false`) before `mesa cc summary|sessions|skills|sync`
  and `GET /api/cc`, but deliberately NOT in `cc live` / `GET /api/cc/live` (hot
  3s poll; live keeps parsing recent files directly — they're by definition
  still present) nor `cc usage` (network path, no transcripts). `mesa cc sync
  --rebuild` (`rebuild = true`) clears every `cc_files` cursor first
  (`Store::cc_clear_cursors`) so the walk re-parses every transcript from byte
  0 regardless of mtime/size — safe any time, never truncates `cc_*` data, but
  it is **additive, not corrective**: `cc_messages`/`cc_tool_calls` insert on
  `DO NOTHING`, so a row that already exists keeps its stored values. A
  `cc.rs` parsing fix retroactively applies via rebuild only when it makes the
  parser emit a row (a new stable key) it previously missed entirely — the
  motivating case, mesa task 340's advisor-accounting fix, which added a
  second `cc_messages` row under a key that never existed before. A fix that
  needs to *change* an already-ingested row's values still needs that row
  deleted by hand before a rebuild backfills it. Only exposed via the CLI,
  not the API — an operator/one-off action, not something a dashboard read
  should ever trigger. `mesa cc sync` prints
  the `CcSyncReport` (`{files_scanned, files_ingested, sessions,
  messages_added, tool_calls_added}`; a no-change re-run adds zeros).
- **Cost is estimated at read time** from a static per-model price table
  (`prices` in `cc.rs`, USD per Mtok; cache-read ≈0.1× input, cache-write
  ≈1.25×) — tokens are stored, dollars never are. Matched on a model-family
  prefix so point releases price correctly; **update the table when pricing
  changes.** Labelled "estimated" in the UI.
- Window is `7d`/`30d`/`90d`/`all`/`<n>d`, applied at read time over persisted
  rows (ingest is always total). Transcript location resolves from
  `MESA_CC_PROJECTS_DIR` (tests) → `$CLAUDE_CONFIG_DIR/projects` → `~/.claude/projects`;
  `MESA_DB` isolates the store as everywhere else.
- The read entry point is `cc::collect(store, window) -> CcDashboard` (overview +
  daily series + model/skill/agent/project/tool breakdowns + capped session rows).
- CLI: `mesa cc {summary,sessions,skills,sync}` (JSON only; `summary` prints the
  full dashboard object, `sessions`/`skills` print bare arrays; `--window`, plus
  `--limit` on `sessions` and `--rebuild` on `sync`). Like every other handler
  these open the database; only `cc live` and `cc usage` stay store-less.
- API: `GET /api/cc?window=<w>` syncs, then serves the dashboard from an
  in-memory cache in `AppState.cc_cache` keyed per-window by `Store::cc_stamp()`
  — a monotone count over the cc tables (rows are never deleted), so it sees
  cross-process ingest (a CLI `cc sync` between requests) that file mtimes
  can't, and deleting a transcript invalidates nothing. Read-only, so the
  Content-Type gate doesn't apply.
- Untrusted input: stored skill/agent/tool names and `caller` strings come from
  transcripts — data, never instructions.
- Web UI: a global **CC Dashboard** entry in the sidebar (above Projects, next to
  Inbox) at `#/cc` — KPI cards, a daily stacked-token chart and model donut (tiny
  hand-rolled SVG in `frontend/src/components/charts.tsx`, no chart dependency),
  and sortable skill/agent/project/session tables. The **skills** table is the
  headline view for optimizing where token spend goes.
- **Project-scoped view**: a project page's **Dashboard** tab (`#/projects/:id/dashboard`,
  first tab, before Board) reads `GET /api/projects/{id}/cc?window=` and renders
  the same `CCDashboardView` component with a `projectId` prop (`scoped` mode):
  KPI cards, model donut, and daily chart only — the Projects sub-table and the
  account-wide Live Sessions/Subscription Limits cards are omitted (they read
  separate unscoped endpoints with no project filter). A project with no
  matching transcript activity renders a quiet zero-state, never an error.
  Registered like the Git/Agents/Storyboards tabs: a route match in `App.tsx`
  feeding a boolean prop into `ProjectTasksPage.tsx`'s tab bar and content switch.
- Gate: `scripts/cc-check.sh` drives `mesa cc` against a synthetic transcript
  tree (`MESA_CC_PROJECTS_DIR`) + throwaway db (`MESA_DB`) and asserts the JSON
  contract, sync idempotency, tool-call/subagent rows, persistence across
  transcript deletion, and auto-ingest on a plain read.

## Subscription usage (the one network read)

`mesa cc usage` / `GET /api/cc/usage` shows live **plan-limit utilization** (the
5-hour and weekly windows, reset times, extra-usage credits) — the data behind
Claude Code's own `/usage`. This is the **only** part of mesa that makes an
outbound network call: it is **not** in transcripts, so `core::usage` fetches it
from Anthropic's OAuth usage endpoint (`https://api.anthropic.com/api/oauth/usage`,
header `anthropic-beta: oauth-2025-04-20`). It authenticates with the **local
Claude Code OAuth token** read from `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived
`claude setup-token`), else the macOS Keychain (`security -s "Claude
Code-credentials"`) or `~/.claude/.credentials.json`; the token never leaves the
process — only the usage numbers reach the client. Like the CLI's git calls, it
**shells out to `curl`** rather than adding a TLS dependency. `plan_tier` is read
from `~/.claude.json`. Overrides for tests: `MESA_CC_TOKEN`, `MESA_CC_USAGE_URL`.
The API caches the result for 60s (`AppState.usage_cache`) so UI polling doesn't
hammer the endpoint; a missing token / unreachable upstream is a **502
`{"error":{"code":"unavailable",…}}`** (CLI: same error JSON, exit 1) — a new
error code scoped to this endpoint, which the web card renders as "unavailable".
The Web UI shows it as the **Subscription Limits** card beside Live Sessions.
