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

/// Pre-fill file dropped by the setup-page launcher script
/// (Install-<Name>.command / .bat / .sh) BEFORE the installer runs. It lets an
/// admin ship a zero-touch install: the launcher embeds the org's license key
/// (and optionally a name) so the agent enrolls itself on first boot with no
/// input from the employee.
///
/// File location (must match the launcher scripts):
///   macOS:   ~/Library/Application Support/RudransAgent/prefill.json
///   Windows: %APPDATA%/RudransAgent/prefill.json
///   Linux:   ~/.local/share/RudransAgent/prefill.json
/// All map to `dirs::data_dir()/RudransAgent/prefill.json`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Prefill {
    /// Org license key embedded by the setup page. When present the agent
    /// enrolls automatically (see `lib.rs` first-boot auto-enroll).
    #[serde(default)]
    pub license_key: Option<String>,
    /// Optional display name. Usually omitted so the agent falls back to the
    /// machine hostname.
    #[serde(default)]
    pub agent_name: Option<String>,
}

fn prefill_path() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("RudransAgent").join("prefill.json"))
}

pub fn read_prefill() -> Option<Prefill> {
    let path = prefill_path()?;
    if !path.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<Prefill>(&raw).ok()
}

/// Convenience: the embedded name if any (used by the setup UI to pre-fill the
/// name field on the manual path).
pub fn read_prefill_name() -> Option<String> {
    read_prefill()
        .and_then(|p| p.agent_name)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// After successful enrollment the prefill file is no longer needed; remove it
/// so it isn't confused with a fresh registration on subsequent launches.
pub fn consume_prefill() {
    if let Some(base) = dirs::data_dir() {
        let _ = std::fs::remove_file(base.join("RudransAgent").join("prefill.json"));
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
}
