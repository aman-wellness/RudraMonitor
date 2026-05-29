// Agent side of the live-monitoring WebRTC stream.
//
// Flow per session:
//   1. Long-poll /webrtc-signal looking for direction=to_agent messages
//      (kind=offer). One outstanding listen at a time across all sessions.
//   2. On `offer` arrival: fetch TURN credentials, build an RTCPeerConnection
//      with our self-hosted STUN/TURN, add a video track wired to the bundled
//      ffmpeg h264 encoder, set the remote description, create + set local
//      answer, POST the answer back through /webrtc-signal.
//   3. Subscribe to local ICE candidates and POST each one (trickle ICE) so
//      the dashboard side gets them as they're discovered. Simultaneously
//      keep long-polling for remote candidates and feed them into the peer
//      connection.
//   4. Spawn an ffmpeg subprocess that writes raw H.264 Annex-B to stdout.
//      Parse NAL units, batch them into samples, push into the track. When
//      the peer connection's ICE state transitions to Disconnected or Failed,
//      kill ffmpeg and tear the session down.
//   5. Restart the signaling loop from (1).
//
// Auth: the agent sends its enroll_token as X-Agent-Token on every signal
// HTTP call, plus the project anon key as the apikey header. The
// /webrtc-signal edge function (PR 2) enforces direction + agent_id ownership.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::time::sleep;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::input::{self, InputEvent, MouseButton};
use crate::{api, config, AppState};

// 30 fps capture so the dashboard cursor catches up with the operator's
// real mouse motion. At 15 fps the customer saw a "drag" / hang feeling
// because each frame ate 66 ms before the next paint — by the time the
// dashboard rendered the cursor at position N, the operator had already
// moved to position N+3 in their head.
// Lightweight defaults (v0.2.58+). The "agent must not hang the
// customer's machine" goal is the dominant constraint — every encoder
// CPU cycle saved on the agent is one fewer reason an employee
// complains. Tuned conservatively for the lowest-spec hardware we
// ship to (Mac Mini 2018 / Surface Pro 7 baseline):
//
//   • 24 fps (was 30) → ~20% encoder CPU saved; mouse motion still
//                       fluid to the human eye (cinema rate).
//   • 960 px wide (was 1280) → 44% fewer pixels to encode each frame.
//                              Still legible enough that an admin can
//                              read the agent's screen during Live.
//   • 1.2 Mbps bitrate (was 2.5 Mbps) → halves the bytes-on-wire and
//                                       lets corporate networks behave.
//
// Dashboard's adaptive-bitrate ladder can dial these UP per-session
// via the `set_quality` control message when network capacity allows.
const TARGET_FPS: u32 = 24;
const TARGET_WIDTH: u32 = 960;
const DEFAULT_BITRATE_KBPS: u32 = 1_200;

/// Shared mutable stream parameters. The control DataChannel writes to
/// these via `InboundMsg::SetQuality`; the ffmpeg pump reads them when
/// it (re)spawns the encoder. Backed by tokio::Mutex so the lock is
/// async-friendly across awaits.
#[derive(Clone, Copy, Debug)]
pub struct StreamParams {
    pub width: u32,
    pub bitrate_kbps: u32,
}
impl Default for StreamParams {
    fn default() -> Self { Self { width: TARGET_WIDTH, bitrate_kbps: DEFAULT_BITRATE_KBPS } }
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct SignalMessage {
    id: String,
    kind: String,
    payload: serde_json::Value,
    created_at: String,
    // Edge fn surfaces session_id on the envelope so agents that
    // broadcast-poll (no session_id query param) can route incoming offers.
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SignalPollResponse {
    messages: Vec<SignalMessage>,
}

#[derive(Debug, Deserialize)]
struct TurnCredentials {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<TurnIceServer>,
}

#[derive(Debug, Deserialize, Clone)]
struct TurnIceServer {
    urls: serde_json::Value,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

/// Spawn the long-running signaling listener. Idempotent across agent
/// restarts — each invocation starts one task that runs forever, picking
/// up offers as they arrive.
pub fn spawn_streaming_loop(state: AppState) {
    tauri::async_runtime::spawn(async move {
        // Wait until the agent is enrolled before doing anything. The HTTP
        // layer needs supabase_url + enroll_token, both come from config
        // after the user enters their license.
        loop {
            if crate::ready(&state).await {
                break;
            }
            sleep(Duration::from_secs(5)).await;
        }
        log::info!("webrtc stream: signaling loop starting");
        let mut since = chrono::Utc::now().to_rfc3339();
        loop {
            match poll_once(&state, &since).await {
                Ok(Some(new_since)) => since = new_since,
                Ok(None) => {}
                Err(e) => {
                    log::warn!("webrtc poll failed: {e}; backing off 10s");
                    sleep(Duration::from_secs(10)).await;
                }
            }
        }
    });
}

/// One pass of the long-poll loop. Returns the updated `since` cursor (the
/// `created_at` of the newest message we handled) so subsequent polls don't
/// re-receive the same offer.
async fn poll_once(state: &AppState, since: &str) -> Result<Option<String>> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg
        .enrollment
        .as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?
        .clone();
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;

    let url = format!(
        "{}/functions/v1/webrtc-signal?session_id=&direction=to_agent&since={}",
        supabase_url.trim_end_matches('/'),
        urlencoding(since)
    );
    let client = api::build_client()?;
    let resp = client
        .get(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .send()
        .await
        .context("signaling long-poll")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("signal poll http {}: {}", status, body));
    }
    // The endpoint's GET handler doesn't actually filter by session_id when
    // it's blank — that's a limitation we'll fix in a follow-up PR. For now
    // the agent only handles one active session at a time anyway, so we
    // accept the broader scan.
    let body: SignalPollResponse = resp.json().await.context("parse poll response")?;

    let mut newest = None;
    for msg in body.messages {
        newest = Some(msg.created_at.clone());
        if msg.kind != "offer" {
            // ICE candidates without an active session are dropped silently —
            // they belong to a peer connection we're not running yet.
            continue;
        }
        // session_id rides on the envelope (the edge function surfaces it
        // from the DB row); sdp is inside the payload alongside any future
        // metadata. If either is missing we drop the offer rather than
        // crashing the polling loop on bad input.
        let session_id = match msg.session_id.clone() {
            Some(s) if !s.is_empty() => s,
            _ => {
                log::warn!("webrtc: offer dropped — missing session_id on envelope");
                continue;
            }
        };
        let sdp = msg
            .payload
            .get("sdp")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("offer missing sdp"))?
            .to_string();
        log::info!("webrtc: offer received for session {}", session_id);
        // Handle the session in a dedicated task so the polling loop keeps
        // running. A flaky connection can stall for tens of seconds during
        // ICE negotiation and we don't want signaling to back up behind it.
        //
        // Pass the offer's created_at down as `ice_since` so the per-session
        // ICE poller picks up any candidates the dashboard posted in the
        // same window as the offer. Previously the ICE poller used
        // `now()` as its starting cursor, which silently dropped every
        // candidate that arrived before the offer-handler had spawned its
        // task — and dashboards trickle their candidates the instant
        // setLocalDescription returns, often a few hundred ms BEFORE the
        // agent finishes building its peer connection. That dropped batch
        // forced ICE to fall back to TURN relay, which is the "remote
        // takes 10-20 seconds to connect" lag the customer reported.
        let ice_since = msg.created_at.clone();
        let st = state.clone();
        let eid = enrollment.agent_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle_session(&st, &session_id, &eid, &sdp, &ice_since).await {
                log::warn!("webrtc session {} failed: {}", session_id, e);
            }
        });
    }
    Ok(newest)
}

async fn handle_session(
    state: &AppState,
    session_id: &str,
    agent_id: &str,
    offer_sdp: &str,
    ice_since: &str,
) -> Result<()> {
    let ice_servers = fetch_ice_servers(state).await?;

    // Build the WebRTC API instance. Default codecs include H.264; we don't
    // need to register anything extra. The dashboard-side SDP munger (see
    // src/pages/monitoring/components/LiveTab.tsx) strips non-baseline H.264
    // PTs from the offer BEFORE we see it, so the answer that webrtc-rs
    // generates can only pick from baseline-compatible PTs. Doing the
    // restriction dashboard-side instead of agent-side is safer because:
    //   • we can deploy a dashboard build in seconds (no Rust rebuild + CI),
    //   • register_default_codecs() is the well-trodden path through
    //     webrtc-rs's negotiation logic — replacing it caused the agent to
    //     emit malformed answers on v0.2.49/0.2.50 (no signaling rows ever
    //     hit the DB).
    let mut me = MediaEngine::default();
    me.register_default_codecs()
        .map_err(|e| anyhow!("register codecs: {e}"))?;
    let registry = Registry::new();
    let api = APIBuilder::new()
        .with_media_engine(me)
        .with_interceptor_registry(registry)
        .build();

    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };
    let pc = Arc::new(
        api.new_peer_connection(config)
            .await
            .map_err(|e| anyhow!("new_peer_connection: {e}"))?,
    );

    // Local video track — payload type 0 lets the API auto-pick H.264 from
    // the negotiated answer.
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: webrtc::api::media_engine::MIME_TYPE_H264.to_owned(),
            ..Default::default()
        },
        "screen-video".to_string(),
        format!("rudrans-{}", agent_id),
    ));
    let rtp_sender = pc
        .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| anyhow!("add_track: {e}"))?;
    // RTP feedback drainer — required so the sender's interceptors keep
    // running (FEC, NACK, etc). We don't act on the packets ourselves.
    tauri::async_runtime::spawn(async move {
        let mut rtcp_buf = vec![0u8; 1500];
        while let Ok((_, _)) = rtp_sender.read(&mut rtcp_buf).await {}
    });

    // Trickle ICE: every local candidate gets shipped to the dashboard.
    {
        let st = state.clone();
        let sid = session_id.to_string();
        let aid = agent_id.to_string();
        pc.on_ice_candidate(Box::new(move |c| {
            let st = st.clone();
            let sid = sid.clone();
            let aid = aid.clone();
            Box::pin(async move {
                if let Some(c) = c {
                    if let Ok(j) = c.to_json() {
                        let _ = post_signal(
                            &st,
                            &sid,
                            &aid,
                            "to_dashboard",
                            "ice_candidate",
                            serde_json::to_value(j).unwrap_or(serde_json::Value::Null),
                        )
                        .await;
                    }
                }
            })
        }));
    }

    // Watch for connection death so we can tear ffmpeg down. Failed and
    // Closed are immediate signals. Disconnected gets a 15s grace period
    // (consent freshness can recover spontaneously on flaky networks); if
    // it's still Disconnected after that, treat it as dead and kill ffmpeg.
    //
    // Without the grace-period kill, a hung Disconnected leaves ffmpeg
    // running indefinitely holding the macOS avfoundation screen device —
    // which then starves the legitimate screenshot + video-clip recorders.
    let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let is_disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let stop_flag = stop_flag.clone();
        let is_disconnected = is_disconnected.clone();
        pc.on_ice_connection_state_change(Box::new(move |s: RTCIceConnectionState| {
            let stop_flag = stop_flag.clone();
            let is_disconnected = is_disconnected.clone();
            Box::pin(async move {
                log::info!("webrtc ice state: {s}");
                match s {
                    RTCIceConnectionState::Failed | RTCIceConnectionState::Closed => {
                        stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    RTCIceConnectionState::Disconnected => {
                        is_disconnected.store(true, std::sync::atomic::Ordering::SeqCst);
                        let stop_flag = stop_flag.clone();
                        let is_disconnected = is_disconnected.clone();
                        tauri::async_runtime::spawn(async move {
                            sleep(Duration::from_secs(15)).await;
                            // Kill only if connection never recovered.
                            if is_disconnected.load(std::sync::atomic::Ordering::SeqCst) {
                                stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                            }
                        });
                    }
                    _ => {
                        is_disconnected.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            })
        }));
    }

    // Remote-control data channel. If the dashboard's offer SDP contains an
    // `m=application` section (Remote tab — not Live tab), webrtc-rs surfaces
    // the channel via this callback once SDP negotiation completes. We then
    // attach our message router which forwards JSON-encoded input events to
    // the input thread. Live-tab connections never trigger this — they only
    // negotiate a video m-section, so the callback simply never fires.
    // Shared stream-quality knobs. The control DataChannel writes to
    // these on `set_quality`; the ffmpeg pump reads them and respawns
    // when they change. Wrapped in an Arc<Mutex<>> so both sides can
    // hold their own reference across awaits.
    let stream_params = Arc::new(tokio::sync::Mutex::new(StreamParams::default()));
    let reload_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let params_for_dc = stream_params.clone();
        let reload_for_dc = reload_flag.clone();
        pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
            let params = params_for_dc.clone();
            let reload = reload_for_dc.clone();
            Box::pin(async move {
                log::info!("webrtc: data channel '{}' attached", dc.label());
                attach_control_channel(dc, params, reload);
            })
        }));
    }

    // SDP exchange.
    let offer = RTCSessionDescription::offer(offer_sdp.to_string())
        .map_err(|e| anyhow!("parse offer sdp: {e}"))?;
    pc.set_remote_description(offer)
        .await
        .map_err(|e| anyhow!("set_remote: {e}"))?;
    let answer = pc
        .create_answer(None)
        .await
        .map_err(|e| anyhow!("create_answer: {e}"))?;
    pc.set_local_description(answer.clone())
        .await
        .map_err(|e| anyhow!("set_local: {e}"))?;
    post_signal(
        state,
        session_id,
        agent_id,
        "to_dashboard",
        "answer",
        json!({ "sdp": answer.sdp }),
    )
    .await?;

    // Spawn remote-ICE consumer (long-polls for ice_candidate messages and
    // adds them to the peer connection).
    {
        let pc = Arc::clone(&pc);
        let st = state.clone();
        let sid = session_id.to_string();
        let stop_flag = stop_flag.clone();
        // Anchor the ICE cursor to the offer's timestamp so any candidates
        // posted in parallel with the offer (trickle ICE — dashboards start
        // emitting them the instant setLocalDescription returns) are
        // included in the very first poll. now()-based anchoring used to
        // lose this batch, forcing ICE to TURN-relay and dragging the
        // connect time out to 10-20 s.
        let initial_since = ice_since.to_string();
        tauri::async_runtime::spawn(async move {
            let mut since = initial_since;
            while !stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
                match poll_remote_ice(&st, &sid, &since).await {
                    Ok((newest, candidates)) => {
                        if let Some(n) = newest {
                            since = n;
                        }
                        for c in candidates {
                            if let Err(e) = pc.add_ice_candidate(c).await {
                                log::warn!("add_ice_candidate failed: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("remote ice poll error: {e}");
                        sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        });
    }

    // Spawn ffmpeg + pump frames into the video track. Blocks until either
    // ffmpeg exits, the peer disconnects, or we hit an unrecoverable error.
    pump_ffmpeg_into_track(video_track, stop_flag.clone(), stream_params.clone(), reload_flag.clone()).await?;

    // Cleanup.
    let _ = pc.close().await;
    Ok(())
}

async fn fetch_ice_servers(state: &AppState) -> Result<Vec<RTCIceServer>> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg
        .enrollment
        .as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?
        .clone();
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let url = format!(
        "{}/functions/v1/webrtc-turn-credentials",
        supabase_url.trim_end_matches('/')
    );
    let client = api::build_client()?;
    let resp = client
        .post(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .send()
        .await
        .context("fetch turn creds")?;
    let creds: TurnCredentials = resp.json().await.context("parse turn creds")?;

    let mut out = Vec::new();
    for s in creds.ice_servers {
        // `urls` can be a string or an array — normalize to Vec<String>.
        let urls: Vec<String> = match s.urls {
            serde_json::Value::String(s) => vec![s],
            serde_json::Value::Array(arr) => arr
                .into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => continue,
        };
        out.push(RTCIceServer {
            urls,
            username: s.username.unwrap_or_default(),
            credential: s.credential.unwrap_or_default(),
            ..Default::default()
        });
    }
    Ok(out)
}

async fn post_signal(
    state: &AppState,
    session_id: &str,
    agent_id: &str,
    direction: &str,
    kind: &str,
    payload: serde_json::Value,
) -> Result<()> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg
        .enrollment
        .as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?
        .clone();
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let url = format!(
        "{}/functions/v1/webrtc-signal",
        supabase_url.trim_end_matches('/')
    );
    let client = api::build_client()?;
    let body = json!({
        "session_id": session_id,
        "agent_id": agent_id,
        "direction": direction,
        "kind": kind,
        "payload": payload,
    });
    let resp = client
        .post(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "post_signal {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    Ok(())
}

async fn poll_remote_ice(
    state: &AppState,
    session_id: &str,
    since: &str,
) -> Result<(Option<String>, Vec<RTCIceCandidateInit>)> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg
        .enrollment
        .as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?
        .clone();
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let url = format!(
        "{}/functions/v1/webrtc-signal?session_id={}&direction=to_agent&since={}",
        supabase_url.trim_end_matches('/'),
        urlencoding(session_id),
        urlencoding(since)
    );
    let client = api::build_client()?;
    let resp = client
        .get(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .send()
        .await?;
    let body: SignalPollResponse = resp.json().await?;
    let mut newest = None;
    let mut candidates = Vec::new();
    for msg in body.messages {
        newest = Some(msg.created_at.clone());
        if msg.kind == "ice_candidate" {
            if let Ok(c) = serde_json::from_value::<RTCIceCandidateInit>(msg.payload) {
                candidates.push(c);
            }
        }
    }
    Ok((newest, candidates))
}

/// Build the ffmpeg command for the current StreamParams. Factored out
/// so `pump_ffmpeg_into_track` can respawn the subprocess when adaptive
/// bitrate fires a `set_quality` request without duplicating the long
/// argument list. Returns the spawned Child + its stdout pipe.
pub(crate) async fn spawn_ffmpeg_with_params(
    ffmpeg_bin: &std::path::Path,
    params: StreamParams,
) -> Result<(Child, tokio::process::ChildStdout, &'static str)> {
    let mut cmd = Command::new(ffmpeg_bin);
    // tokio::process::Command has its own creation_flags method (mirrors
    // the std one). win_proc::no_window is std-only, so inline the flag.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.arg("-hide_banner").arg("-loglevel").arg("error");
    // Strip every drop of input-side buffering. Without these flags ffmpeg
    // spends ~200 ms probing the source format and a further frame or two
    // sitting in the demuxer queue before encode starts — that's the lag
    // the operator feels as "mouse hangs / delay" on the dashboard.
    //   -fflags nobuffer        skip the input buffer
    //   -flags low_delay        compositor delay = 0
    //   -probesize 32           don't read 5 MB before deciding format
    //   -analyzeduration 0      don't sample N seconds before reporting
    //   -thread_queue_size 8    keep the input-thread queue tiny
    cmd.arg("-fflags").arg("nobuffer")
        .arg("-flags").arg("low_delay")
        .arg("-probesize").arg("32")
        .arg("-analyzeduration").arg("0")
        .arg("-thread_queue_size").arg("8");
    cmd.arg("-framerate").arg(TARGET_FPS.to_string());
    #[cfg(target_os = "macos")]
    {
        // avfoundation defaults to NOT drawing the mouse cursor — the
        // captured frames are exactly what the OS painted onto the back
        // buffer, and macOS composites the cursor in a separate layer.
        // -capture_cursor 1 forces avfoundation to alpha-blend the cursor
        // into every frame; -capture_mouse_clicks 1 paints a flash at
        // click points which is nice UX during remote sessions. Without
        // these the operator sees their mouse moving on the agent but
        // can't see WHERE on the dashboard — exactly the customer
        // complaint that landed this fix.
        cmd.arg("-capture_cursor").arg("1");
        cmd.arg("-capture_mouse_clicks").arg("1");
        // Reuse the dynamic screen-index probe from video.rs so a Mac with a
        // weird device layout (multi-camera, virtual displays) still picks
        // the right "Capture screen 0".
        let idx = crate::video::macos_screen_index_for_screenshot(&ffmpeg_bin.to_path_buf());
        cmd.arg("-f").arg("avfoundation").arg("-i").arg(format!("{}:none", idx));
    }
    #[cfg(target_os = "windows")]
    {
        // gdigrab's draw_mouse defaults to 1 on most builds but it's been
        // toggled in upstream ffmpeg over the years; pin it explicitly so
        // we always render the cursor into the stream regardless of
        // which bundled ffmpeg version is in use.
        cmd.arg("-draw_mouse").arg("1");
        cmd.arg("-f").arg("gdigrab").arg("-i").arg("desktop");
    }
    #[cfg(target_os = "linux")]
    {
        cmd.arg("-draw_mouse").arg("1");
        cmd.arg("-f").arg("x11grab").arg("-i").arg(":0.0");
    }

    let frame_duration = Duration::from_millis(1000 / TARGET_FPS as u64);

    // Hardware-encoder pick. Parsec/Moonlight (the lowest-latency remote
    // desktop tools available) BOTH use platform hardware encoders —
    // NVENC, QuickSync, AMF, VideoToolbox, VAAPI. Encode cost drops from
    // 10-30 ms (libx264 ultrafast) to 2-8 ms, the CPU stops being pegged
    // during a Live session, and the customer's mouse lag complaint
    // disappears. ffmpeg already ships every encoder we need — this is
    // a one-line swap, not an architectural change. Falls back to
    // libx264 if no hardware path is available.
    let encoder = crate::ffmpeg::pick_h264_encoder(&ffmpeg_bin.to_path_buf());
    for arg in crate::ffmpeg::encoder_args(encoder) {
        cmd.arg(arg);
    }
    // Apply adaptive bitrate: -b:v sets target, -maxrate caps the peak,
    // -bufsize sizes the rate-control buffer. Pegged at the same value
    // for CBR-ish behaviour which plays well with WebRTC GCC.
    let b = format!("{}k", params.bitrate_kbps);
    let bufsize = format!("{}k", params.bitrate_kbps);
    cmd.arg("-b:v").arg(&b)
        .arg("-maxrate").arg(&b)
        .arg("-bufsize").arg(&bufsize);
    cmd.arg("-vf").arg(format!("scale={}:-2", params.width))
        .arg("-an")
        .arg("-f").arg("h264")
        .arg("-")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child: Child = cmd.spawn().context("spawn ffmpeg for webrtc")?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("ffmpeg stdout missing"))?;

    // Drain stderr concurrently so the pipe never fills (which would block
    // ffmpeg's writes and freeze the pipeline). Log any lines we see — when
    // capture fails, the explanation lives here, not in our return value.
    if let Some(mut err) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                match err.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&buf[..n]);
                        for line in s.lines() {
                            if !line.trim().is_empty() {
                                log::warn!("webrtc ffmpeg: {}", line);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    log::info!(
        "webrtc: ffmpeg started encoder={encoder} width={} bitrate={}kbps",
        params.width, params.bitrate_kbps,
    );
    Ok((child, stdout, encoder))
}

/// Spawn the bundled ffmpeg with a screen-capture input + raw H.264 stdout,
/// parse NAL units, and feed each frame into the WebRTC track. Returns when
/// `stop_flag` flips (peer disconnected) or ffmpeg exits. On `reload_flag`
/// the inner ffmpeg child is killed and restarted with the latest
/// StreamParams — that's how adaptive bitrate gets honoured mid-stream.
pub(crate) async fn pump_ffmpeg_into_track(
    track: Arc<TrackLocalStaticSample>,
    stop_flag: Arc<std::sync::atomic::AtomicBool>,
    params: Arc<tokio::sync::Mutex<StreamParams>>,
    reload_flag: Arc<std::sync::atomic::AtomicBool>,
) -> Result<()> {
    let ffmpeg_bin = crate::ffmpeg::locate_ffmpeg()
        .ok_or_else(|| anyhow!("ffmpeg not bundled"))?;
    let frame_duration = Duration::from_millis(1000 / TARGET_FPS as u64);
    // Real-time pacing strategy (revised after v0.2.56 permanently
    // lagged by 2 s):
    //
    // WHY THE PROBLEM: parallel-starting ffmpeg (whip_publisher
    // optimisation) leaves 1-2 s of frames buffered in the kernel
    // pipe by the time pump begins reading. Sleeping between writes
    // to enforce 30 fps means we drain the backlog at 30 fps — same
    // rate ffmpeg keeps producing. The backlog NEVER shrinks; the
    // dashboard is permanently 2 s behind.
    //
    // FIX: ditch wall-clock pacing entirely. Use ffmpeg's own
    // stdout blocking as the natural 30-fps pacer. At steady state
    // each read returns one NAL access-unit's worth of data and we
    // ship it. During startup-burst the reads return many NALs at
    // once. flush_au() detects this via find_start_code lookahead:
    // if ANY more NAL data is queued in buf after we just consumed
    // an AU, this AU is STALE. Drop P-frames; keep I-frames so the
    // decoder always has a clean restart point (~1 s keyframe
    // interval at -g 30). Backlog drains within ~1 s and steady-
    // state catches up to real-time.

    'outer: loop {
        let current = *params.lock().await;
        reload_flag.store(false, std::sync::atomic::Ordering::SeqCst);
        let (mut child, mut stdout, encoder_in_use) =
            spawn_ffmpeg_with_params(&ffmpeg_bin, current).await?;

        let mut buf = Vec::with_capacity(64 * 1024);
        let mut tmp = vec![0u8; 32 * 1024];
    // Access-unit accumulator. Every H.264 picture is a sequence of NAL
    // units (typically SPS + PPS + IDR slice for keyframes, or just one
    // non-IDR slice for delta frames). The CORRECT way to feed webrtc-rs
    // is one Sample per ACCESS UNIT — webrtc-rs then packetizes the AU
    // into RTP packets sharing one timestamp, sets the marker bit on the
    // last packet, and the browser decodes a complete picture. Previous
    // approaches (one Sample per NAL with duration=frame_duration, or
    // duration=0 for non-slices) led to mis-paced or partially-marked
    // frames and the receiver decoded only the top of each picture,
    // leaving everything below as the decoder's "no data" green surface
        // — the exact artefact customers kept reporting through v0.2.37 and
        // v0.2.39. Aggregating into a per-frame Sample fixes that for good.
        let mut au: Vec<u8> = Vec::with_capacity(64 * 1024);

        loop {
            if stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
                log::info!("webrtc: stop_flag set, killing ffmpeg");
                let _ = child.kill().await;
                let _ = child.wait().await;
                break 'outer;
            }
            // Adaptive-bitrate restart path. The control channel writes new
            // params and flips this flag; we kill ffmpeg + respawn at the
            // top of the outer loop. There's a ~500 ms freeze during restart
            // which is much smaller than the freeze the network would cause
            // if we kept blasting frames at the wrong bitrate.
            if reload_flag.load(std::sync::atomic::Ordering::SeqCst) {
                log::info!("webrtc: reload_flag set, restarting ffmpeg for new quality");
                let _ = child.kill().await;
                let _ = child.wait().await;
                continue 'outer;
            }
            let n = match stdout.read(&mut tmp).await {
                Ok(0) => break, // eof
                Ok(n) => n,
                Err(e) => {
                    log::warn!("ffmpeg stdout read error: {e}");
                    break;
                }
            };
            buf.extend_from_slice(&tmp[..n]);

            // Pull NAL units out of the buffer. Each NAL is appended to the
            // current access-unit buffer. A slice NAL (type 1 or 5) terminates
            // the picture — we flush the accumulated AU as one Sample with
            // the wall-clock frame_duration so RTP timestamps stay aligned
            // with real-time playback. AUDs (type 9) are also treated as a
            // boundary: their presence usually means the next slice belongs
            // to the NEXT picture, so we flush BEFORE adding the AUD.
            while let Some(unit) = take_nal_unit(&mut buf) {
                if unit.is_empty() {
                    continue;
                }
                let nal_type = nal_unit_type(&unit);
                // AUD boundary: flush whatever we have, then start fresh with
                // this AUD opening the next picture.
                if nal_type == 9 && !au.is_empty() {
                    if !flush_au(&track, &mut au, &buf, frame_duration, nal_type).await {
                        break;
                    }
                }
                au.extend_from_slice(&unit);
                // Slice NAL ends the access unit.
                if matches!(nal_type, 1 | 5) {
                    if !flush_au(&track, &mut au, &buf, frame_duration, nal_type).await {
                        break;
                    }
                }
            }
        }

        // ffmpeg exited unexpectedly — log the encoder so the failure is
        // diagnosable from the log, then bail. No silent fallback: every
        // configured encoder is expected to JUST WORK end-to-end. If it
        // doesn't, the encoder_args entry or the bundled ffmpeg build
        // needs the fix, not a runtime band-aid.
        let _ = child.wait().await;
        log::warn!("webrtc: ffmpeg pipeline exited unexpectedly (encoder={encoder_in_use})");
        break 'outer;
    }
    Ok(())
}

/// Ship one access-unit Sample. Returns false on a write_sample error
/// (caller should break the read loop). NO wall-clock pacing — ffmpeg's
/// stdout blocking is the natural 30-fps pacer in steady state.
///
/// Catch-up logic: if `buf` STILL contains another NAL start code after
/// we just consumed one AU, that means ffmpeg has already queued one
/// or more newer frames waiting for us. The AU we're about to ship is
/// therefore STALE. Drop it if it's a P-frame (NAL type 1) — losing a
/// P-frame causes ≤1 s of mild decoder block-artefacts until the next
/// IDR (-g 30 → keyframe per second) resets cleanly. Keep I-frames
/// (type 5) and AUD-flushed AUs unconditionally because the decoder
/// MUST see them to lock back onto the stream.
async fn flush_au(
    track: &Arc<TrackLocalStaticSample>,
    au: &mut Vec<u8>,
    buf_after_this_nal: &[u8],
    frame_duration: Duration,
    nal_type: u8,
) -> bool {
    let more_queued = find_start_code(buf_after_this_nal, 0).is_some();
    if more_queued && nal_type == 1 {
        // Stale P-frame — pipe already holds a newer frame. Drop to
        // catch up; backlog clears within ~1 s for a typical 2 s
        // startup burst because the keep-rate for I-frames + the
        // CONSUMING side keeps draining while production stays at
        // 30 fps.
        au.clear();
        return true;
    }
    let sample = Sample {
        data: std::mem::take(au).into(),
        duration: frame_duration,
        ..Default::default()
    };
    if let Err(e) = track.write_sample(&sample).await {
        log::warn!("track write_sample failed: {e}");
        return false;
    }
    true
}

/// Pull one full NAL unit (including its start code prefix) out of `buf` and
/// return it. Returns None if no full unit is available yet (we need to wait
/// for more bytes). Annex-B start codes: 0x00 0x00 0x01 (3-byte) or
/// 0x00 0x00 0x00 0x01 (4-byte).
fn take_nal_unit(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    // Find the first start code.
    let first = find_start_code(buf, 0)?;
    // Find the next start code AFTER the first one (NAL ends where the next begins).
    let next = find_start_code(buf, first + 3)?;
    let unit: Vec<u8> = buf[first..next].to_vec();
    buf.drain(..next);
    Some(unit)
}

/// Extract the H.264 NAL unit type (5-bit field in the first byte after the
/// Annex-B start code). Returns 0 for malformed input so the caller falls
/// through to its non-slice path (safer than blindly attaching a duration).
///
/// Common types: 1=non-IDR slice, 5=IDR slice, 6=SEI, 7=SPS, 8=PPS, 9=AUD.
fn nal_unit_type(unit: &[u8]) -> u8 {
    let hdr_idx = if unit.len() >= 4 && unit[0..4] == [0, 0, 0, 1] {
        4
    } else if unit.len() >= 3 && unit[0..3] == [0, 0, 1] {
        3
    } else {
        return 0;
    };
    unit.get(hdr_idx).map(|b| b & 0x1F).unwrap_or(0)
}

fn find_start_code(buf: &[u8], from: usize) -> Option<usize> {
    if buf.len() < from + 3 {
        return None;
    }
    let mut i = from;
    while i + 2 < buf.len() {
        if buf[i] == 0x00 && buf[i + 1] == 0x00 {
            if buf[i + 2] == 0x01 {
                return Some(i);
            }
            if buf[i + 2] == 0x00 && i + 3 < buf.len() && buf[i + 3] == 0x01 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn urlencoding(s: &str) -> String {
    // Minimal percent-encoding for our use — just the characters that
    // actually appear in our session IDs and ISO timestamps.
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(c),
            _ => out.push_str(&format!("%{:02X}", c as u32)),
        }
    }
    out
}

// ------------ Remote-control data channel ------------
//
// JSON wire protocol — one message per WebRTC SCTP message. All fields are
// `t`-tagged. Coordinates from the dashboard are normalized 0..1 against the
// streamed display's logical resolution; we multiply by the local primary
// monitor's dimensions before handing to enigo.

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum InboundMsg {
    Hello { #[serde(default)] proto: u32 },
    MouseMove { x: f64, y: f64 },
    MouseButton { btn: String, down: bool },
    MouseWheel { #[serde(default)] dx: i32, #[serde(default)] dy: i32 },
    Key { code: String, down: bool },
    ClipSet { text: String },
    ClipGet,
    Ping { #[serde(default)] id: u64 },
    // Adaptive-bitrate control from the dashboard. The dashboard samples
    // pc.getStats() every few seconds and picks a rung from the ladder:
    //   { width: 1920, bitrate_kbps: 4500 }  // 1080p
    //   { width: 1280, bitrate_kbps: 2500 }  // 720p (default)
    //   { width:  854, bitrate_kbps: 1000 }  //  480p
    //   { width:  640, bitrate_kbps:  500 }  //  360p
    // Agent reads the request, updates shared StreamParams, and the pump
    // loop respawns ffmpeg with the new params if either knob changed
    // beyond a small dead-band. Restart causes a ~500 ms freeze; we skip
    // restarts that don't change the actual ffmpeg command line.
    SetQuality { width: u32, bitrate_kbps: u32 },
}

fn screen_dims() -> (i32, i32) {
    // Use xcap (already a dep for screenshots) to get the primary monitor's
    // logical pixel size. Same display the ffmpeg capture is reading from.
    match xcap::Monitor::all() {
        Ok(mons) => {
            let mon = mons.iter().find(|m| m.is_primary().unwrap_or(false))
                .or_else(|| mons.first());
            if let Some(m) = mon {
                let w = m.width().unwrap_or(1920) as i32;
                let h = m.height().unwrap_or(1080) as i32;
                return (w.max(1), h.max(1));
            }
        }
        Err(e) => log::warn!("screen_dims: xcap failed: {e}"),
    }
    (1920, 1080)
}

pub(crate) fn attach_control_channel(
    dc: Arc<RTCDataChannel>,
    params: Arc<tokio::sync::Mutex<StreamParams>>,
    reload_flag: Arc<std::sync::atomic::AtomicBool>,
) {
    let (w, h) = screen_dims();

    // On open: send screen_info so the dashboard can de-normalize coords on
    // its end if it wants to display a cursor reticle in-page.
    {
        let dc_open = Arc::clone(&dc);
        dc.on_open(Box::new(move || {
            let dc = dc_open.clone();
            Box::pin(async move {
                let msg = json!({"t": "screen_info", "w": w, "h": h, "scale": 1});
                let _ = dc.send_text(msg.to_string()).await;
            })
        }));
    }

    // Per-message router. Each callback is its own future so they don't block
    // the data-channel read loop. Heavy work (input injection, clipboard) is
    // offloaded to the dedicated `rudrans-input` thread via input::sender().
    let dc_msg = Arc::clone(&dc);
    dc.on_message(Box::new(move |m: DataChannelMessage| {
        let dc = dc_msg.clone();
        let params = params.clone();
        let reload = reload_flag.clone();
        Box::pin(async move {
            // Only handle text frames — we don't speak binary on this DC.
            if !m.is_string {
                return;
            }
            let text = match std::str::from_utf8(&m.data) {
                Ok(s) => s,
                Err(_) => return,
            };
            let msg: InboundMsg = match serde_json::from_str(text) {
                Ok(m) => m,
                Err(e) => {
                    log::warn!("control: bad json {e}: {text}");
                    return;
                }
            };
            handle_control_msg(&dc, msg, w, h, &params, &reload).await;
        })
    }));
}

async fn handle_control_msg(
    dc: &Arc<RTCDataChannel>,
    msg: InboundMsg,
    w: i32,
    h: i32,
    params: &Arc<tokio::sync::Mutex<StreamParams>>,
    reload_flag: &Arc<std::sync::atomic::AtomicBool>,
) {
    let Some(tx) = input::sender() else {
        log::warn!("control: input thread not ready");
        return;
    };
    match msg {
        InboundMsg::Hello { proto: _ } => {
            // Already replied with screen_info on_open. Re-send on explicit
            // hello in case the dashboard missed the first one (timing race).
            let reply = json!({"t": "screen_info", "w": w, "h": h, "scale": 1});
            let _ = dc.send_text(reply.to_string()).await;
        }
        InboundMsg::MouseMove { x, y } => {
            let px = (x.clamp(0.0, 1.0) * w as f64).round() as i32;
            let py = (y.clamp(0.0, 1.0) * h as f64).round() as i32;
            let _ = tx.send(InputEvent::MouseMove { x: px, y: py });
        }
        InboundMsg::MouseButton { btn, down } => {
            let button = match btn.as_str() {
                "left" => MouseButton::Left,
                "right" => MouseButton::Right,
                "middle" => MouseButton::Middle,
                _ => return,
            };
            let _ = tx.send(InputEvent::MouseButton { button, down });
        }
        InboundMsg::MouseWheel { dx, dy } => {
            let _ = tx.send(InputEvent::MouseWheel { dx, dy });
        }
        InboundMsg::Key { code, down } => {
            let _ = tx.send(InputEvent::Key { code, down });
        }
        InboundMsg::ClipSet { text } => {
            let _ = tx.send(InputEvent::ClipSet { text });
        }
        InboundMsg::ClipGet => {
            let (rtx, rrx) = tokio::sync::oneshot::channel();
            let _ = tx.send(InputEvent::ClipGet(rtx));
            // Bounded wait so a hung clipboard read can't stall the DC.
            let text = match tokio::time::timeout(Duration::from_millis(500), rrx).await {
                Ok(Ok(v)) => v.unwrap_or_default(),
                _ => String::new(),
            };
            let reply = json!({"t": "clip_data", "text": text});
            let _ = dc.send_text(reply.to_string()).await;
        }
        InboundMsg::Ping { id } => {
            let reply = json!({"t": "pong", "id": id});
            let _ = dc.send_text(reply.to_string()).await;
        }
        InboundMsg::SetQuality { width, bitrate_kbps } => {
            // Clamp to a sane range so a misbehaving dashboard can't ask
            // for 8K or 10 kbps. The default ladder maxes at 1920 + 5 Mbps.
            let new_w = width.clamp(320, 2560);
            let new_b = bitrate_kbps.clamp(200, 8000);
            let mut p = params.lock().await;
            // Dead-band: skip a restart if the request is within 15 % of the
            // current bitrate AND the width is unchanged. Restart costs
            // ~500 ms freeze; not worth it for a noise-level adjustment.
            let same_width = p.width == new_w;
            let drift = (p.bitrate_kbps as i32 - new_b as i32).abs() as u32 * 100
                / p.bitrate_kbps.max(1);
            if same_width && drift < 15 {
                log::debug!("set_quality ignored (within dead-band): {new_w}x@{new_b}kbps");
                return;
            }
            log::info!(
                "set_quality: {}x{}kbps -> {}x{}kbps (restarting encoder)",
                p.width, p.bitrate_kbps, new_w, new_b,
            );
            p.width = new_w;
            p.bitrate_kbps = new_b;
            drop(p);
            reload_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
