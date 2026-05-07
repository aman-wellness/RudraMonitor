// Active window detection. Polled every ~10s; we emit a row to activity_logs only when the
// (process, title) pair changes — so each row represents a single focus session with its real
// duration.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub app_name: String,    // process name, e.g. "chrome", "Code Helper"
    pub window_title: String,
}

#[derive(Debug, Clone)]
pub struct FocusSession {
    pub info: WindowInfo,
    pub started_at: DateTime<Utc>,
}

pub fn current() -> Option<WindowInfo> {
    match active_win_pos_rs::get_active_window() {
        Ok(w) => {
            let proc_basename = std::path::Path::new(&w.process_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let app_name = if !proc_basename.is_empty() {
                proc_basename
            } else {
                w.app_name
            };
            Some(WindowInfo {
                app_name,
                window_title: w.title,
            })
        }
        Err(_) => None,
    }
}

const BROWSERS: &[&str] = &[
    "chrome", "google chrome", "chromium",
    "firefox", "mozilla firefox",
    "safari",
    "msedge", "microsoft edge", "edge",
    "brave", "brave browser",
    "arc",
    "opera",
    "vivaldi",
];

pub fn is_browser(app: &str) -> bool {
    let lower = app.to_lowercase();
    BROWSERS.iter().any(|b| lower.contains(b))
}

/// Build the activity_logs row for a finished focus session.
pub fn to_payload(session: &FocusSession, ended_at: DateTime<Utc>) -> Value {
    let duration = (ended_at - session.started_at).num_seconds().max(0);
    let activity_type = if is_browser(&session.info.app_name) { "browser" } else { "app" };
    json!({
        "activity_type": activity_type,
        "application_name": session.info.app_name,
        "url": session.info.window_title,
        "duration": duration,
        "created_at": session.started_at.to_rfc3339(),
    })
}
