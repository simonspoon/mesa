# Project version

The version of the *app* a project's `local_path` holds, shown as a small badge
beside the project name on its page. Derived, read-only, best-effort
decoration — the same posture `GET /api/git-status` already has: no folder and
no manifest are not errors, they just mean no badge.

## Read order

`core::version::version_of(dir)` checks these files at the **top level of
`dir` only** — no recursion, no workspace/monorepo scanning — and the first
one that yields a non-empty version wins:

| # | File | Where the version comes from |
| --- | --- | --- |
| 1 | `Cargo.toml` | `version` in `[package]`, else in `[workspace.package]` |
| 2 | `package.json` | the top-level `"version"` string |
| 3 | `pyproject.toml` | `version` in `[project]`, else in `[tool.poetry]` |

A file that exists but has no usable version **falls through to the next one**
(a `Cargo.toml` carrying neither table's `version` — a bare `[workspace]` with
no `[workspace.package]`, say — next to a `package.json` reports the
package.json's version).

The only path input is the project's own `local_path` — there is no
caller-supplied path on this surface, so no traversal gate is involved. Each
file read is capped at 256 KiB; anything larger is skipped rather than
slurped.

**No `toml` crate.** Only three keys in two formats are wanted, so the TOML
cases are hand-parsed the way `git::parse_status` hand-parses porcelain: track
the current `[section]` header line by line and take the first
`version = "…"` inside the wanted table (single quotes accepted, a trailing
`# comment` ignored). Being section-aware is the point — a `version` under
`[dependencies.foo]` must not match. `package.json` is parsed with
`serde_json`, already a dependency. The parsers are pure (text in,
`Option<String>` out) and unit-tested in that module without a filesystem.

## Route

`GET /api/projects/{id}/version` → `ProjectVersion { version, source }`, where
`source` is the bare manifest filename (`"Cargo.toml"`) for the badge's
tooltip.

- Behind the **standard guard only** — no `require_agent_access`. This is a
  read-only file read of the project's own folder, like the git tab's GETs.
- `200 {"version": null, "source": null}` when `local_path` is unset, the
  folder is gone, or no manifest yields a version. Quiet empty shape, never an
  error (`project_git_view`'s posture).
- Unknown project id is `not_found` / 404, as everywhere.
- The read runs on `spawn_blocking`, like `get_git_status`.
- **No cache.** This is a per-page fetch, not a poll, so nothing is added to
  `AppState`.

## Derived, never stored

There is no `version` field on `Project`, no DB column and no migration — the
value is computed on every read, so editing a manifest is reflected on the
next page load with no write anywhere. There is also no CLI command, no entry
in the left sidebar or on board cards, and no `/api/git-status` field. mesa
never writes a version.

## Frontend

`getProjectVersion(id)` (`frontend/src/api.ts`) is fetched by
`ProjectTasksPage` through `useFetch` keyed on the project id with no
`pollMs`; its `error` is deliberately unread. The badge renders inside the
`<h1>` after the name and before the `archived` badge, only when `version` is
non-null, with a `v` prefix added only if the manifest didn't already write
one. Presentation only — the parsing logic is in Rust, so there is no vitest
module for it.
