import { describe, expect, it } from 'vitest'
import {
  isPausePhrase,
  normalizePhrase,
  PAUSE_LEAD_INS,
  PAUSE_TAILS,
  PAUSE_TRIGGERS,
  PAUSE_WORD_BUDGET,
} from './livePausePhrase'

describe('normalizePhrase', () => {
  it('lower-cases, strips punctuation and collapses whitespace', () => {
    expect(normalizePhrase('  Hold on,  please!  ')).toBe('hold on please')
    expect(normalizePhrase('Wait… a second.')).toBe('wait a second')
    expect(normalizePhrase('')).toBe('')
    expect(normalizePhrase('...')).toBe('')
  })
})

describe('isPausePhrase', () => {
  it('accepts every trigger on its own', () => {
    for (const trigger of PAUSE_TRIGGERS) {
      expect(isPausePhrase(trigger), trigger).toBe(true)
    }
  })

  it('accepts each phrase form the brief names', () => {
    for (const text of [
      'hold up',
      'hold on',
      'hold on a second',
      'pause',
      'wait',
      'wait a minute',
      'wait a second',
      'wait a sec',
      'wait a moment',
    ]) {
      expect(isPausePhrase(text), text).toBe(true)
    }
  })

  it('accepts every lead-in and tail around every trigger, and both together', () => {
    for (const lead of PAUSE_LEAD_INS) {
      for (const trigger of PAUSE_TRIGGERS) {
        expect(isPausePhrase(`${lead} ${trigger}`), `${lead} ${trigger}`).toBe(true)
        for (const tail of PAUSE_TAILS) {
          expect(isPausePhrase(`${trigger} ${tail}`), `${trigger} ${tail}`).toBe(true)
          expect(isPausePhrase(`${lead} ${trigger} ${tail}`), `${lead} ${trigger} ${tail}`).toBe(true)
        }
      }
    }
  })

  it('ignores case, punctuation and stray whitespace — auris punctuates, the browser does not', () => {
    expect(isPausePhrase('Hold on, please.')).toBe(true)
    expect(isPausePhrase('Hey mesa, wait a second!')).toBe(true)
    expect(isPausePhrase('  PAUSE  ')).toBe(true)
    expect(isPausePhrase('Okay, mesa. Hold up.')).toBe(true)
  })

  it('accepts the naru lead-ins beside the mesa ones', () => {
    expect(isPausePhrase('hey naru, hold up')).toBe(true)
    expect(isPausePhrase('okay naru wait a second please')).toBe(true)
    expect(isPausePhrase('Naru, pause.')).toBe(true)
    expect(isPausePhrase('OK Naru, hold on.')).toBe(true)
    expect(isPausePhrase('naru can you wait for the build')).toBe(false)
    expect(isPausePhrase('naru')).toBe(false)
    expect(isPausePhrase('hey naru')).toBe(false)
  })

  it('is false for empty or punctuation-only text', () => {
    expect(isPausePhrase('')).toBe(false)
    expect(isPausePhrase('   ')).toBe(false)
    expect(isPausePhrase('...')).toBe(false)
  })

  it('is false for an ordinary sentence that merely contains a trigger', () => {
    for (const text of [
      "please don't pause the build",
      "I'll wait for the tests",
      'hold up the release until Friday',
      'pause it and then run the checks',
      'can you wait until the build is green',
      'the hold on the deploy is lifted',
      'mesa please pause the watcher',
    ]) {
      expect(isPausePhrase(text), text).toBe(false)
    }
  })

  it('is false for the bare word "wait" inside longer text', () => {
    expect(isPausePhrase('wait what did that error say')).toBe(false)
    expect(isPausePhrase('no wait')).toBe(false)
    expect(isPausePhrase('wait wait')).toBe(false)
  })

  it('is false for a lead-in or a tail on its own, and for a tail before the trigger', () => {
    expect(isPausePhrase('mesa')).toBe(false)
    expect(isPausePhrase('hey mesa')).toBe(false)
    expect(isPausePhrase('please')).toBe(false)
    expect(isPausePhrase('please wait')).toBe(false)
  })

  it('never matches past the word budget, whatever the words', () => {
    const longest = Math.max(
      ...PAUSE_LEAD_INS.flatMap((lead) =>
        PAUSE_TRIGGERS.flatMap((trigger) =>
          PAUSE_TAILS.map((tail) => `${lead} ${trigger} ${tail}`.split(' ').length),
        ),
      ),
    )
    // The budget is what keeps a long mis-lexed sentence out of the grammar;
    // it must still admit the longest legal phrase.
    expect(longest).toBeLessThanOrEqual(PAUSE_WORD_BUDGET)
    expect(isPausePhrase('hey mesa hold on a second please')).toBe(true)
    expect(isPausePhrase('hey mesa hold on a second please now')).toBe(false)
    expect(isPausePhrase('okay naru hold on a second please')).toBe(true)
    expect(isPausePhrase('okay naru hold on a second please now')).toBe(false)
  })
})
