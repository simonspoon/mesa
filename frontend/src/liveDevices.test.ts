import { beforeEach, describe, expect, it } from 'vitest'
import {
  audioInputs,
  chosenInput,
  DEFAULT_INPUT,
  inputLabel,
  offersInputChoice,
  readInputChoice,
  sameInputs,
  writeInputChoice,
  type AudioInput,
  type DeviceLike,
} from './liveDevices'

function device(kind: string, deviceId: string, label = ''): DeviceLike {
  return { kind, deviceId, label }
}

describe('audioInputs', () => {
  it('keeps only audioinput devices, in order', () => {
    expect(
      audioInputs([
        device('videoinput', 'cam1', 'Webcam'),
        device('audioinput', 'mic1', 'Headset'),
        device('audiooutput', 'spk1', 'Speakers'),
        device('audioinput', 'mic2', 'Built-in Mic'),
      ]),
    ).toEqual([
      { deviceId: 'mic1', label: 'Headset' },
      { deviceId: 'mic2', label: 'Built-in Mic' },
    ])
  })

  it('drops the id-less placeholder a browser emits before mic permission', () => {
    expect(
      audioInputs([device('audioinput', '', 'Microphone'), device('audioinput', 'mic1', 'Real')]),
    ).toEqual([{ deviceId: 'mic1', label: 'Real' }])
  })

  it('drops a repeated deviceId, keeping the first', () => {
    expect(
      audioInputs([
        device('audioinput', 'mic1', 'First'),
        device('audioinput', 'mic1', 'Second'),
      ]),
    ).toEqual([{ deviceId: 'mic1', label: 'First' }])
  })

  it('is empty for an empty input', () => {
    expect(audioInputs([])).toEqual([])
  })
})

describe('inputLabel', () => {
  it('uses the real label, trimmed', () => {
    expect(inputLabel({ deviceId: 'mic1', label: '  Headset  ' }, 0)).toBe('Headset')
  })

  it('numbers the input, 1-based, when the label is blank', () => {
    expect(inputLabel({ deviceId: 'mic1', label: '' }, 0)).toBe('Microphone 1')
    expect(inputLabel({ deviceId: 'mic2', label: '' }, 2)).toBe('Microphone 3')
  })

  it('numbers the input when the label is only whitespace', () => {
    expect(inputLabel({ deviceId: 'mic1', label: '   ' }, 4)).toBe('Microphone 5')
  })
})

describe('sameInputs', () => {
  it('is true for two readings that say the same thing', () => {
    expect(
      sameInputs(
        [{ deviceId: 'mic1', label: 'Headset' }],
        [{ deviceId: 'mic1', label: 'Headset' }],
      ),
    ).toBe(true)
  })

  it('is false when a label changes — the redacted names arriving', () => {
    expect(
      sameInputs(
        [{ deviceId: 'mic1', label: '' }],
        [{ deviceId: 'mic1', label: 'Headset' }],
      ),
    ).toBe(false)
  })

  it('is false when a device appears, disappears or moves', () => {
    const one = [{ deviceId: 'mic1', label: 'Headset' }]
    const two = [
      { deviceId: 'mic1', label: 'Headset' },
      { deviceId: 'mic2', label: 'Built-in Mic' },
    ]
    expect(sameInputs(one, two)).toBe(false)
    expect(sameInputs(two, one)).toBe(false)
    expect(sameInputs(two, [two[1], two[0]])).toBe(false)
  })

  it('is true for two empty lists', () => {
    expect(sameInputs([], [])).toBe(true)
  })
})

describe('chosenInput', () => {
  const inputs: AudioInput[] = [
    { deviceId: 'mic1', label: 'Headset' },
    { deviceId: 'mic2', label: 'Built-in Mic' },
  ]

  it('keeps a stored id that is still in the list', () => {
    expect(chosenInput('mic2', inputs)).toBe('mic2')
  })

  it('falls back to DEFAULT_INPUT for a stored id no longer offered', () => {
    expect(chosenInput('mic-unplugged', inputs)).toBe(DEFAULT_INPUT)
  })

  it('falls back to DEFAULT_INPUT for null, undefined and empty string', () => {
    expect(chosenInput(null, inputs)).toBe(DEFAULT_INPUT)
    expect(chosenInput(undefined, inputs)).toBe(DEFAULT_INPUT)
    expect(chosenInput('', inputs)).toBe(DEFAULT_INPUT)
  })
})

describe('offersInputChoice', () => {
  const twoInputs: AudioInput[] = [
    { deviceId: 'mic1', label: 'Headset' },
    { deviceId: 'mic2', label: 'Built-in Mic' },
  ]
  const oneInput: AudioInput[] = [{ deviceId: 'mic1', label: 'Headset' }]

  it('is true only with support, routing and more than one input', () => {
    expect(offersInputChoice({ supported: true, routes: true, inputs: twoInputs })).toBe(true)
  })

  it('is false where the browser has no recognizer at all', () => {
    expect(offersInputChoice({ supported: false, routes: true, inputs: twoInputs })).toBe(false)
  })

  it('is false where the recognizer does not take a track', () => {
    expect(offersInputChoice({ supported: true, routes: false, inputs: twoInputs })).toBe(false)
  })

  it('is false with only one input', () => {
    expect(offersInputChoice({ supported: true, routes: true, inputs: oneInput })).toBe(false)
  })

  it('is false with zero inputs', () => {
    expect(offersInputChoice({ supported: true, routes: true, inputs: [] })).toBe(false)
  })
})

describe('readInputChoice / writeInputChoice', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults when nothing is stored', () => {
    expect(readInputChoice()).toBe(DEFAULT_INPUT)
  })

  it('round-trips a written choice', () => {
    writeInputChoice('mic1')
    expect(readInputChoice()).toBe('mic1')
  })

  it('writing DEFAULT_INPUT removes the key rather than storing an empty string', () => {
    writeInputChoice('mic1')
    writeInputChoice(DEFAULT_INPUT)
    expect(localStorage.getItem('mesa.live.input')).toBeNull()
    expect(readInputChoice()).toBe(DEFAULT_INPUT)
  })
})
