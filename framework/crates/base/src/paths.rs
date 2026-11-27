//! The Facade home, its sockets and the client's end of one.
//!
//! The socket paths, [`ClientSocket`] and [`is_connection_lost`] come from the platform: on Unix a
//! socket is a file in this user's socket folder, on Windows a named pipe.

use std::ffi::OsString;
use std::fmt::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

mod installation;

pub use crate::platform::paths::*;
pub(crate) use installation::installed_bin;

/// The Facade home. `FACADE_HOME` names it as an absolute path. The installed Shell supplies
/// its own home there when unset. Otherwise the default is `.facade` in `HOME` or `USERPROFILE`.
/// An empty `FACADE_HOME` counts as unset.
pub fn facade_home() -> anyhow::Result<PathBuf> {
    home_from(|name| std::env::var_os(name))
}

/// The Facade home that contains the running executable, for an installed Shell or service.
pub fn installed_facade_home() -> Option<PathBuf> {
    let home = installation::home(facade_home().ok().as_deref())?;
    Some(active_installation_home(&home).unwrap_or(home))
}

/// The v1 spelling used by the daemon of this physical installation, if its lock proves one.
pub fn active_installation_home(home: &Path) -> Option<PathBuf> {
    let physical = home.canonicalize().ok()?;
    let (running, _) = crate::service::running_daemon_home(home).ok().flatten()?;
    (running.is_absolute() && running.canonicalize().ok().as_ref() == Some(&physical))
        .then_some(running)
}

pub(crate) fn home_from(
    mut variable: impl FnMut(&str) -> Option<OsString>,
) -> anyhow::Result<PathBuf> {
    match variable("FACADE_HOME").map(PathBuf::from) {
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
        .find_map(variable)
        .ok_or_else(|| {
            anyhow::anyhow!("cannot locate the Facade home: HOME and USERPROFILE are unset")
        })?;
    Ok(PathBuf::from(user).join(".facade"))
}

/// `framework/` in the Facade home, where the Framework keeps its records, screens, logs and the services'
/// locks.
pub fn framework_dir() -> anyhow::Result<PathBuf> {
    facade_home().map(|home| home.join("framework"))
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
