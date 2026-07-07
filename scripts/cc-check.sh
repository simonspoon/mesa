#!/usr/bin/env bash
# CC Dashboard JSON-contract gate: `mesa cc` ingests Claude Code transcripts into
# the mesa store (cc_* tables) and serves the dashboard from the db, so this
# drives it against a tiny synthetic transcript tree (MESA_CC_PROJECTS_DIR) and a
# throwaway db (MESA_DB), asserting: the summary/sessions/skills JSON shapes, the
# `cc sync` report + its idempotency (second sync = no-op), tool-call and
# subagent rows, persistence across transcript deletion, and auto-ingest on a
# plain dashboard read. `cc live` stays a direct file parse (no db) and is
# checked last.
set -euo pipefail

cd "$(dirname "$0")/.."

BIN=${BIN:-target/release/mesa}
[ -x "$BIN" ] || BIN=target/debug/mesa
[ -x "$BIN" ] || { echo "FAIL: build mesa first (scripts/build.sh or cargo build)" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Synthetic tree: one session "a" whose main transcript carries a usage event
# with a tool_use block, plus a subagent transcript (same sessionId, agentId)
# under <session>/subagents/ — the layout Claude Code writes.
mkdir -p "$TMP/tree/-demo-project/s/subagents"
cat > "$TMP/tree/-demo-project/s.jsonl" <<'JSONL'
{"type":"user","sessionId":"a","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/demo","gitBranch":"main","entrypoint":"cli","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"u1","sessionId":"a","timestamp":"2026-06-15T01:05:00.000Z","cwd":"/home/me/demo","attributionSkill":"build","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","caller":"skill:build"}]}}
JSONL
cat > "$TMP/tree/-demo-project/s/subagents/x.jsonl" <<'JSONL'
{"type":"assistant","uuid":"u2","isSidechain":true,"sessionId":"a","agentId":"x1","timestamp":"2026-06-15T01:10:00.000Z","attributionAgent":"Explore","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL

export MESA_CC_PROJECTS_DIR="$TMP/tree"
export MESA_DB="$TMP/mesa.db"

fail() { echo "FAIL: $1" >&2; exit 1; }

# sync: report shape + counts of the first ingest.
"$BIN" cc sync | python3 -c '
import json,sys
r=json.load(sys.stdin)
for k in ["files_scanned","files_ingested","sessions","messages_added","tool_calls_added"]:
    assert k in r, f"missing key {k}"
assert r["files_scanned"]==2, r
assert r["files_ingested"]==2, r
assert r["sessions"]==1, r
assert r["messages_added"]==2, r
assert r["tool_calls_added"]==1, r
print("sync ok")
' || fail "sync report shape/counts"

# sync idempotency: an unchanged tree re-syncs to a no-op.
"$BIN" cc sync | python3 -c '
import json,sys
r=json.load(sys.stdin)
assert r["files_scanned"]==2, r
assert r["files_ingested"]==0, r
assert r["sessions"]==0, r
assert r["messages_added"]==0, r
assert r["tool_calls_added"]==0, r
print("sync idempotent ok")
' || fail "second sync not a no-op"

# summary: full dashboard object with the expected top-level keys + counts,
# including the tools breakdown and the subagent-attributed agents breakdown.
SUM=$("$BIN" cc summary --window all) || fail "cc summary exited nonzero"
echo "$SUM" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for k in ["generated_at_unix","window","since","overview","daily","models","skills","agents","projects","tools","sessions"]:
    assert k in d, f"missing key {k}"
o=d["overview"]
assert o["sessions"]==1, o["sessions"]
assert o["messages"]==2, o["messages"]
assert o["total_tokens"]==380, o["total_tokens"]
assert o["est_cost_usd"]>0
assert d["since"] is None
t=[t for t in d["tools"] if t["name"]=="Bash"]
assert t and t[0]["caller"]=="skill:build" and t[0]["calls"]==1, d["tools"]
assert any(a["agent"]=="Explore" for a in d["agents"]), d["agents"]
print("summary ok")
' || fail "summary shape/counts"

# sessions: bare array; per-row tool-call/subagent-run counts; --limit caps it.
"$BIN" cc sessions --window all | python3 -c '
import json,sys
rows=json.load(sys.stdin)
assert isinstance(rows,list) and len(rows)==1, rows
r=rows[0]
assert r["project"]=="demo", r["project"]
assert r["used_subagent"] is True
assert r["duration_minutes"]==10.0, r["duration_minutes"]
assert r["tool_calls"]==1, r["tool_calls"]
assert r["agent_runs"]==1, r["agent_runs"]
print("sessions ok")
' || fail "sessions shape"

[ "$("$BIN" cc sessions --window all --limit 0 | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" = "0" ] \
  || fail "sessions --limit not honored"

# skills: bare array including the attributed skill.
"$BIN" cc skills --window all | python3 -c '
import json,sys
rows=json.load(sys.stdin)
assert any(s["skill"]=="build" for s in rows), rows
print("skills ok")
' || fail "skills shape"

# persistence: delete the ingested transcripts — the dashboard reads only the
# db, so totals, the session row, and its subagent/tool attribution all survive.
rm -rf "$TMP/tree/-demo-project"
"$BIN" cc summary --window all | python3 -c '
import json,sys
d=json.load(sys.stdin)
o=d["overview"]
assert o["sessions"]==1 and o["messages"]==2 and o["total_tokens"]==380, o
assert any(a["agent"]=="Explore" for a in d["agents"]), d["agents"]
assert any(t["name"]=="Bash" for t in d["tools"]), d["tools"]
s=d["sessions"][0]
assert s["used_subagent"] is True and s["agent_runs"]==1 and s["tool_calls"]==1, s
print("survives deletion ok")
' || fail "history did not survive transcript deletion"

# auto-ingest: a plain dashboard read (no explicit sync) picks up a new
# transcript AND persists it — the sync that follows has nothing to add.
mkdir -p "$TMP/tree/-auto-project"
cat > "$TMP/tree/-auto-project/t.jsonl" <<'JSONL'
{"type":"assistant","uuid":"u3","sessionId":"b","timestamp":"2026-06-16T01:00:00.000Z","cwd":"/home/me/auto","message":{"model":"claude-opus-4-8","usage":{"input_tokens":900,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL
"$BIN" cc summary --window all | python3 -c '
import json,sys
o=json.load(sys.stdin)["overview"]
assert o["sessions"]==2 and o["messages"]==3 and o["total_tokens"]==1380, o
print("auto-ingest ok")
' || fail "summary did not auto-ingest the new transcript"
[ "$("$BIN" cc sync | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r["messages_added"]+r["tool_calls_added"]+r["files_ingested"])')" = "0" ] \
  || fail "auto-ingest did not persist (sync after summary had work left)"

# live: a direct file parse (never the db). The synthetic sessions above are
# days old, so a default-window live view is well-formed but empty. A second
# transcript stamped "now" must show up as one active live session with a
# per-minute spark.
"$BIN" cc live | python3 -c '
import json,sys
d=json.load(sys.stdin)
for k in ["generated_at_unix","window_minutes","bucket_seconds","active_seconds","active_count","live_count","total_tokens","est_cost_usd","tokens_per_min","sessions"]:
    assert k in d, f"missing key {k}"
assert d["window_minutes"]==15, d["window_minutes"]
assert d["live_count"]==0 and d["sessions"]==[], "old transcripts are not live"
print("live (empty) ok")
' || fail "live empty shape"

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
mkdir -p "$TMP/tree/-now-project"
cat > "$TMP/tree/-now-project/live.jsonl" <<JSONL
{"type":"assistant","sessionId":"now1","timestamp":"$NOW","cwd":"/home/me/now","gitBranch":"main","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL

"$BIN" cc live --minutes 15 | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["live_count"]==1, d["live_count"]
assert d["active_count"]==1, d["active_count"]
s=d["sessions"][0]
assert s["session_id"]=="now1", s
assert s["status"]=="active", s["status"]
assert s["project"]=="now", s["project"]
assert s["total_tokens"]==150, s["total_tokens"]
assert len(s["spark"])==15, len(s["spark"])
assert sum(s["spark"])==150, s["spark"]
print("live (active) ok")
' || fail "live active shape"

echo "ok: cc-check passed"
