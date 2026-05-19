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
fn input_args() -> Vec<&'static str> {
    // "1:none" = primary display, no audio. macOS may number screens differently across machines;
    // 1 is the default for the built-in display in most setups.
    vec!["-f", "avfoundation", "-i", "1:none"]
}

#[cfg(target_os = "windows")]
fn input_args() -> Vec<&'static str> {
    vec!["-f", "gdigrab", "-i", "desktop"]
}

#[cfg(target_os = "linux")]
fn input_args() -> Vec<&'static str> {
    vec!["-f", "x11grab", "-i", ":0.0"]
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn input_args() -> Vec<&'static str> {
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

    for a in input_args() {
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
