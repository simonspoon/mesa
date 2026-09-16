//! The `task-stop-guard` hook (mesa task 1190) — a Claude Code `Stop` hook
//! that keeps a *task agent* from ending its turn before the mesa task it
//! was dispatched for is really handled: still `in_progress` with nothing
//! running in the background and no question filed, or closed while a
//! background shell or agent it launched is still alive.
//!
//! The shape mirrors [`crate::core::supervisor`]: one const holding the
//! script, one holding the library built-in's id, and the built-in row in
//! `core::library::BUILTINS` pointing at both. Being a [`LibraryKind::Hook`]
//! (`crate::core::types::LibraryKind::Hook`) it has a real path,
//! `.claude/hooks/task-stop-guard.sh`, and is installed by the ordinary
//! registration flow — `mesa library hook enable task-stop-guard --event
//! Stop` seeds the file and writes `~/.claude/settings.json`
//! (`docs/library.md`). Nothing in Rust runs it; the script is the whole
//! feature, and `scripts/stop-guard-check.sh` is its behavioural gate.

/// The library built-in holding [`STOP_GUARD_HOOK`]. A hook's *name* carries
/// its own extension (mesa task 1114), so the row's name is
/// [`STOP_GUARD_HOOK_NAME`] while its id stays the bare word.
pub const STOP_GUARD_HOOK_BUILTIN: &str = "task-stop-guard";

/// The built-in's name — the filename it is seeded under in `.claude/hooks/`.
pub const STOP_GUARD_HOOK_NAME: &str = "task-stop-guard.sh";

/// The hook script. Reads Claude Code's `Stop` payload on stdin and decides
/// from the session transcript plus `mesa task show`/`mesa inbox list`
/// whether the agent may end its turn. It needs only `bash`, `jq` and `mesa`
/// and it **never wedges a session**: a missing tool, an unreadable
/// transcript, a session that is not a task agent's, or any mesa error is an
/// allow (exit 0, nothing printed). A block is `{"decision":"block",
/// "reason":…}` on stdout, still exit 0.
///
/// The transcript records it reads (verified against real transcripts under
/// `~/.claude/projects/`):
///
/// * the task id — the FIRST user message, as `/execute-mesa-task <id>`
///   (`DEFAULT_TASK_EXECUTE`), a slash command recorded as
///   `<command-name>/execute-mesa-task</command-name>` +
///   `<command-args><id></command-args>`, or — only in a session launched
///   with `--agent`, marked by a `{"type":"agent-setting","agentSetting":…}`
///   header record no interactive session carries — a one-line prompt
///   ending in `task: <id>` (a customised template);
/// * a background shell — a `tool_result` reading `Command running in
///   background with ID: <id>`; a background agent — a `tool_result` reading
///   `Async agent launched successfully… agentId: <id>`;
/// * a close — a `<task-notification>` with that `<task-id>` (any status;
///   the same agent can notify more than once), whether it arrived as a
///   user record or was absorbed mid-turn into a `queue-operation` record's
///   `content` / a `queued_command` attachment's `prompt`; a
///   `KillShell`/`TaskStop` tool call naming it, or a `[Subagent hand-back]`
///   `<agent-message from="<id>">`.
pub const STOP_GUARD_HOOK: &str = r##"#!/usr/bin/env bash
# task-stop-guard.sh — a Claude Code Stop hook for mesa task agents
# (mesa task 1190). Installed with:
#   mesa library hook enable task-stop-guard --event Stop
#
# Reads the Stop payload on stdin and fires only in a session whose FIRST
# user message names a mesa task (the task-execute prompt); every other
# session is left alone. It never wedges: jq or mesa missing, an unreadable
# transcript, or any mesa error is an allow (exit 0, nothing printed).
#
# Decision — task status x pending background work x question filed:
#   in_progress, background work pending        -> allow (the harness wakes it)
#   in_progress, nothing pending, no inbox item -> block: keep going, close it,
#                                                  park it, or file the question
#   in_progress, inbox item filed for the task  -> allow
#   not in_progress, background work pending    -> block: stop what is listed
#   otherwise                                   -> allow
# Waiting on a background notification is the legitimate way to wait, which
# is why pending work allows rather than blocks — blocking would force polling.
set -u
command -v jq >/dev/null 2>&1 || exit 0
command -v mesa >/dev/null 2>&1 || exit 0

payload=$(cat) || exit 0
[ "$(jq -r '.stop_hook_active // false' <<<"$payload" 2>/dev/null)" = "true" ] && exit 0
transcript=$(jq -r '.transcript_path // empty' <<<"$payload" 2>/dev/null)
[ -n "$transcript" ] && [ -r "$transcript" ] || exit 0

# One pass over the transcript: the task id and start time off the first
# user message, then every background launch minus every close. The loose
# one-line form of the task id ("Execute this task: 12") is accepted only in
# a session launched with --agent, which writes an agent-setting header
# record no interactive session has — "please take a look at task 1" typed
# into a plain session must not make a task agent of it. A
# <task-notification> that arrived mid-turn is never a user record — it is
# absorbed as a queue-operation's content and a queued_command attachment's
# prompt — so closes are read off every record, whatever its type.
facts=$(jq -Rs '
  def text:
    if type == "string" then .
    elif type == "array" then
      map(if type == "object" then (.text // (.content | text)) else "" end) | join("\n")
    elif type == "object" then (.text // (.content | text))
    else "" end;
  def task_id($dispatched):
    [ (capture("(?:^|\\s)/execute-mesa-task\\s+(?<id>[0-9]+)") | .id),
      (capture("<command-name>/execute-(?:mesa-task|todo)</command-name>\\s*<command-args>\\s*(?<id>[0-9]+)") | .id),
      (capture("<command-name>/execute-(?:mesa-task|todo)</command-name>\\s*<command-args>.{0,200}?\"id\":\\s*(?<id>[0-9]+)"; "s") | .id),
      (select($dispatched and length <= 200 and (test("\n") | not)) | capture("\\btask:?\\s*#?(?<id>[0-9]+)\\W*$") | .id)
    ] | .[0];
  [ split("\n")[] | fromjson? | select(type == "object" and ((.isSidechain // false) | not)) ] as $rows
  | any($rows[]; .type == "agent-setting" and (.agentSetting | type == "string")) as $dispatched
  | [ $rows[] | select(.type == "user") ] as $users
  | ($users | map(select(.message.content | type == "string" or (type == "array" and any(.[]; .type == "text")))) | .[0]) as $first
  | ($first.message.content // "" | text) as $prompt
  | [ $users[] | .message.content | select(type == "array") | .[] | select(.type == "tool_result" and ((.is_error // false) | not)) | text ] as $results
  | [ $rows[] | (.message.content | text), (.content | text), (.attachment.prompt | text) ] as $texts
  | [ $rows[] | select(.type == "assistant") | .message.content | select(type == "array") | .[] | select(.type == "tool_use") ] as $calls
  | {
      task_id: ($prompt | task_id($dispatched)),
      started: ($first.timestamp // "" | sub("T"; " ") | .[0:19]),
      shells: [ $results[] | capture("running in background with ID: (?<id>[A-Za-z0-9_-]+)") | .id ],
      agents: [ $results[] | select(test("agent launched")) | capture("agentId: (?<id>[A-Za-z0-9_-]+)") | .id ],
      closed: (
        [ $texts[] | select(test("<task-notification>")) | capture("<task-id>(?<id>[A-Za-z0-9_-]+)</task-id>") | .id ]
        + [ $texts[] | select(test("Subagent hand-back")) | capture("<agent-message from=\"(?<id>[A-Za-z0-9_-]+)\"") | .id ]
        + [ $calls[] | select(.name == "KillShell") | .input.shell_id // empty ]
        + [ $calls[] | select(.name == "TaskStop") | .input.task_id // empty ]
      )
    }
  | .shells -= .closed | .agents -= .closed
' "$transcript" 2>/dev/null) || exit 0

task_id=$(jq -r '.task_id // empty' <<<"$facts")
[ -n "$task_id" ] || exit 0
status=$(mesa task show "$task_id" 2>/dev/null | jq -r '.status // empty') || exit 0
[ -n "$status" ] || exit 0
pending=$(jq -r '(.shells | map("shell " + .)) + (.agents | map("agent " + .)) | join(", ")' <<<"$facts")

block() { jq -cn --arg reason "$1" '{decision: "block", reason: $reason}'; exit 0; }

if [ "$status" = "in_progress" ]; then
  [ -n "$pending" ] && exit 0
  # A first record with no timestamp gives no "since"; nothing counts as
  # filed rather than every old item for the task.
  started=$(jq -r '.started' <<<"$facts")
  filed=false
  if [ -n "$started" ]; then
    filed=$(mesa inbox list 2>/dev/null | jq -r --argjson id "$task_id" --arg since "$started" \
      'any(.[]; .task_id == $id and .created_at >= $since)') || exit 0
  fi
  [ "$filed" = "true" ] && exit 0
  block "mesa task $task_id is still in_progress and nothing is running in the background. Keep working on it; or close it (mesa task update $task_id --status done|cancelled --result '...'); or move it back to todo/backlog with a result saying why (mesa task update $task_id --status todo --result '...'); or file the question you are stuck on (mesa inbox add --task $task_id --kind change-request '...') and then end."
fi

[ -n "$pending" ] && block "mesa task $task_id is $status but this session still has background work running: $pending. Stop each of them (KillShell for a shell, TaskStop for an agent) or wait for their notifications before ending."
exit 0
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::library::{builtin, relative_path};
    use crate::core::types::{LibraryKind, LibraryScope};
    use std::path::PathBuf;

    /// The built-in is a user-scope hook whose name carries the extension,
    /// so it lands at `.claude/hooks/task-stop-guard.sh` and its body is the
    /// script itself — an executable file, hence the shebang.
    #[test]
    fn the_builtin_is_a_hook_at_its_path_with_a_shebang() {
        let b = builtin(STOP_GUARD_HOOK_BUILTIN).expect("built-in exists");
        assert_eq!(b.name, STOP_GUARD_HOOK_NAME);
        assert_eq!(b.kind, LibraryKind::Hook);
        assert_eq!(b.scope, LibraryScope::User);
        assert_eq!(b.body, STOP_GUARD_HOOK);
        assert!(STOP_GUARD_HOOK.starts_with("#!/usr/bin/env bash\n"));
        assert_eq!(
            relative_path(b.kind, b.scope, b.name, false),
            Some(PathBuf::from(".claude/hooks/task-stop-guard.sh"))
        );
    }

    /// The script parses — `bash -n` over the body, so a stray quote in an
    /// edit is caught here rather than on the next Stop.
    #[test]
    fn the_script_parses_under_bash_n() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("bash")
            .arg("-n")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("bash");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(STOP_GUARD_HOOK.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "bash -n: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
