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

use crate::{api, config, AppState};

const TARGET_FPS: u32 = 15;
const TARGET_WIDTH: u32 = 1280;

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
        let st = state.clone();
        let eid = enrollment.agent_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle_session(&st, &session_id, &eid, &sdp).await {
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
) -> Result<()> {
    let ice_servers = fetch_ice_servers(state).await?;

    // Build the WebRTC API instance. Default codecs include H.264; we don't
    // need to register anything extra.
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
        tauri::async_runtime::spawn(async move {
            let mut since = chrono::Utc::now().to_rfc3339();
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
    pump_ffmpeg_into_track(video_track, stop_flag.clone()).await?;

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

/// Spawn the bundled ffmpeg with a screen-capture input + raw H.264 stdout,
/// parse NAL units, and feed each frame into the WebRTC track. Returns when
/// `stop_flag` flips (peer disconnected) or ffmpeg exits.
async fn pump_ffmpeg_into_track(
    track: Arc<TrackLocalStaticSample>,
    stop_flag: Arc<std::sync::atomic::AtomicBool>,
) -> Result<()> {
    let ffmpeg_bin = crate::ffmpeg::locate_ffmpeg()
        .ok_or_else(|| anyhow!("ffmpeg not bundled"))?;

    let mut cmd = Command::new(&ffmpeg_bin);
    cmd.arg("-hide_banner").arg("-loglevel").arg("error");
    cmd.arg("-framerate").arg(TARGET_FPS.to_string());
    #[cfg(target_os = "macos")]
    {
        // Reuse the dynamic screen-index probe from video.rs so a Mac with a
        // weird device layout (multi-camera, virtual displays) still picks
        // the right "Capture screen 0".
        let idx = crate::video::macos_screen_index_for_screenshot(&ffmpeg_bin);
        cmd.arg("-f").arg("avfoundation").arg("-i").arg(format!("{}:none", idx));
    }
    #[cfg(target_os = "windows")]
    {
        cmd.arg("-f").arg("gdigrab").arg("-i").arg("desktop");
    }
    #[cfg(target_os = "linux")]
    {
        cmd.arg("-f").arg("x11grab").arg("-i").arg(":0.0");
    }

    let frame_duration = Duration::from_millis(1000 / TARGET_FPS as u64);
    cmd.arg("-vcodec").arg("libx264")
        .arg("-tune").arg("zerolatency")
        .arg("-preset").arg("ultrafast")
        .arg("-pix_fmt").arg("yuv420p")
        .arg("-profile:v").arg("baseline")
        .arg("-g").arg("30")
        .arg("-keyint_min").arg("30")
        // Re-emit SPS/PPS on EVERY keyframe. Without this, libx264 writes
        // them once at the start of the stream and the dashboard (which
        // typically joins mid-stream) never sees them → no decode → black
        // video. `-bsf:v dump_extra` injects the codec extradata before
        // each IDR so any consumer can sync up on the next keyframe.
        .arg("-x264opts").arg("repeat-headers=1")
        .arg("-bsf:v").arg("dump_extra")
        .arg("-vf").arg(format!("scale={}:-2", TARGET_WIDTH))
        .arg("-an")
        .arg("-f").arg("h264")
        .arg("-")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child: Child = cmd.spawn().context("spawn ffmpeg for webrtc")?;
    let mut stdout = child
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

    log::info!("webrtc: ffmpeg pipeline started, streaming h264 into track");

    let mut buf = Vec::with_capacity(64 * 1024);
    let mut tmp = vec![0u8; 32 * 1024];

    loop {
        if stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
            log::info!("webrtc: stop_flag set, killing ffmpeg");
            let _ = child.kill().await;
            break;
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

        // Flush every full NAL unit we can extract. Annex-B format means
        // each NAL is preceded by 0x00 0x00 0x00 0x01 or 0x00 0x00 0x01.
        while let Some(unit) = take_nal_unit(&mut buf) {
            if unit.is_empty() {
                continue;
            }
            let sample = Sample {
                data: unit.into(),
                duration: frame_duration,
                ..Default::default()
            };
            if let Err(e) = track.write_sample(&sample).await {
                log::warn!("track write_sample failed: {e}");
                break;
            }
        }
    }

    let _ = child.wait().await;
    log::info!("webrtc: ffmpeg pipeline exited");
    Ok(())
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
