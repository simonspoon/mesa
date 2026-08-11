#!/usr/bin/env bash
# CC Dashboard JSON-contract gate: `mesa cc` ingests Claude Code transcripts into
# the mesa store (cc_* tables) and serves the dashboard from the db, so this
# drives it against a tiny synthetic transcript tree (MESA_CC_PROJECTS_DIR) and a
# throwaway db (MESA_DB), asserting: the summary/sessions/skills JSON shapes, the
# `cc sync` report + its idempotency (second sync = no-op), `cc sync --rebuild`
# re-walking without duplicating rows, `cc reset` purging + re-adding them,
# tool-call and subagent rows, persistence
# across transcript deletion, and auto-ingest on a plain dashboard read.
# `cc text` is the one read that leaves the db, so it is driven against bodies
# deliberately longer than the stored 200-char preview (the difference IS the
# assertion) plus its three-way validation/not_found/unavailable split.
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
#
# `u6`/`u7` are ONE API response written as two lines repeating the identical
# `usage` under one `message.id` — the shape Claude Code actually writes (task
# 693). Both rows persist, but every total below counts its 620 tokens once:
# 350 (u1) + 30 (u2) + 620 = 1000, never 1620.
mkdir -p "$TMP/tree/-demo-project/s/subagents"
cat > "$TMP/tree/-demo-project/s.jsonl" <<'JSONL'
{"type":"user","sessionId":"a","timestamp":"2026-06-15T01:00:00.000Z","cwd":"/home/me/demo","gitBranch":"main","entrypoint":"cli","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"u1","sessionId":"a","timestamp":"2026-06-15T01:05:00.000Z","cwd":"/home/me/demo","attributionSkill":"build","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","caller":"skill:build","input":{"command":"grep -rn 'x'\tsrc/","description":"search"}},{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file_path":"/home/me/demo/src/core/cc.rs","limit":20}},{"type":"tool_use","id":"toolu_3","name":"Skill","input":{"skill":"inaros-swe:refine","args":"583"}},{"type":"tool_use","id":"toolu_4","name":"AskUserQuestion","input":{"questions":[]}}]}}
{"type":"assistant","uuid":"u6","sessionId":"a","timestamp":"2026-06-15T01:06:00.000Z","cwd":"/home/me/demo","message":{"id":"msg_dup","model":"claude-opus-4-8","usage":{"input_tokens":20,"output_tokens":600,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"u7","sessionId":"a","timestamp":"2026-06-15T01:06:01.000Z","cwd":"/home/me/demo","message":{"id":"msg_dup","model":"claude-opus-4-8","usage":{"input_tokens":20,"output_tokens":600,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL
cat > "$TMP/tree/-demo-project/s/subagents/x.jsonl" <<'JSONL'
{"type":"assistant","uuid":"u2","isSidechain":true,"sessionId":"a","agentId":"x1","timestamp":"2026-06-15T01:10:00.000Z","attributionAgent":"Explore","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL
# The `.meta.json` sidecar Claude Code writes beside a subagent transcript: it
# carries the spawn provenance (`toolUseId`), which is the only link from a
# subagent back to the call that started it, and so the only thing that makes
# `cc graph` a tree rather than a flat list. Points at `toolu_1` — the Bash
# call — so the graph under test is session -> tool -> agent.
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
assert r["messages_added"]==4, r  # 4 ROWS (u1,u2,u6,u7); u4/u5 are one response
assert r["tool_calls_added"]==4, r
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

# cc reset: purges every cc_* row, then re-ingests. Unlike the rebuild above it
# is corrective, so the rows really are re-ADDED (messages_added > 0 where the
# rebuild added zero) — and because every transcript is still on disk, the
# resulting dashboard is identical to the pre-reset one.
BEFORE=$("$BIN" cc summary --window all) || fail "cc summary before reset exited nonzero"
"$BIN" cc reset | python3 -c '
import json,sys
r=json.load(sys.stdin)
assert r["files_scanned"]==2, r
assert r["files_ingested"]==2, r
assert r["sessions"]==1, r
assert r["messages_added"]==4, r  # purged, so the same 4 rows land again
assert r["tool_calls_added"]==4, r
print("cc reset ok")
' || fail "cc reset did not purge and re-add rows"
AFTER=$("$BIN" cc summary --window all) || fail "cc summary after reset exited nonzero"
python3 -c '
import json,sys
a,b=json.loads(sys.argv[1]),json.loads(sys.argv[2])
a.pop("generated_at_unix"); b.pop("generated_at_unix")
assert a==b, "summary changed across a reset of a fully-present tree"
print("reset round-trips the summary ok")
' "$BEFORE" "$AFTER" || fail "summary differed after cc reset"

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
# 3 responses, not 4 rows: u6/u7 are one API response written twice.
assert o["messages"]==3, o["messages"]
assert o["total_tokens"]==1000, o["total_tokens"]  # 1620 = the duplicate counted twice
assert o["est_cost_usd"]>0
assert d["since"] is None
t=[t for t in d["tools"] if t["name"]=="Bash"]
assert t and t[0]["caller"]=="skill:build" and t[0]["calls"]==1, d["tools"]
# The tool breakdown buckets by (name, caller) and must stay that way now that
# a call also carries a per-call `target`: one Bash bucket, named "Bash", NOT
# one bucket per distinct command. This is why `target` is its own column
# rather than being folded into `name`.
assert len(t)==1 and t[0]["name"]=="Bash", d["tools"]
assert {x["name"] for x in d["tools"]}=={"Bash","Read","Skill","AskUserQuestion"}, d["tools"]
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
assert r["tool_calls"]==4, r["tool_calls"]
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
assert o["sessions"]==1 and o["messages"]==3 and o["total_tokens"]==1000, o
assert any(a["agent"]=="Explore" for a in d["agents"]), d["agents"]
assert any(t["name"]=="Bash" for t in d["tools"]), d["tools"]
s=d["sessions"][0]
assert s["used_subagent"] is True and s["agent_runs"]==1 and s["tool_calls"]==4, s
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
assert o["sessions"]==2 and o["messages"]==4 and o["total_tokens"]==2000, o
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

# A session with prose: one message emitting a `text` block AND two tool_use
# blocks (so all three nodes share the message's timestamp — the equal-ts tie
# the response ordering has to break), plus a prose-free message. Added here,
# after every whole-dashboard count above, so it perturbs none of them.
mkdir -p "$TMP/tree/-prose-project"
cat > "$TMP/tree/-prose-project/p.jsonl" <<'JSONL'
{"type":"assistant","uuid":"p1","sessionId":"p","timestamp":"2026-06-18T01:00:00.000Z","cwd":"/home/me/prose","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"Reading the file.\nThen tests."},{"type":"tool_use","id":"pu_1","name":"Read","input":{"file_path":"/home/me/prose/a.rs"}},{"type":"tool_use","id":"pu_2","name":"Bash","input":{"command":"cargo test"}}]}}
{"type":"assistant","uuid":"p2","sessionId":"p","timestamp":"2026-06-18T01:00:01.000Z","cwd":"/home/me/prose","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"pu_3","name":"Bash","input":{"command":"pwd"}}]}}
JSONL
"$BIN" cc sync >/dev/null || fail "cc sync did not ingest the prose transcript"

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
assert set(by)=={"session","tool:toolu_1","tool:toolu_2","tool:toolu_3","tool:toolu_4",
                 "agent:x1"}, sorted(by)
# The tree: exactly one root, every other node has exactly one parent.
parents={}
for e in g["edges"]:
    assert e["from"] in by and e["to"] in by, e
    assert e["to"] not in parents, f"two parents for {e['to']}"
    parents[e["to"]]=e["from"]
assert parents=={"tool:toolu_1":"session","tool:toolu_2":"session","tool:toolu_3":"session",
                 "tool:toolu_4":"session","agent:x1":"tool:toolu_1"}, parents

s,t,a=by["session"],by["tool:toolu_1"],by["agent:x1"]
assert s["kind"]=="session" and t["kind"]=="tool" and a["kind"]=="agent", g["nodes"]
assert t["name"]=="Bash" and a["name"]=="Explore", g["nodes"]

# ---- what each call acted on (task 583) ----
# A Bash node carries its command, with the tab in the fixture collapsed to a
# single space: a stored target is one line, never able to span rows or move a
# cursor when this JSON is catted.
assert t["target"]=="grep -rn '"'"'x'"'"' src/", repr(t["target"])
# A file tool carries the FULL path; shortening to a basename is the web UI`s
# job, so the payload an agent reads stays unambiguous.
r=by["tool:toolu_2"]
assert r["kind"]=="tool" and r["name"]=="Read", r
assert r["target"]=="/home/me/demo/src/core/cc.rs", r
# A Skill call is its own kind and is named for the skill — not four nodes all
# labelled "Skill". Its id keeps the `tool:` prefix (it is still one
# cc_tool_calls row), which is what lets a skill parent a subagent.
k=by["tool:toolu_3"]
assert k["kind"]=="skill", k
assert k["name"]=="inaros-swe:refine", k
assert k["target"] is None, k
# A tool with no target-bearing input key is unchanged from before this landed.
q=by["tool:toolu_4"]
assert q["kind"]=="tool" and q["name"]=="AskUserQuestion" and q["target"] is None, q
# Only tool nodes ever carry one.
assert s["target"] is None and a["target"] is None, (s,a)
assert a["skill"] is None and a["description"]=="look around" and a["spawn_depth"]==1, a
# Node labels the ticket asks for: name + model + total tokens, on every node.
assert s["model"]=="claude-opus-4-8" and a["model"]=="claude-haiku-4-5", (s,a)
# Rollups are the thread`s own usage, deduped per API response: main
# 100+200+50 + 20+600 = 970 (u6/u7 once, not 1590), subagent 10+20=30.
assert s["tokens_are_rollup"] and s["total_tokens"]==970, s
assert a["tokens_are_rollup"] and a["total_tokens"]==30, a
# A tool node reports its ISSUING message`s usage and says so, so the number is
# not additive with the rollups above.
assert t["tokens_are_rollup"] is False and t["total_tokens"]==350, t
assert t["model"]=="claude-opus-4-8" and t["caller"]=="skill:build", t
# Whole-session total is the honest sum: both threads.
assert g["total_tokens"]==1000, g
assert g["truncated"] is False and g["omitted_tool_calls"]==0, g
# A prose-free session is byte-identical to before response nodes existed: the
# same ids in the same order, no `msg:` node, and an honest zero counter.
assert [n["id"] for n in g["nodes"]]==["session","tool:toolu_1","tool:toolu_2","tool:toolu_3",
                                       "tool:toolu_4","agent:x1"], [n["id"] for n in g["nodes"]]
assert not any(n["id"].startswith("msg:") for n in g["nodes"]), g["nodes"]
assert g["omitted_responses"]==0, g
print("cc graph: session -> tool -> agent tree ok")
' || fail "cc graph did not return the expected session call tree"

# --limit never drops a subagent or the call that spawned it, so the tree stays
# connected however low the cap goes. The three non-spawning calls DO drop, so
# this also exercises the truncation counter itself — with only the one
# structural call in the fixture, `omitted_tool_calls` could never leave 0.
"$BIN" cc graph a --limit 0 | python3 -c '
import json,sys
g=json.load(sys.stdin)
by={n["id"] for n in g["nodes"]}
assert by=={"session","tool:toolu_1","agent:x1"}, sorted(by)
assert all(e["from"] in by and e["to"] in by for e in g["edges"]), g["edges"]
assert g["truncated"] is True and g["omitted_tool_calls"]==3, g
print("cc graph: --limit 0 keeps the spawning call ok")
' || fail "cc graph --limit dropped a structural node"

# ---- cc graph: assistant response nodes (mesa task 605) ----
"$BIN" cc graph p | python3 -c '
import json,sys
g=json.load(sys.stdin)
ids=[n["id"] for n in g["nodes"]]
by={n["id"]:n for n in g["nodes"]}
assert len(ids)==len(by), ids
# One response node per PROSE-BEARING message, in its own `msg:` id namespace —
# disjoint from session/agent:/tool:, so nothing can collide with a tool_use_id.
assert [i for i in ids if i.startswith("msg:")]==["msg:p1"], ids
# p2 emitted only a tool_use, so it contributes a tool node and nothing else.
assert "msg:p2" not in by and "tool:pu_3" in by, ids
# Emission order: root first, then oldest-first, and at p1`s equal timestamp the
# response comes BEFORE the two calls that message issued — the frontend
# tie-breaks equal ts by this order, so it is the contract, not an accident.
assert ids==["session","msg:p1","tool:pu_1","tool:pu_2","tool:pu_3"], ids

r=by["msg:p1"]
assert r["kind"]=="response" and r["name"]=="Response", r
# The preview rides the existing `target` field, sanitized at ingest: the
# newline in the fixture is one space, so this JSON can never span rows.
assert r["target"]=="Reading the file. Then tests.", repr(r["target"])
assert r["model"]=="claude-opus-4-8", r
# The issuing message`s own usage — the same numbers its sibling tool nodes
# carry — and it says so, so nothing here is summable and no total moved.
assert r["tokens_are_rollup"] is False, r
assert r["total_tokens"]==30 and by["tool:pu_1"]["total_tokens"]==30, (r,by["tool:pu_1"])
assert r["messages"]==0 and r["tool_calls"]==0 and r["caller"] is None, r
assert r["skill"] is None and r["description"] is None and r["spawn_depth"] is None, r
assert g["total_tokens"]==40, g

# Flat sibling: the response hangs off the same parent as the message`s tool
# nodes and is never their parent.
parents={e["to"]:e["from"] for e in g["edges"]}
assert len(parents)==len(g["edges"]), g["edges"]
assert parents=={"msg:p1":"session","tool:pu_1":"session","tool:pu_2":"session",
                 "tool:pu_3":"session"}, parents
assert not any(e["from"]=="msg:p1" for e in g["edges"]), g["edges"]
assert g["truncated"] is False and g["omitted_responses"]==0, g
print("cc graph: response nodes ok")
' || fail "cc graph did not return the expected response nodes"

# Responses are budgeted separately from tool calls: with room for one of each,
# each counter reports only its own drops — omitted_tool_calls never counts a
# non-tool, and no node vanishes uncounted.
"$BIN" cc graph p --limit 1 | python3 -c '
import json,sys
g=json.load(sys.stdin)
assert [n["id"] for n in g["nodes"]]==["session","msg:p1","tool:pu_1"], [n["id"] for n in g["nodes"]]
assert g["truncated"] is True, g
assert g["omitted_responses"]==0 and g["omitted_tool_calls"]==2, g
print("cc graph: response budget is separate ok")
' || fail "cc graph --limit did not budget responses separately"

# A dropped response is still counted: omitted stays honest for both
# populations, so a reader can tell a small graph from a truncated one.
"$BIN" cc graph p --limit 0 | python3 -c '
import json,sys
g=json.load(sys.stdin)
assert [n["id"] for n in g["nodes"]]==["session"], [n["id"] for n in g["nodes"]]
assert g["truncated"] is True, g
assert g["omitted_responses"]==1 and g["omitted_tool_calls"]==3, g
print("cc graph: omitted responses counted ok")
' || fail "cc graph --limit 0 did not count the dropped response"

# ---- cc graph: human prompt nodes (mesa task 774) ----
#
# A third project, appended after every whole-dashboard count above (the same
# trick `-prose-project` uses) so it perturbs none of them — and `-demo`'s own
# `user` line stays uningested regardless, since it carries no `uuid` and the
# existing guard drops it.
#
# The fixture is the predicate's whole surface in five lines: a typed human
# turn, a slash command (Claude Code rewrites what the user typed into a
# `<command-name>` envelope, and skill-driven sessions are almost nothing but
# these), an `isMeta` injection, a `tool_result` carrier with no
# `toolUseResult` — and an assistant message stamped the SAME second as the
# first prompt, which is the equal-ts tie the prompt -> response -> tool rank
# has to break.
mkdir -p "$TMP/tree/-prompt-project"
cat > "$TMP/tree/-prompt-project/h.jsonl" <<'JSONL'
{"type":"user","uuid":"hp1","sessionId":"h","timestamp":"2026-06-19T01:00:00.000Z","cwd":"/home/me/prompts","origin":{"type":"human"},"message":{"role":"user","content":"read\tthe file"}}
{"type":"assistant","uuid":"hu1","sessionId":"h","timestamp":"2026-06-19T01:00:00.000Z","cwd":"/home/me/prompts","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"Reading it."},{"type":"tool_use","id":"hu_1","name":"Read","input":{"file_path":"/home/me/prompts/a.rs"}}]}}
{"type":"user","uuid":"hp2","sessionId":"h","timestamp":"2026-06-19T01:00:01.000Z","cwd":"/home/me/prompts","message":{"role":"user","content":"<command-message>execute-todo</command-message><command-name>/execute-todo</command-name><command-args>774</command-args>"}}
{"type":"user","uuid":"hp3","sessionId":"h","timestamp":"2026-06-19T01:00:02.000Z","cwd":"/home/me/prompts","isMeta":true,"message":{"role":"user","content":"Stop hook feedback: all good"}}
{"type":"user","uuid":"hp4","sessionId":"h","timestamp":"2026-06-19T01:00:03.000Z","cwd":"/home/me/prompts","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"hu_1","content":"fn main() {}"}]}}
JSONL
"$BIN" cc sync >/dev/null || fail "cc sync did not ingest the prompt transcript"

"$BIN" cc graph h | python3 -c '
import json,sys
g=json.load(sys.stdin)
ids=[n["id"] for n in g["nodes"]]
# Exact list, in order: root, then the equal-ts tie broken prompt -> response
# -> tool, then the slash command a second later. The two rejected user lines
# (isMeta, tool_result carrier) contribute nothing at all.
assert ids==["session","prompt:hp1","msg:hu1","tool:hu_1","prompt:hp2"], ids
by={n["id"]:n for n in g["nodes"]}
p1,p2=by["prompt:hp1"],by["prompt:hp2"]
assert p1["kind"]=="prompt" and p2["kind"]=="prompt", (p1,p2)
assert p1["name"]=="Prompt" and p2["name"]=="Prompt", (p1,p2)
# Sanitized and capped by the one shared policy: the fixture`s tab is a single
# space, so a stored preview can never span rows when this JSON is catted.
assert p1["target"]=="read the file", repr(p1["target"])
# A slash command is reconstructed from the envelope back to what was typed.
assert p2["target"]=="/execute-todo 774", repr(p2["target"])
# No model, no usage of its own — a user turn is billed as part of the reply.
assert p1["model"] is None and p1["total_tokens"]==0 and p1["est_cost_usd"]==0.0, p1
assert p1["tokens_are_rollup"] is True, p1
# Always a direct child of the root, and never a parent.
parents={e["to"]:e["from"] for e in g["edges"]}
assert len(parents)==len(g["edges"]), g["edges"]
assert parents=={"prompt:hp1":"session","prompt:hp2":"session",
                 "msg:hu1":"session","tool:hu_1":"session"}, parents
assert not any(e["from"].startswith("prompt:") for e in g["edges"]), g["edges"]
# Prompts change no total: the session rollup is the assistant message alone.
assert g["total_tokens"]==30, g
assert g["truncated"] is False and g["omitted_prompts"]==0, g
print("cc graph: prompt nodes ok")
' || fail "cc graph did not return the expected prompt nodes"

# The prompt budget is a third peer of the other two, not a tenant of either:
# with room for one node of each population, each counter reports only its own
# drops.
"$BIN" cc graph h --limit 1 | python3 -c '
import json,sys
g=json.load(sys.stdin)
ids=[n["id"] for n in g["nodes"]]
assert ids==["session","prompt:hp1","msg:hu1","tool:hu_1"], ids
assert g["truncated"] is True, g
assert g["omitted_prompts"]==1, g
assert g["omitted_responses"]==0 and g["omitted_tool_calls"]==0, g
print("cc graph: prompt budget is separate ok")
' || fail "cc graph --limit did not budget prompts separately"

# ---- cc text: one node's FULL, uncapped body (mesa task 803) ----
#
# A fourth appended project, same trick as the two above, so it perturbs no
# whole-dashboard count. Every body here is deliberately well over
# TARGET_MAX_CHARS (200) and ends in a sentinel the stored 200-char preview can
# never reach, which is what makes "this is the full text, not the preview"
# provable rather than asserted by eye. The subagent's `.meta.json` points at
# the `Task` call, whose whole `input` — including the unbounded `prompt` key
# that is deliberately never stored — is the agent node's body.
mkdir -p "$TMP/tree/-text-project/x/subagents"
cat > "$TMP/tree/-text-project/x.jsonl" <<'JSONL'
{"type":"user","uuid":"tp1","sessionId":"tx","timestamp":"2026-06-20T01:00:00.000Z","cwd":"/home/me/text","origin":{"type":"human"},"message":{"role":"user","content":"PROMPT-HEAD lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat PROMPT-TAIL"}}
{"type":"assistant","uuid":"tm1","sessionId":"tx","timestamp":"2026-06-20T01:00:01.000Z","cwd":"/home/me/text","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"RESPONSE-HEAD lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea RESPONSE-TAIL"},{"type":"tool_use","id":"tt_1","name":"Bash","input":{"command":"echo BASH-HEAD && grep -rn 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation' src/ && echo BASH-TAIL","description":"a long one"}},{"type":"tool_use","id":"tt_2","name":"Write","input":{"file_path":"/home/me/text/out.txt","content":"WRITE-HEAD lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip WRITE-TAIL"}},{"type":"tool_use","id":"tt_3","name":"Task","input":{"subagent_type":"Explore","description":"deep dive","prompt":"TASK-HEAD lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut TASK-TAIL"}}]}}
JSONL
cat > "$TMP/tree/-text-project/x/subagents/a.jsonl" <<'JSONL'
{"type":"assistant","uuid":"ta1","isSidechain":true,"sessionId":"tx","agentId":"x2","timestamp":"2026-06-20T01:00:02.000Z","attributionAgent":"Explore","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL
cat > "$TMP/tree/-text-project/x/subagents/a.meta.json" <<'JSON'
{"agentType":"Explore","description":"deep dive","toolUseId":"tt_3","spawnDepth":1}
JSON
"$BIN" cc sync >/dev/null || fail "cc sync did not ingest the node-text transcript"

# Every happy case is checked AGAINST THE GRAPH's stored preview of the same
# node, not against a literal: the assertion is that the two differ in the one
# way that matters — the preview is the capped 200-char column, the text is the
# whole thing off disk.
GRAPH_TX=$("$BIN" cc graph tx) || fail "cc graph tx exited nonzero"

# prompt: the uncapped human turn.
"$BIN" cc text tx prompt:tp1 | GRAPH="$GRAPH_TX" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
for k in ["node_id","kind","name","model","ts","text","format"]:
    assert k in d, f"missing key {k}"
assert d["node_id"]=="prompt:tp1" and d["kind"]=="prompt" and d["name"]=="Prompt", d
assert d["format"]=="text", d["format"]
assert d["model"] is None and d["ts"] is not None, d
t=d["text"]
prev=[n for n in json.loads(os.environ["GRAPH"])["nodes"] if n["id"]=="prompt:tp1"][0]["target"]
# The stored preview really is at the cap — 200 characters, plus the cut
# marker when the cut landed mid-word — and really does stop before the
# sentinel, so a full read is the only way to see the end of this turn.
cut=prev[:-1] if prev.endswith("…") else prev
assert len(cut)==200, (len(prev),prev)
assert "PROMPT-TAIL" not in prev, prev
assert len(t)>200 and t.startswith(cut), (len(t),t[:80],prev[:80])
assert t.startswith("PROMPT-HEAD") and t.endswith("PROMPT-TAIL"), (t[:40],t[-40:])
print("cc text: prompt node full body ok")
' || fail "cc text did not return the full prompt body"

# msg: the uncapped assistant prose.
"$BIN" cc text tx msg:tm1 | GRAPH="$GRAPH_TX" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
assert d["kind"]=="response" and d["name"]=="Response" and d["format"]=="text", d
assert d["model"]=="claude-opus-4-8", d
t=d["text"]
prev=[n for n in json.loads(os.environ["GRAPH"])["nodes"] if n["id"]=="msg:tm1"][0]["target"]
cut=prev[:-1] if prev.endswith("…") else prev
assert len(cut)==200 and "RESPONSE-TAIL" not in prev, prev
assert len(t)>200 and t.startswith(cut), (len(t),t[:80],prev[:80])
assert t.startswith("RESPONSE-HEAD") and t.endswith("RESPONSE-TAIL"), (t[:40],t[-40:])
print("cc text: response node full body ok")
' || fail "cc text did not return the full response body"

# tool: the WHOLE `tool_use.input` as JSON — not the one bounded scalar the
# graph lifted out of it. The Bash command is long enough that the preview cuts
# it, and `description` is a second key the column could never have carried.
"$BIN" cc text tx tool:tt_1 | GRAPH="$GRAPH_TX" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
assert d["kind"]=="tool" and d["name"]=="Bash" and d["format"]=="json", d
inp=json.loads(d["text"])   # the payload really is JSON, pretty-printed
assert set(inp)=={"command","description"}, inp
assert inp["command"].startswith("echo BASH-HEAD"), inp["command"][:40]
assert inp["command"].endswith("BASH-TAIL"), inp["command"][-40:]
assert inp["description"]=="a long one", inp
prev=[n for n in json.loads(os.environ["GRAPH"])["nodes"] if n["id"]=="tool:tt_1"][0]["target"]
cut=prev[:-1] if prev.endswith("…") else prev
assert len(cut)==200 and "BASH-TAIL" not in prev, prev
assert len(inp["command"])>200 and inp["command"].startswith(cut), inp["command"][:80]
print("cc text: tool node whole input ok")
' || fail "cc text did not return the tool call's whole input"

# The bulk keys ingest deliberately never lifts (`content`) come back whole —
# the graph node for this call carries only the file path, so this is the one
# read that can show what was written.
"$BIN" cc text tx tool:tt_2 | GRAPH="$GRAPH_TX" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
assert d["kind"]=="tool" and d["name"]=="Write" and d["format"]=="json", d
inp=json.loads(d["text"])
assert inp["file_path"]=="/home/me/text/out.txt", inp
assert inp["content"].startswith("WRITE-HEAD") and inp["content"].endswith("WRITE-TAIL"), inp["content"][:40]
assert len(inp["content"])>200, len(inp["content"])
# The stored preview is the path and nothing else: `content` is not in the db.
prev=[n for n in json.loads(os.environ["GRAPH"])["nodes"] if n["id"]=="tool:tt_2"][0]["target"]
assert prev=="/home/me/text/out.txt", prev
print("cc text: bulk tool input ok")
' || fail "cc text did not return a Write call's unbounded content"

# agent: the body is the `Task` call that SPAWNED the run — a row in the parent
# thread — while the answer keeps the agent`s own kind and name.
"$BIN" cc text tx agent:x2 | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["node_id"]=="agent:x2" and d["kind"]=="agent" and d["name"]=="Explore", d
assert d["format"]=="json", d["format"]
inp=json.loads(d["text"])
assert inp["subagent_type"]=="Explore" and inp["description"]=="deep dive", inp
assert inp["prompt"].startswith("TASK-HEAD") and inp["prompt"].endswith("TASK-TAIL"), inp["prompt"][:40]
assert len(inp["prompt"])>200, len(inp["prompt"])
print("cc text: agent node spawn prompt ok")
' || fail "cc text did not return the subagent's spawning input"

# The `session` node exists and is a real id — it just has no turn of its own,
# which is a different answer from "no such node": validation (exit 1), not
# not_found.
if "$BIN" cc text tx session >"$TMP/text-session" 2>&1; then
  fail "cc text on the session node should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/text-session"))
assert d["error"]["code"]=="validation", d
' || fail "cc text on the session node did not return error.code=validation"
echo "cc text: session node -> validation ok"

# An id whose prefix is not one the graph mints is the same class of mistake.
if "$BIN" cc text tx bogus:1 >"$TMP/text-prefix" 2>&1; then
  fail "cc text on an unknown id prefix should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/text-prefix"))
assert d["error"]["code"]=="validation", d
' || fail "cc text on an unknown id prefix did not return error.code=validation"
echo "cc text: unknown id prefix -> validation ok"

# A well-formed id with no backing row is not_found — distinct from both of the
# above and from unavailable.
if "$BIN" cc text tx tool:no-such-call >"$TMP/text-404" 2>&1; then
  fail "cc text on an unknown node should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/text-404"))
assert d["error"]["code"]=="not_found", d
' || fail "cc text on an unknown node did not return error.code=not_found"
echo "cc text: unknown node -> not_found ok"

# The deleted-transcript case, on session `a`, whose files were removed above:
# the ROW is still in the db (every aggregate over it still answers), so this is
# not not_found — the body simply cannot be re-read. `unavailable` is the code
# scoped to depending on something outside mesa.
"$BIN" cc graph a >/dev/null || fail "session a rows should still be readable"
if "$BIN" cc text a tool:toolu_2 >"$TMP/text-503" 2>&1; then
  fail "cc text on a deleted transcript should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/text-503"))
assert d["error"]["code"]=="unavailable", d
' || fail "cc text on a deleted transcript did not return error.code=unavailable"
echo "cc text: deleted transcript -> unavailable ok"

# ---- cc chat: the conversation, read straight off the transcript ----
#
# Its own project/session, written AFTER the last `cc sync` above and never
# ingested: that is the point of the fixture, not an accident. `cc chat` is the
# one cc verb that opens no store and runs no sync, because it backs a poll
# behind an open Agent-sidebar pane and must answer for a session mesa spawned
# moments ago. If it ever grows a sync, this session would be the only thing
# still proving it hasn't.
#
# The lines exercise the whole classification: a human turn, an assistant turn
# carrying prose AND two calls, an `isMeta` injection whose content is an array
# of text blocks (the shape an assistant turn has — it must NOT read as one),
# a tool_result carrier, and a subagent transcript that belongs to another
# reader entirely.
mkdir -p "$TMP/tree/-chat-project/cx/subagents"
cat > "$TMP/tree/-chat-project/cx.jsonl" <<'JSONL'
{"type":"user","uuid":"cp1","sessionId":"cx","timestamp":"2026-06-21T02:00:00.000Z","cwd":"/home/me/chat","origin":{"kind":"human"},"message":{"role":"user","content":"CHAT-PROMPT-HEAD lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat CHAT-PROMPT-TAIL"}}
{"type":"user","uuid":"cp2","sessionId":"cx","timestamp":"2026-06-21T02:00:01.000Z","cwd":"/home/me/chat","origin":{"type":"human","kind":"human"},"message":{"role":"user","content":"BOTH-SPELLINGS"}}
{"type":"user","uuid":"cmeta","sessionId":"cx","timestamp":"2026-06-21T02:00:01.000Z","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"an injected skill body"}]}}
{"type":"assistant","uuid":"cm1","sessionId":"cx","timestamp":"2026-06-21T02:00:02.000Z","cwd":"/home/me/chat","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"thinking","thinking":"THINKING-NEVER-SHOWN"},{"type":"text","text":"CHAT-RESPONSE-HEAD lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip CHAT-RESPONSE-TAIL"},{"type":"tool_use","id":"ct_1","name":"Bash","input":{"command":"cargo test"}},{"type":"tool_use","id":"ct_2","name":"advisor","input":{}}]}}
{"type":"user","uuid":"cres","sessionId":"cx","timestamp":"2026-06-21T02:00:03.000Z","toolUseResult":{"stdout":"ok"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"ct_1","content":"ok"}]}}
JSONL
cat > "$TMP/tree/-chat-project/cx/subagents/a.jsonl" <<'JSONL'
{"type":"assistant","uuid":"cs1","isSidechain":true,"sessionId":"cx","agentId":"cg1","timestamp":"2026-06-21T02:00:04.000Z","message":{"model":"claude-haiku-4-5","content":[{"type":"text","text":"SUBAGENT-PROSE"}]}}
JSONL

# Never ingested (no `cc sync` since the file was written) — and the answer is
# still complete, which no other cc verb can say.
"$BIN" cc sessions | python3 -c '
import json,sys
assert not [s for s in json.load(sys.stdin) if s["session_id"]=="cx"], "cx must not be ingested yet"
' || fail "the cc chat fixture was ingested before the no-sync assertion"

"$BIN" cc chat cx >"$TMP/chat-cli" || fail "cc chat cx exited nonzero"
python3 -c '
import json
d=json.load(open("'"$TMP"'/chat-cli"))
for k in ["session_id","turns","truncated"]:
    assert k in d, f"missing key {k}"
assert d["session_id"]=="cx" and d["truncated"] is False, d
shape=[(t["kind"], t["id"]) for t in d["turns"]]
# An injected `user` line, a tool_result carrier and a subagent transcript all
# produce nothing; one assistant line emits its prose BEFORE its own calls.
assert shape==[("prompt","cp1"),("prompt","cp2"),("response","cm1"),("tool","ct_1"),("tool","ct_2")], shape
p,p2,r,t1,t2=d["turns"]
# The human-turn marker upstream renamed: `cp1` carries only the new spelling
# (`origin.kind`) and `cp2` carries BOTH. Reading one spelling drops `cp1`;
# aliasing them onto one field makes `cp2` an unparseable line, which drops it
# from every cc read at once. Each is a regression this fixture would catch.
assert p2["text"]=="BOTH-SPELLINGS", p2
assert p["text"].startswith("CHAT-PROMPT-HEAD") and p["text"].endswith("CHAT-PROMPT-TAIL"), p["text"][:40]
assert p["model"] is None and p["name"] is None, p
# Prose is the product here: full body, not the 200-char stored preview.
assert len(r["text"])>200 and r["text"].endswith("CHAT-RESPONSE-TAIL"), r["text"][-40:]
assert "THINKING-NEVER-SHOWN" not in r["text"], "thinking must be excluded"
assert r["model"]=="claude-opus-4-8" and r["ts"]=="2026-06-21T02:00:02.000Z", r
# A tool turn is the bounded one-line summary, not the whole input.
assert t1["name"]=="Bash" and t1["text"]=="cargo test", t1
assert t2["name"]=="advisor" and t2["text"]=="", t2
assert "SUBAGENT-PROSE" not in json.dumps(d), "a subagent transcript is not this conversation"
print("cc chat: turn classification and full bodies ok")
' || fail "cc chat did not classify the transcript correctly"

# --limit keeps the NEWEST turns and says so: a chat window is read at its end.
"$BIN" cc chat cx --limit 2 | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert [t["id"] for t in d["turns"]]==["ct_1","ct_2"], d["turns"]
assert d["truncated"] is True, d
print("cc chat: --limit keeps the newest turns ok")
' || fail "cc chat --limit did not keep the newest turns"

# An id that is not a session id never becomes a path: refused before any
# filesystem access, and as `validation` rather than `unavailable`.
if "$BIN" cc chat ../../etc/passwd >"$TMP/chat-422" 2>&1; then
  fail "cc chat on a traversal-shaped id should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/chat-422"))
assert d["error"]["code"]=="validation", d
' || fail "cc chat on a traversal-shaped id did not return error.code=validation"
echo "cc chat: non-session id -> validation ok"

# A well-formed id with no transcript on disk is `unavailable` — the code
# scoped to depending on a Claude-Code-managed file, the same one `cc text`
# uses for a deleted transcript.
if "$BIN" cc chat no-such-session >"$TMP/chat-503" 2>&1; then
  fail "cc chat on a session with no transcript should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/chat-503"))
assert d["error"]["code"]=="unavailable", d
' || fail "cc chat on a missing transcript did not return error.code=unavailable"
echo "cc chat: missing transcript -> unavailable ok"

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

# ---- cc session: the aggregate detail read (CLI half, mesa task 689) ----
#
# The default drill-down. Aggregated over EVERY persisted row, so its totals
# must agree with the graph's (which is capped) exactly — that agreement is the
# assertion, not a re-derivation of the numbers.
GRAPH_A=$("$BIN" cc graph a) || fail "cc graph a exited nonzero"
"$BIN" cc session a | GRAPH="$GRAPH_A" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
g=json.loads(os.environ["GRAPH"])
for k in ["session_id","cwd","project","git_branch","entrypoint","start","end",
          "duration_minutes","used_subagent","tokens","total_tokens","est_cost_usd",
          "messages","tool_calls","agent_runs","main","agents","models","tools",
          "skills","activity"]:
    assert k in d, f"missing key {k}"
assert d["session_id"]=="a" and d["project"]=="demo", d
assert d["git_branch"]=="main" and d["entrypoint"]=="cli", d
assert d["used_subagent"] is True and d["duration_minutes"]==10.0, d
# Same numbers as the graph, from a different code path over uncapped rows.
assert d["total_tokens"]==g["total_tokens"]==1000, (d["total_tokens"],g["total_tokens"])
assert d["est_cost_usd"]==g["est_cost_usd"], (d["est_cost_usd"],g["est_cost_usd"])
assert d["tool_calls"]==4 and d["messages"]==3, d
# One `agents` entry per ingested run.
assert d["agent_runs"]==1 and len(d["agents"])==1, d
a=d["agents"][0]
assert a["agent_id"]=="x1" and a["agent"]=="Explore", a
assert a["description"]=="look around" and a["spawn_depth"]==1, a
assert a["total_tokens"]==30 and a["messages"]==1, a
# Main thread vs subagents split, and the two halves sum to the rollup.
assert d["main"]["agent_id"] is None and d["main"]["total_tokens"]==970, d["main"]
assert d["main"]["total_tokens"]+a["total_tokens"]==d["total_tokens"], d
# Tools keyed on NAME only (never target), skills promoted to the skill itself.
assert {t["name"]:t["calls"] for t in d["tools"]}=={"Bash":1,"Read":1,"Skill":1,
                                                    "AskUserQuestion":1}, d["tools"]
assert all(t["subagent_calls"]==0 for t in d["tools"]), d["tools"]
assert d["skills"]==[{"name":"inaros-swe:refine","calls":1}], d["skills"]
assert {m["model"] for m in d["models"]}=={"claude-opus-4-8","claude-haiku-4-5"}, d["models"]
# The activity series is a partition of the session: nothing dropped, nothing
# double-counted, one bucket per ACTIVITY_BUCKETS over a known span.
assert len(d["activity"])==60, len(d["activity"])
assert sum(b["messages"] for b in d["activity"])==d["messages"], d["activity"]
assert sum(b["tool_calls"] for b in d["activity"])==d["tool_calls"], d["activity"]
assert sum(b["total_tokens"] for b in d["activity"])==d["total_tokens"], d["activity"]
print("cc session: aggregate detail ok")
' || fail "cc session did not return the expected aggregate detail"

# Unknown session is not_found (exit 1), exactly like `cc graph`.
if "$BIN" cc session no-such-session >"$TMP/detail-err" 2>&1; then
  fail "cc session on an unknown session should have exited nonzero"
fi
python3 -c '
import json
d=json.load(open("'"$TMP"'/detail-err"))
assert d["error"]["code"]=="not_found", d
' || fail "cc session unknown session did not return error.code=not_found"
echo "cc session: unknown session -> not_found ok"

# `--quiet` is not accepted on any `cc` subcommand: unknown argument, exit 2.
RC=0
"$BIN" cc session a --quiet >/dev/null 2>&1 || RC=$?
[ "$RC" = "2" ] || fail "cc session --quiet expected exit 2, got $RC"
echo "cc session: --quiet rejected (exit 2) ok"

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
assert set(by)=={"session","tool:toolu_1","tool:toolu_2","tool:toolu_3","tool:toolu_4",
                 "agent:x1"}, sorted(by)
assert by["agent:x1"]["name"]=="Explore" and by["agent:x1"]["total_tokens"]==30, by["agent:x1"]
assert by["tool:toolu_1"]["tokens_are_rollup"] is False, by["tool:toolu_1"]
# The kind/name/target trio reaches HTTP identically to the CLI — one `core`
# builder, two surfaces.
assert by["tool:toolu_1"]["target"]=="grep -rn '"'"'x'"'"' src/", by["tool:toolu_1"]
assert by["tool:toolu_3"]["kind"]=="skill", by["tool:toolu_3"]
assert by["tool:toolu_3"]["name"]=="inaros-swe:refine", by["tool:toolu_3"]
assert g["total_tokens"]==1000, g
print("api cc graph: payload matches the CLI ok")
' || fail "GET /api/cc/sessions/{id}/graph did not match the CLI payload"

# The response node reaches HTTP identically — one `core` builder, two surfaces,
# including the emission order the frontend`s equal-ts tie-break depends on.
curl -sf "http://127.0.0.1:$PORT/api/cc/sessions/p/graph" | python3 -c '
import json,sys
g=json.load(sys.stdin)
assert [n["id"] for n in g["nodes"]]==["session","msg:p1","tool:pu_1","tool:pu_2","tool:pu_3"], g["nodes"]
r=[n for n in g["nodes"] if n["id"]=="msg:p1"][0]
assert r["kind"]=="response" and r["name"]=="Response", r
assert r["target"]=="Reading the file. Then tests.", repr(r["target"])
assert r["tokens_are_rollup"] is False and r["total_tokens"]==30, r
assert g["omitted_responses"]==0, g
print("api cc graph: response node ok")
' || fail "GET /api/cc/sessions/{id}/graph did not carry the response node"

STATUS=$(curl -s -o "$TMP/graph-404" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/no-such-session/graph")
[ "$STATUS" = "404" ] || fail "api cc graph: unknown session expected 404, got $STATUS ($(cat "$TMP/graph-404"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/graph-404"))
assert d["error"]["code"]=="not_found", d
' || fail "api cc graph: unknown session did not return error.code=not_found"
echo "api cc graph: unknown session -> 404 not_found ok"

# ---- cc session over HTTP: byte-identical to the CLI, plus the 404 ----
curl -sf "http://127.0.0.1:$PORT/api/cc/sessions/a" >"$TMP/detail-http" \
  || fail "GET /api/cc/sessions/{id} failed"
"$BIN" cc session a >"$TMP/detail-cli" || fail "cc session a exited nonzero"
python3 -c '
import json
h=json.load(open("'"$TMP"'/detail-http")); c=json.load(open("'"$TMP"'/detail-cli"))
# One `core` aggregator, two surfaces: same object, not merely a similar one.
assert h==c, (h,c)
assert h["total_tokens"]==1000 and h["tool_calls"]==4, h
assert len(h["agents"])==h["agent_runs"]==1, h
assert len(h["activity"])==60, len(h["activity"])
print("api cc session: payload matches the CLI ok")
' || fail "GET /api/cc/sessions/{id} did not match the CLI payload"

STATUS=$(curl -s -o "$TMP/detail-404" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/no-such-session")
[ "$STATUS" = "404" ] || fail "api cc session: unknown session expected 404, got $STATUS ($(cat "$TMP/detail-404"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/detail-404"))
assert d["error"]["code"]=="not_found", d
' || fail "api cc session: unknown session did not return error.code=not_found"
echo "api cc session: unknown session -> 404 not_found ok"

# ---- cc text over HTTP: same payload as the CLI, plus the three statuses ----
curl -sf "http://127.0.0.1:$PORT/api/cc/sessions/tx/nodes/tool:tt_1/text" >"$TMP/text-http" \
  || fail "GET /api/cc/sessions/{id}/nodes/{node}/text failed"
"$BIN" cc text tx tool:tt_1 >"$TMP/text-cli" || fail "cc text tx tool:tt_1 exited nonzero"
python3 -c '
import json
h=json.load(open("'"$TMP"'/text-http")); c=json.load(open("'"$TMP"'/text-cli"))
# One `core` reader, two surfaces: the same object, not merely a similar one.
assert h==c, (h,c)
assert json.loads(h["text"])["command"].endswith("BASH-TAIL"), h["text"][-60:]
print("api cc text: payload matches the CLI ok")
' || fail "GET /api/cc/sessions/{id}/nodes/{node}/text did not match the CLI payload"

# The three error codes map to three distinct statuses, the same split the CLI
# reports as one exit code with three `error.code` values.
STATUS=$(curl -s -o "$TMP/text-http-404" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/tx/nodes/tool:no-such-call/text")
[ "$STATUS" = "404" ] || fail "api cc text: unknown node expected 404, got $STATUS ($(cat "$TMP/text-http-404"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/text-http-404"))
assert d["error"]["code"]=="not_found", d
' || fail "api cc text: unknown node did not return error.code=not_found"

STATUS=$(curl -s -o "$TMP/text-http-422" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/tx/nodes/session/text")
[ "$STATUS" = "422" ] || fail "api cc text: session node expected 422, got $STATUS ($(cat "$TMP/text-http-422"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/text-http-422"))
assert d["error"]["code"]=="validation", d
' || fail "api cc text: session node did not return error.code=validation"

STATUS=$(curl -s -o "$TMP/text-http-503" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/a/nodes/tool:toolu_2/text")
[ "$STATUS" = "503" ] || fail "api cc text: deleted transcript expected 503, got $STATUS ($(cat "$TMP/text-http-503"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/text-http-503"))
assert d["error"]["code"]=="unavailable", d
' || fail "api cc text: deleted transcript did not return error.code=unavailable"
echo "api cc text: 404 / 422 / 503 split ok"

# ---- cc chat over HTTP: same payload as the CLI, plus its two statuses ----
curl -sf "http://127.0.0.1:$PORT/api/cc/sessions/cx/chat" >"$TMP/chat-http" \
  || fail "GET /api/cc/sessions/{id}/chat failed"
python3 -c '
import json
h=json.load(open("'"$TMP"'/chat-http")); c=json.load(open("'"$TMP"'/chat-cli"))
# One `core` reader, two surfaces: the same object, not merely a similar one.
assert h==c, (h,c)
print("api cc chat: payload matches the CLI ok")
' || fail "GET /api/cc/sessions/{id}/chat did not match the CLI payload"

curl -sf "http://127.0.0.1:$PORT/api/cc/sessions/cx/chat?limit=2" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert [t["id"] for t in d["turns"]]==["ct_1","ct_2"] and d["truncated"] is True, d
print("api cc chat: ?limit= ok")
' || fail "GET /api/cc/sessions/{id}/chat?limit= did not bound the turns"

STATUS=$(curl -s -o "$TMP/chat-http-422" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/not%20a%20session/chat")
[ "$STATUS" = "422" ] || fail "api cc chat: bad session id expected 422, got $STATUS ($(cat "$TMP/chat-http-422"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/chat-http-422"))
assert d["error"]["code"]=="validation", d
' || fail "api cc chat: bad session id did not return error.code=validation"

STATUS=$(curl -s -o "$TMP/chat-http-503" -w '%{http_code}' "http://127.0.0.1:$PORT/api/cc/sessions/no-such-session/chat")
[ "$STATUS" = "503" ] || fail "api cc chat: missing transcript expected 503, got $STATUS ($(cat "$TMP/chat-http-503"))"
python3 -c '
import json
d=json.load(open("'"$TMP"'/chat-http-503"))
assert d["error"]["code"]=="unavailable", d
' || fail "api cc chat: missing transcript did not return error.code=unavailable"
echo "api cc chat: 422 / 503 split ok"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
unset SERVER_PID

echo "ok: cc-check passed"
