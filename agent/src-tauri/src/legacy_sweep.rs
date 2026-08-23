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
                purge_uninstall_key(hive, name);
            }
        }
        for task in LEGACY_TASK_NAMES {
            let mut cmd = Command::new("schtasks");
            cmd.args(["/delete", "/tn", task, "/f"]);
            crate::win_proc::no_window(&mut cmd);
            let _ = cmd.output();
        }
    }

    /// Enumerate `<hive>\Software\Microsoft\Windows\CurrentVersion\Uninstall`
    /// looking for a DisplayName match. For each hit, run the stored
    /// UninstallString silently, then hard-delete the key (in case the
    /// uninstaller left the key behind). All operations wrapped with
    /// CREATE_NO_WINDOW so nothing flashes on the user's desktop.
    fn purge_uninstall_key(hive: &str, display_name: &str) {
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
        // `reg query /s` emits blocks like:
        //   HKEY_CURRENT_USER\Software\...\Uninstall\{SomeKey}
        //       DisplayName    REG_SZ    Rudrans Agent
        //
        // We scan for lines starting with HKEY_ (the key path) and split
        // to grab the fully-qualified key. Then for each key we probe
        // UninstallString and invoke it.
        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("HKEY_") {
                continue;
            }
            let key = trimmed.to_string();
            run_uninstall_string(&key);
            let mut del = Command::new("reg");
            del.args(["delete", &key, "/f"]);
            crate::win_proc::no_window(&mut del);
            let _ = del.output();
            log::info!("legacy_sweep: purged {key}");
        }
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
