//! Live Claude Code subscription usage (the `/usage` data).
//!
//! Unlike [`super::cc`], which only reads local transcript files, this module
//! makes ONE outbound HTTPS GET to Anthropic's OAuth usage endpoint to fetch the
//! live rate-limit utilization (5-hour and 7-day windows, reset times, extra-
//! usage credits). It authenticates with the local Claude Code OAuth token —
//! the `CLAUDE_CODE_OAUTH_TOKEN` env var (a long-lived `claude setup-token`), the
//! macOS Keychain (`security`), or `~/.claude/.credentials.json` —
//! and shells out to `curl` (the same shell-out posture the CLI uses for `git`),
//! so mesa needs no TLS dependency. Only the usage numbers reach the client; the
//! token never leaves this process.
//!
//! Everything is best-effort: a missing token, offline network, or unexpected
//! payload yields `Err(reason)` so the caller can render an "unavailable" state.
//!
//! Test/override hooks: `MESA_CC_TOKEN` skips the keychain/file lookup and
//! `MESA_CC_USAGE_URL` overrides the endpoint (a `file://…` URL lets a gate feed
//! synthetic JSON through the same `curl` path).

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::types::{CcUsage, CcUsageExtra, CcUsageWindow};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";

// ---- endpoint JSON (only the fields we surface) ----

#[derive(Deserialize)]
struct RawUsage {
    five_hour: Option<RawWindow>,
    seven_day: Option<RawWindow>,
    seven_day_opus: Option<RawWindow>,
    seven_day_sonnet: Option<RawWindow>,
    extra_usage: Option<RawExtra>,
}

#[derive(Deserialize)]
struct RawWindow {
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    resets_at: Option<String>,
}

#[derive(Deserialize)]
struct RawExtra {
    #[serde(default)]
    is_enabled: bool,
    #[serde(default)]
    monthly_limit: Option<f64>,
    #[serde(default)]
    used_credits: Option<f64>,
    #[serde(default)]
    currency: Option<String>,
}

impl RawWindow {
    fn into_window(self) -> CcUsageWindow {
        CcUsageWindow {
            utilization: self.utilization.unwrap_or(0.0),
            resets_at: self.resets_at,
        }
    }
}

/// Fetch live subscription usage. Performs one `curl` GET and returns a concise
/// error string on any failure (no token, network down, bad payload).
pub fn fetch() -> Result<CcUsage, String> {
    let token = token().ok_or("no Claude Code OAuth token found")?;
    let url = std::env::var("MESA_CC_USAGE_URL").unwrap_or_else(|_| USAGE_URL.to_string());

    // `--fail` makes curl exit non-zero on a 4xx/5xx (e.g. a 401 from an expired
    // token) instead of handing back an error body — which, being all-`Option`,
    // would deserialize into an empty usage and masquerade as success. The
    // bearer token is fed through a `-K -` config on stdin rather than `-H` on
    // argv, so it never shows up in the process table; non-secret headers and
    // the URL (after `--`) stay on argv.
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "--fail",
            "--max-time",
            "10",
            "-H",
            &format!("anthropic-beta: {OAUTH_BETA}"),
            "-H",
            "Content-Type: application/json",
            "-K",
            "-",
            "--",
            &url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl failed to run: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        // curl config syntax: `header = "…"` is the long form of `-H`.
        let cfg = format!("header = \"Authorization: Bearer {token}\"\n");
        stdin
            .write_all(cfg.as_bytes())
            .map_err(|e| format!("curl stdin write failed: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("curl wait failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "usage request failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut usage = parse(&out.stdout)?;
    // The host-touching decorations (clock + `.claude.json`) live here, not in
    // `parse`, so `parse` stays a pure, env-independent mapping for tests.
    usage.plan_tier = plan_tier();
    usage.fetched_at_unix = now_unix();
    Ok(usage)
}

/// Map the endpoint payload to [`CcUsage`]. Pure (no clock, no filesystem) so it
/// can be unit-tested against a captured response; `fetch` fills in `plan_tier`
/// and `fetched_at_unix` afterwards.
fn parse(bytes: &[u8]) -> Result<CcUsage, String> {
    let raw: RawUsage =
        serde_json::from_slice(bytes).map_err(|e| format!("unexpected usage payload: {e}"))?;
    Ok(CcUsage {
        five_hour: raw.five_hour.map(RawWindow::into_window),
        seven_day: raw.seven_day.map(RawWindow::into_window),
        seven_day_opus: raw.seven_day_opus.map(RawWindow::into_window),
        seven_day_sonnet: raw.seven_day_sonnet.map(RawWindow::into_window),
        extra_usage: raw.extra_usage.map(|e| CcUsageExtra {
            is_enabled: e.is_enabled,
            monthly_limit: e.monthly_limit,
            used_credits: e.used_credits.unwrap_or(0.0),
            currency: e.currency.unwrap_or_else(|| "USD".to_string()),
        }),
        plan_tier: None,
        fetched_at_unix: 0,
    })
}

/// The Claude Code OAuth access token: `MESA_CC_TOKEN` override →
/// `CLAUDE_CODE_OAUTH_TOKEN` (the long-lived token Claude Code itself honors) →
/// macOS Keychain → `~/.claude/.credentials.json`. Returns `None` if none is
/// available. The env-var forms are bare token strings (not the credentials JSON).
fn token() -> Option<String> {
    if let Ok(t) = std::env::var("MESA_CC_TOKEN") {
        if !t.is_empty() {
            return Some(t);
        }
    }
    // Long-lived OAuth token (`claude setup-token`); same env var Claude Code reads.
    if let Ok(t) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        if !t.is_empty() {
            return Some(t);
        }
    }
    // macOS Keychain — where Claude Code stores the token on darwin.
    if let Ok(out) = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
    {
        if out.status.success() {
            if let Some(t) = token_from_json(&out.stdout) {
                return Some(t);
            }
        }
    }
    // File fallback (Linux, or installs that don't use the keychain).
    token_from_json(&std::fs::read(claude_dir()?.join(".credentials.json")).ok()?)
}

/// The Claude Code config directory: `CLAUDE_CONFIG_DIR` if set (the same
/// override `core::cc` honors), else `~/.claude`.
fn claude_dir() -> Option<std::path::PathBuf> {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        return Some(std::path::PathBuf::from(d));
    }
    Some(std::path::PathBuf::from(std::env::var("HOME").ok()?).join(".claude"))
}

fn token_from_json(bytes: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(str::to_string)
}

/// Best-effort plan label from `.claude.json`
/// (`oauthAccount.organizationRateLimitTier`, falling back to `claudeMaxTier`),
/// prettified to e.g. "Max 20x". Memoized: the tier is stable for a process's
/// life and the file can be large, so it is read and parsed at most once.
fn plan_tier() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(compute_plan_tier).clone()
}

fn compute_plan_tier() -> Option<String> {
    let v = read_claude_json()?;
    let raw = v
        .get("oauthAccount")
        .and_then(|o| o.get("organizationRateLimitTier"))
        .and_then(|t| t.as_str())
        .or_else(|| v.get("claudeMaxTier").and_then(|t| t.as_str()))?;
    Some(pretty_tier(raw))
}

/// `.claude.json` (the big Claude Code config), tried under `CLAUDE_CONFIG_DIR`
/// first when set, then `$HOME/.claude.json`.
fn read_claude_json() -> Option<serde_json::Value> {
    let mut paths = Vec::new();
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        paths.push(std::path::PathBuf::from(d).join(".claude.json"));
    }
    if let Ok(h) = std::env::var("HOME") {
        paths.push(std::path::PathBuf::from(h).join(".claude.json"));
    }
    paths
        .into_iter()
        .find_map(|p| std::fs::read(&p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn pretty_tier(raw: &str) -> String {
    let s = raw.strip_prefix("default_").unwrap_or(raw);
    let s = s.replace("claude_max", "Max").replace('_', " ");
    let s = s.trim();
    if s.is_empty() {
        raw.to_string()
    } else {
        s.to_string()
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_tier_labels() {
        assert_eq!(pretty_tier("default_claude_max_20x"), "Max 20x");
        assert_eq!(pretty_tier("claude_max_5x"), "Max 5x");
        assert_eq!(pretty_tier("5x"), "5x");
    }

    #[test]
    fn parse_maps_windows_and_extra() {
        // A trimmed real response: windows present, opus null, sonnet zeroed.
        let body = br#"{
            "five_hour": {"utilization": 2.0, "resets_at": "2026-06-24T04:09:59+00:00"},
            "seven_day": {"utilization": 13.0, "resets_at": "2026-06-26T12:59:59+00:00"},
            "seven_day_opus": null,
            "seven_day_sonnet": {"utilization": 0.0, "resets_at": null},
            "extra_usage": {"is_enabled": true, "monthly_limit": 20000, "used_credits": 0.0, "currency": "USD"}
        }"#;
        let u = parse(body).expect("parses");
        assert_eq!(u.five_hour.as_ref().unwrap().utilization, 2.0);
        assert_eq!(
            u.five_hour.as_ref().unwrap().resets_at.as_deref(),
            Some("2026-06-24T04:09:59+00:00")
        );
        assert_eq!(u.seven_day.as_ref().unwrap().utilization, 13.0);
        assert!(u.seven_day_opus.is_none());
        assert_eq!(u.seven_day_sonnet.as_ref().unwrap().utilization, 0.0);
        let extra = u.extra_usage.unwrap();
        assert!(extra.is_enabled);
        assert_eq!(extra.monthly_limit, Some(20000.0));
        assert_eq!(extra.currency, "USD");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse(b"not json").is_err());
    }
}
