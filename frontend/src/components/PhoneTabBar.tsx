/**
 * Phone-tier bottom navigation (mesa task 556, docs/mobile.md "Planned:
 * phone-first navigation"). Four slots — Board, Inbox, Agents, More —
 * replacing the two collapsed sidebar rails, which are the only reason the
 * desktop shell still spends horizontal space on nav at 390px.
 *
 * Rendered unconditionally by `App.tsx` and hidden above 600px by CSS, not by
 * a second `matchMedia` — the same "prefer a CSS rule" pattern `.drawer-scrim`
 * uses (docs/mobile.md §2), so there is no JS breakpoint to keep in sync with
 * `App.css`.
 *
 * Agents and More do not navigate: they open the two overlay drawers, whose
 * `collapsed` state now lives in `App` precisely so this bar can drive it.
 * That is the load-bearing part — `AgentSidebar` and `TerminalPage` are
 * permanent sibling mounts owning live PTY sessions through `PtyPool`, so a
 * tab bar may only toggle their *visibility*, never render them conditionally
 * (docs/mobile.md, "The constraint that governs the implementation").
 * Switching tabs here therefore leaves every attached terminal attached.
 */
export function PhoneTabBar({
  activeProjectId,
  inboxActive,
  unread,
  navOpen,
  agentsOpen,
  onNavOpenChange,
  onAgentsOpenChange,
}: {
  activeProjectId: number | null
  inboxActive: boolean
  unread: number
  navOpen: boolean
  agentsOpen: boolean
  onNavOpenChange: (open: boolean) => void
  onAgentsOpenChange: (open: boolean) => void
}) {
  // A drawer sits over the page, so while one is open neither routed slot is
  // what the user is actually looking at.
  const drawerOpen = navOpen || agentsOpen
  const closeDrawers = () => {
    onNavOpenChange(false)
    onAgentsOpenChange(false)
  }

  return (
    <nav className="phone-tabbar" aria-label="Primary">
      {activeProjectId !== null ? (
        <a
          className={`phone-tab${!drawerOpen && !inboxActive ? ' active' : ''}`}
          href={`#/projects/${activeProjectId}`}
          // Fires even when the hash is unchanged (already on that project),
          // which `Sidebar`'s hashchange self-close would miss — and the
          // agents drawer never self-closes on navigation at all.
          onClick={closeDrawers}
        >
          Board
        </a>
      ) : (
        // No active project: the project list lives in the left drawer, and
        // there is no `#/projects` index route to send them to instead.
        <button
          type="button"
          className="phone-tab"
          onClick={() => {
            onAgentsOpenChange(false)
            onNavOpenChange(true)
          }}
        >
          Projects
        </button>
      )}
      <a
        className={`phone-tab${!drawerOpen && inboxActive ? ' active' : ''}`}
        href="#/inbox"
        onClick={closeDrawers}
      >
        Inbox
        {unread > 0 && <span className="inbox-badge">{unread}</span>}
      </a>
      <button
        type="button"
        className={`phone-tab${agentsOpen ? ' active' : ''}`}
        aria-expanded={agentsOpen}
        onClick={() => {
          onNavOpenChange(false)
          onAgentsOpenChange(!agentsOpen)
        }}
      >
        Agents
      </button>
      <button
        type="button"
        className={`phone-tab${navOpen ? ' active' : ''}`}
        aria-expanded={navOpen}
        onClick={() => {
          onAgentsOpenChange(false)
          onNavOpenChange(!navOpen)
        }}
      >
        More
      </button>
    </nav>
  )
}
