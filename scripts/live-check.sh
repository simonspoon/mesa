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
#      template's argv (`--agent mesa-live`), the session name and working
#      folder, the prompt arriving as ONE argument and carrying the session
#      line alone (a hostile project name is data, never syntax), the
#      `mesa-live` agent definition seeded into $HOME/.claude/agents on the
#      first start and never overwritten after it, and a failed spawn ending
#      the session it opened rather than stranding it;
#   5. the API twin over a live `serve` — the `{session:null,turns:[]}` empty
#      state, start/stop, the 409, the utterance write, the route write and the
#      context riding with it (both halves recorded, the CLI reading back the
#      same context, the three-way context key — omitted keeps, null clears, a
#      value replaces (task 1016) — the closed `kind` vocabulary and the
#      200-char field bound), the `?after=` cursor and the idempotent
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
#      in the route report and read back by `mesa live status`, its own
#      three-way key and the two-client scenario that made it one (a desktop
#      reports route+context+box, a phone reports a route alone, and the box
#      survives for `look` to match — task 1016), an impossible box refused,
#      and which window the box picks: the person's rather than
#      the headless `mesa` beside it, `unavailable` when nothing is at the box
#      (or no browser reported one), `conflict` when two windows are;
#   9. the security boundary in default mode — the Host allowlist, the
#      Content-Type gate on every live write, and the agent gate on the three
#      routes that carry it (POST/DELETE /api/live, speak) contrasted with the
#      plain guard on their neighbours;
#  10. the same boundary under `--lan`: Host skipped, Content-Type still
#      firing, and the agent-gated routes keeping their stronger gate;
#  15. the handoff (mesa task 1150): `mesa live handoff` spawning a successor
#      on the SAME session with the note and the last 10 turns appended after
#      the notebook and summary blocks, the same leading argv as the first
#      spawn (the cache-prefix invariant), the lease refusing the outgoing
#      agent's every verb as `conflict` while a lease-less person still
#      drives, the successor's first `listen --lease` stopping the predecessor
#      exactly once, a failed spawn leaving the session untouched, an empty
#      note refused, `mesa live context`'s key set (no `--quiet`), the page
#      seeing one session id throughout, and `handoff --quiet`'s key set;
#  11. session memory (mesa task 921): the `mesa live summary` CLI round-trip
#      (set/show/list, the upsert keeping `created_at`), its `--quiet`
#      contract (drops `body` only; `list --quiet` is a usage error; `--quiet`
#      typed AFTER the text lands in the body, the `live say` trap), the
#      validation/not_found/usage error shapes, `live turns --session` reading
#      an ended session's turns, and the `live-summary` template firing on
#      `live stop` — argv shape, session name, one-argument prompt — with its
#      two guards (no turns spawns nothing; a second stop is not_found and
#      spawns nothing), the recall join proving the notebook AND the single
#      most recent summary reach the NEXT conversation's spawned prompt argv
#      (both after the session line, never before, the notebook first, and
#      no older summary riding along — mesa task 1147 cut recall from 5 to
#      1), the archive being append-only (a summary for a session older than
#      dozens of already-summarised ones still readable, every row kept),
#      and the project-delete cascade;
#  12. POST /api/live/transcribe (mesa task 954), against a stub `auris`
#      (MESA_AURIS_BIN): a real round-trip whose decoded audio reaches the
#      stub on stdin byte-identical to what was sent (never as an argument),
#      keeping the LAST `transcript` line among several and ignoring an
#      unrecognised `type` (auris's own extension mechanism), `unavailable`
#      for a nonzero exit, a run with no `transcript` line at all, and a
#      missing binary; a body one byte over the 25 MiB cap answered 413
#      validation naming the limit, still as JSON, distinct from 422 for
#      invalid/empty/missing base64; both halves of the boundary in default
#      mode (Content-Type, agent gate); and under `--lan` **both verbs are
#      present and relaxed, not absent** — a LAN POST reaches the stub auris
#      with the same argv, the GET answers `{"available": true}`, and the
#      Content-Type gate still fires;
#  13. the whiteboard (mesa task 1071): `mesa live board` — the four kinds and
#      where each body comes from (a typed body, `--file` with the kind from
#      its extension, `--image` stored as base64 with its `content_type` from the
#      inline-image allowlist, `--diagram` as an ESCAPED SVG snapshot a later
#      canvas edit cannot change), `--say` speaking a turn beside the board,
#      the required-source and required-destination ArgGroups and the rest of
#      the exit-2 usage errors (`list --quiet` among them), the bodiless
#      oldest-first `list`/`show` and the `--quiet` key set (drops `body`
#      alone), `keep` into an artifact and onto a task (decoded image bytes,
#      authored `mesa-live`) with an image board refused the artifact and
#      pointed at `--task`, the retention bound pruning to the newest 20,
#      `clear`'s bodiless echo, and `GET /api/live/boards/{id}/render` — a
#      type per kind, nosniff, inline, byte-identical bodies and the artifact
#      CSP verbatim on the two document kinds — with the identical header set
#      in default mode AND under `--lan`, the absence of any board write
#      route, and the render route answering 404 `not_found` once the
#      conversation has ended (the row survives like a turn's; every read of
#      it stops);
#  14. live memory v2 (mesa task 1147): the `mesa live memory` notebook CLI
#      round trip (list/show/add/replace/delete/touch) with the `--quiet` key
#      set (drops `body` alone; `list --quiet`/`search --quiet` are usage
#      errors; `--quiet` typed after the text lands in the body, and after
#      search words is a word), `touch`
#      with no live session being not_found, every guard — the empty body,
#      the 600-char entry bound, the 500-word budget (naming both numbers),
#      the 30%-removal rule refusing a delete above the 100-word floor and
#      allowing one below it, a replace judged on the words it removes — a
#      retired row surviving in `list --all` and in the archive, `search`
#      hitting a turn, a summary and a note with their `kind`s, `ref_id`s
#      and bracketed snippets, a query carrying `"` and `AND` searched as
#      words rather than erroring, decay retiring every entry unused for N
#      ended sessions at the next `live start` (named on stderr, active list
#      empty, `--all` showing `decayed`), the four `/api/live/memory` routes
#      with both halves of the security boundary in default mode AND under
#      `--lan` (the Settings posture: `require_agent_access`, reads
#      included), and `GET /api/live` carrying no notebook (the 2s poll stays
#      bounded); then the dream pass (mesa task 1152): `merge` retiring its
#      sources as `merged` with `merged_into` pointing at the new row, which
#      carries the OLDEST source's provenance, both text bodies still
#      searchable, its refusals (one id, a repeated id, a retired or unknown
#      id, an empty body, no --ids) touching nothing, its budget and
#      removal guards judged on the NET words, `restore` un-retiring a
#      merged or deleted row (retirement fields cleared, nothing else moved)
#      and refused past the budget or on an active row, the `--quiet` key
#      set on both, and `dream` — `--quiet` a usage error, `{spawned:
#      false}` under two entries, `conflict` while a session is live (never
#      spawning), the built-in `live-dream` template's argv with
#      DREAM_PROMPT plus every active entry line and no retired one in the
#      workspace cwd, and a configured template receiving `{prompt}`
#      byte-identical and `{id}` as the newest session's;
#  16. notice turns (mesa task 1157): `mesa live notice permission|stalled`
#      writing a mesa turn with the fixed text, no action and `notice` set,
#      the `--quiet` key set (drops `text`, keeps `notice`), the dedupe (a
#      second call answers the SAME id and writes nothing) and a fresh
#      `next_user_turn` span allowing a fresh one, a bad kind a usage error
#      and `not_found` with nothing live; `POST /api/live/notice`'s round
#      trip, its 422 for a bad/missing kind, its 404 with nothing live and
#      the Content-Type gate; `GET /api/live` answering `blocked: null` for a
#      plain stub job and `"permission prompt"` once the stub reports the
#      session's job blocked; and the notice absent from
#      `mesa live memory search` while the agent's own turn is found;
#  17. the automatic dream (mesa task 1155): `mesa live context` carrying
#      `dream` (null under threshold), a handoff under threshold resting
#      nothing and spawning no dream, two lookalike entries making `context`
#      report a reason and the next handoff spawn the `live-dream` template
#      beside the successor with `resting_since` set (on `live status` and
#      `GET /api/live`), the explicit verb still `conflict` while resting,
#      `listen --lease` waking the session once the stub reports the dream
#      job done (predecessor still stopped once), and `live stop` spawning
#      a dream over threshold and none under it.
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
# A live start seeds the `mesa-live` agent definition into
# $HOME/.claude/agents (mesa task 1068), and every unbound spawn runs in
# $HOME/.mesa/workspace, so the whole gate runs under a throwaway home rather
# than writing into the developer's own. Physically resolved: a child records
# its cwd, and /tmp is a symlink on macOS.
mkdir -p "$TMP/home"
HOME=$(cd "$TMP/home" && pwd -P)
export HOME

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
    # A DISTINCT id per spawn (mesa task 1150): a handoff binds a successor to
    # the same session, and the assertions must be able to tell the two
    # apart. The first spawn is still `deadbeef`; the rest are `deadbeef-<n>`.
    N=\$(( \$(cat "$STUB_DIR/spawns" 2>/dev/null || echo 0) + 1 ))
    printf '%s\n' "\$N" > "$STUB_DIR/spawns"
    if [ "\$N" -eq 1 ]; then ID=deadbeef; else ID="deadbeef-\$N"; fi
    printf '%s\n' "\$ID" > "$STUB_DIR/last-id"
    echo "backgrounded · \$ID (idle — send a prompt to start)"
    ;;
  agents)
    # \`claude agents --json --all\`, for \`mesa live context\` (mesa task 1150):
    # one row naming the newest spawned job and a fixed session uuid, the two
    # keys \`agents::find_session_for_job\` reads. The uuid has no transcript
    # under the throwaway HOME, so the pulse answers null — what it answers
    # for any transcript it cannot read. A \`blocked-id\` file naming a job
    # makes that row a session stuck on a permission prompt, the shape
    # \`GET /api/live\`'s derived \`blocked\` reads (mesa task 1157).
    # A \`done-ids\` file listing the job makes its row \`state: "done"\`, the
    # shape \`agents::job_running\` reads as finished (mesa task 1155).
    ID=\$(cat "$STUB_DIR/last-id" 2>/dev/null)
    if [ "\$ID" = "\$(cat "$STUB_DIR/blocked-id" 2>/dev/null)" ]; then
      printf '[{"id":"%s","sessionId":"00000000-0000-0000-0000-000000000000","state":"blocked","waitingFor":"permission prompt"}]\n' "\$ID"
    elif grep -qx "\$ID" "$STUB_DIR/done-ids" 2>/dev/null; then
      printf '[{"id":"%s","sessionId":"00000000-0000-0000-0000-000000000000","state":"done"}]\n' "\$ID"
    else
      printf '[{"id":"%s","sessionId":"00000000-0000-0000-0000-000000000000","state":"working"}]\n' "\$ID"
    fi
    ;;
  stop)
    # The other end of the receipt: ending a conversation stops the agent it
    # was started with. Records the argv so the assertions can read back WHICH
    # job was stopped; a `stop-fail` marker makes it the failure that must
    # still leave a cleanly ended session behind.
    printf '%s\n' "\$*" > "$STUB_DIR/last-stop"
    # An `if`, not `[ … ] &&`: as the case's last command the bare test
    # would make every ordinary stop exit 1 (mesa task 1155 caught it).
    if [ -e "$STUB_DIR/stop-fail" ]; then echo "No job matching" >&2; exit 1; fi
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

# ---- stub auris (POST /api/live/transcribe, mesa task 954) ----
#
# The mirror of the kokoro-rs stub, running in the other direction: it logs
# its stdin (the decoded recording, which must reach it byte-identical and
# never as an argument) and its argv, then answers auris's real JSON-Lines
# `--format json` shape — a `segment` line, then a `transcript` line — on
# stdout. `$STUB_DIR/auris-lines` lets a case override what it emits (to
# prove mesa keeps the LAST `transcript` line and ignores anything else); an
# `auris-fail` marker is the exit-1 "no transcript" failure mode, printing to
# stderr and writing nothing to stdout.
cat > "$STUB_DIR/auris" <<EOF
#!/usr/bin/env bash
# The model probe (`auris --no-download --list-models`) is how mesa answers
# GET /api/live/transcribe's `{"available": bool}`. It records nothing: a
# probe must not clobber the argv or the stdin the transcribe assertions
# read back.
if [ "\$1" = "--no-download" ] && [ "\$2" = "--list-models" ]; then
  echo "parakeet-tdt-0.6b-v2-int8"
  exit 0
fi
printf '%s\n' "\$*" > "$STUB_DIR/last-argv"
cat > "$STUB_DIR/last-stdin"
[ -e "$STUB_DIR/auris-fail" ] && { echo "stub auris is down" >&2; exit 1; }
if [ -e "$STUB_DIR/auris-lines" ]; then
  cat "$STUB_DIR/auris-lines"
else
  printf '{"type":"segment","index":0,"text":"hello"}\n'
  printf '{"type":"transcript","text":"hello there"}\n'
fi
EOF
chmod +x "$STUB_DIR/auris"
export MESA_AURIS_BIN="$STUB_DIR/auris"

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
[ "$(jqs .agent_id)" = "$(cat "$STUB_DIR/last-id")" ] ||
  fail "live start: the spawn receipt must be bound to the session (got $(jqs .agent_id))"
ok "live start <PROJECT>: resolves a project by name and binds the spawn receipt"

# The argv the built-in `live-agent` template produces:
#   claude --bg --agent mesa-live --name {name} -- {prompt}
# The agent is named literally (mesa task 1068): the conversation runs as the
# `mesa-live` agent definition, which is where its instructions live now.
[ "$(cat "$STUB_DIR/last-argc")" = "7" ] ||
  fail "live spawn: expected 7 arguments, got $(cat "$STUB_DIR/last-argc")"
EXPECTED_FLAGS="--bg
--agent
mesa-live
--name
Live gate project: live $S3
--"
[ "$(cat "$STUB_DIR/last-flags")" = "$EXPECTED_FLAGS" ] ||
  fail "live spawn argv: expected
$EXPECTED_FLAGS
got
$(cat "$STUB_DIR/last-flags")"
# The prompt is ONE argument, and since mesa task 1068 it carries the session
# line and nothing else — the loop travels as the agent definition.
grep -q "Drive mesa live session $S3" "$STUB_DIR/last-prompt" ||
  fail "live spawn: the prompt must be the session line naming the session it drives"
if grep -q 'You are the voice of mesa' "$STUB_DIR/last-prompt"; then
  fail "live spawn: the instruction block must NOT be injected into the prompt any more"
fi
if grep -q 'mesa live listen' "$STUB_DIR/last-prompt"; then
  fail "live spawn: the loop belongs to the agent definition, not the prompt"
fi
[ "$(cat "$STUB_DIR/last-cwd")" = "$WORKDIR" ] ||
  fail "live spawn: must run in the project's local_path (got $(cat "$STUB_DIR/last-cwd"))"
ok "live spawn: the built-in live-agent argv (--agent mesa-live), the session name, the session line as one argument, the project's folder"

# ---- the agent definition is seeded before the spawn (mesa task 1068) ----
#
# `claude --agent mesa-live` errors on an agent Claude Code has never seen, and
# nothing auto-syncs the library, so the first start writes the definition to
# $HOME/.claude/agents/mesa-live.md itself.
SEEDED="$HOME/.claude/agents/mesa-live.md"
[ -f "$SEEDED" ] ||
  fail "live spawn: must seed the mesa-live agent definition at $SEEDED"
grep -q 'mesa live listen' "$SEEDED" ||
  fail "the seeded agent definition must carry the loop"
head -1 "$SEEDED" | grep -q -- '---' ||
  fail "the seeded agent definition must open with YAML frontmatter"
ok "live spawn: seeds the mesa-live agent definition into \$HOME/.claude/agents"

# It never overwrites: after the first seed the file belongs to the library
# sync flow, where the user picks a winner between disk and mesa.
printf 'sentinel, hand-edited\n' > "$SEEDED"
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live start "$PROJ"
[ "$(cat "$SEEDED")" = "sentinel, hand-edited" ] ||
  fail "live spawn: an existing agent definition must be left byte-identical"
ok "live spawn: never overwrites an existing mesa-live agent definition"

# ---- stopping the conversation stops its agent ----
#
# The other half of the spawn: hanging up finishes the background session
# rather than leaving one idling per conversation. The job named is the short
# id from the receipt, and nothing else.
rm -f "$STUB_DIR/last-stop"
STOP_AGENT=$(cat "$STUB_DIR/last-id")
run 0 "$MESA" live stop
[ "$(jqs .status)" = "ended" ] || fail "live stop: status must be ended"
[ "$(cat "$STUB_DIR/last-stop")" = "stop $STOP_AGENT" ] ||
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

# The folder every unbound agent runs in: `~/.mesa/workspace`, created on
# demand (mesa task 1040). Physically resolved, because a throwaway $HOME may
# sit behind a symlink and the stub records `pwd` in the child.
workspace_path() { (cd "$HOME/.mesa/workspace" && pwd -P); }

# By ID, and a project with no local_path: the folder degrades to the workspace
# rather than refusing to start (a conversation needs no checkout).
NOPATH=$("$MESA" project create "Live gate pathless" --no-git | jq -r .id)
run 0 "$MESA" live start --project "$NOPATH"
S4=$(jqs .id)
[ "$(jqs .project_id)" = "$NOPATH" ] || fail "live start --project <id>: project_id"
[ -d "$HOME/.mesa/workspace" ] ||
  fail "live spawn with no local_path: must create ~/.mesa/workspace on demand"
[ "$(cat "$STUB_DIR/last-cwd")" = "$(workspace_path)" ] ||
  fail "live spawn with no local_path: must fall back to ~/.mesa/workspace (got $(cat "$STUB_DIR/last-cwd"))"
run 0 "$MESA" live stop >/dev/null
ok "live start --project <id>: resolves by id; a pathless project runs the agent in ~/.mesa/workspace"

# An unscoped session names itself `mesa live <id>` and also runs in the workspace.
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
[ "$(jqb .agent_id)" = "$(cat "$STUB_DIR/last-id")" ] || fail "POST /api/live: the spawn receipt must be bound"
API_AGENT=$(jqb .agent_id)
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
# arrive in ONE body because they are one statement about one moment: a page
# that reports both cannot have them disagree about which page a focus is on.
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

# The context key is THREE-way, and the three are genuinely different things
# to say (mesa task 1016). Omitting it is silence — "I have nothing to say
# about what is open" — and leaves the stored context exactly as it is, which
# is the only report a client with no notion of a focused file can ever make.
# The route itself is required, so it is always written either way.
api 200 POST "/api/live/route" '{"route":"#/inbox"}'
[ "$(jqb .context.kind)" = "files" ] ||
  fail "omitting the context must leave the stored one standing, not clear it"
[ "$(jqb .context.id)" = "src/core/store.rs" ] ||
  fail "omitting the context must leave every field of it standing"
[ "$(jqb .route)" = "#/inbox" ] || fail "…while the route is always written"

# An explicit null is the other half: the page stating that nothing is
# selected. That is what mesa's own page sends when its editor is empty, and
# it still clears.
api 200 POST "/api/live/route" '{"route":"#/inbox","context":null}'
[ "$(jqb .context)" = "null" ] || fail "an explicit null context must clear what was selected"

# …and a value replaces whatever was there.
api 200 POST "/api/live/route" "$CTX"
[ "$(jqb .context.kind)" = "files" ] || fail "re-reporting the context must record it again"
api 200 POST "/api/live/route" '{"route":"#/inbox","context":null}'
[ "$(jqb .context)" = "null" ] || fail "an explicit null context must clear it again"
ok "the context key is three-way: omitted keeps, null clears, a value replaces"

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
[ "$(cat "$STUB_DIR/last-stop")" = "stop $API_AGENT" ] ||
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

# The same three-way key as the context — and the box is the reason it had to
# become one, since `mesa live look` has nothing else to go on and no second
# client will ever put a box back once one is lost.
api 200 POST "/api/live/route" '{"route":"#/inbox"}'
[ "$(jqb .window.x)" = "118" ] ||
  fail "omitting the window must leave the stored box standing, not clear it"
[ "$(jqb .window.width)" = "1512" ] || fail "omitting the window must leave every field of it"
api 200 POST "/api/live/route" '{"route":"#/inbox","window":null}'
[ "$(jqb .window)" = "null" ] || fail "an explicit null window must clear the stored box"
ok "the window box is three-way too: omitted keeps the box, null clears it"

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

# ---- two clients, one conversation (mesa task 1016) ----
#
# The scenario the three-way key exists for. A desktop browser reports all
# three parts; the person then picks up their phone, whose page reports a route
# and nothing else — it has no focused file and no window box, and never will.
# Under the old complete-statement rule that report erased both for the rest of
# the session, so `mesa live look` could never find the window again. Now the
# last client that actually KNEW something still holds the answer, while the
# route is whoever reported most recently.
api 200 POST "/api/live/route" \
  "{\"route\":\"#/projects/7/files\",\"context\":{\"kind\":\"files\",\"id\":\"src/api.rs\",\"label\":\"api.rs\"},\"window\":$LOOKBOX}"
api 200 POST "/api/live/route" '{"route":"#/inbox"}'
[ "$(jqb .route)" = "#/inbox" ] || fail "two clients: the phone's route must be the recorded one"
[ "$(jqb .context.label)" = "api.rs" ] ||
  fail "two clients: the desktop's context must survive a phone that never had one"
[ "$(jqb .window.width)" = "1512" ] ||
  fail "two clients: the desktop's window box must survive a phone that has none"

# …and the agent reads the surviving box over its own Store, which is what
# `mesa live look` matches a real window against below.
run 0 "$MESA" live status
[ "$(jqs .window.x)" = "118" ] || fail "two clients: the CLI must still see the desktop's box"
[ "$(jqs .window.height)" = "982" ] || fail "two clients: the CLI must still see its height"
ok "two clients on one session: a route-only report keeps the context and box it cannot speak for"

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
#
# /api/live/transcribe rides in this same loop in default mode ONLY: under
# --lan the route does not exist at all (section 12), so the loop's "must be
# 415" expectation would not hold there.
for p in "/api/live" "/api/live/utterance" "/api/live/route" "/api/live/turns/$SPOKEN/played" \
         "/api/live/transcribe"; do
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
ok "Content-Type gate: every live mutation (POST ×5, DELETE) is 415 without JSON; GET is exempt"

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

# =====================================================================
# 11. Session memory (mesa task 921): `mesa live summary` + the live-summary
#     spawn on `live stop`
# =====================================================================

SUMMARY_MAX=$(grep -Eo 'pub const LIVE_SUMMARY_MAX: usize = [0-9]+' src/core/store.rs |
  grep -Eo '[0-9]+$')
[ -n "$SUMMARY_MAX" ] || fail "could not read LIVE_SUMMARY_MAX from src/core/store.rs"

# ---- the CLI round-trip ----

run 0 "$MESA" live start --no-agent
SUM1=$(jqs .id)
run 0 "$MESA" live say "Talked about the roadmap."
run 0 "$MESA" live stop
[ "$(jqs .id)" = "$SUM1" ] || fail "session memory setup: stop must echo $SUM1"

run 0 "$MESA" live summary set "$SUM1" Discussed the roadmap and opened task 42.
[ "$(jqs .session_id)" = "$SUM1" ] || fail "live summary set: session_id"
[ "$(jqs .body)" = "Discussed the roadmap and opened task 42." ] ||
  fail "live summary set: trailing words are joined into the body"
[ "$(jqs .updated_at)" = "$(jqs .created_at)" ] ||
  fail "live summary set: a fresh row's updated_at must equal its created_at"
ok "live summary set: upserts a fresh row, trailing words joined into the body"

run 0 "$MESA" live summary show "$SUM1"
[ "$(jqs .session_id)" = "$SUM1" ] || fail "live summary show: session_id"
[ "$(jqs .body)" = "Discussed the roadmap and opened task 42." ] || fail "live summary show: body"
ok "live summary show: the stored record"

run 0 "$MESA" live summary list
[ "$(jqs type)" = "array" ] || fail "live summary list: bare array"
[ "$(jqs '.[0].session_id')" = "$SUM1" ] ||
  fail "live summary list: newest first, must include the row just set"
ok "live summary list: a bare array, newest first"

# ---- the --quiet contract ----

run 0 "$MESA" live summary set --quiet "$SUM1" Second summary, replacing the first.
printf '%s' "$STDOUT" >"$TMP/summary-quiet.json"
[ "$(jqs 'has("body")')" = "false" ] || fail "live summary set --quiet: body must be dropped"
[ "$(jqs .session_id)" = "$SUM1" ] || fail "live summary set --quiet: session_id must survive"
run 0 "$MESA" live summary show "$SUM1"
printf '%s' "$STDOUT" >"$TMP/summary-full.json"
[ "$(jqs .body)" = "Second summary, replacing the first." ] ||
  fail "live summary set --quiet: must still have written the full record"
jq -e --slurpfile q "$TMP/summary-quiet.json" 'del(.body) == $q[0]' "$TMP/summary-full.json" >/dev/null ||
  fail "live summary set --quiet: must be the full record minus \`body\` and nothing else"
ok "live summary set --quiet: the full record minus \`body\`, every other key present and equal"

run 0 "$MESA" live summary show "$SUM1" --quiet
[ "$(jqs 'has("body")')" = "false" ] || fail "live summary show --quiet: body must be dropped"
[ "$(jqs .session_id)" = "$SUM1" ] || fail "live summary show --quiet: session_id must survive"
ok "live summary show --quiet: the same projection as set"

run 2 "$MESA" live summary list --quiet
[ -z "$STDOUT" ] || fail "live summary list --quiet: stdout must be empty on a usage error"
[ "$(jqe .error.code)" = "usage" ] || fail "live summary list --quiet: error.code"
ok "live summary list --quiet: unknown argument, exit 2, empty stdout"

# `--quiet` typed AFTER the id/text is spoken into the body, never parsed as
# the flag — the exact trap `live say` sets, since everything after the id
# that is not a LEADING flag is swallowed as the summary text.
run 0 "$MESA" live summary set "$SUM1" A note that mentions --quiet in passing.
[ "$(jqs .body)" = "A note that mentions --quiet in passing." ] ||
  fail "live summary set: --quiet typed after the text must land in the body, not be parsed as the flag"
ok "live summary set: --quiet after the text is spoken into the body, exactly like \`live say\`"

# ---- validation and errors ----

run 1 "$MESA" live summary set "$SUM1" ""
[ "$(jqe .error.code)" = "validation" ] || fail "live summary set with an empty body: error.code"
run 1 "$MESA" live summary set "$SUM1" "   "
[ "$(jqe .error.code)" = "validation" ] ||
  fail "live summary set with a whitespace-only body: trimmed, so this is validation too"
ok "live summary set: an empty or whitespace-only body is validation"

LONG_SUMMARY=$(printf 'x%.0s' $(seq 1 $((SUMMARY_MAX + 1))))
run 1 "$MESA" live summary set "$SUM1" "$LONG_SUMMARY"
[ "$(jqe .error.code)" = "validation" ] || fail "an over-long summary body: error.code"
grep -q "$SUMMARY_MAX" <<<"$STDERR" || fail "the summary bound must name itself in the message"
run 0 "$MESA" live summary set "$SUM1" "$(printf 'x%.0s' $(seq 1 "$SUMMARY_MAX"))"
[ "$(jqs '.body | length')" = "$SUMMARY_MAX" ] ||
  fail "a body of exactly $SUMMARY_MAX chars must be accepted (inclusive bound)"
ok "live summary body is capped at $SUMMARY_MAX chars: accepted at the bound, validation past it"

run 1 "$MESA" live summary set 999999 "fine"
[ "$(jqe .error.code)" = "not_found" ] || fail "live summary set on an unknown session: error.code"
run 1 "$MESA" live summary show 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "live summary show on an unknown session: error.code"
ok "live summary set/show on an unknown session: not_found"

run 2 "$MESA" live summary set
[ "$(jqe .error.code)" = "usage" ] || fail "live summary set with no id/text: error.code"
ok "live summary set with no arguments: usage, exit 2"

# ---- upsert: keeps created_at, moves updated_at ----

run 0 "$MESA" live start --no-agent
SUM2=$(jqs .id)
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live summary set "$SUM2" "first pass"
FIRST_CREATED=$(jqs .created_at)
FIRST_UPDATED=$(jqs .updated_at)
sleep 1
run 0 "$MESA" live summary set "$SUM2" "replaced pass"
[ "$(jqs .body)" = "replaced pass" ] || fail "live summary set (second write): body must be replaced"
[ "$(jqs .created_at)" = "$FIRST_CREATED" ] || fail "live summary set (second write): created_at must not move"
[ "$(jqs .updated_at)" != "$FIRST_UPDATED" ] || fail "live summary set (second write): updated_at must move"
ok "live summary set: a second write upserts — body replaced, created_at kept, updated_at moved"

# ---- turns --session: reads an ended session's turns ----

run 0 "$MESA" live start --no-agent
SUM3=$(jqs .id)
run 0 "$MESA" live say "one thing"
run 0 "$MESA" live say "another thing"
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live turns --session "$SUM3"
[ "$(jqs type)" = "array" ] || fail "live turns --session: bare array"
[ "$(jqs length)" = "2" ] || fail "live turns --session: must read the ended session's own turns"
run 1 "$MESA" live turns --session 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "live turns --session <unknown>: error.code"
ok "live turns --session: reads an ended session's turns; an unknown session id is not_found"

# ---- the spawn: `live stop` fires the live-summary template ----
#
# `--no-agent` throughout, so the only \`--bg\` invocation the stub can see
# comes from the summariser, never from a live-agent spawn — isolating it
# from section 4's spawn assertions.

rm -f "$STUB_DIR/last-argc"
run 0 "$MESA" live start --no-agent
SUM4=$(jqs .id)
run 0 "$MESA" live say "We renamed the project."
run 0 "$MESA" live stop
[ -e "$STUB_DIR/last-argc" ] ||
  fail "live stop on a session with turns must spawn its summariser"
EXPECTED_SUMMARY_FLAGS="--bg
--agent
swe
--name
mesa live $SUM4 summary
--"
[ "$(cat "$STUB_DIR/last-flags")" = "$EXPECTED_SUMMARY_FLAGS" ] ||
  fail "live-summary spawn argv: expected
$EXPECTED_SUMMARY_FLAGS
got
$(cat "$STUB_DIR/last-flags")"
grep -q 'Your only job is to write down what it was about' "$STUB_DIR/last-prompt" ||
  fail "live-summary spawn: the prompt argument must be core::live's summariser instructions"
grep -q "summarising mesa live session $SUM4" "$STUB_DIR/last-prompt" ||
  fail "live-summary spawn: the prompt must name the session it is summarising"
# The summariser is an unbound agent too — this session has no project, so it
# must run in the workspace, never in $HOME (mesa task 1040: Claude Code never
# persists folder trust for the home directory).
[ "$(cat "$STUB_DIR/last-cwd")" = "$(workspace_path)" ] ||
  fail "live-summary spawn: an unbound summariser must run in ~/.mesa/workspace (got $(cat "$STUB_DIR/last-cwd"))"
ok "live stop: spawns the live-summary template — the argv shape, the session name, one prompt argument, the workspace cwd"

# ---- the recall join: a stored summary reaches the NEXT conversation's
#      spawned prompt (store -> prompt -> spawn_bg -> argv) ----
#
# `agent_prompt_appends_stored_summaries_as_recall` (Rust) pins the function;
# the spawn assertions above pin that *a* prompt reaches the argv. Neither
# pins the two joined up, which is the seam a refactor could break silently
# with every unit test still green — so this is checked as a fact about the
# argv actually sent, not about what a function returned.
RECALL_TEXT="RECALL-MARKER: onboarded the new intern and closed task 77."
run 0 "$MESA" live start --no-agent
RECALL_SESSION=$(jqs .id)
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live summary set "$RECALL_SESSION" "$RECALL_TEXT"
# The notebook (mesa task 1147) rides in the same prompt, ahead of the
# summary — so one spawn proves both joins and their order.
NOTE_TEXT="NOTE-MARKER: prefers short spoken replies."
run 0 "$MESA" live memory add "$NOTE_TEXT"
NOTE_ID=$(jqs .id)

run 0 "$MESA" live start
grep -q "$RECALL_TEXT" "$STUB_DIR/last-prompt" ||
  fail "a stored summary must reach the very next live-agent spawn's prompt as recall"
grep -q -- "- \[#$NOTE_ID, added [0-9-]*, from session [0-9]*, last used session [0-9]*\] $NOTE_TEXT" \
  "$STUB_DIR/last-prompt" ||
  fail "the notebook entry must reach the spawned prompt as a provenance-labelled line (got: $(cat "$STUB_DIR/last-prompt"))"
# Recall is the single most recent summary: the older ones written above
# (sessions $SUM1, $SUM2) must NOT ride along — they are the archive's now.
[ "$(grep -c '^Session [0-9]*: ' "$STUB_DIR/last-prompt")" = "1" ] ||
  fail "exactly one summary must ride in the prompt (mesa task 1147: recall is last-1), got: $(cat "$STUB_DIR/last-prompt")"
grep -q "Session $RECALL_SESSION: $RECALL_TEXT" "$STUB_DIR/last-prompt" ||
  fail "the one recalled summary must be the most recent session's"
! grep -q "replaced pass" "$STUB_DIR/last-prompt" ||
  fail "an older summary (session $SUM2's) must not ride in the prompt"
NOTE_POS=$(grep -bo "$NOTE_TEXT" "$STUB_DIR/last-prompt" | head -1 | cut -d: -f1)
# Ordering matters: a summary is derived from dictated speech — untrusted
# text — and untrusted text may not sit above the rules (the plan's posture).
# An argv log is the only place this can be checked as a fact about what was
# actually sent, rather than about what `prompt_with` returned in isolation.
SESSION_POS=$(grep -bo 'Drive mesa live session' "$STUB_DIR/last-prompt" | head -1 | cut -d: -f1)
RECALL_POS=$(grep -bo "$RECALL_TEXT" "$STUB_DIR/last-prompt" | head -1 | cut -d: -f1)
[ -n "$SESSION_POS" ] || fail "recall join: could not find the session line in the spawned prompt"
[ -n "$RECALL_POS" ] || fail "recall join: could not find the recall text in the spawned prompt"
[ "$RECALL_POS" -gt "$SESSION_POS" ] ||
  fail "recall must be appended AFTER the session line, never before — untrusted text may not outrank the rules"
[ "$NOTE_POS" -gt "$SESSION_POS" ] && [ "$NOTE_POS" -lt "$RECALL_POS" ] ||
  fail "the notebook must come after the session line and before the summary"
run 0 "$MESA" live stop >/dev/null
ok "the notebook and the single most recent summary reach the next conversation's spawned prompt, in that order, after the session line"

# ---- guard: a session with no turns spawns no summariser ----
rm -f "$STUB_DIR/last-argc"
run 0 "$MESA" live start --no-agent
run 0 "$MESA" live stop
[ ! -e "$STUB_DIR/last-argc" ] ||
  fail "live stop on a session with NO turns must not spawn a summariser"
ok "live stop on a session with no turns: no summariser is spawned"

# ---- guard: a second stop of an already-ended session spawns nothing ----
rm -f "$STUB_DIR/last-argc"
run 1 "$MESA" live stop
[ "$(jqe .error.code)" = "not_found" ] || fail "a second stop of an already-ended session: error.code"
[ ! -e "$STUB_DIR/last-argc" ] ||
  fail "a second stop of an already-ended session must not spawn another summariser"
ok "a second stop of an already-ended session: not_found, and nothing is spawned"

# ---- append-only: a write for an OLD session is readable back immediately,
#      and no row is ever pruned (mesa task 1147) ----
#
# The first cut kept the newest 20 summaries; every summary is now part of
# the searchable archive, so nothing prunes it. A session summarised long
# after dozens of newer ones is the ordering a burst of short conversations
# produces while an older one's background summariser catches up.

run 0 "$MESA" live start --no-agent
OLD_SESSION=$(jqs .id)
run 0 "$MESA" live stop >/dev/null
for i in $(seq 1 25); do
  run 0 "$MESA" live start --no-agent
  NEWER_SESSION=$(jqs .id)
  run 0 "$MESA" live stop >/dev/null
  run 0 "$MESA" live summary set "$NEWER_SESSION" "filler summary $i"
done
run 0 "$MESA" live summary set "$OLD_SESSION" "an older conversation, summarised last"
[ "$(jqs .body)" = "an older conversation, summarised last" ] ||
  fail "a summary write must be readable back in its own response"
run 0 "$MESA" live summary show "$OLD_SESSION"
[ "$(jqs .body)" = "an older conversation, summarised last" ] ||
  fail "a summary for a session older than 25 already-summarised ones must still be readable back"
run 0 "$MESA" live summary show "$SUM1"
[ "$(jqs '.body | length')" = "$SUMMARY_MAX" ] ||
  fail "the very first summary (last set to exactly $SUMMARY_MAX chars) must survive 25+ later ones: the archive is append-only"
# SUM1, SUM2, SUM4's would-be (none — the stub summariser writes nothing),
# RECALL_SESSION, OLD_SESSION and the 25 fillers: 29 distinct sessions.
run 0 "$MESA" live summary list --limit 500
[ "$(jqs length)" = "29" ] ||
  fail "every summary written so far must still be listed: expected 29, got $(jqs length)"
ok "live summary: append-only — a late write for an old session lands, and no earlier row is pruned"

# ---- cascade: deleting a session's project must not destroy its summary ----
#
# `project_id` is ON DELETE SET NULL on `live_sessions` (not CASCADE, unlike
# `live_summaries.session_id` on `live_sessions.id`), so deleting the project
# must leave the session's turns and summary alone. There is no CLI command
# that deletes a live session directly, so this is as far as the cascade can
# be reached from the CLI.

CASCADE_PROJ=$("$MESA" project create "live memory cascade" --no-git | jq -r .id)
run 0 "$MESA" live start --no-agent --project "$CASCADE_PROJ"
CASCADE_SESSION=$(jqs .id)
run 0 "$MESA" live say "one more thing worth remembering"
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live summary set "$CASCADE_SESSION" "notes worth keeping"
run 0 "$MESA" project delete "$CASCADE_PROJ"
run 0 "$MESA" live summary show "$CASCADE_SESSION"
[ "$(jqs .body)" = "notes worth keeping" ] ||
  fail "deleting a session's project must not destroy its summary"
run 0 "$MESA" live turns --session "$CASCADE_SESSION"
[ "$(jqs length)" = "1" ] || fail "deleting a session's project must not destroy its turns either"
ok "deleting a session's project: its summary and turns both survive (project_id is SET NULL, not CASCADE)"

# =====================================================================
# 12. POST /api/live/transcribe — recorded audio in, text out (mesa task 954)
# =====================================================================
#
# Transcribing a recording is stateless — no live session is involved, see
# `listen::transcribe`'s own doc comment — so this section needs nothing from
# section 11's CLI-only work but a fresh server. `LIVE_AUDIO_MAX` is read out
# of the source rather than hardcoded, the same way section 11 reads
# LIVE_SUMMARY_MAX/KEEP.
LIVE_AUDIO_MAX_EXPR=$(grep -Eo 'pub const LIVE_AUDIO_MAX: usize = [^;]+;' src/core/store.rs |
  sed -E 's/.*= (.*);/\1/')
[ -n "$LIVE_AUDIO_MAX_EXPR" ] || fail "could not read LIVE_AUDIO_MAX from src/core/store.rs"
LIVE_AUDIO_MAX=$((LIVE_AUDIO_MAX_EXPR))

PORT=17781
BASE="http://127.0.0.1:$PORT"

# ---- a missing binary, checked with its own short-lived server ----
#
# MESA_AURIS_BIN is read by the child process at spawn time, so it has to be
# wrong BEFORE the server starts — changing the shell's export after a server
# is already running would never reach it.
MESA_AURIS_BIN="$STUB_DIR/no-such-auris" "$MESA" serve --port "$PORT" >"$TMP/serve-nobin.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/live" >/dev/null ||
  fail "server (missing auris binary) did not start (log: $(cat "$TMP/serve-nobin.log"))"
NOBIN_BODY=$(jq -n --arg a "$(printf 'AAAA' | base64)" '{audio_base64: $a}')
api 503 POST "/api/live/transcribe" "$NOBIN_BODY"
[ "$(jqb .error.code)" = "unavailable" ] ||
  fail "transcribe with a missing auris binary: error.code must be unavailable"
ok "POST /api/live/transcribe: a missing auris binary is 503 unavailable"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ---- the real server, stubbed auris in place ----
"$MESA" serve --port "$PORT" >"$TMP/serve12.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/live" >/dev/null ||
  fail "server did not start for section 12 (log: $(cat "$TMP/serve12.log"))"

# ---- round-trip: a real recording, byte-identical on the stub's stdin ----
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

# ---- last transcript line wins; an unrecognised type is ignored ----
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

# ---- unavailable: a nonzero exit, and a run with no transcript line ----
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

# ---- over-cap body: 413, JSON, naming the limit ----
#
# One byte past LIVE_AUDIO_MAX decoded — generated with head -c/base64 rather
# than jq, and posted as a single request; slow to build, so there is exactly
# one of these.
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

# ---- non-audio / malformed bodies: 422, never 413 ----
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

# ---- both halves of the boundary, default mode ----
raw POST "/api/live/transcribe"
[ "$STATUS" = "415" ] || fail "transcribe without Content-Type: expected 415, got $STATUS"
raw POST "/api/live/transcribe" -d 'audio_base64=form+post'
[ "$STATUS" = "415" ] || fail "form-encoded transcribe: expected 415, got $STATUS"
[ "$(origin_status POST "/api/live/transcribe" 'https://evil.example' "$TRANSCRIBE_BODY")" = "403" ] ||
  fail "transcribe with a foreign Origin must be 403 (the agent gate)"
raw POST "/api/live/transcribe" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d "$TRANSCRIBE_BODY"
[ "$STATUS" = "403" ] || fail "transcribe with a bogus Host: expected 403, got $STATUS"
[ "$(origin_status POST "/api/live/transcribe" 'http://localhost:7770' "$TRANSCRIBE_BODY")" = "200" ] ||
  fail "transcribe from a local Origin must reach the handler"
ok "transcribe: Content-Type gate (415 with no/form Content-Type) and agent gate (403 foreign Origin/Host, 200 local) — the same pair speak/start/stop carry"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ---- --lan: the route is PRESENT and relaxed, not absent ----
#
# `/api/live/transcribe` is registered unconditionally (`src/api.rs`), both
# verbs on the one entry, and its `require_agent_access` **relaxes rather than
# refuses** under --lan — the posture every other agent route already takes.
# Decoding a posted recording is strictly less power than the shell --lan
# already hands the whole network through the Agents and Terminal routes, so
# refusing the phone a transcription while granting it a terminal would be a
# distinction with no security content. `mesa live look` keeps the structural
# refusal instead, because photographing the owner's screen is a genuinely
# different capability rather than a stronger one, not merely a bigger one.
#
# The two confused-deputy defenses are untouched by that relaxation: the
# Content-Type gate below still fires in this mode, exactly as it does in
# default mode.
LAN_PORT=17782
LAN_BASE="http://127.0.0.1:$LAN_PORT"
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan12.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$LAN_BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$LAN_BASE/api/live" >/dev/null ||
  fail "LAN server did not start for section 12 (log: $(cat "$TMP/lan12.log"))"

# A LAN page this server handed a phone reaches the decoder, and the recording
# reaches auris exactly as it does in default mode.
rm -f "$STUB_DIR/last-argv"
STATUS=$(curl -s -o "$TMP/lan-body" -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "$TRANSCRIBE_BODY" "$LAN_BASE/api/live/transcribe")
LAN_BODY=$(cat "$TMP/lan-body")
[ "$STATUS" = "200" ] ||
  fail "--lan: POST /api/live/transcribe must reach the handler, got $STATUS ($LAN_BODY)"
[ "$(jq -r .text <<<"$LAN_BODY")" = "hello there" ] ||
  fail "--lan: the stub's transcript must come back, got $LAN_BODY"
[ "$(cat "$STUB_DIR/last-argv")" = "-q --format json" ] ||
  fail "--lan: auris must be run with the same argv as in default mode, got $(cat "$STUB_DIR/last-argv" 2>/dev/null)"
ok "--lan: POST /api/live/transcribe reaches the stub auris with the same argv — require_agent_access relaxes rather than refuses, the posture every agent route takes"

# The GET half rides the same route entry, so a LAN page reads the same real
# answer a default-mode page does rather than a hard-coded false.
STATUS=$(curl -s -o "$TMP/lan-avail" -w '%{http_code}' "$LAN_BASE/api/live/transcribe")
LAN_AVAIL=$(cat "$TMP/lan-avail")
[ "$STATUS" = "200" ] ||
  fail "--lan: GET /api/live/transcribe expected 200, got $STATUS ($LAN_AVAIL)"
[ "$(jq -r .available <<<"$LAN_AVAIL")" = "true" ] ||
  fail "--lan: GET /api/live/transcribe must answer available:true against a working stub, got $LAN_AVAIL"
ok "--lan: GET /api/live/transcribe answers {\"available\": true} off the same route entry — both verbs are present, not just the POST"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -d 'audio_base64=form+post' "$LAN_BASE/api/live/transcribe")
[ "$STATUS" = "415" ] ||
  fail "--lan: the Content-Type gate must still fire, got $STATUS"
ok "--lan: the Content-Type gate still rejects a form-encoded POST — the cross-site defense is untouched by the agent gate relaxing"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

# =====================================================================
# 13. The whiteboard: `mesa live board` and the render route (task 1071)
# =====================================================================
#
# A board is a picture the agent puts in front of the person — a sibling
# table, not a turn, and ephemeral: it belongs to the conversation until
# `keep` copies it into a project. Covered here: the four kinds and where
# each one's body comes from, the required-source ArgGroup, the --quiet key
# sets and the two commands that refuse the flag, `clear`'s echo, both `keep`
# destinations and the image-cannot-be-an-artifact rule, `LiveState.boards`
# bodiless and capped, and the render route's exact headers in default mode
# AND under --lan (they must be identical: the CSP is the defense, not the
# caller's identity).

# Nothing is live after section 12; every board verb needs a conversation.
run 1 "$MESA" live board push hello
[ "$(jqe .error.code)" = "not_found" ] || fail "live board push with no session: error.code"
grep -q 'mesa live start' <<<"$STDERR" ||
  fail "live board push with no session: the message must name \`mesa live start\`"
run 1 "$MESA" live board list
[ "$(jqe .error.code)" = "not_found" ] || fail "live board list with no session: error.code"
ok "every live board verb with no session: exit 1 not_found, hinting at \`live start\`"

run 0 "$MESA" live start --project "$PROJ" --no-agent
BS=$(jqs .id)

# ---- the four kinds, and where each body comes from ----

run 0 "$MESA" live board push --quiet --title "The plan" '## Plan' 'Three steps.'
B_MD=$(jqs .id)
[ "$(jqs .kind)" = "markdown" ] || fail "board push: a text body is markdown by default"
[ "$(jqs .title)" = "The plan" ] || fail "board push: --title"
[ "$(jqs .content_type)" = "null" ] ||
  fail "board push: only an image board records a content_type"
jq -e 'has("body") | not' <<<"$STDOUT" >/dev/null ||
  fail "board push --quiet must drop the body"
run 0 "$MESA" live board show "$B_MD"
[ "$(jqs .body)" = "## Plan Three steps." ] ||
  fail "board push: the trailing var-arg body is joined with spaces, got $(jqs .body)"

printf '<h1>Mockup</h1>\n' > "$TMP/mockup.html"
run 0 "$MESA" live board push --kind html --file "$TMP/mockup.html" --say "Here is the mockup."
B_HTML=$(jqs .id)
[ "$(jqs .kind)" = "html" ] || fail "board push --kind html"
[ "$(jqs .body)" = "<h1>Mockup</h1>" ] || fail "board push --file: the file IS the body"
# --say adds an ordinary mesa turn beside the board, exactly like navigate --say.
[ "$("$MESA" live turns | jq -r '.[-1].text')" = "Here is the mockup." ] ||
  fail "board push --say must speak a mesa turn alongside the board"
[ "$("$MESA" live turns | jq -r '.[-1].action')" = "null" ] ||
  fail "board push --say: a board is not an action — the turn carries none"

# The extension names the kind when --kind does not.
printf '# From a file\n' > "$TMP/note.md"
run 0 "$MESA" live board push --file "$TMP/note.md"
[ "$(jqs .kind)" = "markdown" ] || fail "board push --file note.md: the extension names the kind"
run 0 "$MESA" live board push --file "$TMP/mockup.html"
[ "$(jqs .kind)" = "html" ] || fail "board push --file mockup.html: the extension names the kind"

# An image is stored as base64 IN the board — self-contained, so nothing on
# disk is read again — and its content_type comes from the extension allowlist.
printf '\x89PNG\r\n\x1a\nmesa-live-board' > "$TMP/shot.png"
run 0 "$MESA" live board push --image "$TMP/shot.png" --title "The overlap"
B_IMG=$(jqs .id)
[ "$(jqs .kind)" = "image" ] || fail "board push --image: kind"
[ "$(jqs .content_type)" = "image/png" ] ||
  fail "board push --image: the content_type comes from the extension allowlist"
SHOT_BYTES=$(wc -c < "$TMP/shot.png" | tr -d ' ')
[ "$(jqs .body | base64 --decode | wc -c | tr -d ' ')" = "$SHOT_BYTES" ] ||
  fail "board push --image: the body is base64 of the file's own bytes"
# The allowlist decides, not a sniff: a non-image extension never becomes a board.
printf 'not an image\n' > "$TMP/notes.txt"
run 1 "$MESA" live board push --image "$TMP/notes.txt"
[ "$(jqe .error.code)" = "validation" ] || fail "board push --image <non-image>: error.code"
run 1 "$MESA" live board push --image "$TMP/no-such-file.png"
[ "$(jqe .error.code)" = "validation" ] || fail "board push --image <missing>: error.code"

# A diagram board is a SNAPSHOT: the SVG is rendered at push time and never
# tracks the canvas again.
DIA=$("$MESA" diagram create "$PROJ" "Board flow" | jq -r .id)
"$MESA" diagram frame create "$DIA" "Start" --x 10 --y 10 >/dev/null
"$MESA" diagram frame create "$DIA" '<script>alert(1)</script>' --x 300 --y 200 >/dev/null
run 0 "$MESA" live board push --diagram "$DIA" --title "The flow"
B_SVG=$(jqs .id)
[ "$(jqs .kind)" = "diagram" ] || fail "board push --diagram: kind"
grep -q '<svg' <<<"$(jqs .body)" || fail "board push --diagram: the body must be SVG markup"
grep -q '>Start</text>' <<<"$(jqs .body)" || fail "board push --diagram: a frame title must be drawn"
grep -q '<script>' <<<"$(jqs .body)" &&
  fail "board push --diagram: a frame title must be ESCAPED — this is markup a browser parses"
grep -q '&lt;script&gt;' <<<"$(jqs .body)" || fail "board push --diagram: the escaped title is missing"
# The snapshot is frozen: renaming the frame afterwards changes nothing.
SNAP_FRAME=$("$MESA" diagram show "$DIA" | jq -r '.frames[0].id')
"$MESA" diagram frame update --title "Renamed" "$SNAP_FRAME" >/dev/null
run 0 "$MESA" live board show "$B_SVG"
grep -q '>Start</text>' <<<"$(jqs .body)" ||
  fail "board push --diagram is a SNAPSHOT: a later canvas edit must not change it"
ok "live board push: all four kinds — a text body, --file (kind from the extension), --image (base64 + allowlisted content_type) and --diagram (an escaped, frozen SVG snapshot) — plus --say speaking beside it"

# ---- the required source, and the other usage errors ----

run 2 "$MESA" live board push
[ -z "$STDOUT" ] || fail "live board push with no source: stdout must be empty"
[ "$(jqe .error.code)" = "usage" ] || fail "live board push with no source: error.code"
run 2 "$MESA" live board push --image "$TMP/shot.png" --diagram "$DIA"
[ "$(jqe .error.code)" = "usage" ] || fail "live board push with two sources: error.code"
run 2 "$MESA" live board push --file "$TMP/note.md" body words
[ "$(jqe .error.code)" = "usage" ] || fail "live board push with --file AND a body: error.code"
run 2 "$MESA" live board push --kind html --image "$TMP/shot.png"
[ "$(jqe .error.code)" = "usage" ] || fail "live board push --kind with --image: error.code"
run 2 "$MESA" live board push --kind sideways body
[ "$(jqe .error.code)" = "usage" ] || fail "live board push --kind <junk>: a closed vocabulary"
run 2 "$MESA" live board keep
[ "$(jqe .error.code)" = "usage" ] || fail "live board keep with no destination: error.code"
run 2 "$MESA" live board keep --project "$PROJ" --task 1
[ "$(jqe .error.code)" = "usage" ] || fail "live board keep with both destinations: error.code"
run 2 "$MESA" live board list --quiet
[ -z "$STDOUT" ] || fail "live board list --quiet: stdout must be empty on a usage error"
[ "$(jqe .error.code)" = "usage" ] || fail "live board list --quiet: error.code"
ok "live board usage errors are exit 2: no source, two sources, --kind on a non-text source, no destination, both destinations, and --quiet on \`list\`"

# ---- list, show and the --quiet key sets (jq, never byte-for-byte) ----

run 0 "$MESA" live board list
[ "$(jqs 'type')" = "array" ] || fail "live board list: a bare array"
[ "$(jqs '.[0].id')" = "$B_MD" ] || fail "live board list: oldest first"
[ "$(jqs '.[-1].id')" = "$B_SVG" ] || fail "live board list: the newest is last"
jq -e 'map(has("body")) | any | not' <<<"$STDOUT" >/dev/null ||
  fail "live board list: the history is bodiless — one body is fetched by the render route"
run 0 "$MESA" live board show
[ "$(jqs .id)" = "$B_SVG" ] || fail "live board show with no id: the board that is showing"
FULL=$("$MESA" live board show "$B_MD" | jq -S 'keys')
QUIET=$("$MESA" live board show --quiet "$B_MD" | jq -S 'keys')
[ "$(jq -r 'length' <<<"$FULL")" = "7" ] || fail "LiveBoard key count changed: $FULL"
[ "$(jq -c 'map(select(. != "body"))' <<<"$FULL")" = "$(jq -c '.' <<<"$QUIET")" ] ||
  fail "live board show --quiet must drop exactly \`body\`: $FULL vs $QUIET"
ok "live board list/show: oldest-first, bodiless history; --quiet drops exactly \`body\`"

# ---- keep: an artifact, an attachment, and the rule between them ----

run 0 "$MESA" live board keep --id "$B_MD" --project "Live gate project"
ART=$(jqs .id)
[ "$(jqs .content_type)" = "text/markdown" ] || fail "board keep --project: a markdown board is text/markdown"
[ "$(jqs .name)" = "The plan.md" ] || fail "board keep: the name defaults from the title + extension, got $(jqs .name)"
[ "$("$MESA" artifact show "$ART" | jq -r .body)" = "## Plan Three steps." ] ||
  fail "board keep --project: the artifact body is the board's own"
run 0 "$MESA" live board keep --id "$B_SVG" --project "$PROJ" --name flow.svg
[ "$(jqs .content_type)" = "image/svg+xml" ] || fail "board keep: a diagram board is image/svg+xml"

# An image cannot be an artifact — ARTIFACT_CONTENT_TYPES has no raster mime —
# and the error says where it CAN go.
run 1 "$MESA" live board keep --id "$B_IMG" --project "$PROJ"
[ "$(jqe .error.code)" = "validation" ] || fail "board keep: an image board is not an artifact"
grep -q -- '--task' <<<"$STDERR" || fail "board keep: the refusal must point at --task"

TASK=$("$MESA" task create "$PROJ" "Board gate task" | jq -r .id)
run 0 "$MESA" live board keep --id "$B_IMG" --task "$TASK"
[ "$(jqs .filename)" = "The overlap.png" ] ||
  fail "board keep --task: the name defaults from the title + extension, got $(jqs .filename)"
[ "$(jqs .content_type)" = "image/png" ] || fail "board keep --task: content_type"
[ "$(jqs .size_bytes)" = "$SHOT_BYTES" ] ||
  fail "board keep --task: the DECODED bytes are attached, not the base64"
[ "$(jqs .author)" = "mesa-live" ] || fail "board keep --task: author"
# An untitled board falls back to board-<id> plus its kind's extension.
run 0 "$MESA" live board keep --id "$B_HTML" --task "$TASK"
[ "$(jqs .filename)" = "board-$B_HTML.html" ] ||
  fail "board keep --task: an untitled board is board-<id>.<ext>, got $(jqs .filename)"
run 0 "$MESA" live board keep --id "$B_HTML" --task "$TASK" --name mockup.html
[ "$(jqs .filename)" = "mockup.html" ] || fail "board keep --name is used verbatim"
[ "$(jqs .size_bytes)" = "$(wc -c < "$TMP/mockup.html" | tr -d ' ')" ] ||
  fail "board keep --task: a text board attaches its own bytes, verbatim"
# The extension is always the kind's (or an image's recorded content_type's),
# never one read off the caption: a title claiming another format still gets
# the derived extension appended.
CAP=$("$MESA" live board push --quiet --image "$TMP/shot.png" --title "shot.jpg" | jq -r .id)
run 0 "$MESA" live board keep --id "$CAP" --task "$TASK"
[ "$(jqs .filename)" = "shot.jpg.png" ] ||
  fail "board keep: the extension comes from the board, not the title, got $(jqs .filename)"
ok "live board keep: into an artifact (content type by kind, name from the title) and onto a task (decoded image bytes, authored mesa-live); an image board refuses the artifact and names --task"

# A board from another conversation is not reachable by id: every verb here is
# scoped to the current session.
run 1 "$MESA" live board show 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "live board show <unknown>: error.code"
ok "live board show on a board this conversation does not own: not_found"

# ---- the poll payload: bodiless, and capped at the retention bound ----

for i in $(seq 1 22); do
  "$MESA" live board push --quiet --title "bulk $i" "body $i" >/dev/null
done
run 0 "$MESA" live board list --limit 100
[ "$(jqs 'length')" = "20" ] ||
  fail "live board list: the newest 20 survive a push, got $(jqs 'length')"
[ "$(jqs '.[-1].title')" = "bulk 22" ] || fail "live board list: the newest push is last"
run 0 "$MESA" live board show
[ "$(jqs .title)" = "bulk 22" ] || fail "each push replaces what is showing"
ok "live board push prunes to the newest 20 — that bound IS the history, and it keeps the 2s poll bounded"

# ---- clear: the delete echo ----

run 0 "$MESA" live board clear
[ "$(jqs 'length')" = "20" ] || fail "live board clear: the echo must carry every destroyed board"
jq -e 'map(has("body")) | any | not' <<<"$STDOUT" >/dev/null ||
  fail "live board clear: the echo is bodiless, like every other board listing"
run 0 "$MESA" live board list
[ "$STDOUT" = "[]" ] || fail "live board clear: nothing survives"
run 1 "$MESA" live board show
[ "$(jqe .error.code)" = "not_found" ] || fail "live board show with none pushed: error.code"
run 0 "$MESA" live board clear --quiet
[ "$STDOUT" = "[]" ] || fail "live board clear on an empty whiteboard: an empty echo, not an error"
ok "live board clear: echoes the destroyed boards (the delete-echo safety floor) and is empty-safe"

# ---- the render route, in DEFAULT mode ----

R_MD=$("$MESA" live board push --quiet --title "Rendered plan" '## Plan' | jq -r .id)
R_HTML=$("$MESA" live board push --quiet --kind html --file "$TMP/mockup.html" | jq -r .id)
R_SVG=$("$MESA" live board push --quiet --diagram "$DIA" | jq -r .id)
R_IMG=$("$MESA" live board push --quiet --image "$TMP/shot.png" | jq -r .id)

PORT=17781
BASE="http://127.0.0.1:$PORT"
"$MESA" serve --port "$PORT" >"$TMP/serve13.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/live" >/dev/null ||
  fail "server did not start for section 13 (log: $(cat "$TMP/serve13.log"))"

# The board history rides on the page's existing poll — bodiless, no second
# route to fetch it from.
BODY=$(curl -s "$BASE/api/live")
[ "$(jqb '.boards | length')" = "4" ] || fail "GET /api/live: boards must carry the history"
jq -e '.boards | map(has("body")) | any | not' <<<"$BODY" >/dev/null ||
  fail "GET /api/live: the boards in the poll must be bodiless"
[ "$(jqb '.boards[-1].id')" = "$R_IMG" ] || fail "GET /api/live: the last board is the one showing"
ok "GET /api/live: LiveState.boards is the whole history, oldest first and bodiless — no second poll route"

# CSP_EXPECTED is the artifact render route's policy, byte for byte: the two
# routes share one constant precisely so they cannot drift.
CSP_EXPECTED="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts"

board_headers() { # board_headers <base> <id> -> $TMP/bh, STATUS
  STATUS=$(curl -s -o "$TMP/bbody" -D "$TMP/bh" -w '%{http_code}' "$1/api/live/boards/$2/render")
}
header_of() { grep -i "^$1:" "$TMP/bh" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

check_board_render() { # check_board_render <base> <label>
  local base=$1 label=$2

  board_headers "$base" "$R_MD"
  [ "$STATUS" = "200" ] || fail "$label: markdown render expected 200, got $STATUS"
  [ "$(header_of content-type)" = "text/markdown; charset=utf-8" ] ||
    fail "$label: markdown Content-Type is $(header_of content-type)"
  [ "$(header_of x-content-type-options)" = "nosniff" ] || fail "$label: markdown nosniff"
  grep -qi '^content-disposition: inline;' "$TMP/bh" || fail "$label: markdown must be inline"
  [ "$(cat "$TMP/bbody")" = "## Plan" ] || fail "$label: markdown body must be byte-identical"

  board_headers "$base" "$R_HTML"
  [ "$(header_of content-type)" = "text/html; charset=utf-8" ] ||
    fail "$label: html Content-Type is $(header_of content-type)"
  [ "$(header_of content-security-policy)" = "$CSP_EXPECTED" ] ||
    fail "$label: the html CSP must be the artifact policy verbatim, got $(header_of content-security-policy)"
  [ "$(header_of x-content-type-options)" = "nosniff" ] || fail "$label: html nosniff"

  board_headers "$base" "$R_SVG"
  [ "$(header_of content-type)" = "image/svg+xml; charset=utf-8" ] ||
    fail "$label: diagram Content-Type is $(header_of content-type)"
  [ "$(header_of content-security-policy)" = "$CSP_EXPECTED" ] ||
    fail "$label: the diagram CSP must be the artifact policy verbatim"

  board_headers "$base" "$R_IMG"
  [ "$(header_of content-type)" = "image/png" ] ||
    fail "$label: image Content-Type must be the allowlisted mime, got $(header_of content-type)"
  [ "$(header_of x-content-type-options)" = "nosniff" ] || fail "$label: image nosniff"
  grep -qi '^content-disposition: inline;' "$TMP/bh" || fail "$label: image must be inline"
  cmp -s "$TMP/bbody" "$TMP/shot.png" ||
    fail "$label: the image must come back as the file's own bytes, decoded"

  board_headers "$base" 999999
  [ "$STATUS" = "404" ] || fail "$label: an unknown board must be 404, got $STATUS"
  [ "$(jq -r .error.code <"$TMP/bbody")" = "not_found" ] || fail "$label: unknown board error.code"
}

check_board_render "$BASE" "render (default mode)"
ok "GET /api/live/boards/{id}/render: markdown/html/diagram/image each with their own type, nosniff and inline, the artifact CSP on the two document kinds, byte-identical bodies, 404 for an unknown board"

# There is no write route: boards are pushed by the CLI and read by the
# browser, and the panel's close button is browser-side.
STATUS=$(curl -s -o "$TMP/bbody" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"kind":"markdown","body":"from the network"}' "$BASE/api/live/boards")
[ "$STATUS" != "200" ] && [ "$STATUS" != "201" ] ||
  fail "there must be no POST board route, got $STATUS"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H 'Content-Type: application/json' \
  "$BASE/api/live/boards/$R_MD")
[ "$STATUS" != "200" ] || fail "there must be no DELETE board route, got $STATUS"
[ "$("$MESA" live board list | jq 'length')" = "4" ] ||
  fail "an HTTP write must not have changed the whiteboard"
ok "no POST/DELETE board route exists: the CLI is the only writer"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ---- the same headers under --lan ----
#
# Plain guard in both modes, identical headers in both: what makes an
# agent-written document safe to render is the CSP, not who asked for it, so
# the answer must not vary with the mode mesa is running in.
LAN_PORT=17782
LAN_BASE="http://127.0.0.1:$LAN_PORT"
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan13.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$LAN_BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$LAN_BASE/api/live" >/dev/null ||
  fail "LAN server did not start for section 13 (log: $(cat "$TMP/lan13.log"))"

check_board_render "$LAN_BASE" "render (--lan)"
ok "--lan: the render route answers with the identical header set, CSP included — the sandbox is the defense, not the caller's identity"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

# ---- ending the conversation closes the render route ----
#
# A board is scoped to its conversation, and this route is the only way a
# browser reaches one, so it has to stop answering when the conversation is
# over — otherwise "nothing outlives the conversation unless `keep` promotes
# it" would hold for every read except the one that hands out the bytes. The
# row itself survives an `ended` exactly as a turn's does; this is a status
# check, not a cascade. `not_found`, the same answer an unknown id gets, so a
# caller walking ids is not told the picture is real but simply over.
"$MESA" serve --port "$PORT" >"$TMP/serve13b.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/live" >/dev/null ||
  fail "server did not restart for the end-of-conversation check (log: $(cat "$TMP/serve13b.log"))"

board_headers "$BASE" "$R_HTML"
[ "$STATUS" = "200" ] || fail "the board must still render while the conversation is live, got $STATUS"

run 0 "$MESA" live stop
[ "$(jqs .status)" = "ended" ] || fail "live stop: status must be ended"

for id in "$R_MD" "$R_HTML" "$R_SVG" "$R_IMG"; do
  board_headers "$BASE" "$id"
  [ "$STATUS" = "404" ] ||
    fail "after live stop: board $id must be 404, got $STATUS"
  [ "$(jq -r .error.code <"$TMP/bbody")" = "not_found" ] ||
    fail "after live stop: board $id error.code must be not_found"
done
api 200 GET "/api/live"
[ "$(jqb .session)" = "null" ] || fail "after live stop: the page is idle again"
[ "$(jqb '.boards | length')" = "0" ] || fail "after live stop: no boards ride in the poll"
run 1 "$MESA" live board list
[ "$(jqe .error.code)" = "not_found" ] || fail "after live stop: live board list is not_found"
ok "ending the conversation closes the whiteboard on every surface: the render route answers 404 not_found, the poll carries no boards, and the CLI is not_found — a board outlives it only through \`keep\`"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# =====================================================================
# 14. Live memory v2 (mesa task 1147): the notebook and the archive
# =====================================================================
#
# The numbers are read out of the source rather than hardcoded, the way
# section 11 reads LIVE_SUMMARY_MAX.
NB_BUDGET=$(grep -Eo 'pub const LIVE_NOTEBOOK_BUDGET_WORDS: usize = [0-9]+' src/core/live.rs |
  grep -Eo '[0-9]+$')
NB_DECAY=$(grep -Eo 'pub const LIVE_NOTEBOOK_DECAY_SESSIONS: i64 = [0-9]+' src/core/live.rs |
  grep -Eo '[0-9]+$')
NB_ENTRY_MAX=$(grep -Eo 'pub const LIVE_NOTEBOOK_ENTRY_MAX: usize = [0-9]+' src/core/live.rs |
  grep -Eo '[0-9]+$')
[ -n "$NB_BUDGET" ] && [ -n "$NB_DECAY" ] && [ -n "$NB_ENTRY_MAX" ] ||
  fail "could not read the notebook constants from src/core/live.rs"
[ "$NB_BUDGET" = "500" ] && [ "$NB_ENTRY_MAX" = "600" ] ||
  fail "this section's arithmetic assumes a 500-word budget and a 600-char entry; update it with the constants"

words() { printf 'w%.0s ' $(seq 1 "$1") | sed 's/ $//'; } # N single-letter words

# ---- list: section 11's entry has DECAYED by now — sections 11-13 ended
#      well over N conversations after it was written and section 13's
#      `live start` ran the decay — so it is out of the active list and in
#      --all as `decayed`; --quiet refused on the two arrays ----
run 0 "$MESA" live memory list
[ "$(jqs type)" = "array" ] || fail "live memory list: bare array"
[ "$(jqs 'map(.id) | index('"$NOTE_ID"')')" = "null" ] ||
  fail "live memory list: section 11's entry #$NOTE_ID must have decayed by now (unused for $NB_DECAY+ conversations)"
run 0 "$MESA" live memory list --all
[ "$(jqs 'map(select(.id == '"$NOTE_ID"'))[0].retired_reason')" = "decayed" ] ||
  fail "list --all must show section 11's entry as decayed (got $(jqs 'map(select(.id == '"$NOTE_ID"'))'))"
run 2 "$MESA" live memory list --quiet
[ -z "$STDOUT" ] || fail "live memory list --quiet: stdout must be empty on a usage error"
[ "$(jqe .error.code)" = "usage" ] || fail "live memory list --quiet: error.code"
# `--quiet` BEFORE the words (after them it is a search word, the trailing
# var-arg rule `say`/`add` share).
run 2 "$MESA" live memory search --quiet pelican
[ "$(jqe .error.code)" = "usage" ] || fail "live memory search --quiet: error.code"
run 2 "$MESA" live memory search
[ "$(jqe .error.code)" = "usage" ] || fail "live memory search with no words: usage"
ok "live memory list/search: bare arrays; --quiet is a usage error on both, exit 2"

# ---- delete below the floor: any edit is allowed, and the row is retired,
#      not destroyed ----
run 0 "$MESA" live memory list
[ "$(jqs length)" = "0" ] || fail "the active notebook must be empty here (got $(jqs length))"
run 0 "$MESA" live memory add "DELETE-MARKER: a small entry to remove."
D1=$(jqs .id)
run 0 "$MESA" live memory delete "$D1"
[ "$(jqs .id)" = "$D1" ] || fail "live memory delete: echoes the row"
[ "$(jqs .retired_reason)" = "deleted" ] || fail "live memory delete: retired_reason"
[ "$(jqs .retired_at)" != "null" ] || fail "live memory delete: retired_at stamped"
[ "$(jqs .body)" = "DELETE-MARKER: a small entry to remove." ] ||
  fail "live memory delete: the full record is echoed"
run 0 "$MESA" live memory list
[ "$(jqs 'map(.id) | index('"$D1"')')" = "null" ] ||
  fail "a retired entry must leave the active list"
run 0 "$MESA" live memory list --all
[ "$(jqs 'map(select(.id == '"$D1"'))[0].retired_reason')" = "deleted" ] ||
  fail "list --all must show the retired row with its reason"
run 0 "$MESA" live memory show "$D1"
[ "$(jqs .retired_reason)" = "deleted" ] || fail "show reads a retired row"
run 1 "$MESA" live memory delete "$D1"
[ "$(jqe .error.code)" = "not_found" ] || fail "deleting a retired row: not_found"
run 1 "$MESA" live memory replace "$D1" anything
[ "$(jqe .error.code)" = "not_found" ] || fail "replacing a retired row: not_found"
run 1 "$MESA" live memory delete "$NOTE_ID"
[ "$(jqe .error.code)" = "not_found" ] || fail "deleting a decayed row: not_found"
ok "live memory delete: allowed below the 100-word floor; a soft delete — echoed, out of \`list\`, in \`list --all\` and \`show\`, and not_found for every later write"

# ---- add / show / --quiet / touch ----
run 0 "$MESA" live memory add Prefers short spoken replies.
A1=$(jqs .id)
[ "$(jqs .body)" = "Prefers short spoken replies." ] ||
  fail "live memory add: trailing words are joined into the body"
[ "$(jqs .retired_at)" = "null" ] || fail "a fresh entry is active"
[ "$(jqs .source_session_id)" != "null" ] ||
  fail "an entry added between conversations is dated to the newest session"
[ "$(jqs .last_used_session_id)" = "$(jqs .source_session_id)" ] ||
  fail "a fresh entry's last use is its source session"
run 0 "$MESA" live memory show "$A1"
printf '%s' "$STDOUT" >"$TMP/nb-full.json"
run 0 "$MESA" live memory show "$A1" --quiet
printf '%s' "$STDOUT" >"$TMP/nb-quiet.json"
[ "$(jqs 'has("body")')" = "false" ] || fail "live memory show --quiet: body must be dropped"
jq -e --slurpfile q "$TMP/nb-quiet.json" 'del(.body) == $q[0]' "$TMP/nb-full.json" >/dev/null ||
  fail "live memory --quiet: must be the full record minus \`body\` and nothing else"
run 0 "$MESA" live memory add --quiet "Task 42 holds the roadmap decisions."
A2=$(jqs .id)
[ "$(jqs 'has("body")')" = "false" ] || fail "live memory add --quiet: body must be dropped"
run 0 "$MESA" live memory add A note that mentions --quiet in passing.
A3=$(jqs .id)
[ "$(jqs .body)" = "A note that mentions --quiet in passing." ] ||
  fail "live memory add: --quiet typed after the text must land in the body"
run 0 "$MESA" live memory get "$A2"
[ "$(jqs .body)" = "Task 42 holds the roadmap decisions." ] || fail "get is an alias for show"
ok "live memory add/show/get: full record by default; --quiet drops \`body\` alone and must come before the text"

run 1 "$MESA" live memory touch "$A1"
[ "$(jqe .error.code)" = "not_found" ] || fail "touch with no live session: not_found"
grep -q 'mesa live start' <<<"$STDERR" || fail "touch with no live session must name mesa live start"
run 0 "$MESA" live start --no-agent
TOUCH_SESSION=$(jqs .id)
run 0 "$MESA" live memory touch "$A1"
[ "$(jqs .last_used_session_id)" = "$TOUCH_SESSION" ] ||
  fail "touch must stamp the live session as the last use"
[ "$(jqs 'has("body")')" = "true" ] || fail "touch prints the full record"
run 0 "$MESA" live memory touch "$A1" --quiet
[ "$(jqs 'has("body")')" = "false" ] || fail "touch --quiet drops body"
run 1 "$MESA" live memory touch 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "touch on an unknown id: not_found"
run 0 "$MESA" live stop >/dev/null
ok "live memory touch: not_found with no live session, stamps the live one as last use"

# ---- the entry bound ----
run 1 "$MESA" live memory add ""
[ "$(jqe .error.code)" = "validation" ] || fail "an empty entry: validation"
run 1 "$MESA" live memory add "   "
[ "$(jqe .error.code)" = "validation" ] || fail "a whitespace entry: validation"
run 1 "$MESA" live memory add "$(printf 'x%.0s' $(seq 1 $((NB_ENTRY_MAX + 1))))"
[ "$(jqe .error.code)" = "validation" ] || fail "an over-long entry: validation"
grep -q "$NB_ENTRY_MAX" <<<"$STDERR" || fail "the entry bound must name itself"
run 0 "$MESA" live memory add "$(printf 'x%.0s' $(seq 1 "$NB_ENTRY_MAX"))"
A4=$(jqs .id)
[ "$(jqs '.body | length')" = "$NB_ENTRY_MAX" ] || fail "an entry of exactly $NB_ENTRY_MAX chars is accepted"
ok "live memory add: empty is validation; the $NB_ENTRY_MAX-char bound is inclusive and names itself"

# ---- search: a turn, a summary and a note, by kind ----
run 0 "$MESA" live start --no-agent
SEARCH_SESSION=$(jqs .id)
run 0 "$MESA" live say "The pelican rule is that hooks run as one script."
PELICAN_TURN=$(jqs .id)
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live summary set "$SEARCH_SESSION" "Decided the pelican hooks rule."
run 0 "$MESA" live memory add "pelican: hooks are one script, task 1143"
PELICAN_NOTE=$(jqs .id)
run 0 "$MESA" live memory search pelican
[ "$(jqs type)" = "array" ] || fail "search: bare array"
[ "$(jqs 'map(.kind) | sort | join(",")')" = "note,summary,turn" ] ||
  fail "search must hit the turn, the summary and the note (got $(jqs 'map(.kind)'))"
[ "$(jqs 'map(select(.kind == "turn"))[0].ref_id')" = "$PELICAN_TURN" ] || fail "search: the turn's ref_id"
[ "$(jqs 'map(select(.kind == "turn"))[0].role')" = "mesa" ] || fail "search: a turn carries its role"
[ "$(jqs 'map(select(.kind == "turn"))[0].session_id')" = "$SEARCH_SESSION" ] || fail "search: session_id"
[ "$(jqs 'map(select(.kind == "summary"))[0].ref_id')" = "$SEARCH_SESSION" ] ||
  fail "search: a summary's ref_id is its session"
[ "$(jqs 'map(select(.kind == "note"))[0].ref_id')" = "$PELICAN_NOTE" ] || fail "search: the note's ref_id"
[ "$(jqs 'map(select(.kind == "note"))[0].role')" = "null" ] || fail "search: a note has no role"
[ "$(jqs 'map(select(.kind == "turn"))[0].snippet')" = "The [pelican] rule is that hooks run as one script." ] ||
  fail "search: the snippet brackets the match (got $(jqs 'map(select(.kind == "turn"))[0].snippet'))"
run 0 "$MESA" live memory search --limit 1 pelican
[ "$(jqs length)" = "1" ] || fail "search --limit caps the hits"
run 0 "$MESA" live memory search pelican --limit 1
[ "$(jqs length)" = "0" ] || fail "search: a flag typed after the words is a word (the trailing var-arg rule)"
run 0 "$MESA" live memory search pelican zzzz-no-such-word
[ "$(jqs length)" = "0" ] || fail "search: every word must match (implicit AND)"
# Quotes and operators in the words are words, never FTS syntax.
run 0 "$MESA" live memory search '"pelican" AND NOT ( OR'
[ "$(jqs type)" = "array" ] || fail "search: a query carrying quotes and operators must not error"
run 0 "$MESA" live memory search '"pelican"'
[ "$(jqs length)" = "3" ] || fail "search: a quoted word is searched with the quotes stripped"
run 1 "$MESA" live memory search '"'
[ "$(jqe .error.code)" = "validation" ] || fail "search with nothing left to search: validation"
# A retired note stays in the archive.
run 0 "$MESA" live memory search NOTE-MARKER
[ "$(jqs 'map(select(.kind == "note"))[0].ref_id')" = "$NOTE_ID" ] ||
  fail "a deleted notebook entry must still be found in the archive"
ok "live memory search: hits a turn, a summary and a note by kind with ref_id/session/role/snippet; implicit AND; quotes and operators are words"

# Clear the small entries (all below the floor) so the guard arithmetic
# below starts from an empty notebook.
for id in "$A1" "$A2" "$A3" "$A4" "$PELICAN_NOTE"; do
  run 0 "$MESA" live memory delete "$id"
done
run 0 "$MESA" live memory list
[ "$(jqs length)" = "0" ] || fail "the notebook must be empty before the guard checks"

# ---- the removal guard above the floor, and the budget ----
run 0 "$MESA" live memory add "$(words 99)"
E1=$(jqs .id)
run 0 "$MESA" live memory add "$(words 99)"
E2=$(jqs .id)
run 0 "$MESA" live memory add "$(words 99)"
E3=$(jqs .id)
# 297 words: deleting 99 is 33%, refused.
run 1 "$MESA" live memory delete "$E1"
[ "$(jqe .error.code)" = "validation" ] || fail "deleting 33% of the notebook: validation"
grep -q "99 of the notebook's 297 words" <<<"$STDERR" ||
  fail "the removal guard must name the words removed and held (got $STDERR)"
grep -q "30%" <<<"$STDERR" || fail "the removal guard must name its share"
run 0 "$MESA" live memory show "$E1"
[ "$(jqs .retired_at)" = "null" ] || fail "a refused delete must not retire the row"
# Replacing 99 words with 10 removes 89 of 297 (29.97%): allowed, in place.
run 0 "$MESA" live memory replace "$E1" "$(words 10)"
[ "$(jqs .id)" = "$E1" ] || fail "replace keeps the id"
[ "$(jqs .body)" = "$(words 10)" ] || fail "replace: the new body"
# Replacing 99 with 1 would remove 98 of 208 (47%): refused.
run 1 "$MESA" live memory replace "$E2" "one"
[ "$(jqe .error.code)" = "validation" ] || fail "a replace removing 47%: validation"
grep -q "98 of the notebook's 208 words" <<<"$STDERR" ||
  fail "the replace guard must name the words (got $STDERR)"
ok "live memory: above the 100-word floor a delete or replace removing more than 30% is validation naming the numbers; a smaller replace lands in place"

# 208 → 307 → 406 → 505 (refused) → 500 (exactly) → 501 (refused).
run 0 "$MESA" live memory add "$(words 99)"
E4=$(jqs .id)
run 0 "$MESA" live memory add "$(words 99)"
E5=$(jqs .id)
run 1 "$MESA" live memory add "$(words 99)"
[ "$(jqe .error.code)" = "validation" ] || fail "an add past the budget: validation"
grep -q "505 words" <<<"$STDERR" || fail "the budget message must name the resulting count (got $STDERR)"
grep -q "$NB_BUDGET-word" <<<"$STDERR" || fail "the budget message must name the budget"
run 0 "$MESA" live memory add "$(words 94)"
E6=$(jqs .id)
run 0 "$MESA" live memory list
[ "$(jqs '[.[].body | split(" ") | length] | add')" = "$NB_BUDGET" ] ||
  fail "the notebook must be at exactly $NB_BUDGET words (got $(jqs '[.[].body | split(" ") | length] | add'))"
run 1 "$MESA" live memory add "one"
[ "$(jqe .error.code)" = "validation" ] || fail "one word past the budget: validation"
run 1 "$MESA" live memory replace "$E6" "$(words 95)"
[ "$(jqe .error.code)" = "validation" ] || fail "a replace past the budget: validation"
grep -q "501 words" <<<"$STDERR" || fail "a replace past the budget names the count"
ok "live memory: the $NB_BUDGET-word budget is inclusive, judged on the notebook the write would leave, and names both numbers"

# ---- decay: N ended sessions with no use retires an entry at the next start ----
#
# Every active entry was last used at (or before) the session ended above,
# so after N more ended conversations the next `live start` retires them all
# — named on stderr, gone from the active list, `decayed` in --all.
for _ in $(seq 1 "$NB_DECAY"); do
  run 0 "$MESA" live start --no-agent
  run 0 "$MESA" live stop >/dev/null
done
run 0 "$MESA" live memory list
[ "$(jqs length)" = "6" ] || fail "decay runs at a start, not a stop: all 6 entries still active"
run 0 "$MESA" live start --no-agent
grep -q "retired" <<<"$STDERR" || fail "live start must report the decayed entries on stderr (got: $STDERR)"
for id in "$E1" "$E2" "$E3" "$E4" "$E5" "$E6"; do
  grep -q "#$id\b" <<<"$STDERR" || fail "live start's decay report must name #$id (got: $STDERR)"
done
run 0 "$MESA" live memory list
[ "$(jqs length)" = "0" ] || fail "after decay the active notebook is empty"
run 0 "$MESA" live memory list --all
for id in "$E1" "$E2" "$E3" "$E4" "$E5" "$E6"; do
  [ "$(jqs 'map(select(.id == '"$id"'))[0].retired_reason')" = "decayed" ] ||
    fail "list --all must show #$id as decayed"
done
run 0 "$MESA" live memory show "$E1"
[ "$(jqs .retired_reason)" = "decayed" ] || fail "a decayed row reads as decayed"
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live start --no-agent
[ -z "$STDERR" ] || fail "a second start with nothing left to decay must be silent (got: $STDERR)"
run 0 "$MESA" live stop >/dev/null
ok "live memory decay: an entry unused for $NB_DECAY ended sessions is retired at the next live start — named on stderr, out of the active list, \`decayed\` in --all"

# ---- the API: four routes on require_agent_access, default mode ----
PORT=17781
BASE="http://127.0.0.1:$PORT"
"$MESA" serve --port "$PORT" >"$TMP/serve14.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/live" >/dev/null || fail "server did not start (log: $(cat "$TMP/serve14.log"))"

api 200 GET "/api/live/memory"
[ "$BODY" = "[]" ] || fail "GET /api/live/memory: the active notebook is empty after decay (got $BODY)"
api 201 POST "/api/live/memory" '{"body":"  Prefers the board sorted by priority.  "}'
M1=$(jqb .id)
[ "$(jqb .body)" = "Prefers the board sorted by priority." ] || fail "POST /api/live/memory: trimmed body"
[ "$(jqb .retired_at)" = "null" ] || fail "POST /api/live/memory: active"
api 200 GET "/api/live/memory"
[ "$(jqb length)" = "1" ] && [ "$(jqb '.[0].id')" = "$M1" ] || fail "GET /api/live/memory lists the new row"
api 200 PATCH "/api/live/memory/$M1" '{"body":"Prefers the board sorted by priority, always."}'
[ "$(jqb .id)" = "$M1" ] || fail "PATCH keeps the id"
[ "$(jqb .body)" = "Prefers the board sorted by priority, always." ] || fail "PATCH: the new body"
api 422 POST "/api/live/memory" '{"body":"   "}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST an empty body: validation"
api 422 POST "/api/live/memory" '{}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST with no body key: validation"
api 422 PATCH "/api/live/memory/$M1" "{\"body\":\"$(printf 'x%.0s' $(seq 1 $((NB_ENTRY_MAX + 1))))\"}"
[ "$(jqb .error.code)" = "validation" ] || fail "PATCH past the entry bound: validation"
grep -q "$NB_ENTRY_MAX" <<<"$BODY" || fail "the API names the bound like the CLI"
api 404 PATCH "/api/live/memory/999999" '{"body":"nothing here"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "PATCH an unknown id: not_found"
api 404 DELETE "/api/live/memory/999999"
[ "$(jqb .error.code)" = "not_found" ] || fail "DELETE an unknown id: not_found"
api 200 DELETE "/api/live/memory/$M1"
[ "$(jqb .id)" = "$M1" ] && [ "$(jqb .retired_reason)" = "deleted" ] || fail "DELETE echoes the retired row"
api 200 GET "/api/live/memory"
[ "$BODY" = "[]" ] || fail "a deleted row leaves the active list"
api 404 DELETE "/api/live/memory/$M1"
[ "$(jqb .error.code)" = "not_found" ] || fail "DELETE a retired row: not_found"
# The 2s poll carries no notebook (`blocked` is the derived agent state of
# mesa task 1157, a string or null, not a body).
api 200 GET "/api/live"
[ "$(jqb 'keys | sort | join(",")')" = "blocked,boards,session,turns" ] ||
  fail "GET /api/live must carry exactly session/turns/boards/blocked — no notebook (got $(jqb 'keys'))"
ok "/api/live/memory: GET/POST/PATCH/DELETE round trip, 422 validation with the CLI's messages, 404 for unknown and retired ids, and GET /api/live carries no notebook"

# Both halves of the boundary, default mode: Host allowlist, Content-Type
# gate, and the agent gate (a foreign Origin refused on every verb, reads
# included — the Settings posture, since this is text injected into a
# prompt).
raw GET "/api/live/memory" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "GET /api/live/memory with a foreign Host: expected 403, got $STATUS"
raw POST "/api/live/memory" -d 'body=form+post'
[ "$STATUS" = "415" ] || fail "form-encoded POST /api/live/memory: expected 415, got $STATUS"
raw PATCH "/api/live/memory/1" -d 'body=form+post'
[ "$STATUS" = "415" ] || fail "form-encoded PATCH /api/live/memory: expected 415, got $STATUS"
raw DELETE "/api/live/memory/1" -d 'x=1'
[ "$STATUS" = "415" ] || fail "DELETE /api/live/memory without JSON: expected 415, got $STATUS"
[ "$(origin_status GET "/api/live/memory" 'https://evil.example')" = "403" ] ||
  fail "GET /api/live/memory with a foreign Origin must be 403 (reads are gated too)"
[ "$(origin_status POST "/api/live/memory" 'https://evil.example' '{"body":"x"}')" = "403" ] ||
  fail "POST /api/live/memory with a foreign Origin must be 403"
[ "$(origin_status PATCH "/api/live/memory/1" 'https://evil.example' '{"body":"x"}')" = "403" ] ||
  fail "PATCH /api/live/memory with a foreign Origin must be 403"
[ "$(origin_status DELETE "/api/live/memory/1" 'https://evil.example' '{}')" = "403" ] ||
  fail "DELETE /api/live/memory with a foreign Origin must be 403"
[ "$(origin_status GET "/api/live/memory" "http://localhost:$PORT")" = "200" ] ||
  fail "GET /api/live/memory from a local Origin must be served"
ok "/api/live/memory (default mode): foreign Host 403, non-JSON writes 415, foreign Origin 403 on all four verbs, a local Origin served"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ---- the same routes under --lan: relaxed, never absent ----
LAN_PORT=17782
LAN_BASE="http://127.0.0.1:$LAN_PORT"
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan14.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$LAN_BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$LAN_BASE/api/live" >/dev/null || fail "LAN server did not start (log: $(cat "$TMP/lan14.log"))"

[ "$(lan_status GET "/api/live/memory" 'evil.example')" = "403" ] ||
  fail "--lan: GET /api/live/memory must refuse a DNS-name Host (rebinding defense)"
[ "$(lan_status POST "/api/live/memory" 'evil.example' '{"body":"x"}')" = "403" ] ||
  fail "--lan: POST /api/live/memory must refuse a DNS-name Host"
[ "$(lan_status GET "/api/live/memory" "127.0.0.1:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/live/memory from a local Host must be served"
[ "$(lan_status GET "/api/live/memory" "192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/live/memory from an IP-literal Host (a real LAN browser) must be served"
[ "$(lan_status POST "/api/live/memory" "192.0.2.7:$LAN_PORT" '{"body":"added from the LAN"}')" = "201" ] ||
  fail "--lan: a LAN page may add to the notebook"
LAN_ID=$(curl -s -H "Host: 192.0.2.7:$LAN_PORT" "$LAN_BASE/api/live/memory" | jq -r '.[-1].id')
[ "$(lan_status PATCH "/api/live/memory/$LAN_ID" "192.0.2.7:$LAN_PORT" '{"body":"edited from the LAN"}')" = "200" ] ||
  fail "--lan: a LAN page may edit the notebook"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: 192.0.2.7:$LAN_PORT" \
     -d 'body=form+post' "$LAN_BASE/api/live/memory")" = "415" ] ||
  fail "--lan: the Content-Type gate still fires on the notebook"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: 192.0.2.7:$LAN_PORT" \
     -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
     -d '{"body":"cross-site"}' "$LAN_BASE/api/live/memory")" = "403" ] ||
  fail "--lan: a foreign Origin must still be refused on the notebook"
[ "$(lan_status DELETE "/api/live/memory/$LAN_ID" "192.0.2.7:$LAN_PORT" '{}')" = "200" ] ||
  fail "--lan: a LAN page may delete from the notebook"
ok "--lan: all four /api/live/memory verbs present and relaxed (DNS Host 403, IP-literal Host served), Content-Type and Origin gates still shut"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

# ---- the dream pass (mesa task 1152): merge, restore, dream ----
#
# The active notebook is empty here (everything above was deleted or has
# decayed) and no session is live. `$D1` is a row section 14 deleted, so it
# is the retired id a merge must refuse.

# `dream` takes no --quiet (like `search`), and with fewer than two active
# entries it spawns nothing and says so on stdout, exit 0.
run 2 "$MESA" live memory dream --quiet
[ -z "$STDOUT" ] || fail "live memory dream --quiet: stdout must be empty on a usage error"
[ "$(jqe .error.code)" = "usage" ] || fail "live memory dream --quiet: error.code"
rm -f "$STUB_DIR/last-argc"
run 0 "$MESA" live memory dream
[ "$(jqs .spawned)" = "false" ] || fail "dream over an empty notebook: spawned must be false (got $STDOUT)"
grep -q "at least two" <<<"$(jqs .reason)" || fail "dream: the reason must name the two-entry floor (got $STDOUT)"
[ ! -e "$STUB_DIR/last-argc" ] || fail "dream must not spawn anything with fewer than two entries"
run 0 "$MESA" live memory add "MERGE-A: prefers short spoken replies."
MA=$(jqs .id)
MA_SOURCE=$(jqs .source_session_id)
run 0 "$MESA" live memory dream
[ "$(jqs .spawned)" = "false" ] || fail "dream over one entry: spawned must be false"
grep -q "1 active entry;" <<<"$(jqs .reason)" || fail "dream: the reason counts the entries (got $STDOUT)"
[ ! -e "$STUB_DIR/last-argc" ] || fail "dream must not spawn anything with one entry"
ok "live memory dream: --quiet is a usage error; under two active entries prints {spawned: false, reason} and spawns nothing"

# A newer session, so the second source is attributed to a different
# conversation than the first — which is what makes the provenance
# assertion on the merged row mean something.
run 0 "$MESA" live start --no-agent
run 0 "$MESA" live stop >/dev/null
run 0 "$MESA" live memory add "MERGE-B: wants replies kept brief when spoken."
MB=$(jqs .id)
[ "$(jqs .source_session_id)" != "$MA_SOURCE" ] || fail "merge setup: the two sources must come from different sessions"
run 0 "$MESA" live memory add "KEEP-C: task 42 holds the roadmap."
MC=$(jqs .id)

# ---- merge: the refusals, none of which touch a row ----
run 1 "$MESA" live memory merge --ids "$MA" one bullet
[ "$(jqe .error.code)" = "validation" ] || fail "merge with one id: validation"
grep -q "at least two" <<<"$STDERR" || fail "merge with one id must name the rule (got $STDERR)"
run 1 "$MESA" live memory merge --ids "$MA,$MA" one bullet
[ "$(jqe .error.code)" = "validation" ] || fail "merge with a repeated id: validation (one id is one id)"
run 1 "$MESA" live memory merge --ids "$MA,$D1" one bullet
[ "$(jqe .error.code)" = "not_found" ] || fail "merge naming a retired id: not_found"
run 1 "$MESA" live memory merge --ids "$MA,999999" one bullet
[ "$(jqe .error.code)" = "not_found" ] || fail "merge naming an unknown id: not_found"
run 1 "$MESA" live memory merge --ids "$MA,$MB" ""
[ "$(jqe .error.code)" = "validation" ] || fail "merge into an empty body: validation"
run 2 "$MESA" live memory merge --ids "$MA,$MB"
[ "$(jqe .error.code)" = "usage" ] || fail "merge with no text: usage"
run 2 "$MESA" live memory merge "$MA,$MB" one bullet
[ "$(jqe .error.code)" = "usage" ] || fail "merge without --ids: usage (the ids are a flag, before the text)"
run 0 "$MESA" live memory list
[ "$(jqs 'map(.id) | join(",")')" = "$MA,$MB,$MC" ] || fail "a refused merge must touch nothing (got $(jqs 'map(.id)'))"
ok "live memory merge: one id, a repeated id and an empty body are validation; a retired or unknown id is not_found; no --ids or no text is usage; nothing is touched"

# ---- merge: the round trip ----
run 0 "$MESA" live memory merge --ids "$MB,$MA" MERGED-AB: prefers short spoken replies.
MM=$(jqs .id)
[ "$(jqs .body)" = "MERGED-AB: prefers short spoken replies." ] ||
  fail "merge: trailing words are joined into the new body"
[ "$(jqs .retired_at)" = "null" ] && [ "$(jqs .merged_into)" = "null" ] || fail "the merged row is active"
[ "$(jqs .source_session_id)" = "$MA_SOURCE" ] ||
  fail "the merged row must carry the EARLIEST source's source_session_id ($MA_SOURCE), got $(jqs .source_session_id)"
[ "$(jqs .last_used_session_id)" != "null" ] || fail "the merged row's last use is stamped like an add's"
for id in "$MA" "$MB"; do
  run 0 "$MESA" live memory show "$id"
  [ "$(jqs .retired_reason)" = "merged" ] || fail "source #$id must be retired as merged (got $(jqs .retired_reason))"
  [ "$(jqs .retired_at)" != "null" ] || fail "source #$id: retired_at stamped"
  [ "$(jqs .merged_into)" = "$MM" ] || fail "source #$id must point at the merged row #$MM (got $(jqs .merged_into))"
done
run 0 "$MESA" live memory list
[ "$(jqs 'map(.id) | join(",")')" = "$MC,$MM" ] || fail "after the merge the active list is the survivor and the merged row (got $(jqs 'map(.id)'))"
run 0 "$MESA" live memory list --all
[ "$(jqs 'map(select(.retired_reason == "merged")) | map(.id) | join(",")')" = "$MA,$MB" ] ||
  fail "list --all must show both sources as merged"
[ "$(jqs 'map(select(.id == '"$MM"'))[0].body')" = "MERGED-AB: prefers short spoken replies." ] ||
  fail "list --all must show the merged row too"
run 0 "$MESA" live memory search MERGED-AB
[ "$(jqs 'map(select(.kind == "note"))[0].ref_id')" = "$MM" ] || fail "the merged text must be indexed in the archive"
run 0 "$MESA" live memory search brief
[ "$(jqs 'map(select(.kind == "note"))[0].ref_id')" = "$MB" ] || fail "a merged source's body must stay searchable"
run 1 "$MESA" live memory merge --ids "$MA,$MM" again
[ "$(jqe .error.code)" = "not_found" ] || fail "a merged source is archive: merging it again is not_found"
ok "live memory merge: the sources are retired as merged pointing at the new row, which carries the oldest source's provenance; list --all shows what became what; both old and new text stay searchable"

# ---- restore: the undo ----
run 1 "$MESA" live memory restore "$MM"
[ "$(jqe .error.code)" = "validation" ] || fail "restoring an active row: validation"
grep -q "is not retired" <<<"$STDERR" || fail "restoring an active row must say so (got $STDERR)"
run 1 "$MESA" live memory restore 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "restoring an unknown id: not_found"
run 0 "$MESA" live memory restore "$MA"
[ "$(jqs .id)" = "$MA" ] || fail "restore echoes the row"
[ "$(jqs .retired_at)" = "null" ] && [ "$(jqs .retired_reason)" = "null" ] && [ "$(jqs .merged_into)" = "null" ] ||
  fail "restore must clear retired_at, retired_reason and merged_into (got $STDOUT)"
[ "$(jqs .body)" = "MERGE-A: prefers short spoken replies." ] || fail "restore: the body is untouched"
[ "$(jqs .source_session_id)" = "$MA_SOURCE" ] || fail "restore: provenance is untouched"
run 0 "$MESA" live memory list
[ "$(jqs 'map(.id) | join(",")')" = "$MA,$MC,$MM" ] ||
  fail "a restored source is active again beside the merged row (got $(jqs 'map(.id)'))"
run 0 "$MESA" live memory restore "$MB" --quiet
[ "$(jqs 'has("body")')" = "false" ] || fail "restore --quiet drops body"
[ "$(jqs 'has("merged_into")')" = "true" ] && [ "$(jqs .merged_into)" = "null" ] ||
  fail "restore --quiet keeps merged_into (a bounded pointer), cleared"
run 1 "$MESA" live memory restore "$MB"
[ "$(jqe .error.code)" = "validation" ] || fail "restoring a row twice: validation"
# A deleted row restores the same way as a merged one.
run 0 "$MESA" live memory delete "$MB" >/dev/null
run 0 "$MESA" live memory restore "$MB"
[ "$(jqs .retired_reason)" = "null" ] || fail "a deleted row restores too"
ok "live memory restore: un-retires a merged or deleted row (retirement fields cleared, body and provenance untouched), --quiet drops body alone; an active row is validation, an unknown id not_found"

# ---- restore past the budget is refused ----
# Retire MB (7 words), fill the notebook to exactly the budget with 30-word
# entries (30 is at most 30% of any notebook at or above the 100-word floor,
# so every one of them can be deleted again afterwards), then the restore
# would land at 507.
run 0 "$MESA" live memory delete "$MB" >/dev/null
run 0 "$MESA" live memory list
CUR=$(jqs '[.[].body | split(" ") | length] | add')
FILLERS=()
while [ "$CUR" -le $((NB_BUDGET - 30)) ]; do
  run 0 "$MESA" live memory add "$(words 30)"
  FILLERS+=("$(jqs .id)")
  CUR=$((CUR + 30))
done
if [ "$CUR" -lt "$NB_BUDGET" ]; then
  run 0 "$MESA" live memory add "$(words $((NB_BUDGET - CUR)))"
  FILLERS+=("$(jqs .id)")
fi
run 0 "$MESA" live memory list
[ "$(jqs '[.[].body | split(" ") | length] | add')" = "$NB_BUDGET" ] ||
  fail "restore setup: the notebook must sit at exactly $NB_BUDGET words (got $(jqs '[.[].body | split(" ") | length] | add'))"
run 1 "$MESA" live memory restore "$MB"
[ "$(jqe .error.code)" = "validation" ] || fail "a restore past the budget: validation"
grep -q "$((NB_BUDGET + 7)) words" <<<"$STDERR" || fail "a refused restore names the resulting count (got $STDERR)"
grep -q "$NB_BUDGET-word" <<<"$STDERR" || fail "a refused restore names the budget"
run 0 "$MESA" live memory show "$MB"
[ "$(jqs .retired_reason)" = "deleted" ] || fail "a refused restore must change nothing"
for id in "${FILLERS[@]}"; do
  run 0 "$MESA" live memory delete "$id" >/dev/null
done
ok "live memory restore: refused with the budget message when the row would not fit, and nothing changes"

# ---- merge --quiet, and the two guards judged on the NET words ----
run 0 "$MESA" live memory merge --quiet --ids "$MA,$MM" MERGED-2: prefers short spoken replies.
M2=$(jqs .id)
[ "$(jqs 'has("body")')" = "false" ] || fail "merge --quiet drops body"
[ "$(jqs 'has("merged_into")')" = "true" ] || fail "merge --quiet keeps merged_into"
run 0 "$MESA" live memory list
[ "$(jqs 'map(.id) | join(",")')" = "$MC,$M2" ] || fail "after the second merge: the survivor and the new row (got $(jqs 'map(.id)'))"
# 11 words (MC 6 + M2 5) plus three 40-word entries = 131, above the floor.
run 0 "$MESA" live memory add "$(words 40)"
X1=$(jqs .id)
run 0 "$MESA" live memory add "$(words 40)"
X2=$(jqs .id)
run 0 "$MESA" live memory add "$(words 40)"
X3=$(jqs .id)
# Folding two 40s into 5 removes 75 of 131 (57%): refused on the NET words.
run 1 "$MESA" live memory merge --ids "$X1,$X2" "$(words 5)"
[ "$(jqe .error.code)" = "validation" ] || fail "a merge removing 57% of the notebook: validation"
grep -q "75 of the notebook's 131 words" <<<"$STDERR" ||
  fail "the merge removal guard must name the NET words removed and held (got $STDERR)"
run 0 "$MESA" live memory show "$X1"
[ "$(jqs .retired_at)" = "null" ] || fail "a refused merge must not retire a source"
# The budget: fill to exactly $NB_BUDGET with 30-word entries (deletable
# again, as above), then folding the 11 words of MC and M2 into 12 would
# land at 501: refused, naming the count.
FILLERS=()
CUR=131
while [ "$CUR" -le $((NB_BUDGET - 30)) ]; do
  run 0 "$MESA" live memory add "$(words 30)"
  FILLERS+=("$(jqs .id)")
  CUR=$((CUR + 30))
done
if [ "$CUR" -lt "$NB_BUDGET" ]; then
  run 0 "$MESA" live memory add "$(words $((NB_BUDGET - CUR)))"
  FILLERS+=("$(jqs .id)")
fi
run 1 "$MESA" live memory merge --ids "$MC,$M2" "$(words 12)"
[ "$(jqe .error.code)" = "validation" ] || fail "a merge past the budget: validation"
grep -q "$((NB_BUDGET + 1)) words" <<<"$STDERR" || fail "the merge budget guard names the resulting count (got $STDERR)"
run 0 "$MESA" live memory show "$MC"
[ "$(jqs .retired_at)" = "null" ] || fail "a merge refused by the budget must not retire a source"
for id in "${FILLERS[@]}"; do
  run 0 "$MESA" live memory delete "$id" >/dev/null
done
# Folding two 40s into 50 removes 30 of 131 (23%): allowed, landing at 101.
run 0 "$MESA" live memory merge --ids "$X1,$X2" "$(words 50)"
Y=$(jqs .id)
run 0 "$MESA" live memory list
[ "$(jqs '[.[].body | split(" ") | length] | add')" = "101" ] || fail "after the allowed merge: 101 words"
ok "live memory merge: --quiet drops body alone; the removal guard and the budget are judged on the net words the merge would leave, naming the numbers"

# Back below the floor, then clear to the two survivors for the spawn.
run 0 "$MESA" live memory replace "$Y" "$(words 25)" >/dev/null
for id in "$X3" "$Y"; do
  run 0 "$MESA" live memory delete "$id" >/dev/null
done
run 0 "$MESA" live memory list
[ "$(jqs 'map(.id) | join(",")')" = "$MC,$M2" ] || fail "dream setup: exactly the two survivors (got $(jqs 'map(.id)'))"

# ---- dream: conflict while a conversation is live, and nothing spawned ----
rm -f "$STUB_DIR/last-argc"
run 0 "$MESA" live start --no-agent
NEWEST=$(jqs .id)
run 1 "$MESA" live memory dream
[ "$(jqe .error.code)" = "conflict" ] || fail "dream while a session is live: conflict (got $STDERR)"
grep -q "between conversations" <<<"$STDERR" || fail "dream's conflict must say it runs between conversations (got $STDERR)"
[ ! -e "$STUB_DIR/last-argc" ] || fail "dream must not spawn while a session is live"
run 0 "$MESA" live stop >/dev/null
ok "live memory dream: conflict while a conversation is live, and spawns nothing"

# ---- dream: the spawn through the built-in live-dream template ----
rm -f "$STUB_DIR/last-argc"
run 0 "$MESA" live memory dream
[ "$(jqs .spawned)" = "true" ] || fail "dream with two entries: spawned must be true (got $STDOUT)"
[ "$(jqs .receipt)" = "$(cat "$STUB_DIR/last-id")" ] || fail "dream must print the spawn receipt (got $STDOUT)"
[ -e "$STUB_DIR/last-argc" ] || fail "dream must spawn its agent"
EXPECTED_DREAM_FLAGS="--bg
--agent
swe
--name
live memory dream
--"
[ "$(cat "$STUB_DIR/last-flags")" = "$EXPECTED_DREAM_FLAGS" ] ||
  fail "live-dream spawn argv: expected
$EXPECTED_DREAM_FLAGS
got
$(cat "$STUB_DIR/last-flags")"
grep -q "You are tidying mesa's notebook between conversations" "$STUB_DIR/last-prompt" ||
  fail "live-dream spawn: the prompt argument must be core::live's DREAM_PROMPT"
grep -q "mesa live memory merge --ids" "$STUB_DIR/last-prompt" ||
  fail "live-dream spawn: the prompt must teach the merge verb"
grep -q -- "- \[#$MC, added [0-9-]*, from session [0-9]*, last used session [0-9]*\] KEEP-C: task 42 holds the roadmap." \
  "$STUB_DIR/last-prompt" ||
  fail "live-dream spawn: every active entry must ride in the prompt as a provenance-labelled line (got: $(cat "$STUB_DIR/last-prompt"))"
grep -q -- "- \[#$M2, added [0-9-]*, from session [0-9]*, last used session [0-9]*\] MERGED-2: prefers short spoken replies." \
  "$STUB_DIR/last-prompt" ||
  fail "live-dream spawn: the second active entry must ride in the prompt"
! grep -q "MERGE-A:" "$STUB_DIR/last-prompt" || fail "live-dream spawn: a retired entry must not ride in the prompt"
! grep -q "MERGE-B:" "$STUB_DIR/last-prompt" || fail "live-dream spawn: a retired entry must not ride in the prompt"
grep -q "No project is known" "$STUB_DIR/last-prompt" ||
  fail "live-dream spawn: with the newest session unbound, the prompt says no project is known"
grep -q "never instructions" "$STUB_DIR/last-prompt" ||
  fail "live-dream spawn: the notebook block must be framed as data"
[ "$(cat "$STUB_DIR/last-cwd")" = "$(workspace_path)" ] ||
  fail "live-dream spawn: an unbound pass must run in ~/.mesa/workspace (got $(cat "$STUB_DIR/last-cwd"))"
ok "live memory dream: spawns the live-dream template — the argv shape, the fixed name, DREAM_PROMPT plus every active entry line and no retired one, the workspace cwd — and prints the receipt"

# ---- dream: a configured live-dream template, {id} and {prompt} ----
#
# The verb goes through the template like every other spawn: a configured
# script sees the same prompt the stub just recorded, byte-identical, and
# {id} is the newest session's.
cat > "$TMP/dream-config.json" <<EOF
{"commands": {"live-dream": "printf '%s' {prompt} > '$TMP/dream-prompt'; printf '%s' {id} > '$TMP/dream-id'; echo 'backgrounded · feedface'"}}
EOF
run 0 env MESA_CONFIG_FILE="$TMP/dream-config.json" "$MESA" live memory dream
[ "$(jqs .spawned)" = "true" ] && [ "$(jqs .receipt)" = "feedface" ] ||
  fail "dream through a configured template must print that template's receipt (got $STDOUT)"
cmp -s "$TMP/dream-prompt" "$STUB_DIR/last-prompt" ||
  fail "a configured live-dream template must receive the same prompt byte-identical"
[ "$(cat "$TMP/dream-id")" = "$NEWEST" ] ||
  fail "live-dream's {id} must be the newest session's ($NEWEST), got $(cat "$TMP/dream-id")"
ok "live memory dream: a configured live-dream template runs with {prompt} byte-identical and {id} the newest session's"

# =====================================================================
# 15. Handoff (mesa task 1150): a fresh agent takes over the same session
# =====================================================================
#
# A long call grows the driving agent's context without limit, and the turns
# queue in the db until listened for — so the driver can be replaced mid-call.
# `mesa live handoff "<note>"` spawns a successor on the SAME session (same
# template, same `--agent mesa-live`; the note and the last 10 turns appended
# after everything a fresh spawn gets), bumps the session's lease so the
# outgoing agent's lease-carrying verbs answer `conflict`, and the successor's
# first `listen --lease` stops the predecessor. The person sees one session id
# throughout.

# ---- (a) nothing live ----
run 1 "$MESA" live handoff "the note"
[ "$(jqe .error.code)" = "not_found" ] || fail "live handoff with no session: not_found"
grep -q 'mesa live start' <<<"$STDERR" || fail "live handoff with no session must name mesa live start"
run 1 "$MESA" live context
[ "$(jqe .error.code)" = "not_found" ] || fail "live context with no session: not_found"
run 2 "$MESA" live handoff
[ "$(jqe .error.code)" = "usage" ] || fail "live handoff with no note: usage"
[ -z "$STDOUT" ] || fail "live handoff usage error: empty stdout"
ok "live handoff/context with nothing live: not_found naming live start; a missing note is usage, exit 2"

# A server for the utterances (the page's half of the loop) and for the
# one-session-id check.
PORT=17781
BASE="http://127.0.0.1:$PORT"
"$MESA" serve --port "$PORT" >"$TMP/serve15.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/live" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/live" >/dev/null || fail "server did not start (log: $(cat "$TMP/serve15.log"))"

# ---- (b) the handoff itself: the successor, its prompt, its argv ----
# A notebook entry first, so the block order asserted below is real.
run 0 "$MESA" live memory add "HANDOFF-NOTE-MARKER: likes the roadmap read out first."
run 0 "$MESA" live start "live gate project"
HS=$(jqs .id)
[ "$(jqs .lease)" = "1" ] || fail "a fresh session holds lease 1 (got $(jqs .lease))"
HA1=$(jqs .agent_id)
[ "$HA1" = "$(cat "$STUB_DIR/last-id")" ] || fail "live start: the spawn receipt is the stub's newest id"
[ "$(head -1 "$STUB_DIR/last-prompt")" = "Drive mesa live session $HS (lease 1)." ] ||
  fail "a fresh spawn's first line carries lease 1: $(head -1 "$STUB_DIR/last-prompt")"
FIRST_FLAGS=$(cat "$STUB_DIR/last-flags")
for i in $(seq 1 6); do
  api 201 POST "/api/live/utterance" "{\"text\":\"handoff utterance $i\"}"
  run 0 "$MESA" live listen --lease 1 --wait 0
  [ "$(jqs .text)" = "handoff utterance $i" ] || fail "listen --lease 1 hands over utterance $i"
  run 0 "$MESA" live say --lease 1 "handoff reply $i"
done
run 0 "$MESA" live turns
[ "$(jqs length)" = "12" ] || fail "twelve turns before the handoff (got $(jqs length))"
rm -f "$STUB_DIR/last-stop"
run 0 "$MESA" live handoff "HANDOFF-MARKER: we were on the roadmap; item 3 is pending; I promised to open task 40."
[ "$(jqs .id)" = "$HS" ] || fail "live handoff: the SAME session (got $(jqs .id))"
[ "$(jqs .lease)" = "2" ] || fail "live handoff: lease bumps to 2 (got $(jqs .lease))"
[ "$(jqs .status)" = "live" ] || fail "live handoff: the session stays live"
HA2=$(jqs .agent_id)
[ "$HA2" = "$(cat "$STUB_DIR/last-id")" ] && [ "$HA2" != "$HA1" ] ||
  fail "live handoff: agent_id is the successor's receipt (got $HA2, predecessor $HA1)"
[ ! -e "$STUB_DIR/last-stop" ] || fail "live handoff must not stop the caller: it IS the outgoing agent"
[ -z "$STDERR" ] || fail "live handoff: nothing on stderr on success (got: $STDERR)"
ok "live handoff: exit 0, the same session with lease 2 and the successor's receipt, nothing stopped"

# The successor's prompt: the session line naming its lease, the note, and
# exactly the last 10 of the 12 turns, in order.
[ "$(head -1 "$STUB_DIR/last-prompt")" = "Drive mesa live session $HS (lease 2)." ] ||
  fail "the successor's prompt starts with the session line naming lease 2: $(head -1 "$STUB_DIR/last-prompt")"
grep -q "HANDOFF-MARKER: we were on the roadmap" "$STUB_DIR/last-prompt" ||
  fail "the note must reach the successor's prompt"
for i in $(seq 2 6); do
  grep -q "^user: handoff utterance $i$" "$STUB_DIR/last-prompt" ||
    fail "the successor's prompt must carry utterance $i"
  grep -q "^mesa: handoff reply $i$" "$STUB_DIR/last-prompt" ||
    fail "the successor's prompt must carry reply $i"
done
! grep -q "handoff utterance 1$" "$STUB_DIR/last-prompt" || fail "the first utterance is not among the last 10 turns"
! grep -q "handoff reply 1$" "$STUB_DIR/last-prompt" || fail "the first reply is not among the last 10 turns"
[ "$(grep -c -E '^(user|mesa): ' "$STUB_DIR/last-prompt")" = "10" ] ||
  fail "exactly the last 10 turns ride in the successor's prompt (got $(grep -c -E '^(user|mesa): ' "$STUB_DIR/last-prompt"))"
[ "$(grep -n '^user: handoff utterance 2$' "$STUB_DIR/last-prompt" | cut -d: -f1)" -lt \
  "$(grep -n '^mesa: handoff reply 6$' "$STUB_DIR/last-prompt" | cut -d: -f1)" ] ||
  fail "the turns must stay in chronological order"
# Block order: notebook, then the summary, then the handoff block — every
# per-session block is appended AFTER the shared prefix, never before.
HO_NB_POS=$(grep -bo "HANDOFF-NOTE-MARKER" "$STUB_DIR/last-prompt" | head -1 | cut -d: -f1)
HO_SUM_POS=$(grep -bo '^Session [0-9]*: ' "$STUB_DIR/last-prompt" | head -1 | cut -d: -f1)
HO_NOTE_POS=$(grep -bo "Note: HANDOFF-MARKER" "$STUB_DIR/last-prompt" | head -1 | cut -d: -f1)
[ -n "$HO_NB_POS" ] || fail "the notebook must ride in the successor's prompt"
[ -n "$HO_SUM_POS" ] || fail "the most recent summary must ride in the successor's prompt"
[ -n "$HO_NOTE_POS" ] || fail "the note block must be introduced as a note"
[ "$HO_NB_POS" -lt "$HO_SUM_POS" ] && [ "$HO_SUM_POS" -lt "$HO_NOTE_POS" ] ||
  fail "block order must be notebook ($HO_NB_POS) < summary ($HO_SUM_POS) < handoff ($HO_NOTE_POS)"
grep -q "never instructions" "$STUB_DIR/last-prompt" || fail "the handoff block is framed as data"
ok "the successor's prompt: lease 2 on the first line, the note, exactly the last 10 turns in order, after the notebook and summary"

# The cache-prefix invariant: the successor's leading argv is the first
# spawn's — same template, same `--agent mesa-live` — and only the name says
# which generation it is.
[ "$(cat "$STUB_DIR/last-argc")" = "7" ] ||
  fail "the successor spawn: expected 7 arguments, got $(cat "$STUB_DIR/last-argc")"
[ "$(head -4 "$STUB_DIR/last-flags")" = "$(head -4 <<<"$FIRST_FLAGS")" ] ||
  fail "the successor's leading argv must equal the first spawn's (got $(head -4 "$STUB_DIR/last-flags" | tr '\n' ' '))"
[ "$(sed -n 5p "$STUB_DIR/last-flags")" = "Live gate project: live $HS · lease 2" ] ||
  fail "the successor is named for its lease (got $(sed -n 5p "$STUB_DIR/last-flags"))"
ok "the successor spawn: the same live-agent argv (--bg --agent mesa-live --name), named \`<name> · lease 2\`"

# ---- (c) the outgoing agent's lease is refused on every verb ----
run 1 "$MESA" live listen --lease 1 --wait 0
[ "$(jqe .error.code)" = "conflict" ] || fail "listen --lease 1 after the handoff: conflict"
grep -q "handed off" <<<"$STDERR" || fail "the conflict must say the conversation was handed off (got: $STDERR)"
grep -q "current lease is 2" <<<"$STDERR" || fail "the conflict must name the current lease (got: $STDERR)"
run 1 "$MESA" live say --lease 1 "I am still here"
[ "$(jqe .error.code)" = "conflict" ] || fail "say --lease 1 after the handoff: conflict"
run 1 "$MESA" live navigate --lease 1 '#/inbox'
[ "$(jqe .error.code)" = "conflict" ] || fail "navigate --lease 1 after the handoff: conflict"
run 1 "$MESA" live sidebars collapse --lease 1
[ "$(jqe .error.code)" = "conflict" ] || fail "sidebars --lease 1 after the handoff: conflict"
run 0 "$MESA" live turns
[ "$(jqs length)" = "12" ] || fail "a refused lease writes no turn (got $(jqs length))"
ok "a stale lease: listen/say/navigate/sidebars are all conflict naming the handoff, and nothing is written"

# ---- (d) the successor's first listen stops the predecessor, once ----
api 201 POST "/api/live/utterance" '{"text":"spoken during the swap"}'
rm -f "$STUB_DIR/last-stop"
run 0 "$MESA" live listen --lease 2 --wait 0
[ "$(jqs .text)" = "spoken during the swap" ] ||
  fail "an utterance posted after the handoff waits in the queue for the successor (got $STDOUT)"
[ "$(cat "$STUB_DIR/last-stop" 2>/dev/null)" = "stop $HA1" ] ||
  fail "the successor's first listen must stop the predecessor by its job id (got $(cat "$STUB_DIR/last-stop" 2>/dev/null))"
rm -f "$STUB_DIR/last-stop"
run 0 "$MESA" live listen --lease 2 --wait 0
[ "$STDOUT" = "null" ] || fail "nothing else queued"
[ ! -e "$STUB_DIR/last-stop" ] || fail "the predecessor is stopped exactly once, never re-stopped"
run 0 "$MESA" live say --lease 2 "Picking up where we left off."
[ "$(jqs .role)" = "mesa" ] || fail "say --lease 2 writes the turn"
ok "the successor's first listen --lease 2 takes the queued utterance and stops the predecessor exactly once"

# ---- (e) a lease-less person still drives ----
api 201 POST "/api/live/utterance" '{"text":"no lease at all"}'
rm -f "$STUB_DIR/last-stop"
run 0 "$MESA" live listen --wait 0
[ "$(jqs .text)" = "no lease at all" ] || fail "a lease-less listen still hears"
[ ! -e "$STUB_DIR/last-stop" ] || fail "a lease-less listen stops nobody"
run 0 "$MESA" live say "a person at a terminal"
[ "$(jqs .text)" = "a person at a terminal" ] || fail "a lease-less say still speaks"
ok "without --lease nothing is checked: listen/say behave exactly as before"

# ---- (f) a failed successor spawn leaves the session untouched ----
touch "$STUB_DIR/fail"
run 1 "$MESA" live handoff "doomed"
[ "$(jqe .error.code)" = "unavailable" ] || fail "a failed successor spawn: unavailable"
rm -f "$STUB_DIR/fail"
run 0 "$MESA" live status
[ "$(jqs .status)" = "live" ] || fail "a failed handoff must NOT end the session"
[ "$(jqs .agent_id)" = "$HA2" ] || fail "a failed handoff keeps the current agent (got $(jqs .agent_id))"
[ "$(jqs .lease)" = "2" ] || fail "a failed handoff keeps the current lease (got $(jqs .lease))"
run 0 "$MESA" live listen --lease 2 --wait 0
[ "$STDOUT" = "null" ] || fail "the current lease still listens after a failed handoff"
ok "a failed successor spawn: exit 1 unavailable, the session still live under the same agent and lease"

# ---- (g) the note is validated; nothing is spawned for a bad one ----
SPAWNS_BEFORE=$(cat "$STUB_DIR/spawns")
run 1 "$MESA" live handoff "   "
[ "$(jqe .error.code)" = "validation" ] || fail "a blank note: validation"
run 1 "$MESA" live handoff "$(head -c 8193 /dev/zero | tr '\0' x)"
[ "$(jqe .error.code)" = "validation" ] || fail "a note over LIVE_TEXT_MAX: validation"
[ "$(cat "$STUB_DIR/spawns")" = "$SPAWNS_BEFORE" ] || fail "a refused note must spawn nothing"
run 0 "$MESA" live status
[ "$(jqs .lease)" = "2" ] || fail "a refused note leaves the lease alone"
ok "live handoff: a blank or over-long note is validation, and nothing is spawned"

# ---- (h) mesa live context ----
run 0 "$MESA" live context
[ "$(jq -c 'keys' <<<"$STDOUT")" = '["agent_id","context_tokens","dream","lease","session_id"]' ] ||
  fail "live context: key set (got $STDOUT)"
[ "$(jqs .dream)" = "null" ] || fail "live context: a small notebook wants no dream (got $(jqs .dream))"
[ "$(jqs .session_id)" = "$HS" ] || fail "live context: session_id"
[ "$(jqs .agent_id)" = "$HA2" ] || fail "live context: the current agent"
[ "$(jqs .lease)" = "2" ] || fail "live context: the current lease"
[ "$(jqs .context_tokens)" = "null" ] ||
  fail "live context: the stub's uuid has no transcript, so context_tokens is null (got $(jqs .context_tokens))"
run 2 "$MESA" live context --quiet
[ -z "$STDOUT" ] || fail "live context --quiet: stdout must be empty on a usage error"
[ "$(jqe .error.code)" = "usage" ] || fail "live context --quiet: unknown argument, exit 2"
ok "live context: {session_id, agent_id, lease, context_tokens, dream} for the current agent; --quiet is a usage error"

# ---- (i) the page sees one session id throughout ----
api 200 GET "/api/live"
[ "$(jqb .session.id)" = "$HS" ] || fail "GET /api/live: the same session id across the handoff"
[ "$(jqb .session.lease)" = "2" ] || fail "GET /api/live: the lease rides on the session"
[ "$(jqb '.turns | length')" = "16" ] || fail "GET /api/live: every turn, both sides of the swap (got $(jqb '.turns | length'))"
ok "GET /api/live: one session id and one transcript across the handoff — the page sees no break"

# ---- (j) handoff --quiet: the same key set as status --quiet ----
run 0 "$MESA" live status --quiet
printf '%s' "$STDOUT" >"$TMP/ho-status-quiet.json"
run 0 "$MESA" live handoff --quiet "a third generation"
[ "$(jqs .lease)" = "3" ] || fail "handoff --quiet: lease 3"
jq -e --slurpfile s "$TMP/ho-status-quiet.json" '(keys) == ($s[0] | keys)' <<<"$STDOUT" >/dev/null ||
  fail "handoff --quiet must print the same key set as status --quiet"
run 0 "$MESA" live handoff A note that mentions --quiet in passing.
[ "$(jqs .lease)" = "4" ] || fail "handoff: --quiet typed after the note lands in the note"
grep -q -- "Note: A note that mentions --quiet in passing." "$STUB_DIR/last-prompt" ||
  fail "handoff: --quiet after the note is note text"
ok "live handoff --quiet: the session's quiet shape (nothing to drop), and --quiet must come before the note"

# Ending stops the newest agent — the one the row names.
rm -f "$STUB_DIR/last-stop"
HA_LAST=$(cat "$STUB_DIR/last-id")
run 0 "$MESA" live stop
[ "$(jqs .status)" = "ended" ] || fail "live stop after handoffs: ended"
[ "$(cat "$STUB_DIR/last-stop")" = "stop $HA_LAST" ] ||
  fail "live stop stops the agent currently holding the session (got $(cat "$STUB_DIR/last-stop" 2>/dev/null))"
# With the session ended there is nothing current to hand off: not_found,
# and nothing spawned. (The store-level race — ended between the spawn and
# the rebind — is a Rust test, `hand_off_live_session_refuses_an_ended_row…`.)
SPAWNS_BEFORE=$(cat "$STUB_DIR/spawns")
run 1 "$MESA" live handoff "after the end"
[ "$(jqe .error.code)" = "not_found" ] || fail "live handoff on an ended session: not_found"
[ "$(cat "$STUB_DIR/spawns")" = "$SPAWNS_BEFORE" ] || fail "live handoff on an ended session must spawn nothing"
run 0 "$MESA" live start --no-agent
run 1 "$MESA" live context
[ "$(jqe .error.code)" = "unavailable" ] || fail "live context with no agent bound: unavailable"
run 0 "$MESA" live stop >/dev/null
ok "live stop after handoffs stops the current agent; a handoff after the end is not_found spawning nothing; live context on a --no-agent session is unavailable"

# =====================================================================
# 16. Notice turns (mesa task 1157): telling the person the agent is stuck
# =====================================================================
#
# The live agent cannot report its own blocked state — a `claude --bg`
# session stuck on a permission prompt says nothing, and so does one that has
# simply gone quiet — so the PAGE detects it (`liveWatchdog.ts`, off the poll
# it already makes) and asks mesa to say so. The report is a `mesa` turn with
# a fixed sentence and `notice` set, written by the one Store method both
# surfaces share and deduped per working span, so two browsers racing the
# same poll cost one row and one utterance.

# ---- nothing live ----
run 1 "$MESA" live notice permission
[ "$(jqe .error.code)" = "not_found" ] || fail "live notice with nothing live: not_found"
grep -q 'mesa live start' <<<"$STDERR" || fail "live notice with nothing live: the hint must name live start"
api 404 POST "/api/live/notice" '{"kind":"stalled"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "POST /api/live/notice with nothing live: not_found"
ok "live notice with nothing live: not_found on both surfaces"

# ---- the CLI: both kinds, the turn's shape, and --quiet ----
rm -f "$STUB_DIR/blocked-id"
api 201 POST "/api/live" "{\"project_id\":$PROJ}"
NS=$(jqb .id)
NA=$(jqb .agent_id)
# The first poll of this conversation: the stub reports its job working, so
# the derived `blocked` is null — and that answer is cached for a few seconds.
api 200 GET "/api/live"
[ "$(jqb .blocked)" = "null" ] || fail "GET /api/live: blocked must be null for a working job (got $(jqb .blocked))"
BLOCKED_NULL_AT=$(date +%s)

run 0 "$MESA" live notice permission
NP=$(jqs .id)
[ "$(jqs .session_id)" = "$NS" ] || fail "notice: session_id"
[ "$(jqs .role)" = "mesa" ] || fail "notice: role must be mesa"
[ "$(jqs .notice)" = "permission" ] || fail "notice: kind (got $(jqs .notice))"
[ "$(jqs .text)" = "The agent is blocked on a permission prompt. Check the terminal." ] ||
  fail "notice: the fixed permission text (got $(jqs .text))"
[ "$(jqs .action)" = "null" ] || fail "notice: no action"
[ "$(jqs .target)" = "null" ] || fail "notice: no target"
[ "$(jqs .played_at)" = "null" ] || fail "notice: unplayed, so the page speaks it once"
ok "live notice permission: a mesa turn with the fixed sentence, no action, notice=permission"

run 0 "$MESA" live notice --quiet stalled
NST=$(jqs .id)
[ "$(jq -c 'keys' <<<"$STDOUT")" = '["action","created_at","delivered_at","id","notice","played_at","role","session_id","target"]' ] ||
  fail "notice --quiet: key set (got $(jq -c keys <<<"$STDOUT"))"
[ "$(jqs .notice)" = "stalled" ] || fail "notice --quiet keeps notice"
[ "$NST" != "$NP" ] || fail "the two kinds are independent of each other"
run 0 "$MESA" live notice stalled
[ "$(jqs .text)" = "The agent is still working, or not responding." ] ||
  fail "notice: the fixed stalled text (got $(jqs .text))"
[ "$(jqs .id)" = "$NST" ] || fail "dedupe: a second stalled notice in one span must answer the existing id"
run 0 "$MESA" live notice permission
[ "$(jqs .id)" = "$NP" ] || fail "dedupe: a second permission notice in one span must answer the existing id"
run 0 "$MESA" live turns
[ "$(jqs 'map(select(.notice != null)) | length')" = "2" ] ||
  fail "dedupe: exactly two notice rows after four calls (got $(jqs 'map(select(.notice != null)) | length'))"
[ "$(jqs 'map(select(.notice == null)) | length')" = "0" ] || fail "nothing else was written"
ok "live notice stalled + --quiet: drops text, keeps notice; a repeat of either kind answers the same id and writes nothing"

# ---- a new working span allows a fresh one ----
#
# The span is `COALESCE(working_since, started_at)`; taking the next
# utterance stamps `working_since`. The clock is second-grained, so a beat
# passes first — a notice and a stamp in the same second are one span.
api 201 POST "/api/live/utterance" '{"text":"carry on"}'
sleep 1.1
run 0 "$MESA" live listen --wait 1
run 0 "$MESA" live notice stalled
[ "$(jqs .id)" != "$NST" ] || fail "a new working span must allow a fresh stalled notice"
NST2=$(jqs .id)
run 0 "$MESA" live notice stalled
[ "$(jqs .id)" = "$NST2" ] || fail "…and dedupes again within it"
ok "live notice: a fresh working span (the agent taking the next utterance) allows a fresh notice"

# ---- a bad kind, and no kind ----
run 2 "$MESA" live notice nonsense
[ -z "$STDOUT" ] || fail "live notice with a bad kind: stdout must be empty"
[ "$(jqe .error.code)" = "usage" ] || fail "live notice with a bad kind: usage, exit 2"
run 2 "$MESA" live notice
[ "$(jqe .error.code)" = "usage" ] || fail "live notice with no kind: usage, exit 2"
ok "live notice: a bad or missing kind is a usage error (exit 2, the sidebars rule)"

# ---- the API twin: the same Store method, the same dedupe ----
api 200 POST "/api/live/notice" '{"kind":"permission"}'
NP2=$(jqb .id)
[ "$NP2" != "$NP" ] || fail "POST /api/live/notice: the new span allows a fresh permission notice"
[ "$(jqb .notice)" = "permission" ] || fail "POST /api/live/notice: notice"
[ "$(jqb .role)" = "mesa" ] || fail "POST /api/live/notice: role"
[ "$(jqb .text)" = "The agent is blocked on a permission prompt. Check the terminal." ] ||
  fail "POST /api/live/notice: the fixed text"
api 200 POST "/api/live/notice" '{"kind":"permission"}'
[ "$(jqb .id)" = "$NP2" ] || fail "POST /api/live/notice: a repeat is 200 with the existing turn"
run 0 "$MESA" live notice permission
[ "$(jqs .id)" = "$NP2" ] || fail "one store: the CLI sees the API's notice as the existing one"
api 422 POST "/api/live/notice" '{"kind":"nonsense"}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST /api/live/notice bad kind: validation"
api 422 POST "/api/live/notice" '{}'
[ "$(jqb .error.code)" = "validation" ] || fail "POST /api/live/notice no kind: validation"
raw POST "/api/live/notice" -d 'kind=permission'
[ "$STATUS" = "415" ] || fail "POST /api/live/notice without JSON Content-Type: expected 415, got $STATUS"
[ "$(jqb .error.code)" = "validation" ] || fail "POST /api/live/notice no Content-Type: error.code"
run 0 "$MESA" live turns
[ "$(jqs 'map(select(.notice != null)) | length')" = "4" ] ||
  fail "four notice rows across both surfaces (got $(jqs 'map(select(.notice != null)) | length'))"
ok "POST /api/live/notice: 200 the turn (created or existing), 422 for a bad/missing kind, 415 without JSON"

# ---- GET /api/live: the derived blocked state ----
#
# Read off `claude agents --json --all` by the session's job id, never
# stored, cached for a few seconds per job. The stub now reports the job
# blocked; the earlier null is served until its TTL runs out.
printf '%s\n' "$NA" > "$STUB_DIR/blocked-id"
ELAPSED=$(( $(date +%s) - BLOCKED_NULL_AT ))
[ "$ELAPSED" -ge 6 ] || sleep $(( 6 - ELAPSED ))
api 200 GET "/api/live"
[ "$(jqb .blocked)" = "permission prompt" ] ||
  fail "GET /api/live: blocked must carry the job's waitingFor once the stub reports it blocked (got $(jqb .blocked))"
[ "$(jqb .session.id)" = "$NS" ] || fail "GET /api/live: the same session"
rm -f "$STUB_DIR/blocked-id"
# The CLI never reads it: `live status` is the stored session alone.
run 0 "$MESA" live status
[ "$(jq -c 'has("blocked")' <<<"$STDOUT")" = "false" ] || fail "blocked is derived on the API read, never a session field"
ok "GET /api/live: blocked is null for a working job and the job's waitingFor when claude agents reports it blocked"

# ---- the archive never sees a notice ----
run 0 "$MESA" live say "The heron says the agent is fine."
run 0 "$MESA" live memory search heron
[ "$(jqs 'map(select(.kind == "turn")) | length')" = "1" ] || fail "search: the agent's own turn is indexed"
run 0 "$MESA" live memory search responding
[ "$(jqs length)" = "0" ] || fail "search: a stalled notice must not be in the archive"
run 0 "$MESA" live memory search permission
[ "$(jqs length)" = "0" ] || fail "search: a permission notice must not be in the archive"
ok "live memory search: a notice is not conversation content and is never indexed"

# ---- ended: nothing more can be reported ----
run 0 "$MESA" live stop >/dev/null
run 1 "$MESA" live notice stalled
[ "$(jqe .error.code)" = "not_found" ] || fail "live notice after the end: not_found"
ok "live notice after the conversation ended: not_found"

# =====================================================================
# 17. The automatic dream (mesa task 1155): rest at a handoff, dream at a stop
# =====================================================================
#
# `mesa live memory dream` stays explicit-only between conversations, but the
# pass now also runs on its own, gated by one deterministic check
# (`live::dream_wanted`: 300 active words, or two entries whose token sets
# overlap by half): at a handoff — the outgoing agent announces a rest, the
# dream is spawned beside the successor, the session rests until the
# successor's first `listen` finds the dream job finished — and when a
# conversation ends. The stub `claude agents` answers the dream job done from
# a `done-ids` file, so the wait is one probe rather than ten minutes.

# ---- (a) under threshold: context says no dream; a handoff rests nothing ----
rm -f "$STUB_DIR/done-ids"
run 0 "$MESA" live memory list
DW=$(jqs '[.[] | .body | [scan("\\S+")] | length] | add // 0')
[ "$DW" -lt 300 ] || fail "fixture: the notebook already holds $DW words, over the dream threshold"
run 0 "$MESA" live start "live gate project"
DS=$(jqs .id)
DA1=$(jqs .agent_id)
run 0 "$MESA" live context
[ "$(jqs .dream)" = "null" ] || fail "live context: no dream is due under threshold (got $(jqs .dream))"
SPAWNS_BEFORE=$(cat "$STUB_DIR/spawns")
run 0 "$MESA" live handoff "under threshold"
[ "$(jqs .id)" = "$DS" ] || fail "dream handoff (a): the same session"
[ "$(jqs .lease)" = "2" ] || fail "dream handoff (a): lease 2"
[ "$(jqs .resting_since)" = "null" ] || fail "a handoff under threshold must not rest the session (got $(jqs .resting_since))"
[ "$(cat "$STUB_DIR/spawns")" = "$((SPAWNS_BEFORE + 1))" ] ||
  fail "a handoff under threshold spawns the successor and nothing else (got $(( $(cat "$STUB_DIR/spawns") - SPAWNS_BEFORE )) spawns)"
DA2=$(jqs .agent_id)
[ "$DA2" = "$(cat "$STUB_DIR/last-id")" ] && [ "$DA2" != "$DA1" ] ||
  fail "dream handoff (a): agent_id is the successor's receipt"
[ -z "$STDERR" ] || fail "dream handoff (a): nothing on stderr (got: $STDERR)"
ok "the automatic dream: under threshold live context reports dream null and a handoff rests nothing and spawns no dream"

# ---- (b) two lookalike entries: context reports why, the handoff rests ----
run 0 "$MESA" live memory add "DREAM-DUP-A: prefers the roadmap read out first every morning."
DD_A=$(jqs .id)
run 0 "$MESA" live memory add "DREAM-DUP-B: prefers the roadmap read out first every evening."
DD_B=$(jqs .id)
run 0 "$MESA" live context
[ "$(jqs .dream)" = "entries $DD_A and $DD_B look alike" ] ||
  fail "live context: two lookalike entries are a dream reason naming both ids (got $(jqs .dream))"
SPAWNS_BEFORE=$(cat "$STUB_DIR/spawns")
run 0 "$MESA" live handoff "resting handoff"
[ "$(jqs .lease)" = "3" ] || fail "dream handoff (b): lease 3"
[ "$(jqs .status)" = "live" ] || fail "dream handoff (b): the session stays live"
[ "$(jqs .resting_since)" != "null" ] || fail "a handoff that dreams must rest the session (got $STDOUT)"
[ "$(cat "$STUB_DIR/spawns")" = "$((SPAWNS_BEFORE + 2))" ] ||
  fail "a handoff that dreams spawns the successor AND the dream (got $(( $(cat "$STUB_DIR/spawns") - SPAWNS_BEFORE )) spawns)"
DREAM_ID=$(cat "$STUB_DIR/last-id")
DA3=$(jqs .agent_id)
[ "$DA3" = "deadbeef-$(( $(cat "$STUB_DIR/spawns") - 1 ))" ] ||
  fail "dream handoff (b): agent_id is the successor's receipt, spawned before the dream (got $DA3)"
[ "$DA3" != "$DREAM_ID" ] || fail "dream handoff (b): the dream's receipt must not be bound as the agent"
[ "$(cat "$STUB_DIR/last-flags")" = "$EXPECTED_DREAM_FLAGS" ] ||
  fail "the handoff's dream spawn must go through the live-dream template (got $(cat "$STUB_DIR/last-flags" | tr '\n' ' '))"
grep -q "You are tidying mesa's notebook between conversations" "$STUB_DIR/last-prompt" ||
  fail "the handoff's dream spawn must carry DREAM_PROMPT"
grep -q "DREAM-DUP-A" "$STUB_DIR/last-prompt" && grep -q "DREAM-DUP-B" "$STUB_DIR/last-prompt" ||
  fail "the handoff's dream spawn must carry the active notebook"
[ -z "$STDERR" ] || fail "dream handoff (b): nothing on stderr (got: $STDERR)"
run 0 "$MESA" live status
[ "$(jqs .resting_since)" != "null" ] || fail "live status: resting_since rides on the session"
api 200 GET "/api/live"
[ "$(jqb .session.resting_since)" != "null" ] || fail "GET /api/live: resting_since must ride on the session"
[ "$(jq -c '.session | has("dream_agent_id")' <<<"$BODY")" = "false" ] ||
  fail "GET /api/live: the dream's receipt is store-only, never on the session"
run 1 "$MESA" live memory dream
[ "$(jqe .error.code)" = "conflict" ] || fail "the explicit dream verb is still conflict while a session rests"
ok "the automatic dream: two lookalike entries make context report why, and the handoff spawns live-dream beside the successor and rests the session — on live status and GET /api/live"

# ---- (c) the successor's first listen waits out the rest, then wakes ----
printf '%s\n' "$DREAM_ID" > "$STUB_DIR/done-ids"
api 201 POST "/api/live/utterance" '{"text":"said while resting"}'
rm -f "$STUB_DIR/last-stop"
run 0 "$MESA" live listen --lease 3 --wait 0
[ "$(jqs .text)" = "said while resting" ] ||
  fail "listen --lease 3: once the dream job is done the queued utterance is handed over (got $STDOUT)"
[ "$(cat "$STUB_DIR/last-stop" 2>/dev/null)" = "stop $DA2" ] ||
  fail "the woken successor's first listen still stops the predecessor (got $(cat "$STUB_DIR/last-stop" 2>/dev/null))"
[ -z "$STDERR" ] || fail "a rest that ends before its cap warns about nothing (got: $STDERR)"
run 0 "$MESA" live status
[ "$(jqs .resting_since)" = "null" ] || fail "listen must wake the session: resting_since back to null (got $(jqs .resting_since))"
[ "$(jqs .lease)" = "3" ] || fail "a wake moves nothing but the rest"
api 200 GET "/api/live"
[ "$(jqb .session.resting_since)" = "null" ] || fail "GET /api/live: woken"
rm -f "$STUB_DIR/done-ids"
ok "the automatic dream: listen --lease wakes a resting session once claude agents reports the dream done, hands the queued turn over and stops the predecessor once"

# ---- (d) live stop: a dream over threshold, none under it ----
run 0 "$MESA" live say --lease 3 "A turn, so the summariser has something to read."
SPAWNS_BEFORE=$(cat "$STUB_DIR/spawns")
run 0 "$MESA" live stop
[ "$(jqs .status)" = "ended" ] || fail "live stop (over threshold): ended"
[ "$(jqs .resting_since)" = "null" ] || fail "an ended session is never resting"
[ "$(cat "$STUB_DIR/spawns")" = "$((SPAWNS_BEFORE + 2))" ] ||
  fail "live stop over threshold spawns the summariser AND the dream (got $(( $(cat "$STUB_DIR/spawns") - SPAWNS_BEFORE )) spawns)"
[ "$(cat "$STUB_DIR/last-flags")" = "$EXPECTED_DREAM_FLAGS" ] ||
  fail "live stop's dream spawn must go through the live-dream template (got $(cat "$STUB_DIR/last-flags" | tr '\n' ' '))"
[ "$(cat "$STUB_DIR/last-cwd")" = "$WORKDIR" ] ||
  fail "live stop's dream runs in the conversation's project folder (got $(cat "$STUB_DIR/last-cwd"))"
run 0 "$MESA" live memory delete "$DD_A"
run 0 "$MESA" live memory delete "$DD_B"
run 0 "$MESA" live start "live gate project"
run 0 "$MESA" live say "One turn, under threshold."
SPAWNS_BEFORE=$(cat "$STUB_DIR/spawns")
run 0 "$MESA" live stop
[ "$(cat "$STUB_DIR/spawns")" = "$((SPAWNS_BEFORE + 1))" ] ||
  fail "live stop under threshold spawns the summariser alone (got $(( $(cat "$STUB_DIR/spawns") - SPAWNS_BEFORE )) spawns)"
[ "$(sed -n 5p "$STUB_DIR/last-flags")" = "Live gate project: live $(jqs .id) summary" ] ||
  fail "live stop under threshold: the one spawn is the summariser (got $(sed -n 5p "$STUB_DIR/last-flags"))"
ok "the automatic dream: live stop spawns the dream beside the summariser over threshold and only the summariser under it"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=


echo "all $CHECKS checks passed"
