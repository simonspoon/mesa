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
#   6. both serve modes — raw and search are reads, reachable in default AND
#      `--lan`, while the PATCH write keeps its `require_agent_access` +
#      Content-Type gate in both.
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
# 6. both serve modes
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
