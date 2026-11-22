//! The person's console on Windows: its virtual terminal modes and its input records.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Console::{
    CONSOLE_MODE, CONSOLE_SCREEN_BUFFER_INFO, COORD, DISABLE_NEWLINE_AUTO_RETURN,
    ENABLE_ECHO_INPUT, ENABLE_EXTENDED_FLAGS, ENABLE_LINE_INPUT, ENABLE_MOUSE_INPUT,
    ENABLE_PROCESSED_INPUT, ENABLE_QUICK_EDIT_MODE, ENABLE_VIRTUAL_TERMINAL_INPUT,
    ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT, GetConsoleMode,
    GetConsoleScreenBufferInfo, GetStdHandle, INPUT_RECORD, KEY_EVENT, LEFT_ALT_PRESSED,
    LEFT_CTRL_PRESSED, MOUSE_EVENT, MOUSE_EVENT_RECORD, MOUSE_WHEELED, PeekConsoleInputW,
    RIGHT_ALT_PRESSED, RIGHT_CTRL_PRESSED, ReadConsoleInputW, ReadConsoleOutputCharacterW,
    SHIFT_PRESSED, STD_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleMode,
    WINDOW_BUFFER_SIZE_EVENT,
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
        // A VT line wraps on the next printable character. Cursor moves after a full line
        // must still start from that line, as they do on the agent's screen.
        if let Err(error) = set_mode(
            STD_OUTPUT_HANDLE,
            output | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN,
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

    pub(super) fn set_mouse_capture(&self, enabled: bool) -> io::Result<()> {
        let input = mode(STD_INPUT_HANDLE)?;
        let quick_edit = ENABLE_QUICK_EDIT_MODE | ENABLE_EXTENDED_FLAGS;
        let mouse = if enabled {
            ENABLE_MOUSE_INPUT | ENABLE_EXTENDED_FLAGS
        } else {
            // Give the wheel back to the host and restore its Quick Edit preference.
            self.input & quick_edit
        };
        set_mode(
            STD_INPUT_HANDLE,
            (input & !(ENABLE_MOUSE_INPUT | quick_edit)) | mouse,
        )
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

fn screen_buffer_info(output: HANDLE) -> Option<CONSOLE_SCREEN_BUFFER_INFO> {
    let mut info = CONSOLE_SCREEN_BUFFER_INFO::default();
    // SAFETY: `info` is writable and the console API checks the handle.
    if unsafe { GetConsoleScreenBufferInfo(output, &mut info) } == 0 {
        return None;
    }
    Some(info)
}

pub(super) fn visible_content_end() -> Option<u16> {
    let output = std_handle(STD_OUTPUT_HANDLE).ok()?;
    let info = screen_buffer_info(output)?;
    let window = info.srWindow;
    let width = u16::try_from(i32::from(window.Right) - i32::from(window.Left) + 1).ok()?;
    if width == 0 || window.Top > window.Bottom {
        return None;
    }
    let cursor = info.dwCursorPosition.Y.clamp(window.Top, window.Bottom);
    let mut cells = vec![0u16; usize::from(width)];
    let mut end = cursor;
    for row in (cursor..=window.Bottom).rev() {
        let start = COORD {
            X: window.Left,
            Y: row,
        };
        let mut read = 0;
        // SAFETY: `cells` holds `width` UTF-16 units and `read` is writable.
        let got = unsafe {
            ReadConsoleOutputCharacterW(
                output,
                cells.as_mut_ptr(),
                u32::from(width),
                start,
                &mut read,
            )
        };
        if got == 0 || read == 0 {
            return None;
        }
        if cells[..read as usize]
            .iter()
            .any(|&cell| !matches!(cell, 0 | 0x20))
        {
            end = row;
            break;
        }
    }
    u16::try_from(i32::from(end) - i32::from(window.Top) + 1).ok()
}

/// How many input records one read takes at most.
const RECORDS_PER_READ: usize = 64;

enum PendingInput {
    Keys(Vec<u8>),
    Event(ConsoleRead),
}

pub(super) struct ConsoleReader {
    pending: VecDeque<PendingInput>,
    /// The first half of a character above U+FFFF, until its second half comes.
    high: Option<u16>,
}

impl ConsoleReader {
    pub(super) fn new() -> io::Result<ConsoleReader> {
        std_handle(STD_INPUT_HANDLE)?;
        Ok(ConsoleReader {
            pending: VecDeque::new(),
            high: None,
        })
    }

    pub(super) fn read(&mut self, buf: &mut [u8]) -> io::Result<ConsoleRead> {
        loop {
            let event = match self.pending.front_mut() {
                Some(PendingInput::Keys(keys)) => {
                    let given = buf.len().min(keys.len());
                    buf[..given].copy_from_slice(&keys[..given]);
                    keys.drain(..given);
                    if !keys.is_empty() {
                        return Ok(ConsoleRead::Keys(given));
                    }
                    ConsoleRead::Keys(given)
                }
                Some(PendingInput::Event(event)) => *event,
                None => {
                    self.read_records()?;
                    continue;
                }
            };
            self.pending.pop_front();
            return Ok(event);
        }
    }

    pub(super) fn discard_key_prefix(&mut self, keys: &[u8]) -> io::Result<bool> {
        if keys.is_empty() || !keys.is_ascii() || keys.contains(&0) {
            return Ok(false);
        }
        let Ok(count) = u32::try_from(keys.len()) else {
            return Ok(false);
        };
        let input = std_handle(STD_INPUT_HANDLE)?;
        let mut records = vec![INPUT_RECORD::default(); keys.len()];
        let mut read = 0;
        // SAFETY: `records` holds `count` records and `read` is writable.
        let got = unsafe { PeekConsoleInputW(input, records.as_mut_ptr(), count, &mut read) };
        if got == 0 {
            return Err(io::Error::last_os_error());
        }
        if read != count
            || !records.iter().zip(keys).all(|(record, &byte)| {
                if u32::from(record.EventType) != KEY_EVENT {
                    return false;
                }
                // SAFETY: the record is a key event and UnicodeChar is its UTF-16 unit.
                let key = unsafe { record.Event.KeyEvent };
                key.bKeyDown != 0
                    && key.wRepeatCount == 1
                    && unsafe { key.uChar.UnicodeChar } == u16::from(byte)
            })
        {
            return Ok(false);
        }
        // SAFETY: the buffers are still valid. This reader alone consumes input, so the peeked
        // records are already queued and the read need not wait for more input.
        let got = unsafe { ReadConsoleInputW(input, records.as_mut_ptr(), count, &mut read) };
        if got == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(read == count)
    }

    /// Batches consecutive key bytes. Wheel events stay between their surrounding key batches,
    /// and size changes still coalesce into one event after the batch.
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
        let mut keys = Vec::new();
        let mut resized = false;
        for record in &records[..read as usize] {
            match u32::from(record.EventType) {
                KEY_EVENT => {
                    // SAFETY: a KEY_EVENT record holds a key event.
                    let key = unsafe { record.Event.KeyEvent };
                    // SAFETY: the character's UTF-16 unit is either member of the union.
                    let unit = unsafe { key.uChar.UnicodeChar };
                    if key.bKeyDown != 0 && unit != 0 {
                        for _ in 0..key.wRepeatCount.max(1) {
                            self.push_unit(unit, &mut keys);
                        }
                    }
                }
                MOUSE_EVENT => {
                    // SAFETY: a MOUSE_EVENT record holds a mouse event.
                    let mouse = unsafe { record.Event.MouseEvent };
                    if let Some(wheel) = vertical_wheel(mouse) {
                        if !keys.is_empty() {
                            self.pending
                                .push_back(PendingInput::Keys(std::mem::take(&mut keys)));
                        }
                        self.pending.push_back(PendingInput::Event(wheel));
                    }
                }
                WINDOW_BUFFER_SIZE_EVENT => resized = true,
                _ => {}
            }
        }
        if !keys.is_empty() {
            self.pending.push_back(PendingInput::Keys(keys));
        }
        if resized {
            self.pending
                .push_back(PendingInput::Event(ConsoleRead::Resized));
        }
        Ok(())
    }

    /// Adds one UTF-16 unit of a key's character, as UTF-8.
    fn push_unit(&mut self, unit: u16, keys: &mut Vec<u8>) {
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
            keys.extend_from_slice(character.encode_utf8(&mut bytes).as_bytes());
        }
    }
}

fn vertical_wheel(mouse: MOUSE_EVENT_RECORD) -> Option<ConsoleRead> {
    if mouse.dwEventFlags != MOUSE_WHEELED {
        return None;
    }
    let output = std_handle(STD_OUTPUT_HANDLE).ok()?;
    let window = screen_buffer_info(output)?.srWindow;
    let COORD { X: x, Y: y } = mouse.dwMousePosition;
    if !(window.Left..=window.Right).contains(&x) || !(window.Top..=window.Bottom).contains(&y) {
        return None;
    }
    let state = mouse.dwControlKeyState;
    let modifiers = (u8::from(state & SHIFT_PRESSED != 0) << 2)
        | (u8::from(state & (LEFT_ALT_PRESSED | RIGHT_ALT_PRESSED) != 0) << 3)
        | (u8::from(state & (LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED) != 0) << 4);
    Some(ConsoleRead::Wheel {
        col: u16::try_from(i32::from(x) - i32::from(window.Left) + 1).ok()?,
        row: u16::try_from(i32::from(y) - i32::from(window.Top) + 1).ok()?,
        delta: (mouse.dwButtonState >> 16) as i16,
        modifiers,
    })
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
