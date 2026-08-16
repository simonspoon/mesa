import { describe, expect, it } from 'vitest'
import {
  captureHint,
  isBlockingError,
  readResults,
  recognitionCtor,
  recognizesSpeech,
  shouldListen,
  utteranceFrom,
  type RecognitionResult,
} from './liveRecognition'

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

describe('recognizesSpeech', () => {
  const open = { live: true, joined: true, supported: true, blocked: false } as const

  it('is the way in while the conversation is live in a browser that joined it', () => {
    expect(recognizesSpeech(open)).toBe(true)
  })

  it('needs all four: a live session, a press, a recognizer, an open microphone', () => {
    expect(recognizesSpeech({ ...open, live: false })).toBe(false)
    expect(recognizesSpeech({ ...open, joined: false })).toBe(false)
    expect(recognizesSpeech({ ...open, supported: false })).toBe(false)
    expect(recognizesSpeech({ ...open, blocked: true })).toBe(false)
  })

  it('does not blink while mesa speaks — the capture rules key on this', () => {
    // The engine stops for the length of a reply (`shouldListen`), but the way
    // the person is talking to mesa has not changed, so neither may the focus
    // fight nor the auto-send deadline.
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

describe('captureHint', () => {
  const base = { supported: true, blocked: false, listening: false }

  it('says so where the browser cannot listen', () => {
    expect(captureHint({ ...base, supported: false })).toMatch(/cannot listen/)
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

  it('offers the microphone before the conversation starts', () => {
    expect(captureHint(base)).toMatch(/Go live/)
  })
})
