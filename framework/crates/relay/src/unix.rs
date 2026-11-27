//! The byte boundary of standard input after a reconnect.

#![allow(unsafe_code)]

use std::fs::File;
use std::io::{self, Seek};
use std::os::fd::AsRawFd;

use nix::{errno::Errno, libc};

/// Counts unread bytes once. The relay is the only reader of the CLI's stdin stream.
pub(crate) fn ready_input_bytes(input: &mut File) -> io::Result<usize> {
    let metadata = input.metadata()?;
    if metadata.is_file() {
        let remaining = metadata.len().saturating_sub(input.stream_position()?);
        return Ok(usize::try_from(remaining).unwrap_or(usize::MAX));
    }

    let mut bytes: libc::c_int = 0;
    loop {
        // SAFETY: input is open, and FIONREAD writes a single int at the supplied pointer.
        if unsafe { libc::ioctl(input.as_raw_fd(), libc::FIONREAD, &raw mut bytes) } == 0 {
            return Ok(usize::try_from(bytes).unwrap_or_default());
        }
        if Errno::last() != Errno::EINTR {
            // Descriptors without FIONREAD support are read by the normal poll loop.
            return Ok(0);
        }
    }
}
