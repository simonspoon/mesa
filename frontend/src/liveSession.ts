import type { LiveSession } from './types/LiveSession'

/**
 * What the Live page's controls say, and what the line under them reports
 * (mesa task 855).
 *
 * There is at most one live session, so this is a toggle over a single nullable
 * session rather than a list — but "no session at all", "a session that has
 * ended", "a session still starting" and "a session running in a browser that
 * has never had a press" are four different presses, and the label has to be
 * right in each. That is the kind of predicate this module exists to keep out
 * of the `.tsx`.
 */

/** A press that has been sent and not yet answered, or null when idle. */
export type LivePending = 'start' | 'stop' | null

/**
 * Whether a conversation is running. An ended session is *kept* — its
 * transcript is still on screen — so the row's presence says nothing on its
 * own; only its status does.
 */
export function isLive(session: LiveSession | null): boolean {
  return session !== null && session.status === 'live'
}

/** One of the page's controls, in whichever of its states applies. */
export interface LiveButton {
  label: string
  /**
   * What the press does. `start` and `stop` are the two routes; `listen` calls
   * nothing at all — it exists purely to *be a gesture*, the thing a browser
   * weighs its autoplay policy against.
   */
  action: 'start' | 'stop' | 'listen'
  /** A press already in flight: the same press again would start a second one. */
  disabled: boolean
}

/**
 * What the page offers: the button that leads, and the one beside it when
 * there are two things worth doing at once.
 */
export interface LiveControls {
  primary: LiveButton
  secondary: LiveButton | null
  /**
   * Whether the header offers the conversation-popup toggle at all: there is a
   * session — running, or ended with a transcript still worth reading. With no
   * session there is nothing to show, and the button would open an empty box.
   */
  overlay: boolean
}

/**
 * `unlocked` is whether *this browser* has had a press since the page loaded —
 * whether it has audio, not whether the conversation is running.
 *
 * The two come apart in a way that used to be a dead end: a session started
 * from `mesa live start`, or a page reloaded mid-conversation, is live with no
 * gesture behind it, and the only control on offer was `End`. So mesa talked
 * and nobody heard a word, and the one press available destroyed the
 * conversation. `Listen` is that missing gesture — it joins what is already
 * running, and `End` moves aside to make room for it rather than being taken
 * away.
 */
export function liveControls(
  session: LiveSession | null,
  pending: LivePending,
  unlocked: boolean,
): LiveControls {
  // The popup is about the transcript, not the press: it stays offered for as
  // long as there is a session to read, in-flight presses included.
  const overlay = session !== null
  // The press in flight decides the label, not the session: starting takes a
  // spawn, so between the click and the session landing the button would
  // otherwise still read "Go live" and invite a second one.
  if (pending === 'start') {
    return {
      primary: { label: 'Going live…', action: 'stop', disabled: true },
      secondary: null,
      overlay,
    }
  }
  if (pending === 'stop') {
    return {
      primary: { label: 'Ending…', action: 'start', disabled: true },
      secondary: null,
      overlay,
    }
  }
  if (!isLive(session)) {
    return {
      primary: { label: 'Go live', action: 'start', disabled: false },
      secondary: null,
      overlay,
    }
  }
  const end: LiveButton = { label: 'End', action: 'stop', disabled: false }
  if (unlocked) return { primary: end, secondary: null, overlay }
  return {
    primary: { label: 'Listen', action: 'listen', disabled: false },
    secondary: end,
    overlay,
  }
}

/**
 * The line under the button: what the conversation is doing, in the words a
 * person would use. The error outranks everything — a page that says
 * "listening" while the last call failed is the one way this line can lie —
 * and a live session with no agent bound is called out, because it will listen
 * for ever and never answer.
 */
export function liveStatusLine(
  session: LiveSession | null,
  speaking: boolean,
  error: string | null,
): string {
  if (error !== null) return error
  if (session === null) return 'Not live. Press Go live to start a conversation.'
  if (!isLive(session)) {
    return 'That conversation has ended. Press Go live to start another.'
  }
  if (speaking) return 'Speaking…'
  if (session.agent_id === null) {
    return 'Live, but no agent is attached — nothing will answer.'
  }
  return 'Listening. Dictate into the box below — a settled line sends itself.'
}
