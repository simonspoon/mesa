//! The client side of the `naru-audio` daemon (mesa task 1388): how Naru
//! finds it, asks whether it is ready, and says so loudly when it is not.
//!
//! `naru-audio` is a local HTTP service launchd starts — never Naru. Naru
//! only ever **asks**: `GET {url}/health` with a 500 ms timeout
//! ([`probe`]), classified into one of five [`AudioState`]s, each with the
//! sentence the page shows the person. The answer is cached with a **TTL**
//! rather than for the life of the process: 10 s while `ready`, 2 s for
//! anything else, so a daemon that goes down is noticed within one ready TTL
//! and one that comes back within two seconds, with no restart. There is no
//! `OnceLock` anywhere on this path; [`TtlCache`] is also what
//! `listen::models()` and `speech::voices()` cache their subprocess answers
//! in.
//!
//! Every **change** of state — not every probe — is logged to stderr in the
//! `warn audio state ready -> daemon_down url=…` shape, so a background
//! service's log shows the moment speech broke.
//!
//! The HTTP client is `ureq` with no default features: plain HTTP to a
//! loopback daemon, no TLS, no proxy, no redirects. It is blocking, so every
//! caller on an async worker goes through `spawn_blocking`.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

/// Where the daemon listens when neither the config nor `NARU_AUDIO_URL`
/// says otherwise (`naru-audio serve`'s own default bind).
pub const DEFAULT_URL: &str = "http://127.0.0.1:7870";

/// How long `GET /health` may take before the daemon counts as down. It
/// answers from an in-memory snapshot within milliseconds even mid-decode,
/// so anything slower is a daemon that is not really there.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// How long a `ready` answer is trusted before the daemon is asked again.
pub const READY_TTL: Duration = Duration::from_secs(10);

/// How long any other answer (a failure, an empty list) is trusted — short,
/// so a daemon that comes back is noticed quickly.
pub const FAILURE_TTL: Duration = Duration::from_secs(2);

/// The most of `/health`'s body Naru reads. The real answer is a few hundred
/// bytes; this bounds what a wrong service on the port can make Naru hold.
const HEALTH_BODY_CAP: u64 = 64 * 1024;

/// The one API version this Naru speaks.
const API_VERSION: i64 = 1;

/// Which engine Naru's **server** runs speech through (`audio.engine`,
/// `docs/config.md`). `legacy` is the external `auris`/`kokoro-rs` binaries;
/// `naru-audio` is the daemon. Neither is ever a fallback for the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioEngine {
    Legacy,
    NaruAudio,
}

impl AudioEngine {
    pub fn parse(value: &str) -> Option<AudioEngine> {
        match value {
            "legacy" => Some(AudioEngine::Legacy),
            "naru-audio" => Some(AudioEngine::NaruAudio),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AudioEngine::Legacy => "legacy",
            AudioEngine::NaruAudio => "naru-audio",
        }
    }
}

/// What the probe found (design §4.4). Serialized snake_case — the exact
/// strings `GET /api/live/transcribe` answers with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioState {
    /// Health ok, API 1, and the speech-to-text model loadable.
    Ready,
    /// Connection refused or timed out: nothing is listening at the URL.
    DaemonDown,
    /// The daemon is up but its default model has not been pulled.
    ModelMissing,
    /// The daemon speaks an API version this Naru does not.
    Incompatible,
    /// Anything else the daemon (or whatever answered) reported.
    Error,
}

impl AudioState {
    pub fn as_str(self) -> &'static str {
        match self {
            AudioState::Ready => "ready",
            AudioState::DaemonDown => "daemon_down",
            AudioState::ModelMissing => "model_missing",
            AudioState::Incompatible => "incompatible",
            AudioState::Error => "error",
        }
    }
}

/// One probe's answer: the state, the sentence to show the person (`None`
/// when ready), the URL asked, and when (RFC 3339 UTC).
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub state: AudioState,
    pub message: Option<String>,
    pub url: String,
    pub checked_at: String,
}

/// A single cached value with a TTL decided by the value itself, keyed so a
/// changed key (a different URL, a different binary) is a miss rather than a
/// stale hit. The lock is held across the fetch, so a burst of callers makes
/// one request, not one each.
pub struct TtlCache<T> {
    slot: Mutex<Option<Slot<T>>>,
}

struct Slot<T> {
    key: String,
    value: T,
    at: Instant,
    taken_at: SystemTime,
    ttl: Duration,
}

impl<T: Clone> TtlCache<T> {
    pub const fn new() -> Self {
        TtlCache {
            slot: Mutex::new(None),
        }
    }

    /// The cached value for `key` if it is younger than its TTL at `now`,
    /// else a fresh `fetch()` stored with `ttl(&value)`. Returns the value and
    /// the wall-clock time it was taken.
    pub fn get(
        &self,
        key: &str,
        now: Instant,
        ttl: impl FnOnce(&T) -> Duration,
        fetch: impl FnOnce() -> T,
    ) -> (T, SystemTime) {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = slot.as_ref()
            && s.key == key
            && now.saturating_duration_since(s.at) < s.ttl
        {
            return (s.value.clone(), s.taken_at);
        }
        let value = fetch();
        let taken_at = SystemTime::now();
        *slot = Some(Slot {
            key: key.to_string(),
            ttl: ttl(&value),
            value: value.clone(),
            at: now,
            taken_at,
        });
        (value, taken_at)
    }

    /// Forgets the cached value, so the next [`TtlCache::get`] fetches.
    pub fn invalidate(&self) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl<T: Clone> Default for TtlCache<T> {
    fn default() -> Self {
        TtlCache::new()
    }
}

/// The TTL for a list answer (`listen::models()`, `speech::voices()`): an
/// empty list is a failure to ask, retried soon.
pub fn list_ttl<T>(list: &[T]) -> Duration {
    if list.is_empty() {
        FAILURE_TTL
    } else {
        READY_TTL
    }
}

/// The probe cache plus the last state seen, which is what turns "every
/// probe" into "every change" for the log.
struct Prober {
    cache: TtlCache<Probe>,
    last: Mutex<Option<AudioState>>,
}

impl Prober {
    const fn new() -> Self {
        Prober {
            cache: TtlCache::new(),
            last: Mutex::new(None),
        }
    }

    /// The probe for `url` at `now`, plus the log line to write when the
    /// state differs from the last one this prober saw.
    fn probe_at(&self, url: &str, now: Instant) -> (Probe, Option<String>) {
        let (probe, _) = self.cache.get(
            url,
            now,
            |p| {
                if p.state == AudioState::Ready {
                    READY_TTL
                } else {
                    FAILURE_TTL
                }
            },
            || fetch_health(url),
        );
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        let line =
            (*last != Some(probe.state)).then(|| state_change_line(*last, probe.state, &probe.url));
        *last = Some(probe.state);
        (probe, line)
    }
}

static PROBER: Prober = Prober::new();

/// Whether the daemon at `url` can transcribe, from the cache when it is
/// fresh ([`READY_TTL`] / [`FAILURE_TTL`]). Blocking — at most
/// [`PROBE_TIMEOUT`] on a miss. A change of state is logged to stderr.
pub fn probe(url: &str) -> Probe {
    let (probe, line) = PROBER.probe_at(url, Instant::now());
    if let Some(line) = line {
        eprintln!("{line}");
    }
    probe
}

/// Drops the cached probe, so the next [`probe`] asks the daemon again. For
/// a real request that failed (task 17): the failure is fresher news than a
/// ten-second-old `ready`.
pub fn invalidate() {
    PROBER.cache.invalidate();
}

/// `warn audio state ready -> daemon_down url=…` — `info` when the new state
/// is `ready`, `warn` otherwise; `unknown` for the first probe of a process.
fn state_change_line(from: Option<AudioState>, to: AudioState, url: &str) -> String {
    let level = if to == AudioState::Ready {
        "info"
    } else {
        "warn"
    };
    let from = from.map_or("unknown", AudioState::as_str);
    format!("{level} audio state {from} -> {} url={url}", to.as_str())
}

#[derive(Deserialize)]
struct Health {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    api: Option<i64>,
    #[serde(default)]
    stt: Option<Engine>,
}

#[derive(Deserialize)]
struct Engine {
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    problem: Option<Problem>,
}

#[derive(Deserialize)]
struct Problem {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// `GET {url}/health`, classified. Never fails: every way of not getting a
/// ready daemon is a state with a sentence.
fn fetch_health(url: &str) -> Probe {
    let (state, message) = match request_health(url) {
        Ok((status, body)) => classify(status, &body),
        Err(e) => classify_transport(url, &e),
    };
    Probe {
        state,
        message,
        url: url.to_string(),
        checked_at: crate::core::cc::fmt_ts(unix_now()),
    }
}

fn request_health(url: &str) -> Result<(u16, String), ureq::Error> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let mut response = agent
        .get(format!("{}/health", url.trim_end_matches('/')))
        .call()?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(HEALTH_BODY_CAP)
        .read_to_string()?;
    Ok((status, body))
}

fn down_message(url: &str) -> String {
    format!(
        "Speech isn't available: naru-audio isn't running at {url}. \
         Start it with `brew services start naru-audio`."
    )
}

fn error_message(reported: &str) -> String {
    format!("Speech isn't available: naru-audio reported: {reported}")
}

/// A request that never got an HTTP answer. Refused, timed out, or with no
/// route to the host is `daemon_down` — nothing is listening; anything else
/// (a garbled reply, a bad URL) is an `error` naming it.
fn classify_transport(url: &str, e: &ureq::Error) -> (AudioState, Option<String>) {
    match e {
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::ConnectionFailed
        | ureq::Error::HostNotFound => (AudioState::DaemonDown, Some(down_message(url))),
        other => (AudioState::Error, Some(error_message(&other.to_string()))),
    }
}

/// A `/health` answer, read against design §4.4's table.
fn classify(status: u16, body: &str) -> (AudioState, Option<String>) {
    let Ok(health) = serde_json::from_str::<Health>(body) else {
        return (
            AudioState::Error,
            Some(error_message(&format!(
                "GET /health answered HTTP {status} with a body that is not its JSON"
            ))),
        );
    };
    if health.api != Some(API_VERSION) {
        let v = health.version.as_deref().unwrap_or("(unknown version)");
        let n = health
            .api
            .map_or_else(|| "(none)".to_string(), |n| n.to_string());
        return (
            AudioState::Incompatible,
            Some(format!(
                "Speech isn't available: naru-audio {v} speaks API {n}; this Naru \
                 needs API {API_VERSION}. Upgrade with `brew upgrade naru-audio`."
            )),
        );
    }
    if !(200..300).contains(&status) || health.status.as_deref() != Some("ok") {
        let s = health.status.as_deref().unwrap_or("(none)");
        return (
            AudioState::Error,
            Some(error_message(&format!(
                "GET /health answered HTTP {status} with status {s}"
            ))),
        );
    }
    let Some(stt) = health.stt else {
        return (
            AudioState::Error,
            Some(error_message(
                "no speech-to-text engine (/health has no stt block)",
            )),
        );
    };
    if stt.ready {
        return (AudioState::Ready, None);
    }
    match stt.problem {
        Some(Problem {
            code: Some(code), ..
        }) if code == "model_not_pulled" => {
            let m = stt.default.as_deref().unwrap_or("(default)");
            (
                AudioState::ModelMissing,
                Some(format!(
                    "Speech isn't available: the model {m} isn't downloaded. \
                     Run `naru-audio pull {m}`."
                )),
            )
        }
        Some(Problem {
            message: Some(message),
            ..
        }) => (AudioState::Error, Some(error_message(&message))),
        _ => (
            AudioState::Error,
            Some(error_message("speech-to-text is not ready")),
        ),
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::JoinHandle;

    const READY: &str = r#"{"status":"ok","version":"0.1.0","api":1,"pid":1,"uptime_s":4,
        "stt":{"default":"parakeet-tdt-0.6b-v2-int8","ready":true,"problem":null}}"#;

    /// A one-route HTTP stub: every request gets `body` with a 200. Stopped
    /// by dropping it, which closes the listening socket.
    struct Stub {
        port: u16,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Stub {
        fn start(port: u16, body: &'static str) -> Stub {
            let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind stub");
            let port = listener.local_addr().unwrap().port();
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let thread = std::thread::spawn(move || {
                for conn in listener.incoming() {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(mut conn) = conn else { continue };
                    let mut buf = [0u8; 4096];
                    let mut got = Vec::new();
                    while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                        match conn.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => got.extend_from_slice(&buf[..n]),
                        }
                    }
                    let _ = write!(
                        conn,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            });
            Stub {
                port,
                stop,
                thread: Some(thread),
            }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
    }

    impl Drop for Stub {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wake the blocking accept so the thread sees the flag and drops
            // the listener.
            let _ = TcpStream::connect(("127.0.0.1", self.port));
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    fn state_of(body: &str) -> (AudioState, Option<String>) {
        classify(200, body)
    }

    /// The acceptance run: ready → the daemon stops → `daemon_down` once
    /// the ready TTL lapses → it comes back on the same port → `ready` once
    /// the failure TTL lapses, all on one prober with no restart. The clock
    /// is injected, so the TTLs are exercised without sleeping through them.
    #[test]
    fn probe_follows_a_daemon_that_goes_down_and_comes_back_within_the_ttls() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let port = stub.port;
        let url = stub.url();
        let t0 = Instant::now();

        let (p, line) = prober.probe_at(&url, t0);
        assert_eq!(p.state, AudioState::Ready);
        assert_eq!(p.message, None);
        assert_eq!(p.url, url);
        assert_eq!(p.checked_at.len(), 20, "{}", p.checked_at);
        assert!(p.checked_at.ends_with('Z'), "{}", p.checked_at);
        assert_eq!(
            line.as_deref(),
            Some(format!("info audio state unknown -> ready url={url}").as_str())
        );

        drop(stub);

        // Inside the ready TTL the cached answer stands, and nothing is logged.
        let (p, line) = prober.probe_at(&url, t0 + Duration::from_secs(9));
        assert_eq!(p.state, AudioState::Ready);
        assert_eq!(line, None);

        // Past it, the daemon is asked again and is gone.
        let t1 = t0 + READY_TTL + Duration::from_millis(1);
        let (p, line) = prober.probe_at(&url, t1);
        assert_eq!(p.state, AudioState::DaemonDown);
        assert_eq!(
            p.message.as_deref(),
            Some(
                format!(
                    "Speech isn't available: naru-audio isn't running at {url}. \
                     Start it with `brew services start naru-audio`."
                )
                .as_str()
            )
        );
        assert_eq!(
            line.as_deref(),
            Some(format!("warn audio state ready -> daemon_down url={url}").as_str())
        );

        // It comes back on the same port.
        let stub = Stub::start(port, READY);
        // Within the failure TTL the down answer still stands, unlogged…
        let (p, line) = prober.probe_at(&url, t1 + Duration::from_secs(1));
        assert_eq!(p.state, AudioState::DaemonDown);
        assert_eq!(line, None);
        // …and once it lapses, ready again.
        let (p, line) = prober.probe_at(&url, t1 + FAILURE_TTL + Duration::from_millis(1));
        assert_eq!(p.state, AudioState::Ready);
        assert_eq!(
            line.as_deref(),
            Some(format!("info audio state daemon_down -> ready url={url}").as_str())
        );
        drop(stub);
    }

    /// `invalidate` is the other way past a fresh ready answer: the next
    /// probe asks, whatever the clock says.
    #[test]
    fn invalidate_makes_the_next_probe_ask_again() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let url = stub.url();
        let t0 = Instant::now();
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::Ready);
        drop(stub);
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::Ready);
        prober.cache.invalidate();
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::DaemonDown);
    }

    /// A different URL (a config edit) is a miss, never the old URL's answer.
    #[test]
    fn a_changed_url_is_asked_rather_than_served_from_cache() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let t0 = Instant::now();
        assert_eq!(prober.probe_at(&stub.url(), t0).0.state, AudioState::Ready);
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = format!("http://127.0.0.1:{}", other.local_addr().unwrap().port());
        drop(other);
        let (p, _) = prober.probe_at(&dead, t0);
        assert_eq!(p.state, AudioState::DaemonDown);
        assert_eq!(p.url, dead);
    }

    #[test]
    fn model_missing_names_the_default_model_and_the_pull_command() {
        let stub = Stub::start(
            0,
            r#"{"status":"ok","version":"0.1.0","api":1,
                "stt":{"default":"parakeet-tdt-0.6b-v2-int8","ready":false,
                       "problem":{"code":"model_not_pulled",
                                  "message":"run `naru-audio pull parakeet-tdt-0.6b-v2-int8`"}}}"#,
        );
        let (p, line) = Prober::new().probe_at(&stub.url(), Instant::now());
        assert_eq!(p.state, AudioState::ModelMissing);
        assert_eq!(
            p.message.as_deref(),
            Some(
                "Speech isn't available: the model parakeet-tdt-0.6b-v2-int8 isn't \
                 downloaded. Run `naru-audio pull parakeet-tdt-0.6b-v2-int8`."
            )
        );
        assert!(
            line.unwrap()
                .starts_with("warn audio state unknown -> model_missing")
        );
    }

    #[test]
    fn another_api_version_is_incompatible() {
        let stub = Stub::start(
            0,
            r#"{"status":"ok","version":"2.3.0","api":2,
                "stt":{"default":"m","ready":true,"problem":null}}"#,
        );
        let (p, _) = Prober::new().probe_at(&stub.url(), Instant::now());
        assert_eq!(p.state, AudioState::Incompatible);
        assert_eq!(
            p.message.as_deref(),
            Some(
                "Speech isn't available: naru-audio 2.3.0 speaks API 2; this Naru \
                 needs API 1. Upgrade with `brew upgrade naru-audio`."
            )
        );
    }

    #[test]
    fn a_health_with_no_stt_block_is_an_error() {
        // The scaffold daemon's /health (design task 1) answers exactly this.
        let stub = Stub::start(0, r#"{"status":"ok","version":"0.1.0","api":1,"pid":7}"#);
        let (p, _) = Prober::new().probe_at(&stub.url(), Instant::now());
        assert_eq!(p.state, AudioState::Error);
        assert_eq!(
            p.message.as_deref(),
            Some(
                "Speech isn't available: naru-audio reported: no speech-to-text engine \
                 (/health has no stt block)"
            )
        );
    }

    #[test]
    fn other_problems_are_errors_quoting_the_daemon() {
        let (state, message) = state_of(
            r#"{"status":"ok","version":"0.1.0","api":1,
                "stt":{"default":"m","ready":false,
                       "problem":{"code":"backend_unavailable","message":"mlx requires Apple Silicon"}}}"#,
        );
        assert_eq!(state, AudioState::Error);
        assert_eq!(
            message.as_deref(),
            Some("Speech isn't available: naru-audio reported: mlx requires Apple Silicon")
        );
        // Not JSON at all — some other service on the port.
        assert_eq!(state_of("<html>hi</html>").0, AudioState::Error);
        // Not ready, no problem named.
        assert_eq!(
            state_of(r#"{"status":"ok","api":1,"stt":{"ready":false}}"#).0,
            AudioState::Error
        );
        // Ready by its own account but answering non-2xx.
        assert_eq!(
            classify(500, READY).0,
            AudioState::Error,
            "a 500 is not ready"
        );
    }

    #[test]
    fn states_serialize_to_the_wire_strings() {
        for s in [
            AudioState::Ready,
            AudioState::DaemonDown,
            AudioState::ModelMissing,
            AudioState::Incompatible,
            AudioState::Error,
        ] {
            assert_eq!(
                serde_json::to_value(s).unwrap(),
                serde_json::json!(s.as_str())
            );
        }
    }

    #[test]
    fn ttl_cache_keeps_an_empty_list_briefly_and_a_full_one_longer() {
        let cache: TtlCache<Vec<String>> = TtlCache::new();
        let t0 = Instant::now();
        let mut calls = 0;
        let mut get = |at: Instant, answer: Vec<String>| {
            cache
                .get(
                    "bin",
                    at,
                    |v| list_ttl(v),
                    || {
                        calls += 1;
                        answer
                    },
                )
                .0
        };
        assert!(get(t0, vec![]).is_empty());
        assert!(get(t0 + Duration::from_secs(1), vec!["a".into()]).is_empty());
        assert_eq!(get(t0 + FAILURE_TTL, vec!["a".into()]), vec!["a"]);
        assert_eq!(
            get(t0 + FAILURE_TTL + Duration::from_secs(9), vec![]),
            vec!["a"]
        );
        assert!(get(t0 + FAILURE_TTL + READY_TTL, vec![]).is_empty());
        assert_eq!(calls, 3);
    }

    #[test]
    fn engine_words_round_trip() {
        for e in [AudioEngine::Legacy, AudioEngine::NaruAudio] {
            assert_eq!(AudioEngine::parse(e.as_str()), Some(e));
        }
        assert_eq!(AudioEngine::parse("auris"), None);
    }
}
