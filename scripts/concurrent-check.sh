#!/usr/bin/env bash
# Milestone 8 gate (spec Acceptance 9): with `mesa serve` running, fire 20
# interleaved writes — 10 CLI updates and 10 API PATCHes — against the same
# task set. Assert every CLI write exits 0, every API write returns 2xx, and
# the final state is consistent from both surfaces. Uses a throwaway MESA_DB.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa
PORT=7791
BASE="http://127.0.0.1:$PORT"

TMP=$(mktemp -d)
SERVER_PID=""
# Note: `wait "$SERVER_PID"` here can hang inside an EXIT trap (bash quirk),
# so poll with `kill -0` instead.
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
export MESA_DB="$TMP/mesa.db"

fail() { echo "FAIL: $*" >&2; exit 1; }

# ---- seed: one project, five tasks ----
P=$("$MESA" project create "Concurrency" --no-git | jq .id)
TASKS=()
for i in 1 2 3 4 5; do
  TASKS+=("$("$MESA" task create --project "$P" --title "task $i" | jq .id)")
done

# ---- start the server ----
"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/projects" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server died: $(cat "$TMP/serve.log")"
  sleep 0.1
done
curl -sf "$BASE/api/projects" >/dev/null || fail "server never became ready"

# ---- 20 interleaved writes: CLI and API racing on the same tasks ----
WRITERS=()
for i in $(seq 0 9); do
  T=${TASKS[$((i % 5))]}
  (
    "$MESA" task update "$T" --tags "cli-$i" \
      >"$TMP/cli-$i.out" 2>"$TMP/cli-$i.err"
    echo $? >"$TMP/cli-$i.code"
  ) &
  WRITERS+=($!)
  (
    curl -s -o "$TMP/api-$i.out" -w '%{http_code}' -X PATCH \
      -H 'Content-Type: application/json' \
      -d '{"status":"in_progress"}' \
      "$BASE/api/tasks/$T" >"$TMP/api-$i.code" || echo 000 >"$TMP/api-$i.code"
  ) &
  WRITERS+=($!)
done
wait "${WRITERS[@]}"

for i in $(seq 0 9); do
  code=$(cat "$TMP/cli-$i.code")
  [ "$code" = "0" ] ||
    fail "CLI write $i exited $code (stderr: $(cat "$TMP/cli-$i.err"))"
  status=$(cat "$TMP/api-$i.code")
  case "$status" in
    2*) ;;
    *) fail "API PATCH $i returned $status (body: $(cat "$TMP/api-$i.out"))" ;;
  esac
done
echo "ok: 20/20 interleaved writes succeeded (10 CLI exit 0, 10 API 2xx)"

# ---- every task shows evidence of the writes ----
for T in "${TASKS[@]}"; do
  ROW=$("$MESA" task show "$T")
  touched=$(jq -r '(.status == "in_progress") or (.tags | length > 0)' <<<"$ROW")
  [ "$touched" = "true" ] || fail "task $T untouched after writes: $ROW"
done
echo "ok: all 5 tasks reflect the writes"

# ---- final state consistent from both surfaces ----
CLI_VIEW=$("$MESA" task list --project "$P" | jq -S 'sort_by(.id)')
API_VIEW=$(curl -s "$BASE/api/tasks?project=$P" | jq -S 'sort_by(.id)')
[ "$CLI_VIEW" = "$API_VIEW" ] ||
  fail "surfaces disagree:
CLI: $CLI_VIEW
API: $API_VIEW"
echo "ok: CLI and API report identical final state"

echo "concurrent-check passed"
