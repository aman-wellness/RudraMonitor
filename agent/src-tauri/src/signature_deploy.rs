//! Classic Outlook Desktop signature deployment (Windows-only).
//!
//! Trigger model: this module is **event-driven, not polled**. When an admin
//! clicks "Push signature now" in the portal, the `signatures-push` edge
//! function broadcasts a `signature.push` event on the per-agent Realtime
//! channel (`agent:<agent_id>`). The realtime listener catches that event
//! and calls `deploy_now()` here. Nothing scheduled — no writes happen
//! until the admin explicitly initiates a push.
//!
//! What we write:
//!   %APPDATA%\Microsoft\Signatures\{employee-name}.htm     — HTML body
//!   %APPDATA%\Microsoft\Signatures\{employee-name}.txt     — plain-text
//!   %APPDATA%\Microsoft\Signatures\{employee-name}.rtf     — RTF stub
//!
//! HKCU\Software\Microsoft\Office\{ver}\Common\MailSettings
//!   NewSignature   = {employee-name}
//!   ReplySignature = {employee-name}
//!
//! The signature entry name inside Outlook's dropdown is derived from the
//! filename, so a user with full name "Aman Saini" sees "Aman Saini" in
//! their Signature dropdown — not a brand string. The employee's name is
//! resolved server-side by the fetch endpoint (matching agent_name to
//! employees.full_name, with a fallback to directory_users.display_name).
//!
//! Outlook picks up the change on the next compose — no restart needed.

#![cfg(target_os = "windows")]

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FetchResponse {
    Enabled {
        enabled: bool,
        signature_name: String,
        html: String,
        text: String,
        checksum: String,
    },
    Disabled {
        enabled: bool,
        #[serde(default)]
        reason: Option<String>,
    },
}

/// Fetch the current active signature for this agent's user and deploy it.
/// Called on:
///   1. Agent startup (once, so a fresh install picks up any existing
///      admin-pushed signature before the user opens Outlook).
///   2. Every `signature.push` Realtime broadcast from the portal.
///
/// Idempotent — if the server's checksum matches the last successful
/// deploy, we log and skip the write. `last_checksum` is retained in
/// process memory, not on disk, so a fresh process re-deploys once.
pub async fn deploy_now(
    client: &reqwest::Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    last_checksum: Option<&str>,
) -> Result<Option<String>> {
    let url = format!("{}/functions/v1/agent-signature-fetch", supabase_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .header("apikey", anon_key)
        .header("Authorization", format!("Bearer {}", anon_key))
        .header("x-agent-token", enroll_token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .context("agent-signature-fetch: request")?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "agent-signature-fetch: HTTP {} — {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let body: FetchResponse = resp.json().await.context("agent-signature-fetch: parse json")?;

    match body {
        FetchResponse::Enabled { signature_name, html, text, checksum, .. } => {
            if last_checksum == Some(checksum.as_str()) {
                log::info!("[sig] checksum unchanged, skip write");
                return Ok(Some(checksum));
            }
            if signature_name.trim().is_empty() {
                return Err(anyhow!("server returned empty signature_name"));
            }
            write_signature_files(&signature_name, &html, &text)
                .context("write_signature_files")?;
            set_default_signature_registry(&signature_name)
                .context("set_default_signature_registry")?;
            log::info!("[sig] deployed name={:?} checksum={}", signature_name, &checksum[..12]);
            Ok(Some(checksum))
        }
        FetchResponse::Disabled { reason, .. } => {
            log::debug!(
                "[sig] skipped: {}",
                reason.unwrap_or_else(|| "server disabled".to_string())
            );
            Ok(None)
        }
    }
}

/// Resolves the Outlook signatures directory. On Windows, `dirs::config_dir()`
/// returns `%APPDATA%` (the Roaming folder) — exactly where Outlook looks,
/// and the "Roaming" bit means the signature travels with the user across
/// domain-joined PCs.
fn signatures_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve %APPDATA% via dirs::config_dir()"))?;
    let dir = base.join("Microsoft").join("Signatures");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating {:?}", dir))?;
    Ok(dir)
}

fn write_signature_files(signature_name: &str, html: &str, text: &str) -> Result<()> {
    let dir = signatures_dir()?;
    let htm_path = dir.join(format!("{signature_name}.htm"));
    let txt_path = dir.join(format!("{signature_name}.txt"));
    let rtf_path = dir.join(format!("{signature_name}.rtf"));

    // .htm — the body Outlook uses in HTML compose mode. Wrap in a minimal
    // <html> shell because Outlook's Word-based render engine sometimes drops
    // naked table markup that isn't inside <html><body>.
    let htm_body = format!(
        "<html><head><meta charset=\"utf-8\"></head><body>{html}</body></html>",
    );
    std::fs::write(&htm_path, htm_body).with_context(|| format!("writing {htm_path:?}"))?;

    // .txt — plain-text fallback for plain-text compose mode.
    std::fs::write(&txt_path, text).with_context(|| format!("writing {txt_path:?}"))?;

    // .rtf — Rich Text Format. Old RTF compose mode requires the file to
    // exist. Minimal preamble so Word doesn't complain on some Outlook builds.
    if !rtf_path.exists() {
        std::fs::write(&rtf_path, "{\\rtf1\\ansi\\ansicpg1252\\deff0}")
            .with_context(|| format!("writing {rtf_path:?}"))?;
    }
    Ok(())
}

/// Set HKCU\Software\Microsoft\Office\{ver}\Common\MailSettings.NewSignature
/// and ReplySignature to the given name. Iterates known Office versions
/// (16.0 covers Office 2016/2019/2021/365; 15.0 covers 2013).
///
/// Uses `reg add /f` via the Windows shell rather than a pure-Rust registry
/// crate to keep the dependency footprint tiny. `/f` overwrites existing
/// values silently — the behaviour we want.
fn set_default_signature_registry(name: &str) -> Result<()> {
    use std::process::Command;
    for version in ["16.0", "15.0"] {
        let key = format!("HKCU\\Software\\Microsoft\\Office\\{}\\Common\\MailSettings", version);
        for value_name in ["NewSignature", "ReplySignature"] {
            let mut cmd = Command::new("reg");
            cmd.args(["add", &key, "/v", value_name, "/t", "REG_SZ", "/d", name, "/f"]);
            crate::win_proc::no_window(&mut cmd);
            let status = cmd.status();
            match status {
                Ok(s) if !s.success() => {
                    log::debug!("[sig] reg add {key}\\{value_name} exit={:?}", s.code());
                }
                Err(e) => log::debug!("[sig] reg add {key}\\{value_name} spawn error: {e}"),
                Ok(_) => {}
            }
        }
    }
    Ok(())
}
