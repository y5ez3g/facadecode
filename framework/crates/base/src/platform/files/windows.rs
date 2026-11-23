//! Paths on Windows.

use std::io;
use std::path::{Path, PathBuf};

/// `path` with its links resolved, without the `\\?\` prefix where the path does not need it.
pub(super) fn real_path(path: &Path) -> io::Result<PathBuf> {
    let resolved = std::fs::canonicalize(path)?;
    let text = resolved.as_os_str().to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return Ok(PathBuf::from(format!(r"\\{unc}")));
    }
    match text.strip_prefix(r"\\?\") {
        Some(plain) if plain.len() < 260 && !plain.contains('/') => Ok(PathBuf::from(plain)),
        _ => Ok(resolved),
    }
}

/// The path with `/` as `\` and its letters in lower case.
pub(super) fn folder_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}
