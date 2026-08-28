#!/usr/bin/env bash
# Auris gate (mesa task 944): exercises mesa's speech-to-text surface —
# `POST /api/live/transcribe`, the only user-facing route that reaches
# `src/core/listen.rs` (`mesa live listen` waits for text someone already
# typed or spoke through this route; it never calls `listen::transcribe`
# itself) — against a stub `auris` (`MESA_AURIS_BIN`), never a real
# recognizer. The API-side counterpart to `scripts/api-check.sh`
# (kokoro-rs's speak routes) for the input direction.
#
# Covers, in order:
#   1. a missing auris binary: 503 unavailable, not a panic, naming the
#      binary mesa tried to run (`MESA_AURIS_BIN` in the message);
#   2. the round-trip: the decoded recording reaches auris on stdin
#      byte-identical to what was sent, never as an argument, with argv
#      exactly `-q --format json`;
#   3. auris's own JSON-Lines contract — the LAST `transcript` line wins over
#      an earlier one, and a line with an unrecognised `type` is ignored
#      rather than aborting the read (auris's own extension mechanism,
#      `auris/README.md` "`--format json`");
#   3b. injection-proof: a transcript containing `$()`, backticks, quotes, a
#      literal `\n` escape and JSON-shaped text comes back byte-identical,
#      never expanded, executed, or re-parsed — the mirror, in the return
#      direction, of check 2's byte-identical stdin;
#   3c. stdout carries only the transcript: a successful run that also fills
#      well over a pipe buffer's worth of stderr must still answer 200 with
#      exactly the transcript text, none of that noise leaking in;
#   4. the "nonzero exit means no transcript" rule: a failing auris and a run
#      that never emits a `transcript` line are both 503 unavailable, never a
#      silent 200 with empty text;
#   5. the body-size contract: one byte over `LIVE_AUDIO_MAX` is 413
#      validation naming the limit, still JSON; invalid/empty/missing base64
#      is 422 validation; valid base64 that isn't actually a WAV is not
#      mesa's to reject — it reaches auris unexamined;
#   6. the security boundary in default mode — the Content-Type gate (415 on
#      no/form Content-Type) and the agent gate (403 on a foreign Origin or
#      Host, 200 from a local one) `require_agent_access` shares with
#      speak/start/stop;
#   7. under `--lan`, the route is **absent**, not gated: a well-formed
#      request never reaches the handler (no 200, no transcript, not even the
#      gate's JSON 403 — the embedded static-file fallback's plain 405
#      instead), and auris is never invoked; the Content-Type gate still
#      fires first, in middleware, before routing decides the route doesn't
#      exist.
#   8. `GET /api/live/transcribe` (mesa task 957): a missing recognizer is
#      200 `available: false`, never an error — an empty model list means
#      "mesa could not ask", not "auris says no"; a recognizer that answers
#      `--no-download --list-models` is `available: true`; the same
#      `require_agent_access` gate as the POST (403 foreign Origin/Host, 200
#      local) with no Content-Type check, since a GET carries no body;
#   9. under `--lan`, the GET is **absent** too, on the same route entry as
#      the POST — not merely refusing.
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

# Config is read at its REAL default location under $HOME (mesa task 955 gave
# it a `listen.model`), so a developer with a model saved in their own
# ~/.mesa/config.json would otherwise make the argv-equals-"-q --format json"
# assertions below fail spuriously. Point HOME at a throwaway dir under $TMP —
# `pwd -P` for the same reason config-check.sh resolves it that way: macOS's
# /tmp is a symlink, and a stub's logged cwd/paths must match what mesa
# resolves.
export HOME=$(mkdir -p "$TMP/home" && cd "$TMP/home" && pwd -P)

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

# `LIVE_AUDIO_MAX` is read out of the source rather than hardcoded, so the
# over-cap check tracks the real limit if it ever moves.
LIVE_AUDIO_MAX_EXPR=$(grep -Eo 'pub const LIVE_AUDIO_MAX: usize = [^;]+;' src/core/store.rs |
  sed -E 's/.*= (.*);/\1/')
[ -n "$LIVE_AUDIO_MAX_EXPR" ] || fail "could not read LIVE_AUDIO_MAX from src/core/store.rs"
LIVE_AUDIO_MAX=$((LIVE_AUDIO_MAX_EXPR))

# ---- stub auris ----
#
# A stub, not the real recognizer: this gate asserts the transcribe route's
# contract, not speech recognition. It logs its argv and its stdin verbatim
# (so the byte-identical/injection-proof assertions can read them back) and
# answers auris's real JSON-Lines `--format json` shape — a `segment` line,
# then a `transcript` line. `$STUB_DIR/auris-lines` lets a case override what
# it emits; `auris-fail` is the exit-1 "no transcript" failure mode. A
# `auris-noisy` marker makes a SUCCESSFUL run also write well over a pipe
# buffer's worth of stderr first — mesa must drain stderr without letting any
# of it leak into, prefix, or truncate the stdout transcript it reads back.
STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/auris" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$STUB_DIR/last-argv"
cat > "$STUB_DIR/last-stdin"
# \`listen::models()\` (\`GET /api/live/transcribe\`, mesa task 957) asks with
# this exact argv and a closed stdin; answer with one bounded model name,
# same shape auris itself uses. This branches ahead of the transcribe-only
# fail/lines fixtures below so listing a model is unaffected by them.
if [ "\$*" = "--no-download --list-models" ]; then
  [ -e "$STUB_DIR/auris-fail" ] && exit 1
  printf 'parakeet-tdt-0.6b-v2-int8\n'
  exit 0
fi
[ -e "$STUB_DIR/auris-fail" ] && { echo "stub auris is down" >&2; exit 1; }
[ -e "$STUB_DIR/auris-noisy" ] && { head -c 200000 /dev/zero | tr '\0' 'x' >&2; }
if [ -e "$STUB_DIR/auris-lines" ]; then
  cat "$STUB_DIR/auris-lines"
else
  printf '{"type":"segment","index":0,"text":"hello"}\n'
  printf '{"type":"transcript","text":"hello there"}\n'
fi
EOF
chmod +x "$STUB_DIR/auris"
export MESA_AURIS_BIN="$STUB_DIR/auris"

# ---- helpers (api-check.sh's) ----

# raw <method> <path> [curl args...] — no implied headers. Sets STATUS, BODY.
raw() {
  local method=$1 path=$2
  shift 2
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "$@" "$BASE$path")
  BODY=$(cat "$TMP/body")
}

# api <expected-status> <method> <path> [json-body] — the well-formed client.
api() {
  local expected=$1 method=$2 path=$3 body=${4:-}
  raw "$method" "$path" -H 'Content-Type: application/json' -d "${body:-{\}}"
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}

jqb() { jq -r "$1" <<<"$BODY"; }

origin_status() { # origin_status <method> <path> <origin> [json-body]
  local method=$1 path=$2 origin=$3 body=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" -H "Origin: $origin")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$BASE$path"
}

AUDIO_B64=$(printf 'AAAA' | base64 | tr -d '\n')
BODY_JSON=$(jq -n --arg a "$AUDIO_B64" '{audio_base64: $a}')

# =====================================================================
# 1. A missing auris binary
# =====================================================================
#
# MESA_AURIS_BIN is read by the child process at spawn time, so it has to be
# wrong BEFORE the server starts — changing the shell's export after a server
# is already running would never reach it.

PORT=17777
BASE="http://127.0.0.1:$PORT"

MESA_AURIS_BIN="$STUB_DIR/no-such-auris" "$MESA" serve --port "$PORT" >"$TMP/serve-nobin.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/projects" >/dev/null ||
  fail "server (missing auris binary) did not start (log: $(cat "$TMP/serve-nobin.log"))"

api 503 POST "/api/live/transcribe" "$BODY_JSON"
[ "$(jqb .error.code)" = "unavailable" ] ||
  fail "transcribe with a missing auris binary: error.code must be unavailable"
ok "POST /api/live/transcribe: a missing auris binary is 503 unavailable"

raw GET "/api/live/transcribe"
[ "$STATUS" = "200" ] ||
  fail "GET /api/live/transcribe with a missing auris binary: expected 200, got $STATUS"
[ "$(jqb .available)" = "false" ] ||
  fail "GET /api/live/transcribe with a missing auris binary: available must be false, not an error — an empty model list means mesa could not ask"
ok "GET /api/live/transcribe: a missing auris binary is 200 available:false, never an error"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# =====================================================================
# 2-6: the real server, stubbed auris in place
# =====================================================================

"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/projects" >/dev/null ||
  fail "server did not start (log: $(cat "$TMP/serve.log"))"

# ---- 2. round-trip: a real recording, byte-identical on the stub's stdin ----
head -c 4096 /dev/urandom >"$TMP/audio.raw"
AUDIO_B64=$(base64 <"$TMP/audio.raw" | tr -d '\n')
TRANSCRIBE_BODY=$(jq -n --arg a "$AUDIO_B64" '{audio_base64: $a}')
api 200 POST "/api/live/transcribe" "$TRANSCRIBE_BODY"
[ "$(jqb .text)" = "hello there" ] ||
  fail "transcribe round-trip: expected the stub's transcript, got $(jqb .text)"
cmp -s "$STUB_DIR/last-stdin" "$TMP/audio.raw" ||
  fail "transcribe: the decoded audio must reach auris on stdin, byte-identical to what was sent"
[ "$(cat "$STUB_DIR/last-argv")" = "-q --format json" ] ||
  fail "transcribe: argv must be exactly -q --format json (got $(cat "$STUB_DIR/last-argv"))"
ok "POST /api/live/transcribe: 200 with the stub's transcript; audio reaches auris on stdin byte-identical, never as an argument; argv is -q --format json"

# ---- 8a. GET /api/live/transcribe: available when the stub lists a model ----
raw GET "/api/live/transcribe"
[ "$STATUS" = "200" ] || fail "GET /api/live/transcribe: expected 200, got $STATUS"
[ "$(jqb .available)" = "true" ] ||
  fail "GET /api/live/transcribe: available must be true when the recognizer lists a model"
[ "$(cat "$STUB_DIR/last-argv")" = "--no-download --list-models" ] ||
  fail "GET /api/live/transcribe: must ask auris via --no-download --list-models (got $(cat "$STUB_DIR/last-argv"))"
ok "GET /api/live/transcribe: 200 available:true when the recognizer lists a model, asked via --no-download --list-models"

# ---- 3. last transcript line wins; an unrecognised type is ignored ----
cat >"$STUB_DIR/auris-lines" <<'JSONL'
{"type":"segment","index":0,"text":"first pass"}
{"type":"transcript","text":"draft one"}
{"type":"something-new","text":"a field mesa does not know about"}
{"type":"transcript","text":"final corrected text"}
JSONL
api 200 POST "/api/live/transcribe" "$TRANSCRIBE_BODY"
[ "$(jqb .text)" = "final corrected text" ] ||
  fail "transcribe: must keep the LAST transcript line, not the first (got $(jqb .text))"
rm -f "$STUB_DIR/auris-lines"
ok "transcribe: the last \`transcript\` line wins over an earlier one, and an unrecognised \`type\` is ignored rather than aborting the read — auris's own extension mechanism"

# ---- 3b. injection-proof: a hostile transcript comes back literally ----
#
# The mirror of the round-trip above: that one proves the recording reaches
# auris on stdin byte-identical; this proves a hostile transcript auris hands
# BACK reaches the HTTP caller byte-identical too — nothing expanded,
# executed, or re-parsed anywhere on the way through JSON. Built with
# `jq -n --arg` so the hostile text lands in the stub's JSONL line as a
# properly-escaped JSON string, the same way `scripts-check.sh`'s and
# `api-check.sh`'s own "echoes literally" cases are built.
PWNED_MARKER="$STUB_DIR/pwned-transcript"
HOSTILE_TEXT="\$(touch $PWNED_MARKER); \`id\`; a 'quote' and a \"dquote\"; back\\nslash-n; {\"error\":{\"code\":\"validation\"}}"
jq -nc --arg t "$HOSTILE_TEXT" '{type:"transcript", text:$t}' >"$STUB_DIR/auris-lines"
api 200 POST "/api/live/transcribe" "$TRANSCRIBE_BODY"
printf '%s' "$HOSTILE_TEXT" >"$TMP/expected-hostile"
printf '%s' "$(jqb .text)" >"$TMP/actual-hostile"
cmp -s "$TMP/expected-hostile" "$TMP/actual-hostile" ||
  fail "transcribe: a hostile transcript must come back byte-identical, got $(jqb .text)"
[ ! -e "$PWNED_MARKER" ] || fail "transcribe: a hostile transcript was evaluated by a shell"
rm -f "$STUB_DIR/auris-lines"
ok "INJECTION PROOF: a transcript with \$(), backticks, quotes, a literal \\n escape and JSON-shaped text comes back byte-identical, never expanded, executed, or re-parsed"

# ---- 3c. stdout carries only the transcript: stderr noise must not leak in ----
#
# Section 4 below proves stderr is drained on the FAILURE path without
# hanging the request; this is the success-path mirror — a run that writes
# well over a pipe buffer's worth of stderr and still succeeds must yield a
# clean 200 with exactly the transcript text, none of that noise prefixed,
# appended, or interleaved into it.
touch "$STUB_DIR/auris-noisy"
api 200 POST "/api/live/transcribe" "$TRANSCRIBE_BODY"
rm -f "$STUB_DIR/auris-noisy"
[ "$(jqb .text)" = "hello there" ] ||
  fail "transcribe: stderr noise on a successful run must not leak into the transcript, got $(jqb .text)"
ok "transcribe: stdout carries only the transcript — a noisy stderr on a successful run neither hangs the request nor leaks into the text"

# ---- 4. unavailable: a nonzero exit, and a run with no transcript line ----
touch "$STUB_DIR/auris-fail"
api 503 POST "/api/live/transcribe" "$TRANSCRIBE_BODY"
rm -f "$STUB_DIR/auris-fail"
[ "$(jqb .error.code)" = "unavailable" ] || fail "transcribe: a failing auris must be 503 unavailable"

cat >"$STUB_DIR/auris-lines" <<'JSONL'
{"type":"segment","index":0,"text":"only a segment, nothing final"}
{"type":"something-new"}
JSONL
api 503 POST "/api/live/transcribe" "$TRANSCRIBE_BODY"
[ "$(jqb .error.code)" = "unavailable" ] ||
  fail "transcribe: a run with no transcript line must be 503 unavailable, never a 200 with empty text"
rm -f "$STUB_DIR/auris-lines"
ok "transcribe: unavailable for a failing auris and for a run that never emits a transcript line — never a silent empty success"

# ---- 5a. over-cap body: 413, JSON, naming the limit ----
OVER_RAW=$((LIVE_AUDIO_MAX + 1))
head -c "$OVER_RAW" /dev/zero | base64 | tr -d '\n' >"$TMP/over.b64"
{
  printf '{"audio_base64":"'
  cat "$TMP/over.b64"
  printf '"}'
} >"$TMP/over.json"
STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -H 'Content-Type: application/json' \
  --data-binary @"$TMP/over.json" "$BASE/api/live/transcribe")
BODY=$(cat "$TMP/body")
[ "$STATUS" = "413" ] || fail "transcribe over the $LIVE_AUDIO_MAX-byte cap: expected 413, got $STATUS"
[ "$(jqb .error.code)" = "validation" ] || fail "transcribe over the cap: error.code"
grep -q "$LIVE_AUDIO_MAX" <<<"$BODY" || fail "transcribe over the cap: the message must name the limit"
jq -e . <<<"$BODY" >/dev/null ||
  fail "transcribe over the cap: the 413 must still be JSON — the whole reason the DefaultBodyLimit layer was raised above the cap"
ok "transcribe: a body one byte over the ${LIVE_AUDIO_MAX}-byte cap is 413 validation, still JSON, naming the limit"

# ---- 5b. non-audio / malformed bodies: 422, never 413 ----
api 422 POST "/api/live/transcribe" '{"audio_base64":"not valid base64!!!"}'
[ "$(jqb .error.code)" = "validation" ] || fail "transcribe with invalid base64: error.code"
api 422 POST "/api/live/transcribe" '{"audio_base64":""}'
[ "$(jqb .error.code)" = "validation" ] || fail "transcribe with an empty audio_base64: error.code"
api 422 POST "/api/live/transcribe" '{}'
[ "$(jqb .error.code)" = "validation" ] || fail "transcribe with no audio_base64 field at all: error.code"
ok "transcribe: invalid base64, an empty recording, and a missing field are all 422 validation"

# Valid base64 that is not actually a WAV: mesa never inspects the bytes
# itself (`listen::transcribe` hands them to auris verbatim), so with the
# stub this is indistinguishable from the round-trip above. With a real
# auris this is exit-1 "no transcript" — the `unavailable` path just proven.
NOT_WAV_B64=$(printf 'this is not a wav file' | base64 | tr -d '\n')
api 200 POST "/api/live/transcribe" "$(jq -n --arg a "$NOT_WAV_B64" '{audio_base64: $a}')"
[ "$(jqb .text)" = "hello there" ] ||
  fail "transcribe with non-WAV (but valid) base64: mesa must still just hand it to auris"
ok "transcribe: valid base64 that is not a WAV is not mesa's to reject — it reaches auris unexamined (a real auris would answer unavailable here)"

# ---- 6. both halves of the boundary, default mode ----
raw POST "/api/live/transcribe"
[ "$STATUS" = "415" ] || fail "transcribe without Content-Type: expected 415, got $STATUS"
raw POST "/api/live/transcribe" -d 'audio_base64=form+post'
[ "$STATUS" = "415" ] || fail "form-encoded transcribe: expected 415, got $STATUS"
[ "$(origin_status POST "/api/live/transcribe" 'https://evil.example' "$TRANSCRIBE_BODY")" = "403" ] ||
  fail "transcribe with a foreign Origin must be 403 (the agent gate)"
raw POST "/api/live/transcribe" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d "$TRANSCRIBE_BODY"
[ "$STATUS" = "403" ] || fail "transcribe with a bogus Host: expected 403, got $STATUS"
[ "$(origin_status POST "/api/live/transcribe" 'http://localhost:'"$PORT" "$TRANSCRIBE_BODY")" = "200" ] ||
  fail "transcribe from a local Origin must reach the handler"
ok "transcribe: Content-Type gate (415 with no/form Content-Type) and agent gate (403 foreign Origin/Host, 200 local) — the same pair speak/start/stop carry"

# ---- 8b. GET /api/live/transcribe: the agent gate, default mode ----
#
# A GET carries no body, so there is no Content-Type check to assert here —
# just require_agent_access's Origin/Host halves.
[ "$(origin_status GET "/api/live/transcribe" 'https://evil.example')" = "403" ] ||
  fail "GET /api/live/transcribe with a foreign Origin must be 403 (the agent gate)"
raw GET "/api/live/transcribe" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "GET /api/live/transcribe with a bogus Host: expected 403, got $STATUS"
[ "$(origin_status GET "/api/live/transcribe" 'http://localhost:'"$PORT")" = "200" ] ||
  fail "GET /api/live/transcribe from a local Origin must reach the handler"
ok "GET /api/live/transcribe: the agent gate (403 foreign Origin/Host, 200 local) — same gate as the POST, no Content-Type check"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# =====================================================================
# 7. --lan: the route is ABSENT, not gated
# =====================================================================
#
# `transcribe_router` never registers this route under --lan, so a
# well-formed request falls through to the embedded-static-file fallback
# (`axum_embed::ServeEmbed`, GET/HEAD only), which answers a plain-text 405 —
# nothing like the gate's `{"error":{"code":"validation",...}}` 403. That 405
# is an artifact of the SPA fallback, not a status mesa chose, so this is
# written against the property (the handler was never reached, and the stub
# was never invoked) rather than against the number.

LAN_PORT=17780
LAN_BASE="http://127.0.0.1:$LAN_PORT"
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$LAN_BASE/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$LAN_BASE/api/projects" >/dev/null ||
  fail "LAN server did not start (log: $(cat "$TMP/lan.log"))"

rm -f "$STUB_DIR/last-argv"
STATUS=$(curl -s -o "$TMP/lan-body" -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "$TRANSCRIBE_BODY" "$LAN_BASE/api/live/transcribe")
LAN_BODY=$(cat "$TMP/lan-body")
[ "$STATUS" != "200" ] || fail "--lan: /api/live/transcribe must not be reachable at all, got 200"
grep -q '"text"' <<<"$LAN_BODY" && fail "--lan: a transcript came back — the route must not exist here"
[ "$(jq -e . <<<"$LAN_BODY" 2>/dev/null | jq -r '.error.code // empty' 2>/dev/null)" != "validation" ] ||
  fail "--lan: a validation error shape means the route was gated, not absent"
[ ! -e "$STUB_DIR/last-argv" ] ||
  fail "--lan: auris must never be invoked — the route is absent, not merely refused"
ok "--lan: POST /api/live/transcribe never reaches the handler (not 200, no transcript, not the gate's JSON 403) and auris is never run"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -d 'audio_base64=form+post' "$LAN_BASE/api/live/transcribe")
[ "$STATUS" = "415" ] ||
  fail "--lan: the Content-Type gate must still fire on this path (it runs in middleware before routing), got $STATUS"
ok "--lan: the Content-Type gate still rejects a form-encoded POST to the absent transcribe route — the middleware runs before routing decides the route does not exist"

# ---- 9. --lan: GET /api/live/transcribe is absent too ----
#
# Same route entry as the POST (`transcribe_router`), so it inherits the same
# absence rather than needing its own --lan handling. Unlike the POST, a GET
# to an unknown path is exactly what the SPA fallback DOES serve (200
# index.html, per `transcribe_router`'s own doc comment) — so the property to
# assert here is not the status code but that no availability answer came
# back: the response is the app shell, not JSON with an `available` key.
STATUS=$(curl -s -o "$TMP/lan-get-body" -w '%{http_code}' "$LAN_BASE/api/live/transcribe")
LAN_GET_BODY=$(cat "$TMP/lan-get-body")
grep -q '"available"' <<<"$LAN_GET_BODY" &&
  fail "--lan: an availability answer came back — the route must not exist here"
grep -qi '<html' <<<"$LAN_GET_BODY" ||
  fail "--lan: GET /api/live/transcribe must fall through to the SPA shell, not a JSON answer"
ok "--lan: GET /api/live/transcribe never reaches the handler either — falls through to the SPA fallback like any other unknown GET path, absent exactly like the POST"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

echo "all $CHECKS checks passed"
