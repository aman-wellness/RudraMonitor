// Phase-2 Remote Desktop subsystem.
//
// Completely separate from the LiveKit-based Live Monitoring pipeline
// (capture/, encode/, whip_publisher.rs). NO shared state, NO shared
// dependencies, NO shared subprocess — the two subsystems can run side
// by side without contention. The OS schedules each independently.
//
// Wiring (lib.rs::setup):
//   remote::spawn(state, app_handle)
//
// What spawn() does:
//   1. Waits for agent enrollment (same pattern as the other loops).
//   2. Subscribes to Supabase Realtime channel `agent:<agent_id>`.
//   3. Dispatches `remote.request` events into the consent + rustdesk
//      bring-up pipeline.
//   4. Dispatches `remote.ended` events into the subprocess teardown
//      pipeline.
//
// The whole subsystem is INERT when no `rustdesk` binary is bundled
// (Block 3.2 of the Phase-2 plan adds CI binary bundling). In that
// state, the realtime listener still runs and logs `remote.request`
// events but rustdesk_host::start() returns an error, and the agent
// reports back via /remote-session-approve with decision=deny + a
// "no rustdesk binary bundled" reason. The dashboard sees the error
// surfaced cleanly instead of hanging.

pub mod audit;
pub mod consent;
pub mod policy;
pub mod realtime_listener;
pub mod rustdesk_host;

use crate::AppState;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

/// Per-session state held in the agent's process memory. The realtime
/// listener owns this — only one remote session is allowed at a time
/// (rustdesk subprocess can't co-host multiple controllers).
pub struct RemoteState {
    pub active_session: Mutex<Option<rustdesk_host::HostHandle>>,
    /// Last successfully-deployed Outlook signature checksum. In-memory only
    /// — a fresh process re-deploys on the first `signature.push` event even
    /// if the checksum hasn't changed, which is desirable if the user
    /// reinstalled Office and lost the registry keys. Unused on non-Windows
    /// but kept in the shared struct for cross-platform code simplicity.
    pub last_signature_checksum: Mutex<Option<String>>,
    /// run_id of the currently-executing endpoint tool run (driver updater
    /// or Windows optimizer), or None when no tool is running. Guards
    /// against overlapping runs — a second `tool.run` broadcast for the
    /// same agent while one is in flight is rejected with a log line.
    /// Windows-only feature but the field lives here so `realtime_listener`
    /// compiles cross-platform.
    pub active_tool_run: Mutex<Option<String>>,
}

impl RemoteState {
    pub fn new() -> Self {
        Self {
            active_session: Mutex::new(None),
            last_signature_checksum: Mutex::new(None),
            active_tool_run: Mutex::new(None),
        }
    }
}

/// Public entry point — spawned once at agent boot from lib.rs::setup().
pub fn spawn(state: AppState, app: AppHandle) {
    let remote = Arc::new(RemoteState::new());
    tauri::async_runtime::spawn(async move {
        // Wait for enrollment, same as every other long-running loop.
        loop {
            if crate::ready(&state).await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        log::info!("remote: subsystem starting");

        // Boot-time cleanup: if the previous agent process crashed or
        // was force-killed, rustdesk.exe might still be running. Kill
        // it so the first new session starts from a clean slate.
        rustdesk_host::kill_orphan_rustdesk().await;

        // Reconnect-with-backoff loop. Supabase Realtime can drop the
        // WSS connection on network blips, server restarts, etc. — we
        // want the agent to silently reconnect without losing
        // remote-session capability.
        let mut backoff_secs = 1u64;
        loop {
            match realtime_listener::run(state.clone(), app.clone(), remote.clone()).await {
                Ok(()) => {
                    // Clean shutdown only happens if the AppState's
                    // shutdown flag is flipped, which we don't yet
                    // expose. Reset backoff for the next iteration.
                    backoff_secs = 1;
                }
                Err(e) => {
                    log::warn!("remote: realtime listener died: {e}; reconnecting in {backoff_secs}s");
                    tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                    backoff_secs = (backoff_secs * 2).min(60);
                }
            }
        }
    });
}
