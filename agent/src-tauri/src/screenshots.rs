// Primary-monitor screenshot capture. JPEG-encoded with low quality so each frame stays under the
// 512 KB Edge Function/storage cap, then base64 for transport.
//
// Implementation history:
//   - v0.2.13 and earlier: xcap on every OS. macOS Sequoia returns a
//     wallpaper-only fallback on the legacy CGWindowList path WHEN the calling
//     process doesn't have Screen Recording permission. Once the customer
//     grants the agent permission, the fallback should stop and real screen
//     content comes through.
//   - v0.2.14 to v0.2.19: macOS path moved to a bundled-ffmpeg subprocess,
//     hoping to share the TCC identity. The opposite happened — ad-hoc signed
//     subprocesses are mistrusted by macOS on every install (their hash
//     changes per build), so ffmpeg hung silently and the customer saw NO
//     screenshots at all instead of wallpaper ones.
//   - v0.2.20+: revert macOS to xcap. xcap runs INSIDE the agent process, so
//     its TCC identity is the agent itself — the entry the customer already
//     granted. If macOS still returns wallpaper, the proper fix is the
//     Apple Developer ID signing track. ffmpeg subprocess approach abandoned.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use image::{codecs::jpeg::JpegEncoder, ColorType};

const JPEG_QUALITY: u8 = 50;        // 0-100; ~50 keeps a 1080p frame around 100-200 KB
const MAX_WIDTH: u32 = 1280;        // downscale wider monitors so payload stays small

pub struct CapturedFrame {
    pub jpeg_b64: String,
    pub taken_at: DateTime<Utc>,
}

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
