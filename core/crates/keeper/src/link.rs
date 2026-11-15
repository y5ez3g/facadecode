//! The keeper's end of the daemon's connection. The peer is checked through the kernel before a
//! single byte is read; after that the link only moves newline-framed messages, and the PTY
//! masters that ride along with them, in both directions.

use std::io;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use facade_base::descriptors::{DescriptorLines, send_line};
use facade_base::jsonrpc::encode_line;
use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
use serde::Serialize;

use crate::log;

/// How long one outgoing message may wait for the daemon to make room. A daemon that has not read
/// for this long is treated as gone: the link is dropped and the ping watchdog takes it from there.
const SEND_TIMEOUT: Duration = Duration::from_secs(1);

pub(super) struct Link {
    socket: UnixStream,
    inbox: DescriptorLines,
    daemon: ProcessIdentity,
    greeted: bool,
}

/// One thing read from the link.
pub(super) enum Inbound {
    /// A message line (newline stripped) and what came attached to it: `Ok` with at most one
    /// descriptor, or `Err` with how many came when there were several (those are closed).
    Line(Vec<u8>, Result<Option<OwnedFd>, usize>),
    /// The daemon sent a line over the protocol's size limit.
    Overlong,
    /// End of stream, or a read error.
    Closed,
}

impl Link {
    /// Accepts `socket` only if its peer is a process of this user whose pid and birth match the
    /// record in `core/daemon.lock`. Anyone else is turned away and logged.
    pub(super) fn prove(socket: UnixStream, core: &Path) -> Option<Link> {
        let daemon = match service::authenticate(&socket, core, Service::Daemon) {
            Ok(daemon) => daemon,
            Err(reason) => {
                log("warn", &format!("turned away a connection: {reason}"));
                return None;
            }
        };
        match socket.try_clone().and_then(DescriptorLines::nonblocking) {
            Ok(inbox) => Some(Link {
                socket,
                inbox,
                daemon,
                greeted: false,
            }),
            Err(err) => {
                log("warn", &format!("turned away a connection: {err}"));
                None
            }
        }
    }

    /// The daemon process at the other end.
    pub(super) fn daemon(&self) -> &ProcessIdentity {
        &self.daemon
    }

    /// What `poll` watches for this link.
    pub(super) fn readable(&self) -> BorrowedFd<'_> {
        self.socket.as_fd()
    }

    /// Whether `hello` has succeeded on this link.
    pub(super) fn is_greeted(&self) -> bool {
        self.greeted
    }

    pub(super) fn mark_greeted(&mut self) {
        self.greeted = true;
    }

    /// Everything that has arrived so far, without blocking. A `Closed` or `Overlong` entry is
    /// always last.
    pub(super) fn drain(&mut self) -> Vec<Inbound> {
        let mut got = Vec::new();
        loop {
            match self.inbox.next_line() {
                Ok(Some((offset, text))) => {
                    let attached = self.inbox.take(offset, 1).map(|mut fds| fds.pop());
                    let attached = match attached {
                        Err(0) => Ok(None),
                        other => other,
                    };
                    got.push(Inbound::Line(text, attached));
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => return got,
                Err(err) if err.kind() == io::ErrorKind::InvalidData => {
                    got.push(Inbound::Overlong);
                    return got;
                }
                Err(err) => {
                    log("warn", &format!("reading from the daemon failed: {err}"));
                    got.push(Inbound::Closed);
                    return got;
                }
                Ok(None) => {
                    got.push(Inbound::Closed);
                    return got;
                }
            }
        }
    }

    /// Serializes `message` as one line and writes it, attaching `fd` if given. Gives up after
    /// [`SEND_TIMEOUT`]; any error means the link should be dropped.
    pub(super) fn write(
        &self,
        message: &impl Serialize,
        fd: Option<BorrowedFd<'_>>,
    ) -> io::Result<()> {
        let attached: Vec<BorrowedFd<'_>> = fd.into_iter().collect();
        let deadline = Instant::now() + SEND_TIMEOUT;
        send_line(
            self.socket.as_fd(),
            &encode_line(message),
            &attached,
            Some(deadline),
        )
    }
}
