#!/usr/bin/env bash
# Milestone 8 agent smoke test (spec Acceptance 8): run a fresh headless
# Claude Code session from a temp dir with a throwaway MESA_DB, given ONLY the
# skills/mesa/SKILL.md content plus the fixed prompt. Saves the transcript and
# a per-step pass/fail summary under scripts/agent-check/.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)
OUT="$REPO/scripts/agent-check"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude CLI is required" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }
[ -x target/release/mesa ] || { echo "build target/release/mesa first (./scripts/build.sh)" >&2; exit 1; }

mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export PATH="$REPO/target/release:$PATH"

PROMPT="create a project with 3 tasks, make task 3 blocked by task 1, then try to make task 1 blocked by task 3, then list unblocked tasks"

# Fresh session: temp cwd (no project CLAUDE.md), SKILL.md as the only mesa
# context, throwaway DB. The session needs Bash to run mesa.
(
  cd "$TMP"
  claude -p "$PROMPT" \
    --append-system-prompt "$(cat "$REPO/skills/mesa/SKILL.md")" \
    --dangerously-skip-permissions \
    --max-turns 30 \
    --verbose \
    --output-format stream-json \
    >"$OUT/transcript.jsonl"
)

# Human-readable rendering of the same transcript.
jq -r '
  if .type=="assistant" then
    .message.content[]? |
    if .type=="text" then "ASSISTANT: " + .text
    elif .type=="tool_use" then "TOOL_USE(" + .name + "): " + (.input.command // (.input|tostring))
    else empty end
  elif .type=="user" then
    .message.content[]? | select(.type=="tool_result") |
    "TOOL_RESULT: " + (if (.content|type)=="array"
                       then ([.content[]?|.text // empty]|join("\n"))
                       else (.content|tostring) end)
  elif .type=="result" then "RESULT (" + (.subtype // "") + "): " + (.result // "")
  else empty end
' "$OUT/transcript.jsonl" >"$OUT/transcript.txt"

# ---- per-step grading: empirical DB state + transcript evidence ----
MESA=target/release/mesa
FAILED=0
SUMMARY="$OUT/summary.md"
{
  echo "# Agent smoke test — $(date '+%Y-%m-%d %H:%M')"
  echo
  echo "Prompt: $PROMPT"
  echo
  echo "Context given: skills/mesa/SKILL.md only (appended to the system prompt)."
  echo "Transcript: transcript.jsonl (raw stream-json), transcript.txt (readable)."
  echo
} >"$SUMMARY"

step() { # step <name> <pass-bool> <evidence>
  local mark="PASS"
  [ "$2" = "true" ] || { mark="FAIL"; FAILED=1; }
  echo "- $mark — $1 ($3)" >>"$SUMMARY"
  echo "$mark: $1"
}

# Commands the agent ran, and the tool results it saw.
COMMANDS=$(jq -r '
  select(.type=="assistant") | .message.content[]? |
  select(.type=="tool_use") | .input.command // empty
' "$OUT/transcript.jsonl")
RESULTS=$(jq -r '
  select(.type=="user") | .message.content[]? | select(.type=="tool_result") |
  if (.content|type)=="array" then ([.content[]?|.text // empty]|join("\n"))
  else (.content|tostring) end
' "$OUT/transcript.jsonl")

# Step 1: one project with exactly 3 tasks.
NPROJ=$("$MESA" project list | jq length)
NTASK=$("$MESA" task list | jq length)
step "create a project with 3 tasks" \
  "$([ "$NPROJ" = 1 ] && [ "$NTASK" = 3 ] && echo true || echo false)" \
  "projects=$NPROJ tasks=$NTASK"

T1=$("$MESA" task list | jq 'sort_by(.id) | .[0].id // empty')
T3=$("$MESA" task list | jq 'sort_by(.id) | .[2].id // empty')

# Step 2: exactly the edge task3 <- task1 exists; blocked flags agree.
EDGES=$(sqlite3 "$MESA_DB" "SELECT task_id || '<-' || blocked_by FROM dependencies ORDER BY task_id")
B3=$("$MESA" task show "${T3:-0}" 2>/dev/null | jq -r .blocked || echo n/a)
B1=$("$MESA" task show "${T1:-0}" 2>/dev/null | jq -r .blocked || echo n/a)
step "make task 3 blocked by task 1" \
  "$([ "$EDGES" = "$T3<-$T1" ] && [ "$B3" = true ] && [ "$B1" = false ] && echo true || echo false)" \
  "edges=[$EDGES] task3.blocked=$B3 task1.blocked=$B1"

# Step 3: the cycle attempt was made and rejected (code "cycle" seen).
NCYCLE=$(grep -c '"code":"cycle"' <<<"$RESULTS" || true)
step "try task1 blocked-by task3: rejected with code=cycle" \
  "$([ "$NCYCLE" -ge 1 ] && echo true || echo false)" \
  "cycle errors seen=$NCYCLE"

# Step 4: recovered within one corrected retry (<=2 cycle errors, edge set
# still clean — step 2 already proved no reverse edge landed).
step "recovers from the cycle rejection within one corrected retry" \
  "$([ "$NCYCLE" -ge 1 ] && [ "$NCYCLE" -le 2 ] && echo true || echo false)" \
  "cycle errors seen=$NCYCLE (1 attempt + at most 1 retry)"

# Step 5: listed unblocked tasks via the documented filter.
LISTED=$(grep -c -- '--unblocked' <<<"$COMMANDS" || true)
step "list unblocked tasks" \
  "$([ "$LISTED" -ge 1 ] && echo true || echo false)" \
  "commands using --unblocked=$LISTED"

# Bonus criterion (Acceptance 8): no --help consultation needed.
HELPED=$(grep -c -- '--help\|mesa help' <<<"$COMMANDS" || true)
step "completes without consulting --help" \
  "$([ "$HELPED" = 0 ] && echo true || echo false)" \
  "help invocations=$HELPED"

{
  echo
  echo "Overall: $([ "$FAILED" = 0 ] && echo PASS || echo FAIL)"
} >>"$SUMMARY"
echo "summary written to $SUMMARY"
exit "$FAILED"
