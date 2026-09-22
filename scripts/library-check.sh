#!/usr/bin/env bash
# Library gate (mesa task 919): exercises agents, skills, hooks, prompts and
# CLAUDE.md files stored as first-class records — create -> list
# -> show (by id and by name) -> update -> delete, the built-in fork/restore
# rule, version history, and the sync loop against real files on disk — over
# both the CLI (`mesa library ...`) and the API (`/api/library...`), against a
# throwaway MESA_DB and a throwaway HOME (this gate writes into `.claude`, so
# it must never touch the real one).
#
# Covers, in order:
#   1. CRUD over the CLI: create (positional/flag forms, --scope project),
#      list (bare array, built-ins included), show/get (by id, by name,
#      case-insensitively), update (patches one field, forking a built-in),
#      delete (echoes the full destroyed record), and the domain errors
#      (duplicate name -> conflict, unknown id/name -> not_found);
#   2. the --quiet contract: accepted on create/update/delete/show/get,
#      dropping exactly body+synced_body and keeping name; rejected (exit 2,
#      empty stdout) on list, versions and both sync subcommands; `update`
#      with no field flag is exit 2 usage with empty stdout;
#   3. the name rule — ../evil, a/b, .., ., and an empty name are each
#      `validation` on both surfaces, the traversal chokepoint a synced row
#      relies on;
#   4. built-ins: an unshadowed one lists with id:null, builtin:true; editing
#      it forks a real row carrying builtin_id; deleting the fork restores it
#      unshadowed; deleting an unshadowed built-in is validation; forking the
#      same built-in twice over the API is 409 conflict;
#   5. version history: a real body change appends a version (source "edit"),
#      a no-op update appends none;
#   6. the sync loop, for real, against files under the sandboxed $HOME/.claude
#      — mesa-new written to disk, disk-changed pulled in (appending a
#      sync-pull version), mesa-changed pushed to disk, a stray file adopted
#      as disk-new, disk-deleted resolved both ways (recreate vs. delete the
#      row), and both-changed offered as a conflict where `skip` leaves both
#      sides untouched — asserting actual file bytes, not just the JSON;
#   7. a CRUD round-trip over the API, the malformed-JSON/Content-Type cases,
#      and the fork route's 404/409;
#   8. the security boundary in default mode AND `--lan`: all eleven routes —
#      reads, authoring, both sync routes and both bundle routes — share
#      `require_agent_access` (mesa task 1004, replacing the old
#      loopback-only gate), so in default mode a foreign Host AND a foreign
#      Origin are each refused, while under `--lan` a DNS-name Host
#      (rebinding) and a foreign Origin (cross-site) are refused but a
#      genuine LAN page is served; plus the Content-Type gate firing on every
#      mutation in both modes;
#   9. the live conversation's agent definition comes from the library (mesa
#      task 1068, replacing the `live-agent-prompt` prompt task 919 had made
#      of `config.json`'s `live.prompt`): `mesa-live` starts unshadowed as a
#      user-scope `agent` at `.claude/agents/mesa-live.md`, appears in `sync
#      status` and is written to disk by `sync apply`, the spawned prompt
#      carries the session line ALONE, and editing it forks it with the
#      forked body replacing the built-in;
#  10. import/export (mesa task 963): a CLI round trip (a user row plus a
#      forked built-in export, with no unshadowed built-in and none of
#      id/synced_*/created_at/updated_at/path on an item), importing that
#      bundle into a second, empty db (bodies byte-identical, the fork still
#      carrying its builtin_id, a project-scoped item whose project doesn't
#      exist there failing alone while the rest of the batch still applies),
#      re-import (skip leaves bodies untouched, replace overwrites), an
#      unknown bundle version refusing the whole import with nothing written,
#      `--output` refusing to clobber an existing path, `--quiet` rejected on
#      both commands, and the two new routes added to the gate sweeps in both
#      serve modes;
#  11. hook registration in `.claude/settings.json` (mesa task 1115):
#      status -> enable -> status sees it -> disable, against a settings file
#      that already holds somebody else's settings and somebody else's hook,
#      which must come back BYTE-IDENTICAL; enabling seeding the hook's own
#      script to disk (executable, never overwritten) so the registration
#      never names a file that does not exist; a null `hooks` treated as an
#      absent one on both verbs; a second disable as a no-op success;
#      `--quiet` rejected (exit 2, empty stdout) on all three subcommands;
#      and the three routes joining the gate sweeps (now fourteen routes) in
#      both serve modes;
#  12. the command kind folded into prompt (mesa task 1139): a db holding a
#      pre-1139 `command` row opens as a prompt with `export_command` on,
#      same id and history; `--kind command` is validation; an exporting
#      prompt's file is BYTE-IDENTICAL to its body (cmp) and `sync status`
#      reads in-sync the moment it is written; `--no-export-command` removes
#      the file mesa wrote but leaves a hand-edited one for `disk-new`; the
#      flag survives `--quiet`; and a bundle still saying `"kind":
#      "command"` imports as an exporting prompt;
#  13. hooks wired from outside `.claude/hooks/` (mesa task 1128): against a
#      settings file holding an unrelated key, somebody else's registration,
#      an in-tree command, `bash $HOME/scripts/warm.sh --fast` under two
#      events and a `~/gone/missing.py`, `hook orphans` lists exactly the two
#      out-of-tree rows (exists true/false, two registrations on the first,
#      the in-tree one absent); `adopt` on the missing one is exit 1
#      not_found; a pre-created `.claude/hooks/warm.sh` makes it conflict
#      with the settings file untouched; a real adoption moves the script
#      (executable), rewrites both commands keeping `bash ` and `--fast`,
#      leaves every other byte IDENTICAL (cmp against a sed of the
#      original), shows two registrations on the new item and in-sync in
#      `sync status`, and drops out of `orphans`; `--quiet` rejected on
#      both; and the two routes serving over the API (both sweeps in
#      section 8 now cover sixteen routes).
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; [ -n "${LAN_PID:-}" ] && kill "$LAN_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"

# A throwaway HOME: user-scope library rows sync against $HOME/.claude, so
# this must never be the developer's real one.
mkdir -p "$TMP/home"
export HOME="$TMP/home"
HOME_REAL=$(cd "$TMP/home" && pwd -P)

# Isolate from the developer's real ~/.mesa/config.json — a configured
# `live-agent` template would defeat the built-in-vs-forked prompt assertions
# in section 9 (config-check.sh owns the configured-template half; this gate
# proves the built-in half now resolves through the library, not the file).
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
    fail "expected exit $expected, got $CODE: $* (stdout: $STDOUT) (stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- stub claude (section 9: the live prompt now lives in the library) ----
#
# Only what that section needs: the flags/prompt of the last `--bg` spawn.
STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/claude" <<EOF
#!/usr/bin/env bash
case "\$1" in
  --bg)
    PROMPT=""
    for a in "\$@"; do PROMPT=\$a; done
    printf '%s' "\$PROMPT" > "$STUB_DIR/last-prompt"
    echo "backgrounded · deadbeef (idle — send a prompt to start)"
    ;;
  stop)
    printf '%s\n' "\$*" > "$STUB_DIR/last-stop"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"

# ================= 1. CLI: CRUD =================

run 0 "$MESA" library create prompt cli-note 'remember this'
[ "$(jqs .name)" = "cli-note" ] || fail "CLI create: name"
[ "$(jqs .kind)" = "prompt" ] || fail "CLI create: kind"
[ "$(jqs .scope)" = "user" ] || fail "CLI create: scope defaults to user"
[ "$(jqs .project_id)" = "null" ] || fail "CLI create: unbound by default"
[ "$(jqs .body)" = "remember this" ] || fail "CLI create: body verbatim"
[ "$(jqs .builtin)" = "false" ] || fail "CLI create: builtin false"
[ "$(jqs .builtin_id)" = "null" ] || fail "CLI create: builtin_id null"
[ "$(jqs .path)" = "null" ] || fail "CLI create: a prompt has no path"
[ "$(jqs .synced_body)" = "null" ] || fail "CLI create: synced_body null before any sync"
[ "$(jqs .created_at)" != "null" ] || fail "CLI create: created_at"
[ "$(jqs .updated_at)" != "null" ] || fail "CLI create: updated_at"
LIB_NOTE=$(jqs .id)
ok "CLI library create: positional KIND NAME BODY returns the full record"

run 0 "$MESA" project create "Library project" --no-git
LP=$(jqs .id)
run 0 "$MESA" library create --kind agent --name reviewer --body 'be nice' \
  --scope project --project "Library project"
[ "$(jqs .scope)" = "project" ] || fail "CLI create --scope project: scope"
[ "$(jqs .project_id)" = "$LP" ] || fail "CLI create --project NAME: resolves a project name"
[ "$(jqs .path)" = ".claude/agents/reviewer.md" ] || fail "CLI create: path derived from kind/scope/name"
LIB_REVIEWER=$(jqs .id)
ok "CLI library create --kind/--name/--body/--scope project/--project NAME: flag form, binds and derives the path"

printf 'file body\n' > "$TMP/body.txt"
run 0 "$MESA" library create prompt greeter --body-file "$TMP/body.txt" --export-command
[ "$(jqs .body)" = "$(cat "$TMP/body.txt")" ] || fail "CLI create --body-file: body verbatim"
[ "$(jqs .export_command)" = "true" ] || fail "CLI create --export-command: flag on"
[ "$(jqs .path)" = ".claude/commands/greeter.md" ] || fail "CLI create: an exporting prompt's path"
ok "CLI library create --body-file --export-command: body read from a file, the prompt owning .claude/commands/<name>.md"

# The flag is a prompt's alone (mesa task 1139); the old `command` kind is
# gone from every parser but the bundle's.
run 1 "$MESA" library create agent flagged-agent 'x' --export-command
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create agent --export-command: error.code"
run 1 "$MESA" library create command old-kind 'x'
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create --kind command: error.code"
ok "CLI library create: --export-command on a non-prompt and the retired 'command' kind are each exit 1 validation"

run 0 "$MESA" library create prompt second-note 'x'
LIB_SECOND=$(jqs .id)
ok "fixture: a second prompt/user item, for the name-conflict check below"

# ---- create: usage / domain errors ----

run 2 "$MESA" library create
[ "$(jqe .error.code)" = "usage" ] || fail "CLI create with nothing: code=usage"
ok "CLI library create with no KIND/NAME/BODY: exit 2 usage"

run 1 "$MESA" library create prompt scope-needs-project --body x --scope project
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create --scope project w/o --project: error.code"
ok "CLI library create --scope project without --project: exit 1 validation"

run 1 "$MESA" library create bogus-kind name --body x
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create unknown kind: error.code"
ok "CLI library create with an unknown kind: exit 1 validation"

run 1 "$MESA" library create prompt cli-note --body other
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI create duplicate name: error.code"
ok "CLI library create with a duplicate (kind,scope,name): exit 1 conflict"

# ---- list ----

run 0 "$MESA" library list
[ "$(jqs type)" = "array" ] || fail "CLI list: bare array"
[ "$(jqs 'map(select(.builtin_id=="mesa-live")) | length')" = "1" ] ||
  fail "CLI list: the mesa-live built-in must be present, got $STDOUT"
[ "$(jqs '.[] | select(.builtin_id=="mesa-live") | .id')" = "null" ] ||
  fail "CLI list: an unshadowed built-in must report id:null"
[ "$(jqs '.[] | select(.builtin_id=="mesa-live") | .builtin')" = "true" ] ||
  fail "CLI list: an unshadowed built-in must report builtin:true"
ok "CLI library list: bare array including every unshadowed built-in (id:null, builtin:true)"

run 0 "$MESA" library list --kind prompt
[ "$(jqs 'all(.kind == "prompt")')" = "true" ] || fail "CLI list --kind: not all prompt, got $STDOUT"
[ "$(jqs 'map(select(.name=="cli-note")) | length')" = "1" ] || fail "CLI list --kind: missing cli-note"
ok "CLI library list --kind: filters to one kind"

run 0 "$MESA" library list "Library project"
[ "$(jqs 'map(select(.name=="reviewer")) | length')" = "1" ] || fail "CLI list PROJECT: missing reviewer"
[ "$(jqs 'map(select(.name=="cli-note")) | length')" = "1" ] ||
  fail "CLI list PROJECT: a user-scope item must still be included"
ok "CLI library list <PROJECT>: project-scope items for it plus every user-scope item"

# ---- show / get ----

run 0 "$MESA" library show "$LIB_NOTE"
[ "$(jqs .id)" = "$LIB_NOTE" ] || fail "CLI show by id"
[ "$(jqs .body)" = "remember this" ] || fail "CLI show: full record includes body"
run 0 "$MESA" library show cli-note
[ "$(jqs .id)" = "$LIB_NOTE" ] || fail "CLI show by name"
run 0 "$MESA" library show CLI-NOTE
[ "$(jqs .id)" = "$LIB_NOTE" ] || fail "CLI show by name: case-insensitive"
run 0 "$MESA" library get "$LIB_NOTE"
[ "$(jqs .id)" = "$LIB_NOTE" ] || fail "CLI get: alias for show"
ok "CLI library show/get <ID>|<NAME>: full record, case-insensitive name resolution"

run 1 "$MESA" library show 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI show unknown id: error.code"
run 1 "$MESA" library show no-such-item
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI show unknown name: error.code"
ok "CLI library show unknown id/name: exit 1, code=not_found"

# ---- update ----

run 0 "$MESA" library update "$LIB_NOTE" --body 'updated body'
[ "$(jqs .body)" = "updated body" ] || fail "CLI update --body"
run 0 "$MESA" library update cli-note --name cli-note-renamed
[ "$(jqs .name)" = "cli-note-renamed" ] || fail "CLI update by name --name: renames"
LIB_NOTE_NAME=cli-note-renamed
ok "CLI library update: patches one field at a time, resolves by name"

run 1 "$MESA" library update "$LIB_NOTE" --name second-note
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI update to a taken name: error.code"
ok "CLI library update to an already-taken (kind,scope) name: exit 1 conflict"

run 2 "$MESA" library update "$LIB_NOTE"
[ "$(jqe .error.code)" = "usage" ] || fail "CLI update with no field flag: code=usage"
[ -z "$STDOUT" ] || fail "CLI update usage error: stdout must be empty"
ok "CLI library update with no field flag: exit 2, code=usage, empty stdout"

run 1 "$MESA" library update 999999 --name whatever
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI update unknown id: error.code"
ok "CLI library update unknown id: exit 1, code=not_found"

# ---- delete ----

run 0 "$MESA" library show "$LIB_SECOND"
FULL=$STDOUT
run 0 "$MESA" library delete "$LIB_SECOND"
[ "$(jq -S . <<<"$STDOUT")" = "$(jq -S . <<<"$FULL")" ] ||
  fail "CLI delete: must echo the full destroyed record verbatim"
ok "CLI library delete: echoes the full destroyed record (recovery transcript)"

run 1 "$MESA" library show "$LIB_SECOND"
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI delete: item actually gone"
run 1 "$MESA" library delete 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI delete unknown id: error.code"
ok "CLI library delete: the record is gone, and deleting an unknown id is not_found"

# ================= 2. --quiet contract =================

# The quiet shape is the record minus exactly body+synced_body, keeping name.
quiet_parity() { # quiet_parity <label> <full-json> <quiet-json>
  local label=$1 full=$2 quiet=$3
  local dropped
  dropped=$(jq -r --argjson q "$quiet" \
    '[keys_unsorted[] as $k | select($q | has($k) | not) | $k] | sort | join(",")' <<<"$full")
  [ "$dropped" = "body,synced_body" ] ||
    fail "$label: --quiet must drop exactly body,synced_body — dropped: [$dropped]"
  [ "$(jq -r '.name != null' <<<"$quiet")" = "true" ] || fail "$label: --quiet must keep name"
  [ "$(jq -S 'del(.body, .synced_body)' <<<"$full")" = "$(jq -S . <<<"$quiet")" ] ||
    fail "$label: --quiet changed a value, not just the key set"
}

run 0 "$MESA" library show "$LIB_REVIEWER"
FULL=$STDOUT
run 0 "$MESA" library show "$LIB_REVIEWER" --quiet
quiet_parity "library show" "$FULL" "$STDOUT"
ok "--quiet on library show: drops exactly body+synced_body, keeps name, every other key/value identical"

run 0 "$MESA" library create prompt quiettest 'q' --quiet
QUIET=$STDOUT
QID=$(jq -r .id <<<"$QUIET")
run 0 "$MESA" library show "$QID"
quiet_parity "library create" "$STDOUT" "$QUIET"
[ "$(jqs .body)" = "q" ] || fail "quiet create: the record was still stored in full"
ok "--quiet on library create: prints the record minus body+synced_body, storing it in full"

run 0 "$MESA" library update "$QID" --body 'q2'
FULL=$STDOUT
run 0 "$MESA" library update "$QID" --body 'q3' --quiet
QUIET=$STDOUT
run 0 "$MESA" library show "$QID"
quiet_parity "library update" "$STDOUT" "$QUIET"
ok "--quiet on library update: drops exactly body+synced_body"

run 0 "$MESA" library show "$QID"
FULL=$STDOUT
run 0 "$MESA" library delete "$QID" --quiet
quiet_parity "library delete" "$FULL" "$STDOUT"
run 1 "$MESA" library show "$QID"
[ "$(jqe .error.code)" = "not_found" ] || fail "quiet delete: the record is actually gone"
ok "--quiet on library delete: drops exactly body+synced_body and the record is gone"

run 2 "$MESA" library list --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on list: code=usage"
run 2 "$MESA" library versions "$LIB_REVIEWER" --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on versions: code=usage"
run 2 "$MESA" library sync status --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on sync status: code=usage"
run 2 "$MESA" library sync apply --all-mesa --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on sync apply: code=usage"
ok "--quiet on list/versions/sync status/sync apply: rejected as an unknown argument, exit 2 usage"

# ================= 3. the name rule =================
# The traversal chokepoint every synced path depends on: no /, no \, no ..,
# nothing empty. Proved on both surfaces.

for BADNAME in '../evil' 'a/b' '..' '.' ''; do
  if [ -z "$BADNAME" ]; then
    run 1 "$MESA" library create prompt '' 'x'
  else
    run 1 "$MESA" library create prompt "$BADNAME" 'x'
  fi
  [ "$(jqe .error.code)" = "validation" ] || fail "CLI create name $BADNAME: expected validation, got $STDERR"
done
ok "CLI library create: '../evil', 'a/b', '..', '.', and an empty name are each exit 1 validation"

# The API-side half of this same rule runs against the live server in
# section 7, once it is up.

# ================= 4. built-ins: fork / restore =================
# `stop-notify.sh` is the fixture for this section, leaving `mesa-live`
# untouched for section 9.

run 0 "$MESA" library list
[ "$(jqs '.[] | select(.builtin_id=="stop-notify") | .id')" = "null" ] ||
  fail "fixture: stop-notify must start unshadowed"
BUILTIN_BODY=$(jqs '.[] | select(.builtin_id=="stop-notify") | .body')
ok "fixture: stop-notify is an unshadowed built-in before this section touches it"

run 0 "$MESA" library update stop-notify.sh --body 'echo custom hook'
[ "$(jqs .id)" != "null" ] || fail "editing a built-in must fork it into a real row"
[ "$(jqs .builtin_id)" = "stop-notify" ] || fail "the fork must carry its builtin_id"
[ "$(jqs .builtin)" = "false" ] || fail "the fork itself is not the built-in anymore"
[ "$(jqs .body)" = "echo custom hook" ] || fail "the fork must carry the new body"
STOP_FORK=$(jqs .id)
ok "editing an unshadowed built-in (library update stop-notify.sh) forks it into a real row"

run 0 "$MESA" library list
[ "$(jqs 'map(select(.builtin_id=="stop-notify" and .id==null)) | length')" = "0" ] ||
  fail "the built-in must stop appearing unshadowed once forked"
[ "$(jqs "map(select(.id==$STOP_FORK)) | length")" = "1" ] || fail "the fork must appear in list"
ok "list no longer offers stop-notify unshadowed once it has a fork"

run 0 "$MESA" library delete "$STOP_FORK"
run 0 "$MESA" library list
[ "$(jqs '.[] | select(.builtin_id=="stop-notify") | .id')" = "null" ] ||
  fail "deleting the fork must restore the built-in unshadowed"
[ "$(jqs '.[] | select(.builtin_id=="stop-notify") | .body')" = "$BUILTIN_BODY" ] ||
  fail "the restored built-in must be back to its original body"
ok "deleting the fork restores the built-in unshadowed, with its original body"

run 1 "$MESA" library delete stop-notify.sh
[ "$(jqe .error.code)" = "validation" ] || fail "deleting an unshadowed built-in: expected validation"
ok "deleting an unshadowed built-in (nothing to delete): exit 1 validation"

echo "== library-check: sections 1-4 passed ($CHECKS checks so far) =="

# ================= 5. version history =================

run 0 "$MESA" library versions "$LIB_REVIEWER"
[ "$(jqs type)" = "array" ] || fail "CLI versions: bare array"
[ "$(jqs length)" = "1" ] || fail "CLI versions: creation must write version 1, got $STDOUT"
[ "$(jqs '.[0].source')" = "edit" ] || fail "CLI versions: creation source must be edit"
[ "$(jqs '.[0].body')" = "be nice" ] || fail "CLI versions: version body"
ok "library versions: creating an item writes its first version (source: edit)"

run 0 "$MESA" library update "$LIB_REVIEWER" --body 'be nicer'
run 0 "$MESA" library versions "$LIB_REVIEWER"
[ "$(jqs length)" = "2" ] || fail "CLI versions: a real body change must append a version, got $STDOUT"
ok "a real body change appends a version"

run 0 "$MESA" library update "$LIB_REVIEWER" --body 'be nicer'
run 0 "$MESA" library versions "$LIB_REVIEWER"
[ "$(jqs length)" = "2" ] || fail "CLI versions: a no-op update must append nothing, got $STDOUT"
ok "a no-op update (byte-identical body) appends no version"

run 0 "$MESA" library update "$LIB_REVIEWER" --name reviewer2
run 0 "$MESA" library versions "$LIB_REVIEWER"
[ "$(jqs length)" = "2" ] || fail "CLI versions: renaming alone must append no version, got $STDOUT"
run 0 "$MESA" library update "$LIB_REVIEWER" --name reviewer
ok "renaming without changing the body appends no version either"

run 0 "$MESA" library versions live-summary-prompt
[ "$(jqs type)" = "array" ] || fail "CLI versions on an unshadowed built-in: bare array"
[ "$(jqs length)" = "0" ] || fail "CLI versions on an unshadowed built-in: expected empty, got $STDOUT"
ok "library versions on an unshadowed built-in: empty array (no row, no history)"

# ================= 6. the sync loop, for real =================
# Every assertion below reads the actual bytes under $HOME_REAL/.claude.

CLAUDE_DIR="$HOME_REAL/.claude"

# ---- mesa-new: a fresh row, never synced, no file yet ----

run 0 "$MESA" library create agent syncnew 'version A'
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="syncnew" and .kind=="agent")')
[ "$(jq -r .status <<<"$ROW")" = "mesa-new" ] || fail "sync status: syncnew must be mesa-new, got $ROW"
[ "$(jq -r .path <<<"$ROW")" = ".claude/agents/syncnew.md" ] || fail "sync status: syncnew path"
[ "$(jq -r .disk_body <<<"$ROW")" = "null" ] || fail "sync status: syncnew must have no disk_body yet"
[ "$(jq -r .baseline <<<"$ROW")" = "null" ] || fail "sync status: syncnew must have no baseline yet"
[ "$(jq -r .disk_mtime <<<"$ROW")" = "null" ] ||
  fail "sync status: a mesa-new row has no file, so disk_mtime must be null, got $ROW"
[ "$(jq -r .diff <<<"$ROW")" = "null" ] ||
  fail "sync status: a one-sided row has nothing to diff, so diff must be null, got $ROW"
[ "$(jq -r .mesa_updated_at <<<"$ROW")" != "null" ] ||
  fail "sync status: a real mesa row always has a mesa_updated_at, got $ROW"
ok "sync status: a freshly-created item with no file on disk is mesa-new, with a null disk_mtime and no diff"

run 0 "$MESA" library sync apply --resolve '.claude/agents/syncnew.md=mesa'
RESULT=$(jqs '.[0]')
[ "$(jq -r .applied <<<"$RESULT")" = "true" ] || fail "sync apply mesa on mesa-new: must apply, got $RESULT"
[ "$(jq -r .choice <<<"$RESULT")" = "mesa" ] || fail "sync apply mesa: echoes the choice"
[ -f "$CLAUDE_DIR/agents/syncnew.md" ] || fail "sync apply mesa: file must be written"
[ "$(cat "$CLAUDE_DIR/agents/syncnew.md")" = "version A" ] ||
  fail "sync apply mesa: file content, got $(cat "$CLAUDE_DIR/agents/syncnew.md")"
ok "sync apply (mesa) on a mesa-new row writes the file at the right path with the mesa body"

run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="syncnew" and .kind=="agent")')
[ "$(jq -r .status <<<"$ROW")" = "in-sync" ] || fail "sync status after apply: expected in-sync, got $ROW"
[ "$(jq -r .diff <<<"$ROW")" = "null" ] ||
  fail "sync status: an in-sync row's two sides are the same text, so diff must be null, got $ROW"
[ "$(jq -r .disk_mtime <<<"$ROW")" != "null" ] ||
  fail "sync status: the file exists now, so disk_mtime must be a timestamp, got $ROW"
ok "after applying mesa, the row reports in-sync, with a disk_mtime and no diff"

# ---- disk-changed: the disk side moved since the last sync ----

printf 'version A\nedited on disk\n' > "$CLAUDE_DIR/agents/syncnew.md"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="syncnew" and .kind=="agent")')
[ "$(jq -r .status <<<"$ROW")" = "disk-changed" ] || fail "sync status: expected disk-changed, got $ROW"
ok "editing the file on disk (mesa untouched) reports disk-changed"

run 0 "$MESA" library versions syncnew
BEFORE_VERSIONS=$(jqs length)
run 0 "$MESA" library sync apply --resolve '.claude/agents/syncnew.md=disk'
RESULT=$(jqs '.[0]')
[ "$(jq -r .applied <<<"$RESULT")" = "true" ] || fail "sync apply disk: must apply, got $RESULT"
run 0 "$MESA" library show syncnew
[ "$(jqs .body)" = "$(cat "$CLAUDE_DIR/agents/syncnew.md")" ] ||
  fail "sync apply disk: mesa body must be pulled from the file"
[ "$(jqs .synced_body)" = "$(jqs .body)" ] || fail "sync apply disk: synced_body must match the pulled body"
run 0 "$MESA" library versions syncnew
[ "$(jqs length)" = "$((BEFORE_VERSIONS + 1))" ] ||
  fail "sync apply disk: must append exactly one version, had $BEFORE_VERSIONS now $(jqs length)"
[ "$(jqs '.[0].source')" = "sync-pull" ] || fail "sync apply disk: the new version's source must be sync-pull"
ok "sync apply (disk) on a disk-changed row pulls the file into the body and appends a sync-pull version"

# ---- mesa-changed: mesa moved, disk untouched, since the last sync ----

run 0 "$MESA" library update syncnew --body 'mesa edit'
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="syncnew" and .kind=="agent")')
[ "$(jq -r .status <<<"$ROW")" = "mesa-changed" ] || fail "sync status: expected mesa-changed, got $ROW"
run 0 "$MESA" library sync apply --resolve '.claude/agents/syncnew.md=mesa'
[ "$(cat "$CLAUDE_DIR/agents/syncnew.md")" = "mesa edit" ] ||
  fail "sync apply mesa on mesa-changed: file must be overwritten with the new body"
ok "editing the body in mesa (disk untouched) reports mesa-changed, and applying mesa pushes it to disk"

# ---- disk-new: a file mesa has never seen ----

mkdir -p "$CLAUDE_DIR/commands"
printf 'adopt me' > "$CLAUDE_DIR/commands/adopted.md"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="adopted" and .kind=="prompt")')
[ "$(jq -r .status <<<"$ROW")" = "disk-new" ] || fail "sync status: expected disk-new, got $ROW"
[ "$(jq -r .item_id <<<"$ROW")" = "null" ] || fail "sync status: disk-new row must have no item_id"
[ "$(jq -r .mesa_updated_at <<<"$ROW")" = "null" ] ||
  fail "sync status: a disk-new row has no mesa side, so mesa_updated_at must be null, got $ROW"
[ "$(jq -r .diff <<<"$ROW")" = "null" ] ||
  fail "sync status: a disk-new row has nothing to diff, so diff must be null, got $ROW"
[ "$(jq -r .disk_mtime <<<"$ROW")" != "null" ] ||
  fail "sync status: a disk-new row's file must report an mtime, got $ROW"
ok "a file with no mesa row at all reports disk-new"

run 0 "$MESA" library sync apply --resolve '.claude/commands/adopted.md=disk'
[ "$(jqs '.[0].applied')" = "true" ] || fail "sync apply disk on disk-new: must apply"
run 0 "$MESA" library show adopted
[ "$(jqs .body)" = "adopt me" ] || fail "sync apply disk on disk-new: adopted body must match the file"
[ "$(jqs .kind)" = "prompt" ] || fail "sync apply disk on disk-new: adopted kind"
[ "$(jqs .export_command)" = "true" ] ||
  fail "sync apply disk on disk-new: a commands file adopts as a prompt that EXPORTS (mesa task 1139)"
[ "$(jqs .path)" = ".claude/commands/adopted.md" ] || fail "sync apply disk on disk-new: adopted path"
[ "$(jqs .project_id)" = "null" ] || fail "sync apply disk on disk-new: adopted is user-scope"
ok "sync apply (disk) on a disk-new row adopts the file into a new library row — a commands file as an exporting prompt"

# A hook is any script the user drops in, not only a `*.sh` one, and its
# name carries the extension so it round-trips back to the same file
# (mesa task 1114).
mkdir -p "$CLAUDE_DIR/hooks"
printf '# python guard' > "$CLAUDE_DIR/hooks/poll-guard.py"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="poll-guard.py" and .kind=="hook")')
[ "$(jq -r .status <<<"$ROW")" = "disk-new" ] ||
  fail "sync status: a .py hook must be discovered as disk-new, got $ROW"
[ "$(jq -r .path <<<"$ROW")" = ".claude/hooks/poll-guard.py" ] ||
  fail "sync status: a .py hook's path must keep its extension, got $ROW"
ok "a non-.sh hook file is discovered by sync status with its extension intact"

run 0 "$MESA" library sync apply --resolve '.claude/hooks/poll-guard.py=disk'
[ "$(jqs '.[0].applied')" = "true" ] || fail "sync apply disk on a .py hook: must apply"
run 0 "$MESA" library show poll-guard.py
[ "$(jqs .kind)" = "hook" ] || fail "the adopted .py hook's kind"
[ "$(jqs .body)" = "# python guard" ] || fail "the adopted .py hook's body"
run 0 "$MESA" library update poll-guard.py --body '# edited guard'
run 0 "$MESA" library sync apply --resolve '.claude/hooks/poll-guard.py=mesa'
[ "$(cat "$CLAUDE_DIR/hooks/poll-guard.py")" = "# edited guard" ] ||
  fail "a .py hook must write back to its own filename, not a .sh one"
[ ! -e "$CLAUDE_DIR/hooks/poll-guard.py.sh" ] ||
  fail "a hook's name must not have an extension appended to it a second time"
ok "a .py hook round-trips: adopted from disk, edited in mesa, written back to poll-guard.py"

# ---- disk-deleted: the file vanished since the last sync, resolved both ways ----

run 0 "$MESA" library create hook wontdelete.sh '#!/bin/sh
echo hi'
run 0 "$MESA" library sync apply --resolve '.claude/hooks/wontdelete.sh=mesa'
[ -f "$CLAUDE_DIR/hooks/wontdelete.sh" ] || fail "fixture: wontdelete.sh must exist after the initial sync"
rm "$CLAUDE_DIR/hooks/wontdelete.sh"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="wontdelete.sh" and .kind=="hook")')
[ "$(jq -r .status <<<"$ROW")" = "disk-deleted" ] || fail "sync status: expected disk-deleted, got $ROW"
run 0 "$MESA" library sync apply --resolve '.claude/hooks/wontdelete.sh=mesa'
[ -f "$CLAUDE_DIR/hooks/wontdelete.sh" ] || fail "sync apply mesa on disk-deleted: must recreate the file"
run 0 "$MESA" library show wontdelete.sh
[ "$(cat "$CLAUDE_DIR/hooks/wontdelete.sh")" = "$(jqs .body)" ] ||
  fail "sync apply mesa on disk-deleted: recreated file must hold the mesa body"
ok "sync apply (mesa) on a disk-deleted row recreates the file with the mesa body"

run 0 "$MESA" library create hook willvanish.sh 'content'
run 0 "$MESA" library sync apply --resolve '.claude/hooks/willvanish.sh=mesa'
[ -f "$CLAUDE_DIR/hooks/willvanish.sh" ] || fail "fixture: willvanish.sh must exist after the initial sync"
rm "$CLAUDE_DIR/hooks/willvanish.sh"
run 0 "$MESA" library sync apply --resolve '.claude/hooks/willvanish.sh=disk'
[ "$(jqs '.[0].applied')" = "true" ] || fail "sync apply disk on disk-deleted: must apply"
run 1 "$MESA" library show willvanish.sh
[ "$(jqe .error.code)" = "not_found" ] || fail "sync apply disk on disk-deleted: the mesa row must be gone"
[ ! -e "$CLAUDE_DIR/hooks/willvanish.sh" ] || fail "sync apply disk on disk-deleted: no file must be created"
ok "sync apply (disk) on a disk-deleted row deletes the mesa row (the disk side won, and the disk side is absence)"

# ---- both-changed: both sides moved; skip touches neither ----

run 0 "$MESA" library create prompt conflictitem 'orig' --export-command
run 0 "$MESA" library sync apply --resolve '.claude/commands/conflictitem.md=mesa'
run 0 "$MESA" library update conflictitem --body 'mesa new'
printf 'disk new' > "$CLAUDE_DIR/commands/conflictitem.md"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="conflictitem" and .kind=="prompt")')
[ "$(jq -r .status <<<"$ROW")" = "both-changed" ] || fail "sync status: expected both-changed, got $ROW"
[ "$(jq -r .mesa_body <<<"$ROW")" = "mesa new" ] || fail "sync status both-changed: mesa_body"
[ "$(jq -r .disk_body <<<"$ROW")" = "disk new" ] || fail "sync status both-changed: disk_body"
[ "$(jq -r .baseline <<<"$ROW")" = "orig" ] || fail "sync status both-changed: baseline"
ok "when both sides moved since the last sync, the row is offered as both-changed with both bodies"

# The two change dates and the line-level diff a conflicting row carries
# (mesa task 1097). One line differs on each side, so the diff is exactly one
# mesa-only line and one disk-only one — never a "changed" kind, and never a
# three-way attribution: `baseline` rides on the row separately.
[ "$(jq -r '.diff | type' <<<"$ROW")" = "array" ] ||
  fail "sync status both-changed: diff must be an array, got $ROW"
[ "$(jq -r '.diff | length' <<<"$ROW")" -gt 0 ] ||
  fail "sync status both-changed: diff must not be empty, got $ROW"
[ "$(jq -r '[.diff[] | select(.kind=="mesa-only") | .text] | join(",")' <<<"$ROW")" = "mesa new" ] ||
  fail "sync status both-changed: the mesa-only line must be mesa's body, got $ROW"
[ "$(jq -r '[.diff[] | select(.kind=="disk-only") | .text] | join(",")' <<<"$ROW")" = "disk new" ] ||
  fail "sync status both-changed: the disk-only line must be the file's body, got $ROW"
[ "$(jq -r '.diff[] | select(.kind=="mesa-only") | .mesa_line' <<<"$ROW")" = "1" ] ||
  fail "sync status both-changed: a mesa-only line carries a 1-based mesa_line, got $ROW"
[ "$(jq -r '.diff[] | select(.kind=="mesa-only") | .disk_line' <<<"$ROW")" = "null" ] ||
  fail "sync status both-changed: a mesa-only line has no disk_line, got $ROW"
[ "$(jq -r '.diff[] | select(.kind=="disk-only") | .disk_line' <<<"$ROW")" = "1" ] ||
  fail "sync status both-changed: a disk-only line carries a 1-based disk_line, got $ROW"
[ "$(jq -r '.diff[] | select(.kind=="disk-only") | .mesa_line' <<<"$ROW")" = "null" ] ||
  fail "sync status both-changed: a disk-only line has no mesa_line, got $ROW"
echo "$ROW" | jq -e '.disk_mtime | test("^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$")' >/dev/null ||
  fail "sync status both-changed: disk_mtime must be mesa timestamp text, got $ROW"
echo "$ROW" | jq -e '.mesa_updated_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$")' >/dev/null ||
  fail "sync status both-changed: mesa_updated_at must be mesa timestamp text, got $ROW"
ok "a both-changed row carries a line-level mesa-vs-disk diff and both sides' change dates"

run 0 "$MESA" library sync apply --resolve '.claude/commands/conflictitem.md=skip'
RESULT=$(jqs '.[0]')
[ "$(jq -r .applied <<<"$RESULT")" = "false" ] || fail "sync apply skip: must not apply"
[ "$(jq -r .error <<<"$RESULT")" = "null" ] || fail "sync apply skip: must carry no error"
run 0 "$MESA" library show conflictitem
[ "$(jqs .body)" = "mesa new" ] || fail "skip must leave the mesa body untouched"
[ "$(cat "$CLAUDE_DIR/commands/conflictitem.md")" = "disk new" ] || fail "skip must leave the disk file untouched"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="conflictitem" and .kind=="prompt")')
[ "$(jq -r .status <<<"$ROW")" = "both-changed" ] ||
  fail "after skip the row must still be both-changed (the baseline never moved), got $ROW"
ok "skip leaves BOTH the mesa body and the disk file untouched, and the row is still both-changed on the next scan"

echo "== library-check: section 6 (sync) passed ($CHECKS checks so far) =="

# ================= 7. API: CRUD + malformed bodies + fork 404/409 =================

PORT=17797
"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null ||
  fail "server did not start (log: $(cat "$TMP/serve.log"))"

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

api 201 POST /api/library '{"kind":"prompt","scope":"user","name":"api-note","body":"hi"}'
[ "$(jqb .name)" = "api-note" ] || fail "API create: name"
[ "$(jqb .kind)" = "prompt" ] || fail "API create: kind"
AN=$(jqb .id)
ok "POST /api/library: 201 + the full LibraryItem JSON"

api 422 POST /api/library '{"kind":"prompt","scope":"user","name":"../evil","body":"x"}'
[ "$(jqb .error.code)" = "validation" ] || fail "API create bad name: error.code"
ok "POST /api/library with a traversal name (../evil): 422 validation"

for BADNAME in 'a/b' '..' '.' ''; do
  api 422 POST /api/library "$(jq -cn --arg n "$BADNAME" '{kind:"prompt",scope:"user",name:$n,body:"x"}')"
  [ "$(jqb .error.code)" = "validation" ] || fail "API create bad name $BADNAME: error.code"
done
ok "POST /api/library with 'a/b', '..', '.', or an empty name: each 422 validation"

api 409 POST /api/library '{"kind":"prompt","scope":"user","name":"api-note","body":"x"}'
[ "$(jqb .error.code)" = "conflict" ] || fail "API create duplicate name: error.code"
ok "POST /api/library with a duplicate (kind,scope,name): 409 conflict"

api 422 POST /api/library '{"kind":"not-a-kind","scope":"user","name":"x","body":"x"}'
[ "$(jqb .error.code)" = "validation" ] || fail "API create unknown kind: error.code"
ok "POST /api/library with an unknown kind: 422 validation"

api 422 POST /api/library '{not json'
ok "POST /api/library with unparseable JSON: 422 (JsonRejection, never a 500)"

api 200 GET /api/library
[ "$(jqb type)" = "array" ] || fail "API list: bare array"
[ "$(jqb 'map(select(.name=="api-note")) | length')" = "1" ] || fail "API list: new item present"
ok "GET /api/library: bare array"

api 200 GET "/api/library/$AN"
[ "$(jqb .id)" = "$AN" ] || fail "API show: id"
ok "GET /api/library/{id}: full record"

api 404 GET /api/library/999999
[ "$(jqb .error.code)" = "not_found" ] || fail "API show unknown id: error.code"
ok "GET /api/library/{id} unknown id: 404 not_found"

api 200 PATCH "/api/library/$AN" '{"body":"updated"}'
[ "$(jqb .body)" = "updated" ] || fail "API patch: body"
[ "$(jqb .name)" = "api-note" ] || fail "API patch: untouched fields preserved"
ok "PATCH /api/library/{id}: 200 + the updated record"

api 422 PATCH "/api/library/$AN" '{"name":null}'
[ "$(jqb .error.code)" = "validation" ] || fail "API patch explicit null name: error.code"
api 422 PATCH "/api/library/$AN" '{"body":null}'
[ "$(jqb .error.code)" = "validation" ] || fail "API patch explicit null body: error.code"
ok "PATCH /api/library/{id} with an explicit null name/body: 422 validation, not an erasure"

api 404 PATCH /api/library/999999 '{"body":"x"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "API patch unknown id: error.code"
ok "PATCH /api/library/{id} unknown id: 404 not_found"

api 200 GET "/api/library/$AN/versions"
[ "$(jqb type)" = "array" ] || fail "API versions: bare array"
[ "$(jqb length)" -ge "2" ] || fail "API versions: expected >=2 entries, got $BODY"
ok "GET /api/library/{id}/versions: bare array"

api 200 DELETE "/api/library/$AN"
[ "$(jqb .id)" = "$AN" ] || fail "API delete: echoes the destroyed record"
[ "$(jqb .body)" != "null" ] || fail "API delete: the echo is the FULL record"
ok "DELETE /api/library/{id}: 200, echoes the full destroyed record"

api 404 GET "/api/library/$AN"
ok "DELETE /api/library/{id}: a subsequent GET is 404 not_found"

api 404 DELETE /api/library/999999
[ "$(jqb .error.code)" = "not_found" ] || fail "API delete unknown id: error.code"
ok "DELETE /api/library/{id} unknown id: 404 not_found"

# ---- fork route: 404 unknown builtin, 409 double-fork ----

api 404 POST /api/library/builtins/no-such-builtin/fork '{"body":"x"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "API fork unknown builtin: error.code"
ok "POST /api/library/builtins/{unknown}/fork: 404 not_found"

api 201 POST /api/library/builtins/starter-claude-md/fork '{"body":"custom claude.md"}'
[ "$(jqb .builtin_id)" = "starter-claude-md" ] || fail "API fork: builtin_id"
[ "$(jqb .body)" = "custom claude.md" ] || fail "API fork: body"
ok "POST /api/library/builtins/{id}/fork: 201, creates the fork carrying builtin_id"

api 409 POST /api/library/builtins/starter-claude-md/fork '{"body":"second attempt"}'
[ "$(jqb .error.code)" = "conflict" ] || fail "API fork twice: error.code"
ok "POST /api/library/builtins/{id}/fork a second time: 409 conflict (a built-in forks at most once)"

# the Content-Type gate covers every mutating /api/library route
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -d '{"kind":"prompt","scope":"user","name":"x","body":"x"}' "http://127.0.0.1:$PORT/api/library")
[ "$NO_CT" = "415" ] || fail "POST /api/library without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -d '{"body":"x"}' "http://127.0.0.1:$PORT/api/library/999999")
[ "$NO_CT" = "415" ] || fail "PATCH /api/library/{id} without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "http://127.0.0.1:$PORT/api/library/999999")
[ "$NO_CT" = "415" ] || fail "DELETE /api/library/{id} without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/api/library/builtins/starter-claude-md/fork")
[ "$NO_CT" = "415" ] || fail "POST fork without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/library/sync")
[ "$NO_CT" = "415" ] || fail "POST /api/library/sync without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -d '{"bundle":{"version":1,"exported_at":"x","items":[]}}' "http://127.0.0.1:$PORT/api/library/import")
[ "$NO_CT" = "415" ] || fail "POST /api/library/import without Content-Type: expected 415, got $NO_CT"
ok "every mutating /api/library route (incl. fork, sync apply and import) without a JSON Content-Type is 415"

# ---- export / import (mesa task 963) ----

api 200 GET /api/library/export
[ "$(jqb .version)" = "1" ] || fail "API export: version"
[ "$(jqb type)" = "object" ] || fail "API export: object"
[ "$(jqb '.items | type')" = "array" ] || fail "API export: items array"
ok "GET /api/library/export: 200 + LibraryBundle {version, exported_at, items[]}"

api 422 POST /api/library/import '{not json'
ok "POST /api/library/import with unparseable JSON: 422 (JsonRejection, never a 500)"

api 422 POST /api/library/import \
  '{"bundle":{"version":1,"exported_at":"x","items":[]},"on_conflict":"bogus"}'
[ "$(jqb .error.code)" = "validation" ] || fail "API import unknown on_conflict: error.code"
ok "POST /api/library/import with an unknown on_conflict value: 422 validation"

api 200 POST /api/library/import '{"bundle":{"version":1,"exported_at":"x","items":[]}}'
[ "$(jqb type)" = "array" ] || fail "API import: bare array"
[ "$(jqb length)" = "0" ] || fail "API import of an empty bundle: expected an empty results array"
ok "POST /api/library/import: 200 + LibraryImportResult[] (on_conflict omitted -> defaults to skip)"

# ================= 8. gates: default mode =================
# All ELEVEN library routes share ONE gate — `require_agent_access`, the
# agents'/terminal's/scripts'-run gate (mesa task 1004, replacing the old
# loopback-only `LIBRARY_LOOPBACK`) — reads (list/show/versions/export) as
# much as the five mutations, the two sync routes and import: a row's body IS
# an agent definition, a hook shell script or a CLAUDE.md, so there is no
# coherent line between reading one and writing one. In DEFAULT mode that
# gate is a loopback peer + a local Host + a local Origin, strictly stronger
# than the loopback-only check it replaced. Every curl below originates on
# this machine, so the server always sees a LOOPBACK peer — what these
# assertions pin is the Host/Origin half of the gate (the peer-address half,
# and the fact that `--lan` now lets a real LAN page IN, are pinned by the
# Rust unit tests in api.rs).

raw() { # raw <method> <path> [extra curl args...]
  local method=$1 path=$2; shift 2
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "$@" \
    "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
}

raw GET /api/library -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "200" ] || fail "default: GET /api/library from a local Host must be 200, got $STATUS"
raw GET /api/library -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/library with a foreign Host must be 403, got $STATUS"
ok "default mode: GET /api/library rejects a foreign Host"

raw GET "/api/library/$AN" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/library/{id} with a foreign Host must be 403"
raw GET "/api/library/$AN/versions" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/library/{id}/versions with a foreign Host must be 403"
raw GET /api/library/export -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/library/export with a foreign Host must be 403"
ok "default mode: show, versions and export carry the same gate as list"

# The Origin half of `require_agent_access` (mesa task 1004): in default mode
# the route itself now runs `require_local_origin`, which the loopback-only
# gate it replaced never did. A cross-site page's Origin is refused; a request
# with no Origin at all — curl, or the embedded UI's own same-origin GET — is
# fine, which is what every other assertion in this file relies on.
raw GET /api/library -H "Host: 127.0.0.1:$PORT" -H 'Origin: https://evil.example'
[ "$STATUS" = "403" ] || fail "default: GET /api/library with a foreign Origin must be 403, got $STATUS"
raw GET /api/library -H "Host: 127.0.0.1:$PORT" -H "Origin: http://127.0.0.1:$PORT"
[ "$STATUS" = "200" ] || fail "default: GET /api/library with a local Origin must be 200, got $STATUS"
raw POST /api/library -H "Host: 127.0.0.1:$PORT" -H 'Origin: https://evil.example' \
  -H 'Content-Type: application/json' -d '{"kind":"prompt","scope":"user","name":"origin-probe","body":"x"}'
[ "$STATUS" = "403" ] || fail "default: authoring POST with a foreign Origin must be 403, got $STATUS"
ok "default mode: a foreign Origin is refused on a read and on a write; a local/absent one is not"

api 201 POST /api/library '{"kind":"prompt","scope":"user","name":"gate-fixture","body":"x"}'
GATE_ID=$(jqb .id)

raw POST /api/library -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"kind":"prompt","scope":"user","name":"gate-probe","body":"x"}'
[ "$STATUS" = "403" ] || fail "default: authoring POST with a foreign Host must be 403, got $STATUS"
raw PATCH "/api/library/$GATE_ID" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"body":"gate probe"}'
[ "$STATUS" = "403" ] || fail "default: authoring PATCH with a foreign Host must be 403"
raw DELETE "/api/library/$GATE_ID" -H "Host: evil.example" -H 'Content-Type: application/json'
[ "$STATUS" = "403" ] || fail "default: authoring DELETE with a foreign Host must be 403"
raw POST /api/library/builtins/starter-claude-md/fork -H "Host: evil.example" \
  -H 'Content-Type: application/json' -d '{"body":"x"}'
[ "$STATUS" = "403" ] || fail "default: fork with a foreign Host must be 403"
raw GET /api/library/sync -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/library/sync with a foreign Host must be 403"
raw POST /api/library/sync -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"resolutions":[]}'
[ "$STATUS" = "403" ] || fail "default: POST /api/library/sync with a foreign Host must be 403"
raw POST /api/library/import -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"bundle":{"version":1,"exported_at":"x","items":[]}}'
[ "$STATUS" = "403" ] || fail "default: import with a foreign Host must be 403"
raw GET "/api/library/$GATE_ID/hook" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET .../hook with a foreign Host must be 403"
raw POST "/api/library/$GATE_ID/hook" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"event":"Stop"}'
[ "$STATUS" = "403" ] || fail "default: POST .../hook with a foreign Host must be 403"
raw DELETE "/api/library/$GATE_ID/hook" -H "Host: evil.example" -H 'Content-Type: application/json'
[ "$STATUS" = "403" ] || fail "default: DELETE .../hook with a foreign Host must be 403"
raw GET "/api/library/hooks/orphans?scope=user" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/library/hooks/orphans with a foreign Host must be 403"
raw POST /api/library/hooks/adopt -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"scope":"user","path":"/nope"}'
[ "$STATUS" = "403" ] || fail "default: POST /api/library/hooks/adopt with a foreign Host must be 403"
api 200 GET "/api/library/$GATE_ID"
[ "$(jqb .body)" = "x" ] || fail "default: a refused authoring request must write nothing"
ok "default mode: every mutating route AND both sync routes reject a foreign Host, writing nothing"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ================= gates: --lan mode =================
# `--lan` skips the GLOBAL Host allowlist, and under it `require_agent_access`
# RELAXES rather than refuses (mesa task 1004): the peer no longer has to be
# loopback, so a phone on the network can use the Library page at all — the
# same posture /api/live/transcribe takes, and the one --lan already takes for
# the terminal and for running a script. What it does NOT relax is either
# confused-deputy defense (`require_lan_page_access`): a DNS-name Host is a
# rebound page and a foreign Origin is a cross-site fetch, and both are still
# refused, on all ELEVEN routes alike. Every curl here originates on this
# machine, so the real TCP peer is ALWAYS loopback — the "a genuine LAN peer
# now gets in" half can only be forged in the Rust unit tests (see api.rs).
# What curl CAN prove, and what this section proves for all eleven routes
# exactly as scripts-check.sh proves it for scripts' authoring routes, is: a
# DNS-name Host is refused, a foreign Origin is refused, and a genuinely local
# request (IP-literal or localhost Host on our port, no foreign Origin) still
# succeeds — the flag never locks the machine's own owner out.

LAN_PORT=17799
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf -H "Host: 127.0.0.1:$LAN_PORT" "http://127.0.0.1:$LAN_PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf -H "Host: 127.0.0.1:$LAN_PORT" "http://127.0.0.1:$LAN_PORT/api/projects" >/dev/null ||
  fail "--lan server did not start (log: $(cat "$TMP/lan.log"))"

lan_req() { # lan_req <method> <path> <host> [origin] [json-body]
  local method=$1 path=$2 host=$3 origin=${4:-} body=${5:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -H "Host: $host")
  [ -n "$origin" ] && args+=(-H "Origin: $origin")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "http://127.0.0.1:$LAN_PORT$path"
}

# The contrast: an ordinary route takes any Host under --lan; a library route
# does not — not even a read.
[ "$(lan_req GET /api/projects 'evil.example')" = "200" ] ||
  fail "--lan: an ordinary route must accept any Host (global check skipped)"
[ "$(lan_req GET /api/library 'evil.example')" = "403" ] ||
  fail "--lan: GET /api/library must reject a DNS-name Host (rebinding defense)"
ok "--lan: the global Host allowlist is skipped, but /api/library keeps its own rebinding defense"

# A genuinely local request — IP-literal or localhost Host on our port, no
# foreign Origin — still succeeds on a read: the flag never locks the
# machine's own owner out of their own catalogue.
[ "$(lan_req GET /api/library "127.0.0.1:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/library must accept a local Host"
[ "$(lan_req GET /api/library "192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/library must accept an IP-literal Host (remote browser by IP)"
[ "$(lan_req GET /api/library '192.0.2.7:999')" = "403" ] ||
  fail "--lan: GET /api/library must reject an IP Host on a foreign port"
[ "$(lan_req GET /api/library "192.0.2.7:$LAN_PORT" "http://192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/library must accept an Origin matching the Host"
[ "$(lan_req GET /api/library "192.0.2.7:$LAN_PORT" 'https://evil.example')" = "403" ] ||
  fail "--lan: GET /api/library must reject a foreign Origin"
ok "--lan: GET /api/library accepts a local/IP-literal Host with a matching Origin, rejects a foreign port or Origin"

[ "$(lan_req GET "/api/library/$GATE_ID" "192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/library/{id} must accept an IP-literal Host, same as list"
[ "$(lan_req GET "/api/library/$GATE_ID/versions" "192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/library/{id}/versions must accept an IP-literal Host, same as list"
[ "$(lan_req GET /api/library/export "192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/library/export must accept an IP-literal Host, same as list"
ok "--lan: show, versions and export accept a valid local request too"

LVS=$(lan_req POST /api/library "127.0.0.1:$LAN_PORT" '' '{"kind":"prompt","scope":"user","name":"lan-loopback-check","body":"x"}')
[ "$LVS" = "201" ] ||
  fail "--lan: authoring from this machine's own local Host must still work (the flag never locks the owner out)"
LIS=$(lan_req POST /api/library/import "127.0.0.1:$LAN_PORT" '' '{"bundle":{"version":1,"exported_at":"x","items":[]}}')
[ "$LIS" = "200" ] ||
  fail "--lan: importing from this machine's own local Host must still work (the flag never locks the owner out)"
ok "--lan: authoring (incl. import) from a loopback peer with a local Host still works (the flag never locks the owner out)"

# All SIXTEEN routes: a DNS-name Host (rebinding) and a foreign Origin
# (cross-site) are each refused — reads exactly as strictly as mutations, the
# two sync routes and the two bundle routes, since every one of them shares
# `require_agent_access`.
for CASE in \
  "GET|/api/library|" \
  "GET|/api/library/$GATE_ID|" \
  "GET|/api/library/$GATE_ID/versions|" \
  "POST|/api/library|{\"kind\":\"prompt\",\"scope\":\"user\",\"name\":\"lan-probe\",\"body\":\"x\"}" \
  "PATCH|/api/library/$GATE_ID|{\"body\":\"lan probe\"}" \
  "DELETE|/api/library/$GATE_ID|{}" \
  "POST|/api/library/builtins/starter-claude-md/fork|{\"body\":\"x\"}" \
  "GET|/api/library/sync|" \
  "POST|/api/library/sync|{\"resolutions\":[]}" \
  "GET|/api/library/export|" \
  "POST|/api/library/import|{\"bundle\":{\"version\":1,\"exported_at\":\"x\",\"items\":[]}}" \
  "GET|/api/library/$GATE_ID/hook|" \
  "POST|/api/library/$GATE_ID/hook|{\"event\":\"Stop\"}" \
  "DELETE|/api/library/$GATE_ID/hook|{}" \
  "GET|/api/library/hooks/orphans?scope=user|" \
  "POST|/api/library/hooks/adopt|{\"scope\":\"user\",\"path\":\"/nope\"}" \
; do
  IFS='|' read -r METHOD PATH_ BODY_ <<<"$CASE"
  S=$(lan_req "$METHOD" "$PATH_" "evil.example:$LAN_PORT" '' "$BODY_")
  [ "$S" = "403" ] ||
    fail "--lan: $METHOD $PATH_ from a DNS-name Host must be 403, got $S"
  S=$(lan_req "$METHOD" "$PATH_" "127.0.0.1:$LAN_PORT" 'https://evil.example' "$BODY_")
  [ "$S" = "403" ] ||
    fail "--lan: $METHOD $PATH_ from a foreign Origin must be 403, got $S"
done
ok "--lan: all sixteen library routes (reads included) reject a DNS-name Host (rebinding) and a foreign Origin (cross-site)"

api2() { # api2 <expected-status> <method> <path> [json-body] — against LAN_PORT, local Host
  local expected=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -H "Host: 127.0.0.1:$LAN_PORT")
  case "$method" in
    POST | PUT | PATCH | DELETE) args+=(-H 'Content-Type: application/json' -d "${body:-{\}}") ;;
  esac
  STATUS=$(curl "${args[@]}" "http://127.0.0.1:$LAN_PORT$path")
  BODY=$(cat "$TMP/body")
  [ "$STATUS" = "$expected" ] || fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
api2 200 GET "/api/library/$GATE_ID"
[ "$(jqb .body)" = "x" ] || fail "--lan: a refused authoring request must have written nothing, got $BODY"
ok "--lan: the library row survives every refused request"

# The Content-Type gate does not relax under --lan.
LAN_NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: 127.0.0.1:$LAN_PORT" \
  -d 'kind=prompt&name=x&body=x' "http://127.0.0.1:$LAN_PORT/api/library")
[ "$LAN_NO_CT" = "415" ] ||
  fail "--lan: a form-encoded POST /api/library must still be 415, got $LAN_NO_CT"
LAN_NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: 127.0.0.1:$LAN_PORT" \
  "http://127.0.0.1:$LAN_PORT/api/library/sync")
[ "$LAN_NO_CT" = "415" ] ||
  fail "--lan: POST /api/library/sync with no Content-Type must still be 415, got $LAN_NO_CT"
LAN_NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: 127.0.0.1:$LAN_PORT" \
  -d '{"bundle":{"version":1,"exported_at":"x","items":[]}}' "http://127.0.0.1:$LAN_PORT/api/library/import")
[ "$LAN_NO_CT" = "415" ] ||
  fail "--lan: POST /api/library/import with no Content-Type must still be 415, got $LAN_NO_CT"
ok "--lan: the Content-Type gate still fires on /api/library (the two halves never drift apart)"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

echo "== library-check: sections 7-8 (API + gates) passed ($CHECKS checks so far) =="

# ========== 9. the named agent definitions come from the library ===========
# mesa task 1068: the live conversation runs as the `mesa-live` agent
# definition — an `agent` row with a real path, seeded to disk before the
# spawn and synced like any other — rather than as a `prompt` glued into the
# prompt argument.

run 0 "$MESA" library show mesa-live
[ "$(jqs .id)" = "null" ] || fail "fixture: mesa-live must start unshadowed for this section"
[ "$(jqs .kind)" = "agent" ] || fail "mesa-live must be an agent definition, got $(jqs .kind)"
[ "$(jqs .scope)" = "user" ] || fail "mesa-live must be user-scoped, got $(jqs .scope)"
[ "$(jqs .path)" = ".claude/agents/mesa-live.md" ] ||
  fail "mesa-live must map to .claude/agents/mesa-live.md, got $(jqs .path)"
BUILTIN_DEF=$(jqs .body)
grep -q "mesa live listen" <<<"$BUILTIN_DEF" ||
  fail "fixture: the built-in definition must state the loop"
grep -q "^name: mesa-live$" <<<"$BUILTIN_DEF" ||
  fail "fixture: the built-in definition must carry YAML frontmatter naming the agent"
ok "mesa-live starts unshadowed as a user-scope agent definition at .claude/agents/mesa-live.md"

# Having a path means the sync flow carries it, unlike the prompt it replaced.
rm -f "$CLAUDE_DIR/agents/mesa-live.md"
run 0 "$MESA" library sync status
[ "$(jqs 'map(select(.path==".claude/agents/mesa-live.md")) | length')" = "1" ] ||
  fail "sync status must report a row for the mesa-live definition, got $STDOUT"
MESA_LIVE_STATUS=$(jqs '.[] | select(.path==".claude/agents/mesa-live.md") | .status')
[ "$MESA_LIVE_STATUS" = "mesa-new" ] ||
  fail "with no file on disk, mesa-live must be mesa-new, got $MESA_LIVE_STATUS"
run 0 "$MESA" library sync apply --resolve '.claude/agents/mesa-live.md=mesa' 
grep -q "mesa live listen" "$CLAUDE_DIR/agents/mesa-live.md" ||
  fail "sync apply (mesa wins) must write the definition to \$HOME/.claude/agents/mesa-live.md"
ok "the mesa-live definition appears in sync status and sync apply writes it to \$HOME/.claude/agents"

# The prompt mesa injects is the session line alone: the loop travels as the
# definition now, never as the prompt argument.
rm -f "$STUB_DIR/last-prompt"
run 0 "$MESA" live start
S1=$(jqs .id)
[ -f "$STUB_DIR/last-prompt" ] || fail "live start must spawn the stub claude"
if grep -q "mesa live listen" "$STUB_DIR/last-prompt"; then
  fail "the loop must NOT be injected into the prompt any more: $(cat "$STUB_DIR/last-prompt")"
fi
grep -q "Drive mesa live session $S1 (lease 1)\." "$STUB_DIR/last-prompt" ||
  fail "live start must inject the session line: $(cat "$STUB_DIR/last-prompt")"
run 0 "$MESA" live stop
ok "the spawned prompt carries the session line only — the instructions are the agent definition"

# Editing the built-in forks it, exactly as for any other library row.
run 0 "$MESA" library update mesa-live --body '---
name: mesa-live
---

You are a custom live agent. Be terse.'
[ "$(jqs .builtin_id)" = "mesa-live" ] || fail "forking mesa-live: builtin_id"
[ "$(jqs .id)" != "null" ] || fail "forking mesa-live: the fork must be a real row"
[ "$(jqs .kind)" = "agent" ] || fail "forking mesa-live: the fork keeps its kind"
run 0 "$MESA" library show mesa-live
grep -q "Be terse." <<<"$(jqs .body)" ||
  fail "the forked body must REPLACE the built-in: $STDOUT"
if grep -q "mesa live listen" <<<"$(jqs .body)"; then
  fail "a fork replaces the built-in rather than extending it: $STDOUT"
fi
ok "editing mesa-live forks it, and the forked body replaces the built-in definition"

# ---- the supervisor definition is the same shape one step up (task 1075) ----
# The auto-dispatched `/execute-todo` run is supervised by a named agent for
# the same reason the conversation is: the rules travel as a definition on
# disk, not as text glued into the prompt argument.

run 0 "$MESA" library show supervisor
[ "$(jqs .id)" = "null" ] || fail "fixture: supervisor must start unshadowed for this section"
[ "$(jqs .kind)" = "agent" ] || fail "supervisor must be an agent definition, got $(jqs .kind)"
[ "$(jqs .scope)" = "user" ] || fail "supervisor must be user-scoped, got $(jqs .scope)"
[ "$(jqs .path)" = ".claude/agents/supervisor.md" ] ||
  fail "supervisor must map to .claude/agents/supervisor.md, got $(jqs .path)"
SUPERVISOR_DEF=$(jqs .body)
grep -q "^name: supervisor$" <<<"$SUPERVISOR_DEF" ||
  fail "fixture: the built-in definition must carry YAML frontmatter naming the agent"
grep -q "^model: opus$" <<<"$SUPERVISOR_DEF" ||
  fail "fixture: the built-in definition must run on opus"
grep -q "^tools:.*ExitWorktree" <<<"$SUPERVISOR_DEF" ||
  fail "fixture: the built-in definition must state its tool list"
if grep -qE "^tools:.*(Edit|Write)" <<<"$SUPERVISOR_DEF"; then
  fail "a supervisor must not be able to edit: $SUPERVISOR_DEF"
fi
ok "supervisor starts unshadowed as a user-scope agent definition at .claude/agents/supervisor.md"

# Having a path means the sync flow carries it, exactly as for mesa-live.
rm -f "$CLAUDE_DIR/agents/supervisor.md"
run 0 "$MESA" library sync status
[ "$(jqs 'map(select(.path==".claude/agents/supervisor.md")) | length')" = "1" ] ||
  fail "sync status must report a row for the supervisor definition, got $STDOUT"
SUPERVISOR_STATUS=$(jqs '.[] | select(.path==".claude/agents/supervisor.md") | .status')
[ "$SUPERVISOR_STATUS" = "mesa-new" ] ||
  fail "with no file on disk, supervisor must be mesa-new, got $SUPERVISOR_STATUS"
run 0 "$MESA" library sync apply --resolve '.claude/agents/supervisor.md=mesa'
grep -q "^name: supervisor$" "$CLAUDE_DIR/agents/supervisor.md" ||
  fail "sync apply (mesa wins) must write the definition to \$HOME/.claude/agents/supervisor.md"
ok "the supervisor definition appears in sync status and sync apply writes it to \$HOME/.claude/agents"

# Editing the built-in forks it, exactly as for any other library row.
run 0 "$MESA" library update supervisor --body '---
name: supervisor
---

You are a custom supervisor. Be terse.'
[ "$(jqs .builtin_id)" = "supervisor" ] || fail "forking supervisor: builtin_id"
[ "$(jqs .id)" != "null" ] || fail "forking supervisor: the fork must be a real row"
[ "$(jqs .kind)" = "agent" ] || fail "forking supervisor: the fork keeps its kind"
run 0 "$MESA" library show supervisor
grep -q "Be terse." <<<"$(jqs .body)" ||
  fail "the forked body must REPLACE the built-in: $STDOUT"
if grep -q "^model: opus$" <<<"$(jqs .body)"; then
  fail "a fork replaces the built-in rather than extending it: $STDOUT"
fi
ok "editing supervisor forks it, and the forked body replaces the built-in definition"

echo "== library-check: section 9 (named agent definitions) passed ($CHECKS checks so far) =="

# ================= 10. import / export (mesa task 963) =================
# `starter-claude-md` is already forked (section 7, over the API) with body
# "custom claude.md" — reused here as the "a forked built-in" fixture rather
# than forking a second one.

run 0 "$MESA" library create prompt export-user-note 'exported body'
ok "fixture: a fresh user-scope row for the export/import round trip"

# ---- CLI export: shape of one bundle ----

run 0 "$MESA" library export
[ "$(jqs .version)" = "1" ] || fail "CLI export: version"
[ "$(jqs .exported_at)" != "null" ] || fail "CLI export: exported_at"
[ "$(jqs '.items | type')" = "array" ] || fail "CLI export: items array"

NOTE_ITEM=$(jqs '.items[] | select(.name=="export-user-note")')
[ -n "$NOTE_ITEM" ] || fail "CLI export: export-user-note must be present"
[ "$(jq -r '.kind' <<<"$NOTE_ITEM")" = "prompt" ] || fail "CLI export item: kind"
[ "$(jq -r '.scope' <<<"$NOTE_ITEM")" = "user" ] || fail "CLI export item: scope"
[ "$(jq -r '.project' <<<"$NOTE_ITEM")" = "null" ] || fail "CLI export item: project null for a user-scope row"
[ "$(jq -r '.body' <<<"$NOTE_ITEM")" = "exported body" ] || fail "CLI export item: body"
[ "$(jq -r '.builtin_id' <<<"$NOTE_ITEM")" = "null" ] || fail "CLI export item: builtin_id null for a plain row"
for KEY in id synced_body synced_at created_at updated_at path; do
  [ "$(jq --arg k "$KEY" 'has($k)' <<<"$NOTE_ITEM")" = "false" ] ||
    fail "CLI export item: must carry no '$KEY' key, got $NOTE_ITEM"
done
ok "CLI library export: bundle {version, exported_at, items[]}, an item carries no id/synced_*/created_at/updated_at/path"

FORK_ITEM=$(jqs '.items[] | select(.name=="starter-claude-md")')
[ -n "$FORK_ITEM" ] || fail "CLI export: the forked built-in starter-claude-md must be present"
[ "$(jq -r '.builtin_id' <<<"$FORK_ITEM")" = "starter-claude-md" ] ||
  fail "CLI export: a forked built-in must carry its builtin_id"
[ "$(jq -r '.body' <<<"$FORK_ITEM")" = "custom claude.md" ] || fail "CLI export: forked body"
ok "CLI library export: a forked built-in travels, carrying its builtin_id"

[ "$(jqs '[.items[] | select(.name=="live-summary-prompt")] | length')" = "0" ] ||
  fail "CLI export: an UNshadowed built-in (live-summary-prompt) must never be exported"
ok "CLI library export: no unshadowed built-in appears in the bundle"

# ---- --output: writes a file, refuses to clobber an existing one ----

run 0 "$MESA" library export --output "$TMP/bundle-out.json"
[ "$(jqs .path)" = "$TMP/bundle-out.json" ] || fail "CLI export --output: prints {path, items}"
[ "$(jqs '.items | type')" = "number" ] || fail "CLI export --output: items must be a number"
[ -f "$TMP/bundle-out.json" ] || fail "CLI export --output: file must be written"
[ "$(jq -r .version < "$TMP/bundle-out.json")" = "1" ] || fail "CLI export --output: file holds a real bundle"
BEFORE=$(cat "$TMP/bundle-out.json")

run 1 "$MESA" library export --output "$TMP/bundle-out.json"
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI export --output existing path: error.code"
[ "$(cat "$TMP/bundle-out.json")" = "$BEFORE" ] || fail "CLI export --output existing path: file must be untouched"
ok "CLI library export --output: writes {path, items}, and refuses to clobber an existing path leaving it untouched"

# ---- --quiet is not defined on export/import: exit 2 usage ----

run 2 "$MESA" library export --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on export: code=usage"
run 2 "$MESA" library import /no/such/file --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on import: code=usage"
ok "--quiet on library export/import: rejected as an unknown argument, exit 2 usage"

# ---- CLI import round trip, into a second, empty db ----

run 0 "$MESA" library export --output "$TMP/roundtrip.json"
MESA_DB_2="$TMP/mesa2.db"

run 0 env MESA_DB="$MESA_DB_2" "$MESA" library import "$TMP/roundtrip.json"
RESULTS=$STDOUT
NOTE_RESULT=$(jq '.[] | select(.name=="export-user-note")' <<<"$RESULTS")
[ "$(jq -r .status <<<"$NOTE_RESULT")" = "created" ] || fail "import round trip: export-user-note must be created"
[ "$(jq -r .item_id <<<"$NOTE_RESULT")" != "null" ] || fail "import round trip: created item must carry an item_id"

FORK_RESULT=$(jq '.[] | select(.name=="starter-claude-md")' <<<"$RESULTS")
[ "$(jq -r .status <<<"$FORK_RESULT")" = "created" ] || fail "import round trip: starter-claude-md must be created"

# `library export` with no project scopes to user-scope rows only (the same
# rule `list` follows), so the project-scoped `reviewer` row from section 1
# never appears in the bundle above. Export it explicitly, scoped to its
# project, into a fresh third db that has no such project at all.
run 0 "$MESA" library export "Library project" --output "$TMP/project-scoped.json"
[ "$(jq -r '.items[] | select(.name=="reviewer") | .project' "$TMP/project-scoped.json")" \
  = "Library project" ] || fail "CLI export PROJECT: reviewer must travel with its project's NAME"
MESA_DB_3="$TMP/mesa3.db"
run 0 env MESA_DB="$MESA_DB_3" "$MESA" library import "$TMP/project-scoped.json"
RESULTS=$STDOUT
REVIEWER_RESULT=$(jq '.[] | select(.name=="reviewer")' <<<"$RESULTS")
[ "$(jq -r .status <<<"$REVIEWER_RESULT")" = "failed" ] ||
  fail "import round trip: reviewer (project-scoped to a project absent on the far side) must fail alone"
[ "$(jq -r .item_id <<<"$REVIEWER_RESULT")" = "null" ] || fail "import round trip: a failed item carries no item_id"
[ "$(jq -r .error <<<"$REVIEWER_RESULT")" != "null" ] || fail "import round trip: a failed item carries an error"
NOTE_RESULT=$(jq '.[] | select(.name=="export-user-note")' <<<"$RESULTS")
[ "$(jq -r .status <<<"$NOTE_RESULT")" = "created" ] ||
  fail "import round trip: the rest of the batch must still apply alongside the one failure"
ok "import: a project-scoped item whose project doesn't exist on the far side fails alone; the rest of the batch still applies"

run 0 env MESA_DB="$MESA_DB_2" "$MESA" library show export-user-note
[ "$(jqs .body)" = "exported body" ] || fail "import round trip: body must be byte-identical"
run 0 env MESA_DB="$MESA_DB_2" "$MESA" library show starter-claude-md
[ "$(jqs .body)" = "custom claude.md" ] || fail "import round trip: forked body must be byte-identical"
[ "$(jqs .builtin_id)" = "starter-claude-md" ] || fail "import round trip: the fork must still carry its builtin_id"
run 0 env MESA_DB="$MESA_DB_2" "$MESA" library list
[ "$(jqs 'map(select(.builtin_id=="starter-claude-md" and .id==null)) | length')" = "0" ] ||
  fail "import round trip: the built-in it shadows must no longer be offered unshadowed"
ok "import into a second, empty db reproduces the rows: bodies byte-identical, the fork carrying its builtin_id, the shadowed built-in no longer unshadowed"

# ---- re-import: default (skip) leaves bodies untouched; replace overwrites ----

run 0 env MESA_DB="$MESA_DB_2" "$MESA" library import "$TMP/roundtrip.json"
NOTE_RESULT=$(jqs '.[] | select(.name=="export-user-note")')
[ "$(jq -r .status <<<"$NOTE_RESULT")" = "skipped" ] || fail "re-import (default): export-user-note must be skipped"
run 0 env MESA_DB="$MESA_DB_2" "$MESA" library show export-user-note
[ "$(jqs .body)" = "exported body" ] || fail "re-import (default): body must be untouched"
ok "re-import with the default policy: skipped, bodies untouched"

run 0 "$MESA" library update export-user-note --body 'exported body v2'
run 0 "$MESA" library export --output "$TMP/roundtrip2.json"

run 0 env MESA_DB="$MESA_DB_2" "$MESA" library import "$TMP/roundtrip2.json"
NOTE_RESULT=$(jqs '.[] | select(.name=="export-user-note")')
[ "$(jq -r .status <<<"$NOTE_RESULT")" = "skipped" ] ||
  fail "re-import (default) after editing the source: must still skip"
run 0 env MESA_DB="$MESA_DB_2" "$MESA" library show export-user-note
[ "$(jqs .body)" = "exported body" ] || fail "re-import (default) after editing the source: body must be untouched"

run 0 env MESA_DB="$MESA_DB_2" "$MESA" library import "$TMP/roundtrip2.json" --on-conflict replace
NOTE_RESULT=$(jqs '.[] | select(.name=="export-user-note")')
[ "$(jq -r .status <<<"$NOTE_RESULT")" = "replaced" ] || fail "re-import --on-conflict replace: must replace"
run 0 env MESA_DB="$MESA_DB_2" "$MESA" library show export-user-note
[ "$(jqs .body)" = "exported body v2" ] || fail "re-import --on-conflict replace: new body must be present"
ok "re-import with --on-conflict replace after editing the source: replaced, the new body present"

# ---- unknown bundle version: validation, exit 1, nothing written ----

jq '.version = 999' "$TMP/roundtrip.json" > "$TMP/badversion.json"
MESA_DB_4="$TMP/mesa4.db"
run 1 env MESA_DB="$MESA_DB_4" "$MESA" library import "$TMP/badversion.json"
[ "$(jqe .error.code)" = "validation" ] || fail "import unknown version: error.code"
run 0 env MESA_DB="$MESA_DB_4" "$MESA" library list
[ "$(jqs '[.[] | select(.id != null)] | length')" = "0" ] ||
  fail "import unknown version: nothing must be written, got $STDOUT"
ok "import of a bundle with an unknown version: exit 1 validation, nothing written"

echo 'not a bundle' > "$TMP/malformed.json"
run 1 "$MESA" library import "$TMP/malformed.json"
[ "$(jqe .error.code)" = "validation" ] || fail "import unparseable bundle: error.code"
ok "import of an unparseable bundle: exit 1 validation"

# ---- import preview + per-item resolutions (mesa task 1292) ----
# A bundle's only conflict shape is two bodies and a choice (there is no sync
# baseline in a bundle), so import previews each item against the row it would
# ACTUALLY resolve to — import's own matching rule, shared code — and the apply
# takes one choice per item, keyed by identity. Everything here runs against a
# throwaway db and its own `serve`, so the main db above is untouched.

MESA_DB_5="$TMP/mesa5.db"
run 0 env MESA_DB="$MESA_DB_5" "$MESA" library create --kind prompt --scope user \
  --name keep-note --body 'local keep'
run 0 env MESA_DB="$MESA_DB_5" "$MESA" library create --kind prompt --scope user \
  --name take-note --body 'local take'
run 0 env MESA_DB="$MESA_DB_5" "$MESA" library create --kind prompt --scope user \
  --name same-note --body 'shared'

cat > "$TMP/preview-bundle.json" <<'JSON'
{"version":1,"exported_at":"2026-01-01 00:00:00","items":[
 {"name":"keep-note","kind":"prompt","scope":"user","project":null,"body":"imported keep","builtin_id":null,"export_command":false},
 {"name":"take-note","kind":"prompt","scope":"user","project":null,"body":"imported take","builtin_id":null,"export_command":false},
 {"name":"same-note","kind":"prompt","scope":"user","project":null,"body":"shared","builtin_id":null,"export_command":false},
 {"name":"fresh-note","kind":"prompt","scope":"user","project":null,"body":"brand new","builtin_id":null,"export_command":false},
 {"name":"scoped-note","kind":"prompt","scope":"project","project":"no-such-project","body":"x","builtin_id":null,"export_command":false}
]}
JSON

PORT5=17798
MESA_DB="$MESA_DB_5" "$MESA" serve --port "$PORT5" >"$TMP/serve10.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT5/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT5/api/projects" >/dev/null ||
  fail "section 10 server did not start (log: $(cat "$TMP/serve10.log"))"

api5() { # api5 <expected-status> <method> <path> [json-body]
  STATUS=$(curl -s -o "$TMP/body5" -w '%{http_code}' -X "$2" \
    -H 'Content-Type: application/json' -d "${4:-{\}}" \
    "http://127.0.0.1:$PORT5$3")
  BODY=$(cat "$TMP/body5")
  [ "$STATUS" = "$1" ] || fail "expected HTTP $1, got $STATUS: $2 $3 ($BODY)"
}
jqb5() { jq -r "$1" <<<"$BODY"; }

jq -c '{bundle: .}' "$TMP/preview-bundle.json" > "$TMP/preview-body.json"
api5 200 POST /api/library/import/preview "$(cat "$TMP/preview-body.json")"
[ "$(jqb5 type)" = "array" ] || fail "import preview: bare array"
[ "$(jqb5 length)" = "5" ] || fail "import preview: one row per bundle item"

PREVIEW=$BODY
prow() { jq -c --arg n "$1" '.[] | select(.name==$n)' <<<"$PREVIEW"; }

ROW=$(prow fresh-note)
[ "$(jq -r .status <<<"$ROW")" = "new" ] || fail "preview: fresh-note must be new, got $ROW"
[ "$(jq -r .item_id <<<"$ROW")" = "null" ] || fail "preview: a new row resolves to no item"
[ "$(jq -r .local_body <<<"$ROW")" = "null" ] || fail "preview: a new row has no local body"
[ "$(jq -r .local_updated_at <<<"$ROW")" = "null" ] || fail "preview: a new row has no local date"
[ "$(jq -r .diff <<<"$ROW")" = "null" ] || fail "preview: a new row carries no diff"
[ "$(jq -r .bundle_body <<<"$ROW")" = "brand new" ] || fail "preview: bundle_body"

ROW=$(prow same-note)
[ "$(jq -r .status <<<"$ROW")" = "identical" ] || fail "preview: same-note must be identical, got $ROW"
[ "$(jq -r .diff <<<"$ROW")" = "null" ] || fail "preview: identical bodies carry no diff"
[ "$(jq -r .local_body <<<"$ROW")" = "shared" ] || fail "preview: identical row carries the local body"
[ "$(jq -r .local_updated_at <<<"$ROW")" != "null" ] || fail "preview: an existing row reports its last-changed date"

ROW=$(prow keep-note)
[ "$(jq -r .status <<<"$ROW")" = "conflict" ] || fail "preview: keep-note must be a conflict, got $ROW"
[ "$(jq -r .local_body <<<"$ROW")" = "local keep" ] || fail "preview: conflict local_body"
[ "$(jq -r .bundle_body <<<"$ROW")" = "imported keep" ] || fail "preview: conflict bundle_body"
[ "$(jq -r .item_id <<<"$ROW")" != "null" ] || fail "preview: a conflict names the row it resolved to"
[ "$(jq -r .local_updated_at <<<"$ROW")" != "null" ] || fail "preview: a conflict reports the local date"
[ "$(jq -r '.diff | length' <<<"$ROW")" -gt 0 ] || fail "preview: a conflict carries a diff, got $ROW"
# The diff's "mesa" side is the local row and its "disk" side the bundle.
[ "$(jq -r '[.diff[] | select(.kind=="mesa-only") | .text] | join("")' <<<"$ROW")" = "local keep" ] ||
  fail "preview diff: the mesa-only line must be the LOCAL body"
[ "$(jq -r '[.diff[] | select(.kind=="disk-only") | .text] | join("")' <<<"$ROW")" = "imported keep" ] ||
  fail "preview diff: the disk-only line must be the IMPORTED body"

ROW=$(prow scoped-note)
# Its own status, never `new`: the JSON is the interface, and a caller
# counting `new` rows to learn what an import would create must not be handed
# an item that is going to fail.
[ "$(jq -r .status <<<"$ROW")" = "unresolvable" ] ||
  fail "preview: an item naming an unknown project must be unresolvable, not new, got $ROW"
[ "$(jq -r .error <<<"$ROW")" != "null" ] ||
  fail "preview: an unresolvable item must carry its error, got $ROW"
[ "$(jq -r .diff <<<"$ROW")" = "null" ] || fail "preview: an unresolvable row carries no diff"
[ "$(jq -r '[.[] | select(.status=="new")] | length' <<<"$PREVIEW")" = "1" ] ||
  fail "preview: exactly one row is `new` — the unresolvable one must not be counted with it"
ok "POST /api/library/import/preview: new/identical/conflict/unresolvable per item, a diff ONLY on a conflict (local as its mesa side), local_updated_at on every resolved row, and an unresolvable item carrying its error rather than reading as new"

run 0 env MESA_DB="$MESA_DB_5" "$MESA" library list
[ "$(jqs 'map(select(.id != null)) | length')" = "3" ] ||
  fail "import preview must write nothing, got $STDOUT"
ok "the import preview writes nothing"

# ---- one `replace` and one `skip` in the SAME call ----

RESOLVED=$(jq -c '{bundle: ., resolutions: [
  {name:"keep-note",kind:"prompt",scope:"user",project:null,choice:"skip"},
  {name:"take-note",kind:"prompt",scope:"user",project:null,choice:"replace"},
  {name:"ghost-note",kind:"prompt",scope:"user",project:null,choice:"replace"}
]}' "$TMP/preview-bundle.json")
api5 200 POST /api/library/import "$RESOLVED"
RESULTS=$BODY
rres() { jq -c --arg n "$1" '.[] | select(.name==$n)' <<<"$RESULTS"; }
[ "$(jq -r .status <<<"$(rres keep-note)")" = "skipped" ] || fail "resolutions: keep-note must be skipped"
[ "$(jq -r .status <<<"$(rres take-note)")" = "replaced" ] || fail "resolutions: take-note must be replaced"
[ "$(jq -r .status <<<"$(rres same-note)")" = "skipped" ] ||
  fail "resolutions: an item nobody resolved falls back to on_conflict (skip)"
[ "$(jq -r .status <<<"$(rres fresh-note)")" = "created" ] || fail "resolutions: fresh-note must be created"

run 0 env MESA_DB="$MESA_DB_5" "$MESA" library show keep-note
[ "$(jqs .body)" = "local keep" ] || fail "resolutions: the skipped row keeps its LOCAL body"
run 0 env MESA_DB="$MESA_DB_5" "$MESA" library show take-note
[ "$(jqs .body)" = "imported take" ] || fail "resolutions: the replaced row takes the IMPORTED body"
ok "POST /api/library/import with per-item resolutions: one conflict replaced and another skipped in the same call, each side winning its own row's body"

GHOST=$(rres ghost-note)
[ "$(jq -r .status <<<"$GHOST")" = "failed" ] ||
  fail "a resolution naming nothing in the bundle must fail alone, got $GHOST"
[ "$(jq -r .error <<<"$GHOST")" != "null" ] || fail "the stray resolution's failure carries an error"
[ "$(jq -r '.[] | select(.name=="scoped-note") | .status' <<<"$RESULTS")" = "failed" ] ||
  fail "the unresolvable item still fails alone"
[ "$(jq -r 'length' <<<"$RESULTS")" = "6" ] ||
  fail "one result per bundle item plus one for the stray resolution, got $RESULTS"
ok "a resolution naming an item not in the bundle fails alone while the rest of the batch still applies"

# ---- BACKWARD COMPAT: no `resolutions` is byte-identical to on_conflict ----

MESA_DB_6="$TMP/mesa6.db"
run 0 env MESA_DB="$MESA_DB_6" "$MESA" library create --kind prompt --scope user \
  --name keep-note --body 'local keep'
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true
MESA_DB="$MESA_DB_6" "$MESA" serve --port "$PORT5" >"$TMP/serve10b.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT5/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done

api5 200 POST /api/library/import "$(cat "$TMP/preview-body.json")"
[ "$(jq -r '.[] | select(.name=="keep-note") | .status' <<<"$BODY")" = "skipped" ] ||
  fail "no resolutions, no on_conflict: must still default to skip"
run 0 env MESA_DB="$MESA_DB_6" "$MESA" library show keep-note
[ "$(jqs .body)" = "local keep" ] || fail "no resolutions: the body must be untouched"

api5 200 POST /api/library/import \
  "$(jq -c '{bundle: ., on_conflict: "replace"}' "$TMP/preview-bundle.json")"
[ "$(jq -r '.[] | select(.name=="keep-note") | .status' <<<"$BODY")" = "replaced" ] ||
  fail "no resolutions, on_conflict=replace: must still replace"
run 0 env MESA_DB="$MESA_DB_6" "$MESA" library show keep-note
[ "$(jqs .body)" = "imported keep" ] || fail "no resolutions, on_conflict=replace: the imported body must win"
ok "an import posted with NO resolutions is byte-identical to the old batch-wide on_conflict behaviour"

kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=

# ---- CLI --preview reports and writes nothing ----

MESA_DB_7="$TMP/mesa7.db"
run 0 env MESA_DB="$MESA_DB_7" "$MESA" library create --kind prompt --scope user \
  --name keep-note --body 'local keep'
run 0 env MESA_DB="$MESA_DB_7" "$MESA" library import "$TMP/preview-bundle.json" --preview
[ "$(jqs 'length')" = "5" ] || fail "CLI --preview: one row per bundle item"
[ "$(jqs '.[] | select(.name=="keep-note") | .status')" = "conflict" ] ||
  fail "CLI --preview: keep-note must be a conflict"
[ "$(jqs '.[] | select(.name=="fresh-note") | .status')" = "new" ] ||
  fail "CLI --preview: fresh-note must be new"
run 0 env MESA_DB="$MESA_DB_7" "$MESA" library list
[ "$(jqs 'map(select(.id != null)) | length')" = "1" ] ||
  fail "CLI --preview must write nothing, got $STDOUT"
run 0 env MESA_DB="$MESA_DB_7" "$MESA" library show keep-note
[ "$(jqs .body)" = "local keep" ] || fail "CLI --preview must leave the body untouched"
run 2 env MESA_DB="$MESA_DB_7" "$MESA" library import "$TMP/preview-bundle.json" --preview --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on library import --preview: code=usage"
ok "CLI library import --preview: reports the rows, writes nothing, and still refuses --quiet"

echo "== library-check: section 10 (import/export) passed ($CHECKS checks so far) =="

# ================= 11. hook registration (mesa task 1115) =================
# A hook file does nothing until `.claude/settings.json` names it under an
# event. mesa does not own that file, so the acceptance property is that an
# enable followed by a disable gives it back byte for byte — asserted against
# a settings file that already holds somebody else's settings AND somebody
# else's hook registration.

HOOK_SETTINGS="$HOME/.claude/settings.json"
HOOK_SCRIPT="$HOME/.claude/hooks/gate-hook.sh"
mkdir -p "$HOME/.claude"
cat > "$HOOK_SETTINGS" <<'JSON'
{
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{"type": "command", "command": "somebody-elses-guard.py"}] }
    ]
  },
  "env": {"FOO": "bar"}
}
JSON
cp "$HOOK_SETTINGS" "$TMP/settings.before"

run 0 "$MESA" library create hook gate-hook.sh 'echo hooked'
HOOK_ID=$(jqs .id)

run 0 "$MESA" library hook status gate-hook.sh
[ "$(jqs .item_id)" = "$HOOK_ID" ] || fail "hook status: item_id"
[ "$(jqs .name)" = "gate-hook.sh" ] || fail "hook status: name"
[ "$(jqs .registered)" = "false" ] || fail "hook status: a fresh hook is not registered"
[ "$(jqs '.registrations | length')" = "0" ] || fail "hook status: no registrations yet"
[ "$(jqs .settings_path)" = "$HOME_REAL/.claude/settings.json" ] ||
  fail "hook status: settings_path follows the item's scope, got $(jqs .settings_path)"
[ "$(jqs .command)" = "$HOME_REAL/.claude/hooks/gate-hook.sh" ] ||
  fail "hook status: a user-scope hook is registered by absolute path, got $(jqs .command)"
[ "$(jqs '.events | length')" = "9" ] || fail "hook status: the event vocabulary rides along"
ok "CLI library hook status: an unregistered hook reports its settings file, its command and the event vocabulary"

# `--quiet` is rejected on all three: a status is not a record and has no
# unbounded field to drop.
for SUB in status enable disable; do
  run 2 "$MESA" library hook "$SUB" gate-hook.sh --quiet --event Stop
  [ -z "$STDOUT" ] || fail "library hook $SUB --quiet: stdout must be empty, got $STDOUT"
  [ "$(jqe .error.code)" = "usage" ] || fail "library hook $SUB --quiet: expected usage, got $STDERR"
done
ok "CLI library hook status/enable/disable reject --quiet: exit 2, empty stdout, usage on stderr"

# The hook's own script is not on disk — a built-in is code and a row is a db
# row, and nothing writes either until a sync. A registration naming a file
# that does not exist fires and errors every session, so enabling seeds it.
[ ! -e "$HOOK_SCRIPT" ] || fail "fixture: the hook script must not be on disk before the enable"

run 0 "$MESA" library hook enable gate-hook.sh --event Stop
[ "$(jqs .registered)" = "true" ] || fail "hook enable: registered"
[ "$(jqs '.registrations | length')" = "1" ] || fail "hook enable: exactly one registration"
[ "$(jqs '.registrations[0].event')" = "Stop" ] || fail "hook enable: event"
[ "$(jqs '.registrations[0].matcher')" = "*" ] || fail "hook enable: the matcher defaults to *"
[ "$(jqs '.registrations[0].command')" = "$HOME_REAL/.claude/hooks/gate-hook.sh" ] ||
  fail "hook enable: the registered command is what status said it would be"
[ -f "$HOOK_SCRIPT" ] || fail "hook enable: the hook's own script must be seeded to disk"
[ "$(cat "$HOOK_SCRIPT")" = "echo hooked" ] || fail "hook enable: the seeded script is the item's body"
[ -x "$HOOK_SCRIPT" ] || fail "hook enable: a hook is a script Claude Code runs; it must be executable"
ok "CLI library hook enable: registers under one event AND seeds the hook's own executable script to disk"

# Somebody else's settings and somebody else's hook are still there, and the
# registration is genuinely readable by an ordinary JSON parser.
[ "$(jq -r .model "$HOOK_SETTINGS")" = "opus" ] || fail "hook enable: an unrelated top-level key must survive"
[ "$(jq -r '.env.FOO' "$HOOK_SETTINGS")" = "bar" ] || fail "hook enable: an unrelated block must survive"
[ "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$HOOK_SETTINGS")" = "somebody-elses-guard.py" ] ||
  fail "hook enable: somebody else's hook must survive"
[ "$(jq -r '.hooks.Stop[0].hooks[0].command' "$HOOK_SETTINGS")" = "$HOME_REAL/.claude/hooks/gate-hook.sh" ] ||
  fail "hook enable: the registration must be readable as ordinary JSON"
ok "hook enable: every unrelated setting and somebody else's own hook survive the splice"

run 0 "$MESA" library hook status gate-hook.sh
[ "$(jqs .registered)" = "true" ] || fail "hook status after enable: registered"
[ "$(jqs '.registrations[0].event')" = "Stop" ] || fail "hook status after enable: event"
ok "CLI library hook status: a fresh read of the file reports the registration the enable wrote"

# Never overwritten: after the first seed the file belongs to the sync flow.
printf 'edited by hand\n' > "$HOOK_SCRIPT"
run 0 "$MESA" library hook enable gate-hook.sh --event SessionEnd
[ "$(cat "$HOOK_SCRIPT")" = "edited by hand" ] ||
  fail "hook enable: a script already on disk must never be overwritten"
run 0 "$MESA" library hook disable gate-hook.sh --event SessionEnd
ok "CLI library hook enable: a hook script already on disk is never overwritten"

run 0 "$MESA" library hook disable gate-hook.sh
[ "$(jqs .registered)" = "false" ] || fail "hook disable: registered"
[ "$(jqs '.registrations | length')" = "0" ] || fail "hook disable: no registrations left"
cmp -s "$HOOK_SETTINGS" "$TMP/settings.before" ||
  fail "hook disable: the settings file must come back BYTE-IDENTICAL:\n$(diff "$TMP/settings.before" "$HOOK_SETTINGS" || true)"
ok "CLI library hook disable: removes the registration and gives the settings file back byte-identical"

run 0 "$MESA" library hook disable gate-hook.sh
[ "$(jqs .registered)" = "false" ] || fail "hook disable (again): registered"
cmp -s "$HOOK_SETTINGS" "$TMP/settings.before" || fail "hook disable (again): must not touch the file"
ok "CLI library hook disable on a hook that was never registered: no-op success, file untouched"

# `"hooks": null` is valid JSON, and mesa's own parser reads it as an empty
# map — so both verbs must too, rather than refusing a file mesa says is fine.
printf '{"hooks": null, "model": "opus"}\n' > "$HOOK_SETTINGS"
cp "$HOOK_SETTINGS" "$TMP/settings.null"
run 0 "$MESA" library hook disable gate-hook.sh
[ "$(jqs .registered)" = "false" ] || fail "hook disable on a null hooks: registered"
cmp -s "$HOOK_SETTINGS" "$TMP/settings.null" || fail "hook disable on a null hooks: must touch nothing"
run 0 "$MESA" library hook enable gate-hook.sh --event Stop
[ "$(jqs .registered)" = "true" ] || fail "hook enable on a null hooks: registered"
[ "$(jq -r .model "$HOOK_SETTINGS")" = "opus" ] || fail "hook enable on a null hooks: the sibling key must survive"
[ "$(jq -r '.hooks.Stop[0].hooks[0].command' "$HOOK_SETTINGS")" = "$HOME_REAL/.claude/hooks/gate-hook.sh" ] ||
  fail "hook enable on a null hooks: the registration must be there"
ok "a \"hooks\": null settings file is read as an empty one by both verbs, not refused"

run 0 "$MESA" library hook disable gate-hook.sh
run 1 "$MESA" library hook enable gate-hook.sh --event Nope
[ "$(jqe .error.code)" = "validation" ] || fail "hook enable with a bad event: error.code"
case "$STDERR" in *SubagentStop*) ;; *) fail "hook enable with a bad event: must name the vocabulary" ;; esac
run 0 "$MESA" library create prompt hook-nonhook-probe 'not a hook'
run 1 "$MESA" library hook status hook-nonhook-probe
[ "$(jqe .error.code)" = "validation" ] || fail "hook status on a non-hook item: error.code"
run 1 "$MESA" library hook status no-such-hook.sh
[ "$(jqe .error.code)" = "not_found" ] || fail "hook status on an unknown item: error.code"
ok "CLI library hook: a mistyped event, a non-hook item and an unknown item are each an error, exit 1"

echo "== library-check: section 11 (hook registration) passed ($CHECKS checks so far) =="

# ================= 12. command folded into prompt (mesa task 1139) =================

# ---- the migration: a pre-1139 `command` row opens as an exporting prompt ----
#
# Built for real: the schema exactly as it stood before the fold, loaded from
# the checked-in snapshot scripts/fixtures/pre-1139.sql (a db at
# `user_version = 54`, dumped from a binary built at the fold commit's parent
# — never a current db wound back by hand), with a `command` row and two
# versions inserted into it, then opened by mesa — which runs the fold — and
# read back through the CLI.
command -v sqlite3 >/dev/null || fail "sqlite3 is required for section 12"
sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(a)" 2>/dev/null ||
  fail "section 12 needs a sqlite3 built with FTS5 (the first sqlite3 on PATH lacks it)"
MESA_DB_OLD="$TMP/pre1139.db"
sqlite3 "$MESA_DB_OLD" < scripts/fixtures/pre-1139.sql
sqlite3 "$MESA_DB_OLD" <<'SQL'
INSERT INTO library_items (kind, scope, name, body, synced_body, synced_at, created_at, updated_at)
  VALUES ('command', 'user', 'execute-todo', 'Claim task $ARGS', 'Claim task $ARGS', datetime('now'), datetime('now'), datetime('now'));
INSERT INTO library_versions (item_id, body, source, created_at) VALUES (1, 'v1', 'edit', datetime('now'));
INSERT INTO library_versions (item_id, body, source, created_at) VALUES (1, 'Claim task $ARGS', 'edit', datetime('now'));
SQL
[ "$(sqlite3 "$MESA_DB_OLD" "SELECT kind FROM library_items WHERE id = 1")" = "command" ] ||
  fail "fixture: the pre-1139 db must hold a command row"
run 0 env MESA_DB="$MESA_DB_OLD" "$MESA" library show execute-todo
[ "$(jqs .id)" = "1" ] || fail "migration: the row keeps its id, got $STDOUT"
[ "$(jqs .kind)" = "prompt" ] || fail "migration: kind must become prompt, got $STDOUT"
[ "$(jqs .export_command)" = "true" ] || fail "migration: export_command must be on, got $STDOUT"
[ "$(jqs .path)" = ".claude/commands/execute-todo.md" ] || fail "migration: the path is unchanged, got $STDOUT"
[ "$(jqs .body)" = 'Claim task $ARGS' ] || fail "migration: the body is untouched, got $STDOUT"
[ "$(jqs .synced_body)" = 'Claim task $ARGS' ] || fail "migration: the sync baseline is untouched, got $STDOUT"
run 0 env MESA_DB="$MESA_DB_OLD" "$MESA" library versions execute-todo
[ "$(jqs length)" = "2" ] || fail "migration: history must survive (keyed by item id), got $STDOUT"
run 0 env MESA_DB="$MESA_DB_OLD" "$MESA" library list --kind prompt
[ "$(jqs '[.[] | select(.name=="execute-todo")] | length')" = "1" ] ||
  fail "migration: the migrated row must list as a prompt (the view {prompt:<name>} resolves against), got $STDOUT"
[ "$(sqlite3 "$MESA_DB_OLD" "SELECT count(*) FROM library_items WHERE kind = 'command'")" = "0" ] ||
  fail "migration: no command row may survive"
ok "migration 54: a pre-1139 command row opens as a prompt with export_command on — same id, path, body, baseline and history — and no command row survives"

# ---- export is byte-identical, and in-sync the moment it is written ----
#
# The stored body is canonical: no frontmatter synthesised, no {placeholder}
# rewritten to $ARGUMENTS. Anything else would make every export a permanent
# both-changed row, since the sync compares three plain strings.
printf -- '---\ndescription: refine\n---\nRefine mesa task $ARGUMENTS {id}\n' > "$TMP/refine-body.md"
run 0 "$MESA" library create prompt refine-cmd --body-file "$TMP/refine-body.md" --export-command
[ "$(jqs .path)" = ".claude/commands/refine-cmd.md" ] || fail "exporting prompt: path"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="refine-cmd")')
[ "$(jq -r .status <<<"$ROW")" = "mesa-new" ] || fail "exporting prompt before the sync: expected mesa-new, got $ROW"
run 0 "$MESA" library sync apply --resolve '.claude/commands/refine-cmd.md=mesa'
[ "$(jqs '.[0].applied')" = "true" ] || fail "exporting prompt: sync apply mesa must apply"
cmp -s "$TMP/refine-body.md" "$CLAUDE_DIR/commands/refine-cmd.md" ||
  fail "exporting prompt: the file must be BYTE-IDENTICAL to the body (no frontmatter, no placeholder rewrite)"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="refine-cmd")')
[ "$(jq -r .status <<<"$ROW")" = "in-sync" ] ||
  fail "exporting prompt right after the export: expected in-sync (no spurious diff), got $ROW"
ok "an exporting prompt is written byte-identical to its body and reads in-sync on the very next scan"

# ---- --quiet keeps the flag: bounded, and what says the row is a slash command ----
run 0 "$MESA" library show refine-cmd --quiet
[ "$(jqs .export_command)" = "true" ] || fail "--quiet must keep export_command, got $STDOUT"
[ "$(jqs 'has("body")')" = "false" ] || fail "--quiet still drops body"
ok "--quiet keeps export_command"

# ---- a prompt that does not export is not in the scan at all ----
run 0 "$MESA" library create prompt internal-only 'mesa internal'
[ "$(jqs .export_command)" = "false" ] || fail "a prompt exports only when asked"
[ "$(jqs .path)" = "null" ] || fail "a non-exporting prompt has no path"
run 0 "$MESA" library sync status
[ "$(jqs '[.[] | select(.name=="internal-only")] | length')" = "0" ] ||
  fail "a non-exporting prompt must not appear in sync status"
ok "a prompt with the flag off has no path and is invisible to sync"

# ---- turning the flag off removes the file mesa wrote ----
run 0 "$MESA" library update refine-cmd --no-export-command
[ "$(jqs .export_command)" = "false" ] || fail "--no-export-command: flag off"
[ "$(jqs .path)" = "null" ] || fail "--no-export-command: no path any more"
[ "$(jqs .synced_body)" = "null" ] || fail "--no-export-command: the sync baseline is cleared"
[ ! -e "$CLAUDE_DIR/commands/refine-cmd.md" ] ||
  fail "--no-export-command: the file mesa wrote must be removed"
run 0 "$MESA" library sync status
[ "$(jqs '[.[] | select(.name=="refine-cmd")] | length')" = "0" ] ||
  fail "after the flag goes off the row is out of the scan"
run 0 "$MESA" library show refine-cmd
[ "$(jqs .body)" = "$(cat "$TMP/refine-body.md")" ] || fail "--no-export-command: the body is untouched"
ok "library update --no-export-command removes the file mesa wrote, clears the baseline and keeps the body"

# ---- ...but leaves a hand-edited one for sync to report as disk-new ----
run 0 "$MESA" library update refine-cmd --export-command
[ "$(jqs .path)" = ".claude/commands/refine-cmd.md" ] || fail "--export-command: the path is back"
run 0 "$MESA" library sync apply --resolve '.claude/commands/refine-cmd.md=mesa'
printf 'someone edited this by hand' > "$CLAUDE_DIR/commands/refine-cmd.md"
run 0 "$MESA" library update refine-cmd --no-export-command
[ "$(cat "$CLAUDE_DIR/commands/refine-cmd.md")" = "someone edited this by hand" ] ||
  fail "--no-export-command: a hand-edited file must be left alone"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.path==".claude/commands/refine-cmd.md")')
[ "$(jq -r .status <<<"$ROW")" = "disk-new" ] ||
  fail "a hand-edited file left behind must read disk-new, got $ROW"
[ "$(jq -r .item_id <<<"$ROW")" = "null" ] || fail "the orphaned file belongs to no row"
rm "$CLAUDE_DIR/commands/refine-cmd.md"
ok "library update --no-export-command leaves a hand-edited file in place, and sync status reports it disk-new"

# ---- the API carries the flag on create and update ----
"$MESA" serve --port 17799 >"$TMP/serve12.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:17799/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
API12="http://127.0.0.1:17799"
CODE=$(curl -s -o "$TMP/out" -w '%{http_code}' -X POST "$API12/api/library" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"prompt","scope":"user","name":"api-cmd","body":"api body","export_command":true}')
[ "$CODE" = "201" ] || fail "API create with export_command: expected 201, got $CODE $(cat "$TMP/out")"
[ "$(jq -r .export_command "$TMP/out")" = "true" ] || fail "API create: export_command on"
[ "$(jq -r .path "$TMP/out")" = ".claude/commands/api-cmd.md" ] || fail "API create: path"
API_CMD_ID=$(jq -r .id "$TMP/out")
CODE=$(curl -s -o "$TMP/out" -w '%{http_code}' -X POST "$API12/api/library" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"hook","scope":"user","name":"api-flagged.sh","body":"x","export_command":true}')
[ "$CODE" = "422" ] || fail "API create hook with export_command: expected 422, got $CODE"
CODE=$(curl -s -o "$TMP/out" -w '%{http_code}' -X POST "$API12/api/library" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"command","scope":"user","name":"api-old","body":"x"}')
[ "$CODE" = "422" ] || fail "API create kind=command: expected 422, got $CODE"
CODE=$(curl -s -o "$TMP/out" -w '%{http_code}' -X PATCH "$API12/api/library/$API_CMD_ID" \
  -H 'Content-Type: application/json' -d '{"export_command":false}')
[ "$CODE" = "200" ] || fail "API PATCH export_command:false: expected 200, got $CODE"
[ "$(jq -r .export_command "$TMP/out")" = "false" ] || fail "API PATCH: flag off"
[ "$(jq -r .path "$TMP/out")" = "null" ] || fail "API PATCH: path gone"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
ok "API: POST/PATCH /api/library carry export_command; a non-prompt with it and the retired command kind are 422"

# ---- a pre-1139 bundle still imports: its command is a prompt that exports ----
cat > "$TMP/legacy.json" <<'JSON'
{"version":1,"exported_at":"2026-01-01T00:00:00","items":[
  {"name":"legacy-refine","kind":"command","scope":"user","project":null,"body":"refine body","builtin_id":null},
  {"name":"legacy-note","kind":"prompt","scope":"user","project":null,"body":"note body","builtin_id":null}]}
JSON
run 0 "$MESA" library import "$TMP/legacy.json"
[ "$(jqs '[.[] | select(.status=="created")] | length')" = "2" ] || fail "legacy bundle: both items must import, got $STDOUT"
run 0 "$MESA" library show legacy-refine
[ "$(jqs .kind)" = "prompt" ] || fail "legacy bundle: command imports as a prompt"
[ "$(jqs .export_command)" = "true" ] || fail "legacy bundle: ...that exports"
run 0 "$MESA" library show legacy-note
[ "$(jqs .export_command)" = "false" ] || fail "legacy bundle: an absent export_command reads as off"
run 0 "$MESA" library export
[ "$(jqs '.items[] | select(.name=="legacy-refine") | .export_command')" = "true" ] ||
  fail "export: the bundle carries export_command"
[ "$(jqs '[.items[] | select(.kind=="command")] | length')" = "0" ] || fail "export: no item says command any more"
ok "a bundle exported before 1139 (kind: command) imports as an exporting prompt, and a fresh export carries the flag"

echo "== library-check: section 12 (command folded into prompt) passed ($CHECKS checks so far) =="

# ================= 13. hooks wired from outside .claude/hooks (mesa task 1128) =================
# A settings.json command may name a script anywhere, and the library only
# sees `.claude/hooks/`. mesa lists such commands and, on an explicit
# `adopt`, moves the script in and rewrites the command(s) — the acceptance
# property being that nothing else in the file moves, and that a refused
# adoption touches nothing at all.

ORPHAN_SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude/hooks" "$HOME/scripts"
printf '#!/bin/sh\necho warm\n' > "$HOME/scripts/warm.sh"
chmod +x "$HOME/scripts/warm.sh"
printf 'in tree' > "$HOME/.claude/hooks/in-tree.sh"
cat > "$ORPHAN_SETTINGS" <<'JSON'
{
  "model": "opus",
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [
        {"type": "command", "command": "bash $HOME/scripts/warm.sh --fast"},
        {"type": "command", "command": "somebody-elses-guard.py"}
      ] }
    ],
    "Stop": [
      { "hooks": [{"type": "command", "command": "bash $HOME/scripts/warm.sh --fast"}] },
      { "matcher": "Bash", "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/in-tree.sh"}] }
    ],
    "SessionEnd": [
      { "hooks": [{"type": "command", "command": "~/gone/missing.py"}] }
    ]
  },
  "env": {"FOO": "bar"}
}
JSON
cp "$ORPHAN_SETTINGS" "$TMP/orphans.before"
WARM_SRC="$HOME_REAL/scripts/warm.sh"
WARM_DEST="$HOME_REAL/.claude/hooks/warm.sh"

run 0 "$MESA" library hook orphans
[ "$(jqs length)" = "2" ] || fail "hook orphans: exactly the two out-of-tree rows, got $STDOUT"
[ "$(jqs '[.[] | select(.name=="in-tree.sh")] | length')" = "0" ] ||
  fail "hook orphans: a command resolving inside .claude/hooks must not be listed"
WARM=$(jqs '.[] | select(.name=="warm.sh")')
[ -n "$WARM" ] || fail "hook orphans: warm.sh must be listed"
[ "$(jq -r .path <<<"$WARM")" = "$WARM_SRC" ] || fail "hook orphans: \$HOME expanded and canonical, got $(jq -r .path <<<"$WARM")"
[ "$(jq -r .exists <<<"$WARM")" = "true" ] || fail "hook orphans: warm.sh exists"
[ "$(jq -r .scope <<<"$WARM")" = "user" ] || fail "hook orphans: scope"
[ "$(jq -r .project_id <<<"$WARM")" = "null" ] || fail "hook orphans: project_id"
[ "$(jq -r .settings_path <<<"$WARM")" = "$HOME_REAL/.claude/settings.json" ] || fail "hook orphans: settings_path"
[ "$(jq -r .conflict <<<"$WARM")" = "null" ] || fail "hook orphans: no conflict yet"
[ "$(jq -r '.registrations | length' <<<"$WARM")" = "2" ] || fail "hook orphans: one row, both registrations"
[ "$(jq -r '[.registrations[].event] | sort | join(",")' <<<"$WARM")" = "SessionStart,Stop" ] ||
  fail "hook orphans: the two events"
[ "$(jq -r '.registrations[0].command' <<<"$WARM")" = 'bash $HOME/scripts/warm.sh --fast' ] ||
  fail "hook orphans: the command verbatim"
MISSING=$(jqs '.[] | select(.name=="missing.py")')
[ -n "$MISSING" ] || fail "hook orphans: a missing script is listed, not dropped"
[ "$(jq -r .path <<<"$MISSING")" = "$HOME_REAL/gone/missing.py" ] || fail "hook orphans: ~/ expanded"
[ "$(jq -r .exists <<<"$MISSING")" = "false" ] || fail "hook orphans: missing.py exists:false"
ok "CLI library hook orphans: exactly the two out-of-tree scripts, one row each, the in-tree one absent, the missing one flagged"

for SUB in orphans adopt; do
  run 2 "$MESA" library hook "$SUB" --quiet "$WARM_SRC"
  [ -z "$STDOUT" ] || fail "library hook $SUB --quiet: stdout must be empty, got $STDOUT"
  [ "$(jqe .error.code)" = "usage" ] || fail "library hook $SUB --quiet: expected usage, got $STDERR"
done
ok "CLI library hook orphans/adopt reject --quiet: exit 2, empty stdout, usage on stderr"

run 1 "$MESA" library hook adopt "$HOME_REAL/gone/missing.py"
[ "$(jqe .error.code)" = "not_found" ] || fail "hook adopt on a missing script: expected not_found, got $STDERR"
run 1 "$MESA" library hook adopt "$HOME_REAL/.claude/hooks/in-tree.sh"
[ "$(jqe .error.code)" = "not_found" ] || fail "hook adopt on an in-tree script: expected not_found, got $STDERR"
cmp -s "$ORPHAN_SETTINGS" "$TMP/orphans.before" || fail "hook adopt (refused): the settings file must be untouched"
ok "CLI library hook adopt: a missing script and an in-tree one are each not_found, exit 1, settings untouched"

printf 'taken' > "$WARM_DEST"
run 0 "$MESA" library hook orphans
[ "$(jqs '.[] | select(.name=="warm.sh") | .conflict')" = ".claude/hooks/warm.sh already exists" ] ||
  fail "hook orphans: an existing destination is reported as the conflict, got $STDOUT"
run 1 "$MESA" library hook adopt "$WARM_SRC"
[ "$(jqe .error.code)" = "conflict" ] || fail "hook adopt onto an existing destination: expected conflict, got $STDERR"
[ "$(cat "$WARM_DEST")" = "taken" ] || fail "hook adopt: an existing destination must never be overwritten"
[ -f "$WARM_SRC" ] || fail "hook adopt (conflict): the source must stay"
cmp -s "$ORPHAN_SETTINGS" "$TMP/orphans.before" || fail "hook adopt (conflict): the settings file must be untouched"
rm "$WARM_DEST"
ok "CLI library hook adopt: an existing .claude/hooks/<name> is conflict, exit 1; nothing moved, nothing rewritten"

run 0 "$MESA" library hook adopt "$WARM_SRC"
[ "$(jqs .name)" = "warm.sh" ] || fail "hook adopt: prints the new item's hook status"
[ "$(jqs .registered)" = "true" ] || fail "hook adopt: registered"
[ "$(jqs '.registrations | length')" = "2" ] || fail "hook adopt: both registrations on the new item"
[ "$(jqs '.registrations[0].command')" = "bash $WARM_DEST --fast" ] ||
  fail "hook adopt: the command keeps its prefix and arguments around the new path, got $(jqs '.registrations[0].command')"
[ ! -e "$WARM_SRC" ] || fail "hook adopt: the source must be gone"
[ -f "$WARM_DEST" ] || fail "hook adopt: the destination must exist"
[ -x "$WARM_DEST" ] || fail "hook adopt: the executable bit travels with the script"
[ "$(cat "$WARM_DEST")" = "$(printf '#!/bin/sh\necho warm')" ] || fail "hook adopt: the body is the script"
sed -e "s#[$]HOME/scripts/warm.sh#$WARM_DEST#g" "$TMP/orphans.before" > "$TMP/orphans.expected"
cmp -s "$ORPHAN_SETTINGS" "$TMP/orphans.expected" ||
  fail "hook adopt: only the path token may change; every other byte must be IDENTICAL:\n$(diff "$TMP/orphans.expected" "$ORPHAN_SETTINGS" || true)"
[ "$(jq -r '.hooks.SessionStart[0].hooks[1].command' "$ORPHAN_SETTINGS")" = "somebody-elses-guard.py" ] ||
  fail "hook adopt: somebody else's hook must survive"
ok "CLI library hook adopt: moves the script in (executable), rewrites both commands and leaves every other byte byte-identical"

run 0 "$MESA" library hook status warm.sh
[ "$(jqs '.registrations | length')" = "2" ] || fail "hook status after adopt: two registrations"
run 0 "$MESA" library show warm.sh
[ "$(jqs .kind)" = "hook" ] || fail "adopted item: kind"
[ "$(jqs .scope)" = "user" ] || fail "adopted item: scope"
[ "$(jqs .synced_body)" = "$(jqs .body)" ] || fail "adopted item: the sync baseline is set"
run 0 "$MESA" library sync status
[ "$(jqs '.[] | select(.name=="warm.sh") | .status')" = "in-sync" ] || fail "adopted item: sync status must read in-sync"
run 0 "$MESA" library hook orphans
[ "$(jqs length)" = "1" ] || fail "hook orphans after adopt: only the missing one is left, got $STDOUT"
[ "$(jqs '.[0].name')" = "missing.py" ] || fail "hook orphans after adopt: the missing one"
ok "after adoption: hook status sees both registrations, the row is in-sync, and orphans no longer lists it"

# ---- over the API: the two routes serve (the gates are in section 8) ----
"$MESA" serve --port 17799 >"$TMP/serve13.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:17799/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
API13="http://127.0.0.1:17799"
CODE=$(curl -s -o "$TMP/out" -w '%{http_code}' "$API13/api/library/hooks/orphans?scope=user")
[ "$CODE" = "200" ] || fail "GET /api/library/hooks/orphans: expected 200, got $CODE ($(cat "$TMP/out"))"
[ "$(jq -r length "$TMP/out")" = "1" ] || fail "GET orphans: the one remaining row"
[ "$(jq -r '.[0].name' "$TMP/out")" = "missing.py" ] || fail "GET orphans: missing.py"
CODE=$(curl -s -o "$TMP/out" -w '%{http_code}' "$API13/api/library/hooks/orphans?scope=project")
[ "$CODE" = "422" ] || fail "GET orphans scope=project without a project: expected 422, got $CODE"
CODE=$(curl -s -o "$TMP/out" -w '%{http_code}' -X POST "$API13/api/library/hooks/adopt" \
  -H 'Content-Type: application/json' -d "{\"scope\":\"user\",\"path\":\"$HOME_REAL/gone/missing.py\"}")
[ "$CODE" = "404" ] || fail "POST adopt on a missing script: expected 404, got $CODE ($(cat "$TMP/out"))"
[ "$(jq -r .error.code "$TMP/out")" = "not_found" ] || fail "POST adopt: error.code"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{"scope":"user","path":"/x"}' "$API13/api/library/hooks/adopt")
[ "$CODE" = "415" ] || fail "POST adopt without Content-Type: expected 415, got $CODE"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
ok "API: GET /api/library/hooks/orphans lists, POST /api/library/hooks/adopt answers 404 for a missing script and 415 without JSON"

echo "== library-check: section 13 (hooks wired from outside .claude/hooks) passed ($CHECKS checks so far) =="

echo
echo "library-check: $CHECKS checks passed"
