import { describe, expect, it } from 'vitest'
import { usagePct, usageSeverity } from './usageMeter'

describe('usagePct', () => {
  it('passes a normal utilization through', () => {
    expect(usagePct({ utilization: 42.4, resets_at: null })).toBe(42.4)
  })

  it('clamps a live number that leaves 0–100', () => {
    expect(usagePct({ utilization: 130, resets_at: null })).toBe(100)
    expect(usagePct({ utilization: -5, resets_at: null })).toBe(0)
  })

  it('is null for a missing or unusable window', () => {
    expect(usagePct(null)).toBe(null)
    expect(usagePct(undefined)).toBe(null)
    expect(usagePct({ utilization: NaN, resets_at: null })).toBe(null)
  })
})

describe('usageSeverity', () => {
  it('bands on the boundaries', () => {
    expect(usageSeverity(0)).toBe('ok')
    expect(usageSeverity(69.9)).toBe('ok')
    expect(usageSeverity(70)).toBe('warn')
    expect(usageSeverity(89.9)).toBe('warn')
    expect(usageSeverity(90)).toBe('crit')
    expect(usageSeverity(100)).toBe('crit')
  })
})
