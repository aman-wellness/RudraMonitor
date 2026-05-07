// System metrics collection: CPU/RAM/disk via sysinfo, network throughput as a delta from the
// previous sample, and battery via starship-battery (cross-platform).

use chrono::Utc;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, Networks, System};

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSample {
    pub cpu_usage: i32,
    pub ram_usage: i32,
    pub disk_usage: i32,
    pub battery_level: Option<i32>,
    pub network_speed: Option<String>,
    pub recorded_at: String,
}

// Persisted between calls so we can compute network deltas. None on first call → no speed reported.
struct NetworkPrev {
    when: Instant,
    rx_bytes: u64,
    tx_bytes: u64,
}

static NET_PREV: Lazy<Mutex<Option<NetworkPrev>>> = Lazy::new(|| Mutex::new(None));

fn current_network_totals() -> (u64, u64) {
    let mut nets = Networks::new_with_refreshed_list();
    nets.refresh();
    let mut rx = 0u64;
    let mut tx = 0u64;
    for (_name, data) in &nets {
        rx = rx.saturating_add(data.total_received());
        tx = tx.saturating_add(data.total_transmitted());
    }
    (rx, tx)
}

fn network_speed() -> Option<String> {
    let (rx, tx) = current_network_totals();
    let now = Instant::now();
    let mut guard = NET_PREV.lock().ok()?;
    let result = guard.as_ref().and_then(|prev| {
        let elapsed = now.saturating_duration_since(prev.when).as_secs_f64();
        if elapsed < 0.5 {
            return None;
        }
        let down_bps = (rx.saturating_sub(prev.rx_bytes)) as f64 / elapsed;
        let up_bps = (tx.saturating_sub(prev.tx_bytes)) as f64 / elapsed;
        // Mbps (decimal). 1 Mbps = 125_000 bytes/sec.
        let down_mbps = down_bps / 125_000.0;
        let up_mbps = up_bps / 125_000.0;
        Some(format!("↓{:.1} ↑{:.1} Mbps", down_mbps, up_mbps))
    });
    *guard = Some(NetworkPrev { when: now, rx_bytes: rx, tx_bytes: tx });
    result
}

fn battery_level() -> Option<i32> {
    let manager = starship_battery::Manager::new().ok()?;
    let mut iter = manager.batteries().ok()?;
    let battery = iter.next()?.ok()?;
    let pct = battery.state_of_charge().value * 100.0;
    Some(pct.round() as i32)
}

pub fn collect() -> MetricsSample {
    let mut sys = System::new_all();
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(250));
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_usage().round() as i32;
    let ram_usage = if sys.total_memory() > 0 {
        ((sys.used_memory() as f64 / sys.total_memory() as f64) * 100.0).round() as i32
    } else {
        0
    };

    let disks = Disks::new_with_refreshed_list();
    let disk_usage = disks
        .iter()
        .find(|d| d.mount_point().to_string_lossy() == "/" || d.mount_point().to_string_lossy().starts_with("C:"))
        .or_else(|| disks.iter().next())
        .map(|d| {
            if d.total_space() > 0 {
                let used = d.total_space() - d.available_space();
                ((used as f64 / d.total_space() as f64) * 100.0).round() as i32
            } else {
                0
            }
        })
        .unwrap_or(0);

    MetricsSample {
        cpu_usage,
        ram_usage,
        disk_usage,
        battery_level: battery_level(),
        network_speed: network_speed(),
        recorded_at: Utc::now().to_rfc3339(),
    }
}

pub fn to_payload(sample: &MetricsSample) -> Value {
    json!({
        "cpu_usage": sample.cpu_usage,
        "ram_usage": sample.ram_usage,
        "disk_usage": sample.disk_usage,
        "battery_level": sample.battery_level,
        "network_speed": sample.network_speed,
        "recorded_at": sample.recorded_at,
    })
}
