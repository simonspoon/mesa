/**
 * Playing one of mesa's speak routes on a browser whose media stack will not
 * (mesa task 830) — the inbox's item route, or the live page's turn route.
 *
 * Apple's requires byte-range support of an HTTP media source, and these routes
 * are chunked with no `Content-Length` because the render is still happening —
 * so `<audio src>` there fails outright (task 829) and the first fix was to
 * fetch the audio whole, which meant waiting for the last sentence. The page
 * can instead decode the bytes itself: `fetch` streams the body, `wavStream`
 * turns each chunk into samples, and each one is scheduled on the Web Audio
 * clock as it lands. No range request is ever involved, so nothing about the
 * route has to change and the first sentence still starts in a couple of
 * seconds.
 *
 * The `AudioContext` is the caller's, created and resumed inside the press:
 * the gesture is what unlocks audio, and the failure that sends a press down
 * this path arrives from the element *after* the gesture is gone.
 *
 * The synthesiser writes at roughly real time and its first chunk carries
 * under a tenth of a second (mesa task 1146), so decoded audio is **held**
 * rather than scheduled as it lands: nothing sounds until `PREBUFFER_SECONDS`
 * of it is queued or the body has ended, and an underrun — every scheduled
 * source ended with the body still open — goes back to holding on the same
 * terms rather than starting on the next single chunk with a lead of a few
 * hundred milliseconds. Neither ends the item; only the body's end does, once
 * the last of what it sent has been heard, and what was held at that moment
 * is scheduled and played out first. A body that stops arriving altogether —
 * a hung synthesiser — is given up on after `STALL_SECONDS` and treated as
 * ended, so a turn that never closes cannot wedge the live queue behind it.
 * The listener hears a longer first wait and, on a stall, a gap; never a
 * sample dropped and never a turn cut short.
 *
 * What lives here is the imperative half — a fetch, a clock, and scheduled
 * source nodes. The arithmetic worth pinning is in `speechPlayback.ts`.
 */

import { fetchSpeech } from './api'
import {
  readyToStart,
  replaySlices,
  rewindTarget,
  scheduleAt,
  STALL_SECONDS,
} from './speechPlayback'
import { createWavDecoder, type WavFormat } from './wavStream'

/** What the caller needs told; the rest it drives itself. */
export interface SpeechStreamEvents {
  /**
   * The first samples are scheduled, so the item is about to sound — after
   * enough of it has been held to ride out a pause in the render.
   */
  onPlaying: () => void
  /**
   * The body ended (or stopped arriving) and the last sample has been heard.
   * An underrun is not this: the audio pauses and carries on.
   */
  onEnded: () => void
  /**
   * The item never sounded and now never will: the body was not audio this
   * module can decode, or it failed before a single sample. Reading the body
   * outlives the call that started it, so a failure this late has nowhere else
   * to go — and a press that shows nothing is indistinguishable from one still
   * synthesising. A failure *after* something decoded is not this: what is
   * held plays out and the item ends early, exactly as a truncated stream
   * does for the element.
   */
  onError: (error: Error) => void
}

/** One item being read: the transport, over decoded audio the page holds. */
export interface SpeechStream {
  /** Holds the audio where it is. */
  pause: () => Promise<void>
  /** Lets it run on. */
  resume: () => Promise<void>
  /** Back a step, floored at the start — every sample is still in hand. */
  rewind: () => void
  /** Drops the body still arriving and silences what is scheduled. */
  stop: () => void
}

/**
 * Starts reading the audio at `url` on `ctx` and hands back its transport.
 *
 * A URL rather than an inbox id (mesa task 855): the same decoding serves the
 * inbox's item route and the live page's turn route, and neither of them is
 * this module's business.
 *
 * The returned promise rejects only for what is known before the body is read
 * — the route's own error, which is the reason the row shows. Everything the
 * decoding can go wrong at happens after this resolves, and is reported
 * through `onError` instead.
 *
 * `signal` belongs to the caller and aborts the request itself: the transport
 * that can stop this does not exist until the response headers arrive, and the
 * route holds those back until the synthesiser's first audio, so a press that
 * is abandoned in that window has nothing else to cancel it.
 */
export async function playSpeechStream(
  url: string,
  ctx: AudioContext,
  events: SpeechStreamEvents,
  signal: AbortSignal,
): Promise<SpeechStream> {
  const body = await fetchSpeech(url, signal)

  // Every decoded buffer, kept with where it starts in the item: rewinding is
  // re-scheduling from that point, so the audio already heard has to stay.
  const played: { buffer: AudioBuffer; at: number }[] = []
  const live = new Set<AudioBufferSourceNode>()
  // The context time the item's first sample sits at. Everything the transport
  // knows is read off this: the playhead is `ctx.currentTime - origin`. A gap
  // the network forced moves the origin rather than the schedule.
  let origin = 0
  // How much audio has been scheduled, in item seconds.
  let filled = 0
  // Decoded audio not yet on the clock, and how many seconds of it there are:
  // the lead the player waits for before it starts, and again after an
  // underrun. Everything in it is ahead of `filled`, in order.
  let queue: AudioBuffer[] = []
  let queued = 0
  // Whether the next buffer waits in the queue or goes straight on the clock.
  // On until the first lead is held; on again whenever the schedule runs dry.
  let holding = true
  let complete = false
  let started = false
  let stopped = false
  let stall: ReturnType<typeof setTimeout> | null = null

  const decoder = createWavDecoder()
  const reader = body.getReader()

  function clearStall() {
    if (stall !== null) clearTimeout(stall)
    stall = null
  }

  // Re-armed on every chunk: a body that goes this long without a byte is a
  // synthesiser that hung, and cancelling the reader ends it the way a body
  // that closed would — the next `read()` reports `done`.
  function armStall() {
    clearStall()
    stall = setTimeout(() => {
      stall = null
      void reader.cancel().catch(() => {})
    }, STALL_SECONDS * 1000)
  }

  function ended() {
    return complete && queue.length === 0 && live.size === 0 && !stopped
  }

  function schedule(buffer: AudioBuffer, from: number, at: number) {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    live.add(source)
    source.onended = () => {
      live.delete(source)
      if (live.size > 0) return
      // The last sample of a body that has all arrived is the end of the item.
      // The schedule running dry with the body still open is an underrun:
      // hold what comes next until there is a lead again, and the clock slips
      // by the gap when it starts.
      if (ended()) events.onEnded()
      else if (!complete) holding = true
    }
    source.start(at, from)
  }

  /** Puts everything held on the clock, in order, after what is already there. */
  function flush() {
    if (queue.length === 0) return
    holding = false
    if (!started) {
      // The first buffer sets the clock: everything after it is measured from
      // where this one was put.
      origin = scheduleAt(ctx.currentTime, ctx.currentTime)
      started = true
      events.onPlaying()
    }
    for (const buffer of queue) {
      const at = scheduleAt(ctx.currentTime, origin + filled)
      // Late is silence the listener already heard: the item did not get
      // shorter, so the clock slips rather than the audio being dropped.
      origin += at - (origin + filled)
      played.push({ buffer, at: filled })
      schedule(buffer, 0, at)
      filled += buffer.duration
    }
    queue = []
    queued = 0
  }

  function append(samples: Float32Array, format: WavFormat) {
    if (samples.length === 0) return
    const frames = Math.floor(samples.length / format.channels)
    const buffer = ctx.createBuffer(format.channels, frames, format.sampleRate)
    for (let channel = 0; channel < format.channels; channel++) {
      const track = buffer.getChannelData(channel)
      for (let frame = 0; frame < frames; frame++) {
        track[frame] = samples[frame * format.channels + channel]
      }
    }
    queue.push(buffer)
    queued += buffer.duration
    if (!holding || readyToStart(queued, complete)) flush()
  }

  // Reading runs on after this function returns: the body arrives for as long
  // as the synthesiser keeps writing.
  void (async () => {
    try {
      armStall()
      for (;;) {
        const { done, value } = await reader.read()
        if (done || stopped) break
        armStall()
        const chunk = decoder.push(value)
        if (chunk !== null) append(chunk.samples, chunk.format)
      }
    } catch (err) {
      // Everything the body can be wrong about surfaces here — bytes that are
      // not a WAV, a format nothing decodes, a connection that dropped — and
      // by now the call that started this has long since returned.
      clearStall()
      complete = true
      if (stopped) return
      if (!started && queue.length === 0) {
        events.onError(err instanceof Error ? err : new Error(String(err)))
        return
      }
      // Something had decoded, so the item just ends where the audio does:
      // what is held goes on the clock, what is scheduled plays out, and
      // `onEnded` follows the last of it.
      flush()
      if (ended()) events.onEnded()
      return
    }
    clearStall()
    complete = true
    // The end of the body — or a stall the watchdog ended — is what starts a
    // short item, and what lets a held remainder play out. A body that ended
    // before a single sample — a synthesiser that wrote only a header — has
    // nothing to wait for.
    flush()
    if (ended()) events.onEnded()
  })()

  return {
    async pause() {
      // Suspending stops `currentTime` too, so the playhead keeps its meaning
      // across a hold of any length.
      await ctx.suspend()
    },
    async resume() {
      await ctx.resume()
    },
    rewind() {
      if (!started) return
      const target = rewindTarget(ctx.currentTime - origin, 0)
      if (target === null) return
      for (const source of live) {
        source.onended = null
        source.stop()
      }
      live.clear()
      const at = scheduleAt(ctx.currentTime, ctx.currentTime)
      origin = at - target
      const holding = played.map(({ buffer, at: start }) => ({
        at: start,
        duration: buffer.duration,
      }))
      for (const { index, from, delay } of replaySlices(holding, target)) {
        schedule(played[index].buffer, from, at + delay)
      }
    },
    stop() {
      stopped = true
      clearStall()
      queue = []
      queued = 0
      void reader.cancel().catch(() => {})
      for (const source of live) {
        source.onended = null
        source.stop()
      }
      live.clear()
    },
  }
}
