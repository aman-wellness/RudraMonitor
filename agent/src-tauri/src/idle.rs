// Idle detection. Polls the OS-reported user-input idle every IDLE_POLL_SECS.
// Emits an `activity_logs` row with activity_type='idle' once an idle session ends, so
// each row is a single idle period with a real duration.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

pub const IDLE_THRESHOLD_SECS: u64 = 300; // 5 min

#[derive(Debug, Clone, Copy)]
pub struct IdleSession {
    pub started_at: DateTime<Utc>,
}

/// Returns the OS-reported user-input idle duration in whole seconds. None on platforms where the
/// query fails (the loop should treat None as "active enough — do nothing").
pub fn current_idle_secs() -> Option<u64> {
    user_idle::UserIdle::get_time().ok().map(|d| d.as_seconds())
}

pub fn to_payload(session: &IdleSession, ended_at: DateTime<Utc>) -> Value {
    let duration = (ended_at - session.started_at).num_seconds().max(0);
    json!({
        "activity_type": "idle",
        "application_name": null,
        "url": null,
        "duration": duration,
        "created_at": session.started_at.to_rfc3339(),
    })
}
