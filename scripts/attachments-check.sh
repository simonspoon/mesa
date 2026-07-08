#!/usr/bin/env bash
# Attachments gate: exercises the attachment lifecycle end to end — create
# (add) -> list -> show -> fetch/download -> delete, plus the
# task-delete-cascades-attachments case — over both the CLI
# (`mesa attachment ...`) and the API (`/api/tasks/{id}/attachments`,
# `/api/attachments/{id}[/download]`), against a throwaway MESA_DB and
# MESA_ATTACHMENTS_DIR. Asserts JSON shapes, on-disk file contents, cascade
# cleanup, and exit/status codes.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
export MESA_ATTACHMENTS_DIR="$TMP/attachments"

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
    fail "expected exit $expected, got $CODE: $* (stderr: $STDERR)"
}

jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- fixtures: one project, one task ----

run 0 "$MESA" project create "Attachments project" --no-git
P=$(jqs .id)
run 0 "$MESA" task create --project "$P" --title "Task with files"
TASK=$(jqs .id)

# ================= CLI =================

# ---- add (create) ----
SRC="$TMP/notes.md"
printf 'hello world' > "$SRC"

run 0 "$MESA" attachment add "$TASK" "$SRC" --author simon
[ "$(jqs .task_id)" = "$TASK" ] || fail "CLI add: task_id"
[ "$(jqs .filename)" = "notes.md" ] || fail "CLI add: filename"
[ "$(jqs .content_type)" = "text/markdown" ] || fail "CLI add: content_type guessed"
[ "$(jqs .size_bytes)" = "11" ] || fail "CLI add: size_bytes"
[ "$(jqs .author)" = "simon" ] || fail "CLI add: author"
[ "$(jqs .created_at)" != "null" ] || fail "CLI add: created_at present"
A1=$(jqs .id)
ok "CLI attachment add: full object with author + guessed content_type"

# flag form: --task/--path
SRC2="$TMP/data.bin"
printf 'binary payload' > "$SRC2"
run 0 "$MESA" attachment add --task "$TASK" --path "$SRC2"
[ "$(jqs .author)" = "null" ] || fail "CLI add flag form: author null"
A2=$(jqs .id)
ok "CLI attachment add: flag form (--task/--path), no author"

# both positional and flag is a usage error
run 2 "$MESA" attachment add "$TASK" "$SRC" --task "$TASK"
[ "$(jqe .error.code)" = "usage" ] || fail "CLI add positional+flag: code=usage"
ok "CLI attachment add positional+flag: exit 2, code=usage"

# unknown task is not_found
run 1 "$MESA" attachment add 999999 "$SRC"
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI add unknown task: error.code"
ok "CLI attachment add unknown task: exit 1, code=not_found"

# missing source file is a validation error
run 1 "$MESA" attachment add "$TASK" "$TMP/does-not-exist"
[ "$(jqe .error.code)" = "validation" ] || fail "CLI add missing file: error.code"
ok "CLI attachment add missing source file: exit 1, code=validation"

# oversized file is a validation error (25 MiB cap)
BIG="$TMP/big.bin"
head -c $((25 * 1024 * 1024 + 1)) /dev/zero > "$BIG"
run 1 "$MESA" attachment add "$TASK" "$BIG"
[ "$(jqe .error.code)" = "validation" ] || fail "CLI add oversized: error.code"
ok "CLI attachment add oversized file: exit 1, code=validation"
rm -f "$BIG"

# ---- list ----
run 0 "$MESA" attachment list "$TASK"
[ "$(jqs type)" = "array" ] || fail "CLI list: bare array"
[ "$(jqs length)" = "2" ] || fail "CLI list: expected 2"
[ "$(jqs 'map(.id) == (sort_by(.id) | map(.id))')" = "true" ] || fail "CLI list: ordered by id"
ok "CLI attachment list: bare JSON array, ordered"

# unknown task is not_found
run 1 "$MESA" attachment list 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI list unknown task: error.code"
ok "CLI attachment list unknown task: exit 1, code=not_found"

# ---- show ----
run 0 "$MESA" attachment show "$A1"
[ "$(jqs .id)" = "$A1" ] || fail "CLI show: id"
[ "$(jqs .filename)" = "notes.md" ] || fail "CLI show: filename"
ok "CLI attachment show: full metadata JSON"

run 1 "$MESA" attachment show 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI show unknown id: error.code"
ok "CLI attachment show unknown id: exit 1, code=not_found"

# ---- fetch (download) ----
DEST="$TMP/fetched-notes.md"
run 0 "$MESA" attachment fetch "$A1" "$DEST"
[ "$(jqs .id)" = "$A1" ] || fail "CLI fetch: metadata echoed, not bytes"
[ "$(cat "$DEST")" = "hello world" ] || fail "CLI fetch: bytes written verbatim"
ok "CLI attachment fetch: writes bytes to dest, prints metadata JSON"

run 1 "$MESA" attachment fetch 999999 "$TMP/nope"
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI fetch unknown id: error.code"
ok "CLI attachment fetch unknown id: exit 1, code=not_found"

# ---- delete ----
run 0 "$MESA" attachment delete "$A2"
[ "$(jqs .id)" = "$A2" ] || fail "CLI delete: echoes destroyed record"
ok "CLI attachment delete: echoes the destroyed attachment"

run 0 "$MESA" attachment list "$TASK"
[ "$(jqs length)" = "1" ] || fail "CLI delete: only remaining attachment left"
ok "CLI attachment delete: removed from list"

run 1 "$MESA" attachment delete 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI delete unknown id: error.code"
ok "CLI attachment delete unknown id: exit 1, code=not_found"

# ---- task-delete cascade (files unlinked from disk, subtasks included) ----
run 0 "$MESA" task create --project "$P" --title "Cascade root"
CROOT=$(jqs .id)
run 0 "$MESA" task create --project "$P" --title "Cascade child" --parent "$CROOT"
CCHILD=$(jqs .id)

ROOT_SRC="$TMP/root.txt"
CHILD_SRC="$TMP/child.txt"
printf 'root bytes' > "$ROOT_SRC"
printf 'child bytes' > "$CHILD_SRC"

run 0 "$MESA" attachment add "$CROOT" "$ROOT_SRC"
ROOT_ATT=$(jqs .id)
run 0 "$MESA" attachment add "$CCHILD" "$CHILD_SRC"
CHILD_ATT=$(jqs .id)

ROOT_PATH="$MESA_ATTACHMENTS_DIR/$CROOT/$ROOT_ATT-root.txt"
CHILD_PATH="$MESA_ATTACHMENTS_DIR/$CCHILD/$CHILD_ATT-child.txt"
[ -f "$ROOT_PATH" ] || fail "cascade setup: root attachment file must exist before delete"
[ -f "$CHILD_PATH" ] || fail "cascade setup: child attachment file must exist before delete"

run 0 "$MESA" task delete "$CROOT"

[ -f "$ROOT_PATH" ] && fail "task delete cascade: root attachment file must be unlinked"
[ -f "$CHILD_PATH" ] && fail "task delete cascade: subtask attachment file must be unlinked"
run 1 "$MESA" attachment show "$ROOT_ATT"
[ "$(jqe .error.code)" = "not_found" ] || fail "cascade: root attachment row gone"
run 1 "$MESA" attachment show "$CHILD_ATT"
[ "$(jqe .error.code)" = "not_found" ] || fail "cascade: subtask attachment row gone"
ok "task delete cascades: attachment DB rows + on-disk files gone for task and subtask"

# ================= API =================

PORT=17774
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
  case "$method" in
    POST | PUT | PATCH | DELETE)
      args+=(-H 'Content-Type: application/json' -d "${body:-{\}}")
      ;;
  esac
  STATUS=$(curl "${args[@]}" "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
jqb() { jq -r "$1" <<<"$BODY"; }

CONTENT_B64=$(printf 'api hello world' | base64 | tr -d '\n')
api 201 POST "/api/tasks/$TASK/attachments" \
  "{\"filename\":\"api-notes.txt\",\"content_base64\":\"$CONTENT_B64\",\"author\":\"agent-1\"}"
[ "$(jqb .task_id)" = "$TASK" ] || fail "API create: task_id"
[ "$(jqb .filename)" = "api-notes.txt" ] || fail "API create: filename"
[ "$(jqb .content_type)" = "text/plain" ] || fail "API create: content_type guessed"
[ "$(jqb .author)" = "agent-1" ] || fail "API create: author"
AA1=$(jqb .id)
ok "POST /api/tasks/{id}/attachments: 201 + full Attachment JSON"

# unknown task -> 404 not_found
api 404 POST "/api/tasks/999999/attachments" \
  "{\"filename\":\"x.txt\",\"content_base64\":\"$CONTENT_B64\"}"
[ "$(jqb .error.code)" = "not_found" ] || fail "API create unknown task: error.code"
ok "POST .../attachments unknown task: 404 not_found"

# bad base64 -> 422 validation
api 422 POST "/api/tasks/$TASK/attachments" \
  '{"filename":"x.txt","content_base64":"not-valid-base64!!"}'
[ "$(jqb .error.code)" = "validation" ] || fail "API create bad base64: error.code"
ok "POST .../attachments bad base64: 422 validation"

# ---- list ---- (TASK still holds A1 from the CLI section above)
api 200 GET "/api/tasks/$TASK/attachments"
[ "$(jqb type)" = "array" ] || fail "API list: bare array"
[ "$(jqb length)" = "2" ] || fail "API list: expected 2"
ok "GET /api/tasks/{id}/attachments: bare array"

# ---- show ----
api 200 GET "/api/attachments/$AA1"
[ "$(jqb .id)" = "$AA1" ] || fail "API show: id"
ok "GET /api/attachments/{id}: full metadata JSON"

api 404 GET "/api/attachments/999999"
[ "$(jqb .error.code)" = "not_found" ] || fail "API show unknown id: error.code"
ok "GET /api/attachments/{id} unknown id: 404 not_found"

# ---- download ----
DL_STATUS=$(curl -s -o "$TMP/downloaded.txt" -D "$TMP/headers" -w '%{http_code}' \
  "http://127.0.0.1:$PORT/api/attachments/$AA1/download")
[ "$DL_STATUS" = "200" ] || fail "API download: expected 200, got $DL_STATUS"
[ "$(cat "$TMP/downloaded.txt")" = "api hello world" ] || fail "API download: bytes byte-identical"
grep -qi 'content-type: text/plain' "$TMP/headers" || fail "API download: content-type header"
grep -qi 'content-disposition: attachment; filename="api-notes.txt"' "$TMP/headers" ||
  fail "API download: content-disposition header"
ok "GET /api/attachments/{id}/download: raw bytes, correct headers"

api 404 GET "/api/attachments/999999/download"
[ "$(jqb .error.code)" = "not_found" ] || fail "API download unknown id: error.code"
ok "GET /api/attachments/{id}/download unknown id: 404 not_found"

# ---- delete ----
api 200 DELETE "/api/attachments/$AA1"
[ "$(jqb .id)" = "$AA1" ] || fail "API delete: echoes destroyed record"
ok "DELETE /api/attachments/{id}: 200, echoes destroyed record"

api 404 GET "/api/attachments/$AA1"
[ "$(jqb .error.code)" = "not_found" ] || fail "API delete: attachment actually gone"
ok "DELETE /api/attachments/{id}: subsequent GET is 404 not_found"

api 404 DELETE "/api/attachments/999999"
[ "$(jqb .error.code)" = "not_found" ] || fail "API delete unknown id: error.code"
ok "DELETE /api/attachments/{id} unknown id: 404 not_found"

# the repo-wide Content-Type gate still applies to this mutating route
NO_CT_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  "http://127.0.0.1:$PORT/api/attachments/999999")
[ "$NO_CT_STATUS" = "415" ] || fail "API delete without Content-Type: expected 415, got $NO_CT_STATUS"
ok "DELETE /api/attachments/{id} without Content-Type: 415 (gate still applies)"

# ---- API task-delete cascade ----
CONTENT_B64_2=$(printf 'cascade via api' | base64 | tr -d '\n')
api 201 POST "/api/tasks/$TASK/attachments" \
  "{\"filename\":\"cascade.txt\",\"content_base64\":\"$CONTENT_B64_2\"}"
CASCADE_ATT=$(jqb .id)
CASCADE_PATH="$MESA_ATTACHMENTS_DIR/$TASK/$CASCADE_ATT-cascade.txt"
[ -f "$CASCADE_PATH" ] || fail "API cascade setup: file must exist before delete"

api 200 DELETE "/api/tasks/$TASK"
[ -f "$CASCADE_PATH" ] && fail "API task delete cascade: attachment file must be unlinked"
api 404 GET "/api/attachments/$CASCADE_ATT"
[ "$(jqb .error.code)" = "not_found" ] || fail "API cascade: attachment row gone"
ok "DELETE /api/tasks/{id}: cascades attachment DB row + on-disk file"

echo "all $CHECKS checks passed"
