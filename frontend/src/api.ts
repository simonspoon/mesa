// Typed fetch wrapper over the mesa REST API. All payload types are
// generated from the Rust domain types by ts-rs (src/types/) — do not
// hand-write payload shapes here (spec Requirement 12).

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
