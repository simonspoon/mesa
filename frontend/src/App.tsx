import { useEffect, useState } from 'react'
import './App.css'
import { getCcUsage, getMesaVersion, getTask, listInbox } from './api'
import { AgentSidebar } from './components/AgentSidebar'
import { CommandPalette } from './components/CommandPalette'
import { PhoneTabBar } from './components/PhoneTabBar'
import { PtyPool } from './components/PtyPool'
import { Sidebar } from './components/Sidebar'
import { inboxFilterFor } from './inboxFilter'
import { unreadCount } from './inboxRead'
import { rememberView } from './lastView'
import { CCDashboardView, type CcTab } from './pages/CCDashboardView'
import { CCSessionDetailView } from './pages/CCSessionDetailView'
import { CCSessionTimelineView } from './pages/CCSessionTimelineView'
import { InboxView } from './pages/InboxView'
import { LiveHub } from './components/LiveHub'
import { ProjectTasksPage } from './pages/ProjectTasksPage'
import { ScriptsView } from './pages/ScriptsView'
import { SettingsView } from './pages/SettingsView'
import { TerminalPage } from './pages/TerminalPage'
import { isPhone, onPhoneTierChange } from './phoneTier'
import { useSpatialNav } from './spatialNav'
import { useFetch } from './useFetch'
import { usagePct, usageSeverity } from './usageMeter'
import { useVisualViewportHeightVar } from './visualViewport'

// Hash-based routing: #/ (placeholder), #/projects/:id,
// #/projects/:id/tasks/:tid (task open in the side panel),
// #/projects/:id/diagrams, #/projects/:id/diagrams/:sid,
// #/projects/:id/git (working-tree status + per-file diffs),
// #/projects/:id/files (file tree + content viewer),
// #/projects/:id/terminal (the Terminal page's shell panes, rooted at the
// project's local_path — the project-scoped twin of #/terminal below),
// #/projects/:id/dashboard (project-scoped CC telemetry),
// #/projects/:id/settings (this project's folder / parent / archive — not to
// be confused with #/settings, the global ~/.mesa/config.json editor),
// #/projects/:id/create-task (opens straight into the create-task form;
// closing/saving it returns to the plain project URL — see
// ProjectTasksPage's `createTask` prop), #/terminal (global shell pane-tree;
// TerminalPage is a permanent sibling mount, not resolved into `page` — see
// the render below), #/scripts (the global store of user-authored shell
// scripts and their generated run forms — global like #/inbox, since a script
// may bind a project but does not have to). The spoken conversation is no
// route at all (mesa task 857): it lives in the header (`LiveHub`), which is
// mounted for the life of the app, because a live turn may `navigate` this
// browser somewhere else and the conversation has to survive the navigation
// it just performed. `#/live` survives only as a verb — LiveHub intercepts it,
// opens the conversation panel — a right-hand sidebar since task 887,
// portalled into the `.live-slot` below — and puts the hash back.
//
// Every project-tab and #/cc route is *recorded* browser-local as the last
// view (`lastView.ts`), so the nav's project and CC Dashboard links reopen it.
// Links only — nothing here ever rewrites the hash, so these routes stay
// refresh- and back-stable.
function useHashPath(): string {
  // `rememberView` runs *before* the state update, not in an effect: the nav's
  // links read the remembered tab during render, and an effect would land a
  // render too late, leaving them one navigation stale.
  const read = () => {
    const p = window.location.hash.slice(1) || '/'
    rememberView(p)
    return p
  }
  const [path, setPath] = useState(read)
  useEffect(() => {
    const onChange = () => setPath(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return path
}

// Legacy #/tasks/:id links: resolve the task's project, then rewrite the
// hash into the panel route.
function LegacyTaskRedirect({ taskId }: { taskId: number }) {
  const { data: task, error } = useFetch(
    () => getTask(taskId),
    `legacy-task-${taskId}`,
  )
  useEffect(() => {
    if (task) {
      window.location.hash = `#/projects/${task.project_id}/tasks/${task.id}`
    }
  }, [task])
  if (error) return <p className="error">{error}</p>
  return <p className="muted">Loading…</p>
}

// The header's right-hand plan-limit chips (mesa task 834): how much of the
// Claude subscription's 5-hour and 7-day windows is spent, on every page. The
// same `/api/cc/usage` read the CC dashboard's Subscription Limits card makes
// — one live network call per server cache miss, so poll on its 60s TTL — and
// the same clamp/severity arithmetic (`usageMeter.ts`), never a second copy.
//
// Decoration, like the version beside the wordmark: it renders nothing while
// loading, on an error (no token, offline — a permanent state on a machine
// that never authenticated), or for a window the plan does not meter. The
// dashboard card is where an unavailable read is explained.
function HeaderUsage() {
  const { data } = useFetch(getCcUsage, 'cc-usage-header', { pollMs: 60000 })
  const windows: { label: string; title: string; pct: number }[] = []
  for (const [label, title, w] of [
    ['5h', '5-hour session window', data?.five_hour],
    ['7d', '7-day window (all models)', data?.seven_day],
  ] as const) {
    const pct = usagePct(w)
    if (pct !== null) windows.push({ label, title, pct })
  }
  if (windows.length === 0) return null
  return (
    <div className="header-usage" aria-label="Claude plan limits">
      {windows.map(({ label, title, pct }) => (
        <span
          key={label}
          className={`header-usage-chip ${usageSeverity(pct)}`}
          title={`${title} · ${pct.toFixed(0)}% of plan limit`}
        >
          <span className="header-usage-label">{label}</span>
          <span className="header-usage-pct">{pct.toFixed(0)}%</span>
        </span>
      ))}
    </div>
  )
}

// Cmd+Shift+P (Mac) / Ctrl+Shift+P (elsewhere) opens the command palette,
// wherever the app is mounted — checked via both metaKey and ctrlKey since
// the modifier differs by platform. Always preventDefault so the browser's
// own Ctrl/Cmd+Shift+P binding never fires underneath it.
function useCommandPaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])
}

function App() {
  const path = useHashPath()
  // Bumped after project create/rename/delete so the sidebar refetches.
  const [navVersion, setNavVersion] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // The element LiveHub portals its conversation panel into (mesa task 887).
  // State written by a ref callback, not read out of the DOM: the slot is
  // rendered in this same commit, so it does not exist while the hub above is
  // rendering, and the ref landing is what says it does now.
  const [liveSlot, setLiveSlot] = useState<HTMLDivElement | null>(null)
  useCommandPaletteShortcut(() => setPaletteOpen(true))
  // h/j/k/l + arrow-key spatial focus nav (mesa spec 449 story 454): a
  // second global window keydown listener, disjoint key set from the
  // shortcut above, mounted alongside it per arch-449-keyboard.md §3.
  useSpatialNav()
  // Keeps `--visual-viewport-height` current for the phone tier's
  // keyboard-aware shell (mesa task 560). Mounted here because `#root` is the
  // element the var sizes and App is the only permanent owner of it.
  useVisualViewportHeightVar()
  // Both sidebars' collapse state lives here rather than inside each of them
  // (mesa task 556): the phone tab bar's Agents/More slots open the drawers,
  // so a third party now drives what used to be two private booleans. The
  // sidebars are otherwise unchanged — in particular they are still permanent
  // mounts that only ever toggle CSS, never unmount, which is what keeps
  // AgentSidebar's live PTY sessions alive across a tab switch.
  //
  // The nav sidebar starts collapsed on phones (it is an overlay drawer
  // there); the agents sidebar defaults to collapsed at every width.
  const [navCollapsed, setNavCollapsed] = useState(isPhone)
  const [agentsCollapsed, setAgentsCollapsed] = useState(true)
  // `useState(isPhone)` above decides the nav drawer's state once, at mount,
  // and nothing re-decided it afterwards (mesa task 562; the flaw predates the
  // hoist to App and was filed against Sidebar.tsx, where it used to live).
  // That is not merely a stale default: the same boolean *means* two different
  // things either side of 600px — an in-flow sidebar above it, a fixed overlay
  // drawer below (`.sidebar:not(.collapsed)` in App.css's phone block) — so
  // crossing the boundary without re-deciding strands the nav in the other
  // tier's interpretation. Measured at 390x844: an expanded desktop sidebar
  // became a 256px overlay drawer nobody opened, and a collapsed phone rail
  // stayed a 34px stub on a 1200px window.
  //
  // Keyed on the *crossing*, not on the current value. A plain derived value
  // (`collapsed = phone`) would re-assert on every render and fight the user's
  // own toggle — reopening a drawer they just closed — so within a tier this
  // is inert and manual toggles survive (verified at 390 -> 375).
  useEffect(
    () =>
      onPhoneTierChange((phone) => {
        // Entering the phone tier collapses both drawers, because both become
        // fixed overlays there and neither was opened *as* one. Leaving it
        // only restores the nav: the nav's wide-screen default is expanded,
        // while the agents sidebar defaults to collapsed at every width, so
        // auto-expanding it on the way out would invent state nobody asked
        // for.
        setNavCollapsed(phone)
        if (phone) setAgentsCollapsed(true)
      }),
    [],
  )
  // One inbox poll for two badges. The sidebar's nav entry and the phone tab
  // bar both show the count of items still UNREAD (mesa task 831 — before it,
  // the count was every item, which never went down while triage was pending),
  // and a fetch each would let them skew by up to a poll interval —
  // `useFetch` caches nothing
  // across components, so an identical `key` in both would still be two
  // independent requests.
  const { data: inbox } = useFetch(() => listInbox(), 'inbox-nav', {
    pollMs: 5000,
  })
  const unread = unreadCount(inbox)
  // Which build am I looking at? Fetched once — a running server's version
  // cannot change, so no `pollMs`. Pure decoration: no error branch, and
  // nothing renders until it lands (a placeholder would be noise).
  const { data: mesaVersion } = useFetch(() => getMesaVersion(), 'mesa-version')

  // The inbox and its three sub-views (mesa task 845). One page, one fetch:
  // capture group 1 names the slice to show, and its absence is the "New"
  // triage queue, so the plain `#/inbox` URL every existing link uses still
  // lands where it always did.
  const inboxMatch = /^\/inbox(?:\/(read|archived))?$/.exec(path)
  const inboxFilter = inboxMatch ? inboxFilterFor(inboxMatch[1]) : null
  // Settings: global, above projects like the Inbox — the config file it edits
  // is per-machine, not per-project.
  const settingsMatch = /^\/settings$/.exec(path)
  // Scripts: global too. A script may bind a project (whose `local_path` is
  // then the run's cwd), but it is not a project tab — an unbound one runs in
  // $HOME and belongs to no project at all.
  const scriptsMatch = /^\/scripts$/.exec(path)
  // Terminal is not resolved into `page` (see below) — it's a permanent
  // sibling mount alongside `main`/`AgentSidebar` (mesa task 396,
  // .scratch/arch.md §4.3), toggled via `visibility` so panes and their
  // websockets survive navigating away and back. This match only drives
  // that visibility toggle and the nav's active-link highlight.
  const terminalMatch = /^\/terminal$/.exec(path)
  const terminalActive = terminalMatch !== null
  // CC Dashboard is the default landing view: the root path (#/ or empty) shows
  // the overview, and the brand link points back here. The three sub-pages
  // (#/cc/skills-agents, #/cc/projects, #/cc/sessions) carry the table views;
  // capture group 1 is the active sub-page, undefined for the overview.
  const ccMatch = /^\/(?:cc(?:\/(skills-agents|projects|sessions))?)?$/.exec(path)
  // One session, drilled into from the Sessions table: the aggregate detail
  // page by default, its timeline one link further in. Session ids are UUIDs,
  // but the segment is matched loosely and decoded rather than pattern-matched,
  // so an id shape change upstream can't silently 404 here.
  //
  // `/graph` is the timeline's old URL, kept as an alias so existing links and
  // bookmarks from the React Flow canvas era still land somewhere (mesa task
  // 691).
  //
  // The two patterns cannot swallow each other: the id segment is `[^/]+`, so
  // a trailing suffix can never be part of it and the detail pattern anchors
  // its end right after the id. Keep it that way — a `.+` there would make the
  // order of these two matches load-bearing.
  const ccDetailMatch = /^\/cc\/sessions\/([^/]+)$/.exec(path)
  const ccTimelineMatch = /^\/cc\/sessions\/([^/]+)\/(?:graph|timeline)$/.exec(path)
  // Both are drill-downs *of* the Sessions tab, so the nav keeps highlighting
  // Sessions while either is open.
  const ccTab = ccMatch
    ? ((ccMatch[1] ?? 'overview') as CcTab)
    : ccDetailMatch || ccTimelineMatch
      ? ('sessions' as CcTab)
      : null
  const diagramMatch = /^\/projects\/(\d+)\/diagrams\/(\d+)$/.exec(path)
  const diagramListMatch = /^\/projects\/(\d+)\/diagrams$/.exec(path)
  const gitMatch = /^\/projects\/(\d+)\/git$/.exec(path)
  const filesMatch = /^\/projects\/(\d+)\/files$/.exec(path)
  // Distinct from `terminalMatch` above: this one is a project tab rendered
  // inside `main`'s project frame (like Files/Git), not the permanently
  // mounted global page.
  const projectTerminalMatch = /^\/projects\/(\d+)\/terminal$/.exec(path)
  const dashboardMatch = /^\/projects\/(\d+)\/dashboard$/.exec(path)
  // The project's OWN settings tab (folder / parent / archive) — distinct
  // from `settingsMatch` above, which is the global config.json editor.
  const projectSettingsMatch = /^\/projects\/(\d+)\/settings$/.exec(path)
  // The project's own pane layout (mesa task 843) — the tab a tab-into-the-
  // main-area drag creates. URL-driven like every other project tab; the tree
  // it shows is machine-local (`projectPanes.ts`), and a project with no
  // remembered tree renders the Board here instead.
  const projectCustomMatch = /^\/projects\/(\d+)\/custom(?:\/tasks\/(\d+))?$/.exec(path)
  // Route the command palette's "Create task in <project>" entry navigates
  // to; ProjectTasksPage opens the create-task form on arrival and returns
  // to the plain project route once the form is closed or saved (spec
  // Assumption 2: the create panel itself stays ephemeral local state).
  const createTaskMatch = /^\/projects\/(\d+)\/create-task$/.exec(path)
  const projectMatch = /^\/projects\/(\d+)(?:\/tasks\/(\d+))?$/.exec(path)
  const legacyTaskMatch = /^\/tasks\/(\d+)$/.exec(path)
  const activeProjectId = diagramMatch
    ? Number(diagramMatch[1])
    : diagramListMatch
      ? Number(diagramListMatch[1])
      : gitMatch
        ? Number(gitMatch[1])
        : filesMatch
          ? Number(filesMatch[1])
          : projectTerminalMatch
            ? Number(projectTerminalMatch[1])
            : dashboardMatch
              ? Number(dashboardMatch[1])
              : projectSettingsMatch
                ? Number(projectSettingsMatch[1])
                : projectCustomMatch
                  ? Number(projectCustomMatch[1])
                  : createTaskMatch
                    ? Number(createTaskMatch[1])
                    : projectMatch
                      ? Number(projectMatch[1])
                      : null

  let page
  if (settingsMatch) {
    // ~/.mesa/config.json editor: no project frame, no active project.
    page = <SettingsView />
  } else if (scriptsMatch) {
    // Stored shell scripts + their run forms: global, so no project frame and
    // no active project, exactly like the inbox below.
    page = <ScriptsView />
  } else if (inboxMatch) {
    // Global inbox: lives above projects, so it renders on its own (no project
    // frame) and carries no active project in the nav.
    page = <InboxView filter={inboxFilter!} />
  } else if (ccTimelineMatch) {
    // Checked before `ccMatch` for readability only — every one of these
    // patterns is disjoint (`ccMatch` anchors the end right after `sessions`).
    page = <CCSessionTimelineView sessionId={decodeURIComponent(ccTimelineMatch[1])} />
  } else if (ccDetailMatch) {
    page = <CCSessionDetailView sessionId={decodeURIComponent(ccDetailMatch[1])} />
  } else if (ccMatch) {
    // CC Dashboard: global telemetry view, also above projects. `ccTab` is
    // non-null whenever ccMatch is.
    page = <CCDashboardView tab={ccTab!} />
  } else if (diagramMatch) {
    // Single board: in-place diagram view inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(diagramMatch[1])}
        taskId={null}
        diagrams
        diagramId={Number(diagramMatch[2])}
        git={false}
        files={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (diagramListMatch) {
    // Boards index: in-place diagrams view inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(diagramListMatch[1])}
        taskId={null}
        diagrams
        diagramId={null}
        git={false}
        files={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (gitMatch) {
    // Working-tree git view, in place inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(gitMatch[1])}
        taskId={null}
        diagrams={false}
        diagramId={null}
        git
        files={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (filesMatch) {
    // File tree + content viewer, in place inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(filesMatch[1])}
        taskId={null}
        diagrams={false}
        diagramId={null}
        git={false}
        files
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectTerminalMatch) {
    // Shell panes rooted at the project's folder, in place inside the
    // project page frame. Unlike the global Terminal page (a permanent
    // sibling mount below), this one unmounts with the route — its panes'
    // shells survive anyway, since every PtyTerminal lives in the
    // always-mounted PtyPool and the pane tree is kept per scope by
    // TerminalPage itself (mesa task 524).
    page = (
      <ProjectTasksPage
        projectId={Number(projectTerminalMatch[1])}
        taskId={null}
        diagrams={false}
        diagramId={null}
        git={false}
        files={false}
        terminal
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (dashboardMatch) {
    // Project-scoped CC dashboard, in place inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(dashboardMatch[1])}
        taskId={null}
        diagrams={false}
        diagramId={null}
        git={false}
        files={false}
        terminal={false}
        dashboard
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectSettingsMatch) {
    // Whole-project settings (folder / parent / archive), in place inside the
    // project page frame like Git/Files (mesa task 682).
    page = (
      <ProjectTasksPage
        projectId={Number(projectSettingsMatch[1])}
        taskId={null}
        diagrams={false}
        diagramId={null}
        git={false}
        files={false}
        terminal={false}
        dashboard={false}
        settings
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectCustomMatch) {
    // The project's own pane layout, in place inside the project page frame
    // like every other tab (mesa task 843).
    page = (
      <ProjectTasksPage
        projectId={Number(projectCustomMatch[1])}
        taskId={projectCustomMatch[2] ? Number(projectCustomMatch[2]) : null}
        diagrams={false}
        diagramId={null}
        git={false}
        files={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (createTaskMatch) {
    // Opens straight into the create-task form, in place inside the project
    // page frame (Board view underneath) — see the route comment above.
    page = (
      <ProjectTasksPage
        projectId={Number(createTaskMatch[1])}
        taskId={null}
        diagrams={false}
        diagramId={null}
        git={false}
        files={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectMatch) {
    page = (
      <ProjectTasksPage
        projectId={Number(projectMatch[1])}
        taskId={projectMatch[2] ? Number(projectMatch[2]) : null}
        diagrams={false}
        diagramId={null}
        git={false}
        files={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (legacyTaskMatch) {
    page = <LegacyTaskRedirect taskId={Number(legacyTaskMatch[1])} />
  } else {
    page = <p className="muted placeholder">Select a project.</p>
  }

  return (
    <>
      <header>
        <a className="brand" href="#/">
          <svg className="brand-mark" viewBox="0 0 100 100" role="img" aria-hidden="true">
            <polygon points="8,84 8,68 16,68 16,52 26,52 26,34 74,34 74,52 84,52 84,68 92,68 92,84" fill="#0a4d59" />
            <polygon points="16,68 16,52 26,52 26,34 74,34 74,52 84,52 84,68" fill="#00a8c2" />
            <polygon points="26,52 26,34 74,34 74,52" fill="#00e5ff" />
          </svg>
          <span className="brand-text">
            mesa
            {mesaVersion && (
              <span className="brand-version">v{mesaVersion.version}</span>
            )}
          </span>
        </a>
        {/* The right cluster (mesa task 857): the live conversation's controls
            sit beside the plan-limit chips, on every page. */}
        <div className="header-right">
          {/* A `collapse-sidebars` turn moves both panels at once (task 859):
              the conversation asked for room, and "the sidebars" is the pair.
              Both flags live here already — the phone tab bar writes the same
              two — so the hub relays the request rather than owning it. */}
          <LiveHub
            slot={liveSlot}
            onSidebars={(collapsed) => {
              setNavCollapsed(collapsed)
              setAgentsCollapsed(collapsed)
            }}
          />
          <HeaderUsage />
        </div>
      </header>
      <div className="shell-body">
        <Sidebar
          activeProjectId={activeProjectId}
          inboxFilter={inboxFilter}
          settingsActive={settingsMatch !== null}
          scriptsActive={scriptsMatch !== null}
          terminalActive={terminalActive}
          ccTab={ccTab}
          version={navVersion}
          unread={unread}
          collapsed={navCollapsed}
          onCollapsedChange={setNavCollapsed}
        />
        <div className="main-slot">
          {/* Both panes are permanent siblings, never conditionally rendered —
              same invariant AgentSidebar's own collapse relies on. `main`'s
              content (`page`) keeps its existing per-route mount/unmount
              behavior; only the pane wrapper's visibility toggles alongside
              Terminal's, so navigating to/from Terminal never touches
              TerminalPage's own mounted state (arch.md §4.3). */}
          <div
            className="main-slot-pane"
            style={{ visibility: terminalActive ? 'hidden' : 'visible' }}
          >
            <main>{page}</main>
          </div>
          <div className="main-slot-pane" style={{ visibility: terminalActive ? 'visible' : 'hidden' }}>
            <TerminalPage />
          </div>
        </div>
        {/* Where LiveHub portals its conversation panel (mesa task 887). The
            hub itself stays in the header — everything that makes it work is
            anchored there — but the panel is a right-hand sidebar, a sibling
            of the agents one, so the two can be open together, singly, or not
            at all. A slot rather than the panel itself because the state is
            all the hub's; `display: contents`, so the panel is the flex item
            and an empty slot takes no room. */}
        <div className="live-slot" ref={setLiveSlot} />
        <AgentSidebar
          activeProjectId={activeProjectId}
          liveSlot={liveSlot}
          collapsed={agentsCollapsed}
          onCollapsedChange={setAgentsCollapsed}
        />
        {/* Single always-mounted owner of every open leaf's PtyTerminal
            (mesa task 399, .scratch/arch.md §6.2), across BOTH AgentSidebar
            and TerminalPage — a permanent sibling, never inside `page` or
            conditionally rendered, same never-unmount invariant AgentSidebar
            itself already relies on. */}
        <PtyPool />
      </div>
      {/* Phone-tier only (hidden by CSS above 600px), outside `.shell-body`
          because it is `position: fixed` and must not participate in the
          shell's flex row. */}
      <PhoneTabBar
        activeProjectId={activeProjectId}
        inboxActive={inboxMatch !== null}
        unread={unread}
        navOpen={!navCollapsed}
        agentsOpen={!agentsCollapsed}
        onNavOpenChange={(open) => setNavCollapsed(!open)}
        onAgentsOpenChange={(open) => setAgentsCollapsed(!open)}
      />
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  )
}

export default App
