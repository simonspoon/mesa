# Agents (live Claude Code sessions)

The persistent **Agents sidebar** lists Claude Code sessions across projects,
starts new background ones in a selected project's `local_path`, and embeds
terminals attached to running sessions. Like the CC Dashboard it reads
**external** state — here by shelling out to the `claude` CLI
(`src/core/agents.rs`; `MESA_CLAUDE_BIN` overrides the binary for tests) — and
touches the mesa store only to read `local_path`. There is deliberately no
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
  **502 `unavailable`** on both endpoints. Both this route and the list route
  run their subprocess under `spawn_blocking` and hold no lock across it, so
  spawns do **not** serialize behind agent-list polls — a slow spawn observed
  under a *stub* `claude` is a stub artifact, not a mesa lock: `output()`
  waits for pipe EOF, so a stub that forks a fake long-lived session hangs
  the call for that child's lifetime (mesa task 468 — reproduced at 30s;
  the real CLI returns in ~1.0s, idle or with a prompt). Keep stub `--bg`
  branches fork-free.
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
  sidebar (below) and shares `agents_cache` with the per-project route under a
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
- Gate: `scripts/agents-check.sh` (stub `claude`, asserts the JSON contract and
  the local_path CLI plumbing). The WS bridge itself is verified by live QA.

## Global Agent sidebar

A persistent, collapsible right-hand rail (`AgentSidebar`,
`frontend/src/components/AgentSidebar.tsx`) shows every live session across
every project, with room to attach several at once, arranged as a tree of
resizable/rearrangeable, mixed-orientation panes. The session list itself is
**not** one of those panes (mesa task 414 pulled it out of the tree): it's a
fixed rail docked to the sidebar body's own right edge
(`.agent-sidebar-list-rail`), always full body height, with its own
independent drag-resize handle and collapse toggle — separate from the tile
area beside it, where the tree of attached agent panes lives and reflows
into whatever space the rail leaves. Rendered once in `App.tsx`, as a sibling
of `<main>` outside the hash router, so it is never remounted by navigation;
the same persistent-shell pattern the left `Sidebar` and `CommandPalette`
already use.

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
  no header at all (not an empty section). This bucketed list is the body of
  the 'Agents' rail's own content (`AgentListContent`), rendered directly by
  `AgentSidebar` next to the tile area — not a member of the pane tree below.
- **The 'Agents' list rail** (mesa task 414): a fixed sibling of the tile
  area inside `.agent-sidebar-body` (a row flexbox), not a tree leaf.
  `listWidth`/`listCollapsed`/`listResizing` are their own `AgentSidebar`
  state, independent of the tile area's `root` tree and of the whole
  sidebar's own `width`/`collapsed`. Its own drag-resize handle
  (`.agent-sidebar-list-resize-handle`, hand-rolled `mousedown`/
  `document`-level `mousemove`/`mouseup`, same pattern as the sidebar's own
  width handle) reads the distance from the pointer to the sidebar body's
  own right edge (measured off a `bodyRef` rect, not the viewport), floored
  on both sides — `MIN_LIST_WIDTH` for the rail, `MIN_TILE_WIDTH` for the
  tile area beside it — so dragging one can't squeeze the other to nothing.
  Its own collapse toggle (`.agent-sidebar-list-toggle`, a `‹`/`›` button in
  the rail's own header) shrinks it to a thin full-height strip
  (`.agent-sidebar-list-rail.collapsed`), independent of the whole sidebar's
  own collapse — collapsing the rail hands its space back to the tile area;
  collapsing the whole sidebar (below) hides both.
- Layout: **agent** panes live in a **split-tree** (`SplitNode`/`LeafNode` in
  `AgentSidebar.tsx`), not a flat list — the tile area beside the list rail.
  Each node is either a leaf (one **pane** — `PaneShell`, wrapping an
  attached agent terminal via `AgentPane`, rendered through the shared pty
  pool — see below) or a split: an ordered list of children, each carrying
  its own `ratio` (that slot's flex-grow share within the split) and
  oriented `row` (side-by-side) or `column` (stacked). The root is always a
  split node, never a bare leaf, but an **empty** one (no children) is a
  valid and common state — no agent panes open, just the list rail beside an
  empty tile area. Clicking a session in the list rail toggles its **agent**
  pane in or out of the tree (`insertLeaf`/`removeLeaf`); a new pane always
  appends to the **root** split's own children, regardless of how deep or
  mixed the tree has become elsewhere — there's no "insert into the
  currently-focused split" concept. An agent pane's **close** button removes
  it from the shared pty pool (below) and detaches (the background session
  itself keeps running, unaffected — same contract as the per-project tab's
  detach) without touching any other open pane. `SplitNodeView`, the
  component that recursively renders one split's own direct children, is
  declared at module scope (not nested inside `AgentSidebar`) so its
  identity never changes across a re-render — nesting a per-split component
  inside `AgentSidebar`'s body would remount every open pane's `PtySlot`
  beneath it on every poll tick.
  - **Mixed orientation via a per-divider toggle**: every divider carries a
    small button (`.agent-sidebar-divider-toggle`, centered on the strip)
    showing the orientation clicking it would *produce* — `⬌` on a column
    divider (splits its two adjacent panes side-by-side), `⬍` on a row
    divider (stacks them back). Clicking it extracts that divider's two
    adjacent children, wraps them in a new split node of the opposite
    orientation, and splices that node back into the same slot — this is
    the one mechanism for going from a flat stack to a mixed, arbitrarily
    nested layout, and back. There's no global toggle, context menu, or
    per-pane toolbar; the interaction stays scoped to the exact divider the
    tree operation affects. The toggle button's `onClick` stops propagation
    so the divider's own resize-drag `onMouseDown` never also fires on the
    same gesture, and the drag handler separately ignores the button as a
    mousedown target (belt-and-suspenders, since `mousedown` precedes
    `click`).
  - **Pruning via canonicalization**: every tree mutation (toggle, close,
    reopen) is followed by canonicalizing the whole tree against three
    rules — drop a split left with zero children, inline a split left with
    exactly one child (its lone child takes over the wrapper's own ratio
    slot), and merge a split into its parent when both share the same
    orientation (the child's own children splice in directly, ratios
    rescaled to fit the slot's budget). The merge rule is what makes
    toggling a divider and toggling it back a true round trip — without it,
    nesting would only grow and a second toggle would stop restoring the
    original layout. Together the three rules guarantee a close (or a
    toggle that leaves a split empty or singleton) never renders a dangling
    empty or zero-size region, and reopening a previously-closed agent from
    the session list appends a fresh pane at the root without disturbing the
    rest of the layout.
  - **Resizable**: a divider between two adjacent children
    (`.agent-sidebar-pane-divider`) is drag-resizable — hand-rolled
    `mousedown`/`document`-level `mousemove`/`mouseup`, the same pattern as
    the sidebar's own width handle below. The drag is axis-aware per the
    divider's own split: it reads `clientX` and resizes width for a `row`
    divider, `clientY` and resizes height for a `column` divider, measured
    against that split node's own container (not the whole sidebar), so a
    divider several levels deep resizes only its own two adjacent children
    regardless of how the rest of the tree is shaped. Floored at
    `MIN_PANE_PX` so a drag can't collapse a pane to zero.
  - **Rearrangeable**: each pane's header still has a drag grip (`⠿`,
    `.agent-sidebar-pane-grip`) wired to `@dnd-kit/sortable`
    (`useSortable`/`SortableContext`) — the same library and pattern
    `KanbanBoard.tsx` uses for column drag-and-drop, but scoped per split
    node instead of one flat list: one `SortableContext` per `SplitNodeView`
    instance (all nested under the sidebar's single top-level `DndContext`,
    dnd-kit's standard multi-container pattern), listing only that split's
    own **leaf** children — a nested split occupying a sibling slot has no
    grip and isn't itself draggable. `strategy` follows the split's own
    orientation: `horizontalListSortingStrategy` for `row`,
    `verticalListSortingStrategy` for `column`. `collisionDetection` is
    `pointerWithin`, not dnd-kit's default — every pane can span the whole
    sidebar, so resolving the drop target off the *dragged pane's own*
    (translated) box would let a wide/tall pane's box overlap several
    candidates the cursor isn't even over; `pointerWithin` picks whichever
    pane the raw pointer position is actually inside.
  - **Drop position on the target pane picks between two gestures** — a
    center 40%×40% box vs. the outer edges, quartered into left/right/
    top/bottom by whichever axis the pointer deviates from center more
    (`computeDropEdge`, the standard tiling-WM/VS-Code docking read; a
    cyan `.agent-sidebar-pane-drop-indicator` previews the live zone,
    updated continuously via `onDragMove`):
    - **Center → reorder/move.** Same parent split: a plain sibling
      reorder (`arrayMove`). Different parent split: a cross-split move
      (`moveLeaf`) — the dragged leaf slots into the target's own index in
      *its* split, taking on `DEFAULT_RATIO` there.
    - **Edge → split.** `splitLeafAt` wraps the target and the dragged leaf
      in a brand-new split node — row for a left/right edge, column for
      top/bottom, ordered so left/top puts the dragged leaf first — and
      replaces the target's own slot with that wrapper (which inherits the
      target's ratio there; target and the newly split-in leaf share
      `DEFAULT_RATIO` between themselves). If the new wrapper's
      orientation matches its own parent split's, `canonicalize` splices
      its two children straight back out flat on the next render — which
      is the intended outcome, not a bug to special-case around: dropping
      on the left/right edge of a pane that's already in a row split just
      means "insert as its row-sibling here."
    Either gesture reuses the same per-leaf sortable drop targets — `over`
    is always another leaf's id, in whichever split it lives in, no
    separate `useDroppable` surface for the edge case.
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
- **Split and cross-split move also never drop a live session.** A
  drag-to-edge split or a cross-split move reparents a leaf under a
  freshly-minted split-node id, which would otherwise remount every leaf
  underneath — including its attached terminal, since React's keyed
  reconciliation only compares siblings within one parent's array in one
  commit. Each pane's terminal is therefore never rendered directly at its
  tree position: it's portaled once into a stable, pool-owned DOM container
  (`frontend/src/lib/ptyPool.ts` + an always-mounted `PtyPool` + a `PtySlot`
  placeholder at each tree position — shared verbatim with the Terminal
  page, `docs/terminal.md`), and a tree position just relocates that
  container via `appendChild` whenever it mounts there. Only an explicit
  close removes an entry from the pool, so a reorganize preserves the
  `claude attach` scrollback and connection with no reconnect banner. Built
  primarily for the Terminal page's stronger requirement (there's no
  background session to reconnect to there, so the pre-fix behavior was an
  unrecoverable process kill, not just a lost scrollback); fixed here as an
  incidental consequence of sharing the same mechanism.
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
- **Starting a new agent**: a `+ agent` button (`agent-sidebar-add`) sits in
  the header actions next to maximize, visible only while expanded. It opens
  a small form (`agent-sidebar-add-form`) above the pane tree — a project
  `<select>`, an optional first-prompt text input, and start/cancel — rather
  than being part of the split tree itself (it starts a session; it isn't
  one). The project picker only lists projects with a linked folder
  (`local_path` set), since that's where `POST /api/projects/{id}/agents`
  runs `claude --bg` and a folderless project would just 400; it defaults to
  the project currently in focus (App's `activeProjectId`, the same value
  the left `Sidebar` highlights) if that project is startable, else the
  first startable project, else empty. Submitting calls
  `spawnProjectAgent` and inserts the returned id straight into the pane
  tree via `insertLeaf`, so the new
  session opens attached immediately instead of waiting for the next list
  poll.
- **Auto Tile** (mesa task 411): a toggle (`agent-sidebar-autotile`) in the
  header actions, next to maximize, visible only while expanded. Off by
  default. While on, an effect keyed on `sessions` (the poll result, not the
  per-render sorted `agents` copy — so it only re-runs when a poll actually
  returns new data) keeps the pane tree in sync with agent state instead of
  requiring a click per open/close: every attachable session (`id !== null`)
  in the ACTIVE or BLOCKED bucket without an open pane gets one
  (`insertLeaf`), and every open pane whose session has reached DONE gets
  closed (`ptyPool.remove` + `removeLeaf`) — both buckets auto-open, not just
  ACTIVE, since a blocked agent is the one most likely waiting on the user.
  The effect depends on `autoTile` itself, so switching it on syncs
  immediately against whatever `sessions` already holds rather than only
  reacting to future transitions; switching it off just stops the sync — it
  never force-closes panes auto-tile had opened. Interactive sessions
  (`id === null`) are skipped, same as everywhere else in the sidebar — there
  is no pane to open for them.

  **While on, Auto Tile owns the layout** (mesa task 466): the tree is
  rebuilt as a grid (`buildGrid`) rather than patched pane-by-pane, because
  adding a 4th agent to a 3-pane row has to re-tile everything to reach 2x2.
  Column count comes from `gridColumns(n, width, height)` — it scores every
  column count whose cells clear `MIN_GRID_PANE_PX` (360px, below which a
  terminal wraps into slivers) by how far the resulting cell aspect sits from
  a target of 1.4 on a log scale, plus a small penalty per empty grid slot,
  and takes the best. So a 448px-wide sidebar still stacks vertically no
  matter how many agents run, a ~1400px one puts 4 panes in 2x2 and 6 in 3x2,
  and 2 panes go side by side. Leaves fill row-major (pane `i` → column
  `i % cols`), ordered oldest-first, so a newly started agent appends to the
  end instead of shuffling every existing pane one cell along.

  The width/height fed to `gridColumns` is the **tile area's live measured
  rect** (a `ResizeObserver` on `agent-sidebar-tile-area` → `tileSize`), not
  the sidebar's `width` state: that box is resized three independent ways
  (sidebar drag, maximize, list-rail collapse/resize), so a `width`-derived
  guess would be wrong in most of them. The rebuild is skipped unless the
  pane set or the column count actually changed (`autoTileColsRef`), so
  dragging the sidebar a few px wider — or a poll that returns the same
  agents — leaves the user's own divider positions and manual rearrangement
  intact. A manual drag does get overwritten the next time an agent starts
  or finishes; that is the trade the mode asks for, and turning Auto Tile off
  freezes the layout as-is.

  Because of that guard, panes opened **by hand** while the mode is on (a
  list-rail click, or `+ agent`) must re-tile rather than root-append, and
  both go through `addPane` for exactly that reason: `insertLeaf` would drop
  the new leaf in as a full-height extra column of the row-oriented grid, and
  the next poll — seeing a pane set that already matches the sessions list —
  would leave it that way indefinitely. `addPane` rebuilds the grid with the
  new id appended, which is also what makes a `+ agent` pane appear tiled
  immediately instead of on the next poll.
