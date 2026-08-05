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
  which is what lets a timeline row say `Bash / cargo test` instead of `Bash`.
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
- **An assistant message's own prose is kept only as a bounded preview** —
  `cc_messages.preview` (migration 24, nullable), the second derived `cc_*`
  column and the one deliberate relaxation of "bulk keys are never stored".
  `NULL` means the message emitted no prose, which is also how every row
  ingested before the column existed reads, so no reader has to distinguish
  "no prose" from "not extracted yet". It carries the same three properties
  `target` does — bounded by characters, sanitized at ingest, its own column —
  and the same two-part upgrade path: a row that predates the column is filled
  by a separate guarded `UPDATE … WHERE uuid = ?1 AND preview IS NULL` rather
  than a `DO UPDATE` arm, so a re-walk of an already-ingested db reports the
  handful of genuinely new rows instead of a fake 138k-row import; and the
  cursor clear that *delivers* that re-walk ships with the change that makes
  ingest emit a preview, never with the bare column — the re-walk is one-shot,
  and spending it under a binary that still writes `NULL` is task 583's
  9-of-70,250 outcome all over again. (That cursor clear is migration 25,
  appended alongside the extraction as its own entry, in migration 23's shape.)

  Measured on a copy of the real db (task 610): opening it with the new binary
  moves `user_version` 23 → 25 and empties `cc_files` (3,633 cursors → 0), so
  `preview` starts 100% `NULL` on 138k rows. The **next ordinary `cc sync`** —
  no `--rebuild` anywhere — re-walks the 3,573 transcripts still on disk in
  ~10s, reports `messages_added: 50` (genuinely new lines, not 138k) and
  backfills 19,533 previews; the sync after that ingests nothing, so the
  re-walk really is one-shot. The ~14% fill rate is correct, not a shortfall
  (see the block-type census in the next paragraph). One inherent gap: a message whose
  transcript file has since been deleted keeps `preview` `NULL` forever — the
  prose is no longer there to re-read.

  What is extracted (`RawMessage::assistant_text`): the `text` of every
  `type: "text"` block of one assistant line, **in array order, joined with a
  single space, then sanitized and capped once** — one preview per *message*,
  never one per block, so the 200-character cap bounds the message. The
  sanitizer is `tool_target`'s, factored out as `sanitize_capped`: one policy
  for every untrusted transcript string mesa stores, not a second one.
  `thinking` blocks are **excluded**: they would land reasoning prose in the
  same unlabelled column with nothing to tell it from the reply, and thinking
  routinely dwarfs the response, so it would win the cap and push the actual
  reply out. On real transcripts most assistant messages have no preview at
  all — over the 40 largest transcripts, 4,414 messages were `tool_use`-only
  and 2,097 `thinking`-only against 1,501 carrying any `text`, so the excluded
  population is larger than the kept one and a low fill rate is the expected
  shape, not a miss.
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
- **Cost is estimated at read time** from a per-model price table (USD per
  Mtok) — tokens are stored, dollars never are. The table is
  `config::PriceTable`: the rates mesa ships, overlaid by the `pricing` section
  of `~/.mesa/config.json` and editable from the Settings page
  (`docs/config.md`), so a price change or a new model family needs no rebuild.
  Matched on a model-family prefix, longest match winning, so point releases
  price correctly and a variant can be priced beside its family; an unmatched
  model estimates $0. Because cost is derived on every read, an edit
  retroactively restates every historical figure — intended. The table is
  loaded **once per request**, never per message. Labelled "estimated" in the
  UI.
- Window is `7d`/`30d`/`90d`/`all`/`<n>d`, applied at read time over persisted
  rows (ingest is always total). Transcript location resolves from
  `MESA_CC_PROJECTS_DIR` (tests) → `$CLAUDE_CONFIG_DIR/projects` → `~/.claude/projects`;
  `MESA_DB` isolates the store as everywhere else.
- The read entry point is `cc::collect(store, window) -> CcDashboard` (overview +
  daily series + model/skill/agent/project/tool breakdowns + capped session rows).
- **Session detail** — `cc::session_detail(store, session_id) -> Option<CcSessionDetail>`,
  the other per-session read and the **default** drill-down. Whole-session
  rollup + the main thread vs each subagent (`CcSessionThreadStat`, keyed on
  `agent_id` exactly as the call tree keys threads), per-model / per-tool /
  per-skill breakdowns, and an activity series of `cc::ACTIVITY_BUCKETS` (60)
  evenly-sized buckets over the span (the last inclusive of `end_ts`; a session
  with no usable span is exactly one bucket). Aggregated over **every**
  persisted row — no cap, no truncation flag.
  **Why this is a server-side read rather than something the browser derives
  from the graph payload:** the graph caps its tool nodes
  (`GRAPH_NODE_LIMIT = 600`, API clamp 5,000) so a per-tool count taken from
  its nodes would silently cover only a prefix of a long session (real sessions
  reach ~6.6k calls); and its tool/response nodes carry no message identity and
  repeat their issuing message's usage, so a token-over-time series is not
  derivable client-side at all. Tools are keyed on `name` alone, never `target`
  (the same rule as `toolColor`), and a `Skill` call is promoted into `skills`
  under the skill it ran — the same promotion the call tree does.
  CLI `mesa cc session <SESSION_ID>`; API `GET /api/cc/sessions/{id}` (no query
  parameters). Unknown session is `not_found` (CLI exit 1, HTTP 404); like the
  graph it syncs first and is **not** cached — an on-demand drill-down, not a
  poll.
- **Session call tree** — `cc::session_graph(store, session_id, limit)`, the one
  read that is per-session rather than windowed (it always covers the whole
  session; the `Store::cc_session_*` reads filter on `session_id`, never `ts`).
  Returns a `CcSessionGraph`: one `session` root, one `agent` node per
  `cc_agent_runs` row, one `tool`-or-`skill` node per `cc_tool_calls` row, one
  `response` node per `cc_messages` row whose `preview` is non-`NULL`, plus
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
    `target` is `None` on `session`, `agent` and `skill` nodes; `tool` and
    `response` are the two kinds that carry it.
  - **A `response` node is what the assistant *said*.** One per message with a
    stored `preview`, id **`msg:<message uuid>`** — a fourth id namespace,
    disjoint from `session` / `agent:` / `tool:`, and unique within a graph
    because `cc_messages.uuid` is the primary key. It is named the constant
    `"Response"` and reuses `target` for the preview verbatim (that field is
    already "what this node is about, sanitized, capped at `TARGET_MAX_CHARS`,
    untrusted" — precisely a preview), so no new field, no new read path and no
    change to the `tool:` scheme or the `Skill` promotion. A message with no
    prose gets no node, so a prose-free session's payload is byte-identical to
    before apart from `"omitted_responses": 0`.
    - **Flat sibling, never a parent.** A response hangs off the same parent as
      the tool nodes of its own message — the root, or `agent:<agent_id>` in a
      subagent thread. A message with prose plus two calls yields three edges
      from one parent and none between them; nothing is ever `from` a `msg:`
      id, so the graph stays a tree with the same depth as before.
    - **Equal-`ts` sibling order is fixed server-side: response first.** A
      message emits its prose and its calls at the same instant, and the
      frontend's `childrenByParent` tie-breaks an equal `ts` by *server node
      order* — so the order cannot be an artifact of which loop pushed first.
      Tool and response nodes are built into one pending list and sorted by
      `(ts, kind_rank, id)` with `kind_rank` response = 0, tool = 1, `id` the
      final tie-break, then pushed in that order. Deliberately **not** a
      responses-first pass: `nodes` is documented "root first, then the rest
      oldest first" and `mesa cc graph` is read as a time-ordered column, which
      a two-pass emission would silently break for every CLI reader. Since
      `cc_session_tool_calls` already returns `ORDER BY ts, tool_use_id`, the
      `id` tie-break reproduces the previous tool order byte-for-byte.
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
    thread's own summed usage. On a `tool` or `response` node they are the
    usage of the assistant message that *issued* the call — one message can
    emit several `tool_use` blocks (rare: ~0.25% of real calls) and its prose
    besides, so those siblings all repeat one message's usage and **their
    tokens must never be summed**. A response node adds no summable number and
    moves no aggregate: it is the same usage its sibling tool nodes already
    carry, marked `tokens_are_rollup: false` like theirs. The
    whole-session total on the payload is the additive one. The web UI prefixes
    a non-rollup number with `≈`.
  - `limit` caps `tool` nodes (default `cc::GRAPH_NODE_LIMIT` = 600; the
    API clamps caller input to 5000). Agent nodes and the calls that spawned
    them are **never** dropped, so the tree stays connected at any cap —
    the largest observed real session has ~6.6k tool calls.
    Responses are a **second unbounded population**, so the same `limit` value
    is applied to them **independently**, oldest-first, and what it drops is
    reported by its own `omitted_responses`. Sharing the tool budget would make
    `omitted_tool_calls` count non-tools; exempting responses would leave the
    payload unbounded. `omitted_tool_calls` therefore keeps its exact previous
    meaning and value, and `truncated` now means "**either** population was
    cut".
  - CLI `mesa cc graph <SESSION_ID> [--limit N]`; API
    `GET /api/cc/sessions/{id}/graph?limit=`. A never-ingested session is
    `not_found` (CLI exit 1, HTTP 404) — distinct from an empty graph, which is
    the right answer for a session that made no calls. Unlike `GET /api/cc`
    this response is **not** cached: it is an on-demand drill-down, not a poll.
- CLI: `mesa cc {summary,sessions,skills,session,graph,sync}` (JSON only; `summary` prints the
  full dashboard object, `sessions`/`skills` print bare arrays; `--window`, plus
  `--limit` on `sessions` and `--rebuild` on `sync`). Like every other handler
  these open the database; only `cc live` and `cc usage` stay store-less.
- API: `GET /api/cc?window=<w>` syncs, then serves the dashboard from an
  in-memory cache in `AppState.cc_cache` keyed per-window by `Store::cc_stamp()`
  — a monotone count over the cc tables (rows are never deleted), so it sees
  cross-process ingest (a CLI `cc sync` between requests) that file mtimes
  can't, and deleting a transcript invalidates nothing. Read-only, so the
  Content-Type gate doesn't apply.
- Untrusted input: stored skill/agent/tool names, `caller` strings, a tool
  call's `target` and a message's `preview` all come from transcripts — data,
  never instructions. The last two are the sharpest (verbatim model-authored
  text, often a shell command or free prose), which is why both are sanitized
  at ingest and rendered only as a text child / `title` attribute, never as
  markup or a URL.
- Web UI: a global **CC Dashboard** entry in the sidebar (above Projects, next to
  Inbox) at `#/cc` — KPI cards, a daily stacked-token chart and model donut (tiny
  hand-rolled SVG in `frontend/src/components/charts.tsx`, no chart dependency),
  and sortable skill/agent/project/session tables. The **skills** table is the
  headline view for optimizing where token spend goes. Every table is wrapped in
  a `.cc-table-wrap` scroll box — the cells are `white-space: nowrap`, so a
  table's min-content width routinely exceeds its panel; scrolling the panel
  instead carries its own heading and hint off-screen. Phone-tier readability
  (the frozen identity column) is in `docs/mobile.md`.
- **Session detail page** (`#/cc/sessions/:id`) — what clicking a Sessions row
  opens. `CCSessionDetailView.tsx` over `GET /api/cc/sessions/{id}`: KPI row
  (tokens, est. cost, duration, messages, tool calls, subagent runs, cache-hit
  ratio, tokens/minute), a token-composition donut, one `Sparkbars` per
  activity series (tokens and tool calls get their own scale — sharing one
  would flatten the calls into the axis), a top-12-plus-`other` tool bar list,
  and models / threads tables. The page's pure logic lives in
  `frontend/src/sessionDetail.ts` (vitest-covered, per CLAUDE.md's
  frontend-test rule), which also owns the shared `TOK` colour map and the
  `fmtTok`/`fmtUsd`/`fmtPct`/`fmtInt` formatters the dashboard imports; the
  sortable `DataTable` and the `Kpi` card moved to
  `frontend/src/components/ccTable.tsx` unchanged so both pages use one
  implementation. Charts still come only from `components/charts.tsx` — no
  chart dependency. Zero states (no tool calls, no subagents, no skills) are
  quiet muted lines, never errors, and `agent`/`skill`/`description`/tool names
  /`project`/`cwd` are rendered as text children or `title` attributes only.
- **Session timeline page** (`#/cc/sessions/:id/timeline`): one link
  (`Timeline →`) from the detail page above, which its own `← Session` link
  returns to. A chronological, thread-grouped **row list**
  (`CCSessionTimelineView.tsx`) over the same `GET /api/cc/sessions/{id}/graph`
  payload — which is unchanged, and is still `mesa cc graph`'s.
  `#/cc/sessions/:id/graph` is kept as an alias of this route so links and
  bookmarks from the React Flow canvas that used to live here still resolve
  (mesa task 691). The two route patterns are disjoint — the id segment is
  `[^/]+`, so a trailing suffix can never be swallowed by the detail pattern —
  and all of them keep the nav highlighting Sessions.
  A list rather than a canvas because a session's "tree" is almost always one
  straight column of a few hundred main-thread calls: the graph paid
  canvas/pan/zoom/minimap cost to encode structure that was nearly always
  trivial (its `fitView` had to be clamped precisely because an unclamped one
  squeezed a 17,000px column into a smudge), while what a reader wants — what
  happened, in order, what it acted on, what it said, where the tokens went —
  is a list, which is also scannable, searchable and phone-usable. The only
  genuinely tree-shaped content is a subagent run, and that reads fine as
  indentation under its thread's header row.
  The page fetches with `limit=5000` (the server's own clamp, no server
  change): plain rows are cheap where 600 canvas nodes were not.
  Pure logic lives in `frontend/src/sessionTimeline.ts` (vitest-covered, per
  CLAUDE.md's frontend-test rule): `threadOf` walks the edges up to each node's
  nearest `agent` **ancestor** (so an agent's own row sits at the indent of the
  thread that spawned it, with its children one level in) with a seen-set that
  survives a malformed cyclic payload; `timelineRows` drops the `session` root
  (its data is the page header) and otherwise **preserves payload order** — the
  server already emits "root first, then oldest first" with equal-`ts` ties
  fixed as response-before-tool, so nothing client-side re-sorts. Its one
  exception is placement, not sorting: `cc::session_graph` appends every
  **agent** node after the whole tool/response block, so at its literal payload
  position a subagent's header row lands at the bottom of the page, hundreds of
  rows below the run it names — each header is therefore emitted immediately
  before the first row of its own thread (outer thread first, for a nested
  spawn), and an agent whose rows were all truncated away still appears, at the
  end. Tool and response rows never move; `filterRows`
  applies the case-insensitive substring over `name` + `target`, the kind
  allow-set and an optional thread (whose own agent header row is kept);
  `threadOptions` builds the selector, main thread first, subagents in
  first-appearance order, each labelled from `name`/`skill`/`description` with
  a non-blank fallback.
  A row is: clock (`HH:MM:SS` from `ts`, blank when null) · `name` · the
  `target`/preview, wrapped and CSS-line-clamped with the full value in the
  hover `title` · a right gutter of `shortModel(model)` and
  `formatTokens(total_tokens)`, prefixed `≈` when `tokens_are_rollup` is false
  and carrying the same explanatory `title` as before — a tool/response row's
  tokens are the *issuing message's*, shared with its siblings, so no column of
  them is ever summed. The honest total is the payload's `total_tokens`, in the
  header.
  Row colour keeps the old two-level split. The structural kinds (agent, skill)
  have fixed colours in `App.css`; a **tool** row is coloured by its tool
  *name* — `toolColor()` in `sessionGraph.ts`, applied as an inline style on
  the left border and the name, because the set of tool names is open-ended
  (`mcp__*`, whatever ships next) and can never live in a stylesheet. It is a
  hand-assigned palette slot for the tools that dominate a transcript
  (Bash/Read/Edit are ~80% of all calls and must not sit on neighbouring hues)
  with an FNV-1a hash fallback for everything else. Keyed on `name` alone,
  never `target` — the same reason the ingest keeps them in separate columns.
  A **response** row is on the structural side of that split, not the hashed
  one: `toolColor()` keys on a tool *name* and a response has none, so it owns
  a reserved `RESPONSE_COLOR` (`hsl(36, 30%, 76%)`) written once in
  `sessionGraph.ts` and mirrored into `.cc-tl-row.kind-response` in `App.css`.
  A pale warm neutral is the one free band — every `TOOL_PALETTE` entry sits at
  35%+ saturation and agent/skill own the neon hues — so a reply can never be
  mistaken for a call. `sessionGraph.ts` is now only these shared presentation
  helpers (`formatTokens`, `shortModel`, `toolColor`, `RESPONSE_COLOR`,
  `shortTarget`, all still used by the dashboard and detail pages); the tidy-tree
  layout, the `NODE_W`/`NODE_H` box and `minimapStrokeWidth` went with the
  canvas. `@xyflow/react` stays a dependency — the storyboard canvas uses it.
  The truncation banner gates each of its two sentences on its own counter
  (`omitted_tool_calls` / `omitted_responses`), since `truncated` means either
  population was cut and a response-only truncation would otherwise read
  "0 omitted" tool calls. Zero states are quiet muted lines — "This session
  recorded no tool calls or subagent runs." and, when a filter excludes
  everything, "No rows match this filter." — never errors. Every
  model/transcript-authored string (`target`/preview, `name`, `caller`,
  `description`, `skill`, `project`, `cwd`) renders as a text child or a
  `title` only: never markup, never an `href`, and a path or URL target is
  deliberately not linkified. At the phone tier (`docs/mobile.md`, ≤600px) the
  five-track row grid collapses to clock · name · tokens with the body and
  model wrapping full-width beneath.
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
  dropping a spawning call, and `not_found`/404 on an unknown session). The
  fixture carries a dedicated prose session whose one message emits a `text`
  block **and** two `tool_use` blocks at a single timestamp — that equal-`ts`
  line is the only way to assert the `[response, tool, tool]` sibling order —
  plus a prose-free message that must get no node, and it is appended after
  every whole-dashboard count assertion so it perturbs none of them.
  `cc session` is asserted the same way over both surfaces: the key set, totals
  agreeing **with the graph's** `total_tokens`/`est_cost_usd` (two code paths,
  one answer), `agents` length matching `agent_runs`, the activity buckets
  summing to the session's own message/tool-call/token totals, an HTTP payload
  equal to the CLI's, `--quiet` rejected (exit 2), and `not_found`/404 on an
  unknown session. Exactness past the graph's cap is a `cc.rs` unit test (701
  tool calls in one session), not a shell fixture.

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
