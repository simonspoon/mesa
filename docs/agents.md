# Agents (live Claude Code sessions)

The persistent **Agents sidebar** lists Claude Code sessions across projects,
starts new background ones in a selected project's `local_path`, and embeds
terminals attached to running sessions. Like the CC Dashboard it reads
**external** state — here by shelling out to the `claude` CLI
(`src/core/agents.rs`; `MESA_CLAUDE_BIN` overrides the binary for tests) — and
touches the mesa store only to read `local_path`. There is deliberately no
`mesa agent` CLI: an agent in a terminal would just use `claude` directly.

**The spawn command is user-configurable** — `docs/config.md`.
`agents::spawn_bg` is the single spawn chokepoint (the two watchers and the
POST route all go through it) and runs the template
`~/.mesa/config.json` gives for that action; this route's key is
**`agent-spawn`**, defaulting to `{bin} --bg --agent {agent} -- {prompt}`. The
sections below describe that default. A replacement command owes mesa only its
exit code; see the `POST` route below on the `id: null` case.

**Every session mesa *starts* runs under an agent persona** by default:
`--agent <name>`, **`swe`** — mesa auto-dispatches engineering work, and the
generic assistant persona is the wrong front door for it.
`MESA_CLAUDE_AGENT` overrides the name; set it **empty** to drop the flag and
get a plain session (an unknown agent name is a hard startup failure in the
claude CLI, not a warning, so a machine without a `swe` agent needs this escape
hatch). The flag is placed after `--bg` and before the `--` prompt separator.
`claude agents --json` and the attach bridge don't start a session, so neither
takes it — and neither is affected by the templates, so a template pointing at
a different tool yields sessions the sidebar can't list or attach to.

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
- `POST /api/projects/{id}/agents` (body `{prompt?}`) → runs the
  `agent-spawn` command (`claude --bg` by default) in `local_path` and returns
  `{id}` — the short job id parsed from the "backgrounded · <id>" receipt, or
  **`null`** when the command printed no such line, which a configured
  replacement is entitled to do. A null id is still `201`: the session exists
  and the next list call shows it, mesa just has nothing to open an attach pane
  with. Without a prompt the session starts idle.
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
  (`state` is `done`/`failed`/`stopped`, **or** the stale-`working` case
  below) — each a `<button>` header toggling its own
  `collapsedSections[bucket]` entry; DONE starts collapsed, BLOCKED/ACTIVE
  start open. `AgentSession` carries no completion timestamp (`claude agents
  --json` doesn't report one, only `startedAt`), so DONE is ordered by
  `startedAt` desc as the closest available proxy rather than a true
  completion time. An empty bucket renders no header at all (not an empty
  section). Note DONE does **not** mean the process has exited: `claude
  agents --json` lists live processes, and every session it reports as `done`
  is still running (measured, mesa task 571 — 33 of 33). A `done` session is
  one that has finished its work, not one that has gone away.
- **`state` alone is not a reliable completion signal**, so `bucketOf` also
  reads `status`: a **background** session reporting `status === "idle"` and
  `state === "working"` is bucketed DONE (mesa task 571). Upstream computes
  `state` live — it is persisted nowhere, and `~/.claude/sessions/<pid>.json`
  has no `state` key — and it can stick at `working` indefinitely once a
  background session finishes its turn and goes idle. Measured on claude
  2.1.220: three inbox-watcher sessions sat at `idle`/`working` for 90+
  minutes after their final turn ended, while sessions with byte-identical
  transcript tails reported `done`. Ruled out as the mechanism: age (a `done`
  at 34m alongside a `working` at 90m), process liveness (all 39 alive), and
  the daemon's `bg settled` sweep (sessions reach `done` without one). The
  override is safe because `idle` + `working` has no legitimate meaning — a
  never-prompted session is `idle` + **`blocked`** (verified by spawning a
  bare `claude --bg`), a running one is `busy` + `working` (held steady
  across 20 samples over 40s, no flap to `idle`), and a finished one is
  `idle` + `done`. The `blocked` test stays first so an idle session that is
  genuinely *waiting* keeps its own bucket. This is an inference about
  upstream, not a fact from it, so the row still renders upstream's own
  `working` badge — muted, dashed, and tooltipped rather than suppressed.
  Because it is upstream behavior, the residue is worth re-checking against
  future `claude` releases: if `state` becomes trustworthy, this override
  becomes dead code rather than wrong code.
- **Two mesa-derived counts override `state` in the other direction**
  (mesa task 802): `liveShells` and `liveSubagents` on every `AgentSession`.
  Upstream buckets a session `done` the moment its turn ends, while the work
  that turn started is still running — mesa computes the liveness upstream
  doesn't report, so a session with either count nonzero is bucketed **ACTIVE**
  whatever its `state` says (`blocked` still wins: a session waiting on a
  permission prompt is waiting, not working).
  - `liveShells` counts the session pid's **direct** children whose `comm`
    basename is in `{zsh, bash, sh, dash}`, from **one** `ps -A -o
    pid=,ppid=,comm=` per list refresh — not one `ps` per session. Claude Code
    spawns one `/bin/zsh -c 'source …/shell-snapshots/… && eval …'` child per
    Bash tool call (it is *not* a persistent shell), so a live shell child *is*
    a Bash call in flight right now. The allowlist is why it is not an
    "any child" rule: every working session also carries a `caffeinate` child,
    which is not work — counting it would mark every session busy forever.
  - `liveSubagents` counts `<projects_dir>/*/<sessionId>/subagents/*.jsonl`
    whose mtime is within `cc::ACTIVE_SECS` (90s, shared with the CC
    dashboard's own liveness window). Subagents run **in-process** — there is
    no child to count — so a freshly written transcript is the only signal
    available. The project slug is unknown at this point, so every slug
    directory is checked for the session id, the same glob shape `cc.rs` uses.
  - Both probes **fail open to `0`**: no `ps` (or a platform without one), no
    projects dir, an unreadable folder or an unparseable row all yield `0`,
    never an `Err`. This is a best-effort liveness probe hanging off the agents
    endpoints and the todo watcher (`docs/todo-watcher.md`), and it must never
    turn either into a failure. Enrichment happens in `list_sessions`, so the
    per-project route, the global route and the `agents_cache` TTL all see the
    same numbers for the same one `ps`.
  - Neither field comes from the CLI payload, so both are `#[serde(default)]`
    (parsing `claude agents --json` must not require them) and both cross the
    wire camelCase. Regressions: the pure counters have Rust unit tests in
    `src/core/agents.rs` (a synthetic `ps` table, mtime windows, fail-open);
    `scripts/agents-check.sh` only pins that both fields are on the wire and
    `0` for the stub's nonexistent pids — faking a process tree from bash
    would test the fake.
- The stale-`working` test is `isStaleWorking` in `frontend/src/agentProject.ts`,
  **not** a local helper in `AgentSidebar.tsx`, because two surfaces ask the
  same question and must not drift: the sidebar's `bucketOf` above, and
  `isRunningAgent` — which drives the project sidebar's per-project
  "an agent is running here" dot (`Sidebar.tsx`). Fixing only the bucketing
  would have left that dot lit forever for a **todo**-watcher agent that went
  stale, since those spawn in a project's `local_path` and so do match a
  project (inbox-watcher sessions spawn in `$HOME` and match none, which is
  why the sidebar was the visible half of this bug and the dot was not).
  Note `isRunningAgent`'s `pid !== null` test is a *separate* condition and
  not a liveness check on the terminal states — see the DONE note above. This bucketed list is the body of
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
- **Every pane has two views: `term` and `chat`** (mesa task 814). `term` is
  the attached terminal — the original, and the only one you can type into.
  `chat` is the *same* session rendered as a conversation:
  human prompts and assistant replies as markdown bubbles, with each run of
  tool calls between them collapsed into one muted, expandable block. A
  terminal is a screen buffer — it cannot be scrolled back past its scrollback,
  selected across a reflow, or read on a phone; the chat view is the same
  session as ordinary text, which is what makes the phone tier work at all.
  - **Tool runs are collapsed by default**, except the run at the very end.
    Expanded, a session's tens of calls between two replies are a wall of
    shell that buries the conversation the view exists to show, and the
    summary line (`6 steps · EnterWorktree · Bash ×4 · Read`) already says
    what ran; the last run is the exception because on a live session it is
    what the agent is doing *right now*. An explicit click always wins over
    the default, which is why the state is `undefined`-means-default rather
    than a boolean.
  - **Known gaps, deliberate for now.** A tool call shows its *input* target
    and not its **result**, so the view answers "what is it doing" and not
    "how did that go" — the honest half of the conversation this does not
    carry. Adding results needs its own bounding policy (a result is
    unbounded and routinely megabytes, and the whole payload is a 3s poll),
    which is a design decision in its own right, not a widening of this one.
    There is likewise no in-pane **search** and no **subagent** turns (the
    read is main-thread-only, so a fanned-out `Task` is a dead end here).
  - **Data: `GET /api/cc/sessions/{sessionId}/chat`** (`docs/cc-dashboard.md`
    → *Session chat*), polled at 3s. That route reads the transcript file
    directly — no ingest, no store lock — which is what makes it pollable and
    what lets a session mesa spawned seconds ago have a chat view at all.
  - **Two ids, and this is the one place both are needed.** A pane is keyed by
    the short **background job id** (all `claude attach` takes), while a
    transcript is keyed by the **session id**. The session list is the only
    place they are carried together, so `sessionIdFor` resolves one from the
    other and the `chat` button is **disabled** (with the reason in its title)
    for a pane whose session has dropped out of the list.
  - **The terminal is hidden, never unmounted, while chat is showing** — the
    same choice, for the same reason, as the sidebar's own collapse below:
    `display: none` would zero the pty's measured box, so xterm would refit to
    nothing and the attach socket's scrollback would come back reflowed. Both
    views are absolutely positioned over one area, and the inactive terminal is
    `visibility: hidden`, so it keeps its real size. The **chat** is the
    opposite: it owns no connection, so it *is* unmounted when not showing, and
    while the whole sidebar is collapsed it stops polling — nobody polls a view
    nobody can see, the same rule the session-list poll follows.
  - **`chat` is the default view a pane opens in** (mesa task 820). Opening a
    pane is a *read* — you look at an agent to see what it is saying and doing,
    and only sometimes to type at it — so the pane starts in the view that
    answers that, and the terminal is one click away in the same header. The
    default is only the absent-key case: a pane whose session isn't in the
    session list has no transcript to render and still falls back to `term`
    (the same guard that disables the `chat` button), and a pane the reader has
    switched keeps their choice, closed panes included.
  - The view mode lives in `AgentSidebar` state keyed by pane id, not in the
    pane component and not on the tree leaf: a pane is remounted by any
    reparent (a drag-to-edge split, a cross-split move, an auto-tile rebuild),
    so pane-local state would snap back to the terminal on a layout change.
    Closed panes keep their key, so reopening a session restores the view it
    was last read in.
  - **The chat view can be typed into** (mesa task 844): a composer pinned to
    the bottom of the pane — a one-line textarea that grows with its content to
    a cap, and a drawn send icon (a flat `currentColor` polygon, the same
    vocabulary as the inbox transport glyphs, not a typed `➤`). Enter sends,
    Shift+Enter opens a line, and an all-whitespace message sends **nothing**
    (a bare `\r` would submit whatever the agent's own input box already
    holds). It is a flex sibling of the scroll box, not a `sticky` child, so
    the conversation never scrolls underneath it — in a 200px auto-tile that
    overlap is most of the last turn.
    - **There is no send API, and deliberately so.** The chat is a *render* of
      a transcript file; the only channel into a live session is the terminal
      the pane is already attached to. A composed message is therefore **typed
      into that PTY** — `ptyPool.send(<pane id>, chatSendKeys(text))` — exactly
      as a person at the terminal would type it, and the reply comes back
      through the ordinary 3s transcript poll like any other turn. No new
      route, no second write path into a session, and the whole
      `require_agent_access` gate on the attach socket already covers it.
    - The socket belongs to the pooled `PtyTerminal`, so it registers a writer
      with `ptyPool.setSender` **on open** and withdraws it on close/unmount;
      the **writer itself** answers whether the bytes went out, so
      `ptyPool.send` returns `false` both for a leaf with no writer and for one
      whose socket has left `OPEN` — a graceful close leaves the writer
      registered until the `close` event dispatches, and only the terminal
      holds the `readyState` that tells those apart. Either way the composer
      says so rather than dropping the message: a writer handed out during
      `CONNECTING` would swallow what was typed, and an outside writer has no
      keyboard in front of it to notice.
    - A **multi-line** message is wrapped in bracketed paste
      (`ESC[200~` … `ESC[201~`) rather than sent as raw newlines: a raw `\n` is
      the submit key in the agent's TUI, so three lines would arrive as three
      prompts. CRLF is normalised first, for the same reason. `chatSendKeys`
      (`frontend/src/agentChat.ts`, vitest-covered) is the one place that
      encoding lives.
    - This is the one thing the chat view can do that the terminal cannot do
      better, and it is why the pane defaults to `chat`: read what it is doing,
      say the next thing, without switching views.
  - **Untrusted text, rendered as markup — deliberately, and narrowly.** Every
    body here is model-authored transcript text, which the CC surfaces
    otherwise render only as a text child or a `title`. The chat view is the
    one place it becomes formatted output, because that *is* the feature. It
    is safe by construction, not by sanitizing: the shared `Markdown`
    component passes **no raw HTML** through (there is no `rehype-raw`, so
    embedded markup renders as inert text), react-markdown strips unsafe URL
    schemes, links carry `rel="noreferrer"`, and `resolveImageSrc` is wired to
    refuse **every** image — so an `![](https://tracker/…)` in a transcript can
    never make the browser issue a request *on its own*. A `[link](…)` still
    becomes a real anchor (and remark-gfm autolinks a bare URL): that is a
    click-gated navigation, not a fetch, and it is the deliberate line — prose
    with working links is the point; prose that phones home on render is not.
    Tool names and targets stay plain text children. Do not add `rehype-raw`
    here, and do not resolve images.
  - Pure logic (turn grouping, the tool-run summary, the clock, the
    follow-the-tail predicate) is `frontend/src/agentChat.ts`, vitest-covered
    per CLAUDE.md's frontend-test rule; `AgentChat.tsx` is a thin renderer over
    it. The chat auto-scrolls to the newest turn **only while the reader is
    already near the bottom**, so scrolling up to read something older is never
    yanked back by the next poll.
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
  area instead (`main` display:none via `:has()`), matching the diagram
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
  Because this keys off `bucketOf`, the stale-`working` override above fixes
  auto-tile too: before it, a finished session stuck at `idle`/`working` was
  never in DONE, so its pane stayed open indefinitely and a new one opened
  for every subsequent agent (mesa task 571).
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

## Live-agent marker on Board cards

A kanban card pulses while a live Claude Code session looks like it is working
on that task (mesa task 663) — so the Board shows *live activity*, not just
stored status. The signal is the same `listAllAgents()` feed the sidebar polls
(3s, riding the server's existing 2s cache — an open board adds no extra
`claude agents --json` cost), passed down from `ProjectTasksPage` into
`KanbanBoard` and matched per card by `liveAgentCount()` in
`frontend/src/boardView.ts`.

Deliberately **not** a stored status: `in_progress` is already conveyed by the
column, and it goes stale when an agent crashes. So the marker fires in every
column, and an `in_progress` row whose agent is gone does not animate.

- **Match rule:** a session belongs to a task when its `name` is exactly
  `"{project.name}: {task.name}"` — the string the todo watcher spawns with
  (`src/api.rs`). The frontend holds both halves and reconstructs it.
- **Liveness** is the existing `isRunningAgent()` (`agentProject.ts`), the same
  predicate the sidebar's bucketing uses — `done`/`failed`/`stopped`, `pid:
  null` and the stale `idle`+`working` case (task 571) all leave a card
  unanimated. There is no second liveness predicate.
- **Best-effort by construction**, and it must always degrade to *no
  animation*: sidebar `+ agent` sessions carry no `--name`
  (`DEFAULT_AGENT_SPAWN` has no `{name}`) and never match; a replaced
  `todo-watcher` template without `{name}` loses the marker
  and nothing else; editing a task's `description` after dispatch changes the
  derived `name` and lapses the match; and two tasks in one project sharing
  their first 50 chars both animate. There is no task↔session column,
  migration or route to firm this up — it is a decoration.
- **Degradation:** `/api/agents` is gated and returns 502 `unavailable` with no
  `claude` binary. That error is never read or surfaced; before the first poll
  lands, and on any failure, the board renders exactly as it did before this
  feature — no marker, no banner, no console noise.
- Rendering: a `.live-dot.on` (the existing CC-dashboard live language) in
  `CardBody`, so the `DragOverlay` copy carries it too; tooltip `N agent(s)
  working`. Under `@media (prefers-reduced-motion: reduce)` the dot stays and
  only the pulse stops.
- Covered by vitest (`boardView.test.ts`) plus live QA; no CLI/API/db surface
  changed, so no `scripts/*-check.sh` gate moves.
