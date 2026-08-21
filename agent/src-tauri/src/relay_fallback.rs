// Agent side of the "any network" fallback (see WEBRTC_PRODUCTION_SETUP.md §7).
//
// When the dashboard's WebRTC negotiation fails — which happens when the
// employee is on a network that blocks outbound UDP, the one case the agent's
// webrtc-rs stack cannot handle — the dashboard posts a `relay_start` signal.
// The agent lands here: it opens an OUTBOUND WebSocket to the media relay on
// 443 (which every network allows), pushes the same H.264 stream it would have
// sent over WebRTC, and applies the control messages coming back. Outbound 443
// is the universal escape hatch, so this reaches the employee wherever they are.
//
// This is a FALLBACK, not the default. WebRTC (direct or via TURN) is still
// tried first and is lower latency; this only runs when that could not connect.
//
// Media framing on the wire (must match relay.ts and the dashboard receiver):
//   binary 0x02 + <SPS><PPS> (Annex-B)            decoder config
//   binary 0x01 + <key:u8> + <ts:u64 BE> + <AU>   one H.264 access unit
// Control is the SAME JSON the WebRTC DataChannel uses, so it maps onto the
// existing input pipeline unchanged.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::input::{self, InputEvent, MouseButton};
use crate::webrtc_stream::{InboundMsg, StreamParams};
use crate::{api, config, ffmpeg, webrtc_stream, AppState};

// One relay session per session_id. The flag lets `relay_stop` (or a second
// `relay_start`) tear an existing one down instead of stacking encoders.
static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
fn active() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start (or ignore, if already running) a relay session for `session_id`.
pub fn spawn_agent_relay(state: AppState, session_id: String) {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut m = active().lock().unwrap();
        if m.contains_key(&session_id) {
            log::info!("relay: already running for session {session_id}");
            return;
        }
        m.insert(session_id.clone(), stop.clone());
    }
    log::info!("relay: starting fallback for session {session_id}");
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(&state, &session_id, stop).await {
            log::warn!("relay: session {session_id} ended with error: {e:#}");
        } else {
            log::info!("relay: session {session_id} ended");
        }
        active().lock().unwrap().remove(&session_id);
    });
}

/// Tear down a running relay session (dashboard sent `relay_stop`, or WebRTC
/// recovered).
pub fn stop_relay(session_id: &str) {
    if let Some(flag) = active().lock().unwrap().get(session_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

async fn run(state: &AppState, session_id: &str, stop: Arc<AtomicBool>) -> Result<()> {
    let (token, url) = fetch_relay_token(state, session_id).await?;
    // Token is base64url + '.' — all query-safe characters, no encoding needed.
    let ws_url = format!("{}?token={}", url, token);
    let (ws, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .context("relay connect")?;
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();

    // Single writer owns ws_tx; media and control both feed it through out_tx.
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if ws_tx.send(m).await.is_err() {
                break;
            }
        }
    });

    // Announce the agent's real screen size so the viewer can de-normalise
    // pointer coordinates, mirroring the DataChannel on_open behaviour.
    let (w, h) = webrtc_stream::screen_dims();
    let _ = out_tx.send(Message::Text(
        json!({"t":"screen_info","w":w,"h":h,"scale":1}).to_string(),
    ));

    // ---- media: ffmpeg → Annex-B → framed binary --------------------------
    let ffmpeg_bin = ffmpeg::ensure_ffmpeg().await.context("relay: ffmpeg")?;
    let (child, mut stdout, _enc) =
        webrtc_stream::spawn_ffmpeg_with_params(&ffmpeg_bin, StreamParams::default())
            .await
            .context("relay: spawn ffmpeg")?;
    let media_out = out_tx.clone();
    let media_stop = stop.clone();
    let media = tokio::spawn(async move {
        // Hold the Child so kill_on_drop terminates ffmpeg when this task ends.
        let _child = child;
        let start = Instant::now();
        let mut reader = NalReader::default();
        let mut sps: Option<Vec<u8>> = None;
        let mut pps: Option<Vec<u8>> = None;
        let mut last_config: Vec<u8> = Vec::new();
        let mut buf = [0u8; 65536];
        loop {
            if media_stop.load(Ordering::SeqCst) {
                break;
            }
            let n = match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            for nal in reader.push(&buf[..n]) {
                match nal_type(&nal) {
                    7 => sps = Some(nal),
                    8 => pps = Some(nal),
                    5 => {
                        // Prepend SPS+PPS to every keyframe so a viewer that
                        // joined mid-stream can decode without a side channel.
                        let mut payload = Vec::new();
                        if let (Some(s), Some(p)) = (&sps, &pps) {
                            payload.extend_from_slice(s);
                            payload.extend_from_slice(p);
                        }
                        payload.extend_from_slice(&nal);
                        let ts = start.elapsed().as_micros() as u64;
                        if media_out.send(Message::Binary(frame_media(true, ts, &payload))).is_err() {
                            break;
                        }
                    }
                    1 => {
                        let ts = start.elapsed().as_micros() as u64;
                        if media_out.send(Message::Binary(frame_media(false, ts, &nal))).is_err() {
                            break;
                        }
                    }
                    _ => {} // SEI (6), AUD (9), etc. — decoder doesn't need them here
                }
                // Emit config whenever SPS+PPS first appear or change.
                if let (Some(s), Some(p)) = (&sps, &pps) {
                    let mut cfg = Vec::with_capacity(1 + s.len() + p.len());
                    cfg.push(0x02);
                    cfg.extend_from_slice(s);
                    cfg.extend_from_slice(p);
                    if cfg != last_config {
                        last_config = cfg.clone();
                        let _ = media_out.send(Message::Binary(cfg));
                    }
                }
            }
        }
    });

    // ---- control: viewer → agent input ------------------------------------
    while let Some(msg) = ws_rx.next().await {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match msg {
            Ok(Message::Text(t)) => handle_control(&t, w, h, &out_tx).await,
            Ok(Message::Ping(p)) => {
                let _ = out_tx.send(Message::Pong(p));
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    stop.store(true, Ordering::SeqCst);
    media.abort(); // drops the Child → kill_on_drop stops ffmpeg
    writer.abort();
    Ok(())
}

async fn handle_control(
    text: &str,
    w: i32,
    h: i32,
    out: &mpsc::UnboundedSender<Message>,
) {
    let msg: InboundMsg = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("relay control: bad json {e}: {text}");
            return;
        }
    };
    let Some(tx) = input::sender() else {
        return;
    };
    match msg {
        InboundMsg::Hello { .. } => {
            let _ = out.send(Message::Text(
                json!({"t":"screen_info","w":w,"h":h,"scale":1}).to_string(),
            ));
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
            let (rtx, rrx) = oneshot::channel();
            if tx.send(InputEvent::ClipGet(rtx)).is_ok() {
                if let Ok(Some(t)) = rrx.await {
                    let _ = out.send(Message::Text(
                        json!({"t":"clip_data","text":t}).to_string(),
                    ));
                }
            }
        }
        InboundMsg::Ping { id } => {
            let _ = out.send(Message::Text(json!({"t":"pong","id":id}).to_string()));
        }
        // The fallback streams at default quality; adaptive-bitrate requests are
        // a WebRTC-path optimisation and are simply ignored here.
        InboundMsg::SetQuality { .. } => {}
    }
}

async fn fetch_relay_token(state: &AppState, session_id: &str) -> Result<(String, String)> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg
        .enrollment
        .as_ref()
        .ok_or_else(|| anyhow!("not enrolled"))?
        .clone();
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let url = format!(
        "{}/functions/v1/webrtc-relay-token",
        supabase_url.trim_end_matches('/')
    );
    let client = api::build_client()?;
    let resp = client
        .post(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .json(&json!({ "session": session_id, "role": "agent" }))
        .send()
        .await
        .context("relay token request")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("relay token http {status}: {}", body.trim()));
    }
    let v: serde_json::Value = resp.json().await.context("parse relay token")?;
    let token = v
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("relay token response missing token"))?
        .to_string();
    let ws_url = v
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| anyhow!("relay token response missing url"))?
        .to_string();
    Ok((token, ws_url))
}

fn frame_media(keyframe: bool, ts_micros: u64, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(10 + payload.len());
    v.push(0x01);
    v.push(if keyframe { 1 } else { 0 });
    v.extend_from_slice(&ts_micros.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

/// NAL unit type from a slice that begins at an Annex-B start code (00 00 01).
fn nal_type(nal: &[u8]) -> u8 {
    if nal.len() < 4 {
        return 0;
    }
    nal[3] & 0x1F
}

/// Incremental Annex-B splitter. `push` returns every NAL that became complete
/// with the newly-added bytes; each returned NAL begins at its `00 00 01` start
/// code and ends just before the next one. A trailing `00` from a 4-byte start
/// code lands harmlessly at the end of the previous NAL.
#[derive(Default)]
struct NalReader {
    buf: Vec<u8>,
}

impl NalReader {
    fn push(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(data);
        let b = &self.buf;
        let mut starts = Vec::new();
        let mut i = 0usize;
        while i + 3 <= b.len() {
            if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
                starts.push(i);
                i += 3;
            } else {
                i += 1;
            }
        }
        if starts.len() < 2 {
            return Vec::new();
        }
        let mut nals = Vec::with_capacity(starts.len() - 1);
        for w in 0..starts.len() - 1 {
            nals.push(self.buf[starts[w]..starts[w + 1]].to_vec());
        }
        // Keep from the last (still-incomplete) start code onward.
        let last = *starts.last().unwrap();
        self.buf.drain(0..last);
        nals
    }
}
