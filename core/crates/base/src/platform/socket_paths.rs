//! Each home's two sockets, and the client's end of one. On Unix a socket lives in this user's
//! socket folder; on Windows it is a named pipe, whose name the daemon protocol's guide gives.

use std::io;
use std::path::{Path, PathBuf};

use crate::paths::{facade_home, home_key};

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::ClientSocket;

/// A blocking client's end of a socket. On Unix it is the standard library's `UnixStream`. On
/// Windows it is a named pipe's client end with the same methods, which checks that the server
/// runs as this user before `connect` returns.
#[cfg(unix)]
pub type ClientSocket = std::os::unix::net::UnixStream;

/// Signals EOF to the peer on Unix while keeping the read side open.
/// Windows named pipes have no half-close, so their readers stay connected.
pub fn shutdown_write_if_supported(socket: &ClientSocket) -> io::Result<()> {
    #[cfg(unix)]
    return socket.shutdown(std::net::Shutdown::Write);
    #[cfg(windows)]
    {
        let _ = socket;
        Ok(())
    }
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

/// Whether `error` says the other end of a connection went away, by a raw code that the standard
/// library gives no kind of its own: `EIO` on Unix; `ERROR_BROKEN_PIPE`, `ERROR_NO_DATA` and
/// `ERROR_PIPE_NOT_CONNECTED` on Windows.
pub fn is_connection_lost(error: &io::Error) -> bool {
    #[cfg(unix)]
    return error.raw_os_error() == Some(libc::EIO);
    #[cfg(windows)]
    windows::is_connection_lost(error)
}

/// `<service>-<home key>.sock` in the socket folder.
#[cfg(unix)]
fn socket_for(home: &Path, service: &str) -> anyhow::Result<PathBuf> {
    Ok(socket_dir()?.join(format!("{service}-{}.sock", home_key(home))))
}

/// `\\.\pipe\facade-core-<service>-<home key>`.
#[cfg(windows)]
fn socket_for(home: &Path, service: &str) -> anyhow::Result<PathBuf> {
    Ok(PathBuf::from(format!(
        r"\\.\pipe\facade-core-{service}-{}",
        home_key(home)
    )))
}

/// The user this process runs as.
#[cfg(unix)]
fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// `/tmp/facade-core-<uid>/`, this user's socket folder, made where it is missing. Its path is
/// short, so a socket's path in it stays within every system's limit. A folder another user owns,
/// or that is not a folder, is refused; one others may open is made private again. Unix only.
#[cfg(unix)]
pub fn socket_dir() -> anyhow::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
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
