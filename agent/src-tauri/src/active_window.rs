// Active window detection. Polled every ~10s; we emit a row to activity_logs only when the
// (process, title, url) triple changes — so each row represents a single focus session
// with its real duration. Including URL means tab switches inside the same browser
// also create distinct sessions, which is what we want for analytics.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::browser_url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub app_name: String,
    pub window_title: String,
    /// For browsers only: the active tab URL (extracted via osascript on macOS).
    /// None for non-browsers, or when extraction failed (e.g. Firefox, missing
    /// Automation permission).
    pub url: Option<String>,
    /// For browsers only: the active tab title (often more useful than the
    /// OS-level window title which is usually just "Browser Name").
    pub page_title: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FocusSession {
    pub info: WindowInfo,
    pub started_at: DateTime<Utc>,
}

pub fn current() -> Option<WindowInfo> {
    let w = active_win_pos_rs::get_active_window().ok()?;
    let proc_basename = std::path::Path::new(&w.process_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    let app_name = if !proc_basename.is_empty() { proc_basename } else { w.app_name.clone() };

    // For browsers, try to enrich with the active tab's URL + title.
    // This is the slow path (~50ms osascript / ~120ms powershell). We only do
    // it when we've already established the focused window IS a browser.
    let (mut url, mut page_title) = if is_browser(&app_name) {
        match browser_url::current_for_app(&w.app_name).or_else(|| browser_url::current_for_app(&app_name)) {
            Some(ctx) => (ctx.url, ctx.page_title),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    // Fallback: when URL/title extraction fails (no permission, unsupported
    // browser, headless ChromeDriver, …), try parsing the OS-level window
    // title. Chromium and Edge use "Page Title - Browser Name"; Safari uses
    // just "Page Title". This rescues the PAGE TITLE column even when the
    // address bar can't be read.
    if is_browser(&app_name) && page_title.is_none() && !w.title.is_empty() {
        let candidates = [
            " - Google Chrome", " - Chromium", " - Microsoft\u{200b}\u{2009}Edge",
            " - Microsoft Edge", " - Microsoft\u{00a0}Edge",
            " - Brave", " - Mozilla Firefox", " - Firefox",
            " - Opera", " - Vivaldi", " - Arc",
        ];
        let mut t = w.title.clone();
        for suffix in candidates {
            if let Some(stripped) = t.strip_suffix(suffix) {
                t = stripped.to_string();
                break;
            }
        }
        if !t.is_empty() && t != w.title {
            page_title = Some(t);
        } else if url.is_none() {
            // No suffix matched — keep the raw title so the user at least sees
            // SOMETHING in the Page Title column.
            page_title = Some(w.title.clone());
        }
    }
    let _ = &mut url;  // (silences unused-mut on platforms where url is never reassigned)

    Some(WindowInfo {
        app_name,
        window_title: w.title,
        url,
        page_title,
    })
}

// Known browser process names (matched against proc_basename, case-insensitive).
// Exact-match list — substring matching previously caused false positives like
// SearchHost.exe (Windows Search UI is Chromium-based) being classified as Edge.
const BROWSER_PROCESSES: &[&str] = &[
    "chrome", "google chrome", "chromium",
    "firefox", "mozilla firefox",
    "safari",
    "msedge", "microsoft edge",
    "brave browser", "brave",
    "arc",
    "opera", "opera gx",
    "vivaldi",
    "thorium", "ungoogled-chromium",
];

// Known FALSE-positives — Windows / system processes that would otherwise look
// like browsers because they bundle Chromium internally. Listed in lowercase.
const NOT_BROWSERS: &[&str] = &[
    "searchhost", "searchapp", "searchui",
    "shellexperiencehost", "explorer", "lockapp",
    "msedgewebview2", "edgewebview", "webview2",
    "msteams", "teams", "slack", "discord", "code",
    "spotify", "notion", "obsidian", "figma",
    "explorer.exe", "shellhost",
];

pub fn is_browser(app: &str) -> bool {
    let lower = app.to_lowercase();
    if NOT_BROWSERS.iter().any(|n| &lower == n) { return false; }
    BROWSER_PROCESSES.iter().any(|b| &lower == b)
}

/// Build the activity_logs row for a finished focus session.
pub fn to_payload(session: &FocusSession, ended_at: DateTime<Utc>) -> Value {
    let duration = (ended_at - session.started_at).num_seconds().max(0);
    let is_brw = is_browser(&session.info.app_name);
    let activity_type = if is_brw { "browser" } else { "app" };

    // For browsers we prefer the actual URL; fall back to the window title only when
    // URL extraction failed. The dashboard "Page Title" column reads `page_title`,
    // and the new URL column reads `url`.
    let url = session.info.url.clone().unwrap_or_else(|| {
        if is_brw { String::new() } else { session.info.window_title.clone() }
    });
    let page_title = session.info.page_title.clone()
        .unwrap_or_else(|| session.info.window_title.clone());

    json!({
        "activity_type": activity_type,
        "application_name": session.info.app_name,
        "url": url,
        "page_title": page_title,
        "duration": duration,
        "created_at": session.started_at.to_rfc3339(),
    })
}
