#!/usr/bin/env bash
# Library gate (mesa task 919): exercises agents, skills, hooks, commands,
# prompts and CLAUDE.md files stored as first-class records — create -> list
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
#   8. the security boundary in default mode AND `--lan`: the three read
#      routes (list/show/versions) on `require_agent_access`, and all six
#      mutating/sync routes loopback-only in BOTH modes, plus the
#      Content-Type gate firing on every mutation in both modes;
#   9. the live prompt now comes from the library (mesa task 919's migration
#      off `config.json`'s `live.prompt`): with nothing forked, `live start`
#      spawns the agent with the built-in block; with `live-agent-prompt`
#      forked to a different body, that body REPLACES the built-in while the
#      session line is still appended;
#  10. import/export (mesa task 963): a CLI round trip (a user row plus a
#      forked built-in export, with no unshadowed built-in and none of
#      id/synced_*/created_at/updated_at/path on an item), importing that
#      bundle into a second, empty db (bodies byte-identical, the fork still
#      carrying its builtin_id, a project-scoped item whose project doesn't
#      exist there failing alone while the rest of the batch still applies),
#      re-import (skip leaves bodies untouched, replace overwrites), an
#      unknown bundle version refusing the whole import with nothing written,
#      `--output` refusing to clobber an existing path, `--quiet` rejected on
#      both commands, and the two new routes added to the loopback-gate
#      sweeps (now eleven routes) in both serve modes.
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
run 0 "$MESA" library create command greeter --body-file "$TMP/body.txt"
[ "$(jqs .body)" = "$(cat "$TMP/body.txt")" ] || fail "CLI create --body-file: body verbatim"
[ "$(jqs .path)" = ".claude/commands/greeter.md" ] || fail "CLI create: command path"
ok "CLI library create --body-file: body read from a file"

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
[ "$(jqs 'map(select(.builtin_id=="live-agent-prompt")) | length')" = "1" ] ||
  fail "CLI list: the live-agent-prompt built-in must be present, got $STDOUT"
[ "$(jqs '.[] | select(.builtin_id=="live-agent-prompt") | .id')" = "null" ] ||
  fail "CLI list: an unshadowed built-in must report id:null"
[ "$(jqs '.[] | select(.builtin_id=="live-agent-prompt") | .builtin')" = "true" ] ||
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
# `stop-notify` is the fixture for this section, leaving `live-agent-prompt`
# untouched for section 9.

run 0 "$MESA" library list
[ "$(jqs '.[] | select(.builtin_id=="stop-notify") | .id')" = "null" ] ||
  fail "fixture: stop-notify must start unshadowed"
BUILTIN_BODY=$(jqs '.[] | select(.builtin_id=="stop-notify") | .body')
ok "fixture: stop-notify is an unshadowed built-in before this section touches it"

run 0 "$MESA" library update stop-notify --body 'echo custom hook'
[ "$(jqs .id)" != "null" ] || fail "editing a built-in must fork it into a real row"
[ "$(jqs .builtin_id)" = "stop-notify" ] || fail "the fork must carry its builtin_id"
[ "$(jqs .builtin)" = "false" ] || fail "the fork itself is not the built-in anymore"
[ "$(jqs .body)" = "echo custom hook" ] || fail "the fork must carry the new body"
STOP_FORK=$(jqs .id)
ok "editing an unshadowed built-in (library update stop-notify) forks it into a real row"

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

run 1 "$MESA" library delete stop-notify
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

run 0 "$MESA" library versions live-agent-prompt
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
ok "sync status: a freshly-created item with no file on disk is mesa-new"

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
ok "after applying mesa, the row reports in-sync"

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
ROW=$(jqs '.[] | select(.name=="adopted" and .kind=="command")')
[ "$(jq -r .status <<<"$ROW")" = "disk-new" ] || fail "sync status: expected disk-new, got $ROW"
[ "$(jq -r .item_id <<<"$ROW")" = "null" ] || fail "sync status: disk-new row must have no item_id"
ok "a file with no mesa row at all reports disk-new"

run 0 "$MESA" library sync apply --resolve '.claude/commands/adopted.md=disk'
[ "$(jqs '.[0].applied')" = "true" ] || fail "sync apply disk on disk-new: must apply"
run 0 "$MESA" library show adopted
[ "$(jqs .body)" = "adopt me" ] || fail "sync apply disk on disk-new: adopted body must match the file"
[ "$(jqs .kind)" = "command" ] || fail "sync apply disk on disk-new: adopted kind"
[ "$(jqs .project_id)" = "null" ] || fail "sync apply disk on disk-new: adopted is user-scope"
ok "sync apply (disk) on a disk-new row adopts the file into a new library row"

# ---- disk-deleted: the file vanished since the last sync, resolved both ways ----

run 0 "$MESA" library create hook wontdelete '#!/bin/sh
echo hi'
run 0 "$MESA" library sync apply --resolve '.claude/hooks/wontdelete.sh=mesa'
[ -f "$CLAUDE_DIR/hooks/wontdelete.sh" ] || fail "fixture: wontdelete.sh must exist after the initial sync"
rm "$CLAUDE_DIR/hooks/wontdelete.sh"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="wontdelete" and .kind=="hook")')
[ "$(jq -r .status <<<"$ROW")" = "disk-deleted" ] || fail "sync status: expected disk-deleted, got $ROW"
run 0 "$MESA" library sync apply --resolve '.claude/hooks/wontdelete.sh=mesa'
[ -f "$CLAUDE_DIR/hooks/wontdelete.sh" ] || fail "sync apply mesa on disk-deleted: must recreate the file"
run 0 "$MESA" library show wontdelete
[ "$(cat "$CLAUDE_DIR/hooks/wontdelete.sh")" = "$(jqs .body)" ] ||
  fail "sync apply mesa on disk-deleted: recreated file must hold the mesa body"
ok "sync apply (mesa) on a disk-deleted row recreates the file with the mesa body"

run 0 "$MESA" library create hook willvanish 'content'
run 0 "$MESA" library sync apply --resolve '.claude/hooks/willvanish.sh=mesa'
[ -f "$CLAUDE_DIR/hooks/willvanish.sh" ] || fail "fixture: willvanish.sh must exist after the initial sync"
rm "$CLAUDE_DIR/hooks/willvanish.sh"
run 0 "$MESA" library sync apply --resolve '.claude/hooks/willvanish.sh=disk'
[ "$(jqs '.[0].applied')" = "true" ] || fail "sync apply disk on disk-deleted: must apply"
run 1 "$MESA" library show willvanish
[ "$(jqe .error.code)" = "not_found" ] || fail "sync apply disk on disk-deleted: the mesa row must be gone"
[ ! -e "$CLAUDE_DIR/hooks/willvanish.sh" ] || fail "sync apply disk on disk-deleted: no file must be created"
ok "sync apply (disk) on a disk-deleted row deletes the mesa row (the disk side won, and the disk side is absence)"

# ---- both-changed: both sides moved; skip touches neither ----

run 0 "$MESA" library create command conflictitem 'orig'
run 0 "$MESA" library sync apply --resolve '.claude/commands/conflictitem.md=mesa'
run 0 "$MESA" library update conflictitem --body 'mesa new'
printf 'disk new' > "$CLAUDE_DIR/commands/conflictitem.md"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="conflictitem" and .kind=="command")')
[ "$(jq -r .status <<<"$ROW")" = "both-changed" ] || fail "sync status: expected both-changed, got $ROW"
[ "$(jq -r .mesa_body <<<"$ROW")" = "mesa new" ] || fail "sync status both-changed: mesa_body"
[ "$(jq -r .disk_body <<<"$ROW")" = "disk new" ] || fail "sync status both-changed: disk_body"
[ "$(jq -r .baseline <<<"$ROW")" = "orig" ] || fail "sync status both-changed: baseline"
ok "when both sides moved since the last sync, the row is offered as both-changed with both bodies"

run 0 "$MESA" library sync apply --resolve '.claude/commands/conflictitem.md=skip'
RESULT=$(jqs '.[0]')
[ "$(jq -r .applied <<<"$RESULT")" = "false" ] || fail "sync apply skip: must not apply"
[ "$(jq -r .error <<<"$RESULT")" = "null" ] || fail "sync apply skip: must carry no error"
run 0 "$MESA" library show conflictitem
[ "$(jqs .body)" = "mesa new" ] || fail "skip must leave the mesa body untouched"
[ "$(cat "$CLAUDE_DIR/commands/conflictitem.md")" = "disk new" ] || fail "skip must leave the disk file untouched"
run 0 "$MESA" library sync status
ROW=$(jqs '.[] | select(.name=="conflictitem" and .kind=="command")')
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
# All ELEVEN library routes are loopback-only in BOTH serve modes — including
# the three reads (list/show/versions), not just the five mutations, the two
# sync routes and the two bundle routes (export/import, mesa task 963): a
# row's body IS an agent definition, a hook shell script or a CLAUDE.md, the
# same bytes the sync routes read off disk once it is written there (and a
# bundle is just every one of those bytes at once), so serving that content
# to a LAN peer over GET while writing and syncing it stay loopback-only
# would be a distinction with no security content. Every curl below
# originates on this machine, so the server always sees a LOOPBACK peer —
# what these assertions pin is the Host/Origin half of the same gate (the
# peer-address half is pinned by the Rust unit tests in api.rs).

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
api 200 GET "/api/library/$GATE_ID"
[ "$(jqb .body)" = "x" ] || fail "default: a refused authoring request must write nothing"
ok "default mode: every mutating route AND both sync routes reject a foreign Host, writing nothing"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ================= gates: --lan mode =================
# `--lan` skips the GLOBAL Host allowlist, but every one of the ELEVEN
# library routes — the three reads (list/show/versions) as much as the five
# mutations, the two sync routes and the two bundle routes (export/import) —
# sits behind `require_local_path_write`,
# which layers its own rebinding/cross-site defense
# (`require_lan_page_access`) on top of an actual-loopback-peer check. Every
# curl here originates on this machine, so the real TCP peer is ALWAYS
# loopback and that half can only be forged in the Rust unit tests (see
# api.rs); what curl CAN prove, and what this section proves for all nine
# routes exactly as scripts-check.sh proves it for scripts' authoring routes,
# is: a DNS-name Host is refused (rebinding), a foreign Origin is refused
# (cross-site), and a genuinely local request (IP-literal or localhost Host
# on our port, no foreign Origin) still succeeds — the flag never locks the
# machine's own owner out.

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

# All ELEVEN routes: a DNS-name Host (rebinding) and a foreign Origin
# (cross-site) are each refused — reads exactly as strictly as mutations, the
# two sync routes and the two bundle routes, since every one of them shares
# LIBRARY_LOOPBACK.
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
; do
  IFS='|' read -r METHOD PATH_ BODY_ <<<"$CASE"
  S=$(lan_req "$METHOD" "$PATH_" "evil.example:$LAN_PORT" '' "$BODY_")
  [ "$S" = "403" ] ||
    fail "--lan: $METHOD $PATH_ from a DNS-name Host must be 403, got $S"
  S=$(lan_req "$METHOD" "$PATH_" "127.0.0.1:$LAN_PORT" 'https://evil.example' "$BODY_")
  [ "$S" = "403" ] ||
    fail "--lan: $METHOD $PATH_ from a foreign Origin must be 403, got $S"
done
ok "--lan: all eleven library routes (reads included) reject a DNS-name Host (rebinding) and a foreign Origin (cross-site)"

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

# ================= 9. the live prompt now comes from the library =================
# `core::live::agent_prompt` resolves the `live-agent-prompt` library row
# (forked, else the built-in) rather than config.json's old `live.prompt` key.

run 0 "$MESA" library show live-agent-prompt
[ "$(jqs .id)" = "null" ] || fail "fixture: live-agent-prompt must start unshadowed for this section"
BUILTIN_PROMPT=$(jqs .body)
grep -q "mesa live listen" <<<"$BUILTIN_PROMPT" ||
  fail "fixture: the built-in AGENT_PROMPT must mention mesa live listen"

rm -f "$STUB_DIR/last-prompt"
run 0 "$MESA" live start
S1=$(jqs .id)
[ -f "$STUB_DIR/last-prompt" ] || fail "live start must spawn the stub claude"
grep -q "mesa live listen" "$STUB_DIR/last-prompt" ||
  fail "with nothing forked, live start must spawn with the built-in block: $(cat "$STUB_DIR/last-prompt")"
grep -q "You are driving mesa live session $S1\." "$STUB_DIR/last-prompt" ||
  fail "live start must still append the session line: $(cat "$STUB_DIR/last-prompt")"
run 0 "$MESA" live stop
ok "with nothing forked, mesa live start spawns the agent with the library's built-in live-agent-prompt block"

run 0 "$MESA" library update live-agent-prompt --body 'You are a custom live agent. Be terse.'
[ "$(jqs .builtin_id)" = "live-agent-prompt" ] || fail "forking live-agent-prompt: builtin_id"

rm -f "$STUB_DIR/last-prompt"
run 0 "$MESA" live start
S2=$(jqs .id)
[ -f "$STUB_DIR/last-prompt" ] || fail "live start (forked) must spawn the stub claude"
! grep -q "mesa live listen" "$STUB_DIR/last-prompt" ||
  fail "with live-agent-prompt forked, the built-in block must NOT appear: $(cat "$STUB_DIR/last-prompt")"
grep -q "You are a custom live agent. Be terse." "$STUB_DIR/last-prompt" ||
  fail "the forked body must REPLACE the built-in: $(cat "$STUB_DIR/last-prompt")"
grep -q "You are driving mesa live session $S2\." "$STUB_DIR/last-prompt" ||
  fail "the session line must still be appended after a forked prompt: $(cat "$STUB_DIR/last-prompt")"
run 0 "$MESA" live stop
ok "with live-agent-prompt forked to a different body, that body REPLACES the built-in (mesa never appends to it) while the session line is still appended"

echo "== library-check: section 9 (live prompt) passed ($CHECKS checks so far) =="

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

echo "== library-check: section 10 (import/export) passed ($CHECKS checks so far) =="

echo
echo "library-check: $CHECKS checks passed"
