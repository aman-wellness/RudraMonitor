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

// The relay public key is pinned into RustDesk2.toml so clients refuse to talk
// to a rogue relay impersonating ours, and so customers never have to paste a
// key into RustDesk's Settings UI by hand. It is resolved through
// `config::hbbs_pubkey` rather than hardcoded here, because hbbs generates its
// own keypair per deployment — a local or staging relay has a different key and
// a mismatch makes RustDesk reject the server outright.
fn write_server_config(server_host: &str, hbbs_pubkey: &str) -> Result<()> {
    let dir = rustdesk_config_dir()
        .ok_or_else(|| anyhow!("could not resolve rustdesk config dir"))?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating {:?}", dir))?;
    // verification-method = use-permanent-password forces RustDesk to
    // ONLY accept the password we set via `rustdesk --password X` —
    // disables the random "one-time password" the UI generates on each
    // launch. Result: the password the admin sees in the dashboard and
    // the password shown in RustDesk's window on the agent machine are
    // the same string. Without this, the UI shows a per-launch random
    // string that doesn't match what our backend gave the dashboard.
    let toml = format!(
        r#"rendezvous_server = '{host}:21116'
nat_type = 0
serial = 0

[options]
custom-rendezvous-server = '{host}'
relay-server = '{host}'
key = '{key}'
verification-method = 'use-permanent-password'
approve-mode = 'password'
enable-keyboard = 'Y'
enable-clipboard = 'Y'
enable-file-transfer = 'Y'
enable-audio = 'N'
"#,
        host = server_host,
        key = hbbs_pubkey,
    );
    let target = dir.join("RustDesk2.toml");
    std::fs::write(&target, toml).with_context(|| format!("writing {:?}", target))?;
    log::info!("rustdesk_host: wrote server config to {:?}", target);
    Ok(())
}

/// Best-effort: kill any rustdesk.exe still running from a prior session
/// where the OS killed our parent process before our shutdown handler
/// ran, or where rustdesk spawned helper child processes that survived
/// our `child.start_kill()`. Called at agent boot, before a new spawn,
/// and after each session end.
pub async fn kill_orphan_rustdesk() {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/IM", "rustdesk.exe"]);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = timeout(Duration::from_secs(3), cmd.status()).await;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = timeout(
            Duration::from_secs(3),
            Command::new("killall").args(["-9", "RustDesk"]).status(),
        ).await;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = timeout(
            Duration::from_secs(3),
            Command::new("pkill").args(["-9", "-x", "rustdesk"]).status(),
        ).await;
    }
}

pub async fn start(server_host: &str, session_token: &str, hbbs_pubkey: &str) -> Result<HostHandle> {
    let bin = bundled_path()
        .ok_or_else(|| anyhow!("no rustdesk binary bundled in resources/rustdesk/"))?;
    if !is_executable(&bin) {
        return Err(anyhow!(
            "bundled rustdesk at {:?} is not executable (antivirus quarantine?)",
            bin
        ));
    }

    // Always start from a clean slate — kill any lingering rustdesk from
    // a prior session that didn't shut down cleanly. Otherwise the new
    // spawn races against the old instance and we end up with two
    // rustdesks fighting over the same RustDesk.toml.
    kill_orphan_rustdesk().await;

    log::info!("rustdesk_host: spawning {:?} against server {}", bin, server_host);

    // Order matters — we do CLI work (write configs, set password) FIRST,
    // BEFORE spawning the long-running rustdesk process. RustDesk does
    // its own config-file rewrites at startup, so a `--password` call
    // AFTER spawn races against rustdesk's own writes and loses ~30% of
    // the time on real Windows boxes.

    // 1. Pin our hbbs/hbbr relay in RustDesk2.toml.
    write_server_config(server_host, hbbs_pubkey)?;

    // 2. Derive a stable 8-char per-session password from the JWT.
    let session_pass = derive_pass(session_token);

    // 3. Persist that password via the CLI one-shot. RustDesk writes it
    //    bcrypted into RustDesk.toml so the running host accepts it.
    //    Best-effort — if rustdesk isn't bundled correctly we'll fail
    //    later anyway; this is just for the password persistence.
    if let Err(e) = run_cli(&bin, &["--password", &session_pass]).await {
        log::warn!("rustdesk_host: --password failed: {e} (continuing — admin will need to read RustDesk's UI password)");
    }

    // 4. Spawn the long-running host in HEADLESS server mode. `--server`
    //    runs only RustDesk's background incoming-connection service — it
    //    registers the ID with hbbs and accepts password-authenticated
    //    sessions WITHOUT opening the Flutter GUI window. Previously we
    //    spawned the bare binary, which popped the full RustDesk window on
    //    the employee's screen (very visible on macOS). Detached pipes —
    //    piped output risks buffer deadlock on the Flutter runtime.
    let mut cmd = Command::new(&bin);
    cmd.arg("--server");
    cmd.stdout(std::process::Stdio::null())
       .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().context("rustdesk spawn")?;

    // 5. Poll --get-id until a 9-digit ID prints OR we hit the deadline.
    //    Cold registration against hbbs can take 1-10s depending on
    //    network; on managed Windows machines with TLS-inspecting
    //    proxies, sometimes 15s+. If we still have no ID after the
    //    deadline, kill the child so we don't leak a half-started host.
    let rustdesk_id = match poll_get_id(&bin, Duration::from_secs(READY_TIMEOUT_SECS)).await {
        Ok(id) => id,
        Err(e) => {
            let mut child = child;
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(anyhow!("rustdesk ID not available after {READY_TIMEOUT_SECS}s: {e}"));
        }
    };

    log::info!("rustdesk_host: ready, ID={rustdesk_id}, pass len={}", session_pass.len());
    Ok(HostHandle {
        rustdesk_id,
        rustdesk_password: Some(session_pass),
        child: Some(child),
    })
}

fn is_executable(p: &PathBuf) -> bool {
    if !p.exists() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(windows)]
    {
        return p.extension().and_then(|s| s.to_str()) == Some("exe");
    }
}

async fn poll_get_id(bin: &PathBuf, total: Duration) -> Result<String> {
    let start = std::time::Instant::now();
    let mut attempts = 0u32;
    let mut last_err: Option<anyhow::Error> = None;
    while start.elapsed() < total {
        attempts += 1;
        match get_id(bin).await {
            Ok(id) => {
                log::info!("rustdesk_host: got ID on attempt {attempts}: {id}");
                return Ok(id);
            }
            Err(e) => {
                log::debug!("rustdesk_host: --get-id attempt {attempts} failed: {e}");
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no attempts ran")))
}

fn derive_pass(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(token.as_bytes());
    // 16 bytes → 32 hex chars ≈ 128-bit search space (audit M16). The previous
    // 4 bytes (8 hex / 32-bit) was brute-forceable for anyone who could reach
    // the agent's RustDesk ID. The agent reports this value up to the dashboard,
    // so lengthening it stays consistent end to end.
    hex::encode(&h[..16])
}

async fn run_cli_with_timeout(bin: &PathBuf, args: &[&str], t: Duration) -> Result<std::process::Output> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = timeout(t, cmd.output())
        .await
        .map_err(|_| anyhow!("rustdesk CLI timed out after {:?}", t))??;
    Ok(out)
}

async fn run_cli(bin: &PathBuf, args: &[&str]) -> Result<std::process::Output> {
    // Default 5s — most one-shot CLI calls (--get-id, --password) exit
    // within ~200ms. Anything taking longer is hung; we'd rather fail
    // fast and continue than block the whole consent → spawn flow.
    run_cli_with_timeout(bin, args, Duration::from_secs(5)).await
}

async fn get_id(bin: &PathBuf) -> Result<String> {
    let out = run_cli(bin, &["--get-id"]).await?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    log::debug!("rustdesk --get-id stdout={stdout:?} stderr={stderr:?}");
    // RustDesk IDs are always 9 digits. Earlier loose-matching grabbed
    // unrelated numbers from log lines (PIDs etc) — strict 9-digit-only.
    let combined = format!("{stdout}\n{stderr}");
    for line in combined.lines() {
        let digits: String = line.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() == 9 {
            return Ok(digits);
        }
    }
    // Fall back: if upstream now emits a different length, accept 7-12
    // (but log a warning so we notice the drift).
    for line in combined.lines() {
        let digits: String = line.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 7 && digits.len() <= 12 {
            log::warn!("rustdesk --get-id returned unexpected length: {digits} (expected 9)");
            return Ok(digits);
        }
    }
    Err(anyhow!("rustdesk --get-id did not return a numeric ID. stdout={stdout:?} stderr={stderr:?}"))
}
