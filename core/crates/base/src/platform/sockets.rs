//! The daemon's side of its socket: the listener, and each client's connection. A Unix socket on
//! Unix; on Windows, instances of a named pipe that lets in its owner alone. Everything here needs a
//! tokio runtime.

use std::io;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::socket_paths::ClientSocket;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

#[cfg(windows)]
pub(crate) use windows::owner_only_pipe;
#[cfg(windows)]
pub use windows::server_pipe;

/// The daemon's socket, accepting clients.
pub struct DaemonListener(imp::Listener);

impl DaemonListener {
    /// Listens on `path`. Unix replaces a socket file left there, which the caller knows is stale
    /// as it holds the daemon's lock; Windows makes the pipe's instances with the owner-only access
    /// list.
    pub fn bind(path: &Path) -> io::Result<DaemonListener> {
        imp::Listener::bind(path).map(DaemonListener)
    }

    /// The next client's connection. Cancel-safe: a client is never lost to a cancelled accept.
    pub async fn accept(&mut self) -> io::Result<ServerSocket> {
        self.0.accept().await.map(ServerSocket)
    }
}

/// One client's connection, on the daemon's side.
pub struct ServerSocket(imp::Socket);

impl ServerSocket {
    /// The client's process, where the system tells it.
    pub fn peer_pid(&self) -> Option<u32> {
        imp::peer_pid(&self.0)
    }

    /// The connection's reading and writing halves, and what tells when the client closed.
    pub fn into_split(self) -> (ServerReader, ServerWriter, ServerPeer) {
        let (reader, writer, peer) = imp::split(self.0);
        (ServerReader(reader), ServerWriter(writer), ServerPeer(peer))
    }
}

/// The reading half of a client's connection.
pub struct ServerReader(imp::Reader);

/// The writing half of a client's connection.
pub struct ServerWriter(imp::Writer);

/// What tells when a client closed its connection, and closes it from the daemon's side.
pub struct ServerPeer(imp::Peer);

impl ServerPeer {
    /// Returns once the client closed the connection, even with bytes unread; reads no byte.
    pub async fn closed(&self) {
        self.0.closed().await;
    }

    /// Ends the connection in the direction `how`.
    pub fn shutdown(&self, how: std::net::Shutdown) {
        self.0.shutdown(how);
    }
}

/// A connection inside this process: the client's end, and the daemon's to serve. For the daemon's
/// own MCP tools.
pub fn pair() -> io::Result<(ClientSocket, ServerSocket)> {
    imp::pair().map(|(client, server)| (client, ServerSocket(server)))
}

macro_rules! read_through {
    ($type:ty) => {
        impl AsyncRead for $type {
            fn poll_read(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buf: &mut ReadBuf<'_>,
            ) -> Poll<io::Result<()>> {
                Pin::new(&mut self.0).poll_read(cx, buf)
            }
        }
    };
}

macro_rules! write_through {
    ($type:ty) => {
        impl AsyncWrite for $type {
            fn poll_write(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buf: &[u8],
            ) -> Poll<io::Result<usize>> {
                Pin::new(&mut self.0).poll_write(cx, buf)
            }

            fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
                Pin::new(&mut self.0).poll_flush(cx)
            }

            fn poll_shutdown(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
            ) -> Poll<io::Result<()>> {
                Pin::new(&mut self.0).poll_shutdown(cx)
            }
        }
    };
}

read_through!(ServerSocket);
write_through!(ServerSocket);
read_through!(ServerReader);
write_through!(ServerWriter);
