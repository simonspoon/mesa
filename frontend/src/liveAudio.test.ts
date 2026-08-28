import { describe, expect, it } from 'vitest'
import {
  capturesAudio,
  concatFrames,
  downsample,
  dropBefore,
  encodeWav,
  frameRms,
  isMicRefusal,
  TARGET_SAMPLE_RATE,
  toBase64,
  toPcm16,
  wavFromFrames,
  type CapturedFrame,
} from './liveAudio'
import { parseWavHeader } from './wavStream'

describe('frameRms', () => {
  it('is 0 for an empty block', () => {
    expect(frameRms(new Float32Array(0))).toBe(0)
  })

  it('computes the root-mean-square of a known block', () => {
    // rms of [3, 4] scaled: sqrt((9 + 16) / 2) = sqrt(12.5)
    expect(frameRms(new Float32Array([3, 4]))).toBeCloseTo(Math.sqrt(12.5))
  })
})

describe('downsample', () => {
  it('returns the input unchanged when the rates are equal', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3])
    expect(downsample(samples, 16000, 16000)).toBe(samples)
  })

  it('refuses to upsample, returning the input as-is', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3])
    expect(downsample(samples, 16000, 48000)).toBe(samples)
  })

  it('halves a 32 kHz ramp to 16 kHz', () => {
    const samples = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25])
    const out = downsample(samples, 32000, 16000)
    expect(out.length).toBe(4)
    expect(Array.from(out)).toEqual([0, 0.5, 1, 0.5])
  })
})

describe('toPcm16', () => {
  it('clamps at +1 to 0x7fff, never wrapping to negative', () => {
    const out = toPcm16(new Float32Array([1, 2, 100]))
    expect(out[0]).toBe(0x7fff)
    expect(out[1]).toBe(0x7fff)
    expect(out[2]).toBe(0x7fff)
  })

  it('clamps at -1 to -0x8000', () => {
    const out = toPcm16(new Float32Array([-1, -2, -100]))
    expect(out[0]).toBe(-0x8000)
    expect(out[1]).toBe(-0x8000)
    expect(out[2]).toBe(-0x8000)
  })

  it('scales an in-range sample', () => {
    const out = toPcm16(new Float32Array([0.5, -0.5, 0]))
    expect(out[0]).toBe(Math.trunc(0.5 * 0x7fff))
    expect(out[1]).toBe(Math.trunc(-0.5 * 0x8000))
    expect(out[2]).toBe(0)
  })
})

describe('encodeWav', () => {
  it('produces a header parseWavHeader reads back', () => {
    const pcm = new Int16Array([1, -1, 100, -100])
    const bytes = encodeWav(pcm, 16000)
    expect(bytes.length).toBe(44 + pcm.length * 2)

    const view = new DataView(bytes.buffer)
    const tag = (offset: number) =>
      String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    expect(tag(0)).toBe('RIFF')
    expect(tag(8)).toBe('WAVE')
    expect(tag(12)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM format
    expect(view.getUint16(22, true)).toBe(1) // channels
    expect(view.getUint32(24, true)).toBe(16000) // sample rate
    expect(view.getUint32(28, true)).toBe(16000 * 2) // byte rate (mono, 16-bit)
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(tag(36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(pcm.length * 2)

    const header = parseWavHeader(bytes)
    expect(header).toEqual({ channels: 1, sampleRate: 16000, dataOffset: 44 })
  })

  it('is valid (header-only) even with zero samples', () => {
    const bytes = encodeWav(new Int16Array(0), 16000)
    expect(bytes.length).toBe(44)
    expect(parseWavHeader(bytes)).toEqual({ channels: 1, sampleRate: 16000, dataOffset: 44 })
  })
})

function frame(at: number, values: number[]): CapturedFrame {
  return { at, samples: new Float32Array(values) }
}

describe('concatFrames', () => {
  it('joins only frames within the window, in order', () => {
    const frames = [frame(0, [1]), frame(10, [2, 3]), frame(20, [4]), frame(30, [5])]
    expect(Array.from(concatFrames(frames, 10, 20))).toEqual([2, 3, 4])
  })

  it('is inclusive of both bounds', () => {
    const frames = [frame(10, [1]), frame(20, [2])]
    expect(Array.from(concatFrames(frames, 10, 20))).toEqual([1, 2])
  })

  it('is empty when nothing falls in the window', () => {
    const frames = [frame(0, [1]), frame(100, [2])]
    expect(Array.from(concatFrames(frames, 40, 60))).toEqual([])
  })
})

describe('dropBefore', () => {
  it('keeps only frames at or after the cutoff', () => {
    const frames = [frame(0, [1]), frame(10, [2]), frame(20, [3])]
    expect(dropBefore(frames, 10)).toEqual([frame(10, [2]), frame(20, [3])])
  })
})

describe('wavFromFrames', () => {
  it('produces a parseable header at TARGET_SAMPLE_RATE end to end', () => {
    const frames = [frame(0, [0, 0.5, 1, 0.5]), frame(10, [0, -0.5, -1, -0.5])]
    const bytes = wavFromFrames(frames, 0, 10, 32000)
    const header = parseWavHeader(bytes)
    expect(header).not.toBeNull()
    expect(header?.sampleRate).toBe(TARGET_SAMPLE_RATE)
    expect(header?.channels).toBe(1)
  })

  it('is a valid header-only WAV when the window is empty', () => {
    const frames = [frame(0, [1, 2, 3])]
    const bytes = wavFromFrames(frames, 100, 200, 32000)
    expect(parseWavHeader(bytes)).toEqual({ channels: 1, sampleRate: TARGET_SAMPLE_RATE, dataOffset: 44 })
  })
})

describe('toBase64', () => {
  it('round-trips through atob for a buffer over 8 KiB', () => {
    const bytes = new Uint8Array(20000)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256
    }
    const encoded = toBase64(bytes)
    const decoded = atob(encoded)
    expect(decoded.length).toBe(bytes.length)
    for (let i = 0; i < bytes.length; i += 997) {
      expect(decoded.charCodeAt(i)).toBe(bytes[i])
    }
  })
})

describe('isMicRefusal', () => {
  it('is true for NotAllowedError and SecurityError', () => {
    expect(isMicRefusal('NotAllowedError')).toBe(true)
    expect(isMicRefusal('SecurityError')).toBe(true)
  })

  it('is false for the ordinary failures capture recovers from', () => {
    expect(isMicRefusal('NotFoundError')).toBe(false)
    expect(isMicRefusal('OverconstrainedError')).toBe(false)
    expect(isMicRefusal('NotReadableError')).toBe(false)
  })
})

describe('capturesAudio', () => {
  it('is false with no scope', () => {
    expect(capturesAudio(null)).toBe(false)
    expect(capturesAudio(undefined)).toBe(false)
  })

  it('is false when any of the three pieces is missing', () => {
    expect(capturesAudio({ AudioContext: function () {}, AudioWorkletNode: function () {} })).toBe(false)
    expect(
      capturesAudio({
        navigator: { mediaDevices: { getUserMedia: () => {} } },
        AudioWorkletNode: function () {},
      }),
    ).toBe(false)
    expect(
      capturesAudio({
        navigator: { mediaDevices: { getUserMedia: () => {} } },
        AudioContext: function () {},
      }),
    ).toBe(false)
  })

  it('is true when getUserMedia, an AudioContext and AudioWorkletNode are all present', () => {
    expect(
      capturesAudio({
        navigator: { mediaDevices: { getUserMedia: () => {} } },
        AudioContext: function () {},
        AudioWorkletNode: function () {},
      }),
    ).toBe(true)
  })

  it('accepts webkitAudioContext in place of AudioContext', () => {
    expect(
      capturesAudio({
        navigator: { mediaDevices: { getUserMedia: () => {} } },
        webkitAudioContext: function () {},
        AudioWorkletNode: function () {},
      }),
    ).toBe(true)
  })
})
