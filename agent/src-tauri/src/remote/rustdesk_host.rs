// Wraps the bundled `rustdesk` binary as a subprocess. We never link
// against the rustdesk crate — GPL-3.0 linkage would force the agent to
// be GPL too. Instead we ship the upstream rustdesk binary in
// resources/rustdesk[.exe] and talk to it over stdio. That's "use", not
// "linking" — GPL respects the boundary.
//
// Process lifecycle:
//   spawn(server, token)
//     → spawn rustdesk in unattended "host" mode, point it at our hbbs
//       container, hand it the per-session token as both relay password
//       and one-time pass so the dashboard's RustDesk web client can
//       connect with that same token in its URL hash.
//     → wait for the binary to print its 9-digit ID on stdout (rustdesk
//       prints "Your ID is <id>" on first registration).
//     → return a HostHandle the realtime listener can shutdown() later.
//
// On shutdown(), we send SIGTERM (Unix) / TerminateProcess (Windows)
// and wait up to 5 s for clean exit, then SIGKILL.
//
// The binary itself is added to src-tauri/resources/ by the CI workflow
// in Block 3.2. Until then, this module returns an error from start()
// and the realtime listener reports it back to the backend as a denied
// session — the dashboard shows "agent not capable of remote control"
// instead of hanging.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tokio::time::timeout;

#[cfg(target_os = "windows")]
const BIN_NAME: &str = "rustdesk.exe";
#[cfg(not(target_os = "windows"))]
const BIN_NAME: &str = "rustdesk";

const READY_TIMEOUT_SECS: u64 = 20;

pub struct HostHandle {
    pub rustdesk_id: String,
    child: Option<Child>,
}

impl HostHandle {
    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            {
                if let Some(pid) = child.id() {
                    // SIGTERM first; rustdesk handles it cleanly.
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
    #[cfg(target_os = "macos")]
    {
        let contents = exe_dir.parent()?;
        for sub in ["Resources/resources", "Resources", "Resources/_up_/resources"] {
            let p = contents.join(sub).join(BIN_NAME);
            if p.exists() { return Some(p); }
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        for sub in ["resources", "."] {
            let p = exe_dir.join(sub).join(BIN_NAME);
            if p.exists() { return Some(p); }
        }
        None
    }
}

pub async fn start(server_host: &str, session_token: &str) -> Result<HostHandle> {
    let bin = bundled_path()
        .ok_or_else(|| anyhow!("no rustdesk binary bundled — CI hasn't shipped Block 3.2 yet"))?;

    log::info!("rustdesk_host: spawning {:?} against server {}", bin, server_host);

    // RustDesk reads its hbbs/hbbr coordinates from env or RustDesk2.toml.
    // Env vars are simplest for our case — one-shot per session, no
    // persistent config to leak across sessions.
    let mut cmd = Command::new(&bin);
    cmd.env("RENDEZVOUS_SERVER", format!("{server_host}:21116"))
       .env("RELAY_SERVER",      format!("{server_host}:21117"))
       .env("KEY",               "") // pubkey embedded server-side; agent doesn't need it for outbound
       .env("PASSWORD",          session_token)
       .arg("--service")
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());
    // tokio::process::Command has its own creation_flags (mirrors std).
    // win_proc::no_window is std-only, so inline the flag.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().context("rustdesk spawn")?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("rustdesk stdout missing"))?;
    let mut reader = BufReader::new(stdout).lines();

    // Wait for rustdesk to print its 9-digit ID. Format observed:
    //   "Your ID is 123456789"
    // We also accept a plain 9-digit token on its own line as a fallback.
    let id_future = async {
        while let Ok(Some(line)) = reader.next_line().await {
            log::debug!("rustdesk[stdout] {line}");
            if let Some(id) = extract_id(&line) {
                return Ok::<String, anyhow::Error>(id);
            }
        }
        Err(anyhow!("rustdesk stdout closed before reporting ID"))
    };

    let rustdesk_id = match timeout(Duration::from_secs(READY_TIMEOUT_SECS), id_future).await {
        Ok(Ok(id)) => id,
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(e);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(anyhow!("rustdesk did not report ID within {READY_TIMEOUT_SECS}s"));
        }
    };

    log::info!("rustdesk_host: ready, ID={rustdesk_id}");
    Ok(HostHandle { rustdesk_id, child: Some(child) })
}

fn extract_id(line: &str) -> Option<String> {
    if let Some(rest) = line.split("Your ID is").nth(1) {
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 9 {
            return Some(digits.chars().take(9).collect());
        }
    }
    let trimmed = line.trim();
    if trimmed.len() == 9 && trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Some(trimmed.to_string());
    }
    None
}
