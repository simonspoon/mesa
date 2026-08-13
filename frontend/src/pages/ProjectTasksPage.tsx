import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  getProject,
  getProjectVersion,
  listAllAgents,
  listTasks,
  updateProject,
} from '../api'
import { CreateTaskModal } from '../components/CreateTaskModal'
import { InlineEdit } from '../components/InlineEdit'
import { ProjectPanes, TabDropArea } from '../components/ProjectPanes'
import {
  closePane,
  dropTab,
  getLayout,
  isEmpty,
  paneLabel,
  paneTabs,
  PANE_TABS,
  setLayout,
  singlePane,
  TAB_DRAG_MIME,
  type PaneRoot,
  type PaneTab,
} from '../projectPanes'
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

// 'a' opens the create-task form, on every view of a project page and not
// just the Board (mesa task 811): a task is most often written *about* what is
// currently on screen — a file, a diff, a storyboard frame — so the view you
// are on is the reason to create one, never a reason to have to leave first.
//
// It opens the panel in place rather than navigating to
// #/projects/:id/create-task (which renders the Board underneath, and would
// throw away the very view the task is about). The route still exists for the
// command palette's "Create task in <project>" entry, unchanged.
//
// `shouldIgnoreShortcut` (keyboardScope.ts) is what makes app-wide scope safe:
// it already covers modifiers, text-editing contexts, xterm panes, the
// storyboard canvas and open modals — i.e. every place on these views where
// 'a' means the letter a. The remaining views have no key handling of their
// own to collide with.
//
// `onOpen` is read through a ref so the listener is bound once, not
// re-subscribed on every render by a caller-side closure.
function useCreateTaskShortcut(onOpen: () => void) {
  const latest = useRef(onOpen)
  useEffect(() => {
    latest.current = onOpen
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreShortcut(e)) return
      if (e.key !== 'a') return
      latest.current()
    }
    // Bound on keyup, not keydown (mesa task 817). The create form autoFocuses
    // its description field and React flushes a discrete event synchronously,
    // so opening on keydown mounts that textarea while the keystroke is still
    // in flight — and the rest of the keystroke types an 'a' into it. Waiting
    // for keyup lets the whole keystroke land on the (non-editable) view first.
    window.addEventListener('keyup', onKey)
    return () => window.removeEventListener('keyup', onKey)
  }, [])
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
  custom,
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
  // Custom is the user's own pane layout (mesa task 843) — the tab that only
  // exists once a view tab has been dragged into the main area, showing the
  // tree those drags built. URL-driven like the rest, so it is back-/refresh-
  // stable; the tree behind it is machine-local (`projectPanes.ts`).
  custom: boolean
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

  // This project's Custom pane tree (mesa task 843), restored from its
  // machine-local memory. Kept in state rather than read on every render so a
  // divider drag is a plain re-render; the effect below writes it back.
  //
  // This component is NOT remounted between projects, so — exactly like
  // `prevTaskId` above — the switch is picked up during render off the changed
  // prop, not in an effect (which would persist project A's tree under
  // project B's id on the way through).
  const [layout, setLayoutState] = useState<PaneRoot | null>(() => getLayout(projectId))
  const [prevProjectId, setPrevProjectId] = useState(projectId)
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId)
    setLayoutState(getLayout(projectId))
  }
  useEffect(() => {
    setLayout(projectId, layout)
  }, [projectId, layout])

  // A Custom route with no remembered tree (a bookmark from before the last
  // pane was closed, or another browser tab having closed the last pane) is
  // just the Board — the tab it would select is not on the strip at all. The
  // hash is corrected to match, so the page cannot sit on a route nothing on
  // the strip can navigate away from, and the remembered tab stops pointing
  // at a layout that no longer exists.
  const onCustom = custom && layout !== null
  useEffect(() => {
    if (custom && layout === null) window.location.hash = `#/projects/${projectId}`
  }, [custom, layout, projectId])

  // The Board is the default view — every other tab is URL-driven. Named
  // once because both the 'a' shortcut and the agents poll below are scoped
  // to it.
  const onBoard =
    !storyboards && !git && !files && !terminal && !dashboard && !settings && !onCustom

  // Which single view fills the main area when Custom is not the open tab —
  // and therefore which pane a tab dropped on it splits against.
  const soloTab: PaneTab = settings
    ? 'settings'
    : dashboard
      ? 'dashboard'
      : git
        ? 'git'
        : files
          ? 'files'
          : terminal
            ? 'terminal'
            : storyboards
              ? 'storyboards'
              : 'board'

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
  // "The board is the visible view" now includes the board as one *pane* of a
  // Custom layout, not only the Board tab — which is what `boardVisible` says.
  const boardVisible = onBoard || (onCustom && paneTabs(layout!).includes('board'))
  const { data: sessions } = useFetch(() => listAllAgents(), 'board-agents', {
    pollMs: boardVisible ? 3000 : undefined,
  })
  // Storyboards, Git, Files, Terminal, Dashboard and Settings are their own
  // views with their own fetches/error handling, so a failed task fetch must
  // not block them; only surface it where the board is actually on screen —
  // otherwise a Custom layout holding a board pane would show that pane
  // loading forever instead of the error.
  const error = projectError ?? (boardVisible ? tasksError : null)

  // Called unconditionally, ahead of the early error return, per the rules of
  // hooks. `openCreate` is a hoisted function declaration, so referencing it
  // from here is fine.
  useCreateTaskShortcut(openCreate)

  if (error) return <p className="error">{error}</p>

  function onTasksChanged() {
    refetch()
  }

  function closePanel() {
    setCreating(false)
    // `createTask` also needs the return-to-project-URL treatment: it
    // arrived via the #/projects/:id/create-task route, so closing without
    // saving must navigate away from that route too (spec Assumption 2:
    // the panel is ephemeral, not a back-/refresh-stable URL).
    if (taskId !== null || createTask)
      window.location.hash = onCustom
        ? `#/projects/${projectId}/custom`
        : `#/projects/${projectId}`
  }

  // A view tab was dragged into the main area (mesa task 843). Off a plain tab
  // the tree it lands in is that one view — dropping Files on the Board's right
  // edge is "board beside files", which is the whole gesture — so the drop is
  // resolved against `singlePane(soloTab)` and the page then switches to
  // Custom to show the result.
  function handleDropTab(
    tab: PaneTab,
    overId: string,
    pointer: { x: number; y: number },
    rect: DOMRect,
  ) {
    const base = onCustom ? layout! : singlePane(soloTab)
    const next = dropTab(base, tab, overId, pointer, rect)
    // A drop that changed nothing (a tab onto its own pane) must not mint a
    // one-pane Custom tab out of the view you were already looking at.
    if (!onCustom && paneTabs(next).length < 2) return
    setLayoutState(next)
    if (!custom) window.location.hash = `#/projects/${projectId}/custom`
  }

  function handleClosePane(tab: PaneTab) {
    const next = closePane(layout ?? singlePane(tab), tab)
    if (isEmpty(next)) {
      // The last pane closed: the Custom tab goes off the strip, so the page
      // cannot stay on it.
      setLayoutState(null)
      window.location.hash = `#/projects/${projectId}`
      return
    }
    setLayoutState(next)
  }

  /** One view, rendered either as the whole main area or as one pane of the
   *  Custom layout — the single place each tab's content is described. */
  function viewFor(tab: PaneTab): ReactNode {
    switch (tab) {
      case 'settings':
        return !project ? (
          <p className="muted">Loading…</p>
        ) : (
          <ProjectSettingsView
            projectId={projectId}
            project={project}
            refetchProject={refetchProject}
            onProjectsChanged={onProjectsChanged}
          />
        )
      case 'dashboard':
        return <CCDashboardView tab="overview" projectId={projectId} />
      case 'git':
        return <GitView projectId={projectId} />
      case 'files':
        return <FilesView projectId={projectId} />
      case 'terminal':
        return !project ? (
          <p className="muted">Loading…</p>
        ) : project.local_path === null ? (
          // Same "no linked folder" rung as the Files/Git tabs (M10), worded
          // for shells. A local_path that exists but is dead is left to the
          // server's own rejection (the pane shows its "shell closed" banner)
          // rather than a second client-side probe — there's no tree/status
          // call here to read it from.
          <div className="files-placeholder muted">
            <p>
              This project has no linked folder, so mesa cannot open a shell in
              it. Run <code>mesa project resolve</code> inside the repo, or{' '}
              <code>mesa project update {projectId} --path &lt;dir&gt;</code>, to
              link one.
            </p>
          </div>
        ) : (
          // Keyed by project so switching projects (this component is not
          // remounted between them) starts from that project's own tree
          // rather than carrying the previous one's panes across.
          <TerminalPage key={`project-${projectId}`} projectId={projectId} />
        )
      case 'storyboards':
        return storyboardId !== null ? (
          <StoryboardBoardView projectId={projectId} storyboardId={storyboardId} />
        ) : (
          <StoryboardListView projectId={projectId} />
        )
      case 'board':
        return !tasks ? (
          <p className="muted">Loading…</p>
        ) : (
          <KanbanBoard
            tasks={tasks}
            onMoved={onTasksChanged}
            projectName={project?.name ?? null}
            sessions={sessions}
          />
        )
    }
  }

  /** One tab in the strip. Every view tab is draggable — dragging it into the
   *  main area is what builds the Custom layout — and a plain click still
   *  fills the whole area with it, unchanged. */
  function viewTab(tab: PaneTab, active: boolean, href: string) {
    return (
      <button
        key={tab}
        className={active ? 'active' : ''}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(TAB_DRAG_MIME, tab)
          // Some browsers cancel a drag carrying no `text/plain` at all.
          e.dataTransfer.setData('text/plain', paneLabel(tab))
        }}
        // Only ever navigates *to* a tab: clicking the tab you are already on
        // is a no-op, so it cannot close an open task panel by dropping the
        // deeper route it lives on.
        onClick={() => {
          if (!active) window.location.hash = href
        }}
      >
        {paneLabel(tab)}
      </button>
    )
  }

  function tabHref(tab: PaneTab): string {
    return tab === 'board'
      ? `#/projects/${projectId}`
      : `#/projects/${projectId}/${tab}`
  }

  function tabActive(tab: PaneTab): boolean {
    return tab === 'board' ? onBoard : !onCustom && soloTab === tab
  }

  function openCreate() {
    setCreating(true)
    // One panel, latest action wins: drop an open task back to the
    // project URL (the create form is not URL-addressed).
    if (taskId !== null)
      window.location.hash = onCustom
        ? `#/projects/${projectId}/custom`
        : `#/projects/${projectId}`
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
          {/* Custom is first, ahead of Dashboard (mesa task 843), and exists
              only while this project has a remembered pane layout — it is the
              tab the drag gesture creates, and closing the last pane takes it
              back off the strip. It is not draggable: it *is* the layout, so
              there is no view of it to drop into itself. */}
          {layout !== null && (
            <button
              className={onCustom ? 'active' : ''}
              title="Your own pane layout, built by dragging tabs into the main area"
              onClick={() => {
                if (!onCustom) window.location.hash = `#/projects/${projectId}/custom`
              }}
            >
              Custom
            </button>
          )}
          {/* Dashboard is first of the view tabs, before Board (spec Must #4);
              each is a URL-driven in-place view, and each is draggable into
              the main area to become a pane (mesa task 843). Settings — the
              project's own folder / parent / archive controls — stays last,
              after the working views (mesa task 682). */}
          {PANE_TABS.map((tab) => viewTab(tab, tabActive(tab), tabHref(tab)))}
          <button className="tabs-action" onClick={openCreate}>
            add task
          </button>
        </div>

        {onCustom ? (
          <ProjectPanes
            root={layout!}
            onChange={(update) => setLayoutState((r) => update(r ?? singlePane(soloTab)))}
            onClose={handleClosePane}
            onDropTab={handleDropTab}
            renderView={viewFor}
          />
        ) : (
          // The plain single-view case, unchanged except that the whole area
          // is now a drop target for a dragged tab — dropping one here is what
          // turns this view into the first pane of a Custom layout.
          <TabDropArea
            id={soloTab}
            className="project-view-drop"
            onDropTab={handleDropTab}
          >
            {viewFor(soloTab)}
          </TabDropArea>
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
