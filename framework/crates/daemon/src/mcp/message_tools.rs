//! The message tools: `send_message` sends one message for the actor the server acts for, and the
//! checks of its arguments and of `read_messages`'.

use std::time::{Duration, Instant};

use facade_base::address::selector;
use facade_base::api_v1;
use facade_base::api_v1::daemon::{
    AgentKind, AgentTarget, DaemonCall, ReplyTo, SendArgs, SendResult, SendWait,
};
use facade_base::model::agent::AgentRef;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::{
    DeliveredVia, DeliveryFailure, DeliveryStatus, MessageRef, TextWritten, check_message_text,
};
use serde_json::{Map, Value, json};

use super::daemon_calls::result;
use super::envelope;
use super::verified_tools::ToolReply;
use super::{ActorIdentity, InboxAnswer, InboxOutput, Problems, Relay, ToolCall, optional, text};
use crate::delivery::{SEND_BEFORE_DEADLINE, SendControl, SendTurn};
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

/// Sends once through the daemon, with the relay's original deadline and request ID.
pub(super) async fn send_verified(
    relay: &Relay,
    actor: &ActorIdentity,
    arguments: Map<String, Value>,
    call: &ToolCall,
    send_turn: Option<SendTurn>,
) -> ToolReply {
    let seconds = timeout_seconds(&arguments);
    let (wait_for, budget) = match (seconds, arguments.get("wait_for").and_then(Value::as_str)) {
        (0, _) => (SendWait::Inbox, SEND_TIMEOUT),
        (_, Some("delivery")) => (SendWait::Delivery, Duration::from_secs(seconds)),
        (_, Some("result")) => (SendWait::Result, Duration::from_secs(seconds)),
        _ => unreachable!("validated send wait"),
    };
    let answer_grace = match wait_for {
        SendWait::Inbox => ANSWER_GRACE,
        SendWait::Delivery | SendWait::Result => ANSWER_GRACE + RESPONSE_GRACE,
    };
    let deadline = call.arrived + budget;
    let send_deadline = deadline - answer_grace;
    let left = send_deadline.saturating_duration_since(Instant::now());
    if left.is_zero() && call.replay == super::lines::Replay::First {
        return send_before_deadline(budget).into();
    }
    let mut cancel = relay.sends.read_cancel(&call.key);
    let turn = match send_turn {
        Some(turn) => tokio::select! {
            biased;
            () = cancel.requested() => None,
            turn = turn.until(send_deadline.into()) => turn,
        },
        None => None,
    };
    // A cancelled send can check and withdraw its own saved receipt without waiting for I5.
    if turn.is_none() && !cancel.is_requested() && call.replay == super::lines::Replay::First {
        return send_before_deadline(budget).into();
    }

    let args = SendArgs {
        to: AgentTarget::Selector(text(&arguments, "to")),
        text: text(&arguments, "text"),
        reply_to: optional(&arguments, "reply_to").map(ReplyTo::Address),
        request_id: Some(call.request_id.clone()),
        time_left_ms: Some(left.as_millis() as u64),
        wait_for: Some(wait_for),
        allow_unsupported_receipt: false,
    };
    drop(arguments);
    crate::gate_for_test("mcp-writing-send");
    crate::gate_for_test("mcp-before-send");
    let sent = (relay.verified.services.call)(
        &actor.reference,
        DaemonCall::AgentSend(args),
        SendControl {
            deadline: Some(send_deadline),
            admission: turn.map(|turn| relay.send_order.admitted(turn)),
            relay: call.output.as_ref().map(|output| output.link.clone()),
        },
        cancel.clone(),
    )
    .await;
    match result!(sent, Sent) {
        Ok(sent) => sent_result(relay, actor, call, *sent, wait_for, deadline, seconds).await,
        Err(error) if cancel.is_requested() && error.data.reason == "cancelled" => {
            ToolReply::Cancelled
        }
        Err(error)
            if error.data.reason == "unavailable" && error.message == SEND_BEFORE_DEADLINE =>
        {
            send_before_deadline(budget).into()
        }
        Err(error) => send_failure(&error).into(),
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

async fn sent_result(
    relay: &Relay,
    actor: &ActorIdentity,
    call: &ToolCall,
    sent: SendResult,
    wait_for: SendWait,
    deadline: Instant,
    seconds: u64,
) -> ToolReply {
    let delivery = &sent.message.delivery;
    let how = match delivery_word(delivery.status, delivery.delivered_via) {
        Some(how) => how,
        None => return delivery_failed(&sent).into(),
    };
    let mut data = json!({ "id": sent.id, "delivery": how });
    if wait_for != SendWait::Result {
        return envelope::success(data).into();
    }
    if delivery.status != DeliveryStatus::Success {
        let mut failure = envelope::failure(
            "unavailable",
            "delivery was not confirmed: at the last receipt the message was waiting in the \
             recipient's inbox and may still arrive, so send it again only if you establish \
             that it did not",
        );
        failure["data"] = data;
        return failure.into();
    }
    let reading = async {
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
            return Ok(InboxAnswer::Page(Value::Null));
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
        let output = call.output.clone().map(|target| InboxOutput {
            target,
            sent: Some(data.clone()),
        });
        read_reply(
            &actor.reference,
            ReplyRead {
                original,
                sender,
                wait_until: tokio::time::Instant::from_std(deadline),
            },
            cancel,
            output,
        )
        .await
    };
    let mut failure = match reading.await {
        Ok(InboxAnswer::Answered) => return ToolReply::Answered,
        Ok(InboxAnswer::Page(mut page))
            if page["data"]["messages"]
                .as_array()
                .is_some_and(|messages| !messages.is_empty()) =>
        {
            data["messages"] = page["data"]["messages"].take();
            return envelope::success(data).into();
        }
        Ok(InboxAnswer::Page(_)) => envelope::failure(
            "reply_timeout",
            format!(
                "No reply to {id} within {seconds} seconds. The message was delivered: do not \
                 send it again. A managed agent gets any later reply in its input; a Guest keeps \
                 waiting in read_messages with timeout_seconds 30, adding reply_to \"{id}\" for \
                 this reply alone.",
                id = sent.id,
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
    failure.into()
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

fn send_failure(wire: &api_v1::ErrorBody) -> Value {
    let mut error = envelope::tool_error(wire);
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
    let submission_unconfirmed = delivery.status != DeliveryStatus::Success
        && (delivery.enter_written != Some(true)
            || delivery.reason == Some(DeliveryFailure::SubmissionUnconfirmed));
    let unconfirmed = sent.recipient.as_ref().filter(|recipient| {
        !sent.withdrawn
            && recipient.kind == AgentKind::Managed
            && delivery.text_written != TextWritten::None
            && submission_unconfirmed
    });
    let to = unconfirmed.map_or(sent.message.to.as_str(), |recipient| {
        recipient.address.as_str()
    });
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
    } else if unconfirmed.is_some() {
        words += &format!(
            ". You can look at {to}'s screen for text still in its input; send the message again \
             only if you establish that it did not arrive."
        );
    }
    let reason = serde_json::to_value(delivery.reason.unwrap_or(DeliveryFailure::Unknown))
        .ok()
        .and_then(|reason| reason.as_str().map(str::to_string))
        .unwrap_or_default();
    let mut failure = envelope::failure(&reason, words);
    failure["data"] = json!({ "id": sent.id });
    failure
}
