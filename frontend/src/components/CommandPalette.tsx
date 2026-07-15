import { useEffect, useMemo, useRef, useState } from 'react'
import { listProjects } from '../api'
import type { Project } from '../types/Project'
import { useFetch } from '../useFetch'

interface Command {
  id: string
  label: string
  // Lowercased "keyword" string matched against the query — deliberately
  // separate from `label` so filler words in the label ("Go to", "Create
  // task in") never cause a false match.
  search: string
  run: () => void
}

function navigate(hash: string) {
  window.location.hash = hash
}

/**
 * Fixed top-level destinations plus, per project: "Go to <name>" (the
 * board), the git/files/dashboard/storyboards sub-views, and
 * "Create task in <name>" (which lands on the create-task route —
 * ProjectTasksPage opens the form with its title input focused).
 */
function buildCommands(projects: Project[]): Command[] {
  const commands: Command[] = [
    { id: 'cc', label: 'CC Dashboard', search: 'cc dashboard', run: () => navigate('#/cc') },
    { id: 'inbox', label: 'Inbox', search: 'inbox', run: () => navigate('#/inbox') },
  ]
  for (const p of projects) {
    const name = p.name.toLowerCase()
    commands.push({
      id: `go-${p.id}`,
      label: `Go to ${p.name}`,
      search: `${name} board`,
      run: () => navigate(`#/projects/${p.id}`),
    })
    commands.push({
      id: `git-${p.id}`,
      label: `${p.name} — Git`,
      search: `${name} git`,
      run: () => navigate(`#/projects/${p.id}/git`),
    })
    commands.push({
      id: `files-${p.id}`,
      label: `${p.name} — Files`,
      search: `${name} files`,
      run: () => navigate(`#/projects/${p.id}/files`),
    })
    commands.push({
      id: `dashboard-${p.id}`,
      label: `${p.name} — Dashboard`,
      search: `${name} dashboard`,
      run: () => navigate(`#/projects/${p.id}/dashboard`),
    })
    commands.push({
      id: `storyboards-${p.id}`,
      label: `${p.name} — Storyboards`,
      search: `${name} storyboards`,
      run: () => navigate(`#/projects/${p.id}/storyboards`),
    })
    commands.push({
      id: `create-${p.id}`,
      label: `Create task in ${p.name}`,
      search: `${name} create task new`,
      run: () => navigate(`#/projects/${p.id}/create-task`),
    })
  }
  return commands
}

// Word-AND: every whitespace-separated token in the query must appear
// somewhere in the command's search string.
function matches(command: Command, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every((t) => command.search.includes(t))
}

/**
 * Obsidian/VS-Code-style command palette: a centered modal opened by
 * Cmd/Ctrl+Shift+P (App.tsx) that fuzzy/substring-filters a combined list
 * of navigation + create-task commands. Escape and a backdrop click close
 * it; Up/Down move the selection, Enter runs it.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { data: projects } = useFetch(() => listProjects(), 'command-palette-projects')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const commands = useMemo(() => buildCommands(projects ?? []), [projects])
  const filtered = useMemo(
    () => commands.filter((c) => matches(c, query)),
    [commands, query],
  )

  // Re-filtering drops stale selections (e.g. index 8 selected, next
  // keystroke leaves only 3 results) — always reset to the top match.
  // Adjust state during render off the changed query rather than in an
  // effect (avoids a cascading render), matching ProjectTasksPage's
  // `prevTaskId` pattern.
  const [prevQuery, setPrevQuery] = useState(query)
  if (query !== prevQuery) {
    setPrevQuery(query)
    setSelected(0)
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep the selected row in view as Up/Down moves past the visible window.
  useEffect(() => {
    const el = listRef.current?.children[selected]
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [selected])

  function run(index: number) {
    const command = filtered[index]
    if (!command) return
    command.run()
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(selected)
    } else if (e.key === 'Escape') {
      // Stop here so it doesn't also reach a background view's own Escape
      // listener (e.g. the expanded storyboard canvas) — the palette is a
      // modal, so Escape closes only it.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          value={query}
          placeholder="Jump to a project, view, or create a task…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="command-palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <li className="command-palette-empty muted">No matches.</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.id}
                className={`command-palette-item${i === selected ? ' active' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(i)}
              >
                {c.label}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
