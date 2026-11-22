//! The message tools: `send_message` sends one message for the actor the server acts for, and the
//! checks of its arguments and of `read_messages`'.

use std::io::Write;
use std::time::{Duration, Instant};

use facade_base::address::selector;
use facade_base::api_v1;
use facade_base::api_v1::daemon::{
    AgentSend, AgentTarget, ReplyTo, SendArgs, SendResult, SendWait, cancel_line,
};
use facade_base::api_v1::daemon_client::{Cut, DaemonClient, upgrading};
use facade_base::model::agent::AgentRef;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::machine::{ExecutionOutcome, Unavailable};
use facade_base::model::message::{
    DeliveredVia, DeliveryFailure, DeliveryStatus, MessageRef, check_message_text,
};
use serde_json::{Map, Value, json};

use super::daemon_calls::{self, CONNECT_TIMEOUT, failed};
use super::envelope;
use super::{ActorIdentity, Problems, Relay, ToolCall, optional, text};
use crate::messages::{RESPONSE_GRACE, ReplyRead};

/// The ordinary send budget when the caller asks only for inbox acceptance.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// Time kept for the daemon's delivery receipt to reach the relay.
const ANSWER_GRACE: Duration = Duration::from_millis(500);

/// Refuses a message's text as Facade would before keeping it.
pub(super) fn check_send(arguments: &Map<String, Value>, problems: &mut Problems) {
    let text = arguments.get("text").and_then(Value::as_str);
    if let Some(Err(problem)) = text.map(check_message_text) {
        problems.add(problem);
    }
    match arguments.get("wait_for").and_then(Value::as_str) {
        Some("delivery" | "result") => {}
        Some(_) => problems.add("wait_for must be delivery or result"),
        None if timeout_seconds(arguments) > 0 => {
            problems.add("a positive timeout_seconds requires wait_for")
        }
        None => {}
    }
}

/// Refuses `after` and `last` together: each selects the messages itself.
pub(super) fn check_read(arguments: &Map<String, Value>, problems: &mut Problems) {
    if arguments.contains_key("after") && arguments.contains_key("last") {
        problems.add("give after or last, not both");
    }
}

fn timeout_seconds(arguments: &Map<String, Value>) -> u64 {
    arguments
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

/// Keeps the same deadline and business request ID through reconnect and reply selection.
pub(super) fn send_verified(
    relay: &Relay,
    actor: &ActorIdentity,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Option<Value> {
    let seconds = timeout_seconds(arguments);
    let (wait_for, budget) = match (seconds, arguments.get("wait_for").and_then(Value::as_str)) {
        (0, _) => (SendWait::Inbox, SEND_TIMEOUT),
        (_, Some("delivery")) => (SendWait::Delivery, Duration::from_secs(seconds)),
        (_, Some("result")) => (SendWait::Result, Duration::from_secs(seconds)),
        _ => unreachable!("validated send wait"),
    };
    // Delivery may spend another settlement grace before the receipt can travel back.
    let answer_grace = match wait_for {
        SendWait::Inbox => ANSWER_GRACE,
        SendWait::Delivery | SendWait::Result => ANSWER_GRACE + RESPONSE_GRACE,
    };
    let deadline = call.arrived + budget;
    let time_left = || deadline.saturating_duration_since(Instant::now());
    let send_args = |left: Duration| SendArgs {
        to: AgentTarget::Selector(text(arguments, "to")),
        text: text(arguments, "text"),
        reply_to: optional(arguments, "reply_to").map(ReplyTo::Address),
        request_id: Some(call.request_id.clone()),
        time_left_ms: Some(left.saturating_sub(answer_grace).as_millis() as u64),
        wait_for: Some(wait_for),
        allow_unsupported_receipt: false,
    };
    let connect = || {
        daemon_calls::open_with(
            || (relay.verified.services.connect)(&actor.reference),
            time_left().min(CONNECT_TIMEOUT),
        )
    };
    if time_left() <= answer_grace {
        return Some(send_before_deadline(budget));
    }
    let mut client = match connect() {
        Ok(client) => client,
        Err(failure) => return Some(failure),
    };
    // Tests hold a send here, before its daemon call.
    facade_base::service::gate_for_test("mcp-before-send");
    let mut outcome_unknown = false;
    let outcome = loop {
        if time_left() <= answer_grace {
            return Some(if outcome_unknown {
                send_unconfirmed()
            } else {
                send_before_deadline(budget)
            });
        }
        let Some(written) = relay.sends.write(&call.key, &mut client, |client| {
            let left = time_left();
            if left <= answer_grace {
                return Err(std::io::Error::from(std::io::ErrorKind::TimedOut).into());
            }
            client.writer.set_write_timeout(Some(left))?;
            client.begin_call::<AgentSend>(send_args(left))
        }) else {
            return outcome_unknown.then(send_unconfirmed);
        };
        let sent = written.and_then(|id| receive(&mut client, id, deadline));
        let cut = sent.as_ref().is_err_and(|err| err.is::<Cut>());
        if !cut && !sent.as_ref().is_err_and(upgrading) {
            break sent;
        }
        outcome_unknown |= cut;
        if time_left() <= answer_grace {
            break sent;
        }
        client = match connect() {
            Ok(client) => client,
            Err(_) => break sent,
        };
        // A cancellation after the cut went with the cut connection. The same request ID joins the
        // message the next daemon kept, and the cancellation follows it there.
        if relay.sends.cancelled(&call.key) {
            let left = time_left();
            if left <= answer_grace {
                return outcome_unknown.then(send_unconfirmed);
            }
            break withdraw(&mut client, send_args(left), deadline);
        }
    };
    match outcome {
        Ok(sent) => Some(sent_result(
            relay, actor, call, sent, wait_for, deadline, seconds,
        )),
        Err(err) if relay.sends.cancelled(&call.key) && was_cancelled(&err) => None,
        Err(err) => Some(send_failure(&err, outcome_unknown)),
    }
}

fn send_before_deadline(budget: Duration) -> Value {
    envelope::failure(
        "timeout",
        format!(
            "the send's {} seconds ran out before Facade could take it; nothing was sent",
            budget.as_secs()
        ),
    )
}

fn receive(client: &mut DaemonClient, id: u64, deadline: Instant) -> anyhow::Result<SendResult> {
    // A cancellable send needs the request ID between its write and its response.
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(Cut.into());
    }
    client.writer.set_read_timeout(Some(left))?;
    client.result::<AgentSend>(id)
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
    err.downcast_ref::<api_v1::ErrorBody>()
        .is_some_and(|error| error.data.reason == "cancelled")
}

/// Sends a message again by its request ID and cancels it at once on the same connection: the
/// daemon withdraws the message it kept where its paste has not begun, and otherwise answers what
/// became of it.
fn withdraw(
    client: &mut DaemonClient,
    args: SendArgs,
    deadline: Instant,
) -> anyhow::Result<SendResult> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(Cut.into());
    }
    client.writer.set_write_timeout(Some(left))?;
    let id = client.begin_call::<AgentSend>(args)?;
    client.writer.write_all(&cancel_line(id))?;
    receive(client, id, deadline)
}

fn sent_result(
    relay: &Relay,
    actor: &ActorIdentity,
    call: &ToolCall,
    sent: SendResult,
    wait_for: SendWait,
    deadline: Instant,
    seconds: u64,
) -> Value {
    let delivery = &sent.message.delivery;
    let how = match delivery_word(delivery.status, delivery.delivered_via) {
        Some(how) => how,
        None => return delivery_failed(&sent),
    };
    let mut data = json!({ "id": sent.id, "delivery": how });
    if wait_for != SendWait::Result {
        return envelope::success(data);
    }
    if delivery.status != DeliveryStatus::Success {
        let mut failure = envelope::failure("unavailable", "delivery was not confirmed");
        failure["data"] = data;
        return failure;
    }
    let reading = || {
        let read_reply = relay.verified.read_reply.as_ref().ok_or_else(|| {
            ErrorBody::new(Reason::Unavailable, "the reply reader is unavailable")
        })?;
        let Some(recipient) = sent.recipient else {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                "the send receipt did not identify its recipient",
            ));
        };
        let cancel = relay.sends.read_cancel(&call.key);
        if cancel.is_requested() {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "the reply wait was cancelled",
            ));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        let sender = AgentRef {
            machine_id: recipient.reference.machine_id,
            agent_id: recipient.reference.agent_id,
        };
        let original = match sent.message.message_ref {
            Some(original) => MessageRef {
                machine_id: original.machine_id,
                message_id: original.message_id,
            },
            None => MessageRef {
                machine_id: sender.machine_id.clone(),
                message_id: sent.message.message_id,
            },
        };
        read_reply(
            &actor.reference,
            ReplyRead {
                original,
                sender,
                wait_until: tokio::time::Instant::from_std(deadline),
            },
            cancel,
        )
    };
    let mut failure = match reading() {
        Ok(Some(reply)) => {
            data["messages"] = json!([reply]);
            return envelope::success(data);
        }
        Ok(None) => envelope::failure(
            "reply_timeout",
            format!(
                "No reply to {} within {seconds} seconds. The message was delivered.",
                sent.id
            ),
        ),
        Err(error) => envelope::failure(
            error.data.reason.canonical_name(),
            format!(
                "The original message {} was delivered. {}",
                sent.id, error.message
            ),
        ),
    };
    failure["data"] = data;
    failure
}

fn delivery_word(status: DeliveryStatus, via: Option<DeliveredVia>) -> Option<&'static str> {
    match status {
        DeliveryStatus::Success => via.and_then(delivered_word),
        DeliveryStatus::Pending => Some("waiting_in_inbox"),
        _ => None,
    }
}

fn delivered_word(via: DeliveredVia) -> Option<&'static str> {
    match via {
        DeliveredVia::TypedIntoInput => Some("typed_into_input"),
        DeliveredVia::ReadByRecipient => Some("read_by_recipient"),
        DeliveredVia::ReturnedToRequest => Some("returned_to_request"),
        _ => None,
    }
}

fn send_failure(err: &anyhow::Error, outcome_unknown: bool) -> Value {
    let Some(wire) = err.downcast_ref::<api_v1::ErrorBody>() else {
        if outcome_unknown {
            return send_unconfirmed();
        }
        return failed(
            err,
            "whether the message was sent is not known: it may arrive",
        );
    };
    let mut error = envelope::tool_error(wire);
    if outcome_unknown && error.data.message_ref.is_none() {
        return send_unconfirmed();
    }
    let reference = error.data.message_ref.take();
    let delivered = error.data.delivered_via.take().and_then(delivered_word);
    let mut failure = envelope::refusal(&error);
    if let Some(reference) = reference {
        failure["data"]["id"] = json!(selector::format_message_address(
            &reference.message_id,
            &reference.machine_id
        ));
    }
    if let Some(delivery) = delivered {
        failure["data"]["delivery"] = json!(delivery);
    }
    failure
}

fn delivery_failed(sent: &SendResult) -> Value {
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
    let mut failure = envelope::failure(&reason, words);
    failure["data"] = json!({ "id": sent.id });
    failure
}
