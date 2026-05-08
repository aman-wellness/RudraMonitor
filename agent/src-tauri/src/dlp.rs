// DLP (Data Loss Prevention) — USB transfer watcher.
//
// Strategy:
//   1. Every 5s, list currently-mounted removable drives (Windows DRIVE_REMOVABLE
//      via GetLogicalDrives, macOS /Volumes/* with diskutil info -removable check,
//      Linux /proc/mounts + sysfs `removable` flag).
//   2. Diff against last poll. New drives → spin up a `notify` watcher on the
//      drive root.
//   3. On file CREATE/MODIFY events from the watcher, debounce ~2s to avoid
//      partial-copy noise, then capture: file path, size, mime (best-effort),
//      SHA-256 hash. Emit a dlp_events row via api::dlp_ingest.
//
// Browser email-upload detection lives in browser_url.rs (separate concern).

use anyhow::{Context, Result};
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct RemovableDrive {
    pub mount_point: PathBuf,
    pub label: String,
}

/// Cross-platform listing of currently-attached removable drives.
pub fn list_removable() -> Vec<RemovableDrive> {
    #[cfg(target_os = "windows")] { windows_drives() }
    #[cfg(target_os = "macos")]   { macos_drives() }
    #[cfg(target_os = "linux")]   { linux_drives() }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    { Vec::new() }
}

#[cfg(target_os = "windows")]
fn windows_drives() -> Vec<RemovableDrive> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    // DRIVE_REMOVABLE = 2 (Win32 docs). Hard-coding the constant rather than importing
    // it because the windows-rs feature flag for this re-export shifts between versions
    // and pulling it in on the wrong feature breaks the build with confusing "no
    // DRIVE_REMOVABLE in this module" errors.
    const DRIVE_REMOVABLE: u32 = 2;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26 {
        if mask & (1 << i) == 0 { continue; }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{}:\\", letter);
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) };
        if kind != DRIVE_REMOVABLE { continue; }
        // Volume label
        let mut label_buf = [0u16; 256];
        let label = unsafe {
            if GetVolumeInformationW(
                windows::core::PCWSTR(wide.as_ptr()),
                Some(&mut label_buf),
                None, None, None, None,
            ).is_ok() {
                let len = label_buf.iter().position(|&c| c == 0).unwrap_or(0);
                String::from_utf16_lossy(&label_buf[..len])
            } else {
                String::new()
            }
        };
        out.push(RemovableDrive { mount_point: PathBuf::from(&root), label });
    }
    out
}

#[cfg(target_os = "macos")]
fn macos_drives() -> Vec<RemovableDrive> {
    let entries = match std::fs::read_dir("/Volumes") { Ok(e) => e, Err(_) => return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let label = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        // Skip the boot volume — usually named "Macintosh HD"
        if label == "Macintosh HD" || label.is_empty() { continue; }
        // Use diskutil to confirm removable. Cheap call (~30ms), runs only on diff.
        let output = std::process::Command::new("diskutil")
            .arg("info").arg(&path).output();
        if let Ok(o) = output {
            let s = String::from_utf8_lossy(&o.stdout);
            // diskutil output includes "Removable Media:           Yes" for USB sticks
            if s.contains("Removable Media:") && s.contains("Yes") {
                out.push(RemovableDrive { mount_point: path, label });
                continue;
            }
            // Network mounts have "Protocol: SMB" etc., skip those
            if s.contains("Protocol:") && !s.contains("USB") && !s.contains("Thunderbolt") {
                continue;
            }
            // Fallback: external + ejectable counts as removable
            if s.contains("Ejectable:") && s.contains("Yes") {
                out.push(RemovableDrive { mount_point: path, label });
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn linux_drives() -> Vec<RemovableDrive> {
    let mounts = match std::fs::read_to_string("/proc/mounts") { Ok(s) => s, Err(_) => return Vec::new() };
    let mut out = Vec::new();
    for line in mounts.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 { continue; }
        let dev = parts[0];
        let mount = parts[1];
        // /dev/sdb1 → check /sys/block/sdb/removable == 1
        if !dev.starts_with("/dev/sd") && !dev.starts_with("/dev/mmcblk") { continue; }
        let base = dev.trim_start_matches("/dev/").trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
        let removable_path = format!("/sys/block/{}/removable", base);
        if let Ok(s) = std::fs::read_to_string(&removable_path) {
            if s.trim() == "1" {
                out.push(RemovableDrive {
                    mount_point: PathBuf::from(mount),
                    label: PathBuf::from(mount).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
                });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Watcher state — shared across all currently-watched drives
// ---------------------------------------------------------------------------

pub type DlpEventSink = Arc<dyn Fn(DlpFileEvent) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct DlpFileEvent {
    pub event_type: &'static str,           // "usb_transfer"
    pub direction: &'static str,            // "to_external" | "from_external"
    pub device_name: String,                // drive label
    pub mount_point: String,
    pub file_path: String,
    pub file_name: String,
    pub file_size_bytes: u64,
    pub file_hash_sha256: Option<String>,
    pub active_window: Option<String>,
}

pub struct DlpWatcher {
    drives: Arc<StdMutex<HashMap<PathBuf, Debouncer<notify::RecommendedWatcher>>>>,
    sink: DlpEventSink,
}

impl DlpWatcher {
    pub fn new(sink: DlpEventSink) -> Self {
        Self { drives: Arc::new(StdMutex::new(HashMap::new())), sink }
    }

    /// Run one reconciliation pass: start watching newly-attached drives, drop
    /// watchers for drives that were unmounted.
    pub fn reconcile(&self) {
        let current: HashSet<PathBuf> = list_removable().iter().map(|d| d.mount_point.clone()).collect();
        let mut drives = self.drives.lock().unwrap();

        // Stop watching drives that disappeared
        let stale: Vec<PathBuf> = drives.keys().filter(|k| !current.contains(*k)).cloned().collect();
        for key in stale {
            drives.remove(&key);
            log::info!("DLP: stopped watching {}", key.display());
        }

        // Add watchers for new drives
        let known: HashSet<PathBuf> = drives.keys().cloned().collect();
        for drive in list_removable() {
            if known.contains(&drive.mount_point) { continue; }
            match start_watcher(&drive, self.sink.clone()) {
                Ok(d) => {
                    log::info!("DLP: watching {} ({})", drive.mount_point.display(), drive.label);
                    drives.insert(drive.mount_point, d);
                }
                Err(e) => log::warn!("DLP: failed to watch {}: {}", drive.mount_point.display(), e),
            }
        }
    }
}

fn start_watcher(
    drive: &RemovableDrive,
    sink: DlpEventSink,
) -> Result<Debouncer<notify::RecommendedWatcher>> {
    let (tx, rx) = mpsc::channel();
    let mut debouncer = new_debouncer(Duration::from_secs(2), tx)
        .context("create debouncer")?;
    debouncer.watcher()
        .watch(&drive.mount_point, RecursiveMode::Recursive)
        .with_context(|| format!("watch {}", drive.mount_point.display()))?;

    // Spawn a background thread that drains events and forwards to the sink.
    let drive_clone = drive.clone();
    std::thread::spawn(move || {
        for res in rx {
            let events = match res { Ok(e) => e, Err(e) => { log::warn!("DLP watcher: {:?}", e); continue; } };
            for ev in events {
                if ev.kind != DebouncedEventKind::Any { continue; }
                let path = &ev.path;
                if !path.is_file() { continue; }
                let meta = match std::fs::metadata(path) { Ok(m) => m, Err(_) => continue };
                let size = meta.len();
                // Skip empty / weirdly-large files (>2 GB hash is too expensive)
                if size == 0 { continue; }
                let hash = if size <= 200 * 1024 * 1024 {
                    sha256_of(path).ok()
                } else { None };
                let file_event = DlpFileEvent {
                    event_type: "usb_transfer",
                    direction: "to_external",  // file appearing on USB drive = copy TO external
                    device_name: drive_clone.label.clone(),
                    mount_point: drive_clone.mount_point.display().to_string(),
                    file_path: path.display().to_string(),
                    file_name: path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
                    file_size_bytes: size,
                    file_hash_sha256: hash,
                    active_window: None,  // caller fills this in
                };
                (sink)(file_event);
            }
        }
    });
    Ok(debouncer)
}

fn sha256_of(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Convert a DlpFileEvent into the JSON body expected by the dlp-ingest edge fn.
pub fn to_payload(ev: &DlpFileEvent, active_window: Option<String>) -> serde_json::Value {
    json!({
        "event_type":      ev.event_type,
        "direction":       ev.direction,
        "device_name":     ev.device_name,
        "device_type":     "mass_storage",
        "file_path":       ev.file_path,
        "file_name":       ev.file_name,
        "file_size_bytes": ev.file_size_bytes,
        "file_hash_sha256": ev.file_hash_sha256,
        "active_window":   active_window,
        "occurred_at":     chrono::Utc::now().to_rfc3339(),
    })
}

// ---------------------------------------------------------------------------
// Email-compose session tracker
// ---------------------------------------------------------------------------
//
// Watches whether the user is on a personal-mail compose page for an extended
// duration (default 30s). When the threshold is crossed we emit ONE
// dlp_events row (event_type=email_attachment) per session — the AI classifier
// scores it based on the policy + authorized_domains. This is intentionally
// conservative: better to emit one session-level event than spam events for
// every focus tick.
//
// A single session = continuous focus on the same mail provider URL, broken
// when the user navigates away for > 60 seconds or focuses a different app.

use std::time::Instant;

#[derive(Debug, Clone)]
pub struct EmailSession {
    pub provider: String,
    pub url: String,
    pub started_at: Instant,
    pub last_seen: Instant,
    pub emitted: bool,
}

pub struct EmailComposeTracker {
    current: Option<EmailSession>,
    /// Threshold (seconds) — only emit events for sessions longer than this.
    pub min_session_secs: u64,
}

impl Default for EmailComposeTracker {
    fn default() -> Self { Self { current: None, min_session_secs: 30 } }
}

#[derive(Debug, Clone)]
pub struct EmailEvent {
    pub provider: String,
    pub url: String,
    pub session_secs: u64,
}

impl EmailComposeTracker {
    /// Call on every focus tick. `current_url` is the active browser tab URL
    /// (None if not a browser). Returns Some(EmailEvent) the first time a
    /// personal-mail session crosses the threshold; subsequent ticks of the
    /// same session return None.
    pub fn observe(&mut self, current_url: Option<&str>) -> Option<EmailEvent> {
        let now = Instant::now();
        let provider = current_url.and_then(crate::browser_url::personal_mail_provider);

        match (provider, &mut self.current) {
            // Same session continuing
            (Some(p), Some(s)) if s.url == current_url.unwrap_or("") || s.provider == p => {
                s.last_seen = now;
                let dur = now.duration_since(s.started_at).as_secs();
                if !s.emitted && dur >= self.min_session_secs {
                    s.emitted = true;
                    return Some(EmailEvent {
                        provider: s.provider.clone(),
                        url: s.url.clone(),
                        session_secs: dur,
                    });
                }
                None
            }
            // New mail session begins (or provider switched)
            (Some(p), _) => {
                self.current = Some(EmailSession {
                    provider: p.to_string(),
                    url: current_url.unwrap_or("").to_string(),
                    started_at: now,
                    last_seen: now,
                    emitted: false,
                });
                None
            }
            // No personal-mail focus
            (None, Some(s)) => {
                // 60s grace — user might've alt-tabbed briefly to grab a file
                if now.duration_since(s.last_seen).as_secs() > 60 {
                    self.current = None;
                }
                None
            }
            (None, None) => None,
        }
    }
}

pub fn email_event_payload(ev: &EmailEvent, active_window: Option<String>) -> serde_json::Value {
    json!({
        "event_type":     "email_attachment",
        "direction":      "to_external",
        "mail_provider":  ev.provider,
        "mail_url":       ev.url,
        "active_window":  active_window,
        // file_name / file_size are unknown without picker hooks — AI sees
        // mail_provider + url + window context and classifies on policy.
        "occurred_at":    chrono::Utc::now().to_rfc3339(),
    })
}
