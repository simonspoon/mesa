#!/usr/bin/env bash
# Cost-guard gate (mesa task 1018, docs/cost-guard.md): proves that
# `serve --watch-cost` notices a runaway Claude Code session WHILE it runs,
# files exactly one inbox alert per session per tripped threshold, files
# nothing for a session it cannot attribute to a task, and that the `guard`
# config section behaves like the six sections it sits beside.
#
# Everything the guard reads is synthetic: a tiny Claude Code transcript tree
# under MESA_CC_PROJECTS_DIR (the same seam scripts/cc-check.sh uses — `cc
# live` parses these files directly and never touches the db) and a throwaway
# mesa db. The config file is read at its REAL default location, so HOME is
# pointed at a throwaway dir, exactly as scripts/config-check.sh does.
#
# The guard shells out to nothing and spawns nothing, so this gate needs no
# stub binaries — the only external state is the transcript tree.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT

export MESA_DB="$TMP/mesa.db"
export MESA_CC_PROJECTS_DIR="$TMP/tree"
FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_HOME" "$MESA_CC_PROJECTS_DIR"
CONFIG="$FAKE_HOME/.mesa/config.json"
PORT=17798

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

run() {
  local expected=$1; shift
  set +e
  STDOUT=$(HOME="$FAKE_HOME" "$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }

wait_for_server() {
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $PORT"
}
start_server() { # start_server <flags...>
  HOME="$FAKE_HOME" MESA_WATCH_COST_TICK_MS=150 \
    "$MESA" serve --port "$PORT" "$@" >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  wait_for_server
}
stop_server() {
  [ -n "${SERVER_PID:-}" ] || return 0
  kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
}
inbox_count() { HOME="$FAKE_HOME" "$MESA" inbox list | jq 'length'; }
wait_inbox() { # wait_inbox <n> — blocks until the inbox holds >= n items
  for _ in $(seq 1 60); do
    [ "$(inbox_count)" -ge "$1" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $1 inbox item(s); server log:\n$(cat "$TMP/server.log")"
}

# ---- the synthetic world -------------------------------------------------
#
# Three live sessions, written with a timestamp of "now" so `cc live` sees them
# inside its window:
#
#   runaway  — a spin loop in a folder mesa knows: 2.7B tokens, 99.8% of them
#              cache reads, an estimated cost well past every threshold. The
#              alert for it must be filed against the task whose OWNER is its
#              session id (resolution rung 1).
#   quiet    — a healthy session in the same folder, far under every threshold.
#              It must produce nothing, ever.
#   orphan   — a runaway in a folder no mesa project claims, claimed by no
#              task. It must produce NO inbox item (the guard never invents a
#              task to hang one on) and must still be visible in `mesa cc guard`.

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
REPO="$TMP/repo"
mkdir -p "$REPO" "$MESA_CC_PROJECTS_DIR/-repo" "$MESA_CC_PROJECTS_DIR/-elsewhere"

RUNAWAY=c2b83256-1111-2222-3333-444455556666
QUIET=aaaa1111-2222-3333-4444-555566667777
ORPHAN=bbbb1111-2222-3333-4444-555566667777

# 2.76B tokens at 99.8% cache reads, in one line per usage event. The cost is
# whatever the built-in price table makes of them — comfortably over $25.
{
  echo "{\"type\":\"user\",\"sessionId\":\"$RUNAWAY\",\"timestamp\":\"$NOW\",\"cwd\":\"$REPO\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}"
  for i in $(seq 1 6); do
    echo "{\"type\":\"assistant\",\"uuid\":\"r$i\",\"sessionId\":\"$RUNAWAY\",\"timestamp\":\"$NOW\",\"cwd\":\"$REPO\",\"message\":{\"id\":\"msg_r$i\",\"model\":\"claude-opus-4-8\",\"usage\":{\"input_tokens\":1000,\"output_tokens\":80,\"cache_read_input_tokens\":459080000,\"cache_creation_input_tokens\":0}}}"
  done
} > "$MESA_CC_PROJECTS_DIR/-repo/runaway.jsonl"

cat > "$MESA_CC_PROJECTS_DIR/-repo/quiet.jsonl" <<JSONL
{"type":"user","sessionId":"$QUIET","timestamp":"$NOW","cwd":"$REPO","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"q1","sessionId":"$QUIET","timestamp":"$NOW","cwd":"$REPO","message":{"id":"msg_q1","model":"claude-opus-4-8","usage":{"input_tokens":900,"output_tokens":700,"cache_read_input_tokens":40000,"cache_creation_input_tokens":100}}}
JSONL

{
  echo "{\"type\":\"user\",\"sessionId\":\"$ORPHAN\",\"timestamp\":\"$NOW\",\"cwd\":\"$TMP/nowhere\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}"
  for i in $(seq 1 6); do
    echo "{\"type\":\"assistant\",\"uuid\":\"o$i\",\"sessionId\":\"$ORPHAN\",\"timestamp\":\"$NOW\",\"cwd\":\"$TMP/nowhere\",\"message\":{\"id\":\"msg_o$i\",\"model\":\"claude-opus-4-8\",\"usage\":{\"input_tokens\":1000,\"output_tokens\":80,\"cache_read_input_tokens\":459080000,\"cache_creation_input_tokens\":0}}}"
  done
} > "$MESA_CC_PROJECTS_DIR/-elsewhere/orphan.jsonl"

# ---- the mesa side: a project bound to $REPO, and a claimed task ----------

run 0 "$MESA" project create guarded --path "$REPO" --no-git
PROJECT=$(jqs .id)
run 0 "$MESA" project update "$PROJECT" --path "$REPO"
run 0 "$MESA" task create "$PROJECT" "Refactor the parser"
TASK=$(jqs .id)
run 0 "$MESA" task claim "$TASK" --owner "$RUNAWAY"
[ "$(jqs .owner)" = "$RUNAWAY" ] || fail "claim did not stick"

# ---- `mesa cc guard`: the read-only inspector ------------------------------

run 0 "$MESA" cc guard
[ "$(jqs '.sessions | length')" = "2" ] ||
  fail "expected the two runaways to breach, got: $STDOUT"
[ "$(jqs ".sessions[] | select(.session_id==\"$RUNAWAY\") | .task_id")" = "$TASK" ] ||
  fail "the claimed session must resolve to task $TASK: $STDOUT"
[ "$(jqs ".sessions[] | select(.session_id==\"$ORPHAN\") | .task_id")" = "null" ] ||
  fail "the unattributable session must report task_id null: $STDOUT"
[ "$(jqs ".sessions[] | select(.session_id==\"$RUNAWAY\") | .breaches | map(.threshold) | sort | join(\",\")")" = "cost,spin,tokens" ] ||
  fail "the runaway must trip all three rules: $STDOUT"
jq -e '.thresholds.cost_usd == 25' <<<"$STDOUT" >/dev/null ||
  fail "an absent config must use the built-in \$25 ceiling: $STDOUT"
[ "$(jqs '.window_minutes')" = "60" ] || fail "expected the 60-minute guard window: $STDOUT"
ok "cc guard: both runaways listed, the claimed one resolved to its task, the orphan task_id null, built-in thresholds in force"

# The quiet session is under every line and must not appear at all.
[ "$(jqs ".sessions[] | select(.session_id==\"$QUIET\") | .session_id")" = "" ] ||
  fail "a session under every threshold must not be reported: $STDOUT"
ok "cc guard: a healthy session is not reported"

# `--quiet` is not a flag this command has (it is neither a mutation nor a
# show) — clap refuses it as an unknown argument, exit 2.
run 2 "$MESA" cc guard --quiet
[ -z "$STDOUT" ] || fail "cc guard --quiet must print nothing on stdout"
ok "cc guard rejects --quiet (exit 2, empty stdout)"

# ---- flag OFF: no alerts, ever --------------------------------------------

start_server
sleep 1
[ "$(inbox_count)" -eq 0 ] || fail "flag off: the guard must file nothing"
stop_server
ok "watch_cost off: no alerts"

# ---- flag ON: exactly one item per session per threshold -------------------

start_server --watch-cost
wait_inbox 1
sleep 1  # several more ticks: the fire-once set must hold
run 0 "$MESA" inbox list
[ "$(jqs 'length')" -eq 1 ] ||
  fail "expected exactly one alert, got $(jqs 'length'): $STDOUT"
[ "$(jqs '.[0].author')" = "cost-guard" ] ||
  fail "the alert must be authored by the cost guard: $STDOUT"
[ "$(jqs '.[0].kind')" = "task-summary" ] ||
  fail "alerts are task summaries (never auto-triaged): $STDOUT"
[ "$(jqs '.[0].task_id')" = "$TASK" ] ||
  fail "the alert must name the claimed task: $STDOUT"
ok "watch_cost on: one alert for the runaway, task-summary kind, filed against the claimed task"

# That one alert carries all three rules the session tripped — and nothing
# about the orphan, which filed nothing at all.
BODIES=$(jqs '.[0].body')
grep -q "Spin loop" <<<"$BODIES" || fail "no spin-loop alert: $BODIES"
grep -q "Cost:" <<<"$BODIES" || fail "no cost alert: $BODIES"
grep -q "Volume:" <<<"$BODIES" || fail "no volume alert: $BODIES"
grep -q "$RUNAWAY" <<<"$BODIES" || fail "an alert must name its session: $BODIES"
! grep -q "$ORPHAN" <<<"$BODIES" || fail "the unattributable session must file nothing: $BODIES"
! grep -q '|' <<<"$BODIES" || fail "alert bodies are spoken prose, never tables: $BODIES"
ok "alert bodies are prose naming the session and the rule; the unattributable session filed nothing"

# stderr said so once, rather than every tick.
WARNINGS=$(grep -c "names no mesa task" "$TMP/server.log" || true)
[ "$WARNINGS" -eq 1 ] ||
  fail "the unattributable session must warn exactly once, warned $WARNINGS times"
ok "an unattributable runaway warns once on stderr, not once a tick"

# ---- a second tick adds nothing -------------------------------------------

sleep 1
[ "$(inbox_count)" -eq 1 ] || fail "later ticks must not re-file: $(inbox_count) items"
stop_server
ok "the fire-once set holds across ticks"

# ---- the config section ----------------------------------------------------

start_server --watch-cost
# An absent config reads as all-null values beside the built-in defaults.
CFG=$(curl -sf "http://127.0.0.1:$PORT/api/config/guard")
[ "$(jq -r '.cost_usd' <<<"$CFG")" = "null" ] || fail "unset cost-usd must read null: $CFG"
jq -e '.cost_usd_default == 25' <<<"$CFG" >/dev/null || fail "built-in cost default: $CFG"
jq -e '.total_tokens_default == 100000000' <<<"$CFG" >/dev/null || fail "built-in token default: $CFG"
jq -e '.cache_read_share_default == 0.98' <<<"$CFG" >/dev/null || fail "built-in share default: $CFG"
jq -e '.cache_read_min_tokens_default == 20000000' <<<"$CFG" >/dev/null || fail "built-in floor default: $CFG"
ok "GET /api/config/guard: absent config = null values beside the built-in defaults"

# ---- the other six sections survive this one's save ------------------------
#
# The whole point of read-modify-write-the-whole-document: write every other
# section first, then save `guard`, then read them all back.

curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"commands":{"todo-watcher":"mytool --bg -- /go {id}"}}' \
  "http://127.0.0.1:$PORT/api/config" >/dev/null || fail "seed commands"
curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"pricing":{"claude-fictional":{"input":1.5,"output":2.5,"cache_read":0.5,"cache_write":3.0}}}' \
  "http://127.0.0.1:$PORT/api/config/pricing" >/dev/null || fail "seed pricing"
curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"todo_concurrency":4}' \
  "http://127.0.0.1:$PORT/api/config/watchers" >/dev/null || fail "seed watchers"
curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"voice":"af_sky"}' \
  "http://127.0.0.1:$PORT/api/config/speech" >/dev/null || fail "seed speech"
curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"auto_send_ms":3500}' \
  "http://127.0.0.1:$PORT/api/config/live" >/dev/null || fail "seed live"
curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"model":"small"}' \
  "http://127.0.0.1:$PORT/api/config/listen" >/dev/null || fail "seed listen"

CFG=$(curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"cost_usd":9.5,"total_tokens":250,"cache_read_share":0.75,"cache_read_min_tokens":100}' \
  "http://127.0.0.1:$PORT/api/config/guard") || fail "PUT guard"
jq -e '.cost_usd == 9.5' <<<"$CFG" >/dev/null || fail "PUT echoed the wrong cost: $CFG"
jq -e '.cache_read_share == 0.75' <<<"$CFG" >/dev/null || fail "PUT echoed the wrong share: $CFG"

jq -e '.commands["todo-watcher"] == "mytool --bg -- /go {id}"' "$CONFIG" >/dev/null ||
  fail "the commands section did not survive: $(cat "$CONFIG")"
jq -e '.pricing["claude-fictional"].input == 1.5' "$CONFIG" >/dev/null ||
  fail "the pricing section did not survive: $(cat "$CONFIG")"
jq -e '.watchers["todo-concurrency"] == 4' "$CONFIG" >/dev/null ||
  fail "the watchers section did not survive: $(cat "$CONFIG")"
jq -e '.speech.voice == "af_sky"' "$CONFIG" >/dev/null ||
  fail "the speech section did not survive: $(cat "$CONFIG")"
jq -e '.live["auto-send-ms"] == 3500' "$CONFIG" >/dev/null ||
  fail "the live section did not survive: $(cat "$CONFIG")"
jq -e '.listen.model == "small"' "$CONFIG" >/dev/null ||
  fail "the listen section did not survive: $(cat "$CONFIG")"
jq -e '.guard["cost-usd"] == 9.5 and .guard["total-tokens"] == 250' "$CONFIG" >/dev/null ||
  fail "the guard section is not on disk in kebab-case: $(cat "$CONFIG")"
ok "saving the guard section preserves commands, pricing, watchers, speech, live and listen"

# ---- a bad value is validation and writes NOTHING --------------------------

BEFORE=$(cat "$CONFIG")
for BAD in '{"cost_usd":0}' '{"cost_usd":-3}' '{"cost_usd":"lots"}' \
           '{"total_tokens":0}' '{"total_tokens":2.5}' \
           '{"cache_read_share":1.5}' '{"cache_read_share":0.1}' \
           '{"cache_read_min_tokens":0}'; do
  CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X PUT \
    -H 'Content-Type: application/json' -d "$BAD" \
    "http://127.0.0.1:$PORT/api/config/guard")
  [ "$CODE" = "422" ] || fail "expected 422 for $BAD, got $CODE: $(cat "$TMP/body")"
  [ "$(jq -r '.error.code' "$TMP/body")" = "validation" ] ||
    fail "expected error.code=validation for $BAD: $(cat "$TMP/body")"
done
[ "$BEFORE" = "$(cat "$CONFIG")" ] ||
  fail "a rejected save must leave the file byte-identical"
ok "every bad guard value is 422 validation and writes nothing"

# A key this route does not know is simply not a guard setting — the typed
# body ignores it and nothing is written, exactly as the sibling config routes
# behave. (An unknown key that reaches the *save* layer is `validation`; that
# rule is a Rust unit test, since no route can express it.)
curl -sf -X PUT -H 'Content-Type: application/json' -d '{"nonsense":1}' \
  "http://127.0.0.1:$PORT/api/config/guard" >/dev/null || fail "PUT with an unknown key"
[ "$BEFORE" = "$(cat "$CONFIG")" ] ||
  fail "an unknown body key must write nothing"
ok "an unknown body key is ignored and writes nothing"

# A configured threshold is what the guard then uses — and it is read fresh,
# with no restart: `cost-usd` was 9.5 above, so the quiet session (cents) is
# still under it. Lower the ceiling under it and it breaches.
curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"cost_usd":0.001,"total_tokens":1,"cache_read_share":1.0,"cache_read_min_tokens":1000000000}' \
  "http://127.0.0.1:$PORT/api/config/guard" >/dev/null || fail "PUT low thresholds"
run 0 "$MESA" cc guard
jq -e '.thresholds.cost_usd == 0.001' <<<"$STDOUT" >/dev/null || fail "cc guard did not read the config: $STDOUT"
[ "$(jqs ".sessions[] | select(.session_id==\"$QUIET\") | .breaches | length")" != "" ] ||
  fail "a lowered ceiling must catch the previously-quiet session: $STDOUT"
# The spin floor is now a billion tokens, so nothing can trip `spin`.
[ "$(jqs '[.sessions[].breaches[] | select(.threshold=="spin")] | length')" -eq 0 ] ||
  fail "an unreachable spin floor must silence the spin rule: $STDOUT"
ok "configured thresholds are read fresh and actually govern the verdict"

# `null` puts a key back to the built-in.
CFG=$(curl -sf -X PUT -H 'Content-Type: application/json' \
  -d '{"cost_usd":null,"total_tokens":null,"cache_read_share":null,"cache_read_min_tokens":null}' \
  "http://127.0.0.1:$PORT/api/config/guard") || fail "PUT nulls"
[ "$(jq -r '.cost_usd' <<<"$CFG")" = "null" ] || fail "null must clear the key: $CFG"
jq -e '.guard | length == 0' "$CONFIG" >/dev/null ||
  fail "cleared keys must leave the section empty: $(cat "$CONFIG")"
run 0 "$MESA" cc guard
jq -e '.thresholds.cost_usd == 25' <<<"$STDOUT" >/dev/null || fail "cleared keys must restore the built-in: $STDOUT"
ok "null restores the built-in threshold"

stop_server
echo "cost-guard-check: $CHECKS checks passed"
