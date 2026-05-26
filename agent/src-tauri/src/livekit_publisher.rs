// LiveKit-based screen publisher. Replaces the legacy webrtc_stream.rs
// for v0.3.0+ agents.
//
// Why this exists (see the approved plan
// /Users/Aman/.claude/plans/yaar-koi-hor-tarika-cozy-bonbon.md):
//
//   * Hand-rolled WebRTC + ffmpeg subprocess + signaling edge fn
//     produced a fresh failure mode every release: green screens,
//     slow connect, "Connected but no frames", ICE candidate races.
//   * LiveKit is a battle-tested Apache 2.0 SFU. Its Rust SDK accepts
//     CPU-side RGBA frames and handles every WebRTC quirk for us.
//
// Pipeline (per Live or Remote session):
//
//   xcap::Monitor::capture_image()   // grab the desktop @ N fps
//     -> RGBA → I420 conversion       // libwebrtc wants planar YUV
//     -> NativeVideoSource::capture_frame
//     -> LiveKit's encoder + RTP packetizer + SFU
//     -> dashboard <video> element
//
// Input events (mouse / keyboard / clipboard) ride LiveKit's reliable
// data channel via room.on_data_received().
//
// One LiveKit "room" per agent (name = "agent_<agent_id>"). Agent
// joins as a publisher; dashboard joins as a subscriber + data
// publisher. Permissions enforced by the livekit-token edge fn.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use livekit::{
    options::{TrackPublishOptions, VideoCodec},
    track::{LocalTrack, LocalVideoTrack, TrackSource},
    webrtc::{
        prelude::*,
        video_frame::{I420Buffer, VideoFrame, VideoRotation},
        video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
    },
    DataPacket, Room, RoomEvent, RoomOptions,
};
use serde_json::json;
use tokio::time::sleep;

use crate::{api, config, input, AppState};

const TARGET_WIDTH: u32 = 1280;
const TARGET_HEIGHT: u32 = 720;
const TARGET_FPS: u32 = 30;

/// JSON wire protocol (matches the legacy webrtc_stream control DC so the
/// dashboard's RemoteTab can speak it unchanged once it switches to
/// LiveKit's data channel).
#[derive(Debug, serde::Deserialize)]
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
}

/// Top-level entry: spawn a tokio task that joins the LiveKit room and
/// publishes the screen until the agent shuts down. Idempotent — second
/// call is a no-op (the inner connect loop handles its own reconnects).
pub fn spawn(state: AppState) {
    static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if STARTED.set(()).is_err() { return; }
    tauri::async_runtime::spawn(async move {
        // Wait until the agent is enrolled (license + supabase_url present);
        // re-check every 5 s. Mirrors the old streaming loop's gate.
        loop {
            if crate::ready(&state).await { break; }
            sleep(Duration::from_secs(5)).await;
        }
        log::info!("livekit publisher: starting");
        // Outer reconnect loop. If the room ever disconnects (network
        // change, server restart), back off then rejoin.
        loop {
            match run_session(&state).await {
                Ok(()) => log::info!("livekit publisher: session ended normally; reconnecting in 5s"),
                Err(e) => log::warn!("livekit publisher: {e}; reconnecting in 10s"),
            }
            sleep(Duration::from_secs(10)).await;
        }
    });
}

async fn run_session(state: &AppState) -> Result<()> {
    let token_info = mint_token(state).await?;
    log::info!(
        "livekit publisher: connecting to room={} as identity={}",
        token_info.room, token_info.identity,
    );

    let (room, mut rx) = Room::connect(&token_info.url, &token_info.token, RoomOptions::default())
        .await
        .map_err(|e| anyhow!("livekit connect: {e}"))?;
    let room = Arc::new(room);

    // Video source. Native = CPU-side I420 frames pushed by us; LiveKit
    // encodes and ships via its SFU.
    // NativeVideoSource::new(resolution, enable_cpu_adaptation). We
    // disable internal CPU adaptation because we already control fps
    // and resolution ourselves; let the SFU do bandwidth adaptation
    // instead via simulcast.
    let source = NativeVideoSource::new(
        VideoResolution { width: TARGET_WIDTH, height: TARGET_HEIGHT },
        false,
    );
    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: VideoCodec::H264, // browser-friendly
                ..Default::default()
            },
        )
        .await
        .map_err(|e| anyhow!("publish_track: {e}"))?;

    // Spawn the capture loop in its own task so the room event loop can
    // run concurrently.
    let capture_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let stop = capture_stop.clone();
        tauri::async_runtime::spawn(async move {
            capture_loop(source, stop).await;
        });
    }

    // Inbound event loop: read RoomEvents until the room closes.
    while let Some(ev) = rx.recv().await {
        match ev {
            RoomEvent::DataReceived { payload, .. } => {
                if let Err(e) = handle_data(&room, payload.as_ref()).await {
                    log::warn!("livekit data handler: {e}");
                }
            }
            RoomEvent::Disconnected { reason } => {
                log::info!("livekit publisher: disconnected — reason={reason:?}");
                break;
            }
            _ => {}
        }
    }
    capture_stop.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Frame-grab loop. Captures the primary monitor with xcap, converts
/// RGBA → I420, hands the frame to LiveKit's NativeVideoSource. xcap is
/// already a dependency for screenshots.rs so we reuse the same path
/// (and inherit its TCC grant on macOS).
async fn capture_loop(source: NativeVideoSource, stop: Arc<std::sync::atomic::AtomicBool>) {
    let frame_interval = Duration::from_millis((1000 / TARGET_FPS) as u64);
    loop {
        if stop.load(std::sync::atomic::Ordering::SeqCst) { break; }
        let started = std::time::Instant::now();

        // libwebrtc's I420Buffer isn't Clone — it's reference-counted
        // and the underlying memory is owned by libwebrtc-sys. We
        // allocate a fresh buffer per frame; the previous one is
        // released by libwebrtc once the encoder has consumed it.
        let mut yuv = I420Buffer::new(TARGET_WIDTH, TARGET_HEIGHT);
        if let Err(e) = grab_and_convert(&mut yuv) {
            log::warn!("livekit capture: {e}");
            sleep(Duration::from_millis(500)).await;
            continue;
        }

        let frame = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: chrono::Utc::now().timestamp_micros(),
            frame_metadata: None,
            buffer: yuv,
        };
        source.capture_frame(&frame);

        // Pace at TARGET_FPS — don't burn CPU if a grab was unusually fast.
        let elapsed = started.elapsed();
        if elapsed < frame_interval {
            sleep(frame_interval - elapsed).await;
        }
    }
    log::info!("livekit capture: loop exited");
}

/// xcap capture → RGBA → I420. We use BT.601 limited-range coefficients
/// (the libwebrtc decoder applies the same matrix on the way out, so the
/// round-trip lands on the original colours). Operates on the primary
/// monitor; multi-monitor support comes later.
fn grab_and_convert(out: &mut I420Buffer) -> Result<()> {
    let monitors = xcap::Monitor::all().context("xcap list monitors")?;
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| anyhow!("no monitors detected"))?;
    let img = monitor.capture_image().context("xcap capture")?;

    // Letterbox / scale RGBA → TARGET_WIDTH × TARGET_HEIGHT. Using
    // image::imageops::resize keeps us off ffmpeg for this path — pure
    // Rust, no subprocess.
    let resized = image::imageops::resize(
        &img,
        TARGET_WIDTH,
        TARGET_HEIGHT,
        image::imageops::FilterType::Triangle,
    );

    let (stride_y, stride_u, stride_v) = out.strides();
    let (y_plane, u_plane, v_plane) = out.data_mut();
    rgba_to_i420(
        resized.as_raw(),
        TARGET_WIDTH as usize,
        TARGET_HEIGHT as usize,
        y_plane, stride_y as usize,
        u_plane, stride_u as usize,
        v_plane, stride_v as usize,
    );
    Ok(())
}

/// BT.601 RGBA → I420. Subsamples chroma 2×2. Hot path — straight scalar
/// loop is plenty for 1280×720 @ 30 fps (~7 ms on a current laptop), no
/// SIMD needed yet.
fn rgba_to_i420(
    src: &[u8], width: usize, height: usize,
    y: &mut [u8], y_stride: usize,
    u: &mut [u8], u_stride: usize,
    v: &mut [u8], v_stride: usize,
) {
    // Y for every pixel.
    for row in 0..height {
        let src_row = &src[row * width * 4 .. (row + 1) * width * 4];
        let dst_row = &mut y[row * y_stride .. row * y_stride + width];
        for col in 0..width {
            let p = &src_row[col * 4 .. col * 4 + 4];
            let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
            // BT.601 limited (16..235)
            let yv = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            dst_row[col] = yv.clamp(0, 255) as u8;
        }
    }
    // U/V at 2×2 subsampling — average 4 source pixels per chroma sample.
    for row in (0..height).step_by(2) {
        for col in (0..width).step_by(2) {
            let mut rs = 0i32; let mut gs = 0i32; let mut bs = 0i32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let r0 = (row + dy).min(height - 1);
                    let c0 = (col + dx).min(width - 1);
                    let p = &src[(r0 * width + c0) * 4 .. (r0 * width + c0) * 4 + 4];
                    rs += p[0] as i32; gs += p[1] as i32; bs += p[2] as i32;
                }
            }
            let r = rs / 4; let g = gs / 4; let b = bs / 4;
            let uv = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
            let vv = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
            let cr = row / 2;
            let cc = col / 2;
            u[cr * u_stride + cc] = uv.clamp(0, 255) as u8;
            v[cr * v_stride + cc] = vv.clamp(0, 255) as u8;
        }
    }
}

/// Inbound data-channel handler. The dashboard publishes JSON-encoded
/// input events; we deserialise and forward to the input thread that
/// already exists from the legacy stack.
async fn handle_data(room: &Arc<Room>, payload: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(payload).context("data payload not utf8")?;
    let msg: InboundMsg = serde_json::from_str(text).context("bad json")?;
    let Some(tx) = input::sender() else {
        log::warn!("livekit data: input thread not ready");
        return Ok(());
    };
    match msg {
        InboundMsg::Hello { .. } => {
            let (w, h) = primary_screen_dims();
            send_text(room, json!({"t":"screen_info","w":w,"h":h,"scale":1})).await;
        }
        InboundMsg::MouseMove { x, y } => {
            let (w, h) = primary_screen_dims();
            let px = (x.clamp(0.0, 1.0) * w as f64).round() as i32;
            let py = (y.clamp(0.0, 1.0) * h as f64).round() as i32;
            let _ = tx.send(input::InputEvent::MouseMove { x: px, y: py });
        }
        InboundMsg::MouseButton { btn, down } => {
            let button = match btn.as_str() {
                "left" => input::MouseButton::Left,
                "right" => input::MouseButton::Right,
                "middle" => input::MouseButton::Middle,
                _ => return Ok(()),
            };
            let _ = tx.send(input::InputEvent::MouseButton { button, down });
        }
        InboundMsg::MouseWheel { dx, dy } => {
            let _ = tx.send(input::InputEvent::MouseWheel { dx, dy });
        }
        InboundMsg::Key { code, down } => {
            let _ = tx.send(input::InputEvent::Key { code, down });
        }
        InboundMsg::ClipSet { text } => {
            let _ = tx.send(input::InputEvent::ClipSet { text });
        }
        InboundMsg::ClipGet => {
            let (rtx, rrx) = tokio::sync::oneshot::channel();
            let _ = tx.send(input::InputEvent::ClipGet(rtx));
            let clip = match tokio::time::timeout(Duration::from_millis(500), rrx).await {
                Ok(Ok(v)) => v.unwrap_or_default(),
                _ => String::new(),
            };
            send_text(room, json!({"t":"clip_data","text":clip})).await;
        }
        InboundMsg::Ping { id } => {
            send_text(room, json!({"t":"pong","id":id})).await;
        }
    }
    Ok(())
}

async fn send_text(room: &Arc<Room>, value: serde_json::Value) {
    let _ = room
        .local_participant()
        .publish_data(DataPacket {
            payload: value.to_string().into_bytes(),
            ..Default::default()
        })
        .await;
}

fn primary_screen_dims() -> (i32, i32) {
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
        Err(e) => log::warn!("primary_screen_dims: xcap failed: {e}"),
    }
    (1920, 1080)
}

/// JWT mint via the livekit-token edge fn. Same response shape as the
/// dashboard receives — we just use the X-Agent-Token header for auth.
struct TokenInfo {
    url: String,
    token: String,
    room: String,
    identity: String,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    url: String,
    token: String,
    room: String,
    identity: String,
}

async fn mint_token(state: &AppState) -> Result<TokenInfo> {
    let cfg = state.config.lock().await.clone();
    let enrollment = cfg.enrollment.as_ref().ok_or_else(|| anyhow!("not enrolled"))?.clone();
    let supabase_url = config::supabase_url(&cfg).ok_or_else(|| anyhow!("no supabase url"))?;
    let anon_key = config::supabase_anon_key(&cfg).ok_or_else(|| anyhow!("no anon key"))?;
    let url = format!("{}/functions/v1/livekit-token", supabase_url.trim_end_matches('/'));
    let client = api::build_client()?;
    let resp = client
        .post(&url)
        .header("apikey", &anon_key)
        .header("X-Agent-Token", &enrollment.enroll_token)
        .json(&json!({ "agent_id": enrollment.agent_id }))
        .send()
        .await
        .context("livekit-token fetch")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("livekit-token http {status}: {body}"));
    }
    let r: TokenResponse = resp.json().await.context("parse livekit-token response")?;
    Ok(TokenInfo { url: r.url, token: r.token, room: r.room, identity: r.identity })
}
