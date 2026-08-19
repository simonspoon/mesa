/**
 * What the header band shows about a live conversation (mesa task 874).
 *
 * The panel is shut for most of a conversation — that is the point of a
 * hands-free surface — so the header band is the only place either side of the
 * conversation is visible. Until now it said one thing: mesa is speaking. The
 * other half was invisible, and a person dictating into a page that shows
 * nothing has no way to tell "heard you" from "the microphone never opened".
 *
 * So the indicator is one three-state answer rather than a flag, and the order
 * of the three is the whole decision:
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
export type LiveIndicator = 'speaking' | 'paused' | 'hearing' | 'listening'

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
}): LiveIndicator | null {
  if (input.speaking) return 'speaking'
  if (!input.live || !input.joined) return null
  if (input.paused) return 'paused'
  if (input.interim.trim() !== '' || input.draft.trim() !== '') return 'hearing'
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
  return 'mesa is listening'
}
