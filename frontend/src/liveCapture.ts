import type { ConfigLive } from './types/ConfigLive'

/**
 * When the live conversation owns the keyboard, and when it stands aside
 * (mesa task 857).
 *
 * While a conversation is live, system dictation types into one capture box in
 * the header's conversation panel — wherever the app has navigated, since a
 * `navigate` turn is mesa's doing and the words that follow it are still meant
 * for mesa, not for whatever field the new page focused. That means the box
 * must *hold* focus, and holding focus is a fight this module referees: the
 * person deliberately clicking into a form must win, a page's autofocus firing
 * after mesa navigated must not.
 *
 * The typed box itself is sent by Enter alone (mesa task 977): a timer that
 * posts what the person is still typing sends half-thoughts, and the box is
 * the fallback surface a person is deliberately typing into — not dictating
 * through — so the deliberate keystroke is the boundary, exactly as it is
 * anywhere else text is typed.
 *
 * The focus fight stands down entirely while the browser is doing the
 * listening itself (`listening`, from `liveRecognition.ts` — mesa task 873).
 * The fight was only ever about *where the words land*, and a recognized
 * sentence lands in the conversation no matter what holds the keyboard; so
 * with the microphone open the box stops grabbing focus, and it is a plain
 * fallback the person may type in. This module keeps the rule because
 * recognition is not everywhere: an unsupported browser, or a refused
 * microphone, is exactly the old surface, unchanged.
 *
 * The one number this module still owns — `autoSendIdleMs` — is read by
 * `liveRecognition.ts` alone now: the silence boundary that flushes a
 * *transcribed* recording once the person stops talking for a beat. It moved
 * here rather than staying inline there because it is one wait answering "has
 * the person stopped" and was, until task 977, also the typed draft's own
 * idle deadline — kept in one place so the two surfaces could not drift apart
 * and disagree about how long a pause means.
 */

/** How long after a pointer/key gesture a focus loss still counts as deliberate. */
export const GESTURE_WINDOW_MS = 500

/**
 * How long a transcribed recording must sit in silence before it is sent, with
 * nothing configured — `core::config::DEFAULT_LIVE_AUTO_SEND_MS`, and the wait
 * mesa had before the setting existed (back when it also governed the typed
 * box, before mesa task 977). It is also the answer while the config has not
 * been read yet (or could not be), because a conversation must not stall
 * waiting on a settings file.
 */
export const AUTO_SEND_IDLE_MS = 2000

/**
 * The bounds a configured wait is held to, mirroring
 * `core::config::MIN_LIVE_AUTO_SEND_MS`/`MAX_LIVE_AUTO_SEND_MS` — the same
 * duplication `watchersDraft.ts` makes, so both ends name one rule.
 */
export const MIN_AUTO_SEND_IDLE_MS = 250
export const MAX_AUTO_SEND_IDLE_MS = 60_000

/**
 * The wait this conversation runs on: the configured value, else the one mesa
 * ships — and clamped, because the editor is not the only way into the config
 * file and a hand-edited `0` would post a word at a time rather than configure
 * anything. `null` (the config not read yet, or unreachable) is the built-in
 * wait, never a stall.
 */
export function autoSendIdleMs(live: ConfigLive | null): number {
  if (!live) return AUTO_SEND_IDLE_MS
  const configured = live.auto_send_ms ?? live.auto_send_ms_default
  return Math.min(
    MAX_AUTO_SEND_IDLE_MS,
    Math.max(MIN_AUTO_SEND_IDLE_MS, configured),
  )
}

/**
 * Whether a focus loss was the person's own doing: a pointerdown or keydown
 * (a click into a field, a Tab) landed just before it. Anything later — a
 * page's autofocus, a script — arrives with no gesture behind it.
 */
export function userTookFocus(lastGestureAt: number | null, now: number): boolean {
  return lastGestureAt !== null && now - lastGestureAt <= GESTURE_WINDOW_MS
}

/**
 * Whether the element focus moved to is one a person types into — the only
 * kind of focus loss that can mean "I am deliberately writing elsewhere".
 * Any click blurs the box (buttons, links and blank page all take the focus),
 * but dictation dying because the person pressed a button, or clicked on
 * nothing, would be a fight nobody picked — those losses are taken back.
 */
export function isEditableTarget(tag: string | null, contentEditable: boolean): boolean {
  if (contentEditable) return true
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * The moments capture may (re)take focus — all of them mesa's own actions.
 * `hub-press` is a click on the hub's own controls (the panel toggle, its
 * close button): the person pressing mesa's buttons is handing the keyboard
 * back to mesa, not taking it away.
 */
export type ReclaimCause =
  | 'went-live'
  | 'navigated'
  | 'hub-press'
  | 'focus-lost-no-gesture'

/**
 * Whether the capture box takes focus now. Never while the browser is
 * `listening` for itself: the whole point of the fight is that dictated words
 * must reach the conversation rather than the page, and recognized ones do
 * that with the keyboard anywhere. Never before this browser has both
 * a live session and a press behind it (`unlocked` — a browser that has not
 * joined must not grab the keyboard). While standing down — the person
 * deliberately took focus elsewhere — only mesa acting again (`went-live`,
 * `navigated`) re-arms capture; gestureless drift stays lost, because reclaiming
 * it would be exactly the fight standing down exists to concede.
 */
export function shouldReclaimFocus(input: {
  live: boolean
  unlocked: boolean
  standingDown: boolean
  listening: boolean
  cause: ReclaimCause
}): boolean {
  if (input.listening) return false
  if (!input.live || !input.unlocked) return false
  if (input.standingDown) return input.cause !== 'focus-lost-no-gesture'
  return true
}
