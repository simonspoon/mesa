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
//! * by environment: `MESA_ARG_<NAME>` (upper-cased, `-`→`_`).
//!
//! so a value of `; rm -rf / #` is a string the script may read and never
//! syntax. `agents.rs::spawn_script` holds the same line the same way, and the
//! `env_remove`-then-`env` sweep is copied from it: a declared argument with no
//! value on this call is genuinely *unset*, so `set -u` fires instead of the
//! body silently reading a stale or empty value.
//!
//! Runs are capture-and-return: all three stdio piped, no timeout (matching
//! hooks and agents), output capped. A nonzero exit is **data** — the only
//! `Err` is "bash could not be spawned".

use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

use crate::core::types::{Script, ScriptArg, ScriptArgKind, ScriptRun};

/// Prefix of every environment variable this module sets on a run.
pub const ALL_ENV_PREFIX: &str = "MESA_ARG_";

/// Captured stdout/stderr are capped so a chatty script can't balloon the JSON
/// the UI and CLI print (the `hooks.rs` cap, same size).
const OUTPUT_CAP: usize = 64 * 1024;

/// The environment variable one declared argument arrives in: the name
/// upper-cased with `-` folded to `_`, under [`ALL_ENV_PREFIX`]. `Store`
/// constrains an arg name to `^[A-Za-z_][A-Za-z0-9_-]*$` precisely so this
/// mapping is total and collision-free.
pub fn env_var_name(arg_name: &str) -> String {
    format!(
        "{ALL_ENV_PREFIX}{}",
        arg_name.to_ascii_uppercase().replace('-', "_")
    )
}

/// Every variable name this call *could* set — the sweep list for
/// `env_remove`, so a variable the script declares but this call has no value
/// for is removed rather than inherited from mesa's own environment.
pub fn env_var_names(args: &[ScriptArg]) -> Vec<String> {
    args.iter().map(|a| env_var_name(&a.name)).collect()
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
    // call actually has — copied from `agents.rs::spawn_script`, and the whole
    // reason `${MESA_ARG_X-UNSET}` can tell "not supplied" from "empty".
    for var in env_var_names(&script.args) {
        cmd.env_remove(var);
    }
    for (name, value) in &resolved {
        cmd.env(env_var_name(name), value);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to run bash for script {:?}: {e}", script.name))?;
    // Close stdin from a thread while wait_with_output drains stdout/stderr:
    // writing inline could deadlock against a script that fills its output
    // pipe first (hooks.rs:107-115). Scripts get no payload — an empty stdin
    // that reaches EOF, so `read` in a body returns rather than hanging.
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(b"");
    });
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
    fn env_var_name_upper_cases_and_folds_dashes() {
        assert_eq!(env_var_name("target"), "MESA_ARG_TARGET");
        assert_eq!(env_var_name("dry-run"), "MESA_ARG_DRY_RUN");
        assert_eq!(
            env_var_names(&[arg("a", ScriptArgKind::Text, false)]),
            vec!["MESA_ARG_A".to_string()]
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
            "printf '%s|%s|%s' \"$0\" \"$1\" \"$MESA_ARG_DRY_RUN\"",
            vec![
                arg("dry-run", ScriptArgKind::Text, true),
                arg("second", ScriptArgKind::Text, true),
            ],
        );
        let out = run(&s, &values(&[("dry-run", "yes"), ("second", "two")]), None).unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "demo|yes|yes");
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
            "set -u; printf '%s' \"${MESA_ARG_NOTE-UNSET}\"",
            vec![arg("note", ScriptArgKind::Text, false)],
        );
        // Even with the variable set in mesa's own environment, the sweep
        // removes it: "not supplied" must never read a stale value.
        unsafe { std::env::set_var("MESA_ARG_NOTE", "stale") };
        let out = run(&s, &values(&[]), None).unwrap();
        unsafe { std::env::remove_var("MESA_ARG_NOTE") };
        assert_eq!(out.stdout, "UNSET");
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

    #[test]
    fn capped_truncates_on_a_char_boundary() {
        let big = "é".repeat(OUTPUT_CAP); // 2 bytes each
        let (cut, truncated) = capped(big.as_bytes());
        assert!(truncated);
        assert!(cut.ends_with("[truncated]"));
        assert_eq!(capped(b"small"), ("small".to_string(), false));
    }
}
