//! Reads the host's colors before a foreground launch and consumes outstanding replies in Attach.

use std::borrow::Cow;
use std::io::{self, Write};
use std::time::{Duration, Instant};

use facade_base::console::{ConsoleRead, ConsoleReader};
use facade_base::start::LaunchColors;

use super::ConsoleLease;

const QUERIES: [&str; 19] = [
    "10;", "11;", "12;", "4;0;", "4;1;", "4;2;", "4;3;", "4;4;", "4;5;", "4;6;", "4;7;", "4;8;",
    "4;9;", "4;10;", "4;11;", "4;12;", "4;13;", "4;14;", "4;15;",
];
const RESPONSE_TIME: Duration = Duration::from_millis(100);
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
        let Ok(mut reader) = ConsoleReader::new() else {
            return Ok(Self::default());
        };
        let Ok(lease) = ConsoleLease::acquire() else {
            return Ok(Self::default());
        };
        {
            let mut out = io::stdout().lock();
            QUERIES
                .iter()
                .try_for_each(|query| write!(out, "\x1b]{query}?\x1b\\"))?;
            out.flush()?;
        }
        let mut probe = Self {
            lease: Some(lease),
            replies: Replies::awaiting_queries(),
            ..Self::default()
        };
        let deadline = Instant::now() + RESPONSE_TIME;
        let mut buf = [0; 4096];
        loop {
            match reader.read_until(&mut buf, deadline) {
                Ok(Some(ConsoleRead::Keys(n @ 1..))) => {
                    probe
                        .replies
                        .take_replies(&buf[..n], &mut probe.keys, Some(&mut probe.colors));
                    if !probe.replies.unanswered.contains(&true) {
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

    pub(super) fn take_lease(&mut self) -> Option<ConsoleLease> {
        self.lease.take()
    }

    /// Gives Attach its first keys and keeps any confirmed reply prefix for the next read.
    pub(super) fn into_input(mut self) -> (Option<ConsoleReader>, Vec<u8>, Replies) {
        self.replies.release_short_prefix(&mut self.keys);
        (self.reader, self.keys, self.replies)
    }
}

#[derive(Default)]
pub(super) struct Replies {
    unanswered: [bool; QUERIES.len()],
    pending: Vec<u8>,
}

impl Replies {
    fn awaiting_queries() -> Self {
        Self {
            unanswered: [true; QUERIES.len()],
            pending: Vec::new(),
        }
    }

    /// Filters one Attach read without changing the launch colors.
    pub(super) fn filter<'a>(&mut self, input: &'a [u8]) -> Cow<'a, [u8]> {
        if !self.unanswered.contains(&true) {
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
        while self.unanswered.contains(&true) {
            let Some(start) = bytes.iter().position(|&byte| byte == 0x1b) else {
                break;
            };
            keys.extend_from_slice(&bytes[..start]);
            bytes = &bytes[start..];
            match color_reply(bytes, &self.unanswered) {
                Reply::Partial => {
                    let consumed = self.pending.len() - bytes.len();
                    self.pending.drain(..consumed);
                    return;
                }
                Reply::Other => {
                    keys.push(bytes[0]);
                    bytes = &bytes[1..];
                }
                Reply::Complete { slot, value, len } => {
                    self.unanswered[slot] = false;
                    if let Some(colors) = colors.as_deref_mut() {
                        let color = rgb_color(value);
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

enum Reply<'a> {
    Partial,
    Other,
    Complete {
        slot: usize,
        value: &'a [u8],
        len: usize,
    },
}

fn color_reply<'a>(bytes: &'a [u8], unanswered: &[bool; QUERIES.len()]) -> Reply<'a> {
    let Some(tail) = bytes.strip_prefix(b"\x1b]") else {
        return if bytes == b"\x1b" {
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
    Reply::Complete {
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
    fn color_replies_can_arrive_in_pieces_between_keys() {
        let mut colors = LaunchColors::default();
        let mut replies = Replies::awaiting_queries();
        let mut keys = Vec::new();
        replies.take_replies(
            b"first\x1b]11;rgb:ffff/fafa/eeee\x1b",
            &mut keys,
            Some(&mut colors),
        );
        assert_eq!(colors.background, None);
        replies.take_replies(
            b"\\second\x1b]10;rgb:1/2/3\x07\x1b[A\x1b]12;rgb:00/11/22\x07last",
            &mut keys,
            Some(&mut colors),
        );
        assert_eq!(colors.background, Some([0xff, 0xfa, 0xee]));
        assert_eq!(colors.foreground, Some([0x11, 0x22, 0x33]));
        assert_eq!(colors.cursor, Some([0x00, 0x11, 0x22]));
        assert_eq!(keys, b"firstsecond\x1b[Alast");
    }
}
