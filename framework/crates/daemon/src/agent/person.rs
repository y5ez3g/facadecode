//! The person's keys from an attached terminal. Their Enter may submit what the CLI's input holds,
//! which the agent's state says once the CLI takes it. Keys go into the terminal as they come, but
//! an Enter that may submit waits, with the keys after it, until the CLI drew what came before it,
//! so that the input can be read first.

use std::time::Duration;

use tokio::time::Instant;

use super::{MAX_INPUT_BYTES, PASTE_END, PASTE_START};

/// How long the screen stays quiet after the CLI drew the keys before a held Enter.
pub(super) const ENTER_DRAWN_AFTER: Duration = Duration::from_millis(30);
/// The longest an Enter is held.
const MAX_ENTER_HELD: Duration = Duration::from_millis(150);
/// How soon a held Enter looks again while the CLI keeps drawing.
pub(super) const ENTER_READ_AGAIN: Duration = Duration::from_millis(10);
/// How long the CLI may take to take what an Enter submitted.
const SUBMISSION_TAKEN_TIMEOUT: Duration = Duration::from_secs(4);

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

/// A focus notification alone does not take over from the startup probe.
pub(super) fn has_key(mut bytes: &[u8]) -> bool {
    while let Some(rest) = bytes
        .strip_prefix(b"\x1b[I")
        .or_else(|| bytes.strip_prefix(b"\x1b[O"))
    {
        bytes = rest;
    }
    !bytes.is_empty()
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
    /// The first bytes of a paste bracket the last keys ended in.
    partial: Vec<u8>,
    /// The paste under way, up to [`MAX_INPUT_BYTES`].
    paste: Vec<u8>,
    /// Pastes since the last Enter, at most [`MAX_INPUT_BYTES`] in all.
    pastes: Vec<String>,
}

impl PersonKeys {
    /// Reads `keys` to their end and returns their first Enter, if any.
    pub(super) fn enter(&mut self, keys: &[u8]) -> Option<Enter> {
        let carried = std::mem::take(&mut self.partial);
        let bytes = [carried.as_slice(), keys].concat();
        let mut found = None;
        let mut i = 0;
        while i < bytes.len() {
            let rest = &bytes[i..];
            if let Some(opens) = bracket(rest) {
                self.close_paste();
                self.pasting = opens;
                i += PASTE_START.len();
                continue;
            }
            if rest.len() < PASTE_START.len() && partial_bracket(rest) {
                self.partial = rest.to_vec();
                break;
            }
            let byte = rest[0];
            let after_escape = i > 0 && bytes[i - 1] == 0x1b;
            // Bytes carried over were seen with the last keys.
            if byte == b'\r' && !self.pasting && !after_escape && i >= carried.len() {
                found.get_or_insert_with(|| Enter {
                    at: i - carried.len(),
                    pastes: std::mem::take(&mut self.pastes),
                });
            }
            if self.pasting && self.paste.len() < MAX_INPUT_BYTES {
                self.paste.push(byte);
            }
            i += 1;
        }
        found
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

/// What the person's last Enter submits, while that is not known yet.
pub(super) enum Submitting {
    /// The Enter and the keys after it, held from the CLI until the input written passed
    /// `sent_through` and the CLI drew it, or until `release_at`.
    Held {
        keys: Vec<u8>,
        sent_through: u64,
        release_at: Instant,
        pastes: Vec<String>,
    },
    /// The Enter went over `draft`, said once the CLI takes it, by `until`.
    Sent { draft: String, until: Instant },
}

impl Submitting {
    /// Holds `keys`, an Enter and what follows it, after input that ends at `sent_through`.
    pub(super) fn held(keys: Vec<u8>, sent_through: u64, pastes: Vec<String>) -> Submitting {
        Submitting::Held {
            keys,
            sent_through,
            release_at: Instant::now() + max_enter_held(),
            pastes,
        }
    }

    /// The Enter went over `draft`.
    pub(super) fn sent(draft: String, now: Instant) -> Submitting {
        Submitting::Sent {
            draft,
            until: now + SUBMISSION_TAKEN_TIMEOUT,
        }
    }

    /// The bytes held from the terminal.
    pub(super) fn held_bytes(&self) -> usize {
        match self {
            Submitting::Held { keys, .. } => keys.len(),
            Submitting::Sent { .. } => 0,
        }
    }

    /// Lets a held Enter go now.
    pub(super) fn release_now(&mut self) {
        if let Submitting::Held { release_at, .. } = self {
            *release_at = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pastes_before_an_enter_go_with_it_within_the_input_limit() {
        let pasted = |text: &[u8]| [PASTE_START, text, PASTE_END].concat();
        let mut keys = PersonKeys::default();
        assert_eq!(
            keys.enter(&[pasted(b"one\rtwo"), b" and ".to_vec(), pasted(b"three")].concat()),
            None
        );
        let enter = keys.enter(b"!\r").expect("an Enter");
        assert_eq!(enter.at, 1);
        assert_eq!(enter.pastes, ["one\rtwo", "three"]);
        // A bracket split across reads is still a bracket, and a long paste keeps only its end.
        let big = vec![b'x'; MAX_INPUT_BYTES];
        let both = [pasted(b"small"), pasted(&big)].concat();
        let (first, second) = both.split_at(PASTE_START.len() + 2);
        assert_eq!(keys.enter(first), None);
        assert_eq!(keys.enter(second), None);
        let enter = keys.enter(b"\r").expect("an Enter");
        assert_eq!(enter.pastes.len(), 1);
        assert_eq!(enter.pastes[0].len(), MAX_INPUT_BYTES);
        // Alt+Enter is no Enter.
        assert_eq!(keys.enter(b"\x1b\r"), None);
    }
}
