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
 * The second thing modelled here is the server's **mode rule** (mesa task 667,
 * `config::is_script`): a value with a newline in it is a bash script rather
 * than an argv template, which changes both what will actually run and which
 * vocabulary applies. The page has to say so *while typing*, before a save,
 * so the rule is mirrored here rather than waiting for a round trip.
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
 * True when this value runs as a `bash -c` script rather than as an argv
 * template. Mirrors `config::is_script`: trim first, then look for a newline,
 * so surrounding blank lines don't silently switch modes.
 */
export function isScript(value: string): boolean {
  return value.trim().includes('\n')
}

/** Which mode this row will actually run in, drafted value or default. */
export function effectiveMode(
  command: ConfigCommand,
  draft: Draft,
): 'argv' | 'script' {
  return isScript(effectiveCommand(command, draft)) ? 'script' : 'argv'
}

/** Every placeholder mesa knows, paired with the variable a script reads. */
const PLACEHOLDER_ENV: Record<string, string> = {
  '{bin}': 'MESA_BIN',
  '{agent}': 'MESA_AGENT',
  '{id}': 'MESA_ID',
  '{name}': 'MESA_NAME',
  '{prompt}': 'MESA_PROMPT',
}

/**
 * The save-time error this row would earn for using `{}` syntax in a script,
 * or `null` if it wouldn't — the client-side twin of `config::check_script`,
 * so the mistake is named as it is typed rather than only after a failed PUT.
 *
 * A `{` preceded by `$` is skipped, exactly as the server skips it: a script's
 * own `${MESA_NAME}` is correct usage, not the mistake being named.
 */
export function scriptPlaceholderError(
  command: ConfigCommand,
  draft: Draft,
): string | null {
  const value = effectiveCommand(command, draft)
  if (!isScript(value)) return null
  for (const [placeholder, variable] of Object.entries(PLACEHOLDER_ENV)) {
    let at = value.indexOf(placeholder)
    while (at !== -1) {
      if (at === 0 || value[at - 1] !== '$') {
        return command.env_vars.includes(variable)
          ? `${placeholder} is not substituted in a script — use $${variable} instead`
          : `${placeholder} is not offered to ${command.action}`
      }
      at = value.indexOf(placeholder, at + 1)
    }
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
