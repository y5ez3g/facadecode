//! The folder the services' sockets live in, and each home's two sockets in it.

use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::paths::{facade_home, home_key};

/// The user this process runs as.
fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// `/tmp/facade-core-<uid>/`, this user's socket folder, made where it is missing. Its path is
/// short, so a socket's path in it stays within every system's limit. A folder another user owns,
/// or that is not a folder, is refused; one others may open is made private again.
pub fn socket_dir() -> anyhow::Result<PathBuf> {
    let dir = PathBuf::from(format!("/tmp/facade-core-{}", uid()));
    if let Err(err) = std::fs::DirBuilder::new().mode(0o700).create(&dir)
        && err.kind() != io::ErrorKind::AlreadyExists
    {
        return Err(err.into());
    }
    let meta = std::fs::symlink_metadata(&dir)?;
    anyhow::ensure!(
        meta.is_dir() && meta.uid() == uid(),
        "cannot use {}: it is not a folder owned by this user",
        dir.display()
    );
    if meta.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// The keeper socket of this process's home.
pub fn keeper_socket() -> anyhow::Result<PathBuf> {
    keeper_socket_for(&facade_home()?)
}

/// The daemon socket of this process's home.
pub fn daemon_socket() -> anyhow::Result<PathBuf> {
    daemon_socket_for(&facade_home()?)
}

/// The keeper socket of `home`, whatever this process's `FACADE_HOME` is.
pub fn keeper_socket_for(home: &Path) -> anyhow::Result<PathBuf> {
    socket_for(home, "keeper")
}

/// The daemon socket of `home`, whatever this process's `FACADE_HOME` is.
pub fn daemon_socket_for(home: &Path) -> anyhow::Result<PathBuf> {
    socket_for(home, "daemon")
}

/// `<service>-<home key>.sock` in the socket folder.
fn socket_for(home: &Path, service: &str) -> anyhow::Result<PathBuf> {
    Ok(socket_dir()?.join(format!("{service}-{}.sock", home_key(home))))
}
