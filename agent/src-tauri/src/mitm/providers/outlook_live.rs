//! Outlook.com / Hotmail (personal) send parser.
//!
//! The consumer Outlook Web app posts to
//!   `POST https://outlook.live.com/owa/service.svc?action=SendItem`
//! with a JSON body wrapping an EWS-style `SendItem` payload. Recent
//! versions have also started delegating to the Microsoft Graph
//! endpoint `POST /me/sendMail` with the same shape as the Graph API
//! elsewhere — we match both.
//!
//! We deliberately do NOT match `outlook.office.com` — that's
//! corporate M365 which is outside the DLP scope (org-owned mail path).

use super::{CapturedAttachment, CapturedEmail, EmailProvider};

pub struct OutlookLive;

impl EmailProvider for OutlookLive {
    fn name(&self) -> &'static str {
        "Outlook.com"
    }

    fn owns(&self, host: &str) -> bool {
        // Personal-Outlook hosts only. outlook.office.com is corporate
        // M365 and is explicitly excluded.
        matches!(
            host,
            "outlook.live.com"
            | "outlook.com"
            | "hotmail.com"
        ) || host.ends_with(".outlook.live.com")
    }

    fn is_send_request(&self, method: &str, path: &str, query: &str) -> bool {
        if method != "POST" {
            return false;
        }
        // Classic OWA send.
        if path.starts_with("/owa/service.svc") && query.contains("action=SendItem") {
            return true;
        }
        // Graph-shaped fallback the newer Outlook web client uses.
        if path.ends_with("/sendMail") {
            return true;
        }
        false
    }

    fn parse(&self, headers: &[(String, String)], body: &[u8]) -> Option<CapturedEmail> {
        let is_json = headers.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("content-type")
                && v.to_ascii_lowercase().contains("json")
        });
        if !is_json {
            return None;
        }
        let s = std::str::from_utf8(body).ok()?;
        let v: serde_json::Value = serde_json::from_str(s).ok()?;
        // Both shapes hang the interesting fields off "Message" (OWA) or
        // "message" (Graph). Handle whichever key exists.
        let msg = v
            .get("Message")
            .or_else(|| v.get("message"))
            .or(Some(&v))?;

        // Recipient extraction. EWS: `ToRecipients: [{EmailAddress:{Address}}]`
        // Graph: `toRecipients: [{emailAddress:{address}}]`
        let extract = |ews: &str, graph: &str| -> Vec<String> {
            let arr = match msg
                .get(ews)
                .or_else(|| msg.get(graph))
                .and_then(|x| x.as_array())
            {
                Some(a) => a,
                None => return Vec::new(),
            };
            arr.iter()
                .filter_map(|r| {
                    r.get("EmailAddress")
                        .or_else(|| r.get("emailAddress"))
                        .and_then(|e| {
                            e.get("Address")
                                .or_else(|| e.get("address"))
                                .and_then(|a| a.as_str())
                        })
                        .map(str::to_string)
                })
                .collect()
        };
        let to = extract("ToRecipients", "toRecipients");
        let cc = extract("CcRecipients", "ccRecipients");
        let bcc = extract("BccRecipients", "bccRecipients");
        if to.is_empty() && cc.is_empty() && bcc.is_empty() {
            return None;
        }

        let subject = msg
            .get("Subject")
            .or_else(|| msg.get("subject"))
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Body: `Body: {Value, ContentType}` OR `body: {content, contentType}`.
        let body_obj = msg.get("Body").or_else(|| msg.get("body"));
        let (body_html, body_text) = match body_obj {
            Some(bo) => {
                let content = bo
                    .get("Value")
                    .or_else(|| bo.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                let is_html = bo
                    .get("ContentType")
                    .or_else(|| bo.get("contentType"))
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_ascii_lowercase().contains("html"))
                    .unwrap_or(true);
                if is_html {
                    (Some(content.to_string()), None)
                } else {
                    (None, Some(content.to_string()))
                }
            }
            None => (None, None),
        };
        let from_address = msg
            .get("From")
            .or_else(|| msg.get("from"))
            .and_then(|f| f.get("EmailAddress").or_else(|| f.get("emailAddress")))
            .and_then(|e| e.get("Address").or_else(|| e.get("address")))
            .and_then(|a| a.as_str())
            .map(str::to_string);

        // Attachments: EWS `Attachments: [{Name, Size, ContentBytes, ContentType}]`.
        // Graph uses `attachments` (lowercase) with `name / size / contentBytes / contentType`.
        // We capture the manifest here; the raw ContentBytes base64 is
        // used by Phase 4c to actually upload the bytes.
        let attachments = msg
            .get("Attachments")
            .or_else(|| msg.get("attachments"))
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| {
                        let name = a.get("Name").or_else(|| a.get("name"))?.as_str()?;
                        let size = a.get("Size").or_else(|| a.get("size")).and_then(|s| s.as_u64());
                        let mime = a
                            .get("ContentType")
                            .or_else(|| a.get("contentType"))
                            .and_then(|c| c.as_str())
                            .map(str::to_string);
                        Some(CapturedAttachment {
                            file_name: name.to_string(),
                            file_size_bytes: size,
                            file_mime: mime,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Some(CapturedEmail {
            mail_provider: "Outlook.com".to_string(),
            mail_url: None,
            from_address,
            subject,
            body_text,
            body_html,
            to_recipients: to,
            cc_recipients: cc,
            bcc_recipients: bcc,
            attachments,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_only_personal_outlook() {
        let o = OutlookLive;
        assert!(o.owns("outlook.live.com"));
        assert!(o.owns("hotmail.com"));
        assert!(!o.owns("outlook.office.com")); // corporate: OUT of scope
    }

    #[test]
    fn parses_graph_shape() {
        let o = OutlookLive;
        let headers = vec![("content-type".into(), "application/json".into())];
        let body = br#"{"message":{"subject":"hi","toRecipients":[{"emailAddress":{"address":"a@b.com"}}],"ccRecipients":[],"bccRecipients":[],"body":{"contentType":"html","content":"<p>Yo</p>"}}}"#;
        let cap = o.parse(&headers, body).unwrap();
        assert_eq!(cap.subject.as_deref(), Some("hi"));
        assert_eq!(cap.to_recipients, vec!["a@b.com"]);
        assert_eq!(cap.body_html.as_deref(), Some("<p>Yo</p>"));
    }
}
