import { describe, expect, it } from 'vitest'
import {
  clampPct,
  formatBytes,
  formatUptime,
  systemSeverity,
  usedPct,
} from './systemMeter'

describe('usedPct', () => {
  it('is the used share of the total', () => {
    expect(usedPct(512, 1024)).toBe(50)
    expect(usedPct(0, 1024)).toBe(0)
    expect(usedPct(1024, 1024)).toBe(100)
  })

  it('clamps a reading that leaves 0–100', () => {
    expect(usedPct(2048, 1024)).toBe(100)
    expect(usedPct(-5, 1024)).toBe(0)
  })

  it('is null when either side is unknown, never zero', () => {
    expect(usedPct(null, 1024)).toBe(null)
    expect(usedPct(512, null)).toBe(null)
    expect(usedPct(undefined, undefined)).toBe(null)
    expect(usedPct(NaN, 1024)).toBe(null)
  })

  it('is null for a zero total — no swap is not empty swap', () => {
    expect(usedPct(0, 0)).toBe(null)
    expect(usedPct(0, -1)).toBe(null)
  })
})

describe('clampPct', () => {
  it('passes a normal percentage through and clamps the rest', () => {
    expect(clampPct(63.1)).toBe(63.1)
    expect(clampPct(0)).toBe(0)
    expect(clampPct(100)).toBe(100)
    expect(clampPct(101)).toBe(100)
    expect(clampPct(-0.5)).toBe(0)
  })

  it('is null for an unknown or non-finite reading', () => {
    expect(clampPct(null)).toBe(null)
    expect(clampPct(undefined)).toBe(null)
    expect(clampPct(Infinity)).toBe(null)
    expect(clampPct(NaN)).toBe(null)
  })
})

describe('systemSeverity', () => {
  it('bands on the same boundaries as the plan-limit meter', () => {
    expect(systemSeverity(0)).toBe('ok')
    expect(systemSeverity(69.9)).toBe('ok')
    expect(systemSeverity(70)).toBe('warn')
    expect(systemSeverity(89.9)).toBe('warn')
    expect(systemSeverity(90)).toBe('crit')
    expect(systemSeverity(100)).toBe('crit')
  })
})

describe('formatBytes', () => {
  it('picks a binary unit and one decimal', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(34359738368)).toBe('32.0 GiB')
  })

  it('stops at the largest unit it knows', () => {
    expect(formatBytes(1024 ** 5)).toBe('1.0 PiB')
    expect(formatBytes(1024 ** 6)).toBe('1024.0 PiB')
  })

  it('is the placeholder for an unknown value, never "0 B"', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
  })
})

describe('formatUptime', () => {
  it('drops to the two largest useful units', () => {
    expect(formatUptime(45)).toBe('45s')
    expect(formatUptime(60)).toBe('1m')
    expect(formatUptime(3600)).toBe('1h 0m')
    expect(formatUptime(29299)).toBe('8h 8m')
    expect(formatUptime(86400 * 3 + 3600 * 4)).toBe('3d 4h')
  })

  it('is the placeholder for an unknown or impossible uptime', () => {
    expect(formatUptime(null)).toBe('—')
    expect(formatUptime(undefined)).toBe('—')
    expect(formatUptime(-1)).toBe('—')
    expect(formatUptime(NaN)).toBe('—')
  })
})
