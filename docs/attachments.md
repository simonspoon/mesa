# Attachments (files/images on a task)

A task may carry **attachments** — arbitrary files (screenshots, PDFs, notes)
uploaded and attached directly to one task. Table `attachments` (migration
index 12): `task_id` (`ON DELETE CASCADE`), `filename`, `content_type`
(extension-guessed, nullable), `size_bytes`, `author`, `created_at`. Bytes
live **outside the DB and outside the tracked repo**, in mesa's own data
directory (`MESA_ATTACHMENTS_DIR` if set, else `attachments/` beside the
resolved db — mirrors `hooks.json`'s convention), one subfolder per task id,
filed as `{attachment_id}-{sanitized basename}` (`src/core/attachments.rs`;
`attachment_path` takes only `Path::file_name()` of the original name, so a
hostile `../../etc/passwd` filename can't traverse out of its folder). A
25 MiB **per-file cap** (`MAX_ATTACHMENT_BYTES`) is enforced in exactly one
place: `Store::create_attachment`. Content type is guessed from the file
extension only (no magic-byte sniffing, no new dependency) and stored as
`None` for unrecognized extensions — callers fall back to
`application/octet-stream` at response time, that fallback string is never
itself persisted.
- `Store::create_attachment` validates the task exists and the size cap,
  writes the DB row and the on-disk bytes in one transaction, and only writes
  the file after the row commits — mirrors `delete_attachment`'s
  commit-then-unlink ordering, so a disk failure never orphans a DB row.
  Deleting a task (or any of its subtasks, recursively) reads every
  descendant's attachment file paths **before** the delete commits, then
  unlinks them after — the FK cascade drops the DB rows automatically, but
  SQLite's cascade never touches the filesystem, so `delete_task` does that
  cleanup explicitly. `delete_attachment` itself is best-effort on the
  unlink (a missing file, or any other unlink error, is swallowed — the DB
  commit already succeeded and is the source of truth).
- CLI: `mesa attachment {add,list,show,fetch,delete}`. `add <TASK> <PATH>`
  (or `--task`/`--path`, plus optional `--author`) reads a local file off
  disk and stores a copy; missing task or oversized file are errors. `list`
  prints a bare array of metadata (no content bytes, matches `task list`'s
  compact-array precedent). `show`/`get` prints one attachment's metadata
  (never content). `fetch <ID> <DEST>` writes the bytes to a local path and
  prints the metadata JSON — content bytes never ride stdout, only the
  metadata does. `delete` is no-confirmation, echoes the destroyed record,
  and unlinks the file (same posture as every other delete in this repo).
- API: `POST /api/tasks/{id}/attachments` (JSON body
  `{filename, content_base64, author?}`) — **base64-in-JSON, not
  multipart/raw-body**, specifically so the mutating route stays inside the
  Content-Type CSRF gate (a multipart or raw-body carve-out on a mutating
  route would reopen the form-CSRF hole that gate exists to close). The
  request body limit is sized to `MAX_ATTACHMENT_BYTES * 4/3` (base64
  expansion) plus ~1 MiB headroom, specifically wider than axum's default
  2 MiB body limit — otherwise an at-cap upload would get a bare non-JSON 413
  before `Store`'s own JSON-error-shaped size check ever runs. Bad base64 is
  422 `validation` at the handler; an oversized decoded payload is 422
  `validation` from `Store`. `GET /api/tasks/{id}/attachments` (bare array,
  no content), `GET /api/attachments/{id}` (metadata only) and `DELETE
  /api/attachments/{id}` mirror the CLI. `GET /api/attachments/{id}/download`
  returns raw bytes (never JSON-wrapped) with the guessed/fallback
  `Content-Type` and a `Content-Disposition: attachment` header; it's a GET,
  so the Content-Type gate doesn't apply (same precedent as the Git tab's
  diff routes and the agents list route).
- Web UI: an **Attachments** section on the task panel (`TaskPanel.tsx`) —
  upload form, then a list of rows (filename, size, content-type, a download
  link, delete) with an inline `<img>` preview for any attachment whose
  `content_type` starts with `image/`. Not a separate tab — it lives inside
  the same task detail view as tags/dependencies/hooks.
- Gate: `scripts/attachments-check.sh` (CLI + API JSON contract, including
  cascade-delete-removes-the-file).
