# Keyboard shortcuts

Global keyboard control of the web UI: a create-task shortcut on the Board,
and an app-wide spatial focus layer driven by `h/j/k/l` and the arrow keys.
Frontend-only — no CLI, API, or Rust surface.

## Bindings

| Key | Scope | Effect |
|---|---|---|
| `a` | project **Board** view only | Opens the create-task form (navigates to `#/projects/:id/create-task`) |
| `h` `j` `k` `l` | global | Move native DOM focus left / down / up / right |
| `←` `↓` `↑` `→` | global | Same as `hjkl` |
| `Enter` | global | Activates the focused element (native browser behavior) |
| `Cmd/Ctrl+Shift+P` | global | Command palette — **pre-existing**, untouched |

`Enter` is deliberately *not* special-cased. Focus lands on real interactive
elements, so the browser's own activation does the right thing: a link
navigates, a button clicks, an `InlineEdit` label opens its editor. "Does
nothing on a non-actionable element" falls out for free — non-interactive
elements are never focusable, so they never receive focus to begin with.

## The suppression chokepoint

**`shouldIgnoreShortcut(e: KeyboardEvent): boolean`** in
`frontend/src/keyboardScope.ts` is the single gate for every global
single-key shortcut. Both the `a` shortcut and the spatial nav consume it.

**Any new global single-key shortcut MUST call it.** Do not hand-roll a
second suppression check, and do not fork this module — a divergent copy is
how one surface starts eating another's keys.

Returns `true` (suppress) for, in order:

1. A modifier chord is held (`metaKey`/`ctrlKey`/`altKey`) — those belong to
   their existing owners, e.g. the command palette.
2. `e.target.closest(...)` matches a text input, `textarea`,
   `contenteditable`, or a native `select` — typing and native select
   option-cycling/type-ahead win.
3. `e.target.closest('.xterm, .agent-terminal')` — xterm panes read real
   `keydown` events.
4. A storyboard canvas is mounted anywhere on the page (`.storyboard`) — it
   owns its own key handling and is its own spatial surface.
5. A modal that owns its own key handling is open
   (`.create-task-backdrop`, `.command-palette-backdrop`).

Rules 4 and 5 are **document-wide** queries, not `closest()` — nothing inside
those surfaces is focusable, so the keydown target never lands inside them.

> **Consequence — do not leave a modal's DOM mounted after it closes.**
> Because rule 5 is document-wide, a lingering `.create-task-backdrop`
> silently kills *every* global shortcut until a full page reload. This
> actually happened: `ProjectTasksPage`'s create-panel sync was one-way
> (`if (createTask) setCreating(true)`), so browser Back off the
> `create-task` route left the panel mounted on a board route. Fixed by
> making the sync two-way. If shortcuts ever go dead app-wide, check for a
> stale backdrop first.

## Focus candidates

Native focusability **is** the whole candidate contract — any element already
in the tab order. No registry, no per-component opt-in. `tabindex="-1"` opts
an element out.

Two consequences worth knowing:

- **Kanban cards.** dnd-kit injects `role="button"`/`tabIndex={0}` onto the
  card `<li>` to serve a `KeyboardSensor` this board never configures. That
  made the `<li>` a dead second tab stop ahead of the real target. It is
  forced back to `tabIndex={-1}`, so the tab stop — and the spatial-nav
  candidate — is the nested `<a href="#/projects/:id/tasks/:id">`, which
  already opens the task on Enter natively.
- **`InlineEdit`** was a bare `<span onClick>` — not keyboard-reachable at
  all. It now carries `role="button"`, `tabIndex={0}`, and an Enter handler.

Candidates must also pass a **visibility** test: a non-zero rect *plus* a
computed `visibility` check. mesa keeps live-resource panes mounted-but-hidden
via `visibility: hidden` rather than unmounting them (the inactive
main/Terminal pane, the collapsed AgentSidebar body) so their WebSockets
survive navigation. Those still report a positive-area rect, and `focus()` on
them silently no-ops — without the visibility check, navigation dead-ends in
that direction.

## Geometry

`frontend/src/spatialNav.ts` picks the nearest candidate by on-screen
bounding box, **not DOM/tab order**:

- Direction filter uses **edge** comparison, not centers — so an element
  can't count as "to the right" while still overlapping the origin on the
  primary axis.
- Score prefers a small gap along the pressed axis, and prefers candidates
  that overlap the origin on the perpendicular axis (two cards in the same
  row overlap vertically for a left/right move).
- **No wrap-around.** Nothing in that direction → focus stays put.
- Cold start (nothing focused yet) has no origin, so the first press picks a
  sensible entry point rather than no-oping.

Matching is on lowercase `e.key`. `e.key`'s case follows Shift, so a shifted
letter is not this feature's concern; arrow-key names don't change with Shift.

## Listeners

Two independent `window` `keydown` listeners with disjoint key sets, mounted
side by side in `App.tsx`: the pre-existing `useCommandPaletteShortcut`
(Cmd/Ctrl+Shift+P) and `useSpatialNav()`. The `a` shortcut is a third,
mounted inside `ProjectTasksPage` and gated on the Board view, so it is inert
by construction on Storyboards/Git/Files/Dashboard — no route-string
comparison involved.

## Verifying changes here

Drive real keys with `khora key` (CDP `Input.dispatchKeyEvent`) — synthetic
`KeyboardEvent` dispatch is not trusted and won't exercise these handlers.
`khora key` sends no character, so it cannot test text entry; use
`khora type-keys <session> <selector> <text>` for that.

Verify **each suppression context on its own**. Proving letter-key
suppression does not prove arrow-key suppression: `select` and xterm bind
arrows specifically, letters only incidentally.

Run against a throwaway db and port, never the dev box's live server:

```bash
npm --prefix frontend run build          # debug build reads frontend/dist from disk
MESA_DB=/tmp/kb.db cargo run -- serve --port 7795
```
