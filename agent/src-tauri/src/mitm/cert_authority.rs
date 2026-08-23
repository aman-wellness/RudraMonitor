//! Loads the bundled Wellness Extract Root CA + private key.
//!
//! The public cert is bundled as a file resource
//! (`agent/src-tauri/resources/mitm-ca.crt`). The private key is NEVER
//! written to disk on the endpoint — it's compiled into the binary as
//! a build-time constant from the `WELLNESS_MITM_CA_KEY_PEM` env var
//! that CI sets from a GitHub Actions secret.
//!
//! Phase 3 uses this only to fail-fast if the build lost the key
//! (returned as `Ok(None)` → the proxy runs in passthrough-only mode).
//! Phase 4 wires actual leaf-cert minting via `rcgen::Certificate`
//! signed by this key.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};

/// A loaded CA identity: the DER-encoded cert (for exposing to leaf-
/// signing) plus the private key bytes ready to feed rustls.
#[allow(dead_code)]
pub struct BundledCa {
    pub cert_pem: String,
    pub key_pem: String,
}

/// The private key as embedded at build time. Empty when the env var
/// wasn't set (local `cargo build` or a CI job that isn't the
/// tagged-release workflow). `option_env!` keeps the code compiling
/// without the secret so devs don't need it.
const BUILD_KEY_PEM: Option<&'static str> = option_env!("WELLNESS_MITM_CA_KEY_PEM");

/// Load the bundled CA. Returns:
/// - `Ok(Some(ca))` when both the public cert on disk AND the compiled
///   private key are present.
/// - `Ok(None)` when the private key wasn't embedded — dev / pre-v0.7.0
///   builds. The caller downgrades to passthrough-only.
/// - `Err(_)` when the cert file is missing or unreadable — that means
///   the resource shipped broken, and we want that surfaced loudly.
pub fn load_bundled() -> Result<Option<BundledCa>> {
    let key_pem = match BUILD_KEY_PEM {
        Some(k) if !k.trim().is_empty() => k.to_string(),
        _ => return Ok(None),
    };

    // resources/mitm-ca.crt sits alongside the same folder that houses
    // ffmpeg — reuse the resolver from ffmpeg.rs so we hit exactly the
    // paths Tauri 2 uses across all three platforms.
    let cert_path = find_bundled_cert()?;
    let cert_pem = std::fs::read_to_string(&cert_path)
        .with_context(|| format!("reading CA cert at {:?}", cert_path))?;

    if !cert_pem.contains("BEGIN CERTIFICATE") {
        return Err(anyhow!("CA cert file at {:?} is not PEM", cert_path));
    }
    if !key_pem.contains("BEGIN") {
        return Err(anyhow!("WELLNESS_MITM_CA_KEY_PEM did not decode to PEM"));
    }

    Ok(Some(BundledCa { cert_pem, key_pem }))
}

/// Locate `mitm-ca.crt` in whichever Tauri resource layout the build
/// used. Mirrors `ffmpeg::bundled_paths()`.
fn find_bundled_cert() -> Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            #[cfg(target_os = "macos")]
            {
                if let Some(contents) = exe_dir.parent() {
                    candidates.push(
                        contents.join("Resources").join("resources").join("mitm-ca.crt"),
                    );
                    candidates.push(contents.join("Resources").join("mitm-ca.crt"));
                    candidates.push(
                        contents.join("Resources").join("_up_").join("resources").join("mitm-ca.crt"),
                    );
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                candidates.push(exe_dir.join("resources").join("mitm-ca.crt"));
                candidates.push(exe_dir.join("mitm-ca.crt"));
            }
        }
    }
    for p in &candidates {
        if p.exists() {
            return Ok(p.clone());
        }
    }
    Err(anyhow!(
        "mitm-ca.crt not found in any of the expected paths: {:?}",
        candidates
    ))
}
