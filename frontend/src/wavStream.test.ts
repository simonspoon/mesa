import { describe, expect, it } from 'vitest'
import { createWavDecoder, parseWavHeader } from './wavStream'

/** The header mesa's speak route emits: 16-bit PCM, mono, patched sizes. */
function header(channels = 1, sampleRate = 24000): Uint8Array {
  const bytes = new Uint8Array(44)
  const view = new DataView(bytes.buffer)
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  put(0, 'RIFF')
  view.setUint32(4, 0x7fff002c, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  put(36, 'data')
  view.setUint32(40, 0x7fff_0000, true)
  return bytes
}

function pcm(...samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((s, i) => view.setInt16(i * 2, s, true))
  return bytes
}

describe('parseWavHeader', () => {
  it('reads the format and where the audio starts', () => {
    expect(parseWavHeader(header())).toEqual({
      channels: 1,
      sampleRate: 24000,
      dataOffset: 44,
    })
  })

  it('waits rather than guessing while the header is incomplete', () => {
    expect(parseWavHeader(header().subarray(0, 8))).toBeNull()
    expect(parseWavHeader(header().subarray(0, 40))).toBeNull()
  })

  it('skips chunks between fmt and data', () => {
    const extra = new Uint8Array(44 + 12)
    extra.set(header().subarray(0, 36))
    const view = new DataView(extra.buffer)
    const put = (at: number, text: string) => {
      for (let i = 0; i < text.length; i++)
        view.setUint8(at + i, text.charCodeAt(i))
    }
    put(36, 'LIST')
    view.setUint32(40, 4, true)
    put(48, 'data')
    view.setUint32(52, 0x7fff_0000, true)
    expect(parseWavHeader(extra)?.dataOffset).toBe(56)
  })

  it('rejects a body that is not a WAV at all', () => {
    const text = new TextEncoder().encode('error: no model found\n')
    expect(() => parseWavHeader(text)).toThrow(/WAV/)
  })

  it('rejects a format nothing here converts', () => {
    const other = header()
    new DataView(other.buffer).setUint16(34, 32, true)
    expect(() => parseWavHeader(other)).toThrow(/16-bit/)
  })
})

describe('createWavDecoder', () => {
  it('answers nothing until the header is complete', () => {
    const decoder = createWavDecoder()
    const whole = new Uint8Array([...header(), ...pcm(0x4000)])
    expect(decoder.push(whole.subarray(0, 20))).toBeNull()
    const out = decoder.push(whole.subarray(20))
    expect(out?.format).toEqual({ channels: 1, sampleRate: 24000 })
    expect(Array.from(out?.samples ?? [])).toEqual([0.5])
  })

  it('carries a sample its chunk cut in half', () => {
    const decoder = createWavDecoder()
    decoder.push(header())
    const split = pcm(-0x8000, 0x4000)
    expect(Array.from(decoder.push(split.subarray(0, 3))?.samples ?? [])).toEqual(
      [-1],
    )
    expect(Array.from(decoder.push(split.subarray(3))?.samples ?? [])).toEqual([
      0.5,
    ])
  })

  it('answers an empty chunk when nothing whole arrived', () => {
    const decoder = createWavDecoder()
    decoder.push(header())
    expect(decoder.push(pcm(1).subarray(0, 1))?.samples.length).toBe(0)
  })

  it('keeps the format of a stereo body', () => {
    const decoder = createWavDecoder()
    expect(decoder.push(header(2, 48000))?.format).toEqual({
      channels: 2,
      sampleRate: 48000,
    })
  })
})
