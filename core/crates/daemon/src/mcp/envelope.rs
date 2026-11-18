//! The one envelope every tool answers with. A success is `{"status": "success"}`, with `data`
//! where the call has facts to give. A failure is `{"status": "failure", "reason", "message"}`,
//! whose message says what is wrong, whether anything was done and what to do next. The model reads
//! it as JSON text and gets the same object as the call's structured content.

use facade_base::jsonrpc::{ErrorBody, Reason};
use serde_json::{Value, json};

/// The most characters a result carries inline. Longer messages, screens or lists go to a file.
pub(super) const MAX_INLINE_CHARS: usize = 8000;

/// A success, carrying `data` where it holds anything.
pub(super) fn success(data: Value) -> Value {
    match data {
        Value::Object(fields) if !fields.is_empty() => {
            json!({ "status": "success", "data": fields })
        }
        _ => json!({ "status": "success" }),
    }
}

/// A failure for `reason`, a short word, saying in `message` what went wrong, whether anything was
/// done, and what to do next.
pub(super) fn failure(reason: &str, message: impl Into<String>) -> Value {
    json!({ "status": "failure", "reason": reason, "message": message.into() })
}

/// The daemon's error and structured details. The tools name an agent out of the caller's
/// reach `out_of_reach`, and a daemon handing over to a newer build `unavailable`.
pub(super) fn refusal(error: &ErrorBody) -> Value {
    let reason = match error.data.reason {
        Reason::Refused => "out_of_reach",
        Reason::Upgrading => "unavailable",
        other => other.as_str(),
    };
    let mut refused = failure(reason, error.message.clone());
    if let Value::Object(mut details) = json!(error.data) {
        details.remove("reason");
        if !details.is_empty() {
            refused["data"] = Value::Object(details);
        }
    }
    refused
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A success carries data only where it has some; a failure, its reason and message alone; an
    /// agent out of reach is `out_of_reach`.
    #[test]
    fn the_envelope_holds_status_and_data_or_reason_and_message() {
        assert_eq!(success(json!({})), json!({ "status": "success" }));
        assert_eq!(
            success(json!({ "id": "#m3" })),
            json!({ "status": "success", "data": { "id": "#m3" } })
        );
        assert_eq!(
            serde_json::to_string(&failure("not_found", "no agent #a9")).unwrap(),
            r#"{"status":"failure","reason":"not_found","message":"no agent #a9"}"#
        );
        assert_eq!(
            refusal(&ErrorBody::new(Reason::Refused, "#a2 is out of your reach"))["reason"],
            "out_of_reach"
        );
    }
}
