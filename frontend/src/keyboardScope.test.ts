import { afterEach, describe, expect, it } from 'vitest'
import { shouldIgnoreFilesShortcut, shouldIgnoreShortcut } from './keyboardScope'

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

/** The chord twin of `ignores`, asked about a real Cmd+F keydown. */
function ignoresFind(target: Element | Document = document.body) {
  let seen: boolean | undefined
  const handler = (e: Event) => {
    seen = shouldIgnoreFilesShortcut(e as KeyboardEvent, 'find')
  }
  document.addEventListener('keydown', handler)
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }),
  )
  document.removeEventListener('keydown', handler)
  if (seen === undefined) throw new Error('keydown never reached document')
  return seen
}

/** The same, for the project-search chord: a real Cmd+Shift+F. */
function ignoresSearch(target: Element | Document = document.body) {
  let seen: boolean | undefined
  const handler = (e: Event) => {
    seen = shouldIgnoreFilesShortcut(e as KeyboardEvent, 'search')
  }
  document.addEventListener('keydown', handler)
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'F',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    }),
  )
  document.removeEventListener('keydown', handler)
  if (seen === undefined) throw new Error('keydown never reached document')
  return seen
}

/** The same, for a tab chord: a real Alt+] (matched on `code`, since Alt+] is
 * the character `‘` on macOS). */
function ignoresTabs(target: Element | Document = document.body) {
  let seen: boolean | undefined
  const handler = (e: Event) => {
    seen = shouldIgnoreFilesShortcut(e as KeyboardEvent, 'tabs')
  }
  document.addEventListener('keydown', handler)
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: '‘',
      code: 'BracketRight',
      altKey: true,
      bubbles: true,
    }),
  )
  document.removeEventListener('keydown', handler)
  if (seen === undefined) throw new Error('keydown never reached document')
  return seen
}

describe('shouldIgnoreFilesShortcut', () => {
  it('lets the chord through with nothing focused', () => {
    expect(ignoresFind()).toBe(false)
  })

  it('lets it through from the file editor itself', () => {
    expect(
      ignoresFind(mount('<textarea id="t" class="files-content-editor"></textarea>')),
    ).toBe(false)
  })

  it('lets it through from the find bar own query box', () => {
    expect(ignoresFind(mount('<input id="t" class="files-find-input">'))).toBe(
      false,
    )
  })

  it.each([
    ['the tree new-file row', '<input id="t" class="files-tree-new-input">'],
    ['some other textarea', '<textarea id="t"></textarea>'],
    ['a native select', '<select id="t"></select>'],
    ['a contenteditable', '<div id="t" contenteditable="true"></div>'],
  ])('ignores it while the caret is in %s', (_label, html) => {
    expect(ignoresFind(mount(html))).toBe(true)
  })

  it.each(['create-task-backdrop', 'command-palette-backdrop'])(
    'ignores it while a .%s is open, wherever focus sits',
    (cls) => {
      mount(`<div class="${cls}"></div><button id="t"></button>`)
      expect(ignoresFind(document.getElementById('t')!)).toBe(true)
    },
  )

  it('does not care about a storyboard canvas — the Files tab is its own page', () => {
    mount('<div class="storyboard"></div><button id="t"></button>')
    expect(ignoresFind(document.getElementById('t')!)).toBe(false)
  })

  // The tab chords (Alt+W, Alt+[ / Alt+]) go through the same gate, and the
  // gate never looks at which *key* it is — asserted rather than assumed, since
  // "it happens to be key-blind" is exactly what a later edit could take away.
  // It looks only at which `chord` the caller says it is, and on one control.
  it('answers the same for an Alt chord from the editor', () => {
    const editor = mount('<textarea id="t" class="files-content-editor"></textarea>')
    let seen: boolean | undefined
    const handler = (e: Event) => {
      seen = shouldIgnoreFilesShortcut(e as KeyboardEvent, 'tabs')
    }
    document.addEventListener('keydown', handler)
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: '∑', altKey: true, bubbles: true }),
    )
    document.removeEventListener('keydown', handler)
    expect(seen).toBe(false)
  })

  it('stands a tab chord down while the caret is in the find bar', () => {
    // The one place the two chords differ: Cmd/Ctrl+F acts *in* that input,
    // while Alt+W / Alt+[ / Alt+] unmount it — with focus in it, which drops
    // focus on <body>.
    const input = mount('<input id="t" class="files-find-input">')
    expect(ignoresTabs(input)).toBe(true)
    expect(ignoresFind(input)).toBe(false)
  })

  it.each([
    ['the editor', '<textarea id="t" class="files-content-editor"></textarea>'],
    ['the file itself', '<div id="t" class="files-content"></div>'],
  ])('leaves a tab chord alone from %s', (_label, html) => {
    expect(ignoresTabs(mount(html))).toBe(false)
  })

  it('ignores a tab chord in someone else’s field, like the find chord', () => {
    expect(ignoresTabs(mount('<input id="t" class="files-tree-new-input">'))).toBe(
      true,
    )
  })

  // The project-search chord (Cmd/Ctrl+Shift+F, mesa task 813) is the third
  // caller: same gate, one more box it survives.
  it('lets the search chord through from the editor and from either query box', () => {
    for (const html of [
      '<textarea id="t" class="files-content-editor"></textarea>',
      '<input id="t" class="files-find-input">',
      '<input id="t" class="files-search-input">',
    ]) {
      expect(ignoresSearch(mount(html))).toBe(false)
    }
  })

  it('stands the find chord down in the search panel own box, and vice versa', () => {
    // Each chord acts *in* its own input and would be typed *into* the other
    // one — the same asymmetry `'tabs'` has against the find bar.
    expect(ignoresFind(mount('<input id="t" class="files-search-input">'))).toBe(
      true,
    )
    expect(ignoresTabs(mount('<input id="t" class="files-search-input">'))).toBe(
      true,
    )
  })

  it('ignores the search chord in someone else’s field', () => {
    expect(
      ignoresSearch(mount('<input id="t" class="files-tree-new-input">')),
    ).toBe(true)
    mount('<div class="command-palette-backdrop"></div><button id="t"></button>')
    expect(ignoresSearch(document.getElementById('t')!)).toBe(true)
  })
})
