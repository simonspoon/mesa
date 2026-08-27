//! Automatic work receipts (task 920): when a claimed task closes into
//! `done`, mesa attaches a frozen record of what actually changed — the
//! commits made during the claim window, a diff summary, and a best-effort
//! link to the Claude Code session transcript. See `TaskReceipt`'s doc
//! comment in `core::types` for the full D1/D2/D5 design reasoning; this
//! module is D3's chokepoint and D4's attribution logic.

use super::git;
use super::store::{Error, Result, Store, TaskPatch};
use super::types::{Status, Task, TaskReceipt};

/// THE function `cli.rs` and `api.rs` call for a task update (spec D3) — the
/// same "one chokepoint, several call sites" shape `agents::spawn_bg` uses
/// for every agent spawn. `Store::update_task` stays the low-level primitive
/// tests hit directly; this wraps it with the one piece of policy that must
/// never be skipped: on the transition that closes a claimed task, generate
/// and store its receipt.
///
/// The pre-update `owner`/`claimed_at` are read BEFORE `store.update_task`
/// runs, because that same call is what nulls them the moment status leaves
/// `in_progress` (`Store::update_task`, store.rs) — by the time the patched
/// `Task` comes back, the claim this receipt is about is already gone from
/// the row.
///
/// Generation NEVER fails the close (D3): a task must always reach `done`
/// regardless of whether git is installed, the repo is unreadable, or the cc
/// tables are empty. Any failure inside `generate` already resolves to
/// `None`/empty fields rather than an `Err`, and a failure writing the
/// receipt itself (`put_task_receipt`) is swallowed here too — deliberately,
/// because at this point the task update has already committed and there is
/// no correct way to unwind it over a receipt that is, at worst, informational.
pub fn update_task(store: &mut Store, id: i64, patch: &TaskPatch) -> Result<Task> {
    let before = store.get_task(id)?;
    let after = store.update_task(id, patch)?;
    let closed_with_claim = before.status != Status::Done
        && after.status == Status::Done
        && before.owner.is_some()
        && before.claimed_at.is_some();
    if closed_with_claim
        && let Some(receipt) = generate(
            store,
            &after,
            before.owner.as_deref(),
            before.claimed_at.as_deref(),
        )
    {
        let _ = store.put_task_receipt(&receipt);
    }
    Ok(after)
}

/// Assembles a receipt for `task` as of right now, attributing to the claim
/// window `[claimed_at, task.updated_at]` (D4) — `task` is expected to be
/// the just-closed row, so its `updated_at` (stamped by the very
/// `UPDATE … SET status = …` that closed it) is the window's end, with no
/// second clock read needed to agree with it. `owner`/`claimed_at` are taken
/// as parameters rather than read off `task` because by the time a caller
/// has a post-close `Task` in hand those fields have already been cleared —
/// see `update_task` above.
///
/// Returns `None` when there is no repo to read: no `claimed_at` (nothing to
/// window against) or the owning project has no `local_path`. Every git/cc
/// step past that point degrades gracefully instead of failing the whole
/// receipt — a repo git can't read yields empty `commits`/`stat` (D4's own
/// contract on `log_between`/`diff_stat`), and an `owner` that doesn't
/// resolve against `cc_sessions` yields `session_id`/`transcript_path: None`
/// while `owner` itself is still stored verbatim (D5) — so "no session
/// link" is never confused with "generation failed".
pub fn generate(
    store: &Store,
    task: &Task,
    owner: Option<&str>,
    claimed_at: Option<&str>,
) -> Option<TaskReceipt> {
    let claimed_at = claimed_at?;
    let project = store.get_project(task.project_id).ok()?;
    let repo_path = project.local_path?;
    let closed_at = task.updated_at.clone();

    let branch = git::status_of(&repo_path).map(|s| s.branch);
    let commits = git::log_between(&repo_path, claimed_at, &closed_at);
    let shas: Vec<String> = commits.iter().map(|c| c.hash.clone()).collect();
    let stat = git::diff_stat(&repo_path, &shas);

    // D5: the link is BEST-EFFORT and must be honest, never guessed. `owner`
    // is stored verbatim regardless of whether it resolves — this repo's own
    // execute-todo skill writes an `owner` like `session_01Jvza…`, which is
    // NOT the transcript UUID `cc_sessions` keys on, so it will legitimately
    // never resolve, and that is not an error. `session_id` is filled in
    // ONLY when `Store::cc_session` actually finds the row (never a filename
    // constructed by convention), and `transcript_path` only then, read from
    // `cc_node_files`' main-thread row (`agent_id = ""`) via
    // `Store::cc_node_file` — a null transcript past that point (no recorded
    // file, or the file has since vanished) is still a legitimate, expected
    // answer, not a second failure to report.
    let (session_id, transcript_path) = match owner {
        Some(o) if store.cc_session(o).ok().flatten().is_some() => (
            Some(o.to_string()),
            store.cc_node_file(o, "").ok().flatten(),
        ),
        _ => (None, None),
    };

    let generated_at = store.now().ok()?;

    Some(TaskReceipt {
        task_id: task.id,
        generated_at,
        owner: owner.map(str::to_string),
        claimed_at: Some(claimed_at.to_string()),
        closed_at,
        branch,
        repo_path: Some(repo_path),
        commits,
        stat,
        session_id,
        transcript_path,
        edited: false,
        note: None,
    })
}

/// THE function `cli.rs` and `api.rs` call for `--regenerate`/`POST
/// .../regenerate` (spec D3, mirroring `update_task` above) — hoisted out of
/// both call sites (mesa task 920 defect 2) because they had drifted into
/// ~35 hand-duplicated lines apiece: the `local_path` validation, the
/// existing-receipt-wins claim-window fallback, the `generate` call and the
/// `put`. `CLAUDE.md`'s "CLI and API share `core` and never diverge"
/// invariant means that duplication was itself the bug waiting to happen —
/// exactly the mechanism that let defect 1 below go unfixed on one call site
/// while looking fixed on the other.
///
/// Regeneration recomputes the MACHINE fields (commits, stat, branch,
/// session/transcript) and must preserve the HUMAN ones (`note`): the
/// machine owns everything `generate` computes fresh from git/cc, the human
/// owns `note`, and recomputing the former must never silently discard the
/// latter (spec D6, "generated fields are not write-only" — before this fix,
/// `generate` always returned `note: None, edited: false`, and `put` is
/// INSERT OR REPLACE, so a `--regenerate` on a hand-annotated receipt threw
/// the annotation away with no warning). `edited` describes the note, not
/// the receipt as a whole, so it survives with it rather than being reset.
pub fn regenerate(store: &mut Store, id: i64) -> Result<TaskReceipt> {
    let task = store.get_task(id)?;
    let project = store.get_project(task.project_id)?;
    if project.local_path.is_none() {
        // Named explicitly rather than left to `generate`'s silent `None`
        // (which the automatic close-time path relies on to degrade
        // quietly) — an explicit regenerate call is a request that deserves
        // a reason when it can't be honoured.
        return Err(Error::Validation(format!(
            "project {} has no local_path bound; \
             a receipt needs a repo to read commits from \
             (see `mesa project update --path <dir>`)",
            task.project_id
        )));
    }
    let existing = store.get_task_receipt(id)?;
    // An existing receipt's claim window wins over the task's live one,
    // because closing the task is exactly what clears `Task::owner`/
    // `claimed_at` — the task's own claim is already gone by the time
    // anyone can call `regenerate` on an already-closed task.
    let owner = existing
        .as_ref()
        .and_then(|r| r.owner.clone())
        .or_else(|| task.owner.clone());
    let claimed_at = existing
        .as_ref()
        .and_then(|r| r.claimed_at.clone())
        .or_else(|| task.claimed_at.clone())
        .ok_or_else(|| {
            Error::Validation(format!(
                "task {id} has no claim to regenerate a receipt from \
                 (never claimed, and no existing receipt records one)"
            ))
        })?;
    let mut generated = generate(store, &task, owner.as_deref(), Some(&claimed_at))
        .ok_or_else(|| Error::Validation(format!("could not generate a receipt for task {id}")))?;
    // Defect 1 fix (D6): carry the human's note across regeneration instead
    // of letting `generate`'s fresh `note: None, edited: false` blow it away
    // on the `put_task_receipt` below.
    if let Some(existing) = existing {
        generated.note = existing.note;
        generated.edited = generated.note.is_some();
    }
    store.put_task_receipt(&generated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::store::TaskPatch;
    use crate::core::types::Priority;
    use std::process::{Command, Stdio};

    /// Same idiom as `git.rs`'s `synthetic_history_repo`: a throwaway repo
    /// with one commit, so `generate`'s git calls have real history to read
    /// instead of stubbing `core::git` (which nothing in this codebase does
    /// — every git-backed test spins up a real repo). Mesa's own db lives
    /// inside the same directory as an untracked file, which `git log`
    /// (history, not working-tree status) never sees.
    fn synthetic_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("a.txt"), "line one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "root commit"]);
        dir
    }

    /// A store whose one project's `local_path` is `dir` — `dir` is passed
    /// straight to `create_project` rather than bound afterward, since
    /// `create_project` already takes `local_path` directly.
    fn store_with_project_at(dir: &std::path::Path) -> (Store, i64) {
        let mut store = Store::open(&dir.join("mesa.db")).unwrap();
        let project = store
            .create_project("p", None, None, Some(dir.to_str().unwrap()), None)
            .unwrap();
        (store, project.id)
    }

    #[test]
    fn update_task_generates_a_receipt_on_close_of_a_claimed_task() {
        let repo = synthetic_repo();
        let (mut store, project_id) = store_with_project_at(repo.path());
        let task = store
            .create_task(
                project_id,
                "do the thing",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        // `claim_task` moves the task into `in_progress` and stamps
        // `owner`/`claimed_at` itself — no separate status transition needed.
        store.claim_task(task.id, "session_abc", false).unwrap();

        let after = update_task(
            &mut store,
            task.id,
            &TaskPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.status, Status::Done);
        // The claim is cleared on the very row the receipt is about (D1).
        assert!(after.owner.is_none());

        let receipt = store.get_task_receipt(task.id).unwrap().unwrap();
        assert_eq!(receipt.task_id, task.id);
        assert_eq!(receipt.owner.as_deref(), Some("session_abc"));
        assert!(!receipt.edited);
        assert!(receipt.branch.is_some());
        assert_eq!(receipt.repo_path.as_deref(), repo.path().to_str());
        // `session_abc` is not a `cc_sessions` UUID (D5): never resolves.
        assert!(receipt.session_id.is_none());
        assert!(receipt.transcript_path.is_none());
    }

    #[test]
    fn update_task_writes_no_receipt_without_a_prior_claim() {
        let repo = synthetic_repo();
        let (mut store, project_id) = store_with_project_at(repo.path());
        let task = store
            .create_task(
                project_id,
                "unclaimed task",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        update_task(
            &mut store,
            task.id,
            &TaskPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(store.get_task_receipt(task.id).unwrap().is_none());
    }

    #[test]
    fn update_task_writes_no_receipt_for_a_non_closing_edit() {
        let repo = synthetic_repo();
        let (mut store, project_id) = store_with_project_at(repo.path());
        let task = store
            .create_task(
                project_id,
                "task",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        store.claim_task(task.id, "session_abc", false).unwrap();
        update_task(
            &mut store,
            task.id,
            &TaskPatch {
                priority: Some(Priority::High),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(store.get_task_receipt(task.id).unwrap().is_none());
    }

    #[test]
    fn generate_returns_none_without_a_local_path() {
        let db_dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&db_dir.path().join("mesa.db")).unwrap();
        // A project with no repo bound at all — no `local_path`.
        let project = store.create_project("p", None, None, None, None).unwrap();
        let task = store
            .create_task(
                project.id,
                "task",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let task = store
            .update_task(
                task.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            generate(
                &store,
                &task,
                Some("session_abc"),
                Some("2024-01-01 00:00:00")
            )
            .is_none()
        );
    }

    /// Regression test for mesa task 920 defect 1: `regenerate` must not let
    /// the freshly-`generate`d `note: None, edited: false` overwrite a
    /// hand-written note via `put_task_receipt`'s INSERT OR REPLACE. Against
    /// the pre-fix code — `generate` followed directly by `put_task_receipt`
    /// with no preservation step — this fails because `note`/`edited` come
    /// back cleared; confirmed by running it against that code before this
    /// commit (`git stash` the `regenerate` fix, `cargo test
    /// regenerate_preserves_a_hand_written_note`, observe the assertion
    /// failure, `git stash pop`).
    #[test]
    fn regenerate_preserves_a_hand_written_note() {
        let repo = synthetic_repo();
        let (mut store, project_id) = store_with_project_at(repo.path());
        let task = store
            .create_task(
                project_id,
                "do the thing",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        store.claim_task(task.id, "session_abc", false).unwrap();
        update_task(
            &mut store,
            task.id,
            &TaskPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
        let annotated = store
            .update_task_receipt(
                task.id,
                &crate::core::store::ReceiptPatch {
                    note: Some(Some("verified manually".to_string())),
                },
            )
            .unwrap();
        assert!(annotated.edited);

        let regenerated = regenerate(&mut store, task.id).unwrap();
        assert_eq!(regenerated.note.as_deref(), Some("verified manually"));
        assert!(regenerated.edited);
        // The machine fields still got recomputed — this isn't a no-op.
        assert!(regenerated.branch.is_some());
    }

    #[test]
    fn regenerate_without_a_note_leaves_it_unset() {
        let repo = synthetic_repo();
        let (mut store, project_id) = store_with_project_at(repo.path());
        let task = store
            .create_task(
                project_id,
                "do the thing",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        store.claim_task(task.id, "session_abc", false).unwrap();
        update_task(
            &mut store,
            task.id,
            &TaskPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();

        let regenerated = regenerate(&mut store, task.id).unwrap();
        assert!(regenerated.note.is_none());
        assert!(!regenerated.edited);
    }

    #[test]
    fn regenerate_without_any_claim_is_a_validation_error() {
        let repo = synthetic_repo();
        let (mut store, project_id) = store_with_project_at(repo.path());
        let task = store
            .create_task(
                project_id,
                "never claimed",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();

        let err = regenerate(&mut store, task.id).unwrap_err();
        assert!(matches!(err, crate::core::store::Error::Validation(_)));
    }

    #[test]
    fn regenerate_without_a_local_path_names_the_reason() {
        let db_dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&db_dir.path().join("mesa.db")).unwrap();
        // No `local_path` bound at all.
        let project = store.create_project("p", None, None, None, None).unwrap();
        let task = store
            .create_task(
                project.id,
                "task",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();

        let err = regenerate(&mut store, task.id).unwrap_err();
        match err {
            crate::core::store::Error::Validation(msg) => {
                assert!(msg.contains("local_path"), "message was: {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }
}
