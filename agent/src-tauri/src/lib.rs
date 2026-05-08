// Tauri 2 entrypoint. Wires up:
//   - Tauri commands the React UI calls (get_status, enroll, sign_out, save_supabase_config)
//   - A background tokio task that, once enrolled, pushes system metrics every 60s.

mod active_window;
mod api;
mod browser_url;
mod config;
mod watchdog;

pub use watchdog::{is_guardian_invocation, run_guardian_loop, mark_graceful_shutdown};
mod idle;
mod metrics;
mod screenshots;
mod video;

use active_window::{FocusSession, WindowInfo};
use anyhow::{anyhow, Result};
use chrono::{Duration as ChronoDuration, Utc};
use config::{AgentConfig, Enrollment};
use idle::IdleSession;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    Manager, State, WindowEvent,
};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

const METRICS_INTERVAL_SECS: u64 = 60;
const WINDOW_POLL_SECS: u64 = 10;
// Periodically flush a long-running focus session so the dashboard stays fresh.
const WINDOW_MAX_SESSION_SECS: i64 = 300;
const SCREENSHOT_INTERVAL_SECS: u64 = 300;
const IDLE_POLL_SECS: u64 = 30;
const UPDATE_CHECK_INTERVAL_SECS: u64 = 30 * 60; // 30 minutes — balance bandwidth vs propagation speed
const SETTINGS_REFRESH_SECS: u64 = 300; // 5 min — admin toggles propagate within this window.

// Defaults used when settings can't be fetched yet (first launch, network blip).
const DEFAULT_SETTINGS: api::AgentSettings = api::AgentSettings {
    screenshots_enabled: true,
    active_window_enabled: true,
    screenshot_interval_secs: SCREENSHOT_INTERVAL_SECS as u32,
    idle_threshold_secs: 300,
    videos_enabled: false,
    video_interval_secs: 1800,
};

// Threshold-based alerts: only fired once when crossing into elevated state, cleared when metric drops.
const CPU_ALERT_THRESHOLD: i32 = 90;
const RAM_ALERT_THRESHOLD: i32 = 90;
const DISK_ALERT_THRESHOLD: i32 = 95;

#[derive(Clone)]
pub struct AppState {
    config: Arc<Mutex<AgentConfig>>,
    last_sync: Arc<Mutex<Option<String>>>,
    last_error: Arc<Mutex<Option<String>>>,
    current_focus: Arc<Mutex<Option<FocusSession>>>,
    current_idle: Arc<Mutex<Option<IdleSession>>>,
    active_alerts: Arc<Mutex<HashSet<String>>>,
    paused: Arc<AtomicBool>,
    settings: Arc<Mutex<api::AgentSettings>>,
    /// True if license is missing or last validation said "valid: false".
    /// Capture loops short-circuit when this is set so revoked/expired licenses
    /// stop pumping data immediately.
    license_blocked: Arc<AtomicBool>,
    license_reason: Arc<Mutex<Option<String>>>,
}

impl AppState {
    fn new(cfg: AgentConfig) -> Self {
        Self {
            config: Arc::new(Mutex::new(cfg)),
            last_sync: Arc::new(Mutex::new(None)),
            last_error: Arc::new(Mutex::new(None)),
            current_focus: Arc::new(Mutex::new(None)),
            current_idle: Arc::new(Mutex::new(None)),
            active_alerts: Arc::new(Mutex::new(HashSet::new())),
            paused: Arc::new(AtomicBool::new(false)),
            settings: Arc::new(Mutex::new(DEFAULT_SETTINGS)),
            license_blocked: Arc::new(AtomicBool::new(false)),
            license_reason: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Serialize)]
struct StatusPayload {
    enrolled: bool,
    agent_name: Option<String>,
    machine_name: Option<String>,
    org_id: Option<String>,
    supabase_configured: bool,
    last_sync: Option<String>,
    last_error: Option<String>,
    paused: bool,
    autostart_enabled: bool,
    /// Set by the personalized launcher script (Install-<Name>.command/.bat/.sh).
    /// When Some, the React UI hides the name field — employee only enters license key.
    prefilled_agent_name: Option<String>,
    license_present: bool,
    license_blocked: bool,
    license_reason: Option<String>,
}

#[tauri::command]
async fn get_status(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<StatusPayload, String> {
    let cfg = state.config.lock().await;
    let last_sync = state.last_sync.lock().await.clone();
    let last_error = state.last_error.lock().await.clone();

    let supabase_configured =
        config::supabase_url(&cfg).is_some() && config::supabase_anon_key(&cfg).is_some();

    let (enrolled, agent_name, machine_name, org_id) = if let Some(e) = &cfg.enrollment {
        (true, Some(e.agent_name.clone()), Some(e.machine_name.clone()), Some(e.org_id.clone()))
    } else {
        (false, None, None, None)
    };

    let autostart_enabled = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(false);

    let license_present = cfg.license_key.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let license_blocked = state.license_blocked.load(Ordering::SeqCst);
    let license_reason = state.license_reason.lock().await.clone();

    Ok(StatusPayload {
        enrolled,
        agent_name,
        machine_name,
        org_id,
        supabase_configured,
        last_sync,
        last_error,
        paused: state.paused.load(Ordering::SeqCst),
        autostart_enabled,
        prefilled_agent_name: if enrolled { None } else { config::read_prefill_name() },
        license_present,
        license_blocked,
        license_reason,
    })
}

#[tauri::command]
fn set_paused(paused: bool, state: State<'_, AppState>) {
    state.paused.store(paused, Ordering::SeqCst);
}

#[tauri::command]
async fn set_license_key(license_key: String, state: State<'_, AppState>) -> Result<api::ValidateLicenseResponse, String> {
    let key = license_key.trim().to_string();
    if key.is_empty() { return Err("license key required".into()); }

    let cfg = state.config.lock().await.clone();
    let supabase_url = config::supabase_url(&cfg).ok_or("no supabase url")?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or("no anon key")?;
    let org_id = cfg.enrollment.as_ref().map(|e| e.org_id.clone());

    let client = api::build_client().map_err(|e| e.to_string())?;
    let resp = api::validate_license(&client, &supabase_url, &anon_key, &key, org_id.as_deref())
        .await.map_err(|e| e.to_string())?;
    if !resp.valid {
        let reason = resp.reason.clone().unwrap_or_else(|| "invalid".into());
        return Err(format!("license invalid: {}", reason));
    }

    // Persist
    {
        let mut cfg = state.config.lock().await;
        cfg.license_key = Some(key);
        config::save(&cfg).map_err(|e| e.to_string())?;
    }
    state.license_blocked.store(false, Ordering::SeqCst);
    *state.license_reason.lock().await = None;
    Ok(resp)
}

#[tauri::command]
fn set_autostart(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[derive(serde::Deserialize)]
struct EnrollArgs {
    license_key: String,
    agent_name: String,
}

#[tauri::command]
async fn enroll(args: EnrollArgs, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().await;

    let supabase_url = config::supabase_url(&cfg)
        .ok_or_else(|| "Supabase URL not configured".to_string())?;
    let anon_key = config::supabase_anon_key(&cfg)
        .ok_or_else(|| "Supabase anon key not configured".to_string())?;

    let machine_name = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".to_string());
    let os_type = detect_os();

    let client = api::build_client().map_err(|e| e.to_string())?;
    let resp = api::enroll(
        &client,
        &supabase_url,
        &anon_key,
        &api::EnrollRequest {
            license_key: args.license_key.trim().to_string(),
            agent_name: args.agent_name.trim().to_string(),
            machine_name: machine_name.clone(),
            os_type: os_type.clone(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    cfg.enrollment = Some(Enrollment {
        agent_id: resp.agent_id,
        enroll_token: resp.enroll_token,
        agent_name: args.agent_name,
        machine_name,
        org_id: resp.org_id,
    });
    config::save(&cfg).map_err(|e| e.to_string())?;
    config::consume_prefill();

    // Auto-enable launch-at-login so the agent persists across reboots without the user
    // having to know about it.
    let _ = app.autolaunch().enable();

    // Now that we're enrolled, hide the window and shed all visible UI. From here on the
    // agent runs silently — no dock icon (macOS Accessory), no taskbar, no tray.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_visible(false);
    }
    Ok(())
}

#[tauri::command]
async fn sign_out(state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().await;
    cfg.enrollment = None;
    config::save(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

fn detect_os() -> String {
    if cfg!(target_os = "windows") {
        "Windows".into()
    } else if cfg!(target_os = "macos") {
        "macOS".into()
    } else if cfg!(target_os = "linux") {
        "Ubuntu".into()
    } else {
        "Unknown".into()
    }
}

async fn push_kind(state: &AppState, kind: &str, payload: Value) -> Result<()> {
    if !license_ok(state) { return Ok(()); }
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let client = api::build_client()?;
    api::ingest(
        &client,
        &supabase_url,
        &anon_key,
        &enrollment.enroll_token,
        &api::IngestRequest { kind, payload: vec![payload] },
    )
    .await
}

async fn push_activity(state: &AppState, payload: Value) -> Result<()> {
    push_kind(state, "activity_logs", payload).await
}

async fn idle_tick(state: &AppState) -> Result<()> {
    let threshold = state.settings.lock().await.idle_threshold_secs as u64;
    let now = Utc::now();
    let idle_secs = idle::current_idle_secs().unwrap_or(0);

    let mut current = state.current_idle.lock().await;
    if idle_secs >= threshold {
        if current.is_none() {
            // Backdate started_at to the actual idle start (now − idle_secs).
            *current = Some(IdleSession {
                started_at: now - ChronoDuration::seconds(idle_secs as i64),
            });
        }
        // While idle, do nothing else; final emission happens when the user returns.
        return Ok(());
    }

    // User is active. If we were tracking an idle session, emit it now.
    if let Some(s) = current.take() {
        // Drop lock before network call.
        drop(current);
        let payload = idle::to_payload(&s, now);
        push_activity(state, payload).await?;
    }
    Ok(())
}

async fn maybe_emit_alerts(state: &AppState, sample: &metrics::MetricsSample) -> Result<()> {
    let checks: &[(i32, i32, &str, &str)] = &[
        (sample.cpu_usage, CPU_ALERT_THRESHOLD, "cpu", "error"),
        (sample.ram_usage, RAM_ALERT_THRESHOLD, "ram", "warning"),
        (sample.disk_usage, DISK_ALERT_THRESHOLD, "disk", "error"),
    ];

    for (value, threshold, key, alert_type) in checks {
        let mut active = state.active_alerts.lock().await;
        let elevated = *value >= *threshold;
        let already = active.contains(*key);

        if elevated && !already {
            active.insert((*key).to_string());
            drop(active);
            let message = match *key {
                "cpu" => format!("High CPU usage: {}%", value),
                "ram" => format!("High RAM usage: {}%", value),
                "disk" => format!("Disk almost full: {}% used", value),
                _ => format!("{}: {}%", key, value),
            };
            let payload = json!({
                "alert_type": alert_type,
                "message": message,
                "ai_resolved": false,
                "resolution": null,
                "created_at": Utc::now().to_rfc3339(),
            });
            if let Err(e) = push_kind(state, "alerts", payload).await {
                log::warn!("alert push failed: {e}");
            }
        } else if !elevated && already {
            active.remove(*key);
        }
    }
    Ok(())
}

/// Polls the active window. Emits a row to activity_logs whenever the (app, title) changes,
/// and also flushes a session that has been running for too long.
async fn window_tick(state: &AppState) -> Result<()> {
    if !state.settings.lock().await.active_window_enabled {
        return Ok(());
    }
    let now = Utc::now();
    let new_info: Option<WindowInfo> = active_window::current();

    let mut focus = state.current_focus.lock().await;
    let prev = focus.clone();

    let same = match (&prev, &new_info) {
        (Some(p), Some(n)) => p.info == *n,
        (None, None) => true,
        _ => false,
    };

    let should_flush_long = prev
        .as_ref()
        .map(|p| (now - p.started_at).num_seconds() >= WINDOW_MAX_SESSION_SECS)
        .unwrap_or(false);

    if same && !should_flush_long {
        return Ok(());
    }

    // Emit the previous session (if any).
    if let Some(p) = prev {
        let payload = active_window::to_payload(&p, now);
        // Drop the lock while we do the network call.
        drop(focus);
        push_activity(state, payload).await?;
        focus = state.current_focus.lock().await;
    }

    // Start fresh: either the new window, or restart the same one (long-flush case).
    *focus = new_info.map(|info| FocusSession { info, started_at: now });
    Ok(())
}

async fn settings_tick(state: &AppState) -> Result<()> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;

    let client = api::build_client()?;
    let s = api::fetch_settings(&client, &supabase_url, &anon_key, &enrollment.enroll_token).await?;
    *state.settings.lock().await = s;

    // License re-validation. If a license_key is configured we honour it; if not,
    // the agent runs unblocked (legacy enroll-token-only mode is still supported).
    if let Some(key) = cfg.license_key.as_ref() {
        match api::validate_license(&client, &supabase_url, &anon_key, key, Some(&enrollment.org_id)).await {
            Ok(resp) => {
                if resp.valid {
                    state.license_blocked.store(false, Ordering::SeqCst);
                    *state.license_reason.lock().await = None;
                } else {
                    state.license_blocked.store(true, Ordering::SeqCst);
                    *state.license_reason.lock().await =
                        Some(resp.reason.unwrap_or_else(|| "invalid".into()));
                    log::warn!("license blocked — captures paused");
                }
            }
            Err(e) => {
                // Network failure — don't kill the agent over a transient error.
                log::warn!("license re-validation failed (transient): {e}");
            }
        }
    }
    Ok(())
}

/// Capture loops call this before doing any work.
fn license_ok(state: &AppState) -> bool {
    !state.license_blocked.load(Ordering::SeqCst)
}

async fn screenshot_tick(state: &AppState) -> Result<()> {
    if !license_ok(state) { return Ok(()); }
    if !state.settings.lock().await.screenshots_enabled {
        return Ok(());
    }
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;

    // Capture is blocking; run it on the blocking pool to avoid stalling the runtime.
    let frame =
        tokio::task::spawn_blocking(screenshots::capture_primary).await??;

    let client = api::build_client()?;
    api::upload_screenshot(
        &client,
        &supabase_url,
        &anon_key,
        &enrollment.enroll_token,
        &api::UploadScreenshotRequest {
            image_b64: &frame.jpeg_b64,
            taken_at: frame.taken_at.to_rfc3339(),
            reason: Some("interval"),
        },
    )
    .await?;
    Ok(())
}

async fn video_tick(state: &AppState) -> Result<()> {
    if !license_ok(state) { return Ok(()); }
    if !state.settings.lock().await.videos_enabled {
        return Ok(());
    }
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;

    // Recording is blocking and ffmpeg's runtime ≈ clip length.
    let clip = tokio::task::spawn_blocking(video::record_clip).await??;

    let client = api::build_client()?;
    api::upload_video(
        &client,
        &supabase_url,
        &anon_key,
        &enrollment.enroll_token,
        &api::UploadVideoRequest {
            video_b64: &clip.mp4_b64,
            taken_at: clip.taken_at.to_rfc3339(),
            duration_secs: clip.duration_secs,
        },
    )
    .await?;
    Ok(())
}

async fn metrics_tick(state: &AppState) -> Result<()> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;

    let sample = metrics::collect();
    let client = api::build_client()?;
    api::ingest(
        &client,
        &supabase_url,
        &anon_key,
        &enrollment.enroll_token,
        &api::IngestRequest {
            kind: "system_metrics",
            payload: vec![metrics::to_payload(&sample)],
        },
    )
    .await?;
    // After metrics push: check thresholds and emit alerts. Failures are logged but don't break the tick.
    if let Err(e) = maybe_emit_alerts(state, &sample).await {
        log::warn!("alerts emit failed: {e}");
    }
    Ok(())
}

// One-shot: wait for the agent to be enrolled + Supabase-configured, then emit a single
// session_start row. Active-hours calculations and the AgentDetail "Logins" counter use these.
fn spawn_session_start(state: AppState) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..120 {
            // up to ~10 minutes total wait; agent might still be unenrolled.
            if ready(&state).await {
                let payload = json!({
                    "activity_type": "session_start",
                    "application_name": null,
                    "url": null,
                    "duration": 0,
                    "created_at": Utc::now().to_rfc3339(),
                });
                if let Err(e) = push_kind(&state, "activity_logs", payload).await {
                    log::warn!("session_start push failed: {e}");
                }
                return;
            }
            sleep(Duration::from_secs(5)).await;
        }
    });
}

fn spawn_background_loop(state: AppState) {
    spawn_session_start(state.clone());

    // Settings poller — fetches once early, then every SETTINGS_REFRESH_SECS.
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            // Initial small delay so enrollment finishes first if user just signed in.
            sleep(Duration::from_secs(5)).await;
            loop {
                if ready(&state).await {
                    if let Err(e) = settings_tick(&state).await {
                        log::warn!("settings tick failed: {e}");
                    }
                }
                sleep(Duration::from_secs(SETTINGS_REFRESH_SECS)).await;
            }
        });
    }

    // Window poller — runs every WINDOW_POLL_SECS.
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(WINDOW_POLL_SECS)).await;
                if !ready(&state).await {
                    continue;
                }
                if let Err(e) = window_tick(&state).await {
                    log::warn!("window tick failed: {e}");
                    *state.last_error.lock().await = Some(e.to_string());
                }
            }
        });
    }

    // Idle poller — runs every IDLE_POLL_SECS.
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
                if !ready(&state).await {
                    continue;
                }
                if let Err(e) = idle_tick(&state).await {
                    log::warn!("idle tick failed: {e}");
                    *state.last_error.lock().await = Some(e.to_string());
                }
            }
        });
    }

    // Screenshot poller — interval comes from settings (admin-configurable per agent).
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let interval = state.settings.lock().await.screenshot_interval_secs as u64;
                sleep(Duration::from_secs(interval.max(30))).await;
                if !ready(&state).await {
                    continue;
                }
                if let Err(e) = screenshot_tick(&state).await {
                    log::warn!("screenshot tick failed: {e}");
                    *state.last_error.lock().await = Some(e.to_string());
                }
            }
        });
    }

    // Video poller — opt-in per agent. Skipped silently if videos_enabled=false (settings tick).
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let interval = state.settings.lock().await.video_interval_secs as u64;
                sleep(Duration::from_secs(interval.max(60))).await;
                if !ready(&state).await {
                    continue;
                }
                if !state.settings.lock().await.videos_enabled {
                    continue;
                }
                if let Err(e) = video_tick(&state).await {
                    log::warn!("video tick failed: {e}");
                    *state.last_error.lock().await = Some(e.to_string());
                }
            }
        });
    }

    // Metrics poller — runs every METRICS_INTERVAL_SECS.
    tauri::async_runtime::spawn(async move {
        loop {
            sleep(Duration::from_secs(METRICS_INTERVAL_SECS)).await;
            if !ready(&state).await {
                continue;
            }
            if let Err(e) = metrics_tick(&state).await {
                log::warn!("metrics tick failed: {e}");
                *state.last_error.lock().await = Some(e.to_string());
            } else {
                *state.last_sync.lock().await = Some(Utc::now().to_rfc3339());
                *state.last_error.lock().await = None;
            }
        }
    });
}

async fn ready(state: &AppState) -> bool {
    if state.paused.load(Ordering::SeqCst) {
        return false;
    }
    let c = state.config.lock().await;
    c.enrollment.is_some()
        && config::supabase_url(&c).is_some()
        && config::supabase_anon_key(&c).is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// One-shot, no-Tauri uninstall. Invoked via `TrackForce Agent --uninstall` from a packaging
/// uninstall script (or the bundled "Uninstall TrackForce Agent.command" on macOS). Removes:
///   1. The OS-specific autolaunch entry.
///   2. The on-disk config / enrollment dir.
///   3. The installed app/binary itself (best-effort — fails silently if perms forbid).
///
/// Designed to be idempotent: running it twice is harmless. Running it on a partially
/// installed system (e.g. dev builds) cleans up whatever bits exist and ignores the rest.
pub fn uninstall_self() -> Result<()> {
    // 1. Disable autolaunch. We touch each platform's launcher path directly — pulling in
    //    Tauri's autostart plugin would require a running App handle, which we don't have here.
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let plist = home
                .join("Library/LaunchAgents")
                .join("com.trackforce.agent.plist");
            let _ = std::fs::remove_file(&plist);
            // Tauri-plugin-autostart uses the bundle id as launchd label.
            let _ = std::process::Command::new("launchctl")
                .args(["unload", plist.to_str().unwrap_or("")])
                .status();
        }
    }
    #[cfg(target_os = "windows")]
    {
        // HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<value>
        let _ = std::process::Command::new("reg")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "TrackForce Agent",
                "/f",
            ])
            .status();
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            let _ = std::fs::remove_file(home.join(".config/autostart/com.trackforce.agent.desktop"));
        }
    }

    // 2. Wipe agent.json + any sibling state.
    if let Ok(path) = config::config_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // 3. Remove the installed app bundle / binary itself, OS-specific.
    #[cfg(target_os = "macos")]
    {
        // Walk up from the running executable: <bundle>.app/Contents/MacOS/<exe>
        if let Ok(exe) = std::env::current_exe() {
            if let Some(macos_dir) = exe.parent() {
                if let Some(contents) = macos_dir.parent() {
                    if let Some(app_bundle) = contents.parent() {
                        if app_bundle.extension().and_then(|s| s.to_str()) == Some("app") {
                            let _ = std::fs::remove_dir_all(app_bundle);
                        }
                    }
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // On Windows we can't delete the running .exe directly. Schedule a one-shot
        // cmd that retries deletion after we exit. Best-effort.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let dir_str = dir.display().to_string();
                let _ = std::process::Command::new("cmd")
                    .args([
                        "/C",
                        &format!(
                            "ping 127.0.0.1 -n 3 > nul && rmdir /s /q \"{}\"",
                            dir_str
                        ),
                    ])
                    .spawn();
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::fs::remove_file(&exe);
        }
    }

    Ok(())
}

pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    // Record our PID + (re)spawn guardian so a Task-Manager-kill is auto-recovered.
    watchdog::register_agent_and_ensure_guardian();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // No CLI args; the agent decides what to do based on stored enrollment.
            Some(vec![]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            // Hide on close instead of quitting so the agent keeps running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            let cfg = config::load().unwrap_or_default();
            let enrolled = cfg.enrollment.is_some();
            let state = AppState::new(cfg);
            app.manage(state.clone());

            // Stealth mode on macOS: no dock icon, no menu bar — pure background process.
            // The tray icon is also skipped post-enrollment so the user has zero visible UI.
            #[cfg(target_os = "macos")]
            {
                let policy = if enrolled {
                    tauri::ActivationPolicy::Accessory
                } else {
                    tauri::ActivationPolicy::Regular
                };
                let _ = app.set_activation_policy(policy);
            }

            // Show enrollment window only if the agent hasn't been enrolled yet.
            // Once enrolled, the agent is fully silent — no window, no dock, no tray.
            if !enrolled {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                build_tray(app)?;
            }

            spawn_background_loop(state);
            spawn_updater_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            enroll,
            sign_out,
            set_paused,
            set_autostart,
            set_license_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Periodic updater check. Runs once on launch, then every UPDATE_CHECK_INTERVAL_SECS.
// Silently downloads + applies updates if signed manifest endpoint resolves a newer version.
// Failures are logged but never break the agent — the rest of the app keeps running.
fn spawn_updater_loop(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Small initial delay so the rest of setup completes first.
        sleep(Duration::from_secs(20)).await;
        loop {
            if let Err(e) = check_for_update(&handle).await {
                log::warn!("update check failed: {e}");
            }
            sleep(Duration::from_secs(UPDATE_CHECK_INTERVAL_SECS)).await;
        }
    });
}

async fn check_for_update(handle: &tauri::AppHandle) -> Result<()> {
    let updater = handle.updater().map_err(|e| anyhow!(e.to_string()))?;
    if let Some(update) = updater.check().await.map_err(|e| anyhow!(e.to_string()))? {
        log::info!("downloading update {}", update.version);
        update
            .download_and_install(|_chunk_len, _content_len| {}, || {})
            .await
            .map_err(|e| anyhow!(e.to_string()))?;
        log::info!("update installed; restarting");
        handle.restart();
    }
    Ok(())
}

// Builds a minimal system tray with a context menu. Left-click toggles the main window;
// right-click opens the menu.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show TrackForce", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause monitoring", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "Resume monitoring", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &pause, &resume, &quit])?;

    // Use the bundled window icon as the tray icon. Falls back to a tiny embedded square if absent
    // so dev builds don't fail before icons are generated.
    let icon: Image<'_> = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| Image::new_owned(vec![0; 4 * 16 * 16], 16, 16));

    let _ = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("TrackForce Agent")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "pause" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.paused.store(true, Ordering::SeqCst);
                }
            }
            "resume" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.paused.store(false, Ordering::SeqCst);
                }
            }
            "quit" => {
                // Tray "Quit" is an explicit user-initiated stop. Mark graceful so
                // the guardian doesn't immediately respawn the agent.
                watchdog::mark_graceful_shutdown();
                std::process::exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state, .. } = event {
                if matches!(button, MouseButton::Left) && matches!(button_state, MouseButtonState::Up) {
                    if let Some(w) = tray.app_handle().get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}
