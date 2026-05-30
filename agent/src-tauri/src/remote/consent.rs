// Employee-facing consent prompt — shown when an admin requests a remote
// session and either (a) org policy requires consent OR (b) the trusted
// window has expired. We block the realtime_listener for up to 60 s
// waiting on a user decision.
//
// Implementation note: we use OS-native dialogs via subprocess rather
// than spawning a Tauri webview window — the agent's main webview is
// hidden in the tray and reusing it would flash the dashboard UI on
// every prompt, which would be jarring. The subprocess approach also
// gives us a system-modal "Yes / No" with the correct OS look without
// adding a new Tauri plugin dependency.
//
//   macOS   → osascript -e 'display dialog ...'  (returns 0 on OK, 1 on Cancel)
//   Windows → powershell MessageBox              (returns 6=Yes, 7=No)
//   Linux   → zenity --question                  (returns 0=Yes, 1=No)
//
// If the platform's helper isn't installed (no zenity on a minimal Linux
// box, etc.) we default to DENY so silent admin access can never happen
// behind the employee's back.

use std::time::Duration;
use tauri::AppHandle;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use tokio::process::Command;
use tokio::time::timeout;

#[cfg(target_os = "windows")]
fn show_win32_dialog(title: &str, body: &str) -> Option<bool> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONQUESTION, MB_SYSTEMMODAL, MB_TOPMOST, MB_YESNO,
    };
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let title_w = to_wide(title);
    let body_w = to_wide(body);
    unsafe {
        let r = MessageBoxW(
            None,
            PCWSTR(body_w.as_ptr()),
            PCWSTR(title_w.as_ptr()),
            MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SYSTEMMODAL,
        );
        Some(r == IDYES)
    }
}

const PROMPT_TIMEOUT_SECS: u64 = 60;

pub async fn show_prompt(_app: &AppHandle, viewer_name: &str, reason: &str) -> Option<bool> {
    let title = "Rudrans Remote Support";
    let reason_line = if reason.is_empty() {
        String::new()
    } else {
        format!("\n\nReason: {reason}")
    };
    let body = format!(
        "{viewer_name} from your admin team is requesting to view your screen and control this computer.{reason_line}\n\nAllow this session?"
    );

    let fut = run_dialog(title.into(), body);
    match timeout(Duration::from_secs(PROMPT_TIMEOUT_SECS), fut).await {
        Ok(Some(decision)) => Some(decision),
        Ok(None) => Some(false), // helper missing → deny
        Err(_)   => Some(false), // timeout → deny
    }
}

async fn run_dialog(title: String, body: String) -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        // Newlines in the message become \n in the AppleScript string.
        let escaped = body.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"display dialog "{escaped}" with title "{title}" buttons {{"Deny", "Allow"}} default button "Allow" with icon caution"#
        );
        let out = Command::new("osascript").args(["-e", &script]).output().await.ok()?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Some(stdout.contains("button returned:Allow"));
    }
    #[cfg(target_os = "windows")]
    {
        // PowerShell-MessageBox path was unreliable from the tray-app
        // context — the child PS sometimes ran without UI session access
        // and the dialog never reached the desktop. Use Win32 MessageBoxW
        // directly: it inherits the parent process's UI session and
        // shows a system-modal prompt the same way Tauri's own dialogs do.
        let result = tokio::task::spawn_blocking(move || show_win32_dialog(&title, &body))
            .await
            .ok()
            .flatten();
        return result;
    }
    #[cfg(target_os = "linux")]
    {
        if Command::new("which").arg("zenity").output().await.ok()
            .map(|o| o.status.success()).unwrap_or(false)
        {
            let status = Command::new("zenity")
                .args(["--question", "--title", &title, "--text", &body, "--ok-label=Allow", "--cancel-label=Deny"])
                .status().await.ok()?;
            return Some(status.success());
        }
        return None;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (title, body);
        None
    }
}
