//! Cuts what a stream sends into lines: both sides of the relay write one message per line.

use std::io::{self, Read};

/// The most one read takes.
const MAX_READ_BYTES: usize = 64 * 1024;

/// What a stream sent that has not been taken as lines yet.
#[derive(Default)]
pub(crate) struct Lines {
    unread: Vec<u8>,
    /// The first bytes of `unread` hold no newline: a long line is searched once, not per read.
    searched: usize,
}

impl Lines {
    /// Reads once from `stream`, blocking until it has something; `Ok(0)` once it ended.
    pub(crate) fn fill(&mut self, stream: &mut impl Read) -> io::Result<usize> {
        let start = self.unread.len();
        self.unread.resize(start + MAX_READ_BYTES, 0);
        let read = loop {
            match stream.read(self.unread.get_mut(start..).unwrap_or_default()) {
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                read => break read,
            }
        };
        self.unread
            .truncate(start + read.as_ref().map_or(0, |read| *read));
        read
    }

    /// Takes the next whole line, its newline included.
    pub(crate) fn next_line(&mut self) -> Option<Vec<u8>> {
        let newline = self
            .unread
            .get(self.searched..)?
            .iter()
            .position(|&byte| byte == b'\n');
        let Some(newline) = newline else {
            self.searched = self.unread.len();
            return None;
        };
        let end = self.searched + newline + 1;
        self.searched = 0;
        Some(self.unread.drain(..end).collect())
    }
}
