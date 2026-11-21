//! Reports a CLI waiting on a permission, question, or sign-in to the Agent that started it.
//! Each continuous wait is reported once, after twenty seconds. Agent states come from the
//! `agents` topic's changes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{AgentInfo, AgentState, AgentsUpdate, FACADE, WaitKind, display_name};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::AgentRef;
use facade_base::process::ProcessState;
use facade_base::v3::Caller;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use crate::delivery::pending_message;
use crate::messages::{self, Due, Posted};
use crate::service::value_of;
use crate::{Daemon, Sender, log};

/// How long a started agent waits before its creator is told.
const WAIT_REPORT_DELAY: Duration = Duration::from_secs(20);

pub(crate) const DELIVER_WAIT_NOTICE: &str = "internal.deliver_wait_notice";

#[derive(Deserialize, Serialize)]
pub(crate) struct WaitNotice {
    pub(crate) recipient: AgentRef,
    pub(crate) waiting: AgentRef,
    pub(crate) name: String,
    pub(crate) kind: WaitKind,
}

/// What a started agent waits on, where it is something its creator is told of.
fn waiting_on(info: &AgentInfo) -> Option<WaitKind> {
    if info.state != AgentState::WaitingForYou || info.creator.is_none() {
        return None;
    }
    let kind = info.state_detail.as_ref()?.kind?;
    matches!(
        kind,
        WaitKind::Permission | WaitKind::Question | WaitKind::Auth
    )
    .then_some(kind)
}

/// Sleeps until `at`, or for ever without it.
async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// One time an agent started waiting.
struct Wait {
    kind: WaitKind,
    since: Instant,
    told: bool,
}

/// Follows the agents' states and tells creators of the waits that last twenty seconds.
pub(crate) async fn follow_waits(daemon: Arc<Daemon>) {
    let mut changes = daemon.changes.subscribe();
    let mut waits: HashMap<String, Wait> = HashMap::new();
    let note = |waits: &mut HashMap<String, Wait>, info: &AgentInfo| match waiting_on(info) {
        Some(kind) => {
            let same = waits
                .get(&info.agent_id)
                .is_some_and(|wait| wait.kind == kind);
            if !same {
                let wait = Wait {
                    kind,
                    since: Instant::now(),
                    told: false,
                };
                waits.insert(info.agent_id.clone(), wait);
            }
        }
        None => drop(waits.remove(&info.agent_id)),
    };
    loop {
        // The first wait not told yet comes due twenty seconds after it began; with none, only a
        // change of the agents wakes this.
        let due = waits
            .values()
            .filter(|wait| !wait.told)
            .map(|wait| wait.since + WAIT_REPORT_DELAY)
            .min();
        tokio::select! {
            change = changes.recv() => match change {
                Ok(AgentsUpdate::Updated { agent }) => note(&mut waits, &agent),
                Ok(AgentsUpdate::Removed { agent_id, .. }) => drop(waits.remove(&agent_id)),
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    let infos = daemon.agent_infos();
                    waits.retain(|id, _| infos.iter().any(|info| info.agent_id == *id));
                    infos.iter().for_each(|info| note(&mut waits, info));
                }
                Err(RecvError::Closed) => return,
            },
            () = sleep_until(due) => {
                for (id, wait) in &mut waits {
                    if wait.told || wait.since.elapsed() < WAIT_REPORT_DELAY {
                        continue;
                    }
                    wait.told = true;
                    // Still waiting on the same thing, as its record says now.
                    let Some(info) = daemon.get_agent(id).map(|agent| agent.info()) else {
                        continue;
                    };
                    if waiting_on(&info) == Some(wait.kind) {
                        daemon.tell_creator(&info, wait.kind);
                    }
                }
            }
        }
    }
}

/// The words a creator is told of what its agent `info` waits on: what it waits for first, then
/// who can answer.
fn waiting_text(name: &str, address: &str, kind: WaitKind) -> String {
    let agent = format!("{} ({address})", display_name(name));
    let (what, who) = match kind {
        WaitKind::Permission => ("the person's permission", "Only the person can give it."),
        WaitKind::Auth => ("the person to sign in", "Only the person can sign in."),
        _ => (
            "an answer to its question",
            "You or the person can answer it.",
        ),
    };
    format!("{agent}, which you started, waits for {what}.\nIt has waited 20 seconds. {who}")
}

impl Daemon {
    /// Routes a wait notification to the machine that holds the creator's inbox.
    fn tell_creator(self: &Arc<Self>, info: &AgentInfo, kind: WaitKind) {
        let Some(agent_id) = info.creator.clone() else {
            return;
        };
        let notice = WaitNotice {
            recipient: AgentRef {
                machine_id: info
                    .creator_machine_id
                    .clone()
                    .unwrap_or_else(|| self.machine_id.clone()),
                agent_id,
            },
            waiting: AgentRef {
                machine_id: self.machine_id.clone(),
                agent_id: info.agent_id.clone(),
            },
            name: info.name.clone(),
            kind,
        };
        let due = Due::now();
        let daemon = self.clone();
        tokio::spawn(async move {
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
                    .network_call(
                        &target,
                        caller,
                        DELIVER_WAIT_NOTICE,
                        value_of(notice),
                        Some(left),
                        None,
                    )
                    .await
                    .map(|_| ())
            };
            if let Err(error) = result {
                log(
                    "warn",
                    &format!("could not deliver a wait notice: {}", error.message),
                );
            }
        });
    }

    /// Posts a system message on the creator's machine. Forwarded notices are accepted only from
    /// the machine running the waiting Agent.
    pub(crate) async fn deliver_wait_notice(
        &self,
        caller: &Caller,
        notice: WaitNotice,
        remaining: Option<Duration>,
    ) -> Result<(), ErrorBody> {
        if !matches!(caller, Caller::Terminal { .. })
            || caller.machine_id() != notice.waiting.machine_id
            || self.machine_id != notice.recipient.machine_id
        {
            return Err(ErrorBody::refused(
                "the wait notice does not match the sending or receiving machine",
            ));
        }
        let Some(creator) = self.get_agent(&notice.recipient.agent_id) else {
            return Err(ErrorBody::new(
                Reason::NotFound,
                "the creator is no longer listed",
            ));
        };
        if creator.info().process != ProcessState::Running {
            return Err(ErrorBody::new(Reason::Ended, "the creator has stopped"));
        }
        let due = Due::within(remaining.map(|time| time.as_millis() as u64));
        let from = Sender {
            from: FACADE.to_string(),
            from_name: None,
        };
        let text = waiting_text(
            &notice.name,
            &self.agent_address(&notice.waiting)?,
            notice.kind,
        );
        let mut message = pending_message(from, creator.id(), text, None, Some(due.at));
        message.from_machine_id =
            (notice.waiting.machine_id != self.machine_id).then_some(notice.waiting.machine_id);
        if let Posted::New(message, mut settled) = self.messages.post(message, None, None)?
            && (creator.is_guest() || self.hand_to_typist(&creator, &message, due.instant).await)
        {
            self.messages
                .settle_by_deadline(messages::number(&message), &mut settled, due.instant)
                .await;
        }
        Ok(())
    }
}
