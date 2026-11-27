//! Terminal sizes, screen and input state, and text presentation.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

/// The default number of lines returned by `agent.screen`.
pub const DEFAULT_SCREEN_LINES: u16 = 50;
/// The maximum number of lines returned by `agent.screen`.
pub const MAX_SCREEN_LINES: u16 = 2000;

/// How Antigravity marks a long argument it cut to its last 8,000 characters before passing it on.
pub const CUT_MARK: &str = "[Earlier output truncated]";

/// The colors an editor window's terminals draw with, each `#rrggbb`. An agent of the window
/// replies to its CLI's OSC 10, 11 and 12 queries with them; a color left out gets no reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TerminalColors {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Says where `text` first has a control character other than a tab or a line break, which typed
/// text and messages refuse: `text contains the control character U+001B at character 3; text takes
/// printable characters, tabs, and line breaks`. Each caller adds its own advice.
pub fn first_control(text: &str) -> Option<String> {
    let (at, control) = text
        .chars()
        .enumerate()
        .find(|(_, c)| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))?;
    Some(format!(
        "text contains the control character U+{:04X} at character {}; text takes printable \
         characters, tabs, and line breaks",
        control as u32,
        at + 1
    ))
}

/// The most characters an agent's name takes where Facade Code Framework shows it.
const NAME_CHARS: usize = 120;

/// Untrusted text as one line to show (CLIS-2.3): invisible formatting removed, control characters
/// and runs of white space as one space, trimmed, and at most `most` characters, the last an
/// ellipsis where it was cut between whole graphemes.
pub fn display_line(text: &str, most: usize) -> String {
    let invisible = |c: char| {
        matches!(
            c,
            '\u{200b}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}' | '\u{feff}'
        )
    };
    let spaced: String = text
        .chars()
        .filter(|&c| !invisible(c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let line = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= most {
        return line;
    }
    let (mut kept, mut end) = (0, 0);
    for (at, grapheme) in line.grapheme_indices(true) {
        kept += grapheme.chars().count();
        if kept >= most {
            break;
        }
        end = at + grapheme.len();
    }
    format!("{}…", line[..end].trim_end())
}

/// An agent's name as Facade Code Framework shows it: one line of at most 120 characters. The name itself stays as
/// given.
pub fn display_name(name: &str) -> String {
    display_line(name, NAME_CHARS)
}

/// The screen buffer a CLI shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScreenBuffer {
    /// The normal screen, with scrollback.
    Normal,
    /// The alternate screen, which a full-screen view draws on. It has no scrollback.
    Alternate,
    /// A buffer this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// The text of [`ScreenText::text`] without its marks and escapes: the screen's text as it shows.
pub fn plain(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => plain.extend(chars.next()),
            // The screen's own brackets and braces are escaped, so these are marks, each two of a
            // kind.
            '[' | ']' | '{' | '}' => drop(chars.next()),
            c => plain.push(c),
        }
    }
    plain
}

/// How an agent's message input reads on its screen. A reading never means input may be typed.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InputState {
    /// The CLI's input is drawn empty.
    Usable,
    /// The CLI's input holds text, typed, pasted, or recalled.
    Draft,
    /// A menu or question of the CLI's own is drawn in place of its input.
    Interaction,
    /// The screen does not show the input as the CLI's rule describes it.
    Unknown,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

impl InputState {
    pub fn as_str(self) -> &'static str {
        match self {
            InputState::Usable => "usable",
            InputState::Draft => "draft",
            InputState::Interaction => "interaction",
            InputState::Unknown => "unknown",
            InputState::Unrecognized => "unrecognized",
        }
    }
}

/// The layout a CLI's rule reads its input from.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InputMechanism {
    /// A prompt row inside a frame of two rules.
    Frame,
    /// A prompt row above a model line at the bottom of the screen.
    Prompt,
    /// An editor between two rules, with a cursor the CLI draws.
    Editor,
    /// A box of bar rows above a border.
    Box,
    /// The last row that starts with the prompt.
    PromptRow,
    /// A layout this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl InputMechanism {
    pub fn as_str(self) -> &'static str {
        match self {
            InputMechanism::Frame => "frame",
            InputMechanism::Prompt => "prompt",
            InputMechanism::Editor => "editor",
            InputMechanism::Box => "box",
            InputMechanism::PromptRow => "prompt_row",
            InputMechanism::Unknown => "unknown",
        }
    }
}

/// Rows of a draft scrolled out of the CLI's input, as the CLI marks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HiddenRows {
    /// Rows hidden above the visible input, or 1 where the CLI marks hidden rows without counting them.
    pub above: u32,
    /// Rows hidden below the visible input, or 1 where the CLI marks hidden rows without counting them.
    pub below: u32,
}

/// An agent's message input as its screen shows it now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InputInfo {
    pub state: InputState,
    /// What on the screen the state rests on, such as `the input frame at row 22 is empty`. Never
    /// the draft's text.
    pub evidence: String,
    /// The layout the agent's CLI rule reads. Omitted without a rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mechanism: Option<InputMechanism>,
    /// Draft rows scrolled out of the input. Omitted unless the CLI marks such rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<HiddenRows>,
}

/// The size, in columns and rows, of a terminal started where no terminal gives one: without a
/// terminal of the caller's, or for a guest, which has none of Facade Code Framework's.
pub const DEFAULT_TERMINAL_SIZE: (u16, u16) = (120, 30);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Untrusted text shows as one line: invisible formatting removed, controls and runs of white
    /// space as one space, trimmed, and cut between whole graphemes with an ellipsis. A name shows
    /// that way in at most 120 characters.
    #[test]
    fn untrusted_text_shows_as_one_line_cut_between_whole_graphemes() {
        assert_eq!(display_line("\u{202e}a\tb\r\n\u{feff} c ", 10), "a b c");
        assert_eq!(display_line("abcdef", 4), "abc…");
        assert_eq!(
            display_line("ab   cdef", 4),
            "ab…",
            "no space before the ellipsis"
        );
        assert_eq!(display_line("👍🏽xy", 3), "👍🏽…");
        assert_eq!(display_line("👍🏽x", 2), "…", "never half a grapheme");
        assert_eq!(
            display_name("evil\u{1b}[201~\r\nINJECTED"),
            "evil [201~ INJECTED"
        );
        assert_eq!(
            display_name(&"n".repeat(121)),
            format!("{}…", "n".repeat(119))
        );
    }

    #[test]
    fn input_reads_unknown_as_a_state_of_its_own_and_a_state_this_build_does_not_know_as_unrecognized()
     {
        assert_eq!(
            serde_json::to_value(InputState::Unknown).unwrap(),
            json!("unknown")
        );
        assert_eq!(
            serde_json::from_value::<InputState>(json!("unknown")).unwrap(),
            InputState::Unknown
        );
        assert_eq!(
            serde_json::from_value::<InputState>(json!("typing")).unwrap(),
            InputState::Unrecognized
        );
        let schema = serde_json::to_value(schemars::schema_for!(InputState))
            .unwrap()
            .to_string();
        assert!(
            schema.contains("\"unknown\"") && !schema.contains("unrecognized"),
            "{schema}"
        );
        assert_eq!(
            serde_json::from_value::<InputMechanism>(json!("prompt_row")).unwrap(),
            InputMechanism::PromptRow
        );
        assert_eq!(
            serde_json::from_value::<InputMechanism>(json!("canvas")).unwrap(),
            InputMechanism::Unknown
        );
        let input = InputInfo {
            state: InputState::Unknown,
            evidence: "the agent ended".into(),
            mechanism: None,
            hidden: None,
        };
        assert_eq!(
            serde_json::to_value(&input).unwrap(),
            json!({ "state": "unknown", "evidence": "the agent ended" }),
            "absent values are left out"
        );
    }

    #[test]
    fn plain_screen_text_drops_the_marks_and_keeps_what_the_screen_shows() {
        assert_eq!(
            plain("plain [[picked]] {{hint}} [[{{both}}]]\n\\[a\\] \\{b\\} \\\\c\n[[ ]]"),
            "plain picked hint both\n[a] {b} \\c\n "
        );
        assert_eq!(plain(""), "");
    }
}
