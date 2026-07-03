#!/usr/bin/env bash
# Agents-surface gate: exercises the project local_path plumbing (CLI create/
# update/resolve) and the /api/projects/{id}/agents contract against a stub
# `claude` binary (MESA_CLAUDE_BIN), so no real Claude Code is involved.
# The attach WebSocket is not covered here (no ws client in bash); it is
# exercised by live QA against the real claude CLI.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa
MESA_ABS="$(pwd)/$MESA"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; for p in "${SERVER_PID:-}" "${LAN_PID:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; true' EXIT
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
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- CLI: local_path learned on create, settable, cleared, self-healed ----

REPO="$TMP/repo"
mkdir -p "$REPO/sub"
git -C "$REPO" init -q
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
TOPLEVEL=$(git -C "$REPO" rev-parse --show-toplevel)

run 0 bash -c "cd '$REPO/sub' && '$MESA_ABS' project create 'Repo proj'"
P=$(jqs .id)
[ "$(jqs .local_path)" = "$TOPLEVEL" ] ||
  fail "create: local_path must auto-bind the repo toplevel (got $(jqs .local_path))"
ok "create auto-binds local_path to the repo toplevel (not the subdir)"

run 0 "$MESA" project create "Detached" --no-git
[ "$(jqs .local_path)" = "null" ] || fail "create --no-git: local_path must stay null"
D=$(jqs .id)
ok "create --no-git binds no local_path"

run 0 "$MESA" project update "$D" --path "$REPO"
[ "$(jqs .local_path)" = "$TOPLEVEL" ] || fail "update --path: canonicalized dir stored"
run 0 "$MESA" project update "$D" --path ""
[ "$(jqs .local_path)" = "null" ] || fail "update --path \"\": cleared"
run 1 "$MESA" project update "$D" --path "$TMP/nope"
[ "$(jqe .error.code)" = "validation" ] || fail "update --path missing dir: validation"
ok "update --path sets (canonical), clears (\"\"), rejects missing dirs"

# resolve re-learns the folder: clear it, then resolve from inside the repo.
run 0 "$MESA" project update "$P" --path ""
run 0 "$MESA" project resolve "$REPO/sub"
[ "$(jqs .id)" = "$P" ] || fail "resolve: maps back to the project"
[ "$(jqs .local_path)" = "$TOPLEVEL" ] || fail "resolve: local_path re-learned"
run 0 "$MESA" project show "$P"
[ "$(jqs .local_path)" = "$TOPLEVEL" ] || fail "resolve: re-learned path persisted"
ok "resolve self-heals local_path when unset"

# Worktrees of one repo share a root_commit -> resolve to the SAME project, but
# each has its own toplevel. resolve must NOT overwrite an existing, still-valid
# local_path with the worktree's path (that would thrash the Agents anchor).
git -C "$REPO" worktree add -q "$TMP/wt" -b wtbranch 2>/dev/null
run 0 "$MESA" project resolve "$TMP/wt"
[ "$(jqs .id)" = "$P" ] || fail "worktree resolves to the same project"
[ "$(jqs .local_path)" = "$TOPLEVEL" ] ||
  fail "worktree resolve must NOT thrash local_path (got $(jqs .local_path))"
ok "resolve keeps a still-valid local_path across worktrees (no thrash)"

# ...but a stale (deleted) local_path DOES re-anchor to the live checkout.
GONE="$TMP/moved"; mkdir -p "$GONE"
run 0 "$MESA" project update "$P" --path "$GONE"
rmdir "$GONE"
run 0 "$MESA" project resolve "$REPO/sub"
[ "$(jqs .local_path)" = "$TOPLEVEL" ] || fail "stale local_path must re-anchor"
ok "resolve re-anchors a stale (deleted) local_path to the live checkout"

# ---- API: /api/projects/{id}/agents against a stub claude ----

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/claude" <<EOF
#!/usr/bin/env bash
[ -e "$STUB_DIR/fail" ] && { echo "stub claude is down" >&2; exit 1; }
case "\$1" in
  agents)
    # invoked as: agents --json --cwd <dir>
    printf '[{"pid":123,"id":"abc12345","cwd":"%s","kind":"background","startedAt":1783000000000,"sessionId":"abc12345-0000-0000-0000-000000000000","name":"stub agent","status":"idle","state":"blocked","waitingFor":"permission prompt"}]\n' "\$4"
    ;;
  --bg)
    echo "Starting background service…"
    echo "backgrounded · deadbeef (idle — send a prompt to start)"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$STUB_DIR/claude"

PORT=17771
MESA_CLAUDE_BIN="$STUB_DIR/claude" "$MESA" serve --port "$PORT" >/dev/null 2>&1 &
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

api 200 GET "/api/projects/$P/agents"
[ "$(jqb .path)" = "$TOPLEVEL" ] || fail "GET agents: path is the project folder"
[ "$(jqb '.agents | length')" = "1" ] || fail "GET agents: one stub session"
[ "$(jqb '.agents[0].id')" = "abc12345" ] || fail "GET agents: short id"
[ "$(jqb '.agents[0].cwd')" = "$TOPLEVEL" ] || fail "GET agents: stub got --cwd $TOPLEVEL"
[ "$(jqb '.agents[0].waitingFor')" = "permission prompt" ] || fail "GET agents: camelCase passthrough"
ok "GET /api/projects/{id}/agents lists sessions under local_path"

api 200 GET "/api/projects/$D/agents"
[ "$(jqb .path)" = "null" ] || fail "GET agents (no path): path null"
[ "$(jqb '.agents | length')" = "0" ] || fail "GET agents (no path): empty list"
ok "GET agents on a path-less project: {path: null, agents: []}"

api 201 POST "/api/projects/$P/agents" '{}'
[ "$(jqb .id)" = "deadbeef" ] || fail "POST agents: parsed job id"
api 201 POST "/api/projects/$P/agents" '{"prompt":"do the thing"}'
[ "$(jqb .id)" = "deadbeef" ] || fail "POST agents with prompt: parsed job id"
ok "POST /api/projects/{id}/agents starts a --bg session (with/without prompt)"

api 422 POST "/api/projects/$D/agents" '{}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST agents (no path): validation"
ok "POST agents on a path-less project: 422 validation"

api 404 GET "/api/projects/99999/agents"
[ "$(jqb .error.code)" = "not_found" ] || fail "GET agents unknown project: not_found"
ok "GET agents on unknown project: 404 not_found"

# Cross-site defense: list/spawn reject a foreign browser Origin (like the
# attach socket), while an Origin-less client (curl default) passes.
origin_status() { # origin_status <method> <path> <origin> [body]
  local method=$1 path=$2 origin=$3 body=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" -H "Origin: $origin")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "http://127.0.0.1:$PORT$path"
}
[ "$(origin_status GET "/api/projects/$P/agents" 'https://evil.example')" = "403" ] ||
  fail "GET agents foreign Origin: must be 403"
[ "$(origin_status POST "/api/projects/$P/agents" 'https://evil.example' '{}')" = "403" ] ||
  fail "POST agents foreign Origin: must be 403"
[ "$(origin_status GET "/api/projects/$P/agents" 'http://localhost:7770')" = "200" ] ||
  fail "GET agents local Origin: must pass"
ok "list/spawn reject foreign Origin (cross-site defense), allow local"

# A dead claude CLI is an upstream failure: 502 unavailable. Use a fresh
# project/folder so the 2s in-memory list cache can't serve this request.
FRESH="$TMP/fresh"
mkdir -p "$FRESH"
touch "$STUB_DIR/fail"
api 201 POST "/api/projects" "{\"name\":\"Fresh\",\"local_path\":\"$FRESH\"}"
F=$(jqb .id)
[ "$(jqb .local_path)" = "$FRESH" ] || fail "API create: local_path stored"
api 502 GET "/api/projects/$F/agents"
[ "$(jqb .error.code)" = "unavailable" ] || fail "claude down: unavailable"
api 502 POST "/api/projects/$F/agents" '{}'
[ "$(jqb .error.code)" = "unavailable" ] || fail "claude down on spawn: unavailable"
rm "$STUB_DIR/fail"
ok "claude CLI failure surfaces as 502 unavailable (list + spawn)"

api 200 PATCH "/api/projects/$F" '{"local_path":null}'
[ "$(jqb .local_path)" = "null" ] || fail "API PATCH: local_path cleared"
ok "PATCH /api/projects/{id} clears local_path"

# ---- attach WebSocket handshake (Origin policy + id validation) ----
# A real ws client is out of scope for bash; the HTTP status of the upgrade
# request is enough to pin the policy: 101 for local pages, 403 for foreign
# Origins (cross-site WebSocket hijacking), 422 for bad ids.
ws() { # ws <path> [origin] -> HTTP status of the upgrade attempt
  local path=$1 origin=${2:-}
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 3
    -H 'Connection: Upgrade' -H 'Upgrade: websocket'
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
  [ -n "$origin" ] && args+=(-H "Origin: $origin")
  curl "${args[@]}" "http://127.0.0.1:$PORT$path"
}

[ "$(ws /api/agents/deadbeef/attach 'http://localhost:7770')" = "101" ] ||
  fail "WS attach: local Origin must upgrade (101)"
[ "$(ws /api/agents/deadbeef/attach 'http://localhost:5173')" = "101" ] ||
  fail "WS attach: vite dev Origin must upgrade (101)"
[ "$(ws /api/agents/deadbeef/attach)" = "101" ] ||
  fail "WS attach: no Origin (non-browser client) must upgrade (101)"
[ "$(ws /api/agents/deadbeef/attach 'https://evil.example')" = "403" ] ||
  fail "WS attach: foreign Origin must be refused (403)"
[ "$(ws /api/agents/deadbeef/attach 'http://localhost.evil.example')" = "403" ] ||
  fail "WS attach: prefix-spoofed Origin must be refused (403)"
[ "$(ws '/api/agents/bad%20id!/attach' 'http://localhost:7770')" = "422" ] ||
  fail "WS attach: invalid id must be refused (422)"
[ "$(ws '/api/agents/-rf/attach' 'http://localhost:7770')" = "422" ] ||
  fail "WS attach: leading-dash id must be refused (422)"
ok "WS attach handshake: local/absent Origin upgrade, foreign Origin 403, bad/dash id 422"

# ---- --lan: agent routes keep a Host allowlist the rest of the API drops ----
# Under --lan the global Host check is skipped (a normal route accepts any
# Host), but the agent routes must STILL demand a local Host — else a
# DNS-rebinding page (Host = its rebound hostname) reaches them.
LAN_PORT=17772
MESA_CLAUDE_BIN="$STUB_DIR/claude" "$MESA" serve --lan --port "$LAN_PORT" >/dev/null 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf -H "Host: 127.0.0.1:$LAN_PORT" "http://127.0.0.1:$LAN_PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
lan_status() { # lan_status <path> <host>
  curl -s -o /dev/null -w '%{http_code}' -H "Host: $2" "http://127.0.0.1:$LAN_PORT$1"
}
[ "$(lan_status "/api/projects" 'evil.example')" = "200" ] ||
  fail "--lan: normal route must accept any Host (global check skipped)"
[ "$(lan_status "/api/projects/$P/agents" 'evil.example')" = "403" ] ||
  fail "--lan: agent route must reject a foreign Host (rebinding defense)"
[ "$(lan_status "/api/projects/$P/agents" "127.0.0.1:$LAN_PORT")" = "200" ] ||
  fail "--lan: agent route must accept a local Host"
kill "$LAN_PID" 2>/dev/null; LAN_PID=""
ok "--lan: agent routes keep a Host allowlist even though the rest of the API drops it"

echo "ALL OK ($CHECKS checks)"
