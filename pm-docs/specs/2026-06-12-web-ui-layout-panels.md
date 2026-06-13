# Web UI layout: left nav, full-width main, right-hand detail panel

> **Frozen planning spec (2026-06-12).** Do not update it to match the current
> code. For current truth see `pm-docs/docs/`.

## Goal

The web UI becomes a three-region app shell: a persistent left nav listing all
projects (with project creation built in), a main area that uses the full
window width, and — inside a project view — a right-hand panel that slides the
main area into a split. The panel hosts both the new-task form (opened by an
"Add task" button, replacing the inline create form) and the task detail view
(opened by clicking a task, replacing the standalone task page). Task panel
state is URL-driven, so refreshing or sharing a link restores the open task.

## Context

All claims from the current code; no external research was needed.

- Routing is hash-based with three routes — `#/`, `#/projects/:id`,
  `#/tasks/:id` — matched by regex in `frontend/src/App.tsx:18-30`. The shell
  is a `<header>` plus a `<main>` (`App.tsx:32-41`).
- `main` is capped at `max-width: 720px` and centered
  (`frontend/src/App.css:18-22`). This is the cap the "full window" requirement
  removes.
- `ProjectsPage` (`frontend/src/pages/ProjectsPage.tsx:46-70`) renders the
  project list and an inline `CreateProjectForm`. Its content moves into the
  left nav.
- `ProjectTasksPage` (`frontend/src/pages/ProjectTasksPage.tsx:101-270`)
  renders project header (InlineEdit name/description, ConfirmDelete), an
  inline `CreateTaskForm` (lines 37-99, to be removed), list/board tabs,
  filters, and the task list. Task rows link to `#/tasks/:id`
  (`ProjectTasksPage.tsx:24`).
- `TaskDetailPage` (`frontend/src/pages/TaskDetailPage.tsx:62-199`) is the
  standalone task view: title/status/priority/tags/description editing,
  delete, subtask list + create form, blockers list. Its content becomes the
  right panel's task view.
- `listDependencies` returns full `Task[]` (`frontend/src/api.ts:92-94`), and
  `Task` carries `project_id`, so blocker links can route into the correct
  project's panel.
- `TaskCreate` already accepts optional `description`, `priority`, `tags`
  (`frontend/src/api.ts:106-113`) — the richer panel create form needs no API
  change.
- `useFetch` (`frontend/src/useFetch.ts:9-51`) refetches on mount, `key`
  change, and window focus, and exposes `refetch`. The nav's project list can
  be refreshed after rename/delete by bumping a key from the page (see
  Design).
- Build/verify commands: `cd frontend && npm run build` runs `tsc -b` then
  vite (frontend/package.json). The khora skill is available for browser
  verification against the dev server.

## Requirements

1. A left nav is visible on every route, listing all projects by name; each
   entry links to `#/projects/:id`, and the entry for the currently open
   project is visually marked active.
2. The left nav contains the create-project form; submitting it adds the
   project and the nav list updates without a manual reload.
3. `#/` renders only a placeholder prompt (e.g. "select a project") in the
   main area; the standalone `ProjectsPage` is removed.
4. The main area spans the full window width minus the nav — the 720px
   `max-width` on `main` is gone.
5. The project view shows an "Add task" button; clicking it opens a
   right-hand panel containing a create-task form with title, description,
   priority, and tags fields. The inline `CreateTaskForm` above the list is
   removed.
6. Submitting the panel create form creates the task, the task list
   (list or board view) updates without a manual reload, and the panel
   closes (main area returns to full width).
7. Clicking a task in the project view (list row or kanban card) routes to
   `#/projects/:pid/tasks/:tid` and opens that task's detail in the right
   panel; the main area keeps showing the project's list/board alongside it.
8. The right panel's task view supports everything `TaskDetailPage` does
   today: edit title/description/tags inline, change status/priority,
   delete (with confirm), subtask list + create, blockers list.
9. Edits made in the task panel (e.g. status change) are reflected in the
   main-area task list/board without a manual reload.
10. Loading `#/projects/:pid/tasks/:tid` directly (refresh / deep link)
    renders the project with that task's panel open.
11. Navigating to a legacy `#/tasks/:id` URL redirects to
    `#/projects/:pid/tasks/:id` (project id resolved via `getTask`); the
    standalone `TaskDetailPage` route is removed.
12. Both panel modes (task detail and create form) have a close control;
    closing returns to `#/projects/:pid` with the main area back at full
    width.
13. Renaming or deleting a project from the project view updates the left
    nav without a manual reload; deleting navigates to `#/`.

## Non-goals

- No backend / API changes — the existing endpoints cover everything.
- No mobile/responsive layout work; desktop-width layout only.
- No change to kanban drag-and-drop behavior, filters, or the list/board tabs
  beyond their placement in the new layout.
- No visual redesign beyond the layout split — keep the existing cyberpunk
  theme variables and component styles.
- No panel form for project creation; the nav uses a compact inline form.

## Assumptions

- Assuming "Add task" while a task is open replaces the panel content with
  the create form (one panel, latest action wins), and the URL drops back to
  `#/projects/:pid` since create-form state is ephemeral.
- Assuming subtask and blocker links inside the panel navigate within the
  panel (update the `:tid` segment) rather than opening anything new; blocker
  links use the blocker's own `project_id`.
- Assuming creating a project from the nav just refreshes the nav list and
  does not auto-navigate to the new project.
- Assuming the subtask create form stays inline inside the task panel, as it
  is on the current task page.
- Assuming the nav needs no collapse/hide control.

## Design

**Shell.** `App.tsx` becomes a CSS-grid shell: `header` spanning the top, then
`nav.sidebar` + `main`. The `max-width: 720px` rule on `main` (App.css:18-22)
is removed; `main` gets `flex/grid: 1` and its own scroll. A new
`Sidebar` component absorbs `ProjectsPage`'s fetch + create form, rendered
compactly (name-only entries; description input dropped from the nav form —
description is editable in the project view already). `ProjectsPage.tsx` is
deleted.

**Routing.** `App.tsx` route table becomes: `#/` → placeholder;
`#/projects/:pid` and `#/projects/:pid/tasks/:tid` → `ProjectTasksPage`
(second form passes `taskId`); `#/tasks/:id` → a tiny `LegacyTaskRedirect`
component that calls `getTask(id)` and rewrites the hash. Active-project
highlighting derives from the same parsed path, passed to `Sidebar`.

**Split panel.** `ProjectTasksPage` gains a `panel` concept:
`taskId` prop (from URL) opens the task panel; local state opens the create
panel. When either is open, the page lays out as a two-column flex/grid
(`.project-split`), main column keeping tabs/filters/list/board. The task
panel content is `TaskDetailPage`'s body refactored into a `TaskPanel`
component (file renamed/moved to `components/TaskPanel.tsx`; back-link
replaced by a close ×, navigation hashes changed to the new scheme). The
create panel is a new `CreateTaskPanel` with the four fields, reusing the
existing form styling.

**Refresh wiring.** Mutations in the panel call an `onChanged` callback that
triggers the page's existing `refetch`/`refetchCount`; `TaskPanel` keeps its
own `useFetch` keyed by `task-${taskId}` as today. For the nav: `App` holds a
`navVersion` counter; `Sidebar`'s `useFetch` key includes it, and
`ProjectTasksPage` receives an `onProjectsChanged` prop (bump) called after
rename/delete. This is the smallest mechanism that fits the existing
`useFetch` key-driven pattern — a context or store would be more machinery
than five components justify.

## Implementation

1. **Shell + sidebar.** Grid layout in App.tsx/App.css, `Sidebar` component
   with project list + compact create form, `#/` placeholder, delete
   `ProjectsPage.tsx`, remove the 720px cap.
   → verify: `cd frontend && npm run build` clean; in browser, nav lists
   projects on every route, main area fills the window, creating a project
   from the nav updates the list.
2. **Routing.** New route regexes incl. `#/projects/:pid/tasks/:tid`,
   `LegacyTaskRedirect` for `#/tasks/:id`, task links in `TaskRow` and
   `KanbanBoard` cards point at the new scheme, active nav highlighting.
   → verify: visiting `#/tasks/<existing-id>` lands on
   `#/projects/<pid>/tasks/<id>`; direct load of the new URL renders the
   project view.
3. **TaskPanel.** Refactor `TaskDetailPage` body into `TaskPanel` with close
   button and new-scheme subtask/blocker links; render it as the right column
   of `ProjectTasksPage` when `taskId` is set; delete `TaskDetailPage.tsx`.
   → verify: clicking a task opens the panel beside the list; all edits from
   Requirement 8 work; close returns to `#/projects/:pid`; refresh with the
   task URL reopens the panel.
4. **CreateTaskPanel.** "Add task" button; panel form with title/description/
   priority/tags plus a close button; remove inline `CreateTaskForm`;
   successful create refetches the list and closes the panel.
   → verify: created task appears in list and board without reload; panel
   collapses after save; close button collapses it without saving.
5. **Refresh wiring + cleanup.** `navVersion` bump on project rename/delete,
   panel `onChanged` → list refetch (status change in panel moves the kanban
   card), remove dead imports/components.
   → verify: `npm run build` clean; rename a project and see the nav update;
   change a task's status in the panel and see the list badge/board column
   update.
6. **End-to-end pass.** Drive the dev server with khora through: create
   project → open it → add task via panel → open task → edit status → close
   panel → delete task → delete project.
   → verify: every step observable in the browser with no console errors.

## Open questions

None — all intent questions were answered; everything else is recorded under
Assumptions with defaults.

## Acceptance

- `cd frontend && npm run build` exits 0.
- Browser checks (dev server + khora or manual), each binary:
  - Nav shows all projects on `#/`, `#/projects/:id`, and task URLs; active
    project highlighted.
  - `main` has no 720px cap (inspect: no `max-width` on `main`).
  - `#/` shows the placeholder; no projects page remains.
  - "Add task" opens the right panel; inline create form is absent from the
    project view.
  - Creating via panel adds the task to the visible list without reload and
    the panel collapses; the panel's close button collapses it without
    saving.
  - Clicking a task sets `#/projects/:pid/tasks/:tid` and opens the panel;
    refresh on that URL restores it.
  - `#/tasks/:id` redirects to the new URL.
  - Status change in the panel updates the list/board without reload.
  - Panel close returns to `#/projects/:pid`.
  - Project rename/delete updates the nav; delete lands on `#/`.

## Appendix: Q&A

**Q: When a task is open in the right-hand panel, should the URL reflect it
(so refresh/deep-link restores the open task), and what happens to the
current standalone task page at #/tasks/:id?**
A: URL-driven panel — "Route becomes #/projects/:id/tasks/:tid — refreshing
or sharing the link reopens the project with that task in the panel.
Standalone task page is removed; old #/tasks/:id links redirect into the
panel view."

**Q: With the project list living in a persistent left nav, what should the
home view (#/) show in the main area?**
A: Placeholder only — "Left nav fully replaces the projects page. #/ shows an
empty-state prompt ('select a project'); project creation moves into the left
nav."

**Q: Should creating a task via the new button use the right-hand panel form
only, or should the inline quick-create form also remain above the task
list?**
A: Panel only — "The inline CreateTaskForm is removed from the project view;
'Add task' button opens the right panel with a fuller form (title, priority,
tags, description)."
