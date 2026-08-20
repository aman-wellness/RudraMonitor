// System metrics collection: CPU/RAM/disk via sysinfo, network throughput as a delta from the
// previous sample, and battery via starship-battery (cross-platform).
//
// Two distinct disk numbers, because they answer different questions and were
// previously conflated into one:
//
//   disk_usage    — how FULL the drive is: (total - available) / total.
//                   Surfaced in the dashboard as "Disk Space".
//   disk_activity — how BUSY the disk is: percent of the sampling window the
//                   physical disk spent servicing I/O. This is the quantity
//                   Task Manager puts in its "Disk" column, and it is what a
//                   user comparing the two screens expects to match.
//
// Reporting only capacity meant a two-thirds-full but idle drive showed "63%"
// next to CPU and Memory, reading as heavy disk load while Task Manager showed
// 1-5%.

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
    /// None when the platform or this build cannot measure it — the dashboard
    /// renders that as "—" rather than 0, so "unmeasured" never reads as "idle".
    pub disk_activity: Option<i32>,
    pub battery_level: Option<i32>,
    pub network_speed: Option<String>,
    pub recorded_at: String,
}

/// Percent of the interval the physical disk was busy, via the same performance
/// counter Task Manager reads: `\PhysicalDisk(_Total)\% Idle Time`, inverted.
///
/// PDH rate counters need two collections separated in time, so this samples,
/// waits, and samples again. The wait is 500 ms against a 60 s metrics tick.
/// `PdhAddEnglishCounter` is used rather than the localised variant so the
/// counter path resolves on non-English Windows too.
#[cfg(target_os = "windows")]
fn disk_activity() -> Option<i32> {
    use std::thread::sleep;
    use std::time::Duration;
    use windows::core::w;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE,
    };

    const OK: u32 = 0;
    unsafe {
        let mut query: isize = 0;
        if PdhOpenQueryW(None, 0, &mut query) != OK {
            return None;
        }
        // Every early return past this point has to close the query.
        let mut counter: isize = 0;
        if PdhAddEnglishCounterW(query, w!("\\PhysicalDisk(_Total)\\% Idle Time"), 0, &mut counter) != OK {
            PdhCloseQuery(query);
            return None;
        }
        if PdhCollectQueryData(query) != OK {
            PdhCloseQuery(query);
            return None;
        }
        sleep(Duration::from_millis(500));
        if PdhCollectQueryData(query) != OK {
            PdhCloseQuery(query);
            return None;
        }
        let mut value = PDH_FMT_COUNTERVALUE::default();
        let rc = PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value);
        PdhCloseQuery(query);
        if rc != OK {
            return None;
        }
        let idle = value.Anonymous.doubleValue;
        if !idle.is_finite() {
            return None;
        }
        // Idle can read slightly outside 0-100 on multi-disk systems; clamp.
        Some((100.0 - idle).clamp(0.0, 100.0).round() as i32)
    }
}

/// No portable equivalent yet — macOS needs IOKit and Linux /proc/diskstats
/// io_ticks. Returning None keeps the dashboard honest ("—") instead of
/// inventing a zero.
#[cfg(not(target_os = "windows"))]
fn disk_activity() -> Option<i32> {
    None
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
        disk_activity: disk_activity(),
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
        "disk_activity": sample.disk_activity,
        "battery_level": sample.battery_level,
        "network_speed": sample.network_speed,
        "recorded_at": sample.recorded_at,
    })
}
