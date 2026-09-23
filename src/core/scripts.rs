//! Running a user-authored [`Script`]. Storage lives in `Store`; executing a
//! process is not storage, so it lives here — the `hooks.rs` shape, applied to
//! a record instead of a config string.
//!
//! The load-bearing property, and the reason this module exists at all: **no
//! argument value is ever interpolated into a string a shell parses**. The
//! script body goes to `bash -c` as one verbatim argument, and the values
//! reach it two ways bash *sets* rather than parses —
//!
//! * positionally: `bash -c <body> <script-name> <v1> <v2> …` in declared
//!   order, so the body reads `"$1"`, `"$2"`, … (`$0` is the script's name);
//! * by environment: `NARU_ARG_<NAME>` (upper-cased, `-`→`_`), and
//!   `MESA_ARG_<NAME>` beside it with the identical value, so a script written
//!   before the rename (mesa task 1301) keeps working.
//!
//! so a value of `; rm -rf / #` is a string the script may read and never
//! syntax. (The agent hooks in `config.rs` hold the same line the other way
//! round — quoting each value into the script text — because there the
//! *template* is the user's and the values are mesa's; here the body is the
//! user's and the values are typed in at run time, so they stay out of band.)
//! The `env_remove`-then-`env` sweep makes a declared argument with no value
//! on this call genuinely *unset*, so `set -u` fires instead of the body
//! silently reading a stale or empty value.
//!
//! Runs come in two shapes over one [`command`]: capture-and-return ([`run`],
//! the CLI's and `POST /api/scripts/{id}/run`'s) and line-by-line streaming
//! ([`start`] + [`Streaming::stream`], the Scripts page's). Both pipe all three
//! stdio, have no timeout (matching hooks and agents) and cap each stream at
//! 64 KiB. A nonzero exit is **data** — the only `Err` is "bash could not be
//! spawned".

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::core::types::{
    Script, ScriptArg, ScriptArgKind, ScriptRun, ScriptRunEvent, ScriptStream,
};

/// Prefixes of every environment variable this module sets on a run: each
/// argument is exported under both, `NARU_ARG_` the primary name and
/// `MESA_ARG_` the pre-rename one (mesa task 1324), with the identical value.
pub const ENV_PREFIXES: [&str; 2] = ["NARU_ARG_", "MESA_ARG_"];

/// Captured stdout/stderr are capped so a chatty script can't balloon the JSON
/// the UI and CLI print (the `hooks.rs` cap, same size).
const OUTPUT_CAP: usize = 64 * 1024;

/// The environment variables one declared argument arrives in: the name
/// upper-cased with `-` folded to `_`, under each of [`ENV_PREFIXES`]. `Store`
/// constrains an arg name to `^[A-Za-z_][A-Za-z0-9_-]*$` precisely so this
/// mapping is total and collision-free.
pub fn env_var_names_for(arg_name: &str) -> [String; 2] {
    let suffix = arg_name.to_ascii_uppercase().replace('-', "_");
    ENV_PREFIXES.map(|prefix| format!("{prefix}{suffix}"))
}

/// Every variable name this call *could* set, under both prefixes — the sweep
/// list for `env_remove`, so a variable the script declares but this call has
/// no value for is removed rather than inherited from mesa's own environment.
pub fn env_var_names(args: &[ScriptArg]) -> Vec<String> {
    args.iter()
        .flat_map(|a| env_var_names_for(&a.name))
        .collect()
}

/// Checks a supplied value map against the declared arguments and returns the
/// resolved values, keyed by arg name. Pure: the CLI and the API both call it,
/// so they cannot diverge on what a valid call is.
///
/// Four ways to fail, and only four: a required argument with neither a value
/// nor a default; a key that is not declared; a `Number` whose value is not an
/// `f64`; a `Choice` whose value is not one of its choices. Defaults fill in
/// for an absent optional argument; an optional argument with no default is
/// simply absent from the result, which is what makes it *unset* on the child
/// rather than empty. A `Bool` value is by convention the literal `"true"` or
/// `"false"` — the form only ever emits those, and the shell reads whatever
/// arrives as a string either way.
pub fn validate_values(
    args: &[ScriptArg],
    values: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    for key in values.keys() {
        if !args.iter().any(|a| &a.name == key) {
            return Err(format!("{key:?} is not an argument of this script"));
        }
    }
    let mut resolved = BTreeMap::new();
    for arg in args {
        let supplied = values.get(&arg.name).map(String::as_str);
        let value = match supplied.or(arg.default.as_deref()) {
            Some(v) => v,
            None if arg.required => {
                return Err(format!("argument {:?} is required", arg.name));
            }
            None => continue,
        };
        match arg.kind {
            ScriptArgKind::Number => {
                if value.trim().parse::<f64>().is_err() {
                    return Err(format!(
                        "argument {:?} must be a number, got {value:?}",
                        arg.name
                    ));
                }
            }
            ScriptArgKind::Choice => {
                let ok = arg
                    .choices
                    .as_ref()
                    .is_some_and(|c| c.iter().any(|c| c == value));
                if !ok {
                    return Err(format!(
                        "argument {:?} must be one of {}, got {value:?}",
                        arg.name,
                        arg.choices.clone().unwrap_or_default().join(", ")
                    ));
                }
            }
            ScriptArgKind::Text | ScriptArgKind::Bool => {}
        }
        resolved.insert(arg.name.clone(), value.to_string());
    }
    Ok(resolved)
}

/// The one `bash -c` invocation both run shapes use: body verbatim, values
/// positionally and by environment, the unset sweep, the working directory.
/// `values` must already be resolved by [`validate_values`].
fn command(script: &Script, resolved: &BTreeMap<String, String>, cwd: Option<&str>) -> Command {
    let mut cmd = Command::new("bash");
    // The body is one argument, never a fragment of a command line. `$0` is
    // the script's name so `set -u` diagnostics and `basename $0` read right.
    cmd.arg("-c").arg(&script.body).arg(&script.name);
    // Positional values in *declared* order, so `$1`, `$2`, … line up with the
    // arg list the form was generated from. An argument with no value on this
    // call still occupies its position (as an empty string) — dropping it
    // would silently shift every later `$n`. The environment, not the
    // positions, is where "unset" is expressible.
    for arg in &script.args {
        cmd.arg(resolved.get(&arg.name).map(String::as_str).unwrap_or(""));
    }
    // Remove every variable this feature can set, then set only the ones this
    // call actually has — the whole reason `${NARU_ARG_X-UNSET}` (and its
    // `MESA_ARG_X` twin) can tell "not supplied" from "empty".
    for var in env_var_names(&script.args) {
        cmd.env_remove(var);
    }
    for (name, value) in resolved {
        for var in env_var_names_for(name) {
            cmd.env(var, value);
        }
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Close stdin from a thread while the caller drains stdout/stderr: writing
/// inline could deadlock against a script that fills its output pipe first
/// (hooks.rs:107-115). Scripts get no payload — an empty stdin that reaches
/// EOF, so `read` in a body returns rather than hanging.
fn close_stdin(child: &mut Child) -> std::thread::JoinHandle<()> {
    let mut stdin = child.stdin.take().expect("stdin was piped");
    std::thread::spawn(move || {
        let _ = stdin.write_all(b"");
    })
}

/// Validates `values`, then runs `script.body` under `bash -c` in `cwd`
/// (inheriting the caller's directory when `None`) and captures the outcome.
///
/// `Err` only when bash itself cannot be spawned or its output cannot be
/// collected; the script's own nonzero exit is reported in
/// [`ScriptRun::exit_code`] with a success status, exactly like a `HookRun`.
pub fn run(
    script: &Script,
    values: &BTreeMap<String, String>,
    cwd: Option<&str>,
) -> Result<ScriptRun, String> {
    let resolved = validate_values(&script.args, values)?;
    let mut child = command(script, &resolved, cwd)
        .spawn()
        .map_err(|e| format!("failed to run bash for script {:?}: {e}", script.name))?;
    let writer = close_stdin(&mut child);
    let out = child
        .wait_with_output()
        .map_err(|e| format!("failed to collect output of script {:?}: {e}", script.name))?;
    let _ = writer.join();

    let (stdout, out_cut) = capped(&out.stdout);
    let (stderr, err_cut) = capped(&out.stderr);
    Ok(ScriptRun {
        script_id: script.id,
        // None = killed by a signal; -1 keeps exit_code a plain number in the
        // JSON contract.
        exit_code: out.status.code().unwrap_or(-1),
        stdout,
        stderr,
        truncated: out_cut || err_cut,
    })
}

/// A script started by [`start`], not yet read. Dropping it without calling
/// [`Streaming::stream`] kills it.
pub struct Streaming {
    child: Child,
    started: Instant,
    name: String,
}

/// Validates `values` and starts the script exactly as [`run`] would — the
/// same [`command`] — except in a process group of its own, so a stop can
/// kill whatever the body started too. Split from [`Streaming::stream`] so a
/// spawn failure is still a status code, before any byte is on the wire.
pub fn start(
    script: &Script,
    values: &BTreeMap<String, String>,
    cwd: Option<&str>,
) -> Result<Streaming, String> {
    let resolved = validate_values(&script.args, values)?;
    let mut cmd = command(script, &resolved, cwd);
    cmd.process_group(0);
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to run bash for script {:?}: {e}", script.name))?;
    Ok(Streaming {
        child,
        started: Instant::now(),
        name: script.name.clone(),
    })
}

/// What a pipe reader hands the streaming loop.
enum Pumped {
    Line(ScriptStream, u64, String),
    /// The pipe reached EOF; `true` when its cap cut something.
    Done(bool),
}

/// How often the streaming loop asks `cancelled` while the script is silent.
const CANCEL_POLL: Duration = Duration::from_millis(100);

impl Streaming {
    /// Emits every output line as it is read, stdout and stderr interleaved in
    /// arrival order, then one `exit` (or one `error`) event. Each stream is
    /// capped at [`OUTPUT_CAP`] bytes like the captured run: past it, that
    /// stream's lines are read and dropped (so the script never blocks on a
    /// full pipe) and the exit event says `truncated`.
    ///
    /// The run stops — the whole process group is killed and nothing more is
    /// emitted — as soon as `emit` returns `false` or `cancelled` returns
    /// `true`, which is how a client that walks away stops the script: the
    /// caller's `cancelled` is asked at least every [`CANCEL_POLL`], so a
    /// script that prints nothing is stopped too.
    pub fn stream(
        mut self,
        mut emit: impl FnMut(ScriptRunEvent) -> bool,
        cancelled: impl Fn() -> bool,
    ) {
        let writer = close_stdin(&mut self.child);
        let (tx, rx) = mpsc::channel();
        let stdout = self.child.stdout.take().expect("stdout was piped");
        let stderr = self.child.stderr.take().expect("stderr was piped");
        // Both readers feed one channel, so its order is arrival order.
        pump(stdout, ScriptStream::Stdout, self.started, tx.clone());
        pump(stderr, ScriptStream::Stderr, self.started, tx);

        let mut open = 2;
        let mut truncated = false;
        while open > 0 {
            if cancelled() {
                return self.kill();
            }
            match rx.recv_timeout(CANCEL_POLL) {
                Ok(Pumped::Line(stream, t, text)) => {
                    if !emit(ScriptRunEvent::Line { stream, t, text }) {
                        return self.kill();
                    }
                }
                Ok(Pumped::Done(cut)) => {
                    open -= 1;
                    truncated |= cut;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let _ = writer.join();
        let event = match self.child.wait() {
            Ok(status) => ScriptRunEvent::Exit {
                code: status.code().unwrap_or(-1),
                duration_ms: self.started.elapsed().as_millis() as u64,
                truncated,
            },
            Err(e) => ScriptRunEvent::Error {
                message: format!("failed to collect output of script {:?}: {e}", self.name),
            },
        };
        emit(event);
    }

    /// SIGKILLs the script's process group (its own, from [`start`]), then
    /// reaps the leader. The readers are left to finish on their own: a
    /// descendant that escaped the group may still hold a pipe open.
    fn kill(&mut self) {
        let pgid = self.child.id();
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pgid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Streaming {
    fn drop(&mut self) {
        // Reaped already on every path through `stream`; this is the unread
        // case, which must not leave a script running with nobody reading it.
        if let Ok(None) = self.child.try_wait() {
            self.kill();
        }
    }
}

/// Reads one pipe line by line on its own thread, capping it at
/// [`OUTPUT_CAP`] bytes.
fn pump(
    pipe: impl Read + Send + 'static,
    stream: ScriptStream,
    started: Instant,
    tx: mpsc::Sender<Pumped>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut used = 0usize;
        let mut cut = false;
        let mut buf = Vec::new();
        loop {
            let room = OUTPUT_CAP - used;
            if room == 0 {
                // Keep draining so the script never blocks on a full pipe.
                cut |= std::io::copy(&mut reader, &mut std::io::sink()).unwrap_or(0) > 0;
                break;
            }
            buf.clear();
            let n = match (&mut reader).take(room as u64).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            used += n;
            let whole = buf.last() == Some(&b'\n');
            if whole {
                buf.pop();
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
            } else if used == OUTPUT_CAP {
                // The cap landed mid-line; whatever follows is dropped.
                cut = true;
            }
            let t = started.elapsed().as_millis() as u64;
            let text = String::from_utf8_lossy(&buf).into_owned();
            if tx.send(Pumped::Line(stream, t, text)).is_err() {
                return;
            }
        }
        let _ = tx.send(Pumped::Done(cut));
    });
}

/// Lossy UTF-8, truncated to [`OUTPUT_CAP`] on a char boundary. The flag is
/// what `ScriptRun::truncated` reports, so the UI can say so rather than making
/// the reader spot the marker.
fn capped(bytes: &[u8]) -> (String, bool) {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    if s.len() > OUTPUT_CAP {
        let cut = (0..=OUTPUT_CAP).rev().find(|i| s.is_char_boundary(*i));
        s.truncate(cut.unwrap_or(0));
        s.push_str("\n[truncated]");
        return (s, true);
    }
    (s, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arg(name: &str, kind: ScriptArgKind, required: bool) -> ScriptArg {
        ScriptArg {
            name: name.to_string(),
            label: None,
            kind,
            required,
            default: None,
            choices: match kind {
                ScriptArgKind::Choice => Some(vec!["a".into(), "b".into()]),
                _ => None,
            },
        }
    }

    fn script(body: &str, args: Vec<ScriptArg>) -> Script {
        Script {
            id: 7,
            project_id: None,
            name: "demo".into(),
            description: None,
            body: body.to_string(),
            args,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        }
    }

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn env_var_names_upper_case_fold_dashes_and_carry_both_prefixes() {
        assert_eq!(
            env_var_names_for("target"),
            ["NARU_ARG_TARGET".to_string(), "MESA_ARG_TARGET".to_string()]
        );
        assert_eq!(
            env_var_names_for("dry-run"),
            [
                "NARU_ARG_DRY_RUN".to_string(),
                "MESA_ARG_DRY_RUN".to_string()
            ]
        );
        assert_eq!(
            env_var_names(&[arg("a", ScriptArgKind::Text, false)]),
            vec!["NARU_ARG_A".to_string(), "MESA_ARG_A".to_string()]
        );
    }

    #[test]
    fn validate_values_rejects_a_missing_required_argument() {
        let args = [arg("target", ScriptArgKind::Text, true)];
        let err = validate_values(&args, &values(&[])).unwrap_err();
        assert!(err.contains("required"), "{err}");
    }

    #[test]
    fn validate_values_rejects_an_undeclared_key() {
        let args = [arg("target", ScriptArgKind::Text, false)];
        let err = validate_values(&args, &values(&[("other", "x")])).unwrap_err();
        assert!(err.contains("not an argument"), "{err}");
    }

    #[test]
    fn validate_values_rejects_a_non_numeric_number() {
        let args = [arg("count", ScriptArgKind::Number, true)];
        let err = validate_values(&args, &values(&[("count", "twelve")])).unwrap_err();
        assert!(err.contains("must be a number"), "{err}");
        // A float and a negative are both numbers; the value stays a string.
        let ok = validate_values(&args, &values(&[("count", "-1.5")])).unwrap();
        assert_eq!(ok.get("count").map(String::as_str), Some("-1.5"));
    }

    #[test]
    fn validate_values_rejects_a_choice_outside_its_list() {
        let args = [arg("mode", ScriptArgKind::Choice, true)];
        let err = validate_values(&args, &values(&[("mode", "c")])).unwrap_err();
        assert!(err.contains("must be one of"), "{err}");
        assert!(validate_values(&args, &values(&[("mode", "b")])).is_ok());
    }

    #[test]
    fn validate_values_fills_defaults_and_omits_absent_optionals() {
        let mut with_default = arg("env", ScriptArgKind::Text, true);
        with_default.default = Some("staging".into());
        let bare = arg("note", ScriptArgKind::Text, false);
        let resolved = validate_values(&[with_default, bare], &values(&[])).unwrap();
        assert_eq!(resolved.get("env").map(String::as_str), Some("staging"));
        // An optional with no default is *absent*, not empty — that is what
        // makes its variable unset on the child.
        assert_eq!(resolved.get("note"), None);
    }

    #[test]
    fn run_passes_values_positionally_and_by_environment() {
        let s = script(
            "printf '%s|%s|%s|%s' \"$0\" \"$1\" \"$NARU_ARG_DRY_RUN\" \"$MESA_ARG_DRY_RUN\"",
            vec![
                arg("dry-run", ScriptArgKind::Text, true),
                arg("second", ScriptArgKind::Text, true),
            ],
        );
        let out = run(&s, &values(&[("dry-run", "yes"), ("second", "two")]), None).unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "demo|yes|yes|yes");
        assert_eq!(out.script_id, 7);
    }

    #[test]
    fn run_never_lets_a_value_become_shell_syntax() {
        let s = script(
            "printf '%s' \"$1\"",
            vec![arg("t", ScriptArgKind::Text, true)],
        );
        let hostile = "; echo pwned #";
        let out = run(&s, &values(&[("t", hostile)]), None).unwrap();
        assert_eq!(out.stdout, hostile);
    }

    #[test]
    fn run_leaves_an_unsupplied_argument_genuinely_unset() {
        let s = script(
            "set -u; printf '%s|%s' \"${NARU_ARG_NOTE-UNSET}\" \"${MESA_ARG_NOTE-UNSET}\"",
            vec![arg("note", ScriptArgKind::Text, false)],
        );
        // Even with both variables set in mesa's own environment, the sweep
        // removes them: "not supplied" must never read a stale value.
        unsafe { std::env::set_var("NARU_ARG_NOTE", "stale") };
        unsafe { std::env::set_var("MESA_ARG_NOTE", "stale") };
        let out = run(&s, &values(&[]), None).unwrap();
        unsafe { std::env::remove_var("NARU_ARG_NOTE") };
        unsafe { std::env::remove_var("MESA_ARG_NOTE") };
        assert_eq!(out.stdout, "UNSET|UNSET");
    }

    #[test]
    fn run_reports_a_nonzero_exit_as_data_with_streams_separated() {
        let s = script("echo out; echo err >&2; exit 3", vec![]);
        let out = run(&s, &values(&[]), None).unwrap();
        assert_eq!(out.exit_code, 3);
        assert_eq!(out.stdout, "out\n");
        assert_eq!(out.stderr, "err\n");
        assert!(!out.truncated);
    }

    #[test]
    fn run_honors_the_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let canon = dir.path().canonicalize().unwrap();
        let s = script("pwd", vec![]);
        let out = run(&s, &values(&[]), Some(canon.to_str().unwrap())).unwrap();
        assert_eq!(out.stdout.trim(), canon.to_str().unwrap());
    }

    #[test]
    fn run_rejects_bad_values_before_spawning_anything() {
        let s = script(
            "echo should-not-run",
            vec![arg("t", ScriptArgKind::Text, true)],
        );
        assert!(run(&s, &values(&[]), None).is_err());
    }

    #[test]
    fn run_truncates_oversized_output() {
        let s = script(
            &format!("head -c {} /dev/zero | tr '\\0' 'x'", OUTPUT_CAP + 1024),
            vec![],
        );
        let out = run(&s, &values(&[]), None).unwrap();
        assert!(out.truncated);
        assert!(out.stdout.ends_with("[truncated]"), "no marker");
        assert!(out.stdout.len() <= OUTPUT_CAP + "\n[truncated]".len());
    }

    fn stream_all(s: &Script, vals: &BTreeMap<String, String>) -> Vec<ScriptRunEvent> {
        let mut events = Vec::new();
        start(s, vals, None).unwrap().stream(
            |e| {
                events.push(e);
                true
            },
            || false,
        );
        events
    }

    #[test]
    fn stream_interleaves_both_pipes_in_arrival_order_then_exits() {
        let s = script(
            "echo one; sleep 0.2; echo two >&2; sleep 0.2; printf 'three'; exit 4",
            vec![],
        );
        let events = stream_all(&s, &values(&[]));
        let lines: Vec<(ScriptStream, &str)> = events
            .iter()
            .filter_map(|e| match e {
                ScriptRunEvent::Line { stream, text, .. } => Some((*stream, text.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            lines,
            vec![
                (ScriptStream::Stdout, "one"),
                (ScriptStream::Stderr, "two"),
                (ScriptStream::Stdout, "three"),
            ]
        );
        let ts: Vec<u64> = events
            .iter()
            .filter_map(|e| match e {
                ScriptRunEvent::Line { t, .. } => Some(*t),
                _ => None,
            })
            .collect();
        assert!(ts[1] >= 150 && ts[2] >= ts[1] + 150, "{ts:?}");
        match events.last().unwrap() {
            ScriptRunEvent::Exit {
                code,
                duration_ms,
                truncated,
            } => {
                assert_eq!(*code, 4);
                assert!(*duration_ms >= 400);
                assert!(!truncated);
            }
            other => panic!("last event {other:?}"),
        }
    }

    #[test]
    fn stream_shares_the_value_plumbing_of_run() {
        let s = script(
            "printf '%s|%s\\n' \"$1\" \"${NARU_ARG_NOTE-UNSET}\"",
            vec![
                arg("t", ScriptArgKind::Text, true),
                arg("note", ScriptArgKind::Text, false),
            ],
        );
        let events = stream_all(&s, &values(&[("t", "; echo pwned #")]));
        assert!(matches!(
            &events[0],
            ScriptRunEvent::Line { text, .. } if text == "; echo pwned #|UNSET"
        ));
        assert!(start(&s, &values(&[]), None).is_err(), "validation first");
    }

    #[test]
    fn stream_caps_each_stream_and_reports_truncation() {
        let s = script(
            &format!("yes line | head -c {} ; echo tail >&2", OUTPUT_CAP + 4096),
            vec![],
        );
        let events = stream_all(&s, &values(&[]));
        let out_bytes: usize = events
            .iter()
            .filter_map(|e| match e {
                ScriptRunEvent::Line {
                    stream: ScriptStream::Stdout,
                    text,
                    ..
                } => Some(text.len() + 1),
                _ => None,
            })
            .sum();
        assert!(out_bytes <= OUTPUT_CAP + 1, "{out_bytes}");
        // The other stream is capped on its own.
        assert!(events.iter().any(|e| matches!(
            e,
            ScriptRunEvent::Line { stream: ScriptStream::Stderr, text, .. } if text == "tail"
        )));
        assert!(matches!(
            events.last(),
            Some(ScriptRunEvent::Exit {
                truncated: true,
                code: 0,
                ..
            })
        ));
    }

    #[test]
    fn stream_kills_the_process_group_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("pid");
        // A child of the body, in the body's group: the stop must reach it.
        let s = script(
            &format!(
                "sleep 30 & echo $! > '{}'; echo started; wait",
                marker.display()
            ),
            vec![],
        );
        let begun = Instant::now();
        let mut seen = 0;
        let mut events = Vec::new();
        start(&s, &values(&[]), None).unwrap().stream(
            |e| {
                seen += 1;
                events.push(e);
                true
            },
            || begun.elapsed() > Duration::from_millis(300),
        );
        assert!(begun.elapsed() < Duration::from_secs(5));
        assert_eq!(seen, 1, "only the line, no exit event: {events:?}");
        let pid = std::fs::read_to_string(&marker).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let alive = Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the body's child survived the stop");
    }

    #[test]
    fn stream_stops_when_emit_reports_the_reader_gone() {
        let s = script("while :; do echo x; sleep 0.01; done", vec![]);
        let begun = Instant::now();
        let mut n = 0;
        start(&s, &values(&[]), None).unwrap().stream(
            |_| {
                n += 1;
                n < 3
            },
            || false,
        );
        assert_eq!(n, 3);
        assert!(begun.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn capped_truncates_on_a_char_boundary() {
        let big = "é".repeat(OUTPUT_CAP); // 2 bytes each
        let (cut, truncated) = capped(big.as_bytes());
        assert!(truncated);
        assert!(cut.ends_with("[truncated]"));
        assert_eq!(capped(b"small"), ("small".to_string(), false));
    }
}
