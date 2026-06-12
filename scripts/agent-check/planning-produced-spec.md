# Add `delete` command to notes.sh

## Goal

`notes.sh delete <n>` removes the note shown at number `<n>` in `notes.sh list`
output, so users can prune notes without editing `notes.txt` by hand. After
deletion, `list` renumbers naturally (numbers are generated at display time,
not stored).

## Context

- `notes.sh` is a 7-line bash script with a single `case` dispatch on `$1`
  (notes.sh:3-7).
- `add` appends `$*` to `notes.txt` (notes.sh:4).
- `list` prints `notes.txt` through `nl -ba` (notes.sh:5). `-ba` numbers
  **every** line including blanks, so the displayed number equals the physical
  line number in `notes.txt`. Deleting line `n` from the file is therefore
  exactly "delete note `n` from the list".
- Unknown commands print a usage line and exit 2 (notes.sh:6).
- Platform is macOS (BSD userland); `sed -i` requires the `-i ''` form there.

## Requirements

1. `notes.sh delete <n>` removes line `<n>` from `notes.txt`; all other lines
   are preserved in order.
2. `<n>` must be a positive integer (`^[1-9][0-9]*$`) that is ≤ the current
   line count of `notes.txt`; otherwise print an error to stderr, exit 1, and
   leave `notes.txt` unmodified.
3. Running `delete` when `notes.txt` does not exist prints an error to stderr
   and exits 1.
4. The usage message (notes.sh:2 comment and notes.sh:6 error) mentions
   `delete <n>`.
5. `add` and `list` behavior is unchanged.

## Non-goals

- Delete by text/pattern match.
- Deleting multiple notes or ranges in one invocation.
- Confirmation prompts, undo, or backups of `notes.txt`.
- GNU/Linux `sed` portability (script targets the macOS environment it lives in).
- Any restructuring of the existing `add`/`list` code.

## Assumptions

User instructed: "Default any open choices without asking me." Defaults chosen:

- Assuming the command is named `delete` (not `rm`/`remove`) — correct me if wrong.
- Assuming invalid or out-of-range numbers are an error (exit 1), not a silent
  no-op — correct me if wrong.
- Assuming no confirmation prompt before deleting — correct me if wrong.
- Assuming BSD `sed -i ''` is acceptable since the project lives on macOS;
  portable temp-file shuffling is unnecessary complexity — correct me if wrong.
- Assuming blank lines (addable via `notes.sh add` with no text) count as
  notes, matching what `nl -ba` displays — correct me if wrong.

## Design

Add one `case` branch mirroring the existing style. Validate the argument with
a bash regex match and a line-count comparison (`wc -l < notes.txt`), then
delete in place with `sed -i '' "${n}d" notes.txt`. Because `list` numbers
lines at display time, no renumbering logic is needed. Alternative considered:
`grep -v` or temp-file rewrite — more lines for no benefit on this platform.

## Implementation

1. Add `delete)` branch to the `case` in notes.sh: validate `$2` is a positive
   integer, `notes.txt` exists, and `$2` ≤ line count; on failure print to
   stderr and exit 1.
   → verify: `./notes.sh delete abc`, `./notes.sh delete 0`, and
   `./notes.sh delete 999` each exit 1 with a message on stderr and leave
   `notes.txt` byte-identical (compare with a copy).
2. Perform the deletion with `sed -i '' "${2}d" notes.txt`.
   → verify: with notes a/b/c, `./notes.sh delete 2` leaves exactly a/c, and
   `./notes.sh list` shows them renumbered 1/2.
3. Update both usage strings (the line-2 comment and the line-6 error) to
   include `delete <n>`.
   → verify: `./notes.sh bogus` prints a usage line containing `delete <n>`
   and exits 2.

## Open questions

None — every choice was defaulted per the user's instruction (see Assumptions).

## Acceptance

- `printf 'a\nb\nc\n' > notes.txt; ./notes.sh delete 2; cat notes.txt` →
  output is exactly `a` then `c`.
- `./notes.sh delete 2 && ./notes.sh list` → shows remaining notes numbered
  contiguously from 1.
- `./notes.sh delete x; echo $?` → non-empty stderr, exit code 1, file unchanged.
- `rm -f notes.txt; ./notes.sh delete 1; echo $?` → exit code 1, no crash.
- `./notes.sh add hello && ./notes.sh list` → still works as before.

## Appendix: Q&A

No questions were asked. The user pre-emptively instructed: "Default any open
choices without asking me; do write the spec file."
