// Currently unused — the auto-approve decision happens server-side in
// remote-session-start (the payload arrives with `auto_approved: true`
// if the admin's org policy allows it). This module exists so future
// agent-side gates (e.g., a hard "Never allow on this machine" toggle in
// the agent UI) have a clear home.

#![allow(dead_code)]

use crate::AppState;

/// Hook for a future per-agent kill-switch. Today: always returns true.
pub async fn remote_enabled(_state: &AppState) -> bool {
    true
}
