#!/usr/bin/env bash
# Retro gate (mesa task 1158): the session retrospective over the CLI and
# `mesa serve --watch-retro`, against a stub `claude` binary (MESA_CLAUDE_BIN)
# so no real Claude Code is involved. Uses MESA_WATCH_RETRO_TICK_MS (a
# test-only seam, mirrors MESA_WATCH_INBOX_TICK_MS) to shrink the tick from an
# hour down to test speed.
#
# HOME is pointed at a throwaway dir for the server process: a retrospective
# spans every project, so it runs in $HOME/.mesa/workspace, and the stub logs
# its cwd — the inbox-watcher gate's reasoning, and the same hermeticity.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
# Pin the user config away from the real ~/.mesa/config.json: this gate
# asserts the BUILT-IN spawn command and interval, so a configured one must
# not leak in.
export MESA_CONFIG_FILE="$TMP/config.json"

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
jqe() { jq -r "$1" <<<"$STDERR"; }
# The sorted key set of a JSON object, one line, for the --quiet contract.
keys() { jq -r 'keys | join(",")' <<<"$1"; }

# ---- stub claude: logs every --bg invocation's (cwd, name, prompt) to BG_LOG ----

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
BG_LOG="$TMP/bg.log"
# One line per --bg invocation refused while the `fail` marker exists: the
# observable signal that the watcher retried, and therefore that the previous
# attempt's run row was rolled back (a row left behind would make the next
# tick "not due" for 72 hours, so a second refused call can only follow a
# deleted row).
FAIL_LOG="$TMP/fail.log"
touch "$BG_LOG" "$FAIL_LOG"
cat > "$STUB_DIR/claude" <<EOS
#!/usr/bin/env bash
if [ "\$1" = "--bg" ]; then
  shift
  [ -e "$STUB_DIR/fail" ] && { echo "stub claude is down" >&2; echo refused >> "$FAIL_LOG"; exit 1; }
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
EOS
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"

mkdir -p "$TMP/home"
FAKE_HOME=$(cd "$TMP/home" && pwd -P)
export HOME="$FAKE_HOME"
WORKSPACE="$FAKE_HOME/.mesa/workspace"

# ---- fixtures: a task for the inbox item a finding links to ----

run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" task create "$A" "task a"
TASK_A=$(jqs .id)
ok "fixtures: project A, task $TASK_A"

# ---- the finding log: record, dedup bump, a second fingerprint ----

run 0 "$MESA" retro finding record --fingerprint swe/denial --subject swe --kind denial \
  --summary "swe keeps asking to run git push" --evidence "session abc: 3 denials" \
  --session-id sess-1
[ "$(jqs .new)" = "true" ] || fail "first record must be new: $STDOUT"
F1=$(jqs .finding.id)
[ "$(jqs .finding.count)" = "1" ] || fail "a new finding has count 1: $STDOUT"
[ "$(jqs .finding.evidence)" = "session abc: 3 denials" ] || fail "evidence is the line given: $STDOUT"
[ "$(jqs .finding.inbox_item_id)" = "null" ] || fail "a new finding is unlinked: $STDOUT"
[ "$(jqs '.finding.session_ids | join(",")')" = "sess-1" ] ||
  fail "the recorded session id rides back: $STDOUT"
FULL_KEYS=$(keys "$(jqs .finding)")
[ "$FULL_KEYS" = "count,evidence,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject,summary" ] ||
  fail "finding key set: $FULL_KEYS"
ok "finding record: a new fingerprint is {new: true, finding: {count 1, evidence as given, unlinked}}"

run 0 "$MESA" retro finding record --fingerprint swe/denial --subject swe --kind denial \
  --summary "a different summary" --evidence "session def: 2 denials" --session-id sess-2
[ "$(jqs .new)" = "false" ] || fail "the repeat must answer new: false: $STDOUT"
[ "$(jqs .finding.id)" = "$F1" ] || fail "the repeat is the same row: $STDOUT"
[ "$(jqs .finding.count)" = "2" ] || fail "the repeat bumps count to 2: $STDOUT"
[ "$(jqs .finding.summary)" = "swe keeps asking to run git push" ] || fail "the summary stays as first recorded: $STDOUT"
[ "$(jqs .finding.evidence)" = "$(printf 'session abc: 3 denials\nsession def: 2 denials')" ] ||
  fail "evidence is appended, newest last: $STDOUT"
# The acceptance of mesa task 1255: a second session is KEPT beside the first,
# which is the whole reason the ids are a sibling table and not a column.
[ "$(jqs '.finding.session_ids | join(",")')" = "sess-1,sess-2" ] ||
  fail "a repeat from another session keeps both ids: $STDOUT"
ok "finding record of a known fingerprint: new false, count 2, evidence appended, summary kept, both session ids"

run 0 "$MESA" retro finding record --fingerprint khora/timeout --subject khora --kind timeout \
  --summary "khora find hangs on a slow page"
[ "$(jqs .new)" = "true" ] || fail "a different fingerprint is new: $STDOUT"
F2=$(jqs .finding.id)
[ "$(jqs .finding.evidence)" = "null" ] || fail "no --evidence is null, not empty: $STDOUT"
[ "$(jqs '.finding.session_ids | length')" = "0" ] ||
  fail "no --session-id is an empty set, not a null: $STDOUT"
ok "a second fingerprint is a new finding, recorded without a session id"

# ---- --quiet: record/link/show drop summary + evidence; list rejects it ----

# A second later, so this report moves swe/denial's last_seen_at past
# khora/timeout's (timestamps are whole seconds) and the list order below
# is a real newest-seen order rather than the id tiebreak.
sleep 1
run 0 "$MESA" retro finding record --quiet --fingerprint swe/denial --subject swe --kind denial \
  --summary x --evidence "session ghi: 1 denial" --session-id sess-1
[ "$(jqs .new)" = "false" ] || fail "quiet record keeps the composite's keys: $STDOUT"
[ "$(jqs .finding.count)" = "3" ] || fail "quiet changes stdout only: $STDOUT"
[ "$(jqs '.finding.session_ids | join(",")')" = "sess-1,sess-2" ] ||
  fail "a repeat from a known session is idempotent: $STDOUT"
# session_ids is a bounded set of pointers — the point of recording one — so
# --quiet KEEPS it.
[ "$(keys "$(jqs .finding)")" = "count,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject" ] ||
  fail "quiet finding key set: $(keys "$(jqs .finding)")"
run 0 "$MESA" retro finding show "$F1" --quiet
[ "$(keys "$STDOUT")" = "count,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject" ] ||
  fail "quiet show key set: $(keys "$STDOUT")"
run 0 "$MESA" retro finding show "$F1"
[ "$(keys "$STDOUT")" = "$FULL_KEYS" ] || fail "default show is the full record: $(keys "$STDOUT")"
[ "$(jqs .count)" = "3" ] || fail "show reflects the third report: $STDOUT"
run 0 "$MESA" retro finding get "$F1"
[ "$(jqs .id)" = "$F1" ] || fail "get is an alias for show"
run 2 "$MESA" retro finding list --quiet
[ -z "$STDOUT" ] || fail "a usage error prints nothing on stdout"
ok "--quiet drops summary and evidence (keeping session_ids) on record/show and is a usage error (exit 2) on list"

# ---- list: newest-seen first, bare array, --limit ----

run 0 "$MESA" retro finding list
[ "$(jqs 'map(.id) | join(",")')" = "$F1,$F2" ] || fail "list is most recently seen first: $STDOUT"
[ "$(jqs 'map(has("summary")) | all')" = "true" ] || fail "list carries the full rows: $STDOUT"
[ "$(jqs '.[0].session_ids | join(",")')" = "sess-1,sess-2" ] ||
  fail "list derives the session ids too: $STDOUT"
run 0 "$MESA" retro finding list --limit 1
[ "$(jqs 'length')" = "1" ] || fail "--limit bounds the list: $STDOUT"
[ "$(jqs '.[0].id')" = "$F1" ] || fail "--limit keeps the newest-seen: $STDOUT"
ok "finding list is a bare array, newest-seen first, bounded by --limit"

# ---- link: to a real inbox item; not_found / validation otherwise ----

run 0 "$MESA" inbox add --task "$TASK_A" --author retro --kind change-request "swe keeps asking to run git push"
ITEM=$(jqs .id)
run 0 "$MESA" retro finding link --id "$F1" --inbox-item "$ITEM"
[ "$(jqs .inbox_item_id)" = "$ITEM" ] || fail "link sets inbox_item_id: $STDOUT"
[ "$(jqs '.session_ids | join(",")')" = "sess-1,sess-2" ] || fail "link derives the ids too: $STDOUT"
[ "$(jqs .count)" = "3" ] || fail "link bumps nothing: $STDOUT"
run 0 "$MESA" retro finding link --id "$F1" --inbox-item "$ITEM" --quiet
[ "$(keys "$STDOUT")" = "count,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject" ] ||
  fail "quiet link key set: $(keys "$STDOUT")"
run 1 "$MESA" retro finding link --id 9999 --inbox-item "$ITEM"
[ "$(jqe .error.code)" = "not_found" ] || fail "linking an unknown finding is not_found: $STDERR"
[ -z "$STDOUT" ] || fail "an error prints nothing on stdout"
run 1 "$MESA" retro finding link --id "$F1" --inbox-item 9999
[ "$(jqe .error.code)" = "validation" ] || fail "linking to an unknown inbox item is validation: $STDERR"
run 1 "$MESA" retro finding show 9999
[ "$(jqe .error.code)" = "not_found" ] || fail "show of an unknown finding is not_found: $STDERR"
# Triage deletes the item it assigns (SET NULL): the finding keeps its memory.
run 0 "$MESA" inbox delete "$ITEM"
run 0 "$MESA" retro finding show "$F1"
[ "$(jqs .inbox_item_id)" = "null" ] || fail "a deleted item unlinks the finding: $STDOUT"
[ "$(jqs .count)" = "3" ] || fail "…and nothing else changes: $STDOUT"
ok "finding link: sets the pointer without a bump; not_found for an unknown finding, validation for an unknown item; ON DELETE SET NULL"

# ---- validation shapes ----

LONG_KEY=$(printf 'k%.0s' $(seq 1 201))
LONG_SUMMARY=$(printf 's%.0s' $(seq 1 2001))
LONG_EVIDENCE=$(printf 'e%.0s' $(seq 1 2001))
check_validation() { # check_validation <label> <args...>
  local label=$1; shift
  run 1 "$MESA" retro finding record "$@"
  [ "$(jqe .error.code)" = "validation" ] || fail "$label must be validation: $STDERR"
  [ -z "$STDOUT" ] || fail "$label: an error prints nothing on stdout"
}
check_validation "empty fingerprint" --fingerprint "" --subject s --kind k --summary sum
check_validation "blank subject" --fingerprint f --subject "  " --kind k --summary sum
check_validation "empty kind" --fingerprint f --subject s --kind "" --summary sum
check_validation "empty summary" --fingerprint f --subject s --kind k --summary ""
check_validation "long fingerprint" --fingerprint "$LONG_KEY" --subject s --kind k --summary sum
check_validation "long subject" --fingerprint f --subject "$LONG_KEY" --kind k --summary sum
check_validation "long kind" --fingerprint f --subject s --kind "$LONG_KEY" --summary sum
check_validation "long summary" --fingerprint f --subject s --kind k --summary "$LONG_SUMMARY"
check_validation "long evidence" --fingerprint f --subject s --kind k --summary sum --evidence "$LONG_EVIDENCE"
check_validation "blank session id" --fingerprint f --subject s --kind k --summary sum --session-id "  "
check_validation "long session id" --fingerprint f --subject s --kind k --summary sum --session-id "$LONG_KEY"
run 0 "$MESA" retro finding list
[ "$(jqs 'length')" = "2" ] || fail "a rejected record writes nothing: $STDOUT"
run 2 "$MESA" retro finding record --fingerprint f --subject s --kind k
[ -z "$STDOUT" ] || fail "a missing required flag is a usage error with empty stdout"
ok "every validation shape is exit 1 / validation writing nothing; a missing flag is exit 2"

# ---- status on a fresh install: due, nothing to point at ----

run 0 "$MESA" retro status
[ "$(jqs .last_run)" = "null" ] || fail "no run yet: $STDOUT"
[ "$(jqs .due)" = "true" ] || fail "nothing has run: due: $STDOUT"
[ "$(jqs .next_due_at)" = "null" ] || fail "no run, no deadline: $STDOUT"
[ "$(jqs .interval_hours)" = "72" ] || fail "the built-in interval is 72h: $STDOUT"
[ "$(jqs .findings)" = "2" ] || fail "status counts the log: $STDOUT"
[ "$(jqs .linked)" = "0" ] || fail "status counts linked findings: $STDOUT"
run 0 "$MESA" retro status --quiet
[ "$(keys "$STDOUT")" = "due,findings,interval_hours,last_run,linked,next_due_at" ] ||
  fail "status key set: $(keys "$STDOUT")"
run 0 "$MESA" retro show
[ "$(jqs .due)" = "true" ] || fail "show is an alias for status"
ok "retro status on a fresh install: due, last_run null, next_due_at null, 72h, counts"

# ---- a failed spawn leaves NO run row ----

touch "$STUB_DIR/fail"
run 1 "$MESA" retro run
[ "$(jqe .error.code)" = "unavailable" ] || fail "a failed spawn is unavailable: $STDERR"
[ -z "$STDOUT" ] || fail "a failed run prints nothing on stdout"
run 0 "$MESA" retro status
[ "$(jqs .last_run)" = "null" ] || fail "a failed spawn must delete its run row: $STDOUT"
[ "$(jqs .due)" = "true" ] || fail "…so the next attempt is not a conflict: $STDOUT"
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "a failing spawn must log nothing"
rm -f "$STUB_DIR/fail"
ok "retro run with a failing claude is unavailable and leaves no run row"

# ---- retro run: records a manual run, seeds the definition, spawns in the workspace ----

run 0 "$MESA" retro run
RUN1=$(jqs .id)
[ "$(jqs .trigger)" = "manual" ] || fail "a CLI run is trigger manual: $STDOUT"
[ "$(keys "$STDOUT")" = "id,spawned_at,started_at,trigger" ] || fail "run key set: $(keys "$STDOUT")"
[ "$(jqs .spawned_at)" != "null" ] || fail "a run that spawned prints spawned_at: $STDOUT"
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "one spawn: $(cat "$BG_LOG")"
LINE=$(head -1 "$BG_LOG")
EXPECT="$WORKSPACE|mesa retro $RUN1|Run mesa session retrospective $RUN1."
[ "$LINE" = "$EXPECT" ] || fail "expected '$EXPECT', got '$LINE'"
[ "$(cat "$STUB_DIR/last-agent")" = "mesa-retro" ] ||
  fail "the run must pass --agent mesa-retro, got '$(cat "$STUB_DIR/last-agent")'"
AGENT_FILE="$FAKE_HOME/.claude/agents/mesa-retro.md"
[ -f "$AGENT_FILE" ] || fail "the mesa-retro agent definition must be seeded at $AGENT_FILE before the spawn"
grep -q '^name: mesa-retro$' "$AGENT_FILE" || fail "the seeded definition must name the agent: $(head -3 "$AGENT_FILE")"
grep -q '^model: sonnet$' "$AGENT_FILE" || fail "the retrospective clusters and writes on sonnet"
grep -q '^tools: ' "$AGENT_FILE" || fail "the seeded definition must carry a tool list"
! grep -E '^tools: .*\b(Edit|Write)\b' "$AGENT_FILE" || fail "the retro agent must not be able to Edit/Write: $(grep '^tools:' "$AGENT_FILE")"
grep -q 'haiku' "$AGENT_FILE" && grep -q 'opus' "$AGENT_FILE" && grep -q 'Never fable' "$AGENT_FILE" ||
  fail "the definition must state the model-per-step rule"
grep -q 'mesa retro finding record' "$AGENT_FILE" || fail "the definition must route findings through the log"
grep -q -- '--kind change-request --author retro --task' "$AGENT_FILE" || fail "the definition must file through inbox add"
ok "retro run records a manual run and spawns --agent mesa-retro in ~/.mesa/workspace, named 'mesa retro <id>', with the definition seeded (sonnet, no Edit/Write, model-per-step rule)"

# ---- inside the interval: conflict; --force runs anyway ----

run 1 "$MESA" retro run
[ "$(jqe .error.code)" = "conflict" ] || fail "a second run inside the interval is conflict: $STDERR"
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "a conflict spawns nothing"
run 0 "$MESA" retro status
[ "$(jqs .last_run.id)" = "$RUN1" ] || fail "status names the run: $STDOUT"
[ "$(jqs .due)" = "false" ] || fail "just ran: not due: $STDOUT"
# next_due_at = started_at + 72h, on the store's own clock.
[ "$(jqs '((.last_run.started_at | strptime("%Y-%m-%d %H:%M:%S") | mktime) + 72 * 3600) == (.next_due_at | strptime("%Y-%m-%d %H:%M:%S") | mktime)')" = "true" ] ||
  fail "next_due_at must be started_at + 72h: $STDOUT"
run 0 "$MESA" retro run --force --quiet
RUN2=$(jqs .id)
[ "$RUN2" -gt "$RUN1" ] || fail "--force records a new run: $STDOUT"
[ "$(keys "$STDOUT")" = "id,spawned_at,started_at,trigger" ] || fail "a run has nothing to drop under --quiet: $(keys "$STDOUT")"
[ "$(wc -l < "$BG_LOG")" -eq 2 ] || fail "--force spawns: $(cat "$BG_LOG")"
grep -q "|mesa retro $RUN2|Run mesa session retrospective $RUN2." "$BG_LOG" || fail "the forced run carries its own id"
ok "retro run inside the interval is conflict; --force runs and records a new run; next_due_at is started_at + interval"

# ---- the interval is the config's `watchers.retro-interval-hours`, read fresh ----

cat > "$MESA_CONFIG_FILE" <<'EOC'
{"watchers": {"retro-interval-hours": 1}}
EOC
run 0 "$MESA" retro status
[ "$(jqs .interval_hours)" = "1" ] || fail "the configured interval is read: $STDOUT"
[ "$(jqs '((.last_run.started_at | strptime("%Y-%m-%d %H:%M:%S") | mktime) + 3600) == (.next_due_at | strptime("%Y-%m-%d %H:%M:%S") | mktime)')" = "true" ] ||
  fail "next_due_at follows the configured interval: $STDOUT"
# A hand-edited out-of-range value clamps on read (the todo-concurrency posture).
cat > "$MESA_CONFIG_FILE" <<'EOC'
{"watchers": {"retro-interval-hours": 0}}
EOC
run 0 "$MESA" retro status
[ "$(jqs .interval_hours)" = "1" ] || fail "a hand-edited 0 clamps to 1: $STDOUT"
rm -f "$MESA_CONFIG_FILE"
ok "retro-interval-hours governs status/run with no restart; a hand-edited bad value clamps on read"

# ---- the watcher: serve --watch-retro ----

PORT=17801
wait_for_server() {
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $PORT"
}
wait_bg_lines() { # wait_bg_lines <n> -> blocks until BG_LOG has >= n lines, or fails
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$BG_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n bg dispatch(es); log:\n$(cat "$BG_LOG")"
}
wait_fail_lines() { # wait_fail_lines <n> -> blocks until the stub has refused >= n spawns, or fails
  local n=$1
  for _ in $(seq 1 50); do
    [ "$(wc -l < "$FAIL_LOG")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n refused spawn(s); got $(wc -l < "$FAIL_LOG")"
}
start_server() { # start_server <flags...>
  MESA_WATCH_RETRO_TICK_MS=150 "$MESA" serve --port "$PORT" "$@" >/dev/null 2>&1 &
  SERVER_PID=$!
  wait_for_server
}
stop_server() {
  [ -n "${SERVER_PID:-}" ] || return 0
  kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
}
api() { # api <method> <path> [json-body] -> STDOUT=body, CODE=status
  local method=$1 path=$2 body=${3:-}
  CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "http://127.0.0.1:$PORT$path")
  STDOUT=$(cat "$TMP/body")
}

# A fresh db, so the watcher's first tick finds nothing has run.
export MESA_DB="$TMP/watcher.db"
: > "$BG_LOG"

# flag OFF: no dispatch, ever.
start_server
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "flag off: watcher must not dispatch"
run 0 "$MESA" retro status
[ "$(jqs .last_run)" = "null" ] || fail "flag off: no run row"

# GET/PUT /api/config/watchers carries the new key beside todo_concurrency.
api GET /api/config/watchers
[ "$CODE" = "200" ] || fail "GET /api/config/watchers: $CODE $STDOUT"
[ "$(jqs .retro_interval_hours)" = "null" ] || fail "unconfigured: null: $STDOUT"
[ "$(jqs .retro_interval_hours_default)" = "72" ] || fail "the built-in behind it: $STDOUT"
api PUT /api/config/watchers '{"retro_interval_hours": 24}'
[ "$CODE" = "200" ] || fail "PUT /api/config/watchers: $CODE $STDOUT"
[ "$(jqs .retro_interval_hours)" = "24" ] || fail "PUT echoes the getter: $STDOUT"
[ "$(jq -r '.watchers["retro-interval-hours"]' "$MESA_CONFIG_FILE")" = "24" ] || fail "the key lands in the file"
run 0 "$MESA" retro status
[ "$(jqs .interval_hours)" = "24" ] || fail "the CLI reads what the page wrote: $STDOUT"
for bad in 0 8761 1.5 '"24"'; do
  api PUT /api/config/watchers "{\"retro_interval_hours\": $bad}"
  [ "$CODE" = "422" ] || fail "PUT $bad must be 422, got $CODE: $STDOUT"
  [ "$(jqs .error.code)" = "validation" ] || fail "PUT $bad: $STDOUT"
  [ "$(jq -r '.watchers["retro-interval-hours"]' "$MESA_CONFIG_FILE")" = "24" ] || fail "a rejected PUT writes nothing"
done
api PUT /api/config/watchers '{"todo_concurrency": 3}'
[ "$(jqs .retro_interval_hours)" = "24" ] || fail "saving the sibling key preserves this one: $STDOUT"
api PUT /api/config/watchers '{"retro_interval_hours": null}'
[ "$(jqs .retro_interval_hours)" = "null" ] || fail "null restores the built-in: $STDOUT"
[ "$(jqs .todo_concurrency)" = "3" ] || fail "…and preserves the sibling: $STDOUT"
rm -f "$MESA_CONFIG_FILE"
stop_server
ok "watch_retro off: no dispatch; GET/PUT /api/config/watchers carry retro_interval_hours (422 on a bad value writing nothing, null restores 72, siblings preserved)"

# spawn failure: the run row is rolled back, so a later tick retries. The
# proof is the RETRY, not a point-in-time read of the row: each tick inserts
# the row, spawns, and deletes it again on failure, so `retro status` sampled
# at a random instant may land inside that window and see a row that is
# about to go. A second refused spawn, on the other hand, can only happen
# because the first attempt's row was deleted (a leftover row makes the next
# tick "not due" for 72 hours).
touch "$STUB_DIR/fail"
start_server --watch-retro
wait_fail_lines 2
[ "$(wc -l < "$BG_LOG")" -eq 0 ] || fail "a failing spawn must log nothing"
rm -f "$STUB_DIR/fail"

# flag ON: exactly one dispatch, trigger watcher, and not again inside the interval.
wait_bg_lines 1
run 0 "$MESA" retro status
RUN_W=$(jqs .last_run.id)
[ "$(jqs .last_run.trigger)" = "watcher" ] || fail "a watcher run is trigger watcher: $STDOUT"
[ "$(jqs .due)" = "false" ] || fail "just dispatched: not due: $STDOUT"
LINE=$(head -1 "$BG_LOG")
EXPECT="$WORKSPACE|mesa retro $RUN_W|Run mesa session retrospective $RUN_W."
[ "$LINE" = "$EXPECT" ] || fail "expected '$EXPECT', got '$LINE'"
[ "$(cat "$STUB_DIR/last-agent")" = "mesa-retro" ] || fail "the watcher spawns --agent mesa-retro"
sleep 1
[ "$(wc -l < "$BG_LOG")" -eq 1 ] || fail "inside the interval the watcher must not dispatch again: $(cat "$BG_LOG")"
# The run row is the claim the CLI sees too.
run 1 "$MESA" retro run
[ "$(jqe .error.code)" = "conflict" ] || fail "a CLI run against the watcher's row is conflict: $STDERR"
stop_server
ok "watch_retro on: a failed spawn leaves no row and retries; then exactly one 'watcher' dispatch per interval, and the CLI sees its claim"

echo
echo "retro check passed ($CHECKS checks)"
