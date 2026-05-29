// Thin POST helpers the realtime listener / rustdesk_host use to inform the
// backend about per-session lifecycle events. Each function maps to one
// edge function deployed in supabase/functions/.
//
// All three call X-Agent-Token (the agent's enroll_token) for auth — the
// edge fn looks up the agent row from there and verifies ownership of the
// session being mutated.

use crate::{config, AppState};
use anyhow::{anyhow, Context, Result};
use serde_json::json;

async fn post(state: &AppState, path: &str, body: serde_json::Value) -> Result<()> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?.clone();
    let supabase_url = config::supabase_url(&cfg)
        .ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg)
        .ok_or_else(|| anyhow!("no anon key"))?;
    let client = crate::api::build_client()?;
    let url = format!("{}/functions/v1{}", supabase_url.trim_end_matches('/'), path);
    let resp = client.post(&url)
        .bearer_auth(&anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .json(&body)
        .send().await
        .with_context(|| format!("POST {path}"))?;
    if !resp.status().is_success() {
        let st = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("{path} -> {st}: {body}"));
    }
    Ok(())
}

/// Agent reports the employee's consent decision (or that consent was
/// auto-approved by policy). `decision` ∈ {"allow","deny","once"}.
pub async fn post_decision(
    state: &AppState,
    session_id: &str,
    decision: &str,
    reason: Option<&str>,
) -> Result<()> {
    let mut body = json!({ "session_id": session_id, "decision": decision });
    if let Some(r) = reason {
        body["reason"] = json!(r);
    }
    post(state, "/remote-session-approve", body).await
}

/// Agent reports its rustdesk subprocess is up and accepting connections.
/// This flips the session state to 'publishing' so the dashboard can launch
/// the viewer.
pub async fn post_ready(
    state: &AppState,
    session_id: &str,
    rustdesk_id: &str,
) -> Result<()> {
    post(state, "/remote-session-ready", json!({
        "session_id": session_id,
        "rustdesk_id": rustdesk_id,
    })).await
}

/// Agent reports the session is over (either rustdesk subprocess died, the
/// employee closed the consent prompt mid-session, or some other failure).
pub async fn post_end(
    state: &AppState,
    session_id: &str,
    reason: &str,
) -> Result<()> {
    post(state, "/remote-session-end", json!({
        "session_id": session_id,
        "reason": reason,
    })).await
}
