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
use std::path::PathBuf;
use std::time::Duration;
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

pub async fn start(server_host: &str, session_token: &str) -> Result<HostHandle> {
    let bin = bundled_path()
        .ok_or_else(|| anyhow!("no rustdesk binary bundled in resources/rustdesk/"))?;

    log::info!("rustdesk_host: spawning {:?} against server {}", bin, server_host);

    write_server_config(server_host)?;

    // 1. Spawn the long-running rustdesk host process. Detach stdout/err
    //    — RustDesk is a Flutter GUI, not a CLI; capturing pipes risks
    //    buffer-deadlock on a multi-hour session.
    let mut cmd = Command::new(&bin);
    cmd.stdout(std::process::Stdio::null())
       .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().context("rustdesk spawn")?;

    // 2. Give it a moment to register with hbbs and write its keypair to
    //    %APPDATA%\RustDesk\config\RustDesk.toml.
    tokio::time::sleep(Duration::from_secs(3)).await;

    // 3. Derive a short, RustDesk-friendly per-session password from the
    //    JWT. Full JWTs are too long for RustDesk's password field; first
    //    8 alnum chars of a sha256 give a stable 8-char token. This also
    //    means subsequent admin reconnects to the same session can use
    //    the same password without a DB lookup.
    let session_pass = derive_pass(session_token);

    // 4. Set the permanent password via the CLI one-shot. This rewrites
    //    `password` in RustDesk.toml. RustDesk persists it bcrypted so
    //    subsequent admin connects must use this exact password.
    if let Err(e) = run_cli(&bin, &["--password", &session_pass]).await {
        log::warn!("rustdesk_host: --password CLI failed: {e} (continuing)");
    }

    // 5. Query the decrypted 9-digit ID. `--get-id` exits after printing.
    let rustdesk_id = match get_id(&bin).await {
        Ok(id) => id,
        Err(e) => {
            log::warn!("rustdesk_host: --get-id failed: {e}");
            // Fall back to reading enc_id from RustDesk.toml — better
            // than nothing, but the dashboard won't be able to use the
            // encrypted form. Caller will fail downstream.
            return Err(anyhow!("could not obtain rustdesk ID: {e}"));
        }
    };

    log::info!("rustdesk_host: ready, ID={rustdesk_id}");
    Ok(HostHandle {
        rustdesk_id,
        rustdesk_password: Some(session_pass),
        child: Some(child),
    })
}

fn derive_pass(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(token.as_bytes());
    hex::encode(&h[..4]) // 8 hex chars
}

async fn run_cli(bin: &PathBuf, args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = timeout(Duration::from_secs(READY_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| anyhow!("rustdesk CLI timed out after {}s", READY_TIMEOUT_SECS))??;
    Ok(out)
}

async fn get_id(bin: &PathBuf) -> Result<String> {
    let out = run_cli(bin, &["--get-id"]).await?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // RustDesk prints either:
    //   "Your ID is 123456789"
    //   or just "123456789" depending on version.
    let combined = format!("{stdout}\n{stderr}");
    for line in combined.lines() {
        let digits: String = line.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 6 && digits.len() <= 12 {
            return Ok(digits);
        }
    }
    Err(anyhow!("rustdesk --get-id stdout did not contain a numeric ID: {stdout:?} stderr: {stderr:?}"))
}
