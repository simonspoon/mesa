/**
 * What the `live-cancel` key (Escape by default, mesa task 1354) does to a
 * live conversation: `'discard'` drops everything the microphone has heard
 * and not yet sent and mutes it, `'resume'` opens it again, `null` leaves the
 * keystroke to whatever else wants it.
 *
 * Offered on the listen switch's own terms — a live conversation this browser
 * has joined, with a microphone that could open — because outside them there
 * is nothing to discard or mute, and swallowing the busiest key on the
 * keyboard for nothing is worse than doing nothing. A **pause** stands it
 * down too: a pause keeps the held recording for Resume, so there is no
 * utterance in progress to throw away, and a mute laid under the pause would
 * silently outlast it.
 *
 * `'resume'` only undoes **its own** mute. A microphone the person shut with
 * the switch or the chord stays shut on Escape: Escape is the key a person
 * presses to back out of anything, and a stray one must never be what opens a
 * microphone the person closed on purpose.
 *
 * Two facts about the keystroke itself stand it down: another listener having
 * already claimed it (`defaultPrevented` — every Escape that closes a dialog,
 * a menu or a bar marks it, and the hub reads this after every listener has
 * run), and an IME composition, where Escape cancels the candidate.
 */
export type LiveCancelVerdict = 'discard' | 'resume' | null

export function liveCancelVerdict(input: {
  live: boolean
  joined: boolean
  supported: boolean
  blocked: boolean
  paused: boolean
  muted: boolean
  /** Whether the mute in force is this key's own. */
  mutedByCancel: boolean
  defaultPrevented: boolean
  composing: boolean
}): LiveCancelVerdict {
  if (input.defaultPrevented || input.composing) return null
  if (!input.live || !input.joined || !input.supported || input.blocked) return null
  if (input.paused) return null
  if (!input.muted) return 'discard'
  return input.mutedByCancel ? 'resume' : null
}

/**
 * Which heard speech a discard drops (mesa task 1354). Listening is cut into
 * **stretches**, each ended by one press of the person's: the switch off,
 * which *commits* the stretch — its segments are sent, some of them perhaps
 * only once a drain behind `auris` settles — or the discard key, which drops
 * it. Every capture run, either engine, notes the stretch it began in, and a
 * segment settling later asks whether that stretch was discarded.
 *
 * A stretch rather than a bare generation counter, because a committed
 * stretch must stay immune to every discard after it: speak, switch off with
 * a segment still at `auris`, switch on, Escape — the drain is still going to
 * post what the switch sent, and the Escape was about the new stretch only.
 */
export class DiscardLedger {
  private stretch = 0
  private readonly dropped = new Set<number>()

  /** The stretch a capture run starting now belongs to. */
  get current(): number {
    return this.stretch
  }

  /** The switch off: what this stretch heard is the person's to send. */
  commit(): void {
    this.stretch += 1
  }

  /** The discard key: nothing this stretch heard is sent, however late it lands. */
  discard(): void {
    this.dropped.add(this.stretch)
    this.stretch += 1
  }

  isDiscarded(stretch: number): boolean {
    return this.dropped.has(stretch)
  }
}
