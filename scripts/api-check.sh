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
#   5. the project `sort_order` round-trip added by task 666 — the field the
#      sidebar's drag-reorder writes, and the list order it drives, plus the
#      `parent_id` surface added by task 668 (nesting, detach, cycle/unknown
#      rejection, the archive cascade and the subtree delete echo);
#   5b. GET /api/inbox/{id}/speak (task 815) — the audio contract, the patched
#      streaming WAV sizes, the audio arriving *while* it is still being
#      rendered (task 816), the hostile body arriving as stdin data, the
#      `unavailable` failure and the `require_agent_access` gate, driven
#      against a stub `kokoro-rs` (`MESA_KOKORO_BIN`);
#   6. LAN mode — the Host allowlist is skipped while the Content-Type gate
#      still applies, the two halves of one posture (CLAUDE.md), and the speak
#      route keeps its stronger gate through the flip.
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

# ---- stub kokoro-rs (the inbox speak route, mesa task 815) ----
#
# A stub, not the real synthesiser: this gate asserts the audio contract and
# the injection-proofness of the body handoff, neither of which needs a real
# 45 KB-per-second TTS model. It logs its stdin verbatim (so the hostile-body
# assertion can read it back) and emits the exact *streaming* WAV header
# `kokoro-rs -o -` writes — both sizes 0xFFFFFFFF — so the response proves
# mesa patched them.
#
# It also models the property task 816 turned on: a real synthesiser writes the
# header first and the audio sentence by sentence over the following seconds.
# Dropping a `slow` file in the stub dir inserts that pause between the two, so
# the gate can prove the header reaches the client while the render is still
# running.

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/kokoro-rs" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$STUB_DIR/last-argv"
cat > "$STUB_DIR/last-stdin"
[ -e "$STUB_DIR/fail" ] && { echo "stub kokoro is down" >&2; exit 1; }
# A failure that says a LOT (more than a pipe buffer) before dying: mesa must
# be draining stderr all along, or the child blocks there and never writes the
# stdout byte the request is waiting for.
[ -e "$STUB_DIR/noisy" ] && { head -c 200000 /dev/zero | tr '\0' 'x' >&2; exit 1; }
# A failure that complains on *stdout*: not a WAV, so it must never be served
# as audio.
[ -e "$STUB_DIR/garbage" ] && { echo "kokoro: model load failed, aborting"; exit 1; }
# RIFF ffffffff WAVE fmt (PCM/mono/24k) data ffffffff, then 8 bytes of "audio".
printf 'RIFF\xff\xff\xff\xffWAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\xc0\x5d\x00\x00\x80\xbb\x00\x00\x02\x00\x10\x00data\xff\xff\xff\xff'
if [ -e "$STUB_DIR/slow" ]; then
  sleep 3
  # More than a pipe buffer: a server that stopped reading wedges here forever
  # instead of reaching the marker below.
  head -c 262144 /dev/zero
else
  printf '\x01\x02\x03\x04\x05\x06\x07\x08'
fi
touch "$STUB_DIR/done"
EOF
chmod +x "$STUB_DIR/kokoro-rs"
export MESA_KOKORO_BIN="$STUB_DIR/kokoro-rs"
# …against a config file that doesn't exist, so this gate reads the developer's
# own `~/.mesa/config.json` as little as it reads their db. Since task 822 the
# speak route takes its voice from that file, and the argv assertions below are
# about the *unconfigured* argv — they must not turn red because whoever runs
# the script picked a voice in the UI. `config-check.sh` owns the configured
# half (it already runs under a throwaway HOME).
export MESA_CONFIG_FILE="$TMP/no-such-config.json"

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
  -d "{\"project_id\":$PROJ,\"description\":\"must not exist\"}"
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
raw POST "/api/tasks" -d "project_id=$PROJ&description=form+post"
[ "$STATUS" = "415" ] || fail "form-encoded POST: expected 415, got $STATUS"
ok "Content-Type gate: a form-encoded POST is 415 (the CSRF shape)"

raw POST "/api/tasks" -H 'Content-Type: text/plain' \
  -d "{\"project_id\":$PROJ,\"description\":\"text/plain\"}"
[ "$STATUS" = "415" ] || fail "text/plain POST: expected 415, got $STATUS"
ok "Content-Type gate: text/plain is 415"

# The gate compares the media type only, so a charset parameter is accepted —
# browsers and fetch() both send one.
raw POST "/api/tasks" -H 'Content-Type: application/json; charset=utf-8' \
  -d "{\"project_id\":$PROJ,\"description\":\"charset param\"}"
[ "$STATUS" = "201" ] || fail "application/json; charset=utf-8: expected 201, got $STATUS ($BODY)"
CHARSET_TASK=$(jqb .id)
ok "Content-Type gate: application/json; charset=utf-8 is accepted (param ignored)"

# Case-insensitive media type.
raw POST "/api/tasks" -H 'Content-Type: APPLICATION/JSON' \
  -d "{\"project_id\":$PROJ,\"description\":\"uppercase ct\"}"
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
  "{\"project_id\":$PROJ,\"description\":\"Root task\\nbody text\",\"priority\":\"high\",\"tags\":[\"api\"]}"
T1=$(jqb .id)
[ "$(jqb .project_id)" = "$PROJ" ] || fail "POST /api/tasks: project_id"
[ "$(jqb .description)" = "Root task
body text" ] || fail "POST /api/tasks: description"
[ "$(jqb .name)" = "Root task" ] || fail "POST /api/tasks: name derived from the first line"
[ "$(jqb .status)" = "backlog" ] || fail "POST /api/tasks: default status is backlog, not todo"
[ "$(jqb .priority)" = "high" ] || fail "POST /api/tasks: priority"
[ "$(jqb '.tags | join(",")')" = "api" ] || fail "POST /api/tasks: tags"
[ "$(jqb .blocked)" = "false" ] || fail "POST /api/tasks: blocked derived false"
[ "$(jqb .owner)" = "null" ] || fail "POST /api/tasks: owner starts null"
[ "$(jqb .claimed_at)" = "null" ] || fail "POST /api/tasks: claimed_at starts null"
ok "POST /api/tasks: 201 + full Task JSON"

# A missing required field is a contract-shaped 422, not axum's plain-text 400.
api 422 POST "/api/tasks" "{\"project_id\":$PROJ}"
[ "$(jqb .error.code)" = "validation" ] || fail "POST missing description: error.code"
ok "POST /api/tasks missing a required field: 422 validation in the error shape"

api 422 POST "/api/tasks" "not json at all"
[ "$(jqb .error.code)" = "validation" ] || fail "POST malformed body: error.code"
ok "POST /api/tasks with a malformed body: 422 validation, not a plain-text 400"

# Note the asymmetry, pinned deliberately: an unknown *project* on create is
# `Error::Validation` (422) in `Store::create_task`, while an unknown *task* on
# show/update/delete/claim is `not_found` (404). Both shapes are load-bearing
# for callers; this asserts the one that actually ships.
api 422 POST "/api/tasks" '{"project_id":999999,"description":"orphan"}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST unknown project: error.code"
ok "POST /api/tasks unknown project: 422 validation (not 404 — see Store::create_task)"

# ---- show ----
api 200 GET "/api/tasks/$T1"
[ "$(jqb .id)" = "$T1" ] || fail "GET /api/tasks/{id}: id"
[ "$(jqb .description)" = "Root task
body text" ] || fail "GET /api/tasks/{id}: carries description"
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
api 200 PATCH "/api/tasks/$T1" '{"acceptance":"ships","priority":"low"}'
[ "$(jqb .acceptance)" = "ships" ] || fail "PATCH: acceptance"
[ "$(jqb .priority)" = "low" ] || fail "PATCH: priority"
[ "$(jqb .description)" = "Root task
body text" ] || fail "PATCH: untouched fields survive"
ok "PATCH /api/tasks/{id}: 200 + full Task, partial update leaves other fields"

# `null` clears an optional long-text field; an absent key leaves it alone.
api 200 PATCH "/api/tasks/$T1" '{"acceptance":null}'
[ "$(jqb .acceptance)" = "null" ] || fail "PATCH acceptance:null: must clear"
ok "PATCH /api/tasks/{id}: explicit null clears an optional field"

# ...but the description is the task's identity, so it is the one body that
# cannot be cleared — `null` is a 422, not an erasure (task 660). The CLI's
# `--description ""` fails the same way; that pairing is the contract.
api 422 PATCH "/api/tasks/$T1" '{"description":null}'
[ "$(jqb .error.code)" = "validation" ] || fail "PATCH description:null: error.code"
api 200 GET "/api/tasks/$T1"
[ "$(jqb .description)" = "Root task
body text" ] || fail "PATCH description:null: body must survive the rejection"
# A replacement moves the derived name with it.
api 200 PATCH "/api/tasks/$T1" '{"description":"Root task renamed\nbody text"}'
[ "$(jqb .name)" = "Root task renamed" ] || fail "PATCH description: name follows the body"
ok "PATCH /api/tasks/{id}: description cannot be cleared (422), only replaced"

api 404 PATCH "/api/tasks/999999" '{"priority":"low"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "PATCH unknown task: error.code"
ok "PATCH /api/tasks/{id} unknown id: 404 not_found"

# A task's project is immutable after creation, and the API must not offer a
# side door around that Store invariant.
api 200 PATCH "/api/tasks/$T1" "{\"project_id\":$OTHER}"
[ "$(jqb .project_id)" = "$PROJ" ] || fail "PATCH project_id: must be ignored, not applied"
ok "PATCH /api/tasks/{id}: an unknown project_id key cannot move the task"

# ---- dependencies / derived blocked ----
api 201 POST "/api/tasks" "{\"project_id\":$PROJ,\"description\":\"Blocker\"}"
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
api 200 PATCH "/api/tasks/$T1" '{"description":"Root task touched\nbody text"}'
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

api 201 POST "/api/tasks" "{\"project_id\":$OTHER,\"description\":\"Task in a soon-archived project\"}"
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
api 201 POST "/api/tasks" "{\"project_id\":$PROJ,\"description\":\"Cascade parent\"}"
CP=$(jqb .id)
api 201 POST "/api/tasks" "{\"project_id\":$PROJ,\"description\":\"Cascade child\",\"parent_id\":$CP}"
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

# =====================================================================
# 5. Project sort_order: the drag-reorder round-trip (task 666)
# =====================================================================

# Baseline: creation order, one sort_order apart, and PROJ was created first.
api 200 GET "/api/projects"
[ "$(jqb 'map(select(.id == '"$PROJ"' or .id == '"$OTHER"')) | map(.id) | join(",")')" \
  = "$PROJ,$OTHER" ] ||
  fail "GET /api/projects: new projects must list in creation order"
ok "GET /api/projects: sort_order backfill/next-value keeps creation order"

api 200 GET "/api/projects/$PROJ"
FIRST_ORDER=$(jqb .sort_order)
[ "$FIRST_ORDER" != "null" ] || fail "GET /api/projects/{id}: sort_order must be serialized"
# `sort_order` is a REAL, so it comes back as `1.0` — do the arithmetic and the
# comparisons in jq, never in bash's integer-only $(( )).
NEW_ORDER=$(jq -n --argjson f "$FIRST_ORDER" '$f - 1')

# The drag: one PATCH of the moved project alone, with the value the sidebar
# computes for an insert above the head (`first - 1`).
api 200 PATCH "/api/projects/$OTHER" "{\"sort_order\": $NEW_ORDER}"
[ "$(jqb ".sort_order == $NEW_ORDER")" = "true" ] ||
  fail "PATCH /api/projects/{id}: sort_order must round-trip"
ok "PATCH /api/projects/{id} {sort_order}: 200 + the new value"

api 200 GET "/api/projects"
[ "$(jqb 'map(select(.id == '"$PROJ"' or .id == '"$OTHER"')) | map(.id) | join(",")')" \
  = "$OTHER,$PROJ" ] ||
  fail "GET /api/projects must reflect the new sort_order"
ok "GET /api/projects: the reordered project moved, the other one did not"

# The un-dragged project keeps the value it had — one drag is one write.
api 200 GET "/api/projects/$PROJ"
[ "$(jqb ".sort_order == $FIRST_ORDER")" = "true" ] ||
  fail "PATCH of one project must not rewrite another's sort_order"
ok "PATCH sort_order: neighbours are untouched"

# Omitting the field leaves it alone; a non-numeric value is a 422, never a
# silent no-op.
api 200 PATCH "/api/projects/$OTHER" '{"name":"API gate archived project"}'
[ "$(jqb ".sort_order == $NEW_ORDER")" = "true" ] ||
  fail "a PATCH without sort_order must leave it unchanged"
ok "PATCH without sort_order: value unchanged"

api 422 PATCH "/api/projects/$OTHER" '{"sort_order":"first"}'
ok "PATCH /api/projects/{id} non-numeric sort_order: 422"

# =====================================================================
# 5b. Subprojects: parent_id over HTTP (task 668)
# =====================================================================

api 201 POST "/api/projects" '{"name":"Subproject parent"}'
SP=$(jqb .id)
[ "$(jqb .parent_id)" = "null" ] || fail "POST /api/projects: default parent_id must be null"

api 201 POST "/api/projects" "{\"name\":\"Subproject child\",\"parent_id\":$SP}"
SC=$(jqb .id)
[ "$(jqb .parent_id)" = "$SP" ] || fail "POST /api/projects {parent_id}: must nest"
api 201 POST "/api/projects" "{\"name\":\"Subproject grandchild\",\"parent_id\":$SC}"
SG=$(jqb .id)
ok "POST /api/projects {parent_id}: 201, nests arbitrarily deep"

# The list keeps its shape: one flat array, each row carrying parent_id.
api 200 GET "/api/projects"
[ "$(jqb 'map(select(.id == '"$SG"')) | .[0].parent_id')" = "$SC" ] ||
  fail "GET /api/projects: each row must carry parent_id"
[ "$(jqb 'map(select(.id == '"$SP"' or .id == '"$SC"' or .id == '"$SG"')) | map(.id) | join(",")')" \
  = "$SP,$SC,$SG" ] ||
  fail "GET /api/projects: a new child must sort last among its siblings"
ok "GET /api/projects: flat array, parent_id present, child sorts last"

# Reparent, then detach with an explicit null.
api 200 PATCH "/api/projects/$SG" "{\"parent_id\":$SP}"
[ "$(jqb .parent_id)" = "$SP" ] || fail "PATCH parent_id: must reparent"
api 200 PATCH "/api/projects/$SG" '{"parent_id":null}'
[ "$(jqb .parent_id)" = "null" ] || fail "PATCH parent_id null: must detach to top level"
# Omitting the field leaves it alone (the double-option contract).
api 200 PATCH "/api/projects/$SG" "{\"parent_id\":$SC}"
api 200 PATCH "/api/projects/$SG" '{"name":"Subproject grandchild"}'
[ "$(jqb .parent_id)" = "$SC" ] || fail "a PATCH without parent_id must leave it unchanged"
ok "PATCH /api/projects/{id} {parent_id}: reparents, null detaches, absent is a no-op"

# No new error codes: a cycle is the existing 409, an unknown parent the 422.
api 409 PATCH "/api/projects/$SP" "{\"parent_id\":$SP}"
[ "$(jqb .error.code)" = "cycle" ] || fail "self-parent over HTTP: error.code"
api 409 PATCH "/api/projects/$SP" "{\"parent_id\":$SG}"
[ "$(jqb .error.code)" = "cycle" ] || fail "deep cycle over HTTP: error.code"
api 422 PATCH "/api/projects/$SP" '{"parent_id":999999}'
[ "$(jqb .error.code)" = "validation" ] || fail "unknown parent over HTTP: error.code"
api 422 POST "/api/projects" '{"name":"orphan","parent_id":999999}'
ok "parent_id: 409 cycle / 422 validation, no new error codes"

# Archiving the parent hides the subtree from unscoped reads only.
api 201 POST "/api/tasks" "{\"project_id\":$SG,\"description\":\"grandchild work\"}"
SGT=$(jqb .id)
api 200 POST "/api/projects/$SP/archive"
api 200 GET "/api/projects"
[ "$(jqb 'map(select(.id == '"$SC"' or .id == '"$SG"')) | length')" = "0" ] ||
  fail "archive cascade over HTTP: descendants must leave GET /api/projects"
api 200 GET "/api/tasks"
[ "$(jqb 'map(select(.id == '"$SGT"')) | length')" = "0" ] ||
  fail "archive cascade over HTTP: a descendant's tasks must leave unscoped GET /api/tasks"
api 200 GET "/api/projects/$SG"
[ "$(jqb .archived)" = "false" ] ||
  fail "archive cascade: a descendant's own archived flag must stay false"
api 200 GET "/api/tasks?project=$SG"
[ "$(jqb 'map(select(.id == '"$SGT"')) | length')" = "1" ] ||
  fail "archive cascade: a scoped read of a live child must be unaffected"
api 200 GET "/api/projects?include_archived=true"
[ "$(jqb 'map(select(.id == '"$SG"')) | length')" = "1" ] ||
  fail "?include_archived=true must still return the whole tree"
api 200 POST "/api/projects/$SP/unarchive"
api 200 GET "/api/projects"
[ "$(jqb 'map(select(.id == '"$SG"')) | length')" = "1" ] ||
  fail "unarchive of the root must restore the subtree in one call"
ok "archive/unarchive cascade over HTTP: unscoped only, one write, scoped reads unaffected"

# Deleting the root destroys the subtree; the echo carries every row.
api 200 DELETE "/api/projects/$SP"
[ "$(jqb .project.id)" = "$SP" ] || fail "DELETE project: root echoed"
[ "$(jqb '.subprojects | map(.id) | join(",")')" = "$SC,$SG" ] ||
  fail "DELETE project: subprojects echoed depth-first"
[ "$(jqb "any(.tasks[]; .id == $SGT)")" = "true" ] ||
  fail "DELETE project: a descendant's tasks must be echoed"
api 404 GET "/api/projects/$SG"
ok "DELETE /api/projects/{id}: cascades the subtree, echoes every destroyed row"

api 201 POST "/api/projects" '{"name":"Subproject leaf"}'
SL=$(jqb .id)
api 200 DELETE "/api/projects/$SL"
[ "$(jqb '.subprojects | length')" = "0" ] ||
  fail "DELETE a leaf project: subprojects must be []"
ok "DELETE /api/projects/{id} on a leaf: unchanged apart from an empty subprojects"

# =====================================================================
# 5b. GET /api/inbox/{id}/speak — reading an item aloud (mesa task 815)
# =====================================================================
#
# The route runs an external synthesiser and answers audio bytes. Four things
# must hold: the audio contract (type, nosniff, patched WAV sizes), the body
# reaching the binary as *data* on stdin (never a shell string), the outside-
# mesa failure being `unavailable` rather than a 500, and the gate — this is
# `require_agent_access`, stricter than the task routes beside it.

HOSTILE='$(touch '"$TMP"'/pwned); rm -rf / # spoken'
SPEAK_ID=$("$MESA" inbox add "$HOSTILE" | jq -r .id)

speak() { # speak <path> [curl args...] -> STATUS, $TMP/audio, $TMP/headers
  local path=$1
  shift
  STATUS=$(curl -s -o "$TMP/audio" -D "$TMP/headers" -w '%{http_code}' "$@" "$BASE$path")
}

speak "/api/inbox/$SPEAK_ID/speak"
[ "$STATUS" = "200" ] || fail "speak: expected 200, got $STATUS ($(cat "$TMP/audio"))"
grep -qi '^content-type: audio/wav' "$TMP/headers" || fail "speak: Content-Type must be audio/wav"
grep -qi '^x-content-type-options: nosniff' "$TMP/headers" || fail "speak: nosniff missing"
ok "GET /api/inbox/{id}/speak: 200 audio/wav + nosniff"

# The stub emits a 44-byte streaming header + 8 bytes of audio with BOTH sizes
# 0xFFFFFFFF. Since the audio streams (task 816) the real length is unknown when
# the header goes out, so mesa replaces the placeholders with the open-ended
# 0x7FFF0000 (+ the 36 header bytes for RIFF) — both still positive 31-bit
# sizes, which is what a player that refuses the placeholder (Safari) wants. The
# samples must still arrive untouched.
[ "$(wc -c <"$TMP/audio" | tr -d ' ')" = "52" ] || fail "speak: audio bytes not passed through"
HEXED=$(od -An -tx1 -v "$TMP/audio" | tr -d ' \n')
[ "${HEXED:8:8}" = "2400ff7f" ] || fail "speak: RIFF size not patched (got ${HEXED:8:8})"
[ "${HEXED:80:8}" = "0000ff7f" ] || fail "speak: data size not patched (got ${HEXED:80:8})"
[ "${HEXED:88}" = "0102030405060708" ] || fail "speak: audio payload altered"
ok "speak: the streaming 0xFFFFFFFF WAV sizes are patched, the samples are untouched"

# The response must also carry no Content-Length: the body is chunked because
# its length is not knowable when the header goes out.
grep -qi '^content-length:' "$TMP/headers" &&
  fail "speak: a streamed body must not declare a Content-Length"
ok "speak: the body is chunked, not length-declared"

# …and streaming means exactly this: the header reaches the client while the
# synthesiser is still rendering. The slow stub pauses 3s between the header and
# the samples, so a 1s cap must return the header alone (curl exit 28), not the
# empty body a collect-then-send route would have produced.
touch "$STUB_DIR/slow"
set +e
curl -s --max-time 1 -o "$TMP/partial" "$BASE/api/inbox/$SPEAK_ID/speak"
CURL_RC=$?
set -e
rm -f "$STUB_DIR/slow"
[ "$CURL_RC" = "28" ] || fail "speak: the slow stub should have outlived the 1s cap (curl rc $CURL_RC)"
[ "$(wc -c <"$TMP/partial" | tr -d ' ')" = "44" ] ||
  fail "speak: the header must arrive while synthesis runs, got $(wc -c <"$TMP/partial") bytes"
ok "speak: audio streams — the header plays before the render finishes"

# A listener that hangs up mid-render (stop, or a closed tab) discards the rest
# of the audio — but the synthesis still runs to completion, the no-kill-path
# posture of docs/inbox.md. A server that merely stopped reading would leave the
# child blocked on a full stdout pipe forever, so the marker is the proof.
rm -f "$STUB_DIR/done"
touch "$STUB_DIR/slow"
curl -s --max-time 1 -o /dev/null "$BASE/api/inbox/$SPEAK_ID/speak" || true
for _ in $(seq 1 60); do
  [ -e "$STUB_DIR/done" ] && break
  sleep 0.5
done
rm -f "$STUB_DIR/slow"
[ -e "$STUB_DIR/done" ] ||
  fail "speak: a client that hung up left the synthesiser wedged on a full pipe"
ok "speak: a listener that hangs up mid-render leaves no wedged synthesiser"

# Injection-proof: the body reaches the binary as stdin bytes, verbatim, and
# no shell ever parses it.
[ "$(cat "$STUB_DIR/last-stdin")" = "$HOSTILE" ] ||
  fail "speak: body must reach the synthesiser verbatim on stdin (got $(cat "$STUB_DIR/last-stdin"))"
[ ! -e "$TMP/pwned" ] || fail "speak: a hostile body was evaluated by a shell"
# …and the body is on stdin *only*: argv must stay the fixed three flags, so a
# regression that also passed the text as an argument fails here.
[ "$(cat "$STUB_DIR/last-argv")" = "-q -o -" ] ||
  fail "speak: argv must be the fixed flags, got $(cat "$STUB_DIR/last-argv")"
ok "speak: a hostile body is stdin data, never syntax and never argv"

# The voice is configurable since task 822, but mesa names no default of its
# own: with nothing configured the argv must carry no `-v` at all, i.e. be the
# one this gate asserted before the setting existed. (The configured half lives
# in scripts/config-check.sh, which owns a throwaway HOME.)
grep -q -- ' -v' "$STUB_DIR/last-argv" &&
  fail "speak: an unconfigured voice must add no -v, got $(cat "$STUB_DIR/last-argv")"
ok "speak: with no voice configured the argv carries no -v (unchanged from before task 822)"

api 404 GET "/api/inbox/999999/speak"
[ "$(jqb .error.code)" = "not_found" ] || fail "speak: unknown id must be not_found"
ok "speak: an unknown item is 404 not_found"

touch "$STUB_DIR/fail"
speak "/api/inbox/$SPEAK_ID/speak"
[ "$STATUS" = "503" ] || fail "speak: a failing synthesiser must be 503, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "unavailable" ] ||
  fail "speak: a failing synthesiser must be code unavailable"
rm -f "$STUB_DIR/fail"
ok "speak: a failing synthesiser is 503 unavailable (an outside-mesa dependency)"

# …and the two shapes of failure that a *streaming* reader can get wrong, both
# of which used to be reportable and must stay so. First: a binary that fills
# its stderr pipe before dying. Every pipe must be drained for the child's whole
# life, or it blocks on stderr and the request hangs with no status at all.
touch "$STUB_DIR/noisy"
speak "/api/inbox/$SPEAK_ID/speak" --max-time 20
rm -f "$STUB_DIR/noisy"
[ "$STATUS" = "503" ] || fail "speak: a synthesiser that fills stderr must still be 503, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "unavailable" ] ||
  fail "speak: the noisy failure must be code unavailable"
ok "speak: a synthesiser that fills its stderr pipe is still 503, not a hung request"

# Second: a binary that complains on stdout and exits nonzero. Those bytes are
# not a WAV, so serving them as audio/wav would render an error message to the
# listener as if it were speech.
touch "$STUB_DIR/garbage"
speak "/api/inbox/$SPEAK_ID/speak" --max-time 20
rm -f "$STUB_DIR/garbage"
[ "$STATUS" = "503" ] || fail "speak: non-WAV output from a failed run must be 503, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "unavailable" ] ||
  fail "speak: the garbage-stdout failure must be code unavailable"
ok "speak: a failed run's stdout is never passed off as audio"

# Gate, half one: require_agent_access refuses a cross-site Origin, while the
# same item's JSON — on the plain guard — is served with that same Origin. The
# contrast is the point, so BOTH calls must carry the header.
speak "/api/inbox/$SPEAK_ID/speak" -H 'Origin: http://evil.example'
[ "$STATUS" = "403" ] || fail "speak: a foreign Origin must be 403, got $STATUS"
raw GET "/api/inbox/$SPEAK_ID" -H 'Origin: http://evil.example'
[ "$STATUS" = "200" ] ||
  fail "the item's JSON must stay on the plain guard (foreign Origin), got $STATUS"
ok "speak: a foreign Origin is 403 while the item's JSON, on the plain guard, is not"

# Gate, half two: a cross-site <img>/<audio> subresource sends NO Origin, so
# the Origin checks would wave it through — `Sec-Fetch-Site` is what refuses
# it. Absent (curl, an old browser) stays allowed; our own page is same-origin.
speak "/api/inbox/$SPEAK_ID/speak" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Dest: audio'
[ "$STATUS" = "403" ] || fail "speak: a cross-site subresource must be 403, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "validation" ] ||
  fail "speak: the cross-site refusal must be code validation"
speak "/api/inbox/$SPEAK_ID/speak" -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Dest: audio'
[ "$STATUS" = "200" ] || fail "speak: our own page's <audio> must be served, got $STATUS"
speak "/api/inbox/$SPEAK_ID/speak" -H 'Sec-Fetch-Site: none'
[ "$STATUS" = "200" ] || fail "speak: a typed-in URL must be served, got $STATUS"
ok "speak: Sec-Fetch-Site closes the no-Origin subresource hole (cross-site 403, same-origin/none 200)"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# =====================================================================
# 6. LAN mode: Host allowlist off, Content-Type gate still on
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

raw POST "/api/tasks" -H "Host: evil.example" -d "project_id=$PROJ&description=form+post"
[ "$STATUS" = "415" ] || fail "LAN mode: form-encoded POST must still be 415, got $STATUS"
[ "$(jqb .error.code)" = "validation" ] || fail "LAN mode 415: error.code"
ok "--lan: the Content-Type gate still rejects a form-encoded POST (415)"

raw POST "/api/tasks" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d "{\"project_id\":$PROJ,\"description\":\"lan create\"}"
[ "$STATUS" = "201" ] || fail "LAN mode: a JSON POST from any Host must work, got $STATUS ($BODY)"
ok "--lan: a JSON mutating request from any Host is accepted"

# The speak route does NOT follow the Host allowlist off: it carries the
# stronger agent gate, so under --lan a DNS-name Host is still refused while
# the IP-literal Host a real LAN browser sends is served (the pairing that
# must not drift apart).
speak "/api/inbox/$SPEAK_ID/speak" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "--lan speak: a DNS-name Host must still be 403, got $STATUS"
speak "/api/inbox/$SPEAK_ID/speak" -H "Host: 127.0.0.1:$LAN_PORT"
[ "$STATUS" = "200" ] || fail "--lan speak: an IP-literal Host must be served, got $STATUS"
grep -qi '^content-type: audio/wav' "$TMP/headers" || fail "--lan speak: Content-Type"
ok "--lan: speak keeps the agent gate (DNS Host 403, IP-literal Host 200)"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

echo "all $CHECKS checks passed"
