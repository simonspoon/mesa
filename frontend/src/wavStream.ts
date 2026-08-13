/**
 * Decoding a streamed WAV body as it arrives (mesa task 830).
 *
 * The speak route answers a WAV whose sizes are placeholders — the real length
 * is unknowable while `kokoro-rs` is still rendering — so a browser that will
 * not play a range-less media source cannot use `<audio>` at all. The way to
 * still start on the first sentence is for the page to decode the bytes
 * itself: this module turns the arriving chunks into audio samples, and
 * `speechStream.ts` schedules them.
 *
 * Everything here is arithmetic over bytes: no `AudioContext`, no fetch, no
 * DOM. The two things that historically go wrong with a chunked decoder are
 * both boundary cases and both tested — a header split across chunks, and a
 * chunk that ends half-way through a sample.
 */

/** What the header says about the samples that follow. */
export interface WavFormat {
  sampleRate: number
  /** Interleaved channel count; `kokoro-rs` writes mono. */
  channels: number
}

/** The header, and where in the accumulated bytes the audio starts. */
interface WavHeader extends WavFormat {
  dataOffset: number
}

/** How far into the body a `data` chunk header is still looked for. */
const HEADER_CAP = 64 * 1024

/** 16-bit PCM is the only shape this route emits, so the only one decoded. */
const PCM_FORMAT = 1
const PCM_BITS = 16

/**
 * Reads the RIFF header out of `bytes`, or `null` while there is not enough of
 * it yet. Throws when the bytes are not a WAV this module can play — a
 * synthesiser printing an error on stdout, or a format nothing here converts.
 *
 * The declared sizes are ignored on purpose: mesa patches them to an open-ended
 * `0x7FFF0000` precisely because the truth is not known when the header goes
 * out, so the audio ends where the body does and nowhere else.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader | null {
  if (bytes.length < 12) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') {
    throw new Error('the audio did not arrive as a WAV')
  }
  let format: WavFormat | null = null
  // Walk the chunk list rather than assuming the canonical 44-byte layout: a
  // producer may put its own chunks between `fmt ` and `data`.
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(view, at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) return null
      const code = view.getUint16(body, true)
      const bits = view.getUint16(body + 14, true)
      if (code !== PCM_FORMAT || bits !== PCM_BITS) {
        throw new Error('the audio is not 16-bit PCM')
      }
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
      }
    } else if (id === 'data') {
      if (format === null) throw new Error('the audio declared no format')
      return { ...format, dataOffset: body }
    }
    // A streamed `data` size is a placeholder, so it may not be skipped over —
    // but every chunk ahead of it declares its real length. Chunks are
    // word-aligned.
    at = body + size + (size % 2)
  }
  if (bytes.length > HEADER_CAP) {
    throw new Error('the audio did not arrive as a WAV')
  }
  return null
}

/** Samples handed back by one `push`, once the format is known. */
export interface WavChunk {
  format: WavFormat
  /** Interleaved, `-1..1`. Empty when a chunk carried no whole sample. */
  samples: Float32Array
}

/**
 * A decoder fed the body chunk by chunk. Answers `null` until the header is
 * complete, then a chunk of samples per push — including an empty one, which
 * is a real answer (a chunk can be a single byte of a sample).
 */
export interface WavDecoder {
  push(chunk: Uint8Array): WavChunk | null
}

export function createWavDecoder(): WavDecoder {
  // Before the header: the bytes seen so far, since it may span chunks. After
  // it: at most one byte, the odd half of a sample that its chunk cut through.
  let pending: Uint8Array = new Uint8Array(0)
  let format: WavFormat | null = null

  return {
    push(chunk) {
      let bytes = concat(pending, chunk)
      if (format === null) {
        const header = parseWavHeader(bytes)
        if (header === null) {
          pending = bytes
          return null
        }
        format = { channels: header.channels, sampleRate: header.sampleRate }
        bytes = bytes.subarray(header.dataOffset)
      }
      const whole = bytes.length - (bytes.length % 2)
      pending = bytes.subarray(whole)
      return { format, samples: toFloat32(bytes.subarray(0, whole)) }
    },
  }
}

/** Little-endian signed 16-bit samples as floats. */
function toFloat32(bytes: Uint8Array): Float32Array {
  const samples = new Float32Array(bytes.length / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail
  const joined = new Uint8Array(head.length + tail.length)
  joined.set(head)
  joined.set(tail, head.length)
  return joined
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  )
}
