#!/usr/bin/env bash
# Inbox-watcher gate: exercises `mesa serve --watch-inbox`'s periodic dispatch
# loop against a stub `claude` binary (MESA_CLAUDE_BIN), so no real Claude
# Code is involved. Uses MESA_WATCH_INBOX_TICK_MS (a test-only seam, mirrors
# MESA_CLAUDE_BIN) to shrink the tick from 60s down to test speed.
#
# HOME is pointed at a throwaway dir for the server process: the inbox-watcher
# dispatches in $HOME (an inbox item belongs to no project, so there is no
# local_path to spawn in), and the stub logs its cwd — asserting against the
# real home directory would be neither hermetic nor portable.
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

# ---- stub claude: logs every --bg invocation's (cwd, name, prompt) to BG_LOG ----

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
BG_LOG="$TMP/bg.log"
touch "$BG_LOG"
cat > "$STUB_DIR/claude" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--bg" ]; then
  shift
  [ -e "$STUB_DIR/fail" ] && { echo "stub claude is down" >&2; exit 1; }
  NAME=""
  if [ "\$1" = "--name" ]; then shift; NAME="\$1"; shift; fi
  PROMPT=""
  if [ "\$1" = "--" ]; then shift; PROMPT="\$1"; fi
  echo "\$(pwd)|\$NAME|\$PROMPT" >> "$BG_LOG"
  echo "backgrounded · deadbeef (idle — send a prompt to start)"
  exit 0
fi
if [ "\$1" = "agents" ]; then echo '[]'; exit 0; fi
exit 2
EOF
chmod +x "$STUB_DIR/claude"

# ---- fixtures ----

# Resolved to the physical path (macOS's /tmp -> /private/tmp symlink): a
# child process's cwd (as set via current_dir/chdir) reports the physical
# path, so the stub's logged pwd would otherwise never match the expectation.
mkdir -p "$TMP/home" "$TMP/projA"
FAKE_HOME=$(cd "$TMP/home" && pwd -P)
DIR_A=$(cd "$TMP/projA" && pwd -P)

# A project with a real path and an actionable todo task, purely to prove the
# two watchers are independent: --watch-inbox must never dispatch it.
run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" project update "$A" --path "$DIR_A"
run 0 "$MESA" task create "$A" "task a"
TASK_A=$(jqs .id)

run 0 "$MESA" inbox add --author "agent-7" "khora: eval errors on undefined
second line is ignored by the session name"
ITEM_1=$(jqs .id)
[ "$(jqs .project_id)" = "null" ] || fail "a new inbox item must start unassigned"
ok "fixtures: project A (real path, todo task), inbox item $ITEM_1 pending"

PORT=17782
wait_for_server() {
  local port=$1
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$port/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $port"
}
wait_bg_lines() { # wait_bg_lines <n> -> blocks until BG_LOG has >= n lines, or fails
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$BG_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n bg dispatch(es); log:\n$(cat "$BG_LOG")"
}
start_server() { # start_server <flags...>
  HOME="$FAKE_HOME" MESA_CLAUDE_BIN="$STUB_DIR/claude" \
    MESA_WATCH_INBOX_TICK_MS=150 MESA_WATCH_TODO_TICK_MS=150 \
    "$MESA" serve --port "$PORT" "$@" >/dev/null 2>&1 &
  SERVER_PID=$!
  wait_for_server "$PORT"
}
stop_server() {
  [ -n "${SERVER_PID:-}" ] || return 0
  kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
}

# ---- flag OFF: no dispatch, ever, even with a pending inbox item ----

start_server
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "flag off: watcher must not dispatch"
run 0 "$MESA" inbox show "$ITEM_1"
[ "$(jqs .id)" = "$ITEM_1" ] || fail "flag off: item must still be in the inbox"
stop_server
ok "watch_inbox off: no dispatch, item untouched"

# ---- spawn failure: the item is NOT left claimed, so a later tick retries ----

touch "$STUB_DIR/fail"
start_server --watch-inbox
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "a failing spawn must log nothing"
rm -f "$STUB_DIR/fail"

# ---- flag ON: dispatches the pending item in $HOME with /inbox-triage <id> ----

wait_bg_lines 1
LINE=$(head -1 "$BG_LOG")
EXPECT="$FAKE_HOME|inbox $ITEM_1: khora: eval errors on undefined|/inbox-triage $ITEM_1"
[ "$LINE" = "$EXPECT" ] || fail "expected '$EXPECT', got '$LINE'"
ok "spawn failure releases the claim; the next tick retries and dispatches in \$HOME, prompt '/inbox-triage <id>', session named 'inbox <id>: <first body line>'"

# ---- already dispatched: no re-dispatch, tick after tick ----

# The triage skill's third outcome (no confident project match) leaves the
# item in the inbox untouched, so this is the case that would otherwise
# respawn an agent for the same item on every single tick, forever.
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 1 ] ||
  fail "an already-dispatched item must not dispatch again: $(cat "$BG_LOG")"
run 0 "$MESA" inbox show "$ITEM_1"
[ "$(jqs .id)" = "$ITEM_1" ] || fail "the watcher itself must never mutate the item"
ok "item still pending after dispatch is not re-dispatched on later ticks"

# ---- a newly-arrived item dispatches even while older ones are claimed ----

run 0 "$MESA" inbox add "loki: find exits 0 on no match"
ITEM_2=$(jqs .id)
wait_bg_lines 2
LINE=$(sed -n 2p "$BG_LOG")
EXPECT="$FAKE_HOME|inbox $ITEM_2: loki: find exits 0 on no match|/inbox-triage $ITEM_2"
[ "$LINE" = "$EXPECT" ] || fail "expected '$EXPECT', got '$LINE'"
ok "a new inbox item is dispatched on the next tick, with its own id"

# ---- the whole pending queue goes out in ONE tick (no per-item pacing) ----

# The inbox is one global queue with no per-project cap to pace it, unlike
# the todo-watcher's one-agent-per-project. Three at once must all dispatch.
run 0 "$MESA" inbox add "mesa: item three"
run 0 "$MESA" inbox add "mesa: item four"
run 0 "$MESA" inbox add "mesa: item five"
wait_bg_lines 5
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 5 ] ||
  fail "expected exactly 5 dispatches, got: $(cat "$BG_LOG")"
ok "every pending item dispatches in a single tick, then stops"

# ---- --watch-todo is a separate flag: the todo backlog is untouched ----

[ "$(curl -sf "http://127.0.0.1:$PORT/api/tasks/$TASK_A" | jq -r .status)" = "todo" ] ||
  fail "--watch-inbox alone must not claim a todo task"
! grep -q "execute-mesa-task" "$BG_LOG" ||
  fail "--watch-inbox alone must not dispatch the todo watcher"
ok "watch_inbox is independent of watch_todo: no task claimed, no /execute-mesa-task dispatch"

# ---- an item leaving the inbox (triage's own terminal states) is quiet ----

# Both of the triage skill's acting outcomes remove the item: a viable
# request becomes a task and the item is deleted, a non-viable one is
# converted by `inbox assign`. Neither may provoke a re-dispatch.
run 0 "$MESA" inbox delete "$ITEM_1"
run 0 "$MESA" inbox assign "$ITEM_2" "$A"
[ "$(jqs .status)" = "backlog" ] || fail "inbox assign must create a backlog task"
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 5 ] ||
  fail "items that left the inbox must not re-dispatch: $(cat "$BG_LOG")"
curl -sf "http://127.0.0.1:$PORT/api/inbox" >/dev/null ||
  fail "server must still be healthy after the watcher pruned its dedup set"
stop_server
ok "an item removed by triage (delete or assign) is pruned, never re-dispatched"

echo
echo "inbox-watcher check passed ($CHECKS checks)"
