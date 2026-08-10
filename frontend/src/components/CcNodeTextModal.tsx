import { useEffect, useState } from 'react'
import { ApiError, getCcNodeText } from '../api'
import { formatTokens, shortModel } from '../sessionGraph'
import type { CcGraphNode } from '../types/CcGraphNode'
import type { CcNodeText } from '../types/CcNodeText'

// One timeline row's **full, uncapped** body (mesa task 803), over
// `GET /api/cc/sessions/{id}/nodes/{node}/text`.
//
// The wrapper/panel split and the class names are both deliberate:
// `.create-task-backdrop` is the shared backdrop every modal mounts, and it is
// one of the selectors `keyboardScope.ts::shouldIgnoreShortcut()` watches — so
// reusing it is what suppresses the global single-key shortcuts while this is
// open (docs/keyboard.md). A modal that invented its own backdrop class would
// have to be added to that predicate by hand.
//
// The fetch is lazy by construction: the view mounts this component only once a
// row has been opened, so a session's few hundred rows cost nothing until one
// is asked for.

export function CcNodeTextModal({
  sessionId,
  node,
  onClose,
}: {
  sessionId: string
  node: CcGraphNode
  onClose: () => void
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Stop here rather than letting it reach a listener behind the modal —
        // the same thing CreateTaskModal does.
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="create-task-backdrop" onClick={onClose}>
      <div
        className="create-task-modal cc-nodetext-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Node text"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Keyed on the node, so opening a different row remounts the panel
            with empty state rather than clearing it inside the effect (which
            is the `react-hooks/set-state-in-effect` cascade the repo lints
            against). */}
        <CcNodeTextPanel
          key={`${sessionId}:${node.id}`}
          sessionId={sessionId}
          node={node}
          onClose={onClose}
        />
      </div>
    </div>
  )
}

function CcNodeTextPanel({
  sessionId,
  node,
  onClose,
}: {
  sessionId: string
  node: CcGraphNode
  onClose: () => void
}) {
  const [data, setData] = useState<CcNodeText | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)

  useEffect(() => {
    let live = true
    getCcNodeText(sessionId, node.id)
      .then((d) => {
        if (live) setData(d)
      })
      .catch((e: unknown) => {
        if (!live) return
        const code = e instanceof ApiError ? e.code : 'error'
        const message = e instanceof Error ? e.message : String(e)
        setError({ code, message })
      })
    return () => {
      live = false
    }
  }, [sessionId, node.id])

  // The stored, bounded preview the row itself shows. It is what remains when
  // the transcript has been deleted out from under us — less than the whole
  // body, but not nothing.
  const preview = node.description ?? node.target
  const model = shortModel(data?.model ?? node.model)
  const ts = data?.ts ?? node.ts

  return (
    <>
      {/* `.panel-head` is a right-aligned flex row holding the ✕ and nothing
          else — every other panel in the app puts its heading *after* it, and
          a title dropped inside would be pushed against the button. */}
      <div className="panel-head">
        <button type="button" className="panel-close" onClick={onClose}>
          ✕
        </button>
      </div>
      {/* Untrusted: `name` is model/transcript-authored. Text child only. */}
      <h2 className="cc-nodetext-title">{data?.name ?? node.name}</h2>

      <div className="cc-nodetext-meta">
        <span className="cc-badge">{data?.kind ?? node.kind}</span>
        {ts && <span>{ts.replace('T', ' ').slice(0, 19)}</span>}
        {model && <span className="cc-nodetext-model">{model}</span>}
        {/* A prompt carries no usage of its own, so printing its payload `0`
            would read as a real measurement of nothing — same rule as the row. */}
        {node.kind !== 'prompt' && (
          <span>
            {node.tokens_are_rollup ? '' : '≈'}
            {formatTokens(node.total_tokens)} tokens
          </span>
        )}
      </div>

      {error ? (
        error.code === 'unavailable' ? (
          <>
            <p className="muted">
              The transcript this came from is no longer on disk, so the full text can’t be read.
              What mesa stored is below.
            </p>
            {/* Untrusted transcript text: a text child of a <pre>, never markup. */}
            <pre className="cc-nodetext-body">{preview ?? ''}</pre>
            {!preview && <p className="muted">No stored preview either.</p>}
          </>
        ) : (
          <p className="error">{error.message}</p>
        )
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : (
        // Untrusted, uncapped, model-authored text — the whole point of this
        // view is that it is verbatim. Rendered as a text child of a <pre>:
        // never markup, never a link, never dangerouslySetInnerHTML.
        <pre className={`cc-nodetext-body${data.format === 'json' ? ' is-json' : ''}`}>
          {data.text}
        </pre>
      )}
    </>
  )
}
