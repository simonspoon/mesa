#!/usr/bin/env bash
# Project notebooks gate (mesa task 1333, docs/project-memory.md): the
# `naru memory` CLI, the folder -> project resolver, `naru memory context`,
# the `project-memory.sh` SessionStart hook built-in and the import from
# Claude Code's memory folder — against a throwaway MESA_DB, a throwaway
# HOME and a real throwaway git repo. Nothing here touches a real ~/.claude.
#
# What it pins:
#   * the CLI round trip on a project notebook (add/list/show/replace/touch/
#     delete/restore/merge/search), --project by id and by name, and the cwd
#     standing in for --project from a subfolder of the repo;
#   * --quiet: accepted by show and the mutations (full record minus `body`),
#     refused by list/search/context/dream/import (usage, exit 2);
#   * the notebooks never mix: a live id is not_found to `naru memory`, a
#     project id is not_found to `naru live memory` and to another project,
#     a merge across notebooks is validation, and `live memory list/search`
#     never show a project entry; `live memory move` files one across;
#   * `memory context` from a subfolder prints the header and the entries,
#     and prints nothing (exit 0) for a folder no project holds;
#   * the hook body, extracted via `library show project-memory.sh`, prints
#     that same context for a SessionStart payload naming the folder, and
#     nothing with exit 0 for an unknown folder, garbage stdin, empty stdin,
#     and (without jq) through its sed fallback;
#   * import: MEMORY.md skipped, frontmatter description + body, a long
#     file cut to fit, --dry-run writing nothing, a re-import adding nothing,
#     a missing folder not_found;
#   * dream: under two entries nothing spawns; with two it spawns through
#     the live-dream template (stub claude) in the project's folder with a
#     prompt naming `naru memory merge --project <id>`.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
BIN="$PWD/target/debug"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Canonical, so the paths naru prints match the ones compared against.
TMP=$(cd "$TMP" && pwd -P)
export MESA_DB="$TMP/mesa.db"
export HOME="$TMP/home"
mkdir -p "$HOME"
export PATH="$BIN:$PATH"
NARU=naru

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

run() { # <expected exit> <cmd...> — captures STDOUT/STDERR/CODE
  local expected=$1; shift
  set +e
  STDOUT=$("$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stdout: $STDOUT, stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- fixtures: a real repo bound to a project, and a stranger folder ----
REPO="$TMP/repo"
mkdir -p "$REPO/src/deep" "$TMP/stranger"
git -C "$REPO" init -q
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m root
run 0 "$NARU" project create "Memo" --path "$REPO"
P=$(jqs .id)
[ "$(jqs .local_path)" = "$REPO" ] || fail "fixture: project local_path (got $STDOUT)"
[ "$(jqs .root_commit)" != "null" ] || fail "fixture: project bound to the repo's root commit"
run 0 "$NARU" project create "Other" --no-git
Q=$(jqs .id)
ok "fixtures: project $P bound to a real repo, project $Q with no folder"

# ---- the CLI round trip, --project resolved from the cwd ----
cd "$REPO/src/deep"
run 0 "$NARU" memory add Run cargo fmt before clippy.
E1=$(jqs .id)
[ "$(jqs .project_id)" = "$P" ] || fail "add from a repo subfolder must land in project $P (got $STDOUT)"
[ "$(jqs .body)" = "Run cargo fmt before clippy." ] || fail "add: trailing words joined"
[ "$(jqs .source_session_id)" = "null" ] && [ "$(jqs .last_used_session_id)" = "null" ] ||
  fail "a project entry carries no session provenance"
[ "$(jqs '.evicted | length')" = "0" ] || fail "add: evicted is an empty array"
run 0 "$NARU" memory add --project Memo --quiet "scripts/build.sh refuses a dirty types folder."
E2=$(jqs .id)
[ "$(jqs 'has("body")')" = "false" ] || fail "add --quiet drops body"
run 0 "$NARU" memory add --project "$P" A note that mentions --quiet in passing.
E3=$(jqs .id)
grep -q -- "--quiet in passing" <<<"$(jqs .body)" || fail "--quiet after the text is part of the body"
cd "$TMP"
ok "memory add: cwd, --project by name and by id; --quiet before the text only"

run 0 "$NARU" memory list --project "$P"
[ "$(jqs 'map(.id) | join(",")')" = "$E1,$E2,$E3" ] || fail "memory list: oldest first (got $STDOUT)"
run 0 "$NARU" memory show --project "$P" "$E1"
printf '%s' "$STDOUT" >"$TMP/full.json"
run 0 "$NARU" memory get --project "$P" "$E1" --quiet
printf '%s' "$STDOUT" >"$TMP/quiet.json"
jq -e --slurpfile q "$TMP/quiet.json" 'del(.body) == $q[0]' "$TMP/full.json" >/dev/null ||
  fail "memory show --quiet must be the full record minus body and nothing else"
for verb in list search context dream import; do
  run 2 "$NARU" memory "$verb" --quiet x
  [ -z "$STDOUT" ] && [ "$(jqe .error.code)" = "usage" ] || fail "memory $verb --quiet: usage, empty stdout"
done
run 2 "$NARU" memory context --project "$P"
ok "memory list/show/get; --quiet on show only drops body; list/search/context/dream/import refuse --quiet; context takes no --project"

run 0 "$NARU" memory replace --project "$P" "$E3" A replaced note.
[ "$(jqs .body)" = "A replaced note." ] && [ "$(jqs .last_used_at)" != "null" ] ||
  fail "replace rewrites and stamps last_used_at (got $STDOUT)"
run 0 "$NARU" memory touch --project "$P" "$E1"
[ "$(jqs .last_used_at)" != "null" ] || fail "touch stamps last_used_at with no live session"
run 0 "$NARU" memory delete --project "$P" "$E3"
[ "$(jqs .retired_reason)" = "deleted" ] || fail "delete: soft retire"
run 0 "$NARU" memory list --project "$P"
[ "$(jqs length)" = "2" ] || fail "a deleted entry leaves the list"
run 0 "$NARU" memory list --project "$P" --all
[ "$(jqs length)" = "3" ] || fail "list --all keeps it"
run 0 "$NARU" memory restore --project "$P" "$E3"
[ "$(jqs .retired_at)" = "null" ] || fail "restore un-retires"
run 0 "$NARU" memory merge --project "$P" --ids "$E2,$E3" "build.sh refuses dirty types; replaced note."
EM=$(jqs .id)
[ "$(jqs .project_id)" = "$P" ] || fail "merge stays in the project"
run 0 "$NARU" memory show --project "$P" "$E2"
[ "$(jqs .merged_into)" = "$EM" ] || fail "merge: sources point at the merged row"
run 0 "$NARU" memory search --project "$P" clippy
[ "$(jqs 'map(.ref_id) | join(",")')" = "$E1" ] || fail "memory search finds the project entry (got $STDOUT)"
run 0 "$NARU" memory search --project "$Q" clippy
[ "$(jqs length)" = "0" ] || fail "another project's search sees nothing of this one"
ok "memory replace/touch/delete/restore/merge/search on the project notebook"

# ---- the notebooks never mix ----
run 0 "$NARU" live memory add "Prefers short replies; mentions clippy too."
L1=$(jqs .id)
[ "$(jqs .project_id)" = "null" ] || fail "a live entry has no project"
run 1 "$NARU" memory show --project "$P" "$L1"
[ "$(jqe .error.code)" = "not_found" ] || fail "a live id is not_found to naru memory"
run 1 "$NARU" memory delete --project "$P" "$L1"
[ "$(jqe .error.code)" = "not_found" ] || fail "delete of a live id via naru memory: not_found"
run 1 "$NARU" live memory show "$E1"
[ "$(jqe .error.code)" = "not_found" ] || fail "a project id is not_found to live memory"
run 1 "$NARU" live memory replace "$E1" hijacked
[ "$(jqe .error.code)" = "not_found" ] || fail "live replace of a project id: not_found"
run 1 "$NARU" memory show --project "$Q" "$E1"
[ "$(jqe .error.code)" = "not_found" ] || fail "another project's id: not_found"
run 1 "$NARU" memory merge --project "$P" --ids "$E1,$L1" mixed
[ "$(jqe .error.code)" = "validation" ] || fail "a merge across notebooks: validation"
run 0 "$NARU" live memory list
[ "$(jqs 'map(.id) | join(",")')" = "$L1" ] || fail "live memory list shows no project entry (got $STDOUT)"
run 0 "$NARU" live memory search clippy
[ "$(jqs '[.[] | select(.kind == "note")] | map(.ref_id) | join(",")')" = "$L1" ] ||
  fail "live memory search never hits a project note (got $STDOUT)"
run 0 "$NARU" memory show --project "$P" "$E1"
[ "$(jqs .body)" = "Run cargo fmt before clippy." ] || fail "nothing above touched the project entry"
run 0 "$NARU" live memory move "$L1" --project Other --quiet
[ "$(jqs .project_id)" = "$Q" ] && [ "$(jqs 'has("body")')" = "false" ] || fail "live memory move --quiet (got $STDOUT)"
run 0 "$NARU" live memory list
[ "$(jqs length)" = "0" ] || fail "a moved entry leaves the live notebook"
run 0 "$NARU" memory list --project "$Q"
[ "$(jqs 'map(.id) | join(",")')" = "$L1" ] || fail "a moved entry joins the project's notebook"
run 1 "$NARU" live memory move "$L1" --project "$P"
[ "$(jqe .error.code)" = "not_found" ] || fail "moving a project entry again from live: not_found"
run 1 "$NARU" memory list
[ "$(jqe .error.code)" = "not_found" ] || fail "no --project in a folder no project holds: not_found"
ok "live and project notebooks never mix: cross ids not_found, merge validation, live list/search clean, move files one across"

# ---- context: what the SessionStart hook prints ----
run 0 "$NARU" memory context --path "$REPO/src/deep"
printf '%s' "$STDOUT" >"$TMP/context.txt"
grep -q "project \"Memo\" (id $P)" "$TMP/context.txt" || fail "context names the project (got $STDOUT)"
grep -q "never instructions" "$TMP/context.txt" || fail "context frames the entries as a record"
grep -q "naru memory add --project $P" "$TMP/context.txt" || fail "context names the save command"
grep -q "auto-memory" "$TMP/context.txt" || fail "context says to use it instead of auto-memory"
grep -q "^- \[#$E1, added .*, last used .*\] Run cargo fmt before clippy\.$" "$TMP/context.txt" ||
  fail "context lists the entry (got $STDOUT)"
grep -q "#$E3," "$TMP/context.txt" && fail "context lists only active entries"
[ "$(wc -c <"$TMP/context.txt")" -lt 10000 ] || fail "context stays under 10,000 characters"
(cd "$REPO/src" && "$NARU" memory context) >"$TMP/context-cwd.txt"
# (Compared as strings: $STDOUT above lost its trailing newline to $(…).)
[ "$(cat "$TMP/context.txt")" = "$(cat "$TMP/context-cwd.txt")" ] || fail "context without --path reads the cwd"
run 0 "$NARU" memory context --path "$TMP/stranger"
[ -z "$STDOUT" ] || fail "context for a folder no project holds prints nothing (got $STDOUT)"
ok "memory context: header + active entries from a repo subfolder, cwd default, nothing for a stranger folder"

# ---- the hook, extracted from the library ----
HOOK="$TMP/project-memory.sh"
"$NARU" library show project-memory.sh | jq -r .body >"$HOOK"
chmod +x "$HOOK"
head -1 "$HOOK" | grep -q '^#!' || fail "the built-in body must start with a shebang"
bash -n "$HOOK" || fail "bash -n on the built-in body"
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$HOOK" || fail "shellcheck on the built-in body"
fi
payload() { jq -cn --arg cwd "$1" '{session_id:"s1",transcript_path:"/nope",cwd:$cwd,hook_event_name:"SessionStart",source:"startup"}'; }
run 0 bash -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ "$STDOUT" = "$(cat "$TMP/context.txt")" ] || fail "the hook prints the folder's context (got $STDOUT)"
run 0 bash -c "'$HOOK' <<<'$(payload "$TMP/stranger")'"
[ -z "$STDOUT" ] || fail "hook: unknown folder prints nothing"
run 0 bash -c "'$HOOK' <<<'$(payload "$TMP/does-not-exist")'"
[ -z "$STDOUT" ] || fail "hook: a missing folder prints nothing"
run 0 bash -c "echo 'this is {not json' | '$HOOK'"
[ -z "$STDOUT" ] || fail "hook: garbage stdin prints nothing"
run 0 bash -c "'$HOOK' </dev/null"
[ -z "$STDOUT" ] || fail "hook: empty stdin prints nothing"
# Without jq: a PATH holding only what the fallback needs, and naru.
NOJQ="$TMP/nojq"
mkdir -p "$NOJQ"
for t in bash cat sed head git; do ln -s "$(command -v "$t")" "$NOJQ/$t"; done
ln -s "$BIN/naru" "$NOJQ/naru"
run 0 env PATH="$NOJQ" "$(command -v bash)" -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ "$STDOUT" = "$(cat "$TMP/context.txt")" ] || fail "hook without jq: the sed fallback reads cwd (got $STDOUT)"
# Neither naru nor mesa on PATH: nothing, exit 0.
rm "$NOJQ/naru"
run 0 env PATH="$NOJQ" "$(command -v bash)" -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ -z "$STDOUT" ] || fail "hook with no naru on PATH prints nothing"
# A naru that fails: its stderr is swallowed and the hook still exits 0.
printf '#!/bin/sh\necho boom >&2; exit 1\n' >"$NOJQ/naru"
chmod +x "$NOJQ/naru"
run 0 env PATH="$NOJQ" "$(command -v bash)" -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ -z "$STDOUT" ] && [ -z "$STDERR" ] || fail "hook with a failing naru: nothing on either stream"
ok "project-memory.sh: prints the folder's notebook for a SessionStart payload; nothing and exit 0 for an unknown/missing folder, garbage or empty stdin, no naru, a failing naru; the sed fallback works without jq"

# ---- import from Claude Code's memory folder ----
ENC=$(printf '%s' "$REPO" | sed 's/[^A-Za-z0-9]/-/g')
MEM="$HOME/.claude/projects/$ENC/memory"
mkdir -p "$MEM"
printf -- '- [build](build.md) — index line\n' >"$MEM/MEMORY.md"
printf -- '---\nname: build-order\ndescription: "Run the gates in order"\nmetadata:\n  type: project\n---\n\nfmt, then clippy,\nthen the tests.\n' >"$MEM/build.md"
{ printf -- '---\ndescription: A long one\n---\n'; for _ in $(seq 1 200); do printf 'word '; done; } >"$MEM/long.md"
printf -- '---\n---\n\n' >"$MEM/empty.md"
printf 'not markdown\n' >"$MEM/notes.txt"
run 0 "$NARU" memory list --project "$P"
BEFORE=$(jqs length)
run 0 "$NARU" memory import --project "$P" --dry-run
[ "$(jqs .source)" = "$MEM" ] || fail "import: the default source is Claude Code's memory folder (got $STDOUT)"
[ "$(jqs '.imported | map(.file) | join(",")')" = "build.md,long.md" ] || fail "import --dry-run: what would be imported (got $STDOUT)"
[ "$(jqs '[.imported[].id] | map(select(. != null)) | length')" = "0" ] || fail "import --dry-run: no ids"
[ "$(jqs '.skipped | map(.file + "=" + .reason) | join(",")')" = "empty.md=empty" ] || fail "import: empty.md skipped (got $STDOUT)"
run 0 "$NARU" memory list --project "$P"
[ "$(jqs length)" = "$BEFORE" ] || fail "import --dry-run writes nothing"
run 0 "$NARU" memory import --project "$P"
[ "$(jqs '.imported | length')" = "2" ] || fail "import: two entries"
IB=$(jqs '.imported[0].id')
[ "$(jqs '.evicted | length')" = "0" ] || fail "import: nothing evicted"
run 0 "$NARU" memory show --project "$P" "$IB"
[ "$(jqs .body)" = "Run the gates in order — fmt, then clippy, then the tests." ] || fail "import: description + body (got $STDOUT)"
run 0 "$NARU" memory list --project "$P"
LONG=$(jqs '.[] | select(.body | startswith("A long one")) | .body')
[ "${#LONG}" -le 600 ] && [ "${LONG: -1}" = "…" ] || fail "import: a long file is cut to fit with … (got ${#LONG} chars)"
run 0 "$NARU" memory import --project "$P"
[ "$(jqs '.imported | length')" = "0" ] || fail "re-import adds nothing (got $STDOUT)"
[ "$(jqs '[.skipped[] | select(.reason == "already in the notebook")] | length')" = "2" ] || fail "re-import skips both as already present"
run 1 "$NARU" memory import --project "$Q"
[ "$(jqe .error.code)" = "not_found" ] || fail "import for a project with no folder: not_found"
run 0 "$NARU" memory import --project "$Q" --from "$MEM" --dry-run
[ "$(jqs '.imported | length')" = "2" ] || fail "import --from reads the named folder"
run 1 "$NARU" memory import --project "$Q" --from "$TMP/nowhere"
[ "$(jqe .error.code)" = "not_found" ] || fail "import from a missing folder: not_found"
# At the budget: three 250-word files overflow 500 words, so the first
# import evicts; a re-import must still add nothing (the evicted entry is
# retired, not gone).
BIG="$TMP/big-memory"
mkdir -p "$BIG"
for w in x y z; do
  for _ in $(seq 1 250); do printf '%s ' "$w"; done >"$BIG/$w.md"
done
run 0 "$NARU" project create "Big" --no-git
B=$(jqs .id)
run 0 "$NARU" memory import --project "$B" --from "$BIG"
[ "$(jqs '.imported | length')" = "3" ] && [ "$(jqs '.evicted | length')" = "1" ] ||
  fail "import past the budget: three imported, one evicted (got $STDOUT)"
run 0 "$NARU" memory import --project "$B" --from "$BIG"
[ "$(jqs '.imported | length')" = "0" ] && [ "$(jqs '.evicted | length')" = "0" ] ||
  fail "re-import at the budget must add nothing (got $STDOUT)"
[ "$(jqs '[.skipped[] | select(.reason == "already in the notebook, retired")] | length')" = "1" ] ||
  fail "re-import names the evicted entry as retired (got $STDOUT)"
ok "memory import: MEMORY.md skipped, description + body, long file cut with …, --dry-run writes nothing, re-import idempotent (at the budget too), missing folder not_found"

# ---- dream: through the live-dream template, stub claude ----
STUB="$TMP/stub"
mkdir -p "$STUB"
cat >"$STUB/claude" <<EOF
#!/usr/bin/env bash
case "\$1" in
  --bg)
    for a in "\$@"; do PROMPT=\$a; done
    printf '%s' "\$PROMPT" >"$STUB/last-prompt"
    pwd -P >"$STUB/last-cwd"
    echo "backgrounded · cafe01 (idle)"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$STUB/claude"
export MESA_CLAUDE_BIN="$STUB/claude"
run 0 "$NARU" project create "Lonely" --no-git
R=$(jqs .id)
run 0 "$NARU" memory add --project "$R" only one entry
run 0 "$NARU" memory dream --project "$R"
[ "$(jqs .spawned)" = "false" ] && grep -q "1 active entry" <<<"$(jqs .reason)" || fail "dream under two entries spawns nothing (got $STDOUT)"
[ ! -e "$STUB/last-prompt" ] || fail "dream under two entries must not spawn"
run 0 "$NARU" memory dream --project "$P"
[ "$(jqs .spawned)" = "true" ] && [ "$(jqs .receipt)" = "cafe01" ] || fail "dream spawns and reports the receipt (got $STDOUT)"
[ "$(cat "$STUB/last-cwd")" = "$REPO" ] || fail "dream runs in the project's folder (got $(cat "$STUB/last-cwd"))"
grep -q "naru memory merge --project $P --ids" "$STUB/last-prompt" || fail "dream prompt names the project merge command"
grep -q "Run cargo fmt before clippy" "$STUB/last-prompt" || fail "dream prompt carries the notebook"
ok "memory dream: nothing under two entries; otherwise the live-dream template in the project folder, prompt naming naru memory --project $P"

# ---- the hook is a library built-in, enabled on SessionStart ----
run 0 "$NARU" library hook enable project-memory.sh --event SessionStart --matcher 'startup|resume|clear|compact'
[ -x "$HOME/.claude/hooks/project-memory.sh" ] || fail "enable seeds the hook script"
[ "$(cat "$HOOK")" = "$(cat "$HOME/.claude/hooks/project-memory.sh")" ] || fail "the seeded script is the built-in body"
jq -e '.hooks.SessionStart[0].matcher == "startup|resume|clear|compact"' "$HOME/.claude/settings.json" >/dev/null ||
  fail "enable registers it on SessionStart (throwaway HOME)"
ok "library hook enable project-memory.sh --event SessionStart seeds and registers it (throwaway HOME)"

echo "project-memory-check: $CHECKS checks passed"
