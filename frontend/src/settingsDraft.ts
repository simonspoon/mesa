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
