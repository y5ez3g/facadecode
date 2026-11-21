//! Where the daemon of the relay's Facade home listens, by the rule in `core/protocol/DAEMON.md`,
//! "Connect to the daemon". `facade-base` follows the same rule; the scenario tests that go
//! through the relay keep the two the same.

use std::path::PathBuf;

#[cfg(unix)]
use nix::unistd::Uid;
use sha2::{Digest, Sha256};

/// The daemon socket of the Facade home this process's environment names. Fails, saying why,
/// where it names none.
pub(crate) fn daemon_socket() -> Result<PathBuf, String> {
    let home = facade_home()?;
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    let key = digest.iter().take(5).map(|byte| format!("{byte:02x}"));
    let key = key.collect::<Vec<_>>().concat();
    #[cfg(unix)]
    let socket = PathBuf::from(format!(
        "/tmp/facade-core-{}/daemon-{key}.sock",
        Uid::current()
    ));
    #[cfg(windows)]
    let socket = PathBuf::from(format!(r"\\.\pipe\facade-core-daemon-{key}"));
    Ok(socket)
}

/// The Facade home, by the same rule.
fn facade_home() -> Result<PathBuf, String> {
    match std::env::var_os("FACADE_HOME").map(PathBuf::from) {
        Some(home) if home.as_os_str().is_empty() => {}
        Some(home) if home.is_absolute() => return Ok(home),
        Some(home) => {
            return Err(format!(
                "FACADE_HOME must be an absolute path; got {}",
                home.display()
            ));
        }
        None => {}
    }
    let user = ["HOME", "USERPROFILE"]
        .into_iter()
        .find_map(std::env::var_os)
        .ok_or("cannot find the Facade home: FACADE_HOME, HOME and USERPROFILE are unset")?;
    Ok(PathBuf::from(user).join(".facade"))
}
