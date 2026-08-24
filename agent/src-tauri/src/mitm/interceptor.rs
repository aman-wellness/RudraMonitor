//! TLS-terminated interception path.
//!
//! Once `proxy::handle` has decided a CONNECT target is a public-webmail
//! host, it hands control here. The flow, per client TLS session:
//!
//!   1. Wrap the TCP stream in a rustls `TlsAcceptor` using a leaf cert
//!      minted (and cached) for the exact SNI hostname the browser sent.
//!   2. Open our own TLS connection to the REAL upstream host on 443
//!      using rustls + the Mozilla webpki-roots bundle — deliberately
//!      NOT the endpoint OS trust store, because that store contains
//!      our own MITM anchor and would MITM-loop.
//!   3. Loop: read one HTTP/1.1 request from the client, check the
//!      provider for whether it's a "send", buffer + parse if so, then
//!      forward the raw request to upstream and stream the response
//!      back to the client. Keep-alive keeps the loop running until
//!      either side closes.
//!
//! Captured emails feed into the DLP ingest edge fn via `api::` —
//! deliberately kept off the fast forward path (spawned as a detached
//! task) so a slow ingest never stalls the user's browsing.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;

use super::cert_authority::Authority;
use super::providers::{self, CapturedEmail, UploadedFile};

/// Maximum size of any single request we buffer while parsing. Bodies
/// larger than this get forwarded without a capture attempt — Gmail's
/// send POST is well under 1 MB even with a huge draft.
const MAX_CAPTURE_BODY_BYTES: usize = 2 * 1024 * 1024;

/// The one-shot entry point for a public-webmail CONNECT session.
/// `host` is the exact hostname from the CONNECT line (used as SNI +
/// upstream target); `port` is normally 443.
pub async fn intercept(
    client: TcpStream,
    ca: Arc<Authority>,
    host: String,
    port: u16,
) -> Result<()> {
    // ---- server side of the MITM ----
    let server_cfg = ca.server_config_for(&host)?;
    let acceptor = TlsAcceptor::from(server_cfg);
    let mut client_tls = acceptor.accept(client).await?;

    // ---- client side (to real upstream) ----
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let up_cfg = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let up_cfg = Arc::new(up_cfg);
    let up_connector = tokio_rustls::TlsConnector::from(up_cfg);
    let up_tcp = TcpStream::connect((host.as_str(), port)).await?;
    let up_dns = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|e| anyhow!("SNI: {e}"))?;
    let mut upstream_tls = up_connector.connect(up_dns, up_tcp).await?;

    let provider = providers::for_host(&host);

    // Per-session state — attachment uploads observed BEFORE the send
    // fires. Keyed by the provider's handle string (Gmail `attid`,
    // OWA upload-session id, etc.). Bytes stay in memory only until
    // the send correlates them; a Content-Length cap on uploads keeps
    // this bounded.
    let mut pending_uploads: HashMap<String, UploadedFile> = HashMap::new();

    // Simple HTTP/1.1 request loop. Keep-alive supported by re-entering
    // after each response; connection: close or a read of 0 bytes ends
    // the session.
    let mut client_buf = Vec::with_capacity(16 * 1024);
    loop {
        let (headers_end, request_head, method, path, query, content_length, want_close) =
            match read_request_head(&mut client_tls, &mut client_buf).await? {
                Some(v) => v,
                None => break, // client closed cleanly
            };

        // Slurp body up to content-length. Chunked encoding on
        // requests is exceedingly rare from browsers (mostly used on
        // responses), but we still cap at MAX_CAPTURE_BODY_BYTES.
        let want_capture = provider
            .as_ref()
            .map(|p| p.is_send_request(method.as_str(), path.as_str(), query.as_str()))
            .unwrap_or(false);
        let want_upload_capture = provider
            .as_ref()
            .map(|p| p.is_upload_request(method.as_str(), path.as_str(), query.as_str()))
            .unwrap_or(false);

        // Read the body inline if we plan to capture (either a send or
        // an upload). Non-capture requests stream straight upstream.
        if (want_capture || want_upload_capture) && content_length <= MAX_CAPTURE_BODY_BYTES {
            // Ensure the buffer already has at least the full body.
            let needed = headers_end + content_length;
            while client_buf.len() < needed {
                let mut chunk = [0u8; 8192];
                let n = client_tls.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                client_buf.extend_from_slice(&chunk[..n]);
            }
            let body = &client_buf[headers_end..headers_end + content_length];

            if want_upload_capture {
                if let Some(p) = provider.clone() {
                    let headers_vec = parse_headers_kv(&request_head);
                    if let Some(upload) = p.parse_upload(&headers_vec, &query, body) {
                        log::info!(
                            "mitm: attachment upload captured — handle={} name={} size={} mime={:?}",
                            upload.handle,
                            upload.file_name,
                            upload.file_size_bytes,
                            upload.file_mime,
                        );
                        pending_uploads.insert(upload.handle.clone(), upload);
                    }
                }
            }

            if want_capture {
                if let Some(p) = provider.clone() {
                    let headers_vec = parse_headers_kv(&request_head);
                    if let Some(mut captured) = p.parse(&headers_vec, body) {
                        // Backfill the URL from what we know.
                        captured.mail_url =
                            Some(format!("https://{host}{path}?{query}"));
                        // Hydrate attachments from the session's
                        // pending uploads.
                        for att in captured.attachments.iter_mut() {
                            if let Some(handle) = &att.handle {
                                if let Some(up) = pending_uploads.get(handle) {
                                    att.file_name = up.file_name.clone();
                                    att.file_size_bytes = Some(up.file_size_bytes);
                                    att.file_mime = up.file_mime.clone();
                                    if !up.bytes.is_empty() {
                                        att.bytes = Some(up.bytes.clone());
                                    }
                                }
                            }
                        }
                        // Drop the uploads we consumed so a follow-up
                        // send in the same session doesn't double-count.
                        for att in captured.attachments.iter() {
                            if let Some(h) = &att.handle {
                                pending_uploads.remove(h);
                            }
                        }
                        tokio::spawn(emit_capture(captured));
                    }
                }
            }

            // Forward EVERYTHING we've buffered so far. Note we send
            // exactly `needed` bytes — any pipeline'd next request in
            // the buffer stays for the next loop iteration.
            upstream_tls.write_all(&client_buf[..needed]).await?;
            client_buf.drain(..needed);
        } else {
            // Non-capture request (or a body too big to buffer): flush
            // the request head, then stream content-length bytes.
            upstream_tls.write_all(&client_buf[..headers_end]).await?;
            let already_have = client_buf.len().saturating_sub(headers_end).min(content_length);
            if already_have > 0 {
                upstream_tls
                    .write_all(&client_buf[headers_end..headers_end + already_have])
                    .await?;
            }
            let mut remaining = content_length.saturating_sub(already_have);
            client_buf.drain(..headers_end + already_have);
            let mut chunk = [0u8; 16 * 1024];
            while remaining > 0 {
                let take = remaining.min(chunk.len());
                let n = client_tls.read(&mut chunk[..take]).await?;
                if n == 0 {
                    break;
                }
                upstream_tls.write_all(&chunk[..n]).await?;
                remaining -= n;
            }
        }

        // Response: forward with proper HTTP/1.1 framing so we know
        // exactly when the body ends and can cycle to the next request
        // on the same session. Returns true if the response signalled
        // Connection: close.
        let close_after = forward_one_response(&mut upstream_tls, &mut client_tls).await?;

        if want_close || close_after {
            break;
        }
    }
    Ok(())
}

async fn read_request_head<S>(
    stream: &mut S,
    buf: &mut Vec<u8>,
) -> Result<Option<(usize, Vec<u8>, String, String, String, usize, bool)>>
where
    S: tokio::io::AsyncRead + Unpin,
{
    // Grow the buffer until we see \r\n\r\n or hit a sanity limit.
    let mut chunk = [0u8; 4096];
    loop {
        // Try parse first with what we already have (from prior loop iterations).
        if let Some(hdr_end) = find_headers_end(buf) {
            let head_bytes = &buf[..hdr_end];
            let mut hdrs = [httparse::EMPTY_HEADER; 64];
            let mut req = httparse::Request::new(&mut hdrs);
            let _ = req.parse(head_bytes)?;
            let method = req.method.unwrap_or("").to_string();
            let full_path = req.path.unwrap_or("");
            let (path, query) = match full_path.split_once('?') {
                Some((p, q)) => (p.to_string(), q.to_string()),
                None => (full_path.to_string(), String::new()),
            };
            let mut content_length = 0usize;
            let mut want_close = false;
            for h in req.headers.iter() {
                if h.name.eq_ignore_ascii_case("content-length") {
                    content_length = std::str::from_utf8(h.value)
                        .unwrap_or("0")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                }
                if h.name.eq_ignore_ascii_case("connection")
                    && std::str::from_utf8(h.value)
                        .unwrap_or("")
                        .to_ascii_lowercase()
                        .contains("close")
                {
                    want_close = true;
                }
            }
            return Ok(Some((
                hdr_end,
                head_bytes.to_vec(),
                method,
                path,
                query,
                content_length,
                want_close,
            )));
        }
        if buf.len() > 128 * 1024 {
            return Err(anyhow!("request head too large"));
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn parse_headers_kv(head: &[u8]) -> Vec<(String, String)> {
    let mut hdrs = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut hdrs);
    let _ = req.parse(head);
    req.headers
        .iter()
        .filter(|h| !h.name.is_empty())
        .map(|h| {
            (
                h.name.to_string(),
                std::str::from_utf8(h.value).unwrap_or("").to_string(),
            )
        })
        .collect()
}

/// Forward a single HTTP/1.1 response from upstream to client with
/// proper framing — Content-Length OR Transfer-Encoding: chunked OR
/// read-until-EOF, whichever the response declares. Replaces the
/// idle-timeout heuristic from Phase 4c so keep-alive request
/// pipelining works and we don't stall the browser on slow servers.
///
/// Returns `Ok(true)` when the response signalled Connection: close;
/// caller should terminate the session.
async fn forward_one_response<C, U>(upstream: &mut U, client: &mut C) -> Result<bool>
where
    C: tokio::io::AsyncWrite + Unpin,
    U: tokio::io::AsyncRead + Unpin,
{
    // Read until end of response head.
    let mut head_buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let hdr_end = loop {
        if let Some(end) = find_headers_end(&head_buf) {
            break end;
        }
        if head_buf.len() > 128 * 1024 {
            return Err(anyhow!("response head too large"));
        }
        let n = upstream.read(&mut chunk).await?;
        if n == 0 {
            // Upstream closed before sending a full response head —
            // pass through what we have and stop the session.
            if !head_buf.is_empty() {
                client.write_all(&head_buf).await?;
            }
            return Ok(true);
        }
        head_buf.extend_from_slice(&chunk[..n]);
    };

    // Parse framing directives before we start forwarding — so we know
    // when to stop reading upstream for THIS response and cycle to the
    // next request on the same session.
    let (content_length, is_chunked, close_after) = {
        let mut hdrs = [httparse::EMPTY_HEADER; 64];
        let mut resp = httparse::Response::new(&mut hdrs);
        let _ = resp.parse(&head_buf[..hdr_end])?;
        let mut cl: Option<usize> = None;
        let mut chunked = false;
        let mut close = false;
        for h in resp.headers.iter() {
            if h.name.eq_ignore_ascii_case("content-length") {
                cl = std::str::from_utf8(h.value)
                    .ok()
                    .and_then(|s| s.trim().parse().ok());
            }
            if h.name.eq_ignore_ascii_case("transfer-encoding")
                && std::str::from_utf8(h.value)
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .contains("chunked")
            {
                chunked = true;
            }
            if h.name.eq_ignore_ascii_case("connection")
                && std::str::from_utf8(h.value)
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .contains("close")
            {
                close = true;
            }
        }
        (cl, chunked, close)
    };

    // Forward the head.
    client.write_all(&head_buf[..hdr_end]).await?;
    // Anything the head-read overshot into the buffer is the beginning
    // of the body — forward it up front and treat as "already read".
    let overshoot = &head_buf[hdr_end..];
    let mut already_read: usize = overshoot.len();
    if !overshoot.is_empty() {
        client.write_all(overshoot).await?;
    }

    // ---- body forwarding ----
    if is_chunked {
        // Chunked-encoding: forward until the terminating 0\r\n\r\n.
        // We don't need to fully parse; just stream through and watch
        // for the 5-byte sentinel across bytes-as-they-arrive.
        let mut trailing: Vec<u8> = overshoot.to_vec();
        loop {
            if trailing.windows(5).any(|w| w == b"0\r\n\r\n") {
                break;
            }
            let n = upstream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            client.write_all(&chunk[..n]).await?;
            trailing.extend_from_slice(&chunk[..n]);
            // Bound the sliding buffer so a long chunked response
            // doesn't accumulate GBs in RAM — keep the last 8 bytes
            // for the sentinel match.
            if trailing.len() > 8 {
                let drop = trailing.len() - 8;
                trailing.drain(..drop);
            }
        }
    } else if let Some(cl) = content_length {
        // Read the declared number of bytes minus whatever we already
        // pulled with the head-read overshoot.
        let mut remaining = cl.saturating_sub(already_read);
        while remaining > 0 {
            let take = remaining.min(chunk.len());
            let n = upstream.read(&mut chunk[..take]).await?;
            if n == 0 {
                break;
            }
            client.write_all(&chunk[..n]).await?;
            remaining -= n;
            already_read += n;
        }
    } else {
        // No Content-Length, no chunked encoding: read-until-EOF.
        // Signals a Connection: close response by RFC.
        loop {
            let n = upstream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            client.write_all(&chunk[..n]).await?;
        }
        return Ok(true);
    }

    let _ = client.flush().await;
    Ok(close_after)
}

/// Fire-and-forget hand-off from the interceptor to the DLP ingest
/// pipeline. Two-phase: open (metadata + attachment manifest → returns
/// signed upload URLs) → PUT each attachment's bytes → finalize.
///
/// Everything is best-effort: an ingest failure logs and returns, it
/// never blocks the user's actual browsing (this fn is always spawned).
/// Missing mitm config (agent not yet enrolled) also returns silently.
async fn emit_capture(captured: CapturedEmail) {
    log::info!(
        "mitm: captured email — provider={} subject={:?} to={:?} cc={:?} bcc={:?} attachments={}",
        captured.mail_provider,
        captured.subject,
        captured.to_recipients,
        captured.cc_recipients,
        captured.bcc_recipients,
        captured.attachments.len(),
    );

    let cfg = match super::mitm_cfg() {
        Some(c) => c,
        None => {
            log::debug!("mitm: emit_capture skipped — MitmConfig not set yet");
            return;
        }
    };

    let client = match crate::api::build_client() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("mitm: emit_capture http client build failed: {e}");
            return;
        }
    };

    // ---- Phase 1: open the event ----
    let manifest: Vec<serde_json::Value> = captured
        .attachments
        .iter()
        .map(|a| {
            let mut o = serde_json::Map::new();
            o.insert("file_name".into(), a.file_name.clone().into());
            o.insert(
                "file_size_bytes".into(),
                a.file_size_bytes.unwrap_or(0).into(),
            );
            if let Some(m) = &a.file_mime {
                o.insert("file_mime".into(), m.clone().into());
            }
            serde_json::Value::Object(o)
        })
        .collect();

    let payload = serde_json::json!({
        "action": "open",
        "mail_provider": captured.mail_provider,
        "mail_url": captured.mail_url,
        "from_address": captured.from_address,
        "subject": captured.subject,
        "body_text": captured.body_text,
        "body_html": captured.body_html,
        "to_recipients": captured.to_recipients,
        "cc_recipients": captured.cc_recipients,
        "bcc_recipients": captured.bcc_recipients,
        "attachments": manifest,
        "occurred_at": chrono::Utc::now().to_rfc3339(),
    });

    let open_resp = match crate::api::dlp_email_open(
        &client,
        &cfg.supabase_url,
        &cfg.anon_key,
        &cfg.enroll_token,
        &payload,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("mitm: dlp-email open failed: {e}");
            return;
        }
    };

    let event_id = match open_resp.get("event_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            log::debug!("mitm: dlp-email open returned no event_id ({open_resp})");
            return;
        }
    };

    // ---- Phase 2: attachments ----
    //
    // The server minted a signed upload URL per attachment we declared
    // in the manifest. PUT the captured bytes for each; skip
    // attachments where the provider couldn't capture bytes (e.g.
    // Gmail multipart shape that we haven't parsed yet) — the row
    // still lands with the right file_name / count.
    let finalize_required = open_resp
        .get("finalize_required")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if finalize_required {
        if let Some(urls) = open_resp.get("upload_urls").and_then(|v| v.as_array()) {
            for (i, u) in urls.iter().enumerate() {
                let signed = match u.get("signed_url").and_then(|s| s.as_str()) {
                    Some(s) => s,
                    None => continue,
                };
                let file_name = u
                    .get("file_name")
                    .and_then(|s| s.as_str())
                    .unwrap_or("attachment");

                // Match by index into the captured attachments — the
                // manifest we sent up preserves order.
                let att = match captured.attachments.get(i) {
                    Some(a) => a,
                    None => continue,
                };
                let bytes = match &att.bytes {
                    Some(b) => b.clone(),
                    None => continue, // parser couldn't grab bytes
                };
                let mime = att.file_mime.clone().unwrap_or_else(|| "application/octet-stream".to_string());
                if let Err(e) = crate::api::dlp_email_upload(&client, signed, &mime, bytes).await {
                    log::warn!("mitm: attachment PUT for {file_name} failed: {e}");
                }
            }
        }
    }

    if !finalize_required {
        return; // no attachments, event auto-ingested by open()
    }

    // ---- Phase 3: finalize ----
    if let Err(e) = crate::api::dlp_email_finalize(
        &client,
        &cfg.supabase_url,
        &cfg.anon_key,
        &cfg.enroll_token,
        &event_id,
    )
    .await
    {
        log::warn!("mitm: dlp-email finalize failed: {e}");
    }
}
