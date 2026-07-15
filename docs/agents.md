# Agents (live Claude Code sessions per project)

The **Agents** tab on a project page (web UI, `#/projects/:id/agents`) lists
the Claude Code sessions running under the project's `local_path`, starts new
background ones, and embeds a terminal attached to a running one. Like the CC
Dashboard it reads **external** state — here by shelling out to the `claude`
CLI (`src/core/agents.rs`; `MESA_CLAUDE_BIN` overrides the binary for tests) —
and touches the mesa store only to read `local_path`. There is deliberately no
`mesa agent` CLI: an agent in a terminal would just use `claude` directly.

- `GET /api/projects/{id}/agents` → `{path, agents}` via `claude agents
  --json` (sessions started under that folder, background and interactive),
  filtered to `local_path` **in Rust** (`agents::is_under`) against each
  session's own `cwd`, not via `claude`'s `--cwd` flag — live QA on mesa task
  310 found a session whose cwd exactly equaled the filter dir missing from
  `--cwd`-filtered output while present unfiltered (task 313); the exact
  trigger was never characterized, so mesa filters deterministically instead
  of trusting that black box. Cached 2s per folder in
  `AppState.agents_cache` (each list call costs ~0.5s of node startup; the UI
  polls every 3s). No `local_path` → `{path: null, agents: []}`, not an error.
- `POST /api/projects/{id}/agents` (body `{prompt?}`) → runs `claude --bg` in
  `local_path` and returns `{id}` — the short job id parsed from the
  "backgrounded · <id>" receipt. Without a prompt the session starts idle.
  No/missing `local_path` is `validation`; a failing/missing `claude` CLI is
  **502 `unavailable`** on both endpoints.
- `GET /api/agents/{id}/attach?cols=&rows=` upgrades to a **WebSocket bridged
  onto `claude attach <id>` in a PTY** (`bridge_attach` in `src/api.rs`,
  portable-pty): server→client binary frames are raw terminal output;
  client→server binary frames are keystrokes, text frames are JSON control
  (`{"resize":{cols,rows}}`). Closing the socket kills only the attach client —
  the background session keeps running (claude's own attach/detach contract).
  Only background sessions (those with a short `id`) are attachable;
  interactive ones are listed as not-attachable.
- `GET /api/agents` → `Vec<AgentSession>` (bare array, no `path` wrapper) via
  `claude agents --json` with **no `--cwd` filter** — every live session on
  the machine, across every project's folder at once. Backs the global Agents
  sidebar (below); the per-project route above is for the project-scoped
  Agents tab. Shares `agents_cache` with the per-project route under a
  sentinel key (`ALL_AGENTS_CACHE_KEY`, a NUL-prefixed string no real
  `local_path` can equal) — same 2s TTL, same "collapse concurrent polls"
  rationale, just keyed once instead of per-folder.
- **All four agent routes share one mode-dependent access gate**,
  `require_agent_access`. Terminal access is code execution — a strictly
  stronger capability than the task CRUD the rest of the API exposes — so the
  browser-as-confused-deputy holes stay closed in BOTH modes; what differs is
  who may connect:
  - **Default (loopback) mode** stacks three checks: `require_loopback` (peer
    address via `ConnectInfo` — refuses any non-local peer), `require_local_host`
    (Host allowlist — the DNS-rebinding defense: a same-origin GET carries no
    Origin and the peer is the victim's own loopback, so only the Host header,
    the page's rebound hostname rather than `localhost`, still distinguishes a
    rebinding page), and `require_local_origin` (Origin allowlist — refuses
    cross-site fetch/WebSocket; WebSockets are exempt from CORS, so the attach
    socket leans on this entirely; Origin-less non-browser clients pass).
  - **`--lan` mode** serves LAN peers (the opt-in "trust every device on the
    LAN" posture includes the terminal, so the web UI — including attach — works
    from a remote machine), but composes two ordered, interdependent checks
    (`require_lan_page_access`, also reused by the `local_path` write) that keep
    hostile *pages* out: `require_lan_agent_host` — Host must be
    `localhost:<port>` or an IP-literal on the serve port (plus the portless
    forms browsers send when the port is 80), which kills DNS rebinding without
    enumerating LAN addresses (a rebound page's requests carry its own DNS
    hostname, never an IP literal; browse the UI by IP from remote machines) —
    **then** `require_origin_matches_host` — a browser Origin must exactly match
    that vetted Host, **or** be a local page (embedded UI / vite dev) from a
    **loopback peer**. The loopback scope on the local-page allowance is
    load-bearing: without it a *remote* browser showing a hostile `localhost:*`
    page would pass and open the attach WebSocket cross-origin (the WS is exempt
    from CORS). Order matters — the Origin match trusts the Host, so the Host is
    validated first. The peer-sensitive branch is pinned by `src/api.rs` unit
    tests (the shell gate always sees a loopback peer).
- **Writing a project's `local_path` is loopback-only** (`require_local_path_write`
  on `create`/`update`, both modes): it is the folder `claude --bg` runs in —
  an execution anchor, not mere data — so a LAN peer (who under `--lan` can
  otherwise write any project field) must not point a future locally-triggered
  agent at a directory of their choosing. Under `--lan` the loopback peer alone
  is not enough (the global `guard` skips its Host check there, so a
  DNS-rebinding page on the server's own machine arrives with a loopback peer),
  so the agent routes' Host/Origin checks stack on top. Every other project
  field stays writable under `--lan`.
- Web UI: `AgentsView` under the project tabs — the attached terminal
  (`AgentTerminal`, xterm.js + fit addon over the attach socket) fills the main
  area, viewport-bound (the terminal scrolls, the page doesn't), with the
  session list + start form in a sub nav on the right (3s poll). All terminal
  I/O rides the server-side WebSocket bridge, so it works from remote machines
  under `--lan`. The vite dev proxy has `ws: true` for this socket.
- Gate: `scripts/agents-check.sh` (stub `claude`, asserts the JSON contract and
  the local_path CLI plumbing). The WS bridge itself is verified by live QA.

## Global Agent sidebar

A persistent, collapsible right-hand rail (`AgentSidebar`,
`frontend/src/components/AgentSidebar.tsx`) shows every live session across
every project — not scoped to one project's Agents tab — with room to attach
several at once, as resizable/rearrangeable stacked panes. Rendered once in
`App.tsx`, as a sibling of `<main>` outside the hash router, so it is never
remounted by navigation; the same persistent-shell pattern the left `Sidebar`
and `CommandPalette` already use.

- Data: `listAllAgents()` (`GET /api/agents`, 3s poll) for the session list,
  plus a plain `listProjects()` fetch (no poll) to label each session with the
  project whose `local_path` is a prefix of its `cwd` (longest match wins for
  nested folders) — the same path-prefix relationship `agents::is_under`
  matches on for the per-project route above. A session under no known
  project's folder shows its raw `cwd`.
- The session list is grouped into three collapsible sections — BLOCKED
  (`state === "blocked"`), ACTIVE (`state === "working"` or no `state` at all,
  which covers interactive sessions — those never get a `state`), and DONE
  (`state` is `done`/`failed`/`stopped`, i.e. the process has exited) — each a
  `<button>` header toggling its own `collapsedSections[bucket]` entry; DONE
  starts collapsed, BLOCKED/ACTIVE start open. `AgentSession` carries no
  completion timestamp (`claude agents --json` doesn't report one, only
  `startedAt`), so DONE is ordered by `startedAt` desc as the closest
  available proxy rather than a true completion time. An empty bucket renders
  no header at all (not an empty section).
- Layout: clicking a session toggles it into `openIds` (an ordered array, not
  a single `selectedId`) — any number of sessions can be attached at once,
  each its own **pane** (`Pane` in `AgentSidebar.tsx`, wrapping the same
  `AgentTerminal` the per-project Agents tab uses) stacked below the
  (always-visible) session list in `.agent-sidebar-panes`. Panes and their
  dividers are flat flex siblings, not nested per-pane wrappers — a pane's
  `flex-grow` (its share of the stack, in `ratios`) only competes correctly
  against its true siblings that way. A pane's **close** button unmounts its
  `AgentTerminal` and detaches (the background session itself keeps running,
  unaffected — same contract as the per-project tab's detach) without
  touching any other open pane.
  - **Resizable**: a divider between two adjacent panes (`.agent-sidebar-pane-divider`)
    is drag-resizable — hand-rolled `mousedown`/`document`-level
    `mousemove`/`mouseup`, the same pattern as the sidebar's own width handle
    below, converting a pixel delta into a ratio delta relative to the two
    panes' combined `flex-grow` so the same drag distance feels consistent
    regardless of pane count or current split. Floored at `MIN_PANE_PX` so a
    drag can't collapse a pane to zero.
  - **Rearrangeable**: each pane's header has a drag grip (`⠿`,
    `.agent-sidebar-pane-grip`) wired to `@dnd-kit/sortable`
    (`useSortable`/`SortableContext`/`verticalListSortingStrategy`) — the same
    library and pattern `KanbanBoard.tsx` uses for column drag-and-drop.
    Dragging a grip reorders `openIds` via `arrayMove`.
- **Collapse never unmounts anything.** `collapsed` (default `true`) toggles
  a CSS class on the `<aside>`; the list and any attached terminal stay
  mounted underneath, hidden via `visibility: hidden` on the inner
  `.agent-sidebar-body` (not `display: none` or a conditional
  `{!collapsed && …}` render) — the layout box, xterm's fitted size, and the
  attach WebSocket are all untouched by a collapse/expand cycle. This is the
  feature's core guarantee: collapse the sidebar mid-session, expand it back
  later, and the terminal is still attached with no reconnect, exactly as if
  the tab had just been sitting in the background. `visibility` also avoids
  the pixel-clipping trap `overflow: hidden` alone has: content narrower than
  its own natural width but positioned inside the still-laid-out (just
  invisible) body can't peek through the collapsed rail's clipped edge.
- The list poll itself pauses while collapsed (`pollMs` only set when
  expanded) — nobody can see the list, and each poll costs a `claude agents`
  subprocess; reopening triggers an immediate one-off fetch.
- **Width**: the whole rail is drag-resizable from its left-edge handle
  (`agent-sidebar-resize-handle`), floored at `MIN_WIDTH` but with **no fixed
  upper cap** — it can be dragged arbitrarily wide. The only ceiling is a
  floor on `main`'s own width (`MIN_MAIN_WIDTH`), measured live off `main`'s
  `getBoundingClientRect()` on every drag move (so it tracks the left nav
  sidebar's actual current width, collapsed or expanded, rather than assuming
  one) — past that point `main`'s content (e.g. the CC Dashboard's cards)
  doesn't overflow the page so much as wrap into illegible slivers, which is
  the thing being floored against, not an arbitrary product limit like the
  sidebar's own old 720px cap. A separate **maximize** toggle
  (`agent-sidebar-maximize`) grows the panel to fill the whole main content
  area instead (`main` display:none via `:has()`), matching the storyboard
  canvas's own takeover-view expand toggle; `Escape` restores.
