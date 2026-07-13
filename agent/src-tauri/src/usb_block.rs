// Removable-disk blocker. When the org policy says
// `removable_disks_blocked = true`, this module unmounts any newly-attached
// USB / external HDD / SD card within ~5 seconds of detection. The agent's
// own policy is server-driven (per-agent toggle in `agents` table), so
// allowlisting a specific agent — say the IT admin's laptop — is just one
// click in the dashboard.
//
// **Detection** reuses [`dlp::list_removable`] so we don't duplicate the
// already-debugged "is this volume actually removable?" heuristic
// (diskutil-on-mac, GetDriveType-on-win, /sys/block/$dev/removable-on-linux).
//
// **Eject**: when policy is ON, spawn diskutil / mountvol to unmount any
// newly-detected removable volume. Track its disk-ID so we can remount it
// later.
//
// **Auto-remount on policy OFF**: persisted across agent restarts via a
// tiny JSON file. The instant the admin toggles "block USB" OFF for this
// agent, the next reconcile pass remounts every disk we previously ejected —
// no manual user action needed. After a successful remount the disk-ID is
// removed from the persisted set.
//
// Edge case — agent's own external boot/storage disk: we never unmount
// `Macintosh HD` (dlp::macos_drives filters it out) and on Windows we leave
// `C:` alone (drive_type != DRIVE_REMOVABLE for fixed disks). The user can
// still allowlist their laptop via the per-agent toggle if they need to
// use external storage.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::dlp::{list_removable, RemovableDrive};

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
struct PersistedState {
    /// Disk identifiers we ejected (mac: "disk4s2", win: "E:", linux: "/dev/sdb1").
    /// Persisted to disk so an agent restart doesn't strand the user's USB.
    ejected_ids: HashSet<String>,
}

pub struct UsbBlocker {
    /// Set of mount points already ejected this session. Prevents repeated
    /// unmount attempts on a stuck/locked volume every 5 s.
    seen: HashSet<PathBuf>,
    /// Last value of `enabled` seen by reconcile — used to detect the
    /// ON → OFF transition that triggers auto-remount.
    last_enabled: Option<bool>,
    persisted: PersistedState,
    state_path: PathBuf,
}

impl UsbBlocker {
    pub fn new() -> Self {
        let dir = state_dir();
        let _ = std::fs::create_dir_all(&dir);
        let state_path = dir.join("usb-block-state.json");
        let persisted = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|s| serde_json::from_str::<PersistedState>(&s).ok())
            .unwrap_or_default();
        Self {
            seen: HashSet::new(),
            last_enabled: None,
            persisted,
            state_path,
        }
    }

    /// Single reconcile pass. Call every 5 s from spawn_usb_block_loop in
    /// lib.rs. Returns (newly_blocked, newly_remounted).
    pub fn reconcile(&mut self, enabled: bool) -> (Vec<RemovableDrive>, Vec<String>) {
        // Currently mounted removable volumes.
        let drives = list_removable();
        let live: HashSet<PathBuf> = drives.iter().map(|d| d.mount_point.clone()).collect();
        self.seen.retain(|p| live.contains(p));

        let mut newly_blocked = Vec::new();
        let mut newly_remounted = Vec::new();

        // Auto-remount on policy=false: try every persisted disk id every
        // tick. macOS / Windows / Linux all silently no-op when the disk
        // either isn't physically attached or is already mounted, so the
        // cost of retrying each tick is negligible. On success we drop the
        // id from the persisted set.
        if !enabled && !self.persisted.ejected_ids.is_empty() {
            let ids: Vec<String> = self.persisted.ejected_ids.iter().cloned().collect();
            for id in ids {
                if try_mount(&id) {
                    log::info!("usb_block: remounted {id} (policy off)");
                    self.persisted.ejected_ids.remove(&id);
                    newly_remounted.push(id);
                }
            }
            self.persist();
        }

        // Track policy transitions for log clarity.
        if self.last_enabled != Some(enabled) {
            log::info!(
                "usb_block: policy is now {} (was {:?})",
                if enabled { "BLOCK" } else { "ALLOW" },
                self.last_enabled
            );
            self.last_enabled = Some(enabled);
            if !enabled {
                // Don't carry "already-ejected this session" memory across a
                // policy flip — admin might re-enable and expect the same
                // volumes to be re-blocked.
                self.seen.clear();
            }
        }

        if !enabled {
            return (newly_blocked, newly_remounted);
        }

        for d in drives {
            if self.seen.contains(&d.mount_point) { continue; }
            let disk_id = resolve_disk_id(&d.mount_point);
            if try_unmount(&d.mount_point) {
                log::info!(
                    "usb_block: ejected {} ({}) id={}",
                    d.mount_point.display(),
                    d.label,
                    disk_id.as_deref().unwrap_or("?"),
                );
                self.seen.insert(d.mount_point.clone());
                if let Some(id) = disk_id {
                    self.persisted.ejected_ids.insert(id);
                }
                newly_blocked.push(d);
            } else {
                log::warn!(
                    "usb_block: unmount failed for {} ({}); will retry on next tick",
                    d.mount_point.display(),
                    d.label,
                );
            }
        }
        if !newly_blocked.is_empty() {
            self.persist();
        }
        (newly_blocked, newly_remounted)
    }

    fn persist(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.persisted) {
            let _ = std::fs::write(&self.state_path, s);
        }
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn try_unmount(mount_point: &std::path::Path) -> bool {
    let output = std::process::Command::new("/usr/sbin/diskutil")
        .args(["unmount", "force"])
        .arg(mount_point)
        .output();
    match output {
        Ok(o) => o.status.success(),
        Err(e) => {
            log::warn!("usb_block: diskutil spawn failed: {e}");
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn resolve_disk_id(mount_point: &std::path::Path) -> Option<String> {
    // `diskutil info <mount>` includes a line like:
    //     Device Identifier:         disk4s2
    let out = std::process::Command::new("/usr/sbin/diskutil")
        .arg("info")
        .arg(mount_point)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Device Identifier:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn try_mount(disk_id: &str) -> bool {
    let out = std::process::Command::new("/usr/sbin/diskutil")
        .arg("mount")
        .arg(disk_id)
        .output();
    matches!(out, Ok(ref o) if o.status.success())
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn try_unmount(mount_point: &std::path::Path) -> bool {
    let drive = mount_point.to_string_lossy().to_string();
    let drive_letter = drive.chars().next().map(|c| format!("{c}:")).unwrap_or_default();
    if drive_letter.is_empty() { return false; }

    // NB: crate::win_proc::no_window applies CREATE_NO_WINDOW so the child
    // process doesn't briefly pop a console. Without that flag, spawning
    // mountvol / powershell every 5 s (the usb_block loop cadence) makes
    // a cmd window flash on the user's desktop AND steals focus mid-
    // keystroke — customer symptom: "type hi nhi hota hai auto".
    let mut mv_cmd = std::process::Command::new("mountvol");
    mv_cmd.arg(&drive_letter).arg("/D");
    crate::win_proc::no_window(&mut mv_cmd);
    let mv = mv_cmd.output();
    if let Ok(o) = mv {
        if o.status.success() { return true; }
    }
    let ps_cmd = format!(
        "$sh = New-Object -ComObject Shell.Application; \
         $vol = $sh.Namespace(17).ParseName('{}'); \
         if ($vol) {{ $vol.InvokeVerb('Eject') }}",
        drive_letter
    );
    let mut ps_command = std::process::Command::new("powershell");
    ps_command.args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd]);
    crate::win_proc::no_window(&mut ps_command);
    let ps = ps_command.output();
    matches!(ps, Ok(ref o) if o.status.success())
}

#[cfg(target_os = "windows")]
fn resolve_disk_id(mount_point: &std::path::Path) -> Option<String> {
    // Use the drive letter itself as the id — Windows mountvol takes the
    // letter and an arbitrary mount-point GUID for re-mount. Simpler: we
    // remount by rescanning all volumes (handled inside try_mount).
    let drive = mount_point.to_string_lossy().to_string();
    drive.chars().next().map(|c| format!("{c}:"))
}

#[cfg(target_os = "windows")]
fn try_mount(_drive_letter: &str) -> bool {
    // On Windows, after `mountvol X: /D`, the volume is dismounted but the
    // underlying disk is still attached. The cleanest "remount everything"
    // is `mountvol /R` which rescans and re-mounts all volumes that lost
    // their assignment. Cheap enough to run once per remount attempt.
    let mut cmd = std::process::Command::new("mountvol");
    cmd.arg("/R");
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output();
    matches!(out, Ok(ref o) if o.status.success())
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn try_unmount(mount_point: &std::path::Path) -> bool {
    let uctl = std::process::Command::new("udisksctl")
        .args(["unmount", "-b"])
        .arg(mount_point)
        .output();
    if let Ok(o) = uctl {
        if o.status.success() { return true; }
    }
    let umount = std::process::Command::new("umount")
        .arg(mount_point)
        .output();
    matches!(umount, Ok(ref o) if o.status.success())
}

#[cfg(target_os = "linux")]
fn resolve_disk_id(mount_point: &std::path::Path) -> Option<String> {
    // findmnt -no SOURCE <mount> → /dev/sdb1
    let out = std::process::Command::new("findmnt")
        .args(["-no", "SOURCE"])
        .arg(mount_point)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let dev = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dev.is_empty() { None } else { Some(dev) }
}

#[cfg(target_os = "linux")]
fn try_mount(device: &str) -> bool {
    let out = std::process::Command::new("udisksctl")
        .args(["mount", "-b", device])
        .output();
    matches!(out, Ok(ref o) if o.status.success())
}

// ---------------------------------------------------------------------------
// State dir (mirrors wallpaper.rs)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn state_dir() -> PathBuf {
    dirs::cache_dir()
        .map(|d| d.join("com.rudrans.agent"))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[cfg(target_os = "windows")]
fn state_dir() -> PathBuf {
    dirs::data_local_dir()
        .map(|d| d.join("com.wellnessextract.agent"))
        .unwrap_or_else(|| PathBuf::from("C:\\Temp"))
}

#[cfg(target_os = "linux")]
fn state_dir() -> PathBuf {
    dirs::cache_dir()
        .map(|d| d.join("com.rudrans.agent"))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}
