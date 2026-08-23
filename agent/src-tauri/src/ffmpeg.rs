// Self-contained ffmpeg provisioning.
//
// Resolution order:
//   1. Bundled binary shipped inside the .app/.msi/.deb. This is the macOS
//      Screen Recording fix — when ffmpeg lives inside the parent bundle, TCC
//      attributes screen-capture calls to the parent's identity ("Rudrans
//      Agent") which already has permission. The previous download-to-user-
//      data-dir path made ffmpeg an orphan binary at an unsigned location, so
//      macOS re-prompted for screen recording every few minutes and refused
//      to remember the grant.
//   2. Cached copy in OS user-data dir (legacy v0.2.4-v0.2.12 download path).
//   3. System `ffmpeg` on PATH (lets advanced users override with a custom build).
//   4. Fresh download from Supabase Storage — last-resort if the bundle was
//      tampered with or the agent was installed from an old build before
//      ffmpeg started shipping inside the bundle.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(target_os = "windows")]
const FFMPEG_URL: &str = "https://api-ems.wellnessextract.com/storage/v1/object/public/ffmpeg/ffmpeg-windows-x64.exe";
#[cfg(target_os = "macos")]
const FFMPEG_URL: &str = "https://api-ems.wellnessextract.com/storage/v1/object/public/ffmpeg/ffmpeg-macos-universal";
#[cfg(target_os = "linux")]
const FFMPEG_URL: &str = "https://api-ems.wellnessextract.com/storage/v1/object/public/ffmpeg/ffmpeg-linux-x64";

#[cfg(target_os = "windows")]
const BIN_NAME: &str = "ffmpeg.exe";
#[cfg(not(target_os = "windows"))]
const BIN_NAME: &str = "ffmpeg";

// Pinned SHA-256 of the downloaded ffmpeg (audit H9). The download path fetches
// an executable from public storage and runs it; without an integrity check, a
// compromised bucket/CDN means remote code execution on every agent that hits
// the fallback. Set this at build time (`RUDRANS_FFMPEG_SHA256=<hex>`) so a
// release build REQUIRES the exact binary. Empty (unset) keeps the old
// behaviour but logs a loud warning — pin it for production builds.
const EXPECTED_FFMPEG_SHA256: &str = match option_env!("RUDRANS_FFMPEG_SHA256") {
    Some(v) => v,
    None => "",
};

fn cache_path() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("could not resolve OS data dir"))?;
    let dir = base.join("RudransAgent").join("bin");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {:?}", dir))?;
    Ok(dir.join(BIN_NAME))
}

/// Where Tauri drops `bundle.resources` per platform. The agent runs as
/// `<bundle>/Contents/MacOS/wellness-extract-agent` on macOS, so resources sit one
/// dir up under Contents/Resources/. Windows and Linux Tauri builds keep
/// the resources sibling to the executable.
fn bundled_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            #[cfg(target_os = "macos")]
            {
                // /Applications/Rudrans Agent.app/Contents/MacOS/wellness-extract-agent
                //   → ../Resources/...
                if let Some(contents) = exe_dir.parent() {
                    // Tauri 2 actually nests bundle.resources entries under
                    // Contents/Resources/resources/ (mirrors the layout of
                    // agent/src-tauri/resources/). The pkg installer drops the
                    // file at THIS path; everything else is a defensive guess.
                    out.push(contents.join("Resources").join("resources").join(BIN_NAME));
                    // Older Tauri 1 layouts flattened straight into Resources/
                    // and a few snapshots used the _up_/ shim — keep both as
                    // safety nets so a mixed-build customer still resolves.
                    out.push(contents.join("Resources").join(BIN_NAME));
                    out.push(contents.join("Resources").join("_up_").join("resources").join(BIN_NAME));
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                // Windows MSI: <install>\wellness-extract-agent.exe   ←→ <install>\resources\ffmpeg.exe
                // Linux deb:    /usr/bin/wellness-extract-agent       ←→ /usr/lib/.../resources/ffmpeg
                // Tauri also drops a sibling resources/ dir.
                out.push(exe_dir.join("resources").join(BIN_NAME));
                out.push(exe_dir.join(BIN_NAME));
            }
        }
    }
    out
}

fn works(path: &PathBuf) -> bool {
    let mut cmd = Command::new(path);
    crate::win_proc::no_window(&mut cmd);
    cmd.arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// One-shot probe: run `ffmpeg -encoders` and return the set of encoder
/// names the binary actually ships with. Used by `pick_h264_encoder` so
/// we don't pass `-vcodec h264_nvenc` to an ffmpeg build that wasn't
/// compiled with NVENC support — that produces a hard "Unknown encoder"
/// failure with no fallback.
fn list_encoders(path: &PathBuf) -> std::collections::HashSet<String> {
    let mut cmd = Command::new(path);
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.arg("-hide_banner").arg("-encoders")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let mut set = std::collections::HashSet::new();
    if let Ok(o) = out {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            // Format: " V..... h264_nvenc           NVIDIA NVENC H.264 encoder ..."
            // We want the second whitespace-delimited token.
            let trimmed = line.trim();
            let mut it = trimmed.split_whitespace();
            let flags = it.next().unwrap_or("");
            let name = it.next().unwrap_or("").to_string();
            // Only video encoders (flags start with 'V').
            if flags.starts_with('V') && !name.is_empty() {
                set.insert(name);
            }
        }
    }
    set
}

/// Pick the best available H.264 encoder for this machine. Hardware
/// encoders are dramatically faster (2–8 ms per frame vs 10–30 ms for
/// libx264 ultrafast) and free up the CPU during a Live/Remote session.
/// Order is the same one Parsec/Moonlight use:
///   1. Platform-native hardware (VideoToolbox / NVENC / AMF / QSV / VAAPI)
///   2. libx264 software fallback
///
/// Cached after the first call — the answer never changes within a
/// process lifetime and the probe is ~50 ms.
pub fn pick_h264_encoder(ffmpeg_bin: &PathBuf) -> &'static str {
    use std::sync::OnceLock;
    static CACHED: OnceLock<&'static str> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let available = list_encoders(ffmpeg_bin);
        // Preference order. First match wins.
        #[cfg(target_os = "macos")]
        let order = ["h264_videotoolbox", "libx264"];
        // Windows: libx264 FIRST.
        //
        // Why not hardware encoders here: `list_encoders` only checks
        // what ffmpeg.exe was COMPILED with — not what the host
        // hardware actually supports at runtime. So on a machine
        // without NVIDIA GPU, our probe still returns `h264_nvenc` as
        // "available", we configure it, ffmpeg subprocess starts, and
        // then either:
        //   • blocks 5-10 s probing for an NVENC-capable GPU before
        //     giving up (LiveKit Ingress's "source encoder not ready"
        //     timer fires at 8 s — session torn down before our first
        //     frame arrives), OR
        //   • fails fast but takes long enough that we miss the
        //     timeout window anyway.
        //
        // libx264 has zero runtime probing — it works everywhere and
        // starts producing frames within ~50 ms of spawn. CPU is 15-25%
        // at our 960p/1.2Mbps/24fps target, which is acceptable; the
        // alternative is "Live View doesn't work at all on this
        // customer's machine" which is unacceptable.
        //
        // v0.3.2-followup: ship a proper Windows Graphics Capture +
        // Media Foundation native path (per the Phase-1 spec). That
        // gets us back to true hardware encoding with reliable
        // startup. Today's commit is the 80/20 "make it work first".
        #[cfg(target_os = "windows")]
        let order = ["libx264"];
        #[cfg(target_os = "linux")]
        let order = ["libx264"];
        for name in order {
            if available.contains(name) {
                log::info!("h264 encoder picked: {name}");
                return name;
            }
        }
        log::warn!("no known H.264 encoder available in ffmpeg; falling back to libx264 by name");
        "libx264"
    })
}

/// Whether `ddagrab` (Desktop Duplication API) actually captures on THIS
/// machine, established by capturing a frame rather than by asking what the
/// binary supports.
///
/// Remote Desktop's Windows capture uses ddagrab because gdigrab cannot reach
/// 30 fps at 1080p (measured ~19 vs ~29). But ddagrab is not universally
/// available, and every way it fails is invisible to a filter-list check:
///
///   • it needs ffmpeg 6.0+, and an older ffmpeg on PATH or in the cache is
///     resolved ahead of any newer bundled copy;
///   • it needs an attached desktop session, so it fails under a service
///     context and over some RDP configurations;
///   • it goes through D3D11, which on this very machine already produced a
///     runtime "Invalid argument" from `scale_d3d11` while reporting the
///     filter as present.
///
/// That last point is the same trap `pick_h264_encoder` documents at length:
/// `-filters` and `-encoders` list what ffmpeg was COMPILED with, not what the
/// host can do. So this runs the real thing for one frame and reads the exit
/// status. Without the probe, a machine that cannot do ddagrab gets a session
/// that connects and then shows a permanently black screen — the failure is
/// silent because the peer connection itself is perfectly healthy.
///
/// Cached for the process lifetime: the answer cannot change, and the probe
/// costs a few hundred milliseconds.
#[cfg(target_os = "windows")]
pub fn can_ddagrab(ffmpeg_bin: &PathBuf) -> bool {
    use std::sync::OnceLock;
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let mut cmd = Command::new(ffmpeg_bin);
        crate::win_proc::no_window(&mut cmd);
        let ok = cmd
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-filter_complex",
                "ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            log::info!("ddagrab probe succeeded; using Desktop Duplication capture");
        } else {
            log::warn!(
                "ddagrab probe failed on this machine; Remote Desktop will capture \
                 with gdigrab instead (lower frame rate, but it produces a picture)"
            );
        }
        ok
    })
}

/// Return the ffmpeg `-vcodec <name>` argument bundle for low-latency
/// streaming with the chosen encoder. Each hardware encoder has its own
/// flag dialect; this is the single place that knows them all.
///
/// All variants share the same intent: real-time, low-delay, single-slice,
/// frequent keyframes, no B-frames. The encoder-specific flags below have
/// been chosen from each vendor's tuning guide.
pub fn encoder_args(encoder: &str) -> Vec<&'static str> {
    // EVERY encoder in this match MUST emit SPS/PPS before every IDR.
    // Without that, a dashboard joining mid-stream (i.e. every Remote
    // session — the receiver always joins AFTER the encoder is running)
    // never sees the codec extradata and the H.264 decoder silently
    // refuses to draw a frame. The customer sees a perfectly Live
    // connection with a black rectangle. `-bsf:v dump_extra` injects
    // the encoder's extradata before every IDR regardless of which
    // encoder produced it, so it's the safe lowest common denominator
    // across VT / NVENC / QSV / AMF / VAAPI / libx264.
    //
    // Profile choice: MAIN @ level 4.0 (v0.6.8+). Was `baseline` until
    // v0.6.7 — that broke as soon as v0.6.6 bumped the encode target
    // from 960 to 1920 wide. H.264 Baseline is capped at Level 3.1
    // (1280×720 @ 30fps); at 1080p the encoder either downgraded
    // silently to a level Chrome rejects or emitted level 4.0
    // bitstream mismatching the SDP-negotiated profile-level-id, so
    // Chrome received bytes but produced zero decoded frames. Main @
    // Level 4.0 is spec-clean for 1080p30, universally supported by
    // Chrome / Firefox / Safari WebRTC decoders, and still keeps
    // `-bf 0` so we retain the zero-latency contract (no B-frames).
    match encoder {
        "h264_videotoolbox" => vec![
            "-vcodec", "h264_videotoolbox",
            "-realtime", "1",        // VT-specific: skip quality re-encodes
            "-allow_sw", "1",        // graceful fall-back if HW path is busy
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            // NOTE: ffmpeg 9.0+ h264_videotoolbox rejects `-level 4.0` with
            // "Cannot prepare encoder: -12902" — the level was previously
            // needed to keep Baseline<3.1 encoders honest at 1080p, but on
            // `main` profile VideoToolbox picks a spec-clean level (4.0
            // for 1920×1080@30 with our bitrate) without help. Do not
            // re-add the explicit -level here.
            "-g", "15",
            "-bf", "0",              // no B-frames — keep zero-latency contract
            "-bsf:v", "dump_extra",  // SPS/PPS before every IDR
        ],
        "h264_nvenc" => vec![
            "-vcodec", "h264_nvenc",
            "-preset", "p1",         // p1 = lowest latency, p7 = best quality
            "-tune", "ll",           // low-latency tune
            "-rc", "cbr",            // constant-bitrate so REMB throttle works
            "-zerolatency", "1",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-level", "4.0",
            "-g", "15",
            "-bf", "0",
            "-bsf:v", "dump_extra",
        ],
        "h264_qsv" => vec![
            "-vcodec", "h264_qsv",
            "-preset", "veryfast",
            "-async_depth", "1",     // single-frame pipeline = lowest delay
            "-pix_fmt", "nv12",      // QSV's native fmt; saves a copy
            "-profile:v", "main",
            "-level", "4.0",
            "-g", "15",
            "-bf", "0",
            "-bsf:v", "dump_extra",
        ],
        "h264_amf" => vec![
            "-vcodec", "h264_amf",
            "-usage", "lowlatency",
            "-quality", "speed",
            "-rc", "cbr",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-level", "4.0",
            "-g", "15",
            "-bf", "0",
            "-bsf:v", "dump_extra",
        ],
        "h264_mf" => vec![
            "-vcodec", "h264_mf",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-level", "4.0",
            "-g", "15",
            "-bsf:v", "dump_extra",
        ],
        "h264_vaapi" => vec![
            "-vcodec", "h264_vaapi",
            "-qp", "23",
            "-profile:v", "main",
            "-level", "4.0",
            "-bf", "0",
            "-g", "15",
            "-bsf:v", "dump_extra",
        ],
        _ => vec![
            "-vcodec", "libx264",
            "-tune", "zerolatency",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-level", "4.0",
            "-g", "15",
            "-keyint_min", "15",
            "-x264opts", "repeat-headers=1:slices=1:sliced-threads=0",
            "-threads", "1",
            "-bsf:v", "dump_extra",
        ],
    }
}

/// Synchronous lookup of an already-present ffmpeg (bundled, cached, or on
/// PATH). Skips the download path so it can be called from blocking contexts
/// like screenshot capture. Returns None if none of the known locations have
/// a working binary — callers should fall back to the async ensure_ffmpeg.
pub fn locate_ffmpeg() -> Option<PathBuf> {
    for candidate in bundled_paths() {
        if candidate.exists() && works(&candidate) {
            return Some(candidate);
        }
    }
    if let Ok(cached) = cache_path() {
        if cached.exists() && works(&cached) {
            return Some(cached);
        }
    }
    let system = PathBuf::from(BIN_NAME);
    if works(&system) {
        return Some(system);
    }
    None
}

/// Return a path to a working ffmpeg, preferring the binary shipped inside
/// the app bundle so macOS TCC inherits the parent's Screen Recording grant.
pub async fn ensure_ffmpeg() -> Result<PathBuf> {
    for candidate in bundled_paths() {
        if candidate.exists() && works(&candidate) {
            log::info!("using bundled ffmpeg at {:?}", candidate);
            return Ok(candidate);
        }
    }

    let cached = cache_path()?;
    if cached.exists() && works(&cached) {
        log::info!("using cached ffmpeg at {:?}", cached);
        return Ok(cached);
    }

    let system = PathBuf::from(BIN_NAME);
    if works(&system) {
        log::info!("using system ffmpeg on PATH");
        return Ok(system);
    }

    log::info!("ffmpeg not present, downloading from {FFMPEG_URL}");
    download_to(&cached).await?;
    if !works(&cached) {
        let _ = std::fs::remove_file(&cached);
        return Err(anyhow!("downloaded ffmpeg did not execute successfully"));
    }
    log::info!("ffmpeg cached at {:?}", cached);
    Ok(cached)
}

async fn download_to(dest: &PathBuf) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .context("building http client")?;

    let resp = client
        .get(FFMPEG_URL)
        .send()
        .await
        .with_context(|| format!("GET {FFMPEG_URL}"))?
        .error_for_status()
        .with_context(|| format!("non-2xx from {FFMPEG_URL}"))?;

    let bytes = resp.bytes().await.context("reading ffmpeg body")?;
    if bytes.len() < 1_000_000 {
        return Err(anyhow!(
            "ffmpeg download suspiciously small ({} bytes) — likely an error page",
            bytes.len()
        ));
    }

    // Integrity check (audit H9). Compute the SHA-256 of what we downloaded and,
    // if a hash was pinned at build time, REFUSE to install anything else — so a
    // tampered storage bucket cannot deliver malicious code to run on the
    // employee's machine. If unpinned, log the hash + a warning rather than
    // silently trusting the download.
    let digest = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(&bytes);
        hex::encode(h.finalize())
    };
    if !EXPECTED_FFMPEG_SHA256.is_empty() {
        if !digest.eq_ignore_ascii_case(EXPECTED_FFMPEG_SHA256) {
            return Err(anyhow!(
                "ffmpeg checksum mismatch — refusing to install. got {digest}, expected {EXPECTED_FFMPEG_SHA256}"
            ));
        }
    } else {
        log::warn!(
            "ffmpeg downloaded from {FFMPEG_URL} with NO pinned checksum \
             (RUDRANS_FFMPEG_SHA256 unset). Set it for release builds so a \
             compromised bucket cannot deliver malicious code. sha256={digest}"
        );
    }

    // Write to a tmp sibling and atomically rename so a partial download never gets cached.
    let tmp = dest.with_extension("partial");
    std::fs::write(&tmp, &bytes).with_context(|| format!("writing {:?}", tmp))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tmp, perms)?;
    }

    std::fs::rename(&tmp, dest).with_context(|| format!("renaming to {:?}", dest))?;
    Ok(())
}
