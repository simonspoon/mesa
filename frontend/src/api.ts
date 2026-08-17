// Typed fetch wrapper over the mesa REST API. All payload types are
// generated from the Rust domain types by ts-rs (src/types/) — do not
// hand-write payload shapes here (spec Requirement 12).

import type { AgentSession } from './types/AgentSession'
import type { AgentSpawned } from './types/AgentSpawned'
import type { AnchorSide } from './types/AnchorSide'
import type { Attachment } from './types/Attachment'
import type { CcDashboard } from './types/CcDashboard'
import type { CcLive } from './types/CcLive'
import type { CcNodeText } from './types/CcNodeText'
import type { CcSessionChat } from './types/CcSessionChat'
import type { CcSessionDetail } from './types/CcSessionDetail'
import type { CcSessionGraph } from './types/CcSessionGraph'
import type { CcUsage } from './types/CcUsage'
import type { ConfigCommand } from './types/ConfigCommand'
import type { ConfigPrice } from './types/ConfigPrice'
import type { ConfigSpeech } from './types/ConfigSpeech'
import type { ConfigLive } from './types/ConfigLive'
import type { ConfigWatchers } from './types/ConfigWatchers'
import type { Diagram } from './types/Diagram'
import type { DiagramEvent } from './types/DiagramEvent'
import type { DiagramType } from './types/DiagramType'
import type { DiagramView } from './types/DiagramView'
import type { DirEntry } from './types/DirEntry'
import type { DirListing } from './types/DirListing'
import type { EdgeMarker } from './types/EdgeMarker'
import type { EdgeStyle } from './types/EdgeStyle'
import type { FileContentView } from './types/FileContentView'
import type { FileTreeEntry } from './types/FileTreeEntry'
import type { Frame } from './types/Frame'
import type { FrameEdge } from './types/FrameEdge'
import type { FrameShape } from './types/FrameShape'
import type { GitCommitFile } from './types/GitCommitFile'
import type { GitFileDiff } from './types/GitFileDiff'
import type { InboxItem } from './types/InboxItem'
import type { InboxKind } from './types/InboxKind'
import type { LiveSession } from './types/LiveSession'
import type { LiveState } from './types/LiveState'
import type { LiveTurn } from './types/LiveTurn'
import type { MesaVersion } from './types/MesaVersion'
import type { ModelRates } from './types/ModelRates'
import type { ProjectFileSearch } from './types/ProjectFileSearch'
import type { ProjectFileTree } from './types/ProjectFileTree'
import type { ProjectGitLog } from './types/ProjectGitLog'
import type { ProjectGitStatus } from './types/ProjectGitStatus'
import type { ProjectGitView } from './types/ProjectGitView'
import type { ProjectVersion } from './types/ProjectVersion'
import type { Priority } from './types/Priority'
import type { Project } from './types/Project'
import type { Script } from './types/Script'
import type { ScriptArg } from './types/ScriptArg'
import type { ScriptRun } from './types/ScriptRun'
import type { Status } from './types/Status'
import type { Task } from './types/Task'
import type { TaskSummary } from './types/TaskSummary'
import type { Waypoint } from './types/Waypoint'

/** Error body shape shared by the API and CLI: {"error": {"code", "message"}}. */
export class ApiError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** The `ApiError` a failed response describes, whatever it answered with. */
async function apiErrorFrom(res: Response): Promise<ApiError> {
  let code = 'http_error'
  let message = `${res.status} ${res.statusText}`
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string }
    }
    if (body.error?.code) code = body.error.code
    if (body.error?.message) message = body.error.message
  } catch {
    // non-JSON error body: keep the HTTP status line as the message
  }
  return new ApiError(code, message, res.status)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  })
  if (!res.ok) throw await apiErrorFrom(res)
  return (await res.json()) as T
}

export interface TaskFilters {
  project?: number
  status?: Status
  tag?: string
  unblocked?: boolean
}

/**
 * Lists projects. Default excludes archived projects (matches CLI/API
 * default): every existing caller keeps calling `listProjects()` unedited
 * and inherits the exclusion. Pass `true` to include archived ones too
 * (the sidebar's "archived (N)" group).
 */
export function listProjects(includeArchived = false): Promise<Project[]> {
  return request(
    `/api/projects${includeArchived ? '?include_archived=true' : ''}`,
  )
}

export function getProject(id: number): Promise<Project> {
  return request(`/api/projects/${id}`)
}

export function listTasks(filters: TaskFilters = {}): Promise<TaskSummary[]> {
  const params = new URLSearchParams()
  if (filters.project !== undefined) params.set('project', String(filters.project))
  if (filters.status !== undefined) params.set('status', filters.status)
  if (filters.tag !== undefined && filters.tag !== '') params.set('tag', filters.tag)
  if (filters.unblocked) params.set('unblocked', 'true')
  const qs = params.toString()
  return request(`/api/tasks${qs ? `?${qs}` : ''}`)
}

export function getTask(id: number): Promise<Task> {
  return request(`/api/tasks/${id}`)
}

/** Moves a task to a new status (kanban drop): PATCH /api/tasks/:id. */
export function updateTaskStatus(id: number, status: Status): Promise<Task> {
  return request(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}

/**
 * Board drag-and-drop (spec 328): sets the dropped card's manual order,
 * and its status too when the drop also changed columns.
 */
export function updateTaskPosition(
  id: number,
  status: Status | undefined,
  sortOrder: number,
): Promise<Task> {
  return request(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, sort_order: sortOrder }),
  })
}

/** The full task objects `id` is directly blocked by. */
export function listDependencies(id: number): Promise<Task[]> {
  return request(`/api/tasks/${id}/dependencies`)
}

// Mutation request shapes. These are inputs to PATCH/POST, not API payload
// mirrors, so they are hand-written (responses use the generated types).
// PATCH semantics: an absent field is left unchanged (JSON.stringify drops
// `undefined`), an explicit `null` clears it.

export interface ProjectPatch {
  name?: string
  description?: string | null
  local_path?: string | null
  /** Manual nav position; the column is NOT NULL, so there is no `| null`
   *  clear here the way the free-text fields have one. */
  sort_order?: number
  /** Parent project (task 668); `null` detaches to top level. A cycle is a
   *  409, an unknown parent a 422. */
  parent_id?: number | null
}

export interface TaskCreate {
  project_id: number
  /** Required: a task's description is its identity, and its first line is
   *  the `name` every surface renders. */
  description: string
  status?: Status
  priority?: Priority
  tags?: string[]
  parent_id?: number
}

export interface TaskPatch {
  /** Replace-only: the description is the task's identity, so there is no
   *  `null` clear — the server answers one with a 422. */
  description?: string
  status?: Status
  priority?: Priority
  tags?: string[]
  // Long-text fields; `null` clears, omitting leaves the stored value alone
  // (the server's `double_option`).
  acceptance?: string | null
  artifact?: string | null
  result?: string | null
  sort_order?: number
}

export function createProject(
  name: string,
  description?: string,
  local_path?: string,
): Promise<Project> {
  return request(
    '/api/projects',
    jsonInit('POST', { name, description, local_path }),
  )
}

export function updateProject(id: number, patch: ProjectPatch): Promise<Project> {
  return request(`/api/projects/${id}`, jsonInit('PATCH', patch))
}

/** Returns the destroyed records: the project, the subprojects the cascade
 *  took with it (task 668; `[]` for a leaf) and all their tasks. */
export function deleteProject(
  id: number,
): Promise<{ project: Project; subprojects: Project[]; tasks: Task[] }> {
  return request(`/api/projects/${id}`, {
    method: 'DELETE',
    // No body, but the server's guard requires JSON Content-Type on all
    // mutating methods (src/api.rs Requirement 7 middleware).
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Hides the project from default lists/pickers; reversible, no cascade. */
export function archiveProject(id: number): Promise<Project> {
  return request(`/api/projects/${id}/archive`, jsonInit('POST', {}))
}

/** Reverses `archiveProject`. */
export function unarchiveProject(id: number): Promise<Project> {
  return request(`/api/projects/${id}/unarchive`, jsonInit('POST', {}))
}

export function createTask(body: TaskCreate): Promise<Task> {
  return request('/api/tasks', jsonInit('POST', body))
}

export function updateTask(id: number, patch: TaskPatch): Promise<Task> {
  return request(`/api/tasks/${id}`, jsonInit('PATCH', patch))
}

/** Returns the destroyed records: the task plus all cascaded subtasks. */
export function deleteTask(id: number): Promise<Task[]> {
  return request(`/api/tasks/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---- attachments (files attached to a task) ----

/** A task's attachments (metadata only — never content bytes). */
export function listAttachments(taskId: number): Promise<Attachment[]> {
  return request(`/api/tasks/${taskId}/attachments`)
}

export interface AttachmentCreate {
  filename: string
  /** Base64-encoded file content (no `data:` prefix). Not FormData/multipart
   * — the API only accepts base64-in-JSON, a deliberate CSRF-preserving
   * decision (arch.md §4): the mutating-method Content-Type gate only allows
   * `application/json`, which a plain HTML form cannot set. */
  content_base64: string
  author?: string
}

export function createAttachment(
  taskId: number,
  body: AttachmentCreate,
): Promise<Attachment> {
  return request(`/api/tasks/${taskId}/attachments`, jsonInit('POST', body))
}

/** Returns the destroyed attachment. */
export function deleteAttachment(id: number): Promise<Attachment> {
  return request(`/api/attachments/${id}`, jsonDelete())
}

/** Raw-bytes download/preview URL — used directly as `<a href>`/`<img src>`,
 * no further encoding needed (arch.md §4). */
export function attachmentDownloadUrl(id: number): string {
  return `/api/attachments/${id}/download`
}

/** Git status of each project's local_path; projects without a repo omitted. */
export function getGitStatus(): Promise<ProjectGitStatus[]> {
  return request('/api/git-status')
}

/** mesa's own version (the running binary's CARGO_PKG_VERSION). */
export function getMesaVersion(): Promise<MesaVersion> {
  return request('/api/version')
}

/**
 * The app version in the project's local_path, read out of its manifest
 * (Cargo.toml, then package.json, then pyproject.toml). Decoration for the
 * project header: no folder / no manifest is `{version: null, source: null}`,
 * never an error.
 */
export function getProjectVersion(id: number): Promise<ProjectVersion> {
  return request(`/api/projects/${id}/version`)
}

/**
 * Working-tree view of the project's local_path repo: branch summary plus the
 * changed/untracked file list, plus every worktree of that repo. Empty states
 * are data, never errors: path null = no local_path; path set + repo null =
 * folder gone / not a repo. `worktree` selects which worktree `repo`
 * reflects (must be one of the response's own `worktrees[].path`); omitted =
 * the project's `local_path`.
 */
export function getProjectGit(
  id: number,
  worktree?: string,
): Promise<ProjectGitView> {
  const q = worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''
  return request(`/api/projects/${id}/git${q}`)
}

/**
 * Unified diff (vs HEAD; untracked files as all-added) for one path from the
 * status list. Non-listed paths are 404 — the UI only asks for listed files.
 * `worktree` scopes both the status list and the diff read to that worktree
 * (same selector as getProjectGit).
 */
export function getProjectGitDiff(
  id: number,
  path: string,
  worktree?: string,
): Promise<GitFileDiff> {
  const wt = worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''
  return request(
    `/api/projects/${id}/git/diff?path=${encodeURIComponent(path)}${wt}`,
  )
}

/** Recent commit log for the project's local_path repo, or for one of its
 * worktrees when `worktree` selects one (same selector as getProjectGit — a
 * worktree has its own HEAD, so its log is its own branch's). Empty states are
 * data, never errors: path null = no local_path; path set + commits null =
 * folder gone / not a repo; commits = [] = a real repo with no commits yet. */
export function getProjectGitLog(
  id: number,
  worktree?: string,
): Promise<ProjectGitLog> {
  const q = worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''
  return request(`/api/projects/${id}/git/log${q}`)
}

/** Commit history for ONE file under the project's local_path — backs the
 * Files tab's History pane. Same `ProjectGitLog` shape and empty-state ladder
 * as `getProjectGitLog` above, with one extra reading: `commits = []` here
 * means the file itself has no commits yet (untracked / never committed),
 * not that the repo is empty. 404s on a path that doesn't resolve inside
 * local_path. Takes no worktree — unlike the whole-repo log, since the Files
 * tab browses local_path's own tree. */
export function getProjectGitFileLog(
  id: number,
  path: string,
): Promise<ProjectGitLog> {
  return request(
    `/api/projects/${id}/git/file-log?path=${encodeURIComponent(path)}`,
  )
}

/** Files changed in one commit. 404s (surfaced as a thrown/rejected error
 * by `request`, same as any other endpoint) on an unknown/invalid sha. */
export function getProjectGitCommitFiles(
  id: number,
  sha: string,
): Promise<GitCommitFile[]> {
  return request(
    `/api/projects/${id}/git/commits/${encodeURIComponent(sha)}/files`,
  )
}

/** Unified diff of one file as of one commit. `path` must come from that
 * SAME commit's own getProjectGitCommitFiles() result — passing a
 * working-tree path that wasn't touched by this commit 404s. */
export function getProjectGitCommitDiff(
  id: number,
  sha: string,
  path: string,
): Promise<GitFileDiff> {
  return request(
    `/api/projects/${id}/git/commits/${encodeURIComponent(sha)}/diff?path=${encodeURIComponent(path)}`,
  )
}

// ---- fs (server-side directory listing, backs the new-project folder picker) ----

/**
 * Directories under `path` (or the server's `$HOME` if omitted). Directories
 * only, one level deep — used to drive the new-project folder-picker's
 * navigation (breadcrumb via `parent`, click-to-enter via each entry's
 * `path`). Loopback-gated server-side, but same-origin fetches from the web
 * UI clear that transparently.
 */
export function listFsDirs(path?: string): Promise<DirListing> {
  const qs = path !== undefined ? `?path=${encodeURIComponent(path)}` : ''
  return request(`/api/fs/dirs${qs}`)
}

/**
 * Creates one folder named `name` directly inside the absolute directory
 * `path`, so a project can be started in a folder that doesn't exist yet.
 * `name` must be a single folder name, not a path (`validation` otherwise);
 * an already-taken name is `conflict`. Echoes the new directory as a
 * `DirEntry` identical in shape to the ones `listFsDirs` returns, so the
 * picker can navigate straight into it.
 */
export function createFsDir(path: string, name: string): Promise<DirEntry> {
  return request('/api/fs/dirs', jsonInit('POST', { path, name }))
}

// ---- files (read-only file tree + content, local_path-anchored) ----

/**
 * One directory level of a project's file tree, rooted at local_path:
 * `local_path` itself when `path` is omitted, else the subdirectory `path`
 * resolves to (mesa task 410's lazy per-directory walk — a call never
 * returns more than one level). Empty states are data, never errors: path
 * null = no local_path; path set + tree null = folder gone / unreadable;
 * tree = [] = a real, empty (or fully-excluded) directory.
 */
export function getProjectFiles(
  id: number,
  path?: string,
): Promise<ProjectFileTree> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return request(`/api/projects/${id}/files${query}`)
}

/**
 * One file's content (or a binary/truncation indicator) by its path from
 * that SAME project's tree above. An unsafe/unlisted/nonexistent path, or a
 * directory given where a file is expected, 404s.
 */
export function getProjectFilesContent(
  id: number,
  path: string,
): Promise<FileContentView> {
  return request(
    `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}`,
  )
}

/**
 * Raw-bytes download URL for one file of the project's tree (mesa task 683) —
 * the file itself, not the capped/binary-blanked view above, which is why the
 * download can't be built client-side from `content`. Fetched (not used as an
 * `<a href>`) so a 404/422 renders in the pane instead of navigating the SPA
 * away to a JSON error page.
 */
export function projectFileDownloadUrl(id: number, path: string): string {
  return `/api/projects/${id}/files/download?path=${encodeURIComponent(path)}`
}

/**
 * Inline-image URL for one file of the project's tree (mesa task 801) — used
 * directly as an `<img src>`, never fetched as JSON, so no further encoding is
 * needed beyond the query escape here. The route serves only the allowlisted
 * image types (`isImagePath` in `fileImage.ts` mirrors that allowlist), with
 * `Content-Disposition: inline`, `nosniff` and a strict CSP; anything else it
 * refuses. Distinct from `projectFileDownloadUrl`, which is a save-to-disk
 * attachment fetched through `fetch` so its errors render in the pane.
 */
export function projectFileRawUrl(id: number, path: string): string {
  return `/api/projects/${id}/files/raw?path=${encodeURIComponent(path)}`
}

/**
 * Saves a file's full content, overwriting it on disk. Path and content ride
 * the JSON body (matches the request wrapper's Content-Type header, keeping
 * this mutating call inside the API's CSRF gate). A binary/truncated target,
 * or oversized new content, 422s; an unsafe/unlisted/nonexistent path 404s.
 * Returns the freshly re-read `FileContentView`.
 */
export function updateProjectFilesContent(
  id: number,
  path: string,
  content: string,
): Promise<FileContentView> {
  return request(
    `/api/projects/${id}/files/content`,
    jsonInit('PATCH', { path, content }),
  )
}

/**
 * Creates one EMPTY file at `path`, relative to the project's local_path
 * (mesa task 672). No content rides along — the file starts empty and is
 * filled in through `updateProjectFilesContent` above, which keeps a single
 * place where content is capped and binary-checked.
 *
 * A parent directory that doesn't resolve (traversal, absolute path, missing,
 * or itself a file) 404s; a final component that isn't a usable single file
 * name (empty, `.`/`..`, containing a separator) 422s; a name already taken on
 * disk — file, directory or dangling symlink — 409s. Returns the freshly read
 * `FileContentView` of the new file, so it can be opened without a second
 * request.
 */
export function createProjectFile(
  id: number,
  path: string,
): Promise<FileContentView> {
  return request(
    `/api/projects/${id}/files/content`,
    jsonInit('POST', { path }),
  )
}

/**
 * Renames one tree entry — file or directory — **within its own directory**
 * (mesa task 877). `name` is a single component, never a path: this moves
 * nothing between folders, which is what keeps the operation checkable against
 * the same `safe_path` chokepoint every other Files route goes through.
 *
 * An unsafe/unlisted/nonexistent `path` 404s; a `name` that isn't a usable
 * single component (empty, `.`/`..`, containing a separator), or a `path` naming
 * the project root itself, 422s; a name already taken on disk 409s. Returns the
 * renamed `FileTreeEntry`, whose `path` is what the open tabs are re-pointed at.
 */
export function renameProjectFileEntry(
  id: number,
  path: string,
  name: string,
): Promise<FileTreeEntry> {
  return request(
    `/api/projects/${id}/files/entry`,
    jsonInit('PATCH', { path, name }),
  )
}

/**
 * Deletes one tree entry (mesa task 877). A directory goes **recursively**,
 * with its whole contents — the same no-confirmation, no-`--force` posture the
 * rest of mesa takes, so the confirmation is the caller's job (the Files tree
 * raises an inline two-step prompt before it gets here).
 *
 * The path rides the query rather than a body, matching the other body-less
 * DELETEs; the JSON Content-Type still goes out, since the guard middleware
 * requires it on every mutating method. An unsafe/unlisted/nonexistent path
 * 404s; the project root itself 422s. Returns the destroyed `FileTreeEntry`,
 * which is what tells the tree whether a whole subtree of tabs just went away.
 */
export function deleteProjectFileEntry(
  id: number,
  path: string,
): Promise<FileTreeEntry> {
  return request(
    `/api/projects/${id}/files/entry?path=${encodeURIComponent(path)}`,
    jsonDelete(),
  )
}

/**
 * Every match of a literal `query` across the project's tree (mesa task 813) —
 * the Files tab's Cmd/Ctrl+Shift+F panel. Grouped by file, capped server-side
 * on every axis (matches per file, files, total, files opened), and searching
 * exactly the tree the browser lists: excluded and binary files are skipped
 * there, not filtered here.
 *
 * An empty query never reaches this (the panel refuses it) and would 422; a
 * query that simply matches nothing is a 200 with no files.
 */
export function searchProjectFiles(
  id: number,
  query: string,
  options: { caseSensitive: boolean; wholeWord: boolean },
): Promise<ProjectFileSearch> {
  const params = new URLSearchParams({ q: query })
  if (options.caseSensitive) params.set('case', 'true')
  if (options.wholeWord) params.set('word', 'true')
  return request(`/api/projects/${id}/files/search?${params.toString()}`)
}

// ---- agents (live Claude Code sessions; local/LAN-page-gated endpoints) ----

/** Every live Claude Code session on the machine (no folder filter) — backs
 * the persistent Agents sidebar. */
export function listAllAgents(): Promise<AgentSession[]> {
  return request('/api/agents')
}

/** Starts a background agent session in the project's folder, running the
 * `agent-spawn` command from `~/.mesa/config.json` (`claude --bg …` by
 * default). `id` is null when that command printed no job-id receipt — the
 * session started, it just can't be attached to by id yet. */
export function spawnProjectAgent(
  id: number,
  body: { prompt?: string } = {},
): Promise<AgentSpawned> {
  return request(`/api/projects/${id}/agents`, jsonInit('POST', body))
}

// ---- diagrams ----
// The guard middleware requires a JSON Content-Type on every mutating method,
// so even body-less DELETEs send the header (src/api.rs Requirement 7).

function jsonDelete(): RequestInit {
  return { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }
}

/** `?author=` query for the change history on body-less DELETEs. */
function actorQuery(author?: string): string {
  return author ? `?author=${encodeURIComponent(author)}` : ''
}

export function listDiagrams(project?: number): Promise<Diagram[]> {
  const qs = project !== undefined ? `?project=${project}` : ''
  return request(`/api/diagrams${qs}`)
}

/** A board's full contents in one object: the board plus its frames and edges. */
export function getDiagram(id: number): Promise<DiagramView> {
  return request(`/api/diagrams/${id}`)
}

/** The board's change history (who/what/when), oldest first. */
export function listDiagramEvents(id: number): Promise<DiagramEvent[]> {
  return request(`/api/diagrams/${id}/events`)
}

export interface DiagramCreate {
  project_id: number
  title: string
  description?: string
  author?: string
  diagram_type?: DiagramType
}

export function createDiagram(body: DiagramCreate): Promise<Diagram> {
  return request('/api/diagrams', jsonInit('POST', body))
}

export interface DiagramPatch {
  title?: string
  description?: string | null
}

export function updateDiagram(
  id: number,
  patch: DiagramPatch,
  author?: string,
): Promise<Diagram> {
  return request(`/api/diagrams/${id}`, jsonInit('PATCH', { ...patch, author }))
}

/** Returns the destroyed contents: the board plus all cascaded frames/edges. */
export function deleteDiagram(id: number): Promise<DiagramView> {
  return request(`/api/diagrams/${id}`, jsonDelete())
}

export interface FrameCreate {
  title: string
  body?: string
  x?: number
  y?: number
  w?: number
  h?: number
  color?: string
  task_id?: number
  author?: string
  shape?: FrameShape
}

export function createFrame(
  diagramId: number,
  body: FrameCreate,
): Promise<Frame> {
  return request(`/api/diagrams/${diagramId}/frames`, jsonInit('POST', body))
}

export interface FramePatch {
  title?: string
  body?: string | null
  x?: number
  y?: number
  w?: number
  h?: number
  color?: string | null
  task_id?: number | null
}

export function updateFrame(
  id: number,
  patch: FramePatch,
  author?: string,
): Promise<Frame> {
  return request(`/api/frames/${id}`, jsonInit('PATCH', { ...patch, author }))
}

/** Returns the destroyed frame and the edges that cascaded with it. */
export function deleteFrame(
  id: number,
  author?: string,
): Promise<{ frame: Frame; edges: FrameEdge[] }> {
  return request(`/api/frames/${id}${actorQuery(author)}`, jsonDelete())
}

export interface EdgeCreate {
  from_frame: number
  to_frame: number
  label?: string
  author?: string
}

export function createEdge(
  diagramId: number,
  body: EdgeCreate,
): Promise<FrameEdge> {
  return request(`/api/diagrams/${diagramId}/edges`, jsonInit('POST', body))
}

export interface EdgePatch {
  label?: string | null
  waypoints?: Waypoint[]
  from_anchor?: AnchorSide | null
  to_anchor?: AnchorSide | null
  /** Connector properties (mesa task 854). Same three-state `double_option`
   *  contract as the anchors: omitted leaves the field untouched, an explicit
   *  `null` clears it back to the default, a value sets it. */
  style?: EdgeStyle | null
  from_marker?: EdgeMarker | null
  to_marker?: EdgeMarker | null
}

export function updateEdge(
  id: number,
  patch: EdgePatch,
  author?: string,
): Promise<FrameEdge> {
  return request(`/api/edges/${id}`, jsonInit('PATCH', { ...patch, author }))
}

/** Returns the destroyed edge. */
export function deleteEdge(id: number, author?: string): Promise<FrameEdge> {
  return request(`/api/edges/${id}${actorQuery(author)}`, jsonDelete())
}

// ---- inbox (global update requests) ----

/** Inbox items, newest first. With `project`, only items assigned there. */
export function listInbox(project?: number): Promise<InboxItem[]> {
  const qs = project !== undefined ? `?project=${project}` : ''
  return request(`/api/inbox${qs}`)
}

export function getInboxItem(id: number): Promise<InboxItem> {
  return request(`/api/inbox/${id}`)
}

export interface InboxCreate {
  body: string
  /**
   * The task this item comes from (mesa task 847). Required: an item always
   * reports on a piece of work, and that task is what names the project and
   * the work on the reader's first line. An unknown id is a 422.
   */
  task_id: number
  author?: string
  /**
   * What the item is for (mesa task 846). Omitted, it is a `task-summary`:
   * the server decides, so a caller that says nothing never has an item
   * auto-triaged on its behalf.
   */
  kind?: InboxKind
}

export function createInboxItem(body: InboxCreate): Promise<InboxItem> {
  return request('/api/inbox', jsonInit('POST', body))
}

/**
 * Assign an item to a project: converts it into a todo task there and removes
 * it from the inbox. Resolves to the created task.
 */
export function assignInboxItem(id: number, projectId: number): Promise<Task> {
  return request(`/api/inbox/${id}`, jsonInit('PATCH', { project_id: projectId }))
}

/**
 * Mark an item read (mesa task 831), stamping `read_at` the first time. The
 * route is idempotent, so the page may send it without knowing whether it
 * already has; the resolved item carries the stamp.
 */
export function markInboxItemRead(id: number): Promise<InboxItem> {
  return request(`/api/inbox/${id}/read`, jsonInit('POST', {}))
}

/**
 * Archive an item, or put it back (mesa task 845). Unlike the read mark this
 * toggles, so the direction is the body; the resolved item carries the new
 * `archived_at`.
 */
export function setInboxItemArchived(
  id: number,
  archived: boolean,
): Promise<InboxItem> {
  return request(`/api/inbox/${id}/archive`, jsonInit('POST', { archived }))
}

/**
 * Spoken-audio URL for one inbox item (mesa task 815) — used directly as an
 * `<audio src>`, never fetched as JSON. The route synthesises the item's body
 * with `kokoro-rs` on the server and answers `audio/wav`; synthesis runs on
 * every request, so treat the URL as a play action rather than a cheap read.
 */
export function inboxSpeakUrl(id: number): string {
  return `/api/inbox/${id}/speak`
}

/**
 * Any of mesa's spoken-audio routes as a body the page reads itself (mesa task
 * 830) — the fallback for a browser whose media stack refuses the streamed
 * response. Apple's (iOS Safari, and Safari on a Mac) requires byte-range
 * support of an HTTP media source, and these routes are chunked with no
 * `Content-Length` on purpose, so `<audio src>` never gets past "the server is
 * not correctly configured" there. A `fetch` asks for none of that, and its
 * body arrives in pieces, so the audio can still start on the first sentence —
 * the decoding and the playing are `speechStream.ts`.
 *
 * Takes the URL rather than an item id (mesa task 855): the inbox and the live
 * page speak over two different routes, and which one is being read is the
 * caller's business, not this function's.
 *
 * A second full synthesis, so it is a fallback and never the first attempt:
 * the routes cache nothing. `signal` is what stop cancels it with — the render
 * already running on the server finishes regardless, as it does for a listener
 * that hangs up mid-stream.
 */
export async function fetchSpeech(
  url: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw await apiErrorFrom(res)
  if (res.body === null) throw new ApiError('http_error', 'no audio', 200)
  return res.body
}

/** Returns the destroyed item. */
export function deleteInboxItem(id: number): Promise<InboxItem> {
  return request(`/api/inbox/${id}`, jsonDelete())
}

// ---- live (the spoken conversation, mesa task 855) ----

/**
 * The Live page's one read: the current conversation, if any, and the turns
 * after `after`. The cursor is exclusive, so a poll that asks for what it has
 * already seen answers with an empty array — the transcript is accumulated by
 * the page (`liveTurns.ts`), not re-sent every two seconds.
 */
export function getLive(after?: number): Promise<LiveState> {
  const qs = after !== undefined ? `?after=${after}` : ''
  return request(`/api/live${qs}`)
}

/**
 * Starts a conversation and spawns the agent that drives it. At most one may
 * be live, so a second start while one is running is a 409 `conflict` naming
 * the session already there.
 */
export function startLive(projectId?: number): Promise<LiveSession> {
  return request('/api/live', jsonInit('POST', { project_id: projectId ?? null }))
}

/** Ends the conversation. Idempotent: ending an ended one returns it unchanged. */
export function stopLive(): Promise<LiveSession> {
  return request('/api/live', jsonDelete())
}

/**
 * One dictated line from the person. Free text from a microphone by way of the
 * OS — untrusted data, which is why it goes into the store as a turn and
 * reaches the agent as one argument rather than anything a shell parses.
 */
export function sendLiveUtterance(text: string): Promise<LiveTurn> {
  return request('/api/live/utterance', jsonInit('POST', { text }))
}

/**
 * The page reporting where the browser is, so the agent knows what the person
 * is looking at. Ambient, like the inbox's read mark: sent on arrival and on
 * every hash change, and a failure is forgotten rather than shown.
 */
export function reportLiveRoute(route: string): Promise<LiveSession> {
  return request('/api/live/route', jsonInit('POST', { route }))
}

/**
 * Stamps a mesa turn as spoken, the first time. Idempotent and never moved —
 * the `read_at` rule — so a re-render can never make the page say a turn twice.
 */
export function markLiveTurnPlayed(id: number): Promise<LiveTurn> {
  return request(`/api/live/turns/${id}/played`, jsonInit('POST', {}))
}

/**
 * Spoken-audio URL for one live turn — used directly as an `<audio src>`, or
 * handed to `fetchSpeech` on the decode-it-yourself path. Synthesis runs on
 * every request, exactly as `inboxSpeakUrl`'s does, so it is a play action
 * rather than a cheap read; a turn with no text (a pure navigate) is a 422.
 */
export function liveSpeakUrl(id: number): string {
  return `/api/live/turns/${id}/speak`
}

// ---- CC Dashboard (Claude Code telemetry) ----

/** Claude Code telemetry for a window (`7d` | `30d` | `90d` | `all`). */
export function getCcDashboard(window: string): Promise<CcDashboard> {
  return request(`/api/cc?window=${encodeURIComponent(window)}`)
}

/**
 * Claude Code telemetry scoped to one project's sessions (cwd == local_path).
 * Same shape as getCcDashboard; never errors on an unmatched/unset local_path
 * (empty/zero dashboard instead) — only an unknown project id 404s.
 */
export function getProjectCcDashboard(
  projectId: number,
  window: string,
): Promise<CcDashboard> {
  return request(
    `/api/projects/${projectId}/cc?window=${encodeURIComponent(window)}`,
  )
}

/** Currently-running Claude Code sessions over the last `minutes`. */
export function getCcLive(minutes: number): Promise<CcLive> {
  return request(`/api/cc/live?minutes=${minutes}`)
}

/**
 * One session's call tree (nodes + edges). 404s for a session that was never
 * ingested — an empty graph is a real answer for a session that made no calls,
 * so the two are kept distinct.
 */
export function getCcSessionGraph(sessionId: string, limit?: number): Promise<CcSessionGraph> {
  const q = limit === undefined ? '' : `?limit=${limit}`
  return request(`/api/cc/sessions/${encodeURIComponent(sessionId)}/graph${q}`)
}

/**
 * The body behind one node of that call tree — a prompt's or response's prose,
 * or a tool call's / subagent spawn's full input. Read on demand, never part
 * of the graph payload: bodies are not stored in the db, so this one route
 * goes back to the transcript on disk. Hence a third failure mode beyond 404
 * (unknown node) and 422 (the `session` node has no text of its own): 503
 * `unavailable` when Claude Code has since deleted the transcript. `format`
 * says how to render `text` — `json` for tool/agent inputs, `text` for prose.
 */
export function getCcNodeText(sessionId: string, nodeId: string): Promise<CcNodeText> {
  return request(
    `/api/cc/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}/text`,
  )
}

/**
 * One session's conversation — the Agent sidebar's chat view (task 814): its
 * main-thread prompts, replies and tool calls, oldest first, with full
 * uncapped bodies on the prose. Read straight off the transcript, so unlike
 * every other cc read it costs no ingest and answers for a session mesa
 * spawned moments ago; that is also why it is safe to poll. 503 `unavailable`
 * when the session has no transcript on disk.
 *
 * `text` on a prompt/response turn is **untrusted model-authored text**: it
 * may be rendered as markdown (structure only — `Markdown` never passes raw
 * HTML through) but never as HTML, and never as a URL.
 */
export function getCcSessionChat(sessionId: string, limit?: number): Promise<CcSessionChat> {
  const q = limit === undefined ? '' : `?limit=${limit}`
  return request(`/api/cc/sessions/${encodeURIComponent(sessionId)}/chat${q}`)
}

/**
 * One session's aggregate detail — the default drill-down. Aggregated
 * server-side over every persisted row (the graph payload caps its nodes and
 * repeats one message's usage across siblings, so none of this is derivable
 * from it). 404s for a session that was never ingested.
 */
export function getCcSessionDetail(sessionId: string): Promise<CcSessionDetail> {
  return request(`/api/cc/sessions/${encodeURIComponent(sessionId)}`)
}

/** Live subscription usage (plan limits + reset times), fetched from Anthropic. */
export function getCcUsage(): Promise<CcUsage> {
  return request('/api/cc/usage')
}

/**
 * Relaunches the server on the current mesa binary on disk. The old process
 * exits shortly after responding, so the caller should poll for the server
 * coming back up (see `waitForServer` in Sidebar.tsx) before reloading.
 */
export function restartServer(): Promise<{ restarting: boolean }> {
  return request('/api/restart', jsonInit('POST', {}))
}

/** What one CC index reset re-ingested. Mirrors Rust's `CcSyncReport`, which
 * is CLI-facing and deliberately not a ts-rs export — hence hand-written here,
 * like `restartServer()`'s `{restarting}`. */
export type CcResetReport = {
  files_scanned: number
  files_ingested: number
  sessions: number
  messages_added: number
  tool_calls_added: number
}

/**
 * Deletes every stored `cc_*` row and re-reads the transcripts on disk — the
 * fix for costs recorded before the usage-dedupe fix, which a plain re-sync
 * cannot correct. Destructive: sessions whose transcript file is gone are lost
 * permanently. Takes ~10-30s on a real tree.
 */
export function resetCcIndex(): Promise<CcResetReport> {
  return request('/api/cc/reset', jsonInit('POST', {}))
}

/**
 * The four agent-spawn command templates in `~/.mesa/config.json`, each with
 * the built-in default it falls back to and the placeholders it may use
 * (docs/config.md). 502 `unavailable` means the file itself is unreadable or
 * malformed — a real state the Settings page shows rather than papering over.
 */
export function getConfig(): Promise<ConfigCommand[]> {
  return request('/api/config')
}

/**
 * Writes command templates and echoes the settings as re-read from disk, so
 * the caller never has to guess what landed. Only the keys passed are touched;
 * a blank value clears one back to its built-in default. 422 `validation` is a
 * template the spawn path would later reject (bad placeholder, unbalanced
 * quote) — nothing is written in that case.
 */
export function updateConfig(
  commands: Record<string, string>,
): Promise<ConfigCommand[]> {
  return request('/api/config', jsonInit('PUT', { commands }))
}

/**
 * The per-model-family price table the CC Dashboard estimates cost from: the
 * rates mesa ships, each with the `~/.mesa/config.json` override that beats it
 * (docs/config.md). `value: null` means the built-in `default` is in use; a
 * `default: null` row is a prefix the user added. 502 `unavailable` means the
 * config file itself is unreadable, exactly as for `getConfig`.
 */
export function getPricing(): Promise<ConfigPrice[]> {
  return request('/api/config/pricing')
}

/**
 * Writes price rows and echoes the table as re-read from disk. Only the
 * prefixes passed are touched; `null` removes one — restoring the built-in
 * rate for a family mesa ships, deleting the row for one you added. 422
 * `validation` is a bad prefix or a rate that isn't a finite number ≥ 0, and
 * nothing is written in that case.
 */
export function updatePricing(
  pricing: Record<string, ModelRates | null>,
): Promise<ConfigPrice[]> {
  return request('/api/config/pricing', jsonInit('PUT', { pricing }))
}

/**
 * The watcher settings in `~/.mesa/config.json`: today, how many todo-watcher
 * agents a project may run at once (mesa task 777). `todo_concurrency: null`
 * means the config says nothing, so the shipped `todo_concurrency_default`
 * applies. 502 `unavailable` means the config file itself is unreadable,
 * exactly as for `getConfig`.
 */
export function getWatchers(): Promise<ConfigWatchers> {
  return request('/api/config/watchers')
}

/**
 * Writes watcher settings and echoes them as re-read from disk. Only the keys
 * passed are touched; `null` removes one, restoring the built-in default. 422
 * `validation` is a value outside the accepted range or not a whole number,
 * and nothing is written in that case.
 */
export function updateWatchers(
  watchers: Record<string, number | null>,
): Promise<ConfigWatchers> {
  return request('/api/config/watchers', jsonInit('PUT', watchers))
}

/**
 * The speech settings in `~/.mesa/config.json`: the voice the inbox's play
 * button speaks in (mesa task 822), plus every voice the installed `kokoro-rs`
 * reports. `voice: null` means the config says nothing, so the synthesiser's
 * own default applies; an empty `voices` means mesa could not ask the binary,
 * not that there are none. 502 `unavailable` means the config file itself is
 * unreadable, exactly as for `getConfig`.
 */
export function getSpeech(): Promise<ConfigSpeech> {
  return request('/api/config/speech')
}

/**
 * Writes speech settings and echoes them as re-read from disk. Only the keys
 * passed are touched; `null` removes one, restoring the synthesiser's default.
 * 422 `validation` is a name that isn't a voice (or isn't one this binary
 * offers), and nothing is written in that case.
 */
export function updateSpeech(
  speech: Record<string, string | null>,
): Promise<ConfigSpeech> {
  return request('/api/config/speech', jsonInit('PUT', speech))
}

/**
 * Spoken-sample URL for one voice (mesa task 824) — an `<audio src>` like
 * `inboxSpeakUrl`, never fetched as JSON. It speaks a fixed mesa sentence in
 * the voice named, reading nothing from the config file, which is what lets the
 * Settings page audition a **drafted** voice before saving it. A blank name is
 * the synthesiser's own default. Synthesis runs on every request, so this is a
 * play action, not a cheap read.
 */
export function speechPreviewUrl(voice: string): string {
  return `/api/config/speech/preview?voice=${encodeURIComponent(voice)}`
}

/**
 * The live settings in `~/.mesa/config.json`: the instruction block a live
 * conversation's agent is spawned with (mesa task 867), plus the block mesa
 * ships. `prompt: null` means the config says nothing, so `default_prompt` is
 * what the agent gets. 502 `unavailable` means the config file itself is
 * unreadable, exactly as for `getConfig`.
 */
export function getLiveConfig(): Promise<ConfigLive> {
  return request('/api/config/live')
}

/**
 * Writes live settings and echoes them as re-read from disk. Only the keys
 * passed are touched; `null` removes one, restoring the block mesa ships. 422
 * `validation` is a prompt past the length bound, and nothing is written then.
 */
export function updateLiveConfig(
  live: Record<string, string | null>,
): Promise<ConfigLive> {
  return request('/api/config/live', jsonInit('PUT', live))
}

// ---- scripts (user-authored shell) ----

/** The create/patch body. A `PATCH` sends only the keys it changes; `null` on
 * `project_id`/`description` clears that field, and `body` is sent verbatim —
 * it is shell source, so nothing on this path may rewrite it. */
export interface ScriptWrite {
  project_id?: number | null
  name?: string
  description?: string | null
  body?: string
  args?: ScriptArg[]
}

/** Every script, or just one project's. Ordered by name, server-side. */
export function listScripts(project?: number): Promise<Script[]> {
  const qs = project !== undefined ? `?project=${project}` : ''
  return request(`/api/scripts${qs}`)
}

export function getScript(id: number): Promise<Script> {
  return request(`/api/scripts/${id}`)
}

/**
 * Authoring a script is authoring a program mesa will execute, so all three
 * mutations are loopback-only in *both* serve modes (docs/scripts.md) — a 403
 * here is a LAN peer, not a bug. A duplicate name is 409 `conflict`.
 */
export function createScript(body: ScriptWrite): Promise<Script> {
  return request('/api/scripts', jsonInit('POST', body))
}

export function updateScript(id: number, body: ScriptWrite): Promise<Script> {
  return request(`/api/scripts/${id}`, jsonInit('PATCH', body))
}

/** Returns the destroyed record — the recoverable delete echo. */
export function deleteScript(id: number): Promise<Script> {
  return request(`/api/scripts/${id}`, jsonDelete())
}

/**
 * Runs the script with `values` (declared arguments only; a blank one is
 * omitted so its default fills in — see `scriptDraft.ts::valuesFor`). Resolves
 * for a **failing** script too: a nonzero `exit_code` is the script's own
 * result, carried in the record, not a rejected promise. Rejects only for a
 * validation error, a missing script, or bash failing to spawn (502
 * `unavailable`). Runs are not persisted.
 */
export function runScript(
  id: number,
  values: Record<string, string>,
): Promise<ScriptRun> {
  return request(`/api/scripts/${id}/run`, jsonInit('POST', { values }))
}
