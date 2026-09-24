import { describe, expect, it } from 'vitest'
import { DiscardLedger, liveCancelVerdict } from './liveCancel'

const LISTENING = {
  live: true,
  joined: true,
  supported: true,
  blocked: false,
  paused: false,
  muted: false,
  mutedByCancel: false,
  defaultPrevented: false,
  composing: false,
}

describe('liveCancelVerdict', () => {
  it('discards and mutes while listening', () => {
    expect(liveCancelVerdict(LISTENING)).toBe('discard')
  })

  it('resumes a mute it made itself', () => {
    expect(liveCancelVerdict({ ...LISTENING, muted: true, mutedByCancel: true })).toBe('resume')
  })

  it('never opens a microphone the person shut with the switch', () => {
    expect(liveCancelVerdict({ ...LISTENING, muted: true, mutedByCancel: false })).toBeNull()
  })

  it('leaves the key alone off the listen switch terms', () => {
    for (const off of [
      { live: false },
      { joined: false },
      { supported: false },
      { blocked: true },
      // A pause keeps the recording for Resume: nothing to discard.
      { paused: true },
    ]) {
      expect(liveCancelVerdict({ ...LISTENING, ...off })).toBeNull()
      expect(liveCancelVerdict({ ...LISTENING, ...off, muted: true, mutedByCancel: true })).toBeNull()
    }
  })

  it('yields to a listener that already claimed the Escape', () => {
    // A dialog, menu or bar closing on the same press marks the event.
    expect(liveCancelVerdict({ ...LISTENING, defaultPrevented: true })).toBeNull()
    expect(
      liveCancelVerdict({ ...LISTENING, muted: true, mutedByCancel: true, defaultPrevented: true }),
    ).toBeNull()
  })

  it('leaves an IME composition its Escape', () => {
    expect(liveCancelVerdict({ ...LISTENING, composing: true })).toBeNull()
  })
})

describe('DiscardLedger', () => {
  it('drops what a discarded stretch heard, however late it lands', () => {
    const ledger = new DiscardLedger()
    const run = ledger.current
    ledger.discard()
    expect(ledger.isDiscarded(run)).toBe(true)
    // The run after the discard hears into a fresh stretch.
    expect(ledger.isDiscarded(ledger.current)).toBe(false)
  })

  it('keeps a stretch the switch committed immune to a later discard', () => {
    // Speak, switch off with a segment still draining, switch on, Escape:
    // the drain still owns the committed stretch.
    const ledger = new DiscardLedger()
    const sent = ledger.current
    ledger.commit()
    const after = ledger.current
    ledger.discard()
    expect(ledger.isDiscarded(sent)).toBe(false)
    expect(ledger.isDiscarded(after)).toBe(true)
  })

  it('leaves a stretch no press has ended alone', () => {
    const ledger = new DiscardLedger()
    expect(ledger.isDiscarded(ledger.current)).toBe(false)
  })
})
