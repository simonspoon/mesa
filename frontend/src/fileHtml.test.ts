import { describe, expect, it } from 'vitest'
import { isHtmlDocumentPath } from './fileHtml'

describe('isHtmlDocumentPath', () => {
  it('accepts both document extensions', () => {
    expect(isHtmlDocumentPath('index.html')).toBe(true)
    expect(isHtmlDocumentPath('docs/old.htm')).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(isHtmlDocumentPath('INDEX.HTML')).toBe(true)
    expect(isHtmlDocumentPath('a/Page.HtM')).toBe(true)
  })

  it('rejects the other sources the server also calls "html"', () => {
    expect(isHtmlDocumentPath('src/App.vue')).toBe(false)
    expect(isHtmlDocumentPath('src/App.svelte')).toBe(false)
    expect(isHtmlDocumentPath('src/App.astro')).toBe(false)
  })

  it('reads the FINAL extension only', () => {
    expect(isHtmlDocumentPath('index.html.txt')).toBe(false)
    expect(isHtmlDocumentPath('notes.txt.html')).toBe(true)
  })

  it('rejects a name with no extension of its own', () => {
    expect(isHtmlDocumentPath('README')).toBe(false)
    expect(isHtmlDocumentPath('.html')).toBe(false)
    expect(isHtmlDocumentPath('a/.htm')).toBe(false)
    expect(isHtmlDocumentPath('')).toBe(false)
  })

  it('rejects a directory component that looks like one', () => {
    expect(isHtmlDocumentPath('site.html/index.md')).toBe(false)
  })
})
