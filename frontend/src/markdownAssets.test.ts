import { describe, expect, it } from 'vitest'
import { resolveMarkdownImageSrc } from './markdownAssets'

describe('resolveMarkdownImageSrc', () => {
  it('resolves a relative src against the markdown file directory', () => {
    expect(resolveMarkdownImageSrc('', './a.png')).toBe('a.png')
    expect(resolveMarkdownImageSrc('', 'a.png')).toBe('a.png')
    expect(resolveMarkdownImageSrc('docs', 'imgs/b.svg')).toBe('docs/imgs/b.svg')
    expect(resolveMarkdownImageSrc('docs', './imgs/b.svg')).toBe('docs/imgs/b.svg')
  })

  it('walks up with `..`', () => {
    expect(resolveMarkdownImageSrc('docs/sub', '../c.png')).toBe('docs/c.png')
    expect(resolveMarkdownImageSrc('docs/sub', '../../c.png')).toBe('c.png')
    expect(resolveMarkdownImageSrc('docs/sub', '../imgs/./c.png')).toBe('docs/imgs/c.png')
  })

  it('refuses a `..` chain that escapes the repo root', () => {
    expect(resolveMarkdownImageSrc('docs', '../../../etc/passwd')).toBeNull()
    expect(resolveMarkdownImageSrc('', '../a.png')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', '/../a.png')).toBeNull()
  })

  it('treats a leading slash as repo-root-relative', () => {
    expect(resolveMarkdownImageSrc('docs/sub', '/logo.png')).toBe('logo.png')
    expect(resolveMarkdownImageSrc('', '/logo.png')).toBe('logo.png')
    expect(resolveMarkdownImageSrc('docs', '/imgs/logo.png')).toBe('imgs/logo.png')
  })

  it('refuses anything with an absolute URL scheme', () => {
    expect(resolveMarkdownImageSrc('docs', 'https://x/y.png')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', 'http://x/y.png')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', 'data:image/png;base64,AAA')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', 'mailto:someone@example.com')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', 'weird-scheme:y.png')).toBeNull()
  })

  it('refuses a protocol-relative URL', () => {
    expect(resolveMarkdownImageSrc('docs', '//cdn/x.png')).toBeNull()
  })

  it('refuses an anchor and an empty src', () => {
    expect(resolveMarkdownImageSrc('docs', '#anchor')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', '')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', '   ')).toBeNull()
  })

  it('strips a query or fragment before resolving', () => {
    expect(resolveMarkdownImageSrc('', 'a.png?v=2')).toBe('a.png')
    expect(resolveMarkdownImageSrc('', 'a.png#x')).toBe('a.png')
    expect(resolveMarkdownImageSrc('docs', 'imgs/b.svg?w=10#frag')).toBe('docs/imgs/b.svg')
  })

  // The answer is a path, not a URL — the caller re-encodes it, so an escape
  // left standing here would reach the server double-encoded.
  it('decodes percent-escapes into the real filename', () => {
    expect(resolveMarkdownImageSrc('docs', 'my%20logo.png')).toBe('docs/my logo.png')
    expect(resolveMarkdownImageSrc('', './a%2Bb.png')).toBe('a+b.png')
    expect(resolveMarkdownImageSrc('', 'a%23b.png')).toBe('a#b.png')
  })

  it('refuses a separator or dot-segment smuggled in behind an escape', () => {
    expect(resolveMarkdownImageSrc('docs', 'a%2Fb.png')).toBe(null)
    expect(resolveMarkdownImageSrc('docs', '%2E%2E/x.png')).toBe(null)
    expect(resolveMarkdownImageSrc('docs', '%2e/x.png')).toBe(null)
  })

  it('keeps a malformed escape verbatim — it is a filename, not an error', () => {
    expect(resolveMarkdownImageSrc('', '100%.png')).toBe('100%.png')
  })

  it('treats a backslash as an ordinary character, not a separator', () => {
    expect(resolveMarkdownImageSrc('docs', 'a\\b.png')).toBe('docs/a\\b.png')
  })

  it('refuses a src that normalises away to nothing', () => {
    expect(resolveMarkdownImageSrc('', '.')).toBeNull()
    expect(resolveMarkdownImageSrc('', '/')).toBeNull()
    expect(resolveMarkdownImageSrc('docs', '../')).toBeNull()
  })
})
