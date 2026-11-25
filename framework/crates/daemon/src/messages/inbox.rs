//! Reading inboxes, and messages leaving them.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::SystemTime;

use facade_base::model::agent::AgentRef;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::MessageRef;
#[cfg(test)]
use facade_base::model::message::{Delivery, MAX_MESSAGE_IDS, MessagesWatchArgs};
use facade_base::{
    model::machine::WindowRef,
    model::message::{
        DEFAULT_MESSAGES_LIMIT, DeliveryStatus, MAX_MESSAGES_LIMIT, Message, MessagesSnapshot,
    },
};
use tokio::sync::OwnedSemaphorePermit;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::outcome::read_delivery;
use super::write_queue::Lane;
use super::writer::{Effect, EffectStop, PendingEffect, Prepared, stop_before_effect};
use super::{Deliveries, Due, GuestReplyWait, KEPT_FOR, Messages, Settled, number, parse_number};
#[cfg(test)]
use super::{OpenMap, warn};
use crate::lifecycle::RelayLink;
use crate::server::OutboxRoom;
use crate::store::{CommandRequest, Gone, InboxPage, MessageTable};
use crate::{Cancel, an_hour_ago, blocking_in_place, pause_for_test, send_route_cutoff};

/// Rechecks the run allowed to read an inbox at the time the page is taken.
pub(crate) type ReadAdmission = Arc<dyn Fn() -> bool + Send + Sync>;

/// Selection for an inbox read. Cursors name local inbox messages, replies use stable references.
#[derive(Default)]
pub(crate) struct InboxRead {
    pub(crate) after: Option<String>,
    pub(crate) last: Option<u16>,
    pub(crate) reply_to: Option<MessageRef>,
    pub(crate) wait_until: Option<Instant>,
    /// A snapshot also has a budget for acquiring room for its reply.
    pub(crate) admit_by: Option<Instant>,
    pub(crate) admit_run: Option<ReadAdmission>,
    pub(crate) relay: Option<Arc<RelayLink>>,
}

/// Selection for the first reply from the recipient of a specific send.
pub(crate) struct ReplyRead {
    pub(crate) original: MessageRef,
    pub(crate) sender: AgentRef,
    pub(crate) wait_until: Instant,
    pub(crate) admit_run: Option<ReadAdmission>,
    pub(crate) relay: Option<Arc<RelayLink>>,
}

/// An inbox page may become delivered only once the client has room for its complete answer.
pub(crate) enum InboxSelection<T, Room> {
    Ready {
        count: usize,
        result: T,
        enqueue: Option<ReadAnswer>,
    },
    Wait(Pin<Box<dyn Future<Output = Result<Room, ErrorBody>> + Send>>),
}

/// An answer with its whole outbox reservation. Before the writer claims it, the caller can
/// return the room as soon as its relay freezes.
pub(crate) struct ReadAnswer {
    link: Arc<RelayLink>,
    room: OutboxRoom,
    line: Vec<u8>,
}

impl ReadAnswer {
    pub(crate) fn new(link: Arc<RelayLink>, room: OutboxRoom, line: Vec<u8>) -> Self {
        Self { link, room, line }
    }

    pub(crate) fn claim(self) -> Result<Option<Box<dyn FnOnce() + Send>>, ErrorBody> {
        let Some(effect) = self.link.try_effect()? else {
            return Ok(None);
        };
        Ok(Some(Box::new(move || {
            crate::gate_for_test("mcp-inbox-answer");
            self.room.send(self.line);
            drop(effect);
        })))
    }
}

#[derive(Clone)]
struct PageQuery {
    owner: String,
    after: Option<u64>,
    last: Option<usize>,
    reply_to: Option<(String, u64)>,
    sender: Option<AgentRef>,
    admit_run: Option<ReadAdmission>,
}

impl PageQuery {
    fn arguments<'a>(&'a self, machine_id: &'a str, at: &'a str) -> InboxPage<'a> {
        InboxPage {
            machine_id,
            after: self.after,
            last: self.last,
            limit: if self.sender.is_some() {
                1
            } else {
                usize::from(DEFAULT_MESSAGES_LIMIT) + 1
            },
            reply_to: self
                .reply_to
                .as_ref()
                .map(|(machine, number)| (machine.as_str(), *number)),
            now: at,
        }
    }

    fn snapshot(&self, deliveries: &Deliveries, mut messages: Vec<Message>) -> MessagesSnapshot {
        let next_cursor = page_cursor(
            &mut messages,
            self.last.unwrap_or(usize::from(DEFAULT_MESSAGES_LIMIT)),
        );
        for message in &mut messages {
            deliveries.identify(message);
        }
        MessagesSnapshot {
            messages,
            next_cursor,
            ..MessagesSnapshot::default()
        }
    }
}

enum Taken<T> {
    Page(T),
    Again,
    Paused,
    Expired,
}

struct ProjectedPage<T> {
    query: PageQuery,
    snapshot: MessagesSnapshot,
    count: usize,
    result: T,
    reply: Option<ReadAnswer>,
    until: Option<Instant>,
    cancel: Cancel,
    budget: OwnedSemaphorePermit,
}

impl<T, Room> InboxSelection<T, Room> {
    pub(crate) fn ready(count: usize, result: T) -> Self {
        Self::Ready {
            count,
            result,
            enqueue: None,
        }
    }
}

async fn resume_read(
    relay: &RelayLink,
    until: Option<Instant>,
    cancel: Cancel,
) -> Result<bool, ErrorBody> {
    tokio::select! {
        biased;
        stopped = stop_before_effect(until, cancel, None) => match stopped {
            EffectStop::Cancelled => Err(read_cancelled()),
            EffectStop::Expired => Ok(false),
            EffectStop::Frozen => unreachable!("wait for the effect even while the relay is frozen"),
        },
        effect = relay.effect() => {
            drop(effect?);
            Ok(true)
        }
    }
}

async fn retry_read(
    stopped: EffectStop,
    relay: Option<&RelayLink>,
    until: Option<Instant>,
    cancel: &Cancel,
) -> Result<bool, ErrorBody> {
    match stopped {
        EffectStop::Cancelled => Err(read_cancelled()),
        EffectStop::Expired => Ok(false),
        EffectStop::Frozen => {
            let relay = relay.expect("only a relay read can freeze");
            resume_read(relay, until, cancel.clone()).await
        }
    }
}

impl Messages {
    /// Projects whole messages before committing the delivered prefix. A waiting read subscribes
    /// before checking so a post can wake it even if it arrives while the check is in progress.
    pub(crate) async fn read_inbox<T: Send + 'static, Room: Send>(
        &self,
        owner: &str,
        is_guest: bool,
        mut read: InboxRead,
        cancel: Cancel,
        project: impl Fn(&MessagesSnapshot, Option<Room>) -> Result<InboxSelection<T, Room>, ErrorBody>
        + Send,
    ) -> Result<T, ErrorBody> {
        read.wait_until = read.wait_until.map(Due::inbox_wait);
        self.read_selected(owner, is_guest, read, None, cancel, project)
            .await
    }

    /// Takes one complete matching reply within the send's remaining time.
    pub(crate) async fn read_first_reply<T: Send + 'static, Room: Send>(
        &self,
        owner: &str,
        is_guest: bool,
        read: ReplyRead,
        cancel: Cancel,
        project: impl Fn(&MessagesSnapshot, Option<Room>) -> Result<InboxSelection<T, Room>, ErrorBody>
        + Send,
    ) -> Result<T, ErrorBody> {
        let inbox = InboxRead {
            reply_to: Some(read.original),
            wait_until: Some(read.wait_until),
            admit_run: read.admit_run,
            relay: read.relay,
            ..InboxRead::default()
        };
        self.read_selected(owner, is_guest, inbox, Some(&read.sender), cancel, project)
            .await
    }

    async fn read_selected<T: Send + 'static, Room: Send>(
        &self,
        owner: &str,
        is_guest: bool,
        read: InboxRead,
        sender: Option<&AgentRef>,
        mut cancel: Cancel,
        project: impl Fn(&MessagesSnapshot, Option<Room>) -> Result<InboxSelection<T, Room>, ErrorBody>
        + Send,
    ) -> Result<T, ErrorBody> {
        if read.after.is_some() && read.last.is_some() {
            return Err(ErrorBody::invalid_argument("give after or last, not both"));
        }
        let after = read.after.as_deref().map(cursor_number).transpose()?;
        let last = read.last.map(last_limit).transpose()?.map(usize::from);
        let reply_to = read
            .reply_to
            .as_ref()
            .map(|reference| {
                let number = stored_number(&reference.message_id)
                    .ok_or_else(|| ErrorBody::invalid_argument("reply_to must name a message"))?;
                Ok::<_, ErrorBody>((reference.machine_id.as_str(), number))
            })
            .transpose()?;
        let mut wait = read.wait_until.map(|until| (until, self.subscribe()));
        let mut reply_wait = None;
        let query = PageQuery {
            owner: owner.to_owned(),
            after,
            last,
            reply_to: reply_to.map(|(machine, number)| (machine.to_owned(), number)),
            sender: sender.cloned(),
            admit_run: read.admit_run.clone(),
        };
        let deliveries = &self.deliveries;
        let mut room = None;

        'read: loop {
            if cancel.is_requested() {
                return Err(read_cancelled());
            }
            if read.admit_by.is_some_and(|until| until <= Instant::now()) {
                return Err(read_before_deadline());
            }
            let until = wait.as_ref().map(|(until, _)| *until).or(read.admit_by);
            if wait
                .as_ref()
                .is_some_and(|(until, _)| *until <= Instant::now())
            {
                break;
            }
            let planning = async {
                let budget = deliveries
                    .page_budget
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(ErrorBody::internal)?;
                let _reading = deliveries.table.read_turn().await;
                let at = facade_base::time::iso_now();
                let page = query.arguments(&deliveries.machine_id, &at);
                let messages = blocking_in_place(|| match sender {
                    Some(sender) => deliveries.table.readable_replies(owner, &page, sender),
                    None => deliveries.table.readable_inbox(owner, &page),
                })
                .map_err(ErrorBody::internal)?;
                Ok::<_, ErrorBody>((budget, messages))
            };
            let stop = stop_before_effect(
                until,
                cancel.clone(),
                read.relay.as_ref().map(|relay| relay.closing()),
            );
            let (budget, messages) = tokio::select! {
                biased;
                reason = stop => {
                    drop(room.take());
                    if retry_read(reason, read.relay.as_deref(), until, &cancel).await? {
                        continue 'read;
                    }
                    if wait.is_some() { break 'read; }
                    return Err(read_before_deadline());
                }
                ready = planning => ready?,
            };
            let reservation = if !messages.is_empty() || wait.is_none() {
                drop(reply_wait.take());
                let snapshot = query.snapshot(deliveries, messages);
                match project(&snapshot, room.take())? {
                    InboxSelection::Ready {
                        count,
                        result,
                        enqueue,
                    } => {
                        if count == 0 {
                            return Ok(result);
                        }
                        if count > snapshot.messages.len() {
                            return Err(ErrorBody::internal(
                                "inbox projection returned more than its candidate page",
                            ));
                        }
                        let link = enqueue.as_ref().map(|answer| answer.link.clone());
                        match deliveries
                            .clone()
                            .take_projected_page(ProjectedPage {
                                query: query.clone(),
                                snapshot,
                                count,
                                result,
                                reply: enqueue,
                                until,
                                cancel: cancel.clone(),
                                budget,
                            })
                            .await?
                        {
                            Taken::Page(result) => return Ok(result),
                            Taken::Again => continue 'read,
                            Taken::Expired if wait.is_some() => break 'read,
                            Taken::Expired => return Err(read_before_deadline()),
                            Taken::Paused => {
                                let relay = link.expect("only relay read pages wait to thaw");
                                if resume_read(&relay, until, cancel.clone()).await? {
                                    continue 'read;
                                }
                                if wait.is_some() {
                                    break 'read;
                                }
                                return Err(read_before_deadline());
                            }
                        }
                    }
                    InboxSelection::Wait(reservation) => {
                        drop(budget);
                        Some(reservation)
                    }
                }
            } else {
                drop(budget);
                if is_guest
                    && reply_wait.is_none()
                    && let Some((until, _)) = &wait
                    && let Some(reference) = &read.reply_to
                {
                    let waiting = Arc::new(GuestReplyWait {
                        reference: reference.clone(),
                        until: *until,
                        cancel: cancel.clone(),
                        relay: read.relay.clone(),
                    });
                    match deliveries
                        .clone()
                        .register_guest_wait(query.clone(), waiting.clone())
                        .await?
                    {
                        Ok(true) => reply_wait = Some(waiting),
                        Ok(false) => continue 'read,
                        Err(stopped) => {
                            if retry_read(stopped, read.relay.as_deref(), Some(*until), &cancel)
                                .await?
                            {
                                continue 'read;
                            }
                            break 'read;
                        }
                    }
                }
                None
            };

            if let Some(reservation) = reservation {
                let stop = stop_before_effect(
                    until,
                    cancel.clone(),
                    read.relay.as_ref().map(|relay| relay.closing()),
                );
                let granted = tokio::select! {
                    biased;
                    stopped = stop => Err(stopped),
                    ready = reservation => Ok(ready?),
                };
                match granted {
                    Ok(granted) => room = Some(granted),
                    Err(stopped) => {
                        if !retry_read(stopped, read.relay.as_deref(), until, &cancel).await? {
                            if wait.is_some() {
                                break 'read;
                            }
                            return Err(read_before_deadline());
                        }
                    }
                }
                continue;
            }

            drop(room.take());
            let Some((until, changes)) = &mut wait else {
                break;
            };
            loop {
                tokio::select! {
                    biased;
                    () = cancel.requested() => return Err(read_cancelled()),
                    () = tokio::time::sleep_until(*until) => break 'read,
                    change = changes.recv() => match change {
                        Ok(change) if change.to() == owner => break,
                        Ok(_) => {},
                        Err(RecvError::Lagged(_)) => break,
                        Err(RecvError::Closed) => break 'read,
                    },
                }
            }
        }
        drop(reply_wait);
        match project(&MessagesSnapshot::default(), room)? {
            InboxSelection::Ready { result, .. } => Ok(result),
            InboxSelection::Wait(_) => Err(ErrorBody::internal("an empty page waits for room")),
        }
    }

    /// Finds the marked command request in the original recipient's local mailbox.
    pub(crate) fn command_request(
        &self,
        owner: &str,
        reference: &MessageRef,
    ) -> Result<Option<CommandRequest>, ErrorBody> {
        let deliveries = &self.deliveries;
        if reference.machine_id != deliveries.machine_id {
            return Ok(None);
        }
        let Some(number) = stored_number(&reference.message_id) else {
            return Ok(None);
        };
        blocking_in_place(|| deliveries.table.command_request(owner, number))
            .map_err(ErrorBody::internal)
    }

    /// Reads `owner`'s inbox as `args` select, oldest first. Each message read that was not yet
    /// delivered is delivered by this read, in the table before the read returns: one its typist
    /// had not begun is never typed, and one it was typing finishes with what reached the terminal
    /// unknown.
    #[cfg(test)]
    pub(crate) fn read(
        &self,
        owner: &str,
        args: &MessagesWatchArgs,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        let mut open = self.deliveries.lock();
        let mut snapshot = self.snapshot(owner, args)?;
        self.deliveries.deliver_read(
            &mut open.agents,
            &mut snapshot.messages,
            &facade_base::time::iso_now(),
        )?;
        Ok(snapshot)
    }

    /// Looks up the original message in its recipient's inbox. A window replying to a message
    /// for the person must appear on that message's delivery receipt.
    pub(crate) fn reply_in_inbox(
        &self,
        owner: &str,
        reference: &MessageRef,
        window: Option<&WindowRef>,
    ) -> Result<Option<Message>, ErrorBody> {
        if reference.machine_id != self.deliveries.machine_id {
            return Ok(None);
        }
        let Some(number) = parse_number(&reference.message_id) else {
            return Ok(None);
        };
        let kept = blocking_in_place(|| self.deliveries.table.inbox_message(owner, number))
            .map_err(ErrorBody::internal)?;
        Ok(kept
            .filter(|kept| {
                window.is_none_or(|window| {
                    kept.window_delivery.as_ref().is_some_and(|outcomes| {
                        outcomes
                            .iter()
                            .any(|outcome| outcome.is_delivered() && outcome.window() == window)
                    })
                })
            })
            .map(|kept| kept.message))
    }

    #[cfg(test)]
    fn snapshot(
        &self,
        owner: &str,
        args: &MessagesWatchArgs,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        let limit = usize::from(page_limit(args)?);
        let after = args.cursor.as_deref().map(cursor_number).transpose()?;
        let mut snapshot = if let Some(last) = args.last {
            if args.ids.is_some() || after.is_some() || args.limit.is_some() {
                return Err(ErrorBody::invalid_argument(
                    "last selects messages itself; leave out ids, cursor and limit",
                ));
            }
            self.last(owner, args.all, usize::from(last_limit(last)?))
        } else {
            match &args.ids {
                Some(ids) => self.by_ids(owner, ids, args),
                None => self.page(owner, after.unwrap_or(0), args.all, limit),
            }
        }?;
        for message in &mut snapshot.messages {
            self.deliveries.identify(message);
        }
        Ok(snapshot)
    }

    /// The messages among `ids` in `inbox`, and the IDs not found there.
    #[cfg(test)]
    fn by_ids(
        &self,
        owner: &str,
        ids: &[String],
        args: &MessagesWatchArgs,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        if args.all || args.cursor.is_some() {
            return Err(ErrorBody::invalid_argument(
                "ids selects messages itself; leave out all and cursor",
            ));
        }
        if ids.is_empty() || ids.len() > MAX_MESSAGE_IDS {
            return Err(ErrorBody::invalid_argument(format!(
                "ids takes 1 to {MAX_MESSAGE_IDS} message IDs"
            )));
        }
        let wanted: Vec<u64> = ids.iter().filter_map(|id| parse_number(id)).collect();
        let table = &self.deliveries.table;
        let messages = blocking_in_place(|| table.inbox_messages(owner, &wanted))
            .map_err(ErrorBody::internal)?;
        let found = |id: &String| {
            parse_number(id).is_some_and(|wanted| messages.iter().any(|m| number(m) == wanted))
        };
        let not_found: Vec<String> = ids.iter().filter(|id| !found(id)).cloned().collect();
        if messages.is_empty() {
            return Err(ErrorBody::new(
                Reason::NotFound,
                format!("no message {} is in this inbox", not_found.join(", ")),
            ));
        }
        Ok(MessagesSnapshot {
            messages,
            not_found,
            next_cursor: None,
        })
    }

    /// Up to `limit` messages of `owner`'s inbox after number `after`: undelivered messages by
    /// default.
    #[cfg(test)]
    fn page(
        &self,
        owner: &str,
        after: u64,
        all: bool,
        limit: usize,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        let table = &self.deliveries.table;
        let mut messages = blocking_in_place(|| table.inbox_page(owner, after, all, limit + 1))
            .map_err(ErrorBody::internal)?;
        let next_cursor = page_cursor(&mut messages, limit);
        Ok(MessagesSnapshot {
            messages,
            not_found: Vec::new(),
            next_cursor,
        })
    }

    /// The newest `last` messages of `owner`'s inbox, oldest first: of every message where `all`,
    /// else of those not yet delivered.
    #[cfg(test)]
    fn last(&self, owner: &str, all: bool, last: usize) -> Result<MessagesSnapshot, ErrorBody> {
        let table = &self.deliveries.table;
        let messages = blocking_in_place(|| table.inbox_last(owner, all, last))
            .map_err(ErrorBody::internal)?;
        Ok(MessagesSnapshot {
            messages,
            not_found: Vec::new(),
            next_cursor: None,
        })
    }

    /// Takes every message not yet delivered to `owner`, oldest first, delivering them as a read
    /// does.
    #[cfg(test)]
    pub(crate) fn take(&self, owner: &str) -> Result<Vec<Message>, ErrorBody> {
        let undelivered = MessagesWatchArgs {
            limit: Some(MAX_MESSAGES_LIMIT),
            ..MessagesWatchArgs::default()
        };
        let mut taken = Vec::new();
        loop {
            let page = self.read(owner, &undelivered)?;
            taken.extend(page.messages);
            if page.next_cursor.is_none() {
                return Ok(taken);
            }
        }
    }

    /// Every message in `owner`'s inbox as it stands, oldest first, delivering none.
    #[cfg(test)]
    pub(crate) fn inbox(&self, owner: &str) -> Vec<Message> {
        blocking_in_place(|| self.deliveries.table.inbox(owner)).unwrap_or_else(|err| {
            warn(&format!("{err:#}"));
            Vec::new()
        })
    }

    /// Lets go of the deliveries to `owner`, whose inbox the daemon deleted with it, and tells
    /// watchers that each message `gone` is. Sends waiting on its messages learn they went with it.
    #[cfg(test)]
    pub(crate) fn drop_inbox(&self, owner: &str, gone: Vec<Gone>) {
        self.deliveries.forget_inbox(owner, gone);
    }

    pub(crate) async fn remove_inbox(
        &self,
        owner: String,
        remove: impl FnOnce() -> anyhow::Result<Vec<Gone>> + Send + 'static,
    ) -> Result<(), ErrorBody> {
        let deliveries = self.deliveries.clone();
        self.ordered(0, move || {
            let gone = remove()?;
            deliveries.forget_inbox(&owner, gone);
            Ok(())
        })
        .await
    }

    /// Deletes the messages older than [`KEPT_FOR`] at `now`, telling watchers each is gone.
    /// Returns how many it deleted.
    pub(crate) async fn expire(&self, now: SystemTime) -> Result<usize, ErrorBody> {
        let before = now.checked_sub(KEPT_FOR).unwrap_or(SystemTime::UNIX_EPOCH);
        let before = facade_base::time::iso_time(before);
        let deliveries = self.deliveries.clone();
        self.ordered(0, move || {
            let gone = deliveries
                .table
                .expire_messages(&before, an_hour_ago, send_route_cutoff)?;
            let count = gone.len();
            for message in gone {
                deliveries.removed(message.to);
            }
            Ok(count)
        })
        .await
    }
}

impl Deliveries {
    fn forget_inbox(&self, owner: &str, gone: Vec<Gone>) {
        let mut open = self.lock();
        open.guest_reply_waits.remove(owner);
        open.agents
            .retain(|_, delivery| delivery.message.to != owner);
        for message in gone {
            self.removed(message.to);
        }
    }
    async fn take_projected_page<T: Send + 'static>(
        self: Arc<Self>,
        page: ProjectedPage<T>,
    ) -> Result<Taken<T>, ErrorBody> {
        let stop = stop_before_effect(
            page.until,
            page.cancel.clone(),
            page.reply.as_ref().map(|reply| reply.link.closing()),
        );
        let deliveries = self.clone();
        // This operation owns the page budget taken before any snapshot or encoded frame was
        // allocated. The ordinary queue's byte permits are for message bodies.
        match self
            .writer
            .before_effect(Lane::Ordered, 0, page, stop, None, move |batch, page| {
                deliveries.stage_projected_page(batch, page)
            })
            .await?
        {
            Effect::Answered(page) => Ok(page),
            Effect::Stopped(_, EffectStop::Cancelled) => Err(read_cancelled()),
            Effect::Stopped(_, EffectStop::Expired) => Ok(Taken::Expired),
            Effect::Stopped(_, EffectStop::Frozen) => Ok(Taken::Paused),
        }
    }

    fn stage_projected_page<T: Send + 'static>(
        self: Arc<Self>,
        batch: &mut crate::store::Batch<'_>,
        page: PendingEffect<ProjectedPage<T>>,
    ) -> rusqlite::Result<Prepared<Taken<T>>> {
        let Some(query) = page.lock().unwrap().as_ref().map(|page| page.query.clone()) else {
            return Ok(Prepared::known(Err(read_cancelled())));
        };
        let at = facade_base::time::iso_now();
        let arguments = query.arguments(&self.machine_id, &at);
        let current = match MessageTable::read_page_in(
            batch,
            &query.owner,
            &arguments,
            query.sender.as_ref(),
        )? {
            Ok(messages) => query.snapshot(&self, messages),
            Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
        };

        let Some(page) = page.lock().unwrap().take() else {
            return Ok(Prepared::known(Err(read_cancelled())));
        };
        let ProjectedPage {
            snapshot,
            count,
            result,
            reply,
            until,
            cancel,
            budget,
            ..
        } = page;
        if current.messages != snapshot.messages || current.next_cursor != snapshot.next_cursor {
            return Ok(Prepared::known(Ok(Taken::Again)));
        }
        drop(current);
        if cancel.is_requested() {
            return Ok(Prepared::known(Err(read_cancelled())));
        }
        if query.admit_run.as_ref().is_some_and(|check| !check()) {
            return Ok(Prepared::known(Err(ErrorBody::new(
                Reason::Unavailable,
                "this relay's run has ended",
            ))));
        }
        if until.is_some_and(|until| until <= Instant::now()) {
            return Ok(Prepared::known(Ok(Taken::Expired)));
        }
        let send = match reply {
            Some(reply) => match reply.claim() {
                Ok(Some(send)) => Some(send),
                Ok(None) => return Ok(Prepared::known(Ok(Taken::Paused))),
                Err(error) => return Ok(Prepared::known(Err(error))),
            },
            None => None,
        };
        let delivered: Vec<Message> = snapshot
            .messages
            .into_iter()
            .take(count)
            .filter_map(|mut message| {
                if message.delivery.status == DeliveryStatus::Success {
                    return None;
                }
                message.delivery = read_delivery(&message.delivery, false, &at);
                Some(message)
            })
            .collect();
        let writes: Vec<_> = delivered
            .iter()
            .map(|message| (number(message), &message.delivery))
            .collect();
        let (written, facts) = match MessageTable::take_page_in(batch, &writes)? {
            Ok(written) => written,
            Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
        };
        Ok(Prepared::changed(
            move |connection| facts.states(connection),
            move |committed| {
                committed.require()?;
                pause_for_test("after-read-commit");
                {
                    let mut open = self.lock();
                    for message in delivered {
                        if !written.settled.contains(&number(&message)) {
                            continue;
                        }
                        if let Some(ended) = open.agents.remove(&number(&message)) {
                            ended
                                .settled
                                .send_replace(Some(Settled::Kept(Box::new(message.clone()))));
                        }
                        self.updated(&message);
                    }
                }
                if let Some(send) = send {
                    send();
                }
                drop(budget);
                Ok(Taken::Page(result))
            },
        ))
    }

    async fn register_guest_wait(
        self: Arc<Self>,
        query: PageQuery,
        waiting: Arc<GuestReplyWait>,
    ) -> Result<Result<bool, EffectStop>, ErrorBody> {
        let stop = stop_before_effect(
            Some(waiting.until),
            waiting.cancel.clone(),
            waiting.relay.as_ref().map(|relay| relay.closing()),
        );
        let deliveries = self.clone();
        let claim = self
            .writer
            .before_effect(
                Lane::Ordered,
                0,
                waiting.clone(),
                stop,
                None,
                move |batch, plan| {
                    // The query establishes order. Withdrawal can still win before publication.
                    if !plan
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|waiting| waiting.active())
                    {
                        return Ok(Prepared::known(Ok(false)));
                    }
                    let at = facade_base::time::iso_now();
                    let arguments = query.arguments(&deliveries.machine_id, &at);
                    let empty = match MessageTable::read_page_in(
                        batch,
                        &query.owner,
                        &arguments,
                        query.sender.as_ref(),
                    )? {
                        Ok(messages) => messages.is_empty(),
                        Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
                    };
                    Ok(Prepared {
                        witness: None,
                        finish: Box::new(move |committed| {
                            committed.require()?;
                            if empty
                                && let Some(waiting) = plan.lock().unwrap().take()
                                && waiting.active()
                            {
                                let mut open = deliveries.lock();
                                for delivery in open
                                    .agents
                                    .values_mut()
                                    .filter(|delivery| delivery.message.to == query.owner)
                                {
                                    delivery.note_reply_wait(&waiting, &deliveries.machine_id, &at);
                                }
                                open.guest_reply_waits
                                    .insert(query.owner, Arc::downgrade(&waiting));
                            }
                            Ok(empty)
                        }),
                    })
                },
            )
            .await?;
        Ok(match claim {
            Effect::Answered(registered) => waiting.stopped().map_or(Ok(registered), Err),
            Effect::Stopped(_, stopped) => Err(stopped),
        })
    }

    /// Delivers unread messages, clears any prompt result debts, and tells their sends.
    #[cfg(test)]
    fn deliver_read(
        &self,
        open: &mut OpenMap,
        messages: &mut [Message],
        at: &str,
    ) -> Result<(), ErrorBody> {
        let mut delivered = Vec::new();
        for message in messages.iter_mut() {
            if message.delivery.status == DeliveryStatus::Success {
                continue;
            }
            let typing = open
                .get(&number(message))
                .is_some_and(|delivery| delivery.pasted);
            message.delivery = read_delivery(&message.delivery, typing, at);
            delivered.push(&*message);
        }
        if delivered.is_empty() {
            return Ok(());
        }
        let writes: Vec<(u64, &Delivery)> = delivered
            .iter()
            .map(|message| (number(message), &message.delivery))
            .collect();
        blocking_in_place(|| self.table.record_reads(&writes, &[])).map_err(ErrorBody::internal)?;
        pause_for_test("after-read-commit");
        for message in delivered {
            if let Some(ended) = open.remove(&number(message)) {
                ended
                    .settled
                    .send_replace(Some(Settled::Kept(Box::new(message.clone()))));
            }
            self.updated(message);
        }
        Ok(())
    }
}

fn read_cancelled() -> ErrorBody {
    ErrorBody::new(Reason::Cancelled, "the inbox read was cancelled")
}

pub(crate) fn read_before_deadline() -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        "the inbox read expired before Facade could take it",
    )
}

fn stored_number(id: &str) -> Option<u64> {
    parse_number(id).filter(|number| i64::try_from(*number).is_ok())
}

fn cursor_number(cursor: &str) -> Result<u64, ErrorBody> {
    stored_number(cursor).ok_or_else(|| {
        ErrorBody::invalid_argument(format!("{cursor} is not a cursor this inbox gave"))
    })
}

fn page_cursor(messages: &mut Vec<Message>, limit: usize) -> Option<String> {
    if messages.len() <= limit {
        return None;
    }
    messages.truncate(limit);
    messages.last().map(|last| last.message_id.clone())
}

fn last_limit(last: u16) -> Result<u16, ErrorBody> {
    if (1..=MAX_MESSAGES_LIMIT).contains(&last) {
        Ok(last)
    } else {
        Err(ErrorBody::invalid_argument(format!(
            "last must be between 1 and {MAX_MESSAGES_LIMIT}"
        )))
    }
}

/// The page size `args` ask for.
#[cfg(test)]
fn page_limit(args: &MessagesWatchArgs) -> Result<u16, ErrorBody> {
    let limit = args.limit.unwrap_or(DEFAULT_MESSAGES_LIMIT);
    if (1..=MAX_MESSAGES_LIMIT).contains(&limit) {
        Ok(limit)
    } else {
        Err(ErrorBody::invalid_argument(format!(
            "limit must be between 1 and {MAX_MESSAGES_LIMIT}"
        )))
    }
}
