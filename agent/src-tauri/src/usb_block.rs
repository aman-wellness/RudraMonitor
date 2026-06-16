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
// **Action**: spawn diskutil / mountvol as a child process. We don't try to
// keep handles or watch for re-attach — every 5 s reconcile just enumerates
// what's mounted now and unmounts whatever shouldn't be.
//
// Edge case — agent's own external boot/storage disk: we never unmount
// `Macintosh HD` (the boot volume; dlp::macos_drives already filters it out)
// and on Windows we leave `C:` alone (drive_type != DRIVE_REMOVABLE for fixed
// disks). The user can still allowlist their laptop via the per-agent toggle
// if they need to use external storage.

use std::collections::HashSet;
use std::path::PathBuf;

use crate::dlp::{list_removable, RemovableDrive};

/// Set of mount points that have already been ejected this session. Prevents
/// us from repeatedly trying to unmount a stuck/locked volume every 5 s — if
/// the first unmount fails, the user probably has a file open and we'll just
/// log it once. Reset on agent restart so the policy reapplies if needed.
#[derive(Default)]
pub struct UsbBlocker {
    seen: HashSet<PathBuf>,
}

impl UsbBlocker {
    pub fn new() -> Self { Self::default() }

    /// Single reconcile pass. Call every 5 s from the spawn_usb_block_loop
    /// in lib.rs. `enabled` comes from `state.settings.removable_disks_blocked`.
    /// Returns the list of newly-blocked mount points so the caller can log
    /// activity_logs rows (one per block event).
    pub fn reconcile(&mut self, enabled: bool) -> Vec<RemovableDrive> {
        // Currently mounted removable volumes. dlp::list_removable already
        // filters the boot volume and network mounts.
        let drives = list_removable();
        let live: HashSet<PathBuf> = drives.iter().map(|d| d.mount_point.clone()).collect();

        // Forget mount points that are no longer present (user pulled them
        // out) so a re-insert of the same USB stick triggers another unmount.
        self.seen.retain(|p| live.contains(p));

        if !enabled {
            // Policy says: this agent is allowlisted. Don't touch anything,
            // but clear any stale state so toggling the policy back ON
            // re-ejects whatever's currently plugged in.
            self.seen.clear();
            return Vec::new();
        }

        let mut newly_blocked = Vec::new();
        for d in drives {
            if self.seen.contains(&d.mount_point) { continue; }
            if try_unmount(&d.mount_point) {
                log::info!(
                    "usb_block: ejected {} ({})",
                    d.mount_point.display(),
                    d.label
                );
                self.seen.insert(d.mount_point.clone());
                newly_blocked.push(d);
            } else {
                log::warn!(
                    "usb_block: unmount failed for {} ({}); will retry on next tick",
                    d.mount_point.display(),
                    d.label
                );
                // Don't add to seen — retry next tick. Eventually either the
                // user closes the file holding it open, or they pull the
                // drive physically.
            }
        }
        newly_blocked
    }
}

#[cfg(target_os = "macos")]
fn try_unmount(mount_point: &std::path::Path) -> bool {
    // `diskutil unmount force` — works even if a Finder window has the volume
    // open. Safer than `diskutil eject` which can refuse on Time Machine
    // disks; unmount is enough to make the volume disappear from Finder.
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

#[cfg(target_os = "windows")]
fn try_unmount(mount_point: &std::path::Path) -> bool {
    // Windows mount_point is the drive root like "E:\". `mountvol E: /D`
    // removes the drive letter mapping, which dismounts the volume.
    // Requires admin elevation on most systems — if the agent isn't elevated,
    // fall back to the user-level PowerShell Shell.Application Eject verb,
    // which works without admin but only on devices that advertise eject
    // capability (most USB sticks do).
    let drive = mount_point.to_string_lossy().to_string();
    let drive_letter = drive.chars().next().map(|c| format!("{c}:")).unwrap_or_default();
    if drive_letter.is_empty() { return false; }

    // First attempt: mountvol /D — clean unmount if we have admin.
    let mv = std::process::Command::new("mountvol")
        .arg(&drive_letter)
        .arg("/D")
        .output();
    if let Ok(o) = mv {
        if o.status.success() { return true; }
    }

    // Fallback: PowerShell Shell.Application Eject (user-level, works for USB
    // mass-storage class devices). Drive letter without trailing slash.
    let ps_cmd = format!(
        "$sh = New-Object -ComObject Shell.Application; \
         $vol = $sh.Namespace(17).ParseName('{}'); \
         if ($vol) {{ $vol.InvokeVerb('Eject') }}",
        drive_letter
    );
    let ps = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
        .output();
    match ps {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn try_unmount(mount_point: &std::path::Path) -> bool {
    // umount needs root on most distros, but `udisksctl unmount` works
    // user-level if the volume was mounted via udisks (which is how all
    // desktop environments do it). Try udisksctl first, fall back to umount.
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
    match umount {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}
