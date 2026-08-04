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

# positional form: project create <NAME> ≡ --name, like every other create
run 0 "$MESA" project create --name "Flag form" --no-git
[ "$(jqs .name)" = "Flag form" ] || fail "project create --name: name"
run 0 "$MESA" project delete "$(jqs .id)"
run 2 "$MESA" project create "A" --name "B" --no-git
[ "$(jqe .error.code)" = "usage" ] || fail "positional+flag name: code=usage"
run 2 "$MESA" project create --no-git
[ "$(jqe .error.code)" = "usage" ] || fail "missing name: code=usage"
ok "project create: positional/flag name forms; both or neither is usage"

run 0 "$MESA" project create "Other" --no-git
P2=$(jqs .id)

# ---- sort_order: the field the sidebar's drag-reorder writes (task 666) ----
# Creation order first, then the head-insert value a drag computes. jq does the
# arithmetic: `sort_order` is a REAL, so it serializes as `1.0` and bash's
# integer-only $(( )) cannot touch it.
run 0 "$MESA" project list
[ "$(jqs 'map(select(.id == '"$P"' or .id == '"$P2"')) | map(.id) | join(",")')" = "$P,$P2" ] ||
  fail "project list: new projects must list in creation order"
run 0 "$MESA" project show "$P"
P_ORDER=$(jqs .sort_order)
[ "$P_ORDER" != "null" ] || fail "project show: sort_order must be present"
P_ORDER_UP=$(jq -n --argjson f "$P_ORDER" '$f - 1')
run 0 "$MESA" project update "$P2" --sort-order "$P_ORDER_UP"
[ "$(jqs ".sort_order == $P_ORDER_UP")" = "true" ] || fail "project update --sort-order: value"
run 0 "$MESA" project list
[ "$(jqs 'map(select(.id == '"$P"' or .id == '"$P2"')) | map(.id) | join(",")')" = "$P2,$P" ] ||
  fail "project list must reflect the new sort_order"
run 0 "$MESA" project show "$P"
[ "$(jqs ".sort_order == $P_ORDER")" = "true" ] ||
  fail "updating one project's sort_order must not rewrite another's"
# A non-numeric value is a usage error, not a silent no-op.
run 2 "$MESA" project update "$P2" --sort-order not-a-number
# Put it back so the rest of the gate sees creation order.
run 0 "$MESA" project update "$P2" --sort-order "$(jq -n --argjson f "$P_ORDER" '$f + 1')"
ok "project sort_order: listed order, one-row update, non-numeric is usage"

run 0 "$MESA" task create --project "$P" --description "Design layout" --priority high --tags design,web
T1=$(jqs .id)
[ "$(jqs .blocked)" = "false" ] || fail "task create: blocked must be present and false"
[ "$(jqs .status)" = "todo" ] || fail "task create: default status"
[ "$(jqs .priority)" = "high" ] || fail "task create: priority"
[ "$(jqs '.tags == ["design","web"]')" = "true" ] || fail "task create: tags"
ok "task create returns full object with blocked present"

run 0 "$MESA" task create --project "$P" --description "Write copy" --tag draft
[ "$(jqs '.tags == ["draft"]')" = "true" ] || fail "task create --tag is an alias for --tags"
T2=$(jqs .id)
run 0 "$MESA" task create --project "$P" --description "Ship it"
T3=$(jqs .id)
run 0 "$MESA" task create --project "$P" --description "Ship subtask" --parent "$T3"
T4=$(jqs .id)
[ "$(jqs .parent_id)" = "$T3" ] || fail "task create: parent_id"
run 0 "$MESA" task create --project "$P2" --description "Unrelated"
T5=$(jqs .id)
ok "task create: subtask and second project"

# positional form: task create <PROJECT> <DESCRIPTION> ≡ --project/--description
run 0 "$MESA" task create "$P" "Positional form" --priority low
[ "$(jqs .description)" = "Positional form" ] || fail "task create positional: description"
[ "$(jqs .name)" = "Positional form" ] || fail "task create positional: derived name"
[ "$(jqs .project_id)" = "$P" ] || fail "task create positional: project_id"
run 0 "$MESA" task delete "$(jqs .id)"
run 0 "$MESA" task create "$P" --description "Mixed form"
[ "$(jqs .description)" = "Mixed form" ] || fail "task create mixed: description"
run 0 "$MESA" task delete "$(jqs .id)"
run 2 "$MESA" task create "$P" "twice" --description "conflict"
[ "$(jqe .error.code)" = "usage" ] || fail "positional+flag description: code=usage"
run 2 "$MESA" task create "$P"
[ "$(jqe .error.code)" = "usage" ] || fail "missing description: code=usage"
# the third form: a body from a file (or stdin) satisfies the same requirement
run 0 bash -c "printf 'From a file\n\nwith a body' | $MESA task create '$P' --description-file -"
[ "$(jqs .name)" = "From a file" ] || fail "task create --description-file: derived name"
run 0 "$MESA" task delete "$(jqs .id)"
run 2 "$MESA" task create "$P" "twice" --description-file -
[ "$(jqe .error.code)" = "usage" ] || fail "positional+--description-file: code=usage"
ok "task create: positional/flag/file forms; more than one is usage"

# the derived name: first line only, cut to 50 chars with an ellipsis marking
# the cut. Never stored — it always follows the body it was cut from.
LONGLINE=$(printf 'y%.0s' $(seq 1 60))
run 0 "$MESA" task create "$P" "$LONGLINE"
TLONG=$(jqs .id)
[ "$(jqs .name)" = "$(printf 'y%.0s' $(seq 1 50))…" ] || fail "task create: name cut at 50 chars"
[ "$(jqs .description)" = "$LONGLINE" ] || fail "task create: description kept in full"
run 0 "$MESA" task update "$TLONG" --description "renamed by the body"
[ "$(jqs .name)" = "renamed by the body" ] || fail "task update: name follows the description"
run 0 "$MESA" task update "$TLONG" --append --description "a later note"
[ "$(jqs .name)" = "renamed by the body" ] || fail "append must not move the name"
run 1 "$MESA" task update "$TLONG" --description ""
[ "$(jqe .error.code)" = "validation" ] || fail "empty description: code=validation"
run 0 "$MESA" task delete "$TLONG"
ok "task name: first line cut to 50 chars, derived on read, never emptiable"

# validation: unknown project
run 1 "$MESA" task create --project 9999 --description "orphan"
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

run 0 "$MESA" task list --project "$P" --tags design
[ "$(jqs length)" = "1" ] || fail "list --tags alias: expected 1"
[ "$(jqs '.[0].id')" = "$T1" ] || fail "list --tags alias: wrong task"
ok "task list --tags is an alias for --tag"

run 0 "$MESA" task list --parent "$T3"
[ "$(jqs length)" = "1" ] || fail "list --parent: expected 1"
[ "$(jqs '.[0].parent_id')" = "$T3" ] || fail "list --parent: wrong task"
ok "task list --parent filter"

run 0 "$MESA" task list --status todo
[ "$(jqs length)" = "5" ] || fail "list --status todo: expected 5"
ok "task list --status filter"

# ---- update ----
run 0 "$MESA" task update "$T2" --status in_progress --description "Rewrite copy" --tags copy
[ "$(jqs .status)" = "in_progress" ] || fail "update: status"
[ "$(jqs .description)" = "Rewrite copy" ] || fail "update: --description must replace the body"
[ "$(jqs .name)" = "Rewrite copy" ] || fail "update: name follows the new body"
[ "$(jqs '.tags == ["copy"]')" = "true" ] || fail "update: --tags must replace the full set"
[ "$(jqs .blocked)" = "false" ] || fail "update: blocked present"
ok "task update: full object, description replaced, tags replaced"

# --tag is an alias for --tags on update (and --tags for --tag on list, above)
run 0 "$MESA" task update "$T2" --tag copy,urgent
[ "$(jqs '.tags == ["copy","urgent"]')" = "true" ] || fail "update --tag alias: tag set"
run 0 "$MESA" task update "$T2" --tags copy
[ "$(jqs '.tags == ["copy"]')" = "true" ] || fail "update: restore tags"
ok "task update --tag is an alias for --tags"

run 0 "$MESA" task list --project "$P" --status in_progress
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].id')" = "$T2" ] || fail "list --status after update"
ok "task list --status reflects update"

# poka-yoke: update with no fields is a usage error
run 2 "$MESA" task update "$T1"
[ "$(jqe .error.code)" = "usage" ] || fail "empty update: error.code"
ok "task update with no fields: exit 2, code=usage"

# ---- claim / release (task 563) ----
run 0 "$MESA" task show "$T2"
[ "$(jqs .owner)" = "null" ] || fail "claim: a fresh task must be unowned"
[ "$(jqs .claimed_at)" = "null" ] || fail "claim: a fresh task has no claimed_at"
ok "task show: owner/claimed_at present and null when unclaimed"

run 0 "$MESA" task claim "$T2" --owner sess-a
[ "$(jqs .status)" = "in_progress" ] || fail "claim: moves the task to in_progress"
[ "$(jqs .owner)" = "sess-a" ] || fail "claim: records the owner"
[ "$(jqs .claimed_at)" != "null" ] || fail "claim: must stamp claimed_at"
ok "task claim: in_progress + owner + claimed_at"

# the guard against two agents in one repo
run 1 "$MESA" task claim "$T2" --owner sess-b
[ "$(jqe .error.code)" = "conflict" ] || fail "claim by another owner: error.code"
ok "task claim held by another owner: exit 1, code=conflict"

# same owner = renewal, not conflict
run 0 "$MESA" task claim "$T2" --owner sess-a
[ "$(jqs .owner)" = "sess-a" ] || fail "claim: re-claiming with the same owner renews"
ok "task claim by the same owner: renews the lease"

run 0 "$MESA" task claim "$T2" --owner sess-b --force
[ "$(jqs .owner)" = "sess-b" ] || fail "claim --force: breaks the stale claim"
ok "task claim --force: breaks another owner's claim"

# claims travel in `list` too, so a project can be scanned in one call
run 0 "$MESA" task list --project "$P"
[ "$(jqs "any(.[]; .id == $T2 and .owner == \"sess-b\")")" = "true" ] ||
  fail "list: owner must be carried on compact objects"
[ "$(jqs 'all(.[]; has("claimed_at"))')" = "true" ] || fail "list: claimed_at always present"
ok "task list: owner/claimed_at on compact objects"

run 0 "$MESA" task release "$T2"
[ "$(jqs .owner)" = "null" ] || fail "release: clears owner"
[ "$(jqs .claimed_at)" = "null" ] || fail "release: clears claimed_at"
[ "$(jqs .status)" = "in_progress" ] || fail "release: leaves status untouched"
ok "task release: clears the claim, status untouched"

run 0 "$MESA" task release "$T2"
[ "$(jqs .owner)" = "null" ] || fail "release: idempotent"
ok "task release on an unclaimed task: idempotent"

# leaving in_progress drops the claim rather than leaving a done task owned
run 0 "$MESA" task claim "$T2" --owner sess-a
run 0 "$MESA" task update "$T2" --status done
[ "$(jqs .owner)" = "null" ] || fail "done: claim must be dropped"
[ "$(jqs .claimed_at)" = "null" ] || fail "done: claimed_at must be dropped"
ok "leaving in_progress drops the claim"

# restore T2 to the state this section found it in (in_progress, unclaimed),
# so the assertions further down are unaffected by this block
run 0 "$MESA" task update "$T2" --status in_progress

run 1 "$MESA" task claim 999999 --owner sess-a
[ "$(jqe .error.code)" = "not_found" ] || fail "claim missing task: error.code"
ok "task claim on a missing task: exit 1, code=not_found"

run 2 "$MESA" task claim "$T2"
[ "$(jqe .error.code)" = "usage" ] || fail "claim without --owner: error.code"
ok "task claim without --owner: exit 2, code=usage"

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

# ---- deps ----
# T3 is blocked by T1 at this point; the edge is inspectable from both ends.
run 0 "$MESA" task deps "$T3"
[ "$(jqs .id)" = "$T3" ] || fail "deps: echoes the task id"
[ "$(jqs .blocked)" = "true" ] || fail "deps: blocked mirrors task show"
[ "$(jqs '.blocked_by | length')" = "1" ] || fail "deps: one blocker"
[ "$(jqs '.blocked_by[0].id')" = "$T1" ] || fail "deps: names the blocker"
[ "$(jqs '.blocked_by[0] | has("description")')" = "false" ] || fail "deps: compact objects"
[ "$(jqs '.blocks | length')" = "0" ] || fail "deps: T3 blocks nothing"
ok "task deps: blocked_by names the blocker, compact shape"

# ...and the reverse direction from the blocker's side
run 0 "$MESA" task deps "$T1"
[ "$(jqs '.blocks[0].id')" = "$T3" ] || fail "deps: reverse edge"
[ "$(jqs '.blocked_by | length')" = "0" ] || fail "deps: T1 has no blockers"
ok "task deps: blocks lists the reverse edge"

run 1 "$MESA" task deps 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "deps missing task: error.code"
ok "task deps on a missing task: exit 1, code=not_found"

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
[ "$(jqs .description)" = "Rewrite copy" ] || fail "show: full object includes description field"
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
run 0 "$MESA" task create --project "$P3" --description "Acceptance task" \
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
[ "$(jqs "any(.[]; .id == $TA and .artifact == \"abc123\")")" = "true" ] ||
  fail "list: artifact must appear in compact objects (bounded pointer, spec 651)"
[ "$(jqs 'any(.[]; has("description"))')" = "false" ] ||
  fail "list: description must NOT appear in compact objects"
ok "task list: acceptance + artifact present, description absent (compact shape)"

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
{\"ref\":\"a\",\"description\":\"design\",\"priority\":\"high\",\"acceptance\":\"AC-a\"},\
{\"ref\":\"b\",\"description\":\"build\",\"blocked_by\":[\"a\"]},\
{\"ref\":\"c\",\"description\":\"sub\",\"parent\":\"a\"}]}"
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
{\"ref\":\"x\",\"description\":\"X\",\"blocked_by\":[\"y\"]},\
{\"ref\":\"y\",\"description\":\"Y\",\"blocked_by\":[\"x\"]}]}"
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

# ---- --quiet on the task group (spec 644) ----
# Self-contained: its own project, dropped at the end, so the delete/backup
# assertions below (which assume only P and P2 exist) stay valid.
#
# Quiet output is compared with `printf '%s' | jq`, never `echo "$var"` — zsh
# echo expands escapes and corrupts JSON carrying \n in a description.

# quiet_is_full_minus_bodies <full-file> <quiet-file> — the quiet object must be
# EXACTLY the full object minus the three keys the compact shape drops: every
# other key present and byte-equal. Fails if a key is missing, extra, or edited.
# `artifact` is deliberately NOT dropped — it is a bounded pointer an agent
# writes at close-out and needs echoed back (spec 651).
quiet_is_full_minus_bodies() {
  jq -e --slurpfile q "$2" \
    'del(.description, .result, .created_at) == $q[0]' "$1" >/dev/null
}

run 0 "$MESA" project create "Quiet" --no-git
PQ=$(jqs .id)

BODY="line one
line two"

# `<subject>\n\n<body>`: the post-660 task shape — a first line that becomes
# the name, then the body the compact projection drops.
body_with() { printf '%s\n\n%s' "$1" "$BODY"; }

# show: the reference parity case — same record, read twice, so nothing volatile
# moves between the two calls.
run 0 "$MESA" task create "$PQ" --description "$(body_with 'Quiet subject')" \
  --acceptance "AC" --artifact "sha1"
QT=$(jqs .id)
run 0 "$MESA" task show "$QT"
printf '%s' "$STDOUT" >"$TMP/full.json"
# non-quiet output is unchanged: the full 17-key task object
[ "$(jqs 'keys | join(",")')" = "acceptance,artifact,blocked,claimed_at,created_at,description,id,name,owner,parent_id,priority,project_id,result,sort_order,status,tags,updated_at" ] ||
  fail "task show (no --quiet): full key set must be unchanged"
run 0 "$MESA" task show "$QT" --quiet
printf '%s' "$STDOUT" >"$TMP/quiet.json"
[ "$(jqs 'has("description")')" = "false" ] || fail "task show --quiet: description must be dropped"
[ "$(jqs .artifact)" = "sha1" ] ||
  fail "task show --quiet: artifact must be kept, with its value (spec 651)"
quiet_is_full_minus_bodies "$TMP/full.json" "$TMP/quiet.json" ||
  fail "task show --quiet: must be the full object minus description/result/created_at"
ok "task show --quiet: compact shape, every other key present and equal"

# every quiet mutation prints that same compact shape; parity is checked against
# a following `show` (a read, so updated_at cannot move between the two).
quiet_mutation_ok() { # quiet_mutation_ok <label> <cmd...>
  local label=$1; shift
  run 0 "$@"
  printf '%s' "$STDOUT" >"$TMP/quiet.json"
  [ "$(jqs 'has("description")')" = "false" ] || fail "$label --quiet: description must be dropped"
  run 0 "$MESA" task show "$QT"
  printf '%s' "$STDOUT" >"$TMP/full.json"
  quiet_is_full_minus_bodies "$TMP/full.json" "$TMP/quiet.json" ||
    fail "$label --quiet: must be the full object minus the three dropped keys"
}

quiet_mutation_ok "task update" "$MESA" task update "$QT" --status in_progress --quiet
quiet_mutation_ok "task claim" "$MESA" task claim "$QT" --owner sess-q --quiet
quiet_mutation_ok "task release" "$MESA" task release "$QT" --quiet
ok "task update/claim/release --quiet: compact shape, parity with show"

run 0 "$MESA" task create "$PQ" "Quiet blocker" --quiet
QB=$(jqs .id)
[ "$(jqs 'has("description")')" = "false" ] || fail "task create --quiet: description must be dropped"
[ "$(jqs .name)" = "Quiet blocker" ] || fail "task create --quiet: name"
quiet_mutation_ok "task block" "$MESA" task block "$QT" --by "$QB" --quiet
[ "$(jqs .blocked)" = "true" ] || fail "task block --quiet: blocked must be true"
quiet_mutation_ok "task unblock" "$MESA" task unblock "$QT" --on "$QB" --quiet
[ "$(jqs .blocked)" = "false" ] || fail "task unblock --quiet: blocked must be false"
ok "task create/block/unblock --quiet: compact shape, values intact"

# import composite: same container (a bare array), members compacted
IMPQ="{\"project\":$PQ,\"tasks\":[{\"ref\":\"a\",\"description\":\"quiet import\\nan imported body\"}]}"
run 0 bash -c "printf '%s' '$IMPQ' | $MESA task import"
[ "$(jqs type)" = "array" ] || fail "task import (no --quiet): bare array"
[ "$(jqs '.[0] | has("description")')" = "true" ] || fail "task import (no --quiet): description present"
run 0 "$MESA" task delete "$(jqs '.[0].id')"
run 0 bash -c "printf '%s' '$IMPQ' | $MESA task import --quiet"
[ "$(jqs type)" = "array" ] || fail "task import --quiet: container stays a bare array"
[ "$(jqs length)" = "1" ] || fail "task import --quiet: one created task"
[ "$(jqs 'all(.[]; has("description"))')" = "false" ] || fail "task import --quiet: members compacted"
[ "$(jqs '.[0].name')" = "quiet import" ] || fail "task import --quiet: name"
run 0 "$MESA" task delete "$(jqs '.[0].id')" --quiet
ok "task import --quiet: same container, compact members"

# delete composite: the cascade array keeps its shape, members compacted.
# --quiet here is an explicit opt-out of the full recovery transcript.
run 0 "$MESA" task create "$PQ" --description "$(body_with 'Quiet parent')"
QP=$(jqs .id)
run 0 "$MESA" task create "$PQ" --description "$(body_with 'Quiet child')" --parent "$QP"
run 0 "$MESA" task delete "$QP" --quiet
[ "$(jqs type)" = "array" ] || fail "task delete --quiet: container stays a bare array"
[ "$(jqs length)" = "2" ] || fail "task delete --quiet: task + cascaded subtask"
[ "$(jqs '.[0].id')" = "$QP" ] || fail "task delete --quiet: deleted task first"
[ "$(jqs 'any(.[]; has("description"))')" = "false" ] || fail "task delete --quiet: members compacted"
[ "$(jqs 'all(.[]; has("blocked"))')" = "true" ] || fail "task delete --quiet: blocked still present"
ok "task delete --quiet: cascade array with compact members"

# --quiet is a modifier, NOT a field: `task update <id> --quiet` alone must be a
# loud usage error, so a batch caller fails on item one instead of silently
# no-opping every item.
run 2 "$MESA" task update "$QT" --quiet
[ -z "$STDOUT" ] || fail "task update --quiet alone: stdout must be empty"
[ -n "$STDERR" ] || fail "task update --quiet alone: stderr must be non-empty"
[ "$(jqe .error.code)" = "usage" ] || fail "task update --quiet alone: error.code"
ok "task update --quiet with no field flag: exit 2, empty stdout, code=usage"

# long form only: no -q alias
run 2 "$MESA" task show "$QT" -q
ok "task show -q: exit 2 (no short alias)"

# --quiet does not exist outside the 9 subcommands in scope
run 2 "$MESA" task list --quiet
run 2 "$MESA" task next --quiet
run 2 "$MESA" task deps "$QT" --quiet
run 2 "$MESA" task events "$QT" --quiet
ok "task list/next/deps/events --quiet: exit 2 (unknown argument)"

# every one of the 9 advertises the flag in --help
for SUB in create import show update delete claim release block unblock; do
  run 0 "$MESA" task "$SUB" --help
  grep -q -- "--quiet" <<<"$STDOUT" || fail "task $SUB --help: must list --quiet"
done
ok "task create/import/show/update/delete/claim/release/block/unblock --help: --quiet listed"

# --quiet changes stdout only: exit code and the stderr payload are identical
run 1 "$MESA" task show 999999
printf '%s' "$STDERR" >"$TMP/err-full.txt"
run 1 "$MESA" task show 999999 --quiet
printf '%s' "$STDERR" >"$TMP/err-quiet.txt"
cmp -s "$TMP/err-full.txt" "$TMP/err-quiet.txt" ||
  fail "task show --quiet: stderr must be byte-identical on the error path"
ok "error path: exit 1 and byte-identical stderr with and without --quiet"

# size: the reason the flag exists (28 KB description -> < 1 KB on stdout)
python3 -c "import sys; sys.stdout.write('x' * 28672)" >"$TMP/big.txt"
run 0 "$MESA" task create "$PQ" --description-file "$TMP/big.txt" --quiet
QBIG=$(jqs .id)
run 0 "$MESA" task update "$QBIG" --status done --quiet
printf '%s' "$STDOUT" >"$TMP/big-quiet.json"
[ "$(wc -c <"$TMP/big-quiet.json")" -lt 1024 ] ||
  fail "task update --quiet on a 28 KB description: stdout must be < 1 KB"
[ "$(jqs .status)" = "done" ] || fail "task update --quiet: | jq -r .status must print done"
run 0 "$MESA" task update "$QBIG" --status todo
[ "$(wc -c <<<"$STDOUT")" -gt 28672 ] ||
  fail "task update without --quiet: must still echo the full 28 KB body"
ok "28 KB description: --quiet stdout < 1 KB, status readable; default still full"

run 0 "$MESA" project delete "$PQ"

# ---- --quiet on the project group (spec 644) ----
# Self-contained: its own projects, all destroyed here, so the delete/backup
# assertions below (which assume only P and P2 exist) stay valid.
#
# JSON is compared with `printf '%s'` into a file, never `echo "$var"` — zsh
# echo expands escapes and corrupts JSON carrying \n in a description.

# project_quiet_parity <full-file> <quiet-file> — the quiet project must be
# EXACTLY the full project minus `description`: every other key present and
# byte-equal. Fails if a key is missing, extra, or edited.
project_quiet_parity() {
  jq -e --slurpfile q "$2" 'del(.description) == $q[0]' "$1" >/dev/null
}

run 0 "$MESA" project create "Quiet project" --no-git --description "$BODY"
PJQ=$(jqs .id)

# show: the reference parity case — same record read twice, nothing volatile
# moves between the two calls (Project carries no timestamp at all).
run 0 "$MESA" project show "$PJQ"
printf '%s' "$STDOUT" >"$TMP/pfull.json"
# non-quiet output is unchanged: the full 8-key project object
[ "$(jqs 'keys | join(",")')" = "archived,description,id,local_path,name,parent_id,root_commit,sort_order" ] ||
  fail "project show (no --quiet): full key set must be unchanged"
[ "$(jqs 'has("description")')" = "true" ] || fail "project show (no --quiet): description present"
run 0 "$MESA" project show "$PJQ" --quiet
printf '%s' "$STDOUT" >"$TMP/pquiet.json"
[ "$(jqs 'has("description")')" = "false" ] || fail "project show --quiet: description must be dropped"
project_quiet_parity "$TMP/pfull.json" "$TMP/pquiet.json" ||
  fail "project show --quiet: must be the full project minus description"
ok "project show --quiet: full project minus description, every other key equal"

# every quiet mutation prints that same shape; parity is checked against a
# following `show` (a read), so the two captures describe the same state.
project_quiet_mutation_ok() { # project_quiet_mutation_ok <label> <cmd...>
  local label=$1; shift
  run 0 "$@"
  printf '%s' "$STDOUT" >"$TMP/pquiet.json"
  [ "$(jqs 'has("description")')" = "false" ] || fail "$label --quiet: description must be dropped"
  run 0 "$MESA" project show "$PJQ"
  printf '%s' "$STDOUT" >"$TMP/pfull.json"
  project_quiet_parity "$TMP/pfull.json" "$TMP/pquiet.json" ||
    fail "$label --quiet: must be the full project minus description"
}

project_quiet_mutation_ok "project update" "$MESA" project update "$PJQ" --name "Quiet renamed" --quiet
project_quiet_mutation_ok "project archive" "$MESA" project archive "$PJQ" --quiet
[ "$(jqs .archived)" = "true" ] || fail "project archive --quiet: archived must be true"
project_quiet_mutation_ok "project unarchive" "$MESA" project unarchive "$PJQ" --quiet
[ "$(jqs .archived)" = "false" ] || fail "project unarchive --quiet: archived must be false"
ok "project update/archive/unarchive --quiet: shape and values intact"

run 0 "$MESA" project create "Quiet created" --no-git --description "$BODY" --quiet
PJQ2=$(jqs .id)
[ "$(jqs 'has("description")')" = "false" ] || fail "project create --quiet: description must be dropped"
[ "$(jqs .name)" = "Quiet created" ] || fail "project create --quiet: name"
[ "$(jqs .archived)" = "false" ] || fail "project create --quiet: archived"
run 0 "$MESA" project delete "$PJQ2"
ok "project create --quiet: project minus description, values intact"

# delete: the composite keeps its {project, tasks} key structure; only the
# members are projected. --quiet here is an explicit opt-out of the full
# recovery transcript.
run 0 "$MESA" task create "$PJQ" --description "$(body_with 'Quiet cascade')"
run 0 "$MESA" project create "Quiet delete" --no-git --description "$BODY"
PJQ3=$(jqs .id)
run 0 "$MESA" task create "$PJQ3" --description "$(body_with 'Quiet cascade')"
run 0 "$MESA" project delete "$PJQ3"
printf '%s' "$STDOUT" >"$TMP/pdel-full.json"
[ "$(jqs '.project | has("description")')" = "true" ] ||
  fail "project delete (no --quiet): project description present"
[ "$(jqs '.tasks[0] | has("description")')" = "true" ] ||
  fail "project delete (no --quiet): task description present"
run 0 "$MESA" project delete "$PJQ" --quiet
printf '%s' "$STDOUT" >"$TMP/pdel-quiet.json"
[ "$(jq -S 'keys' "$TMP/pdel-quiet.json")" = "$(jq -S 'keys' "$TMP/pdel-full.json")" ] ||
  fail "project delete --quiet: container keys must match the non-quiet shape"
[ "$(jqs '.project | has("description")')" = "false" ] ||
  fail "project delete --quiet: project description must be dropped"
[ "$(jqs '.project.id')" = "$PJQ" ] || fail "project delete --quiet: project echoed"
[ "$(jqs '.tasks | length')" = "1" ] || fail "project delete --quiet: cascaded task echoed"
[ "$(jqs 'any(.tasks[]; has("description"))')" = "false" ] ||
  fail "project delete --quiet: task members must be compacted"
[ "$(jqs 'all(.tasks[]; has("blocked"))')" = "true" ] ||
  fail "project delete --quiet: blocked still present on task members"
ok "project delete --quiet: same {project, tasks} keys, compact members"

# --quiet is a modifier, NOT a field: `project update <id> --quiet` alone must
# be a usage error, not a legal call that silently does nothing (M2).
run 0 "$MESA" project create "Quiet usage" --no-git
PJQ4=$(jqs .id)
run 2 "$MESA" project update "$PJQ4" --quiet
[ -z "$STDOUT" ] || fail "project update --quiet alone: stdout must be empty"
[ -n "$STDERR" ] || fail "project update --quiet alone: stderr must be non-empty"
[ "$(jqe .error.code)" = "usage" ] || fail "project update --quiet alone: error.code"
ok "project update --quiet with no field flag: exit 2, empty stdout, code=usage"

# long form only: no -q alias
run 2 "$MESA" project show "$PJQ4" -q
ok "project show -q: exit 2 (no short alias)"

# --quiet does not exist outside the 6 subcommands in scope
run 2 "$MESA" project list --quiet
run 2 "$MESA" project resolve --quiet
ok "project list/resolve --quiet: exit 2 (unknown argument)"

# every one of the 6 advertises the flag in --help
for SUB in create show update delete archive unarchive; do
  run 0 "$MESA" project "$SUB" --help
  grep -q -- "--quiet" <<<"$STDOUT" || fail "project $SUB --help: must list --quiet"
done
ok "project create/show/update/delete/archive/unarchive --help: --quiet listed"

# --quiet changes stdout only: exit code and the stderr payload are identical
run 1 "$MESA" project show 999999
printf '%s' "$STDERR" >"$TMP/perr-full.txt"
run 1 "$MESA" project show 999999 --quiet
printf '%s' "$STDERR" >"$TMP/perr-quiet.txt"
cmp -s "$TMP/perr-full.txt" "$TMP/perr-quiet.txt" ||
  fail "project show --quiet: stderr must be byte-identical on the error path"
ok "project error path: exit 1 and byte-identical stderr with and without --quiet"

run 0 "$MESA" project delete "$PJQ4"

# ---- --quiet on the inbox group (spec 644, M12 inbox half) ----
# Inbox has no gate script of its own, so its assertions live here.
# Self-contained: its own project and items, all destroyed here, so the
# delete/backup assertions below (which assume only P and P2 exist) stay valid.
#
# JSON is compared with `printf '%s'` into a file, never `echo "$var"` — zsh
# echo expands escapes and corrupts JSON carrying \n in a body.

# inbox_quiet_parity <full-file> <quiet-file> — the quiet item must be EXACTLY
# the full item minus `body`: every other key present and byte-equal.
inbox_quiet_parity() {
  jq -e --slurpfile q "$2" 'del(.body) == $q[0]' "$1" >/dev/null
}

run 0 "$MESA" project create "Quiet inbox" --no-git
PIQ=$(jqs .id)

# show: the reference parity case — same record read twice, so nothing volatile
# moves between the two calls.
run 0 "$MESA" inbox add --author agent-q "$BODY"
IQ=$(jqs .id)
run 0 "$MESA" inbox show "$IQ"
printf '%s' "$STDOUT" >"$TMP/ifull.json"
# non-quiet output is unchanged: the full 6-key inbox item
[ "$(jqs 'keys | join(",")')" = "author,body,created_at,id,project_id,updated_at" ] ||
  fail "inbox show (no --quiet): full key set must be unchanged"
[ "$(jqs 'has("body")')" = "true" ] || fail "inbox show (no --quiet): body present"
run 0 "$MESA" inbox show "$IQ" --quiet
printf '%s' "$STDOUT" >"$TMP/iquiet.json"
[ "$(jqs 'has("body")')" = "false" ] || fail "inbox show --quiet: body must be dropped"
inbox_quiet_parity "$TMP/ifull.json" "$TMP/iquiet.json" ||
  fail "inbox show --quiet: must be the full item minus body"
ok "inbox show --quiet: full item minus body, every other key equal"

# `get` is an alias for `show` and carries the same flag
run 0 "$MESA" inbox get "$IQ" --quiet
[ "$(jqs 'has("body")')" = "false" ] || fail "inbox get --quiet: body must be dropped"
[ "$(jqs .id)" = "$IQ" ] || fail "inbox get --quiet: id"
ok "inbox get --quiet: same shape as show"

# add: --quiet must precede the message (everything after `add` that is not a
# leading flag is swallowed as the body by trailing_var_arg).
run 0 "$MESA" inbox add --quiet --author agent-q "$BODY"
printf '%s' "$STDOUT" >"$TMP/iquiet.json"
IQ2=$(jqs .id)
[ "$(jqs 'has("body")')" = "false" ] || fail "inbox add --quiet: body must be dropped"
[ "$(jqs .author)" = "agent-q" ] || fail "inbox add --quiet: author"
[ "$(jqs .project_id)" = "null" ] || fail "inbox add --quiet: lands unassigned"
run 0 "$MESA" inbox show "$IQ2"
printf '%s' "$STDOUT" >"$TMP/ifull.json"
inbox_quiet_parity "$TMP/ifull.json" "$TMP/iquiet.json" ||
  fail "inbox add --quiet: must be the full item minus body"
ok "inbox add --quiet: item minus body, values intact"

# assign returns the created TASK, so its quiet shape is the compact task —
# not an inbox projection. The side effect (item converted and removed) is
# unchanged by the flag.
run 0 "$MESA" inbox assign "$IQ2" "$PIQ" --quiet
printf '%s' "$STDOUT" >"$TMP/iquiet.json"
IQT=$(jqs .id)
[ "$(jqs 'has("description")')" = "false" ] || fail "inbox assign --quiet: description must be dropped"
[ "$(jqs .status)" = "backlog" ] || fail "inbox assign --quiet: assigned items land in the backlog"
[ "$(jqs .project_id)" = "$PIQ" ] || fail "inbox assign --quiet: project_id"
[ "$(jqs 'has("blocked")')" = "true" ] || fail "inbox assign --quiet: blocked still present"
run 0 "$MESA" task show "$IQT"
printf '%s' "$STDOUT" >"$TMP/ifull.json"
quiet_is_full_minus_bodies "$TMP/ifull.json" "$TMP/iquiet.json" ||
  fail "inbox assign --quiet: must be the compact task (full minus the three dropped keys)"
run 1 "$MESA" inbox show "$IQ2"
[ "$(jqe .error.code)" = "not_found" ] || fail "inbox assign --quiet: item must still be consumed"
ok "inbox assign --quiet: compact task, item still converted and removed"

# delete: --quiet is an explicit opt-out of the full recovery transcript.
run 0 "$MESA" inbox add "$BODY"
IQ3=$(jqs .id)
run 0 "$MESA" inbox delete "$IQ3" --quiet
printf '%s' "$STDOUT" >"$TMP/iquiet.json"
[ "$(jqs 'has("body")')" = "false" ] || fail "inbox delete --quiet: body must be dropped"
[ "$(jqs .id)" = "$IQ3" ] || fail "inbox delete --quiet: destroyed item echoed"
run 1 "$MESA" inbox show "$IQ3"
[ "$(jqe .error.code)" = "not_found" ] || fail "inbox delete --quiet: item must still be gone"
ok "inbox delete --quiet: destroyed item minus body, still deleted"

# long form only: no -q alias
run 2 "$MESA" inbox show "$IQ" -q
ok "inbox show -q: exit 2 (no short alias)"

# --quiet does not exist outside the 4 subcommands in scope
run 2 "$MESA" inbox list --quiet
ok "inbox list --quiet: exit 2 (unknown argument)"

# every one of the 4 advertises the flag in --help
for SUB in add show assign delete; do
  run 0 "$MESA" inbox "$SUB" --help
  grep -q -- "--quiet" <<<"$STDOUT" || fail "inbox $SUB --help: must list --quiet"
done
ok "inbox add/show/assign/delete --help: --quiet listed"

# --quiet changes stdout only: exit code and the stderr payload are identical
run 1 "$MESA" inbox show 999999
printf '%s' "$STDERR" >"$TMP/ierr-full.txt"
run 1 "$MESA" inbox show 999999 --quiet
printf '%s' "$STDERR" >"$TMP/ierr-quiet.txt"
cmp -s "$TMP/ierr-full.txt" "$TMP/ierr-quiet.txt" ||
  fail "inbox show --quiet: stderr must be byte-identical on the error path"
ok "inbox error path: exit 1 and byte-identical stderr with and without --quiet"

run 0 "$MESA" inbox delete "$IQ"
run 0 "$MESA" project delete "$PIQ"

# ---- subprojects: parent_id, archive cascade, subtree delete (task 668) ----
run 0 "$MESA" project create "Parent" --no-git
SP=$(jqs .id)
[ "$(jqs .parent_id)" = "null" ] || fail "project create: default parent_id must be null"

# --parent takes an id...
run 0 "$MESA" project create "Child" --no-git --parent "$SP"
SC=$(jqs .id)
[ "$(jqs .parent_id)" = "$SP" ] || fail "project create --parent <id>: parent_id"
# ...or a name.
run 0 "$MESA" project create "Grandchild" --no-git --parent "Child"
SG=$(jqs .id)
[ "$(jqs .parent_id)" = "$SC" ] || fail "project create --parent <name>: parent_id"
ok "project create --parent: accepts an id or a name, nests 3 deep"

# `list` carries parent_id, and the array stays flat and in sort_order.
run 0 "$MESA" project list
[ "$(jqs 'map(select(.id == '"$SG"')) | .[0].parent_id')" = "$SC" ] ||
  fail "project list: rows must carry parent_id"
[ "$(jqs 'map(select(.id == '"$SP"' or .id == '"$SC"' or .id == '"$SG"')) | map(.id) | join(",")')" = "$SP,$SC,$SG" ] ||
  fail "project list: a new child must sort last among its siblings"
ok "project list: flat array carrying parent_id, child sorts last"

# reparent by name, then detach with the empty string
run 0 "$MESA" project update "$SG" --parent "Parent"
[ "$(jqs .parent_id)" = "$SP" ] || fail "project update --parent: reparent"
run 0 "$MESA" project update "Grandchild" --parent ""
[ "$(jqs .parent_id)" = "null" ] || fail 'project update --parent "": must detach'
run 0 "$MESA" project update "$SG" --parent "$SC"
ok "project update --parent: reparents by name and detaches on \"\""

# cycles are `cycle` (exit 1), an unknown parent `validation`, an ambiguous or
# missing name resolves through the shared project resolver.
run 1 "$MESA" project update "$SP" --parent "$SP"
[ "$(jqe .error.code)" = "cycle" ] || fail "self-parent: error.code must be cycle"
run 1 "$MESA" project update "$SP" --parent "$SG"
[ "$(jqe .error.code)" = "cycle" ] || fail "deep cycle: error.code must be cycle"
run 1 "$MESA" project update "$SP" --parent 999999
[ "$(jqe .error.code)" = "validation" ] || fail "unknown parent id: error.code"
run 1 "$MESA" project create "Orphan" --no-git --parent "no such project"
[ "$(jqe .error.code)" = "not_found" ] || fail "unknown parent name: error.code"
ok "project --parent: cycle/validation/not_found, exit 1"

# `parent_id` is bounded, so --quiet keeps it (only free text is dropped).
run 0 "$MESA" project show "$SC" --quiet
[ "$(jqs .parent_id)" = "$SP" ] || fail "project show --quiet: must keep parent_id"
[ "$(jqs 'has("description")')" = "false" ] || fail "project show --quiet: description dropped"
ok "project --quiet: keeps parent_id, drops description"

# archiving the parent hides the WHOLE subtree from unscoped reads...
run 0 "$MESA" task create "$SG" "grandchild work"
SGT=$(jqs .id)
run 0 "$MESA" project archive "$SP"
run 0 "$MESA" project list
[ "$(jqs "any(.[]; .id == $SC or .id == $SG)")" = "false" ] ||
  fail "archive cascade: descendants must vanish from project list"
run 0 "$MESA" task list
[ "$(jqs "any(.[]; .id == $SGT)")" = "false" ] ||
  fail "archive cascade: a descendant's tasks must vanish from unscoped task list"
# ...without writing a single descendant row...
run 0 "$MESA" project show "$SG"
[ "$(jqs .archived)" = "false" ] ||
  fail "archive cascade: a descendant's own archived flag must stay false"
# ...and every scoped read is unaffected.
run 0 "$MESA" task list --project "$SG"
[ "$(jqs 'length')" = "1" ] || fail "archive cascade: scoped read must be unaffected"
run 0 "$MESA" project list --include-archived
[ "$(jqs "any(.[]; .id == $SG)")" = "true" ] ||
  fail "archive cascade: --include-archived must still return everything"
run 0 "$MESA" project unarchive "$SP"
run 0 "$MESA" project list
[ "$(jqs "any(.[]; .id == $SG)")" = "true" ] ||
  fail "unarchive: one call must restore the subtree"
ok "archive cascades to descendants for unscoped reads only, no per-child write"

# deleting the parent destroys the subtree, and the echo carries every row
run 0 "$MESA" project delete "$SP"
[ "$(jqs .project.id)" = "$SP" ] || fail "subtree delete: root echoed"
[ "$(jqs '.subprojects | map(.id) | join(",")')" = "$SC,$SG" ] ||
  fail "subtree delete: subprojects echoed depth-first"
[ "$(jqs "any(.tasks[]; .id == $SGT)")" = "true" ] ||
  fail "subtree delete: a descendant's tasks must be echoed"
run 1 "$MESA" project show "$SG"
[ "$(jqe .error.code)" = "not_found" ] || fail "subtree delete: descendant must be gone"
ok "project delete: cascades the subtree and echoes every destroyed row"

# a leaf delete is unchanged apart from an empty `subprojects`
run 0 "$MESA" project create "Leaf" --no-git
SL=$(jqs .id)
run 0 "$MESA" project delete "$SL" --quiet
[ "$(jqs '.subprojects | length')" = "0" ] || fail "leaf delete: subprojects must be []"
[ "$(jqs 'has("project") and has("subprojects") and has("tasks")')" = "true" ] ||
  fail "delete --quiet: composite key structure must be unchanged"
[ "$(jqs '.project | has("description")')" = "false" ] ||
  fail "delete --quiet: members must be compacted"
ok "project delete --quiet: same keys, compacted members, empty subprojects on a leaf"

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
