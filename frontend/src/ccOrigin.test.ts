import { describe, expect, it } from 'vitest'
import {
  ccBackLink,
  ccOriginFromHash,
  ccSessionHref,
  ccTimelineHref,
  splitHashQuery,
} from './ccOrigin'

describe('splitHashQuery', () => {
  it('returns a query-less path unchanged', () => {
    expect(splitHashQuery('/cc/sessions/abc')).toEqual({ path: '/cc/sessions/abc', query: '' })
  })

  it('splits the query off the path', () => {
    expect(splitHashQuery('/cc/sessions/abc?project=3')).toEqual({
      path: '/cc/sessions/abc',
      query: 'project=3',
    })
  })

  it('keeps the whole query when it holds more than one key', () => {
    expect(splitHashQuery('/cc/sessions/abc/timeline?project=3&x=1').query).toBe('project=3&x=1')
  })
})

describe('ccOriginFromHash', () => {
  it('reads the project id out of the query', () => {
    expect(ccOriginFromHash('/cc/sessions/abc?project=3')).toBe(3)
    expect(ccOriginFromHash('/cc/sessions/abc/timeline?project=12')).toBe(12)
  })

  it('is null for a path carrying no query', () => {
    expect(ccOriginFromHash('/cc/sessions/abc')).toBeNull()
  })

  it('degrades to no origin for a malformed value rather than throwing', () => {
    for (const hash of [
      '/cc/sessions/abc?project=',
      '/cc/sessions/abc?project=nope',
      '/cc/sessions/abc?project=-3',
      '/cc/sessions/abc?project=0',
      '/cc/sessions/abc?project=3.5',
      '/cc/sessions/abc?other=3',
      '/cc/sessions/abc?',
    ]) {
      expect(ccOriginFromHash(hash)).toBeNull()
    }
  })
})

describe('ccSessionHref', () => {
  it('links to the bare detail route with no origin', () => {
    expect(ccSessionHref('s-1', null)).toBe('#/cc/sessions/s-1')
  })

  it('appends the origin when the table is project-scoped', () => {
    expect(ccSessionHref('s-1', 3)).toBe('#/cc/sessions/s-1?project=3')
  })

  it('encodes the session id', () => {
    expect(ccSessionHref('a/b c', 3)).toBe('#/cc/sessions/a%2Fb%20c?project=3')
  })
})

describe('ccTimelineHref', () => {
  it('forwards the origin one drill-down further in', () => {
    expect(ccTimelineHref('s-1', 3)).toBe('#/cc/sessions/s-1/timeline?project=3')
    expect(ccTimelineHref('s-1', null)).toBe('#/cc/sessions/s-1/timeline')
  })
})

describe('ccBackLink', () => {
  it('goes back to the global Sessions table with no origin', () => {
    expect(ccBackLink(null, 'mesa')).toEqual({ href: '#/cc/sessions', label: '← Sessions' })
  })

  it('goes back to the project dashboard it came from', () => {
    expect(ccBackLink(3, 'mesa')).toEqual({
      href: '#/projects/3/dashboard',
      label: '← mesa dashboard',
    })
  })

  it('labels the project dashboard without a name until the detail lands', () => {
    expect(ccBackLink(3, null)).toEqual({ href: '#/projects/3/dashboard', label: '← Dashboard' })
  })

  it('round-trips a row href through the origin parser', () => {
    const href = ccSessionHref('s-1', 3)
    expect(ccBackLink(ccOriginFromHash(href.slice(1)), 'mesa').href).toBe('#/projects/3/dashboard')
  })
})
