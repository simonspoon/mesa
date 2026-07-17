import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

/**
 * An xterm.js terminal wired to a raw PTY over a websocket. Generalized out
 * of `AgentTerminal.tsx` (mesa task 395 / .scratch/arch.md §4.1) so a second
 * PTY-backed surface (the Terminal page, `/api/terminal/attach`) reuses the
 * exact same open/message/data/resize/keepalive-tolerant-close wiring
 * instead of a hand-copied (and driftable) second implementation —
 * `AgentTerminal` is now a thin wrapper over this component.
 *
 * Wire protocol (see src/api.rs's shared `pump_pty`): server→client binary
 * frames are raw PTY output; client→server binary frames are keystrokes and
 * text frames are JSON control (`{"resize":{cols,rows}}`). Closing this
 * component only tears down its own socket/pty — whatever's on the other
 * end (a `claude attach` bridge or a raw shell) is the caller's concern via
 * `closedMessage`'s wording, not this component's.
 */
export function PtyTerminal({
  endpoint,
  closedMessage,
}: {
  // Path (no origin) to the websocket endpoint to attach to, e.g.
  // `/api/agents/${agentId}/attach` or `/api/terminal/attach`.
  endpoint: string
  // Shown in the "connection closed" banner — callers know what "closed"
  // means for their own backing process (session detach vs. shell exit).
  closedMessage: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [closed, setClosed] = useState(false)
  // Bumped by the reconnect button to force the effect to re-run and open a
  // fresh socket without unmounting (the parent's key is its own pane
  // identity, which does not change on reconnect).
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // Each (re)connect starts from a clean "not closed" state; a stale banner
    // from a previous socket must not linger over a live one.
    setClosed(false)
    // Guards the async onclose: a socket torn down by THIS effect's cleanup
    // (React StrictMode double-mounts in dev, aborting the first CONNECTING
    // socket) must not flip the banner on — only a close we did not initiate
    // should. Captured per effect run.
    let disposed = false
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Share Tech Mono", Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: '#060a10',
        foreground: '#b8dde8',
        cursor: '#00e5ff',
        selectionBackground: 'rgba(0, 229, 255, 0.3)',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${proto}://${window.location.host}${endpoint}?cols=${term.cols}&rows=${term.rows}`,
    )
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => term.write(new Uint8Array(ev.data as ArrayBuffer))
    ws.onopen = () => {
      // Resizes fit()'d during the CONNECTING window were dropped (the guard
      // below only sends when OPEN); push the current size once so the PTY
      // matches the actual viewport rather than the initial query-param size.
      ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }))
    }
    ws.onclose = () => {
      if (!disposed) setClosed(true)
    }

    const encoder = new TextEncoder()
    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d))
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ resize: { cols, rows } }))
    })
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(el)
    term.focus()

    return () => {
      disposed = true
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      ws.close()
      term.dispose()
    }
  }, [endpoint, epoch])

  return (
    <div className="agent-terminal">
      {closed && (
        <div className="agent-terminal-closed">
          <span>{closedMessage}</span>
          <button onClick={() => setEpoch((e) => e + 1)}>reconnect</button>
        </div>
      )}
      <div ref={containerRef} className="agent-terminal-screen" />
    </div>
  )
}
