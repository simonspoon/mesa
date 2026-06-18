#!/usr/bin/env bash
# Docs-tab spec Implementation 7 (panel, Hamel): agent acceptance test for the
# pm-docs/ convention. A fresh headless Claude session runs in a small fixture
# project under ~/inaros (so the root CLAUDE.md Project Documents rule is in
# scope), with the planning skill available and a mesa project created.
# It is prompted to plan a small feature and write the spec file — but
# never told WHERE. Pass: the spec lands under pm-docs/specs/ unprompted.
# Saves the transcript and a pass/fail summary under scripts/agent-check/.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)
OUT="$REPO/scripts/agent-check"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude CLI is required" >&2; exit 1; }
[ -x target/release/mesa ] || { echo "build target/release/mesa first (./scripts/build.sh)" >&2; exit 1; }

mkdir -p "$OUT"
# The fixture must live under ~/inaros so the root CLAUDE.md applies.
TMP=$(mktemp -d "$HOME/inaros/projects/tmp-agent-check-XXXXXX")
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export PATH="$REPO/target/release:$PATH"

# Tiny fixture project: a notes CLI with the planning skill available.
cat >"$TMP/notes.sh" <<'EOF'
#!/usr/bin/env bash
# notes.sh — append-only notes. Usage: notes.sh add <text> | notes.sh list
case "${1:-}" in
  add) shift; echo "$*" >> notes.txt ;;
  list) nl -ba notes.txt 2>/dev/null ;;
  *) echo "usage: notes.sh add <text> | notes.sh list" >&2; exit 2 ;;
esac
EOF
chmod +x "$TMP/notes.sh"
mkdir -p "$TMP/.claude/skills"
cp -R "$REPO/.claude/skills/planning" "$TMP/.claude/skills/planning"
mesa project create notes >/dev/null

PROMPT="/planning add a delete command to notes.sh that removes a note by its list number. Default any open choices without asking me; do write the spec file."

(
  cd "$TMP"
  claude -p "$PROMPT" \
    --dangerously-skip-permissions \
    --max-turns 40 \
    --verbose \
    --output-format stream-json \
    >"$OUT/planning-transcript.jsonl"
)

# Human-readable rendering of the same transcript.
jq -r '
  if .type=="assistant" then
    .message.content[]? |
    if .type=="text" then "ASSISTANT: " + .text
    elif .type=="tool_use" then "TOOL_USE(" + .name + "): " + (.input.command // .input.file_path // (.input|tostring))
    else empty end
  elif .type=="user" then
    .message.content[]? | select(.type=="tool_result") |
    "TOOL_RESULT: " + (if (.content|type)=="array"
                       then ([.content[]?|.text // empty]|join("\n"))
                       else (.content|tostring) end)
  elif .type=="result" then "RESULT (" + (.subtype // "") + "): " + (.result // "")
  else empty end
' "$OUT/planning-transcript.jsonl" >"$OUT/planning-transcript.txt"

# ---- grading: filesystem state, not transcript claims ----
FAILED=0
SUMMARY="$OUT/planning-summary.md"
{
  echo "# Planning-convention agent test — $(date '+%Y-%m-%d %H:%M')"
  echo
  echo "Prompt: $PROMPT"
  echo
  echo "Context: fixture project under ~/inaros (root CLAUDE.md in scope),"
  echo "planning skill copied in, mesa project 'notes' created."
  echo "The prompt asks for a spec file but never names a location."
  echo
} >"$SUMMARY"

step() { # step <name> <pass-bool> <evidence>
  local mark="PASS"
  [ "$2" = "true" ] || { mark="FAIL"; FAILED=1; }
  echo "- $mark — $1 ($3)" >>"$SUMMARY"
  echo "$mark: $1"
}

# An absent directory is a normal outcome here, not an error: guard the
# finds so set -e/pipefail don't abort the grading.
PMDOCS_SPECS=$( (find "$TMP/pm-docs/specs" -name '*.md' 2>/dev/null || true) | wc -l | tr -d ' ')
OLD_SPECS=$( (find "$TMP/specs" -name '*.md' 2>/dev/null || true) | wc -l | tr -d ' ')
step "spec file written under pm-docs/specs/ unprompted" \
  "$([ "$PMDOCS_SPECS" -ge 1 ] && echo true || echo false)" \
  "files in pm-docs/specs=$PMDOCS_SPECS: $( (find "$TMP/pm-docs/specs" -name '*.md' 2>/dev/null || true) | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
step "no spec written to the old specs/ location" \
  "$([ "$OLD_SPECS" = 0 ] && echo true || echo false)" \
  "files in specs/=$OLD_SPECS"

# Preserve the produced spec alongside the transcript as evidence.
if [ "$PMDOCS_SPECS" -ge 1 ]; then
  cp "$(find "$TMP/pm-docs/specs" -name '*.md' | head -1)" "$OUT/planning-produced-spec.md"
fi

{
  echo
  echo "Overall: $([ "$FAILED" = 0 ] && echo PASS || echo FAIL)"
} >>"$SUMMARY"
echo "summary written to $SUMMARY"
exit "$FAILED"
