//! The daemon's Unix socket.

use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::Path;

use tokio::io::Interest;
use tokio::io::unix::AsyncFd;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};

pub(super) type Socket = UnixStream;
pub(super) type Reader = OwnedReadHalf;
pub(super) type Writer = OwnedWriteHalf;

pub(super) struct Listener(UnixListener);

impl Listener {
    pub(super) fn bind(path: &Path) -> io::Result<Listener> {
        let _ = std::fs::remove_file(path);
        UnixListener::bind(path).map(Listener)
    }

    pub(super) async fn accept(&mut self) -> io::Result<Socket> {
        self.0.accept().await.map(|(socket, _)| socket)
    }
}

pub(super) fn peer_pid(socket: &Socket) -> Option<u32> {
    crate::platform::unix_process::peer_pid(socket.as_fd())
}

pub(super) fn split(socket: Socket) -> (Reader, Writer, Peer) {
    let peer = Peer(socket.as_fd().try_clone_to_owned().ok());
    let (reader, writer) = socket.into_split();
    (reader, writer, peer)
}

/// A copy of the connection's descriptor; None where it could not be copied, and then the close
/// is never seen.
pub(super) struct Peer(Option<OwnedFd>);

impl Peer {
    pub(super) async fn closed(&self) {
        let watched = self
            .0
            .as_ref()
            .and_then(|socket| socket.try_clone().ok())
            // SAFETY: the copy is owned by the AsyncFd, so it stays open, and the same descriptor,
            // for as long as it is registered.
            .and_then(|copy| {
                unsafe { AsyncFd::register_with_interest(copy, Interest::READABLE) }.ok()
            });
        let Some(watched) = watched else {
            return std::future::pending().await;
        };
        while let Ok(mut ready) = watched.readable().await {
            if ready.ready().is_read_closed() {
                return;
            }
            // Readable bytes belong to the reader: wait for more of them, or for the close.
            ready.clear_ready();
        }
    }

    pub(super) fn shutdown(&self, how: std::net::Shutdown) {
        let how = match how {
            std::net::Shutdown::Read => nix::sys::socket::Shutdown::Read,
            std::net::Shutdown::Write => nix::sys::socket::Shutdown::Write,
            std::net::Shutdown::Both => nix::sys::socket::Shutdown::Both,
        };
        if let Some(socket) = &self.0 {
            let _ = nix::sys::socket::shutdown(socket.as_raw_fd(), how);
        }
    }
}

pub(super) fn pair() -> io::Result<(std::os::unix::net::UnixStream, Socket)> {
    let (ours, theirs) = std::os::unix::net::UnixStream::pair()?;
    theirs.set_nonblocking(true)?;
    Ok((ours, UnixStream::from_std(theirs)?))
}
