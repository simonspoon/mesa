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
  /**
   * The optional argument is the microphone (mesa task 884): a live audio
   * `MediaStreamTrack` the engine listens to instead of whatever the operating
   * system calls default. Omitting it is the call mesa has always made, and is
   * still what every browser understands — the argument is Chromium's, and one
   * that ignores it throws rather than silently listening to the wrong device
   * (`liveDevices.ts`).
   */
  start(track?: MediaStreamTrack): void
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
 * `paused` belongs here rather than in `shouldListen` for the same reason
 * `joined` does, and the opposite one from `speaking`: pausing is the person
 * saying they are not in the conversation for now, so the microphone stops
 * being the way in *at all* — the capture rules and the hint must see it, and
 * unlike a reply it does not end on its own.
 *
 * `muted` is the person's own switch on the microphone (mesa task 887), and it
 * belongs here for the same reason again: a muted page is one where the
 * microphone is not the way in, so the capture box takes the keyboard back and
 * the hint says to type. It starts **muted** — a browser that opens the
 * microphone the moment a conversation starts is listening to the room for the
 * whole of it, and the person has to be the one who asks for that. It is deliberately not
 * `paused`: muting stops mesa hearing this room while she keeps talking and
 * the typed box keeps working, where pausing stops the whole run.
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
  /** The person stepped out of the conversation (mesa task 882). */
  paused: boolean
  /** The person turned the microphone off (mesa task 887). */
  muted: boolean
}): boolean {
  return (
    input.live &&
    input.joined &&
    input.supported &&
    !input.blocked &&
    !input.paused &&
    !input.muted
  )
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
  paused: boolean
  muted: boolean
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
 * The chord that turns the microphone on and off (mesa task 887), as a
 * predicate over the keystroke rather than a check inside the hub — it is a
 * rule about which keystroke belongs to the conversation, which is exactly the
 * kind of thing that is wrong in a component and testable here.
 *
 * A **chord**, not a single key, and for the reason `keyboardScope.ts` sets
 * out: the capture box holds the keyboard for most of a conversation, so a
 * single-key shortcut would be typed into the box rather than pressed. That is
 * also why it cannot consult `shouldIgnoreShortcut` — that predicate's first
 * rule is "a modifier chord belongs to its existing owner" — and why it is the
 * hub's own listener, in the shape of the command palette's.
 *
 * Both modifiers are accepted because the platform differs (Cmd on a Mac,
 * Ctrl elsewhere), the same way the palette's does; Alt is not, so a
 * different chord that happens to end in L is not this one.
 */
export function isListenChord(e: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
}): boolean {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return false
  return e.key.toLowerCase() === 'l'
}

/** How the chord is written wherever the page names it. One string for both
 * platforms rather than a detected one: it is read next to the control it
 * describes, and being told which half is yours is cheaper than mesa guessing
 * wrong about a keyboard it cannot see. */
export const LISTEN_CHORD = '⌘/Ctrl+Shift+L'

/**
 * What the composer says about listening — one line, always present, because
 * "is it hearing me" is the only question a hands-free surface has to answer
 * without being asked. The six states are the six honest ones: the person
 * paused it, this browser cannot listen, the microphone was refused, the
 * conversation has not started yet, the person muted it, or it is listening.
 *
 * The two states above muted are the two presses that have to come first — a
 * conversation to listen to, and this browser joined to it, since the switch
 * is not even offered until both are true.
 *
 * Muted ranks under refused and above listening (mesa task 887): a microphone
 * the browser will not give mesa is not one the person can un-mute, so saying
 * that first is the only line naming something they can act on. It ranks
 * under `live` too, and has to: the switch starts muted, so without that the
 * muted line would be what *every* page said before its first press — a
 * composer telling the reader to un-mute a conversation that has not started,
 * under a placeholder telling them to go live. The offer to start is the
 * older, truer line, and it stays the one a cold page shows.
 *
 * `listening` here is `recognizesSpeech`, not whether the engine is running
 * this second: a line that says "listening" and then "go live" and then
 * "listening" again on every reply is answering the question wrong on a
 * several-second cycle. That mesa pauses while she speaks is said *in* the
 * listening line, where it belongs.
 *
 * `paused` outranks the rest (mesa task 882), and it is the one state that
 * has to: the box itself is disabled while paused, so every other line here
 * would be inviting the person to type into a field that will not take it.
 * The other three describe *how* words reach mesa; this one says none of them
 * do right now, and names the press that changes that.
 */
export function captureHint(input: {
  /** There is a conversation running (the hub's `live`). */
  live: boolean
  /** This browser has had its press (the hub's `unlocked`). */
  joined: boolean
  supported: boolean
  blocked: boolean
  listening: boolean
  paused: boolean
  /** The person turned the microphone off (mesa task 887). */
  muted: boolean
}): string {
  if (input.paused) {
    return 'Paused. Press Resume to talk to mesa again — the conversation is still running.'
  }
  if (!input.supported) {
    return 'This browser cannot listen for itself. Type here, or use your system dictation — a settled line is sent on its own.'
  }
  if (input.blocked) {
    return 'The microphone was refused, so mesa is not listening. Type here, or use your system dictation — a settled line is sent on its own.'
  }
  if (!input.live) {
    return 'Go live and mesa listens through this browser. You can also type here, or use your system dictation.'
  }
  if (!input.joined) {
    // Live somewhere, but not here: the microphone cannot open until this
    // browser has had a gesture, and the switch is not even offered yet — so
    // naming the chord would be naming something that does nothing.
    return 'Press Listen to join the conversation on this browser. You can also type here, or use your system dictation.'
  }
  if (input.muted) {
    return `mesa is not listening. Press ${LISTEN_CHORD} — or the microphone button — to have her listen, or just type here.`
  }
  if (input.listening) {
    return 'Listening — each finished sentence is sent as you say it, and mesa stops listening while she is speaking. You can still type here.'
  }
  // Joined, unmuted, and still not the way in — nothing left that is worth a
  // line of its own; the box is the way in and says so.
  return 'Type here, or use your system dictation — a settled line is sent on its own.'
}
