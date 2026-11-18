//! The one envelope every tool answers with. A success is `{"status": "success"}`, with `data`
//! where the call has facts to give. A failure is `{"status": "failure", "reason", "message"}`,
//! whose message says what is wrong, whether anything was done and what to do next. The model reads
//! it as JSON text and gets the same object as the call's structured content.

use facade_base::daemon::{WindowDelivery, WindowDeliveryFailure};
use facade_base::jsonrpc::{ErrorBody, Reason};
use serde_json::{Value, json};

use super::addresses::Addresses;

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
    refusal_with_addresses(error, &Addresses::default())
}

pub(super) fn refusal_with_addresses(error: &ErrorBody, addresses: &Addresses<'_>) -> Value {
    let reason = match error.data.reason {
        Reason::Refused => "out_of_reach",
        Reason::Upgrading => "unavailable",
        other => other.as_str(),
    };
    let mut refused = failure(reason, error.message.clone());
    if let Value::Object(mut details) = json!(error.data) {
        details.remove("reason");
        if let Some(message) = &error.data.message_ref {
            let id = format!("#{}", message.message_id);
            details.remove("message_ref");
            details.insert(
                "address".into(),
                json!(addresses.qualified(&id, &message.machine_id)),
            );
            details.insert("id".into(), json!(id));
        }
        if let Some(windows) = &error.data.windows {
            details.insert("windows".into(), json!(window_failures(windows, addresses)));
        }
        if let Some(windows) = &error.data.window_delivery {
            details.insert(
                "window_delivery".into(),
                window_delivery(windows, addresses),
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

/// The receipt's existing groups, with each window represented by its address.
pub(super) fn window_delivery(windows: &WindowDelivery, addresses: &Addresses<'_>) -> Value {
    let delivered: Vec<_> = windows
        .delivered
        .iter()
        .map(|window| addresses.window(window))
        .collect();
    let outcome_unknown: Vec<_> = windows
        .outcome_unknown
        .iter()
        .map(|window| addresses.window(window))
        .collect();
    json!({
        "delivered": delivered,
        "not_delivered": window_failures(&windows.not_delivered, addresses),
        "outcome_unknown": outcome_unknown,
    })
}

fn window_failures(failures: &[WindowDeliveryFailure], addresses: &Addresses<'_>) -> Vec<Value> {
    failures
        .iter()
        .map(|failure| json!({ "window": addresses.window(&failure.window), "reason": failure.reason }))
        .collect()
}

#[cfg(test)]
mod tests {
    use facade_base::daemon::WindowRef;
    use facade_base::machine::{ExecutionOutcome, MessageRef, Unavailable};

    use super::*;

    #[test]
    fn refusals_keep_receipt_groups_with_window_addresses() {
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
        let refusal = refusal_with_addresses(&error, &addresses);
        assert_eq!(refusal["reason"], "unavailable");
        assert_eq!(
            refusal["data"],
            json!({
                "id": "#m7", "address": "#m7@id:00000000000040008000000000000001",
                "unavailable": {
                    "execution": "outcome_unknown", "window": "win-3@id:00000000000040008000000000000002",
                },
                "window_delivery": {
                    "delivered": [], "not_delivered": [{"window": "win-2", "reason": "not_watching"}],
                    "outcome_unknown": ["win-3@id:00000000000040008000000000000002"],
                },
            })
        );

        let mut error = ErrorBody::new(Reason::Unavailable, "no window took it");
        error.data.windows = Some(vec![WindowDeliveryFailure {
            window,
            reason: "window_disconnected".into(),
        }]);
        assert_eq!(
            refusal_with_addresses(&error, &addresses)["data"],
            json!({
                "windows": [{"window": "win-2", "reason": "window_disconnected"}],
            })
        );
    }

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
