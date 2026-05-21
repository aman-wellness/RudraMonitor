// Short-clip screen recording via the system `ffmpeg` binary.
//
// We deliberately avoid bundling ffmpeg or linking native APIs — keeps the agent small and
// licensing simple. If ffmpeg isn't on PATH we log a notice and skip the tick. Bundling for
// production rollouts is a Tauri `bundle.resources` decision documented in ROLLOUT.md.

use crate::ffmpeg;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use std::path::PathBuf;
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

const CLIP_DURATION_SECS: u32 = 10;
const FRAMERATE: u32 = 5;
const SCALE_FILTER: &str = "scale=1280:-2";

pub struct CapturedClip {
    pub mp4_b64: String,
    pub taken_at: DateTime<Utc>,
    pub duration_secs: u32,
}

fn temp_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    let nonce = chrono::Utc::now().timestamp_millis();
    p.push(format!("rudrans_{nonce}.mp4"));
    p
}

#[cfg(target_os = "macos")]
fn input_args(ffmpeg_bin: &PathBuf) -> Vec<String> {
    // The previous hard-coded "1:none" was almost always wrong — on macOS,
    // AVFoundation index 1 is typically a camera (FaceTime / Continuity), not
    // the display. The actual screen device is enumerated as "Capture screen 0"
    // at a machine-dependent index. Query ffmpeg for the live device list and
    // pick the screen index dynamically. Result is cached so we only pay the
    // ~150ms probe cost once per process.
    let idx = macos_screen_index(ffmpeg_bin);
    vec!["-f".into(), "avfoundation".into(), "-i".into(), format!("{}:none", idx)]
}

#[cfg(target_os = "macos")]
pub fn macos_screen_index_for_screenshot(ffmpeg_bin: &PathBuf) -> u32 {
    macos_screen_index(ffmpeg_bin)
}

#[cfg(target_os = "macos")]
fn macos_screen_index(ffmpeg_bin: &PathBuf) -> u32 {
    static CACHED: OnceLock<u32> = OnceLock::new();
    *CACHED.get_or_init(|| {
        // Each line in -list_devices output looks like:
        //   [AVFoundation indev @ 0x...] [3] Capture screen 0
        // Parse the LAST "[N]" group (the logger prefix is the FIRST group).
        let out = Command::new(ffmpeg_bin)
            .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
            .output();
        if let Ok(o) = out {
            let txt = String::from_utf8_lossy(&o.stderr);
            for line in txt.lines() {
                if !line.to_lowercase().contains("capture screen") { continue; }
                if let Some(last_open) = line.rfind('[') {
                    if let Some(close) = line[last_open..].find(']') {
                        let n = &line[last_open + 1..last_open + close];
                        if let Ok(v) = n.parse::<u32>() {
                            log::info!("avfoundation screen device detected at index {} (line: {:?})", v, line);
                            return v;
                        }
                    }
                }
            }
            log::warn!("avfoundation list-devices ran but no 'Capture screen' line matched; falling back to index 1");
        } else {
            log::warn!("avfoundation list-devices probe failed; falling back to index 1");
        }
        // Fallback ki 1: most MacBooks have just one camera (FaceTime, index 0)
        // and the screen lands at index 1. Previous fallback of 3 only matched
        // Mac Studios / multi-camera setups and silently failed elsewhere.
        1
    })
}

#[cfg(target_os = "windows")]
fn input_args(_ffmpeg_bin: &PathBuf) -> Vec<String> {
    vec!["-f".into(), "gdigrab".into(), "-i".into(), "desktop".into()]
}

#[cfg(target_os = "linux")]
fn input_args(_ffmpeg_bin: &PathBuf) -> Vec<String> {
    vec!["-f".into(), "x11grab".into(), "-i".into(), ":0.0".into()]
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn input_args(_ffmpeg_bin: &PathBuf) -> Vec<String> {
    vec![]
}

pub async fn record_clip() -> Result<CapturedClip> {
    let ffmpeg_bin = ffmpeg::ensure_ffmpeg()
        .await
        .context("provisioning ffmpeg")?;

    tokio::task::spawn_blocking(move || record_clip_blocking(&ffmpeg_bin))
        .await
        .context("ffmpeg join")?
}

fn record_clip_blocking(ffmpeg_bin: &PathBuf) -> Result<CapturedClip> {
    let out = temp_path();
    let out_str = out.to_string_lossy().to_string();
    let duration = CLIP_DURATION_SECS.to_string();
    let framerate = FRAMERATE.to_string();

    let mut cmd = Command::new(ffmpeg_bin);
    cmd.arg("-y")
        .arg("-loglevel").arg("error")
        .arg("-framerate").arg(&framerate);

    for a in input_args(ffmpeg_bin) {
        cmd.arg(a);
    }

    cmd.arg("-t").arg(&duration)
        .arg("-vf").arg(SCALE_FILTER)
        .arg("-c:v").arg("libx264")
        .arg("-preset").arg("ultrafast")
        .arg("-crf").arg("28")
        .arg("-pix_fmt").arg("yuv420p")
        .arg("-movflags").arg("+faststart")
        .arg("-an") // no audio (privacy + simplicity)
        .arg(&out_str)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let started_at = Utc::now();
    let output = cmd.output().with_context(|| "spawning ffmpeg")?;

    if !output.status.success() {
        // Best-effort cleanup before bubbling the error.
        let _ = std::fs::remove_file(&out);
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(anyhow!("ffmpeg failed: {} — {}", output.status, stderr.trim()));
    }

    let bytes = std::fs::read(&out).with_context(|| format!("reading {out_str}"))?;
    let _ = std::fs::remove_file(&out);

    Ok(CapturedClip {
        mp4_b64: STANDARD.encode(&bytes),
        taken_at: started_at,
        duration_secs: CLIP_DURATION_SECS,
    })
}
