// macOS native screen capture via ScreenCaptureKit.
//
// Flow:
//   1. SCShareableContent::get() → pick the primary SCDisplay.
//   2. SCContentFilter::with_display_excluding_windows (capture the
//      whole screen sans our own windows — irrelevant on the agent
//      since we have none visible, but kept for correctness).
//   3. SCStreamConfiguration with width/height/fps/BGRA/show-cursor.
//   4. SCStream + an SCStreamOutputTrait handler. The handler runs on
//      a Core Foundation thread; it pulls BGRA bytes out of the
//      CVPixelBuffer attached to each CMSampleBuffer and shoves them
//      into a tokio mpsc bounded channel (try_send drops the frame on
//      backpressure — encoder couldn't keep up, dropping is cheaper
//      than queuing and growing memory).
//
// Permission: ScreenCaptureKit requires the Screen Recording TCC
// privilege. If the user hasn't granted it via System Settings →
// Privacy & Security → Screen Recording, SCShareableContent::get()
// errors out and we bubble the error up — caller falls back to the
// ffmpeg path which has the same requirement and will display the
// same TCC prompt.

use super::{Capturer, Frame};
use anyhow::{anyhow, Context, Result};
use core_media_rs::cm_sample_buffer::CMSampleBuffer;
use core_media_rs::cm_time::CMTime;
use core_video_rs::cv_pixel_buffer::lock::LockTrait;
use core_video_rs::cv_pixel_buffer::CVPixelBuffer;
use screencapturekit::{
    shareable_content::SCShareableContent,
    stream::{
        configuration::{pixel_format::PixelFormat, SCStreamConfiguration},
        content_filter::SCContentFilter,
        output_trait::SCStreamOutputTrait,
        output_type::SCStreamOutputType,
        SCStream,
    },
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::sync::mpsc;

pub struct ScreenCaptureKitCapturer {
    width: u32,
    height: u32,
}

impl ScreenCaptureKitCapturer {
    pub fn new() -> Result<Self> {
        // Probe the primary display BEFORE we commit to a capture so we
        // can size the stream config to match. SCK auto-scales if our
        // dimensions don't match, but matching natively avoids the GPU
        // doing a rescale on every frame.
        let displays = SCShareableContent::get()
            .map_err(|e| anyhow!("SCShareableContent::get failed: {e:?} — Screen Recording permission required"))?
            .displays();
        let display = displays
            .first()
            .ok_or_else(|| anyhow!("no display available"))?;
        let width = display.width();
        let height = display.height();
        log::info!("sck: primary display {width}x{height}");
        Ok(Self { width, height })
    }
}

/// Output handler — runs on a CoreFoundation thread inside SCK. Has to
/// be Send + Sync because SCK holds it across threads internally.
struct Output {
    tx: mpsc::Sender<Frame>,
    started_at: Instant,
    /// Monotonic frame counter — used to drop frames when we exceed the
    /// target FPS. Cheaper than wall-clock comparisons inside a hot
    /// per-frame callback.
    last_emit_ns: AtomicU64,
    /// Minimum ns between emitted frames (= 1e9 / target_fps).
    min_interval_ns: u64,
}

impl SCStreamOutputTrait for Output {
    fn did_output_sample_buffer(
        &self,
        sample: CMSampleBuffer,
        of_type: SCStreamOutputType,
    ) {
        if of_type != SCStreamOutputType::Screen {
            return;
        }
        // FPS gate: SCK delivers at the display's natural refresh
        // (60 Hz on a Retina Mac). We only forward frames at our
        // target rate; the rest are silently dropped to save encoder
        // CPU and bandwidth.
        let now_ns = self.started_at.elapsed().as_nanos() as u64;
        let last = self.last_emit_ns.load(Ordering::Relaxed);
        if now_ns.saturating_sub(last) < self.min_interval_ns {
            return;
        }
        // Pull the CVPixelBuffer out of the CMSampleBuffer.
        let pixbuf = match sample.get_pixel_buffer() {
            Ok(p) => p,
            Err(e) => {
                log::warn!("sck: get_pixel_buffer failed: {e:?}");
                return;
            }
        };
        let frame = match extract_frame(&pixbuf, now_ns) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("sck: extract_frame failed: {e}");
                return;
            }
        };
        // Non-blocking send — drop on backpressure rather than block
        // the CF callback thread (would stall the whole capture).
        match self.tx.try_send(frame) {
            Ok(()) => {
                self.last_emit_ns.store(now_ns, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                // Encoder couldn't keep up. Drop silently — better
                // than queue-grow latency.
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                // Consumer dropped — capture will be stopped by the
                // outer task; we just exit this callback.
            }
        }
    }
}

/// Pull BGRA bytes out of a CVPixelBuffer. Locks the buffer, copies
/// `height × stride` bytes into a fresh Arc<[u8]>, then unlocks. The
/// copy is unavoidable here because the CV-owned memory is reclaimed
/// when this function returns; later iterations can keep the
/// CVPixelBuffer alive and hand it directly to VideoToolbox for true
/// zero-copy encoding.
fn extract_frame(pixbuf: &CVPixelBuffer, pts_ns: u64) -> Result<Frame> {
    let width = pixbuf.get_width();
    let height = pixbuf.get_height();
    let stride = pixbuf.get_bytes_per_row();
    // RAII lock guard via core-video-rs's safe wrapper — the underlying
    // CVPixelBufferLockBaseAddress is called on entry and the matching
    // unlock on Drop. as_slice() returns the BGRA bytes for the single
    // (non-planar) plane SCK gives us when the pixel format is BGRA.
    let guard = pixbuf
        .lock()
        .map_err(|e| anyhow!("CVPixelBuffer lock: {e:?}"))?;
    let bytes = guard.as_slice();
    let data: Arc<[u8]> = Arc::from(bytes.to_vec().into_boxed_slice());
    drop(guard);
    Ok(Frame { width, height, stride, data, pts_ns })
}

#[async_trait::async_trait]
impl Capturer for ScreenCaptureKitCapturer {
    async fn run(self: Box<Self>, target_fps: u32, tx: mpsc::Sender<Frame>) -> Result<()> {
        let target_fps = target_fps.max(1);
        let min_interval_ns = 1_000_000_000u64 / target_fps as u64;
        let width = self.width;
        let height = self.height;

        // SCK's SCDisplay / SCStream / SCStreamConfiguration handles
        // are !Send because they wrap raw Apple-framework pointers.
        // We can't hold them across an await on the tokio runtime
        // (multi-threaded → would invalidate the !Send assumption).
        //
        // Solution: run the entire SCK lifecycle on a dedicated OS
        // thread. The async run() function just sets up a stop
        // channel and waits for the consumer-side `tx` to close.
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let frame_tx = tx.clone();

        let thread_handle = std::thread::Builder::new()
            .name("sck-capture".into())
            .spawn(move || -> Result<()> {
                let displays = SCShareableContent::get()
                    .map_err(|e| anyhow!("SCShareableContent::get: {e:?}"))?
                    .displays();
                let display = displays
                    .into_iter()
                    .next()
                    .ok_or_else(|| anyhow!("no display"))?;

                let config = SCStreamConfiguration::new()
                    .set_width(width)
                    .map_err(|e| anyhow!("set_width: {e:?}"))?
                    .set_height(height)
                    .map_err(|e| anyhow!("set_height: {e:?}"))?
                    .set_shows_cursor(true)
                    .map_err(|e| anyhow!("set_shows_cursor: {e:?}"))?
                    .set_pixel_format(PixelFormat::BGRA)
                    .map_err(|e| anyhow!("set_pixel_format: {e:?}"))?
                    .set_minimum_frame_interval(&CMTime {
                        value: 1,
                        timescale: target_fps as i32,
                        flags: 1,
                        epoch: 0,
                    })
                    .map_err(|e| anyhow!("set_minimum_frame_interval: {e:?}"))?
                    .set_queue_depth(3)
                    .map_err(|e| anyhow!("set_queue_depth: {e:?}"))?;

                let filter =
                    SCContentFilter::new().with_display_excluding_windows(&display, &[]);
                let mut stream = SCStream::new(&filter, &config);
                let output = Output {
                    tx: frame_tx,
                    started_at: Instant::now(),
                    last_emit_ns: AtomicU64::new(0),
                    min_interval_ns,
                };
                stream.add_output_handler(output, SCStreamOutputType::Screen);

                stream
                    .start_capture()
                    .map_err(|e| anyhow!("start_capture: {e:?}"))?;
                log::info!("sck: capture started @ {target_fps}fps");

                // Block this OS thread until the async side tells us
                // to stop (channel close = consumer dropped tx).
                let _ = stop_rx.recv();
                log::info!("sck: stop signal received");
                let _ = stream.stop_capture();
                Ok(())
            })
            .context("spawn sck-capture thread")?;

        // Async side: wait for the consumer to drop their end of `tx`,
        // then signal the SCK thread to stop and join it.
        tx.closed().await;
        let _ = stop_tx.send(());
        // Best-effort join. Don't propagate the inner Result since the
        // capture has already done its job by the time we get here.
        if let Err(e) = thread_handle.join() {
            log::warn!("sck-capture thread panicked: {e:?}");
        }
        Ok(())
    }
}
