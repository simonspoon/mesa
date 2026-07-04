#!/usr/bin/env bash
# Hooks gate: exercises the task-execute hook contract end to end — CLI
# (`mesa task execute`) and API (POST /api/tasks/{id}/execute) — against a
# throwaway db and hooks file (MESA_DB / MESA_HOOKS_FILE), including the
# unconfigured, hook-failure, and access-gate shapes.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
export MESA_HOOKS_FILE="$TMP/hooks.json"

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

# ---- fixtures: a project anchored to a folder, with one task ----

WORKDIR="$TMP/workdir"
mkdir -p "$WORKDIR"
run 0 "$MESA" project create "Hooked" --no-git
P=$(jqs .id)
run 0 "$MESA" project update "$P" --path "$WORKDIR"
ANCHOR=$(jqs .local_path)
run 0 "$MESA" task create --project "$P" --title "Wire the hooks"
T=$(jqs .id)

# ---- CLI: unconfigured, then a full run ----

run 1 "$MESA" task execute "$T"
[ "$(jqe .error.code)" = "validation" ] || fail "unconfigured: validation error"
grep -q "task-execute" <<<"$STDERR" || fail "unconfigured: message names the hook"
ok "execute without a configured hook: exit 1 validation"

echo 'not json' > "$MESA_HOOKS_FILE"
run 1 "$MESA" task execute "$T"
[ "$(jqe .error.code)" = "validation" ] || fail "malformed config: validation error"
ok "execute with a malformed hooks file: exit 1 validation"

# The hook proves every contract leg at once: cwd = local_path, env vars set,
# task JSON on stdin, stdout/stderr captured, nonzero exit reported as data.
cat > "$MESA_HOOKS_FILE" <<'EOF'
{"task-execute": "pwd; echo \"id=$MESA_TASK_ID project=$MESA_PROJECT_ID hook=$MESA_HOOK title=$MESA_TASK_TITLE\"; cat; echo boom >&2; exit 3"}
EOF

run 0 "$MESA" task execute "$T"
[ "$(jqs .hook)" = "task-execute" ] || fail "CLI: hook name echoed"
[ "$(jqs .exit_code)" = "3" ] || fail "CLI: hook exit code is data (got $(jqs .exit_code))"
[ "$(jqs .stderr)" = "boom" ] || fail "CLI: stderr captured"
STDOUT_FIELD=$(jqs .stdout)
head -1 <<<"$STDOUT_FIELD" | grep -qx "$ANCHOR" || fail "CLI: hook ran in local_path (got $(head -1 <<<"$STDOUT_FIELD"))"
grep -q "id=$T project=$P hook=task-execute title=Wire the hooks" <<<"$STDOUT_FIELD" ||
  fail "CLI: env vars delivered"
grep -q "\"title\":\"Wire the hooks\"" <<<"$STDOUT_FIELD" || fail "CLI: task JSON on stdin"
ok "CLI execute: cwd/env/stdin/output/exit contract"

run 1 "$MESA" task execute 99999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI: unknown task not_found"
ok "CLI execute on unknown task: not_found"

# ---- API: same contract over POST /api/tasks/{id}/execute ----

PORT=17773
"$MESA" serve --port "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null || fail "server did not start"

api() { # api <expected-status> <method> <path> [json-body]
  local expected=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  STATUS=$(curl "${args[@]}" "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
jqb() { jq -r "$1" <<<"$BODY"; }

api 200 POST "/api/tasks/$T/execute" '{}'
[ "$(jqb .exit_code)" = "3" ] || fail "API: hook exit code is data"
[ "$(jqb .stderr)" = "boom" ] || fail "API: stderr captured"
grep -q "id=$T" <<<"$(jqb .stdout)" || fail "API: env vars delivered"
ok "POST /api/tasks/{id}/execute runs the hook and returns the outcome"

api 404 POST "/api/tasks/99999/execute" '{}'
[ "$(jqb .error.code)" = "not_found" ] || fail "API: unknown task not_found"
ok "API execute on unknown task: 404 not_found"

# Code execution shares the agents' cross-site defense: a foreign browser
# Origin is refused; the local UI page passes.
origin_status() { # origin_status <origin>
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $1" \
    -H 'Content-Type: application/json' -d '{}' \
    "http://127.0.0.1:$PORT/api/tasks/$T/execute"
}
[ "$(origin_status 'https://evil.example')" = "403" ] ||
  fail "API: foreign Origin must be 403"
[ "$(origin_status "http://localhost:$PORT")" = "200" ] ||
  fail "API: local Origin must pass"
ok "execute rejects a foreign Origin (agents access gate), allows local"

rm "$MESA_HOOKS_FILE"
api 422 POST "/api/tasks/$T/execute" '{}'
[ "$(jqb .error.code)" = "validation" ] || fail "API unconfigured: validation"
ok "API execute without a configured hook: 422 validation"

echo "ALL OK ($CHECKS checks)"
