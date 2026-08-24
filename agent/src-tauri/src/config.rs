// Persisted on-disk agent configuration:
//   - Supabase project URL + anon key (compiled-in defaults can be overridden by env var)
//   - The agent's enrollment record after first successful /enroll-agent call.
//
// Stored as JSON in the OS user data dir under "RudransAgent/agent.json".

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentConfig {
    pub supabase_url: Option<String>,
    pub supabase_anon_key: Option<String>,
    pub enrollment: Option<Enrollment>,
    /// License key entered at setup. If present, the agent revalidates it
    /// periodically and stops capturing if it becomes invalid/expired.
    pub license_key: Option<String>,
    /// Public key of the RustDesk hbbs relay this agent should trust. Only set
    /// when pointing the agent at a relay other than the production one — a
    /// self-hosted staging relay, or a local one for development. See
    /// `hbbs_pubkey` for precedence.
    #[serde(default)]
    pub hbbs_pubkey: Option<String>,
    /// Local acknowledgement that the Email DLP MITM proxy is enabled
    /// on THIS endpoint. Even when the server-side flags all say "start
    /// the proxy", the agent won't set a system-wide proxy or install
    /// a TLS interception path until this is true. Flipped once from
    /// the first-run consent screen (or by an MDM push writing this
    /// field into agent.json before first launch) — never automatically.
    #[serde(default)]
    pub mitm_consent: bool,
    /// True once the operator has made an explicit choice (accept OR
    /// decline). Stops the consent screen from re-appearing on every
    /// launch after a decline. Admins can reset by editing agent.json.
    #[serde(default)]
    pub mitm_consent_answered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Enrollment {
    pub agent_id: String,
    pub enroll_token: String,
    pub agent_name: String,
    pub machine_name: String,
    pub org_id: String,
}

pub fn config_path() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("could not resolve OS data dir"))?;
    let dir = base.join("RudransAgent");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {:?}", dir))?;
    Ok(dir.join("agent.json"))
}

/// Pre-fill file that carries the org license key so the agent enrols itself
/// on first boot with NO input from the employee (zero-touch).
///
/// The key is stamped into the ONE shared installer at download time (from the
/// Agent Setup page) so nothing identifying ever appears in the filename:
///   Windows — the download appends a `{{WEZT-LICENSE}}<key>{{/WEZT-LICENSE}}`
///             footer to the installer's bytes; the NSIS hook copies the whole
///             installer to `enroll.dat` next to the exe, and we parse the key
///             out of its tail here (see `read_footer_key`).
///   macOS   — the download appends the same footer to the .pkg; the postinstall
///             extracts it and writes `prefill.json` next to the exe.
/// So we look, in priority order:
///   0. `<install dir>/enroll.dat`      — the Windows footer copy;
///   1. `<install dir>/prefill.json`    — macOS (and any MDM-pushed) prefill;
///   2. `dirs::data_dir()/RudransAgent/prefill.json` — legacy per-user path.
/// The agent deletes all of these once enrolment succeeds (`consume_prefill`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Prefill {
    /// Org license key embedded by the installer. When present the agent
    /// enrolls automatically (see `lib.rs` first-boot auto-enroll).
    #[serde(default)]
    pub license_key: Option<String>,
    /// Optional display name. Usually omitted so the agent falls back to the
    /// machine hostname.
    #[serde(default)]
    pub agent_name: Option<String>,
}

/// Markers the download page wraps the license key in when it appends a footer
/// to the shared installer's bytes. Kept ASCII so the browser, NSIS, Rust and
/// the macOS shell all agree on them byte-for-byte.
const ZT_START: &[u8] = b"{{WEZT-LICENSE}}";
const ZT_END: &[u8] = b"{{/WEZT-LICENSE}}";

/// `<install dir>/enroll.dat` — the copy of the stamped installer the NSIS hook
/// drops so we can read the license footer after the download is long gone.
fn enroll_dat_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("enroll.dat"))
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Pull the license key out of an installer's appended footer. Pure over bytes
/// so it's unit-testable; only the tail is scanned to stay cheap on a ~25 MB
/// installer copy.
fn parse_footer_key(data: &[u8]) -> Option<String> {
    let tail = if data.len() > 65_536 {
        &data[data.len() - 65_536..]
    } else {
        data
    };
    let start = find_sub(tail, ZT_START)? + ZT_START.len();
    let end = find_sub(&tail[start..], ZT_END)?;
    let key = std::str::from_utf8(&tail[start..start + end])
        .ok()?
        .trim()
        .to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

fn read_footer_key(path: &std::path::Path) -> Option<String> {
    parse_footer_key(&std::fs::read(path).ok()?)
}

/// All candidate prefill locations, highest priority first.
fn prefill_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // 1. Next to the installed executable (written by the elevated installer).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("prefill.json"));
        }
    }
    // 2. Legacy per-user data dir.
    if let Some(base) = dirs::data_dir() {
        paths.push(base.join("RudransAgent").join("prefill.json"));
    }
    paths
}

pub fn read_prefill() -> Option<Prefill> {
    // 0. Windows zero-touch: license footer in the installer copy (enroll.dat).
    //    No agent_name → auto-enroll falls back to the machine hostname.
    if let Some(dat) = enroll_dat_path() {
        if dat.exists() {
            if let Some(key) = read_footer_key(&dat) {
                return Some(Prefill {
                    license_key: Some(key),
                    agent_name: None,
                });
            }
        }
    }
    for path in prefill_paths() {
        if !path.exists() {
            continue;
        }
        if let Ok(raw) = std::fs::read_to_string(&path) {
            // Trim a possible UTF-8 BOM some editors prepend, which would
            // otherwise make serde_json reject the first `{`.
            let raw = raw.trim_start_matches('\u{feff}');
            if let Ok(p) = serde_json::from_str::<Prefill>(raw) {
                return Some(p);
            }
        }
    }
    None
}

/// Convenience: the embedded name if any (used by the setup UI to pre-fill the
/// name field on the manual path).
pub fn read_prefill_name() -> Option<String> {
    read_prefill()
        .and_then(|p| p.agent_name)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// After successful enrollment the prefill is no longer needed; remove it from
/// every candidate location so it isn't re-consumed on a later launch. The
/// install-dir copy may fail to delete if the agent isn't elevated — harmless,
/// because first-boot auto-enroll short-circuits once `enrollment` is set.
pub fn consume_prefill() {
    if let Some(dat) = enroll_dat_path() {
        let _ = std::fs::remove_file(&dat);
    }
    for path in prefill_paths() {
        let _ = std::fs::remove_file(&path);
    }
}

pub fn load() -> Result<AgentConfig> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AgentConfig::default());
    }
    let raw = std::fs::read_to_string(&path).with_context(|| format!("reading {:?}", path))?;
    let cfg: AgentConfig = serde_json::from_str(&raw).context("parsing agent.json")?;
    Ok(cfg)
}

pub fn save(cfg: &AgentConfig) -> Result<()> {
    let path = config_path()?;
    let raw = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&path, raw).with_context(|| format!("writing {:?}", path))?;
    Ok(())
}

// Compile-time embedded Supabase credentials. Bake the org's production project so
// employees never see a setup screen — just license key + agent name on first launch.
// To override per-build, set RUDRANS_SUPABASE_URL / _ANON_KEY at compile time.
const EMBEDDED_SUPABASE_URL: &str = match option_env!("RUDRANS_SUPABASE_URL") {
    Some(v) => v,
    None => "https://api-ems.wellnessextract.com",
};
const EMBEDDED_SUPABASE_ANON_KEY: &str = match option_env!("RUDRANS_SUPABASE_ANON_KEY") {
    Some(v) => v,
    None => "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc4NTUyOTU5LCJleHAiOjIwOTM5MTI5NTl9.kKjcCGveLa8gnkBcTFLBkTHZsn5II1AvQDpoKLXHFS0",
};

/// Effective Supabase URL — runtime env var first, then on-disk override, then compiled-in default.
pub fn supabase_url(cfg: &AgentConfig) -> Option<String> {
    std::env::var("RUDRANS_SUPABASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg.supabase_url.clone())
        .or_else(|| Some(EMBEDDED_SUPABASE_URL.to_string()))
}

pub fn supabase_anon_key(cfg: &AgentConfig) -> Option<String> {
    std::env::var("RUDRANS_SUPABASE_ANON_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg.supabase_anon_key.clone())
        .or_else(|| Some(EMBEDDED_SUPABASE_ANON_KEY.to_string()))
}

/// Public key of the RustDesk hbbs relay, pinned into RustDesk2.toml so the
/// client refuses to talk to a rogue relay impersonating ours.
///
/// hbbs generates its own ed25519 keypair on first boot, so this value is
/// per-deployment: the production key below is wrong for any self-hosted or
/// local relay, and a mismatch makes RustDesk reject the server as untrusted.
/// It used to be a bare `const` inside rustdesk_host, which meant pointing the
/// agent at any other relay required editing source and rebuilding.
const EMBEDDED_HBBS_PUBKEY: &str = match option_env!("RUDRANS_HBBS_PUBKEY") {
    Some(v) => v,
    // Production hbbs at api-ems.wellnessextract.com, auto-generated by the
    // rustdesk-server image on first boot.
    None => "N9YabDaxaMGLRZe0ImMg7A+erwbHnklEQeQviQA+E7s=",
};

pub fn mitm_consent(cfg: &AgentConfig) -> bool {
    // Environment override for MDM-pushed installs where consent is
    // recorded via a Group Policy / mobileconfig, not a first-run
    // click. `WELLNESS_MITM_CONSENT=1` at agent-launch time counts as
    // explicit consent even without the on-disk flag set.
    if std::env::var("WELLNESS_MITM_CONSENT")
        .ok()
        .as_deref()
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        return true;
    }
    cfg.mitm_consent
}

pub fn hbbs_pubkey(cfg: &AgentConfig) -> String {
    std::env::var("RUDRANS_HBBS_PUBKEY")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg.hbbs_pubkey.clone().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| EMBEDDED_HBBS_PUBKEY.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The zero-touch launcher writes {"license_key": ...}; the older launcher
    // wrote {"agent_name": ...}. Both must parse, and each field is optional.
    #[test]
    fn prefill_parses_key_and_optional_name() {
        let key_only: Prefill = serde_json::from_str(r#"{"license_key":"ABC-123"}"#).unwrap();
        assert_eq!(key_only.license_key.as_deref(), Some("ABC-123"));
        assert_eq!(key_only.agent_name, None);

        let both: Prefill = serde_json::from_str(r#"{"license_key":"K","agent_name":"Rahul"}"#).unwrap();
        assert_eq!(both.license_key.as_deref(), Some("K"));
        assert_eq!(both.agent_name.as_deref(), Some("Rahul"));

        // Legacy name-only prefill: no key, so the agent falls back to the
        // manual setup screen rather than auto-enrolling.
        let legacy: Prefill = serde_json::from_str(r#"{"agent_name":"Old"}"#).unwrap();
        assert_eq!(legacy.license_key, None);
        assert_eq!(legacy.agent_name.as_deref(), Some("Old"));
    }

    // The download appends the key footer to the END of the installer's raw
    // bytes (after arbitrary binary), and we must recover it from the tail.
    #[test]
    fn footer_key_extracted_from_installer_tail() {
        let mut blob = vec![0u8, 1, 2, 255, 0, 13, 10]; // fake binary payload
        blob.extend_from_slice(b"\n{{WEZT-LICENSE}}WE-ACME-9931{{/WEZT-LICENSE}}\n");
        assert_eq!(parse_footer_key(&blob).as_deref(), Some("WE-ACME-9931"));

        // Surrounding whitespace inside the markers is trimmed.
        let padded = b"xx{{WEZT-LICENSE}}  KEY-42  {{/WEZT-LICENSE}}".to_vec();
        assert_eq!(parse_footer_key(&padded).as_deref(), Some("KEY-42"));

        // No footer (plain/unstamped installer) → no key → manual setup screen.
        assert_eq!(parse_footer_key(&[0u8; 32]), None);
        assert_eq!(parse_footer_key(b"{{WEZT-LICENSE}}{{/WEZT-LICENSE}}"), None);
    }
}
