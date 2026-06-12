# Agent smoke test — 2026-06-11 22:23

Prompt: create a project with 3 tasks, make task 3 blocked by task 1, then try to make task 1 blocked by task 3, then list unblocked tasks

Context given: skills/mesa/SKILL.md only (appended to the system prompt).
Transcript: transcript.jsonl (raw stream-json), transcript.txt (readable).

- PASS — create a project with 3 tasks (projects=1 tasks=3)
- PASS — make task 3 blocked by task 1 (edges=[3<-1] task3.blocked=true task1.blocked=false)
- PASS — try task1 blocked-by task3: rejected with code=cycle (cycle errors seen=1)
- PASS — recovers from the cycle rejection within one corrected retry (cycle errors seen=1 (1 attempt + at most 1 retry))
- PASS — list unblocked tasks (commands using --unblocked=1)
- PASS — completes without consulting --help (help invocations=0)

Overall: PASS
