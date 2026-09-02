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

// -----------------------------------------------------------------------------
// PowerShell + CIM. Replacement for wmic across the board.
//
// wmic.exe is deprecated in Windows 10 21H1 and no longer shipped by default on
// Windows 11 22H2 and Server 2025. On those machines the wmic-backed probes
// silently returned None and the inventory row landed with hardware={} — that's
// what Umang Goyal's 2026-09-02 12:48 UTC snapshot looked like: 53 software
// entries, 50 event rows, and an empty hardware blob. PowerShell + Get-CimInstance
// speaks the same underlying WMI provider on every Windows version we support
// (7 through 11) and is present regardless of the wmic feature-on-demand state.
// -----------------------------------------------------------------------------

/// ConvertTo-Json in PowerShell emits a JSON OBJECT for a single row and a
/// JSON ARRAY for multiple rows — a real ergonomic footgun when we don't
/// know the row count ahead of time. This wrapper always sees an array by
/// asking PowerShell for one explicitly with @().
#[cfg(target_os = "windows")]
fn ps_rows<T: for<'de> Deserialize<'de>>(select_pipeline: &str) -> Option<Vec<T>> {
    // `-Compress` shrinks payload, `-Depth 5` covers the nested SoftwareLicensingProduct.
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; @({}) | ConvertTo-Json -Compress -Depth 5",
        select_pipeline
    );
    // If the wrapped pipeline emitted 0 or 1 rows PowerShell serialises differently
    // even inside @(). @() forces an array for the empty case; a single row still
    // arrives as a bare object. Try both.
    let text_out = {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-OutputFormat", "Text",
            "-Command", &script,
        ]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::null());
        crate::win_proc::no_window(&mut cmd);
        cmd.output().ok()?
    };
    if !text_out.status.success() { return None; }
    let text = String::from_utf8_lossy(&text_out.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() { return None; }
    if let Ok(v) = serde_json::from_str::<Vec<T>>(trimmed) {
        return Some(v);
    }
    // Single row case — PowerShell dropped the array wrapper.
    if let Ok(v) = serde_json::from_str::<T>(trimmed) {
        return Some(vec![v]);
    }
    None
}

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
    // OS family — read by the dashboard so it can render Mac chips vs
    // Windows chips instead of pretending every agent is Windows.
    out["os_type"] = Value::String(std::env::consts::OS.to_string());
    // Machine identity — hostname + Dell/Latitude style manufacturer/model
    // (this is what admins recognise from Intune / Endpoint Manager). The
    // motherboard section carries a DIFFERENT manufacturer string (often
    // just "Dell Inc."); this reads Win32_ComputerSystem which is the
    // consumer-facing brand + model.
    #[cfg(target_os = "windows")]
    {
        if let Some(sys) = probe_computer_system() { out["computer_system"] = sys; }
        if let Some(vols) = probe_volumes() { out["volumes"] = vols; }
        if let Some(tpm) = probe_tpm() { out["tpm"] = tpm; }
        if let Some(patch) = probe_last_patch() { out["last_patch"] = patch; }
        if let Some(aad) = probe_aad_join() { out["aad_join"] = aad; }
        if let Some(bl) = probe_bitlocker() { out["bitlocker"] = bl; }
    }
    // System serial FIRST — this is the string that's printed on the
    // sticker on the back of every laptop/desktop and what admins type
    // into the IT Hardware register's device_serial field. Ship it at
    // the top-level of hardware so the join into hardware_assets is one
    // hop: hardware->>'system_serial' = hardware_assets.device_serial.
    if let Some(sn) = probe_system_serial() { out["system_serial"] = sn; }
    if let Some(cpu) = probe_cpu() { out["cpu"] = cpu; }
    if let Some(memory) = probe_memory() { out["memory"] = memory; }
    if let Some(disks) = probe_disks() { out["disks"] = disks; }
    if let Some(gpu) = probe_gpu() { out["gpu"] = gpu; }
    if let Some(mb) = probe_motherboard() { out["motherboard"] = mb; }
    if let Some(bios) = probe_bios() { out["bios"] = bios; }
    if let Some(os) = probe_os() { out["os"] = os; }
    if let Some(nics) = probe_network_adapters() { out["network_adapters"] = nics; }
    if let Some(lic) = probe_windows_license() { out["license"] = lic; }
    #[cfg(target_os = "windows")]
    {
        out["product_licenses"] = probe_product_licenses();
    }
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
    // 1. OEM key from BIOS via SLS.
    #[derive(Deserialize)]
    struct Oem { #[serde(default)] OA3xOriginalProductKey: String }
    let oem_key = ps_rows::<Oem>(
        "Get-CimInstance SoftwareLicensingService | Select OA3xOriginalProductKey"
    )
    .and_then(|v| v.into_iter().next())
    .map(|o| o.OA3xOriginalProductKey.trim().to_string())
    .filter(|s| !s.is_empty());

    // 2. Windows SKU (PartialProductKey is the last 5 chars of the installed key).
    #[derive(Deserialize)]
    struct WinSku {
        #[serde(default)] Name: String,
        #[serde(default)] PartialProductKey: String,
        #[serde(default)] ProductKeyChannel: String,
        LicenseStatus: Option<i32>,
        GenuineStatus: Option<serde_json::Value>,
    }
    let win_rows = ps_rows::<WinSku>(
        "Get-CimInstance SoftwareLicensingProduct -Filter \"Name LIKE 'Windows%'\" | Where-Object { $_.PartialProductKey } | Select Name, PartialProductKey, ProductKeyChannel, LicenseStatus, GenuineStatus"
    ).unwrap_or_default();
    // Try to recover the full 25-char key from DigitalProductId. If the
    // decoded string's last-5 char group matches SPP's PartialProductKey we
    // trust it; otherwise it's the "BBBBB-BBBBB-…" post-1607 junk and we
    // drop it back to partial-only.
    let decoded_full = recover_windows_full_key();
    let mut skus: Vec<Value> = Vec::new();
    for r in win_rows {
        let sc = r.LicenseStatus;
        let last5 = &r.PartialProductKey;
        // Priority: decoded blob if last-5 matches → decoded, else GVLK
        // lookup by name/channel → GVLK, else null (partial only).
        let full_key: Option<String> = decoded_full.as_ref().and_then(|k| {
            let dec_last5 = k.rsplitn(2, '-').next().unwrap_or("");
            if !last5.is_empty() && dec_last5.eq_ignore_ascii_case(last5) {
                Some(k.clone())
            } else { None }
        }).or_else(|| {
            if r.ProductKeyChannel.contains("Volume") || r.ProductKeyChannel.contains("GVLK") {
                gvlk_for(&r.Name).map(|s| s.to_string())
            } else { None }
        });
        let full_key_source = if full_key.is_some() {
            if decoded_full.is_some() && full_key == decoded_full { "decoded" } else { "gvlk_public" }
        } else { "unavailable" };
        skus.push(json!({
            "sku_name": r.Name,
            "activation_channel": r.ProductKeyChannel,
            "partial_product_key": r.PartialProductKey,
            "full_product_key": full_key,
            "full_key_source": full_key_source,
            "license_status_code": sc,
            "license_status": license_status_text(sc.unwrap_or(-1)),
        }));
    }
    Some(json!({
        "oem_product_key": oem_key,
        "active_skus": skus,
    }))
}

/// Any OTHER SPP-tracked product with a PartialProductKey — Microsoft Office
/// (all editions), Visio, Project, some Server SKUs. Anti-piracy limit means
/// we get the last 5 chars only, never the full key, but that's still enough
/// to prove which key an admin allocated to which endpoint. Non-Windows
/// license coverage was zero before this — third-party product keys (Adobe,
/// AutoCAD, IDM…) live in encrypted vendor-specific stores and are out of
/// scope; a Product Keys section that just lists MS SPP is honest.
#[cfg(target_os = "windows")]
fn probe_product_licenses() -> Value {
    #[derive(Deserialize)]
    struct Sku {
        #[serde(default)] Name: String,
        #[serde(default)] PartialProductKey: String,
        #[serde(default)] ProductKeyChannel: String,
        LicenseStatus: Option<i32>,
    }
    let rows = ps_rows::<Sku>(
        "Get-CimInstance SoftwareLicensingProduct -Filter \"NOT Name LIKE 'Windows%'\" | Where-Object { $_.PartialProductKey } | Select Name, PartialProductKey, ProductKeyChannel, LicenseStatus"
    ).unwrap_or_default();
    let items: Vec<Value> = rows.into_iter().map(|r| {
        let sc = r.LicenseStatus;
        // Volume:GVLK products carry a public generic key — look it up
        // by SKU name. Retail Office keys are not retrievable on modern
        // Office (post-2016, token-based activation); return None there.
        let full_key: Option<String> = if r.ProductKeyChannel.contains("Volume") || r.ProductKeyChannel.contains("GVLK") {
            gvlk_for(&r.Name).map(|s| s.to_string())
        } else { None };
        let full_key_source = if full_key.is_some() { "gvlk_public" } else { "unavailable" };
        json!({
            "name": r.Name,
            "partial_product_key": r.PartialProductKey,
            "full_product_key": full_key,
            "full_key_source": full_key_source,
            "activation_channel": r.ProductKeyChannel,
            "license_status_code": sc,
            "license_status": license_status_text(sc.unwrap_or(-1)),
        })
    }).collect();
    json!(items)
}

// -----------------------------------------------------------------------------
// Product-key recovery. Microsoft's SPP API only exposes PartialProductKey
// (the last 5 chars) since Windows 10 1607 — the OEM BIOS key stays fully
// retrievable via OA3xOriginalProductKey, but the CURRENTLY-INSTALLED key
// after that is officially opaque. Two workarounds cover most cases:
//
//   1. DigitalProductId decoder. Windows / Office store an encrypted 172-byte
//      blob under
//        HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\DigitalProductId
//        HKLM\SOFTWARE\Microsoft\Office\<ver>\Registration\{clsid}\DigitalProductID
//      Bytes 52..67 hold the key encoded in a base-24 alphabet ("BCDFGHJKMPQRT
//      VWXY2346789"). Works on Windows 7 / 8 / 8.1 / older Server, and on
//      Office 2010-2016. Post-Windows 10 1607 Microsoft randomised these
//      bytes at install time, so the decoded string is junk ("BBBBB-BBBBB-…")
//      and we drop it by comparing its last 5 chars against the SPP-reported
//      PartialProductKey.
//
//   2. KMS / Volume License GVLK lookup. Products activated via KMS use the
//      Generic Volume License Key that Microsoft PUBLISHES for that SKU. The
//      key isn't a secret — it's the same string on every KMS-activated
//      endpoint on the planet. Match by ProductKeyChannel = "Volume:GVLK"
//      + Name substring against a small in-code table.
// -----------------------------------------------------------------------------

/// Base-24 alphabet Microsoft uses for the DigitalProductId payload.
#[cfg(target_os = "windows")]
const DIGIT_MAP: &[u8] = b"BCDFGHJKMPQRTVWXY2346789";

/// Decode the 15-byte key payload at offset 52..67 of a Microsoft
/// DigitalProductId blob into the 25-char CD-key string (XXXXX-XXXXX-XXXXX-
/// XXXXX-XXXXX). Algorithm is the classic base-24 division loop; see the
/// public write-ups by NirSoft / Belarc for the derivation.
#[cfg(target_os = "windows")]
fn decode_digital_product_id(blob: &[u8]) -> Option<String> {
    if blob.len() < 67 { return None; }
    let mut key_bytes: [u8; 15] = blob[52..67].try_into().ok()?;
    let mut chars = [0u8; 25];
    for i in (0..25).rev() {
        let mut cur = 0u32;
        for j in (0..15).rev() {
            cur = (cur << 8) | key_bytes[j] as u32;
            key_bytes[j] = (cur / 24) as u8;
            cur %= 24;
        }
        chars[i] = DIGIT_MAP[cur as usize];
    }
    let mut out = String::with_capacity(29);
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && i % 5 == 0 { out.push('-'); }
        out.push(*c as char);
    }
    // Junk-detector: on Win 10 1607+ every group is "BBBBB" or has a single
    // non-B char. Reject anything whose base24-value distribution looks like
    // that — the SPP PartialProductKey comparison in probe_windows_license
    // is the authoritative check, but this cheap sanity filter avoids
    // shipping "BBBBB-BBBBB-…" strings when SPP happens to fail too.
    let non_b = out.chars().filter(|c| c.is_ascii_alphanumeric() && *c != 'B').count();
    if non_b < 5 { return None; }
    Some(out)
}

/// Read a REG_BINARY registry value and return its raw bytes. Uses `reg query`
/// so we don't depend on the winreg crate.
#[cfg(target_os = "windows")]
fn reg_read_binary(hive_path: &str, value_name: &str) -> Option<Vec<u8>> {
    let mut cmd = Command::new("reg");
    cmd.args(["query", hive_path, "/v", value_name]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    // Line looks like:  DigitalProductId    REG_BINARY    A400000003000000...
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with(value_name) { continue; }
        let mut parts = trimmed.split_whitespace().skip(1);
        let ty = parts.next().unwrap_or("");
        if ty != "REG_BINARY" { continue; }
        let hex = parts.next().unwrap_or("");
        if hex.len() < 134 { continue; } // 67 bytes minimum
        let mut bytes = Vec::with_capacity(hex.len() / 2);
        for i in (0..hex.len()).step_by(2) {
            let byte = u8::from_str_radix(&hex[i..i+2], 16).ok()?;
            bytes.push(byte);
        }
        return Some(bytes);
    }
    None
}

/// Extract the CD-key from HKLM's Windows NT DigitalProductId. Returns None
/// on modern Windows 10/11 (Microsoft randomises the blob at install time),
/// which is intentional — we prefer showing "partial only" over shipping a
/// junk decoded string.
#[cfg(target_os = "windows")]
fn recover_windows_full_key() -> Option<String> {
    let blob = reg_read_binary(
        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "DigitalProductId",
    )?;
    decode_digital_product_id(&blob)
}

/// Known Microsoft-published KMS/GVLK strings. Not secret — Microsoft
/// publishes these on learn.microsoft.com for every VL SKU. Matched by the
/// SPP Name substring when ProductKeyChannel == "Volume:GVLK".
#[cfg(target_os = "windows")]
const GVLK_TABLE: &[(&str, &str)] = &[
    // Windows 11 VL — most common editions.
    ("Windows 11 Pro",              "W269N-WFGWX-YVC9B-4J6C9-T83GX"),
    ("Windows 11 Enterprise",       "NPPR9-FWDCX-D2C8J-H872K-2YT43"),
    ("Windows 11 Education",        "NW6C2-QMPVW-D7KKK-3GKT6-VCFB2"),
    // Windows 10 VL.
    ("Windows 10 Pro",              "W269N-WFGWX-YVC9B-4J6C9-T83GX"),
    ("Windows 10 Enterprise",       "NPPR9-FWDCX-D2C8J-H872K-2YT43"),
    ("Windows 10 Education",        "NW6C2-QMPVW-D7KKK-3GKT6-VCFB2"),
    // Office 2024 LTSC / ProPlus VL.
    ("Office24ProPlus2024VL",       "XJ2XN-FW8RK-P4HMP-DKDBV-GQ7XM"),
    ("ProPlus2024Volume",           "XJ2XN-FW8RK-P4HMP-DKDBV-GQ7XM"),
    ("Office LTSC Professional Plus 2024", "XJ2XN-FW8RK-P4HMP-DKDBV-GQ7XM"),
    // Office 2021 LTSC VL.
    ("ProPlus2021Volume",           "FXYTK-NJJ8C-GB6DW-3DYQT-6F7TH"),
    ("Office LTSC Professional Plus 2021", "FXYTK-NJJ8C-GB6DW-3DYQT-6F7TH"),
    // Office 2019 VL.
    ("ProPlus2019Volume",           "NMMKJ-6RK4F-KMJVX-8D9MJ-6MWKP"),
    // Office 2016 VL.
    ("ProPlusVL_KMS_Client",        "XQNVK-8JYDB-WJ9W3-YJ8YR-WFG99"),
    ("StandardVL_KMS_Client",       "JNRGM-WHDWX-FJJG3-K47QV-DRTFM"),
];

#[cfg(target_os = "windows")]
fn gvlk_for(name: &str) -> Option<&'static str> {
    for (needle, key) in GVLK_TABLE {
        if name.contains(needle) { return Some(*key); }
    }
    None
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

/// System serial (SMBIOS "Chassis" serial). Same admin-visible string that
/// goes into hardware_assets.device_serial. Tries three CIM classes in
/// order until we get a real value — OEM defaults ("Default string", "To be
/// filled by O.E.M.", …) filtered.
#[cfg(target_os = "windows")]
fn probe_system_serial() -> Option<Value> {
    #[derive(Deserialize)] struct One { #[serde(rename = "V")] v: Option<String> }
    let bad = ["", "None", "Default string", "To be filled by O.E.M.", "System Serial Number", "Not Specified", "0"];
    let queries = [
        "Get-CimInstance Win32_BIOS | Select-Object @{n='V';e={$_.SerialNumber}}",
        "Get-CimInstance Win32_ComputerSystemProduct | Select-Object @{n='V';e={$_.IdentifyingNumber}}",
        "Get-CimInstance Win32_SystemEnclosure | Select-Object @{n='V';e={$_.SerialNumber}}",
    ];
    for q in queries {
        if let Some(rows) = ps_rows::<One>(q) {
            for r in rows {
                if let Some(v) = r.v {
                    let trimmed = v.trim().to_string();
                    if !bad.iter().any(|b| b.eq_ignore_ascii_case(&trimmed)) {
                        return Some(Value::String(trimmed));
                    }
                }
            }
        }
    }
    None
}

// Non-Windows probe_system_serial variants live further down alongside the
// rest of the macOS / Linux platform gates.

#[cfg(target_os = "windows")]
fn probe_cpu() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] Name: String,
        NumberOfCores: Option<i64>,
        NumberOfLogicalProcessors: Option<i64>,
        MaxClockSpeed: Option<i64>,
        #[serde(default)] SocketDesignation: String,
    }
    let row: Row = ps_rows::<Row>(
        "Get-CimInstance Win32_Processor | Select Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, SocketDesignation"
    )?.into_iter().next()?;
    Some(json!({
        "name": row.Name,
        "cores": row.NumberOfCores,
        "logical_processors": row.NumberOfLogicalProcessors,
        "max_clock_mhz": row.MaxClockSpeed,
        "socket": row.SocketDesignation,
    }))
}

#[cfg(target_os = "windows")]
fn probe_memory() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        Capacity: Option<serde_json::Value>, // uint64 → JSON number or string; be lenient
        #[serde(default)] Manufacturer: String,
        Speed: Option<i64>,
        #[serde(default)] PartNumber: String,
        #[serde(default)] DeviceLocator: String,
    }
    fn as_u64(v: &Option<serde_json::Value>) -> Option<u64> {
        match v {
            Some(serde_json::Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
            Some(serde_json::Value::String(s)) => s.parse::<u64>().ok(),
            _ => None,
        }
    }
    let rows = ps_rows::<Row>(
        "Get-CimInstance Win32_PhysicalMemory | Select Capacity, Manufacturer, Speed, PartNumber, DeviceLocator"
    )?;
    let mut slots = Vec::new();
    let mut total_bytes: u64 = 0;
    for r in rows {
        if let Some(cap) = as_u64(&r.Capacity) {
            total_bytes = total_bytes.saturating_add(cap);
            slots.push(json!({
                "capacity_bytes": cap,
                "capacity_gb": (cap as f64 / 1_073_741_824.0 * 100.0).round() / 100.0,
                "manufacturer": r.Manufacturer.trim().to_string(),
                "speed_mhz": r.Speed,
                "part_number": r.PartNumber.trim().to_string(),
                "slot": r.DeviceLocator,
            }));
        }
    }
    if slots.is_empty() { return None; }
    Some(json!({
        "total_bytes": total_bytes,
        "total_gb": (total_bytes as f64 / 1_073_741_824.0 * 100.0).round() / 100.0,
        "slots": slots,
    }))
}

#[cfg(target_os = "windows")]
fn probe_disks() -> Option<Value> {
    // Status returns "OK" normally, "Pred Fail" when SMART's predict-failure
    // flag is set. Single most actionable disk-health signal available
    // without a real SMART library.
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] Model: String,
        Size: Option<serde_json::Value>,
        #[serde(default)] SerialNumber: String,
        #[serde(default)] Status: String,
        #[serde(default)] MediaType: String,
        #[serde(default)] InterfaceType: String,
    }
    let rows = ps_rows::<Row>(
        "Get-CimInstance Win32_DiskDrive | Select Model, Size, SerialNumber, Status, MediaType, InterfaceType"
    )?;
    let disks: Vec<Value> = rows.into_iter().filter_map(|r| {
        let size_bytes: u64 = match r.Size {
            Some(serde_json::Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64))?,
            Some(serde_json::Value::String(s)) => s.parse::<u64>().ok()?,
            _ => return None,
        };
        if size_bytes == 0 { return None; }
        Some(json!({
            "model": r.Model.trim().to_string(),
            "size_bytes": size_bytes,
            "size_gb": (size_bytes as f64 / 1_073_741_824.0).round(),
            "serial_number": r.SerialNumber.trim().to_string(),
            "status": r.Status.clone(),
            "predict_failure": !r.Status.eq_ignore_ascii_case("OK") && !r.Status.is_empty(),
            "media_type": r.MediaType,
            "interface": r.InterfaceType,
        }))
    }).collect();
    if disks.is_empty() { None } else { Some(json!(disks)) }
}

#[cfg(target_os = "windows")]
fn probe_gpu() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] Name: String,
        AdapterRAM: Option<serde_json::Value>,
        #[serde(default)] DriverVersion: String,
        #[serde(default)] VideoProcessor: String,
    }
    let rows = ps_rows::<Row>(
        "Get-CimInstance Win32_VideoController | Select Name, AdapterRAM, DriverVersion, VideoProcessor"
    )?;
    let gpus: Vec<Value> = rows.into_iter().filter_map(|r| {
        if r.Name.trim().is_empty() { return None; }
        let vram = match r.AdapterRAM {
            Some(serde_json::Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
            Some(serde_json::Value::String(s)) => s.parse::<u64>().ok(),
            _ => None,
        };
        Some(json!({
            "name": r.Name,
            "vram_bytes": vram,
            "driver_version": r.DriverVersion,
            "processor": r.VideoProcessor,
        }))
    }).collect();
    if gpus.is_empty() { None } else { Some(json!(gpus)) }
}

#[cfg(target_os = "windows")]
fn probe_motherboard() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] Manufacturer: String,
        #[serde(default)] Product: String,
        #[serde(default)] SerialNumber: String,
        #[serde(default)] Version: String,
    }
    let r = ps_rows::<Row>(
        "Get-CimInstance Win32_BaseBoard | Select Manufacturer, Product, SerialNumber, Version"
    )?.into_iter().next()?;
    Some(json!({
        "manufacturer": r.Manufacturer,
        "model": r.Product,
        "serial_number": r.SerialNumber,
        "version": r.Version,
    }))
}

#[cfg(target_os = "windows")]
fn probe_bios() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] Manufacturer: String,
        #[serde(default)] Version: String,
        #[serde(default)] SMBIOSBIOSVersion: String,
        #[serde(default)] ReleaseDate: String,
    }
    let r = ps_rows::<Row>(
        "Get-CimInstance Win32_BIOS | Select Manufacturer, Version, SMBIOSBIOSVersion, ReleaseDate"
    )?.into_iter().next()?;
    Some(json!({
        "manufacturer": r.Manufacturer,
        "version": r.Version,
        "smbios_version": r.SMBIOSBIOSVersion,
        "release_date": r.ReleaseDate,
    }))
}

#[cfg(target_os = "windows")]
fn probe_os() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] Caption: String,
        #[serde(default)] Version: String,
        #[serde(default)] BuildNumber: String,
        #[serde(default)] OSArchitecture: String,
        #[serde(default)] InstallDate: String,
        OperatingSystemSKU: Option<i32>,
        #[serde(default)] MUILanguages: Vec<String>,
        #[serde(default)] Locale: String,
    }
    let r = ps_rows::<Row>(
        "Get-CimInstance Win32_OperatingSystem | Select Caption, Version, BuildNumber, OSArchitecture, InstallDate, OperatingSystemSKU, MUILanguages, Locale"
    )?.into_iter().next()?;
    let sku_code = r.OperatingSystemSKU.unwrap_or(0);
    let sku_name = match sku_code {
        4 => "Enterprise", 27 => "Enterprise N", 48 => "Professional",
        49 => "Professional N", 98 => "Home", 100 => "Home N",
        101 => "Home Single Language", 103 => "Professional with Media Center",
        121 => "Education", 125 => "Enterprise LTSB",
        161 => "Pro for Workstations", _ => "Other",
    };
    Some(json!({
        "name": r.Caption,
        "version": r.Version,
        "build": r.BuildNumber,
        "architecture": r.OSArchitecture,
        "install_date": r.InstallDate,
        "sku_code": sku_code,
        "sku_name": sku_name,
        "languages": r.MUILanguages,
        "locale": r.Locale,
    }))
}

/// Win32_ComputerSystem: hostname + brand + model + user + domain +
/// PC-system-type. This is the Intune "Manufacturer / Model / Name" row.
#[cfg(target_os = "windows")]
fn probe_computer_system() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] DNSHostName: String,
        #[serde(default)] Manufacturer: String,
        #[serde(default)] Model: String,
        #[serde(default)] UserName: String,
        #[serde(default)] Domain: String,
        PCSystemType: Option<i32>,
        TotalPhysicalMemory: Option<serde_json::Value>,
    }
    let r = ps_rows::<Row>(
        "Get-CimInstance Win32_ComputerSystem | Select DNSHostName, Manufacturer, Model, UserName, Domain, PCSystemType, TotalPhysicalMemory"
    )?.into_iter().next()?;
    let sys_type = match r.PCSystemType {
        Some(1) => "Desktop", Some(2) => "Mobile", Some(3) => "Workstation",
        Some(4) => "Enterprise server", Some(5) => "SOHO server",
        Some(6) => "Appliance PC", Some(7) => "Performance server",
        Some(8) => "Maximum", _ => "Unknown",
    };
    Some(json!({
        "hostname": r.DNSHostName,
        "manufacturer": r.Manufacturer,
        "model": r.Model,
        "current_user": r.UserName,
        "domain": r.Domain,
        "system_type": sys_type,
    }))
}

/// Per-volume storage stats — total + free bytes for each fixed drive
/// (DriveType=3). Matches Intune's "Total storage space / Free storage
/// space" but broken down per letter so an admin can see WHICH drive is
/// full without RDPing in.
#[cfg(target_os = "windows")]
fn probe_volumes() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] DeviceID: String,
        #[serde(default)] VolumeName: String,
        Size: Option<serde_json::Value>,
        FreeSpace: Option<serde_json::Value>,
        #[serde(default)] FileSystem: String,
    }
    fn as_u64(v: &Option<serde_json::Value>) -> u64 {
        match v {
            Some(serde_json::Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)).unwrap_or(0),
            Some(serde_json::Value::String(s)) => s.parse::<u64>().unwrap_or(0),
            _ => 0,
        }
    }
    let rows = ps_rows::<Row>(
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select DeviceID, VolumeName, Size, FreeSpace, FileSystem"
    )?;
    let vols: Vec<Value> = rows.into_iter().filter_map(|r| {
        let size = as_u64(&r.Size);
        let free = as_u64(&r.FreeSpace);
        if size == 0 { return None; }
        let gb = 1_073_741_824.0;
        Some(json!({
            "device_id": r.DeviceID,
            "label": r.VolumeName,
            "file_system": r.FileSystem,
            "size_gb": (size as f64 / gb * 100.0).round() / 100.0,
            "free_gb": (free as f64 / gb * 100.0).round() / 100.0,
            "used_pct": if size > 0 { (((size - free) as f64 / size as f64) * 100.0).round() as i32 } else { 0 },
        }))
    }).collect();
    if vols.is_empty() { None } else { Some(json!(vols)) }
}

/// TPM (Trusted Platform Module) health. Same set of fields Intune shows
/// on its Hardware tab. The Win32_Tpm class lives in the special namespace
/// root\CIMV2\Security\MicrosoftTpm.
#[cfg(target_os = "windows")]
fn probe_tpm() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        IsActivated_InitialValue: Option<bool>,
        IsEnabled_InitialValue: Option<bool>,
        IsOwned_InitialValue: Option<bool>,
        #[serde(default)] SpecVersion: String,
        #[serde(default)] ManufacturerIdTxt: String,
        #[serde(default)] ManufacturerVersion: String,
        #[serde(default)] PhysicalPresenceVersionInfo: String,
    }
    let r = ps_rows::<Row>(
        "Get-CimInstance -Namespace 'root\\CIMV2\\Security\\MicrosoftTpm' Win32_Tpm -ErrorAction SilentlyContinue | Select IsActivated_InitialValue, IsEnabled_InitialValue, IsOwned_InitialValue, SpecVersion, ManufacturerIdTxt, ManufacturerVersion, PhysicalPresenceVersionInfo"
    )?.into_iter().next()?;
    Some(json!({
        "activated": r.IsActivated_InitialValue,
        "enabled": r.IsEnabled_InitialValue,
        "owned": r.IsOwned_InitialValue,
        "spec_version": r.SpecVersion,
        "manufacturer_id": r.ManufacturerIdTxt,
        "manufacturer_version": r.ManufacturerVersion,
        "physical_presence_version": r.PhysicalPresenceVersionInfo,
    }))
}

/// Last Windows Update installed — the "Security patch level" row on Intune.
/// Get-Hotfix is fast (< 500 ms) and covers KB IDs, install dates, and
/// descriptions across every history-carrying source.
#[cfg(target_os = "windows")]
fn probe_last_patch() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] HotFixID: String,
        InstalledOn: Option<serde_json::Value>,
        #[serde(default)] Description: String,
    }
    let rows = ps_rows::<Row>(
        "Get-Hotfix | Sort-Object -Property InstalledOn -Descending | Select-Object -First 5 HotFixID, InstalledOn, Description"
    )?;
    let mut items = Vec::new();
    for r in rows {
        // InstalledOn arrives as either an ISO string or a CIM datetime
        // object; ConvertTo-Json flattens to a string field with DateTime.
        let installed = match r.InstalledOn {
            Some(serde_json::Value::String(s)) => s,
            Some(v) => v.to_string(),
            None => String::new(),
        };
        items.push(json!({
            "kb": r.HotFixID,
            "installed_on": installed,
            "description": r.Description,
        }));
    }
    if items.is_empty() { None } else { Some(json!(items)) }
}

/// Microsoft Entra (Azure AD) join status. dsregcmd /status is the
/// authoritative source; we scrape the AzureAdJoined / DomainJoined /
/// TenantId / TenantName lines. Runs unprivileged.
#[cfg(target_os = "windows")]
fn probe_aad_join() -> Option<Value> {
    let mut cmd = Command::new("dsregcmd");
    cmd.args(["/status"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    crate::win_proc::no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    fn field(text: &str, key: &str) -> String {
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix(key) {
                return rest.trim_start_matches(':').trim().to_string();
            }
        }
        String::new()
    }
    let aad_joined = field(&text, "AzureAdJoined");
    let domain_joined = field(&text, "DomainJoined");
    let workplace_joined = field(&text, "WorkplaceJoined");
    if aad_joined.is_empty() && domain_joined.is_empty() { return None; }
    Some(json!({
        "azure_ad_joined": aad_joined.eq_ignore_ascii_case("YES"),
        "domain_joined": domain_joined.eq_ignore_ascii_case("YES"),
        "workplace_joined": workplace_joined.eq_ignore_ascii_case("YES"),
        "tenant_name": field(&text, "TenantName"),
        "tenant_id": field(&text, "TenantId"),
        "device_id": field(&text, "DeviceId"),
    }))
}

#[cfg(target_os = "windows")]
fn probe_network_adapters() -> Option<Value> {
    // Join Win32_NetworkAdapter (physical row + MAC) with
    // Win32_NetworkAdapterConfiguration (per-index IPAddress). Powershell
    // one-liner does the join by Index so we get MAC + IPv4 + subnet on
    // the same row — that's what admins expect from Intune's Wi-Fi/wired
    // IP columns.
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] Name: String,
        #[serde(default)] NetConnectionID: String,
        #[serde(default)] MACAddress: String,
        Speed: Option<serde_json::Value>,
        #[serde(default)] AdapterType: String,
        #[serde(default)] IPv4: Vec<String>,
        #[serde(default)] IPSubnet: Vec<String>,
        #[serde(default)] Gateway: Vec<String>,
    }
    let script = "\
Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=true' | ForEach-Object { \
  $idx = $_.InterfaceIndex; \
  $cfg = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter (\"InterfaceIndex=\" + $idx) | Select-Object -First 1; \
  [PSCustomObject]@{ \
    Name = $_.Name; \
    NetConnectionID = $_.NetConnectionID; \
    MACAddress = $_.MACAddress; \
    Speed = $_.Speed; \
    AdapterType = $_.AdapterType; \
    IPv4 = @($cfg.IPAddress | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' }); \
    IPSubnet = @($cfg.IPSubnet | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' }); \
    Gateway = @($cfg.DefaultIPGateway | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' }); \
  } \
}";
    let rows = ps_rows::<Row>(script)?;
    let nics: Vec<Value> = rows.into_iter().filter_map(|r| {
        if r.Name.trim().is_empty() { return None; }
        let speed = match r.Speed {
            Some(serde_json::Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
            Some(serde_json::Value::String(s)) => s.parse::<u64>().ok(),
            _ => None,
        };
        let conn = r.NetConnectionID.to_lowercase();
        let kind = if conn.contains("wi-fi") || conn.contains("wifi") || conn.contains("wireless") {
            "wifi"
        } else if conn.contains("ethernet") || conn.contains("local area") {
            "ethernet"
        } else { "other" };
        Some(json!({
            "name": r.Name,
            "connection_name": r.NetConnectionID,
            "kind": kind,
            "mac_address": r.MACAddress,
            "speed_bps": speed,
            "adapter_type": r.AdapterType,
            "ipv4": r.IPv4,
            "subnet": r.IPSubnet,
            "gateway": r.Gateway,
        }))
    }).collect();
    if nics.is_empty() { None } else { Some(json!(nics)) }
}

/// BitLocker encryption status per volume. Get-BitLockerVolume is the
/// canonical source (ships with Windows since 8/8.1/10). Non-fatal on
/// SKUs that lack BitLocker (Home) — returns None quietly.
#[cfg(target_os = "windows")]
fn probe_bitlocker() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)] MountPoint: String,
        #[serde(default)] VolumeType: String,
        #[serde(default)] EncryptionMethod: String,
        VolumeStatus: Option<i32>,
        EncryptionPercentage: Option<i32>,
        ProtectionStatus: Option<i32>,
    }
    let rows = ps_rows::<Row>(
        "Get-BitLockerVolume -ErrorAction SilentlyContinue | Select MountPoint, VolumeType, EncryptionMethod, VolumeStatus, EncryptionPercentage, ProtectionStatus"
    )?;
    let vols: Vec<Value> = rows.into_iter().map(|r| {
        let vol_status_text = match r.VolumeStatus {
            Some(0) => "FullyDecrypted", Some(1) => "FullyEncrypted",
            Some(2) => "EncryptionInProgress", Some(3) => "DecryptionInProgress",
            Some(4) => "EncryptionPaused", Some(5) => "DecryptionPaused",
            _ => "Unknown",
        };
        json!({
            "mount": r.MountPoint,
            "volume_type": r.VolumeType,
            "encryption_method": r.EncryptionMethod,
            "encryption_pct": r.EncryptionPercentage,
            "volume_status": vol_status_text,
            "protection_on": matches!(r.ProtectionStatus, Some(1)),
        })
    }).collect();
    if vols.is_empty() { None } else { Some(json!(vols)) }
}

// -----------------------------------------------------------------------------
// macOS probes. system_profiler -json is the canonical machine-readable
// entry point (in-box since 10.12); pmset for battery health. No sudo
// required for any of these paths.
// -----------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn sp_json(data_type: &str) -> Option<Value> {
    let out = Command::new("/usr/sbin/system_profiler")
        .args([data_type, "-json"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    serde_json::from_slice::<Value>(&out.stdout).ok()
}

#[cfg(target_os = "macos")]
fn probe_cpu() -> Option<Value> {
    let root = sp_json("SPHardwareDataType")?;
    let item = root.get("SPHardwareDataType")?.as_array()?.first()?;
    Some(json!({
        "name": item.get("chip_type").or_else(|| item.get("cpu_type")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "cores": item.get("number_processors").and_then(|v| v.as_i64()),
        "logical_processors": item.get("number_processors").and_then(|v| v.as_i64()),
        "socket": "",
    }))
}

#[cfg(target_os = "macos")]
fn probe_memory() -> Option<Value> {
    let root = sp_json("SPHardwareDataType")?;
    let item = root.get("SPHardwareDataType")?.as_array()?.first()?;
    // On Apple Silicon system_profiler reports "16 GB" as a string; parse it.
    let total_str = item.get("physical_memory").and_then(|v| v.as_str()).unwrap_or("");
    let total_gb: Option<f64> = total_str.split_whitespace().next().and_then(|s| s.parse::<f64>().ok());
    let total_bytes = total_gb.map(|g| (g * 1_073_741_824.0) as u64).unwrap_or(0);
    Some(json!({
        "total_bytes": total_bytes,
        "total_gb": total_gb.map(|g| (g * 100.0).round() / 100.0),
        "slots": [],
    }))
}

#[cfg(target_os = "macos")]
fn probe_disks() -> Option<Value> {
    // SPStorageDataType lists mounted volumes; SPNVMeDataType / SPSerialATA-
    // DataType have physical devices with SMART status.
    let mut disks = Vec::new();
    if let Some(root) = sp_json("SPNVMeDataType") {
        if let Some(arr) = root.get("SPNVMeDataType").and_then(|v| v.as_array()) {
            for controller in arr {
                if let Some(items) = controller.get("_items").and_then(|v| v.as_array()) {
                    for d in items {
                        let smart = d.get("smart_status").and_then(|v| v.as_str()).unwrap_or("");
                        disks.push(json!({
                            "model": d.get("device_model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            "size_bytes": d.get("size_in_bytes").and_then(|v| v.as_u64()).unwrap_or(0),
                            "size_gb": d.get("size_in_bytes").and_then(|v| v.as_u64()).map(|b| (b as f64 / 1_073_741_824.0).round() as u64).unwrap_or(0),
                            "serial_number": d.get("device_serial").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            "status": smart.to_string(),
                            "predict_failure": !smart.eq_ignore_ascii_case("verified") && !smart.is_empty(),
                            "media_type": "NVMe",
                            "interface": "NVMe",
                        }));
                    }
                }
            }
        }
    }
    if disks.is_empty() { None } else { Some(json!(disks)) }
}

#[cfg(target_os = "macos")]
fn probe_gpu() -> Option<Value> {
    let root = sp_json("SPDisplaysDataType")?;
    let arr = root.get("SPDisplaysDataType")?.as_array()?;
    let gpus: Vec<Value> = arr.iter().filter_map(|g| {
        let name = g.get("sppci_model").and_then(|v| v.as_str())?.to_string();
        Some(json!({
            "name": name,
            "vram_bytes": g.get("spdisplays_vram").and_then(|v| v.as_str()).and_then(|s| {
                s.split_whitespace().next()?.parse::<u64>().ok().map(|n| n * 1_073_741_824)
            }),
            "driver_version": g.get("sppci_bus").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "processor": g.get("sppci_cores").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }))
    }).collect();
    if gpus.is_empty() { None } else { Some(json!(gpus)) }
}

#[cfg(target_os = "macos")]
fn probe_motherboard() -> Option<Value> {
    let root = sp_json("SPHardwareDataType")?;
    let item = root.get("SPHardwareDataType")?.as_array()?.first()?;
    Some(json!({
        "manufacturer": "Apple",
        "model": item.get("machine_model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "serial_number": item.get("serial_number").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "version": item.get("model_number").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    }))
}

#[cfg(target_os = "macos")]
fn probe_bios() -> Option<Value> {
    let root = sp_json("SPHardwareDataType")?;
    let item = root.get("SPHardwareDataType")?.as_array()?.first()?;
    Some(json!({
        "manufacturer": "Apple",
        "version": item.get("boot_rom_version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "smbios_version": item.get("SMC_version_system").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "release_date": "",
    }))
}

#[cfg(target_os = "macos")]
fn probe_os() -> Option<Value> {
    let root = sp_json("SPSoftwareDataType")?;
    let item = root.get("SPSoftwareDataType")?.as_array()?.first()?;
    let os_ver = item.get("os_version").and_then(|v| v.as_str()).unwrap_or("");
    Some(json!({
        "name": "macOS",
        "version": os_ver,
        "build": item.get("kernel_version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "architecture": std::env::consts::ARCH,
        "install_date": "",
    }))
}

#[cfg(target_os = "macos")]
fn probe_network_adapters() -> Option<Value> {
    let root = sp_json("SPNetworkDataType")?;
    let arr = root.get("SPNetworkDataType")?.as_array()?;
    let nics: Vec<Value> = arr.iter().filter_map(|n| {
        let name = n.get("_name").and_then(|v| v.as_str())?.to_string();
        Some(json!({
            "name": name,
            "mac_address": n.get("hardware_mac_address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "speed_bps": serde_json::Value::Null,
            "adapter_type": n.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }))
    }).collect();
    if nics.is_empty() { None } else { Some(json!(nics)) }
}

#[cfg(target_os = "macos")]
fn probe_system_serial() -> Option<Value> {
    let root = sp_json("SPHardwareDataType")?;
    let item = root.get("SPHardwareDataType")?.as_array()?.first()?;
    let sn = item.get("serial_number").and_then(|v| v.as_str())?.trim().to_string();
    if sn.is_empty() { None } else { Some(Value::String(sn)) }
}

// -----------------------------------------------------------------------------
// Linux / other-Unix — no probes yet; fleet is Windows + Mac.
// -----------------------------------------------------------------------------

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_cpu() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_memory() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_disks() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_gpu() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_motherboard() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_bios() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_os() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_network_adapters() -> Option<Value> { None }
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn probe_system_serial() -> Option<Value> { None }

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

/// macOS installed apps — system_profiler SPApplicationsDataType is
/// authoritative but SLOW (~30-60 s on a laptop with 400+ apps). Cheaper:
/// enumerate /Applications and ~/Applications and read the CFBundle*
/// keys from each Info.plist.
#[cfg(target_os = "macos")]
fn collect_software() -> Value {
    fn scan(dir: &std::path::Path, out: &mut Vec<Value>, seen: &mut std::collections::HashSet<String>) {
        let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("app") { continue; }
            let plist = path.join("Contents/Info.plist");
            let bytes = match std::fs::read(&plist) { Ok(b) => b, Err(_) => continue };
            // Cheap XML-plist scrape — no crate. macOS ships both binary and
            // XML Info.plist; the binary ones we skip (would need plist crate).
            let text = String::from_utf8_lossy(&bytes);
            if !text.contains("<?xml") { continue; }
            let name = plist_str(&text, "CFBundleName")
                .or_else(|| plist_str(&text, "CFBundleDisplayName"))
                .unwrap_or_else(|| path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string());
            if name.is_empty() { continue; }
            let key = name.to_lowercase();
            if !seen.insert(key) { continue; }
            let version = plist_str(&text, "CFBundleShortVersionString")
                .or_else(|| plist_str(&text, "CFBundleVersion"))
                .unwrap_or_default();
            let publisher = plist_str(&text, "CFBundleIdentifier").unwrap_or_default();
            out.push(json!({
                "name": name,
                "version": version,
                "publisher": publisher,
                "install_date": "",
            }));
        }
    }
    let mut items: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    scan(std::path::Path::new("/Applications"), &mut items, &mut seen);
    if let Some(home) = dirs::home_dir() {
        scan(&home.join("Applications"), &mut items, &mut seen);
    }
    items.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    json!(items)
}

#[cfg(target_os = "macos")]
fn plist_str(text: &str, key: &str) -> Option<String> {
    let needle = format!("<key>{key}</key>");
    let start = text.find(&needle)? + needle.len();
    let after = &text[start..];
    let open = after.find("<string>")? + "<string>".len();
    let close = after[open..].find("</string>")?;
    Some(after[open..open+close].to_string())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn collect_software() -> Value {
    json!([])
}

// ---------------------------------------------------------------------------
// Battery health — full charge vs design capacity (aging %).
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn collect_battery() -> Option<Value> {
    #[derive(Deserialize)]
    struct Row {
        EstimatedChargeRemaining: Option<i32>,
        BatteryStatus: Option<i32>,
        DesignCapacity: Option<i64>,
        FullChargeCapacity: Option<i64>,
    }
    let r = ps_rows::<Row>(
        "Get-CimInstance Win32_Battery | Select EstimatedChargeRemaining, BatteryStatus, DesignCapacity, FullChargeCapacity"
    )?.into_iter().next()?;
    let health_pct = match (r.DesignCapacity, r.FullChargeCapacity) {
        (Some(d), Some(f)) if d > 0 => Some(((f as f64 / d as f64) * 100.0).round() as i32),
        _ => None,
    };
    Some(json!({
        "estimated_charge_pct": r.EstimatedChargeRemaining,
        "status_code": r.BatteryStatus,
        "design_capacity_mwh": r.DesignCapacity,
        "full_capacity_mwh": r.FullChargeCapacity,
        "health_pct": health_pct,
    }))
}

/// macOS battery health via SPPowerDataType (system_profiler).
/// health_pct = MaxCapacity / DesignCapacity * 100.
#[cfg(target_os = "macos")]
fn collect_battery() -> Option<Value> {
    let root = sp_json("SPPowerDataType")?;
    let arr = root.get("SPPowerDataType")?.as_array()?;
    // Find the "Battery Information" section (schema differs slightly by
    // macOS version; try a few labels).
    for section in arr {
        let key = section.get("_name").and_then(|v| v.as_str()).unwrap_or("");
        if !key.contains("battery") && !key.contains("Battery") { continue; }
        // Charge info + health info nested under sppower_battery_*
        let health = section.get("sppower_battery_health_info");
        let charge = section.get("sppower_battery_charge_info");
        let design = health
            .and_then(|h| h.get("sppower_battery_design_capacity"))
            .and_then(|v| v.as_i64());
        let full = health
            .and_then(|h| h.get("sppower_battery_maximum_capacity"))
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim_end_matches('%').parse::<i64>().ok())));
        let cycle = health
            .and_then(|h| h.get("sppower_battery_cycle_count"))
            .and_then(|v| v.as_i64());
        let charge_pct = charge
            .and_then(|c| c.get("sppower_battery_state_of_charge"))
            .and_then(|v| v.as_i64())
            .map(|n| n as i32);
        let health_pct = match (design, full) {
            (Some(d), Some(f)) if d > 0 => Some(((f as f64 / d as f64) * 100.0).round() as i32),
            (None, Some(f)) => Some(f as i32), // Apple Silicon often reports "%" directly.
            _ => None,
        };
        return Some(json!({
            "estimated_charge_pct": charge_pct,
            "status_code": serde_json::Value::Null,
            "design_capacity_mwh": design,
            "full_capacity_mwh": full,
            "health_pct": health_pct,
            "cycle_count": cycle,
        }));
    }
    None
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
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
    // Return early on any wevtutil failure with an empty array — never
    // fatal for the inventory cycle. Prior code tried `?` on the .ok()
    // which doesn't compile because the fn returns `Value`, not `Option`.
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            log::warn!("inventory: wevtutil spawn failed: {e}");
            return json!([]);
        }
    };
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

/// macOS system errors via `log show --last 24h --predicate 'messageType ==
/// "error" OR messageType == "fault"'`. Unified log is chatty, so cap at
/// 200 lines and take head; we're not shipping the whole log.
#[cfg(target_os = "macos")]
fn collect_system_events() -> Value {
    let out = match Command::new("/usr/bin/log")
        .args([
            "show",
            "--last", "24h",
            "--style", "compact",
            "--predicate", "messageType == \"error\" OR messageType == \"fault\"",
            "--info",
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return json!([]),
    };
    if !out.status.success() { return json!([]); }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut events = Vec::new();
    for line in text.lines().take(50) {
        // Compact style: "2026-09-02 12:34:56.789 Df kernel [msg]" — try to
        // pull timestamp + subsystem + message.
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let (time, rest) = match trimmed.split_once(' ') {
            Some(pair) => pair, None => ("", trimmed),
        };
        let (_flags, msg) = match rest.trim_start().split_once(' ') {
            Some(pair) => pair, None => ("", rest),
        };
        events.push(json!({
            "time": time,
            "event_id": serde_json::Value::Null,
            "level": if trimmed.contains("<Fault>") { "critical" } else { "error" },
            "source": "macOS log",
            "message": msg.chars().take(400).collect::<String>(),
        }));
    }
    json!(events)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
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
        "os_type": std::env::consts::OS,
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

// wmic() and parse_csv() were removed 2026-09-02: every hardware probe
// now goes through ps_rows / ps_json above (Get-CimInstance | ConvertTo-
// Json). See the CIM comment at the top of the file for why. The one
// site that still needed a plain-string wmic-style call — probe_system_
// serial — moved to CIM at the same time.

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

pub async fn run_one(state: &crate::AppState) -> Result<()> {
    one_cycle(state).await
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
