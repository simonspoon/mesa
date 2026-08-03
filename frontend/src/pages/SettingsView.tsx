import { useState } from 'react'
import { getConfig, listProjects, restartServer, updateConfig } from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import {
  changedCommands,
  draftFrom,
  effectiveCommand,
  effectiveMode,
  isDirty,
  isRowChanged,
  scriptPlaceholderError,
  type Draft,
} from '../settingsDraft'
import type { ConfigCommand } from '../types/ConfigCommand'
import { useFetch } from '../useFetch'

/**
 * Human copy for each config key. The server sends the key, the default and
 * the placeholder vocabulary; only "what does this spawn *do*" lives here,
 * because it is prose about mesa's behavior, not config data.
 */
const COPY: Record<string, { title: string; blurb: string }> = {
  'todo-watcher': {
    title: 'Todo watcher',
    blurb:
      '`serve --watch-todo` runs this to pick up the next unblocked task in a project.',
  },
  'refine-watcher': {
    title: 'Refine watcher',
    blurb:
      '`serve --watch-refine` runs this to sharpen a task sitting in the refine column and move it on to todo.',
  },
  'inbox-watcher': {
    title: 'Inbox watcher',
    blurb: '`serve --watch-inbox` runs this to triage a new inbox item.',
  },
  'agent-spawn': {
    title: 'Add agent',
    blurb: "The Agents sidebar's + button runs this to start a session.",
  },
}

/**
 * Polls the server with a cheap existing GET until it responds, for use after
 * `restartServer()` — the old process exits and a new one has to open the
 * store and rebind the port before anything answers again.
 */
async function waitForServer(timeoutMs = 15000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      await listProjects()
      return
    } catch {
      // Still shutting down or starting back up — keep polling.
    }
  }
  throw new Error(
    'server did not come back within 15s — check the terminal mesa is running in',
  )
}

async function handleRestart(): Promise<void> {
  await restartServer()
  await waitForServer()
  window.location.reload()
}

/**
 * The page title row: "Settings" on the left, Restart server hard right (mesa
 * task 655 — it used to live in the sidebar footer). It renders in *every*
 * branch below, including the unreadable-config error state: relaunching mesa
 * is the one control that must stay reachable even when the page's own data
 * won't load.
 */
function SettingsHeader() {
  return (
    <div className="settings-header">
      <h1>Settings</h1>
      <ConfirmDelete
        label="Restart server"
        message="Relaunches mesa (picks up a rebuilt binary); reloads when it's back."
        onDelete={handleRestart}
      />
    </div>
  )
}

/**
 * Settings: a form over `~/.mesa/config.json` — today, the three command
 * templates mesa uses to start a coding agent (docs/config.md).
 *
 * Two things the page must not soften, because they are the file's actual
 * semantics rather than presentation:
 *
 * - **Blank means "use the built-in default"**, not "run nothing". Every row
 *   shows the default it would fall back to, and clearing a box is the reset.
 * - **One line is argv, never a shell string.** The help text says so, since
 *   a GUI invites typing `foo | bar` at it. Bad templates are rejected by the
 *   server at save time (unknown placeholder, unbalanced quote) rather than
 *   failing silently at the next dispatch, and the message lands here.
 * - **A second line makes it a bash script**, run as `bash -c` with the values
 *   arriving as `MESA_*` environment variables instead of `{}` placeholders
 *   (mesa task 667). Each row states which mode it is in and what will run, so
 *   the newline rule is never a surprise the user discovers at dispatch time.
 *
 * The file is read fresh on every spawn, so a save takes effect immediately —
 * no server restart, which the page states so nobody goes looking for one.
 */
export function SettingsView() {
  const { data: commands, error, refetch } = useFetch(() => getConfig(), 'config')
  // The form is edited locally and saved explicitly. `null` = not seeded yet;
  // it is seeded from the first load (and re-seeded after a save, from the
  // echoed settings) rather than derived per render, so typing isn't clobbered
  // by a refetch mid-edit.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: Draft = draft ?? (commands ? draftFrom(commands) : {})

  function edit(action: string, value: string) {
    setDraft({ ...seeded, [action]: value })
    setSaved(false)
  }

  function save() {
    if (!commands) return
    setSaving(true)
    setSaveError(null)
    updateConfig(changedCommands(commands, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the form shows what
        // actually landed (trimmed, blanks resolved to their defaults).
        setDraft(draftFrom(fresh))
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <div className="settings-page">
        <SettingsHeader />
        <p className="error">{error}</p>
        <p className="muted">
          mesa found a config file it could not read. Fix{' '}
          <code>~/.mesa/config.json</code> by hand — editing it from here would
          overwrite whatever is in there.
        </p>
      </div>
    )
  }
  if (!commands) {
    return (
      <div className="settings-page">
        <SettingsHeader />
        <p className="muted">Loading…</p>
      </div>
    )
  }

  const dirty = isDirty(commands, seeded)

  return (
    <div className="settings-page">
      <SettingsHeader />
      <p className="muted">
        Stored in <code>~/.mesa/config.json</code> and re-read on every spawn —
        a change takes effect on the next dispatch, with no server restart.
      </p>

      <h2>Agent commands</h2>
      <p className="muted">
        The command mesa runs to start a coding agent. Leave a box empty to use
        the built-in default. There are two modes, chosen by what you type:
      </p>
      <ul className="muted settings-modes">
        <li>
          <strong>One line is argv, not a shell command</strong>: no pipes,
          redirection, <code>$VAR</code> or <code>~</code>. Quote an argument
          that contains spaces, and write values as <code>{'{}'}</code>{' '}
          placeholders.
        </li>
        <li>
          <strong>More than one line is a bash script</strong>, run as{' '}
          <code>bash -c</code> in the same folder — so you can <code>cd</code>,{' '}
          <code>export</code>, or pick a binary first. A script reads its values
          as <code>MESA_*</code> environment variables instead;{' '}
          <code>{'{}'}</code> placeholders are not substituted there, and a
          value with nothing to say on a given run is left unset.
        </li>
      </ul>

      {commands.map((c) => (
        <CommandRow
          key={c.action}
          command={c}
          draft={seeded}
          onEdit={(value) => edit(c.action, value)}
        />
      ))}

      <div className="settings-actions">
        <button type="button" disabled={!dirty || saving} onClick={save}>
          {saving ? 'saving…' : 'save'}
        </button>
        {dirty && !saving && <span className="muted">unsaved changes</span>}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </div>
  )
}

function CommandRow({
  command,
  draft,
  onEdit,
}: {
  command: ConfigCommand
  draft: Draft
  onEdit: (value: string) => void
}) {
  const copy = COPY[command.action]
  const text = draft[command.action] ?? ''
  const usingDefault = text.trim() === ''
  const mode = effectiveMode(command, draft)
  const placeholderError = scriptPlaceholderError(command, draft)
  // Grow with the script so a multi-line value isn't edited through a slot.
  const rows = Math.min(16, Math.max(2, text.split('\n').length + 1))
  return (
    <section className="settings-command">
      <label htmlFor={`cmd-${command.action}`}>
        <span className="settings-command-title">
          {copy?.title ?? command.action}
        </span>
        <code className="settings-command-key">{command.action}</code>
      </label>
      {copy && <p className="muted settings-command-blurb">{copy.blurb}</p>}
      <textarea
        id={`cmd-${command.action}`}
        className="settings-command-input"
        rows={rows}
        spellCheck={false}
        value={text}
        placeholder={command.default}
        onChange={(e) => onEdit(e.target.value)}
      />
      <div className="settings-command-meta">
        {/* The vocabulary follows the mode: a script never sees `{}`, and an
            argv template never sees the variables. Showing both at once would
            invite the exact mistake the server rejects at save time. */}
        <span className="settings-placeholders">
          {(mode === 'script' ? command.env_vars.map((v) => `$${v}`) : command.placeholders).map(
            (p) => (
              <code key={p}>{p}</code>
            ),
          )}
        </span>
        {!usingDefault && (
          <button
            type="button"
            className="settings-reset"
            title="Clear this box, restoring the built-in default"
            onClick={() => onEdit('')}
          >
            reset to default
          </button>
        )}
      </div>
      <p className="settings-effective">
        <span className="muted">
          {usingDefault ? 'default in use:' : 'will run:'}
        </span>{' '}
        {mode === 'script' ? (
          <>
            <code>bash -c</code>{' '}
            <span className="muted">
              with {command.env_vars.map((v) => `$${v}`).join(', ')} set
            </span>
            <code className="settings-effective-script">
              {effectiveCommand(command, draft)}
            </code>
          </>
        ) : (
          <code>{effectiveCommand(command, draft)}</code>
        )}
        {isRowChanged(command, draft) && (
          <span className="settings-pending"> (unsaved)</span>
        )}
      </p>
      {placeholderError && <p className="error">{placeholderError}</p>}
    </section>
  )
}
