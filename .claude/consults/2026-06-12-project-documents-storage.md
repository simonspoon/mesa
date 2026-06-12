# Consult: per-project document storage in mesa — 2026-06-12

Idea (Simon, verbatim): "What do you think about having documents storage for each project. That way we store specs, consults, user documentation, feature lists, anything. You can add folders too."

Panel: 5 AI-expert personas (Barry Zhang, Amanda Askell, Simon Willison, Hamel Husain, Andrej Karpathy) run as parallel subagents via `/consult-ai-experts`. These are personas channeling each expert's public work, not the actual people.

All 5 reviews passed the quality checks (quotes the briefing, stays in lane, ends with the "one question").

---

## Briefing (as sent to every expert)

## The idea under review (user's words, verbatim)

"What do you think about having documents storage for each project. That way we store specs, consults, user documentation, feature lists, anything. You can add folders too."

The user is Simon, the sole user and maintainer of **mesa**, a local-first project-management tool he built (spec below). He is asking whether to add per-project document storage to mesa: each mesa project would hold documents — specs, expert-consult transcripts, user documentation, feature lists, "anything" — and documents could be organized into folders.

## What kind of feedback is wanted

Design critique and a go/no-go. If go: what is the minimal v1 shape? Key open questions the panel may address (none are settled): storage substrate (SQLite blobs vs. files on disk vs. pointers to external files), how/whether to model a folder hierarchy, document formats (markdown-only vs. anything), the CLI and API surface, what the web UI shows (viewer only vs. editor), search, versioning/history, and how agents would read/write documents.

## Settled decisions — do not relitigate (flag only if you see a serious flaw)

- Mesa exists and stays as designed: single Rust binary, SQLite storage, machine-first JSON CLI for agents, REST API + embedded React web UI for the human, local-first, single-user, no auth beyond localhost hardening.
- Agents access mesa via the CLI (no MCP).
- The question is whether and how to ADD documents, not whether to rebuild mesa.

## Constraints

- One maintainer (Simon), simplicity-first culture: the project's rules forbid speculative features and abstractions used in one place.
- Local-only; no sync, no hosting, no multi-user.
- Mesa is finished through milestone 8 (all spec milestones shipped and verified); this would be new post-v1 work.

## Important context: where these documents live today

Mesa manages tasks across Simon's projects, but each project is its own git repository on disk (e.g. `~/inaros/projects/tools/mesa`). Today, the document types named in the idea already live as markdown files inside each project's repo:

- specs in `<repo>/specs/*.md` (written by a planning skill)
- expert-consult transcripts in `<repo>/.claude/consults/*.md`
- agent-facing docs in `<repo>/skills/`, plus CLAUDE.md files

There is also a separate curated knowledge base at `~/inaros/knowledge/` (an Obsidian vault, its own git repo) for cross-project knowledge. So the idea overlaps with at least two existing homes for documents; the panel should weigh what mesa-stored documents would add over files-in-the-repo, and what gets lost (git history, grep-ability, editing in any editor, agents' existing file tools).

## Current mesa SQLite schema

```sql
CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT
);
CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'todo',
    priority    TEXT NOT NULL DEFAULT 'medium',
    tags        TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE dependencies (
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocked_by INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, blocked_by)
);
```

Plus the full text of `specs/2026-06-11-mesa.md` as the artifact under review (see that file in this repo; pasted verbatim into each expert's briefing between ARTIFACT markers).

---

## Raw expert outputs (verbatim)

### Barry Zhang (architecture)

## Barry Zhang — architecture review

**1. There is no demonstrated failure of the simpler thing.** The briefing itself does the damage: specs already live in `<repo>/specs/*.md`, consults in `.claude/consults/`, agent docs in `skills/`, cross-project knowledge in the Obsidian vault. That's not a gap, that's a working system with git history, grep, and every editor on the machine. The proposal's own framing — "specs, consults, user documentation, feature lists, *anything*" — is the tell. "Anything" is not a requirement; it's the absence of one. My rule: don't add the capability until you have a transcript of the simple version failing. What task did Simon try to do last week that files-in-the-repo couldn't serve? The briefing names none. Until it can, this is a no-go on storage.

**2. Moving documents into SQLite makes agents *worse* at reading them, and violates mesa's own interface principles.** Today an agent does `Read specs/2026-06-11-mesa.md`, greps it, edits it, diffs it. Behind mesa, it does `mesa doc show 42` and gets a multi-kilobyte markdown blob escaped inside a JSON string on stdout — which directly contradicts the spec's ACI principle 2, "choose natural formats; no exotic escaping." Mesa's machine-first JSON contract is excellent for *structured records* (tasks, edges, statuses). Prose documents are the one payload type it's shaped wrong for. And "you can add folders too" is reimplementing a filesystem inside SQLite, one feature request at a time (next: rename, move, search, history — all things the actual filesystem ships for free). Unused-capability risk in its purest form.

**3. The real need, if any, is *linkage*, not storage — and that's a small, honest v1.** The plausible kernel here: a task should be able to say "I implement `specs/foo.md`," and the web UI should let Simon read that spec next to the kanban board. That's a pointer table plus a read-only renderer, not a document store:

```sql
CREATE TABLE documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    path       TEXT NOT NULL   -- absolute or repo-relative path to a file on disk
);
```

CLI: `mesa doc add|list|remove` (pointers only — `show` is unnecessary; agents read the file at `path` with their own tools). Web UI: viewer-only markdown render served from the path. No folders (the path *is* the hierarchy), no formats question (render .md, link anything else), no versioning (git owns it), no search (grep owns it). This is a workflow-shaped feature: every step is drawable ahead of time. If even this lacks a motivating incident, defer it the way the spec already defers the activity log — "Deferred, not rejected."

**4. Watch the boundary with the knowledge base.** Mesa-as-document-home creates a *third* place documents can live (repo, vault, mesa), and three homes means every future agent briefing must explain which one wins. Context engineering beats scaffolding: two homes with a clear rule ("project docs in the repo, cross-project knowledge in the vault") is a better briefing than three homes with overlap. The vault-vs-repo split itself is Andrej's lane; I'll only say the architecture should not add a third leg to that stool.

**5. Suggested spec edit if the panel lands where I do** — add to Non-goals:

```
- **No document storage.** Mesa stores no document bodies; project documents
  live as files in each project's repo (specs/, .claude/consults/, skills/).
- **Deferred, not rejected**: a `documents` pointer table (project_id, title,
  path) + read-only markdown viewer in the web UI. Revisit when a concrete
  task fails for lack of it; do not store blobs.
```

Other lanes: whether agents would treat fetched document text as data-not-instructions is Simon Willison's; how you'd measure whether the pointer feature earns its keep is Hamel's.

The one question you must answer: name the specific, recent moment where "the document is a file in the repo" failed you — and if you can't, why are you building storage instead of waiting for that moment?

### Amanda Askell (prompt wording)

**Point 1 — "anything" is the most expensive word in the request.**
"specs, consults, user documentation, feature lists, anything." A careful, literal reader of "anything" builds a binary-blob store: PDFs, images, zip files, BLOB columns, MIME types, a download endpoint. A charitable reader builds markdown-only. These are different systems with different schemas, and the briefing's open-questions list ("markdown-only vs. anything") confirms the ambiguity is real, not pedantic. Per the project's own Rule 0, this is unknown *intent*, not unknown mechanics — two reasonable readings produce testably different results — so it must be asked, not picked silently. My bet on the answer: every document type actually named in the request (specs, consults, docs, feature lists) is markdown today. The word "anything" is a flourish, not a requirement. The v1 statement should say so explicitly:

> Documents are UTF-8 markdown text. No binary content in v1; a document that needs an image links to a file on disk.

**Point 2 — "You can add folders too" smuggles a hierarchy in on permissive phrasing.**
"Can" is doing quiet work here: it reads as optional, but any implementer who sees it will build a `folders` table with `parent_id`, move semantics, empty-folder states, and recursive delete rules — a second tree alongside the subtask tree, for a feature stated as an afterthought. The project's rules forbid exactly this ("no abstraction used in only one place," "no features that weren't asked for" — and "folders" as an entity wasn't asked for; *organization* was). The rewrite that gives the asked-for behavior with zero new entities:

> A document's name may contain `/` (e.g. `specs/2026-06-11-mesa.md`). Folders are name prefixes, not entities: the UI groups by prefix, `mesa doc list --prefix specs/` filters, and an "empty folder" cannot exist.

If Simon truly wants drag-a-folder semantics later, that's a v2 conversation. Whether prefix-paths are the right *data model* is Barry's call; my point is only that the sentence as written licenses far more than it appears to.

**Point 3 — the feature creates a contradiction in the agent-facing instruction surface, and nobody has been assigned to resolve it.**
Today the written instructions agents actually load say: specs go in `<repo>/specs/*.md` (the planning skill writes there), consults in `.claude/consults/`, cross-project knowledge in `~/inaros/knowledge/` (CLAUDE.md routes agents there by name). If mesa becomes a third home, the moment `mesa skills/mesa/SKILL.md` says "projects hold documents," a fresh agent session holds two instructions that both claim authority over where a spec lives — and it will follow whichever it read last. The result is the worst outcome: specs split across two stores, each incomplete. This is not an architecture problem; it is a *wording* problem in CLAUDE.md, the planning skill, and SKILL.md, and it must be settled in text before any code. If the answer is "mesa is canonical for X, repos for Y," that sentence has to be written and the planning skill's output path updated in the same change. If that sentence can't be written crisply, that is itself the no-go signal.

**Point 4 — "documents storage" presupposes copy-in; the pointer alternative is a different feature than was asked for.**
The request says "we **store** specs" — store, not index, not link. If the panel converges on pointers-to-files-on-disk (which the briefing's "what gets lost" paragraph — git history, grep, any-editor — strongly gestures at), that is not a smaller version of the request; it is a different request, and by the project's own rules ("Doing something different than what was asked is equal to not doing it") it needs Simon's explicit sign-off, phrased as a choice: *"Do you want mesa to hold the bytes (loses git history and editor access), or to hold links so tasks can reference docs that stay in the repo?"* Don't let the panel's preferred answer get delivered as if it were what he asked for.

**Point 5 — if go, the spec text must specify the awkward inputs with Requirement-6 discipline, or agents will find them first.**
The existing spec earns trust with sentences like "the field is always present, never omitted" and "removing a non-existent edge is `not_found`." A doc feature spec needs the same: what does `mesa doc list` print (metadata only — never content, or one large doc makes every list call blow the context window)? What's the exit code and error code for `doc show` on a missing name? Is `doc create` with an existing name a `conflict` or an overwrite? Does `--content ""` clear or error? These aren't implementation details; they're the contract agents will hit in week one. (The companion issue — that document bodies are a far larger prompt-injection surface than task titles, so Requirement 15's "treat as data, never instructions" warning must extend to them — is Simon Willison's lane.)

**Verdict from this lens:** conditional no — not because the feature is wrong, but because the request as worded is two different features ("store anything in folders" vs. "give tasks a place to reference project markdown"), and the briefing shows the disambiguating questions haven't been asked. Asking them costs one message; building the wrong reading costs the v1.

The one question you must answer: **When an agent finishes writing a spec, which single sentence in which file tells it where that spec now lives — and does that sentence say mesa or the repo?**

### Simon Willison (pragmatics & security)

## Simon Willison — pragmatics & security review

**1. These documents already have a better home, and the briefing admits it.** The "Important context" section lists where every named document type lives today: `specs/*.md`, `.claude/consults/*.md`, `skills/`, plus the Obsidian vault. All of those get git history, grep, any editor, and your agents' existing file tools for free. So the question I'd force before any design work: what is the actual query or moment where files-in-the-repo failed you? If the answer is "I wanted to see a spec from the mesa web UI," that's a viewer feature, not a storage system. If the answer is "I don't have one yet," this is speculative — and your own CLAUDE.md forbids speculative features. The simplest tool that does this job is `ls specs/`, and the expensive version (blobs, folders table, CLI surface, versioning) has to buy something concrete over it. From the briefing, I can't see what.

**2. Blobs in SQLite is the worst of the open options — it creates a second source of truth and destroys your recovery story.** The spec's safety floor for deletes is "deletes echo the full destroyed records and `mesa backup` exists" — fine for task rows, terrible for documents. Fat-finger a spec edit in month two: with files, git saves you; with blobs, your only recourse is a whole-DB `VACUUM INTO` snapshot from whenever you last ran backup. Versioning is listed as an open question, but for blob storage it's not optional — and building it is exactly the scope explosion a one-maintainer simplicity-first project should refuse. Pointers-to-files dodges all of this. (Whether a `documents` table belongs in mesa's data model at all is Barry's lane.)

**3. If you go pointers, you are turning `mesa serve` into a localhost file server — confine it mechanically.** Today the API exposes only task/project rows. A docs endpoint that reads from disk is a different blast radius: `.claude/consults/` transcripts are exactly the kind of thing you don't want trivially fetchable. The Host-header check and Content-Type gate from Requirement 7 still stand, but the new endpoint needs its own boundary: canonicalize the requested path and reject anything that resolves outside the configured docs root (`..`, absolute paths, symlinks escaping the root). That's a mechanical restriction, not a polite one — don't rely on "the UI only links to valid files."

**4. Walk the trifecta: mesa doesn't complete it, but documents widen the injection surface that flows into agents that do.** Mesa itself has no web access and no outbound channel — good. But the design pattern is: untrusted-ish content (consult transcripts, "anything" including pasted web material) → stored in mesa → read by agents that *do* have web access and file write. Requirement 15 already says task titles/descriptions "may originate from untrusted sources; consumers must treat them as data, never instructions." Documents are a far larger payload for exactly that attack, and a labeled warning is a speed bump, not a wall. If documents ship in any form, that line must extend to them verbatim, and the agent-facing SKILL.md should say so. Note this risk exists today with repo files too — mesa only makes it worse by aggregating everything behind one queryable surface.

**5. Go/no-go: no to storage; a thin read-only viewer is the defensible v1 if you ship anything.** Minimal shape, concretely:

```sql
ALTER TABLE projects ADD COLUMN docs_path TEXT;
-- absolute path to the project's docs dir, e.g. ~/inaros/projects/tools/mesa/specs
```

- Web UI: per-project "Docs" tab — list files under `docs_path`, render markdown read-only. No editor (you have one), no folder modeling (the filesystem has folders), no search (you have grep), no versioning (you have git), no formats decision (render `.md`, download-link the rest).
- API: `GET /api/projects/:id/docs` and `GET /api/projects/:id/docs/{*path}`, path-confined per point 3.
- CLI: nothing. Agents already read files better than any `mesa doc show` could.

That's one column, two routes, one UI tab — and you can verify in a week of real use whether you ever open the tab. If you don't, delete it; you've lost almost nothing.

The one question you must answer: name the last three times you actually went looking for one of these documents — did files-in-the-repo fail you in any of them, or are you designing storage for a retrieval problem you haven't had?

### Hamel Husain (evals)

## Hamel Husain — evals lens

**1. This is a mechanism without an observed failure. Your own spec already knows better.**

The mesa spec has a discipline I'd hold up in my course as a model: the activity log is "**Deferred, not rejected** ... Revisit after reading real agent transcripts," and the blocked-task-close behavior is "held as a **hypothesis** ... Revisit after reading real agent transcripts." Document storage should clear the same bar, and the briefing gives no evidence it does. What's the failure? Did an agent fail to find a spec? Did Simon lose a consult transcript? Did grep miss something? The pitch — "we store specs, consults, user documentation, feature lists, anything" — is a solution shape, not an error analysis. "Anything" is the tell: when the feature's scope is "anything," nobody has looked at the actual data. Before any panel blesses this, I want the inventory: how many documents exist today across the repos, what sizes, how often are they read vs. written, and by whom (agent or human). That's an afternoon with `find` and git log, and it will either produce the failure mode this fixes or kill the idea cleanly.

**2. The predictable failure mode is dual-home drift, and as designed it's unmeasurable.**

The briefing is explicit that these documents already have homes: `specs/*.md`, `.claude/consults/*.md`, `skills/`, plus the knowledge base. Add mesa storage and you don't replace those homes — the planning skill still writes to `specs/`, the consult skill still writes to `.claude/consults/`. You create a second copy. The concrete failed run looks like: an agent reads the mesa copy of a spec that's three revisions behind the repo copy, and plans against stale requirements — and nothing in the design would ever surface that this happened. If this ships in any form, the acceptance criterion I'd demand is binary and checkable: *for every document type mesa stores, name the single canonical home, and show the check that detects divergence.* If you can't write that check, the feature manufactures silent failures. (Whether pointers-vs-blobs solves this architecturally is Barry's lane; I'm only insisting the failure be detectable.)

**3. Consult transcripts are your raw eval data — don't move them somewhere less inspectable.**

The `.claude/consults/*.md` files are exactly the artifacts you need to do error analysis on your own agent workflows: full transcripts, in git, greppable, diffable, readable in any editor. Putting them in SQLite blobs behind a CLI makes the raw data *harder* to look at, which is the opposite of what a single maintainer doing his own quality control needs. "Look at your data" requires the data to be trivially lookable-at. Any v1 that makes `grep -r` stop working on consults is a regression in your ability to evaluate everything else you build.

**4. If go: the minimal v1 is instrumentation, not storage — and it has a built-in success metric.**

The evals-friendly v1 is a registry of pointers to existing files (path + project + label), not a content store. Not because it's architecturally lighter (Barry's call) but because it's *measurable*: a registry that gets queried tells you which documents agents and Simon actually need findable, and a registry nobody queries after 30 days is a clean no-go signal you can read straight from usage. A blob store gives you no such signal — content sits there whether or not it earned its place. Define the kill criterion before building, in the spec's own style:

```
- **Hypothesis**: agents need a cross-project "where is the spec for X"
  lookup that filesystem conventions don't provide. v1 is a pointer
  registry (`mesa doc add <project> <path> --label spec`). Revisit after
  30 days of real use: if `mesa doc list` appears in fewer than N real
  agent transcripts, remove it.
```

**5. The folder hierarchy is speculative until a flat list has demonstrably failed.**

"You can add folders too" — for a corpus that today is, per project, a handful of specs and consults? Your CLAUDE.md forbids exactly this ("No features that weren't asked for" is the user's own rule, and here the user is asking, but the *test* still applies: no structure until flat structure has produced a real retrieval failure). Binary check: has anyone ever failed to find a document because the list was flat? If no observed instance, folders are out of v1, full stop.

**Verdict: no-go as stated; conditional go on the pointer-registry v1 in point 4 — and only after the one-afternoon document inventory in point 1, which I'd treat as the actual next task.**

The one question you must answer: **Name one real, dated instance where you or an agent needed a document and the files-in-the-repo setup failed you — and if you can't, what are you building this to fix?**

### Andrej Karpathy (knowledge, context & autonomy)

## Karpathy — knowledge, context & autonomy review

**Verdict: no-go on document *storage*; conditional go on document *indexing* — and the minimal v1 might be one column.**

**1. Ask what the model actually sees when it needs a spec. Today vs. proposed, traced concretely.** Today an agent needing the mesa spec does one tool call — `Read specs/2026-06-11-mesa.md` — and gets raw markdown, with partial reads (offset/limit), grep, and glob all available for free. Under mesa-stored docs the same retrieval becomes: `mesa doc list --project 3`, scan the JSON for the right id, `mesa doc show 17`, then parse markdown out of a JSON-escaped string. That's three calls, more tokens carried in the main window, and a worse format. Note this violates mesa's *own* spec, principle 2: "Choose natural formats; no exotic escaping." JSON-escaped markdown is exactly the exotic escaping that principle exists to forbid. The proposal makes knowledge harder for the model to retrieve, which is the one thing a document feature must not do.

**2. You'd be creating a third home for knowledge, and homes have a discovery cost.** The briefing already names two: files-in-repo (`specs/`, `.claude/consults/`, `skills/`) and the Obsidian vault for cross-project knowledge. Each additional home is another place every fresh agent session must know to check, which means more boilerplate in every CLAUDE.md, or — the realistic outcome — agents checking the place their tools work best (the filesystem) and silently never seeing what's in mesa. Knowledge that isn't retrieved is knowledge you don't have. The split you have today is actually principled: repo-local knowledge lives with the repo, cross-project knowledge lives in the vault. "Anything goes in mesa too" breaks that with no retrieval story.

**3. The autonomy regression is the quiet one: documents in SQLite lose the `git diff` checkpoint.** Today, when an agent writes a spec or consult transcript, the human verification loop is built in — it lands as an uncommitted file, Simon reviews the diff, commits or rejects. That checkpoint sits *before* the document becomes durable truth that future agent sessions load as context. A doc written via `mesa doc create` is live the instant the command exits: no diff, no review, no history, no revert. A wrong premise written by one agent gets loaded into every future context with zero human gate. That's the failure mode I care about most — not the crash, the plausible doc. The briefing lists "versioning/history" as an open question; for files in a git repo it's not a question at all, it's already solved better than mesa v2 ever would.

**4. If anything ships, it's pointers, not blobs — and possibly just one column.** The only thing mesa can add that the filesystem can't is *association*: "this task relates to that spec." That's metadata, not storage. Two minimal shapes, in increasing order of cost:

Cheapest (my pick — convention over schema):
```sql
ALTER TABLE projects ADD COLUMN repo_path TEXT;
```
Mesa now knows where each project lives on disk; agents and the web UI derive documents by existing convention (`<repo_path>/specs/*.md`). One column, zero new CLI surface beyond `--repo-path` on project create/update.

If real task-to-doc linking pain emerges later:
```sql
CREATE TABLE documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,  -- file on disk; mesa stores pointers, never content
    title      TEXT
);
```
Either way the filesystem stays the substrate; git history, grep, any editor, and agents' existing Read/Grep tools are all preserved. "You can add folders too" answers itself under this design: the filesystem already has folders. Don't rebuild a filesystem inside SQLite for an audience of one.

**5.** Whether a doc-viewer panel belongs in the web UI at all is an architecture/scope call — Barry's lane. Whether mesa-rendered untrusted markdown opens an injection surface in the UI is Simon Willison's.

The one question you must answer: When you or an agent last needed a project document mid-task, what concretely failed about reading the file from the repo — and would mesa storing that document have fixed the failure, or just moved the file somewhere your tools are weaker?

---

## Synthesis

### Per-expert summaries

**Barry Zhang (architecture)** — No-go on storage: no demonstrated failure of files-in-the-repo, and "anything" is the absence of a requirement. SQLite-stored prose violates mesa's own ACI principle 2 (JSON-escaped markdown is exotic escaping). The plausible kernel is *linkage*, not storage: a `documents` pointer table + read-only viewer. Don't add a third home for documents. *One question: name the specific, recent moment where "the document is a file in the repo" failed you.*

**Amanda Askell (wording)** — Conditional no: the request as worded is two different features ("store anything in folders" vs. "give tasks a place to reference project markdown") and the disambiguating questions haven't been asked. "Anything" licenses a binary-blob store; "you can add folders too" smuggles in a second tree. A pointer design is a *different feature* than "store" and needs Simon's explicit sign-off as a choice. The canonical-home sentence must be written into CLAUDE.md/the planning skill/SKILL.md before any code. *One question: when an agent finishes writing a spec, which single sentence in which file tells it where that spec now lives — mesa or the repo?*

**Simon Willison (pragmatics & security)** — No to storage; if anything ships, a thin read-only viewer: one `docs_path` column, two path-confined GET routes, one UI tab, no CLI. Blobs in SQLite destroy the recovery story (git saves you; `VACUUM INTO` doesn't). A docs endpoint turns `mesa serve` into a localhost file server — confine paths mechanically (canonicalize, reject escapes). Documents widen the injection surface flowing into web-connected agents; extend Requirement 15's treat-as-data warning. *One question: name the last three times you went looking for one of these documents — did files-in-the-repo fail you in any of them?*

**Hamel Husain (evals)** — No-go as stated; conditional go on a pointer registry only after a one-afternoon document inventory (count, sizes, read/write frequency, by whom). The predictable failure is dual-home drift — an agent reading a stale mesa copy of a spec — and as designed it's undetectable. Consult transcripts are raw eval data; anything that makes `grep -r` stop working on them is a regression. Define the kill criterion before building (30 days; if unused, remove). *One question: name one real, dated instance where files-in-the-repo failed you — and if you can't, what is this fixing?*

**Andrej Karpathy (knowledge & context)** — No-go on storage, conditional go on indexing. Retrieval gets strictly worse: one `Read` call becomes three CLI calls returning JSON-escaped markdown. A third knowledge home has discovery cost agents will silently fail to pay. SQLite docs lose the git-diff human checkpoint — an agent-written wrong premise becomes durable truth with no review gate. Cheapest viable shape: `ALTER TABLE projects ADD COLUMN repo_path TEXT` and derive docs by convention. *One question: what concretely failed about reading the file from the repo last time — and would mesa storing it have fixed that, or moved the file somewhere your tools are weaker?*

### Convergent points

1. **No observed failure of the status quo — all 5 experts, briefing-specific.** Every expert independently demanded a dated, concrete incident where files-in-the-repo failed, and four of five made it their "one question." They anchored it to briefing specifics: the spec's own "deferred, not rejected" discipline and the existing homes list. High signal.
2. **Pointers/index, never blobs — 4 experts (Barry, Willison, Hamel, Karpathy), briefing-specific.** Three near-identical schemas proposed independently (pointer table or a single path column on `projects`). Blobs lose git history, recovery, grep, and the human review gate. High signal.
3. **Third-home / dual-home drift — 4 experts (Barry, Amanda, Hamel, Karpathy), briefing-specific.** Repo + vault already exist; mesa as a third home means agents read stale copies or never look. Amanda located the fix precisely: a canonical-home sentence in the agent-facing docs, written before any code.
4. **Folders rejected for v1 — 4 experts, partly generic.** "The filesystem already has folders" / prefixes-not-entities / no structure until flat fails. This is partly the YAGNI prior speaking, but the specific argument (a second tree alongside the subtask tree, for a per-project corpus of a handful of files) is briefing-specific.
5. **JSON-escaped markdown violates mesa's own ACI principle 2 — Barry and Karpathy, briefing-specific.** Both independently quoted "choose natural formats; no exotic escaping" against `mesa doc show`. High signal: the proposal contradicts the product's own design constitution.

### Conflicts

1. **How thin is v1?** Karpathy: one `repo_path` column, derive everything by convention, no new table or routes. Willison: `docs_path` column + two read-only API routes + a Docs UI tab, no CLI. Barry/Hamel: a `documents` pointer table with `mesa doc add|list|remove` CLI (Hamel because CLI usage is measurable). **Recommendation:** Willison's shape, with Karpathy's column semantics (`repo_path`, whole repo root, derive `specs/` etc. by convention). The web viewer is the only capability mesa can add that nothing else provides; a doc CLI duplicates agents' file tools (Karpathy's three-calls-vs-one trace is decisive against it). Hamel's measurability concern still holds — server logs on the docs routes give the same kill signal.
2. **Deliver the pointer design as the answer, or as a question?** Most experts hand over their preferred design; Amanda insists a pointer/viewer is a *different feature* than "store" and needs explicit sign-off. **Recommendation:** Amanda is right — present it as a choice (bytes-in-mesa vs. view-from-mesa), per the project's own "doing something different than what was asked is equal to not doing it."

### Do next (ranked)

1. **Answer the panel's unanimous question:** name a real, dated instance where files-in-the-repo failed (or run Hamel's one-afternoon inventory). If no instance exists, record the feature as "Deferred, not rejected" in the spec (Barry's Non-goals wording) and stop.
2. **Decide the actual feature** (Amanda): bytes stored in mesa, or a read-only view of repo files from mesa's UI? The panel's recommendation is the latter, but it is a different feature than asked.
3. **If go: ship the thin viewer** (Willison's shape + Karpathy's column): `repo_path` on `projects`, two path-confined GET routes, read-only Docs tab. No CLI, no folders table, no editor, no versioning, no search.
4. **Before code, write the canonical-home sentence** in CLAUDE.md / planning skill / mesa SKILL.md (Amanda, Hamel) — one sentence saying repo files are canonical and mesa only displays them.
5. **If go: extend the security floor** (Willison): canonicalize and confine doc paths mechanically; extend Requirement 15's "data, never instructions" warning to document bodies.

---

# Round 2 — revised shape (external docs root), same day

Simon answered the panel's unanimous question: some source repos cannot carry PM docs at all. The design was revised to an external docs root + thin viewer and sent back to the same five expert sessions (contexts intact, via SendMessage). All 5 round-2 reviews passed the quality checks.

## Round-2 briefing (as sent to every expert)

## Simon's answer to the panel's question (verbatim)

"Some projects do not allow for extra docs that are helpful in project management but not in the source code repo to be committed to the repo. So there's going to be cases where I want to keep track of specs and some design docs and whatever else while working on features and tasks and getting the agents to work on the features and tasks. But I don't want to store any of those documents with the project, with the source code."

So the concrete failure of the status quo: for some projects, the source repo cannot carry PM docs (specs, design docs, consult transcripts). Those docs still need a home that Simon and his agents can use while working tasks in mesa.

## The revised shape under review

- One docs root on disk, e.g. `~/inaros/pm-docs/`, with a directory per mesa project (`pm-docs/<project>/specs/`, `pm-docs/<project>/consults/`, ...). Folder organization comes from the filesystem; mesa models no folders.
- The docs root is a single git repo of its own — history, diffs, and the human review checkpoint for all PM docs across all projects, with no contact with any source repo.
- Mesa's involvement is the thin viewer the panel converged on last round: a `docs_path` column on `projects`, two path-confined read-only GET routes (`GET /api/projects/:id/docs` listing, `GET /api/projects/:id/docs/{*path}` content), and a read-only Docs tab in the web UI rendering markdown. Optionally `mesa project create` initializes `<docs_root>/<slug>/`.
- No `mesa doc` CLI: agents read/write docs with their normal file tools (Read/Grep/Edit). No blobs in SQLite, no editor in the UI, no versioning in mesa, no search in mesa.
- Canonical-home rule, to be written into CLAUDE.md / the planning skill / mesa's SKILL.md before code: "PM documents for a project live in `<docs_root>/<project>/`, never in the source repo; mesa displays them; the files are the truth."

## Open design questions (not settled)

1. Per-project docs location: (a) derived from a single `MESA_DOCS_ROOT` convention — zero config, one rule agents learn once, with a per-project override column for odd cases (current lean) — or (b) a fully per-project arbitrary `docs_path` (max flexibility, more config)?
2. The split-home wrinkle: for projects whose repos DO allow docs, Simon currently keeps specs/consults in the repo (`specs/`, `.claude/consults/`). The revised shape could either (i) migrate ALL projects' PM docs to the docs root — one unconditional rule, but it moves files that were fine where they were — or (ii) keep repo docs where allowed and use the docs root only for restricted projects — no migration, but the canonical-home rule becomes conditional: "in the repo if allowed, else in the docs root."

## Round-2 raw expert outputs (verbatim)

### Barry Zhang (architecture)

## Barry Zhang — round 2

**1. The shape now passes the test I set last round — say so plainly.** Simon named a concrete failure ("some projects do not allow... docs to be committed to the repo"), and the revised design is the minimal answer to *that* failure: a filesystem convention plus a thin read-only viewer. Every capability granted is used — no doc CLI agents wouldn't prefer over Read/Grep, no blobs, no folder model ("folder organization comes from the filesystem" is exactly right), versioning delegated to a git repo that already does it. Mesa's footprint is one column and two GET routes. This is the workflow version, fully drawable ahead of time. Go.

**2. Open question 1 — but don't ship the override column yet.** The lean is right (convention over config), with one correction: "with a per-project override column for odd cases" is the exact speculative move the project's own rules forbid. No odd case has occurred. However, *derivation* has a mechanical flaw: `projects.name` has no UNIQUE constraint and isn't slug-safe, so a path derived on every read from a renamable, collidable name is a latent bug. Resolve it by materializing once: `mesa project create` computes the slug, creates `<docs_root>/<slug>/`, and stores the result in `docs_path`. You get convention's zero-config behavior, no rename ambiguity, and — see point 3 — the column you stored turns out to answer the other open question for free.

**3. Open question 2 — make the rule unconditional in *form* by moving the conditional into data.** "In the repo if allowed, else in the docs root" written as prose is a briefing bug factory: every agent session must re-derive a per-project fact ("is this repo restrictive?") that lives nowhere it can check, so agents will guess. But option (i)'s forced migration breaks co-location for projects where it works and moves files that were fine — scope expansion to buy rule symmetry. Take (ii), implemented as data: `docs_path` defaults to `<docs_root>/<slug>/` at create, and for permissive projects Simon may point it into the repo. The agent-facing rule then has no conditional at all — it's one lookup. Rewrite of the canonical-home rule:

```
PM documents for a project live at the project's `docs_path`
(`mesa project show <id>` returns it; default `<docs_root>/<slug>/`).
The files are the truth; mesa only displays them.
Never write a PM doc anywhere except the project's `docs_path`.
```

Which project-repo split is *philosophically* right for knowledge layout is Andrej's lane; my claim is narrower: whatever the answer per project, encode it in the row, not in conditional prose.

**4. New gap the revision introduces: the docs-root repo has no committer.** The briefing sells the docs root as "history, diffs, and the human review checkpoint" — but agents write there with plain file tools, and nothing in the shape says who runs `git commit`. An uncommitted git repo delivers none of those three benefits; it just silently degrades to a directory. Don't put this in mesa (correctly out of scope for a viewer). Pin it in the deterministic layer that already exists: the planning skill and any consult-writing skill end their write with a commit to the docs repo. One line in each skill, written before code, alongside the canonical-home rule.

**5. Path confinement on `GET .../docs/{*path}` is Simon Willison's lane** — traversal out of `docs_path` is the obvious attack; one line from me and moving on.

The one question you must answer: when `docs_path` points inside a source repo for permissive projects, are you committed to mesa's viewer and the planning skill treating that path identically to the docs root — and if not, what breaks first?

### Amanda Askell (prompt wording)

**What survives round 1:** the two ambiguities I flagged are genuinely resolved. "Store" vs. "index" is settled the right way and stated crisply ("the files are the truth"); "anything" and "folders" dissolved into the filesystem, where they cost no spec language at all. And the canonical-home sentence is scheduled "before code," which was my condition. Good. Now the problems with the revised text itself.

**Point 1 — Option (ii) as drafted is an instruction agents cannot follow, because "allowed" is not observable.**
"In the repo if allowed, else in the docs root" conditions on a fact that exists only in Simon's head. An agent about to write a spec for project X has no file, flag, or command that tells it whether X's repo "allows" PM docs — so it will guess, and the failure mode is precisely the one this feature exists to prevent: a spec committed into a repo that mustn't carry it. This is my round-1 Point 3 reborn in worse form: round 1 had two homes with conflicting instructions; option (ii) has two homes with *one* instruction whose branch condition the reader can't evaluate. Either pick (i), or make the condition data — which leads to:

**Point 2 — the `docs_path` column dissolves open question 2 entirely, if you write the rule as a lookup instead of a convention.**
The revised shape already contains the fix and doesn't notice. If `docs_path` is mandatory on every project, then for restricted projects it points into the docs root and for permissive projects it may point at `<repo>/specs/`'s parent — and the agent-facing rule becomes unconditional, identical under (i) and (ii), with no judgment call and no path derivation. The condition moves out of prose and into a per-project data value Simon sets once at `project create`. Replace the drafted rule:

> ~~"PM documents for a project live in `<docs_root>/<project>/`, never in the source repo; mesa displays them; the files are the truth."~~

with:

> PM documents for a project live in the directory given by that project's `docs_path` (`mesa project show <id>`). Always look it up; never derive it from the project name and never assume a default. Mesa renders these files read-only — edit them with your normal file tools. The files, not mesa, are the source of record.

Note what the original sentence got wrong even on its own terms: "never in the source repo" is *false* under option (ii), so the drafted rule already presupposed an answer to a question the briefing lists as open. The lookup form is true under both.

**Point 3 — `<project>` vs. `<slug>` is an unspecified derivation that two agents will compute two ways.**
The briefing writes `pm-docs/<project>/specs/` in one bullet and `<docs_root>/<slug>/` in another. Project names contain spaces and capitals; "slug" is never defined. If any instruction anywhere tells an agent the path *pattern* rather than the looked-up path, "Web UI Rework" becomes `web-ui-rework/` in one session and `Web UI Rework/` in the next, and the docs split across two directories with no error. The lookup rule in Point 2 makes this unreachable — but only if no document (CLAUDE.md, SKILL.md, planning skill) ever states the convention to agents. The convention `<docs_root>/<slug>/` should appear in exactly one place: the code path in `mesa project create` that mints the directory and writes `docs_path`. On open question 1, that's my position: (a) is fine, but the convention is for mesa's create command and for Simon's mental model — the agent instruction surface should be lookup-only, which makes (a) vs. (b) invisible to agents and therefore free to change later.

**Point 4 — "Optionally `mesa project create` initializes `<docs_root>/<slug>/`" — "optionally" is not a spec.**
Optional to whom, decided when? If it's a flag, name it and state the default; if it's unconditional, delete the word. And specify the awkward inputs in the same sentence, Requirement-6 style: what happens when the directory already exists (adopt it silently? error?), and — the case that matters most under Point 2 — whether a project can exist with `docs_path` unset, because every downstream instruction ("always look it up") assumes the lookup returns something. Same discipline for the two GET routes: the spec must say what the listing returns for an empty directory versus a missing directory versus an unset `docs_path` — an empty array and a 404 are different claims, and an agent-adjacent UI will surface whichever one you didn't think about. (Path confinement on `{*path}` — traversal, symlinks out of the root — is Simon Willison's lane; I flag only that the contract wording must exist.)

**Point 5 — the migration sentence is missing.**
Under (i), and even under (ii)-with-lookup, the planning skill's current instruction — write specs to `<repo>/specs/*.md` — becomes wrong for at least some projects, and the briefing's "to be written into CLAUDE.md / the planning skill / mesa's SKILL.md" names the files but not the edit. The planning skill needs its output-path line replaced with the Point 2 lookup, in the same change that ships the rule — otherwise the highest-volume producer of specs keeps following the old instruction, and the canonical-home rule is a sentence agents read but a behavior they don't exhibit.

The one question you must answer: **Is `docs_path` mandatory on every mesa project — so that "look it up" always returns an answer — or can it be unset, in which case what is an agent holding a finished spec instructed to do?**

### Simon Willison (pragmatics & security)

## Simon Willison — pragmatics & security, round 2

**Verdict first: the revised shape survives my round-1 objections.** Files are the truth, git provides history, agents use their normal file tools, mesa is a path-confined read-only viewer with no `mesa doc` CLI. That's the simplest tool that does the job, and the answer to the panel's question is a real failure of the status quo, not an imagined one. Go — with the following.

**1. You've built an aggregation point, and whether that's fine depends on *why* the repos forbid these docs.** "Repo hygiene" and "confidentiality/policy" look identical in the briefing but have opposite risk profiles. If any project bars PM docs for confidentiality reasons (client work, NDA material in consult transcripts), then `~/inaros/pm-docs/` as one git repo concentrates exactly the material the policy was protecting — and adds two channels that didn't exist before: (a) any agent session with file access to the docs root can read *every* project's docs, where previously docs were confined per-repo; (b) one habitual `git push` to the wrong remote exfiltrates all of it at once. Mechanical mitigations, not behavioral ones: the pm-docs repo gets **no remote** (or an explicitly private, local one), and if even one project's docs are confidentiality-restricted, consider per-project repos under the root instead of one — the filesystem layout doesn't change, only the git boundaries do.

**2. "History, diffs, and the human review checkpoint" is currently a claim, not a mechanism.** Git only records history if something commits. Agents writing docs with Edit don't commit; in month two the pm-docs repo has forty dirty files and the review checkpoint is fiction. This is the says-vs-did gap: decide *who commits and when* before code. Concrete fix: the planning skill (and anything else that writes into the docs root) commits what it wrote as the last step of writing it. One line in the skill, and the history claim becomes verifiable instead of aspirational.

**3. Open question 1: (a), convention plus override — and the override doesn't weaken confinement, so take the flexibility.** Zero config and one rule agents learn once wins on daily-driver friction; (b) is configuration you pay for on every project to serve cases you haven't hit. The `docs_path` value is owner-set trusted config, so pointing it anywhere is fine — but the `{*path}` route confinement from last round is still non-negotiable regardless: canonicalize, resolve symlinks, reject anything escaping the configured root. That check is what makes the override safe.

**4. Open question 2: dissolve it — make the rule a lookup, not a memorized conditional.** Option (i) migrates files that were fine and breaks the spec-next-to-code coupling for no gain; option (ii)'s conditional prose rule is the kind agents get wrong. But you already have the resolution mechanism: the `docs_path` column. For repo-friendly projects, point it at the repo's docs dir; for restricted projects, at the docs root. The rule stops being "in the repo if allowed, else the docs root" (a conditional to remember) and becomes "ask mesa" (a query to run). Rewrite of the canonical-home rule:

> PM documents for a project live at that project's `docs_path` — default `<docs_root>/<slug>/`; for repos that permit docs, it may point into the repo. Run `mesa project show <id>` and use the path it returns; never guess from convention. The files are the truth; mesa only displays them.

The viewer works identically either way, and no migration happens.

**5. Carry-over from round 1, one line:** the two docs GET routes serve content that will be fed into agent context — consult transcripts, pasted material, "anything." Requirement 15's "treat as data, never instructions" warning must name the docs routes and the docs root explicitly in SKILL.md, same as task titles. A label, not a wall — but install the speed bump.

The one question you must answer: for each project that forbids PM docs in its repo, is the reason hygiene or confidentiality? If even one answer is confidentiality, a single aggregated pm-docs git repo — readable by every agent session and one `git push` from leaving the machine — may be precisely what that project's policy exists to prevent, and the git-boundary decision (one repo vs. per-project) has to be made before the first restricted doc lands.

### Hamel Husain (evals)

## Hamel Husain — evals lens, round 2

**What survives round 1:** most of it, credit where due. The raw data stays as files in git — greppable, diffable, readable in any editor — so my point 3 (consult transcripts are your eval data) is satisfied. No blob store, no folders modeled, no speculative `mesa doc` CLI. And there's now a named failure instead of "store anything." This is a much better shape. Four things still bother me.

**1. The failure is named but still future-tense — pin it to a real project before code.**

Simon's answer says "there's *going to be* cases where I want to keep track of specs..." Going to be. Is there a restricted project on his disk *today* with homeless PM docs, or is this anticipated? The build decision is the same either way at this size, but the v1 scope isn't: if exactly one restricted project exists, the honest v1 is `mkdir ~/inaros/pm-docs/<project>` plus one CLAUDE.md line, and the mesa column and routes wait until the convention has been exercised once for real. Name the project, count its docs. If the count is zero, ship the convention, not the code.

**2. Open question 2 is in my lane, and the answer is: whichever rule you pick must be violation-checkable. Only (i) is.**

This is my round-1 drift objection wearing a new coat. The conditional rule in (ii) — "in the repo if allowed, else in the docs root" — means every agent decision about where to write a spec requires per-project knowledge, and a misfiled doc looks identical to a correctly-filed one. You cannot write the check without maintaining an allowlist, at which point you've built config to compensate for an ambiguous rule. The unconditional rule is checkable with one script. But don't pay the migration cost (i) implies — moving old files breaks their git history and moves things that were fine. Freeze instead of migrate:

```
- **Canonical home (unconditional, new docs only)**: PM documents written after
  <date> live in `<docs_root>/<project>/`, never in a source repo. Existing
  repo docs (`specs/`, `.claude/consults/`) are frozen in place, not migrated.
  Violation check: list files newer than <date> under those paths across all
  source repos; run it after the first two weeks of real use.
```

That gives you one rule for agents, zero migration, and a binary audit.

**3. The whole design hangs on an unenforced convention — so the acceptance test is an agent test, and it will fail as currently planned.**

Mesa's own spec principle 4: "Test empirically with a real agent, not just scripts." Here the agent-facing surface isn't a CLI, it's the canonical-home rule in CLAUDE.md / planning skill / SKILL.md. The briefing's own context says the planning skill *currently writes specs to `<repo>/specs/`*. Until that skill is updated, a fresh agent session asked to spec a restricted project will misfile the doc 100% of the time — the rule text in CLAUDE.md won't outvote the skill's explicit write path. The acceptance test, before declaring this done: fresh session, restricted project, "plan feature X" — binary check: did the spec land in `<docs_root>/<project>/specs/` with no extra prompting? Also note the rule is slated to live in three documents; three copies of one rule is its own drift surface. Pick one canonical statement (CLAUDE.md) and have the skill/SKILL.md reference it, not restate it.

**4. The Docs tab needs the same kill criterion mesa already uses for deferred features.**

The viewer routes are cheap, but cheap code that nobody uses is still maintenance. Simon reads these files in his editor today. Write the hypothesis in the spec's own house style:

```
- **Hypothesis**: a read-only Docs tab gets used during real task work.
  Revisit after 30 days: if it hasn't been opened while working tasks,
  drop the routes and keep only the `docs_path` column + the convention.
```

On open question 1: weak preference for (a), one convention agents learn once, because every per-project override is a place the rule can silently diverge — but the config mechanics are Barry's call. Path confinement of the `{*path}` route is Simon Willison's lane; I only note the traversal test should be in the acceptance suite, not just the code.

**Verdict: go, with the freeze-don't-migrate unconditional rule, the planning-skill update treated as part of v1 (not a docs afterthought), and the agent misfiling test as the acceptance gate.**

The one question you must answer: **When a fresh agent session is asked to plan a feature on a restricted project, does the spec land in the docs root unprompted — and have you actually run that test, or only written the rule?**

### Andrej Karpathy (knowledge, context & autonomy)

## Karpathy — round 2

**1. Round-1 objections: cleared, and cleanly.** Files on disk are the substrate, agents retrieve with one `Read` call of raw markdown (no JSON-escaped exotica), folders come from the filesystem, git supplies history and the diff-review checkpoint, and mesa carries pointers-plus-viewer rather than content. "No `mesa doc` CLI: agents read/write docs with their normal file tools" is exactly the right sentence — the model's strongest retrieval path is the one it already has. This shape survives my lens. The remaining issues are about the *rules* around the files, not the files.

**2. Open question 1: pure convention (a), and be suspicious of the override column.** A retrieval rule is knowledge an agent must carry into every session; its cost is measured in what the agent has to *do* before it can trust it. `$MESA_DOCS_ROOT/<project>/` is one line in SKILL.md, derivable with zero lookups. But the moment a per-project override column exists, the convention stops being trustworthy — a rule with exceptions must be verified, so the honest agent procedure becomes "run `mesa project show` first, every session," which silently reintroduces the lookup you were avoiding and makes the convention dead weight. Either ship pure convention with no override (my pick — add the column the day an odd case actually exists, per your own simplicity rules), or accept that the real rule is "always ask mesa" and write *that* in the skill. Don't ship both rules at once; agents will follow whichever one they loaded.

**3. Open question 2: take (i), one unconditional rule. Conditional retrieval rules decay into silent wrong answers.** Under (ii), an agent hunting for the spec must branch: restricted project → docs root, else → repo `specs/`. The failure mode isn't an error — it's the agent checking the wrong home, finding nothing (or worse, finding a stale doc that was never migrated), and proceeding on a wrong premise. That's the quiet autonomy degradation I keep flagging, now built into the spec. Price it: option (i) costs one human-supervised migration, paid once; option (ii) costs a two-place lookup plus a classification judgment ("is this repo restricted?") in *every future agent session, forever*, with stale-doc hazard during the indefinite period where both homes have content. There's also a verification dividend to (i): one docs repo means one diff stream to review, instead of PM-doc diffs scattered across N source repos plus a side repo. Migrate everything; delete the old copies in the same commit so there is never a moment with two plausible truths.

**4. New problem the revision introduces: the diff-review checkpoint moved out of the path of work.** In round 1 I praised files-in-repo because the human gate is automatic — agent writes a spec, it shows up in the diff of the repo Simon is already working in. In a side repo nobody is "in," agent-written docs accumulate uncommitted (or worse, agents commit them unreviewed) and the checkpoint exists only if Simon remembers to open `pm-docs/`. The gate didn't disappear, but it became opt-in, and opt-in gates erode. Don't build mechanism for this — just put the discipline into the canonical-home rule so every doc-writing agent ends its work by surfacing the pending diff (see rewrite below). Whether mesa's Docs tab should badge "uncommitted changes in docs root" is a feature question for Barry; I'd note only that it would put the checkpoint back in Simon's daily line of sight.

**5. The rule as drafted has a resolution gap.** "PM documents for a project live in `<docs_root>/<project>/`" — resolved *how*? An agent working inside a source repo knows its cwd and the repo dir name; it does not automatically know the mesa project's name or slug, and in restricted repos you can't commit a breadcrumb. If slug ≠ repo dir name, the convention misses and the agent guesses. Pin the mapping in the rule itself. Rewrite of the canonical-home rule:

> PM documents for **every** project live in `$MESA_DOCS_ROOT/<slug>/`, never in the source repo — even where the repo would allow it. `<slug>` is the mesa project name; when working in a source repo, resolve it with `mesa project list` if it doesn't match the repo directory name. Mesa displays these docs read-only; the files on disk are the truth. The docs root is its own git repo: after writing or editing a doc, leave the change uncommitted and tell Simon a docs diff is pending review.

(Path confinement on `GET .../docs/{*path}` and rendering untrusted markdown in the UI: Simon Willison's lane, one line, but make sure he looks at it.)

The one question you must answer: are you willing to migrate the already-allowed repo docs (`specs/`, `.claude/consults/`) into the docs root and delete the originals in one pass — because if the answer is no, you are choosing the conditional rule, and you should write the two-home lookup procedure into every agent's SKILL.md now rather than letting each session rediscover it?

## Round-2 synthesis

### Verdicts

Barry: **go**. Willison: **go** (pending the confidentiality answer). Hamel: **go** (with freeze rule + agent test as the gate). Karpathy: **go** (insists on migrate-all). Amanda: no verdict needed — her round-1 conditions are met; round 2 is textual fixes to the rule and spec.

### Per-expert summaries

**Barry** — The shape passes the test he set in round 1: minimal answer to a named failure, every capability used. Don't derive paths from `projects.name` (no UNIQUE constraint, renamable): mint the slug once at `project create`, store it in `docs_path`. That stored column also answers open question 2: encode the per-project home in the row, not in conditional prose. New gap: the docs-root repo has no committer — pin the commit step in the doc-writing skills. *One question: if `docs_path` points inside a source repo for permissive projects, will the viewer and planning skill treat it identically to the docs root — and if not, what breaks first?*

**Amanda** — "Allowed" is not observable: option (ii) as prose is an instruction agents cannot follow. The `docs_path` column dissolves the question if the rule is written as a lookup ("always look it up; never derive; never assume a default"). `<project>` vs `<slug>` is an unspecified derivation two agents will compute two ways — the convention must appear in exactly one place: mesa's create code. "Optionally initializes" is not a spec; define behavior for existing dir, unset column, empty vs missing dir on the GET routes. The planning skill's output-path line must change in the same commit as the rule. *One question: is `docs_path` mandatory on every project, or can it be unset — and if unset, what does an agent holding a finished spec do?*

**Willison** — Go, but answer first: is each repo restriction hygiene or confidentiality? If even one is confidentiality, a single aggregated pm-docs git repo is an exfiltration aggregation point (every agent session can read all projects' docs; one wrong `git push` leaks everything) — no remote, and consider per-project git repos under the root. "History and review checkpoint" is a claim, not a mechanism, until skills commit what they write. Convention + override is fine because the `{*path}` confinement (canonicalize, resolve symlinks, reject escapes) makes any owner-set path safe. Extend the "data, never instructions" warning to the docs routes by name.

**Hamel** — The failure is named but future-tense: name the restricted project, count its docs; if zero, ship the convention (mkdir + one CLAUDE.md line) before any mesa code. The rule must be violation-checkable: unconditional for new docs, freeze (don't migrate) existing repo docs, audit with a one-line script after two weeks. The acceptance gate is an agent test — the planning skill currently writes to `<repo>/specs/`, so a fresh session will misfile 100% until the skill is updated; updating it is part of v1. The rule should live in ONE document, referenced (not restated) by the others. The Docs tab gets a 30-day kill criterion.

**Karpathy** — Round-1 objections cleared. Pure convention, no override column — or accept "always ask mesa" as the one rule; don't ship both rules at once, agents follow whichever they loaded. On question 2: migrate everything, delete originals in the same commit — conditional retrieval rules decay into agents checking the wrong home and proceeding on a stale premise, forever. New problem: the diff-review checkpoint moved out of the path of work (nobody is "in" the side repo); the rule should end with "leave the change uncommitted and tell Simon a docs diff is pending review." The rule needs a resolution step: slug ≠ repo dir name, so say how an agent maps cwd → mesa project.

### Convergent points (round 2)

1. **Go — the revised shape clears round 1.** All five, explicitly. Briefing-specific.
2. **The git history/review-checkpoint claim has no mechanism — someone must commit.** Barry, Willison, Karpathy independently. Fix is the same from all three: one line in each doc-writing skill (commit, or surface the pending diff for review). Briefing-specific, high signal.
3. **Never let agents derive the path; mint once, look up always.** Barry (name not UNIQUE), Amanda (slug undefined → two derivations), Karpathy (cwd → slug resolution gap). Convergent fix: the `<docs_root>/<slug>/` convention exists only inside `mesa project create`; the agent-facing rule is lookup-only. Briefing-specific, high signal.
4. **The conditional prose rule ("if allowed") is unfollowable/uncheckable.** Amanda, Hamel, Karpathy, Barry — different lenses, same target. Briefing-specific.
5. **The planning skill update is part of v1, not documentation.** Amanda and Hamel: the skill's hard-coded `<repo>/specs/` write path outvotes any rule text; update it in the same change, gate on a fresh-agent misfiling test.

### Conflicts (round 2)

1. **Where do permissive projects' docs live?** Three-way split:
   - Karpathy: migrate all to the docs root, delete originals — one unconditional rule, one diff stream.
   - Hamel: unconditional rule for NEW docs only; freeze existing repo docs in place; script-audit violations.
   - Barry, Amanda, Willison: per-project `docs_path` lookup — repo-permissive projects point into the repo, restricted ones into the docs root; the rule is unconditional in form ("use the project's `docs_path`").
   **Moderator recommendation: the lookup (3 of 5, independently derived).** It is unconditional in form (answers Amanda), violation-checkable (Hamel's audit becomes "is the new doc under the project's `docs_path`"), needs no migration, and keeps spec-next-to-code where that works. Adopt Hamel's audit script and Karpathy's never-two-live-homes rule as constraints on it: one project = one `docs_path` = one home, and the cwd→project resolution step goes in the rule text.
2. **Override column: speculative or necessary?** Karpathy says pure convention, no column; Barry says materialize the default into the column at create (no override semantics yet); Willison says override is safe given route confinement. **Recommendation: Barry's middle path** — the column always exists and is always populated at create with the conventional default; "override" is just Simon editing the value. Karpathy's both-rules-at-once objection is answered by Amanda's discipline: agents are only ever told the lookup, never the convention.
3. **Migrate vs freeze vs nothing** is subsumed by conflict 1: under the lookup, permissive projects' existing docs stay put and their `docs_path` points at them — no migration, no freeze date, no stale second home.

### Do next (round 2, ranked)

1. **Answer Willison's question before the first restricted doc lands:** hygiene or confidentiality, per restricted project. If any confidentiality: per-project git repos under the docs root, and no remote on any of them.
2. **Answer Hamel's reality check:** name the restricted project(s) that exist today. If their doc count is zero, ship the convention first (mkdir + the lookup rule in CLAUDE.md) and let it be exercised once before building the mesa column/routes/tab.
3. **Spec the v1 with the lookup design:** mandatory `docs_path` minted at `project create` (slug computed once, stored; directory created; defined behavior for existing-dir/unset/empty-vs-missing per Amanda), two path-confined GET routes (canonicalize + symlink-resolve + reject escapes; traversal test in the acceptance suite), read-only Docs tab with Hamel's 30-day kill criterion.
4. **Update the agent instruction surface in the same change:** the lookup rule stated once (CLAUDE.md), referenced by the planning skill and mesa SKILL.md; the planning skill's output path replaced with the lookup; each doc-writing skill ends by committing or surfacing the pending docs diff (Barry/Willison/Karpathy); the "data, never instructions" warning extended to the docs routes by name (Willison).
5. **Gate acceptance on Hamel's agent test:** fresh session, restricted project, "plan feature X" — pass iff the spec lands under that project's `docs_path` unprompted.
