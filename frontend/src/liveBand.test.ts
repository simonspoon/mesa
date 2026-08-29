import { describe, expect, it } from 'vitest'
import { drawAperture, simEnvelope, smoothLevel, type ApertureCtx } from './liveBand'
import type { LiveIndicator } from './liveIndicator'

const STATES: LiveIndicator[] = ['speaking', 'paused', 'hearing', 'working', 'listening']

/** A fake 2D context that records every call and property write instead of
 *  drawing anything — enough to assert what `drawAperture` *did* without a
 *  real `<canvas>` or a jsdom canvas shim. */
function fakeCtx(): { ctx: ApertureCtx; log: unknown[] } {
  const log: unknown[] = []
  const ctx = {} as ApertureCtx
  for (const method of [
    'save',
    'restore',
    'translate',
    'beginPath',
    'arc',
    'stroke',
    'fill',
  ] as const) {
    ctx[method] = (...args: unknown[]) => {
      log.push([method, ...args])
    }
  }
  for (const prop of ['globalAlpha', 'strokeStyle', 'fillStyle', 'lineWidth', 'shadowColor', 'shadowBlur'] as const) {
    Object.defineProperty(ctx, prop, {
      set(v) {
        log.push([`set:${prop}`, v])
      },
    })
  }
  return { ctx, log }
}

describe('smoothLevel', () => {
  it('attacks faster than it releases', () => {
    const attack = smoothLevel(0, 1) // jump up from silence
    const release = smoothLevel(1, 0) // drop to silence from full
    // Attack moves further toward its target in one step than release does.
    expect(attack).toBeGreaterThan(1 - release)
  })

  it('converges toward the target over repeated steps', () => {
    let level = 0
    for (let i = 0; i < 50; i++) level = smoothLevel(level, 0.8)
    expect(level).toBeCloseTo(0.8, 2)
  })

  it('is stable once it reaches its target', () => {
    expect(smoothLevel(0.5, 0.5)).toBe(0.5)
  })
})

describe('simEnvelope', () => {
  it('stays within 0..1', () => {
    for (let t = 0; t < 20; t += 0.37) {
      const v = simEnvelope(t)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('actually varies over time', () => {
    const values = new Set<number>()
    for (let t = 0; t < 20; t += 0.37) values.add(Number(simEnvelope(t).toFixed(4)))
    expect(values.size).toBeGreaterThan(1)
  })
})

describe('drawAperture', () => {
  it('draws something for every one of the five states', () => {
    for (const state of STATES) {
      const { ctx, log } = fakeCtx()
      drawAperture(ctx, 18, 18, state, 1.23, 0.5, '#fff', false)
      expect(log.length).toBeGreaterThan(0)
    }
  })

  it('paused issues no time-dependent geometry: two different t give identical logs', () => {
    const a = fakeCtx()
    const b = fakeCtx()
    drawAperture(a.ctx, 18, 18, 'paused', 1, 0.5, '#fff', false)
    drawAperture(b.ctx, 18, 18, 'paused', 99, 0.5, '#fff', false)
    expect(a.log).toEqual(b.log)
  })

  it('under reduced motion, every state produces identical logs at two different t', () => {
    for (const state of STATES) {
      const a = fakeCtx()
      const b = fakeCtx()
      drawAperture(a.ctx, 18, 18, state, 1, 0.5, '#fff', true)
      drawAperture(b.ctx, 18, 18, state, 99, 0.5, '#fff', true)
      expect(a.log).toEqual(b.log)
    }
  })

  it('hearing at level 0 vs level 1 produces different geometry', () => {
    const low = fakeCtx()
    const high = fakeCtx()
    drawAperture(low.ctx, 18, 18, 'hearing', 1, 0, '#fff', false)
    drawAperture(high.ctx, 18, 18, 'hearing', 1, 1, '#fff', false)
    expect(low.log).not.toEqual(high.log)
  })
})
