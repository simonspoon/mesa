import { refractor } from 'refractor/core'
import { describe, expect, it } from 'vitest'
import { highlightOverlaySource, prismGrammar } from './syntaxHighlighter'

// Importing the module under test is what runs its registerLanguage calls,
// and PrismLight's registerLanguage ignores the name it is given and hands the
// grammar straight to this same refractor singleton — so `refractor.registered`
// is the only honest answer to "did that token's grammar actually load".
// PrismLight exposes no list of its own (there is no `supportedLanguages` on
// it), which is why the test reaches for refractor rather than the component.

/** Every language token the server's `core::files::language_of` /
 * `language_of_name` can tag a file with, plus the fence aliases people write
 * by hand — each paired with the Prism grammar it must resolve to. */
const EXPECTED: Array<[string, string]> = [
  ['swift', 'swift'],
  ['kotlin', 'kotlin'],
  ['kt', 'kotlin'],
  ['java', 'java'],
  ['objectivec', 'objectivec'],
  ['objc', 'objectivec'],
  ['php', 'php'],
  ['dart', 'dart'],
  ['scala', 'scala'],
  ['lua', 'lua'],
  ['perl', 'perl'],
  ['r', 'r'],
  ['haskell', 'haskell'],
  ['hs', 'haskell'],
  ['elixir', 'elixir'],
  ['docker', 'docker'],
  ['dockerfile', 'docker'],
  ['makefile', 'makefile'],
  ['make', 'makefile'],
  ['diff', 'diff'],
  ['patch', 'diff'],
  ['ini', 'ini'],
  ['env', 'ini'],
  ['dotenv', 'ini'],
  ['powershell', 'powershell'],
  ['ps1', 'powershell'],
  ['pwsh', 'powershell'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['protobuf', 'protobuf'],
  ['proto', 'protobuf'],
  ['graphql', 'graphql'],
  ['gql', 'graphql'],
  ['groovy', 'groovy'],
  ['gradle', 'groovy'],
]

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

  it('resolves every new server tag and fence alias', () => {
    for (const [token, grammar] of EXPECTED) {
      expect(prismGrammar(token), token).toBe(grammar)
    }
  })

  it('resolves a token whatever case it arrives in', () => {
    expect(prismGrammar('Dockerfile')).toBe('docker')
    expect(prismGrammar('PowerShell')).toBe('powershell')
  })

  it('leaves an Xcode project file uncoloured', () => {
    // .pbxproj is a NeXT-style plist, not XML — the server deliberately
    // leaves it untagged, and no fence alias rescues it here either.
    expect(prismGrammar('pbxproj')).toBeUndefined()
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

describe('registered grammars', () => {
  it('has actually loaded every grammar the table resolves to', () => {
    for (const grammar of new Set(EXPECTED.map(([, g]) => g))) {
      expect(refractor.registered(grammar), grammar).toBe(true)
    }
  })

  it('pulls in the grammars the dependency-heavy ones extend', () => {
    // php extends markup+clike, scss extends css, objectivec extends c,
    // kotlin and groovy extend clike. Each ESM module is supposed to register
    // its own dependencies; highlighting a sample is what proves it did —
    // an unregistered dependency leaves the extend a no-op and the sample
    // comes back as one undifferentiated text node.
    const samples: Array<[string, string]> = [
      ['php', '<?php $x = "hi"; echo $x; ?>'],
      ['scss', '$c: red;\n.a { color: $c; }'],
      ['objectivec', '@interface Foo : NSObject\n@end'],
      ['kotlin', 'fun main() { val x = 1 }'],
      ['groovy', 'def x = "hi"\nprintln x'],
    ]
    // Counted through the whole tree rather than across the top level: php
    // wraps its whole `<?php … ?>` span in one element and puts every token
    // inside it, so a top-level count alone would read as "no colouring".
    const elements = (node: { type: string; children?: unknown[] }): number =>
      (node.type === 'element' ? 1 : 0) +
      ((node.children ?? []) as Array<{ type: string; children?: unknown[] }>)
        .map(elements)
        .reduce((a, b) => a + b, 0)
    for (const [grammar, source] of samples) {
      expect(elements(refractor.highlight(source, grammar)), grammar).toBeGreaterThan(1)
    }
  })
})
