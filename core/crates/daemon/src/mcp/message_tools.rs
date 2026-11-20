//! The message tools: `send_message` sends one message for the actor the server acts for, and the
//! checks of its arguments and of `read_messages`'.

use std::io::Write;
use std::time::{Duration, Instant};

use facade_base::daemon::{DeliveredVia, DeliveryFailure, DeliveryStatus, check_message_text};
use facade_base::daemon_client::{Cut, DaemonClient, cancel_line, upgrading};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{ExecutionOutcome, Unavailable};
use facade_base::operations::Operation;
use facade_base::v3::{self, AgentKind};
use serde_json::{Map, Value, json};

use super::daemon_calls::{self, CONNECT_TIMEOUT, failed};
use super::envelope;
use super::{ActorIdentity, Problems, Relay, ToolCall, optional, text};

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

/// Sends a message for `actor` as `call`, and answers how its delivery ended.
///
/// It connects and hands the message over within the send's 30 seconds and gives Facade what is
/// left of them. A send cut off by takeover or restart goes again with the same request ID. Until
/// the daemon confirms a receipt, an unresolved first attempt may still have sent the message.
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
                || (relay.verified.services.connect)(&actor.reference),
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
            allow_unsupported_receipt: false,
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
        None => return delivery_failed(&sent),
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

fn delivery_word(status: DeliveryStatus, via: Option<DeliveredVia>) -> Option<&'static str> {
    match (status, via) {
        (DeliveryStatus::Success, Some(DeliveredVia::ReadByRecipient)) => Some("read_by_recipient"),
        (DeliveryStatus::Success, _) => Some("typed_into_input"),
        (DeliveryStatus::Pending, _) => Some("waiting_in_inbox"),
        _ => None,
    }
}

fn delivery_failed(sent: &v3::SendResult) -> Value {
    let delivery = &sent.message.delivery;
    let to = &sent.message.to;
    let mut words = delivery.failure_words(to);
    if sent.withdrawn {
        words +=
            &format!("; it was withdrawn from {to}'s inbox, so it is safe to send it again later");
        if let Some(reference) = &sent.expected_reply_to {
            let message = &reference.message_id;
            words += &format!(
                ". The Guest was waiting for a reply to {message}. If this was a reply, send it \
                 again with reply_to: {message}."
            );
        }
    }
    let reason = serde_json::to_value(delivery.reason.unwrap_or(DeliveryFailure::Unknown))
        .ok()
        .and_then(|reason| reason.as_str().map(str::to_string))
        .unwrap_or_default();
    envelope::failure(&reason, words)
}
