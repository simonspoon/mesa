import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  DEFAULT_KEYMAP,
  canonicalChord,
  chordFromEvent,
  chordLabel,
  conflicts,
  formatChord,
  hasModifier,
  matchedChord,
  matchesChord,
  matchesShortcut,
  resolveKeymap,
  sameChords,
  type Keymap,
} from './keymap'
import type { ConfigKeymap } from './types/ConfigKeymap'

/** A keystroke, with the modifiers a `KeyboardEvent` reports. */
function press(key: string, mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {}) {
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  }
}

/** The same keystroke as a real bubbling event, for the two predicates that
 *  consult `shouldIgnoreShortcut` and therefore need a DOM target. */
function dispatch(
  key: string,
  mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {},
  target?: Element,
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { ...press(key, mods), bubbles: true })
  // `shouldIgnoreShortcut` reads `e.target`, which a constructed event leaves
  // null — the same trick `keyboardScope.test.ts` avoids by dispatching for
  // real. Here the predicate is the subject, not the delivery, so naming the
  // target directly is the honest thing to pin.
  Object.defineProperty(e, 'target', { value: target ?? document.body })
  return e
}

describe('the shipped keymap', () => {
  // The whole point of the defaults: nothing about the keyboard changed the
  // day this section shipped. The Rust twin of this test is
  // `config::tests::the_shipped_keymap_is_todays_behaviour`.
  it('is exactly what the app answered to before it was rebindable', () => {
    expect(DEFAULT_KEYMAP).toEqual({
      'command-palette': ['Mod+Shift+P'],
      'focus-left': ['h', 'ArrowLeft'],
      'focus-down': ['j', 'ArrowDown'],
      'focus-up': ['k', 'ArrowUp'],
      'focus-right': ['l', 'ArrowRight'],
      'create-task': ['a'],
      'live-listen': ['Mod+Shift+L'],
    })
  })

  it('binds no chord to two actions', () => {
    expect(conflicts(DEFAULT_KEYMAP)).toEqual([])
  })

  it('is every action ACTIONS names, in that order', () => {
    expect(Object.keys(DEFAULT_KEYMAP)).toEqual(ACTIONS.map((a) => a.id))
  })
})

describe('matchesChord', () => {
  it('matches the palette chord under either platform modifier', () => {
    // Cmd on a Mac, Ctrl elsewhere — one chord, folded into `Mod`.
    expect(matchesChord('Mod+Shift+P', press('P', { meta: true, shift: true }))).toBe(true)
    expect(matchesChord('Mod+Shift+P', press('P', { ctrl: true, shift: true }))).toBe(true)
  })

  it('reads a letter case-insensitively, since Shift capitalises it', () => {
    expect(matchesChord('Mod+Shift+L', press('l', { meta: true, shift: true }))).toBe(true)
    expect(matchesChord('Mod+Shift+L', press('L', { meta: true, shift: true }))).toBe(true)
    expect(matchesChord('a', press('a'))).toBe(true)
    expect(matchesChord('a', press('b'))).toBe(false)
  })

  it('compares every modifier in both directions', () => {
    expect(matchesChord('Mod+Shift+L', press('L', { meta: true }))).toBe(false)
    expect(matchesChord('Mod+Shift+L', press('L', { shift: true }))).toBe(false)
    // A chord that happens to end in L but carries Alt is a different chord.
    expect(matchesChord('Mod+Shift+L', press('L', { meta: true, shift: true, alt: true }))).toBe(
      false,
    )
    // …and a bare chord is not pressed while a modifier is held.
    expect(matchesChord('a', press('a', { meta: true }))).toBe(false)
    expect(matchesChord('ArrowLeft', press('ArrowLeft'))).toBe(true)
    expect(matchesChord('ArrowLeft', press('ArrowLeft', { shift: true }))).toBe(false)
  })

  it('never matches a chord it cannot parse', () => {
    expect(matchesChord('Hyper+k', press('k'))).toBe(false)
    expect(matchesChord('', press(''))).toBe(false)
  })
})

describe('chordFromEvent', () => {
  it('records the modifiers held, with Cmd and Ctrl folding to one Mod', () => {
    // A Mac records Cmd; a Linux/Windows box records Ctrl; the same chord.
    expect(chordFromEvent(press('P', { meta: true, shift: true }))).toBe('Mod+Shift+p')
    expect(chordFromEvent(press('P', { ctrl: true, shift: true }))).toBe('Mod+Shift+p')
    expect(chordFromEvent(press('N', { meta: true, ctrl: true, shift: true }))).toBe('Mod+Shift+n')
  })

  it('writes the modifiers in one fixed order whatever was pressed', () => {
    expect(chordFromEvent(press('k', { alt: true, shift: true, ctrl: true }))).toBe(
      'Mod+Alt+Shift+k',
    )
  })

  it('keeps the key name the browser reports', () => {
    expect(chordFromEvent(press('ArrowLeft'))).toBe('ArrowLeft')
    expect(chordFromEvent(press('/'))).toBe('/')
    expect(chordFromEvent(press('a'))).toBe('a')
  })

  it('is null for a bare modifier — that is how a chord starts', () => {
    expect(chordFromEvent(press('Shift', { shift: true }))).toBeNull()
    expect(chordFromEvent(press('Meta', { meta: true }))).toBeNull()
    expect(chordFromEvent(press('Control', { ctrl: true }))).toBeNull()
    expect(chordFromEvent(press('Alt', { alt: true }))).toBeNull()
  })

  it('round-trips: what it records is what matches', () => {
    const e = press('P', { ctrl: true, shift: true })
    expect(matchesChord(chordFromEvent(e) as string, e)).toBe(true)
  })
})

describe('canonicalChord', () => {
  it('is one spelling per binding', () => {
    expect(canonicalChord('Shift+Mod+A')).toBe('Mod+Shift+a')
    expect(canonicalChord('mod+shift+p')).toBe('Mod+Shift+p')
    expect(canonicalChord(' ArrowLeft ')).toBe('ArrowLeft')
    expect(sameChords(['H', 'ArrowLeft'], ['ArrowLeft', 'h'])).toBe(true)
  })

  it('refuses what the server refuses', () => {
    expect(canonicalChord('')).toBeNull()
    expect(canonicalChord('Mod+')).toBeNull()
    expect(canonicalChord('Hyper+k')).toBeNull()
    expect(canonicalChord('Mod+Mod+k')).toBeNull()
    expect(canonicalChord('Shift')).toBeNull()
    expect(canonicalChord('Mod+ k')).toBeNull()
  })

  it('knows which chords carry a modifier', () => {
    expect(hasModifier('Mod+Shift+P')).toBe(true)
    expect(hasModifier('Shift+a')).toBe(true)
    expect(hasModifier('a')).toBe(false)
    expect(hasModifier('ArrowLeft')).toBe(false)
  })
})

describe('matchesShortcut', () => {
  it('honours an override', () => {
    const keymap: Keymap = { ...DEFAULT_KEYMAP, 'create-task': ['Mod+Shift+N'] }
    expect(matchesShortcut('create-task', dispatch('a'), keymap)).toBe(false)
    expect(
      matchesShortcut('create-task', dispatch('N', { meta: true, shift: true }), keymap),
    ).toBe(true)
    // …and the default still applies to every action the override left alone.
    expect(matchesShortcut('focus-left', dispatch('h'), keymap)).toBe(true)
  })

  it('reports which of an action’s chords was pressed', () => {
    expect(matchedChord('focus-left', press('h'), DEFAULT_KEYMAP)).toBe('h')
    expect(matchedChord('focus-left', press('ArrowLeft'), DEFAULT_KEYMAP)).toBe('ArrowLeft')
    expect(matchedChord('focus-left', press('j'), DEFAULT_KEYMAP)).toBeNull()
  })

  it('subjects a bare chord to shouldIgnoreShortcut, wherever it is bound', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    // The shipped bare chords, suppressed inside a text field exactly as the
    // inline `shouldIgnoreShortcut` calls they replaced were.
    expect(matchesShortcut('create-task', dispatch('a', {}, input), DEFAULT_KEYMAP)).toBe(false)
    expect(matchesShortcut('focus-left', dispatch('h', {}, input), DEFAULT_KEYMAP)).toBe(false)
    // A palette rebound to a bare letter is now suppressed there too — the
    // rule follows the chord, not the call site.
    const bare: Keymap = { ...DEFAULT_KEYMAP, 'command-palette': ['p'] }
    expect(matchesShortcut('command-palette', dispatch('p', {}, input), bare)).toBe(false)
    expect(matchesShortcut('command-palette', dispatch('p'), bare)).toBe(true)
    input.remove()
  })

  it('leaves a modifier chord claimed from inside a text field', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(
      matchesShortcut(
        'command-palette',
        dispatch('P', { meta: true, shift: true }, input),
        DEFAULT_KEYMAP,
      ),
    ).toBe(true)
    // The listen chord is the reason that rule exists: the capture box holds
    // the keyboard for most of a conversation.
    expect(
      matchesShortcut(
        'live-listen',
        dispatch('L', { ctrl: true, shift: true }, input),
        DEFAULT_KEYMAP,
      ),
    ).toBe(true)
    input.remove()
  })
})

describe('conflicts', () => {
  it('finds a chord two actions would both answer to', () => {
    const clashing: Keymap = { ...DEFAULT_KEYMAP, 'create-task': ['h'] }
    expect(conflicts(clashing)).toEqual([{ chord: 'h', actions: ['focus-left', 'create-task'] }])
  })

  it('sees through two spellings of one chord', () => {
    const clashing: Keymap = {
      ...DEFAULT_KEYMAP,
      'create-task': ['Shift+Mod+P'],
    }
    expect(conflicts(clashing)).toEqual([
      { chord: 'Mod+Shift+p', actions: ['command-palette', 'create-task'] },
    ])
  })
})

describe('resolveKeymap', () => {
  const config = (rows: { action: string; value: string[] | null }[]): ConfigKeymap => ({
    actions: rows.map((r) => ({
      ...r,
      default: DEFAULT_KEYMAP[r.action as keyof Keymap] ?? [],
    })),
  })

  it('is the shipped keymap before the fetch has answered', () => {
    expect(resolveKeymap(null)).toEqual(DEFAULT_KEYMAP)
    expect(resolveKeymap(undefined)).toEqual(DEFAULT_KEYMAP)
  })

  it('takes an override and leaves everything else shipped', () => {
    const resolved = resolveKeymap(
      config([
        { action: 'create-task', value: ['n'] },
        { action: 'focus-left', value: null },
      ]),
    )
    expect(resolved['create-task']).toEqual(['n'])
    expect(resolved['focus-left']).toEqual(['h', 'ArrowLeft'])
  })

  it('drops an entry it cannot use, costing that action alone', () => {
    const resolved = resolveKeymap(
      config([
        { action: 'create-task', value: [] },
        { action: 'focus-up', value: ['Hyper+k'] },
        { action: 'invent-a-shortcut', value: ['q'] },
        { action: 'focus-down', value: ['J'] },
      ]),
    )
    expect(resolved['create-task']).toEqual(['a'])
    expect(resolved['focus-up']).toEqual(['k', 'ArrowUp'])
    expect(resolved['focus-down']).toEqual(['J'])
    expect('invent-a-shortcut' in resolved).toBe(false)
  })
})

describe('formatChord', () => {
  it('draws a chord as the caps a keyboard has', () => {
    expect(formatChord('Mod+Shift+P')).toEqual(['⌘/Ctrl', 'Shift', 'P'])
    expect(formatChord('ArrowLeft')).toEqual(['←'])
    expect(formatChord('h')).toEqual(['H'])
    expect(chordLabel('Mod+Shift+L')).toBe('⌘/Ctrl+Shift+L')
  })

  it('names ⌘ and Ctrl together rather than guessing the platform', () => {
    // The rule `liveRecognition.ts`'s LISTEN_CHORD already followed: the label
    // is read beside the control, and being told which half is yours beats a
    // wrong guess about a keyboard mesa cannot see.
    expect(chordLabel('Mod+Shift+L')).toBe('⌘/Ctrl+Shift+L')
  })

  it('shows an unknown key as the browser names it rather than blank', () => {
    expect(formatChord('F13')).toEqual(['F13'])
    expect(formatChord('not a chord')).toEqual(['not a chord'])
  })
})
