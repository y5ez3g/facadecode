//! The person's terminal on Unix: crossterm's raw mode is all it needs.

use std::io::{self, Read};

use signal_hook::consts::{SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGWINCH};

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

    pub(super) fn discard_key_prefix(&mut self, _keys: &[u8]) -> io::Result<bool> {
        Ok(false)
    }
}

pub(super) struct ConsoleSignals(signal_hook::iterator::Signals);

impl ConsoleSignals {
    pub(super) fn new() -> io::Result<ConsoleSignals> {
        signal_hook::iterator::Signals::new([SIGWINCH, SIGTERM, SIGHUP, SIGINT, SIGQUIT])
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
