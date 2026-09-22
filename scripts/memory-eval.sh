#!/usr/bin/env bash
# Live memory v2 eval harness (mesa task 1149): replays the person's real live
# sessions through four memory baselines, quizzes each at checkpoints, stress
# tests the notebook with synthetic sessions, and prints one score table.
#
#   scripts/memory-eval.sh [--sessions N] [--baselines a,b,c] [--stress N]
#       [--stress-fast N] [--budget W] [--decay product|never] [--edit-max PCT]
#       [--dream-every N] [--from ID] [--out DIR] [--dry-run] [--table-only]
#
# --from ID: the first real session replayed (default 60, where the real
# conversations start; earlier rows are the feature's own test sessions), and
# only sessions in which the person actually spoke count.
# --baselines: none,last5,nodecay,full by default; `dream` (mesa task 1152) is
# opt-in — `full` plus a synchronous dream pass after every --dream-every Nth
# session (default 3).
#
# bash + jq + curl, model calls through `claude -p` (MESA_EVAL_MODEL, default
# haiku). Never writes the person's db: it is copied once and read from the
# copy. See docs/live.md, "The eval harness".
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export EVAL_DIR="$ROOT/scripts/memory-eval"

FROM=60; SESSIONS_N=0; BASELINES="none,last5,nodecay,full"; STRESS_N=30; STRESS_FAST_N=200
export BUDGET=500 DECAY=product EDIT_MAX_PCT=60 DREAM_EVERY=3
OUT="${CLAUDE_JOB_DIR:-${TMPDIR:-/tmp}}/impl-eval/out"
[ -n "${CLAUDE_JOB_DIR:-}" ] && OUT="$CLAUDE_JOB_DIR/tmp/impl-eval/out"
DRY=0; TABLE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sessions) SESSIONS_N=$2; shift 2 ;;
    --from) FROM=$2; shift 2 ;;
    --baselines) BASELINES=$2; shift 2 ;;
    --stress) STRESS_N=$2; shift 2 ;;
    --stress-fast) STRESS_FAST_N=$2; shift 2 ;;
    --budget) BUDGET=$2; shift 2 ;;
    --decay) DECAY=$2; shift 2 ;;
    --edit-max) EDIT_MAX_PCT=$2; shift 2 ;;
    --dream-every) DREAM_EVERY=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --table-only) TABLE_ONLY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
export OUT MODEL="${MESA_EVAL_MODEL:-haiku}"
export MESA_BIN="${MESA_BIN:-$ROOT/target/release/mesa}"
export REAL_CLAUDE="${REAL_CLAUDE:-$(command -v claude || true)}"
for tool in jq curl sqlite3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done
[ -x "$MESA_BIN" ] || { echo "no mesa binary at $MESA_BIN (build first, or set MESA_BIN)" >&2; exit 2; }
[ -n "$REAL_CLAUDE" ] || { echo "no claude on PATH (set REAL_CLAUDE)" >&2; exit 2; }
mkdir -p "$OUT"
[ "$TABLE_ONLY" = 1 ] || : > "$OUT/calls"

# The person's db, copied once; every read of the real turns is off the copy.
# Naru's own default (mesa task 1301): naru.db when it exists, else mesa.db.
DEFAULT_SRC_DB="$HOME/Library/Application Support/naru/naru.db"
[ -f "$DEFAULT_SRC_DB" ] || DEFAULT_SRC_DB="$HOME/Library/Application Support/mesa/mesa.db"
SRC_DB="${MESA_EVAL_SOURCE_DB:-$DEFAULT_SRC_DB}"
export REAL_DB="$OUT/real.db"
cp "$SRC_DB" "$REAL_DB"; rm -f "$REAL_DB-wal" "$REAL_DB-shm"
# shellcheck source=memory-eval/lib.sh
. "$EVAL_DIR/lib.sh"
with_turns=($(real_sessions_with_turns "$FROM" "$SESSIONS_N"))
[ "${#with_turns[@]}" -gt 0 ] || { echo "no real sessions with a user turn from $FROM on" >&2; exit 1; }
export SESSIONS="${with_turns[*]}"
export QUIZ="$EVAL_DIR/quiz.json"
nq=$(jq --argjson ids "$(printf '%s\n' "${with_turns[@]}" | jq -cs .)" '[.[] | select(.after_session as $a | $ids | index($a))] | length' "$QUIZ")

# ---- plan and cost ----
calls=0
IFS=, read -ra BL <<<"$BASELINES"
for b in "${BL[@]}"; do
  case "$b" in
    none) ;;
    last5) calls=$((calls + ${#with_turns[@]})) ;;
    nodecay|full) calls=$((calls + 2 * ${#with_turns[@]})) ;;
    # `full`'s calls plus one dream call per --dream-every sessions.
    dream) calls=$((calls + 2 * ${#with_turns[@]} + ${#with_turns[@]} / DREAM_EVERY)) ;;
    *) echo "unknown baseline: $b" >&2; exit 2 ;;
  esac
  calls=$((calls + 2 * nq))
done
[ "$DREAM_EVERY" -ge 1 ] 2>/dev/null || { echo "--dream-every must be a whole number of sessions, 1 or more" >&2; exit 2; }
calls=$((calls + 2 * STRESS_N))
# ~$0.05 per haiku call was measured on this machine (a ~24k-token system
# prompt is cached and re-read per call, plus the prompt); a tool-using
# agent step costs more, so read this as a floor.
est=$(awk -v c="$calls" 'BEGIN { printf "%.2f", c * 0.05 }')
dream_note=""
case ",$BASELINES," in *,dream,*) dream_note=", dream pass every $DREAM_EVERY sessions (dream)" ;; esac
echo "plan: ${#with_turns[@]} real sessions (${with_turns[0]:-none}..${with_turns[${#with_turns[@]}-1]:-none}) × baselines [$BASELINES], $nq quiz questions, stress $STRESS_N model-driven + $STRESS_FAST_N scripted; harness checks: budget $BUDGET words, decay $DECAY (nodecay touches), fast-editor wipe $EDIT_MAX_PCT%$dream_note (product guard: 30%/edit, 500 words, 10 sessions — constants, not flags)"
echo "model calls: ~$calls on $MODEL, est. cost ~\$$est (floor); out: $OUT"
[ "$DRY" = 1 ] && exit 0

# ---- run: baselines in parallel, then stress ----
if [ "$TABLE_ONLY" = 0 ]; then
PIDS=()
# `|| true` everywhere: under set -e a failed kill in an EXIT trap would
# otherwise turn a finished run into exit 1.
cleanup() { for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done; pkill -P $$ 2>/dev/null || true; return 0; }
trap cleanup EXIT INT TERM
for b in "${BL[@]}"; do
  bash "$EVAL_DIR/baseline.sh" "$b" 2>"$OUT/$b.log" &
  PIDS+=($!)
done
failed=0
for p in "${PIDS[@]}"; do wait "$p" || failed=1; done
[ "$failed" = 0 ] || echo "a baseline failed; see $OUT/*.log" >&2
[ "$STRESS_FAST_N" -gt 0 ] && bash "$EVAL_DIR/stress.sh" fast "$STRESS_FAST_N" 2>"$OUT/stress-fast.log"
[ "$STRESS_N" -gt 0 ] && bash "$EVAL_DIR/stress.sh" model "$STRESS_N" 2>"$OUT/stress-model.log"
fi

# ---- score table ----
results=()
for b in "${BL[@]}"; do [ -f "$OUT/$b/result.json" ] && results+=("$OUT/$b/result.json"); done
stress=()
for m in fast model; do [ -f "$OUT/stress-$m/result.json" ] && stress+=("$OUT/stress-$m/result.json"); done
jq -s --arg model "$MODEL" --argjson calls "$(wc -l < "$OUT/calls" | tr -d ' ')" \
   --argjson budget "$BUDGET" --arg decay "$DECAY" --arg sessions "$SESSIONS" \
   '{model: $model, model_calls: $calls, budget: $budget, decay: $decay, sessions: ($sessions | split(" ") | map(tonumber)),
     baselines: [.[] | select(.baseline)], stress: [.[] | select(.mode)]}' ${results[@]+"${results[@]}"} ${stress[@]+"${stress[@]}"} > "$OUT/results.json"
echo
score_table "$OUT/results.json"
echo "model calls made: $(wc -l < "$OUT/calls" | tr -d ' '); raw results: $OUT/results.json"
