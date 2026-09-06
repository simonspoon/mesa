import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYMAP } from './keymap'
import {
  changedKeymap,
  conflictingActions,
  draftFrom,
  isDirty,
  isOverridden,
  isSavable,
  resetAll,
  withChord,
  withReset,
} from './keymapDraft'
import type { ConfigKeymap } from './types/ConfigKeymap'

/** A `GET /api/config/keymap` answer with the given overrides and nothing
 *  else — every action always ships a row, as the server's does. */
function config(overrides: Record<string, string[]> = {}): ConfigKeymap {
  return {
    actions: Object.entries(DEFAULT_KEYMAP).map(([action, def]) => ({
      action,
      value: overrides[action] ?? null,
      default: def,
    })),
  }
}

const DEFAULTED = config()
const SET = config({ 'create-task': ['n'] })

describe('draftFrom', () => {
  it('renders an unconfigured keymap as the chords mesa ships', () => {
    expect(draftFrom(DEFAULTED)).toEqual(DEFAULT_KEYMAP)
  })

  it('renders a configured action as its override, the rest shipped', () => {
    const draft = draftFrom(SET)
    expect(draft['create-task']).toEqual(['n'])
    expect(draft['focus-left']).toEqual(['h', 'ArrowLeft'])
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
  })
})

describe('editing a row', () => {
  it('replaces the whole list, so a change is one chord', () => {
    const draft = withChord(draftFrom(DEFAULTED), 'focus-left', 'Alt+ArrowLeft')
    expect(draft['focus-left']).toEqual(['Alt+ArrowLeft'])
    expect(isOverridden(draft, 'focus-left')).toBe(true)
    expect(isDirty(DEFAULTED, draft)).toBe(true)
  })

  it('resets one row without touching the others', () => {
    const edited = withChord(withChord(draftFrom(DEFAULTED), 'focus-up', 'z'), 'create-task', 'n')
    const draft = withReset(edited, 'focus-up')
    expect(draft['focus-up']).toEqual(['k', 'ArrowUp'])
    expect(draft['create-task']).toEqual(['n'])
  })

  it('resets everything at once', () => {
    expect(resetAll()).toEqual(DEFAULT_KEYMAP)
    expect(isDirty(DEFAULTED, resetAll())).toBe(false)
    // Against a *configured* server state, "reset all" is a real change.
    expect(isDirty(SET, resetAll())).toBe(true)
  })

  it('sees no change in a re-spelling of the same chord', () => {
    const draft = withChord(draftFrom(SET), 'create-task', 'N')
    expect(isDirty(SET, draft)).toBe(false)
  })
})

describe('isSavable', () => {
  it('accepts the shipped keymap', () => {
    expect(isSavable(draftFrom(DEFAULTED))).toBe(true)
  })

  it('refuses a chord two actions would share, naming the other one', () => {
    const draft = withChord(draftFrom(DEFAULTED), 'create-task', 'h')
    expect(isSavable(draft)).toBe(false)
    expect(conflictingActions(draft, 'create-task')).toEqual(['focus-left'])
    expect(conflictingActions(draft, 'focus-left')).toEqual(['create-task'])
    expect(conflictingActions(draft, 'focus-up')).toEqual([])
  })

  it('refuses a clash the user cannot see coming, against an action they never touched', () => {
    // `l` is the spatial nav's right, not the listen chord — which is why the
    // draft has to hold every binding rather than only the overrides.
    const draft = withChord(draftFrom(DEFAULTED), 'live-listen', 'l')
    expect(isSavable(draft)).toBe(false)
  })

  it('refuses a chord mesa cannot parse, and an action bound to nothing', () => {
    expect(isSavable({ ...DEFAULT_KEYMAP, 'create-task': ['Hyper+n'] })).toBe(false)
    expect(isSavable({ ...DEFAULT_KEYMAP, 'create-task': [] })).toBe(false)
  })
})

describe('changedKeymap', () => {
  it('sends only what changed', () => {
    const draft = withChord(draftFrom(DEFAULTED), 'create-task', 'n')
    expect(changedKeymap(DEFAULTED, draft)).toEqual({ 'create-task': ['n'] })
  })

  it('sends null for an action drafted back to the shipped chords', () => {
    // A default is an absence, never a stored copy of itself.
    const draft = withReset(draftFrom(SET), 'create-task')
    expect(changedKeymap(SET, draft)).toEqual({ 'create-task': null })
  })

  it('sends nothing at all when the draft is pristine or unsavable', () => {
    expect(changedKeymap(DEFAULTED, draftFrom(DEFAULTED))).toEqual({})
    expect(changedKeymap(DEFAULTED, withChord(draftFrom(DEFAULTED), 'create-task', 'h'))).toEqual({})
  })

  it('sends every changed action in one PUT', () => {
    const draft = withChord(withChord(draftFrom(SET), 'focus-up', 'z'), 'create-task', 'q')
    expect(changedKeymap(SET, draft)).toEqual({ 'focus-up': ['z'], 'create-task': ['q'] })
  })
})
