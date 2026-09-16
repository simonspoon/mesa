#!/usr/bin/env bash
# task-stop-guard gate (mesa task 1190): runs the `task-stop-guard` library
# built-in — a Claude Code Stop hook — against synthetic transcripts and a
# throwaway MESA_DB, with `mesa` on PATH being the debug binary. The script
# is extracted from `mesa library show task-stop-guard.sh` so what is tested
# is exactly what `mesa library hook enable task-stop-guard --event Stop`
# would seed to ~/.claude/hooks/. Nothing here touches a real ~/.claude:
# HOME is a throwaway too.
#
# The decision table it pins (docs/library.md "The task-stop-guard hook"):
#   * a session whose first user message names no task -> allow;
#   * in_progress + nothing pending + no inbox item    -> block, the reason
#     naming the task, `mesa task update` and `mesa inbox add`;
#   * in_progress + a pending background shell         -> allow;
#   * done + a pending background agent                -> block, listing it;
#   * done + nothing pending                           -> allow;
#   * a launch closed by a <task-notification> (as a user record or
#     absorbed mid-turn into a queue-operation record), a KillShell or a
#     TaskStop is no longer pending;
#   * in_progress + an inbox item filed for the task since the session
#     started -> allow (an older item does not count, and a first record
#     with no timestamp counts nothing as filed);
#   * the loose one-line task-id form ("Execte this task: N") is honoured
#     only with the agent-setting header a --agent launch writes; "please
#     take a look at task N" in a plain session -> allow;
#   * stop_hook_active: true                           -> allow;
#   * an unknown task id, an unreadable transcript     -> allow (never wedge);
#   * every allow prints nothing and exits 0; every block exits 0 too.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
BIN="$PWD/target/debug"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME="$TMP/home"
mkdir -p "$HOME"
export PATH="$BIN:$PATH"
MESA=mesa

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

# ---- the hook under test, extracted from the library ----
HOOK="$TMP/task-stop-guard.sh"
"$MESA" library show task-stop-guard.sh | jq -r .body >"$HOOK"
chmod +x "$HOOK"
head -1 "$HOOK" | grep -q '^#!' || fail "the built-in body must start with a shebang"
bash -n "$HOOK" || fail "bash -n on the built-in body"
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$HOOK" || fail "shellcheck on the built-in body"
  ok "shellcheck: clean at -S warning"
fi
ok "task-stop-guard.sh extracted from the library, parses under bash -n"

# ---- fixtures ----
"$MESA" project create "Guard" --no-git >/dev/null
P=$("$MESA" project list | jq -r '.[0].id')
T_PROG=$("$MESA" task create "$P" "In progress task" | jq -r .id)
"$MESA" task update "$T_PROG" --status in_progress >/dev/null
T_DONE=$("$MESA" task create "$P" "Done task" | jq -r .id)
"$MESA" task update "$T_DONE" --status done >/dev/null
T_INBOX=$("$MESA" task create "$P" "Task with a question" | jq -r .id)
"$MESA" task update "$T_INBOX" --status in_progress >/dev/null
T_OLD=$("$MESA" task create "$P" "Task with an old item" | jq -r .id)
"$MESA" task update "$T_OLD" --status in_progress >/dev/null
# An inbox item filed BEFORE the session starts must not count as its question.
"$MESA" inbox add --task "$T_OLD" --kind change-request "an older question" >/dev/null
ok "fixtures: an in_progress, a done and two questioned tasks"

# Transcript timestamps are ISO with a T and Z; mesa's are `datetime('now')`.
# A session that "started" a minute ago covers the inbox item filed below;
# one that "starts" a minute from now sees every item so far as older.
STARTED=$(date -u -v-60S +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d '60 seconds ago' +%Y-%m-%dT%H:%M:%S.000Z)
LATER=$(date -u -v+60S +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d '60 seconds' +%Y-%m-%dT%H:%M:%S.000Z)
"$MESA" inbox add --task "$T_INBOX" --kind change-request "which way?" >/dev/null

# transcript <file> <first-user-text> [more JSONL lines...] — the records are
# the shapes real transcripts carry (verified against ~/.claude/projects/).
transcript() {
  local file=$1 prompt=$2; shift 2
  {
    jq -cn --arg p "$prompt" --arg ts "$STARTED" \
      '{type:"user",timestamp:$ts,message:{role:"user",content:$p}}'
    for line in "$@"; do printf '%s\n' "$line"; done
  } >"$file"
}
transcript_no_ts() { # <file> <first-user-text> — a first record carrying no timestamp
  jq -cn --arg p "$2" '{type:"user",message:{role:"user",content:$p}}' >"$1"
}
# The header record a session launched with --agent carries and an
# interactive one does not — the second signal the loose one-line task-id
# form requires.
agent_setting() { jq -cn '{type:"agent-setting",agentSetting:"supervisor"}'; }
shell_launch() { # <shell id>
  jq -cn --arg id "$1" '{type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_1",content:("Command running in background with ID: " + $id + ". Output is being written to: /tmp/x.output. You will be notified when it completes."),is_error:false}]}}'
}
agent_launch() { # <agent id>
  jq -cn --arg id "$1" '{type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_2",content:[{type:"text",text:("Async agent launched successfully. (This tool result is internal metadata.)\nagentId: " + $id + " (internal ID - do not mention to user.)\nThe agent is working in the background.")}]}]}}'
}
notification() { # <id> <status>
  jq -cn --arg id "$1" --arg st "$2" '{type:"user",message:{role:"user",content:("<task-notification>\n<task-id>" + $id + "</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>" + $st + "</status>\n<summary>done</summary>\n</task-notification>")}}'
}
absorbed() { # <id> — a notification that landed mid-turn: a queue-operation record, no user record at all
  jq -cn --arg id "$1" '{type:"queue-operation",operation:"remove",reason:"absorbed_mid_turn",content:("<task-notification>\n<task-id>" + $id + "</task-id>\n<status>failed</status>\n<summary>killed</summary>\n</task-notification>")}'
}
kill_shell() { jq -cn --arg id "$1" '{type:"assistant",message:{role:"assistant",content:[{type:"tool_use",id:"toolu_9",name:"KillShell",input:{shell_id:$id}}]}}'; }
task_stop() { jq -cn --arg id "$1" '{type:"assistant",message:{role:"assistant",content:[{type:"tool_use",id:"toolu_8",name:"TaskStop",input:{task_id:$id}}]}}'; }

# hook <transcript> [stop_hook_active] — runs the hook with a Stop payload,
# leaving OUT and CODE. Every path must exit 0.
hook() {
  local payload
  payload=$(jq -cn --arg t "$1" --argjson a "${2:-false}" \
    '{session_id:"s1",transcript_path:$t,stop_hook_active:$a,cwd:"/tmp"}')
  set +e
  OUT=$("$HOOK" <<<"$payload" 2>"$TMP/stderr")
  CODE=$?
  set -e
  [ "$CODE" -eq 0 ] || fail "hook must exit 0 (got $CODE; stderr: $(cat "$TMP/stderr"))"
}
allowed() { [ -z "$OUT" ] || fail "$1: expected allow (no output), got: $OUT"; ok "$1: allow"; }
blocked() { # <label> <substring>...
  local label=$1; shift
  [ "$(jq -r .decision <<<"$OUT" 2>/dev/null)" = "block" ] || fail "$label: expected block, got: $OUT"
  local reason; reason=$(jq -r .reason <<<"$OUT")
  for want in "$@"; do
    case "$reason" in *"$want"*) ;; *) fail "$label: reason lacks '$want': $reason" ;; esac
  done
  ok "$label: block ($reason)"
}

# ================= not a task agent =================
transcript "$TMP/plain.jsonl" "Please refactor the parser, mesa task 9999 style is fine." "$(shell_launch bzzz)"
hook "$TMP/plain.jsonl"; allowed "a session whose first message names no task"

# ================= in_progress, nothing pending =================
transcript "$TMP/prog.jsonl" "/execute-mesa-task $T_PROG"
hook "$TMP/prog.jsonl"
blocked "in_progress + nothing pending" "task $T_PROG" "in_progress" "mesa task update $T_PROG" "mesa inbox add --task $T_PROG"

# the slash-command record shape and a customised one-line template too
transcript "$TMP/slash.jsonl" "<command-message>execute-mesa-task</command-message>
<command-name>/execute-mesa-task</command-name>
<command-args>$T_PROG</command-args>"
hook "$TMP/slash.jsonl"; blocked "the <command-name>/<command-args> record shape" "task $T_PROG"
transcript "$TMP/custom.jsonl" "Execte this task: $T_PROG" "$(agent_setting)"
hook "$TMP/custom.jsonl"; blocked "a one-line customised template ending in the id, in a --agent session" "task $T_PROG"
# ...but without the --agent header the same loose form is an ordinary prompt
transcript "$TMP/chat.jsonl" "please take a look at task $T_PROG"
hook "$TMP/chat.jsonl"; allowed "a one-line interactive prompt naming the task, no --agent header"
transcript "$TMP/custom-plain.jsonl" "Execte this task: $T_PROG"
hook "$TMP/custom-plain.jsonl"; allowed "the customised template form without the --agent header"
# the exact forms need no header
transcript "$TMP/slash-plain.jsonl" "/execute-mesa-task $T_PROG" "$(agent_setting)"
hook "$TMP/slash-plain.jsonl"; blocked "/execute-mesa-task with the --agent header too" "task $T_PROG"

# ================= in_progress, pending shell =================
transcript "$TMP/prog-shell.jsonl" "/execute-mesa-task $T_PROG" "$(shell_launch bq1w2e3r4)"
hook "$TMP/prog-shell.jsonl"; allowed "in_progress + a pending background shell"

# ...and once its notification lands, it is pending no more
transcript "$TMP/prog-shell-done.jsonl" "/execute-mesa-task $T_PROG" "$(shell_launch bq1w2e3r4)" "$(notification bq1w2e3r4 completed)"
hook "$TMP/prog-shell-done.jsonl"; blocked "in_progress + a shell whose notification landed" "task $T_PROG"

# ================= done, pending agent =================
transcript "$TMP/done-agent.jsonl" "/execute-mesa-task $T_DONE" "$(agent_launch a1b2c3d4e5f6a7b8c)"
hook "$TMP/done-agent.jsonl"
blocked "done + a pending background agent" "task $T_DONE is done" "agent a1b2c3d4e5f6a7b8c"

# a failed notification, a TaskStop and a KillShell each close a launch
transcript "$TMP/done-closed.jsonl" "/execute-mesa-task $T_DONE" \
  "$(agent_launch a1b2c3d4e5f6a7b8c)" "$(notification a1b2c3d4e5f6a7b8c failed)" \
  "$(agent_launch a2222222222222222)" "$(task_stop a2222222222222222)" \
  "$(shell_launch b33333333)" "$(kill_shell b33333333)"
hook "$TMP/done-closed.jsonl"; allowed "done + launches closed by notification/TaskStop/KillShell"

# a notification absorbed mid-turn (a queue-operation, never a user record) closes too
transcript "$TMP/done-absorbed.jsonl" "/execute-mesa-task $T_DONE" "$(shell_launch b55555555)" "$(absorbed b55555555)"
hook "$TMP/done-absorbed.jsonl"; allowed "done + a shell whose notification was absorbed mid-turn"

# one closed, one still open: the reason lists exactly the open one
transcript "$TMP/done-mixed.jsonl" "/execute-mesa-task $T_DONE" \
  "$(shell_launch b33333333)" "$(kill_shell b33333333)" "$(shell_launch b44444444)"
hook "$TMP/done-mixed.jsonl"
blocked "done + one open shell of two" "shell b44444444"
case "$(jq -r .reason <<<"$OUT")" in *b33333333*) fail "a killed shell must not be listed" ;; esac
ok "the killed shell is not in the list"

# ================= done, nothing pending =================
transcript "$TMP/done.jsonl" "/execute-mesa-task $T_DONE"
hook "$TMP/done.jsonl"; allowed "done + nothing pending"

# ================= in_progress, inbox item filed =================
transcript "$TMP/asked.jsonl" "/execute-mesa-task $T_INBOX"
hook "$TMP/asked.jsonl"; allowed "in_progress + an inbox item filed since the session started"
STARTED="$LATER" transcript "$TMP/old.jsonl" "/execute-mesa-task $T_OLD"
hook "$TMP/old.jsonl"; blocked "in_progress + only an inbox item older than the session" "task $T_OLD"
transcript_no_ts "$TMP/no-ts.jsonl" "/execute-mesa-task $T_INBOX"
hook "$TMP/no-ts.jsonl"; blocked "a first record with no timestamp counts no inbox item as filed" "task $T_INBOX"

# ================= loop guard and never-wedge =================
hook "$TMP/prog.jsonl" true; allowed "stop_hook_active: true"
transcript "$TMP/unknown.jsonl" "/execute-mesa-task 999999"
hook "$TMP/unknown.jsonl"; allowed "an unknown task id"
hook "$TMP/does-not-exist.jsonl"; allowed "an unreadable transcript"
MESA_DB="$TMP/nowhere/none.db" hook "$TMP/prog.jsonl"; allowed "a mesa error (unusable MESA_DB)"

echo
echo "stop-guard-check: $CHECKS checks passed"
