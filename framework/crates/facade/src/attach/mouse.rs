//! SGR mouse reports requested by Attach while it owns the mouse.

use facade_base::console::PointerAction;

const CSI: &[u8] = b"\x1b[";

pub(super) enum MouseInput<'a> {
    Keys(&'a [u8]),
    Wheel(i16),
    Pointer {
        col: u16,
        row: u16,
        action: PointerAction,
    },
}

#[derive(Default)]
pub(super) struct LocalMouseInput {
    pending: Vec<u8>,
}

impl LocalMouseInput {
    /// Keep an unfinished report once its CSI introducer arrives. A lone Escape goes through
    /// immediately. A report begun under local ownership is still consumed after a handoff.
    pub(super) fn read(&mut self, keys: &[u8], local: bool, mut emit: impl FnMut(MouseInput<'_>)) {
        let had_pending = !self.pending.is_empty();
        let joined;
        let keys = if had_pending {
            let mut pending = std::mem::take(&mut self.pending);
            pending.extend_from_slice(keys);
            joined = pending;
            joined.as_slice()
        } else {
            keys
        };
        let mut start = 0;
        let mut search = 0;
        let mut candidate = had_pending.then_some(0);
        loop {
            if local && candidate.is_none() {
                candidate = keys[search..]
                    .windows(CSI.len())
                    .position(|window| window == CSI)
                    .map(|at| search + at);
            }
            let Some(at) = candidate.take() else {
                break;
            };
            match sgr_report(&keys[at..]) {
                Report::Complete { length, event } => {
                    emit(MouseInput::Keys(&keys[start..at]));
                    if local && let Some(event) = event {
                        emit(event);
                    }
                    start = at + length;
                    search = start;
                }
                Report::Incomplete => {
                    emit(MouseInput::Keys(&keys[start..at]));
                    self.pending.extend_from_slice(&keys[at..]);
                    return;
                }
                Report::Other => search = at + CSI.len(),
            }
        }
        emit(MouseInput::Keys(&keys[start..]));
    }

    /// The CSI introducer is still ambiguous at end of input. A confirmed mouse prefix is local.
    pub(super) fn remaining_keys(&self) -> &[u8] {
        if self.pending == CSI { CSI } else { &[] }
    }
}

enum Report {
    Complete {
        length: usize,
        event: Option<MouseInput<'static>>,
    },
    Incomplete,
    Other,
}

fn sgr_report(bytes: &[u8]) -> Report {
    let Some(fields) = bytes.strip_prefix(b"\x1b[<") else {
        return if bytes == CSI {
            Report::Incomplete
        } else {
            Report::Other
        };
    };
    // Each of the three decimal fields fits in five digits, bounding the pending report.
    let mut numbers = [0u32; 3];
    let mut separators = 0;
    let mut digits = 0;
    for (at, &byte) in fields.iter().enumerate() {
        match byte {
            b'0'..=b'9' if digits < 5 => {
                numbers[separators] = 10 * numbers[separators] + u32::from(byte - b'0');
                digits += 1;
            }
            b';' if separators < 2 && digits > 0 => {
                separators += 1;
                digits = 0;
            }
            b'M' | b'm' if separators == 2 && digits > 0 => {
                return Report::Complete {
                    length: 3 + at + 1,
                    event: sgr_event(numbers, byte),
                };
            }
            _ => return Report::Other,
        }
    }
    Report::Incomplete
}

fn sgr_event([button, col, row]: [u32; 3], final_byte: u8) -> Option<MouseInput<'static>> {
    let action = match (button & !28, final_byte) {
        (64, b'M') => return Some(MouseInput::Wheel(1)),
        (65, b'M') => return Some(MouseInput::Wheel(-1)),
        (0, b'M') => PointerAction::LeftDown,
        (32, b'M') => PointerAction::LeftDrag,
        (0, b'm') => PointerAction::LeftUp,
        (2, b'M') => PointerAction::RightDown,
        _ => return None,
    };
    Some(MouseInput::Pointer {
        col: u16::try_from(col).ok()?,
        row: u16::try_from(row).ok()?,
        action,
    })
}
