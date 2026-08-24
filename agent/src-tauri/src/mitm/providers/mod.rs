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
    /// Handle the browser referenced in the send request (`att=XXX` in
    /// Gmail's form body; upload session id for OWA/Graph). Empty for
    /// providers where the send request already carried the bytes
    /// inline (Outlook Live Graph shape).
    pub handle: Option<String>,
    /// Raw file bytes when the provider was able to capture them (via
    /// the earlier upload POST in the same TLS session, or inline in
    /// the send body). None means "referenced but bytes not captured"
    /// — the row still lands with the file name so the admin can see
    /// SOMETHING left the endpoint, just not what.
    pub bytes: Option<Vec<u8>>,
}

/// A raw file the provider captured off an "attachment upload" request
/// that came BEFORE the send in the same TLS session. Keyed by
/// `handle` (Gmail's `att_XXX`, OWA's upload-session id, etc.); the
/// send parser looks up handles it referenced and hydrates their
/// `bytes` on the CapturedEmail. Provider-agnostic shape.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct UploadedFile {
    pub handle: String,
    pub file_name: String,
    pub file_size_bytes: u64,
    pub file_mime: Option<String>,
    pub bytes: Vec<u8>,
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

    /// True when this request is an attachment UPLOAD that we should
    /// buffer + parse, so we can hydrate `att` handles later when the
    /// send fires. Default false — providers opt in.
    fn is_upload_request(&self, _method: &str, _path: &str, _query: &str) -> bool {
        false
    }

    /// Parse an upload request. Providers that don't do out-of-band
    /// uploads (Outlook Live Graph inlines the bytes in the send body)
    /// leave this returning None. Called after `is_upload_request`
    /// returns true; the body slice is the full buffered request body.
    fn parse_upload(
        &self,
        _headers: &[(String, String)],
        _query: &str,
        _body: &[u8],
    ) -> Option<UploadedFile> {
        None
    }

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

/// Hosts we NEVER intercept even if they match `PUBLIC_WEBMAIL_HOSTS`
/// or the interception check would otherwise say yes. Banking /
/// payments / healthcare — TLS termination on these is both morally
/// wrong and mostly futile because their mobile apps ship pinned
/// certs that reject our leaves anyway. Desktop browsers to these
/// hosts stay on the raw passthrough tunnel so a bank login still
/// verifies against the real cert chain.
///
/// Not exhaustive — this is a floor, not a ceiling. Admins can extend
/// via `dlp_settings.authorized_domains` (already used by the ingest
/// side to whitelist trusted destinations).
pub const PASSTHROUGH_BYPASS_HOSTS: &[&str] = &[
    // Indian banks
    "hdfcbank.com",
    "sbi.co.in",
    "icicibank.com",
    "axisbank.com",
    "kotak.com",
    "yesbank.in",
    "pnbindia.in",
    "unionbankofindia.co.in",
    "bankofbaroda.in",
    "hdfcergo.com",
    "iciciprulife.com",
    // Payments
    "razorpay.com",
    "paytm.com",
    "phonepe.com",
    "googlepay.com",
    "pay.google.com",
    "stripe.com",
    "paypal.com",
    // Healthcare
    "practo.com",
    "apollo247.com",
    "cowin.gov.in",
    "abdm.gov.in",
    // Government portals
    "incometax.gov.in",
    "gst.gov.in",
    "irctc.co.in",
    "digilocker.gov.in",
    "uidai.gov.in",
    // Our own backend — self-loop safety.
    "wellnessextract.com",
    "rudrans.com",
];

fn is_bypass_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    for banned in PASSTHROUGH_BYPASS_HOSTS {
        if h == *banned || h.ends_with(&format!(".{banned}")) {
            return true;
        }
    }
    false
}

/// Is the current CONNECT target a public webmail host we should
/// terminate TLS on? Exact host or `.suffix` match — `foo.mail.google.com`
/// matches `mail.google.com` so Gmail's assorted subdomains (which do
/// exist for uploads / apis) all flow through the same interceptor.
///
/// `outlook.office.com` is intentionally NOT on this list — corporate
/// M365 stays out of the DLP scope. Banking / payments / healthcare in
/// `PASSTHROUGH_BYPASS_HOSTS` are also filtered out even if they'd
/// otherwise match (defensive; none currently overlap).
pub fn is_public_webmail(host: &str) -> bool {
    if is_bypass_host(host) {
        return false;
    }
    let h = host.to_ascii_lowercase();
    for known in PUBLIC_WEBMAIL_HOSTS {
        if h == *known || h.ends_with(&format!(".{known}")) {
            return true;
        }
    }
    false
}
