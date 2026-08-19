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
//! and a `usage` block, so those drive token/cost/model/skill/agent rollups.
//! One other kind of line produces a row of its own: a `user` line that
//! [`human_prompt`] judges to be a real human turn becomes a `cc_prompts` row —
//! a bounded preview and nothing else, no usage, its own table. Every other
//! line with a timestamp merely contributes to the session's start/end span,
//! and lines that don't parse, or aren't telemetry, are skipped.
//!
//! One API response is written as SEVERAL transcript lines — typically a
//! `thinking` line then the `text`/`tool_use` line — and every one of them
//! repeats the *identical* `message.usage` block. `message.id` is what those
//! lines share and what a separate billed call differs on, so it is the
//! billing identity: rows stay per-line (a tool call links to its event uuid,
//! and the session graph draws one response node per line) while every read
//! that sums usage counts each [`dedupe_key`] once. Without that, a single
//! billed response was counted 2-4 times (task 693).
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
//! Cost is **estimated** from a per-model price table (USD per million
//! tokens), labelled as an estimate in the UI. The table is
//! [`crate::core::config::PriceTable`] — the rates mesa ships, overlaid by the
//! `pricing` section of `~/.mesa/config.json` — so a price change or a new
//! model family is a Settings edit rather than a rebuild. It is built once per
//! request and threaded through the per-message loops below.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::config::PriceTable;
use super::store::{
    CcAgentRunUpsert, CcFileBatch, CcFileCursor, CcMessageRow, CcNodeFilePair, CcPromptRow,
    CcSessionRecord, CcSessionUpsert, CcToolCallRow, Error, Result, Store,
};
use super::types::{
    CcAgentStat, CcChatAsk, CcChatOption, CcChatQuestion, CcChatTurn, CcChatTurnKind, CcDashboard,
    CcDayPoint, CcGraphEdge, CcGraphNode, CcGraphNodeKind, CcLive, CcLiveSession, CcLiveSubagent,
    CcModelStat, CcNodeText, CcNodeTextFormat, CcOverview, CcProjectStat, CcSessionBucket,
    CcSessionChat, CcSessionDetail, CcSessionGraph, CcSessionModelStat, CcSessionRow,
    CcSessionSkillStat, CcSessionThreadStat, CcSessionToolStat, CcSkillStat, CcTokens, CcToolStat,
    CcUsage,
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
    /// The line's own type tag (`"user"`, `"assistant"`, `"system"`, …). Only
    /// [`human_prompt`] reads it: every other path keys off the shape of
    /// `message` instead, which is why it went unparsed until task 774.
    #[serde(rename = "type", default)]
    kind: Option<String>,
    /// Set by Claude Code on a `user` line it synthesized rather than received:
    /// hook output, an injected skill body, an image stub, a caveat banner.
    #[serde(default)]
    is_meta: Option<bool>,
    /// Present on the `user` line that *carries* a tool's result back into the
    /// conversation — a transport frame, never a human turn.
    #[serde(default)]
    tool_use_result: Option<serde_json::Value>,
    // `userType` is deliberately NOT parsed: the resolved predicate never
    // consults it (`origin.type` is the authority, with a prefix fallback for
    // legacy lines), and a field no code reads is a `dead_code` failure under
    // the `-D warnings` clippy gate.
    /// Where the turn came from (Claude Code ≥ v2.1.187). Authoritative for
    /// [`human_prompt`] when present.
    #[serde(default)]
    origin: Option<RawOrigin>,
}

/// The `origin` block of a `user` line. Only what it calls the turn is read.
///
/// **Upstream has spelled that key both ways** — `type` when the block was
/// introduced (v2.1.187), `kind` on current releases (v2.1.227, task 814) — so
/// both are parsed. Reading only one fails *silent and total*: an `origin`
/// object whose single key mesa doesn't know deserializes to an all-`None`
/// `RawOrigin`, which is not "no origin" (the branch that falls back to the
/// prefix list) but "origin says not-human", so every human turn of every
/// session is rejected and `cc_prompts` quietly stops growing. Found by live
/// QA of the chat view, whose whole left side was missing.
///
/// They are **two fields, not one field with `#[serde(alias)]`**. An alias
/// maps two JSON keys onto one field, which makes a line carrying *both*
/// spellings a serde duplicate-field error — and every parse site here is
/// `let Ok(raw) = … else { continue }`, so that line would be dropped from
/// the ingest entirely, taking its usage, tool calls and session span with
/// it. Emitting both keys through a rename is the most ordinary thing
/// upstream could do next, and it must degrade to "read either", never to a
/// worse failure than the bug this fixes.
#[derive(Deserialize)]
struct RawOrigin {
    #[serde(rename = "type", default)]
    type_key: Option<String>,
    #[serde(rename = "kind", default)]
    kind_key: Option<String>,
}

impl RawOrigin {
    /// What this block calls the turn, under either spelling. `type` wins when
    /// both are present and disagree — it is the original, so a line carrying
    /// both is most likely a compatibility emission led by the old key.
    fn says(&self) -> Option<&str> {
        self.type_key.as_deref().or(self.kind_key.as_deref())
    }
}

#[derive(Deserialize)]
struct RawMessage {
    /// The API response id (`msg_…`). One response is written as SEVERAL
    /// transcript lines (a `thinking` line, then the `text`/`tool_use` line),
    /// each repeating the identical `usage` block under this one id — so it,
    /// not the per-line `uuid`, is the billing identity reads dedupe on
    /// ([`dedupe_key`]).
    #[serde(default)]
    id: Option<String>,
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
    /// The `tool_use` blocks of this message as `(id, name, caller, target)`.
    /// Blocks missing a string `id`/`name`, and unknown block shapes, are
    /// skipped — the same leniency as malformed lines. `caller` is kept
    /// verbatim: a JSON string as-is, any other non-null value as its compact
    /// JSON text. `server_tool_use` blocks (e.g. the built-in `advisor` tool)
    /// carry the same shape under a distinct `type` tag, so they're read the
    /// same way.
    ///
    /// `input` is read **only** through [`tool_target`], which lifts at most
    /// one short scalar out of it. The payload as a whole is still never
    /// stored: it is untrusted and unbounded (a `Write` carries a whole file,
    /// an `Edit` two copies of a hunk), which is why the narrow extraction is
    /// a named function with its own cap rather than a field grab here.
    fn tool_uses(&self) -> Vec<(String, String, Option<String>, Option<String>)> {
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
                let target = b.get("input").and_then(tool_target);
                Some((id.to_string(), name.to_string(), caller, target))
            })
            .collect()
    }

    /// This message's prose: the `text` of every `type: "text"` block, in
    /// array order, joined with a single space and then run once through
    /// [`sanitize_capped`]. `None` when `content` is not an array (a user
    /// line carries a plain string), holds no `text` block (a tool-use-only
    /// assistant turn), or when nothing survives sanitization.
    ///
    /// One preview per *message*, never one per block: the graph draws one
    /// response node per message, and joining before sanitizing is what makes
    /// the cap bound the whole message rather than each block separately.
    ///
    /// `thinking` blocks are deliberately excluded. They would land reasoning
    /// prose in the same unlabelled `preview` field with no way for a reader
    /// to tell it from the reply, and thinking routinely dwarfs the response —
    /// it would win the cap and push the actual reply out.
    fn assistant_text(&self) -> Option<String> {
        sanitize_capped(&self.assistant_text_raw()?)
    }

    /// The same prose, **uncapped and unsanitized** — the body
    /// [`node_text`] returns for a `msg:` node. Split out rather than
    /// duplicated so the two can never disagree about *which* blocks count:
    /// the only difference between them is the cap.
    fn assistant_text_raw(&self) -> Option<String> {
        let blocks = self.content.as_ref()?.as_array()?;
        let joined = blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        if joined.is_empty() {
            None
        } else {
            Some(joined)
        }
    }
}

/// Cap on a stored [`tool_target`], in characters. A `Bash` command runs past
/// 400 chars in ~10% of real calls and a `Write` input is a whole file, so the
/// cap is what keeps the column bounded; it sits well above the ~40 chars a
/// 210px graph node can show, leaving the rest for the node's hover title.
pub const TARGET_MAX_CHARS: usize = 200;

/// Input keys worth lifting, most specific first — the first one holding a
/// string wins. One ordered list rather than a per-tool `match`: it gets every
/// tool observed across 52k real calls right (`Bash`→`command`,
/// `Read`/`Write`/`Edit`→`file_path`, `Skill`→`skill`, `WebFetch`→`url`,
/// `Agent`→`description`, `EnterWorktree`→`name`) and degrades to `None` for
/// an unknown tool instead of needing an edit for every new one.
///
/// Order carries the decisions. `command` precedes `description` because
/// `Bash` carries both and the command is the point; `subject` precedes
/// `description` for `TaskCreate`'s pair. Bulk-payload keys (`prompt`,
/// `content`, `new_string`, `script`) are absent on purpose — they are the
/// unbounded halves this function exists to avoid.
const TARGET_KEYS: &[&str] = &[
    "skill",
    "command",
    "file_path",
    "url",
    "query",
    "pattern",
    "path",
    "name",
    "subject",
    "title",
    "description",
];

/// The one short scalar worth keeping from a `tool_use.input` payload: what
/// the call acted on. `None` when the input is not an object (a `Read` whose
/// input failed to parse arrives as `{"__unparsedToolInput": "..."}` or worse),
/// when no known key holds a string, or when the value is blank.
///
/// The result is sanitized and capped by [`sanitize_capped`] before it is
/// returned — at ingest, never at a display site — because it is **untrusted
/// model-authored text heading for a database**: whitespace runs (a heredoc's
/// newlines) collapse to single spaces and control characters are dropped, so
/// one row can never span lines or move a terminal cursor when a
/// `mesa cc graph` payload is catted. It stays data, never instructions.
pub fn tool_target(input: &serde_json::Value) -> Option<String> {
    let obj = input.as_object()?;
    let raw = TARGET_KEYS
        .iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()))?;
    sanitize_capped(raw)
}

/// Sanitize and cap untrusted model-authored text on its way into the db:
/// whitespace runs collapse to a single space, control characters are dropped,
/// and the result is cut at [`TARGET_MAX_CHARS`] **characters** (never bytes)
/// with a trailing `…`. `None` when nothing survives.
///
/// One policy, shared by every transcript-derived string mesa stores —
/// [`tool_target`]'s lifted `tool_use.input` scalar and
/// [`RawMessage::assistant_text`]'s prose preview. Sanitizing here rather than
/// at any display site is what guarantees a stored row can never span lines or
/// move a terminal cursor when a `mesa cc graph` payload is catted. It stays
/// data, never instructions.
pub fn sanitize_capped(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut pending_space = false;
    let mut chars = 0usize;
    for c in raw.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if c.is_control() {
            continue;
        }
        if pending_space {
            if chars == TARGET_MAX_CHARS {
                break;
            }
            out.push(' ');
            chars += 1;
            pending_space = false;
        }
        if chars == TARGET_MAX_CHARS {
            out.push('…');
            break;
        }
        out.push(c);
        chars += 1;
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Text prefixes that mark a `user` line as machinery rather than a human
/// turn. **The pre-`origin` fallback only**: Claude Code ≥ v2.1.187 stamps
/// every user line with an `origin` block, which is authoritative and skips
/// this list entirely. Older transcripts have nothing but the text to go on,
/// and these are the shapes observed carrying injected content — command
/// echoes, local command output, caveat banners, interrupt markers, image
/// stubs, notifications, hook feedback, skill preambles and cross-session
/// messages.
const NON_HUMAN_PREFIXES: &[&str] = &[
    "<command-message>",
    "<local-command-stdout>",
    "<local-command-caveat>",
    "Caveat: The messages below were generated",
    "<system-reminder>",
    // Both the bare marker and the `… for tool use]` variant, so the entry
    // deliberately stops before the closing bracket.
    "[Request interrupted by user",
    // Ctrl-B bash mode writes the command the user typed AND its output back
    // as `user` lines. The command is human input and is kept; its captured
    // output is not. (Found by ingesting the real corpus: 4 rows in 2,312.)
    "<bash-stdout>",
    "<bash-stderr>",
    "[Image:",
    "[SYSTEM NOTIFICATION",
    "Stop hook feedback:",
    "Base directory for this skill:",
    "<teammate-message",
    "Another Claude session sent a message:",
];

/// The preview of a real human turn, or `None` for every other `user` line.
///
/// Claude Code writes far more `user` lines than the user ever typed: tool
/// results ride back in on one, so do hook output, injected skill bodies,
/// system reminders and image stubs, and a subagent's task prompt is a `user`
/// line on a sidechain. This is the single place that decides which of them a
/// human actually authored — pure, so the decision is unit-testable against a
/// synthetic line rather than only through a whole `sync`.
///
/// Two things are worth spelling out:
///
/// * **Slash commands count.** A `/execute-todo 774` turn is what the user
///   typed, even though Claude Code rewrites it into a command envelope before
///   the model sees it; the envelope is unwrapped back to `name args`. In
///   skill-driven use, free-typed turns are ~1% of user lines and whole
///   sessions have none, so dropping these would leave the feature showing
///   almost nothing.
/// * **`origin.type` is the authority, `promptSource` is not** —
///   `claude-desktop` human turns carry `promptSource: "sdk"`. Lines predating
///   `origin` fall back to [`NON_HUMAN_PREFIXES`].
///
/// The result is sanitized and capped by the shared [`sanitize_capped`], the
/// same policy every other transcript-derived string mesa stores goes through:
/// what lands in the db is a bounded preview, never the prompt body.
fn human_prompt(line: &RawLine) -> Option<String> {
    sanitize_capped(&human_prompt_raw(line)?)
}

/// The same human turn, **uncapped and unsanitized** — the body
/// [`node_text`] returns for a `prompt:` node. Split out rather than
/// duplicated so the two can never disagree about which `user` lines count as
/// a human turn at all; the only difference between them is the cap.
fn human_prompt_raw(line: &RawLine) -> Option<String> {
    if line.kind.as_deref() != Some("user") {
        return None;
    }
    if line.is_meta == Some(true) {
        return None;
    }
    // A sidechain user line is a *subagent's task prompt*, already carried by
    // the agent node's `description`. Main thread only.
    if line.is_sidechain == Some(true) {
        return None;
    }
    if line.tool_use_result.is_some() {
        return None;
    }

    let content = line.message.as_ref()?.content.as_ref()?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => {
            // ~794 tool-result carriers in the real corpus lack
            // `toolUseResult`, so the guard above is not enough on its own:
            // one `tool_result` block condemns the whole line.
            if blocks
                .iter()
                .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
            {
                return None;
            }
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .filter(|t| !t.trim_start().starts_with("<system-reminder>"))
                .collect::<Vec<_>>()
                .join(" ")
        }
        _ => return None,
    };

    if let Some(cmd) = slash_command(&text) {
        return Some(cmd);
    }
    let accepted = match line.origin.as_ref() {
        Some(o) => o.says() == Some("human"),
        None => {
            let trimmed = text.trim_start();
            !NON_HUMAN_PREFIXES.iter().any(|p| trimmed.starts_with(p))
        }
    };
    if !accepted {
        return None;
    }
    if text.is_empty() { None } else { Some(text) }
}

/// The `/name args` a `<command-name>` envelope stands for, or `None` when the
/// text is not one. Claude Code rewrites a typed slash command into this
/// envelope, so reconstructing it is what keeps a skill-driven session's human
/// turns visible at all.
fn slash_command(text: &str) -> Option<String> {
    let name = tagged(text, "command-name")?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    match tagged(text, "command-args").map(|a| a.trim().to_string()) {
        Some(args) if !args.is_empty() => Some(format!("{name} {args}")),
        _ => Some(name.to_string()),
    }
}

/// The body of the first `<tag>…</tag>` pair in `text`.
fn tagged<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(&format!("</{tag}>"))?;
    Some(&rest[..end])
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

// ---- pricing (USD per 1M tokens) ----
//
// The table lives in `~/.mesa/config.json` over the built-in defaults
// (`core::config::PriceTable`, mesa task 692), matched on a model-family
// prefix. It is loaded ONCE per request and threaded down: these are
// per-message loops, so a per-row file read would be a real cost.

/// The merged price table, or the store's error type — a config file that
/// exists but can't be read is surfaced, never silently priced at the
/// built-ins (`docs/config.md`).
fn load_prices() -> Result<PriceTable> {
    PriceTable::load().map_err(|e| super::store::Error::Io(std::io::Error::other(e)))
}

fn estimate_cost(prices: &PriceTable, model: &str, u: &RawUsage) -> f64 {
    let r = prices.for_model(model);
    (u.input_tokens as f64 * r.input
        + u.output_tokens as f64 * r.output
        + u.cache_read_input_tokens as f64 * r.cache_read
        + u.cache_creation_input_tokens as f64 * r.cache_write)
        / 1_000_000.0
}

/// The cost of one stored message row — the db-side twin of [`estimate_cost`],
/// shared by the two per-session rollups so the formula exists once.
fn row_cost(prices: &PriceTable, m: &CcMessageRow) -> f64 {
    let r = prices.for_model(&m.model);
    (m.input_tokens as f64 * r.input
        + m.output_tokens as f64 * r.output
        + m.cache_read_tokens as f64 * r.cache_read
        + m.cache_creation_tokens as f64 * r.cache_write)
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
pub(crate) const ACTIVE_SECS: i64 = 90;
/// Width of one `spark` bucket — one bar per minute.
const LIVE_BUCKET_SECS: i64 = 60;

/// Build the dashboard for `window` (`7d`/`30d`/`90d`/`all`/`<n>d`) from the
/// **persisted** `cc_*` rows — no transcript file is opened, so history
/// survives Claude Code deleting its transcripts, and nothing can be counted
/// twice against live files. Callers must run [`sync`] first to fold new
/// transcript lines in. Returns **all** session rows (newest first); callers
/// that need a bounded payload cap `sessions` themselves ([`MAX_SESSION_ROWS`]).
pub fn collect(store: &Store, window: &str) -> Result<CcDashboard> {
    collect_inner(store, window, None, None)
}

/// [`collect`] with the cutoff supplied by the caller instead of derived from
/// the clock — the one case mesa cannot derive: a [`USAGE_WINDOWS`] token,
/// whose start is the live usage endpoint's `resets_at` minus the window's
/// length ([`usage_window_start`]). The fetch and its cache stay with the
/// caller, so this module still reads nothing but the db.
pub fn collect_since(store: &Store, window: &str, since: i64) -> Result<CcDashboard> {
    collect_inner(store, window, None, Some(since))
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
    // Same rule `collect_inner` enforces, applied before the zero-state
    // shortcut can hand back a 30-day cutoff wearing a `cc-5h` label.
    reject_usage_window(window)?;
    let Some(local_path) = local_path else {
        return Ok(empty_dashboard(window, None));
    };
    collect_inner(store, window, Some(local_path), None)
}

/// [`collect_for_project`] with a caller-supplied cutoff, for the same reason
/// [`collect_since`] has one.
pub fn collect_for_project_since(
    store: &Store,
    window: &str,
    since: i64,
    local_path: Option<&str>,
) -> Result<CcDashboard> {
    let Some(local_path) = local_path else {
        return Ok(empty_dashboard(window, Some(since)));
    };
    collect_inner(store, window, Some(local_path), Some(since))
}

/// Zero-valued dashboard for `window`, built by running the same cutoff/now
/// computation `collect` uses over an empty [`Agg`] — guarantees the
/// zero-state has exactly the same shape (overview zeros, empty vecs, correct
/// `window`/`since`/`generated_at_unix`) as a real dashboard that happens to
/// match nothing, with no hand-maintained "empty CcDashboard" literal to
/// drift out of sync.
fn empty_dashboard(window: &str, since: Option<i64>) -> CcDashboard {
    let now = now_unix();
    Agg::default().finish(window, since.or_else(|| window_cutoff(window, now)), now)
}

/// Shared body of [`collect`] and [`collect_for_project`]. `cwd_filter: None`
/// is unfiltered (the global dashboard); `Some(path)` restricts every
/// aggregation loop to sessions whose `cwd` exactly equals `path`.
fn collect_inner(
    store: &Store,
    window: &str,
    cwd_filter: Option<&str>,
    since: Option<i64>,
) -> Result<CcDashboard> {
    let prices = load_prices()?;
    let now = now_unix();
    // A subscription window has no clock-derived cutoff: it starts when the
    // live usage endpoint says the open window started. Reaching here without
    // one would silently serve the 30-day fallback under a `cc-5h` label, so
    // it is an error rather than a quiet substitution.
    if since.is_none() {
        reject_usage_window(window)?;
    }
    let cutoff = since.or_else(|| window_cutoff(window, now));

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

    // One billed API response spans several transcript lines that repeat its
    // usage; rows arrive in a deterministic order (`ORDER BY ts, uuid`), so the
    // first line of a response contributes everything and its repeats nothing
    // — including the `messages` counts, which count responses, not lines.
    let mut seen: HashSet<String> = HashSet::new();
    for m in store.cc_read_messages(cutoff)? {
        if !seen.insert(dedupe_key(&m).to_string()) {
            continue;
        }
        let usage = RawUsage {
            input_tokens: m.input_tokens,
            output_tokens: m.output_tokens,
            cache_read_input_tokens: m.cache_read_tokens,
            cache_creation_input_tokens: m.cache_creation_tokens,
            ..Default::default()
        };
        let cost = estimate_cost(&prices, &m.model, &usage);
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
        let (mut batch, consumed) = parse_batch(&bytes[start..]);
        apply_sidecar(&f, &mut batch);
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

/// Purge the persisted `cc_*` telemetry and re-ingest every transcript still
/// on disk — the *corrective* counterpart to `sync(store, true)`'s additive
/// re-walk. A rebuild can only add rows a parser previously missed; only a
/// purge can fix rows whose stored values are wrong (task 693: Claude Code
/// repeats one API response's `usage` across several transcript lines, so
/// pre-fix rows double-count cost and tokens).
///
/// Destructive of history: a session whose transcript file Claude Code has
/// since deleted cannot be re-read, so its rows are gone permanently. Shared
/// verbatim by `mesa cc reset` and `POST /api/cc/reset` so the two cannot
/// diverge; no read path may call it.
pub fn reset_and_sync(store: &mut Store) -> Result<CcSyncReport> {
    store.cc_reset()?;
    // Cursors went with the reset, so a plain sync already re-walks from 0.
    sync(store, false)
}

/// The `.meta.json` sidecar Claude Code writes beside each subagent
/// transcript: how the run was spawned. Not telemetry — none of it appears on
/// the transcript lines, so without this the `Task` call that started a
/// subagent and the subagent itself are two unrelated rows.
#[derive(Deserialize)]
struct RawSidecar {
    #[serde(rename = "toolUseId")]
    tool_use_id: Option<String>,
    description: Option<String>,
    #[serde(rename = "spawnDepth")]
    spawn_depth: Option<i64>,
    #[serde(rename = "parentAgentId")]
    parent_agent_id: Option<String>,
}

/// Fold `<transcript>.meta.json` into the batch's agent runs, when the file is
/// a subagent transcript that has one.
///
/// Applied to *every* run in the batch rather than matched by `agent_id`: a
/// subagent transcript is one run's transcript (its lines all carry the same
/// `agentId`), and the sidecar's own name encodes that same id, so there is
/// nothing to disambiguate. An ordinary session transcript has no sidecar and
/// no `agentId` lines, so this is a no-op there twice over.
///
/// Missing, unreadable, or unparseable sidecar → leave the fields `None`. The
/// spawn edge is an enrichment; a run without it still ingests and still shows
/// up in the graph (reparented onto the root).
fn apply_sidecar(transcript: &Path, batch: &mut CcFileBatch) {
    if batch.agent_runs.is_empty() {
        return;
    }
    let meta = transcript.with_extension("meta.json");
    let Ok(bytes) = fs::read(&meta) else { return };
    let Ok(raw) = serde_json::from_slice::<RawSidecar>(&bytes) else {
        return;
    };
    for r in &mut batch.agent_runs {
        if r.tool_use_id.is_none() {
            r.tool_use_id.clone_from(&raw.tool_use_id);
        }
        if r.description.is_none() {
            r.description.clone_from(&raw.description);
        }
        if r.spawn_depth.is_none() {
            r.spawn_depth = raw.spawn_depth;
        }
        if r.parent_agent_id.is_none() {
            r.parent_agent_id.clone_from(&raw.parent_agent_id);
        }
    }
}

/// Fold the complete (`\n`-terminated) lines of `bytes` into a [`CcFileBatch`],
/// returning it with the count of bytes consumed — the offset just past the
/// last complete line. A trailing partial line (a writer mid-append) is left
/// for the next sync.
fn parse_batch(bytes: &[u8]) -> (CcFileBatch, usize) {
    // BTreeMaps so the batch order is deterministic for a given input.
    let mut sessions: BTreeMap<String, CcSessionUpsert> = BTreeMap::new();
    let mut agent_runs: BTreeMap<(String, String), CcAgentRunUpsert> = BTreeMap::new();
    // Every `(sessionId, agentId)` pair whose lines are in this file — the
    // pointer back to the transcript. A BTreeSet, so it is deduped and
    // deterministic like the two maps above.
    let mut node_files: BTreeSet<(String, String)> = BTreeSet::new();
    let mut batch = CcFileBatch::default();
    let mut pos = 0usize;
    let mut consumed = 0usize;
    while let Some(nl) = bytes[pos..].iter().position(|&b| b == b'\n') {
        let line = &bytes[pos..pos + nl];
        pos += nl + 1;
        consumed = pos;
        if let Ok(line) = std::str::from_utf8(line) {
            fold_line(
                line,
                &mut sessions,
                &mut agent_runs,
                &mut node_files,
                &mut batch,
            );
        }
    }
    batch.sessions = sessions.into_values().collect();
    batch.agent_runs = agent_runs.into_values().collect();
    batch.node_files = node_files
        .into_iter()
        .map(|(session_id, agent_id)| CcNodeFilePair {
            session_id,
            agent_id,
        })
        .collect();
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
    node_files: &mut BTreeSet<(String, String)>,
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

    // This line's thread → this file. Recorded from the line's own ids rather
    // than from the accumulators below, because a subagent transcript's lines
    // carry the *parent's* `sessionId`: deriving the main-thread pair from
    // `sessions` would point every session at a subagent's file.
    node_files.insert((sid.clone(), raw.agent_id.clone().unwrap_or_default()));

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
                // Spawn provenance is not on the transcript lines at all — it
                // lives in the run's `.meta.json` sidecar, which `sync` folds
                // in after parsing (see `apply_sidecar`).
                tool_use_id: None,
                description: None,
                spawn_depth: None,
                parent_agent_id: None,
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
    // A human turn is a `user` line, so it carries neither a model nor a usage
    // block and produces none of the rows below — it gets its own row, in its
    // own table, and leaves every other path untouched.
    if let Some(preview) = human_prompt(&raw) {
        batch.prompts.push(CcPromptRow {
            uuid: uuid.clone(),
            session_id: sid.clone(),
            ts,
            preview,
        });
    }
    for (tool_use_id, name, caller, target) in msg.tool_uses() {
        batch.tool_calls.push(CcToolCallRow {
            tool_use_id,
            message_uuid: uuid.clone(),
            session_id: sid.clone(),
            agent_id: raw.agent_id.clone(),
            name,
            caller,
            ts,
            target,
        });
    }
    if let (Some(model), Some(usage)) = (msg.model.as_ref(), msg.usage.as_ref()) {
        batch.messages.push(CcMessageRow {
            uuid: uuid.clone(),
            message_id: msg.id.clone(),
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
            // The prose this assistant turn emitted, already sanitized and
            // capped. `None` for a tool-use-only turn — indistinguishable
            // from a row that predates the column, by design: both mean
            // "no response node".
            preview: msg.assistant_text(),
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
                // Its OWN key, never the parent's bare `message.id` — that
                // would make these real advisor tokens read as a duplicate of
                // the wrapper turn and be discarded. Built from the parent's
                // `message.id` when there is one so that the iterations
                // repeated on every line of one response still collapse to
                // one, and from the per-line uuid otherwise.
                message_id: Some(format!(
                    "{}:advisor:{i}",
                    msg.id.as_deref().unwrap_or(uuid.as_str())
                )),
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
                // A synthesized row for a nested advisor turn — it has no
                // `content[]` of its own to preview.
                preview: None,
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
    // `live` cannot fail — it returns a view, not a Result — so an unreadable
    // config falls back to the shipped rates here rather than blanking the
    // panel. The verbs that *edit* the table (`/api/config/pricing`) are where
    // a malformed file is reported, as 502.
    let prices = PriceTable::load().unwrap_or_else(|_| PriceTable::builtin());
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
            parse_live_file(&f, &prices, cutoff, first_min, n_buckets, &mut sessions);
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
    prices: &PriceTable,
    cutoff: i64,
    first_min: i64,
    n_buckets: usize,
    sessions: &mut HashMap<String, LiveAcc>,
) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    // The same per-response duplication the persisted path dedupes: the lines
    // of one API response repeat its usage, and they are always in one file,
    // so a per-file set is enough. Keyed on `message.id`, falling back to the
    // line uuid; a line with neither is never deduped, so it still counts.
    let mut seen: HashSet<String> = HashSet::new();
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
        let key = raw
            .message
            .as_ref()
            .and_then(|m| m.id.as_deref())
            .or(raw.uuid.as_deref());
        if let Some(key) = key
            && !seen.insert(key.to_string())
        {
            continue;
        }
        s.models.insert(model.clone());
        s.messages += 1;
        s.tokens.add(usage);
        s.cost += estimate_cost(prices, &model, usage);
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

// ---- session call tree (`mesa cc graph`, `GET /api/cc/sessions/{id}/graph`) ----

/// Default cap on `tool` nodes in one graph. The largest real session observed
/// carries ~6.6k tool calls, which is a useless picture and a slow canvas;
/// subagent nodes and the calls that spawned them are never counted against
/// this, so the tree stays connected however low it goes. `response` nodes are
/// the second unbounded population and get this same cap as their own,
/// separately counted budget.
pub const GRAPH_NODE_LIMIT: usize = 600;

/// Build one session's call tree from the persisted `cc_*` rows. `Ok(None)`
/// when the session was never ingested.
///
/// The tree is `session → tool → agent → tool → …`: a subagent hangs off the
/// `Task` call that spawned it (`cc_agent_runs.tool_use_id`, from the run's
/// `.meta.json` sidecar). A run whose sidecar was missing falls back to its
/// `parent_agent_id`, then to the root — so a pre-sidecar row still renders,
/// just flattened.
///
/// A message that emitted prose also gets a `response` node (`msg:<uuid>`),
/// hung off the same parent as that message's tool nodes and emitted before
/// them when they share a timestamp.
///
/// Each ingested human turn gets a `prompt` node (`prompt:<uuid>`), always a
/// direct child of the root, and sorts ahead of both at an equal timestamp —
/// it is the cause of what follows it.
pub fn session_graph(
    store: &Store,
    session_id: &str,
    limit: usize,
) -> Result<Option<CcSessionGraph>> {
    let prices = load_prices()?;
    let Some(sess) = store.cc_session(session_id)? else {
        return Ok(None);
    };
    let messages = store.cc_session_messages(session_id)?;
    let tool_calls = store.cc_session_tool_calls(session_id)?;
    let runs = store.cc_session_agent_runs(session_id)?;
    let prompts = store.cc_session_prompts(session_id)?;

    // ---- per-thread rollups, keyed by agent_id (None = the main thread) ----
    #[derive(Default)]
    struct Thread {
        tok: Tok,
        cost: f64,
        messages: i64,
        tool_calls: i64,
        /// model -> message count, for "the model this thread mostly ran on".
        models: BTreeMap<String, i64>,
    }
    let mut threads: HashMap<Option<String>, Thread> = HashMap::new();
    // tool_use_id -> its issuing message's (model, tokens, cost). A tool_use
    // can sit on an event carrying no usage, so this is a lookup, not a join.
    let mut by_uuid: HashMap<&str, (&str, Tok, f64)> = HashMap::new();

    // Nodes stay per transcript line (`by_uuid` below, and one response node
    // per prose line), but the thread ROLLUP the session/agent nodes show is
    // usage — so it counts one API response once, exactly as the detail page
    // does. Otherwise a session's own KPIs and its call tree would disagree.
    let mut seen: HashSet<&str> = HashSet::new();
    for m in &messages {
        let cost = row_cost(&prices, m);
        if seen.insert(dedupe_key(m)) {
            let t = threads.entry(m.agent_id.clone()).or_default();
            t.tok.input += m.input_tokens;
            t.tok.output += m.output_tokens;
            t.tok.cache_read += m.cache_read_tokens;
            t.tok.cache_creation += m.cache_creation_tokens;
            t.cost += cost;
            t.messages += 1;
            *t.models.entry(m.model.clone()).or_insert(0) += 1;
        }
        by_uuid.insert(
            &m.uuid,
            (
                &m.model,
                Tok {
                    input: m.input_tokens,
                    output: m.output_tokens,
                    cache_read: m.cache_read_tokens,
                    cache_creation: m.cache_creation_tokens,
                },
                cost,
            ),
        );
    }
    for c in &tool_calls {
        threads.entry(c.agent_id.clone()).or_default().tool_calls += 1;
    }

    // ---- which tool calls are structural (spawned a subagent) ----
    let spawning: HashSet<&str> = runs
        .iter()
        .filter_map(|r| r.tool_use_id.as_deref())
        .collect();

    // ---- truncation: keep every spawning call, fill the rest oldest-first ----
    let plain = tool_calls
        .iter()
        .filter(|c| !spawning.contains(c.tool_use_id.as_str()))
        .count();
    let keep_plain = limit.saturating_sub(spawning.len());
    let omitted = plain.saturating_sub(keep_plain) as i64;
    let mut budget = keep_plain;

    let mut nodes: Vec<CcGraphNode> = Vec::new();
    let mut edges: Vec<CcGraphEdge> = Vec::new();

    // ---- root ----
    let main = threads.get(&None);
    nodes.push(CcGraphNode {
        id: "session".into(),
        kind: CcGraphNodeKind::Session,
        name: short_session(session_id),
        target: None,
        model: main.and_then(|t| top_model(&t.models)),
        tokens: main
            .map(|t| t.tok.to_cc())
            .unwrap_or_else(|| Tok::default().to_cc()),
        total_tokens: main.map_or(0, |t| t.tok.total()),
        tokens_are_rollup: true,
        est_cost_usd: round4(main.map_or(0.0, |t| t.cost)),
        ts: sess.start_ts.map(fmt_ts),
        skill: None,
        description: None,
        spawn_depth: None,
        messages: main.map_or(0, |t| t.messages),
        tool_calls: main.map_or(0, |t| t.tool_calls),
        caller: None,
    });

    // ---- response budget: its own `limit`, oldest-first, its own counter ----
    //
    // Response nodes are a second unbounded population. Riding the tool budget
    // would make `omitted_tool_calls` count non-tools, so the same limit is
    // applied to them independently and what it drops is reported separately.
    // `messages` is already ordered by (ts, uuid), so `take` keeps the oldest.
    let prose = messages.iter().filter(|m| m.preview.is_some());
    let prose_total = prose.clone().count();
    let omitted_responses = prose_total.saturating_sub(limit) as i64;

    // ---- prompt budget: the same again, a third time ----
    //
    // Human turns are a third unbounded population, and the same reasoning
    // applies: sharing either budget above would make its counter report
    // something other than what it names. `prompts` is ordered by (ts, uuid),
    // so `take` keeps the oldest.
    let omitted_prompts = prompts.len().saturating_sub(limit) as i64;

    // Prompt, tool and response nodes are emitted in ONE merged, ts-ordered
    // pass. They routinely share a `ts` (one assistant message emits prose and
    // its calls at the same instant; a prompt is stamped the same second the
    // reply to it starts) and the frontend tie-breaks equal `ts` by server
    // order, so the ordering must be deterministic here, not an artifact of
    // which loop happened to push first: sort by (ts, kind_rank, id) with
    // prompt = 0, response = 1, tool = 2. A prompt causes what follows it, so
    // it sorts first; response-before-tool is unchanged, just shifted up.
    // Emitting all responses in a pass of their own would instead break
    // `nodes`' documented "oldest first" for every reader.
    struct Pending {
        ts: i64,
        rank: u8,
        node: CcGraphNode,
        edge: CcGraphEdge,
    }
    let mut pending: Vec<Pending> = Vec::new();

    // ---- tool nodes, oldest first ----
    let mut kept_tools: HashSet<&str> = HashSet::new();
    for c in &tool_calls {
        let structural = spawning.contains(c.tool_use_id.as_str());
        if !structural {
            if budget == 0 {
                continue;
            }
            budget -= 1;
        }
        kept_tools.insert(&c.tool_use_id);
        let issuing = by_uuid.get(c.message_uuid.as_str());
        // A `Skill` call is promoted to its own kind and labelled with the
        // skill itself — `Skill`/`Skill`/`Skill` down a column says nothing.
        // The promotion needs the target (that *is* the skill name), so a row
        // ingested before migration 22 stays a plain tool node rather than
        // becoming a `skill` node with nothing to call itself.
        let is_skill = c.name == "Skill" && c.target.is_some();
        let (kind, name, target) = if is_skill {
            (CcGraphNodeKind::Skill, c.target.clone().unwrap(), None)
        } else {
            (CcGraphNodeKind::Tool, c.name.clone(), c.target.clone())
        };
        let node = CcGraphNode {
            id: format!("tool:{}", c.tool_use_id),
            kind,
            name,
            target,
            model: issuing.map(|(m, _, _)| (*m).to_string()),
            tokens: issuing
                .map(|(_, t, _)| t.to_cc())
                .unwrap_or_else(|| Tok::default().to_cc()),
            total_tokens: issuing.map_or(0, |(_, t, _)| t.total()),
            // The issuing message's usage, not this call's own — see
            // `CcGraphNode`. Never sum these.
            tokens_are_rollup: false,
            est_cost_usd: round4(issuing.map_or(0.0, |(_, _, c)| *c)),
            ts: Some(fmt_ts(c.ts)),
            skill: None,
            description: None,
            spawn_depth: None,
            messages: 0,
            tool_calls: 0,
            caller: c.caller.clone(),
        };
        let edge = CcGraphEdge {
            from: match c.agent_id.as_deref() {
                Some(a) => format!("agent:{a}"),
                None => "session".into(),
            },
            to: format!("tool:{}", c.tool_use_id),
        };
        pending.push(Pending {
            ts: c.ts,
            rank: 2,
            node,
            edge,
        });
    }

    // ---- response nodes: one per message that emitted prose ----
    //
    // A flat sibling of that message's tool nodes — same parent, never their
    // parent — carrying the message's own usage, the same numbers those
    // siblings carry. `tokens_are_rollup: false` is what says so; nothing here
    // is summable and no aggregate changes.
    for m in prose.take(limit) {
        let issuing = by_uuid.get(m.uuid.as_str());
        let node = CcGraphNode {
            id: format!("msg:{}", m.uuid),
            kind: CcGraphNodeKind::Response,
            name: "Response".into(),
            target: m.preview.clone(),
            model: Some(m.model.clone()),
            tokens: issuing
                .map(|(_, t, _)| t.to_cc())
                .unwrap_or_else(|| Tok::default().to_cc()),
            total_tokens: issuing.map_or(0, |(_, t, _)| t.total()),
            tokens_are_rollup: false,
            est_cost_usd: round4(issuing.map_or(0.0, |(_, _, c)| *c)),
            ts: Some(fmt_ts(m.ts)),
            skill: None,
            description: None,
            spawn_depth: None,
            messages: 0,
            tool_calls: 0,
            caller: None,
        };
        let edge = CcGraphEdge {
            from: match m.agent_id.as_deref() {
                Some(a) => format!("agent:{a}"),
                None => "session".into(),
            },
            to: format!("msg:{}", m.uuid),
        };
        pending.push(Pending {
            ts: m.ts,
            rank: 1,
            node,
            edge,
        });
    }

    // ---- prompt nodes: one per ingested human turn ----
    //
    // Always a direct child of the root — `cc_prompts` holds main-thread lines
    // only. No model and no usage: a user turn is billed as part of the reply
    // it provokes, so any number here would be invented. `tokens_are_rollup`
    // is nonetheless `true`, which is the flag the UI reads as "this is not
    // one message's usage shared with siblings" and so never prefixes `≈`.
    for p in prompts.iter().take(limit) {
        let node = CcGraphNode {
            id: format!("prompt:{}", p.uuid),
            kind: CcGraphNodeKind::Prompt,
            name: "Prompt".into(),
            target: Some(p.preview.clone()),
            model: None,
            tokens: Tok::default().to_cc(),
            total_tokens: 0,
            tokens_are_rollup: true,
            est_cost_usd: 0.0,
            ts: Some(fmt_ts(p.ts)),
            skill: None,
            description: None,
            spawn_depth: None,
            messages: 0,
            tool_calls: 0,
            caller: None,
        };
        let edge = CcGraphEdge {
            from: "session".into(),
            to: format!("prompt:{}", p.uuid),
        };
        pending.push(Pending {
            ts: p.ts,
            rank: 0,
            node,
            edge,
        });
    }

    pending.sort_by(|a, b| {
        a.ts.cmp(&b.ts)
            .then_with(|| a.rank.cmp(&b.rank))
            .then_with(|| a.node.id.cmp(&b.node.id))
    });
    for p in pending {
        nodes.push(p.node);
        edges.push(p.edge);
    }

    // ---- agent nodes ----
    for r in &runs {
        let t = threads.get(&Some(r.agent_id.clone()));
        let first_ts = messages
            .iter()
            .find(|m| m.agent_id.as_deref() == Some(r.agent_id.as_str()))
            .map(|m| fmt_ts(m.ts));
        nodes.push(CcGraphNode {
            id: format!("agent:{}", r.agent_id),
            kind: CcGraphNodeKind::Agent,
            name: r
                .agent
                .clone()
                .or_else(|| r.skill.clone())
                .unwrap_or_else(|| "subagent".into()),
            target: None,
            model: t.and_then(|t| top_model(&t.models)),
            tokens: t
                .map(|t| t.tok.to_cc())
                .unwrap_or_else(|| Tok::default().to_cc()),
            total_tokens: t.map_or(0, |t| t.tok.total()),
            tokens_are_rollup: true,
            est_cost_usd: round4(t.map_or(0.0, |t| t.cost)),
            ts: first_ts,
            skill: r.skill.clone(),
            description: r.description.clone(),
            spawn_depth: r.spawn_depth,
            messages: t.map_or(0, |t| t.messages),
            tool_calls: t.map_or(0, |t| t.tool_calls),
            caller: None,
        });
        // Parent, in descending order of exactness. `kept_tools` matters:
        // a spawning call is never truncated, so the first arm only misses
        // when the call itself was never ingested.
        let from = match r.tool_use_id.as_deref() {
            Some(tid) if kept_tools.contains(tid) => format!("tool:{tid}"),
            _ => match r.parent_agent_id.as_deref() {
                Some(p) if runs.iter().any(|o| o.agent_id == p) => format!("agent:{p}"),
                _ => "session".into(),
            },
        };
        edges.push(CcGraphEdge {
            from,
            to: format!("agent:{}", r.agent_id),
        });
    }

    // ---- whole-session totals (the only additive numbers here) ----
    let mut all = Tok::default();
    let mut cost = 0.0;
    for t in threads.values() {
        all.input += t.tok.input;
        all.output += t.tok.output;
        all.cache_read += t.tok.cache_read;
        all.cache_creation += t.tok.cache_creation;
        cost += t.cost;
    }

    Ok(Some(CcSessionGraph {
        session_id: session_id.to_string(),
        project: sess.cwd.as_deref().map(short_project),
        cwd: sess.cwd,
        git_branch: sess.git_branch,
        start: sess.start_ts.map(fmt_ts),
        end: sess.end_ts.map(fmt_ts),
        total_tokens: all.total(),
        tokens: all.to_cc(),
        est_cost_usd: round4(cost),
        nodes,
        edges,
        truncated: omitted > 0 || omitted_responses > 0 || omitted_prompts > 0,
        omitted_tool_calls: omitted,
        omitted_responses,
        omitted_prompts,
    }))
}

// ---- session detail (`mesa cc session`, `GET /api/cc/sessions/{id}`) ----

/// Buckets in [`CcSessionDetail::activity`]. Fixed rather than derived from the
/// span so the series is the same width for a 2-minute session and an 8-hour
/// one, which is what lets the frontend draw it without a scale of its own.
pub const ACTIVITY_BUCKETS: usize = 60;

/// One session's exact aggregates. `Ok(None)` when the session was never
/// ingested (mirrors [`session_graph`]).
///
/// Every persisted row is counted — no cap, no truncation flag. That is the
/// point of this being a separate read: the graph's tool nodes are capped, and
/// its tool/response nodes repeat their issuing message's usage, so neither an
/// exact per-tool count nor a token-over-time series can be derived from it.
pub fn session_detail(store: &Store, session_id: &str) -> Result<Option<CcSessionDetail>> {
    let prices = load_prices()?;
    let Some(sess) = store.cc_session(session_id)? else {
        return Ok(None);
    };
    // Usage is per API response, not per transcript line: keep the first row
    // of each response (rows come back `ORDER BY ts, uuid`) and drop its
    // repeats, so every rollup below — threads, models, whole-session totals
    // and the activity series — counts one response once. The call tree
    // (`session_graph`) deliberately does NOT do this: its response nodes are
    // per line.
    let mut seen: HashSet<String> = HashSet::new();
    let messages: Vec<CcMessageRow> = store
        .cc_session_messages(session_id)?
        .into_iter()
        .filter(|m| seen.insert(dedupe_key(m).to_string()))
        .collect();
    let tool_calls = store.cc_session_tool_calls(session_id)?;
    let runs = store.cc_session_agent_runs(session_id)?;

    // ---- per-thread rollups, keyed by agent_id (None = the main thread), the
    // same keying `session_graph` uses ----
    #[derive(Default)]
    struct Thread {
        tok: Tok,
        cost: f64,
        messages: i64,
        tool_calls: i64,
        models: BTreeMap<String, i64>,
        first_ts: Option<i64>,
        last_ts: Option<i64>,
    }
    impl Thread {
        fn touch(&mut self, ts: i64) {
            self.first_ts = Some(self.first_ts.map_or(ts, |t| t.min(ts)));
            self.last_ts = Some(self.last_ts.map_or(ts, |t| t.max(ts)));
        }
    }
    #[derive(Default)]
    struct ModelAcc {
        tok: Tok,
        cost: f64,
        messages: i64,
    }

    let mut threads: BTreeMap<Option<String>, Thread> = BTreeMap::new();
    let mut models: BTreeMap<String, ModelAcc> = BTreeMap::new();
    // name -> (calls, subagent_calls); keyed on the tool NAME alone, never the
    // target, so one Bash row means "Bash", not one row per command.
    let mut tools: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut skills: BTreeMap<String, i64> = BTreeMap::new();

    for m in &messages {
        let cost = row_cost(&prices, m);
        let t = threads.entry(m.agent_id.clone()).or_default();
        t.tok.input += m.input_tokens;
        t.tok.output += m.output_tokens;
        t.tok.cache_read += m.cache_read_tokens;
        t.tok.cache_creation += m.cache_creation_tokens;
        t.cost += cost;
        t.messages += 1;
        *t.models.entry(m.model.clone()).or_insert(0) += 1;
        t.touch(m.ts);

        let a = models.entry(m.model.clone()).or_default();
        a.tok.input += m.input_tokens;
        a.tok.output += m.output_tokens;
        a.tok.cache_read += m.cache_read_tokens;
        a.tok.cache_creation += m.cache_creation_tokens;
        a.cost += cost;
        a.messages += 1;
    }
    for c in &tool_calls {
        let t = threads.entry(c.agent_id.clone()).or_default();
        t.tool_calls += 1;
        t.touch(c.ts);
        let e = tools.entry(c.name.clone()).or_insert((0, 0));
        e.0 += 1;
        if c.agent_id.is_some() {
            e.1 += 1;
        }
        // Same promotion the call tree does: a `Skill` call is named for the
        // skill it ran. A row ingested before migration 22 has no target and so
        // has no name to report — it stays a plain tool row only.
        if c.name == "Skill"
            && let Some(skill) = c.target.as_deref()
        {
            *skills.entry(skill.to_string()).or_insert(0) += 1;
        }
    }

    // A run row supplies a thread's identity; a thread seen only in messages or
    // tool calls still gets an entry, with those fields left None.
    let run_by_id: BTreeMap<&str, &CcAgentRunUpsert> =
        runs.iter().map(|r| (r.agent_id.as_str(), r)).collect();
    for r in &runs {
        threads.entry(Some(r.agent_id.clone())).or_default();
    }

    let stat = |agent_id: Option<&str>, t: Option<&Thread>| {
        let run = agent_id.and_then(|a| run_by_id.get(a));
        CcSessionThreadStat {
            agent_id: agent_id.map(str::to_string),
            agent: run.and_then(|r| r.agent.clone()),
            skill: run.and_then(|r| r.skill.clone()),
            description: run.and_then(|r| r.description.clone()),
            spawn_depth: run.and_then(|r| r.spawn_depth),
            model: t.and_then(|t| top_model(&t.models)),
            messages: t.map_or(0, |t| t.messages),
            tool_calls: t.map_or(0, |t| t.tool_calls),
            tokens: t
                .map(|t| t.tok.to_cc())
                .unwrap_or_else(|| Tok::default().to_cc()),
            total_tokens: t.map_or(0, |t| t.tok.total()),
            est_cost_usd: round4(t.map_or(0.0, |t| t.cost)),
            start: t.and_then(|t| t.first_ts).map(fmt_ts),
            end: t.and_then(|t| t.last_ts).map(fmt_ts),
        }
    };

    let main = stat(None, threads.get(&None));
    let mut agents: Vec<CcSessionThreadStat> = threads
        .iter()
        .filter_map(|(k, t)| k.as_deref().map(|a| stat(Some(a), Some(t))))
        .collect();
    agents.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then_with(|| a.agent_id.cmp(&b.agent_id))
    });

    let mut model_stats: Vec<CcSessionModelStat> = models
        .into_iter()
        .map(|(model, a)| CcSessionModelStat {
            model,
            messages: a.messages,
            tokens: a.tok.to_cc(),
            total_tokens: a.tok.total(),
            est_cost_usd: round4(a.cost),
        })
        .collect();
    model_stats.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then_with(|| a.model.cmp(&b.model))
    });

    let mut tool_stats: Vec<CcSessionToolStat> = tools
        .into_iter()
        .map(|(name, (calls, subagent_calls))| CcSessionToolStat {
            name,
            calls,
            subagent_calls,
        })
        .collect();
    tool_stats.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.name.cmp(&b.name)));

    let mut skill_stats: Vec<CcSessionSkillStat> = skills
        .into_iter()
        .map(|(name, calls)| CcSessionSkillStat { name, calls })
        .collect();
    skill_stats.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.name.cmp(&b.name)));

    // ---- whole-session totals: every thread, the only additive numbers ----
    let mut all = Tok::default();
    let mut cost = 0.0;
    let mut msg_count = 0;
    for t in threads.values() {
        all.input += t.tok.input;
        all.output += t.tok.output;
        all.cache_read += t.tok.cache_read;
        all.cache_creation += t.tok.cache_creation;
        cost += t.cost;
        msg_count += t.messages;
    }

    let activity = activity_series(&sess, &messages, &tool_calls);
    let dur = match (sess.start_ts, sess.end_ts) {
        (Some(s), Some(e)) if e > s => (e - s) as f64 / 60.0,
        _ => 0.0,
    };

    Ok(Some(CcSessionDetail {
        session_id: session_id.to_string(),
        project: sess.cwd.as_deref().map(short_project),
        cwd: sess.cwd,
        git_branch: sess.git_branch,
        entrypoint: sess.entrypoint,
        start: sess.start_ts.map(fmt_ts),
        end: sess.end_ts.map(fmt_ts),
        duration_minutes: round2(dur),
        used_subagent: sess.used_subagent,
        tokens: all.to_cc(),
        total_tokens: all.total(),
        est_cost_usd: round4(cost),
        messages: msg_count,
        tool_calls: tool_calls.len() as i64,
        agent_runs: runs.len() as i64,
        main,
        agents,
        models: model_stats,
        tools: tool_stats,
        skills: skill_stats,
        activity,
    }))
}

/// [`ACTIVITY_BUCKETS`] evenly-sized buckets over `start_ts..=end_ts`, the last
/// one inclusive of `end_ts` so no event is dropped. Zero-activity buckets are
/// still emitted — a flat gap is signal. A session with no known span, or one
/// whose span is a single instant, is exactly one bucket holding everything.
fn activity_series(
    sess: &CcSessionRecord,
    messages: &[CcMessageRow],
    tool_calls: &[CcToolCallRow],
) -> Vec<CcSessionBucket> {
    let span = match (sess.start_ts, sess.end_ts) {
        (Some(s), Some(e)) if e > s => Some((s, e)),
        _ => None,
    };
    let n = if span.is_some() { ACTIVITY_BUCKETS } else { 1 };
    let idx = |ts: i64| match span {
        // Clamped both ways: an event outside the recorded span (a session row
        // whose start/end predates a later ingest) lands in an end bucket
        // rather than being dropped or panicking.
        Some((s, e)) => (((ts - s).max(0) as i128 * n as i128) / (e - s) as i128)
            .clamp(0, n as i128 - 1) as usize,
        None => 0,
    };
    let mut out: Vec<CcSessionBucket> = (0..n)
        .map(|i| CcSessionBucket {
            start: fmt_ts(match span {
                Some((s, e)) => s + ((e - s) * i as i64) / n as i64,
                None => sess.start_ts.or(sess.end_ts).unwrap_or(0),
            }),
            messages: 0,
            tool_calls: 0,
            total_tokens: 0,
            output_tokens: 0,
        })
        .collect();
    for m in messages {
        let b = &mut out[idx(m.ts)];
        b.messages += 1;
        b.total_tokens +=
            m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens;
        b.output_tokens += m.output_tokens;
    }
    for c in tool_calls {
        out[idx(c.ts)].tool_calls += 1;
    }
    out
}

/// The model a thread mostly ran on: most messages, ties broken by name so the
/// answer is stable across runs.
fn top_model(models: &BTreeMap<String, i64>) -> Option<String> {
    models
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(m, _)| m.clone())
}

/// First dash-group of a session UUID — enough to recognise, short enough to
/// sit in a graph node.
fn short_session(session_id: &str) -> String {
    session_id
        .split('-')
        .next()
        .unwrap_or(session_id)
        .to_string()
}

// ---- node full text (`mesa cc text`,
//      `GET /api/cc/sessions/{id}/nodes/{node}/text`) ----

/// One graph node's full, uncapped body, read on demand from the transcript
/// the node came from (task 803).
///
/// **The one read that leaves the db.** Every other dashboard surface answers
/// from `cc_*` alone, and the previews stored there are deliberately bounded
/// and sanitized (`sanitize_capped`, [`TARGET_MAX_CHARS`]) — the whole Bash
/// command, the whole `Write` content, the whole subagent prompt are not in
/// the database and never were. So "show me all of it" has to reopen the
/// `.jsonl`, exactly the carve-out [`live`] already takes.
///
/// The pointer that makes it one file read instead of a scan of thousands is
/// `cc_node_files`, written at ingest from the path the walker already had.
///
/// Errors, deliberately distinct:
/// * `validation` — `"session"` (a thread, not a turn: nothing to show), or an
///   id whose prefix is not one this graph mints.
/// * `not_found` — the id parses but no row in this session backs it.
/// * `unavailable` — the row is there but its transcript is not: no
///   `cc_node_files` pointer, a file since deleted, or a line no longer in it.
///   The code scoped to "depends on something outside mesa".
///
/// The returned `text` is **untrusted model-authored text**, uncapped and
/// unsanitized because raw is the entire point here. Every caller must render
/// it as data, never as instructions and never as markup.
pub fn node_text(store: &Store, session_id: &str, node_id: &str) -> Result<CcNodeText> {
    let target = resolve_node(store, session_id, node_id)?;
    let body = read_node_body(store, session_id, &target)?;
    Ok(CcNodeText {
        node_id: node_id.to_string(),
        kind: target.kind,
        name: target.name,
        model: target.model,
        ts: target.ts,
        text: body,
        format: match target.kind {
            CcGraphNodeKind::Response | CcGraphNodeKind::Prompt => CcNodeTextFormat::Text,
            _ => CcNodeTextFormat::Json,
        },
    })
}

/// What a node id resolved to: which thread's transcript holds it, which
/// identifier to scan that file for, and the metadata the graph would have
/// shown beside it.
struct NodeTarget {
    kind: CcGraphNodeKind,
    name: String,
    model: Option<String>,
    ts: Option<String>,
    /// `""` for the main thread — the `cc_node_files` key.
    agent_id: String,
    /// What to look for in the transcript.
    ident: NodeIdent,
}

/// The identifier [`read_node_body`] scans a transcript line for.
enum NodeIdent {
    /// A line `uuid`, whose assistant prose is the body.
    Message(String),
    /// A line `uuid`, whose human turn is the body.
    Prompt(String),
    /// A `tool_use` block id, whose whole `input` is the body.
    ToolUse(String),
}

/// Parse `node_id` and find the row backing it. Session-scoped reads only —
/// an id from another session is `not_found` here, so a node id can never be
/// used to read across sessions.
fn resolve_node(store: &Store, session_id: &str, node_id: &str) -> Result<NodeTarget> {
    // `session` is a real node kind and a real id — it just has no turn of its
    // own to show, which is a different answer from "no such node".
    if node_id == "session" {
        return Err(Error::Validation(
            "the session node has no text of its own; pick a prompt, response, tool or agent node"
                .into(),
        ));
    }
    let Some((prefix, rest)) = node_id.split_once(':') else {
        return Err(Error::Validation(format!(
            "unknown node id {node_id}: expected one of session, prompt:<uuid>, \
             msg:<uuid>, tool:<tool_use_id>, agent:<agent_id>"
        )));
    };
    match prefix {
        "msg" => {
            let m = store
                .cc_session_messages(session_id)?
                .into_iter()
                .find(|m| m.uuid == rest)
                .ok_or_else(|| {
                    Error::NotFound(format!("no node {node_id} in session {session_id}"))
                })?;
            Ok(NodeTarget {
                kind: CcGraphNodeKind::Response,
                name: "Response".into(),
                model: Some(m.model.clone()),
                ts: Some(fmt_ts(m.ts)),
                agent_id: m.agent_id.clone().unwrap_or_default(),
                ident: NodeIdent::Message(m.uuid),
            })
        }
        "prompt" => {
            let p = store
                .cc_session_prompts(session_id)?
                .into_iter()
                .find(|p| p.uuid == rest)
                .ok_or_else(|| {
                    Error::NotFound(format!("no node {node_id} in session {session_id}"))
                })?;
            Ok(NodeTarget {
                kind: CcGraphNodeKind::Prompt,
                name: "Prompt".into(),
                model: None,
                ts: Some(fmt_ts(p.ts)),
                // `cc_prompts` is main-thread only, by construction.
                agent_id: String::new(),
                ident: NodeIdent::Prompt(p.uuid),
            })
        }
        "tool" => tool_target_node(store, session_id, node_id, rest),
        "agent" => {
            // A subagent's body is the `Task` call that spawned it: the whole
            // prompt it was given. That call is a tool row in the *parent*
            // thread, so this hands off to the tool path rather than opening
            // the subagent's own transcript.
            let run = store
                .cc_session_agent_runs(session_id)?
                .into_iter()
                .find(|r| r.agent_id == rest)
                .ok_or_else(|| {
                    Error::NotFound(format!("no node {node_id} in session {session_id}"))
                })?;
            let tool_use_id = run.tool_use_id.ok_or_else(|| {
                Error::Unavailable(format!(
                    "subagent {rest} has no recorded spawning tool call \
                     (its `.meta.json` sidecar was missing or unreadable)"
                ))
            })?;
            let mut t = tool_target_node(store, session_id, node_id, &tool_use_id)?;
            // Keep the *agent's* identity on the answer — the body is the
            // spawn call, but the node the caller asked about is the run.
            t.kind = CcGraphNodeKind::Agent;
            t.name = run
                .agent
                .or(run.skill)
                .unwrap_or_else(|| format!("agent {rest}"));
            Ok(t)
        }
        _ => Err(Error::Validation(format!(
            "unknown node id {node_id}: expected one of session, prompt:<uuid>, \
             msg:<uuid>, tool:<tool_use_id>, agent:<agent_id>"
        ))),
    }
}

/// The `tool:`-backed half of [`resolve_node`], shared by a tool/skill node
/// and by the agent node that borrows its spawning call.
fn tool_target_node(
    store: &Store,
    session_id: &str,
    node_id: &str,
    tool_use_id: &str,
) -> Result<NodeTarget> {
    let c = store
        .cc_session_tool_calls(session_id)?
        .into_iter()
        .find(|c| c.tool_use_id == tool_use_id)
        .ok_or_else(|| Error::NotFound(format!("no node {node_id} in session {session_id}")))?;
    // Same promotion rule as the graph: a `Skill` call is its own kind,
    // labelled with the skill rather than the word "Skill".
    let is_skill = c.name == "Skill" && c.target.is_some();
    Ok(NodeTarget {
        kind: if is_skill {
            CcGraphNodeKind::Skill
        } else {
            CcGraphNodeKind::Tool
        },
        name: if is_skill {
            c.target.clone().unwrap_or_default()
        } else {
            c.name.clone()
        },
        model: None,
        ts: Some(fmt_ts(c.ts)),
        agent_id: c.agent_id.clone().unwrap_or_default(),
        ident: NodeIdent::ToolUse(c.tool_use_id),
    })
}

/// Open the transcript this thread was read from and pull the full body out.
///
/// Two files may be tried: the thread's own pointer, then the session's
/// main-thread pointer. The fallback covers a row whose thread predates
/// `cc_node_files` (or whose file moved) while the session's main transcript
/// is still on disk — cheap, bounded at two reads, and it can only ever widen
/// what resolves, never what is allowed.
fn read_node_body(store: &Store, session_id: &str, target: &NodeTarget) -> Result<String> {
    let mut tried: Vec<String> = Vec::new();
    for agent_id in [target.agent_id.as_str(), ""] {
        if tried.iter().any(|a| a == agent_id) {
            continue;
        }
        tried.push(agent_id.to_string());
        let Some(path) = store.cc_node_file(session_id, agent_id)? else {
            continue;
        };
        let path = transcript_path(&path)?;
        let Ok(bytes) = fs::read(&path) else { continue };
        if let Some(body) = scan_for_body(&bytes, &target.ident) {
            return Ok(body);
        }
    }
    Err(Error::Unavailable(format!(
        "the transcript backing this node is no longer readable \
         (session {session_id}); Claude Code may have deleted it"
    )))
}

/// The sole chokepoint for turning a stored `cc_node_files.path` into a file
/// mesa will open. A path is a *cursor-era observation*, not a capability: it
/// is whatever the walker recorded, under whatever `MESA_CC_PROJECTS_DIR` /
/// `CLAUDE_CONFIG_DIR` was set at the time. Anything that does not canonicalize
/// to a descendant of the CURRENT [`projects_dir`] is refused rather than read
/// — the same posture as `files::safe_path`, and the reason this route cannot
/// be turned into an arbitrary-file reader by a doctored row.
fn transcript_path(stored: &str) -> Result<PathBuf> {
    let root = projects_dir()
        .and_then(|r| fs::canonicalize(r).ok())
        .ok_or_else(|| Error::Unavailable("no readable Claude Code transcript directory".into()))?;
    let candidate = fs::canonicalize(stored)
        .map_err(|_| Error::Unavailable(format!("transcript {stored} is no longer on disk")))?;
    if !candidate.starts_with(&root) {
        return Err(Error::Validation(format!(
            "refusing to read {stored}: outside the transcript directory"
        )));
    }
    Ok(candidate)
}

/// Scan a transcript's bytes line by line for `ident` and return the full
/// body. Line-at-a-time and short-circuiting: a transcript runs to tens of
/// megabytes, and only one of its lines matters.
fn scan_for_body(bytes: &[u8], ident: &NodeIdent) -> Option<String> {
    for line in bytes.split(|&b| b == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Cheap pre-filter: the identifier is a literal substring of any line
        // that could match, so the JSON parse (the expensive half) only runs
        // on the handful of lines that mention it.
        let needle = match ident {
            NodeIdent::Message(u) | NodeIdent::Prompt(u) => u,
            NodeIdent::ToolUse(t) => t,
        };
        if !line.contains(needle.as_str()) {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawLine>(line) else {
            continue;
        };
        match ident {
            NodeIdent::Message(uuid) => {
                if raw.uuid.as_deref() != Some(uuid.as_str()) {
                    continue;
                }
                if let Some(t) = raw.message.as_ref().and_then(|m| m.assistant_text_raw()) {
                    return Some(t);
                }
            }
            NodeIdent::Prompt(uuid) => {
                if raw.uuid.as_deref() != Some(uuid.as_str()) {
                    continue;
                }
                if let Some(t) = human_prompt_raw(&raw) {
                    return Some(t);
                }
            }
            NodeIdent::ToolUse(id) => {
                let Some(content) = raw.message.as_ref().and_then(|m| m.content.as_ref()) else {
                    continue;
                };
                let Some(blocks) = content.as_array() else {
                    continue;
                };
                for b in blocks {
                    if b.get("id").and_then(|i| i.as_str()) != Some(id.as_str()) {
                        continue;
                    }
                    let input = b.get("input")?;
                    // The whole payload, pretty-printed: this is the payoff —
                    // the entire Bash command, the entire `Write` content, the
                    // entire `Task` prompt, none of which is in the db.
                    return serde_json::to_string_pretty(input).ok();
                }
            }
        }
    }
    None
}

// ---- session chat (the Agent sidebar's rendered view, task 814) ----

/// Default cap on the turns one [`session_chat`] call returns, newest kept.
pub const CHAT_TURN_LIMIT: usize = 200;

/// How much of a transcript's **tail** [`session_chat`] parses. A transcript
/// reaches tens of megabytes (21 MB, measured on the real corpus) and this
/// read is a 3-second poll behind an open chat pane, so parsing whole files
/// would burn CPU proportional to session age on every tick. A window bounds
/// that cost by *bytes read* — which is the cost — where the turn limit alone
/// could not: dropping turns after parsing them saves nothing.
///
/// **On a long session this, not `CHAT_TURN_LIMIT`, is the operative bound**,
/// and by a wide margin: transcript bytes are dominated by tool *results*,
/// which produce no turn at all. Measured over the six largest real
/// transcripts (21.2 down to 8.2 MB), 2 MiB yielded 18-84 turns — never
/// close to 200. So the chat view shows roughly the last few dozen exchanges
/// of a long session whatever `limit` says, and `truncated` is how it admits
/// that. Reading back by turn count instead would mean reading most of a 21 MB
/// file on every 3-second tick, which is the cost this exists to avoid.
/// A transcript smaller than this is read whole and `truncated` is false.
const CHAT_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// The ceiling [`read_tail`] will grow its window to when the window lands
/// *inside a single line*. One transcript line can itself be megabytes (a
/// large tool result; the real corpus holds a 2.59 MB one), and a window
/// holding no complete line yields no turns at all — a blank chat pane for a
/// session that is talking perfectly well. Above every transcript observed
/// (21.2 MB), so in practice this means "read the whole file rather than
/// answer nothing"; it is a bound, not a budget, and only a pathological tail
/// ever reaches it.
const CHAT_TAIL_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// One session's conversation, read **live from its transcript file** rather
/// than from the `cc_*` tables (task 814) — one of the four reads to do so,
/// beside [`live`], [`node_text`] and [`session_pulse`], and for two of their
/// reasons at once:
/// the newest turns of a running session are younger than any ingest, and the
/// bodies a chat window renders were deliberately never stored (a stored
/// preview is 200 sanitized characters).
///
/// Consequently it takes no [`Store`] and runs no [`sync`] — a full tree walk
/// under the API's store lock is not something a poll may do — and it answers
/// for a session mesa spawned moments ago that has never been ingested.
///
/// `session_id` is caller input and is used to *build* a path, so it is
/// validated to the id charset first ([`Error::Validation`]) and the result
/// still goes through [`transcript_path`]. A session with no transcript on
/// disk is [`Error::Unavailable`] — the code already scoped to "the row is
/// fine, the Claude-Code-managed file is not".
///
/// Turns come out in **file order**, which is chronological: a transcript is
/// append-only. Within one assistant line the prose is emitted before that
/// line's tool calls — the same `response`-before-`tool` rule
/// [`session_graph`] applies at an equal timestamp.
pub fn session_chat(session_id: &str, limit: usize) -> Result<CcSessionChat> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::Validation(format!("not a session id: {session_id}")));
    }
    let path = find_transcript(session_id).ok_or_else(|| {
        Error::Unavailable(format!("no transcript on disk for session {session_id}"))
    })?;
    let path = transcript_path(&path.to_string_lossy())?;
    let (text, windowed) = read_tail(&path, CHAT_TAIL_BYTES)?;

    let mut turns = chat_turns(&text);
    let pending_question = pending_ask(&text);
    let dropped = turns.len().saturating_sub(limit);
    if dropped > 0 {
        turns.drain(..dropped);
    }
    Ok(CcSessionChat {
        session_id: session_id.to_string(),
        turns,
        truncated: windowed || dropped > 0,
        pending_question,
    })
}

/// The `AskUserQuestion` call this window ends on **unanswered**, if any (task
/// 866) — the one thing in a chat pane a reader can act on rather than watch.
///
/// A call is answered when a later line carries a `tool_result` for its
/// `tool_use_id`; the *last* unanswered one wins, because a session asks one
/// question at a time and everything before it is history. Read from the same
/// window the turns are, so a question older than the window is not offered —
/// which is right: a client that answered it would be typing at a chooser
/// that closed long ago.
///
/// Both the labels and the questions are model-authored text bound for a
/// button, so each goes through [`sanitize_capped`] exactly as a tool target
/// does. The tool's `preview` is dropped: it is unbounded, and this payload is
/// a 3-second poll.
fn pending_ask(text: &str) -> Option<CcChatAsk> {
    let mut asked: Vec<CcChatAsk> = Vec::new();
    let mut answered: HashSet<String> = HashSet::new();
    for line in text.lines() {
        let Ok(raw) = serde_json::from_str::<RawLine>(line.trim()) else {
            continue;
        };
        if raw.is_sidechain == Some(true) {
            continue;
        }
        let Some(blocks) = raw
            .message
            .as_ref()
            .and_then(|m| m.content.as_ref())
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("tool_result") => {
                    if let Some(id) = b.get("tool_use_id").and_then(|i| i.as_str()) {
                        answered.insert(id.to_string());
                    }
                }
                Some("tool_use") if b.get("name").and_then(|n| n.as_str()) == Some(ASK_TOOL) => {
                    let (Some(id), Some(questions)) = (
                        b.get("id").and_then(|i| i.as_str()),
                        b.get("input")
                            .and_then(|i| i.get("questions"))
                            .and_then(|q| q.as_array()),
                    ) else {
                        continue;
                    };
                    asked.push(CcChatAsk {
                        id: id.to_string(),
                        questions: questions.iter().map(chat_question).collect(),
                    });
                }
                _ => {}
            }
        }
    }
    asked
        .into_iter()
        .filter(|a| !answered.contains(&a.id))
        // A call with nothing to click is not something a reader can answer.
        .rfind(|a| a.questions.iter().any(|q| !q.options.is_empty()))
}

/// The tool a session asks its multiple-choice questions with. Named once:
/// the name is Claude Code's, not mesa's, and this is the only place mesa
/// reads one tool by name.
const ASK_TOOL: &str = "AskUserQuestion";

/// One `questions[]` entry of an [`ASK_TOOL`] input, leniently — a field this
/// build does not find becomes empty rather than dropping the question, the
/// same rule the rest of this parser follows.
fn chat_question(raw: &serde_json::Value) -> CcChatQuestion {
    let field = |key: &str| {
        raw.get(key)
            .and_then(|v| v.as_str())
            .and_then(sanitize_capped)
            .unwrap_or_default()
    };
    CcChatQuestion {
        question: field("question"),
        header: field("header"),
        multi_select: raw
            .get("multiSelect")
            .and_then(|m| m.as_bool())
            .unwrap_or(false),
        options: raw
            .get("options")
            .and_then(|o| o.as_array())
            .map(|options| {
                options
                    .iter()
                    .filter_map(|o| {
                        let label = o.get("label").and_then(|l| l.as_str())?;
                        Some(CcChatOption {
                            // An option with no label is nothing a reader
                            // could recognise, so it is dropped rather than
                            // rendered as a blank button.
                            label: sanitize_capped(label)?,
                            description: o
                                .get("description")
                                .and_then(|d| d.as_str())
                                .and_then(sanitize_capped)
                                .unwrap_or_default(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Fold one transcript's text into ordered chat turns. Split out from
/// [`session_chat`] so the whole line-classification policy — which lines are
/// a human turn, which are the assistant's, which are neither — is unit
/// testable against literal transcript lines rather than only through a file.
fn chat_turns(text: &str) -> Vec<CcChatTurn> {
    let mut turns: Vec<CcChatTurn> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawLine>(line) else {
            continue;
        };
        // A subagent's turns belong to its own transcript and its own reader;
        // the same main-thread-only rule `cc_prompts` keeps. (Sidechain lines
        // are not written to this file, so this is a guard, not a filter.)
        if raw.is_sidechain == Some(true) {
            continue;
        }
        let Some(uuid) = raw.uuid.clone() else {
            continue;
        };
        if let Some(text) = human_prompt_raw(&raw) {
            turns.push(CcChatTurn {
                id: uuid,
                kind: CcChatTurnKind::Prompt,
                ts: raw.timestamp.clone(),
                model: None,
                name: None,
                text,
            });
            continue;
        }
        // Assistant turns are read off `type` rather than off the shape of
        // `message`, which is not enough on its own: Claude Code writes its
        // own injections (a skill body, hook output, a caveat banner) as
        // `user` lines whose content is an array of `text` blocks — exactly
        // what `assistant_text_raw` reads — so a shape test alone renders an
        // injected skill body as something the assistant said.
        if raw.kind.as_deref() != Some("assistant") {
            continue;
        }
        let Some(msg) = raw.message.as_ref() else {
            continue;
        };
        if let Some(text) = msg.assistant_text_raw() {
            turns.push(CcChatTurn {
                id: uuid,
                kind: CcChatTurnKind::Response,
                ts: raw.timestamp.clone(),
                model: msg.model.clone(),
                name: None,
                text,
            });
        }
        for (id, name, _caller, target) in msg.tool_uses() {
            turns.push(CcChatTurn {
                id,
                kind: CcChatTurnKind::Tool,
                ts: raw.timestamp.clone(),
                model: None,
                name: Some(name),
                // Bounded on purpose: a chat row says *that* a call happened
                // and what it acted on. The whole input is `cc text`'s job.
                text: target.unwrap_or_default(),
            });
        }
    }
    turns
}

/// The tail [`session_pulse`] reads — two orders of magnitude under
/// [`CHAT_TAIL_BYTES`] on purpose. The chat window backs **one** open pane;
/// the pulse runs for **every** session in the agents list on every poll of
/// it, so its cost is multiplied by the session count and paid again every
/// couple of seconds. All it has to find is the newest assistant line, which
/// on a live session is within a few KB of EOF; 256 KiB is slack for a tail
/// full of large tool results, not a budget it expects to spend.
const PULSE_TAIL_BYTES: u64 = 256 * 1024;

/// What one running session is saying and how full its context is — the two
/// mesa-derived fields the Agents sidebar row shows (task 869).
#[derive(Debug, Default, PartialEq)]
pub struct SessionPulse {
    /// The assistant's newest prose, sanitized and capped by
    /// [`sanitize_capped`].
    pub last_response: Option<String>,
    /// The newest assistant message's occupied context window.
    pub context_tokens: Option<i64>,
}

/// One session's pulse, read **live off its transcript** — the fourth read to
/// go to the files rather than the `cc_*` tables, beside [`live`],
/// [`node_text`] and [`session_chat`], and for [`live`]'s reason: what a
/// session said seconds ago is younger than any ingest, and this backs a
/// 3-second poll on a *running* session.
///
/// **Fails open in every direction** — an unknown session, no transcript on
/// disk, an unreadable file, a window holding no assistant line and a session
/// that has never carried usage all answer an all-`None` [`SessionPulse`],
/// never an error. It hangs off the agents endpoints and off the list the
/// todo watcher reads: neither may be turned into a failure by a missing file.
pub fn session_pulse(session_id: &str) -> SessionPulse {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return SessionPulse::default();
    }
    let Some(path) = find_transcript(session_id) else {
        return SessionPulse::default();
    };
    let Ok((text, _)) = read_tail(&path, PULSE_TAIL_BYTES) else {
        return SessionPulse::default();
    };
    pulse_from_text(&text)
}

/// Pure half of [`session_pulse`]: fold a transcript window into the newest
/// assistant prose and the newest occupied context. Split out so the
/// line-classification rule is unit-testable against literal lines, like
/// [`chat_turns`].
///
/// The two answers come from **independently** chosen lines: a session's
/// newest message is routinely a tool call, which carries usage but no prose,
/// while the reply before it carries the prose. Taking both off one line would
/// blank whichever half that line lacks.
///
/// "Assistant" is [`chat_turns`]' rule exactly — `type == "assistant"` plus
/// [`RawMessage::assistant_text_raw`] — because Claude Code writes its own
/// injections (hook output, a skill body, a caveat banner) as `user` lines
/// whose content is an array of `text` blocks, and a shape test alone would
/// report one of those as something the agent said.
fn pulse_from_text(text: &str) -> SessionPulse {
    let mut pulse = SessionPulse::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawLine>(line) else {
            continue;
        };
        // A subagent's turns are its own; the same main-thread-only rule
        // `chat_turns` keeps.
        if raw.is_sidechain == Some(true) || raw.kind.as_deref() != Some("assistant") {
            continue;
        }
        let Some(msg) = raw.message.as_ref() else {
            continue;
        };
        if let Some(prose) = msg.assistant_text() {
            pulse.last_response = Some(prose);
        }
        if let Some(u) = msg.usage.as_ref() {
            // Input side only: the context window is the size of the newest
            // request, not of the whole conversation and not of the reply.
            pulse.context_tokens =
                Some(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens);
        }
    }
    pulse
}

/// The main-thread transcript of `session_id`: `<projects_dir>/*/<id>.jsonl`.
///
/// The project slug is unknown here — it encodes the session's cwd, which the
/// caller does not hold — so every slug directory is probed for the file, the
/// same shape `agents::live_subagents` uses for the same reason. It is one
/// `stat` per slug directory (98 on the real corpus), not a tree walk.
fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let root = projects_dir()?;
    let file = format!("{session_id}.jsonl");
    for entry in fs::read_dir(&root).ok()?.flatten() {
        let candidate = entry.path().join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The last `window` bytes of `path` as text, plus whether the window
/// actually cut anything. A cut lands mid-line, so the first (partial) line is
/// dropped — losing at most one turn that a caller was told is truncated
/// anyway. Lossy UTF-8 for the same reason the parsers elsewhere are lenient:
/// one bad byte must not blank a whole conversation.
///
/// The window is a parameter because its two callers have opposite budgets:
/// [`session_chat`] backs one open pane and asks for [`CHAT_TAIL_BYTES`],
/// while [`session_pulse`] runs for every listed session on every poll and
/// asks for [`PULSE_TAIL_BYTES`].
fn read_tail(path: &Path, mut window: u64) -> Result<(String, bool)> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let read_all = |f: &mut fs::File| -> Result<(String, bool)> {
        let mut buf = Vec::with_capacity(len as usize);
        f.seek(SeekFrom::Start(0))?;
        f.read_to_end(&mut buf)?;
        Ok((String::from_utf8_lossy(&buf).into_owned(), false))
    };
    // `buf` holds the bytes from `have_from` to EOF, and **grows downward**:
    // widening reads only the newly exposed prefix and prepends it, never the
    // whole window again. This is a poll, and the widening case is by
    // definition the one with megabyte lines in it — re-reading from scratch
    // would make 2+8+32 MiB of I/O out of what should be 32.
    let mut buf: Vec<u8> = Vec::new();
    let mut have_from = len;
    loop {
        if len <= window + 1 {
            return read_all(&mut f);
        }
        // Start one byte EARLY, so the buffer opens with the byte preceding
        // the window. That byte is the whole difference between "the cut
        // landed mid-line" and "the cut landed exactly on a line start":
        // without it a boundary that happens to fall on a newline discards a
        // line that was complete, which `truncated` then reports as if it were
        // the ordinary partial-line loss.
        let from = len - window - 1;
        let mut head = Vec::with_capacity((have_from - from) as usize);
        f.seek(SeekFrom::Start(from))?;
        // `take` rather than an exact read: a transcript only ever grows, but
        // a rotation between the `metadata` above and this read must degrade
        // to a short answer, not to a 500.
        std::io::Read::by_ref(&mut f)
            .take(have_from - from)
            .read_to_end(&mut head)?;
        head.extend_from_slice(&buf);
        buf = head;
        have_from = from;

        let start = buf
            .iter()
            .position(|&b| b == b'\n')
            .map_or(buf.len(), |i| i + 1);
        if start < buf.len() || window >= CHAT_TAIL_MAX_BYTES {
            return Ok((String::from_utf8_lossy(&buf[start..]).into_owned(), true));
        }
        // The window fell entirely inside one line, so it holds no complete
        // line and parsing it would answer "this session has said nothing".
        // Widen and retry rather than return that.
        window = window.saturating_mul(4).min(CHAT_TAIL_MAX_BYTES);
    }
}

// ---- small helpers ----

/// What a persisted message row is counted *under* when summing usage: its
/// `message.id` (one billed API response, however many transcript lines it was
/// written as), falling back to the per-line `uuid` for a row ingested before
/// migration 29 or a line that genuinely carries no `message.id`. The fallback
/// is what makes the rule lossless — such a row is counted exactly once, never
/// dropped.
fn dedupe_key(m: &CcMessageRow) -> &str {
    m.message_id.as_deref().unwrap_or(&m.uuid)
}

/// The two windows whose start mesa cannot compute from the clock: the
/// currently-open Claude Code **subscription** windows, the same 5-hour and
/// 7-day limits the Subscription card reports. Their cutoff is that window's
/// `resets_at` minus its fixed length, which only the live usage endpoint
/// knows — so a caller resolves it with [`usage_window_start`] and hands it to
/// [`collect_since`]. Nothing else about the dashboard changes: the cutoff is
/// still one Unix second, merely not a midnight.
pub const USAGE_WINDOWS: [&str; 2] = ["cc-5h", "cc-7d"];

/// Refuse a [`USAGE_WINDOWS`] token on an entry point that derives its own
/// cutoff: there is nothing to derive it from, and falling through would serve
/// the 30-day default under a `cc-5h` label. Callers with a snapshot use
/// [`collect_since`] / [`collect_for_project_since`] instead.
fn reject_usage_window(window: &str) -> Result<()> {
    if is_usage_window(window) {
        return Err(Error::Validation(format!(
            "window {window} needs a live usage snapshot; use collect_since"
        )));
    }
    Ok(())
}

/// True iff `window` names one of [`USAGE_WINDOWS`].
pub fn is_usage_window(window: &str) -> bool {
    USAGE_WINDOWS.iter().any(|w| window.eq_ignore_ascii_case(w))
}

/// Start (Unix seconds) of the open subscription window `window` names, read
/// off a usage snapshot: `resets_at` minus the window's fixed length. `None`
/// when `window` is not one of [`USAGE_WINDOWS`], or the snapshot carries no
/// such window / no reset time — there is then no open window to scope to, and
/// the caller reports `unavailable` rather than inventing a cutoff. Pure: the
/// fetch, and the cache in front of it, belong to the caller.
pub fn usage_window_start(window: &str, usage: &CcUsage) -> Option<i64> {
    let (w, len) = if window.eq_ignore_ascii_case("cc-5h") {
        (usage.five_hour.as_ref(), 5 * 3_600)
    } else if window.eq_ignore_ascii_case("cc-7d") {
        (usage.seven_day.as_ref(), 7 * 86_400)
    } else {
        return None;
    };
    parse_ts(w?.resets_at.as_deref()?).map(|resets| resets - len)
}

/// UTC-midnight cutoff for `window`: `<n>d` is **n calendar days ending
/// today**, i.e. midnight of `today - (n - 1)`, so `since` is the true
/// inclusive first day and `active_days <= n`. (Subtracting n days would make
/// `7d` span 8 dates.) `all` has no cutoff.
fn window_cutoff(window: &str, now: i64) -> Option<i64> {
    window_days(window).map(|d| (now.div_euclid(86_400) - (d - 1)) * 86_400)
}

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
pub(crate) fn projects_dir() -> Option<PathBuf> {
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
        let builtin = PriceTable::builtin();
        // Opus: $5 in + $25 out per Mtok = $30.
        assert!((estimate_cost(&builtin, "claude-opus-4-8", &u) - 30.0).abs() < 1e-9);
        // Unknown / synthetic: zero.
        assert_eq!(estimate_cost(&builtin, "<synthetic>", &u), 0.0);

        // …and a configured override moves the number, with no rebuild — the
        // whole point of mesa task 692.
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"pricing": {"claude-opus": {"input": 1, "output": 2,
                                            "cache_read": 0, "cache_write": 0}}}"#,
        )
        .unwrap();
        unsafe { std::env::set_var("MESA_CONFIG_FILE", &path) };
        let configured = PriceTable::load().unwrap();
        // Point the seam back at a path that doesn't exist rather than unsetting
        // it: the api tests rely on MESA_CONFIG_FILE staying set to "no file".
        unsafe { std::env::set_var("MESA_CONFIG_FILE", dir.path().join("gone.json")) };
        assert!((estimate_cost(&configured, "claude-opus-4-8", &u) - 3.0).abs() < 1e-9);
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
                    Some(r#"{"type":"direct"}"#.to_string()),
                    // The one scalar lifted out of `input`.
                    Some("ls".to_string()),
                ),
                (
                    "tu2".to_string(),
                    "Skill".to_string(),
                    Some("direct".to_string()),
                    // No `input` at all: absent, not an error.
                    None,
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
    fn one_api_response_written_as_several_lines_is_counted_once() {
        // task 693: Claude Code writes one API response as several transcript
        // lines (thinking, then text/tool_use), each repeating the identical
        // `message.usage`. Rows stay per line; usage is summed once per
        // `message.id`. The advisor turn nested in that usage is NOT a
        // duplicate — it is real, separately billed tokens and must survive.
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        let usage = r#""usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40,"iterations":[{"type":"advisor_message","model":"claude-opus-4-8","input_tokens":1000,"output_tokens":2000}]}"#;
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                &format!(
                    r#"{{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/w","message":{{"id":"msg_A","model":"claude-sonnet-5","content":[{{"type":"text","text":"thinking out loud"}}],{usage}}}}}"#
                ),
                &format!(
                    r#"{{"type":"assistant","uuid":"u2","sessionId":"s1","timestamp":"2026-06-15T01:00:01.000Z","cwd":"/w","message":{{"id":"msg_A","model":"claude-sonnet-5","content":[{{"type":"text","text":"hi"}}],{usage}}}}}"#
                ),
                // A second, genuinely distinct response.
                r#"{"type":"assistant","uuid":"u3","sessionId":"s1","timestamp":"2026-06-15T01:00:02.000Z","cwd":"/w","message":{"id":"msg_B","model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":2}}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        // Rows are per line and untouched: 3 events + 2 advisor rows.
        assert_eq!(q::<i64>(&db, "SELECT COUNT(*) FROM cc_messages"), 5);
        assert_eq!(
            q::<String>(&db, "SELECT message_id FROM cc_messages WHERE uuid = 'u2'"),
            "msg_A"
        );
        // The advisor row's key is its own, derived from the parent's
        // `message.id` — so the copy on each line collapses to one, but it is
        // never mistaken for the wrapper turn.
        assert_eq!(
            q::<String>(
                &db,
                "SELECT message_id FROM cc_messages WHERE uuid = 'u1:advisor:0'"
            ),
            "msg_A:advisor:0"
        );

        let d = collect(&store, "all").unwrap();
        // msg_A once + msg_B once + the advisor turn once = 3 messages.
        assert_eq!(d.overview.messages, 3);
        assert_eq!(d.overview.tokens.input, 10 + 1 + 1000);
        assert_eq!(d.overview.tokens.output, 20 + 2 + 2000);
        assert_eq!(d.overview.tokens.cache_read, 30);
        assert_eq!(d.overview.tokens.cache_creation, 40);
        assert_eq!(d.sessions[0].messages, 3);
        assert_eq!(
            d.agents
                .iter()
                .find(|a| a.agent == "advisor")
                .unwrap()
                .tokens
                .output,
            2000
        );

        // The session detail page sums the same way.
        let det = session_detail(&store, "s1").unwrap().unwrap();
        assert_eq!(det.messages, 3);
        assert_eq!(det.tokens.input, 10 + 1 + 1000);
        assert_eq!(det.total_tokens, d.overview.total_tokens);
        // …while the call tree still draws one response node per line.
        let g = session_graph(&store, "s1", 100).unwrap().unwrap();
        assert_eq!(
            g.nodes
                .iter()
                .filter(|n| n.kind == CcGraphNodeKind::Response)
                .count(),
            2
        );
    }

    #[test]
    fn window_of_n_days_covers_n_calendar_days_ending_today() {
        // task 693: `7d` used to floor `now - 7*86400` to midnight, i.e. days
        // t-7..t inclusive = EIGHT dates.
        let day: i64 = 86_400;
        let now: i64 = 1_800_000_000; // arbitrary; only the date floor matters
        let today = now.div_euclid(day) * day;
        assert_eq!(window_cutoff("7d", now), Some(today - 6 * day));
        assert_eq!(window_cutoff("1d", now), Some(today));
        assert_eq!(window_cutoff("30d", now), Some(today - 29 * day));
        assert_eq!(window_cutoff("all", now), None);
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

        // A subscription window is the same aggregation over a caller-supplied
        // cutoff: two minutes ago keeps only the recent message, and asking for
        // one without that cutoff is an error rather than a silent 30-day
        // dashboard wearing a `cc-5h` label.
        let open = collect_since(&store, "cc-5h", now_unix() - 120).unwrap();
        assert_eq!(open.window, "cc-5h");
        assert_eq!(open.overview.sessions, 1);
        assert_eq!(open.overview.messages, 1);
        assert_eq!(open.overview.total_tokens, 11);
        assert!(matches!(
            collect(&store, "cc-5h"),
            Err(Error::Validation(_))
        ));
        // Including the project-scoped zero-state shortcut, which returns
        // before `collect_inner` would have caught it.
        assert!(matches!(
            collect_for_project(&store, "cc-7d", None),
            Err(Error::Validation(_))
        ));
    }

    #[test]
    fn a_subscription_window_starts_its_reset_time_minus_its_length() {
        use super::super::types::CcUsageWindow;
        let win = |resets: &str| CcUsageWindow {
            utilization: 0.0,
            resets_at: Some(resets.to_string()),
        };
        let usage = CcUsage {
            five_hour: Some(win("2026-08-19T17:20:00.468279+00:00")),
            seven_day: Some(win("2026-08-21T13:00:00.468304+00:00")),
            seven_day_opus: None,
            seven_day_sonnet: None,
            extra_usage: None,
            plan_tier: None,
            fetched_at_unix: 0,
        };
        // The endpoint reports when the window closes; its length is fixed by
        // the plan, so the open window started that much earlier.
        assert_eq!(
            usage_window_start("cc-5h", &usage),
            parse_ts("2026-08-19T12:20:00Z")
        );
        assert_eq!(
            usage_window_start("cc-7d", &usage),
            parse_ts("2026-08-14T13:00:00Z")
        );
        // Not a subscription token, and a snapshot with nothing open: both
        // `None`, which is what makes the caller say `unavailable` instead of
        // inventing a cutoff.
        assert_eq!(usage_window_start("30d", &usage), None);
        assert!(is_usage_window("cc-5h") && is_usage_window("CC-7D"));
        assert!(!is_usage_window("7d"));
        let empty = CcUsage {
            five_hour: None,
            seven_day: Some(CcUsageWindow {
                utilization: 0.0,
                resets_at: None,
            }),
            seven_day_opus: None,
            seven_day_sonnet: None,
            extra_usage: None,
            plan_tier: None,
            fetched_at_unix: 0,
        };
        assert_eq!(usage_window_start("cc-5h", &empty), None);
        assert_eq!(usage_window_start("cc-7d", &empty), None);
    }

    // ---- tool targets (task 583) ----

    fn target(json: &str) -> Option<String> {
        tool_target(&serde_json::from_str(json).unwrap())
    }

    #[test]
    fn tool_target_picks_the_key_that_says_what_the_call_did() {
        // The shapes actually observed across 52k real calls.
        // `command` beats `description`: Bash carries both.
        assert_eq!(
            target(r#"{"command":"git status","description":"check"}"#).as_deref(),
            Some("git status")
        );
        assert_eq!(
            target(r#"{"file_path":"/a/b/cc.rs","limit":20}"#).as_deref(),
            Some("/a/b/cc.rs")
        );
        assert_eq!(
            target(r#"{"skill":"inaros-swe:refine","args":"583"}"#).as_deref(),
            Some("inaros-swe:refine")
        );
        assert_eq!(
            target(r#"{"url":"https://x.dev","prompt":"summarize"}"#).as_deref(),
            Some("https://x.dev")
        );
        // Agent: the one-line description, never the prompt.
        assert_eq!(
            target(r#"{"description":"hunt bugs","prompt":"...","subagent_type":"guru"}"#)
                .as_deref(),
            Some("hunt bugs")
        );
        // TaskCreate's pair.
        assert_eq!(
            target(r#"{"subject":"ship it","description":"longer"}"#).as_deref(),
            Some("ship it")
        );

        // No known key -> None, rather than an arbitrary field. `advisor`
        // sends `{}`; StructuredOutput sends a caller-defined payload.
        assert_eq!(target(r#"{}"#), None);
        assert_eq!(target(r#"{"refuted":true,"evidence":"..."}"#), None);
        // Bulk payloads are not keys, so a Write is its path, never its file.
        assert_eq!(
            target(r#"{"file_path":"/a/b.txt","content":"...500KB..."}"#).as_deref(),
            Some("/a/b.txt")
        );
        assert_eq!(target(r#"{"prompt":"a very long prompt"}"#), None);

        // Non-object inputs: unparsed, a bare string, a list, null. The first
        // of these is a shape real `Read` calls actually arrive in.
        assert_eq!(
            target(r#"{"__unparsedToolInput":"Read(file_path: \"/a\")"}"#),
            None
        );
        assert_eq!(target(r#""just a string""#), None);
        assert_eq!(target(r#"[1,2]"#), None);
        assert_eq!(target("null"), None);
        // A non-string value under a known key is skipped, not stringified.
        assert_eq!(target(r#"{"command":42}"#), None);
        // Blank/whitespace-only collapses to nothing, and nothing is `None`.
        assert_eq!(target(r#"{"command":"   \n  "}"#), None);
    }

    #[test]
    fn tool_target_sanitizes_and_caps() {
        // A heredoc is one row: newlines and tabs collapse so a stored target
        // can never span lines or move a cursor when the JSON is catted.
        assert_eq!(
            target("{\"command\":\"python3 - <<'PY'\\n\\tprint(1)\\nPY\"}").as_deref(),
            Some("python3 - <<'PY' print(1) PY")
        );
        // Control characters are dropped outright (here: a bare ESC).
        assert_eq!(
            target("{\"command\":\"echo \\u001b[31mred\"}").as_deref(),
            Some("echo [31mred")
        );

        // Over the cap: exactly TARGET_MAX_CHARS kept, plus one ellipsis.
        let long = "x".repeat(TARGET_MAX_CHARS + 50);
        let got = target(&format!(r#"{{"command":"{long}"}}"#)).unwrap();
        assert_eq!(got.chars().count(), TARGET_MAX_CHARS + 1);
        assert!(got.ends_with('…'));
        // At the cap exactly: kept whole, no ellipsis.
        let exact = "y".repeat(TARGET_MAX_CHARS);
        let got = target(&format!(r#"{{"command":"{exact}"}}"#)).unwrap();
        assert_eq!(got.chars().count(), TARGET_MAX_CHARS);
        assert!(!got.ends_with('…'));

        // Multi-byte input is counted and cut by CHARACTER, so the cap can
        // never split a code point and produce invalid UTF-8.
        let wide = "é".repeat(TARGET_MAX_CHARS + 10);
        let got = target(&format!(r#"{{"command":"{wide}"}}"#)).unwrap();
        assert_eq!(got.chars().count(), TARGET_MAX_CHARS + 1);
    }

    /// `RawMessage::assistant_text` over a raw `message` object.
    fn prose(json: &str) -> Option<String> {
        let msg: RawMessage = serde_json::from_str(json).unwrap();
        msg.assistant_text()
    }

    #[test]
    fn assistant_text_lifts_prose_and_ignores_everything_else() {
        // The common real shape: a sentence, then the calls it introduced.
        // The prose is the preview; the tool blocks contribute nothing.
        assert_eq!(
            prose(
                r#"{"content":[{"type":"text","text":"Let me read the file."},
                    {"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/a"}}]}"#
            )
            .as_deref(),
            Some("Let me read the file.")
        );
        // Tool-use only -> nothing stored, so no response node.
        assert_eq!(
            prose(r#"{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{}}]}"#),
            None
        );
        // Prose that sanitizes to empty is the same as no prose.
        assert_eq!(
            prose(r#"{"content":[{"type":"text","text":"  \n\t "}]}"#),
            None
        );
        assert_eq!(prose(r#"{"content":[{"type":"text","text":""}]}"#), None);
        // Non-array content (a user line carries a bare string), absent
        // content, and a `text` block whose `text` is missing or non-string.
        assert_eq!(prose(r#"{"content":"just a string"}"#), None);
        assert_eq!(prose(r#"{}"#), None);
        assert_eq!(prose(r#"{"content":[{"type":"text"}]}"#), None);
        assert_eq!(prose(r#"{"content":[{"type":"text","text":42}]}"#), None);
        // `thinking` blocks are excluded: reasoning prose would be
        // indistinguishable from the reply in the same field, and would win
        // the cap over it.
        assert_eq!(
            prose(
                r#"{"content":[{"type":"thinking","thinking":"weighing options"},
                    {"type":"text","text":"Done."}]}"#
            )
            .as_deref(),
            Some("Done.")
        );
        assert_eq!(
            prose(r#"{"content":[{"type":"thinking","thinking":"weighing options"}]}"#),
            None
        );
    }

    #[test]
    fn assistant_text_joins_blocks_in_order_then_sanitizes_once() {
        // Several text blocks are ONE preview, in array order.
        assert_eq!(
            prose(
                r#"{"content":[{"type":"text","text":"First."},
                    {"type":"tool_use","id":"tu1","name":"Bash","input":{}},
                    {"type":"text","text":"Second."},
                    {"type":"text","text":"Third."}]}"#
            )
            .as_deref(),
            Some("First. Second. Third.")
        );
        // Same sanitizer as `tool_target`: newline/tab runs collapse to one
        // space and control characters are dropped, so a stored preview can
        // never span lines or move a terminal cursor.
        assert_eq!(
            prose("{\"content\":[{\"type\":\"text\",\"text\":\"line one\\n\\n\\tline two\"}]}")
                .as_deref(),
            Some("line one line two")
        );
        assert_eq!(
            prose("{\"content\":[{\"type\":\"text\",\"text\":\"red \\u001b[31malert\"}]}")
                .as_deref(),
            Some("red [31malert")
        );

        // A long paragraph is capped in CHARACTERS, not bytes — the cap is
        // shared with `tool_target`, there is no second constant.
        let long = "é".repeat(10_000);
        let got = prose(&format!(
            r#"{{"content":[{{"type":"text","text":"{long}"}}]}}"#
        ))
        .unwrap();
        assert_eq!(got.chars().count(), TARGET_MAX_CHARS + 1);
        assert!(got.ends_with('…'));
        assert!(got.len() < 10_000);

        // The cap bounds the MESSAGE, not each block: two blocks each at the
        // cap yield one capped preview, not two. (Here the cut lands on the
        // joining space, which the shipped sanitizer drops without an
        // ellipsis — `tool_target`'s behaviour, reused verbatim.)
        let half = "z".repeat(TARGET_MAX_CHARS);
        let got = prose(&format!(
            r#"{{"content":[{{"type":"text","text":"{half}"}},{{"type":"text","text":"{half}"}}]}}"#
        ))
        .unwrap();
        assert_eq!(got.chars().count(), TARGET_MAX_CHARS);
    }

    #[test]
    fn ingest_stores_a_preview_for_a_prose_bearing_message_only() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                // Prose + a tool call in one message.
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"Reading\nthe file."},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/a"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
                // Tool-use only.
                r#"{"type":"assistant","uuid":"u2","sessionId":"s1","timestamp":"2026-06-15T01:00:01.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu2","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        let msgs = store.cc_session_messages("s1").unwrap();
        let by = |u: &str| msgs.iter().find(|m| m.uuid == u).unwrap().preview.clone();
        assert_eq!(by("u1").as_deref(), Some("Reading the file."));
        assert_eq!(by("u2"), None);
    }

    /// One transcript line, as `human_prompt` sees it.
    fn prompt_of(json: &str) -> Option<String> {
        human_prompt(&serde_json::from_str::<RawLine>(json).unwrap())
    }

    #[test]
    fn human_prompt_accepts_a_typed_turn_and_a_slash_command() {
        // The authoritative modern shape: `origin.type == "human"`.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","origin":{"type":"human"},
                    "message":{"content":"add a prompts row to the timeline"}}"#
            )
            .as_deref(),
            Some("add a prompts row to the timeline")
        );
        // …and the key upstream renamed it to. Both spellings are live in the
        // corpus, and reading only one rejects every human turn written by the
        // other (task 814) — not "no origin", which would fall back to the
        // prefix list and accept this.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","origin":{"kind":"human"},
                    "message":{"content":"add a prompts row to the timeline"}}"#
            )
            .as_deref(),
            Some("add a prompts row to the timeline")
        );
        // A line carrying BOTH spellings must still parse. This is why
        // `RawOrigin` has two fields rather than one `#[serde(alias)]`: an
        // alias makes this a duplicate-field error, and every parse site skips
        // an unparseable line — so emitting both keys (the ordinary way to ship
        // a rename) would drop the whole line from the ingest, which is worse
        // than the bug the second spelling fixes.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","origin":{"type":"human","kind":"human"},
                    "message":{"content":"both keys"}}"#
            )
            .as_deref(),
            Some("both keys")
        );
        // Either key order, same answer.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","origin":{"kind":"human","type":"human"},
                    "message":{"content":"both keys, other order"}}"#
            )
            .as_deref(),
            Some("both keys, other order")
        );
        // An array of text blocks flattens the same way, in order.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","origin":{"type":"human"},
                    "message":{"content":[{"type":"text","text":"first"},
                                          {"type":"text","text":"second"}]}}"#
            )
            .as_deref(),
            Some("first second")
        );
        // A typed slash command: Claude Code rewrites it into a command
        // envelope, and the envelope is unwrapped back to what was typed.
        // Accepted whatever `origin` says — this IS human input.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":"<command-message>execute-refine</command-message><command-name>/execute-refine</command-name><command-args>774</command-args>"}}"#
            )
            .as_deref(),
            Some("/execute-refine 774")
        );
        // No args, or blank args: the bare command name.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":"<command-name>/clear</command-name><command-args></command-args>"}}"#
            )
            .as_deref(),
            Some("/clear")
        );
        // Legacy line — no `origin` at all — whose text hits nothing on the
        // fallback list.
        assert_eq!(
            prompt_of(r#"{"type":"user","message":{"content":"ship it"}}"#).as_deref(),
            Some("ship it")
        );
        // The shared cap, not a second one: 250 chars in, 200 + `…` out.
        let long = "x".repeat(250);
        let capped = prompt_of(&format!(
            r#"{{"type":"user","origin":{{"type":"human"}},"message":{{"content":"{long}"}}}}"#
        ))
        .unwrap();
        assert_eq!(capped.chars().count(), TARGET_MAX_CHARS + 1);
        assert!(capped.ends_with('…'));
    }

    #[test]
    fn human_prompt_rejects_every_machine_authored_user_line() {
        // Not a user line at all.
        assert_eq!(
            prompt_of(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#
            ),
            None
        );
        // Claude Code's own injections are flagged `isMeta`.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","isMeta":true,"origin":{"type":"human"},
                    "message":{"content":"Caveat: …"}}"#
            ),
            None
        );
        // A sidechain user line is a subagent's task prompt — already the
        // agent node's `description`, and not the main thread.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","isSidechain":true,"origin":{"type":"human"},
                    "message":{"content":"Research the store layer"}}"#
            ),
            None
        );
        // A tool result riding back in, flagged.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","toolUseResult":{"stdout":"ok"},
                    "message":{"content":"ok"}}"#
            ),
            None
        );
        // …and the ~794 carriers in the real corpus that have no
        // `toolUseResult` — one `tool_result` block condemns the line, even
        // alongside a `text` block.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"},
                                                        {"type":"text","text":"and some prose"}]}}"#
            ),
            None
        );
        // Legacy prefix fallback, one per shape that matters.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":"<local-command-stdout>total 8</local-command-stdout>"}}"#
            ),
            None
        );
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":"<system-reminder>be brief</system-reminder>"}}"#
            ),
            None
        );
        assert_eq!(
            prompt_of(r#"{"type":"user","message":{"content":"[Image: screenshot.png]"}}"#),
            None
        );
        // Both interrupt variants — the entry stops before the `]` for this.
        assert_eq!(
            prompt_of(r#"{"type":"user","message":{"content":"[Request interrupted by user]"}}"#),
            None
        );
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":"[Request interrupted by user for tool use]"}}"#
            ),
            None
        );
        // Ctrl-B bash mode: the captured output is machine text, the command
        // above it is what the user typed and is kept.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","message":{"content":"<bash-stdout>total 8</bash-stdout><bash-stderr></bash-stderr>"}}"#
            ),
            None
        );
        // A `<system-reminder>` block inside an array is dropped rather than
        // condemning the line — the human's own text beside it survives.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","origin":{"type":"human"},
                    "message":{"content":[{"type":"text","text":"<system-reminder>ctx</system-reminder>"},
                                          {"type":"text","text":"do the thing"}]}}"#
            )
            .as_deref(),
            Some("do the thing")
        );
        // With `origin` present it is authoritative: a non-human origin is
        // rejected however innocuous the text reads.
        assert_eq!(
            prompt_of(
                r#"{"type":"user","origin":{"type":"hook"},"message":{"content":"plain text"}}"#
            ),
            None
        );
        // Nothing to preview.
        assert_eq!(
            prompt_of(r#"{"type":"user","message":{"content":"   "}}"#),
            None
        );
        assert_eq!(
            prompt_of(r#"{"type":"user","message":{"content":42}}"#),
            None
        );
        assert_eq!(prompt_of(r#"{"type":"user"}"#), None);
    }

    #[test]
    fn ingest_stores_main_thread_prompts_only_and_is_idempotent() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                r#"{"type":"user","uuid":"p1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","origin":{"type":"human"},"message":{"content":"read\tthe file"}}"#,
                r#"{"type":"user","uuid":"p2","sessionId":"s1","timestamp":"2026-06-15T01:00:05.000Z","message":{"content":"<command-name>/execute-todo</command-name><command-args>774</command-args>"}}"#,
                // Rejected: meta, sidechain, tool-result carrier — and a line
                // with no uuid, which the existing guard already drops.
                r#"{"type":"user","uuid":"p3","sessionId":"s1","timestamp":"2026-06-15T01:00:06.000Z","isMeta":true,"message":{"content":"hook fired"}}"#,
                r#"{"type":"user","uuid":"p4","sessionId":"s1","timestamp":"2026-06-15T01:00:07.000Z","isSidechain":true,"origin":{"type":"human"},"message":{"content":"subagent task"}}"#,
                r#"{"type":"user","uuid":"p5","sessionId":"s1","timestamp":"2026-06-15T01:00:08.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}}"#,
                r#"{"type":"user","sessionId":"s1","timestamp":"2026-06-15T01:00:09.000Z","origin":{"type":"human"},"message":{"content":"no uuid, no row"}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        // A second walk from byte 0 must change nothing.
        sync(&mut store, true).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        let rows = store.cc_session_prompts("s1").unwrap();
        let got: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.uuid.as_str(), r.preview.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![("p1", "read the file"), ("p2", "/execute-todo 774")]
        );
        // Prompts are their own table: no message row was invented for them.
        assert!(store.cc_session_messages("s1").unwrap().is_empty());
    }

    #[test]
    fn session_graph_emits_prompt_nodes_first_at_an_equal_ts() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                // Prompt, response and tool call all stamped the same second:
                // the tie the rank must break, prompt → response → tool.
                r#"{"type":"user","uuid":"p1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","origin":{"type":"human"},"message":{"content":"read the file"}}"#,
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"Reading it."},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/a"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
                r#"{"type":"user","uuid":"p2","sessionId":"s1","timestamp":"2026-06-15T01:00:01.000Z","origin":{"type":"human"},"message":{"content":"now commit"}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        let g = session_graph(&store, "s1", GRAPH_NODE_LIMIT)
            .unwrap()
            .unwrap();
        let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["session", "prompt:p1", "msg:u1", "tool:tu1", "prompt:p2"]
        );

        let p = g.nodes.iter().find(|n| n.id == "prompt:p1").unwrap();
        assert_eq!(p.kind, CcGraphNodeKind::Prompt);
        assert_eq!(p.name, "Prompt");
        assert_eq!(p.target.as_deref(), Some("read the file"));
        // No model, no usage of its own — a user turn is billed as part of the
        // reply it provokes, so any number here would be invented.
        assert_eq!(p.model, None);
        assert_eq!(p.total_tokens, 0);
        assert_eq!(p.est_cost_usd, 0.0);
        assert!(p.tokens_are_rollup);

        // Always a direct child of the root, and never a parent itself.
        let parent = |to: &str| {
            g.edges
                .iter()
                .find(|e| e.to == to)
                .map(|e| e.from.as_str())
                .unwrap()
        };
        assert_eq!(parent("prompt:p1"), "session");
        assert_eq!(parent("prompt:p2"), "session");
        assert!(!g.edges.iter().any(|e| e.from.starts_with("prompt:")));

        assert!(!g.truncated);
        assert_eq!(g.omitted_prompts, 0);

        // A third budget, peer to the other two: room for one node of each
        // population, and each counter reports only its own drops.
        let g1 = session_graph(&store, "s1", 1).unwrap().unwrap();
        let ids1: Vec<&str> = g1.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids1, vec!["session", "prompt:p1", "msg:u1", "tool:tu1"]);
        assert!(g1.truncated);
        assert_eq!(g1.omitted_prompts, 1);
        assert_eq!(g1.omitted_responses, 0);
        assert_eq!(g1.omitted_tool_calls, 0);
    }

    #[test]
    fn session_graph_labels_calls_and_promotes_skills() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/work/widget","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"cargo test"}},{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"/home/me/work/widget/src/core/cc.rs"}},{"type":"tool_use","id":"tu3","name":"Skill","input":{"skill":"inaros-swe:refine","args":"583"}},{"type":"tool_use","id":"tu4","name":"AskUserQuestion","input":{"questions":[]}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        let g = session_graph(&store, "s1", GRAPH_NODE_LIMIT)
            .unwrap()
            .unwrap();
        let node = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap();

        // A plain tool keeps its tool name and carries what it acted on.
        assert_eq!(node("tool:tu1").kind, CcGraphNodeKind::Tool);
        assert_eq!(node("tool:tu1").name, "Bash");
        assert_eq!(node("tool:tu1").target.as_deref(), Some("cargo test"));
        // A file tool stores the FULL path; shortening to a basename is the
        // frontend's job (`shortTarget`), so the payload stays unambiguous.
        assert_eq!(
            node("tool:tu2").target.as_deref(),
            Some("/home/me/work/widget/src/core/cc.rs")
        );
        // A Skill call is promoted: own kind, skill name as the node name,
        // and no redundant target.
        assert_eq!(node("tool:tu3").kind, CcGraphNodeKind::Skill);
        assert_eq!(node("tool:tu3").name, "inaros-swe:refine");
        assert_eq!(node("tool:tu3").target, None);
        // A tool with no target-bearing key renders as it always did.
        assert_eq!(node("tool:tu4").kind, CcGraphNodeKind::Tool);
        assert_eq!(node("tool:tu4").name, "AskUserQuestion");
        assert_eq!(node("tool:tu4").target, None);
        // Non-tool kinds never carry one.
        assert_eq!(node("session").kind, CcGraphNodeKind::Session);
        assert_eq!(node("session").target, None);
    }

    #[test]
    fn session_graph_emits_response_nodes_as_ordered_flat_siblings() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-proj");
        fs::create_dir_all(&proj).unwrap();
        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                // Prose + two tool calls in ONE message: all three nodes share
                // the message's ts, which is the tie the ordering must break.
                r#"{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"Reading the file."},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/a"}},{"type":"tool_use","id":"tu2","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
                // Prose only, later.
                r#"{"type":"assistant","uuid":"u2","sessionId":"s1","timestamp":"2026-06-15T01:00:01.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
                // Tool-use only: no prose, so no response node.
                r#"{"type":"assistant","uuid":"u3","sessionId":"s1","timestamp":"2026-06-15T01:00:02.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu3","name":"Bash","input":{"command":"pwd"}}],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        let db = tmp.path().join("mesa.db");
        let mut store = Store::open(&db).unwrap();
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path().join("projects"));
        }
        sync(&mut store, false).unwrap();
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        let g = session_graph(&store, "s1", GRAPH_NODE_LIMIT)
            .unwrap()
            .unwrap();
        let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        // Root first, then oldest-first — and at the equal ts of message u1 the
        // response comes before the two tool nodes it issued.
        assert_eq!(
            ids,
            vec![
                "session", "msg:u1", "tool:tu1", "tool:tu2", "msg:u2", "tool:tu3",
            ]
        );

        let r = g.nodes.iter().find(|n| n.id == "msg:u1").unwrap();
        assert_eq!(r.kind, CcGraphNodeKind::Response);
        assert_eq!(r.name, "Response");
        assert_eq!(r.target.as_deref(), Some("Reading the file."));
        assert_eq!(r.model.as_deref(), Some("claude-opus-4-8"));
        // The issuing message's own usage — the same numbers its sibling tool
        // nodes carry, so it must declare itself non-summable.
        assert!(!r.tokens_are_rollup);
        assert_eq!(r.total_tokens, 30);
        assert_eq!(r.total_tokens, node_total(&g, "tool:tu1"));
        // A prose-free message contributes no response node.
        assert!(!ids.contains(&"msg:u3"));

        // Flat sibling: same parent as the message's tool nodes, and never
        // their parent.
        let parent = |to: &str| {
            g.edges
                .iter()
                .find(|e| e.to == to)
                .map(|e| e.from.as_str())
                .unwrap()
        };
        assert_eq!(parent("msg:u1"), "session");
        assert_eq!(parent("tool:tu1"), "session");
        assert_eq!(parent("tool:tu2"), "session");
        assert!(!g.edges.iter().any(|e| e.from == "msg:u1"));

        assert!(!g.truncated);
        assert_eq!(g.omitted_responses, 0);

        // The response budget is the tool budget's peer, not its tenant: with
        // room for one node of each population, each counter reports only its
        // own drops.
        let g1 = session_graph(&store, "s1", 1).unwrap().unwrap();
        let ids1: Vec<&str> = g1.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids1, vec!["session", "msg:u1", "tool:tu1"]);
        assert!(g1.truncated);
        assert_eq!(g1.omitted_responses, 1);
        assert_eq!(g1.omitted_tool_calls, 2);
    }

    fn node_total(g: &CcSessionGraph, id: &str) -> i64 {
        g.nodes.iter().find(|n| n.id == id).unwrap().total_tokens
    }

    /// A session bigger than the graph's node cap: 700 Bash calls (main +
    /// subagent), a `Skill` call, and one message per thread. Ingested straight
    /// into the store so the fixture stays a few lines rather than 700 of JSON.
    fn seed_big_session(store: &mut Store) {
        let mut tool_calls: Vec<CcToolCallRow> = Vec::new();
        for i in 0..700 {
            tool_calls.push(CcToolCallRow {
                tool_use_id: format!("tu{i}"),
                message_uuid: "u1".into(),
                session_id: "big".into(),
                // Every 10th call is the subagent's, so `subagent_calls` is a
                // real subset rather than 0 or everything.
                agent_id: if i % 10 == 0 { Some("a1".into()) } else { None },
                name: "Bash".into(),
                caller: None,
                // Spread over the whole span so the buckets are not one spike.
                ts: 1000 + i,
                target: Some(format!("echo {i}")),
            });
        }
        tool_calls.push(CcToolCallRow {
            tool_use_id: "tu-skill".into(),
            message_uuid: "u1".into(),
            session_id: "big".into(),
            agent_id: None,
            name: "Skill".into(),
            caller: None,
            ts: 1200,
            target: Some("inaros-swe:refine".into()),
        });
        let msg = |uuid: &str, agent: Option<&str>, ts: i64, out: i64| CcMessageRow {
            message_id: None,
            uuid: uuid.into(),
            session_id: "big".into(),
            agent_id: agent.map(str::to_string),
            ts,
            model: "claude-opus-4-8".into(),
            input_tokens: 100,
            output_tokens: out,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            skill: None,
            agent: None,
            preview: None,
        };
        store
            .cc_ingest_file(
                "/t/big.jsonl",
                &CcFileCursor {
                    mtime: 1,
                    size: 1,
                    byte_offset: 1,
                },
                &CcFileBatch {
                    sessions: vec![CcSessionUpsert {
                        session_id: "big".into(),
                        cwd: Some("/home/me/work/widget".into()),
                        git_branch: Some("main".into()),
                        entrypoint: Some("cli".into()),
                        used_subagent: true,
                        start_ts: Some(1000),
                        end_ts: Some(1699),
                    }],
                    agent_runs: vec![CcAgentRunUpsert {
                        session_id: "big".into(),
                        agent_id: "a1".into(),
                        agent: Some("Explore".into()),
                        skill: None,
                        tool_use_id: Some("tu0".into()),
                        description: Some("look around".into()),
                        spawn_depth: Some(1),
                        parent_agent_id: None,
                    }],
                    messages: vec![msg("u1", None, 1000, 200), msg("u2", Some("a1"), 1400, 20)],
                    tool_calls,
                    prompts: Vec::new(),
                    node_files: Vec::new(),
                },
            )
            .unwrap();
    }

    #[test]
    fn session_detail_counts_every_row_past_the_graph_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        seed_big_session(&mut store);

        let d = session_detail(&store, "big").unwrap().unwrap();
        // Exact, not a prefix: the graph would keep at most GRAPH_NODE_LIMIT
        // tool nodes, which is the whole reason this is its own read.
        assert!(d.tool_calls > GRAPH_NODE_LIMIT as i64);
        assert_eq!(d.tool_calls, 701);
        let bash = d.tools.iter().find(|t| t.name == "Bash").unwrap();
        assert_eq!(bash.calls, 700);
        assert_eq!(bash.subagent_calls, 70);
        // Tools are keyed on the name alone — 700 distinct targets, one row.
        assert_eq!(d.tools.len(), 2);
        // `Skill` is promoted to the skill it ran, as in the call tree.
        assert_eq!(d.skills.len(), 1);
        assert_eq!(d.skills[0].name, "inaros-swe:refine");
        assert_eq!(d.skills[0].calls, 1);

        // Main vs subagent split: main 100+200, subagent 100+20 — and the
        // whole-session rollup is their sum.
        assert_eq!(d.main.agent_id, None);
        assert_eq!(d.main.total_tokens, 300);
        assert_eq!(d.main.tool_calls, 631);
        assert_eq!(d.agents.len(), 1);
        assert_eq!(d.agents[0].agent_id.as_deref(), Some("a1"));
        assert_eq!(d.agents[0].agent.as_deref(), Some("Explore"));
        assert_eq!(d.agents[0].description.as_deref(), Some("look around"));
        assert_eq!(d.agents[0].spawn_depth, Some(1));
        assert_eq!(d.agents[0].total_tokens, 120);
        assert_eq!(d.agents[0].tool_calls, 70);
        assert_eq!(d.total_tokens, 420);
        assert_eq!(d.messages, 2);
        assert_eq!(d.agent_runs, 1);
        assert!((d.est_cost_usd - (d.main.est_cost_usd + d.agents[0].est_cost_usd)).abs() < 1e-9);
        assert_eq!(d.project.as_deref(), Some("widget"));

        // The activity series is a partition of the session: every message and
        // every tool call lands in exactly one bucket, none dropped.
        assert_eq!(d.activity.len(), ACTIVITY_BUCKETS);
        assert_eq!(
            d.activity.iter().map(|b| b.messages).sum::<i64>(),
            d.messages
        );
        assert_eq!(
            d.activity.iter().map(|b| b.tool_calls).sum::<i64>(),
            d.tool_calls
        );
        assert_eq!(
            d.activity.iter().map(|b| b.total_tokens).sum::<i64>(),
            d.total_tokens
        );
        assert_eq!(d.activity.iter().map(|b| b.output_tokens).sum::<i64>(), 220);
        // The last event sits exactly on `end_ts` and belongs to the last
        // bucket, not to a 61st one.
        assert!(d.activity.last().unwrap().tool_calls > 0);

        // A session that was never ingested is None, not an empty detail.
        assert!(session_detail(&store, "nope").unwrap().is_none());
    }

    #[test]
    fn session_detail_collapses_to_one_bucket_without_a_span() {
        // No usable span (start == end): one bucket holding everything, rather
        // than 60 buckets 59 of which are a lie.
        let tmp = tempfile::tempdir().unwrap();
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        store
            .cc_ingest_file(
                "/t/flat.jsonl",
                &CcFileCursor {
                    mtime: 1,
                    size: 1,
                    byte_offset: 1,
                },
                &CcFileBatch {
                    sessions: vec![CcSessionUpsert {
                        session_id: "flat".into(),
                        cwd: None,
                        git_branch: None,
                        entrypoint: None,
                        used_subagent: false,
                        start_ts: Some(500),
                        end_ts: Some(500),
                    }],
                    messages: vec![CcMessageRow {
                        uuid: "m1".into(),
                        message_id: None,
                        session_id: "flat".into(),
                        agent_id: None,
                        ts: 500,
                        model: "claude-opus-4-8".into(),
                        input_tokens: 1,
                        output_tokens: 2,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        skill: None,
                        agent: None,
                        preview: None,
                    }],
                    ..Default::default()
                },
            )
            .unwrap();

        let d = session_detail(&store, "flat").unwrap().unwrap();
        assert_eq!(d.activity.len(), 1);
        assert_eq!(d.activity[0].messages, 1);
        assert_eq!(d.activity[0].total_tokens, 3);
        assert_eq!(d.duration_minutes, 0.0);
        // No tool calls and no subagents: quiet empties, never an error.
        assert!(d.tools.is_empty() && d.skills.is_empty() && d.agents.is_empty());
        assert_eq!(d.main.messages, 1);
        assert_eq!(d.models.len(), 1);
    }

    #[test]
    fn session_graph_leaves_a_pre_migration_skill_call_alone() {
        // A row ingested before migration 22 has `target IS NULL`. The skill
        // promotion keys on the target (that IS the name), so such a row must
        // stay a plain `tool` node rather than become a `skill` node labelled
        // "Skill" — the graph degrades to its old picture instead of lying.
        let tmp = tempfile::tempdir().unwrap();
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        store
            .cc_ingest_file(
                "/t/a.jsonl",
                &CcFileCursor {
                    mtime: 1,
                    size: 1,
                    byte_offset: 1,
                },
                &CcFileBatch {
                    sessions: vec![CcSessionUpsert {
                        session_id: "s".into(),
                        cwd: None,
                        git_branch: None,
                        entrypoint: None,
                        used_subagent: false,
                        start_ts: Some(10),
                        end_ts: Some(20),
                    }],
                    tool_calls: vec![CcToolCallRow {
                        tool_use_id: "tu1".into(),
                        message_uuid: "u1".into(),
                        session_id: "s".into(),
                        agent_id: None,
                        name: "Skill".into(),
                        caller: None,
                        ts: 10,
                        target: None, // the pre-migration state
                    }],
                    ..Default::default()
                },
            )
            .unwrap();

        let g = session_graph(&store, "s", GRAPH_NODE_LIMIT)
            .unwrap()
            .unwrap();
        let n = g.nodes.iter().find(|n| n.id == "tool:tu1").unwrap();
        assert_eq!(n.kind, CcGraphNodeKind::Tool);
        assert_eq!(n.name, "Skill");
        assert_eq!(n.target, None);
    }

    // ---- node_text: the one read that leaves the db (task 803) ----

    /// A body far past `TARGET_MAX_CHARS`, so "uncapped" is provable rather
    /// than merely plausible: an assertion against a short string would pass
    /// whether or not the cap was applied.
    fn long_body(tag: &str) -> String {
        format!("{tag} {}", "x".repeat(400))
    }

    /// A projects tree with one session: a human turn, an assistant turn that
    /// emits prose *and* a Bash call, the `Task` call that spawns a subagent,
    /// a `Skill` call, and the subagent's own transcript (+ its sidecar, which
    /// is what links the run back to its spawning tool call).
    ///
    /// Returns `(tempdir, projects_root, store)` — the tempdir must outlive
    /// the store, and the caller keeps `MESA_CC_PROJECTS_DIR` pointed at the
    /// root for as long as it wants reads to resolve.
    fn seed_transcripts() -> (tempfile::TempDir, PathBuf, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let proj = root.join("-demo");
        fs::create_dir_all(proj.join("s1").join("subagents")).unwrap();

        let prompt = long_body("please");
        let prose = long_body("here is the answer");
        let command = long_body("echo");
        let task_prompt = long_body("go and look at");
        let sub_prose = long_body("subagent says");

        write_jsonl(
            &proj,
            "s1.jsonl",
            &[
                &format!(
                    r#"{{"type":"user","uuid":"u0","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/w","origin":{{"type":"human"}},"message":{{"role":"user","content":[{{"type":"text","text":{}}}]}}}}"#,
                    serde_json::to_string(&prompt).unwrap()
                ),
                &format!(
                    r#"{{"type":"assistant","uuid":"u1","sessionId":"s1","timestamp":"2026-06-15T01:01:00.000Z","cwd":"/w","message":{{"model":"claude-opus-4-8","content":[{{"type":"text","text":{}}},{{"type":"tool_use","id":"tu1","name":"Bash","input":{{"command":{},"description":"list"}}}}],"usage":{{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
                    serde_json::to_string(&prose).unwrap(),
                    serde_json::to_string(&command).unwrap()
                ),
                &format!(
                    r#"{{"type":"assistant","uuid":"u2","sessionId":"s1","timestamp":"2026-06-15T01:02:00.000Z","cwd":"/w","message":{{"model":"claude-opus-4-8","content":[{{"type":"tool_use","id":"tu2","name":"Task","input":{{"description":"look around","prompt":{}}}}}],"usage":{{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
                    serde_json::to_string(&task_prompt).unwrap()
                ),
                r#"{"type":"assistant","uuid":"u3","sessionId":"s1","timestamp":"2026-06-15T01:03:00.000Z","cwd":"/w","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu3","name":"Skill","input":{"skill":"inaros-swe:refine","args":"803"}}],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        write_jsonl(
            &proj.join("s1").join("subagents"),
            "agent-a1.jsonl",
            &[&format!(
                r#"{{"type":"assistant","uuid":"u5","sessionId":"s1","agentId":"a1","isSidechain":true,"timestamp":"2026-06-15T01:04:00.000Z","cwd":"/w","attributionAgent":"Explore","message":{{"model":"claude-opus-4-8","content":[{{"type":"text","text":{}}}],"usage":{{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
                serde_json::to_string(&sub_prose).unwrap()
            )],
        );
        fs::write(
            proj.join("s1").join("subagents").join("agent-a1.meta.json"),
            r#"{"toolUseId":"tu2","description":"look around","spawnDepth":1}"#,
        )
        .unwrap();

        // SAFETY: every caller holds ENV_LOCK for this window.
        unsafe { std::env::set_var("MESA_CC_PROJECTS_DIR", &root) };
        let mut store = Store::open(&tmp.path().join("mesa.db")).unwrap();
        sync(&mut store, false).unwrap();
        (tmp, root, store)
    }

    /// The pointer table, which is what makes any of this one file read: the
    /// main thread points at the session transcript and the subagent at its
    /// own — *not* both at whichever file the walker happened to reach last.
    /// A subagent's lines carry the parent's `sessionId`, so deriving the pair
    /// from the session upsert rather than from the line would get exactly
    /// this wrong.
    #[test]
    fn ingest_points_each_thread_at_its_own_transcript() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (_tmp, _root, store) = seed_transcripts();

        let main = store.cc_node_file("s1", "").unwrap().unwrap();
        assert!(main.ends_with("-demo/s1.jsonl"), "{main}");
        let sub = store.cc_node_file("s1", "a1").unwrap().unwrap();
        assert!(sub.ends_with("subagents/agent-a1.jsonl"), "{sub}");
    }

    #[test]
    fn node_text_returns_the_uncapped_body_for_every_kind() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (_tmp, _root, store) = seed_transcripts();

        // A human turn: the whole prompt, not the 200-char preview.
        let p = node_text(&store, "s1", "prompt:u0").unwrap();
        assert_eq!(p.kind, CcGraphNodeKind::Prompt);
        assert_eq!(p.format, CcNodeTextFormat::Text);
        assert_eq!(p.text, long_body("please"));
        assert!(p.text.chars().count() > TARGET_MAX_CHARS);

        // Assistant prose, likewise uncapped and with no trailing ellipsis.
        let m = node_text(&store, "s1", "msg:u1").unwrap();
        assert_eq!(m.kind, CcGraphNodeKind::Response);
        assert_eq!(m.format, CcNodeTextFormat::Text);
        assert_eq!(m.text, long_body("here is the answer"));
        assert!(!m.text.ends_with('…'));
        assert_eq!(m.model.as_deref(), Some("claude-opus-4-8"));

        // A tool call: the WHOLE input as pretty JSON, including the bulk
        // keys `TARGET_KEYS` deliberately never lifts.
        let t = node_text(&store, "s1", "tool:tu1").unwrap();
        assert_eq!(t.kind, CcGraphNodeKind::Tool);
        assert_eq!(t.name, "Bash");
        assert_eq!(t.format, CcNodeTextFormat::Json);
        let parsed: serde_json::Value = serde_json::from_str(&t.text).unwrap();
        assert_eq!(parsed["command"], serde_json::json!(long_body("echo")));
        assert_eq!(parsed["description"], serde_json::json!("list"));
        assert!(t.text.contains('\n'), "pretty-printed, not compact");

        // A `Skill` call keeps the graph's promotion: its own kind, named for
        // the skill rather than the word "Skill".
        let s = node_text(&store, "s1", "tool:tu3").unwrap();
        assert_eq!(s.kind, CcGraphNodeKind::Skill);
        assert_eq!(s.name, "inaros-swe:refine");
        assert_eq!(s.format, CcNodeTextFormat::Json);

        // A subagent's body is the `Task` call that spawned it — the whole
        // prompt it was handed, which lives in the PARENT's transcript.
        let a = node_text(&store, "s1", "agent:a1").unwrap();
        assert_eq!(a.kind, CcGraphNodeKind::Agent);
        assert_eq!(a.name, "Explore");
        assert_eq!(a.format, CcNodeTextFormat::Json);
        let parsed: serde_json::Value = serde_json::from_str(&a.text).unwrap();
        assert_eq!(
            parsed["prompt"],
            serde_json::json!(long_body("go and look at"))
        );

        // A message inside the subagent's own transcript resolves through the
        // subagent's pointer, not the session's.
        let sub = node_text(&store, "s1", "msg:u5").unwrap();
        assert_eq!(sub.text, long_body("subagent says"));
    }

    /// The three failure modes are deliberately distinct codes, and the CLI
    /// and the API both key off them.
    #[test]
    fn node_text_separates_validation_not_found_and_unavailable() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (tmp, root, store) = seed_transcripts();

        // The session node is a thread, not a turn: nothing to show, which is
        // a different answer from "no such node".
        assert!(matches!(
            node_text(&store, "s1", "session"),
            Err(Error::Validation(_))
        ));
        // A prefix this graph never mints, and a bare id with no prefix.
        assert!(matches!(
            node_text(&store, "s1", "file:/etc/passwd"),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            node_text(&store, "s1", "u1"),
            Err(Error::Validation(_))
        ));
        // Parses, but nothing backs it.
        assert!(matches!(
            node_text(&store, "s1", "msg:nope"),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            node_text(&store, "s1", "tool:nope"),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            node_text(&store, "s1", "agent:nope"),
            Err(Error::NotFound(_))
        ));
        // A node id cannot be used to read across sessions.
        assert!(matches!(
            node_text(&store, "other", "msg:u1"),
            Err(Error::NotFound(_))
        ));

        // The row survives, the transcript does not: `unavailable`, the code
        // scoped to "depends on something outside mesa". Both files go, so
        // the main-thread fallback cannot rescue it either.
        fs::remove_file(root.join("-demo").join("s1.jsonl")).unwrap();
        fs::remove_file(
            root.join("-demo")
                .join("s1")
                .join("subagents")
                .join("agent-a1.jsonl"),
        )
        .unwrap();
        assert!(matches!(
            node_text(&store, "s1", "msg:u1"),
            Err(Error::Unavailable(_))
        ));
        drop(tmp);
    }

    /// The path guard. A stored path is a cursor-era observation, not a
    /// capability: once `projects_dir()` moves, yesterday's path is outside
    /// the tree mesa is willing to open, and is refused rather than read.
    #[test]
    fn node_text_refuses_a_path_outside_the_projects_dir() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (tmp, _root, store) = seed_transcripts();

        // Same db, same rows, different transcript root — the stored paths
        // now escape it.
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        // SAFETY: ENV_LOCK gives this test exclusive access to the env var.
        unsafe { std::env::set_var("MESA_CC_PROJECTS_DIR", &elsewhere) };
        let refused = node_text(&store, "s1", "msg:u1");
        // SAFETY: same window, same lock.
        unsafe { std::env::remove_var("MESA_CC_PROJECTS_DIR") };
        assert!(
            matches!(refused, Err(Error::Validation(_))),
            "a path outside the transcript root must be refused, not read"
        );
    }

    // ---- session chat (task 814) ----

    /// One transcript, exercising every classification the chat read makes:
    /// a human turn, an assistant turn carrying prose *and* two calls, one
    /// injected `user` line that must not read as an assistant turn, one
    /// `tool_result` carrier, and a sidechain line from a subagent.
    const CHAT_LINES: &str = concat!(
        r#"{"type":"user","uuid":"p1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","origin":{"type":"human"},"message":{"role":"user","content":"ship it"}}"#,
        "\n",
        r#"{"type":"user","uuid":"m1","sessionId":"s","timestamp":"2026-08-01T10:00:01.000Z","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"an injected skill body"}]}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:02.000Z","message":{"id":"msg_1","model":"claude-opus-5","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"On it."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test"}},{"type":"tool_use","id":"t2","name":"advisor","input":{}}]}}"#,
        "\n",
        r#"{"type":"user","uuid":"r1","sessionId":"s","timestamp":"2026-08-01T10:00:03.000Z","toolUseResult":{"stdout":"ok"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"sa1","isSidechain":true,"agentId":"g1","sessionId":"s","timestamp":"2026-08-01T10:00:04.000Z","message":{"model":"claude-opus-5","content":[{"type":"text","text":"subagent prose"}]}}"#,
        "\n",
        "not json at all\n",
    );

    #[test]
    fn chat_turns_classify_a_transcript() {
        let turns = chat_turns(CHAT_LINES);
        let shape: Vec<(CcChatTurnKind, &str)> =
            turns.iter().map(|t| (t.kind, t.id.as_str())).collect();
        assert_eq!(
            shape,
            vec![
                (CcChatTurnKind::Prompt, "p1"),
                (CcChatTurnKind::Response, "a1"),
                (CcChatTurnKind::Tool, "t1"),
                (CcChatTurnKind::Tool, "t2"),
            ],
            "an injected `user` line, a tool_result carrier, a sidechain line \
             and an unparseable line all produce no turn — and one assistant \
             line emits its prose BEFORE its own calls"
        );

        assert_eq!(turns[0].text, "ship it");
        assert_eq!(turns[0].model, None, "a human turn has no model");

        // The response body is the prose only: `thinking` is excluded exactly
        // as it is from a stored preview.
        assert_eq!(turns[1].text, "On it.");
        assert_eq!(turns[1].model.as_deref(), Some("claude-opus-5"));
        assert_eq!(turns[1].ts.as_deref(), Some("2026-08-01T10:00:02.000Z"));

        // A tool turn carries the tool's name and the bounded target; a call
        // whose input has no summarizable key still appears, with none.
        assert_eq!(turns[2].name.as_deref(), Some("Bash"));
        assert_eq!(turns[2].text, "cargo test");
        assert_eq!(turns[3].name.as_deref(), Some("advisor"));
        assert_eq!(turns[3].text, "");
    }

    #[test]
    fn chat_bodies_are_uncapped_but_a_tool_target_is_not() {
        let long = "x".repeat(TARGET_MAX_CHARS * 3);
        let line = format!(
            r#"{{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{{"model":"m","content":[{{"type":"text","text":"{long}"}},{{"type":"tool_use","id":"t1","name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#
        );
        let turns = chat_turns(&line);
        assert_eq!(
            turns[0].text.chars().count(),
            TARGET_MAX_CHARS * 3,
            "prose is the product here: no cap, no sanitizing"
        );
        assert_eq!(
            turns[1].text.chars().count(),
            TARGET_MAX_CHARS + 1,
            "a tool target stays the same bounded summary the call tree shows              — 200 chars plus the ellipsis marking the cut"
        );
    }

    /// One `AskUserQuestion` call, as Claude Code writes it: two questions,
    /// the second `multiSelect`, an unbounded `preview` on one option and an
    /// option with no label at all.
    fn ask_line(id: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"a-{id}","sessionId":"s","timestamp":"2026-08-01T10:00:05.000Z","message":{{"model":"m","content":[{{"type":"tool_use","id":"{id}","name":"AskUserQuestion","input":{{"questions":[{{"question":"Redis or in-memory?","header":"Cache","multiSelect":false,"options":[{{"label":"Redis","description":"shared","preview":"a very long preview"}},{{"label":"In memory","description":""}},{{"description":"no label"}}]}},{{"question":"Which suites?","header":"Tests","multiSelect":true,"options":[{{"label":"unit"}},{{"label":"e2e"}}]}}]}}}}]}}}}"#
        )
    }

    #[test]
    fn pending_ask_reads_the_question_a_session_is_waiting_on() {
        let ask = pending_ask(&ask_line("q1")).expect("an unanswered ask is pending");
        assert_eq!(ask.id, "q1", "the tool_use_id is what a client answers by");
        assert_eq!(ask.questions.len(), 2);

        let first = &ask.questions[0];
        assert_eq!(first.question, "Redis or in-memory?");
        assert_eq!(first.header, "Cache");
        assert!(!first.multi_select);
        assert_eq!(
            first
                .options
                .iter()
                .map(|o| (o.label.as_str(), o.description.as_str()))
                .collect::<Vec<_>>(),
            vec![("Redis", "shared"), ("In memory", "")],
            "options keep their order, an absent description is empty, and an \
             option with no label is dropped rather than rendered blank"
        );
        assert!(
            ask.questions[1].multi_select,
            "multiSelect rides along — a chooser that takes several answers is \
             not answered the way one that takes one is"
        );
    }

    #[test]
    fn pending_ask_is_none_once_the_question_is_answered() {
        let answered = format!(
            "{}\n{}",
            ask_line("q1"),
            r#"{"type":"user","uuid":"r9","sessionId":"s","timestamp":"2026-08-01T10:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"q1","content":"answered"}]}}"#
        );
        assert_eq!(
            pending_ask(&answered),
            None,
            "a call with a result is history, not something to click"
        );
        assert_eq!(
            pending_ask(CHAT_LINES),
            None,
            "a session that never asked is not waiting on an answer"
        );
    }

    #[test]
    fn pending_ask_takes_the_newest_unanswered_question() {
        let two = format!("{}\n{}", ask_line("q1"), ask_line("q2"));
        assert_eq!(
            pending_ask(&two).map(|a| a.id),
            Some("q2".to_string()),
            "a session asks one thing at a time: the last one is the open one"
        );
        let sidechain = ask_line("q3").replace(
            r#""type":"assistant""#,
            r#""type":"assistant","isSidechain":true"#,
        );
        assert_eq!(
            pending_ask(&sidechain),
            None,
            "a subagent's question belongs to its own transcript, the same \
             main-thread-only rule the turns follow"
        );
    }

    #[test]
    fn session_chat_refuses_an_id_that_is_not_a_session_id() {
        // The id is used to BUILD a path, so it is validated before any
        // filesystem access — no transcript root needs to exist for this.
        for bogus in ["../../etc/passwd", "a/b", "", "sess id", "s.jsonl"] {
            assert!(
                matches!(session_chat(bogus, 10), Err(Error::Validation(_))),
                "{bogus:?} must be refused as a session id"
            );
        }
    }

    #[test]
    fn session_chat_reads_a_transcript_and_keeps_the_newest_turns() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let proj = root.join("-some-project");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("sess-1.jsonl"), CHAT_LINES).unwrap();
        // SAFETY: ENV_LOCK gives this test exclusive access to the env var.
        unsafe { std::env::set_var("MESA_CC_PROJECTS_DIR", &root) };
        let all = session_chat("sess-1", 100);
        let tail = session_chat("sess-1", 2);
        let missing = session_chat("sess-2", 100);
        // SAFETY: same window, same lock.
        unsafe { std::env::remove_var("MESA_CC_PROJECTS_DIR") };

        let all = all.unwrap();
        assert_eq!(all.session_id, "sess-1");
        assert_eq!(all.turns.len(), 4);
        assert!(!all.truncated);

        let tail = tail.unwrap();
        assert_eq!(
            tail.turns.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["t1", "t2"],
            "the limit keeps the NEWEST turns — a chat window is read at its end"
        );
        assert!(tail.truncated);

        assert!(
            matches!(missing, Err(Error::Unavailable(_))),
            "a session with no transcript on disk is unavailable, not not_found"
        );
    }

    /// Writes one transcript under a throwaway root and returns what
    /// `session_chat` makes of it — the tail-window tests below control the
    /// exact byte layout, so they need the file verbatim.
    fn chat_of_file(body: &str) -> Result<CcSessionChat> {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let proj = root.join("-big-project");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("sess-big.jsonl"), body).unwrap();
        // SAFETY: ENV_LOCK gives this test exclusive access to the env var.
        unsafe { std::env::set_var("MESA_CC_PROJECTS_DIR", &root) };
        let out = session_chat("sess-big", 100);
        // SAFETY: same window, same lock.
        unsafe { std::env::remove_var("MESA_CC_PROJECTS_DIR") };
        out
    }

    /// One assistant line saying `text`, padded to exactly `len` bytes when
    /// that is possible — the padding rides inside the prose so the line stays
    /// valid JSON and the turn stays identifiable by `uuid`.
    fn assistant_line(uuid: &str, text: &str, len: Option<usize>) -> String {
        let line = |body: &str| {
            format!(
                r#"{{"type":"assistant","uuid":"{uuid}","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{{"model":"m","content":[{{"type":"text","text":"{body}"}}]}}}}"#
            )
        };
        match len {
            None => line(text),
            Some(want) => {
                let base = line(text).len();
                assert!(want >= base, "cannot pad below the line's own length");
                line(&format!("{text}{}", "y".repeat(want - base)))
            }
        }
    }

    #[test]
    fn a_single_line_larger_than_the_tail_window_does_not_blank_the_chat() {
        // A multi-megabyte transcript line is ordinary — the real corpus holds
        // a 2.59 MB one (a large tool result). If the window lands entirely
        // inside one, a naive tail read finds no complete line at all and the
        // pane renders "this session has not said anything yet" for a session
        // that is talking perfectly well.
        let body = format!(
            "{}\n{}\n",
            assistant_line("a1", "still here", None),
            assistant_line("huge", "big", Some(CHAT_TAIL_BYTES as usize + 4096)),
        );
        let chat = chat_of_file(&body).unwrap();
        assert_eq!(
            chat.turns.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["a1", "huge"],
            "the window must widen past an oversized line rather than answer nothing"
        );
    }

    #[test]
    fn a_window_boundary_on_a_line_start_keeps_that_whole_line() {
        // Lay the file out so `len - CHAT_TAIL_BYTES` falls EXACTLY on `keep`'s
        // first byte: nothing there is partial, so nothing may be dropped.
        // Without the one-byte lookbehind the first newline the buffer finds is
        // `keep`'s own terminator, and a complete turn is silently discarded —
        // and because `last` is still there the read looks successful.
        let last = assistant_line("last", "the newest turn", None);
        let keep_len = CHAT_TAIL_BYTES as usize - (last.len() + 1) - 1;
        let keep = assistant_line("keep", "on the boundary", Some(keep_len));
        let head = format!("{}\n", assistant_line("old", "before the window", None));
        let body = format!("{head}{keep}\n{last}\n");
        assert_eq!(
            body.len() as u64 - CHAT_TAIL_BYTES,
            head.len() as u64,
            "the fixture must put the boundary exactly on `keep`'s first byte"
        );

        let chat = chat_of_file(&body).unwrap();
        assert_eq!(
            chat.turns.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["keep", "last"],
            "a line wholly inside the window is not a partial line and must survive"
        );
        assert!(chat.truncated, "`old` really was dropped, so say so");
    }

    // ---- session pulse (task 869) ----

    /// One transcript ending the way a working session's does: prose, then a
    /// tool call that carries usage but no prose. Also holds an *older*
    /// assistant turn, an injected `user` line whose content is text blocks,
    /// and a sidechain line — none of which may become the pulse.
    const PULSE_LINES: &str = concat!(
        r#"{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-5","content":[{"type":"text","text":"an earlier reply"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}}"#,
        "\n",
        r#"{"type":"user","uuid":"i1","sessionId":"s","timestamp":"2026-08-01T10:00:01.000Z","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"an injected skill body"}]}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"sa1","isSidechain":true,"agentId":"g1","sessionId":"s","timestamp":"2026-08-01T10:00:02.000Z","message":{"model":"claude-opus-5","content":[{"type":"text","text":"subagent prose"}],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":1,"cache_creation_input_tokens":1}}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a2","sessionId":"s","timestamp":"2026-08-01T10:00:03.000Z","message":{"id":"m2","model":"claude-opus-5","content":[{"type":"text","text":"the newest reply"}],"usage":{"input_tokens":100,"output_tokens":9000,"cache_read_input_tokens":200,"cache_creation_input_tokens":300}}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a3","sessionId":"s","timestamp":"2026-08-01T10:00:04.000Z","message":{"id":"m3","model":"claude-opus-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test"}}],"usage":{"input_tokens":1000,"output_tokens":5,"cache_read_input_tokens":2000,"cache_creation_input_tokens":3000}}}"#,
        "\n",
        "not json at all\n",
    );

    #[test]
    fn pulse_takes_the_newest_prose_and_the_newest_context_independently() {
        let pulse = pulse_from_text(PULSE_LINES);
        assert_eq!(
            pulse.last_response.as_deref(),
            Some("the newest reply"),
            "the newest assistant prose wins over an earlier one — and the \
             newest line of all is a tool call, which has no prose to offer"
        );
        assert_eq!(
            pulse.context_tokens,
            Some(1000 + 2000 + 3000),
            "context is the newest message's input + cache_read + \
             cache_creation — never output, never a sum across messages"
        );
    }

    #[test]
    fn pulse_ignores_a_synthesized_user_line_and_a_subagent() {
        // Claude Code writes its own injections (a skill body, hook output, a
        // caveat banner) as `user` lines whose content is an array of `text`
        // blocks — exactly the shape assistant prose has.
        let injected = r#"{"type":"user","uuid":"i1","sessionId":"s","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"an injected skill body"}],"usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        let sidechain = r#"{"type":"assistant","uuid":"sa1","isSidechain":true,"sessionId":"s","message":{"model":"m","content":[{"type":"text","text":"subagent prose"}],"usage":{"input_tokens":9,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
        assert_eq!(
            pulse_from_text(&format!("{injected}\n{sidechain}\n")),
            SessionPulse::default(),
            "neither an injected user line nor a subagent is this session \
             speaking"
        );
    }

    #[test]
    fn pulse_prose_is_bounded_and_a_usageless_session_has_no_context() {
        let long = "z".repeat(TARGET_MAX_CHARS + 500);
        let line = assistant_line("a1", &long, None);
        let pulse = pulse_from_text(&line);
        let got = pulse.last_response.unwrap();
        assert_eq!(
            got.chars().count(),
            TARGET_MAX_CHARS + 1,
            "model-authored text on a 3-second poll is capped, with the `…` \
             that marks the cut"
        );
        assert!(got.ends_with('…'));
        assert_eq!(
            pulse.context_tokens, None,
            "a line with no usage block leaves the context unknown, not zero"
        );
    }

    #[test]
    fn session_pulse_fails_open_on_a_missing_transcript() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let proj = root.join("-some-project");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("sess-1.jsonl"), PULSE_LINES).unwrap();
        // SAFETY: ENV_LOCK gives this test exclusive access to the env var.
        unsafe { std::env::set_var("MESA_CC_PROJECTS_DIR", &root) };
        let found = session_pulse("sess-1");
        let missing = session_pulse("sess-2");
        let bogus = session_pulse("../../etc/passwd");
        // SAFETY: same window, same lock.
        unsafe { std::env::remove_var("MESA_CC_PROJECTS_DIR") };

        assert_eq!(found.last_response.as_deref(), Some("the newest reply"));
        assert_eq!(found.context_tokens, Some(6000));
        assert_eq!(
            missing,
            SessionPulse::default(),
            "a session with no transcript on disk is silent, not an error"
        );
        assert_eq!(bogus, SessionPulse::default());
    }
}
