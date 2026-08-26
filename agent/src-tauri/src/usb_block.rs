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
        // Windows: the DURABLE block is the "Removable Storage Access" policy,
        // not unmounting. Unmount/eject is defeated by a simple replug. The
        // policy denies access at the OS level, but writing it requires the
        // agent to be ELEVATED (admin/SYSTEM). Re-assert every tick while
        // blocking so an employee who clears the key is re-blocked within 5s;
        // clear it once when the policy flips off. If the agent is not elevated
        // the write no-ops — warn once so the gap is visible in the log.
        #[cfg(target_os = "windows")]
        {
            // Idempotent: always reconcile the OS-level Group Policy
            // to the current desired state, on every tick. Prior versions
            // gated the OFF call behind `last_enabled == Some(true)`,
            // which meant a fresh agent process starting up with the OS
            // still carrying a previous session's Deny_All policy would
            // NEVER clear it — admin toggles OFF, agent memory has
            // last_enabled=None, condition fails, HKLM policy stays,
            // USB stays blocked. `apply_removable_storage_policy(false)`
            // is a no-op when the key isn't there, so calling it
            // unconditionally every tick is cheap and correct.
            apply_removable_storage_policy(enabled);
            if enabled && self.last_enabled != Some(true) && !usb_block_available() {
                log::warn!(
                    "usb_block: policy is ON but the agent is NOT elevated — the OS block \
                     cannot be applied and removable drives will remain usable. Install/run \
                     the agent as a service or with admin rights to enforce USB blocking."
                );
            }
        }

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

// Windows "Removable Storage Access" policy — the real, replug-proof block.
//
// This is written under HKLM (machine-wide, every user) and REQUIRES the agent
// to be running elevated (admin/SYSTEM). There is no non-admin path: the
// `...\Policies\...` subtree — HKCU included — is writable only by
// administrators by design, so a standard-user agent cannot durably block USB
// at all (its only non-admin option, eject, is undone by a replug). We set both
// the top-level "All Removable Storage classes: Deny all access" and the
// Removable Disks class, covering USB flash drives, external HDDs and SD cards.
// The write silently no-ops if the agent is not elevated; `usb_block_available()`
// reports that so the loop can log a clear warning.
//
// Effect applies to the NEXT device arrival, so pairing it with the eject below
// cuts off an already-mounted drive immediately; a replug is then denied.
#[cfg(target_os = "windows")]
fn apply_removable_storage_policy(deny: bool) {
    let val = if deny { "1" } else { "0" };
    let keys = [
        r"HKLM\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices",
        r"HKLM\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices\{53f5630d-b6bf-11d0-94f2-00a0c91efb8b}",
    ];
    for key in keys {
        let mut cmd = std::process::Command::new("reg");
        cmd.args(["add", key, "/v", "Deny_All", "/t", "REG_DWORD", "/d", val, "/f"]);
        crate::win_proc::no_window(&mut cmd);
        let _ = cmd.output(); // silently no-ops when the agent is not elevated
    }
}

/// True if this process can write HKLM policy (i.e. is elevated) — used to warn
/// the admin when USB blocking is toggled on but the agent can't enforce it.
#[cfg(target_os = "windows")]
fn usb_block_available() -> bool {
    // Probe: try to open the RemovableStorageDevices policy key for write via a
    // no-op `reg add` of the container key. Exit code 0 => we have access.
    let mut cmd = std::process::Command::new("reg");
    cmd.args([
        "add",
        r"HKLM\SOFTWARE\Policies\Microsoft\Windows\RemovableStorageDevices",
        "/f",
    ]);
    crate::win_proc::no_window(&mut cmd);
    matches!(cmd.output(), Ok(o) if o.status.success())
}

#[cfg(target_os = "windows")]
fn try_unmount(mount_point: &std::path::Path) -> bool {
    let drive = mount_point.to_string_lossy().to_string();
    let drive_letter = drive.chars().next().map(|c| format!("{c}:")).unwrap_or_default();
    if drive_letter.is_empty() { return false; }

    // `X:\` stops existing once the letter is detached — verify rather than
    // trusting the exit code.
    let gone = || !std::path::Path::new(&format!("{drive_letter}\\")).exists();

    // Detach the drive letter with `mountvol X: /D`. This cuts off access
    // immediately but is RECOVERABLE — the volume still exists, it only loses
    // its mount point, and unblock reassigns the letter from the GUID captured
    // in resolve_disk_id. Requires admin (per-user installs fail "Access is
    // denied"). no_window keeps mountvol from flashing a console / stealing
    // focus mid-keystroke (customer symptom: "type hi nhi hota hai auto").
    //
    // We deliberately DO NOT use the Shell "Eject" verb. Eject powers the media
    // down / removes it, which software cannot reverse — once ejected only a
    // physical replug brings the drive back. That was the root cause of "I
    // unblock the drive but it stays blocked": the block ejected the media and
    // nothing could remount it. Letter-detach keeps the block fully reversible.
    let mut mv_cmd = std::process::Command::new("mountvol");
    mv_cmd.arg(&drive_letter).arg("/D");
    crate::win_proc::no_window(&mut mv_cmd);
    match mv_cmd.output() {
        Ok(o) if o.status.success() && gone() => return true,
        Ok(o) if !o.status.success() => {
            log::warn!(
                "usb_block: `mountvol {drive_letter} /D` failed (agent may lack admin rights): {}",
                String::from_utf8_lossy(&o.stderr).trim(),
            );
        }
        _ => {}
    }

    log::warn!(
        "usb_block: {drive_letter} could not be detached — the drive is in use or the agent \
         lacks admin rights. The Deny_All policy still blocks new arrivals; run the agent \
         elevated for immediate cut-off. Will retry next tick.",
    );
    false
}

#[cfg(target_os = "windows")]
fn resolve_disk_id(mount_point: &std::path::Path) -> Option<String> {
    // Persist "LETTER|\\?\Volume{guid}\" so unblock can reassign the EXACT
    // volume. The GUID is captured now, while the letter still exists (block
    // happens right after). Fall back to letter-only when the GUID can't be
    // resolved — unblock then relies on a replug, which works because the
    // Deny_All policy is cleared on unblock anyway.
    let drive = mount_point.to_string_lossy().to_string();
    let letter = drive.chars().next().map(|c| format!("{c}:"))?;
    match volume_guid_for_letter(&letter) {
        Some(guid) => Some(format!("{letter}|{guid}")),
        None => Some(letter),
    }
}

/// Map a drive letter (e.g. "E:") to its stable volume GUID path
/// ("\\?\Volume{...}\") by parsing `mountvol`'s listing, which prints each GUID
/// path followed by its current mount point(s).
#[cfg(target_os = "windows")]
fn volume_guid_for_letter(letter: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("mountvol");
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let want = format!("{letter}\\"); // e.g. "E:\"
    let mut current_guid: Option<String> = None;
    for line in s.lines() {
        let t = line.trim();
        if t.starts_with(r"\\?\Volume{") {
            current_guid = Some(t.to_string());
        } else if t.eq_ignore_ascii_case(&want) {
            return current_guid;
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn try_mount(id: &str) -> bool {
    // `id` is "LETTER|\\?\Volume{guid}\" (captured at block time) or a legacy
    // "LETTER" with no GUID. Reassign the letter to the volume — the correct
    // inverse of `mountvol X: /D`.
    //
    // The old code ran `mountvol /R`, which does NOT remount anything: it only
    // deletes mount-point directories and registry settings for volumes no
    // longer in the system. That's why unblock never restored the drive.
    if let Some((letter, guid)) = id.split_once('|') {
        let mut cmd = std::process::Command::new("mountvol");
        cmd.arg(letter).arg(guid);
        crate::win_proc::no_window(&mut cmd);
        return matches!(cmd.output(), Ok(ref o) if o.status.success());
    }
    // Legacy id with no GUID captured (blocked by a pre-fix agent): we can't
    // deterministically reassign the letter. Deny_All is already cleared, so a
    // physical replug remounts it. Drop it from the tracked set so we don't
    // spin on it every tick.
    log::warn!(
        "usb_block: no volume GUID stored for {id} (blocked by an older agent build); \
         unblock now relies on a replug — the Deny_All policy is already off."
    );
    true
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
