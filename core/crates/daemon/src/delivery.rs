//! Messages between agents and to the person, as `agent.send` asks: records resolve the recipient,
//! messages keep the message and settle it, and the recipient's typist types it. A start's prompt
//! and the results messages write go the same way. Input of any kind reaches an agent through
//! [`Daemon::hand_input`].

use std::sync::Arc;

use facade_base::daemon::{
    DeliveredVia, Delivery, DeliveryFailure, DeliveryStatus, Message, SendArgs, SendResult,
    TERMINAL_WINDOW, TextWritten,
};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_rules::Rule;
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent::{
    self, AgentCommand, AgentHandle, Input, InputRejection, MessageTyping, Submission,
};
use crate::messages::{self, Due, Earlier, Outcome, Posted, PostedResult, Settled};
use crate::operations::{check_request_id, request_words};
use crate::records;
use crate::{Cancel, Daemon, HUMAN, Sender, gate_for_test, log};

/// How input waits where its agent has no room for it now, or a resize waits to take effect.
pub(crate) enum InputWait {
    /// It does not wait: a call with an ID fails with `capacity_exceeded`.
    Refuse,
    /// It waits until its call is cancelled: a notification, which its connection's end cancels.
    UntilCancelled(Cancel),
    /// It waits as long as its caller does: a message, which its deadline bounds.
    Always,
}

/// The widest number a message gets, so that a check of its length holds whatever number it gets.
const WIDEST_NUMBER: &str = "m999999999";

/// Refuses `message` where its recipient's CLI, by `rule`, could not take it within a delivery: its
/// paste, its Enter and their confirmation at that CLI's rates here (RULES-1.5, MCP-4.1).
/// `recipient` names the recipient in the error, and `instead` says what to do instead.
pub(crate) fn check_fits(
    rule: Option<&'static Rule>,
    recipient: &str,
    message: &Message,
    instead: &str,
) -> Result<(), ErrorBody> {
    let Some(rule) = rule else {
        return Ok(());
    };
    let widest = Message {
        message_id: WIDEST_NUMBER.into(),
        ..message.clone()
    };
    let typed = facade_base::daemon::typed_text(&widest);
    if agent::delivery_time(rule, &typed) <= messages::delivery_limit() {
        return Ok(());
    }
    Err(ErrorBody::invalid_argument(format!(
        "the message is too long for {recipient}'s CLI, {}, to take within thirty seconds at its \
         paste rate here; {instead}",
        rule.display_name
    )))
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
        sender: Option<&str>,
        args: SendArgs,
        mut cancel: Cancel,
    ) -> Result<SendResult, ErrorBody> {
        let due = Due::within(args.time_left_ms);
        let caller = sender
            .map(records::normalize_agent_reference)
            .unwrap_or_else(|| HUMAN.to_string());
        if let Some(request_id) = args.request_id.as_deref() {
            check_request_id(request_id)?;
            if let Some(earlier) = self.messages.find_request(&caller, request_id)? {
                return self.repeat_send(earlier, request_id, cancel).await;
            }
        }
        facade_base::daemon::check_message_text(&args.text).map_err(ErrorBody::invalid_argument)?;
        let from = match sender.map(records::normalize_agent_reference) {
            None => None,
            Some(sender) => Some(self.get_agent(&sender).ok_or_else(|| {
                ErrorBody::new(
                    Reason::NotFound,
                    format!("#{sender}, the agent this message would come from, is not listed"),
                )
            })?),
        };
        let reach = self.reach_of(from.as_ref().map(AgentHandle::id));
        let Some(to) = self.resolve_named(&args.to, &reach, true)? else {
            return self.tell_person(from.as_ref(), args);
        };
        if to.exit().borrow().is_some() {
            return Err(ErrorBody::new(
                Reason::Ended,
                format!("#{} ended; it takes no messages", to.id()),
            ));
        }
        let inbox = from.as_ref().map_or(HUMAN, AgentHandle::id).to_string();
        if let Some(reply) = args.reply_to.as_deref()
            && !self.messages.in_inbox(&inbox, reply)
        {
            return Err(ErrorBody::new(
                Reason::NotFound,
                format!("no message {reply} is in the sender's inbox"),
            ));
        }
        let from_info = from.as_ref().map(AgentHandle::info);
        let to_window = to.info().window_id;
        let sender = Sender {
            from: inbox.clone(),
            from_name: from_info.as_ref().map(|info| info.name.clone()),
        };
        let reply_to = args
            .reply_to
            .map(|reply| reply.trim_start_matches('#').to_string());
        // A guest has no typist: its next turn's hook takes its messages.
        let deadline = (!to.is_guest()).then(|| due.at.clone());
        let message = Message {
            from_window: from_info
                .map(|info| info.window_id)
                .filter(|window| *window != to_window)
                .map(|window| self.windows.label(&window)),
            ..pending_message(sender, to.id(), args.text, reply_to, deadline)
        };
        if !to.is_guest() {
            let rule = to
                .rule()
                .and_then(|name| facade_rules::find(name).ok().flatten());
            check_fits(
                rule,
                &format!("#{}", to.id()),
                &message,
                "send it in shorter parts",
            )?;
        }
        let (message, mut settled) =
            match self.messages.post(message, args.request_id.as_deref())? {
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
            return Ok(SendResult {
                message,
                repeated: false,
                withdrawn: false,
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
        Ok(SendResult {
            message,
            repeated: false,
            withdrawn,
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
    ) -> Result<SendResult, ErrorBody> {
        let (Earlier::Settled(message) | Earlier::Delivering(message, _)) = &earlier;
        log(
            "info",
            &format!(
                "{}, #{}'s to #{}, answers its request {request_id} again",
                message.message_id, message.from, message.to
            ),
        );
        let (message, withdrawn) = match earlier {
            Earlier::Settled(message) => (message, false),
            // A guest's message waits with no deadline for its next turn: it answers as it stands.
            Earlier::Delivering(message, _) if message.delivery.deadline.is_none() => {
                (message, false)
            }
            Earlier::Delivering(message, mut settled) => {
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
        };
        Ok(SendResult {
            message,
            repeated: true,
            withdrawn,
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
                creator => self.get_agent(creator).map(|creator| creator.info().name),
            };
            let typing = self
                .messages
                .begin_prompt(number, &due.at, from_name)
                .map(|begun| {
                    MessageTyping::start_prompt(
                        facade_base::daemon::typed_text(&begun),
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

    /// Tells the person a message from agent `from`: delivered as the `ide` clients of `from`'s
    /// window that watch its messages are handed it (RULES-1.8). Refused before it is kept where
    /// no such client is there, where `from` is in the terminal window, or where the person sends
    /// it. It is never kept for later or sent to another window.
    fn tell_person(
        &self,
        from: Option<&AgentHandle>,
        args: SendArgs,
    ) -> Result<SendResult, ErrorBody> {
        let Some(from) = from else {
            return Err(ErrorBody::invalid_argument(
                "a message to the person must come from an agent",
            ));
        };
        let info = from.info();
        if info.window_id == TERMINAL_WINDOW {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                format!(
                    "#{} runs in the terminal window, not in an editor window, where Facade \
                     could tell the person",
                    from.id()
                ),
            ));
        }
        if !self.windows.tells_person(&info.window_id) {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                format!(
                    "no editor shows #{}'s window, {}, now: the person cannot be told",
                    from.id(),
                    self.windows.label(&info.window_id)
                ),
            ));
        }
        if let Some(reply) = args.reply_to.as_deref()
            && !self.messages.in_inbox(from.id(), reply)
        {
            return Err(ErrorBody::new(
                Reason::NotFound,
                format!("no message {reply} is in the sender's inbox"),
            ));
        }
        let now = facade_base::time::iso_now();
        let message = Message {
            message_id: String::new(),
            from: from.id().to_string(),
            from_name: Some(info.name),
            to: HUMAN.into(),
            text: args.text,
            reply_to: args
                .reply_to
                .map(|reply| reply.trim_start_matches('#').to_string()),
            from_window: None,
            call_id: None,
            result: None,
            at: now.clone(),
            delivery: Delivery {
                status: DeliveryStatus::Success,
                reason: None,
                text_written: TextWritten::None,
                enter_written: Some(false),
                deadline: None,
                delivered_via: Some(DeliveredVia::Notified),
                delivered_at: Some(now),
            },
        };
        let (message, repeated) = self.messages.notify(message, args.request_id.as_deref())?;
        let line = if repeated {
            format!(
                "{}, #{}'s to #human, answers its request {} again",
                message.message_id,
                message.from,
                args.request_id.as_deref().unwrap_or_default()
            )
        } else {
            format!(
                "#{} sent {} to #human{}",
                message.from,
                message.message_id,
                request_words(args.request_id.as_deref())
            )
        };
        log("info", &line);
        Ok(SendResult {
            message,
            repeated,
            withdrawn: false,
        })
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
            facade_base::daemon::typed_text(message),
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
    while let Some(PostedResult {
        message,
        deadline,
        mut settled,
    }) = results.recv().await
    {
        let daemon = daemon.clone();
        tokio::spawn(async move {
            gate_for_test("before-result-delivery");
            let Some(to) = daemon.get_agent(&message.to) else {
                return;
            };
            if to.is_guest() || daemon.hand_to_typist(&to, &message, deadline).await {
                daemon
                    .messages
                    .settle_by_deadline(messages::number(&message), &mut settled, deadline)
                    .await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use facade_base::daemon::{
        Delivery, DeliveryStatus, MAX_MESSAGE_CHARS, MAX_MESSAGE_LINES, Message, TextWritten,
    };

    use super::check_fits;

    /// The longest message there is, 8,000 four-byte characters on 540 lines under the longest
    /// header, its sender's window named in it too, either fits a whole delivery to each CLI or is
    /// refused before it is sent, the refusal naming that CLI (RULES-1.5, MCP-4.1).
    #[test]
    fn the_longest_message_fits_each_cli_or_is_refused_naming_it() {
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
        let message = Message {
            message_id: String::new(),
            from: "a999999999".into(),
            from_name: Some("\u{1D54F}".repeat(200)),
            to: "a1".into(),
            text,
            reply_to: Some("m999999999".into()),
            from_window: Some("\u{1D54F}".repeat(200)),
            call_id: None,
            result: None,
            at: facade_base::time::iso_now(),
            delivery: Delivery {
                status: DeliveryStatus::Pending,
                reason: None,
                text_written: TextWritten::None,
                enter_written: Some(false),
                deadline: None,
                delivered_via: None,
                delivered_at: None,
            },
        };
        let widest = Message {
            message_id: "m999999999".into(),
            ..message.clone()
        };
        let typed = facade_base::daemon::typed_text(&widest);
        for rule in facade_rules::rules().unwrap() {
            let fits =
                crate::agent::delivery_time(rule, &typed) <= crate::messages::delivery_limit();
            match check_fits(Some(rule), "#a1", &message, "send it in shorter parts") {
                Ok(()) => assert!(fits, "{} was let through", rule.cli),
                Err(refused) => {
                    assert!(!fits, "{} was refused: {}", rule.cli, refused.message);
                    assert!(
                        refused.message.contains(&rule.display_name),
                        "{}",
                        refused.message
                    );
                }
            }
        }
    }
}
