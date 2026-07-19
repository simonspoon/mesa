#!/usr/bin/env bash
# Milestone 3 gate: exercises the mesa CLI JSON contract end to end —
# create -> list(filtered) -> update -> block -> cycle-rejection -> unblock
# -> delete -> backup — against a throwaway MESA_DB. Asserts JSON fields
# (including error.code and the always-present `blocked`) and exit codes 0/1/2.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
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
    fail "expected exit $expected, got $CODE: $* (stderr: $STDERR)"
}

jqs() { jq -r "$1" <<<"$STDOUT"; } # query last stdout
jqe() { jq -r "$1" <<<"$STDERR"; } # query last stderr

# ---- create ----
run 0 "$MESA" project create "Website" --description "marketing site" --no-git
[ "$(jqs .name)" = "Website" ] || fail "project create: name"
[ "$(jqs .description)" = "marketing site" ] || fail "project create: description"
P=$(jqs .id)
ok "project create returns full object, exit 0"

run 0 "$MESA" project create "Other" --no-git
P2=$(jqs .id)

run 0 "$MESA" task create --project "$P" --title "Design layout" --priority high --tags design,web
T1=$(jqs .id)
[ "$(jqs .blocked)" = "false" ] || fail "task create: blocked must be present and false"
[ "$(jqs .status)" = "todo" ] || fail "task create: default status"
[ "$(jqs .priority)" = "high" ] || fail "task create: priority"
[ "$(jqs '.tags == ["design","web"]')" = "true" ] || fail "task create: tags"
ok "task create returns full object with blocked present"

run 0 "$MESA" task create --project "$P" --title "Write copy" --description "homepage"
T2=$(jqs .id)
run 0 "$MESA" task create --project "$P" --title "Ship it"
T3=$(jqs .id)
run 0 "$MESA" task create --project "$P" --title "Ship subtask" --parent "$T3"
T4=$(jqs .id)
[ "$(jqs .parent_id)" = "$T3" ] || fail "task create: parent_id"
run 0 "$MESA" task create --project "$P2" --title "Unrelated"
T5=$(jqs .id)
ok "task create: subtask and second project"

# positional form: task create <PROJECT> <TITLE> ≡ --project/--title
run 0 "$MESA" task create "$P" "Positional form" --priority low
[ "$(jqs .title)" = "Positional form" ] || fail "task create positional: title"
[ "$(jqs .project_id)" = "$P" ] || fail "task create positional: project_id"
run 0 "$MESA" task delete "$(jqs .id)"
run 0 "$MESA" task create "$P" --title "Mixed form"
[ "$(jqs .title)" = "Mixed form" ] || fail "task create mixed: title"
run 0 "$MESA" task delete "$(jqs .id)"
run 2 "$MESA" task create "$P" "twice" --title "conflict"
[ "$(jqe .error.code)" = "usage" ] || fail "positional+flag title: code=usage"
run 2 "$MESA" task create "$P"
[ "$(jqe .error.code)" = "usage" ] || fail "missing title: code=usage"
ok "task create: positional/mixed forms; both-or-neither is usage"

# validation: unknown project
run 1 "$MESA" task create --project 9999 --title "orphan"
[ "$(jqe .error.code)" = "validation" ] || fail "unknown project: error.code"
jqe .error.message | grep -q 9999 || fail "unknown project: message names the id"
ok "create with unknown project: exit 1, code=validation"

# ---- list (filtered) ----
run 0 "$MESA" task list --project "$P"
[ "$(jqs type)" = "array" ] || fail "list: must be a bare array"
[ "$(jqs length)" = "4" ] || fail "list --project: expected 4 tasks"
[ "$(jqs 'all(.[]; has("blocked"))')" = "true" ] || fail "list: blocked always present"
[ "$(jqs 'any(.[]; has("description"))')" = "false" ] || fail "list: compact objects must omit description"
ok "task list --project: bare array, compact, blocked present"

run 0 "$MESA" task list --project "$P" --tag design
[ "$(jqs length)" = "1" ] || fail "list --tag: expected 1"
[ "$(jqs '.[0].id')" = "$T1" ] || fail "list --tag: wrong task"
ok "task list --tag filter"

run 0 "$MESA" task list --parent "$T3"
[ "$(jqs length)" = "1" ] || fail "list --parent: expected 1"
[ "$(jqs '.[0].parent_id')" = "$T3" ] || fail "list --parent: wrong task"
ok "task list --parent filter"

run 0 "$MESA" task list --status todo
[ "$(jqs length)" = "5" ] || fail "list --status todo: expected 5"
ok "task list --status filter"

# ---- update ----
run 0 "$MESA" task update "$T2" --status in_progress --description "" --tags copy
[ "$(jqs .status)" = "in_progress" ] || fail "update: status"
[ "$(jqs .description)" = "null" ] || fail "update: --description \"\" must clear"
[ "$(jqs '.tags == ["copy"]')" = "true" ] || fail "update: --tags must replace the full set"
[ "$(jqs .blocked)" = "false" ] || fail "update: blocked present"
ok "task update: full object, description cleared, tags replaced"

run 0 "$MESA" task list --project "$P" --status in_progress
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].id')" = "$T2" ] || fail "list --status after update"
ok "task list --status reflects update"

# poka-yoke: update with no fields is a usage error
run 2 "$MESA" task update "$T1"
[ "$(jqe .error.code)" = "usage" ] || fail "empty update: error.code"
ok "task update with no fields: exit 2, code=usage"

# ---- block ----
run 0 "$MESA" task block "$T3" --by "$T1"
[ "$(jqs .blocked)" = "true" ] || fail "block: blocked must be true"
[ "$(jqs .id)" = "$T3" ] || fail "block: returns the blocked task"
ok "task block: full object with blocked=true"

run 0 "$MESA" task block "$T3" --by "$T1"
[ "$(jqs .blocked)" = "true" ] || fail "block: idempotent re-add"
ok "task block: re-adding an existing edge is idempotent"

# the old --on spelling is gone: it is now a usage error
run 2 "$MESA" task block "$T3" --on "$T1"
[ "$(jqe .error.code)" = "usage" ] || fail "block --on: error.code"
ok "task block --on (removed spelling): exit 2, code=usage"

run 0 "$MESA" task list --project "$P" --unblocked
[ "$(jqs "any(.[]; .id == $T3)")" = "false" ] || fail "--unblocked: blocked task must be excluded"
[ "$(jqs "any(.[]; .id == $T1)")" = "true" ] || fail "--unblocked: unblocked task must be included"
ok "task list --unblocked filter"

# ---- cycle rejection ----
run 1 "$MESA" task block "$T1" --by "$T3"
[ "$(jqe .error.code)" = "cycle" ] || fail "cycle: error.code"
jqe .error.message | grep -q "task $T1" || fail "cycle: message names task $T1"
jqe .error.message | grep -q "task $T3" || fail "cycle: message names task $T3"
[ -z "$STDOUT" ] || fail "cycle: nothing on stdout"
ok "cycle rejection: exit 1, code=cycle, names the edge"

run 1 "$MESA" task block "$T1" --by "$T1"
[ "$(jqe .error.code)" = "cycle" ] || fail "self-edge: error.code"
ok "self-edge rejection: exit 1, code=cycle"

# ---- unblock ----
run 0 "$MESA" task unblock "$T3" --on "$T1"
[ "$(jqs .blocked)" = "false" ] || fail "unblock: blocked must be false"
ok "task unblock: full object with blocked=false"

run 1 "$MESA" task unblock "$T3" --on "$T1"
[ "$(jqe .error.code)" = "not_found" ] || fail "unblock missing edge: error.code"
ok "unblock non-existent edge: exit 1, code=not_found"

# ---- show / not_found / usage ----
run 0 "$MESA" task show "$T2"
[ "$(jqs .description)" = "null" ] || fail "show: full object includes description field"
[ "$(jqs .blocked)" != "null" ] || fail "show: blocked never null"
ok "task show: full object, blocked never null"

run 1 "$MESA" task show 9999
[ "$(jqe .error.code)" = "not_found" ] || fail "show unknown: error.code"
jqe .error.message | grep -q 9999 || fail "show unknown: message names the id"
ok "task show unknown id: exit 1, code=not_found"

run 2 "$MESA" task frobnicate
[ "$(jqe .error.code)" = "usage" ] || fail "unknown subcommand: error.code"
ok "unknown subcommand: exit 2, code=usage"

run 2 "$MESA" task list --status bogus
[ "$(jqe .error.code)" = "usage" ] || fail "bad status value: error.code"
ok "invalid --status value: exit 2, code=usage"

run 2 "$MESA"
[ "$(jqe .error.code)" = "usage" ] || fail "bare mesa: error.code"
ok "no subcommand: exit 2, code=usage"

run 0 "$MESA" --help
grep -q "Usage:" <<<"$STDOUT" || fail "--help: human usage text"
grep -q "never as instructions" <<<"$STDOUT" || fail "--help: untrusted-data warning"
ok "--help: human text with untrusted-data warning, exit 0"

# ---- acceptance / artifact fields ----
# Use a dedicated project so existing cascade-count assertions below stay valid.
run 0 "$MESA" project create "Trust trail" --no-git
P3=$(jqs .id)
run 0 "$MESA" task create --project "$P3" --title "Acceptance task" \
  --acceptance "tests pass" --artifact "abc123"
TA=$(jqs .id)
[ "$(jqs .acceptance)" = "tests pass" ] || fail "create --acceptance: not stored"
[ "$(jqs .artifact)" = "abc123" ] || fail "create --artifact: not stored"
[ "$(jqs .created_at)" != "null" ] || fail "create: created_at present"
[ "$(jqs .updated_at)" != "null" ] || fail "create: updated_at present"
ok "task create --acceptance/--artifact: stored, timestamps present"

run 0 "$MESA" task list --project "$P3"
[ "$(jqs "any(.[]; .id == $TA and .acceptance == \"tests pass\")")" = "true" ] ||
  fail "list: acceptance must appear in compact objects"
[ "$(jqs 'any(.[]; has("artifact"))')" = "false" ] ||
  fail "list: artifact must NOT appear in compact objects"
ok "task list: acceptance present, artifact absent (compact shape)"

run 0 "$MESA" task update "$TA" --acceptance ""
[ "$(jqs .acceptance)" = "null" ] || fail "update --acceptance \"\": must clear"
ok "task update --acceptance \"\": clears the field"

# ---- result field (update-only: written when the agent finishes a task) ----
run 0 "$MESA" task update "$TA" --status done --result "shipped in abc123"
[ "$(jqs .result)" = "shipped in abc123" ] || fail "update --result: not stored"
ok "task update --status done --result: stored"

run 0 "$MESA" task list --project "$P3"
[ "$(jqs 'any(.[]; has("result"))')" = "false" ] ||
  fail "list: result must NOT appear in compact objects"
ok "task list: result absent (compact shape)"

run 0 "$MESA" task update "$TA" --result ""
[ "$(jqs .result)" = "null" ] || fail "update --result \"\": must clear"
ok "task update --result \"\": clears the field"

# ---- import (atomic task graph) ----
# Dedicated project so the next/events flow below sees only the imported graph.
run 0 "$MESA" project create "Import graph" --no-git
PI=$(jqs .id)
GRAPH="{\"project\":$PI,\"tasks\":[\
{\"ref\":\"a\",\"title\":\"design\",\"priority\":\"high\",\"acceptance\":\"AC-a\"},\
{\"ref\":\"b\",\"title\":\"build\",\"blocked_by\":[\"a\"]},\
{\"ref\":\"c\",\"title\":\"sub\",\"parent\":\"a\"}]}"
STDOUT=$(echo "$GRAPH" | "$MESA" task import); CODE=$?
[ "$CODE" -eq 0 ] || fail "import: exit 0 expected, got $CODE"
[ "$(jqs type)" = "array" ] || fail "import: prints a bare array"
[ "$(jqs length)" = "3" ] || fail "import: expected 3 created tasks"
IA=$(jqs '.[0].id'); IB=$(jqs '.[1].id'); IC=$(jqs '.[2].id')
[ "$(jqs '.[1].blocked')" = "true" ] || fail "import: intra-doc blocked_by must wire a dep"
[ "$(jqs ".[2].parent_id == $IA")" = "true" ] || fail "import: parent ref must resolve"
ok "task import: 3-task graph created atomically, deps + parent wired"

# in-graph cycle is rejected and creates nothing
BEFORE=$("$MESA" task list --project "$PI" | jq length)
CYCLE="{\"project\":$PI,\"tasks\":[\
{\"ref\":\"x\",\"title\":\"X\",\"blocked_by\":[\"y\"]},\
{\"ref\":\"y\",\"title\":\"Y\",\"blocked_by\":[\"x\"]}]}"
set +e
STDOUT=$(echo "$CYCLE" | "$MESA" task import 2>"$TMP/stderr"); CODE=$?
set -e
STDERR=$(cat "$TMP/stderr")
[ "$CODE" -eq 1 ] || fail "import cycle: expected exit 1, got $CODE"
[ "$(jqe .error.code)" = "cycle" ] || fail "import cycle: error.code"
AFTER=$("$MESA" task list --project "$PI" | jq length)
[ "$BEFORE" = "$AFTER" ] || fail "import cycle: rolled back (count $BEFORE -> $AFTER)"
ok "task import: in-graph cycle rejected (code=cycle, nothing created)"

# malformed JSON is a usage error
run 2 bash -c "echo 'not json' | $MESA task import"
[ "$(jqe .error.code)" = "usage" ] || fail "import malformed JSON: error.code"
ok "task import: malformed JSON: exit 2, code=usage"

# ---- next (deterministic actionable task / counts object) ----
run 0 "$MESA" task next --project "$PI"
[ "$(jqs .id)" = "$IA" ] || fail "next: expected high-priority unblocked task $IA"
ok "task next --project: returns the deterministic actionable task"

# positional project form: next/list <PROJECT> ≡ --project; both is usage
run 0 "$MESA" task next "$PI"
[ "$(jqs .id)" = "$IA" ] || fail "task next positional: expected task $IA"
run 2 "$MESA" task next "$PI" --project "$PI"
[ "$(jqe .error.code)" = "usage" ] || fail "task next positional+flag: code=usage"
run 0 "$MESA" task list "$PI"
[ "$(jqs 'length')" = "$("$MESA" task list --project "$PI" | jq length)" ] || fail "task list positional: same rows as --project"
run 2 "$MESA" task list "$PI" --project "$PI"
[ "$(jqe .error.code)" = "usage" ] || fail "task list positional+flag: code=usage"
ok "task next/list: positional project ≡ --project; both is usage"

# drive that project to completion; next then reports a counts object
run 0 "$MESA" task update "$IA" --status done
run 0 "$MESA" task update "$IB" --status done
run 0 "$MESA" task update "$IC" --status done
run 0 "$MESA" task next --project "$PI"
[ "$(jqs .next)" = "null" ] || fail "next (none): must print {\"next\":null,...}"
[ "$(jqs .blocked)" = "0" ] || fail "next (none): blocked count"
[ "$(jqs .in_progress)" = "0" ] || fail "next (none): in_progress count"
[ "$(jqs .todo)" = "0" ] || fail "next (none): todo count"
ok "task next (none actionable): counts object, exit 0, all done"

# ---- events (append-only status log) ----
run 0 "$MESA" task events "$IA"
[ "$(jqs type)" = "array" ] || fail "events: bare array"
[ "$(jqs length)" = "2" ] || fail "events: expected create + 1 status change"
[ "$(jqs '.[0].from_status')" = "null" ] || fail "events: creation row has null from_status"
[ "$(jqs '.[0].to_status')" = "todo" ] || fail "events: creation row to_status"
[ "$(jqs '.[1].from_status')" = "todo" ] || fail "events: change row from_status"
[ "$(jqs '.[1].to_status')" = "done" ] || fail "events: change row to_status"
ok "task events <id>: append-only rows, oldest first (create + change)"

# ---- root-commit binding & resolve (source-to-project identity) ----
# Isolated db + a throwaway git repo so this can't perturb the P/P2 counts the
# delete/backup assertions below depend on.
MESA_ABS="$(pwd)/$MESA"
RDB="$TMP/resolve.db"
MESA_DB="$RDB" run 0 "$MESA" project create "Bound" --root-commit deadbeefcafe
[ "$(jqs .root_commit)" = "deadbeefcafe" ] || fail "create --root-commit: stored"
MESA_DB="$RDB" run 1 "$MESA" project create "Dup" --root-commit deadbeefcafe
[ "$(jqe .error.code)" = "conflict" ] || fail "duplicate root commit: error.code=conflict"
ok "root-commit binding: stored + duplicate rejected (conflict)"

# An explicit empty --root-commit means "no binding", not an empty-string bind
# (mirrors `update --root-commit ""`); two of them must not collide.
MESA_DB="$RDB" run 0 "$MESA" project create "Empty A" --root-commit ""
[ "$(jqs .root_commit)" = "null" ] || fail "create --root-commit \"\": must not bind"
MESA_DB="$RDB" run 0 "$MESA" project create "Empty B" --root-commit ""
ok "create --root-commit \"\": treated as no binding, no collision"

REPO="$TMP/repo"
mkdir -p "$REPO/sub"
git -C "$REPO" init -q
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
RC=$(git -C "$REPO" rev-list --max-parents=0 --reverse HEAD | head -1)
MESA_DB="$RDB" run 0 bash -c "cd '$REPO' && '$MESA_ABS' project create 'Repo proj'"
[ "$(jqs .root_commit)" = "$RC" ] || fail "create auto-binds cwd root commit"
RPID=$(jqs .id)
MESA_DB="$RDB" run 0 "$MESA" project resolve "$REPO/sub"
[ "$(jqs .id)" = "$RPID" ] || fail "resolve: subdir maps to its repo's project"
ok "resolve: a git checkout maps back to its one project"
MESA_DB="$RDB" run 1 "$MESA" project resolve "$TMP"
[ "$(jqe .error.code)" = "validation" ] || fail "resolve non-git: error.code=validation"
ok "resolve: non-git path errors validation"

# --path <dir> detects the auto-bound root commit from <dir>, not from the cwd
# repo (regression: used to bind whatever repo the command happened to run in).
REPO2="$TMP/repo2"
mkdir -p "$REPO2"
git -C "$REPO2" init -q
# distinct message so this root commit can't hash-collide with $REPO's
git -C "$REPO2" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init2
RC2=$(git -C "$REPO2" rev-list --max-parents=0 --reverse HEAD | head -1)
MESA_DB="$RDB" run 0 "$MESA" project create "Path proj" --path "$REPO2"
[ "$(jqs .root_commit)" = "$RC2" ] || fail "create --path: root commit from --path dir, not cwd"
ok "create --path: auto-binds the --path directory's repo"

# Drop the extra projects so the delete/backup assertions below (which assume
# only P and P2 exist) remain valid.
run 0 "$MESA" project delete "$P3"
run 0 "$MESA" project delete "$PI"

# ---- delete ----
run 0 "$MESA" task delete "$T3"
[ "$(jqs type)" = "array" ] || fail "task delete: bare array of destroyed records"
[ "$(jqs length)" = "2" ] || fail "task delete: task + cascaded subtask"
[ "$(jqs '.[0].id')" = "$T3" ] || fail "task delete: deleted task first"
[ "$(jqs "any(.[]; .id == $T4)")" = "true" ] || fail "task delete: subtask included"
[ "$(jqs 'all(.[]; has("blocked"))')" = "true" ] || fail "task delete: blocked present on records"
ok "task delete: echoes full destroyed records (cascade)"

run 0 "$MESA" project delete "$P"
[ "$(jqs .project.id)" = "$P" ] || fail "project delete: project echoed"
[ "$(jqs '.tasks | length')" = "2" ] || fail "project delete: cascaded tasks echoed"
ok "project delete: echoes project plus cascaded tasks"

run 1 "$MESA" project show "$P"
[ "$(jqe .error.code)" = "not_found" ] || fail "deleted project: error.code"
ok "deleted project is gone: exit 1, code=not_found"

# ---- backup ----
run 0 "$MESA" backup "$TMP/snap.db"
[ -f "$TMP/snap.db" ] || fail "backup: snapshot file missing"
MESA_DB="$TMP/snap.db" run 0 "$MESA" project list
[ "$(jqs length)" = "1" ] || fail "backup: snapshot project count"
[ "$(jqs '.[0].id')" = "$P2" ] || fail "backup: snapshot contents"
ok "backup: VACUUM INTO snapshot readable via MESA_DB"

echo "all $CHECKS checks passed"
