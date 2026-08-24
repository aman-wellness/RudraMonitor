//! Small `multipart/form-data` parser for the older Gmail Web upload
//! shape (and Yahoo Mail's send body).
//!
//! Deliberately narrow-scope — the standard `multer` crate pulls in
//! futures / streams / mime and is heavier than the two-hundred bytes
//! of state we actually need for an already-in-memory body. This just
//! walks the boundary sequence and yields `(headers_map, body_slice)`
//! per part. No streaming, no chunked-encoding awareness — the
//! interceptor already buffered the full request body before calling
//! us.

/// One part inside a multipart body.
#[derive(Debug)]
#[allow(dead_code)]
pub struct Part<'a> {
    /// Lower-cased header names → raw values. Empty vec = the part
    /// has no headers (malformed but shouldn't crash the walk).
    pub headers: Vec<(String, String)>,
    /// Raw body bytes for this part — everything between the two
    /// boundary markers, minus the trailing \r\n.
    pub body: &'a [u8],
}

impl<'a> Part<'a> {
    /// Look up a header by (case-insensitive) name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Convenience: pull the filename out of a Content-Disposition
    /// header (`form-data; name="file"; filename="report.pdf"`).
    /// Returns None if the header is missing or doesn't carry one.
    pub fn filename(&self) -> Option<String> {
        let cd = self.header("content-disposition")?;
        let key = "filename=";
        let idx = cd.find(key)?;
        let rest = &cd[idx + key.len()..];
        let val = if let Some(stripped) = rest.strip_prefix('"') {
            let end = stripped.find('"')?;
            &stripped[..end]
        } else {
            let end = rest.find([';', ' ']).unwrap_or(rest.len());
            &rest[..end]
        };
        Some(val.to_string())
    }
}

/// Parse a multipart body. `boundary` is the raw value out of the
/// enclosing `Content-Type: multipart/form-data; boundary=XXX` header
/// (without the leading `--`). Returns an empty vec on any parse
/// error — this is defensive; the caller falls back to a
/// bytes-not-captured event which is still better than dropping the
/// whole session.
pub fn parse<'a>(body: &'a [u8], boundary: &str) -> Vec<Part<'a>> {
    let mut out = Vec::new();
    let sep = format!("--{}", boundary);
    let sep_bytes = sep.as_bytes();

    // First find of the boundary tells us where the preamble ends.
    let mut cursor = match find(body, sep_bytes) {
        Some(i) => i + sep_bytes.len(),
        None => return out,
    };

    loop {
        // Terminator boundary is `--boundary--`. Peek and bail.
        if body.get(cursor..cursor + 2) == Some(b"--") {
            return out;
        }
        // Skip past the CRLF after the boundary.
        if body.get(cursor..cursor + 2) == Some(b"\r\n") {
            cursor += 2;
        }

        // Next boundary marker ends this part.
        let part_end = match find(&body[cursor..], sep_bytes) {
            Some(i) => cursor + i,
            None => return out,
        };
        // Split part into (head, body).
        let hdr_end = match find(&body[cursor..part_end], b"\r\n\r\n") {
            Some(i) => cursor + i,
            None => {
                cursor = part_end + sep_bytes.len();
                continue;
            }
        };
        let head_slice = &body[cursor..hdr_end];
        let body_slice_end = if part_end >= 2 && &body[part_end - 2..part_end] == b"\r\n" {
            part_end - 2
        } else {
            part_end
        };
        let body_slice = &body[hdr_end + 4..body_slice_end];

        // Parse the headers into (name, value) pairs.
        let headers = parse_headers(head_slice);
        out.push(Part {
            headers,
            body: body_slice,
        });

        cursor = part_end + sep_bytes.len();
    }
}

/// Byte-slice needle-in-haystack. Naive O(n·m); the multipart bodies
/// we deal with are ≤ 25 MB and the boundary strings are ≤ ~40 chars,
/// so a proper Boyer-Moore is overkill.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_headers(bytes: &[u8]) -> Vec<(String, String)> {
    let s = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in s.split("\r\n") {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            out.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    out
}

/// Extract the boundary from a Content-Type header like
/// `multipart/form-data; boundary=WebKitFormBoundaryABC`. Trims
/// optional quotes and any parameters after boundary.
pub fn boundary_of(content_type: &str) -> Option<String> {
    let key = "boundary=";
    let idx = content_type.find(key)?;
    let rest = &content_type[idx + key.len()..];
    let s = if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        &stripped[..end]
    } else {
        let end = rest.find([';', ' ']).unwrap_or(rest.len());
        &rest[..end]
    };
    Some(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_two_part_body() {
        let boundary = "AaB03x";
        let body = b"--AaB03x\r\nContent-Disposition: form-data; name=\"field1\"\r\n\r\nvalue1\r\n--AaB03x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nfile contents\r\n--AaB03x--\r\n";
        let parts = parse(body, boundary);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].body, b"value1");
        assert_eq!(parts[1].filename().as_deref(), Some("a.txt"));
        assert_eq!(parts[1].body, b"file contents");
        assert_eq!(parts[1].header("content-type"), Some("text/plain"));
    }

    #[test]
    fn extracts_boundary_from_content_type() {
        assert_eq!(
            boundary_of("multipart/form-data; boundary=abc123"),
            Some("abc123".to_string())
        );
        assert_eq!(
            boundary_of("multipart/form-data; boundary=\"quoted\"; charset=utf-8"),
            Some("quoted".to_string())
        );
        assert_eq!(boundary_of("application/json"), None);
    }
}
