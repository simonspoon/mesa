#!/usr/bin/env bash
# Storyboard CLI JSON-contract gate: exercises storyboard/frame/edge end to end
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
run 0 "$MESA" task create --project "$P" --title "Linked task"
TASK=$(jqs .id)
run 0 "$MESA" task create --project "$P2" --title "Foreign task"
FTASK=$(jqs .id)

# ---- storyboard create ----
run 0 "$MESA" storyboard create --project "$P" --title "Onboarding" \
  --description "the happy path" --author agent-1
[ "$(jqs .title)" = "Onboarding" ] || fail "storyboard create: title"
[ "$(jqs .description)" = "the happy path" ] || fail "storyboard create: description"
[ "$(jqs .author)" = "agent-1" ] || fail "storyboard create: author"
[ "$(jqs .project_id)" = "$P" ] || fail "storyboard create: project_id"
[ "$(jqs .created_at)" != "null" ] || fail "storyboard create: created_at present"
SB=$(jqs .id)
ok "storyboard create: full object with author + timestamps"

# positional forms: create <PROJECT|STORYBOARD> <TITLE> ≡ flag forms
run 0 "$MESA" storyboard create "$P" "Positional board"
[ "$(jqs .title)" = "Positional board" ] || fail "storyboard create positional: title"
SBP=$(jqs .id)
run 0 "$MESA" storyboard frame create "$SBP" "Pos frame A"
FP1=$(jqs .id)
[ "$(jqs .title)" = "Pos frame A" ] || fail "frame create positional: title"
run 0 "$MESA" storyboard frame create "$SBP" "Pos frame B"
FP2=$(jqs .id)
run 0 "$MESA" storyboard edge create "$SBP" "$FP1" "$FP2" --label then
[ "$(jqs .from_frame)" = "$FP1" ] || fail "edge create positional: from"
[ "$(jqs .to_frame)" = "$FP2" ] || fail "edge create positional: to"
run 2 "$MESA" storyboard edge create "$SBP" "$FP1" "$FP2" --to "$FP2"
[ "$(jqe .error.code)" = "usage" ] || fail "edge positional+flag: code=usage"
run 0 "$MESA" storyboard delete "$SBP"
ok "positional create forms: storyboard/frame/edge; both forms is usage"

# unknown project is a validation error
run 1 "$MESA" storyboard create --project 9999 --title "orphan"
[ "$(jqe .error.code)" = "validation" ] || fail "unknown project: error.code"
ok "storyboard create unknown project: exit 1, code=validation"

# ---- storyboard list (bare array, no frames/edges) ----
run 0 "$MESA" storyboard create --project "$P" --title "Second board"
SB2=$(jqs .id)
run 0 "$MESA" storyboard list --project "$P"
[ "$(jqs type)" = "array" ] || fail "list: bare array"
[ "$(jqs length)" = "2" ] || fail "list --project: expected 2"
[ "$(jqs 'any(.[]; has("frames"))')" = "false" ] || fail "list: must omit frames"
ok "storyboard list --project: bare array, frames omitted"

# positional project form: list <PROJECT> ≡ --project; both is usage
run 0 "$MESA" storyboard list "$P"
[ "$(jqs length)" = "2" ] || fail "list positional: expected 2"
run 2 "$MESA" storyboard list "$P" --project "$P"
[ "$(jqe .error.code)" = "usage" ] || fail "list positional+flag: code=usage"
ok "storyboard list: positional project ≡ --project; both is usage"

# ---- frames ----
run 0 "$MESA" storyboard frame create --storyboard "$SB" --title "Land on home" --author user
F1=$(jqs .id)
[ "$(jqs '.x == 40')" = "true" ] || fail "frame create: default x"
[ "$(jqs '.y == 40')" = "true" ] || fail "frame create: default y"
[ "$(jqs '.w == 240')" = "true" ] || fail "frame create: default w"
[ "$(jqs '.h == 140')" = "true" ] || fail "frame create: default h"
[ "$(jqs .storyboard_id)" = "$SB" ] || fail "frame create: storyboard_id"
ok "frame create: full object with default geometry"

run 0 "$MESA" storyboard frame create --storyboard "$SB" --title "Sign up" \
  --x 360 --y 60 --color '#ff2bd6' --task "$TASK"
F2=$(jqs .id)
[ "$(jqs '.x == 360')" = "true" ] || fail "frame create: explicit x"
[ "$(jqs .color)" = "#ff2bd6" ] || fail "frame create: color"
[ "$(jqs .task_id)" = "$TASK" ] || fail "frame create: same-project task link"
ok "frame create: explicit geometry, colour, same-project task link"

# cross-project task link rejected
run 1 "$MESA" storyboard frame create --storyboard "$SB" --title "Bad" --task "$FTASK"
[ "$(jqe .error.code)" = "validation" ] || fail "cross-project task: error.code"
ok "frame create cross-project task: exit 1, code=validation"

# unknown storyboard rejected (validation, like a task's unknown project)
run 1 "$MESA" storyboard frame create --storyboard 9999 --title "Bad"
[ "$(jqe .error.code)" = "validation" ] || fail "unknown storyboard: error.code"
ok "frame create unknown storyboard: exit 1, code=validation"

# move a frame
run 0 "$MESA" storyboard frame update "$F1" --x 120 --y 90 --author mover
[ "$(jqs '.x == 120')" = "true" ] || fail "frame update: x moved"
[ "$(jqs '.y == 90')" = "true" ] || fail "frame update: y moved"
ok "frame update: reposition"

# empty update is a usage error
run 2 "$MESA" storyboard frame update "$F1"
[ "$(jqe .error.code)" = "usage" ] || fail "empty frame update: error.code"
ok "frame update no fields: exit 2, code=usage"

# unlink the task
run 0 "$MESA" storyboard frame update "$F2" --no-task
[ "$(jqs .task_id)" = "null" ] || fail "frame update --no-task: must clear"
ok "frame update --no-task: clears the link"

# ---- edges ----
run 0 "$MESA" storyboard edge create --storyboard "$SB" --from "$F1" --to "$F2" \
  --label "then" --author user
E1=$(jqs .id)
[ "$(jqs .from_frame)" = "$F1" ] || fail "edge create: from_frame"
[ "$(jqs .to_frame)" = "$F2" ] || fail "edge create: to_frame"
[ "$(jqs .label)" = "then" ] || fail "edge create: label"
ok "edge create: full object"

# cycles are allowed (reverse edge accepted)
run 0 "$MESA" storyboard edge create --storyboard "$SB" --from "$F2" --to "$F1"
E2=$(jqs .id)
ok "edge create: reverse edge accepted (cycles allowed)"

# self-edge rejected
run 1 "$MESA" storyboard edge create --storyboard "$SB" --from "$F1" --to "$F1"
[ "$(jqe .error.code)" = "validation" ] || fail "self-edge: error.code"
ok "edge create self-edge: exit 1, code=validation"

# endpoint not on this board rejected
run 0 "$MESA" storyboard frame create --storyboard "$SB2" --title "Foreign frame"
FF=$(jqs .id)
run 1 "$MESA" storyboard edge create --storyboard "$SB" --from "$F1" --to "$FF"
[ "$(jqe .error.code)" = "validation" ] || fail "foreign frame edge: error.code"
ok "edge create foreign endpoint: exit 1, code=validation"

# relabel + clear
run 0 "$MESA" storyboard edge update "$E1" --label "next"
[ "$(jqs .label)" = "next" ] || fail "edge update: relabel"
run 0 "$MESA" storyboard edge update "$E1" --label ""
[ "$(jqs .label)" = "null" ] || fail "edge update --label \"\": must clear"
ok "edge update: relabel and clear"

# ---- show (full view) ----
run 0 "$MESA" storyboard show "$SB"
[ "$(jqs .storyboard.id)" = "$SB" ] || fail "show: storyboard echoed"
[ "$(jqs '.frames | length')" = "2" ] || fail "show: 2 frames"
[ "$(jqs '.edges | length')" = "2" ] || fail "show: 2 edges"
[ "$(jqs '.frames | map(.id) == (sort_by(.id) | map(.id))')" = "true" ] ||
  fail "show: frames ordered by id"
ok "storyboard show: full {storyboard, frames, edges} view"

# unknown storyboard show is not_found
run 1 "$MESA" storyboard show 9999
[ "$(jqe .error.code)" = "not_found" ] || fail "show unknown: error.code"
ok "storyboard show unknown id: exit 1, code=not_found"

# ---- storyboard update ----
run 0 "$MESA" storyboard update "$SB" --title "Onboarding v2" --description ""
[ "$(jqs .title)" = "Onboarding v2" ] || fail "storyboard update: title"
[ "$(jqs .description)" = "null" ] || fail "storyboard update: --description \"\" clears"
[ "$(jqs .author)" = "agent-1" ] || fail "storyboard update: author immutable"
ok "storyboard update: title set, description cleared, author immutable"

# ---- change history (who / what / when) ----
run 0 "$MESA" storyboard events "$SB"
[ "$(jqs type)" = "array" ] || fail "events: bare array"
[ "$(jqs '.[0].action')" = "storyboard_created" ] || fail "events: first is creation"
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
ok "storyboard events: change history with attribution, oldest first"

# unknown board's history is not_found
run 1 "$MESA" storyboard events 9999
[ "$(jqe .error.code)" = "not_found" ] || fail "events unknown board: error.code"
ok "storyboard events unknown board: exit 1, code=not_found"

# ---- delete frame (echo frame + cascaded edges) ----
run 0 "$MESA" storyboard frame delete "$F1" --author remover
[ "$(jqs .frame.id)" = "$F1" ] || fail "frame delete: frame echoed"
[ "$(jqs '.edges | length')" = "2" ] || fail "frame delete: cascaded edges echoed"
ok "frame delete: echoes {frame, edges}; touching edges cascade"

run 0 "$MESA" storyboard events "$SB"
[ "$(jqs 'any(.[]; .action == "frame_removed" and .actor == "remover")')" = "true" ] ||
  fail "events: frame_removed attributed to remover"
ok "frame delete logged in history with attribution"

# the board now has one frame and no edges
run 0 "$MESA" storyboard show "$SB"
[ "$(jqs '.frames | length')" = "1" ] || fail "after frame delete: 1 frame"
[ "$(jqs '.edges | length')" = "0" ] || fail "after frame delete: 0 edges"
ok "frame delete cascaded its edges"

# ---- delete edge echo ----
run 0 "$MESA" storyboard frame create --storyboard "$SB2" --title "Frame B"
FB=$(jqs .id)
run 0 "$MESA" storyboard edge create --storyboard "$SB2" --from "$FF" --to "$FB"
E3=$(jqs .id)
run 0 "$MESA" storyboard edge delete "$E3"
[ "$(jqs .id)" = "$E3" ] || fail "edge delete: echoes destroyed edge"
ok "edge delete: echoes the destroyed edge"

# ---- delete storyboard (cascade echo) ----
run 0 "$MESA" storyboard delete "$SB"
[ "$(jqs .storyboard.id)" = "$SB" ] || fail "storyboard delete: storyboard echoed"
[ "$(jqs '.frames | length')" = "1" ] || fail "storyboard delete: frames echoed"
ok "storyboard delete: echoes full destroyed view (cascade)"

run 1 "$MESA" storyboard show "$SB"
[ "$(jqe .error.code)" = "not_found" ] || fail "deleted storyboard: error.code"
ok "deleted storyboard is gone: exit 1, code=not_found"

# deleting the project cascades the remaining board away
run 0 "$MESA" project delete "$P"
run 0 "$MESA" storyboard list --project "$P"
[ "$(jqs length)" = "0" ] || fail "project delete: storyboards must cascade"
ok "project delete cascades its storyboards"

# ---- usage errors ----
run 2 "$MESA" storyboard create "no project flag"
[ "$(jqe .error.code)" = "usage" ] || fail "missing --project: error.code"
ok "storyboard create without --project: exit 2, code=usage"

# ---- diagram_type + shape (mesa task 357) ----
# $P was deleted above (project delete cascade check); use a fresh project.
run 0 "$MESA" project create "Diagram types project" --no-git
DP=$(jqs .id)

run 0 "$MESA" storyboard create --project "$DP" --title "Untyped board"
[ "$(jqs .diagram_type)" = "storyboard" ] || fail "storyboard create: default diagram_type"
ok "storyboard create: diagram_type defaults to storyboard"

run 0 "$MESA" storyboard create --project "$DP" --title "Flow" --type flowchart
FLOW=$(jqs .id)
[ "$(jqs .diagram_type)" = "flowchart" ] || fail "storyboard create --type: diagram_type"
ok "storyboard create --type flowchart: diagram_type echoed"

run 2 "$MESA" storyboard create --project "$DP" --title "Bad type" --type bogus
[ "$(jqe .error.code)" = "usage" ] || fail "invalid --type: error.code"
ok "storyboard create --type bogus: exit 2, code=usage"

run 0 "$MESA" storyboard frame create --storyboard "$FLOW" --title "Decide" --shape decision
DECIDE=$(jqs .id)
[ "$(jqs .shape)" = "decision" ] || fail "frame create --shape: shape echoed"
ok "frame create --shape decision: shape echoed"

run 1 "$MESA" storyboard frame create --storyboard "$FLOW" --title "Bad shape" --shape entity
[ "$(jqe .error.code)" = "validation" ] || fail "shape wrong for board type: error.code"
ok "frame create --shape entity on a flowchart board: exit 1, code=validation"

run 2 "$MESA" storyboard frame create --storyboard "$FLOW" --title "Bad value" --shape bogus
[ "$(jqe .error.code)" = "usage" ] || fail "invalid --shape: error.code"
ok "frame create --shape bogus: exit 2, code=usage"

# diagram_type/shape are creation-only: no --type/--shape flag exists on the
# update subcommands, so passing one is a clap usage error, not validation.
run 2 "$MESA" storyboard update "$FLOW" --type storyboard
[ "$(jqe .error.code)" = "usage" ] || fail "--type on storyboard update: error.code"
ok "storyboard update --type: exit 2, code=usage (no such flag; immutable)"

run 2 "$MESA" storyboard frame update "$DECIDE" --shape process
[ "$(jqe .error.code)" = "usage" ] || fail "--shape on frame update: error.code"
ok "frame update --shape: exit 2, code=usage (no such flag; immutable)"

echo "all $CHECKS checks passed"
