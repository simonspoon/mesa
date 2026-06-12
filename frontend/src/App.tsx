import { useEffect, useState } from 'react'
import './App.css'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectTasksPage } from './pages/ProjectTasksPage'
import { TaskDetailPage } from './pages/TaskDetailPage'

// Hash-based routing: #/ (projects), #/projects/:id, #/tasks/:id.
function useHashPath(): string {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || '/')
  useEffect(() => {
    const onChange = () => setPath(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return path
}

function App() {
  const path = useHashPath()
  const projectMatch = /^\/projects\/(\d+)$/.exec(path)
  const taskMatch = /^\/tasks\/(\d+)$/.exec(path)

  let page
  if (projectMatch) {
    page = <ProjectTasksPage projectId={Number(projectMatch[1])} />
  } else if (taskMatch) {
    page = <TaskDetailPage taskId={Number(taskMatch[1])} />
  } else {
    page = <ProjectsPage />
  }

  return (
    <>
      <header>
        <a className="brand" href="#/">
          mesa
        </a>
      </header>
      <main>{page}</main>
    </>
  )
}

export default App
