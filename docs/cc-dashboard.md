# CC Dashboard (Claude Code telemetry)

An **analytics surface** over Claude Code's own session transcripts — the
newline-delimited JSON under `~/.claude/projects/**/*.jsonl` (including
subagent transcripts in `<session>/subagents/*.jsonl`). Transcripts are
**ingested** into `cc_*` tables (sessions, agent runs, messages, tool calls,
prompts, per-file cursors — migration 12, plus `cc_prompts` at 31 and
`cc_node_files` at 34) through `Store` — the single-write-path
invariant holds here too — and **the dashboard reads only the db**, never the
files, so history survives Claude Code's own transcript cleanup and nothing is
ever double-counted. The parsing/aggregation lives in `src/core/cc.rs` so the
CLI and API share it and never diverge.

**Three reads carve out of "db only", and only three**: `cc live` (a direct
parse of the last few minutes, where the files are by definition still
present), `cc text` (one node's full body, which is deliberately not in the db
— see *Node text* below) and `cc chat` (one session's whole conversation, for
both of those reasons at once — see *Session chat* below). Everything else
answers from `cc_*` alone.

Migration numbers in this file are the **resulting `user_version`**, i.e.
1-based: `MIGRATIONS` in `src/core/store.rs` is a 0-indexed array, so
"migration 34" is `MIGRATIONS[33]`. Enumerate the array rather than counting the
comments — several entries are the bare `DELETE FROM cc_files;` cursor clear.

- Each transcript line is one event. Only `assistant` events carry a `model` and
  a `usage` block (`{input, output, cache_read, cache_creation}` tokens), so
  those drive token/cost/model/skill/agent/tool rollups. One other kind of line
  produces a row of its own: a `user` line that `cc::human_prompt` judges to be
  a **real human turn** becomes a `cc_prompts` row (migration 31) — a bounded
  preview and nothing else, in its own table, contributing to no total (see
  *Human prompts* below). Every other timestamped line merely widens its
  session's start/end span. Unparseable or non-telemetry lines are skipped. Subagent lines carry the **parent's** `sessionId` plus an `agentId`,
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
- **One API response is several transcript lines, and usage is counted once per
  response.** Claude Code writes a single assistant response as a *line per
  content-block group* — typically a `thinking` line, then the
  `text`/`tool_use` line — and **repeats the identical `message.usage` block on
  every one of them**. Rows are keyed on the per-line `uuid`, so summing rows
  counted one billed call 2-4 times: measured over three days of real
  transcripts, 3,971 assistant usage lines carried only 2,557 distinct
  `message.id` values (groups of 2 ×1,200, 3 ×104, 4 ×2), **zero** groups
  disagreed on their usage, and every group sat inside one file and one
  session. That was ~35-40% inflation on every token and cost figure mesa
  reported, everywhere.

  `message.id` is the **billing identity** and is stored as
  `cc_messages.message_id` (migration 29, nullable). The rows stay **per line**
  — `cc_tool_calls.message_uuid` points at an event uuid and the call tree
  draws one `response` node per line — and instead **every read that sums usage
  dedupes in Rust**: iterate in a deterministic order (`ORDER BY ts, uuid`) and
  let a row contribute its tokens, cost and `messages` count only the first
  time its key is seen. The key (`cc::dedupe_key`) is `message_id` when
  non-`NULL`, else the row's own `uuid`, so a row predating the column or a
  line genuinely without a `message.id` is counted exactly once, never dropped.
  Applied in `cc::collect_inner`, `cc::session_detail`, the live path
  `cc::parse_live_file` (which parses files directly and duplicates
  identically), and the thread rollup inside `cc::session_graph` — that last
  one so a session's KPIs and its own call tree can't disagree; the graph's
  *nodes* are untouched.

  **The advisor exception:** `fold_line` emits a second `cc_messages` row for
  an advisor call's nested `usage.iterations[]`, keyed on the parent event's
  uuid plus a suffix. Its `message_id` is its own synthetic key —
  `<parent message.id>:advisor:<i>` — never the parent's bare `message.id`,
  which would discard real advisor tokens as a duplicate of the wrapper turn
  (the copy repeated on each line of one response still collapses to one).
  Covered by `cc::tests::one_api_response_written_as_several_lines_is_counted_once`.

  Existing rows predate the column, so it takes the same two-part upgrade
  `preview` did: a separate guarded `UPDATE cc_messages SET message_id = ?2
  WHERE uuid = ?1 AND message_id IS NULL` in `Store::cc_ingest_file` (never a
  `DO UPDATE` arm, so `messages_added` keeps meaning "rows inserted"), plus a
  **`DELETE FROM cc_files;` cursor clear as migration 30**, shipped in the same
  binary as the extraction so the next *ordinary* `cc sync` re-walks every
  transcript once and fills the column. Releasing the bare column alone is the
  bug.

  Measured on a copy of the real db: opening it moves `user_version` 28 → 30
  and empties `cc_files` (3,956 cursors → 0); the next ordinary `cc sync`
  re-walks 3,292 transcripts, reports `messages_added: 166` (genuinely new
  lines, not 151k) and fills `message_id` on 95,508 of 151,307 rows. The
  remainder are rows whose transcript has since been deleted — the same
  inherent gap `preview` has — and they keep counting under their `uuid`.
  The 7-day total went 906.9m → 391.0m tokens.
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
- **Human prompts are ingested too, as their own bounded rows** —
  `cc_prompts (uuid, session_id, ts, preview)` (migration 31), the third
  derived `cc_*` store and the same relaxation of "bulk keys are never stored"
  that `preview` is: one sanitized, `sanitize_capped`-bounded ≤200-char string
  per turn, never the prompt body. Without it a session read as a wall of
  effects with no causes — the *agent's* every move was recorded and the human
  turns that provoked them were invisible.

  **Its own table, not a `role` column on `cc_messages`.** Every row of that
  table is an assistant *usage* event; a user line carries neither `model` nor
  `usage`, so it would leave most of those columns empty and land in every read
  that sums them. There is deliberately **no `agent_id`** either (see
  main-thread-only below), and no `CcSyncReport` counter — no reader reports
  prompt volume, so a field there would ripple into the TS type and several
  `cc-check.sh` count assertions for nothing.

  **The predicate is the whole problem.** Claude Code writes far more `user`
  lines than the user ever typed, so `cc::human_prompt(&RawLine) -> Option<String>`
  is the single place that decides which of them a human authored — a pure
  function, so the decision is unit-testable against a synthetic line rather
  than only through a whole `sync`. In order:
  1. `type == "user"`.
  2. Not `isMeta` — that flag marks Claude Code's own injections: hook output,
     skill bodies, image stubs, caveat banners.
  3. Not `isSidechain`. A sidechain user line is a **subagent's task prompt**,
     already carried by the agent node's `description`; prompts are
     **main-thread only**, which is what makes "always a child of the session
     root" true and why the table needs no `agent_id`.
  4. No `toolUseResult`, **and** no `tool_result` block anywhere in
     `message.content` — ~794 result carriers in the real corpus lack the
     `toolUseResult` field, so the flag alone is not enough. One such block
     condemns the whole line.
  5. Flatten `content`: a bare string as-is; an array as its `type: "text"`
     blocks joined in order with a single space, **skipping** any block opening
     with `<system-reminder>` (context injected beside what the human wrote —
     dropping the block keeps the human's own text rather than losing the line).
  6. **Slash commands count as human input.** Claude Code rewrites a typed
     `/execute-todo 774` into a `<command-name>`/`<command-args>` envelope; the
     envelope is reconstructed back to `name args` and accepted *regardless of
     `origin`*. This is load-bearing, not a nicety: in skill-driven use
     free-typed turns are ~1% of user lines and whole sessions have **zero**,
     so without it the feature would show almost nothing.
  7. Otherwise, if the line has an `origin` block (Claude Code ≥ v2.1.187) it
     is **authoritative**: accept iff it says `human`. Note it is `origin`,
     **not** `promptSource` — `claude-desktop` human turns carry
     `promptSource: "sdk"`, so keying off that would drop them.
     **Upstream has spelled the key both ways** and mesa reads both, as **two
     fields, not one field with `#[serde(alias)]`**: `type` when the block was
     introduced, `kind` on current releases (observed on v2.1.227, task 814).
     An alias maps both keys onto one field, so a line carrying *both* — the
     ordinary way to ship a rename — becomes a serde duplicate-field error,
     and every parse site skips an unparseable line, dropping it from the
     ingest entirely along with its usage, tool calls and session span. The
     fix must never fail worse than the bug. Reading only one spelling fails
     *closed and silently*
     — an `origin` object whose one key is unknown parses as "origin present,
     not human", which is the accept-nothing branch rather than the prefix
     fallback, so every human turn of every session written by that release is
     dropped and `cc_prompts` quietly stops growing. It went unnoticed until
     the chat view (`docs/agents.md`) rendered a conversation with no human
     side. If a future release renames it again, this is the failure shape to
     look for: prompts present in old sessions, absent in new ones.
  8. Otherwise — a legacy line with no `origin`, where the text is all there is
     to go on — reject anything opening with one of `cc::NON_HUMAN_PREFIXES`
     (`<command-message>`, `<local-command-stdout>`, `<local-command-caveat>`,
     `Caveat: The messages below were generated`, `<system-reminder>`,
     `[Request interrupted by user` — no closing bracket, so the
     `… for tool use]` variant matches too — `[Image:`,
     `[SYSTEM NOTIFICATION`, `Stop hook feedback:`,
     `Base directory for this skill:`, `<teammate-message`,
     `Another Claude session sent a message:`, `<bash-stdout>`,
     `<bash-stderr>`). The list is the pre-`origin` fallback and nothing else.
     Its two `bash-*` entries and the interrupt truncation came from ingesting
     the real 3,329-transcript corpus and reading what leaked: ctrl-B bash mode
     writes both the typed command and its captured output back as `user`
     lines, and only the output is machinery.
  9. Finally `sanitize_capped` — the same shared policy, not a second cap
     constant. Nothing left means no row.

  Ingest keys on the transcript line `uuid`, so re-ingesting is a no-op like
  every other row here; the line still passes through `fold_line`'s existing
  uuid/message guard first, so a `user` line with no `uuid` produces nothing
  (which is why `cc-check.sh`'s original `-demo` fixture is unaffected). As
  with every derived `cc_*` column, the extraction ships with its **own cursor
  clear** (`DELETE FROM cc_files;`, migration 32) in the same binary, so the
  next ordinary `cc sync` re-walks every transcript once and fills the table.
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
  and `GET /api/cc` — and before `cc text`, whose file read needs the
  `cc_node_files` pointer to exist for a session ingested moments ago — but
  deliberately NOT in `cc live` / `GET /api/cc/live` (hot
  3s poll; live keeps parsing recent files directly — they're by definition
  still present) nor `cc usage` (network path, no transcripts). Live and
  `cc text` are the **only** two reads that open a transcript at all: live
  because the data is younger than any ingest, node text because the body it
  returns was never stored. `mesa cc sync
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
  deleted by hand before a rebuild backfills it. `--rebuild` is exposed via
  the CLI only, not the API — an operator/one-off action, not something a
  dashboard read should ever trigger. `mesa cc sync` prints
  the `CcSyncReport` (`{files_scanned, files_ingested, sessions,
  messages_added, tool_calls_added}`; a no-change re-run adds zeros).
- **Reset is the corrective one** (mesa task 698): `cc::reset_and_sync` =
  `Store::cc_reset` (one transaction deleting `cc_messages`, `cc_prompts`,
  `cc_tool_calls`, `cc_agent_runs`, `cc_sessions`, `cc_node_files`,
  `cc_files`) followed by a plain sync. It is
  what fixes rows whose stored *values* are wrong — the inflated cost/tokens
  recorded before task 693's usage dedupe — which no rebuild can do. It is
  **destructive of history**: a session whose transcript file Claude Code has
  since deleted cannot be re-read and is gone permanently. So unlike
  `--rebuild` it *is* exposed to the UI, but only ever as a deliberate,
  confirmed **operator action** — `mesa cc reset` and `POST /api/cc/reset`
  (loopback-only in both serve modes, like the config writes), reached from a
  confirm button in Settings → Model pricing. No read path — `GET /api/cc`,
  `cc summary`, the auto-ingest — can trigger it. Both CC caches invalidate on
  their own, being keyed by `Store::cc_stamp`, which the purge moves (it is
  the one write that can move the stamp *down*).
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
  rows (ingest is always total). **`<n>d` means n calendar days ending today**:
  the cutoff is UTC midnight of `today - (n - 1)` (`cc::window_cutoff`, the one
  place it is computed — `empty_dashboard` and `collect_inner` share it), so
  `since` is the true inclusive first day and `active_days <= n`. It used to
  floor `now - n·86400`, i.e. `t-7 .. t` = **eight** dates for `7d`; on real
  data that extra day added 319.4m tokens and 16 sessions (task 693).
  Days are bucketed in **UTC** (`fmt_date`), deliberately not local time: the
  measured difference over a week is ~0.6% (585.0m local vs 588.4m UTC) and
  switching would churn every date across the API and TS surface.
- **Reconciliation with Claude Code's own stats screen** (recorded once so the
  next reader doesn't re-derive it): mesa rolls **subagent/sidechain** usage
  into the parent session; Claude's screen counts main-session transcripts
  only, and **double-counts per response exactly the way mesa used to**. Over
  the same 7 local days, main-transcripts-only with no dedupe = 41.4k in /
  2.73m out / 516.6m cache read / 19.2m cache write = 538.6m over 78 sessions,
  matching that screen's 540.5m / 78 to within the minutes between the two
  measurements. mesa's deduped 7-day figure is therefore *lower* than what
  Claude shows (~380m vs the 906.9m mesa reported before this fix) — and that
  is the correct outcome, not a shortfall. Subagent tokens are real billed
  tokens and mesa keeps counting them.
- Transcript location resolves from
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
  `response` node per `cc_messages` row whose `preview` is non-`NULL`, one
  `prompt` node per `cc_prompts` row, plus parent→child edges. **Guaranteed a tree** — every node but the root has exactly
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
    `target` is `None` on `session`, `agent` and `skill` nodes; `tool`,
    `response` and `prompt` are the three kinds that carry it.
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
      Prompt, tool and response nodes are built into one pending list and
      sorted by `(ts, kind_rank, id)` with `kind_rank` **prompt = 0,
      response = 1, tool = 2**, `id` the final tie-break, then pushed in that
      order. A prompt is the *cause* of what follows it, so it sorts ahead of
      both; response-before-tool is unchanged, just shifted up a rank.
      Deliberately **not** a
      responses-first pass: `nodes` is documented "root first, then the rest
      oldest first" and `mesa cc graph` is read as a time-ordered column, which
      a two-pass emission would silently break for every CLI reader. Since
      `cc_session_tool_calls` already returns `ORDER BY ts, tool_use_id`, the
      `id` tie-break reproduces the previous tool order byte-for-byte.
  - **A `prompt` node is what the *user* asked for.** One per `cc_prompts` row,
    id **`prompt:<line uuid>`** — a fifth id namespace, disjoint from the other
    four. Named the constant `"Prompt"`, and it reuses `target` for the preview
    exactly as `response` does. Always a **direct child of the root**: only
    main-thread turns are ingested, so no prompt ever hangs off an `agent:`
    node, and nothing is ever `from` a `prompt:` id.

    It carries **no model and no usage**: `model: None`, zero `tokens`,
    `total_tokens: 0`, `est_cost_usd: 0.0`. A user turn is billed as part of
    the reply it provokes, so any number here would be invented, and no
    aggregate anywhere moves. `tokens_are_rollup` is nonetheless `true` — the
    flag means "this is not one message's usage shared with siblings", which is
    what stops the UI prefixing a meaningless `≈` (the timeline suppresses the
    cell entirely; see the page section below).
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
    payload unbounded. Prompts are a **third** such population and take the
    **third independent budget** of the same `limit`, reported by its own
    `omitted_prompts`, for exactly the same reasons. Each counter therefore
    keeps its exact meaning and value, and `truncated` means "**any** of the
    three populations was cut".
  - CLI `mesa cc graph <SESSION_ID> [--limit N]`; API
    `GET /api/cc/sessions/{id}/graph?limit=`. A never-ingested session is
    `not_found` (CLI exit 1, HTTP 404) — distinct from an empty graph, which is
    the right answer for a session that made no calls. Unlike `GET /api/cc`
    this response is **not** cached: it is an on-demand drill-down, not a poll.
- **Node text** — `cc::node_text(store, session_id, node_id) -> CcNodeText`
  (task 803), the answer to "show me all of it" for a node the graph can only
  name. Everything stored is a bounded preview by design — 200 sanitized
  characters of a `target`, a `preview`, a prompt — so the whole `Bash` command,
  the whole `Write` content, the whole subagent spawn prompt are **not in the
  database and never were**. The only place they exist is the `.jsonl`, so this
  read reopens it: the second carve-out from "the dashboard reads only the db",
  and the reason the surface is a separate on-demand verb rather than a fatter
  graph payload (a graph that inlined bodies would carry megabytes to render a
  column of 40-char labels).
  - **`cc_node_files (session_id, agent_id, path)`, PK `(session_id, agent_id)`,
    migration 34** — the pointer from one *thread* back to the transcript file
    it was read from, `agent_id = ''` meaning the session's main thread. It is
    what makes the body a single file read instead of a scan of thousands of
    transcripts; the walker already holds the path at ingest, so writing it
    costs nothing (`CcFileBatch::node_files`, filled by `cc::fold_line` from
    each line's own `sessionId`/`agentId`, written by `Store::cc_ingest_file`).
    **Its own table, not a column on `cc_messages`/`cc_tool_calls`.** Those
    insert `ON CONFLICT DO NOTHING`, so an added column would stay `NULL` on
    every already-ingested row *even after* the cursor clear re-walked the file
    — the same trap `preview` and `message_id` each needed a guarded `UPDATE`
    to escape. A fresh table has no such rows to leave behind: the re-walk
    upserts it clean. It ships with its own **`DELETE FROM cc_files;` cursor
    clear as migration 35**, in the same binary as the write, per the
    add-a-derived-store rule above.
    The pair really is 1:1 with a file: measured over the real
    `~/.claude/projects` corpus, **3,445 `(session_id, agent_id)` pairs, none
    spanning two files**. So the upsert's last-writer-wins, and the fallback
    below, are belt-and-braces against a shape that does not occur — not a
    policy for one that does.
  - **Resolution is session-scoped and re-derived, never trusted from the
    caller.** The id is parsed for its prefix only; the `kind`, `name`, `model`
    and `ts` on the answer come from the backing row, and every lookup filters
    on `session_id`, so a node id from another session is `not_found` rather
    than a way to read across sessions. `msg:` and `prompt:` return the uncapped
    prose (`format: "text"`); `tool:` and a promoted `skill` return the **whole
    `tool_use.input`** pretty-printed (`format: "json"`), which is the payoff —
    the bulk keys ingest deliberately never lifts (`content`, `new_string`,
    `prompt`, `script`) are exactly what a reader came for. An `agent:` node
    borrows the **`Task` call that spawned it** (a row in the *parent* thread,
    found through the sidecar's `tool_use_id`), so its body is the full prompt
    the subagent was given, while `kind`/`name` stay the run's own.
  - **Reading the file.** `read_node_body` tries the thread's own pointer, then
    the session's `agent_id = ''` row — bounded at two reads, and it can only
    widen what resolves (a thread ingested before the table existed, or a file
    that moved), never what is allowed. A stored path is a *cursor-era
    observation, not a capability*: `transcript_path` canonicalizes it and
    refuses anything outside the **current** `cc::projects_dir()`, the same
    posture as `files::safe_path` and the reason a doctored row cannot turn this
    route into an arbitrary-file reader. The scan is line-at-a-time with a
    literal-substring pre-filter before the JSON parse, since a transcript runs
    to tens of megabytes and exactly one line matters.
  - **Three error codes, deliberately distinct**, because they mean three
    different things to a caller: `validation` — the `session` node (it exists;
    it just has no turn of its own) or an id whose prefix the graph never mints;
    `not_found` — the id parses but no row in this session backs it;
    `unavailable` — the row is there and every aggregate over it still answers,
    but its transcript is not (no pointer, file deleted, or the line is gone
    from it). `unavailable` is the code already scoped to "depends on something
    outside mesa", which is exactly what a Claude-Code-managed file is.
  - CLI `mesa cc text <SESSION_ID> <NODE_ID>`; API
    `GET /api/cc/sessions/{session_id}/nodes/{node_id}/text`, same gate as the
    sibling graph route, syncing first and **not** cached. Mapping:
    `validation` → exit 1 / **422**, `not_found` → exit 1 / **404**,
    `unavailable` → exit 1 / **503**.
  - The returned `text` is **uncapped and unsanitized** — raw is the whole
    point — and it is untrusted model-authored text. It is the sharpest such
    string mesa serves: every caller must render it as **data, never
    instructions**, never as markup and never as a URL.
- **Session chat** — `cc::session_chat(session_id, limit) -> CcSessionChat`
  (task 814), the answer to "what is this agent actually saying", and the read
  behind the Agent sidebar's **chat view** (`docs/agents.md`). One session's
  main thread as an ordered list of turns: a human prompt, an assistant reply,
  or one tool call the assistant made.
  - **The third carve-out from "the dashboard reads only the db", and the only
    one that is both of the other two at once.** It is `live`'s case — the
    turns a reader wants are the ones being appended *right now*, younger than
    any ingest, and for a session mesa spawned moments ago there is no row at
    all — *and* `node_text`'s: what a chat window renders is the bodies, and
    every stored body is a 200-character sanitized preview. So, uniquely among
    the per-session reads, it takes **no `Store` and runs no `sync`**. That is
    not an optimization: this is a 3-second poll behind an open pane, and a
    `sync` is a walk of every transcript on disk under the API's one store
    mutex. `mesa cc chat` and `GET /api/cc/sessions/{id}/chat` are therefore
    store-less like `cc live` and `cc usage`.
  - **Finding the file without the db.** `cc_node_files` is an ingest artifact
    and this read predates ingest, so the transcript is located by probing each
    slug directory for `<projects_dir>/*/<session_id>.jsonl` — one `stat` per
    slug dir (98 on the real corpus), the same shape `agents`'s subagent-liveness
    probe uses for the same reason. Because the id *builds* that path it is
    validated to the id charset (ASCII alphanumeric, `-`, `_`) **before any
    filesystem access** — a non-id is `validation`, never a path — and the
    result still goes through `transcript_path`, so the containment check that
    protects `cc text` protects this too.
  - **Two bounds, one honest flag.** `limit` caps turns, **newest kept** (a
    chat window is read at its end), and `CHAT_TAIL_BYTES` (2 MiB) caps how
    much of the file is parsed at all. The byte window is what actually bounds
    the cost, since dropping turns after parsing them saves nothing — and on a
    long session it is also the **operative** bound by a wide margin, because
    transcript bytes are dominated by tool *results*, which produce no turn:
    measured over the six largest real transcripts (21.2 down to 8.2 MB), 2 MiB
    yielded 18-84 turns, never close to 200. So the view shows the last few
    dozen exchanges of a long session whatever `limit` says. Reading back by
    turn count instead would mean re-reading most of a 21 MB file every 3
    seconds, which is the cost the window exists to avoid.
    `truncated` is a single boolean covering both bounds: the byte window drops
    an *unknown* number of turns, so a count would be invented.
    Two properties the window has to have, both regression-tested:
    **it never lands inside a single line and answers nothing** — a transcript
    line can itself be megabytes (the real corpus holds a 2.59 MB tool result),
    and a window holding no complete line would blank the pane for a session
    that is talking fine, so it widens (to `CHAT_TAIL_MAX_BYTES`, 32 MiB —
    above every transcript observed, i.e. "read it all rather than say
    nothing") until it captures one; and **a boundary that lands exactly on a
    line start keeps that line**, which is why the read seeks one byte *early*
    — that byte is the whole difference between a cut that was mid-line and one
    that was not.
  - **What a line becomes.** A human turn is `human_prompt_raw` — the same
    predicate `cc_prompts` ingests on, uncapped — so main-thread only, no
    injections, no tool-result carriers. An assistant turn is
    `assistant_text_raw`, uncapped, `thinking` excluded exactly as it is from a
    stored preview. **An assistant turn is recognized by `type == "assistant"`,
    never by the shape of `message`**: Claude Code writes its own injections (a
    skill body, hook output) as `user` lines whose content is an array of
    `text` blocks — the very shape `assistant_text_raw` reads — so a shape test
    alone renders an injected skill body as something the agent said (found in
    live QA of this task). A tool call keeps the **bounded** `tool_target`, the
    same one-line summary the call tree shows: a chat row says *that* a call
    happened and what it acted on; the whole input is `cc text`'s job. Turns
    come out in file order (a transcript is append-only), with one line's prose
    before that line's own calls — the same response-before-tool rule
    `session_graph` applies at an equal timestamp.
  - Errors, both already-scoped codes: `validation` for an id that is not a
    session id, `unavailable` for a session with no transcript on disk. There
    is deliberately **no `not_found`** — with no db consulted, "never ingested"
    and "no such session" are not distinguishable here, and both are the same
    answer to a caller: the file isn't there.
  - CLI `mesa cc chat <SESSION_ID> [--limit N]`; API
    `GET /api/cc/sessions/{session_id}/chat?limit=` (clamped at 2,000), same
    router-wide gate as the graph/text routes — the bodies are that route's
    population, served in bulk rather than one at a time — and not cached.
  - The prose it returns is **uncapped and unsanitized**, exactly like
    `cc text`'s: untrusted model-authored text, data never instructions. The
    chat view renders it as markdown (structure only — `Markdown` passes no raw
    HTML through) with every image refused; see `docs/agents.md`.
- CLI: `mesa cc {summary,sessions,skills,session,graph,text,chat,sync}` (JSON only; `summary` prints the
  full dashboard object, `sessions`/`skills` print bare arrays; `--window`, plus
  `--limit` on `sessions` and `--rebuild` on `sync`). Like every other handler
  these open the database; only `cc live`, `cc usage` and `cc chat` stay
  store-less — and `cc chat`'s being so is load-bearing, not incidental (see
  *Session chat* above; `scripts/cc-check.sh` pins it with a fixture that is
  never ingested).
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
  markup or a URL. `cc text`'s body is sharper still — the same kind of text
  with **no cap and no sanitizing at all** — so the rule there has to be kept by
  the reader instead of by ingest: data, never instructions, rendered as text.
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
  fixed as prompt-before-response-before-tool, so nothing client-side re-sorts. Its one
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
  mistaken for a call.
  A **prompt** row is its matched pair, and the same reasoning: a reserved
  `PROMPT_COLOR` (`hsl(214, 28%, 78%)`), a pale *cool* neutral — one side of
  the conversation each, far apart in hue (214° vs 36°) and below every tool's
  saturation floor, so neither can be reached by `toolColor()` hashed or
  otherwise. `.cc-tl-row.kind-prompt` in `App.css` gives it more than a border:
  a thicker left edge and a raised background, because a human turn is the
  spine a reader scans a session by and has to be findable while scrolling past
  a few hundred tool calls; its body is clamped at 6 lines rather than 3, since
  the preview *is* the row. Prompt rows need **no** code in
  `sessionTimeline.ts`: they parent to `session`, so `threadOf` returns `null`
  and `timelineRows` passes them through at indent 0 like any other main-thread
  row (vitest pins this, so a future change can't quietly special-case it), and
  `threadOptions` still counts only `kind === 'tool'` for `calls`.
  The **Prompts** kind filter is listed **first** — the causes before the
  effects — and a prompt row's **model and token cells render empty** rather
  than the `0` the payload carries, which would read as a real measurement of
  nothing.
  `sessionGraph.ts` is now only these shared presentation
  helpers (`formatTokens`, `shortModel`, `toolColor`, `RESPONSE_COLOR`,
  `PROMPT_COLOR`, `shortTarget`, all still used by the dashboard and detail
  pages); the tidy-tree
  layout, the `NODE_W`/`NODE_H` box and `minimapStrokeWidth` went with the
  canvas. `@xyflow/react` stays a dependency — the storyboard canvas uses it.
  The truncation banner gates each of its three sentences on its own counter
  (`omitted_prompts` / `omitted_tool_calls` / `omitted_responses`), since
  `truncated` means any population was cut and a response-only truncation would
  otherwise read "0 omitted" tool calls. Zero states are quiet muted lines —
  "This session recorded no prompts, tool calls or subagent runs." and, when a filter excludes
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
  `cc text` gets a **fourth appended fixture project** whose every body — human
  turn, assistant prose, `Bash` command, `Write` content, `Task` prompt — runs
  well past `TARGET_MAX_CHARS` and ends in a sentinel the 200-char column can
  never reach. That is the assertion: each happy case is compared against *the
  graph's own preview of the same node*, so the check is "these two differ in
  the one way that matters", not a literal transcribed twice. Also asserted:
  the whole `input` comes back as JSON (including the `content` key ingest
  never lifts, whose graph node carries only the file path), the `agent:` node
  returns its spawning `Task` input, and all three error codes — `session` and
  a bogus prefix → `validation`, an unknown id → `not_found`, and a node of the
  deleted `-demo` transcript (whose rows are still queryable) → `unavailable`.
  The HTTP half asserts a payload equal to the CLI's plus the 404/422/503
  split, since the status mapping is the only thing that surface adds.
  `cc chat` gets a **fifth appended fixture project**, and the thing that makes
  it a fixture rather than a copy of `-text-project` is *when* it is written:
  after the last `cc sync`, and never ingested. The check asserts `cc sessions`
  does not list it and that `cc chat` answers completely anyway — the only
  assertion in the suite that would fail if this read ever grew a sync. Also
  asserted: the turn classification (an `isMeta` injection whose content is an
  array of `text` blocks produces nothing, as do a tool-result carrier and a
  subagent transcript; one assistant line emits prose before its own calls),
  full prose against a `thinking` block that must not appear, a tool turn
  bounded to its target, `--limit` keeping the *newest* turns and setting
  `truncated`, and both error codes. The HTTP half adds `?limit=` and the
  422/503 split.

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
