//! One fact an agent is told without asking (RULES-1.8): an agent that shares a member window with
//! its creator, whose CLI has waited twenty seconds on its own permission, question or
//! sign-in, is reported to that creator once each time it starts waiting, while the creator still
//! runs. The person is never told by it. Agent states come from the `agents` topic's changes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{AgentInfo, AgentState, AgentsChange, FACADE, WaitKind, display_name};
use facade_base::process::ProcessState;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use crate::delivery::pending_message;
use crate::messages::{self, Due, Posted};
use crate::{Daemon, Sender, log};

/// How long a started agent waits before its creator is told.
const WAIT_REPORT_DELAY: Duration = Duration::from_secs(20);

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
                Ok(AgentsChange::Updated { agent }) => note(&mut waits, &agent),
                Ok(AgentsChange::Removed { agent_id }) => drop(waits.remove(&agent_id)),
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
fn waiting_text(info: &AgentInfo, kind: WaitKind) -> String {
    let agent = format!("{} (#{})", display_name(&info.name), info.agent_id);
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
    /// Tells `info`'s creator, as a Facade result, that `info` waits on `kind`: only a creator of
    /// the same window that still runs. A guest creator has no typist: the result waits in its
    /// inbox for its next turn, as any message to a guest does.
    fn tell_creator(self: &Arc<Self>, info: &AgentInfo, kind: WaitKind) {
        let Some(creator) = info.creator.as_deref().and_then(|id| self.get_agent(id)) else {
            return;
        };
        let theirs = creator.info();
        if theirs.process != ProcessState::Running
            || !info
                .windows
                .iter()
                .any(|window| theirs.windows.contains(window))
        {
            return;
        }
        let due = Due::now();
        let from = Sender {
            from: FACADE.to_string(),
            from_name: None,
        };
        let text = waiting_text(info, kind);
        let guest = creator.is_guest();
        let deadline = (!guest).then(|| due.at.clone());
        let message = pending_message(from, creator.id(), text, None, deadline);
        let (message, mut settled) = match self.messages.post(message, None) {
            Ok(Posted::New(message, settled)) => (message, settled),
            Ok(Posted::Earlier(_)) => return,
            Err(error) => {
                log(
                    "warn",
                    &format!(
                        "could not tell #{} that #{} waits: {}",
                        creator.id(),
                        info.agent_id,
                        error.message
                    ),
                );
                return;
            }
        };
        log(
            "info",
            &format!(
                "told #{} that #{} waits on {}",
                creator.id(),
                info.agent_id,
                kind.as_str()
            ),
        );
        if guest {
            return;
        }
        let daemon = self.clone();
        tokio::spawn(async move {
            if daemon.hand_to_typist(&creator, &message, due.instant).await {
                daemon
                    .messages
                    .settle_by_deadline(messages::number(&message), &mut settled, due.instant)
                    .await;
            }
        });
    }
}
