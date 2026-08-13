/**
 * Playing the inbox's speak route on a browser whose media stack will not
 * (mesa task 830).
 *
 * Apple's requires byte-range support of an HTTP media source, and this route
 * is chunked with no `Content-Length` because the render is still happening —
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
 * What lives here is the imperative half — a fetch, a clock, and scheduled
 * source nodes. The arithmetic worth pinning is in `speechPlayback.ts`.
 */

import { fetchInboxSpeech } from './api'
import { replaySlices, rewindTarget, scheduleAt } from './speechPlayback'
import { createWavDecoder, type WavFormat } from './wavStream'

/** What the caller needs told; the rest it drives itself. */
export interface SpeechStreamEvents {
  /** The first samples are scheduled, so the item is about to sound. */
  onPlaying: () => void
  /** The body ended and the last sample has been heard. */
  onEnded: () => void
  /**
   * The item never sounded and now never will: the body was not audio this
   * module can decode, or it failed before a single sample. Reading the body
   * outlives the call that started it, so a failure this late has nowhere else
   * to go — and a press that shows nothing is indistinguishable from one still
   * synthesising. A failure *after* the sound started is not this: the item
   * ends early, exactly as a truncated stream does for the element.
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
 * Starts reading inbox item `id` on `ctx` and hands back its transport.
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
  id: number,
  ctx: AudioContext,
  events: SpeechStreamEvents,
  signal: AbortSignal,
): Promise<SpeechStream> {
  const body = await fetchInboxSpeech(id, signal)

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
  let complete = false
  let started = false
  let stopped = false

  const decoder = createWavDecoder()
  const reader = body.getReader()

  function schedule(buffer: AudioBuffer, from: number, at: number) {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    live.add(source)
    source.onended = () => {
      live.delete(source)
      // The last sample of a body that has all arrived is the end of the item.
      if (complete && live.size === 0 && !stopped) events.onEnded()
    }
    source.start(at, from)
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
    if (!started) {
      // The first buffer sets the clock: everything after it is measured from
      // where this one was put.
      origin = scheduleAt(ctx.currentTime, ctx.currentTime)
      started = true
      events.onPlaying()
    }
    const at = scheduleAt(ctx.currentTime, origin + filled)
    // Late is silence the listener already heard: the item did not get shorter,
    // so the clock slips rather than the audio being dropped.
    origin += at - (origin + filled)
    played.push({ buffer, at: filled })
    schedule(buffer, 0, at)
    filled += buffer.duration
  }

  // Reading runs on after this function returns: the body arrives for as long
  // as the synthesiser keeps writing.
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || stopped) break
        const chunk = decoder.push(value)
        if (chunk !== null) append(chunk.samples, chunk.format)
      }
    } catch (err) {
      // Everything the body can be wrong about surfaces here — bytes that are
      // not a WAV, a format nothing decodes, a connection that dropped — and
      // by now the call that started this has long since returned.
      complete = true
      if (stopped) return
      if (!started) {
        events.onError(err instanceof Error ? err : new Error(String(err)))
        return
      }
      // It was already sounding, so the item just ends where the audio does;
      // what is still scheduled plays out and `onEnded` follows it.
      if (live.size === 0) events.onEnded()
      return
    }
    complete = true
    // A body that ended before a single sample — a synthesiser that wrote only
    // a header — has nothing to wait for.
    if (!stopped && live.size === 0) events.onEnded()
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
      void reader.cancel().catch(() => {})
      for (const source of live) {
        source.onended = null
        source.stop()
      }
      live.clear()
    },
  }
}
