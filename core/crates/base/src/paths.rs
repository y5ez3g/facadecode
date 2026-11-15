//! The Facade home, and the sockets its services listen on.

use std::fmt::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub use crate::platform::{
    daemon_socket, daemon_socket_for, keeper_socket, keeper_socket_for, socket_dir,
};

/// The Facade home. `FACADE_HOME` names it, as an absolute path; without it, it is `.facade` in
/// the user's home folder, `HOME` or else `USERPROFILE`. A `FACADE_HOME` that is set but empty,
/// as a CLI passes on a variable it refers to that is unset, counts as unset.
pub fn facade_home() -> anyhow::Result<PathBuf> {
    match std::env::var_os("FACADE_HOME").map(PathBuf::from) {
        Some(named) if named.as_os_str().is_empty() => {}
        Some(named) if named.is_absolute() => return Ok(named),
        Some(named) => anyhow::bail!(
            "FACADE_HOME must be an absolute path; got {}",
            named.display()
        ),
        None => {}
    }
    let user = ["HOME", "USERPROFILE"]
        .into_iter()
        .find_map(std::env::var_os)
        .ok_or_else(|| {
            anyhow::anyhow!("cannot locate the Facade home: HOME and USERPROFILE are unset")
        })?;
    Ok(PathBuf::from(user).join(".facade"))
}

/// `core/` in the Facade home, where the core keeps its records, screens, logs and the services'
/// locks.
pub fn core_dir() -> anyhow::Result<PathBuf> {
    facade_home().map(|home| home.join("core"))
}

/// The ten hexadecimal digits that tell `home`'s sockets from another home's: the first five
/// bytes of the SHA-256 of its path. The path is taken as written, with symbolic links left
/// alone, and as UTF-8, any other bytes replaced as [`Path::to_string_lossy`] replaces them.
pub fn home_key(home: &Path) -> String {
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    digest[..5].iter().fold(String::new(), |mut key, byte| {
        let _ = write!(key, "{byte:02x}");
        key
    })
}
