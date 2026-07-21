// The folder the new-project picker last confirmed with "use this folder".
// Reopening the picker starts there instead of the server's $HOME — most new
// projects live beside the previous one, so $HOME is rarely the useful floor
// after the first time. Machine-local (localStorage), like the storyboard
// view state and author name: it's a per-browser convenience, never project
// or server data.

const KEY = 'mesa-last-folder'

export function getLastFolder(): string | undefined {
  return localStorage.getItem(KEY) ?? undefined
}

export function setLastFolder(path: string): void {
  localStorage.setItem(KEY, path)
}

/** Called when the remembered folder no longer lists — it was moved or deleted
 * since it was stored, so the picker falls back to $HOME and forgets it. */
export function clearLastFolder(): void {
  localStorage.removeItem(KEY)
}
