// Supabase Realtime WSS subscriber for the `agent:<id>` channel.
//
// Protocol reference: https://supabase.com/docs/guides/realtime/protocol
//
// Flow:
//   1. Connect to wss://api.rudrans.com/realtime/v1/websocket?apikey=<anon>
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
        "remote.ended" => {
            log::info!("remote: received remote.ended payload={inner_payload}");
            let remote = remote.clone();
            tauri::async_runtime::spawn(async move {
                let mut slot = remote.active_session.lock().await;
                if let Some(handle) = slot.take() {
                    let _ = handle.shutdown().await;
                }
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

async fn handle_request(
    state: AppState,
    app: AppHandle,
    remote: Arc<RemoteState>,
    payload: serde_json::Value,
) -> Result<()> {
    let req: RequestPayload = serde_json::from_value(payload)
        .context("parse remote.request payload")?;

    // Singleton enforcement — refuse a 2nd session if one is in flight.
    {
        let slot = remote.active_session.lock().await;
        if slot.is_some() {
            log::warn!("remote: session ignored — another already active");
            super::audit::post_decision(&state, &req.session_id, "deny",
                Some("agent already has an active session")).await.ok();
            return Ok(());
        }
    }

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

    // Spawn rustdesk subprocess.
    let host = match rustdesk_host::start(&req.rustdesk_server, &req.session_token).await {
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
