// Wraps the bundled `rustdesk` binary as a subprocess. GPL-3.0 "use"
// boundary — never linked, only spawned.
//
// RustDesk is a Flutter app, not a CLI tool. It doesn't print structured
// stdout, so the original "parse `Your ID is N` from stdout" approach
// silently timed out. The correct integration uses RustDesk's config
// files:
//
//   1. Pre-write RustDesk2.toml with our rendezvous + relay servers so
//      the binary uses OUR hbbs/hbbr container instead of the public one.
//   2. Spawn rustdesk. It registers with hbbs, generates a 9-digit ID
//      and a random password, and writes them to RustDesk.toml.
//   3. Poll RustDesk.toml until the `id` and `password` fields appear
//      (usually within 3-5s on a warm cache, up to 15s cold).
//   4. Return both to the caller; the dashboard surfaces them so the
//      admin enters them into their RustDesk client.
//
// Per-session password rotation (security improvement) lands in v0.6 —
// for now the agent's binary uses RustDesk's permanent password.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};
use tokio::time::timeout;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const READY_TIMEOUT_SECS: u64 = 20;

pub struct HostHandle {
    pub rustdesk_id: String,
    pub rustdesk_password: Option<String>,
    child: Option<Child>,
}

impl HostHandle {
    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            {
                if let Some(pid) = child.id() {
                    unsafe { libc::kill(pid as i32, libc::SIGTERM); }
                }
            }
            #[cfg(windows)]
            {
                let _ = child.start_kill();
            }
            let _ = timeout(Duration::from_secs(5), child.wait()).await;
            let _ = child.kill().await;
        }
        Ok(())
    }
}

fn bundled_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let resource_roots: Vec<PathBuf> = {
        #[cfg(target_os = "macos")]
        {
            let contents = exe_dir.parent()?;
            vec![
                contents.join("Resources").join("resources").join("rustdesk"),
                contents.join("Resources").join("rustdesk"),
                contents.join("Resources").join("_up_").join("resources").join("rustdesk"),
            ]
        }
        #[cfg(not(target_os = "macos"))]
        {
            vec![exe_dir.join("resources").join("rustdesk"), exe_dir.join("rustdesk")]
        }
    };

    #[cfg(target_os = "macos")]
    let rel = ["RustDesk.app/Contents/MacOS/RustDesk"];
    #[cfg(target_os = "linux")]
    let rel = ["rustdesk/rustdesk"];
    #[cfg(target_os = "windows")]
    let rel = ["rustdesk/rustdesk.exe", "rustdesk\\rustdesk.exe"];

    for root in &resource_roots {
        for r in rel.iter() {
            let p = root.join(r);
            if p.exists() { return Some(p); }
        }
    }
    None
}

/// RustDesk's per-user config dir. RustDesk2.toml (server config) and
/// RustDesk.toml (identity / password) both live here.
fn rustdesk_config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library/Preferences/com.carriez.RustDesk"))
    }
    #[cfg(target_os = "windows")]
    {
        // %APPDATA%\RustDesk\config
        dirs::config_dir().map(|d| d.join("RustDesk").join("config"))
    }
    #[cfg(target_os = "linux")]
    {
        dirs::config_dir().map(|d| d.join("rustdesk").join("config"))
    }
}

fn write_server_config(server_host: &str) -> Result<()> {
    let dir = rustdesk_config_dir()
        .ok_or_else(|| anyhow!("could not resolve rustdesk config dir"))?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating {:?}", dir))?;
    // The TOML schema matches what upstream RustDesk writes. `options.key`
    // pins the hbbs public key so this rustdesk instance won't talk to a
    // rogue relay. Empty string = trust on first contact (acceptable for
    // a self-hosted single-server deployment).
    let toml = format!(
        r#"rendezvous_server = '{host}:21116'
nat_type = 0
serial = 0

[options]
custom-rendezvous-server = '{host}'
relay-server = '{host}'
key = ''
enable-keyboard = 'Y'
enable-clipboard = 'Y'
enable-file-transfer = 'Y'
enable-audio = 'N'
"#,
        host = server_host,
    );
    let target = dir.join("RustDesk2.toml");
    std::fs::write(&target, toml).with_context(|| format!("writing {:?}", target))?;
    log::info!("rustdesk_host: wrote server config to {:?}", target);
    Ok(())
}

pub async fn start(server_host: &str, _session_token: &str) -> Result<HostHandle> {
    let bin = bundled_path()
        .ok_or_else(|| anyhow!("no rustdesk binary bundled in resources/rustdesk/"))?;

    log::info!("rustdesk_host: spawning {:?} against server {}", bin, server_host);

    write_server_config(server_host)?;

    let mut cmd = Command::new(&bin);
    // Avoid stdout/stderr capture — rustdesk isn't a CLI tool and
    // capturing them risks pipe-buffer deadlock on a long-running GUI
    // process.
    cmd.stdout(std::process::Stdio::null())
       .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().context("rustdesk spawn")?;

    // Poll RustDesk.toml (created by the child) for the id + password.
    // Cold start can take a few seconds while it contacts hbbs.
    let cfg_path = rustdesk_config_dir()
        .ok_or_else(|| anyhow!("config dir gone"))?
        .join("RustDesk.toml");
    let (rustdesk_id, rustdesk_password) = match timeout(
        Duration::from_secs(READY_TIMEOUT_SECS),
        wait_for_identity(&cfg_path),
    ).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(anyhow!(
                "rustdesk did not write id/password to {:?} within {}s",
                cfg_path, READY_TIMEOUT_SECS
            ));
        }
    };

    log::info!("rustdesk_host: ready, ID={rustdesk_id}");
    Ok(HostHandle {
        rustdesk_id,
        rustdesk_password: Some(rustdesk_password),
        child: Some(child),
    })
}

async fn wait_for_identity(path: &Path) -> Result<(String, String)> {
    let start = Instant::now();
    loop {
        if let Ok(content) = std::fs::read_to_string(path) {
            let id  = extract_field(&content, "id");
            let pwd = extract_field(&content, "password");
            if let (Some(id), Some(pwd)) = (id.as_ref(), pwd.as_ref()) {
                if id.len() >= 6 && !pwd.is_empty() {
                    return Ok((id.clone(), pwd.clone()));
                }
            }
            // Some rustdesk versions store id but defer password until the
            // first incoming connect request. If we have an id but no
            // password after 8s, return with an empty password — the user
            // can still see the ID and rustdesk will prompt for password
            // interactively.
            if start.elapsed() > Duration::from_secs(8) {
                if let Some(id) = id {
                    if id.len() >= 6 {
                        return Ok((id, pwd.unwrap_or_default()));
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Extract a top-level scalar `key = 'value'` (or `key = "value"`) from a
/// minimal TOML file. We don't need a full TOML parser — RustDesk's
/// identity file is a flat key=value list and we only read two fields.
fn extract_field(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(&format!("{key} =")) {
            let v = rest.trim()
                .trim_matches('"').trim_matches('\'')
                .trim().to_string();
            if !v.is_empty() { return Some(v); }
        }
    }
    None
}
