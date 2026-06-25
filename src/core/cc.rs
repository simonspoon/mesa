//! CC Dashboard: Claude Code telemetry.
//!
//! Parses Claude Code's own session transcripts — newline-delimited JSON under
//! `~/.claude/projects/**/*.jsonl` (including subagent transcripts in
//! `<session>/subagents/*.jsonl`) — and folds them into a [`CcDashboard`]. This
//! is **read-only external data**: nothing here touches the mesa SQLite store,
//! so the "all writes go through `Store`" invariant is preserved (there are no
//! writes). Shared by the CLI (`mesa cc`) and the API (`GET /api/cc`) so the two
//! surfaces never diverge.
//!
//! Each transcript line is one event. Only `assistant` events carry a `model`
//! and a `usage` block, so those drive token/cost/model/skill/agent rollups;
//! every line with a timestamp contributes to a session's start/end span. Lines
//! that don't parse, or aren't telemetry, are skipped.
//!
//! Cost is **estimated** from a static per-model price table (USD per million
//! tokens). It is labelled as an estimate in the UI and will drift as pricing
//! changes — update [`prices`] when it does.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::types::{
    CcAgentStat, CcDashboard, CcDayPoint, CcLive, CcLiveSession, CcLiveSubagent, CcModelStat,
    CcOverview, CcProjectStat, CcSessionRow, CcSkillStat, CcTokens,
};

// ---- transcript line shape (only the fields we read) ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLine {
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

#[derive(Default)]
struct Agg {
    sessions: HashMap<String, SessionAcc>,
    days: BTreeMap<String, DayAcc>,
    models: HashMap<String, GroupAcc>,
    skills: HashMap<String, GroupAcc>,
    agents: HashMap<String, GroupAcc>,
    projects: HashMap<String, ProjAcc>,
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

/// Build the dashboard for `window` (`7d`/`30d`/`90d`/`all`/`<n>d`). Returns
/// **all** session rows (newest first); callers that need a bounded payload cap
/// `sessions` themselves (see [`MAX_SESSION_ROWS`]).
pub fn collect(window: &str) -> CcDashboard {
    let now = now_unix();
    // Floor the cutoff to UTC midnight so `since` (a date) is genuinely the
    // inclusive first day of the window — otherwise the boundary day would be
    // partially excluded by now's time-of-day.
    let cutoff = window_days(window).map(|d| {
        let raw = now - d * 86_400;
        raw.div_euclid(86_400) * 86_400
    });

    let mut agg = Agg::default();
    if let Some(root) = projects_dir() {
        for f in collect_files(&root) {
            // Optimization: a windowed query skips whole files last modified
            // before the cutoff, since an append-only transcript's mtime is >=
            // its newest event. (A file restored from backup with an artificially
            // old mtime could be skipped despite holding in-window events — an
            // accepted trade for not parsing every file on each request.)
            if let Some(c) = cutoff
                && file_mtime(&f).is_some_and(|m| m < c)
            {
                continue;
            }
            parse_file(&f, cutoff, &mut agg);
        }
    }
    agg.finish(window, cutoff, now)
}

/// Newest transcript mtime (Unix seconds), or 0 if none. The API uses this as a
/// cheap cache key: re-parse only when new activity has landed.
pub fn newest_mtime() -> i64 {
    let mut newest = 0;
    if let Some(root) = projects_dir() {
        for f in collect_files(&root) {
            if let Some(m) = file_mtime(&f)
                && m > newest
            {
                newest = m;
            }
        }
    }
    newest
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

        let s = sessions
            .entry(sid.clone())
            .or_insert_with(|| LiveAcc { spark: vec![0; n_buckets], ..Default::default() });
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

fn parse_file(path: &Path, cutoff: Option<i64>, agg: &mut Agg) {
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
        if cutoff.is_some_and(|c| ts < c) {
            continue;
        }

        // Every timestamped line widens the session span and fills in metadata.
        let s = agg.sessions.entry(sid.clone()).or_default();
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
        if s.entrypoint.is_none() {
            s.entrypoint = raw.entrypoint.clone();
        }
        if raw.is_sidechain == Some(true) {
            s.sidechain = true;
        }

        // Only assistant turns carry model + usage; everything else is span-only.
        let Some(usage) = raw.message.as_ref().and_then(|m| m.usage.as_ref()) else {
            continue;
        };
        let Some(model) = raw.message.as_ref().and_then(|m| m.model.clone()) else {
            continue;
        };
        let cost = estimate_cost(&model, usage);

        s.models.insert(model.clone());
        s.messages += 1;
        s.tokens.add(usage);
        s.cost += cost;

        let date = ts_str.get(0..10).unwrap_or("").to_string();
        let d = agg.days.entry(date).or_default();
        d.sessions.insert(sid.clone());
        d.messages += 1;
        d.tokens.add(usage);
        d.cost += cost;

        let m = agg.models.entry(model).or_default();
        m.messages += 1;
        m.sessions.insert(sid.clone());
        m.tokens.add(usage);
        m.cost += cost;

        if let Some(skill) = raw.attribution_skill.clone() {
            let g = agg.skills.entry(skill).or_default();
            g.messages += 1;
            g.sessions.insert(sid.clone());
            g.tokens.add(usage);
            g.cost += cost;
        }
        if let Some(agent) = raw.attribution_agent.clone() {
            let g = agg.agents.entry(agent).or_default();
            g.messages += 1;
            g.sessions.insert(sid.clone());
            g.tokens.add(usage);
            g.cost += cost;
        }
        if let Some(cwd) = raw.cwd.clone() {
            let p = agg.projects.entry(cwd.clone()).or_default();
            p.path = cwd;
            p.sessions.insert(sid.clone());
            p.messages += 1;
            p.tokens.add(usage);
            p.cost += cost;
        }
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
        models.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

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
        skills.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

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
        agents.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

        let mut projects: Vec<CcProjectStat> = self
            .projects
            .into_iter()
            .map(|(_, p)| CcProjectStat {
                project: short_project(&p.path),
                path: p.path,
                sessions: p.sessions.len() as i64,
                messages: p.messages,
                total_tokens: p.tokens.total(),
                est_cost_usd: round4(p.cost),
            })
            .collect();
        projects.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

        // ---- session rows (newest first; ISO strings sort chronologically) ----
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
                    session_id,
                    duration_minutes: round2(dur),
                    models: s.models.into_iter().collect(),
                    messages: s.messages,
                    total_tokens: s.tokens.total(),
                    tokens: s.tokens.to_cc(),
                    est_cost_usd: round4(s.cost),
                    project: s.cwd.as_deref().map(short_project),
                    cwd: s.cwd,
                    git_branch: s.git_branch,
                    entrypoint: s.entrypoint,
                    used_subagent: s.sidechain,
                    start: s.start_str,
                    end: s.end_str,
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
        };
        // Opus: $5 in + $25 out per Mtok = $30.
        assert!((estimate_cost("claude-opus-4-8", &u) - 30.0).abs() < 1e-9);
        // Unknown / synthetic: zero.
        assert_eq!(estimate_cost("<synthetic>", &u), 0.0);
    }

    #[test]
    fn folds_transcripts_into_dashboard() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-some-project");
        fs::create_dir_all(&proj).unwrap();
        // Two assistant turns in one session, plus a non-telemetry user line.
        write_jsonl(
            &proj,
            "sess.jsonl",
            &[
                r#"{"type":"user","sessionId":"s1","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/work/widget","gitBranch":"main","entrypoint":"cli","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-06-15T01:05:00.000Z","cwd":"/home/me/work/widget","attributionSkill":"build","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}}"#,
                r#"{"type":"assistant","isSidechain":true,"sessionId":"s1","timestamp":"2026-06-15T01:10:00.000Z","attributionAgent":"Explore","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            ],
        );
        // SAFETY: ENV_LOCK gives this test exclusive access to the env var.
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path());
        }
        let d = collect("all");
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }

        assert_eq!(d.overview.sessions, 1);
        assert_eq!(d.overview.messages, 2);
        assert_eq!(d.overview.tokens.input, 110);
        assert_eq!(d.overview.tokens.output, 220);
        assert_eq!(d.overview.total_tokens, 110 + 220 + 50);
        assert_eq!(d.overview.active_days, 1);
        // Span is 01:00 → 01:10 = 10 minutes.
        assert!((d.overview.avg_session_minutes - 10.0).abs() < 1e-6);
        assert_eq!(d.models.len(), 2);
        assert_eq!(d.skills.iter().find(|s| s.skill == "build").unwrap().messages, 1);
        assert_eq!(d.agents.iter().find(|a| a.agent == "Explore").unwrap().messages, 1);
        let row = &d.sessions[0];
        assert_eq!(row.project.as_deref(), Some("widget"));
        assert!(row.used_subagent);
    }

    // Build an ISO-8601 UTC timestamp `secs_ago` seconds before now, so a test
    // transcript can land inside (or outside) the live window deterministically.
    fn iso_at(secs_ago: i64) -> String {
        let e = now_unix() - secs_ago;
        let tod = e.rem_euclid(86_400);
        format!("{}T{:02}:{:02}:{:02}.000Z", fmt_date(e), tod / 3600, (tod % 3600) / 60, tod % 60)
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
    fn window_filters_old_events() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("p")).unwrap();
        write_jsonl(
            &tmp.path().join("p"),
            "old.jsonl",
            &[
                r#"{"type":"assistant","sessionId":"old","timestamp":"2000-01-01T00:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":1}}}"#,
            ],
        );
        unsafe {
            std::env::set_var("MESA_CC_PROJECTS_DIR", tmp.path());
        }
        // A 7-day window excludes a year-2000 event (file mtime is "now", so the
        // file isn't skipped — the per-event cutoff is what drops it).
        let d = collect("7d");
        unsafe {
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }
        assert_eq!(d.overview.sessions, 0);
        assert!(d.since.is_some());
    }
}
