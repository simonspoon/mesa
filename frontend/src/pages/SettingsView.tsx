import { useEffect, useRef, useState } from 'react'
import {
  getConfig,
  getKeymap,
  getListen,
  getLiveConfig,
  getPricing,
  getSpeech,
  getSystemInfo,
  getWatchers,
  listProjects,
  resetCcIndex,
  restartServer,
  speechPreviewUrl,
  updateConfig,
  updateKeymap,
  updateListen,
  updateLiveConfig,
  updatePricing,
  updateSpeech,
  updateWatchers,
  type CcResetReport,
} from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import {
  ACTIONS,
  DEFAULT_KEYMAP,
  chordFromEvent,
  chordLabel,
  formatChord,
  type KeymapAction,
} from '../keymap'
import {
  changedKeymap,
  conflictingActions,
  draftFrom as keymapDraftFrom,
  isDirty as isKeymapDirty,
  isOverridden,
  isSavable as isKeymapSavable,
  resetAll,
  withChord,
  withReset,
  type KeymapDraft,
} from '../keymapDraft'
import { publishKeymap } from '../keymapStore'
import {
  clampPct,
  formatBytes,
  formatUptime,
  systemSeverity,
  usedPct,
} from '../systemMeter'
import {
  RATE_FIELDS,
  addedPricing,
  blankRates,
  changedPricing,
  draftFrom as pricingDraftFrom,
  isBlank,
  isDirty as isPricingDirty,
  isNewRowStarted,
  isSavable,
  newRow,
  newRowErrors,
  rowErrors,
  type NewRow,
  type PricingDraft,
  type RateField,
} from '../pricingDraft'
import type { ConfigPrice } from '../types/ConfigPrice'
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
import {
  canPick,
  changedSpeech,
  draftFrom as speechDraftFrom,
  isDirty as isSpeechDirty,
  isSavable as isSpeechSavable,
  options as voiceOptions,
  sampleButton,
  valueError as voiceError,
  type SpeechDraft,
} from '../speechDraft'
import {
  canPick as canPickModel,
  changedListen,
  draftFrom as listenDraftFrom,
  isDirty as isListenDirty,
  isSavable as isListenSavable,
  options as modelOptions,
  valueError as modelError,
  type ListenDraft,
} from '../listenDraft'
import {
  changedLive,
  draftFrom as liveDraftFrom,
  isDirty as isLiveDirty,
  isSavable as isLiveSavable,
  MAX_AUTO_SEND_MS,
  MIN_AUTO_SEND_MS,
  waitError,
  type LivePromptDraft,
} from '../livePromptDraft'
import type { ConfigCommand } from '../types/ConfigCommand'
import { useLiveContext } from '../liveContext'
import { useFetch } from '../useFetch'
import {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  changedWatchers,
  draftFrom as watchersDraftFrom,
  isDirty as isWatchersDirty,
  isSavable as isWatchersSavable,
  valueError,
  type WatchersDraft,
} from '../watchersDraft'

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
  // The whole page is one subject — the config file — so the page is the whole
  // report (mesa task 888).
  useLiveContext({ kind: 'settings', id: null, label: null, detail: null })
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

      <h2>Hooks</h2>
      <p className="muted">
        The hook mesa runs to start a coding agent. Leave a box empty to use
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

      <WatchersSection />
      <KeymapSection />
      <LivePromptSection />
      <SpeechSection />
      <ListenSection />
      <PricingSection />
      <SystemSection />
    </div>
  )
}

/**
 * Keyboard shortcuts: which chord runs each of mesa's four global keyboard
 * listeners (mesa task 1079). Its own section, draft and save button, for the
 * same reason watchers and pricing have theirs — a separate endpoint, so one
 * form's rejection must not strand the other's edits.
 *
 * The draft is the **whole** keymap rather than the overrides, because a
 * conflict is a fact about every binding at once: a chord recorded here has to
 * be judged against the six actions the user never touched as well. Only what
 * actually changed is PUT (`changedKeymap`), and an action drafted back to the
 * shipped chords is PUT as `null` — a default is an absence, never a stored
 * copy of itself.
 */
function KeymapSection() {
  const { data: config, error, refetch } = useFetch(() => getKeymap(), 'keymap')
  const [draft, setDraft] = useState<KeymapDraft | null>(null)
  const [recording, setRecording] = useState<KeymapAction | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  // A recorded chord's own keyup must not reach the app either: the
  // create-task shortcut is bound on keyup (mesa task 817), so recording `a`
  // would otherwise open the create-task form behind this page.
  const swallowKeyup = useRef(false)

  const seeded: KeymapDraft = draft ?? (config ? keymapDraftFrom(config) : resetAll())

  // The recording listener. Capture phase on `window`, so it runs before every
  // global shortcut listener in the app and `stopPropagation` keeps the chord
  // being recorded from also *firing* — pressing Cmd/Ctrl+Shift+P to rebind
  // the palette must not open the palette.
  useEffect(() => {
    if (recording === null) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        swallowKeyup.current = true
        return
      }
      const chord = chordFromEvent(e)
      // A bare modifier is how every chord starts, not a chord: keep waiting.
      if (chord === null) return
      setDraft((d) => withChord(d ?? seeded, recording, chord))
      setRecording(null)
      setSaved(false)
      swallowKeyup.current = true
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, seeded])

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (recording === null && !swallowKeyup.current) return
      swallowKeyup.current = false
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keyup', onKeyUp, true)
    return () => window.removeEventListener('keyup', onKeyUp, true)
  }, [recording])

  function save() {
    if (!config) return
    setSaving(true)
    setSaveError(null)
    updateKeymap(changedKeymap(config, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the rows show what
        // landed — and hand the same answer to the listeners, which are
        // mounted above this page and would otherwise keep the old chords
        // until a reload.
        setDraft(keymapDraftFrom(fresh))
        publishKeymap(fresh)
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
      <>
        <h2>Keyboard shortcuts</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!config) {
    return (
      <>
        <h2>Keyboard shortcuts</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isKeymapDirty(config, seeded)
  const savable = isKeymapSavable(seeded)
  const label = (id: KeymapAction) => ACTIONS.find((a) => a.id === id)?.label ?? id

  return (
    <>
      <h2>Keyboard shortcuts</h2>
      <p className="muted settings-command-blurb">
        The shortcuts that work anywhere in the app. A chord is recorded from
        the next key you press — ⌘ and Ctrl are one modifier, so a keymap means
        the same thing on either platform. Shortcuts without a modifier stand
        down while you are typing in a field, a terminal or a diagram; ones with
        a modifier do not. The Files tab's own chords and a form's Escape are
        not here: they belong to one panel while it is on screen, not to the
        app.
      </p>
      {ACTIONS.map((spec) => {
        const chords = seeded[spec.id] ?? []
        const clash = conflictingActions(seeded, spec.id)
        return (
          <section className="settings-command" key={spec.id}>
            <label>
              <span className="settings-command-title">{spec.label}</span>
              <code className="settings-command-key">{spec.id}</code>
            </label>
            <p className="muted settings-command-blurb">{spec.blurb}</p>
            <div className="settings-keymap-row">
              <span className="settings-keymap-chords">
                {recording === spec.id ? (
                  <span className="settings-pending">
                    press a chord — Escape cancels
                  </span>
                ) : (
                  chords.map((chord, i) => (
                    <span className="settings-keymap-chord" key={chord}>
                      {i > 0 && <span className="muted">or </span>}
                      {formatChord(chord).map((cap) => (
                        <kbd key={cap}>{cap}</kbd>
                      ))}
                    </span>
                  ))
                )}
              </span>
              <button
                type="button"
                aria-label={`Change the ${spec.label} shortcut`}
                onClick={() => {
                  setRecording(recording === spec.id ? null : spec.id)
                  setSaved(false)
                }}
              >
                {recording === spec.id ? 'cancel' : 'change'}
              </button>
              <button
                type="button"
                className="settings-reset"
                disabled={!isOverridden(seeded, spec.id)}
                title={`Back to ${DEFAULT_KEYMAP[spec.id].map(chordLabel).join(' or ')}`}
                onClick={() => {
                  setDraft(withReset(seeded, spec.id))
                  setSaved(false)
                }}
              >
                reset
              </button>
            </div>
            {clash.length > 0 && (
              <p className="error">
                also bound to {clash.map(label).join(', ')} — one chord belongs
                to one action
              </p>
            )}
          </section>
        )
      })}

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save shortcuts'}
        </button>
        <button
          type="button"
          className="settings-inline-button"
          onClick={() => {
            setDraft(resetAll())
            setRecording(null)
            setSaved(false)
          }}
        >
          reset all
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Watchers: how the background loops behave (mesa task 777) — today, how many
 * todo-watcher agents one project may have running at once. Its own section,
 * its own draft and its own save button, for the same reason pricing has one:
 * a separate endpoint, so one form's rejection must not strand the other's
 * edits.
 *
 * Blank is the built-in default, exactly as a blank command box is — clearing
 * the box PUTs `null`, which removes the key rather than writing a 1.
 */
function WatchersSection() {
  const { data: watchers, error, refetch } = useFetch(() => getWatchers(), 'watchers')
  const [draft, setDraft] = useState<WatchersDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: WatchersDraft =
    draft ?? (watchers ? watchersDraftFrom(watchers) : { todo_concurrency: '' })

  function edit(value: string) {
    setDraft({ ...seeded, todo_concurrency: value })
    setSaved(false)
  }

  function save() {
    if (!watchers) return
    setSaving(true)
    setSaveError(null)
    updateWatchers(changedWatchers(watchers, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(watchersDraftFrom(fresh))
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
      <>
        <h2>Watchers</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!watchers) {
    return (
      <>
        <h2>Watchers</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isWatchersDirty(watchers, seeded)
  const savable = isWatchersSavable(seeded)
  const fieldError = valueError(seeded.todo_concurrency)

  return (
    <>
      <h2>Watchers</h2>
      <section className="settings-command">
        <label htmlFor="watch-todo-concurrency">
          <span className="settings-command-title">
            Todo watcher: max concurrent agents per project
          </span>
          <code className="settings-command-key">todo_concurrency</code>
        </label>
        <p className="muted settings-command-blurb">
          blank = {watchers.todo_concurrency_default} (the default); lowering it
          never stops work already in flight
        </p>
        <input
          id="watch-todo-concurrency"
          type="number"
          min={MIN_CONCURRENCY}
          max={MAX_CONCURRENCY}
          step="1"
          className="settings-watcher-input"
          value={seeded.todo_concurrency}
          placeholder={String(watchers.todo_concurrency_default)}
          onChange={(e) => edit(e.target.value)}
        />
        {fieldError && <p className="error">{fieldError}</p>}
      </section>

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save watchers'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Live: how long a dictated line sits before the page sends it (mesa task
 * 886). Its own section, draft and save button, for the same reason watchers
 * and pricing have theirs — a separate endpoint, so one form's rejection must
 * not strand the other's edits.
 *
 * The instruction block the conversation's agent is spawned with used to
 * live here too (mesa task 867), but moved to the library as of mesa task
 * 919 — it is now the `mesa-live` agent definition (mesa task 1068), edited
 * on `#/library` like any other row, so this section only links there instead
 * of holding a second editor for it.
 *
 * One thing it must not soften: **a blank wait is the two seconds mesa
 * ships**, not "never send" — the box is empty on an unconfigured install
 * and clearing it removes the key.
 */
function LivePromptSection() {
  const { data: live, error, refetch } = useFetch(() => getLiveConfig(), 'live')
  const [draft, setDraft] = useState<LivePromptDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: LivePromptDraft =
    draft ?? (live ? liveDraftFrom(live) : { auto_send_ms: '' })

  function edit(patch: Partial<LivePromptDraft>) {
    setDraft({ ...seeded, ...patch })
    setSaved(false)
  }

  function save() {
    if (!live) return
    setSaving(true)
    setSaveError(null)
    updateLiveConfig(changedLive(live, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(liveDraftFrom(fresh))
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
      <>
        <h2>Live conversation</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!live) {
    return (
      <>
        <h2>Live conversation</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isLiveDirty(live, seeded)
  const savable = isLiveSavable(seeded)
  const waitFieldError = waitError(seeded.auto_send_ms)

  return (
    <>
      <h2>Live conversation</h2>
      <section className="settings-command">
        <span className="settings-command-title">Agent definition</span>
        <p className="muted settings-command-blurb">
          What the agent driving a spoken conversation is told to do now
          lives in the library — see <a href="#/library">the library</a>,
          under the <code>mesa-live</code> agent.
        </p>
      </section>

      <section className="settings-command">
        <label htmlFor="live-auto-send">
          <span className="settings-command-title">
            Wait before sending a dictated line
          </span>
          <code className="settings-command-key">live.auto-send-ms</code>
        </label>
        <p className="muted settings-command-blurb">
          How long the person may fall silent, while mesa is listening,
          before the transcribed recording so far is sent as one turn —
          dictation never presses Enter, so this pause is what ends a spoken
          thought. Blank = {live.auto_send_ms_default} ms (the default). It
          does not apply to text typed into the conversation box, which is
          sent by Enter alone (mesa task 977).
        </p>
        <input
          id="live-auto-send"
          type="number"
          min={MIN_AUTO_SEND_MS}
          max={MAX_AUTO_SEND_MS}
          step="50"
          className="settings-watcher-input"
          value={seeded.auto_send_ms}
          placeholder={String(live.auto_send_ms_default)}
          onChange={(e) => edit({ auto_send_ms: e.target.value })}
        />
        {waitFieldError && <p className="error">{waitFieldError}</p>}
      </section>

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save live settings'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Speech: the voice the Inbox's play button reads an item in (mesa task 822).
 * Its own section, draft and save button, for the same reason watchers and
 * pricing have theirs — a separate endpoint, so one form's rejection must not
 * strand the other's edits.
 *
 * Two things it must not soften:
 * - **Blank is the synthesiser's own default**, not silence: mesa passes no
 *   `-v` at all then, which is exactly what it did before this setting existed.
 * - **The list is what the installed binary reports**, not a list mesa ships.
 *   When mesa could not ask it (no `kokoro-rs` on PATH) there is no list to
 *   pick from, so the box becomes a plain one rather than an empty dropdown
 *   that would look like "no voices exist".
 */
function SpeechSection() {
  const { data: speech, error, refetch } = useFetch(() => getSpeech(), 'speech')
  const [draft, setDraft] = useState<SpeechDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  // The sample being played, if any: the voice it was started for and a nonce
  // that makes pressing test twice on the same voice a second play rather than
  // a no-op (the <audio> is keyed by it). Null is "nothing playing" — the
  // element is unmounted then, which is what stops the sound.
  const [sample, setSample] = useState<{ voice: string; nonce: number } | null>(
    null,
  )
  // Whether the sample's audio has actually started: synthesis takes seconds,
  // so "asked for it" and "hearing it" are different states, exactly as on the
  // Inbox page's play button.
  const [playing, setPlaying] = useState(false)
  const [sampleError, setSampleError] = useState(false)

  const seeded: SpeechDraft =
    draft ?? (speech ? speechDraftFrom(speech) : { voice: '' })

  function edit(value: string) {
    setDraft({ voice: value })
    setSaved(false)
    // A different voice is a different sample; stop the old one rather than
    // leave the previous voice playing under a changed selection.
    setSample(null)
    setPlaying(false)
    setSampleError(false)
  }

  // Stops the sample if one is playing, starts one for the drafted voice
  // otherwise — the drafted one, not the saved one, which is the whole point.
  function toggleSample() {
    setSampleError(false)
    setPlaying(false)
    setSample((current) =>
      current ? null : { voice: seeded.voice, nonce: Date.now() },
    )
  }

  function save() {
    if (!speech) return
    setSaving(true)
    setSaveError(null)
    updateSpeech(changedSpeech(speech, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(speechDraftFrom(fresh))
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
      <>
        <h2>Speech</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!speech) {
    return (
      <>
        <h2>Speech</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isSpeechDirty(speech, seeded)
  const savable = isSpeechSavable(seeded)
  const fieldError = voiceError(seeded.voice)

  return (
    <>
      <h2>Speech</h2>
      <section className="settings-command">
        <label htmlFor="speech-voice">
          <span className="settings-command-title">
            Inbox playback voice
          </span>
          <code className="settings-command-key">voice</code>
        </label>
        <p className="muted settings-command-blurb">
          The voice <code>kokoro-rs</code> reads an inbox item in when you press
          play. Blank = the voice the synthesiser picks itself; a change applies
          on the next press, with no restart.
        </p>
        <div className="settings-voice-row">
          {canPick(speech) ? (
            <select
              id="speech-voice"
              className="settings-voice-input"
              value={seeded.voice}
              onChange={(e) => edit(e.target.value)}
            >
              {/* Not a count: `options()` may carry a configured voice the
                  binary no longer lists, so any number here would be wrong in
                  exactly the case that matters. */}
              <option value="">default (the synthesiser's own)</option>
              {voiceOptions(speech).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="speech-voice"
              type="text"
              className="settings-voice-input"
              spellCheck={false}
              value={seeded.voice}
              placeholder="af_heart"
              onChange={(e) => edit(e.target.value)}
            />
          )}
          {/* Hears the *drafted* voice, not the saved one — so the choice can
              be made before it is committed. Refused while the name is one the
              save would reject: there is nothing to audition then. */}
          <button
            type="button"
            disabled={!!fieldError}
            title={sampleButton(!!sample, playing).title}
            onClick={toggleSample}
          >
            {sampleButton(!!sample, playing).label}
          </button>
        </div>
        {!canPick(speech) && (
          <p className="muted settings-command-blurb">
            mesa could not ask <code>kokoro-rs</code> which voices it has — type
            a name, or run <code>kokoro-rs --list-voices</code> to see them.
          </p>
        )}
        {fieldError && <p className="error">{fieldError}</p>}
        {sampleError && (
          <p className="error">could not play a sample in this voice</p>
        )}
      </section>

      {/* One player, unmounted to stop — the same shape (and the same
          `AbortError` caveat) as the Inbox page's, so a browser that refuses
          autoplay reports a failure instead of leaving the button reading
          "synthesising…" forever. The in-flight synthesis on the server
          finishes and its bytes are discarded. */}
      {sample && (
        <audio
          key={`${sample.voice}:${sample.nonce}`}
          src={speechPreviewUrl(sample.voice)}
          ref={(el) => {
            // A refusal that lands after this element is gone belongs to a
            // sample the user has already replaced or stopped, so it must not
            // report a failure against whatever is playing by then — the
            // Inbox player guards the same race with its item id. The cleanup
            // runs on unmount, which is exactly when this closure goes stale.
            let live = true
            el?.play().catch((err: DOMException) => {
              if (err.name === 'AbortError' || !live) return
              setSampleError(true)
              setSample(null)
              setPlaying(false)
            })
            return () => {
              live = false
            }
          }}
          onPlaying={() => setPlaying(true)}
          onEnded={() => {
            setSample(null)
            setPlaying(false)
          }}
          onError={() => {
            setSampleError(true)
            setSample(null)
            setPlaying(false)
          }}
        />
      )}

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save speech'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Listen: the model `live transcribe` runs the external `auris` speech-to-text
 * binary with (mesa task 955). Its own section, draft and save button, for
 * the same reason speech has one — a separate endpoint, so one form's
 * rejection must not strand the other's edits.
 *
 * The input-side mirror of `SpeechSection`, minus a test button: `auris` has
 * nothing like speaking a sample.
 *
 * Two things it must not soften:
 * - **Blank is the binary's own default**, not silence: mesa passes no `-m`
 *   at all then, which is exactly what it did before this setting existed.
 * - **The list is what the installed binary reports**, not a list mesa
 *   ships. When mesa could not ask it (no `auris` on PATH) there is no list
 *   to pick from, so the box becomes a plain one rather than an empty
 *   dropdown that would look like "no models exist".
 */
function ListenSection() {
  const { data: listen, error, refetch } = useFetch(() => getListen(), 'listen')
  const [draft, setDraft] = useState<ListenDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: ListenDraft =
    draft ?? (listen ? listenDraftFrom(listen) : { model: '' })

  function edit(value: string) {
    setDraft({ model: value })
    setSaved(false)
  }

  function save() {
    if (!listen) return
    setSaving(true)
    setSaveError(null)
    updateListen(changedListen(listen, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(listenDraftFrom(fresh))
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
      <>
        <h2>Listen</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!listen) {
    return (
      <>
        <h2>Listen</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isListenDirty(listen, seeded)
  const savable = isListenSavable(seeded)
  const fieldError = modelError(seeded.model)

  return (
    <>
      <h2>Listen</h2>
      <section className="settings-command">
        <label htmlFor="listen-model">
          <span className="settings-command-title">
            Live transcription model
          </span>
          <code className="settings-command-key">model</code>
        </label>
        <p className="muted settings-command-blurb">
          The model <code>auris</code> decodes a live-conversation recording
          with. Blank = the model auris picks itself; a change applies on the
          next transcription, with no restart.
        </p>
        <div className="settings-voice-row">
          {canPickModel(listen) ? (
            <select
              id="listen-model"
              className="settings-voice-input"
              value={seeded.model}
              onChange={(e) => edit(e.target.value)}
            >
              {/* Not a count: `options()` may carry a configured model the
                  binary no longer lists, so any number here would be wrong in
                  exactly the case that matters. */}
              <option value="">default (the binary's own)</option>
              {modelOptions(listen).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="listen-model"
              type="text"
              className="settings-voice-input"
              spellCheck={false}
              value={seeded.model}
              placeholder="parakeet-tdt-0.6b-v2-int8"
              onChange={(e) => edit(e.target.value)}
            />
          )}
        </div>
        {!canPickModel(listen) && (
          <p className="muted settings-command-blurb">
            mesa could not ask <code>auris</code> which models it has — type a
            name, or run <code>auris --list-models</code> to see them.
          </p>
        )}
        {fieldError && <p className="error">{fieldError}</p>}
      </section>

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save listen'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
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

/**
 * Model pricing: the rates the CC Dashboard's est. cost is computed from
 * (mesa task 692). Its own section, its own draft and its own save button —
 * it is a separate endpoint, so merging the two forms would let one form's
 * rejection strand the other's edits.
 *
 * Two rules, both the server's:
 * - matching is by **prefix** (`claude-opus` prices every Opus release), the
 *   longest match winning, so a variant can be priced beside its family;
 * - a blank row is "use the built-in rate" — the reset for a family mesa
 *   ships, the delete for a prefix the user added.
 */
function PricingSection() {
  const { data: prices, error, refetch } = useFetch(() => getPricing(), 'pricing')
  const [draft, setDraft] = useState<PricingDraft | null>(null)
  const [extra, setExtra] = useState<NewRow[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: PricingDraft = draft ?? (prices ? pricingDraftFrom(prices) : {})

  function editRate(prefix: string, field: RateField, value: string) {
    setDraft({ ...seeded, [prefix]: { ...seeded[prefix], [field]: value } })
    setSaved(false)
  }

  function clearRow(prefix: string) {
    setDraft({ ...seeded, [prefix]: blankRates() })
    setSaved(false)
  }

  function editNew(index: number, next: NewRow) {
    setExtra(extra.map((row, i) => (i === index ? next : row)))
    setSaved(false)
  }

  function save() {
    if (!prices) return
    setSaving(true)
    setSaveError(null)
    updatePricing({
      ...changedPricing(prices, seeded),
      ...addedPricing(extra),
    }).then(
      (fresh) => {
        // Re-seed from what landed; an added prefix comes back an ordinary row.
        setDraft(pricingDraftFrom(fresh))
        setExtra([])
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
      <>
        <h2>Model pricing</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!prices) {
    return (
      <>
        <h2>Model pricing</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isPricingDirty(prices, seeded) || extra.some(isNewRowStarted)
  const errors = newRowErrors(extra)
  const savable = isSavable(prices, seeded) && errors.length === 0

  return (
    <>
      <h2>Model pricing</h2>
      <p className="muted">
        USD per 1M tokens, used for the CC Dashboard's estimated cost. Models are
        matched by <strong>prefix</strong> — <code>claude-opus</code> prices every
        Opus release — and the longest matching prefix wins, so{' '}
        <code>claude-opus-5-mini</code> can be priced separately. Leave a row
        blank to use the built-in rate shown in the boxes; a model no prefix
        matches is estimated at $0. A change applies on the next dashboard read,
        past sessions included, with no restart.
      </p>

      <div className="settings-prices">
        <div className="settings-price-head muted">
          <span>prefix</span>
          <span>input</span>
          <span>output</span>
          <span>cache read</span>
          <span>cache write</span>
          <span />
        </div>
        {prices.map((p) => (
          <PriceRow
            key={p.prefix}
            price={p}
            draft={seeded}
            onEdit={(field, value) => editRate(p.prefix, field, value)}
            onClear={() => clearRow(p.prefix)}
          />
        ))}
        {extra.map((row, i) => (
          <NewPriceRow
            key={i}
            row={row}
            onEdit={(next) => editNew(i, next)}
            onRemove={() => setExtra(extra.filter((_, j) => j !== i))}
          />
        ))}
      </div>

      <div className="settings-actions">
        <button type="button" onClick={() => setExtra([...extra, newRow()])}>
          add model prefix
        </button>
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save pricing'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {errors.map((e) => (
        <p className="error" key={e}>
          {e}
        </p>
      ))}
      {saveError && <p className="error">{saveError}</p>}

      <ResetCcIndex />
    </>
  )
}

/**
 * Purges the stored Claude Code telemetry and re-ingests the transcripts on
 * disk (mesa task 698). It lives in the pricing section because it is the
 * other half of "what the CC Dashboard's cost says" — not in the header row,
 * where Restart is deliberately the one always-reachable control.
 *
 * Confirmed, because it is destructive of history: rows whose transcript file
 * Claude Code has since deleted cannot come back. Nothing on this page reads
 * cc data, so there is nothing to refetch — the counts are the receipt, and
 * the dashboard picks the new rows up on its next read.
 */
function ResetCcIndex() {
  const [pending, setPending] = useState(false)
  const [report, setReport] = useState<CcResetReport | null>(null)

  function reset() {
    setPending(true)
    setReport(null)
    return resetCcIndex()
      .then((r) => setReport(r))
      .finally(() => setPending(false))
  }

  return (
    <div className="settings-actions">
      <ConfirmDelete
        // Remount after a run so the control disarms itself, ready for the next.
        key={report ? 'done' : 'idle'}
        label="Reset CC index"
        message="Deletes the stored Claude Code telemetry and re-reads every transcript on disk (10-30s). Fixes inflated costs recorded before the dedupe fix. Sessions whose transcript file no longer exists are lost permanently."
        onDelete={reset}
      />
      {pending && <span className="muted">re-reading transcripts…</span>}
      {report && !pending && (
        <span className="settings-saved">
          re-indexed {report.files_ingested}/{report.files_scanned} transcripts —{' '}
          {report.sessions} sessions, {report.messages_added} messages
        </span>
      )}
    </div>
  )
}

/** One priced family: four boxes over the built-in rate as placeholder. */
function PriceRow({
  price,
  draft,
  onEdit,
  onClear,
}: {
  price: ConfigPrice
  draft: PricingDraft
  onEdit: (field: RateField, value: string) => void
  onClear: () => void
}) {
  const row = draft[price.prefix] ?? blankRates()
  const overridden = !isBlank(row)
  const errors = rowErrors(price.prefix, row, price.default)
  return (
    <>
      <div className="settings-price-row">
        <code className="settings-price-prefix">{price.prefix}</code>
        {RATE_FIELDS.map((field) => (
          <input
            key={field}
            type="number"
            min="0"
            step="any"
            className="settings-price-input"
            aria-label={`${price.prefix} ${field}`}
            value={row[field]}
            placeholder={price.default ? String(price.default[field]) : '0'}
            onChange={(e) => onEdit(field, e.target.value)}
          />
        ))}
        {overridden ? (
          <button
            type="button"
            className="settings-reset"
            title={
              price.default
                ? 'Clear this row, restoring the built-in rate'
                : 'Remove this prefix'
            }
            onClick={onClear}
          >
            {price.default ? 'reset to default' : 'remove'}
          </button>
        ) : (
          <span className="muted settings-price-note">built-in</span>
        )}
      </div>
      {errors.map((e) => (
        <p className="error" key={e}>
          {price.prefix} — {e}
        </p>
      ))}
    </>
  )
}

/** A prefix being added: the same row, plus an editable prefix box. */
function NewPriceRow({
  row,
  onEdit,
  onRemove,
}: {
  row: NewRow
  onEdit: (next: NewRow) => void
  onRemove: () => void
}) {
  return (
    <div className="settings-price-row">
      <input
        type="text"
        className="settings-price-input"
        aria-label="new model prefix"
        placeholder="claude-opus-5-mini"
        spellCheck={false}
        value={row.prefix}
        onChange={(e) => onEdit({ ...row, prefix: e.target.value })}
      />
      {RATE_FIELDS.map((field) => (
        <input
          key={field}
          type="number"
          min="0"
          step="any"
          className="settings-price-input"
          aria-label={`new prefix ${field}`}
          value={row.rates[field]}
          onChange={(e) =>
            onEdit({ ...row, rates: { ...row.rates, [field]: e.target.value } })
          }
        />
      ))}
      <button
        type="button"
        className="settings-reset"
        title="Drop this row"
        onClick={onRemove}
      >
        remove
      </button>
    </div>
  )
}

/**
 * The host mesa is running on (mesa task 1093). **Read-only** — unlike every
 * other section on this page it edits nothing, has no draft and no save
 * button, because the machine is not a setting. It is here because Settings
 * is already the page about *this installation* rather than about a project,
 * and because the server is often on a box nobody is sitting at.
 *
 * Polled rather than fetched once: it is a live reading, and `GET /api/system`
 * itself blocks ~200ms taking a second CPU sample, so 3s is as fast as the
 * numbers are worth. `useFetch` drops a poll whose result is unchanged and
 * pauses entirely while the tab is hidden.
 *
 * The rule this section must not soften: **a value the host would not report
 * is `null`, and a `null` is typeset, never metered.** Drawing an empty bar
 * for an unknown figure would claim the machine has none of it.
 */
function SystemSection() {
  const { data: info, error } = useFetch(getSystemInfo, 'system-info', {
    pollMs: 3000,
  })

  if (error) {
    return (
      <>
        <h2>System</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!info) {
    return (
      <>
        <h2>System</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const load = info.load_average
  return (
    <>
      <h2>System</h2>
      <p className="muted">
        The host this server is running on, read fresh every few seconds and
        never stored. A dash means the machine did not report that figure —
        which is not the same as zero.
      </p>
      <section className="settings-command settings-system">
        <Meter
          label="Memory"
          pct={usedPct(info.ram_used_bytes, info.ram_total_bytes)}
          detail={`${formatBytes(info.ram_used_bytes)} of ${formatBytes(info.ram_total_bytes)}`}
        />
        <Meter
          label="Swap"
          pct={usedPct(info.swap_used_bytes, info.swap_total_bytes)}
          detail={
            info.swap_total_bytes > 0
              ? `${formatBytes(info.swap_used_bytes)} of ${formatBytes(info.swap_total_bytes)}`
              : 'none configured'
          }
        />
        <Meter
          label="CPU"
          pct={clampPct(info.cpu_usage_pct)}
          detail={info.cpu_model ?? 'model not reported'}
        />
        <div className="settings-system-cores">
          {info.cpu_per_core_pct.map((p, i) => {
            const pct = clampPct(p) ?? 0
            return (
              <span
                key={i}
                className="settings-system-core"
                title={`core ${i + 1}: ${pct.toFixed(0)}%`}
              >
                <span
                  className={`settings-system-core-fill ${systemSeverity(pct)}`}
                  style={{ height: `${pct}%` }}
                />
              </span>
            )
          })}
        </div>
        <Meter
          label="Disk (mesa database volume)"
          pct={
            info.disk_total_bytes !== null && info.disk_free_bytes !== null
              ? usedPct(
                  info.disk_total_bytes - info.disk_free_bytes,
                  info.disk_total_bytes,
                )
              : null
          }
          detail={
            info.disk_free_bytes !== null
              ? `${formatBytes(info.disk_free_bytes)} free of ${formatBytes(info.disk_total_bytes)}`
              : 'not reported'
          }
        />
        {info.gpu && (
          <Meter
            label="GPU"
            // Always null today: real utilisation needs privileged
            // `powermetrics`, so the row is a fact sheet, not a meter.
            pct={clampPct(info.gpu.usage_pct)}
            detail={
              info.gpu.vram_bytes !== null
                ? `${info.gpu.name} · ${formatBytes(info.gpu.vram_bytes)} VRAM`
                : `${info.gpu.name} · shared memory`
            }
          />
        )}
        <dl className="settings-system-facts">
          <dt>Host</dt>
          <dd>{info.hostname ?? '—'}</dd>
          <dt>OS</dt>
          <dd>{info.os ?? '—'}</dd>
          <dt>Cores</dt>
          <dd>
            {info.cpu_cores !== null
              ? `${info.cpu_cores} physical · ${info.cpu_logical} logical`
              : `${info.cpu_logical} logical`}
          </dd>
          <dt>Load</dt>
          <dd>
            {load
              ? load.map((n) => n.toFixed(2)).join(' · ')
              : 'not reported on this platform'}
          </dd>
          <dt>Uptime</dt>
          <dd>{formatUptime(info.uptime_secs)}</dd>
          <dt>mesa process</dt>
          <dd>{formatBytes(info.process_rss_bytes)}</dd>
        </dl>
      </section>
    </>
  )
}

/**
 * One labelled bar. A `null` percentage draws **no track at all** — just the
 * label and whatever the host did say — which is the whole point of keeping
 * `null` distinct from 0 all the way from `core::system`.
 */
function Meter({
  label,
  pct,
  detail,
}: {
  label: string
  pct: number | null
  detail: string
}) {
  return (
    <div className="settings-system-row">
      <div className="settings-system-rowtop">
        <span className="settings-system-label">{label}</span>
        <span className="settings-system-pct">
          {pct === null ? 'not reported' : `${pct.toFixed(0)}%`}
        </span>
      </div>
      {pct !== null && (
        <div className="settings-system-track">
          <div
            className={`settings-system-fill ${systemSeverity(pct)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="settings-system-detail muted">{detail}</div>
    </div>
  )
}
