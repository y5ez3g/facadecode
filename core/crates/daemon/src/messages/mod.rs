//! Messages between agents and the person, and what becomes of each.
//!
//! Every message has a number (#mN), given here as the table keeps it, and stays in its recipient's
//! inbox for [`KEPT_FOR`], across daemon restarts. Only the messages still being delivered live in
//! memory, as open deliveries. An open delivery ends once: its recipient's typist types it, a read
//! (a `messages` snapshot, or a guest's prompt or turn-end hook) takes it, its deadline passes,
//! or the person's window delivery is settled.
//!
//! The rules, each kept under the one lock over the open deliveries:
//! - The table hears of a fact before anyone acts on it: a message before it is answered or typed,
//!   a paste before it is written, a read before its snapshot is answered, a settlement before the
//!   send it answers. A restart so finds at most one paste of each agent begun and not settled.
//! - A typist and a read never both take a message: whichever comes first owns it.
//! - A message may be withdrawn only while none of it can have been typed. A start's prompt is
//!   never withdrawn: the first task an agent is given stays in its inbox even where it timed out.
//! - A start's prompt from an agent owes that agent a result. The settlement that ends the prompt
//!   writes the result in the same transaction, and the result is delivered like any message.
//! - A send with a request ID finds, within the hour, the message it kept first, and keeps no other.
//! - A message to the person counts as delivered once a window subscription takes it. The table
//!   keeps the window outcomes before answering, and each window's snapshot uses those receipts.

mod handle;
mod human;
mod inbox;
mod outcome;
mod restart;
mod settle;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use facade_base::daemon::{AgentInfo, Message, SendOutcome};
use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::{AgentDeliverStartResultArgs, AgentRef, MessageRef};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::Instant;

use crate::store::{Kept, KeptMessage, MessageTable, RequestId};
use crate::{HUMAN, blocking_in_place};

pub(crate) use handle::DeliveryHandle;
pub(crate) use human::{human_result, no_window_delivery};
pub(crate) use outcome::{Due, Outcome, delivery_limit};
pub(crate) use restart::{Recipient, TakeUp, decide};

/// How long messages are kept (RULES-5.3).
pub(crate) const KEPT_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// How long past a deadline the typist has to say how the delivery ended, and as long again where
/// its paste had begun.
pub(crate) const RESPONSE_GRACE: Duration = Duration::from_millis(250);

/// The longest a message may take from its call reaching the daemon to its delivery.
const DELIVERY_TIME: Duration = Duration::from_millis(29_500);

/// How long a request ID finds the message it kept (MCP-1.1).
const REQUEST_HOUR: Duration = Duration::from_secs(60 * 60);

/// How many changes a slow `messages` watcher may fall behind by before it misses some.
const CHANGES_QUEUED: usize = 1024;

/// What a waiting send learns once its message's delivery ends. A message whose inbox went closes
/// the channel with nothing.
#[derive(Clone, Debug)]
pub(crate) enum Settled {
    /// Ended, as the table keeps it.
    Kept(Box<Message>),
    /// Failed with none of it typed, and taken out of the inbox: its sender may send it again.
    Withdrawn(Box<Message>),
    /// Withdrawn by its send's `cancel` before its paste began; not kept.
    Cancelled,
}

/// A change for `messages` watchers: a message kept or changed, or one gone.
#[derive(Clone, Debug)]
pub(crate) enum Change {
    Updated(Box<Message>),
    Removed { message_id: String, to: String },
}

impl Change {
    /// Whose inbox it is in.
    pub(crate) fn to(&self) -> &str {
        match self {
            Change::Updated(message) => &message.to,
            Change::Removed { to, .. } => to,
        }
    }
}

/// What a post kept: a new message being delivered, or the one its request ID kept before.
pub(crate) enum Posted {
    New(Message, watch::Receiver<Option<Settled>>),
    Earlier(Earlier),
}

/// A pending message to the person, or the one its request ID kept before.
pub(crate) enum PostedHuman {
    New(Message),
    Earlier(Earlier),
}

/// The message a request ID kept before: still being delivered, or ended as it stands.
pub(crate) enum Earlier {
    Delivering(Message, watch::Receiver<Option<Settled>>),
    Settled(Message),
    HumanReady(SendOutcome),
    HumanInFlight(watch::Receiver<Option<HumanSend>>),
}

/// The result a start's prompt owes the agent or guest that sent it.
pub(crate) struct OwedResult {
    /// The number reserved on the creator's machine.
    pub(crate) reference: MessageRef,
    /// The started agent as it stands; the result describes it as it is when the prompt ends.
    pub(crate) agent: Arc<dyn Fn() -> AgentInfo + Send + Sync>,
}

/// A result ready for the daemon to deliver before its deadline.
pub(crate) enum PostedResult {
    Local {
        message: Message,
        deadline: Instant,
        settled: watch::Receiver<Option<Settled>>,
    },
    Remote {
        args: AgentDeliverStartResultArgs,
        deadline: Instant,
    },
}

/// The number of message `message`, which the table numbered.
pub(crate) fn number(message: &Message) -> u64 {
    parse_number(&message.message_id).expect("a numbered message")
}

/// The number in a message ID, written `m4` or `#m4`.
fn parse_number(id: &str) -> Option<u64> {
    let digits = id.strip_prefix('#').unwrap_or(id).strip_prefix('m')?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn warn(message: &str) {
    facade_base::log::write("daemon", "warn", message);
}

/// A message being delivered.
struct Open {
    message: Message,
    /// Whether its paste began: a read still takes it, with what reached the terminal unknown.
    pasted: bool,
    /// Whether it is a start's prompt, which is never withdrawn.
    prompt: bool,
    /// The result it owes, where it is a start's prompt from an agent or guest.
    owes: Option<OwedResult>,
    /// Told what became of it. Dropped untold where its inbox went first.
    settled: watch::Sender<Option<Settled>>,
}

impl Open {
    /// Whether it may still go back out of its inbox: none of it can have been typed, and it is no
    /// start's prompt.
    fn may_withdraw(&self) -> bool {
        !self.pasted && !self.prompt && self.owes.is_none()
    }
}

/// The open deliveries and the table under them, shared by [`Messages`] and its typists' handles.
struct Deliveries {
    machine_id: String,
    table: MessageTable,
    /// By number. Taken before any write to the table, so that a read, the beginning of a paste and
    /// a settlement never interleave.
    open: Mutex<OpenDeliveries>,
    changes: broadcast::Sender<Change>,
    results: mpsc::UnboundedSender<PostedResult>,
}

type OpenMap = HashMap<u64, Open>;
type HumanSend = Result<SendOutcome, facade_base::jsonrpc::SendFailure>;

#[derive(Default)]
struct OpenDeliveries {
    agents: OpenMap,
    human: HashMap<u64, watch::Sender<Option<HumanSend>>>,
}

impl Deliveries {
    fn lock(&self) -> MutexGuard<'_, OpenDeliveries> {
        self.open.lock().unwrap()
    }

    fn reference(&self, message_id: String) -> MessageRef {
        MessageRef {
            machine_id: self.machine_id.clone(),
            message_id,
        }
    }

    /// Supplies the full reference for a window notification or a cross-machine send response.
    fn identify(&self, message: &mut Message) {
        if message.to == HUMAN
            || message
                .from_machine_id
                .as_ref()
                .is_some_and(|from| from != &self.machine_id)
        {
            message.message_ref = Some(self.reference(message.message_id.clone()));
        }
    }

    fn updated(&self, message: &Message) {
        let _ = self
            .changes
            .send(Change::Updated(Box::new(message.clone())));
    }

    fn removed(&self, message_id: String, to: String) {
        let _ = self.changes.send(Change::Removed { message_id, to });
    }

    /// Opens the delivery of `message`. Returns the receiver its settlement reaches.
    fn open(
        open: &mut OpenMap,
        message: Message,
        pasted: bool,
        prompt: bool,
        owes: Option<OwedResult>,
    ) -> watch::Receiver<Option<Settled>> {
        let (settled, receiver) = watch::channel(None);
        let delivery = Open {
            message,
            pasted,
            prompt,
            owes,
            settled,
        };
        open.insert(number(&delivery.message), delivery);
        receiver
    }

    /// Writes `message` under the next number, unless its sender kept one with `request_id` within
    /// the hour.
    fn keep(
        &self,
        message: &Message,
        request_id: Option<&str>,
        caller_window_id: Option<&str>,
    ) -> Result<Kept, ErrorBody> {
        let since = hour_ago();
        let request = request_id.map(|id| RequestId {
            id,
            since: &since,
            caller_window_id,
        });
        blocking_in_place(|| self.table.insert_message(message, request))
            .map_err(ErrorBody::internal)
    }

    fn posted(&self, open: &mut OpenDeliveries, kept: Kept) -> Posted {
        match kept {
            Kept::New(mut message) => {
                self.identify(&mut message);
                let settled = Self::open(&mut open.agents, message.clone(), false, false, None);
                self.updated(&message);
                Posted::New(message, settled)
            }
            Kept::Earlier(kept) => Posted::Earlier(self.earlier(open, kept)),
        }
    }

    /// A request ID's kept message, with a way to wait while its delivery is open.
    fn earlier(&self, open: &OpenDeliveries, kept: KeptMessage) -> Earlier {
        let KeptMessage {
            mut message,
            window_delivery,
            ..
        } = kept;
        self.identify(&mut message);
        if message.to == HUMAN {
            return match open.human.get(&number(&message)) {
                Some(settled) => Earlier::HumanInFlight(settled.subscribe()),
                None => Earlier::HumanReady(SendOutcome {
                    message,
                    repeated: true,
                    withdrawn: false,
                    window_delivery,
                }),
            };
        }
        match open.agents.get(&number(&message)) {
            Some(delivery) => {
                Earlier::Delivering(delivery.message.clone(), delivery.settled.subscribe())
            }
            None => Earlier::Settled(message),
        }
    }

    /// Deletes message `number` from the table. Returns whether it did.
    fn delete(&self, number: u64) -> bool {
        blocking_in_place(|| self.table.delete_message(number))
            .inspect_err(|err| warn(&format!("{err:#}; #m{number} stays")))
            .is_ok()
    }
}

/// An hour before now, as the table writes times: a request ID finds messages kept since.
fn hour_ago() -> String {
    let now = SystemTime::now();
    facade_base::time::iso_time(
        now.checked_sub(REQUEST_HOUR)
            .unwrap_or(SystemTime::UNIX_EPOCH),
    )
}

/// The daemon's messages.
pub(crate) struct Messages {
    deliveries: Arc<Deliveries>,
    /// The results written, until the daemon takes them.
    results: Mutex<Option<mpsc::UnboundedReceiver<PostedResult>>>,
}

impl Messages {
    pub(crate) fn new(table: MessageTable, machine_id: String) -> Messages {
        let (results, receiver) = mpsc::unbounded_channel();
        Messages {
            deliveries: Arc::new(Deliveries {
                machine_id,
                table,
                open: Mutex::default(),
                changes: broadcast::channel(CHANGES_QUEUED).0,
                results,
            }),
            results: Mutex::new(Some(receiver)),
        }
    }

    /// Raises the counter so the next message number is above `given`; one already above stays.
    /// Blocks.
    pub(crate) fn raise_above(&self, given: u64) -> anyhow::Result<()> {
        self.deliveries.table.raise_above(given)
    }

    /// The handle an agent's typist delivers through.
    pub(crate) fn delivery_handle(&self) -> DeliveryHandle {
        DeliveryHandle::of(self.deliveries.clone())
    }

    /// Every result written from now on, once each, for the daemon to deliver. Only the first call
    /// gets them.
    pub(crate) fn take_results(&self) -> Option<mpsc::UnboundedReceiver<PostedResult>> {
        self.results.lock().unwrap().take()
    }

    /// Follows new messages, delivery changes and messages gone.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Change> {
        self.deliveries.changes.subscribe()
    }

    /// Keeps a new pending message and opens its delivery. Where its sender kept one with
    /// `request_id` within the hour, keeps nothing and returns that one instead.
    pub(crate) fn post(
        &self,
        message: Message,
        request_id: Option<&str>,
        caller_window_id: Option<&str>,
    ) -> Result<Posted, ErrorBody> {
        let mut open = self.deliveries.lock();
        let kept = self
            .deliveries
            .keep(&message, request_id, caller_window_id)?;
        Ok(self.deliveries.posted(&mut open, kept))
    }

    /// The message this caller kept for `to` with `request_id` within the hour, if any.
    pub(crate) fn find_request(
        &self,
        from_machine_id: &str,
        from: &str,
        to: &str,
        request_id: &str,
        caller_window_id: Option<&str>,
    ) -> Result<Option<Earlier>, ErrorBody> {
        let open = self.deliveries.lock();
        let since = hour_ago();
        let request = RequestId {
            id: request_id,
            since: &since,
            caller_window_id,
        };
        let found = blocking_in_place(|| {
            self.deliveries
                .table
                .find_request(from_machine_id, from, to, request)
        })
        .map_err(ErrorBody::internal)?;
        Ok(found.map(|kept| self.deliveries.earlier(&open, kept)))
    }

    /// Commits the local number a start result will use when it reaches its creator.
    pub(crate) fn reserve_result(&self) -> Result<MessageRef, ErrorBody> {
        let _open = self.deliveries.lock();
        let number = blocking_in_place(|| self.deliveries.table.reserve_result_number())
            .map_err(ErrorBody::internal)?;
        Ok(self.deliveries.reference(format!("m{number}")))
    }

    /// Keeps a result under its reserved number and opens its delivery on this machine.
    pub(crate) fn accept_reserved_result(
        &self,
        recipient: &AgentRef,
        message: &Message,
    ) -> Result<Option<Posted>, ErrorBody> {
        if message.to != recipient.agent_id {
            return Err(ErrorBody::invalid_argument(
                "the start result names a different recipient",
            ));
        }
        let mut open = self.deliveries.lock();
        let kept = blocking_in_place(|| {
            self.deliveries
                .table
                .insert_reserved_result(recipient, message)
        })
        .map_err(ErrorBody::internal)?;
        Ok(kept.map(|kept| self.deliveries.posted(&mut open, kept)))
    }

    /// Withdraws message `number` for its send's `cancel`, where its paste has not begun: it is
    /// deleted, its send learns it was cancelled, and watchers that it is gone. Returns whether it
    /// was withdrawn.
    pub(crate) fn withdraw(&self, number: u64) -> bool {
        let deliveries = &self.deliveries;
        let mut open = deliveries.lock();
        if !open.agents.get(&number).is_some_and(Open::may_withdraw) {
            return false;
        }
        if let Err(err) = blocking_in_place(|| deliveries.table.delete_message(number)) {
            warn(&format!("{err:#}; #m{number} goes on"));
            return false;
        }
        let Some(gone) = open.agents.remove(&number) else {
            return false;
        };
        gone.settled.send_replace(Some(Settled::Cancelled));
        let Message { message_id, to, .. } = gone.message;
        deliveries.removed(message_id, to);
        true
    }

    /// Opens the delivery of a start's prompt, kept with its agent's record and pending with no
    /// deadline until its delivery begins. `owes` is the result it owes its sender.
    pub(crate) fn deliver_prompt(
        &self,
        prompt: Message,
        owes: Option<OwedResult>,
    ) -> watch::Receiver<Option<Settled>> {
        let mut open = self.deliveries.lock();
        self.deliveries.updated(&prompt);
        Deliveries::open(&mut open.agents, prompt, false, true, owes)
    }

    /// Begins the delivery of prompt `number` once its agent's tools connected or never will: gives
    /// it `deadline`, and `from_name` where it had no sender's name. Returns the prompt as it now
    /// stands, or None where it is no longer open. A deadline the table could not write is only
    /// logged: after a restart the prompt gets a whole delivery's time.
    pub(crate) fn begin_prompt(
        &self,
        number: u64,
        deadline: &str,
        from_name: Option<String>,
    ) -> Option<Message> {
        let mut open = self.deliveries.lock();
        let prompt = &mut open.agents.get_mut(&number)?.message;
        let table = &self.deliveries.table;
        if let Err(err) =
            blocking_in_place(|| table.begin_prompt(number, deadline, from_name.as_deref()))
        {
            warn(&format!("{err:#}"));
        }
        prompt.delivery.deadline = Some(deadline.to_string());
        if prompt.from_name.is_none() {
            prompt.from_name = from_name;
        }
        self.deliveries.updated(prompt);
        Some(prompt.clone())
    }

    /// Message `id` as it stands, where it is kept.
    pub(crate) fn message(&self, id: &str) -> Option<Message> {
        let number = parse_number(id)?;
        let mut message = blocking_in_place(|| self.deliveries.table.message(number))
            .unwrap_or_else(|err| {
                warn(&format!("{err:#}"));
                None
            })?;
        self.deliveries.identify(&mut message);
        Some(message)
    }

    /// Whether message `number` is kept. A table that cannot say counts as yes, so nothing is
    /// deleted on a guess.
    pub(crate) fn keeps(&self, number: u64) -> bool {
        blocking_in_place(|| self.deliveries.table.keeps_message(number)).unwrap_or(true)
    }
}

#[cfg(test)]
pub(crate) mod tests;
