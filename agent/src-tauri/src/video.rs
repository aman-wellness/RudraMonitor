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

// 30s captures show actual user activity — 10s was barely more than a
// screenshot, customers couldn't tell what was happening between switches.
// At 5fps that's 150 frames, x264 ultrafast crf 28 keeps the encoded clip
// well under the 16 MB upload-video ceiling.
const CLIP_DURATION_SECS: u32 = 30;
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
    p.push(format!("we_{nonce}.mp4"));
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

    // On macOS, use the SYSTEM `screencapture` binary for the actual
    // recording — it inherits the parent .app's TCC Screen Recording
    // grant automatically. Bundled ffmpeg is treated by macOS TCC as a
    // separate binary that never got a Screen Recording grant, so
    // `-f avfoundation` silently records black frames (customer report
    // 2026-07-27: Jomin's Mac had Screen Recording toggled on but
    // Videos tab stayed at 0 clips because the bundled-ffmpeg path
    // couldn't actually see the screen). ffmpeg is still invoked
    // for the .mov → .mp4 re-encode, which needs NO screen access
    // so the TCC quirk doesn't apply.
    #[cfg(target_os = "macos")]
    {
        return tokio::task::spawn_blocking(move || record_clip_macos_native(&ffmpeg_bin))
            .await
            .context("screencapture+ffmpeg join")?;
    }
    #[cfg(not(target_os = "macos"))]
    tokio::task::spawn_blocking(move || record_clip_blocking(&ffmpeg_bin))
        .await
        .context("ffmpeg join")?
}

#[cfg(target_os = "macos")]
fn record_clip_macos_native(ffmpeg_bin: &PathBuf) -> Result<CapturedClip> {
    let mov = {
        let mut p = std::env::temp_dir();
        p.push(format!("we_{}.mov", chrono::Utc::now().timestamp_millis()));
        p
    };
    let mp4 = temp_path();

    // screencapture -V <seconds> -v -x -o -T 0 <path.mov>
    //   -V N   : capture video for N seconds
    //   -v     : silent (no shutter sound)
    //   -x     : no notification / preview panel
    //   -T 0   : no start delay
    // Inherits the parent .app's TCC Screen Recording grant.
    let sc_status = Command::new("/usr/sbin/screencapture")
        .args(["-V", &CLIP_DURATION_SECS.to_string(), "-v", "-x", "-T", "0"])
        .arg(&mov)
        .stderr(Stdio::piped())
        .output()
        .context("spawn screencapture")?;
    if !sc_status.status.success() {
        // Common case: TCC not granted. `screencapture` writes nothing to
        // stdout in that case; log the exit code + stderr so support can
        // point the customer at System Settings → Privacy → Screen
        // Recording quickly.
        let err = String::from_utf8_lossy(&sc_status.stderr);
        return Err(anyhow!(
            "screencapture exited {} — did the user grant Screen Recording to Security Assistant? stderr: {}",
            sc_status.status, err.trim()
        ));
    }
    if !mov.exists() {
        return Err(anyhow!("screencapture reported success but no .mov file at {mov:?}"));
    }

    // Re-encode .mov → .mp4 with the same encoding params the pre-2026-07
    // path used, so downstream browser playback + our upload-size ceiling
    // stay identical. Encoding doesn't need screen access → ffmpeg's
    // sandboxed identity is a non-issue here.
    let mut cmd = Command::new(ffmpeg_bin);
    crate::win_proc::no_window(&mut cmd);
    let mov_str = mov.to_string_lossy().to_string();
    let mp4_str = mp4.to_string_lossy().to_string();
    cmd.arg("-y")
        .arg("-loglevel").arg("error")
        .arg("-i").arg(&mov_str)
        .arg("-vf").arg(SCALE_FILTER)
        .arg("-r").arg(FRAMERATE.to_string())
        .arg("-c:v").arg("libx264")
        .arg("-preset").arg("ultrafast")
        .arg("-crf").arg("28")
        .arg("-pix_fmt").arg("yuv420p")
        .arg("-movflags").arg("+faststart")
        .arg("-an")
        .arg(&mp4_str)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let ff = cmd.output().context("spawn ffmpeg re-encode")?;
    // Best-effort cleanup of the intermediate .mov regardless of ffmpeg outcome.
    let _ = std::fs::remove_file(&mov);
    if !ff.status.success() {
        let err = String::from_utf8_lossy(&ff.stderr);
        return Err(anyhow!("ffmpeg re-encode failed ({}): {}", ff.status, err.trim()));
    }

    let bytes = std::fs::read(&mp4).context("read encoded mp4")?;
    let _ = std::fs::remove_file(&mp4);
    Ok(CapturedClip {
        mp4_b64: STANDARD.encode(&bytes),
        taken_at: Utc::now(),
        duration_secs: CLIP_DURATION_SECS,
    })
}

fn record_clip_blocking(ffmpeg_bin: &PathBuf) -> Result<CapturedClip> {
    let out = temp_path();
    let out_str = out.to_string_lossy().to_string();
    let duration = CLIP_DURATION_SECS.to_string();
    let framerate = FRAMERATE.to_string();

    let mut cmd = Command::new(ffmpeg_bin);
    crate::win_proc::no_window(&mut cmd);
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

    // Spawn + wait with a hard ceiling. macOS TCC sometimes silently blocks the
    // ffmpeg subprocess (when the binary's ad-hoc code signature isn't on the
    // Screen Recording allow-list under a stable identity) and the process
    // hangs indefinitely with no stderr output. Without a timeout, the calling
    // tokio task hangs forever and the video poller stops firing future ticks
    // — exactly the production symptom this v0.2.19 build is fixing.
    let mut child = cmd.spawn().with_context(|| "spawning ffmpeg")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(
        (CLIP_DURATION_SECS as u64).saturating_add(20),
    );
    let output = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stderr = Vec::new();
                if let Some(mut s) = child.stderr.take() {
                    use std::io::Read;
                    let _ = s.read_to_end(&mut stderr);
                }
                break std::process::Output { status, stdout: Vec::new(), stderr };
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    log::warn!("ffmpeg recording timeout — killing subprocess");
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&out);
                    return Err(anyhow!(
                        "ffmpeg recording timed out after {}s (likely macOS TCC blocking unsigned binary)",
                        (CLIP_DURATION_SECS as u64).saturating_add(20)
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                return Err(anyhow!("waiting on ffmpeg: {e}"));
            }
        }
    };

    if !output.status.success() {
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
