// Primary-monitor screenshot capture. JPEG-encoded with low quality so each frame stays under the
// 512 KB Edge Function/storage cap, then base64 for transport.
//
// macOS Sequoia silently returns a wallpaper-only fallback image when the
// calling binary doesn't have ScreenCaptureKit/TCC clearance, even when the
// parent app does. xcap on macOS uses the legacy CGDisplayCreateImage path,
// which is exactly the API that gets the fallback treatment. Customers
// reported "every screenshot is the same desktop wallpaper" — that's the
// fallback in action, not a code bug in xcap. Route macOS screenshot
// capture through the bundled ffmpeg (single-frame avfoundation grab)
// so it shares the TCC identity we already fixed for video recording.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
#[cfg(not(target_os = "macos"))]
use image::{codecs::jpeg::JpegEncoder, ColorType};

#[cfg(not(target_os = "macos"))]
const JPEG_QUALITY: u8 = 50;        // 0-100; ~50 keeps a 1080p frame around 100-200 KB
#[cfg(not(target_os = "macos"))]
const MAX_WIDTH: u32 = 1280;        // downscale wider monitors so payload stays small

pub struct CapturedFrame {
    pub jpeg_b64: String,
    pub taken_at: DateTime<Utc>,
}

#[cfg(target_os = "macos")]
pub fn capture_primary() -> Result<CapturedFrame> {
    use std::process::{Command, Stdio};

    let ffmpeg_bin = crate::ffmpeg::locate_ffmpeg()
        .ok_or_else(|| anyhow!("ffmpeg not found — bundle missing or cache empty"))?;
    let idx = crate::video::macos_screen_index_for_screenshot(&ffmpeg_bin);

    let mut out = std::env::temp_dir();
    out.push(format!("rudrans_ss_{}.jpg", chrono::Utc::now().timestamp_millis()));
    let out_str = out.to_string_lossy().to_string();

    // Same hard 15s ceiling as video::record_clip — macOS TCC can silently
    // block the subprocess without ever returning, and the screenshot loop
    // would otherwise wedge forever after the first hang.
    let mut child = Command::new(&ffmpeg_bin)
        .args([
            "-y",
            "-loglevel", "error",
            "-f", "avfoundation",
            "-i", &format!("{}:none", idx),
            "-frames:v", "1",
            "-vf", "scale=1280:-2",
            "-q:v", "5",
            &out_str,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| "spawning ffmpeg for screenshot")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    log::warn!("ffmpeg screenshot timeout — killing subprocess");
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&out);
                    return Err(anyhow!("ffmpeg screenshot timed out (likely macOS TCC blocking unsigned binary)"));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                return Err(anyhow!("waiting on ffmpeg: {e}"));
            }
        }
    };
    if !status.success() {
        let _ = std::fs::remove_file(&out);
        return Err(anyhow!("ffmpeg screenshot exited {}", status));
    }
    let bytes = std::fs::read(&out).with_context(|| format!("reading {out_str}"))?;
    let _ = std::fs::remove_file(&out);
    Ok(CapturedFrame {
        jpeg_b64: STANDARD.encode(&bytes),
        taken_at: Utc::now(),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_primary() -> Result<CapturedFrame> {
    let monitors = xcap::Monitor::all().map_err(|e| anyhow!("xcap monitors: {e}"))?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| xcap::Monitor::all().ok().and_then(|v| v.into_iter().next()))
        .ok_or_else(|| anyhow!("no monitors detected"))?;

    let img = monitor.capture_image().map_err(|e| anyhow!("xcap capture: {e}"))?;
    let (mut w, mut h) = (img.width(), img.height());
    let mut buf = img.into_raw(); // RGBA8

    // Downscale to MAX_WIDTH to keep file size predictable on 4K screens.
    if w > MAX_WIDTH {
        let scale = MAX_WIDTH as f32 / w as f32;
        let new_h = (h as f32 * scale).round() as u32;
        let resized = image::imageops::resize(
            &image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(w, h, buf)
                .ok_or_else(|| anyhow!("invalid raw image"))?,
            MAX_WIDTH,
            new_h,
            image::imageops::FilterType::Triangle,
        );
        w = resized.width();
        h = resized.height();
        buf = resized.into_raw();
    }

    // JPEG only supports RGB; strip the alpha channel.
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in buf.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }

    let mut jpeg = Vec::with_capacity(150 * 1024);
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY);
        encoder
            .encode(&rgb, w, h, ColorType::Rgb8.into())
            .map_err(|e| anyhow!("jpeg encode: {e}"))?;
    }

    Ok(CapturedFrame {
        jpeg_b64: STANDARD.encode(&jpeg),
        taken_at: Utc::now(),
    })
}
