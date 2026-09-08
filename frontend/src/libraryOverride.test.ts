import { describe, expect, it } from 'vitest'
import {
  DIFF_MAX_LINES,
  diffLines,
  foldOverrides,
  itemKey,
} from './libraryOverride'
import type { LibraryItem } from './types/LibraryItem'

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 1,
    name: 'supervisor',
    kind: 'agent',
    scope: 'user',
    project_id: null,
    body: 'mine',
    builtin_id: null,
    builtin: false,
    path: '.claude/agents/supervisor.md',
    synced_body: null,
    synced_at: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

function builtin(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return item({
    id: null,
    builtin: true,
    builtin_id: 'supervisor',
    body: 'shipped',
    ...overrides,
  })
}

describe('foldOverrides', () => {
  it('folds a name collision into the user row and captures the built-in body', () => {
    const user = item()
    const { items, overriddenBody } = foldOverrides([user, builtin()])
    expect(items).toEqual([user])
    expect(overriddenBody.get(itemKey(user))).toBe('shipped')
  })

  it('leaves a fork alone and badges nothing', () => {
    // A fork carries `builtin_id`, so the server already dropped the built-in
    // from the list — there is nothing in the browser to diff it against.
    const fork = item({ builtin_id: 'supervisor' })
    const { items, overriddenBody } = foldOverrides([fork])
    expect(items).toEqual([fork])
    expect(overriddenBody.size).toBe(0)
  })

  it('leaves an unshadowed built-in untouched', () => {
    const only = builtin()
    const { items, overriddenBody } = foldOverrides([only])
    expect(items).toEqual([only])
    expect(overriddenBody.size).toBe(0)
  })

  it('does not fold across a different kind or scope', () => {
    const user = item({ kind: 'skill' })
    const scoped = item({ id: 2, scope: 'project', project_id: 7 })
    const all = [user, scoped, builtin()]
    const { items, overriddenBody } = foldOverrides(all)
    expect(items).toEqual(all)
    expect(overriddenBody.size).toBe(0)
  })

  it('matches the name case-sensitively', () => {
    const user = item({ name: 'Supervisor' })
    const { items, overriddenBody } = foldOverrides([user, builtin()])
    expect(items).toHaveLength(2)
    expect(overriddenBody.size).toBe(0)
  })
})

describe('diffLines', () => {
  it('reports identical bodies as all context, numbered on both sides', () => {
    const out = diffLines('a\nb\n', 'a\nb\n')
    expect(out).toEqual([
      { kind: 'context', mesa_line: 1, disk_line: 1, text: 'a' },
      { kind: 'context', mesa_line: 2, disk_line: 2, text: 'b' },
    ])
  })

  it('reports a line only the built-in has as disk-only', () => {
    const out = diffLines('a\nc', 'a\nb\nc')
    expect(out.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['disk-only', 'b'],
      ['context', 'c'],
    ])
    expect(out[1].mesa_line).toBeNull()
    expect(out[1].disk_line).toBe(2)
  })

  it('reports a line only the user copy has as mesa-only', () => {
    const out = diffLines('a\nb\nc', 'a\nc')
    expect(out.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['mesa-only', 'b'],
      ['context', 'c'],
    ])
    expect(out[1].mesa_line).toBe(2)
    expect(out[1].disk_line).toBeNull()
  })

  it('cuts a long result to a marker line carrying neither number', () => {
    const long = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    const out = diffLines(long, '')
    expect(out).toHaveLength(DIFF_MAX_LINES + 1)
    const last = out[out.length - 1]
    expect(last.kind).toBe('context')
    expect(last.mesa_line).toBeNull()
    expect(last.disk_line).toBeNull()
    expect(last.text).toContain('1 more diff lines not shown')
  })

  it('refuses a table past the cell bound with the same marker shape', () => {
    const wide = Array.from({ length: 4001 }, (_, i) => `${i}`).join('\n')
    const out = diffLines(wide, wide.replace('0', 'x'))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('context')
    expect(out[0].mesa_line).toBeNull()
    expect(out[0].disk_line).toBeNull()
    expect(out[0].text).toContain('diff not computed')
  })
})
