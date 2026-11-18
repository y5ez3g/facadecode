//! The keys taken by the public command line and the Rust MCP tools.

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
