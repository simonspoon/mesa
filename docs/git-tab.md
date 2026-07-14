# Git tab (read-only working-tree + history view per project)

The **Git** tab on a project page (web UI) shows the working tree of the
project's `local_path`: branch/ahead-behind + changed-file list, with a
per-file unified-diff pane, plus a **History** sub-view (toggle, default
Working tree) that browses commit history. Like `/api/git-status` it reads
**external** state via read-only `git` shell-outs (`view_of`/`diff_of`/
`commit_log_of`/`commit_files_of`/`commit_file_diff_of` in `src/core/git.rs`)
and touches the store only to read `local_path`. No CLI (an agent in a
terminal uses `git` directly). Standard middleware guard only — no
agent-style gate, it executes nothing.

- `GET /api/projects/{id}/git` → `ProjectGitView` via `git::view_of`
  (porcelain-v2 parse). Empty-state ladder like the agents endpoint: no
  `local_path` → `{path: null, repo: null}`; dead folder or non-repo →
  `{path, repo: null}`; never an error. Cached 5s per folder
  (`AppState.git_view_cache`).
- `GET /api/projects/{id}/git/diff?path=<file>` → `GitFileDiff` via
  `git::diff_of`. `?path=` is allowlisted by **byte-equal membership in git's
  own status output** (path or rename orig_path), so traversal/absolute/
  unlisted paths are 404 `not_found`. Untracked files (status `??`) diff via
  the `--no-index` route.
- `GET /api/projects/{id}/git/log` → `ProjectGitLog` via `git::commit_log_of`
  (`git log`, newest first, capped at `LOG_CAP` = 100 — browsing, not a full
  walk, no pagination). Same three-rung empty-state ladder one level deeper:
  no `local_path` → `{path: null, commits: null}`; dead folder/non-repo →
  `{path, commits: null}`; real repo → `{path, commits: Some(vec)}` (`[]` on
  an unborn HEAD). Cached 5s per folder (`AppState.git_log_cache`).
- `GET /api/projects/{id}/git/commits/{sha}/files` → `Vec<GitCommitFile>` via
  `git::commit_files_of` (`git show --name-status`). `GitCommitFile` is a
  distinct type from `GitFile`: its `status` is a single name-status token
  (`A`/`M`/`D`/`R100`/…), not the two-column staged/unstaged porcelain pair a
  working-tree file has — a commit has no staged/unstaged distinction. Root
  commits diff against the empty tree (all files `A`), so this and the diff
  route below work unmodified for a repo's first commit. 404 `not_found` on
  a malformed/unknown `sha` or no repo. Cached 5s per `(local_path, sha)`
  (`AppState.git_commit_files_cache`) — also backs the diff route's
  allowlist below, so selecting then diffing a commit's file doesn't re-run
  `git show --name-status` twice.
- `GET /api/projects/{id}/git/commits/{sha}/diff?path=<file>` → `GitFileDiff`
  via `git::commit_file_diff_of` (`git show <sha> -- <path>`, same
  `DIFF_CAP` truncation as the working-tree diff). `?path=` is allowlisted by
  byte-equal membership in **that commit's own** `commit_files_of` result
  (not the working-tree status list the sibling `/git/diff` route uses) —
  an unlisted path, or a bad/unknown `sha`, is 404 `not_found`. Diff text
  itself is not cached (matches `/git/diff`'s precedent).
- Every `sha` accepted from a request path is validated by
  `git::is_valid_commit_id` (7–64 hex chars) **before** any `git` subprocess
  is spawned, so it can never be read as a flag or a path.
