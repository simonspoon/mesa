import { afterEach, describe, expect, it } from 'vitest'
import { shouldIgnoreShortcut } from './keyboardScope'

/**
 * Ask the predicate about a real bubbling keydown, the way the app does:
 * every global shortcut listens on `document`, so `e.target` is the deepest
 * element and the `closest()` checks are walking a live ancestor chain rather
 * than a hand-built stub.
 */
function ignores(target: Element | Document = document.body, init: KeyboardEventInit = {}) {
  let seen: boolean | undefined
  const handler = (e: Event) => {
    seen = shouldIgnoreShortcut(e as KeyboardEvent)
  }
  document.addEventListener('keydown', handler)
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'a', bubbles: true, ...init }),
  )
  document.removeEventListener('keydown', handler)
  if (seen === undefined) throw new Error('keydown never reached document')
  return seen
}

/** Mount `html` in the body and return the element marked `id="t"`. */
function mount(html: string): Element {
  document.body.innerHTML = html
  return document.getElementById('t') ?? document.body
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('shouldIgnoreShortcut', () => {
  it('lets a bare key through', () => {
    expect(ignores()).toBe(false)
  })

  it('lets Shift through — it is not one of the chord modifiers', () => {
    expect(ignores(document.body, { key: 'A', shiftKey: true })).toBe(false)
  })

  it.each(['metaKey', 'ctrlKey', 'altKey'])('ignores a %s chord', (mod) => {
    expect(ignores(document.body, { [mod]: true })).toBe(true)
  })

  it.each([
    ['an input', '<input id="t">'],
    ['a textarea', '<textarea id="t"></textarea>'],
    ['a native select', '<select id="t"></select>'],
    ['an empty contenteditable', '<div id="t" contenteditable=""></div>'],
    ['a contenteditable="true"', '<div id="t" contenteditable="true"></div>'],
    ['an xterm pane', '<div class="xterm"><span id="t"></span></div>'],
    ['an agent terminal', '<div class="agent-terminal"><span id="t"></span></div>'],
  ])('ignores a keystroke inside %s', (_label, html) => {
    expect(ignores(mount(html))).toBe(true)
  })

  it('does not ignore a contenteditable="false" subtree', () => {
    expect(ignores(mount('<div id="t" contenteditable="false"></div>'))).toBe(
      false,
    )
  })

  it('does not ignore a sibling of an input — only an ancestor counts', () => {
    expect(
      ignores(mount('<label><span id="t">x</span><input></label>')),
    ).toBe(false)
  })

  it('ignores every key while a storyboard canvas is mounted anywhere', () => {
    // Document-wide, not target-scoped: the storyboard owns its own spatial
    // key handling even when focus sits elsewhere on the page.
    mount('<div class="storyboard"></div><button id="t"></button>')
    expect(ignores(document.getElementById('t')!)).toBe(true)
  })

  it.each(['create-task-backdrop', 'command-palette-backdrop'])(
    'ignores every key while a .%s is open',
    (cls) => {
      // Also document-wide — which is why a modal left mounted after close
      // silently kills every global shortcut on the page.
      mount(`<div class="${cls}"></div><button id="t"></button>`)
      expect(ignores(document.getElementById('t')!)).toBe(true)
    },
  )

  it('stops ignoring once the modal unmounts', () => {
    mount('<div class="create-task-backdrop"></div>')
    expect(ignores()).toBe(true)
    document.body.innerHTML = ''
    expect(ignores()).toBe(false)
  })
})
