// Whether the Files tab's viewer and editor soft-wrap long lines (mesa task
// 809). Machine-local (localStorage) and ONE global preference across every
// project, file and pane — the same reasoning `filesTreeWidth.ts` sets out: it
// is a statement about how this browser should render code, not about any one
// repo, so it has no column, no route and no place in a backup.
//
// Off is the recoverable state, and the one the tab shipped with (`wrap="off"`,
// the pane scrolling sideways), so anything other than the exact stored `true`
// — nothing stored, a hand-edited value, an older shape — reads as off.

const KEY = 'mesa-files-word-wrap'

export function loadWordWrap(): boolean {
  return localStorage.getItem(KEY) === 'true'
}

export function saveWordWrap(wrap: boolean): void {
  localStorage.setItem(KEY, String(wrap))
}
