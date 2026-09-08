import { describe, expect, it } from 'vitest'
import { highlightOverlaySource, prismGrammar } from './syntaxHighlighter'

describe('prismGrammar', () => {
  it('maps a server language tag to its registered grammar', () => {
    expect(prismGrammar('rust')).toBe('rust')
    expect(prismGrammar('csharp')).toBe('csharp')
  })

  it('accepts the aliases people write after a markdown fence', () => {
    expect(prismGrammar('yml')).toBe('yaml')
    expect(prismGrammar('sh')).toBe('bash')
    expect(prismGrammar('C#')).toBe('csharp')
  })

  it('resolves both query languages, however they are spelled', () => {
    expect(prismGrammar('sql')).toBe('sql')
    // The server tags Kusto "kql"; Prism registers the grammar as "kusto".
    expect(prismGrammar('kql')).toBe('kusto')
    expect(prismGrammar('kusto')).toBe('kusto')
    expect(prismGrammar('csl')).toBe('kusto')
  })

  it('is undefined for an unknown or absent token', () => {
    // The caller's cue to render a plain, uncoloured block instead.
    expect(prismGrammar('brainfuck')).toBeUndefined()
    expect(prismGrammar('')).toBeUndefined()
    expect(prismGrammar(null)).toBeUndefined()
  })
})

describe('highlightOverlaySource', () => {
  it('leaves a body with no trailing newline alone', () => {
    expect(highlightOverlaySource('fn main() {}')).toBe('fn main() {}')
    expect(highlightOverlaySource('')).toBe('')
  })

  it('pads one newline so <pre> keeps the textarea’s line count', () => {
    // A <pre> swallows exactly one trailing newline; without the pad, the
    // caret's line and the painted line drift apart from here on.
    expect(highlightOverlaySource('a\n')).toBe('a\n\n')
  })

  it('pads only once however many blank lines trail', () => {
    expect(highlightOverlaySource('a\n\n\n')).toBe('a\n\n\n\n')
  })
})
