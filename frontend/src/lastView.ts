// The view the user was last on, so the left nav's project links and its "CC
// Dashboard" link reopen that tab instead of always dumping you back on the
// Board / the CC overview (mesa tasks 694, 695). Machine-local (localStorage),
// like lastFolder.ts and the diagram view state — never project or server
// data.
//
// Two deliberate shapes:
// - **A tab per project** (695), stored as one id → tab map; a project with no
//   memory opens on the Board. The CC Dashboard stays one global sub-tab —
//   there is only one CC Dashboard.
// - **Links only, never a redirect.** Nothing here writes
//   `window.location.hash`; arriving at `#/projects/7` directly (bookmark,
//   Back, task-panel link, phone tab bar) still renders the Board.

import type { CcTab } from './pages/CCDashboardView'

export type { CcTab }
export type ProjectTab =
  | 'board'
  // The user's own pane layout (mesa task 843). Remembered like any other
  // tab, so leaving a project and coming back reopens the layout — but only
  // ever as a *link*: a project whose layout has since been emptied renders
  // the Board at that route rather than an empty frame.
  | 'custom'
  | 'dashboard'
  | 'diagrams'
  | 'git'
  | 'files'
  | 'terminal'
  | 'settings'

// The tabs that appear as a path segment. `board` is the bare
// `#/projects/{id}` route — there is no `/board` segment to emit or match.
const TAB_SEGMENTS = [
  'custom',
  'dashboard',
  'diagrams',
  'git',
  'files',
  'terminal',
  'settings',
] as const
const CC_TABS = ['overview', 'skills-agents', 'projects', 'sessions'] as const

const PROJECT_KEY = 'mesa-last-project-tabs'
// 694's single-string key. Not migrated (worst case: one landing on the Board
// per project); dropped on the first write so it does not linger.
const OLD_PROJECT_KEY = 'mesa-last-project-tab'
const CC_KEY = 'mesa-last-cc-tab'

/** The project a path is on and the tab it is on, or null if it is not a
 *  project route.
 *
 *  The tab only — never the deep id: `/projects/7/tasks/12`,
 *  `/projects/7/create-task` and `/projects/7` are all `board`, and
 *  `/projects/7/diagrams/3` is `diagrams`, so the remembered link lands
 *  on the *new* project's diagrams list rather than another project's row. */
export function projectViewFromPath(
  path: string,
): { id: number; tab: ProjectTab } | null {
  const m = /^\/projects\/(\d+)(?:\/([^/]+))?(?:\/.*)?$/.exec(path)
  if (m === null) return null
  const seg = m[2]
  const tab = (TAB_SEGMENTS as readonly string[]).includes(seg)
    ? (seg as ProjectTab)
    : 'board'
  return { id: Number(m[1]), tab }
}

/** The tab half of {@link projectViewFromPath}. */
export function projectTabFromPath(path: string): ProjectTab | null {
  return projectViewFromPath(path)?.tab ?? null
}

/** The CC Dashboard sub-tab a path is on, or null if it is not a `/cc` route.
 *  The session drill-downs (`/cc/sessions/<id>`, `.../timeline`, `.../graph`)
 *  are all `sessions`. `/` renders the overview but is deliberately *not* a
 *  match — root records nothing. */
export function ccTabFromPath(path: string): CcTab | null {
  const m = /^\/cc(?:\/([^/]+))?(?:\/.*)?$/.exec(path)
  if (m === null) return null
  const seg = m[1]
  return (CC_TABS as readonly string[]).includes(seg) ? (seg as CcTab) : 'overview'
}

function read<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  const raw = localStorage.getItem(key)
  return raw !== null && (valid as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback
}

const PROJECT_TABS = ['board', ...TAB_SEGMENTS] as const

/** The id → tab map, total: absent, unparseable, non-object and entries with a
 *  non-string or unknown tab are all simply absent from the result. */
function readProjectTabs(): Record<string, ProjectTab> {
  const out: Record<string, ProjectTab> = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(localStorage.getItem(PROJECT_KEY) ?? '')
  } catch {
    return out
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [id, tab] of Object.entries(parsed as Record<string, unknown>)) {
    if ((PROJECT_TABS as readonly unknown[]).includes(tab)) out[id] = tab as ProjectTab
  }
  return out
}

export function getLastProjectTab(projectId: number): ProjectTab {
  return readProjectTabs()[String(projectId)] ?? 'board'
}

export function getLastCcTab(): CcTab {
  return read(CC_KEY, CC_TABS, 'overview')
}

/** Record the view `path` is on. A path that is neither a project nor a `/cc`
 *  route (`/inbox`, `/settings`, `/terminal`, `/`) leaves both memories
 *  untouched — which is what makes "go to the Inbox and come back" restore the
 *  view you left. */
export function rememberView(path: string): void {
  const view = projectViewFromPath(path)
  if (view !== null) {
    const tabs = readProjectTabs()
    tabs[String(view.id)] = view.tab
    localStorage.setItem(PROJECT_KEY, JSON.stringify(tabs))
    localStorage.removeItem(OLD_PROJECT_KEY)
  }
  const cc = ccTabFromPath(path)
  if (cc !== null) localStorage.setItem(CC_KEY, cc)
}

export function projectHref(projectId: number): string {
  const tab = getLastProjectTab(projectId)
  return tab === 'board' ? `#/projects/${projectId}` : `#/projects/${projectId}/${tab}`
}

export function ccHref(): string {
  const tab = getLastCcTab()
  return tab === 'overview' ? '#/cc' : `#/cc/${tab}`
}
