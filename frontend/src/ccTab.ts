// Which tab of the CC Dashboard a route is on (mesa task 1159). The page is
// an overview (charts + KPIs) and three table sub-pages, each on its own
// `#/cc/…` segment so a tab is bookmarkable and Back-stable, exactly as the
// Settings page's are (`settingsTab.ts`). Pure: no DOM, no React — the strip's
// hrefs come from here and `lastView.ts` validates a remembered tab against
// the same list, so the two cannot disagree.

export type CcTab = 'overview' | 'skills-agents' | 'projects' | 'sessions'

/** The strip's order. `overview` is first and is also the bare `#/cc`
 *  route — there is no `#/cc/overview` segment (mesa task 699). */
export const CC_TABS: readonly CcTab[] = ['overview', 'skills-agents', 'projects', 'sessions']

const LABELS: Record<CcTab, string> = {
  overview: 'Overview',
  'skills-agents': 'Skills & Agents',
  projects: 'Projects',
  sessions: 'Sessions',
}

export function ccTabLabel(tab: CcTab): string {
  return LABELS[tab]
}

/** The route a tab lives on. `overview` emits the bare `#/cc`, so the first
 *  tab's link is the one every existing link to the dashboard already uses. */
export function ccTabHref(tab: CcTab): string {
  return tab === 'overview' ? '#/cc' : `#/cc/${tab}`
}
