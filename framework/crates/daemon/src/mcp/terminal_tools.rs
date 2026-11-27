//! The checks of the terminal tools' arguments, and what a refused input answers. Text and keys go
//! in without draft protection: they can edit a draft or answer a menu.

use facade_base::api_v1::ErrorBody;
use facade_base::key_input::{KeyProblem, NAMED_KEYS, key_problems};
use facade_base::model::terminal::{CUT_MARK, first_control};
use serde_json::{Map, Value, json};

use super::{Problems, envelope};

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

/// What input that did not all go in answers: cut off partway, or refused with nothing typed.
pub(super) fn input_failure(error: &ErrorBody, agent: &str) -> Value {
    let mut refusal = envelope::daemon_refusal(error);
    if error.data.reason == "partial_input" {
        refusal["message"] = json!(format!(
            "{}; only part of the input reached {agent}; read its screen before typing again",
            error.message
        ));
    }
    refusal
}
