// Typed fetch wrapper over the mesa REST API. All payload types are
// generated from the Rust domain types by ts-rs (src/types/) — do not
// hand-write payload shapes here (spec Requirement 12).

import type { AgentSession } from './types/AgentSession'
import type { AgentSpawned } from './types/AgentSpawned'
import type { AnchorSide } from './types/AnchorSide'
import type { Attachment } from './types/Attachment'
import type { CcDashboard } from './types/CcDashboard'
import type { CcLive } from './types/CcLive'
import type { CcUsage } from './types/CcUsage'
import type { DiagramType } from './types/DiagramType'
import type { DirListing } from './types/DirListing'
import type { FileContentView } from './types/FileContentView'
import type { Frame } from './types/Frame'
import type { FrameEdge } from './types/FrameEdge'
import type { FrameShape } from './types/FrameShape'
import type { GitCommitFile } from './types/GitCommitFile'
import type { GitFileDiff } from './types/GitFileDiff'
import type { HookRun } from './types/HookRun'
import type { InboxItem } from './types/InboxItem'
import type { ProjectFileTree } from './types/ProjectFileTree'
import type { ProjectGitLog } from './types/ProjectGitLog'
import type { ProjectGitStatus } from './types/ProjectGitStatus'
import type { ProjectGitView } from './types/ProjectGitView'
import type { Priority } from './types/Priority'
import type { Project } from './types/Project'
import type { Status } from './types/Status'
import type { Storyboard } from './types/Storyboard'
import type { StoryboardEvent } from './types/StoryboardEvent'
import type { StoryboardView } from './types/StoryboardView'
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  })
  if (!res.ok) {
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
    throw new ApiError(code, message, res.status)
  }
  return (await res.json()) as T
}

export interface TaskFilters {
  project?: number
  status?: Status
  tag?: string
  unblocked?: boolean
}

export function listProjects(): Promise<Project[]> {
  return request('/api/projects')
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
}

export interface TaskCreate {
  project_id: number
  title: string
  description?: string
  status?: Status
  priority?: Priority
  tags?: string[]
  parent_id?: number
}

export interface TaskPatch {
  title?: string
  description?: string | null
  status?: Status
  priority?: Priority
  tags?: string[]
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

/** Returns the destroyed records: the project plus all cascaded tasks. */
export function deleteProject(
  id: number,
): Promise<{ project: Project; tasks: Task[] }> {
  return request(`/api/projects/${id}`, {
    method: 'DELETE',
    // No body, but the server's guard requires JSON Content-Type on all
    // mutating methods (src/api.rs Requirement 7 middleware).
    headers: { 'Content-Type': 'application/json' },
  })
}

export function createTask(body: TaskCreate): Promise<Task> {
  return request('/api/tasks', jsonInit('POST', body))
}

export function updateTask(id: number, patch: TaskPatch): Promise<Task> {
  return request(`/api/tasks/${id}`, jsonInit('PATCH', patch))
}

/**
 * Fires the task-execute hook (the shell command configured in the server's
 * local hooks.json). Resolves to the captured run — a nonzero exit_code is
 * carried inside, not thrown. Rejects with `validation` when no hook is
 * configured. Loopback/LAN-page gated like the agents endpoints.
 */
export function executeTask(id: number): Promise<HookRun> {
  return request(`/api/tasks/${id}/execute`, jsonInit('POST', {}))
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

/** Recent commit log for the project's local_path repo. Empty states are
 * data, never errors: path null = no local_path; path set + commits null =
 * folder gone / not a repo; commits = [] = a real repo with no commits yet. */
export function getProjectGitLog(id: number): Promise<ProjectGitLog> {
  return request(`/api/projects/${id}/git/log`)
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

// ---- files (read-only file tree + content, local_path-anchored) ----

/**
 * File tree rooted at the project's local_path. Empty states are data,
 * never errors: path null = no local_path; path set + tree null = folder
 * gone / unreadable; tree = [] = a real, empty (or fully-excluded) folder.
 */
export function getProjectFiles(id: number): Promise<ProjectFileTree> {
  return request(`/api/projects/${id}/files`)
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

// ---- agents (live Claude Code sessions; local/LAN-page-gated endpoints) ----

/** Every live Claude Code session on the machine (no folder filter) — backs
 * the persistent Agents sidebar. */
export function listAllAgents(): Promise<AgentSession[]> {
  return request('/api/agents')
}

/** Starts a background `claude --bg` session in the project's folder. */
export function spawnProjectAgent(
  id: number,
  body: { prompt?: string } = {},
): Promise<AgentSpawned> {
  return request(`/api/projects/${id}/agents`, jsonInit('POST', body))
}

// ---- storyboards ----
// The guard middleware requires a JSON Content-Type on every mutating method,
// so even body-less DELETEs send the header (src/api.rs Requirement 7).

function jsonDelete(): RequestInit {
  return { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }
}

/** `?author=` query for the change history on body-less DELETEs. */
function actorQuery(author?: string): string {
  return author ? `?author=${encodeURIComponent(author)}` : ''
}

export function listStoryboards(project?: number): Promise<Storyboard[]> {
  const qs = project !== undefined ? `?project=${project}` : ''
  return request(`/api/storyboards${qs}`)
}

/** A board's full contents in one object: the board plus its frames and edges. */
export function getStoryboard(id: number): Promise<StoryboardView> {
  return request(`/api/storyboards/${id}`)
}

/** The board's change history (who/what/when), oldest first. */
export function listStoryboardEvents(id: number): Promise<StoryboardEvent[]> {
  return request(`/api/storyboards/${id}/events`)
}

export interface StoryboardCreate {
  project_id: number
  title: string
  description?: string
  author?: string
  diagram_type?: DiagramType
}

export function createStoryboard(body: StoryboardCreate): Promise<Storyboard> {
  return request('/api/storyboards', jsonInit('POST', body))
}

export interface StoryboardPatch {
  title?: string
  description?: string | null
}

export function updateStoryboard(
  id: number,
  patch: StoryboardPatch,
  author?: string,
): Promise<Storyboard> {
  return request(`/api/storyboards/${id}`, jsonInit('PATCH', { ...patch, author }))
}

/** Returns the destroyed contents: the board plus all cascaded frames/edges. */
export function deleteStoryboard(id: number): Promise<StoryboardView> {
  return request(`/api/storyboards/${id}`, jsonDelete())
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
  storyboardId: number,
  body: FrameCreate,
): Promise<Frame> {
  return request(`/api/storyboards/${storyboardId}/frames`, jsonInit('POST', body))
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
  storyboardId: number,
  body: EdgeCreate,
): Promise<FrameEdge> {
  return request(`/api/storyboards/${storyboardId}/edges`, jsonInit('POST', body))
}

export interface EdgePatch {
  label?: string | null
  waypoints?: Waypoint[]
  from_anchor?: AnchorSide | null
  to_anchor?: AnchorSide | null
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
  author?: string
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

/** Returns the destroyed item. */
export function deleteInboxItem(id: number): Promise<InboxItem> {
  return request(`/api/inbox/${id}`, jsonDelete())
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
