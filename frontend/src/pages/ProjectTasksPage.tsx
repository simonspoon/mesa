import { useEffect, useState } from 'react'
import {
  getProject,
  getProjectVersion,
  listAllAgents,
  listTasks,
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
import { ProjectSettingsView } from './ProjectSettingsView'
import { StoryboardListView } from './StoryboardListView'
import { TerminalPage } from './TerminalPage'

// 'a' opens the create-task form via the existing #/projects/:id/create-task
// route (spec req 1) — a hash navigation, no new form plumbing;
// ProjectTasksPage's own `createTask` prop handling opens the panel on
// arrival. Board-scoped by construction — `active` is false whenever a
// non-Board view (Storyboards/Git/Files/Terminal/Dashboard/Settings) is
// showing, so the
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
  settings,
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
  // Settings is another URL-driven view: the project's own whole-project
  // controls — folder (local_path), parent project, archive/unarchive
  // (mesa task 682). Distinct from the GLOBAL #/settings page, which edits
  // ~/.mesa/config.json.
  settings: boolean
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

  // The Board is the default view — every other tab is URL-driven. Named
  // once because both the 'a' shortcut and the agents poll below are scoped
  // to it.
  const onBoard =
    !storyboards && !git && !files && !terminal && !dashboard && !settings

  const {
    data: project,
    error: projectError,
    refetch: refetchProject,
  } = useFetch(() => getProject(projectId), `project-${projectId}`)
  // The app version in the project's folder, for the badge beside its name
  // (mesa task 684). Decoration, so it is deliberately a plain keyed fetch
  // with no `pollMs` — one read per project page — and its `error` is unread:
  // the quiet empty shape is a 200, so a failure here just means no badge.
  const { data: appVersion } = useFetch(
    () => getProjectVersion(projectId),
    `project-version-${projectId}`,
  )
  // The board always shows every status column, so it fetches unfiltered.
  const { data: tasks, error: tasksError, refetch } = useFetch(
    () => listTasks({ project: projectId }),
    `board-${projectId}`,
    // Live-sync the board: agents mutate the DB underneath the UI, so poll
    // for changes instead of waiting for a window refocus. No-op polls are
    // dropped in useFetch, so an unchanged view never re-renders.
    { pollMs: 3000 },
  )
  // Live-agent markers on the cards (mesa task 663). Purely decorative: the
  // same `listAllAgents()` feed and 3s interval the Agents sidebar polls, so
  // it rides the server's existing 2s cache rather than adding `claude agents
  // --json` cost, and it only polls while the Board is the visible view. Its
  // `error` is deliberately unread and never surfaced — `/api/agents` is
  // gated and 502s `unavailable` with no `claude` binary, and the board must
  // render byte-identically in that case (and before the first poll lands).
  const { data: sessions } = useFetch(() => listAllAgents(), 'board-agents', {
    pollMs: onBoard ? 3000 : undefined,
  })
  // Storyboards, Git, Files, Terminal, Dashboard and Settings are their own
  // views with their own fetches/error handling, so a failed task fetch must
  // not block them; only surface it on the Board view.
  const error = projectError ?? (onBoard ? tasksError : null)

  // Same board-vs-other-view condition the tabs use below (spec req 2: 'a'
  // is inert on non-Board pages). Called unconditionally, ahead of the
  // early error return, per the rules of hooks; `active` gates the listener
  // itself, not this call.
  useCreateTaskShortcut(onBoard, projectId)

  if (error) return <p className="error">{error}</p>

  function onTasksChanged() {
    refetch()
  }

  // Return to the Board view. When a storyboards route is open this also
  // returns the hash to the project URL so the switch happens in place,
  // matching how the tabs toggle among any views (M5 symmetric return).
  function selectBoard() {
    if (!onBoard) window.location.hash = `#/projects/${projectId}`
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
          {/* The version of the app this project's folder holds (task 684),
              derived from its manifest on every read. Best-effort: absent
              whenever there is no folder or no readable version, so the
              header is unchanged for a project that isn't an app. The `v`
              prefix is added only when the manifest didn't already write
              one. */}
          {appVersion?.version && (
            <span
              className="badge project-version-badge"
              title={`from ${appVersion.source}`}
            >
              {appVersion.version.startsWith('v')
                ? appVersion.version
                : `v${appVersion.version}`}
            </span>
          )}
          {/* An archived project's page is otherwise identical to a live
              one's — every read here is project-scoped, so the flag changes
              nothing about it (task 509). Says so plainly, next to the name,
              and reuses the existing task badge styling. */}
          {project?.archived && (
            <span
              className="badge project-archived-badge"
              title="Hidden from the sidebar's main list and from unscoped task/storyboard views. Restore from the Settings tab."
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
            className={onBoard ? 'active' : ''}
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
          {/* Whole-project settings (folder / parent / archive) — last,
              after the working views (mesa task 682). */}
          <button
            className={settings ? 'active' : ''}
            onClick={() => {
              if (!settings)
                window.location.hash = `#/projects/${projectId}/settings`
            }}
          >
            Settings
          </button>
        </div>

        {/* Create action lives where the user is working: below the tabs, on
            the Board view only (spec S5), not on Storyboards/
            Git/Files/Dashboard (those carry their own content). */}
        {onBoard && (
          <p className="task-actions">
            <button onClick={openCreate}>add task</button>
          </p>
        )}

        {settings ? (
          !project ? (
            <p className="muted">Loading…</p>
          ) : (
            <ProjectSettingsView
              projectId={projectId}
              project={project}
              refetchProject={refetchProject}
              onProjectsChanged={onProjectsChanged}
            />
          )
        ) : dashboard ? (
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
          <KanbanBoard
            tasks={tasks}
            onMoved={onTasksChanged}
            projectName={project?.name ?? null}
            sessions={sessions}
          />
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
