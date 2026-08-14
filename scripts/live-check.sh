#!/usr/bin/env bash
# Mesa-live gate (mesa task 855): exercises the spoken-conversation surface end
# to end — the `mesa live` CLI group and the `/api/live*` routes — against a
# throwaway MESA_DB, a stub `claude` (MESA_CLAUDE_BIN) and a stub `kokoro-rs`
# (MESA_KOKORO_BIN). No real agent and no real synthesiser are ever started.
#
# Covers, in order:
#   1. the CLI with nothing running — `status` prints null and exits 0, every
#      other verb is `not_found` naming `mesa live start`, and the usage errors
#      (exit 2) around them, including `--quiet` refused on `turns`;
#   2. the CLI happy path on a --no-agent session: start -> say -> navigate ->
#      turns -> sidebars -> stop -> status, plus the `--quiet` key sets compared
#      with jq (a turn drops `text`; a session drops nothing);
#   3. every `Validation` rule reachable from a surface — the route shape, the
#      8192-char text bound, a mesa turn with neither text nor action, an
#      unknown project — and the `conflict` that enforces one live session;
#   4. the spawn: project resolution by id AND by name, the `live-agent`
#      template's argv, the session name and working folder, the prompt
#      arriving as ONE argument (a hostile project name is data, never syntax),
#      and a failed spawn ending the session it opened rather than stranding it;
#   5. the API twin over a live `serve` — the `{session:null,turns:[]}` empty
#      state, start/stop, the 409, the utterance and route writes, the `?after=`
#      cursor and the idempotent played stamp;
#   6. the loop the two surfaces make together: an utterance posted over HTTP is
#      handed to `mesa live listen` exactly once, never twice, and a quiet wait
#      prints `null` and exits 0;
#   7. GET /api/live/turns/{id}/speak — the audio contract, the patched
#      streaming WAV sizes, the header arriving mid-render, no Content-Length,
#      `validation` for a pure-navigate turn and `unavailable` for a failing
#      synthesiser;
#   8. the security boundary in default mode — the Host allowlist, the
#      Content-Type gate on every live write, and the agent gate on the three
#      routes that carry it (POST/DELETE /api/live, speak) contrasted with the
#      plain guard on their neighbours;
#   9. the same boundary under `--lan`: Host skipped, Content-Type still
#      firing, and the agent-gated routes keeping their stronger gate.
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
# This gate asserts the BUILT-IN `live-agent` template, so the developer's own
# ~/.mesa/config.json must not leak in (config-check.sh owns the configured
# half, under a throwaway HOME).
export MESA_CONFIG_FILE="$TMP/no-such-config.json"

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

jqs() { jq -r "$1" <<<"$STDOUT"; } # query last stdout
jqe() { jq -r "$1" <<<"$STDERR"; } # query last stderr

# ---- stub claude (`live start` spawns an agent through agents::spawn_bg) ----
#
# A stub, not the real CLI: this gate asserts the argv the `live-agent`
# template produces and the fact that the prompt is one argument, neither of
# which needs a real Claude Code session. It records the last spawn's argument
# count, its leading flags, its final argument (the prompt) and its working
# directory, so the assertions below can read them back. A `fail` marker turns
# it into a spawn that cannot start — the case that must end the session again.
STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/claude" <<EOF
#!/usr/bin/env bash
[ -e "$STUB_DIR/fail" ] && { echo "stub claude is down" >&2; exit 1; }
case "\$1" in
  --bg)
    printf '%s\n' "\$#" > "$STUB_DIR/last-argc"
    # The flags before the prompt, one per line: a name carrying shell syntax
    # must come back as exactly one line for the injection assertion to mean
    # anything.
    printf '%s\n' "\${@:1:6}" > "$STUB_DIR/last-flags"
    PROMPT=""
    for a in "\$@"; do PROMPT=\$a; done
    printf '%s' "\$PROMPT" > "$STUB_DIR/last-prompt"
    pwd > "$STUB_DIR/last-cwd"
    echo "backgrounded · deadbeef (idle — send a prompt to start)"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"

# ---- stub kokoro-rs (the speak route) ----
#
# Byte-for-byte the synthesiser stub `api-check.sh` writes, for the same
# reasons: it logs its stdin, and it emits the exact *streaming* WAV header
# `kokoro-rs -o -` writes — both sizes 0xFFFFFFFF — so the response proves mesa
# patched them. A `slow` marker inserts a pause between the header and the
# samples, which is how the gate proves the header reaches the client while the
# render is still running.
cat > "$STUB_DIR/kokoro-rs" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$STUB_DIR/last-argv"
cat > "$STUB_DIR/last-stdin"
[ -e "$STUB_DIR/tts-fail" ] && { echo "stub kokoro is down" >&2; exit 1; }
# RIFF ffffffff WAVE fmt (PCM/mono/24k) data ffffffff, then 8 bytes of "audio".
printf 'RIFF\xff\xff\xff\xffWAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\xc0\x5d\x00\x00\x80\xbb\x00\x00\x02\x00\x10\x00data\xff\xff\xff\xff'
if [ -e "$STUB_DIR/slow" ]; then
  sleep 3
  head -c 262144 /dev/zero
else
  printf '\x01\x02\x03\x04\x05\x06\x07\x08'
fi
EOF
chmod +x "$STUB_DIR/kokoro-rs"
export MESA_KOKORO_BIN="$STUB_DIR/kokoro-rs"

# ---- fixtures ----
#
# `--no-git` throughout: a scripted fixture repo would produce a root commit
# that collides with other gates' fixtures under the DB-unique root_commit
# binding (see scripts/cli-check.sh).
mkdir -p "$TMP/work"
PROJ=$("$MESA" project create "Live gate project" --no-git | jq -r .id)
# Read the folder back rather than assuming it: `project update --path` stores
# the CANONICAL path, and on macOS $TMPDIR lives under a /var -> /private/var
# symlink, so the stored value is what the spawn's cwd must equal.
WORKDIR=$("$MESA" project update "$PROJ" --path "$TMP/work" | jq -r .local_path)

# =====================================================================
# 1. The CLI with nobody talking to mesa
# =====================================================================

run 0 "$MESA" live status
[ "$STDOUT" = "null" ] || fail "live status with no session: expected null, got $STDOUT"
run 0 "$MESA" live show
[ "$STDOUT" = "null" ] || fail "live show (alias): expected null"
run 0 "$MESA" live get
[ "$STDOUT" = "null" ] || fail "live get (alias): expected null"
ok "live status/show/get with no session: null, exit 0 — an answer, not a failure"

for verb in stop turns listen; do
  run 1 "$MESA" live "$verb"
  [ "$(jqe .error.code)" = "not_found" ] || fail "live $verb with no session: error.code"
  grep -q 'mesa live start' <<<"$STDERR" ||
    fail "live $verb with no session: the message must name \`mesa live start\`"
done
run 1 "$MESA" live say "into the void"
[ "$(jqe .error.code)" = "not_found" ] || fail "live say with no session: error.code"
run 1 "$MESA" live navigate '#/inbox'
[ "$(jqe .error.code)" = "not_found" ] || fail "live navigate with no session: error.code"
run 1 "$MESA" live sidebars collapse
[ "$(jqe .error.code)" = "not_found" ] || fail "live sidebars with no session: error.code"
ok "every other live verb with no session: exit 1 not_found, hinting at \`live start\`"

# ---- usage errors (exit 2), and the one --quiet exclusion ----

run 2 "$MESA" live turns --quiet
[ -z "$STDOUT" ] || fail "live turns --quiet: stdout must be empty on a usage error"
[ "$(jqe .error.code)" = "usage" ] || fail "live turns --quiet: error.code"
ok "live turns --quiet: unknown argument, exit 2, empty stdout (the --quiet contract)"

run 2 "$MESA" live listen --wait not-a-number
[ "$(jqe .error.code)" = "usage" ] || fail "live listen --wait <junk>: error.code"
run 2 "$MESA" live start "Live gate project" --project "$PROJ"
[ "$(jqe .error.code)" = "usage" ] || fail "live start with both project forms: error.code"
run 2 "$MESA" live say
[ "$(jqe .error.code)" = "usage" ] || fail "live say with no text: error.code"
run 2 "$MESA" live navigate
[ "$(jqe .error.code)" = "usage" ] || fail "live navigate with no route: error.code"
run 2 "$MESA" live sidebars
[ "$(jqe .error.code)" = "usage" ] || fail "live sidebars with no state: error.code"
run 2 "$MESA" live sidebars sideways
[ "$(jqe .error.code)" = "usage" ] ||
  fail "live sidebars <not collapse|expand>: a closed vocabulary, refused by clap"
ok "usage errors are exit 2: bad --wait, both project forms, a missing required arg"

# =====================================================================
# 2. The CLI happy path (start -> say -> navigate -> turns -> sidebars -> stop)
# =====================================================================
#
# `--no-agent` throughout this section: the loop is what is under test here,
# and the spawn has a section of its own below.

run 0 "$MESA" live start --no-agent
S1=$(jqs .id)
[ "$(jqs .status)" = "live" ] || fail "live start: status must be live"
[ "$(jqs .project_id)" = "null" ] || fail "live start: an unscoped session has no project"
[ "$(jqs .agent_id)" = "null" ] || fail "live start --no-agent: agent_id must stay null"
[ "$(jqs .route)" = "null" ] || fail "live start: route starts null"
[ "$(jqs .ended_at)" = "null" ] || fail "live start: ended_at starts null"
[ "$(jqs .started_at)" != "null" ] || fail "live start: started_at must be stamped"
ok "live start --no-agent: exit 0, a live session with no agent bound"

run 0 "$MESA" live status
[ "$(jqs .id)" = "$S1" ] || fail "live status: must be the session just started"
ok "live status during a conversation: the live session"

run 0 "$MESA" live say Three tasks are in progress right now.
SAY_ID=$(jqs .id)
[ "$(jqs .session_id)" = "$S1" ] || fail "live say: session_id"
[ "$(jqs .role)" = "mesa" ] || fail "live say: role must be mesa"
[ "$(jqs .text)" = "Three tasks are in progress right now." ] ||
  fail "live say: the trailing words are joined into the spoken text"
[ "$(jqs .action)" = "null" ] || fail "live say: a plain reply carries no action"
[ "$(jqs .target)" = "null" ] || fail "live say: a plain reply carries no target"
[ "$(jqs .played_at)" = "null" ] || fail "live say: played_at is the page's stamp, not the CLI's"
ok "live say: a mesa turn, unquoted words joined, no action"

run 0 "$MESA" live navigate '#/projects/3' --say "Opening that project."
NAV_ID=$(jqs .id)
[ "$(jqs .action)" = "navigate" ] || fail "live navigate: action"
[ "$(jqs .target)" = "#/projects/3" ] || fail "live navigate: target"
[ "$(jqs .text)" = "Opening that project." ] || fail "live navigate --say: spoken text"
run 0 "$MESA" live navigate '#/inbox'
PURE_NAV_ID=$(jqs .id)
[ "$(jqs .text)" = "" ] || fail "live navigate with no --say: a pure action turn says nothing"
[ "$(jqs .action)" = "navigate" ] || fail "live navigate with no --say: action"
ok "live navigate: a navigate turn with and without spoken text"

run 0 "$MESA" live turns
[ "$(jqs type)" = "array" ] || fail "live turns: bare array"
[ "$(jqs 'map(.id) | join(",")')" = "$SAY_ID,$NAV_ID,$PURE_NAV_ID" ] ||
  fail "live turns: oldest first, every turn"
run 0 "$MESA" live turns --after "$SAY_ID"
[ "$(jqs 'map(.id) | join(",")')" = "$NAV_ID,$PURE_NAV_ID" ] ||
  fail "live turns --after: an exclusive id cursor"
run 0 "$MESA" live turns --limit 1
[ "$(jqs length)" = "1" ] || fail "live turns --limit: must bound the page"
run 0 "$MESA" live turns --after "$PURE_NAV_ID"
[ "$(jqs length)" = "0" ] || fail "live turns past the end: an empty array, not an error"
ok "live turns: bare array oldest first, --after cursor, --limit, empty past the end"

# ---- the sidebar verbs (mesa task 859) ----
#
# The second page action: it changes what the person is *looking at*, like
# navigate, and like navigate it may narrate itself or move in silence. What it
# must never do is carry a route — that is the other verb.

run 0 "$MESA" live sidebars collapse --say "Making some room."
[ "$(jqs .action)" = "collapse-sidebars" ] || fail "live sidebars collapse: action"
[ "$(jqs .target)" = "null" ] || fail "live sidebars collapse: a sidebar turn carries no target"
[ "$(jqs .text)" = "Making some room." ] || fail "live sidebars --say: spoken text"
[ "$(jqs .role)" = "mesa" ] || fail "live sidebars: role must be mesa"
run 0 "$MESA" live sidebars expand
[ "$(jqs .action)" = "expand-sidebars" ] || fail "live sidebars expand: action"
[ "$(jqs .text)" = "" ] || fail "live sidebars with no --say: a pure action turn says nothing"
ok "live sidebars collapse|expand: a targetless action turn, with and without spoken text"

run 0 "$MESA" live sidebars collapse --quiet
[ "$(jqs 'has("text")')" = "false" ] || fail "live sidebars --quiet: text must be dropped"
[ "$(jqs .action)" = "collapse-sidebars" ] ||
  fail "live sidebars --quiet: the action is bounded, so it must survive"
ok "live sidebars --quiet: the same projection every live turn gets"

# ---- --quiet key sets (jq, never byte-for-byte) ----
#
# The same record read twice: `--quiet` writes the turn, then `live turns`
# reads that same row back in full, so a difference can only be the projection.

run 0 "$MESA" live say --quiet Working on it.
printf '%s' "$STDOUT" >"$TMP/turn-quiet.json"
QT_ID=$(jqs .id)
[ "$(jqs 'has("text")')" = "false" ] || fail "live say --quiet: text must be dropped"
[ "$(jqs .id)" = "$QT_ID" ] || fail "live say --quiet: id must survive"
run 0 "$MESA" live turns --after "$PURE_NAV_ID"
printf '%s' "$(jq ".[] | select(.id == $QT_ID)" <<<"$STDOUT")" >"$TMP/turn-full.json"
[ "$(jq -r .text "$TMP/turn-full.json")" = "Working on it." ] ||
  fail "live turns: the full record must still carry the spoken text"
jq -e --slurpfile q "$TMP/turn-quiet.json" 'del(.text) == $q[0]' "$TMP/turn-full.json" >/dev/null ||
  fail "live say --quiet: must be the full turn minus \`text\` and nothing else"
ok "live turn --quiet: the full record minus \`text\`, every other key present and equal"

run 0 "$MESA" live status --quiet
printf '%s' "$STDOUT" >"$TMP/session-quiet.json"
run 0 "$MESA" live status
printf '%s' "$STDOUT" >"$TMP/session-full.json"
jq -e --slurpfile q "$TMP/session-quiet.json" '. == $q[0]' "$TMP/session-full.json" >/dev/null ||
  fail "live status --quiet: a session has no unbounded field, so it passes through unchanged"
ok "live session --quiet: identical to the default output (nothing to drop)"

run 0 "$MESA" live listen --quiet --wait 0
[ "$STDOUT" = "null" ] || fail "live listen --quiet with nothing said: null"
ok "live listen --quiet: still null when there is nothing to hear"

# ---- stop, and what it leaves behind ----

run 0 "$MESA" live stop
[ "$(jqs .id)" = "$S1" ] || fail "live stop: must echo the session it ended"
[ "$(jqs .status)" = "ended" ] || fail "live stop: status must be ended"
ENDED_AT=$(jqs .ended_at)
[ "$ENDED_AT" != "null" ] || fail "live stop: ended_at must be stamped"
run 0 "$MESA" live status
[ "$STDOUT" = "null" ] || fail "live status after stop: nobody is talking, so null"
ok "live stop: the ended session with its ended_at stamp; status goes back to null"

# An ended session is not the current one, so every verb is `not_found` again —
# including a second stop. (`Store::end_live_session` is idempotent, but there
# has to BE a session to end.)
run 1 "$MESA" live stop
[ "$(jqe .error.code)" = "not_found" ] || fail "second live stop: error.code"
run 1 "$MESA" live say "after the end"
[ "$(jqe .error.code)" = "not_found" ] || fail "live say after stop: error.code"
ok "after stop: stop/say are not_found again — an ended session is not the current one"

# =====================================================================
# 3. Validation rules and the single-live-session conflict
# =====================================================================

run 0 "$MESA" live start --no-agent
S2=$(jqs .id)

run 1 "$MESA" live start --no-agent
[ "$(jqe .error.code)" = "conflict" ] || fail "second live start: error.code must be conflict"
grep -q "$S2" <<<"$STDERR" || fail "second live start: the message must name the live session"
run 0 "$MESA" live status
[ "$(jqs .id)" = "$S2" ] || fail "a refused start must leave the running session alone"
ok "live start while one is running: exit 1 conflict naming the live session"

# The route rule, shared by `navigate --target` and POST /api/live/route.
run 1 "$MESA" live navigate 'projects/3'
[ "$(jqe .error.code)" = "validation" ] || fail "navigate to a non-hash route: error.code"
run 1 "$MESA" live navigate '/projects/3'
[ "$(jqe .error.code)" = "validation" ] || fail "navigate to an absolute path: error.code"
run 1 "$MESA" live navigate '#projects'
[ "$(jqe .error.code)" = "validation" ] || fail "navigate to '#projects' (no slash): error.code"
run 1 "$MESA" live navigate ''
[ "$(jqe .error.code)" = "validation" ] || fail "navigate to an empty route: error.code"
run 1 "$MESA" live navigate "#/$(printf 'x%.0s' $(seq 1 210))"
[ "$(jqe .error.code)" = "validation" ] || fail "navigate to a 200+ char route: error.code"
run 0 "$MESA" live navigate "#/$(printf 'x%.0s' $(seq 1 197))"
[ "$(jqs .target)" = "#/$(printf 'x%.0s' $(seq 1 197))" ] ||
  fail "a 199-char route must be accepted (the bound is 200, inclusive)"
ok "route rule: must be a non-empty \`#/…\` under 200 chars, else validation"

# A mesa turn must say something or do something. `say ""` is the reachable
# shape of "neither": clap accepts the empty argument, `Store` refuses the turn.
run 1 "$MESA" live say ""
[ "$(jqe .error.code)" = "validation" ] || fail "live say \"\": error.code"
run 1 "$MESA" live say "   "
[ "$(jqe .error.code)" = "validation" ] ||
  fail "live say with only whitespace: text is trimmed, so this is validation too"
ok "a mesa turn with neither text nor an action: validation (a navigate turn is how you say nothing)"

# The spoken text is bounded — a runaway body would wedge the synthesiser.
LONG=$(printf 'x%.0s' $(seq 1 8193))
run 1 "$MESA" live say "$LONG"
[ "$(jqe .error.code)" = "validation" ] || fail "8193-char say: error.code"
grep -q '8192' <<<"$STDERR" || fail "the text bound must name itself in the message"
run 0 "$MESA" live say "$(printf 'x%.0s' $(seq 1 8192))"
[ "$(jqs '.text | length')" = "8192" ] || fail "an 8192-char say must be accepted (inclusive bound)"
ok "turn text is capped at 8192 chars: 8192 accepted, 8193 validation"

run 0 "$MESA" live stop >/dev/null

# An unknown project is validation (the `assign_inbox_item` shape), not
# not_found — and it must leave no session behind.
run 1 "$MESA" live start --project 999999 --no-agent
[ "$(jqe .error.code)" = "validation" ] || fail "live start with an unknown project id: error.code"
run 1 "$MESA" live start --project "No such project" --no-agent
[ "$(jqe .error.code)" = "not_found" ] ||
  fail "live start with an unknown project NAME: the resolver's not_found"
run 0 "$MESA" live status
[ "$STDOUT" = "null" ] || fail "a refused start must not leave a session behind"
ok "live start: an unknown project id is validation, an unknown name is not_found, neither starts a session"

# =====================================================================
# 4. The spawn: project resolution, the live-agent argv, and a failed spawn
# =====================================================================

# By NAME (the standard resolver: case-insensitive exact match).
run 0 "$MESA" live start "live gate project"
S3=$(jqs .id)
[ "$(jqs .project_id)" = "$PROJ" ] || fail "live start <name>: must resolve the project by name"
[ "$(jqs .agent_id)" = "deadbeef" ] ||
  fail "live start: the spawn receipt must be bound to the session (got $(jqs .agent_id))"
ok "live start <PROJECT>: resolves a project by name and binds the spawn receipt"

# The argv the built-in `live-agent` template produces:
#   {bin} --bg --agent {agent} --name {name} -- {prompt}
[ "$(cat "$STUB_DIR/last-argc")" = "7" ] ||
  fail "live spawn: expected 7 arguments, got $(cat "$STUB_DIR/last-argc")"
EXPECTED_FLAGS="--bg
--agent
swe
--name
Live gate project: live $S3
--"
[ "$(cat "$STUB_DIR/last-flags")" = "$EXPECTED_FLAGS" ] ||
  fail "live spawn argv: expected
$EXPECTED_FLAGS
got
$(cat "$STUB_DIR/last-flags")"
# The prompt is ONE argument, carrying the instruction block and the session id.
grep -q 'You are the voice of mesa' "$STUB_DIR/last-prompt" ||
  fail "live spawn: the prompt argument must be core::live's instruction block"
grep -q "session $S3" "$STUB_DIR/last-prompt" ||
  fail "live spawn: the prompt must name the session it drives"
grep -q 'mesa live listen' "$STUB_DIR/last-prompt" ||
  fail "live spawn: the prompt must state the loop's own command spellings"
[ "$(cat "$STUB_DIR/last-cwd")" = "$WORKDIR" ] ||
  fail "live spawn: must run in the project's local_path (got $(cat "$STUB_DIR/last-cwd"))"
ok "live spawn: the built-in live-agent argv, the session name, the prompt as one argument, the project's folder"

run 0 "$MESA" live stop >/dev/null

# By ID, and a project with no local_path: the folder degrades to $HOME rather
# than refusing to start (a conversation needs no checkout).
NOPATH=$("$MESA" project create "Live gate pathless" --no-git | jq -r .id)
run 0 "$MESA" live start --project "$NOPATH"
S4=$(jqs .id)
[ "$(jqs .project_id)" = "$NOPATH" ] || fail "live start --project <id>: project_id"
[ "$(cat "$STUB_DIR/last-cwd")" = "$HOME" ] ||
  fail "live spawn with no local_path: must fall back to \$HOME (got $(cat "$STUB_DIR/last-cwd"))"
run 0 "$MESA" live stop >/dev/null
ok "live start --project <id>: resolves by id; a pathless project runs the agent in \$HOME"

# An unscoped session names itself `mesa live <id>` and also runs in $HOME.
run 0 "$MESA" live start
S5=$(jqs .id)
head -5 "$STUB_DIR/last-flags" | tail -1 >"$TMP/name"
[ "$(cat "$TMP/name")" = "mesa live $S5" ] ||
  fail "an unscoped live session must be named 'mesa live <id>' (got $(cat "$TMP/name"))"
run 0 "$MESA" live stop >/dev/null
ok "an unscoped live start: the session name is \`mesa live <id>\`"

# Untrusted input: a project name is data. It reaches the spawn as ONE argv
# entry, so shell syntax inside it is a string, never something a shell parses.
HOSTILE_NAME='$(touch '"$TMP"'/pwned); rm -rf / #'
HOSTILE=$("$MESA" project create "$HOSTILE_NAME" --no-git | jq -r .id)
run 0 "$MESA" live start --project "$HOSTILE"
HS=$(jqs .id)
head -5 "$STUB_DIR/last-flags" | tail -1 >"$TMP/name"
[ "$(cat "$TMP/name")" = "$HOSTILE_NAME: live $HS" ] ||
  fail "a hostile project name must arrive verbatim as one argument (got $(cat "$TMP/name"))"
[ ! -e "$TMP/pwned" ] || fail "a hostile project name was evaluated by a shell"
run 0 "$MESA" live stop >/dev/null
ok "live spawn: a hostile project name is one argv entry, never syntax"

# A spawn that cannot start must END the session it just opened: a live session
# nothing is listening to can never answer, and would `conflict` every retry.
touch "$STUB_DIR/fail"
run 1 "$MESA" live start
[ "$(jqe .error.code)" = "unavailable" ] ||
  fail "a failed spawn: error.code must be unavailable (something outside mesa)"
rm -f "$STUB_DIR/fail"
run 0 "$MESA" live status
[ "$STDOUT" = "null" ] || fail "a failed spawn must leave NO live session behind"
run 0 "$MESA" live start --no-agent
[ "$(jqs .status)" = "live" ] || fail "after a failed spawn, the obvious retry must work"
run 0 "$MESA" live stop >/dev/null
ok "a failed spawn: exit 1 unavailable, the session is ended again, the retry is not a conflict"

# =====================================================================
# 5. The API twin over a live `serve`
# =====================================================================

PORT=17781
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
raw() {
  local method=$1 path=$2
  shift 2
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "$@" "$BASE$path")
  BODY=$(cat "$TMP/body")
}

# api <expected-status> <method> <path> [json-body] — the well-formed client.
api() {
  local expected=$1 method=$2 path=$3 body=${4:-}
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

# ---- the empty state ----
api 200 GET "/api/live"
[ "$(jqb .session)" = "null" ] || fail "GET /api/live idle: session must be null"
[ "$(jqb '.turns | length')" = "0" ] || fail "GET /api/live idle: turns must be []"
[ "$(jqb '.turns | type')" = "array" ] || fail "GET /api/live idle: turns must be an array"
ok "GET /api/live with nothing running: 200 {session:null, turns:[]} — an idle page is normal"

# Every write acts on THE current session, so with none they are not_found.
api 404 POST "/api/live/utterance" '{"text":"anyone there?"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "utterance with no session: error.code"
grep -q 'POST /api/live' <<<"$BODY" || fail "utterance with no session: the hint must name the route"
api 404 POST "/api/live/route" '{"route":"#/inbox"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "route with no session: error.code"
api 404 DELETE "/api/live"
[ "$(jqb .error.code)" = "not_found" ] || fail "DELETE with no session: error.code"
ok "the live writes with no session: 404 not_found naming POST /api/live"

# ---- start ----
api 422 POST "/api/live" '{"project_id":999999}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST /api/live unknown project: error.code"
api 200 GET "/api/live"
[ "$(jqb .session)" = "null" ] || fail "a refused start must leave no session"
ok "POST /api/live with an unknown project_id: 422 validation, no session opened"

api 201 POST "/api/live" "{\"project_id\":$PROJ}"
AS=$(jqb .id)
[ "$(jqb .status)" = "live" ] || fail "POST /api/live: status"
[ "$(jqb .project_id)" = "$PROJ" ] || fail "POST /api/live: project_id"
[ "$(jqb .agent_id)" = "deadbeef" ] || fail "POST /api/live: the spawn receipt must be bound"
[ "$(cat "$STUB_DIR/last-cwd")" = "$WORKDIR" ] ||
  fail "POST /api/live: the agent must be spawned in the project's folder"
head -5 "$STUB_DIR/last-flags" | tail -1 >"$TMP/name"
[ "$(cat "$TMP/name")" = "Live gate project: live $AS" ] ||
  fail "POST /api/live: the session name must be the CLI's (got $(cat "$TMP/name"))"
grep -q "session $AS" "$STUB_DIR/last-prompt" ||
  fail "POST /api/live: the same core::live prompt, naming this session"
ok "POST /api/live: 201, the session + spawn receipt, and the CLI's folder/name/prompt"

api 409 POST "/api/live" '{}'
[ "$(jqb .error.code)" = "conflict" ] || fail "second POST /api/live: error.code"
grep -q "$AS" <<<"$BODY" || fail "second POST /api/live: must name the live session"
ok "POST /api/live while one is running: 409 conflict naming it"

# The CLI sees the same session — one store, two surfaces.
run 0 "$MESA" live status
[ "$(jqs .id)" = "$AS" ] || fail "the CLI must see the session the API started"
ok "one live session across both surfaces: the CLI sees the API's session"

# ---- utterance ----
api 201 POST "/api/live/utterance" '{"text":"open the board please"}'
U1=$(jqb .id)
[ "$(jqb .role)" = "user" ] || fail "utterance: role must be user"
[ "$(jqb .session_id)" = "$AS" ] || fail "utterance: session_id"
[ "$(jqb .text)" = "open the board please" ] || fail "utterance: text"
[ "$(jqb .action)" = "null" ] || fail "utterance: a user turn carries no action"
[ "$(jqb .delivered_at)" = "null" ] || fail "utterance: undelivered until an agent listens"
ok "POST /api/live/utterance: 201, an undelivered user turn"

api 422 POST "/api/live/utterance" '{"text":""}'
[ "$(jqb .error.code)" = "validation" ] || fail "empty utterance: error.code"
api 422 POST "/api/live/utterance" '{"text":"   "}'
[ "$(jqb .error.code)" = "validation" ] || fail "whitespace utterance: error.code"
api 422 POST "/api/live/utterance" '{}'
[ "$(jqb .error.code)" = "validation" ] || fail "utterance with no text field: error.code"
LONGJSON=$(jq -n --arg t "$LONG" '{text:$t}')
api 422 POST "/api/live/utterance" "$LONGJSON"
[ "$(jqb .error.code)" = "validation" ] || fail "8193-char utterance: error.code"
ok "POST /api/live/utterance: empty/blank/missing/over-long text is 422 validation"

# ---- route ----
api 200 POST "/api/live/route" '{"route":"#/projects/7/files"}'
[ "$(jqb .route)" = "#/projects/7/files" ] || fail "POST /api/live/route: must record the route"
[ "$(jqb .id)" = "$AS" ] || fail "POST /api/live/route: answers the session"
api 422 POST "/api/live/route" '{"route":"/projects/7"}'
[ "$(jqb .error.code)" = "validation" ] || fail "a non-hash route: error.code"
api 422 POST "/api/live/route" '{"route":""}'
[ "$(jqb .error.code)" = "validation" ] || fail "an empty route: error.code"
api 200 GET "/api/live"
[ "$(jqb .session.route)" = "#/projects/7/files" ] ||
  fail "a refused route must leave the recorded one alone"
ok "POST /api/live/route: records a hash route, refuses anything else (422)"

# ---- the page's poll: session + turns, and the ?after= cursor ----
"$MESA" live say "Opening the board." >/dev/null
"$MESA" live navigate '#/projects/3' --say "Here it is." >/dev/null
api 200 GET "/api/live"
[ "$(jqb .session.id)" = "$AS" ] || fail "GET /api/live: the session rides with the turns"
[ "$(jqb '.turns | map(.id) | length')" = "3" ] ||
  fail "GET /api/live: every turn so far (the utterance and both replies)"
LAST=$(jqb '.turns | last | .id')
SPEAK_TURN=$(jqb '.turns | map(select(.role == "mesa" and .text != "")) | first | .id')
api 200 GET "/api/live?after=$U1"
[ "$(jqb '.turns | map(select(.id <= '"$U1"')) | length')" = "0" ] ||
  fail "GET /api/live?after=: the cursor is exclusive"
api 200 GET "/api/live?after=$LAST"
[ "$(jqb '.turns | length')" = "0" ] || fail "GET /api/live at the head: an empty turn list"
ok "GET /api/live: session + turns in one poll, ?after= as an exclusive cursor"

# ---- the played stamp ----
api 200 POST "/api/live/turns/$SPEAK_TURN/played"
FIRST_PLAYED=$(jqb .played_at)
[ "$FIRST_PLAYED" != "null" ] || fail "played: must stamp played_at"
sleep 1
api 200 POST "/api/live/turns/$SPEAK_TURN/played"
[ "$(jqb .played_at)" = "$FIRST_PLAYED" ] ||
  fail "played: a second stamp must not move the first (was $FIRST_PLAYED, now $(jqb .played_at))"
api 404 POST "/api/live/turns/999999/played"
[ "$(jqb .error.code)" = "not_found" ] || fail "played on an unknown turn: error.code"
ok "POST /api/live/turns/{id}/played: idempotent — stamped once, never moved, 404 on an unknown turn"

# =====================================================================
# 6. The loop: an utterance is handed out exactly once
# =====================================================================
#
# The page posts over HTTP; the agent pulls over the CLI, which opens its own
# Store beside the server's. `next_user_turn` is one UPDATE … RETURNING, so two
# listeners can never be handed the same utterance.

run 0 "$MESA" live listen --wait 5
[ "$(jqs .id)" = "$U1" ] || fail "live listen: must hand over the oldest undelivered utterance"
[ "$(jqs .role)" = "user" ] || fail "live listen: role"
[ "$(jqs .delivered_at)" != "null" ] || fail "live listen: the turn must come back stamped delivered"
ok "live listen: the API's utterance reaches the CLI, stamped delivered"

run 0 "$MESA" live listen --wait 1
[ "$STDOUT" = "null" ] || fail "live listen: a delivered utterance must never be handed out twice"
ok "live listen: never the same utterance twice (delivery is the stamp)"

run 0 "$MESA" live listen --wait 1
[ "$STDOUT" = "null" ] || fail "live listen with nothing said: expected null"
[ "$CODE" = "0" ] || fail "live listen on timeout must exit 0 — a quiet minute is data"
ok "live listen on timeout: null, exit 0"

# Two listeners, one utterance: exactly one of them may hear it.
"$MESA" live listen --wait 6 >"$TMP/listen-a.json" 2>/dev/null &
LA=$!
"$MESA" live listen --wait 6 >"$TMP/listen-b.json" 2>/dev/null &
LB=$!
sleep 1
api 201 POST "/api/live/utterance" '{"text":"exactly once"}'
RACE=$(jqb .id)
wait "$LA"; wait "$LB"
HEARD=$(cat "$TMP/listen-a.json" "$TMP/listen-b.json" | jq -s "map(select(.id == $RACE)) | length")
[ "$HEARD" = "1" ] ||
  fail "two concurrent listeners heard the utterance $HEARD times (must be exactly 1)"
ok "two concurrent listeners, one utterance: heard exactly once"

# A session ended from the web UI ends the wait early rather than leaving the
# agent listening to a finished conversation.
"$MESA" live listen --wait 60 >"$TMP/listen-end.json" 2>/dev/null &
LE=$!
sleep 1
api 200 DELETE "/api/live"
[ "$(jqb .status)" = "ended" ] || fail "DELETE /api/live: status must be ended"
wait "$LE"
[ "$(cat "$TMP/listen-end.json")" = "null" ] ||
  fail "live listen must return null when the session ends under it"
ok "DELETE /api/live: 200 the ended session, and a waiting \`live listen\` returns null early"

api 404 DELETE "/api/live"
[ "$(jqb .error.code)" = "not_found" ] || fail "second DELETE /api/live: error.code"
api 200 GET "/api/live"
[ "$(jqb .session)" = "null" ] || fail "after DELETE: back to the idle state"
ok "DELETE /api/live twice: the second is 404 not_found, and the page is idle again"

# =====================================================================
# 7. GET /api/live/turns/{id}/speak — the audio contract
# =====================================================================
#
# The same route shape as the inbox's speak (api-check.sh section 5b): an
# external synthesiser, a streamed body, and `unavailable` for a failure
# outside mesa. What is its own here is the empty-text case — a mesa turn may
# carry an action instead of words, and asking to speak one is validation.

speak() { # speak <path> [curl args...] -> STATUS, $TMP/audio, $TMP/headers
  local path=$1
  shift
  STATUS=$(curl -s -o "$TMP/audio" -D "$TMP/headers" -w '%{http_code}' "$@" "$BASE$path")
}

# A fresh session whose turns carry a hostile body, so the injection assertion
# has something to read back.
api 201 POST "/api/live" '{}'
SS=$(jqb .id)
HOSTILE_TEXT='$(touch '"$TMP"'/spoken-pwned); rm -rf / # spoken'
SPOKEN=$("$MESA" live say "$HOSTILE_TEXT" | jq -r .id)
SILENT=$("$MESA" live navigate '#/inbox' | jq -r .id)

speak "/api/live/turns/$SPOKEN/speak"
[ "$STATUS" = "200" ] || fail "speak: expected 200, got $STATUS ($(cat "$TMP/audio"))"
grep -qi '^content-type: audio/wav' "$TMP/headers" || fail "speak: Content-Type must be audio/wav"
grep -qi '^x-content-type-options: nosniff' "$TMP/headers" || fail "speak: nosniff missing"
grep -qi '^content-length:' "$TMP/headers" &&
  fail "speak: a streamed body must not declare a Content-Length"
ok "GET /api/live/turns/{id}/speak: 200 audio/wav + nosniff, chunked (no Content-Length)"

# The stub emits a 44-byte streaming header + 8 bytes of audio with BOTH sizes
# 0xFFFFFFFF. The real length is unknown when the header goes out, so mesa
# replaces the placeholders with the open-ended 0x7FFF0000 (+ 36 header bytes
# for RIFF); the samples must arrive untouched.
[ "$(wc -c <"$TMP/audio" | tr -d ' ')" = "52" ] || fail "speak: audio bytes not passed through"
HEXED=$(od -An -tx1 -v "$TMP/audio" | tr -d ' \n')
[ "${HEXED:8:8}" = "2400ff7f" ] || fail "speak: RIFF size not patched (got ${HEXED:8:8})"
[ "${HEXED:80:8}" = "0000ff7f" ] || fail "speak: data size not patched (got ${HEXED:80:8})"
[ "${HEXED:88}" = "0102030405060708" ] || fail "speak: audio payload altered"
ok "speak: the streaming 0xFFFFFFFF WAV sizes are patched, the samples are untouched"

# The spoken text is the turn's, verbatim, on stdin — never a shell string and
# never argv. With nothing configured the argv is the fixed flags, which is
# also the assertion that an unconfigured voice adds no `-v`.
[ "$(cat "$STUB_DIR/last-stdin")" = "$HOSTILE_TEXT" ] ||
  fail "speak: the turn's text must reach the synthesiser verbatim on stdin"
[ ! -e "$TMP/spoken-pwned" ] || fail "speak: a hostile turn body was evaluated by a shell"
[ "$(cat "$STUB_DIR/last-argv")" = "-q -o -" ] ||
  fail "speak: argv must be the fixed flags, got $(cat "$STUB_DIR/last-argv")"
ok "speak: the turn text is stdin data, never syntax and never argv; an unconfigured voice adds no -v"

# Streaming means the header reaches the client while the render is still
# running: the slow stub pauses 3s between them, so a 1s cap returns the header
# alone (curl exit 28), not the empty body a collect-then-send route gives.
touch "$STUB_DIR/slow"
set +e
curl -s --max-time 1 -o "$TMP/partial" "$BASE/api/live/turns/$SPOKEN/speak"
CURL_RC=$?
set -e
rm -f "$STUB_DIR/slow"
[ "$CURL_RC" = "28" ] || fail "speak: the slow stub should have outlived the 1s cap (curl rc $CURL_RC)"
[ "$(wc -c <"$TMP/partial" | tr -d ' ')" = "44" ] ||
  fail "speak: the header must arrive while synthesis runs, got $(wc -c <"$TMP/partial") bytes"
ok "speak: audio streams — the header plays before the render finishes"

# A pure navigate says nothing, and silence coming down an audio element is
# indistinguishable from a broken synthesiser. So it is validation, not a
# zero-length WAV — and nothing is spawned.
rm -f "$STUB_DIR/last-argv"
speak "/api/live/turns/$SILENT/speak"
[ "$STATUS" = "422" ] || fail "speak on a pure-navigate turn: expected 422, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "validation" ] ||
  fail "speak on a pure-navigate turn: error.code must be validation"
[ ! -e "$STUB_DIR/last-argv" ] ||
  fail "speak on a pure-navigate turn: nothing may be spawned"
ok "speak on a turn with no text: 422 validation, and no synthesiser is started"

speak "/api/live/turns/999999/speak"
[ "$STATUS" = "404" ] || fail "speak on an unknown turn: expected 404, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "not_found" ] || fail "speak unknown turn: error.code"
ok "speak on an unknown turn: 404 not_found"

touch "$STUB_DIR/tts-fail"
speak "/api/live/turns/$SPOKEN/speak"
rm -f "$STUB_DIR/tts-fail"
[ "$STATUS" = "503" ] || fail "speak: a failing synthesiser must be 503, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "unavailable" ] ||
  fail "speak: a failing synthesiser must be code unavailable"
ok "speak: a missing or failing synthesiser is 503 unavailable (an outside-mesa dependency)"

# =====================================================================
# 8. The security boundary in default mode
# =====================================================================

# ---- Host-header allowlist (DNS-rebinding defense) ----
raw GET "/api/live" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "bogus Host on GET /api/live: expected 403, got $STATUS"
[ "$(jqb .error.code)" = "validation" ] || fail "bogus Host: error.code"
raw POST "/api/live/utterance" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"text":"must not be recorded"}'
[ "$STATUS" = "403" ] ||
  fail "bogus Host on a well-formed utterance: expected 403, got $STATUS"
raw GET "/api/live" -H "Host: localhost:$PORT"
[ "$STATUS" = "200" ] || fail "Host localhost:$PORT: expected 200, got $STATUS"
raw GET "/api/live" -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "200" ] || fail "Host 127.0.0.1:$PORT: expected 200, got $STATUS"
raw GET "/api/live" -H "Host: localhost:1"
[ "$STATUS" = "403" ] || fail "Host on the wrong port: expected 403, got $STATUS"
ok "Host allowlist: a foreign Host is 403 on read and write; both allowlisted spellings pass"

# ---- Content-Type gate (cross-site form posts), on every live write ----
for p in "/api/live" "/api/live/utterance" "/api/live/route" "/api/live/turns/$SPOKEN/played"; do
  raw POST "$p"
  [ "$STATUS" = "415" ] || fail "POST $p without Content-Type: expected 415, got $STATUS"
  [ "$(jqb .error.code)" = "validation" ] || fail "POST $p no Content-Type: error.code"
  raw POST "$p" -d 'text=form+post'
  [ "$STATUS" = "415" ] || fail "form-encoded POST $p: expected 415, got $STATUS"
done
raw DELETE "/api/live" -d 'x=1'
[ "$STATUS" = "415" ] || fail "DELETE /api/live without JSON Content-Type: expected 415, got $STATUS"
raw GET "/api/live"
[ "$STATUS" = "200" ] || fail "GET /api/live is exempt from the Content-Type gate"
ok "Content-Type gate: every live mutation (POST ×4, DELETE) is 415 without JSON; GET is exempt"

# ---- the agent gate on the three routes that carry it ----
#
# `POST`/`DELETE /api/live` spawn and hang up on a background agent, and the
# speak route pins a core for as long as the audio is — all three carry
# `require_agent_access`, stronger than the writes beside them. The contrast is
# the point, so the plain-guard neighbours are probed with the SAME header.
origin_status() { # origin_status <method> <path> <origin> [json-body]
  local method=$1 path=$2 origin=$3 body=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" -H "Origin: $origin")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$BASE$path"
}
[ "$(origin_status POST "/api/live" 'https://evil.example' '{}')" = "403" ] ||
  fail "POST /api/live with a foreign Origin must be 403"
[ "$(origin_status DELETE "/api/live" 'https://evil.example' '{}')" = "403" ] ||
  fail "DELETE /api/live with a foreign Origin must be 403"
speak "/api/live/turns/$SPOKEN/speak" -H 'Origin: http://evil.example'
[ "$STATUS" = "403" ] || fail "speak with a foreign Origin must be 403, got $STATUS"
# …while the plain-guard neighbours are served with that same Origin.
[ "$(origin_status GET "/api/live" 'https://evil.example')" = "200" ] ||
  fail "GET /api/live must stay on the plain guard (foreign Origin)"
[ "$(origin_status POST "/api/live/utterance" 'https://evil.example' '{"text":"plain guard"}')" = "201" ] ||
  fail "POST /api/live/utterance must stay on the plain guard (foreign Origin)"
[ "$(origin_status POST "/api/live/route" 'https://evil.example' '{"route":"#/live"}')" = "200" ] ||
  fail "POST /api/live/route must stay on the plain guard (foreign Origin)"
[ "$(origin_status POST "/api/live/turns/$SPOKEN/played" 'https://evil.example' '{}')" = "200" ] ||
  fail "POST /api/live/turns/{id}/played must stay on the plain guard (foreign Origin)"
[ "$(origin_status POST "/api/live" 'http://localhost:7770' '{}')" = "409" ] ||
  fail "POST /api/live from a local Origin must reach the handler (409: one is live)"
ok "agent gate: start/stop/speak refuse a foreign Origin; the plain-guard live writes do not"

# The speak route's second half: a cross-site <audio> subresource sends NO
# Origin, so `Sec-Fetch-Site` is what refuses it — exactly as the inbox's.
speak "/api/live/turns/$SPOKEN/speak" -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Dest: audio'
[ "$STATUS" = "403" ] || fail "speak: a cross-site subresource must be 403, got $STATUS"
[ "$(jq -r .error.code <"$TMP/audio")" = "validation" ] ||
  fail "speak: the cross-site refusal must be code validation"
speak "/api/live/turns/$SPOKEN/speak" -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Dest: audio'
[ "$STATUS" = "200" ] || fail "speak: our own page's <audio> must be served, got $STATUS"
speak "/api/live/turns/$SPOKEN/speak" -H 'Sec-Fetch-Site: none'
[ "$STATUS" = "200" ] || fail "speak: a typed-in URL must be served, got $STATUS"
ok "speak: Sec-Fetch-Site closes the no-Origin subresource hole (cross-site 403, same-origin/none 200)"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# =====================================================================
# 9. LAN mode: Host allowlist off, Content-Type gate still on
# =====================================================================
#
# `--lan` flips the bind address and the Host policy together — two halves of
# one opt-in posture (CLAUDE.md). What it must NOT do is relax the Content-Type
# gate, or let the agent-gated live routes off their stronger gate.

LAN_PORT=17782
LAN_BASE="http://127.0.0.1:$LAN_PORT"
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$LAN_BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$LAN_BASE/api/live" >/dev/null ||
  fail "LAN server did not start (log: $(cat "$TMP/lan.log"))"

BASE=$LAN_BASE

raw GET "/api/live" -H "Host: evil.example"
[ "$STATUS" = "200" ] || fail "--lan: a foreign Host must be allowed on the read, got $STATUS"
[ "$(jqb .session.id)" = "$SS" ] || fail "--lan: the same session is served"
ok "--lan: the Host allowlist is skipped on the ordinary live read (opt-in LAN trust)"

raw POST "/api/live/utterance" -H "Host: evil.example" -d 'text=form+post'
[ "$STATUS" = "415" ] || fail "--lan: a form-encoded utterance must still be 415, got $STATUS"
[ "$(jqb .error.code)" = "validation" ] || fail "--lan 415: error.code"
raw POST "/api/live/route" -H "Host: evil.example" -d 'route=%23/live'
[ "$STATUS" = "415" ] || fail "--lan: a form-encoded route post must still be 415, got $STATUS"
ok "--lan: the Content-Type gate still rejects a form-encoded live write (415)"

raw POST "/api/live/utterance" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"text":"dictated from the LAN"}'
[ "$STATUS" = "201" ] || fail "--lan: a JSON utterance from any Host must work, got $STATUS ($BODY)"
ok "--lan: a JSON live write from any Host is accepted"

# The agent-gated routes do NOT follow the Host allowlist off: under --lan a
# DNS-name Host is still refused while the IP-literal Host a real LAN browser
# sends is served — the pairing that must not drift apart.
lan_status() { # lan_status <method> <path> <host> [json-body]
  local method=$1 path=$2 host=$3 body=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" -H "Host: $host")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$LAN_BASE$path"
}
[ "$(lan_status POST "/api/live" 'evil.example' '{}')" = "403" ] ||
  fail "--lan: POST /api/live must still refuse a DNS-name Host (rebinding defense)"
[ "$(lan_status POST "/api/live" "evil.example:$LAN_PORT" '{}')" = "403" ] ||
  fail "--lan: POST /api/live must refuse a DNS-name Host even on our port"
[ "$(lan_status DELETE "/api/live" 'evil.example' '{}')" = "403" ] ||
  fail "--lan: DELETE /api/live must still refuse a DNS-name Host"
speak "/api/live/turns/$SPOKEN/speak" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "--lan speak: a DNS-name Host must still be 403, got $STATUS"
speak "/api/live/turns/$SPOKEN/speak" -H "Host: 127.0.0.1:$LAN_PORT"
[ "$STATUS" = "200" ] || fail "--lan speak: a local Host must be served, got $STATUS"
grep -qi '^content-type: audio/wav' "$TMP/headers" || fail "--lan speak: Content-Type"
speak "/api/live/turns/$SPOKEN/speak" -H "Host: 192.0.2.7:$LAN_PORT"
[ "$STATUS" = "200" ] || fail "--lan speak: an IP-literal Host must be served, got $STATUS"
speak "/api/live/turns/$SPOKEN/speak" -H "Host: 192.0.2.7:999"
[ "$STATUS" = "403" ] || fail "--lan speak: an IP Host on a foreign port must be 403, got $STATUS"
# Still 409 rather than 403 for a local Host: the gate passed and the handler
# refused, which is what proves the 403s above were the gate and not the store.
[ "$(lan_status POST "/api/live" "127.0.0.1:$LAN_PORT" '{}')" = "409" ] ||
  fail "--lan: POST /api/live from a local Host must reach the handler"
ok "--lan: start/stop/speak keep the agent gate (DNS Host 403, local/IP-literal Host through to the handler)"

[ "$(lan_status DELETE "/api/live" "127.0.0.1:$LAN_PORT" '{}')" = "200" ] ||
  fail "--lan: DELETE /api/live from a local Host must end the session"
ok "--lan: the conversation can still be ended from a local client"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

echo "all $CHECKS checks passed"
