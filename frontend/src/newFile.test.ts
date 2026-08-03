import { describe, expect, it } from 'vitest'
import { newFilePath } from './newFile'

describe('newFilePath', () => {
  it('returns the bare name at the project root', () => {
    expect(newFilePath('', 'notes.md')).toEqual({ ok: true, path: 'notes.md' })
  })

  it('joins a parent directory with exactly one slash', () => {
    expect(newFilePath('src/core', 'new.rs')).toEqual({
      ok: true,
      path: 'src/core/new.rs',
    })
  })

  it('trims the typed name, so what is sent is what is created', () => {
    expect(newFilePath('src', '  new.rs  ')).toEqual({
      ok: true,
      path: 'src/new.rs',
    })
  })

  it('allows a dotfile', () => {
    expect(newFilePath('', '.env')).toEqual({ ok: true, path: '.env' })
    expect(newFilePath('cfg', '.gitignore')).toEqual({
      ok: true,
      path: 'cfg/.gitignore',
    })
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(newFilePath('', '')).toEqual({
      ok: false,
      reason: 'Enter a file name.',
    })
    expect(newFilePath('src', '   ')).toEqual({
      ok: false,
      reason: 'Enter a file name.',
    })
  })

  it('rejects . and ..', () => {
    expect(newFilePath('src', '.')).toEqual({
      ok: false,
      reason: 'A file cannot be named . or ..',
    })
    expect(newFilePath('', '..')).toEqual({
      ok: false,
      reason: 'A file cannot be named . or ..',
    })
    // Trimmed first, so padding doesn't smuggle one through.
    expect(newFilePath('', ' .. ').ok).toBe(false)
  })

  it('rejects a name carrying a separator or a NUL', () => {
    const reason = 'Enter a single file name, not a path.'
    expect(newFilePath('', 'a/b')).toEqual({ ok: false, reason })
    expect(newFilePath('src', '../escape.txt')).toEqual({ ok: false, reason })
    expect(newFilePath('', '/etc/passwd')).toEqual({ ok: false, reason })
    expect(newFilePath('', 'a\\b')).toEqual({ ok: false, reason })
    expect(newFilePath('', 'a\0b')).toEqual({ ok: false, reason })
  })
})
