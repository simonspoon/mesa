// Typed fetch wrapper over the mesa REST API. All payload types are
// generated from the Rust domain types by ts-rs (src/types/) — do not
// hand-write payload shapes here (spec Requirement 12).

import type { Priority } from './types/Priority'
import type { Project } from './types/Project'
import type { Status } from './types/Status'
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

/** Sorted file paths (relative to the project's docs_path), recursive. */
export function listDocs(projectId: number): Promise<string[]> {
  return request(`/api/projects/${projectId}/docs`)
}

/** URL of a doc's raw content (used directly as an <img> src). */
export function docUrl(projectId: number, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `/api/projects/${projectId}/docs/${encoded}`
}

/** Fetches a doc's raw bytes (the docs content route is not JSON). */
export async function getDoc(
  projectId: number,
  path: string,
): Promise<ArrayBuffer> {
  const res = await fetch(docUrl(projectId, path))
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
  return res.arrayBuffer()
}

// Mutation request shapes. These are inputs to PATCH/POST, not API payload
// mirrors, so they are hand-written (responses use the generated types).
// PATCH semantics: an absent field is left unchanged (JSON.stringify drops
// `undefined`), an explicit `null` clears it.

export interface ProjectPatch {
  name?: string
  description?: string | null
  docs_path?: string | null
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
