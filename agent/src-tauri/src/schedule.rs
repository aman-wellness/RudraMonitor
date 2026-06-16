// Tracking-schedule gate.
//
// Org admins set working hours via the dashboard. Outside those hours the
// agent pauses ALL capture loops (screenshots, video, USB block, wallpaper,
// DLP, activity logging). The system stays online and continues to send
// heartbeat/metrics so the admin can see the device is alive — just not
// captured.
//
// Schedule JSON shape (matches what the dashboard writes):
//   {
//     "tz": "Asia/Kolkata",
//     "days": {
//       "mon": [{"start":"09:00","end":"18:00"}],
//       "tue": [{"start":"09:00","end":"18:00"}],
//       "wed": [{"start":"09:00","end":"18:00"}],
//       "thu": [{"start":"09:00","end":"18:00"}],
//       "fri": [{"start":"09:00","end":"18:00"}],
//       "sat": [],
//       "sun": []
//     }
//   }
//
// Empty array OR missing key for a day = that day has no working hours
// (agent pauses all day). Multiple ranges per day are supported (e.g.
// 09:00-13:00 + 14:00-18:00 for lunch break) — `is_within` returns true
// if the current time falls inside ANY range.

use chrono::{DateTime, NaiveTime, Timelike, Utc, Weekday, Datelike};
use chrono_tz::Tz;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
struct ScheduleRange {
    start: String,
    end: String,
}

#[derive(Debug, Deserialize)]
struct ScheduleConfig {
    #[serde(default)]
    tz: Option<String>,
    #[serde(default)]
    days: HashMap<String, Vec<ScheduleRange>>,
}

/// Returns true if `now` is INSIDE the working hours defined by the JSON.
///
/// Fail-safe semantics: if the JSON can't be parsed, or the tz string is
/// invalid, or there are no day entries at all, we return TRUE (= "not
/// outside hours"). The schedule is a privacy/compliance feature; an
/// admin who broke the JSON shouldn't accidentally have all their
/// agents stop capturing data. Better to over-capture and let them
/// notice than under-capture silently.
pub fn is_within_tracking_hours(schedule_json: Option<&str>, now_utc: DateTime<Utc>) -> bool {
    let raw = match schedule_json {
        Some(s) if !s.is_empty() => s,
        _ => return true,
    };
    let cfg: ScheduleConfig = match serde_json::from_str(raw) {
        Ok(c) => c,
        Err(_) => return true,
    };
    if cfg.days.is_empty() {
        return true;
    }

    // Resolve timezone. Default to UTC if unspecified or invalid.
    let tz: Tz = cfg
        .tz
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(chrono_tz::UTC);

    let local = now_utc.with_timezone(&tz);
    let weekday_key = match local.weekday() {
        Weekday::Mon => "mon",
        Weekday::Tue => "tue",
        Weekday::Wed => "wed",
        Weekday::Thu => "thu",
        Weekday::Fri => "fri",
        Weekday::Sat => "sat",
        Weekday::Sun => "sun",
    };
    let ranges = match cfg.days.get(weekday_key) {
        Some(r) => r,
        None => return false, // missing day key = no working hours that day
    };
    if ranges.is_empty() {
        return false;
    }

    // Compare current local time-of-day against each range.
    let cur_secs = local.num_seconds_from_midnight() as i64;
    for r in ranges {
        let Some(start_secs) = parse_hhmm_to_secs(&r.start) else { continue };
        let Some(end_secs) = parse_hhmm_to_secs(&r.end) else { continue };
        // Half-open interval [start, end). 09:00–18:00 means
        // active from 09:00:00 inclusive to 17:59:59 inclusive.
        if cur_secs >= start_secs && cur_secs < end_secs {
            return true;
        }
    }
    false
}

fn parse_hhmm_to_secs(s: &str) -> Option<i64> {
    NaiveTime::parse_from_str(s, "%H:%M")
        .ok()
        .map(|t| t.num_seconds_from_midnight() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(tz: Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        tz.with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn missing_json_means_always_tracking() {
        assert!(is_within_tracking_hours(None, Utc::now()));
        assert!(is_within_tracking_hours(Some(""), Utc::now()));
    }

    #[test]
    fn invalid_json_fail_safe_true() {
        assert!(is_within_tracking_hours(Some("not json"), Utc::now()));
    }

    #[test]
    fn within_mon_fri_9_to_6_ist() {
        let j = r#"{"tz":"Asia/Kolkata","days":{"mon":[{"start":"09:00","end":"18:00"}]}}"#;
        // Mon 2026-06-15 10:30 IST = inside hours
        let ist: Tz = "Asia/Kolkata".parse().unwrap();
        assert!(is_within_tracking_hours(Some(j), at(ist, 2026, 6, 15, 10, 30)));
        // Mon 2026-06-15 19:00 IST = past hours
        assert!(!is_within_tracking_hours(Some(j), at(ist, 2026, 6, 15, 19, 0)));
        // Tue 2026-06-16 10:30 IST = day not in schedule
        assert!(!is_within_tracking_hours(Some(j), at(ist, 2026, 6, 16, 10, 30)));
    }

    #[test]
    fn multi_range_lunch_break() {
        let j = r#"{"tz":"UTC","days":{"mon":[{"start":"09:00","end":"13:00"},{"start":"14:00","end":"18:00"}]}}"#;
        // 13:30 = lunch break, paused
        assert!(!is_within_tracking_hours(Some(j), at(chrono_tz::UTC, 2026, 6, 15, 13, 30)));
        // 14:30 = back to work
        assert!(is_within_tracking_hours(Some(j), at(chrono_tz::UTC, 2026, 6, 15, 14, 30)));
    }
}
