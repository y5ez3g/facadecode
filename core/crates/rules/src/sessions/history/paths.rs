use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use facade_base::system::{SYSTEM, System};

/// A file URL from Antigravity's workspace URIs or Pi's session directory setting.
pub(super) fn file_url(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file:")?;
    let rest = rest.split(['?', '#']).next()?;
    let (host, encoded) = match rest.strip_prefix("//") {
        Some(authority) => authority.split_at(authority.find('/')?),
        None => ("", rest),
    };
    let mut bytes = encoded.bytes();
    let mut decoded = Vec::new();
    while let Some(byte) = bytes.next() {
        let byte = if byte == b'%' {
            let high = (bytes.next()? as char).to_digit(16)?;
            let low = (bytes.next()? as char).to_digit(16)?;
            let decoded = (high * 16 + low) as u8;
            if decoded == b'/' || (SYSTEM == System::Windows && decoded == b'\\') {
                return None;
            }
            decoded
        } else {
            byte
        };
        if byte == 0 {
            return None;
        }
        decoded.push(byte);
    }
    let decoded = String::from_utf8(decoded).ok()?;
    let local = host.is_empty() || host.eq_ignore_ascii_case("localhost");
    let path = match SYSTEM {
        System::Windows if local => PathBuf::from(decoded.strip_prefix('/')?),
        System::Windows => PathBuf::from(format!("//{host}{decoded}")),
        System::Unix if local => PathBuf::from(decoded),
        System::Unix => return None,
    };
    path.is_absolute().then_some(path)
}

/// SQLite's URI for a quiet database. Escape filenames before adding the connection parameter.
pub(super) fn immutable_uri(path: &Path) -> Option<String> {
    let raw = path.to_str()?;
    let windows;
    let raw = match SYSTEM {
        System::Unix => raw,
        System::Windows => {
            windows = raw.replace('\\', "/");
            windows.strip_prefix("//?/").unwrap_or(&windows)
        }
    };
    let mut uri = String::from("file://");
    if SYSTEM == System::Windows {
        if let Some(unc) = raw.strip_prefix("UNC/") {
            uri.push_str("//");
            encode(&mut uri, unc);
            uri.push_str("?immutable=1");
            return Some(uri);
        }
        if !raw.starts_with('/') {
            uri.push('/');
        }
    }
    encode(&mut uri, raw);
    uri.push_str("?immutable=1");
    Some(uri)
}

fn encode(uri: &mut String, path: &str) {
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            uri.push(byte as char);
        } else {
            write!(uri, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
}
