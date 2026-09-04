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
 * - **Only a final result is recorded.** An interim result is the engine
 *   thinking out loud — it is shown as a preview and never recorded, because a
 *   sentence held mid-guess is a sentence the person never said.
 * - **Listening is a recording, not a stream of utterances** (mesa task 889),
 *   and a recording has **two** boundaries, not one (mesa task 917). Each
 *   settled sentence is *held* rather than sent, and the whole recording
 *   becomes **one** `user` turn — ordinarily on **silence**: the wait
 *   `live.auto-send-ms` names. `liveCapture.ts::autoSendIdleMs` still owns
 *   the number and the clamp; mesa task 977 took the typed box off it, so
 *   this is now that setting's one reader rather than one of two. A
 *   conversation is not one sentence at a time: the engine settles
 *   wherever the speaker drew breath, so posting each final made the agent
 *   answer a half-thought and then answer the rest of it, and the person had
 *   to talk to the pauses the engine chose rather than to mesa — silence
 *   after the *whole* thought is the pause that actually means something. The
 *   switch the person already has (`isListenChord`, the listen button)
 *   remains the second boundary: an explicit early send for whenever the
 *   silence wait would be too slow or too fast for what was just said. The
 *   silence timer is measured on `shouldListen`, not `recognizesSpeech` —
 *   deliberately excluding the seconds mesa is talking, because a timer that
 *   ran through her reply would read the person's own silence, sitting and
 *   listening to mesa, as them falling quiet, and post the half-thought she
 *   is still mid-reply to. It also restarts on every result, interim included,
 *   so a mid-sentence pause the person fills back in does not get cut off by
 *   a clock that only heard the settled words.
 * - **Recognition ends on its own, constantly.** Chrome stops after roughly a
 *   minute, and on a long enough silence; the engine reports that as an
 *   ordinary end, not an error. So "should it be running" is asked again on
 *   every end (`shouldListen`) rather than assumed from the last start, and the
 *   answer is what restarts it.
 * - **mesa stops listening while she speaks.** The microphone would otherwise
 *   hear her own reply out of the speakers and answer it — a conversation with
 *   itself. `speaking` is therefore a gate on listening, not a separate mute.
 *
 * As of mesa task 956, `LiveHub.tsx` no longer calls into this module for the
 * microphone itself — page-side audio capture (`liveAudio.ts`, `liveVad.ts`)
 * posts each finished utterance to `POST /api/live/transcribe`, which hands
 * it to the external `auris` binary and returns text. That text is handed
 * straight to the functions below, at exactly the point in the flow
 * `onresult`'s final branch used to occupy — `heldWith`, `shouldFlushSilence`,
 * `heldFlush`, `utteranceFrom`, `captureHint`, `correctVocabulary` and the
 * rest of this module's exports are all still in use, unchanged, because the
 * decisions they encode (only a settled utterance is recorded, a recording
 * has two boundaries, the person's own vocabulary gets corrected) never had
 * anything to do with *how* the words were heard. `recognitionCtor`,
 * `readResults`, `isBlockingError` and `SpeechRecognitionLike` are the part
 * that was `SpeechRecognition`-specific; as of mesa task 957 they are **in
 * use again**, by the browser-recognizer path `listenPath` falls back to on
 * a machine with no `auris`.
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
 * The two ways in a page can have (mesa task 957), plus none: `'auris'`
 * (page-side capture posted to `POST /api/live/transcribe`, mesa task 956),
 * `'browser'` (this module's original `SpeechRecognition` path, mesa task
 * 873), or `'none'` (the typed box and the person's own system dictation).
 */
export type ListenPath = 'auris' | 'browser' | 'none'

/**
 * Which way in this page actually has, decided once per conversation and
 * named to the person (`captureHint`) rather than left for them to guess
 * from transcript quality.
 *
 * auris wins whenever it can be reached, **even where the browser also has
 * its own recognizer** — the ordering is the whole point of mesa task 957:
 * auris hears mesa's own vocabulary correctly (mesa task 922 exists only
 * because the browser's engine does not) and punctuates like a person,
 * where `SpeechRecognition` does neither. Firefox has no recognizer of its
 * own at all, so auris is also the only way a Firefox user gets a
 * microphone here — `getUserMedia` is everywhere `SpeechRecognition` is
 * not, so `transcribes && captures && !recognizes` is a genuinely new
 * capability, not just a better one.
 *
 * The browser's own recognizer is the fallback, and `'none'` is the last
 * resort — the typed box and the person's own system dictation.
 */
export function listenPath(input: {
  /**
   * The server has an `auris` that answered — `GET /api/live/transcribe`.
   * False whenever mesa could not ask: the request failed, or
   * `listen::models()` came back empty. An empty model list means
   * **"mesa could not ask"**, never "auris says there are none" — the same
   * rule `speech::voices()` has carried since it shipped.
   */
  transcribes: boolean
  /** This browser can capture audio at all (`liveAudio.ts::capturesAudio`). */
  captures: boolean
  /** This browser has a recognizer of its own (`recognitionCtor(...) !== null`). */
  recognizes: boolean
}): ListenPath {
  if (input.transcribes && input.captures) return 'auris'
  if (input.recognizes) return 'browser'
  return 'none'
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
 * the hint says to type. A conversation this browser **joins** opens
 * listening on its own (mesa task 917) — a hands-free surface that needs a
 * press before it can hear is not hands-free, and the press that joined the
 * conversation is already the consent, the same one an autoplay policy
 * weighs. Once muted, though, it is the person's own act and it **sticks for
 * the session**: this module does not reopen it underneath them, only a
 * fresh press does. It is deliberately not
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
 * Whether the recording should be sent because the person has gone quiet
 * (mesa task 917) — the second boundary a recording has, next to the listen
 * switch.
 *
 * `listening` here is `shouldListen`, not `recognizesSpeech` — the same
 * distinction `shouldListen` itself draws, and load-bearing for the same
 * reason: the timer is measuring a pause **in the person's speech**, and
 * while mesa is talking the microphone is shut, so there is nothing to
 * measure and no pause to read. A timer that ran through her reply would
 * count the person listening to mesa as the person falling silent, and post
 * the half-thought they were still building mid-sentence. It is also what
 * keeps this rule from ever recording mesa herself: when she stops, the
 * microphone reopens and the wait starts fresh.
 *
 * Blank is not silence worth acting on — nothing was said, so there is
 * nothing to flush, and firing anyway would be an empty turn the server
 * would refuse for no reason. `recording` and `interim` are checked
 * separately from the send itself (`heldFlush` does the actual joining) so
 * this predicate stays a pure yes/no over what the caller already has in
 * hand.
 */
export function shouldFlushSilence(input: {
  listening: boolean
  recording: string
  interim: string
  idleMs: number
  idleThresholdMs: number
}): boolean {
  if (!input.listening) return false
  if (input.recording.trim() === '' && input.interim.trim() === '') return false
  return input.idleMs >= input.idleThresholdMs
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
 * Whether a failed transcription means auris heard nothing, rather than that
 * auris broke.
 *
 * A segment the VAD ended on a breath, a door or a stretch of room noise
 * reaches auris as audio with no speech in it, and auris reports that as a
 * failure — mesa's `/api/live/transcribe` has no transcript to answer with, so
 * it is a 503 like any other (`docs/listen.md`). That is a normal outcome of
 * listening, not something to tell the person about, so the caller says
 * nothing for it.
 *
 * The match is on the shape of auris's own wording, case-insensitively,
 * because the sentence comes from that binary's stderr rather than from mesa
 * and may be reworded. Erring toward "this is a real error" is deliberate: a
 * missed silence shows a banner that now clears itself on the next successful
 * segment, while a false positive would hide a genuinely broken binary for the
 * whole conversation.
 */
export function isSilentTranscribe(message: string): boolean {
  const said = message.toLowerCase()
  return said.includes('no speech') || said.includes('nothing transcribed')
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
 * Longest recording the page will hold before it has to let go of it — the
 * server's own `LIVE_TEXT_MAX` (`src/core/store.rs`), mirrored here because
 * this is where the text is assembled and a turn over the cap is a 422 the
 * person would meet only after speaking for nine minutes.
 */
export const HELD_MAX = 8192

/**
 * One settled sentence joined onto the recording (mesa task 889), and whatever
 * that no longer leaves room for.
 *
 * `flush` is the escape hatch and nothing more: a recording that would cross
 * `HELD_MAX` is posted as it stands and the new sentence begins a fresh one, so
 * a monologue long enough to break the cap arrives as several turns instead of
 * being refused. The split is on a sentence boundary — the engine's, not a
 * character count — because half a word is not something anybody said.
 * Everything short of the cap, which is every ordinary turn, holds until the
 * person stops listening.
 *
 * One sentence longer than the whole cap is the one case that *is* cut, at
 * `HELD_MAX` characters: there is no boundary inside it to split on, and the
 * server would refuse the turn whole. An engine settles on a breath, so this
 * is a case that does not arise short of a recognizer that never finalises.
 */
export function heldWith(
  held: string,
  text: string,
): { held: string; flush: string | null } {
  const sentence = text.trim()
  if (sentence === '') return { held, flush: null }
  if (held === '') return { held: sentence.slice(0, HELD_MAX), flush: null }
  const joined = `${held} ${sentence}`
  if (joined.length <= HELD_MAX) return { held: joined, flush: null }
  return { held: sentence.slice(0, HELD_MAX), flush: held }
}

/**
 * What the recording becomes when listening stops — the held sentences plus
 * whatever the engine was still guessing at, in the order they were said.
 * Empty when nothing was heard.
 *
 * The interim is included **here and nowhere else**. Everywhere else it is a
 * preview and never a turn, but this one moment is the exception the rule was
 * never about: the person finished speaking and then reached for the switch, so
 * the sentence the engine has not settled yet is the last thing they said. The
 * engine does deliver it as a final when it stops — but that arrives after the
 * switch has already flipped, on the browser's own schedule, and a recording
 * that posts the last sentence a beat later (or, once muted, not at all) is
 * worse than one that posts the engine's best guess at it now.
 *
 * A **list**, because the guess joins the recording under exactly the rule
 * every other sentence joined it under — `heldWith`, cap and all. A recording
 * already at the cap plus a long tail is two turns for the same reason a long
 * monologue was: one implementation of the boundary, so the last sentence
 * cannot be the one that slips over it and takes the whole flush down with a
 * 422.
 */
export function heldFlush(held: string, interim: string): string[] {
  const grown = heldWith(held, interim)
  const last = utteranceFrom(grown.held)
  return [grown.flush, last].filter((t): t is string => t !== null)
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

/**
 * A rough phonetic fold, used to catch the browser mishearing a name mesa
 * knows for an ordinary word that sounds like it (mesa task 922) — "khora" as
 * "chorus", "helios" as "helius". `SpeechGrammarList`, the API's own way to
 * hand a recognizer a vocabulary up front, is a documented no-op in Chrome, so
 * this correction has to happen after the fact, on the text the engine already
 * settled on.
 *
 * Plain soundex will not do: it keeps the first *letter* rather than the first
 * *sound*, so "chorus" (C-) and "khora" (K-) are already different codes
 * before either word is folded any further. Metaphone comes closer but maps
 * `ch` to `x`, landing "chorus" and "khora" on different codes again. This
 * fold instead normalises the *spelling* toward the sound first — `ch`, `kh`,
 * `ck` and `qu` all become `k`, the same target `c` itself falls to except
 * before `e`/`i`/`y` — and only then keeps one representative letter, so both
 * words collapse onto the same key.
 *
 * The steps, in the order that makes that collapse happen:
 * 1. Lowercase and strip everything that is not a-z — punctuation and
 *    digits carry no sound.
 * 2. Fold digraphs and single letters that spell one sound multiple ways,
 *    left to right over the whole string. `gh` is dropped outright (a silent
 *    letter pair in the words it appears in, "though"/"through"/"ghost"'s `h`
 *    contribute nothing to how the name sounds); `x` becomes `ks` and `z`
 *    becomes `s` because both are just voiced/voiceless spellings of sounds
 *    already in the alphabet; `y` is left as a vowel rather than folded, so
 *    the vowel-stripping step below treats it exactly like `a`/`e`/`i`/`o`/`u`.
 *    This has to run before step 4, or `ch`/`kh`/`ck` would already have lost
 *    the letter that makes them a digraph.
 * 3. Drop one trailing `s` — the recognizer's stray plural/sibilant
 *    ("helius" for "Helios") must not be what keeps two spellings apart.
 * 4. Keep the first character verbatim (soundex's one idea worth keeping —
 *    two words starting on genuinely different sounds should stay apart), then
 *    drop every vowel *after* it. Vowels are the least reliably heard part of
 *    a word and the part speakers vary most on, so keeping only the
 *    consonant skeleton is what makes "khora" and "chorus" line up despite
 *    neither vowel matching.
 * 5. Collapse runs of the same character to one, the way soundex does for a
 *    doubled consonant — "kh" and "k" folding to the same letter in step 2
 *    can otherwise leave "kk" where a single word only ever had one sound.
 *
 * Worked examples this order is chosen to satisfy (both sides fold to `kr`,
 * `hls`, `hlm` respectively — the exact letters are incidental, only the
 * equalities below are load-bearing and are what the tests check):
 * - `soundKey('chorus') === soundKey('khora')`
 * - `soundKey('helius') === soundKey('helios')`
 * - `soundKey('helium') !== soundKey('helios')`
 */
export function soundKey(word: string): string {
  let s = word.toLowerCase().replace(/[^a-z]/g, '')
  s = s
    .replace(/gh/g, '')
    .replace(/ph/g, 'f')
    .replace(/ch/g, 'k')
    .replace(/kh/g, 'k')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'k')
    .replace(/q/g, 'k')
    .replace(/wh/g, 'w')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
  // Doubled letters collapse **before** the vowels come out, not after, and the
  // order is the whole difference between a fold that works and one that eats
  // the flagship case (mesa task 922). Collapsing afterwards would merge two
  // consonants a vowel had kept apart: `kokoro` strips to `kkr` and then to
  // `kr`, which is exactly `khora`'s key — so the ambiguity rule in
  // `buildVocabulary` would cancel both, and the one mishearing this whole
  // function exists to correct would stop being correctable. A vowel between
  // two of the same consonant is a syllable, and soundex has always counted it.
  s = s.replace(/(.)\1+/g, '$1')
  s = s.replace(/s$/, '')
  if (s.length > 1) {
    s = s[0] + s.slice(1).replace(/[aeiouy]/g, '')
  }
  return s
}

/**
 * The small set of ordinary English words this correction must never
 * override (mesa task 922) — the guard `buildVocabulary` and
 * `correctVocabulary` both check before ever consulting a sound key. A name
 * that also happens to spell an everyday word (there are none in
 * `MESA_VOCABULARY` today) is dropped from the vocabulary entirely rather
 * than risk it, and an everyday word is never *rewritten* even where its
 * sound key collides with a real name — "chorus" is deliberately the
 * mishearing this feature corrects, but "course" or "call" must reach the
 * transcript untouched regardless of what they sound like. This is
 * necessarily incomplete (a rewrite is only worth doing where mesa is fairly
 * sure), not an attempt at a full dictionary — the top few hundred function
 * words and common nouns/verbs, weighted toward the ones that sound like
 * mesa's own names, is what keeps ordinary speech safe without trying to
 * enumerate the language.
 */
export const COMMON_ENGLISH: ReadonlySet<string> = new Set([
  // top function words
  'the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but',
  'his', 'from', 'they', 'she', 'her', 'been', 'than', 'its', 'who', 'did',
  'yes', 'get', 'has', 'him', 'how', 'man', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she',
  'too', 'use', 'want', 'need', 'will', 'well', 'were', 'when', 'what',
  'where', 'which', 'while', 'would', 'could', 'should', 'about', 'after',
  'again', 'against', 'because', 'before', 'being', 'below', 'between',
  'both', 'down', 'during', 'each', 'few', 'further', 'here', 'into',
  'itself', 'just', 'more', 'most', 'once', 'only', 'other', 'over',
  'own', 'same', 'some', 'such', 'then', 'there', 'these', 'those',
  'through', 'under', 'until', 'very', 'your', 'yours', 'ours', 'theirs',
  'them', 'their', 'have', 'having', 'does', 'doing', 'done', 'shall',
  'must', 'can', 'cannot', 'like', 'make', 'made', 'take', 'took',
  'come', 'came', 'go', 'goes', 'went', 'gone', 'look', 'looked',
  'give', 'gave', 'find', 'found', 'know', 'knew', 'think', 'thought',
  'good', 'great', 'little', 'long', 'right', 'still', 'never', 'always',
  'today', 'tomorrow', 'yesterday', 'time', 'year', 'work', 'life',
  'world', 'hand', 'part', 'place', 'case', 'week', 'point', 'fact',
  'group', 'number', 'room', 'area', 'money', 'story', 'water', 'family',
  'word', 'body', 'music', 'level', 'child', 'eye', 'day', 'thing',
  'people', 'name', 'home', 'country', 'company', 'system', 'program',
  'question', 'government', 'power', 'issue', 'side', 'kind', 'head',
  'house', 'service', 'friend', 'father', 'mother', 'sister', 'brother',
  // sound-alikes to the words we correct *toward* — the actual guard
  'course', 'cores', 'chores', 'corps', 'care', 'call', 'called', 'calls',
  'class', 'close', 'closed', 'coarse', 'chore', 'core',
  'cause', 'cost', 'cold', 'code', 'cloud', 'crowd', 'clock', 'clerk',
  'quote', 'quote', 'quiet', 'quick', 'quite', 'question',
  'help', 'helper', 'health', 'held', 'hell', 'hello',
  'lock', 'locked', 'lucky', 'local', 'logic',
  'saw', 'sonnet', 'song', 'sound', 'south', 'shape', 'sharp',
  'open', 'opens', 'opened', 'opening', 'opus', 'office', 'often',
  'clip', 'client', 'clean',
])

/**
 * The names mesa always knows regardless of what projects exist in this
 * install (mesa task 922) — its own tools and the model family names it
 * talks about.
 *
 * The list is deliberately **not** pre-filtered for what `buildVocabulary`
 * will actually keep. `sonnet` and `opus` are ordinary English words as well
 * as model names, so `COMMON_ENGLISH` drops them, and that is the right
 * outcome rather than an oversight: nothing needs correcting *to* a word the
 * recognizer already spells correctly, and a vocabulary that could rewrite
 * "opus" would be a vocabulary that could rewrite it wrongly. Listing them
 * here says what mesa's words are; the rules downstream say which of them are
 * safe to correct toward, and keeping those two statements apart is what lets
 * a rule change without this list being re-audited.
 */
export const MESA_VOCABULARY: readonly string[] = [
  'khora',
  'qorvex',
  'helios',
  'loki',
  'kokoro',
  'mesa',
  'claude',
  'sonnet',
  'opus',
  'haiku',
  'clippy',
  'sqlite',
  'vitest',
  'soundex',
]

/**
 * The correction table built once per conversation (mesa task 922): a sound
 * key to the one spelling it may be corrected to. A `ReadonlyMap` rather than
 * a plain object so an unusual project name can never collide with a
 * `Map`/`Object.prototype` method name the way a bare `{}` lookup can.
 */
export type Vocabulary = ReadonlyMap<string, string>

/**
 * Builds a `Vocabulary` from mesa's own names plus whatever this install's
 * project names contribute (mesa task 922) — called once when a conversation
 * opens, not on every result, since the set of things worth correcting *to*
 * does not change mid-conversation.
 *
 * Every rule below exists to serve one governing principle: **a wrong
 * "correction" is worse than the mishearing it replaced.** A missed rewrite
 * is a name spelled the way the engine guessed it — mildly wrong, and no
 * worse than today. A wrong rewrite silently replaces a word the person
 * actually said with one they didn't, inside a transcript nobody proofreads
 * before it is sent — so every rule here errs toward dropping a candidate
 * rather than keeping a shaky one.
 *
 * - Each name is split on whitespace and punctuation into tokens, and each
 *   token stands as its own candidate — a two-word project name should
 *   correct either of its words on its own, not only the phrase whole.
 * - A token under 4 characters is dropped: a short sound key is a common
 *   prefix of half the language, so "correcting" toward it would rewrite far
 *   more ordinary speech than it would ever fix.
 * - A token whose *sound key* comes out under 2 characters is dropped for the
 *   same reason, one step later — the fold can shrink a longer token down to
 *   almost nothing (a name that is mostly vowels), and it is the key's length
 *   that actually determines how much it collides with.
 * - A token that is itself in `COMMON_ENGLISH` is dropped: a name that is
 *   also an everyday word cannot be corrected *to* without corrupting the
 *   ordinary speech that already spells it that way.
 * - If two different surviving tokens land on the same sound key with
 *   *different* canonical spellings, the key is dropped entirely rather than
 *   arbitrarily keeping one — mesa has no way to know which of two real names
 *   the person meant, and guessing wrong is the exact failure this feature
 *   exists to avoid.
 * - The key is computed from the lowercased token; the value kept is the
 *   token's original spelling, so a proper-noun capitalisation in a project
 *   name survives into the correction.
 */
export function buildVocabulary(names: Iterable<string>): Vocabulary {
  const claims = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const name of names) {
    for (const token of name.split(/[^A-Za-z]+/)) {
      if (token.length < 4) continue
      if (COMMON_ENGLISH.has(token.toLowerCase())) continue
      const key = soundKey(token.toLowerCase())
      if (key.length < 2) continue
      const existing = claims.get(key)
      if (existing === undefined) {
        claims.set(key, token)
      } else if (existing.toLowerCase() !== token.toLowerCase()) {
        ambiguous.add(key)
      }
    }
  }
  for (const key of ambiguous) claims.delete(key)
  return claims
}

/**
 * Rewrites whole words in recognised text toward mesa's vocabulary (mesa task
 * 922) — applied to both the final and interim text in `onresult`, since
 * `heldFlush` can send the interim tail as part of a turn.
 *
 * Splits on word boundaries so every separator — spaces, punctuation, the
 * sentence's own capitalisation — round-trips untouched wherever nothing
 * matched; an empty vocabulary is therefore a no-op that returns its input
 * unchanged rather than a pass over the string that happens to change
 * nothing. For each word:
 * - a word under 4 characters, or one whose lowercase form is in
 *   `COMMON_ENGLISH`, is left alone without even computing a sound key —
 *   the same two guards `buildVocabulary` applies when deciding what may be
 *   corrected *to* apply here to what may be corrected *from*;
 * - otherwise its sound key is looked up, and it is replaced **only** when
 *   there is a hit whose spelling actually differs (a word already spelled
 *   correctly is left as the engine wrote it, not re-typed identically);
 * - the replacement is the vocabulary's stored spelling verbatim, not a
 *   case-matched version of it — the entire point is the *real* spelling of
 *   the name, so guessing at how to re-capitalise it would undo that.
 *
 * Task ids are deliberately not part of this: a digit string has no
 * sound-alike spelling for a phonetic fold to work on, and turning a spoken
 * number into a digit string is a different mechanism this module does not
 * attempt.
 */
export function correctVocabulary(text: string, vocab: Vocabulary): string {
  if (vocab.size === 0) return text
  return text.replace(/[A-Za-z']+/g, (word) => {
    if (word.length < 4) return word
    const lower = word.toLowerCase()
    if (COMMON_ENGLISH.has(lower)) return word
    const hit = vocab.get(soundKey(lower))
    if (hit === undefined || hit.toLowerCase() === lower) return word
    return hit
  })
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
 * paused it, neither way in is available, the microphone was refused, the
 * conversation has not started yet, the person muted it, or it is listening
 * (and, once listening, which of the two ways in — mesa task 957).
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
  /** Which way in this page actually has (mesa task 957, `listenPath`). */
  path: ListenPath
  blocked: boolean
  listening: boolean
  paused: boolean
  /** The person turned the microphone off (mesa task 887). */
  muted: boolean
}): string {
  if (input.paused) {
    return 'Paused. Press Resume to talk to mesa again — the conversation is still running.'
  }
  if (input.path === 'none') {
    return 'Neither auris nor this browser can listen here. Type here, or use your system dictation.'
  }
  if (input.blocked) {
    return 'The microphone was refused, so mesa is not listening. Type here, or use your system dictation.'
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
    // Named (mesa task 957): the person can act on the difference — auris is
    // an install away, the browser recognizer is not — so the ladder saying
    // only "listening" would hide something worth knowing.
    const via = input.path === 'auris' ? 'auris' : 'this browser'
    return `Listening through ${via} — everything you say is held here and sent to mesa once you go quiet, or right away if you press the switch. She stops listening while she is speaking. You can still type here.`
  }
  // Joined, unmuted, and still not the way in — nothing left that is worth a
  // line of its own; the box is the way in and says so.
  return 'Type here, or use your system dictation.'
}
