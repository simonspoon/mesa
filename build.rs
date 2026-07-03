//! rust-embed's derive requires `frontend/dist` to exist at compile time,
//! even in debug builds (which read the folder from disk at runtime). The
//! folder is untracked frontend build output, so a fresh clone/worktree
//! doesn't have it — create it here so `cargo build`/`cargo test` work
//! without a manual `mkdir`.

use std::{env, fs, path::PathBuf};

fn main() {
    let dist = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("frontend/dist");
    fs::create_dir_all(&dist).expect("failed to create frontend/dist for rust-embed");
    // Re-run when the folder changes or goes missing: a deleted dist is
    // recreated, and a rebuilt frontend re-embeds in release builds.
    println!("cargo:rerun-if-changed=frontend/dist");
}
