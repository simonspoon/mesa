/**
 * The browser's own ears (mesa task 873).
 *
 * Until now the live conversation heard the person only through *system*
 * dictation typing into the capture box: the box had to hold the keyboard, a
 * click elsewhere broke it, and a settled draft was sent on a timer. This
 * module is the other way in — the Web Speech API, opened in the page, posting
 * each **final** result as a `user` turn the moment the engine settles it.
 *
 * Three things about the shape of it are load-bearing, and all three are
 * decisions rather than plumbing, which is why they live here and not in
 * `LiveHub.tsx`:
 *
 * - **Only a final result is an utterance.** An interim result is the engine
 *   thinking out loud — it is shown as a preview and never sent, because a
 *   sentence posted mid-guess is a sentence the person never said.
 * - **Recognition ends on its own, constantly.** Chrome stops after roughly a
 *   minute, and on a long enough silence; the engine reports that as an
 *   ordinary end, not an error. So "should it be running" is asked again on
 *   every end (`shouldListen`) rather than assumed from the last start, and the
 *   answer is what restarts it.
 * - **mesa stops listening while she speaks.** The microphone would otherwise
 *   hear her own reply out of the speakers and answer it — a conversation with
 *   itself. `speaking` is therefore a gate on listening, not a separate mute.
 *
 * The audio never leaves the page: recognition is the browser's, mesa still
 * ships no speech-to-text and no route accepts an audio body (`docs/live.md`,
 * *What is deliberately absent*).
 */

/** One reading of what was heard. The API offers alternatives; mesa takes the first. */
export type RecognitionAlternative = { transcript: string }

/**
 * One result: a stretch of speech the engine is either still guessing at
 * (`isFinal: false`) or has settled on.
 */
export type RecognitionResult = {
  isFinal: boolean
  0: RecognitionAlternative | undefined
}

/** The recognizer, as much of it as mesa touches. */
export type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void)
    | null
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/**
 * The recognizer this browser offers, under either of its two names, or `null`
 * where there is none (Firefox today). Takes the global rather than reading
 * `window` itself, so the answer is testable and so an unsupported browser is
 * one value the hub carries rather than a `typeof` check scattered through it.
 */
export function recognitionCtor(
  scope: Record<string, unknown> | null | undefined,
): SpeechRecognitionCtor | null {
  if (!scope) return null
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition
  return typeof ctor === 'function' ? (ctor as SpeechRecognitionCtor) : null
}

/**
 * Whether recognition is this browser's **way in** — the steady answer, held
 * for the whole conversation rather than for the seconds the engine happens to
 * be running.
 *
 * `joined` is the hub's `unlocked`: the press that unlocks audio is also the
 * gesture that may open a microphone, and a browser watching a conversation it
 * never joined has no business listening to the room.
 *
 * This, and not `shouldListen`, is what the capture box's two rules stand down
 * for (`liveCapture.ts`) and what the composer's hint reports. Those are
 * questions about *how the person is talking to mesa*, and the answer must not
 * flicker every time mesa speaks — a focus fight that re-arms itself for the
 * length of each reply is the same fight, fought at random.
 */
export function recognizesSpeech(input: {
  live: boolean
  joined: boolean
  supported: boolean
  blocked: boolean
}): boolean {
  return input.live && input.joined && input.supported && !input.blocked
}

/**
 * Whether the microphone should be open *right now* — asked on every change of
 * the inputs, and again every time the engine ends by itself, which is what
 * makes restarting a re-answer rather than a retry loop.
 *
 * The way in, minus the seconds mesa is talking: the microphone would
 * otherwise hear her own reply out of the speakers and answer it.
 */
export function shouldListen(input: {
  live: boolean
  joined: boolean
  supported: boolean
  blocked: boolean
  speaking: boolean
}): boolean {
  return recognizesSpeech(input) && !input.speaking
}

/**
 * Whether an error the engine reported is the end of listening for this page,
 * or one of the ordinary interruptions it recovers from.
 *
 * Only a refusal is permanent: the person said no to the microphone, or the
 * browser's policy did. `no-speech`, `aborted`, `network` and `audio-capture`
 * all arrive in normal use — a silent minute reports `no-speech` — and each is
 * followed by an end that `shouldListen` answers on its own merits. Treating
 * those as fatal would silence recognition on the first quiet stretch; treating
 * a refusal as transient would reopen a permission prompt for ever.
 */
export function isBlockingError(code: string): boolean {
  return code === 'not-allowed' || code === 'service-not-allowed'
}

/**
 * The final text and the interim preview in one event, plus how far the
 * results list has now been consumed.
 *
 * `from` is where to start reading: the event's own `resultIndex` (where the
 * engine's list changed), never behind `settledThrough` from the last event.
 * That floor is what stops a duplicate turn — the reported index is the
 * engine's promise that everything before it is unchanged, and an engine that
 * reports a lower one (Chromium on Android has) would otherwise re-post every
 * sentence before it. An utterance is an irreversible write and an answer the
 * agent gives twice, so the caller keeps its own high-water mark rather than
 * trusting the promise.
 */
export function readResults(
  from: number,
  results: ArrayLike<RecognitionResult>,
): { final: string; interim: string; settledThrough: number } {
  const start = Math.max(0, from)
  let final = ''
  let interim = ''
  let settledThrough = start
  for (let i = start; i < results.length; i += 1) {
    const result = results[i]
    if (!result) continue
    const text = result[0]?.transcript ?? ''
    if (result.isFinal) {
      final += text
      settledThrough = i + 1
    } else {
      interim += text
    }
  }
  return { final: final.trim(), interim: interim.trim(), settledThrough }
}

/**
 * The utterance a final result becomes, or `null` when there is nothing to
 * say. The engine settles on empty strings routinely (a cough, a door), and a
 * blank `user` turn is one the server would refuse and the agent would have to
 * read past.
 */
export function utteranceFrom(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * What the composer says about listening — one line, always present, because
 * "is it hearing me" is the only question a hands-free surface has to answer
 * without being asked. The four states are the four honest ones: this browser
 * cannot, the microphone was refused, it is listening, or the conversation has
 * not started yet.
 *
 * `listening` here is `recognizesSpeech`, not whether the engine is running
 * this second: a line that says "listening" and then "go live" and then
 * "listening" again on every reply is answering the question wrong on a
 * several-second cycle. That mesa pauses while she speaks is said *in* the
 * listening line, where it belongs.
 */
export function captureHint(input: {
  supported: boolean
  blocked: boolean
  listening: boolean
}): string {
  if (!input.supported) {
    return 'This browser cannot listen for itself. Type here, or use your system dictation — a settled line is sent on its own.'
  }
  if (input.blocked) {
    return 'The microphone was refused, so mesa is not listening. Type here, or use your system dictation — a settled line is sent on its own.'
  }
  if (input.listening) {
    return 'Listening — each finished sentence is sent as you say it, and mesa stops listening while she is speaking. You can still type here.'
  }
  return 'Go live and mesa listens through this browser. You can also type here, or use your system dictation.'
}
