//! The one envelope every tool answers with. A success is `{"status": "success"}`, with `data`
//! where the call has facts to give. A failure is `{"status": "failure", "reason", "message"}`,
//! whose message says what is wrong, whether anything was done and what to do next. The model reads
//! it as JSON text and gets the same object as the call's structured content.

use facade_base::api_v1;
use facade_base::model::error::{ErrorBody, Reason, SendFailure};
use facade_base::model::message::WindowDeliveryOutcome;
use serde::Serialize;
use serde_json::{Value, json};

use super::addresses::Addresses;

/// A success, carrying `data` where it holds anything.
pub(super) fn success(data: Value) -> Value {
    match data {
        Value::Object(fields) if !fields.is_empty() => {
            json!({ "status": "success", "data": fields })
        }
        _ => json!({ "status": "success" }),
    }
}

pub(super) fn encode(data: impl Serialize) -> Result<Value, ErrorBody> {
    serde_json::to_value(data)
        .map(success)
        .map_err(ErrorBody::internal)
}

/// A failure for `reason`, a short word, saying in `message` what went wrong, whether anything was
/// done, and what to do next.
pub(super) fn failure(reason: &str, message: impl Into<String>) -> Value {
    json!({ "status": "failure", "reason": reason, "message": message.into() })
}

/// The daemon's error with the public reason and structured details.
pub(super) fn refusal(error: &ErrorBody) -> Value {
    refusal_with_addresses(error, &Addresses::default())
}

pub(super) fn daemon_refusal(error: &api_v1::ErrorBody) -> Value {
    refusal(&tool_error(error))
}

/// Restores the details used by the MCP receipt from the daemon's error.
pub(super) fn tool_error(error: &api_v1::ErrorBody) -> ErrorBody {
    let mut data = error.data.details.clone().unwrap_or_default();
    for field in ["agents", "machines", "sessions", "available_clis"] {
        data.remove(field);
    }
    match error.data.reason.as_str() {
        "unavailable" if data.contains_key("execution") => {
            let fields = ["execution", "machine", "window", "matches", "unanswered"];
            let unavailable = fields
                .into_iter()
                .filter_map(|field| data.remove(field).map(|value| (field.to_string(), value)))
                .collect();
            data.insert("unavailable".into(), Value::Object(unavailable));
        }
        "machine_id_conflict" => {
            let conflict =
                json!({ "machine_id": data.remove("machine_id"), "paths": data.remove("paths") });
            data.insert("machine_id_conflict".into(), conflict);
        }
        "ssh_interaction_required" => {
            let interaction =
                json!({ "reason": data.remove("message"), "command": data.remove("command") });
            data.insert("ssh_interaction".into(), interaction);
        }
        _ => {}
    }
    data.insert("reason".into(), json!(error.data.reason));
    let mut projected = ErrorBody::new(
        serde_json::from_value(json!(error.data.reason)).unwrap_or(Reason::Unknown),
        &error.message,
    );
    if let Ok(details) = serde_json::from_value(Value::Object(data)) {
        projected.data = details;
    }
    projected.code = error.code;
    projected
}

fn refusal_with_addresses(error: &ErrorBody, addresses: &Addresses<'_>) -> Value {
    let SendFailure {
        error,
        window_delivery: outcomes,
    } = error.clone().into();
    let reason = error.data.reason.canonical_name();
    let mut refused = failure(reason, error.message.clone());
    if let Value::Object(mut details) = json!(error.data) {
        // The terminal's diagnostic rows belong to the daemon protocol.
        for field in ["reason", "agents", "machines", "sessions", "available_clis"] {
            details.remove(field);
        }
        if let Some(message) = &error.data.message_ref {
            let id = format!("#{}", message.message_id);
            details.remove("message_ref");
            details.insert(
                "address".into(),
                json!(addresses.qualified(&id, &message.machine_id)),
            );
            details.insert("id".into(), json!(id));
        }
        if let Some(outcomes) = outcomes {
            details.insert(
                "window_delivery".into(),
                window_delivery(&outcomes, addresses),
            );
        }
        if let Some(unavailable) = details.get_mut("unavailable")
            && let Some(window) = error
                .data
                .unavailable
                .as_ref()
                .and_then(|data| data.window.as_ref())
        {
            unavailable["window"] = json!(addresses.window(window));
        }
        if !details.is_empty() {
            refused["data"] = Value::Object(details);
        }
    }
    refused
}

/// Each attempted window's receipt uses a copyable address.
pub(super) fn window_delivery(
    outcomes: &[WindowDeliveryOutcome],
    addresses: &Addresses<'_>,
) -> Value {
    Value::Array(
        outcomes
            .iter()
            .map(|outcome| {
                let window = addresses.window(outcome.window());
                match outcome {
                    WindowDeliveryOutcome::Delivered { .. } => {
                        json!({ "window": window, "state": "delivered" })
                    }
                    WindowDeliveryOutcome::NotDelivered { reason, .. } => {
                        json!({ "window": window, "state": "not_delivered", "reason": reason })
                    }
                    WindowDeliveryOutcome::OutcomeUnknown { .. } => {
                        json!({ "window": window, "state": "outcome_unknown" })
                    }
                }
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use facade_base::model::error::Reason;
    use facade_base::model::machine::{ExecutionOutcome, Unavailable, WindowRef};
    use facade_base::model::message::{
        MessageRef, TextWritten, WindowDelivery, WindowDeliveryFailure,
    };

    use super::*;

    #[test]
    fn refusals_project_each_window_delivery_state() {
        let here = "00000000-0000-4000-8000-000000000001";
        let remote = "00000000-0000-4000-8000-000000000002";
        let addresses = Addresses {
            here,
            machines: &[],
        };
        let window = WindowRef {
            machine_id: here.into(),
            window_id: "win-2".into(),
        };
        let unknown = WindowRef {
            machine_id: remote.into(),
            window_id: "win-3".into(),
        };
        let mut error = ErrorBody::new(Reason::Unavailable, "the receipt was lost");
        error.data.message_ref = Some(MessageRef {
            machine_id: here.into(),
            message_id: "m7".into(),
        });
        error.data.unavailable = Some(Unavailable {
            execution: ExecutionOutcome::OutcomeUnknown,
            machine: None,
            window: Some(unknown.clone()),
            matches: Vec::new(),
            unanswered: Vec::new(),
        });
        error.data.window_delivery = Some(WindowDelivery {
            delivered: Vec::new(),
            not_delivered: vec![WindowDeliveryFailure {
                window: window.clone(),
                reason: "not_watching".into(),
            }],
            outcome_unknown: vec![unknown],
        });
        assert_eq!(ErrorBody::from(SendFailure::from(error.clone())), error);
        let refusal = refusal_with_addresses(&error, &addresses);
        assert_eq!(refusal["reason"], "unavailable");
        assert_eq!(
            refusal["data"],
            json!({
                "id": "#m7", "address": "#m7@id:00000000000040008000000000000001",
                "unavailable": {
                    "execution": "outcome_unknown", "window": "win-3@id:00000000000040008000000000000002",
                },
                "window_delivery": [
                    {"window": "win-2", "state": "not_delivered", "reason": "not_watching"},
                    {"window": "win-3@id:00000000000040008000000000000002", "state": "outcome_unknown"},
                ],
            })
        );

        let mut error = ErrorBody::new(Reason::Unavailable, "no window took it");
        error.data.windows = Some(vec![WindowDeliveryFailure {
            window,
            reason: "window_disconnected".into(),
        }]);
        assert_eq!(ErrorBody::from(SendFailure::from(error.clone())), error);
        assert_eq!(
            refusal_with_addresses(&error, &addresses)["data"],
            json!({
                "window_delivery": [
                    {"window": "win-2", "state": "not_delivered", "reason": "window_disconnected"},
                ],
            })
        );
        error.data.windows = Some(Vec::new());
        assert_eq!(
            refusal_with_addresses(&error, &addresses)["data"],
            json!({ "window_delivery": [] }),
        );
    }

    /// The envelope carries data only when the tool has facts to report.
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
    }

    #[test]
    fn daemon_refusals_keep_their_canonical_reason_and_details() {
        for (reason, name) in [
            (Reason::InvalidSettings, "invalid_settings"),
            (Reason::CallerUnavailable, "caller_unavailable"),
            (Reason::IncompatibleProtocol, "incompatible_protocol"),
            (Reason::Refused, "refused"),
            (Reason::Upgrading, "upgrading"),
            (Reason::NotFound, "not_found"),
            (Reason::InvalidArgument, "invalid_argument"),
        ] {
            let error = ErrorBody::new(reason, "the call could not go ahead");
            assert_eq!(refusal(&error), failure(name, error.message));
        }
        let mut partial = ErrorBody::new(Reason::PartialInput, "the run ended during input");
        partial.data.text_written = Some(TextWritten::Partial);
        partial.data.enter_written = Some(false);
        let reply = refusal(&partial);
        assert_eq!(reply["reason"], "partial_input", "{reply}");
        assert_eq!(
            reply["data"],
            json!({ "text_written": "partial", "enter_written": false })
        );
    }
}
