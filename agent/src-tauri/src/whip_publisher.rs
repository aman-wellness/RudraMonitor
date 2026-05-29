// WHIP publisher — sends agent screen to LiveKit OSS via the WHIP
// (WebRTC-HTTP Ingestion Protocol) endpoint exposed by livekit-ingress.
//
// Replaces the custom Supabase-table signaling that lived in
// webrtc_stream.rs. From the agent's POV the WebRTC stack itself is
// unchanged — same webrtc-rs PeerConnection, same ffmpeg → NAL →
// TrackLocalStaticSample pipeline. ONLY the SDP exchange + ICE trickle
// transport swaps:
//
//   old: long-poll /functions/v1/webrtc-signal table for offer, post
//        answer + candidates back. Custom auth, custom TURN, custom
//        codec negotiation drama. ~1000 lines of plumbing.
//
//   new: POST our OFFER (we are the publisher / offerer in WHIP) to
//        https://api.rudrans.com/whip/<room>. Get answer in the response
//        body, get Location header pointing at the per-session ICE
//        endpoint. Trickle local candidates by HTTP PATCH to that URL.
//        ~250 lines, no custom signaling table.
//
// LiveKit OSS handles all the hard parts (codec negotiation, TURN,
// jitter buffer, congestion control, multi-subscriber fanout) for us.
// The dashboard subscribes via the livekit-client JS SDK against
// wss://api.rudrans.com/livekit/ — no shared signaling code needed.
//
// Trigger model (start/stop): the dashboard subscribes to the agent's
// room first. LiveKit fires a `participant_joined` webhook to our
// Supabase backend, which inserts a row in `webrtc_signaling` with
// kind='livekit_start'. The agent polls that table (the existing
// long-poll loop) and starts a WHIP session on each such trigger.
// `livekit_stop` tears it down. Reusing the existing polling
// mechanism keeps the wire format small and avoids introducing
// another Supabase realtime channel.

use anyhow::{anyhow, Context, Result};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::webrtc_stream::{
    attach_control_channel, pump_ffmpeg_into_track, StreamParams,
};
use crate::{api, config, AppState};

/// Public entry point — spawned once at agent boot from lib.rs::setup.
/// Mirrors webrtc_stream::spawn_streaming_loop's lifecycle (wait for
/// enrollment, then poll forever) so dropping in WHIP doesn't change
/// the agent's startup contract.
pub fn spawn_whip_loop(state: AppState) {
    tauri::async_runtime::spawn(async move {
        loop {
            if crate::ready(&state).await {
                break;
            }
            sleep(Duration::from_secs(5)).await;
        }
        log::info!("whip: publisher loop starting");
        // Singleton session state. Two trips through the poll loop
        // simultaneously firing run_session() leads to TWO ffmpegs
        // racing for the same screen-capture device — the OS gives
        // only ONE of them access (macOS avfoundation, Windows gdigrab,
        // Linux x11grab all single-grab the display). The losing
        // ffmpeg starts but produces zero frames, Ingress reports
        // "source encoder not ready" after ~8 s and drops the session.
        //
        // `active` flips true while a WHIP session is running;
        // `stop_current` is the AtomicBool the ICE-state callback +
        // livekit_stop handler signal to tear down the in-flight session.
        let active = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_current = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Wall-clock timestamp of when the singleton lock was last
        // claimed. Used by the stuck-state recovery in poll_once to
        // force-reclaim a session lock that's been held more than
        // 120 s — defends against tauri's silent panic swallow.
        let last_claim = Arc::new(std::sync::RwLock::new(std::time::Instant::now()));
        let mut since = chrono::Utc::now().to_rfc3339();
        loop {
            match poll_once(&state, &since, &active, &stop_current, &last_claim).await {
                Ok(Some(new_since)) => since = new_since,
                Ok(None) => {}
                Err(e) => {
                    log::warn!("whip poll failed: {e}; backing off 10s");
                    sleep(Duration::from_secs(10)).await;
                }
            }
        }
    });
}

/// One round of the long-poll. We reuse the existing webrtc_signal edge
/// function — the dashboard inserts livekit_start / livekit_stop rows
/// with `direction=to_agent`. Format mirrors the old offer envelope so
/// the edge function needs no changes (Block A through G keep the table
/// schema stable; only the kinds it carries shift).
async fn poll_once(
    state: &AppState,
    since: &str,
    active: &Arc<std::sync::atomic::AtomicBool>,
    stop_current: &Arc<std::sync::atomic::AtomicBool>,
    last_claim: &Arc<std::sync::RwLock<std::time::Instant>>,
) -> Result<Option<String>> {
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
        urlencode(since)
    );
    let client = api::build_client()?;
    let resp = client
        .get(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .send()
        .await
        .context("whip long-poll")?;
    if !resp.status().is_success() {
        let s = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("whip poll http {s}: {body}"));
    }

    #[derive(serde::Deserialize)]
    struct Envelope {
        kind: String,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        payload: serde_json::Value,
        created_at: String,
    }
    #[derive(serde::Deserialize)]
    struct Body {
        messages: Vec<Envelope>,
    }
    let body: Body = resp.json().await.context("whip parse")?;

    let mut newest = None;
    for msg in body.messages {
        newest = Some(msg.created_at.clone());
        // livekit_stop: tell whatever session is currently running to
        // tear down. The actual cleanup happens inside run_session
        // (kills ffmpeg, closes PC) once stop_current flips true.
        if msg.kind == "livekit_stop" {
            log::info!("whip: livekit_stop received");
            stop_current.store(true, std::sync::atomic::Ordering::SeqCst);
            continue;
        }
        // We only care about LiveKit-flavoured messages here. Anything
        // else (legacy `offer`/`ice_candidate`) is left for webrtc_stream's
        // poller to consume.
        if msg.kind != "livekit_start" {
            continue;
        }
        // Singleton: if a session is already running AND it's recent
        // enough to plausibly still be alive, IGNORE this start
        // (dashboard hard-refreshes spam livekit_start; second one
        // would launch a parallel ffmpeg that loses the screen-capture
        // race with the first, producing zero frames and an
        // "ingress: source encoder not ready" failure ~8 s later).
        //
        // STUCK-STATE RECOVERY: if the lock was last claimed >120 s
        // ago, we treat it as stuck and force-claim. Two ways this
        // can happen even with the drop-guard added below:
        //   • macOS / Windows OS suspended the agent task mid-session
        //     and never resumed cleanly (rare but seen on Sleep wakes).
        //   • A future bug puts run_session into an infinite await.
        // Customer's pain was "agent unreachable forever after one
        // bad session". 120 s is generous enough that a legit slow
        // Windows ffmpeg startup (33 s in the worst case we've
        // observed) still falls inside.
        let now = std::time::Instant::now();
        let lock_age = now.duration_since(*last_claim.read().unwrap_or_else(|e| e.into_inner()));
        if active.load(std::sync::atomic::Ordering::SeqCst) && lock_age < std::time::Duration::from_secs(120) {
            log::info!("whip: livekit_start ignored — session already active ({}s ago)", lock_age.as_secs());
            continue;
        }
        if active.load(std::sync::atomic::Ordering::SeqCst) {
            log::warn!("whip: forcing reclaim of stale session lock (held {}s)", lock_age.as_secs());
            active.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        *last_claim.write().unwrap_or_else(|e| e.into_inner()) = now;
        // Drop-guard ensures `active` flips back to false WHEN the
        // session task exits — including via panic. tauri's spawn
        // catches panics silently, which means a run_session() panic
        // would otherwise leave `active=true` forever and lock out
        // ALL future livekit_start signals until the agent restarts.
        // The guard runs during panic unwind, so the lock always
        // gets released no matter how the session ends.
        struct ActiveGuard(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for ActiveGuard {
            fn drop(&mut self) {
                self.0.store(false, std::sync::atomic::Ordering::SeqCst);
                log::info!("whip: session lock released (drop guard)");
            }
        }
        let session_id = msg.session_id.clone().unwrap_or_default();
        let room = msg
            .payload
            .get("room")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("agent_{}", enrollment.agent_id));
        log::info!("whip: livekit_start for session={session_id} room={room}");
        active.store(true, std::sync::atomic::Ordering::SeqCst);
        // Fresh stop flag for THIS session — if a previous stop arrived
        // during teardown of the last session, ignore it.
        stop_current.store(false, std::sync::atomic::Ordering::SeqCst);
        let st = state.clone();
        let aid = enrollment.agent_id.clone();
        let active_for_session = active.clone();
        let stop_for_session = stop_current.clone();
        tauri::async_runtime::spawn(async move {
            // Drop-guard pattern: `active` is reset to false when
            // _guard is dropped, which happens at end-of-scope OR
            // during panic unwind. Either way, the singleton lock
            // always gets released. Replaces the explicit store()
            // at the bottom of the task which was unreachable on
            // panic (tauri's spawn swallows panics silently).
            let _guard = ActiveGuard(active_for_session);
            let result = run_session(&st, &aid, &session_id, &room, stop_for_session).await;
            if let Err(e) = result {
                log::warn!("whip session {session_id} failed: {e}");
            } else {
                log::info!("whip session {session_id} ended cleanly");
            }
            // _guard drops here.
        });
    }
    Ok(newest)
}

/// Response from /functions/v1/livekit-token when the caller is the
/// agent. Contains BOTH the LiveKit room JWT (for completeness; not
/// used by the WHIP flow) AND the pre-registered Ingress resource that
/// the agent should POST WHIP traffic into.
#[derive(serde::Deserialize, Debug)]
struct LiveKitAgentToken {
    #[allow(dead_code)]
    token: String,
    #[allow(dead_code)]
    room: String,
    ingress: Option<IngressInfo>,
}

#[derive(serde::Deserialize, Debug)]
struct IngressInfo {
    #[allow(dead_code)]
    #[serde(default)]
    ingress_id: String,
    url: String,
    stream_key: String,
}

/// Hit /functions/v1/livekit-token which (for agent callers) ALSO
/// creates a LiveKit Ingress resource and returns its `url` +
/// `stream_key`. We need both: WHIP target is the url, auth is the
/// stream_key (which IS the JWT LiveKit pre-stamped with that ingress
/// id in the subject claim). Without the Ingress resource the WHIP POST
/// fails with "no response from servers" — Ingress can't look the
/// session up.
async fn fetch_livekit_ingress(state: &AppState, room: &str) -> Result<IngressInfo> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg
        .enrollment
        .as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?
        .clone();
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let url = format!(
        "{}/functions/v1/livekit-token",
        supabase_url.trim_end_matches('/')
    );
    let client = api::build_client()?;
    let resp = client
        .post(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "agent_id": enrollment.agent_id, "room": room }).to_string())
        .send()
        .await
        .context("livekit-token request")?;
    if !resp.status().is_success() {
        let s = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("livekit-token http {s}: {body}"));
    }
    let r: LiveKitAgentToken = resp.json().await.context("parse livekit-token")?;
    r.ingress.ok_or_else(|| {
        anyhow!("livekit-token returned no ingress info — CreateIngress likely failed server-side")
    })
}

/// Run one WHIP publishing session. Drives the peer connection from
/// offer through ICE-trickle through ffmpeg pump, blocks until either
/// the connection drops or the encoder exits.
async fn run_session(
    state: &AppState,
    agent_id: &str,
    _session_id: &str,
    room: &str,
    stop_signal: Arc<std::sync::atomic::AtomicBool>,
) -> Result<()> {
    let ingress = fetch_livekit_ingress(state, room).await?;
    // The Ingress's `url` is the exact endpoint to POST WHIP to;
    // `stream_key` is the bearer auth that ties our session to the
    // pre-created IngressInfo on the LiveKit server. The room JWT
    // (returned alongside) is ignored — LiveKit owns the participant
    // identity once Ingress is in front.
    let whip_url = ingress.url.clone();
    let token = ingress.stream_key.clone();
    log::info!("whip: ingress URL={whip_url}");

    // Standard WebRTC stack — same shape as webrtc_stream::handle_session.
    // No iceServers passed: LiveKit Ingress advertises its own TURN
    // candidates in the answer, so we don't need to configure one here.
    let mut me = MediaEngine::default();
    me.register_default_codecs()
        .map_err(|e| anyhow!("register codecs: {e}"))?;
    let registry = Registry::new();
    let api_builder = APIBuilder::new()
        .with_media_engine(me)
        .with_interceptor_registry(registry)
        .build();
    let pc = Arc::new(
        api_builder
            .new_peer_connection(RTCConfiguration::default())
            .await
            .map_err(|e| anyhow!("new_peer_connection: {e}"))?,
    );

    // Video track. Same H.264 capability that webrtc_stream used so the
    // ffmpeg pump in pump_ffmpeg_into_track is interchangeable.
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: webrtc::api::media_engine::MIME_TYPE_H264.to_owned(),
            ..Default::default()
        },
        "screen-video".to_string(),
        format!("rudrans-{agent_id}"),
    ));
    let rtp_sender = pc
        .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| anyhow!("add_track: {e}"))?;
    // RTCP feedback drainer — same as webrtc_stream. Required so the
    // sender's interceptors (NACK, FEC) keep ticking.
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 1500];
        while let Ok((_, _)) = rtp_sender.read(&mut buf).await {}
    });

    // Remote-control data channel. We CREATE it on the publisher side
    // so the resulting m=application section is in OUR offer. LiveKit
    // routes data-channel messages between the publisher and any
    // subscribers in the room, so the dashboard's "Take Control"
    // button (which sends mouse/keyboard JSON events into this DC) just
    // works without any further plumbing. We reuse attach_control_channel
    // verbatim from webrtc_stream so the existing input mapping and
    // adaptive-bitrate handshake survive the pivot.
    let stream_params = Arc::new(tokio::sync::Mutex::new(StreamParams::default()));
    let reload_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dc = pc
        .create_data_channel("control", None)
        .await
        .map_err(|e| anyhow!("create_data_channel: {e}"))?;
    attach_control_channel(dc, stream_params.clone(), reload_flag.clone());

    // Stop flag — pulled by ICE state callback below and by the
    // ffmpeg pump so we can tear everything down on a single signal.
    // Also driven by `stop_signal` (livekit_stop from the dashboard)
    // via the bridging task below.
    let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        // Bridge: forward livekit_stop signals from the poll-loop side
        // into this session's stop_flag. Poll the AtomicBool on a 500ms
        // cadence — cheap and matches the existing ICE-state callback
        // pattern (no extra channels needed). Task exits when stop_flag
        // is set (avoiding leaks across short-lived sessions).
        let stop_flag = stop_flag.clone();
        let stop_signal = stop_signal.clone();
        tauri::async_runtime::spawn(async move {
            while !stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
                if stop_signal.load(std::sync::atomic::Ordering::SeqCst) {
                    log::info!("whip: livekit_stop signal received, tearing down session");
                    stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
                sleep(Duration::from_millis(500)).await;
            }
        });
    }
    {
        let stop_flag = stop_flag.clone();
        let is_disconnected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        pc.on_ice_connection_state_change(Box::new(move |s: RTCIceConnectionState| {
            let stop_flag = stop_flag.clone();
            let is_disconnected = is_disconnected.clone();
            Box::pin(async move {
                log::info!("whip ice: {s}");
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

    // ============================================================
    // CRITICAL TIMING NOTE
    // ============================================================
    // LiveKit Ingress times out the publisher within ~700-1000ms of
    // ICE reaching Connected if no RTP frames have arrived. We hit
    // this on every session in v0.2.52/0.2.53 testing:
    //
    //   ingress: ICE Connected
    //   +700ms : "source encoder not ready" → session torn down
    //   +1900ms: track has started ← TOO LATE, already gone
    //
    // ffmpeg spawn + first-keyframe takes 1-2 s on macOS avfoundation
    // (slow capture-device init). If we sequence ffmpeg AFTER the
    // WHIP exchange, we miss the window.
    //
    // Fix: spawn the ffmpeg pump BEFORE the WHIP exchange so it's
    // running in parallel. By the time ICE connects, ffmpeg has had
    // 1-2 s of head-start and is already pushing frames into the
    // track buffer. webrtc-rs holds them until the connection is up
    // and then flushes RTP immediately on Connected. Ingress sees
    // media within ~50ms of ICE Connected → no timeout.
    let pump_video_track = Arc::clone(&video_track);
    let pump_stop_flag = stop_flag.clone();
    let pump_stream_params = stream_params.clone();
    let pump_reload_flag = reload_flag.clone();
    let pump_handle = tauri::async_runtime::spawn(async move {
        pump_ffmpeg_into_track(
            pump_video_track,
            pump_stop_flag,
            pump_stream_params,
            pump_reload_flag,
        )
        .await
    });

    // --- WHIP exchange (running in parallel with ffmpeg startup) ---
    //
    // 1. createOffer / setLocalDescription.
    // 2. POST offer.sdp to /whip/<stream_key>. Body=application/sdp,
    //    Authorization=Bearer <stream_key>. Response: 201 with answer
    //    SDP body + Location header (ICE-trickle resource URL).
    // 3. setRemoteDescription(answer).
    // 4. on_ice_candidate: PATCH each candidate to the Location URL.
    let offer = pc
        .create_offer(None)
        .await
        .map_err(|e| anyhow!("create_offer: {e}"))?;
    pc.set_local_description(offer.clone())
        .await
        .map_err(|e| anyhow!("set_local: {e}"))?;

    let http = api::build_client()?;
    let resp = http
        .post(&whip_url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/sdp")
        .body(offer.sdp.clone())
        .send()
        .await
        .context("WHIP POST offer")?;
    if !resp.status().is_success() {
        let s = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("WHIP POST failed {s}: {body}"));
    }
    // The per-session ICE-trickle resource URL — used for PATCH below.
    // LiveKit returns an absolute or root-relative URL; both are fine
    // for reqwest, so we resolve relative ones against the WHIP URL.
    let resource_url = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            if s.starts_with("http") {
                s.to_string()
            } else {
                // Same scheme://host as the WHIP URL, replacing the path.
                let base = url::Url::parse(&whip_url).ok();
                base.and_then(|b| b.join(s).ok().map(|u| u.to_string()))
                    .unwrap_or_else(|| s.to_string())
            }
        });
    let answer_sdp = resp.text().await.context("WHIP answer body")?;
    let answer = RTCSessionDescription::answer(answer_sdp)
        .map_err(|e| anyhow!("parse answer: {e}"))?;
    pc.set_remote_description(answer)
        .await
        .map_err(|e| anyhow!("set_remote: {e}"))?;

    // Trickle ICE. webrtc-rs emits each local candidate via the
    // on_ice_candidate callback as setLocalDescription's gathering
    // progresses; we PATCH each one to the WHIP resource.
    if let Some(resource) = resource_url.clone() {
        let token = token.clone();
        let http = http.clone();
        pc.on_ice_candidate(Box::new(move |c| {
            let resource = resource.clone();
            let token = token.clone();
            let http = http.clone();
            Box::pin(async move {
                let Some(cand) = c else { return };
                let Ok(j) = cand.to_json() else { return };
                // WHIP trickle is PATCH with application/trickle-ice-sdpfrag.
                // Format: a single `a=` line for the candidate, plus the
                // m-line index and ufrag from the candidate JSON. The
                // simplest form LiveKit accepts is just the candidate
                // string itself in a one-line SDP fragment.
                let body = format!(
                    "a={}\r\n",
                    j.candidate.trim_start_matches("candidate:").trim_start()
                );
                let body = if !body.starts_with("a=candidate:") {
                    format!("a=candidate:{}\r\n", j.candidate.trim_start_matches("candidate:").trim_start())
                } else { body };
                if let Err(e) = http
                    .patch(&resource)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/trickle-ice-sdpfrag")
                    .body(body)
                    .send()
                    .await
                {
                    log::warn!("whip ICE trickle PATCH failed: {e}");
                }
            })
        }));
    }

    // Wait for the ffmpeg pump task (spawned above, running in
    // parallel with the WHIP handshake). It exits when stop_flag is
    // set (ICE Failed/Closed/15s-Disconnected, or livekit_stop) OR
    // when ffmpeg itself dies unexpectedly. Whichever comes first is
    // the session's natural end.
    let pump_result = pump_handle.await;
    match pump_result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::warn!("whip pump failed: {e}"),
        Err(e) => log::warn!("whip pump task join failed: {e}"),
    }

    // Best-effort tell LiveKit we're going away. WHIP defines DELETE
    // on the resource URL as "publisher leaving".
    if let Some(resource) = resource_url {
        let _ = http
            .delete(&resource)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await;
    }
    let _ = pc.close().await;
    Ok(())
}

/// Minimal percent-encoding for path / query segments. Used for the
/// poll-cursor `since` value (RFC3339 timestamps contain `:` and `+`
/// which must be escaped in URLs).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// Suppress unused warnings while the dual-stack rollout is in progress.
// Block G of the pivot deletes webrtc_stream.rs entirely; until then both
// modules coexist and a few imports go through periods of unuse depending
// on which path the dashboard takes.
#[allow(dead_code)]
fn _unused_ref(_dc: Arc<RTCDataChannel>) {}
