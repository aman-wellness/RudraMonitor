// Self-contained ffmpeg provisioning.
//
// Employee laptops virtually never have ffmpeg on PATH (especially Windows/macOS),
// which silently disabled video recording on every deployed agent. Instead of asking
// the customer to push ffmpeg out via MDM, the agent downloads a static binary on
// first need and caches it under the OS user-data dir. Subsequent ticks reuse the
// cached copy.
//
// Binaries are hosted on the Rudrans Supabase Storage `ffmpeg` public bucket. Each
// build is a single, statically linked executable (no shared libs, no installer).

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

fn works(path: &PathBuf) -> bool {
    Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Return a path to a working ffmpeg. Order of preference:
///   1. Cached copy in app data dir (downloaded previously).
///   2. System `ffmpeg` on PATH (lets advanced users override with a custom build).
///   3. Fresh download from Supabase Storage.
pub async fn ensure_ffmpeg() -> Result<PathBuf> {
    let cached = cache_path()?;
    if cached.exists() && works(&cached) {
        return Ok(cached);
    }

    // Fall back to system ffmpeg if the user happens to have one installed.
    let system = PathBuf::from(BIN_NAME);
    if works(&system) {
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
