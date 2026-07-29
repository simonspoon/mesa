#!/usr/bin/env bash
# Config gate: proves the three spawn commands in ~/.mesa/config.json actually
# replace the built-in `claude --bg …` argv — for the todo-watcher, the
# inbox-watcher and the Agents surface's spawn route — and that a missing or
# broken config behaves the way docs/config.md says.
#
# The config file is read at its REAL default location, so HOME is pointed at
# a throwaway dir (MESA_CONFIG_FILE, the unit tests' seam, would sidestep the
# path resolution this gate exists to check). That also suits the
# inbox-watcher, which dispatches in $HOME.
#
# Two stubs stand in for the outside world: `mytool` (the replacement command,
# logging its argv) and `claude` (the built-in default's program, logging to a
# *separate* file). Which log grows is the whole assertion.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

run() {
  local expected=$1; shift
  set +e
  STDOUT=$("$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }

# ---- stubs ----

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
ARGV_LOG="$TMP/mytool.log"      # every configured-command invocation
CLAUDE_LOG="$TMP/claude.log"    # every built-in-default invocation
touch "$ARGV_LOG" "$CLAUDE_LOG"

# The replacement command: logs `<cwd>|<arg>|<arg>|…` and prints NO job-id
# receipt, the case a custom command is entitled to.
cat > "$STUB_DIR/mytool" <<EOF
#!/usr/bin/env bash
LINE="\$(pwd)"; for a in "\$@"; do LINE="\$LINE|\$a"; done; echo "\$LINE" >> "$ARGV_LOG"
echo "started my own way"
EOF

# Same, but speaks claude's receipt format, so mesa can lift an id out of it.
cat > "$STUB_DIR/mytool-receipt" <<EOF
#!/usr/bin/env bash
LINE="\$(pwd)"; for a in "\$@"; do LINE="\$LINE|\$a"; done; echo "\$LINE" >> "$ARGV_LOG"
echo "backgrounded · cafe1234 · mine"
EOF

# The program the BUILT-IN default names. Logs to its own file so "the config
# took over" is provable as "this file stayed empty".
cat > "$STUB_DIR/claude" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "agents" ]; then echo '[]'; exit 0; fi
if [ "\$1" = "--bg" ]; then
  shift
  LINE="\$(pwd)"; for a in "\$@"; do LINE="\$LINE|\$a"; done; echo "\$LINE" >> "$CLAUDE_LOG"
  echo "backgrounded · deadbeef (idle — send a prompt to start)"
  exit 0
fi
exit 2
EOF
chmod +x "$STUB_DIR/mytool" "$STUB_DIR/mytool-receipt" "$STUB_DIR/claude"

# ---- fixtures ----

# Physical paths: a child's cwd reports the resolved path (macOS /tmp symlink),
# so the stubs' logged pwd would otherwise never match.
mkdir -p "$TMP/home/.mesa" "$TMP/projA"
FAKE_HOME=$(cd "$TMP/home" && pwd -P)
DIR_A=$(cd "$TMP/projA" && pwd -P)
CONFIG="$FAKE_HOME/.mesa/config.json"

write_config() { cat > "$CONFIG"; }   # body on stdin

run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" project update "$A" --path "$DIR_A"
run 0 "$MESA" task create "$A" "task a"
TASK_A=$(jqs .id)
run 0 "$MESA" inbox add "khora: eval errors on undefined"
ITEM_1=$(jqs .id)
ok "fixtures: project A at a real path with one todo task, one pending inbox item"

PORT=17785
wait_for_server() {
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $PORT"
}
wait_lines() { # wait_lines <file> <n>
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$1")" -ge "$2" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $2 line(s) in $1; got:\n$(cat "$1")"
}
api() { # api <method> <path> [json-body] -> STDOUT=body, CODE=status
  local method=$1 path=$2 body=${3:-}
  CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "http://127.0.0.1:$PORT$path")
  STDOUT=$(cat "$TMP/body")
}

# ---- both watchers + the spawn route run the CONFIGURED command ----

# The todo-watcher template carries a literal quoted multi-word token as well
# as {id}/{name}: quoting is the template author's tool for "one argument with
# spaces", and {name} (a task title, untrusted text) must land as exactly one
# argument without being quoted at all.
write_config <<EOF
{
  "commands": {
    "todo-watcher": "$STUB_DIR/mytool dispatch 'one arg' --task {id} --label {name}",
    "inbox-watcher": "$STUB_DIR/mytool triage {id}",
    "agent-spawn": "$STUB_DIR/mytool-receipt start --prompt {prompt}"
  }
}
EOF

HOME="$FAKE_HOME" MESA_CLAUDE_BIN="$STUB_DIR/claude" \
  MESA_WATCH_TODO_TICK_MS=150 MESA_WATCH_INBOX_TICK_MS=150 \
  "$MESA" serve --port "$PORT" --watch-todo --watch-inbox >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server

wait_lines "$ARGV_LOG" 2
grep -qx "$DIR_A|dispatch|one arg|--task|$TASK_A|--label|A: task a" "$ARGV_LOG" ||
  fail "todo-watcher did not run the configured command: $(cat "$ARGV_LOG")"
ok "todo-watcher runs the configured command, in the project folder, with {id}/{name} substituted (a quoted template token stays one arg; so does a title with spaces)"

grep -qx "$FAKE_HOME|triage|$ITEM_1" "$ARGV_LOG" ||
  fail "inbox-watcher did not run the configured command: $(cat "$ARGV_LOG")"
ok "inbox-watcher runs the configured command in \$HOME with {id} substituted"

[ "$(curl -sf "http://127.0.0.1:$PORT/api/tasks/$TASK_A" | jq -r .status)" = "in_progress" ] ||
  fail "a configured command must still be a real dispatch (task left unclaimed)"
ok "a configured dispatch claims the task exactly like the built-in one"

api POST "/api/projects/$A/agents" '{"prompt":"look at the tests"}'
[ "$CODE" = "201" ] || fail "spawn: expected 201, got $CODE: $STDOUT"
[ "$(jq -r .id <<<"$STDOUT")" = "cafe1234" ] ||
  fail "spawn: the id must come from the configured command's receipt: $STDOUT"
grep -qx "$DIR_A|start|--prompt|look at the tests" "$ARGV_LOG" ||
  fail "agent-spawn did not run the configured command: $(cat "$ARGV_LOG")"
ok "POST /api/projects/{id}/agents runs the configured command and returns the id from its receipt"

api POST "/api/projects/$A/agents" '{}'
[ "$CODE" = "201" ] || fail "spawn without a prompt: expected 201, got $CODE: $STDOUT"
grep -qx "$DIR_A|start" "$ARGV_LOG" ||
  fail "an absent {prompt} must drop its flag too: $(cat "$ARGV_LOG")"
ok "an absent value drops its token and the preceding flag (\`--prompt {prompt}\` vanishes as a pair)"

[ ! -s "$CLAUDE_LOG" ] ||
  fail "the built-in claude command ran anyway: $(cat "$CLAUDE_LOG")"
ok "with all three commands configured, the built-in \`claude\` argv is never used"

# ---- a command that prints no receipt: created, with a null id ----

# Read per spawn, not cached at startup: editing the file takes effect on the
# next dispatch, with no server restart.
write_config <<EOF
{"commands": {"agent-spawn": "$STUB_DIR/mytool start-idle"}}
EOF
api POST "/api/projects/$A/agents" '{}'
[ "$CODE" = "201" ] || fail "no-receipt spawn: expected 201, got $CODE: $STDOUT"
[ "$(jq -r '.id' <<<"$STDOUT")" = "null" ] ||
  fail "a command with no receipt must yield id: null, got $STDOUT"
grep -qx "$DIR_A|start-idle" "$ARGV_LOG" || fail "no-receipt command did not run"
ok "an edited config applies to the next spawn with no restart; a command printing no receipt is 201 with id: null, not an error"

# ---- a broken config is an error, not a silent fallback ----

printf '{ not json' > "$CONFIG"
api POST "/api/projects/$A/agents" '{}'
[ "$CODE" = "502" ] || fail "malformed config: expected 502, got $CODE: $STDOUT"
[ "$(jq -r .error.code <<<"$STDOUT")" = "unavailable" ] ||
  fail "malformed config: expected code unavailable, got $STDOUT"
grep -q "malformed mesa config" <<<"$STDOUT" ||
  fail "malformed config: the message must name the problem: $STDOUT"
ok "a malformed config fails the spawn as unavailable and says so (never a silent fall back to the default)"

write_config <<EOF
{"commands": {"agent-spawn": "$STUB_DIR/mytool run {oops}"}}
EOF
api POST "/api/projects/$A/agents" '{}'
[ "$CODE" = "502" ] || fail "bad placeholder: expected 502, got $CODE: $STDOUT"
grep -q "{oops}" <<<"$STDOUT" ||
  fail "bad placeholder: the message must name it: $STDOUT"
ok "an unsupported placeholder is reported by name, before anything is run"

write_config <<EOF
{"commands": {"agent-spawn": "$STUB_DIR/mytool run {id}"}}
EOF
api POST "/api/projects/$A/agents" '{}'
[ "$CODE" = "502" ] || fail "out-of-scope placeholder: expected 502, got $CODE: $STDOUT"
grep -q '{id}' <<<"$STDOUT" ||
  fail "out-of-scope placeholder: expected {id} named: $STDOUT"
ok "placeholders are scoped per command: {id} is not offered to agent-spawn"

# ---- an unconfigured command falls back to the built-in claude argv ----

# `{}` (no commands at all) and a config file that never mentions this action
# are the same state as no file: use the default.
write_config <<'EOF'
{"commands": {}}
EOF
api POST "/api/projects/$A/agents" '{"prompt":"/execute-mesa-task 1"}'
[ "$CODE" = "201" ] || fail "default fallback: expected 201, got $CODE: $STDOUT"
[ "$(jq -r .id <<<"$STDOUT")" = "deadbeef" ] ||
  fail "default fallback: expected the claude stub's id, got $STDOUT"
grep -qx "$DIR_A|--agent|swe|--|/execute-mesa-task 1" "$CLAUDE_LOG" ||
  fail "the built-in default argv changed: $(cat "$CLAUDE_LOG")"
ok "an action absent from the config uses the built-in \`claude --bg --agent swe -- <prompt>\` argv (MESA_CLAUDE_BIN still feeds {bin})"

# The other two actions fall back the same way — proven on a fresh project, so
# the todo-watcher's one-agent-per-project cap doesn't hide it.
mkdir -p "$TMP/projB"
DIR_B=$(cd "$TMP/projB" && pwd -P)
run 0 "$MESA" project create "B" --no-git
B=$(jqs .id)
run 0 "$MESA" project update "$B" --path "$DIR_B"
run 0 "$MESA" task create "$B" "task b"
TASK_B=$(jqs .id)
wait_lines "$CLAUDE_LOG" 2
grep -qx "$DIR_B|--agent|swe|--name|B: task b|--|/execute-mesa-task $TASK_B" "$CLAUDE_LOG" ||
  fail "the built-in todo-watcher argv changed: $(cat "$CLAUDE_LOG")"
ok "the unconfigured todo-watcher keeps its built-in \`--agent swe --name <project>: <title> -- /execute-mesa-task <id>\` argv"

run 0 "$MESA" inbox add "loki: find exits 0 on no match"
ITEM_2=$(jqs .id)
wait_lines "$CLAUDE_LOG" 3
grep -qx "$FAKE_HOME|--agent|swe|--name|inbox $ITEM_2: loki: find exits 0 on no match|--|/inbox-triage $ITEM_2" "$CLAUDE_LOG" ||
  fail "the built-in inbox-watcher argv changed: $(cat "$CLAUDE_LOG")"
ok "the unconfigured inbox-watcher keeps its built-in \`--name inbox <id>: <body> -- /inbox-triage <id>\` argv"

# ---- MESA_CLAUDE_AGENT still disables --agent through the default template ----

kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
: > "$CLAUDE_LOG"
HOME="$FAKE_HOME" MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_CLAUDE_AGENT="" \
  MESA_WATCH_TODO_TICK_MS=150 \
  "$MESA" serve --port "$PORT" --watch-todo >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server
api POST "/api/projects/$A/agents" '{"prompt":"no persona"}'
[ "$CODE" = "201" ] || fail "empty MESA_CLAUDE_AGENT: expected 201, got $CODE: $STDOUT"
grep -qx "$DIR_A|--|no persona" "$CLAUDE_LOG" ||
  fail "an empty MESA_CLAUDE_AGENT must drop \`--agent\` entirely: $(cat "$CLAUDE_LOG")"
ok "MESA_CLAUDE_AGENT='' still omits --agent (the default template's {agent} is unavailable, so the pair drops)"

echo
echo "config-check: $CHECKS checks passed"
