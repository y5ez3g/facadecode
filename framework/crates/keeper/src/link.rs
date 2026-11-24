//! The keeper's end of the daemon's connection. The peer is checked through the kernel before a
//! single byte is read; after that the link only moves newline-framed messages, and the PTY
//! masters that ride along with them, in both directions.

use std::io;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use facade_base::api_v1::{ApiVersion, MAX_LINE_BYTES, encode_line};
use facade_base::descriptors::{DescriptorLines, send_line};
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
    api_version: Option<ApiVersion>,
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
    /// record in `framework/daemon.lock`. Anyone else is turned away and logged.
    pub(super) fn prove(socket: UnixStream, framework: &Path) -> Option<Link> {
        let daemon = match service::authenticate(&socket, framework, Service::Daemon) {
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
                api_version: None,
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

    /// The version selected by `hello` on this proved link.
    pub(super) fn api_version(&self) -> Option<ApiVersion> {
        self.api_version
    }

    pub(super) fn set_api_version(&mut self, version: ApiVersion) {
        self.api_version = Some(version);
    }

    /// Everything that has arrived so far, without blocking. A `Closed` or `Overlong` entry is
    /// always last.
    pub(super) fn drain(&mut self) -> Vec<Inbound> {
        let mut got = Vec::new();
        loop {
            match self.inbox.next_line() {
                Ok(Some((_, text))) if text.len() >= MAX_LINE_BYTES => {
                    got.push(Inbound::Overlong);
                    return got;
                }
                Ok(Some((begin, text))) => {
                    let end = begin + text.len() as u64 + 1;
                    let attached = match self.inbox.take_carried(begin, end) {
                        Ok(mut fds) if fds.len() <= 1 => Ok(fds.pop()),
                        Ok(fds) => Err(fds.len()),
                        Err(count) => Err(count),
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
