import { shouldIgnoreShortcut } from './keyboardScope'
import type { ConfigKeymap } from './types/ConfigKeymap'

/**
 * The one table of mesa's **global** keyboard shortcuts, and the rules for
 * reading a keystroke against it (mesa task 1079).
 *
 * Before this module each listener compared `e.key` inline — the palette in
 * `App.tsx`, the spatial nav's `KEY_DIRECTION`, the `a` shortcut in
 * `ProjectTasksPage`, the listen chord in `liveRecognition.ts` — so there was
 * nowhere to *state* what mesa binds, and nothing to rebind. Every one of them
 * now asks `matchesShortcut` instead, which is what lets the Settings page's
 * Keyboard shortcuts section and the command palette's key caps read the same
 * answer the listeners act on.
 *
 * Only the four global **window** listeners are here. The Files tab's chords,
 * the code editor's Cmd/Ctrl+S and a modal's Escape stay hard-coded on
 * purpose: each belongs to one surface that is on screen and owns the keyboard
 * while it is, which is a different thing from a binding the whole app answers
 * to. Rebinding those would mean rebinding a form, not the app.
 */

/** Every action the keymap names. */
export type KeymapAction =
  | 'command-palette'
  | 'focus-left'
  | 'focus-down'
  | 'focus-up'
  | 'focus-right'
  | 'create-task'
  | 'live-listen'

export interface KeymapActionSpec {
  id: KeymapAction
  /** What the Settings row calls it. Copy, not contract — the server holds ids
   *  and chords and nothing else. */
  label: string
  /** The one-line "what does this do", shown under the label. */
  blurb: string
  /** The chords mesa ships. A **list**, because the spatial nav has always
   *  answered to a letter *and* an arrow; a rebind replaces the whole list
   *  with the one chord recorded. */
  defaults: string[]
}

/**
 * The shipped bindings, in the order the Settings page lists them.
 *
 * The **twin** of `config::KEYMAP_ACTIONS` in `src/core/config.rs`, which
 * holds the same ids and the same defaults so the server can refuse an unknown
 * action and judge a collision against an action nobody overrode. Two copies
 * because the page has to render before its first fetch resolves; each side
 * has a test naming these exact strings, so editing one without the other
 * fails.
 */
export const ACTIONS: KeymapActionSpec[] = [
  {
    id: 'command-palette',
    label: 'Command palette',
    blurb: 'Jump to a project, a view, or create a task',
    defaults: ['Mod+Shift+P'],
  },
  {
    id: 'focus-left',
    label: 'Move focus left',
    blurb: 'Spatial focus navigation, by what is on screen rather than tab order',
    defaults: ['h', 'ArrowLeft'],
  },
  {
    id: 'focus-down',
    label: 'Move focus down',
    blurb: 'Spatial focus navigation',
    defaults: ['j', 'ArrowDown'],
  },
  {
    id: 'focus-up',
    label: 'Move focus up',
    blurb: 'Spatial focus navigation',
    defaults: ['k', 'ArrowUp'],
  },
  {
    id: 'focus-right',
    label: 'Move focus right',
    blurb: 'Spatial focus navigation',
    defaults: ['l', 'ArrowRight'],
  },
  {
    id: 'create-task',
    label: 'Create task',
    blurb: 'Opens the create-task form over whichever project view you are on',
    defaults: ['a'],
  },
  {
    id: 'live-listen',
    label: 'Live conversation: listen',
    blurb: 'Opens and shuts the microphone during a live conversation',
    defaults: ['Mod+Shift+L'],
  },
]

/** What every action is bound to right now. */
export type Keymap = Record<KeymapAction, string[]>

export const DEFAULT_KEYMAP: Keymap = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.defaults]),
) as Keymap

/** The modifier names a chord may carry, in the order a canonical chord writes
 *  them. `Mod` is meta-or-ctrl: one name for both platforms, because a keymap
 *  saved on a Mac has to mean the same thing on the Linux box that reads the
 *  same config file. */
const MODIFIERS = ['Mod', 'Alt', 'Shift'] as const

/** Keys that are only ever a modifier: never the tail of a chord, and never
 *  what a recording settles on — pressing Shift is how a chord *starts*. */
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Meta',
  'Alt',
  'AltGraph',
  'CapsLock',
  'OS',
  'Mod',
  'Ctrl',
])

interface ParsedChord {
  mod: boolean
  alt: boolean
  shift: boolean
  /** The `KeyboardEvent.key` this chord ends in, lowercased when it is a
   *  single character. */
  key: string
}

/**
 * A chord string parsed, or `null` when it is not one mesa can use.
 *
 * mesa invents no key names: the tail is whatever `KeyboardEvent.key` reports
 * (`ArrowLeft`, `Enter`, `/`, `a`), so what a recording captures from a real
 * keystroke is exactly what is stored and exactly what is compared. The
 * mirror of `config::canonical_chord`, which refuses the same shapes on the
 * way into the file.
 */
export function parseChord(chord: string): ParsedChord | null {
  const trimmed = (chord ?? '').trim()
  if (trimmed === '' || /\s/.test(trimmed)) return null
  const parts = trimmed.split('+')
  const key = parts.pop() as string
  if (key === '' || MODIFIER_KEYS.has(key) || MODIFIER_KEYS.has(key.toLowerCase())) return null
  const parsed: ParsedChord = {
    mod: false,
    alt: false,
    shift: false,
    key: key.length === 1 ? key.toLowerCase() : key,
  }
  for (const part of parts) {
    const name = MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase())
    if (!name) return null
    if (parsed[name.toLowerCase() as 'mod' | 'alt' | 'shift']) return null
    parsed[name.toLowerCase() as 'mod' | 'alt' | 'shift'] = true
  }
  return parsed
}

/** The one spelling of a chord, or `null` when it is not a chord. Two
 *  bindings are the same binding iff their canonical forms are equal, so every
 *  comparison in this module — matching, conflict detection, "is this still
 *  the default" — goes through here rather than comparing the raw strings. */
export function canonicalChord(chord: string): string | null {
  const parsed = parseChord(chord)
  if (!parsed) return null
  return formatParsed(parsed)
}

function formatParsed(parsed: ParsedChord): string {
  const out: string[] = []
  if (parsed.mod) out.push('Mod')
  if (parsed.alt) out.push('Alt')
  if (parsed.shift) out.push('Shift')
  out.push(parsed.key)
  return out.join('+')
}

/** True when a chord carries a modifier — the question that decides whether
 *  `shouldIgnoreShortcut` gets a say (see `matchesShortcut`). */
export function hasModifier(chord: string): boolean {
  const parsed = parseChord(chord)
  return parsed !== null && (parsed.mod || parsed.alt || parsed.shift)
}

/** The keystroke a listener saw, as a chord — or `null` when it is not one:
 *  a bare modifier press, which is how every chord begins. */
export function chordFromEvent(e: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
}): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  if (e.key === '') return null
  return formatParsed({
    // Cmd on a Mac, Ctrl elsewhere: one chord, folded here so nothing
    // downstream has to know which platform it is on.
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
  })
}

/**
 * Does this keystroke *press* this chord?
 *
 * All three modifiers are compared exactly, in both directions: a chord that
 * does not name Shift is not pressed while Shift is held. That is very
 * slightly stricter than the code this replaced — `Shift+←` used to move focus
 * left, since the old table only looked at `e.key` — and deliberately so: a
 * recording round-trips exactly, and two chords that differ only by a modifier
 * are genuinely two chords, which is what makes the conflict rule mean
 * anything.
 */
export function matchesChord(
  chord: string,
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
): boolean {
  const parsed = parseChord(chord)
  if (!parsed) return false
  if (parsed.mod !== (e.metaKey || e.ctrlKey)) return false
  if (parsed.alt !== e.altKey) return false
  if (parsed.shift !== e.shiftKey) return false
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return key === parsed.key
}

/** Which of an action's chords this keystroke pressed, or `null` for none. */
export function matchedChord(
  action: KeymapAction,
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
  keymap: Keymap = DEFAULT_KEYMAP,
): string | null {
  return (keymap[action] ?? DEFAULT_KEYMAP[action]).find((c) => matchesChord(c, e)) ?? null
}

/**
 * **The predicate every global listener asks.** True when this keystroke is
 * this action, and the app is in a state where the action may fire.
 *
 * The suppression rule is keyed on the chord, not on the call site, which is
 * the one thing this module adds to the behaviour it replaced. Before it, two
 * of the four listeners consulted `shouldIgnoreShortcut` (the bare-letter
 * ones) and two did not (the chord ones) — a split that was right, but written
 * as four independent decisions. Now: **a matched chord carrying no modifier
 * is subject to `shouldIgnoreShortcut`, wherever it is bound.** With the
 * shipped defaults that is byte-identical to before, since exactly the bare
 * ones are `h/j/k/l`, the arrows and `a`. It has to be a rule about the chord
 * because a user may now bind `create-task` to Cmd+Shift+N (which must fire
 * from inside a text field, as the palette does) or the palette to `p` (which
 * must not be typed into one).
 *
 * `shouldIgnoreShortcut`'s own first rule — "a modifier chord belongs to its
 * existing owner" — is why the check is skipped rather than softened for a
 * modifier chord: it answers `true` for every one of them by construction, and
 * weakening it is exactly what that file exists to prevent.
 */
export function matchesShortcut(
  action: KeymapAction,
  e: KeyboardEvent,
  keymap: Keymap = DEFAULT_KEYMAP,
): boolean {
  const chord = matchedChord(action, e, keymap)
  if (chord === null) return false
  if (!hasModifier(chord) && shouldIgnoreShortcut(e)) return false
  return true
}

/** How one key of a chord is drawn as a cap. Only the keys a keyboard draws
 *  as a symbol are translated; everything else is shown as the browser names
 *  it, so an unusual key is still readable rather than blank. */
const CAPS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ' ': 'Space',
  Escape: 'Esc',
  Mod: '⌘/Ctrl',
}

/**
 * A chord as the caps to draw, one string per key.
 *
 * `Mod` is drawn as `⌘/Ctrl` rather than resolved per platform, matching
 * `liveRecognition.ts`'s `LISTEN_CHORD` and for the reason given there: it is
 * read next to the control it describes, and being told which half is yours is
 * cheaper than mesa guessing wrong about a keyboard it cannot see.
 */
export function formatChord(chord: string): string[] {
  const parsed = parseChord(chord)
  if (!parsed) return [chord]
  const caps: string[] = []
  if (parsed.mod) caps.push(CAPS.Mod)
  if (parsed.alt) caps.push('Alt')
  if (parsed.shift) caps.push('Shift')
  caps.push(CAPS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key))
  return caps
}

/** A chord as one readable string, for a title attribute or a palette row. */
export function chordLabel(chord: string): string {
  return formatChord(chord).join('+')
}

/** Every chord two or more actions would both answer to. Empty is the only
 *  savable state — a keyboard is a partition, not a set of independent
 *  values. */
export function conflicts(keymap: Keymap): { chord: string; actions: KeymapAction[] }[] {
  const byChord = new Map<string, KeymapAction[]>()
  for (const { id } of ACTIONS) {
    for (const chord of keymap[id] ?? []) {
      const key = canonicalChord(chord)
      if (key === null) continue
      byChord.set(key, [...(byChord.get(key) ?? []), id])
    }
  }
  return [...byChord.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([chord, actions]) => ({ chord, actions }))
}

/**
 * The keymap in force, given what `GET /api/config/keymap` said — or the
 * shipped one before it has answered, and for any action whose stored value
 * mesa cannot use. Forgiving on the way in, exactly as the server's read path
 * is: one unusable entry costs that action its override and nothing else.
 */
export function resolveKeymap(config: ConfigKeymap | null | undefined): Keymap {
  const out = { ...DEFAULT_KEYMAP }
  for (const row of config?.actions ?? []) {
    const spec = ACTIONS.find((a) => a.id === row.action)
    if (!spec) continue
    const chords = row.value ?? []
    if (chords.length === 0 || chords.some((c) => canonicalChord(c) === null)) continue
    out[spec.id] = chords
  }
  return out
}

/** True when two chord lists are the same set of bindings, whatever their
 *  spelling or order. */
export function sameChords(a: string[], b: string[]): boolean {
  const canon = (list: string[]) => list.map(canonicalChord).sort().join(' ')
  return a.length === b.length && canon(a) === canon(b)
}
