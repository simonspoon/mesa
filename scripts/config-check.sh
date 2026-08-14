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
# The synthesiser behind the `speech` section (mesa task 822). `--list-voices`
# is the one source of the voices mesa offers — read by the Settings route and
# by the save-time check — so the stub answers it with a bounded list plus a
# line that is not a name, which must be filtered out. mesa asks for the list
# with `--no-download` beside it (listing names must never become a model
# fetch), so the stub matches the flag anywhere in its argv rather than at $1.
# Every other invocation logs its argv (the whole point: does the saved voice reach `-v`?) and emits
# the streaming WAV header `kokoro-rs -o -` writes, exactly like the stub in
# scripts/api-check.sh.
KOKORO_ARGV="$TMP/kokoro.argv"
cat > "$STUB_DIR/kokoro-rs" <<EOF
#!/usr/bin/env bash
case " \$* " in *" --list-voices "*) LISTING=1;; *) LISTING=0;; esac
if [ "\$LISTING" = "1" ]; then
  printf 'Available voices:\naf_heart\naf_bella\nbm_george\n'
  exit 0
fi
printf '%s\n' "\$*" > "$KOKORO_ARGV"
cat > /dev/null
printf 'RIFF\xff\xff\xff\xffWAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\xc0\x5d\x00\x00\x80\xbb\x00\x00\x02\x00\x10\x00data\xff\xff\xff\xff'
printf '\x01\x02\x03\x04\x05\x06\x07\x08'
EOF
chmod +x "$STUB_DIR/mytool" "$STUB_DIR/mytool-receipt" "$STUB_DIR/claude" "$STUB_DIR/kokoro-rs"
export MESA_KOKORO_BIN="$STUB_DIR/kokoro-rs"

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
run 0 "$MESA" inbox add --task "$TASK_A" --kind change-request "khora: eval errors on undefined"
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
# spaces", and {name} (a task name, untrusted text) must land as exactly one
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
ok "todo-watcher runs the configured command, in the project folder, with {id}/{name} substituted (a quoted template token stays one arg; so does a name with spaces)"

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

# ---- the Settings surface: GET/PUT /api/config (mesa task 654) ----

# The web UI edits this same file. What matters is that it is genuinely the
# same file and the same rules — not a parallel store that happens to agree.
write_config <<EOF
{"other": {"x": 1}, "commands": {"todo-watcher": "$STUB_DIR/mytool dispatch {id}"}}
EOF
api GET /api/config
[ "$CODE" = "200" ] || fail "GET /api/config: expected 200, got $CODE: $STDOUT"
[ "$(jq -r 'map(.action) | join(",")' <<<"$STDOUT")" = "todo-watcher,inbox-watcher,agent-spawn,live-agent" ] ||
  fail "GET /api/config must list all four actions in order: $STDOUT"
[ "$(jq -r '.[0].value' <<<"$STDOUT")" = "$STUB_DIR/mytool dispatch {id}" ] ||
  fail "GET /api/config: configured value wrong: $STDOUT"
[ "$(jq -r '.[1].value' <<<"$STDOUT")" = "null" ] ||
  fail "an unconfigured action must report value: null, got $STDOUT"
[ "$(jq -r '.[1].default' <<<"$STDOUT")" = '{bin} --bg --agent {agent} --name {name} -- "/inbox-triage {id}"' ] ||
  fail "GET /api/config: built-in default wrong: $STDOUT"
[ "$(jq -r '.[2].placeholders | join(" ")' <<<"$STDOUT")" = "{bin} {agent} {prompt}" ] ||
  fail "GET /api/config: agent-spawn's placeholder vocabulary wrong: $STDOUT"
ok "GET /api/config reports each command's configured value (null when unset), its built-in default and the placeholders it offers"

api PUT /api/config "{\"commands\": {\"agent-spawn\": \"  $STUB_DIR/mytool from-settings --prompt {prompt}  \"}}"
[ "$CODE" = "200" ] || fail "PUT /api/config: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.[2].value' <<<"$STDOUT")" = "$STUB_DIR/mytool from-settings --prompt {prompt}" ] ||
  fail "PUT must echo the stored (trimmed) value: $STDOUT"
[ "$(jq -r '.other.x' < "$CONFIG")" = "1" ] ||
  fail "PUT dropped a section of the file it doesn't own: $(cat "$CONFIG")"
[ "$(jq -r '.commands["todo-watcher"]' < "$CONFIG")" = "$STUB_DIR/mytool dispatch {id}" ] ||
  fail "PUT clobbered a command it wasn't asked to touch: $(cat "$CONFIG")"
api POST "/api/projects/$A/agents" '{"prompt":"from the settings page"}'
[ "$CODE" = "201" ] || fail "post-PUT spawn: expected 201, got $CODE: $STDOUT"
grep -qx "$DIR_A|from-settings|--prompt|from the settings page" "$ARGV_LOG" ||
  fail "the spawn did not use the just-saved command: $(cat "$ARGV_LOG")"
ok "PUT /api/config writes the same file the spawn path reads — the next spawn uses it, with no restart — and leaves untouched keys and unknown sections alone"

api PUT /api/config '{"commands": {"agent-spawn": "   "}}'
[ "$CODE" = "200" ] || fail "PUT blank: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.[2].value' <<<"$STDOUT")" = "null" ] ||
  fail "a blank value must clear the key, got $STDOUT"
[ "$(jq -r '.commands | has("agent-spawn")' < "$CONFIG")" = "false" ] ||
  fail "a blank value must remove the key, not store an empty string: $(cat "$CONFIG")"
ok "PUT with a blank value clears one command back to its built-in default (the key is removed, never stored empty)"

BEFORE=$(cat "$CONFIG")
api PUT /api/config '{"commands": {"todo-watcher": "mytool {prompt}"}}'
[ "$CODE" = "422" ] || fail "bad placeholder: expected 422, got $CODE: $STDOUT"
[ "$(jq -r .error.code <<<"$STDOUT")" = "validation" ] ||
  fail "bad placeholder: expected code validation, got $STDOUT"
grep -q "{prompt}" <<<"$STDOUT" || fail "the message must name the placeholder: $STDOUT"
api PUT /api/config '{"commands": {"agent-spawn": "mytool \"oops"}}'
[ "$CODE" = "422" ] || fail "unterminated quote: expected 422, got $CODE: $STDOUT"
api PUT /api/config '{"commands": {"tsak": "mytool"}}'
[ "$CODE" = "422" ] || fail "unknown key: expected 422, got $CODE: $STDOUT"
grep -q "unknown command" <<<"$STDOUT" || fail "unknown key: message wrong: $STDOUT"
[ "$(cat "$CONFIG")" = "$BEFORE" ] ||
  fail "a rejected PUT must not touch the file: $(cat "$CONFIG")"
ok "PUT rejects a template the spawn path would later fail on (bad placeholder, unbalanced quote, unknown key) as 422 validation, writing nothing"

# ---- script mode: a multi-line value runs as bash -c (mesa task 667) ----

# The mode is chosen by the value: a newline makes it a script. Values arrive
# as MESA_* environment variables, never substituted into the body — which is
# what keeps untrusted free text out of shell parsing in this mode too.
SCRIPT_LOG="$TMP/script.log"
: > "$SCRIPT_LOG"

# Every script logs `<action>|<cwd>|<vars…>`, reading each variable with
# `${X:-<unset>}` so "unset" and "empty" are distinguishable in the log.
watcher_script() { # watcher_script <action>
  printf 'set -u\nprintf "%%s|%%s|%%s|%%s|%%s|%%s\\n" "%s" "$(pwd)" "${MESA_ID:-<unset>}" "${MESA_NAME:-<unset>}" "${MESA_AGENT:-<unset>}" "${MESA_PROMPT:-<unset>}" >> "%s"\necho "backgrounded · 5c81aaaa"' "$1" "$SCRIPT_LOG"
}
SPAWN_SCRIPT=$(printf 'set -u\ncd "$(pwd)"\nexport PICKED=yes\nprintf "%%s|%%s|%%s|%%s|%%s\\n" "agent-spawn" "$PICKED" "${MESA_PROMPT:-<unset>}" "${MESA_ID:-<unset>}" "${MESA_NAME:-<unset>}" >> "%s"\necho "backgrounded · 5c81bbbb"' "$SCRIPT_LOG")

jq -n \
  --arg todo "$(watcher_script todo-watcher)" \
  --arg inbox "$(watcher_script inbox-watcher)" \
  --arg spawn "$SPAWN_SCRIPT" \
  '{commands: {"todo-watcher": $todo, "inbox-watcher": $inbox, "agent-spawn": $spawn}}' \
  > "$CONFIG"

# A fresh project, so the todo-watcher's one-agent-per-project cap doesn't
# hide the dispatch, and a task name that is a shell-injection attempt.
mkdir -p "$TMP/projC"
DIR_C=$(cd "$TMP/projC" && pwd -P)
run 0 "$MESA" project create "C" --no-git
C=$(jqs .id)
run 0 "$MESA" project update "$C" --path "$DIR_C"
# Short enough that the derived task name is the description verbatim (the
# 50-char cut would otherwise elide the payload), and relative so the file it
# would create lands in the script's own cwd.
PWNED="$DIR_C/pwned"
HOSTILE='"; touch pwned #'
run 0 "$MESA" task create "$C" "$HOSTILE"
TASK_C=$(jqs .id)
run 0 "$MESA" inbox add --task "$TASK_C" --kind change-request "script-mode triage"
ITEM_3=$(jqs .id)

wait_lines "$SCRIPT_LOG" 2
grep -Fqx "todo-watcher|$DIR_C|$TASK_C|C: $HOSTILE|swe|<unset>" "$SCRIPT_LOG" ||
  fail "todo-watcher script mode wrong: $(cat "$SCRIPT_LOG")"
ok "a multi-line todo-watcher runs as bash -c in the project folder, with MESA_ID/MESA_NAME set and MESA_PROMPT (not offered) unset"

[ ! -e "$PWNED" ] ||
  fail "an untrusted task name was parsed as shell syntax — script mode leaks"
ok "a task name of \`\"; touch <file> #\` round-trips as one string: the body reaches bash verbatim, values arrive out-of-band"

grep -Fqx "inbox-watcher|$FAKE_HOME|$ITEM_3|inbox $ITEM_3: script-mode triage|swe|<unset>" "$SCRIPT_LOG" ||
  fail "inbox-watcher script mode wrong: $(cat "$SCRIPT_LOG")"
ok "the inbox-watcher takes a script too, in its own cwd"

api POST "/api/projects/$C/agents" '{"prompt":"from a script"}'
[ "$CODE" = "201" ] || fail "script spawn: expected 201, got $CODE: $STDOUT"
[ "$(jq -r .id <<<"$STDOUT")" = "5c81bbbb" ] ||
  fail "a script's \`backgrounded · <id>\` receipt must be parsed as usual: $STDOUT"
grep -Fqx "agent-spawn|yes|from a script|<unset>|<unset>" "$SCRIPT_LOG" ||
  fail "agent-spawn script mode wrong: $(cat "$SCRIPT_LOG")"
ok "agent-spawn takes a script (cd/export work), its receipt is parsed as usual, and MESA_ID/MESA_NAME are unset for it"

api POST "/api/projects/$C/agents" '{}'
[ "$CODE" = "201" ] || fail "promptless script spawn: expected 201, got $CODE: $STDOUT"
grep -Fqx "agent-spawn|yes|<unset>|<unset>|<unset>" "$SCRIPT_LOG" ||
  fail "an absent prompt must leave MESA_PROMPT UNSET, not empty: $(cat "$SCRIPT_LOG")"
ok "a value absent on this call leaves its variable unset, not empty (the script-mode drop rule, under \`set -u\`)"

[ ! -s "$CLAUDE_LOG" ] ||
  fail "the built-in claude command ran during script mode: $(cat "$CLAUDE_LOG")"
ok "with all three commands configured as scripts, the built-in \`claude\` argv is still never used"

# A script that exits nonzero is a failed spawn, exactly as an argv is.
write_config <<'EOF'
{"commands": {"agent-spawn": "echo nope >&2\nexit 4"}}
EOF
api POST "/api/projects/$C/agents" '{}'
[ "$CODE" = "502" ] || fail "failing script: expected 502, got $CODE: $STDOUT"
grep -q "nope" <<<"$STDOUT" || fail "a failing script must surface its stderr: $STDOUT"
ok "a script's exit code is the whole contract: nonzero is a failed spawn, stderr and all"

# ---- script-mode validation is a save-time 422, writing nothing ----

BEFORE=$(cat "$CONFIG")
api PUT /api/config '{"commands": {"todo-watcher": "cd /repo\nclaude --name {name}"}}'
[ "$CODE" = "422" ] || fail "{} in a script: expected 422, got $CODE: $STDOUT"
[ "$(jq -r .error.code <<<"$STDOUT")" = "validation" ] ||
  fail "{} in a script: expected code validation, got $STDOUT"
grep -q "MESA_NAME" <<<"$STDOUT" ||
  fail "the message must name the env var to use instead: $STDOUT"
api PUT /api/config '{"commands": {"todo-watcher": "cd /repo\nif true; then\necho stuck"}}'
[ "$CODE" = "422" ] || fail "bash syntax error: expected 422, got $CODE: $STDOUT"
grep -q "not valid bash" <<<"$STDOUT" ||
  fail "a bash syntax error must say so: $STDOUT"
[ "$(cat "$CONFIG")" = "$BEFORE" ] ||
  fail "a rejected script PUT must not touch the file: $(cat "$CONFIG")"
ok "a script with a {placeholder} or a bash syntax error is 422 validation at save time, leaving the file byte-identical"

# A valid script round-trips through the editor and drives the next spawn.
api PUT /api/config "$(jq -n --arg s "$SPAWN_SCRIPT" '{commands: {"agent-spawn": $s}}')"
[ "$CODE" = "200" ] || fail "PUT a script: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.[2].value' <<<"$STDOUT")" = "$SPAWN_SCRIPT" ] ||
  fail "PUT must echo the stored script verbatim: $STDOUT"
[ "$(jq -r '.[2].env_vars | join(" ")' <<<"$STDOUT")" = "MESA_BIN MESA_AGENT MESA_PROMPT" ] ||
  fail "GET/PUT must report agent-spawn's script-mode vocabulary: $STDOUT"
[ "$(jq -r '.[0].env_vars | join(" ")' <<<"$STDOUT")" = "MESA_BIN MESA_AGENT MESA_ID MESA_NAME" ] ||
  fail "GET/PUT must report the watchers' script-mode vocabulary: $STDOUT"
: > "$SCRIPT_LOG"
api POST "/api/projects/$C/agents" '{"prompt":"saved from settings"}'
[ "$CODE" = "201" ] || fail "post-PUT script spawn: expected 201, got $CODE: $STDOUT"
grep -Fqx "agent-spawn|yes|saved from settings|<unset>|<unset>" "$SCRIPT_LOG" ||
  fail "the just-saved script did not drive the next spawn: $(cat "$SCRIPT_LOG")"
ok "a script saved over PUT /api/config round-trips verbatim, reports its MESA_* vocabulary, and drives the very next spawn"

# ---- the pricing section: GET/PUT /api/config/pricing (mesa task 692) ----

# Same file, same rules, a different section — and the two must not disturb
# each other, which is the whole reason the saver is a sibling of the commands
# one rather than a second file format.
write_config <<EOF
{"other": {"x": 1}, "commands": {"todo-watcher": "$STUB_DIR/mytool dispatch {id}"}}
EOF
api GET /api/config/pricing
[ "$CODE" = "200" ] || fail "GET pricing: expected 200, got $CODE: $STDOUT"
[ "$(jq -r 'map(.prefix) | join(",")' <<<"$STDOUT")" = "claude-fable,claude-mythos,claude-opus,claude-sonnet,claude-haiku" ] ||
  fail "GET pricing must list the built-in families in order: $STDOUT"
[ "$(jq -r '.[] | select(.prefix=="claude-opus") | .value' <<<"$STDOUT")" = "null" ] ||
  fail "an unconfigured prefix must report value: null, got $STDOUT"
[ "$(jq '.[] | select(.prefix=="claude-opus") | .default.output == 25' <<<"$STDOUT")" = "true" ] ||
  fail "GET pricing: built-in opus rate wrong: $STDOUT"
ok "GET /api/config/pricing lists the built-in model families with value: null (no override) and the shipped rates as default"

api PUT /api/config/pricing '{"pricing": {"claude-opus": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}, "newco-x": {"input": 7, "output": 8, "cache_read": 0, "cache_write": 0}}}'
[ "$CODE" = "200" ] || fail "PUT pricing: expected 200, got $CODE: $STDOUT"
[ "$(jq '.[] | select(.prefix=="claude-opus") | .value.output == 2' <<<"$STDOUT")" = "true" ] ||
  fail "PUT must echo the stored override: $STDOUT"
[ "$(jq '.[] | select(.prefix=="claude-opus") | .default.output == 25' <<<"$STDOUT")" = "true" ] ||
  fail "the built-in must still be reported behind an override: $STDOUT"
# A prefix the binary never heard of is the point: a new family, no rebuild.
[ "$(jq -r '.[] | select(.prefix=="newco-x") | .default' <<<"$STDOUT")" = "null" ] ||
  fail "a user-added prefix must have no built-in behind it: $STDOUT"
[ "$(jq '.[] | select(.prefix=="newco-x") | .value.input == 7' <<<"$STDOUT")" = "true" ] ||
  fail "a user-added prefix must round-trip: $STDOUT"
[ "$(jq -r '.commands["todo-watcher"]' < "$CONFIG")" = "$STUB_DIR/mytool dispatch {id}" ] ||
  fail "a pricing write clobbered the commands section: $(cat "$CONFIG")"
[ "$(jq -r '.other.x' < "$CONFIG")" = "1" ] ||
  fail "a pricing write dropped a section it doesn't own: $(cat "$CONFIG")"
ok "PUT /api/config/pricing overrides a built-in family and adds a wholly new prefix, leaving commands and unknown sections verbatim"

# The commands saver has to be just as careful in the other direction.
api PUT /api/config '{"commands": {"inbox-watcher": "mytool triage {id}"}}'
[ "$CODE" = "200" ] || fail "PUT commands after pricing: expected 200, got $CODE: $STDOUT"
[ "$(jq '.pricing["claude-opus"].output == 2' < "$CONFIG")" = "true" ] ||
  fail "a commands write clobbered the pricing section: $(cat "$CONFIG")"
ok "a commands write preserves the pricing section, exactly as a pricing write preserves commands"

api PUT /api/config/pricing '{"pricing": {"claude-opus": null, "newco-x": null}}'
[ "$CODE" = "200" ] || fail "PUT pricing null: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.[] | select(.prefix=="claude-opus") | .value' <<<"$STDOUT")" = "null" ] ||
  fail "null must restore the built-in for a shipped family: $STDOUT"
[ "$(jq -r 'map(select(.prefix=="newco-x")) | length' <<<"$STDOUT")" = "0" ] ||
  fail "null must delete a user-added prefix outright: $STDOUT"
[ "$(jq -r '.pricing | has("claude-opus")' < "$CONFIG")" = "false" ] ||
  fail "null must remove the key, never store it zeroed: $(cat "$CONFIG")"
ok "PUT null restores the built-in rate for a shipped family and deletes a user-added prefix"

BEFORE=$(cat "$CONFIG")
api PUT /api/config/pricing '{"pricing": {"claude-opus": {"input": -1, "output": 2, "cache_read": 3, "cache_write": 4}}}'
[ "$CODE" = "422" ] || fail "negative rate: expected 422, got $CODE: $STDOUT"
[ "$(jq -r .error.code <<<"$STDOUT")" = "validation" ] ||
  fail "negative rate: expected code validation, got $STDOUT"
api PUT /api/config/pricing '{"pricing": {"claude opus": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}}}'
[ "$CODE" = "422" ] || fail "prefix with whitespace: expected 422, got $CODE: $STDOUT"
[ "$(cat "$CONFIG")" = "$BEFORE" ] ||
  fail "a rejected pricing PUT must not touch the file: $(cat "$CONFIG")"
ok "PUT /api/config/pricing rejects a negative rate and a whitespace-bearing prefix as 422 validation, writing nothing"

# The write is loopback-only in both modes; from a loopback shell the reachable
# half of that gate is the Host allowlist the same stack enforces.
CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -H 'Host: evil.example' \
  "http://127.0.0.1:$PORT/api/config/pricing")
[ "$CODE" = "403" ] || fail "GET pricing with a foreign Host: expected 403, got $CODE: $(cat "$TMP/body")"
CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X PUT -H 'Host: evil.example' \
  -H 'Content-Type: application/json' \
  --data '{"pricing": {"claude-opus": null}}' \
  "http://127.0.0.1:$PORT/api/config/pricing")
[ "$CODE" = "403" ] || fail "PUT pricing with a foreign Host: expected 403, got $CODE: $(cat "$TMP/body")"
[ "$(cat "$CONFIG")" = "$BEFORE" ] || fail "a refused pricing PUT must not touch the file"
ok "both pricing verbs sit behind the config routes' gate — a request that isn't from this machine's own page is refused, writing nothing"

# ---- the watchers section: GET/PUT /api/config/watchers (mesa task 777) ----

# Same file, same sibling-section rules as pricing, a different route.
write_config <<EOF
{"other": {"x": 1}, "commands": {"todo-watcher": "$STUB_DIR/mytool dispatch {id}"}, "pricing": {"claude-opus": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}}}
EOF
api GET /api/config/watchers
[ "$CODE" = "200" ] || fail "GET watchers: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.todo_concurrency' <<<"$STDOUT")" = "null" ] ||
  fail "an unconfigured todo_concurrency must report null, got $STDOUT"
[ "$(jq -r '.todo_concurrency_default' <<<"$STDOUT")" = "1" ] ||
  fail "GET watchers: built-in default wrong: $STDOUT"
ok "GET /api/config/watchers reports todo_concurrency: null (no override) and todo_concurrency_default: 1 on a fresh config"

api PUT /api/config/watchers '{"todo_concurrency": 3}'
[ "$CODE" = "200" ] || fail "PUT watchers: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.todo_concurrency' <<<"$STDOUT")" = "3" ] ||
  fail "PUT must echo the stored override: $STDOUT"
[ "$(jq -r '.watchers["todo-concurrency"]' < "$CONFIG")" = "3" ] ||
  fail "PUT watchers did not write todo-concurrency: $(cat "$CONFIG")"
[ "$(jq -r '.commands["todo-watcher"]' < "$CONFIG")" = "$STUB_DIR/mytool dispatch {id}" ] ||
  fail "a watchers write clobbered the commands section: $(cat "$CONFIG")"
[ "$(jq '.pricing["claude-opus"].output == 2' < "$CONFIG")" = "true" ] ||
  fail "a watchers write clobbered the pricing section: $(cat "$CONFIG")"
[ "$(jq -r '.other.x' < "$CONFIG")" = "1" ] ||
  fail "a watchers write dropped a section it doesn't own: $(cat "$CONFIG")"
ok "PUT /api/config/watchers sets todo_concurrency, leaving commands, pricing and an unknown section untouched"

# The other two savers have to be just as careful toward watchers.
api PUT /api/config '{"commands": {"inbox-watcher": "mytool triage {id}"}}'
[ "$CODE" = "200" ] || fail "PUT commands after watchers: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.watchers["todo-concurrency"]' < "$CONFIG")" = "3" ] ||
  fail "a commands write clobbered the watchers section: $(cat "$CONFIG")"
api PUT /api/config/pricing '{"pricing": {"claude-opus": null}}'
[ "$CODE" = "200" ] || fail "PUT pricing after watchers: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.watchers["todo-concurrency"]' < "$CONFIG")" = "3" ] ||
  fail "a pricing write clobbered the watchers section: $(cat "$CONFIG")"
ok "saving commands or pricing preserves the watchers section, exactly as watchers preserves them"

api PUT /api/config/watchers '{"todo_concurrency": null}'
[ "$CODE" = "200" ] || fail "PUT watchers null: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.todo_concurrency' <<<"$STDOUT")" = "null" ] ||
  fail "null must restore the default, got $STDOUT"
[ "$(jq -r '.watchers | has("todo-concurrency")' < "$CONFIG")" = "false" ] ||
  fail "null must remove the key, never store it: $(cat "$CONFIG")"
ok "PUT null on todo_concurrency removes the key, restoring the built-in default"

BEFORE=$(cat "$CONFIG")
api PUT /api/config/watchers '{"todo_concurrency": 0}'
[ "$CODE" = "422" ] || fail "todo_concurrency 0: expected 422, got $CODE: $STDOUT"
[ "$(jq -r .error.code <<<"$STDOUT")" = "validation" ] ||
  fail "todo_concurrency 0: expected code validation, got $STDOUT"
api PUT /api/config/watchers '{"todo_concurrency": 2.5}'
[ "$CODE" = "422" ] || fail "todo_concurrency 2.5: expected 422, got $CODE: $STDOUT"
api PUT /api/config/watchers '{"todo_concurrency": "abc"}'
[ "$CODE" = "422" ] || fail "todo_concurrency \"abc\": expected 422, got $CODE: $STDOUT"
api PUT /api/config/watchers '{"todo_concurrency": 21}'
[ "$CODE" = "422" ] || fail "todo_concurrency 21: expected 422, got $CODE: $STDOUT"
api PUT /api/config/watchers '{"todo_concurrency": -1}'
[ "$CODE" = "422" ] || fail "todo_concurrency -1: expected 422, got $CODE: $STDOUT"
[ "$(cat "$CONFIG")" = "$BEFORE" ] ||
  fail "a rejected watchers PUT must not touch the file: $(cat "$CONFIG")"
ok "PUT /api/config/watchers rejects 0, a non-integer, and a value outside 1..=20 as 422 validation, writing nothing"

CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -H 'Host: evil.example' \
  "http://127.0.0.1:$PORT/api/config/watchers")
[ "$CODE" = "403" ] || fail "GET watchers with a foreign Host: expected 403, got $CODE: $(cat "$TMP/body")"
CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X PUT -H 'Host: evil.example' \
  -H 'Content-Type: application/json' \
  --data '{"todo_concurrency": 5}' \
  "http://127.0.0.1:$PORT/api/config/watchers")
[ "$CODE" = "403" ] || fail "PUT watchers with a foreign Host: expected 403, got $CODE: $(cat "$TMP/body")"
[ "$(cat "$CONFIG")" = "$BEFORE" ] || fail "a refused watchers PUT must not touch the file"
ok "both watchers verbs sit behind the config routes' gate — a request that isn't from this machine's own page is refused, writing nothing"

# ---- the speech section: GET/PUT /api/config/speech (mesa task 822) ----
#
# The fourth section of the same file, and the only one whose value has to
# survive all the way into another program's argv: the voice is what the inbox's
# play button passes to `kokoro-rs`. So this covers the sibling-section rules
# like pricing and watchers, and then the thing those two have no analogue of —
# the saved value showing up in the synthesiser's command line, and NOT showing
# up at all when nothing is saved.

speak() { # speak <inbox-id> -> CODE, argv in $KOKORO_ARGV
  rm -f "$KOKORO_ARGV"
  CODE=$(curl -s -o "$TMP/audio" -w '%{http_code}' \
    "http://127.0.0.1:$PORT/api/inbox/$1/speak")
}

write_config <<EOF
{"other": {"x": 1}, "commands": {"todo-watcher": "$STUB_DIR/mytool dispatch {id}"}, "pricing": {"claude-opus": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}}, "watchers": {"todo-concurrency": 3}}
EOF
api GET /api/config/speech
[ "$CODE" = "200" ] || fail "GET speech: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.voice' <<<"$STDOUT")" = "null" ] ||
  fail "an unconfigured voice must report null, got $STDOUT"
# mesa ships no voice list of its own: the choices are whatever the installed
# binary answers `--list-voices` with, minus the lines that aren't names.
[ "$(jq -r '.voices | join(",")' <<<"$STDOUT")" = "af_heart,af_bella,bm_george" ] ||
  fail "GET speech: voices must be the binary's --list-voices output, names only: $STDOUT"
ok "GET /api/config/speech reports voice: null on a fresh config and offers exactly the voices the installed synthesiser lists"

api PUT /api/config/speech '{"voice": "bm_george"}'
[ "$CODE" = "200" ] || fail "PUT speech: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.voice' <<<"$STDOUT")" = "bm_george" ] ||
  fail "PUT must echo the stored voice: $STDOUT"
[ "$(jq -r '.speech.voice' < "$CONFIG")" = "bm_george" ] ||
  fail "PUT speech did not write the voice: $(cat "$CONFIG")"
[ "$(jq -r '.commands["todo-watcher"]' < "$CONFIG")" = "$STUB_DIR/mytool dispatch {id}" ] ||
  fail "a speech write clobbered the commands section: $(cat "$CONFIG")"
[ "$(jq '.pricing["claude-opus"].output == 2' < "$CONFIG")" = "true" ] ||
  fail "a speech write clobbered the pricing section: $(cat "$CONFIG")"
[ "$(jq -r '.watchers["todo-concurrency"]' < "$CONFIG")" = "3" ] ||
  fail "a speech write clobbered the watchers section: $(cat "$CONFIG")"
[ "$(jq -r '.other.x' < "$CONFIG")" = "1" ] ||
  fail "a speech write dropped a section it doesn't own: $(cat "$CONFIG")"
ok "PUT /api/config/speech sets the voice, leaving commands, pricing, watchers and an unknown section untouched"

# The whole point of the setting: the saved name reaches the synthesiser, as one
# argument after `-v`, read fresh on the press with no restart.
speak "$ITEM_1"
[ "$CODE" = "200" ] || fail "speak with a configured voice: expected 200, got $CODE: $(cat "$TMP/audio")"
[ "$(cat "$KOKORO_ARGV")" = "-q -o - -v bm_george" ] ||
  fail "the saved voice must reach the synthesiser's argv, got $(cat "$KOKORO_ARGV")"
ok "the saved voice reaches the synthesiser as \`-v <voice>\`, read on the press (no restart)"

# …and the Settings page's test button (mesa task 824) is the other way round:
# the voice it speaks is the *query's*, because it exists to audition a choice
# that has not been saved. `bm_george` is what the file says here, so a preview
# asking for `af_bella` proves the route reads the query and not the file —
# which is only assertable with a voice actually configured, so it lives here
# rather than beside the route's other checks in api-check.sh.
preview() { # preview <query> -> CODE, argv in $KOKORO_ARGV
  rm -f "$KOKORO_ARGV"
  CODE=$(curl -s -o "$TMP/audio" -w '%{http_code}' \
    "http://127.0.0.1:$PORT/api/config/speech/preview$1")
}
preview "?voice=af_bella"
[ "$CODE" = "200" ] || fail "preview with a configured voice: expected 200, got $CODE: $(cat "$TMP/audio")"
[ "$(cat "$KOKORO_ARGV")" = "-q -o - -v af_bella" ] ||
  fail "preview must speak the query's voice, not the saved one: $(cat "$KOKORO_ARGV")"
# The blank one is the same story: it means "the synthesiser's own default",
# never "fall back to whatever is saved".
preview "?voice="
[ "$CODE" = "200" ] || fail "preview with a blank voice: expected 200, got $CODE: $(cat "$TMP/audio")"
[ "$(cat "$KOKORO_ARGV")" = "-q -o -" ] ||
  fail "a blank preview voice must add no -v, saved or not: $(cat "$KOKORO_ARGV")"
ok "the voice preview speaks the query's voice, never the saved one — and blank stays the synthesiser's own default"

# The other three savers have to leave the voice alone, exactly as it leaves
# them alone.
api PUT /api/config '{"commands": {"inbox-watcher": "mytool triage {id}"}}'
[ "$CODE" = "200" ] || fail "PUT commands after speech: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.speech.voice' < "$CONFIG")" = "bm_george" ] ||
  fail "a commands write clobbered the speech section: $(cat "$CONFIG")"
api PUT /api/config/pricing '{"pricing": {"claude-opus": null}}'
[ "$CODE" = "200" ] || fail "PUT pricing after speech: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.speech.voice' < "$CONFIG")" = "bm_george" ] ||
  fail "a pricing write clobbered the speech section: $(cat "$CONFIG")"
api PUT /api/config/watchers '{"todo_concurrency": 2}'
[ "$CODE" = "200" ] || fail "PUT watchers after speech: expected 200, got $CODE: $STDOUT"
[ "$(jq -r '.speech.voice' < "$CONFIG")" = "bm_george" ] ||
  fail "a watchers write clobbered the speech section: $(cat "$CONFIG")"
ok "saving commands, pricing or watchers preserves the speech section, exactly as speech preserves them"

# Both spellings of "no voice" remove the key: an install with nothing saved and
# an install that saved and cleared must be the same file, and the same argv.
for RESET in 'null' '""'; do
  api PUT /api/config/speech "{\"voice\": \"bm_george\"}"
  [ "$CODE" = "200" ] || fail "PUT speech before reset $RESET: got $CODE: $STDOUT"
  api PUT /api/config/speech "{\"voice\": $RESET}"
  [ "$CODE" = "200" ] || fail "PUT speech $RESET: expected 200, got $CODE: $STDOUT"
  [ "$(jq -r '.voice' <<<"$STDOUT")" = "null" ] ||
    fail "PUT speech $RESET must report no voice, got $STDOUT"
  [ "$(jq -r '.speech | has("voice")' < "$CONFIG")" = "false" ] ||
    fail "PUT speech $RESET must remove the key, never store it: $(cat "$CONFIG")"
done
ok "PUT voice null and voice \"\" both remove the key (absence, never an empty string in the file)"

# …and with the key gone the argv is byte-for-byte the one mesa ran before the
# setting existed — mesa names no default voice of its own.
speak "$ITEM_1"
[ "$CODE" = "200" ] || fail "speak with no voice: expected 200, got $CODE: $(cat "$TMP/audio")"
[ "$(cat "$KOKORO_ARGV")" = "-q -o -" ] ||
  fail "an unconfigured voice must add no -v at all, got $(cat "$KOKORO_ARGV")"
ok "with no voice configured the synthesiser runs the pre-822 argv — no \`-v\`, no mesa-chosen default"

BEFORE=$(cat "$CONFIG")
# A voice is a bounded identifier, so a value that could be read as an option,
# split into two arguments, or carry shell syntax is refused at save time —
# the store-what-you-would-refuse-to-run rule.
for BAD in '-o' 'a b' 'af_heart; rm -rf /'; do
  api PUT /api/config/speech "$(jq -n --arg v "$BAD" '{voice: $v}')"
  [ "$CODE" = "422" ] || fail "voice $BAD: expected 422, got $CODE: $STDOUT"
  [ "$(jq -r .error.code <<<"$STDOUT")" = "validation" ] ||
    fail "voice $BAD: expected code validation, got $STDOUT"
done
# A well-shaped name the installed binary never offered is refused too, by the
# same list the editor is built from.
api PUT /api/config/speech '{"voice": "zz_nobody"}'
[ "$CODE" = "422" ] || fail "unknown voice: expected 422, got $CODE: $STDOUT"
[ "$(jq -r .error.code <<<"$STDOUT")" = "validation" ] ||
  fail "unknown voice: expected code validation, got $STDOUT"
grep -q "zz_nobody" <<<"$STDOUT" || fail "the message must name the voice: $STDOUT"
[ "$(cat "$CONFIG")" = "$BEFORE" ] ||
  fail "a rejected speech PUT must not touch the file: $(cat "$CONFIG")"
ok "PUT /api/config/speech rejects a voice that isn't a bounded identifier and one the binary doesn't offer as 422 validation, writing nothing"

CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -H 'Host: evil.example' \
  "http://127.0.0.1:$PORT/api/config/speech")
[ "$CODE" = "403" ] || fail "GET speech with a foreign Host: expected 403, got $CODE: $(cat "$TMP/body")"
CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X PUT -H 'Host: evil.example' \
  -H 'Content-Type: application/json' \
  --data '{"voice": "af_bella"}' \
  "http://127.0.0.1:$PORT/api/config/speech")
[ "$CODE" = "403" ] || fail "PUT speech with a foreign Host: expected 403, got $CODE: $(cat "$TMP/body")"
[ "$(cat "$CONFIG")" = "$BEFORE" ] || fail "a refused speech PUT must not touch the file"
ok "both speech verbs sit behind the config routes' gate — a request that isn't from this machine's own page is refused, writing nothing"

printf '{ not json' > "$CONFIG"
api GET /api/config
[ "$CODE" = "502" ] || fail "malformed config GET: expected 502, got $CODE: $STDOUT"
[ "$(jq -r .error.code <<<"$STDOUT")" = "unavailable" ] ||
  fail "malformed config GET: expected code unavailable, got $STDOUT"
api PUT /api/config '{"commands": {"agent-spawn": "mytool"}}'
[ "$CODE" = "502" ] || fail "malformed config PUT: expected 502, got $CODE: $STDOUT"
api GET /api/config/pricing
[ "$CODE" = "502" ] || fail "malformed config pricing GET: expected 502, got $CODE: $STDOUT"
api PUT /api/config/pricing '{"pricing": {"claude-opus": null}}'
[ "$CODE" = "502" ] || fail "malformed config pricing PUT: expected 502, got $CODE: $STDOUT"
api GET /api/config/watchers
[ "$CODE" = "502" ] || fail "malformed config watchers GET: expected 502, got $CODE: $STDOUT"
api PUT /api/config/watchers '{"todo_concurrency": 5}'
[ "$CODE" = "502" ] || fail "malformed config watchers PUT: expected 502, got $CODE: $STDOUT"
api GET /api/config/speech
[ "$CODE" = "502" ] || fail "malformed config speech GET: expected 502, got $CODE: $STDOUT"
api PUT /api/config/speech '{"voice": "af_bella"}'
[ "$CODE" = "502" ] || fail "malformed config speech PUT: expected 502, got $CODE: $STDOUT"
[ "$(cat "$CONFIG")" = '{ not json' ] ||
  fail "a PUT must never overwrite a config it could not parse: $(cat "$CONFIG")"
ok "a malformed config is 502 unavailable on all eight config verbs, and a PUT never overwrites a file it could not read"

# The preview is the one speech surface a malformed file cannot break, because
# it reads no config at all — which is what makes it usable on the page whose
# job is to fix that file.
preview "?voice=af_bella"
[ "$CODE" = "200" ] || fail "preview under a malformed config: expected 200, got $CODE: $(cat "$TMP/audio")"
[ "$(cat "$KOKORO_ARGV")" = "-q -o - -v af_bella" ] ||
  fail "preview under a malformed config must still speak the query's voice: $(cat "$KOKORO_ARGV")"
ok "the voice preview still works under a malformed config — it reads no config at all"

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
ok "the unconfigured todo-watcher keeps its built-in \`--agent swe --name <project>: <name> -- /execute-mesa-task <id>\` argv"

run 0 "$MESA" inbox add --task "$TASK_B" --kind change-request "loki: find exits 0 on no match"
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
