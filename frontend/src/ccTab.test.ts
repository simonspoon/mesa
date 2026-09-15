import { describe, expect, it } from 'vitest'
import { CC_TABS, ccTabHref, ccTabLabel } from './ccTab'

describe('strip', () => {
  it('lists the four tabs in order, overview first', () => {
    expect(CC_TABS).toEqual(['overview', 'skills-agents', 'projects', 'sessions'])
  })

  it('labels each tab', () => {
    expect(CC_TABS.map(ccTabLabel)).toEqual([
      'Overview',
      'Skills & Agents',
      'Projects',
      'Sessions',
    ])
  })

  it('links the first tab to the bare route and the rest to their segment', () => {
    expect(ccTabHref('overview')).toBe('#/cc')
    expect(ccTabHref('skills-agents')).toBe('#/cc/skills-agents')
    expect(ccTabHref('projects')).toBe('#/cc/projects')
    expect(ccTabHref('sessions')).toBe('#/cc/sessions')
  })
})
