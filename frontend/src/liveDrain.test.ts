import { describe, expect, it } from 'vitest'
import { mayHold, SegmentChain } from './liveDrain'
import { heldFlush, heldWith, statusPill } from './liveRecognition'

/** A promise the test resolves by hand, standing in for one transcribe call. */
function deferred() {
  let resolve!: (text: string) => void
  const promise = new Promise<string>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Two microtask turns — enough for a resolved step and the count behind it. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * The hub's wiring, without the hub: refs for the gate, a recording folded
 * through `heldWith`, a flush through `heldFlush`, and a chain whose steps
 * are pending transcriptions. `mute()` is `toggleListening(true)` — the ref
 * first, then the open utterance cut onto the chain, then `close()`.
 */
function page() {
  const posted: string[] = []
  const state = { live: true, paused: false, muted: false }
  let recording = ''
  let outstanding = 0
  const chain = new SegmentChain({
    flush: () => {
      const texts = heldFlush(recording, '')
      recording = ''
      if (!state.live) return
      posted.push(...texts)
    },
    onOutstanding: (n) => {
      outstanding = n
    },
  })
  const hear = () => {
    const d = deferred()
    chain.enqueue(() =>
      d.promise.then((text) => {
        if (mayHold({ ...state, draining: chain.draining })) {
          const grown = heldWith(recording, text)
          recording = grown.held
          if (grown.flush !== null) posted.push(grown.flush)
        }
      }),
    )
    return d
  }
  return {
    posted,
    state,
    chain,
    hear,
    recording: () => recording,
    outstanding: () => outstanding,
    mute: () => {
      state.muted = true
      return chain.close()
    },
    muteWithCut: () => {
      state.muted = true
      const cut = hear()
      return { cut, result: chain.close() }
    },
    unmute: () => {
      state.muted = false
      if (!chain.draining) recording = ''
    },
  }
}

describe('SegmentChain', () => {
  it('flushes at once when nothing is outstanding', () => {
    const p = page()
    p.state.muted = true
    expect(p.chain.close()).toBe('flushed')
    expect(p.chain.draining).toBe(false)
    expect(p.posted).toEqual([])
  })

  it('a mute with a segment in flight and an open utterance sends both, in order, as one turn', async () => {
    const p = page()
    const first = p.hear()
    const { cut, result } = p.muteWithCut()
    expect(result).toBe('draining')
    // Nothing posted at the press.
    expect(p.posted).toEqual([])
    cut.resolve('and then the cut')
    first.resolve('the first sentence')
    await settle()
    expect(p.posted).toEqual(['the first sentence and then the cut'])
    expect(p.chain.draining).toBe(false)
    expect(p.recording()).toBe('')
  })

  it('a segment already held goes in the same turn', async () => {
    const p = page()
    const held = p.hear()
    held.resolve('already here')
    await settle()
    const inFlight = p.hear()
    p.mute()
    inFlight.resolve('still coming')
    await settle()
    expect(p.posted).toEqual(['already here still coming'])
  })

  it('a pause still drops the late segment', async () => {
    const p = page()
    const inFlight = p.hear()
    p.state.paused = true
    inFlight.resolve('said into a pause')
    await settle()
    expect(p.recording()).toBe('')
    expect(p.posted).toEqual([])
  })

  it('ending the conversation drops the late segment and posts nothing', async () => {
    const p = page()
    const inFlight = p.hear()
    p.state.live = false
    p.mute()
    inFlight.resolve('said after the end')
    await settle()
    expect(p.posted).toEqual([])
  })

  it('an unmute before the drain finishes keeps order and loses nothing', async () => {
    const p = page()
    const old = p.hear()
    p.mute()
    p.unmute()
    // The new run's segment is queued behind the pending flush.
    const fresh = p.hear()
    fresh.resolve('new run')
    old.resolve('old run')
    await settle()
    expect(p.posted).toEqual(['old run'])
    expect(p.recording()).toBe('new run')
  })

  it('a second mute while the first is still draining sends two turns in order', async () => {
    const p = page()
    const old = p.hear()
    p.mute()
    p.unmute()
    const fresh = p.hear()
    expect(p.mute()).toBe('draining')
    fresh.resolve('second run')
    old.resolve('first run')
    await settle()
    expect(p.posted).toEqual(['first run', 'second run'])
    expect(p.chain.draining).toBe(false)
  })

  it('the pill reads transcribing… for the whole of a drain', async () => {
    const p = page()
    const first = p.hear()
    const { cut } = p.muteWithCut()
    const pill = () =>
      statusPill({
        speaking: false,
        blocked: false,
        stalled: false,
        heard: p.outstanding() > 0 || p.recording() !== '',
        transcribing: p.outstanding() > 0,
      })
    expect(pill()).toBe('transcribing…')
    first.resolve('one')
    await settle()
    expect(pill()).toBe('transcribing…')
    cut.resolve('two')
    await settle()
    expect(p.posted).toEqual(['one two'])
    expect(pill()).toBe(null)
  })

  it('a failed step ends and the chain carries on', async () => {
    const p = page()
    p.chain.enqueue(() => Promise.reject(new Error('auris fell over')))
    const next = p.hear()
    p.mute()
    next.resolve('after the failure')
    await settle()
    expect(p.posted).toEqual(['after the failure'])
    expect(p.outstanding()).toBe(0)
  })
})

describe('mayHold', () => {
  const base = { live: true, paused: false, muted: false, draining: false }

  it('holds an ordinary segment', () => {
    expect(mayHold(base)).toBe(true)
  })

  it('drops once the conversation has ended, draining or not', () => {
    expect(mayHold({ ...base, live: false })).toBe(false)
    expect(mayHold({ ...base, live: false, muted: true, draining: true })).toBe(false)
  })

  it('drops on a pause, draining or not', () => {
    expect(mayHold({ ...base, paused: true })).toBe(false)
    expect(mayHold({ ...base, paused: true, muted: true, draining: true })).toBe(false)
  })

  it('drops on a mute unless the switch is still draining', () => {
    expect(mayHold({ ...base, muted: true })).toBe(false)
    expect(mayHold({ ...base, muted: true, draining: true })).toBe(true)
  })
})
