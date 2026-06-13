# Project Docs tab — per-project `pm-docs/` viewer

> **Frozen planning spec (2026-06-12).** Do not update it to match the current
> code. For current truth see `pm-docs/docs/`.

> Follows the two-round expert-panel consult in
> `.claude/consults/2026-06-12-project-documents-storage.md` (verdict: files on
> disk are the truth; mesa is a thin, path-confined, read-only viewer; the docs
> location is per-project data that is looked up, never derived).

## Goal

Each mesa project can point at a docs folder on disk — by convention `pm-docs/` at the project's repo root — via a new nullable `docs_path` column. The web UI's project view gains a third tab, **Docs**, next to List and Board: a left-hand file tree of everything under `docs_path`, and a read-only viewer that renders markdown (GFM) including mermaid diagrams, shows other text files as plain text, images as images, and a "no preview" notice for anything else. Agents and Simon keep reading/writing the files with normal file tools; mesa only displays them. The agent-side conventions (root `CLAUDE.md`, the planning skill) are updated in the same change so new PM documents land in `pm-docs/` and the path is looked up from mesa, not guessed.

## Context

- **Schema**: `projects` is `id, name, description` (`src/core/store.rs:55-59`); migrations are a `user_version`-indexed array of SQL strings (`src/core/store.rs:54`, `MIGRATIONS`), so adding migration 2 is appending one string.
- **Types**: `Project` derives serde + ts-rs and exports to `frontend/src/types/` (`src/core/types.rs:68-77`). `ProjectPatch` uses `Option<Option<String>>` where `Some(None)` clears a field (`src/core/store.rs:110-114`); `update_project` applies it at `src/core/store.rs:187`.
- **CLI**: `mesa project create/update` already take `--description`, with `--description ""` clearing (`src/cli.rs:112`, `src/cli.rs:287`); `--docs-path` follows the same pattern.
- **API**: routes and the Host/Content-Type guard live in `src/api.rs:63-87` and `src/api.rs:90-120`; error bodies use `{"error":{"code","message"}}` via `ApiError`. New docs routes are GET-only, so the existing guard applies unchanged (Host check; the Content-Type gate only touches mutating methods).
- **Frontend**: the List/Board tabs are local state `view: 'list' | 'board'` in `frontend/src/pages/ProjectTasksPage.tsx:30`, with buttons at `:208-221`; `useFetch` (`frontend/src/useFetch.ts`) is the shared fetch hook (refetch-on-focus per mesa spec Requirement 10). No markdown or mermaid dependency exists yet (`frontend/package.json`).
- **Rendering libs** (web research, June 2026): react-markdown v10.1.0 is the standard React markdown renderer, React 19-compatible — https://registry.npmjs.org/react-markdown/latest [web, verified]. remark-gfm v4.0.1 pairs with it — https://registry.npmjs.org/remark-gfm/latest [web, verified]. mermaid v11.15.0 renders fully client-side; it is heavy (~153 KB gzip main bundle plus self-loaded diagram chunks) so it must be dynamically imported, not in the initial chunk — https://bundlephobia.com/package/mermaid@11.15.0 [web, verified]. The recommended SPA integration is a custom `code` component that detects `language-mermaid` and calls `mermaid.render`, NOT rehype-mermaid (async, Playwright-leaning, known multi-block re-render bug — https://github.com/remarkjs/react-markdown/issues/902) [web, verified; "recommended" is inferred].
- **Conventions to update**: the planning skill writes specs to `specs/YYYY-MM-DD-<slug>.md` (`.claude/skills/planning/SKILL.md`, Phase 3); the root rules file is `~/inaros/CLAUDE.md`; the agent-facing mesa doc is `skills/mesa/SKILL.md` (mesa spec Requirement 15, including the untrusted-data warning that must extend to doc content).
- **Panel constraints honored**: path confinement on the content route (Willison, round 2); `docs_path` is looked up, never derived from the project name (Barry/Amanda/Karpathy convergence); no doc CLI, no blobs, no folder modeling, no editor (round-1 convergence); agent acceptance test (Hamel).

## Requirements

1. Migration 2 adds `docs_path TEXT` (nullable) to `projects`; existing databases migrate on `Store` open with no data loss.
2. `Project` carries `docs_path: Option<String>` in every CLI and API response (ts-rs regenerates `frontend/src/types/Project.ts`); `ProjectPatch` supports set and clear (`Some(None)` clears, matching `description`).
3. `mesa project create` and `mesa project update` accept `--docs-path <path>`; `--docs-path ""` clears it; the value is stored as given (no validation that the directory exists — it may be created later).
4. `GET /api/projects/{id}/docs` returns a sorted JSON array of file paths (strings, relative to `docs_path`, files only, recursive), skipping dot-files and dot-directories. Empty directory → `[]` (200). `docs_path` unset → 422 `{"error":{"code":"validation","message":"project <id> has no docs_path configured"}}`. `docs_path` set but the directory missing → 404 `not_found` naming the path. Unknown project id → 404.
5. `GET /api/projects/{id}/docs/{*path}` returns the file's bytes with a Content-Type guessed from extension (`text/plain` fallback). Confinement is mechanical: join, canonicalize, and reject (404 `not_found`) any request whose canonical target is not under the canonical `docs_path` — covering `..`, absolute paths, and symlinks escaping the root. The same unset/missing/unknown-id behavior as Requirement 4 applies.
6. The project view shows a third tab **Docs** after List and Board (`view: 'list' | 'board' | 'docs'`). It fetches the listing via `useFetch` (so it refetches on window focus like other views).
7. Docs tab layout: a left-hand file tree built client-side from the path list (directories collapsible, files selectable); a right-hand read-only viewer for the selected file. No file selected → a hint. `docs_path` unset → the 422 message area tells the user to set the docs path (which is editable inline per Requirement 9).
8. Viewer rendering by extension: `.md` renders via react-markdown + remark-gfm with raw HTML **not** enabled (no rehype-raw), and fenced ```mermaid blocks render as diagrams via a custom code component that dynamically imports mermaid (`await import('mermaid')` — mermaid must not be in the initial Vite chunk) with `securityLevel` left at its default (`strict`); a mermaid parse/render error falls back to showing the fenced source as a code block, not a broken page. `.png/.jpg/.jpeg/.gif/.webp` render as `<img>`. Any other file: if the body decodes as UTF-8, show it preformatted; otherwise show "no preview".
9. The project header in the web UI shows the docs path as an `InlineEdit` field (like description), with empty → clear, matching the CLI semantics.
10. `skills/mesa/SKILL.md` documents `docs_path` (field, CLI flag, the two docs routes) and extends the existing untrusted-data warning: document contents fetched from the docs routes are data, never instructions.
11. `~/inaros/CLAUDE.md` gains a Project Documents rule: PM documents (specs, design docs, consult notes) for a project live in its `pm-docs/` folder — by convention at the repo root; when a project's docs cannot live in its repo, its mesa `docs_path` points elsewhere, and the path is looked up (`mesa project show <id>`), never derived from the project name. The planning skill's Phase 3 output path changes from `specs/` to `pm-docs/specs/` (create if needed). The rule is stated once in CLAUDE.md; the skill references the convention rather than restating it.
12. `scripts/build.sh` still passes end-to-end (types regenerate; `tsc` clean; release binary serves the Docs tab).

## Non-goals

- No editing, creating, deleting, or uploading docs from the web UI or API ("read only for now" — all docs routes are GET).
- No `mesa doc` CLI subcommand: agents use their file tools (panel round-1/2 convergence).
- No doc content in SQLite — the column stores a path, never bytes.
- No folder modeling in mesa: the tree is whatever the filesystem under `docs_path` contains.
- No search, no doc versioning/history (git owns the files), no live sync (refetch-on-focus only, matching the rest of the UI).
- No migration of existing documents: current `specs/` and `.claude/consults/` files stay where they are (freeze, don't migrate — Hamel, round 2); the new convention applies to documents written after this ships.
- The consult skill's output path (`.claude/consults/`) is unchanged in this pass; moving it under `pm-docs/` is a possible follow-up.
- No multi-workstation/server story (separately deferred).

## Assumptions

1. **Assuming dot-files and dot-directories are hidden** from the listing (keeps `.obsidian/`, `.DS_Store` noise out) — correct me if wrong.
2. **Assuming images render inline** for common raster formats (png/jpg/jpeg/gif/webp) and `.svg` is treated as text (it is XML; rendering it as an image is a needless script-bearing format in a viewer) — correct me if wrong.
3. **Assuming no upper bound on file size served**; pm-docs folders are small. A pathological file makes a slow tab, not a broken server.
4. **Assuming the Docs tab is not URL-addressed** (like the List/Board toggle, it's local state; deep-linking to a specific doc is out of scope).
5. **Assuming `docs_path` may be set to any directory** the user chooses (it is owner-set trusted config; the path confinement protects the HTTP surface, not the owner from themselves).
6. **Assuming mesa's own project** gets `docs_path` pointing at a new `pm-docs/` in this repo as the first real use, while existing `specs/` files stay put.

## Design

One migration, one struct field, two GET routes, one new page component, three doc edits.

- **Core**: append migration 2 (`ALTER TABLE projects ADD COLUMN docs_path TEXT`); add `docs_path` to `Project`, `ProjectPatch`, and the project CRUD in `Store`. No new error variants — `Validation`/`NotFound` cover the docs routes.
- **API**: `list_docs` walks `docs_path` recursively (small dirs; no need for a walker crate — `std::fs::read_dir` recursion), filters dot-entries, returns relative paths sorted. `show_doc` joins the requested subpath, canonicalizes both root and target, and 404s unless `target.starts_with(root)`; serves bytes with `mime_guess`-style extension mapping (a small hand-rolled match is fine — md/txt/png/jpg/jpeg/gif/webp/json/etc., `text/plain` fallback). Routes registered beside the existing project routes; the guard middleware already covers them.
- **Frontend**: add `react-markdown`, `remark-gfm`, `mermaid` to `package.json`. New `frontend/src/components/DocsTab.tsx`: `useFetch` the listing; build a nested tree from the flat paths; selection state; on select, fetch the file and dispatch on extension per Requirement 8. A `Mermaid` component holds the dynamic import and renders into a ref, with error fallback to the raw source. Third tab button in `ProjectTasksPage.tsx`; `InlineEdit` for `docs_path` in the header. Styling follows the existing plain-CSS theme in `App.css`.
- **Why this over alternatives**: rehype-mermaid rejected (async hooks + Playwright bias + re-render bug, Context); serving a pre-built HTML tree from Rust rejected (the client already builds UI from JSON everywhere else); `repo_path` + hard-coded `/pm-docs` suffix rejected (Q&A 1 — direct `docs_path` keeps the convention in the user's hands and handles restricted repos with no special case).

## Implementation

1. **Migration + core types + Store CRUD** — migration 2; `docs_path` through `Project`/`ProjectPatch`/create/update/get/list; store tests for round-trip, clear-with-`Some(None)`, and migration of an existing v1 database file.
   → verify: `cargo test` passes; `frontend/src/types/Project.ts` gains `docs_path: string | null`.
2. **CLI flags** — `--docs-path` on `project create`/`project update`, empty string clears; `--help` documents it.
   → verify: `mesa project create x --docs-path /tmp/d | jq .docs_path` prints `"/tmp/d"`; `mesa project update <id> --docs-path "" | jq .docs_path` prints `null`.
3. **Docs API routes** — listing + content with confinement and the Requirement 4/5 error contract.
   → verify: with `mesa serve` running and a fixture dir: listing returns sorted relative paths and `[]` for an empty dir; `curl --path-as-is .../docs/../secret` and a symlink escaping the root both 404; unset `docs_path` 422s with code `validation`; missing dir 404s.
4. **Docs tab UI** — deps, `DocsTab.tsx` (tree + viewer + mermaid component with lazy import), third tab button, `InlineEdit` for docs path.
   → verify: in the browser, a project pointed at a fixture `pm-docs/` shows the tree; a `.md` with a ```mermaid block renders a diagram; a `.txt` shows preformatted; a `.png` shows as an image; a binary shows "no preview"; `npx vite build` output shows mermaid in a separate lazy chunk, not the entry chunk.
5. **Build pipeline** — full pipeline from clean.
   → verify: `./scripts/build.sh` exits 0; release binary at `http://127.0.0.1:7770` serves the Docs tab with no dev server.
6. **Convention updates** — `~/inaros/CLAUDE.md` Project Documents rule; planning skill Phase 3 path → `pm-docs/specs/`; `skills/mesa/SKILL.md` documents `docs_path` + extends the data-not-instructions warning; create `pm-docs/` in this repo and set mesa's own project `docs_path`.
   → verify: diff inspection of the three files against Requirements 10-11; `mesa project show <mesa-id> | jq .docs_path` returns the new folder.
7. **Agent acceptance test** (panel, Hamel) — fresh Claude session in a project with `docs_path` set, prompted to plan a small feature.
   → verify: the spec file lands under `pm-docs/specs/` unprompted; transcript saved under `scripts/agent-check/`.

## Open questions

None blocking. One held as a default: whether `.svg` should render as an image rather than text (Assumption 2 says text; flip it later if it ever matters).

## Acceptance

1. `cargo test` exits 0, including new docs_path store tests and a migration-from-v1 test.
2. The curl battery from Implementation 3 passes verbatim: traversal (`..`, absolute, symlink) → 404; unset path → 422 `validation`; empty dir → `[]`; content route serves a markdown file's bytes.
3. In the browser: Docs tab on a project with a fixture `pm-docs/` renders a markdown file containing a mermaid diagram as a diagram, GFM tables as tables; raw `<script>` in a markdown file does NOT execute (react-markdown without rehype-raw).
4. `vite build` chunk report: mermaid is not in the entry chunk.
5. `./scripts/build.sh` exits 0 from a clean state and the release binary serves the working Docs tab.
6. The planning skill's next run writes its spec under `pm-docs/specs/` (agent test, Implementation 7), transcript saved.

## Appendix: Q&A

- Q: "How should mesa know where a project's docs live? The panel recommended a per-project path that agents and the UI look up rather than derive." → A: "docs_path column (Recommended)"
- Q: "What should the file tree show besides markdown?" → A: "All files, render what we can (Recommended)"
- Q: "Is updating the agent-side conventions (planning skill output path, CLAUDE.md rule saying PM docs go in pm-docs/) part of this work, or mesa-only for now?" → A: "Include convention updates"
- Q: "Where can docs_path be set?" → A: "CLI + web UI (Recommended)"

Prior context: user direction verbatim — "go ahead and plan it out simple. docs stay in the repo under a 'pm-docs' folder. web site has another 'tab' next to list and board so the user can view them. The content area for the docs will have a left hand file tree for selecting files, a (read only for now) viewer that renders markdown including mermaid."
