// Typed fetch wrapper over the mesa REST API. All payload types are
// generated from the Rust domain types by ts-rs (src/types/) — do not
// hand-write payload shapes here (spec Requirement 12).

import type { Frame } from './types/Frame'
import type { FrameEdge } from './types/FrameEdge'
import type { Post } from './types/Post'
import type { PostSummary } from './types/PostSummary'
import type { PostThread } from './types/PostThread'
import type { Priority } from './types/Priority'
import type { Project } from './types/Project'
import type { Status } from './types/Status'
import type { Storyboard } from './types/Storyboard'
import type { StoryboardEvent } from './types/StoryboardEvent'
import type { StoryboardView } from './types/StoryboardView'
import type { Task } from './types/Task'
import type { TaskSummary } from './types/TaskSummary'

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
}

export interface TaskCreate {
  project_id: number
  title: string
  description?: string
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
}

export function createProject(
  name: string,
  description?: string,
): Promise<Project> {
  return request('/api/projects', jsonInit('POST', { name, description }))
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

/** Returns the destroyed records: the task plus all cascaded subtasks. */
export function deleteTask(id: number): Promise<Task[]> {
  return request(`/api/tasks/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
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

// ---- posts (bulletin board) ----

export interface PostFilters {
  project?: number
  tag?: string
  author?: string
}

/** Top-level posts only (newest first), as compact summaries with reply_count. */
export function listPosts(filters: PostFilters = {}): Promise<PostSummary[]> {
  const params = new URLSearchParams()
  if (filters.project !== undefined) params.set('project', String(filters.project))
  if (filters.tag !== undefined && filters.tag !== '') params.set('tag', filters.tag)
  if (filters.author !== undefined && filters.author !== '')
    params.set('author', filters.author)
  const qs = params.toString()
  return request(`/api/posts${qs ? `?${qs}` : ''}`)
}

/** A post with its direct replies: {post, replies}. */
export function getPost(id: number): Promise<PostThread> {
  return request(`/api/posts/${id}`)
}

export interface PostCreate {
  project_id: number
  body: string
  title?: string
  tag?: string
  author?: string
}

export function createPost(body: PostCreate): Promise<Post> {
  return request('/api/posts', jsonInit('POST', body))
}

export interface ReplyCreate {
  body: string
  title?: string
  tag?: string
  author?: string
}

/** Posts a reply that inherits the parent's project. */
export function replyToPost(parentId: number, body: ReplyCreate): Promise<Post> {
  return request(`/api/posts/${parentId}/replies`, jsonInit('POST', body))
}

export interface PostPatch {
  body?: string
  title?: string | null
  tag?: string | null
}

export function updatePost(id: number, patch: PostPatch): Promise<Post> {
  return request(`/api/posts/${id}`, jsonInit('PATCH', patch))
}

/** Returns the destroyed thread: the post plus all cascaded replies. */
export function deletePost(id: number): Promise<PostThread> {
  return request(`/api/posts/${id}`, jsonDelete())
}
