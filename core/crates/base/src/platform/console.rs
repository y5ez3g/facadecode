//! The person's console while attach shows an agent: what crossterm's raw mode leaves out. Attach's
//! own threads call these; nothing here starts a thread.

use std::io;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

/// The console modes that make keys travel as bytes, entered after crossterm's raw mode. Windows
/// adds virtual terminal input to the input, without line, echo or processed input, and virtual
/// terminal processing to the output; Unix changes nothing. Dropping it restores them.
pub struct VtModes(imp::VtModes);

impl VtModes {
    pub fn enter() -> io::Result<VtModes> {
        imp::VtModes::enter().map(VtModes)
    }

    /// Puts back what `enter` changed, once.
    pub fn restore(&self) {
        self.0.restore();
    }
}

impl Drop for VtModes {
    fn drop(&mut self) {
        self.0.restore();
    }
}

/// The lower of the cursor and the last row containing text, as a 1-based viewport row.
/// Returns `None` if the viewport cannot be read or on Unix.
pub fn visible_content_end() -> Option<u16> {
    imp::visible_content_end()
}

/// What one read of the console brought.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleRead {
    /// This many bytes of keys, at the start of the buffer; 0 at the end of the input.
    Keys(usize),
    /// The console changed size.
    Resized,
}

/// Reads the person's keys. Unix: standard input's bytes. Windows: the console's input records,
/// the characters of key-down records as bytes, never those of key-up records, and size changes
/// as [`ConsoleRead::Resized`].
pub struct ConsoleReader(imp::ConsoleReader);

impl ConsoleReader {
    pub fn new() -> io::Result<ConsoleReader> {
        imp::ConsoleReader::new().map(ConsoleReader)
    }

    /// Waits for keys or a size change.
    pub fn read(&mut self, buf: &mut [u8]) -> io::Result<ConsoleRead> {
        self.0.read(buf)
    }

    /// Discards an exact ASCII key-down prefix of the native input queue without waiting for input.
    /// Returns `false` if the prefix is absent or on Unix. The reader must own console input.
    pub fn discard_key_prefix(&mut self, keys: &[u8]) -> io::Result<bool> {
        self.0.discard_key_prefix(keys)
    }
}

/// What the system told the console's program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleSignal {
    /// The console changed size.
    Resized,
    /// The program is asked to end by the signal `name`, whose number on this system is `number`;
    /// attach exits with 128 plus it.
    Ended { name: &'static str, number: i32 },
}

/// The signals that reach the console's program. Unix: SIGWINCH, and SIGTERM, SIGHUP, SIGINT and
/// SIGQUIT. Windows: none; [`ConsoleSignals::next`] returns None at once.
pub struct ConsoleSignals(imp::ConsoleSignals);

impl ConsoleSignals {
    pub fn new() -> io::Result<ConsoleSignals> {
        imp::ConsoleSignals::new().map(ConsoleSignals)
    }
}

impl Iterator for ConsoleSignals {
    type Item = ConsoleSignal;

    /// Waits for the next signal; None once none can come.
    fn next(&mut self) -> Option<ConsoleSignal> {
        self.0.next()
    }
}
