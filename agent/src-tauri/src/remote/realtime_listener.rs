// Supabase Realtime WSS subscriber for the `agent:<id>` channel.
//
// Protocol reference: https://supabase.com/docs/guides/realtime/protocol
//
// Flow:
//   1. Connect to wss://api-ems.wellnessextract.com/realtime/v1/websocket?apikey=<anon>
//   2. Send `phx_join` on topic "realtime:agent:<agent_id>" with the
//      caller's user JWT (we use the agent's anon-equivalent: a custom
//      claims JWT minted from the enroll token; for now we use the anon
//      key directly since the channel name is per-agent and the agent
//      knows its own id).
//   3. Receive broadcasts on that channel:
//        • `remote.request`  → start consent + rustdesk pipeline
//        • `remote.ended`    → tear down active session
//   4. Heartbeat every 30 s with `phx_heartbeat`.
//
// This loop returns when the WSS is dropped — caller wraps it in a
// reconnect backoff loop (see mod.rs).

use crate::{config, AppState};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::{consent, rustdesk_host, RemoteState};

#[derive(Serialize)]
struct PhxFrame<'a, T: Serialize> {
    topic: &'a str,
    event: &'a str,
    payload: T,
    #[serde(rename = "ref")]
    msg_ref: String,
}

#[derive(Deserialize)]
struct InboundMessage {
    topic: String,
    event: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Serialize)]
struct JoinPayload<'a> {
    config: JoinConfig,
    access_token: &'a str,
}
#[derive(Serialize, Default)]
struct JoinConfig {
    broadcast: BroadcastConfig,
    presence: PresenceConfig,
    postgres_changes: Vec<()>,
    private: bool,
}
#[derive(Serialize)]
struct BroadcastConfig { self_: bool, ack: bool }
impl Default for BroadcastConfig { fn default() -> Self { Self { self_: false, ack: false } } }
#[derive(Serialize, Default)]
struct PresenceConfig { key: String }

pub async fn run(state: AppState, app: AppHandle, remote: Arc<RemoteState>) -> Result<()> {
    // Resolve agent identity from config (already-enrolled at this point).
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?
        .clone();
    let agent_id = enrollment.agent_id.clone();
    let supabase_url = config::supabase_url(&cfg)
        .ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg)
        .ok_or_else(|| anyhow!("no anon key"))?;

    // Supabase Realtime WSS URL.
    // ws path is /realtime/v1/websocket?apikey=<anon>&vsn=1.0.0.
    let wss_url = format!(
        "{}/realtime/v1/websocket?apikey={}&vsn=1.0.0",
        supabase_url.trim_end_matches('/').replace("http://", "ws://").replace("https://", "wss://"),
        urlencoding::encode(&anon_key),
    );
    log::info!("remote: connecting realtime WSS to {wss_url}");

    let (ws_stream, _resp) = tokio_tungstenite::connect_async(&wss_url)
        .await
        .context("realtime ws connect")?;
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // -- JOIN channel --
    let topic = format!("realtime:agent:{agent_id}");
    let join_frame = PhxFrame {
        topic: &topic,
        event: "phx_join",
        payload: JoinPayload {
            access_token: &anon_key,
            config: JoinConfig::default(),
        },
        msg_ref: "1".into(),
    };
    let join_json = serde_json::to_string(&join_frame)?;
    ws_tx.send(Message::Text(join_json.into())).await
        .context("send phx_join")?;

    // -- Heartbeat task --
    // Channel for the heartbeat task to push heartbeat frames into the
    // shared sink. We can't share &mut ws_tx across tasks, so we route
    // heartbeats via mpsc back to the read-loop here.
    let (hb_tx, mut hb_rx) = mpsc::channel::<String>(8);
    {
        let hb_tx = hb_tx.clone();
        let topic = topic.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(25));
            let mut ref_n = 100u64;
            interval.tick().await; // skip immediate
            loop {
                interval.tick().await;
                ref_n += 1;
                let hb = serde_json::json!({
                    "topic": topic,
                    "event": "heartbeat",
                    "payload": {},
                    "ref": ref_n.to_string(),
                }).to_string();
                if hb_tx.send(hb).await.is_err() { break; }
            }
        });
    }

    log::info!("remote: realtime joined topic={topic}");

    // -- Read loop --
    loop {
        tokio::select! {
            maybe_msg = ws_rx.next() => {
                let Some(msg) = maybe_msg else { return Err(anyhow!("realtime ws closed")); };
                let msg = msg.context("ws recv")?;
                match msg {
                    Message::Text(t) => {
                        if let Ok(parsed) = serde_json::from_str::<InboundMessage>(&t) {
                            if parsed.topic != topic { continue; }
                            handle_event(&state, &app, &remote, &parsed).await;
                        }
                    }
                    Message::Ping(p) => {
                        ws_tx.send(Message::Pong(p)).await.ok();
                    }
                    Message::Close(_) => {
                        return Err(anyhow!("realtime ws received close frame"));
                    }
                    _ => {}
                }
            }
            hb = hb_rx.recv() => {
                if let Some(frame) = hb {
                    if let Err(e) = ws_tx.send(Message::Text(frame.into())).await {
                        return Err(anyhow!("ws heartbeat send: {e}"));
                    }
                }
            }
        }
    }
}

async fn handle_event(
    state: &AppState,
    app: &AppHandle,
    remote: &Arc<RemoteState>,
    msg: &InboundMessage,
) {
    // Supabase Realtime wraps broadcasts as { event: "broadcast",
    // payload: { event: "<our-event-name>", payload: {...} } }.
    // We unwrap one layer here.
    if msg.event != "broadcast" {
        return;
    }
    let payload = &msg.payload;
    let inner_event = payload.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let inner_payload = payload.get("payload").cloned().unwrap_or(serde_json::Value::Null);

    match inner_event {
        "remote.request" => {
            log::info!("remote: received remote.request payload={inner_payload}");
            let state = state.clone();
            let app = app.clone();
            let remote = remote.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle_request(state, app, remote, inner_payload).await {
                    log::warn!("remote.request handler failed: {e}");
                }
            });
        }
        "signature.push" => {
            log::info!("signature: received signature.push");
            // Windows-only. On macOS/Linux the Outlook OWA push (Exchange
            // PowerShell REST from the signatures-push edge fn) has already
            // handled the user's signature — nothing local to do.
            #[cfg(target_os = "windows")]
            {
                let state = state.clone();
                let remote = remote.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = handle_signature_push(state, remote).await {
                        log::warn!("signature.push handler failed: {e}");
                    }
                });
            }
            #[cfg(not(target_os = "windows"))]
            {
                log::debug!("signature: ignoring signature.push (non-Windows)");
            }
        }
        "agent.update_now" => {
            // Admin clicked "Force update" in the dashboard. Ring the
            // updater bell — the updater loop's tokio::select! wakes up
            // and calls check_for_update() immediately instead of waiting
            // for its next 60s / 10-min tick. Same code path as normal
            // auto-update, just triggered on demand.
            log::info!("updater: agent.update_now received");
            crate::wake_updater();
        }
        "tool.run" => {
            log::info!("tool.run: received payload={inner_payload}");
            // Windows-only. Both bundled scripts (DriverManagerPro,
            // Optimize) rely on Windows-only cmdlets — on macOS/Linux the
            // agent has nothing to do, so we log-and-ignore rather than
            // fake-succeed. The dashboard button is gated on
            // agent.os_type === 'Windows' anyway.
            #[cfg(target_os = "windows")]
            {
                let state = state.clone();
                let remote = remote.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = handle_tool_run(state, remote, inner_payload).await {
                        log::warn!("tool.run handler failed: {e}");
                    }
                });
            }
            #[cfg(not(target_os = "windows"))]
            {
                log::debug!("tool.run: ignoring on non-Windows platform");
            }
        }
        "remote.ended" => {
            log::info!("remote: received remote.ended payload={inner_payload}");
            let remote = remote.clone();
            tauri::async_runtime::spawn(async move {
                let mut slot = remote.active_session.lock().await;
                if let Some(handle) = slot.take() {
                    let _ = handle.shutdown().await;
                }
                // Even if the slot was already empty, sweep any stray
                // rustdesk processes — the previous shutdown may have
                // missed a helper child (--cm connection manager, etc).
                drop(slot);
                rustdesk_host::kill_orphan_rustdesk().await;
            });
        }
        _ => {
            log::debug!("remote: ignoring inner event {inner_event}");
        }
    }
}

#[derive(Deserialize)]
struct RequestPayload {
    session_id: String,
    viewer_name: Option<String>,
    reason: Option<String>,
    rustdesk_server: String,
    session_token: String,
    // Edge fn currently emits `null` (not `false`) when org policy
    // requires consent. Default-on-null accepts both shapes.
    #[serde(default, deserialize_with = "de_bool_null_as_false")]
    auto_approved: bool,
}

fn de_bool_null_as_false<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<bool>::deserialize(d)?.unwrap_or(false))
}

/// Fetch the org's active Outlook signature for this agent's user and
/// deploy it locally. Windows only — on other OSes the OWA push path
/// already handled the signature server-side.
///
/// Fires on the `signature.push` Realtime broadcast triggered by the
/// admin's "Push signature now" button in the portal.
#[cfg(target_os = "windows")]
async fn handle_signature_push(state: crate::AppState, remote: Arc<super::RemoteState>) -> Result<()> {
    let (supabase_url, anon_key, enroll_token) = {
        let cfg = state.config.lock().await.clone();
        let url = crate::config::supabase_url(&cfg);
        let anon = crate::config::supabase_anon_key(&cfg);
        let tok = cfg.enrollment.as_ref().map(|e| e.enroll_token.clone());
        (url, anon, tok)
    };
    let (url, anon, token) = match (supabase_url, anon_key, enroll_token) {
        (Some(u), Some(a), Some(t)) => (u, a, t),
        _ => return Err(anyhow!("agent not enrolled — cannot deploy signature")),
    };

    let client = crate::api::build_client().context("build_client")?;

    let last = remote.last_signature_checksum.lock().await.clone();
    match crate::signature_deploy::deploy_now(&client, &url, &anon, &token, last.as_deref()).await {
        Ok(new_checksum) => {
            if let Some(c) = new_checksum {
                *remote.last_signature_checksum.lock().await = Some(c);
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Payload of the `tool.run` broadcast the dashboard's `agent-run-tool`
/// edge function sends into the `agent:<id>` channel when an admin clicks
/// "Run Driver Update" / "Run Windows Optimizer". Nothing else in the
/// codebase produces this event.
#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct ToolRunPayload {
    tool: String,   // "driver_updater" | "windows_optimizer"
    run_id: String, // UUID of the pre-inserted tool_runs row
}

/// Fetch config, guard against overlapping runs, execute the requested
/// tool via `endpoint_tools::run_tool()`, and POST the result envelope
/// to `agent-tool-result`. The `active_tool_run` mutex is held across
/// the entire spawn_blocking run so a second `tool.run` broadcast for
/// this agent while one is executing gets rejected cleanly.
#[cfg(target_os = "windows")]
async fn handle_tool_run(
    state: crate::AppState,
    remote: Arc<super::RemoteState>,
    payload: serde_json::Value,
) -> Result<()> {
    let parsed: ToolRunPayload = serde_json::from_value(payload)
        .context("parse tool.run payload")?;
    let kind = crate::endpoint_tools::ToolKind::parse(&parsed.tool)
        .ok_or_else(|| anyhow!("unknown tool kind: {}", parsed.tool))?;

    // Reject overlap. `try_lock` isn't ideal (we want to hold the guard
    // for the whole run) — instead we set the slot, release the mutex,
    // and clear the slot at the end. If a second broadcast lands while
    // active_tool_run is Some, we drop it with a log line.
    {
        let mut slot = remote.active_tool_run.lock().await;
        if let Some(existing) = slot.as_ref() {
            log::warn!(
                "tool.run: rejecting overlapping run (already running={existing}, incoming={})",
                parsed.run_id
            );
            return Ok(());
        }
        *slot = Some(parsed.run_id.clone());
    }

    let result_res = crate::endpoint_tools::run_tool(kind, parsed.run_id.clone()).await;

    // Always clear the guard, even on Err — a stuck slot would lock out
    // future runs until the agent restarts.
    *remote.active_tool_run.lock().await = None;

    let result = result_res.context("endpoint_tools::run_tool")?;

    // Post back to the dashboard. Config lookup deferred to POST time so
    // a config change mid-run (unlikely but possible) picks up fresh
    // supabase_url / anon_key.
    let (supabase_url, anon_key, enroll_token) = {
        let cfg = state.config.lock().await.clone();
        let url = crate::config::supabase_url(&cfg);
        let anon = crate::config::supabase_anon_key(&cfg);
        let tok = cfg.enrollment.as_ref().map(|e| e.enroll_token.clone());
        (url, anon, tok)
    };
    let (url, anon, token) = match (supabase_url, anon_key, enroll_token) {
        (Some(u), Some(a), Some(t)) => (u, a, t),
        _ => return Err(anyhow!("agent not enrolled — cannot post tool result")),
    };
    let client = crate::api::build_client().context("build_client")?;
    crate::endpoint_tools::post_result(&client, &url, &anon, &token, &result).await
}

async fn handle_request(
    state: AppState,
    app: AppHandle,
    remote: Arc<RemoteState>,
    payload: serde_json::Value,
) -> Result<()> {
    let req: RequestPayload = serde_json::from_value(payload)
        .context("parse remote.request payload")?;

    // If a previous session is still in our slot, shut it down before
    // starting a new one. Refusing-with-deny was customer-hostile: any
    // crash/abort that left active_session populated would block all
    // future sessions until agent restart. Now we always recover.
    {
        let mut slot = remote.active_session.lock().await;
        if let Some(handle) = slot.take() {
            log::info!("remote: shutting down stale active_session before new request");
            let _ = handle.shutdown().await;
        }
    }
    // Belt-and-suspenders: nuke any rustdesk.exe that survived our
    // shutdown (helper child processes, OS-killed parents, etc).
    rustdesk_host::kill_orphan_rustdesk().await;

    // Consent step (skipped if auto_approved by org policy).
    let approved = if req.auto_approved {
        true
    } else {
        consent::show_prompt(&app, &req.viewer_name.clone().unwrap_or_else(|| "Admin".into()),
                             &req.reason.clone().unwrap_or_default())
            .await
            .unwrap_or(false)
    };
    let decision = if approved { "allow" } else { "deny" };

    // Report decision to backend (also bumps trusted_until if appropriate).
    super::audit::post_decision(&state, &req.session_id, decision, None).await?;
    if !approved {
        return Ok(());
    }

    // Spawn rustdesk subprocess. The relay's public key is deployment-specific,
    // so resolve it from config (env -> agent.json -> compiled default) rather
    // than trusting a constant baked into the binary.
    let hbbs_pubkey = {
        let cfg = state.config.lock().await;
        crate::config::hbbs_pubkey(&cfg)
    };
    let host = match rustdesk_host::start(
        &req.rustdesk_server, &req.session_token, &hbbs_pubkey,
    ).await {
        Ok(h) => h,
        Err(e) => {
            log::warn!("remote: rustdesk_host start failed: {e}");
            super::audit::post_end(&state, &req.session_id,
                &format!("rustdesk_host start failed: {e}")).await.ok();
            return Err(e);
        }
    };

    let rustdesk_id = host.rustdesk_id.clone();
    let rustdesk_pass = host.rustdesk_password.clone();

    // Store handle so /remote.ended can tear it down later.
    {
        let mut slot = remote.active_session.lock().await;
        *slot = Some(host);
    }

    // Tell backend we're ready — flips state to 'publishing', dashboard
    // iframe can now connect.
    super::audit::post_ready(
        &state, &req.session_id, &rustdesk_id, rustdesk_pass.as_deref(),
    ).await?;
    Ok(())
}
