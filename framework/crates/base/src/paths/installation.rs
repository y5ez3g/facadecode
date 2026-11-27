//! The installation layout, shared with the standalone MCP relay.

use std::path::{Path, PathBuf};

/// The installation that contains the running program, using the default home's spelling
/// when it reaches the same directory.
pub(crate) fn home(default: Option<&Path>) -> Option<PathBuf> {
    let program = std::env::current_exe().ok()?.canonicalize().ok()?;
    let home = installed_bin(&program)?.parent()?.parent()?;
    Some(
        default
            .filter(|default| {
                default.is_absolute() && default.canonicalize().ok().as_deref() == Some(home)
            })
            .map_or_else(|| home_spelling(home), Path::to_path_buf),
    )
}

/// The bin folder of an installed launcher or versioned program.
pub(crate) fn installed_bin(program: &Path) -> Option<&Path> {
    let suffix = Path::new("framework").join("bin");
    program.ancestors().skip(1).take(2).find(|bin| {
        let Some(home) = bin.parent().and_then(Path::parent) else {
            return false;
        };
        bin.ends_with(&suffix)
            || home
                .join(&suffix)
                .canonicalize()
                .is_ok_and(|standard| bin.canonicalize().ok().as_ref() == Some(&standard))
    })
}

/// The ordinary Windows spelling of a resolved home where it needs no verbatim prefix.
fn home_spelling(home: &Path) -> PathBuf {
    if cfg!(windows) {
        let text = home.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(plain) = text.strip_prefix(r"\\?\")
            && plain.len() < 260
            && !plain.contains('/')
        {
            return PathBuf::from(plain);
        }
    }
    home.to_path_buf()
}
