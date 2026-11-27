//! Reads the host's terminal colors and grapheme cluster mode for Attach.

use std::borrow::Cow;
use std::io::{self, Write};
use std::time::{Duration, Instant};

use facade_base::console::{ConsoleRead, ConsoleReader};
use facade_base::start::LaunchColors;

use super::{ConsoleLease, escapes};

const NAMED_COLORS: usize = 3;
const QUERIES: [&str; 19] = [
    "10;", "11;", "12;", "4;0;", "4;1;", "4;2;", "4;3;", "4;4;", "4;5;", "4;6;", "4;7;", "4;8;",
    "4;9;", "4;10;", "4;11;", "4;12;", "4;13;", "4;14;", "4;15;",
];
const GRAPHEME_MODE_QUERY: &[u8] = b"\x1b[?2027$p";
/// Asks for the terminal's device attributes. Every terminal answers, and after the color replies,
/// so the answer ends the wait.
const LAST_QUERY: &[u8] = b"\x1b[c";
/// The longest a launch waits for the answers. A nearby terminal takes a few milliseconds and one
/// at the far end of an SSH connection a round trip.
const RESPONSE_TIME: Duration = Duration::from_secs(1);
const MAX_VALUE_LEN: usize = 64;

#[derive(Default)]
pub(crate) struct Probe {
    pub(crate) colors: LaunchColors,
    lease: Option<ConsoleLease>,
    reader: Option<ConsoleReader>,
    keys: Vec<u8>,
    replies: Replies,
}

impl Probe {
    pub(crate) fn read() -> io::Result<Self> {
        Self::read_queries(QUERIES.len(), crate::asks_colors())
    }

    /// Reads the host colors used for handback of an already running agent's attachment.
    pub(super) fn read_named() -> io::Result<Self> {
        Self::read_queries(NAMED_COLORS, true)
    }

    fn read_queries(count: usize, grapheme_mode: bool) -> io::Result<Self> {
        let Ok(mut reader) = ConsoleReader::new() else {
            return Ok(Self::default());
        };
        let Ok(lease) = ConsoleLease::acquire() else {
            return Ok(Self::default());
        };
        {
            let mut out = io::stdout().lock();
            QUERIES[..count]
                .iter()
                .try_for_each(|query| write!(out, "\x1b]{query}?\x1b\\"))?;
            if grapheme_mode {
                out.write_all(GRAPHEME_MODE_QUERY)?;
            }
            out.write_all(LAST_QUERY)?;
            out.flush()?;
        }
        let mut probe = Self {
            lease: Some(lease),
            replies: Replies::awaiting_queries(count, grapheme_mode),
            ..Self::default()
        };
        let deadline = Instant::now() + RESPONSE_TIME;
        let mut buf = [0; super::READ_BYTES];
        loop {
            match reader.read_until(&mut buf, deadline) {
                Ok(Some(ConsoleRead::Keys(n @ 1..))) => {
                    probe
                        .replies
                        .take_replies(&buf[..n], &mut probe.keys, Some(&mut probe.colors));
                    if !probe.replies.awaiting {
                        break;
                    }
                }
                Ok(Some(ConsoleRead::Keys(0)) | None) | Err(_) => break,
                Ok(Some(_)) => {}
            }
        }
        probe.reader = Some(reader);
        Ok(probe)
    }

    /// Reads the colors for a launch that leaves the console to the shell. What the person typed
    /// meanwhile goes back to the shell.
    pub(crate) fn read_colors() -> io::Result<LaunchColors> {
        let mut probe = Self::read_queries(QUERIES.len(), false)?;
        let lease = probe.lease.take();
        let colors = probe.colors;
        let (_, keys, _) = probe.into_input();
        drop(lease);
        facade_base::console::return_input(&keys);
        Ok(colors)
    }

    pub(super) fn take_lease(&mut self) -> Option<ConsoleLease> {
        self.lease.take()
    }

    pub(super) fn take_host_colors(&mut self) -> HostColors {
        HostColors {
            original: std::mem::take(&mut self.replies.named),
            ..HostColors::default()
        }
    }

    pub(super) fn host_grapheme_mode(&self) -> Option<bool> {
        self.replies.grapheme_mode
    }

    /// Gives Attach its first keys and keeps any confirmed reply prefix for the next read.
    pub(super) fn into_input(mut self) -> (Option<ConsoleReader>, Vec<u8>, Replies) {
        self.replies.release_short_prefix(&mut self.keys);
        (self.reader, self.keys, self.replies)
    }
}

#[derive(Default)]
pub(super) struct Replies {
    /// Whether an answer can still arrive: not after the answer to the last query.
    awaiting: bool,
    unanswered: [bool; QUERIES.len()],
    pending: Vec<u8>,
    grapheme_mode_pending: bool,
    grapheme_mode: Option<bool>,
    /// The host can report more than eight bits per channel.
    named: [Option<Vec<u8>>; NAMED_COLORS],
}

impl Replies {
    fn awaiting_queries(count: usize, grapheme_mode_pending: bool) -> Self {
        let mut replies = Self {
            awaiting: true,
            grapheme_mode_pending,
            ..Self::default()
        };
        replies.unanswered[..count].fill(true);
        replies
    }

    /// Filters one Attach read without changing the launch colors.
    pub(super) fn filter<'a>(&mut self, input: &'a [u8]) -> Cow<'a, [u8]> {
        if !self.awaiting {
            return Cow::Borrowed(input);
        }
        let mut keys = Vec::new();
        self.take_replies(input, &mut keys, None);
        self.release_short_prefix(&mut keys);
        Cow::Owned(keys)
    }

    fn release_short_prefix(&mut self, keys: &mut Vec<u8>) {
        if self.pending.len() < 3 {
            keys.append(&mut self.pending);
        }
    }

    fn take_replies(
        &mut self,
        input: &[u8],
        keys: &mut Vec<u8>,
        mut colors: Option<&mut LaunchColors>,
    ) {
        self.pending.extend_from_slice(input);
        let mut bytes = self.pending.as_slice();
        while self.awaiting {
            let Some(start) = bytes.iter().position(|&byte| byte == 0x1b) else {
                break;
            };
            keys.extend_from_slice(&bytes[..start]);
            bytes = &bytes[start..];
            match reply(bytes, &self.unanswered, self.grapheme_mode_pending) {
                Reply::Partial => {
                    let consumed = self.pending.len() - bytes.len();
                    self.pending.drain(..consumed);
                    return;
                }
                Reply::Other => {
                    keys.push(bytes[0]);
                    bytes = &bytes[1..];
                }
                Reply::Last { len } => {
                    self.awaiting = false;
                    bytes = &bytes[len..];
                }
                Reply::GraphemeMode { enabled, len } => {
                    self.grapheme_mode_pending = false;
                    self.grapheme_mode = enabled;
                    bytes = &bytes[len..];
                }
                Reply::Color { slot, value, len } => {
                    self.unanswered[slot] = false;
                    if let Some(colors) = colors.as_deref_mut() {
                        let color = rgb_color(value);
                        if slot < NAMED_COLORS && color.is_some() {
                            self.named[slot] = Some(value.to_vec());
                        }
                        match slot {
                            0 => colors.foreground = color,
                            1 => colors.background = color,
                            2 => colors.cursor = color,
                            _ => colors.ansi[slot - 3] = color,
                        }
                    }
                    bytes = &bytes[len..];
                }
            }
        }
        keys.extend_from_slice(bytes);
        self.pending.clear();
    }
}

#[derive(Default)]
pub(super) struct HostColors {
    original: [Option<Vec<u8>>; NAMED_COLORS],
    changed: [bool; NAMED_COLORS],
}

impl HostColors {
    /// Records the named colors that the CLI's forwarded OSC setters and resets can change.
    pub(super) fn observe_output(&mut self, bytes: &[u8]) {
        if self.original.iter().all(Option::is_none) {
            return;
        }
        for body in escapes(bytes).filter_map(|sequence| sequence.strip_prefix(b"]")) {
            let body = body.split(|&byte| byte == 0x07).next().unwrap_or_default();
            let mut fields = body.split(|&byte| byte == b';');
            let first = match fields.next() {
                Some([b'1', number @ b'0'..=b'2']) => usize::from(number - b'0'),
                Some([b'1', b'1', number @ b'0'..=b'2']) => {
                    self.changed[usize::from(number - b'0')] = true;
                    continue;
                }
                _ => continue,
            };
            for (changed, value) in self.changed[first..].iter_mut().zip(fields) {
                *changed |= !value.is_empty() && value != b"?";
            }
        }
    }

    pub(super) fn restore(&self, output: &mut Vec<u8>) {
        for ((query, original), changed) in QUERIES.iter().zip(&self.original).zip(self.changed) {
            if changed && let Some(value) = original {
                output.extend_from_slice(b"\x1b]");
                output.extend_from_slice(query.as_bytes());
                output.extend_from_slice(value);
                output.extend_from_slice(b"\x1b\\");
            }
        }
    }
}

enum Reply<'a> {
    Partial,
    Other,
    Color {
        slot: usize,
        value: &'a [u8],
        len: usize,
    },
    GraphemeMode {
        enabled: Option<bool>,
        len: usize,
    },
    /// The device attributes.
    Last {
        len: usize,
    },
}

fn reply<'a>(
    bytes: &'a [u8],
    unanswered: &[bool; QUERIES.len()],
    grapheme_mode_pending: bool,
) -> Reply<'a> {
    const MODE_REPORT: &[u8] = b"\x1b[?2027;";
    if grapheme_mode_pending {
        if MODE_REPORT.starts_with(bytes) {
            return Reply::Partial;
        }
        if let Some(status) = bytes.strip_prefix(MODE_REPORT) {
            match status {
                [b'0'..=b'4'] | [b'0'..=b'4', b'$'] => return Reply::Partial,
                [value @ b'0'..=b'4', b'$', b'y', ..] => {
                    return Reply::GraphemeMode {
                        enabled: match value {
                            b'1' => Some(true),
                            b'2' => Some(false),
                            _ => None,
                        },
                        len: MODE_REPORT.len() + 3,
                    };
                }
                _ => {}
            }
        }
    }
    if let Some(attributes) = bytes.strip_prefix(b"\x1b[?") {
        return match attributes
            .iter()
            .take(MAX_VALUE_LEN)
            .position(|byte| !(byte.is_ascii_digit() || *byte == b';'))
        {
            Some(end) if attributes[end] == b'c' => Reply::Last { len: 3 + end + 1 },
            None if attributes.len() < MAX_VALUE_LEN => Reply::Partial,
            _ => Reply::Other,
        };
    }
    let Some(tail) = bytes.strip_prefix(b"\x1b]") else {
        return if b"\x1b[?".starts_with(bytes) {
            Reply::Partial
        } else {
            Reply::Other
        };
    };
    for (slot, (query, &waiting)) in QUERIES.iter().zip(unanswered).enumerate() {
        if !waiting {
            continue;
        }
        let prefix = query.as_bytes();
        if let Some(value) = tail.strip_prefix(prefix) {
            return reply_value(value, slot, bytes.len() - value.len());
        }
        if prefix.starts_with(tail) {
            return Reply::Partial;
        }
    }
    Reply::Other
}

fn reply_value(value: &[u8], slot: usize, prefix_len: usize) -> Reply<'_> {
    let Some(end) = value
        .iter()
        .take(MAX_VALUE_LEN + 1)
        .position(|byte| !(b' '..=b'~').contains(byte))
    else {
        return if value.len() <= MAX_VALUE_LEN {
            Reply::Partial
        } else {
            Reply::Other
        };
    };
    let terminator = match &value[end..] {
        [0x1b] => return Reply::Partial,
        [0x07, ..] => 1,
        [0x1b, b'\\', ..] => 2,
        _ => return Reply::Other,
    };
    Reply::Color {
        slot,
        value: &value[..end],
        len: prefix_len + end + terminator,
    }
}

fn rgb_color(value: &[u8]) -> Option<[u8; 3]> {
    let rgb = std::str::from_utf8(value.strip_prefix(b"rgb:")?).ok()?;
    let mut components = rgb.split('/');
    let color = [
        component(components.next()?)?,
        component(components.next()?)?,
        component(components.next()?)?,
    ];
    components.next().is_none().then_some(color)
}

fn component(digits: &str) -> Option<u8> {
    if digits.is_empty() || digits.len() > 4 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(digits, 16).ok()?;
    let max = (1 << (digits.len() * 4)) - 1;
    Some(((value * 255 + max / 2) / max) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_split_grapheme_mode_report_preserves_other_keys() {
        for (status, expected) in [
            (b'0', None),
            (b'1', Some(true)),
            (b'2', Some(false)),
            (b'3', None),
            (b'4', None),
        ] {
            let mut replies = Replies::awaiting_queries(NAMED_COLORS, true);
            let mut keys = Vec::new();
            replies.take_replies(b"a\x1b[?2027;", &mut keys, None);
            replies.take_replies(&[status, b'$'], &mut keys, None);
            replies.take_replies(b"y\x1b[?1;2cb", &mut keys, None);
            assert_eq!(replies.grapheme_mode, expected);
            assert!(!replies.grapheme_mode_pending);
            assert!(!replies.awaiting);
            assert_eq!(keys, b"ab");
        }
    }

    #[test]
    fn color_replies_can_arrive_in_pieces_between_keys() {
        let mut colors = LaunchColors::default();
        let mut replies = Replies::awaiting_queries(QUERIES.len(), false);
        let mut keys = Vec::new();
        replies.take_replies(
            b"first\x1b]11;rgb:ffff/f54f/eeee\x1b",
            &mut keys,
            Some(&mut colors),
        );
        assert_eq!(colors.background, None);
        replies.take_replies(
            b"\\second\x1b]10;rgb:1/2/3\x07\x1b[A\x1b]12;rgb:00/11/22\x07last",
            &mut keys,
            Some(&mut colors),
        );
        assert_eq!(colors.background, Some([0xff, 0xf4, 0xee]));
        assert_eq!(
            replies.named[1].as_deref(),
            Some(&b"rgb:ffff/f54f/eeee"[..])
        );
        assert_eq!(colors.foreground, Some([0x11, 0x22, 0x33]));
        assert_eq!(colors.cursor, Some([0x00, 0x11, 0x22]));
        assert_eq!(keys, b"firstsecond\x1b[Alast");
    }

    #[test]
    fn the_device_attributes_end_the_wait() {
        let mut colors = LaunchColors::default();
        let mut replies = Replies::awaiting_queries(QUERIES.len(), false);
        let mut keys = Vec::new();
        replies.take_replies(
            b"ls\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?1",
            &mut keys,
            Some(&mut colors),
        );
        assert!(replies.awaiting);
        replies.take_replies(b";2c\x1b[?x", &mut keys, Some(&mut colors));
        assert!(!replies.awaiting);
        assert_eq!(colors.background, Some([0xff; 3]));
        assert_eq!(colors.foreground, None);
        assert_eq!(keys, b"ls\x1b[?x");
    }
}
