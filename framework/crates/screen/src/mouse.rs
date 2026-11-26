//! The CLI's mouse modes, and wheel reports for them.

use std::io::Write;

use alacritty_terminal::term::TermMode;

use crate::Screen;

const TRACKING_MODES: [(u16, TermMode); 3] = [
    (1000, TermMode::MOUSE_REPORT_CLICK),
    (1002, TermMode::MOUSE_DRAG),
    (1003, TermMode::MOUSE_MOTION),
];

const ENCODING_MODES: [(u16, TermMode); 2] =
    [(1006, TermMode::SGR_MOUSE), (1005, TermMode::UTF8_MOUSE)];

impl Screen {
    /// Whether the CLI is tracking mouse events.
    pub fn reports_mouse(&self) -> bool {
        self.terminal.term.mode().intersects(TermMode::MOUSE_MODE)
    }

    /// Sets the CLI's tracking and encoding modes on a viewer, on or off. In each group the active
    /// mode comes last, because a terminal can take any reset as turning the whole group off:
    /// macOS Terminal returns to the legacy encoding on a reset of 1005, whatever 1006 says.
    pub fn mouse_modes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for modes in [&TRACKING_MODES[..], &ENCODING_MODES] {
            let mut modes = modes.to_vec();
            modes.sort_by_key(|&(_, mode)| self.terminal.has(mode));
            for (number, mode) in modes {
                let on_off = if self.terminal.has(mode) { 'h' } else { 'l' };
                write!(out, "\x1b[?{number}{on_off}").unwrap();
            }
        }
        out
    }

    /// Encodes platform-neutral wheel input for the current mouse mode. Coordinates are one-based
    /// cells in the grid, modifiers use terminal bits 4 (Shift), 8 (Alt) and 16 (Ctrl), and a delta
    /// of 120 is one tick up. Only complete ticks with encodable coordinates produce reports.
    pub fn encode_wheel(&self, col: u16, row: u16, delta: i16, modifiers: u8) -> Option<Vec<u8>> {
        let ticks = delta / 120;
        if !self.reports_mouse()
            || ticks == 0
            || col == 0
            || row == 0
            || col > self.cols()
            || row > self.rows()
        {
            return None;
        }

        let button = (if ticks > 0 { 64 } else { 65 }) | (modifiers & 28);
        let repetitions = usize::from(ticks.unsigned_abs());
        if self.terminal.has(TermMode::SGR_MOUSE) {
            return Some(
                format!("\x1b[<{button};{col};{row}M")
                    .as_bytes()
                    .repeat(repetitions),
            );
        }

        // Legacy and UTF-8 reports offset fields by 32. A coordinate must fit in one byte in
        // legacy mode, or a code point of at most two UTF-8 bytes in UTF-8 mode.
        let fields = [u16::from(button), col, row];
        if self.terminal.has(TermMode::UTF8_MOUSE) {
            if col > 2015 || row > 2015 {
                return None;
            }
            let mut report = String::from("\x1b[M");
            report.extend(fields.map(|field| char::from_u32(u32::from(field) + 32).unwrap()));
            Some(report.as_bytes().repeat(repetitions))
        } else {
            if col > 223 || row > 223 {
                return None;
            }
            let [button, col, row] = fields.map(|field| (field + 32) as u8);
            Some([0x1b, b'[', b'M', button, col, row].repeat(repetitions))
        }
    }
}
