import { useState } from 'react'
import { deleteProject, getProject, listTasks, updateProject } from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { CreateTaskPanel } from '../components/CreateTaskPanel'
import { InlineEdit } from '../components/InlineEdit'
import { TaskPanel } from '../components/TaskPanel'
import { TaskRow } from '../components/TaskRow'
import { KanbanBoard } from '../KanbanBoard'
import type { Priority } from '../types/Priority'
import type { Status } from '../types/Status'
import { useFetch } from '../useFetch'
import { AgentsView } from './AgentsView'
import { CCDashboardView } from './CCDashboardView'
import { FilesView } from './FilesView'
import { GitView } from './GitView'
import { StoryboardBoardView } from './StoryboardBoardView'
import { StoryboardListView } from './StoryboardListView'

import type { TaskSummary } from '../types/TaskSummary'

const STATUSES: Status[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']

// Order tasks so each subtask sits directly under its parent, indented one
// level (spec S6, one level only). Parents keep the incoming order; a subtask
// whose parent is absent from the list (filtered out) stays in place at the
// top level so it is never dropped.
function nestSubtasks(
  tasks: TaskSummary[],
): { task: TaskSummary; depth: number }[] {
  const byParent = new Map<number, TaskSummary[]>()
  for (const t of tasks) {
    if (t.parent_id !== null) {
      const group = byParent.get(t.parent_id) ?? []
      group.push(t)
      byParent.set(t.parent_id, group)
    }
  }
  const present = new Set(tasks.map((t) => t.id))
  const out: { task: TaskSummary; depth: number }[] = []
  for (const t of tasks) {
    // Skip subtasks whose parent is also in the list; they are emitted under
    // the parent below. Orphaned subtasks fall through at depth 0.
    if (t.parent_id !== null && present.has(t.parent_id)) continue
    out.push({ task: t, depth: 0 })
    for (const child of byParent.get(t.id) ?? []) {
      out.push({ task: child, depth: 1 })
    }
  }
  return out
}

export function ProjectTasksPage({
  projectId,
  taskId,
  storyboards,
  storyboardId,
  agents,
  git,
  files,
  dashboard,
  createTask,
  onProjectsChanged,
}: {
  projectId: number
  taskId: number | null
  // Storyboards is a URL-driven view (refresh-/back-stable): `storyboards` is
  // true on the boards routes, `storyboardId` selects a single board's canvas.
  storyboards: boolean
  storyboardId: number | null
  // Agents is another URL-driven view: live Claude Code sessions under the
  // project's folder, with an embedded terminal.
  agents: boolean
  // Git is another URL-driven view: working-tree status of the project's
  // linked folder, with a per-file diff pane.
  git: boolean
  // Files is another URL-driven view: the project's file tree (rooted at
  // local_path) with a content viewer for the selected file.
  files: boolean
  // Dashboard is another URL-driven view: this project's scoped CC telemetry
  // (project-scoped CCDashboardView, overview only).
  dashboard: boolean
  // True while on the #/projects/:id/create-task route (the command
  // palette's "Create task in <project>" entry): seeds the create-task
  // panel open on arrival. `closePanel`/the panel's `onCreated` return the
  // hash to the plain project route, so the create panel itself stays
  // ephemeral local state (spec Assumption 2), not URL-persisted.
  createTask: boolean
  onProjectsChanged: () => void
}) {
  // Status and tag are passed through to the API's query filters; priority
  // is filtered client-side (the API has no priority filter).
  const [status, setStatus] = useState<Status | ''>('')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [tag, setTag] = useState('')
  // List/Board is an in-place toggle held in local state; Storyboards is
  // URL-driven (the `storyboards` prop). `view` only distinguishes list vs
  // board — when Storyboards is active it governs neither tab's content.
  const [view, setView] = useState<'list' | 'board'>('board')
  // Create-form panel state is ephemeral (spec Assumption 2); the task
  // panel is URL-driven via `taskId`. Latest action wins: opening a task
  // closes the create form. Seeded from `createTask` so a direct arrival
  // via the create-task route opens straight into the form.
  const [creating, setCreating] = useState(createTask)
  // Latest action wins: opening a task (taskId becomes non-null) closes the
  // create form. Adjust the state during render off the changed prop rather
  // than in an effect (avoids a cascading re-render).
  const [prevTaskId, setPrevTaskId] = useState(taskId)
  if (taskId !== prevTaskId) {
    setPrevTaskId(taskId)
    if (taskId !== null) setCreating(false)
  }
  // The component isn't remounted between in-place project views, so a
  // second palette-triggered arrival at the create-task route (component
  // already mounted on this project) needs the same latest-action-wins
  // treatment as `prevTaskId` above, not just the `useState` seed.
  const [prevCreateTask, setPrevCreateTask] = useState(createTask)
  if (createTask !== prevCreateTask) {
    setPrevCreateTask(createTask)
    if (createTask) setCreating(true)
  }

  const {
    data: project,
    error: projectError,
    refetch: refetchProject,
  } = useFetch(() => getProject(projectId), `project-${projectId}`)
  // The board always shows every status column, so it fetches unfiltered;
  // the list filters apply only to the list view.
  const { data: tasks, error: tasksError, refetch } = useFetch(
    () =>
      view === 'board'
        ? listTasks({ project: projectId })
        : listTasks({
            project: projectId,
            status: status === '' ? undefined : status,
            tag: tag === '' ? undefined : tag,
          }),
    view === 'board'
      ? `board-${projectId}`
      : `tasks-${projectId}-${status}-${tag}`,
    // Live-sync the List/Board: agents mutate the DB underneath the UI, so
    // poll for changes instead of waiting for a window refocus. No-op polls
    // are dropped in useFetch, so an unchanged view never re-renders.
    { pollMs: 3000 },
  )
  // Unfiltered count for the delete confirmation: the list fetch above may
  // be filtered, but the cascade destroys every task in the project.
  const { data: allTasks, refetch: refetchCount } = useFetch(
    () => listTasks({ project: projectId }),
    `count-${projectId}`,
  )

  // Storyboards, Agents, Git, Files, and Dashboard are their own views with
  // their own fetches/error handling, so a failed task fetch must not block
  // them; only surface it on the task views (List/Board).
  const error =
    projectError ??
    (storyboards || agents || git || files || dashboard ? null : tasksError)
  if (error) return <p className="error">{error}</p>

  const visible = tasks?.filter((t) => priority === '' || t.priority === priority)

  function onTasksChanged() {
    refetch()
    refetchCount()
  }

  // Switch to a task view (List/Board). When a storyboards route is open this
  // also returns the hash to the project URL so the switch happens in place,
  // matching how the tabs toggle among any views (M5 symmetric return).
  function selectView(next: 'list' | 'board') {
    setView(next)
    if (storyboards || agents || git || files || dashboard)
      window.location.hash = `#/projects/${projectId}`
  }

  function closePanel() {
    setCreating(false)
    // `createTask` also needs the return-to-project-URL treatment: it
    // arrived via the #/projects/:id/create-task route, so closing without
    // saving must navigate away from that route too (spec Assumption 2:
    // the panel is ephemeral, not a back-/refresh-stable URL).
    if (taskId !== null || createTask)
      window.location.hash = `#/projects/${projectId}`
  }

  function openCreate() {
    setCreating(true)
    // One panel, latest action wins: drop an open task back to the
    // project URL (the create form is not URL-addressed).
    if (taskId !== null) window.location.hash = `#/projects/${projectId}`
  }

  const panel = creating ? (
    <CreateTaskPanel
      projectId={projectId}
      onClose={closePanel}
      onCreated={() => {
        setCreating(false)
        if (createTask) window.location.hash = `#/projects/${projectId}`
        onTasksChanged()
      }}
    />
  ) : taskId !== null ? (
    <TaskPanel
      key={taskId}
      taskId={taskId}
      onClose={closePanel}
      onChanged={onTasksChanged}
    />
  ) : null

  const listView = (
    <>
      <div className="filters">
        <label>
          Status{' '}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Status | '')}
          >
            <option value="">all</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority{' '}
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority | '')}
          >
            <option value="">all</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag{' '}
          <input
            type="text"
            value={tag}
            placeholder="filter by tag"
            onChange={(e) => setTag(e.target.value)}
          />
        </label>
      </div>

      {!visible ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="muted">No tasks match.</p>
      ) : (
        <ul className="card-list">
          {nestSubtasks(visible).map(({ task, depth }) => (
            <TaskRow key={task.id} task={task} depth={depth} />
          ))}
        </ul>
      )}
    </>
  )

  return (
    <div className={panel ? 'project-split' : ''}>
      <div className="project-main">
        <h1>
          {project ? (
            <InlineEdit
              value={project.name}
              onSave={(name) =>
                updateProject(projectId, { name }).then(() => {
                  refetchProject()
                  onProjectsChanged()
                })
              }
            />
          ) : (
            `Project ${projectId}`
          )}
        </h1>
        {project && (
          <p className="muted">
            <InlineEdit
              value={project.description ?? ''}
              multiline
              placeholder="no description — click to add"
              onSave={(d) =>
                updateProject(projectId, {
                  description: d === '' ? null : d,
                }).then(refetchProject)
              }
            />
          </p>
        )}
        <div className="tabs">
          {/* Dashboard is first, before Board (spec Must #4): a URL-driven
              in-place view, like Storyboards/Agents/Git below. */}
          <button
            className={dashboard ? 'active' : ''}
            onClick={() => {
              if (!dashboard)
                window.location.hash = `#/projects/${projectId}/dashboard`
            }}
          >
            Dashboard
          </button>
          <button
            className={
              !storyboards && !agents && !git && !files && !dashboard && view === 'board'
                ? 'active'
                : ''
            }
            onClick={() => selectView('board')}
          >
            Board
          </button>
          <button
            className={
              !storyboards && !agents && !git && !files && !dashboard && view === 'list'
                ? 'active'
                : ''
            }
            onClick={() => selectView('list')}
          >
            List
          </button>
          {/* URL-driven in-place views (refresh-/back-stable) that keep this
              frame around their content, like List/Board above. */}
          <button
            className={storyboards ? 'active' : ''}
            onClick={() => {
              if (!storyboards)
                window.location.hash = `#/projects/${projectId}/storyboards`
            }}
          >
            Storyboards
          </button>
          <button
            className={agents ? 'active' : ''}
            onClick={() => {
              if (!agents)
                window.location.hash = `#/projects/${projectId}/agents`
            }}
          >
            Agents
          </button>
          <button
            className={git ? 'active' : ''}
            onClick={() => {
              if (!git) window.location.hash = `#/projects/${projectId}/git`
            }}
          >
            Git
          </button>
          <button
            className={files ? 'active' : ''}
            onClick={() => {
              if (!files) window.location.hash = `#/projects/${projectId}/files`
            }}
          >
            Files
          </button>
        </div>

        {/* Create action lives where the user is working: below the tabs, on
            the List/Board views only (spec S5), not on Storyboards/
            Agents/Git/Files/Dashboard (those carry their own content). */}
        {!storyboards && !agents && !git && !files && !dashboard && (
          <p className="task-actions">
            <button onClick={openCreate}>add task</button>
          </p>
        )}

        {dashboard ? (
          <CCDashboardView tab="overview" projectId={projectId} />
        ) : git ? (
          <GitView projectId={projectId} />
        ) : files ? (
          <FilesView projectId={projectId} />
        ) : agents ? (
          <AgentsView projectId={projectId} />
        ) : storyboards ? (
          storyboardId !== null ? (
            <StoryboardBoardView
              projectId={projectId}
              storyboardId={storyboardId}
            />
          ) : (
            <StoryboardListView projectId={projectId} />
          )
        ) : view === 'board' ? (
          !tasks ? (
            <p className="muted">Loading…</p>
          ) : (
            <KanbanBoard tasks={tasks} onMoved={onTasksChanged} />
          )
        ) : (
          listView
        )}

        {/* Destructive action tucked away, de-emphasized (spec S8): rarely
            used, kept reachable in a low-key project footer. */}
        <p className="project-danger">
          <ConfirmDelete
            label="delete project"
            message={`Deletes this project and ${allTasks?.length ?? '?'} task(s).`}
            onDelete={() =>
              deleteProject(projectId).then(() => {
                onProjectsChanged()
                window.location.hash = '#/'
              })
            }
          />
        </p>
      </div>
      {panel && <aside className="side-panel">{panel}</aside>}
    </div>
  )
}
