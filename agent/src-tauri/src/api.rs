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
}

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
        return Err(anyhow!("settings fetch failed: {} — {}", status, body));
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
    let json = resp.json::<ValidateLicenseResponse>().await
        .map_err(|e| anyhow!("validate-license parse: {} (http {})", e, status))?;
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

pub fn build_client() -> Result<Client> {
    Ok(Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("TrackForceAgent/0.1")
        .build()?)
}

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
        return Err(anyhow!("enroll failed: {} — {}", status, body));
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
