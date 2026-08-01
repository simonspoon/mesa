//! User config: the command lines mesa uses when it starts a coding agent.
//!
//! mesa spawns an agent from exactly three places — the todo-watcher's
//! dispatch, the inbox-watcher's triage, and the Agents surface's "add agent"
//! button. Each used to be a hardcoded `claude --bg …` argv, so swapping the
//! binary, the persona, or the slash command meant a rebuild. Each is now a
//! **command template** in `~/.mesa/config.json`:
//!
//! ```json
//! {
//!   "commands": {
//!     "todo-watcher":  "claude --bg --agent swe --name {name} -- \"/execute-mesa-task {id}\"",
//!     "inbox-watcher": "claude --bg --agent swe --name {name} -- \"/inbox-triage {id}\"",
//!     "agent-spawn":   "claude --bg --agent swe -- {prompt}"
//!   }
//! }
//! ```
//!
//! A template is **argv, not a shell command** — tokenized here and handed to
//! `Command` directly, with no `sh -c` anywhere. That is load-bearing, not
//! stylistic: the watchers pass a task name / inbox body (untrusted free
//! text) as the session `--name`, and what makes that safe is that it reaches
//! the agent as one `Command::arg`. Placeholders are substituted *after*
//! tokenization, so a value can never split into extra argv entries or be
//! reinterpreted as flags — see [`expand`].
//!
//! Unlike `hooks.json` (a genuine `sh -c` string, [`crate::core::hooks`]) this
//! file only ever names a program and its arguments.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::core::types::ConfigCommand;

/// The todo-watcher's dispatch command (`docs/todo-watcher.md`).
pub const TODO_WATCHER: &str = "todo-watcher";
/// The inbox-watcher's triage command (`docs/inbox-watcher.md`).
pub const INBOX_WATCHER: &str = "inbox-watcher";
/// The Agents surface's "add agent" command (`docs/agents.md`).
pub const AGENT_SPAWN: &str = "agent-spawn";

/// Every configurable command, in the order the docs and the Settings page
/// list them. The single source of truth for "which keys mesa configures" —
/// [`default_command`] answers the same question one key at a time.
pub const ACTIONS: [&str; 3] = [TODO_WATCHER, INBOX_WATCHER, AGENT_SPAWN];

/// Built-in default for [`TODO_WATCHER`] — the argv mesa shipped before the
/// config file existed, spelled as a template. `{bin}`/`{agent}` carry the
/// pre-existing `MESA_CLAUDE_BIN`/`MESA_CLAUDE_AGENT` env seams, so with no
/// config file the resulting argv is byte-identical to the hardcoded one.
///
/// Note the quotes around the prompt: a slash command and its argument are
/// **one** argv entry (`claude` takes the prompt as a single positional), and
/// tokenization is by whitespace. Unquoted, `/execute-mesa-task {id}` would
/// arrive as two arguments and the id would be lost.
pub const DEFAULT_TODO_WATCHER: &str =
    r#"{bin} --bg --agent {agent} --name {name} -- "/execute-mesa-task {id}""#;
/// Built-in default for [`INBOX_WATCHER`]; see [`DEFAULT_TODO_WATCHER`].
pub const DEFAULT_INBOX_WATCHER: &str =
    r#"{bin} --bg --agent {agent} --name {name} -- "/inbox-triage {id}""#;
/// Built-in default for [`AGENT_SPAWN`]. No `{id}`/`{name}`: this spawn is
/// driven by a request body, not a mesa record, and the prompt is optional —
/// absent, the `-- {prompt}` pair drops out and the session starts idle.
pub const DEFAULT_AGENT_SPAWN: &str = "{bin} --bg --agent {agent} -- {prompt}";

/// The built-in template for `action`, or `None` if `action` isn't one of the
/// three. Public so the docs check and the API can report the shipped default.
pub fn default_command(action: &str) -> Option<&'static str> {
    match action {
        TODO_WATCHER => Some(DEFAULT_TODO_WATCHER),
        INBOX_WATCHER => Some(DEFAULT_INBOX_WATCHER),
        AGENT_SPAWN => Some(DEFAULT_AGENT_SPAWN),
        _ => None,
    }
}

/// `MESA_CONFIG_FILE` if set (the test seam, mirroring `MESA_HOOKS_FILE`),
/// else `~/.mesa/config.json`. `~/.mesa` may also be the JSON file itself —
/// accepted because "a config in ~/.mesa" reads both ways, and a user who
/// wrote one file shouldn't get silent no-ops.
pub fn config_file() -> PathBuf {
    if let Ok(p) = std::env::var("MESA_CONFIG_FILE") {
        return PathBuf::from(p);
    }
    let home = directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_default();
    let dot = home.join(".mesa");
    if dot.is_file() {
        return dot;
    }
    dot.join("config.json")
}

/// The `commands` map. Deliberately not `deny_unknown_fields`: the file is
/// meant to grow other sections, and an unknown key must not break spawning.
#[derive(Debug, Default, Deserialize)]
struct Config {
    #[serde(default)]
    commands: HashMap<String, String>,
}

/// The configured template for `action`: `Ok(None)` when the file or the key
/// is absent, or the value is blank (all three mean "use the built-in
/// default"); `Err` when the file exists but can't be read or parsed — a
/// broken config must be visible, not silently ignored (same rule as
/// `hooks::command_for`).
pub fn command_for(action: &str) -> Result<Option<String>, String> {
    command_in(&config_file(), action)
}

fn command_in(path: &Path, action: &str) -> Result<Option<String>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config
        .commands
        .get(action)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

/// Every action's current setting, for the Settings page
/// (`GET /api/config`): the configured template (`None` = falling back), the
/// built-in default it falls back to, and the placeholders it may use.
///
/// `Err` on a file that exists but can't be read or parsed — the same rule the
/// spawn path follows, for the same reason: a broken config must never read as
/// "unconfigured", least of all on the surface that edits it.
pub fn settings() -> Result<Vec<ConfigCommand>, String> {
    settings_in(&config_file())
}

fn settings_in(path: &Path) -> Result<Vec<ConfigCommand>, String> {
    ACTIONS
        .iter()
        .map(|action| {
            Ok(ConfigCommand {
                action: (*action).to_string(),
                value: command_in(path, action)?,
                default: default_command(action).unwrap_or_default().to_string(),
                placeholders: offered_placeholders(action)
                    .iter()
                    .map(|p| (*p).to_string())
                    .collect(),
            })
        })
        .collect()
}

/// Why a [`save_commands`] call didn't happen. Split so the API can answer
/// 422 for "your template is wrong" and 502 for "this machine's config file is
/// unreadable" — the same split the spawn path already draws.
#[derive(Debug, PartialEq)]
pub enum SaveError {
    /// An unknown key, or a template the spawn path would later reject.
    Validation(String),
    /// The file couldn't be read, parsed or written.
    Unavailable(String),
}

/// Writes the `commands` entries named in `updates` into the config file.
///
/// - A blank value **removes** the key, which is how the Settings page says
///   "back to the built-in default" — the same meaning blank already has on
///   the read side ([`command_in`]).
/// - Every template is validated *before* anything is written, so a rejected
///   save leaves the file exactly as it was and a half-applied batch is not a
///   reachable state.
/// - Keys this call doesn't name, and any other top-level section of the file,
///   are preserved verbatim — the file is documented as free to grow sections
///   mesa doesn't know about, and an editor that silently dropped them would
///   break that promise.
pub fn save_commands(updates: &HashMap<String, String>) -> Result<(), SaveError> {
    save_commands_in(&config_file(), updates)
}

fn save_commands_in(path: &Path, updates: &HashMap<String, String>) -> Result<(), SaveError> {
    let mut actions: Vec<&String> = updates.keys().collect();
    actions.sort();
    for action in &actions {
        if default_command(action).is_none() {
            return Err(SaveError::Validation(format!(
                "unknown command {action:?}; mesa configures {}",
                ACTIONS.join(", ")
            )));
        }
        let template = updates[*action].trim();
        if !template.is_empty() {
            validate(action, template).map_err(SaveError::Validation)?;
        }
    }

    let mut root: serde_json::Value = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            SaveError::Unavailable(format!("malformed mesa config {}: {e}", path.display()))
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => {
            return Err(SaveError::Unavailable(format!(
                "cannot read {}: {e}",
                path.display()
            )));
        }
    };
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let commands = object
        .entry("commands")
        .or_insert_with(|| serde_json::json!({}));
    let Some(commands) = commands.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"commands\" is not a JSON object",
            path.display()
        )));
    };
    for action in actions {
        let template = updates[action].trim();
        if template.is_empty() {
            commands.remove(action);
        } else {
            commands.insert(
                action.clone(),
                serde_json::Value::String(template.to_string()),
            );
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// Write via a sibling temp file + rename, so a spawn reading the config
/// concurrently sees either the old file or the new one, never a truncated
/// one — the file is read on **every** spawn, with no lock between us.
fn write_atomically(path: &Path, body: &str) -> Result<(), SaveError> {
    let unavailable =
        |e: std::io::Error| SaveError::Unavailable(format!("cannot write {}: {e}", path.display()));
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(unavailable)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, body).map_err(unavailable)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        unavailable(e)
    })
}

/// Rejects a template the spawn path would fail on later — an unterminated
/// quote, a placeholder this action doesn't offer, or one that expands to an
/// empty argv. Every value is supplied, so only template-shaped mistakes are
/// caught here; the per-call drop rule stays [`expand`]'s business.
///
/// The point is *when* the failure lands: at save time, in the editor, rather
/// than at the next dispatch, in a watcher log the user isn't reading.
pub fn validate(action: &str, template: &str) -> Result<(), String> {
    let vars = Vars {
        bin: Some("claude"),
        agent: Some("swe"),
        id: Some(1),
        name: Some("name"),
        prompt: Some("prompt"),
    };
    expand(action, template, &vars).map(|_| ())
}

/// The values a template's placeholders may resolve to. A `None` field is
/// "not available for this call" — see [`expand`]'s drop rule. `bin`/`agent`
/// are filled from the env seams by `agents::argv_for`, not by callers.
#[derive(Debug, Default, Clone)]
pub struct Vars<'a> {
    pub bin: Option<&'a str>,
    pub agent: Option<&'a str>,
    pub id: Option<i64>,
    pub name: Option<&'a str>,
    pub prompt: Option<&'a str>,
}

impl Vars<'_> {
    /// `Some(value)` if this placeholder is available, `None` if it is a
    /// recognized placeholder with no value on this call. `Err` for a name
    /// this action doesn't offer at all.
    fn lookup(&self, key: &str, action: &str) -> Result<Option<String>, String> {
        let (offered, value) = match key {
            "bin" => (true, self.bin.map(str::to_string)),
            "agent" => (true, self.agent.map(str::to_string)),
            "id" => (action != AGENT_SPAWN, self.id.map(|i| i.to_string())),
            "name" => (action != AGENT_SPAWN, self.name.map(str::to_string)),
            "prompt" => (action == AGENT_SPAWN, self.prompt.map(str::to_string)),
            _ => (false, None),
        };
        if !offered {
            return Err(format!(
                "unsupported placeholder {{{key}}} in the {action} command; \
                 {action} offers {}",
                offered_list(action)
            ));
        }
        Ok(value)
    }
}

/// The placeholder names `action` offers, `{}`-delimited and in doc order.
/// Shared by the "unsupported placeholder" error below and by [`settings`],
/// so the Settings page can only ever advertise placeholders [`Vars::lookup`]
/// actually accepts.
pub fn offered_placeholders(action: &str) -> &'static [&'static str] {
    if action == AGENT_SPAWN {
        &["{bin}", "{agent}", "{prompt}"]
    } else {
        &["{bin}", "{agent}", "{id}", "{name}"]
    }
}

fn offered_list(action: &str) -> String {
    offered_placeholders(action).join(", ")
}

/// Expands `template` into an argv for `action`.
///
/// Two passes, in this order — the order is the safety property:
/// 1. [`tokenize`] splits the template on whitespace, honoring quotes, so the
///    token count is fixed by the *template* alone.
/// 2. Each token's `{placeholder}`s are replaced in place. A substituted value
///    is never re-split or re-quoted, so untrusted text (a task name, an
///    inbox body) lands as exactly one argv entry.
///
/// A token holding a placeholder that has no value is **dropped**, along with
/// an immediately preceding token that starts with `-`. That one rule is what
/// makes the defaults reproduce today's behavior: with no `--name` available
/// `--name {name}` disappears as a pair (rather than leaving a dangling flag
/// that would swallow the next argument), and with no prompt `-- {prompt}`
/// goes too.
pub fn expand(action: &str, template: &str, vars: &Vars) -> Result<Vec<String>, String> {
    let tokens = tokenize(template)
        .map_err(|e| format!("cannot parse the {action} command {template:?}: {e}"))?;
    let mut argv: Vec<String> = Vec::with_capacity(tokens.len());
    for token in &tokens {
        match substitute(action, token, vars)? {
            Some(arg) => argv.push(arg),
            None => {
                if argv.last().is_some_and(|prev| prev.starts_with('-')) {
                    argv.pop();
                }
            }
        }
    }
    if argv.is_empty() {
        return Err(format!(
            "the {action} command {template:?} expands to nothing"
        ));
    }
    Ok(argv)
}

/// `Ok(None)` = this token must be dropped (an available-but-unset
/// placeholder). A `{` that opens no valid placeholder is a literal brace.
fn substitute(action: &str, token: &str, vars: &Vars) -> Result<Option<String>, String> {
    let mut out = String::with_capacity(token.len());
    let mut rest = token;
    while let Some(open) = rest.find('{') {
        let (before, from_brace) = rest.split_at(open);
        out.push_str(before);
        let Some(close) = from_brace.find('}') else {
            out.push_str(from_brace);
            return Ok(Some(out));
        };
        let key = &from_brace[1..close];
        match vars.lookup(key, action)? {
            Some(value) => out.push_str(&value),
            None => return Ok(None),
        }
        rest = &from_brace[close + 1..];
    }
    out.push_str(rest);
    Ok(Some(out))
}

/// Splits a command template into tokens: whitespace-separated, with `'…'`
/// (literal) and `"…"` (backslash-escapable) quoting, so a template can carry
/// an argument containing spaces. Quotes are removed; an empty quoted string
/// is a real, empty token. `Err` on an unterminated quote or a trailing
/// backslash — a typo the user should see, not a silently mangled argv.
///
/// Not `shell_words`-complete on purpose: no expansion, no substitution, no
/// operators. `|`, `>`, `&&`, `$VAR` are ordinary characters here, because
/// nothing downstream is a shell.
pub fn tokenize(s: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if started {
                    tokens.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => cur.push(c),
                        None => return Err("unterminated single quote".to_string()),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(esc) => cur.push(esc),
                            None => return Err("trailing backslash".to_string()),
                        },
                        Some(c) => cur.push(c),
                        None => return Err("unterminated double quote".to_string()),
                    }
                }
            }
            '\\' => {
                started = true;
                match chars.next() {
                    Some(esc) => cur.push(esc),
                    None => return Err("trailing backslash".to_string()),
                }
            }
            c => {
                started = true;
                cur.push(c);
            }
        }
    }
    if started {
        tokens.push(cur);
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &Path, json: &str) -> PathBuf {
        let path = dir.join("config.json");
        std::fs::write(&path, json).unwrap();
        path
    }

    #[test]
    fn command_in_missing_file_is_unconfigured() {
        assert_eq!(
            command_in(Path::new("/nonexistent/config.json"), TODO_WATCHER),
            Ok(None)
        );
    }

    #[test]
    fn command_in_reads_a_command_and_misses_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "mytool run {id}"}}"#,
        );
        assert_eq!(
            command_in(&path, TODO_WATCHER).unwrap().as_deref(),
            Some("mytool run {id}")
        );
        assert_eq!(command_in(&path, INBOX_WATCHER).unwrap(), None);
    }

    #[test]
    fn command_in_treats_blank_and_missing_section_as_unconfigured() {
        let dir = tempfile::tempdir().unwrap();
        // A blank value falls back to the default rather than expanding to an
        // empty argv — the natural way to "un-set" one command.
        let path = write_config(dir.path(), r#"{"commands": {"todo-watcher": "   "}}"#);
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
        let path = write_config(dir.path(), r#"{"other": {"x": 1}}"#);
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
    }

    #[test]
    fn command_in_rejects_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = command_in(&path, TODO_WATCHER).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
    }

    fn update(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn settings_reports_every_action_with_its_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "mytool run {id}"}}"#,
        );
        let settings = settings_in(&path).unwrap();
        assert_eq!(settings.len(), ACTIONS.len());
        assert_eq!(settings[0].action, TODO_WATCHER);
        assert_eq!(settings[0].value.as_deref(), Some("mytool run {id}"));
        assert_eq!(settings[0].default, DEFAULT_TODO_WATCHER);
        // An unconfigured action is `None` — "falling back", not "empty".
        assert_eq!(settings[1].action, INBOX_WATCHER);
        assert_eq!(settings[1].value, None);
        assert_eq!(settings[1].default, DEFAULT_INBOX_WATCHER);
        // The placeholder vocabulary is per-action, matching `Vars::lookup`.
        assert_eq!(
            settings[0].placeholders,
            ["{bin}", "{agent}", "{id}", "{name}"]
        );
        assert_eq!(settings[2].action, AGENT_SPAWN);
        assert_eq!(settings[2].placeholders, ["{bin}", "{agent}", "{prompt}"]);
    }

    #[test]
    fn settings_surfaces_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = settings_in(&path).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
    }

    #[test]
    fn save_commands_writes_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        // The file need not exist yet — nor its parent directory.
        let path = dir.path().join("nested").join("config.json");
        save_commands_in(&path, &update(&[(AGENT_SPAWN, "  mytool -- {prompt}  ")])).unwrap();
        // Stored trimmed, and visible to the ordinary read path immediately.
        assert_eq!(
            command_in(&path, AGENT_SPAWN).unwrap().as_deref(),
            Some("mytool -- {prompt}")
        );
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
    }

    #[test]
    fn save_commands_preserves_untouched_keys_and_other_sections() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"other": {"x": 1}, "commands": {"todo-watcher": "mytool {id}"}}"#,
        );
        save_commands_in(&path, &update(&[(INBOX_WATCHER, "mytool triage {id}")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // A section mesa knows nothing about survives the edit verbatim.
        assert_eq!(written["other"]["x"], 1);
        assert_eq!(written["commands"]["todo-watcher"], "mytool {id}");
        assert_eq!(written["commands"]["inbox-watcher"], "mytool triage {id}");
    }

    #[test]
    fn save_commands_clears_a_key_on_blank() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "mytool {id}", "agent-spawn": "mytool"}}"#,
        );
        save_commands_in(&path, &update(&[(TODO_WATCHER, "   ")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Removed, not stored blank: the default is expressed by absence.
        assert!(written["commands"].get(TODO_WATCHER).is_none());
        assert_eq!(written["commands"]["agent-spawn"], "mytool");
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
    }

    #[test]
    fn save_commands_rejects_a_bad_template_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"commands": {"todo-watcher": "mytool {id}"}}"#;
        let path = write_config(dir.path(), before);
        // Unsupported placeholder for this action…
        let err =
            save_commands_in(&path, &update(&[(TODO_WATCHER, "mytool {prompt}")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unsupported placeholder")),
            "{err:?}"
        );
        // …an unterminated quote…
        let err = save_commands_in(&path, &update(&[(AGENT_SPAWN, "mytool \"oops")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unterminated")),
            "{err:?}"
        );
        // …and a key mesa doesn't configure.
        let err = save_commands_in(&path, &update(&[("tsak", "mytool")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unknown command")),
            "{err:?}"
        );
        // Every rejection is total: the file is byte-identical.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn save_commands_is_all_or_nothing_across_a_batch() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"commands": {}}"#;
        let path = write_config(dir.path(), before);
        // One good entry, one bad one — the good one must not land either.
        let err = save_commands_in(
            &path,
            &update(&[(TODO_WATCHER, "mytool {id}"), (AGENT_SPAWN, "mytool {id}")]),
        )
        .unwrap_err();
        assert!(matches!(err, SaveError::Validation(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn save_commands_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = save_commands_in(&path, &update(&[(TODO_WATCHER, "mytool {id}")])).unwrap_err();
        // Unavailable, not validation: the user's template was fine, the file
        // on this machine isn't — and overwriting it would destroy content.
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn saved_templates_expand_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        save_commands_in(
            &path,
            &update(&[(TODO_WATCHER, r#"mytool --name {name} -- "/go {id}""#)]),
        )
        .unwrap();
        let template = command_in(&path, TODO_WATCHER).unwrap().unwrap();
        let vars = Vars {
            id: Some(7),
            name: Some("a b"),
            ..Vars::default()
        };
        assert_eq!(
            expand(TODO_WATCHER, &template, &vars).unwrap(),
            ["mytool", "--name", "a b", "--", "/go 7"]
        );
    }

    #[test]
    fn tokenize_splits_on_whitespace_and_honors_quotes() {
        assert_eq!(tokenize("claude --bg").unwrap(), ["claude", "--bg"]);
        assert_eq!(tokenize("  a\t b \n").unwrap(), ["a", "b"]);
        assert_eq!(
            tokenize(r#"a "two words" 'and more'"#).unwrap(),
            ["a", "two words", "and more"]
        );
        // Quotes join, they don't separate: adjacent runs are one token.
        assert_eq!(tokenize(r#"--name="a b""#).unwrap(), ["--name=a b"]);
        assert_eq!(tokenize(r#"a "" b"#).unwrap(), ["a", "", "b"]);
        assert_eq!(tokenize(r#""a\"b" c\ d"#).unwrap(), [r#"a"b"#, "c d"]);
        // No shell downstream, so operators are literal characters.
        assert_eq!(tokenize("a | b > c").unwrap(), ["a", "|", "b", ">", "c"]);
        assert_eq!(tokenize("$HOME").unwrap(), ["$HOME"]);
    }

    #[test]
    fn tokenize_rejects_unterminated_quotes_and_backslash() {
        assert!(tokenize(r#"a "b"#).unwrap_err().contains("double quote"));
        assert!(tokenize("a 'b").unwrap_err().contains("single quote"));
        assert!(tokenize("a b\\").unwrap_err().contains("backslash"));
    }

    #[test]
    fn default_templates_reproduce_the_pre_config_argv() {
        // The exact argv mesa hardcoded before this config existed. If any of
        // these three change, the check scripts' stub-argv assertions and the
        // agent CLI contract change with them.
        let vars = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            id: Some(731),
            name: Some("mesa: do the thing"),
            ..Default::default()
        };
        assert_eq!(
            expand(TODO_WATCHER, DEFAULT_TODO_WATCHER, &vars).unwrap(),
            [
                "claude",
                "--bg",
                "--agent",
                "swe",
                "--name",
                "mesa: do the thing",
                "--",
                "/execute-mesa-task 731",
            ]
        );
        assert_eq!(
            expand(INBOX_WATCHER, DEFAULT_INBOX_WATCHER, &vars).unwrap(),
            [
                "claude",
                "--bg",
                "--agent",
                "swe",
                "--name",
                "mesa: do the thing",
                "--",
                "/inbox-triage 731",
            ]
        );
        let spawn = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            prompt: Some("look at the tests"),
            ..Default::default()
        };
        assert_eq!(
            expand(AGENT_SPAWN, DEFAULT_AGENT_SPAWN, &spawn).unwrap(),
            [
                "claude",
                "--bg",
                "--agent",
                "swe",
                "--",
                "look at the tests"
            ]
        );
    }

    #[test]
    fn absent_value_drops_the_token_and_its_flag() {
        // No agent (MESA_CLAUDE_AGENT="") → `--agent {agent}` vanishes as a
        // pair; no prompt → so does `-- {prompt}`. Both are today's behavior.
        let vars = Vars {
            bin: Some("claude"),
            ..Default::default()
        };
        assert_eq!(
            expand(AGENT_SPAWN, DEFAULT_AGENT_SPAWN, &vars).unwrap(),
            ["claude", "--bg"]
        );
        let named = Vars {
            bin: Some("claude"),
            id: Some(7),
            ..Default::default()
        };
        assert_eq!(
            expand(TODO_WATCHER, DEFAULT_TODO_WATCHER, &named).unwrap(),
            ["claude", "--bg", "--", "/execute-mesa-task 7"]
        );
        // A dropped token only takes a *flag* with it, never a positional.
        let vars = Vars {
            bin: Some("t"),
            id: Some(1),
            ..Default::default()
        };
        assert_eq!(
            expand(TODO_WATCHER, "{bin} run {name}", &vars).unwrap(),
            ["t", "run"]
        );
    }

    #[test]
    fn untrusted_values_stay_one_argv_token() {
        // The whole point of substituting after tokenizing: a name full of
        // spaces, quotes and shell metacharacters is one argument, and the
        // argv length is fixed by the template.
        let hostile = r#"drop "; rm -rf / #' --dangerously-skip-permissions"#;
        let vars = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            id: Some(1),
            name: Some(hostile),
            ..Default::default()
        };
        let argv = expand(TODO_WATCHER, DEFAULT_TODO_WATCHER, &vars).unwrap();
        assert_eq!(argv.len(), 8);
        assert_eq!(argv[5], hostile);
    }

    #[test]
    fn placeholders_are_scoped_to_the_action() {
        let vars = Vars {
            bin: Some("claude"),
            id: Some(1),
            prompt: Some("p"),
            ..Default::default()
        };
        // agent-spawn has no mesa record behind it, so no {id}/{name}…
        let err = expand(AGENT_SPAWN, "{bin} {id}", &vars).unwrap_err();
        assert!(err.contains("{id}"), "{err}");
        assert!(err.contains("{bin}, {agent}, {prompt}"), "{err}");
        // …and the watchers' prompt is theirs to write, not mesa's to inject.
        let err = expand(TODO_WATCHER, "{bin} {prompt}", &vars).unwrap_err();
        assert!(err.contains("{prompt}"), "{err}");
        let err = expand(TODO_WATCHER, "{bin} {nope}", &vars).unwrap_err();
        assert!(err.contains("{nope}"), "{err}");
    }

    #[test]
    fn expand_handles_braces_that_are_not_placeholders() {
        let vars = Vars {
            bin: Some("t"),
            id: Some(5),
            ..Default::default()
        };
        // An unclosed brace is literal text, and a placeholder can sit inside
        // a larger token (`mesa-{id}` is one argument).
        assert_eq!(
            expand(TODO_WATCHER, "{bin} a{b mesa-{id}", &vars).unwrap(),
            ["t", "a{b", "mesa-5"]
        );
    }

    #[test]
    fn expand_rejects_a_template_that_yields_no_argv() {
        let vars = Vars::default();
        assert!(
            expand(TODO_WATCHER, "   ", &vars)
                .unwrap_err()
                .contains("nothing")
        );
        assert!(
            expand(TODO_WATCHER, "{name}", &vars)
                .unwrap_err()
                .contains("nothing")
        );
        assert!(
            expand(TODO_WATCHER, r#"a "b"#, &vars)
                .unwrap_err()
                .contains("double quote")
        );
    }

    #[test]
    fn every_default_names_a_known_action() {
        for action in [TODO_WATCHER, INBOX_WATCHER, AGENT_SPAWN] {
            assert!(default_command(action).is_some(), "{action}");
        }
        assert_eq!(default_command("task-execute"), None);
    }
}
