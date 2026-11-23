//! What each piece of a CLI's output means here: whether viewers get it, and what it changes.
//!
//! Only the agent's screen answers terminal queries. A viewer's terminal that saw a query would
//! answer it too, and its answer would reach the CLI as typed input, so viewers never get one. Nor
//! do they get the CLI's status sequences (OSC 7501), which are the daemon's.

use crate::kept_modes::{ActiveCharset, KeptModes, KeyboardChange, ModifyOtherKeys};
use crate::program_status::{self, StatusEvent};
use crate::units::{Piece, Splitter};
use crate::write_title_body;

/// A place in the output where the screen must look at its state, just after the piece.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Mark {
    /// The CLI switched between the main and the alternate screen.
    SwitchScreen,
    /// `ESC c`: a full reset.
    Reset,
    /// `ESC H`: a tab stop at the cursor.
    SetTabStop,
    /// `CSI g`, `CSI 0 g`: no tab stop at the cursor.
    ClearTabStop,
    /// `CSI 3 g`: no tab stops.
    ClearAllTabStops,
    /// The CLI said something of its status (a full reset is [`Mark::Reset`]).
    Status(StatusEvent),
}

/// A CLI's output split for viewers and the screen.
#[derive(Debug, Default)]
pub(crate) struct Filtered {
    /// Whole pieces for viewers, without queries.
    pub(crate) viewer_output: Vec<u8>,
    /// Complete OSC 9;4 activity sequences kept in the viewer output.
    pub(crate) native_activity: Vec<u8>,
    /// Each mark, with the offset in the output just after it.
    pub(crate) marks: Vec<(usize, Mark)>,
}

/// Splits `bytes` into what viewers get and where the screen must look, and follows the modes in
/// `modes`. Adds the status glyph to viewer titles. `rows` bounds the scrolling region.
pub(crate) fn filter(
    splitter: &mut Splitter,
    modes: &mut KeptModes,
    bytes: &[u8],
    rows: u16,
    status_glyph: Option<&str>,
) -> Filtered {
    let mut filtered = Filtered {
        viewer_output: Vec::with_capacity(bytes.len()),
        ..Filtered::default()
    };
    splitter.split(bytes, |offset, piece| {
        let (mut bytes, mark) = read_piece(&piece, modes, rows);
        if matches!(piece, Piece::String(_)) {
            if bytes.starts_with(b"\x1b]9;4;") {
                filtered.native_activity.extend_from_slice(bytes);
            }
            if let Some(glyph) = status_glyph
                && let [b'\x1b', b']', b'0' | b'2', b';', body @ ..] = bytes
                && let Some(title) = body
                    .strip_suffix(b"\x07")
                    .or_else(|| body.strip_suffix(b"\x1b\\"))
            {
                filtered.viewer_output.extend_from_slice(&bytes[..4]);
                write_title_body(&mut filtered.viewer_output, title, Some(glyph));
                bytes = &body[title.len()..];
            }
        }
        filtered.viewer_output.extend_from_slice(bytes);
        if let Some(mark) = mark {
            filtered.marks.push((offset, mark));
        }
    });
    filtered
}

/// What viewers get of `piece` (nothing for a query), and the mark it makes.
fn read_piece<'a>(piece: &Piece<'a>, modes: &mut KeptModes, rows: u16) -> (&'a [u8], Option<Mark>) {
    const NOTHING: &[u8] = &[];
    match *piece {
        // ENQ asks for an answerback message, and gets none.
        Piece::Byte(0x05) => (NOTHING, None),
        Piece::Byte(byte) | Piece::Control(byte) => {
            match byte {
                0x0e => modes.active_charset = ActiveCharset::G1,
                0x0f => modes.active_charset = ActiveCharset::G0,
                _ => {}
            }
            (std::slice::from_ref(byte_ref(byte)), None)
        }
        Piece::Char(bytes) | Piece::CutString(bytes) => (bytes, None),
        Piece::Escape(bytes) => match bytes {
            // DECID asks for the device attributes.
            [_, b'Z'] => (NOTHING, None),
            [_, b'c'] => {
                modes.reset();
                (bytes, Some(Mark::Reset))
            }
            [_, b'H'] => (bytes, Some(Mark::SetTabStop)),
            _ => (bytes, None),
        },
        Piece::Csi(bytes) => {
            let csi = Csi::new(bytes);
            if csi.is_query() {
                (NOTHING, None)
            } else {
                (bytes, csi.apply(modes, rows))
            }
        }
        Piece::String(bytes) => read_string(bytes),
    }
}

/// A static copy of `byte`, so that a lone byte can be passed on as a slice.
fn byte_ref(byte: u8) -> &'static u8 {
    static BYTES: [u8; 256] = {
        let mut all = [0; 256];
        let mut n = 0;
        while n < 256 {
            all[n] = n as u8;
            n += 1;
        }
        all
    };
    &BYTES[usize::from(byte)]
}

/// A complete CSI sequence: `ESC [`, a private marker, parameters, intermediates, a final byte.
struct Csi {
    /// `<`, `=`, `>` or `?` right after `ESC [`.
    marker: Option<u8>,
    params: Vec<u8>,
    intermediates: Vec<u8>,
    last: u8,
}

impl Csi {
    fn new(sequence: &[u8]) -> Self {
        let (&last, mut body) = sequence[2..].split_last().expect("a final byte");
        let marker = match body.first() {
            Some(&byte @ 0x3c..=0x3f) => {
                body = &body[1..];
                Some(byte)
            }
            _ => None,
        };
        let pick = |range: std::ops::RangeInclusive<u8>| -> Vec<u8> {
            body.iter()
                .copied()
                .filter(|byte| range.contains(byte))
                .collect()
        };
        Csi {
            marker,
            params: pick(0x30..=0x3b),
            intermediates: pick(0x20..=0x2f),
            last,
        }
    }

    /// The parameter fields between semicolons, each as a number where it is one.
    fn fields(&self) -> impl Iterator<Item = Option<u16>> + '_ {
        self.params
            .split(|&byte| byte == b';')
            .map(|field| std::str::from_utf8(field).ok()?.parse().ok())
    }

    fn field(&self, index: usize) -> Option<u16> {
        self.fields().nth(index).flatten()
    }

    /// The first parameter, up to a semicolon or a colon.
    fn first(&self) -> Option<u16> {
        let digits = self
            .params
            .split(|&byte| matches!(byte, b';' | b':'))
            .next()?;
        std::str::from_utf8(digits).ok()?.parse().ok()
    }

    /// Whether the sequence asks the terminal to report something.
    fn is_query(&self) -> bool {
        let plain = self.intermediates.is_empty();
        match (self.marker, self.last) {
            // Device status and the cursor position; `CSI > 4 n` sets modifyOtherKeys.
            (None | Some(b'?'), b'n') => true,
            // Primary, secondary and tertiary device attributes.
            (_, b'c') => true,
            // A mode's state, and presentation state.
            (_, b'p' | b'w') => self.intermediates == b"$",
            // Kitty keyboard flags, modifyOtherKeys and graphics attributes; the version.
            (Some(b'?'), b'u' | b'm' | b'S') | (Some(b'>'), b'q') => plain,
            // Terminal parameters; area checksums.
            (None, b'x') if plain => true,
            (_, b'y') => self.intermediates == b"*",
            // Window state, place, size and title.
            (None, b't') if plain => {
                matches!(self.first(), Some(11 | 13..=16 | 18..=21))
            }
            _ => false,
        }
    }

    /// Applies what the sequence changes to `modes`, and returns the mark it makes.
    fn apply(&self, modes: &mut KeptModes, rows: u16) -> Option<Mark> {
        if !self.intermediates.is_empty() {
            return None;
        }
        match (self.marker, self.last) {
            (Some(b'?'), b'h' | b'l') => {
                let switches = self
                    .fields()
                    .flatten()
                    .any(|mode| [47, 1047, 1049].contains(&mode));
                if !switches {
                    return None;
                }
                modes.switch_screen(self.last == b'h');
                Some(Mark::SwitchScreen)
            }
            (Some(marker @ (b'>' | b'<' | b'=')), b'u') => {
                let flags = (self.field(0).unwrap_or(0) & 0x1f) as u8;
                modes.change_keyboard(match marker {
                    b'>' => KeyboardChange::Push(flags),
                    b'<' => KeyboardChange::Pop(usize::from(self.field(0).unwrap_or(1).max(1))),
                    _ => KeyboardChange::Change {
                        flags,
                        how: self.field(1).unwrap_or(1),
                    },
                });
                None
            }
            (Some(b'>'), b'm' | b'n') => {
                let setting = match (self.last, self.params.is_empty(), self.first()) {
                    (b'm', true, _) => ModifyOtherKeys::Initial,
                    (b'm', false, Some(4)) => self
                        .field(1)
                        .map_or(ModifyOtherKeys::Initial, ModifyOtherKeys::Level),
                    (b'n', false, Some(4)) => ModifyOtherKeys::Disabled,
                    _ => return None,
                };
                modes.modify_other_keys = setting;
                None
            }
            (None, b'g') => match self.first() {
                None | Some(0) => Some(Mark::ClearTabStop),
                Some(3) => Some(Mark::ClearAllTabStops),
                _ => None,
            },
            (None, b'r') => {
                if let Some(region) = self.scroll_region(rows) {
                    modes.scroll_region = region;
                }
                None
            }
            _ => None,
        }
    }

    /// `CSI top ; bottom r` as alacritty reads it: None when the bounds are invalid and the region
    /// stays, `Some(None)` for the whole screen.
    fn scroll_region(&self, rows: u16) -> Option<Option<(u16, u16)>> {
        let mut bounds = self.fields().map(|bound| bound.filter(|&n| n != 0));
        let top = bounds.next().flatten().unwrap_or(1);
        let bottom = bounds.next().flatten().unwrap_or(rows);
        (top < bottom).then(|| {
            let (top, bottom) = (top.min(rows), bottom.min(rows));
            (top != 1 || bottom != rows).then_some((top, bottom))
        })
    }
}

/// A complete control string: viewers get it unless it is a query or a status sequence.
fn read_string(string: &[u8]) -> (&[u8], Option<Mark>) {
    let introducer = string[1];
    let body = string[2..]
        .strip_suffix(b"\x1b\\")
        .or_else(|| string[2..].strip_suffix(b"\x07"))
        .unwrap_or(&string[2..]);
    let text = String::from_utf8_lossy(body);
    let mut mark = None;
    if introducer == b']' {
        if let Some(status) = text.strip_prefix("7501;") {
            return (&[], program_status::status_event(status).map(Mark::Status));
        }
        if program_status::is_shell_prompt(body) {
            mark = Some(Mark::Status(StatusEvent::ShellPrompt));
        }
    }
    let query = match introducer {
        // Colours (OSC 4, OSC 10 to 19) and the clipboard (OSC 52) asked with `?`.
        b']' => {
            let mut fields = text.split(';');
            match fields.next().and_then(|number| number.parse::<u16>().ok()) {
                Some(4 | 10..=19) => fields.any(|field| field == "?"),
                Some(52) => fields.nth(1) == Some("?"),
                _ => false,
            }
        }
        // Capabilities and settings.
        b'P' => text.starts_with("+q") || text.starts_with("$q"),
        // A kitty graphics query.
        b'_' => {
            text.starts_with('G')
                && text
                    .split([',', ';'])
                    .any(|field| field.trim_start_matches('G') == "a=q")
        }
        _ => false,
    };
    (if query { &[] } else { string }, mark)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filtered(chunks: &[&[u8]]) -> Vec<u8> {
        let (mut splitter, mut modes) = (Splitter::default(), KeptModes::default());
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(filter(&mut splitter, &mut modes, chunk, 24, None).viewer_output);
        }
        out
    }

    #[test]
    fn queries_are_left_out_and_everything_else_passes_unchanged() {
        let stream: &[u8] =
            b"a\x1b[6nb\x1b[?6nb\x1b[cc\x1b[>cd\x1b[?u\x1b[?2026$pe\x1b]11;?\x07f\x1b]10;?\
              \x1b\\g\x1bP+q544e\x1b\\h\x1b[14ti\x05j\x1bZk";
        assert_eq!(filtered(&[stream]), b"abbcdefghijk");
        let kept: &[u8] =
            b"\x1b[31mred\x1b[0m\x1b[?1049h\x1b]0;title\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\
              \x1b\\\x1b(0q\x1b(B\x1b[2;5r\x1b[8;24;80t\x1b[>4;1m\x1b[>4n";
        assert_eq!(filtered(&[kept]), kept);
    }

    #[test]
    fn an_unfinished_unit_waits_for_its_end_wherever_the_stream_is_split() {
        let stream = "x\x1b]9;4;1;25\x1b[31m你\x1b]0;t\x07\x1b]9;40;x\x07\x1b]9;4;1;50\x07\x1b[6n\x1b]9;4;0;0\x1b\\y"
            .as_bytes();
        let whole = filtered(&[stream]);
        for split in 0..=stream.len() {
            let (mut splitter, mut modes) = (Splitter::default(), KeptModes::default());
            let first = filter(&mut splitter, &mut modes, &stream[..split], 24, None);
            let complete = whole.starts_with(&first.viewer_output)
                && std::str::from_utf8(&first.viewer_output).is_ok()
                && !first.viewer_output.ends_with(b"\x1b");
            assert!(complete, "split at {split}: {first:?}");
            let rest = filter(&mut splitter, &mut modes, &stream[split..], 24, None);
            assert_eq!(
                [first.viewer_output, rest.viewer_output].concat(),
                whole,
                "split at {split}"
            );
            assert_eq!(
                [first.native_activity, rest.native_activity].concat(),
                b"\x1b]9;4;1;50\x07\x1b]9;4;0;0\x1b\\",
                "split at {split}"
            );
        }
    }

    #[test]
    fn the_scrolling_region_and_the_character_set_are_noted() {
        let (mut splitter, mut modes) = (Splitter::default(), KeptModes::default());
        filter(&mut splitter, &mut modes, b"\x1b[2;10r\x0e", 24, None);
        assert_eq!(
            (modes.scroll_region, modes.active_charset),
            (Some((2, 10)), ActiveCharset::G1)
        );
        filter(&mut splitter, &mut modes, b"\x1b[r\x0f", 24, None);
        assert_eq!(
            (modes.scroll_region, modes.active_charset),
            (None, ActiveCharset::G0)
        );
        filter(&mut splitter, &mut modes, b"\x1b[5;3r", 24, None);
        assert_eq!(
            modes.scroll_region, None,
            "an invalid scrolling region leaves the region as it is"
        );
    }
}
