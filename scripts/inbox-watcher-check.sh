#!/usr/bin/env bash
# Inbox-watcher gate: exercises `mesa serve --watch-inbox`'s periodic dispatch
# loop against a stub `claude` binary (MESA_CLAUDE_BIN), so no real Claude
# Code is involved. Uses MESA_WATCH_INBOX_TICK_MS (a test-only seam, mirrors
# MESA_CLAUDE_BIN) to shrink the tick from 60s down to test speed.
#
# HOME is pointed at a throwaway dir for the server process: the inbox-watcher
# dispatches in $HOME/.mesa/workspace (an inbox item belongs to no project, so
# there is no local_path to spawn in), and the stub logs its cwd — asserting
# against the real home directory would be neither hermetic nor portable. That
# the folder follows $HOME at all is what proves mesa's home lookup reads the
# environment, not the passwd entry.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
# Pin the user config away from the real ~/.mesa/config.json: this gate
# asserts the BUILT-IN spawn command, so a configured one must not leak in.
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

# ---- stub claude: logs every --bg invocation's (cwd, name, prompt, job id) to
# BG_LOG. Each dispatch gets its own receipt id, its `agents` branch lists every
# id it handed out with one shared status/pid (the todo-watcher gate's reaper
# stub), and `stop` records its argument — the whole of what the reaper
# touches (mesa task 1192). ----

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
BG_LOG="$TMP/bg.log"
JOB_IDS="$TMP/job-ids"
STOPS="$TMP/stops.log"
JOB_STATUS="$TMP/job-status"
JOB_PID="$TMP/job-pid"
JOB_COUNTER="$TMP/job-counter"
touch "$BG_LOG" "$JOB_IDS" "$STOPS"
echo idle > "$JOB_STATUS"
echo 424242 > "$JOB_PID"
echo 0 > "$JOB_COUNTER"
cat > "$STUB_DIR/claude" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--bg" ]; then
  shift
  [ -e "$STUB_DIR/fail" ] && { echo "stub claude is down" >&2; exit 1; }
  AGENT=""
  if [ "\$1" = "--agent" ]; then shift; AGENT="\$1"; shift; fi
  echo "\$AGENT" > "$STUB_DIR/last-agent"
  NAME=""
  if [ "\$1" = "--name" ]; then shift; NAME="\$1"; shift; fi
  PROMPT=""
  if [ "\$1" = "--" ]; then shift; PROMPT="\$1"; fi
  N=\$(( \$(cat "$JOB_COUNTER") + 1 ))
  echo "\$N" > "$JOB_COUNTER"
  ID=\$(printf 'job%04d' "\$N")
  echo "\$ID" >> "$JOB_IDS"
  echo "\$(pwd)|\$NAME|\$PROMPT|\$ID" >> "$BG_LOG"
  echo "backgrounded · \$ID (idle — send a prompt to start)"
  exit 0
fi
if [ "\$1" = "agents" ]; then
  STATUS=\$(cat "$JOB_STATUS")
  PID=\$(cat "$JOB_PID")
  FIRST=1
  printf '['
  while read -r id; do
    [ -z "\$id" ] && continue
    [ "\$FIRST" = 1 ] || printf ','
    FIRST=0
    printf '{"pid":%s,"id":"%s","cwd":"/tmp","kind":"background","startedAt":1783000000000,"sessionId":"%s-0000-0000-0000-000000000000","name":"triage","status":"%s","state":"done"}' "\$PID" "\$id" "\$id" "\$STATUS"
  done < "$JOB_IDS"
  printf ']\n'
  exit 0
fi
if [ "\$1" = "stop" ]; then echo "\$2" >> "$STOPS"; exit 0; fi
exit 2
EOF
chmod +x "$STUB_DIR/claude"

# ---- fixtures ----

# Resolved to the physical path (macOS's /tmp -> /private/tmp symlink): a
# child process's cwd (as set via current_dir/chdir) reports the physical
# path, so the stub's logged pwd would otherwise never match the expectation.
mkdir -p "$TMP/home" "$TMP/projA"
FAKE_HOME=$(cd "$TMP/home" && pwd -P)
# mesa creates this on demand (mesa task 1040); it deliberately does not exist
# yet, and the dispatch assertions below are what prove it appears.
WORKSPACE="$FAKE_HOME/.mesa/workspace"
DIR_A=$(cd "$TMP/projA" && pwd -P)

# A project with a real path and an actionable todo task, purely to prove the
# two watchers are independent: --watch-inbox must never dispatch it.
run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" project update "$A" --path "$DIR_A"
run 0 "$MESA" task create "$A" "task a"
TASK_A=$(jqs .id)

run 0 "$MESA" inbox add --task "$TASK_A" --author "agent-7" --kind change-request "khora: eval errors on undefined
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

# ---- flag ON: dispatches the pending item in the workspace with "Triage mesa inbox item <id>." ----

wait_bg_lines 1
LINE=$(head -1 "$BG_LOG" | cut -d'|' -f1-3)
EXPECT="$WORKSPACE|inbox $ITEM_1: khora: eval errors on undefined|Triage mesa inbox item $ITEM_1."
[ "$LINE" = "$EXPECT" ] || fail "expected '$EXPECT', got '$LINE'"
[ -d "$WORKSPACE" ] || fail "the dispatch folder ~/.mesa/workspace must be created on demand"
ok "spawn failure releases the claim; the next tick retries and dispatches in ~/.mesa/workspace (created on demand), prompt 'Triage mesa inbox item <id>.', session named 'inbox <id>: <first body line>'"

# Triage runs as the `inbox-triage` agent definition (mesa task 1168), which
# the watcher seeds to ~/.claude/agents/inbox-triage.md before the spawn —
# `claude --agent` errors on an agent it has never seen.
[ "$(cat "$STUB_DIR/last-agent")" = "inbox-triage" ] ||
  fail "triage dispatch must pass --agent inbox-triage, got '$(cat "$STUB_DIR/last-agent")'"
AGENT_FILE="$FAKE_HOME/.claude/agents/inbox-triage.md"
[ -f "$AGENT_FILE" ] || fail "the inbox-triage agent definition must be seeded at $AGENT_FILE before the spawn"
grep -q '^name: inbox-triage$' "$AGENT_FILE" || fail "the seeded definition must name the agent: $(head -3 "$AGENT_FILE")"
grep -q '^tools: ' "$AGENT_FILE" || fail "the seeded definition must carry a tool list"
! grep -E '^tools: .*\b(Edit|Write)\b' "$AGENT_FILE" || fail "the triage agent must not be able to Edit/Write: $(grep '^tools:' "$AGENT_FILE")"
ok "triage session is spawned with --agent inbox-triage, its definition seeded to ~/.claude/agents/inbox-triage.md with no Edit/Write"

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

run 0 "$MESA" inbox add --task "$TASK_A" --kind change-request "loki: find exits 0 on no match"
ITEM_2=$(jqs .id)
wait_bg_lines 2
LINE=$(sed -n 2p "$BG_LOG" | cut -d'|' -f1-3)
EXPECT="$WORKSPACE|inbox $ITEM_2: loki: find exits 0 on no match|Triage mesa inbox item $ITEM_2."
[ "$LINE" = "$EXPECT" ] || fail "expected '$EXPECT', got '$LINE'"
ok "a new inbox item is dispatched on the next tick, with its own id"

# ---- the whole pending queue goes out in ONE tick (no per-item pacing) ----

# The inbox is one global queue with no per-project cap to pace it, unlike
# the todo-watcher's one-agent-per-project. Three at once must all dispatch.
run 0 "$MESA" inbox add --task "$TASK_A" --kind change-request "mesa: item three"
ITEM_3=$(jqs .id)
run 0 "$MESA" inbox add --task "$TASK_A" --kind change-request "mesa: item four"
run 0 "$MESA" inbox add --task "$TASK_A" --kind change-request "mesa: item five"
wait_bg_lines 5
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 5 ] ||
  fail "expected exactly 5 dispatches, got: $(cat "$BG_LOG")"
ok "every pending item dispatches in a single tick, then stops"

# ---- only change requests are triaged (task 846) ----

# A task summary is an agent reporting to a person — every /execute-todo
# close-out sends one — so the watcher must leave it alone, tick after tick,
# rather than answering a report with an agent. The kind never changes, so
# this is a permanent skip and not a delay.
run 0 "$MESA" inbox add --task "$TASK_A" --kind task-summary "mesa task 846 is done: inbox items now carry a type"
ITEM_SUMMARY=$(jqs .id)
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 5 ] ||
  fail "a task summary must never dispatch: $(cat "$BG_LOG")"
! grep -q "Triage mesa inbox item $ITEM_SUMMARY." "$BG_LOG" ||
  fail "a task summary must never be triaged"
run 0 "$MESA" inbox show "$ITEM_SUMMARY"
[ "$(jqs .kind)" = "task-summary" ] || fail "the watcher must not touch the item at all"
ok "a task-summary item is never dispatched, on this tick or any later one"

# ---- --watch-todo is a separate flag: the todo backlog is untouched ----

[ "$(curl -sf "http://127.0.0.1:$PORT/api/tasks/$TASK_A" | jq -r .status)" = "todo" ] ||
  fail "--watch-inbox alone must not claim a todo task"
! grep -q "execute-mesa-task" "$BG_LOG" ||
  fail "--watch-inbox alone must not dispatch the todo watcher"
ok "watch_inbox is independent of watch_todo: no task claimed, no /execute-mesa-task dispatch"

# ---- the reaper (mesa task 1192): a triage session is stopped once its item
# is triaged — archived, assigned or deleted — and the session is not busy,
# exactly once. Same map and same 20s loop as the todo-watcher's reaper, which
# `--watch-inbox` alone must start. ----

job_for() { # job_for <item id> -> the receipt id of that item's dispatch
  grep "|Triage mesa inbox item $1\\.|" "$BG_LOG" | cut -d'|' -f4
}
wait_stop_lines() { # wait_stop_lines <n>
  local n=$1
  for _ in $(seq 1 60); do
    [ "$(wc -l < "$STOPS")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n stop(s); log:\n$(cat "$STOPS")"
}

# Every item is still pending, so however idle the sessions are, none stops.
sleep 1
[ "$(wc -l < "$STOPS")" -eq 0 ] ||
  fail "a pending item's triage session must never be stopped: $(cat "$STOPS")"
ok "the reaper leaves a triage session alone while its item is pending"

# Archived with a reason — the agent's own verdict — while the session is still
# `busy` writing it: left for a later pass. Flipped a few ticks before the
# archive, as the todo-watcher gate does, so no pass pairs an old `idle`
# listing with the archived row.
echo busy > "$JOB_STATUS"
sleep 0.8
run 0 "$MESA" inbox archive "$ITEM_3" --reason "not actionable"
[ "$(jqs .archived_at)" != "null" ] || fail "archive must stamp archived_at"
sleep 1
[ "$(wc -l < "$STOPS")" -eq 0 ] ||
  fail "a busy session must not be stopped: $(cat "$STOPS")"
ok "a session still busy after its item was archived is left for a later pass"

echo idle > "$JOB_STATUS"
wait_stop_lines 1
sleep 1
[ "$(wc -l < "$STOPS")" -eq 1 ] ||
  fail "a stopped session must be stopped exactly once: $(cat "$STOPS")"
[ "$(head -1 "$STOPS")" = "$(job_for "$ITEM_3")" ] ||
  fail "expected 'claude stop $(job_for "$ITEM_3")', got '$(head -1 "$STOPS")'"
ok "archiving a dispatched item stops exactly its own session, exactly once"

# ---- an item leaving the inbox (triage's other terminal states) is quiet,
# and its session is stopped too ----

# Both of the triage agent's acting outcomes remove the item: a viable
# request becomes a task and the item is deleted, a non-viable one is
# converted by `inbox assign`. Neither may provoke a re-dispatch.
run 0 "$MESA" inbox delete "$ITEM_1"
run 0 "$MESA" inbox assign "$ITEM_2" "$A"
[ "$(jqs .status)" = "backlog" ] || fail "inbox assign must create a backlog task"
wait_stop_lines 3
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 5 ] ||
  fail "items that left the inbox must not re-dispatch: $(cat "$BG_LOG")"
[ "$(wc -l < "$STOPS")" -eq 3 ] ||
  fail "expected exactly 3 stops (archived, deleted, assigned): $(cat "$STOPS")"
grep -qx "$(job_for "$ITEM_1")" "$STOPS" || fail "the deleted item's session must be stopped: $(cat "$STOPS")"
grep -qx "$(job_for "$ITEM_2")" "$STOPS" || fail "the assigned item's session must be stopped: $(cat "$STOPS")"
curl -sf "http://127.0.0.1:$PORT/api/inbox" >/dev/null ||
  fail "server must still be healthy after the watcher pruned its dedup set"
stop_server
ok "an item removed by triage (delete or assign) is pruned, never re-dispatched, and its session stopped"

# ---- a restart re-triages what is still pending, never what is archived ----

# The dedup set is in memory, so a restart re-dispatches every item still
# sitting untriaged (the recoverable direction). An archived request has
# been triaged already — the archive is the verdict — and before mesa task
# 1192 only that emptied set stood between it and a fresh agent, so every
# restart re-triaged every archived request.
start_server --watch-inbox
wait_bg_lines 7
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 7 ] ||
  fail "a restart re-dispatches exactly the two pending items: $(cat "$BG_LOG")"
[ "$(grep -c "|Triage mesa inbox item $ITEM_3\\.|" "$BG_LOG")" -eq 1 ] ||
  fail "an archived item must not be re-triaged after a restart: $(cat "$BG_LOG")"
stop_server
ok "after a restart the pending items are re-dispatched and the archived one is not"

echo
echo "inbox-watcher check passed ($CHECKS checks)"
