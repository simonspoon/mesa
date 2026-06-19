import { useEffect, useState } from 'react'
import './App.css'
import { getTask } from './api'
import { Sidebar } from './components/Sidebar'
import { ProjectTasksPage } from './pages/ProjectTasksPage'
import { StoryboardListPage } from './pages/StoryboardListPage'
import { StoryboardPage } from './pages/StoryboardPage'
import { useFetch } from './useFetch'

// Hash-based routing: #/ (placeholder), #/projects/:id,
// #/projects/:id/tasks/:tid (task open in the side panel),
// #/projects/:id/storyboards, #/projects/:id/storyboards/:sid.
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

  const storyboardMatch = /^\/projects\/(\d+)\/storyboards\/(\d+)$/.exec(path)
  const storyboardListMatch = /^\/projects\/(\d+)\/storyboards$/.exec(path)
  const projectMatch = /^\/projects\/(\d+)(?:\/tasks\/(\d+))?$/.exec(path)
  const legacyTaskMatch = /^\/tasks\/(\d+)$/.exec(path)
  const activeProjectId = storyboardMatch
    ? Number(storyboardMatch[1])
    : storyboardListMatch
      ? Number(storyboardListMatch[1])
      : projectMatch
        ? Number(projectMatch[1])
        : null

  let page
  if (storyboardMatch) {
    page = (
      <StoryboardPage
        projectId={Number(storyboardMatch[1])}
        storyboardId={Number(storyboardMatch[2])}
      />
    )
  } else if (storyboardListMatch) {
    page = <StoryboardListPage projectId={Number(storyboardListMatch[1])} />
  } else if (projectMatch) {
    page = (
      <ProjectTasksPage
        projectId={Number(projectMatch[1])}
        taskId={projectMatch[2] ? Number(projectMatch[2]) : null}
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
        <Sidebar activeProjectId={activeProjectId} version={navVersion} />
        <main>{page}</main>
      </div>
    </>
  )
}

export default App
