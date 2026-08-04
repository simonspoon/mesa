import { describe, expect, it } from 'vitest'
import {
  clampAgentSidebarWidth,
  DEFAULT_AGENT_SIDEBAR_WIDTH,
  MIN_AGENT_SIDEBAR_WIDTH,
  MIN_MAIN_WIDTH,
} from './agentSidebarWidth'

describe('clampAgentSidebarWidth', () => {
  it('passes an in-range width through untouched', () => {
    expect(clampAgentSidebarWidth(600, 1200)).toBe(600)
  })

  it('floors at MIN_AGENT_SIDEBAR_WIDTH rather than collapsing', () => {
    expect(clampAgentSidebarWidth(40, 1200)).toBe(MIN_AGENT_SIDEBAR_WIDTH)
    expect(clampAgentSidebarWidth(-500, 1200)).toBe(MIN_AGENT_SIDEBAR_WIDTH)
  })

  it('ceilings at the live max so main keeps its floor', () => {
    expect(clampAgentSidebarWidth(5000, 640)).toBe(640)
    // The default on a small window is exactly the case the mount clamp exists
    // for: an 800px viewport with a 220px nav leaves 260px of headroom…
    expect(clampAgentSidebarWidth(DEFAULT_AGENT_SIDEBAR_WIDTH, 800 - 220 - MIN_MAIN_WIDTH)).toBe(
      MIN_AGENT_SIDEBAR_WIDTH,
    )
  })

  it('lets the floor win when the window leaves no room to grow', () => {
    expect(clampAgentSidebarWidth(600, 80)).toBe(MIN_AGENT_SIDEBAR_WIDTH)
    expect(clampAgentSidebarWidth(600, -100)).toBe(MIN_AGENT_SIDEBAR_WIDTH)
  })

  it('falls back to the default on a non-finite width', () => {
    expect(clampAgentSidebarWidth(NaN, 1200)).toBe(DEFAULT_AGENT_SIDEBAR_WIDTH)
    expect(clampAgentSidebarWidth(Infinity, 1200)).toBe(DEFAULT_AGENT_SIDEBAR_WIDTH)
  })

  it('defaults above the floor, or the default itself would be clamped away', () => {
    expect(DEFAULT_AGENT_SIDEBAR_WIDTH).toBeGreaterThan(MIN_AGENT_SIDEBAR_WIDTH)
  })
})
