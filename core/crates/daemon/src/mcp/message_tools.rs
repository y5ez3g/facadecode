//! The message tools: `send_message` sends one message for the agent the server acts for, and
//! `read_messages` reads its inbox.

use std::io::Write;
use std::time::{Duration, Instant};

use facade_base::daemon::{
    AgentSend, DeliveredVia, DeliveryFailure, DeliveryStatus, FACADE, Message, MessagesTopic,
    MessagesWatchArgs, SendArgs, SendResult, check_message_text, display_name,
};
use facade_base::daemon_client::{Cut, DaemonClient, cancel_line, upgrading};
use facade_base::jsonrpc::{ErrorBody, Reason};
use serde_json::{Map, Value, json};

use super::Relay;
use super::daemon_calls::{self, CONNECT_TIMEOUT, failed};
use super::envelope::{self, MAX_INLINE_CHARS};
use super::result_files::{self, ResultFile};
use super::schema::Problems;
use super::tool_calls::{ToolCall, optional, text};

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
    let connect = || {
        let timeout = time_left(call.arrived)
            .unwrap_or_default()
            .min(CONNECT_TIMEOUT);
        daemon_calls::open(relay, &daemon_calls::as_agent(agent), timeout)
    };
    let send_args = |left: Option<Duration>| SendArgs {
        to: text(arguments, "to"),
        text: text(arguments, "text"),
        reply_to: optional(arguments, "reply_to"),
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
        Ok(sent) => Some(delivered(&sent)),
        Err(err) if relay.sends.cancelled(&call.key) && was_cancelled(&err) => None,
        Err(err) => Some(failed(
            &err,
            "whether the message was sent is not known: it may arrive",
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

/// The answer to a send whose delivery is settled: the message's ID and how it reached its
/// recipient, or why it did not, and that it was withdrawn where its failure withdrew it.
fn delivered(sent: &SendResult) -> Value {
    let message = &sent.message;
    let delivery = &message.delivery;
    let how = match (delivery.status, delivery.delivered_via) {
        (DeliveryStatus::Success, Some(DeliveredVia::Read)) => "read_by_recipient",
        (DeliveryStatus::Success, Some(DeliveredVia::Notified)) => "shown_to_person",
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
    envelope::success(json!({ "id": format!("#{}", message.message_id), "delivery": how }))
}

/// A message as `read_messages` returns it: its ID, its sender as Facade writes one (`@name #a3`,
/// `#human` for the person, `facade` for Facade's result), its time and text, and the message it
/// answers.
fn view_of(message: &Message) -> Value {
    let from = match &message.from_name {
        Some(name) => format!("@{} #{}", display_name(name), message.from),
        None if message.from == FACADE => FACADE.to_string(),
        None => format!("#{}", message.from),
    };
    let mut view = json!({
        "id": format!("#{}", message.message_id), "from": from, "at": message.at,
        "text": message.text,
    });
    if let Some(answered) = &message.reply_to {
        view["reply_to"] = json!(format!("#{answered}"));
    }
    view
}

/// Reads the inbox of the agent the server acts for: the messages not yet delivered, which reading
/// delivers; every message after `after`; or the `last` newest. Messages longer together than a
/// result carries go to a JSON file.
pub(super) fn read(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let after = optional(arguments, "after").map(|id| id.trim_start_matches('#').to_string());
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
    let views: Vec<Value> = messages.iter().map(view_of).collect();
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
