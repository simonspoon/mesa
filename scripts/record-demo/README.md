# record-demo

Produces a short, silent promo video of the mesa web UI: a scripted tour
driven by [khora](https://www.npmjs.com/package/khora) (CDP automation),
captured at the browser level via `Page.startScreencast` — never the host's
physical screen, so it can't leak whatever else is on the display and works
unattended in headless CI-style environments.

Always run against a **throwaway** `MESA_DB` + port, never a live/dev
instance — the tour deliberately starts at `#/projects/1` and never visits
`#/cc`, `#/agents`, `#/terminal`, or the Git/Files tabs, all of which surface
real host state (Claude Code telemetry, live agent sessions, the local
filesystem) that has no business in a promo video.

## Usage

```bash
# 1. Fresh db + server
export MESA_DB=/tmp/mesa-demo/demo.db
mesa serve --port 7799 &

# 2. Seed fictional demo data (creates projects 1-2, tasks 1-5, storyboard 1)
scripts/record-demo/seed-demo-data.sh

# 3. Record (headless khora session; ~15-20s tour)
BASE_URL=http://127.0.0.1:7799 scripts/record-demo/walkthrough.sh /tmp/mesa-demo/frames

# 4. Assemble into an mp4, preserving real frame pacing (variable frame rate)
python3 scripts/record-demo/assemble.py /tmp/mesa-demo/frames /tmp/mesa-demo/demo.mp4
```

## Files

- `recorder.mjs` — connects directly to a khora page's CDP WebSocket,
  starts a screencast, and dumps timestamped JPEGs + `manifest.json`.
  Generic: works for any CDP page target, not mesa-specific.
- `seed-demo-data.sh` — fixture data for the tour below. The frame/task ids
  it produces are hardcoded into `walkthrough.sh`'s selectors, so the two
  files change together.
- `walkthrough.sh` — launches headless khora, injects a synthetic cursor dot
  (moved via `khora eval` before each click so the recording reads as a
  person driving the app), and clicks through: board → a blocked task's
  dependencies → a task with a subtask → the storyboard canvas → a second
  project → the inbox.
- `assemble.py` — turns `manifest.json` + frames into an mp4 via ffmpeg's
  concat demuxer, holding each frame for its real on-screen duration.
