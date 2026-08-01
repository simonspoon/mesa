#!/usr/bin/env bash
# Refine-watcher gate: exercises `mesa serve --watch-refine`'s periodic loop
# against a stub `claude` binary (MESA_CLAUDE_BIN), so no real Claude Code is
# involved. Uses MESA_WATCH_REFINE_TICK_MS (a test-only seam, mirrors
# MESA_WATCH_TODO_TICK_MS) to shrink the tick from 60s to test speed.
#
# What separates this watcher from the todo one, and therefore what this gate
# is really asserting (docs/refine-watcher.md):
#   - dispatch is NOT a status claim: the task stays `refine` until the agent
#     moves it on, so the in-memory dedup set is the only thing stopping a
#     re-dispatch every tick;
#   - a busy project (an in_progress leaf) is still refined — refinement is
#     text work, not execution;
#   - one dispatch per project per tick, so a full column drips rather than
#     spawning an agent per task at once;
#   - `refine` and `todo` never contend: neither watcher sees the other's
#     column.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
# Pin the user config away from the real ~/.mesa/config.json: this gate
# asserts the BUILT-IN refinement prompt, so a configured one must not leak in.
export MESA_CONFIG_FILE="$TMP/no-config.json"

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

# ---- stub claude: logs every --bg invocation's (cwd, name, prompt) ----

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
BG_LOG="$TMP/bg.log"
FAIL_LOG="$TMP/bg-fail.log"
touch "$BG_LOG" "$FAIL_LOG"
cat > "$STUB_DIR/claude" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--bg" ]; then
  shift
  [ -e "$STUB_DIR/fail" ] && {
    echo "\$(pwd)" >> "$FAIL_LOG"
    echo "stub claude is down" >&2
    exit 1
  }
  AGENT=""
  if [ "\$1" = "--agent" ]; then shift; AGENT="\$1"; shift; fi
  echo "\$AGENT" > "$STUB_DIR/last-agent"
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

# ---- fixtures: project A (real path), B (no path) ----

mkdir -p "$TMP/projA"
DIR_A=$(cd "$TMP/projA" && pwd -P)

run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" project update "$A" --path "$DIR_A"
run 0 "$MESA" project create "B" --no-git
B=$(jqs .id)

run 0 "$MESA" task create "$A" "vague one" --status refine
TASK_1=$(jqs .id)
[ "$(jqs .status)" = "refine" ] || fail "refine must be an accepted status"
run 0 "$MESA" task create "$A" "vague two" --status refine
TASK_2=$(jqs .id)
run 0 "$MESA" task create "$A" "ordinary work"
TASK_TODO=$(jqs .id)
run 0 "$MESA" task create "$B" "nowhere to run" --status refine
TASK_B=$(jqs .id)
ok "fixtures: two refine tasks + one todo task in a path-bound project, one refine task in a path-less one"

# ---- CLI contract: the new status is filterable and listable like any other

run 0 "$MESA" task list "$A" --status refine
[ "$(jqs 'map(.id) | join(",")')" = "$TASK_1,$TASK_2" ] ||
  fail "task list --status refine must return exactly the refine column: $STDOUT"
run 2 "$MESA" task update "$TASK_1" --status refin
grep -q "backlog|refine|todo" <<<"$STDERR" ||
  fail "the status parse error must list refine: $STDERR"
ok "CLI: --status refine round-trips on create/list, and the parse error names it"

PORT=17786
wait_for_server() {
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $PORT"
}
task_status() { curl -sf "http://127.0.0.1:$PORT/api/tasks/$1" | jq -r .status; }
wait_bg_lines() { # wait_bg_lines <n>
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$BG_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n bg dispatch(es); log:\n$(cat "$BG_LOG")"
}
wait_fail_lines() { # wait_fail_lines <n>
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$FAIL_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n failed spawn attempt(s)"
}

# ---- flag OFF: no dispatch, ever, even with a full refine column ----

MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_WATCH_REFINE_TICK_MS=150 \
  "$MESA" serve --port "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "flag off: watcher must not dispatch"
[ "$(task_status "$TASK_1")" = "refine" ] || fail "flag off: task must stay refine"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
ok "watch_refine off: no dispatch, no status change"

# ---- --watch-todo alone never touches the refine column ----

# The two columns are disjoint by construction (`next_task` filters
# `status = 'todo'`), which is what lets the flags be independent.
MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_WATCH_TODO_TICK_MS=150 \
  "$MESA" serve --port "$PORT" --watch-todo >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server
wait_bg_lines 1
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "the todo watcher dispatched more than its one todo task"
grep -q "/execute-mesa-task $TASK_TODO" "$BG_LOG" ||
  fail "the todo watcher must dispatch the todo task: $(cat "$BG_LOG")"
[ "$(task_status "$TASK_1")" = "refine" ] || fail "a refine task must be invisible to the todo watcher"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
ok "--watch-todo alone dispatches only the todo column; refine tasks are never picked or claimed by it"

# TASK_TODO is left in_progress (a leaf), so project A reads BUSY from here
# on — which the refine watcher must ignore.

# ---- flag ON: one dispatch per project per tick, exactly once per task ----

: > "$BG_LOG"
MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_WATCH_REFINE_TICK_MS=150 \
  "$MESA" serve --port "$PORT" --watch-refine >/dev/null 2>&1 &
SERVER_PID=$!
wait_for_server

wait_bg_lines 1
LINE=$(head -1 "$BG_LOG")
CWD=${LINE%%|*}
NAME=$(cut -d'|' -f2 <<<"$LINE")
PROMPT=$(cut -d'|' -f3- <<<"$LINE")
[ "$CWD" = "$DIR_A" ] || fail "refinement must run in the project folder, got '$CWD'"
[ "$NAME" = "A: vague one" ] ||
  fail "session must be named '<project>: <task name>', got '$NAME'"
grep -q "id $TASK_1" <<<"$PROMPT" ||
  fail "the built-in prompt must carry the task id: '$PROMPT'"
grep -q "description and acceptance" <<<"$PROMPT" ||
  fail "the built-in prompt must ask for the description/acceptance rewrite: '$PROMPT'"
grep -q "'todo'" <<<"$PROMPT" ||
  fail "the built-in prompt must ask for the move to todo: '$PROMPT'"
[ "$(cat "$STUB_DIR/last-agent")" = "swe" ] ||
  fail "dispatch must pass --agent swe, got '$(cat "$STUB_DIR/last-agent")'"
ok "watch_refine on: dispatches the head of the refine column in the project folder, as '<project>: <name>' under --agent swe, with the built-in refinement prompt"

# The dispatch is NOT a claim: the task is still sitting in the column, and
# the project's own in_progress leaf did not park it either.
[ "$(task_status "$TASK_1")" = "refine" ] ||
  fail "a dispatched refine task must stay in the refine column (no status claim)"
[ "$(task_status "$TASK_TODO")" = "in_progress" ] ||
  fail "fixture: project A must be busy for the busy-project assertion to mean anything"
ok "dispatch claims no status (the task stays refine) and a busy project is refined anyway"

wait_bg_lines 2
LINE=$(sed -n '2p' "$BG_LOG")
grep -q "id $TASK_2" <<<"$LINE" || fail "the next tick must take the next task in rank: '$LINE'"
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 2 ] ||
  fail "each refine task is dispatched at most once per run: $(cat "$BG_LOG")"
[ "$(task_status "$TASK_B")" = "refine" ] ||
  fail "a path-less project must never be dispatched onto"
ok "the column drains one task per tick and never re-dispatches; a path-less project is skipped"

# ---- the agent's own move to todo is what ends refinement ----

run 0 "$MESA" task update "$TASK_1" --status todo
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 2 ] || fail "a refined task must not be re-dispatched"
[ "$(task_status "$TASK_1")" = "todo" ] || fail "the refined task should now be a plain todo"
ok "a task moved on to todo leaves the column for good (the refine watcher is done with it)"

# …and a task pushed back in gets another pass: the dedup set tracks the
# column, not the task's whole life.
run 0 "$MESA" task update "$TASK_1" --status refine
wait_bg_lines 3
grep -q "id $TASK_1" <<<"$(sed -n '3p' "$BG_LOG")" ||
  fail "a task returned to the refine column must be refined again: $(cat "$BG_LOG")"
ok "a task moved back into the refine column is dispatched again"

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

# ---- spawn failure releases the claim, so the next tick retries ----

# Isolated db/log/server: the fixtures above hold a drained column, and a
# retry assertion needs a task that is provably undispatched at entry.
RETRY_DB="$TMP/retry.db"
mkdir -p "$TMP/retryDir"
RETRY_DIR=$(cd "$TMP/retryDir" && pwd -P)
: > "$BG_LOG"
: > "$FAIL_LOG"

export MESA_DB="$RETRY_DB"
run 0 "$MESA" project create "R" --no-git
R=$(jqs .id)
run 0 "$MESA" project update "$R" --path "$RETRY_DIR"
run 0 "$MESA" task create "$R" "flaky" --status refine
TASK_R=$(jqs .id)

touch "$STUB_DIR/fail"
RETRY_PORT=17787
MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_WATCH_REFINE_TICK_MS=150 \
  "$MESA" serve --port "$RETRY_PORT" --watch-refine >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$RETRY_PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
wait_fail_lines 1
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "a failed spawn must not log a successful bg line"
rm "$STUB_DIR/fail"
wait_bg_lines 1
grep -q "id $TASK_R" "$BG_LOG" ||
  fail "a failed spawn must be retried on a later tick: $(cat "$BG_LOG")"
ok "a spawn failure releases the in-memory claim so the next tick retries (never a silently stranded task)"

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

# ---- archived projects are never dispatched onto ----

# Same rule as the todo watcher's, and for the same reason: the project list
# comes from `Store::list_projects()`, and `list_refine_tasks(None)` excludes
# archived projects too.
ARCH_DB="$TMP/arch.db"
mkdir -p "$TMP/archDir" "$TMP/normDir"
ARCH_DIR=$(cd "$TMP/archDir" && pwd -P)
NORM_DIR=$(cd "$TMP/normDir" && pwd -P)
: > "$BG_LOG"

export MESA_DB="$ARCH_DB"
run 0 "$MESA" project create "Arch" --no-git
ARCH=$(jqs .id)
run 0 "$MESA" project update "$ARCH" --path "$ARCH_DIR"
run 0 "$MESA" project archive "$ARCH"
run 0 "$MESA" task create "$ARCH" "hidden" --status refine
TASK_HIDDEN=$(jqs .id)
run 0 "$MESA" project create "Norm" --no-git
NORM=$(jqs .id)
run 0 "$MESA" project update "$NORM" --path "$NORM_DIR"
run 0 "$MESA" task create "$NORM" "shown" --status refine
TASK_SHOWN=$(jqs .id)

ARCH_PORT=17788
MESA_CLAUDE_BIN="$STUB_DIR/claude" MESA_WATCH_REFINE_TICK_MS=150 \
  "$MESA" serve --port "$ARCH_PORT" --watch-refine >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$ARCH_PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
wait_bg_lines 1
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 1 ] ||
  fail "an archived project must never be dispatched onto: $(cat "$BG_LOG")"
grep -q "id $TASK_SHOWN" "$BG_LOG" || fail "expected the unarchived project's task: $(cat "$BG_LOG")"

run 0 "$MESA" project unarchive "$ARCH"
wait_bg_lines 2
grep -q "id $TASK_HIDDEN" "$BG_LOG" ||
  fail "unarchiving must let the next tick refine its column: $(cat "$BG_LOG")"
ok "an archived project is skipped while its unarchived sibling is refined; unarchiving resumes it on the next tick"

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

echo "ALL OK ($CHECKS checks)"
