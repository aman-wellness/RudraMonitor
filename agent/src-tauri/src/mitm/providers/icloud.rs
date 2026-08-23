//! iCloud Mail send parser.
//!
//! iCloud posts to
//!   `POST https://p*-mailws.icloud.com/wm/mail?...`
//! (the `p*` prefix rotates per user's Apple pod: p01, p02, ...). The
//! `?dsid=<id>` query param carries the Apple account routing. The
//! body is a JSON envelope.
//!
//! This parser is best-effort — Apple docs nothing publicly, so the
//! field names are inferred from a handful of captured traffic samples.
//! Parse misses fall through silently.

use super::{CapturedEmail, EmailProvider};

pub struct ICloud;

impl EmailProvider for ICloud {
    fn name(&self) -> &'static str {
        "iCloud Mail"
    }

    fn owns(&self, host: &str) -> bool {
        // iCloud's Mail web infra uses per-pod hostnames like
        // p01-mailws.icloud.com, p02-mailws.icloud.com, etc. Also the
        // account-side www.icloud.com and mail.icloud.com.
        host.ends_with("-mailws.icloud.com")
            || host == "mail.icloud.com"
            || host == "www.icloud.com"
            || host.ends_with(".icloud.com")
    }

    fn is_send_request(&self, method: &str, path: &str, _query: &str) -> bool {
        method == "POST"
            && path.starts_with("/wm/mail")
            && (path.contains("/send") || path.ends_with("/sendMessage"))
    }

    fn parse(&self, _headers: &[(String, String)], body: &[u8]) -> Option<CapturedEmail> {
        let s = std::str::from_utf8(body).ok()?;
        let v: serde_json::Value = serde_json::from_str(s).ok()?;
        let msg = v.get("message").or_else(|| v.get("Message")).or(Some(&v))?;

        let extract = |field: &str| -> Vec<String> {
            msg.get(field)
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|r| {
                            r.as_str()
                                .map(str::to_string)
                                .or_else(|| {
                                    r.get("emailAddress")
                                        .and_then(|a| a.as_str())
                                        .map(str::to_string)
                                })
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let to = extract("toAddresses");
        let cc = extract("ccAddresses");
        let bcc = extract("bccAddresses");
        if to.is_empty() && cc.is_empty() && bcc.is_empty() {
            return None;
        }

        Some(CapturedEmail {
            mail_provider: "iCloud Mail".to_string(),
            mail_url: None,
            from_address: msg
                .get("fromAddress")
                .and_then(|a| a.as_str())
                .map(str::to_string),
            subject: msg
                .get("subject")
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            body_text: msg
                .get("plainBody")
                .and_then(|b| b.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            body_html: msg
                .get("htmlBody")
                .and_then(|b| b.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            to_recipients: to,
            cc_recipients: cc,
            bcc_recipients: bcc,
            attachments: Vec::new(),
        })
    }
}
