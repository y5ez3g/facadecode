//! Messages between agents and to the person, as `agent.send` asks: records resolve the recipient,
//! messages keep the message and settle it, and the recipient's typist types it. A start's prompt
//! and the results messages write go the same way. Input of any kind reaches an agent through
//! [`Daemon::hand_input`].

use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{
    Delivery, DeliveryFailure, DeliveryStatus, FACADE, Message, SendOutcome, StartOutcome,
    TextWritten, start_result_text_at,
};
use facade_base::jsonrpc::{ErrorBody, Reason, SendFailure, decode_arguments};
use facade_base::machine::{AgentRef, ExecutionOutcome, MachineIdentity, MessageRef};
use facade_base::operations::{CallParams, Operation};
use facade_base::v3::address as addresses;
use facade_base::v3::{self, AgentDeliverStartResult, Caller, ForwardCall};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent::{
    self, AgentCommand, AgentHandle, Input, InputRejection, MessageTyping, Submission,
};
use crate::machine_service::machine_address_part;
use crate::messages::{self, Due, Earlier, Outcome, Posted, PostedResult, Settled};
use crate::operations::{check_request_id, request_words};
use crate::records::OperationTarget;
use crate::service::{Forwarded, sender_from, value_of};
use crate::store::SendRoute;
use crate::{Cancel, Daemon, HUMAN, Sender, gate_for_test, log};

struct SendOrigin<'a> {
    machine: &'a str,
    sender: Sender,
}

fn log_repeat(message: &Message, request_id: &str) {
    log(
        "info",
        &format!(
            "{}, #{}'s to #{}, answers its request {request_id} again",
            message.message_id, message.from, message.to
        ),
    );
}

/// How input waits where its agent has no room for it now, or a resize waits to take effect.
pub(crate) enum InputWait {
    /// It does not wait: a call with an ID fails with `capacity_exceeded`.
    Refuse,
    /// It waits until its call is cancelled: a notification, which its connection's end cancels.
    UntilCancelled(Cancel),
    /// It waits as long as its caller does: a message, which its deadline bounds.
    Always,
}

/// A message from `from` to `to`, pending until `deadline`, or with no deadline: a start's prompt
/// until its delivery begins, or a guest's until its next turn. The store numbers it.
pub(crate) fn pending_message(
    from: Sender,
    to: &str,
    text: String,
    reply_to: Option<String>,
    deadline: Option<String>,
) -> Message {
    Message {
        message_ref: None,
        from_machine_id: None,
        reply_to_machine_id: None,
        message_id: String::new(),
        from: from.from,
        from_name: from.from_name,
        to: to.to_string(),
        text,
        reply_to,
        from_window: None,
        call_id: None,
        result: None,
        at: facade_base::time::iso_now(),
        delivery: Delivery {
            status: DeliveryStatus::Pending,
            reason: None,
            text_written: TextWritten::None,
            enter_written: Some(false),
            deadline,
            delivered_via: None,
            delivered_at: None,
        },
    }
}

/// The message, its withdrawal status, and any reply the Guest was waiting for. A cancel and
/// a removed inbox still answer with their respective errors.
fn settled_answer(
    settled: Option<Settled>,
    to: &str,
    message_id: &str,
) -> Result<(Message, bool, Option<MessageRef>), ErrorBody> {
    match settled {
        Some(Settled::Kept(message)) => Ok((*message, false, None)),
        Some(Settled::Withdrawn(message)) => Ok((*message, true, None)),
        Some(Settled::WithdrawnWhileWaiting {
            message,
            expected_reply_to,
        }) => Ok((*message, true, Some(expected_reply_to))),
        Some(Settled::Cancelled) => Err(ErrorBody::new(
            Reason::Cancelled,
            format!("{message_id} was withdrawn before anything of it was typed; it is not kept"),
        )),
        None => Err(ErrorBody::new(
            Reason::Ended,
            format!("{to} was removed with its messages; what became of {message_id} is not known"),
        )),
    }
}

/// What the typist says an agent said: the message's text, from its sender.
fn submission_of(message: &Message) -> Submission {
    Submission {
        text: message.text.clone(),
        sender: Sender {
            from: message.from.clone(),
            from_name: message.from_name.clone(),
        },
    }
}

/// Projects the result's agent and prompt, which both belong to the machine that started it.
pub(crate) fn render_start_result(
    result: &StartOutcome,
    visible: &[MachineIdentity],
) -> Result<String, ErrorBody> {
    let agent = result.agent.reference();
    let selector = machine_address_part(&agent.machine_id, visible)?;
    let prompt = MessageRef {
        machine_id: agent.machine_id.clone(),
        message_id: result.prompt.message_id.clone(),
    };
    Ok(start_result_text_at(
        result,
        &addresses::format_agent_address(&agent, &selector),
        &addresses::format_message_address(&prompt, &selector),
    ))
}

impl Daemon {
    /// Projects durable machine IDs into the references read on this machine's terminal.
    pub(crate) fn message_text(&self, message: &Message) -> String {
        if message.from == FACADE {
            let projected = message.result.as_ref().and_then(|result| {
                self.machine_identities()
                    .and_then(|visible| render_start_result(result, &visible))
                    .ok()
            });
            let text = projected.as_deref().unwrap_or(&message.text);
            let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
            return if rest.is_empty() {
                format!("🔔 {first} · {}", message.message_id)
            } else {
                format!("🔔 {first} · {}\n{rest}", message.message_id)
            };
        }
        let sender = if matches!(message.from.as_str(), "human" | "command_line") {
            "the command line".to_owned()
        } else {
            let from = AgentRef {
                agent_id: message.from.clone(),
                machine_id: message
                    .from_machine_id
                    .clone()
                    .unwrap_or_else(|| self.machine_id.clone()),
            };
            let address = self
                .agent_address(&from)
                .unwrap_or_else(|_| from.exact_address());
            message.from_name.as_ref().map_or_else(
                || address.clone(),
                |name| format!("{} ({address})", facade_base::daemon::display_name(name)),
            )
        };
        let reply = message
            .reply_to
            .as_ref()
            .map(|message_id| {
                let reference = MessageRef {
                    message_id: message_id.clone(),
                    machine_id: message
                        .reply_to_machine_id
                        .clone()
                        .unwrap_or_else(|| self.machine_id.clone()),
                };
                let address = if reference.machine_id == self.machine_id {
                    reference.message_id
                } else {
                    self.message_address(&reference).unwrap_or_else(|_| {
                        format!("{}@{}", reference.message_id, reference.machine_id)
                    })
                };
                format!(" · Reply to {address}")
            })
            .unwrap_or_default();
        format!(
            "📨 Message from {sender} · {}{reply}\n{}",
            message.message_id, message.text
        )
    }

    /// Hands input to `agent`'s current run, waiting for room as `wait` says, until the run takes
    /// it or ends. Input waiting for a run that ended never reaches the next one.
    pub(crate) async fn hand_input(
        &self,
        agent: &AgentHandle,
        mut input: Input,
        wait: InputWait,
    ) -> Result<(), ErrorBody> {
        let id = agent.id().to_string();
        let run = agent.run();
        let room_changed = agent.input_room_changed();
        let mut cancel = match wait {
            InputWait::UntilCancelled(ref cancel) => Some(cancel.clone()),
            _ => None,
        };
        loop {
            // Listening before the input goes, so that no change of room is missed.
            let room = room_changed.notified();
            tokio::pin!(room);
            room.as_mut().enable();
            let (reply, taken) = oneshot::channel();
            if !agent
                .send(AgentCommand::WriteInput { input, run, reply })
                .await
            {
                return Err(crate::operations::agent_stopped(&id));
            }
            match taken
                .await
                .map_err(|_| crate::operations::agent_stopped(&id))?
            {
                Ok(()) => return Ok(()),
                Err(InputRejection::AgentExited) => {
                    return Err(ErrorBody::new(Reason::Ended, format!("{id} ended")));
                }
                Err(InputRejection::Backpressured(back)) => input = back,
            }
            match (&wait, cancel.as_mut()) {
                (InputWait::Refuse, _) => {
                    return Err(ErrorBody::new(
                        Reason::CapacityExceeded,
                        format!(
                            "agent {id} cannot accept this input: its {} KiB of waiting input \
                             is full, or a resize is waiting to take effect",
                            agent::MAX_INPUT_BYTES / 1024
                        ),
                    ));
                }
                (InputWait::UntilCancelled(_), Some(cancel)) => {
                    tokio::select! {
                        () = room => {}
                        () = cancel.requested() => {
                            return Err(ErrorBody::new(Reason::Unavailable, "the connection closed"));
                        }
                    }
                }
                _ => room.await,
            }
            gate_for_test("before-input-retry");
        }
    }

    pub(crate) async fn route_send(
        self: &Arc<Self>,
        caller: &Caller,
        mut args: v3::AgentSendArgs,
        incoming: Option<Forwarded>,
        mut cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let forwarded = incoming.is_some();
        let limit = incoming
            .as_ref()
            .and_then(|call| call.remaining)
            .map(|remaining| remaining.as_millis().min(u64::MAX as u128) as u64);
        let budget = match (limit, args.time_left_ms) {
            (Some(outer), Some(inner)) => Some(outer.min(inner)),
            (outer, inner) => outer.or(inner),
        };
        let due = Due::within(budget);
        let (recipient, sender, replay) = if let Some(call) = incoming {
            let recipient = call
                .recipient
                .filter(|reference| {
                    reference.machine_id == self.machine_id && reference.agent_id == args.to
                })
                .ok_or_else(|| {
                    ErrorBody::invalid_argument(
                        "a forwarded send needs the resolved local recipient",
                    )
                })?;
            args.request_id = call.request_id;
            (recipient, sender_from(caller, call.from_name), true)
        } else {
            let sender = sender_from(caller, self.caller_name(caller));
            let request = args.request_id.as_deref();
            if let Some(id) = request {
                check_request_id(id)?;
            }
            let target = args.to.trim_matches(facade_base::settings::is_space);
            let table = self.store.message_table();
            let retained = if let Some(request) = request {
                crate::blocking_in_place(|| table.send_target(&sender.from, request, target))
                    .map_err(ErrorBody::internal)?
            } else {
                None
            };
            let (route, replay) = match retained {
                Some(route) => (route, true),
                None => {
                    if args.reply_to_machine_id.is_some() {
                        return Err(ErrorBody::invalid_argument("provide the reply in reply_to"));
                    }
                    self.check_message_sender(caller)?;
                    let reply = self.original_reply(caller, args.reply_to.as_deref())?;
                    let resolving = self.addressed_agent(
                        caller,
                        v3::AgentTarget::Address {
                            agent: args.to.clone(),
                        },
                        OperationTarget::Send,
                    );
                    let recipient = tokio::time::timeout_at(due.instant, resolving)
                        .await
                        .map_err(|_| send_before_deadline())??;
                    if let Some((_, original)) = &reply
                        && original != &recipient
                    {
                        return Err(ErrorBody::invalid_argument(
                            "reply_to belongs to a different sender; use the original sender's address or omit reply_to",
                        ));
                    }
                    let route = SendRoute {
                        recipient,
                        reply: reply.map(|(message, _)| message),
                    };
                    if let Some(request) = request {
                        crate::blocking_in_place(|| {
                            table.keep_send_target(&sender.from, request, target, &route)
                        })
                        .map_err(ErrorBody::internal)?
                    } else {
                        (route, false)
                    }
                }
            };
            args.reply_to = route.reply.as_ref().map(|reply| reply.message_id.clone());
            args.reply_to_machine_id = route.reply.map(|reply| reply.machine_id);
            (route.recipient, sender, replay)
        };
        let allow_reply_hint = matches!(caller, Caller::Agent { .. }) && args.reply_to.is_none();
        if recipient.machine_id != self.machine_id {
            let target = &recipient.machine_id;
            let routed =
                tokio::time::timeout_at(due.instant, self.network.ensure_route(target)).await;
            match routed {
                Ok(Ok(())) => {}
                _ if replay => return Err(send_unconfirmed()),
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err(send_before_deadline()),
            }
            if cancel.is_requested() {
                if replay {
                    return Err(send_unconfirmed());
                }
                return Err(ErrorBody::new(
                    Reason::Cancelled,
                    "the send was cancelled before it was forwarded",
                ));
            }
            args.to = recipient.agent_id.clone();
            args.time_left_ms = None;
            let request_id = args.request_id.clone();
            let call = ForwardCall {
                call: CallParams {
                    op: v3::AgentSend::NAME.into(),
                    args: value_of(args),
                },
                by_model: matches!(caller, Caller::Agent { .. }),
                from_name: sender.from_name,
                recipient: Some(recipient.clone()),
            };
            let delivering = async {
                let mut response = self
                    .forward_call(
                        target,
                        caller.clone(),
                        call.clone(),
                        Some(
                            send_time_left(due.instant)
                                .map_err(|error| if replay { send_unconfirmed() } else { error })?,
                        ),
                        request_id.clone(),
                    )
                    .await;
                if request_id.is_some()
                    && response.as_ref().is_err_and(|error| {
                        error.data.unavailable.as_ref().is_some_and(|unavailable| {
                            unavailable.execution == ExecutionOutcome::OutcomeUnknown
                        })
                    })
                    && let Ok(Ok(())) =
                        tokio::time::timeout_at(due.instant, self.network.ensure_route(target))
                            .await
                    && let Ok(left) = send_time_left(due.instant)
                {
                    let retried = self
                        .forward_call(target, caller.clone(), call, Some(left), request_id)
                        .await;
                    if retried.is_ok()
                        || retried
                            .as_ref()
                            .is_err_and(|err| err.data.reason == Reason::Cancelled)
                    {
                        response = retried;
                    }
                }
                response.map_err(|error| {
                    if replay
                        && error.data.unavailable.as_ref().is_some_and(|unavailable| {
                            unavailable.execution == ExecutionOutcome::NotExecuted
                        })
                    {
                        send_unconfirmed()
                    } else {
                        error
                    }
                })
            };
            let mut result: v3::SendResult = tokio::select! {
                biased;
                result = delivering => decode_arguments(result?)?,
                () = cancel.requested() => return Err(send_unconfirmed()),
            };
            let candidate = result.expected_reply_to.take().filter(|_| {
                allow_reply_hint
                    && result.withdrawn
                    && result.message.delivery.reason == Some(DeliveryFailure::Timeout)
            });
            result.expected_reply_to = self.checked_reply_hint(caller, &recipient, candidate);
            let message = MessageRef {
                machine_id: recipient.machine_id,
                message_id: result.message.message_id.clone(),
            };
            result.id = self.message_address(&message)?;
            return Ok(value_of(result));
        }
        let origin = SendOrigin {
            machine: caller.machine_id(),
            sender,
        };
        let (sent, candidate) = self
            .send_to_agent(caller, &recipient, args, origin, due, cancel)
            .await?;
        let candidate = candidate.filter(|_| allow_reply_hint);
        let expected_reply_to = if forwarded {
            candidate
        } else {
            self.checked_reply_hint(caller, &recipient, candidate)
        };
        let reference = MessageRef {
            machine_id: self.machine_id.clone(),
            message_id: sent.message.message_id.clone(),
        };
        Ok(value_of(v3::SendResult {
            id: self.message_address(&reference)?,
            message: self.public_message(sent.message)?,
            repeated: sent.repeated,
            withdrawn: sent.withdrawn,
            expected_reply_to,
        }))
    }

    pub(crate) fn message_address(&self, message: &MessageRef) -> Result<String, ErrorBody> {
        let machine = self.machine_address_part(&message.machine_id)?;
        Ok(addresses::format_message_address(message, &machine))
    }

    fn check_message_sender(&self, caller: &Caller) -> Result<(), ErrorBody> {
        if let Caller::Agent { agent, .. } = caller {
            let from = self.get_agent(&agent.agent_id).ok_or_else(|| {
                ErrorBody::new(Reason::CallerUnavailable, "the sender is no longer listed")
            })?;
            if !from.is_guest() && from.rule().is_none() {
                return Err(ErrorBody::new(
                    Reason::Unsupported,
                    "a custom program cannot send messages",
                ));
            }
        }
        Ok(())
    }

    fn original_reply(
        &self,
        caller: &Caller,
        input: Option<&str>,
    ) -> Result<Option<(MessageRef, AgentRef)>, ErrorBody> {
        let Some(input) = input else {
            return Ok(None);
        };
        let Caller::Agent { agent, .. } = caller else {
            return Err(ErrorBody::invalid_argument(
                "the command line has no inbox; omit reply_to to send a new message",
            ));
        };
        let parsed = addresses::parse_message_address(input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let machine_id = parsed
            .machine
            .map(|selector| self.select_machine(selector).map(|row| row.machine_id))
            .transpose()?
            .unwrap_or_else(|| self.machine_id.clone());
        let reference = MessageRef {
            machine_id,
            message_id: parsed.message_id.into(),
        };
        let original = self
            .messages
            .reply_in_inbox(&agent.agent_id, &reference, None)?
            .ok_or_else(|| {
                ErrorBody::new(
                    Reason::NotFound,
                    format!("no message {input} is in the sender's inbox"),
                )
            })?;
        match original.from.as_str() {
            "human" | "command_line" => Err(ErrorBody::invalid_argument(
                "the original message came from the command line, which has no reply address",
            )),
            FACADE => Err(ErrorBody::invalid_argument(
                "the original message is a Facade notification, which has no reply address",
            )),
            _ => Ok(Some((
                reference.clone(),
                AgentRef {
                    machine_id: original.from_machine_id.unwrap_or(reference.machine_id),
                    agent_id: original.from,
                },
            ))),
        }
    }

    fn checked_reply_hint(
        &self,
        caller: &Caller,
        recipient: &AgentRef,
        candidate: Option<MessageRef>,
    ) -> Option<MessageRef> {
        let candidate = candidate.filter(|reference| reference.machine_id == self.machine_id)?;
        let (reference, original_sender) = self
            .original_reply(caller, Some(&candidate.message_id))
            .ok()??;
        (reference == candidate && &original_sender == recipient).then_some(candidate)
    }

    async fn send_to_agent(
        self: &Arc<Self>,
        caller: &Caller,
        recipient: &AgentRef,
        args: v3::AgentSendArgs,
        origin: SendOrigin<'_>,
        due: Due,
        mut cancel: Cancel,
    ) -> Result<(SendOutcome, Option<MessageRef>), SendFailure> {
        let inbox = origin.sender.from.clone();
        let machine = origin.machine;
        if let Some(request_id) = args.request_id.as_deref() {
            check_request_id(request_id)?;
            if let Some(earlier) = self.messages.find_request(
                machine,
                &inbox,
                &recipient.agent_id,
                request_id,
                None,
            )? {
                return self.repeat_send(earlier, request_id, cancel).await;
            }
        }
        let to = self.local_target(caller, recipient, OperationTarget::Send)?;
        facade_base::daemon::check_message_text(&args.text).map_err(ErrorBody::invalid_argument)?;
        let reply = match (args.reply_to, args.reply_to_machine_id) {
            (Some(message_id), Some(machine_id)) if machine_id == machine => Some(MessageRef {
                machine_id,
                message_id,
            }),
            (None, None) => None,
            _ => {
                return Err(ErrorBody::invalid_argument(
                    "a forwarded reply needs the checked message reference",
                )
                .into());
            }
        };
        if to.exit().borrow().is_some() {
            return Err(ErrorBody::new(
                Reason::Ended,
                format!(
                    "{} ended; it takes no messages",
                    self.agent_address(recipient)?
                ),
            )
            .into());
        }
        if !to.is_guest() && to.rule().is_none() {
            return Err(ErrorBody::new(
                Reason::Unsupported,
                format!(
                    "{} is a custom program and cannot receive messages",
                    to.info().name
                ),
            )
            .into());
        }
        let message = Message {
            from_machine_id: (machine != self.machine_id).then(|| machine.to_string()),
            reply_to_machine_id: reply.as_ref().map(|reference| reference.machine_id.clone()),
            from_window: None,
            ..pending_message(
                origin.sender,
                to.id(),
                args.text,
                reply.map(|reference| reference.message_id),
                Some(due.at.clone()),
            )
        };
        let (message, mut settled) =
            match self
                .messages
                .post(message, args.request_id.as_deref(), None)?
            {
                Posted::New(message, settled) => (message, settled),
                // A call with the same ID kept its message first: this one joins it.
                Posted::Earlier(earlier) => {
                    let request_id = args.request_id.as_deref().unwrap_or_default();
                    return self.repeat_send(earlier, request_id, cancel).await;
                }
            };
        log(
            "info",
            &format!(
                "#{inbox} sent {} to #{}{}",
                message.message_id,
                to.id(),
                request_words(args.request_id.as_deref())
            ),
        );
        let number = messages::number(&message);
        {
            let delivered = async {
                if to.is_guest() || self.hand_to_typist(&to, &message, due.instant).await {
                    self.messages
                        .settle_by_deadline(number, &mut settled, due.instant)
                        .await;
                }
            };
            tokio::pin!(delivered);
            tokio::select! {
                () = &mut delivered => {}
                // A cancel withdraws the message while its paste has not begun; once it began, the
                // delivery goes on.
                () = cancel.requested() => {
                    if self.messages.withdraw(number) {
                        log(
                            "info",
                            &format!(
                                "{}, #{inbox}'s to #{}, was withdrawn by its send's cancel before \
                                 its paste began",
                                message.message_id,
                                to.id()
                            ),
                        );
                    } else {
                        delivered.await;
                    }
                }
            }
        }
        gate_for_test("before-send-answer");
        let answer = settled.borrow().clone();
        let (message, withdrawn, expected_reply_to) =
            settled_answer(answer, to.id(), &message.message_id)?;
        Ok((
            SendOutcome {
                message,
                repeated: false,
                withdrawn,
                window_delivery: None,
            },
            expected_reply_to,
        ))
    }

    /// Answers a send that repeats an earlier one by its request ID with the message that one
    /// kept, joining its delivery while it lasts. A cancel of the repeat withdraws the message
    /// while its paste has not begun, as one of the first call would.
    async fn repeat_send(
        &self,
        earlier: Earlier,
        request_id: &str,
        mut cancel: Cancel,
    ) -> Result<(SendOutcome, Option<MessageRef>), SendFailure> {
        let (message, settled) = match earlier {
            Earlier::HumanReady(result) => {
                log_repeat(&result.message, request_id);
                return messages::human_result(result).map(|sent| (sent, None));
            }
            Earlier::Withdrawn(message) => {
                if message.delivery.reason.is_none() {
                    return settled_answer(
                        Some(Settled::Cancelled),
                        &message.to,
                        &message.message_id,
                    )
                    .map(|(message, withdrawn, expected_reply_to)| {
                        (
                            SendOutcome {
                                message,
                                repeated: true,
                                withdrawn,
                                window_delivery: None,
                            },
                            expected_reply_to,
                        )
                    })
                    .map_err(Into::into);
                }
                log_repeat(&message, request_id);
                return Ok((
                    SendOutcome {
                        message,
                        repeated: true,
                        withdrawn: true,
                        window_delivery: None,
                    },
                    None,
                ));
            }
            Earlier::Settled(message) => (message, None),
            Earlier::Delivering(message, settled) => (message, Some(settled)),
        };
        log_repeat(&message, request_id);
        let (message, withdrawn, expected_reply_to) = match settled {
            // A guest's message waits with no deadline for its next turn.
            Some(mut settled) if message.delivery.deadline.is_some() => {
                let number = messages::number(&message);
                {
                    let settling = async {
                        let _ = settled.wait_for(Option::is_some).await;
                    };
                    tokio::pin!(settling);
                    tokio::select! {
                        () = &mut settling => {}
                        () = cancel.requested() => {
                            if self.messages.withdraw(number) {
                                log(
                                    "info",
                                    &format!(
                                        "{}, #{}'s to #{}, was withdrawn by its send's cancel \
                                         before its paste began",
                                        message.message_id, message.from, message.to
                                    ),
                                );
                            } else {
                                settling.await;
                            }
                        }
                    }
                }
                let answer = settled.borrow().clone();
                settled_answer(answer, &message.to, &message.message_id)?
            }
            _ => (message, false, None),
        };
        Ok((
            SendOutcome {
                message,
                repeated: true,
                withdrawn,
                window_delivery: None,
            },
            expected_reply_to,
        ))
    }

    /// Delivers `agent`'s start prompt once its start settled (`started`): its CLI's tools
    /// connected or will not. It goes before every message held for it. A run that ends first
    /// fails it as ended. Nobody waits on it; its result, where it owes one, and the log say how
    /// it went. A prompt not delivered in time fails: withdrawn where nothing of it was typed, kept
    /// as failed otherwise.
    pub(crate) async fn send_start_prompt(
        self: Arc<Self>,
        agent: AgentHandle,
        prompt: Message,
        mut settled: watch::Receiver<Option<Settled>>,
        started: oneshot::Receiver<()>,
    ) {
        let (id, number) = (agent.id().to_string(), messages::number(&prompt));
        let mut exit = agent.exit();
        let started = tokio::select! {
            started = started => started.is_ok(),
            _ = exit.wait_for(Option::is_some) => false,
        };
        if started {
            gate_for_test("before-prompt-delivery");
            let due = Due::now();
            // The creator's name as it is now: a start from an agent's terminal can come before
            // that agent is listed.
            let from_name = match prompt.from.as_str() {
                HUMAN => None,
                creator if prompt.from_machine_id.is_none() => {
                    self.get_agent(creator).map(|creator| creator.info().name)
                }
                _ => None,
            };
            let typing = self
                .messages
                .begin_prompt(number, &due.at, from_name)
                .map(|begun| {
                    MessageTyping::start_prompt(
                        self.message_text(&begun),
                        number,
                        due.instant,
                        submission_of(&begun),
                    )
                });
            let prompt_command = AgentCommand::StartPrompt {
                run: agent::FIRST_RUN,
                prompt: typing,
            };
            if agent.send(prompt_command).await {
                self.messages
                    .settle_by_deadline(number, &mut settled, due.instant)
                    .await;
            } else {
                self.messages
                    .settle(&[number], Outcome::untyped(DeliveryFailure::Ended));
            }
        } else {
            self.messages
                .settle(&[number], Outcome::untyped(DeliveryFailure::Ended));
        }
        let delivery = match &*settled.borrow() {
            Some(Settled::Kept(message)) => Some((message.delivery.clone(), false)),
            Some(Settled::Withdrawn(message) | Settled::WithdrawnWhileWaiting { message, .. }) => {
                Some((message.delivery.clone(), true))
            }
            Some(Settled::Cancelled) | None => None,
        };
        let prompt_id = prompt.message_id;
        match delivery {
            Some((delivery, _)) if delivery.status == DeliveryStatus::Success => log(
                "info",
                &format!("#{id}'s start prompt, {prompt_id}, was delivered"),
            ),
            Some((delivery, withdrawn)) => log(
                "warn",
                &format!(
                    "#{id}'s start prompt, {prompt_id}, was not delivered{}: {}",
                    if withdrawn { " and was withdrawn" } else { "" },
                    delivery.failure_words(&format!("#{id}"))
                ),
            ),
            None => log(
                "info",
                &format!("#{id} was removed with its start prompt, {prompt_id}"),
            ),
        }
    }

    /// Selects the current member subscriptions before keeping one message under one number.
    pub(crate) async fn accept_start_result(
        self: &Arc<Self>,
        caller: &Caller,
        forwarded: v3::AgentDeliverStartResultArgs,
        remaining: Option<Duration>,
    ) -> Result<(), ErrorBody> {
        let mut args = facade_base::machine::AgentDeliverStartResultArgs {
            recipient: forwarded.recipient,
            message: crate::service::stored_message(forwarded.message),
        };
        if !matches!(caller, Caller::Terminal { .. })
            || args.recipient.machine_id != self.machine_id
            || args.message.from != facade_base::daemon::FACADE
            || args
                .message
                .result
                .as_ref()
                .is_none_or(|result| result.agent.machine_id != caller.machine_id())
        {
            return Err(ErrorBody::refused(
                "the start result does not belong to the forwarding machine and local recipient",
            ));
        }
        args.message.from_machine_id = Some(caller.machine_id().to_string());
        let due = Due::within(remaining.map(|time| time.as_millis().min(u64::MAX as u128) as u64));
        args.message.delivery.deadline = Some(due.at);
        let Some(posted) = self
            .messages
            .accept_reserved_result(&args.recipient, &args.message)?
        else {
            return Err(ErrorBody::new(
                Reason::NotFound,
                "the original creator or its reserved result is gone",
            ));
        };
        let to = &args.recipient.agent_id;
        let id = &args.message.message_id;
        let delivered = match posted {
            Posted::New(message, settled) => {
                let outcome = self
                    .deliver_local_result(message, due.instant, settled)
                    .await;
                settled_answer(outcome, to, id)?.0
            }
            Posted::Earlier(Earlier::Delivering(_, mut settled)) => {
                let outcome = settled
                    .wait_for(Option::is_some)
                    .await
                    .ok()
                    .and_then(|outcome| outcome.clone());
                settled_answer(outcome, to, id)?.0
            }
            Posted::Earlier(Earlier::Settled(message) | Earlier::Withdrawn(message)) => message,
            Posted::Earlier(Earlier::HumanReady(_)) => {
                return Err(ErrorBody::internal(
                    "a start result was addressed to the person",
                ));
            }
        };
        if delivered.delivery.status != DeliveryStatus::Success {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                delivered.delivery.failure_words(to),
            ));
        }
        Ok(())
    }

    async fn deliver_local_result(
        &self,
        message: Message,
        deadline: tokio::time::Instant,
        mut settled: watch::Receiver<Option<Settled>>,
    ) -> Option<Settled> {
        gate_for_test("before-result-delivery");
        let to = self.get_agent(&message.to)?;
        if to.is_guest() || self.hand_to_typist(&to, &message, deadline).await {
            self.messages
                .settle_by_deadline(messages::number(&message), &mut settled, deadline)
                .await;
        }
        settled.borrow().clone()
    }

    /// Hands a pending message to `to`'s typist, which settles it. False where the typist could
    /// not take it: it then fails as `timeout` by `deadline`, or as `ended`.
    pub(crate) async fn hand_to_typist(
        &self,
        to: &AgentHandle,
        message: &Message,
        deadline: tokio::time::Instant,
    ) -> bool {
        let number = messages::number(message);
        let typing = MessageTyping::new(
            self.message_text(message),
            number,
            deadline,
            submission_of(message),
        );
        let handed = tokio::time::timeout_at(
            deadline,
            self.hand_input(to, Input::Message(typing), InputWait::Always),
        )
        .await;
        let failure = match handed {
            Ok(Ok(())) => return true,
            Err(_late) => DeliveryFailure::Timeout,
            Ok(Err(_ended)) => DeliveryFailure::Ended,
        };
        self.messages.settle(&[number], Outcome::untyped(failure));
        false
    }
}

/// Delivers each result messages wrote, as a message is: to its recipient's typist by its
/// deadline. A guest's waits for its next turn to take it.
pub(crate) async fn deliver_results(
    daemon: Arc<Daemon>,
    mut results: mpsc::UnboundedReceiver<PostedResult>,
) {
    while let Some(result) = results.recv().await {
        let daemon = daemon.clone();
        tokio::spawn(async move {
            match result {
                PostedResult::Local {
                    message,
                    deadline,
                    settled,
                } => {
                    daemon
                        .deliver_local_result(message, deadline, settled)
                        .await;
                }
                PostedResult::Remote { args, deadline } => {
                    let target = args.recipient.machine_id.clone();
                    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                    let caller = Caller::Terminal {
                        machine_id: daemon.machine_id.clone(),
                    };
                    if let Err(error) = daemon
                        .network_call(
                            &target,
                            caller,
                            AgentDeliverStartResult::NAME,
                            value_of(v3::AgentDeliverStartResultArgs {
                                recipient: args.recipient,
                                message: match daemon.public_message(args.message) {
                                    Ok(message) => message,
                                    Err(error) => {
                                        log("warn", &error.message);
                                        return;
                                    }
                                },
                            }),
                            Some(left),
                            None,
                        )
                        .await
                    {
                        log(
                            "warn",
                            &format!("could not deliver the start result: {}", error.message),
                        );
                    }
                }
            }
        });
    }
}

fn send_time_left(deadline: tokio::time::Instant) -> Result<Duration, ErrorBody> {
    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
    if left.is_zero() {
        Err(send_before_deadline())
    } else {
        Ok(left)
    }
}

fn send_unconfirmed() -> ErrorBody {
    let mut error = ErrorBody::new(
        Reason::Unavailable,
        "the original send's delivery outcome is unknown",
    );
    error.data.unavailable = Some(facade_base::machine::Unavailable {
        execution: ExecutionOutcome::OutcomeUnknown,
        machine: None,
        window: None,
        matches: Vec::new(),
        unanswered: Vec::new(),
    });
    error
}

fn send_before_deadline() -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        "the delivery time expired before the message was sent",
    )
}

#[cfg(test)]
mod tests {
    use facade_base::daemon::{MAX_MESSAGE_CHARS, MAX_MESSAGE_LINES};

    #[test]
    fn accepts_a_message_at_both_public_limits() {
        let mut lines = vec!["\u{1D54F}".repeat(13); MAX_MESSAGE_LINES];
        let length = |lines: &[String]| {
            lines.iter().map(|line| line.chars().count()).sum::<usize>() + lines.len() - 1
        };
        let rest = MAX_MESSAGE_CHARS - length(&lines);
        lines[0].push_str(&"\u{1D54F}".repeat(rest));
        let text = lines.join("\n");
        assert_eq!(
            (
                text.chars().count(),
                facade_base::daemon::check_message_text(&text)
            ),
            (MAX_MESSAGE_CHARS, Ok(()))
        );
    }
}
