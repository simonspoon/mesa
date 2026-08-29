#!/usr/bin/env bash
# Artifacts gate (mesa task 974): agent-written documents (HTML mockups,
# SVGs, markdown reports) stored per project and rendered back through a
# sandboxed route, exercised over the CLI (`mesa artifact ...`) and the API
# (`/api/projects/{id}/artifacts...`, `/api/artifacts/{id}...`) against a
# throwaway MESA_DB.
#
# The load-bearing assertions, beyond CRUD shape:
#   * `list` never includes `body`, and rejects `--quiet` (it already omits
#     the one field quiet would drop);
#   * a duplicate `name` within a project is `conflict`, case-insensitively;
#   * a body over `ARTIFACT_BODY_MAX` (2 MiB) is `validation` naming the
#     limit, distinct from an empty/blank body;
#   * deleting a project CASCADEs its artifacts; deleting a task SETs
#     `task_id` NULL on artifacts bound to it, leaving the artifact itself
#     alone — the opposite of scripts'/inbox's own SET NULL on project;
#   * the render route serves the stored body byte-identically behind the
#     EXACT CSP / nosniff / Content-Type / Content-Disposition header set,
#     404s an artifact/project mismatch, and — the whole point of plain
#     `guard` with no stronger gate — answers with that identical header set
#     under both `serve` and `serve --lan`.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; [ -n "${LAN_PID:-}" ] && kill "$LAN_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

# run <expected-exit> <cmd...> — captures STDOUT, STDERR, CODE.
run() {
  local expected=$1; shift
  set +e
  STDOUT=$("$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stdout: $STDOUT) (stderr: $STDERR)"
}

jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- fixtures ----

run 0 "$MESA" project create "Artifacts project" --no-git
P=$(jqs .id)
run 0 "$MESA" project create "Other project" --no-git
P2=$(jqs .id)

run 0 "$MESA" task create "$P" "a task to bind"
T=$(jqs .id)

# ================= CLI =================

# ---- create ----

# positional PROJECT + NAME, --body, default content-type
run 0 "$MESA" artifact create "$P" mockup --body '<h1>hi</h1>'
[ "$(jqs .name)" = "mockup" ] || fail "CLI create: name"
[ "$(jqs .project_id)" = "$P" ] || fail "CLI create: project_id"
[ "$(jqs .task_id)" = "null" ] || fail "CLI create: task_id unbound by default"
[ "$(jqs .content_type)" = "text/html" ] || fail "CLI create: content_type defaults to text/html"
[ "$(jqs .body)" = "<h1>hi</h1>" ] || fail "CLI create: body verbatim"
[ "$(jqs .created_at)" != "null" ] || fail "CLI create: created_at"
[ "$(jqs .updated_at)" != "null" ] || fail "CLI create: updated_at"
A_MOCKUP=$(jqs .id)
ok "CLI artifact create: positional PROJECT + NAME + --body returns the full record, content_type defaults to text/html"

# flag form: --project NAME, --body-file, explicit --content-type, --task
printf '# Report\n\nsome findings\n' > "$TMP/report.md"
run 0 "$MESA" artifact create --project "Artifacts project" --name report \
  --body-file "$TMP/report.md" --content-type text/markdown --task "$T"
[ "$(jqs .project_id)" = "$P" ] || fail "CLI create flag form: --project resolves a project NAME"
[ "$(jqs .content_type)" = "text/markdown" ] || fail "CLI create: --content-type"
[ "$(jqs .task_id)" = "$T" ] || fail "CLI create: --task binds"
[ "$(jqs .body)" = "$(cat "$TMP/report.md")" ] || fail "CLI create: --body-file body verbatim"
A_REPORT=$(jqs .id)
ok "CLI artifact create: --project NAME/--name/--body-file/--content-type/--task"

# --body-file - reads stdin
STDOUT=$(printf '<svg xmlns="http://www.w3.org/2000/svg"/>' |
  "$MESA" artifact create "$P" diagram --body-file - --content-type image/svg+xml 2>"$TMP/stderr")
CODE=$?
[ "$CODE" -eq 0 ] || fail "CLI create --body-file -: expected exit 0, got $CODE"
[ "$(jqs .content_type)" = "image/svg+xml" ] || fail "CLI create: --body-file - reads stdin"
A_SVG=$(jqs .id)
ok "CLI artifact create: --body-file - reads the body from stdin"

# both positional and flag for the same required arg is a usage error
run 2 "$MESA" artifact create "$P" dup --name dup --body x
[ "$(jqe .error.code)" = "usage" ] || fail "CLI create positional+flag NAME: code=usage"
ok "CLI artifact create NAME positionally AND as --name: exit 2, code=usage"

run 2 "$MESA" artifact create --name onlyflag --body x
[ "$(jqe .error.code)" = "usage" ] || fail "CLI create with no PROJECT: code=usage"
ok "CLI artifact create with no PROJECT (positional or flag): exit 2, code=usage"

# ---- create: domain errors ----

run 1 "$MESA" artifact create "$P" empty-body --body '   '
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create blank body: error.code"
ok "CLI artifact create with a blank body: exit 1, code=validation"

run 1 "$MESA" artifact create "$P" '   ' --body x
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create blank name: error.code"
ok "CLI artifact create with a blank name: exit 1, code=validation"

run 1 "$MESA" artifact create "$P" mockup --body x
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI create duplicate name: error.code"
ok "CLI artifact create with a duplicate name in the same project: exit 1, code=conflict"

run 1 "$MESA" artifact create "$P" MOCKUP --body x
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI create case-insensitive duplicate name: error.code"
ok "CLI artifact create with a duplicate name differing only in case: exit 1, code=conflict"

# the SAME name in a DIFFERENT project is fine — uniqueness is per-project
run 0 "$MESA" artifact create "$P2" mockup --body x
ok "CLI artifact create: the same name in a different project is not a conflict"

run 1 "$MESA" artifact create "$P" badtype --body x --content-type text/plain
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create disallowed content-type: error.code"
ok "CLI artifact create with a content-type outside the three-value allowlist: exit 1, code=validation"

run 1 "$MESA" artifact create 999999 orphan --body x
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create unknown project: error.code"
ok "CLI artifact create with an unknown project: exit 1, code=validation"

run 1 "$MESA" artifact create "$P" badtask --body x --task 999999
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create unknown task: error.code"
ok "CLI artifact create with an unknown task: exit 1, code=validation"

# ---- create: ARTIFACT_BODY_MAX (2 MiB) ----

run 0 "$MESA" artifact create "$P" atcap --body-file <(head -c $((2 * 1024 * 1024)) /dev/zero | tr '\0' 'x')
ok "CLI artifact create: a body exactly at ARTIFACT_BODY_MAX (2 MiB) is accepted"

run 1 "$MESA" artifact create "$P" overcap --body-file <(head -c $((2 * 1024 * 1024 + 1)) /dev/zero | tr '\0' 'x')
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create over-cap body: error.code"
grep -qi "2097152\|2 MiB\|2097153" <<<"$(jqe .error.message)" ||
  fail "CLI create over-cap body: error message should name the byte limit, got: $(jqe .error.message)"
ok "CLI artifact create with a body one byte over ARTIFACT_BODY_MAX: exit 1, code=validation, naming the limit"

# ---- list ----

run 0 "$MESA" artifact list "$P"
[ "$(jqs type)" = "array" ] || fail "CLI list: bare array"
[ "$(jqs length)" = "4" ] || fail "CLI list: expected 4 artifacts in P, got $STDOUT"
[ "$(jqs 'map(.name) | join(",")')" = "atcap,diagram,mockup,report" ] ||
  fail "CLI list: ordered by name COLLATE NOCASE, got $STDOUT"
[ "$(jqs 'map(has("body")) | any')" = "false" ] || fail "CLI list: body must never appear"
ok "CLI artifact list <PROJECT>: bare array, ordered by name, no body field"

run 0 "$MESA" artifact list --project "Artifacts project"
[ "$(jqs length)" = "4" ] || fail "CLI list --project NAME: expected 4"
ok "CLI artifact list --project NAME: a project argument takes an id or a name"

run 0 "$MESA" artifact list
[ "$(jqs 'map(select(.project_id == '"$P2"')) | length')" = "1" ] ||
  fail "CLI list with no PROJECT: expected P2's artifact present, got $STDOUT"
[ "$(jqs 'map(select(.project_id == '"$P"')) | length')" = "4" ] ||
  fail "CLI list with no PROJECT: expected P's 4 artifacts present, got $STDOUT"
ok "CLI artifact list with no PROJECT: unscoped, spans every project"

run 2 "$MESA" artifact list "$P" --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on list: code=usage"
ok "--quiet on artifact list: rejected as an unknown argument, exit 2 usage"

# ---- show / get ----

run 0 "$MESA" artifact show "$A_MOCKUP"
[ "$(jqs .id)" = "$A_MOCKUP" ] || fail "CLI show: id"
[ "$(jqs .body)" = "<h1>hi</h1>" ] || fail "CLI show: full record includes body"
ok "CLI artifact show <ID>: full record"

run 0 "$MESA" artifact get "$A_MOCKUP"
[ "$(jqs .id)" = "$A_MOCKUP" ] || fail "CLI get alias"
ok "CLI artifact get: alias for show"

run 1 "$MESA" artifact show 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI show unknown id: error.code"
ok "CLI artifact show unknown id: exit 1, code=not_found"

# ---- update ----

run 0 "$MESA" artifact update "$A_MOCKUP" --body '<h1>hi again</h1>'
[ "$(jqs .body)" = "<h1>hi again</h1>" ] || fail "CLI update: body"
[ "$(jqs .name)" = "mockup" ] || fail "CLI update: untouched fields preserved"
ok "CLI artifact update --body: patches one field, leaves the rest"

run 0 "$MESA" artifact update "$A_MOCKUP" --name mockup2
[ "$(jqs .name)" = "mockup2" ] || fail "CLI update: name"
ok "CLI artifact update --name: renames"

run 1 "$MESA" artifact update "$A_MOCKUP" --name report
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI update to a taken name: error.code"
ok "CLI artifact update to an already-taken name in the same project: exit 1, code=conflict"

run 1 "$MESA" artifact update "$A_MOCKUP" --body '  '
[ "$(jqe .error.code)" = "validation" ] || fail "CLI update blank body: error.code"
ok "CLI artifact update with a blank body: exit 1, code=validation (replace-only, not an erasure)"

run 1 "$MESA" artifact update "$A_MOCKUP" --name '  '
[ "$(jqe .error.code)" = "validation" ] || fail "CLI update blank name: error.code"
ok "CLI artifact update with a blank name: exit 1, code=validation"

run 1 "$MESA" artifact update "$A_MOCKUP" --content-type text/plain
[ "$(jqe .error.code)" = "validation" ] || fail "CLI update disallowed content-type: error.code"
ok "CLI artifact update with a content-type outside the allowlist: exit 1, code=validation"

run 0 "$MESA" artifact update "$A_REPORT" --task ""
[ "$(jqs .task_id)" = "null" ] || fail "CLI update --task '': must un-bind"
ok "CLI artifact update --task '': un-binds the task"

run 0 "$MESA" artifact update "$A_REPORT" --task "$T"
[ "$(jqs .task_id)" = "$T" ] || fail "CLI update --task: rebind"
ok "CLI artifact update --task <ID>: rebinds"

run 2 "$MESA" artifact update "$A_MOCKUP"
[ "$(jqe .error.code)" = "usage" ] || fail "CLI update with no field flag: code=usage"
[ -z "$STDOUT" ] || fail "CLI update usage error: stdout must be empty"
ok "CLI artifact update with no field flag: exit 2, code=usage, empty stdout"

run 1 "$MESA" artifact update 999999 --body x
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI update unknown id: error.code"
ok "CLI artifact update unknown id: exit 1, code=not_found"

# ---- --quiet: create/update/show/delete drop exactly `body` ----

quiet_parity() { # quiet_parity <label> <full-json> <quiet-json>
  local label=$1 full=$2 quiet=$3
  local dropped
  dropped=$(jq -r --argjson q "$quiet" \
    '[keys_unsorted[] as $k | select($q | has($k) | not) | $k] | sort | join(",")' <<<"$full")
  [ "$dropped" = "body" ] ||
    fail "$label: --quiet must drop exactly body — dropped: [$dropped]"
  [ "$(jq -S 'del(.body)' <<<"$full")" = "$(jq -S . <<<"$quiet")" ] ||
    fail "$label: --quiet changed a value, not just the key set"
}

run 0 "$MESA" artifact show "$A_REPORT"
FULL=$STDOUT
run 0 "$MESA" artifact show "$A_REPORT" --quiet
quiet_parity "artifact show" "$FULL" "$STDOUT"
ok "--quiet on artifact show: drops exactly body, every other key and value identical"

run 0 "$MESA" artifact create "$P" quiettest --body q --quiet
QUIET=$STDOUT
QID=$(jq -r .id <<<"$QUIET")
run 0 "$MESA" artifact show "$QID"
quiet_parity "artifact create" "$STDOUT" "$QUIET"
[ "$(jqs .body)" = "q" ] || fail "quiet create: the record was still stored in full"
ok "--quiet on artifact create: prints the record minus body, storing it in full"

run 0 "$MESA" artifact update "$QID" --body q2
FULL=$STDOUT
run 0 "$MESA" artifact update "$QID" --body q3 --quiet
QUIET=$STDOUT
run 0 "$MESA" artifact show "$QID"
quiet_parity "artifact update" "$STDOUT" "$QUIET"
ok "--quiet on artifact update: drops exactly body"

run 0 "$MESA" artifact show "$QID"
FULL=$STDOUT
run 0 "$MESA" artifact delete "$QID" --quiet
quiet_parity "artifact delete" "$FULL" "$STDOUT"
run 1 "$MESA" artifact show "$QID"
[ "$(jqe .error.code)" = "not_found" ] || fail "quiet delete: the record is actually gone"
ok "--quiet on artifact delete: drops exactly body and the record is gone"

# ---- delete echoes the full destroyed record (the safety floor) ----

run 0 "$MESA" artifact show "$A_SVG"
FULL=$STDOUT
run 0 "$MESA" artifact delete "$A_SVG"
[ "$(jq -S . <<<"$STDOUT")" = "$(jq -S . <<<"$FULL")" ] ||
  fail "CLI delete: must echo the full destroyed record verbatim"
ok "CLI artifact delete: echoes the full destroyed record (recovery transcript)"

run 1 "$MESA" artifact delete 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI delete unknown id: error.code"
ok "CLI artifact delete unknown id: exit 1, code=not_found"

# ---- project delete CASCADEs its artifacts (the opposite of scripts) ----

run 0 "$MESA" project create "Cascade project" --no-git
PCASC=$(jqs .id)
run 0 "$MESA" artifact create "$PCASC" doomed --body x
A_DOOMED=$(jqs .id)
run 0 "$MESA" project delete "$PCASC"
run 1 "$MESA" artifact show "$A_DOOMED"
[ "$(jqe .error.code)" = "not_found" ] || fail "project delete must CASCADE its artifacts: error.code"
ok "deleting a project CASCADEs its artifacts (ON DELETE CASCADE) — the opposite of scripts' SET NULL"

# ---- task delete SETs NULL on task_id, leaving the artifact intact ----

run 0 "$MESA" task create "$P" "a doomed task"
TDOOMED=$(jqs .id)
run 0 "$MESA" artifact create "$P" taskbound --body x --task "$TDOOMED"
A_TASKBOUND=$(jqs .id)
run 0 "$MESA" task delete "$TDOOMED"
run 0 "$MESA" artifact show "$A_TASKBOUND"
[ "$(jqs .task_id)" = "null" ] ||
  fail "task delete must SET NULL on a bound artifact's task_id: $STDOUT"
ok "deleting a task SETs NULL on artifacts.task_id (ON DELETE SET NULL) — the artifact itself survives"

# ================= API =================

PORT=17788
"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null ||
  fail "server did not start (log: $(cat "$TMP/serve.log"))"

BASE="http://127.0.0.1:$PORT"

api() { # api <expected-status> <method> <path> [json-body]
  local expected=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method")
  case "$method" in
    POST | PUT | PATCH | DELETE)
      args+=(-H 'Content-Type: application/json' -d "${body:-{\}}")
      ;;
  esac
  STATUS=$(curl "${args[@]}" "$BASE$path")
  BODY=$(cat "$TMP/body")
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
jqb() { jq -r "$1" <<<"$BODY"; }

# fetch <path> — GET into $TMP/out with its headers in $TMP/headers.
fetch() {
  STATUS=$(curl -s -o "$TMP/out" -D "$TMP/headers" -w '%{http_code}' "$1")
  BODY=$(cat "$TMP/out")
}
hdr() {
  local name
  name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  tr -d '\r' < "$TMP/headers" |
    awk -v n="$name:" 'tolower($0) ~ "^"n {sub(/^[^:]*:[ \t]*/, ""); print}'
}

run 0 "$MESA" project create "API artifacts project" --no-git
AP=$(jqs .id)
run 0 "$MESA" project create "API other project" --no-git
AP2=$(jqs .id)

# ---- create ----

api 201 POST "/api/projects/$AP/artifacts" \
  '{"name":"api-mockup","content_type":"text/html","body":"<h1>api</h1>"}'
[ "$(jqb .name)" = "api-mockup" ] || fail "API create: name"
[ "$(jqb .project_id)" = "$AP" ] || fail "API create: project_id"
[ "$(jqb .body)" = "<h1>api</h1>" ] || fail "API create: body"
AID=$(jqb .id)
ok "POST /api/projects/{id}/artifacts: 201 + the full Artifact JSON"

# content_type is OPTIONAL on the API too — the default lives in `core`
# (DEFAULT_ARTIFACT_CONTENT_TYPE, applied inside Store::create_artifact), so
# the CLI's default and the API's default cannot diverge.
api 201 POST "/api/projects/$AP/artifacts" '{"name":"api-defaulted","body":"<p>no type given</p>"}'
[ "$(jqb .content_type)" = "text/html" ] ||
  fail "API create with no content_type: must default to text/html, got $(jqb .content_type)"
ok "POST .../artifacts with no content_type field: 201, defaults to text/html (same default as the CLI, shared via core)"

api 422 POST "/api/projects/$AP/artifacts" '{"name":"api-blank","content_type":"text/html","body":"   "}'
[ "$(jqb .error.code)" = "validation" ] || fail "API create blank body: error.code"
ok "POST .../artifacts with a blank body: 422 validation"

api 409 POST "/api/projects/$AP/artifacts" '{"name":"api-mockup","content_type":"text/html","body":"x"}'
[ "$(jqb .error.code)" = "conflict" ] || fail "API create duplicate name: error.code"
ok "POST .../artifacts with a duplicate name: 409 conflict"

api 422 POST "/api/projects/$AP/artifacts" '{"name":"api-badtype","content_type":"text/plain","body":"x"}'
[ "$(jqb .error.code)" = "validation" ] || fail "API create disallowed content-type: error.code"
ok "POST .../artifacts with a content-type outside the allowlist: 422 validation"

api 422 POST "/api/projects/$AP/artifacts" '{"name":"api-malformed"}'
[ "$(jqb .error.code)" != "null" ] || fail "API create malformed body: error payload"
ok "POST .../artifacts with a malformed body (no content_type/body fields): 422"

api 422 POST "/api/projects/$AP/artifacts" '{not json'
ok "POST .../artifacts with unparseable JSON: 422 (JsonRejection, never a 500)"

# the repo-wide Content-Type gate covers these routes with no carve-out
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -d '{"name":"x","content_type":"text/html","body":"x"}' "$BASE/api/projects/$AP/artifacts")
[ "$NO_CT" = "415" ] || fail "POST .../artifacts without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -d '{"name":"x"}' "$BASE/api/artifacts/$AID")
[ "$NO_CT" = "415" ] || fail "PATCH /api/artifacts/{id} without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/artifacts/999999")
[ "$NO_CT" = "415" ] || fail "DELETE /api/artifacts/{id} without Content-Type: expected 415, got $NO_CT"
ok "every mutating artifacts route without a JSON Content-Type is 415 (no carve-out in the global guard)"

# ---- list ----

api 200 GET "/api/projects/$AP/artifacts"
[ "$(jqb type)" = "array" ] || fail "API list: bare array"
[ "$(jqb 'map(select(.name == "api-mockup")) | length')" = "1" ] || fail "API list: new artifact present"
[ "$(jqb 'map(has("body")) | any')" = "false" ] || fail "API list: body must never appear"
ok "GET /api/projects/{id}/artifacts: bare array, no body field"

# ---- show ----

api 200 GET "/api/artifacts/$AID"
[ "$(jqb .id)" = "$AID" ] || fail "API show: id"
[ "$(jqb .body)" != "null" ] || fail "API show: full record includes body"
ok "GET /api/artifacts/{id}: full record"

api 404 GET /api/artifacts/999999
[ "$(jqb .error.code)" = "not_found" ] || fail "API show unknown id: error.code"
ok "GET /api/artifacts/{id} unknown id: 404 not_found"

# ---- update ----

api 200 PATCH "/api/artifacts/$AID" '{"body":"<h1>patched</h1>"}'
[ "$(jqb .body)" = "<h1>patched</h1>" ] || fail "API patch: body"
[ "$(jqb .name)" = "api-mockup" ] || fail "API patch: untouched fields preserved"
ok "PATCH /api/artifacts/{id}: 200 + the updated record"

api 422 PATCH "/api/artifacts/$AID" '{"body":"  "}'
[ "$(jqb .error.code)" = "validation" ] || fail "API patch blank body: error.code"
ok "PATCH /api/artifacts/{id} with a blank body: 422 validation"

api 404 PATCH /api/artifacts/999999 '{"body":"x"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "API patch unknown id: error.code"
ok "PATCH /api/artifacts/{id} unknown id: 404 not_found"

# ---- render ----

api 201 POST "/api/projects/$AP/artifacts" \
  "{\"name\":\"render-html\",\"content_type\":\"text/html\",\"body\":\"<h1>hi</h1><script>1</script>\"}"
RHTML=$(jqb .id)

fetch "$BASE/api/projects/$AP/artifacts/$RHTML/render"
[ "$STATUS" = "200" ] || fail "render html: expected 200, got $STATUS ($BODY)"
[ "$(hdr content-type)" = "text/html; charset=utf-8" ] ||
  fail "render html: content-type must be text/html; charset=utf-8, got '$(hdr content-type)'"
case "$(hdr content-disposition)" in
  inline*) ;;
  *) fail "render html: content-disposition must start with inline, got '$(hdr content-disposition)'" ;;
esac
grep -q 'filename="render-html"' <<<"$(hdr content-disposition)" ||
  fail "render html: content-disposition must name the artifact, got '$(hdr content-disposition)'"
[ "$(hdr x-content-type-options)" = "nosniff" ] ||
  fail "render html: x-content-type-options must be nosniff, got '$(hdr x-content-type-options)'"
CSP=$(hdr content-security-policy)
EXPECTED_CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts"
[ "$CSP" = "$EXPECTED_CSP" ] ||
  fail "render html: CSP must be exactly '$EXPECTED_CSP', got '$CSP'"
[ "$BODY" = "<h1>hi</h1><script>1</script>" ] ||
  fail "render html: body must be byte-identical to the stored body, got: $BODY"
ok "GET .../artifacts/{id}/render on text/html: 200, exact Content-Type/Disposition/nosniff/CSP headers, byte-identical body"

api 201 POST "/api/projects/$AP/artifacts" \
  '{"name":"render-md","content_type":"text/markdown","body":"# hi\n"}'
RMD=$(jqb .id)
fetch "$BASE/api/projects/$AP/artifacts/$RMD/render"
[ "$STATUS" = "200" ] || fail "render markdown: expected 200, got $STATUS"
[ "$(hdr content-type)" = "text/markdown; charset=utf-8" ] ||
  fail "render markdown: content-type must be text/markdown; charset=utf-8, got '$(hdr content-type)'"
CSP=$(hdr content-security-policy)
[ "$CSP" = "$EXPECTED_CSP" ] || fail "render markdown: CSP must match the html route's, got '$CSP'"
ok "GET .../artifacts/{id}/render on text/markdown: same header set, content-type reflects the stored mime"

# a mismatched project/artifact pair is 404, not 403
api 404 GET "/api/projects/$AP2/artifacts/$RHTML/render"
[ "$(jqb .error.code)" = "not_found" ] || fail "render mismatch: error.code"
ok "GET /api/projects/{id}/artifacts/{aid}/render with an artifact belonging to a different project: 404 not_found"

api 404 GET "/api/projects/999999/artifacts/$RHTML/render"
[ "$(jqb .error.code)" = "not_found" ] || fail "render unknown project: error.code"
ok "GET .../artifacts/{aid}/render with an unknown project id: 404 not_found"

api 404 GET "/api/projects/$AP/artifacts/999999/render"
[ "$(jqb .error.code)" = "not_found" ] || fail "render unknown artifact: error.code"
ok "GET .../artifacts/{aid}/render with an unknown artifact id: 404 not_found"

# ---- delete ----

api 200 DELETE "/api/artifacts/$RMD"
[ "$(jqb .id)" = "$RMD" ] || fail "API delete: echoes the destroyed record"
[ "$(jqb .body)" != "null" ] || fail "API delete: the echo is the FULL record"
ok "DELETE /api/artifacts/{id}: 200, echoes the full destroyed record"

api 404 GET "/api/artifacts/$RMD"
[ "$(jqb .error.code)" = "not_found" ] || fail "API delete: artifact actually gone"
ok "DELETE /api/artifacts/{id}: a subsequent GET is 404 not_found"

api 404 DELETE /api/artifacts/999999
[ "$(jqb .error.code)" = "not_found" ] || fail "API delete unknown id: error.code"
ok "DELETE /api/artifacts/{id} unknown id: 404 not_found"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ================= --lan mode: the render headers must not drift =================
# Plain `guard`, unconditionally, is the whole design here (docs/artifacts.md):
# a body that is project content, not an execution input, so nothing about
# this route may depend on which serve mode started it. This is the pairing
# assertion the feature exists to keep true.

LAN_PORT=17790
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf -H "Host: 127.0.0.1:$LAN_PORT" "http://127.0.0.1:$LAN_PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf -H "Host: 127.0.0.1:$LAN_PORT" "http://127.0.0.1:$LAN_PORT/api/projects" >/dev/null ||
  fail "--lan server did not start (log: $(cat "$TMP/lan.log"))"

LAN_BASE="http://127.0.0.1:$LAN_PORT"

lan_api() { # lan_api <expected-status> <method> <path> [json-body]
  local expected=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/lanbody" -w '%{http_code}' -X "$method" -H "Host: 127.0.0.1:$LAN_PORT")
  case "$method" in
    POST | PUT | PATCH | DELETE)
      args+=(-H 'Content-Type: application/json' -d "${body:-{\}}")
      ;;
  esac
  STATUS=$(curl "${args[@]}" "$LAN_BASE$path")
  BODY=$(cat "$TMP/lanbody")
  [ "$STATUS" = "$expected" ] ||
    fail "--lan: expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
jqb() { jq -r "$1" <<<"$BODY"; }

lan_fetch() { # lan_fetch <path>
  STATUS=$(curl -s -o "$TMP/lanout" -D "$TMP/lanheaders" -w '%{http_code}' \
    -H "Host: 127.0.0.1:$LAN_PORT" "$LAN_BASE$1")
  BODY=$(cat "$TMP/lanout")
}
lan_hdr() {
  local name
  name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  tr -d '\r' < "$TMP/lanheaders" |
    awk -v n="$name:" 'tolower($0) ~ "^"n {sub(/^[^:]*:[ \t]*/, ""); print}'
}

# Both `serve` processes open the SAME throwaway MESA_DB in turn (the first
# was killed above before this one started), so the html render fixture from
# the default-mode run is still there to re-fetch.
lan_api 200 GET "/api/projects/$AP/artifacts"
[ "$(jqb 'map(select(.name == "render-html")) | length')" = "1" ] ||
  fail "--lan: the html render fixture must still exist in the shared db"

lan_fetch "/api/projects/$AP/artifacts/$RHTML/render"
[ "$STATUS" = "200" ] || fail "--lan render html: expected 200, got $STATUS"
LAN_CT=$(lan_hdr content-type)
LAN_CD=$(lan_hdr content-disposition)
LAN_NOSNIFF=$(lan_hdr x-content-type-options)
LAN_CSP=$(lan_hdr content-security-policy)

# The default-mode server was already killed above; compare against the
# EXPECTED_CSP constant and the literal values pinned by the earlier
# default-mode assertions on this same artifact, rather than re-fetching.
[ "$LAN_CT" = "text/html; charset=utf-8" ] ||
  fail "--lan render html: content-type differs from default mode, got '$LAN_CT'"
case "$LAN_CD" in
  inline*) ;;
  *) fail "--lan render html: content-disposition differs from default mode, got '$LAN_CD'" ;;
esac
[ "$LAN_NOSNIFF" = "nosniff" ] ||
  fail "--lan render html: x-content-type-options differs from default mode, got '$LAN_NOSNIFF'"
[ "$LAN_CSP" = "$EXPECTED_CSP" ] ||
  fail "--lan render html: CSP differs from default mode, got '$LAN_CSP'"
[ "$BODY" = "<h1>hi</h1><script>1</script>" ] ||
  fail "--lan render html: body differs from default mode, got: $BODY"
ok "--lan: GET .../artifacts/{id}/render answers with the IDENTICAL Content-Type/Disposition/nosniff/CSP header set and body as default mode"

# A DNS-rebinding-shaped Host is not refused on this route — plain `guard`
# under --lan does not carry the global Host allowlist, and this route is
# deliberately not given a stronger one (docs/artifacts.md's whole argument).
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.example" \
  "$LAN_BASE/api/projects/$AP/artifacts/$RHTML/render")
[ "$STATUS" = "200" ] ||
  fail "--lan: render must be reachable regardless of Host (plain guard, no stronger gate) — got $STATUS"
ok "--lan: the render route is reachable under a foreign Host too — the gate is unconditionally plain guard, by design"

echo "all $CHECKS checks passed"
