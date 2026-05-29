// Native screen capture — replaces the ffmpeg subprocess pipeline.
//
// Why move off ffmpeg: each ffmpeg subprocess on macOS spawns a
// 15-25 MB binary, attaches to avfoundation via XPC, transcodes
// through libavfilter, and re-encodes via libavcodec. On a Mac Mini
// 2018 / Surface Pro 7 i5, that's 30-45% CPU during an active Live
// session — enough that the employee notices fan spin-up and complains
// to IT. The product goal is "agent must not hang the customer's
// machine"; ffmpeg as a subprocess can't meet that.
//
// The native path uses Apple's ScreenCaptureKit (macOS 12.3+) /
// Windows Graphics Capture (Win10 1903+) / PipeWire (Linux). Each OS
// owns a zero-copy GPU surface pipeline from compositor to frame
// consumer; we never touch raw pixel bytes in CPU memory.
//
// Output of this layer = a stream of `Frame`s (raw pixel data +
// dimensions + pts). The downstream encoder layer (encode/) consumes
// these and produces H.264 NAL access units.

use anyhow::Result;
use std::sync::Arc;
use tokio::sync::mpsc;

/// One captured frame. `data` is BGRA bytes on macOS/Windows, NV12 on
/// Linux PipeWire (we convert in the encoder layer when needed).
/// `Arc<[u8]>` lets us pass frames between threads without copying.
pub struct Frame {
    pub width:  u32,
    pub height: u32,
    pub stride: u32,        // bytes per row (may differ from width*4 due to GPU alignment)
    pub data:   Arc<[u8]>,
    /// Monotonic nanoseconds since capture started. Used by the encoder
    /// to assign RTP timestamps and to throttle the source FPS.
    pub pts_ns: u64,
}

#[async_trait::async_trait]
pub trait Capturer: Send {
    /// Start capturing at ~`target_fps`. Pushes frames into `tx` until
    /// the sender is dropped (consumer stopped) or capture fails.
    async fn run(self: Box<Self>, target_fps: u32, tx: mpsc::Sender<Frame>) -> Result<()>;
}

/// Build the capturer appropriate for the current OS. On platforms
/// where we haven't shipped a native implementation yet, returns
/// `Ok(None)` so the caller can fall back to the legacy ffmpeg path
/// without crashing.
pub fn for_platform() -> Result<Option<Box<dyn Capturer>>> {
    #[cfg(target_os = "macos")]
    {
        return Ok(Some(Box::new(macos::ScreenCaptureKitCapturer::new()?)));
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows WGC + Linux PipeWire land in the next iteration. The
        // existing ffmpeg path (webrtc_stream::spawn_ffmpeg_with_params)
        // remains the fallback there.
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
pub mod macos;
