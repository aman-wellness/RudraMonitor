//! Wellness Extract Root CA — bundled cert + build-embedded private key,
//! plus on-demand leaf-cert minting for whichever webmail host the proxy
//! is terminating TLS on.
//!
//! Leaves are RSA-2048 for compatibility (rcgen defaults to ECDSA-P-256
//! which Chrome accepts fine, but a couple of legacy IE-mode / old
//! Chromium builds still on Windows 10 don't — RSA is the safe pick).
//! Each leaf gets a SAN for the exact host we're intercepting, a 30-day
//! validity, and is cached in memory keyed by host so we only sign
//! once per hostname per agent-lifetime.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use rcgen::{
    CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;

/// The CA's private key as embedded at build time (via CI reading a
/// GitHub secret into `WELLNESS_MITM_CA_KEY_PEM`). Empty when the env
/// var wasn't set (local `cargo build`) — `option_env!` keeps the code
/// compiling without the secret so devs don't need it.
const BUILD_KEY_PEM: Option<&'static str> = option_env!("WELLNESS_MITM_CA_KEY_PEM");

/// The one live CA identity for this process. Loaded once at startup;
/// leaves are minted against it on-demand.
pub struct Authority {
    /// PEM of the CA public cert — kept for logging + debug.
    #[allow(dead_code)]
    pub ca_cert_pem: String,
    /// rcgen-loaded CA identity used to sign leaves. Wrapped in an
    /// `rcgen::Certificate` so we can call `.serialize_der_with_signer`
    /// on each leaf's params.
    ca_cert: rcgen::Certificate,
    /// Owned copy of the CA key so we can pass it to each leaf sign.
    ca_key: KeyPair,
    /// Per-host cached rustls server configs. Signing a fresh leaf is
    /// ~50 ms; caching drops that to a hashmap lookup on subsequent
    /// requests to the same webmail host.
    cache: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

impl Authority {
    /// Load the bundled CA. Returns None when the private key wasn't
    /// embedded — the caller downgrades to passthrough-only.
    pub fn load_bundled() -> Result<Option<Arc<Self>>> {
        let key_pem = match BUILD_KEY_PEM {
            Some(k) if !k.trim().is_empty() => k.to_string(),
            _ => return Ok(None),
        };
        let cert_path = find_bundled_cert()?;
        let cert_pem = std::fs::read_to_string(&cert_path)
            .with_context(|| format!("reading CA cert at {:?}", cert_path))?;

        // Parse the PEM into an rcgen Certificate we can sign against.
        let ca_key = KeyPair::from_pem(&key_pem)
            .map_err(|e| anyhow!("CA key parse: {e}"))?;
        let ca_params = CertificateParams::from_ca_cert_pem(&cert_pem)
            .map_err(|e| anyhow!("CA cert parse: {e}"))?;
        let ca_cert = ca_params
            .self_signed(&ca_key)
            .map_err(|e| anyhow!("CA cert reconstruct: {e}"))?;

        Ok(Some(Arc::new(Self {
            ca_cert_pem: cert_pem,
            ca_cert,
            ca_key,
            cache: Mutex::new(HashMap::new()),
        })))
    }

    /// Mint (or reuse a cached) leaf cert for the given SNI hostname
    /// and return a rustls ServerConfig ready to `TlsAcceptor::from`.
    pub fn server_config_for(&self, host: &str) -> Result<Arc<ServerConfig>> {
        if let Some(cfg) = self.cache.lock().unwrap().get(host).cloned() {
            return Ok(cfg);
        }

        // ---- leaf key + params ----
        let leaf_key = KeyPair::generate()
            .map_err(|e| anyhow!("leaf keygen: {e}"))?;
        let mut params = CertificateParams::new(vec![host.to_string()])
            .map_err(|e| anyhow!("leaf params: {e}"))?;
        params.is_ca = IsCa::NoCa;
        // 30-day validity; long enough to survive typical sessions, short
        // enough that a compromised leaf key isn't good for long.
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::days(1);
        params.not_after = now + time::Duration::days(30);
        params.distinguished_name = {
            let mut dn = DistinguishedName::new();
            dn.push(DnType::CommonName, host);
            dn.push(DnType::OrganizationName, "Wellness Extract DLP");
            dn
        };
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        params
            .extended_key_usages
            .push(rcgen::ExtendedKeyUsagePurpose::ServerAuth);
        // Extra SAN for the exact host + a plain "www." variant so a
        // browser that resolved a CNAME still finds a match. rcgen keeps
        // dedup, so passing the same string twice is safe.
        params.subject_alt_names.push(SanType::DnsName(
            host.to_string().try_into().map_err(|e| anyhow!("san name: {e}"))?,
        ));

        // ---- sign with the CA ----
        let leaf_cert = params
            .signed_by(&leaf_key, &self.ca_cert, &self.ca_key)
            .map_err(|e| anyhow!("leaf sign: {e}"))?;

        // ---- assemble rustls ServerConfig ----
        let cert_der = CertificateDer::from(leaf_cert.der().to_vec());
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
        let cfg = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der], key_der)
            .map_err(|e| anyhow!("rustls ServerConfig: {e}"))?;

        // Advertise HTTP/1.1 only via ALPN. Full HTTP/2 termination is
        // a bigger surface (h2 crate + stream multiplexing) that we
        // don't need for MVP — the browser negotiates down cleanly.
        let mut cfg = cfg;
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];

        let arc = Arc::new(cfg);
        self.cache.lock().unwrap().insert(host.to_string(), arc.clone());
        Ok(arc)
    }
}

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
        "mitm-ca.crt not found in any of: {:?}",
        candidates
    ))
}
