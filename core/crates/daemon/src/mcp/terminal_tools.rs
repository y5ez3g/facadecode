//! The terminal tools: `read_screen`, `type_text` and `press_keys`. Text and keys go in without
//! draft protection: they can edit a draft or answer a menu.

use facade_base::daemon::{AgentScreen, AgentType, CUT_MARK, ScreenArgs, TypeArgs, first_control};
use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::key_input::{KeyProblem, NAMED_KEYS, key_problems};
use facade_base::process::ProcessState;
use serde_json::{Map, Value, json};

use super::daemon_calls::{CONNECT_TIMEOUT, agent_failed};
use super::envelope::{self, MAX_INLINE_CHARS};
use super::result_files::{self, ResultFile};
use super::{Problems, text};

/// Refuses cut-off text and control characters before any text is typed.
pub(super) fn check_text(arguments: &Map<String, Value>, problems: &mut Problems) {
    let Some(text) = arguments.get("text").and_then(Value::as_str) else {
        return;
    };
    if text.starts_with(CUT_MARK) {
        problems.add(format!(
            "text starts with {CUT_MARK:?}: its beginning was cut on its way; type it in shorter \
             parts"
        ));
    } else if let Some(problem) = first_control(text) {
        problems.add(format!(
            "{problem}. Use press_keys with Esc or another key name"
        ));
    }
}

/// Refuses all problems in the key batch the schema read.
pub(super) fn check_keys(arguments: &Map<String, Value>, problems: &mut Problems) {
    if !arguments.contains_key("keys") {
        return;
    }
    for problem in key_problems(&key_strings(arguments)) {
        let words = match &problem {
            KeyProblem::Count(_) => problem.to_string(),
            KeyProblem::Unknown {
                replacement: Some(name),
                ..
            } => format!("{problem}. Use {name:?}"),
            KeyProblem::Unknown { .. } => format!(
                "{problem}. Use {}, Ctrl+A to Ctrl+Z or one non-control Unicode code point",
                NAMED_KEYS.join(", ")
            ),
        };
        problems.add(words);
    }
}

/// The keys argument's strings, in order.
fn key_strings(arguments: &Map<String, Value>) -> Vec<String> {
    let Some(keys) = arguments.get("keys").and_then(Value::as_array) else {
        return Vec::new();
    };
    keys.iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// Reads an agent's screen, its last lines as `lines` asks. A reading longer than a result carries
/// goes to a text file, which the result names in place of the text.
pub(super) fn read_screen(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let lines = arguments
        .get("lines")
        .and_then(Value::as_u64)
        .and_then(|lines| u16::try_from(lines).ok());
    let agent = text(arguments, "agent");
    let screen = match client.call::<AgentScreen>(ScreenArgs {
        agent: agent.clone(),
        lines,
    }) {
        Ok(screen) => screen,
        Err(err) => {
            return agent_failed(
                client,
                &err,
                &agent,
                "nothing was changed",
                Some(CONNECT_TIMEOUT),
            );
        }
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
                 {err:#}; set 'lines' to a smaller number"
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
        keys: Some(key_strings(arguments)),
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
        Some(error) if error.data.reason == Reason::PartialInput => {
            let mut refusal = envelope::refusal(error);
            refusal["message"] = json!(format!(
                "{}; only part of the input reached {agent}; read its screen before typing again",
                error.message
            ));
            refusal
        }
        _ => agent_failed(
            client,
            &err,
            &agent,
            &format!(
                "whether the input reached {agent} is not known; read its screen before typing again"
            ),
            Some(CONNECT_TIMEOUT),
        ),
    }
}
