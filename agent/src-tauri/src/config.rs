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

/// Read the optional pre-fill file dropped by the personalized launcher script
/// (Install-<Name>.command / .bat / .sh). When present, the UI hides the agent
/// name input and only asks the employee for the license key.
///
/// File location matches the launcher scripts:
///   macOS:   ~/Library/Application Support/RudransAgent/prefill.json
///   Windows: %APPDATA%/RudransAgent/prefill.json
///   Linux:   ~/.local/share/RudransAgent/prefill.json
/// All map to `dirs::data_dir()/RudransAgent/prefill.json`.
pub fn read_prefill_name() -> Option<String> {
    let base = dirs::data_dir()?;
    let path = base.join("RudransAgent").join("prefill.json");
    if !path.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let name = v.get("agent_name")?.as_str()?.trim().to_string();
    if name.is_empty() { None } else { Some(name) }
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
    None => "https://api.rudrans.com",
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
