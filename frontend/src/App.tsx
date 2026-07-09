import { useEffect, useState } from 'react'
import './App.css'
import { getTask } from './api'
import { Sidebar } from './components/Sidebar'
import { CCDashboardView, type CcTab } from './pages/CCDashboardView'
import { InboxView } from './pages/InboxView'
import { ProjectTasksPage } from './pages/ProjectTasksPage'
import { useFetch } from './useFetch'

// Hash-based routing: #/ (placeholder), #/projects/:id,
// #/projects/:id/tasks/:tid (task open in the side panel),
// #/projects/:id/storyboards, #/projects/:id/storyboards/:sid,
// #/projects/:id/agents (live Claude Code sessions + embedded terminal),
// #/projects/:id/git (working-tree status + per-file diffs),
// #/projects/:id/dashboard (project-scoped CC telemetry).
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

function App() {
  const path = useHashPath()
  // Bumped after project create/rename/delete so the sidebar refetches.
  const [navVersion, setNavVersion] = useState(0)

  const inboxMatch = /^\/inbox$/.exec(path)
  // CC Dashboard is the default landing view: the root path (#/ or empty) shows
  // the overview, and the brand link points back here. The three sub-pages
  // (#/cc/skills-agents, #/cc/projects, #/cc/sessions) carry the table views;
  // capture group 1 is the active sub-page, undefined for the overview.
  const ccMatch = /^\/(?:cc(?:\/(skills-agents|projects|sessions))?)?$/.exec(path)
  const ccTab = ccMatch ? ((ccMatch[1] ?? 'overview') as CcTab) : null
  const storyboardMatch = /^\/projects\/(\d+)\/storyboards\/(\d+)$/.exec(path)
  const storyboardListMatch = /^\/projects\/(\d+)\/storyboards$/.exec(path)
  const agentsMatch = /^\/projects\/(\d+)\/agents$/.exec(path)
  const gitMatch = /^\/projects\/(\d+)\/git$/.exec(path)
  const dashboardMatch = /^\/projects\/(\d+)\/dashboard$/.exec(path)
  const projectMatch = /^\/projects\/(\d+)(?:\/tasks\/(\d+))?$/.exec(path)
  const legacyTaskMatch = /^\/tasks\/(\d+)$/.exec(path)
  const activeProjectId = storyboardMatch
    ? Number(storyboardMatch[1])
    : storyboardListMatch
      ? Number(storyboardListMatch[1])
      : agentsMatch
        ? Number(agentsMatch[1])
        : gitMatch
          ? Number(gitMatch[1])
          : dashboardMatch
            ? Number(dashboardMatch[1])
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
        agents={false}
        git={false}
        dashboard={false}
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
        agents={false}
        git={false}
        dashboard={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (agentsMatch) {
    // Live Claude Code sessions, in place inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(agentsMatch[1])}
        taskId={null}
        storyboards={false}
        storyboardId={null}
        agents
        git={false}
        dashboard={false}
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
        agents={false}
        git
        dashboard={false}
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
        agents={false}
        git={false}
        dashboard
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
        agents={false}
        git={false}
        dashboard={false}
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
          mesa
        </a>
      </header>
      <div className="shell-body">
        <Sidebar
          activeProjectId={activeProjectId}
          inboxActive={inboxMatch !== null}
          ccTab={ccTab}
          version={navVersion}
        />
        <main>{page}</main>
      </div>
    </>
  )
}

export default App
