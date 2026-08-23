//! Set / unset the machine-wide HTTP + HTTPS proxy so browsers route
//! through the local MITM listener.
//!
//! Each platform has its own dance. All are best-effort — a failure
//! logs and returns `Err`, but the caller in `mitm/mod.rs` swallows it
//! so the listener still runs (a self-configured browser can still be
//! pointed at 127.0.0.1:47443 manually).
//!
//! The three implementations are separated by cfg so the crate compiles
//! cleanly on each target without pulling in the other platforms' deps.

use anyhow::Result;

/// Hosts / patterns the system should never send through our proxy.
/// Includes our own backend so the agent's ingest loop doesn't
/// self-loop, plus the standard localhost / private-net escapes.
const BYPASS_HOSTS: &[&str] = &[
    "localhost",
    "127.0.0.1",
    "*.local",
    // Corporate + partner infra — never through the DLP proxy.
    "*.wellnessextract.com",
    "*.rudrans.com",
    "*.supabase.co",
    "*.livekit.cloud",
];

// ============================ macOS ============================

#[cfg(target_os = "macos")]
pub fn set(addr: &str) -> Result<()> {
    // addr is "127.0.0.1:47443" — split into host + port for
    // networksetup which takes them as separate args.
    let (host, port) = split_addr(addr)?;
    for service in list_network_services()? {
        run_networksetup(&["-setwebproxy", &service, &host, &port])?;
        run_networksetup(&["-setsecurewebproxy", &service, &host, &port])?;
        // Bypass list is a single args-array passed to
        // -setproxybypassdomains.
        let mut args = vec!["-setproxybypassdomains", service.as_str()];
        args.extend(BYPASS_HOSTS.iter().copied());
        run_networksetup(&args)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn unset() -> Result<()> {
    for service in list_network_services().unwrap_or_default() {
        // Errors here are non-fatal — the service may have already been
        // reset by a network change. Log via debug only.
        let _ = run_networksetup(&["-setwebproxystate", &service, "off"]);
        let _ = run_networksetup(&["-setsecurewebproxystate", &service, "off"]);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn list_network_services() -> Result<Vec<String>> {
    let out = std::process::Command::new("/usr/sbin/networksetup")
        .arg("-listallnetworkservices")
        .output()?;
    if !out.status.success() {
        anyhow::bail!("networksetup -listallnetworkservices exit {:?}", out.status.code());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .skip(1) // first line is a header note about an asterisk prefix
        .filter(|l| !l.trim().is_empty() && !l.starts_with('*'))
        .map(str::to_string)
        .collect())
}

#[cfg(target_os = "macos")]
fn run_networksetup(args: &[&str]) -> Result<()> {
    let out = std::process::Command::new("/usr/sbin/networksetup")
        .args(args)
        .output()?;
    if !out.status.success() {
        anyhow::bail!(
            "networksetup {:?} failed (exit {:?}): {}",
            args,
            out.status.code(),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    Ok(())
}

// ============================ Windows ============================

#[cfg(target_os = "windows")]
pub fn set(addr: &str) -> Result<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (settings, _) = hkcu.create_subkey(
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
    )?;
    settings.set_value("ProxyEnable", &1u32)?;
    settings.set_value("ProxyServer", &addr.to_string())?;
    settings.set_value("ProxyOverride", &BYPASS_HOSTS.join(";"))?;
    // Tell running browsers / WinInet clients to reload the setting
    // immediately (otherwise they cache the old value until relaunch).
    let _ = notify_settings_changed();
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn unset() -> Result<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        KEY_SET_VALUE,
    )?;
    let _ = settings.set_value("ProxyEnable", &0u32);
    let _ = notify_settings_changed();
    Ok(())
}

#[cfg(target_os = "windows")]
fn notify_settings_changed() -> Result<()> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let param = "Internet Settings\0".encode_utf16().collect::<Vec<u16>>();
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(param.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            2000,
            None,
        );
    }
    Ok(())
}

// ============================ Linux ============================

#[cfg(target_os = "linux")]
pub fn set(addr: &str) -> Result<()> {
    let (host, port) = split_addr(addr)?;
    // GNOME (via GSettings). Runs per-user; on non-GNOME desktops this
    // is a no-op and returns non-zero — we swallow that.
    let _ = run("gsettings", &["set", "org.gnome.system.proxy", "mode", "manual"]);
    let _ = run("gsettings", &["set", "org.gnome.system.proxy.http", "host", &host]);
    let _ = run("gsettings", &["set", "org.gnome.system.proxy.http", "port", &port]);
    let _ = run("gsettings", &["set", "org.gnome.system.proxy.https", "host", &host]);
    let _ = run("gsettings", &["set", "org.gnome.system.proxy.https", "port", &port]);
    let ignore = format!("[{}]", BYPASS_HOSTS.iter()
        .map(|h| format!("'{h}'")).collect::<Vec<_>>().join(", "));
    let _ = run("gsettings", &["set", "org.gnome.system.proxy", "ignore-hosts", &ignore]);
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn unset() -> Result<()> {
    let _ = run("gsettings", &["set", "org.gnome.system.proxy", "mode", "none"]);
    Ok(())
}

#[cfg(target_os = "linux")]
fn run(cmd: &str, args: &[&str]) -> Result<()> {
    let out = std::process::Command::new(cmd).args(args).output()?;
    if !out.status.success() {
        anyhow::bail!("{cmd} {args:?} exit {:?}", out.status.code());
    }
    Ok(())
}

// ============================ shared ============================

#[allow(dead_code)]
fn split_addr(addr: &str) -> Result<(String, String)> {
    let (h, p) = addr
        .rsplit_once(':')
        .ok_or_else(|| anyhow::anyhow!("addr missing port: {addr}"))?;
    Ok((h.to_string(), p.to_string()))
}
