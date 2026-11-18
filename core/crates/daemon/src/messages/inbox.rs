//! Reading inboxes, and messages leaving them.

use std::time::SystemTime;

use facade_base::daemon::{
    DEFAULT_MESSAGES_LIMIT, Delivery, DeliveryStatus, MAX_MESSAGE_IDS, MAX_MESSAGES_LIMIT, Message,
    MessagesSnapshot, MessagesWatchArgs, WindowRef,
};
use facade_base::jsonrpc::{ErrorBody, Reason};

use super::outcome::read_delivery;
use super::settle::owed_results;
use super::{Deliveries, Due, KEPT_FOR, Messages, OpenMap, Settled, number, parse_number, warn};
use crate::store::Gone;
use crate::{blocking_in_place, pause_for_test};

enum Inbox<'a> {
    Recipient(&'a str),
    Window(&'a WindowRef),
}

impl Messages {
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
        self.deliveries
            .deliver_read(&mut open.agents, &mut snapshot.messages)?;
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

    fn snapshot(
        &self,
        inbox: Inbox<'_>,
        args: &MessagesWatchArgs,
    ) -> Result<MessagesSnapshot, ErrorBody> {
        let limit = usize::from(page_limit(args)?);
        let after = args
            .cursor
            .as_deref()
            .map(|cursor| {
                parse_number(cursor).ok_or_else(|| {
                    ErrorBody::invalid_argument(format!("{cursor} is not a cursor this inbox gave"))
                })
            })
            .transpose()?;
        match &args.ids {
            Some(ids) => self.by_ids(inbox, ids, args),
            None => self.page(inbox, after.unwrap_or(0), args.all, limit),
        }
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
        let more = messages.len() > limit;
        messages.truncate(limit);
        let next_cursor = more
            .then(|| messages.last().map(|last| last.message_id.clone()))
            .flatten();
        Ok(MessagesSnapshot {
            messages,
            not_found: Vec::new(),
            next_cursor,
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
        for Gone { number, from, to } in gone {
            self.deliveries.removed(format!("m{number}"), from, to);
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
        for Gone { number, from, to } in gone {
            self.deliveries.removed(format!("m{number}"), from, to);
        }
        Ok(count)
    }
}

impl Deliveries {
    /// Delivers, by this read, the messages among `messages` not delivered yet: writes their
    /// deliveries and the results they owe, tells their sends, and hands the results on.
    fn deliver_read(&self, open: &mut OpenMap, messages: &mut [Message]) -> Result<(), ErrorBody> {
        let at = facade_base::time::iso_now();
        let mut read = Vec::new();
        for message in messages.iter_mut() {
            if message.delivery.status == DeliveryStatus::Success {
                continue;
            }
            let typing = open
                .get(&number(message))
                .is_some_and(|delivery| delivery.pasted);
            message.delivery = read_delivery(&message.delivery, typing, &at);
            read.push(number(message));
        }
        if read.is_empty() {
            return Ok(());
        }
        let delivered: Vec<&Message> = messages
            .iter()
            .filter(|message| read.contains(&number(message)))
            .collect();
        let writes: Vec<(u64, &Delivery)> = delivered
            .iter()
            .map(|message| (number(message), &message.delivery))
            .collect();
        let due = Due::now();
        let results = owed_results(open, &writes, &at, &due);
        let recorded = blocking_in_place(|| self.table.record_reads(&writes, &results))
            .map_err(ErrorBody::internal)?;
        pause_for_test("after-read-commit");
        for message in delivered {
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
