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
 */

/** How long after a pointer/key gesture a focus loss still counts as deliberate. */
export const GESTURE_WINDOW_MS = 500

/** How long a non-empty draft must sit untouched before it is sent. */
export const AUTO_SEND_IDLE_MS = 2000

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
 * Whether the capture box takes focus now. Never before this browser has both
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
  cause: ReclaimCause
}): boolean {
  if (!input.live || !input.unlocked) return false
  if (input.standingDown) return input.cause !== 'focus-lost-no-gesture'
  return true
}

/**
 * Whether an untouched draft is ready to send: non-blank, idle past the
 * threshold, and not mid-IME-composition — sending half-converted text would
 * ship a word the person never said.
 */
export function shouldAutoSend(draft: string, idleMs: number, composing: boolean): boolean {
  return !composing && draft.trim() !== '' && idleMs >= AUTO_SEND_IDLE_MS
}
