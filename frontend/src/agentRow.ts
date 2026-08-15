// The Agent sidebar's list row (mesa task 869) — the two derivations its
// four lines need, kept out of `AgentSidebar.tsx` so they can be unit-tested
// (the repo's rule: logic worth testing never lives inline in a `.tsx`).
//
// Both answer `null` rather than a placeholder when there is nothing to say.
// A row renders nothing at all in that case: "no transcript yet" and "no
// usage line yet" must not read as an empty response or as zero tokens.

/**
 * The context-window figure for a row's right-hand meta slot: a compact,
 * fixed-width-ish token count.
 *
 * `null` for absent (no usage line on the transcript yet) **and for 0** —
 * a session occupying no context has nothing worth a column of its own, and
 * "0" beside a running agent reads as a measurement, not as an absence.
 * Negative is treated the same way: it can only be a bad reading.
 *
 * Under 1k the raw count is exact; above it one decimal is kept unless it
 * would be `.0`, so the string never exceeds six characters and a column of
 * them stays scannable.
 */
export function formatContextTokens(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens < 1000) return String(Math.round(tokens))
  const [value, suffix] = tokens < 1_000_000 ? [tokens / 1000, 'k'] : [tokens / 1_000_000, 'M']
  // `toFixed(1)` then strip a trailing `.0`: 48.2k, but 1k rather than 1.0k.
  return value.toFixed(1).replace(/\.0$/, '') + suffix
}

/**
 * The one-line preview of an agent's latest prose.
 *
 * The server already bounds the text; this only makes it fit on one line —
 * every run of whitespace (newlines included) collapses to a single space,
 * so a multi-paragraph reply can't turn the row into a block. Whitespace-only
 * text is nothing to show, so it comes back `null` like an absent one.
 *
 * The result is still **untrusted model-authored text** and is rendered as a
 * plain text node: never HTML, markdown or a URL.
 */
export function responsePreview(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed === '' ? null : collapsed
}
