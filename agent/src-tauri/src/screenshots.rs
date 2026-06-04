// Primary-monitor screenshot capture. JPEG-encoded with low quality so each frame stays under the
// 512 KB Edge Function/storage cap, then base64 for transport.
//
// macOS path (v0.2.22+): use the system /usr/sbin/screencapture binary.
// It's Apple-signed and trusted, so macOS attributes the screen-capture
// permission check to the *parent* process (Rudrans Agent) — which is
// already in the customer's Screen Recording allow-list. This sidesteps
// both the CGDisplayCreateImage wallpaper-fallback on Sequoia (xcap path)
// and the ad-hoc-signed bundled-ffmpeg TCC re-prompt loop (v0.2.14 path).
//
// Win/Linux still use xcap which works fine on those platforms.

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
    use std::time::{Duration, Instant};

    let out = std::env::temp_dir().join(format!(
        "we_ss_{}.jpg",
        chrono::Utc::now().timestamp_millis()
    ));
    let out_str = out.to_string_lossy().to_string();

    // -x  silent (no sound)
    // -t jpg  JPEG output
    // -C  don't capture the cursor (privacy + cleaner reports)
    // -r  no window shadow
    // /usr/sbin/screencapture is Apple-signed; TCC attributes the request
    // to Rudrans Agent (the parent), so the existing Screen Recording grant
    // applies. No wallpaper fallback, no permission re-prompt on update.
    let mut child = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-C", "-r", "-t", "jpg", &out_str])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawning /usr/sbin/screencapture")?;

    // Hard ceiling — Apple's tool is fast (sub-second normally) but if TCC
    // ever does deny it interactively we don't want the agent loop wedged.
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&out);
                return Err(anyhow!("screencapture timed out (TCC may be blocking)"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                return Err(anyhow!("waiting on screencapture: {e}"));
            }
        }
    };
    if !status.success() {
        let _ = std::fs::remove_file(&out);
        return Err(anyhow!("screencapture exited {}", status));
    }
    let bytes = std::fs::read(&out).with_context(|| format!("reading {out_str}"))?;
    let _ = std::fs::remove_file(&out);
    if bytes.len() < 1000 {
        return Err(anyhow!("screencapture produced suspiciously small file ({} bytes)", bytes.len()));
    }
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
