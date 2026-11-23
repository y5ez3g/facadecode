//! Creator watchdog notices and authenticated delivery to the recipient's system inbox.

use std::sync::Arc;
use std::time::Duration;

use facade_base::api_v1::daemon::{self as wire, Caller};
use facade_base::model::agent::{
    ANSWER_WAIT, AgentRef, ManagedAgent, ManagedAgentState, WaitKind, error_words, exit_words,
};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::{DeliveryStatus, FACADE, send_failure_text};
use facade_base::model::terminal::display_name;
use facade_base::process::ProcessState;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::agent::{AgentCommand, AgentHandle};
use crate::api;
use crate::delivery::pending_message;
use crate::lifecycle::Work;
use crate::messages::{self, Due, Posted, PromptWatch};
use crate::{Daemon, Sender, log};

/// How long a continuously blocked or errored run waits before its creator is told.
const WAIT_REPORT_DELAY: Duration = Duration::from_secs(30);

#[derive(Deserialize, Serialize)]
pub(crate) struct WaitNotice {
    pub(crate) recipient: AgentRef,
    pub(crate) waiting: AgentRef,
    pub(crate) name: String,
    pub(crate) kind: WaitKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trouble {
    Waiting(WaitKind),
    Error,
    Ended,
}

impl Trouble {
    pub(crate) fn observe(info: &ManagedAgent, observed_end: bool) -> Option<Self> {
        if info.creator.is_none() || info.guest {
            return None;
        }
        match info.process {
            ProcessState::Ended if observed_end => Some(Self::Ended),
            ProcessState::Running => match info.state {
                ManagedAgentState::WaitingForYou => {
                    let kind = info.state_detail.as_ref()?.kind?;
                    kind.waiting_for().map(|_| Self::Waiting(kind))
                }
                ManagedAgentState::Error => Some(Self::Error),
                _ => None,
            },
            _ => None,
        }
    }

    pub(crate) fn deadline(self, now: Instant) -> Instant {
        match self {
            Self::Ended => now,
            Self::Waiting(_) | Self::Error => now + WAIT_REPORT_DELAY,
        }
    }
}

impl Daemon {
    pub(crate) async fn watch_creator(
        self: &Arc<Self>,
        agent: &AgentHandle,
        prompt: Option<PromptWatch>,
    ) {
        if agent.info().creator.is_none() {
            return;
        }
        let daemon = Arc::downgrade(self);
        let rule = agent
            .rule()
            .and_then(|name| facade_rules::find(name).ok().flatten());
        let report = Box::new(move |info: ManagedAgent, trouble| {
            if let Some(daemon) = daemon.upgrade() {
                let resumable = trouble == Trouble::Ended
                    && rule
                        .zip(info.session.as_deref())
                        .is_some_and(|(rule, session)| rule.resume_args(session).is_some());
                daemon.tell_creator(info, trouble, resumable);
            }
        });
        agent
            .send(AgentCommand::WatchCreator { prompt, report })
            .await;
    }

    pub(crate) fn tell_creator(
        self: &Arc<Self>,
        info: ManagedAgent,
        trouble: Trouble,
        resumable: bool,
    ) {
        let Some(recipient) = info.creator_ref() else {
            return;
        };
        let agent = api::wire_ref(&info.reference());
        let notice = match trouble {
            Trouble::Waiting(kind) => {
                self.route_wait_notice(WaitNotice {
                    recipient,
                    waiting: info.reference(),
                    name: info.name,
                    kind,
                });
                return;
            }
            Trouble::Error => wire::Notice::AgentError {
                agent,
                name: info.name,
                state_detail: info.state_detail,
                tools_reason: info.tools_reason,
            },
            Trouble::Ended => {
                let Some(exit) = info.exit else {
                    return;
                };
                wire::Notice::AgentEnded {
                    agent,
                    name: info.name,
                    exit,
                    how: info.state_detail.and_then(|detail| detail.how),
                    resumable,
                }
            }
        };
        self.route_notice(recipient, notice);
    }

    fn route_wait_notice(self: &Arc<Self>, notice: WaitNotice) {
        let Some(work) = self.lifecycle.begin(Work::Send) else {
            return;
        };
        let due = Due::now();
        let daemon = self.clone();
        tokio::spawn(async move {
            let _work = work;
            let target = notice.recipient.machine_id.clone();
            let caller = Caller::Terminal {
                machine_id: daemon.machine_id.clone(),
            };
            let left = due.instant.saturating_duration_since(Instant::now());
            let result = if target == daemon.machine_id {
                daemon
                    .deliver_wait_notice(&caller, notice, Some(left))
                    .await
            } else {
                daemon
                    .network_call::<wire::InternalDeliverWaitNotice>(
                        &target,
                        &caller,
                        wire::InternalDeliverWaitNoticeArgs {
                            recipient: api::wire_ref(&notice.recipient),
                            waiting: api::wire_ref(&notice.waiting),
                            name: notice.name,
                            kind: notice.kind,
                        },
                        Some(left),
                    )
                    .await
                    .map(|_| ())
            };
            log_notice_error(result);
        });
    }

    pub(crate) fn route_notice(self: &Arc<Self>, recipient: AgentRef, notice: wire::Notice) {
        let Some(work) = self.lifecycle.begin(Work::Send) else {
            return;
        };
        let due = Due::now();
        let daemon = self.clone();
        tokio::spawn(async move {
            let _work = work;
            let target = recipient.machine_id.clone();
            let caller = Caller::Terminal {
                machine_id: daemon.machine_id.clone(),
            };
            let args = wire::InternalDeliverNoticeArgs {
                recipient: api::wire_ref(&recipient),
                notice,
            };
            let left = due.instant.saturating_duration_since(Instant::now());
            let result = if target == daemon.machine_id {
                daemon.deliver_notice(&caller, args, Some(left)).await
            } else {
                daemon
                    .network_call::<wire::InternalDeliverNotice>(&target, &caller, args, Some(left))
                    .await
                    .map(|_| ())
            };
            log_notice_error(result);
        });
    }

    pub(crate) async fn deliver_wait_notice(
        &self,
        caller: &Caller,
        notice: WaitNotice,
        remaining: Option<Duration>,
    ) -> Result<(), ErrorBody> {
        let source = &notice.waiting.machine_id;
        self.check_notice(caller, &notice.recipient, source)?;
        let address = self.agent_address(&notice.waiting)?;
        let name = display_name(&notice.name);
        let what = notice.kind.waiting_for().unwrap_or("the person");
        let seconds = WAIT_REPORT_DELAY.as_secs();
        let text = format!(
            "{name} ({address}), which you started, waits for {what}.\nIt has waited {seconds} seconds. {ANSWER_WAIT}"
        );
        self.post_notice(&notice.recipient, source, text, remaining)
            .await
    }

    pub(crate) async fn deliver_notice(
        &self,
        caller: &Caller,
        args: wire::InternalDeliverNoticeArgs,
        remaining: Option<Duration>,
    ) -> Result<(), ErrorBody> {
        let recipient = api::agent_ref(args.recipient);
        let source = match &args.notice {
            wire::Notice::AgentError { agent, .. } | wire::Notice::AgentEnded { agent, .. } => {
                &agent.machine_id
            }
            wire::Notice::SendFailed {
                target,
                message,
                delivery,
                ..
            } => {
                if message.machine_id != target.machine_id
                    || delivery.status != DeliveryStatus::Failure
                {
                    return Err(ErrorBody::refused(
                        "a failed-send notice needs a failed message on the target's machine",
                    ));
                }
                &target.machine_id
            }
        };
        self.check_notice(caller, &recipient, source)?;
        let text = match args.notice {
            wire::Notice::AgentError {
                agent,
                name,
                state_detail,
                tools_reason,
            } => {
                let label = self.notice_agent(agent, &name)?;
                let error = error_words(state_detail.as_ref(), tools_reason);
                format!(
                    "{label} {error}.\nIt has been in Error for {} seconds. Use `read_screen` to decide what to do next.",
                    WAIT_REPORT_DELAY.as_secs()
                )
            }
            wire::Notice::AgentEnded {
                agent,
                name,
                exit,
                how,
                resumable,
            } => {
                let label = self.notice_agent(agent, &name)?;
                let ended = exit_words(&exit, how);
                let next = if resumable {
                    "Its saved session can be resumed."
                } else {
                    "It has no resumable saved session."
                };
                format!("{label} {ended}.\n{next}")
            }
            wire::Notice::SendFailed {
                target,
                message,
                delivery,
                withdrawn,
            } => {
                let target = self.agent_address(&api::agent_ref(target))?;
                let message = self.message_address(&api::message_ref(message))?;
                send_failure_text(&message, &target, &delivery, withdrawn)
            }
        };
        self.post_notice(&recipient, caller.machine_id(), text, remaining)
            .await
    }

    fn notice_agent(&self, agent: wire::AgentRef, name: &str) -> Result<String, ErrorBody> {
        let address = self.agent_address(&api::agent_ref(agent))?;
        Ok(format!("{} ({address})", display_name(name)))
    }

    fn check_notice(
        &self,
        caller: &Caller,
        recipient: &AgentRef,
        source: &str,
    ) -> Result<(), ErrorBody> {
        if !matches!(caller, Caller::Terminal { .. })
            || caller.machine_id() != source
            || self.machine_id != recipient.machine_id
        {
            return Err(ErrorBody::refused(
                "the notice does not match the sending or receiving machine",
            ));
        }
        Ok(())
    }

    async fn post_notice(
        &self,
        recipient: &AgentRef,
        source: &str,
        text: String,
        remaining: Option<Duration>,
    ) -> Result<(), ErrorBody> {
        let agent = self.get_agent(&recipient.agent_id).ok_or_else(|| {
            ErrorBody::new(Reason::NotFound, "the notice recipient is no longer listed")
        })?;
        if agent.info().process != ProcessState::Running {
            return Err(ErrorBody::new(
                Reason::Ended,
                "the notice recipient has stopped",
            ));
        }
        let due = Due::within(remaining.map(|time| time.as_millis() as u64));
        let from = Sender {
            from: FACADE.to_string(),
            from_name: None,
        };
        let mut message = pending_message(from, agent.id(), text, None, Some(due.at));
        message.from_machine_id = (source != self.machine_id).then(|| source.to_string());
        if let Posted::New(message, mut settled) = self.messages.post(message, None, None, false)?
            && (agent.is_guest() || self.hand_to_typist(&agent, &message, due.instant).await)
        {
            self.messages
                .settle_by_deadline(messages::number(&message), &mut settled, due.instant)
                .await;
        }
        Ok(())
    }
}

fn log_notice_error(result: Result<(), ErrorBody>) {
    if let Err(error) = result {
        log(
            "warn",
            &format!("could not deliver a notice: {}", error.message),
        );
    }
}
