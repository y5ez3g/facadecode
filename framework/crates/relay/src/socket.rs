//! Where the daemon of the relay's Facade home listens, by the rule in `framework/protocol/DAEMON.md`,
//! "Connect to the daemon". `facade-base` follows the same rule; the scenario tests that go
//! through the relay keep the two the same.

use std::path::PathBuf;

#[cfg(unix)]
use nix::unistd::Uid;
use sha2::{Digest, Sha256};

#[path = "../../base/src/paths/installation.rs"]
mod installation;

pub(crate) struct Destination {
    pub(crate) home: PathBuf,
    pub(crate) socket: PathBuf,
    pub(crate) installed: bool,
}

/// The initial daemon address. An implicit launch uses its installation or the equivalent default.
pub(crate) fn daemon_socket() -> Result<Destination, String> {
    let (home, installed) = facade_home()?;
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    let key = digest.iter().take(5).map(|byte| format!("{byte:02x}"));
    let key = key.collect::<Vec<_>>().concat();
    Ok(Destination {
        home,
        socket: socket_for_key(&key),
        installed,
    })
}

pub(crate) fn socket_for_key(key: &str) -> PathBuf {
    #[cfg(unix)]
    return PathBuf::from(format!(
        "/tmp/facade-framework-{}/daemon-{key}.sock",
        Uid::current()
    ));
    #[cfg(windows)]
    return PathBuf::from(format!(r"\\.\pipe\facade-framework-daemon-{key}"));
}

/// The Facade home, by the same rule.
fn facade_home() -> Result<(PathBuf, bool), String> {
    match std::env::var_os("FACADE_HOME").map(PathBuf::from) {
        Some(home) if home.as_os_str().is_empty() => {}
        Some(home) if home.is_absolute() => return Ok((home, false)),
        Some(home) => {
            return Err(format!(
                "FACADE_HOME must be an absolute path; got {}",
                home.display()
            ));
        }
        None => {}
    }
    let default = ["HOME", "USERPROFILE"]
        .into_iter()
        .find_map(std::env::var_os)
        .map(|user| PathBuf::from(user).join(".facade"));
    if let Some(home) = installation::home(default.as_deref()) {
        return Ok((home, true));
    }
    default.map(|home| (home, false)).ok_or_else(|| {
        "cannot find the Facade home: FACADE_HOME, HOME and USERPROFILE are unset".into()
    })
}
