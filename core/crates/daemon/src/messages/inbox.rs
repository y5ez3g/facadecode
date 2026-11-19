//! Reading inboxes, and messages leaving them.

use std::time::SystemTime;

use facade_base::daemon::{
    DEFAULT_MESSAGES_LIMIT, Delivery, DeliveryStatus, MAX_MESSAGE_IDS, MAX_MESSAGES_LIMIT, Message,
    MessagesSnapshot, MessagesWatchArgs, WindowRef,
};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::MessageRef;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::outcome::read_delivery;
use super::settle::owed_results;
use super::{Deliveries, Due, KEPT_FOR, Messages, OpenMap, Settled, number, parse_number, warn};
use crate::store::{Gone, InboxPage};
use crate::{Cancel, blocking_in_place, pause_for_test};

/// Selection for an inbox read. Cursors name local inbox messages, replies use stable references.
#[derive(Default)]
pub(crate) struct InboxRead {
    pub(crate) after: Option<String>,
    pub(crate) last: Option<u16>,
    pub(crate) reply_to: Option<MessageRef>,
    pub(crate) wait_until: Option<Instant>,
}

enum Inbox<'a> {
    Recipient(&'a str),
    Window(&'a WindowRef),
}

#[derive(Clone, Copy)]
enum ReadMode {
    Compatibility,
    Unstarted,
}

impl Messages {
    /// Projects whole messages before committing the delivered prefix. A waiting read subscribes
    /// before checking so a post can wake it even if it arrives while the check is in progress.
    #[allow(dead_code)] // The verified relay is wired in separately.
    pub(crate) async fn read_inbox<T>(
        &self,
        owner: &str,
        read: InboxRead,
        mut cancel: Cancel,
        project: impl Fn(&MessagesSnapshot) -> Result<(usize, T), ErrorBody> + Send,
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
        let mut wait = read
            .wait_until
            .map(|until| (Due::inbox_wait(until), self.subscribe()));
        let deliveries = &self.deliveries;
        let limit = usize::from(DEFAULT_MESSAGES_LIMIT);

        'read: loop {
            {
                let mut open = deliveries.lock();
                if cancel.is_requested() {
                    return Err(read_cancelled());
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
                    limit: limit + 1,
                    reply_to,
                    now: &at,
                };
                let mut messages =
                    blocking_in_place(|| deliveries.table.readable_inbox(owner, &page))
                        .map_err(ErrorBody::internal)?;
                if !messages.is_empty() || wait.is_none() {
                    let next_cursor = page_cursor(&mut messages, last.unwrap_or(limit));
                    for message in &mut messages {
                        deliveries.identify(message);
                    }
                    let mut snapshot = MessagesSnapshot {
                        messages,
                        next_cursor,
                        ..MessagesSnapshot::default()
                    };
                    let (count, result) = project(&snapshot)?;
                    if cancel.is_requested() {
                        return Err(read_cancelled());
                    }
                    let prefix = snapshot.messages.get_mut(..count).ok_or_else(|| {
                        ErrorBody::internal(
                            "inbox projection returned more than its candidate page",
                        )
                    })?;
                    deliveries.deliver_read(&mut open.agents, prefix, &at, ReadMode::Unstarted)?;
                    return Ok(result);
                }
            }

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
        project(&MessagesSnapshot::default()).map(|(_, result)| result)
    }

    /// Reads `owner`'s inbox as `args` select, oldest first. Each message read that was not yet
    /// delivered is delivered by this read, in the table before the read returns: one its typist
    /// had not begun is never typed, and one it was typing finishes with what reached the terminal
    /// unknown.
    pub(crate) fn read(
        &self,
        owner: &str,
        args: &MessagesWatchArgs,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        let mut open = self.deliveries.lock();
        let mut snapshot = self.snapshot(Inbox::Recipient(owner), args)?;
        self.deliveries.deliver_read(
            &mut open.agents,
            &mut snapshot.messages,
            &facade_base::time::iso_now(),
            ReadMode::Compatibility,
        )?;
        Ok(snapshot)
    }

    /// Reads the history of messages already delivered to this window.
    pub(crate) fn read_human(
        &self,
        window: &WindowRef,
        args: &MessagesWatchArgs,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        self.snapshot(Inbox::Window(window), args)
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

    fn snapshot(
        &self,
        inbox: Inbox<'_>,
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
            self.last(inbox, args.all, usize::from(last_limit(last)?))
        } else {
            match &args.ids {
                Some(ids) => self.by_ids(inbox, ids, args),
                None => self.page(inbox, after.unwrap_or(0), args.all, limit),
            }
        }?;
        for message in &mut snapshot.messages {
            self.deliveries.identify(message);
        }
        Ok(snapshot)
    }

    /// The messages among `ids` in `inbox`, and the IDs not found there.
    fn by_ids(
        &self,
        inbox: Inbox<'_>,
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
        let messages = blocking_in_place(|| match inbox {
            Inbox::Recipient(owner) => table.inbox_messages(owner, &wanted),
            Inbox::Window(window) => {
                let mut messages = table.human_inbox(window)?;
                messages.retain(|message| wanted.contains(&number(message)));
                Ok(messages)
            }
        })
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

    /// Up to `limit` messages of `inbox` after number `after`. A recipient gets undelivered
    /// messages by default, and a window gets its delivery history.
    fn page(
        &self,
        inbox: Inbox<'_>,
        after: u64,
        all: bool,
        limit: usize,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        let table = &self.deliveries.table;
        let mut messages = blocking_in_place(|| match inbox {
            Inbox::Recipient(owner) => table.inbox_page(owner, after, all, limit + 1),
            Inbox::Window(window) => Ok(table
                .human_inbox(window)?
                .into_iter()
                .filter(|message| number(message) > after)
                .take(limit + 1)
                .collect()),
        })
        .map_err(ErrorBody::internal)?;
        let next_cursor = page_cursor(&mut messages, limit);
        Ok(MessagesSnapshot {
            messages,
            not_found: Vec::new(),
            next_cursor,
        })
    }

    /// The newest `last` messages of `inbox`, oldest first: of every message where `all`, else of
    /// those not yet delivered to a recipient.
    fn last(
        &self,
        inbox: Inbox<'_>,
        all: bool,
        last: usize,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        let table = &self.deliveries.table;
        let messages = blocking_in_place(|| match inbox {
            Inbox::Recipient(owner) => table.inbox_last(owner, all, last),
            Inbox::Window(window) => {
                let mut messages = table.human_inbox(window)?;
                messages.drain(..messages.len().saturating_sub(last));
                Ok(messages)
            }
        })
        .map_err(ErrorBody::internal)?;
        Ok(MessagesSnapshot {
            messages,
            not_found: Vec::new(),
            next_cursor: None,
        })
    }

    /// Takes every message not yet delivered to `owner`, oldest first, delivering them as a read
    /// does.
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
        open.agents
            .retain(|_, delivery| delivery.message.to != owner);
        for message in gone {
            self.deliveries
                .removed(format!("m{}", message.number), message.to);
        }
    }

    /// Deletes the messages older than [`KEPT_FOR`] at `now`, telling watchers each is gone.
    /// Returns how many it deleted.
    pub(crate) fn expire(&self, now: SystemTime) -> anyhow::Result<usize> {
        let before = now.checked_sub(KEPT_FOR).unwrap_or(SystemTime::UNIX_EPOCH);
        let before = facade_base::time::iso_time(before);
        let _open = self.deliveries.lock();
        let gone = blocking_in_place(|| self.deliveries.table.expire_messages(&before))?;
        let count = gone.len();
        for message in gone {
            self.deliveries
                .removed(format!("m{}", message.number), message.to);
        }
        Ok(count)
    }
}

impl Deliveries {
    /// Delivers, by this read, the messages among `messages` not delivered yet: writes their
    /// deliveries and the results they owe, tells their sends, and hands the results on.
    fn deliver_read(
        &self,
        open: &mut OpenMap,
        messages: &mut [Message],
        at: &str,
        mode: ReadMode,
    ) -> Result<(), ErrorBody> {
        let mut delivered = Vec::new();
        for message in messages.iter_mut() {
            if message.delivery.status == DeliveryStatus::Success {
                continue;
            }
            let typing = matches!(mode, ReadMode::Compatibility)
                && open
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
        let due = Due::now();
        let results = owed_results(open, &writes, at, &due);
        let recorded = blocking_in_place(|| match mode {
            ReadMode::Compatibility => self.table.record_reads(&writes, &results),
            ReadMode::Unstarted => self.table.record_unstarted_reads(&writes, &results),
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
        self.hand_on(open, results, &recorded.results, &due);
        Ok(())
    }
}

fn read_cancelled() -> ErrorBody {
    ErrorBody::new(Reason::Cancelled, "the inbox read was cancelled")
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
