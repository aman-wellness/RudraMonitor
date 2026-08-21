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

/// Hard cap on a single tool run. Optimize.ps1 does `sfc /scannow` +
/// `chkdsk /scan` + `DISM /RestoreHealth` which combined can hit
/// ~30 minutes on a well-used SSD, longer on a slow HDD. 45 minutes gives
/// a comfortable buffer without pinning powershell.exe forever if the
/// script hangs.
const RUN_TIMEOUT: Duration = Duration::from_secs(45 * 60);

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
    // Install the module + its NuGet provider prerequisite. Both are safe
    // to re-invoke — `-Force` short-circuits when already present.
    let install = "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue; \
                   Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -ForceBootstrap -ErrorAction SilentlyContinue | Out-Null; \
                   Install-Module -Name PSWindowsUpdate -Scope AllUsers -Force -AllowClobber -ErrorAction Stop";
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-Command", install,
    ]);
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output().context("spawn PSWindowsUpdate installer")?;
    if !out.status.success() {
        return Err(anyhow!(
            "PSWindowsUpdate bootstrap failed: {}",
            String::from_utf8_lossy(&out.stderr).chars().take(400).collect::<String>()
        ));
    }
    Ok(())
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

    // 3. Spawn powershell.exe with the exact flag set that guarantees no
    // window flash on Windows 11 + Windows Terminal — same combo used
    // by usb_block.rs and signature_deploy.rs. -NonInteractive prevents
    // the script from ever pausing on Read-Host in a headless session.
    let started = Instant::now();
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", &script.to_string_lossy(),
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    crate::win_proc::no_window(&mut cmd);

    // 4. Run inside a tokio timeout so a wedged sfc/chkdsk doesn't pin the
    // agent thread forever. spawn_blocking so we don't block the async
    // runtime for the (possibly 30-min) run.
    let output_res = tokio::time::timeout(
        RUN_TIMEOUT,
        tokio::task::spawn_blocking(move || cmd.output()),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let (exit_code, stdout_tail, state) = match output_res {
        Ok(Ok(Ok(out))) => {
            let mut combined = out.stdout;
            combined.extend_from_slice(&out.stderr);
            let start = combined.len().saturating_sub(STDOUT_TAIL_BYTES);
            let tail = String::from_utf8_lossy(&combined[start..]).into_owned();
            let code = out.status.code().unwrap_or(-1);
            let state = if out.status.success() { "succeeded" } else { "failed" };
            (code, tail, state)
        }
        Ok(Ok(Err(e))) => (-1, format!("spawn error: {e}"), "failed"),
        Ok(Err(e)) => (-1, format!("join error: {e}"), "failed"),
        Err(_) => (-1, format!("timeout after {}s", RUN_TIMEOUT.as_secs()), "timed_out"),
    };

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
