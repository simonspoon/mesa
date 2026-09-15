/**
 * The order every heard segment settles in, and what the listen switch going
 * off does to the ones still on their way (mesa task 1154).
 *
 * Segments are transcribed **in order** — chained one after another, so two
 * overlapping posts to `/api/live/transcribe` can never land the halves of one
 * thought the wrong way round. Before this module that chain was local to one
 * run of the capture effect, and the person's own switch was the one teardown
 * that lost text: the press flushed the recording at once, so a segment still
 * in flight — and the utterance the teardown cut with `vadCut` — settled after
 * the mute and failed the delivery-time gate. The chain now outlives a capture
 * run: every run enqueues onto the tail of the last, `close()` is the switch,
 * and a flush that has to wait is one more step in the same order — old
 * segments, then the flush as one turn, then whatever the next run hears — so
 * a mute, an unmute and a second mute cannot interleave what they send.
 *
 * Deliberately not the recording itself: the held text stays in `LiveHub`'s
 * own state, folded through `heldWith` exactly as before. This is only the
 * sequencing and the two counts the gate below needs.
 */
export interface SegmentChainHooks {
  flush: () => void
  onOutstanding?: (n: number) => void
}

export class SegmentChain {
  private tail: Promise<void> = Promise.resolve()
  private inFlight = 0
  private pendingFlushes = 0
  private readonly hooks: SegmentChainHooks

  /**
   * `flush` posts the recording held so far and lets go of it; `onOutstanding`
   * is told the new count each time a segment is queued or settles, which is
   * what keeps the status pill on "transcribing…" for the whole of a drain.
   */
  constructor(hooks: SegmentChainHooks) {
    this.hooks = hooks
  }

  /** Segments queued or in flight — a count, not a flag, like `hearing`. */
  get outstanding(): number {
    return this.inFlight
  }

  /**
   * Whether a switch-off is still waiting on this chain. A count underneath,
   * not a flag: a mute, an unmute and a second mute leave two flushes pending,
   * and the first running must not read as the second having finished.
   */
  get draining(): boolean {
    return this.pendingFlushes > 0
  }

  /** One segment's transcription, run once every earlier step has settled. */
  enqueue(step: () => Promise<void>): void {
    this.count(1)
    this.tail = this.tail
      .then(step)
      // A step that failed still ends: the chain's job is order, and a bad
      // segment must not hold every later one — `send` reports its own error.
      .catch(() => {})
      .then(() => this.count(-1))
  }

  /**
   * The listen switch going off. Nothing outstanding means the flush is now,
   * exactly as it always was; otherwise it is the next step after the last
   * segment already heard, and `draining` says so until then.
   */
  close(): 'flushed' | 'draining' {
    if (this.inFlight === 0) {
      this.hooks.flush()
      return 'flushed'
    }
    this.pendingFlushes += 1
    this.tail = this.tail.then(() => {
      this.pendingFlushes -= 1
      this.hooks.flush()
    })
    return 'draining'
  }

  private count(delta: number): void {
    this.inFlight += delta
    this.hooks.onOutstanding?.(this.inFlight)
  }
}

/**
 * The delivery-time gate: whether a segment that has just come back from the
 * transcriber still belongs to a recording that will be sent.
 *
 * A conversation that ended and a pause both drop it — neither is a recording
 * that will be sent, and the pause is the person saying "hear nothing from
 * me" over the very sentence they were saying. A mute drops it too, *unless*
 * the switch is still draining: then the segment was heard before the press
 * and is what the person said last, so it is folded in for the flush queued
 * behind it. Only the person's own switch drains; mesa starting to speak
 * (task 961's `outlives`) has no press and no pending flush, and pause and end
 * keep their verdict whatever the chain is doing.
 */
export function mayHold(input: {
  live: boolean
  paused: boolean
  muted: boolean
  draining: boolean
}): boolean {
  return input.live && !input.paused && (!input.muted || input.draining)
}
