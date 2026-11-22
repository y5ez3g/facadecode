//! Public key validation and shared terminal input encoding and sizing.

use std::fmt;

pub const MAX_KEYS: usize = 100;

pub const NAMED_KEYS: [&str; 15] = [
    "Enter",
    "Esc",
    "Tab",
    "Shift+Tab",
    "Backspace",
    "Delete",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Space",
];

const REPLACEMENTS: [(&str, &str); 6] = [
    ("Escape", "Esc"),
    ("Return", "Enter"),
    ("ArrowUp", "Up"),
    ("ArrowDown", "Down"),
    ("ArrowLeft", "Left"),
    ("ArrowRight", "Right"),
];

/// An invalid key count or spelling in one public input call.
#[derive(Debug)]
pub enum KeyProblem {
    Count(usize),
    Unknown {
        given: String,
        replacement: Option<&'static str>,
    },
}

impl fmt::Display for KeyProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Count(count) => write!(f, "expected 1 to {MAX_KEYS} keys, got {count}"),
            Self::Unknown { given, .. } => write!(f, "unknown key {given:?}"),
        }
    }
}

/// The problems with a batch, count first, then unknown keys in input order.
pub fn key_problems(keys: &[String]) -> impl Iterator<Item = KeyProblem> + '_ {
    let count_problem =
        (!(1..=MAX_KEYS).contains(&keys.len())).then_some(KeyProblem::Count(keys.len()));
    count_problem
        .into_iter()
        .chain(keys.iter().filter_map(|key| {
            if public_key(key) {
                return None;
            }
            let replacement = REPLACEMENTS
                .iter()
                .find(|(alias, _)| key.eq_ignore_ascii_case(alias))
                .map(|(_, name)| *name);
            Some(KeyProblem::Unknown {
                given: key.clone(),
                replacement,
            })
        }))
}

fn public_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    let control = bytes.len() == 6
        && bytes[..5].eq_ignore_ascii_case(b"ctrl+")
        && bytes[5].is_ascii_alphabetic();
    let mut characters = key.chars();
    let single = matches!(
        (characters.next(), characters.next()),
        (Some(character), None) if !character.is_control()
    );
    NAMED_KEYS.iter().any(|name| key.eq_ignore_ascii_case(name)) || control || single
}

/// The most bytes of input that may wait for an agent's terminal.
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;

/// The opening delimiter of a bracketed paste.
pub const PASTE_START: &[u8] = b"\x1b[200~";
/// The closing delimiter of a bracketed paste.
pub const PASTE_END: &[u8] = b"\x1b[201~";

/// Counts a paste's UTF-8 bytes and both bracketed-paste delimiters.
pub fn paste_bytes(text: &str) -> usize {
    text.len() + PASTE_START.len() + PASTE_END.len()
}

/// A key press encoded as terminal input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Character(char),
    Ctrl(u8),
    Space,
    Enter,
    Escape,
    Tab,
    ShiftTab,
    Backspace,
    Delete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
}

const KEY_NAMES: [(&str, Key); 21] = [
    ("Enter", Key::Enter),
    ("Return", Key::Enter),
    ("Escape", Key::Escape),
    ("Esc", Key::Escape),
    ("Tab", Key::Tab),
    ("Shift+Tab", Key::ShiftTab),
    ("Backspace", Key::Backspace),
    ("Delete", Key::Delete),
    ("Up", Key::Up),
    ("ArrowUp", Key::Up),
    ("Down", Key::Down),
    ("ArrowDown", Key::Down),
    ("Left", Key::Left),
    ("ArrowLeft", Key::Left),
    ("Right", Key::Right),
    ("ArrowRight", Key::Right),
    ("Home", Key::Home),
    ("End", Key::End),
    ("PageUp", Key::PageUp),
    ("PageDown", Key::PageDown),
    ("Space", Key::Space),
];

impl Key {
    /// Decodes a key name, including aliases accepted by the daemon.
    pub fn named(name: &str) -> Option<Self> {
        let standard = KEY_NAMES
            .iter()
            .position(|(known, _)| name.eq_ignore_ascii_case(known));
        if let Some(index) = standard {
            return Some(KEY_NAMES[index].1);
        }
        let letters = name.as_bytes();
        if letters.len() == 6
            && letters[..5].eq_ignore_ascii_case(b"ctrl+")
            && letters[5].is_ascii_alphabetic()
        {
            return Some(Self::Ctrl(letters[5].to_ascii_lowercase() - b'a' + 1));
        }
        let mut chars = name.chars();
        let character = chars.next()?;
        (chars.next().is_none() && !character.is_control()).then_some(Self::Character(character))
    }

    /// Appends terminal bytes using the requested cursor key mode.
    pub fn write(self, application: bool, bytes: &mut Vec<u8>) {
        let fixed: &[u8] = match self {
            Self::Character(c) => {
                bytes.extend(c.encode_utf8(&mut [0; 4]).as_bytes());
                return;
            }
            Self::Ctrl(value) => {
                bytes.push(value);
                return;
            }
            Self::Enter => b"\r",
            Self::Escape => b"\x1b",
            Self::Tab => b"\t",
            Self::Space => b" ",
            Self::Backspace => b"\x7f",
            Self::ShiftTab => b"\x1b[Z",
            Self::Delete => b"\x1b[3~",
            Self::PageUp => b"\x1b[5~",
            Self::PageDown => b"\x1b[6~",
            cursor => {
                let final_byte = match cursor {
                    Self::Up => b'A',
                    Self::Down => b'B',
                    Self::Right => b'C',
                    Self::Left => b'D',
                    Self::Home => b'H',
                    Self::End => b'F',
                    _ => unreachable!("cursor key"),
                };
                bytes.extend([0x1b, if application { b'O' } else { b'[' }, final_byte]);
                return;
            }
        };
        bytes.extend(fixed);
    }

    /// Counts the bytes in either cursor key mode.
    pub fn most_bytes(self) -> usize {
        let mut bytes = Vec::new();
        self.write(false, &mut bytes);
        bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn the_mcp_schema_advertises_the_public_keys_and_limit() {
        let tools: Vec<Value> = serde_json::from_str(crate::tools::DEFINITIONS).unwrap();
        let tool = tools
            .iter()
            .find(|tool| tool["name"] == "press_keys")
            .unwrap();
        let keys = &tool["inputSchema"]["properties"]["keys"];
        assert_eq!(keys["minItems"], 1);
        assert_eq!(keys["maxItems"], MAX_KEYS);
        assert!(
            tool["description"]
                .as_str()
                .unwrap()
                .contains(&NAMED_KEYS.join(", "))
        );
    }
}
