// Thin wrapper around the two Supabase Edge Functions the agent talks to:
//   POST {supabase_url}/functions/v1/enroll-agent
//   POST {supabase_url}/functions/v1/ingest
//
// Both expect Authorization: Bearer <key>. For enrollment we send the project anon key.
// For ingest we send the per-agent enroll_token returned at enrollment.

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct EnrollRequest {
    pub license_key: String,
    pub agent_name: String,
    pub machine_name: String,
    pub os_type: String,
    /// Stamped from CARGO_PKG_VERSION so the dashboard can show the actual
    /// build running on each machine instead of a hard-coded placeholder.
    pub agent_version: String,
}

#[derive(Debug, Deserialize)]
pub struct EnrollResponse {
    pub agent_id: String,
    pub enroll_token: String,
    pub org_id: String,
}

#[derive(Debug, Serialize)]
pub struct IngestRequest<'a> {
    pub kind: &'a str, // "system_metrics" | "activity_logs" | "alerts"
    pub payload: Vec<Value>,
    /// Build version. Edge fn refreshes `agents.agent_version` on every
    /// heartbeat so the dashboard always shows the latest installed build
    /// (no re-enroll required after auto-updates).
    pub agent_version: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentSettings {
    pub screenshots_enabled: bool,
    pub active_window_enabled: bool,
    pub screenshot_interval_secs: u32,
    pub idle_threshold_secs: u32,
    #[serde(default)]
    pub videos_enabled: bool,
    #[serde(default = "default_video_interval")]
    pub video_interval_secs: u32,
    /// DLP USB watcher + email-compose tracker. Off by default; admin enables
    /// per-agent from the dashboard's Capture Controls. Server-driven so we can
    /// kill DLP for a misbehaving agent without rebuilding the binary.
    #[serde(default)]
    pub dlp_enabled: bool,
    /// Block any removable disk (USB stick, external HDD, SD card). Default ON
    /// at the org level; admin can flip it OFF per-agent to allowlist a device.
    #[serde(default = "default_true")]
    pub removable_disks_blocked: bool,
    /// If true, apply the org-wide wallpaper (see wallpaper_url) on this device.
    /// Toggle OFF per-agent to exempt a specific agent.
    #[serde(default = "default_true")]
    pub wallpaper_enforced: bool,
    /// Org-wide wallpaper image URL. None → no wallpaper push for this org.
    #[serde(default)]
    pub wallpaper_url: Option<String>,
    /// Timestamp of the most recent wallpaper change. Agent compares this to its
    /// locally cached last-applied stamp and re-applies only when newer, so a
    /// reboot doesn't re-download/re-apply the same image.
    #[serde(default)]
    pub wallpaper_updated_at: Option<String>,
    /// Org-default or per-agent-override working-hours schedule. When true,
    /// the agent pauses ALL capture (screenshots, video, USB block,
    /// wallpaper, DLP, activity logging) OUTSIDE the configured hours.
    /// false = 24/7 tracking (no schedule applied).
    #[serde(default)]
    pub tracking_schedule_enabled: bool,
    /// JSON shape:
    ///   {
    ///     "tz": "Asia/Kolkata",
    ///     "days": {
    ///       "mon": [{"start":"09:00","end":"18:00"}],
    ///       "tue": [...], ...
    ///     }
    ///   }
    /// Empty array or missing key for a day = that day has no working
    /// hours (agent pauses all day).
    #[serde(default)]
    pub tracking_schedule_json: Option<String>,
    /// Email DLP MITM proxy master switch. Only true when the org has
    /// explicitly opted in AND the plan includes DLP — both checks
    /// happen server-side in agent-settings so an expired subscription
    /// silently disables interception without touching the row. Agent
    /// gates `mitm::start()` on this + local consent.
    #[serde(default)]
    pub email_intercept_public_only: bool,
    /// Jurisdictional toggle: when false the ingest edge fn strips
    /// body_text / body_html before writing the row. Metadata (subject,
    /// recipients, attachments) still lands.
    #[serde(default = "default_true")]
    pub email_body_capture: bool,
}

fn default_true() -> bool { true }

fn default_video_interval() -> u32 { 1800 }

pub async fn fetch_settings(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
) -> Result<AgentSettings> {
    let url = format!("{}/functions/v1/agent-settings", supabase_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .bearer_auth(enroll_token)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // IMPORTANT: prefix with "http_status=" so the caller can reliably
        // distinguish "the server said 404" (clear enrollment) from a network
        // error like "failed to lookup address — not known" (leave enrollment
        // alone). Substring-matching "not found" against generic error text
        // was wiping enrollment on reboot before DNS came up.
        return Err(anyhow!("settings fetch failed: http_status={} body={}", status.as_u16(), body));
    }
    Ok(resp.json::<AgentSettings>().await?)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ValidateLicenseResponse {
    pub valid: bool,
    pub status: Option<String>,
    pub expires_at: Option<String>,
    pub organization_id: Option<String>,
    pub seat_count: Option<i32>,
    pub seats_used: Option<i32>,
    pub plan_code: Option<String>,
    pub reason: Option<String>,
}

pub async fn validate_license(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    license_key: &str,
    org_id: Option<&str>,
) -> Result<ValidateLicenseResponse> {
    let url = format!("{}/functions/v1/validate-license", supabase_url.trim_end_matches('/'));
    let mut body = serde_json::json!({ "license_key": license_key });
    if let Some(o) = org_id { body["org_id"] = serde_json::json!(o); }
    let resp = client
        .post(&url)
        .bearer_auth(anon_key)
        .header("apikey", anon_key)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    // Check the STATUS before parsing.
    //
    // This used to go straight to resp.json(), so any non-2xx response failed as
    // a deserialisation error and the setup screen reported "invalid license
    // key" — for a 404, a 502, or a captive portal's HTML login page alike. The
    // one thing it could not tell you was that the key was fine and the agent
    // was talking to the wrong place. Diagnosing that cost real time, so name
    // the URL and the status instead.
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let hint = if status.as_u16() == 404 {
            " — nothing is serving that path. Check the backend URL the agent was \
             built with, and that it points at a reachable Supabase instance."
        } else {
            ""
        };
        return Err(anyhow!(
            "validate-license: HTTP {} from {}{}\n{}",
            status, url, hint, body.trim(),
        ));
    }
    let json = resp.json::<ValidateLicenseResponse>().await
        .map_err(|e| anyhow!("validate-license parse: {} (http {} from {})", e, status, url))?;
    Ok(json)
}

/// Send a DLP event (USB transfer / email attachment / etc.) to the dashboard.
/// Server-side this triggers AI classification + email alert if unauthorized.
pub async fn dlp_ingest(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    payload: &Value,
) -> Result<()> {
    let url = format!("{}/functions/v1/dlp-ingest", supabase_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(anon_key)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .json(payload)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("dlp-ingest: {} — {}", status, body));
    }
    Ok(())
}

/// Two-phase email ingest — Phase 1 opens an event, gets signed upload
/// URLs per attachment, we PUT each attachment via reqwest, then we call
/// finalize. Returns the `event_id` so the caller can correlate upstream.
///
/// Payload shape mirrors `supabase/functions/dlp-email-ingest/index.ts`:
///   {
///     action: "open",
///     mail_provider, mail_url?, from_address?, subject?, body_text?,
///     body_html?, to_recipients, cc_recipients?, bcc_recipients?,
///     active_window?, screenshot_b64?,
///     attachments: [{ file_name, file_size_bytes, file_mime?, file_hash_sha256? }]
///   }
pub async fn dlp_email_open(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    payload: &Value,
) -> Result<Value> {
    let url = format!(
        "{}/functions/v1/dlp-email-ingest",
        supabase_url.trim_end_matches('/')
    );
    let resp = client
        .post(&url)
        .bearer_auth(anon_key)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .json(payload)
        .send()
        .await?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(anyhow!("dlp-email-ingest open: {} — {}", status, body));
    }
    Ok(body)
}

/// PUT attachment bytes to a signed upload URL returned by dlp_email_open.
/// The signed URL is already scoped to the exact storage path, so this is
/// a straight PUT with the content-type header the object should carry.
pub async fn dlp_email_upload(
    client: &Client,
    signed_url: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> Result<()> {
    let resp = client
        .put(signed_url)
        .header("content-type", content_type)
        .body(bytes)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("dlp-email attachment PUT: {} — {}", status, body));
    }
    Ok(())
}

/// Finalize an email event once all attachments have been PUT.
pub async fn dlp_email_finalize(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    event_id: &str,
) -> Result<()> {
    let url = format!(
        "{}/functions/v1/dlp-email-ingest",
        supabase_url.trim_end_matches('/')
    );
    let payload = serde_json::json!({ "action": "finalize", "event_id": event_id });
    let resp = client
        .post(&url)
        .bearer_auth(anon_key)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .json(&payload)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("dlp-email-ingest finalize: {} — {}", status, body));
    }
    Ok(())
}

pub fn build_client() -> Result<Client> {
    Ok(Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("RudransAgent/0.1")
        .build()?)
}

/// Per-request timeout for the `webrtc-signal` long-poll, which MUST exceed
/// that endpoint's own hold time (`LONG_POLL_TIMEOUT_MS`, 25s).
///
/// `build_client`'s 20s default is shorter than the server's 25s hold, so every
/// idle long-poll aborted client-side ~5s before the server would have replied.
/// The callers treat that as a failure and back off 10s, which left the agent
/// deaf to Live View start triggers for roughly a third of every cycle and made
/// "click Live View" take up to ~10s extra for no reason. Measured before the
/// fix: a continuous stream of `whip poll failed: whip long-poll; backing off
/// 10s` on a completely healthy connection.
///
/// Set per-request rather than by widening the client default, so ordinary
/// calls keep failing fast when the backend is genuinely unreachable.
pub const LONG_POLL_TIMEOUT: Duration = Duration::from_secs(35);

pub async fn enroll(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    req: &EnrollRequest,
) -> Result<EnrollResponse> {
    let url = format!("{}/functions/v1/enroll-agent", supabase_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(anon_key)
        .header("apikey", anon_key)
        .json(req)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // Name the URL, not just the status.
        //
        // "invalid license key" is what enroll-agent returns when no organization
        // matches — which is also exactly what a CORRECT key looks like when the
        // agent is pointed at the WRONG backend. Without the URL the two are
        // indistinguishable, and the message actively misleads: it blames the key.
        // The URL is resolved at runtime (env → agent.json → compiled default), so
        // it is not something the reader can infer from which installer they ran.
        return Err(anyhow!("enroll failed: {} from {} — {}", status, url, body));
    }
    Ok(resp.json::<EnrollResponse>().await?)
}

#[derive(Debug, Serialize)]
pub struct UploadScreenshotRequest<'a> {
    pub image_b64: &'a str,
    pub taken_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'a str>,
}

pub async fn upload_screenshot<'a>(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    req: &UploadScreenshotRequest<'a>,
) -> Result<()> {
    let url = format!("{}/functions/v1/upload-screenshot", supabase_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(enroll_token)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .json(req)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("upload-screenshot failed: {} — {}", status, body));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct UploadVideoRequest<'a> {
    pub video_b64: &'a str,
    pub taken_at: String,
    pub duration_secs: u32,
}

pub async fn upload_video<'a>(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    req: &UploadVideoRequest<'a>,
) -> Result<()> {
    let url = format!("{}/functions/v1/upload-video", supabase_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(enroll_token)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .timeout(std::time::Duration::from_secs(60))
        .json(req)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("upload-video failed: {} — {}", status, body));
    }
    Ok(())
}

pub async fn ingest<'a>(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    req: &IngestRequest<'a>,
) -> Result<()> {
    let url = format!("{}/functions/v1/ingest", supabase_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(enroll_token)
        .header("apikey", anon_key) // Supabase Edge gateway requires apikey header
        .header("X-Agent-Token", enroll_token)
        .json(req)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ingest failed: {} — {}", status, body));
    }
    Ok(())
}
