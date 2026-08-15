import { describe, expect, it } from 'vitest'
import { formatContextTokens, responsePreview } from './agentRow'

describe('formatContextTokens', () => {
  it('shows a sub-1k count exactly', () => {
    expect(formatContextTokens(1)).toBe('1')
    expect(formatContextTokens(999)).toBe('999')
  })

  it('compacts thousands to one decimal', () => {
    expect(formatContextTokens(1000)).toBe('1k')
    expect(formatContextTokens(48_200)).toBe('48.2k')
    expect(formatContextTokens(999_400)).toBe('999.4k')
  })

  it('compacts millions the same way', () => {
    expect(formatContextTokens(1_000_000)).toBe('1M')
    expect(formatContextTokens(1_100_000)).toBe('1.1M')
  })

  it('renders nothing rather than a zero that reads as a measurement', () => {
    expect(formatContextTokens(0)).toBeNull()
    expect(formatContextTokens(-5)).toBeNull()
  })

  it('renders nothing when there is no usage line yet', () => {
    expect(formatContextTokens(null)).toBeNull()
    expect(formatContextTokens(undefined)).toBeNull()
    expect(formatContextTokens(Number.NaN)).toBeNull()
  })
})

describe('responsePreview', () => {
  it('passes a plain one-line response through', () => {
    expect(responsePreview('Ran the tests, all green.')).toBe('Ran the tests, all green.')
  })

  it('collapses newlines and runs of whitespace to single spaces', () => {
    expect(responsePreview('first line\n\nsecond   line\tthird')).toBe('first line second line third')
  })

  it('trims the edges', () => {
    expect(responsePreview('\n  reading the file  \n')).toBe('reading the file')
  })

  it('renders nothing for empty, whitespace-only or absent text', () => {
    expect(responsePreview('')).toBeNull()
    expect(responsePreview('   \n\t ')).toBeNull()
    expect(responsePreview(null)).toBeNull()
    expect(responsePreview(undefined)).toBeNull()
  })
})
