# Terminal (shell panes)

The **Terminal** page is a global nav entry (`#/terminal`,
left `Sidebar` link next to Inbox) showing a pane-tree of real interactive
shells — plain `$SHELL` processes at `$HOME`, not `claude attach` sessions.
Unlike Agents, there is no server-side session registry: every websocket
connection to the backend endpoint spawns a **new** shell process and dies
with it, and the client owns the pane tree's shape entirely in its own state.
Mounted once, permanently, in `App.tsx` — never resolved into `<main>` — so
navigating to another page and back never disturbs an open pane.

- `GET /api/terminal/attach?cols=<u16>&rows=<u16>[&project=<i64>]` upgrades to
  a **WebSocket bridged onto a real shell in a PTY** (`terminal_attach` in
  `src/api.rs`, `portable-pty`): server→client binary frames are raw terminal
  output; client→server binary frames are keystrokes, text frames are JSON
  control (`{"resize":{cols,rows}}`) — the exact same wire protocol as
  `/api/agents/{id}/attach`, since both now share one `pump_pty` helper.
  Spawn command resolution: `$SHELL` env var, falling back to `/bin/sh`;
  `TERM=xterm-256color`. No path id — each connection is its own shell, so
  there's nothing to select. Closing the socket (from either side) kills that
  connection's shell process only; other open panes are unaffected.
- **cwd is `$HOME`, or a project's folder with `?project=<id>`** (the project
  Terminal tab, below). The path is never client-supplied: the id is resolved
  through the store to that project's `local_path`, and rejected exactly as
  `spawn_project_agent` rejects its own spawn folder — unknown id is
  `not_found`, unset or non-directory `local_path` is `validation` (422).
  Both fail the handshake *before* the upgrade, so a bad scope never spawns a
  shell somewhere the caller didn't ask for. This adds no new reachability:
  the gate below is unchanged, and any caller that clears it can already run
  `cd <anywhere>` in a `$HOME` shell.
- **Shares `require_agent_access` verbatim with the Agents attach
  endpoint** — same gate, same call shape, no new/weaker/stronger logic; see
  `docs/agents.md`'s "All four agent routes share..." writeup for the full
  loopback/Host/Origin stack and its `--lan` behavior, which applies here
  unchanged (a non-agent route reusing the same gate). The one thing worth
  restating for this surface specifically: a raw shell is a materially
  different *shape* of code execution than a scoped `claude attach <id>`
  bridge, but not a different *reachability class* — any peer that already
  clears this gate under `--lan` can reach unconstrained code execution today
  via `POST /api/projects/{id}/agents` (`claude --bg`), so gate-parity here
  isn't granting a new class of access, just a different shell for the same
  already-gated caller.
- One posture note worth calling out explicitly: because the Terminal page is
  always mounted (below) and seeds one shell pane by default, a `$HOME` shell
  spawns on **every app load, on any route** — not only once the user
  actually navigates to `#/terminal`. It's gated by the exact same
  `require_agent_access` check as ever; what's changed is that reaching the
  gate no longer requires an explicit "open Terminal" click first.
- No new error codes — denials are `require_agent_access`'s existing
  `validation`/403 shapes, unchanged.

## Pane-tree UI

Panes live in the same split-tree model as the Agent sidebar
(`frontend/src/lib/paneTree.ts`, extracted out of `AgentSidebar.tsx` and
shared by both surfaces) — a leaf is one pane, a split is an ordered list of
children each carrying a `ratio` and an orientation (`row`/`column`). The
Terminal page seeds one shell leaf on mount; since only a drag-to-split
creates new leaves in the shared tree engine and there's no session picker to
open one from, a page-header `+ new shell` button mints and appends a fresh
leaf directly to root (the one deliberate addition beyond the tree engine
itself). Resize (divider drag), split (drag a pane onto another's edge), and
rearrange (drag a pane's grip to reorder within its split, or to another
split's center to move across) work identically to the Agent sidebar's model
— see `docs/agents.md`'s "Layout" section for the full drag/drop-zone
mechanics, which this page reuses unchanged. Each pane's shell lifecycle is
independent: opening several panes runs distinct, concurrently-progressing
shells, and a pane's explicit **close** button kills only its own process,
leaving every other open pane's process and output untouched.

**Cross-nav persistence.** `TerminalPage` is mounted exactly once in
`App.tsx`, as a permanent sibling of `<main>`'s router outlet (not a branch of
the route-conditional `page` variable that resolves into `<main>` and
unmounts on every navigation) — the same pattern the Agent sidebar already
uses. Whichever of `<main>`/`<TerminalPage>` isn't the active route is
toggled with `visibility: hidden`, never `display: none` and never a
conditional render, since a `display:none` box collapses to zero size and
breaks `FitAddon.fit()`'s layout read for any pane resized while hidden (a
browser-window resize while the user is on a different page, for instance).
The result: navigating away from Terminal and back leaves every open pane's
websocket, PTY, and xterm scrollback completely untouched — no reconnect, no
PTY restart, verified via `ps` (same PIDs before/after) and a live command
(e.g. `sleep 300`) continuing exactly where it was.

**A pane's flex chain must carry `min-width: 0`, not just `min-height: 0`**
(mesa task 552). `.agent-terminal` and `.agent-terminal-screen` — the two
boxes `PtyTerminal` renders, shared by this page and the Agent sidebar — are
flex items, and a flex item defaults to `min-width: auto`, i.e. it refuses to
shrink below its content's min-content width. An xterm's content is a
character grid, so its min-content width is `cols × cell width`: when the
surrounding layout gets *narrower*, the box stays pinned at the old size,
`FitAddon.fit()` measures that stale width (it reads
`terminal.element.parentElement`), derives a cols count still too large, and
xterm re-lays-out — which resizes the box again and re-fires the
`ResizeObserver` that called `fit()`. The loop walks the terminal down two
columns per frame until it reaches the true fit, sending one
`{"resize":…}` frame per step: **89 frames measured from a single
un-maximize click**, i.e. 89 SIGWINCHes into the attached process. A raw
shell shrugs that off; the `claude attach` bridge does not — Claude Code's
Ink TUI redraws its prompt box on every one, which surfaced as the input box
steadily gaining line breaks. With `min-width: 0` on both boxes the same
click sends exactly 1. Both are required: `.agent-terminal-screen` alone
still stormed at 89, since its own parent still refused to shrink. The
mirror of the `display: none` trap above — that one collapses the measured
box to zero, this one pins it too wide.

**At the phone tier there is no split at all** (mesa task 560). Both this page
and the Agent sidebar render a single pane below 600px — `SoloShellPane` here,
`SoloAgentPane` there, plain siblings of the sortable versions rather than a
prop on them, since `useSortable` requires an enclosing `DndContext` and the
whole point is that there isn't one. `+ new shell` is not rendered, so the
tree cannot grow past the seeded leaf.

The tree itself is **not** pruned to match. The unrendered leaves keep their
sockets open in `PtyPool` with their containers detached, exactly as a leaf is
for one commit mid-reparent, so widening past 600px restores the layout with
every shell's scrollback intact (verified with distinct per-pane markers across
a 1440 → 390 → 1440 round trip). Pruning would have to kill them, and — as the
`PtySlot`/`PtyPool` section below says — a shell killed on this surface is
unrecoverable. This is also why it cannot be a CSS rule: `display: none` on a
live pane is the same zero-size-box trap the `visibility` toggle above avoids.
See `docs/mobile.md` for the rest, including the on-screen-keyboard sizing and
the measured frame counts.

**Counting a pane's outbound resize frames.** The measurement behind mesa task
552's number, and the one any change to the resize path owes: hook the socket
from inside the page and read `window.__sent`.

```js
const o = WebSocket.prototype.send
window.__sent = []
WebSocket.prototype.send = function (d) {
  window.__sent.push({ t: Math.round(performance.now()),
    s: typeof d === 'string' ? 'TEXT:' + d : 'BIN' })
  return o.apply(this, arguments)
}
```

Text frames are the `{"resize":{cols,rows}}` controls; binary frames are
keystrokes. A healthy transition sends **one** text frame per live PTY. A
climbing sequence (`…,52,54,55,56`) is `FitAddon` converging — expected after a
font-size change, and the signature of the task-552 feedback loop if it appears
after a plain width change.

**Surviving a split or move, not just navigation.** A drag-to-edge split or a
cross-split move reparents a leaf under a freshly-minted split-node id, which
would otherwise remount every leaf in that subtree — including its live
terminal — since React's keyed reconciliation only compares siblings within
one parent's array. Each pane's terminal is therefore never rendered directly
at its tree position; instead it's portaled once into a stable, pool-owned
DOM container (`frontend/src/lib/ptyPool.ts` + the always-mounted `PtyPool`
component + a `PtySlot` placeholder at each tree position, shared verbatim
with the Agent sidebar) that a tree position merely relocates via
`appendChild` whenever it mounts there. Only an explicit pane close removes
an entry from the pool; a plain reparent never does, so splitting or moving
an already-running pane preserves its process, scrollback, and cursor state
exactly as if it had never moved. This mechanism is what makes the Terminal
page's split/move safe at all (there is no backing session to reconnect to,
unlike `claude attach` — a killed shell here is unrecoverable), and it fixed
the Agent sidebar's own equivalent scrollback-loss issue as an incidental
consequence of being shared.

## Project Terminal tab

`#/projects/:id/terminal` is the same `TerminalPage` component rendered as a
project tab beside Files, with its shells rooted in that project's
`local_path` instead of `$HOME`. One optional `projectId` prop is the whole
difference: it picks the endpoint (`?project=<id>`, so the *server* resolves
the folder) and the scope key. Everything else — the tree engine, the
drag/split/resize model, `PtySlot`/`PtyPool`, `+ new shell` — is the global
page's code unchanged.

- **Every scope keeps its own pane tree**, in a module-level `Map` in
  `TerminalPage.tsx` keyed `global` / `project:<id>`. Unlike the global page,
  the tab is inside `<main>`'s routed content and therefore *unmounts* when
  you switch tabs. The panes' shells survive that on their own (they live in
  the always-mounted `PtyPool`, and a detached pool container is relocated,
  never recreated) — but the tree's *shape* is plain component state, which
  would reset to one fresh leaf and orphan every still-running pane. The map
  is what closes that gap; `ProjectTasksPage` renders the page with
  `key={`project-${projectId}`}` so switching projects is a fresh mount that
  restores the new scope's own tree. There is deliberately **no**
  second permanent mount and no `visibility` toggle for this surface: the
  pool already provides the process-level persistence that motivated the
  global page's permanent mount.
- **Sizing**: the embedded page adds `.terminal-page-embedded`, which drops
  the standalone padding/scroll and binds the pane body to the same
  `--tab-viewport-*` box the Files/Agents layouts use — inside the project
  frame's block flow, `flex: 1` has nothing to grow against and the panes
  would otherwise collapse to zero height. At the phone tier this box drops
  `--tab-viewport-min`'s 256px floor and hides its own
  `.terminal-page-header`: with an on-screen keyboard up the tab has 112px to
  work with, and the floor alone put the prompt back under the keyboard
  (`docs/mobile.md`). The global page keeps its header.
- **A project with no `local_path`** shows the Files/Git tabs' "no linked
  folder" placeholder instead of a pane tree, so the dead case is a quiet
  empty state, not a socket that opens and immediately closes. A
  `local_path` that is set but no longer a directory is left to the server's
  own `validation` rejection (the pane shows its "shell closed" banner) —
  there's no tree/status call on this tab to read that rung from.
- The `'a'` create-task shortcut is inert on this tab, like every other
  non-Board view (`ProjectTasksPage`'s `useCreateTaskShortcut`), on top of
  `shouldIgnoreShortcut`'s existing `.xterm`/`.agent-terminal` suppression.
