#!/usr/bin/env bash
# Records a short scripted tour of the mesa web UI as an mp4, for promo use.
#
# Captures at the CDP level (Page.startScreencast) via a headless khora
# session — never the physical screen — so it can't leak whatever else is on
# the host display, and works unattended. A synthetic cursor dot is injected
# into the page and moved to each target before every click, so the result
# reads as a person driving the app (no audio).
#
# Prereqs:
#   - `mesa serve` running against a THROWAWAY db (never the live dev
#     instance) with seed-demo-data.sh already run against it.
#   - khora, ffmpeg on PATH; node with global WebSocket (node >= 21).
#
# Usage: BASE_URL=http://127.0.0.1:7799 scripts/record-demo/walkthrough.sh <outDir>
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:7799}"
OUT="${1:?usage: walkthrough.sh <outDir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$OUT"
rm -f "$OUT/STOP"

CURSOR_INIT='(function(){
  if (window.__demoCursor) return "ok";
  var d = document.createElement("div");
  d.id = "__demo_cursor__";
  Object.assign(d.style, {
    position: "fixed", width: "18px", height: "18px", borderRadius: "50%",
    background: "rgba(255,255,255,0.9)", border: "2px solid #22d3ee",
    boxShadow: "0 0 12px rgba(34,211,238,0.9)", zIndex: 999999,
    pointerEvents: "none", left: "-50px", top: "-50px",
    transform: "translate(-50%,-50%)", transition: "left .35s ease, top .35s ease"
  });
  document.body.appendChild(d);
  window.__demoCursor = function(x,y){ d.style.left = x+"px"; d.style.top = y+"px"; return true; };
  window.__demoCenter = function(sel){
    var e = document.querySelector(sel);
    if(!e) return null;
    var r = e.getBoundingClientRect();
    return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)};
  };
  return "ok";
})()'

launch_json=$(khora -f json launch --window-size 1440x900)
SID=$(echo "$launch_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
WS=$(echo "$launch_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['ws_url'])")
CDP_PORT=$(echo "$WS" | sed -E 's#ws://127\.0\.0\.1:([0-9]+)/.*#\1#')
cleanup() { khora kill "$SID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

khora navigate "$SID" "$BASE_URL/#/projects/1" >/dev/null
sleep 1.5

PAGE_WS=$(curl -s "http://127.0.0.1:$CDP_PORT/json" |
  python3 -c "import json,sys
for t in json.load(sys.stdin):
    if t.get('type')=='page':
        print(t['webSocketDebuggerUrl']); break")

node "$HERE/recorder.mjs" "$PAGE_WS" "$OUT" > "$OUT/recorder.log" 2>&1 &
REC_PID=$!
sleep 0.5

khora eval "$SID" "$CURSOR_INIT" >/dev/null

move_to() {  # move_to <selector>
  local sel="$1" center x y
  center=$(khora -f json eval "$SID" "window.__demoCenter('$sel')")
  if [ "$center" = "null" ]; then return 1; fi
  x=$(echo "$center" | python3 -c "import json,sys;print(json.load(sys.stdin)['x'])")
  y=$(echo "$center" | python3 -c "import json,sys;print(json.load(sys.stdin)['y'])")
  khora eval "$SID" "window.__demoCursor($x,$y)" >/dev/null
}

demo_click() {  # demo_click <selector> <settle_seconds>
  local sel="$1" settle="${2:-0.9}"
  khora wait-for "$SID" "$sel" --timeout 4000 >/dev/null
  move_to "$sel"
  sleep 0.45
  khora click "$SID" "$sel" >/dev/null
  sleep "$settle"
}

# --- tour ---------------------------------------------------------------
sleep 1.2                                            # board, first impression
demo_click 'a[href="#/projects/1/tasks/5"]' 1.4       # blocked task + deps
demo_click '.panel-close' 0.6
demo_click 'a[href="#/projects/1/tasks/2"]' 1.4       # in-progress task + subtask
demo_click '.panel-close' 0.6
demo_click '.tabs button:nth-of-type(3)' 1.0          # Storyboards tab
demo_click 'a[href="#/projects/1/storyboards/1"]' 1.8 # Checkout Flow canvas
demo_click 'a[href="#/projects/2"]' 1.6                # switch project
demo_click 'a[href="#/inbox"]' 1.4                    # global inbox
# --------------------------------------------------------------------------

touch "$OUT/STOP"
wait "$REC_PID"
echo "captured to $OUT" >&2
