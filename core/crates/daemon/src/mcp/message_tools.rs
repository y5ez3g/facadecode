//! The message tools: `send_message` sends one message for the agent the server acts for, and
//! `read_messages` reads its inbox.

use std::io::Write;
use std::time::{Duration, Instant};

use facade_base::address::{MachineSelector, parse_message_address};
use facade_base::daemon::{
    AgentSend, AgentSendArgs, DeliveredVia, DeliveryFailure, DeliveryStatus, FACADE, Message,
    MessagesTopic, MessagesWatchArgs, SendOutcome, WindowDeliveryOutcome, check_message_text,
};
use facade_base::daemon_client::{Cut, DaemonClient, cancel_line, upgrading};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{ExecutionOutcome, MachineIdentity, MessageRef, Unavailable};
use facade_base::operations::Operation;
use facade_base::v3::{self, AgentKind};
use serde_json::{Map, Value, json};

use super::addresses::Addresses;
use super::daemon_calls::{self, CONNECT_TIMEOUT, agent_failed, failed, machine_identities};
use super::envelope::{self, MAX_INLINE_CHARS};
use super::result_files::{self, ResultFile};
use super::{ActorIdentity, Problems, Relay, ToolCall, optional, text};
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
/// left of them. A send cut off by takeover or restart goes again with the same request ID. Until
/// the daemon confirms a receipt, an unresolved first attempt may still have sent the message.
pub(super) fn send(
    relay: &Relay,
    agent: &str,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Option<Value> {
    let to = text(arguments, "to");
    send_over::<AgentSend>(
        relay,
        call,
        |timeout| daemon_calls::open(relay, &daemon_calls::as_agent(agent), timeout),
        |left| AgentSendArgs {
            to: to.clone(),
            text: text(arguments, "text"),
            reply_to: optional(arguments, "reply_to"),
            reply_to_machine_id: None,
            request_id: Some(call.request_id.clone()),
            time_left_ms: left.map(|left| left.as_millis() as u64),
        },
        |sent, client| delivered(&sent.into(), &client.hello_result.machine_id),
        |err, client| {
            agent_failed(
                client,
                err,
                &to,
                "whether the message was sent is not known: it may arrive",
                time_left(call.arrived),
            )
        },
    )
}

pub(super) fn send_verified(
    relay: &Relay,
    actor: &ActorIdentity,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Option<Value> {
    send_over::<v3::AgentSend>(
        relay,
        call,
        |timeout| {
            daemon_calls::open_with(
                || (relay.verified().services.connect)(&actor.reference),
                timeout,
            )
        },
        |left| v3::AgentSendArgs {
            to: text(arguments, "to"),
            text: text(arguments, "text"),
            reply_to: optional(arguments, "reply_to"),
            reply_to_machine_id: None,
            request_id: Some(call.request_id.clone()),
            time_left_ms: left.map(|left| left.as_millis() as u64),
        },
        |sent, _| delivered_verified(sent, actor.kind),
        |err, _| {
            failed(
                err,
                "whether the message was sent is not known: it may arrive",
            )
        },
    )
}

fn send_over<O: Operation>(
    relay: &Relay,
    call: &ToolCall,
    open: impl Fn(Duration) -> Result<DaemonClient, Value>,
    send_args: impl Fn(Option<Duration>) -> O::Args,
    receipt: impl FnOnce(O::Result, &mut DaemonClient) -> Value,
    failure: impl FnOnce(&anyhow::Error, &mut DaemonClient) -> Value,
) -> Option<Value> {
    let connect = || {
        let timeout = time_left(call.arrived)
            .unwrap_or_default()
            .min(CONNECT_TIMEOUT);
        open(timeout)
    };
    let connected = connect();
    // Tests hold a send here, before its daemon call.
    facade_base::service::gate_for_test("mcp-before-send");
    let mut client = match connected {
        Ok(client) => client,
        Err(failure) => return Some(failure),
    };
    let mut outcome_unknown = false;
    let outcome = loop {
        let Some(left) = time_left(call.arrived) else {
            if outcome_unknown {
                return Some(send_unconfirmed());
            }
            let message =
                "the send's 30 seconds ran out before Facade could take it; nothing was sent";
            return Some(envelope::failure("timeout", message));
        };
        let Some(written) = relay.sends.write(&call.key, &mut client, |client| {
            client.begin_call::<O>(send_args(Some(left)))
        }) else {
            return outcome_unknown.then(send_unconfirmed);
        };
        let sent = written.and_then(|id| client.result::<O>(id));
        let cut = sent.as_ref().is_err_and(|err| err.is::<Cut>());
        if !cut && !sent.as_ref().is_err_and(upgrading) {
            break sent;
        }
        outcome_unknown |= cut;
        client = match connect() {
            Ok(client) => client,
            Err(_) => break sent,
        };
        // A cancellation after the cut went with the cut connection. The same request ID joins the
        // message the next daemon kept, and the cancellation follows it there.
        if relay.sends.cancelled(&call.key) {
            let Some(left) = time_left(call.arrived) else {
                return outcome_unknown.then(send_unconfirmed);
            };
            break withdraw::<O>(&mut client, send_args(Some(left)));
        }
    };
    match outcome {
        Ok(sent) => Some(receipt(sent, &mut client)),
        Err(err) if relay.sends.cancelled(&call.key) && was_cancelled(&err) => None,
        Err(_) if outcome_unknown => Some(send_unconfirmed()),
        Err(err) => Some(failure(&err, &mut client)),
    }
}

fn send_unconfirmed() -> Value {
    let mut error = ErrorBody::new(
        Reason::Unavailable,
        "the original send's delivery outcome is unknown",
    );
    error.data.unavailable = Some(Unavailable {
        execution: ExecutionOutcome::OutcomeUnknown,
        machine: None,
        window: None,
        matches: Vec::new(),
        unanswered: Vec::new(),
    });
    envelope::refusal(&error)
}

fn was_cancelled(err: &anyhow::Error) -> bool {
    err.downcast_ref::<ErrorBody>()
        .is_some_and(|error| error.data.reason == Reason::Cancelled)
}

/// Sends a message again by its request ID and cancels it at once on the same connection: the
/// daemon withdraws the message it kept where its paste has not begun, and otherwise answers what
/// became of it.
fn withdraw<O: Operation>(client: &mut DaemonClient, args: O::Args) -> anyhow::Result<O::Result> {
    let id = client.begin_call::<O>(args)?;
    client.writer.write_all(&cancel_line(id))?;
    client.result::<O>(id)
}

fn delivered_verified(sent: v3::SendResult, sender: AgentKind) -> Value {
    let delivery = &sent.message.delivery;
    let how = match delivery_word(delivery.status, delivery.delivered_via) {
        Some(how) => how,
        None => return delivery_failed(delivery, &sent.message.to, sent.withdrawn),
    };
    let mut data = json!({ "id": sent.id, "delivery": how });
    if sender == AgentKind::Guest {
        data["next"] = json!({
            "tool": "read_messages",
            "arguments": { "wait": true, "reply_to": sent.id },
        });
    }
    envelope::success(data)
}

/// The stored message reference. The local inbox supplies the machine for its own records.
fn reference_to(message: &Message, local_machine_id: &str) -> MessageRef {
    message.message_ref.clone().unwrap_or_else(|| MessageRef {
        machine_id: local_machine_id.to_string(),
        message_id: message.message_id.clone(),
    })
}

/// The result of a send, with the message ID and the delivery information the daemon kept.
fn delivered(sent: &SendOutcome, local_machine: &str) -> Value {
    let message = &sent.message;
    let delivery = &message.delivery;
    let reference = reference_to(message, local_machine);
    let id = format!("#{}", reference.message_id);
    let addresses = Addresses {
        here: local_machine,
        machines: &[],
    };
    let address = addresses.qualified(&id, &reference.machine_id);
    if message.to == HUMAN {
        return match window_receipt(
            &reference,
            delivery.status,
            sent.repeated,
            sent.window_delivery.as_deref(),
            &addresses,
        ) {
            Ok(windows) => envelope::success(json!({
                "id": id, "address": address, "delivery": "delivered_to_windows",
                "window_delivery": envelope::window_delivery(windows, &addresses),
            })),
            Err(failure) => failure,
        };
    }
    let how = match delivery_word(delivery.status, delivery.delivered_via) {
        Some(how) => how,
        None => return delivery_failed(delivery, &format!("#{}", message.to), sent.withdrawn),
    };
    envelope::success(json!({
        "id": id, "address": address, "delivery": how
    }))
}

fn delivery_word(status: DeliveryStatus, via: Option<DeliveredVia>) -> Option<&'static str> {
    match (status, via) {
        (DeliveryStatus::Success, Some(DeliveredVia::ReadByRecipient)) => Some("read_by_recipient"),
        (DeliveryStatus::Success, _) => Some("typed_into_input"),
        (DeliveryStatus::Pending, _) => Some("waiting_in_inbox"),
        _ => None,
    }
}

fn delivery_failed(delivery: &facade_base::daemon::Delivery, to: &str, withdrawn: bool) -> Value {
    let mut words = delivery.failure_words(to);
    if withdrawn {
        words +=
            &format!("; it was withdrawn from {to}'s inbox, so it is safe to send it again later");
    }
    let reason = serde_json::to_value(delivery.reason.unwrap_or(DeliveryFailure::Unknown))
        .ok()
        .and_then(|reason| reason.as_str().map(str::to_string))
        .unwrap_or_default();
    envelope::failure(&reason, words)
}

/// A pending repeat can carry the original receipt with window outcomes still unknown.
fn window_receipt<'a>(
    reference: &MessageRef,
    status: DeliveryStatus,
    repeated: bool,
    windows: Option<&'a [WindowDeliveryOutcome]>,
    addresses: &Addresses<'_>,
) -> Result<&'a [WindowDeliveryOutcome], Value> {
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
        "id": id, "address": addresses.qualified(&id, &reference.machine_id),
    });
    if let Some(windows) = windows {
        result["data"]["window_delivery"] = envelope::window_delivery(windows, addresses);
    }
    Err(result)
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

/// A message and its copyable sender and reply references.
fn view_of(message: &Message, addresses: &Addresses<'_>) -> Value {
    let reference = reference_to(message, addresses.here);
    let id = format!("#{}", reference.message_id);
    let from = match message.from.as_str() {
        FACADE => FACADE.to_string(),
        HUMAN => "#human".to_string(),
        id => addresses.role(
            &format!("#{id}"),
            sender_machine_id(message, addresses.here),
        ),
    };
    let mut view = json!({
        "id": id, "address": addresses.qualified(&id, &reference.machine_id),
        "from": from, "at": message.at, "text": message.text,
    });
    if let Some(answered) = &message.reply_to {
        let machine_id = message
            .reply_to_machine_id
            .as_deref()
            .unwrap_or(&reference.machine_id);
        view["reply_to"] = json!(addresses.role(&format!("#{answered}"), machine_id));
    }
    view
}

/// The message number in `after`, which may carry this machine as its result gives it: #m4@id:….
fn inbox_position(
    client: &mut DaemonClient,
    after: &str,
    machines: &mut Option<Vec<MachineIdentity>>,
) -> Result<String, ErrorBody> {
    let address = parse_message_address(after)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
    if let Some(selector) = address.machine {
        let here = client.hello_result.machine_id.clone();
        let local = match selector {
            MachineSelector::Name(_) => machines
                .get_or_insert_with(|| machine_identities(client, Some(CONNECT_TIMEOUT)))
                .iter()
                .find(|machine| machine.machine_id == here)
                .cloned(),
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

/// Reads the inbox of the agent the server acts for, a page of at most 100: the messages not yet
/// delivered; the messages after `after`; or the `last` newest. Facade delivers only the messages
/// it returns. `next_cursor`, where more follow, is the `after` that reads them. Messages longer
/// together than a result carries go to a JSON file.
pub(super) fn read(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let mut machines = None;
    let after = match optional(arguments, "after")
        .map(|after| inbox_position(client, &after, &mut machines))
        .transpose()
    {
        Ok(after) => after,
        Err(error) => return envelope::refusal(&error),
    };
    let last = arguments
        .get("last")
        .and_then(Value::as_u64)
        .and_then(|last| u16::try_from(last).ok());
    let selection = MessagesWatchArgs {
        ids: None,
        all: after.is_some() || last.is_some(),
        cursor: after,
        limit: None,
        last,
    };
    let snapshot = match client.snapshot::<MessagesTopic>(selection) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            return failed(
                &err,
                "messages it was returning may have been delivered: read them again with last",
            );
        }
    };
    let messages = &snapshot.messages;
    let machine_id = client.hello_result.machine_id.clone();
    let remote_sender = messages.iter().any(|message| {
        !matches!(message.from.as_str(), FACADE | HUMAN)
            && sender_machine_id(message, &machine_id) != machine_id
    });
    // The snapshot may have delivered these messages. If the lookup fails, show their IDs.
    let machines = machines.unwrap_or_else(|| {
        if remote_sender {
            machine_identities(client, Some(CONNECT_TIMEOUT))
        } else {
            Vec::new()
        }
    });
    let addresses = Addresses {
        here: &machine_id,
        machines: &machines,
    };
    let views: Vec<Value> = messages
        .iter()
        .map(|message| view_of(message, &addresses))
        .collect();
    let length: usize = messages
        .iter()
        .map(|message| message.text.chars().count())
        .sum();
    let mut result = json!({ "messages": views });
    if length > MAX_INLINE_CHARS
        && let Some(first) = messages.first()
    {
        let kind = ResultFile::Messages {
            first: &first.message_id,
        };
        // Where their file cannot be written they go inline: this read delivered them, so an
        // answer too long beats losing them.
        if let Ok(path) = result_files::write(kind, &json!(views).to_string()) {
            result = json!({ "file": path });
        }
    }
    if let Some(next) = &snapshot.next_cursor {
        result["next_cursor"] = json!(format!("#{next}"));
    }
    envelope::success(result)
}

#[cfg(test)]
mod tests {
    use facade_base::daemon::{MessagesSnapshot, WindowRef};

    use super::*;

    #[test]
    fn message_roles_use_unique_names_then_prefixes_or_exact_ids() {
        let local = "55e07e27-11ef-4b5c-ac23-74d587b3463b";
        let remote = "3f9a2c1d-0ad1-4bd3-a032-a6f7b4f89ac4";
        let message: Message = serde_json::from_value(json!({
            "message_id": "m42", "from": "a7", "from_name": "Ada",
            "from_machine_id": remote, "to": "a1", "text": "Ready",
            "reply_to": "m3", "reply_to_machine_id": remote,
            "at": "2026-11-17T00:00:00.000Z",
            "delivery": {"status": "pending", "text_written": "none"},
        }))
        .unwrap();
        let mut machines = vec![MachineIdentity {
            machine_id: remote.into(),
            name: "gpu".into(),
        }];
        let snapshot = MessagesSnapshot {
            messages: vec![message],
            ..MessagesSnapshot::default()
        };
        let view = |here: &str, machines: &[MachineIdentity]| {
            let (count, result) = super::super::project_inbox(&snapshot, here, machines).unwrap();
            assert_eq!(count, 1);
            result["data"]["messages"][0].clone()
        };
        let named = view(local, &machines);
        assert_eq!(named["from"], "a7@gpu");
        assert_eq!(named["reply_to"], "m3@gpu");
        assert!(named.get("from_address").is_none());
        assert!(named.get("from_machine_id").is_none());
        assert!(named.get("reply_to_machine_id").is_none());

        machines.extend([
            MachineIdentity {
                machine_id: local.into(),
                name: "gpu".into(),
            },
            MachineIdentity {
                machine_id: "3f9a2c1d-1ad1-4bd3-a032-a6f7b4f89ac4".into(),
                name: "a-saved-peer".into(),
            },
        ]);
        let duplicate = view(local, &machines);
        assert_eq!(duplicate["from"], format!("a7@{remote}"));
        assert_eq!(duplicate["reply_to"], format!("m3@{remote}"));
        let same_machine = view(remote, &machines);
        assert_eq!(same_machine["from"], format!("a7@{remote}"));
        assert_eq!(same_machine["reply_to"], "m3");

        let exact = view(local, &[]);
        assert_eq!(exact["from"], "a7@3f9a2c1d");
        assert_eq!(exact["reply_to"], "m3@3f9a2c1d");
        assert_eq!(exact["id"], "m42");
        assert_eq!(exact["text"], "Ready");
    }

    #[test]
    fn only_a_pending_repeat_reports_an_unknown_window_delivery_outcome() {
        let reference = MessageRef {
            machine_id: "00000000-0000-4000-8000-000000000001".into(),
            message_id: "m7".into(),
        };
        let data = json!({
            "id": "#m7", "address": "#m7@id:00000000000040008000000000000001",
        });
        let addresses = Addresses {
            here: &reference.machine_id,
            machines: &[],
        };
        let receipt = [WindowDeliveryOutcome::OutcomeUnknown {
            window: WindowRef {
                machine_id: reference.machine_id.clone(),
                window_id: "win-2".into(),
            },
        }];
        for windows in [None, Some(receipt.as_slice())] {
            let unknown = window_receipt(
                &reference,
                DeliveryStatus::Pending,
                true,
                windows,
                &addresses,
            )
            .unwrap_err();
            let mut expected = data.clone();
            if windows.is_some() {
                expected["window_delivery"] =
                    json!([{"window": "win-2", "state": "outcome_unknown"}]);
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
                window_receipt(&reference, status, repeated, None, &addresses).unwrap_err(),
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
