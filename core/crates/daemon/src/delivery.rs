//! Messages between agents and to the person, as `agent.send` asks: records resolve the recipient,
//! messages keep the message and settle it, and the recipient's typist types it. A start's prompt
//! and the results messages write go the same way. Input of any kind reaches an agent through
//! [`Daemon::hand_input`].

use std::sync::Arc;
use std::time::Duration;

use facade_base::address::{
    display_machine_selector, exact_machine_selector, parse_message_address,
};
use facade_base::daemon::{
    AgentSendArgs, AgentSendResult, Delivery, DeliveryFailure, DeliveryStatus, Message,
    MessagesChange, SendOutcome, TextWritten, WindowDelivery, WindowDeliveryOutcome, WindowRef,
};
use facade_base::jsonrpc::{ErrorBody, Reason, SendFailure, decode_arguments};
use facade_base::machine::{
    AgentDeliverStartResult, AgentDeliverStartResultArgs, Caller, ExecutionOutcome, ForwardCall,
    MachineIdentity, MessageRef, WindowDeliver, WindowDeliverArgs, WindowDeliverResult,
};
use facade_base::operations::Operation;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent::{
    self, AgentCommand, AgentHandle, Input, InputRejection, MessageTyping, Submission,
};
use crate::messages::{self, Due, Earlier, Outcome, Posted, PostedHuman, PostedResult, Settled};
use crate::operations::{check_request_id, request_words};
use crate::records::Reach;
use crate::service::{sender_from, value_of};
use crate::{Cancel, Daemon, HUMAN, Sender, gate_for_test, log};

pub(crate) const VERIFY_HUMAN_REPLY: &str = "machine.verify_human_reply";

struct SendOrigin<'a> {
    caller: &'a Caller,
    sender: Sender,
    from_window: Option<String>,
    reply: Option<MessageRef>,
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

/// The answer to a send whose message came to `settled`: the message and whether its failure
/// withdrew it; `cancelled` where the send's cancel withdrew it; or, with nothing settled, gone
/// with its recipient `to`'s inbox.
fn settled_answer(
    settled: Option<Settled>,
    to: &str,
    message_id: &str,
) -> Result<(Message, bool), ErrorBody> {
    match settled {
        Some(Settled::Kept(message)) => Ok((*message, false)),
        Some(Settled::Withdrawn(message)) => Ok((*message, true)),
        Some(Settled::Cancelled) => Err(ErrorBody::new(
            Reason::Cancelled,
            format!("{message_id} was withdrawn before anything of it was typed; it is not kept"),
        )),
        None => Err(ErrorBody::new(
            Reason::Ended,
            format!(
                "#{to} was removed with its messages; what became of {message_id} is not known"
            ),
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

impl Daemon {
    /// Projects durable machine IDs into the references read on this machine's terminal.
    pub(crate) fn message_text(&self, message: &Message) -> String {
        let remote = |id: Option<&str>| id.is_some_and(|id| id != self.machine_id);
        if !remote(message.from_machine_id.as_deref())
            && !remote(message.reply_to_machine_id.as_deref())
        {
            return facade_base::daemon::typed_text(message);
        }
        let machines: Vec<_> = self
            .network
            .machines()
            .into_iter()
            .map(|row| MachineIdentity {
                machine_id: row.machine_id,
                name: row.name,
            })
            .collect();
        let selector = |id: Option<&str>| {
            let id = id.filter(|id| *id != self.machine_id)?;
            let selected = machines
                .iter()
                .find(|machine| machine.machine_id == id)
                .map(|machine| display_machine_selector(machine, &machines))
                .unwrap_or_else(|| exact_machine_selector(id));
            Some(selected)
        };
        facade_base::daemon::typed_text_with_machines(
            message,
            selector(message.from_machine_id.as_deref()).as_deref(),
            selector(message.reply_to_machine_id.as_deref()).as_deref(),
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
                    return Err(ErrorBody::new(Reason::Ended, format!("#{id} ended")));
                }
                Err(InputRejection::Backpressured(back)) => input = back,
            }
            match (&wait, cancel.as_mut()) {
                (InputWait::Refuse, _) => {
                    return Err(ErrorBody::new(
                        Reason::CapacityExceeded,
                        format!(
                            "agent #{id} cannot accept this input: its {} KiB of waiting input \
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

    /// Sends a message from `sender`, the agent a client acts for, or from the person
    /// (`agent.send`). Answers once it is delivered or failed, within what is left of its 30
    /// seconds; a message to the person once its window is handed it; one to a guest at once,
    /// pending until its next turn. A send with its sender's request ID looks for it first, and a
    /// cancel withdraws the message while its paste has not begun.
    pub(crate) async fn send(
        self: &Arc<Self>,
        caller: &Caller,
        args: AgentSendArgs,
        cancel: Cancel,
    ) -> Result<SendOutcome, SendFailure> {
        let due = Due::within(args.time_left_ms);
        let from = self.sending_agent(caller)?;
        let reach = Reach::from(caller);
        let Some(to) = self.resolve_named(&args.to, &reach, true)? else {
            let Some(from) = from.as_ref() else {
                return Err(ErrorBody::invalid_argument(
                    "a message to the person must come from an agent",
                )
                .into());
            };
            return self.tell_person(caller, from, args, due, cancel).await;
        };
        let reply = self
            .verified_reply(caller, args.reply_to.as_deref())
            .await?;
        let from_info = from.as_ref().map(AgentHandle::info);
        let to_windows = to.info().windows;
        let from_window = from_info
            .as_ref()
            .and_then(|info| match info.windows.as_slice() {
                [window] if !to_windows.contains(window) => Some(self.windows.name(window)),
                _ => None,
            });
        let sender = sender_from(caller, from_info.map(|info| info.name));
        let origin = SendOrigin {
            caller,
            sender,
            from_window,
            reply,
        };
        self.send_to_agent(to, args, origin, due, cancel).await
    }

    pub(crate) fn sending_agent(&self, caller: &Caller) -> Result<Option<AgentHandle>, ErrorBody> {
        let Caller::Agent { agent, .. } = caller else {
            return Ok(None);
        };
        self.get_agent(&agent.agent_id).map(Some).ok_or_else(|| {
            ErrorBody::new(
                Reason::NotFound,
                format!(
                    "#{}, the agent this message would come from, is not listed",
                    agent.agent_id
                ),
            )
        })
    }

    /// A name can stop matching live recipients while its earlier send is still kept.
    pub(crate) async fn replay_ended_local_send(
        &self,
        caller: &Caller,
        to: &AgentHandle,
        request_id: &str,
        reply_to: Option<&str>,
        cancel: Cancel,
    ) -> Result<Option<SendOutcome>, ErrorBody> {
        if to.exit().borrow().is_none() {
            return Ok(None);
        }
        check_request_id(request_id)?;
        let caller_window = match caller {
            Caller::Ide { window } => Some(window.window_id.as_str()),
            _ => None,
        };
        let sender = sender_from(caller, None);
        let earlier = self.messages.find_request(
            caller.machine_id(),
            &sender.from,
            to.id(),
            request_id,
            caller_window,
        )?;
        match earlier {
            Some(earlier) => {
                self.verified_reply(caller, reply_to).await?;
                self.repeat_send(earlier, request_id, cancel)
                    .await
                    .map(Some)
                    .map_err(Into::into)
            }
            None => Ok(None),
        }
    }

    pub(crate) async fn accept_forwarded_send(
        self: &Arc<Self>,
        caller: &Caller,
        forwarded: ForwardCall,
        request_id: Option<String>,
        remaining: Option<Duration>,
        cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let reply_machine = forwarded
            .call
            .args
            .get("reply_to_machine_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut args: AgentSendArgs = decode_arguments(forwarded.call.args)?;
        let reply = args
            .reply_to
            .clone()
            .zip(reply_machine)
            .map(|(message_id, machine_id)| MessageRef {
                machine_id,
                message_id,
            });
        if args.reply_to.is_some() && reply.is_none() {
            return Err(ErrorBody::invalid_argument(
                "a forwarded reply needs the verified message reference",
            ));
        }
        let to = self.resolve_agent(&args.to, &Reach::from(caller))?;
        args.request_id = request_id;
        let limit = remaining.map(|time| time.as_millis().min(u64::MAX as u128) as u64);
        let time_left = match (limit, args.time_left_ms) {
            (Some(forwarded), Some(given)) => Some(forwarded.min(given)),
            (left, given) => left.or(given),
        };
        let origin = SendOrigin {
            caller,
            sender: sender_from(caller, forwarded.from_name),
            from_window: forwarded.from_window,
            reply,
        };
        Ok(value_of(AgentSendResult::from(
            self.send_to_agent(to, args, origin, Due::within(time_left), cancel)
                .await?,
        )))
    }

    pub(crate) async fn verify_forwarded_reply(
        &self,
        caller: &Caller,
        args: &mut Value,
    ) -> Result<(), ErrorBody> {
        let reply = args.get("reply_to").and_then(Value::as_str);
        if let Some(reference) = self.verified_reply(caller, reply).await? {
            args["reply_to"] = Value::String(reference.message_id);
            args["reply_to_machine_id"] = Value::String(reference.machine_id);
        }
        Ok(())
    }

    async fn verified_reply(
        &self,
        caller: &Caller,
        input: Option<&str>,
    ) -> Result<Option<MessageRef>, ErrorBody> {
        let Some(input) = input else {
            return Ok(None);
        };
        let address = parse_message_address(input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let machine_id = address
            .machine
            .map(|selector| self.select_machine(selector).map(|row| row.machine_id))
            .transpose()?
            .unwrap_or_else(|| self.machine_id.clone());
        let reference = MessageRef {
            machine_id,
            message_id: address.message_id.to_string(),
        };
        let found = if reference.machine_id == self.machine_id {
            let (owner, window) = match caller {
                Caller::Agent { agent, .. } => (agent.agent_id.as_str(), None),
                Caller::Ide { window } => (HUMAN, Some(window)),
                Caller::Terminal { .. } => (HUMAN, None),
            };
            self.messages
                .reply_in_inbox(owner, &reference, window)?
                .is_some()
        } else if matches!(caller, Caller::Agent { .. }) {
            false
        } else {
            let replied = self
                .network_call(
                    &reference.machine_id,
                    caller.clone(),
                    VERIFY_HUMAN_REPLY,
                    value_of(&reference),
                    Some(Duration::from_secs(30)),
                    None,
                )
                .await?;
            decode_arguments::<bool>(replied)?
        };
        if !found {
            return Err(ErrorBody::new(
                Reason::NotFound,
                format!("no message {input} is in the sender's inbox"),
            ));
        }
        Ok(Some(reference))
    }

    pub(crate) fn verify_human_reply_at_store(
        &self,
        caller: &Caller,
        reference: MessageRef,
    ) -> Result<Value, ErrorBody> {
        let window = match caller {
            Caller::Ide { window } => Some(window),
            Caller::Terminal { .. } => None,
            _ => {
                return Err(ErrorBody::refused(
                    "only the person can verify a reply in the person's inbox",
                ));
            }
        };
        Ok(value_of(
            self.messages
                .reply_in_inbox(HUMAN, &reference, window)?
                .is_some(),
        ))
    }

    async fn send_to_agent(
        self: &Arc<Self>,
        to: AgentHandle,
        args: AgentSendArgs,
        origin: SendOrigin<'_>,
        due: Due,
        mut cancel: Cancel,
    ) -> Result<SendOutcome, SendFailure> {
        let inbox = origin.sender.from.clone();
        let machine = origin.caller.machine_id();
        let window = match origin.caller {
            Caller::Ide { window } => Some(window.window_id.as_str()),
            _ => None,
        };
        if let Some(request_id) = args.request_id.as_deref() {
            check_request_id(request_id)?;
            if let Some(earlier) =
                self.messages
                    .find_request(machine, &inbox, to.id(), request_id, window)?
            {
                return self.repeat_send(earlier, request_id, cancel).await;
            }
        }
        facade_base::daemon::check_message_text(&args.text).map_err(ErrorBody::invalid_argument)?;
        if to.exit().borrow().is_some() {
            return Err(ErrorBody::new(
                Reason::Ended,
                format!("#{} ended; it takes no messages", to.id()),
            )
            .into());
        }
        let deadline = (!to.is_guest()).then(|| due.at.clone());
        let message = Message {
            from_machine_id: (machine != self.machine_id).then(|| machine.to_string()),
            reply_to_machine_id: origin
                .reply
                .as_ref()
                .map(|reference| reference.machine_id.clone()),
            from_window: origin.from_window,
            ..pending_message(
                origin.sender,
                to.id(),
                args.text,
                origin.reply.map(|reference| reference.message_id),
                deadline,
            )
        };
        let (message, mut settled) =
            match self
                .messages
                .post(message, args.request_id.as_deref(), window)?
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
        if to.is_guest() {
            return Ok(SendOutcome {
                message,
                repeated: false,
                withdrawn: false,
                window_delivery: None,
            });
        }
        let number = messages::number(&message);
        {
            let delivered = async {
                if self.hand_to_typist(&to, &message, due.instant).await {
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
        let (message, withdrawn) = settled_answer(answer, to.id(), &message.message_id)?;
        Ok(SendOutcome {
            message,
            repeated: false,
            withdrawn,
            window_delivery: None,
        })
    }

    /// Answers a send that repeats an earlier one by its request ID with the message that one
    /// kept, joining its delivery while it lasts. A cancel of the repeat withdraws the message
    /// while its paste has not begun, as one of the first call would.
    async fn repeat_send(
        &self,
        earlier: Earlier,
        request_id: &str,
        mut cancel: Cancel,
    ) -> Result<SendOutcome, SendFailure> {
        let (message, settled) = match earlier {
            Earlier::HumanReady(result) => {
                log_repeat(&result.message, request_id);
                return messages::human_result(result);
            }
            Earlier::HumanInFlight(mut settled) => {
                let result = settled.wait_for(Option::is_some).await.map_err(|_| {
                    ErrorBody::new(
                        Reason::Unavailable,
                        "the original delivery ended without a result",
                    )
                })?;
                let result = result.as_ref().expect("a settled person message").clone();
                if let Ok(sent) = &result {
                    log_repeat(&sent.message, request_id);
                }
                return result;
            }
            Earlier::Withdrawn(message) => {
                if message.delivery.reason.is_none() {
                    return settled_answer(
                        Some(Settled::Cancelled),
                        &message.to,
                        &message.message_id,
                    )
                    .map(|(message, withdrawn)| SendOutcome {
                        message,
                        repeated: true,
                        withdrawn,
                        window_delivery: None,
                    })
                    .map_err(Into::into);
                }
                log_repeat(&message, request_id);
                return Ok(SendOutcome {
                    message,
                    repeated: true,
                    withdrawn: true,
                    window_delivery: None,
                });
            }
            Earlier::Settled(message) => (message, None),
            Earlier::Delivering(message, settled) => (message, Some(settled)),
        };
        log_repeat(&message, request_id);
        let (message, withdrawn) = match settled {
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
            _ => (message, false),
        };
        Ok(SendOutcome {
            message,
            repeated: true,
            withdrawn,
            window_delivery: None,
        })
    }

    /// Delivers `agent`'s start prompt once its start settled (`started`): its CLI's tools
    /// connected or will not. It goes before every message held for it. A run that ends first
    /// fails it as ended. Nobody waits on it; its result, where it owes one, and the log say how
    /// it went. A prompt that is not typed in time stays in the inbox.
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
            Some(Settled::Kept(message) | Settled::Withdrawn(message)) => {
                Some(message.delivery.clone())
            }
            Some(Settled::Cancelled) | None => None,
        };
        let prompt_id = prompt.message_id;
        match delivery {
            Some(delivery) if delivery.status == DeliveryStatus::Success => log(
                "info",
                &format!("#{id}'s start prompt, {prompt_id}, was delivered"),
            ),
            Some(delivery) => log(
                "warn",
                &format!(
                    "#{id}'s start prompt, {prompt_id}, was not delivered and stays in its inbox: \
                     {}",
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
    async fn tell_person(
        self: &Arc<Self>,
        caller: &Caller,
        from: &AgentHandle,
        args: AgentSendArgs,
        due: Due,
        cancel: Cancel,
    ) -> Result<SendOutcome, SendFailure> {
        let request = args.request_id.as_deref();
        if let Some(request) = request {
            check_request_id(request)?;
            if let Some(earlier) =
                self.messages
                    .find_request(&self.machine_id, from.id(), HUMAN, request, None)?
            {
                return self.repeat_send(earlier, request, cancel).await;
            }
        }
        facade_base::daemon::check_message_text(&args.text).map_err(ErrorBody::invalid_argument)?;
        let reply = self
            .verified_reply(caller, args.reply_to.as_deref())
            .await?;
        let info = from.info();
        let mut local = Vec::new();
        let mut remote: std::collections::BTreeMap<String, Vec<WindowRef>> =
            std::collections::BTreeMap::new();
        let mut outcomes = Vec::new();
        for window in info.windows {
            if window.machine_id == self.machine_id {
                match self.windows.person_target(&window) {
                    Ok(target) => local.push((window, target)),
                    Err(failure) => outcomes.push(failure),
                }
            } else {
                remote
                    .entry(window.machine_id.clone())
                    .or_default()
                    .push(window);
            }
        }
        if local.is_empty() && remote.is_empty() {
            if let Some(request) = request
                && let Some(earlier) =
                    self.messages
                        .find_request(&self.machine_id, from.id(), HUMAN, request, None)?
            {
                return self.repeat_send(earlier, request, cancel).await;
            }
            return Err(messages::no_window_delivery(outcomes));
        }
        let sender = Sender {
            from: from.id().to_owned(),
            from_name: Some(info.name),
        };
        let message = Message {
            reply_to_machine_id: reply.as_ref().map(|reference| reference.machine_id.clone()),
            ..pending_message(
                sender,
                HUMAN,
                args.text,
                reply.map(|reference| reference.message_id),
                None,
            )
        };
        let message = match self.messages.begin_human(message, request)? {
            PostedHuman::New(message) => message,
            PostedHuman::Earlier(earlier) => {
                return self
                    .repeat_send(earlier, request.unwrap_or_default(), cancel)
                    .await;
            }
        };
        let change = value_of(MessagesChange::Updated {
            message: Box::new(message.clone()),
        });
        for (window, target) in local {
            match self.windows.deliver_to_person(&target, &change) {
                Ok(()) => outcomes.push(WindowDeliveryOutcome::Delivered { window }),
                Err(failure) => outcomes.push(failure),
            }
        }
        let reference = MessageRef {
            machine_id: self.machine_id.clone(),
            message_id: message.message_id.clone(),
        };
        let mut offers = tokio::task::JoinSet::new();
        for (machine_id, windows) in remote {
            let daemon = self.clone();
            let caller = caller.clone();
            let payload = WindowDeliverArgs {
                message_ref: reference.clone(),
                message: message.clone(),
                windows: windows.clone(),
            };
            let left = due
                .instant
                .saturating_duration_since(tokio::time::Instant::now());
            offers.spawn(async move {
                let result = daemon
                    .network_call(
                        &machine_id,
                        caller,
                        WindowDeliver::NAME,
                        value_of(payload),
                        Some(left),
                        None,
                    )
                    .await;
                (windows, result)
            });
        }
        while let Some(offer) = offers.join_next().await {
            let (windows, result) = offer.map_err(ErrorBody::internal)?;
            match result {
                Ok(value) => match decode_arguments::<WindowDelivery>(value) {
                    Ok(receipt) => outcomes.extend(receipt.into_outcomes()),
                    Err(_) => outcomes.extend(
                        windows
                            .into_iter()
                            .map(|window| WindowDeliveryOutcome::OutcomeUnknown { window }),
                    ),
                },
                Err(error)
                    if error.data.unavailable.as_ref().is_some_and(|unavailable| {
                        unavailable.execution == ExecutionOutcome::OutcomeUnknown
                    }) =>
                {
                    outcomes.extend(
                        windows
                            .into_iter()
                            .map(|window| WindowDeliveryOutcome::OutcomeUnknown { window }),
                    );
                }
                Err(_) => outcomes.extend(windows.into_iter().map(|window| {
                    WindowDeliveryOutcome::NotDelivered {
                        window,
                        reason: "machine_unavailable".to_string(),
                    }
                })),
            }
        }
        outcomes.sort();
        let result = self.messages.finish_human(&message, outcomes)?;
        log(
            "info",
            &format!(
                "#{} sent {} to #human{}",
                message.from,
                message.message_id,
                request_words(request)
            ),
        );
        Ok(result)
    }

    pub(crate) fn deliver_forwarded_human(
        &self,
        caller: &Caller,
        args: WindowDeliverArgs,
    ) -> Result<WindowDeliverResult, ErrorBody> {
        let Caller::Agent { agent, .. } = caller else {
            return Err(ErrorBody::refused(
                "a message to the person must come from an agent",
            ));
        };
        if agent.machine_id != args.message_ref.machine_id
            || agent.agent_id != args.message.from
            || args.message_ref.message_id != args.message.message_id
            || args.message.to != HUMAN
            || args
                .windows
                .iter()
                .any(|window| window.machine_id != self.machine_id)
        {
            return Err(ErrorBody::invalid_argument(
                "the notification does not name its source or its member windows",
            ));
        }
        let change = value_of(MessagesChange::Updated {
            message: Box::new(Message {
                message_ref: Some(args.message_ref),
                ..args.message
            }),
        });
        let mut outcomes = Vec::new();
        for window in args.windows {
            match self
                .windows
                .person_target(&window)
                .and_then(|target| self.windows.deliver_to_person(&target, &change))
            {
                Ok(()) => outcomes.push(WindowDeliveryOutcome::Delivered { window }),
                Err(failure) => outcomes.push(failure),
            }
        }
        Ok(WindowDeliverResult {
            window_delivery: outcomes,
        })
    }

    pub(crate) async fn deliver_forwarded_result(
        self: &Arc<Self>,
        caller: &Caller,
        mut args: AgentDeliverStartResultArgs,
        remaining: Option<Duration>,
    ) -> Result<(), ErrorBody> {
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
            Posted::Earlier(Earlier::HumanReady(_) | Earlier::HumanInFlight(_)) => {
                return Err(ErrorBody::internal(
                    "a start result was addressed to the person",
                ));
            }
        };
        if delivered.delivery.status != DeliveryStatus::Success {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                delivered.delivery.failure_words(&format!("#{to}")),
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
                            value_of(args),
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
