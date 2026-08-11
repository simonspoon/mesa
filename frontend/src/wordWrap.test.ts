import { beforeEach, describe, expect, it } from 'vitest'
import { loadWordWrap, saveWordWrap } from './wordWrap'

describe('word wrap preference', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('reads off when nothing is stored', () => {
    expect(loadWordWrap()).toBe(false)
  })

  it('round-trips both ways', () => {
    saveWordWrap(true)
    expect(loadWordWrap()).toBe(true)
    saveWordWrap(false)
    expect(loadWordWrap()).toBe(false)
  })

  it('reads off on a garbage stored value', () => {
    for (const bad of ['', '1', 'on', 'yes', 'TRUE', '{"wrap":true}', 'null']) {
      localStorage.setItem('mesa-files-word-wrap', bad)
      expect(loadWordWrap()).toBe(false)
    }
  })
})
