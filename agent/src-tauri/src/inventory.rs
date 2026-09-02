// Per-agent hardware + software + Windows-event-log inventory. Collected
// on boot (after a short delay so the agent is enrolled) and then once every
// 24 h. Payload is 10-200 KB per agent so we don't ride the 60-second
// metrics tick — separate posting cadence, separate DB table
// (`agent_inventory`, see migration 0153).
//
// Everything here is Windows-first because the fleet is Windows-first. Mac
// and Linux stub the platform-specific pieces (WMIC, wevtutil, registry
// enumeration) so the agent still compiles and posts an empty section
// rather than crashing.
//
// The philosophy: cheap, quiet, no PowerShell modules to install. Every
// invocation goes through wmic / reg / wevtutil which are shipped in-box
// on every supported Windows version and finish in under ~10 seconds each.
// If a probe fails we log-and-skip the section, not the whole cycle —
// admins would rather see partial hardware than nothing at all.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct InventoryPayload {
    pub hardware: Value,
    pub software: Value,
    pub battery: Option<Value>,
    pub system_events: Value,
    pub summary: Value,
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

pub fn collect() -> InventoryPayload {
    let hardware = collect_hardware();
    let software = collect_software();
    let battery = collect_battery();
    let system_events = collect_system_events();
    let summary = build_summary(&hardware, &battery, &system_events);
    InventoryPayload {
        hardware,
        software,
        battery,
        system_events,
        summary,
    }
}

// ---------------------------------------------------------------------------
// Hardware — CPU, RAM, disks (+ SMART), GPU, motherboard, BIOS, NICs.
// ---------------------------------------------------------------------------

fn collect_hardware() -> Value {
    let mut out = json!({});
    if let Some(cpu) = probe_cpu() { out["cpu"] = cpu; }
    if let Some(memory) = probe_memory() { out["memory"] = memory; }
    if let Some(disks) = probe_disks() { out["disks"] = disks; }
    if let Some(gpu) = probe_gpu() { out["gpu"] = gpu; }
    if let Some(mb) = probe_motherboard() { out["motherboard"] = mb; }
    if let Some(bios) = probe_bios() { out["bios"] = bios; }
    if let Some(os) = probe_os() { out["os"] = os; }
    if let Some(nics) = probe_network_adapters() { out["network_adapters"] = nics; }
    if let Some(lic) = probe_windows_license() { out["license"] = lic; }
    out
}

/// Windows activation + product key. What we can and can't get:
///   * OEM key baked into UEFI BIOS: retrievable via WMI
///     SoftwareLicensingService.OA3xOriginalProductKey. Present on OEM-
///     preloaded Windows, empty on machines where Windows was re-imaged
///     onto non-OEM media.
///   * Currently-installed product key: NOT retrievable. Microsoft
///     removed the ability circa Windows 10 1607 for anti-piracy reasons;
///     wmic returns only the last 5 chars ("partial product key") via
///     SoftwareLicensingProduct.PartialProductKey. That's what we send.
///   * Activation status: SoftwareLicensingProduct.LicenseStatus (0=
///     unlicensed, 1=licensed, 2=OOB grace, 3=OOT grace, 4=non-genuine
///     grace, 5=notification, 6=extended grace).
///   * Windows edition (Home / Pro / Enterprise / Education) plus the
///     activation channel: Retail / OEM_DM / OEM_SLP / Volume:MAK /
///     Volume:GVLK — from SoftwareLicensingProduct.Name +
///     .ProductKeyChannel.
///
/// One row per active Windows SKU is returned (typically just one). All
/// probes are read-only and only require standard user context.
#[cfg(target_os = "windows")]
fn probe_windows_license() -> Option<Value> {
    // 1. OEM key from BIOS.
    let oem_key = wmic(&[
        "path", "SoftwareLicensingService", "get", "OA3xOriginalProductKey", "/format:csv",
    ]).and_then(|out| {
        parse_csv(&out).into_iter().next()
            .and_then(|r| r.get("OA3xOriginalProductKey").cloned())
            .filter(|s| !s.is_empty())
    });

    // 2. Active SKU: LicenseStatus + PartialProductKey + Name + Channel.
    let sku_out = wmic(&[
        "path", "SoftwareLicensingProduct",
        "where", "PartialProductKey <> null",
        "get", "Name,LicenseStatus,PartialProductKey,ProductKeyChannel,GenuineStatus",
        "/format:csv",
    ])?;
    let rows = parse_csv(&sku_out);
    let mut skus: Vec<Value> = Vec::new();
    for r in rows {
        let name = r.get("Name").cloned().unwrap_or_default();
        if !name.contains("Windows") { continue; }
        let status_code = r.get("LicenseStatus").and_then(|s| s.parse::<i32>().ok());
        skus.push(json!({
            "sku_name": name,
            "activation_channel": r.get("ProductKeyChannel").cloned().unwrap_or_default(),
            "partial_product_key": r.get("PartialProductKey").cloned().unwrap_or_default(),
            "license_status_code": status_code,
            "license_status": license_status_text(status_code.unwrap_or(-1)),
            "genuine_status_code": r.get("GenuineStatus").and_then(|s| s.parse::<i32>().ok()),
        }));
    }

    Some(json!({
        "oem_product_key": oem_key,
        "active_skus": skus,
    }))
}

fn license_status_text(code: i32) -> &'static str {
    match code {
        0 => "Unlicensed",
        1 => "Licensed",
        2 => "Out-of-box grace",
        3 => "Out-of-tolerance grace",
        4 => "Non-genuine grace",
        5 => "Notification",
        6 => "Extended grace",
        _ => "Unknown",
    }
}

#[cfg(not(target_os = "windows"))]
fn probe_windows_license() -> Option<Value> { None }

#[cfg(target_os = "windows")]
fn probe_cpu() -> Option<Value> {
    let out = wmic(&["cpu", "get", "Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,SocketDesignation", "/format:csv"])?;
    let rows = parse_csv(&out);
    let first = rows.into_iter().next()?;
    Some(json!({
        "name": first.get("Name").cloned().unwrap_or_default(),
        "cores": first.get("NumberOfCores").and_then(|s| s.parse::<i64>().ok()),
        "logical_processors": first.get("NumberOfLogicalProcessors").and_then(|s| s.parse::<i64>().ok()),
        "max_clock_mhz": first.get("MaxClockSpeed").and_then(|s| s.parse::<i64>().ok()),
        "socket": first.get("SocketDesignation").cloned().unwrap_or_default(),
    }))
}

#[cfg(target_os = "windows")]
fn probe_memory() -> Option<Value> {
    let out = wmic(&["memorychip", "get", "Capacity,Manufacturer,Speed,PartNumber,DeviceLocator", "/format:csv"])?;
    let rows = parse_csv(&out);
    let mut slots = Vec::new();
    let mut total_bytes: u64 = 0;
    for row in rows {
        if let Some(cap) = row.get("Capacity").and_then(|s| s.parse::<u64>().ok()) {
            total_bytes = total_bytes.saturating_add(cap);
            slots.push(json!({
                "capacity_bytes": cap,
                "capacity_gb": (cap as f64 / 1_073_741_824.0 * 100.0).round() / 100.0,
                "manufacturer": row.get("Manufacturer").cloned().unwrap_or_default(),
                "speed_mhz": row.get("Speed").and_then(|s| s.parse::<i64>().ok()),
                "part_number": row.get("PartNumber").cloned().unwrap_or_default(),
                "slot": row.get("DeviceLocator").cloned().unwrap_or_default(),
            }));
        }
    }
    Some(json!({
        "total_bytes": total_bytes,
        "total_gb": (total_bytes as f64 / 1_073_741_824.0 * 100.0).round() / 100.0,
        "slots": slots,
    }))
}

#[cfg(target_os = "windows")]
fn probe_disks() -> Option<Value> {
    // Status column returns "OK" normally, "Pred Fail" when SMART's
    // predict-failure flag is set. This is the single most actionable
    // hardware-health signal we can get without a real SMART library.
    let out = wmic(&["diskdrive", "get", "Model,Size,SerialNumber,Status,MediaType,InterfaceType", "/format:csv"])?;
    let rows = parse_csv(&out);
    let disks: Vec<Value> = rows.into_iter().filter_map(|r| {
        let size_bytes = r.get("Size").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        if size_bytes == 0 { return None; }
        let status = r.get("Status").cloned().unwrap_or_default();
        Some(json!({
            "model": r.get("Model").cloned().unwrap_or_default(),
            "size_bytes": size_bytes,
            "size_gb": (size_bytes as f64 / 1_073_741_824.0).round(),
            "serial_number": r.get("SerialNumber").cloned().unwrap_or_default(),
            "status": status.clone(),
            "predict_failure": !status.eq_ignore_ascii_case("OK"),
            "media_type": r.get("MediaType").cloned().unwrap_or_default(),
            "interface": r.get("InterfaceType").cloned().unwrap_or_default(),
        }))
    }).collect();
    if disks.is_empty() { None } else { Some(json!(disks)) }
}

#[cfg(target_os = "windows")]
fn probe_gpu() -> Option<Value> {
    let out = wmic(&["path", "win32_videocontroller", "get", "Name,AdapterRAM,DriverVersion,VideoProcessor", "/format:csv"])?;
    let rows = parse_csv(&out);
    let gpus: Vec<Value> = rows.into_iter().filter_map(|r| {
        let name = r.get("Name").cloned().unwrap_or_default();
        if name.is_empty() { return None; }
        Some(json!({
            "name": name,
            "vram_bytes": r.get("AdapterRAM").and_then(|s| s.parse::<u64>().ok()),
            "driver_version": r.get("DriverVersion").cloned().unwrap_or_default(),
            "processor": r.get("VideoProcessor").cloned().unwrap_or_default(),
        }))
    }).collect();
    if gpus.is_empty() { None } else { Some(json!(gpus)) }
}

#[cfg(target_os = "windows")]
fn probe_motherboard() -> Option<Value> {
    let out = wmic(&["baseboard", "get", "Manufacturer,Product,SerialNumber,Version", "/format:csv"])?;
    let rows = parse_csv(&out);
    let first = rows.into_iter().next()?;
    Some(json!({
        "manufacturer": first.get("Manufacturer").cloned().unwrap_or_default(),
        "model": first.get("Product").cloned().unwrap_or_default(),
        "serial_number": first.get("SerialNumber").cloned().unwrap_or_default(),
        "version": first.get("Version").cloned().unwrap_or_default(),
    }))
}

#[cfg(target_os = "windows")]
fn probe_bios() -> Option<Value> {
    let out = wmic(&["bios", "get", "Manufacturer,Version,SMBIOSBIOSVersion,ReleaseDate", "/format:csv"])?;
    let rows = parse_csv(&out);
    let first = rows.into_iter().next()?;
    Some(json!({
        "manufacturer": first.get("Manufacturer").cloned().unwrap_or_default(),
        "version": first.get("Version").cloned().unwrap_or_default(),
        "smbios_version": first.get("SMBIOSBIOSVersion").cloned().unwrap_or_default(),
        "release_date": first.get("ReleaseDate").cloned().unwrap_or_default(),
    }))
}

#[cfg(target_os = "windows")]
fn probe_os() -> Option<Value> {
    let out = wmic(&["os", "get", "Caption,Version,BuildNumber,OSArchitecture,InstallDate", "/format:csv"])?;
    let rows = parse_csv(&out);
    let first = rows.into_iter().next()?;
    Some(json!({
        "name": first.get("Caption").cloned().unwrap_or_default(),
        "version": first.get("Version").cloned().unwrap_or_default(),
        "build": first.get("BuildNumber").cloned().unwrap_or_default(),
        "architecture": first.get("OSArchitecture").cloned().unwrap_or_default(),
        "install_date": first.get("InstallDate").cloned().unwrap_or_default(),
    }))
}

#[cfg(target_os = "windows")]
fn probe_network_adapters() -> Option<Value> {
    let out = wmic(&["nic", "where", "PhysicalAdapter=true", "get", "Name,MACAddress,Speed,AdapterType", "/format:csv"])?;
    let rows = parse_csv(&out);
    let nics: Vec<Value> = rows.into_iter().filter_map(|r| {
        let name = r.get("Name").cloned().unwrap_or_default();
        if name.is_empty() { return None; }
        Some(json!({
            "name": name,
            "mac_address": r.get("MACAddress").cloned().unwrap_or_default(),
            "speed_bps": r.get("Speed").and_then(|s| s.parse::<u64>().ok()),
            "adapter_type": r.get("AdapterType").cloned().unwrap_or_default(),
        }))
    }).collect();
    if nics.is_empty() { None } else { Some(json!(nics)) }
}

#[cfg(not(target_os = "windows"))]
fn probe_cpu() -> Option<Value> { None }
#[cfg(not(target_os = "windows"))]
fn probe_memory() -> Option<Value> { None }
#[cfg(not(target_os = "windows"))]
fn probe_disks() -> Option<Value> { None }
#[cfg(not(target_os = "windows"))]
fn probe_gpu() -> Option<Value> { None }
#[cfg(not(target_os = "windows"))]
fn probe_motherboard() -> Option<Value> { None }
#[cfg(not(target_os = "windows"))]
fn probe_bios() -> Option<Value> { None }
#[cfg(not(target_os = "windows"))]
fn probe_os() -> Option<Value> { None }
#[cfg(not(target_os = "windows"))]
fn probe_network_adapters() -> Option<Value> { None }

// ---------------------------------------------------------------------------
// Installed software — HKLM Uninstall enum (fast, no wmic product).
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn collect_software() -> Value {
    // wmic product is famously slow (triggers MSI self-repair on every row);
    // reading the registry is milliseconds. Two hives cover 32- and 64-bit
    // installers. Duplicates are collapsed by DisplayName.
    let hives = [
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    let mut items: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for hive in hives {
        let out = match reg_query_recursive(hive) {
            Some(o) => o,
            None => continue,
        };
        for block in out.split("\r\n\r\n") {
            let mut display_name = String::new();
            let mut display_version = String::new();
            let mut publisher = String::new();
            let mut install_date = String::new();
            let mut is_system_component = false;
            for line in block.lines() {
                let t = line.trim();
                if let Some(v) = extract_reg_value(t, "DisplayName") { display_name = v; }
                else if let Some(v) = extract_reg_value(t, "DisplayVersion") { display_version = v; }
                else if let Some(v) = extract_reg_value(t, "Publisher") { publisher = v; }
                else if let Some(v) = extract_reg_value(t, "InstallDate") { install_date = v; }
                else if let Some(v) = extract_reg_value(t, "SystemComponent") {
                    is_system_component = v == "0x1";
                }
            }
            // Skip anonymous / system-component rows to keep the list to
            // things a human would recognise in Add/Remove Programs.
            if display_name.is_empty() || is_system_component { continue; }
            let key = display_name.to_lowercase();
            if !seen.insert(key) { continue; }
            items.push(json!({
                "name": display_name,
                "version": display_version,
                "publisher": publisher,
                "install_date": install_date,
            }));
        }
    }
    items.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    json!(items)
}

#[cfg(not(target_os = "windows"))]
fn collect_software() -> Value {
    json!([])
}

// ---------------------------------------------------------------------------
// Battery health — full charge vs design capacity (aging %).
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn collect_battery() -> Option<Value> {
    let out = wmic(&["path", "Win32_Battery", "get", "EstimatedChargeRemaining,BatteryStatus,DesignCapacity,FullChargeCapacity", "/format:csv"])?;
    let rows = parse_csv(&out);
    let first = rows.into_iter().next()?;
    let design = first.get("DesignCapacity").and_then(|s| s.parse::<i64>().ok());
    let full = first.get("FullChargeCapacity").and_then(|s| s.parse::<i64>().ok());
    // Not every OEM populates DesignCapacity via WMI; when both are present
    // the ratio is the classic laptop-battery "health %" the tools report.
    let health_pct = match (design, full) {
        (Some(d), Some(f)) if d > 0 => Some(((f as f64 / d as f64) * 100.0).round() as i32),
        _ => None,
    };
    Some(json!({
        "estimated_charge_pct": first.get("EstimatedChargeRemaining").and_then(|s| s.parse::<i32>().ok()),
        "status_code": first.get("BatteryStatus").and_then(|s| s.parse::<i32>().ok()),
        "design_capacity_mwh": design,
        "full_capacity_mwh": full,
        "health_pct": health_pct,
    }))
}

#[cfg(not(target_os = "windows"))]
fn collect_battery() -> Option<Value> { None }

// ---------------------------------------------------------------------------
// System event log — last 50 critical + error from the System channel.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn collect_system_events() -> Value {
    // wevtutil is 5-10× faster than Get-WinEvent for this exact query and
    // ships in-box back to Windows 7. XML output because CSV drops the
    // message body.
    let mut cmd = Command::new("wevtutil");
    cmd.args([
        "qe", "System",
        "/q:*[System[(Level=1 or Level=2)]]", // 1 = Critical, 2 = Error
        "/c:50",
        "/rd:true",
        "/f:xml",
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Very light XML pull — one entry per <Event>...</Event>. No dependency
    // on an XML crate; the schema is stable and we only need five fields.
    let mut events = Vec::new();
    for chunk in text.split("<Event ") {
        if !chunk.contains("</Event>") { continue; }
        let event_id = pull_tag(chunk, "EventID");
        let level = pull_tag(chunk, "Level");
        let time_created = pull_attr(chunk, "TimeCreated", "SystemTime");
        let provider = pull_attr(chunk, "Provider", "Name");
        // Message body lives inside <EventData><Data>…</Data></EventData>;
        // stitch them together separated by ` | `.
        let mut msg_parts = Vec::new();
        for part in chunk.split("<Data").skip(1) {
            if let Some(inner) = part.split_once('>').map(|x| x.1) {
                if let Some(end) = inner.find("</Data>") {
                    let s = inner[..end].trim().to_string();
                    if !s.is_empty() { msg_parts.push(s); }
                }
            }
        }
        events.push(json!({
            "time": time_created,
            "event_id": event_id.parse::<i64>().ok(),
            "level": match level.as_str() { "1" => "critical", "2" => "error", _ => "other" },
            "source": provider,
            "message": msg_parts.join(" | "),
        }));
    }
    events
        .sort_by(|a, b| b["time"].as_str().unwrap_or("").cmp(a["time"].as_str().unwrap_or("")));
    json!(events)
}

#[cfg(not(target_os = "windows"))]
fn collect_system_events() -> Value {
    json!([])
}

// ---------------------------------------------------------------------------
// Summary flags for the fleet at-risk badge.
// ---------------------------------------------------------------------------

fn build_summary(hardware: &Value, battery: &Option<Value>, events: &Value) -> Value {
    let disk_predict_fail = hardware
        .get("disks")
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().any(|d| d["predict_failure"].as_bool().unwrap_or(false)))
        .unwrap_or(false);
    let event_error_count = events.as_array().map(|a| a.len()).unwrap_or(0);
    let battery_health = battery
        .as_ref()
        .and_then(|b| b.get("health_pct"))
        .and_then(|h| h.as_i64());
    let battery_health_low = battery_health.map(|h| h < 75).unwrap_or(false);

    // Pull the first SKU's status + edition so the fleet-list badge can
    // flag unlicensed / non-genuine machines at a glance without decoding
    // the whole license section.
    let (windows_licensed, windows_edition) = hardware
        .get("license")
        .and_then(|l| l.get("active_skus"))
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.first())
        .map(|sku| {
            let licensed = sku.get("license_status_code")
                .and_then(|v| v.as_i64())
                .map(|c| c == 1)
                .unwrap_or(false);
            let edition = sku.get("sku_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (licensed, edition)
        })
        .unwrap_or((false, String::new()));

    json!({
        "disk_predict_fail": disk_predict_fail,
        "event_error_count_24h": event_error_count,
        "battery_health_low": battery_health_low,
        "battery_health_pct": battery_health,
        "windows_licensed": windows_licensed,
        "windows_edition": windows_edition,
        "agent_version": env!("CARGO_PKG_VERSION"),
    })
}

// ---------------------------------------------------------------------------
// Wire the collected payload to the agent-inventory-post edge function.
// ---------------------------------------------------------------------------

pub async fn post(
    supabase_url: &str,
    anon_key: &str,
    enroll_token: &str,
    payload: &InventoryPayload,
) -> Result<()> {
    let url = format!("{}/functions/v1/agent-inventory-post", supabase_url.trim_end_matches('/'));
    let client = crate::api::build_client()?;
    let resp = client
        .post(&url)
        .bearer_auth(anon_key)
        .header("apikey", anon_key)
        .header("X-Agent-Token", enroll_token)
        .json(payload)
        .send()
        .await
        .context("post agent-inventory-post")?;
    if !resp.status().is_success() {
        anyhow::bail!(
            "agent-inventory-post: {} — {}",
            resp.status(),
            resp.text().await.unwrap_or_default().chars().take(200).collect::<String>()
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// wmic helpers.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn wmic(args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("wmic");
    cmd.args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout).into_owned();
    Some(s)
}

/// Parse wmic /format:csv output. Header row + N data rows separated by
/// CRLF; commas inside quoted fields are handled minimally (wmic never
/// emits quoted commas in practice for the columns we probe).
#[cfg(target_os = "windows")]
fn parse_csv(text: &str) -> Vec<std::collections::HashMap<String, String>> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header = match lines.next() {
        Some(h) => h.split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>(),
        None => return Vec::new(),
    };
    let mut rows = Vec::new();
    for line in lines {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < header.len() { continue; }
        let mut map = std::collections::HashMap::new();
        for (i, h) in header.iter().enumerate() {
            map.insert(h.clone(), parts[i].trim().to_string());
        }
        rows.push(map);
    }
    rows
}

#[cfg(target_os = "windows")]
fn reg_query_recursive(hive: &str) -> Option<String> {
    let mut cmd = Command::new("reg");
    cmd.args(["query", hive, "/s"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(target_os = "windows")]
fn extract_reg_value(line: &str, name: &str) -> Option<String> {
    // Lines look like: "    DisplayName    REG_SZ    Google Chrome"
    if !line.starts_with(name) { return None; }
    let rest = line[name.len()..].trim_start();
    let mut parts = rest.splitn(2, char::is_whitespace);
    let _ty = parts.next()?;
    let val = parts.next().map(|s| s.trim().to_string()).unwrap_or_default();
    Some(val)
}

#[cfg(target_os = "windows")]
fn pull_tag(chunk: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    if let Some(start) = chunk.find(&open) {
        let after = &chunk[start + open.len()..];
        if let Some(end) = after.find(&close) {
            return after[..end].to_string();
        }
    }
    String::new()
}

#[cfg(target_os = "windows")]
fn pull_attr(chunk: &str, tag: &str, attr: &str) -> String {
    let needle = format!("<{tag} ");
    let attr_needle = format!("{attr}='");
    if let Some(start) = chunk.find(&needle) {
        let after = &chunk[start..];
        if let Some(a) = after.find(&attr_needle) {
            let inside = &after[a + attr_needle.len()..];
            if let Some(end) = inside.find('\'') {
                return inside[..end].to_string();
            }
        }
        // Fallback: double-quote variant.
        let alt = format!("{attr}=\"");
        if let Some(a) = after.find(&alt) {
            let inside = &after[a + alt.len()..];
            if let Some(end) = inside.find('"') {
                return inside[..end].to_string();
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Loop driver — 30 s warmup, then every 24 h.
// ---------------------------------------------------------------------------

pub fn spawn_inventory_loop(state: crate::AppState) {
    tauri::async_runtime::spawn(async move {
        // Warmup: let enrollment + settings tick settle first.
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            if let Err(e) = one_cycle(&state).await {
                log::warn!("inventory: cycle failed: {e:#}");
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

async fn one_cycle(state: &crate::AppState) -> Result<()> {
    // Config lookup on each cycle so a mid-cycle URL/token change is picked
    // up on the next post.
    let (url, anon, token) = {
        let cfg = state.config.lock().await.clone();
        let u = crate::config::supabase_url(&cfg);
        let a = crate::config::supabase_anon_key(&cfg);
        let t = cfg.enrollment.as_ref().map(|e| e.enroll_token.clone());
        (u, a, t)
    };
    let (url, anon, token) = match (url, anon, token) {
        (Some(u), Some(a), Some(t)) => (u, a, t),
        _ => {
            log::debug!("inventory: skip — agent not enrolled yet");
            return Ok(());
        }
    };
    // Collection is CPU-blocking (spawns wmic / reg / wevtutil); run on the
    // blocking pool so we don't hold the async runtime for the ~5-10 s each
    // probe takes.
    let payload = tokio::task::spawn_blocking(collect)
        .await
        .context("spawn_blocking inventory::collect")?;
    log::info!(
        "inventory: collected — hw={} bytes, sw={} items, events={}",
        serde_json::to_string(&payload.hardware).map(|s| s.len()).unwrap_or(0),
        payload.software.as_array().map(|a| a.len()).unwrap_or(0),
        payload.system_events.as_array().map(|a| a.len()).unwrap_or(0),
    );
    post(&url, &anon, &token, &payload).await?;
    Ok(())
}
