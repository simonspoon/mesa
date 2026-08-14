#!/usr/bin/env bash
# Diagram CLI JSON-contract gate: exercises diagram/frame/edge end to end
# — create -> list -> frame(create/link/move) -> edge(create/cycle-ok/self-edge
# -reject) -> show(view) -> update -> delete(cascade echo) — against a throwaway
# MESA_DB. Asserts JSON shapes, the full-view show, delete echoes, and exit
# codes 0/1/2 with the right error.code.
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

jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- setup: two projects, one task in each ----
run 0 "$MESA" project create "Board project" --no-git
P=$(jqs .id)
run 0 "$MESA" project create "Other project" --no-git
P2=$(jqs .id)
run 0 "$MESA" task create --project "$P" --description "Linked task"
TASK=$(jqs .id)
run 0 "$MESA" task create --project "$P2" --description "Foreign task"
FTASK=$(jqs .id)

# ---- diagram create ----
run 0 "$MESA" diagram create --project "$P" --title "Onboarding" \
  --description "the happy path" --author agent-1
[ "$(jqs .title)" = "Onboarding" ] || fail "diagram create: title"
[ "$(jqs .description)" = "the happy path" ] || fail "diagram create: description"
[ "$(jqs .author)" = "agent-1" ] || fail "diagram create: author"
[ "$(jqs .project_id)" = "$P" ] || fail "diagram create: project_id"
[ "$(jqs .created_at)" != "null" ] || fail "diagram create: created_at present"
SB=$(jqs .id)
ok "diagram create: full object with author + timestamps"

# positional forms: create <PROJECT|DIAGRAM> <TITLE> ≡ flag forms
run 0 "$MESA" diagram create "$P" "Positional board"
[ "$(jqs .title)" = "Positional board" ] || fail "diagram create positional: title"
SBP=$(jqs .id)
run 0 "$MESA" diagram frame create "$SBP" "Pos frame A"
FP1=$(jqs .id)
[ "$(jqs .title)" = "Pos frame A" ] || fail "frame create positional: title"
run 0 "$MESA" diagram frame create "$SBP" "Pos frame B"
FP2=$(jqs .id)
run 0 "$MESA" diagram edge create "$SBP" "$FP1" "$FP2" --label then
[ "$(jqs .from_frame)" = "$FP1" ] || fail "edge create positional: from"
[ "$(jqs .to_frame)" = "$FP2" ] || fail "edge create positional: to"
run 2 "$MESA" diagram edge create "$SBP" "$FP1" "$FP2" --to "$FP2"
[ "$(jqe .error.code)" = "usage" ] || fail "edge positional+flag: code=usage"
run 0 "$MESA" diagram delete "$SBP"
ok "positional create forms: diagram/frame/edge; both forms is usage"

# unknown project is a validation error
run 1 "$MESA" diagram create --project 9999 --title "orphan"
[ "$(jqe .error.code)" = "validation" ] || fail "unknown project: error.code"
ok "diagram create unknown project: exit 1, code=validation"

# ---- diagram list (bare array, no frames/edges) ----
run 0 "$MESA" diagram create --project "$P" --title "Second board"
SB2=$(jqs .id)
run 0 "$MESA" diagram list --project "$P"
[ "$(jqs type)" = "array" ] || fail "list: bare array"
[ "$(jqs length)" = "2" ] || fail "list --project: expected 2"
[ "$(jqs 'any(.[]; has("frames"))')" = "false" ] || fail "list: must omit frames"
ok "diagram list --project: bare array, frames omitted"

# positional project form: list <PROJECT> ≡ --project; both is usage
run 0 "$MESA" diagram list "$P"
[ "$(jqs length)" = "2" ] || fail "list positional: expected 2"
run 2 "$MESA" diagram list "$P" --project "$P"
[ "$(jqe .error.code)" = "usage" ] || fail "list positional+flag: code=usage"
ok "diagram list: positional project ≡ --project; both is usage"

# ---- frames ----
run 0 "$MESA" diagram frame create --diagram "$SB" --title "Land on home" --author user
F1=$(jqs .id)
[ "$(jqs '.x == 40')" = "true" ] || fail "frame create: default x"
[ "$(jqs '.y == 40')" = "true" ] || fail "frame create: default y"
[ "$(jqs '.w == 240')" = "true" ] || fail "frame create: default w"
[ "$(jqs '.h == 140')" = "true" ] || fail "frame create: default h"
[ "$(jqs .diagram_id)" = "$SB" ] || fail "frame create: diagram_id"
ok "frame create: full object with default geometry"

run 0 "$MESA" diagram frame create --diagram "$SB" --title "Sign up" \
  --x 360 --y 60 --color '#ff2bd6' --task "$TASK"
F2=$(jqs .id)
[ "$(jqs '.x == 360')" = "true" ] || fail "frame create: explicit x"
[ "$(jqs .color)" = "#ff2bd6" ] || fail "frame create: color"
[ "$(jqs .task_id)" = "$TASK" ] || fail "frame create: same-project task link"
ok "frame create: explicit geometry, colour, same-project task link"

# cross-project task link rejected
run 1 "$MESA" diagram frame create --diagram "$SB" --title "Bad" --task "$FTASK"
[ "$(jqe .error.code)" = "validation" ] || fail "cross-project task: error.code"
ok "frame create cross-project task: exit 1, code=validation"

# unknown diagram rejected (validation, like a task's unknown project)
run 1 "$MESA" diagram frame create --diagram 9999 --title "Bad"
[ "$(jqe .error.code)" = "validation" ] || fail "unknown diagram: error.code"
ok "frame create unknown diagram: exit 1, code=validation"

# move a frame
run 0 "$MESA" diagram frame update "$F1" --x 120 --y 90 --author mover
[ "$(jqs '.x == 120')" = "true" ] || fail "frame update: x moved"
[ "$(jqs '.y == 90')" = "true" ] || fail "frame update: y moved"
ok "frame update: reposition"

# empty update is a usage error
run 2 "$MESA" diagram frame update "$F1"
[ "$(jqe .error.code)" = "usage" ] || fail "empty frame update: error.code"
ok "frame update no fields: exit 2, code=usage"

# unlink the task
run 0 "$MESA" diagram frame update "$F2" --no-task
[ "$(jqs .task_id)" = "null" ] || fail "frame update --no-task: must clear"
ok "frame update --no-task: clears the link"

# ---- edges ----
run 0 "$MESA" diagram edge create --diagram "$SB" --from "$F1" --to "$F2" \
  --label "then" --author user
E1=$(jqs .id)
[ "$(jqs .from_frame)" = "$F1" ] || fail "edge create: from_frame"
[ "$(jqs .to_frame)" = "$F2" ] || fail "edge create: to_frame"
[ "$(jqs .label)" = "then" ] || fail "edge create: label"
ok "edge create: full object"

# cycles are allowed (reverse edge accepted)
run 0 "$MESA" diagram edge create --diagram "$SB" --from "$F2" --to "$F1"
E2=$(jqs .id)
ok "edge create: reverse edge accepted (cycles allowed)"

# self-edge rejected
run 1 "$MESA" diagram edge create --diagram "$SB" --from "$F1" --to "$F1"
[ "$(jqe .error.code)" = "validation" ] || fail "self-edge: error.code"
ok "edge create self-edge: exit 1, code=validation"

# endpoint not on this board rejected
run 0 "$MESA" diagram frame create --diagram "$SB2" --title "Foreign frame"
FF=$(jqs .id)
run 1 "$MESA" diagram edge create --diagram "$SB" --from "$F1" --to "$FF"
[ "$(jqe .error.code)" = "validation" ] || fail "foreign frame edge: error.code"
ok "edge create foreign endpoint: exit 1, code=validation"

# relabel + clear
run 0 "$MESA" diagram edge update "$E1" --label "next"
[ "$(jqs .label)" = "next" ] || fail "edge update: relabel"
run 0 "$MESA" diagram edge update "$E1" --label ""
[ "$(jqs .label)" = "null" ] || fail "edge update --label \"\": must clear"
ok "edge update: relabel and clear"

# ---- show (full view) ----
run 0 "$MESA" diagram show "$SB"
[ "$(jqs .diagram.id)" = "$SB" ] || fail "show: diagram echoed"
[ "$(jqs '.frames | length')" = "2" ] || fail "show: 2 frames"
[ "$(jqs '.edges | length')" = "2" ] || fail "show: 2 edges"
[ "$(jqs '.frames | map(.id) == (sort_by(.id) | map(.id))')" = "true" ] ||
  fail "show: frames ordered by id"
ok "diagram show: full {diagram, frames, edges} view"

# unknown diagram show is not_found
run 1 "$MESA" diagram show 9999
[ "$(jqe .error.code)" = "not_found" ] || fail "show unknown: error.code"
ok "diagram show unknown id: exit 1, code=not_found"

# ---- diagram update ----
run 0 "$MESA" diagram update "$SB" --title "Onboarding v2" --description ""
[ "$(jqs .title)" = "Onboarding v2" ] || fail "diagram update: title"
[ "$(jqs .description)" = "null" ] || fail "diagram update: --description \"\" clears"
[ "$(jqs .author)" = "agent-1" ] || fail "diagram update: author immutable"
ok "diagram update: title set, description cleared, author immutable"

# ---- change history (who / what / when) ----
run 0 "$MESA" diagram events "$SB"
[ "$(jqs type)" = "array" ] || fail "events: bare array"
[ "$(jqs '.[0].action')" = "diagram_created" ] || fail "events: first is creation"
[ "$(jqs '.[0].actor')" = "agent-1" ] || fail "events: creation attributed to agent-1"
[ "$(jqs 'any(.[]; .action == "frame_added")')" = "true" ] || fail "events: frame_added logged"
[ "$(jqs 'any(.[]; .action == "edge_added")')" = "true" ] || fail "events: edge_added logged"
[ "$(jqs 'any(.[]; .action == "frame_moved" and .actor == "mover")')" = "true" ] ||
  fail "events: frame_moved attributed to mover"
[ "$(jqs 'any(.[]; .action == "edge_relabeled")')" = "true" ] || fail "events: edge_relabeled logged"
# every row carries the who/what/when fields, oldest first
[ "$(jqs 'all(.[]; has("actor") and (.action|length>0) and (.summary|length>0) and (.at|length>0))')" = "true" ] ||
  fail "events: each row has actor/action/summary/at"
[ "$(jqs 'map(.id) == (sort_by(.id) | map(.id))')" = "true" ] || fail "events: ordered oldest-first"
ok "diagram events: change history with attribution, oldest first"

# unknown board's history is not_found
run 1 "$MESA" diagram events 9999
[ "$(jqe .error.code)" = "not_found" ] || fail "events unknown board: error.code"
ok "diagram events unknown board: exit 1, code=not_found"

# ---- delete frame (echo frame + cascaded edges) ----
run 0 "$MESA" diagram frame delete "$F1" --author remover
[ "$(jqs .frame.id)" = "$F1" ] || fail "frame delete: frame echoed"
[ "$(jqs '.edges | length')" = "2" ] || fail "frame delete: cascaded edges echoed"
ok "frame delete: echoes {frame, edges}; touching edges cascade"

run 0 "$MESA" diagram events "$SB"
[ "$(jqs 'any(.[]; .action == "frame_removed" and .actor == "remover")')" = "true" ] ||
  fail "events: frame_removed attributed to remover"
ok "frame delete logged in history with attribution"

# the board now has one frame and no edges
run 0 "$MESA" diagram show "$SB"
[ "$(jqs '.frames | length')" = "1" ] || fail "after frame delete: 1 frame"
[ "$(jqs '.edges | length')" = "0" ] || fail "after frame delete: 0 edges"
ok "frame delete cascaded its edges"

# ---- delete edge echo ----
run 0 "$MESA" diagram frame create --diagram "$SB2" --title "Frame B"
FB=$(jqs .id)
run 0 "$MESA" diagram edge create --diagram "$SB2" --from "$FF" --to "$FB"
E3=$(jqs .id)
run 0 "$MESA" diagram edge delete "$E3"
[ "$(jqs .id)" = "$E3" ] || fail "edge delete: echoes destroyed edge"
ok "edge delete: echoes the destroyed edge"

# ---- delete diagram (cascade echo) ----
run 0 "$MESA" diagram delete "$SB"
[ "$(jqs .diagram.id)" = "$SB" ] || fail "diagram delete: diagram echoed"
[ "$(jqs '.frames | length')" = "1" ] || fail "diagram delete: frames echoed"
ok "diagram delete: echoes full destroyed view (cascade)"

run 1 "$MESA" diagram show "$SB"
[ "$(jqe .error.code)" = "not_found" ] || fail "deleted diagram: error.code"
ok "deleted diagram is gone: exit 1, code=not_found"

# deleting the project cascades the remaining board away
run 0 "$MESA" project delete "$P"
run 0 "$MESA" diagram list --project "$P"
[ "$(jqs length)" = "0" ] || fail "project delete: diagrams must cascade"
ok "project delete cascades its diagrams"

# ---- usage errors ----
run 2 "$MESA" diagram create "no project flag"
[ "$(jqe .error.code)" = "usage" ] || fail "missing --project: error.code"
ok "diagram create without --project: exit 2, code=usage"

# ---- diagram_type + shape (mesa task 357) ----
# $P was deleted above (project delete cascade check); use a fresh project.
run 0 "$MESA" project create "Diagram types project" --no-git
DP=$(jqs .id)

run 0 "$MESA" diagram create --project "$DP" --title "Untyped board"
[ "$(jqs .diagram_type)" = "storyboard" ] || fail "diagram create: default diagram_type"
ok "diagram create: diagram_type defaults to storyboard"

run 0 "$MESA" diagram create --project "$DP" --title "Flow" --type flowchart
FLOW=$(jqs .id)
[ "$(jqs .diagram_type)" = "flowchart" ] || fail "diagram create --type: diagram_type"
ok "diagram create --type flowchart: diagram_type echoed"

run 2 "$MESA" diagram create --project "$DP" --title "Bad type" --type bogus
[ "$(jqe .error.code)" = "usage" ] || fail "invalid --type: error.code"
ok "diagram create --type bogus: exit 2, code=usage"

run 0 "$MESA" diagram frame create --diagram "$FLOW" --title "Decide" --shape decision
DECIDE=$(jqs .id)
[ "$(jqs .shape)" = "decision" ] || fail "frame create --shape: shape echoed"
ok "frame create --shape decision: shape echoed"

run 1 "$MESA" diagram frame create --diagram "$FLOW" --title "Bad shape" --shape entity
[ "$(jqe .error.code)" = "validation" ] || fail "shape wrong for board type: error.code"
ok "frame create --shape entity on a flowchart board: exit 1, code=validation"

run 2 "$MESA" diagram frame create --diagram "$FLOW" --title "Bad value" --shape bogus
[ "$(jqe .error.code)" = "usage" ] || fail "invalid --shape: error.code"
ok "frame create --shape bogus: exit 2, code=usage"

# diagram_type/shape are creation-only: no --type/--shape flag exists on the
# update subcommands, so passing one is a clap usage error, not validation.
run 2 "$MESA" diagram update "$FLOW" --type storyboard
[ "$(jqe .error.code)" = "usage" ] || fail "--type on diagram update: error.code"
ok "diagram update --type: exit 2, code=usage (no such flag; immutable)"

run 2 "$MESA" diagram frame update "$DECIDE" --shape process
[ "$(jqe .error.code)" = "usage" ] || fail "--shape on frame update: error.code"
ok "frame update --shape: exit 2, code=usage (no such flag; immutable)"

# ---- --quiet on the diagram/frame/edge group (spec 644) ----
# Self-contained: its own project, created and deleted here. Quiet output is
# compared through files written with `printf '%s'`, never `echo "$var"` —
# echo expands escapes and corrupts JSON carrying \n in a description/body.
#
# The contract under test: --quiet drops ONLY the unbounded free text
# (Diagram.description, Frame.body; a FrameEdge has none, so quiet == full),
# and the {diagram, frames, edges} / {frame, edges} composites keep their
# container keys while compacting their members.

# minus_ok <label> <full-file> <quiet-file> <key...> — the quiet record must be
# EXACTLY the full record minus the named keys: every other key present AND
# byte-equal. With no keys, quiet must equal full outright.
minus_ok() {
  local label=$1 full=$2 q=$3; shift 3
  local filter="." k
  for k in "$@"; do filter="$filter | del(.$k)"; done
  jq -e --slurpfile q "$q" "$filter == \$q[0]" "$full" >/dev/null ||
    fail "$label: quiet output must be the full record minus [$*]"
}

# capture <file> — write the last run's stdout verbatim.
capture() { printf '%s' "$STDOUT" >"$1"; }

run 0 "$MESA" project create "Quiet board project" --no-git
QP=$(jqs .id)

QBODY="line one
line two"

# ---- diagram create ----
run 0 "$MESA" diagram create "$QP" "Quiet board" --description "$QBODY" --author agent-q
QSB=$(jqs .id)
[ "$(jqs 'has("description")')" = "true" ] ||
  fail "diagram create (no --quiet): description must be present"

run 0 "$MESA" diagram create "$QP" "Quiet board 2" --description "$QBODY" --quiet
QSB2=$(jqs .id)
[ "$(jqs 'has("description")')" = "false" ] ||
  fail "diagram create --quiet: description must be dropped"
capture "$TMP/sb2-quiet.json"
# parity against the same record read back in full (a read, so nothing moves)
run 0 "$MESA" diagram show "$QSB2"
capture "$TMP/sb2-view.json"
jq '.diagram' "$TMP/sb2-view.json" >"$TMP/sb2-full.json"
minus_ok "diagram create --quiet" "$TMP/sb2-full.json" "$TMP/sb2-quiet.json" description
ok "diagram create --quiet: description dropped, every other key present and equal"

run 0 "$MESA" diagram delete "$QSB2"

# frames + edges on the main board so the composites are non-empty
run 0 "$MESA" diagram frame create "$QSB" "Quiet frame A" --body "$QBODY"
QF1=$(jqs .id)
[ "$(jqs 'has("body")')" = "true" ] || fail "frame create (no --quiet): body must be present"

run 0 "$MESA" diagram frame create "$QSB" "Quiet frame B" --body "$QBODY" --x 400 --quiet
QF2=$(jqs .id)
[ "$(jqs 'has("body")')" = "false" ] || fail "frame create --quiet: body must be dropped"
[ "$(jqs .title)" = "Quiet frame B" ] || fail "frame create --quiet: title"
capture "$TMP/f2-quiet.json"

run 0 "$MESA" diagram edge create "$QSB" "$QF1" "$QF2" --label then
QE1=$(jqs .id)

# ---- diagram show: composite keys identical, members compacted (M7) ----
run 0 "$MESA" diagram show "$QSB"
capture "$TMP/view-full.json"
run 0 "$MESA" diagram show "$QSB" --quiet
capture "$TMP/view-quiet.json"
jq -e --slurpfile q "$TMP/view-quiet.json" '
  (keys == ($q[0] | keys))
  and ((.diagram | del(.description)) == $q[0].diagram)
  and ((.frames | map(del(.body))) == $q[0].frames)
  and (.edges == $q[0].edges)
' "$TMP/view-full.json" >/dev/null ||
  fail "diagram show --quiet: same keys, members = full minus description/body"
[ "$(jqs '.diagram | has("description")')" = "false" ] ||
  fail "diagram show --quiet: diagram.description must be dropped"
[ "$(jqs 'any(.frames[]; has("body"))')" = "false" ] ||
  fail "diagram show --quiet: frame bodies must be dropped"
[ "$(jqs '.frames | length')" = "2" ] || fail "diagram show --quiet: 2 frames"
[ "$(jqs '.edges | length')" = "1" ] || fail "diagram show --quiet: 1 edge"
ok "diagram show --quiet: {diagram, frames, edges} keys unchanged, members compacted"

# ---- frame create/update --quiet parity against the board view ----
jq --argjson id "$QF2" '.frames[] | select(.id == $id)' "$TMP/view-full.json" \
  >"$TMP/f2-full.json"
minus_ok "frame create --quiet" "$TMP/f2-full.json" "$TMP/f2-quiet.json" body

run 0 "$MESA" diagram frame update "$QF1" --x 120 --y 90 --quiet
[ "$(jqs 'has("body")')" = "false" ] || fail "frame update --quiet: body must be dropped"
[ "$(jqs '.x == 120')" = "true" ] || fail "frame update --quiet: x moved"
capture "$TMP/f1-upd-quiet.json"
run 0 "$MESA" diagram show "$QSB"
capture "$TMP/view-after.json"
jq --argjson id "$QF1" '.frames[] | select(.id == $id)' "$TMP/view-after.json" \
  >"$TMP/f1-upd-full.json"
minus_ok "frame update --quiet" "$TMP/f1-upd-full.json" "$TMP/f1-upd-quiet.json" body
ok "frame create/update --quiet: body dropped, every other key present and equal"

# ---- edges: no unbounded field, so --quiet output EQUALS full output ----
run 0 "$MESA" diagram edge update "$QE1" --label "next"
capture "$TMP/e1-upd-full.json"
run 0 "$MESA" diagram edge update "$QE1" --label "next" --quiet
capture "$TMP/e1-upd-quiet.json"
cmp -s "$TMP/e1-upd-full.json" "$TMP/e1-upd-quiet.json" ||
  fail "edge update --quiet: stdout must be byte-identical to the non-quiet form"
minus_ok "edge update --quiet" "$TMP/e1-upd-full.json" "$TMP/e1-upd-quiet.json"
[ "$(jqs .label)" = "next" ] || fail "edge update --quiet: label"
ok "edge update --quiet: byte-identical to the full output (an edge has no free text)"

run 0 "$MESA" diagram edge create "$QSB" "$QF2" "$QF1" --quiet
QE2=$(jqs .id)
[ "$(jqs .from_frame)" = "$QF2" ] || fail "edge create --quiet: from_frame"
[ "$(jqs 'has("label")')" = "true" ] || fail "edge create --quiet: full edge still echoed"
run 0 "$MESA" diagram edge delete "$QE2" --quiet
[ "$(jqs .id)" = "$QE2" ] || fail "edge delete --quiet: echoes the destroyed edge"
[ "$(jqs 'has("to_frame")')" = "true" ] || fail "edge delete --quiet: full edge still echoed"
ok "edge create/delete --quiet: accepted, full record still echoed"

# ---- frame delete composite: {frame, edges} keys kept, frame body dropped ----
run 0 "$MESA" diagram frame create "$QSB" "Doomed full" --body "$QBODY"
QFD1=$(jqs .id)
run 0 "$MESA" diagram edge create "$QSB" "$QF1" "$QFD1"
run 0 "$MESA" diagram frame delete "$QFD1"
capture "$TMP/fdel-full.json"
[ "$(jqs '.frame | has("body")')" = "true" ] ||
  fail "frame delete (no --quiet): frame.body must be present"
[ "$(jqs '.edges | length')" = "1" ] || fail "frame delete: cascaded edge echoed"

run 0 "$MESA" diagram frame create "$QSB" "Doomed quiet" --body "$QBODY"
QFD2=$(jqs .id)
run 0 "$MESA" diagram edge create "$QSB" "$QF1" "$QFD2"
run 0 "$MESA" diagram frame delete "$QFD2" --quiet
capture "$TMP/fdel-quiet.json"
# the two deletes destroy different frames, so ids differ — compare key SETS:
# the container keys and the echoed edge must be identical, and the frame must
# differ by exactly `body`.
jq -e --slurpfile q "$TMP/fdel-quiet.json" '
  (keys == ($q[0] | keys))
  and ((.frame | keys) - ["body"] == ($q[0].frame | keys))
  and ((.edges[0] | keys) == ($q[0].edges[0] | keys))
' "$TMP/fdel-full.json" >/dev/null ||
  fail "frame delete --quiet: {frame, edges} keys kept, frame minus body, edges full"
[ "$(jqs '.frame | has("body")')" = "false" ] ||
  fail "frame delete --quiet: frame.body must be dropped"
[ "$(jqs '.frame.id')" = "$QFD2" ] || fail "frame delete --quiet: frame echoed"
[ "$(jqs '.edges | length')" = "1" ] || fail "frame delete --quiet: cascaded edge echoed"
ok "frame delete --quiet: {frame, edges} keys kept, frame body dropped, edges full"

# ---- diagram update / delete ----
run 0 "$MESA" diagram update "$QSB" --title "Quiet board v2" --quiet
[ "$(jqs 'has("description")')" = "false" ] ||
  fail "diagram update --quiet: description must be dropped"
[ "$(jqs .title)" = "Quiet board v2" ] || fail "diagram update --quiet: title"
capture "$TMP/sb-upd-quiet.json"
run 0 "$MESA" diagram show "$QSB"
capture "$TMP/view-upd.json"
jq '.diagram' "$TMP/view-upd.json" >"$TMP/sb-upd-full.json"
minus_ok "diagram update --quiet" "$TMP/sb-upd-full.json" "$TMP/sb-upd-quiet.json" description

# delete echoes the destroyed view; --quiet waives the full recovery transcript
run 0 "$MESA" diagram delete "$QSB" --quiet
capture "$TMP/sbdel-quiet.json"
jq -e --slurpfile q "$TMP/sbdel-quiet.json" 'keys == ($q[0] | keys)' \
  "$TMP/view-upd.json" >/dev/null ||
  fail "diagram delete --quiet: container keys must stay {diagram, frames, edges}"
[ "$(jqs '.diagram.id')" = "$QSB" ] || fail "diagram delete --quiet: diagram echoed"
[ "$(jqs '.diagram | has("description")')" = "false" ] ||
  fail "diagram delete --quiet: description must be dropped"
[ "$(jqs 'any(.frames[]; has("body"))')" = "false" ] ||
  fail "diagram delete --quiet: frame bodies must be dropped"
ok "diagram update/delete --quiet: compact members, container keys unchanged"

# ---- flag surface (M2/M3) ----
run 0 "$MESA" diagram create "$QP" "Surface board"
SSB=$(jqs .id)
run 0 "$MESA" diagram frame create "$SSB" "Surface frame A"
SF1=$(jqs .id)
run 0 "$MESA" diagram frame create "$SSB" "Surface frame B" --x 400
SF2=$(jqs .id)
run 0 "$MESA" diagram edge create "$SSB" "$SF1" "$SF2"
SE=$(jqs .id)

# --quiet is a modifier, not a field: alone on an update it must be a loud usage
# error, so a batch caller fails on item one instead of silently no-opping.
for TARGET in "diagram update $SSB" "diagram frame update $SF1" \
  "diagram edge update $SE"; do
  # shellcheck disable=SC2086
  run 2 "$MESA" $TARGET --quiet
  [ -z "$STDOUT" ] || fail "$TARGET --quiet alone: stdout must be empty"
  [ "$(jqe .error.code)" = "usage" ] || fail "$TARGET --quiet alone: code=usage"
done
ok "diagram/frame/edge update --quiet with no field flag: exit 2, code=usage"

run 2 "$MESA" diagram show "$SSB" -q
ok "diagram show -q: exit 2 (long form only, no short alias)"

run 2 "$MESA" diagram list --quiet
run 2 "$MESA" diagram events "$SSB" --quiet
ok "diagram list/events --quiet: exit 2 (unknown argument; out of scope)"

# all 10 in-scope subcommands advertise the flag
while read -r SUB; do
  # shellcheck disable=SC2086
  run 0 "$MESA" $SUB --help
  grep -q -- "--quiet" <<<"$STDOUT" || fail "mesa $SUB --help: must list --quiet"
done <<'SUBS'
diagram create
diagram show
diagram update
diagram delete
diagram frame create
diagram frame update
diagram frame delete
diagram edge create
diagram edge update
diagram edge delete
SUBS
ok "all 10 diagram/frame/edge subcommands list --quiet in --help"

# --quiet changes stdout only: exit code and stderr payload are untouched
run 1 "$MESA" diagram show 9999
printf '%s' "$STDERR" >"$TMP/err-full.txt"
run 1 "$MESA" diagram show 9999 --quiet
printf '%s' "$STDERR" >"$TMP/err-quiet.txt"
cmp -s "$TMP/err-full.txt" "$TMP/err-quiet.txt" ||
  fail "diagram show --quiet: stderr must be byte-identical on the error path"
ok "error path: exit 1 and byte-identical stderr with and without --quiet"

run 0 "$MESA" project delete "$QP"

# ---- shapes + connector properties (mesa task 854) ----
# `mesa diagram types` is the discovery command: it must state EXACTLY what
# `frame create --shape` and `edge create --*-marker` accept per board type, so
# the whole matrix below is driven off its output rather than a copy of the
# value sets. A listed value must create; an unlisted one must be rejected.

run 2 "$MESA" diagram types --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "diagram types --quiet: code=usage"
ok "diagram types --quiet: exit 2 (a read command, out of scope)"

run 0 "$MESA" diagram types
capture "$TMP/types.json"
[ "$(jqs type)" = "array" ] || fail "diagram types: bare array"
[ "$(jqs 'all(.[]; has("type") and has("shapes") and has("generic_frame")
        and has("edge_styles") and has("edge_markers"))')" = "true" ] ||
  fail "diagram types: every row must carry all five keys"
[ "$(jqs 'map(select(.type == "erd")) | .[0].edge_markers | index("crows_foot") != null')" = "true" ] ||
  fail "diagram types: erd must list the cardinality markers"
[ "$(jqs 'map(select(.type != "erd")) | all(.[]; .edge_markers | index("crows_foot") == null)')" = "true" ] ||
  fail "diagram types: only erd may list the cardinality markers"
ok "diagram types: one row per type, cardinality markers on erd alone"

ALL_SHAPES=$(jq -r '[.[].shapes[]] | unique | .[]' "$TMP/types.json")
ALL_MARKERS=$(jq -r '[.[].edge_markers[]] | unique | .[]' "$TMP/types.json")

run 0 "$MESA" project create "Shape matrix project" --no-git
MP=$(jqs .id)

for T in $(jq -r '.[].type' "$TMP/types.json"); do
  LISTED_SHAPES=$(jq -r --arg t "$T" '.[] | select(.type == $t) | .shapes[]' "$TMP/types.json")
  LISTED_MARKERS=$(jq -r --arg t "$T" '.[] | select(.type == $t) | .edge_markers[]' "$TMP/types.json")
  GENERIC=$(jq -r --arg t "$T" '.[] | select(.type == $t) | .generic_frame' "$TMP/types.json")
  FIRST_SHAPE=$(head -n1 <<<"$LISTED_SHAPES")

  run 0 "$MESA" diagram create "$MP" "Board $T" --type "$T"
  MB=$(jqs .id)

  # the generic card (no --shape at all) exactly where `generic_frame` says
  if [ "$GENERIC" = "true" ]; then
    run 0 "$MESA" diagram frame create "$MB" "generic"
    [ "$(jqs .shape)" = "null" ] || fail "$T: omitted --shape must store null"
  else
    run 1 "$MESA" diagram frame create "$MB" "generic"
    [ "$(jqe .error.code)" = "validation" ] || fail "$T: omitted --shape must be validation"
  fi

  for S in $ALL_SHAPES; do
    if grep -qx "$S" <<<"$LISTED_SHAPES"; then
      run 0 "$MESA" diagram frame create "$MB" "f-$S" --shape "$S"
      [ "$(jqs .shape)" = "$S" ] || fail "$T/--shape $S: shape echoed"
    else
      run 1 "$MESA" diagram frame create "$MB" "f-$S" --shape "$S"
      [ "$(jqe .error.code)" = "validation" ] || fail "$T/--shape $S: code=validation"
    fi
  done

  # two frames to hang connectors off, shaped however this board demands
  if [ "$GENERIC" = "true" ]; then
    run 0 "$MESA" diagram frame create "$MB" "edge A"
  else
    run 0 "$MESA" diagram frame create "$MB" "edge A" --shape "$FIRST_SHAPE"
  fi
  MA=$(jqs .id)
  if [ "$GENERIC" = "true" ]; then
    run 0 "$MESA" diagram frame create "$MB" "edge B" --x 400
  else
    run 0 "$MESA" diagram frame create "$MB" "edge B" --x 400 --shape "$FIRST_SHAPE"
  fi
  MBB=$(jqs .id)

  for M in $ALL_MARKERS; do
    if grep -qx "$M" <<<"$LISTED_MARKERS"; then
      run 0 "$MESA" diagram edge create "$MB" "$MA" "$MBB" --to-marker "$M"
      [ "$(jqs .to_marker)" = "$M" ] || fail "$T/--to-marker $M: marker echoed"
    else
      run 1 "$MESA" diagram edge create "$MB" "$MA" "$MBB" --to-marker "$M"
      [ "$(jqe .error.code)" = "validation" ] || fail "$T/--to-marker $M: code=validation"
      [ "$(jqe .error.message)" = "marker '$M' is not valid for a $T board" ] ||
        fail "$T/--to-marker $M: message"
    fi
  done
done
ok "diagram types: every listed shape/marker creates, every unlisted one is validation"

run 2 "$MESA" diagram frame create "$MB" "bad" --shape bogus
[ "$(jqe .error.code)" = "usage" ] || fail "unknown --shape literal: code=usage"
run 2 "$MESA" diagram edge create "$MB" "$MA" "$MBB" --to-marker bogus
[ "$(jqe .error.code)" = "usage" ] || fail "unknown --to-marker literal: code=usage"
run 2 "$MESA" diagram edge create "$MB" "$MA" "$MBB" --style bogus
[ "$(jqe .error.code)" = "usage" ] || fail "unknown --style literal: code=usage"
ok "unknown shape/marker/style literals: exit 2, code=usage (never reach Store)"

# ---- style + markers on one connector, created and patched ----
run 0 "$MESA" diagram create "$MP" "Connector board" --type flowchart
CB=$(jqs .id)
run 0 "$MESA" diagram frame create "$CB" "Start" --shape start_end
CF1=$(jqs .id)
run 0 "$MESA" diagram frame create "$CB" "Store it" --shape database --x 400
CF2=$(jqs .id)

run 0 "$MESA" diagram edge create "$CB" "$CF1" "$CF2" \
  --style dashed --from-marker circle --to-marker hollow_arrow --author agent-1
CE=$(jqs .id)
[ "$(jqs .style)" = "dashed" ] || fail "edge create --style"
[ "$(jqs .from_marker)" = "circle" ] || fail "edge create --from-marker"
[ "$(jqs .to_marker)" = "hollow_arrow" ] || fail "edge create --to-marker"
ok "edge create --style/--from-marker/--to-marker: all three echoed"

# an untouched edge keeps the default rendering: all three null
run 0 "$MESA" diagram edge create "$CB" "$CF2" "$CF1"
[ "$(jqs '.style == null and .from_marker == null and .to_marker == null')" = "true" ] ||
  fail "edge create without the flags: all three must be null (today's rendering)"
ok "edge create without the new flags: style/markers null (unchanged rendering)"

run 0 "$MESA" diagram edge update "$CE" --style dotted --to-marker diamond
[ "$(jqs .style)" = "dotted" ] || fail "edge update --style"
[ "$(jqs .to_marker)" = "diamond" ] || fail "edge update --to-marker"
[ "$(jqs .from_marker)" = "circle" ] || fail "edge update: an omitted field is untouched"
ok "edge update --style/--to-marker: set; omitted fields untouched"

run 0 "$MESA" diagram edge update "$CE" --style "" --from-marker "" --to-marker ""
[ "$(jqs '.style == null and .from_marker == null and .to_marker == null')" = "true" ] ||
  fail 'edge update --style "": must clear all three back to the default'
ok 'edge update --style ""/--from-marker ""/--to-marker "": clears back to the default'

run 2 "$MESA" diagram edge update "$CE" --style bogus
[ "$(jqe .error.code)" = "usage" ] || fail "edge update --style bogus: code=usage"
ok "edge update --style bogus: exit 2, code=usage"

# the erd-only family is rejected on this flowchart board, at both verbs
run 1 "$MESA" diagram edge create "$CB" "$CF1" "$CF2" --to-marker crows_foot
[ "$(jqe .error.code)" = "validation" ] || fail "crows_foot on flowchart create: code"
run 1 "$MESA" diagram edge update "$CE" --to-marker one_or_many
[ "$(jqe .error.code)" = "validation" ] || fail "one_or_many on flowchart update: code"
[ "$(jqe .error.message)" = "marker 'one_or_many' is not valid for a flowchart board" ] ||
  fail "erd-only marker on a flowchart: message"
ok "erd-only markers on a flowchart board: exit 1, code=validation (create and update)"

# ...and accepted on an erd board
run 0 "$MESA" diagram create "$MP" "Schema" --type erd
EB=$(jqs .id)
run 0 "$MESA" diagram frame create "$EB" "orders" --shape entity
EF1=$(jqs .id)
run 0 "$MESA" diagram frame create "$EB" "line_items" --shape weak_entity --x 400
EF2=$(jqs .id)
run 0 "$MESA" diagram edge create "$EB" "$EF1" "$EF2" --from-marker one --to-marker crows_foot
[ "$(jqs .from_marker)" = "one" ] || fail "erd board: --from-marker one"
[ "$(jqs .to_marker)" = "crows_foot" ] || fail "erd board: --to-marker crows_foot"
ok "cardinality markers on an erd board: accepted"

# ---- the restyle event ----
run 0 "$MESA" diagram events "$CB"
[ "$(jqs 'any(.[]; .action == "edge_restyled")')" = "true" ] ||
  fail "events: edge_restyled must be logged"
[ "$(jqs '[.[] | select(.action == "edge_restyled")] | length')" = "2" ] ||
  fail "events: one edge_restyled per landing patch (set, then clear)"
[ "$(jqs '[.[] | select(.action == "edge_restyled")] | .[-1].summary | contains("style: default")')" = "true" ] ||
  fail "events: the clearing patch's summary names the default"
ok "diagram events: edge_restyled logged once per landing style/marker patch"

# a patch that re-asserts what is stored logs nothing
run 0 "$MESA" diagram events "$CB"
BEFORE=$(jqs length)
run 0 "$MESA" diagram edge update "$CE" --style ""
run 0 "$MESA" diagram events "$CB"
[ "$(jqs length)" = "$BEFORE" ] || fail "no-op restyle patch must log no event"
ok "no-op style patch: no event appended"

run 0 "$MESA" project delete "$MP"

echo "all $CHECKS checks passed"
