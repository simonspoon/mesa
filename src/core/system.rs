//! The host the mesa server is running on: memory, CPU, disk, GPU, uptime.
//! Like `core::version` this reads EXTERNAL state only — nothing here touches
//! the mesa store, nothing is written, and the answer is **derived on every
//! read, never stored**. mesa often serves a machine nobody is sitting at, so
//! this is the one place that machine describes itself.
//!
//! [`snapshot`] is **infallible**: every value a platform may decline to
//! report is an `Option<T>`, and "could not determine" is `null` — never a
//! sentinel, never zero, never an error surfaced to the client (the
//! `get_project_version` posture, `{"version":null,…}`). A `null` therefore
//! means *this host did not say*, which is a different fact from a reading of
//! zero and must stay distinguishable in the UI.
//!
//! Two things cost real time and are handled deliberately:
//!
//! - **CPU utilisation needs two samples.** `sysinfo` reports a percentage by
//!   differencing two refreshes, so [`snapshot`] refreshes, sleeps
//!   [`sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`], and refreshes again. That makes
//!   it a ~200ms *blocking* call — the API handler runs it inside
//!   `spawn_blocking`; the CLI, which is one shot, calls it directly. The
//!   `System` is process-global so consecutive calls also see a real delta.
//! - **The GPU is a subprocess** (`system_profiler`, macOS only) and a slow
//!   one, so it is asked **once for the life of the process** and cached: the
//!   hardware does not change under a running server. Everything about it is
//!   best-effort — not a Mac, no binary, a non-zero exit or output mesa cannot
//!   parse are all `gpu: null`.

use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use crate::core::store::default_db_path;
use crate::core::types::{GpuInfo, SystemInfo};

/// The process-global sampler. CPU percentages are a difference between two
/// refreshes of the *same* `System`, so it has to outlive one call.
static SYS: OnceLock<Mutex<sysinfo::System>> = OnceLock::new();

/// The macOS hardware report mesa shells out to. `MESA_SYSTEM_PROFILER_BIN`
/// overrides it — the same test seam as `listen::auris_bin` and
/// `speech::kokoro_bin`, and how the GPU parse is tested against a stub.
fn system_profiler_bin() -> String {
    std::env::var("MESA_SYSTEM_PROFILER_BIN").unwrap_or_else(|_| "system_profiler".to_string())
}

/// The most `system_profiler` output mesa will read. A display report is a
/// few KiB; anything past this is not one (`version::FILE_CAP` precedent).
const PROFILER_CAP: usize = 512 * 1024;

/// A live reading of the host. See the module doc: blocking for roughly
/// [`sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`], and never an error.
pub fn snapshot() -> SystemInfo {
    let mutex = SYS.get_or_init(|| Mutex::new(sysinfo::System::new()));
    // A panicking caller must not poison the sampler for the rest of the
    // process — this is decoration, so a poisoned lock is taken anyway.
    let mut sys = mutex.lock().unwrap_or_else(|e| e.into_inner());

    sys.refresh_cpu_all();
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpus = sys.cpus();
    let cpu_model = cpus
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|b| !b.is_empty());

    let process_rss_bytes = sysinfo::get_current_pid().ok().and_then(|pid| {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), false);
        sys.process(pid).map(|p| p.memory())
    });

    let (disk_total_bytes, disk_free_bytes) = match disk_for(&default_db_path()) {
        Some((total, free)) => (Some(total), Some(free)),
        None => (None, None),
    };

    SystemInfo {
        ram_total_bytes: sys.total_memory(),
        ram_used_bytes: sys.used_memory(),
        swap_total_bytes: sys.total_swap(),
        swap_used_bytes: sys.used_swap(),
        cpu_model,
        cpu_cores: sysinfo::System::physical_core_count().map(|n| n as u32),
        cpu_logical: sys.cpus().len() as u32,
        cpu_usage_pct: f64::from(sys.global_cpu_usage()),
        cpu_per_core_pct: sys
            .cpus()
            .iter()
            .map(|c| f64::from(c.cpu_usage()))
            .collect(),
        load_average: load_average(),
        gpu: gpu().clone(),
        uptime_secs: sysinfo::System::uptime(),
        disk_total_bytes,
        disk_free_bytes,
        process_rss_bytes,
        os: sysinfo::System::long_os_version(),
        hostname: sysinfo::System::host_name(),
    }
}

/// The 1/5/15-minute load average, or `None` where the platform has no such
/// idea. Windows is the one mesa knows about: `sysinfo` answers three zeros
/// there, which would read as "an idle machine" rather than "not reported".
fn load_average() -> Option<[f64; 3]> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let avg = sysinfo::System::load_average();
    Some([avg.one, avg.five, avg.fifteen])
}

/// `(total, available)` bytes of the volume holding `path` — the mount point
/// that is the **longest** prefix of it, since `/` is a prefix of everything
/// and would otherwise win over the volume the file is actually on. `None`
/// when no mount point matches (which includes a platform that lists none).
fn disk_for(path: &Path) -> Option<(u64, u64)> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| (d.total_space(), d.available_space()))
}

/// The host's GPU, asked once and cached for the life of the process (see the
/// module doc). `None` off macOS and on every failure.
fn gpu() -> &'static Option<GpuInfo> {
    static GPU: OnceLock<Option<GpuInfo>> = OnceLock::new();
    GPU.get_or_init(read_gpu)
}

/// Runs `system_profiler SPDisplaysDataType -json` and reads the first
/// display adapter out of it. Every failure — not a Mac, a missing binary, a
/// non-zero exit, oversized or unparseable output — is `None`.
fn read_gpu() -> Option<GpuInfo> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new(system_profiler_bin())
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.len() > PROFILER_CAP {
        return None;
    }
    parse_gpu(&String::from_utf8_lossy(&out.stdout))
}

/// The first `SPDisplaysDataType` entry as a [`GpuInfo`]. Pure (text in,
/// `Option` out) so the contract is testable without a Mac.
///
/// The name is `sppci_model` and **not** `_name`: on this hardware `_name` is
/// a localization key (`kHW_IntelUHDGraphics630Item`), so it is only the last
/// resort. VRAM is a human string ("1536 MB", "8 GB") under one of three
/// keys depending on the adapter, and is simply absent on Apple silicon,
/// where the GPU shares system memory — `vram_bytes: null` there.
fn parse_gpu(text: &str) -> Option<GpuInfo> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let card = v.get("SPDisplaysDataType")?.as_array()?.first()?;
    let name = ["sppci_model", "_name"]
        .iter()
        .find_map(|k| card.get(*k)?.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let vram_bytes = ["_spdisplays_vram", "spdisplays_vram", "sppci_vram"]
        .iter()
        .find_map(|k| card.get(*k)?.as_str())
        .and_then(parse_vram);
    GpuInfo {
        name,
        vram_bytes,
        // Real GPU utilisation on macOS needs privileged `powermetrics`
        // (mesa task 1093 put that out of scope), so this is always `null`
        // rather than a number mesa cannot stand behind.
        usage_pct: None,
    }
    .into()
}

/// `"1536 MB"` / `"8 GB"` as bytes. Anything else is `None`.
fn parse_vram(text: &str) -> Option<u64> {
    let (n, unit) = text.trim().split_once(' ')?;
    let n: u64 = n.trim().parse().ok()?;
    let scale = match unit.trim().to_ascii_uppercase().as_str() {
        "MB" => 1024 * 1024,
        "GB" => 1024 * 1024 * 1024,
        _ => return None,
    };
    n.checked_mul(scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reports_plausible_memory_and_cores() {
        let s = snapshot();
        assert!(s.ram_total_bytes > 0, "no total RAM reported");
        assert!(s.ram_used_bytes > 0, "no used RAM reported");
        assert!(s.ram_used_bytes <= s.ram_total_bytes);
        assert!(s.cpu_logical >= 1, "no logical cores reported");
        assert_eq!(s.cpu_per_core_pct.len(), s.cpu_logical as usize);
        assert!(s.cpu_usage_pct >= 0.0);
    }

    #[test]
    fn snapshot_is_repeatable() {
        // The sampler is process-global; a second call must not deadlock or
        // change shape.
        assert_eq!(snapshot().cpu_logical, snapshot().cpu_logical);
    }

    #[test]
    fn gpu_name_prefers_the_model_over_the_localization_key() {
        let text = r#"{"SPDisplaysDataType":[{"_name":"kHW_IntelUHDGraphics630Item",
            "_spdisplays_vram":"1536 MB","sppci_model":"Intel UHD Graphics 630"}]}"#;
        let got = parse_gpu(text).unwrap();
        assert_eq!(got.name, "Intel UHD Graphics 630");
        assert_eq!(got.vram_bytes, Some(1536 * 1024 * 1024));
        assert_eq!(got.usage_pct, None);
    }

    #[test]
    fn gpu_falls_back_to_the_name_key() {
        let text = r#"{"SPDisplaysDataType":[{"_name":"Apple M1 Pro"}]}"#;
        let got = parse_gpu(text).unwrap();
        assert_eq!(got.name, "Apple M1 Pro");
        // Apple silicon shares system memory and reports no VRAM at all.
        assert_eq!(got.vram_bytes, None);
    }

    #[test]
    fn gpu_first_card_wins() {
        let text = r#"{"SPDisplaysDataType":[{"sppci_model":"one"},{"sppci_model":"two"}]}"#;
        assert_eq!(parse_gpu(text).unwrap().name, "one");
    }

    #[test]
    fn gpu_malformed_or_empty_is_none() {
        assert_eq!(parse_gpu("{not json"), None);
        assert_eq!(parse_gpu(r#"{"SPDisplaysDataType":[]}"#), None);
        assert_eq!(parse_gpu(r#"{"other":[{"sppci_model":"x"}]}"#), None);
        assert_eq!(
            parse_gpu(r#"{"SPDisplaysDataType":[{"sppci_model":""}]}"#),
            None
        );
    }

    #[test]
    fn vram_units() {
        assert_eq!(parse_vram("1536 MB"), Some(1536 * 1024 * 1024));
        assert_eq!(parse_vram(" 8 GB "), Some(8 * 1024 * 1024 * 1024));
        assert_eq!(parse_vram("1536MB"), None);
        assert_eq!(parse_vram("lots"), None);
        assert_eq!(parse_vram("1536 KB"), None);
    }

    /// `MESA_SYSTEM_PROFILER_BIN` is a process-global env var and cargo runs
    /// tests in threads, so the stub cases share one test (the `listen.rs`
    /// precedent).
    #[test]
    fn gpu_reads_a_stub_binary_and_survives_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("profiler.sh");
        std::fs::write(
            &stub,
            "#!/bin/sh\necho '{\"SPDisplaysDataType\":[{\"sppci_model\":\"Stub GPU\",\"_spdisplays_vram\":\"2 GB\"}]}'\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        unsafe { std::env::set_var("MESA_SYSTEM_PROFILER_BIN", &stub) };
        let ok = read_gpu();
        unsafe { std::env::set_var("MESA_SYSTEM_PROFILER_BIN", "mesa-no-such-profiler-binary") };
        let missing = read_gpu();
        let failing = {
            let bad = dir.path().join("fails.sh");
            std::fs::write(&bad, "#!/bin/sh\nexit 3\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            unsafe { std::env::set_var("MESA_SYSTEM_PROFILER_BIN", &bad) };
            read_gpu()
        };
        unsafe { std::env::remove_var("MESA_SYSTEM_PROFILER_BIN") };

        assert_eq!(
            missing, None,
            "a missing binary must be None, never an error"
        );
        assert_eq!(failing, None, "a non-zero exit must be None");
        if cfg!(target_os = "macos") {
            let ok = ok.expect("the stub's output should have parsed");
            assert_eq!(ok.name, "Stub GPU");
            assert_eq!(ok.vram_bytes, Some(2 * 1024 * 1024 * 1024));
        } else {
            // Off macOS mesa never runs the binary at all.
            assert_eq!(ok, None);
        }
    }
}
