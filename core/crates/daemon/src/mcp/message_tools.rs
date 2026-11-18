//! The message tools: `send_message` sends one message for the agent the server acts for, and
//! `read_messages` reads its inbox.

use std::io::Write;
use std::time::{Duration, Instant};

use facade_base::address::{
    MachineSelector, display_machine_selector, exact_machine_selector, parse_message_address,
};
use facade_base::daemon::{
    AgentSend, DeliveredVia, DeliveryFailure, DeliveryStatus, FACADE, Message, MessagesTopic,
    MessagesWatchArgs, SendArgs, SendResult, WindowDelivery, WindowRef, WindowsTopic,
    check_message_text, display_name,
};
use facade_base::daemon_client::{Cut, DaemonClient, cancel_line, upgrading};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{AgentRef, MachineIdentity, MessageRef};
use facade_base::operations::NoArgs;
use serde_json::{Map, Value, json};

use super::Relay;
use super::daemon_calls::{self, CONNECT_TIMEOUT, agent_failed, failed, machine_identities};
use super::envelope::{self, MAX_INLINE_CHARS};
use super::result_files::{self, ResultFile};
use super::schema::Problems;
use super::tool_calls::{ToolCall, optional, text};
use crate::HUMAN;

/// The time a send answers within, from its line's arrival (RULES-1.2).
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// Of a send's 30 seconds, what is kept for its answer's way back from Facade.
const ANSWER_GRACE: Duration = Duration::from_millis(500);

/// Refuses a message's text as Facade would before keeping it.
pub(super) fn check_send(arguments: &Map<String, Value>, problems: &mut Problems) {
    let text = arguments.get("text").and_then(Value::as_str);
    if let Some(Err(problem)) = text.map(check_message_text) {
        problems.add(problem);
    }
}

/// Refuses `after` and `last` together: each selects the messages itself.
pub(super) fn check_read(arguments: &Map<String, Value>, problems: &mut Problems) {
    if arguments.contains_key("after") && arguments.contains_key("last") {
        problems.add("give after or last, not both");
    }
}

/// What is left of a send's 30 seconds, counted from its line's arrival, less the half second kept
/// for its answer's way back; None where nothing is.
fn time_left(arrived: Instant) -> Option<Duration> {
    let used = arrived.elapsed() + ANSWER_GRACE;
    SEND_TIMEOUT
        .checked_sub(used)
        .filter(|left| !left.is_zero())
}

/// Sends a message for `agent` as `call`, and answers how its delivery ended.
///
/// It connects and hands the message over within the send's 30 seconds and gives Facade what is
/// left of them; with nothing left, it sends nothing and answers `timeout`. A send cut off by a newer
/// Facade taking over, or by a restart, goes again with the same request ID to the daemon that
/// answers next, and joins what the first did. Answers nothing where its client cancelled it before
/// it was written, or Facade withdrew the message for the cancellation, as it does where its paste
/// has not begun.
pub(super) fn send(
    relay: &Relay,
    agent: &str,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Option<Value> {
    let to = text(arguments, "to");
    let connect = || {
        let timeout = time_left(call.arrived)
            .unwrap_or_default()
            .min(CONNECT_TIMEOUT);
        daemon_calls::open(relay, &daemon_calls::as_agent(agent), timeout)
    };
    let send_args = |left: Option<Duration>| SendArgs {
        to: to.clone(),
        text: text(arguments, "text"),
        reply_to: optional(arguments, "reply_to"),
        reply_to_machine_id: None,
        request_id: Some(call.request_id.clone()),
        time_left_ms: left.map(|left| left.as_millis() as u64),
    };
    let connected = connect();
    // Tests hold a send here, before its daemon call.
    facade_base::service::gate_for_test("mcp-before-send");
    let mut client = match connected {
        Ok(client) => client,
        Err(failure) => return Some(failure),
    };
    let outcome = loop {
        let Some(left) = time_left(call.arrived) else {
            let message =
                "the send's 30 seconds ran out before Facade could take it; nothing was sent";
            return Some(envelope::failure("timeout", message));
        };
        let written = relay.sends.write(&call.key, &mut client, |client| {
            client.begin_call::<AgentSend>(send_args(Some(left)))
        })?;
        let sent = written.and_then(|id| client.result::<AgentSend>(id));
        let go_again = sent
            .as_ref()
            .is_err_and(|err| err.downcast_ref::<Cut>().is_some() || upgrading(err));
        if !go_again {
            break sent;
        }
        client = match connect() {
            Ok(client) => client,
            Err(_) => break sent,
        };
        // A cancellation after the cut went with the cut connection. The same request ID joins the
        // message the next daemon kept, and the cancellation follows it there.
        if relay.sends.cancelled(&call.key) {
            break withdraw(&mut client, send_args(time_left(call.arrived)));
        }
    };
    match outcome {
        Ok(sent) => Some(delivered(&mut client, &sent, call.arrived)),
        Err(err) if relay.sends.cancelled(&call.key) && was_cancelled(&err) => None,
        Err(err) => Some(agent_failed(
            &mut client,
            &err,
            &to,
            "whether the message was sent is not known: it may arrive",
            time_left(call.arrived),
        )),
    }
}

fn was_cancelled(err: &anyhow::Error) -> bool {
    err.downcast_ref::<ErrorBody>()
        .is_some_and(|error| error.data.reason == Reason::Cancelled)
}

/// Sends a message again by its request ID and cancels it at once on the same connection: the
/// daemon withdraws the message it kept where its paste has not begun, and otherwise answers what
/// became of it.
fn withdraw(client: &mut DaemonClient, args: SendArgs) -> anyhow::Result<SendResult> {
    let id = client.begin_call::<AgentSend>(args)?;
    client.writer.write_all(&cancel_line(id))?;
    client.result::<AgentSend>(id)
}

/// The stored message reference. The local inbox supplies the machine for its own records.
fn reference_to(message: &Message, local_machine_id: &str) -> MessageRef {
    message.message_ref.clone().unwrap_or_else(|| MessageRef {
        machine_id: local_machine_id.to_string(),
        message_id: message.message_id.clone(),
    })
}

/// The result of a send, with the message ID and the delivery information the daemon kept.
fn delivered(client: &mut DaemonClient, sent: &SendResult, arrived: Instant) -> Value {
    let message = &sent.message;
    let delivery = &message.delivery;
    let reference = reference_to(message, &client.hello_result.machine_id);
    let id = format!("#{}", reference.message_id);
    if message.to == HUMAN {
        return match window_receipt(
            &reference,
            delivery.status,
            sent.repeated,
            sent.windows.as_ref(),
        ) {
            Ok(windows) => delivered_to_windows(client, &reference, windows, arrived),
            Err(failure) => failure,
        };
    }
    let how = match (delivery.status, delivery.delivered_via) {
        (DeliveryStatus::Success, Some(DeliveredVia::Read)) => "read_by_recipient",
        (DeliveryStatus::Success, _) => "typed_into_input",
        // A guest takes its messages at its next turn: the send ends here.
        (DeliveryStatus::Pending, _) => "waiting_in_inbox",
        _ => {
            let mut words = delivery.failure_words(&format!("#{}", message.to));
            if sent.withdrawn {
                words += &format!(
                    "; it was withdrawn from #{}'s inbox, so it is safe to send it again later",
                    message.to
                );
            }
            let reason = serde_json::to_value(delivery.reason.unwrap_or(DeliveryFailure::Unknown))
                .ok()
                .and_then(|reason| reason.as_str().map(str::to_string))
                .unwrap_or_default();
            return envelope::failure(&reason, words);
        }
    };
    envelope::success(json!({
        "id": id, "address": reference.exact_address(), "delivery": how
    }))
}

/// A pending repeat can carry the original receipt with window outcomes still unknown.
fn window_receipt<'a>(
    reference: &MessageRef,
    status: DeliveryStatus,
    repeated: bool,
    windows: Option<&'a WindowDelivery>,
) -> Result<&'a WindowDelivery, Value> {
    let (reason, detail) = match (status, repeated, windows) {
        (DeliveryStatus::Pending, true, _) => {
            ("outcome_unknown", "Its window delivery outcome is unknown.")
        }
        (_, _, Some(windows)) => return Ok(windows),
        _ => (
            Reason::Internal.as_str(),
            "Its window delivery receipt is missing.",
        ),
    };
    let id = format!("#{}", reference.message_id);
    let mut result = envelope::failure(reason, format!("Facade kept {id}. {detail}"));
    result["data"] = json!({
        "id": id, "address": reference.exact_address(), "message_ref": reference
    });
    if let Some(windows) = windows {
        result["data"]["window_delivery"] = json!(windows);
    }
    Err(result)
}

/// Names the windows in the receipt using a snapshot from the daemon that answered the send.
fn delivered_to_windows(
    client: &mut DaemonClient,
    reference: &MessageRef,
    windows: &WindowDelivery,
    arrived: Instant,
) -> Value {
    // Name lookup stays within the send's time limit. The receipt already has the window IDs.
    let known = time_left(arrived)
        .and_then(|wait| {
            client.writer.set_read_timeout(Some(wait)).ok()?;
            client.writer.set_write_timeout(Some(wait)).ok()?;
            client.snapshot::<WindowsTopic>(NoArgs {}).ok()
        })
        .unwrap_or_default();
    let named = |window: &WindowRef| {
        let name = known
            .iter()
            .find(|listed| {
                listed.machine_id == window.machine_id && listed.window_id == window.window_id
            })
            .map(|listed| listed.label.as_str())
            .filter(|label| !label.is_empty())
            .unwrap_or(&window.window_id);
        json!({ "machine_id": window.machine_id, "window_id": window.window_id, "name": name })
    };
    let delivered: Vec<_> = windows.delivered.iter().map(named).collect();
    let not_delivered: Vec<_> = windows
        .not_delivered
        .iter()
        .map(|failure| json!({ "window": named(&failure.window), "reason": failure.reason }))
        .collect();
    let outcome_unknown: Vec<_> = windows.outcome_unknown.iter().map(named).collect();
    envelope::success(json!({
        "id": format!("#{}", reference.message_id),
        "address": reference.exact_address(),
        "delivery": "delivered_to_windows",
        "windows": {
            "delivered": delivered,
            "not_delivered": not_delivered,
            "outcome_unknown": outcome_unknown,
        },
    }))
}

fn sender_machine_id<'a>(message: &'a Message, local_machine_id: &'a str) -> &'a str {
    message
        .from_machine_id
        .as_deref()
        .or_else(|| {
            message
                .message_ref
                .as_ref()
                .map(|id| id.machine_id.as_str())
        })
        .unwrap_or(local_machine_id)
}

/// A message's copyable references and its sender's display label.
fn view_of(message: &Message, local_machine_id: &str, machines: &[MachineIdentity]) -> Value {
    let reference = reference_to(message, local_machine_id);
    let from_machine_id = sender_machine_id(message, local_machine_id);
    let (from_label, from_address) = match message.from.as_str() {
        FACADE => (FACADE.to_string(), FACADE.to_string()),
        HUMAN => ("#human".to_string(), "#human".to_string()),
        id => {
            let reference = AgentRef {
                machine_id: from_machine_id.to_string(),
                agent_id: id.to_string(),
            };
            let address = reference.exact_address();
            let selector = machines
                .iter()
                .find(|machine| machine.machine_id == from_machine_id)
                .map(|machine| display_machine_selector(machine, machines))
                .unwrap_or_else(|| exact_machine_selector(from_machine_id));
            let label = reference.label(local_machine_id, &selector);
            (label, address)
        }
    };
    let from = match &message.from_name {
        Some(name) => format!("@{} {from_label}", display_name(name)),
        None => from_label,
    };
    let mut view = json!({
        "id": format!("#{}", reference.message_id), "address": reference.exact_address(),
        "from": from, "from_address": from_address, "from_machine_id": from_machine_id,
        "at": message.at, "text": message.text,
    });
    if let Some(answered) = &message.reply_to {
        let replied = MessageRef {
            machine_id: message
                .reply_to_machine_id
                .as_deref()
                .unwrap_or(&reference.machine_id)
                .to_string(),
            message_id: answered.clone(),
        };
        view["reply_to"] = json!(replied.exact_address());
        view["reply_to_machine_id"] = json!(replied.machine_id);
    }
    view
}

/// The message number in `after`, which may carry this machine as its result gives it: #m4@id:….
fn inbox_position(client: &mut DaemonClient, after: &str) -> Result<String, ErrorBody> {
    let address = parse_message_address(after)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
    if let Some(selector) = address.machine {
        let here = client.hello_result.machine_id.clone();
        let local = match selector {
            MachineSelector::Name(_) => machine_identities(client, Some(CONNECT_TIMEOUT))
                .into_iter()
                .find(|machine| machine.machine_id == here),
            MachineSelector::IdPrefix(_) => Some(MachineIdentity {
                machine_id: here,
                name: String::new(),
            }),
        };
        if !local.is_some_and(|machine| selector.matches(&machine)) {
            return Err(ErrorBody::invalid_argument(format!(
                "{after} is on another machine; after takes a message of your inbox"
            )));
        }
    }
    Ok(address.message_id.to_string())
}

/// Reads the inbox of the agent the server acts for: the messages not yet delivered, which reading
/// delivers; every message after `after`; or the `last` newest. Messages longer together than a
/// result carries go to a JSON file.
pub(super) fn read(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let after = match optional(arguments, "after")
        .map(|after| inbox_position(client, &after))
        .transpose()
    {
        Ok(after) => after,
        Err(error) => return envelope::refusal(&error),
    };
    let last = arguments
        .get("last")
        .and_then(Value::as_u64)
        .and_then(|last| usize::try_from(last).ok());
    let selection = MessagesWatchArgs {
        ids: None,
        all: after.is_some() || last.is_some(),
        cursor: after,
        limit: None,
    };
    let mut messages = match client.snapshot::<MessagesTopic>(selection) {
        Ok(snapshot) => snapshot.messages,
        Err(err) => {
            return failed(
                &err,
                "messages it was returning may have been delivered: read them again with last",
            );
        }
    };
    if let Some(last) = last {
        let older = messages.len().saturating_sub(last);
        messages.drain(..older);
    }
    let machine_id = client.hello_result.machine_id.clone();
    let remote_sender = messages.iter().any(|message| {
        !matches!(message.from.as_str(), FACADE | HUMAN)
            && sender_machine_id(message, &machine_id) != machine_id
    });
    // The snapshot may have delivered these messages. If the lookup fails, show their IDs.
    let machines = if remote_sender {
        machine_identities(client, Some(CONNECT_TIMEOUT))
    } else {
        Vec::new()
    };
    let views: Vec<Value> = messages
        .iter()
        .map(|message| view_of(message, &machine_id, &machines))
        .collect();
    let length: usize = messages
        .iter()
        .map(|message| message.text.chars().count())
        .sum();
    if length > MAX_INLINE_CHARS
        && let Some(first) = messages.first()
    {
        let kind = ResultFile::Messages {
            first: &first.message_id,
        };
        if let Ok(path) = result_files::write(kind, &json!(views).to_string()) {
            return envelope::success(json!({ "file": path }));
        }
    }
    // Short enough, or their file could not be written: this read delivered them, so an answer too
    // long beats losing them.
    envelope::success(json!({ "messages": views }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_sender_uses_a_readable_label_and_its_full_address() {
        let local = "55e07e27-11ef-4b5c-ac23-74d587b3463b";
        let remote = "3f9a2c1d-0ad1-4bd3-a032-a6f7b4f89ac4";
        let message: Message = serde_json::from_value(json!({
            "message_id": "m42", "from": "a7", "from_name": "Ada",
            "from_machine_id": remote, "to": "a1", "text": "Ready",
            "at": "2026-11-17T00:00:00.000Z",
            "delivery": {"status": "pending", "text_written": "none"},
        }))
        .unwrap();
        let mut machines = vec![MachineIdentity {
            machine_id: remote.into(),
            name: "gpu".into(),
        }];
        assert_eq!(view_of(&message, local, &machines)["from"], "@Ada #a7@gpu");

        machines.push(MachineIdentity {
            machine_id: local.into(),
            name: "gpu".into(),
        });
        let view = view_of(&message, local, &machines);
        assert_eq!(view["from"], "@Ada #a7@id:3f9a2c1d");
        assert_eq!(
            view["from_address"],
            "#a7@id:3f9a2c1d0ad14bd3a032a6f7b4f89ac4"
        );
        assert_eq!(view["from_machine_id"], remote);
        assert_eq!(view_of(&message, remote, &machines)["from"], "@Ada #a7");
        assert_eq!(
            view_of(&message, local, &[])["from"],
            "@Ada #a7@id:3f9a2c1d0ad14bd3a032a6f7b4f89ac4"
        );
    }

    #[test]
    fn only_a_pending_repeat_reports_an_unknown_window_delivery_outcome() {
        let reference = MessageRef {
            machine_id: "00000000-0000-4000-8000-000000000001".into(),
            message_id: "m7".into(),
        };
        let data = json!({
            "id": "#m7", "address": "#m7@id:00000000000040008000000000000001",
            "message_ref": reference,
        });
        let receipt = WindowDelivery {
            delivered: Vec::new(),
            not_delivered: Vec::new(),
            outcome_unknown: vec![WindowRef {
                machine_id: reference.machine_id.clone(),
                window_id: "win-2".into(),
            }],
        };
        for windows in [None, Some(&receipt)] {
            let unknown =
                window_receipt(&reference, DeliveryStatus::Pending, true, windows).unwrap_err();
            let mut expected = data.clone();
            if let Some(windows) = windows {
                expected["window_delivery"] = json!(windows);
            }
            assert_eq!(
                unknown,
                json!({
                    "status": "failure",
                    "reason": "outcome_unknown",
                    "message": "Facade kept #m7. Its window delivery outcome is unknown.",
                    "data": expected,
                }),
            );
        }
        for (status, repeated) in [
            (DeliveryStatus::Success, false),
            (DeliveryStatus::Success, true),
            (DeliveryStatus::Pending, false),
        ] {
            assert_eq!(
                window_receipt(&reference, status, repeated, None).unwrap_err(),
                json!({
                    "status": "failure",
                    "reason": "internal",
                    "message": "Facade kept #m7. Its window delivery receipt is missing.",
                    "data": data,
                }),
            );
        }
    }
}
