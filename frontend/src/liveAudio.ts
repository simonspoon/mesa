/**
 * Page-side audio capture, encoded to the WAV shape `auris` expects on stdin
 * (mesa task 956).
 *
 * Until now the live conversation heard the person through the browser's own
 * `SpeechRecognition` — this module is what replaces the microphone half of
 * that: an `AudioWorkletProcessor` hands the main thread raw `Float32Array`
 * blocks, and the functions here turn a *window* of those blocks into the
 * WAV bytes `POST /api/live/transcribe` accepts as base64 (`src/core/listen.rs`
 * hands them to `auris` byte-identical on stdin). `liveVad.ts` decides which
 * window is worth transcribing; this module is pure plumbing with no opinion
 * about speech.
 *
 * A few things here are decisions rather than arithmetic:
 *
 * - **16 kHz mono.** Speech models want it, a browser `AudioContext` is
 *   usually 44.1 or 48 kHz, and every extra sample is bytes the 25 MB route
 *   cap burns through for no gain — so capture is downsampled once, here,
 *   rather than sent at capture rate.
 * - **Frames carry `Date.now()`, not `AudioContext.currentTime`.** LiveHub's
 *   existing silence timer (`shouldFlushSilence`) and the VAD both need to
 *   answer "when", and there should be one clock answering that question, not
 *   an audio clock and a wall clock that can drift apart across a long
 *   conversation.
 * - **The cut between utterances is at a block boundary, not a sample.** A
 *   worklet block is a few milliseconds; snapping to one costs at most that
 *   much extra silence on either edge of a segment, which is far cheaper than
 *   a sample-exact cut that risks slicing through the first consonant.
 */

/** What every capture is resampled to before it is encoded and sent. */
export const TARGET_SAMPLE_RATE = 16000

/** One block of mono audio out of the worklet. */
export interface CapturedFrame {
  /** `Date.now()` when the page received this block — see the module doc. */
  at: number
  samples: Float32Array
}

/** Root-mean-square level of a block: what the VAD and the level meter read. */
export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0
  }
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i]
  }
  return Math.sqrt(sumSquares / samples.length)
}

/**
 * Linear-interpolation resample. Never upsamples — `fromRate < toRate`
 * returns `samples` unchanged, since inventing samples adds no information
 * and auris is happy with any rate; this function exists only to stop paying
 * for capture-rate audio we do not need.
 */
export function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate || samples.length === 0) {
    return samples
  }
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(samples.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio
    const lo = Math.floor(srcIndex)
    const hi = Math.min(lo + 1, samples.length - 1)
    const frac = srcIndex - lo
    out[i] = samples[lo] + (samples[hi] - samples[lo]) * frac
  }
  return out
}

/**
 * Float samples (`-1..1`) to signed 16-bit PCM. Clamped before scaling, and
 * scaled asymmetrically (negative by 0x8000, positive by 0x7fff) so a
 * full-scale positive sample cannot wrap to the opposite sign.
 */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}

/**
 * A canonical 44-byte RIFF/WAVE header (mono, 16-bit PCM) plus little-endian
 * samples — the exact byte shape `src/core/listen.rs` hands `auris` on
 * stdin.
 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length * 2
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  writeTag(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeTag(view, 8, 'WAVE')
  writeTag(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeTag(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * 2, pcm[i], true)
  }
  return bytes
}

function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i++) {
    view.setUint8(offset + i, tag.charCodeAt(i))
  }
}

/**
 * The samples of every frame whose `at` falls in `[fromAt, toAt]`, joined in
 * order. The window is whole frames, not a sample-exact slice — see the
 * module doc.
 */
export function concatFrames(frames: readonly CapturedFrame[], fromAt: number, toAt: number): Float32Array {
  const matching = frames.filter((frame) => frame.at >= fromAt && frame.at <= toAt)
  const total = matching.reduce((sum, frame) => sum + frame.samples.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of matching) {
    out.set(frame.samples, offset)
    offset += frame.samples.length
  }
  return out
}

/**
 * The rolling buffer's bound: every frame at or after `at`. Without this a
 * page listening for an hour would hold an hour of audio rather than the
 * handful of seconds any one segment needs.
 */
export function dropBefore(frames: readonly CapturedFrame[], at: number): CapturedFrame[] {
  return frames.filter((frame) => frame.at >= at)
}

/**
 * The one call the hub makes: window, downsample to `TARGET_SAMPLE_RATE`,
 * quantize, encode. When the window is empty the result is still a valid
 * (header-only) WAV — the caller is expected to check for that rather than
 * post silence to the transcribe route.
 */
export function wavFromFrames(
  frames: readonly CapturedFrame[],
  fromAt: number,
  toAt: number,
  sampleRate: number,
): Uint8Array {
  const windowed = concatFrames(frames, fromAt, toAt)
  const resampled = downsample(windowed, sampleRate, TARGET_SAMPLE_RATE)
  return encodeWav(toPcm16(resampled), TARGET_SAMPLE_RATE)
}

/**
 * Chunked `btoa`: `String.fromCharCode(...bytes)` blows the call-argument
 * limit on a megabyte of audio, so this feeds it 8 KiB at a time.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 8192
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const chunk = bytes.subarray(offset, offset + CHUNK)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/**
 * Whether this browser can be the way in at all. Takes the global as an
 * argument rather than reading `window` itself, exactly the way
 * `liveRecognition.ts::recognitionCtor` does, and for the same reason: a
 * pure predicate over an injected scope is testable in jsdom without touching
 * a real global.
 */
export function capturesAudio(scope: Record<string, unknown> | null | undefined): boolean {
  if (!scope) {
    return false
  }
  const mediaDevices = (scope.navigator as { mediaDevices?: { getUserMedia?: unknown } } | undefined)?.mediaDevices
  const hasGetUserMedia = typeof mediaDevices?.getUserMedia === 'function'
  const hasAudioContext = typeof scope.AudioContext === 'function' || typeof scope.webkitAudioContext === 'function'
  const hasWorklet = typeof scope.AudioWorkletNode === 'function'
  return hasGetUserMedia && hasAudioContext && hasWorklet
}

/**
 * Whether a `getUserMedia` rejection is the microphone being **refused** —
 * terminal for the page — or one of the ordinary failures capture recovers
 * from. Only `'NotAllowedError'` (the person or the browser's policy said no)
 * and `'SecurityError'` are permanent; `'NotFoundError'`, `'OverconstrainedError'`
 * and `'NotReadableError'` (a device unplugged, a constraint nothing matches,
 * another application holding the input) all fall back to the default device
 * rather than ending listening.
 *
 * This is the `getUserMedia` twin of `liveRecognition.ts::isBlockingError`,
 * which judges the same decision over a `SpeechRecognition` error *code*
 * (`'not-allowed'`) rather than a `DOMException.name` — different browser
 * API, different vocabulary, so it stays a separate function rather than one
 * that has to know both.
 */
export function isMicRefusal(name: string): boolean {
  return name === 'NotAllowedError' || name === 'SecurityError'
}

/**
 * Source of an `AudioWorkletProcessor` named `mesa-pcm`, loaded from a
 * `blob:` URL rather than a served asset — mesa's pages carry no CSP that
 * would forbid a blob worklet, and a blob keeps this off Vite's asset
 * pipeline and out of the rust-embed `dist` plumbing.
 */
export const PCM_WORKLET_SOURCE = `
class MesaPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length > 0) {
      // The worklet reuses its internal buffer across calls, so posting it
      // raw would hand the main thread a block that may already have been
      // overwritten by the time it reads it. The copy is what makes each
      // posted frame the block it actually captured.
      this.port.postMessage(new Float32Array(channel))
    }
    return true
  }
}
registerProcessor('mesa-pcm', MesaPcmProcessor)
`
