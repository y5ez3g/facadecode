//! A terminal's master with a line, as the descriptor of its first byte.

use std::io;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;

use crate::platform::descriptors::{DescriptorLines, send_line};
use crate::platform::terminal::PtyMaster;
use crate::process::ProcessIdentity;

pub(super) struct Sender(UnixStream);

impl Sender {
    pub(super) fn new(socket: UnixStream, _receiver: &ProcessIdentity) -> io::Result<Sender> {
        Ok(Sender(socket))
    }

    pub(super) fn send(&self, line: &[u8], terminal: Option<&PtyMaster>) -> io::Result<()> {
        let fds: Vec<_> = terminal.iter().map(|master| master.as_fd()).collect();
        send_line(self.0.as_fd(), line, &fds, None)
    }
}

pub(super) struct Receiver(DescriptorLines);

impl Receiver {
    pub(super) fn new(socket: UnixStream) -> Receiver {
        Receiver(DescriptorLines::new(socket))
    }

    pub(super) fn next_line(&mut self) -> io::Result<Option<(Vec<u8>, Option<PtyMaster>)>> {
        let Some((begin, line)) = self.0.next_line()? else {
            return Ok(None);
        };
        // The line's newline comes after it.
        let end = begin + line.len() as u64 + 1;
        // A terminal is one descriptor: a line with another count, or whose descriptors the
        // kernel dropped, carries none, and those that came are closed.
        let terminal = match self.0.take_carried(begin, end) {
            Ok(mut fds) if fds.len() == 1 => fds.pop().map(PtyMaster::from),
            _ => None,
        };
        Ok(Some((line, terminal)))
    }
}
