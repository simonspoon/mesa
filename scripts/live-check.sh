#!/usr/bin/env bash
# Mesa-live gate (mesa task 855): exercises the spoken-conversation surface end
# to end — the `mesa live` CLI group and the `/api/live*` routes — against a
# throwaway MESA_DB, a stub `claude` (MESA_CLAUDE_BIN), a stub `kokoro-rs`
# (MESA_KOKORO_BIN) and a stub `loki` (MESA_LOKI_BIN). No real agent, no real
# synthesiser and no real screen are ever touched.
#
# Covers, in order:
#   1. the CLI with nothing running — `status` prints null and exits 0, every
#      other verb is `not_found` naming `mesa live start`, and the usage errors
#      (exit 2) around them, including `--quiet` refused on `turns` and `look`;
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
#      state, start/stop, the 409, the utterance write, the route write and the
#      context riding with it (both halves recorded, the CLI reading back the
#      same context, omitted/null clearing it, the closed `kind` vocabulary and
#      the 200-char field bound), the `?after=` cursor and the idempotent
#      played stamp;
#   6. the loop the two surfaces make together: an utterance posted over HTTP is
#      handed to `mesa live listen` exactly once, never twice, a quiet wait
#      prints `null` and exits 0, and the session's `working_since` opens when
#      the utterance is handed over, survives a reply and closes on the next
#      wait that finds nothing (task 894);
#   7. GET /api/live/turns/{id}/speak — the audio contract, the patched
#      streaming WAV sizes, the header arriving mid-render, no Content-Length,
#      `validation` for a pure-navigate turn and `unavailable` for a failing
#      synthesiser;
#   8. `mesa live look` (task 895) against a stub loki — the window box riding
#      in the route report and read back by `mesa live status`, an impossible
#      box refused, and which window the box picks: the person's rather than
#      the headless `mesa` beside it, `unavailable` when nothing is at the box
#      (or no browser reported one), `conflict` when two windows are;
#   9. the security boundary in default mode — the Host allowlist, the
#      Content-Type gate on every live write, and the agent gate on the three
#      routes that carry it (POST/DELETE /api/live, speak) contrasted with the
#      plain guard on their neighbours;
#  10. the same boundary under `--lan`: Host skipped, Content-Type still
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
  stop)
    # The other end of the receipt: ending a conversation stops the agent it
    # was started with. Records the argv so the assertions can read back WHICH
    # job was stopped; a `stop-fail` marker makes it the failure that must
    # still leave a cleanly ended session behind.
    printf '%s\n' "\$*" > "$STUB_DIR/last-stop"
    [ -e "$STUB_DIR/stop-fail" ] && { echo "No job matching" >&2; exit 1; }
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

# ---- stub loki (`live look` photographs the person's browser window) ----
#
# A stub, and it has to be one: a gate has no screen, no browser and no window
# server, and the half of `live look` that is mesa's — WHICH of the windows on
# offer the reported box picks — needs none of the three. It answers
# `-f json windows` from a file section 8 rewrites per case, writes a file
# wherever `--output` points for `screenshot`, and records every invocation so
# a check can assert that nothing was run at all.
cat > "$STUB_DIR/loki" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$STUB_DIR/last-loki"
case "\$1" in
  -f) cat "$STUB_DIR/windows.json" ;;
  screenshot)
    OUT=""
    while [ \$# -gt 0 ]; do
      [ "\$1" = "--output" ] && OUT=\$2
      shift
    done
    printf '\x89PNG\r\n\x1a\n' > "\$OUT"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$STUB_DIR/loki"
export MESA_LOKI_BIN="$STUB_DIR/loki"

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

for verb in stop turns listen look; do
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

# `look` is the other command with no record to project: it prints a shot, not
# a stored object, so there is nothing for --quiet to drop.
run 2 "$MESA" live look --quiet
[ -z "$STDOUT" ] || fail "live look --quiet: stdout must be empty on a usage error"
[ "$(jqe .error.code)" = "usage" ] || fail "live look --quiet: error.code"
ok "live look --quiet: unknown argument, exit 2, empty stdout (the --quiet contract)"

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

# ---- stopping the conversation stops its agent ----
#
# The other half of the spawn: hanging up finishes the background session
# rather than leaving one idling per conversation. The job named is the short
# id from the receipt, and nothing else.
rm -f "$STUB_DIR/last-stop"
run 0 "$MESA" live stop
[ "$(jqs .status)" = "ended" ] || fail "live stop: status must be ended"
[ "$(cat "$STUB_DIR/last-stop")" = "stop deadbeef" ] ||
  fail "live stop: must run \`claude stop <agent_id>\` (got $(cat "$STUB_DIR/last-stop" 2>/dev/null))"
ok "live stop: ends the session AND stops the agent it was started with, by its short job id"

# Best-effort, both ways round: a session with no agent has nothing to stop,
# and a `claude stop` that fails is a warning on stderr — never a nonzero exit,
# and never anything on stdout but the ended session.
rm -f "$STUB_DIR/last-stop"
run 0 "$MESA" live start --no-agent
run 0 "$MESA" live stop
[ ! -e "$STUB_DIR/last-stop" ] ||
  fail "live stop on a --no-agent session: there is no agent to stop"
[ -z "$STDERR" ] || fail "live stop on a --no-agent session: nothing to warn about"

touch "$STUB_DIR/stop-fail"
run 0 "$MESA" live start
run 0 "$MESA" live stop
rm -f "$STUB_DIR/stop-fail"
[ "$(jqs .status)" = "ended" ] ||
  fail "live stop with a failing \`claude stop\`: the conversation is still ended"
grep -q 'could not stop its agent' <<<"$STDERR" ||
  fail "live stop with a failing \`claude stop\`: the warning belongs on stderr"
run 0 "$MESA" live status
[ "$STDOUT" = "null" ] || fail "a failed agent stop must still leave no live session"
ok "live stop is best-effort: no agent is a no-op, a failing \`claude stop\` warns on stderr and still exits 0"

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

# ---- context: what is open on that page (task 888) ----
#
# The route says which page; the context says what is in focus on it. They
# arrive in ONE body because they are one statement — and because omitting the
# context is how a page with nothing open says so, which every bare-route
# assertion above already depends on.
CTX=$(jq -n '{route:"#/projects/7/files",
              context:{kind:"files", id:"src/core/store.rs",
                       label:"store.rs", detail:"line 42"}}')
api 200 POST "/api/live/route" "$CTX"
[ "$(jqb .route)" = "#/projects/7/files" ] || fail "route+context: must record the route"
[ "$(jqb .id)" = "$AS" ] || fail "route+context: still answers the session"
[ "$(jqb .context.kind)" = "files" ] || fail "route+context: must record the kind"
[ "$(jqb .context.id)" = "src/core/store.rs" ] || fail "route+context: must record the id"
[ "$(jqb .context.label)" = "store.rs" ] || fail "route+context: must record the label"
[ "$(jqb .context.detail)" = "line 42" ] || fail "route+context: must record the detail"
api 200 GET "/api/live"
[ "$(jqb '.session.context')" != "null" ] || fail "the context must survive the write"
ok "POST /api/live/route: records the page AND what is open on it"

# The agent never reads this over HTTP — it runs `mesa live status`, which
# opens its own Store against the same file. The two surfaces share `core` and
# must not disagree about what the person is looking at.
run 0 "$MESA" live status
[ "$(jqs .context.kind)" = "files" ] || fail "live status: the CLI must see the reported kind"
[ "$(jqs .context.id)" = "src/core/store.rs" ] || fail "live status: the CLI must see the id"
[ "$(jqs .context.label)" = "store.rs" ] || fail "live status: the CLI must see the label"
[ "$(jqs .context.detail)" = "line 42" ] || fail "live status: the CLI must see the detail"
ok "mesa live status: the CLI reads back the context the page reported over HTTP"

# The report is a complete statement, not a patch: no context clears.
api 200 POST "/api/live/route" '{"route":"#/inbox"}'
[ "$(jqb .context)" = "null" ] || fail "omitting context must clear it, not leave the old one"
api 200 POST "/api/live/route" "$CTX"
[ "$(jqb .context.kind)" = "files" ] || fail "re-reporting the context must record it again"
api 200 POST "/api/live/route" '{"route":"#/inbox","context":null}'
[ "$(jqb .context)" = "null" ] || fail "an explicit null context must clear it too"
ok "the context is a statement, not a patch: omitted or null clears what was selected"

# "Nothing selected" is genuinely absent, never "". A page whose editor is
# empty reports its kind and no more, and the agent must not have to treat an
# empty string as a name.
api 200 POST "/api/live/route" \
  '{"route":"#/projects/7/files","context":{"kind":"files","id":"","label":"   ","detail":"\t"}}'
[ "$(jqb .context.kind)" = "files" ] || fail "a bare context still names its page"
[ "$(jqb .context.id)" = "null" ] || fail "a blank id must come back null, not \"\""
[ "$(jqb .context.label)" = "null" ] || fail "a whitespace label must come back null"
[ "$(jqb .context.detail)" = "null" ] || fail "a whitespace detail must come back null"
ok "blank/whitespace context fields fold to null: nothing selected is absent, not empty"

# Each free-text field is bounded for the reason the route is — a label is
# SPOKEN — and the bound is inclusive, exactly as the route's is.
F200=$(printf 'x%.0s' $(seq 1 200))
for FIELD in id label detail; do
  BODY200=$(jq -n --arg f "$FIELD" --arg v "$F200" \
    '{route:"#/projects/7/files", context:({kind:"files"} + {($f): $v})}')
  api 200 POST "/api/live/route" "$BODY200"
  [ "$(jqb ".context.$FIELD | length")" = "200" ] ||
    fail "a 200-char $FIELD must be accepted (the bound is 200, inclusive)"
  BODY201=$(jq -n --arg f "$FIELD" --arg v "x$F200" \
    '{route:"#/projects/7/files", context:({kind:"files"} + {($f): $v})}')
  api 422 POST "/api/live/route" "$BODY201"
  [ "$(jqb .error.code)" = "validation" ] || fail "a 201-char $FIELD: error.code"
  grep -q "$FIELD" <<<"$(jqb .error.message)" || fail "the message must name the field ($FIELD)"
done
ok "each context field is capped at 200 chars: 200 accepted, 201 validation naming the field"

# `kind` is a CLOSED vocabulary, and serde is the gate: a page mesa does not
# have never reaches the handler, and comes back as the same 422 `validation`
# an over-long field gets.
api 422 POST "/api/live/route" '{"route":"#/inbox","context":{"kind":"holodeck"}}'
[ "$(jqb .error.code)" = "validation" ] || fail "an unknown context kind: error.code"
api 422 POST "/api/live/route" '{"route":"#/inbox","context":{}}'
[ "$(jqb .error.code)" = "validation" ] || fail "a context with no kind: error.code"
# `custom` is a real project tab and deliberately NOT a context kind — a custom
# layout is several views at once and each publishes what it holds, so the tab
# is never the answer. Pinned here so nobody adds it back by reflex.
api 422 POST "/api/live/route" '{"route":"#/projects/7","context":{"kind":"custom"}}'
[ "$(jqb .error.code)" = "validation" ] || fail "the custom tab is not a context kind: error.code"
ok "an unknown page kind is 422 validation: the vocabulary is closed"

# A refused report leaves BOTH halves of the stored one alone — the route rule
# already promises that, and validating the context before either is written is
# what keeps the promise now that a report carries two things.
api 200 POST "/api/live/route" "$CTX"
api 422 POST "/api/live/route" \
  "$(jq -n --arg v "x$F200" '{route:"#/inbox", context:{kind:"inbox", label:$v}}')"
api 200 GET "/api/live"
[ "$(jqb .session.route)" = "#/projects/7/files" ] ||
  fail "a refused context must leave the recorded route alone"
[ "$(jqb .session.context.label)" = "store.rs" ] ||
  fail "a refused context must leave the recorded context alone"
ok "a refused context writes nothing: the stored route AND context are untouched"

# Every value of the vocabulary, because a vocabulary the gate does not
# exercise is a vocabulary that rots. These ARE the app's pages: seven project
# tabs plus the two global pages that have a focus. There is deliberately no
# `custom`: a custom layout is several views at once and each publishes what
# it holds, so the tab is never the answer (see `LiveContextKind`).
for KIND in board dashboard diagrams files git inbox scripts settings terminal; do
  api 200 POST "/api/live/route" \
    "$(jq -n --arg k "$KIND" '{route:"#/projects/7", context:{kind:$k, label:"a thing"}}')"
  [ "$(jqb .context.kind)" = "$KIND" ] || fail "context kind $KIND must be accepted"
done
ok "all nine page kinds are accepted: board, dashboard, diagrams, files, git, inbox, scripts, settings, terminal"

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

# The agent's half of the header band (task 894). Taking an utterance opens a
# working span on the session row, which is what the page's existing poll shows
# as "she is working on it" — and what tells it apart from never having heard.
api 200 GET "/api/live"
[ "$(jqb .session.working_since)" != "null" ] ||
  fail "live listen: taking an utterance must mark the session working"
# Saying something does not close it: an agent that says "one moment" and then
# does the job is working for the whole of it.
run 0 "$MESA" live say "One moment."
api 200 GET "/api/live"
[ "$(jqb .session.working_since)" != "null" ] ||
  fail "live say must not end the working span — the agent may still be working"
ok "live listen: taking an utterance marks the session working, and a reply does not clear it"

run 0 "$MESA" live listen --wait 1
[ "$STDOUT" = "null" ] || fail "live listen: a delivered utterance must never be handed out twice"
ok "live listen: never the same utterance twice (delivery is the stamp)"

# …and going back to the wait with nothing to hand out is the agent genuinely
# waiting on the person, which is the one thing that ends the span.
api 200 GET "/api/live"
[ "$(jqb .session.working_since)" = "null" ] ||
  fail "live listen with nothing to hand out must clear the working span"
ok "live listen: waiting with nothing to do clears the working span"

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
rm -f "$STUB_DIR/last-stop"
api 200 DELETE "/api/live"
[ "$(jqb .status)" = "ended" ] || fail "DELETE /api/live: status must be ended"
wait "$LE"
[ "$(cat "$TMP/listen-end.json")" = "null" ] ||
  fail "live listen must return null when the session ends under it"
# The API twin of the CLI's stop: the same short job id, stopped the same way.
[ "$(cat "$STUB_DIR/last-stop")" = "stop deadbeef" ] ||
  fail "DELETE /api/live: must stop the agent it spawned (got $(cat "$STUB_DIR/last-stop" 2>/dev/null))"
ok "DELETE /api/live: 200 the ended session, its agent stopped, and a waiting \`live listen\` returns null early"

api 404 DELETE "/api/live"
[ "$(jqb .error.code)" = "not_found" ] || fail "second DELETE /api/live: error.code"
api 200 GET "/api/live"
[ "$(jqb .session)" = "null" ] || fail "after DELETE: back to the idle state"
ok "DELETE /api/live twice: the second is 404 not_found, and the page is idle again"

# Best-effort there too: a `claude stop` that fails must not turn hanging up
# into an error — the store write is what ended the conversation.
api 201 POST "/api/live" '{}'
touch "$STUB_DIR/stop-fail"
api 200 DELETE "/api/live"
rm -f "$STUB_DIR/stop-fail"
[ "$(jqb .status)" = "ended" ] ||
  fail "DELETE /api/live with a failing \`claude stop\`: the conversation is still ended"
api 200 GET "/api/live"
[ "$(jqb .session)" = "null" ] || fail "a failed agent stop must still leave no live session"
ok "DELETE /api/live is best-effort: a failing \`claude stop\` still answers the ended session"

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
# 8. `mesa live look`: photographing the person's browser window (task 895)
# =====================================================================
#
# The stub loki above stands in for a screen. What is under test is mesa's
# half: the box the page reports travelling with the route, and which of the
# windows on offer that box picks.

# ---- a conversation no browser has joined ----
#
# Session SS was started over HTTP and has reported no window, which is every
# CLI-driven and every --no-agent conversation. mesa must say so itself rather
# than asking loki for a window at a box of nothing.
rm -f "$STUB_DIR/last-loki"
run 1 "$MESA" live look
[ "$(jqe .error.code)" = "unavailable" ] || fail "live look with no reported window: error.code"
grep -q 'press Listen' <<<"$STDERR" ||
  fail "live look with no reported window: the message must name the way to get one"
[ ! -e "$STUB_DIR/last-loki" ] ||
  fail "live look with no reported window must not run loki at all"
ok "live look on a session no browser has joined: exit 1 unavailable, and loki is never run"

# ---- the window box rides in the route report ----
#
# Not a route of its own: the box says which desktop window the route and the
# context are showing in, so all three are one statement from one poster.
LOOKBOX='{"x":118,"y":64,"width":1512,"height":982}'
api 200 POST "/api/live/route" "{\"route\":\"#/projects/7/files\",\"window\":$LOOKBOX}"
[ "$(jqb .window.x)" = "118" ] || fail "route+window: must record x"
[ "$(jqb .window.y)" = "64" ] || fail "route+window: must record y"
[ "$(jqb .window.width)" = "1512" ] || fail "route+window: must record width"
[ "$(jqb .window.height)" = "982" ] || fail "route+window: must record height"

# The agent reads it over its own Store, never over HTTP — the two surfaces
# share `core` and must not disagree about where the person's window is.
run 0 "$MESA" live status
[ "$(jqs .window.x)" = "118" ] || fail "live status: the CLI must see the reported x"
[ "$(jqs .window.width)" = "1512" ] || fail "live status: the CLI must see the reported width"
[ "$(jqs .window.height)" = "982" ] || fail "live status: the CLI must see the reported height"
ok "POST /api/live/route: the window box rides with the route and reaches \`mesa live status\`"

# A statement, not a patch — exactly as the context is.
api 200 POST "/api/live/route" '{"route":"#/inbox"}'
[ "$(jqb .window)" = "null" ] || fail "omitting the window must clear it, not leave the old box"
ok "the window box is a statement too: a report without one clears it"

# An origin may be negative: a display to the LEFT of the primary one is where
# a great many people keep their browser.
api 200 POST "/api/live/route" \
  '{"route":"#/inbox","window":{"x":-1440,"y":-200,"width":1440,"height":900}}'
[ "$(jqb .window.x)" = "-1440" ] || fail "a negative origin must be accepted (a display to the left)"
ok "a negative window origin is legal: only the extents must be positive"

# …but a box no browser could be in is refused, and refused before anything is
# written, exactly as an over-long context field is.
api 200 POST "/api/live/route" "{\"route\":\"#/projects/7/files\",\"window\":$LOOKBOX}"
for BAD in '{"x":0,"y":0,"width":20001,"height":982}' \
           '{"x":0,"y":0,"width":0,"height":982}' \
           '{"x":0,"y":0,"width":1512,"height":-1}' \
           '{"x":-20001,"y":0,"width":1512,"height":982}' \
           '{"x":0,"y":20001,"width":1512,"height":982}'; do
  api 422 POST "/api/live/route" "{\"route\":\"#/inbox\",\"window\":$BAD}"
  [ "$(jqb .error.code)" = "validation" ] || fail "an impossible window box ($BAD): error.code"
done
api 200 GET "/api/live"
[ "$(jqb .session.route)" = "#/projects/7/files" ] ||
  fail "a refused window box must leave the recorded route alone"
[ "$(jqb .session.window.width)" = "1512" ] ||
  fail "a refused window box must leave the recorded box alone"
ok "an impossible window box is 422 validation and writes nothing (route AND box untouched)"

if [ "$(uname -s)" != "Darwin" ]; then
  # loki drives macOS's own window server, and mesa says so before it goes
  # looking for a binary that could never have worked here — "not installed"
  # would send someone off to install it.
  run 1 "$MESA" live look
  [ "$(jqe .error.code)" = "unavailable" ] || fail "live look off a Mac: error.code"
  grep -qi 'mac' <<<"$STDERR" || fail "live look off a Mac: the message must say loki is a Mac tool"
  ok "live look on a machine that is not a Mac: exit 1 unavailable, saying so"
else
  # ---- which window the box picks ----
  #
  # The list the stub answers with is the real situation this design exists
  # for: a khora-launched HEADLESS Chrome titled `mesa`, the person's own
  # window, and a menu bar. Only the size tells the first two apart, so a
  # title match would photograph the headless one. The person's frame is
  # deliberately fractional — the window server reports a float CGRect and the
  # page reports integers, and rounding is what makes those one statement.
  cat > "$STUB_DIR/windows.json" <<'JSON'
[{"window_id":40484,"pid":34872,"title":"mesa","bundle_id":"com.google.Chrome",
  "frame":{"x":0.0,"y":0.0,"width":1600.0,"height":1200.0},"is_on_screen":false},
 {"window_id":40041,"pid":501,"title":"mesa","bundle_id":"com.google.Chrome",
  "frame":{"x":118.4,"y":63.7,"width":1512.0,"height":981.5},"is_on_screen":true},
 {"window_id":38878,"pid":403,"title":"Finder","bundle_id":"com.apple.finder",
  "frame":{"x":0.0,"y":0.0,"width":1728.0,"height":38.0},"is_on_screen":true}]
JSON
  rm -f "$STUB_DIR/last-loki"
  run 0 "$MESA" live look
  SHOT=$(jqs .path)
  [ "$(jqs .window_id)" = "40041" ] ||
    fail "live look photographed window $(jqs .window_id): the box must pick the PERSON's window, not the headless mesa beside it"
  [ "$(jqs .width)" = "1512" ] || fail "live look: width must be the reported one"
  [ "$(jqs .height)" = "982" ] || fail "live look: height must be the reported one"
  [ -s "$SHOT" ] || fail "live look: no file at the path it printed ($SHOT)"
  case "$SHOT" in
    */mesa-live-"$SS"-*.png) ;;
    *) fail "live look: the default path must be a temp file named for the session (got $SHOT)" ;;
  esac
  [ "$(cat "$STUB_DIR/last-loki")" = "screenshot --window 40041 --output $SHOT" ] ||
    fail "live look: the shot must be of the matched window (got $(cat "$STUB_DIR/last-loki"))"
  ok "live look: the reported box picks the person's window over a lookalike titled \`mesa\`, and a PNG lands at a temp path named for the session"

  run 0 "$MESA" live look --output "$TMP/screen.png"
  [ "$(jqs .path)" = "$TMP/screen.png" ] || fail "live look --output: must print the path it was given"
  [ -s "$TMP/screen.png" ] || fail "live look --output: no file written"
  ok "live look --output: the shot lands exactly where the caller asked"

  # Nothing at that box: the browser moved or closed since it reported. This
  # moment is wrong, not the conversation — so `unavailable`, and a message
  # naming the box rather than a nearest-match guess.
  cat > "$STUB_DIR/windows.json" <<'JSON'
[{"window_id":40484,"title":"mesa",
  "frame":{"x":0.0,"y":0.0,"width":1600.0,"height":1200.0}}]
JSON
  run 1 "$MESA" live look
  [ "$(jqe .error.code)" = "unavailable" ] || fail "live look with no window at the box: error.code"
  grep -q '1512×982' <<<"$STDERR" ||
    fail "live look with no window at the box: the message must name the box it looked for"
  ok "live look with nothing at the reported box: exit 1 unavailable, never a nearest guess"

  # Two windows genuinely stacked at one box is ambiguous, and ambiguity here
  # means photographing the wrong screen — so both ids are named and the
  # person can fix it.
  cat > "$STUB_DIR/windows.json" <<'JSON'
[{"window_id":11,"title":"mesa","frame":{"x":118.0,"y":64.0,"width":1512.0,"height":982.0}},
 {"window_id":12,"title":"mesa","frame":{"x":118.0,"y":64.0,"width":1512.0,"height":982.0}}]
JSON
  run 1 "$MESA" live look
  [ "$(jqe .error.code)" = "conflict" ] || fail "live look with two windows at one box: error.code"
  grep -q '11' <<<"$STDERR" && grep -q '12' <<<"$STDERR" ||
    fail "live look with two windows at one box: the message must name both ids"
  ok "live look with two windows at one box: exit 1 conflict naming both — never a coin toss"
fi

# There is deliberately no HTTP route for any of this: capturing the person's
# screen must not be reachable over a socket that `--lan` opens to the network.
raw POST "/api/live/look" -H 'Content-Type: application/json' -d '{}'
[ "$STATUS" = "405" ] || fail "POST /api/live/look must reach no handler at all, got $STATUS"
raw GET "/api/live/look"
jq -e 'type == "object" and has("path")' <<<"$BODY" >/dev/null 2>&1 &&
  fail "GET /api/live/look answered a screenshot — this must not be reachable over HTTP"
ok "there is no /api/live/look route: the screen is reachable only from the CLI"

# =====================================================================
# 9. The security boundary in default mode
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
# 10. LAN mode: Host allowlist off, Content-Type gate still on
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
