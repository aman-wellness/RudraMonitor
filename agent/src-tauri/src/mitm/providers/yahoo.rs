//! Yahoo Mail send parser.
//!
//! Yahoo's web client posts to
//!   `POST https://apis.mail.yahoo.com/ws/v3/mailboxes/@.id==*/messages/@.id==*/send`
//! with a multipart body. The exact shape shifts every few months as
//! Yahoo reskins the client — this parser leans on tolerant matching
//! for a few known field paths and misses gracefully otherwise. When a
//! parse fails, the interceptor still forwards the request untouched
//! and the miss is invisible to the user (no ingest row is created).
//!
//! For MVP we extract `to / cc / bcc / subject / body_html` from the
//! JSON blob Yahoo now uses in place of full multipart. Attachment
//! byte capture is Phase 4c.

use super::{CapturedEmail, EmailProvider};

pub struct Yahoo;

impl EmailProvider for Yahoo {
    fn name(&self) -> &'static str {
        "Yahoo Mail"
    }

    fn owns(&self, host: &str) -> bool {
        matches!(
            host,
            "mail.yahoo.com" | "yahoo.com" | "apis.mail.yahoo.com"
        ) || host.ends_with(".mail.yahoo.com")
            || host.ends_with(".yahoo.com")
    }

    fn is_send_request(&self, method: &str, path: &str, _query: &str) -> bool {
        method == "POST" && path.contains("/messages/") && path.ends_with("/send")
    }

    fn parse(&self, _headers: &[(String, String)], body: &[u8]) -> Option<CapturedEmail> {
        let s = std::str::from_utf8(body).ok()?;
        // Yahoo wraps multipart around a JSON part; we only care about
        // the JSON. Naive slice — find the first { and try to parse.
        let start = s.find('{')?;
        let v: serde_json::Value = serde_json::from_str(&s[start..]).ok()?;
        let msg = v.get("message").or(Some(&v))?;

        let extract = |field: &str| -> Vec<String> {
            msg.get(field)
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|r| r.get("email").and_then(|a| a.as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let to = extract("to");
        let cc = extract("cc");
        let bcc = extract("bcc");
        if to.is_empty() && cc.is_empty() && bcc.is_empty() {
            return None;
        }

        let subject = msg
            .get("subject")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let body_html = msg
            .get("html")
            .or_else(|| msg.get("body"))
            .and_then(|b| b.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let from = msg
            .get("from")
            .and_then(|f| f.get("email"))
            .and_then(|a| a.as_str())
            .map(str::to_string);

        Some(CapturedEmail {
            mail_provider: "Yahoo Mail".to_string(),
            mail_url: None,
            from_address: from,
            subject,
            body_text: None,
            body_html,
            to_recipients: to,
            cc_recipients: cc,
            bcc_recipients: bcc,
            attachments: Vec::new(),
        })
    }
}
