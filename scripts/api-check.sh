#!/usr/bin/env bash
# API gate: exercises the HTTP task surface end to end against a live
# `mesa serve` on a throwaway MESA_DB — the API-side counterpart to
# `scripts/cli-check.sh`, which is CLI-only and never speaks HTTP.
#
# Covers, in order:
#   1. the security boundary in default mode — the Host-header allowlist and
#      the Content-Type gate (`guard` in src/api.rs), including the
#      `application/json; charset=utf-8` parameter case and the GET carve-out;
#   2. the task routes' JSON contract and status codes — create/list/show/
#      update/delete, the TaskSummary-vs-Task shape split, derived `blocked`,
#      block/unblock/dependencies/dependents and the cycle rejection;
#   3. the claim routes added by task 563 — POST /api/tasks/{id}/claim and
#      /release: 200 shapes, renewal, the 409 on a rival owner, --force, the
#      status-leaves-in_progress clear, and the `claimed_at` asymmetry that
#      makes the pair useful (it must NOT move on an ordinary field write);
#   4. archived-project scoping over HTTP (unscoped hides, scoped does not);
#   5. LAN mode — the Host allowlist is skipped while the Content-Type gate
#      still applies, the two halves of one posture (CLAUDE.md).
#
# Attachment routes have their own gate (scripts/attachments-check.sh); the
# agents/terminal/hook routes have theirs (agents-check.sh, hooks-check.sh).
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP";
      [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null;
      [ -n "${LAN_PID:-}" ] && kill "$LAN_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

# ---- fixtures ----
#
# Built with the CLI (which opens the same db directly) so the API section
# starts from known ids. `--no-git` is deliberate: a scripted fixture repo
# would produce a root commit that collides with other gates' fixtures under
# the DB-unique root_commit binding (see scripts/cli-check.sh).

PROJ=$("$MESA" project create "API gate project" --no-git | jq -r .id)
OTHER=$("$MESA" project create "API gate archived project" --no-git | jq -r .id)

# ---- server ----

PORT=17775
BASE="http://127.0.0.1:$PORT"
"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/projects" >/dev/null ||
  fail "server did not start (log: $(cat "$TMP/serve.log"))"

# raw <method> <path> [curl args...] — no implied headers, for the gate checks.
# Sets STATUS and BODY.
raw() {
  local method=$1 path=$2
  shift 2
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "$@" "$BASE$path")
  BODY=$(cat "$TMP/body")
}

# api <expected-status> <method> <path> [json-body] — the well-formed client:
# JSON Content-Type on every mutating method.
api() {
  local expected=$1 method=$2 path=$3 body=${4:-}
  # Seeded non-empty: `"${args[@]}"` on an empty array is an unbound-variable
  # error under `set -u` in macOS's bash 3.2.
  local args=(-H 'Accept: application/json')
  case "$method" in
    POST | PUT | PATCH | DELETE)
      args+=(-H 'Content-Type: application/json' -d "${body:-{\}}")
      ;;
  esac
  raw "$method" "$path" "${args[@]}"
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}

jqb() { jq -r "$1" <<<"$BODY"; }

# =====================================================================
# 1. Security boundary (default mode)
# =====================================================================

# ---- Host-header allowlist (DNS-rebinding defense) ----

raw GET "/api/projects" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "bogus Host: expected 403, got $STATUS ($BODY)"
[ "$(jqb .error.code)" = "validation" ] || fail "bogus Host: error.code"
ok "Host allowlist: a foreign Host is 403 validation, even on a GET"

# A mutating request with a bogus Host must die on the Host check, not reach
# the handler — assert with an otherwise-valid create.
raw POST "/api/tasks" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d "{\"project_id\":$PROJ,\"title\":\"must not exist\"}"
[ "$STATUS" = "403" ] || fail "bogus Host on POST: expected 403, got $STATUS ($BODY)"
ok "Host allowlist: rejects a well-formed mutating request before the handler"

# Both allowlisted spellings pass. `localhost:PORT` is only reachable by
# setting the header explicitly, since curl is dialing 127.0.0.1.
raw GET "/api/projects" -H "Host: localhost:$PORT"
[ "$STATUS" = "200" ] || fail "Host localhost:$PORT: expected 200, got $STATUS"
ok "Host allowlist: localhost:<port> is accepted"

raw GET "/api/projects" -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "200" ] || fail "Host 127.0.0.1:$PORT: expected 200, got $STATUS"
ok "Host allowlist: 127.0.0.1:<port> is accepted"

# The port is part of the allowlisted value — a right-host/wrong-port Host is
# still rejected, which is what makes the check a rebinding defense rather
# than a hostname spellcheck.
raw GET "/api/projects" -H "Host: localhost:1"
[ "$STATUS" = "403" ] || fail "Host with wrong port: expected 403, got $STATUS"
ok "Host allowlist: an allowlisted hostname on the wrong port is 403"

# ---- Content-Type gate (cross-site form posts) ----

# No Content-Type at all.
raw POST "/api/tasks/1/release"
[ "$STATUS" = "415" ] || fail "POST without Content-Type: expected 415, got $STATUS"
[ "$(jqb .error.code)" = "validation" ] || fail "no Content-Type: error.code"
ok "Content-Type gate: a mutating request with no Content-Type is 415 validation"

# curl's default for -d is application/x-www-form-urlencoded: the exact
# cross-site form post the gate exists to reject.
raw POST "/api/tasks" -d "project_id=$PROJ&title=form+post"
[ "$STATUS" = "415" ] || fail "form-encoded POST: expected 415, got $STATUS"
ok "Content-Type gate: a form-encoded POST is 415 (the CSRF shape)"

raw POST "/api/tasks" -H 'Content-Type: text/plain' \
  -d "{\"project_id\":$PROJ,\"title\":\"text/plain\"}"
[ "$STATUS" = "415" ] || fail "text/plain POST: expected 415, got $STATUS"
ok "Content-Type gate: text/plain is 415"

# The gate compares the media type only, so a charset parameter is accepted —
# browsers and fetch() both send one.
raw POST "/api/tasks" -H 'Content-Type: application/json; charset=utf-8' \
  -d "{\"project_id\":$PROJ,\"title\":\"charset param\"}"
[ "$STATUS" = "201" ] || fail "application/json; charset=utf-8: expected 201, got $STATUS ($BODY)"
CHARSET_TASK=$(jqb .id)
ok "Content-Type gate: application/json; charset=utf-8 is accepted (param ignored)"

# Case-insensitive media type.
raw POST "/api/tasks" -H 'Content-Type: APPLICATION/JSON' \
  -d "{\"project_id\":$PROJ,\"title\":\"uppercase ct\"}"
[ "$STATUS" = "201" ] || fail "APPLICATION/JSON: expected 201, got $STATUS ($BODY)"
UPPER_TASK=$(jqb .id)
ok "Content-Type gate: the media type is matched case-insensitively"

# GETs carry no body and are exempt.
raw GET "/api/tasks"
[ "$STATUS" = "200" ] || fail "GET without Content-Type: expected 200, got $STATUS"
ok "Content-Type gate: GET is exempt"

# Every mutating verb is gated, not just POST.
for m in PATCH DELETE; do
  raw "$m" "/api/tasks/$CHARSET_TASK" -d 'x=1'
  [ "$STATUS" = "415" ] || fail "$m without JSON Content-Type: expected 415, got $STATUS"
done
ok "Content-Type gate: PATCH and DELETE are gated too"

# Clean up the two gate-probe tasks.
api 200 DELETE "/api/tasks/$CHARSET_TASK"
api 200 DELETE "/api/tasks/$UPPER_TASK"

# =====================================================================
# 2. Task routes: JSON contract + status codes
# =====================================================================

api 201 POST "/api/tasks" \
  "{\"project_id\":$PROJ,\"title\":\"Root task\",\"description\":\"body text\",\"priority\":\"high\",\"tags\":[\"api\"]}"
T1=$(jqb .id)
[ "$(jqb .project_id)" = "$PROJ" ] || fail "POST /api/tasks: project_id"
[ "$(jqb .title)" = "Root task" ] || fail "POST /api/tasks: title"
[ "$(jqb .description)" = "body text" ] || fail "POST /api/tasks: description"
[ "$(jqb .status)" = "backlog" ] || fail "POST /api/tasks: default status is backlog, not todo"
[ "$(jqb .priority)" = "high" ] || fail "POST /api/tasks: priority"
[ "$(jqb '.tags | join(",")')" = "api" ] || fail "POST /api/tasks: tags"
[ "$(jqb .blocked)" = "false" ] || fail "POST /api/tasks: blocked derived false"
[ "$(jqb .owner)" = "null" ] || fail "POST /api/tasks: owner starts null"
[ "$(jqb .claimed_at)" = "null" ] || fail "POST /api/tasks: claimed_at starts null"
ok "POST /api/tasks: 201 + full Task JSON"

# A missing required field is a contract-shaped 422, not axum's plain-text 400.
api 422 POST "/api/tasks" "{\"project_id\":$PROJ}"
[ "$(jqb .error.code)" = "validation" ] || fail "POST missing title: error.code"
ok "POST /api/tasks missing a required field: 422 validation in the error shape"

api 422 POST "/api/tasks" "not json at all"
[ "$(jqb .error.code)" = "validation" ] || fail "POST malformed body: error.code"
ok "POST /api/tasks with a malformed body: 422 validation, not a plain-text 400"

# Note the asymmetry, pinned deliberately: an unknown *project* on create is
# `Error::Validation` (422) in `Store::create_task`, while an unknown *task* on
# show/update/delete/claim is `not_found` (404). Both shapes are load-bearing
# for callers; this asserts the one that actually ships.
api 422 POST "/api/tasks" '{"project_id":999999,"title":"orphan"}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST unknown project: error.code"
ok "POST /api/tasks unknown project: 422 validation (not 404 — see Store::create_task)"

# ---- show ----
api 200 GET "/api/tasks/$T1"
[ "$(jqb .id)" = "$T1" ] || fail "GET /api/tasks/{id}: id"
[ "$(jqb .description)" = "body text" ] || fail "GET /api/tasks/{id}: carries description"
ok "GET /api/tasks/{id}: full Task JSON including description"

api 404 GET "/api/tasks/999999"
[ "$(jqb .error.code)" = "not_found" ] || fail "GET unknown task: error.code"
ok "GET /api/tasks/{id} unknown id: 404 not_found"

# ---- list ---- (TaskSummary, not Task: no description)
api 200 GET "/api/tasks?project=$PROJ"
[ "$(jqb type)" = "array" ] || fail "GET /api/tasks: bare array"
[ "$(jqb 'map(select(.id == '"$T1"')) | length')" = "1" ] || fail "GET /api/tasks: contains T1"
[ "$(jqb 'map(has("description")) | any')" = "false" ] ||
  fail "GET /api/tasks: summaries must not carry description"
[ "$(jqb 'map(has("owner") and has("claimed_at") and has("blocked")) | all')" = "true" ] ||
  fail "GET /api/tasks: summaries must carry owner/claimed_at/blocked"
ok "GET /api/tasks: bare array of TaskSummary (no description; owner/claimed_at/blocked present)"

# ---- update ----
api 200 PATCH "/api/tasks/$T1" '{"title":"Root task renamed","priority":"low"}'
[ "$(jqb .title)" = "Root task renamed" ] || fail "PATCH: title"
[ "$(jqb .priority)" = "low" ] || fail "PATCH: priority"
[ "$(jqb .description)" = "body text" ] || fail "PATCH: untouched fields survive"
ok "PATCH /api/tasks/{id}: 200 + full Task, partial update leaves other fields"

# `null` clears an optional long-text field; an absent key leaves it alone.
api 200 PATCH "/api/tasks/$T1" '{"description":null}'
[ "$(jqb .description)" = "null" ] || fail "PATCH description:null: must clear"
ok "PATCH /api/tasks/{id}: explicit null clears an optional field"

api 404 PATCH "/api/tasks/999999" '{"title":"nope"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "PATCH unknown task: error.code"
ok "PATCH /api/tasks/{id} unknown id: 404 not_found"

# A task's project is immutable after creation, and the API must not offer a
# side door around that Store invariant.
api 200 PATCH "/api/tasks/$T1" "{\"project_id\":$OTHER}"
[ "$(jqb .project_id)" = "$PROJ" ] || fail "PATCH project_id: must be ignored, not applied"
ok "PATCH /api/tasks/{id}: an unknown project_id key cannot move the task"

# ---- dependencies / derived blocked ----
api 201 POST "/api/tasks" "{\"project_id\":$PROJ,\"title\":\"Blocker\"}"
T2=$(jqb .id)

api 200 POST "/api/tasks/$T1/block" "{\"on\":$T2}"
[ "$(jqb .blocked)" = "true" ] || fail "block: blocked must derive true"
ok "POST /api/tasks/{id}/block: 200 + the task with blocked derived true"

api 200 GET "/api/tasks/$T1/dependencies"
[ "$(jqb 'map(.id) | join(",")')" = "$T2" ] || fail "dependencies: expected [$T2]"
ok "GET /api/tasks/{id}/dependencies: the blockers, as full tasks"

api 200 GET "/api/tasks/$T2/dependents"
[ "$(jqb 'map(.id) | join(",")')" = "$T1" ] || fail "dependents: expected [$T1]"
ok "GET /api/tasks/{id}/dependents: the reverse edge"

# `blocked` is derived on every read, never stored: finishing the blocker
# clears it with no write to the blocked task.
api 200 PATCH "/api/tasks/$T2" '{"status":"done"}'
api 200 GET "/api/tasks/$T1"
[ "$(jqb .blocked)" = "false" ] || fail "blocked must clear when the blocker is done"
ok "blocked is derived: a done blocker unblocks with no write to the blocked task"

api 200 PATCH "/api/tasks/$T2" '{"status":"todo"}'
api 200 GET "/api/tasks?project=$PROJ&unblocked=true"
[ "$(jqb 'map(select(.id == '"$T1"')) | length')" = "0" ] ||
  fail "?unblocked=true must exclude the blocked task"
ok "GET /api/tasks?unblocked=true: excludes tasks with an open blocker"

# self-edge and cycle are both 409 cycle
api 409 POST "/api/tasks/$T1/block" "{\"on\":$T1}"
[ "$(jqb .error.code)" = "cycle" ] || fail "self-edge: error.code"
ok "POST .../block on itself: 409 cycle"

api 409 POST "/api/tasks/$T2/block" "{\"on\":$T1}"
[ "$(jqb .error.code)" = "cycle" ] || fail "cycle: error.code"
ok "POST .../block forming a cycle: 409 cycle"

api 200 POST "/api/tasks/$T1/unblock" "{\"on\":$T2}"
[ "$(jqb .blocked)" = "false" ] || fail "unblock: blocked must derive false"
ok "POST /api/tasks/{id}/unblock: 200, edge removed"

api 404 POST "/api/tasks/$T1/unblock" "{\"on\":$T2}"
[ "$(jqb .error.code)" = "not_found" ] || fail "unblock a missing edge: error.code"
ok "POST .../unblock with no such edge: 404 not_found"

# =====================================================================
# 3. Claim routes (task 563)
# =====================================================================

api 200 POST "/api/tasks/$T1/claim" '{"owner":"session-aaa"}'
[ "$(jqb .status)" = "in_progress" ] || fail "claim: must move the task to in_progress"
[ "$(jqb .owner)" = "session-aaa" ] || fail "claim: owner"
[ "$(jqb .claimed_at)" != "null" ] || fail "claim: claimed_at set"
CLAIMED_AT=$(jqb .claimed_at)
ok "POST /api/tasks/{id}/claim: 200 + full Task, in_progress with owner + claimed_at"

# The claim rides on TaskSummary too, so one list call answers live-vs-abandoned.
api 200 GET "/api/tasks?project=$PROJ"
[ "$(jqb 'map(select(.id == '"$T1"')) | .[0].owner')" = "session-aaa" ] ||
  fail "list: TaskSummary must carry the owner"
[ "$(jqb 'map(select(.id == '"$T1"')) | .[0].claimed_at')" = "$CLAIMED_AT" ] ||
  fail "list: TaskSummary must carry claimed_at"
ok "GET /api/tasks: the claim is visible in the list payload, not only on show"

# A rival owner is a conflict — the only guard against two agents in one repo.
api 409 POST "/api/tasks/$T1/claim" '{"owner":"session-bbb"}'
[ "$(jqb .error.code)" = "conflict" ] || fail "rival claim: error.code"
grep -q "session-aaa" <<<"$BODY" || fail "rival claim: message must name the holder"
ok "POST .../claim by a rival owner: 409 conflict naming the current holder"

# The asymmetry the pair exists for: `updated_at` moves on any field write,
# `claimed_at` must move ONLY on claim/renew. Timestamps are second-grained
# SQLite `datetime('now')`, so a real sleep is required to tell them apart.
sleep 2
api 200 PATCH "/api/tasks/$T1" '{"title":"Root task touched"}'
[ "$(jqb .claimed_at)" = "$CLAIMED_AT" ] ||
  fail "an ordinary update must not restamp claimed_at (was $CLAIMED_AT, now $(jqb .claimed_at))"
[ "$(jqb .updated_at)" != "$CLAIMED_AT" ] ||
  fail "updated_at did not move — the claimed_at assert above is vacuous"
[ "$(jqb .owner)" = "session-aaa" ] || fail "an ordinary update must not drop the claim"
ok "PATCH on a claimed task: updated_at moves, claimed_at does not (the liveness asymmetry)"

# Re-claiming with the SAME owner is a renewal, not a conflict.
api 200 POST "/api/tasks/$T1/claim" '{"owner":"session-aaa"}'
[ "$(jqb .owner)" = "session-aaa" ] || fail "renew: owner unchanged"
[ "$(jqb .claimed_at)" != "$CLAIMED_AT" ] || fail "renew: claimed_at must move"
ok "POST .../claim by the same owner: 200 renewal, claimed_at moves"

# --force breaks a live claim.
api 200 POST "/api/tasks/$T1/claim" '{"owner":"session-bbb","force":true}'
[ "$(jqb .owner)" = "session-bbb" ] || fail "force: owner must be replaced"
ok "POST .../claim with force:true: 200, the rival claim is broken"

# An empty/whitespace owner is a validation error, not a null claim.
api 422 POST "/api/tasks/$T1/claim" '{"owner":"   "}'
[ "$(jqb .error.code)" = "validation" ] || fail "blank owner: error.code"
ok "POST .../claim with a blank owner: 422 validation"

api 422 POST "/api/tasks/$T1/claim" '{}'
[ "$(jqb .error.code)" = "validation" ] || fail "missing owner field: error.code"
ok "POST .../claim with no owner field: 422 validation"

api 404 POST "/api/tasks/999999/claim" '{"owner":"session-aaa"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "claim unknown task: error.code"
ok "POST .../claim on an unknown task: 404 not_found"

# ---- release ----
api 200 POST "/api/tasks/$T1/release"
[ "$(jqb .owner)" = "null" ] || fail "release: owner cleared"
[ "$(jqb .claimed_at)" = "null" ] || fail "release: claimed_at cleared"
[ "$(jqb .status)" = "in_progress" ] || fail "release: status must be left alone"
ok "POST /api/tasks/{id}/release: 200, claim cleared, status untouched"

# Unguarded and idempotent by design — it is the stale-claim breaker.
api 200 POST "/api/tasks/$T1/release"
[ "$(jqb .owner)" = "null" ] || fail "second release: still null"
ok "POST .../release twice: idempotent, no conflict"

api 404 POST "/api/tasks/999999/release"
[ "$(jqb .error.code)" = "not_found" ] || fail "release unknown task: error.code"
ok "POST .../release on an unknown task: 404 not_found"

# An in_progress task with a null owner is not a live hold, so it is claimable
# without --force (a plain status flip, or a pre-claims row).
api 200 POST "/api/tasks/$T1/claim" '{"owner":"session-ccc"}'
[ "$(jqb .owner)" = "session-ccc" ] || fail "claim over a null owner: owner"
ok "POST .../claim on an in_progress task with a null owner: 200 without force"

# Leaving in_progress clears the claim, so no done/cancelled row stays owned.
api 200 PATCH "/api/tasks/$T1" '{"status":"done"}'
[ "$(jqb .owner)" = "null" ] || fail "status leaving in_progress must clear owner"
[ "$(jqb .claimed_at)" = "null" ] || fail "status leaving in_progress must clear claimed_at"
ok "PATCH status out of in_progress: the claim is cleared"

# =====================================================================
# 4. Archived-project scoping over HTTP
# =====================================================================

api 201 POST "/api/tasks" "{\"project_id\":$OTHER,\"title\":\"Task in a soon-archived project\"}"
T3=$(jqb .id)

api 200 POST "/api/projects/$OTHER/archive"
[ "$(jqb .archived)" = "true" ] || fail "archive: archived flag"
ok "POST /api/projects/{id}/archive: 200 + the project with archived true"

api 200 GET "/api/tasks"
[ "$(jqb 'map(select(.id == '"$T3"')) | length')" = "0" ] ||
  fail "unscoped GET /api/tasks must exclude an archived project's tasks"
ok "GET /api/tasks unscoped: excludes tasks of archived projects"

api 200 GET "/api/tasks?project=$OTHER"
[ "$(jqb 'map(select(.id == '"$T3"')) | length')" = "1" ] ||
  fail "scoped GET /api/tasks?project= must still return an archived project's tasks"
ok "GET /api/tasks?project=<archived>: a scoped read is unaffected by the flag"

api 200 GET "/api/projects"
[ "$(jqb 'map(select(.id == '"$OTHER"')) | length')" = "0" ] ||
  fail "GET /api/projects must exclude archived projects by default"
api 200 GET "/api/projects?include_archived=true"
[ "$(jqb 'map(select(.id == '"$OTHER"')) | length')" = "1" ] ||
  fail "GET /api/projects?include_archived=true must widen to archived projects"
ok "GET /api/projects: hides archived by default, ?include_archived=true widens"

api 200 POST "/api/projects/$OTHER/unarchive"
[ "$(jqb .archived)" = "false" ] || fail "unarchive: archived flag"
api 200 GET "/api/tasks"
[ "$(jqb 'map(select(.id == '"$T3"')) | length')" = "1" ] ||
  fail "unarchive must restore the project's tasks to unscoped reads"
ok "POST /api/projects/{id}/unarchive: 200, tasks return to unscoped reads"

# ---- delete echoes the destroyed records, subtasks included ----
api 201 POST "/api/tasks" "{\"project_id\":$PROJ,\"title\":\"Cascade parent\"}"
CP=$(jqb .id)
api 201 POST "/api/tasks" "{\"project_id\":$PROJ,\"title\":\"Cascade child\",\"parent_id\":$CP}"
CC=$(jqb .id)

api 200 DELETE "/api/tasks/$CP"
[ "$(jqb type)" = "array" ] || fail "DELETE: must echo an array of destroyed records"
[ "$(jqb '.[0].id')" = "$CP" ] || fail "DELETE: the task itself comes first"
[ "$(jqb 'map(.id) | sort | join(",")')" = "$CP,$CC" ] ||
  fail "DELETE: must echo the task and its subtask"
ok "DELETE /api/tasks/{id}: 200, echoes the destroyed task and its subtasks"

api 404 GET "/api/tasks/$CC"
ok "DELETE /api/tasks/{id}: the subtask is really gone (cascade)"

api 404 DELETE "/api/tasks/999999"
[ "$(jqb .error.code)" = "not_found" ] || fail "DELETE unknown task: error.code"
ok "DELETE /api/tasks/{id} unknown id: 404 not_found"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# =====================================================================
# 5. LAN mode: Host allowlist off, Content-Type gate still on
# =====================================================================
#
# `--lan` flips the bind address and the Host policy together — two halves of
# one opt-in posture (CLAUDE.md). What it must NOT do is relax the
# Content-Type gate, which is the cross-site form-post defense and applies in
# both modes.

LAN_PORT=17776
LAN_BASE="http://127.0.0.1:$LAN_PORT"
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$LAN_BASE/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$LAN_BASE/api/projects" >/dev/null ||
  fail "LAN server did not start (log: $(cat "$TMP/lan.log"))"

BASE=$LAN_BASE

raw GET "/api/projects" -H "Host: evil.example"
[ "$STATUS" = "200" ] || fail "LAN mode: a foreign Host must be allowed, got $STATUS"
ok "--lan: the Host allowlist is skipped (opt-in LAN trust)"

raw POST "/api/tasks" -H "Host: evil.example" -d "project_id=$PROJ&title=form+post"
[ "$STATUS" = "415" ] || fail "LAN mode: form-encoded POST must still be 415, got $STATUS"
[ "$(jqb .error.code)" = "validation" ] || fail "LAN mode 415: error.code"
ok "--lan: the Content-Type gate still rejects a form-encoded POST (415)"

raw POST "/api/tasks" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d "{\"project_id\":$PROJ,\"title\":\"lan create\"}"
[ "$STATUS" = "201" ] || fail "LAN mode: a JSON POST from any Host must work, got $STATUS ($BODY)"
ok "--lan: a JSON mutating request from any Host is accepted"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

echo "all $CHECKS checks passed"
