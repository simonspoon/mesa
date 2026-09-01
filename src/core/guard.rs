//! The cost guard: deciding whether a *currently running* Claude Code session
//! has gone wrong, and saying so in prose a person can read (mesa task 1018,
//! `docs/cost-guard.md`).
//!
//! The motivating incident is the whole design brief. One session spent
//! $1,413.72 across 2.76B tokens in 7h55m, 91.2% of it inside a single 6h14m
//! window that was 99.8% cache **reads** with almost no output — an agent
//! re-reading the same context forever. Every part of that was visible in
//! `mesa cc` the entire time; nothing was *watching*. So this module is
//! deliberately small: it turns the numbers [`crate::core::cc::live`] already
//! computes into a verdict, and the verdict into a sentence.
//!
//! The rules themselves read nothing — no files, no db, no clock; every input
//! arrives as an argument, which is what makes them testable and what keeps
//! the guard from becoming a second transcript-ingestion path. Only
//! [`resolve_task`] and [`report`] touch the store, and only to *read*: the
//! guard writes nothing of its own except the inbox item its watcher files.

use crate::core::store::{Result, Store};
use crate::core::types::{CcLive, CcLiveSession, Status, Task};
use serde::Serialize;

/// How far back the guard looks: one hour.
///
/// Wider than `cc live`'s own 15-minute default (`cc::DEFAULT_LIVE_MINUTES`)
/// and narrower than its 1440-minute ceiling, for two reasons. Every figure
/// the rules read is a **window** total, not a session lifetime, so the window
/// is also the unit the thresholds are denominated in — and an hour of spend
/// is the unit a person already thinks in. And a session that pauses for a few
/// minutes between tool calls must not drop out of view between ticks; fifteen
/// minutes is short enough that a thinking agent can.
pub const DEFAULT_GUARD_WINDOW_MINUTES: i64 = 60;

/// The dollars-in-the-window rule.
pub const COST: &str = "cost";
/// The tokens-in-the-window rule.
pub const TOKENS: &str = "tokens";
/// The spin-loop rule: enormous volume that is almost entirely cache reads.
pub const SPIN: &str = "spin";

/// The resolved numbers one tick guards against, read fresh from
/// `~/.mesa/config.json` each time (`core::config::guard_thresholds`). A plain
/// value struct rather than a handle to the config, so [`breaches`] can be
/// exercised against numbers no config file would ever hold.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GuardThresholds {
    /// Estimated dollars in the guard window at or above which `cost` fires.
    pub cost_usd: f64,
    /// Tokens in the guard window at or above which `tokens` fires.
    pub total_tokens: i64,
    /// Share of tokens that must be cache reads for `spin` to fire.
    pub cache_read_share: f64,
    /// Tokens a session must have *before* `spin` is allowed to fire at all.
    pub cache_read_min_tokens: i64,
}

/// One rule a session has tripped: which rule, what mesa measured, and the
/// number it was measured against. Both figures are `f64` so a breach is one
/// shape whether the rule counts dollars, tokens or a ratio; a token count
/// well past 2^53 is not a number this feature can reach.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GuardBreach {
    /// [`COST`], [`TOKENS`] or [`SPIN`] — the fire-once key, paired with the
    /// session id, that stops one runaway filing the same alert every minute.
    pub threshold: &'static str,
    /// What this session actually shows.
    pub observed: f64,
    /// The threshold it reached.
    pub limit: f64,
}

/// Every rule `session` currently trips, in a fixed order (cost, tokens,
/// spin).
///
/// A session can trip several at once and each is reported separately: they
/// are different findings, not three spellings of one. "$40 spent" tells a
/// person to look; "$40 spent, 99.8% of it re-reading the same context" tells
/// them what they will find.
///
/// Every comparison is `>=`, so a threshold set to exactly what a session
/// shows fires — a limit is a limit, not a number to exceed.
pub fn breaches(session: &CcLiveSession, t: &GuardThresholds) -> Vec<GuardBreach> {
    let mut out = Vec::new();
    if session.est_cost_usd >= t.cost_usd {
        out.push(GuardBreach {
            threshold: COST,
            observed: session.est_cost_usd,
            limit: t.cost_usd,
        });
    }
    if session.total_tokens >= t.total_tokens {
        out.push(GuardBreach {
            threshold: TOKENS,
            observed: session.total_tokens as f64,
            limit: t.total_tokens as f64,
        });
    }
    // The floor is checked first and does double duty: it keeps a three-message
    // session that is trivially 100% cache-read from being called a runaway,
    // and — because it is at least 1 by construction — it is also what makes
    // the division below safe. A session with no tokens can never reach it.
    if session.total_tokens >= t.cache_read_min_tokens && session.total_tokens > 0 {
        let share = session.tokens.cache_read as f64 / session.total_tokens as f64;
        if share >= t.cache_read_share {
            out.push(GuardBreach {
                threshold: SPIN,
                observed: share,
                limit: t.cache_read_share,
            });
        }
    }
    out
}

/// The share of `session`'s tokens that are cache reads, for reporting. `0.0`
/// for a session with no tokens — there is no ratio to state, and a report is
/// not the place to invent one.
pub fn cache_read_share(session: &CcLiveSession) -> f64 {
    if session.total_tokens <= 0 {
        return 0.0;
    }
    session.tokens.cache_read as f64 / session.total_tokens as f64
}

/// The alert an inbox item carries: **prose**, not a table.
///
/// The inbox's play button may read this aloud through `kokoro-rs`
/// (`docs/inbox.md`), so it has to survive being spoken — which rules out
/// markdown tables, bullet grids and bare numbers with no unit. The session
/// id, cwd and project name are **data** and are stated as data; nothing here
/// is ever handed to a shell.
///
/// `minutes` is how long the session has been running (first to last in-window
/// event), `None` when the timestamps could not be read — then the sentence
/// simply omits the duration rather than guessing at one.
pub fn alert_body(
    session: &CcLiveSession,
    breaches: &[GuardBreach],
    window_minutes: i64,
    minutes: Option<i64>,
) -> String {
    let short: String = session.session_id.chars().take(8).collect();
    let where_ = match (&session.project, &session.cwd) {
        (Some(project), Some(cwd)) => format!(" in project {project} ({cwd})"),
        (Some(project), None) => format!(" in project {project}"),
        (None, Some(cwd)) => format!(" in {cwd}"),
        (None, None) => String::new(),
    };
    let running = match minutes {
        Some(m) if m >= 1 => format!(" It has been running for about {}.", humanize(m)),
        _ => String::new(),
    };

    let mut body = format!(
        "Cost guard: Claude Code session {short} (full id {full}){where_} has crossed a \
         threshold.{running} Over the last {window_minutes} minutes it used {tokens} tokens \
         at an estimated cost of ${cost:.2}, of which {share:.1} percent were cache reads. \
         It last produced {output} output tokens across {messages} assistant messages and is \
         currently {status}.\n\n",
        full = session.session_id,
        tokens = session.total_tokens,
        cost = session.est_cost_usd,
        share = cache_read_share(session) * 100.0,
        output = session.tokens.output,
        messages = session.messages,
        status = session.status,
    );
    for b in breaches {
        body.push_str(&explain(b));
        body.push('\n');
    }
    body.push_str(
        "\nmesa does not stop sessions. If this one is working as intended, no action is \
         needed; otherwise the session is the one to interrupt. Run `mesa cc guard` to see \
         every live session currently over a threshold.\n",
    );
    body
}

/// One breach as a sentence, saying what the rule means rather than restating
/// its name — an inbox item is read by a person who did not write the config.
fn explain(b: &GuardBreach) -> String {
    match b.threshold {
        COST => format!(
            "Cost: estimated spend of ${:.2} reached the ${:.2} guard threshold.",
            b.observed, b.limit
        ),
        TOKENS => format!(
            "Volume: {} tokens reached the {} token guard threshold.",
            b.observed as i64, b.limit as i64
        ),
        SPIN => format!(
            "Spin loop: {:.1} percent of this session's tokens are cache reads, at or above the \
             {:.1} percent threshold. That pattern is an agent re-reading the same context \
             instead of making progress.",
            b.observed * 100.0,
            b.limit * 100.0
        ),
        other => format!("{other}: {} reached {}.", b.observed, b.limit),
    }
}

/// A whole number of minutes as English — "45 minutes", "1 hour 5 minutes",
/// "6 hours". Spoken aloud, so no `6h14m`.
fn humanize(minutes: i64) -> String {
    let hours = minutes / 60;
    let rest = minutes % 60;
    let plural = |n: i64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    match (hours, rest) {
        (0, m) => plural(m, "minute"),
        (h, 0) => plural(h, "hour"),
        (h, m) => format!("{} {}", plural(h, "hour"), plural(m, "minute")),
    }
}

/// One live session as `mesa cc guard` reports it: the identity, the numbers
/// the rules read, the rules it tripped, and the task the alert would be filed
/// against — `null` when the ladder in [`resolve_task`] dead-ends, which is
/// the whole reason this command exists.
#[derive(Debug, Clone, Serialize)]
pub struct GuardSessionReport {
    pub session_id: String,
    pub project: Option<String>,
    pub cwd: Option<String>,
    /// `active` or `idle`, straight from [`crate::core::cc::live`].
    pub status: String,
    pub started: String,
    pub last_activity: String,
    /// Wall-clock minutes from this session's first **in-window** event to its
    /// last, so it never exceeds the window; `null` if the timestamps could
    /// not be parsed.
    pub running_minutes: Option<i64>,
    pub messages: i64,
    pub total_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub est_cost_usd: f64,
    pub cache_read_share: f64,
    pub breaches: Vec<GuardBreach>,
    /// The task an alert about this session would name, resolved through
    /// [`resolve_task`]; `null` when nothing in mesa claims it.
    pub task_id: Option<i64>,
}

/// The `mesa cc guard` payload: what was in force, and every live session
/// currently over one of those lines.
#[derive(Debug, Clone, Serialize)]
pub struct GuardReport {
    pub generated_at_unix: i64,
    pub window_minutes: i64,
    pub thresholds: GuardThresholds,
    /// Only the breaching sessions — a quiet machine reports an empty array.
    pub sessions: Vec<GuardSessionReport>,
}

/// Minutes from a session's first in-window event to its last, `None` when
/// either timestamp is unparseable. Not "since it started": [`crate::core::cc::live`]
/// only sees events inside the window, so a session older than the window
/// reports the window, not its true age.
pub fn running_minutes(session: &CcLiveSession) -> Option<i64> {
    let start = crate::core::cc::parse_ts(&session.started)?;
    let end = crate::core::cc::parse_ts(&session.last_activity)?;
    Some(((end - start).max(0)) / 60)
}

/// Which mesa task a runaway session belongs to — a **resolution**, never a
/// fabrication.
///
/// `Store::create_inbox_item` requires a real task id, because the inbox's
/// rule is that every item names the task it came from (`docs/inbox.md`, task
/// 847). The guard does not get to loosen that: an alert nobody can trace back
/// to work is worth less than the invariant it would cost. So it asks two
/// questions and accepts "no" as an answer:
///
/// 1. **Did a claim name this session?** A task whose `owner` is the session
///    id — the same link `docs/receipts.md` uses. This is exact: the agent
///    itself said so.
/// 2. **Whose folder is it working in?** The session's `cwd` matched by
///    **exact** equality against a project's `local_path` (the rule
///    `cc::collect_for_project` already uses — no prefix or subdirectory
///    matching, because a worktree is not its parent repo), then that
///    project's `in_progress` tasks, oldest claim first and otherwise the most
///    recently updated. A guess, but a narrow one, and the alert says which
///    session it is about so a wrong task is a wrong *filing cabinet*, not a
///    wrong story.
///
/// `Ok(None)` is the third answer and a normal one — `mesa cc guard` is where
/// such a session stays visible.
pub fn resolve_task(store: &Store, session: &CcLiveSession) -> Result<Option<i64>> {
    if let Some(task) = store.find_task_by_owner(&session.session_id)? {
        return Ok(Some(task.id));
    }
    let Some(cwd) = session.cwd.as_deref() else {
        return Ok(None);
    };
    // `list_projects_all`, not `list_projects`: an archived project's runaway
    // agent is still spending money.
    let Some(project) = store
        .list_projects_all()?
        .into_iter()
        .find(|p| p.local_path.as_deref() == Some(cwd))
    else {
        return Ok(None);
    };
    let mut candidates: Vec<Task> = store
        .list_tasks(Some(project.id))?
        .into_iter()
        .filter(|t| t.status == Status::InProgress)
        .collect();
    // Oldest claim first — the task that has been open longest is the one a
    // long-running session is most likely still on. An unclaimed in-progress
    // task sorts last (`None` after every `Some`), where the most recently
    // updated one wins.
    candidates.sort_by(|a, b| {
        (a.claimed_at.is_none(), &a.claimed_at)
            .cmp(&(b.claimed_at.is_none(), &b.claimed_at))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    Ok(candidates.first().map(|t| t.id))
}

/// Every live session currently over a threshold, with its task resolved —
/// the shared body of `mesa cc guard` and, minus the report shell, of the
/// watcher's own tick.
pub fn report(store: &Store, live: &CcLive, thresholds: &GuardThresholds) -> Result<GuardReport> {
    let mut sessions = Vec::new();
    for session in &live.sessions {
        let breaches = breaches(session, thresholds);
        if breaches.is_empty() {
            continue;
        }
        sessions.push(GuardSessionReport {
            session_id: session.session_id.clone(),
            project: session.project.clone(),
            cwd: session.cwd.clone(),
            status: session.status.clone(),
            started: session.started.clone(),
            last_activity: session.last_activity.clone(),
            running_minutes: running_minutes(session),
            messages: session.messages,
            total_tokens: session.total_tokens,
            cache_read_tokens: session.tokens.cache_read,
            output_tokens: session.tokens.output,
            est_cost_usd: session.est_cost_usd,
            cache_read_share: cache_read_share(session),
            breaches,
            task_id: resolve_task(store, session)?,
        });
    }
    Ok(GuardReport {
        generated_at_unix: live.generated_at_unix,
        window_minutes: live.window_minutes,
        thresholds: *thresholds,
        sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::CcTokens;

    fn thresholds() -> GuardThresholds {
        GuardThresholds {
            cost_usd: 25.0,
            total_tokens: 100_000_000,
            cache_read_share: 0.98,
            cache_read_min_tokens: 20_000_000,
        }
    }

    fn session(cost: f64, input: i64, output: i64, cache_read: i64) -> CcLiveSession {
        let tokens = CcTokens {
            input,
            output,
            cache_read,
            cache_creation: 0,
        };
        let total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation;
        CcLiveSession {
            session_id: "c2b83256-0000-0000-0000-000000000000".into(),
            project: Some("mesa".into()),
            cwd: Some("/home/me/mesa".into()),
            git_branch: None,
            models: vec![],
            started: "2026-09-01T01:00:00Z".into(),
            last_activity: "2026-09-01T07:00:00Z".into(),
            idle_seconds: 3,
            status: "active".into(),
            messages: 400,
            tokens,
            total_tokens: total,
            est_cost_usd: cost,
            used_subagent: false,
            subagents: vec![],
            spark: vec![],
        }
    }

    fn kinds(s: &CcLiveSession) -> Vec<&'static str> {
        breaches(s, &thresholds())
            .into_iter()
            .map(|b| b.threshold)
            .collect()
    }

    #[test]
    fn the_resolution_ladder_prefers_a_claim_then_the_cwd_then_gives_up() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("test.db")).unwrap();
        let repo = "/home/me/guarded";
        let project = store
            .create_project("guarded", None, None, Some(repo), None)
            .unwrap()
            .id;
        let older = store
            .create_task(
                project,
                "older work",
                crate::core::types::Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
            .id;
        let newer = store
            .create_task(
                project,
                "newer work",
                crate::core::types::Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
            .id;

        let mut s = session(50.0, 10, 10, 10);
        s.cwd = Some(repo.to_string());

        // Rung 3 first: nothing claimed, nothing in progress — a dead end, and
        // not an error.
        assert_eq!(resolve_task(&store, &s).unwrap(), None);

        // Rung 2: the cwd matches this project. A claimed in-progress task
        // outranks an unclaimed one — a claim dates the work, an ordinary
        // status flip does not.
        store
            .update_task(
                older,
                &crate::core::store::TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        store.claim_task(newer, "someone-else", false).unwrap();
        assert_eq!(resolve_task(&store, &s).unwrap(), Some(newer));

        // Rung 1 outranks it: a task claimed by this very session id.
        store.claim_task(older, &s.session_id, false).unwrap();
        assert_eq!(resolve_task(&store, &s).unwrap(), Some(older));

        // A cwd no project names is a dead end even with claims about.
        s.cwd = Some("/somewhere/else".to_string());
        s.session_id = "unknown-session".to_string();
        assert_eq!(resolve_task(&store, &s).unwrap(), None);
        // Matching is exact: a subdirectory of the project folder is not it.
        s.cwd = Some(format!("{repo}/frontend"));
        assert_eq!(resolve_task(&store, &s).unwrap(), None);
    }

    #[test]
    fn a_quiet_session_breaches_nothing() {
        assert!(kinds(&session(1.5, 1_000, 500, 10_000)).is_empty());
    }

    #[test]
    fn cost_fires_at_the_threshold_not_past_it() {
        assert_eq!(kinds(&session(25.0, 1_000, 500, 1_000)), vec![COST]);
        assert!(kinds(&session(24.99, 1_000, 500, 1_000)).is_empty());
    }

    #[test]
    fn volume_fires_on_tokens_alone() {
        // Cheap model, enormous volume: no cost breach, but the tokens rule
        // catches it. Cache read share is low, so `spin` stays quiet.
        let s = session(2.0, 60_000_000, 40_000_000, 0);
        assert_eq!(kinds(&s), vec![TOKENS]);
    }

    #[test]
    fn a_zero_token_session_never_divides_by_zero() {
        let s = session(0.0, 0, 0, 0);
        assert!(kinds(&s).is_empty());
        assert_eq!(cache_read_share(&s), 0.0);
    }

    #[test]
    fn a_small_all_cache_read_session_is_under_the_spin_floor() {
        // 100% cache reads, but only 5M tokens — an ordinary session reading
        // its own context, which is exactly what the floor exists to spare.
        let s = session(1.0, 0, 0, 5_000_000);
        assert_eq!(cache_read_share(&s), 1.0);
        assert!(kinds(&s).is_empty());
    }

    #[test]
    fn the_motivating_incident_trips_all_three() {
        // 99.8% cache reads, 2.76B tokens, $1413.72 — session c2b83256.
        let s = session(1_413.72, 5_000_000, 520_000, 2_754_480_000);
        assert_eq!(kinds(&s), vec![COST, TOKENS, SPIN]);
        let spin = breaches(&s, &thresholds())
            .into_iter()
            .find(|b| b.threshold == SPIN)
            .unwrap();
        assert!(spin.observed >= 0.998, "{spin:?}");
    }

    #[test]
    fn spin_fires_alone_when_volume_is_over_the_floor_but_under_the_ceiling() {
        // 30M tokens: over the 20M spin floor, well under the 100M volume
        // ceiling, and cheap enough not to trip cost.
        let s = session(3.0, 40_000, 20_000, 29_940_000);
        assert_eq!(kinds(&s), vec![SPIN]);
    }

    #[test]
    fn the_alert_body_is_speakable_prose_naming_the_session() {
        let s = session(1_413.72, 5_000_000, 520_000, 2_754_480_000);
        let body = alert_body(&s, &breaches(&s, &thresholds()), 60, Some(475));
        assert!(body.contains("c2b83256"), "{body}");
        assert!(body.contains(&s.session_id), "{body}");
        assert!(body.contains("project mesa"), "{body}");
        assert!(body.contains("7 hours 55 minutes"), "{body}");
        assert!(body.contains("Spin loop"), "{body}");
        assert!(!body.contains('|'), "no markdown tables: {body}");
    }

    #[test]
    fn an_unknown_duration_is_simply_omitted() {
        let s = session(30.0, 1_000, 500, 1_000);
        let body = alert_body(&s, &breaches(&s, &thresholds()), 60, None);
        assert!(!body.contains("running for"), "{body}");
    }

    #[test]
    fn durations_read_as_english() {
        assert_eq!(humanize(1), "1 minute");
        assert_eq!(humanize(45), "45 minutes");
        assert_eq!(humanize(60), "1 hour");
        assert_eq!(humanize(65), "1 hour 5 minutes");
        assert_eq!(humanize(360), "6 hours");
    }
}
