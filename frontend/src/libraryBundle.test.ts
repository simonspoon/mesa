import { describe, expect, it } from 'vitest'
import { bundleFilename, parseBundle, summarizeImport } from './libraryBundle'
import type { LibraryImportResult } from './types/LibraryImportResult'

describe('bundleFilename', () => {
  it('names the export by date alone', () => {
    expect(bundleFilename(new Date('2026-08-29T12:34:56Z'))).toBe('mesa-library-2026-08-29.json')
  })
})

const validItem = {
  name: 'my-agent',
  kind: 'agent',
  scope: 'user',
  project: null,
  body: 'do the thing',
  builtin_id: null,
}

function bundleText(overrides: Record<string, unknown> = {}, items: unknown[] = [validItem]): string {
  return JSON.stringify({
    version: 1,
    exported_at: '2026-08-29T00:00:00Z',
    items,
    ...overrides,
  })
}

describe('parseBundle', () => {
  it('parses a well-formed bundle', () => {
    const result = parseBundle(bundleText())
    expect('bundle' in result).toBe(true)
    if ('bundle' in result) {
      expect(result.bundle.version).toBe(1)
      expect(result.bundle.items).toEqual([validItem])
    }
  })

  it('defaults a missing exported_at to an empty string rather than failing', () => {
    const result = parseBundle(JSON.stringify({ version: 1, items: [validItem] }))
    expect('bundle' in result).toBe(true)
    if ('bundle' in result) expect(result.bundle.exported_at).toBe('')
  })

  it('defaults an item missing project/builtin_id to null', () => {
    const { name, kind, scope, body } = validItem
    const result = parseBundle(bundleText({}, [{ name, kind, scope, body }]))
    expect('bundle' in result).toBe(true)
    if ('bundle' in result) {
      expect(result.bundle.items[0].project).toBeNull()
      expect(result.bundle.items[0].builtin_id).toBeNull()
    }
  })

  it('rejects text that is not valid JSON', () => {
    const result = parseBundle('{not json')
    expect(result).toEqual({ error: expect.stringContaining('not valid JSON') })
  })

  it('rejects a JSON array at the top level', () => {
    const result = parseBundle('[]')
    expect('error' in result).toBe(true)
  })

  it('rejects a JSON primitive at the top level', () => {
    const result = parseBundle('"hello"')
    expect('error' in result).toBe(true)
  })

  it('rejects a missing version field', () => {
    const result = parseBundle(JSON.stringify({ items: [validItem] }))
    expect(result).toEqual({ error: expect.stringContaining('version') })
  })

  it('rejects a non-numeric version field', () => {
    const result = parseBundle(bundleText({ version: '1' }))
    expect(result).toEqual({ error: expect.stringContaining('version') })
  })

  it('rejects an unknown version', () => {
    const result = parseBundle(bundleText({ version: 2 }))
    expect(result).toEqual({ error: expect.stringContaining('Unknown bundle version 2') })
  })

  it('rejects a missing items field', () => {
    const result = parseBundle(JSON.stringify({ version: 1 }))
    expect(result).toEqual({ error: expect.stringContaining('items') })
  })

  it('rejects a non-array items field', () => {
    const result = parseBundle(bundleText({ items: { not: 'an array' } }))
    expect(result).toEqual({ error: expect.stringContaining('items') })
  })

  it('rejects an item that is not an object', () => {
    const result = parseBundle(bundleText({}, ['not an object']))
    expect(result).toEqual({ error: expect.stringContaining('Item 0 is not an object') })
  })

  it('rejects an item missing a name', () => {
    const rest: Record<string, unknown> = { ...validItem }
    delete rest.name
    const result = parseBundle(bundleText({}, [rest]))
    expect(result).toEqual({ error: expect.stringContaining('missing a "name"') })
  })

  it('rejects an item with a non-string name', () => {
    const result = parseBundle(bundleText({}, [{ ...validItem, name: 42 }]))
    expect(result).toEqual({ error: expect.stringContaining('missing a "name"') })
  })

  it('rejects an item missing a kind', () => {
    const rest: Record<string, unknown> = { ...validItem }
    delete rest.kind
    const result = parseBundle(bundleText({}, [rest]))
    expect(result).toEqual({ error: expect.stringContaining('"kind"') })
  })

  it('rejects an item with an unrecognized kind', () => {
    const result = parseBundle(bundleText({}, [{ ...validItem, kind: 'not-a-kind' }]))
    expect(result).toEqual({ error: expect.stringContaining('"kind"') })
  })

  it('rejects an item missing a scope', () => {
    const rest: Record<string, unknown> = { ...validItem }
    delete rest.scope
    const result = parseBundle(bundleText({}, [rest]))
    expect(result).toEqual({ error: expect.stringContaining('"scope"') })
  })

  it('rejects an item with an unrecognized scope', () => {
    const result = parseBundle(bundleText({}, [{ ...validItem, scope: 'global' }]))
    expect(result).toEqual({ error: expect.stringContaining('"scope"') })
  })

  it('rejects an item missing a body', () => {
    const rest: Record<string, unknown> = { ...validItem }
    delete rest.body
    const result = parseBundle(bundleText({}, [rest]))
    expect(result).toEqual({ error: expect.stringContaining('missing a "body"') })
  })

  it('rejects an item with a non-string body', () => {
    const result = parseBundle(bundleText({}, [{ ...validItem, body: 123 }]))
    expect(result).toEqual({ error: expect.stringContaining('missing a "body"') })
  })

  it('names the offending index and item when several items are present', () => {
    const badItem: Record<string, unknown> = { ...validItem }
    delete badItem.name
    const result = parseBundle(bundleText({}, [validItem, badItem]))
    expect(result).toEqual({ error: expect.stringContaining('Item 1') })
  })
})

function result(status: LibraryImportResult['status'], name = 'x'): LibraryImportResult {
  return { name, kind: 'agent', scope: 'user', status, item_id: null, error: null }
}

describe('summarizeImport', () => {
  it('reports nothing to import for an empty batch', () => {
    expect(summarizeImport([])).toBe('Nothing to import.')
  })

  it('pluralizes a single item correctly', () => {
    expect(summarizeImport([result('created')])).toBe('1 item created.')
  })

  it('pluralizes multiple items correctly', () => {
    expect(summarizeImport([result('skipped'), result('skipped')])).toBe('2 items skipped.')
  })

  it('lists every non-zero status in created/replaced/skipped/failed order', () => {
    const results = [
      result('failed'),
      result('skipped'),
      result('created'),
      result('replaced'),
      result('skipped'),
    ]
    expect(summarizeImport(results)).toBe('1 item created, 1 item replaced, 2 items skipped, 1 item failed.')
  })

  it('omits any status with a zero count', () => {
    expect(summarizeImport([result('created'), result('created')])).toBe('2 items created.')
  })
})
