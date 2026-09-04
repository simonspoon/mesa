#!/usr/bin/env bash
# Seed a fresh worktree's target/ from the main checkout's, so a new agent
# worktree builds in seconds instead of compiling every dependency cold.
#
# Each worktree deliberately keeps its OWN target dir. Pointing them all at one
# shared dir is unsafe here: cargo hashes a workspace member's source path
# RELATIVE to the workspace root, so main and every worktree would share one set
# of mesa artifacts whose freshness is then decided by mtime alone — main can
# "build" in under a second against a worktree's artifact and silently run that
# worktree's code. This does the safe half of the same idea instead: an APFS
# copy-on-write clone (instant, no shared inodes) plus an mtime sync, after
# which each tree owns its artifacts outright.
#
# The mtime sync is cargo's own freshness rule applied to main: a file that is
# byte-identical to main's takes main's timestamp, and anything that differs (or
# is new) keeps its checkout mtime — newer than every cloned artifact, so cargo
# rebuilds exactly what depends on it.
#
#   scripts/worktree-warm.sh                    # every worktree under .claude/worktrees/
#   scripts/worktree-warm.sh <path> [<path>...] # named worktrees, anywhere
set -euo pipefail

START=$SECONDS

GIT_COMMON=$(git rev-parse --git-common-dir)
MAIN=$(cd "$GIT_COMMON/.." && pwd)

[ -d "$MAIN/target" ] || { echo "skip: $MAIN/target does not exist — build main first"; exit 0; }

# warm <worktree-path>
warm() {
  local wt=$1
  [ -d "$wt" ] || { echo "skip: $wt (no such directory)"; return; }
  wt=$(cd "$wt" && pwd)
  [ "$wt" != "$MAIN" ] || { echo "skip: $wt (this is the main checkout)"; return; }
  # Warming is only sound on a tree that has never been built: an existing
  # target/ holds artifacts fingerprinted against sources this would restamp.
  [ ! -e "$wt/target" ] || { echo "skip: $wt (target/ already exists)"; return; }

  # -p is load-bearing, not tidiness: the artifacts must keep main's old
  # timestamps, so that any file this script does NOT restamp below (one that
  # differs from main's, or is new) is newer than them and rebuilds.
  if cp -c -Rp "$MAIN/target" "$wt/target" 2>/dev/null; then
    echo "cloned: $MAIN/target -> $wt/target (APFS copy-on-write)"
  else
    # A clone that failed partway leaves a partial $wt/target, into which a
    # plain cp would nest a second copy — start the fallback from nothing.
    rm -rf "$wt/target"
    cp -Rp "$MAIN/target" "$wt/target"
    echo "copied: $MAIN/target -> $wt/target (not APFS — a full copy, not a clone)"
  fi

  # build.rs watches frontend/dist, which is untracked build output — so a fresh
  # worktree does not have it, and cargo calls a *missing* watched path stale
  # unconditionally, rebuilding the whole crate however good the mtimes are.
  # Mirror main's copy, timestamps and all. If main has none, the build script
  # creates an empty one and this crate compiles once, as it did before.
  if [ -d "$MAIN/frontend/dist" ] && [ ! -e "$wt/frontend/dist" ]; then
    cp -c -Rp "$MAIN/frontend/dist" "$wt/frontend/dist" 2>/dev/null ||
      { rm -rf "$wt/frontend/dist"; cp -Rp "$MAIN/frontend/dist" "$wt/frontend/dist"; }
    echo "cloned: frontend/dist (untracked, watched by build.rs)"
  fi

  local synced=0 differing=0 f
  while IFS= read -r -d '' f; do
    [ -f "$MAIN/$f" ] && [ -f "$wt/$f" ] || continue
    if cmp -s "$MAIN/$f" "$wt/$f"; then
      touch -r "$MAIN/$f" "$wt/$f"
      synced=$((synced + 1))
    else
      differing=$((differing + 1))
    fi
  done < <(git -C "$MAIN" ls-files -z)

  echo "warmed: $wt ($synced files took main's mtime, $differing differ and were left alone)"
}

if [ "$#" -gt 0 ]; then
  for wt in "$@"; do warm "$wt"; done
else
  while IFS= read -r line; do
    case "$line" in
      "worktree $MAIN/.claude/worktrees/"*) warm "${line#worktree }" ;;
    esac
  done < <(git -C "$MAIN" worktree list --porcelain)
fi

echo "ok: worktree-warm in $((SECONDS - START))s"
