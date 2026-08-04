# Archived projects

A project may be **`archived`** — a persisted boolean, default `false`, flipped
by `Store::archive_project`/`unarchive_project` (idempotent setters; archiving an
already-archived project, or vice versa, succeeds and returns current state),
`mesa project archive|unarchive <ID|NAME>` (same id-or-name resolution as every
other project-arg command), and `POST /api/projects/{id}/archive`/`unarchive`.

## The ancestor rule (task 668)

Effective visibility is **derived, never stored**: a project is hidden from
unscoped reads iff it is archived **or any ancestor is**. Archiving a parent
therefore hides its whole subtree — and writes *nothing* to the descendants'
rows, exactly as `blocked` is computed rather than persisted. Unarchiving the
parent brings the subtree back in one write; a descendant that was archived on
its own account stays archived, because its own flag still says so.

One shared recursive-CTE predicate (`HIDDEN_PROJECTS_CTE` /
`NOT_HIDDEN_PROJECT` in `src/core/store.rs`) implements it at every unscoped
site — `list_projects`, `list_tasks`, `next_task`, `list_refine_tasks`,
`list_storyboards`, and so the todo/refine watchers and `GET /api/git-status`
that read through them. It is defined once on purpose: five hand-copied CTEs
would be five chances for "archived" to mean something slightly different.

The web UI re-derives the same rule client-side
(`projectTree.ts::effectivelyArchivedIds`), because the sidebar fetches with
`include_archived=true` and partitions the one array itself — otherwise a live
child of an archived parent would sit in the nav's main list while every
unscoped read omits it.

## The one rule: scoped reads never change

Archiving hides a project from **unscoped** views; it never deletes.
`project show`/`update`/`delete` and any query scoped to an explicit project
id/name are unaffected by the flag — **including a live child of an archived
parent**.

- `Store::list_projects()` keeps its signature and excludes hidden rows
  (archived, or under an archived ancestor);
  `Store::list_projects_all()` returns both.
- `mesa project list --include-archived` and
  `GET /api/projects?include_archived=true` widen to the full set. The unscoped
  default (CLI/API, and every current caller of `list_projects()`: the
  todo-watcher's project fan-out and `GET /api/git-status`) is unchanged and
  simply stops seeing archived projects — which is how the watcher and
  git-status decoration both skip them with no edit of their own.

## Tasks and storyboards follow the same rule

`Store::list_tasks` gained the `project: Option<i64>` argument its siblings
(`next_task`, `list_storyboards`) already had. All three share one rule:
`Some(id)` returns that project's rows regardless of `archived` (a scoped read of
an archived project is byte-identical to before archiving), `None` excludes rows
whose project is hidden — archived or under an archived ancestor — via an inner
join on `projects` plus the shared hidden-projects CTE.

`mesa task list`, `mesa task next`, `GET /api/tasks`, `mesa storyboard list` and
`GET /api/storyboards` all resolve their project id/name once and pass it
straight into the same `Store` call — the CLI and API no longer re-implement the
project filter as a handler-side `.filter(...)`, closing the divergence risk
structurally rather than by discipline.

## Web UI

Both directions are reachable from two places:

- The sidebar's collapsible `archived (N)` group nests descendants under their
  archived root and carries `restore` on the root — the row that is actually
  archived. One call brings the subtree back; a live child listed under an
  archived root has nothing of its own to restore, so it offers no button.
- The project page's **Settings** tab (`#/projects/:id/settings`, mesa task 682
  — it used to be a footer under every tab) offers `unarchive project` (and the
  page title an `archived` badge) whenever `project.archived` is set — the page
  keeps working while archived, since every read on it is project-scoped.

The sidebar's restore **must** re-run the two *unscoped* nav fetches
(`GET /api/tasks?status=todo`, `GET /api/git-status`) alongside the project list:
those omit archived projects, so a restored row otherwise sits with no todo badge
and no git line until the next poll tick.
