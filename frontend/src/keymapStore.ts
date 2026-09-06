import { useEffect, useSyncExternalStore } from 'react'
import { getKeymap } from './api'
import { DEFAULT_KEYMAP, resolveKeymap, type Keymap } from './keymap'
import type { ConfigKeymap } from './types/ConfigKeymap'

/**
 * The one place the page learns what the keyboard is bound to (mesa task
 * 1079).
 *
 * A module-level store rather than a context, because the four listeners that
 * read it are mounted in four different places — `App`'s palette hook and
 * spatial nav, `ProjectTasksPage`'s create-task hook, `LiveHub`'s listen chord
 * — and two of them are above where any provider `App` rendered would sit. A
 * store also answers the thing a provider would not: there must be exactly one
 * `GET /api/config/keymap` for the page however many listeners ask, since a
 * keymap is one fact about this install, not per-component state.
 *
 * Before the fetch resolves — and if it never does, on a server that refuses
 * the config routes — every reader sees `DEFAULT_KEYMAP`, so the app answers
 * to the shipped chords rather than to nothing.
 */

let current: Keymap = DEFAULT_KEYMAP
let started = false
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Publishes a keymap the Settings page just saved, so the listeners pick it
 *  up without a reload — the save's own response is the freshest answer there
 *  is, so refetching it would only be slower. */
export function publishKeymap(config: ConfigKeymap): void {
  current = resolveKeymap(config)
  emit()
}

/** Fetches the keymap once per page. Later calls are no-ops: the Settings
 *  page's own editor has its own `useFetch`, and its saves come back through
 *  `publishKeymap`. */
function load(): void {
  if (started) return
  started = true
  getKeymap().then(publishKeymap, () => {
    // A refused or unreadable config is not a reason to have no shortcuts —
    // the shipped keymap is already in force, so there is nothing to do.
  })
}

/** The keymap in force. Re-renders its caller when a save changes it. */
export function useKeymap(): Keymap {
  useEffect(load, [])
  return useSyncExternalStore(subscribe, () => current)
}
