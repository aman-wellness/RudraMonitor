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
// We use a single short PowerShell snippet that talks to the OS UIAutomation
// API to read the focused browser's address bar and tab title. Spawning
// powershell is ~80-150ms — comparable to osascript on macOS — and only fires
// when a browser window is in focus, so the cost is bounded.
//
// The snippet looks up the foreground window, finds the Edit control whose
// AutomationId is "addressEditBox" (Edge) or "url-bar" (Firefox) or any Edit
// inside the Chrome/Brave document — Chromium-based browsers don't expose a
// stable AutomationId, so we walk the tree and pick the first Edit child of
// the toolbar.
#[cfg(target_os = "windows")]
pub fn current_for_app(_app_name: &str) -> Option<BrowserContext> {
    // Caller (active_window::current) already verified this is a known browser
    // process via the strict is_browser() check, so we don't re-filter here.

    // PowerShell + UIAutomation:
    //   1. Win32 GetForegroundWindow → HWND of the topmost browser window
    //   2. AutomationElement.FromHandle wraps the HWND in a UIA element
    //   3. Walk descendants for Edit controls, pick the one whose value looks
    //      like a URL (this is the address bar — works for Chrome / Edge /
    //      Brave / Vivaldi / Opera / Firefox)
    //   4. Output: <URL>\n<window title>
    //
    // This is more reliable than `[AutomationElement]::FocusedElement` which
    // sometimes returns a popup or unrelated element.
    const SCRIPT: &str = r#"
$ErrorActionPreference='SilentlyContinue';
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@;
$hwnd = [W]::GetForegroundWindow();
if($hwnd -eq 0){ exit 0 };
$ae = [System.Windows.Automation.AutomationElement];
$top = $ae::FromHandle($hwnd);
if($top -eq $null){ exit 0 };
$title = $top.Current.Name;
$cond = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit);
$edits = $top.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond);
$url='';
foreach($e in $edits){
  $vp = $null;
  if($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)){
    try { $v = $vp.Current.Value } catch { continue };
    if($v -and ($v -match '^[a-zA-Z]+://' -or $v -match '^[a-z0-9.-]+\.[a-z]{2,}')){ $url=$v; break };
  }
}
"$url`n$title"
"#;

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-Command", SCRIPT,
        ])
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let raw = String::from_utf8_lossy(&output.stdout);
    let trimmed = raw.trim();
    if trimmed.is_empty() { return None; }

    let mut lines = trimmed.split('\n');
    let mut url = lines.next().map(|s| s.trim().to_string()).unwrap_or_default();
    let title = lines.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // Normalise bare hostnames into full URLs so the dashboard's URL parser works.
    if !url.is_empty() && !url.contains("://") {
        url = format!("https://{}", url);
    }
    let url = if url.is_empty() { None } else { Some(url) };

    if url.is_none() && title.is_none() { return None; }
    Some(BrowserContext { url, page_title: title })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn current_for_app(_app_name: &str) -> Option<BrowserContext> {
    // Linux: no portable API. Could shell out to wmctrl/xdotool for the window
    // title (which Chrome on Linux includes the page title in), but URL
    // extraction requires AT-SPI integration — left for a future pass.
    None
}
