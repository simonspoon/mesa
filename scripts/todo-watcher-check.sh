#!/usr/bin/env bash
# Todo-watcher gate: exercises `mesa serve --watch-todo`'s periodic dispatch
# loop against a stub `claude` binary (MESA_CLAUDE_BIN), so no real Claude
# Code is involved. Uses MESA_WATCH_TODO_TICK_MS (a test-only seam, mirrors
# MESA_CLAUDE_BIN) to shrink the tick from 60s down to test speed.
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

# ---- fixtures: two real dirs (projects A, C) + one --no-git project (B) ----

# Resolved to the physical path (macOS's /tmp -> /private/tmp symlink): a
# child process's cwd (as set via current_dir/chdir) reports the physical
# path, so the stub's logged pwd would otherwise never match a $TMP-relative
# expectation.
mkdir -p "$TMP/projA" "$TMP/projC"
DIR_A=$(cd "$TMP/projA" && pwd -P)
DIR_C=$(cd "$TMP/projC" && pwd -P)

run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" project update "$A" --path "$DIR_A"

run 0 "$MESA" project create "B" --no-git
B=$(jqs .id)
run 0 "$MESA" project create "C" --no-git
C=$(jqs .id)
run 0 "$MESA" project update "$C" --path "$DIR_C"

run 0 "$MESA" task create "$A" "task a"
TASK_A=$(jqs .id)
[ "$(jqs .status)" = "todo" ] || fail "new task must start todo"
ok "fixtures: project A (real path), B (no path), C (real path), task A todo"

PORT=17781
wait_for_server() {
  local port=$1
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$port/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $port"
}
task_status() { # task_status <id>
  curl -sf "http://127.0.0.1:$PORT/api/tasks/$1" | jq -r .status
}
wait_bg_lines() { # wait_bg_lines <n> -> blocks until BG_LOG has >= n lines, or fails
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$BG_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n bg dispatch(es); log:\n$(cat "$BG_LOG")"
}

# ---- flag OFF: no dispatch, ever, even with an actionable todo task ----

MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_WATCH_TODO_TICK_MS=150 \
  "$MESA" serve --port "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server "$PORT"
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "flag off: watcher must not dispatch"
[ "$(task_status "$TASK_A")" = "todo" ] || fail "flag off: task must stay todo"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
ok "watch_todo off: no dispatch, no status change"

# ---- flag ON: dispatches the actionable task, claims it in_progress ----

MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_WATCH_TODO_TICK_MS=150 \
  "$MESA" serve --port "$PORT" --watch-todo >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server "$PORT"

wait_bg_lines 1
LINE=$(head -1 "$BG_LOG")
[ "$LINE" = "$DIR_A|A: task a|/execute-mesa-task $TASK_A" ] ||
  fail "expected '$DIR_A|A: task a|/execute-mesa-task $TASK_A', got '$LINE'"
[ "$(task_status "$TASK_A")" = "in_progress" ] || fail "dispatched task must be claimed in_progress"
ok "watch_todo on: dispatches next actionable task, prompt is /execute-mesa-task <id>, session named '<project>: <title>', claims in_progress"

# ---- project already busy (in_progress task present): a second todo task
# in the SAME project must NOT be dispatched while the first is in flight ----

run 0 "$MESA" task create "$A" "task a2"
TASK_A2=$(jqs .id)
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "busy project must not get a second dispatch"
[ "$(task_status "$TASK_A2")" = "todo" ] || fail "second task in a busy project must stay todo"
ok "project with an in_progress task is skipped even with another actionable todo task"

# ---- project B (no local_path) is skipped even with an actionable task ----

run 0 "$MESA" task create "$B" "task b"
TASK_B=$(jqs .id)
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "path-less project must not be dispatched"
[ "$(task_status "$TASK_B")" = "todo" ] || fail "path-less project's task must stay todo"
ok "project without local_path is skipped"

# ---- project C: stale local_path (folder no longer exists) is skipped ----

rmdir "$DIR_C"
run 0 "$MESA" task create "$C" "task c"
TASK_C=$(jqs .id)
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "stale local_path must not be dispatched"
[ "$(task_status "$TASK_C")" = "todo" ] || fail "stale-path project's task must stay todo"
ok "project with a stale (deleted) local_path is skipped"

# ---- spawn failure reverts the claimed task back to todo (no wedge) ----

touch "$STUB_DIR/fail"
mkdir -p "$DIR_C"
sleep 1
[ "$(task_status "$TASK_C")" = "todo" ] || fail "failed spawn must revert the task to todo, not wedge it in_progress"
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "failed spawn must not log a successful bg line"
rm "$STUB_DIR/fail"
ok "a spawn_bg failure reverts the claimed task back to todo instead of wedging the project"

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

# ---- archived project is never auto-dispatched onto (mesa task 506 /
# main-loop ruling 1); unarchiving lets the next tick dispatch it. Runs
# against its own throwaway MESA_DB, stub log and server instance -- fully
# isolated from the A/B/C fixtures above, which otherwise have in-flight
# claim/revert cycles (spawn-failure retry) that would make shared-log
# assertions here racy against tick timing. ----

ARCH_DB="$TMP/archived.db"
ARCH_LOG="$TMP/archived-bg.log"
touch "$ARCH_LOG"
ARCH_STUB="$STUB_DIR/claude-archived"
cat > "$ARCH_STUB" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--bg" ]; then
  shift
  NAME=""
  if [ "\$1" = "--name" ]; then shift; NAME="\$1"; shift; fi
  PROMPT=""
  if [ "\$1" = "--" ]; then shift; PROMPT="\$1"; fi
  echo "\$(pwd)|\$NAME|\$PROMPT" >> "$ARCH_LOG"
  echo "backgrounded · deadbeef (idle — send a prompt to start)"
  exit 0
fi
if [ "\$1" = "agents" ]; then echo '[]'; exit 0; fi
exit 2
EOF
chmod +x "$ARCH_STUB"

mkdir -p "$TMP/normDir" "$TMP/archDir"
NORM_DIR=$(cd "$TMP/normDir" && pwd -P)
ARCH_DIR=$(cd "$TMP/archDir" && pwd -P)

export MESA_DB="$ARCH_DB"
run 0 "$MESA" project create "Norm" --no-git
NORM=$(jqs .id)
run 0 "$MESA" project update "$NORM" --path "$NORM_DIR"
run 0 "$MESA" task create "$NORM" "task norm"
TASK_NORM=$(jqs .id)

run 0 "$MESA" project create "Arch" --no-git
ARCH=$(jqs .id)
run 0 "$MESA" project update "$ARCH" --path "$ARCH_DIR"
# Archive BEFORE the task exists: a todo task must never be actionable for an
# already-archived project, not even for the one tick between its creation
# and a subsequent archive call.
run 0 "$MESA" project archive "$ARCH"
run 0 "$MESA" task create "$ARCH" "task arch"
TASK_ARCH=$(jqs .id)

ARCH_PORT=17782
MESA_CLAUDE_BIN="$ARCH_STUB" MESA_WATCH_TODO_TICK_MS=150 \
  "$MESA" serve --port "$ARCH_PORT" --watch-todo >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server "$ARCH_PORT"

arch_task_status() { curl -sf "http://127.0.0.1:$ARCH_PORT/api/tasks/$1" | jq -r .status; }
wait_arch_bg_lines() { # wait_arch_bg_lines <n> -> blocks until ARCH_LOG has >= n lines, or fails
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$ARCH_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n archived-check bg dispatch(es); log:\n$(cat "$ARCH_LOG")"
}

wait_arch_bg_lines 1
sleep 1
[ "$(wc -l < "$ARCH_LOG")" -eq 1 ] || fail "archived project must never be dispatched, even across several ticks"
LINE=$(head -1 "$ARCH_LOG")
[ "$LINE" = "$NORM_DIR|Norm: task norm|/execute-mesa-task $TASK_NORM" ] ||
  fail "expected '$NORM_DIR|Norm: task norm|/execute-mesa-task $TASK_NORM', got '$LINE'"
[ "$(arch_task_status "$TASK_NORM")" = "in_progress" ] || fail "unarchived project's task must be claimed in_progress"
[ "$(arch_task_status "$TASK_ARCH")" = "todo" ] || fail "archived project's task must stay todo, never claimed"
ok "archived project is never auto-dispatched onto while its unarchived sibling is, across several ticks"

run 0 "$MESA" project unarchive "$ARCH"
wait_arch_bg_lines 2
LINE=$(sed -n '2p' "$ARCH_LOG")
[ "$LINE" = "$ARCH_DIR|Arch: task arch|/execute-mesa-task $TASK_ARCH" ] ||
  fail "expected '$ARCH_DIR|Arch: task arch|/execute-mesa-task $TASK_ARCH', got '$LINE'"
[ "$(arch_task_status "$TASK_ARCH")" = "in_progress" ] || fail "unarchiving must let the next tick dispatch its actionable todo task"
ok "unarchiving a project lets the next tick dispatch its actionable todo task"

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

# ---- an in_progress task WITH subtasks is an umbrella, not a worker: it must
# not wedge its project, and dispatch narrows to its own descendants (mesa
# task 570). Isolated db/log/server, same reason as the archived block. ----

UMB_DB="$TMP/umbrella.db"
UMB_LOG="$TMP/umbrella-bg.log"
touch "$UMB_LOG"
UMB_STUB="$STUB_DIR/claude-umbrella"
sed "s#$ARCH_LOG#$UMB_LOG#" "$ARCH_STUB" > "$UMB_STUB"
chmod +x "$UMB_STUB"

mkdir -p "$TMP/umbDir"
UMB_DIR=$(cd "$TMP/umbDir" && pwd -P)

export MESA_DB="$UMB_DB"
run 0 "$MESA" project create "Umb" --no-git
UMB=$(jqs .id)
run 0 "$MESA" project update "$UMB" --path "$UMB_DIR"
# `outsider` is created first so it wins any project-wide pick on id order --
# if the umbrella's scoping ever regressed to a plain next_task, this is the
# task that would be dispatched instead of a child.
run 0 "$MESA" task create "$UMB" "outsider"
TASK_OUT=$(jqs .id)
run 0 "$MESA" task create "$UMB" "epic"
TASK_EPIC=$(jqs .id)
run 0 "$MESA" task create "$UMB" "child one" --parent "$TASK_EPIC"
TASK_C1=$(jqs .id)
run 0 "$MESA" task create "$UMB" "child two" --parent "$TASK_EPIC"
TASK_C2=$(jqs .id)
run 0 "$MESA" task update "$TASK_EPIC" --status in_progress

UMB_PORT=17783
MESA_CLAUDE_BIN="$UMB_STUB" MESA_WATCH_TODO_TICK_MS=150 \
  "$MESA" serve --port "$UMB_PORT" --watch-todo >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server "$UMB_PORT"

umb_task_status() { curl -sf "http://127.0.0.1:$UMB_PORT/api/tasks/$1" | jq -r .status; }
wait_umb_bg_lines() { # wait_umb_bg_lines <n>
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$UMB_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n umbrella-check bg dispatch(es); log:\n$(cat "$UMB_LOG")"
}

wait_umb_bg_lines 1
sleep 1
[ "$(wc -l < "$UMB_LOG")" -eq 1 ] || fail "the dispatched child is a leaf: it must wedge the project again"
LINE=$(head -1 "$UMB_LOG")
[ "$LINE" = "$UMB_DIR|Umb: child one|/execute-mesa-task $TASK_C1" ] ||
  fail "expected '$UMB_DIR|Umb: child one|/execute-mesa-task $TASK_C1', got '$LINE'"
[ "$(umb_task_status "$TASK_EPIC")" = "in_progress" ] || fail "the umbrella itself must be left alone"
[ "$(umb_task_status "$TASK_OUT")" = "todo" ] || fail "an open umbrella unblocks only its own children"
[ "$(umb_task_status "$TASK_C2")" = "todo" ] || fail "children must not fan out concurrently"
ok "an in_progress task with subtasks does not wedge its project: its first child is dispatched, siblings and unrelated tasks wait"

run 0 "$MESA" task update "$TASK_C1" --status done
wait_umb_bg_lines 2
LINE=$(sed -n '2p' "$UMB_LOG")
[ "$LINE" = "$UMB_DIR|Umb: child two|/execute-mesa-task $TASK_C2" ] ||
  fail "expected '$UMB_DIR|Umb: child two|/execute-mesa-task $TASK_C2', got '$LINE'"
ok "a finished child lets the next tick take the umbrella's next subtask"

run 0 "$MESA" task update "$TASK_C2" --status done
sleep 1
[ "$(wc -l < "$UMB_LOG")" -eq 2 ] || fail "an exhausted subtree must not fall back to the wider project"
[ "$(umb_task_status "$TASK_OUT")" = "todo" ] || fail "unrelated todo must stay untouched while the umbrella is open"
ok "an open umbrella with no actionable subtasks left keeps the rest of the project parked"

run 0 "$MESA" task update "$TASK_EPIC" --status done
wait_umb_bg_lines 3
LINE=$(sed -n '3p' "$UMB_LOG")
[ "$LINE" = "$UMB_DIR|Umb: outsider|/execute-mesa-task $TASK_OUT" ] ||
  fail "expected '$UMB_DIR|Umb: outsider|/execute-mesa-task $TASK_OUT', got '$LINE'"
ok "closing the umbrella returns the project to plain whole-backlog dispatch"

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

# ---- the umbrella rule's other half: the watcher must never CLAIM a task
# that still has actionable subtasks. If it did, that task would read as an
# umbrella one tick later and a second agent would be spawned onto its own
# child in the same repo (mesa task 570). ----

EPIC_DB="$TMP/epic.db"
EPIC_LOG="$TMP/epic-bg.log"
touch "$EPIC_LOG"
EPIC_STUB="$STUB_DIR/claude-epic"
sed "s#$ARCH_LOG#$EPIC_LOG#" "$ARCH_STUB" > "$EPIC_STUB"
chmod +x "$EPIC_STUB"

mkdir -p "$TMP/epicDir"
EPIC_DIR=$(cd "$TMP/epicDir" && pwd -P)

export MESA_DB="$EPIC_DB"
run 0 "$MESA" project create "Epic" --no-git
EPIC_P=$(jqs .id)
run 0 "$MESA" project update "$EPIC_P" --path "$EPIC_DIR"
# All todo, epic created first so a plain `next_task` would pick it.
run 0 "$MESA" task create "$EPIC_P" "epic"
T_EPIC=$(jqs .id)
run 0 "$MESA" task create "$EPIC_P" "story" --parent "$T_EPIC"
T_STORY=$(jqs .id)

EPIC_PORT=17784
MESA_CLAUDE_BIN="$EPIC_STUB" MESA_WATCH_TODO_TICK_MS=150 \
  "$MESA" serve --port "$EPIC_PORT" --watch-todo >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server "$EPIC_PORT"

epic_task_status() { curl -sf "http://127.0.0.1:$EPIC_PORT/api/tasks/$1" | jq -r .status; }
wait_epic_bg_lines() { # wait_epic_bg_lines <n>
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$EPIC_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n epic-check bg dispatch(es); log:\n$(cat "$EPIC_LOG")"
}

wait_epic_bg_lines 1
sleep 1
[ "$(wc -l < "$EPIC_LOG")" -eq 1 ] || fail "claiming an epic would let the next tick spawn a second agent on its own child"
LINE=$(head -1 "$EPIC_LOG")
[ "$LINE" = "$EPIC_DIR|Epic: story|/execute-mesa-task $T_STORY" ] ||
  fail "expected '$EPIC_DIR|Epic: story|/execute-mesa-task $T_STORY', got '$LINE'"
[ "$(epic_task_status "$T_EPIC")" = "todo" ] || fail "a task with actionable subtasks must never be claimed by the watcher"
ok "the watcher claims an actionable leaf, never a task that still has actionable subtasks"

run 0 "$MESA" task update "$T_STORY" --status done
wait_epic_bg_lines 2
LINE=$(sed -n '2p' "$EPIC_LOG")
[ "$LINE" = "$EPIC_DIR|Epic: epic|/execute-mesa-task $T_EPIC" ] ||
  fail "expected '$EPIC_DIR|Epic: epic|/execute-mesa-task $T_EPIC', got '$LINE'"
sleep 1
[ "$(wc -l < "$EPIC_LOG")" -eq 2 ] || fail "an epic holding its own claim must park the project"
ok "an exhausted epic is dispatched last (its roll-up) and parks the project while it holds the claim"

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

echo "ALL OK ($CHECKS checks)"
