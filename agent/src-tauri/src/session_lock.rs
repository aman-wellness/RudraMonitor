// Detect whether the interactive desktop is locked (Windows lock screen up,
// Ctrl-Alt-Del, or the "secure desktop" for a UAC prompt). Read by the
// screenshot / video / wallpaper loops so they SKIP work while the machine is
// locked — capturing the lock screen is not useful, and letting these loops
// tick every 30-60 s during lock keeps modern-standby laptops from ever
// reaching deep sleep, which on some Windows 11 + Intune fleets ends up
// escalating to a forced shutdown ("kuch time baad shutdown ho jaati hai").
//
// Implementation: `OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS)` on Windows
// returns NULL when the caller can't reach the interactive desktop — which is
// exactly the case while the screen is locked (the input desktop is Winlogon,
// not Default, and the current process lives on Default). Poll every 5 s to
// keep the state fresh without adding meaningful CPU load. macOS + Linux
// are no-ops for now — the shutdown-on-idle report is Windows-specific.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static LOCKED: AtomicBool = AtomicBool::new(false);

/// Cheap read from anywhere. Returns true if the session is currently locked.
pub fn is_locked() -> bool {
    LOCKED.load(Ordering::Relaxed)
}

/// Start the poller. Called once from setup after the Tauri app is up. Cheap
/// enough (one syscall every 5 s) that we don't gate it on target_os here —
/// the syscall itself is Windows-only, so the poller is a no-op elsewhere.
pub fn spawn_poller() {
    std::thread::spawn(|| loop {
        let locked = probe();
        let prev = LOCKED.swap(locked, Ordering::Relaxed);
        if prev != locked {
            if locked {
                log::info!("session_lock: locked — pausing capture loops");
            } else {
                log::info!("session_lock: unlocked — resuming capture loops");
            }
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}

#[cfg(target_os = "windows")]
fn probe() -> bool {
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS};
    unsafe {
        // OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS): asks for a handle to
        // whatever desktop currently receives user input. When the screen is
        // locked that desktop is Winlogon\Winlogon, which our process (running
        // on Winsta0\Default) is not allowed to touch, so the call returns an
        // invalid handle. When unlocked we get Default and the call succeeds.
        match OpenInputDesktop(0, false, DESKTOP_READOBJECTS) {
            Ok(h) => {
                let _ = CloseDesktop(h);
                false
            }
            Err(_) => true,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn probe() -> bool {
    // No cross-platform detection wired up yet. The shutdown-on-idle symptom
    // is a Windows-only report; treating other OSes as always-unlocked keeps
    // their capture cadence unchanged.
    false
}
