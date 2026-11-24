//! Typing for one agent runs in receive order, in its own lane. An Attach resize waits for the
//! matching reference's lane before changing the viewer's size.

use std::collections::HashMap;
use std::sync::Arc;

use facade_base::api_v1::ErrorBody;
use facade_base::api_v1::daemon::{AgentRef, AgentTarget, AgentTypeArgs, DaemonCall};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

use super::connection::{Peer, shell_ended};
use super::outbox::Outbox;
use super::{Client, Service, WhenFull};
use crate::Cancel;

/// The most request bytes of typing waiting in one lane. A longer request waits until it is alone.
const MAX_LANE_BYTES: usize = 1024 * 1024;

/// A request waiting in its lane, with the room it takes there until it is answered.
struct Queued {
    id: Option<u64>,
    args: AgentTypeArgs,
    _room: OwnedSemaphorePermit,
}

struct Lane {
    queue: mpsc::UnboundedSender<Queued>,
    room: Arc<Semaphore>,
}

impl Lane {
    fn idle(&self) -> bool {
        self.room.available_permits() == MAX_LANE_BYTES
    }
}

/// One connection's lanes, by the agent their requests name.
#[derive(Default)]
pub(super) struct Lanes(HashMap<LaneTarget, Lane>);

#[derive(PartialEq, Eq, Hash)]
enum LaneTarget {
    Address(String),
    Reference(AgentRef),
}

impl LaneTarget {
    fn of(target: &AgentTarget) -> Self {
        match target {
            AgentTarget::Selector(selector) => Self::Address(selector.clone()),
            AgentTarget::Reference(reference) => Self::Reference(reference.clone()),
        }
    }
}

/// What every lane of a connection runs with.
pub(super) struct LaneContext<S> {
    pub(super) service: Arc<S>,
    pub(super) client: Arc<Client>,
    pub(super) outbox: Outbox,
    pub(super) peer: Arc<Peer>,
    pub(super) shell_exited: Cancel,
}

impl<S> Clone for LaneContext<S> {
    fn clone(&self) -> Self {
        LaneContext {
            service: self.service.clone(),
            client: self.client.clone(),
            outbox: self.outbox.clone(),
            peer: self.peer.clone(),
            shell_exited: self.shell_exited.clone(),
        }
    }
}

impl Lanes {
    /// Puts request `id` in its agent's lane. Without room there, a request with an ID fails with
    /// `capacity_exceeded`; one without waits, and so does this connection's reading, until there
    /// is room or the client closes.
    pub(super) async fn queue<S: Service>(
        &mut self,
        context: &LaneContext<S>,
        id: Option<u64>,
        args: AgentTypeArgs,
        size: usize,
    ) {
        let agent = LaneTarget::of(&args.target);
        if !self.0.contains_key(&agent) {
            // Forget idle lanes: a long connection keeps none for agents it no longer types into.
            self.0.retain(|_, lane| !lane.idle());
        }
        let lane = self.0.entry(agent).or_insert_with(|| open(context.clone()));
        let bytes = size.clamp(1, MAX_LANE_BYTES) as u32;
        let mut exited = context.shell_exited.clone();
        let room = match lane.room.clone().try_acquire_many_owned(bytes) {
            Ok(room) => room,
            Err(_) if id.is_some() => {
                return context.outbox.answer(id, Err(no_room())).await;
            }
            Err(_) => tokio::select! {
                room = lane.room.clone().acquire_many_owned(bytes) => {
                    room.expect("a lane's room stays open")
                }
                () = context.peer.closed() => return,
                () = exited.requested() => return,
            },
        };
        let _ = lane.queue.send(Queued {
            id,
            args,
            _room: room,
        });
    }

    /// All permits are free once the matching lane has finished its queued input.
    pub(super) async fn wait_for_input(&self, reference: &AgentRef, peer: &Peer) {
        let Some(lane) = self.0.get(&LaneTarget::Reference(reference.clone())) else {
            return;
        };
        if !lane.idle() {
            tokio::select! {
                _ = lane.room.acquire_many(MAX_LANE_BYTES as u32) => {}
                () = peer.closed() => {}
            }
        }
    }
}

/// Opens a lane: a task that runs its requests one at a time. Once the client closed, it runs
/// nothing more, as input after input that was dropped would arrive with a gap.
fn open<S: Service>(context: LaneContext<S>) -> Lane {
    let (queue, mut waiting) = mpsc::unbounded_channel::<Queued>();
    tokio::spawn(async move {
        while let Some(request) = waiting.recv().await {
            if context.peer.hung_up() {
                continue;
            }
            let (when_full, cancel) = match request.id {
                Some(_) => (WhenFull::Refuse, Cancel::default()),
                None => (WhenFull::Wait, context.peer.hangup()),
            };
            let call = async {
                context
                    .service
                    .call(
                        &context.client,
                        DaemonCall::AgentType(request.args),
                        when_full,
                        cancel,
                    )
                    .await
            };
            let mut exited = context.shell_exited.clone();
            let result = tokio::select! {
                biased;
                () = exited.requested() => Err(shell_ended()),
                result = call => result,
            };
            // Input that stopped waiting because its client closed: nothing after it runs.
            if result.is_err() && request.id.is_none() && context.peer.is_closed() {
                context.peer.give_up();
            }
            context.outbox.answer(request.id, result).await;
        }
    });
    Lane {
        queue,
        room: Arc::new(Semaphore::new(MAX_LANE_BYTES)),
    }
}

fn no_room() -> ErrorBody {
    let message = format!(
        "this connection's waiting input for the agent is full ({} KiB); repeat the call once \
         earlier input was answered",
        MAX_LANE_BYTES / 1024
    );
    super::operation_error("capacity_exceeded", message)
}
