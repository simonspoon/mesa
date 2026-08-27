#!/usr/bin/env bash
# Work receipts gate (mesa task 920): exercises `mesa task receipt` end to
# end over the CLI, against a throwaway MESA_DB and a REAL throwaway git
# repo bound as a project's local_path (receipts read commits with `git
# log`, so a fake/no-op repo would prove nothing about D4's attribution
# window).
#
# The load-bearing assertions, beyond CRUD shape:
#   * closing a CLAIMED task auto-generates a receipt, and the commits made
#     during the claim window (and only those) appear in it (D1/D3/D4);
#   * closing an UNCLAIMED task generates no receipt at all (D3's guard);
#   * the diff summary counts a file changed by two commits once, not twice
#     (core::git::diff_stat's distinct-paths contract);
#   * --note sets the note and flips edited (D6);
#   * --regenerate PRESERVES a hand-written note/edited while recomputing
#     the machine fields — a regression guard for a real data-loss bug
#     (core::receipt::regenerate's doc comment, "defect 1") where an early
#     version of --regenerate silently discarded a hand-written note;
#   * --quiet drops exactly `commits`/`note`, nothing else (key-set compare
#     via jq, never byte-for-byte);
#   * --delete echoes the destroyed record and a subsequent show is
#     not_found (the recovery-transcript safety floor);
#   * --regenerate on a project with no local_path is validation, exit 1;
#   * mutually exclusive flags together are a usage error, exit 2.
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

# ---- a real throwaway git repo, bound as a project's local_path ----
REPO="$TMP/repo"
mkdir -p "$REPO"
git() { command git -C "$REPO" -c user.email=t@t -c user.name=t "$@"; }
git init -b trunk >/dev/null
echo "root" >"$REPO/a.txt"
git add -A >/dev/null
git commit -q -m "root commit" >/dev/null

# --path binds local_path unconditionally (see cli.rs ProjectCmd::Create);
# --no-git skips root_commit auto-detection, irrelevant to receipts.
run 0 "$MESA" project create "Receipts" --no-git --path "$REPO"
P=$(jqs .id)
[ "$(jqs .local_path)" != "null" ] || fail "project create --path: local_path must be bound"
ok "project bound to a real throwaway git repo"

# ================= closing a CLAIMED task generates a receipt =================
run 0 "$MESA" task create "$P" "Claimed work"
T=$(jqs .id)
# A full second clear of the root commit above: mesa's timestamps and git's
# `--since`/`--until` share one-second granularity, so a claim stamped in the
# same wall-clock second as the root commit would pull it into the window too.
sleep 1
run 0 "$MESA" task claim "$T" --owner sess-abc
CLAIMED_AT=$(jqs .claimed_at)

sleep 1
echo "first change" >>"$REPO/a.txt"
git add -A >/dev/null
git commit -q -m "commit one, touches a.txt" >/dev/null
SHA1=$(git rev-parse HEAD)

sleep 1
echo "second change" >>"$REPO/a.txt"
echo "new file" >"$REPO/b.txt"
git add -A >/dev/null
git commit -q -m "commit two, touches a.txt again and b.txt" >/dev/null
SHA2=$(git rev-parse HEAD)

sleep 1
run 0 "$MESA" task update "$T" --status done
[ "$(jqs .owner)" = "null" ] || fail "closing a claim: owner must be cleared on the task row"
ok "closing a claimed task clears its own owner/claimed_at"

run 0 "$MESA" task receipt "$T"
[ "$(jqs .task_id)" = "$T" ] || fail "receipt: task_id"
[ "$(jqs .owner)" = "sess-abc" ] || fail "receipt: owner stored verbatim"
[ "$(jqs .claimed_at)" = "$CLAIMED_AT" ] || fail "receipt: claimed_at carried from the claim"
[ "$(jqs '.commits | length')" = "2" ] || fail "receipt: expected 2 commits in the claim window"
[ "$(jqs '[.commits[].hash] | sort')" = "$(jq -n --arg a "$SHA1" --arg b "$SHA2" '[$a,$b] | sort')" ] ||
  fail "receipt: commit shas must match what was made during the claim window"
[ "$(jqs .session_id)" = "null" ] || fail "receipt: sess-abc is not a cc_sessions uuid, must not resolve"
[ "$(jqs .edited)" = "false" ] || fail "receipt: freshly generated must not be edited"
ok "closing a claimed task auto-generates a receipt with the claim-window commits"

# ---- diff summary counts a twice-touched file once ----
[ "$(jqs .stat.files_changed)" = "2" ] || fail "receipt: stat.files_changed must be 2 distinct paths (a.txt, b.txt), not 3"
ok "diff summary counts a file changed by two commits once, not twice"

# ================= closing an UNCLAIMED task generates none =================
run 0 "$MESA" task create "$P" "Unclaimed work"
TU=$(jqs .id)
run 0 "$MESA" task update "$TU" --status done
run 1 "$MESA" task receipt "$TU"
[ "$(jqe .error.code)" = "not_found" ] || fail "receipt on an unclaimed close: error.code"
ok "closing an unclaimed task generates no receipt (not_found on read)"

# ================= --note sets the note and flips edited =================
run 0 "$MESA" task receipt "$T" --note "re-ran once, flaky test"
[ "$(jqs .note)" = "re-ran once, flaky test" ] || fail "--note: not stored"
[ "$(jqs .edited)" = "true" ] || fail "--note: must flip edited"
ok "--note sets the note and flips edited"

# ================= --regenerate PRESERVES a hand-written note =================
# Regression guard (core::receipt::regenerate's "defect 1"): an early version
# threw the human's note away on regenerate because `generate` always returns
# note:None/edited:false and `put_task_receipt` is INSERT OR REPLACE.
run 0 "$MESA" task receipt "$T" --regenerate
[ "$(jqs .note)" = "re-ran once, flaky test" ] || fail "--regenerate must PRESERVE the hand-written note"
[ "$(jqs .edited)" = "true" ] || fail "--regenerate must PRESERVE edited alongside the note"
[ "$(jqs '.commits | length')" = "2" ] || fail "--regenerate must still recompute the machine fields (commits)"
ok "--regenerate recomputes machine fields while preserving a hand-written note (regression guard)"

# ================= --quiet drops exactly commits/note =================
run 0 "$MESA" task receipt "$T"
FULL_KEYS=$(jqs 'keys' | jq -c .)
run 0 "$MESA" task receipt "$T" --quiet
QUIET_KEYS=$(jqs 'keys' | jq -c .)
[ "$(jq -cn --argjson f "$FULL_KEYS" --argjson q "$QUIET_KEYS" '($f - $q) | sort')" = '["commits","note"]' ] ||
  fail "--quiet must drop exactly commits and note"
[ "$(jq -cn --argjson f "$FULL_KEYS" --argjson q "$QUIET_KEYS" '$q - $f')" = "[]" ] ||
  fail "--quiet must not add or rename any key"
ok "--quiet drops exactly commits/note, keeps every other key"

# ================= --delete echoes the destroyed record =================
run 0 "$MESA" task receipt "$T" --delete
[ "$(jqs .task_id)" = "$T" ] || fail "--delete: echo must be the destroyed record"
[ "$(jqs .note)" = "re-ran once, flaky test" ] || fail "--delete: echo must carry the full record, note included"
ok "--delete echoes the destroyed record"

run 1 "$MESA" task receipt "$T"
[ "$(jqe .error.code)" = "not_found" ] || fail "show after delete: error.code"
ok "a deleted receipt's subsequent show is not_found"

# ================= --regenerate with no local_path is validation =================
run 0 "$MESA" project create "No repo" --no-git
PN=$(jqs .id)
run 0 "$MESA" task create "$PN" "Orphan task"
TN=$(jqs .id)
run 0 "$MESA" task claim "$TN" --owner sess-xyz
run 1 "$MESA" task receipt "$TN" --regenerate
[ "$(jqe .error.code)" = "validation" ] || fail "--regenerate with no local_path: error.code"
ok "--regenerate on a project with no local_path: exit 1, code=validation"

# ================= usage error: mutually exclusive flags =================
run 2 "$MESA" task receipt "$T" --regenerate --note "x"
[ "$(jqe .error.code)" = "usage" ] || fail "--regenerate --note together: error.code"
ok "mutually exclusive receipt flags together: exit 2, code=usage"

echo
echo "receipts-check: $CHECKS checks passed"
