//! What the agent tools share beyond their daemon calls: the checks of a `start_agent` call, and the
//! failure a refused start answers.

use facade_base::api_v1;
use facade_base::daemon::check_message_text;
use facade_base::jsonrpc::Reason;
use serde_json::{Map, Value, json};

use super::{Problems, envelope};

/// Refuses a start's prompt as Facade refuses a message's text, and a model or an effort that is
/// blank: a start leaves either out for its CLI's own.
pub(super) fn check_start(arguments: &Map<String, Value>, problems: &mut Problems) {
    for field in ["model", "effort"] {
        let blank = arguments
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| value.chars().all(facade_base::settings::is_space));
        if blank {
            problems.add(format!(
                "{field} must not be blank; leave it out for the CLI's own"
            ));
        }
    }
    let prompt = arguments.get("prompt").and_then(Value::as_str);
    if let Some(Err(problem)) = prompt.map(check_message_text) {
        problems.add(problem);
    }
}

/// A start the daemon refused, saying where a worktree it made stays.
pub(super) fn start_daemon_refused(error: &api_v1::ErrorBody) -> Value {
    let mut tool_error = envelope::tool_error(error);
    if error.data.reason == "invalid_argument"
        && error
            .data
            .details
            .as_ref()
            .is_some_and(|details| details.contains_key("available_clis"))
    {
        tool_error.data.reason = Reason::NotFound;
    }
    let mut refused = envelope::refusal(&tool_error);
    if let Some(unavailable) = &tool_error.data.unavailable {
        refused["data"]["execution"] = json!(unavailable.execution);
    }
    let kept_worktree = tool_error
        .data
        .kept
        .as_ref()
        .and_then(|kept| kept.path.as_deref());
    if let Some(folder) = kept_worktree {
        if let Some(kept) = refused["data"]["kept"].as_object_mut() {
            kept.remove("path");
            kept.insert("folder".to_string(), json!(folder));
        }
        refused["message"] = json!(format!(
            "{}; the worktree it made stays at {folder}",
            error.message
        ));
    }
    refused
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_failure_names_the_folder_of_its_kept_worktree() {
        let error = serde_json::from_value(json!({
            "code": -32000,
            "message": "Git failed",
            "data": {
                "reason": "worktree_failed",
                "details": { "kept": { "branch": "review", "path": "/work/review" } },
            },
        }))
        .unwrap();
        let refused = start_daemon_refused(&error);
        assert_eq!(refused["reason"], "worktree_failed");
        assert_eq!(
            refused["data"]["kept"],
            json!({ "branch": "review", "folder": "/work/review" })
        );
        assert_eq!(
            refused["message"],
            "Git failed; the worktree it made stays at /work/review"
        );
        assert_eq!(error.data.details.unwrap()["kept"]["path"], "/work/review");
    }

    #[test]
    fn a_start_reports_a_daemon_not_found_as_not_found() {
        let error = serde_json::from_value(json!({
            "code": -32000,
            "message": "the agent this start acts for is no longer listed",
            "data": { "reason": "not_found" },
        }))
        .unwrap();
        let refused = start_daemon_refused(&error);
        assert_eq!(refused["reason"], "not_found", "{refused}");
        assert_eq!(refused["message"], error.message, "{refused}");
    }
}
