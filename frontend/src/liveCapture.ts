import type { ConfigLive } from './types/ConfigLive'

/**
 * When the live conversation owns the keyboard, and when it stands aside
 * (mesa task 857).
 *
 * While a conversation is live, system dictation types into one capture box in
 * the header's conversation popup — wherever the app has navigated, since a
 * `navigate` turn is mesa's doing and the words that follow it are still meant
 * for mesa, not for whatever field the new page focused. That means the box
 * must *hold* focus, and holding focus is a fight this module referees: the
 * person deliberately clicking into a form must win, a page's autofocus firing
 * after mesa navigated must not.
 *
 * The other half is when a dictated line is *sent*. Dictation never presses
 * Enter, so waiting for one means the conversation stalls until the person
 * touches the keyboard — the opposite of hands-free. mesa decides instead: a
 * draft nobody has edited for a beat is a finished thought.
 *
 * Both halves stand down entirely while the browser is doing the listening
 * itself (`listening`, from `liveRecognition.ts` — mesa task 873). The fight
 * was only ever about *where the words land*, and a recognized sentence lands
 * in the conversation no matter what holds the keyboard; so with the
 * microphone open the box stops grabbing focus and stops sending on a timer,
 * and it is a plain fallback the person may type in. This module keeps both
 * rules because recognition is not everywhere: an unsupported browser, or a
 * refused microphone, is exactly the old surface, unchanged.
 */

/** How long after a pointer/key gesture a focus loss still counts as deliberate. */
export const GESTURE_WINDOW_MS = 500

/**
 * How long a non-empty draft must sit untouched before it is sent, with nothing
 * configured — `core::config::DEFAULT_LIVE_AUTO_SEND_MS`, and the wait mesa had
 * before the setting existed. It is also the answer while the config has not
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
 * `hub-press` is a click on the hub's own controls (the popup toggle, its
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

/**
 * Whether an untouched draft is ready to send: non-blank, idle past the
 * threshold, not mid-IME-composition — sending half-converted text would
 * ship a word the person never said — and not while the browser is
 * `listening`, where the engine's own final results are what get sent and a
 * timer firing on top of them would post the same sentence twice.
 *
 * The threshold is passed in rather than read from the constant: how long a
 * pause means "finished" is the person's own cadence, so it is a setting
 * (`live.auto-send-ms`, mesa task 886) and this predicate must answer for
 * whatever they chose.
 */
export function shouldAutoSend(
  draft: string,
  idleMs: number,
  composing: boolean,
  listening: boolean,
  idleThresholdMs: number,
): boolean {
  if (listening) return false
  return !composing && draft.trim() !== '' && idleMs >= idleThresholdMs
}
