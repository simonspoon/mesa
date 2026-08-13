import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { usePhoneTier } from '../phoneTier'

// xterm's font size is a JS option, not a stylesheet property — but the
// *breakpoint* that chooses it still lives in CSS alone (`--pty-font-size`,
// `App.css`), per `docs/mobile.md`'s rule. This reads the resolved value
// rather than branching on `isPhone()` here, so there is no second copy of
// `600px` to keep in step.
//
// Measured at 390x844 (mesa task 560): 13px gives a 7.02px cell, i.e. 48
// columns of a 337px screen; 11px gives 56. The pane is the whole phone, so
// the columns are worth more than the extra 2px of glyph.
function ptyFontSize(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--pty-font-size')
  const n = Number.parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : 13
}

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
  registerSend,
}: {
  // Path (no origin) to the websocket endpoint to attach to, e.g.
  // `/api/agents/${agentId}/attach` or `/api/terminal/attach`.
  endpoint: string
  // Shown in the "connection closed" banner — callers know what "closed"
  // means for their own backing process (session detach vs. shell exit).
  closedMessage: ReactNode
  // Hands the caller a writer into this socket for as long as it is open, and
  // `null` when it goes (mesa task 844: the chat view's composer types into
  // the terminal its pane is already attached to, since a transcript render
  // has no channel of its own). Optional — a surface with nothing but the
  // terminal itself typing into the PTY simply omits it.
  registerSend?: (send: ((data: string) => boolean) | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Held only so the tier effect below can retune an already-open terminal;
  // everything else about the terminal stays inside the connect effect.
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [closed, setClosed] = useState(false)
  // Bumped by the reconnect button to force the effect to re-run and open a
  // fresh socket without unmounting (the parent's key is its own pane
  // identity, which does not change on reconnect).
  const [epoch, setEpoch] = useState(0)
  // Read inside the connect effect without being one of its dependencies: the
  // prop is a fresh closure on every parent render, and re-running the effect
  // would tear down and reopen the socket each time.
  const registerRef = useRef(registerSend)
  useEffect(() => {
    registerRef.current = registerSend
  })

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
      // Share Tech Mono stays primary, so ordinary text looks unchanged; the
      // second family is an icons-only Nerd Font (bundled, see main.tsx) that
      // only ever supplies the Private Use Area codepoints a prompt emits
      // (starship/p10k segments, git/branch icons) and Share Tech Mono lacks.
      fontFamily: '"Share Tech Mono", "Pure Nerd Font", Menlo, monospace',
      fontSize: ptyFontSize(),
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
    // `endpoint` may already carry a query of its own (the project Terminal
    // tab's `?project=<id>`), so the size params append with the right
    // separator rather than a hardcoded `?`.
    const sep = endpoint.includes('?') ? '&' : '?'
    const ws = new WebSocket(
      `${proto}://${window.location.host}${endpoint}${sep}cols=${term.cols}&rows=${term.rows}`,
    )
    ws.binaryType = 'arraybuffer'
    const encoder = new TextEncoder()
    ws.onmessage = (ev) => term.write(new Uint8Array(ev.data as ArrayBuffer))
    ws.onopen = () => {
      // Resizes fit()'d during the CONNECTING window were dropped (the guard
      // below only sends when OPEN); push the current size once so the PTY
      // matches the actual viewport rather than the initial query-param size.
      ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }))
      // Handed out only once the socket is open, and withdrawn again below the
      // moment it closes: an outside writer (the chat composer) has no
      // keyboard in front of it to notice a dropped message, so "there is no
      // writer" has to be the honest answer whenever a write wouldn't land.
      registerRef.current?.((d) => {
        if (ws.readyState !== WebSocket.OPEN) return false
        ws.send(encoder.encode(d))
        return true
      })
    }
    ws.onclose = () => {
      // Both inside the `disposed` guard, and the writer for the same reason
      // the banner is: a socket torn down by this effect's own cleanup closes
      // *asynchronously*, by which time the reconnect (or StrictMode's second
      // mount) has already opened a new one and registered its writer —
      // clearing here would strand the composer against a live terminal. The
      // cleanup path has already withdrawn the writer itself.
      if (disposed) return
      registerRef.current?.(null)
      setClosed(true)
    }

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
    termRef.current = term
    fitRef.current = fit

    return () => {
      disposed = true
      registerRef.current?.(null)
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      ws.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [endpoint, epoch])

  // Retunes an already-open terminal when the phone tier engages or lifts.
  // The explicit `fit()` is not belt-and-braces: changing the font changes
  // the CELL size, not the box, so the `ResizeObserver` above never fires and
  // the terminal would keep its old `cols`/`rows` at the new glyph size —
  // verified by watching `cols` fail to move without it. Skipped on the first
  // run, where the connect effect already constructed at the right size and a
  // second fit would be one gratuitous `{"resize":…}` frame.
  const phone = usePhoneTier()
  const firstTier = useRef(true)
  useEffect(() => {
    if (firstTier.current) {
      firstTier.current = false
      return
    }
    const term = termRef.current
    if (!term) return
    const size = ptyFontSize()
    if (term.options.fontSize === size) return
    term.options.fontSize = size
    fitRef.current?.fit()
  }, [phone])

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
