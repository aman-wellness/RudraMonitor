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
    use uiautomation::UIAutomation;
    use uiautomation::types::{TreeScope, UIProperty};
    use uiautomation::variants::Variant;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    // 1. Foreground HWND
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0 == 0 { return None; }

    // 2. Wrap in a UIA element. `UIAutomation::new()` is cheap (cached by the
    //    crate). `element_from_handle` returns the AutomationElement for the
    //    window's root.
    let automation = UIAutomation::new().ok()?;
    let root = automation.element_from_handle(hwnd.into()).ok()?;

    // Window title (used as a fallback for page title; Chromium browsers expose
    // the active tab title here as "Page Title - Browser Name").
    let title = root.get_name().ok().filter(|s| !s.is_empty());

    // 3. Walk descendants looking for Edit controls. The address bar is always
    //    an Edit (ControlType::Edit). On Chromium the AutomationId varies by
    //    browser, but the address bar value always passes the URL/host regex
    //    below. We grab the first Edit whose value looks like a URL.
    let edit_cond = automation
        .create_property_condition(UIProperty::ControlType, Variant::from(50004i32), None)
        .ok()?;
    let edits = root.find_all(TreeScope::Descendants, &edit_cond).ok()?;

    let mut url: Option<String> = None;
    for e in edits.iter() {
        let value = e.get_property_value(UIProperty::ValueValue).ok()
            .and_then(|v| v.get_string().ok())
            .filter(|s| !s.is_empty());
        if let Some(v) = value {
            if looks_like_url(&v) {
                url = Some(if v.contains("://") { v } else { format!("https://{}", v) });
                break;
            }
        }
    }

    if url.is_none() && title.is_none() { return None; }
    Some(BrowserContext { url, page_title: title })
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
