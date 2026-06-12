import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { docUrl, getDoc, listDocs } from '../api'
import { useFetch } from '../useFetch'

/**
 * Docs tab (spec Requirements 6-8): a left-hand file tree of everything
 * under the project's docs_path, and a read-only viewer for the selected
 * file. Markdown renders via react-markdown + GFM with raw HTML disabled
 * (no rehype-raw); ```mermaid blocks render as diagrams via a lazily
 * imported mermaid; images render inline; other files show as plain text
 * when they decode as UTF-8, otherwise "no preview".
 */
export function DocsTab({
  projectId,
  docsPath,
}: {
  projectId: number
  docsPath: string | null
}) {
  const [selected, setSelected] = useState<string | null>(null)
  // Keyed on docsPath so changing the path in the header refetches.
  const { data: paths, error } = useFetch(
    () => listDocs(projectId),
    `docs-${projectId}-${docsPath ?? ''}`,
  )

  if (error) {
    return (
      <div>
        <p className="error">{error}</p>
        {!docsPath && (
          <p className="muted">
            Set the docs path in the project header above to enable this tab.
          </p>
        )}
      </div>
    )
  }
  if (!paths) return <p className="muted">Loading…</p>
  if (paths.length === 0) return <p className="muted">No documents yet.</p>

  return (
    <div className="docs-view">
      <nav className="doc-tree-pane">
        <DirEntries
          dir={buildTree(paths)}
          selected={selected}
          onSelect={setSelected}
        />
      </nav>
      <div className="doc-viewer">
        {selected ? (
          <DocViewer key={selected} projectId={projectId} path={selected} />
        ) : (
          <p className="muted">Select a file to view it.</p>
        )}
      </div>
    </div>
  )
}

// ---- file tree ----

interface Dir {
  dirs: Map<string, Dir>
  files: { name: string; path: string }[]
}

/** Nests the flat (sorted) path list into directories client-side. */
function buildTree(paths: string[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push({ name: parts[parts.length - 1], path })
  }
  return root
}

function DirEntries({
  dir,
  selected,
  onSelect,
}: {
  dir: Dir
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <ul className="doc-tree">
      {[...dir.dirs.entries()].map(([name, sub]) => (
        <li key={name}>
          <details open>
            <summary>{name}/</summary>
            <DirEntries dir={sub} selected={selected} onSelect={onSelect} />
          </details>
        </li>
      ))}
      {dir.files.map((f) => (
        <li key={f.path}>
          <button
            className={`doc-file${selected === f.path ? ' active' : ''}`}
            onClick={() => onSelect(f.path)}
          >
            {f.name}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ---- viewer ----

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

function extension(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** `text: null` means the bytes are not valid UTF-8 (binary → no preview). */
function decodeUtf8(buf: ArrayBuffer): { text: string | null } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  } catch {
    return { text: null }
  }
}

function DocViewer({ projectId, path }: { projectId: number; path: string }) {
  const ext = extension(path)
  const isImage = IMAGE_EXTS.includes(ext)
  const { data, error } = useFetch(
    () =>
      isImage
        ? Promise.resolve(null)
        : getDoc(projectId, path).then(decodeUtf8),
    `doc-${projectId}-${path}`,
  )

  if (isImage) {
    return <img className="doc-image" src={docUrl(projectId, path)} alt={path} />
  }
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  if (data.text === null) {
    return <p className="muted">No preview for this file type.</p>
  }
  if (ext === 'md' || ext === 'markdown') {
    return (
      <div className="doc-markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ node: _node, className, children, ...rest }) {
              if (className?.includes('language-mermaid')) {
                return <Mermaid source={String(children)} />
              }
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              )
            },
          }}
        >
          {data.text}
        </Markdown>
      </div>
    )
  }
  return <pre className="doc-plain">{data.text}</pre>
}

// ---- mermaid ----

// mermaid.render needs a document-unique element id per diagram.
let mermaidSeq = 0

/**
 * Renders a ```mermaid block as a diagram. The mermaid library is heavy
 * (spec Requirement 8), so it is dynamically imported here — keeping it
 * out of the initial Vite chunk. A parse/render error falls back to the
 * fenced source as a plain code block.
 */
function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${mermaidSeq++}`
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        // securityLevel stays at its default ('strict').
        mermaid.initialize({ startOnLoad: false, theme: 'dark' })
        const { svg } = await mermaid.render(id, source)
        if (!cancelled) setSvg(svg)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [source])

  if (failed) return <code className="doc-mermaid-error">{source}</code>
  if (!svg) return <span className="muted">rendering diagram…</span>
  // The svg comes from mermaid.render under securityLevel 'strict',
  // which sanitizes the diagram text.
  return (
    <span
      className="doc-mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
