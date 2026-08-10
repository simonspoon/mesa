import type { AgentSession } from './types/AgentSession'
import { isRunningAgent } from './agentProject'
import type { TaskSummary } from './types/TaskSummary'

/** How many *live* Claude Code sessions look like they are working on this
 * task — what drives the kanban card's live marker (mesa task 663).
 *
 * The link is by session name: both watchers spawn with
 * `format!("{}: {}", project.name, task.name)` (`src/api.rs`), and the
 * frontend holds both halves, so it reconstructs that exact string and
 * compares. Liveness is the existing `isRunningAgent` — the one predicate,
 * shared with the Agents sidebar.
 *
 * **This is deliberately best-effort, and a decoration only.** There is no
 * stored task↔session link (no column, no migration, no route), so the match
 * lapses silently in several ordinary cases and must always degrade to "no
 * animation":
 * - sessions started from the Agents sidebar's "add agent" button carry no
 *   `--name` at all (`DEFAULT_AGENT_SPAWN` has no `{name}`) and never match;
 * - a user-replaced `todo-watcher` command template that
 *   drops `{name}` loses the animation and nothing else;
 * - if a task's `description` (and so its derived `name`) changed after
 *   dispatch, the match lapses;
 * - two tasks in one project whose first 50 chars are identical share a
 *   derived `name`, so both animate.
 *
 * `projectName`/`sessions` are nullable so the not-yet-loaded and
 * failed-fetch cases (`/api/agents` is gated and 502s with no `claude`
 * binary) are the same "0" as no match. */
export function liveAgentCount(
  task: Pick<TaskSummary, 'name'>,
  projectName: string | null,
  sessions: AgentSession[] | null,
): number {
  if (projectName === null || sessions === null) return 0
  const wanted = `${projectName}: ${task.name}`
  return sessions.filter((s) => s.name === wanted && isRunningAgent(s)).length
}

/** How many `done` cards the Board renders before the first "load more"
 *  (mesa task 664), and how many each click adds. */
export const DONE_INITIAL = 20
export const DONE_PAGE = 50

/** Render cap for the Board's `done` column — a *view* limit only: the
 *  fetch (`GET /api/tasks?project=<id>`) still returns every task and the
 *  column header still reports the full total, so a truncated column never
 *  reads as missing data.
 *
 *  Only `done` is capped; the four working columns are returned untouched.
 *  Callers apply this **after** the recency sort and **before** nesting, so
 *  "the last 20" is a literal count of the 20 most recently completed rows —
 *  a subtask whose parent falls outside the cut simply renders at top level,
 *  which `nestColumn` already handles.
 *
 *  `hidden` is what the button's label reports; 0 means no button. */
export function capColumn<T>(
  status: string,
  tasks: T[],
  shown: number,
): { visible: T[]; hidden: number } {
  if (status !== 'done' || tasks.length <= shown) {
    return { visible: tasks, hidden: 0 }
  }
  return { visible: tasks.slice(0, shown), hidden: tasks.length - shown }
}

// Per-board canvas view state (pan + zoom), persisted browser-local so each
// storyboard reopens at the pan/zoom the user left it. This lives only on the
// user's machine (localStorage), keyed by board id — never on the board/server
// and never shared across devices, matching the author-id pattern in author.ts.

const KEY = (storyboardId: number) => `mesa-board-view-${storyboardId}`

/** The pan/zoom transform applied to the canvas content layer. Mirrors the
 *  `ViewTransform` shape in StoryboardCanvas; kept structural so a saved view
 *  round-trips unchanged. */
export type BoardView = {
  tx: number
  ty: number
  scale: number
}

/** Load the saved view for a board, or null if none is stored / it is
 *  unreadable. Validates the shape so a corrupt entry falls back to the
 *  default rather than throwing. */
export function loadBoardView(storyboardId: number): BoardView | null {
  const raw = localStorage.getItem(KEY(storyboardId))
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as BoardView).tx === 'number' &&
      typeof (v as BoardView).ty === 'number' &&
      typeof (v as BoardView).scale === 'number'
    ) {
      return v as BoardView
    }
  } catch {
    // Corrupt entry — fall through to the default.
  }
  return null
}

export function saveBoardView(storyboardId: number, view: BoardView): void {
  localStorage.setItem(KEY(storyboardId), JSON.stringify(view))
}
