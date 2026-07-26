#!/usr/bin/env bash
# CC Dashboard JSON-contract gate: `mesa cc` ingests Claude Code transcripts into
# the mesa store (cc_* tables) and serves the dashboard from the db, so this
# drives it against a tiny synthetic transcript tree (MESA_CC_PROJECTS_DIR) and a
# throwaway db (MESA_DB), asserting: the summary/sessions/skills JSON shapes, the
# `cc sync` report + its idempotency (second sync = no-op), `cc sync --rebuild`
# re-walking without duplicating rows, tool-call and subagent rows, persistence
# across transcript deletion, and auto-ingest on a plain dashboard read.
# `cc live` stays a direct file parse (no db) and is checked last.
set -euo pipefail

cd "$(dirname "$0")/.."

BIN=${BIN:-target/release/mesa}
[ -x "$BIN" ] || BIN=target/debug/mesa
[ -x "$BIN" ] || { echo "FAIL: build mesa first (scripts/build.sh or cargo build)" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT

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
# The `.meta.json` sidecar Claude Code writes beside a subagent transcript: it
# carries the spawn provenance (`toolUseId`), which is the only link from a
# subagent back to the call that started it, and so the only thing that makes
# `cc graph` a tree rather than a flat list. Points at `toolu_1` — the one tool
# call this fixture has — so the graph under test is session -> tool -> agent.
# NOT a `.jsonl`, so `collect_files` ignores it and the file counts above hold.
cat > "$TMP/tree/-demo-project/s/subagents/x.meta.json" <<'JSON'
{"agentType":"Explore","description":"look around","toolUseId":"toolu_1","spawnDepth":1}
JSON

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

# sync --rebuild: clears cursors, re-walks both files, re-adds nothing (same
# stable-key upserts as a plain sync) — proves a rebuild is safe to run any
# time, not just a way to force re-parsing.
"$BIN" cc sync --rebuild | python3 -c '
import json,sys
r=json.load(sys.stdin)
assert r["files_scanned"]==2, r
assert r["files_ingested"]==2, r
assert r["messages_added"]==0, r
assert r["tool_calls_added"]==0, r
print("sync --rebuild ok")
' || fail "sync --rebuild did not re-walk without duplicating rows"

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


# ---- Project-scoped CC Dashboard: GET /api/projects/{id}/cc (mesa task 273) ----
# A fresh project + real directory (local_path canonicalizes via
# std::fs::canonicalize, so it must actually exist) with its own synthetic
# session, added and checked only now, after every prior assertion above, so
# it can't perturb the whole-dashboard counts already checked.

SCOPED_DIR="$TMP/scoped-repo"
mkdir -p "$SCOPED_DIR"
SCOPED_PATH=$(cd "$SCOPED_DIR" && pwd -P)

mkdir -p "$TMP/tree/-scoped-project"
cat > "$TMP/tree/-scoped-project/scoped.jsonl" <<JSONL
{"type":"assistant","uuid":"u4","sessionId":"scoped1","timestamp":"2026-06-17T01:00:00.000Z","cwd":"$SCOPED_PATH","message":{"model":"claude-opus-4-8","usage":{"input_tokens":500,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL

SCOPED_ID=$("$BIN" project create "Scoped proj" --no-git | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
"$BIN" project update "$SCOPED_ID" --path "$SCOPED_PATH" >/dev/null

NOLOC_ID=$("$BIN" project create "No local_path proj" --no-git | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

EMPTY_DIR="$TMP/empty-repo"; mkdir -p "$EMPTY_DIR"
EMPTY_PATH=$(cd "$EMPTY_DIR" && pwd -P)
MISMATCH_ID=$("$BIN" project create "Mismatched proj" --no-git | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
"$BIN" project update "$MISMATCH_ID" --path "$EMPTY_PATH" >/dev/null

# ---- cc graph: the session call tree (CLI half) ----
#
# Shape under test: session -> tool(Bash, toolu_1) -> agent(Explore, x1). The
# agent hangs off the tool call only because the sidecar named it, so this also
# pins the sidecar ingest end to end.
"$BIN" cc graph a | python3 -c '
import json,sys
g=json.load(sys.stdin)
assert g["session_id"]=="a", g
assert g["project"]=="demo", g
by={n["id"]:n for n in g["nodes"]}
assert set(by)=={"session","tool:toolu_1","agent:x1"}, sorted(by)
# The tree: exactly one root, every other node has exactly one parent.
parents={}
for e in g["edges"]:
    assert e["from"] in by and e["to"] in by, e
    assert e["to"] not in parents, f"two parents for {e['to']}"
    parents[e["to"]]=e["from"]
assert parents=={"tool:toolu_1":"session","agent:x1":"tool:toolu_1"}, parents

s,t,a=by["session"],by["tool:toolu_1"],by["agent:x1"]
assert s["kind"]=="session" and t["kind"]=="tool" and a["kind"]=="agent", g["nodes"]
assert t["name"]=="Bash" and a["name"]=="Explore", g["nodes"]
assert a["skill"] is None and a["description"]=="look around" and a["spawn_depth"]==1, a
# Node labels the ticket asks for: name + model + total tokens, on every node.
assert s["model"]=="claude-opus-4-8" and a["model"]=="claude-haiku-4-5", (s,a)
# Rollups are the thread`s own usage: main 100+200+50=350, subagent 10+20=30.
assert s["tokens_are_rollup"] and s["total_tokens"]==350, s
assert a["tokens_are_rollup"] and a["total_tokens"]==30, a
# A tool node reports its ISSUING message`s usage and says so, so the number is
# not additive with the rollups above.
assert t["tokens_are_rollup"] is False and t["total_tokens"]==350, t
assert t["model"]=="claude-opus-4-8" and t["caller"]=="skill:build", t
# Whole-session total is the honest sum: both threads.
assert g["total_tokens"]==380, g
assert g["truncated"] is False and g["omitted_tool_calls"]==0, g
print("cc graph: session -> tool -> agent tree ok")
' || fail "cc graph did not return the expected session call tree"

# --limit never drops a subagent or the call that spawned it, so the tree stays
# connected however low the cap goes.
"$BIN" cc graph a --limit 0 | python3 -c '
import json,sys
g=json.load(sys.stdin)
by={n["id"] for n in g["nodes"]}
assert by=={"session","tool:toolu_1","agent:x1"}, sorted(by)
assert all(e["from"] in by and e["to"] in by for e in g["edges"]), g["edges"]
assert g["omitted_tool_calls"]==0, g
print("cc graph: --limit 0 keeps the spawning call ok")
' || fail "cc graph --limit dropped a structural node"

# Unknown session is not_found (exit 1), never an empty graph — an empty graph
# is a real answer for a session that made no calls.
if "$BIN" cc graph no-such-session >"$TMP/graph-err" 2>&1; then
  fail "cc graph on an unknown session should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/graph-err"))
assert d["error"]["code"]=="not_found", d
' || fail "cc graph unknown session did not return error.code=not_found"
echo "cc graph: unknown session -> not_found ok"

PORT=17773
"$BIN" serve --port "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null || fail "server did not start"

# a project whose local_path matches the synthetic session's cwd: scoped to
# only that session, not the whole dashboard's other sessions.
curl -sf "http://127.0.0.1:$PORT/api/projects/$SCOPED_ID/cc?window=all" | python3 -c '
import json,sys
d=json.load(sys.stdin)
o=d["overview"]
assert o["sessions"]==1, o
assert o["messages"]==1, o
assert o["total_tokens"]==550, o
assert len(d["sessions"])==1 and d["sessions"][0]["session_id"]=="scoped1", d["sessions"]
print("project cc: scoped to matching session ok")
' || fail "project cc dashboard was not scoped to the matching session"

# no local_path at all: a defined zero-valued dashboard, not an error.
curl -sf "http://127.0.0.1:$PORT/api/projects/$NOLOC_ID/cc?window=all" | python3 -c '
import json,sys
d=json.load(sys.stdin)
o=d["overview"]
assert o["sessions"]==0 and o["messages"]==0 and o["total_tokens"]==0, o
assert d["sessions"]==[] and d["models"]==[] and d["skills"]==[] and d["agents"]==[] and d["tools"]==[], d
print("project cc: no local_path -> empty dashboard ok")
' || fail "project cc dashboard without local_path was not an empty dashboard"

# local_path set but matching zero sessions: same empty shape, still no error.
curl -sf "http://127.0.0.1:$PORT/api/projects/$MISMATCH_ID/cc?window=all" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["overview"]["sessions"]==0, d["overview"]
print("project cc: local_path with no matching sessions -> empty dashboard ok")
' || fail "project cc dashboard with an unmatched local_path was not empty"

# unknown project id: 404 not_found, never a crash/500.
STATUS=$(curl -s -o "$TMP/cc-body" -w '%{http_code}' "http://127.0.0.1:$PORT/api/projects/999999999/cc")
[ "$STATUS" = "404" ] || fail "project cc: unknown project id expected 404, got $STATUS ($(cat "$TMP/cc-body"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/cc-body"))
assert d["error"]["code"]=="not_found", d
' || fail "project cc: unknown project id did not return error.code=not_found"
echo "project cc: unknown project id -> 404 not_found ok"

# ---- cc graph over HTTP: same payload as the CLI, plus the 404 ----
curl -sf "http://127.0.0.1:$PORT/api/cc/sessions/a/graph" | python3 -c '
import json,sys
g=json.load(sys.stdin)
by={n["id"]:n for n in g["nodes"]}
assert set(by)=={"session","tool:toolu_1","agent:x1"}, sorted(by)
assert by["agent:x1"]["name"]=="Explore" and by["agent:x1"]["total_tokens"]==30, by["agent:x1"]
assert by["tool:toolu_1"]["tokens_are_rollup"] is False, by["tool:toolu_1"]
assert g["total_tokens"]==380, g
print("api cc graph: payload matches the CLI ok")
' || fail "GET /api/cc/sessions/{id}/graph did not match the CLI payload"

STATUS=$(curl -s -o "$TMP/graph-404" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/no-such-session/graph")
[ "$STATUS" = "404" ] || fail "api cc graph: unknown session expected 404, got $STATUS ($(cat "$TMP/graph-404"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/graph-404"))
assert d["error"]["code"]=="not_found", d
' || fail "api cc graph: unknown session did not return error.code=not_found"
echo "api cc graph: unknown session -> 404 not_found ok"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
unset SERVER_PID

echo "ok: cc-check passed"
