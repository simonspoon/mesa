# Mesa web UI: CRUD controls + cyberpunk/Tron theme

> **Frozen planning spec (2026-06-12).** Do not update it to match the current
> code. For current truth see `pm-docs/docs/`.

> Follow-up to `specs/2026-06-11-mesa.md`. That spec's v1 UI is read-only
> except kanban drag; this one adds editing/creation/deletion controls and
> replaces the minimal light theme with a committed dark cyberpunk look.

## Goal

The mesa web UI becomes a full management surface, not just a viewer: projects
and tasks can be created, edited, and deleted from the browser (subtasks
included), with deletes guarded by an inline confirmation that states what
cascades. Visually, the UI gets a dark-only cyberpunk/Tron treatment — neon
cyan/magenta on near-black, grid backdrop, glow on interactive elements,
angular panel corners, Orbitron display headings and Share Tech Mono data
text — applied across every existing view (project list, task list/filters,
task detail, kanban board). All work is frontend-only; the existing REST API
already covers every operation.

## Context

All claims verified against the working tree on 2026-06-12.

- **Backend needs no changes.** The API already exposes full CRUD:
  `POST/GET /api/projects`, `GET/PATCH/DELETE /api/projects/{id}`,
  `POST/GET /api/tasks`, `GET/PATCH/DELETE /api/tasks/{id}`, plus
  block/unblock/dependencies (`src/api.rs:63-87`).
- PATCH distinguishes "clear field" (`null`) from "leave unchanged" (absent)
  via `double_option` (`src/api.rs:184-190`); `TaskUpdate` accepts `title`,
  `description`, `status`, `priority`, `tags`, `parent_id`
  (`src/api.rs:271-285`); `ProjectUpdate` accepts `name`, `description`
  (`src/api.rs:201-207`). `--tags`/`tags` replaces the full set (parent spec
  Requirement 3).
- Deletes cascade and return the destroyed records: project delete returns
  `{"project": ..., "tasks": [...]}` (`src/api.rs:246-253`); task delete
  returns the task plus cascaded subtasks (`src/api.rs:362-365`). No
  confirmation exists server-side by design (parent spec Assumption 11).
- Mutating requests must send `Content-Type: application/json` or the guard
  middleware rejects them with 415 (`src/api.rs:107-132`). The existing
  `updateTaskStatus` shows the working pattern
  (`frontend/src/api.ts:74-80`).
- The frontend fetch layer (`frontend/src/api.ts`) currently has read
  functions plus `updateTaskStatus` only; all other mutations are missing.
- `useFetch` already returns a `refetch` that re-runs the loader without
  clearing current data (`frontend/src/useFetch.ts:48`) — the kanban board
  uses it after a drop (`frontend/src/pages/ProjectTasksPage.tsx:141`).
  Mutations added by this spec reuse the same pattern.
- Error shape: `ApiError` carries `code`/`message`/`status`
  (`frontend/src/api.ts:11-20`); cycle/validation errors arrive as
  409/422 with `{"error": {"code", "message"}}` (`src/api.rs:144-158`).
- Pages: `ProjectsPage.tsx` (list only), `ProjectTasksPage.tsx` (filters,
  list/board tabs), `TaskDetailPage.tsx` (read-only fields, subtasks,
  blockers). Routing is hash-based in `App.tsx:8-16`.
- Current theme: light, two small CSS files (`frontend/src/index.css` —
  variables, `frontend/src/App.css` — components), system font stack, no UI
  framework (parent spec Assumption 10).
- Fonts on npm, verified 2026-06-12 via `npm view`:
  `@fontsource/orbitron` 5.2.8, `@fontsource/share-tech-mono` 5.2.7.
  Bundling (not a CDN `<link>`) is required: the built frontend is embedded
  in the binary and served at `/` (parent spec Requirement 9), and must
  render correctly with no network access.
- ts-rs generated types (`frontend/src/types/`) must not be hand-edited
  (parent spec Requirement 12); new request-body types live in `api.ts` as
  function parameters, mirroring how `updateTaskStatus` already works.

## Requirements

1. `ProjectsPage` has a create-project form: name (required), description
   (optional). Submitting POSTs `/api/projects` and the new project appears
   in the list without a manual reload.
2. `ProjectTasksPage` lets the user edit the project's name and description
   inline (click-to-edit); saving PATCHes `/api/projects/{id}` and the
   header updates.
3. `ProjectTasksPage` has a delete-project control with a two-step inline
   confirmation that states how many tasks will be deleted with it (count
   from the already-fetched task list). Confirming DELETEs and navigates
   to `#/`.
4. `ProjectTasksPage` has a create-task form: title (required), priority
   (select, default `medium`), tags (comma-separated, optional). Submitting
   POSTs `/api/tasks` with the page's `project_id` and the list/board
   refetches.
5. `TaskDetailPage` supports inline editing of title, description, status,
   priority, and tags. Each field PATCHes only what changed; clearing the
   description sends `"description": null`. The view refetches after each
   save (so derived `blocked` and badges stay correct).
6. `TaskDetailPage` has a delete-task control with a two-step inline
   confirmation stating how many subtasks cascade. Confirming DELETEs and
   navigates to the parent project page.
7. `TaskDetailPage` has a create-subtask form (title required) that POSTs
   `/api/tasks` with `parent_id` = the current task and `project_id` = the
   current task's project; the subtask list refetches.
8. Every mutation failure (4xx/5xx) surfaces the API's `error.message`
   inline next to the control that triggered it; the UI never silently
   swallows an error.
9. The UI is dark-only cyberpunk/Tron, full treatment: near-black
   background with a subtle grid backdrop, neon cyan primary + magenta
   secondary accents, glow (box-shadow/text-shadow) on interactive and
   focused elements, angular clipped corners on panels/cards, Orbitron for
   the brand and headings, Share Tech Mono for body/data text. Status
   colors remap to the neon palette (todo=cyan, in_progress=amber,
   done=green, cancelled=dimmed+strikethrough, blocked=magenta/red glow).
10. Fonts ship via `@fontsource/orbitron` and `@fontsource/share-tech-mono`
    npm packages, imported in the frontend source so Vite bundles them. The
    built `dist/` references no external origin (no CDN links).
11. Every existing view (projects list, task list + filters, tabs, kanban
    board + drag states, task detail) is restyled — no view is left on the
    old light theme.
12. `npx tsc --noEmit` is clean and `./scripts/build.sh` passes end-to-end.

## Non-goals

- Dependency (block/unblock) management from the UI — explicitly deselected;
  the detail page keeps its read-only "Blocked by" list. CLI owns edges.
- Light mode, theme toggle, or `prefers-color-scheme` handling — dark only.
- Reassigning an existing task's parent or project from the UI (creation
  with a parent is in; re-parenting is out).
- Tag/status/priority editing from list rows or kanban cards — editing
  lives on detail pages; kanban drag remains the only board-side mutation.
- No new backend endpoints, no API changes, no Rust changes.
- No optimistic updates, undo, toasts, websockets, or animation systems
  (static grid + glows; CSS transitions only).
- No UI component framework — stays plain CSS (parent spec Assumption 10).

## Assumptions

Defaults chosen without asking (or where the chosen answer needed
interpretation) — correct me if wrong:

1. **"Confirm dialog" is an inline two-step confirm**, not a native
   `window.confirm` or a modal: the delete button flips to
   "Deletes N task(s) — Confirm / Cancel" in place. Native dialogs can't be
   themed; a modal adds infrastructure for one interaction.
2. **Tags edit as one comma-separated text input** (split/trim on save,
   empty input → `[]`). The API replaces the whole set, so this maps 1:1.
3. **Project editing lives on `ProjectTasksPage`** (there is no separate
   project detail page, and adding one is out of scope).
4. **Create-task form fields are title + priority + tags**; description is
   added afterwards on the detail page. Keeps the form one row.
5. **Inline edit interaction**: a field enters edit mode on click (or an
   edit icon), saves on Enter/save-button, cancels on Escape/cancel-button.
   One small shared component, reused for all text fields; status/priority
   render as always-active styled `<select>`s that PATCH on change.
6. **No animated effects** (no animated scanlines/flicker): static grid
   backdrop, glow shadows, hover/focus transitions only.
7. **Empty-state copy changes**: "create one with `mesa project create`"
   becomes the actual in-UI form (the hint no longer applies).

## Design

Frontend-only change, three layers:

1. **Data layer** (`frontend/src/api.ts`): add `createProject`,
   `updateProject(id, patch)`, `deleteProject`, `createTask(body)`,
   `updateTask(id, patch)`, `deleteTask`. Patch parameter types are
   hand-written *request* shapes (mirroring `updateTaskStatus`), using
   `null` for clears — they are inputs, not API payload mirrors, so they
   don't violate the ts-rs rule. Responses reuse generated `Project`/`Task`
   types.
2. **Components** (`frontend/src/components/`): `InlineEdit` (text/textarea
   click-to-edit with save/cancel and error slot) and `ConfirmDelete`
   (two-step button with cascade message). Pages wire them to the api
   functions and call the existing `useFetch` `refetch` on success.
   Creation forms are small local `<form>`s per page (three call sites,
   slightly different fields — not worth a shared abstraction).
3. **Theme** (`index.css` + `App.css` rewrite): CSS-variable palette
   (`--bg`, `--panel`, `--neon-cyan`, `--neon-magenta`, `--neon-amber`,
   `--neon-green`, `--grid-line`...), grid backdrop via two
   `repeating-linear-gradient`s on `body`, `clip-path: polygon(...)` corner
   cuts on panels/cards/buttons, `box-shadow` glows on hover/focus,
   `@fontsource` imports in `main.tsx`. Existing class names are kept so
   markup changes stay minimal; new controls reuse them plus a handful of
   new classes (`.inline-edit`, `.confirm-delete`, `.create-form`).

Why this over alternatives: modals or edit routes would need routing/portal
infrastructure for interactions that inline components cover (user picked
inline); a CSS framework or styled-components contradicts the parent spec's
no-framework assumption and buys nothing at this size; keeping mutations as
plain functions + `refetch` matches the established kanban pattern instead
of introducing a query library.

## Implementation

1. **Mutation API layer**: add the six mutation functions to
   `frontend/src/api.ts`; install `@fontsource/orbitron` and
   `@fontsource/share-tech-mono` (do the install now so the lockfile change
   rides this milestone).
   → verify: `npx tsc --noEmit` clean; `curl`-equivalent smoke via browser
   console or a throwaway call confirms `createProject('x')` returns a
   `Project` with an id.
2. **Shared components**: `InlineEdit` and `ConfirmDelete` in
   `frontend/src/components/`, themed-classname-ready but functional under
   the old CSS.
   → verify: `npx tsc --noEmit` clean (components exercised in milestones
   3–4).
3. **Project CRUD**: create form on `ProjectsPage` (Req 1); inline
   name/description edit + delete-with-cascade-count on `ProjectTasksPage`
   (Reqs 2–3).
   → verify: in the browser — create a project, rename it, reload (rename
   persisted), delete it (confirm message names the task count, lands on
   `#/`, project gone); `mesa project list` agrees at each step.
4. **Task CRUD + subtasks**: create-task form on `ProjectTasksPage`
   (Req 4); inline field edits, delete, and subtask form on
   `TaskDetailPage` (Reqs 5–7); mutation errors render inline (Req 8).
   → verify: in the browser — create a task with tags, edit every field on
   its detail page, clear its description, add a subtask, delete the task
   (confirm states subtask count, subtask gone after); `mesa task show`
   agrees after each edit; forcing a validation error (e.g. empty title
   PATCH) shows the API message inline.
5. **Cyberpunk theme**: rewrite `index.css`/`App.css` per Design §3; font
   imports in `main.tsx`; restyle all views including kanban drag/over
   states and the new controls (Reqs 9–11).
   → verify: visual pass with khora screenshots of all four views (projects,
   list+filters, board mid-drag, task detail with edit mode open) — dark
   palette, grid, glows, Orbitron headings, mono body all present; no
   unstyled light remnants.
6. **Build + offline check**: full pipeline and no-external-assets check
   (Reqs 10, 12).
   → verify: `./scripts/build.sh` exits 0; `grep -rE "https?://" frontend/dist/assets/`
   finds no font/CSS CDN URLs; release binary at `http://127.0.0.1:7770/`
   renders the themed UI and a create→edit→delete round-trip works against
   it.

## Open questions

None blocking. One held hypothesis: comma-separated tag input (Assumption 2)
is good enough for single-user use; if tags grow heavy use, revisit with a
chip editor. Default: ship the text input.

## Acceptance

1. `./scripts/build.sh` exits 0; `npx tsc --noEmit` exits 0.
2. Against the release binary (no Vite dev server): create a project, add a
   task with tags, edit its title/status/priority/tags/description on the
   detail page, add a subtask — each change visible after browser reload
   and confirmed by `mesa task show <id>` / `mesa project show <id>`.
3. Deleting that project from the UI shows "Deletes N task(s)" with the
   correct N before confirming; after confirming, `mesa project list` no
   longer contains it and the browser is at `#/`.
4. A failed mutation shows the API error message inline: e.g. PATCH a task
   title to empty → the 422 `error.message` appears next to the field, and
   the field's previous value is still intact after cancel.
5. Visual: every view renders the dark cyberpunk theme (khora screenshot
   pass); DevTools network tab during a full session shows zero requests to
   non-localhost origins.
6. Kanban still works: drag a card to a new column, `mesa task show <id>`
   reports the new status (no regression from restyling).

## Appendix: Q&A

Round 1 (2026-06-12):
- Q: "Should the cyberpunk theme be dark-only, or a light/dark toggle?"
  → A: "Dark-only (Recommended)"
- Q: "Which controls should the web UI get? (select all that apply)"
  → A: "Project create/edit/delete, Task create/edit/delete, Subtask
  creation" (Dependency block/unblock not selected)
- Q: "How should editing work interaction-wise?"
  → A: "Inline on detail pages (Recommended)"
- Q: "Should deletes in the UI require confirmation?"
  → A: "Confirm dialog (Recommended)"

Round 2 (2026-06-12):
- Q: "How far should the cyberpunk/Tron styling go?"
  → A: "Full treatment (Recommended)" (neon glows, grid/scanline backdrop,
  angular panel corners, Orbitron headings, mono data text)
