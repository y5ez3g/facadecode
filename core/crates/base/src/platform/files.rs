//! Files and folders only this user may read, and how paths are compared.
//!
//! On Unix, private means mode 0600 for a file and 0700 for a folder. On Windows Facade sets no
//! access list: each file and folder inherits its folder's, and the default home is private through
//! the user's profile.

use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[cfg(windows)]
mod windows;

/// Whether the current system can use `name` as one directory component.
pub fn valid_folder_name(name: &str) -> bool {
    if matches!(name, "" | "." | "..")
        || name.contains('\0')
        || name.contains(std::path::is_separator)
    {
        return false;
    }
    #[cfg(windows)]
    {
        if name.ends_with(['.', ' ']) || name.contains(|c: char| c < ' ' || "<>:\"|?*".contains(c))
        {
            return false;
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let numbered_port = stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9');
        !(numbered_port || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()))
    }
    #[cfg(unix)]
    true
}

/// Opens `path` for writing, empty, made private where it is new.
pub fn create_private_file(path: &Path) -> io::Result<File> {
    private_options()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
}

/// Options that make a file private where they create it: mode 0600 on Unix, nothing on Windows.
pub fn private_options() -> OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.mode(0o600);
        options
    }
    #[cfg(windows)]
    OpenOptions::new()
}

/// Makes the folder `path`, private, where it is missing; its parent must exist.
pub fn create_private_folder(path: &Path) -> io::Result<()> {
    folder_builder(false).create(path)
}

/// Makes the folder `path` and every missing folder above it, private.
pub fn create_private_folder_all(path: &Path) -> io::Result<()> {
    folder_builder(true).create(path)
}

fn folder_builder(recursive: bool) -> std::fs::DirBuilder {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
}

/// Makes the file or folder `path` this user's alone: 0600 for a file and 0700 for a folder on
/// Unix; nothing on Windows.
pub fn make_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if std::fs::metadata(path)?.is_dir() {
            0o700
        } else {
            0o600
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    std::fs::metadata(path).map(drop)
}

/// Whether neither the group nor others have any access to `path` on Unix; always true on
/// Windows.
pub fn is_private(path: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(std::fs::metadata(path)?.permissions().mode() & 0o077 == 0)
    }
    #[cfg(windows)]
    std::fs::metadata(path).map(|_| true)
}

/// Makes what was written into the folder `path`, such as a new or renamed file, last through a
/// crash: Unix syncs the folder itself; Windows needs nothing, as NTFS journals its metadata in
/// order.
pub fn sync_folder(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    return File::open(path)?.sync_all();
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
}

/// `path` with its links resolved. Windows leaves out the `\\?\` prefix where the path does not
/// need it, so that it compares with what Git and editors print.
pub fn real_path(path: &Path) -> io::Result<PathBuf> {
    #[cfg(unix)]
    return std::fs::canonicalize(path);
    #[cfg(windows)]
    windows::real_path(path)
}

/// SQLite's URI for a quiet database. Escape filenames before adding the connection parameter.
pub fn immutable_uri(path: &Path) -> Option<String> {
    let raw = path.to_str()?;
    let windows;
    let raw = if cfg!(windows) {
        windows = raw.replace('\\', "/");
        windows.strip_prefix("//?/").unwrap_or(&windows)
    } else {
        raw
    };
    let mut uri = String::from("file://");
    if cfg!(windows) {
        if let Some(unc) = raw.strip_prefix("UNC/") {
            uri.push_str("//");
            encode_uri_path(&mut uri, unc);
            uri.push_str("?immutable=1");
            return Some(uri);
        }
        if !raw.starts_with('/') {
            uri.push('/');
        }
    }
    encode_uri_path(&mut uri, raw);
    uri.push_str("?immutable=1");
    Some(uri)
}

fn encode_uri_path(uri: &mut String, path: &str) {
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            uri.push(byte as char);
        } else {
            write!(uri, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
}

/// The form in which two folders are compared: two folders are the same where their keys are.
/// Windows folds letter case and `/` into `\`; Unix keeps the path as written.
pub fn folder_key(path: &Path) -> String {
    #[cfg(unix)]
    return path.to_string_lossy().into_owned();
    #[cfg(windows)]
    windows::folder_key(path)
}
