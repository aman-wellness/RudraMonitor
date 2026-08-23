//! Phase 3 proxy: passthrough HTTP CONNECT tunnel on 127.0.0.1:47443.
//!
//! Browsers point at us via the system proxy setting; we accept their
//! `CONNECT host:port HTTP/1.1` request, open a raw TCP socket to
//! `host:port`, reply `200 OK`, then blind-copy bytes both directions
//! until either side closes. No TLS is terminated, no request body is
//! read — the browser and destination speak whatever HTTPS they want.
//!
//! Interception (TLS termination + provider parsing) layers on top of
//! this in Phase 4 by branching before the raw tunnel opens.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

pub async fn run(bind: &str, stop: Arc<Notify>) -> anyhow::Result<()> {
    let listener = TcpListener::bind(bind).await?;
    log::info!("mitm: passthrough proxy listening on {bind}");
    loop {
        tokio::select! {
            _ = stop.notified() => {
                log::info!("mitm: stop signal received");
                return Ok(());
            }
            accept = listener.accept() => {
                match accept {
                    Ok((stream, peer)) => {
                        log::trace!("mitm: accepted connection from {peer}");
                        tokio::spawn(async move {
                            if let Err(e) = handle(stream).await {
                                log::debug!("mitm: session ended with error: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        // A transient accept() failure (e.g. too many open
                        // files) shouldn't kill the whole listener. Log
                        // and keep going.
                        log::warn!("mitm: accept failed ({e})");
                    }
                }
            }
        }
    }
}

async fn handle(mut client: TcpStream) -> anyhow::Result<()> {
    // Read the first request. CONNECT is the only method we care about
    // for the HTTPS path; a plain GET/POST to us as a proxy means the
    // browser was misconfigured (or a curl -x smoke test) — respond 400.
    let mut buf = [0u8; 8192];
    let n = client.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let head = std::str::from_utf8(&buf[..n])
        .map_err(|_| anyhow::anyhow!("non-utf8 client preamble"))?;

    let first_line = head.lines().next().unwrap_or("");
    let mut it = first_line.split_whitespace();
    let method = it.next().unwrap_or("");
    let target = it.next().unwrap_or("");

    if method != "CONNECT" {
        // Anything but CONNECT is a browser-side misconfiguration or a
        // probe. Reply with a short 400 so the tool sees a real answer,
        // then drop the connection.
        let _ = client
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 30\r\nConnection: close\r\n\r\nWellness Extract DLP proxy 47443\n")
            .await;
        return Ok(());
    }

    // target format: "example.com:443"
    let (host, port) = match target.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(443)),
        None => (target.to_string(), 443),
    };

    // Phase 3: everyone gets the raw tunnel. Phase 4 will branch here on
    // `is_public_webmail(&host)` and terminate TLS for those instead.
    let upstream = match TcpStream::connect((host.as_str(), port)).await {
        Ok(s) => s,
        Err(e) => {
            // Send a 502 so the browser shows "site can't be reached"
            // cleanly instead of hanging on an aborted CONNECT.
            let _ = client
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            return Err(e.into());
        }
    };

    // 200 OK on the CONNECT means "go ahead and speak TLS at me".
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;

    tunnel(client, upstream).await
}

/// Blind bidirectional byte copy between two TCP sockets. Uses
/// `tokio::io::copy_bidirectional` for the fast path; matches whichever
/// side closes first (half-close on one direction, then the other).
async fn tunnel(mut a: TcpStream, mut b: TcpStream) -> anyhow::Result<()> {
    match tokio::io::copy_bidirectional(&mut a, &mut b).await {
        Ok((c2s, s2c)) => {
            log::trace!("mitm: tunnel closed ({c2s} bytes up, {s2c} down)");
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset
            || e.kind() == std::io::ErrorKind::BrokenPipe
            || e.kind() == std::io::ErrorKind::UnexpectedEof => {
            // Normal browser navigation closes half the tunnel abruptly.
            // Don't spam warn-level for that.
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}
