import { describe, expect, it } from 'vitest'
import {
  SETTINGS_TABS,
  settingsTabFromPath,
  settingsTabHref,
  settingsTabLabel,
} from './settingsTab'

describe('settingsTabFromPath', () => {
  it('lands the bare route on the first tab', () => {
    expect(settingsTabFromPath('/settings')).toBe('hooks')
  })

  it('maps each known segment to its tab', () => {
    expect(settingsTabFromPath('/settings/hooks')).toBe('hooks')
    expect(settingsTabFromPath('/settings/keyboard')).toBe('keyboard')
    expect(settingsTabFromPath('/settings/voice')).toBe('voice')
    expect(settingsTabFromPath('/settings/memory')).toBe('memory')
    expect(settingsTabFromPath('/settings/pricing')).toBe('pricing')
    expect(settingsTabFromPath('/settings/system')).toBe('system')
  })

  it('falls back to the first tab for an unknown shape', () => {
    expect(settingsTabFromPath('/settings/wat')).toBe('hooks')
    expect(settingsTabFromPath('/settings/')).toBe('hooks')
    expect(settingsTabFromPath('/settings/voice/extra')).toBe('hooks')
    // A trailing slash is not tolerated: App.tsx's route regex never sends
    // that path to the page at all, so the parser must not promise otherwise.
    expect(settingsTabFromPath('/settings/voice/')).toBe('hooks')
  })

  it('matches the segment case-insensitively', () => {
    expect(settingsTabFromPath('/settings/Pricing')).toBe('pricing')
    expect(settingsTabFromPath('/settings/SYSTEM')).toBe('system')
  })
})

describe('strip', () => {
  it('lists the six tabs in order, hooks first', () => {
    expect(SETTINGS_TABS).toEqual([
      'hooks',
      'keyboard',
      'voice',
      'memory',
      'pricing',
      'system',
    ])
  })

  it('emits the bare route for hooks, the segment otherwise', () => {
    expect(settingsTabHref('hooks')).toBe('#/settings')
    expect(settingsTabHref('keyboard')).toBe('#/settings/keyboard')
    expect(settingsTabHref('system')).toBe('#/settings/system')
  })

  it('round-trips every href back to its tab', () => {
    for (const tab of SETTINGS_TABS) {
      expect(settingsTabFromPath(settingsTabHref(tab).slice(1))).toBe(tab)
    }
  })

  it('labels every tab', () => {
    for (const tab of SETTINGS_TABS) expect(settingsTabLabel(tab)).not.toBe('')
    expect(settingsTabLabel('keyboard')).toBe('Keyboard')
  })
})
