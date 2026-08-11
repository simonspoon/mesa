// Where a dragged modal box sits (mesa task 811). The box is centred by its
// flex backdrop and displaced from that centre by a transform, so its position
// is one offset from centre rather than a left/top pair — which is what keeps
// the existing centring, the phone-tier full-bleed sheet and the `--cut`
// styling untouched.
//
// Pure math, no DOM: the component measures and applies, this decides. Lives
// here rather than inline in `CreateTaskModal.tsx` for the reason CLAUDE.md
// gives — the clamp is the part that historically ships wrong (a modal dragged
// off the edge of the screen has no way back), and only a module is testable.

export type Offset = { x: number; y: number }
export type Size = { width: number; height: number }

/**
 * The offset a drag lands on: where the box started, plus how far the pointer
 * has moved, clamped so the box stays fully inside the viewport.
 *
 * A centred box of width `w` in a viewport of width `vw` has `(vw - w) / 2` of
 * slack on each side, so the offset range is symmetric about 0. When the box is
 * at least as wide as the viewport that slack is negative — there is nowhere to
 * go — and the limit floors at 0, pinning the box where it is. That is what
 * makes the phone tier's full-bleed sheet immovable without a second rule: it
 * is exactly as wide as the screen, so every drag resolves to (0, 0).
 */
export function dragOffset(
  origin: Offset,
  delta: Offset,
  box: Size,
  viewport: Size,
): Offset {
  const limitX = Math.max(0, (viewport.width - box.width) / 2)
  const limitY = Math.max(0, (viewport.height - box.height) / 2)
  return {
    x: clamp(origin.x + delta.x, limitX),
    y: clamp(origin.y + delta.y, limitY),
  }
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value))
}
