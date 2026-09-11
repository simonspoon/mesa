import type { ConfigCommand } from './types/ConfigCommand'

/**
 * Pure draft logic for the Settings page's config editor, hoisted out of the
 * component so it is unit-testable (see CLAUDE.md: the frontend tests cover the
 * pure modules, never a rendered tree).
 *
 * The whole subtlety is one equivalence the server also draws: a **blank**
 * textarea and a **null** stored value are the same state — "no template
 * configured, run the built-in default". Get that wrong and the page either
 * reports a pristine form as dirty forever, or sends a no-op save that rewrites
 * the file for nothing.
 *
 * The second thing modelled here is the server's placeholder vocabulary
 * (`config::check_key`): every hook is a bash script and every `{placeholder}`
 * is substituted shell-quoted (mesa task 1143), but which names an action
 * offers is per action, and the page says so *while typing*, before a save,
 * rather than waiting for a round trip.
 */

/** One textarea's text per action. Blank = "fall back to the default". */
export type Draft = Record<string, string>

/** The editable text for each command as loaded: `null` renders as empty. */
export function draftFrom(commands: ConfigCommand[]): Draft {
  const draft: Draft = {}
  for (const c of commands) draft[c.action] = c.value ?? ''
  return draft
}

/** What one row will actually run: the drafted template, else the default. */
export function effectiveCommand(command: ConfigCommand, draft: Draft): string {
  const drafted = (draft[command.action] ?? '').trim()
  return drafted === '' ? command.default : drafted
}

/**
 * The save-time error this row would earn for naming a placeholder its action
 * does not offer, or `null` if it wouldn't — the client-side twin of
 * `config::check_key`'s scope rule, so the mistake is named as it is typed
 * rather than only after a failed PUT.
 *
 * What counts as a placeholder mirrors the server's `scan_script`: a brace
 * holding only name characters (`{id}`, `{tsak}`), or a `{prompt:<name>}`,
 * and only when the `{` is not preceded by `$` — a script's own `${HOME}` is
 * bash's parameter expansion, not mesa's placeholder. Anything else
 * (`cp a{,.bak}`, `{ …; }`, jq's `{id: 1}`) is bash text and is left alone. A
 * `{prompt:<name>}` is offered to every action, so it is never an error here;
 * whether the library holds that name is the server's call (it has the list).
 * The server's other rules (single quotes, `$'…'`, backticks and arithmetic
 * refuse a placeholder; `bash -n`) have no twin here — each needs a shell
 * lexer, and the PUT names the context it found.
 */
export function placeholderError(
  command: ConfigCommand,
  draft: Draft,
): string | null {
  const value = effectiveCommand(command, draft)
  const brace = /\{([A-Za-z0-9_-]+|prompt:[A-Za-z0-9][A-Za-z0-9._-]*)\}/g
  for (const m of value.matchAll(brace)) {
    if (m.index > 0 && value[m.index - 1] === '$') continue
    if (m[1].startsWith('prompt:')) continue
    if (command.placeholders.includes(m[0])) continue
    return `${m[0]} is not offered to ${command.action}`
  }
  return null
}

/** True when this row's text differs from what the server last reported. */
export function isRowChanged(command: ConfigCommand, draft: Draft): boolean {
  return (draft[command.action] ?? '').trim() !== (command.value ?? '')
}

/**
 * The subset to PUT: only rows whose text actually changed. Sending untouched
 * rows would be harmless but would rewrite keys the user never opened — and
 * the API's "only the keys present are touched" rule exists precisely so two
 * editors can't clobber each other.
 *
 * Values are sent trimmed, matching what the server stores, so a save followed
 * immediately by a re-render doesn't read as still-dirty.
 */
export function changedCommands(
  commands: ConfigCommand[],
  draft: Draft,
): Record<string, string> {
  const changed: Record<string, string> = {}
  for (const c of commands) {
    if (isRowChanged(c, draft)) changed[c.action] = (draft[c.action] ?? '').trim()
  }
  return changed
}

/** True when anything at all is pending, i.e. the Save button does something. */
export function isDirty(commands: ConfigCommand[], draft: Draft): boolean {
  return commands.some((c) => isRowChanged(c, draft))
}
