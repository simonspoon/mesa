import type { LiveIndicator } from './liveIndicator'

/**
 * The conversation indicator's drawing (mesa task 973), replacing the five
 * bars `liveIndicator.ts` used to be paired with. What state is shown and
 * what it means has not changed — `liveIndicator.ts`'s ranking, its doc
 * comment and its ordering of the five states are untouched by this file —
 * only how the header draws the state it is handed.
 *
 * The old band was bars because a bar chart is the obvious way to draw "how
 * much sound", but a strip of five bars reads as a level meter, and three of
 * the five states here are not about level at all — paused and listening are
 * about *whether* something is happening, not how loud it is. An aperture —
 * a ring (or a few) around a lit centre — turns out to draw all five states
 * without needing five different metaphors:
 *
 * - **speaking**: rings travelling outward from the centre, faster and
 *   brighter with the (simulated — see `simEnvelope`) amplitude, and a
 *   glowing core. Outward motion reads as mesa's voice going out.
 * - **hearing**: the same rings, run in reverse — travelling inward, toward
 *   the core — driven by the real microphone level. The mirrored direction is
 *   the point: it is visually the same shape as speaking (both sides of one
 *   conversation, drawn with one renderer) but unmistakably the other
 *   direction, which is the whole distinction a person needs at a glance.
 * - **working**: a dim static ring with one bright dot orbiting it — motion
 *   with no amplitude in it at all, because nothing about the agent thinking
 *   is loud or quiet, it is simply ongoing.
 * - **listening**: a slow, low-alpha breathing ring around a dim dot — the
 *   resting state, present enough to say the microphone is open, faint
 *   enough that nobody mistakes it for speech.
 * - **paused**: a single static arc, opened rather than closed — the one
 *   state that draws no full circle, so a glance at the *shape* alone (never
 *   mind the colour) tells paused apart from every other state, not just its
 *   stillness.
 *
 * The ranking `liveIndicator.ts` computes survives without the bars because
 * nothing about *how the states are chosen* lived in the bars in the first
 * place — the band still shows exactly one of these five drawings at a time,
 * in the same order of precedence, and `role="status"` +
 * `indicatorLabel(state)` is still the accessible name a screen reader gets
 * regardless of what is drawn.
 */

/**
 * A level meter needs a fast attack and a slow release to be readable: jump
 * up the instant a sound arrives (so the meter doesn't lag behind speech
 * starting) but fall back down gradually (so it doesn't flicker to zero in
 * the gaps between syllables). `0.55` vs `0.14` is the ported mockup's own
 * tuning — ported rather than re-derived, since it is the number that made
 * the reference read as continuous motion rather than a series of steps.
 */
export function smoothLevel(prev: number, raw: number): number {
  return prev + (raw - prev) * (raw > prev ? 0.55 : 0.14)
}

/**
 * mesa's speaking envelope. Real playback runs through two different code
 * paths — an `<audio>` element and, on browsers whose media stack refuses a
 * range-less stream, a Web Audio decode-and-schedule fallback
 * (`docs/live.md`) — and tapping a real `AnalyserNode` off both to get one
 * true amplitude signal is out of scope for this task. So `speaking` draws a
 * *simulated* envelope instead: a slow phrase-shaped rise and fall with two
 * faster, mutually awkward syllable oscillations riding on top of it, which
 * is what makes the drawing read as a voice rather than as a metronome. This
 * is the mockup's own `simLevel`, ported unchanged.
 */
export function simEnvelope(t: number): number {
  const phrase = Math.max(0, Math.sin(t * 0.34) * 0.5 + 0.42)
  const syll = 0.5 + 0.5 * Math.sin(t * 11.3)
  const syll2 = 0.5 + 0.5 * Math.sin(t * 7.1 + 1.4)
  return Math.min(1, phrase * (0.35 + 0.5 * syll * syll2 + 0.15 * Math.sin(t * 23)))
}

/**
 * The subset of `CanvasRenderingContext2D` `drawAperture` actually uses — a
 * real canvas context satisfies this structurally, and a test can hand it a
 * plain object that just records calls, with no `<canvas>` or jsdom canvas
 * shim required.
 */
export interface ApertureCtx {
  globalAlpha: number
  // `string`, matching the colours this renderer ever writes — widened to
  // `CanvasRenderingContext2D`'s own `string | CanvasGradient |
  // CanvasPattern` so a real 2D context satisfies this interface structurally
  // (its getter can return a gradient/pattern from elsewhere in the app; this
  // renderer only ever assigns a string).
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  shadowColor: string
  shadowBlur: number
  save(): void
  restore(): void
  translate(x: number, y: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  stroke(): void
  fill(): void
}

/**
 * Draws one frame of the aperture into a `w`×`h` canvas already scaled to
 * device pixels and translated to nothing in particular — this function owns
 * its own centring (`w / 2, h / 2`).
 *
 * `reduced` is a parameter rather than a `matchMedia` read in here so this
 * function stays a pure, testable renderer and the component (which already
 * owns the media-query subscription for its own re-render) is the one place
 * that reads the real query. Under `reduced`, every state freezes to a single
 * representative frame — the mockup's own `reduced ? … : …` branches, ported
 * as-is — which is also why `paused` never looks at `t` at all: it is
 * already a static shape.
 */
export function drawAperture(
  ctx: ApertureCtx,
  w: number,
  h: number,
  state: LiveIndicator,
  t: number,
  level: number,
  color: string,
  reduced: boolean,
): void {
  const cx = w / 2
  const cy = h / 2
  const R = h * 0.46

  ctx.save()
  ctx.translate(cx, cy)

  if (state === 'paused') {
    // An open arc, not a closed ring — paused is the one state whose *shape*
    // says so, not just its stillness (a dimmed circle is too easily read as
    // "listening, but dimmer").
    ctx.globalAlpha = 0.55
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, h * 0.055)
    ctx.beginPath()
    ctx.arc(0, 0, R * 0.66, -Math.PI * 0.72, Math.PI * 0.72)
    ctx.stroke()
    ctx.restore()
    return
  }

  if (state === 'listening') {
    const breath = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.42 * 2 * Math.PI)
    ctx.globalAlpha = 0.22 + 0.2 * breath
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, h * 0.045)
    ctx.beginPath()
    ctx.arc(0, 0, R * (0.42 + 0.24 * breath), 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 0.85
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(0, 0, Math.max(1.2, h * 0.075), 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return
  }

  if (state === 'working') {
    // An orbit, not a wave: motion with no amplitude in it at all — nothing
    // about the agent thinking is loud or quiet.
    ctx.globalAlpha = 0.3
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, h * 0.04)
    ctx.beginPath()
    ctx.arc(0, 0, R * 0.72, 0, Math.PI * 2)
    ctx.stroke()

    const a = reduced ? -Math.PI / 2 : t * 0.72 * 2 * Math.PI
    const trail = 14
    for (let i = trail; i >= 0; i--) {
      const ang = a - i * 0.052
      ctx.globalAlpha = (1 - i / (trail + 1)) * 0.9
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(
        Math.cos(ang) * R * 0.72,
        Math.sin(ang) * R * 0.72,
        Math.max(0.7, h * 0.058 * (1 - i / (trail + 2))),
        0,
        Math.PI * 2,
      )
      ctx.fill()
    }
    ctx.restore()
    return
  }

  // speaking + hearing: the same rings, run in opposite directions — mesa's
  // voice going out, the person's coming in. `out` is speaking; `lv` (the
  // real, smoothed microphone level) drives hearing's amplitude, while
  // speaking's amplitude is the simulated envelope (`simEnvelope`, see its
  // own doc comment for why).
  const out = state === 'speaking'
  const amp = out ? (reduced ? 0.55 : 0.35 + 0.65 * simEnvelope(t * 1.7)) : level
  const rings = 3
  ctx.lineWidth = Math.max(1, h * 0.05)
  for (let i = 0; i < rings; i++) {
    let p = reduced ? (i + 1) / (rings + 1) : (t * 0.85 + i / rings) % 1
    if (!out) p = 1 - p
    const r = R * (0.24 + 0.76 * p)
    const fade = out ? 1 - p : p
    ctx.globalAlpha = Math.max(0, fade * (0.28 + 0.6 * amp))
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  // The core: mesa's own (simulated) volume when she speaks, the real
  // microphone level when she hears.
  const coreR = Math.max(1.4, h * (0.09 + 0.17 * amp))
  ctx.globalAlpha = 1
  ctx.fillStyle = color
  if (out) {
    ctx.shadowColor = color
    ctx.shadowBlur = 8
  }
  ctx.beginPath()
  ctx.arc(0, 0, coreR, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}
