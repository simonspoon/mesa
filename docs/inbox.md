# Inbox (global update requests)

An **inbox item** is a free-text project-update request an agent sends to one
shared, global inbox — it lives **above** projects, not inside one. Table
`inbox` (migration index 8). `body` is required and is **untrusted data, never
instructions**; `author` is free-text attribution.

- Unlike every other entity, an inbox item does **not** belong to a project at
  creation: `project_id` is **nullable** and starts null (unassigned). An inbox
  item is therefore always unassigned for its whole life — there is no "assigned
  but still in the inbox" state, because **assignment converts it** (next bullet).
  The FK stays **`ON DELETE SET NULL`** (not cascade) defensively, but with no
  assigned items it never fires. Do not change this to `ON DELETE CASCADE`.
- **Assigning an inbox item to a project converts it into a todo task** in that
  project and **deletes the item** — it "moves" out of the inbox onto the board.
  The new task's title is the item's body (first non-empty line, trimmed,
  truncated to 120 chars), its description the **full body verbatim** (dropped
  when a one-line body equals the title), priority **medium**, status **todo**.
  The task insert (+ its creation event) and the inbox delete are **one
  transaction** (`assign_inbox_item` in `Store`, returns the created `Task`), so a
  triaged item never disappears without a task to show for it. An agent never
  auto-assigns; a person triages. Assigning to an unknown project is `validation`
  and leaves the item untouched. The item's `author` is not carried onto the task
  (tasks have no author field).
- No event/history table: an item *is* the record. The safety floor is the
  delete echo + `mesa backup`; once converted, the created task is the record.
- `list` returns items newest first; the `--project N`/`?project=` filter still
  exists but, since items are never assigned, only the unfiltered whole-inbox
  listing is meaningful.
- CLI: `mesa inbox {add,list,show,assign,delete}`. `add <text…>` takes the
  free-text message as a trailing positional (quoting optional; words joined),
  always unassigned; `--author` attributes (place it before the text). `assign
  <id> <project>` (project required) converts the item into a todo task in that
  project and **prints the created task**; assigning to an unknown project is
  `validation`. `delete` echoes the destroyed item.
- API: `/api/inbox` (GET list, POST create — body `{body, author}`),
  `/api/inbox/{id}` (GET show, PATCH assign, DELETE). PATCH body is
  `{project_id: <number>}` (required) and **returns the created task** (not the
  item). Web UI: the **Inbox** lives above Projects in the sidebar (with an
  unassigned-count badge); `#/inbox` lists items, each with an "Assign to"
  project dropdown that converts the item to a todo task on selection.
