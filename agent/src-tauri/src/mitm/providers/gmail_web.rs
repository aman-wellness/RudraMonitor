//! Gmail Web send parser.
//!
//! Gmail's browser client sends the actual message via a POST to
//!   `https://mail.google.com/mail/u/{N}/?...&act=sm`
//! where `{N}` is the account index (0 by default, incremented per
//! logged-in Gmail account in this browser profile). The body is
//! `application/x-www-form-urlencoded` and carries the fields we care
//! about: `to`, `cc`, `bcc`, `subject`, `body`, and attachment handle
//! references. Save-drafts use `act=sd` — we intentionally SKIP those,
//! or the DLP row lands before the user actually chose to send.
//!
//! Notes on Gmail's quirks:
//! - `to` / `cc` / `bcc` are each a single scalar with commas between
//!   multiple recipients; some newer client builds send them repeated
//!   instead (`to=a@b.com&to=c@d.com`). This parser accepts both.
//! - `subject` may be missing entirely — Gmail sends an empty-subject
//!   send just fine. We land it as `None`.
//! - `body` is HTML on the modern client (`ishtml=1` marker in the
//!   form). Older clients set `ishtml=0` and send plain text. We keep
//!   both channels populated where possible.
//! - Attachment BYTES come via a separate earlier POST to
//!   `/_/upload?...` — that isn't parsed here. Phase 4b will correlate
//!   the `attach_XXX` handle IDs the send request references back to
//!   the earlier upload response so the actual file bytes end up in
//!   the DLP attachment bucket. For now the parser records the handle
//!   IDs as `file_name` placeholders so admins at least see "1
//!   attachment sent, correlation pending".

use super::{CapturedAttachment, CapturedEmail, EmailProvider};

pub struct GmailWeb;

impl EmailProvider for GmailWeb {
    fn name(&self) -> &'static str {
        "Gmail"
    }

    fn owns(&self, host: &str) -> bool {
        host == "mail.google.com"
            || host == "gmail.com"
            || host.ends_with(".mail.google.com")
            || host.ends_with(".gmail.com")
    }

    fn is_send_request(&self, method: &str, path: &str, query: &str) -> bool {
        if method != "POST" {
            return false;
        }
        // Path is `/mail/u/{N}/` on the web client; the interesting bit
        // lives in the query string. Do a cheap contains-check instead
        // of full path parsing.
        if !path.starts_with("/mail/") {
            return false;
        }
        // `act=sm` = send-message. Save-drafts (`sd`) and other
        // reactions (`del`, `star`, ...) all pass through untouched.
        query.split('&').any(|kv| kv == "act=sm")
    }

    fn parse(&self, headers: &[(String, String)], body: &[u8]) -> Option<CapturedEmail> {
        // The client always sends this Content-Type on `act=sm` today,
        // but the check is cheap and prevents wasting cycles if Gmail
        // ships a multipart-encoded send in the future.
        let is_form = headers.iter().any(|(k, v)| {
            k.eq_ignore_ascii_case("content-type")
                && v.to_ascii_lowercase()
                    .starts_with("application/x-www-form-urlencoded")
        });
        if !is_form {
            return None;
        }

        let body_str = std::str::from_utf8(body).ok()?;
        let mut to = Vec::new();
        let mut cc = Vec::new();
        let mut bcc = Vec::new();
        let mut subject: Option<String> = None;
        let mut body_html: Option<String> = None;
        let mut body_text: Option<String> = None;
        let mut is_html = false;
        let mut attach_handles: Vec<String> = Vec::new();

        for pair in body_str.split('&') {
            let (k, v) = match pair.split_once('=') {
                Some(kv) => kv,
                None => continue,
            };
            let val = url_decode(v);
            match k {
                "to" => split_recipients(&val, &mut to),
                "cc" => split_recipients(&val, &mut cc),
                "bcc" => split_recipients(&val, &mut bcc),
                "subject" | "subjectbox" => {
                    if !val.is_empty() {
                        subject = Some(val);
                    }
                }
                "body" => {
                    // Populated as HTML or text depending on `ishtml`;
                    // Gmail's mobile web sometimes sends both a
                    // `body` (HTML) and a `bodybox` (text fallback).
                    // Capture into both slots — the ingest edge fn
                    // stores what it gets.
                    if val.is_empty() { continue; }
                    if is_html {
                        body_html = Some(val);
                    } else {
                        // We might not have seen `ishtml=1` yet
                        // because form key order isn't fixed; land
                        // in html and swap below if `ishtml` says
                        // otherwise.
                        body_html = Some(val);
                    }
                }
                "bodybox" => {
                    if !val.is_empty() {
                        body_text = Some(val);
                    }
                }
                "ishtml" => {
                    is_html = val == "1";
                    // If we already put the `body` field in the HTML
                    // slot but ishtml says text, promote it.
                    if !is_html {
                        if let Some(b) = body_html.take() {
                            body_text = Some(b);
                        }
                    }
                }
                k if k.starts_with("att") => {
                    // `att`, `attid`, `atthandle` — anything starting
                    // with `att` is a reference to a prior upload.
                    if !val.is_empty() {
                        attach_handles.push(val);
                    }
                }
                _ => {}
            }
        }

        // A send with no addressees at all is almost certainly a spurious
        // POST from the client that isn't a real send. Skip.
        if to.is_empty() && cc.is_empty() && bcc.is_empty() {
            return None;
        }

        let attachments = attach_handles
            .into_iter()
            .map(|h| CapturedAttachment {
                file_name: format!("attachment-{h}"),
                file_size_bytes: None,
                file_mime: None,
            })
            .collect();

        Some(CapturedEmail {
            mail_provider: "Gmail".to_string(),
            mail_url: None, // filled in by the interceptor which knows the full URL
            from_address: None, // Gmail's send doesn't include From — inferred from account
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

fn split_recipients(raw: &str, out: &mut Vec<String>) {
    for piece in raw.split(',') {
        let t = piece.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
}

/// application/x-www-form-urlencoded decoder — handles `+` as space and
/// `%XX` percent escapes. Not a full URL parse; that's overkill here.
fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &input[i + 1..i + 3];
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_send_query() {
        let g = GmailWeb;
        assert!(g.is_send_request("POST", "/mail/u/0/", "ik=abc&act=sm&at=xyz"));
        // save-draft is NOT a send
        assert!(!g.is_send_request("POST", "/mail/u/0/", "ik=abc&act=sd"));
        // GET is never a send
        assert!(!g.is_send_request("GET", "/mail/u/0/", "act=sm"));
    }

    #[test]
    fn parses_basic_form_body() {
        let g = GmailWeb;
        let headers = vec![(
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        )];
        let body = b"to=a%40b.com%2Cc%40d.com&cc=e%40f.com&subject=hi&body=%3Cp%3EYo%3C%2Fp%3E&ishtml=1";
        let cap = g.parse(&headers, body).unwrap();
        assert_eq!(cap.to_recipients, vec!["a@b.com", "c@d.com"]);
        assert_eq!(cap.cc_recipients, vec!["e@f.com"]);
        assert_eq!(cap.subject.as_deref(), Some("hi"));
        assert_eq!(cap.body_html.as_deref(), Some("<p>Yo</p>"));
    }

    #[test]
    fn drops_send_without_recipients() {
        let g = GmailWeb;
        let headers = vec![(
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        )];
        assert!(g.parse(&headers, b"subject=orphan&body=Hi").is_none());
    }
}
