import { useEffect, useRef } from 'react'
import { drawAperture, smoothLevel } from '../liveBand'
import type { LiveIndicator } from '../liveIndicator'
import { indicatorLabel } from '../liveIndicator'

/**
 * How big the aperture is drawn, in CSS pixels. It was 18 while it lived in
 * the page header, absolutely positioned in a band with a row of buttons to
 * stay out of the way of; since mesa task 1069 it leads the conversation
 * panel's own head, where it is the picture of the conversation rather than a
 * hint that one exists. `drawAperture` is parametric on `w`/`h` — every stroke
 * and radius in it is a fraction of the height — so this is the only number
 * that changes.
 */
const APERTURE_PX = 44

/**
 * The conversation indicator's drawing surface (mesa task 973) — one
 * 44×44 canvas replacing the old five-bar band, painted by `liveBand.ts`'s
 * `drawAperture`. `liveBand.ts` carries the reasoning for *what* is drawn;
 * this component is only the plumbing that keeps a canvas fed at 60fps
 * without dragging React into the hot path.
 *
 * Colour lives in CSS, not here: a `.live-band-<state>` class carries
 * `color: var(--cyan)` etc. (and speaking's glow), the same palette every
 * other themed element in this app draws from, and the render loop reads
 * `getComputedStyle(canvas).color` back out rather than duplicating the
 * palette in TypeScript. That is also why the colour is re-read only when
 * `state` changes and not on every frame — `getComputedStyle` is not the
 * kind of call to make 60 times a second.
 */
export function LiveBand({ state, level }: { state: LiveIndicator; level: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Everything the rAF loop reads lives in a ref, not state — the loop runs
  // for the life of the component (mounted once below) and must never itself
  // be the thing that triggers a React render, 60 times a second.
  const stateRef = useRef(state)
  // The incoming level is already throttled at the source (0.03/100ms — see
  // `LiveHub`'s comment where it passes this prop); copying it into a ref
  // rather than reading the prop by closure means a fresh level never has to
  // wait for the loop's effect to be re-created.
  const levelRef = useRef(level)
  // Smoothed once per frame (`smoothLevel`'s fast-attack, slow-release) —
  // also a ref, for the same reason.
  const smoothedRef = useRef(0)
  const colorRef = useRef('')
  const reducedRef = useRef(false)

  // Refs are not render-time values, so the props are copied into them from
  // an effect rather than written during render. This runs on every level
  // update, but it is only a field write — the throttling that keeps it
  // cheap already happened at the source.
  useEffect(() => {
    levelRef.current = level
  }, [level])

  useEffect(() => {
    stateRef.current = state
    // The colour is re-read only when `state` changes, not every frame —
    // `getComputedStyle` is not the kind of call to make 60 times a second.
    const canvas = canvasRef.current
    if (canvas === null) return
    colorRef.current = getComputedStyle(canvas).color
  }, [state])

  // The one rAF loop: started on mount, cancelled on unmount, and otherwise
  // left alone — a state or level change reaches it through the refs above,
  // never by tearing the loop down and starting a new one.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = APERTURE_PX
    const h = APERTURE_PX
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.scale(dpr, dpr)

    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedRef.current = media.matches
    // The old CSS block answered `@media (prefers-reduced-motion: reduce)`
    // live — a setting flipped mid-session took effect without a reload —
    // and a canvas has no CSS media query to lean on, so this is that
    // behaviour's replacement: subscribe rather than read the query once.
    const onReducedChange = (e: MediaQueryListEvent): void => {
      reducedRef.current = e.matches
    }
    media.addEventListener('change', onReducedChange)

    let raf = 0
    const start = performance.now()
    const frame = (now: number): void => {
      const t = (now - start) / 1000
      smoothedRef.current = smoothLevel(smoothedRef.current, levelRef.current)
      ctx.clearRect(0, 0, w, h)
      drawAperture(ctx, w, h, stateRef.current, t, smoothedRef.current, colorRef.current, reducedRef.current)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      media.removeEventListener('change', onReducedChange)
    }
    // Deliberately empty: this effect is the mount/unmount lifecycle, not a
    // response to `state`/`level` changing — see the refs above.
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={`live-band live-band-${state}`}
      role="status"
      aria-label={indicatorLabel(state)}
    />
  )
}
