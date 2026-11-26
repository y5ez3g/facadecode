//! The person's terminal on Unix: crossterm's raw mode is all it needs.

use std::io::{self, Read};
use std::os::fd::AsFd;
use std::time::Instant;

use nix::errno::Errno;
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

use signal_hook::consts::{SIGHUP, SIGINT, SIGPIPE, SIGQUIT, SIGTERM, SIGWINCH};

use super::{ConsoleRead, ConsoleSignal};

pub(super) struct VtModes;

impl VtModes {
    pub(super) fn enter() -> io::Result<VtModes> {
        Ok(VtModes)
    }

    pub(super) fn set_mouse_capture(&self, _enabled: bool) -> io::Result<()> {
        Ok(())
    }

    pub(super) fn restore(&self) {}
}

pub(super) struct ConsoleReader(io::Stdin);

impl ConsoleReader {
    pub(super) fn new() -> io::Result<ConsoleReader> {
        Ok(ConsoleReader(io::stdin()))
    }

    pub(super) fn read(&mut self, buf: &mut [u8]) -> io::Result<ConsoleRead> {
        loop {
            match self.0.lock().read(buf) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                read => return read.map(ConsoleRead::Keys),
            }
        }
    }

    pub(super) fn read_until(
        &mut self,
        buf: &mut [u8],
        deadline: Instant,
    ) -> io::Result<Option<ConsoleRead>> {
        let mut fd = [PollFd::new(self.0.as_fd(), PollFlags::POLLIN)];
        loop {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return Ok(None);
            };
            let millis = left.as_millis().clamp(1, i32::MAX as u128) as i32;
            match poll(
                &mut fd,
                PollTimeout::try_from(millis).expect("bounded wait"),
            ) {
                Ok(0) => return Ok(None),
                Ok(_) => return self.read(buf).map(Some),
                Err(Errno::EINTR) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    pub(super) fn discard_key_prefix(&mut self, _keys: &[u8]) -> io::Result<bool> {
        Ok(false)
    }
}

pub(super) fn owns_input() -> bool {
    // SAFETY: these only read the process's and the terminal's groups.
    unsafe { libc::tcgetpgrp(libc::STDIN_FILENO) == libc::getpgrp() }
}

pub(super) fn return_input(bytes: &[u8]) {
    for byte in bytes {
        // SAFETY: TIOCSTI reads the one byte it is given.
        if unsafe { libc::ioctl(libc::STDIN_FILENO, libc::TIOCSTI as _, byte as *const u8) } != 0 {
            return;
        }
    }
}

pub(super) struct ConsoleSignals(signal_hook::iterator::Signals);

impl ConsoleSignals {
    pub(super) fn new() -> io::Result<ConsoleSignals> {
        signal_hook::iterator::Signals::new([SIGWINCH, SIGTERM, SIGHUP, SIGINT, SIGQUIT, SIGPIPE])
            .map(ConsoleSignals)
    }

    pub(super) fn next(&mut self) -> Option<ConsoleSignal> {
        let signal = self.0.forever().next()?;
        if signal == SIGWINCH {
            return Some(ConsoleSignal::Resized);
        }
        let name = signal_hook::low_level::signal_name(signal).unwrap_or("a signal");
        Some(ConsoleSignal::Ended {
            name,
            number: signal,
        })
    }
}
