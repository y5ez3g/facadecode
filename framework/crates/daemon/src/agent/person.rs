//! The person's keys from an attached terminal. Their Enter may submit what the CLI's input holds,
//! which the agent's state says once the CLI takes it. Keys go into the terminal as they come, but
//! an Enter that may submit waits, with the keys after it, until the CLI drew what came before it,
//! so that the input can be read first. What a terminal reports by itself, such as its mouse, is
//! told from keys that can change the input, and what the input has yet to show of those is kept.

use std::borrow::Cow;
use std::ops::Range;
use std::time::Duration;

use facade_base::model::terminal::InputState;
use facade_rules::BoxReading;
use tokio::time::Instant;

use super::{ESCAPE_DELAY, MAX_INPUT_BYTES, PASTE_END, PASTE_START, SLOWEST_DRAW};

/// How long the screen stays quiet after the CLI drew the keys before a held Enter.
pub(super) const ENTER_DRAWN_AFTER: Duration = Duration::from_millis(30);
/// The longest an Enter is held.
const MAX_ENTER_HELD: Duration = Duration::from_millis(150);
/// How soon a held Enter looks again while the CLI keeps drawing.
pub(super) const ENTER_READ_AGAIN: Duration = Duration::from_millis(10);
/// How long the CLI may take to take what an Enter submitted.
const SUBMISSION_TAKEN_TIMEOUT: Duration = Duration::from_secs(4);
/// The longest escape sequence read as one; a longer one is keys.
const MAX_SEQUENCE_BYTES: usize = 64;

fn max_enter_held() -> Duration {
    // Scenario tests slow the hold down to see what it holds.
    if cfg!(debug_assertions)
        && let Some(ms) = std::env::var("FACADE_TEST_ENTER_HELD_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
    {
        return Duration::from_millis(ms);
    }
    MAX_ENTER_HELD
}

/// What some of the person's keys hold, up to their first Enter.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct PersonInput {
    /// More than reports of their terminal's own: the input may change.
    pub(super) edits: bool,
    /// The start of the first complete editing key that can go now.
    pub(super) first_edit: Option<KeyOffset>,
    /// The first key that can change the text of a delivery draft.
    pub(super) first_draft_edit: Option<KeyOffset>,
    /// The final byte of the last such key, so its entire sequence has to reach the CLI.
    pub(super) last_draft_edit: Option<KeyOffset>,
    /// A sequence that still needs to be classified.
    pub(super) partial_start: Option<KeyOffset>,
    /// A key that may empty the input or bring an older draft back went in, their Enter aside.
    pub(super) clears: bool,
    /// The Enter they end with.
    pub(super) enter: Option<Enter>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum KeyOffset {
    Carried,
    Packet(usize),
}

impl KeyOffset {
    fn from_index(index: usize, carried: usize) -> Self {
        index
            .checked_sub(carried)
            .map_or(Self::Carried, Self::Packet)
    }
}

impl PersonInput {
    fn edited_at(&mut self, bytes: Range<usize>, carried: usize, changes_draft: bool) {
        let offset = KeyOffset::from_index(bytes.start, carried);
        self.edits = true;
        self.first_edit.get_or_insert(offset);
        if changes_draft {
            self.first_draft_edit.get_or_insert(offset);
            self.last_draft_edit = Some(KeyOffset::from_index(bytes.end - 1, carried));
        }
    }

    fn partial_at(&mut self, index: usize, carried: usize) {
        self.edits = true;
        self.partial_start = Some(KeyOffset::from_index(index, carried));
    }
}

/// Up and Down in either cursor mode, with at most one Enter at the end.
pub(super) fn menu_keys(mut bytes: &[u8]) -> bool {
    while let [b'\x1b', b'[' | b'O', b'A' | b'B', rest @ ..] = bytes {
        bytes = rest;
    }
    matches!(bytes, [] | [b'\r'])
}

/// An Enter in the person's keys that may submit the input.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Enter {
    /// Where it is in the keys just given.
    pub(super) at: usize,
    /// The texts the person pasted since their last Enter, earliest first.
    pub(super) pastes: Vec<String>,
}

/// Follows the person's keys through bracketed pastes: a carriage return outside a paste, and not
/// right after Escape (that is Alt+Enter), is an Enter.
#[derive(Default)]
pub(super) struct PersonKeys {
    /// Inside a paste.
    pasting: bool,
    /// The first bytes of an escape sequence the last keys ended in.
    partial: Vec<u8>,
    /// The paste under way, up to [`MAX_INPUT_BYTES`].
    paste: Vec<u8>,
    /// Pastes since the last Enter, at most [`MAX_INPUT_BYTES`] in all.
    pastes: Vec<String>,
    /// When their last key that can change the input came, and when it went on.
    last: Option<(Instant, Instant)>,
    unshown: Unshown,
}

impl PersonKeys {
    /// Reads `keys`, which go into the input now, up to their first Enter, or to their end.
    pub(super) fn read(&mut self, keys: &[u8]) -> PersonInput {
        let now = Instant::now();
        let mut found = PersonInput::default();
        let lone_escape = self.lone_escape();
        if self.finish_escape(now) {
            found.clears = lone_escape;
            found.first_edit = Some(KeyOffset::Carried);
            found.first_draft_edit = found.first_edit;
            found.last_draft_edit = found.first_edit;
        }
        let carried = std::mem::take(&mut self.partial);
        let bytes = following(&carried, keys);
        let mut i = 0;
        while i < bytes.len() {
            let rest = &bytes[i..];
            if let Some(opens) = bracket(rest) {
                self.close_paste();
                self.pasting = opens;
                found.edited_at(i..i + PASTE_START.len(), carried.len(), true);
                i += PASTE_START.len();
                continue;
            }
            if partial_bracket(rest) {
                found.partial_at(i, carried.len());
                self.partial = rest.to_vec();
                break;
            }
            if rest[0] == 0x1b && !self.pasting {
                let Some(length) = sequence(rest) else {
                    found.partial_at(i, carried.len());
                    self.partial = rest.to_vec();
                    break;
                };
                let key = &rest[..length];
                if !is_report(key) {
                    let leaves = sequence_leaves(key);
                    found.edited_at(
                        i..i + length,
                        carried.len(),
                        leaves != Leaves::AsItWas || sequence_changes_text(key),
                    );
                    // Alt+Enter is a line break of the draft's.
                    if key != b"\x1b" || rest.get(1) != Some(&b'\r') {
                        found.clears |= self.goes_in(leaves, now);
                    }
                }
                i += length;
                continue;
            }
            let byte = rest[0];
            let leaves = if self.pasting {
                Leaves::Draft
            } else {
                character_leaves(byte.into())
            };
            // An Enter counts once it goes on.
            if self.pasting || byte != b'\r' {
                found.clears |= self.goes_in(leaves, now);
            }
            let after_escape = i > 0 && bytes[i - 1] == 0x1b;
            if byte == b'\r' && !self.pasting && !after_escape {
                found.edits = true;
                found.enter = Some(Enter {
                    at: i - carried.len(),
                    pastes: std::mem::take(&mut self.pastes),
                });
                break;
            }
            found.edited_at(
                i..i + 1,
                carried.len(),
                leaves != Leaves::AsItWas || changes_character(byte.into()),
            );
            if self.pasting && self.paste.len() < MAX_INPUT_BYTES {
                self.paste.push(byte);
            }
            i += 1;
        }
        found
    }

    /// Whether `keys`, the person's next, hold more than reports of their terminal's own.
    pub(super) fn edits(&self, keys: &[u8]) -> bool {
        let carried = match self.escape_expired(Instant::now()) {
            true => &[][..],
            false => &self.partial[..],
        };
        let bytes = following(carried, keys);
        let mut rest = bytes.as_ref();
        while rest.first() == Some(&0x1b)
            && let Some(length) = sequence(rest)
            && is_report(&rest[..length])
        {
            rest = &rest[length..];
        }
        self.pasting || !rest.is_empty()
    }

    /// Whether an incomplete escape sequence outside a paste has reached its wait bound.
    fn escape_expired(&self, now: Instant) -> bool {
        !self.pasting && self.partial_deadline().is_some_and(|until| now >= until)
    }

    /// Finishes an incomplete escape sequence as an editing key once its following bytes are due.
    pub(super) fn finish_escape(&mut self, now: Instant) -> bool {
        if !self.escape_expired(now) {
            return false;
        }
        if self.lone_escape() {
            self.goes_in(Leaves::Nothing, now);
        }
        self.partial.clear();
        true
    }

    /// Whether an Escape already sent to the CLI could still be its own key.
    pub(super) fn lone_escape(&self) -> bool {
        self.partial == b"\x1b" && !self.pasting
    }

    /// Whether a paste of the person's goes on.
    pub(super) fn is_pasting(&self) -> bool {
        self.pasting
    }

    /// Whether the person is in the middle of something the CLI has part of: a paste, until its
    /// end, or an escape sequence or paste bracket, until its rest is due.
    pub(super) fn is_writing(&self, now: Instant) -> bool {
        self.is_pasting() || self.partial_until(now).is_some()
    }

    /// Until when the rest of an escape sequence or paste bracket the person's keys ended in may
    /// still come: an Escape alone is a key of its own after the pause that tells it from one,
    /// and the rest of anything else may take as long as their keys take to show.
    pub(super) fn partial_until(&self, now: Instant) -> Option<Instant> {
        self.partial_deadline().filter(|until| now < *until)
    }

    fn partial_deadline(&self) -> Option<Instant> {
        let (_, went) = self.last?;
        Some(match self.partial.as_slice() {
            [] => return None,
            b"\x1b" => went + ESCAPE_DELAY,
            _ => went + SLOWEST_DRAW,
        })
    }

    /// A key that leaves `leaves` goes into the input. Returns whether it may empty it.
    fn goes_in(&mut self, leaves: Leaves, now: Instant) -> bool {
        self.unshown.follow(leaves, now);
        leaves == Leaves::Nothing
    }

    /// An Enter, held until now, goes on: the input shows nothing once the CLI takes what it submits.
    pub(super) fn enters(&mut self) {
        self.unshown.follow(Leaves::Nothing, Instant::now());
    }

    /// The input reads as `reading`.
    pub(super) fn sees(&mut self, reading: &BoxReading) {
        self.unshown.sees(reading, Instant::now());
    }

    /// Until when the input may not show all the person's keys yet, where it may not.
    pub(super) fn unshown_until(&self) -> Option<Instant> {
        self.unshown.until().filter(|until| Instant::now() < *until)
    }

    /// When a key that came at `came` may go on. One that came while the key before it waited goes
    /// as long after that one as it came, but at most the pause after an Escape, so that they stay
    /// keys of their own.
    pub(super) fn due(&self, came: Instant) -> Instant {
        match self.last {
            Some((before, went)) if came < went => {
                went + came.saturating_duration_since(before).min(ESCAPE_DELAY)
            }
            _ => came,
        }
    }

    /// A key that can change the input and came at `came` goes on now.
    pub(super) fn goes_on(&mut self, came: Instant) {
        self.last = Some((came, Instant::now()));
    }

    /// Ends the paste under way, keeping its text.
    fn close_paste(&mut self) {
        if self.pasting {
            let text = String::from_utf8_lossy(&self.paste).into_owned();
            self.pastes.push(text);
            let mut total: usize = self.pastes.iter().map(String::len).sum();
            while total > MAX_INPUT_BYTES {
                total -= self.pastes.remove(0).len();
            }
        }
        self.paste.clear();
    }
}

/// What a key of the person's leaves in the input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Leaves {
    /// A draft: it is text.
    Draft,
    /// Nothing, or anything: it is an Enter, or may clear the input or bring an older draft back.
    Nothing,
    /// What was there: it moves along the draft or takes a character from it.
    AsItWas,
}

/// What the input has yet to show of the person's keys: a draft after their text, and nothing after
/// an Enter or another key that can empty it, one after the other in the order they went in. A CLI
/// that takes keys slowly shows them one by one while later ones are on their way.
#[derive(Default)]
struct Unshown {
    /// Whether the next of these is a draft.
    draft: bool,
    /// How many are left, a draft and nothing in turn.
    left: usize,
    /// The draft the input showed last.
    seen: Option<String>,
    /// When it shows all of them at the latest: when neither a key went in nor the input changed for
    /// as long as a slow CLI takes to draw.
    until: Option<Instant>,
}

impl Unshown {
    /// A key goes into the input that leaves `leaves` there.
    fn follow(&mut self, leaves: Leaves, now: Instant) {
        if leaves == Leaves::AsItWas {
            return;
        }
        if self.until.is_none_or(|until| until <= now) {
            self.left = 0;
        }
        let draft = leaves == Leaves::Draft;
        let odd = self.left % 2 == 1;
        if self.left == 0 {
            (self.draft, self.left) = (draft, 1);
        } else if draft != (self.draft == odd) {
            self.left += 1;
        }
        self.until = Some(now + SLOWEST_DRAW);
    }

    /// The input reads as `reading`. A menu or question takes the keys itself, and an unread input
    /// shows none.
    fn sees(&mut self, reading: &BoxReading, now: Instant) {
        if self.left == 0 || reading.is_unread() {
            return;
        }
        if reading.info.state == InputState::Interaction {
            self.left = 0;
            return;
        }
        let draft = reading.info.state == InputState::Draft;
        if reading.draft != self.seen {
            self.seen.clone_from(&reading.draft);
            self.until = Some(now + SLOWEST_DRAW);
        }
        if draft == self.draft {
            (self.draft, self.left) = (!draft, self.left - 1);
        }
    }

    fn until(&self) -> Option<Instant> {
        self.until.filter(|_| self.left > 0)
    }
}

/// `keys` after the bytes `carried` over from the last ones.
fn following<'a>(carried: &[u8], keys: &'a [u8]) -> Cow<'a, [u8]> {
    if carried.is_empty() {
        Cow::Borrowed(keys)
    } else {
        Cow::Owned([carried, keys].concat())
    }
}

/// Whether `bytes` begin with a paste bracket: Some(true) for its start, Some(false) for its end.
fn bracket(bytes: &[u8]) -> Option<bool> {
    if bytes.starts_with(PASTE_START) {
        Some(true)
    } else if bytes.starts_with(PASTE_END) {
        Some(false)
    } else {
        None
    }
}

/// Whether `bytes` are the first bytes of a paste bracket.
fn partial_bracket(bytes: &[u8]) -> bool {
    PASTE_START.starts_with(bytes) || PASTE_END.starts_with(bytes)
}

/// The length of the escape sequence `bytes` begin with; None while its end has not come.
fn sequence(bytes: &[u8]) -> Option<usize> {
    match bytes.get(1)? {
        // The older mouse report: three bytes of any value follow.
        b'[' if bytes.get(2) == Some(&b'M') => (bytes.len() >= 6).then_some(6),
        b'[' => {
            let end = bytes[2..]
                .iter()
                .position(|byte| !matches!(byte, 0x20..=0x3f));
            match end.map(|end| end + 2) {
                Some(end) if matches!(bytes[end], 0x40..=0x7e) => Some(end + 1),
                Some(end) => Some(end),
                None => (bytes.len() > MAX_SEQUENCE_BYTES).then_some(MAX_SEQUENCE_BYTES),
            }
        }
        b'O' => {
            let last = bytes.get(2)?;
            Some(if matches!(last, 0x40..=0x7e) { 3 } else { 2 })
        }
        _ => Some(1),
    }
}

/// Whether a terminal sends the escape sequence `keys` by itself: the mouse, the focus, a key let
/// go or a modifier alone, the last two in win32-input-mode or the kitty keyboard encoding.
fn is_report(keys: &[u8]) -> bool {
    let Some((last, parameters)) = control_sequence(keys) else {
        return false;
    };
    let number = |at, part| parameter(parameters, at, part);
    match last {
        _ if keys.starts_with(b"\x1b[M") => true,
        b'M' | b'm' => parameters.starts_with(b"<"),
        b'I' | b'O' => parameters.is_empty(),
        b'_' => {
            let modifier = matches!(number(0, 0), 16..=18 | 20 | 91 | 92 | 144 | 145 | 160..=165);
            number(3, 0) == 0 || (modifier && number(2, 0) == 0)
        }
        _ => {
            let modifier = matches!(number(0, 0), 57358..=57360 | 57441..=57454);
            number(1, 1) == 3 || (last == b'u' && modifier)
        }
    }
}

/// What the key whose character is `character` leaves in the input. Keys the input has no use for
/// leave what was there.
fn character_leaves(character: u32) -> Leaves {
    match character {
        // Backspace, Tab and a line break; Ctrl+A, B, E and F, which move the cursor; and Ctrl+G, L, O
        // and T, which CLIs take for views of theirs.
        0x7f | 0x08..=0x0a | 0x01 | 0x02 | 0x05 | 0x06 | 0x07 | 0x0c | 0x0f | 0x14 => {
            Leaves::AsItWas
        }
        // Ctrl+V and Y paste.
        0x16 | 0x19 | 0x20.. => Leaves::Draft,
        _ => Leaves::Nothing,
    }
}

/// What the key the escape sequence `keys` encodes leaves in the input.
fn sequence_leaves(keys: &[u8]) -> Leaves {
    let Some((last, parameters)) = control_sequence(keys) else {
        // Right, Left, End, Home and F1 to F4.
        return match keys {
            [0x1b, b'O', b'C' | b'D' | b'F' | b'H' | b'P'..=b'S'] => Leaves::AsItWas,
            _ => Leaves::Nothing,
        };
    };
    let number = |at, part| parameter(parameters, at, part);
    match last {
        // Right, Left, End, Home, F1 to F4 and Shift+Tab; then Home, Insert, Delete, End, the pages
        // and the other function keys.
        b'C' | b'D' | b'F' | b'H' | b'P'..=b'S' | b'Z' => Leaves::AsItWas,
        b'~' if matches!(number(0, 0), 1..=8 | 11..=24) => Leaves::AsItWas,
        b'_' => match (number(2, 0), number(0, 0)) {
            (0, 35 | 36 | 37 | 39) => Leaves::AsItWas,
            (0, _) => Leaves::Nothing,
            (character, _) => character_leaves(character),
        },
        // The modifiers count from 1: Shift 1, Alt 2, Ctrl 4, Super 8, Hyper 16, Meta 32.
        b'u' => {
            let modifiers = number(1, 0).saturating_sub(1) & 0b11_1111;
            match number(0, 0) {
                // A line break of the draft's.
                13 if modifiers != 0 => Leaves::AsItWas,
                57344..=63743 => Leaves::Nothing,
                character if modifiers <= 1 => character_leaves(character),
                _ => Leaves::Nothing,
            }
        }
        _ => Leaves::Nothing,
    }
}

fn changes_character(character: u32) -> bool {
    matches!(character, 0x08..=0x0a | 0x7f)
}

/// Some keys edit the text while leaving a draft in the input.
fn sequence_changes_text(keys: &[u8]) -> bool {
    match control_sequence(keys) {
        Some((b'~', parameters)) => parameter(parameters, 0, 0) == 3,
        Some((b'_', parameters)) => matches!(parameter(parameters, 0, 0), 8 | 9 | 46),
        Some((b'u', parameters)) => {
            let character = parameter(parameters, 0, 0);
            changes_character(character) || (character == 13 && parameter(parameters, 1, 0) > 1)
        }
        _ => false,
    }
}

/// The last byte of the control sequence `keys` and its parameters.
fn control_sequence(keys: &[u8]) -> Option<(u8, &[u8])> {
    let (last, parameters) = keys.strip_prefix(b"\x1b[")?.split_last()?;
    Some((*last, parameters))
}

/// Part `part` of parameter `at` of a control sequence, or 0 where it gives none.
fn parameter(parameters: &[u8], at: usize, part: usize) -> u32 {
    let field = parameters.split(|&byte| byte == b';').nth(at);
    let digits = field.and_then(|field| field.split(|&byte| byte == b':').nth(part));
    digits
        .and_then(|digits| std::str::from_utf8(digits).ok()?.parse().ok())
        .unwrap_or(0)
}

/// A person's Enter held until the CLI draws the preceding keys or the hold expires.
pub(super) struct HeldEnter {
    pub(super) came: Instant,
    pub(super) sent_through: u64,
    pub(super) release_at: Instant,
    pub(super) pastes: Vec<String>,
}

impl HeldEnter {
    pub(super) fn new(came: Instant, sent_through: u64, pastes: Vec<String>) -> Self {
        Self {
            came,
            sent_through,
            release_at: Instant::now() + max_enter_held(),
            pastes,
        }
    }

    pub(super) fn release_now(&mut self) {
        self.release_at = Instant::now();
    }
}

/// What a person's issued Enter submits, while its output frames are still being read.
pub(super) struct Submitting {
    pub(super) over: Option<Box<BoxReading>>,
    pub(super) pastes: Vec<String>,
    pub(super) through: u64,
    pub(super) until: Instant,
    pub(super) cleared_at: Option<u64>,
    pub(super) confirmed_at: Option<Instant>,
    pub(super) after_interaction: bool,
    pub(super) delivery_batch: Option<u64>,
    /// The CLI still showed or reported a wait after the following edit went on.
    pub(super) wait_observed_after_edit: bool,
}

impl Submitting {
    /// The Enter that ends at `through`, and any complete draft already read.
    pub(super) fn sent(over: Option<BoxReading>, pastes: Vec<String>, through: u64) -> Submitting {
        Self {
            over: over.map(Box::new),
            pastes,
            through,
            until: Instant::now() + SUBMISSION_TAKEN_TIMEOUT,
            cleared_at: None,
            confirmed_at: None,
            after_interaction: false,
            delivery_batch: None,
            wait_observed_after_edit: false,
        }
    }

    /// Whether `reading`, a whole frame the CLI drew after a sent Enter reached it, shows that the
    /// CLI took the draft the Enter went over: the input reads empty. A menu, a question or a row
    /// that may be a hint shows nothing of it.
    pub(super) fn is_taken(reading: &BoxReading) -> bool {
        reading.info.state == InputState::Usable
    }
}

#[cfg(test)]
mod tests {
    use facade_base::model::terminal::InputInfo;
    use facade_rules::{InputLine, LineCell};

    use super::*;

    fn reading(state: InputState, draft: Option<&str>) -> BoxReading {
        BoxReading::new(
            InputInfo {
                state,
                evidence: String::new(),
                mechanism: None,
                hidden: None,
            },
            draft.map(str::to_string),
        )
    }

    fn nothing() -> BoxReading {
        reading(InputState::Usable, None)
    }

    #[test]
    fn the_pastes_before_an_enter_go_with_it_within_the_input_limit() {
        let pasted = |text: &[u8]| [PASTE_START, text, PASTE_END].concat();
        let mut keys = PersonKeys::default();
        let read = keys.read(&[pasted(b"one\rtwo"), b" and ".to_vec(), pasted(b"three")].concat());
        assert_eq!(read.enter, None);
        let enter = keys.read(b"!\r and more").enter.expect("an Enter");
        assert_eq!(enter.at, 1);
        assert_eq!(enter.pastes, ["one\rtwo", "three"]);
        // A bracket split across reads is still a bracket, and a long paste keeps only its end.
        let big = vec![b'x'; MAX_INPUT_BYTES];
        let both = [pasted(b"small"), pasted(&big)].concat();
        let (first, second) = both.split_at(PASTE_START.len() + 2);
        assert_eq!(keys.read(first).enter, None);
        assert_eq!(keys.read(second).enter, None);
        let enter = keys.read(b"\r").enter.expect("an Enter");
        assert_eq!(enter.pastes.len(), 1);
        assert_eq!(enter.pastes[0].len(), MAX_INPUT_BYTES);
        // Alt+Enter is no Enter.
        assert_eq!(keys.read(b"\x1b\r").enter, None);
    }

    /// What follows an Enter is read once it goes on: a paste it begins is not under way yet.
    #[test]
    fn keys_are_read_up_to_their_first_enter() {
        let mut person = PersonKeys::default();
        let keys = b"a\r\x1b[200~b\rc\x1b[201~\r";
        let first = person.read(keys);
        assert!(!person.is_pasting());
        let rest = &keys[first.enter.expect("the first Enter").at + 1..];
        let second = person.read(rest).enter.expect("the second Enter");
        assert_eq!(second.at + 1, rest.len());
        assert_eq!(second.pastes, ["b\rc"]);
    }

    /// The mouse, the focus, a key let go and a modifier alone come from the terminal, not from
    /// typing, also where one comes in two pieces.
    #[test]
    fn a_terminal_s_own_reports_are_not_typing() {
        for report in [
            &b"\x1b[<35;120;40M"[..],
            b"\x1b[<64;20;8M\x1b[<65;20;8M",
            b"\x1b[<0;20;8M\x1b[<0;20;8m",
            b"\x1b[M #(",
            b"\x1b[I",
            b"\x1b[O",
            b"\x1b[65;30;97;0;0;1_",
            b"\x1b[13;28;13;0;0;1_",
            b"\x1b[16;42;0;1;16;1_",
            b"\x1b[97;1:3u",
            b"\x1b[1;1:3A",
            b"\x1b[57441;2u",
        ] {
            let shown = String::from_utf8_lossy(report);
            let mut person = PersonKeys::default();
            assert!(!person.edits(report), "{shown:?}");
            assert_eq!(person.read(report), PersonInput::default(), "{shown:?}");
            assert_eq!(person.unshown_until(), None, "{shown:?}");
            for cut in 1..report.len() {
                let mut person = PersonKeys::default();
                person.read(&report[..cut]);
                let rest = &report[cut..];
                assert!(!person.edits(rest), "{shown:?} cut at {cut}");
                person.read(rest);
                assert_eq!(person.unshown_until(), None, "{shown:?} cut at {cut}");
            }
        }
    }

    /// Everything else may change the input, an escape sequence no terminal is known to send by
    /// itself included. The input will show a draft after text; after a key that can empty it,
    /// nothing; and after one that moves along the draft or takes from it, what it showed.
    #[test]
    fn keys_are_typing_and_the_input_will_show_what_they_leave() {
        for (keys, shows) in [
            (&b"x"[..], Some(true)),
            ("\u{754c}".as_bytes(), Some(true)),
            (b"\x1b[200~pasted\x1b[201~", Some(true)),
            (b"\x1b[65;30;97;1;0;1_", Some(true)),
            (b"\x1b[97u", Some(true)),
            (b"\x1b[97:65;2u", Some(true)),
            (b"\x1b[I and x", Some(true)),
            (b"\x03", Some(false)),
            (b"\x1b[A", Some(false)),
            (b"\x1bOA", Some(false)),
            (b"\x1b[97;5u", Some(false)),
            (b"\x1b[13u", Some(false)),
            (b"\x1b[57352u", Some(false)),
            (b"\x1b[13;28;13;1;0;1_", Some(false)),
            (b"\x1b[38;72;0;1;0;1_", Some(false)),
            (b"\x15", Some(false)),
            (b"\x16", Some(true)),
            (b"\x1b[999z", Some(false)),
            (b"\r", None),
            (b"\t", None),
            (b"\x7f", None),
            (b"\x1b\r", None),
            (b"\x1b[D", None),
            (b"\x1bOH", None),
            (b"\x1b[1;5C", None),
            (b"\x1b[1~", None),
            (b"\x1b[Z", None),
            (b"\x1b[6~", None),
            (b"\x1b[3~", None),
            (b"\x1bOP", None),
            (b"\x0f", None),
            (b"\x1b[8;14;8;1;0;1_", None),
            (b"\x1b[37;75;0;1;0;1_", None),
            (b"\x1b[127u", None),
            (b"\x1b[13;2u", None),
        ] {
            let shown = String::from_utf8_lossy(keys);
            let mut person = PersonKeys::default();
            assert!(person.edits(keys), "{shown:?}");
            assert!(person.read(keys).edits, "{shown:?}");
            let next = person.unshown_until().map(|_| person.unshown.draft);
            assert_eq!(next, shows, "{shown:?}");
        }
    }

    /// The input shows what a person typed in its order: a slow CLI draws a line they submitted while
    /// their next one is on its way, and emptying the input for that line says nothing of the next.
    #[test]
    fn a_line_on_its_way_is_not_taken_for_the_one_the_input_shows() {
        let mut person = PersonKeys::default();
        let lines = ["first", "second", "third"];
        for (at, line) in lines.iter().enumerate() {
            person.read(line.as_bytes());
            if at + 1 < lines.len() {
                person.read(b"\r");
                person.enters();
            }
        }
        for line in ["first", "second"] {
            for shown in [&line[..2], line] {
                person.sees(&reading(InputState::Draft, Some(shown)));
                assert!(person.unshown_until().is_some(), "{shown}");
            }
            person.sees(&reading(InputState::Unknown, None));
            person.sees(&nothing());
            assert!(person.unshown_until().is_some(), "after {line}");
        }
        person.sees(&reading(InputState::Draft, Some("t")));
        assert_eq!(person.unshown_until(), None, "the last line shows");
    }

    /// One key after the other, as a fast CLI draws them, leaves nothing to wait for. What changes
    /// the draft without emptying it, an empty input that stays empty and a menu leave nothing either.
    #[test]
    fn the_input_shows_the_person_s_keys_at_once() {
        for (keys, shown) in [
            (&b"x"[..], reading(InputState::Draft, Some("x"))),
            (b"xy\x7f", reading(InputState::Draft, Some("x"))),
            (b"\x03", nothing()),
            (b"\x1b[A\x1b[B", nothing()),
            (b"/model", reading(InputState::Interaction, None)),
        ] {
            let mut person = PersonKeys::default();
            person.read(keys);
            person.sees(&shown);
            assert_eq!(person.unshown_until(), None, "{keys:?}");
        }
        let mut person = PersonKeys::default();
        person.read(b"x");
        person.sees(&reading(InputState::Draft, Some("x")));
        person.read(b"\r");
        person.enters();
        assert!(person.unshown_until().is_some());
        person.sees(&nothing());
        assert_eq!(person.unshown_until(), None);
    }

    /// What the CLI draws in one frame is waited for no longer than a slow CLI takes to draw, after
    /// the last key and the last change of the input.
    #[tokio::test(start_paused = true)]
    async fn keys_that_never_show_are_waited_for_a_bounded_time() {
        let mut person = PersonKeys::default();
        person.read(b"abc");
        person.read(b"\r");
        person.enters();
        person.sees(&nothing());
        let wait = SLOWEST_DRAW - Duration::from_millis(1);
        tokio::time::advance(wait).await;
        assert!(person.unshown_until().is_some());
        person.sees(&reading(InputState::Draft, Some("ab")));
        person.sees(&reading(InputState::Draft, Some("abc")));
        tokio::time::advance(wait).await;
        assert!(person.unshown_until().is_some(), "the input changed");
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(person.unshown_until(), None);
        person.read(b"d");
        person.sees(&reading(InputState::Draft, Some("d")));
        assert_eq!(person.unshown_until(), None, "what was waited for is over");
    }

    /// An Escape that nothing followed for a while was the key alone: an Enter after it is an Enter,
    /// and a report after it is none of its sequence.
    #[tokio::test(start_paused = true)]
    async fn an_escape_alone_begins_nothing() {
        for waits in [false, true] {
            let mut person = PersonKeys::default();
            assert!(person.read(b"\x1b").edits);
            person.goes_on(Instant::now());
            if waits {
                tokio::time::advance(ESCAPE_DELAY).await;
            }
            assert_eq!(person.edits(b"\x1b[I"), !waits);
            assert_eq!(person.read(b"\r").enter.is_some(), waits);
        }
    }

    /// A paste goes on until its end, whatever it holds and however it is cut.
    #[test]
    fn a_paste_is_typing_until_its_end() {
        let mut person = PersonKeys::default();
        assert!(person.read(b"\x1b[200~one\r\x1b[20").edits);
        assert!(person.is_pasting() && person.edits(b"\x1b[I"));
        let read = person.read(b"0~two");
        assert_eq!((read.edits, read.enter), (true, None));
        assert!(person.is_pasting());
        person.read(b"\x1b[201~");
        assert!(!person.is_pasting() && !person.edits(b"\x1b[I"));
    }

    /// Keys that end in part of an escape sequence or paste bracket write until its rest is due: an
    /// Escape alone until it is one, anything else as long as keys take to show. A paste goes on
    /// until its end.
    #[tokio::test(start_paused = true)]
    async fn keys_that_end_in_part_of_a_sequence_write_until_its_rest_is_due() {
        for (begun, lasts) in [
            (&b"\x1b"[..], ESCAPE_DELAY),
            (&b"\x1b[20"[..], SLOWEST_DRAW),
            (&b"\x1b[1;5"[..], SLOWEST_DRAW),
        ] {
            let mut person = PersonKeys::default();
            assert!(person.read(begun).edits);
            person.goes_on(Instant::now());
            tokio::time::advance(lasts - Duration::from_millis(1)).await;
            assert!(person.is_writing(Instant::now()), "{begun:?}");
            tokio::time::advance(Duration::from_millis(1)).await;
            assert!(!person.is_writing(Instant::now()), "{begun:?}");
            assert!(person.finish_escape(Instant::now()), "{begun:?}");
        }
        let mut person = PersonKeys::default();
        person.read(b"\x1b[20");
        person.goes_on(Instant::now());
        person.read(b"0~a paste");
        tokio::time::advance(SLOWEST_DRAW).await;
        assert!(
            person.is_writing(Instant::now()),
            "a paste goes on until its end"
        );
    }

    /// Keys that may empty the input are told from the others, the Enter they end with aside.
    #[test]
    fn keys_that_may_empty_the_input_are_told() {
        for (keys, clears) in [
            (&b"abc"[..], false),
            (&b"a\x03"[..], true),
            (&b"\x1b[A"[..], true),
            (&b"\x1b[C\x7f"[..], false),
            (&b"done\r"[..], false),
        ] {
            let read = PersonKeys::default().read(keys);
            assert_eq!(read.clears, clears, "{keys:?}");
        }
    }

    /// The CLI took a draft once a frame reads the input empty: a menu, a question, another draft, a
    /// frame under way or a row that may be a hint shows nothing of it.
    #[test]
    fn a_draft_is_taken_once_the_input_reads_empty() {
        let row = |text: &str| InputLine {
            row: 1,
            start: 2,
            cells: text
                .chars()
                .map(|c| LineCell {
                    text: c.into(),
                    dim: false,
                    colored: true,
                })
                .collect(),
            rest: false,
            cut: false,
            cursor: (2, 1),
        };
        let shows = |state, line: Option<&str>, unsure| BoxReading {
            line: line.map(row),
            unsure,
            ..reading(state, None)
        };
        for (state, line, unsure, taken) in [
            (InputState::Usable, None, false, true),
            (InputState::Interaction, None, false, false),
            (InputState::Draft, Some("another"), false, false),
            (InputState::Unknown, None, false, false),
            (InputState::Unknown, Some("a hint"), true, false),
            (InputState::Unknown, Some("mine"), true, false),
        ] {
            let now = shows(state, line, unsure);
            assert_eq!(Submitting::is_taken(&now), taken, "{now:?}");
        }
    }

    /// A key goes on when it comes. One that came while the key before it waited keeps its pace.
    #[tokio::test(start_paused = true)]
    async fn keys_that_waited_keep_their_pace() {
        let start = Instant::now();
        let after = |ms| start + Duration::from_millis(ms);
        let mut person = PersonKeys::default();
        assert_eq!(person.due(start), start);
        person.goes_on(start);
        assert_eq!(person.due(after(1)), after(1));
        // Keys of 10, 30 and 400 ms wait until 500 ms.
        tokio::time::advance(Duration::from_millis(500)).await;
        person.goes_on(after(10));
        assert_eq!(person.due(after(30)), after(520));
        assert_eq!(person.due(after(400)), after(500) + ESCAPE_DELAY);
        assert_eq!(person.due(after(501)), after(501));
    }
}
