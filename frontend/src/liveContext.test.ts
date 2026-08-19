import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearIfStanding,
  CONTEXT_FIELD_MAX,
  currentContext,
  publishContext,
  normalizeContext,
  sameContext,
  setPageContext,
  subscribeContext,
} from './liveContext'
import type { LiveContext } from './types/LiveContext'

function ctx(over: Partial<LiveContext> = {}): LiveContext {
  return { kind: 'board', id: null, label: null, detail: null, ...over }
}

describe('normalizeContext', () => {
  it('leaves no focus alone', () => {
    expect(normalizeContext(null)).toBeNull()
  })

  it('trims every field', () => {
    expect(normalizeContext(ctx({ id: ' 12 ', label: '\tSpec\n', detail: ' line 4 ' }))).toEqual(
      ctx({ id: '12', label: 'Spec', detail: 'line 4' }),
    )
  })

  it('folds blank and whitespace-only to null', () => {
    expect(normalizeContext(ctx({ id: '', label: '   ', detail: '\n\t' }))).toEqual(ctx())
  })

  it('keeps a value that is exactly the bound', () => {
    const at = 'a'.repeat(CONTEXT_FIELD_MAX)
    expect(normalizeContext(ctx({ id: at }))?.id).toBe(at)
  })

  it('keeps a value under the bound', () => {
    const under = 'a'.repeat(CONTEXT_FIELD_MAX - 1)
    expect(normalizeContext(ctx({ label: under }))?.label).toBe(under)
  })

  it('cuts a value over the bound, marking the cut', () => {
    const over = 'a'.repeat(CONTEXT_FIELD_MAX + 40)
    const cut = normalizeContext(ctx({ detail: over }))?.detail
    expect(cut).toHaveLength(CONTEXT_FIELD_MAX)
    expect(cut?.endsWith('…')).toBe(true)
  })

  it('trims before measuring, so padding never causes a cut', () => {
    const padded = ` ${'a'.repeat(CONTEXT_FIELD_MAX)} `
    expect(normalizeContext(ctx({ id: padded }))?.id).toHaveLength(CONTEXT_FIELD_MAX)
  })

  it('never touches the kind', () => {
    expect(normalizeContext(ctx({ kind: 'files' }))?.kind).toBe('files')
  })
})

describe('sameContext', () => {
  it('two absences are the same', () => {
    expect(sameContext(null, null)).toBe(true)
  })

  it('an absence and a focus are not', () => {
    expect(sameContext(null, ctx())).toBe(false)
    expect(sameContext(ctx(), null)).toBe(false)
  })

  it('equal fields on distinct objects are the same', () => {
    const a = ctx({ id: '7', label: 'Board', detail: 'x' })
    const b = ctx({ id: '7', label: 'Board', detail: 'x' })
    expect(sameContext(a, b)).toBe(true)
  })

  it('any one field differing is a difference', () => {
    const base = ctx({ id: '7', label: 'Board', detail: 'x' })
    expect(sameContext(base, { ...base, kind: 'files' })).toBe(false)
    expect(sameContext(base, { ...base, id: '8' })).toBe(false)
    expect(sameContext(base, { ...base, label: 'Files' })).toBe(false)
    expect(sameContext(base, { ...base, detail: null })).toBe(false)
  })
})

describe('the channel', () => {
  beforeEach(() => {
    setPageContext(null)
  })

  it('starts with nothing in focus', () => {
    expect(currentContext()).toBeNull()
  })

  it('publishes the normalized value, not what was handed in', () => {
    setPageContext(ctx({ id: '  9  ', label: '' }))
    expect(currentContext()).toEqual(ctx({ id: '9' }))
  })

  it('notifies a subscriber on a real change only', () => {
    const seen = vi.fn()
    const off = subscribeContext(seen)
    setPageContext(ctx({ id: '7' }))
    setPageContext(ctx({ id: '7' }))
    setPageContext(ctx({ id: ' 7 ' }))
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(ctx({ id: '7' }))
    setPageContext(ctx({ id: '8' }))
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })

  it('clearing to nothing is a change worth hearing', () => {
    const seen = vi.fn()
    const off = subscribeContext(seen)
    setPageContext(ctx({ id: '7' }))
    setPageContext(null)
    expect(seen).toHaveBeenCalledTimes(2)
    expect(seen).toHaveBeenLastCalledWith(null)
    setPageContext(null)
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })

  it('stops delivering once unsubscribed', () => {
    const seen = vi.fn()
    const off = subscribeContext(seen)
    off()
    setPageContext(ctx({ id: '7' }))
    expect(seen).not.toHaveBeenCalled()
    expect(currentContext()).toEqual(ctx({ id: '7' }))
  })
})

// What `useLiveContext` does, without a rendered tree (the suite renders no
// components — see CLAUDE.md): a page publishes on every change of its focus
// and, when it goes away, clears only what it still owns.
describe('publishing and standing down', () => {
  beforeEach(() => {
    setPageContext(null)
  })

  it('a change of focus never leaves null standing in between', () => {
    const seen = vi.fn()
    const off = subscribeContext(seen)
    const first = publishContext(ctx({ kind: 'files', id: 'a.ts', label: 'a.ts' }))
    publishContext(ctx({ kind: 'files', id: 'b.ts', label: 'b.ts' }))
    expect(seen.mock.calls.map(([c]) => c?.id)).toEqual(['a.ts', 'b.ts'])
    expect(first?.id).toBe('a.ts')
    off()
  })

  it('hands back the normalized value it published', () => {
    expect(publishContext(ctx({ id: '  7  ', label: '' }))).toEqual(ctx({ id: '7' }))
  })

  it('a page going away clears the focus it still owns', () => {
    const mine = publishContext(ctx({ kind: 'git', id: 'abc123' }))
    clearIfStanding(mine)
    expect(currentContext()).toBeNull()
  })

  it('a superseded publisher stands down instead of clearing', () => {
    // The route-change order: the arriving page publishes before the departing
    // page's cleanup runs.
    const departing = publishContext(ctx({ kind: 'files', id: 'a.ts' }))
    const arriving = publishContext(ctx({ kind: 'board', id: '7' }))
    const seen = vi.fn()
    const off = subscribeContext(seen)
    clearIfStanding(departing)
    expect(currentContext()).toEqual(arriving)
    expect(seen).not.toHaveBeenCalled()
    off()
  })
})
