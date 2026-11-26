//! Each home's two sockets, and the client's end of one. On Unix a socket lives in this user's
//! socket folder; on Windows it is a named pipe, whose name the daemon protocol's guide gives.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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

/// Opens the client's socket within the deadline. A busy endpoint can be retried by the caller.
pub fn connect_client_until(path: &Path, until: Instant) -> io::Result<ClientSocket> {
    connect_time_left(until)?;
    #[cfg(unix)]
    let socket = connect_unix_client_until(path, until)?;
    #[cfg(windows)]
    let socket = ClientSocket::try_connect(path)?;
    connect_time_left(until)?;
    Ok(socket)
}

fn connect_time_left(until: Instant) -> io::Result<Duration> {
    let remaining = until.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(io::ErrorKind::TimedOut.into());
    }
    Ok(remaining)
}

#[cfg(unix)]
fn connect_unix_client_until(path: &Path, until: Instant) -> io::Result<ClientSocket> {
    use std::os::fd::{AsFd, AsRawFd, FromRawFd, IntoRawFd};

    use nix::errno::Errno;
    use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
    use nix::sys::socket::{UnixAddr, connect, getsockopt, sockopt::SocketError};

    let addr = UnixAddr::new(path)?;
    let socket = {
        #[cfg(target_os = "macos")]
        let _forks = loop {
            connect_time_left(until)?;
            match super::unix_process::FORK_LOCK.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(error)) => break error.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    let remaining = connect_time_left(until)?;
                    std::thread::sleep(remaining.min(Duration::from_millis(1)));
                }
            }
        };
        tokio::net::UnixSocket::new_stream()?
    };
    connect_time_left(until)?;
    match connect(socket.as_raw_fd(), &addr) {
        Ok(()) => {}
        Err(Errno::EINPROGRESS) => {
            let mut fds = [PollFd::new(socket.as_fd(), PollFlags::POLLOUT)];
            loop {
                let remaining = connect_time_left(until)?;
                let millis = remaining.as_nanos().div_ceil(1_000_000);
                let timeout = PollTimeout::try_from(millis).unwrap_or(PollTimeout::MAX);
                match poll(&mut fds, timeout) {
                    Ok(0) | Err(Errno::EINTR) => continue,
                    Ok(_) => break,
                    Err(error) => return Err(error.into()),
                }
            }
            connect_time_left(until)?;
            let error = getsockopt(&socket, SocketError)?;
            if error != 0 {
                return Err(io::Error::from_raw_os_error(error));
            }
        }
        Err(error) => return Err(error.into()),
    }
    // SAFETY: into_raw_fd transfers ownership of the connected stream descriptor.
    let stream = unsafe { ClientSocket::from_raw_fd(socket.into_raw_fd()) };
    stream.set_nonblocking(false)?;
    Ok(stream)
}

/// Clears the timeouts shared by the client's read and write handles.
pub(crate) fn clear_client_timeouts(socket: &ClientSocket) -> io::Result<()> {
    allow_timeout_on_hangup(socket, socket.set_read_timeout(None)).and(allow_timeout_on_hangup(
        socket,
        socket.set_write_timeout(None),
    ))
}

/// macOS can reject a timeout change with EINVAL after the peer closes. A read-side hangup
/// confirms that any remaining bytes can be read without waiting for the peer.
pub(crate) fn allow_timeout_on_hangup(
    socket: &ClientSocket,
    changed: io::Result<()>,
) -> io::Result<()> {
    #[cfg(unix)]
    if changed
        .as_ref()
        .is_err_and(|error| error.raw_os_error() == Some(libc::EINVAL))
    {
        use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
        use std::os::fd::AsFd;

        let mut reads = [PollFd::new(socket.as_fd(), PollFlags::POLLIN)];
        if poll(&mut reads, PollTimeout::ZERO).is_ok()
            && reads[0]
                .revents()
                .is_some_and(|events| events.contains(PollFlags::POLLHUP))
        {
            return Ok(());
        }
    }
    #[cfg(windows)]
    let _ = socket;
    changed
}

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

/// `\\.\pipe\facade-framework-<service>-<home key>`.
#[cfg(windows)]
fn socket_for(home: &Path, service: &str) -> anyhow::Result<PathBuf> {
    Ok(PathBuf::from(format!(
        r"\\.\pipe\facade-framework-{service}-{}",
        home_key(home)
    )))
}

/// The user this process runs as.
#[cfg(unix)]
fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// `/tmp/facade-framework-<uid>/`, this user's socket folder, made where it is missing. Its path is
/// short, so a socket's path in it stays within every system's limit. A folder another user owns,
/// or that is not a folder, is refused; one others may open is made private again. Unix only.
#[cfg(unix)]
pub fn socket_dir() -> anyhow::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let dir = PathBuf::from(format!("/tmp/facade-framework-{}", uid()));
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
