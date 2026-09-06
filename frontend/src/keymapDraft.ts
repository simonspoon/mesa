import {
  ACTIONS,
  DEFAULT_KEYMAP,
  canonicalChord,
  conflicts,
  resolveKeymap,
  sameChords,
  type Keymap,
  type KeymapAction,
} from './keymap'
import type { ConfigKeymap } from './types/ConfigKeymap'

/**
 * Pure draft logic for the Settings page's Keyboard shortcuts editor, hoisted
 * out of the component so it is unit-testable (see CLAUDE.md: the frontend
 * tests cover the pure modules, never a rendered tree).
 *
 * The same two things [`watchersDraft`](./watchersDraft.ts) models, for a table
 * of bindings rather than one number:
 *
 * - **Absent means "the chords mesa ships"**, exactly as a blank command box
 *   means "the built-in template". An action drafted back to its defaults is
 *   PUT as `null`, which removes the key rather than writing the default in.
 * - **The draft is the whole keymap, not the overrides.** A conflict is a fact
 *   about every binding at once — including the six the user never touched —
 *   so the editor has to hold all of them to answer "may this be saved".
 */

/** Every action's chords as drafted. */
export type KeymapDraft = Keymap

/** The editable keymap as loaded: the overrides the server reported, over the
 *  chords mesa ships. */
export function draftFrom(config: ConfigKeymap): KeymapDraft {
  return resolveKeymap(config)
}

/** Binds `action` to the one chord just recorded, replacing whatever it held.
 *  A recording replaces rather than appends: the row shows one chord after a
 *  change, and "add a second binding" is not a thing the editor offers. */
export function withChord(
  draft: KeymapDraft,
  action: KeymapAction,
  chord: string,
): KeymapDraft {
  return { ...draft, [action]: [chord] }
}

/** Puts one action back to the chords mesa ships. */
export function withReset(draft: KeymapDraft, action: KeymapAction): KeymapDraft {
  return { ...draft, [action]: DEFAULT_KEYMAP[action] }
}

/** Puts every action back — the "Reset all" button. */
export function resetAll(): KeymapDraft {
  return { ...DEFAULT_KEYMAP }
}

/** True when `action` is drafted to something other than what mesa ships. */
export function isOverridden(draft: KeymapDraft, action: KeymapAction): boolean {
  return !sameChords(draft[action] ?? [], DEFAULT_KEYMAP[action])
}

/** True when anything drafted differs from what the server last reported. */
export function isDirty(config: ConfigKeymap, draft: KeymapDraft): boolean {
  const stored = resolveKeymap(config)
  return ACTIONS.some(({ id }) => !sameChords(draft[id] ?? [], stored[id]))
}

/** True when nothing drafted would be rejected by the server: every chord is
 *  one, every action has at least one, and no chord is bound twice. */
export function isSavable(draft: KeymapDraft): boolean {
  const wellFormed = ACTIONS.every(({ id }) => {
    const chords = draft[id] ?? []
    return chords.length > 0 && chords.every((c) => canonicalChord(c) !== null)
  })
  return wellFormed && conflicts(draft).length === 0
}

/** The actions this row collides with, for the inline complaint. Empty is the
 *  savable state. */
export function conflictingActions(
  draft: KeymapDraft,
  action: KeymapAction,
): KeymapAction[] {
  return conflicts(draft)
    .filter(({ actions }) => actions.includes(action))
    .flatMap(({ actions }) => actions.filter((a) => a !== action))
}

/**
 * The subset to PUT: an action only when it actually changed, so the API's
 * "only the actions present are touched" rule keeps two editors from
 * clobbering each other. An action drafted back to the shipped chords sends
 * `null` — the server's "remove this key", which is what makes a default an
 * absence rather than a stored copy of itself.
 */
export function changedKeymap(
  config: ConfigKeymap,
  draft: KeymapDraft,
): Record<string, string[] | null> {
  if (!isDirty(config, draft) || !isSavable(draft)) return {}
  const stored = resolveKeymap(config)
  const out: Record<string, string[] | null> = {}
  for (const { id } of ACTIONS) {
    const chords = draft[id] ?? []
    if (sameChords(chords, stored[id])) continue
    out[id] = sameChords(chords, DEFAULT_KEYMAP[id]) ? null : chords
  }
  return out
}
