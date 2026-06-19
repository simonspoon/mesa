// The local actor id ("who am I") stamped on storyboards, frames, and edges
// for attribution. Collaboration is asynchronous and attribution-based, so the
// web just needs a name to send; it persists in localStorage between visits
// and defaults to "user".

const KEY = 'mesa-author'

export function getAuthor(): string {
  return localStorage.getItem(KEY) || 'user'
}

export function setAuthor(name: string): void {
  const trimmed = name.trim()
  if (trimmed === '') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, trimmed)
}
