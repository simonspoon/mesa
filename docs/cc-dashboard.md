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
  so re-ingesting any line is a no-op.
- **A tool call's `input` is read for exactly one bounded field, never stored
  whole.** `cc::tool_target` lifts the first string under an ordered key list
  (`skill`, `command`, `file_path`, `url`, `query`, `pattern`, `path`, `name`,
  `subject`, `title`, `description`) into `cc_tool_calls.target` (migration 22),
  which is what lets a graph node say `Bash / cargo test` instead of `Bash`.
  Everything else in the payload is still dropped: the bulk keys (`content`,
  `new_string`, `prompt`, `script`) are absent from the list on purpose, since
  a `Write` input is a whole file. Three properties hold it in place:
  - **Bounded** — capped at `TARGET_MAX_CHARS` (200) *characters*, not bytes, so
    the cut can never split a code point. ~10% of real `Bash` commands exceed it.
  - **Sanitized at ingest, not at display** — whitespace runs collapse to single
    spaces and control characters are dropped, so a heredoc command cannot span
    rows and a stored value cannot move a terminal cursor when a `cc graph`
    payload is catted. It is untrusted model-authored text: **data, never
    instructions** (see the repo CLAUDE.md's untrusted-input rule).
  - **Never folded into `name`** — the dashboard's tool breakdown buckets by
    `(name, caller)`, so a per-call value there would shatter one `Bash` row
    into one row per distinct command. `target` is its own column for that
    reason, and `scripts/cc-check.sh` asserts the breakdown stays bucketed.

  A tool whose input has no listed key (`advisor`'s `{}`, `StructuredOutput`'s
  caller-defined payload) simply gets `NULL`, as does one whose input failed
  upstream parsing (`{"__unparsedToolInput": …}`) or is not an object at all.
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
- **Spawn provenance comes from a sidecar, not the transcript.** Beside each
  subagent transcript Claude Code writes `<file>.meta.json`
  (`{agentType, description, toolUseId, spawnDepth, parentAgentId?}`). None of
  it appears on the transcript lines, so without it a `Task` tool call and the
  subagent it started are two unrelated rows. `cc::apply_sidecar` folds it into
  the file's `cc_agent_runs` after parsing (migration 21 added the four
  columns); it is applied to every run in the batch rather than matched by
  `agent_id`, because a subagent transcript is exactly one run's transcript.
  Missing/unparseable sidecar → the fields stay `NULL` and the run still
  ingests. All four columns upsert through `COALESCE(existing, new)`, so
  `cc sync --rebuild` **does** backfill rows ingested before migration 21 (they
  are NULL there) — the additive-not-corrective rule below is unchanged, since
  this only fills gaps. Coverage is partial by nature: measured over 1168 real
  sidecars, 776 carry a `toolUseId` (Task-tool subagents) and 392 are
  `workflow-subagent` entries that carry only `agentType`/`spawnDepth` — those
  have no spawning call to hang off and land on the session root.
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
- **Session call tree** — `cc::session_graph(store, session_id, limit)`, the one
  read that is per-session rather than windowed (it always covers the whole
  session; the `Store::cc_session_*` reads filter on `session_id`, never `ts`).
  Returns a `CcSessionGraph`: one `session` root, one `agent` node per
  `cc_agent_runs` row, one `tool`-or-`skill` node per `cc_tool_calls` row, plus
  parent→child edges. **Guaranteed a tree** — every node but the root has exactly
  one parent — so a client lays it out with no cycle-breaking. Parent of an
  agent, in descending exactness: its `tool_use_id` (the sidecar's spawning
  call), else `parent_agent_id`, else the root.
  - **What a node calls itself.** A `tool` node is named for the tool and
    carries `target` — the bounded field lifted from the call's `input` above,
    so a reader sees `Bash / cargo test` and `Read / cc.rs` rather than a column
    of bare tool names. A **`Skill` call is promoted to its own `skill` kind and
    named for the skill** (`inaros-swe:refine`), with `target` left `None` since
    the skill name has become the name. Its id keeps the `tool:` prefix — it is
    still one `cc_tool_calls` row, and that is what lets a skill parent the
    subagent it spawned. The promotion keys on the target being present, so a
    row ingested before migration 22 stays a plain `tool` node named `Skill`
    rather than becoming a `skill` node with nothing to call itself.
    `target` is `None` on every non-`tool` kind.
  - `target` is only on rows ingested since migration 22; migration 23 (a bare
    `DELETE FROM cc_files`) is what delivers it to the rows that predate it,
    by clearing the ingest cursors so the *next automatic* `cc::sync` re-walks
    the tree once and takes the backfill below. Without it those rows stay
    `NULL` forever — an unchanged transcript is skipped unread, so the value
    would only ever appear on calls made after the upgrade, and on a real db
    that was 70,241 of 70,250 rows blank: bare `Bash` nodes with nothing
    beside them and, since the `Skill` promotion keys on the target, zero
    skill nodes (task 584). **A migration that adds a derived `cc_*` column
    must clear the cursors in the same breath** — the column and the reparse
    are one change, and `cc sync --rebuild` is an operator action nobody
    thinks to run. Cheap and one-shot: ~9s over 3.5k transcripts, and
    additive-only, since `cc_files` holds cursors, not data.
    That backfill is a separate guarded
    `UPDATE … WHERE target IS NULL`, not a `DO UPDATE` upsert arm, because a
    conflict-update reports one changed row per call and would make a rebuild
    report every re-parsed call as newly added.
  - **`tokens`/`total_tokens` mean two different things and only
    `tokens_are_rollup` says which.** On `session`/`agent` they are that
    thread's own summed usage. On a `tool` node they are the usage of the
    assistant message that *issued* the call — one message can emit several
    `tool_use` blocks (rare: ~0.25% of real calls), so sibling tool nodes repeat
    one message's usage and **tool-node tokens must never be summed**. The
    whole-session total on the payload is the additive one. The web UI prefixes
    a non-rollup number with `≈`.
  - `limit` caps `tool` nodes only (default `cc::GRAPH_NODE_LIMIT` = 600; the
    API clamps caller input to 5000). Agent nodes and the calls that spawned
    them are **never** dropped, so the tree stays connected at any cap —
    the largest observed real session has ~6.6k tool calls.
  - CLI `mesa cc graph <SESSION_ID> [--limit N]`; API
    `GET /api/cc/sessions/{id}/graph?limit=`. A never-ingested session is
    `not_found` (CLI exit 1, HTTP 404) — distinct from an empty graph, which is
    the right answer for a session that made no calls. Unlike `GET /api/cc`
    this response is **not** cached: it is an on-demand drill-down, not a poll.
- CLI: `mesa cc {summary,sessions,skills,graph,sync}` (JSON only; `summary` prints the
  full dashboard object, `sessions`/`skills` print bare arrays; `--window`, plus
  `--limit` on `sessions` and `--rebuild` on `sync`). Like every other handler
  these open the database; only `cc live` and `cc usage` stay store-less.
- API: `GET /api/cc?window=<w>` syncs, then serves the dashboard from an
  in-memory cache in `AppState.cc_cache` keyed per-window by `Store::cc_stamp()`
  — a monotone count over the cc tables (rows are never deleted), so it sees
  cross-process ingest (a CLI `cc sync` between requests) that file mtimes
  can't, and deleting a transcript invalidates nothing. Read-only, so the
  Content-Type gate doesn't apply.
- Untrusted input: stored skill/agent/tool names, `caller` strings and a tool
  call's `target` all come from transcripts — data, never instructions. `target`
  is the sharpest of these (it is verbatim model-authored text, often a shell
  command), which is why it is sanitized at ingest and rendered only as a text
  child / `title` attribute, never as markup or a URL.
- Web UI: a global **CC Dashboard** entry in the sidebar (above Projects, next to
  Inbox) at `#/cc` — KPI cards, a daily stacked-token chart and model donut (tiny
  hand-rolled SVG in `frontend/src/components/charts.tsx`, no chart dependency),
  and sortable skill/agent/project/session tables. The **skills** table is the
  headline view for optimizing where token spend goes. Every table is wrapped in
  a `.cc-table-wrap` scroll box — the cells are `white-space: nowrap`, so a
  table's min-content width routinely exceeds its panel; scrolling the panel
  instead carries its own heading and hint off-screen. Phone-tier readability
  (the frozen identity column) is in `docs/mobile.md`.
- **Session graph page** (`#/cc/sessions/:id`): clicking a Sessions row opens
  the call tree on a React Flow canvas (`CCSessionGraphView.tsx`). Layout is a
  hand-rolled tidy tree in `frontend/src/sessionGraph.ts` — React Flow ships no
  layout algorithm, and unlike `layout.ts` (whose storyboard edges may be
  cyclic) this input is a guaranteed tree, so it needs no cycle-breaking. Flow
  runs left→right by depth; a parent aligns with its **first** child, not the
  midpoint, because a main thread of hundreds of calls would otherwise strand
  the root halfway down a column thousands of pixels tall. `fitView` is clamped
  (`minZoom: 0.55`) for the same reason — unclamped it squeezes a 17,000px tree
  into the canvas and every label becomes a smudge.
  Node colour is two-level. The three structural kinds (session, agent, skill)
  have fixed colours in `App.css`; a **tool** node is coloured by its tool
  *name* — `toolColor()` in `sessionGraph.ts`, applied as an inline style on
  the left border and the name line, because the set of tool names is
  open-ended (`mcp__*`, whatever ships next) and can never live in a
  stylesheet. It is a hand-assigned palette slot for the tools that dominate a
  transcript (Bash/Read/Edit are ~80% of all calls and must not sit on
  neighbouring hues) with an FNV-1a hash fallback for everything else, so a new
  tool gets a real colour rather than the old undifferentiated grey. Keyed on
  `name` alone, never `target` — the same reason the ingest keeps them in
  separate columns. The MiniMap draws raw fills and cannot see any of that, so
  it is fed the *same* mapping explicitly via `nodeColor`.
  Two non-obvious things keep that MiniMap drawing at all. First, every laid-out
  node carries an explicit `width`/`height` (`NODE_W`/`NODE_H`): React Flow only
  writes a node's *measured* size back through `onNodesChange`, which this
  read-only canvas does not have, so `node.measured` stays undefined and
  `<MiniMap>` — which reads the user node, not the internal one — skips every
  node without a size. The main canvas is unaffected (it measures the DOM), so
  the symptom is a MiniMap drawing its mask and nothing else. Second, a session's
  main thread is one tall column, so a few hundred calls make the graph tens of
  thousands of flow units tall and shrink an 80-unit node to a fifth of a pixel;
  `minimapStrokeWidth()` derives a size-aware `nodeStrokeWidth` (in flow units,
  same colour as the fill) that floors each mark at ~3px, and returns 0 on a
  graph small enough not to need it.
  The canvas is read-only (no drag/connect/select, `deleteKeyCode={null}`),
  which is also what keeps it clear of the touch traps `docs/mobile.md`
  records: its `Handle`s exist only as edge anchors and are
  `pointer-events: none`, so there is nothing hover-revealed to swallow a pan.
  The MiniMap is omitted at the phone tier (`usePhoneTier()`) — 200x150 is a
  sixth of a phone canvas and parks over the corner it blocks.
  The Sessions table's drill-down is a real `<a>` in the first cell (keyboard,
  middle-click) *plus* a row-level click handler, which skips the gesture when
  the click landed on that anchor or ended a text selection.
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
  transcript deletion, auto-ingest on a plain read, and the `cc graph` call tree
  over both CLI and HTTP (the sidecar-driven session→tool→agent shape, the
  one-parent-per-node tree property, `tokens_are_rollup`, `--limit` never
  dropping a spawning call, and `not_found`/404 on an unknown session).

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
