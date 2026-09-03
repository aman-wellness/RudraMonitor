//! Silent execution of bundled PowerShell maintenance scripts.
//!
//! Fires only when the admin explicitly clicks "Run Driver Update" or
//! "Run Windows Optimizer" in the dashboard. Zero polling, zero background
//! schedule — a Supabase Realtime `tool.run` broadcast from
//! `agent-run-tool` edge function is the only trigger (see
//! `remote/realtime_listener.rs::handle_tool_run`).
//!
//! Both scripts require admin (DISM, sfc, chkdsk, pnputil, Stop-Service).
//! We rely on the scheduled task registered with `/rl highest` (see
//! `service_install.rs`) so the agent process already carries an admin
//! token — powershell.exe launched here inherits it. Windows shows no
//! UAC prompt at runtime because the task grant is permanent.
//!
//! Windows-only. Non-Windows platforms compile out entirely.

#![cfg(target_os = "windows")]

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

/// Hard cap on a single tool run. Optimize.ps1 now sticks to cleanup +
/// DISM /StartComponentCleanup + Optimize-Volume — the repair-oriented
/// sfc / DISM /RestoreHealth / chkdsk block was removed 2026-09-02 after
/// Anmol Sangwan's machine kept blowing past 45 minutes on sfc alone.
/// A healthy Optimizer run now finishes in 5-10 minutes; 20 gives us
/// headroom on a slow HDD or an unusually large Windows Update backlog.
/// Driver Update path is unaffected (its own preflight is well under
/// this cap).
const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Only the last 8 KB of the script's stdout goes back to the dashboard —
/// enough for the "Cleanup summary" block Optimize.ps1 prints at the end,
/// short enough to not blow up the `tool_runs` row.
const STDOUT_TAIL_BYTES: usize = 8 * 1024;

/// Result artifacts (CSV / TXT) may be much larger than the stdout tail —
/// InstalledDrivers.csv on a driver-rich workstation can be ~500 KB. Cap
/// at 512 KB before base64-encoding; anything larger gets truncated with
/// a header note so the tool_runs upload still succeeds.
const ARTIFACT_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy)]
pub enum ToolKind {
    DriverUpdater,
    WindowsOptimizer,
}

impl ToolKind {
    fn wire(&self) -> &'static str {
        match self {
            ToolKind::DriverUpdater => "driver_updater",
            ToolKind::WindowsOptimizer => "windows_optimizer",
        }
    }
    fn script_filename(&self) -> &'static str {
        match self {
            ToolKind::DriverUpdater => "DriverManagerPro.ps1",
            ToolKind::WindowsOptimizer => "Optimize.ps1",
        }
    }
    /// Path of the report file the script writes, RELATIVE to the resource
    /// directory. Absent if the script produced nothing (e.g. failed
    /// preflight).
    fn report_relpath(&self) -> &'static str {
        match self {
            ToolKind::DriverUpdater => "InstalledDrivers.csv",
            ToolKind::WindowsOptimizer => "Logs\\Cleanup_Report.txt",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "driver_updater" => Some(ToolKind::DriverUpdater),
            "windows_optimizer" => Some(ToolKind::WindowsOptimizer),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub run_id: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    /// Last ~8 KB of the script's combined stdout+stderr, UTF-8 lossy.
    pub stdout_tail: String,
    /// `succeeded` / `failed` / `timed_out`. Matches the DB enum on
    /// `tool_runs.state`.
    pub state: &'static str,
    /// Optional base64 report artifact.
    pub report_b64: Option<String>,
    pub artifact_filename: Option<String>,
}

/// Resolve the bundled script path. Same layout probing as
/// `remote/rustdesk_host.rs::bundled_path()` — Tauri drops resources next
/// to the exe on Windows, either at `<exe>/resources/…` or `<exe>/…`.
fn bundled_script_path(kind: ToolKind) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let candidates = [
        exe_dir.join("resources").join("endpoint-tools").join(kind.script_filename()),
        exe_dir.join("endpoint-tools").join(kind.script_filename()),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Preflight the `PSWindowsUpdate` module for the driver-updater path.
/// DriverManagerPro calls `Get-WindowsUpdate -Install` which lives in
/// that module — not shipped in-box with Windows. First time we run
/// on a fresh machine we bootstrap it silently. Subsequent runs no-op.
fn ensure_pswindowsupdate() -> Result<()> {
    let probe = "if (Get-Module -ListAvailable PSWindowsUpdate) { exit 0 } else { exit 1 }";
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-Command", probe,
    ]);
    crate::win_proc::no_window(&mut cmd);
    if let Ok(status) = cmd.status() {
        if status.success() {
            return Ok(());
        }
    }
    // Install the module + its NuGet provider prerequisite. ORDER MATTERS:
    // Set-PSRepository/Install-Module both depend on the NuGet package
    // provider being bootstrapped first. Prior release ran Set-PSRepository
    // first and cascaded to "NuGet provider is required to interact with
    // NuGet-based repositories" on any machine without NuGet preinstalled
    // (v0.6.24 field failure on Pooja's PC).
    //
    // Also: `-Confirm:$false` on Install-PackageProvider silences the
    // "would you like to install NuGet from https://oneget.org" prompt
    // that fires under -NonInteractive.
    //
    // Try AllUsers first (works when the interactive user is an admin —
    // task RunLevel=Highest picks up admin token). On a Standard User
    // account the AllUsers install fails with "Administrator rights are
    // required to install packages in C:\Program Files\..." — retry with
    // -Scope CurrentUser which lands the module under the user profile
    // and is what the error's own hint tells us to do. Endpoint tools
    // then work for Standard-User accounts too.
    let install_allusers = "Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -ForceBootstrap -Confirm:$false -Scope AllUsers -ErrorAction Stop | Out-Null; \
                   Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue; \
                   Install-Module -Name PSWindowsUpdate -Scope AllUsers -Force -AllowClobber -Confirm:$false -ErrorAction Stop";
    let install_currentuser = "Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -ForceBootstrap -Confirm:$false -Scope CurrentUser -ErrorAction Stop | Out-Null; \
                   Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue; \
                   Install-Module -Name PSWindowsUpdate -Scope CurrentUser -Force -AllowClobber -Confirm:$false -ErrorAction Stop";
    for (label, script) in [("AllUsers", install_allusers), ("CurrentUser", install_currentuser)] {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-Command", script,
        ]);
        crate::win_proc::no_window(&mut cmd);
        match cmd.output() {
            Ok(out) if out.status.success() => {
                log::info!("PSWindowsUpdate installed (scope={label})");
                return Ok(());
            }
            Ok(out) => {
                log::warn!(
                    "PSWindowsUpdate install scope={label} failed: {}",
                    String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()
                );
                // fall through to next scope
            }
            Err(e) => {
                log::warn!("PSWindowsUpdate install scope={label} spawn error: {e}");
            }
        }
    }
    Err(anyhow!(
        "PSWindowsUpdate bootstrap failed under both AllUsers and CurrentUser scopes — \
         PowerShell Gallery may be unreachable, or the user profile has NuGet blocked. \
         Manual install: run `Install-Module PSWindowsUpdate -Scope CurrentUser` as the logged-in user."
    ))
}

/// Execute the given tool and return a result envelope ready to POST to
/// `agent-tool-result`. Callers should pass the DB-side `run_id` so the
/// server can UPDATE the pre-inserted `tool_runs` row.
pub async fn run_tool(kind: ToolKind, run_id: String) -> Result<ToolResult> {
    // 1. Preflight (DriverUpdater only). Errors here surface as a failed
    // run — we don't try to execute the script if the module install fails
    // because DriverManagerPro will just crash on `Get-WindowsUpdate`.
    if matches!(kind, ToolKind::DriverUpdater) {
        if let Err(e) = ensure_pswindowsupdate() {
            return Ok(ToolResult {
                run_id,
                exit_code: -1,
                duration_ms: 0,
                stdout_tail: format!("PSWindowsUpdate preflight failed: {e}"),
                state: "failed",
                report_b64: None,
                artifact_filename: None,
            });
        }
    }

    // 1b. Early "running" ping so the dashboard row transitions out of
    // pending the moment the agent picks up the event. Non-fatal on
    // failure — the final result POST below is what matters.
    let _ = post_running(&run_id).await;

    // 1c. Keep the machine awake while the script runs. Without this the
    // laptop can enter modern-standby (lid close, idle-sleep timer) mid-
    // run, the tokio runtime freezes, the 45-min timeout never fires, and
    // the DB reaper flips the row to 'cancelled' at 60 min with no
    // completion post from the agent — exactly what killed Anmol Sangwan's
    // 2026-09-02 09:07 UTC run despite v0.7.31's tokio::process fix.
    // KeepAwakeGuard drops back to normal power on Drop, no matter how
    // the run exits (early-return, panic, timeout, ok).
    let _keep_awake = KeepAwakeGuard::new();

    // 2. Locate the bundled .ps1.
    let script = match bundled_script_path(kind) {
        Some(p) => p,
        None => {
            return Ok(ToolResult {
                run_id,
                exit_code: -1,
                duration_ms: 0,
                stdout_tail: format!("bundled script not found: {}", kind.script_filename()),
                state: "failed",
                report_b64: None,
                artifact_filename: None,
            });
        }
    };
    let script_dir = script.parent().map(|p| p.to_path_buf());

    // 3. Spawn powershell.exe with tokio::process::Command so we can
    // actually kill the child when the timeout fires. Prior code used
    // std::process::Command inside tokio::task::spawn_blocking + a
    // tokio::time::timeout wrapping the JoinHandle — the timeout DID
    // fire on the outer future, but spawn_blocking tasks are
    // NON-CANCELLABLE: the powershell child kept running past the
    // 45-min timeout, the tokio-side "timed_out" result was constructed
    // and returned, but only after the join actually settled — which
    // for a script wedged on chkdsk or Get-WindowsUpdate could be an
    // hour or more. Result: DB row stays 'running' until the 60-min
    // reaper. Anmol Sangwan hit exactly this on 2026-09-02.
    //
    // tokio::process::Command owns a Child handle we can kill on
    // timeout; the child dies within a second and the completion POST
    // fires immediately after. -NonInteractive still prevents Read-Host
    // pauses.
    let started = Instant::now();
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", &script.to_string_lossy(),
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    // CREATE_NO_WINDOW: prevent the child from briefly popping a
    // console window when spawned from a service context. Mirrors what
    // win_proc::no_window does for std::process::Command.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let (exit_code, stdout_tail, state) = match cmd.spawn() {
        Ok(mut child) => {
            let mut stdout = child.stdout.take();
            let mut stderr = child.stderr.take();
            match tokio::time::timeout(RUN_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => {
                    let mut combined = Vec::new();
                    if let Some(mut s) = stdout.take() {
                        let _ = s.read_to_end(&mut combined).await;
                    }
                    if let Some(mut s) = stderr.take() {
                        let _ = s.read_to_end(&mut combined).await;
                    }
                    let start = combined.len().saturating_sub(STDOUT_TAIL_BYTES);
                    let tail = String::from_utf8_lossy(&combined[start..]).into_owned();
                    let code = status.code().unwrap_or(-1);
                    let state = if status.success() { "succeeded" } else { "failed" };
                    (code, tail, state)
                }
                Ok(Err(e)) => (-1, format!("wait error: {e}"), "failed"),
                Err(_) => {
                    // Kill the child so the process doesn't linger. wait()
                    // above already borrowed &mut child so we can only kill
                    // once the future is dropped by the Err match arm.
                    let _ = child.start_kill();
                    // Give powershell a beat to actually die, then drain
                    // whatever it managed to print before the axe fell.
                    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                    let mut combined = Vec::new();
                    if let Some(mut s) = stdout.take() {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(2),
                            s.read_to_end(&mut combined),
                        ).await;
                    }
                    if let Some(mut s) = stderr.take() {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(2),
                            s.read_to_end(&mut combined),
                        ).await;
                    }
                    let notice = format!("[timeout] killed powershell.exe after {}s.\n\n", RUN_TIMEOUT.as_secs());
                    let start = combined.len().saturating_sub(STDOUT_TAIL_BYTES - notice.len());
                    let tail = format!("{notice}{}", String::from_utf8_lossy(&combined[start..]));
                    (-1, tail, "timed_out")
                }
            }
        }
        Err(e) => (-1, format!("spawn error: {e}"), "failed"),
    };
    let duration_ms = started.elapsed().as_millis() as u64;

    // 5. Read the report artifact if it exists. Non-fatal — some runs
    // produce nothing (e.g. Optimize.ps1 aborted before writing the log).
    let (report_b64, artifact_filename) = if let Some(dir) = script_dir {
        let report_path = dir.join(kind.report_relpath());
        match std::fs::read(&report_path) {
            Ok(mut bytes) => {
                let filename = report_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned());
                if bytes.len() > ARTIFACT_MAX_BYTES {
                    let notice = format!(
                        "[Wellness Extract agent] Report truncated — original {} bytes, kept last {} bytes.\r\n",
                        bytes.len(),
                        ARTIFACT_MAX_BYTES
                    );
                    let keep = ARTIFACT_MAX_BYTES.saturating_sub(notice.len());
                    let start = bytes.len().saturating_sub(keep);
                    let mut truncated = notice.into_bytes();
                    truncated.extend_from_slice(&bytes[start..]);
                    bytes = truncated;
                }
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                (Some(encoded), filename)
            }
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(ToolResult {
        run_id,
        exit_code,
        duration_ms,
        stdout_tail,
        state,
        report_b64,
        artifact_filename,
    })
}

/// POST an early `state=running` update so the dashboard row transitions
/// out of pending the moment the agent picks up the event. The full result
/// envelope (exit_code, duration, artifact) is posted separately at the
/// end via `post_result`.
async fn post_running(run_id: &str) -> Result<()> {
    // Read config each time — cheap, avoids threading state through.
    // Failure to build client is non-fatal; the run continues and the
    // dashboard just sees "pending → succeeded" without a running phase.
    let cfg = crate::config::load().ok();
    let cfg = match cfg { Some(c) => c, None => return Ok(()) };
    let url = crate::config::supabase_url(&cfg);
    let anon = crate::config::supabase_anon_key(&cfg);
    let token = cfg.enrollment.as_ref().map(|e| e.enroll_token.clone());
    let (url, anon, token) = match (url, anon, token) {
        (Some(u), Some(a), Some(t)) => (u, a, t),
        _ => return Ok(()),
    };
    let client = crate::api::build_client()?;
    let full = format!(
        "{}/functions/v1/agent-tool-result",
        url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "run_id": run_id,
        "state": "running",
        "exit_code": 0,
        "duration_ms": 0,
        "stdout_tail": "",
    });
    let resp = client
        .post(&full)
        .bearer_auth(&anon)
        .header("apikey", &anon)
        .header("X-Agent-Token", &token)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        log::debug!(
            "post_running: {} — {}",
            resp.status(),
            resp.text().await.unwrap_or_default().chars().take(200).collect::<String>()
        );
    }
    Ok(())
}

/// POST the result envelope to `agent-tool-result`. Kept next to run_tool
/// so callers only have to hold the state (config, http client) once.
pub async fn post_result(
    client: &reqwest::Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    result: &ToolResult,
) -> Result<()> {
    let url = format!(
        "{}/functions/v1/agent-tool-result",
        supabase_url.trim_end_matches('/')
    );
    let resp = client
        .post(&url)
        .bearer_auth(anon_key)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .json(result)
        .send()
        .await
        .context("post agent-tool-result")?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "agent-tool-result: {} — {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(())
}

/// Prevents the machine from entering sleep / modern-standby while a tool
/// run is in flight. On construction, calls SetThreadExecutionState with
/// ES_CONTINUOUS | ES_SYSTEM_REQUIRED — the system idle-timer is held off
/// as long as the flag is set. On Drop, clears the flag back to
/// ES_CONTINUOUS alone so the machine can sleep again the moment the run
/// exits (success, failure, timeout, or panic).
///
/// Display sleep is deliberately NOT held: we don't want a laptop closed on
/// a desk to light up its screen for an admin-triggered maintenance run.
/// Only the SYSTEM idle path is blocked.
struct KeepAwakeGuard;

impl KeepAwakeGuard {
    fn new() -> Self {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
            };
            let prev = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            if prev.0 == 0 {
                log::warn!("keep-awake: SetThreadExecutionState returned 0 — sleep may still fire");
            } else {
                log::info!("keep-awake: holding system idle-timer for the duration of the tool run");
            }
        }
        Self
    }
}

impl Drop for KeepAwakeGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            let _ = SetThreadExecutionState(ES_CONTINUOUS);
            log::info!("keep-awake: released system idle-timer hold");
        }
    }
}
