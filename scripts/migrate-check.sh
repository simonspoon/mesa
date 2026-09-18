#!/usr/bin/env bash
# Migration gate (mesa task 1206, docs/migrate.md): `mesa migrate
# check|export|import` end to end over the CLI, between two throwaway HOMEs
# with different usernames and two throwaway MESA_DBs. Never touches the real
# ~/.claude, ~/.mesa or db: HOME and MESA_DB are set on every call.
#
# The load-bearing assertions:
#   * export bundles the db snapshot, ~/.mesa/config.json and the chosen
#     ~/.claude items, per-project memory but NOT session transcripts (unless
#     --with-sessions), with missing items listed under `skipped`;
#   * import into a HOME under a different username maps every project's
#     local_path, renames the projects/<encoded> memory dir (content intact)
#     while a dir that only shares a textual prefix is left alone, rewrites
#     the old home in settings.json / an agent / .mesa/config.json, and keeps
#     the hook executable;
#   * a second import without --force is `conflict`, exit 1, and writes
#     nothing; --force overwrites;
#   * --repo-root maps the manifest's repo_root ahead of the home map;
#   * `check` lists the hard-coded home paths, read-only;
#   * --quiet is refused (exit 2) on all three; bad --home-map / a garbage
#     archive are `validation`, exit 1.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA="$PWD/target/debug/mesa"

# The physical path: `project create --path` canonicalizes, and /var is a
# symlink to /private/var on macOS.
TMP=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$TMP"' EXIT

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
enc() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

SRC="$TMP/Users/olduser"
DST="$TMP/Users/newuser"
SRC_DB="$TMP/src.db"
DST_DB="$TMP/dst.db"
as_src() { HOME="$SRC" MESA_DB="$SRC_DB" "$MESA" "$@"; }
as_dst() { HOME="$DST" MESA_DB="$DST_DB" "$MESA" "$@"; }

# ---- the source machine ----
mkdir -p "$SRC/inaros/mesa" "$SRC/inaros/qorvex" "$DST"
mkdir -p "$SRC/.claude/hooks" "$SRC/.claude/agents" "$SRC/.mesa"
cat >"$SRC/.claude/settings.json" <<EOF
{
  "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "$SRC/.claude/hooks/guard.sh"}]}]},
  "statusLine": {"type": "command", "command": "bash $SRC/.claude/statusline-command.sh"}
}
EOF
printf '#!/bin/sh\necho ok\n' >"$SRC/.claude/statusline-command.sh"
printf '#!/bin/sh\n# guards %s/inaros\nexit 0\n' "$SRC" >"$SRC/.claude/hooks/guard.sh"
chmod 755 "$SRC/.claude/hooks/guard.sh"
printf -- '---\nname: sup\n---\nWork in %s/inaros/mesa, not %sX.\n' "$SRC" "$SRC" \
  >"$SRC/.claude/agents/sup.md"
printf '{"commands": {"todo-watcher": "cd %s/inaros && claude"}}\n' "$SRC" \
  >"$SRC/.mesa/config.json"
MEM_SRC="$SRC/.claude/projects/$(enc "$SRC/inaros/mesa")"
mkdir -p "$MEM_SRC/memory"
printf 'remember: mesa lives in %s/inaros/mesa\n' "$SRC" >"$MEM_SRC/memory/MEMORY.md"
echo '{"type":"user"}' >"$MEM_SRC/session-1.jsonl"
# A dir whose encoded name merely starts with the old home's encoding,
# followed by a non-boundary character: it must never be renamed.
DECOY="$(enc "$SRC")x-other"
mkdir -p "$SRC/.claude/projects/$DECOY/memory"
echo decoy >"$SRC/.claude/projects/$DECOY/memory/MEMORY.md"
echo '{"display":"hi"}' >"$SRC/.claude/history.jsonl"

run 0 as_src project create mesa --path "$SRC/inaros/mesa" --no-git
run 0 as_src project create qorvex --path "$SRC/inaros/qorvex" --no-git
[ "$(as_src project list | jq -r '.[0].local_path')" = "$SRC/inaros/mesa" ] ||
  fail "source project local_path"
ok "source HOME + db built"

# ================= check =================
run 0 as_src migrate check
[ "$(jqs '[.hardcoded[] | select(.file == ".claude/settings.json")] | length')" -eq 2 ] ||
  fail "check: settings.json's two hard-coded paths, got $STDOUT"
[ "$(jqs '[.hardcoded[] | select(.file == ".claude/agents/sup.md")][0].match')" = "$SRC/inaros/mesa" ] ||
  fail "check: agent path match"
[ "$(jqs '[.hardcoded[] | select(.file == ".claude/agents/sup.md")] | length')" -eq 1 ] ||
  fail "check: ${SRC}X is not under the home and must not be flagged"
[ "$(jqs '[.items[] | select(.path == ".claude/CLAUDE.md")][0].present')" = false ] ||
  fail "check: missing CLAUDE.md listed as not present"
[ "$(jqs '[.items[] | select(.path == ".claude/settings.json")][0].present')" = true ] ||
  fail "check: settings.json present"
[ "$(jqs .repo_root)" = "$SRC/inaros" ] || fail "check: repo_root"
[ ! -e "$DST_DB" ] || fail "check wrote a db"
ok "check lists items and hard-coded paths"

# ================= export =================
run 0 as_src migrate export "$TMP/move.tar.gz"
[ -s "$TMP/move.tar.gz" ] || fail "export: no archive"
[ "$(jqs .projects)" -eq 2 ] || fail "export: project count"
[ "$(jqs .repo_root)" = "$SRC/inaros" ] || fail "export: repo_root"
jqs '.skipped[]' | grep -qx '.claude/CLAUDE.md' || fail "export: skipped lists CLAUDE.md"
LIST=$(tar -tzf "$TMP/move.tar.gz")
grep -q 'memory/MEMORY.md' <<<"$LIST" || fail "export: memory missing"
! grep -q 'session-1.jsonl' <<<"$LIST" || fail "export: session transcript bundled without --with-sessions"
! grep -q 'history.jsonl' <<<"$LIST" || fail "export: history bundled without --with-sessions"
grep -qx 'manifest.json' <<<"$LIST" || grep -qx './manifest.json' <<<"$LIST" || fail "export: manifest"
MANIFEST=$(tar -xzOf "$TMP/move.tar.gz" manifest.json)
[ "$(jq -r .source_home <<<"$MANIFEST")" = "$SRC" ] || fail "manifest: source_home"
[ "$(jq -r .format_version <<<"$MANIFEST")" = 1 ] || fail "manifest: format_version"
[ "$(jq -r '.projects | length' <<<"$MANIFEST")" -eq 2 ] || fail "manifest: projects"
run 1 as_src migrate export "$TMP/move.tar.gz"
[ "$(jqe .error.code)" = conflict ] || fail "export over an existing archive: conflict"
ok "export bundles memory but not sessions"

# ================= import into a different username =================
run 0 as_dst migrate import "$TMP/move.tar.gz"
[ "$(as_dst project list | jq -r '[.[].local_path] | join(",")')" = "$DST/inaros/mesa,$DST/inaros/qorvex" ] ||
  fail "import: local_paths not mapped: $(as_dst project list)"
[ "$(jqs '.projects | length')" -eq 2 ] || fail "import: remapped projects reported"
MEM_DST="$DST/.claude/projects/$(enc "$DST/inaros/mesa")"
[ "$(cat "$MEM_DST/memory/MEMORY.md")" = "remember: mesa lives in $SRC/inaros/mesa" ] ||
  fail "import: memory content must be restored byte-identical"
[ ! -e "$DST/.claude/projects/$(enc "$SRC/inaros/mesa")" ] || fail "import: old encoded dir left behind"
[ ! -e "$MEM_DST/session-1.jsonl" ] || fail "import: session present without --with-sessions"
[ -f "$DST/.claude/projects/$DECOY/memory/MEMORY.md" ] || fail "import: decoy dir must keep its name"
jqs '.renamed[].to' | grep -qxF -- "$(enc "$DST/inaros/mesa")" || fail "import: rename reported"
grep -q "$DST/.claude/hooks/guard.sh" "$DST/.claude/settings.json" || fail "import: hook path rewritten"
grep -q "bash $DST/.claude/statusline-command.sh" "$DST/.claude/settings.json" || fail "import: statusLine rewritten"
! grep -q "$SRC" "$DST/.claude/settings.json" || fail "import: old home left in settings.json"
grep -q "Work in $DST/inaros/mesa, not ${SRC}X." "$DST/.claude/agents/sup.md" ||
  fail "import: agent rewrite (boundary): $(cat "$DST/.claude/agents/sup.md")"
grep -q "cd $DST/inaros" "$DST/.mesa/config.json" || fail "import: config.json rewritten"
[ -x "$DST/.claude/hooks/guard.sh" ] || fail "import: hook lost its executable bit"
jqs '.rewritten[]' | grep -qx '.claude/settings.json' || fail "import: rewritten list"
jqs '.todo[]' | grep -q "clone mesa to $DST/inaros/mesa" || fail "import: todo clone line"
ok "import maps paths, renames memory dirs, rewrites files, keeps modes"

# ================= a second import refuses and writes nothing =================
echo mine >"$DST/.claude/settings.json"
BEFORE=$(cd "$DST" && find . -type f -exec shasum {} + | sort; shasum "$DST_DB")
run 1 as_dst migrate import "$TMP/move.tar.gz"
[ "$(jqe .error.code)" = conflict ] || fail "second import: conflict"
jqe .error.message | grep -q "settings.json" || fail "second import: names the differing file"
jqe .error.message | grep -q "dst.db" || fail "second import: names the db"
[ -z "$STDOUT" ] || fail "second import: stdout must be empty"
AFTER=$(cd "$DST" && find . -type f -exec shasum {} + | sort; shasum "$DST_DB")
[ "$BEFORE" = "$AFTER" ] || fail "second import wrote something"
ok "second import without --force is conflict and writes nothing"

run 0 as_dst migrate import "$TMP/move.tar.gz" --force
grep -q "$DST/.claude/hooks/guard.sh" "$DST/.claude/settings.json" || fail "--force: settings restored"
ok "--force overwrites"

# ================= --with-sessions + --repo-root =================
run 0 as_src migrate export "$TMP/full.tar.gz" --with-sessions
THIRD="$TMP/Users/third"
mkdir -p "$THIRD"
run 0 env HOME="$THIRD" MESA_DB="$TMP/third.db" "$MESA" migrate import "$TMP/full.tar.gz" --repo-root "$TMP/code"
[ "$(HOME="$THIRD" MESA_DB="$TMP/third.db" "$MESA" project list | jq -r '.[0].local_path')" = "$TMP/code/mesa" ] ||
  fail "--repo-root: local_path"
MEM3="$THIRD/.claude/projects/$(enc "$TMP/code/mesa")"
[ -f "$MEM3/session-1.jsonl" ] || fail "--with-sessions: session transcript restored under the renamed dir"
[ -f "$THIRD/.claude/history.jsonl" ] || fail "--with-sessions: history.jsonl"
grep -q "Work in $TMP/code/mesa" "$THIRD/.claude/agents/sup.md" || fail "--repo-root: agent rewrite"
grep -q "$THIRD/.claude/hooks/guard.sh" "$THIRD/.claude/settings.json" || fail "--repo-root: home map still applies"
ok "--with-sessions carries transcripts; --repo-root outranks the home map"

# ================= usage and validation =================
for sub in check "export $TMP/q.tar.gz" "import $TMP/move.tar.gz"; do
  # shellcheck disable=SC2086
  run 2 as_dst migrate $sub --quiet
  [ "$(jqe .error.code)" = usage ] || fail "migrate $sub --quiet: usage"
done
ok "--quiet refused, exit 2"

run 1 as_dst migrate import "$TMP/move.tar.gz" --home-map nonsense
[ "$(jqe .error.code)" = validation ] || fail "bad --home-map: validation"
echo "not a tarball" >"$TMP/garbage.tar.gz"
run 1 as_dst migrate import "$TMP/garbage.tar.gz"
[ "$(jqe .error.code)" = validation ] || fail "garbage archive: validation"
run 1 as_dst migrate import "$TMP/absent.tar.gz"
[ "$(jqe .error.code)" = validation ] || fail "missing archive: validation"
ok "bad --home-map and bad archives are validation"

echo "migrate-check: $CHECKS checks passed"
