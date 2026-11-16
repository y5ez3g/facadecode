//! The person's console on Windows: its virtual terminal modes and its input records.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Console::{
    CONSOLE_MODE, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT,
    GetConsoleMode, GetStdHandle, INPUT_RECORD, KEY_EVENT, ReadConsoleInputW, STD_HANDLE,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleMode, WINDOW_BUFFER_SIZE_EVENT,
};

use super::{ConsoleRead, ConsoleSignal};

/// The modes the console had before, which `restore` puts back. Only the values are kept, so that
/// attach may keep this in a static: the handles are taken again when restoring.
pub(super) struct VtModes {
    input: CONSOLE_MODE,
    output: CONSOLE_MODE,
    restored: AtomicBool,
}

impl VtModes {
    pub(super) fn enter() -> io::Result<VtModes> {
        let input = mode(STD_INPUT_HANDLE)?;
        let output = mode(STD_OUTPUT_HANDLE)?;
        let keys = ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT;
        // Window input makes the console report its size changes as input records.
        let wanted = ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT;
        set_mode(STD_INPUT_HANDLE, (input | wanted) & !keys)?;
        if let Err(error) = set_mode(
            STD_OUTPUT_HANDLE,
            output | ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        ) {
            let _ = set_mode(STD_INPUT_HANDLE, input);
            return Err(error);
        }
        Ok(VtModes {
            input,
            output,
            restored: AtomicBool::new(false),
        })
    }

    pub(super) fn restore(&self) {
        if self.restored.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = set_mode(STD_INPUT_HANDLE, self.input);
        let _ = set_mode(STD_OUTPUT_HANDLE, self.output);
    }
}

/// The standard handle `which`.
fn std_handle(which: STD_HANDLE) -> io::Result<HANDLE> {
    // SAFETY: GetStdHandle has no preconditions; the result is checked.
    let handle = unsafe { GetStdHandle(which) };
    if handle.is_null() || handle as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(handle)
}

/// The console mode of the standard handle `which`.
fn mode(which: STD_HANDLE) -> io::Result<CONSOLE_MODE> {
    let mut mode = 0;
    // SAFETY: the handle is a standard handle; `mode` is written.
    if unsafe { GetConsoleMode(std_handle(which)?, &mut mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(mode)
}

fn set_mode(which: STD_HANDLE, mode: CONSOLE_MODE) -> io::Result<()> {
    // SAFETY: the handle is a standard handle.
    if unsafe { SetConsoleMode(std_handle(which)?, mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// How many input records one read takes at most.
const RECORDS_PER_READ: usize = 64;

pub(super) struct ConsoleReader {
    /// Key bytes read and not yet given, in order.
    pending: Vec<u8>,
    /// The first half of a character above U+FFFF, until its second half comes.
    high: Option<u16>,
    /// Whether the console changed size since the last `Resized`.
    resized: bool,
}

impl ConsoleReader {
    pub(super) fn new() -> io::Result<ConsoleReader> {
        std_handle(STD_INPUT_HANDLE)?;
        Ok(ConsoleReader {
            pending: Vec::new(),
            high: None,
            resized: false,
        })
    }

    /// Keys come before a size change read with them.
    pub(super) fn read(&mut self, buf: &mut [u8]) -> io::Result<ConsoleRead> {
        loop {
            if !self.pending.is_empty() {
                let given = buf.len().min(self.pending.len());
                buf[..given].copy_from_slice(&self.pending[..given]);
                self.pending.drain(..given);
                return Ok(ConsoleRead::Keys(given));
            }
            if std::mem::take(&mut self.resized) {
                return Ok(ConsoleRead::Resized);
            }
            self.read_records()?;
        }
    }

    /// Waits for input records, and keeps what their key-down records and size changes bring.
    fn read_records(&mut self) -> io::Result<()> {
        // SAFETY: an all-zero INPUT_RECORD is valid.
        let mut records: [INPUT_RECORD; RECORDS_PER_READ] = unsafe { std::mem::zeroed() };
        let mut read = 0u32;
        let input = std_handle(STD_INPUT_HANDLE)?;
        // SAFETY: the buffer holds the number of records given; `read` is written.
        let got = unsafe {
            ReadConsoleInputW(
                input,
                records.as_mut_ptr(),
                RECORDS_PER_READ as u32,
                &mut read,
            )
        };
        if got == 0 {
            return Err(io::Error::last_os_error());
        }
        for record in &records[..read as usize] {
            match u32::from(record.EventType) {
                KEY_EVENT => {
                    // SAFETY: a KEY_EVENT record holds a key event.
                    let key = unsafe { record.Event.KeyEvent };
                    // SAFETY: the character's UTF-16 unit is either member of the union.
                    let unit = unsafe { key.uChar.UnicodeChar };
                    if key.bKeyDown != 0 && unit != 0 {
                        for _ in 0..key.wRepeatCount.max(1) {
                            self.push_unit(unit);
                        }
                    }
                }
                WINDOW_BUFFER_SIZE_EVENT => self.resized = true,
                _ => {}
            }
        }
        Ok(())
    }

    /// Adds one UTF-16 unit of a key's character, as UTF-8.
    fn push_unit(&mut self, unit: u16) {
        let units: Vec<u16> = match (self.high.take(), unit) {
            (None, 0xD800..=0xDBFF) => {
                self.high = Some(unit);
                return;
            }
            (Some(high), _) => vec![high, unit],
            (None, _) => vec![unit],
        };
        for character in char::decode_utf16(units) {
            let character = character.unwrap_or(char::REPLACEMENT_CHARACTER);
            let mut bytes = [0u8; 4];
            self.pending
                .extend_from_slice(character.encode_utf8(&mut bytes).as_bytes());
        }
    }
}

/// No signals reach a console program on Windows that attach follows.
pub(super) struct ConsoleSignals;

impl ConsoleSignals {
    pub(super) fn new() -> io::Result<ConsoleSignals> {
        Ok(ConsoleSignals)
    }

    pub(super) fn next(&mut self) -> Option<ConsoleSignal> {
        None
    }
}
