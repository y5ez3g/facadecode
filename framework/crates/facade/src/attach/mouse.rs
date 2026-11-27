//! The mouse in what the host sends: SGR reports while Attach has the mouse, and the cursor keys that
//! a terminal app makes of the wheel while it keeps the mouse itself.

use std::time::{Duration, Instant};

use facade_base::console::PointerAction;
use facade_base::desktop::Arrows;

use super::win32_key_prefix;

const ESCAPE: &[u8] = b"\x1b";
const CSI: &[u8] = b"\x1b[";
const SS3: &[u8] = b"\x1bO";
/// A held key repeats this often at least. Its last repeat can be read once it is up again.
const KEY_REPEAT: Duration = Duration::from_millis(150);

/// What Attach takes out of the input. The rest travels to the CLI as it came.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Take {
    Reports,
    /// The host sends application cursor keys, and the wheel as Up and Down. The CLI asked for such
    /// keys, or gets the ordinary ones.
    CursorKeys {
        down: Arrows,
        application: bool,
    },
    Nothing,
}

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
    /// The start of what may be a report or a cursor key, for [`Self::give_up`] if the rest does not
    /// follow.
    pending: Vec<u8>,
    /// The last Up or Down the person pressed, and when.
    pressed: Option<(Arrow, Instant)>,
    /// The key whose release belongs to the wheel as well.
    wheel_key: Option<Arrow>,
}

impl LocalMouseInput {
    /// Keeps what is unfinished, as a final Escape may be. A report begun under local ownership is
    /// still consumed after a handoff.
    pub(super) fn read(&mut self, keys: &[u8], take: Take, mut emit: impl FnMut(MouseInput<'_>)) {
        let mut joined = std::mem::take(&mut self.pending);
        let had_pending = !joined.is_empty();
        joined.extend_from_slice(keys);
        match take {
            Take::CursorKeys { down, application } if !joined.starts_with(b"\x1b[<") => {
                self.read_cursor_keys(&joined, down, application, &mut emit);
            }
            _ => self.read_reports(&joined, take, had_pending, &mut emit),
        }
    }

    fn read_reports(
        &mut self,
        keys: &[u8],
        take: Take,
        had_pending: bool,
        emit: &mut impl FnMut(MouseInput<'_>),
    ) {
        let local = take != Take::Nothing;
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
                Report::Other => search = at + 1,
            }
        }
        let mut rest = &keys[start..];
        if local && let Some(before) = rest.strip_suffix(ESCAPE) {
            self.pending.extend_from_slice(ESCAPE);
            rest = before;
        }
        emit(MouseInput::Keys(rest));
    }

    /// Tells the wheel from the cursor keys it is sent as: the person presses none.
    fn read_cursor_keys(
        &mut self,
        keys: &[u8],
        down: Arrows,
        application: bool,
        emit: &mut impl FnMut(MouseInput<'_>),
    ) {
        let mut start = 0;
        let mut search = 0;
        while let Some(at) = keys[search..].iter().position(|&byte| byte == 0x1b) {
            let at = search + at;
            let (length, key) = match cursor_key(&keys[at..]) {
                Cursor::Key { length, key } => (length, key),
                Cursor::Incomplete => {
                    emit(MouseInput::Keys(&keys[start..at]));
                    self.pending.extend_from_slice(&keys[at..]);
                    return;
                }
                Cursor::Other => {
                    search = at + 1;
                    continue;
                }
            };
            let end = at + length;
            let sent = &keys[at..end];
            let tick = match key {
                Key::Application(b'A') => self.wheel(Arrow::Up, down),
                Key::Application(b'B') => self.wheel(Arrow::Down, down),
                Key::Application(_) => None,
                Key::Ordinary(arrow) => self.wheel(arrow, down),
                Key::Win32(arrow, true) => {
                    let tick = self.wheel(arrow, down);
                    self.wheel_key = tick.map(|_| arrow);
                    tick
                }
                Key::Win32(arrow, false) if self.wheel_key == Some(arrow) => {
                    self.wheel_key = None;
                    Some(0)
                }
                Key::Win32(..) => None,
            };
            search = end;
            match (tick, key) {
                (Some(tick), _) => {
                    emit(MouseInput::Keys(&keys[start..at]));
                    emit(MouseInput::Wheel(tick));
                    start = end;
                }
                (None, Key::Application(last)) if !application => {
                    emit(MouseInput::Keys(&keys[start..at]));
                    emit(MouseInput::Keys(&[0x1b, b'[', last]));
                    start = end;
                }
                (None, _) => debug_assert!(!sent.is_empty()),
            }
        }
        emit(MouseInput::Keys(&keys[start..]));
    }

    /// The tick of the wheel an arrow key stands for; none if the person pressed it.
    fn wheel(&mut self, arrow: Arrow, down: Arrows) -> Option<i16> {
        let now = Instant::now();
        let (is_down, tick) = match arrow {
            Arrow::Up => (down.up, 1),
            Arrow::Down => (down.down, -1),
        };
        if is_down {
            self.pressed = Some((arrow, now));
            return None;
        }
        let repeats = self
            .pressed
            .is_some_and(|(pressed, at)| pressed == arrow && now < at + KEY_REPEAT);
        (!repeats).then_some(tick)
    }

    /// Whether the rest of a report or a key is still to come.
    pub(super) fn unfinished(&self) -> bool {
        !self.pending.is_empty()
    }

    /// What is held once no more comes: keys, unless it is clear that a report was cut off.
    pub(super) fn give_up(&mut self) -> Vec<u8> {
        let mut held = std::mem::take(&mut self.pending);
        if held.starts_with(b"\x1b[<") {
            held.clear();
        }
        held
    }
}

/// `keys` without the complete SGR mouse reports in them. A report the CLI gets, such as the
/// pointer moving over it, is no typing.
pub(super) fn without_reports(keys: &[u8]) -> Vec<u8> {
    let mut rest = Vec::with_capacity(keys.len());
    let mut at = 0;
    while at < keys.len() {
        match sgr_report(&keys[at..]) {
            Report::Complete { length, .. } => at += length,
            _ => {
                rest.push(keys[at]);
                at += 1;
            }
        }
    }
    rest
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
        return if CSI.starts_with(bytes) {
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Arrow {
    Up,
    Down,
}

#[derive(Clone, Copy)]
enum Key {
    /// A cursor key in its application form, by its final byte.
    Application(u8),
    /// An ordinary Up or Down that Windows Terminal can emit for the wheel.
    Ordinary(Arrow),
    /// A record of an arrow key that a terminal's bytes can stand for, and whether it goes down.
    Win32(Arrow, bool),
}

enum Cursor {
    Key { length: usize, key: Key },
    Incomplete,
    Other,
}

fn cursor_key(bytes: &[u8]) -> Cursor {
    if let Some(&last @ (b'A' | b'B' | b'C' | b'D' | b'F' | b'H')) =
        bytes.strip_prefix(SS3).and_then(<[u8]>::first)
    {
        let key = Key::Application(last);
        return Cursor::Key { length: 3, key };
    }
    if cfg!(windows)
        && let [0x1b, b'[', direction @ (b'A' | b'B'), ..] = bytes
    {
        let arrow = if *direction == b'A' {
            Arrow::Up
        } else {
            Arrow::Down
        };
        return Cursor::Key {
            length: 3,
            key: Key::Ordinary(arrow),
        };
    }
    if SS3.starts_with(bytes) || starts_arrow_record(bytes) {
        return Cursor::Incomplete;
    }
    let Some((record, rest)) = win32_key_prefix(bytes) else {
        return Cursor::Other;
    };
    let arrow = match record.virtual_key {
        b"38" => Arrow::Up,
        b"40" => Arrow::Down,
        _ => return Cursor::Other,
    };
    if record.has_modifiers() || record.is_enhanced() {
        return Cursor::Other;
    }
    Cursor::Key {
        length: bytes.len() - rest.len(),
        key: Key::Win32(arrow, !record.is_release()),
    }
}

/// Whether a read cut off what can be a record of Up or Down. The Windows console gives its input in
/// pieces of a fixed length.
fn starts_arrow_record(bytes: &[u8]) -> bool {
    [b"\x1b[38;".as_slice(), b"\x1b[40;"].iter().any(|start| {
        start.starts_with(bytes)
            || bytes.strip_prefix(*start).is_some_and(|fields| {
                fields.len() < 24
                    && fields
                        .iter()
                        .all(|&byte| byte.is_ascii_digit() || byte == b';')
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mouse reports are no typing. Only the keys around them remain.
    #[test]
    fn reports_leave_only_the_keys_around_them() {
        assert_eq!(without_reports(b"\x1b[<35;20;16M"), b"");
        assert_eq!(without_reports(b"\x1b[<35;20;16M\x1b[<0;21;16m"), b"");
        assert_eq!(without_reports(b"a\x1b[<35;20;16Mb"), b"ab");
        assert_eq!(without_reports(b"\x1b[A\x1b"), b"\x1b[A\x1b");
    }

    const NONE: Arrows = Arrows {
        up: false,
        down: false,
    };
    const UP: Arrows = Arrows {
        up: true,
        down: false,
    };

    /// What reaches the CLI, and how far the wheel turned.
    fn routed(parts: [&[u8]; 2], take: Take) -> (String, i16) {
        let mut mouse = LocalMouseInput::default();
        let mut keys = Vec::new();
        let mut ticks = 0;
        for part in parts {
            mouse.read(part, take, |event| match event {
                MouseInput::Keys(more) => keys.extend_from_slice(more),
                MouseInput::Wheel(more) => ticks += more,
                MouseInput::Pointer { .. } => {}
            });
        }
        keys.extend(mouse.give_up());
        (String::from_utf8(keys).unwrap(), ticks)
    }

    fn cursor_keys(input: &str, down: Arrows, application: bool) -> (String, i16) {
        let take = Take::CursorKeys { down, application };
        let whole = routed([input.as_bytes(), b""], take);
        for cut in 1..input.len() {
            let (first, rest) = input.as_bytes().split_at(cut);
            assert_eq!(routed([first, rest], take), whole, "{input:?} cut at {cut}");
        }
        whole
    }

    #[test]
    fn reports_cut_off_anywhere_stay_with_attach() {
        let input = b"\x1b[<64;30;8M\x1b[<64;30;8M\x1b[<65;130;48M";
        for cut in 1..input.len() {
            let parts = [&input[..cut], &input[cut..]];
            let routed = routed(parts, Take::Reports);
            assert_eq!(routed, (String::new(), 1), "cut at {cut}");
        }
        let input = b"a\x1b[A\x1b\x1b[<64;30;8Mb\x1b";
        for cut in 1..input.len() {
            let parts = [&input[..cut], &input[cut..]];
            let routed = routed(parts, Take::Reports);
            assert_eq!(routed, ("a\x1b[A\x1bb\x1b".into(), 1), "cut at {cut}");
        }
    }

    #[test]
    fn a_cli_that_tracks_the_mouse_gets_its_reports() {
        let input = "x\x1b[<0;3;4M\x1b[<2;3;4M\x1bOA\x1b";
        let routed = routed([input.as_bytes(), b""], Take::Nothing);
        assert_eq!(routed, (input.into(), 0));
    }

    #[test]
    fn a_cli_that_tracks_the_mouse_gets_drags_and_right_clicks_unchanged() {
        let input = "\x1b[<0;3;4M\x1b[<32;5;4M\x1b[<0;5;4m\x1b[<2;3;4M\x1b[<2;3;4m";
        for cut in 0..=input.len() {
            let (first, rest) = input.as_bytes().split_at(cut);
            assert_eq!(
                routed([first, rest], Take::Nothing),
                (input.into(), 0),
                "cut at {cut}"
            );
        }
    }

    #[test]
    fn an_arrow_key_that_is_not_down_is_the_wheel() {
        assert_eq!(
            cursor_keys("a\x1bOA\x1bOA\x1bOA\x1bOBb", NONE, false),
            ("ab".into(), 2)
        );
        assert_eq!(
            cursor_keys("a\x1bOAb", UP, true),
            ("a\x1bOAb".into(), 0),
            "the person pressed Up"
        );
        assert_eq!(
            cursor_keys("\x1bOA\x1bOB", UP, false),
            ("\x1b[A".into(), -1)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_ordinary_arrows_can_carry_the_wheel() {
        assert_eq!(cursor_keys("a\x1b[Ab", NONE, true), ("ab".into(), 1));
        assert_eq!(
            cursor_keys("\x1b[A", UP, true),
            ("\x1b[A".into(), 0),
            "a pressed Up goes to the CLI in its original form"
        );
        assert_eq!(cursor_keys("\x1b[B", NONE, false), (String::new(), -1));
        let down = Arrows { down: true, ..NONE };
        assert_eq!(cursor_keys("\x1b[B", down, true), ("\x1b[B".into(), 0));
    }

    #[test]
    fn the_other_cursor_keys_reach_the_cli_as_it_asked_for_them() {
        let others = "\x1bOC\x1bOD\x1bOH\x1bOF";
        assert_eq!(cursor_keys(others, NONE, true), (others.into(), 0));
        assert_eq!(
            cursor_keys(others, NONE, false),
            ("\x1b[C\x1b[D\x1b[H\x1b[F".into(), 0)
        );
        // F1, a modified arrow key, ordinary keys and Escape are no cursor keys of the wheel.
        let keys = "\x1bOP\x1b[1;2A\x1bxé\x1b";
        assert_eq!(cursor_keys(keys, NONE, false), (keys.into(), 0));
        #[cfg(not(windows))]
        assert_eq!(cursor_keys("\x1b[A", NONE, false), ("\x1b[A".into(), 0));
    }

    #[test]
    fn the_wheel_is_told_from_arrow_key_records() {
        let wheel = "\x1b[38;72;0;1;0;1_\x1b[38;72;0;0;0;1_";
        assert_eq!(cursor_keys(wheel, NONE, false), (String::new(), 1));
        assert_eq!(cursor_keys(wheel, UP, false), (wheel.into(), 0));
        let keyboard = "\x1b[38;72;0;1;256;1_\x1b[38;72;0;0;256;1_";
        assert_eq!(
            cursor_keys(keyboard, NONE, false),
            (keyboard.into(), 0),
            "the record says that the keyboard sent it"
        );
        let with_shift = "\x1b[38;72;0;1;16;1_\x1b[38;72;0;0;16;1_";
        assert_eq!(cursor_keys(with_shift, NONE, false), (with_shift.into(), 0));
        let letter = "\x1b[65;30;97;1;0;1_\x1b[65;30;97;0;0;1_";
        assert_eq!(cursor_keys(letter, NONE, false), (letter.into(), 0));
    }

    #[test]
    fn the_last_repeat_of_a_key_can_be_read_after_its_release() {
        let mut mouse = LocalMouseInput::default();
        let mut ticks = 0;
        for down in [UP, NONE] {
            let take = Take::CursorKeys {
                down,
                application: false,
            };
            mouse.read(b"\x1bOA", take, |event| {
                if let MouseInput::Wheel(more) = event {
                    ticks += more;
                }
            });
        }
        assert_eq!(ticks, 0);
        std::thread::sleep(KEY_REPEAT);
        let take = Take::CursorKeys {
            down: NONE,
            application: false,
        };
        mouse.read(b"\x1bOA", take, |event| {
            if let MouseInput::Wheel(more) = event {
                ticks += more;
            }
        });
        assert_eq!(ticks, 1);
    }
}
