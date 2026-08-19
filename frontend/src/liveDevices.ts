/**
 * Which microphone the live conversation listens through (mesa task 884).
 *
 * `liveRecognition.ts` answers *whether* the browser is listening; this module
 * answers *what it is listening to*. They are separate questions because a
 * machine with a laptop microphone, a headset and a webcam has three answers to
 * the second one and the browser picks whichever the operating system last
 * called default — which, on the machine mesa is dictated into, is routinely
 * the wrong one and is not changeable from inside the page's own controls.
 *
 * Three things here are decisions rather than plumbing:
 *
 * - **The default is "no track at all".** The Web Speech API grew an optional
 *   `MediaStreamTrack` argument to `start()`; passing one is how a specific
 *   device gets chosen, and passing none is what mesa has always done. So the
 *   empty choice is not "device zero" — it is the untouched call, which needs
 *   no `getUserMedia`, no microphone permission of mesa's own and no support
 *   for that argument. A browser that cannot route a track still listens
 *   exactly as it did before this module existed.
 * - **A stored choice is a wish, not a fact.** Device ids are per-origin and
 *   rotate when site storage is cleared, and the headset they named may simply
 *   be unplugged. So the stored id is checked against the devices that are
 *   *here* on every read, and an id nobody offers falls back to the default —
 *   a conversation that hears nothing because the microphone it was told to
 *   use went away is worse than one that hears the wrong microphone.
 * - **Nothing to choose between is not a choice.** The control is offered only
 *   where there are two or more inputs *and* the browser takes the track
 *   argument; anywhere else it would be a dropdown that either has one entry
 *   or changes nothing, and both of those lie about what mesa can do.
 *
 * The audio still never leaves the page: a chosen track is handed to the
 * browser's own recognizer, mesa ships no speech-to-text and no route accepts
 * an audio body (`docs/live.md`).
 */

/** A `MediaDeviceInfo`, as much of one as the chooser reads. */
export interface DeviceLike {
  kind: string
  deviceId: string
  label: string
}

/** One microphone the person could pick. */
export interface AudioInput {
  deviceId: string
  label: string
}

/**
 * The choice that routes no track: whatever the browser would have listened
 * through anyway. Deliberately the empty string, so it is also what an absent
 * or unreadable stored value means.
 */
export const DEFAULT_INPUT = ''

/** Machine-local, like every other remembered pane width and last view. */
const KEY = 'mesa.live.input'

/**
 * The microphones, out of everything `enumerateDevices()` returns.
 *
 * Two entries are dropped. One with **no id** is the placeholder a browser
 * emits before microphone permission has ever been granted — it names no
 * device, and its empty id is the same string as `DEFAULT_INPUT`, so keeping
 * it would put a second "default" in the list that quietly stops meaning
 * "route nothing". A **repeated** id is the same device seen twice (a
 * `devicechange` mid-enumeration will do it), and a `<select>` with two
 * identical values cannot say which one is chosen.
 */
export function audioInputs(devices: readonly DeviceLike[]): AudioInput[] {
  const seen = new Set<string>()
  const inputs: AudioInput[] = []
  for (const device of devices) {
    if (device.kind !== 'audioinput') continue
    if (device.deviceId === '') continue
    if (seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    inputs.push({ deviceId: device.deviceId, label: device.label })
  }
  return inputs
}

/**
 * Whether two readings of the device list say the same thing.
 *
 * The list is re-read often — on every `devicechange`, and on every recognizer
 * start, which is once a turn — and almost every re-read returns exactly what
 * the last one did. `enumerateDevices` hands back fresh objects each time, so
 * without this the header would re-render once a turn to redraw an identical
 * dropdown.
 */
export function sameInputs(
  a: readonly AudioInput[],
  b: readonly AudioInput[],
): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (input, i) => input.deviceId === b[i].deviceId && input.label === b[i].label,
  )
}

/**
 * What one entry is called. A browser redacts every label until microphone
 * permission has been granted, so before the first conversation the list is
 * real devices with blank names — numbered rather than blank, because a
 * dropdown of empty rows cannot be picked from at all, and the numbers are
 * replaced by the true names the moment recognition starts.
 */
export function inputLabel(input: AudioInput, index: number): string {
  const label = input.label.trim()
  return label === '' ? `Microphone ${index + 1}` : label
}

/**
 * The device to actually listen through: the remembered one if it is still
 * here, and the browser's default if it is not.
 */
export function chosenInput(
  stored: string | null | undefined,
  inputs: readonly AudioInput[],
): string {
  if (!stored) return DEFAULT_INPUT
  return inputs.some((input) => input.deviceId === stored) ? stored : DEFAULT_INPUT
}

/**
 * Whether the header offers the chooser at all.
 *
 * `routes` is whether this browser takes a track on `start()` — learned by
 * trying it rather than probed, since the only safe probe would be to open a
 * recognizer, and opening one is exactly the thing that asks a person for
 * their microphone.
 */
export function offersInputChoice(input: {
  supported: boolean
  routes: boolean
  inputs: readonly AudioInput[]
}): boolean {
  return input.supported && input.routes && input.inputs.length > 1
}

/** The remembered choice, or the default when there is none. */
export function readInputChoice(): string {
  return localStorage.getItem(KEY) ?? DEFAULT_INPUT
}

/** Remember a choice; the default is remembered as nothing at all. */
export function writeInputChoice(deviceId: string): void {
  if (deviceId === DEFAULT_INPUT) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, deviceId)
}
