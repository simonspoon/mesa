# Planning-convention agent test — 2026-06-12 16:59

Prompt: /planning add a delete command to notes.sh that removes a note by its list number. Default any open choices without asking me; do write the spec file.

Context: fixture project under ~/inaros (root CLAUDE.md in scope),
planning skill copied in, mesa project 'notes' with docs_path set.
The prompt asks for a spec file but never names a location.

- PASS — spec file written under pm-docs/specs/ unprompted (files in pm-docs/specs=1: 2026-06-12-notes-delete-command.md )
- PASS — no spec written to the old specs/ location (files in specs/=0)

Overall: PASS
