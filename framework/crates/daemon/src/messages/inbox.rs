//! Reading inboxes, and messages leaving them.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::SystemTime;

use facade_base::model::agent::AgentRef;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::MessageRef;
#[cfg(test)]
use facade_base::model::message::{MAX_MESSAGE_IDS, MessagesWatchArgs};
use facade_base::{
    model::machine::WindowRef,
    model::message::{
        DEFAULT_MESSAGES_LIMIT, Delivery, DeliveryStatus, MAX_MESSAGES_LIMIT, Message,
        MessagesSnapshot,
    },
};
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::outcome::read_delivery;
#[cfg(test)]
use super::warn;
use super::{
    Deliveries, Due, GuestReplyWait, KEPT_FOR, Messages, OpenMap, Settled, number, parse_number,
};
use crate::store::{CommandRequest, Gone, InboxPage};
use crate::{Cancel, an_hour_ago, blocking_in_place, pause_for_test, send_route_cutoff};

/// Selection for an inbox read. Cursors name local inbox messages, replies use stable references.
#[derive(Default)]
pub(crate) struct InboxRead {
    pub(crate) after: Option<String>,
    pub(crate) last: Option<u16>,
    pub(crate) reply_to: Option<MessageRef>,
    pub(crate) wait_until: Option<Instant>,
    /// A snapshot also has a budget for acquiring room for its reply.
    pub(crate) admit_by: Option<Instant>,
}

/// Selection for the first reply from the recipient of a specific send.
pub(crate) struct ReplyRead {
    pub(crate) original: MessageRef,
    pub(crate) sender: AgentRef,
    pub(crate) wait_until: Instant,
}

/// An inbox page may become delivered only once the client has room for its complete answer.
pub(crate) enum InboxSelection<T, Room> {
    Ready {
        count: usize,
        result: T,
        enqueue: Option<Box<dyn FnOnce() + Send>>,
    },
    Wait(Pin<Box<dyn Future<Output = Result<Room, ErrorBody>> + Send>>),
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

#[derive(Clone, Copy)]
enum ReadMode {
    /// A read of the earlier `messages` call, which unit tests still make.
    #[cfg(test)]
    Compatibility,
    Unstarted,
}

impl Messages {
    /// Projects whole messages before committing the delivered prefix. A waiting read subscribes
    /// before checking so a post can wake it even if it arrives while the check is in progress.
    pub(crate) async fn read_inbox<T, Room: Send>(
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
    pub(crate) async fn read_first_reply<T, Room: Send>(
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
            ..InboxRead::default()
        };
        self.read_selected(owner, is_guest, inbox, Some(&read.sender), cancel, project)
            .await
    }

    async fn read_selected<T, Room: Send>(
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
        let deliveries = &self.deliveries;
        let limit = usize::from(DEFAULT_MESSAGES_LIMIT);
        let mut room = None;

        'read: loop {
            let reservation = {
                let mut open = deliveries.lock();
                if cancel.is_requested() {
                    return Err(read_cancelled());
                }
                if read.admit_by.is_some_and(|until| until <= Instant::now()) {
                    return Err(read_before_deadline());
                }
                if wait
                    .as_ref()
                    .is_some_and(|(until, _)| *until <= Instant::now())
                {
                    break;
                }
                let at = facade_base::time::iso_now();
                let page = InboxPage {
                    machine_id: &deliveries.machine_id,
                    after,
                    last,
                    limit: if sender.is_some() { 1 } else { limit + 1 },
                    reply_to,
                    now: &at,
                };
                let mut messages = blocking_in_place(|| match sender {
                    Some(sender) => deliveries.table.readable_replies(owner, &page, sender),
                    None => deliveries.table.readable_inbox(owner, &page),
                })
                .map_err(ErrorBody::internal)?;
                if !messages.is_empty() || wait.is_none() {
                    drop(reply_wait.take());
                    let next_cursor = page_cursor(&mut messages, last.unwrap_or(limit));
                    for message in &mut messages {
                        deliveries.identify(message);
                    }
                    let mut snapshot = MessagesSnapshot {
                        messages,
                        next_cursor,
                        ..MessagesSnapshot::default()
                    };
                    match project(&snapshot, room.take())? {
                        InboxSelection::Ready {
                            count,
                            result,
                            enqueue,
                        } => {
                            if cancel.is_requested() {
                                return Err(read_cancelled());
                            }
                            if read.admit_by.is_some_and(|until| until <= Instant::now()) {
                                return Err(read_before_deadline());
                            }
                            let prefix = snapshot.messages.get_mut(..count).ok_or_else(|| {
                                ErrorBody::internal(
                                    "inbox projection returned more than its candidate page",
                                )
                            })?;
                            deliveries.deliver_read(
                                &mut open.agents,
                                prefix,
                                &at,
                                ReadMode::Unstarted,
                            )?;
                            drop(open);
                            if let Some(enqueue) = enqueue {
                                enqueue();
                            }
                            return Ok(result);
                        }
                        InboxSelection::Wait(reservation) => Some(reservation),
                    }
                } else if is_guest
                    && reply_wait.is_none()
                    && let Some((until, _)) = &wait
                    && let Some(reference) = &read.reply_to
                {
                    let waiting = Arc::new(GuestReplyWait {
                        reference: reference.clone(),
                        until: *until,
                        cancel: cancel.clone(),
                    });
                    if waiting.active() {
                        let at = facade_base::time::iso_now();
                        for delivery in open
                            .agents
                            .values_mut()
                            .filter(|delivery| delivery.message.to == owner)
                        {
                            delivery.note_reply_wait(&waiting, &deliveries.machine_id, &at);
                        }
                        open.guest_reply_waits
                            .insert(owner.to_owned(), Arc::downgrade(&waiting));
                        reply_wait = Some(waiting);
                    }
                    None
                } else {
                    None
                }
            };

            if let Some(reservation) = reservation {
                let granted =
                    if let Some(until) = wait.as_ref().map(|(until, _)| *until).or(read.admit_by) {
                        tokio::select! {
                            biased;
                            () = cancel.requested() => return Err(read_cancelled()),
                            () = tokio::time::sleep_until(until) => {
                                if wait.is_some() { break 'read; }
                                return Err(read_before_deadline());
                            }
                            ready = reservation => ready?,
                        }
                    } else {
                        tokio::select! {
                            biased;
                            () = cancel.requested() => return Err(read_cancelled()),
                            ready = reservation => ready?,
                        }
                    };
                room = Some(granted);
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
            ReadMode::Compatibility,
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
    pub(crate) fn drop_inbox(&self, owner: &str, gone: Vec<Gone>) {
        let mut open = self.deliveries.lock();
        open.guest_reply_waits.remove(owner);
        open.agents
            .retain(|_, delivery| delivery.message.to != owner);
        for message in gone {
            self.deliveries.removed(message.to);
        }
    }

    /// Deletes the messages older than [`KEPT_FOR`] at `now`, telling watchers each is gone.
    /// Returns how many it deleted.
    pub(crate) fn expire(&self, now: SystemTime) -> anyhow::Result<usize> {
        let before = now.checked_sub(KEPT_FOR).unwrap_or(SystemTime::UNIX_EPOCH);
        let before = facade_base::time::iso_time(before);
        let _open = self.deliveries.lock();
        let gone = blocking_in_place(|| {
            self.deliveries
                .table
                .expire_messages(&before, an_hour_ago, send_route_cutoff)
        })?;
        let count = gone.len();
        for message in gone {
            self.deliveries.removed(message.to);
        }
        Ok(count)
    }
}

impl Deliveries {
    /// Delivers unread messages, clears any prompt result debts, and tells their sends.
    fn deliver_read(
        &self,
        open: &mut OpenMap,
        messages: &mut [Message],
        at: &str,
        mode: ReadMode,
    ) -> Result<(), ErrorBody> {
        let mut delivered = Vec::new();
        for message in messages.iter_mut() {
            if message.delivery.status == DeliveryStatus::Success
                || (matches!(mode, ReadMode::Unstarted)
                    && message.delivery.status == DeliveryStatus::Failure
                    && message.delivery.enter_written != Some(false))
            {
                continue;
            }
            let typing = match mode {
                #[cfg(test)]
                ReadMode::Compatibility => open
                    .get(&number(message))
                    .is_some_and(|delivery| delivery.pasted),
                ReadMode::Unstarted => false,
            };
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
        let recorded = blocking_in_place(|| match mode {
            #[cfg(test)]
            ReadMode::Compatibility => self.table.record_reads(&writes, &[]),
            ReadMode::Unstarted => self.table.record_unstarted_reads(&writes),
        })
        .map_err(ErrorBody::internal)?;
        pause_for_test("after-read-commit");
        for message in delivered {
            if matches!(mode, ReadMode::Unstarted) && !recorded.settled.contains(&number(message)) {
                continue;
            }
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
