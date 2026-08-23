//! Per-provider request parsers for the Email DLP intercept path.
//!
//! Each provider owns:
//!   1. `matches(host, method, path)` — pattern for the ONE HTTP request
//!      that actually delivers the send (Gmail's `?...&act=sm`, Outlook
//!      Live's `service.svc?action=SendItem`, etc.). Everything else on
//!      the same TLS session gets forwarded untouched.
//!   2. `parse(headers, body)` — extract a `CapturedEmail` struct from
//!      the request the browser sent. Parsers work on the RAW HTTP
//!      request bytes because the shape is provider-specific (form-
//!      encoded, JSON, multipart, etc.) — no attempt at a unified DSL.
//!
//! Phase 4 landing:
//!   - gmail_web: real parser, form-encoded act=sm body.
//!   - outlook_live / yahoo / icloud: matcher stubs that log but don't
//!     yet parse — deferred to iterate as we get real traffic samples.
//!   - protonmail: matcher stub that only emits a metadata event
//!     ("send detected on E2E provider, body not inspectable").

mod gmail_web;
mod icloud;
mod outlook_live;
mod protonmail;
mod yahoo;

use std::sync::Arc;

/// A captured email — what the DLP pipeline needs to `dlp-email-ingest`.
/// Populated by `EmailProvider::parse`; anything the provider couldn't
/// find stays `None` / empty.
#[derive(Debug, Default, Clone)]
#[allow(dead_code)]
pub struct CapturedEmail {
    pub mail_provider: String,
    pub mail_url: Option<String>,
    pub from_address: Option<String>,
    pub subject: Option<String>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub to_recipients: Vec<String>,
    pub cc_recipients: Vec<String>,
    pub bcc_recipients: Vec<String>,
    /// Attachment handles the browser referenced in the send request.
    /// The upload bytes themselves land via a separate earlier request
    /// that Phase 4b will correlate on `attachment_id`. For now the
    /// parser records the names / sizes it can see.
    pub attachments: Vec<CapturedAttachment>,
}

#[derive(Debug, Default, Clone)]
#[allow(dead_code)]
pub struct CapturedAttachment {
    pub file_name: String,
    pub file_size_bytes: Option<u64>,
    pub file_mime: Option<String>,
}

/// One provider's parser. Every implementation is stateless — no
/// per-session buffering here; that lives in the interceptor.
pub trait EmailProvider: Send + Sync {
    /// Human-readable name that lands in `dlp_email_events.mail_provider`
    /// and matches the seed in `supabase/migrations/0148_dlp_email_events.sql`.
    fn name(&self) -> &'static str;

    /// True when this provider owns the hostname the browser is
    /// currently CONNECTing to. Hostname match is lowercase + suffix.
    fn owns(&self, host: &str) -> bool;

    /// True when this specific HTTP request is the "send" request we
    /// want to capture. Anything returning false gets forwarded
    /// untouched — the interceptor doesn't buffer or copy the body.
    fn is_send_request(&self, method: &str, path: &str, query: &str) -> bool;

    /// Parse a send request's body. May return None if the shape
    /// doesn't match — the interceptor then still forwards the request
    /// but doesn't emit a capture event.
    fn parse(&self, headers: &[(String, String)], body: &[u8]) -> Option<CapturedEmail>;
}

/// The full provider registry. Order doesn't matter — `owns()` is used
/// as a lookup, not a fallthrough chain.
pub fn all() -> Vec<Arc<dyn EmailProvider>> {
    vec![
        Arc::new(gmail_web::GmailWeb),
        Arc::new(outlook_live::OutlookLive),
        Arc::new(yahoo::Yahoo),
        Arc::new(icloud::ICloud),
        Arc::new(protonmail::ProtonMail),
    ]
}

/// Resolve a hostname to a provider (or None for a public webmail host
/// we know about but haven't written a parser for yet — the interceptor
/// still terminates TLS and logs, so we get a traffic sample to write
/// the parser against).
pub fn for_host(host: &str) -> Option<Arc<dyn EmailProvider>> {
    let h = host.to_ascii_lowercase();
    for p in all() {
        if p.owns(&h) {
            return Some(p);
        }
    }
    None
}

/// Fixed public-webmail hostname list. Matches the seed in migration
/// 0148 exactly — one source of truth would be a nightly agent-settings
/// refresh, but for MVP the list rarely changes and hard-coding
/// eliminates a runtime failure mode.
pub const PUBLIC_WEBMAIL_HOSTS: &[&str] = &[
    "mail.google.com",
    "gmail.com",
    "mail.yahoo.com",
    "yahoo.com",
    "outlook.live.com",
    "outlook.com",
    "hotmail.com",
    "mail.aol.com",
    "aol.com",
    "mail.proton.me",
    "protonmail.com",
    "mail.icloud.com",
    "icloud.com",
    "mail.zoho.com",
    "mail.rediff.com",
    "rediffmail.com",
    "gmx.com",
    "mail.com",
    "mail.yandex.com",
];

/// Is the current CONNECT target a public webmail host we should
/// terminate TLS on? Exact host or `.suffix` match — `foo.mail.google.com`
/// matches `mail.google.com` so Gmail's assorted subdomains (which do
/// exist for uploads / apis) all flow through the same interceptor.
///
/// `outlook.office.com` is intentionally NOT on this list — corporate
/// M365 stays out of the DLP scope.
pub fn is_public_webmail(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    for known in PUBLIC_WEBMAIL_HOSTS {
        if h == *known || h.ends_with(&format!(".{known}")) {
            return true;
        }
    }
    false
}
