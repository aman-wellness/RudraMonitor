//! ProtonMail metadata-only detector.
//!
//! ProtonMail encrypts the message body client-side BEFORE it hits the
//! wire — even with TLS terminated, all we see is a ciphertext blob
//! that PGP-decrypts to whatever the sender + recipient's public keys
//! decode to. Full body / attachment inspection isn't achievable from
//! this vantage point without breaking the encryption model.
//!
//! What we CAN capture: the fact that a send happened, from which agent,
//! to how many recipients (Proton's `Recipients` header carries the
//! addresses in cleartext — they're needed for delivery routing). The
//! admin gets a row that says "Proton send, N recipients, body
//! E2E-inspection not available".

use super::{CapturedEmail, EmailProvider};

pub struct ProtonMail;

impl EmailProvider for ProtonMail {
    fn name(&self) -> &'static str {
        "ProtonMail"
    }

    fn owns(&self, host: &str) -> bool {
        host == "mail.proton.me"
            || host == "protonmail.com"
            || host.ends_with(".proton.me")
            || host.ends_with(".protonmail.com")
    }

    fn is_send_request(&self, method: &str, path: &str, _query: &str) -> bool {
        // API path is `POST /api/mail/v4/messages/<id>` with
        // `?send=true` OR the newer `/api/mail/v4/messages/<id>/send`.
        // Both are what we want; anything else on the API is meta/UI.
        method == "POST"
            && path.starts_with("/api/mail/")
            && (path.contains("/send") || path.contains("send="))
    }

    fn parse(&self, _headers: &[(String, String)], body: &[u8]) -> Option<CapturedEmail> {
        // The JSON body includes ToList / CCList / BCCList as
        // `[{Name, Address}, ...]` — these are cleartext because
        // Proton's own SMTP relay needs them to route.
        //
        // Full attachment / body content is PGP-encrypted; even if we
        // parsed it we couldn't decrypt. So the row we land is:
        //   provider = ProtonMail
        //   subject / body = None (encrypted at rest before send)
        //   to/cc/bcc = whatever the JSON exposes
        //   attachments_count = counted via len(Attachments) if any
        let body_str = std::str::from_utf8(body).ok()?;
        let v: serde_json::Value = serde_json::from_str(body_str).ok()?;
        let msg = v.get("Message").or(Some(&v))?;

        let extract_addrs = |field: &str| -> Vec<String> {
            msg.get(field)
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|r| r.get("Address").and_then(|a| a.as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let to = extract_addrs("ToList");
        let cc = extract_addrs("CCList");
        let bcc = extract_addrs("BCCList");
        if to.is_empty() && cc.is_empty() && bcc.is_empty() {
            return None;
        }

        Some(CapturedEmail {
            mail_provider: "ProtonMail".to_string(),
            mail_url: None,
            from_address: msg
                .get("Sender")
                .and_then(|s| s.get("Address"))
                .and_then(|a| a.as_str())
                .map(str::to_string),
            subject: msg
                .get("Subject")
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            // Body + attachments are E2E-encrypted; we deliberately
            // leave both empty and let the dashboard render "body not
            // available for E2E-encrypted providers".
            body_text: Some(
                "(ProtonMail send — body is client-side E2E encrypted; content not inspectable)"
                    .to_string(),
            ),
            body_html: None,
            to_recipients: to,
            cc_recipients: cc,
            bcc_recipients: bcc,
            attachments: Vec::new(),
        })
    }
}
