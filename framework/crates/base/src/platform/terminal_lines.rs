//! Keeper protocol lines that may carry a terminal, for the daemon's side of the keeper link.
//!
//! A line carries at most one terminal. On Unix the terminal's master goes with the line's first
//! byte (`SCM_RIGHTS`, through [`super::descriptors`]). On Windows it is the line's top-level
//! `terminal` member, `{"input": …, "output": …, "signal": …, "job": …}`: each value is a handle
//! that the sender duplicated into the receiving process before it wrote the line, and `signal` is
//! absent where the sender had let go of its copy for a stop. The sender retains ownership until
//! the whole line is delivered. The receiver authenticates the peer before reading its handles.

use std::io;

use super::socket_paths::ClientSocket;
use super::terminal::PtyMaster;
use crate::process::ProcessIdentity;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

#[cfg(windows)]
pub use windows::{
    InvalidTerminalEnvelope, PeerProcess, PreparedTerminal, add_terminal, take_terminal,
};

/// Writes lines, each with the terminal it carries, to the process `receiver` at the other end.
pub struct LineSender(imp::Sender);

impl LineSender {
    /// Writes to `socket`, whose other end is the process `receiver`, which Windows duplicates
    /// handles into.
    pub fn new(socket: ClientSocket, receiver: &ProcessIdentity) -> io::Result<LineSender> {
        imp::Sender::new(socket, receiver).map(LineSender)
    }

    /// Writes all of `line`, newline included, with `terminal` where it carries one; blocks until
    /// it is written.
    pub fn send(&self, line: &[u8], terminal: Option<&PtyMaster>) -> io::Result<()> {
        self.0.send(line, terminal)
    }
}

/// Reads lines, each with the terminal it carried.
pub struct LineReceiver(imp::Receiver);

impl LineReceiver {
    /// On Windows, the caller must authenticate the peer before reading from this socket.
    pub fn new(socket: ClientSocket) -> LineReceiver {
        LineReceiver(imp::Receiver::new(socket))
    }

    /// The next line without its newline, with the terminal it carried; None at the end. A line
    /// longer than `MAX_LINE_BYTES` is `InvalidData`. Blocks until a line comes.
    pub fn next_line(&mut self) -> io::Result<Option<(Vec<u8>, Option<PtyMaster>)>> {
        self.0.next_line()
    }
}
