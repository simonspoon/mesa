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
   * What the press does. `start` and `stop` are the two routes; `listen`,
   * `pause` and `resume` call nothing at all. `listen` exists purely to *be a
   * gesture*, the thing a browser weighs its autoplay policy against; the
   * other two are this browser's own participation, which is not the server's
   * business (see `pause` below).
   */
  action: 'start' | 'stop' | 'listen' | 'pause' | 'resume'
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
   * Stepping out of the conversation without ending it (mesa task 882), or
   * stepping back in — offered only while there is something to step out of:
   * the conversation is live, *this* browser has joined it, and no press is in
   * flight.
   *
   * It is deliberately a *third* control rather than a state of the primary
   * one. The primary toggle answers "is this conversation running", which
   * pause does not change: the session stays `live`, the agent stays spawned,
   * and the turns keep arriving. What stops is this browser's part in it — it
   * speaks nothing, hears nothing and is driven nowhere until Resume. Folding
   * that into the same button would put "quiet for a minute" and "destroy the
   * conversation" one mis-click apart.
   */
  pause: LiveButton | null
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
  paused: boolean,
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
      // Nothing to step out of yet, and a press mid-spawn would be pausing a
      // conversation that has not started saying anything.
      pause: null,
      overlay,
    }
  }
  if (pending === 'stop') {
    return {
      primary: { label: 'Ending…', action: 'start', disabled: true },
      secondary: null,
      pause: null,
      overlay,
    }
  }
  if (!isLive(session)) {
    return {
      primary: { label: 'Go live', action: 'start', disabled: false },
      secondary: null,
      pause: null,
      overlay,
    }
  }
  // Live, and this browser is in it: the one situation where stepping out for
  // a minute is a thing a person can want. A browser that has not joined is
  // already silent — pausing it would offer to stop something that is not
  // happening, and `Listen` is the press that belongs there.
  const pause: LiveButton | null = unlocked
    ? paused
      ? { label: 'Resume', action: 'resume', disabled: false }
      : { label: 'Pause', action: 'pause', disabled: false }
    : null
  const end: LiveButton = { label: 'End', action: 'stop', disabled: false }
  if (unlocked) return { primary: end, secondary: null, pause, overlay }
  return {
    primary: { label: 'Listen', action: 'listen', disabled: false },
    secondary: end,
    pause,
    overlay,
  }
}

/**
 * The line under the button: what the conversation is doing, in the words a
 * person would use. The error outranks everything — a page that says
 * "listening" while the last call failed is the one way this line can lie —
 * and a live session with no agent bound is called out, because it will listen
 * for ever and never answer.
 *
 * `paused` sits directly under the two not-live states and above everything
 * else the running conversation could say. It has to: while paused nothing is
 * spoken and the microphone is shut, so "Speaking…" and "Listening." are both
 * simply untrue, and even the no-agent warning is the wrong thing to lead with
 * when the reason nothing is happening is that the person asked for it. It
 * ranks *below* the not-live pair because those describe the session itself,
 * which pause never touches.
 */
export function liveStatusLine(
  session: LiveSession | null,
  speaking: boolean,
  error: string | null,
  paused: boolean,
): string {
  if (error !== null) return error
  if (session === null) return 'Not live. Press Go live to start a conversation.'
  if (!isLive(session)) {
    return 'That conversation has ended. Press Go live to start another.'
  }
  if (paused) {
    return 'Paused — not speaking, not listening. Press Resume to pick the conversation back up.'
  }
  if (speaking) return 'Speaking…'
  if (session.agent_id === null) {
    return 'Live, but no agent is attached — nothing will answer.'
  }
  return 'Listening. Dictate into the box below — a settled line sends itself.'
}
