/**
 * Voice activity detection: a pure state machine over frame levels (mesa task
 * 956).
 *
 * The browser's `SpeechRecognition` used to decide, on its own, where one
 * sentence ended and the next began — LiveHub's held-recording rules
 * (`heldWith`, `shouldFlushSilence`, `heldFlush`) are built on top of that
 * boundary. Replacing the recognizer with page-side capture posted to
 * `POST /api/live/transcribe` means mesa now has to find that boundary
 * itself, over nothing but a level per audio block. Three decisions:
 *
 * - **An utterance ends at a breath**, matching what the recognizer used to
 *   settle on — the whole point is that everything downstream of "here is a
 *   segment of speech" carries on exactly as before.
 * - **Hysteresis, not one threshold.** A voice trailing off crosses a single
 *   level over and over on its way down; two thresholds (`onsetRms` to start,
 *   a lower `releaseRms` to keep going) mean the tail of a word does not
 *   chatter the detector on and off.
 * - **A maximum segment.** A room with a fan or an HVAC vent in it never
 *   falls quiet, and a segment that never ends is a turn that never arrives —
 *   and, eventually, a WAV over the transcribe route's 25 MB cap. Past
 *   `maxSegmentMs` the utterance is cut and a new one begins immediately,
 *   because the person is still talking.
 */

export interface VadConfig {
  /** Level that starts an utterance. */
  onsetRms: number
  /** Level that keeps one going — lower than onset, the hysteresis. */
  releaseRms: number
  /** Quiet this long ends the utterance. */
  hangoverMs: number
  /** An utterance shorter than this is a cough, a door, a chair; discarded. */
  minSpeechMs: number
  /** No utterance runs longer than this; it is cut and a new one begins. */
  maxSegmentMs: number
}

export const DEFAULT_VAD: VadConfig = {
  onsetRms: 0.02,
  releaseRms: 0.012,
  hangoverMs: 700,
  minSpeechMs: 200,
  maxSegmentMs: 20000,
}

/**
 * How much audio before the onset rides along, so the first consonant is not
 * clipped — the caller (holding the rolling frame buffer) is what actually
 * applies this; the state machine itself only reports where speech began.
 */
export const PRE_ROLL_MS = 300

export interface VadState {
  startedAt: number | null
  lastLoudAt: number
}

export function initialVad(): VadState {
  return { startedAt: null, lastLoudAt: 0 }
}

export interface VadStep {
  state: VadState
  /** Audible right now — what drives the level meter and LiveHub's "heard" clock. */
  loud: boolean
  /** An utterance just ended and is worth transcribing, or null. */
  ended: { startedAt: number; endedAt: number } | null
}

/**
 * One frame in, one decision out. Never mutates `state` — callers hold the
 * previous `VadState` across frames the same way `liveRecognition.ts`'s
 * callers hold theirs.
 *
 * `endedAt` is `lastLoudAt`, not the frame's own `at`: the hangover is how we
 * *know* speech has ended, not part of what was said. The caller gets the
 * trailing quiet back for free from block-boundary slicing (`liveAudio.ts`),
 * and adds its own leading room via `PRE_ROLL_MS`.
 */
export function vadStep(
  state: VadState,
  frame: { rms: number; at: number },
  config: VadConfig = DEFAULT_VAD,
): VadStep {
  const speaking = state.startedAt !== null
  const loud = frame.rms >= (speaking ? config.releaseRms : config.onsetRms)

  if (!speaking) {
    if (!loud) {
      return { state, loud, ended: null }
    }
    return { state: { startedAt: frame.at, lastLoudAt: frame.at }, loud, ended: null }
  }

  const startedAt = state.startedAt as number

  if (loud) {
    const lastLoudAt = frame.at
    if (frame.at - startedAt >= config.maxSegmentMs) {
      // Still talking, but this segment is as long as it gets — cut it and
      // start the next one right where this one left off.
      return {
        state: { startedAt: frame.at, lastLoudAt },
        loud,
        ended: { startedAt, endedAt: frame.at },
      }
    }
    return { state: { startedAt, lastLoudAt }, loud, ended: null }
  }

  if (frame.at - state.lastLoudAt >= config.hangoverMs) {
    const longEnough = state.lastLoudAt - startedAt >= config.minSpeechMs
    return {
      state: initialVad(),
      loud,
      ended: longEnough ? { startedAt, endedAt: state.lastLoudAt } : null,
    }
  }

  // Still inside the hangover: not loud this frame, but not yet quiet long
  // enough to call it over.
  return { state, loud, ended: null }
}

/**
 * The utterance in progress right now, if there is one worth transcribing —
 * for a caller whose capture is being torn down *out from under* the VAD
 * rather than ending it on the VAD's own terms (mesa task 961).
 *
 * Four of the five reasons `shouldListen` goes false (pause, mute, the
 * listen switch, ending the conversation) are the person's own act, and the
 * sentence they cut off by it is rightly dropped. The fifth — mesa starting
 * to speak — is not: the person may still have been mid-sentence when her
 * audio began, and that sentence was heard before it, so it belongs in the
 * recording. `vadStep` never gets to report it as `ended`, because nothing
 * fed it another frame; `vadCut` answers the same "is this worth sending"
 * question `vadStep`'s hangover branch already does, from whatever state the
 * VAD was actually left in.
 *
 * Same too-short rule as the hangover branch: no utterance in progress, or
 * one shorter than `minSpeechMs`, is null. Otherwise `endedAt` is
 * `lastLoudAt`, not "now" — for the same reason `vadStep`'s doc comment
 * gives: the quiet is how we know speech ended, not part of what was said,
 * and cutting at "now" would drag in silence the person never spoke into.
 */
export function vadCut(
  state: VadState,
  config: VadConfig = DEFAULT_VAD,
): { startedAt: number; endedAt: number } | null {
  if (state.startedAt === null) {
    return null
  }
  if (state.lastLoudAt - state.startedAt < config.minSpeechMs) {
    return null
  }
  return { startedAt: state.startedAt, endedAt: state.lastLoudAt }
}
