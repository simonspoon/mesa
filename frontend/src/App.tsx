import { useEffect, useState } from 'react'
import './App.css'
import { getTask } from './api'
import { AgentSidebar } from './components/AgentSidebar'
import { CommandPalette } from './components/CommandPalette'
import { PtyPool } from './components/PtyPool'
import { Sidebar } from './components/Sidebar'
import { CCDashboardView, type CcTab } from './pages/CCDashboardView'
import { InboxView } from './pages/InboxView'
import { ProjectTasksPage } from './pages/ProjectTasksPage'
import { TerminalPage } from './pages/TerminalPage'
import { useFetch } from './useFetch'

// Hash-based routing: #/ (placeholder), #/projects/:id,
// #/projects/:id/tasks/:tid (task open in the side panel),
// #/projects/:id/storyboards, #/projects/:id/storyboards/:sid,
// #/projects/:id/git (working-tree status + per-file diffs),
// #/projects/:id/files (file tree + content viewer),
// #/projects/:id/dashboard (project-scoped CC telemetry),
// #/projects/:id/create-task (opens straight into the create-task form;
// closing/saving it returns to the plain project URL — see
// ProjectTasksPage's `createTask` prop), #/terminal (global shell pane-tree;
// TerminalPage is a permanent sibling mount, not resolved into `page` — see
// the render below).
function useHashPath(): string {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || '/')
  useEffect(() => {
    const onChange = () => setPath(window.location.hash.slice(1) || '/')
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
  useCommandPaletteShortcut(() => setPaletteOpen(true))

  const inboxMatch = /^\/inbox$/.exec(path)
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
  const ccTab = ccMatch ? ((ccMatch[1] ?? 'overview') as CcTab) : null
  const storyboardMatch = /^\/projects\/(\d+)\/storyboards\/(\d+)$/.exec(path)
  const storyboardListMatch = /^\/projects\/(\d+)\/storyboards$/.exec(path)
  const gitMatch = /^\/projects\/(\d+)\/git$/.exec(path)
  const filesMatch = /^\/projects\/(\d+)\/files$/.exec(path)
  const dashboardMatch = /^\/projects\/(\d+)\/dashboard$/.exec(path)
  // Route the command palette's "Create task in <project>" entry navigates
  // to; ProjectTasksPage opens the create-task form on arrival and returns
  // to the plain project route once the form is closed or saved (spec
  // Assumption 2: the create panel itself stays ephemeral local state).
  const createTaskMatch = /^\/projects\/(\d+)\/create-task$/.exec(path)
  const projectMatch = /^\/projects\/(\d+)(?:\/tasks\/(\d+))?$/.exec(path)
  const legacyTaskMatch = /^\/tasks\/(\d+)$/.exec(path)
  const activeProjectId = storyboardMatch
    ? Number(storyboardMatch[1])
    : storyboardListMatch
      ? Number(storyboardListMatch[1])
      : gitMatch
        ? Number(gitMatch[1])
        : filesMatch
          ? Number(filesMatch[1])
          : dashboardMatch
            ? Number(dashboardMatch[1])
            : createTaskMatch
              ? Number(createTaskMatch[1])
              : projectMatch
                ? Number(projectMatch[1])
                : null

  let page
  if (inboxMatch) {
    // Global inbox: lives above projects, so it renders on its own (no project
    // frame) and carries no active project in the nav.
    page = <InboxView />
  } else if (ccMatch) {
    // CC Dashboard: global telemetry view, also above projects. `ccTab` is
    // non-null whenever ccMatch is.
    page = <CCDashboardView tab={ccTab!} />
  } else if (storyboardMatch) {
    // Single board: in-place storyboard view inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(storyboardMatch[1])}
        taskId={null}
        storyboards
        storyboardId={Number(storyboardMatch[2])}
        git={false}
        files={false}
        dashboard={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (storyboardListMatch) {
    // Boards index: in-place storyboards view inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(storyboardListMatch[1])}
        taskId={null}
        storyboards
        storyboardId={null}
        git={false}
        files={false}
        dashboard={false}
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
        storyboards={false}
        storyboardId={null}
        git
        files={false}
        dashboard={false}
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
        storyboards={false}
        storyboardId={null}
        git={false}
        files
        dashboard={false}
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
        storyboards={false}
        storyboardId={null}
        git={false}
        files={false}
        dashboard
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
        storyboards={false}
        storyboardId={null}
        git={false}
        files={false}
        dashboard={false}
        createTask
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectMatch) {
    page = (
      <ProjectTasksPage
        projectId={Number(projectMatch[1])}
        taskId={projectMatch[2] ? Number(projectMatch[2]) : null}
        storyboards={false}
        storyboardId={null}
        git={false}
        files={false}
        dashboard={false}
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
          mesa
        </a>
      </header>
      <div className="shell-body">
        <Sidebar
          activeProjectId={activeProjectId}
          inboxActive={inboxMatch !== null}
          terminalActive={terminalActive}
          ccTab={ccTab}
          version={navVersion}
        />
        <div className="main-slot">
          {/* Both panes are permanent siblings, never conditionally rendered —
              same invariant AgentSidebar's own collapse relies on. `main`'s
              content (`page`) keeps its existing per-route mount/unmount
              behavior; only the pane wrapper's visibility toggles alongside
              Terminal's, so navigating to/from Terminal never touches
              TerminalPage's own mounted state (arch.md §4.3). */}
          <div className="main-slot-pane" style={{ visibility: terminalActive ? 'hidden' : 'visible' }}>
            <main>{page}</main>
          </div>
          <div className="main-slot-pane" style={{ visibility: terminalActive ? 'visible' : 'hidden' }}>
            <TerminalPage />
          </div>
        </div>
        <AgentSidebar activeProjectId={activeProjectId} />
        {/* Single always-mounted owner of every open leaf's PtyTerminal
            (mesa task 399, .scratch/arch.md §6.2), across BOTH AgentSidebar
            and TerminalPage — a permanent sibling, never inside `page` or
            conditionally rendered, same never-unmount invariant AgentSidebar
            itself already relies on. */}
        <PtyPool />
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  )
}

export default App
