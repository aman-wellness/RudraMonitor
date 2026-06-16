// Org-wide wallpaper enforcement. The admin uploads an image in the dashboard
// (Org Settings → Wallpaper); the agent picks up the URL via its
// agent-settings poll and replaces the desktop wallpaper on every agent that
// has `wallpaper_enforced = true`.
//
// **Idempotence**: we cache the last-applied `wallpaper_updated_at` (RFC3339
// string) in a tiny JSON file in the agent's data dir. A new tick re-applies
// only when the server's timestamp is strictly newer than what we cached. So
// rebooting an agent doesn't re-download or re-set the wallpaper on every
// startup.
//
// **OS apply**:
//   - macOS: `osascript -e 'tell application "System Events" to tell every
//     desktop to set picture to POSIX file "<path>"'` — covers all monitors.
//   - Windows: `reg add HKCU\Control Panel\Desktop /v Wallpaper ...` + a
//     RUNDLL32 call that re-reads the per-user system parameters so the
//     change takes effect without a logout.
//   - Linux: best-effort `gsettings` for GNOME / `feh` fallback. Not the main
//     target for v0.3.0; harmless if it errors.
//
// The downloaded image lives at <cache_dir>/org-wallpaper.<ext> so the agent
// keeps a single canonical copy regardless of how many times the admin
// changes it. The Reqwest client is the same one already used for screenshot
// uploads (build_client() in api.rs).

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

use crate::api;

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
struct WallpaperState {
    /// RFC3339 timestamp the agent has already applied. None = nothing applied yet.
    last_applied_at: Option<String>,
    /// Filesystem path of the image we wrote on the last successful apply.
    /// Used so the apply step knows what to point the OS at without
    /// re-downloading when only the cache-on-disk got nuked.
    last_path: Option<String>,
}

pub struct WallpaperManager {
    state: WallpaperState,
    state_path: PathBuf,
    /// Local cache filename (without extension); we append .jpg or .png based
    /// on what the server sent so the OS picks the right decoder.
    image_dir: PathBuf,
}

impl WallpaperManager {
    pub fn new() -> Self {
        let base = state_dir();
        let _ = std::fs::create_dir_all(&base);
        let state_path = base.join("wallpaper-state.json");
        let state = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|s| serde_json::from_str::<WallpaperState>(&s).ok())
            .unwrap_or_default();
        Self { state, state_path, image_dir: base }
    }

    /// One iteration. No-op when there's nothing to do (policy off, no URL,
    /// or we've already applied this version).
    pub async fn tick(
        &mut self,
        enforced: bool,
        url: Option<&str>,
        updated_at: Option<&str>,
    ) -> Result<()> {
        if !enforced { return Ok(()); }
        let url = match url {
            Some(u) if !u.is_empty() => u,
            _ => return Ok(()),
        };
        let updated_at = match updated_at {
            Some(u) if !u.is_empty() => u,
            _ => return Ok(()),
        };

        // Already applied this version? Skip.
        if self.state.last_applied_at.as_deref() == Some(updated_at) {
            // Re-apply only if the cached file disappeared (cache cleared by
            // user). Cheap to check.
            if let Some(p) = self.state.last_path.as_deref() {
                if std::path::Path::new(p).exists() {
                    return Ok(());
                }
            }
        }

        // Download. Reuse the same client builder as the rest of the agent so
        // it inherits the right TLS roots + user agent.
        let client = api::build_client().context("wallpaper: build_client")?;
        let resp = client.get(url).send().await.context("wallpaper: GET")?;
        if !resp.status().is_success() {
            return Err(anyhow!(
                "wallpaper: server returned http_status={}",
                resp.status().as_u16()
            ));
        }
        let ext = if url.to_lowercase().ends_with(".png") { "png" } else { "jpg" };
        let dest = self.image_dir.join(format!("org-wallpaper.{ext}"));
        let bytes = resp.bytes().await.context("wallpaper: read body")?;
        if bytes.len() < 1024 {
            return Err(anyhow!("wallpaper: server returned suspiciously small body ({} bytes)", bytes.len()));
        }
        let mut f = tokio::fs::File::create(&dest).await.context("wallpaper: create file")?;
        f.write_all(&bytes).await.context("wallpaper: write file")?;
        f.flush().await.ok();
        drop(f);

        apply_wallpaper(&dest)?;

        self.state.last_applied_at = Some(updated_at.to_string());
        self.state.last_path = Some(dest.to_string_lossy().to_string());
        let _ = std::fs::write(
            &self.state_path,
            serde_json::to_string_pretty(&self.state).unwrap_or_default(),
        );
        log::info!("wallpaper: applied {} (updated_at={updated_at})", dest.display());
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn apply_wallpaper(path: &std::path::Path) -> Result<()> {
    // `every desktop` covers all attached monitors. Quoting: we escape any
    // `"` in the path defensively, though our cache filename never contains
    // one.
    let p = path.to_string_lossy().replace('"', "\\\"");
    let script = format!(
        "tell application \"System Events\" to tell every desktop to set picture to POSIX file \"{}\"",
        p
    );
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .context("wallpaper: spawn osascript")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("osascript failed: {}", stderr.trim()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_wallpaper(path: &std::path::Path) -> Result<()> {
    // Two steps so the change persists across logout and takes effect now:
    //   1. Write the path into the registry so Windows uses it on next login.
    //   2. Trigger SystemParametersInfoW(SPI_SETDESKWALLPAPER, ...) so the
    //      desktop refreshes immediately.
    // The SystemParametersInfo call is the canonical way; we do it via the
    // windows-rs crate already in the agent's deps.
    let p = path.to_string_lossy().to_string();

    // Registry write — `reg add` is shell-friendly.
    let reg = std::process::Command::new("reg")
        .args([
            "add",
            "HKCU\\Control Panel\\Desktop",
            "/v", "Wallpaper",
            "/t", "REG_SZ",
            "/d", &p,
            "/f",
        ])
        .output()
        .context("wallpaper: spawn reg")?;
    if !reg.status.success() {
        log::warn!("wallpaper: reg add failed: {}", String::from_utf8_lossy(&reg.stderr));
    }

    // Live apply via WinAPI. SPI_SETDESKWALLPAPER = 0x0014, fWinIni flags
    // SPIF_UPDATEINIFILE | SPIF_SENDCHANGE = 0x03.
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_SETDESKWALLPAPER, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE,
    };
    let wide: Vec<u16> = p.encode_utf16().chain(std::iter::once(0)).collect();
    let pwstr = PCWSTR(wide.as_ptr());
    unsafe {
        let ok = SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            Some(pwstr.0 as *mut _),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        );
        if ok.is_err() {
            return Err(anyhow!("SystemParametersInfoW(SPI_SETDESKWALLPAPER) failed"));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_wallpaper(path: &std::path::Path) -> Result<()> {
    // Try GNOME first (covers Ubuntu / Pop / Fedora Workstation). gsettings
    // is the canonical GNOME 3+ command and is silent-success when the schema
    // doesn't exist (KDE / XFCE), so we shrug and move on.
    let uri = format!("file://{}", path.to_string_lossy());
    let _ = std::process::Command::new("gsettings")
        .args(["set", "org.gnome.desktop.background", "picture-uri", &uri])
        .status();
    let _ = std::process::Command::new("gsettings")
        .args(["set", "org.gnome.desktop.background", "picture-uri-dark", &uri])
        .status();
    Ok(())
}

#[cfg(target_os = "macos")]
fn state_dir() -> PathBuf {
    dirs::cache_dir()
        .map(|d| d.join("com.rudrans.agent"))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[cfg(target_os = "windows")]
fn state_dir() -> PathBuf {
    dirs::data_local_dir()
        .map(|d| d.join("com.wellnessextract.agent"))
        .unwrap_or_else(|| PathBuf::from("C:\\Temp"))
}

#[cfg(target_os = "linux")]
fn state_dir() -> PathBuf {
    dirs::cache_dir()
        .map(|d| d.join("com.rudrans.agent"))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}
