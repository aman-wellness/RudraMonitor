// Self-installing OS autostart.
//
// Called once at agent startup. Idempotent — if the OS-level autostart
// hook is already in place, it's a no-op. Re-runs on every launch so
// uninstalls / manual deletes / file-system tampering self-heal on the
// next agent restart.
//
// **macOS** — writes `~/Library/LaunchAgents/com.wellnessextract.agent.plist`
// with `RunAtLoad=true` + `KeepAlive=true`. KeepAlive is what makes launchd
// respawn the agent if the user kills it from Activity Monitor; without
// KeepAlive, the in-process guardian still respawns it within ~5s, but
// KeepAlive closes the gap to <1s and survives the guardian being killed
// too. Bootstrapped via `launchctl bootstrap gui/<uid>` — that's the
// per-user launchd domain that's accessible without admin rights.
//
// **Windows** — registers a Scheduled Task `WellnessExtractAgent` via
// schtasks.exe with:
//   - Trigger: at logon of any user (`/sc onlogon`)
//   - Restart on failure: 1-minute delay, up to 999 attempts
//   - Run as the interactive user (no admin needed)
// A Scheduled Task is the only persistence mechanism on Windows that
// (a) works without admin elevation, (b) survives reboot, and (c) has
// built-in restart-on-failure. The HKCU Run key only fires on login,
// not on failure; a Windows Service requires admin install. The
// in-process guardian fills the gap when a logged-in user kills the
// agent mid-session.
//
// **Linux** — writes `~/.config/autostart/com.rudrans.agent.desktop`
// (XDG desktop file, picked up by every major DE).

use std::path::PathBuf;

/// Force-register OS autostart for the current agent binary. Safe to
/// call on every startup — does the minimum work needed to bring the
/// OS state in line with our intent.
pub fn ensure_installed(exe_path: &std::path::Path) {
    if let Err(e) = ensure_installed_impl(exe_path) {
        // Log but don't fail the agent — autostart is a "should" not a
        // "must". The guardian still keeps the process alive within
        // the current session; this only matters at next reboot.
        log::warn!("service_install: skipped — {e}");
    }
}

#[cfg(target_os = "macos")]
fn ensure_installed_impl(exe_path: &std::path::Path) -> std::io::Result<()> {
    let home = dirs::home_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir")
    })?;
    let dir = home.join("Library/LaunchAgents");
    std::fs::create_dir_all(&dir)?;
    let plist_path = dir.join("com.wellnessextract.agent.plist");

    let desired = build_macos_plist(exe_path);

    // Skip the launchctl bounce if the on-disk plist already matches
    // what we'd write. Avoids a spurious unload/load every launch
    // (which would kill ourselves on every restart — launchctl bootout
    // sends SIGTERM to the labeled job, and we ARE the labeled job).
    if let Ok(existing) = std::fs::read_to_string(&plist_path) {
        if existing == desired {
            return Ok(());
        }
    }
    std::fs::write(&plist_path, &desired)?;
    log::info!("service_install: wrote {}", plist_path.display());

    // Tell launchd about the new plist. We DON'T bootout-then-bootstrap
    // (that would terminate ourselves). Just bootstrap — if the label is
    // already registered, launchctl reports "already exists" and we
    // ignore it. The new plist takes effect at next login or boot.
    let uid_str = unsafe { libc::getuid() }.to_string();
    let domain = format!("gui/{uid_str}");
    let _ = std::process::Command::new("/bin/launchctl")
        .args(["bootstrap", &domain])
        .arg(&plist_path)
        .output();
    Ok(())
}

#[cfg(target_os = "macos")]
fn build_macos_plist(exe_path: &std::path::Path) -> String {
    // CFBundleExecutable would be cleaner but we want to point at the
    // exact binary the user launched — handles dev runs / multiple
    // .app copies / unusual install paths.
    let exe = exe_path.to_string_lossy().replace("&", "&amp;");
    let logs = dirs::home_dir()
        .map(|h| h.join("Library/Logs/WellnessExtractAgent"))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let _ = std::fs::create_dir_all(&logs);
    let out_log = logs.join("agent.out.log").to_string_lossy().replace("&", "&amp;");
    let err_log = logs.join("agent.err.log").to_string_lossy().replace("&", "&amp;");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wellnessextract.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>{out_log}</string>
  <key>StandardErrorPath</key><string>{err_log}</string>
</dict>
</plist>
"#
    )
}

#[cfg(target_os = "windows")]
fn ensure_installed_impl(exe_path: &std::path::Path) -> std::io::Result<()> {
    // Skip if --guardian — the guardian process is the agent's child and
    // shouldn't itself try to register a Scheduled Task pointing at the
    // guardian binary (which is the same binary, but the task should
    // launch the agent without the guardian arg).
    if std::env::args().any(|a| a == "--guardian") {
        return Ok(());
    }

    let task_name = "WellnessExtractAgent";
    let exe = exe_path.to_string_lossy().to_string();

    // Check whether the task already exists AND points at the same exe.
    // `schtasks /query /tn <name>` returns 0 if the task exists, 1 if not.
    // no_window flag: schtasks + powershell would otherwise pop a cmd
    // window on every agent launch and steal keyboard focus (customer
    // saw random cmd-flashes + dropped keystrokes on Windows).
    let mut query_cmd = std::process::Command::new("schtasks");
    query_cmd.args(["/query", "/tn", task_name, "/fo", "LIST", "/v"]);
    crate::win_proc::no_window(&mut query_cmd);
    let query = query_cmd.output();
    if let Ok(o) = &query {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout);
            // "Task To Run" line should contain our current exe path.
            // If it does, no-op; if not (e.g. agent moved to a new install
            // dir after auto-update), re-register.
            if s.contains(&exe) {
                return Ok(());
            }
        }
    }

    // (Re)create the task. /f overwrites any existing entry with the
    // same name. /sc onlogon = trigger on user login (any user). /rl
    // limited = standard user privileges (no admin needed). /it = run
    // only if user is logged on (matches our "tray app" model).
    let mut create_cmd = std::process::Command::new("schtasks");
    create_cmd.args(["/create", "/f", "/sc", "onlogon", "/rl", "limited", "/it",
                     "/tn", task_name,
                     "/tr", &format!("\"{exe}\"")]);
    crate::win_proc::no_window(&mut create_cmd);
    let create = create_cmd.output()?;
    if !create.status.success() {
        log::warn!(
            "service_install: schtasks /create failed: {}",
            String::from_utf8_lossy(&create.stderr).trim()
        );
        return Ok(());
    }

    // Harden the task: restart on failure (1 min delay, 999 attempts).
    // schtasks /create doesn't expose these flags directly — we have to
    // round-trip via /change with XML. Simplest path: edit the registered
    // task's XML in place via PowerShell's Set-ScheduledTask.
    let ps = format!(
        "$t = Get-ScheduledTask -TaskName '{task_name}' -ErrorAction SilentlyContinue; \
         if ($t) {{ \
           $t.Settings.RestartCount = 999; \
           $t.Settings.RestartInterval = 'PT1M'; \
           $t.Settings.DisallowStartIfOnBatteries = $false; \
           $t.Settings.StopIfGoingOnBatteries = $false; \
           Set-ScheduledTask -InputObject $t | Out-Null \
         }}"
    );
    let mut ps_cmd = std::process::Command::new("powershell");
    ps_cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
    crate::win_proc::no_window(&mut ps_cmd);
    let _ = ps_cmd.output();

    log::info!("service_install: registered Scheduled Task {task_name}");
    Ok(())
}

#[cfg(target_os = "linux")]
fn ensure_installed_impl(exe_path: &std::path::Path) -> std::io::Result<()> {
    let home = dirs::home_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir")
    })?;
    let dir = home.join(".config/autostart");
    std::fs::create_dir_all(&dir)?;
    let desktop_path = dir.join("com.rudrans.agent.desktop");

    let desired = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Rudrans Security Assistant\n\
         Exec={}\n\
         Hidden=false\n\
         NoDisplay=false\n\
         X-GNOME-Autostart-enabled=true\n",
        exe_path.display()
    );

    if let Ok(existing) = std::fs::read_to_string(&desktop_path) {
        if existing == desired {
            return Ok(());
        }
    }
    std::fs::write(&desktop_path, &desired)?;
    log::info!("service_install: wrote {}", desktop_path.display());
    Ok(())
}
