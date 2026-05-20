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
const FFMPEG_URL: &str = "https://api.rudrans.com/storage/v1/object/public/ffmpeg/ffmpeg-windows-x64.exe";
#[cfg(target_os = "macos")]
const FFMPEG_URL: &str = "https://api.rudrans.com/storage/v1/object/public/ffmpeg/ffmpeg-macos-universal";
#[cfg(target_os = "linux")]
const FFMPEG_URL: &str = "https://api.rudrans.com/storage/v1/object/public/ffmpeg/ffmpeg-linux-x64";

#[cfg(target_os = "windows")]
const BIN_NAME: &str = "ffmpeg.exe";
#[cfg(not(target_os = "windows"))]
const BIN_NAME: &str = "ffmpeg";

fn cache_path() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("could not resolve OS data dir"))?;
    let dir = base.join("RudransAgent").join("bin");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {:?}", dir))?;
    Ok(dir.join(BIN_NAME))
}

/// Where Tauri drops `bundle.resources` per platform. The agent runs as
/// `<bundle>/Contents/MacOS/rudrans-agent` on macOS, so resources sit one
/// dir up under Contents/Resources/. Windows and Linux Tauri builds keep
/// the resources sibling to the executable.
fn bundled_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            #[cfg(target_os = "macos")]
            {
                // /Applications/Rudrans Agent.app/Contents/MacOS/rudrans-agent
                //   → ../Resources/ffmpeg
                if let Some(contents) = exe_dir.parent() {
                    out.push(contents.join("Resources").join(BIN_NAME));
                    // Tauri 2 sometimes nests under _up_/ — try both.
                    out.push(contents.join("Resources").join("_up_").join("resources").join(BIN_NAME));
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                // Windows MSI: <install>\rudrans-agent.exe   ←→ <install>\resources\ffmpeg.exe
                // Linux deb:    /usr/bin/rudrans-agent       ←→ /usr/lib/.../resources/ffmpeg
                // Tauri also drops a sibling resources/ dir.
                out.push(exe_dir.join("resources").join(BIN_NAME));
                out.push(exe_dir.join(BIN_NAME));
            }
        }
    }
    out
}

fn works(path: &PathBuf) -> bool {
    Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
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
