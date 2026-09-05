import { describe, expect, it } from 'vitest'
import {
  buildVocabulary,
  captureHint,
  COMMON_ENGLISH,
  correctVocabulary,
  HEARING_HOLD_MS,
  HELD_MAX,
  heldFlush,
  heldWith,
  isBlockingError,
  isListenChord,
  isSilentTranscribe,
  listenPath,
  MESA_VOCABULARY,
  readResults,
  recognitionCtor,
  recognizesSpeech,
  shouldFlushSilence,
  shouldListen,
  showsHearing,
  soundKey,
  utteranceFrom,
  type RecognitionResult,
} from './liveRecognition'
import { DEFAULT_VAD } from './liveVad'

/** A result list the way the API hands one over: array-like, cumulative. */
function results(...items: [string, boolean][]): ArrayLike<RecognitionResult> {
  return items.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }))
}

describe('recognitionCtor', () => {
  class Fake {}

  it('finds the standard name', () => {
    expect(recognitionCtor({ SpeechRecognition: Fake })).toBe(Fake)
  })

  it('finds the webkit name, which is the one that actually ships', () => {
    expect(recognitionCtor({ webkitSpeechRecognition: Fake })).toBe(Fake)
  })

  it('prefers the standard name when a browser has both', () => {
    class Other {}
    expect(recognitionCtor({ SpeechRecognition: Fake, webkitSpeechRecognition: Other })).toBe(
      Fake,
    )
  })

  it('is null where there is no recognizer at all', () => {
    expect(recognitionCtor({})).toBe(null)
    expect(recognitionCtor(null)).toBe(null)
    expect(recognitionCtor(undefined)).toBe(null)
  })

  it('is null when the name is present but not constructible', () => {
    expect(recognitionCtor({ SpeechRecognition: 'yes' })).toBe(null)
  })
})

describe('listenPath', () => {
  it('picks auris when the server can transcribe and this browser can capture audio', () => {
    expect(listenPath({ transcribes: true, captures: true, recognizes: false })).toBe('auris')
  })

  it('prefers auris even where the browser also has its own recognizer', () => {
    // The ordering is the whole point of mesa task 957: auris hears mesa's
    // own vocabulary correctly and punctuates like a person, where
    // SpeechRecognition does neither.
    expect(listenPath({ transcribes: true, captures: true, recognizes: true })).toBe('auris')
  })

  it('falls back to the browser recognizer where auris cannot be reached', () => {
    expect(listenPath({ transcribes: false, captures: true, recognizes: true })).toBe('browser')
    expect(listenPath({ transcribes: true, captures: false, recognizes: true })).toBe('browser')
    expect(listenPath({ transcribes: false, captures: false, recognizes: true })).toBe('browser')
  })

  it('is none where neither way in is available', () => {
    expect(listenPath({ transcribes: false, captures: false, recognizes: false })).toBe('none')
    expect(listenPath({ transcribes: false, captures: true, recognizes: false })).toBe('none')
    expect(listenPath({ transcribes: true, captures: false, recognizes: false })).toBe('none')
  })

  it('gives Firefox a microphone through auris even though it has no recognizer of its own', () => {
    // Firefox has no SpeechRecognition at all — this is the genuinely new
    // case the task exists for.
    expect(listenPath({ transcribes: true, captures: true, recognizes: false })).toBe('auris')
  })

  it('leaves Firefox with no way in when auris cannot be reached either', () => {
    expect(listenPath({ transcribes: false, captures: true, recognizes: false })).toBe('none')
  })
})

describe('recognizesSpeech', () => {
  const open = {
    live: true,
    joined: true,
    supported: true,
    blocked: false,
    paused: false,
    muted: false,
  } as const

  it('is the way in while the conversation is live in a browser that joined it', () => {
    expect(recognizesSpeech(open)).toBe(true)
  })

  it('needs all four: a live session, a press, a recognizer, an open microphone', () => {
    expect(recognizesSpeech({ ...open, live: false })).toBe(false)
    expect(recognizesSpeech({ ...open, joined: false })).toBe(false)
    expect(recognizesSpeech({ ...open, supported: false })).toBe(false)
    expect(recognizesSpeech({ ...open, blocked: true })).toBe(false)
  })

  it('is not the way in while the person has muted the microphone', () => {
    // The person's own switch (mesa task 887). Unlike a pause the conversation
    // carries on — mesa still speaks and the typed box still works — so the
    // capture rules must see it and take the keyboard back.
    expect(recognizesSpeech({ ...open, muted: true })).toBe(false)
    expect(shouldListen({ ...open, muted: true, speaking: false })).toBe(false)
  })

  it('is not the way in while the person has stepped out', () => {
    // Unlike a reply, a pause does not end on its own — the person is not in
    // the conversation until they press Resume, so the capture rules and the
    // hint that read this must see it, not just the recognizer's lifecycle.
    expect(recognizesSpeech({ ...open, paused: true })).toBe(false)
    expect(shouldListen({ ...open, paused: true, speaking: false })).toBe(false)
  })

  it('does not blink while mesa speaks — the capture rules key on this', () => {
    // The engine stops for the length of a reply (`shouldListen`), but the way
    // the person is talking to mesa has not changed, so neither may the focus
    // fight.
    const whileSpeaking = { ...open, speaking: true }
    expect(recognizesSpeech(whileSpeaking)).toBe(true)
    expect(shouldListen(whileSpeaking)).toBe(false)
  })
})

describe('shouldListen', () => {
  const open = {
    live: true,
    joined: true,
    supported: true,
    blocked: false,
    paused: false,
    muted: false,
    speaking: false,
  } as const

  it('listens while the conversation is live in a browser that joined it', () => {
    expect(shouldListen(open)).toBe(true)
  })

  it('never listens without a live session', () => {
    expect(shouldListen({ ...open, live: false })).toBe(false)
  })

  it('never listens before this browser has joined', () => {
    expect(shouldListen({ ...open, joined: false })).toBe(false)
  })

  it('never listens where the browser has no recognizer', () => {
    expect(shouldListen({ ...open, supported: false })).toBe(false)
  })

  it('never listens once the microphone was refused', () => {
    expect(shouldListen({ ...open, blocked: true })).toBe(false)
  })

  it('stops listening while mesa is speaking, so she does not hear herself', () => {
    expect(shouldListen({ ...open, speaking: true })).toBe(false)
  })

  it('never listens while the conversation is paused', () => {
    expect(shouldListen({ ...open, paused: true })).toBe(false)
  })

  it('never listens while the microphone is muted', () => {
    expect(shouldListen({ ...open, muted: true })).toBe(false)
  })
})

describe('shouldFlushSilence', () => {
  const open = { listening: true, recording: 'make a task', interim: '', idleMs: 2000, idleThresholdMs: 2000 }

  it('flushes once the wait has fully elapsed', () => {
    expect(shouldFlushSilence(open)).toBe(true)
  })

  it('is not yet silence short of the threshold', () => {
    expect(shouldFlushSilence({ ...open, idleMs: 1999 })).toBe(false)
  })

  it('a blank recording is nothing to flush, even past the threshold', () => {
    expect(shouldFlushSilence({ ...open, recording: '', interim: '' })).toBe(false)
    expect(shouldFlushSilence({ ...open, recording: '   ', interim: ' \n' })).toBe(false)
  })

  it('an unsettled interim is enough on its own', () => {
    expect(shouldFlushSilence({ ...open, recording: '', interim: 'still going' })).toBe(true)
  })

  it('never fires while the microphone is not the way in right now', () => {
    // `listening` is `shouldListen`, not `recognizesSpeech` — while mesa is
    // speaking the caller passes false here, and the timer must not fire.
    expect(shouldFlushSilence({ ...open, listening: false })).toBe(false)
  })
})

describe('isBlockingError', () => {
  it('a refusal ends listening for the page', () => {
    expect(isBlockingError('not-allowed')).toBe(true)
    expect(isBlockingError('service-not-allowed')).toBe(true)
  })

  it('the ordinary interruptions are not fatal', () => {
    for (const code of ['no-speech', 'aborted', 'network', 'audio-capture', 'unknown']) {
      expect(isBlockingError(code)).toBe(false)
    }
  })
})

describe('isSilentTranscribe', () => {
  it('auris hearing nothing is not a failure worth reporting', () => {
    expect(
      isSilentTranscribe(
        'auris produced no transcript: auris: nothing transcribed; no speech in the audio',
      ),
    ).toBe(true)
  })

  it('the wording is matched however it is cased', () => {
    expect(isSilentTranscribe('AURIS: No Speech In The Audio')).toBe(true)
  })

  it('a broken binary is a real error', () => {
    expect(isSilentTranscribe('failed to spawn auris: No such file or directory')).toBe(false)
    expect(isSilentTranscribe('auris exited with exit status: 2')).toBe(false)
    expect(isSilentTranscribe('')).toBe(false)
  })
})

describe('readResults', () => {
  it('separates what the engine settled on from what it is still guessing', () => {
    expect(readResults(0, results(['make a task ', true], ['for the ', false]))).toEqual({
      final: 'make a task',
      interim: 'for the',
      settledThrough: 1,
    })
  })

  it('reads only from where it is told — earlier results were already sent', () => {
    expect(readResults(1, results(['already sent', true], ['and this one', true]))).toEqual({
      final: 'and this one',
      interim: '',
      settledThrough: 2,
    })
  })

  it('joins several settled results into one utterance', () => {
    expect(readResults(0, results(['one ', true], ['two', true]))).toEqual({
      final: 'one two',
      interim: '',
      settledThrough: 2,
    })
  })

  it('is empty for an interim-only event, and settles nothing', () => {
    expect(readResults(0, results(['hello', false]))).toEqual({
      final: '',
      interim: 'hello',
      settledThrough: 0,
    })
  })

  it('carries the high-water mark forward past an interim that follows a final', () => {
    // The mark must not fall back to the start once a later interim arrives:
    // the next event is what would then re-post the settled sentence.
    expect(readResults(1, results(['sent', true], ['done', true], ['still…', false]))).toEqual(
      { final: 'done', interim: 'still…', settledThrough: 2 },
    )
  })

  it('survives an empty list and a result with no alternative', () => {
    expect(readResults(0, [])).toEqual({ final: '', interim: '', settledThrough: 0 })
    expect(readResults(0, [{ isFinal: true, 0: undefined }])).toEqual({
      final: '',
      interim: '',
      settledThrough: 1,
    })
  })

  it('a negative index is read as the start of the list', () => {
    expect(readResults(-3, results(['one', true]))).toEqual({
      final: 'one',
      interim: '',
      settledThrough: 1,
    })
  })
})

describe('the high-water mark over a run of events', () => {
  it('an engine that reports an index it already settled posts nothing twice', () => {
    // The hub floors the read at its own mark, which is the whole point:
    // Chromium on Android has been seen re-reporting from 0.
    const list = results(['first', true], ['second', true])
    const one = readResults(Math.max(0, 0), [list[0]])
    expect(one).toEqual({ final: 'first', interim: '', settledThrough: 1 })
    const two = readResults(Math.max(0, one.settledThrough), list)
    expect(two).toEqual({ final: 'second', interim: '', settledThrough: 2 })
  })
})

describe('utteranceFrom', () => {
  it('trims what is sent', () => {
    expect(utteranceFrom('  make a task \n')).toBe('make a task')
  })

  it('sends nothing for a result the engine settled on with no words in it', () => {
    expect(utteranceFrom('')).toBe(null)
    expect(utteranceFrom('   \n ')).toBe(null)
  })
})

describe('heldWith', () => {
  it('joins each settled sentence onto the recording', () => {
    let held = ''
    for (const text of ['make a task', 'call it the header', 'in mesa']) {
      const grown = heldWith(held, text)
      expect(grown.flush).toBe(null)
      held = grown.held
    }
    expect(held).toBe('make a task call it the header in mesa')
  })

  it('records nothing for a settled result with no words in it', () => {
    expect(heldWith('so far', '   ')).toEqual({ held: 'so far', flush: null })
    expect(heldWith('', '')).toEqual({ held: '', flush: null })
  })

  it('trims the sentence rather than the recording it joins', () => {
    expect(heldWith('', '  make a task \n')).toEqual({ held: 'make a task', flush: null })
  })

  it('flushes on a sentence boundary once the cap is in the way', () => {
    const held = 'x'.repeat(HELD_MAX - 3)
    const grown = heldWith(held, 'and then')
    expect(grown.flush).toBe(held)
    expect(grown.held).toBe('and then')
  })

  it('holds everything that still fits', () => {
    const held = 'x'.repeat(HELD_MAX - 'and then'.length - 1)
    expect(heldWith(held, 'and then').flush).toBe(null)
  })
})

describe('heldFlush', () => {
  it('sends the recording with the sentence still being guessed at on the end', () => {
    expect(heldFlush('make a task', 'call it the header')).toEqual([
      'make a task call it the header',
    ])
  })

  it('sends the recording alone when the engine had settled everything', () => {
    expect(heldFlush('make a task', '')).toEqual(['make a task'])
  })

  it('sends the guess alone when it is all there is', () => {
    expect(heldFlush('', 'make a task')).toEqual(['make a task'])
  })

  it('sends nothing when the microphone heard nothing', () => {
    expect(heldFlush('', '')).toEqual([])
    expect(heldFlush('  ', ' \n')).toEqual([])
  })

  it('splits rather than posting one turn over the cap', () => {
    const held = 'x'.repeat(HELD_MAX - 3)
    expect(heldFlush(held, 'and then')).toEqual([held, 'and then'])
  })

  it('keeps every flushed turn inside the cap', () => {
    const held = 'x'.repeat(HELD_MAX - 3)
    for (const text of heldFlush(held, 'and then')) {
      expect(text.length).toBeLessThanOrEqual(HELD_MAX)
    }
  })
})

describe('soundKey', () => {
  it('folds a mishearing onto the same key as the name it stands for', () => {
    // "chorus" is exactly the kind of mishearing mesa task 922 exists to fix.
    expect(soundKey('chorus')).toBe(soundKey('khora'))
    expect(soundKey('helius')).toBe(soundKey('helios'))
  })

  it('keeps two names with genuinely different sounds apart', () => {
    expect(soundKey('helium')).not.toBe(soundKey('helios'))
  })

  it('collapses doubled letters before stripping vowels, not after (mesa task 922 regression)', () => {
    // Collapsing after the vowel strip would merge two consonants a vowel kept
    // apart: "kokoro" would fold to "kkr" and then collapse to "kr" — exactly
    // "khora"'s key — which would then cancel both entries as ambiguous in
    // buildVocabulary and knock the flagship name "khora" out of the
    // vocabulary entirely.
    expect(soundKey('kokoro')).not.toBe(soundKey('khora'))
  })
})

describe('buildVocabulary', () => {
  it('builds a correction table from the given names', () => {
    const vocab = buildVocabulary(['khora'])
    expect(vocab.get(soundKey('khora'))).toBe('khora')
  })

  it('splits a multi-word name into independent candidate tokens', () => {
    const vocab = buildVocabulary(['The Helios'])
    expect(vocab.get(soundKey('helios'))).toBe('Helios')
    expect(vocab.size).toBe(1) // "the" is under 4 characters and is dropped
  })

  it('drops a token shorter than 4 characters', () => {
    const vocab = buildVocabulary(['abc', 'xyz'])
    expect(vocab.size).toBe(0)
  })

  it('drops a token that is itself common English', () => {
    const vocab = buildVocabulary(['course'])
    expect(vocab.size).toBe(0)
  })

  it('drops a sound key two different names both claim, rather than picking one', () => {
    // Two real, unrelated names that happen to fold to the same key: mesa
    // cannot know which the person meant, so neither wins.
    const a = 'khora'
    const b = 'chorus' // stand-in for a second real name sharing the key
    const vocab = buildVocabulary([a, b])
    expect(vocab.has(soundKey(a))).toBe(false)
  })

  it('keeps one spelling when the same name is offered more than once', () => {
    const vocab = buildVocabulary(['khora', 'khora'])
    expect(vocab.get(soundKey('khora'))).toBe('khora')
  })

  it('keeps "khora" in the vocabulary built from the real MESA_VOCABULARY (end-to-end guard)', () => {
    // This is the guard that actually matters: it fails if any future name,
    // COMMON_ENGLISH entry or fold change knocks "khora" out again, the way
    // the step-order bug above once did.
    const vocab = buildVocabulary(MESA_VOCABULARY)
    expect(vocab.get(soundKey('chorus'))).toBe('khora')
  })

  it('never rewrites a MESA_VOCABULARY name into a different name (round trip)', () => {
    const vocab = buildVocabulary(MESA_VOCABULARY)
    const survivors = new Set([...vocab.values()].map((v) => v.toLowerCase()))
    for (const name of MESA_VOCABULARY) {
      if (!survivors.has(name.toLowerCase())) continue
      expect(correctVocabulary(name, vocab)).toBe(name)
    }
  })

  it('drops from COMMON_ENGLISH exactly the words the doc comment names as intentional', () => {
    // MESA_VOCABULARY's own doc comment names "sonnet" and "opus" as
    // deliberately dropped because they are also ordinary English words. Any
    // other name silently swallowed by the same guard is a regression, not a
    // known trade-off.
    const intersection = MESA_VOCABULARY.filter((name) => COMMON_ENGLISH.has(name.toLowerCase()))
    expect(intersection.sort()).toEqual(['opus', 'sonnet'])
  })
})

describe('correctVocabulary', () => {
  it('rewrites a mishearing to the vocabulary spelling', () => {
    const vocab = buildVocabulary(['khora'])
    expect(correctVocabulary('can you open chorus', vocab)).toBe('can you open khora')
  })

  it('does not rewrite a near-miss that is not actually a hit', () => {
    const vocab = buildVocabulary(['helios'])
    expect(correctVocabulary('look at helium', vocab)).toBe('look at helium')
  })

  it('leaves a word shorter than 4 characters alone', () => {
    const vocab = buildVocabulary(['khora'])
    expect(correctVocabulary('go to it now', vocab)).toBe('go to it now')
  })

  it('passes a full sentence of plain English through unchanged, punctuation and all', () => {
    const vocab = buildVocabulary(MESA_VOCABULARY)
    const sentence = "Please close the task, and let's talk about the course next."
    expect(correctVocabulary(sentence, vocab)).toBe(sentence)
  })

  it('leaves a word already spelled correctly alone', () => {
    const vocab = buildVocabulary(['khora'])
    expect(correctVocabulary('open khora please', vocab)).toBe('open khora please')
  })

  it('returns the input unchanged for an empty vocabulary', () => {
    expect(correctVocabulary('open chorus please', buildVocabulary([]))).toBe(
      'open chorus please',
    )
  })

  it('corrects "chorus" to "khora" using the real built-in vocabulary (flagship case, end-to-end)', () => {
    const vocab = buildVocabulary(MESA_VOCABULARY)
    expect(correctVocabulary('can you open chorus', vocab)).toBe('can you open khora')
  })

  it('corrects "helius" to "helios" using the real built-in vocabulary', () => {
    const vocab = buildVocabulary(MESA_VOCABULARY)
    expect(correctVocabulary('can you open helius', vocab)).toBe('can you open helios')
  })

  it('passes a sentence with contractions and capitalisation through unchanged using the real vocabulary', () => {
    const vocab = buildVocabulary(MESA_VOCABULARY)
    const sentence = "Don't forget, she's opening the course tomorrow!"
    expect(correctVocabulary(sentence, vocab)).toBe(sentence)
  })
})

describe('isListenChord', () => {
  const chord = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'l' }

  it('is the chord under either platform modifier', () => {
    expect(isListenChord(chord)).toBe(true)
    expect(isListenChord({ ...chord, metaKey: false, ctrlKey: true })).toBe(true)
  })

  it('reads the shifted key the browser actually reports', () => {
    // Shift is held, so the key arrives capitalised on most layouts.
    expect(isListenChord({ ...chord, key: 'L' })).toBe(true)
  })

  it('is not a bare L — the capture box is holding the keyboard', () => {
    expect(isListenChord({ ...chord, metaKey: false })).toBe(false)
    expect(isListenChord({ ...chord, shiftKey: false })).toBe(false)
  })

  it('leaves a different chord that happens to end in L alone', () => {
    expect(isListenChord({ ...chord, altKey: true })).toBe(false)
    expect(isListenChord({ ...chord, key: 'k' })).toBe(false)
  })
})

describe('captureHint', () => {
  const base = {
    live: true,
    joined: true,
    path: 'auris' as const,
    blocked: false,
    listening: false,
    paused: false,
    muted: false,
  }

  it('says so where neither way in is available', () => {
    expect(captureHint({ ...base, path: 'none' })).toMatch(/Neither auris nor this browser/)
  })

  it('says so once the microphone was refused', () => {
    expect(captureHint({ ...base, blocked: true })).toMatch(/refused/)
  })

  it('a refusal outranks nothing else being wrong', () => {
    expect(captureHint({ ...base, blocked: true, listening: true })).toMatch(/refused/)
  })

  it('says it is listening while it is', () => {
    expect(captureHint({ ...base, listening: true })).toMatch(/Listening/)
  })

  it('names auris as the way in while listening through it', () => {
    expect(captureHint({ ...base, listening: true, path: 'auris' })).toMatch(
      /Listening through auris/,
    )
  })

  it('names this browser as the way in while listening through its own recognizer', () => {
    expect(captureHint({ ...base, listening: true, path: 'browser' })).toMatch(
      /Listening through this browser/,
    )
  })

  it('says the recording is sent on silence, with the switch as an early send', () => {
    const hint = captureHint({ ...base, listening: true })
    expect(hint).toMatch(/once you go quiet/)
    expect(hint).toMatch(/press the switch/)
  })

  it('offers the microphone before the conversation starts', () => {
    expect(captureHint({ ...base, live: false })).toMatch(/Go live/)
  })

  it('names the press that joins a conversation this browser has not joined', () => {
    expect(captureHint({ ...base, joined: false })).toMatch(/Press Listen/)
    // Above the mute, since the switch is not offered until this browser is in
    // the conversation — naming the chord there names something inert.
    expect(captureHint({ ...base, joined: false, muted: true })).toMatch(/Press Listen/)
  })

  it('a page with no conversation is not told to un-mute one', () => {
    // The switch starts muted, so without this rank the muted line is what
    // every cold page would say — under a placeholder telling them to go live.
    expect(captureHint({ ...base, live: false, muted: true })).toMatch(/Go live/)
  })

  it('names the chord that unmutes the microphone', () => {
    expect(captureHint({ ...base, muted: true })).toMatch(/Shift\+L/)
  })

  it('a refusal outranks a mute — one of the two is the person\'s to undo', () => {
    expect(captureHint({ ...base, muted: true, blocked: true })).toMatch(/refused/)
  })

  it('names the press that undoes a pause, above every other line', () => {
    // The box is disabled while paused, so each of the other three would be
    // inviting the person to type into a field that will not take it.
    expect(captureHint({ ...base, paused: true })).toMatch(/Resume/)
    expect(captureHint({ ...base, paused: true, path: 'none' })).toMatch(/Resume/)
    expect(captureHint({ ...base, paused: true, blocked: true })).toMatch(/Resume/)
  })
})

describe('showsHearing', () => {
  const now = 1_000_000
  const base = { recording: '', interim: '', hearing: 0, voicedAt: null as number | null, now, holdMs: HEARING_HOLD_MS }

  it('shows the panel while the person is saying their first sentence', () => {
    // The case that used to blink: nothing is recorded yet and no segment
    // exists to be in flight, because the VAD has not ended one — but the
    // person is plainly talking.
    expect(showsHearing({ ...base, voicedAt: now - 200 })).toBe(true)
  })

  it('bridges the VAD hangover, so the hold reaches the segment it ends', () => {
    // The whole point of deriving the hold from `hangoverMs`: the last audible
    // frame is at least that long before the segment is posted.
    expect(showsHearing({ ...base, voicedAt: now - DEFAULT_VAD.hangoverMs })).toBe(true)
  })

  it('drops once the person has actually gone quiet', () => {
    expect(showsHearing({ ...base, voicedAt: now - 1500 })).toBe(false)
  })

  it('shows the panel while a finished segment is in flight', () => {
    expect(showsHearing({ ...base, hearing: 1 })).toBe(true)
  })

  it('shows the panel for a recording nothing is adding to right now', () => {
    expect(showsHearing({ ...base, recording: 'what I said' })).toBe(true)
  })

  it('shows the panel for the browser path\'s own interim guess', () => {
    // `voicedAt` is auris-path-only, so this is the browser path's whole case.
    expect(showsHearing({ ...base, interim: 'half a sen' })).toBe(true)
  })

  it('shows nothing when nothing is being heard', () => {
    expect(showsHearing(base)).toBe(false)
  })
})
