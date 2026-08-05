// The view the user was last on, so the left nav's project links and its "CC
// Dashboard" link reopen that tab instead of always dumping you back on the
// Board / the CC overview (mesa task 694). Machine-local (localStorage), like
// lastFolder.ts and the storyboard view state — never project or server data.
//
// Two deliberate limits:
// - **One project tab, globally.** The intent is "carry the view I'm on across
//   the switch", not "each project remembers its own tab".
// - **Links only, never a redirect.** Nothing here writes
//   `window.location.hash`; arriving at `#/projects/7` directly (bookmark,
//   Back, task-panel link, phone tab bar) still renders the Board.

import type { CcTab } from './pages/CCDashboardView'

export type { CcTab }
export type ProjectTab =
  | 'board'
  | 'dashboard'
  | 'storyboards'
  | 'git'
  | 'files'
  | 'terminal'
  | 'settings'

// The tabs that appear as a path segment. `board` is the bare
// `#/projects/{id}` route — there is no `/board` segment to emit or match.
const TAB_SEGMENTS = [
  'dashboard',
  'storyboards',
  'git',
  'files',
  'terminal',
  'settings',
] as const
const CC_TABS = ['overview', 'skills-agents', 'projects', 'sessions'] as const

const PROJECT_KEY = 'mesa-last-project-tab'
const CC_KEY = 'mesa-last-cc-tab'

/** The project tab a path is on, or null if it is not a project route.
 *
 *  The tab only — never the deep id: `/projects/7/tasks/12`,
 *  `/projects/7/create-task` and `/projects/7` are all `board`, and
 *  `/projects/7/storyboards/3` is `storyboards`, so the remembered link lands
 *  on the *new* project's storyboards list rather than another project's row. */
export function projectTabFromPath(path: string): ProjectTab | null {
  const m = /^\/projects\/\d+(?:\/([^/]+))?(?:\/.*)?$/.exec(path)
  if (m === null) return null
  const seg = m[1]
  return (TAB_SEGMENTS as readonly string[]).includes(seg)
    ? (seg as ProjectTab)
    : 'board'
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

export function getLastProjectTab(): ProjectTab {
  return read(PROJECT_KEY, ['board', ...TAB_SEGMENTS] as const, 'board')
}

export function getLastCcTab(): CcTab {
  return read(CC_KEY, CC_TABS, 'overview')
}

/** Record the view `path` is on. A path that is neither a project nor a `/cc`
 *  route (`/inbox`, `/settings`, `/terminal`, `/`) leaves both memories
 *  untouched — which is what makes "go to the Inbox and come back" restore the
 *  view you left. */
export function rememberView(path: string): void {
  const tab = projectTabFromPath(path)
  if (tab !== null) localStorage.setItem(PROJECT_KEY, tab)
  const cc = ccTabFromPath(path)
  if (cc !== null) localStorage.setItem(CC_KEY, cc)
}

export function projectHref(projectId: number): string {
  const tab = getLastProjectTab()
  return tab === 'board' ? `#/projects/${projectId}` : `#/projects/${projectId}/${tab}`
}

export function ccHref(): string {
  const tab = getLastCcTab()
  return tab === 'overview' ? '#/cc' : `#/cc/${tab}`
}
