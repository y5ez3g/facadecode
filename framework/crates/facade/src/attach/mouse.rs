//! The mouse in what the host sends: SGR reports while Attach has the mouse, and the cursor keys that
//! a terminal app makes of the wheel while it keeps the mouse itself.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use facade_base::console::PointerAction;
use facade_base::desktop::{Arrow, Arrows, CursorEvent, CursorSample};

use super::win32_key_prefix;

const ESCAPE: &[u8] = b"\x1b";
const CSI: &[u8] = b"\x1b[";
const SS3: &[u8] = b"\x1bO";
const MAX_CURSOR_EVENTS: usize = 256;
/// A held key repeats this often at least. Its last repeat can be read once it is up again.
const KEY_REPEAT: Duration = Duration::from_millis(150);

/// What Attach takes out of the input. The rest travels to the CLI as it came.
pub(super) enum Take {
    Reports,
    /// The host sends application cursor keys, and the wheel as Up and Down. The CLI asked for such
    /// keys, or gets the ordinary ones.
    CursorKeys {
        sample: CursorSample,
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

#[derive(Clone, Copy)]
enum Keyboard {
    Legacy(Arrows),
    Observed(Arrows),
}

#[derive(Default)]
pub(super) struct LocalMouseInput {
    /// The start of what may be a report or a cursor key, for [`Self::give_up`] if the rest does not
    /// follow.
    pending: Vec<u8>,
    /// Native events that still have bytes to match, including the rest of a wheel's steps.
    events: VecDeque<CursorEvent>,
    /// The keyboard evidence when a partial read started.
    pending_keyboard: Option<Keyboard>,
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
        let pending_keyboard = self.pending_keyboard.take();
        joined.extend_from_slice(keys);
        match take {
            Take::CursorKeys {
                sample,
                application,
            } if !joined.starts_with(b"\x1b[<") => {
                let keyboard = match sample {
                    CursorSample::Observed { events, held } => {
                        self.events.extend(events);
                        let excess = self.events.len().saturating_sub(MAX_CURSOR_EVENTS);
                        self.events.drain(..excess);
                        Keyboard::Observed(held)
                    }
                    CursorSample::KeyboardState(down) => Keyboard::Legacy(down),
                };
                self.read_cursor_keys(&joined, keyboard, pending_keyboard, application, &mut emit);
            }
            take => {
                self.events.clear();
                let local = !matches!(take, Take::Nothing);
                self.read_reports(&joined, local, had_pending, &mut emit);
            }
        }
    }

    fn read_reports(
        &mut self,
        keys: &[u8],
        local: bool,
        had_pending: bool,
        emit: &mut impl FnMut(MouseInput<'_>),
    ) {
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

    /// Separates wheel steps from keys and forwards the cursor keys in the CLI's mode.
    fn read_cursor_keys(
        &mut self,
        keys: &[u8],
        keyboard: Keyboard,
        pending_keyboard: Option<Keyboard>,
        application: bool,
        emit: &mut impl FnMut(MouseInput<'_>),
    ) {
        let mut start = 0;
        let mut search = 0;
        while let Some(at) = keys[search..].iter().position(|&byte| byte == 0x1b) {
            let at = search + at;
            let source = if at == 0 {
                pending_keyboard.unwrap_or(keyboard)
            } else {
                keyboard
            };
            let (length, key) = match cursor_key(&keys[at..]) {
                Cursor::Key { length, key } => (length, key),
                Cursor::Incomplete => {
                    emit(MouseInput::Keys(&keys[start..at]));
                    self.pending.extend_from_slice(&keys[at..]);
                    self.pending_keyboard = Some(source);
                    return;
                }
                Cursor::Other => {
                    search = at + 1;
                    continue;
                }
            };
            let end = at + length;
            let tick = match key {
                Key::Application(b'A') => self.wheel(Arrow::Up, source, &keys[at..]),
                Key::Application(b'B') => self.wheel(Arrow::Down, source, &keys[at..]),
                Key::Application(_) => None,
                Key::Ordinary(arrow) if cfg!(windows) => self.wheel(arrow, source, &keys[at..]),
                Key::Ordinary(arrow) => self.match_arrow(arrow, None, false),
                Key::Win32(arrow, true) => {
                    let tick = self.wheel(arrow, source, &keys[at..]);
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
                (None, _) => {}
            }
        }
        emit(MouseInput::Keys(&keys[start..]));
    }

    /// The tick of the wheel an arrow key stands for; none if the person pressed it.
    fn wheel(&mut self, arrow: Arrow, keyboard: Keyboard, remaining: &[u8]) -> Option<i16> {
        match keyboard {
            Keyboard::Legacy(down) => (!self.was_pressed(arrow, down)).then_some(wheel_tick(arrow)),
            Keyboard::Observed(held) => {
                let pressed = self.was_pressed(arrow, held);
                self.match_arrow(arrow, Some(remaining), pressed)
            }
        }
    }

    fn was_pressed(&mut self, arrow: Arrow, down: Arrows) -> bool {
        let now = Instant::now();
        let is_down = match arrow {
            Arrow::Up => down.up,
            Arrow::Down => down.down,
        };
        if is_down {
            self.pressed = Some((arrow, now));
            return true;
        }
        self.pressed
            .is_some_and(|(pressed, at)| pressed == arrow && now < at + KEY_REPEAT)
    }

    /// Match one sequence at a time. Earlier events without matching bytes may have been handled
    /// by the host itself. A plain CSI arrow can match a key, as the host's wheel uses SS3 here.
    fn match_arrow(
        &mut self,
        arrow: Arrow,
        application: Option<&[u8]>,
        pressed: bool,
    ) -> Option<i16> {
        let matches_key =
            |event: &CursorEvent| matches!(event, CursorEvent::Key(key) if *key == arrow);
        let next = self.events.iter().position(|event| match event {
            CursorEvent::Key(_) => matches_key(event),
            CursorEvent::Wheel { arrow: wheel, .. } => application.is_some() && *wheel == arrow,
        })?;
        self.events.drain(..next);
        let Some(CursorEvent::Wheel {
            count, may_skip, ..
        }) = self.events.front()
        else {
            self.events.pop_front();
            return None;
        };
        let (count, may_skip) = (*count, *may_skip);
        if may_skip && pressed {
            self.events.pop_front();
            return None;
        }
        if may_skip && let Some(bytes) = application {
            let mut keys = self
                .events
                .iter()
                .enumerate()
                .filter(|(_, event)| matches_key(event));
            if let Some((first, _)) = keys.next()
                && remaining_arrows(bytes, arrow) <= 1 + keys.count()
            {
                // The host can accumulate a wheel event without writing an arrow. Keep the
                // positive keyboard match, and leave the wheel for any following bytes.
                self.events.remove(first);
                return None;
            }
        }
        self.events.pop_front();
        if count > 1 {
            self.events.push_front(CursorEvent::Wheel {
                arrow,
                count: count - 1,
                may_skip,
            });
        }
        Some(wheel_tick(arrow))
    }

    /// Whether the rest of a report or a key is still to come.
    pub(super) fn unfinished(&self) -> bool {
        !self.pending.is_empty()
    }

    /// What is held once no more comes: keys, unless it is clear that a report was cut off.
    pub(super) fn give_up(&mut self) -> Vec<u8> {
        self.pending_keyboard = None;
        self.events.clear();
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

fn wheel_tick(arrow: Arrow) -> i16 {
    match arrow {
        Arrow::Up => 1,
        Arrow::Down => -1,
    }
}

/// How many sequences, including a partial one at the read boundary, can match this arrow.
fn remaining_arrows(bytes: &[u8], arrow: Arrow) -> usize {
    let last = match arrow {
        Arrow::Up => b'A',
        Arrow::Down => b'B',
    };
    let complete = bytes
        .windows(3)
        .filter(|window| matches!(window, [0x1b, b'O' | b'[', direction] if *direction == last))
        .count();
    let partial = bytes.ends_with(SS3) || bytes.ends_with(CSI);
    complete + usize::from(partial)
}

#[derive(Clone, Copy)]
enum Key {
    /// A cursor key in its application form, by its final byte.
    Application(u8),
    /// An ordinary Up or Down. Only Windows Terminal can emit it for the wheel here.
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
    if let [0x1b, b'[', direction @ (b'A' | b'B'), ..] = bytes {
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
    fn routed(parts: [&[u8]; 2], take: impl Fn() -> Take) -> (String, i16) {
        let mut mouse = LocalMouseInput::default();
        let mut keys = Vec::new();
        let mut ticks = 0;
        for part in parts {
            mouse.read(part, take(), |event| match event {
                MouseInput::Keys(more) => keys.extend_from_slice(more),
                MouseInput::Wheel(more) => ticks += more,
                MouseInput::Pointer { .. } => {}
            });
        }
        keys.extend(mouse.give_up());
        (String::from_utf8(keys).unwrap(), ticks)
    }

    fn cursor_keys(input: &str, down: Arrows, application: bool) -> (String, i16) {
        let take = || Take::CursorKeys {
            sample: CursorSample::KeyboardState(down),
            application,
        };
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
            let routed = routed(parts, || Take::Reports);
            assert_eq!(routed, (String::new(), 1), "cut at {cut}");
        }
        let input = b"a\x1b[A\x1b\x1b[<64;30;8Mb\x1b";
        for cut in 1..input.len() {
            let parts = [&input[..cut], &input[cut..]];
            let routed = routed(parts, || Take::Reports);
            assert_eq!(routed, ("a\x1b[A\x1bb\x1b".into(), 1), "cut at {cut}");
        }
    }

    #[test]
    fn a_cli_that_tracks_the_mouse_gets_its_reports() {
        let input = "x\x1b[<0;3;4M\x1b[<2;3;4M\x1bOA\x1b";
        let routed = routed([input.as_bytes(), b""], || Take::Nothing);
        assert_eq!(routed, (input.into(), 0));
    }

    #[test]
    fn a_cli_that_tracks_the_mouse_gets_drags_and_right_clicks_unchanged() {
        let input = "\x1b[<0;3;4M\x1b[<32;5;4M\x1b[<0;5;4m\x1b[<2;3;4M\x1b[<2;3;4m";
        for cut in 0..=input.len() {
            let (first, rest) = input.as_bytes().split_at(cut);
            assert_eq!(
                routed([first, rest], || Take::Nothing),
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

    #[test]
    fn keys_with_no_wheel_event_follow_the_cli_cursor_mode() {
        let application_keys = b"\x1bOA\x1bOB\x1bOD\x1bOC\x1bOH\x1bOF";
        let ordinary_keys = "\x1b[A\x1b[B\x1b[D\x1b[C\x1b[H\x1b[F";
        for application in [false, true] {
            let take = || Take::CursorKeys {
                sample: CursorSample::Observed {
                    events: Vec::new(),
                    held: NONE,
                },
                application,
            };
            let expected = if application {
                std::str::from_utf8(application_keys).unwrap()
            } else {
                ordinary_keys
            };
            for cut in 0..=application_keys.len() {
                let (first, rest) = application_keys.split_at(cut);
                assert_eq!(routed([first, rest], take), (expected.into(), 0));
            }
        }
    }

    #[test]
    fn a_fragmented_wheel_event_keeps_its_source() {
        assert_eq!(
            observed_input([
                (b"\x1bO".as_slice(), vec![wheel(1, false)]),
                (b"B\x1bOA", vec![CursorEvent::Key(Arrow::Up)]),
            ]),
            [Step::Wheel(-1), Step::Keys(b"\x1b[A".to_vec())]
        );
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Step {
        Keys(Vec<u8>),
        Wheel(i16),
    }

    fn wheel(count: u64, may_skip: bool) -> CursorEvent {
        CursorEvent::Wheel {
            arrow: Arrow::Down,
            count,
            may_skip,
        }
    }

    fn observed_input<'a>(
        parts: impl IntoIterator<Item = (&'a [u8], Vec<CursorEvent>)>,
    ) -> Vec<Step> {
        let mut mouse = LocalMouseInput::default();
        let mut steps = Vec::new();
        for (bytes, events) in parts {
            mouse.read(
                bytes,
                Take::CursorKeys {
                    sample: CursorSample::Observed { events, held: NONE },
                    application: false,
                },
                |event| match event {
                    MouseInput::Keys([]) => {}
                    MouseInput::Keys(bytes) => steps.push(Step::Keys(bytes.to_vec())),
                    MouseInput::Wheel(tick) => steps.push(Step::Wheel(tick)),
                    MouseInput::Pointer { .. } => panic!("unexpected pointer report"),
                },
            );
        }
        assert!(!mouse.unfinished());
        steps
    }

    #[test]
    fn identical_sequences_keep_key_and_wheel_order_even_in_one_read() {
        let input = b"\x1bOB\x1bOB";
        for cut in 1..=input.len() {
            let (first, rest) = input.split_at(cut);
            let key = CursorEvent::Key(Arrow::Down);
            assert_eq!(
                observed_input([(first, vec![key, wheel(1, false)]), (rest, vec![])]),
                [Step::Keys(b"\x1b[B".to_vec()), Step::Wheel(-1)],
                "key then wheel, cut at {cut}"
            );
            let key = CursorEvent::Key(Arrow::Down);
            assert_eq!(
                observed_input([(first, vec![wheel(1, false), key]), (rest, vec![])]),
                [Step::Wheel(-1), Step::Keys(b"\x1b[B".to_vec())],
                "wheel then key, cut at {cut}"
            );
        }
    }

    #[test]
    fn only_scoped_wheel_evidence_can_consume_an_arrow() {
        assert_eq!(
            observed_input([(b"\x1bOB".as_slice(), vec![])]),
            [Step::Keys(b"\x1b[B".to_vec())]
        );
    }

    #[test]
    fn a_wheel_event_without_bytes_cannot_take_a_matching_key() {
        let key = || CursorEvent::Key(Arrow::Down);
        let down = b"\x1bOB".as_slice();
        assert_eq!(
            observed_input([(down, vec![wheel(1, true), key()]), (down, vec![key()])]),
            [
                Step::Keys(b"\x1b[B".to_vec()),
                Step::Keys(b"\x1b[B".to_vec())
            ]
        );
        assert_eq!(
            observed_input([(b"\x1bOB\x1bOB".as_slice(), vec![wheel(1, true), key()])]),
            [Step::Wheel(-1), Step::Keys(b"\x1b[B".to_vec())]
        );
        assert_eq!(
            observed_input([(down, vec![wheel(1, true), key()]), (down, vec![])]),
            [Step::Keys(b"\x1b[B".to_vec()), Step::Wheel(-1)]
        );
    }

    #[test]
    fn an_observer_that_only_sees_the_wheel_can_still_tell_a_held_arrow_from_silent_scroll() {
        let mut mouse = LocalMouseInput::default();
        let mut keys = Vec::new();
        mouse.read(
            b"\x1bOB",
            Take::CursorKeys {
                sample: CursorSample::Observed {
                    events: vec![wheel(1, true)],
                    held: Arrows { down: true, ..NONE },
                },
                application: false,
            },
            |event| match event {
                MouseInput::Keys(bytes) => keys.extend_from_slice(bytes),
                _ => panic!("a held arrow can still be recognized"),
            },
        );
        assert_eq!(keys, b"\x1b[B");
    }

    #[test]
    fn a_multi_line_wheel_can_span_reads_before_a_key_in_the_same_direction() {
        assert_eq!(
            observed_input([
                (b"\x1bOB".as_slice(), vec![wheel(4, false)]),
                (b"\x1bOB\x1bOB", vec![]),
                (b"\x1bOB\x1bOB", vec![CursorEvent::Key(Arrow::Down)]),
            ]),
            [
                Step::Wheel(-1),
                Step::Wheel(-1),
                Step::Wheel(-1),
                Step::Wheel(-1),
                Step::Keys(b"\x1b[B".to_vec()),
            ]
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
                sample: CursorSample::KeyboardState(down),
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
            sample: CursorSample::KeyboardState(NONE),
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
