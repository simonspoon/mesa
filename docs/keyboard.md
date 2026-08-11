# Keyboard shortcuts

Global keyboard control of the web UI: a create-task shortcut on any project
view, and an app-wide spatial focus layer driven by `h/j/k/l` and the arrow
keys. Frontend-only — no CLI, API, or Rust surface.

## Bindings

| Key | Scope | Effect |
|---|---|---|
| `a` | any project view | Opens the create-task modal **in place**, over the view you are on (task 811) |
| `h` `j` `k` `l` | global | Move native DOM focus left / down / up / right |
| `←` `↓` `↑` `→` | global | Same as `hjkl` |
| `Enter` | global | Activates the focused element (native browser behavior) |
| `Cmd/Ctrl+Shift+P` | global | Command palette — **pre-existing**, untouched |
| `Cmd/Ctrl+F` | Files tab, focused pane, findable file | Opens find-in-file, selecting the remembered query (task 809) |
| `Cmd/Ctrl+S` | Files tab editor | Saves the file, staying in the editor (and swallows Save Page) |
| `Alt+W` | Files tab | Closes the focused pane's active tab |
| `Alt+[` `Alt+]` | Files tab | Previous / next tab in the focused pane |

`Enter` is deliberately *not* special-cased. Focus lands on real interactive
elements, so the browser's own activation does the right thing: a link
navigates, a button clicks, an `InlineEdit` label opens its editor. "Does
nothing on a non-actionable element" falls out for free — non-interactive
elements are never focusable, so they never receive focus to begin with.

`a` was Board-only until task 811, and gaining the other views changed *how* it
opens, not just *where*: it now sets `ProjectTasksPage`'s own `creating` state
instead of navigating to `#/projects/:id/create-task`. That route renders the
**Board** underneath the form, which is the right landing place for the command
palette's "Create task in &lt;project&gt;" entry (its only remaining caller) and
exactly the wrong one for this shortcut — a task written while reading a file,
a diff or a storyboard would have thrown away the thing it was about. The
in-place modal leaves the view untouched, and is draggable and lightly dimmed
for the same reason (`modalDrag.ts`, `CreateTaskModal.tsx`).

The listener is bound app-wide with no view check, because
`shouldIgnoreShortcut` already answers the question every non-Board view would
have asked: the Files editor and the new-file row are text controls (rule 2),
the Terminal tab's panes are xterm (rule 3), a storyboard canvas suppresses
everything (rule 4). Do not re-add a per-view gate on top of it — that is the
divergent second suppression check the chokepoint exists to prevent.

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
   `.create-task-backdrop` is the **shared** backdrop class, not one modal's:
   create-task, create-project and task detail (`TaskModal.tsx`) all mount it,
   so all three suppress the global shortcuts while open. A new modal that
   reuses it inherits that for free; one that invents its own backdrop class
   must be added to rule 5 here and in `keyboardScope.ts`.

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

## The chord sibling (`shouldIgnoreFilesShortcut`, task 809)

`shouldIgnoreShortcut`'s **first** rule is "a modifier chord belongs to its
existing owner", so it answers `true` for every chord by construction — a chord
shortcut cannot consult it, and must not be the reason someone weakens it. The
Files tab's chords therefore call a *sibling* export in the same file,
**`shouldIgnoreFilesShortcut(e, chord)`**, so there is still exactly one module
deciding which surface may claim a keystroke.

One predicate for all four chords, not one each: they ask nearly the same
question. It returns `true` (stand down) when a modal that owns its own keys is
open (`.create-task-backdrop`, `.command-palette-backdrop` — rule 5 above, same
classes) or when the caret is in a text control that is not the tab's own; the
two that *do* claim these chords are `.files-content-editor` and
`.files-find-input`. The `chord` argument (`'find'` | `'tabs'`, required, never
defaulted) is the one place the four part company, and only on that second
control: Cmd/Ctrl+F acts *in* the find bar's query box, while Alt+W and
Alt+[ / ] act by tearing it down — the pane's active path changes,
`ContentPane` remounts, and the input is unmounted while it holds focus, which
drops focus on `<body>` (Tab restarts at the top of the page, Escape answers
nothing). `closeFind` hands the caret on for exactly that reason and the tab
chords have nothing to hand it to, the pane that would take it not existing yet,
so they stand down there instead. Everything else about scoping is the caller's:
the
listeners live in `FilesView`/`ContentPane`, so they exist only while the tab
is mounted, and Cmd/Ctrl+F additionally requires that pane to be the focused
one — in a split, both are mounted and two find bars racing for one keystroke
is the bug scoping avoids.

**`preventDefault` fires only after a binding has decided to act**, which is
what keeps the browser's own Cmd+F everywhere else and leaves an Alt chord this
tab does nothing with (a one-tab pane's `Alt+]`) alone. The tab chords match on
**`e.code`**, not `e.key`: Alt+W on macOS *is* the character `∑`.

**Which is also the price, and it is paid in the editor.** On macOS Option+W,
Option+`[` and Option+`]` are `∑`, `“` and `‘`, and the predicate deliberately
lets these chords through in `.files-content-editor` — closing or cycling the
file you are *editing* is the case they exist for. So with the caret in the code
and something for the chord to do, those three characters do not type; with one
tab open `Alt+[`/`Alt+]` stand down (nothing to cycle to) and `“`/`‘` type
normally, so the behaviour depends on how many tabs are open. That is the trade
rather than an oversight: Alt is the only chord space this page owns (Cmd/Ctrl+W
and Ctrl+Tab are the browser's, below), and losing a curly quote in a code
editor is the smaller loss. Elsewhere in the app — and in any other text control,
where the predicate stands down — all three still type.

**Cmd/Ctrl+W is deliberately not bound.** Chrome and Safari deliver it to the
browser, not the document, so binding it would ship a shortcut that works
nowhere and loses the window; Ctrl+Tab and Cmd/Ctrl+Shift+`[`/`]` are skipped
for the same reason, which is why the bindings are Alt-based.

Inside the editor itself, Tab/Shift+Tab/Enter/brackets are *editing* keys
rather than shortcuts and never reach either predicate — `CodeEditor` returns
before consulting `editorInput.ts` the moment any of `meta`/`ctrl`/`alt` is
held, and before anything at all while an IME composition is in flight
(`isComposing`, the keydown that commits a candidate). Escape is claimed by both
the find bar and the editor and is resolved by
precedence, not by focus: with the bar up Escape closes the bar, and only once
it is gone does it discard the edit. In **view** mode there is no editor to
route it, so the pane binds Escape at the document level while the bar is up —
otherwise clicking one of the bar's own buttons left the key answered by
nothing. The close-confirm bar (task 809, the tab's one modal-ish prompt) binds
Escape on itself for the same reason it autofocuses "keep editing": both keys a
user reaches for to dismiss a prompt have to resolve it, and both resolve it the
safe way. It stops the event rather than letting it bubble, since the editor
underneath answers Escape by discarding the very draft the bar is protecting.

**Escape also arms the next Tab as a plain focus move**, in either mode and in
every mount of this editor (`tabEscapeAfter`). Taking Tab away from the browser
takes the last keyboard route out of an indented line with it — Shift+Tab falls
through only once there is nothing left to dedent — which is a WCAG 2.1.2 trap,
and worst on the Scripts page, where the same component is one field of a form
and nothing binds Escape at all. Any other typed key disarms it, so a user who
presses Escape and keeps typing never sees it.

**Cmd/Ctrl+Shift+F is not this tab's.** The find binding excludes Shift: that
chord is "find in files" everywhere it is bound and a browser/extension chord on
some setups, and swallowing it to open the in-file bar would be claiming a key
this tab was never offered.

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

`shouldIgnoreShortcut` itself has unit tests (`npm --prefix frontend run
test`, `frontend/src/keyboardScope.test.ts`) covering each of its five checks
against a jsdom tree. They cover the **decision** and nothing below it: the
test dispatches a synthetic bubbling `keydown` from a chosen element, so it
pins what the predicate answers for a given `e.target` — never that a real
browser would have delivered the keystroke to that target in the first place.
Focus routing, `isTrusted`, and whether a handler is mounted at all are still
only answerable live.

So: drive real keys with `khora key` (CDP `Input.dispatchKeyEvent`) —
synthetic `KeyboardEvent` dispatch is not trusted and won't exercise these
handlers.
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
