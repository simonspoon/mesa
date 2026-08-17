#!/usr/bin/env bash
# Files gate: exercises the Files tab's read routes against a live `mesa serve`
# over a throwaway MESA_DB and a throwaway project folder bound as
# `local_path` — with the inline image route (task 801) as the subject.
#
# Covers, in order:
#   1. the content GET's classification of the new fixtures — a real PNG is
#      `is_binary`, an `.svg` is TEXT with `language: "svg"`;
#   2. `GET /api/projects/{id}/files/raw?path=` — the extension allowlist that
#      IS the boundary: an image comes back with a real mime, byte-identical,
#      behind `nosniff` + an inline `Content-Disposition` + a
#      `default-src 'none'; sandbox` CSP, and everything else (html, markdown,
#      an extensionless file) is 422 `validation` rather than any content type
#      at all;
#   3. the traversal cases (`../`, an absolute path) and the missing `?path=`;
#   4. `GET .../files/download` still being a fixed `application/octet-stream`
#      + `attachment` — a regression guard, since raw is the route that added
#      real mime types to this surface;
#   5. `GET /api/projects/{id}/files/search?q=` (task 813) — hits grouped by
#      file over the SAME tree the browser lists (an excluded directory and a
#      binary are skipped server-side, not filtered by the client), the two
#      option toggles, a miss as a 200, and the `?q=` contract (missing, empty
#      or over-long is 422 `validation`);
#   6. `PATCH`/`DELETE /api/projects/{id}/files/entry` (task 877) — renaming
#      and deleting one entry of the tree: the echoed `FileTreeEntry` for a
#      file and a folder (whose contents stay readable under the new name), the
#      409 on a taken name, the 422s for an unusable name and for the project
#      root itself, the 404s for a traversal and a missing entry, a recursive
#      folder delete, the tree no longer listing a deleted entry *immediately*
#      (the cache-eviction assertion), and the 422 for a missing `?path=`;
#   7. both serve modes — raw and search are reads, reachable in default AND
#      `--lan`, while the content PATCH and both entry writes keep their
#      `require_agent_access` + Content-Type gates in both.
#
# The tree/content/create/write contract at large is exercised by the Rust
# unit tests in src/core/files.rs; this script is the HTTP-surface gate.
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

# ---- fixtures: a project folder bound as local_path ----
#
# Not a git repo — `local_path` is a plain folder pointer, and `--path` is what
# binds it (the root-commit auto-detect simply finds nothing here).

REPO="$TMP/repo"
mkdir -p "$REPO/sub"

# a real 1x1 PNG (the smallest valid one), written as bytes, not as text
printf '%s' \
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > "$REPO/logo.png"
[ -s "$REPO/logo.png" ] || fail "fixture: logo.png must be non-empty"

cat > "$REPO/sub/icon.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>
SVG

cat > "$REPO/README.md" <<'MD'
# Fixture

![](./logo.png)

![](./sub/icon.svg)
MD

cat > "$REPO/page.html" <<'HTML'
<!doctype html><title>not an image</title><p>hello
HTML

printf 'plain notes\n' > "$REPO/notes.md"
printf 'no extension here\n' > "$REPO/LICENSE"

# Search fixtures (task 813): one hit in a nested source file, one in an
# EXCLUDED directory, and one inside a binary — the last two must never come
# back, and neither can be told apart from the first by the query alone.
mkdir -p "$REPO/src" "$REPO/node_modules"
cat > "$REPO/src/main.rs" <<'RS'
fn main() {
    let needle = 1; // needle again
    let Needle = 2;
    let needles = 3;
}
RS
printf 'needle needle needle\n' > "$REPO/node_modules/dep.js"
printf 'needle inside a binary\n\0\n' > "$REPO/blob.dat"

# Rename/delete fixtures (task 877): an entry of each kind to rename, a name
# already taken to collide with, and an entry of each kind to destroy. None of
# them mention the search query above, so section 5's counts are unaffected.
printf 'content survives\n' > "$REPO/oldname.txt"
printf 'taken\n' > "$REPO/taken.txt"
mkdir -p "$REPO/oldfolder/nested"
printf 'still here\n' > "$REPO/oldfolder/nested/deep.txt"
printf 'bye\n' > "$REPO/doomed.txt"
mkdir -p "$REPO/doomedfolder/nested"
printf 'also bye\n' > "$REPO/doomedfolder/nested/b.txt"

STDOUT=$("$MESA" project create "Files project" --path "$REPO")
PROJ=$(jq -r .id <<<"$STDOUT")
[ "$(jq -r .local_path <<<"$STDOUT")" != "null" ] || fail "fixture: local_path must be bound"

# ---- server ----

PORT=17778
LAN_PORT=17779
BASE="http://127.0.0.1:$PORT"

start_server() { # start_server <pidvar-name> <port> [extra-args...]
  local var=$1 port=$2; shift 2
  "$MESA" serve --port "$port" "$@" >"$TMP/serve-$port.log" 2>&1 &
  local pid=$!
  printf -v "$var" '%s' "$pid"
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$port/api/projects" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -sf "http://127.0.0.1:$port/api/projects" >/dev/null ||
    fail "server on $port did not start (log: $(cat "$TMP/serve-$port.log"))"
}

start_server SERVER_PID "$PORT"

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
# STATUS is the code; use `hdr <name>` to read a header, case-insensitively
# and with the CRLF stripped.
fetch() {
  STATUS=$(curl -s -o "$TMP/out" -D "$TMP/headers" -w '%{http_code}' "$BASE$1")
  BODY=$(cat "$TMP/out")
}
hdr() {
  local name
  name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  tr -d '\r' < "$TMP/headers" |
    awk -v n="$name:" 'tolower($0) ~ "^"n {sub(/^[^:]*:[ \t]*/, ""); print}'
}

# =====================================================================
# 1. the content GET's view of the fixtures
# =====================================================================

api 200 GET "/api/projects/$PROJ/files/content?path=logo.png"
[ "$(jqb .is_binary)" = "true" ] || fail "content: a PNG must be is_binary ($BODY)"
[ "$(jqb .content)" = "" ] || fail "content: a binary file's content must be empty"
ok "GET .../files/content on a PNG: is_binary, empty content"

api 200 GET "/api/projects/$PROJ/files/content?path=sub/icon.svg"
[ "$(jqb .is_binary)" = "false" ] || fail "content: an SVG must be text, not binary"
[ "$(jqb .language)" = "svg" ] || fail "content: an SVG's language must be svg, got $(jqb .language)"
grep -q '<svg' <<<"$(jqb .content)" || fail "content: the SVG source must come back"
ok "GET .../files/content on an SVG: text, language=svg"

# =====================================================================
# 2. the raw route — the allowlist is the boundary
# =====================================================================

fetch "/api/projects/$PROJ/files/raw?path=logo.png"
[ "$STATUS" = "200" ] || fail "raw png: expected 200, got $STATUS ($BODY)"
[ "$(hdr content-type)" = "image/png" ] ||
  fail "raw png: content-type must be image/png, got '$(hdr content-type)'"
case "$(hdr content-disposition)" in
  inline*) ;;
  *) fail "raw png: content-disposition must start with inline, got '$(hdr content-disposition)'" ;;
esac
[ "$(hdr x-content-type-options)" = "nosniff" ] ||
  fail "raw png: x-content-type-options must be nosniff, got '$(hdr x-content-type-options)'"
CSP=$(hdr content-security-policy)
[ -n "$CSP" ] || fail "raw png: a content-security-policy header must be present"
grep -q "default-src 'none'" <<<"$CSP" || fail "raw png: CSP must be default-src 'none', got '$CSP'"
grep -q 'sandbox' <<<"$CSP" || fail "raw png: CSP must sandbox, got '$CSP'"
ok "GET .../files/raw on a PNG: 200, image/png, inline, nosniff + sandboxing CSP"

cmp -s "$TMP/out" "$REPO/logo.png" || fail "raw png: body must be byte-identical to the file on disk"
ok "GET .../files/raw on a PNG: body is byte-identical to the file on disk"

fetch "/api/projects/$PROJ/files/raw?path=sub/icon.svg"
[ "$STATUS" = "200" ] || fail "raw svg: expected 200, got $STATUS ($BODY)"
[ "$(hdr content-type)" = "image/svg+xml" ] ||
  fail "raw svg: content-type must be image/svg+xml, got '$(hdr content-type)'"
case "$(hdr content-disposition)" in
  inline*) ;;
  *) fail "raw svg: content-disposition must start with inline" ;;
esac
[ "$(hdr x-content-type-options)" = "nosniff" ] || fail "raw svg: nosniff"
CSP=$(hdr content-security-policy)
grep -q "default-src 'none'" <<<"$CSP" || fail "raw svg: CSP default-src 'none'"
grep -q 'sandbox' <<<"$CSP" || fail "raw svg: CSP sandbox"
cmp -s "$TMP/out" "$REPO/sub/icon.svg" || fail "raw svg: bytes verbatim"
ok "GET .../files/raw on an SVG: image/svg+xml behind the same three hardening headers"

# Everything not on the allowlist is refused OUTRIGHT — there is no
# `text/html`, no sniff, no octet-stream fallback on this route.
for BAD in page.html notes.md LICENSE; do
  api 422 GET "/api/projects/$PROJ/files/raw?path=$BAD"
  [ "$(jqb .error.code)" = "validation" ] ||
    fail "raw $BAD: error.code must be validation, got $(jqb .error.code)"
  ok "GET .../files/raw on $BAD: 422 validation (not an image extension)"
done

# =====================================================================
# 3. traversal + the missing query parameter
# =====================================================================

# A real image OUTSIDE the project root: the escape a traversal would win, so
# these two cases exercise `safe_path` itself rather than the allowlist.
cp "$REPO/logo.png" "$TMP/outside.png"

api 404 GET "/api/projects/$PROJ/files/raw?path=../outside.png"
[ "$(jqb .error.code)" = "not_found" ] || fail "raw traversal: error.code"
ok "GET .../files/raw?path=../outside.png (a real image above the root): 404 not_found"

api 404 GET "/api/projects/$PROJ/files/raw?path=$TMP/outside.png"
[ "$(jqb .error.code)" = "not_found" ] || fail "raw absolute path: error.code"
ok "GET .../files/raw with an absolute path to a real image: 404 not_found"

# A traversal at a NON-image extension is 404 too, not 422: `safe_path` runs
# BEFORE the allowlist, so this route never becomes an oracle that tells a
# caller "outside the repo" apart from "inside but not an image". This pins
# that ordering.
api 404 GET "/api/projects/$PROJ/files/raw?path=../../etc/passwd"
[ "$(jqb .error.code)" = "not_found" ] || fail "raw non-image traversal: error.code"
ok "GET .../files/raw?path=../../etc/passwd: 404 not_found (safe_path fires before the allowlist)"

api 404 GET "/api/projects/$PROJ/files/raw?path=/etc/passwd"
[ "$(jqb .error.code)" = "not_found" ] || fail "raw non-image absolute path: error.code"
ok "GET .../files/raw?path=/etc/passwd: 404 not_found (safe_path fires first)"

api 422 GET "/api/projects/$PROJ/files/raw"
[ "$(jqb .error.code)" = "validation" ] || fail "raw no ?path=: error.code"
ok "GET .../files/raw with no ?path=: 422 validation"

# =====================================================================
# 4. download is UNCHANGED — octet-stream + attachment
# =====================================================================

fetch "/api/projects/$PROJ/files/download?path=logo.png"
[ "$STATUS" = "200" ] || fail "download png: expected 200, got $STATUS"
[ "$(hdr content-type)" = "application/octet-stream" ] ||
  fail "download png: content-type must stay application/octet-stream, got '$(hdr content-type)'"
case "$(hdr content-disposition)" in
  attachment*) ;;
  *) fail "download png: content-disposition must start with attachment, got '$(hdr content-disposition)'" ;;
esac
cmp -s "$TMP/out" "$REPO/logo.png" || fail "download png: bytes verbatim"
ok "GET .../files/download on a PNG: still octet-stream + attachment (raw did not relax it)"

# =====================================================================
# 5. project search (task 813) — the same tree the browser lists
# =====================================================================

api 200 GET "/api/projects/$PROJ/files/search?q=needle"
[ "$(jqb '.files | length')" = "1" ] ||
  fail "search: expected hits in exactly one file, got $(jqb '.files | length') ($BODY)"
[ "$(jqb '.files[0].path')" = "src/main.rs" ] ||
  fail "search: the one file must be src/main.rs, got $(jqb '.files[0].path')"
[ "$(jqb .total_matches)" = "4" ] ||
  fail "search: case-insensitive by default, expected 4 matches, got $(jqb .total_matches)"
[ "$(jqb .truncated)" = "false" ] || fail "search: nothing here hits a cap"
[ "$(jqb '.files[0].language')" = "rust" ] || fail "search: language must come with the group"
[ "$(jqb '.files[0].matches[0].line')" = "2" ] ||
  fail "search: first hit is on line 2, got $(jqb '.files[0].matches[0].line')"
[ "$(jqb '.files[0].matches[0].text')" = "let needle = 1; // needle again" ] ||
  fail "search: the snippet drops leading indentation, got '$(jqb '.files[0].matches[0].text')'"
ok "GET .../files/search: hits grouped by file, node_modules and the binary absent"

# The excluded directory and the NUL-carrying file are the two that must never
# appear — asserted by name rather than only by the count above.
grep -q 'node_modules' <<<"$BODY" && fail "search: an EXCLUDED_DIRS file must never appear"
grep -q 'blob.dat' <<<"$BODY" && fail "search: a binary file must never be scanned"
ok "GET .../files/search: excluded and binary files are skipped, not filtered client-side"

api 200 GET "/api/projects/$PROJ/files/search?q=Needle&case=true"
[ "$(jqb .total_matches)" = "1" ] ||
  fail "search ?case=true: expected 1 match, got $(jqb .total_matches)"
[ "$(jqb '.files[0].matches[0].line')" = "3" ] || fail "search ?case=true: wrong line"
ok "GET .../files/search?case=true: matches case, and only case"

api 200 GET "/api/projects/$PROJ/files/search?q=needle&word=true"
[ "$(jqb .total_matches)" = "3" ] ||
  fail "search ?word=true: expected 3 whole-word matches, got $(jqb .total_matches)"
ok "GET .../files/search?word=true: whole word only (needles no longer counts)"

api 200 GET "/api/projects/$PROJ/files/search?q=nothing-matches-this"
[ "$(jqb '.files | length')" = "0" ] || fail "search: a miss must be an empty list"
[ "$(jqb .total_matches)" = "0" ] || fail "search: a miss must be 0 matches"
ok "GET .../files/search with no hits: 200 and an empty result, not an error"

api 422 GET "/api/projects/$PROJ/files/search"
[ "$(jqb .error.code)" = "validation" ] || fail "search no ?q=: error.code"
api 422 GET "/api/projects/$PROJ/files/search?q="
[ "$(jqb .error.code)" = "validation" ] || fail "search empty ?q=: error.code"
LONG=$(head -c 201 < /dev/zero | tr '\0' 'n')
api 422 GET "/api/projects/$PROJ/files/search?q=$LONG"
[ "$(jqb .error.code)" = "validation" ] || fail "search over-long ?q=: error.code"
ok "GET .../files/search with a missing, empty or over-long ?q=: 422 validation"

# =====================================================================
# 6. rename + delete one tree entry (task 877)
# =====================================================================

api 200 PATCH "/api/projects/$PROJ/files/entry" \
  '{"path":"oldname.txt","name":"newname.txt"}'
[ "$(jqb .name)" = "newname.txt" ] || fail "rename file: echoed name, got $(jqb .name)"
[ "$(jqb .path)" = "newname.txt" ] || fail "rename file: echoed path, got $(jqb .path)"
[ "$(jqb .is_dir)" = "false" ] || fail "rename file: is_dir must be false"
ok "PATCH .../files/entry on a file: 200 and the new FileTreeEntry"

api 200 GET "/api/projects/$PROJ/files/content?path=newname.txt"
[ "$(jqb .content)" = "content survives" ] ||
  fail "rename file: content must survive the rename, got '$(jqb .content)'"
api 404 GET "/api/projects/$PROJ/files/content?path=oldname.txt"
ok "rename file: readable under the new name, gone under the old one"

api 200 PATCH "/api/projects/$PROJ/files/entry" \
  '{"path":"oldfolder","name":"newfolder"}'
[ "$(jqb .name)" = "newfolder" ] || fail "rename folder: echoed name"
[ "$(jqb .path)" = "newfolder" ] || fail "rename folder: echoed path"
[ "$(jqb .is_dir)" = "true" ] || fail "rename folder: is_dir must be true"
ok "PATCH .../files/entry on a folder: 200 and the new FileTreeEntry"

# The whole subtree moved with the name — asserted through the tree listing and
# the content read, i.e. the routes the browser would use next.
api 200 GET "/api/projects/$PROJ/files?path=newfolder/nested"
[ "$(jqb '.tree | length')" = "1" ] || fail "rename folder: nested level must list one entry ($BODY)"
[ "$(jqb '.tree[0].path')" = "newfolder/nested/deep.txt" ] ||
  fail "rename folder: nested path must re-anchor, got $(jqb '.tree[0].path')"
api 200 GET "/api/projects/$PROJ/files/content?path=newfolder/nested/deep.txt"
[ "$(jqb .content)" = "still here" ] || fail "rename folder: nested content must survive"
ok "rename folder: its contents are still readable under the new name"

api 409 PATCH "/api/projects/$PROJ/files/entry" \
  '{"path":"newname.txt","name":"taken.txt"}'
[ "$(jqb .error.code)" = "conflict" ] || fail "rename onto a taken name: error.code"
api 200 GET "/api/projects/$PROJ/files/content?path=taken.txt"
[ "$(jqb .content)" = "taken" ] || fail "rename conflict: the existing file must be untouched"
ok "PATCH .../files/entry onto an existing name: 409 conflict, nothing overwritten"

# A new name that is a path would be a MOVE, which this route cannot express.
for BADNAME in 'sub/x.txt' '..' '.' '' 'a\\b'; do
  api 422 PATCH "/api/projects/$PROJ/files/entry" \
    "{\"path\":\"newname.txt\",\"name\":\"$BADNAME\"}"
  [ "$(jqb .error.code)" = "validation" ] || fail "rename name '$BADNAME': error.code"
done
ok "PATCH .../files/entry with a path-shaped, dotted or empty name: 422 validation"

# The project folder itself is not an entry of its own tree.
for ROOTPATH in '' '.'; do
  api 422 PATCH "/api/projects/$PROJ/files/entry" \
    "{\"path\":\"$ROOTPATH\",\"name\":\"renamed\"}"
  [ "$(jqb .error.code)" = "validation" ] || fail "rename root '$ROOTPATH': error.code"
done
[ -d "$REPO" ] || fail "rename root: the project folder must survive"
ok "PATCH .../files/entry naming the project root: 422 validation"

api 404 PATCH "/api/projects/$PROJ/files/entry" \
  '{"path":"../outside.png","name":"owned.png"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "rename traversal: error.code"
[ -f "$TMP/outside.png" ] || fail "rename traversal: the file above the root must be untouched"
api 404 PATCH "/api/projects/$PROJ/files/entry" '{"path":"nope.txt","name":"x.txt"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "rename missing source: error.code"
ok "PATCH .../files/entry for a traversal or a missing entry: 404 not_found"

api 200 DELETE "/api/projects/$PROJ/files/entry?path=doomed.txt"
[ "$(jqb .name)" = "doomed.txt" ] || fail "delete file: echoed name"
[ "$(jqb .path)" = "doomed.txt" ] || fail "delete file: echoed path"
[ "$(jqb .is_dir)" = "false" ] || fail "delete file: is_dir must be false"
[ ! -e "$REPO/doomed.txt" ] || fail "delete file: it must be gone from disk"
api 404 GET "/api/projects/$PROJ/files/content?path=doomed.txt"
ok "DELETE .../files/entry on a file: 200, the destroyed entry echoed, gone from disk"

# Warm the root level FIRST: the 5s tree cache is what the handler has to evict,
# so a stale entry here would still list the folder after it was destroyed.
api 200 GET "/api/projects/$PROJ/files"
jqb '.tree[].name' | grep -qx 'doomedfolder' || fail "delete folder: fixture must be listed first"

api 200 DELETE "/api/projects/$PROJ/files/entry?path=doomedfolder"
[ "$(jqb .name)" = "doomedfolder" ] || fail "delete folder: echoed name"
[ "$(jqb .is_dir)" = "true" ] || fail "delete folder: is_dir must be true"
[ ! -e "$REPO/doomedfolder" ] || fail "delete folder: a non-empty folder must be removed recursively"
ok "DELETE .../files/entry on a non-empty folder: 200 and a recursive removal"

api 200 GET "/api/projects/$PROJ/files"
jqb '.tree[].name' | grep -qx 'doomedfolder' &&
  fail "delete folder: the tree must not list it on the very next read (cache eviction)"
ok "DELETE .../files/entry evicts the tree cache: the next read no longer lists it"

api 422 DELETE "/api/projects/$PROJ/files/entry"
[ "$(jqb .error.code)" = "validation" ] || fail "delete no ?path=: error.code"
api 422 DELETE "/api/projects/$PROJ/files/entry?path="
[ "$(jqb .error.code)" = "validation" ] || fail "delete empty ?path=: error.code"
api 422 DELETE "/api/projects/$PROJ/files/entry?path=."
[ "$(jqb .error.code)" = "validation" ] || fail "delete the root: error.code"
[ -d "$REPO" ] || fail "delete root: the project folder must survive"
ok "DELETE .../files/entry with a missing, empty or root ?path=: 422 validation"

api 404 DELETE "/api/projects/$PROJ/files/entry?path=../outside.png"
[ "$(jqb .error.code)" = "not_found" ] || fail "delete traversal: error.code"
[ -f "$TMP/outside.png" ] || fail "delete traversal: the file above the root must be untouched"
api 404 DELETE "/api/projects/$PROJ/files/entry?path=nope.txt"
[ "$(jqb .error.code)" = "not_found" ] || fail "delete missing entry: error.code"
ok "DELETE .../files/entry for a traversal or a missing entry: 404 not_found"

# =====================================================================
# 7. both serve modes
# =====================================================================
#
# raw is a READ on the plain `guard`, so it is reachable in default mode and
# under `--lan`; the PATCH write keeps `require_agent_access` plus the
# Content-Type/CSRF gate in both. The pair is what must not drift apart.

check_modes() { # check_modes <label>
  local label=$1

  fetch "/api/projects/$PROJ/files/raw?path=logo.png"
  [ "$STATUS" = "200" ] || fail "$label: raw must be reachable, got $STATUS"
  [ "$(hdr content-type)" = "image/png" ] || fail "$label: raw content-type"
  ok "$label: GET .../files/raw is reachable (a read on the standard guard)"

  api 200 GET "/api/projects/$PROJ/files/search?q=needle"
  [ "$(jqb '.files | length')" = "1" ] || fail "$label: search must be reachable"
  ok "$label: GET .../files/search is reachable (a read on the standard guard)"

  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'path=notes.md&content=owned' \
    "$BASE/api/projects/$PROJ/files/content")
  [ "$status" = "415" ] ||
    fail "$label: PATCH without Content-Type: application/json must be 415, got $status"
  ok "$label: PATCH .../files/content without a JSON Content-Type is refused (415)"

  # ...and the write itself still works from a local page, so the gate above is
  # the Content-Type half firing, not the route being unreachable.
  api 200 PATCH "/api/projects/$PROJ/files/content" \
    '{"path":"notes.md","content":"plain notes\n"}'
  [ "$(jqb .path)" = "notes.md" ] || fail "$label: PATCH echo path"
  ok "$label: PATCH .../files/content with JSON from a local page succeeds"

  # The two entry writes (task 877) share that gate pair exactly — the pairing
  # is what must not drift apart, so both halves are asserted per mode.
  status=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'path=notes.md&name=owned.md' \
    "$BASE/api/projects/$PROJ/files/entry")
  [ "$status" = "415" ] ||
    fail "$label: PATCH .../files/entry without a JSON Content-Type must be 415, got $status"
  status=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    "$BASE/api/projects/$PROJ/files/entry?path=notes.md")
  [ "$status" = "415" ] ||
    fail "$label: DELETE .../files/entry without a JSON Content-Type must be 415, got $status"
  [ -f "$REPO/notes.md" ] || fail "$label: a refused entry write must never touch disk"
  ok "$label: PATCH/DELETE .../files/entry without a JSON Content-Type are refused (415)"

  # ...and both work from a local page, so the 415s above are the Content-Type
  # half firing rather than the routes being unreachable. A round-trip rename
  # and a create-then-delete leave the fixtures exactly as they were, so this
  # runs identically in either mode.
  api 200 PATCH "/api/projects/$PROJ/files/entry" \
    '{"path":"newname.txt","name":"gatename.txt"}'
  [ "$(jqb .path)" = "gatename.txt" ] || fail "$label: entry rename echo path"
  api 200 PATCH "/api/projects/$PROJ/files/entry" \
    '{"path":"gatename.txt","name":"newname.txt"}'
  ok "$label: PATCH .../files/entry with JSON from a local page succeeds"

  api 200 POST "/api/projects/$PROJ/files/content" '{"path":"gate-doomed.txt"}'
  api 200 DELETE "/api/projects/$PROJ/files/entry?path=gate-doomed.txt"
  [ "$(jqb .name)" = "gate-doomed.txt" ] || fail "$label: entry delete echo name"
  [ ! -e "$REPO/gate-doomed.txt" ] || fail "$label: entry delete must remove the file"
  ok "$label: DELETE .../files/entry with JSON from a local page succeeds"
}

check_modes "default mode"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

start_server LAN_PID "$LAN_PORT" --lan
BASE="http://127.0.0.1:$LAN_PORT"
check_modes "--lan"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

echo "all $CHECKS checks passed"
