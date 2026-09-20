//! The server's registry of **detached** script runs (mesa task 1224) — the
//! runs the Scripts page starts, walks away from, reopens and stops.
//!
//! The whole new capability is a second *caller* of [`scripts::Streaming`],
//! not a second executor: `core::scripts` is unchanged, and so are the two
//! older run routes. A detached run is that same
//! [`scripts::Streaming::stream`] call with a different pair of closures —
//! an `emit` that **always returns `true`** (no reader owns this run, so a
//! tab closing must never kill it) and a `cancelled` that reads this
//! registry's stop flag instead of a response channel's `is_closed`. The
//! captured and streamed routes keep the opposite ownership — the client
//! hanging up stops the script — and that difference is deliberate.
//!
//! This module is not inside `scripts.rs` because the pump performs the run's
//! two db writes, and `scripts.rs`' whole point is that executing a process is
//! not storage.
//!
//! Three properties are load-bearing:
//!
//! * **The store lock is taken exactly twice per run** — once to open the row,
//!   once to close it — and *never* per output line. A chatty script would
//!   otherwise stall every other request through the single `Store` mutex.
//! * **The db write happens strictly before the registry entry is removed**,
//!   so an attach can never observe "no entry *and* a row still saying
//!   `running`" — the one state that would hang a page on a finished run.
//! * **Snapshot-and-subscribe happens under one acquisition of the entry's
//!   locks**, so no event can be missed between the replay snapshot and the
//!   live subscription, and none can be delivered twice.
//!
//! The replay buffer is bounded by `scripts`' own 64 KiB per-stream cap — the
//! pump buffers *line events*, not raw bytes, so no run can grow it without
//! bound and it needs no cap of its own. The ceiling is that cap plus one
//! JSON envelope per line, which for a script printing very short lines is
//! the larger term; a change to the cap moves this ceiling with it.

use std::collections::{BTreeMap, HashMap};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::scripts;
use super::store::{Error, SCRIPT_RUN_ABANDONED, Store};
use super::types::{Script, ScriptRunEvent, ScriptRunRecord, ScriptRunStatus};

/// The note on a run an explicit stop ended.
pub const SCRIPT_RUN_STOPPED: &str = "the run was stopped";

/// The note on a run whose output ended without an exit status ever arriving.
pub const SCRIPT_RUN_NO_EXIT: &str = "the stream ended without an exit status";

/// How many events one attached reader may fall behind before its channel is
/// full. A reader that cannot keep up is dropped from the subscriber list —
/// it went away, or its socket is wedged — and the **run carries on**.
const SUB_BUFFER: usize = 256;

/// Why a detached run could not be started. The two failures reach the API as
/// different statuses, so they stay distinguishable here rather than being
/// flattened into one string.
pub enum StartError {
    /// bash would not start — the `unavailable` shape, 502.
    Spawn(String),
    /// The run row could not be written.
    Store(Error),
}

/// One run in flight: what it has printed, who is listening, and whether it
/// has been asked to stop.
struct Entry {
    /// Every event so far in arrival order — the replay buffer for an attach
    /// that arrives mid-run. Ends with exactly one terminal event once the
    /// run is over.
    events: Mutex<Vec<ScriptRunEvent>>,
    /// Every attached reader. A sender that is full or closed is dropped: the
    /// reader is gone, which says nothing about whether the run should be.
    subs: Mutex<Vec<tokio::sync::mpsc::Sender<ScriptRunEvent>>>,
    /// The **only** stop signal. `scripts::Streaming::stream` polls it at
    /// least every 100ms, so a silent script is stopped too.
    stop: AtomicBool,
}

impl Entry {
    fn new() -> Entry {
        Entry {
            events: Mutex::new(Vec::new()),
            subs: Mutex::new(Vec::new()),
            stop: AtomicBool::new(false),
        }
    }

    /// Records one event and hands it to every live subscriber.
    fn push(&self, event: ScriptRunEvent) {
        lock(&self.events).push(event.clone());
        let mut subs = lock(&self.subs);
        subs.retain(|tx| tx.try_send(event.clone()).is_ok());
    }
}

/// Every detached run this server owns, keyed by `script_runs.id`. Held in
/// `AppState` beside the other in-memory process bookkeeping; memory-only, so
/// a restart owns nothing — which is exactly what
/// [`Store::reconcile_script_runs`] relies on.
#[derive(Default)]
pub struct Registry {
    runs: Mutex<HashMap<i64, Arc<Entry>>>,
}

impl Registry {
    pub fn new() -> Registry {
        Registry::default()
    }

    /// Starts `script` detached and returns its freshly opened row.
    ///
    /// The spawn happens **before** the row is written, so a script bash will
    /// not start leaves nothing behind — a row that never ran is never
    /// written. If the row cannot be written the [`scripts::Streaming`] is
    /// dropped, which kills the process it just started.
    ///
    /// `values` must already have passed `scripts::validate_values` (the
    /// caller does that first so a client mistake about the declared args is
    /// a 422 rather than a 502).
    pub fn start(
        self: &Arc<Self>,
        store: &Arc<Mutex<Store>>,
        script: &Script,
        values: &BTreeMap<String, String>,
        cwd: Option<&str>,
    ) -> Result<ScriptRunRecord, StartError> {
        let running = scripts::start(script, values, cwd).map_err(StartError::Spawn)?;
        let record = lock(store)
            .create_script_run(script.id, values, cwd, std::process::id() as i64)
            .map_err(StartError::Store)?;

        let entry = Arc::new(Entry::new());
        lock(&self.runs).insert(record.id, entry.clone());

        let id = record.id;
        let store = store.clone();
        let registry = self.clone();
        // A std thread, not `spawn_blocking`: this outlives every request and
        // must not occupy a tokio worker even nominally.
        std::thread::spawn(move || {
            let pump = entry.clone();
            running.stream(
                // ALWAYS true. A dead subscriber must never kill the run —
                // get this wrong and the streamed route's hang-up semantics
                // leak in here, and the run dies the moment a tab closes.
                move |event| {
                    pump.push(event);
                    true
                },
                || entry.stop.load(Ordering::Relaxed),
            );
            registry.settle(&store, id, &entry);
        });
        Ok(record)
    }

    /// Closes out a run whose `stream` has returned: classify, make sure the
    /// buffer ends with exactly one terminal event, write the row, and only
    /// **then** drop the registry entry.
    fn settle(&self, store: &Arc<Mutex<Store>>, id: i64, entry: &Arc<Entry>) {
        let stopped = entry.stop.load(Ordering::Relaxed);
        let terminal = terminal_of(&lock(&entry.events));
        let (status, exit_code, note, truncated) = match terminal {
            Some(ScriptRunEvent::Exit {
                code, truncated, ..
            }) => (ScriptRunStatus::Finished, Some(code), None, truncated),
            Some(ScriptRunEvent::Error { message }) => {
                (ScriptRunStatus::Failed, None, Some(message), false)
            }
            // `stream` kills and returns without emitting anything when it is
            // cancelled, so a stop is the no-terminal-event case with the flag
            // set; without the flag the pipes ended and the exit status never
            // came.
            _ if stopped => (
                ScriptRunStatus::Stopped,
                None,
                Some(SCRIPT_RUN_STOPPED.to_string()),
                false,
            ),
            _ => (
                ScriptRunStatus::Failed,
                None,
                Some(SCRIPT_RUN_NO_EXIT.to_string()),
                false,
            ),
        };
        // A run that ended with no terminal event of its own still owes every
        // reader one, so the live stream and a later replay of the same run
        // end the same way.
        if !lock(&entry.events).iter().any(is_terminal) {
            entry.push(ScriptRunEvent::Error {
                message: note.clone().unwrap_or_default(),
            });
        }
        let events = ndjson(&lock(&entry.events));
        let _ = lock(store).finish_script_run(
            id,
            status,
            exit_code,
            note.as_deref(),
            &events,
            truncated,
        );
        // The write is strictly before the removal: an attach must never find
        // no entry while the row still says `running`.
        let _ = lock(&self.runs).remove(&id);
        // Dropping the senders ends every attached stream.
        lock(&entry.subs).clear();
    }

    /// Replays what a live run has printed so far and subscribes to the rest,
    /// under **one** acquisition of the entry's locks — so nothing is missed
    /// at the seam and nothing is delivered twice. `None` when this server
    /// does not own the run (it finished, or it never was ours), which is the
    /// caller's signal to replay the stored log instead.
    pub fn attach(
        &self,
        id: i64,
    ) -> Option<(
        Vec<ScriptRunEvent>,
        tokio::sync::mpsc::Receiver<ScriptRunEvent>,
    )> {
        let entry = lock(&self.runs).get(&id).cloned()?;
        let events = lock(&entry.events);
        let mut subs = lock(&entry.subs);
        let (tx, rx) = tokio::sync::mpsc::channel(SUB_BUFFER);
        subs.push(tx);
        let snapshot = events.clone();
        drop(subs);
        drop(events);
        Some((snapshot, rx))
    }

    /// Asks a run to stop. `scripts::Streaming::stream`'s own 100ms cancel
    /// poll picks it up and kills the whole process group — a child the body
    /// started included. Answers false when this server does not own the run,
    /// which a caller reads as "already over", never as an error.
    pub fn stop(&self, id: i64) -> bool {
        match lock(&self.runs).get(&id) {
            Some(entry) => {
                entry.stop.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

/// The terminal event a finished run's stored log is missing, derived from its
/// row — the abandoned-by-a-restart case, whose row was written by
/// [`Store::reconcile_script_runs`] and never carried a log at all. A run that
/// is still `running` has no terminal event, and says so.
pub fn synthesized_terminal(record: &ScriptRunRecord) -> Option<ScriptRunEvent> {
    match record.status {
        ScriptRunStatus::Running => None,
        ScriptRunStatus::Finished => Some(ScriptRunEvent::Exit {
            code: record.exit_code.unwrap_or(-1),
            duration_ms: 0,
            truncated: record.truncated,
        }),
        _ => Some(ScriptRunEvent::Error {
            message: record
                .note
                .clone()
                .unwrap_or_else(|| SCRIPT_RUN_ABANDONED.to_string()),
        }),
    }
}

/// True for the two events that end a run's stream.
pub fn is_terminal(event: &ScriptRunEvent) -> bool {
    matches!(
        event,
        ScriptRunEvent::Exit { .. } | ScriptRunEvent::Error { .. }
    )
}

fn terminal_of(events: &[ScriptRunEvent]) -> Option<ScriptRunEvent> {
    events.iter().rev().find(|e| is_terminal(e)).cloned()
}

/// One event per line, exactly the bytes the stream route puts on the wire —
/// which is why replaying a stored run is "send this column" rather than a
/// reconstruction.
pub fn ndjson(events: &[ScriptRunEvent]) -> String {
    let mut out = String::new();
    for event in events {
        if let Ok(line) = serde_json::to_string(event) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

/// Whether a pid names a live process — `reconcile_script_runs`' liveness
/// check. A `kill -0` shell-out, the idiom `scripts::Streaming::kill` already
/// uses, run at most once per `running` row at start-up. A failure to ask is
/// read as **alive**, so an unanswerable question never flips another
/// server's live run to `failed`.
pub fn pid_is_live(pid: i64) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(true)
}

/// A poisoned lock is not a reason to lose a run: every holder here only ever
/// pushes to a `Vec` or reads a flag, so the data is still coherent.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::{ScriptRunStatus, ScriptStream};
    use std::time::{Duration, Instant};

    /// A registry over a tempdir-backed store holding one script with `body`.
    fn fixture(body: &str) -> (tempfile::TempDir, Arc<Mutex<Store>>, Arc<Registry>, Script) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("t.db")).unwrap();
        let script = store.create_script(None, "s", None, body, &[]).unwrap();
        (
            dir,
            Arc::new(Mutex::new(store)),
            Arc::new(Registry::new()),
            script,
        )
    }

    fn start(
        registry: &Arc<Registry>,
        store: &Arc<Mutex<Store>>,
        script: &Script,
    ) -> ScriptRunRecord {
        match registry.start(store, script, &BTreeMap::new(), None) {
            Ok(r) => r,
            Err(StartError::Spawn(m)) => panic!("spawn: {m}"),
            Err(StartError::Store(e)) => panic!("store: {e}"),
        }
    }

    /// Polls the row until it leaves `running`, or gives up.
    fn settled(store: &Arc<Mutex<Store>>, id: i64) -> ScriptRunRecord {
        let begun = Instant::now();
        loop {
            let row = lock(store).get_script_run(id).unwrap();
            if row.status != ScriptRunStatus::Running {
                return row;
            }
            assert!(begun.elapsed() < Duration::from_secs(20), "run never ended");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn texts(events: &[ScriptRunEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                ScriptRunEvent::Line { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// Drains a subscription to its end — every event the run had left.
    fn drain(
        snapshot: Vec<ScriptRunEvent>,
        mut rx: tokio::sync::mpsc::Receiver<ScriptRunEvent>,
    ) -> Vec<ScriptRunEvent> {
        let mut all = snapshot;
        while let Some(e) = rx.blocking_recv() {
            all.push(e);
        }
        all
    }

    /// The property this whole design turns on: two readers attaching at
    /// different moments each see the run's **complete** ordered output — no
    /// gap at the snapshot/subscribe seam and no duplicate across it — and
    /// each ends with exactly one terminal event.
    #[test]
    fn two_subscribers_attached_at_different_points_each_see_the_whole_run() {
        let (_dir, store, registry, script) =
            fixture("echo one; sleep 0.4; echo two >&2; sleep 0.4; echo three; exit 7");
        let run = start(&registry, &store, &script);

        let first = registry.attach(run.id).expect("live run has an entry");
        std::thread::sleep(Duration::from_millis(600));
        let second = registry.attach(run.id).expect("still running");
        let second_snapshot = second.0.clone();

        let a = drain(first.0, first.1);
        let b = drain(second.0, second.1);
        for (who, events) in [("first", &a), ("second", &b)] {
            assert_eq!(texts(events), ["one", "two", "three"], "{who}: {events:?}");
            assert_eq!(
                events.iter().filter(|e| is_terminal(e)).count(),
                1,
                "{who} saw more than one terminal event: {events:?}"
            );
            assert!(matches!(
                events.last(),
                Some(ScriptRunEvent::Exit { code: 7, .. })
            ));
        }
        // The second reader joined after the run had already printed "one"
        // and "two", so its snapshot is what carried them — the replay half
        // genuinely ran, rather than the two readers both being live from the
        // start.
        assert!(
            texts(&second_snapshot).len() >= 2,
            "the second attach replayed nothing: {second_snapshot:?}"
        );

        let row = settled(&store, run.id);
        assert_eq!(row.status, ScriptRunStatus::Finished);
        assert_eq!(row.exit_code, Some(7));
        assert_eq!(row.note, None);
        assert!(!row.truncated);
        // A nonzero exit is data here too.
        assert_eq!(lock(&store).script_run_events(run.id).unwrap(), ndjson(&a));
    }

    /// The explicit inverse of `scripts::stream_stops_when_emit_reports_the_
    /// reader_gone`: on this path a reader walking away is not a stop. Get
    /// this wrong and a run dies the moment a tab closes.
    #[test]
    fn a_subscriber_that_goes_away_does_not_stop_the_run() {
        let (_dir, store, registry, script) =
            fixture("echo started; sleep 0.6; echo finished; exit 0");
        let run = start(&registry, &store, &script);
        // Attach and drop the receiver immediately.
        drop(registry.attach(run.id).expect("live run has an entry"));

        let row = settled(&store, run.id);
        assert_eq!(row.status, ScriptRunStatus::Finished);
        assert_eq!(row.exit_code, Some(0));
        let stored = lock(&store).script_run_events(run.id).unwrap();
        assert!(
            stored.contains("finished"),
            "the run stopped when its reader left: {stored:?}"
        );
    }

    #[test]
    fn stop_kills_the_process_group_and_the_row_lands_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("pid");
        let (_d, store, registry, script) = fixture(&format!(
            "sleep 30 & echo $! > '{}'; echo started; wait",
            marker.display()
        ));
        let run = start(&registry, &store, &script);
        // Wait for the body to have started its child.
        let begun = Instant::now();
        while !marker.exists() {
            assert!(begun.elapsed() < Duration::from_secs(10), "never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(registry.stop(run.id));

        let row = settled(&store, run.id);
        assert_eq!(row.status, ScriptRunStatus::Stopped);
        assert_eq!(row.exit_code, None);
        assert_eq!(row.note.as_deref(), Some(SCRIPT_RUN_STOPPED));
        // The child the body started is in the killed process group too.
        let pid = std::fs::read_to_string(&marker).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let alive = Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the body's child survived the stop");
        // Stopping a run that is over is a no-op, not an error.
        assert!(!registry.stop(run.id));
        assert_eq!(lock(&store).get_script_run(run.id).unwrap(), row);
    }

    #[test]
    fn a_run_past_the_output_cap_lands_truncated() {
        let (_dir, store, registry, script) = fixture("yes line | head -c 70000; echo tail >&2");
        let run = start(&registry, &store, &script);
        let row = settled(&store, run.id);
        assert_eq!(row.status, ScriptRunStatus::Finished);
        assert!(row.truncated, "{row:?}");
        // The *text* is bounded by `scripts`' own 64 KiB per-stream cap, so
        // the buffer and the stored log are too — the pump buffers line
        // events, never raw bytes.
        let stored = lock(&store).script_run_events(run.id).unwrap();
        let text: usize = stored
            .lines()
            .filter_map(|l| serde_json::from_str::<ScriptRunEvent>(l).ok())
            .map(|e| match e {
                ScriptRunEvent::Line { text, .. } => text.len(),
                _ => 0,
            })
            .sum();
        assert!(text <= 64 * 1024, "output text past the cap: {text}");
    }

    /// The db write happens strictly before the entry is removed, so a reader
    /// racing the end of a run can never see "nothing to attach to **and** a
    /// row that still says `running`" — the one state that hangs a page on a
    /// run that is already over.
    #[test]
    fn an_attach_never_sees_no_entry_while_the_row_still_says_running() {
        let (_dir, store, registry, script) = fixture("echo x; exit 0");
        let run = start(&registry, &store, &script);
        let begun = Instant::now();
        loop {
            // Ask in this order on purpose: if the entry is gone, the row must
            // already be closed.
            let attached = registry.attach(run.id).is_some();
            let row = lock(&store).get_script_run(run.id).unwrap();
            if !attached {
                assert_ne!(
                    row.status,
                    ScriptRunStatus::Running,
                    "the entry went before the row was written"
                );
                break;
            }
            assert!(begun.elapsed() < Duration::from_secs(20), "run never ended");
        }
    }

    #[test]
    fn a_synthesized_terminal_event_stands_in_for_a_log_that_never_got_one() {
        let (_dir, store, registry, script) = fixture("exit 0");
        let run = start(&registry, &store, &script);
        let mut row = settled(&store, run.id);
        assert!(matches!(
            synthesized_terminal(&row),
            Some(ScriptRunEvent::Exit { code: 0, .. })
        ));
        row.status = ScriptRunStatus::Failed;
        row.note = Some(SCRIPT_RUN_ABANDONED.to_string());
        assert!(matches!(
            synthesized_terminal(&row),
            Some(ScriptRunEvent::Error { message }) if message == SCRIPT_RUN_ABANDONED
        ));
        row.status = ScriptRunStatus::Running;
        assert!(synthesized_terminal(&row).is_none());
    }

    #[test]
    fn ndjson_is_one_event_per_line() {
        let events = vec![
            ScriptRunEvent::Line {
                stream: ScriptStream::Stdout,
                t: 1,
                text: "a".into(),
            },
            ScriptRunEvent::Exit {
                code: 0,
                duration_ms: 2,
                truncated: false,
            },
        ];
        let out = ndjson(&events);
        assert_eq!(out.lines().count(), 2);
        assert!(out.ends_with('\n'));
        let back: Vec<ScriptRunEvent> = out
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(back, events);
    }
}
