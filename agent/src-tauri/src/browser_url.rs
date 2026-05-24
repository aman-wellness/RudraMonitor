// Extract the active tab's URL + title from supported browsers.
//
// macOS:   uses `osascript` against Chromium/WebKit family browsers.
// Windows: not implemented yet (would use UIAutomation to read the address bar).
// Linux:   not implemented (no portable API; X11/Wayland varies wildly).
//
// Returns None if extraction fails for any reason — callers should fall back to
// the window title from active-win-pos-rs.

#[derive(Debug, Clone)]
pub struct BrowserContext {
    pub url: Option<String>,
    pub page_title: Option<String>,
}

/// Returns the canonical name of a personal mail provider if the URL is a
/// known personal mail hostname. Used by DLP to flag email-attachment risk.
/// Distinguishes:
///   - "gmail" (mail.google.com — both work + personal; use authorized_domains
///     in dlp_settings to whitelist your company's @gmail.com if needed)
///   - "yahoo", "outlook" (outlook.live.com / hotmail.com), "rediffmail",
///     "proton", "zoho-personal", "aol".
/// Excludes business mail providers behind custom domains (Outlook 365 on a
/// company tenant is at outlook.office.com — not flagged by default).
pub fn personal_mail_provider(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("mail.google.com") || lower.contains("gmail.com") { return Some("gmail"); }
    if lower.contains("mail.yahoo.com") || lower.contains("yahoo.com/mail") { return Some("yahoo"); }
    if lower.contains("outlook.live.com") || lower.contains("hotmail.com")
        || lower.contains("outlook.com") && !lower.contains("outlook.office.com") { return Some("outlook"); }
    if lower.contains("rediffmail.com") || lower.contains("rediff.com/mail") { return Some("rediffmail"); }
    if lower.contains("mail.proton.me") || lower.contains("protonmail.com") { return Some("proton"); }
    if lower.contains("mail.aol.com") || lower.contains("aol.com/mail") { return Some("aol"); }
    if lower.contains("mail.zoho.com") { return Some("zoho"); }
    None
}

/// True if the URL looks like a "compose" / "new mail" page for one of the
/// known personal providers — implies an in-progress outgoing message.
pub fn is_compose_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    // Gmail compose: ?compose=new or #inbox?compose=…
    if lower.contains("mail.google.com") && (lower.contains("compose") || lower.contains("/u/0/?cs=") ) { return true; }
    // Yahoo compose
    if lower.contains("mail.yahoo.com") && lower.contains("compose") { return true; }
    // Outlook compose
    if lower.contains("outlook.live.com") && lower.contains("deeplink/compose") { return true; }
    // Rediff compose
    if lower.contains("rediffmail.com") && lower.contains("compose") { return true; }
    // Proton compose (modal — URL doesn't always change). Treat any /inbox state
    // on Proton as risky-context once duration crosses threshold.
    if lower.contains("mail.proton.me") { return true; }
    false
}

#[cfg(target_os = "macos")]
pub fn current_for_app(app_name: &str) -> Option<BrowserContext> {
    let lower = app_name.to_lowercase();

    // Chromium-family browsers all share the same AppleScript dictionary
    // (active tab of front window, URL/title properties).
    let is_chromium = lower.contains("chrome")
        || lower.contains("brave")
        || lower.contains("edge")
        || lower.contains("arc")
        || lower.contains("vivaldi")
        || lower.contains("opera")
        || lower.contains("chromium");

    let is_safari = lower.contains("safari");

    let script = if is_chromium {
        // We use the literal app_name because `tell application "Google Chrome"`
        // and `tell application "Brave Browser"` need different identifiers.
        // The basename of the .app bundle (which is what active-win returns) IS
        // the AppleScript identifier for these browsers.
        format!(
            r#"tell application "{name}"
                if (count of windows) is 0 then return ""
                set theTab to active tab of front window
                return (URL of theTab) & "
" & (title of theTab)
            end tell"#,
            name = app_name
        )
    } else if is_safari {
        r#"tell application "Safari"
            if (count of windows) is 0 then return ""
            set theTab to current tab of front window
            return (URL of theTab) & "
" & (name of theTab)
        end tell"#
            .to_string()
    } else {
        // Firefox doesn't expose URL via AppleScript — give up gracefully.
        return None;
    };

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut lines = trimmed.split('\n');
    let url = lines.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let title = lines.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if url.is_none() && title.is_none() {
        return None;
    }
    Some(BrowserContext { url, page_title: title })
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
//
// Native UIA via the `uiautomation` Rust crate — no PowerShell subprocess. Each
// poll runs in well under 50ms and bypasses PowerShell startup latency, which
// was the main reason URLs weren't being captured earlier (PowerShell on
// employee machines occasionally takes 2-5s to start, well past the agent's
// effective polling budget).
#[cfg(target_os = "windows")]
pub fn current_for_app(_app_name: &str) -> Option<BrowserContext> {
    // UIAutomation tree traversal on a focused browser is expensive — `find_all`
    // can take 200-1500ms and holds COM apartment locks that briefly stall
    // input processing in the browser itself (manifests as cursor / scroll
    // lag for the end-user). Two mitigations:
    //
    //   1. Per-HWND title cache. We only re-query UIA when the foreground
    //      window's title changes (which means a navigation or tab switch).
    //      A user reading the same page for 30 minutes triggers exactly
    //      ONE UIA walk, not 360.
    //   2. Hard 400ms timeout via a worker thread + channel try_recv.
    //      If UIA hasn't returned by then we abandon the query and fall
    //      back to the window title. The orphaned thread will finish on
    //      its own and we'll pick up its result on the next tick if the
    //      title hasn't changed since.
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::time::Duration;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};

    static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    // Cheap WinAPI title read — sub-millisecond. Used as the cache key.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() { return None; }
    let hwnd_addr = hwnd.0 as usize;
    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buf) } as usize;
    let title = if title_len > 0 {
        Some(String::from_utf16_lossy(&title_buf[..title_len]))
    } else {
        None
    };

    // Cache hit? (same window, same title — same tab + same URL).
    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.hwnd == hwnd_addr && entry.title == title {
                return Some(BrowserContext {
                    url: entry.url.clone(),
                    page_title: entry.title.clone(),
                });
            }
        }
    }

    // Cache miss → do the expensive UIA walk on a worker thread with a
    // 400ms ceiling. Anything slower than that is unacceptable; the user
    // gets the title-only fallback this tick and a fresh attempt next
    // tick (5s later). One stalled UIA worker doesn't stall the next.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(query_uia(hwnd_addr));
    });
    let url = match rx.recv_timeout(Duration::from_millis(400)) {
        Ok(u) => u,
        Err(_) => None,
    };

    // Update cache only when we got an answer — don't poison the cache on
    // a timeout (next call will retry).
    if url.is_some() {
        if let Ok(mut guard) = cache.lock() {
            *guard = Some(CacheEntry {
                hwnd: hwnd_addr,
                title: title.clone(),
                url: url.clone(),
            });
        }
    }

    if url.is_none() && title.is_none() { return None; }
    Some(BrowserContext { url, page_title: title })
}

#[cfg(target_os = "windows")]
struct CacheEntry {
    hwnd: usize,
    title: Option<String>,
    url: Option<String>,
}

#[cfg(target_os = "windows")]
fn query_uia(hwnd_addr: usize) -> Option<String> {
    use uiautomation::UIAutomation;
    use uiautomation::types::{Handle, TreeScope, UIProperty};
    use uiautomation::variants::Variant;

    let automation = UIAutomation::new().ok()?;
    let handle = Handle::from(hwnd_addr as isize);
    let root = automation.element_from_handle(handle).ok()?;
    let edit_cond = automation
        .create_property_condition(UIProperty::ControlType, Variant::from(50004i32), None)
        .ok()?;
    let edits = root.find_all(TreeScope::Descendants, &edit_cond).ok()?;
    for e in edits.iter() {
        let value = e
            .get_property_value(UIProperty::ValueValue)
            .ok()
            .and_then(|v| v.get_string().ok())
            .filter(|s| !s.is_empty());
        if let Some(v) = value {
            if looks_like_url(&v) {
                return Some(if v.contains("://") { v } else { format!("https://{}", v) });
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn looks_like_url(v: &str) -> bool {
    // Schemes that browsers actually load (skip about:, chrome://, etc — they're
    // not useful in productivity reports).
    if v.starts_with("http://") || v.starts_with("https://") { return true; }
    // Bare host like "example.com" or "sub.domain.co.uk".
    let lower = v.to_ascii_lowercase();
    if !lower.contains('.') { return false; }
    let first = lower.split('/').next().unwrap_or("");
    let parts: Vec<&str> = first.split('.').collect();
    parts.len() >= 2 && parts.iter().all(|p| !p.is_empty()) && parts.last().is_some_and(|tld| tld.len() >= 2)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn current_for_app(_app_name: &str) -> Option<BrowserContext> {
    // Linux: no portable API. Could shell out to wmctrl/xdotool for the window
    // title (which Chrome on Linux includes the page title in), but URL
    // extraction requires AT-SPI integration — left for a future pass.
    None
}
