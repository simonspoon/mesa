#!/usr/bin/env bash
# Advisory drift-check for the living docs under pm-docs/docs/ (spec:
# pm-docs/specs/2026-06-12-living-architecture-docs.md). For each living doc it
# verifies:
#   (a) every path listed in its `Tracks:` header still exists;
#   (b) every repo path it cites in the body (src/…, frontend/…, scripts/…,
#       Cargo.toml) still exists;
#   (c) every `mesa <subcommand>` shown in inline code still parses — checked
#       only when a release binary is present, skipped (not failed) otherwise.
# Advisory only: this is NOT wired into scripts/build.sh. Exit 0 if current,
# 1 if any living doc is stale.
set -uo pipefail

cd "$(dirname "$0")/.."

bin="target/release/mesa"
fail=0

# trim surrounding whitespace and one trailing prose punctuation char
strip() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  s="${s%%[.,:\;\)]}"
  printf '%s' "$s"
}

report() { echo "FAIL: $1: $2" >&2; fail=1; }

[ -x "$bin" ] || echo "skip: command-parse checks ($bin not built)"

shopt -s nullglob
for doc in pm-docs/docs/*.md; do
  # (a) Tracks: header paths
  tracks=$(grep -m1 '^Tracks:' "$doc" | sed 's/^Tracks://')
  if [ -n "$tracks" ]; then
    IFS=',' read -ra tpaths <<< "$tracks"
    for p in "${tpaths[@]}"; do
      p=$(strip "$p"); [ -z "$p" ] && continue
      [ -e "$p" ] || report "$doc" "Tracks path does not exist: $p"
    done
  fi

  # (b) inline repo paths cited in the body
  while IFS= read -r p; do
    p=$(strip "$p"); [ -z "$p" ] && continue
    [ -e "$p" ] || report "$doc" "cited path does not exist: $p"
  done < <(grep -oE '(src|frontend|scripts)/[A-Za-z0-9_./-]+|Cargo\.toml' "$doc" | sort -u)

  # (c) mesa commands shown in inline code
  if [ -x "$bin" ]; then
    while IFS= read -r span; do
      span="${span//\`/}"
      [ "${span#mesa }" = "$span" ] && continue   # keep only "mesa …" spans
      sub=$(printf '%s' "$span" | awk '{print $2}')
      case "$sub" in ""|-*) continue ;; esac
      "$bin" "$sub" --help >/dev/null 2>&1 || report "$doc" "command does not parse: mesa $sub"
    done < <(grep -oE '`[^`]+`' "$doc" | sort -u)
  fi
done

[ "$fail" -ne 0 ] && exit 1
echo "ok: pm-docs/docs is current"
