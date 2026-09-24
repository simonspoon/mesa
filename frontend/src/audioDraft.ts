import type { ConfigAudio } from './types/ConfigAudio'
import type { TranscribeStatus } from './types/TranscribeStatus'

/**
 * Pure logic for the Settings page's engine selectors (mesa task 1391):
 * `audio.engine` (which engine the **server** runs speech through) and, via
 * the two engine helpers below, `listen.engine` in
 * [`listenDraft`](./listenDraft.ts). Hoisted out of the component so it is
 * unit-testable (CLAUDE.md: the frontend tests cover the pure modules).
 *
 * An engine is picked from a fixed list, so the draft holds the **effective**
 * engine — the configured one, else the built-in — and a save follows the
 * route's rule that `null` removes the key: picking the built-in sends
 * `null` rather than writing the default into the file. The daemon URL is
 * deliberately not edited here.
 */

/** The engines `PUT /api/config/audio` accepts, built-in first. */
export const AUDIO_ENGINES = ['legacy', 'naru-audio']

export type AudioDraft = { engine: string }

/** The engine in force: the configured one, else the built-in. */
function effective(configured: string | null, fallback: string): string {
  const trimmed = (configured ?? '').trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * The options to offer: the known engines, plus a configured value that is
 * not one of them (a hand edit) so the select shows the file rather than
 * silently rewriting a value nobody touched.
 */
export function engineChoices(configured: string | null, known: string[]): string[] {
  const trimmed = (configured ?? '').trim()
  if (trimmed === '' || known.includes(trimmed)) return known
  return [...known, trimmed]
}

/**
 * What to PUT for a drafted engine: `undefined` when it is already the one
 * in force (send no key), `null` when it is the built-in (remove the key),
 * else the engine itself.
 */
export function engineChange(
  configured: string | null,
  fallback: string,
  drafted: string,
): string | null | undefined {
  if (drafted === effective(configured, fallback)) return undefined
  return drafted === fallback ? null : drafted
}

/** The select as loaded: the engine in force. */
export function draftFrom(audio: ConfigAudio): AudioDraft {
  return { engine: effective(audio.engine, audio.engine_default) }
}

/** The engines to offer for `audio.engine`. */
export function options(audio: ConfigAudio): string[] {
  return engineChoices(audio.engine, AUDIO_ENGINES)
}

/** True when the select differs from what the server last reported. */
export function isDirty(audio: ConfigAudio, draft: AudioDraft): boolean {
  return engineChange(audio.engine, audio.engine_default, draft.engine) !== undefined
}

/** The subset to PUT: `engine` only, and only when it changed. */
export function changedAudio(
  audio: ConfigAudio,
  draft: AudioDraft,
): Record<string, string | null> {
  const engine = engineChange(audio.engine, audio.engine_default, draft.engine)
  return engine === undefined ? {} : { engine }
}

/**
 * The read-only probe line beside the selectors: the engine, its state in
 * words and, on `naru-audio`, the URL asked — then when the (cached) answer
 * was taken. The server's `message` is shown on its own line, verbatim.
 */
export function probeLine(status: TranscribeStatus): string {
  const where = status.url ? ` at ${status.url}` : ''
  const state = status.state.replace(/_/g, ' ')
  return `${status.engine}${where}: ${state} (checked ${status.checked_at})`
}
