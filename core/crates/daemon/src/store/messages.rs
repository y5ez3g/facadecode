//! The `messages` table: every message of the last 30 days and what became of it. Its columns are
//! named after the protocol's `Message`, and values are kept by their protocol names. `paste` holds
//! the one fact the protocol does not show: once a message's paste began, the number of that
//! paste's first message, shared by all of its messages, so that a joined paste's text can be built
//! again after a restart. `from_window` keeps the sender's window as the message's header first
//! named it. `call_id` and `result` keep a result's call and its facts as JSON, and `result_owed`
//! the number a start's prompt keeps for the result it owes: the prompt's settlement writes that
//! result in the same transaction and clears it, so exactly one result follows.
//!
//! `request_id` keeps the sender's own ID of the send, where it gave one. The same sender's same ID
//! within the hour finds the message again through `messages_request`, in the transaction that
//! would keep a new one, so that two calls with one ID keep one message.
//!
//! A message takes its number in the transaction that writes it, so no message lacks one and no
//! number goes to two. Deleting messages never lowers the counter. A value this build does not
//! know reads as the protocol's `unknown` or `unrecognized`, never as `pending`; a row that cannot
//! be read at all is logged, skipped and left as it is.

use std::sync::Arc;

use facade_base::daemon::{Delivery, Message, WindowDelivery, WindowRef};
use facade_base::machine::{AgentRef, MessageRef};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::{Store, log};
use crate::HUMAN;

/// What a message not yet delivered satisfies. `messages_undelivered` holds the messages it
/// selects, and a query that repeats it uses that index.
const UNDELIVERED: &str = "status != 'success'";

/// The columns a message is read from and written to, in order.
const COLUMNS: &str = "number, \"from\", from_name, \"to\", text, reply_to, at, status, reason, \
                       text_written, enter_written, deadline, delivered_via, delivered_at, paste, \
                       from_window, call_id, result_owed, result, human_windows, \
                       from_machine_id, reply_to_machine_id, result_owed_machine_id";

/// Creates the table and its indexes. `messages_undelivered` lets reads scan only messages that
/// are still waiting.
pub(super) fn add_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(&format!(
        "CREATE TABLE messages (
			number INTEGER PRIMARY KEY,
			\"from\" TEXT NOT NULL,
			from_name TEXT,
			\"to\" TEXT NOT NULL,
			text TEXT NOT NULL,
			reply_to INTEGER,
			at TEXT NOT NULL,
			status TEXT NOT NULL,
			reason TEXT,
			text_written TEXT NOT NULL,
			enter_written INTEGER,
			deadline TEXT,
			delivered_via TEXT,
			delivered_at TEXT,
			paste INTEGER,
			from_window TEXT,
			call_id TEXT,
			result_owed INTEGER,
			result_owed_machine_id TEXT,
			result TEXT,
			request_id TEXT,
			request_window_id TEXT,
			human_windows TEXT,
			from_machine_id TEXT,
			reply_to_machine_id TEXT
		);
		CREATE INDEX messages_inbox ON messages (\"to\", number);
		CREATE INDEX messages_undelivered ON messages (\"to\", number) WHERE {UNDELIVERED};
		CREATE INDEX messages_request ON messages
		    (\"from\", from_machine_id, \"to\", request_window_id, request_id) WHERE request_id IS NOT NULL;"
    ))
}

/// A send's own ID as its sender gave it, and the earliest time at which a message it kept still
/// answers it: an hour before now.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RequestId<'a> {
    pub(crate) id: &'a str,
    pub(crate) since: &'a str,
    pub(crate) caller_window_id: Option<&'a str>,
}

/// What keeping a message with a request ID found: the message kept now, or the one its sender
/// kept with that ID before.
#[derive(Debug)]
pub(crate) enum Kept {
    New(Message),
    Earlier(KeptMessage),
}

#[cfg(test)]
impl Kept {
    /// The message kept now, or found.
    pub(crate) fn into_message(self) -> Message {
        match self {
            Kept::New(message) => message,
            Kept::Earlier(kept) => kept.message,
        }
    }
}

/// A kept message, with the paste it went in once its paste began, and for a start's prompt, the
/// number it keeps for the result it owes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeptMessage {
    pub(crate) message: Message,
    pub(crate) paste: Option<u64>,
    pub(crate) result_owed: Option<MessageRef>,
    /// The window subscriptions that took or refused a message to the person.
    pub(crate) human_windows: Option<WindowDelivery>,
}

/// A message deleted from the store: its number and recipient.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Gone {
    pub(crate) number: u64,
    pub(crate) to: String,
}

/// What a settlement wrote: the messages it settled, and the results their settlement wrote.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Settlement {
    pub(crate) settled: Vec<u64>,
    pub(crate) results: Vec<u64>,
}

/// A message's number, from its ID `m<number>`.
pub(super) fn number_of(message: &Message) -> u64 {
    message.message_id[1..].parse().expect("a numbered message")
}

/// A value's protocol name, as `serde` writes it.
fn name<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        _ => unreachable!("a protocol value is written as a name"),
    }
}

/// A value read from its protocol name. A name this build does not know reads as the type's own
/// fallback.
fn named<T: DeserializeOwned>(name: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(name)).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, err.into())
    })
}

fn read_message(row: &Row) -> rusqlite::Result<KeptMessage> {
    let number: i64 = row.get("number")?;
    let reply_to: Option<i64> = row.get("reply_to")?;
    let reason: Option<String> = row.get("reason")?;
    let via: Option<String> = row.get("delivered_via")?;
    let paste: Option<i64> = row.get("paste")?;
    let result_owed: Option<i64> = row.get("result_owed")?;
    let result_machine: Option<String> = row.get("result_owed_machine_id")?;
    // Facts this build cannot read leave a result its words.
    let result: Option<String> = row.get("result")?;
    let human_column = row.as_ref().column_index("human_windows")?;
    let human_windows = row
        .get::<_, Option<String>>(human_column)?
        .map(|windows| {
            serde_json::from_str(&windows).map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    human_column,
                    rusqlite::types::Type::Text,
                    err.into(),
                )
            })
        })
        .transpose()?;
    let delivery = Delivery {
        status: named(row.get("status")?)?,
        reason: reason.map(named).transpose()?,
        text_written: named(row.get("text_written")?)?,
        enter_written: row.get("enter_written")?,
        deadline: row.get("deadline")?,
        delivered_via: via.map(named).transpose()?,
        delivered_at: row.get("delivered_at")?,
    };
    Ok(KeptMessage {
        message: Message {
            message_id: format!("m{number}"),
            message_ref: None,
            from: row.get("from")?,
            from_name: row.get("from_name")?,
            from_machine_id: row.get("from_machine_id")?,
            to: row.get("to")?,
            text: row.get("text")?,
            reply_to: reply_to.map(|reply| format!("m{reply}")),
            reply_to_machine_id: row.get("reply_to_machine_id")?,
            from_window: row.get("from_window")?,
            call_id: row.get("call_id")?,
            result: result.and_then(|facts| serde_json::from_str(&facts).ok()),
            at: row.get("at")?,
            delivery,
        },
        paste: paste.map(|paste| paste as u64),
        result_owed: result_owed
            .zip(result_machine)
            .map(|(number, machine_id)| MessageRef {
                machine_id,
                message_id: format!("m{number}"),
            }),
        human_windows,
    })
}

/// Takes the next message number, in `connection`'s transaction.
fn take_number(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row(
        "UPDATE message_numbers SET next = next + 1 RETURNING next - 1",
        [],
        |row| row.get(0),
    )
}

/// Writes `message` as message `number`, with its send's request ID where it had one.
fn write(
    connection: &Connection,
    number: i64,
    message: &Message,
    request: Option<RequestId<'_>>,
) -> rusqlite::Result<()> {
    let delivery = &message.delivery;
    let reply_to = message
        .reply_to
        .as_deref()
        .and_then(|reply| reply.strip_prefix('m')?.parse::<i64>().ok());
    let result = message
        .result
        .as_ref()
        .map(|facts| serde_json::to_string(facts).expect("a result's facts are written as JSON"));
    connection.execute(
        &format!(
            "INSERT INTO messages ({COLUMNS}, request_id, request_window_id) VALUES
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?16,
              NULL, ?17, NULL, NULLIF(?18, (SELECT machine_id FROM machine)), ?19, NULL, ?20, ?21)"
        ),
        params![
            number,
            message.from,
            message.from_name,
            message.to,
            message.text,
            reply_to,
            message.at,
            name(&delivery.status),
            delivery.reason.as_ref().map(name),
            name(&delivery.text_written),
            delivery.enter_written,
            delivery.deadline,
            delivery.delivered_via.as_ref().map(name),
            delivery.delivered_at,
            message.from_window,
            message.call_id,
            result,
            message.from_machine_id,
            message.reply_to_machine_id,
            request.map(|request| request.id),
            request.and_then(|request| request.caller_window_id),
        ],
    )?;
    Ok(())
}

/// The message this caller kept for `to` with the same request ID within its hour.
fn find_request(
    connection: &Connection,
    from_machine_id: Option<&str>,
    from: &str,
    to: &str,
    request: RequestId,
) -> rusqlite::Result<Option<KeptMessage>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM messages WHERE \"from\" = ?1
         AND from_machine_id IS NULLIF(?2, (SELECT machine_id FROM machine)) AND \"to\" = ?3
         AND request_window_id IS ?4 AND request_id = ?5 AND at >= ?6 ORDER BY number LIMIT 1"
    ))?;
    let mut rows = statement.query(params![
        from,
        from_machine_id,
        to,
        request.caller_window_id,
        request.id,
        request.since
    ])?;
    rows.next()?.map(read_message).transpose()
}

/// Writes `message` under the next number, in `connection`'s transaction. Returns it with its ID.
pub(super) fn insert(connection: &Connection, message: &Message) -> rusqlite::Result<Message> {
    let number = take_number(connection)?;
    write(connection, number, message, None)?;
    Ok(Message {
        message_id: format!("m{number}"),
        ..message.clone()
    })
}

/// Takes the next number for the result prompt `prompt` owes and keeps it on the prompt, in
/// `connection`'s transaction.
pub(super) fn owe_result(
    connection: &Connection,
    prompt: u64,
    reserved: Option<(&str, i64)>,
) -> rusqlite::Result<MessageRef> {
    let (machine_id, number) = match reserved {
        Some((machine_id, number)) => (machine_id.to_string(), number),
        None => (local_machine(connection)?, take_number(connection)?),
    };
    connection.execute(
        "UPDATE messages SET result_owed = ?1, result_owed_machine_id = ?2 WHERE number = ?3",
        params![number, machine_id, prompt as i64],
    )?;
    Ok(MessageRef {
        machine_id,
        message_id: format!("m{number}"),
    })
}

fn local_machine(connection: &Connection) -> rusqlite::Result<String> {
    connection.query_row("SELECT machine_id FROM machine", [], |row| row.get(0))
}

pub(super) fn result_number(reference: &MessageRef) -> anyhow::Result<i64> {
    reference
        .message_id
        .strip_prefix('m')
        .and_then(|digits| digits.parse::<i64>().ok())
        .filter(|number| *number > 0)
        .ok_or_else(|| anyhow::anyhow!("invalid result message number {}", reference.message_id))
}

/// Deletes `owner`'s inbox, in `connection`'s transaction. The messages it sent stay. Returns what
/// it deleted.
pub(super) fn delete_inbox(connection: &Connection, owner: &str) -> rusqlite::Result<Vec<Gone>> {
    delete_returning(connection, "\"to\" = ?1", owner)
}

/// Deletes the messages `filter` selects with `value`, returning each.
fn delete_returning(
    connection: &Connection,
    filter: &str,
    value: &str,
) -> rusqlite::Result<Vec<Gone>> {
    let mut statement = connection.prepare(&format!(
        "DELETE FROM messages WHERE {filter} RETURNING number, \"to\""
    ))?;
    let gone = statement.query_map([value], |row| {
        Ok(Gone {
            number: row.get::<_, i64>(0)? as u64,
            to: row.get(1)?,
        })
    })?;
    gone.collect()
}

/// Writes `result` under the number prompt `prompt` keeps for it and clears that number, where the
/// prompt still owes it and the result's recipient, the prompt's caller, is still there: an agent
/// whose record has no exit, or a guest whose record is kept. Returns whether it was written. A
/// result not written leaves its number unused.
fn write_result(connection: &Connection, prompt: u64, result: &Message) -> rusqlite::Result<bool> {
    let (owed, machine): (Option<i64>, Option<String>) = connection.query_row(
        "SELECT result_owed, result_owed_machine_id FROM messages WHERE number = ?1",
        [prompt as i64],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let numbered = result
        .message_id
        .strip_prefix('m')
        .and_then(|n| n.parse().ok());
    let Some((number, machine_id)) = owed.zip(machine).filter(|(number, machine_id)| {
        Some(*number) == numbered
            && result.message_ref.as_ref().is_some_and(|reference| {
                &reference.machine_id == machine_id && reference.message_id == result.message_id
            })
    }) else {
        return Ok(false);
    };
    connection.execute(
        "UPDATE messages SET result_owed = NULL, result_owed_machine_id = NULL WHERE number = ?1",
        [prompt as i64],
    )?;
    if machine_id != local_machine(connection)? {
        return Ok(true);
    }
    let caller_there = recipient_there(connection, &result.to)?;
    if caller_there {
        write(connection, number, result, None)?;
    }
    Ok(caller_there)
}

fn recipient_there(connection: &Connection, recipient: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM agents WHERE agent_id = ?1 AND exit_at IS NULL) \
         OR EXISTS (SELECT 1 FROM guests WHERE agent_id = ?1)",
        [recipient],
        |row| row.get(0),
    )
}

/// Writes message `number`'s delivery where its row satisfies `condition`. Returns whether a row
/// changed.
fn write_delivery(
    connection: &Connection,
    number: u64,
    delivery: &Delivery,
    condition: &str,
) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        &format!(
            "UPDATE messages SET status = ?2, reason = ?3, text_written = ?4, enter_written = ?5, \
             deadline = ?6, delivered_via = ?7, delivered_at = ?8 WHERE number = ?1 AND {condition}"
        ),
        params![
            number as i64,
            name(&delivery.status),
            delivery.reason.as_ref().map(name),
            name(&delivery.text_written),
            delivery.enter_written,
            delivery.deadline,
            delivery.delivered_via.as_ref().map(name),
            delivery.delivered_at,
        ],
    )?;
    Ok(changed == 1)
}

/// The handle of the `messages` table, which the daemon's messages own: they number, keep, settle,
/// read and expire messages here. Every method blocks.
#[derive(Clone)]
pub(crate) struct MessageTable(Arc<Store>);

impl MessageTable {
    pub(super) fn new(store: Arc<Store>) -> MessageTable {
        MessageTable(store)
    }

    /// Commits a message number for a result that another machine will send back.
    pub(crate) fn reserve_result_number(&self) -> anyhow::Result<u64> {
        self.0.with(
            || "reserve a result message number".to_string(),
            |connection| take_number(connection).map(|number| number as u64),
        )
    }

    /// Admits a forwarded result under the number this home reserved for its caller.
    pub(crate) fn insert_reserved_result(
        &self,
        recipient: &AgentRef,
        message: &Message,
    ) -> anyhow::Result<Option<Kept>> {
        let reference = message
            .message_ref
            .as_ref()
            .filter(|reference| {
                reference.machine_id == recipient.machine_id
                    && reference.message_id == message.message_id
            })
            .ok_or_else(|| {
                anyhow::anyhow!("the result's message reference does not name its reserved number")
            })?;
        let number = result_number(reference)?;
        self.0.transaction(
            || format!("save the start result #m{number}"),
            |connection| {
                let next: i64 =
                    connection
                        .query_row("SELECT next FROM message_numbers", [], |row| row.get(0))?;
                if number >= next
                    || recipient.machine_id != local_machine(connection)?
                    || !recipient_there(connection, &recipient.agent_id)?
                {
                    return Ok(None);
                }
                let existing = connection
                    .query_row(
                        &format!("SELECT {COLUMNS} FROM messages WHERE number = ?1"),
                        [number],
                        read_message,
                    )
                    .optional()?;
                if let Some(kept) = existing {
                    return Ok((kept.message.to == recipient.agent_id
                        && kept.message.from == message.from
                        && kept.message.from_machine_id == message.from_machine_id
                        && kept.message.call_id == message.call_id
                        && kept.message.result == message.result)
                        .then_some(Kept::Earlier(kept)));
                }
                write(connection, number, message, None)?;
                Ok(Some(Kept::New(message.clone())))
            },
        )
    }

    /// Raises the counter so the next message number is above `given`; one already above stays.
    /// Blocks.
    pub(crate) fn raise_above(&self, given: u64) -> anyhow::Result<()> {
        self.0.with(
            || "raise the message counter".to_string(),
            |connection| {
                connection.execute(
                    "UPDATE message_numbers SET next = MAX(next, ?1 + 1)",
                    [given as i64],
                )
            },
        )?;
        Ok(())
    }

    /// Takes the next number and writes `message` under it, in one transaction, with `request`,
    /// its send's request ID, where it had one. Where that transaction finds a message the sender
    /// kept with the same ID within its hour, it keeps nothing and answers that message.
    pub(crate) fn insert_message(
        &self,
        message: &Message,
        request: Option<RequestId>,
    ) -> anyhow::Result<Kept> {
        self.0.transaction(
            || "save a message".to_string(),
            |transaction| {
                if let Some(request) = request
                    && let Some(earlier) = find_request(
                        transaction,
                        message.from_machine_id.as_deref(),
                        &message.from,
                        &message.to,
                        request,
                    )?
                {
                    return Ok(Kept::Earlier(earlier));
                }
                let number = take_number(transaction)?;
                write(transaction, number, message, request)?;
                Ok(Kept::New(Message {
                    message_id: format!("m{number}"),
                    ..message.clone()
                }))
            },
        )
    }

    /// The message this caller kept for `to` with the same request ID within its hour.
    pub(crate) fn find_request(
        &self,
        from_machine_id: &str,
        from: &str,
        to: &str,
        request: RequestId,
    ) -> anyhow::Result<Option<KeptMessage>> {
        self.0.with(
            || "read messages".to_string(),
            |connection| find_request(connection, Some(from_machine_id), from, to, request),
        )
    }

    /// Deletes message `number`, withdrawn before its paste began. Returns whether it was kept.
    pub(crate) fn delete_message(&self, number: u64) -> anyhow::Result<bool> {
        let deleted = self.0.with(
            || format!("delete #m{number}"),
            |connection| {
                connection.execute("DELETE FROM messages WHERE number = ?1", [number as i64])
            },
        )?;
        Ok(deleted == 1)
    }

    /// Keeps the first window receipt. Without a confirmed delivery the message stays pending.
    pub(crate) fn settle_human(
        &self,
        number: u64,
        windows: &WindowDelivery,
    ) -> anyhow::Result<Message> {
        let delivered_at = (!windows.delivered.is_empty()).then(facade_base::time::iso_now);
        let windows = serde_json::to_string(windows)?;
        self.0.transaction(
            || format!("save the window delivery of #m{number}"),
            |transaction| {
                transaction.query_row(
                    &format!(
                        "UPDATE messages SET
                         status = CASE WHEN ?2 IS NOT NULL THEN 'success' ELSE status END,
                         delivered_via = CASE WHEN ?2 IS NOT NULL THEN 'notified' ELSE NULL END,
                         delivered_at = ?2, human_windows = ?3
                         WHERE number = ?1 AND \"to\" = ?4 AND status = 'pending'
                         AND human_windows IS NULL
                         RETURNING {COLUMNS}"
                    ),
                    params![number as i64, delivered_at, windows, HUMAN],
                    |row| Ok(read_message(row)?.message),
                )
            },
        )
    }

    /// Looks up a message in its owner's inbox without changing delivery state.
    pub(crate) fn inbox_message(
        &self,
        owner: &str,
        number: u64,
    ) -> anyhow::Result<Option<KeptMessage>> {
        self.0.with(
            || format!("read #m{number} in {owner}'s inbox"),
            |connection| {
                connection
                    .query_row(
                        &format!(
                            "SELECT {COLUMNS} FROM messages WHERE number = ?1 AND \"to\" = ?2"
                        ),
                        params![number as i64, owner],
                        read_message,
                    )
                    .optional()
            },
        )
    }

    /// The settled messages that reached this window's subscription, in message number order.
    pub(crate) fn human_inbox(&self, window: &WindowRef) -> anyhow::Result<Vec<Message>> {
        let kept = self.select(
            "\"to\" = ?1 AND status = 'success' AND human_windows IS NOT NULL",
            None,
            [HUMAN],
        )?;
        Ok(kept
            .into_iter()
            .filter(|kept| {
                kept.human_windows
                    .as_ref()
                    .is_some_and(|windows| windows.delivered.contains(window))
            })
            .map(|kept| kept.message)
            .collect())
    }

    /// Begins the delivery of prompt `number`, kept with no deadline while its CLI's tools connect:
    /// gives it `deadline`, and `from_name` where it was kept without one. Returns whether the
    /// prompt was still pending without a deadline.
    pub(crate) fn begin_prompt(
        &self,
        number: u64,
        deadline: &str,
        from_name: Option<&str>,
    ) -> anyhow::Result<bool> {
        let changed = self.0.with(
            || format!("begin the delivery of #m{number}"),
            |connection| {
                connection.execute(
                    "UPDATE messages SET deadline = ?2, from_name = coalesce(from_name, ?3) \
                     WHERE number = ?1 AND status = 'pending' AND deadline IS NULL",
                    params![number as i64, deadline, from_name],
                )
            },
        )?;
        Ok(changed == 1)
    }

    /// Records, in one transaction, that the paste of `numbers` begins, named by its first.
    pub(crate) fn begin_paste(&self, numbers: &[u64]) -> anyhow::Result<()> {
        let Some(first) = numbers.first() else {
            return Ok(());
        };
        self.0.transaction(
            || format!("record that #m{first}'s paste began"),
            |transaction| {
                for number in numbers {
                    transaction.execute(
                        "UPDATE messages SET paste = ?1 WHERE number = ?2",
                        params![*first as i64, *number as i64],
                    )?;
                }
                Ok(())
            },
        )
    }

    /// Writes, in one transaction, each delivery whose message is still pending, and the results
    /// that the prompts among them owe, each paired with its prompt's number. A result is written
    /// only for a caller still there. A message settled before, or deleted with its recipient's
    /// inbox, is left as it is.
    pub(crate) fn settle_messages(
        &self,
        settled: &[(u64, &Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.write_deliveries(settled, "status = 'pending'", results)
    }

    /// Writes, in one transaction, the delivery of each message a read handed over, unless it was
    /// delivered before, and the results the prompts among them owe, as `settle_messages` does.
    pub(crate) fn record_reads(
        &self,
        read: &[(u64, &Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.write_deliveries(read, UNDELIVERED, results)
    }

    fn write_deliveries(
        &self,
        deliveries: &[(u64, &Delivery)],
        condition: &str,
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.0.transaction(
            || "save the delivery of messages".to_string(),
            |transaction| {
                let mut written = Settlement::default();
                for (number, delivery) in deliveries {
                    if !write_delivery(transaction, *number, delivery, condition)? {
                        continue;
                    }
                    written.settled.push(*number);
                    let result = results.iter().find(|(prompt, _)| prompt == number);
                    if let Some((_, result)) = result
                        && write_result(transaction, *number, result)?
                    {
                        written.results.push(*number);
                    }
                }
                Ok(written)
            },
        )
    }

    /// The first `limit` messages `filter` selects with `values`, or all of them, by number; a row
    /// this build cannot read is logged and skipped.
    fn select(
        &self,
        filter: &str,
        limit: Option<usize>,
        values: impl rusqlite::Params,
    ) -> anyhow::Result<Vec<KeptMessage>> {
        let limit = limit
            .map(|limit| format!(" LIMIT {limit}"))
            .unwrap_or_default();
        self.0.with(
            || "read messages".to_string(),
            |connection| {
                let mut statement = connection.prepare(&format!(
                    "SELECT {COLUMNS} FROM messages WHERE {filter} ORDER BY number{limit}"
                ))?;
                let mut rows = statement.query(values)?;
                let mut messages = Vec::new();
                while let Some(row) = rows.next()? {
                    match read_message(row) {
                        Ok(message) => messages.push(message),
                        Err(err) => {
                            let number = row
                                .get::<_, i64>(0)
                                .map_or("with no number".to_string(), |n| format!("#m{n}"));
                            log(
                                "warn",
                                &format!(
                                    "skipping message {number} that this build cannot read: {err}"
                                ),
                            );
                        }
                    }
                }
                Ok(messages)
            },
        )
    }

    fn select_messages(
        &self,
        filter: &str,
        limit: Option<usize>,
        values: impl rusqlite::Params,
    ) -> anyhow::Result<Vec<Message>> {
        let kept = self.select(filter, limit, values)?;
        Ok(kept.into_iter().map(|kept| kept.message).collect())
    }

    /// Message `number`, if it is kept.
    pub(crate) fn message(&self, number: u64) -> anyhow::Result<Option<Message>> {
        Ok(self
            .select_messages("number = ?1", None, [number as i64])?
            .pop())
    }

    /// The messages of `owner`'s inbox among `numbers`, by number.
    pub(crate) fn inbox_messages(
        &self,
        owner: &str,
        numbers: &[u64],
    ) -> anyhow::Result<Vec<Message>> {
        let list: Vec<String> = numbers.iter().map(u64::to_string).collect();
        let filter = format!("\"to\" = ?1 AND number IN ({})", list.join(", "));
        self.select_messages(&filter, None, [owner])
    }

    /// Up to `limit` messages of `owner`'s inbox after number `after`, by number: every kept one
    /// with `all`, otherwise those not delivered yet.
    pub(crate) fn inbox_page(
        &self,
        owner: &str,
        after: u64,
        all: bool,
        limit: usize,
    ) -> anyhow::Result<Vec<Message>> {
        let filter = match all {
            true => "\"to\" = ?1 AND number > ?2".to_string(),
            false => format!("\"to\" = ?1 AND number > ?2 AND {UNDELIVERED}"),
        };
        self.select_messages(&filter, Some(limit), params![owner, after as i64])
    }

    /// The newest `last` messages of `owner`'s inbox, by number: of every message where `all`,
    /// else of those not yet delivered.
    pub(crate) fn inbox_last(
        &self,
        owner: &str,
        all: bool,
        last: usize,
    ) -> anyhow::Result<Vec<Message>> {
        let undelivered = match all {
            true => String::new(),
            false => format!(" AND {UNDELIVERED}"),
        };
        let filter = format!(
            "number IN (SELECT number FROM messages WHERE \"to\" = ?1{undelivered} \
             ORDER BY number DESC LIMIT {last})"
        );
        self.select_messages(&filter, None, [owner])
    }

    /// Every kept message of `owner`'s inbox, by number.
    pub(crate) fn inbox(&self, owner: &str) -> anyhow::Result<Vec<Message>> {
        self.select_messages("\"to\" = ?1", None, [owner])
    }

    /// The messages still pending, by number, each with the paste it went in.
    pub(crate) fn pending_messages(&self) -> anyhow::Result<Vec<KeptMessage>> {
        self.select("status = 'pending'", None, [])
    }

    /// The messages of paste `paste`, whatever became of each, by number.
    pub(crate) fn paste_messages(&self, paste: u64) -> anyhow::Result<Vec<Message>> {
        self.select_messages("paste = ?1", None, [paste as i64])
    }

    /// Whether message `number` is kept.
    pub(crate) fn keeps_message(&self, number: u64) -> anyhow::Result<bool> {
        self.0.with(
            || "read messages".to_string(),
            |connection| {
                connection.query_row(
                    "SELECT EXISTS (SELECT 1 FROM messages WHERE number = ?1)",
                    [number as i64],
                    |row| row.get(0),
                )
            },
        )
    }

    /// Deletes the messages sent before `before`, a time as `facade_base::time` writes it. Returns
    /// what it deleted.
    pub(crate) fn expire_messages(&self, before: &str) -> anyhow::Result<Vec<Gone>> {
        self.0.with(
            || "delete expired messages".to_string(),
            |connection| delete_returning(connection, "at < ?1", before),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use facade_base::daemon::{
        DeliveredVia, DeliveryFailure, DeliveryStatus, TextWritten, WindowDeliveryFailure,
    };

    use super::*;
    use crate::messages::tests::message;

    /// A test's own core folder, deleted when it is dropped.
    struct Core(PathBuf);

    impl Core {
        fn new(test: &str) -> Core {
            let dir =
                std::env::temp_dir().join(format!("facade-messages-{test}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Core(dir)
        }

        fn open(&self) -> Arc<Store> {
            Store::open(&self.0, &[]).unwrap().store
        }
    }

    impl Drop for Core {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// What became of a message, without its times.
    fn became(
        message: &Message,
    ) -> (
        DeliveryStatus,
        Option<DeliveryFailure>,
        TextWritten,
        Option<bool>,
        Option<DeliveredVia>,
    ) {
        let delivery = &message.delivery;
        (
            delivery.status,
            delivery.reason,
            delivery.text_written,
            delivery.enter_written,
            delivery.delivered_via,
        )
    }

    fn numbers(messages: &[Message]) -> Vec<String> {
        messages
            .iter()
            .map(|message| message.message_id.clone())
            .collect()
    }

    fn failure(reason: DeliveryFailure) -> Delivery {
        Delivery {
            status: DeliveryStatus::Failure,
            reason: Some(reason),
            text_written: TextWritten::None,
            enter_written: Some(false),
            ..message(0, "").delivery
        }
    }

    fn read_at(at: &str) -> Delivery {
        Delivery {
            status: DeliveryStatus::Success,
            reason: None,
            text_written: TextWritten::None,
            enter_written: Some(false),
            deadline: None,
            delivered_via: Some(DeliveredVia::Read),
            delivered_at: Some(at.into()),
        }
    }

    #[test]
    fn human_receipts_survive_reopening_and_appear_only_for_the_delivered_window() {
        let core = Core::new("human-receipts");
        let window = WindowRef {
            machine_id: "here".into(),
            window_id: "win-1".into(),
        };
        let other = WindowRef {
            machine_id: "elsewhere".into(),
            ..window.clone()
        };
        let receipt = WindowDelivery {
            outcome_unknown: Vec::new(),
            delivered: vec![window.clone()],
            not_delivered: vec![WindowDeliveryFailure {
                window: other.clone(),
                reason: "window_disconnected".into(),
            }],
        };
        let request = RequestId {
            id: "to-person",
            since: "2026-11-09T00:00:00.000Z",
            caller_window_id: None,
        };
        let pending = message(0, HUMAN);
        let store = core.open();
        store.insert_message(&pending, Some(request)).unwrap();
        store.insert_message(&pending, None).unwrap();
        let settled = store.message_table().settle_human(1, &receipt).unwrap();
        assert_eq!(settled.delivery.status, DeliveryStatus::Success);
        drop(store);

        let store = core.open();
        let kept = store.find_request("a1", HUMAN, request).unwrap().unwrap();
        assert_eq!(kept.message, settled);
        assert_eq!(kept.human_windows, Some(receipt));
        assert_eq!(
            store.message_table().human_inbox(&window).unwrap(),
            [settled]
        );
        assert!(
            store
                .message_table()
                .human_inbox(&other)
                .unwrap()
                .is_empty()
        );
    }

    /// A message kept with a request ID is its sender's for the hour: the same sender's same ID
    /// finds it in the transaction that would keep another, which takes no number. Another sender's
    /// same ID, the same ID once the first is deleted, and the same ID after the hour keep new
    /// messages.
    #[test]
    fn a_request_id_keeps_one_message_per_sender_and_recipient_within_the_hour() {
        let store = Store::in_memory();
        // The messages are sent at 2026-11-10T00:00:00.000Z, within the hour since this.
        let within = "2026-11-09T23:00:00.000Z";
        let keep = |message: &Message, id, since| {
            store
                .insert_message(
                    message,
                    Some(RequestId {
                        id,
                        since,
                        caller_window_id: None,
                    }),
                )
                .unwrap()
        };
        assert!(matches!(
            keep(&message(0, "a2"), "r1", within),
            Kept::New(first) if first.message_id == "m1"
        ));
        let again = keep(&message(0, "a2"), "r1", within);
        assert!(
            matches!(
                &again,
                Kept::Earlier(kept) if kept.message.message_id == "m1" && kept.message.to == "a2"
            ),
            "the first as it was: {again:?}"
        );
        assert_eq!(
            keep(
                &Message {
                    from: "a4".into(),
                    ..message(0, "a2")
                },
                "r1",
                within
            )
            .into_message()
            .message_id,
            "m2",
            "another sender's own"
        );
        let found = store
            .find_request(
                "a1",
                "a2",
                RequestId {
                    id: "r1",
                    since: within,
                    caller_window_id: None,
                },
            )
            .unwrap();
        assert_eq!(found.map(|kept| kept.message.message_id), Some("m1".into()));
        assert!(
            store.message_table().delete_message(1).unwrap()
                && !store.message_table().keeps_message(1).unwrap()
                && !store.message_table().delete_message(1).unwrap()
        );
        assert!(
            store
                .find_request(
                    "a1",
                    "a2",
                    RequestId {
                        id: "r1",
                        since: within,
                        caller_window_id: None,
                    }
                )
                .unwrap()
                .is_none()
        );
        assert_eq!(
            keep(&message(0, "a2"), "r1", within)
                .into_message()
                .message_id,
            "m3",
            "a deleted message's ID is free, its number not"
        );
        let after_the_hour = keep(&message(0, "a2"), "r1", "2026-11-10T00:00:00.001Z");
        assert!(matches!(after_the_hour, Kept::New(new) if new.message_id == "m4"));
        assert!(
            matches!(keep(&message(0, "a3"), "r1", within), Kept::New(new) if new.message_id == "m5")
        );
    }

    /// A message takes its number in the transaction that writes it: one that cannot be written
    /// takes none.
    #[test]
    fn a_message_and_its_number_are_written_together() {
        let store = Store::in_memory();
        assert_eq!(
            store
                .insert_message(&message(0, "a2"), None)
                .unwrap()
                .into_message()
                .message_id,
            "m1"
        );
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN \
                 SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();
        assert!(
            store
                .message_table()
                .insert_message(&message(0, "a2"), None)
                .is_err()
        );
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER refuse")
            .unwrap();
        assert_eq!(
            store
                .insert_message(&message(0, "a2"), None)
                .unwrap()
                .into_message()
                .message_id,
            "m2",
            "the refused message took no number"
        );
    }

    /// Every field of a message, its delivery and its paste survive a reopen.
    #[test]
    fn a_message_its_delivery_and_its_paste_survive_a_reopen() {
        let core = Core::new("reopen");
        let store = core.open();
        let from_person = Message {
            from: "human".into(),
            from_name: None,
            reply_to: Some("m9".into()),
            text: "two\nlines\tand a tab".into(),
            ..message(0, "a2")
        };
        let from_elsewhere = Message {
            from_window: Some("Design".into()),
            ..message(0, "a3")
        };
        let kept = [
            store
                .insert_message(&from_person, None)
                .unwrap()
                .into_message(),
            store
                .insert_message(&message(0, "a2"), None)
                .unwrap()
                .into_message(),
            store
                .insert_message(&from_elsewhere, None)
                .unwrap()
                .into_message(),
        ];
        store.message_table().begin_paste(&[1, 2]).unwrap();
        let unconfirmed = Delivery {
            text_written: TextWritten::Unknown,
            enter_written: None,
            ..failure(DeliveryFailure::SubmissionUnconfirmed)
        };
        assert_eq!(
            store
                .settle_messages(&[(2, &unconfirmed)], &[])
                .unwrap()
                .settled,
            [2]
        );
        drop(store);
        let store = core.open();
        let pending = store.message_table().pending_messages().unwrap();
        assert_eq!(
            pending,
            [
                KeptMessage {
                    message: kept[0].clone(),
                    paste: Some(1),
                    result_owed: None,
                    human_windows: None,
                },
                KeptMessage {
                    message: kept[2].clone(),
                    paste: None,
                    result_owed: None,
                    human_windows: None,
                }
            ]
        );
        assert_eq!(
            store.message_table().message(2).unwrap().unwrap(),
            Message {
                delivery: unconfirmed.clone(),
                ..kept[1].clone()
            }
        );
        assert_eq!(
            numbers(&store.message_table().paste_messages(1).unwrap()),
            ["m1", "m2"],
            "a paste's messages, whatever became of each"
        );
    }

    /// A settlement changes only a message still pending, so the first one wins; a read delivers
    /// one not delivered yet, a failed one included.
    #[test]
    fn a_settlement_changes_only_a_pending_message_and_a_read_only_an_undelivered_one() {
        let store = Store::in_memory();
        for to in ["a2", "a2", "a2"] {
            store
                .insert_message(&message(0, to), None)
                .unwrap()
                .into_message();
        }
        let timeout = failure(DeliveryFailure::Timeout);
        assert_eq!(
            store
                .settle_messages(&[(1, &timeout), (2, &timeout)], &[])
                .unwrap()
                .settled,
            [1, 2]
        );
        assert_eq!(
            store
                .settle_messages(&[(1, &read_at("t"))], &[])
                .unwrap()
                .settled,
            Vec::<u64>::new(),
            "settled before"
        );
        assert_eq!(
            store
                .record_reads(&[(1, &read_at("t")), (3, &read_at("t"))], &[])
                .unwrap()
                .settled,
            [1, 3],
            "a failed message and a pending one"
        );
        assert_eq!(
            store
                .record_reads(&[(1, &read_at("later"))], &[])
                .unwrap()
                .settled,
            Vec::<u64>::new(),
            "delivered before"
        );
        assert_eq!(
            store
                .message(1)
                .unwrap()
                .unwrap()
                .delivery
                .delivered_at
                .as_deref(),
            Some("t")
        );
        assert_eq!(
            became(&store.message_table().message(2).unwrap().unwrap()).1,
            Some(DeliveryFailure::Timeout)
        );
    }

    /// A start's prompt from #a1 to #a2, kept with no deadline yet, which names call 7.
    fn prompt() -> Message {
        let pending = Delivery {
            deadline: None,
            ..message(0, "a2").delivery
        };
        Message {
            call_id: Some("7".into()),
            delivery: pending,
            ..message(0, "a2")
        }
    }

    /// The result #a2's prompt `prompt` owes #a1, under `number`, its prompt settled as `delivery`.
    fn result(reference: &MessageRef, prompt: &Message, delivery: &Delivery) -> Message {
        let agent = serde_json::from_value(serde_json::json!({
            "agent_id": "a2", "name": "Nova", "cli": "claude", "cwd": "/w",
            "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "windows": [{
                "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "window_id": "terminal"
            }],
            "location_id": "loc-1", "pid": 7, "process": "running", "cols": 80, "rows": 24,
            "created_at": "2026-11-11T00:00:00.000Z", "root": "a1", "yolo": true, "state": "idle",
            "tools_state": "available",
        }))
        .unwrap();
        let prompt = facade_base::daemon::PromptOutcome {
            message_id: prompt.message_id.clone(),
            delivery: delivery.clone(),
        };
        let outcome = facade_base::daemon::StartOutcome { agent, prompt };
        Message {
            message_id: reference.message_id.clone(),
            message_ref: Some(reference.clone()),
            from: facade_base::daemon::FACADE.into(),
            from_name: None,
            to: "a1".into(),
            text: facade_base::daemon::start_result_text(&outcome),
            call_id: Some("7".into()),
            result: Some(outcome),
            ..message(0, "a1")
        }
    }

    /// The number a kept prompt keeps for its result.
    fn owed(store: &Store, prompt: u64) -> Option<i64> {
        let connection = store.connection.lock().unwrap();
        connection
            .query_row(
                "SELECT result_owed FROM messages WHERE number = ?1",
                [prompt as i64],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// A start's prompt is kept with its agent's record, and takes the number of the result it owes
    /// with its own. Its delivery begins once, with a deadline and its sender's name. The
    /// transaction that settles it writes its result, under that number, once: a later read
    /// delivers it with no second result. The result, its call and its facts survive a reopen.
    #[test]
    fn a_prompt_owes_one_result_written_in_the_transaction_that_settles_it() {
        let core = Core::new("prompt");
        let store = core.open();
        store.insert(&crate::store::tests::record("a1")).unwrap();
        let (kept, owed_number) = store
            .insert_with_prompt(&crate::store::tests::record("a2"), &prompt(), true, None)
            .unwrap();
        let reference = owed_number.unwrap();
        assert_eq!(
            (kept.message_id.as_str(), reference.message_id.as_str()),
            ("m1", "m2")
        );
        assert_eq!(
            store.message_table().pending_messages().unwrap(),
            [KeptMessage {
                message: kept.clone(),
                paste: None,
                result_owed: Some(reference.clone()),
                human_windows: None,
            }]
        );
        assert!(
            store
                .begin_prompt(1, "2026-11-11T00:00:29.500Z", Some("Ada"))
                .unwrap()
        );
        assert!(
            !store
                .begin_prompt(1, "2026-11-11T00:01:00.000Z", None)
                .unwrap(),
            "its delivery begins once"
        );
        let begun = store.message_table().message(1).unwrap().unwrap();
        assert_eq!(
            (
                begun.delivery.deadline.as_deref(),
                begun.from_name.as_deref()
            ),
            (Some("2026-11-11T00:00:29.500Z"), Some("Ada"))
        );
        let timeout = failure(DeliveryFailure::Timeout);
        let owed_result = result(&reference, &kept, &timeout);
        let settled = store
            .settle_messages(&[(1, &timeout)], &[(1, owed_result.clone())])
            .unwrap();
        assert_eq!(
            settled,
            Settlement {
                settled: vec![1],
                results: vec![1]
            }
        );
        assert_eq!(owed(&store, 1), None, "the prompt owes nothing more");
        let read = store
            .record_reads(
                &[(1, &read_at("t"))],
                &[(1, result(&reference, &kept, &read_at("t")))],
            )
            .unwrap();
        assert_eq!(
            read,
            Settlement {
                settled: vec![1],
                results: vec![]
            },
            "a later read delivers the prompt with no second result"
        );
        drop(store);
        let store = core.open();
        assert_eq!(
            store.message_table().message(2).unwrap().unwrap(),
            Message {
                message_ref: None,
                ..owed_result
            },
            "the result, its call and its facts survive a reopen"
        );
        assert_eq!(
            store
                .insert_message(&message(0, "a1"), None)
                .unwrap()
                .into_message()
                .message_id,
            "m3",
            "numbers go on after the result's"
        );
    }

    /// The result is written in the transaction that settles its prompt: where it cannot be
    /// written, the prompt is not settled either, and still owes it.
    #[test]
    fn a_prompt_whose_result_cannot_be_written_is_not_settled() {
        let store = Store::in_memory();
        store.insert(&crate::store::tests::record("a1")).unwrap();
        let (kept, reference) = store
            .insert_with_prompt(&crate::store::tests::record("a2"), &prompt(), true, None)
            .unwrap();
        let refuse = "CREATE TRIGGER refuse BEFORE INSERT ON messages WHEN NEW.\"from\" = 'facade' \
                      BEGIN SELECT RAISE(ABORT, 'refused'); END;";
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch(refuse)
            .unwrap();
        let timeout = failure(DeliveryFailure::Timeout);
        assert!(
            store
                .settle_messages(
                    &[(1, &timeout)],
                    &[(1, result(&reference.unwrap(), &kept, &timeout))]
                )
                .is_err()
        );
        assert_eq!(
            store
                .message_table()
                .message(1)
                .unwrap()
                .unwrap()
                .delivery
                .status,
            DeliveryStatus::Pending,
            "the prompt is not settled"
        );
        assert_eq!(owed(&store, 1), Some(2), "and still owes its result");
    }

    /// A result whose caller was removed, or ended, is not written: its number goes unused, and the
    /// prompt owes nothing more. A prompt kept without one owes none, and a record that cannot be
    /// written keeps no prompt.
    #[test]
    fn a_result_for_a_caller_that_went_is_not_written() {
        let store = Store::in_memory();
        let timeout = failure(DeliveryFailure::Timeout);
        let exit = facade_base::process::ProcessExit {
            code: Some(0),
            signal: None,
            reason: None,
            at: "t".into(),
        };
        for (caller, went) in [("removed", true), ("ended", false)] {
            store.insert(&crate::store::tests::record("a1")).unwrap();
            let (kept, owed_number) = store
                .insert_with_prompt(&crate::store::tests::record("a2"), &prompt(), true, None)
                .unwrap();
            let number = super::number_of(&kept);
            match went {
                true => drop(store.delete("a1").unwrap()),
                false => store.record_exit("a1", &exit).unwrap(),
            }
            let reference = owed_number.unwrap();
            let owed_result = result(&reference, &kept, &timeout);
            let settled = store
                .settle_messages(&[(number, &timeout)], &[(number, owed_result)])
                .unwrap();
            assert_eq!(
                settled,
                Settlement {
                    settled: vec![number],
                    results: vec![]
                },
                "{caller}"
            );
            assert_eq!(
                store
                    .message_table()
                    .message(result_number(&reference).unwrap() as u64)
                    .unwrap(),
                None,
                "{caller}"
            );
            assert_eq!(owed(&store, number), None, "{caller}");
            store.delete("a1").unwrap();
            store.delete("a2").unwrap();
        }
        let (kept, owed_number) = store
            .insert_with_prompt(&crate::store::tests::record("a3"), &prompt(), false, None)
            .unwrap();
        assert_eq!(
            (owed_number, owed(&store, super::number_of(&kept))),
            (None, None),
            "a person's prompt owes nothing"
        );
        assert!(
            store
                .insert_with_prompt(&crate::store::tests::record("a3"), &prompt(), true, None)
                .is_err(),
            "a record already kept"
        );
        assert_eq!(
            store
                .insert_message(&message(0, "a1"), None)
                .unwrap()
                .into_message()
                .message_id,
            format!("m{}", super::number_of(&kept) + 1)
        );
    }

    /// A result for a guest, which is not stored, is written while the guest is listed, as one for
    /// an agent is while its record is stored: by the settlement, or by a read, of the prompt that
    /// owes it. One for a guest no longer listed is not.
    #[test]
    fn an_inbox_is_read_by_ids_or_a_page_at_a_time() {
        let store = Store::in_memory();
        for to in ["a2", "a3", "a2", "a2", "a2"] {
            store
                .insert_message(&message(0, to), None)
                .unwrap()
                .into_message();
        }
        store.settle_messages(&[(3, &read_at("t"))], &[]).unwrap();
        assert_eq!(
            numbers(
                &store
                    .message_table()
                    .inbox_messages("a2", &[1, 2, 3, 9])
                    .unwrap()
            ),
            ["m1", "m3"],
            "another inbox's m2 is not read"
        );
        assert_eq!(
            numbers(&store.message_table().inbox_page("a2", 0, false, 2).unwrap()),
            ["m1", "m4"],
            "not delivered, by number"
        );
        assert_eq!(
            numbers(&store.message_table().inbox_page("a2", 1, true, 2).unwrap()),
            ["m3", "m4"],
            "every kept one after m1"
        );
        assert_eq!(
            numbers(&store.message_table().inbox("a2").unwrap()),
            ["m1", "m3", "m4", "m5"]
        );
    }

    /// The default read uses the index of messages not yet delivered, so it takes time by what
    /// waits.
    #[test]
    fn the_default_read_uses_the_index_of_messages_not_yet_delivered() {
        let store = Store::in_memory();
        let connection = store.connection.lock().unwrap();
        let query = format!(
            "SELECT {COLUMNS} FROM messages WHERE \"to\" = 'a2' AND number > 0 AND {UNDELIVERED} \
             ORDER BY number LIMIT 101"
        );
        let plan: Vec<String> = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
            .unwrap()
            .query_map([], |row| row.get(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter()
                .any(|step| step.contains("messages_undelivered")),
            "{plan:?}"
        );
    }

    /// Deleting an agent deletes its inbox in the same transaction; what it sent stays in its
    /// recipients' inboxes.
    #[test]
    fn an_agent_s_inbox_goes_with_its_record_and_what_it_sent_stays() {
        let store = Store::in_memory();
        store.insert(&crate::store::tests::record("a1")).unwrap();
        store
            .insert_message(&message(0, "a1"), None)
            .unwrap()
            .into_message();
        store
            .insert_message(
                &Message {
                    from: "a1".into(),
                    ..message(0, "a2")
                },
                None,
            )
            .unwrap()
            .into_message();
        store.delete("a1").unwrap();
        assert!(store.message_table().inbox("a1").unwrap().is_empty());
        assert_eq!(numbers(&store.message_table().inbox("a2").unwrap()), ["m2"]);
        store.delete_inbox("a2").unwrap();
        assert!(!store.message_table().keeps_message(2).unwrap());
    }

    /// Expiry deletes the messages sent before a time and never lowers the counter.
    #[test]
    fn expiry_deletes_by_when_a_message_was_sent_and_numbers_go_on() {
        let store = Store::in_memory();
        for at in ["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"] {
            store
                .insert_message(
                    &Message {
                        at: at.into(),
                        ..message(0, "a2")
                    },
                    None,
                )
                .unwrap()
                .into_message();
        }
        assert_eq!(
            store
                .message_table()
                .expire_messages("2026-10-12T00:00:00.000Z")
                .unwrap(),
            [Gone {
                number: 1,
                to: "a2".into()
            }]
        );
        assert!(
            !store.message_table().keeps_message(1).unwrap()
                && store.message_table().keeps_message(2).unwrap()
        );
        store
            .message_table()
            .expire_messages("2026-12-01T00:00:00.000Z")
            .unwrap();
        assert_eq!(
            store
                .insert_message(&message(0, "a2"), None)
                .unwrap()
                .into_message()
                .message_id,
            "m3"
        );
    }

    /// A value this build does not know reads as unknown, never as pending; a row that cannot be
    /// decoded is skipped and kept as it is.
    #[test]
    fn values_this_build_does_not_know_read_as_unknown_and_an_unreadable_row_stays_as_it_is() {
        let store = Store::in_memory();
        for _ in 0..3 {
            store
                .insert_message(&message(0, "a2"), None)
                .unwrap()
                .into_message();
        }
        {
            let connection = store.connection.lock().unwrap();
            connection
                .execute(
                    "UPDATE messages SET status = 'archived', reason = 'eaten', \
                     text_written = 'some', delivered_via = 'pigeon' WHERE number = 1",
                    [],
                )
                .unwrap();
            connection
                .execute("UPDATE messages SET at = X'FF' WHERE number = 2", [])
                .unwrap();
        }
        let unknown = store.message_table().message(1).unwrap().unwrap();
        assert_eq!(
            became(&unknown),
            (
                DeliveryStatus::Unknown,
                Some(DeliveryFailure::Unknown),
                TextWritten::Unrecognized,
                Some(false),
                Some(DeliveredVia::Unknown)
            )
        );
        assert_eq!(
            numbers(&store.message_table().inbox("a2").unwrap()),
            ["m1", "m3"],
            "the unreadable m2 is skipped"
        );
        assert_eq!(
            store.message_table().pending_messages().unwrap().len(),
            1,
            "only m3 is pending"
        );
        let kept: Vec<u8> = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT at FROM messages WHERE number = 2", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, [0xFF], "the row is not rewritten");
    }
}
