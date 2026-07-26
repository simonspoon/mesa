# Archived projects

A project may be **`archived`** — a persisted boolean, default `false`, flipped
by `Store::archive_project`/`unarchive_project` (idempotent setters; archiving an
already-archived project, or vice versa, succeeds and returns current state),
`mesa project archive|unarchive <ID|NAME>` (same id-or-name resolution as every
other project-arg command), and `POST /api/projects/{id}/archive`/`unarchive`.

## The one rule: scoped reads never change

Archiving hides a project from **unscoped** views; it never deletes.
`project show`/`update`/`delete` and any query scoped to an explicit project
id/name are unaffected by the flag.

- `Store::list_projects()` keeps its signature and excludes archived rows;
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
whose project is archived, via an inner join on `projects`.

`mesa task list`, `mesa task next`, `GET /api/tasks`, `mesa storyboard list` and
`GET /api/storyboards` all resolve their project id/name once and pass it
straight into the same `Store` call — the CLI and API no longer re-implement the
project filter as a handler-side `.filter(...)`, closing the divergence risk
structurally rather than by discipline.

## Web UI

Both directions are reachable from two places:

- The sidebar's collapsible `archived (N)` group carries a per-row `restore`.
- The project page's footer offers `unarchive project` (and its title an
  `archived` badge) whenever `project.archived` is set — the page keeps working
  while archived, since every read on it is project-scoped.

The sidebar's restore **must** re-run the two *unscoped* nav fetches
(`GET /api/tasks?status=todo`, `GET /api/git-status`) alongside the project list:
those omit archived projects, so a restored row otherwise sits with no todo badge
and no git line until the next poll tick.
