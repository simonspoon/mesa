import { useEffect, useState } from 'react'
import {
  archiveProject,
  getProject,
  listTasks,
  unarchiveProject,
  updateProject,
} from '../api'
import { CreateTaskModal } from '../components/CreateTaskModal'
import { InlineEdit } from '../components/InlineEdit'
import { TaskModal } from '../components/TaskModal'
import { KanbanBoard } from '../KanbanBoard'
import { shouldIgnoreShortcut } from '../keyboardScope'
import { useFetch } from '../useFetch'
import { CCDashboardView } from './CCDashboardView'
import { FilesView } from './FilesView'
import { GitView } from './GitView'
import { StoryboardBoardView } from './StoryboardBoardView'
import { StoryboardListView } from './StoryboardListView'
import { TerminalPage } from './TerminalPage'

// 'a' opens the create-task form via the existing #/projects/:id/create-task
// route (spec req 1) — a hash navigation, no new form plumbing;
// ProjectTasksPage's own `createTask` prop handling opens the panel on
// arrival. Board-scoped by construction — `active` is false whenever a
// non-Board view (Storyboards/Git/Files/Terminal/Dashboard) is showing, so the
// listener is a no-op there without a route string check
// (.scratch/arch-449-keyboard.md §3). `shouldIgnoreShortcut`
// (keyboardScope.ts) covers modifiers, text-editing contexts, terminals, the
// storyboard canvas and open modals.
function useCreateTaskShortcut(active: boolean, projectId: number) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreShortcut(e)) return
      if (e.key === 'a')
        window.location.hash = `#/projects/${projectId}/create-task`
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, projectId])
}

export function ProjectTasksPage({
  projectId,
  taskId,
  storyboards,
  storyboardId,
  git,
  files,
  terminal,
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
  // Git is another URL-driven view: working-tree status of the project's
  // linked folder, with a per-file diff pane.
  git: boolean
  // Files is another URL-driven view: the project's file tree (rooted at
  // local_path) with a content viewer for the selected file.
  files: boolean
  // Terminal is another URL-driven view: the global Terminal page's pane
  // tree of live shells, rooted at the project's local_path instead of
  // $HOME (mesa task 524).
  terminal: boolean
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
  // The sync runs both ways: leaving the route (browser Back off
  // #/projects/:id/create-task) must close the panel, not just arriving
  // must open it. A one-way `if (createTask) setCreating(true)` left the
  // panel and its `.create-task-backdrop` mounted on a board route, which
  // `shouldIgnoreShortcut` reads document-wide as "a modal owns the keys" —
  // silently killing every global shortcut until a full reload.
  // Clicking the board's own "add task" button is unaffected: it sets
  // `creating` without changing `createTask`, so this block never fires.
  const [prevCreateTask, setPrevCreateTask] = useState(createTask)
  if (createTask !== prevCreateTask) {
    setPrevCreateTask(createTask)
    setCreating(createTask)
  }

  const {
    data: project,
    error: projectError,
    refetch: refetchProject,
  } = useFetch(() => getProject(projectId), `project-${projectId}`)
  // The board always shows every status column, so it fetches unfiltered.
  const { data: tasks, error: tasksError, refetch } = useFetch(
    () => listTasks({ project: projectId }),
    `board-${projectId}`,
    // Live-sync the board: agents mutate the DB underneath the UI, so poll
    // for changes instead of waiting for a window refocus. No-op polls are
    // dropped in useFetch, so an unchanged view never re-renders.
    { pollMs: 3000 },
  )
  // Storyboards, Git, Files, Terminal, and Dashboard are their own views
  // with their own fetches/error handling, so a failed task fetch must not
  // block them; only surface it on the Board view.
  const error =
    projectError ??
    (storyboards || git || files || terminal || dashboard ? null : tasksError)

  // Same board-vs-other-view condition the tabs use below (spec req 2: 'a'
  // is inert on non-Board pages). Called unconditionally, ahead of the
  // early error return, per the rules of hooks; `active` gates the listener
  // itself, not this call.
  useCreateTaskShortcut(
    !storyboards && !git && !files && !terminal && !dashboard,
    projectId,
  )

  // Archiving hides the project (reversible), never deletes — spec req 12 /
  // Won't list: no confirmation prompt, no "this deletes N tasks" copy.
  // Declared ahead of the early error return below, per the rules of hooks.
  // One in-flight flag / one error slot covers both directions: the footer
  // only ever offers whichever of archive/unarchive this project isn't
  // already in (task 509).
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  if (error) return <p className="error">{error}</p>

  function onTasksChanged() {
    refetch()
  }

  // Return to the Board view. When a storyboards route is open this also
  // returns the hash to the project URL so the switch happens in place,
  // matching how the tabs toggle among any views (M5 symmetric return).
  function selectBoard() {
    if (storyboards || git || files || terminal || dashboard)
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

  function handleArchive() {
    setArchiving(true)
    setArchiveError(null)
    archiveProject(projectId)
      .then(() => {
        onProjectsChanged()
        // The project just vanished from the default list/sidebar; land
        // somewhere still valid instead of leaving the user on a page for
        // a now-hidden project.
        window.location.hash = '#/'
      })
      .catch((e: unknown) => {
        setArchiving(false)
        setArchiveError(e instanceof Error ? e.message : String(e))
      })
  }

  // Restoring keeps the user where they are (the page was already valid while
  // archived — `show` is a scoped read, unaffected by the flag), so unlike
  // `handleArchive` there is no navigation and the in-flight flag has to be
  // cleared here. Refetching the project is what flips this footer back to
  // "archive project" and drops the header badge.
  function handleUnarchive() {
    setArchiving(true)
    setArchiveError(null)
    unarchiveProject(projectId)
      .then(() => {
        setArchiving(false)
        refetchProject()
        onProjectsChanged()
      })
      .catch((e: unknown) => {
        setArchiving(false)
        setArchiveError(e instanceof Error ? e.message : String(e))
      })
  }

  return (
    <>
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
          {/* An archived project's page is otherwise identical to a live
              one's — every read here is project-scoped, so the flag changes
              nothing about it (task 509). Says so plainly, next to the name,
              and reuses the existing task badge styling. */}
          {project?.archived && (
            <span
              className="badge project-archived-badge"
              title="Hidden from the sidebar's main list and from unscoped task/storyboard views. Restore below."
            >
              archived
            </span>
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
              in-place view, like Storyboards/Git below. */}
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
              !storyboards && !git && !files && !terminal && !dashboard
                ? 'active'
                : ''
            }
            onClick={selectBoard}
          >
            Board
          </button>
          {/* URL-driven in-place views (refresh-/back-stable) that keep this
              frame around their content, like Board above. */}
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
          <button
            className={terminal ? 'active' : ''}
            onClick={() => {
              if (!terminal)
                window.location.hash = `#/projects/${projectId}/terminal`
            }}
          >
            Terminal
          </button>
        </div>

        {/* Create action lives where the user is working: below the tabs, on
            the Board view only (spec S5), not on Storyboards/
            Git/Files/Dashboard (those carry their own content). */}
        {!storyboards && !git && !files && !terminal && !dashboard && (
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
        ) : terminal ? (
          !project ? (
            <p className="muted">Loading…</p>
          ) : project.local_path === null ? (
            // Same "no linked folder" rung as the Files/Git tabs (M10),
            // worded for shells. A local_path that exists but is dead is
            // left to the server's own rejection (the pane shows its
            // "shell closed" banner) rather than a second client-side
            // probe — there's no tree/status call here to read it from.
            <div className="files-placeholder muted">
              <p>
                This project has no linked folder, so mesa cannot open a shell
                in it. Run <code>mesa project resolve</code> inside the repo,
                or <code>mesa project update {projectId} --path &lt;dir&gt;</code>,
                to link one.
              </p>
            </div>
          ) : (
            // Keyed by project so switching projects (this component is not
            // remounted between them) starts from that project's own tree
            // rather than carrying the previous one's panes across.
            <TerminalPage key={`project-${projectId}`} projectId={projectId} />
          )
        ) : storyboards ? (
          storyboardId !== null ? (
            <StoryboardBoardView
              projectId={projectId}
              storyboardId={storyboardId}
            />
          ) : (
            <StoryboardListView projectId={projectId} />
          )
        ) : !tasks ? (
          <p className="muted">Loading…</p>
        ) : (
          <KanbanBoard tasks={tasks} onMoved={onTasksChanged} />
        )}

        {/* Retirement action tucked away, de-emphasized (spec S8): rarely
            used, kept reachable in a low-key project footer. Archiving is
            reversible (this same footer, or the sidebar's archived group,
            restores it), so this is a plain
            button with no confirm step and no destructive copy — spec's
            Won't list explicitly rules out a confirmation prompt here.
            Deleting a project is still possible; it's just no longer
            offered from this control (CLI/API unchanged). */}
        {/* Rendered only once the project is loaded: the footer's verb depends
            on `archived`, and offering "archive project" for a moment on a
            project that is already archived is the very confusion task 509
            reports. */}
        {project && (
          <p className="project-danger">
            {project.archived ? (
              <button onClick={handleUnarchive} disabled={archiving}>
                unarchive project
              </button>
            ) : (
              <button onClick={handleArchive} disabled={archiving}>
                archive project
              </button>
            )}
            {archiveError && <span className="error">{archiveError}</span>}
          </p>
        )}
    {taskId !== null && (
      <TaskModal
        key={taskId}
        taskId={taskId}
        onClose={closePanel}
        onChanged={onTasksChanged}
      />
    )}
    {creating && (
      <CreateTaskModal
        projectId={projectId}
        onClose={closePanel}
        onCreated={() => {
          setCreating(false)
          if (createTask) window.location.hash = `#/projects/${projectId}`
          onTasksChanged()
        }}
      />
    )}
    </>
  )
}
