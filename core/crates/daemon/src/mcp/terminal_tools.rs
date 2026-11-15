//! The terminal tools: `read_screen`, `type_text` and `press_keys`. Text and keys go in without
//! draft protection: they can edit a draft or answer a menu.

use facade_base::daemon::{AgentScreen, AgentType, CUT_MARK, ScreenArgs, TypeArgs};
use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::process::ProcessState;
use serde_json::{Map, Value, json};

use super::daemon_calls::failed;
use super::envelope::{self, MAX_INLINE_CHARS};
use super::result_files::{self, ResultFile};
use super::schema::Problems;
use super::tool_calls::text;

/// The keys `press_keys` takes by name, in lower case, besides Ctrl+A to Ctrl+Z and any one
/// printable character.
const NAMED_KEYS: [&str; 15] = [
    "enter",
    "escape",
    "tab",
    "shift+tab",
    "backspace",
    "delete",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
    "space",
];

/// Refuses text whose beginning a CLI cut off on its way, before any of it is typed.
pub(super) fn check_text(arguments: &Map<String, Value>, problems: &mut Problems) {
    let cut = arguments
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.starts_with(CUT_MARK));
    if cut {
        problems.add(format!(
            "text starts with {CUT_MARK:?}: its beginning was cut on its way; type it in shorter \
             parts"
        ));
    }
}

/// Whether `press_keys` takes `key`: a named key, Ctrl and a letter, or one printable character.
/// A key the daemon knows by another name, such as Return for Enter, is not taken.
fn is_known_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if NAMED_KEYS.contains(&lower.as_str()) {
        return true;
    }
    if let Some(letter) = lower.strip_prefix("ctrl+") {
        return letter.len() == 1 && letter.as_bytes()[0].is_ascii_lowercase();
    }
    let mut characters = key.chars();
    matches!(
        (characters.next(), characters.next()),
        (Some(character), None) if !character.is_control()
    )
}

/// Refuses each key `press_keys` does not take.
pub(super) fn check_keys(arguments: &Map<String, Value>, problems: &mut Problems) {
    for key in keys(arguments).iter().filter(|key| !is_known_key(key)) {
        problems.add(format!(
            "unknown key {key:?}; the keys are Enter, Escape, Tab, Shift+Tab, Backspace, Delete, \
             Up, Down, Left, Right, Home, End, PageUp, PageDown, Space, Ctrl+A to Ctrl+Z, and any \
             one printable character"
        ));
    }
}

/// The keys argument's strings, in order.
fn keys(arguments: &Map<String, Value>) -> Vec<String> {
    let Some(keys) = arguments.get("keys").and_then(Value::as_array) else {
        return Vec::new();
    };
    keys.iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// Reads an agent's screen, its last lines as `last` asks. A reading longer than a result carries
/// goes to a text file, which the result names in place of the text.
pub(super) fn read_screen(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let lines = arguments
        .get("last")
        .and_then(Value::as_u64)
        .and_then(|last| u16::try_from(last).ok());
    let agent = text(arguments, "agent");
    let screen = match client.call::<AgentScreen>(ScreenArgs { agent, lines }) {
        Ok(screen) => screen,
        Err(err) => return failed(&err, "nothing was changed"),
    };
    let ended = screen.process == ProcessState::Ended;
    if screen.text.chars().count() <= MAX_INLINE_CHARS {
        return envelope::success(json!({ "ended": ended, "text": screen.text }));
    }
    match result_files::write(ResultFile::Screen, &screen.text) {
        Ok(path) => envelope::success(json!({ "ended": ended, "file": path })),
        Err(err) => envelope::failure(
            "unavailable",
            format!(
                "the screen is too long to return here, and its file could not be written: \
                 {err:#}; read fewer lines with last"
            ),
        ),
    }
}

/// Types text, then Enter where asked, and answers once all of it reached the terminal.
pub(super) fn type_text(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let input = TypeArgs {
        agent: text(arguments, "agent"),
        raw: None,
        text: Some(text(arguments, "text")),
        enter: arguments.get("enter") == Some(&Value::Bool(true)),
        keys: None,
    };
    type_into(client, input)
}

/// Presses keys in order and answers once all of them reached the terminal.
pub(super) fn press_keys(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let input = TypeArgs {
        agent: text(arguments, "agent"),
        raw: None,
        text: None,
        enter: false,
        keys: Some(keys(arguments)),
    };
    type_into(client, input)
}

/// Writes `input` into its agent's terminal. Input that did not all go in was cut off partway, or
/// refused with nothing typed.
fn type_into(client: &mut DaemonClient, input: TypeArgs) -> Value {
    let agent = input.agent.clone();
    let err = match client.call::<AgentType>(input) {
        Ok(_) => return envelope::success(json!({})),
        Err(err) => err,
    };
    match err.downcast_ref::<ErrorBody>() {
        Some(error) if error.data.reason == Reason::PartialInput => envelope::failure(
            "partial_input",
            format!(
                "{}; only part of the input reached {agent}; read its screen before typing again",
                error.message
            ),
        ),
        _ => failed(
            &err,
            &format!(
                "whether the input reached {agent} is not known; read its screen before typing again"
            ),
        ),
    }
}
