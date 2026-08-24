// Tauri 2 entrypoint. Wires up:
//   - Tauri commands the React UI calls (get_status, enroll, sign_out, save_supabase_config)
//   - A background tokio task that, once enrolled, pushes system metrics every 60s.

mod active_window;
mod api;
mod browser_url;
mod config;
mod dlp;
mod ffmpeg;
mod watchdog;
mod win_proc;

pub use watchdog::{is_guardian_invocation, run_guardian_loop, mark_graceful_shutdown};
mod idle;
mod input;
mod metrics;
mod relay_fallback;
mod screenshots;
mod video;
mod webrtc_stream;
mod whip_publisher;
// Phase-2 Remote Desktop subsystem (RustDesk subprocess + Supabase Realtime
// listener). Completely separate from the LiveKit/WHIP live-monitoring path
// — no shared state, no shared subprocess.
mod remote;

// Native capture + encode pipeline (v0.3.0 spec). Replaces the ffmpeg
// subprocess pipeline on platforms where we have a native path
// implemented. On platforms where we don't yet (Windows + Linux at
// v0.3.0), capture::for_platform() returns Ok(None) and whip_publisher
// falls back to the legacy ffmpeg pump.
mod capture;
// mod encode;  // landing in v0.3.1 alongside Windows + Linux capture.

mod usb_block;
mod wallpaper;
mod schedule;
mod service_install;
#[cfg(target_os = "windows")]
mod signature_deploy;
#[cfg(target_os = "windows")]
mod endpoint_tools;
mod legacy_sweep;

use active_window::{FocusSession, WindowInfo};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use config::{AgentConfig, Enrollment};
use idle::IdleSession;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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
const WINDOW_POLL_SECS: u64 = 5;
// Periodically flush a long-running focus session so the dashboard stays fresh.
// Was 300s — that meant the currently-focused window didn't surface in the
// browser/app tab until the user switched away or 5 full minutes elapsed. 30s
// gives near-realtime visibility: a customer opening Chrome sees "Chrome" in
// the dashboard within 30 seconds at the latest (a fresh switch is detected
// at the next 5s window poll). Combined with the dashboard's Supabase
// Realtime subscription on activity_logs INSERTs, updates land in the UI
// almost instantly once they hit Postgres.
const WINDOW_MAX_SESSION_SECS: i64 = 30;
const SCREENSHOT_INTERVAL_SECS: u64 = 300;
const IDLE_POLL_SECS: u64 = 30;
// Aggressive update cadence: customers reported Windows agents stuck
// on old versions for days because the 30-min interval combined with
// the 20-s startup delay meant agents that came online for short
// sessions (laptop opened, employee checked email, closed laptop)
// often missed every check window. New cadence (v0.3.3+):
//   • Startup check after 3 s (was 20 s) — fires before the user can
//     realistically close the lid again.
//   • 60-second "fast lane" for the first 10 minutes — catches
//     anything published while the machine was offline.
//   • 10-minute steady-state interval (was 30 min) — manifest fetch
//     is ~300 bytes uncompressed; bandwidth cost is negligible vs
//     propagation speed.
const UPDATE_CHECK_STARTUP_DELAY_SECS: u64 = 3;
const UPDATE_CHECK_FAST_INTERVAL_SECS: u64 = 60;
const UPDATE_CHECK_FAST_DURATION_SECS: u64 = 10 * 60;
const UPDATE_CHECK_INTERVAL_SECS: u64 = 10 * 60;
const SETTINGS_REFRESH_SECS: u64 = 60; // 1 min — admin toggles propagate within this window.

// Defaults used when settings can't be fetched yet (first launch, network blip).
const DEFAULT_SETTINGS: api::AgentSettings = api::AgentSettings {
    screenshots_enabled: true,
    active_window_enabled: true,
    screenshot_interval_secs: SCREENSHOT_INTERVAL_SECS as u32,
    idle_threshold_secs: 300,
    videos_enabled: false,
    video_interval_secs: 1800,
    dlp_enabled: false,
    // USB block default ON, wallpaper default enforced. Until first settings
    // fetch lands, this means a fresh enrollment immediately blocks USBs. The
    // toggle in the admin portal flips back within ~60 s of the first poll.
    removable_disks_blocked: true,
    wallpaper_enforced: true,
    wallpaper_url: None,
    wallpaper_updated_at: None,
    tracking_schedule_enabled: false,
    tracking_schedule_json: None,
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
    /// Per-process kill-switches set by capture loops after they detect that
    /// macOS TCC is silently blocking the ad-hoc-signed ffmpeg subprocess.
    /// Without these, the agent prompts the customer for Screen Recording
    /// permission every iteration — the OS re-prompts because the binary
    /// hash doesn't match any stable trust record. Once we observe the
    /// timeout pattern, freeze the loop for the rest of this process so
    /// customers don't get harassed. An agent restart (or v0.2.20+ signed
    /// build) clears the flag and gives macOS another chance.
    video_capture_disabled: Arc<AtomicBool>,
    screenshot_capture_disabled: Arc<AtomicBool>,
    /// Unix-second timestamp of the last successful ingest() call. The
    /// connection watchdog reads this every few seconds; if it's been more
    /// than CONNECTION_STALE_SECS (= 30s) since the last success, the
    /// watchdog forces a fast metrics push to reach out to the server
    /// rather than waiting on the next 5-minute screenshot tick. Backed
    /// by AtomicU64 so we can update it without contending on a Mutex
    /// from every tick.
    last_ingest_unix: Arc<std::sync::atomic::AtomicU64>,
    /// Unix-second timestamp of the previous idle_tick. Used to detect
    /// system sleep: if the gap between two consecutive idle_tick calls
    /// exceeds 3× the normal poll interval, the OS was almost certainly
    /// asleep (the agent's tokio task is paused while the system sleeps,
    /// so the next tick fires immediately after wake-up). We then close
    /// any in-progress idle session at the timestamp BEFORE sleep — sleep
    /// duration must not be counted as user-idle.
    last_idle_tick_unix: Arc<std::sync::atomic::AtomicU64>,
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
            video_capture_disabled: Arc::new(AtomicBool::new(false)),
            screenshot_capture_disabled: Arc::new(AtomicBool::new(false)),
            last_ingest_unix: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            last_idle_tick_unix: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }
}

/// Convenience wrapper around schedule::is_within_tracking_hours that
/// fetches the cached settings from AppState. Capture loops call this
/// before doing any work; if it returns false, the loop sleeps and tries
/// again next tick.
async fn within_hours(state: &AppState) -> bool {
    let s = state.settings.lock().await;
    if !s.tracking_schedule_enabled {
        return true; // no schedule = always track
    }
    schedule::is_within_tracking_hours(s.tracking_schedule_json.as_deref(), Utc::now())
}

/// Threshold for the connection watchdog. If no ingest() has succeeded in
/// this many seconds, the watchdog pushes a fresh heartbeat instead of
/// waiting on the next slow interval (default screenshot tick is 5 min).
const CONNECTION_STALE_SECS: u64 = 30;

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mark_ingest_ok(state: &AppState) {
    state.last_ingest_unix.store(now_unix(), std::sync::atomic::Ordering::Relaxed);
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
    /// The backend this agent will actually talk to, after the env →
    /// agent.json → compiled-default precedence in `config::supabase_url` has
    /// been applied. Shown on the setup screen because an on-disk agent.json
    /// silently outranks the URL compiled into the installer, so "which build
    /// did I install" does not answer "where is it sending my licence key".
    backend_url: Option<String>,
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
        backend_url: config::supabase_url(&cfg),
    })
}

#[tauri::command]
fn set_paused(paused: bool, state: State<'_, AppState>) {
    state.paused.store(paused, Ordering::SeqCst);
}

#[tauri::command]
async fn set_license_key(license_key: String, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<api::ValidateLicenseResponse, String> {
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

    // Once the license is saved, the customer never needs to see the window
    // again unless they explicitly open it from the tray. Hide it so the
    // agent vanishes into the background like a fresh enrollment would.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }

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
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
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
    // Persist the license key alongside the enrollment so the next launch
    // doesn't open the "License Required" prompt for an already-enrolled
    // agent. Without this, license_key stays None on disk and the setup
    // window auto-shows on every reboot.
    cfg.license_key = Some(args.license_key.trim().to_string());
    config::save(&cfg).map_err(|e| e.to_string())?;
    config::consume_prefill();

    // The previous run may have flipped license_blocked to true (stale org
    // binding, expired key, anything that's now resolved). Settings_tick only
    // re-validates every 5 minutes, so without this the agent silently pauses
    // captures for up to 5 min after a fresh enrollment — exactly what tripped
    // the v0.2.9 video-recording report.
    drop(cfg);
    state.license_blocked.store(false, Ordering::SeqCst);
    *state.license_reason.lock().await = None;

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
        &api::IngestRequest { kind, payload: vec![payload], agent_version: env!("CARGO_PKG_VERSION") },
    )
    .await?;
    mark_ingest_ok(state);
    Ok(())
}

async fn push_activity(state: &AppState, payload: Value) -> Result<()> {
    push_kind(state, "activity_logs", payload).await
}

async fn idle_tick(state: &AppState) -> Result<()> {
    // Don't gate idle_tick on within_hours() — we still need to record the
    // "last tick" timestamp every cycle so sleep detection works. But we
    // skip producing any idle activity_logs rows when outside hours.
    let outside_schedule = !within_hours(state).await;
    let threshold = state.settings.lock().await.idle_threshold_secs as u64;
    let now = Utc::now();
    let now_unix_s = now_unix();
    let idle_secs = idle::current_idle_secs().unwrap_or(0);

    // Sleep detection. idle_tick is scheduled every IDLE_POLL_SECS (30 s).
    // When the OS sleeps, the tokio task pauses; on wake-up the next tick
    // fires immediately after a much-larger-than-30s gap. We treat any
    // gap > 3× the poll interval (= 90 s) as "system was asleep" and:
    //   1. Close any in-progress idle session at the timestamp of the
    //      PREVIOUS tick — that's the last point we can confirm the
    //      machine was actually running.
    //   2. Drop the session reference so the post-wake idle counter
    //      starts fresh.
    //   3. Skip emitting an idle row for the sleep gap entirely — sleep
    //      is NOT user-idle (the system was off), so it shouldn't count
    //      toward idle time. The "offline" stretch is already visible
    //      via the heartbeat gap.
    const SLEEP_GAP_THRESHOLD_SECS: u64 = IDLE_POLL_SECS * 3;
    let last_tick = state.last_idle_tick_unix.load(Ordering::SeqCst);
    let gap = now_unix_s.saturating_sub(last_tick);
    state.last_idle_tick_unix.store(now_unix_s, Ordering::SeqCst);

    if last_tick > 0 && gap > SLEEP_GAP_THRESHOLD_SECS {
        let mut current = state.current_idle.lock().await;
        if let Some(s) = current.take() {
            // Close the session at the LAST tick we saw — that's the
            // last point we have evidence the system was running. Anything
            // after that until now was sleep, which we discard.
            drop(current);
            let ended_at = DateTime::<Utc>::from(
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(last_tick),
            );
            // Only emit if the session had a non-trivial duration; sleep
            // happening 5 s into an idle session is just noise.
            if (ended_at - s.started_at).num_seconds() >= threshold as i64 {
                let payload = idle::to_payload(&s, ended_at);
                let _ = push_activity(state, payload).await;
            }
        }
        log::info!("idle_tick: detected sleep gap of {} s; idle session reset", gap);
        // Don't start a new idle session on this tick — let the next
        // tick re-evaluate from a clean slate.
        return Ok(());
    }

    let mut current = state.current_idle.lock().await;
    if idle_secs >= threshold {
        if current.is_none() && !outside_schedule {
            // Backdate started_at to the actual idle start (now − idle_secs).
            *current = Some(IdleSession {
                started_at: now - ChronoDuration::seconds(idle_secs as i64),
            });
        }
        // While idle, do nothing else; final emission happens when the user returns.
        return Ok(());
    }

    // User is active. If we were tracking an idle session, emit it now —
    // but only if we're inside tracking hours (or were when the session
    // started). When outside hours, just discard the session silently.
    if let Some(s) = current.take() {
        // Drop lock before network call.
        drop(current);
        if !outside_schedule {
            let payload = idle::to_payload(&s, now);
            push_activity(state, payload).await?;
        }
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
    if !within_hours(state).await { return Ok(()); }
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

/// Consecutive 401/403/404 responses from `agent-settings`. Reset by the first
/// success. Only an UNBROKEN run reaches the wipe threshold (audit M13).
static SETTINGS_REJECTIONS: AtomicU32 = AtomicU32::new(0);
/// How many consecutive rejections it takes to believe the agent is really gone
/// from the server rather than the backend being mid-restart/mis-deploy. At the
/// settings poll interval this is a couple of minutes — long enough to outlast
/// a gateway restart, short enough that a genuinely deleted agent returns to the
/// setup screen promptly.
const SETTINGS_REJECTIONS_BEFORE_WIPE: u32 = 4;

async fn settings_tick(state: &AppState) -> Result<()> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;

    let client = api::build_client()?;
    let s = match api::fetch_settings(&client, &supabase_url, &anon_key, &enrollment.enroll_token).await {
        Ok(s) => s,
        Err(e) => {
            // ONLY clear enrollment when the server returned an actual HTTP
            // 401 / 403 / 404 (i.e. the agent_id is definitively gone). We
            // detect that via the structured "http_status=" prefix that
            // api::fetch_settings now adds — substring-matching the bare
            // message used to nuke enrollment on transient DNS / connection
            // errors at boot, forcing the user to re-enter their license.
            let msg = e.to_string();
            let server_rejected = msg.contains("http_status=401")
                || msg.contains("http_status=403")
                || msg.contains("http_status=404");
            if server_rejected {
                // Require the rejection to PERSIST before discarding enrollment
                // (audit M13). A single mis-deploy of the agent-settings function
                // returning 404/401 to everyone would otherwise de-enrol the whole
                // fleet at once, forcing every machine to re-enter its licence key.
                // The cost is wildly asymmetric — a wipe is destructive; waiting a
                // few more ticks costs only a stale settings snapshot — so only an
                // unbroken run of rejections clears local config.
                let n = SETTINGS_REJECTIONS.fetch_add(1, Ordering::SeqCst) + 1;
                if n < SETTINGS_REJECTIONS_BEFORE_WIPE {
                    log::warn!(
                        "server rejected enrollment ({msg}) — {n}/{} before clearing; treating as transient",
                        SETTINGS_REJECTIONS_BEFORE_WIPE
                    );
                } else {
                    log::warn!("server rejected enrollment {n}x ({msg}) — clearing local config to re-enroll");
                    let mut cfg_w = state.config.lock().await;
                    cfg_w.enrollment = None;
                    cfg_w.license_key = None;
                    let _ = config::save(&cfg_w);
                    SETTINGS_REJECTIONS.store(0, Ordering::SeqCst);
                }
            } else {
                log::warn!("settings_tick transient error (will retry): {msg}");
            }
            return Err(e);
        }
    };
    // A success clears the rejection streak — only an unbroken run wipes.
    SETTINGS_REJECTIONS.store(0, Ordering::SeqCst);
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
    if !within_hours(state).await { return Ok(()); }
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
    if !license_ok(state) {
        log::info!("video_tick: skip — license blocked");
        return Ok(());
    }
    if !within_hours(state).await {
        log::info!("video_tick: skip — outside tracking schedule");
        return Ok(());
    }
    if !state.settings.lock().await.videos_enabled {
        log::info!("video_tick: skip — videos_enabled=false in cached settings");
        return Ok(());
    }
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;

    log::info!("video_tick: starting record_clip");
    let clip = video::record_clip().await?;
    log::info!(
        "video_tick: recorded {}s clip ({} bytes b64), uploading",
        clip.duration_secs,
        clip.mp4_b64.len()
    );

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

    // metrics::collect() is synchronous and sleeps ~0.75s internally (CPU + net
    // sampling windows). Run it on the blocking pool so it doesn't freeze an
    // async worker thread and stall other agent tasks (audit M12) — mirroring
    // how screenshot capture is already offloaded.
    let sample = tauri::async_runtime::spawn_blocking(metrics::collect)
        .await
        .map_err(|e| anyhow!("metrics collect task failed: {e}"))?;
    let client = api::build_client()?;
    api::ingest(
        &client,
        &supabase_url,
        &anon_key,
        &enrollment.enroll_token,
        &api::IngestRequest {
            kind: "system_metrics",
            payload: vec![metrics::to_payload(&sample)],
            agent_version: env!("CARGO_PKG_VERSION"),
        },
    )
    .await?;
    mark_ingest_ok(state);
    // After metrics push: check thresholds and emit alerts. Failures are logged but don't break the tick.
    if let Err(e) = maybe_emit_alerts(state, &sample).await {
        log::warn!("alerts emit failed: {e}");
    }
    Ok(())
}

/// Connection watchdog. Runs alongside the slow tick loops (metrics every
/// 30s+, screenshots every 5 min by default). If we haven't successfully
/// hit the server in CONNECTION_STALE_SECS (30s), we fire an extra
/// heartbeat — and keep firing every 10s until contact is restored. This
/// matches the customer's "30s disconnect → reconnect" requirement
/// without rewriting the whole transport layer onto a websocket.
async fn connection_watchdog(state: AppState) {
    // Seed the timestamp on startup so we don't immediately think we're
    // offline before any tick has run.
    mark_ingest_ok(&state);
    loop {
        sleep(Duration::from_secs(5)).await;
        if state.paused.load(std::sync::atomic::Ordering::Relaxed) { continue; }
        if !license_ok(&state) { continue; }
        let last = state.last_ingest_unix.load(std::sync::atomic::Ordering::Relaxed);
        if last == 0 { continue; }
        let gap = now_unix().saturating_sub(last);
        if gap < CONNECTION_STALE_SECS { continue; }
        log::warn!("connection_watchdog: {}s since last successful ingest — forcing heartbeat", gap);
        // Reach out via metrics_tick — it's the cheapest payload and any
        // 200 response resets our "last_ingest" clock so the watchdog
        // calms back down. Any error is logged and we'll retry in 5s.
        if let Err(e) = metrics_tick(&state).await {
            log::warn!("connection_watchdog: heartbeat failed: {e}");
        }
    }
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

    // Connection watchdog — fires an extra heartbeat whenever the agent
    // has been silent for >CONNECTION_STALE_SECS (currently 30s). Keeps
    // working through network drops without waiting for the slow 5-minute
    // screenshot tick to retry.
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move { connection_watchdog(state).await });
    }

    // Settings poller — fetches once early, then every SETTINGS_REFRESH_SECS.
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            // Initial small delay so enrollment finishes first if user just signed in.
            sleep(Duration::from_secs(5)).await;
            loop {
                if ready(&state).await {
                    if let Err(e) = settings_tick(&state).await {
                        log::warn!("settings tick failed: {e:#}");
                    }
                }
                // Sleep for the poll interval OR until an admin toggles a
                // setting in the dashboard (realtime `settings.refresh` rings
                // SETTINGS_NOTIFY) — whichever comes first. This is what makes
                // the USB-block toggle take effect in seconds.
                tokio::select! {
                    _ = sleep(Duration::from_secs(SETTINGS_REFRESH_SECS)) => {}
                    _ = SETTINGS_NOTIFY.notified() => {
                        log::info!("settings: refresh bell rung by admin — applying now");
                    }
                }
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
                    log::warn!("window tick failed: {e:#}");
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
                    log::warn!("idle tick failed: {e:#}");
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
                if state.screenshot_capture_disabled.load(Ordering::SeqCst) {
                    continue;
                }
                if !ready(&state).await {
                    continue;
                }
                if let Err(e) = screenshot_tick(&state).await {
                    log::warn!("screenshot tick failed: {e:#}");
                    *state.last_error.lock().await = Some(e.to_string());
                    // We used to permanently disable screenshot capture on macOS
                    // after a single failure to avoid a re-prompt loop. The
                    // re-prompt loop is no longer a concern (we route through
                    // /usr/sbin/screencapture which inherits the parent app's
                    // TCC grant — no per-call dialog), and the permanent-kill
                    // meant a single transient failure on auto-update (or any
                    // brief TCC reset) silently broke screenshots until the user
                    // happened to restart the agent. The customer now had no
                    // working capture for 36+ hours with no signal in the UI.
                    //
                    // Instead, let the natural interval handle retry: if
                    // permission is denied at TCC level, screencapture returns
                    // an error each tick but does not pop a UI dialog, so the
                    // cost is just one log line per interval. On re-grant the
                    // next tick recovers automatically.
                }
            }
        });
    }

    // Video poller. Wake every 30s, check cache state, only fire video_tick
    // when the interval has truly elapsed since the last attempt. Previous
    // implementations sleep'd for `interval` seconds at the top of every
    // iteration — and on startup `interval` is the DEFAULT_SETTINGS value
    // (1800s = 30 minutes) until settings_tick refreshes the cache. That
    // meant the very first recording attempt didn't fire until ~30 minutes
    // after launch, even though settings_tick updated the cache to
    // videos_enabled=true / interval=120s within the first 5 seconds.
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            // Initialise to a very stale instant so the first iteration that
            // satisfies the gating conditions fires immediately.
            let mut last_attempt = tokio::time::Instant::now()
                .checked_sub(Duration::from_secs(86400))
                .unwrap_or_else(tokio::time::Instant::now);
            loop {
                sleep(Duration::from_secs(30)).await;
                let (interval, videos_on) = {
                    let s = state.settings.lock().await;
                    (s.video_interval_secs as u64, s.videos_enabled)
                };
                let blocked = state.license_blocked.load(Ordering::SeqCst);
                let capture_disabled = state.video_capture_disabled.load(Ordering::SeqCst);
                let is_ready = ready(&state).await;
                if capture_disabled {
                    // Don't even log on every iteration — once disabled for the
                    // session, stay silent. A restart clears the flag.
                    continue;
                }
                log::info!(
                    "video poller wake: cache videos_enabled={}, license_blocked={}, interval={}s, agent_ready={}, since_last_attempt={}s",
                    videos_on, blocked, interval.max(60), is_ready,
                    last_attempt.elapsed().as_secs()
                );
                if !is_ready { continue; }
                if !videos_on { continue; }
                if blocked { continue; }
                if last_attempt.elapsed() < Duration::from_secs(interval.max(60)) { continue; }
                last_attempt = tokio::time::Instant::now();
                if let Err(e) = video_tick(&state).await {
                    log::warn!("video tick failed: {e:#}");
                    *state.last_error.lock().await = Some(e.to_string());
                    // Same change as screenshot poller above — no permanent
                    // kill-switch on transient failure. Natural interval
                    // (video_interval_secs, default 30 min) is already wide
                    // enough that a re-try cost is negligible; on permission
                    // re-grant the next attempt recovers automatically.
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
                log::warn!("metrics tick failed: {e:#}");
                *state.last_error.lock().await = Some(e.to_string());
            } else {
                *state.last_sync.lock().await = Some(Utc::now().to_rfc3339());
                *state.last_error.lock().await = None;
            }
        }
    });
}

pub(crate) async fn ready(state: &AppState) -> bool {
    if state.paused.load(Ordering::SeqCst) {
        return false;
    }
    let c = state.config.lock().await;
    c.enrollment.is_some()
        && config::supabase_url(&c).is_some()
        && config::supabase_anon_key(&c).is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// One-shot, no-Tauri uninstall. Invoked via `Rudrans Agent --uninstall` from a packaging
/// uninstall script (or the bundled "Uninstall Rudrans Agent.command" on macOS). Removes:
///   1. The OS-specific autolaunch entry.
///   2. The on-disk config / enrollment dir.
///   3. The installed app/binary itself (best-effort — fails silently if perms forbid).
///
/// Designed to be idempotent: running it twice is harmless. Running it on a partially
/// installed system (e.g. dev builds) cleans up whatever bits exist and ignores the rest.
fn log_file_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return dirs::home_dir().map(|h| h.join("Library/Logs/Rudrans Agent/agent.log"));
    }
    #[cfg(target_os = "windows")]
    {
        return dirs::data_local_dir().map(|d| d.join("RudransAgent").join("logs").join("agent.log"));
    }
    #[cfg(target_os = "linux")]
    {
        return dirs::data_dir().map(|d| d.join("RudransAgent").join("logs").join("agent.log"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    None
}

pub fn uninstall_self() -> Result<()> {
    // 0. Mark graceful shutdown + give the watchdog a moment to notice. Without this
    //    the guardian process polls every 2s and may respawn the agent mid-wipe.
    watchdog::mark_graceful_shutdown();
    std::thread::sleep(std::time::Duration::from_secs(3));

    // 0a. Kill the running agent + guardian by their recorded PIDs (not by image name —
    //    that would kill THIS uninstall process too). We skip our own PID so the
    //    uninstall continues to run.
    let my_pid = std::process::id();
    if let Some(base) = dirs::data_dir() {
        let dir = base.join("RudransAgent");
        for pid_file in &["agent.pid", "guardian.pid"] {
            if let Ok(raw) = std::fs::read_to_string(dir.join(pid_file)) {
                if let Ok(pid) = raw.trim().parse::<u32>() {
                    if pid == my_pid { continue; }
                    #[cfg(target_os = "windows")]
                    {
                        let mut cmd = std::process::Command::new("taskkill");
                        crate::win_proc::no_window(&mut cmd);
                        let _ = cmd.args(["/F", "/PID", &pid.to_string()]).status();
                    }
                    #[cfg(unix)]
                    unsafe {
                        let _ = libc::kill(pid as libc::pid_t, libc::SIGKILL);
                    }
                }
            }
        }
    }
    // Brief pause so the OS releases file handles held by the killed processes.
    std::thread::sleep(std::time::Duration::from_secs(1));

    // 1. Disable autolaunch. We touch each platform's launcher path directly — pulling in
    //    Tauri's autostart plugin would require a running App handle, which we don't have here.
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let plist = home
                .join("Library/LaunchAgents")
                .join("com.wellnessextract.agent.plist");
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
        let mut cmd = std::process::Command::new("reg");
        crate::win_proc::no_window(&mut cmd);
        let _ = cmd.args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "Rudrans Agent",
            "/f",
        ]).status();
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            let _ = std::fs::remove_file(home.join(".config/autostart/com.wellnessextract.agent.desktop"));
        }
    }

    // 2. Wipe agent.json + any sibling state. Retry briefly because on Windows
    //    file handles can linger for a second or two after process termination.
    if let Ok(path) = config::config_path() {
        if let Some(dir) = path.parent() {
            for attempt in 0..5 {
                if std::fs::remove_dir_all(dir).is_ok() { break; }
                std::thread::sleep(std::time::Duration::from_millis(500 * (attempt + 1) as u64));
            }
            // Final fallback on Windows: scheduled cmd that nukes the dir after we exit.
            #[cfg(target_os = "windows")]
            if dir.exists() {
                let dir_str = dir.display().to_string();
                let mut cmd = std::process::Command::new("cmd");
                crate::win_proc::no_window(&mut cmd);
                let _ = cmd.args([
                    "/C",
                    &format!("ping 127.0.0.1 -n 5 > nul && rmdir /s /q \"{}\"", dir_str),
                ]).spawn();
            }
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
                let mut cmd = std::process::Command::new("cmd");
                crate::win_proc::no_window(&mut cmd);
                let _ = cmd.args([
                    "/C",
                    &format!("ping 127.0.0.1 -n 3 > nul && rmdir /s /q \"{}\"", dir_str),
                ]).spawn();
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
    // Persistent file logging. env_logger's default stderr target gets eaten by
    // macOS when the agent is launched via LaunchAgent or the .pkg bundle (and
    // by Windows service host on Windows) — every prior support attempt that
    // asked the customer to redirect stdout into a file came back with a 0-byte
    // log even though the agent was clearly running. Pipe to a known file
    // under the OS Logs directory so a single `cat` always works.
    let log_path = log_file_path();
    let mut builder = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    );
    if let Some(ref p) = log_path {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            builder.target(env_logger::Target::Pipe(Box::new(f)));
        }
    }
    let _ = builder.try_init();
    if let Some(ref p) = log_path {
        log::info!("agent log: {:?}", p);
    }

    // Record our PID + (re)spawn guardian so a Task-Manager-kill is auto-recovered.
    watchdog::register_agent_and_ensure_guardian();

    // Force-register OS-level autostart on every launch. This survives:
    //   • Manual unregistration via system settings — re-registers on next start
    //   • Auto-update to a new install path — re-points at the new binary
    //   • Reboot — OS picks up the registered hook at next boot/login
    // Combined with the in-process guardian (above) which respawns within
    // ~5s of any kill, this gives us true "cannot be permanently killed"
    // behaviour without ever needing UAC elevation or admin install on
    // Windows.
    if let Ok(exe) = std::env::current_exe() {
        service_install::ensure_installed(&exe);
    }

    tauri::Builder::default()
        // Single-instance: if the user double-clicks the app while it's already running
        // (or relaunches it from Spotlight/Start menu), focus the hidden window instead
        // of spawning a second agent process. Without this, every relaunch boots a
        // fresh Tauri instance — which the watchdog then has to fight, and the user
        // may see stale "Loading…" or duplicate license-key prompts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second invocation here usually means the user explicitly relaunched
            // the agent — but it can also fire spuriously after a reboot when
            // LaunchAgent and the watchdog briefly race. Only surface the window
            // if there's no enrollment on disk; otherwise the agent should remain
            // a silent background process exactly as the rebrand spec promised.
            let enrolled_now = config::load().ok()
                .and_then(|c| c.enrollment)
                .is_some();
            if !enrolled_now {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        }))
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

            // macOS activation policy: Accessory = tray-only (no dock icon).
            // Regular = full app with dock. Use Regular ONLY when there is no
            // enrollment at all (fresh install). Anything else — including an
            // enrolled agent that happens to have a missing license_key on
            // disk (legacy v0.2.0 / 0.2.1 bug where enroll() forgot to save
            // license_key) — stays Accessory so the user is never bothered
            // with an unwanted window pop-up. The agent is already operational
            // for those rows; the License Required prompt is reachable via the
            // tray if the user actually wants it.
            #[cfg(target_os = "macos")]
            {
                let policy = if !enrolled {
                    tauri::ActivationPolicy::Regular
                } else {
                    tauri::ActivationPolicy::Accessory
                };
                let _ = app.set_activation_policy(policy);
            }

            // Tray is intentionally hidden once the agent is enrolled — the
            // customer shouldn't have any visible indication that a monitoring
            // tool is running (matches the stealth spec: no dock icon, no
            // menu-bar icon, no window). The tray is ONLY built during the
            // first-run enrollment window so a user launching from the
            // Applications folder has a place to paste the license key.
            // Post-enrollment re-enrollment is an admin task (re-install).
            if !enrolled {
                build_tray(app)?;
            }

            // Re-arm autostart on every launch when the agent is enrolled.
            // We already call `enable()` once at the end of enroll() (line
            // ~325) — but customers reported the agent failing to come back
            // after Windows shutdown/restart. Three reasons that can happen:
            //   • the customer toggled the switch off and forgot,
            //   • a Windows feature-update wiped HKCU\...\Run entries,
            //   • antivirus quarantined the registry value as "startup app".
            // `enable()` is idempotent — if the entry is already correct,
            // it's a no-op. If it's missing, this restores it. We also
            // re-write it on every launch so an auto-update to a new
            // install path immediately repoints autostart at the new exe.
            if enrolled {
                let mgr = app.autolaunch();
                match mgr.enable() {
                    Ok(()) => log::info!("autostart: ensured enabled at boot"),
                    Err(e) => log::warn!("autostart: enable failed: {e}"),
                }
            }

            // Auto-show the main window ONLY on fresh installs (no enrollment
            // saved yet). If the agent has an enrollment, FORCE hide the window
            // — macOS occasionally restores it visible across reboots when the
            // previous session ended with it on screen (e.g. customer just
            // entered their license key and hit Activate). Tauri's default
            // `visible: false` only applies on first show; restoration bypasses
            // that. Explicit .hide() here is what keeps the agent truly silent.
            if let Some(w) = app.get_webview_window("main") {
                if !enrolled {
                    let _ = w.show();
                    let _ = w.set_focus();
                } else {
                    let _ = w.hide();
                }
            }

            // Best-effort orphan ffmpeg cleanup. A previous agent process
            // (or a stuck WebRTC session that left a child holding
            // avfoundation) can monopolise the macOS screen-capture device,
            // which then starves both the screenshot poller AND new
            // recording attempts. Kill any ffmpeg that's still holding our
            // bundled binary path at startup — restricted by argv match so
            // we don't accidentally clobber unrelated ffmpegs the user
            // might be running for their own purposes.
            #[cfg(target_os = "macos")]
            {
                // Match both old and new bundle names. Auto-updates from
                // v0.2.32 (when the bundle was "Rudrans Agent.app") leave
                // the legacy directory in place — pkill catches that too.
                let _ = std::process::Command::new("pkill")
                    .args(["-f", "Security Assistant.app/Contents/Resources/ffmpeg"])
                    .status();
                let _ = std::process::Command::new("pkill")
                    .args(["-f", "Rudrans Agent.app/Contents/Resources/ffmpeg"])
                    .status();
            }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/IM", "ffmpeg.exe"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
            }

            // Remote Desktop input thread. Owns enigo + arboard. Idle
            // unless the WebRTC data channel pushes events at it.
            input::spawn();

            // Sweep stale bundles left over from prior agent identities
            // (TrackForce Agent, Rudrans Agent, com.trackforce.agent .deb).
            // Idempotent per-process via std::sync::Once — customers who
            // updated cleanly see one no-op call per boot, customers with
            // orphan bundles get them removed on the first boot of v0.6.23.
            legacy_sweep::run_once();

            spawn_background_loop(state.clone());
            spawn_updater_loop(app.handle().clone());
            // DLP watcher always starts but loops short-circuit when
            // settings.dlp_enabled is false — admin toggles from the dashboard.
            spawn_dlp_loop(state.clone());
            // USB-block loop: enumerates removable volumes every 5s and unmounts
            // any new ones unless the agent is allowlisted. Always starts; the
            // loop itself reads settings.removable_disks_blocked each iteration.
            spawn_usb_block_loop(state.clone());
            // Wallpaper loop: polls every 60s for a server-side wallpaper URL
            // change; downloads + applies when one appears. Settings-gated by
            // wallpaper_enforced per-agent toggle.
            spawn_wallpaper_loop(state.clone());
            // WebRTC live-monitoring loop. Idle until the dashboard sends an
            // offer through /webrtc-signal; from that point the agent owns
            // an RTCPeerConnection that streams ffmpeg's h264 stdout into a
            // video track until the dashboard closes the session.
            // LiveKit + WHIP publisher is the ONLY screen-streaming
            // path on v0.2.58+. The legacy webrtc_stream loop is
            // disabled (block G of the pivot) — it can no longer race
            // for the OS screen-capture device against the WHIP path
            // and CPU drops by ~30 % at idle (no second ffmpeg
            // standing by). The webrtc_stream module is kept compiled
            // for one more release in case we need to flip the flag
            // back during incident response; the module's spawn is
            // simply not called.
            // Both signalling paths run. They serve different features and
            // neither idles expensively: each is a long-poll that spawns ffmpeg
            // only for the duration of an actual session.
            //
            //   webrtc_stream  — Remote Desktop. Direct peer connection to the
            //                    dashboard with a control DataChannel carrying
            //                    mouse/keyboard/clipboard. Re-enabled here; it
            //                    was parked as a dead-code anchor when Live View
            //                    moved to LiveKit, which left the agent able to
            //                    be remote-controlled with no dashboard to do
            //                    it from.
            //   whip_publisher — Live View. One-way screen share into a LiveKit
            //                    room, which fans out to multiple viewers.
            //
            // The CPU concern that motivated parking this was a SECOND ffmpeg
            // standing by. That is not what happens: the encoder is spawned
            // inside a session and killed when the peer connection closes, so an
            // idle agent runs neither.
            webrtc_stream::spawn_streaming_loop(state.clone());
            whip_publisher::spawn_whip_loop(state.clone());

            // Phase-2 Remote Desktop. Subscribes to Supabase Realtime
            // channel `agent:<id>`, dispatches remote.request → consent →
            // bundled rustdesk subprocess. Inert (logs + denies) until
            // the rustdesk binary lands in resources/ via Block 3.2.
            remote::spawn(state, app.handle().clone());
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
// DLP USB-transfer watcher. Reconciles attached removable drives every 5s and
// posts file events to the dashboard via dlp-ingest. The edge fn handles AI
// classification + email alerts on its side.
fn spawn_dlp_loop(state: AppState) {
    use std::sync::Arc;
    use tokio::sync::mpsc;

    // Tokio unbounded channel — `send()` is sync (never blocks), so we can call
    // it from the synchronous notify watcher thread. Drain happens in async land.
    let (tx, mut rx) = mpsc::unbounded_channel::<dlp::DlpFileEvent>();
    let sink: Arc<dyn Fn(dlp::DlpFileEvent) + Send + Sync> = Arc::new(move |ev| {
        let _ = tx.send(ev);
    });
    let watcher = Arc::new(dlp::DlpWatcher::new(sink));

    // Reconcile loop — discovers new USB drives, drops detached ones.
    let w_clone = watcher.clone();
    let reconcile_state = state.clone();
    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_secs(15)).await;  // let the rest of startup finish
        loop {
            // Server-controlled gate. When admin disables DLP, we drop all
            // currently-watched filesystem watchers (releasing IO handles) and
            // sleep idle until the setting flips back on.
            let enabled = reconcile_state.settings.lock().await.dlp_enabled
                && within_hours(&reconcile_state).await;
            if !enabled {
                w_clone.clear();
                sleep(Duration::from_secs(30)).await;
                continue;
            }
            w_clone.reconcile();
            sleep(Duration::from_secs(5)).await;
        }
    });

    // Drain loop — converts each captured file event into a dlp-ingest POST.
    let drain_state = state.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let Err(e) = post_dlp_event(&drain_state, ev).await {
                log::warn!("dlp post failed: {e}");
            }
        }
    });

    // Email-compose tracker — poll every 5s when DLP is enabled. Combined with
    // the tracker's emit-on-first-detection behaviour (min_session_secs=0) this
    // surfaces a Gmail / personal-mail visit in the dashboard within ~5 seconds
    // of the tab being opened. Each poll is still cheap (one UIA tree walk on
    // Windows, ~50ms).
    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_secs(20)).await;
        let mut tracker = dlp::EmailComposeTracker::default();
        loop {
            let enabled = state.settings.lock().await.dlp_enabled
                && within_hours(&state).await;
            if !enabled {
                sleep(Duration::from_secs(30)).await;
                continue;
            }
            let aw = active_window::current();
            let url = aw.as_ref().and_then(|w| w.url.clone());
            let evt = tracker.observe(url.as_deref());
            if let Some(e) = evt {
                let active_w = aw.as_ref().map(|w| format!("{} — {}", w.app_name, w.window_title));
                let payload = dlp::email_event_payload(&e, active_w);
                if let Err(err) = post_dlp_payload(&state, &payload).await {
                    log::warn!("dlp email post failed: {err}");
                }
            }
            sleep(Duration::from_secs(5)).await;
        }
    });
}

/// USB-block enforcement loop. Independent of DLP — DLP watches files
/// being copied; usb_block prevents the disk from being usable at all.
/// Per-agent allowlist via `settings.removable_disks_blocked = false`,
/// which also triggers auto-remount of anything we previously ejected.
fn spawn_usb_block_loop(state: AppState) {
    tauri::async_runtime::spawn(async move {
        // Let enrollment + first settings_tick land before we start ejecting
        // disks. Avoids a fresh install ejecting the customer's USB-installed
        // license dongle before the admin has a chance to allowlist them.
        sleep(Duration::from_secs(15)).await;
        let mut blocker = usb_block::UsbBlocker::new();
        loop {
            // Outside tracking schedule = treat policy as OFF (allow USBs).
            // This way employees can use external storage on personal time
            // without admin intervention. Drives auto-remount as soon as
            // the schedule lapses, just like a manual toggle-off.
            let in_hours = within_hours(&state).await;
            let enabled = in_hours && state.settings.lock().await.removable_disks_blocked;
            let (blocked, remounted) = blocker.reconcile(enabled);
            // Log block + remount events so the admin sees the audit trail.
            // Best effort — if the post fails we don't retry; the local log
            // line is still produced inside usb_block::reconcile.
            for d in blocked {
                let payload = serde_json::json!({
                    "event_type": "usb_blocked",
                    "device_name": d.label,
                    "mount_point": d.mount_point.to_string_lossy(),
                });
                if let Err(e) = post_dlp_payload(&state, &payload).await {
                    log::warn!("usb_block: block post failed: {e}");
                }
            }
            for id in remounted {
                let payload = serde_json::json!({
                    "event_type": "usb_remounted",
                    "device_name": id.clone(),
                    "mount_point": id,
                });
                if let Err(e) = post_dlp_payload(&state, &payload).await {
                    log::warn!("usb_block: remount post failed: {e}");
                }
            }
            sleep(Duration::from_secs(5)).await;
        }
    });
}

/// Wallpaper enforcement loop. Polls `state.settings` (refreshed every 60 s
/// by settings_tick) for a server-side wallpaper URL change; downloads and
/// applies the new image when seen. Per-agent exempt via `wallpaper_enforced`.
fn spawn_wallpaper_loop(state: AppState) {
    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_secs(20)).await;
        let mut wm = wallpaper::WallpaperManager::new();
        loop {
            // Wallpaper enforcement intentionally bypasses the schedule
            // gate. A wallpaper change is a one-shot apply (downloaded
            // image written to the OS), not a continuous "capture"
            // activity, and the wallpaper should reflect the org branding
            // 24/7 — including during off-hours when the user logs in
            // briefly for personal stuff. If admin doesn't want that,
            // the per-agent wallpaper_enforced toggle still works.
            let snap = {
                let s = state.settings.lock().await;
                (
                    s.wallpaper_enforced,
                    s.wallpaper_url.clone(),
                    s.wallpaper_updated_at.clone(),
                )
            };
            let (enforced, url, updated_at) = snap;
            if let Err(e) = wm.tick(enforced, url.as_deref(), updated_at.as_deref()).await {
                log::warn!("wallpaper tick failed: {e:#}");
            }
            sleep(Duration::from_secs(60)).await;
        }
    });
}

/// Generic POST helper used by both USB and email watchers.
async fn post_dlp_payload(state: &AppState, payload: &serde_json::Value) -> Result<()> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.clone().ok_or_else(|| anyhow!("not enrolled"))?;
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let client = api::build_client()?;
    api::dlp_ingest(&client, &supabase_url, &anon_key, &enrollment.enroll_token, payload).await
}

async fn post_dlp_event(state: &AppState, ev: dlp::DlpFileEvent) -> Result<()> {
    // Active window snapshot for context — useful for the AI classifier.
    let active_window = active_window::current()
        .map(|w| format!("{} — {}", w.app_name, w.window_title));
    let payload = dlp::to_payload(&ev, active_window);
    post_dlp_payload(state, &payload).await
}

/// Admin-triggered "check for update NOW" bell. The updater loop selects
/// on `sleep(interval)` OR `UPDATE_NOTIFY.notified()`; the realtime
/// `agent.update_now` handler rings it so the loop skips the rest of its
/// sleep and hits `check_for_update()` immediately. Without this, an
/// agent would only find a new release on its next 10-min steady-state
/// poll, and admins had no way to force the check.
///
/// Wrapped in `Lazy` because tokio's Notify needs a runtime handle for
/// creation on some setups; module-static gives us a single instance
/// shared between `spawn_updater_loop` (consumer) and
/// `force_update_now` in remote/realtime_listener.rs (producer).
pub static UPDATE_NOTIFY: once_cell::sync::Lazy<std::sync::Arc<tokio::sync::Notify>> =
    once_cell::sync::Lazy::new(|| std::sync::Arc::new(tokio::sync::Notify::new()));

/// Trigger a check-for-update from anywhere in the agent (called by the
/// realtime `agent.update_now` handler). Non-blocking; the actual work
/// happens inside `spawn_updater_loop` the moment its sleep is
/// interrupted.
pub fn wake_updater() {
    UPDATE_NOTIFY.notify_one();
}

/// Admin-toggled "apply settings NOW" bell. The settings poller selects on
/// `sleep(SETTINGS_REFRESH_SECS)` OR `SETTINGS_NOTIFY.notified()`; the realtime
/// `settings.refresh` handler rings it the instant an admin changes a per-agent
/// setting (e.g. the USB-block toggle) in the dashboard, so it takes effect in
/// seconds instead of waiting up to a full poll interval. Same shape as the
/// updater bell above.
pub static SETTINGS_NOTIFY: once_cell::sync::Lazy<std::sync::Arc<tokio::sync::Notify>> =
    once_cell::sync::Lazy::new(|| std::sync::Arc::new(tokio::sync::Notify::new()));

/// Ring the settings bell (called by the realtime `settings.refresh` handler).
pub fn wake_settings() {
    SETTINGS_NOTIFY.notify_one();
}

fn spawn_updater_loop(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Tight startup window — fires before the user has a chance to
        // close their laptop again on a quick-session machine. 3 s is
        // long enough for Tauri setup + system tray to settle.
        sleep(Duration::from_secs(UPDATE_CHECK_STARTUP_DELAY_SECS)).await;

        // Latch flipped ONCE per process lifetime the moment
        // `download_and_install` returns Ok. Any further check() call
        // from this doomed process would re-fire the install because
        // our binary's baked-in version (env!("CARGO_PKG_VERSION"))
        // is still older than latest.json until the installer swaps
        // files. Windows especially: NSIS-passive install can take
        // 30-60 s to fully replace the exe, and during that window a
        // second check() → second installer → double-install crash
        // was observed in v0.6.7 as a "continuous update" loop.
        let install_fired = std::sync::Arc::new(
            std::sync::atomic::AtomicBool::new(false)
        );

        // FAST LANE: for the first 10 minutes after boot, check every
        // 60 s. This is where most missed-update scenarios live —
        // machine was offline when v0.X.Y was released, comes online
        // briefly, the old 30-min interval would still miss the
        // window. With this loop the agent will fetch the latest within
        // 1 min of being online.
        let fast_lane_deadline = std::time::Instant::now()
            + Duration::from_secs(UPDATE_CHECK_FAST_DURATION_SECS);
        while std::time::Instant::now() < fast_lane_deadline
            && !install_fired.load(std::sync::atomic::Ordering::SeqCst)
        {
            if let Err(e) = check_for_update(&handle, &install_fired).await {
                log::warn!("update check (fast) failed: {e}");
            }
            // Sleep for the fast-lane interval OR until an admin rings the
            // update bell — whichever comes first.
            tokio::select! {
                _ = sleep(Duration::from_secs(UPDATE_CHECK_FAST_INTERVAL_SECS)) => {},
                _ = UPDATE_NOTIFY.notified() => {
                    log::info!("updater: bell rung by admin — checking now");
                }
            }
        }

        // STEADY STATE: every 10 min forever. Combined with the fast
        // lane above, this gives us:
        //   • <1 min from publish to install if agent is online at
        //     publish time.
        //   • <1 min from agent-online to install if agent comes back
        //     online after a publish.
        //   • <10 min in any other steady-state edge case.
        //
        // Post-install the latch keeps us silent so we don't fight the
        // running installer. Loop kept alive (rather than returning)
        // so the process stays observable in `ps` — the installer
        // will kill us as part of its file-swap step.
        loop {
            if !install_fired.load(std::sync::atomic::Ordering::SeqCst) {
                if let Err(e) = check_for_update(&handle, &install_fired).await {
                    log::warn!("update check failed: {e}");
                }
            }
            // Same select trick in steady state — admin can force a check
            // without waiting the full 10-min interval.
            tokio::select! {
                _ = sleep(Duration::from_secs(UPDATE_CHECK_INTERVAL_SECS)) => {},
                _ = UPDATE_NOTIFY.notified() => {
                    log::info!("updater: bell rung by admin — checking now");
                }
            }
        }
    });
}

async fn check_for_update(
    handle: &tauri::AppHandle,
    install_fired: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    // Customers reported "agents not updating" — add structured logs at
    // every step so we can read /tmp/wellness-extract-agent.log (mac) or
    // %LOCALAPPDATA%\com.wellnessextract.agent\logs\… (win) to see which step
    // failed without needing remote access.
    let current = env!("CARGO_PKG_VERSION");
    log::info!("updater: checking for update (current version {current})");
    let updater = handle.updater().map_err(|e| {
        log::warn!("updater: handle.updater() failed: {e}");
        anyhow!(e.to_string())
    })?;
    let check_result = updater.check().await.map_err(|e| {
        log::warn!("updater: check() failed: {e}");
        anyhow!(e.to_string())
    })?;
    match check_result {
        None => {
            log::info!("updater: no update available (current {current})");
        }
        Some(update) => {
            log::info!("updater: update {} available, downloading + installing", update.version);
            let mut bytes_seen: u64 = 0;
            let result = update
                .download_and_install(
                    |chunk_len, total_len| {
                        bytes_seen += chunk_len as u64;
                        if let Some(total) = total_len {
                            // Log only at the start and end so we don't spam.
                            if bytes_seen == chunk_len as u64 {
                                log::info!("updater: download started ({total} bytes)");
                            } else if bytes_seen >= total {
                                log::info!("updater: download complete ({total} bytes)");
                            }
                        }
                    },
                    || log::info!("updater: install starting (installer process spawned)"),
                )
                .await;
            match result {
                Ok(_) => {
                    // Latch stops the polling loop from firing check()
                    // again while the installer works. Prevents the
                    // v0.6.7 "continuous update" loop where fast-lane
                    // hit check() every 60 s, saw our still-old baked
                    // version < latest.json, and spawned a second
                    // concurrent installer over the first.
                    install_fired.store(true, std::sync::atomic::Ordering::SeqCst);
                    log::info!("updater: install kicked off — suppressing further checks");

                    // macOS: download_and_install is SYNCHRONOUS with the
                    // .app.tar.gz extract + swap. When Ok() returns, the
                    // new .app is on disk. But — unlike NSIS on Windows —
                    // Tauri's Mac updater does NOT spawn a relauncher, so
                    // the OLD running process keeps executing indefinitely
                    // with install_fired latched forever. Result: the Mac
                    // catches ONE update then goes silent for all future
                    // versions. That's how every macOS agent got stranded
                    // on v0.6.18 while Windows kept marching forward.
                    //
                    // Fix: exit(0) after a successful Mac install. The
                    // LaunchAgent (KeepAlive=true) respawns us from the
                    // just-swapped /Applications/Security Assistant.app,
                    // which is the NEW version, with install_fired=false.
                    //
                    // Windows path is left untouched — NSIS relaunches
                    // the fresh exe itself once its file-swap finishes,
                    // and we must NOT beat it to the punch.
                    #[cfg(target_os = "macos")]
                    {
                        log::info!("updater: macOS — exiting so LaunchAgent respawns the new .app");
                        // Give the log a moment to flush before we die.
                        sleep(Duration::from_millis(500)).await;
                        std::process::exit(0);
                    }
                }
                Err(e) => {
                    // Windows: most common failure modes are UAC declined,
                    // running .exe file-locked, or missing admin token.
                    // Don't propagate the error — keep the loop alive so the
                    // next 10-min tick retries.
                    log::warn!("updater: download_and_install failed: {e}");
                }
            }
        }
    }
    Ok(())
}

// Builds a minimal system tray with a context menu. Left-click toggles the main window;
// right-click opens the menu.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Security Assistant", true, None::<&str>)?;
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
        .tooltip("Security Assistant")
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
