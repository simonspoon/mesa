/**
 * What the header band shows about a live conversation (mesa task 874).
 *
 * The panel is shut for most of a conversation — that is the point of a
 * hands-free surface — so the header band is the only place either side of the
 * conversation is visible. Until now it said one thing: mesa is speaking. The
 * other half was invisible, and a person dictating into a page that shows
 * nothing has no way to tell "heard you" from "the microphone never opened".
 *
 * So the indicator is one single answer rather than a flag — the band shows
 * one thing at a time — and the order they are ranked in is the whole
 * decision:
 *
 * - **mesa speaking outranks everything.** While she talks the microphone is
 *   deliberately shut (`shouldListen`), so anything the band said about hearing
 *   the person would be describing a microphone that is not open.
 * - **Paused comes next** (mesa task 882) — in practice it is the top state,
 *   since pausing silences whatever was sounding, and it is written below
 *   speaking only so that a tail of audio still shows as audio rather than as
 *   a lie. It outranks both of the states under it because a paused page is
 *   neither hearing nor listening: the microphone is shut and nothing is being
 *   taken in. A draft left sitting in the box from before the pause must not
 *   make the band claim she is still being heard.
 * - **Being heard outranks being listened to.** Words arriving — an interim
 *   result from the recognizer, or a draft in the capture box — is the stronger
 *   news, and it is the one the person is waiting for.
 * - **Working comes under being heard and over listening** (mesa task 894).
 *   Between taking an utterance and speaking again the agent may be thinking,
 *   reading files, running commands or waiting on a subagent, and a band that
 *   said nothing about it looked exactly like a page that never heard the
 *   person at all — "she is working on it" and "you were not heard" are the
 *   two readings this state exists to tell apart. It sits under hearing
 *   because words arriving from the person is still the stronger news, and
 *   over listening because listening is the resting state and this is not
 *   rest. Its input is the session's own `working_since`, so it stays lit for
 *   the whole span — including the stretch after "one moment, let me look",
 *   which is exactly where a spinner tied to speech goes dark.
 * - **Listening is the resting state**, shown only where the microphone really
 *   is the way in (`recognizesSpeech`). A browser that types into the box gets
 *   no resting indicator: there is nothing ambient to report, and a permanent
 *   glyph that means "a text box exists" is noise.
 *
 * `interim` and `draft` are both read because they are the same fact reaching
 * the page by its two routes — recognized speech and dictation typed into the
 * fallback box — and the band answers "mesa can tell you are talking", not
 * "which input path you used".
 */

/** What the band is showing, or `null` for a band with nothing to say. */
export type LiveIndicator = 'speaking' | 'paused' | 'hearing' | 'working' | 'listening'

export function headerIndicator(input: {
  live: boolean
  /** This browser has had its press — the hub's `unlocked`. */
  joined: boolean
  /** mesa's own audio is sounding. */
  speaking: boolean
  /** The microphone is this browser's way in (`recognizesSpeech`). */
  recognizes: boolean
  /** What the engine is still guessing at, never yet sent. */
  interim: string
  /** What is sitting in the capture box. */
  draft: string
  /** The person stepped out of the conversation without ending it. */
  paused: boolean
  /** The agent has taken an utterance and not gone back to waiting on the
   *  person — the session's `working_since` (mesa task 894). */
  working: boolean
}): LiveIndicator | null {
  if (input.speaking) return 'speaking'
  if (!input.live || !input.joined) return null
  if (input.paused) return 'paused'
  if (input.interim.trim() !== '' || input.draft.trim() !== '') return 'hearing'
  // Reported whether or not the microphone is this browser's way in: unlike
  // listening, there *is* something ambient to report — someone is doing work
  // — and a person typing into the fallback box needs that answer most.
  if (input.working) return 'working'
  return input.recognizes ? 'listening' : null
}

/**
 * The indicator's accessible name. The band is a `role="status"` with no text
 * of its own — five bars are the whole of it — so this line is the only thing a
 * screen reader has, and each state has to say who is talking rather than that
 * something is animating.
 */
export function indicatorLabel(state: LiveIndicator): string {
  if (state === 'speaking') return 'mesa is speaking'
  if (state === 'paused') return 'mesa is paused'
  if (state === 'hearing') return 'mesa is hearing you'
  if (state === 'working') return 'mesa is working on it'
  return 'mesa is listening'
}
