//! Local HTTPS interception proxy for the Email DLP module (v0.7.0+).
//!
//! Runs a plain-text HTTP proxy on `127.0.0.1:47443`, terminated by an
//! agent-installed root CA (see `agent/src-tauri/resources/mitm-ca.crt` +
//! matching install scripts in `agent/scripts/pkg-scripts/postinstall`,
//! `agent/src-tauri/wix/*`, `agent/src-tauri/scripts/deb-scripts/postinst`).
//!
//! Phase 3 scope (this file): **passthrough only.** The proxy accepts
//! HTTP `CONNECT` from a browser, resolves the target host, and blind-
//! tunnels the raw TCP bytes both directions. No TLS termination, no
//! certificate minting, no request inspection. This is the plumbing
//! layer — verifies system-proxy set, browser routing, connection
//! reliability, and fail-open before Phase 4 layers actual interception
//! on top of it.
//!
//! The system-wide proxy setting is applied at [`start`] and reverted at
//! [`stop`]. If the proxy dies unexpectedly, the guardian is expected to
//! invoke [`stop`] before restart so the endpoint never sits with a
//! system proxy pointing at a dead port.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

mod cert_authority;
mod interceptor;
mod providers;
mod proxy;
mod system_proxy;

pub use cert_authority::Authority;

/// The minimum config the interceptor needs to fire off a DLP ingest
/// call. Stashed in a `OnceCell` at `start()` so the interceptor task
/// (spawned per TLS session, no AppState reference) can pull it without
/// threading Tauri state through every layer.
#[derive(Clone, Debug)]
pub struct MitmConfig {
    pub supabase_url: String,
    pub anon_key: String,
    pub enroll_token: String,
}

static MITM_CFG: once_cell::sync::OnceCell<MitmConfig> = once_cell::sync::OnceCell::new();

pub(crate) fn mitm_cfg() -> Option<&'static MitmConfig> {
    MITM_CFG.get()
}

/// Loopback bind address for the local proxy. The port is chosen high
/// enough to avoid collision with common dev tools (Vite 5173, Next.js
/// 3000, etc.) and low enough that firewalls treat it as ephemeral. Not
/// exposed to any external network — the listener binds `127.0.0.1`
/// only, so no LAN neighbour can reach it.
pub const PROXY_BIND_ADDR: &str = "127.0.0.1:47443";

/// Global stop signal used to tear the proxy down cleanly on agent
/// shutdown. Cheap to clone; every task holds an `Arc` and polls it.
static STOP: once_cell::sync::Lazy<Arc<Notify>> =
    once_cell::sync::Lazy::new(|| Arc::new(Notify::new()));

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Spin up the proxy + set system proxy. Idempotent: a second call while
/// running is a no-op and returns Ok. Failure to set the system proxy is
/// logged, not fatal — the listener still runs so a self-configured
/// browser (e.g. Firefox with an explicit proxy setting) can still route
/// through it.
pub async fn start(cfg: MitmConfig) -> anyhow::Result<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        log::debug!("mitm: start() called while already running — ignoring");
        return Ok(());
    }
    let _ = MITM_CFG.set(cfg);

    // Install the ring crypto provider before touching rustls anywhere
    // — rustls 0.23 requires an explicit CryptoProvider install once
    // per process. Second call is a no-op.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Load the bundled CA + key. `Ok(None)` = the key wasn't embedded
    // (dev build); we still start the proxy in passthrough-only mode.
    let ca = match Authority::load_bundled() {
        Ok(Some(ca)) => {
            log::info!("mitm: bundled CA loaded — TLS interception enabled");
            Some(ca)
        }
        Ok(None) => {
            log::warn!("mitm: no CA key in this build; proxy runs in passthrough-only mode");
            None
        }
        Err(e) => {
            log::error!("mitm: CA load failed ({e}); passthrough-only");
            None
        }
    };

    // Best-effort system-proxy set. On failure we still bring the
    // listener up so trace / debug users can point a manual proxy at it.
    if let Err(e) = system_proxy::set(PROXY_BIND_ADDR) {
        log::warn!("mitm: system_proxy::set failed ({e}); listener still starting");
    }

    let stop = STOP.clone();
    tokio::spawn(async move {
        if let Err(e) = proxy::run(PROXY_BIND_ADDR, ca, stop).await {
            log::error!("mitm: proxy exited with error: {e}");
        }
        // Whatever caused the exit, revert system proxy so browsing
        // survives. `stop()` is called explicitly from the guardian's
        // shutdown path too — this is the belt-and-suspenders.
        if let Err(e) = system_proxy::unset() {
            log::warn!("mitm: system_proxy::unset on exit failed ({e})");
        }
        RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(())
}

/// Tear the proxy down: signal the listener, revert the system proxy.
/// Safe to call from any thread; safe to call when not running (no-op).
pub fn stop() {
    if !RUNNING.load(Ordering::SeqCst) {
        return;
    }
    STOP.notify_waiters();
    if let Err(e) = system_proxy::unset() {
        log::warn!("mitm: system_proxy::unset failed ({e})");
    }
}
