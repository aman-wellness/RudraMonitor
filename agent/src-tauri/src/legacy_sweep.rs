//! One-shot cleanup of leftover bundles from prior agent identities.
//!
//! The agent's identity churned 2026-05 → 2026-06:
//!   v0.1.x        productName "TrackForce Agent" / bundle id `com.trackforce.agent`
//!   v0.2.x-v0.5.5 productName "Rudrans Agent"    (v0.2.33 → "Security Assistant";
//!                                                identifier `com.rudrans.agent`)
//!   v0.5.6+       identifier `com.wellnessextract.agent` (final, frozen)
//!
//! Each rename installed a NEW bundle without removing the previous one. On
//! customers who ran a v0.2.x installer months ago, `/Applications/` still
//! carries `Rudrans Agent.app` alongside the current `Security Assistant.app`,
//! `dpkg -l` shows `trackforce-agent` alongside `wellness-extract-agent`, and
//! Windows Add-or-Remove Programs lists three entries. Every subsequent
//! release makes it worse because the auto-updater upgrades ONE bundle
//! (the current identifier) and leaves the others alone.
//!
//! `run_once()` fires from `lib.rs::setup()` at agent boot, guarded by
//! `std::sync::Once`. Idempotent — subsequent boots are no-ops once the
//! stale artifacts are gone.
//!
//! FROZEN CONTRACT (see `.claude/memory/feedback_installer_identity.md`):
//! any future rename must FIRST add the outgoing identity to these arrays
//! and ship a release, only THEN change the identifier — otherwise the
//! same dual-install bug reappears.

use std::sync::Once;

static SWEEP_ONCE: Once = Once::new();

/// Idempotent legacy-artifact removal. Safe to call at every boot;
/// spawn-blocks briefly (msec-scale) so we call it from the async setup
/// hook without offloading.
pub fn run_once() {
    SWEEP_ONCE.call_once(|| {
        if let Err(e) = std::panic::catch_unwind(|| sweep()) {
            // Never abort startup because cleanup blew up — the sweep is
            // best-effort. Log and move on.
            log::warn!("legacy_sweep panicked: {:?}", e);
        }
    });
}

fn sweep() {
    #[cfg(target_os = "macos")]
    macos::sweep();

    #[cfg(target_os = "windows")]
    windows::sweep();

    #[cfg(target_os = "linux")]
    linux::sweep();

    // Remove the previous update(s) the auto-updater left on disk.
    purge_stale_update_downloads();
}

/// Delete the Tauri updater's leftover download directories.
///
/// Every auto-update extracts its installer into
/// `<TEMP>/<productName>-<version>-updater-<random>/` and NEVER cleans it up,
/// so each update leaves a ~40-60 MB folder behind and they pile up
/// indefinitely (customers saw many hundred MB of stale installers in
/// `%TEMP%`). This runs from `run_once()` at boot — which, after an update,
/// happens on the freshly-installed version's first launch — so by the time we
/// get here every such folder (including the one that just installed us) is
/// finished and safe to delete. Best-effort: a folder whose installer .exe is
/// still momentarily locked simply fails and is cleaned on the next boot.
fn purge_stale_update_downloads() {
    let tmp = std::env::temp_dir();
    let entries = match std::fs::read_dir(&tmp) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        // Tauri's updater temp dir is "<productName>-<version>-updater-<rand>".
        // "-updater-" is Tauri's own marker; the productName prefix scopes the
        // match to our app so we never touch anyone else's temp files.
        if name.starts_with("Security Assistant-") && name.contains("-updater-") {
            match std::fs::remove_dir_all(entry.path()) {
                Ok(()) => log::info!("cleanup: removed stale update download '{name}'"),
                Err(e) => log::debug!("cleanup: could not remove '{name}' (in use?): {e}"),
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::path::Path;
    use std::process::Command;

    /// Bundles installed under a prior productName. Do NOT include the
    /// current bundle — this is a delete list.
    const LEGACY_APPS: &[&str] = &[
        "/Applications/Rudrans Agent.app",
        "/Applications/TrackForce Agent.app",
    ];

    /// LaunchAgent plist basenames from prior identifiers. `com.rudrans.agent`
    /// is the CURRENT label the postinstall installs — do NOT include it
    /// here or every boot after a fresh install would wipe our own agent.
    const LEGACY_PLISTS: &[&str] = &[
        "com.trackforce.agent",
    ];

    pub fn sweep() {
        for legacy in LEGACY_APPS {
            if !Path::new(legacy).exists() {
                continue;
            }
            // Kill anything running out of the stale bundle before deletion.
            let _ = Command::new("/usr/bin/pkill").args(["-f", legacy]).output();
            match std::fs::remove_dir_all(legacy) {
                Ok(_) => log::info!("legacy_sweep: removed {legacy}"),
                Err(e) => log::warn!("legacy_sweep: rm {legacy} failed: {e}"),
            }
        }

        // Bootout + delete stale LaunchAgent plists. Need the console user's
        // UID for launchctl's gui/<uid>/<label> domain.
        let console_user = Command::new("/usr/bin/stat")
            .args(["-f%Su", "/dev/console"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "root");
        let uid = console_user.as_ref().and_then(|u| {
            Command::new("/usr/bin/id")
                .args(["-u", u])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
        });

        for label in LEGACY_PLISTS {
            let path = format!("/Library/LaunchAgents/{}.plist", label);
            if !Path::new(&path).exists() {
                continue;
            }
            if let Some(u) = uid.as_ref() {
                let _ = Command::new("/bin/launchctl")
                    .args(["bootout", &format!("gui/{}/{}", u, label)])
                    .output();
            }
            match std::fs::remove_file(&path) {
                Ok(_) => log::info!("legacy_sweep: removed {path}"),
                Err(e) => log::warn!("legacy_sweep: rm {path} failed: {e}"),
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::process::Command;

    /// Add-or-Remove-Programs DisplayName strings from prior productNames.
    /// Matched via `reg query /f <name> /d` against both HKCU and HKLM
    /// Uninstall roots. The current productName ("Security Assistant") is
    /// intentionally NOT in this list.
    const LEGACY_DISPLAY_NAMES: &[&str] = &[
        "Rudrans Agent",
        "TrackForce Agent",
    ];

    /// Scheduled-task names from prior installers. Current task is
    /// "WellnessExtractAgent" per service_install.rs.
    const LEGACY_TASK_NAMES: &[&str] = &[
        "RudransAgent",
        "TrackForceAgent",
    ];

    pub fn sweep() {
        for hive in ["HKCU", "HKLM"] {
            for name in LEGACY_DISPLAY_NAMES {
                purge_uninstall_key(hive, name, None);
            }
        }
        // Same-name-different-location sweep. NSIS installMode changed
        // in v0.7.3 from currentUser → perMachine (fix for the CA-
        // install popup). Machines that ran v0.7.0-v0.7.2 have an
        // Add-or-Remove-Programs entry under HKCU pointing at
        // %LOCALAPPDATA%\Programs\Security Assistant\, and the newer
        // per-machine install adds a SEPARATE entry under HKLM pointing
        // at C:\Program Files\Security Assistant\. Auto-update on the
        // perMachine path never touches the currentUser install, so
        // both coexist forever — two tray icons, two scheduled tasks,
        // two update loops racing.
        //
        // Purge any "Security Assistant" uninstall key whose
        // InstallLocation is NOT the directory the currently-running
        // exe lives in. This guarantees exactly ONE install survives
        // — the one we're running out of.
        let self_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
        if let Some(dir) = self_dir {
            let keep = normalize_path(&dir.to_string_lossy());
            for hive in ["HKCU", "HKLM"] {
                purge_uninstall_key(hive, "Security Assistant", Some(keep.clone()));
            }
        }

        for task in LEGACY_TASK_NAMES {
            let mut cmd = Command::new("schtasks");
            cmd.args(["/delete", "/tn", task, "/f"]);
            crate::win_proc::no_window(&mut cmd);
            let _ = cmd.output();
        }
    }

    fn normalize_path(p: &str) -> String {
        p.trim().trim_end_matches('\\').to_lowercase()
    }

    /// Enumerate `<hive>\Software\Microsoft\Windows\CurrentVersion\Uninstall`
    /// looking for a DisplayName match. For each hit, run the stored
    /// UninstallString silently, then hard-delete the key (in case the
    /// uninstaller left the key behind). All operations wrapped with
    /// CREATE_NO_WINDOW so nothing flashes on the user's desktop.
    /// If `keep_install_dir` is `Some(path)`, ONLY purge keys whose
    /// `InstallLocation` value does NOT match that path (case-insensitive,
    /// trailing-backslash stripped). Used for same-name sweeps where we
    /// need to preserve the currently-running install and remove sibling
    /// copies. `None` means "purge every match" — the historical behavior.
    fn purge_uninstall_key(hive: &str, display_name: &str, keep_install_dir: Option<String>) {
        let root = format!(
            "{hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
        );
        let mut probe = Command::new("reg");
        probe.args(["query", &root, "/s", "/f", display_name, "/d"]);
        crate::win_proc::no_window(&mut probe);
        let out = match probe.output() {
            Ok(o) if o.status.success() => o,
            _ => return,
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("HKEY_") {
                continue;
            }
            let key = trimmed.to_string();
            if let Some(keep) = keep_install_dir.as_ref() {
                let install_loc = read_reg_string(&key, "InstallLocation").map(|s| normalize_path(&s));
                if install_loc.as_deref() == Some(keep.as_str()) {
                    log::info!("legacy_sweep: keeping {key} (matches running install)");
                    continue;
                }
            }
            run_uninstall_string(&key);
            let mut del = Command::new("reg");
            del.args(["delete", &key, "/f"]);
            crate::win_proc::no_window(&mut del);
            let _ = del.output();
            log::info!("legacy_sweep: purged {key}");
        }
    }

    fn read_reg_string(key: &str, name: &str) -> Option<String> {
        let mut q = Command::new("reg");
        q.args(["query", key, "/v", name]);
        crate::win_proc::no_window(&mut q);
        let out = q.output().ok()?;
        if !out.status.success() { return None; }
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        stdout.lines()
            .find(|l| l.trim_start().starts_with(name))
            .and_then(|l| l.split("REG_SZ").nth(1))
            .map(|s| s.trim().trim_matches('"').to_string())
    }

    fn run_uninstall_string(key: &str) {
        let mut q = Command::new("reg");
        q.args(["query", key, "/v", "UninstallString"]);
        crate::win_proc::no_window(&mut q);
        let out = match q.output() {
            Ok(o) if o.status.success() => o,
            _ => return,
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        // "    UninstallString    REG_SZ    C:\Program Files\...\uninstall.exe"
        let uninst = stdout.lines()
            .find(|l| l.trim_start().starts_with("UninstallString"))
            .and_then(|l| l.split("REG_SZ").nth(1))
            .map(|s| s.trim().trim_matches('"').to_string());
        let Some(cmd_line) = uninst else { return; };
        // NSIS uninstallers accept `/S` for silent. MSI needs `/qn`. Try
        // both flags — the wrong one is a harmless no-op for the other.
        for extra in [&["/S"][..], &["/quiet"][..]] {
            let mut c = Command::new(&cmd_line);
            c.args(extra);
            crate::win_proc::no_window(&mut c);
            if c.status().is_ok() {
                break;
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::process::Command;

    /// Debian package names from prior identities. Current package is
    /// `wellness-extract-agent` (matches Cargo `name`).
    const LEGACY_PACKAGES: &[&str] = &[
        "trackforce-agent",
        "rudrans-agent",
    ];

    pub fn sweep() {
        for pkg in LEGACY_PACKAGES {
            // dpkg-query returns non-zero if the package isn't known —
            // check the exit status before invoking --purge (avoids the
            // "package not installed" noise on every boot).
            let installed = Command::new("dpkg-query")
                .args(["-W", "-f=${Status}", pkg])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("install ok installed"))
                .unwrap_or(false);
            if installed {
                // --purge needs root; if the agent isn't root, this fails
                // silently and the .deb postinst (agent/src-tauri/DEBIAN/postinst)
                // does the same purge next time apt runs.
                let _ = Command::new("dpkg")
                    .args(["--purge", "--force-depends", pkg])
                    .output();
                log::info!("legacy_sweep: purged package {pkg}");
            }
            // Also try to stop + disable any stale systemd unit named
            // <pkg>.service. Best-effort; failures on non-systemd hosts
            // (unlikely for our Ubuntu target) are silent.
            let unit = format!("{pkg}.service");
            let _ = Command::new("systemctl").args(["stop", &unit]).output();
            let _ = Command::new("systemctl").args(["disable", &unit]).output();
        }
    }
}
