// Shared presentation helpers for the CC dashboard's session views — token
// and model abbreviation, per-tool colour, and the display form of a call's
// target. Pure and unit-tested; no canvas, no DOM.
//
// Named for the `GET /api/cc/sessions/{id}/graph` payload these all read from
// (`CcGraphNode`), which is still the API's shape. The React Flow layout that
// once lived here went with the call-graph canvas it positioned (mesa task
// 691) — the session view is a list now (`sessionTimeline.ts`), and the
// dashboard, the session detail page and that timeline all still want these.

import type { CcGraphNode } from './types/CcGraphNode'

/** Compact token count for a row or card label: `231`, `44.7k`, `2.05M`. The
 *  gutter it sits in is narrow, so a raw `15452878` would wrap its line. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Drop the `claude-` prefix and any date suffix: `claude-opus-5[1m]` →
 *  `opus-5[1m]`, `claude-haiku-4-5-20251001` → `haiku-4-5`. Width again — the
 *  family and generation are what a reader is scanning for. */
export function shortModel(model: string | null): string | null {
  if (!model) return null
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** Per-tool colour.
 *
 *  A session's main thread is one tall column of `kind: tool` rows, and until
 *  now every one of them carried the same grey left border — so scanning for
 *  "where did it start editing files" meant reading every label. Giving each
 *  tool *name* its own stable colour turns that column into a scannable stripe.
 *
 *  Two-part, deliberately: a hand-assigned index for the tools that actually
 *  dominate a transcript (Bash/Read/Edit are ~80% of all calls, and those must
 *  never sit on neighbouring hues), and a hash for everything else — the tail
 *  is open-ended (`mcp__*` names, whatever ships next month), so a pure lookup
 *  table would go stale and hand a new tool the "unknown" grey it used to have.
 *
 *  Hues avoid the three bands already spent on the other node kinds — cyan
 *  (session), violet (skill), magenta (agent) — so a tool never impersonates
 *  the structural colours it sits between. */
const TOOL_PALETTE = [
  'hsl(28, 85%, 60%)', //  0 orange
  'hsl(206, 80%, 62%)', //  1 blue
  'hsl(150, 65%, 52%)', //  2 green
  'hsl(340, 75%, 62%)', //  3 rose
  'hsl(48, 90%, 58%)', //  4 yellow
  'hsl(170, 58%, 48%)', //  5 teal
  'hsl(96, 55%, 55%)', //  6 olive
  'hsl(276, 65%, 68%)', //  7 purple
  'hsl(14, 78%, 62%)', //  8 vermilion
  'hsl(62, 62%, 56%)', //  9 chartreuse
  'hsl(220, 68%, 68%)', // 10 indigo
  'hsl(4, 72%, 62%)', // 11 red
  'hsl(190, 45%, 55%)', // 12 slate-cyan
  'hsl(35, 45%, 52%)', // 13 tan
  'hsl(300, 40%, 62%)', // 14 mauve
  'hsl(128, 40%, 46%)', // 15 forest
  'hsl(240, 35%, 66%)', // 16 periwinkle
  'hsl(84, 35%, 48%)', // 17 moss
]

/** Fixed slots. Two rules, in tension, and the second is why this is a table
 *  rather than a pure hash:
 *
 *  1. The high-volume tools must never collide — `Bash`/`Read`/`Edit` alone are
 *     ~80% of a transcript, so one accidental shared hue flattens most of the
 *     column back to the single stripe this replaces. Measured against a real
 *     session, a 12-entry palette put `Bash` and `EnterWorktree` on the same
 *     orange; the palette is 18 wide for that reason.
 *  2. Where two names *are* one act, they share deliberately. `Task`/`Agent`
 *     are the same spawn under two spellings; the `Task*` management tools,
 *     the worktree pair and the send family each read as one thing in a column
 *     and colouring them apart would invent a distinction. */
/** The hash draws only from slots at or above this one, so no unknown name can
 *  land on a *high-volume* tool's colour — measured, `advisor` hashed straight
 *  onto `Write`'s rose before the split.
 *
 *  It is a floor, not a private range: the table still uses 12–17 for its
 *  low-traffic families, so an unknown name may share with `EnterWorktree` or
 *  the `Task*` group. That is the intended trade — two rare things sharing a
 *  hue is a far cheaper mistake than a rare one impersonating `Bash`. */
const FALLBACK_FROM = 12

const TOOL_SLOT: Record<string, number> = {
  Bash: 0,
  Read: 1,
  Edit: 2,
  Write: 3,
  WebFetch: 4,
  WebSearch: 5,
  // Same act under three spellings across Claude Code versions.
  Agent: 7,
  Task: 7,
  Skill: 6,
  // Both search for files; one colour is the honest encoding.
  Glob: 8,
  Grep: 8,
  ToolSearch: 9,
  StructuredOutput: 10,
  AskUserQuestion: 11,
  EnterWorktree: 12,
  ExitWorktree: 12,
  TaskCreate: 13,
  TaskUpdate: 13,
  TaskStop: 13,
  TaskList: 13,
  TaskGet: 13,
  TaskOutput: 13,
  Monitor: 14,
  Workflow: 15,
  SendMessage: 16,
  SendUserFile: 16,
  PushNotification: 16,
  ScheduleWakeup: 17,
  CronCreate: 17,
  CronList: 17,
  CronDelete: 17,
}

/** Colour for a tool node, keyed on the tool's name. Stable across reloads and
 *  across sessions — the same tool is the same colour everywhere, which is the
 *  whole point — and total: an unrecognised name still gets a real colour. */
export function toolColor(name: string): string {
  const slot = TOOL_SLOT[name]
  if (slot !== undefined) return TOOL_PALETTE[slot]
  // FNV-1a, 32-bit — any stable string hash would do; this one is four lines.
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return TOOL_PALETTE[FALLBACK_FROM + ((h >>> 0) % (TOOL_PALETTE.length - FALLBACK_FROM))]
}

/** Reserved colour for `kind: response`.
 *
 *  Deliberately NOT a `toolColor()` slot: that function keys on a tool *name*,
 *  and a response has no tool name to key on — asking it would mean a hashed
 *  fallback, i.e. a colour that could land on any low-traffic tool's hue.
 *
 *  Low-saturation and light on purpose. Every `TOOL_PALETTE` entry sits at 35%+
 *  saturation and the three structural kinds own neon cyan (session), violet
 *  (skill) and magenta (agent), so a pale warm neutral is the one band nothing
 *  else can reach, hashed or otherwise. */
export const RESPONSE_COLOR = 'hsl(36, 30%, 76%)'

/** Reserved colour for `kind: prompt` — the human turns, and so the spine a
 *  reader scans a session by.
 *
 *  Reserved for the same reason `RESPONSE_COLOR` is: a prompt has no tool name
 *  for `toolColor()` to key on, so asking it would mean a hashed fallback onto
 *  some low-traffic tool's hue.
 *
 *  A cool pale neutral, mirroring the response's warm one: the two kinds that
 *  carry prose are a matched pair — one side of the conversation each — and the
 *  eye should sort them apart at a glance without either shouting over the
 *  saturated tool column. 214° is far from the response's 36°, and at 28%
 *  saturation it is below every `TOOL_PALETTE` entry's 35% floor, so no tool
 *  can reach it hashed or otherwise. The blue *band* is spent on `blue` (206°)
 *  and `slate-cyan` (190°), but those sit at 80%/45% saturation and 62%/55%
 *  lightness — nothing at 28%/78% is within reach. */
export const PROMPT_COLOR = 'hsl(214, 28%, 78%)'

/** Tools whose `target` is a path, so the caller shows its last segment. The
 *  server stores the full path (it is the unambiguous thing to store); which
 *  part of it fits a one-line cell is a rendering question, decided here. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Artifact'])

/** The one-line display form of what the call acted on, shortened to what a
 *  single line can hold. A file tool shows the file name (`cc.rs`, not 58 characters of
 *  `/Users/…/src/core/`); everything else — a Bash command, a URL, a query —
 *  shows the target as stored, since its front is already the informative end.
 *
 *  Path shortening keys on the tool name first and falls back to "looks like a
 *  path" (leading `/`, `./` or `~`, no spaces) so an unrecognised file-ish tool
 *  still reads well. A Bash command is never shortened this way even when it
 *  starts with an absolute path, because it holds spaces the moment it takes an
 *  argument — and `/usr/local/bin/foo --flag` wants its flags, not `foo`.
 *
 *  The full value stays available as the caller's hover title: this returns the
 *  display form only, and never claims to round-trip.
 *
 *  A `response`'s or `prompt`'s target is prose, not a target, and is passed
 *  through untouched: the "looks like a path" heuristic would otherwise mangle
 *  a one-word reply — or a bare slash command such as `/clear`, which is
 *  exactly what a prompt row often holds — into a path segment. */
export function shortTarget(node: Pick<CcGraphNode, 'kind' | 'name' | 'target'>): string | null {
  const t = node.target
  if (!t) return null
  if (node.kind === 'response' || node.kind === 'prompt') return t
  const pathLike = FILE_TOOLS.has(node.name) || (/^[~./]/.test(t) && !/\s/.test(t))
  if (!pathLike) return t
  // `filter(Boolean)` so a trailing slash yields the directory name rather
  // than an empty string.
  const parts = t.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : t
}
