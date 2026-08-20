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
// Native UIA via the `uiautomation` Rust crate — no PowerShell subprocess.
//
// WHY THIS WAS RETURNING NOTHING. Every browser row in the database carried a
// page_title and an EMPTY url — 153 of 153 on the machine where this was
// diagnosed, which is a 100% failure rate, not an occasional miss. Three
// compounding causes:
//
//   1. `find_all(TreeScope::Descendants)` enumerates the browser's ENTIRE UIA
//      tree to collect every Edit control before picking the one that looks
//      like a URL. On a real Chrome window that is thousands of elements.
//   2. The walk was abandoned after 400ms — while the comment directly above
//      it admitted the operation "can take 200-1500ms". The budget sat below
//      the documented cost of the work, so the walk essentially always lost.
//   3. On timeout the cache was deliberately left unwritten so the next call
//      would retry. Combined with (2), every tick paid for a full tree walk
//      and every tick threw the answer away. The old comment claimed a late
//      result would be "picked up on the next tick" — it could not be: the
//      receiver was dropped the instant recv_timeout returned, so the worker
//      sent its value into a closed channel and it was lost.
//
// Consequences went beyond a blank column: with no URL there is no host, so
// every `match_type = 'host'` row in productivity_rules was dead code that
// could never match, and no search query or visited domain was ever recorded.
//
// Fixes, in order of impact: try a short-circuiting `find_first` before the
// exhaustive scan; give the walk a budget above its real cost; keep late
// results in a shared slot instead of discarding them; and remember a walk
// that genuinely found nothing for NEGATIVE_TTL so an unreadable page does not
// re-walk the tree on every tick.

/// Budget for one address-bar read. Deliberately above the 200-1500ms range
/// the operation is known to take — the previous 400ms sat below it.
#[cfg(target_os = "windows")]
const UIA_BUDGET: std::time::Duration = std::time::Duration::from_millis(1_500);

/// How long to trust a COMPLETED walk that found no URL before trying again.
/// Without this, a page whose address bar cannot be read (a PDF viewer, an app
/// window mis-detected as a browser, a browser with accessibility disabled)
/// would pay for a full tree walk every tick forever.
#[cfg(target_os = "windows")]
const NEGATIVE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(target_os = "windows")]
pub fn current_for_app(_app_name: &str) -> Option<BrowserContext> {
    // The per-HWND title cache is kept from the original design and is why
    // this is cheap in the steady state: the address bar is only re-read when
    // the foreground window's title changes, which means a navigation or a tab
    // switch. Someone reading one page for 30 minutes triggers exactly one
    // walk, not 360.
    use std::sync::{Arc, Mutex};
    use std::sync::OnceLock;
    use std::time::Instant;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};

    static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();
    static PENDING: OnceLock<Arc<Mutex<Option<PendingResult>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let pending = PENDING.get_or_init(|| Arc::new(Mutex::new(None)));

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

    // Adopt a walk that finished after we stopped waiting for it. This is the
    // half the old code got wrong — a slow-but-successful read is still a
    // correct read, and on a machine where the walk reliably exceeds the
    // budget it is the ONLY way a URL is ever obtained.
    if let Ok(mut slot) = pending.lock() {
        if let Some(pr) = slot.as_ref() {
            if pr.hwnd == hwnd_addr && pr.title == title {
                if let Ok(mut c) = cache.lock() {
                    *c = Some(CacheEntry {
                        hwnd: hwnd_addr,
                        title: title.clone(),
                        url: pr.url.clone(),
                        resolved_at: Instant::now(),
                    });
                }
            }
            // Either adopted, or it belongs to a tab we have since left.
            *slot = None;
        }
    }

    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.hwnd == hwnd_addr && entry.title == title {
                // A hit WITH a url is good indefinitely — an unchanged title
                // means the same page. A hit WITHOUT one is only good for
                // NEGATIVE_TTL, so a transient failure gets another chance.
                if entry.url.is_some() || entry.resolved_at.elapsed() < NEGATIVE_TTL {
                    return Some(BrowserContext {
                        url: entry.url.clone(),
                        page_title: entry.title.clone(),
                    });
                }
            }
        }
    }

    // Cache miss → walk on a worker thread so a pathological UIA call can
    // never stall the caller's tick. The worker publishes into the shared slot
    // whether or not we are still waiting, so no completed work is wasted.
    let slot = pending.clone();
    let worker_title = title.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let started = Instant::now();
        let url = query_uia(hwnd_addr);
        let took_ms = started.elapsed().as_millis();
        if let Ok(mut g) = slot.lock() {
            *g = Some(PendingResult { hwnd: hwnd_addr, title: worker_title, url: url.clone() });
        }
        match &url {
            Some(u) => log::debug!("browser_url: read address bar in {took_ms}ms: {u}"),
            None => log::debug!("browser_url: walk finished in {took_ms}ms, no URL found"),
        }
        let _ = tx.send(url);
    });

    match rx.recv_timeout(UIA_BUDGET) {
        Ok(url) => {
            // Completed in budget. Record it — including a definitive "no URL
            // here", which NEGATIVE_TTL will expire — and clear the slot so
            // the same answer is not adopted twice.
            if let Ok(mut g) = pending.lock() { *g = None; }
            if let Ok(mut c) = cache.lock() {
                *c = Some(CacheEntry {
                    hwnd: hwnd_addr,
                    title: title.clone(),
                    url: url.clone(),
                    resolved_at: Instant::now(),
                });
            }
            if url.is_none() && title.is_none() { return None; }
            Some(BrowserContext { url, page_title: title })
        }
        Err(_) => {
            // Over budget. Report the title now; the worker will still publish
            // into the slot and the next tick adopts it.
            log::debug!(
                "browser_url: address-bar read exceeded {}ms, using title this tick",
                UIA_BUDGET.as_millis()
            );
            if title.is_none() { return None; }
            Some(BrowserContext { url: None, page_title: title })
        }
    }
}

#[cfg(target_os = "windows")]
struct CacheEntry {
    hwnd: usize,
    title: Option<String>,
    /// None means a walk COMPLETED and found no URL — distinct from "not yet
    /// attempted", which is the absence of a cache entry altogether.
    url: Option<String>,
    resolved_at: std::time::Instant,
}

/// A walk's result, published by the worker thread so an answer that arrives
/// after the caller's budget expired is still usable on the next tick.
#[cfg(target_os = "windows")]
struct PendingResult {
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
    // ControlType 50004 = Edit, matched by numeric id rather than by name so
    // the lookup also works on non-English Windows.
    let edit_cond = automation
        .create_property_condition(UIProperty::ControlType, Variant::from(50004i32), None)
        .ok()?;

    fn url_of(e: &uiautomation::UIElement) -> Option<String> {
        let v = e
            .get_property_value(UIProperty::ValueValue)
            .ok()
            .and_then(|v| v.get_string().ok())
            .filter(|s| !s.is_empty())?;
        if !looks_like_url(&v) { return None; }
        Some(if v.contains("://") { v } else { format!("https://{v}") })
    }

    // Fast path: stop at the first Edit in the tree. In a browser that is the
    // omnibox in the overwhelming majority of cases, and it avoids
    // enumerating the entire element tree.
    if let Ok(first) = root.find_first(TreeScope::Descendants, &edit_cond) {
        if let Some(u) = url_of(&first) { return Some(u); }
    }

    // Slow path, kept for correctness: some layouts (a focused in-page text
    // field, extra browser chrome) put another Edit first, so scan them all
    // rather than reporting no URL.
    let edits = root.find_all(TreeScope::Descendants, &edit_cond).ok()?;
    for e in edits.iter() {
        if let Some(u) = url_of(e) { return Some(u); }
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
