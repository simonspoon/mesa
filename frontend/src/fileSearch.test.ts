import { describe, expect, it } from 'vitest'
import {
  MAX_SEARCH_QUERY,
  searchRequestQuery,
  searchSummary,
  snippetSegments,
} from './fileSearch'
import type { ProjectFileSearch } from './types/ProjectFileSearch'

function result(patch: Partial<ProjectFileSearch> = {}): ProjectFileSearch {
  return { files: [], total_matches: 0, truncated: false, ...patch }
}

function file(path: string, lines: number[]) {
  return {
    path,
    language: null,
    matches: lines.map((line) => ({ line, text: 'x' })),
    truncated: false,
  }
}

describe('searchRequestQuery', () => {
  it('sends the query verbatim', () => {
    expect(searchRequestQuery('needle')).toBe('needle')
  })

  it('refuses an empty query and nothing else', () => {
    expect(searchRequestQuery('')).toBeNull()
    // Whitespace is searchable text in a code browser, so it is a real query
    // rather than an empty one — trimming would search for something else.
    expect(searchRequestQuery('  ')).toBe('  ')
    expect(searchRequestQuery(' else {')).toBe(' else {')
  })

  it('clamps an over-long query instead of refusing it', () => {
    const long = 'n'.repeat(MAX_SEARCH_QUERY + 50)
    expect(searchRequestQuery(long)).toHaveLength(MAX_SEARCH_QUERY)
  })
})

describe('searchSummary', () => {
  it('says nothing before a search has run', () => {
    expect(searchSummary(null)).toBe('')
  })

  it('says so in words when nothing matched', () => {
    expect(searchSummary(result())).toBe('No results')
  })

  it('counts results and files, singular and plural', () => {
    expect(
      searchSummary(result({ files: [file('a.rs', [1])], total_matches: 1 })),
    ).toBe('1 result in 1 file')
    expect(
      searchSummary(
        result({
          files: [file('a.rs', [1, 2]), file('b.rs', [7])],
          total_matches: 3,
        }),
      ),
    ).toBe('3 results in 2 files')
  })

  it('marks a capped search as a floor, never a total', () => {
    expect(
      searchSummary(
        result({
          files: [file('a.rs', [1])],
          total_matches: 1000,
          truncated: true,
        }),
      ),
    ).toBe('1000+ results in 1+ file')
  })
})

describe('snippetSegments', () => {
  const plain = { caseSensitive: false, wholeWord: false }

  it('cuts a snippet into plain and matched runs', () => {
    expect(snippetSegments('let needle = 1', 'needle', plain)).toEqual([
      { text: 'let ', match: -1 },
      { text: 'needle', match: 0 },
      { text: ' = 1', match: -1 },
    ])
  })

  it('honours the same toggles the find bar does', () => {
    expect(
      snippetSegments('Needle needles', 'needle', {
        caseSensitive: true,
        wholeWord: false,
      }),
    ).toEqual([
      { text: 'Needle ', match: -1 },
      { text: 'needle', match: 0 },
      { text: 's', match: -1 },
    ])
    expect(
      snippetSegments('needles needle', 'needle', {
        caseSensitive: false,
        wholeWord: true,
      }),
    ).toEqual([
      { text: 'needles ', match: -1 },
      { text: 'needle', match: 0 },
    ])
  })

  it('leaves a snippet whose match was windowed away unhighlighted', () => {
    // The server cuts a long line around the match; a row it cut *through*
    // simply paints plain — never a highlight in the wrong place.
    expect(snippetSegments('…eedle = 1', 'needle', plain)).toEqual([
      { text: '…eedle = 1', match: -1 },
    ])
  })
})
