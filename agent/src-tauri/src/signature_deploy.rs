//! Classic Outlook Desktop signature deployment (Windows-only).
//!
//! Microsoft's Set-MailboxMessageConfiguration path (used by the
//! `signatures-push` edge function) reaches Outlook Web and New Outlook
//! immediately, but only reaches Classic Outlook Desktop if the customer's
//! tenant has enabled cloud/roaming signatures. Many tenants haven't yet.
//!
//! Since we already have an agent running on every user's PC, we take the
//! MDM approach that CodeTwo / Exclaimer use: write the signature files
//! directly into `%APPDATA%\Microsoft\Signatures\` and set the HKCU
//! registry keys that tell Outlook which signature to use for new mail
//! and replies. Outlook picks up the change on the next compose — no
//! restart, no admin, no roaming-signature dependency.
//!
//! Layout on disk:
//!   %APPDATA%\Microsoft\Signatures\{name}.htm    — HTML body
//!   %APPDATA%\Microsoft\Signatures\{name}.txt    — plain-text fallback
//!   %APPDATA%\Microsoft\Signatures\{name}.rtf    — RTF fallback (empty, still needed)
//!   %APPDATA%\Microsoft\Signatures\{name}_files\ — Outlook creates this on first use
//!
//! Registry:
//!   HKCU\Software\Microsoft\Office\16.0\Common\MailSettings
//!     NewSignature     = {name}
//!     ReplySignature   = {name}
//!
//! We tick every 15 minutes and skip the write when the server-reported
//! checksum matches what we already deployed (persisted in agent.json).

#![cfg(target_os = "windows")]

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

/// Signature name shown inside Outlook's Signature dropdown. Prefixed with
/// the vendor so an IT admin scanning the list can immediately tell it's
/// centrally managed, not something the user hand-picked.
const SIGNATURE_NAME: &str = "TrackForce";

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FetchResponse {
    Enabled {
        enabled: bool,
        name: String,
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

/// Fetch → render → write. Idempotent when the server checksum hasn't changed.
pub async fn tick(
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
        FetchResponse::Enabled { html, text, checksum, .. } => {
            // Skip when nothing changed — cheap short-circuit that keeps the
            // filesystem quiet on machines that have already been deployed.
            if last_checksum == Some(checksum.as_str()) {
                return Ok(Some(checksum));
            }
            write_signature_files(&html, &text)
                .context("write_signature_files")?;
            set_default_signature_registry(SIGNATURE_NAME)
                .context("set_default_signature_registry")?;
            log::info!("[sig] deployed signature checksum={}", &checksum[..12]);
            Ok(Some(checksum))
        }
        FetchResponse::Disabled { enabled: _, reason } => {
            log::debug!(
                "[sig] skipped: {}",
                reason.unwrap_or_else(|| "server disabled".to_string())
            );
            Ok(None)
        }
    }
}

/// Resolves the signatures directory. `dirs::config_dir()` returns
/// `%APPDATA%` on Windows (the Roaming folder), which is exactly where
/// Outlook looks — the "Roaming" bit is important because Outlook profiles
/// on domain-joined PCs roam with the user.
fn signatures_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve %APPDATA% via dirs::config_dir()"))?;
    let dir = base.join("Microsoft").join("Signatures");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating {:?}", dir))?;
    Ok(dir)
}

fn write_signature_files(html: &str, text: &str) -> Result<()> {
    let dir = signatures_dir()?;
    let htm_path = dir.join(format!("{SIGNATURE_NAME}.htm"));
    let txt_path = dir.join(format!("{SIGNATURE_NAME}.txt"));
    let rtf_path = dir.join(format!("{SIGNATURE_NAME}.rtf"));

    // .htm — Outlook uses this when the composer is set to HTML (the default
    // for modern users). We wrap the body in a minimal <html> shell because
    // Outlook's Word-based engine sometimes drops naked table markup that
    // isn't inside <html><body>.
    let htm_body = format!(
        "<html><head><meta charset=\"utf-8\"><meta name=\"generator\" content=\"TrackForce\"></head><body>{html}</body></html>",
    );
    std::fs::write(&htm_path, htm_body).with_context(|| format!("writing {htm_path:?}"))?;

    // .txt — plain-text fallback used when the composer is set to plain text.
    std::fs::write(&txt_path, text).with_context(|| format!("writing {txt_path:?}"))?;

    // .rtf — Rich Text Format. Outlook's older RTF compose mode requires
    // this file to exist, even if empty. We emit a minimal RTF preamble so
    // Word doesn't complain on some Outlook builds when reading it.
    if !rtf_path.exists() {
        std::fs::write(&rtf_path, "{\\rtf1\\ansi\\ansicpg1252\\deff0}")
            .with_context(|| format!("writing {rtf_path:?}"))?;
    }
    Ok(())
}

/// Writes HKCU\Software\Microsoft\Office\{ver}\Common\MailSettings NewSignature
/// and ReplySignature to the given name. Iterates known Office versions
/// (16.0 covers Office 2016/2019/2021/365; 15.0 covers 2013) so a user with
/// any modern Outlook picks up the change. Older Office versions are
/// intentionally skipped — they're out of Microsoft support and getting
/// increasingly rare.
///
/// We use `reg add` via the Windows shell rather than a pure-Rust registry
/// crate — keeps the agent's dependency footprint tiny (no new crate) and
/// mirrors what an IT admin would type manually. `reg add /f` overwrites
/// existing values silently, which is the behaviour we want.
fn set_default_signature_registry(name: &str) -> Result<()> {
    use std::process::Command;
    // Suppress the console window flash that would otherwise show for a
    // frame every 15 minutes. Same pattern used by usb_block / service_install.
    for version in ["16.0", "15.0"] {
        let key = format!("HKCU\\Software\\Microsoft\\Office\\{}\\Common\\MailSettings", version);
        for value_name in ["NewSignature", "ReplySignature"] {
            let mut cmd = Command::new("reg");
            cmd.args(["add", &key, "/v", value_name, "/t", "REG_SZ", "/d", name, "/f"]);
            crate::win_proc::no_window(&mut cmd);
            let status = cmd.status();
            match status {
                Ok(s) if !s.success() => {
                    // Non-fatal — user may just not have that Office version installed.
                    log::debug!("[sig] reg add {key}\\{value_name} exit={:?}", s.code());
                }
                Err(e) => log::debug!("[sig] reg add {key}\\{value_name} spawn error: {e}"),
                Ok(_) => {}
            }
        }
    }
    Ok(())
}
