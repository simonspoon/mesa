//! CC Dashboard: Claude Code telemetry.
//!
//! Parses Claude Code's own session transcripts — newline-delimited JSON under
//! `~/.claude/projects/**/*.jsonl` (including subagent transcripts in
//! `<session>/subagents/*.jsonl`) — and **ingests** them into the mesa store's
//! `cc_*` tables via [`sync`] (incremental, per-file cursor, idempotent
//! upserts; all SQL lives in `Store`, preserving the single-write-path
//! invariant). The dashboard ([`collect`]) reads **only the db**, never the
//! files, so history survives Claude Code deleting its transcripts. Only
//! [`live`] still parses recent files directly (it reports the last minutes,
//! for which the files are by definition present). Shared by the CLI
//! (`mesa cc`) and the API (`GET /api/cc`) so the two surfaces never diverge.
//!
//! Each transcript line is one event. Only `assistant` events carry a `model`
//! and a `usage` block, so those drive token/cost/model/skill/agent rollups;
//! every line with a timestamp contributes to a session's start/end span. Lines
//! that don't parse, or aren't telemetry, are skipped.
//!
//! A call to the built-in `advisor` tool doesn't get its own transcript line
//! or file the way a Task-tool subagent does — it's a `server_tool_use` block
//! on an ordinary event, and the advisor model's own (often large) usage is
//! nested inside that event's `usage.iterations[]` rather than the event's
//! own top-level `usage` (which stays small — wrapper overhead only). Both
//! are unfolded in [`fold_line`]/[`RawMessage::tool_uses`] so advisor calls
//! and their real token/cost show up under their own model, tagged agent
//! `"advisor"`.
//!
//! Cost is **estimated** from a static per-model price table (USD per million
//! tokens). It is labelled as an estimate in the UI and will drift as pricing
//! changes — update [`prices`] when it does.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::store::{
    CcAgentRunUpsert, CcFileBatch, CcFileCursor, CcMessageRow, CcSessionUpsert, CcToolCallRow,
    Result, Store,
};
use super::types::{
    CcAgentStat, CcDashboard, CcDayPoint, CcLive, CcLiveSession, CcLiveSubagent, CcModelStat,
    CcOverview, CcProjectStat, CcSessionRow, CcSkillStat, CcTokens, CcToolStat,
};

// ---- transcript line shape (only the fields we read) ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLine {
    /// Stable per-event id — the idempotency key for persisted message rows.
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    entrypoint: Option<String>,
    #[serde(default)]
    is_sidechain: Option<bool>,
    /// Stable id of a subagent run; present only on subagent (sidechain) lines.
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    attribution_skill: Option<String>,
    #[serde(default)]
    attribution_agent: Option<String>,
    #[serde(default)]
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<RawUsage>,
    /// Content blocks, parsed leniently: any JSON shape is accepted (user
    /// messages carry a plain string here); only `tool_use` blocks in an array
    /// are read, via [`RawMessage::tool_uses`]. Unused by `collect`/`live`.
    #[serde(default)]
    content: Option<serde_json::Value>,
}

impl RawMessage {
    /// The `tool_use` blocks of this message as `(id, name, caller)`. Blocks
    /// missing a string `id`/`name`, and unknown block shapes, are skipped —
    /// the same leniency as malformed lines. `caller` is kept verbatim: a JSON
    /// string as-is, any other non-null value as its compact JSON text. Tool
    /// `input` payloads are deliberately never read (untrusted + large).
    /// `server_tool_use` blocks (e.g. the built-in `advisor` tool) carry the
    /// same `id`/`name`/`caller` shape as `tool_use` under a distinct `type`
    /// tag, so they're read the same way.
    fn tool_uses(&self) -> Vec<(String, String, Option<String>)> {
        let Some(blocks) = self.content.as_ref().and_then(|c| c.as_array()) else {
            return Vec::new();
        };
        blocks
            .iter()
            .filter(|b| {
                matches!(
                    b.get("type").and_then(|t| t.as_str()),
                    Some("tool_use") | Some("server_tool_use")
                )
            })
            .filter_map(|b| {
                let id = b.get("id")?.as_str()?;
                let name = b.get("name")?.as_str()?;
                let caller = b.get("caller").and_then(|c| match c {
                    serde_json::Value::Null => None,
                    serde_json::Value::String(s) => Some(s.clone()),
                    other => Some(other.to_string()),
                });
                Some((id.to_string(), name.to_string(), caller))
            })
            .collect()
    }
}

#[derive(Deserialize, Default)]
struct RawUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
    /// A `server_tool_use` call to a tool that itself runs its own model turn
    /// (currently only `advisor`) records that turn's real usage here rather
    /// than in the top-level fields above, which stay small (wrapper
    /// overhead only). Each entry's own `type` tags what kind of turn it was
    /// (`"advisor_message"` for advisor); only those are read.
    #[serde(default)]
    iterations: Vec<RawIteration>,
}

#[derive(Deserialize, Default)]
struct RawIteration {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

// ---- pricing (USD per 1M tokens): (input, output, cache_read, cache_write) ----
//
// cache_read ≈ 0.1× input, cache_write (5-minute TTL) ≈ 1.25× input. Matched on
// a model-family prefix so new point releases price correctly without an edit.
fn prices(model: &str) -> (f64, f64, f64, f64) {
    if model.starts_with("claude-fable") || model.starts_with("claude-mythos") {
        (10.0, 50.0, 1.0, 12.5)
    } else if model.starts_with("claude-opus") {
        (5.0, 25.0, 0.5, 6.25)
    } else if model.starts_with("claude-sonnet") {
        (3.0, 15.0, 0.3, 3.75)
    } else if model.starts_with("claude-haiku") {
        (1.0, 5.0, 0.1, 1.25)
    } else {
        // Synthetic/unknown models (e.g. "<synthetic>"): no cost estimate.
        (0.0, 0.0, 0.0, 0.0)
    }
}

fn estimate_cost(model: &str, u: &RawUsage) -> f64 {
    let (i, o, cr, cw) = prices(model);
    (u.input_tokens as f64 * i
        + u.output_tokens as f64 * o
        + u.cache_read_input_tokens as f64 * cr
        + u.cache_creation_input_tokens as f64 * cw)
        / 1_000_000.0
}

// ---- accumulators ----

#[derive(Default)]
struct Tok {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
}

impl Tok {
    fn add(&mut self, u: &RawUsage) {
        self.input += u.input_tokens;
        self.output += u.output_tokens;
        self.cache_read += u.cache_read_input_tokens;
        self.cache_creation += u.cache_creation_input_tokens;
    }
    fn total(&self) -> i64 {
        self.input + self.output + self.cache_read + self.cache_creation
    }
    fn to_cc(&self) -> CcTokens {
        CcTokens {
            input: self.input,
            output: self.output,
            cache_read: self.cache_read,
            cache_creation: self.cache_creation,
        }
    }
}

#[derive(Default)]
struct SessionAcc {
    has_ts: bool,
    start_ts: i64,
    end_ts: i64,
    start_str: String,
    end_str: String,
    models: BTreeSet<String>,
    messages: i64,
    tokens: Tok,
    cost: f64,
    cwd: Option<String>,
    git_branch: Option<String>,
    entrypoint: Option<String>,
    sidechain: bool,
}

#[derive(Default)]
struct DayAcc {
    sessions: HashSet<String>,
    messages: i64,
    tokens: Tok,
    cost: f64,
}

/// Generic "rolled up by some key" bucket (models, skills, agents).
#[derive(Default)]
struct GroupAcc {
    messages: i64,
    sessions: HashSet<String>,
    tokens: Tok,
    cost: f64,
}

#[derive(Default)]
struct ProjAcc {
    path: String,
    sessions: HashSet<String>,
    messages: i64,
    tokens: Tok,
    cost: f64,
}

/// Per-`(name, caller)` tool-call bucket.
#[derive(Default)]
struct ToolAcc {
    calls: i64,
    sessions: HashSet<String>,
}

#[derive(Default)]
struct Agg {
    sessions: HashMap<String, SessionAcc>,
    days: BTreeMap<String, DayAcc>,
    models: HashMap<String, GroupAcc>,
    skills: HashMap<String, GroupAcc>,
    agents: HashMap<String, GroupAcc>,
    projects: HashMap<String, ProjAcc>,
    tools: HashMap<(String, Option<String>), ToolAcc>,
    /// In-window tool calls per session (for the session rows).
    session_tool_calls: HashMap<String, i64>,
    /// Subagent runs per session (all-time — runs carry no timestamp).
    agent_runs: HashMap<String, i64>,
}

/// Cap the *web/API* dashboard applies to its session rows (newest first);
/// `overview.sessions` still reports the true total. The CLI `cc sessions`
/// command returns the full list (see `collect`), so this lives at the API
/// boundary, not in `collect`.
pub const MAX_SESSION_ROWS: usize = 250;

/// Default recency window (minutes) for [`live`] when a caller doesn't specify.
pub const DEFAULT_LIVE_MINUTES: i64 = 15;
/// Upper bound on the live window, so an over-large `minutes` can't blow up the
/// per-session spark vectors (one bucket per minute).
pub const MAX_LIVE_MINUTES: i64 = 1440;
/// Within this gap since its newest event, a live session is "active" (working);
/// beyond it the session is merely "idle" but still live.
const ACTIVE_SECS: i64 = 90;
/// Width of one `spark` bucket — one bar per minute.
const LIVE_BUCKET_SECS: i64 = 60;

/// Build the dashboard for `window` (`7d`/`30d`/`90d`/`all`/`<n>d`) from the
/// **persisted** `cc_*` rows — no transcript file is opened, so history
/// survives Claude Code deleting its transcripts, and nothing can be counted
/// twice against live files. Callers must run [`sync`] first to fold new
/// transcript lines in. Returns **all** session rows (newest first); callers
/// that need a bounded payload cap `sessions` themselves ([`MAX_SESSION_ROWS`]).
pub fn collect(store: &Store, window: &str) -> Result<CcDashboard> {
    collect_inner(store, window, None)
}

/// Project-scoped variant of [`collect`]: aggregation is restricted to
/// sessions whose `cc_sessions.cwd` exactly equals `local_path` (no
/// prefix/subdirectory matching — see `.scratch/arch.md`). `local_path: None`
/// (the project has no `local_path` recorded) returns a zero-valued dashboard
/// directly, without falling through to `collect_inner(store, window, None)`
/// — that `None` means "unfiltered" there and would silently return the
/// *global* dashboard instead.
pub fn collect_for_project(
    store: &Store,
    window: &str,
    local_path: Option<&str>,
) -> Result<CcDashboard> {
    let Some(local_path) = local_path else {
        return Ok(empty_dashboard(window));
    };
    collect_inner(store, window, Some(local_path))
}

/// Zero-valued dashboard for `window`, built by running the same cutoff/now
/// computation `collect` uses over an empty [`Agg`] — guarantees the
/// zero-state has exactly the same shape (overview zeros, empty vecs, correct
/// `window`/`since`/`generated_at_unix`) as a real dashboard that happens to
/// match nothing, with no hand-maintained "empty CcDashboard" literal to
/// drift out of sync.
fn empty_dashboard(window: &str) -> CcDashboard {
    let now = now_unix();
    let cutoff = window_days(window).map(|d| (now - d * 86_400).div_euclid(86_400) * 86_400);
    Agg::default().finish(window, cutoff, now)
}

/// Shared body of [`collect`] and [`collect_for_project`]. `cwd_filter: None`
/// is unfiltered (the global dashboard); `Some(path)` restricts every
/// aggregation loop to sessions whose `cwd` exactly equals `path`.
fn collect_inner(store: &Store, window: &str, cwd_filter: Option<&str>) -> Result<CcDashboard> {
    let now = now_unix();
    // Floor the cutoff to UTC midnight so `since` (a date) is genuinely the
    // inclusive first day of the window — otherwise the boundary day would be
    // partially excluded by now's time-of-day.
    let cutoff = window_days(window).map(|d| {
        let raw = now - d * 86_400;
        raw.div_euclid(86_400) * 86_400
    });

    let mut agg = Agg::default();

    // Sessions first: they carry the span and the metadata (cwd/branch/…)
    // every other rollup keys off. A session is in-window iff its span reaches
    // the cutoff (`end_ts >= cutoff` — an in-window message implies this).
    // The filter guard here is also how the allow-list forms for the loops
    // below: a filtered-out session's id is simply never inserted into
    // `agg.sessions`, so the messages/tool_calls loops can key off its
    // presence there instead of maintaining a separate set.
    for rec in store.cc_read_sessions(cutoff)? {
        if cwd_filter.is_some_and(|f| rec.cwd.as_deref() != Some(f)) {
            continue;
        }
        let s = agg.sessions.entry(rec.session_id).or_default();
        s.cwd = rec.cwd;
        s.git_branch = rec.git_branch;
        s.entrypoint = rec.entrypoint;
        s.sidechain = rec.used_subagent;
        if let (Some(start), Some(end)) = (rec.start_ts, rec.end_ts) {
            // Windowed duration = the stored span clamped to the window
            // (`max(start, cutoff) .. end`); `all` = the full span.
            let start = cutoff.map_or(start, |c| start.max(c));
            let end = end.max(start);
            s.has_ts = true;
            s.start_ts = start;
            s.end_ts = end;
            s.start_str = fmt_ts(start);
            s.end_str = fmt_ts(end);
        }
    }

    for m in store.cc_read_messages(cutoff)? {
        let usage = RawUsage {
            input_tokens: m.input_tokens,
            output_tokens: m.output_tokens,
            cache_read_input_tokens: m.cache_read_tokens,
            cache_creation_input_tokens: m.cache_creation_tokens,
            ..Default::default()
        };
        let cost = estimate_cost(&m.model, &usage);
        // The message's session is always present above (its ts bounds the
        // session span) unless the sessions loop filtered it out for cwd —
        // so a missing session here means either a corrupt db (unfiltered
        // path, not a real path today) or a filtered-out session
        // (project-scoped path). Either way, drop the whole message rather
        // than defaulting a blank session in, so a filtered-out session
        // never re-enters aggregation via the messages loop. Projects group
        // by the *session's* keep-first cwd.
        let Some(s) = agg.sessions.get_mut(&m.session_id) else {
            continue;
        };
        s.models.insert(m.model.clone());
        s.messages += 1;
        s.tokens.add(&usage);
        s.cost += cost;
        let cwd = s.cwd.clone();

        let d = agg.days.entry(fmt_date(m.ts)).or_default();
        d.sessions.insert(m.session_id.clone());
        d.messages += 1;
        d.tokens.add(&usage);
        d.cost += cost;

        let g = agg.models.entry(m.model).or_default();
        g.messages += 1;
        g.sessions.insert(m.session_id.clone());
        g.tokens.add(&usage);
        g.cost += cost;

        if let Some(skill) = m.skill {
            let g = agg.skills.entry(skill).or_default();
            g.messages += 1;
            g.sessions.insert(m.session_id.clone());
            g.tokens.add(&usage);
            g.cost += cost;
        }
        if let Some(agent) = m.agent {
            let g = agg.agents.entry(agent).or_default();
            g.messages += 1;
            g.sessions.insert(m.session_id.clone());
            g.tokens.add(&usage);
            g.cost += cost;
        }
        if let Some(cwd) = cwd {
            let p = agg.projects.entry(cwd.clone()).or_default();
            p.path = cwd;
            p.sessions.insert(m.session_id.clone());
            p.messages += 1;
            p.tokens.add(&usage);
            p.cost += cost;
        }
    }

    for t in store.cc_read_tool_calls(cutoff)? {
        if cwd_filter.is_some() && !agg.sessions.contains_key(&t.session_id) {
            continue;
        }
        let g = agg.tools.entry((t.name, t.caller)).or_default();
        g.calls += 1;
        g.sessions.insert(t.session_id.clone());
        *agg.session_tool_calls.entry(t.session_id).or_default() += 1;
    }
    agg.agent_runs = store.cc_agent_run_counts()?;

    Ok(agg.finish(window, cutoff, now))
}

// ---- incremental ingest (transcripts → cc_* tables via Store) ----

/// What one [`sync`] run did. Serialized for the CLI (`mesa cc sync`, story
/// 250); never sent to the web UI, so deliberately not a ts-rs export.
#[derive(Debug, Default, Serialize)]
pub struct CcSyncReport {
    /// `.jsonl` files seen under the transcript root.
    pub files_scanned: i64,
    /// Files actually parsed (cursor miss, growth, or rewrite).
    pub files_ingested: i64,
    /// Distinct sessions touched by the ingested files.
    pub sessions: i64,
    /// Message rows actually inserted (conflict no-ops excluded).
    pub messages_added: i64,
    /// Tool-call rows actually inserted (conflict no-ops excluded).
    pub tool_calls_added: i64,
}

/// Incrementally ingest every transcript under [`projects_dir`] into the
/// `cc_*` tables. Never window-limited — windowing is read-time only.
///
/// Per file, against its `cc_files` cursor: no cursor → parse from byte 0;
/// mtime AND size both unchanged → skip without reading; size grew → resume
/// from `byte_offset` (transcripts are append-only); size shrank (rewrite /
/// rotation — abnormal) → re-parse from 0, safe because every row upserts on
/// a stable key. The cursor is purely an optimization: correctness comes from
/// the upsert keys, so a lost or stale cursor can only cost re-parsing, never
/// duplicates. Each file commits in its own transaction (batch + cursor
/// together), so a crash mid-sync loses at most "this file not yet ingested".
///
/// `rebuild` clears every `cc_files` cursor first (`Store::cc_clear_cursors`),
/// so this walk re-parses every transcript from byte 0 regardless of its
/// mtime/size. Safe to call any time — never truncates `cc_*` data — but it
/// is additive, not corrective: `cc_messages`/`cc_tool_calls` rows insert on
/// `DO NOTHING`, so a row that already exists keeps its stored values. A
/// `cc.rs` fix retroactively applies via rebuild only when it makes the
/// parser emit a row (a new stable key) it previously missed entirely — the
/// motivating case, mesa task 340's advisor-accounting fix. A fix that needs
/// to *change* an already-ingested row's values still needs that row deleted
/// by hand first.
pub fn sync(store: &mut Store, rebuild: bool) -> Result<CcSyncReport> {
    let mut report = CcSyncReport::default();
    let Some(root) = projects_dir() else {
        return Ok(report);
    };
    if rebuild {
        store.cc_clear_cursors()?;
    }
    let cursors = store.cc_cursors()?;
    let mut sessions_touched: HashSet<String> = HashSet::new();
    for f in collect_files(&root) {
        report.files_scanned += 1;
        let path = f.to_string_lossy().to_string();
        let start = match (cursors.get(&path), file_mtime(&f), file_size(&f)) {
            (_, None, _) | (_, _, None) => continue, // vanished mid-walk
            (Some(c), Some(m), Some(s)) if c.mtime == m && c.size == s => continue, // unchanged
            (Some(c), _, Some(s)) if s >= c.size => c.byte_offset.max(0) as usize, // grew: resume
            _ => 0, // no cursor, or shrank: (re-)parse from the top
        };
        let Ok(bytes) = fs::read(&f) else { continue };
        let start = start.min(bytes.len());
        let (batch, consumed) = parse_batch(&bytes[start..]);
        for s in &batch.sessions {
            sessions_touched.insert(s.session_id.clone());
        }
        // Cursor = the bytes we actually parsed (not a re-stat, which could
        // already include lines appended after our read).
        let cursor = CcFileCursor {
            mtime: file_mtime(&f).unwrap_or(0),
            size: bytes.len() as i64,
            byte_offset: (start + consumed) as i64,
        };
        let counts = store.cc_ingest_file(&path, &cursor, &batch)?;
        report.files_ingested += 1;
        report.messages_added += counts.messages_added;
        report.tool_calls_added += counts.tool_calls_added;
    }
    report.sessions = sessions_touched.len() as i64;
    Ok(report)
}

/// Fold the complete (`\n`-terminated) lines of `bytes` into a [`CcFileBatch`],
/// returning it with the count of bytes consumed — the offset just past the
/// last complete line. A trailing partial line (a writer mid-append) is left
/// for the next sync.
fn parse_batch(bytes: &[u8]) -> (CcFileBatch, usize) {
    // BTreeMaps so the batch order is deterministic for a given input.
    let mut sessions: BTreeMap<String, CcSessionUpsert> = BTreeMap::new();
    let mut agent_runs: BTreeMap<(String, String), CcAgentRunUpsert> = BTreeMap::new();
    let mut batch = CcFileBatch::default();
    let mut pos = 0usize;
    let mut consumed = 0usize;
    while let Some(nl) = bytes[pos..].iter().position(|&b| b == b'\n') {
        let line = &bytes[pos..pos + nl];
        pos += nl + 1;
        consumed = pos;
        if let Ok(line) = std::str::from_utf8(line) {
            fold_line(line, &mut sessions, &mut agent_runs, &mut batch);
        }
    }
    batch.sessions = sessions.into_values().collect();
    batch.agent_runs = agent_runs.into_values().collect();
    (batch, consumed)
}

/// Fold one transcript line into the per-file accumulators. Mirrors
/// `parse_file`'s rules: a line needs a session id + parseable timestamp to
/// count at all; every such line widens the session span and fills metadata
/// keep-first; only lines with an event `uuid` yield message/tool-call rows
/// (pinned in `.scratch/arch.md` — no synthetic keys for a *line* lacking its
/// own uuid). Parent-session linkage is the line's own `sessionId` (subagent
/// lines carry the parent's id), with `agentId` attributing the row to its
/// subagent run. One exception to "no synthetic keys": an advisor call's
/// nested `usage.iterations` turn has no uuid of its own (it isn't a
/// separate line), so its message row is keyed off the *real* parent uuid
/// plus a deterministic suffix — still idempotent, since re-ingesting the
/// same line always derives the same key.
fn fold_line(
    line: &str,
    sessions: &mut BTreeMap<String, CcSessionUpsert>,
    agent_runs: &mut BTreeMap<(String, String), CcAgentRunUpsert>,
    batch: &mut CcFileBatch,
) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let raw: RawLine = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(_) => return,
    };
    let (Some(sid), Some(ts_str)) = (raw.session_id.as_ref(), raw.timestamp.as_ref()) else {
        return;
    };
    let Some(ts) = parse_ts(ts_str) else {
        return;
    };

    let s = sessions
        .entry(sid.clone())
        .or_insert_with(|| CcSessionUpsert {
            session_id: sid.clone(),
            cwd: None,
            git_branch: None,
            entrypoint: None,
            used_subagent: false,
            start_ts: None,
            end_ts: None,
        });
    if s.cwd.is_none() {
        s.cwd = raw.cwd.clone();
    }
    if s.git_branch.is_none() {
        s.git_branch = raw.git_branch.clone().filter(|g| !g.is_empty());
    }
    if s.entrypoint.is_none() {
        s.entrypoint = raw.entrypoint.clone();
    }
    if raw.is_sidechain == Some(true) {
        s.used_subagent = true;
    }
    s.start_ts = Some(s.start_ts.map_or(ts, |t| t.min(ts)));
    s.end_ts = Some(s.end_ts.map_or(ts, |t| t.max(ts)));

    if let Some(aid) = raw.agent_id.as_ref() {
        let r = agent_runs
            .entry((sid.clone(), aid.clone()))
            .or_insert_with(|| CcAgentRunUpsert {
                session_id: sid.clone(),
                agent_id: aid.clone(),
                agent: None,
                skill: None,
            });
        if r.agent.is_none() {
            r.agent = raw.attribution_agent.clone();
        }
        if r.skill.is_none() {
            r.skill = raw.attribution_skill.clone();
        }
    }

    // Without an event uuid there is no stable row identity: the line stays
    // span-only (no message row, and no tool-call rows — `message_uuid` is
    // how a call links back to its event).
    let (Some(uuid), Some(msg)) = (raw.uuid.as_ref(), raw.message.as_ref()) else {
        return;
    };
    for (tool_use_id, name, caller) in msg.tool_uses() {
        batch.tool_calls.push(CcToolCallRow {
            tool_use_id,
            message_uuid: uuid.clone(),
            session_id: sid.clone(),
            agent_id: raw.agent_id.clone(),
            name,
            caller,
            ts,
        });
    }
    if let (Some(model), Some(usage)) = (msg.model.as_ref(), msg.usage.as_ref()) {
        batch.messages.push(CcMessageRow {
            uuid: uuid.clone(),
            session_id: sid.clone(),
            agent_id: raw.agent_id.clone(),
            ts,
            model: model.clone(),
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_input_tokens,
            cache_creation_tokens: usage.cache_creation_input_tokens,
            skill: raw.attribution_skill.clone(),
            agent: raw.attribution_agent.clone(),
        });
        // An advisor call's own model turn is nested inside this event's
        // usage.iterations rather than being its own transcript line (unlike
        // a Task-tool subagent, which gets a separate subagents/*.jsonl
        // file). Surface it as its own message row — keyed off this event's
        // uuid since it has none of its own — so its real tokens/cost land
        // under its own model and it shows up as agent "advisor", not folded
        // invisibly into the caller's tiny wrapper usage above.
        for (i, it) in usage
            .iterations
            .iter()
            .filter(|it| it.kind.as_deref() == Some("advisor_message"))
            .enumerate()
        {
            let Some(advisor_model) = it.model.as_ref() else {
                continue;
            };
            batch.messages.push(CcMessageRow {
                uuid: format!("{uuid}:advisor:{i}"),
                session_id: sid.clone(),
                agent_id: None,
                ts,
                model: advisor_model.clone(),
                input_tokens: it.input_tokens,
                output_tokens: it.output_tokens,
                cache_read_tokens: it.cache_read_input_tokens,
                cache_creation_tokens: it.cache_creation_input_tokens,
                skill: raw.attribution_skill.clone(),
                agent: Some("advisor".to_string()),
            });
        }
    }
}

// ---- live sessions ----

#[derive(Default)]
struct LiveAcc {
    has_ts: bool,
    start_ts: i64,
    end_ts: i64,
    start_str: String,
    end_str: String,
    models: BTreeSet<String>,
    messages: i64,
    tokens: Tok,
    cost: f64,
    cwd: Option<String>,
    git_branch: Option<String>,
    sidechain: bool,
    /// Subagents seen under this session, keyed by `agentId`.
    subagents: HashMap<String, SubAcc>,
    /// One total-token bucket per window minute (oldest→newest).
    spark: Vec<i64>,
}

/// Per-subagent accumulator within a live session (keyed by `agentId`).
#[derive(Default)]
struct SubAcc {
    agent: Option<String>,
    skill: Option<String>,
    models: BTreeSet<String>,
    last_ts: i64,
    last_str: String,
    messages: i64,
    tokens: Tok,
}

/// Build the live-sessions view over the last `window_minutes` (clamped to
/// `[1, MAX_LIVE_MINUTES]`). Like [`collect`] it skips whole files whose mtime
/// predates the window, so it stays cheap enough to poll on a short interval —
/// only sessions with a *recent* event are parsed at all.
pub fn live(window_minutes: i64) -> CcLive {
    let now = now_unix();
    let win = window_minutes.clamp(1, MAX_LIVE_MINUTES);
    let n_buckets = win as usize;
    // Bucket 0 covers the oldest in-window minute; the cutoff is its start.
    let first_min = now.div_euclid(60) - (win - 1);
    let cutoff = first_min * 60;

    let mut sessions: HashMap<String, LiveAcc> = HashMap::new();
    if let Some(root) = projects_dir() {
        for f in collect_files(&root) {
            if file_mtime(&f).is_some_and(|m| m < cutoff) {
                continue;
            }
            parse_live_file(&f, cutoff, first_min, n_buckets, &mut sessions);
        }
    }

    let mut total_tokens = 0i64;
    let mut total_cost = 0.0;
    let mut active_count = 0i64;
    let mut rows: Vec<CcLiveSession> = sessions
        .into_iter()
        .map(|(session_id, s)| {
            let idle = (now - s.end_ts).max(0);
            let active = idle <= ACTIVE_SECS;
            if active {
                active_count += 1;
            }
            let total = s.tokens.total();
            total_tokens += total;
            total_cost += s.cost;
            // Only subagents active within the live gap are "currently running".
            let mut subagents: Vec<CcLiveSubagent> = s
                .subagents
                .into_iter()
                .filter_map(|(agent_id, sub)| {
                    let idle = (now - sub.last_ts).max(0);
                    (idle <= ACTIVE_SECS).then(|| CcLiveSubagent {
                        agent_id,
                        agent: sub.agent,
                        skill: sub.skill,
                        models: sub.models.into_iter().collect(),
                        last_activity: sub.last_str,
                        idle_seconds: idle,
                        messages: sub.messages,
                        total_tokens: sub.tokens.total(),
                    })
                })
                .collect();
            // Tiebreak on agent_id so ties don't flicker between polls (HashMap
            // iteration order is otherwise non-deterministic).
            subagents.sort_by(|a, b| {
                a.idle_seconds
                    .cmp(&b.idle_seconds)
                    .then_with(|| a.agent_id.cmp(&b.agent_id))
            });
            CcLiveSession {
                session_id,
                project: s.cwd.as_deref().map(short_project),
                cwd: s.cwd,
                git_branch: s.git_branch,
                models: s.models.into_iter().collect(),
                started: s.start_str,
                last_activity: s.end_str,
                idle_seconds: idle,
                status: if active { "active" } else { "idle" }.to_string(),
                messages: s.messages,
                total_tokens: total,
                tokens: s.tokens.to_cc(),
                est_cost_usd: round4(s.cost),
                used_subagent: s.sidechain,
                subagents,
                spark: s.spark,
            }
        })
        .collect();
    // Active sessions first, then the most recently active (smallest idle gap).
    rows.sort_by(|a, b| {
        (a.status != "active", a.idle_seconds).cmp(&(b.status != "active", b.idle_seconds))
    });

    CcLive {
        generated_at_unix: now,
        window_minutes: win,
        bucket_seconds: LIVE_BUCKET_SECS,
        active_seconds: ACTIVE_SECS,
        active_count,
        live_count: rows.len() as i64,
        total_tokens,
        est_cost_usd: round4(total_cost),
        tokens_per_min: round2(total_tokens as f64 / win as f64),
        sessions: rows,
    }
}

fn parse_live_file(
    path: &Path,
    cutoff: i64,
    first_min: i64,
    n_buckets: usize,
    sessions: &mut HashMap<String, LiveAcc>,
) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let raw: RawLine = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let (Some(sid), Some(ts_str)) = (raw.session_id.as_ref(), raw.timestamp.as_ref()) else {
            continue;
        };
        let ts = match parse_ts(ts_str) {
            Some(t) => t,
            None => continue,
        };
        if ts < cutoff {
            continue;
        }

        let s = sessions.entry(sid.clone()).or_insert_with(|| LiveAcc {
            spark: vec![0; n_buckets],
            ..Default::default()
        });
        if !s.has_ts || ts < s.start_ts {
            s.start_ts = ts;
            s.start_str = ts_str.clone();
        }
        if !s.has_ts || ts > s.end_ts {
            s.end_ts = ts;
            s.end_str = ts_str.clone();
        }
        s.has_ts = true;
        if s.cwd.is_none() {
            s.cwd = raw.cwd.clone();
        }
        if s.git_branch.is_none() {
            s.git_branch = raw.git_branch.clone().filter(|g| !g.is_empty());
        }
        if raw.is_sidechain == Some(true) {
            s.sidechain = true;
        }
        // Subagent lines carry an `agentId`; track each subagent's recency and
        // attribution so the UI can list the ones currently running. Recency is
        // updated for every line (including the user/attachment lines that have
        // no usage), so a just-spawned subagent shows as running immediately.
        if let Some(aid) = raw.agent_id.as_ref() {
            let sub = s.subagents.entry(aid.clone()).or_default();
            if ts >= sub.last_ts {
                sub.last_ts = ts;
                sub.last_str = ts_str.clone();
            }
            if sub.agent.is_none() {
                sub.agent = raw.attribution_agent.clone();
            }
            if sub.skill.is_none() {
                sub.skill = raw.attribution_skill.clone();
            }
        }

        let Some(usage) = raw.message.as_ref().and_then(|m| m.usage.as_ref()) else {
            continue;
        };
        let Some(model) = raw.message.as_ref().and_then(|m| m.model.clone()) else {
            continue;
        };
        s.models.insert(model.clone());
        s.messages += 1;
        s.tokens.add(usage);
        s.cost += estimate_cost(&model, usage);
        // The entry was already created above for any line carrying an `agentId`,
        // so reuse it by mutable handle (no second insert, no clone).
        if let Some(aid) = raw.agent_id.as_ref()
            && let Some(sub) = s.subagents.get_mut(aid)
        {
            sub.models.insert(model);
            sub.messages += 1;
            sub.tokens.add(usage);
        }
        let idx = (ts.div_euclid(60) - first_min).clamp(0, n_buckets as i64 - 1) as usize;
        s.spark[idx] += usage.input_tokens
            + usage.output_tokens
            + usage.cache_read_input_tokens
            + usage.cache_creation_input_tokens;
    }
}

impl Agg {
    fn finish(self, window: &str, cutoff: Option<i64>, now: i64) -> CcDashboard {
        // ---- overview (over ALL sessions, before the row cap) ----
        let total_sessions = self.sessions.len() as i64;
        let mut tok = Tok::default();
        let mut total_cost = 0.0;
        let mut total_messages = 0i64;
        let mut durations: Vec<f64> = Vec::new();
        let mut first: Option<String> = None;
        let mut last: Option<String> = None;
        for s in self.sessions.values() {
            tok.input += s.tokens.input;
            tok.output += s.tokens.output;
            tok.cache_read += s.tokens.cache_read;
            tok.cache_creation += s.tokens.cache_creation;
            total_cost += s.cost;
            total_messages += s.messages;
            // Every session contributes a duration (0 for a single-event
            // session) so the average/median denominator equals the session
            // count reported in the overview.
            if s.has_ts {
                durations.push(((s.end_ts - s.start_ts).max(0)) as f64 / 60.0);
            }
            if s.has_ts {
                if first.as_ref().is_none_or(|f| &s.start_str < f) {
                    first = Some(s.start_str.clone());
                }
                if last.as_ref().is_none_or(|l| &s.end_str > l) {
                    last = Some(s.end_str.clone());
                }
            }
        }
        let total_tokens = tok.total();
        let avg_minutes = if durations.is_empty() {
            0.0
        } else {
            durations.iter().sum::<f64>() / durations.len() as f64
        };
        let overview = CcOverview {
            sessions: total_sessions,
            active_days: self.days.len() as i64,
            messages: total_messages,
            total_tokens,
            est_cost_usd: round4(total_cost),
            avg_session_minutes: round2(avg_minutes),
            median_session_minutes: round2(median(&mut durations)),
            avg_tokens_per_session: if total_sessions > 0 {
                round2(total_tokens as f64 / total_sessions as f64)
            } else {
                0.0
            },
            cache_hit_ratio: if tok.cache_read + tok.input > 0 {
                round4(tok.cache_read as f64 / (tok.cache_read + tok.input) as f64)
            } else {
                0.0
            },
            tokens: tok.to_cc(),
            first_activity: first,
            last_activity: last,
        };

        // ---- daily series (chronological) ----
        let daily = self
            .days
            .into_iter()
            .map(|(date, d)| CcDayPoint {
                date,
                sessions: d.sessions.len() as i64,
                messages: d.messages,
                total_tokens: d.tokens.total(),
                tokens: d.tokens.to_cc(),
                est_cost_usd: round4(d.cost),
            })
            .collect();

        // ---- breakdowns (by total tokens, descending) ----
        let mut models: Vec<CcModelStat> = self
            .models
            .into_iter()
            .map(|(model, g)| CcModelStat {
                model,
                messages: g.messages,
                sessions: g.sessions.len() as i64,
                total_tokens: g.tokens.total(),
                tokens: g.tokens.to_cc(),
                est_cost_usd: round4(g.cost),
            })
            .collect();
        models.sort_by_key(|b| std::cmp::Reverse(b.total_tokens));

        let mut skills: Vec<CcSkillStat> = self
            .skills
            .into_iter()
            .map(|(skill, g)| CcSkillStat {
                skill,
                messages: g.messages,
                sessions: g.sessions.len() as i64,
                total_tokens: g.tokens.total(),
                tokens: g.tokens.to_cc(),
                est_cost_usd: round4(g.cost),
            })
            .collect();
        skills.sort_by_key(|b| std::cmp::Reverse(b.total_tokens));

        let mut agents: Vec<CcAgentStat> = self
            .agents
            .into_iter()
            .map(|(agent, g)| CcAgentStat {
                agent,
                messages: g.messages,
                sessions: g.sessions.len() as i64,
                total_tokens: g.tokens.total(),
                tokens: g.tokens.to_cc(),
                est_cost_usd: round4(g.cost),
            })
            .collect();
        agents.sort_by_key(|b| std::cmp::Reverse(b.total_tokens));

        let mut projects: Vec<CcProjectStat> = self
            .projects
            .into_values()
            .map(|p| CcProjectStat {
                project: short_project(&p.path),
                path: p.path,
                sessions: p.sessions.len() as i64,
                messages: p.messages,
                total_tokens: p.tokens.total(),
                est_cost_usd: round4(p.cost),
            })
            .collect();
        projects.sort_by_key(|b| std::cmp::Reverse(b.total_tokens));

        // ---- tool calls (most calls first; name/caller tiebreak for stability) ----
        let mut tools: Vec<CcToolStat> = self
            .tools
            .into_iter()
            .map(|((name, caller), t)| CcToolStat {
                name,
                caller,
                calls: t.calls,
                sessions: t.sessions.len() as i64,
            })
            .collect();
        tools.sort_by(|a, b| {
            b.calls
                .cmp(&a.calls)
                .then_with(|| (&a.name, &a.caller).cmp(&(&b.name, &b.caller)))
        });

        // ---- session rows (newest first; ISO strings sort chronologically) ----
        let tool_counts = self.session_tool_calls;
        let run_counts = self.agent_runs;
        let mut sessions: Vec<CcSessionRow> = self
            .sessions
            .into_iter()
            .map(|(session_id, s)| {
                let dur = if s.end_ts > s.start_ts {
                    (s.end_ts - s.start_ts) as f64 / 60.0
                } else {
                    0.0
                };
                CcSessionRow {
                    duration_minutes: round2(dur),
                    models: s.models.into_iter().collect(),
                    messages: s.messages,
                    total_tokens: s.tokens.total(),
                    tokens: s.tokens.to_cc(),
                    est_cost_usd: round4(s.cost),
                    tool_calls: tool_counts.get(&session_id).copied().unwrap_or(0),
                    agent_runs: run_counts.get(&session_id).copied().unwrap_or(0),
                    project: s.cwd.as_deref().map(short_project),
                    cwd: s.cwd,
                    git_branch: s.git_branch,
                    entrypoint: s.entrypoint,
                    used_subagent: s.sidechain,
                    start: s.start_str,
                    end: s.end_str,
                    session_id,
                }
            })
            .collect();
        sessions.sort_by(|a, b| b.start.cmp(&a.start));

        CcDashboard {
            generated_at_unix: now,
            window: window.to_string(),
            since: cutoff.map(fmt_date),
            overview,
            daily,
            models,
            skills,
            agents,
            projects,
            tools,
            sessions,
        }
    }
}

// ---- small helpers ----

/// `all` => no cutoff; `<n>d` => n days; anything else falls back to 30 days.
fn window_days(window: &str) -> Option<i64> {
    if window.eq_ignore_ascii_case("all") {
        return None;
    }
    let digits = window.strip_suffix(['d', 'D']).unwrap_or(window);
    Some(digits.parse::<i64>().unwrap_or(30).max(1))
}

fn short_project(cwd: &str) -> String {
    cwd.rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn file_mtime(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn file_size(path: &Path) -> Option<i64> {
    fs::metadata(path).ok().map(|m| m.len() as i64)
}

/// Where Claude Code stores transcripts. `MESA_CC_PROJECTS_DIR` overrides it
/// (used by tests); otherwise `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`.
fn projects_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MESA_CC_PROJECTS_DIR") {
        return Some(PathBuf::from(p));
    }
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(d).join("projects"));
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                out.push(p);
            }
        }
    }
    out
}

/// Parse `2026-06-15T01:44:23.655Z` (and any RFC-3339-ish prefix) to Unix
/// seconds, UTC. Fractional seconds and the timezone suffix are ignored — every
/// transcript timestamp is `Z`.
fn parse_ts(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let y = num(0, 4)?;
    let mo = num(5, 7)?;
    let d = num(8, 10)?;
    let h = num(11, 13)?;
    let mi = num(14, 16)?;
    let se = num(17, 19)?;
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + se)
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Howard Hinnant's
/// algorithm). Avoids pulling in a date crate for one conversion.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`]: format Unix seconds as `YYYY-MM-DD` (UTC).
fn fmt_date(epoch: i64) -> String {
    let z = epoch.div_euclid(86_400) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Inverse of [`parse_ts`]: format Unix seconds as ISO-8601 UTC
/// (`YYYY-MM-DDTHH:MM:SSZ`). Fractional seconds are not reconstructed — the
/// stored integer is the truth, and the loss is cosmetic (see `.scratch/arch.md`).
fn fmt_ts(epoch: i64) -> String {
    let tod = epoch.rem_euclid(86_400);
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        fmt_date(epoch),
        tod / 3_600,
        (tod % 3_600) / 60,
        tod % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // `collect()` reads the global MESA_CC_PROJECTS_DIR env var, and cargo runs
    // tests in parallel — so every test that points it at a temp dir must hold
    // this lock for the set→collect→unset window, or one test's dir leaks into
    // another's `collect()`. Recover from poison so a panic in one test fails
    // only that test, not every other test queued on the lock.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn write_jsonl(dir: &Path, name: &str, lines: &[&str]) {
        let path = dir.join(name);
        let mut f = fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn date_round_trips() {
        // 2026-06-15 → days → back to the same date.
        let ts = parse_ts("2026-06-15T01:44:23.655Z").unwrap();
        assert_eq!(fmt_date(ts), "2026-06-15");
        // Epoch sanity: 1970-01-01T00:00:00Z is 0.
        assert_eq!(parse_ts("1970-01-01T00:00:00Z").unwrap(), 0);
    }

    #[test]
    fn cost_estimate_matches_price_table() {
        let u = RawUsage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            ..Default::default()
        };
        // Opus: $5 in + $25 out per Mtok = $30.
        assert!((estimate_cost("claude-opus-4-8", &u) - 30.0).abs() < 1e-9);
        // Unknown / synthetic: zero.
        assert_eq!(estimate_cost("<synthetic>", &u), 0.0);
    }

    #[test]
    fn folds_ingested_rows_into_dashboard() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-some-project");
        fs::create_dir_all(&proj).unwrap();
        // Two assistant turns in one session, plus a non-telemetry user line;
        // one turn carries a tool_use block.
        write_jsonl(
            &proj,
            "sess.jsonl",
            &[
                r#"{"type":"user","uuid":"u0","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/work/widget","gitBranch":"main","entrypoint":"cli","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:05:00.000Z","cwd":"/home/me/work/widget","attributionSkill":"build","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"},"caller":{"type":"direct"}}],"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}}"#,
                r#"{"type":"assistant","uuid":"u2","isSidechain":true,"sessionId":"s1","timestamp":"2026-06-15T01:10:00.000Z","attributionAgent":"Explore","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        // SAFETY: ENV_LOCK gives this test exclusive access to the env var.
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }
        let d = collect(&store, "all").unwrap();

        assert_eq!(d.overview.sessions, 1);
        assert_eq!(d.overview.messages, 2);
        assert_eq!(d.overview.tokens.input, 110);
        assert_eq!(d.overview.tokens.output, 220);
        assert_eq!(d.overview.total_tokens, 110 + 220 + 50);
        assert_eq!(d.overview.active_days, 1);
        // Span is 01:00 → 01:10 = 10 minutes.
        assert!((d.overview.avg_session_minutes - 10.0).abs() < 1e-6);
        assert_eq!(d.models.len(), 2);
        assert_eq!(
            d.skills
                .iter()
                .find(|s| s.skill == "build")
                .unwrap()
                .messages,
            1
        );
        assert_eq!(
            d.agents
                .iter()
                .find(|a| a.agent == "Explore")
                .unwrap()
                .messages,
            1
        );
        // Tool breakdown: one Bash call, caller verbatim.
        assert_eq!(d.tools.len(), 1);
        assert_eq!(d.tools[0].name, "Bash");
        assert_eq!(d.tools[0].caller.as_deref(), Some(r#"{"type":"direct"}"#));
        assert_eq!(d.tools[0].calls, 1);
        assert_eq!(d.tools[0].sessions, 1);
        let row = &d.sessions[0];
        assert_eq!(row.project.as_deref(), Some("widget"));
        assert!(row.used_subagent);
        assert_eq!(row.tool_calls, 1);
        assert_eq!(row.agent_runs, 0); // no agentId lines in this transcript
        assert_eq!(row.start, "2026-06-15T01:00:00Z");
        assert_eq!(row.end, "2026-06-15T01:10:00Z");
    }

    #[test]
    fn collect_for_project_filters_all_three_loops_by_cwd() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-some-project");
        fs::create_dir_all(&proj).unwrap();
        // Two sessions in one transcript file, distinguished only by cwd:
        // s1 (the project we'll scope to) has a skill-attributed message and
        // a Bash tool call; s2 (a different project's session) has an
        // agent-attributed message and a Read tool call. If the filter leaks
        // anywhere, s2's data will surface in the scoped dashboard.
        write_jsonl(
            &proj,
            "sess.jsonl",
            &[
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/work/widget","gitBranch":"main","attributionSkill":"build","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Bash","caller":{"type":"direct"}}],"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}}"#,
                r#"{"type":"assistant","uuid":"u2","sessionId":"s2","timestamp":"2026-06-15T02:00:00.000Z","cwd":"/home/me/work/other","attributionAgent":"Explore","message":{"model":"claude-haiku-4-5","content":[{"type":"tool_use","id":"tu2","name":"Read","caller":{"type":"direct"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        // SAFETY: ENV_LOCK gives this test exclusive access to the env var.
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        // Sanity: the unscoped dashboard sees both sessions.
        let global = collect(&store, "all").unwrap();
        assert_eq!(global.overview.sessions, 2);
        assert_eq!(global.overview.messages, 2);

        // Scoped to s1's cwd: only s1 contributes, across every rollup.
        let scoped = collect_for_project(&store, "all", Some("/home/me/work/widget")).unwrap();
        assert_eq!(scoped.overview.sessions, 1);
        assert_eq!(scoped.overview.messages, 1);
        assert_eq!(scoped.overview.tokens.input, 100);
        assert_eq!(scoped.overview.tokens.output, 200);
        assert_eq!(scoped.sessions.len(), 1);
        assert_eq!(scoped.sessions[0].session_id, "s1");
        // models/skills/agents/tools breakdowns: only s1's data is present.
        assert_eq!(scoped.models.len(), 1);
        assert_eq!(scoped.models[0].model, "claude-opus-4-8");
        assert_eq!(scoped.skills.len(), 1);
        assert_eq!(scoped.skills[0].skill, "build");
        assert!(scoped.agents.is_empty()); // s2's "Explore" must not leak in
        assert_eq!(scoped.tools.len(), 1);
        assert_eq!(scoped.tools[0].name, "Bash");
        assert_eq!(scoped.tools[0].calls, 1);
        // daily series: only s1's day/message counts into 2026-06-15.
        assert_eq!(scoped.daily.len(), 1);
        assert_eq!(scoped.daily[0].messages, 1);
        // project breakdown: only s1's cwd appears.
        assert_eq!(scoped.projects.len(), 1);
        assert_eq!(scoped.projects[0].path, "/home/me/work/widget");

        // Scoped to s2's cwd: symmetric check, only s2 contributes.
        let scoped2 = collect_for_project(&store, "all", Some("/home/me/work/other")).unwrap();
        assert_eq!(scoped2.overview.sessions, 1);
        assert_eq!(scoped2.sessions[0].session_id, "s2");
        assert_eq!(scoped2.tools.len(), 1);
        assert_eq!(scoped2.tools[0].name, "Read");
        assert!(scoped2.skills.is_empty());
        assert_eq!(scoped2.agents.len(), 1);
        assert_eq!(scoped2.agents[0].agent, "Explore");

        // A project with no local_path (None) short-circuits to a zero-valued
        // dashboard — not the global one — with the same shape a real
        // dashboard would have for this window.
        let unset = collect_for_project(&store, "all", None).unwrap();
        assert_eq!(unset.overview.sessions, 0);
        assert_eq!(unset.overview.messages, 0);
        assert!(unset.sessions.is_empty());
        assert!(unset.models.is_empty());
        assert!(unset.skills.is_empty());
        assert!(unset.agents.is_empty());
        assert!(unset.tools.is_empty());
        assert!(unset.daily.is_empty());
        assert_eq!(unset.window, "all");
        assert!(unset.since.is_none());

        // A local_path that matches no session's cwd is likewise a
        // zero-valued dashboard, not an error.
        let no_match = collect_for_project(&store, "all", Some("/nope")).unwrap();
        assert_eq!(no_match.overview.sessions, 0);
        assert!(no_match.sessions.is_empty());
    }

    #[test]
    fn dashboard_survives_transcript_deletion() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let proj = root.join("-proj");
        let subs = proj.join("s1").join("subagents");
        fs::create_dir_all(&subs).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/work/widget","attributionSkill":"build","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Bash","caller":{"type":"direct"}}],"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        // Subagent run under the same session: its usage and tool call must
        // stay attributed to the parent session after the files are gone.
        write_jsonl(
            &subs,
            "agent-aaa.jsonl",
            &[
                r#"{"type":"assistant","uuid":"u2","isSidechain":true,"sessionId":"s1","agentId":"agent-aaa","attributionAgent":"Explore","timestamp":"2026-06-15T01:10:00.000Z","message":{"model":"claude-haiku-4-5","content":[{"type":"tool_use","id":"tu2","name":"Read","caller":{"type":"direct"}}],"usage":{"input_tokens":10,"output_tokens":20}}}"#,
            ],
        );
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", &root);
        }
        sync(&mut store, false).unwrap();
        let before = collect(&store, "all").unwrap();

        // Claude Code cleans up its transcripts: every file disappears.
        fs::remove_dir_all(&root).unwrap();
        let after = collect(&store, "all").unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        // Totals are identical before and after the deletion (only the
        // generated-at stamp may differ).
        let norm = |d: &CcDashboard| {
            let mut v = serde_json::to_value(d).unwrap();
            v["generated_at_unix"] = 0.into();
            v
        };
        assert_eq!(norm(&before), norm(&after));

        // The deleted session is still fully reported.
        assert_eq!(after.overview.sessions, 1);
        assert_eq!(after.overview.messages, 2);
        let row = &after.sessions[0];
        assert_eq!(row.session_id, "s1");
        assert!(row.used_subagent);
        // Subagent usage is attributed to the parent session…
        assert_eq!(row.total_tokens, 100 + 200 + 50 + 10 + 20);
        assert_eq!(row.agent_runs, 1);
        // …tool-call data is present…
        assert_eq!(row.tool_calls, 2);
        assert_eq!(after.tools.iter().map(|t| t.calls).sum::<i64>(), 2);
        // …and the agent/skill breakdowns survive.
        assert_eq!(
            after
                .agents
                .iter()
                .find(|a| a.agent == "Explore")
                .unwrap()
                .messages,
            1
        );
        assert_eq!(
            after
                .skills
                .iter()
                .find(|s| s.skill == "build")
                .unwrap()
                .messages,
            1
        );
    }

    // Build an ISO-8601 UTC timestamp `secs_ago` seconds before now, so a test
    // transcript can land inside (or outside) the live window deterministically.
    fn iso_at(secs_ago: i64) -> String {
        let e = now_unix() - secs_ago;
        let tod = e.rem_euclid(86_400);
        format!(
            "{}T{:02}:{:02}:{:02}.000Z",
            fmt_date(e),
            tod / 3600,
            (tod % 3600) / 60,
            tod % 60
        )
    }

    #[test]
    fn live_picks_up_recent_sessions() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-live-project");
        fs::create_dir_all(&proj).unwrap();
        let recent = format!(
            r#"{{"type":"assistant","sessionId":"live1","timestamp":"{}","cwd":"/home/me/work/widget","gitBranch":"main","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
            iso_at(30)
        );
        let stale = format!(
            r#"{{"type":"assistant","sessionId":"old1","timestamp":"{}","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":1,"output_tokens":1}}}}}}"#,
            iso_at(20 * 60)
        );
        write_jsonl(&proj, "live.jsonl", &[recent.as_str()]);
        write_jsonl(&proj, "old.jsonl", &[stale.as_str()]);
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path());
        }
        let l = live(15);
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }
        // Only the 30-s-old session is inside the 15-minute window.
        assert_eq!(l.live_count, 1);
        assert_eq!(l.active_count, 1);
        assert_eq!(l.window_minutes, 15);
        let s = &l.sessions[0];
        assert_eq!(s.session_id, "live1");
        assert_eq!(s.status, "active");
        assert_eq!(s.total_tokens, 150);
        assert!(s.idle_seconds <= ACTIVE_SECS);
        assert_eq!(s.project.as_deref(), Some("widget"));
        // One bucket per window minute; the 30-s-old event lands in one of the
        // last two minute buckets (depending on where "now" sits in its minute).
        assert_eq!(s.spark.len(), 15);
        assert_eq!(s.spark.iter().sum::<i64>(), 150);
        assert_eq!(s.spark[13] + s.spark[14], 150);
    }

    #[test]
    fn live_lists_running_subagents() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-live-project");
        let subs = proj.join("sess").join("subagents");
        fs::create_dir_all(&subs).unwrap();
        // Parent session: one recent assistant turn.
        let parent = format!(
            r#"{{"type":"assistant","sessionId":"sess","timestamp":"{}","cwd":"/home/me/work/widget","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":100,"output_tokens":50}}}}}}"#,
            iso_at(20)
        );
        write_jsonl(&proj, "sess.jsonl", &[parent.as_str()]);
        // A subagent under the same session: recent (running) + attributed.
        let running = format!(
            r#"{{"type":"assistant","isSidechain":true,"sessionId":"sess","agentId":"agent-aaa","attributionAgent":"Explore","attributionSkill":"code-review","timestamp":"{}","message":{{"model":"claude-haiku-4-5","usage":{{"input_tokens":10,"output_tokens":20}}}}}}"#,
            iso_at(15)
        );
        // A second subagent that finished long ago — must NOT be listed.
        let stale = format!(
            r#"{{"type":"assistant","isSidechain":true,"sessionId":"sess","agentId":"agent-bbb","attributionAgent":"Plan","timestamp":"{}","message":{{"model":"claude-haiku-4-5","usage":{{"input_tokens":5,"output_tokens":5}}}}}}"#,
            iso_at(10 * 60)
        );
        write_jsonl(&subs, "agent-aaa.jsonl", &[running.as_str()]);
        write_jsonl(&subs, "agent-bbb.jsonl", &[stale.as_str()]);
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path());
        }
        let l = live(15);
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }
        let s = l.sessions.iter().find(|s| s.session_id == "sess").unwrap();
        assert!(s.used_subagent);
        // Only the running subagent is surfaced; the stale one is filtered out.
        assert_eq!(s.subagents.len(), 1);
        let sub = &s.subagents[0];
        assert_eq!(sub.agent_id, "agent-aaa");
        assert_eq!(sub.agent.as_deref(), Some("Explore"));
        assert_eq!(sub.skill.as_deref(), Some("code-review"));
        assert_eq!(sub.total_tokens, 30);
        assert_eq!(sub.messages, 1);
        assert!(sub.idle_seconds <= ACTIVE_SECS);
    }

    #[test]
    fn tool_uses_parses_blocks_leniently() {
        // Mixed content: a real tool_use (object caller), a text block, a
        // malformed tool_use (no id), and a string-caller tool_use.
        let m: RawMessage = serde_json::from_str(
            r#"{"content":[
                {"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"},"caller":{"type":"direct"}},
                {"type":"text","text":"hi"},
                {"type":"tool_use","name":"NoId"},
                {"type":"tool_use","id":"tu2","name":"Skill","caller":"direct"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            m.tool_uses(),
            vec![
                (
                    "tu1".to_string(),
                    "Bash".to_string(),
                    Some(r#"{"type":"direct"}"#.to_string())
                ),
                (
                    "tu2".to_string(),
                    "Skill".to_string(),
                    Some("direct".to_string())
                ),
            ]
        );
        // A plain-string content (user turns) yields nothing and doesn't error.
        let m: RawMessage = serde_json::from_str(r#"{"content":"just text"}"#).unwrap();
        assert!(m.tool_uses().is_empty());
    }

    /// One-value SQL query against the ingest db (test-side read only; all
    /// writes still go through `Store`).
    fn q<T: rusqlite::types::FromSql>(db: &Path, sql: &str) -> T {
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn sync_ingests_tool_calls_and_subagent_linkage() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        let subs = proj.join("s1").join("subagents");
        fs::create_dir_all(&subs).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                r#"{"type":"user","uuid":"u0","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/work/widget","gitBranch":"main","entrypoint":"cli","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:05:00.000Z","cwd":"/home/me/work/widget","attributionSkill":"build","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"},"caller":{"type":"direct"}}],"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        // Subagent transcript: same sessionId as the parent (the linkage),
        // plus an agentId attributing its rows to the run.
        write_jsonl(
            &subs,
            "agent-aaa.jsonl",
            &[
                r#"{"type":"assistant","uuid":"u2","isSidechain":true,"sessionId":"s1","agentId":"agent-aaa","attributionAgent":"Explore","timestamp":"2026-06-15T01:10:00.000Z","message":{"model":"claude-haiku-4-5","content":[{"type":"tool_use","id":"tu2","name":"Read","caller":{"type":"direct"}}],"usage":{"input_tokens":10,"output_tokens":20}}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        let rep = sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        assert_eq!(rep.files_scanned, 2);
        assert_eq!(rep.files_ingested, 2);
        assert_eq!(rep.sessions, 1);
        assert_eq!(rep.messages_added, 2);
        assert_eq!(rep.tool_calls_added, 2);

        // One session, span over ALL lines, subagent flag OR-merged in from
        // the sidechain file, metadata keep-first.
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_sessions"), 1);
        assert_eq!(
            q::<String>(&db, "SELECT cwd FROM cc_sessions"),
            "/home/me/work/widget"
        );
        assert_eq!(q::<i64>(&db, "SELECT used_subagent FROM cc_sessions"), 1);
        assert_eq!(
            q::<i64>(&db, "SELECT end_ts - start_ts FROM cc_sessions"),
            600
        );
        // Messages keyed by event uuid; the subagent's row carries agent_id.
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_messages"), 2);
        assert_eq!(
            q::<String>(&db, "SELECT agent_id FROM cc_messages WHERE uuid = 'u2'"),
            "agent-aaa"
        );
        // Tool calls linked to session + message uuid; caller kept verbatim.
        assert_eq!(
            q::<String>(
                &db,
                "SELECT session_id || '/' || message_uuid || '/' || name || '/' || caller \
                 FROM cc_tool_calls WHERE tool_use_id = 'tu1' AND agent_id IS NULL"
            ),
            r#"s1/u1/Bash/{"type":"direct"}"#
        );
        assert_eq!(
            q::<String>(
                &db,
                "SELECT agent_id FROM cc_tool_calls WHERE tool_use_id = 'tu2'"
            ),
            "agent-aaa"
        );
        // The subagent run row links the run to its parent session.
        assert_eq!(
            q::<String>(
                &db,
                "SELECT session_id || '/' || agent FROM cc_agent_runs WHERE agent_id = 'agent-aaa'"
            ),
            "s1/Explore"
        );
    }

    #[test]
    fn sync_ingests_advisor_calls() {
        // task 340: an advisor call is one `assistant` event with a
        // `server_tool_use` block naming "advisor" and its own (large) model
        // usage nested in `usage.iterations`, NOT a separate transcript line
        // the way a Task-tool subagent gets one. Both the tool call and the
        // advisor model's real usage must still be ingested.
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:05:00.000Z","cwd":"/home/me/work/widget","attributionSkill":"build","message":{"model":"claude-sonnet-5","content":[{"type":"server_tool_use","id":"srv1","name":"advisor","input":{}}],"usage":{"input_tokens":4,"output_tokens":683,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"iterations":[{"type":"message","input_tokens":2,"output_tokens":85},{"type":"advisor_message","model":"claude-opus-4-8","input_tokens":91627,"output_tokens":18716,"cache_read_input_tokens":100,"cache_creation_input_tokens":50},{"type":"message","input_tokens":2,"output_tokens":598}]}}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        let rep = sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        assert_eq!(rep.files_ingested, 1);
        // The caller's wrapper turn AND the advisor's own turn each yield a
        // message row.
        assert_eq!(rep.messages_added, 2);
        assert_eq!(rep.tool_calls_added, 1);

        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_messages"), 2);
        assert_eq!(
            q::<String>(&db, "SELECT model FROM cc_messages WHERE uuid = 'u1'"),
            "claude-sonnet-5"
        );
        // The advisor row is keyed off the parent event's uuid (no uuid of
        // its own), carries the advisor's real model + tokens, and is
        // tagged agent "advisor" so it surfaces distinctly from its caller.
        let advisor_uuid = q::<String>(&db, "SELECT uuid FROM cc_messages WHERE uuid != 'u1'");
        assert_eq!(advisor_uuid, "u1:advisor:0");
        assert_eq!(
            q::<String>(
                &db,
                "SELECT model || '/' || agent || '/' || skill || '/' \
                 || input_tokens || '/' || output_tokens \
                 || '/' || cache_read_tokens || '/' || cache_creation_tokens \
                 FROM cc_messages WHERE uuid = 'u1:advisor:0'"
            ),
            "claude-opus-4-8/advisor/build/91627/18716/100/50"
        );
        assert_eq!(
            q::<i64>(
                &db,
                "SELECT COUNT(*) FROM cc_messages \
                 WHERE uuid = 'u1:advisor:0' AND agent_id IS NULL"
            ),
            1
        );
        // The advisor tool call itself is linked back to the parent event.
        assert_eq!(
            q::<String>(
                &db,
                "SELECT session_id || '/' || message_uuid || '/' || name \
                 FROM cc_tool_calls WHERE tool_use_id = 'srv1'"
            ),
            "s1/u1/advisor"
        );
    }

    #[test]
    fn sync_is_idempotent_and_resumes_incrementally() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        let l1 = r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Bash","caller":{"type":"direct"}}],"usage":{"input_tokens":1,"output_tokens":2}}}"#;
        let l2 = r#"{"type":"assistant","uuid":"u2","sessionId":"s1","timestamp":"2026-06-15T01:05:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":3,"output_tokens":4}}}"#;
        let l3 = r#"{"type":"assistant","uuid":"u3","sessionId":"s1","timestamp":"2026-06-15T01:10:00.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu3","name":"Read","caller":{"type":"direct"}}],"usage":{"input_tokens":5,"output_tokens":6}}}"#;
        write_jsonl(&proj, "s1.jsonl", &[l1, l2]);
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        let first = sync(&mut store, false).unwrap();
        assert_eq!(first.files_ingested, 1);
        assert_eq!(first.messages_added, 2);
        assert_eq!(first.tool_calls_added, 1);

        // Unchanged tree: the cursor (mtime + size) skips the file unread.
        let second = sync(&mut store, false).unwrap();
        assert_eq!(second.files_scanned, 1);
        assert_eq!(second.files_ingested, 0);
        assert_eq!(second.sessions, 0);
        assert_eq!(second.messages_added, 0);
        assert_eq!(second.tool_calls_added, 0);

        // Append one event: only the new line ingests (cursor resume), no dupes.
        {
            let mut f = fs::OpenOptions::new()
                .append(true)
                .open(proj.join("s1.jsonl"))
                .unwrap();
            writeln!(f, "{l3}").unwrap();
        }
        let third = sync(&mut store, false).unwrap();
        assert_eq!(third.files_ingested, 1);
        assert_eq!(third.messages_added, 1);
        assert_eq!(third.tool_calls_added, 1);
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_messages"), 3);
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_tool_calls"), 2);

        // Shrunk file (rewrite/rotation — abnormal): full re-parse from 0,
        // upsert keys keep it duplicate-free.
        write_jsonl(&proj, "s1.jsonl", &[l1]);
        let fourth = sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }
        assert_eq!(fourth.files_ingested, 1);
        assert_eq!(fourth.messages_added, 0);
        assert_eq!(fourth.tool_calls_added, 0);
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_messages"), 3);
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_tool_calls"), 2);
    }

    #[test]
    fn rebuild_reparses_unchanged_files_without_duplicating_rows() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        let l1 = r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Bash","caller":{"type":"direct"}}],"usage":{"input_tokens":1,"output_tokens":2}}}"#;
        write_jsonl(&proj, "s1.jsonl", &[l1]);
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        let first = sync(&mut store, false).unwrap();
        assert_eq!(first.files_ingested, 1);
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_files"), 1);

        // Unchanged tree, no rebuild: cursor skips the file unread.
        let plain = sync(&mut store, false).unwrap();
        assert_eq!(plain.files_ingested, 0);

        // Simulate the mesa-task-340 scenario: a row later versions of the
        // parser would emit is missing from an older ingest (here, deleted
        // directly to stand in for "never ingested by the old parser").
        // A rebuild re-walks the same bytes and backfills it — the actual
        // value-add over a plain sync, which the cursor would have skipped.
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute("DELETE FROM cc_tool_calls WHERE tool_use_id = 'tu1'", [])
                .unwrap();
        }
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_tool_calls"), 0);

        // Also stand in for the *unsupported* case: a fix that would change
        // an already-present row's stored values. `cc_messages` inserts on
        // `DO NOTHING`, so this corrupted value must NOT be corrected by a
        // rebuild — proving rebuild is additive-only, never corrective.
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute(
                "UPDATE cc_messages SET input_tokens = 999 WHERE uuid = 'u1'",
                [],
            )
            .unwrap();
        }

        // Unchanged tree, rebuild: the cursor is cleared first, so the file
        // is re-walked from byte 0 regardless of mtime/size.
        let rebuilt = sync(&mut store, true).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }
        assert_eq!(rebuilt.files_scanned, 1);
        assert_eq!(rebuilt.files_ingested, 1);
        // The missing tool-call row is backfilled...
        assert_eq!(rebuilt.tool_calls_added, 1);
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_tool_calls"), 1);
        // ...no duplicate cc_files cursor or cc_messages row is created...
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_files"), 1);
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_messages"), 1);
        assert_eq!(rebuilt.messages_added, 0);
        // ...and the already-present (corrupted) message row is left as-is —
        // rebuild backfills missing rows, it does not correct existing ones.
        assert_eq!(
            q::<i64>(
                &db,
                "SELECT input_tokens FROM cc_messages WHERE uuid = 'u1'"
            ),
            999
        );
    }

    #[test]
    fn window_filters_persisted_rows() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-p");
        fs::create_dir_all(&proj).unwrap();
        // One session entirely in the past; one spanning past → now.
        write_jsonl(
            &proj,
            "old.jsonl",
            &[
                r#"{"type":"assistant","uuid":"uo","sessionId":"old","timestamp":"2000-01-01T00:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":1}}}"#,
            ],
        );
        let recent = format!(
            r#"{{"type":"assistant","uuid":"m2","sessionId":"mix","timestamp":"{}","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":5,"output_tokens":6}}}}}}"#,
            iso_at(60)
        );
        write_jsonl(
            &proj,
            "mix.jsonl",
            &[
                r#"{"type":"assistant","uuid":"m1","sessionId":"mix","timestamp":"2000-01-01T00:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":7,"output_tokens":0}}}"#,
                recent.as_str(),
            ],
        );
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        // `all`: everything persisted is reported.
        let all = collect(&store, "all").unwrap();
        assert_eq!(all.overview.sessions, 2);
        assert_eq!(all.overview.messages, 3);
        assert!(all.since.is_none());

        // `7d`: the year-2000 session drops out; the spanning session stays
        // but only its in-window message counts, and its duration is clamped
        // to the window rather than the 26-year stored span.
        let d7 = collect(&store, "7d").unwrap();
        assert_eq!(d7.window, "7d");
        assert!(d7.since.is_some());
        assert_eq!(d7.overview.sessions, 1);
        assert_eq!(d7.overview.messages, 1);
        assert_eq!(d7.overview.total_tokens, 11);
        let row = &d7.sessions[0];
        assert_eq!(row.session_id, "mix");
        assert_eq!(row.messages, 1);
        assert!(row.duration_minutes <= 8.0 * 24.0 * 60.0);

        // `<n>d` free-form windows share the same path/shape.
        let d2 = collect(&store, "2d").unwrap();
        assert_eq!(d2.overview.sessions, 1);
        assert_eq!(d2.overview.total_tokens, 11);
    }
}
