//! Attachment storage: pure path/format logic for task attachments, no DB
//! access (mirrors `hooks.rs`). `Store` owns the DB row (single write path);
//! this module owns where an attachment's bytes live on disk and how to
//! best-effort guess its content type from the filename.

use std::path::{Path, PathBuf};

/// Per-file size cap, enforced in exactly one place: `Store::create_attachment`.
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024; // 25 MiB

/// `MESA_ATTACHMENTS_DIR` if set and non-empty, else `attachments/` beside
/// the resolved database. An empty env var counts as unset (mirrors the
/// `MESA_DB` / `hooks_file()` convention: SQLite/fs treat `""` as "here",
/// which would silently misplace files).
pub fn attachments_dir() -> PathBuf {
    if let Ok(p) = std::env::var("MESA_ATTACHMENTS_DIR")
        && !p.is_empty()
    {
        return PathBuf::from(p);
    }
    let mut path = crate::core::default_db_path();
    path.set_file_name("attachments");
    path
}

/// Where one attachment's bytes live on disk. Derived, never stored in the
/// DB — one source of truth (the row), no path column to keep in sync.
/// `filename` is sanitized to its base name (`Path::file_name`) before
/// joining, closing path traversal via a hostile original filename
/// (`../../etc/passwd`).
pub fn attachment_path(task_id: i64, attachment_id: i64, filename: &str) -> PathBuf {
    let base = Path::new(filename)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".to_string());
    attachments_dir()
        .join(task_id.to_string())
        .join(format!("{attachment_id}-{base}"))
}

/// Extension-only content-type guess (no magic-byte sniffing — no new
/// dependency). Unknown/missing extension -> `None`; callers fall back to
/// "application/octet-stream" at response time, never store that fallback.
pub fn guess_content_type(filename: &str) -> Option<String> {
    let ext = Path::new(filename).extension()?.to_str()?.to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "zip" => "application/zip",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        _ => return None,
    };
    Some(mime.to_string())
}

// `attachments_dir()` reads the global MESA_ATTACHMENTS_DIR env var, and
// cargo runs tests in parallel — every test (here and in `store.rs`'s
// attachment tests) that points it at a temp dir must hold this lock for its
// whole body, or one test's dir leaks into another's read. `pub(crate)` so
// `store.rs`'s test module shares the same lock rather than racing a second,
// uncoordinated one (mirrors `cc.rs`'s `ENV_LOCK`, scoped crate-wide here
// since two files touch this particular env var).
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_path_sanitizes_traversal_and_layout() {
        let p = attachment_path(42, 7, "../../etc/passwd");
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "7-passwd");
        assert!(p.parent().unwrap().ends_with("attachments/42"));
    }

    #[test]
    fn guess_content_type_matches_known_extensions_case_insensitively() {
        assert_eq!(guess_content_type("a.png").as_deref(), Some("image/png"));
        assert_eq!(guess_content_type("A.PNG").as_deref(), Some("image/png"));
        assert_eq!(guess_content_type("a.unknownext"), None);
        assert_eq!(guess_content_type("noext"), None);
    }

    #[test]
    fn empty_attachments_dir_env_counts_as_unset() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("MESA_ATTACHMENTS_DIR", "") };
        let dir = attachments_dir();
        assert!(
            dir.ends_with("attachments"),
            "empty MESA_ATTACHMENTS_DIR must fall back to the default path, got {dir:?}"
        );
        unsafe { std::env::set_var("MESA_ATTACHMENTS_DIR", "/tmp/explicit-attachments") };
        assert_eq!(
            attachments_dir(),
            PathBuf::from("/tmp/explicit-attachments")
        );
        unsafe { std::env::remove_var("MESA_ATTACHMENTS_DIR") };
    }
}
