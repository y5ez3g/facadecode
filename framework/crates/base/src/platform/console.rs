//! The person's console while attach shows an agent: what crossterm's raw mode leaves out. Attach's
//! own threads call these; nothing here starts a thread.

use std::io;
use std::time::Instant;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

/// The console modes that make keys travel as bytes. Enter before crossterm's optional raw mode
/// so Windows saves the original console modes. Windows enables virtual terminal input and output
/// processing and disables line, echo and processed input. Unix changes nothing. Dropping it
/// restores the original modes.
pub struct VtModes(imp::VtModes);

impl VtModes {
    pub fn enter() -> io::Result<VtModes> {
        imp::VtModes::enter().map(VtModes)
    }

    /// Toggles native mouse capture on Windows, giving scrolling back to the host when disabled.
    /// Call while the modes are active, serialized with other mode changes and restoration.
    /// Unix terminals report mouse input as bytes.
    pub fn set_mouse_capture(&self, enabled: bool) -> io::Result<()> {
        self.0.set_mouse_capture(enabled)
    }

    /// Puts back the original console modes, once.
    pub fn restore(&self) {
        self.0.restore();
    }
}

impl Drop for VtModes {
    fn drop(&mut self) {
        self.0.restore();
    }
}

/// A native mouse button action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerAction {
    LeftDown,
    LeftDrag,
    LeftUp,
    RightDown,
}

/// What one read of the console brought.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleRead {
    /// This many bytes of keys, at the start of the buffer; 0 at the end of the input.
    Keys(usize),
    /// The console changed size.
    Resized,
    /// A native vertical wheel event. Coordinates are one-based within the visible viewport.
    /// Delta is positive up, and the modifier bits are Shift=4, Alt=8, Control=16.
    Wheel {
        col: u16,
        row: u16,
        delta: i16,
        modifiers: u8,
    },
    /// A native pointer action at a one-based position in the visible viewport.
    Pointer {
        col: u16,
        row: u16,
        action: PointerAction,
    },
}

/// Reads standard input bytes on Unix. On Windows, reads console input records, yielding
/// key-down characters (including host VT sequences) as bytes, size changes, and native wheel
/// and pointer events.
pub struct ConsoleReader(imp::ConsoleReader);

impl ConsoleReader {
    pub fn new() -> io::Result<ConsoleReader> {
        imp::ConsoleReader::new().map(ConsoleReader)
    }

    /// Waits for keys, a size change or a native mouse event.
    pub fn read(&mut self, buf: &mut [u8]) -> io::Result<ConsoleRead> {
        self.0.read(buf)
    }

    /// Reads one event by the deadline, or returns None if no event is available in time.
    /// The caller must own console input.
    pub fn read_until(
        &mut self,
        buf: &mut [u8],
        deadline: Instant,
    ) -> io::Result<Option<ConsoleRead>> {
        self.0.read_until(buf, deadline)
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

/// On Unix, SIGWINCH reports a resize, and SIGTERM, SIGHUP, SIGINT, SIGQUIT and SIGPIPE report
/// that the program should end. On Windows, [`ConsoleSignals::next`] returns `None` immediately.
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
