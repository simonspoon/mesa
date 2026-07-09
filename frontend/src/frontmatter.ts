// A leading YAML frontmatter block must open on the file's very first line —
// the same start-of-file heuristic gray-matter/Jekyll/Hugo use — so a document
// that merely opens with a `---` thematic break elsewhere isn't misdetected.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/

export function splitFrontmatter(content: string): {
  frontmatter: string | null
  body: string
} {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return { frontmatter: null, body: content }
  return { frontmatter: match[1], body: content.slice(match[0].length) }
}
