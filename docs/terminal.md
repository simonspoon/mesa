# Terminal (global shell panes)

The **Terminal** page is a global, non-project-scoped nav entry (`#/terminal`,
left `Sidebar` link next to Inbox) showing a pane-tree of real interactive
shells — plain `$SHELL` processes at `$HOME`, not `claude attach` sessions.
Unlike Agents, there is no server-side session registry: every websocket
connection to the backend endpoint spawns a **new** shell process and dies
with it, and the client owns the pane tree's shape entirely in its own state.
Mounted once, permanently, in `App.tsx` — never resolved into `<main>` — so
navigating to another page and back never disturbs an open pane.

- `GET /api/terminal/attach?cols=<u16>&rows=<u16>` upgrades to a **WebSocket
  bridged onto a real shell in a PTY** (`terminal_attach` in `src/api.rs`,
  `portable-pty`): server→client binary frames are raw terminal output;
  client→server binary frames are keystrokes, text frames are JSON control
  (`{"resize":{cols,rows}}`) — the exact same wire protocol as
  `/api/agents/{id}/attach`, since both now share one `pump_pty` helper.
  Spawn command resolution: `$SHELL` env var, falling back to `/bin/sh`; cwd
  is always `$HOME` (`directories::BaseDirs`); `TERM=xterm-256color`. No path
  id — each connection is its own shell, so there's nothing to select.
  Closing the socket (from either side) kills that connection's shell
  process only; other open panes are unaffected.
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
