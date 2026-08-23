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
mod proxy;
mod system_proxy;

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
pub async fn start() -> anyhow::Result<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        log::debug!("mitm: start() called while already running — ignoring");
        return Ok(());
    }

    // Load the bundled CA + key. On Phase 3 the key is only wired up so
    // we can fail-fast if the build lost the secret; the proxy itself
    // doesn't yet mint leaves. `load_bundled` is Ok(None) when the key
    // is deliberately absent (dev builds, pre-v0.7.0 tagged builds).
    match cert_authority::load_bundled() {
        Ok(Some(_ca)) => log::info!("mitm: bundled CA loaded — ready for interception"),
        Ok(None) => log::warn!(
            "mitm: no CA key in this build; proxy runs in passthrough-only mode"
        ),
        Err(e) => {
            log::error!("mitm: CA load failed ({e}); running passthrough-only");
        }
    }

    // Best-effort system-proxy set. On failure we still bring the
    // listener up so trace / debug users can point a manual proxy at it.
    if let Err(e) = system_proxy::set(PROXY_BIND_ADDR) {
        log::warn!("mitm: system_proxy::set failed ({e}); listener still starting");
    }

    let stop = STOP.clone();
    tokio::spawn(async move {
        if let Err(e) = proxy::run(PROXY_BIND_ADDR, stop).await {
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
