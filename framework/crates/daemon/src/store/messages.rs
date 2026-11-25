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
//! would keep a new one, so that two calls with one ID keep one message. A withdrawal with a
//! request ID keeps only its receipt. Confirmed command replies are also kept as receipts,
//! hidden from inbox and history reads. `notify_failure` preserves an authenticated Inbox send's
//! notice decision when its delivery is still pending at takeover.
//!
//! A message takes its number in the transaction that writes it, so no message lacks one and no
//! number goes to two. Deleting messages never lowers the counter. A value this build does not
//! know reads as the protocol's `unknown` or `unrecognized`, never as `pending`; a row that cannot
//! be read at all is logged, skipped and left as it is.

use std::sync::Arc;

use facade_base::model::message::{Delivery, Message, WindowDelivery, WindowDeliveryOutcome};
use facade_base::{model::agent::AgentRef, model::message::MessageRef};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::{Store, log};

/// What a message not yet delivered satisfies. `messages_undelivered` holds the messages it
/// selects, and a query that repeats it uses that index.
const UNDELIVERED: &str = "status != 'success'";

/// The columns a message is read from and written to, in order.
const COLUMNS: &str = "number, \"from\", from_name, \"to\", text, reply_to, at, status, reason, \
                       text_written, enter_written, deadline, delivered_via, delivered_at, paste, \
                       from_window, call_id, result_owed, result, human_windows, \
                       from_machine_id, reply_to_machine_id, result_owed_machine_id, withdrawn, \
                       command_line_reply, notify_failure";

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

pub(super) fn migrate_withdrawals(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "ALTER TABLE messages ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0;
         DROP INDEX messages_request;
         CREATE INDEX messages_request ON messages
             (\"from\", from_machine_id, \"to\", request_id, at) WHERE request_id IS NOT NULL;",
    )
}

pub(super) fn migrate_send_routes(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "ALTER TABLE messages ADD COLUMN private_receipt INTEGER NOT NULL DEFAULT 0;
         CREATE TABLE send_routes (
             sender TEXT NOT NULL,
             request_id TEXT NOT NULL,
             target TEXT NOT NULL,
             machine_id TEXT NOT NULL,
             agent_id TEXT NOT NULL,
             reply_message_id TEXT,
             reply_machine_id TEXT,
             at TEXT NOT NULL,
             PRIMARY KEY (sender, request_id, target)
         );",
    )
}

pub(super) fn migrate_command_line_replies(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "ALTER TABLE messages ADD COLUMN command_line_reply INTEGER NOT NULL DEFAULT 0;",
    )
}

pub(super) fn migrate_failure_notices(connection: &Connection) -> rusqlite::Result<()> {
    connection
        .execute_batch("ALTER TABLE messages ADD COLUMN notify_failure INTEGER NOT NULL DEFAULT 0;")
}

/// The first recipient and checked reply of a send, retained by its originating machine.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SendRoute {
    pub(crate) recipient: AgentRef,
    pub(crate) reply: Option<MessageRef>,
}

/// A locally resolved route that becomes durable with its first message.
#[derive(Clone)]
pub(crate) struct SendRouteBinding {
    pub(crate) target: String,
    pub(crate) route: SendRoute,
}

fn keep_send_route(
    connection: &Connection,
    sender: &str,
    request_id: &str,
    target: &str,
    route: &SendRoute,
    route_cutoff: impl FnOnce() -> String,
) -> rusqlite::Result<(SendRoute, bool)> {
    let inserted = connection.execute(
        "INSERT INTO send_routes
        (sender,request_id,target,machine_id,agent_id,reply_message_id,reply_machine_id,at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(sender,request_id,target) DO UPDATE SET
        at=excluded.at, machine_id=excluded.machine_id, agent_id=excluded.agent_id,
        reply_message_id=excluded.reply_message_id, reply_machine_id=excluded.reply_machine_id
        WHERE at < ?9",
        params![
            sender,
            request_id,
            target,
            route.recipient.machine_id,
            route.recipient.agent_id,
            route.reply.as_ref().map(|reply| &reply.message_id),
            route.reply.as_ref().map(|reply| &reply.machine_id),
            facade_base::time::iso_now(),
            route_cutoff()
        ],
    )?;
    if inserted != 0 {
        return Ok((route.clone(), false));
    }
    let retained = connection.query_row(
        "SELECT machine_id, agent_id, reply_message_id, reply_machine_id FROM send_routes
        WHERE sender = ?1 AND request_id = ?2 AND target = ?3",
        params![sender, request_id, target],
        read_send_route,
    )?;
    Ok((retained, true))
}

fn read_send_route(row: &Row<'_>) -> rusqlite::Result<SendRoute> {
    let reply_id: Option<String> = row.get(2)?;
    let reply_machine: Option<String> = row.get(3)?;
    Ok(SendRoute {
        recipient: AgentRef {
            machine_id: row.get(0)?,
            agent_id: row.get(1)?,
        },
        reply: reply_id
            .zip(reply_machine)
            .map(|(message_id, machine_id)| MessageRef {
                message_id,
                machine_id,
            }),
    })
}

fn saved_route(
    connection: &Connection,
    sender: &str,
    request: &str,
    target: &str,
) -> rusqlite::Result<Option<(String, SendRoute)>> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            "SELECT machine_id, agent_id, reply_message_id, reply_machine_id, at FROM send_routes
         WHERE sender = ?1 AND request_id = ?2 AND target = ?3",
            params![sender, request, target],
            |row| Ok((row.get(4)?, read_send_route(row)?)),
        )
        .optional()
}

fn kept_number(connection: &Connection, number: u64) -> rusqlite::Result<Option<KeptMessage>> {
    use rusqlite::OptionalExtension;
    connection
        .prepare_cached(&format!("SELECT {COLUMNS} FROM messages WHERE number = ?1"))?
        .query_row([number as i64], read_message)
        .optional()
}

struct RouteChange {
    sender: String,
    request: String,
    target: String,
    before: Option<(String, SendRoute)>,
    after: Option<(String, SendRoute)>,
}

/// The rows a save expects after commitment, including a separately retained route.
pub(crate) struct SaveFacts {
    row: Option<(u64, KeptMessage)>,
    route: Option<RouteChange>,
}

impl SaveFacts {
    pub(crate) fn states(&self, connection: &Connection) -> rusqlite::Result<(bool, bool)> {
        let (mut before, mut after) = (true, true);
        if let Some((number, expected)) = &self.row {
            let saved = kept_number(connection, *number)?;
            before = saved.is_none();
            after = saved.as_ref() == Some(expected);
        }
        if let Some(route) = &self.route
            && route.before != route.after
        {
            let saved = saved_route(connection, &route.sender, &route.request, &route.target)?;
            before &= saved == route.before;
            after &= saved == route.after;
        }
        Ok((before, after))
    }
}

/// The affected rows in one delivery operation, before and after its savepoint.
pub(crate) struct PasteFacts {
    before: PasteSnapshot,
    after: PasteSnapshot,
    rows: PasteRows,
}

#[derive(Default)]
struct PasteRows {
    delivery: Vec<u64>,
    full: Vec<u64>,
}

#[derive(PartialEq, Eq)]
struct PasteSnapshot {
    delivery: Vec<Option<PasteDelivery>>,
    full: Vec<Option<KeptMessage>>,
}

/// A normal handoff changes delivery and paste facts without rewriting the message.
/// Withdrawals and result writes can change the contents and retain full row evidence.
#[derive(PartialEq, Eq)]
struct PasteDelivery {
    delivery: Delivery,
    paste: Option<i64>,
    owed: Option<i64>,
    owing_to: Option<String>,
    withdrawn: bool,
    private_receipt: bool,
}

impl PasteRows {
    fn snapshot(&self, connection: &Connection) -> rusqlite::Result<PasteSnapshot> {
        let mut delivery = Vec::with_capacity(self.delivery.len());
        if !self.delivery.is_empty() {
            let mut query = connection.prepare_cached(
                "SELECT status, reason, text_written, enter_written, deadline, delivered_via,
                 delivered_at, paste, result_owed, result_owed_machine_id, withdrawn, private_receipt
                 FROM messages WHERE number = ?1",
            )?;
            for &number in &self.delivery {
                let row = query.query_row([number as i64], |row| {
                    Ok(PasteDelivery {
                        delivery: read_delivery(row)?,
                        paste: row.get("paste")?,
                        owed: row.get("result_owed")?,
                        owing_to: row.get("result_owed_machine_id")?,
                        withdrawn: row.get("withdrawn")?,
                        private_receipt: row.get("private_receipt")?,
                    })
                });
                delivery.push(row.optional()?);
            }
        }
        let full = self
            .full
            .iter()
            .map(|&number| kept_number(connection, number))
            .collect::<rusqlite::Result<_>>()?;
        Ok(PasteSnapshot { delivery, full })
    }
}

impl PasteFacts {
    fn capture<T>(
        connection: &Connection,
        rows: PasteRows,
        write: impl FnOnce(&PasteSnapshot) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<(T, Self)> {
        let before = rows.snapshot(connection)?;
        let result = write(&before)?;
        let after = rows.snapshot(connection)?;
        Ok((
            result,
            Self {
                before,
                after,
                rows,
            },
        ))
    }

    pub(crate) fn states(&self, connection: &Connection) -> rusqlite::Result<(bool, bool)> {
        if self.before == self.after {
            return Ok((true, true));
        }
        let actual = self.rows.snapshot(connection)?;
        Ok((actual == self.before, actual == self.after))
    }
}

pub(crate) struct PasteWrite {
    pub(crate) settlement: Settlement,
    pub(crate) began: bool,
    pub(crate) facts: PasteFacts,
}

/// A send's own ID as its sender gave it, and the earliest time at which a kept message still
/// answers it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RequestId<'a> {
    pub(crate) id: &'a str,
    pub(crate) since: &'a str,
    pub(crate) caller_window_id: Option<&'a str>,
}

/// The origin of a command-line send that requested a reply.
pub(crate) struct CommandRequest {
    pub(crate) origin_machine: String,
    pub(crate) request_id: String,
}

/// What keeping a message with a request ID found: the message kept now, or the one its sender
/// kept with that ID before.
#[derive(Debug)]
pub(crate) enum Kept {
    New(Message),
    Earlier(KeptMessage),
}

pub(crate) enum SaveRejection {
    ChangedRoute,
    MissingRecipient,
}

type SaveResult = Result<Kept, SaveRejection>;

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
    pub(crate) notify_failure: bool,
    pub(crate) withdrawn: bool,
    /// The window subscriptions that took or refused a message to the person.
    pub(crate) window_delivery: Option<Vec<WindowDeliveryOutcome>>,
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

/// A read of eligible pending mail, or of history as well when paging or reading the tail.
pub(crate) struct InboxPage<'a> {
    pub(crate) machine_id: &'a str,
    pub(crate) after: Option<u64>,
    pub(crate) last: Option<usize>,
    pub(crate) limit: usize,
    pub(crate) reply_to: Option<(&'a str, u64)>,
    pub(crate) now: &'a str,
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

fn read_delivery(row: &Row) -> rusqlite::Result<Delivery> {
    let reason: Option<String> = row.get("reason")?;
    let via: Option<String> = row.get("delivered_via")?;
    Ok(Delivery {
        status: named(row.get("status")?)?,
        reason: reason.map(named).transpose()?,
        text_written: named(row.get("text_written")?)?,
        enter_written: row.get("enter_written")?,
        deadline: row.get("deadline")?,
        delivered_via: via.map(named).transpose()?,
        delivered_at: row.get("delivered_at")?,
    })
}

fn read_message(row: &Row) -> rusqlite::Result<KeptMessage> {
    let number: i64 = row.get("number")?;
    let reply_to: Option<i64> = row.get("reply_to")?;
    let paste: Option<i64> = row.get("paste")?;
    let result_owed: Option<i64> = row.get("result_owed")?;
    let result_machine: Option<String> = row.get("result_owed_machine_id")?;
    // Facts this build cannot read leave a result its words.
    let result: Option<String> = row.get("result")?;
    let human_column = row.as_ref().column_index("human_windows")?;
    let window_delivery = row
        .get::<_, Option<String>>(human_column)?
        .map(|windows| {
            serde_json::from_str::<WindowDelivery>(&windows)
                .map(WindowDelivery::into_outcomes)
                .map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(
                        human_column,
                        rusqlite::types::Type::Text,
                        err.into(),
                    )
                })
        })
        .transpose()?;
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
            command_line_reply: row.get("command_line_reply")?,
            from_window: row.get("from_window")?,
            call_id: row.get("call_id")?,
            result: result.and_then(|facts| serde_json::from_str(&facts).ok()),
            at: row.get("at")?,
            delivery: read_delivery(row)?,
        },
        paste: paste.map(|paste| paste as u64),
        result_owed: result_owed
            .zip(result_machine)
            .map(|(number, machine_id)| MessageRef {
                machine_id,
                message_id: format!("m{number}"),
            }),
        window_delivery,
        withdrawn: row.get("withdrawn")?,
        notify_failure: row.get("notify_failure")?,
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
    notify_failure: bool,
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
              NULL, ?17, NULL, NULLIF(?18, (SELECT machine_id FROM machine)), ?19, NULL, 0, ?20, ?21, ?22, ?23)"
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
            message.command_line_reply,
            notify_failure,
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
         AND request_id = ?4 AND at >= ?5 ORDER BY number LIMIT 1"
    ))?;
    let mut rows = statement.query(params![
        from,
        from_machine_id,
        to,
        request.id,
        request.since
    ])?;
    rows.next()?.map(read_message).transpose()
}

/// Writes `message` under the next number, in `connection`'s transaction. Returns it with its ID.
pub(super) fn insert(connection: &Connection, message: &Message) -> rusqlite::Result<Message> {
    let number = take_number(connection)?;
    write(connection, number, message, None, false)?;
    Ok(Message {
        message_id: format!("m{number}"),
        ..message.clone()
    })
}

fn insert_requested(
    connection: &Connection,
    message: &Message,
    request: Option<RequestId<'_>>,
    notify_failure: bool,
    binding: Option<&SendRouteBinding>,
    require_recipient: bool,
) -> rusqlite::Result<SaveResult> {
    let earlier = match request {
        Some(request) => find_request(
            connection,
            message.from_machine_id.as_deref(),
            &message.from,
            &message.to,
            request,
        )?,
        None => None,
    };
    if require_recipient && earlier.is_none() && !recipient_there(connection, &message.to)? {
        return Ok(Err(SaveRejection::MissingRecipient));
    }
    if let Some(binding) = binding {
        let request = request.expect("a route binding belongs to a request ID");
        let (pinned, _) = keep_send_route(
            connection,
            &message.from,
            request.id,
            &binding.target,
            &binding.route,
            crate::send_route_cutoff,
        )?;
        if pinned != binding.route {
            return Ok(Err(SaveRejection::ChangedRoute));
        }
    }
    if let Some(earlier) = earlier {
        return Ok(Ok(Kept::Earlier(earlier)));
    }
    let number = take_number(connection)?;
    write(connection, number, message, request, notify_failure)?;
    Ok(Ok(Kept::New(Message {
        message_id: format!("m{number}"),
        ..message.clone()
    })))
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
pub(super) fn delete_inbox(
    connection: &Connection,
    owner: &str,
    since: &str,
) -> rusqlite::Result<Vec<Gone>> {
    let mut archived = {
        let mut statement = connection.prepare(
            "UPDATE messages SET private_receipt = 1, text = '', from_name = NULL,
             reply_to = NULL, reply_to_machine_id = NULL, from_window = NULL,
             request_window_id = NULL, call_id = NULL, result = NULL,
             result_owed = NULL, result_owed_machine_id = NULL, human_windows = NULL
             WHERE \"to\" = ?1 AND withdrawn = 0 AND private_receipt = 0
             AND status <> 'pending' AND request_id IS NOT NULL AND at >= ?2
             RETURNING number",
        )?;
        statement
            .query_map(params![owner, since], |row| {
                Ok(Gone {
                    number: row.get::<_, i64>(0)? as u64,
                    to: owner.to_owned(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    archived.extend(delete_returning(
        connection,
        "\"to\" = ?1 AND withdrawn = 0 AND private_receipt = 0",
        owner,
    )?);
    Ok(archived)
}

/// Deletes the messages `filter` selects with `value`, returning each.
fn delete_returning(
    connection: &Connection,
    filter: &str,
    value: &str,
) -> rusqlite::Result<Vec<Gone>> {
    let mut statement = connection.prepare(&format!(
        "DELETE FROM messages WHERE {filter} RETURNING number, \"to\", (withdrawn OR private_receipt)"
    ))?;
    let mut rows = statement.query([value])?;
    let mut gone = Vec::new();
    while let Some(row) = rows.next()? {
        if !row.get::<_, bool>(2)? {
            gone.push(Gone {
                number: row.get::<_, i64>(0)? as u64,
                to: row.get(1)?,
            });
        }
    }
    Ok(gone)
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
    clear_result_debt(connection, prompt)?;
    if machine_id != local_machine(connection)? {
        return Ok(true);
    }
    let caller_there = recipient_there(connection, &result.to)?;
    if caller_there {
        write(connection, number, result, None, false)?;
    }
    Ok(caller_there)
}

fn clear_result_debt(connection: &Connection, prompt: u64) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE messages SET result_owed = NULL, result_owed_machine_id = NULL \
         WHERE number = ?1 AND (result_owed IS NOT NULL OR result_owed_machine_id IS NOT NULL)",
        [prompt as i64],
    )?;
    Ok(())
}

fn recipient_there(connection: &Connection, recipient: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM agents WHERE agent_id = ?1 AND exit_at IS NULL) \
         OR EXISTS (SELECT 1 FROM guests WHERE agent_id = ?1)",
        [recipient],
        |row| row.get(0),
    )
}

/// Preserves a withdrawn request's original settlement and discards its contents.
fn hide_withdrawal(connection: &Connection, number: u64) -> rusqlite::Result<()> {
    let number = number as i64;
    let kept = connection.execute(
        "UPDATE messages SET withdrawn = 1, text = '', from_name = NULL, reply_to = NULL,
         reply_to_machine_id = NULL, from_window = NULL, request_window_id = NULL, call_id = NULL,
         result = NULL, result_owed = NULL, result_owed_machine_id = NULL, human_windows = NULL
         WHERE number = ?1 AND request_id IS NOT NULL",
        [number],
    )?;
    if kept == 0 {
        connection.execute("DELETE FROM messages WHERE number = ?1", [number])?;
    }
    Ok(())
}

/// Writes message `number`'s delivery where its row satisfies `condition`. Returns whether a row
/// changed.
fn write_delivery(
    connection: &Connection,
    number: u64,
    delivery: &Delivery,
    condition: &str,
) -> rusqlite::Result<bool> {
    let mut write = connection.prepare_cached(&format!(
        "UPDATE messages SET status = ?2, reason = ?3, text_written = ?4, enter_written = ?5, \
         deadline = ?6, delivered_via = ?7, delivered_at = ?8, \
         result_owed = CASE WHEN ?2 = 'success' THEN NULL ELSE result_owed END, \
         result_owed_machine_id = CASE WHEN ?2 = 'success' THEN NULL ELSE result_owed_machine_id END \
         WHERE number = ?1 AND withdrawn = 0 AND private_receipt = 0 AND ({condition})"
    ))?;
    let changed = write.execute(params![
        number as i64,
        name(&delivery.status),
        delivery.reason.as_ref().map(name),
        name(&delivery.text_written),
        delivery.enter_written,
        delivery.deadline,
        delivery.delivered_via.as_ref().map(name),
        delivery.delivered_at,
    ])?;
    Ok(changed == 1)
}

/// The handle of the `messages` table, which the daemon's messages own: they number, keep, settle,
/// read and expire messages here. Every method blocks.
#[derive(Clone)]
pub(crate) struct MessageTable(Arc<Store>);

enum Withdrawal<'a> {
    Unstarted(&'a [u64]),
    CleanedPaste,
}

fn record_paste(connection: &Connection, numbers: &[u64]) -> rusqlite::Result<usize> {
    let Some(first) = numbers.first() else {
        return Ok(0);
    };
    let mut changed = 0;
    let mut set = connection.prepare_cached(
        "UPDATE messages SET paste = ?1
         WHERE number = ?2 AND status = 'pending' AND paste IS NULL
         AND withdrawn = 0 AND private_receipt = 0",
    )?;
    for number in numbers {
        changed += set.execute(params![*first as i64, *number as i64])?;
    }
    Ok(changed)
}

fn release_paste(connection: &Connection, number: u64) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        "UPDATE messages SET paste = NULL
         WHERE number = ?1 AND paste = ?1 AND status = 'pending'
         AND withdrawn = 0 AND private_receipt = 0",
        [number as i64],
    )?;
    Ok(changed == 1)
}

fn record_deliveries(
    connection: &Connection,
    deliveries: &[(u64, &Delivery)],
    condition: &str,
    results: &[(u64, Message)],
    withdrawal: Withdrawal<'_>,
) -> rusqlite::Result<Settlement> {
    let mut written = Settlement::default();
    for (number, delivery) in deliveries {
        let (withdraw, eligible) = match withdrawal {
            Withdrawal::CleanedPaste => (true, "status = 'pending' AND paste IS NOT NULL"),
            Withdrawal::Unstarted(numbers) if numbers.contains(number) => {
                (true, "status = 'pending' AND paste IS NULL")
            }
            Withdrawal::Unstarted(_) => (false, condition),
        };
        if !write_delivery(connection, *number, delivery, eligible)? {
            continue;
        }
        written.settled.push(*number);
        let result = results.iter().find(|(prompt, _)| prompt == number);
        if let Some((_, result)) = result
            && write_result(connection, *number, result)?
        {
            written.results.push(*number);
        }
        if withdraw {
            hide_withdrawal(connection, *number)?;
        }
    }
    Ok(written)
}

impl MessageTable {
    pub(crate) async fn read_turn(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.0.read_admission.lock().await
    }

    pub(crate) fn write_batch(
        &self,
        write: impl FnOnce(&mut super::Batch<'_>) -> rusqlite::Result<()>,
    ) -> super::BatchResult {
        self.0.write_batch(write)
    }

    pub(crate) fn verify_write<T>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> anyhow::Result<T> {
        self.0.verify_write(read)
    }

    pub(super) fn new(store: Arc<Store>) -> MessageTable {
        MessageTable(store)
    }

    /// Commits a message number before a result or command reply crosses a handoff.
    pub(crate) fn reserve_result_number(&self) -> anyhow::Result<u64> {
        self.0.transaction(
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
                write(connection, number, message, None, false)?;
                Ok(Some(Kept::New(message.clone())))
            },
        )
    }

    /// Reads the retained target, taking the cutoff under the connection lock.
    pub(crate) fn send_target(
        &self,
        sender: &str,
        request_id: &str,
        target: &str,
        route_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<Option<SendRoute>> {
        use rusqlite::OptionalExtension;
        self.0.read(
            || "read the original send recipient".into(),
            |connection| {
                connection
                    .query_row(
                        "SELECT machine_id, agent_id, reply_message_id, reply_machine_id FROM send_routes
                WHERE sender = ?1 AND request_id = ?2 AND target = ?3 AND at >= ?4",
                        params![sender, request_id, target, route_cutoff()],
                        read_send_route,
                    )
                    .optional()
            },
        )
    }

    /// Keeps the first resolved target for retries on this machine, including after takeover.
    /// Samples the cutoff inside the transaction after dating a new route.
    #[cfg(test)]
    pub(crate) fn keep_send_target(
        &self,
        sender: &str,
        request_id: &str,
        target: &str,
        route: &SendRoute,
        route_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<(SendRoute, bool)> {
        self.0.transaction(
            || "save the original send recipient".into(),
            |connection| {
                keep_send_route(connection, sender, request_id, target, route, route_cutoff)
            },
        )
    }

    pub(crate) fn keep_send_target_in(
        batch: &mut super::Batch<'_>,
        sender: String,
        request: String,
        binding: SendRouteBinding,
    ) -> rusqlite::Result<rusqlite::Result<((SendRoute, bool), SaveFacts)>> {
        batch.operation(|connection| {
            let target = binding.target;
            let before = saved_route(connection, &sender, &request, &target)?;
            let kept = keep_send_route(
                connection,
                &sender,
                &request,
                &target,
                &binding.route,
                crate::send_route_cutoff,
            )?;
            let after = saved_route(connection, &sender, &request, &target)?;
            let route = RouteChange {
                sender,
                request,
                target,
                before,
                after,
            };
            Ok((
                kept,
                SaveFacts {
                    row: None,
                    route: Some(route),
                },
            ))
        })
    }

    /// Takes the next number and writes `message` under it, in one transaction, with `request`,
    /// its send's request ID, where it had one. Where that transaction finds a message the sender
    /// kept with the same ID within its hour, it keeps nothing and answers that message.
    #[cfg(test)]
    pub(crate) fn insert_message(
        &self,
        message: &Message,
        request: Option<RequestId>,
        notify_failure: bool,
        binding: Option<&SendRouteBinding>,
    ) -> anyhow::Result<Kept> {
        match self.0.transaction(
            || "save a message".to_string(),
            |transaction| {
                insert_requested(
                    transaction,
                    message,
                    request,
                    notify_failure,
                    binding,
                    false,
                )
            },
        )? {
            Ok(kept) => Ok(kept),
            Err(SaveRejection::ChangedRoute) => {
                anyhow::bail!("the retained send route changed before saving")
            }
            Err(SaveRejection::MissingRecipient) => {
                unreachable!("the fixture does not require a recipient")
            }
        }
    }

    pub(crate) fn insert_message_in(
        batch: &mut super::Batch<'_>,
        message: &Message,
        request: Option<RequestId<'_>>,
        notify_failure: bool,
        binding: Option<&SendRouteBinding>,
    ) -> rusqlite::Result<rusqlite::Result<(SaveResult, SaveFacts)>> {
        batch.operation(|connection| {
            let route_key = request
                .zip(binding)
                .map(|(request, binding)| (request.id, &binding.target));
            let mut route = if let Some((id, target)) = route_key {
                Some(RouteChange {
                    sender: message.from.clone(),
                    request: id.to_owned(),
                    target: target.clone(),
                    before: saved_route(connection, &message.from, id, target)?,
                    after: None,
                })
            } else {
                None
            };
            let kept =
                insert_requested(connection, message, request, notify_failure, binding, true)?;
            if let Some(route) = &mut route {
                route.after =
                    saved_route(connection, &route.sender, &route.request, &route.target)?;
            }
            let row = match &kept {
                Ok(Kept::New(message)) => {
                    let number = number_of(message);
                    Some((
                        number,
                        kept_number(connection, number)?
                            .ok_or(rusqlite::Error::QueryReturnedNoRows)?,
                    ))
                }
                _ => None,
            };
            Ok((kept, SaveFacts { row, route }))
        })
    }

    pub(crate) fn find_request_in(
        batch: &mut super::Batch<'_>,
        from_machine_id: &str,
        from: &str,
        to: &str,
        request: RequestId<'_>,
    ) -> rusqlite::Result<rusqlite::Result<Option<KeptMessage>>> {
        batch.operation(|connection| {
            find_request(connection, Some(from_machine_id), from, to, request)
        })
    }

    /// The message this caller kept for `to` with the same request ID within its hour.
    pub(crate) fn find_request(
        &self,
        from_machine_id: &str,
        from: &str,
        to: &str,
        request: RequestId,
    ) -> anyhow::Result<Option<KeptMessage>> {
        self.0.read(
            || "read messages".to_string(),
            |connection| find_request(connection, Some(from_machine_id), from, to, request),
        )
    }

    /// Finds the origin and request ID of an exact marked send, including a retained withdrawal.
    pub(crate) fn command_request(
        &self,
        owner: &str,
        number: u64,
    ) -> anyhow::Result<Option<CommandRequest>> {
        self.0.with(
            || format!("read the command-line request for #m{number} in {owner}'s inbox"),
            |connection| {
                connection
                    .query_row(
                        "SELECT COALESCE(from_machine_id, (SELECT machine_id FROM machine)), request_id
                         FROM messages WHERE number = ?1 AND \"to\" = ?2 AND command_line_reply = 1
                         AND \"from\" = 'command_line' AND request_id IS NOT NULL",
                        params![number as i64, owner],
                        |row| {
                            Ok(CommandRequest {
                                origin_machine: row.get(0)?,
                                request_id: row.get(1)?,
                            })
                        },
                    )
                    .optional()
            },
        )
    }

    /// Keeps a confirmed reply at its reserved number as a private request receipt.
    pub(crate) fn keep_command_reply(
        &self,
        message: &Message,
        request: Option<RequestId<'_>>,
    ) -> anyhow::Result<Message> {
        self.0.transaction(
            || "save a command-line reply receipt".to_string(),
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
                    return Ok(earlier.message);
                }
                let number = number_of(message) as i64;
                write(transaction, number, message, request, false)?;
                transaction.execute(
                    "UPDATE messages SET private_receipt = 1 WHERE number = ?1",
                    [number],
                )?;
                Ok(message.clone())
            },
        )
    }

    /// Looks up a message in its owner's inbox without changing delivery state.
    pub(crate) fn inbox_message(
        &self,
        owner: &str,
        number: u64,
    ) -> anyhow::Result<Option<KeptMessage>> {
        self.0.read(
            || format!("read #m{number} in {owner}'s inbox"),
            |connection| {
                connection
                    .query_row(
                        &format!(
                            "SELECT {COLUMNS} FROM messages WHERE number = ?1 AND \"to\" = ?2 AND withdrawn = 0 AND private_receipt = 0"
                        ),
                        params![number as i64, owner],
                        read_message,
                    )
                    .optional()
            },
        )
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
        let changed = self.0.transaction(
            || format!("begin the delivery of #m{number}"),
            |connection| {
                connection.execute(
                    "UPDATE messages SET deadline = ?2, from_name = coalesce(from_name, ?3) \
                     WHERE number = ?1 AND status = 'pending' AND withdrawn = 0 AND private_receipt = 0 AND deadline IS NULL",
                    params![number as i64, deadline, from_name],
                )
            },
        )?;
        Ok(changed == 1)
    }

    /// Records, in one transaction, that the paste of `numbers` begins, named by its first.
    #[cfg(test)]
    pub(crate) fn begin_paste(&self, numbers: &[u64]) -> anyhow::Result<()> {
        let Some(first) = numbers.first() else {
            return Ok(());
        };
        self.0.transaction(
            || format!("record that #m{first}'s paste began"),
            |transaction| record_paste(transaction, numbers).map(|_| ()),
        )
    }

    pub(crate) fn write_paste_in(
        batch: &mut super::Batch<'_>,
        deliveries: &[(u64, &Delivery)],
        results: &[(u64, Message)],
        withdrawals: &[u64],
        cleaned_paste: bool,
        next: Option<u64>,
    ) -> rusqlite::Result<rusqlite::Result<PasteWrite>> {
        batch.operation(|connection| {
            let mut rows = PasteRows::default();
            for &(number, _) in deliveries {
                if cleaned_paste || withdrawals.contains(&number) {
                    rows.full.push(number);
                } else {
                    rows.delivery.push(number);
                }
            }
            rows.delivery.extend(next);
            for (_, message) in results {
                if let Some(reference) = &message.message_ref
                    && let Ok(number) = result_number(reference)
                {
                    rows.full.push(number as u64);
                }
            }
            let withdrawal = if cleaned_paste {
                Withdrawal::CleanedPaste
            } else {
                Withdrawal::Unstarted(withdrawals)
            };
            let ((settlement, began), facts) = PasteFacts::capture(connection, rows, |_| {
                let settlement = record_deliveries(
                    connection,
                    deliveries,
                    "status = 'pending'",
                    results,
                    withdrawal,
                )?;
                let began = match next {
                    Some(number) => record_paste(connection, &[number])? == 1,
                    None => false,
                };
                Ok((settlement, began))
            })?;
            Ok(PasteWrite {
                settlement,
                began,
                facts,
            })
        })
    }

    pub(crate) fn release_paste_in(
        batch: &mut super::Batch<'_>,
        number: u64,
    ) -> rusqlite::Result<rusqlite::Result<(bool, PasteFacts)>> {
        batch.operation(|connection| {
            let rows = PasteRows {
                delivery: vec![number],
                full: Vec::new(),
            };
            PasteFacts::capture(connection, rows, |_| release_paste(connection, number))
        })
    }

    pub(crate) fn withdraw_in(
        batch: &mut super::Batch<'_>,
        number: u64,
        delivery: &Delivery,
        unused_grant: bool,
    ) -> rusqlite::Result<rusqlite::Result<(bool, PasteFacts)>> {
        batch.operation(|connection| {
            let rows = PasteRows {
                delivery: Vec::new(),
                full: vec![number],
            };
            PasteFacts::capture(connection, rows, |before| {
                let can_withdraw_grant = unused_grant
                    && before.full[0]
                        .as_ref()
                        .is_some_and(|kept| kept.paste == Some(number));
                let withdrawal = if can_withdraw_grant {
                    Withdrawal::CleanedPaste
                } else {
                    Withdrawal::Unstarted(std::slice::from_ref(&number))
                };
                let written = record_deliveries(
                    connection,
                    &[(number, delivery)],
                    "status = 'pending'",
                    &[],
                    withdrawal,
                )?;
                Ok(written.settled.contains(&number))
            })
        })
    }

    /// Writes, in one transaction, each delivery whose message is still pending, and the results
    /// that the prompts among them owe, each paired with its prompt's number. A result is written
    /// only for a caller still there. A message settled before, or deleted with its recipient's
    /// inbox, is left as it is.
    #[cfg(test)]
    pub(crate) fn settle_messages(
        &self,
        settled: &[(u64, &Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.settle_with_withdrawals(settled, results, &[])
    }

    /// Settles still-pending deliveries and withdraws only those whose paste has yet to start.
    /// Owed results, the final receipt, and the withdrawal are committed with the delivery.
    #[cfg(test)]
    pub(crate) fn settle_with_withdrawals(
        &self,
        settled: &[(u64, &Delivery)],
        results: &[(u64, Message)],
        withdrawals: &[u64],
    ) -> anyhow::Result<Settlement> {
        self.write_deliveries(
            settled,
            "status = 'pending'",
            results,
            Withdrawal::Unstarted(withdrawals),
        )
    }

    /// Post uses this after the terminal confirms clearing its own paste before Enter.
    #[cfg(test)]
    pub(crate) fn settle_cleaned_paste(
        &self,
        settled: &[(u64, &Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.write_deliveries(
            settled,
            "status = 'pending'",
            results,
            Withdrawal::CleanedPaste,
        )
    }

    /// Writes, in one transaction, the delivery of each message a read handed over, unless it was
    /// delivered before, and the results the prompts among them owe, as `settle_messages` does.
    #[cfg(test)]
    pub(crate) fn record_reads(
        &self,
        read: &[(u64, &Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.write_deliveries(read, UNDELIVERED, results, Withdrawal::Unstarted(&[]))
    }

    #[cfg(test)]
    fn write_deliveries(
        &self,
        deliveries: &[(u64, &Delivery)],
        condition: &str,
        results: &[(u64, Message)],
        withdrawal: Withdrawal<'_>,
    ) -> anyhow::Result<Settlement> {
        self.0.transaction(
            || "save the delivery of messages".to_string(),
            |transaction| {
                record_deliveries(transaction, deliveries, condition, results, withdrawal)
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
        self.0.read(
            || "read messages".to_owned(),
            |connection| select_from(connection, filter, limit, values),
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
    #[cfg(test)]
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
    #[cfg(test)]
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
    #[cfg(test)]
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
            "number IN (SELECT number FROM messages WHERE withdrawn = 0 AND private_receipt = 0 AND \"to\" = ?1{undelivered} \
             ORDER BY number DESC LIMIT {last})"
        );
        self.select_messages(&filter, None, [owner])
    }

    /// Selects only messages this owner can take, plus delivered history on an explicit history
    /// read. Filters run before the page limit so an earlier unrelated message cannot block a reply.
    pub(crate) fn readable_inbox(
        &self,
        owner: &str,
        page: &InboxPage<'_>,
    ) -> anyhow::Result<Vec<Message>> {
        self.readable_page(owner, page, None)
    }

    /// Selects readable replies from the exact agent on its machine before applying the limit.
    pub(crate) fn readable_replies(
        &self,
        owner: &str,
        page: &InboxPage<'_>,
        sender: &AgentRef,
    ) -> anyhow::Result<Vec<Message>> {
        self.readable_page(owner, page, Some(sender))
    }

    fn readable_page(
        &self,
        owner: &str,
        page: &InboxPage<'_>,
        sender: Option<&AgentRef>,
    ) -> anyhow::Result<Vec<Message>> {
        self.0.read(
            || "prepare an inbox page".into(),
            |connection| select_page(connection, owner, page, sender),
        )
    }

    pub(crate) fn read_page_in(
        batch: &mut super::Batch<'_>,
        owner: &str,
        page: &InboxPage<'_>,
        sender: Option<&AgentRef>,
    ) -> rusqlite::Result<rusqlite::Result<Vec<Message>>> {
        batch.operation(|connection| select_page(connection, owner, page, sender))
    }

    pub(crate) fn take_page_in(
        batch: &mut super::Batch<'_>,
        writes: &[(u64, &Delivery)],
    ) -> rusqlite::Result<rusqlite::Result<(Settlement, PasteFacts)>> {
        batch.operation(|connection| {
            let rows = PasteRows {
                delivery: writes.iter().map(|(number, _)| *number).collect(),
                full: Vec::new(),
            };
            PasteFacts::capture(connection, rows, |_| {
                let written = record_deliveries(
                    connection,
                    writes,
                    "status = 'pending' AND paste IS NULL",
                    &[],
                    Withdrawal::Unstarted(&[]),
                )?;
                if written.settled.len() != writes.len() {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                }
                Ok(written)
            })
        })
    }

    /// Every kept message of `owner`'s inbox, by number.
    #[cfg(test)]
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
                    "SELECT EXISTS (SELECT 1 FROM messages WHERE number = ?1 AND withdrawn = 0 AND private_receipt = 0)",
                    [number as i64],
                    |row| row.get(0),
                )
            },
        )
    }

    /// Deletes the messages sent before `before`, a time as `facade_base::time` writes it. Returns
    /// what it deleted.
    pub(crate) fn expire_messages(
        &self,
        before: &str,
        receipt_cutoff: impl FnOnce() -> String,
        route_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<Vec<Gone>> {
        self.0.transaction(
            || "delete expired messages".to_string(),
            |connection| {
                let since = receipt_cutoff();
                connection.execute("DELETE FROM send_routes WHERE at < ?1", [route_cutoff()])?;
                connection.execute(
                    "DELETE FROM messages WHERE (withdrawn OR private_receipt) AND at < ?1",
                    [since],
                )?;
                delete_returning(connection, "at < ?1", before)
            },
        )
    }
}

fn select_page(
    connection: &Connection,
    owner: &str,
    page: &InboxPage<'_>,
    sender: Option<&AgentRef>,
) -> rusqlite::Result<Vec<Message>> {
    let history = page.after.is_some() || page.last.is_some() || page.reply_to.is_some();
    let (reply_machine, reply_number) = page.reply_to.unzip();
    let values = params![
        owner,
        page.after.unwrap_or(0) as i64,
        page.now,
        history,
        reply_number.map(|number| number as i64),
        page.machine_id,
        reply_machine,
        sender.map(|sender| &sender.agent_id),
        sender.map(|sender| &sender.machine_id),
    ];
    let eligible = "\"to\" = ?1 AND number > ?2 \
        AND ((status = 'pending' AND paste IS NULL AND (deadline IS NULL OR deadline > ?3)) \
             OR (?4 AND status = 'success')) \
        AND (?5 IS NULL OR (reply_to = ?5 AND COALESCE(reply_to_machine_id, ?6) = ?7)) \
        AND (?8 IS NULL OR (\"from\" = ?8 AND from_machine_id IS NULLIF(?9, (SELECT machine_id FROM machine))))";
    let rows = match page.last {
        Some(last) => select_from(
            connection,
            &format!(
                "number IN (SELECT number FROM messages WHERE withdrawn = 0 AND private_receipt = 0 AND ({eligible}) ORDER BY number DESC LIMIT {last})"
            ),
            None,
            values,
        ),
        None => select_from(connection, eligible, Some(page.limit), values),
    }?;
    Ok(rows.into_iter().map(|row| row.message).collect())
}

fn select_from(
    connection: &Connection,
    filter: &str,
    limit: Option<usize>,
    values: impl rusqlite::Params,
) -> rusqlite::Result<Vec<KeptMessage>> {
    let limit = limit
        .map(|limit| format!(" LIMIT {limit}"))
        .unwrap_or_default();
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM messages WHERE withdrawn = 0 AND private_receipt = 0
         AND ({filter}) ORDER BY number{limit}"
    ))?;
    let mut rows = statement.query(values)?;
    let mut messages = Vec::new();
    while let Some(row) = rows.next()? {
        match read_message(row) {
            Ok(message) => messages.push(message),
            Err(error) => {
                let number = row
                    .get::<_, i64>(0)
                    .map_or("with no number".into(), |n| format!("#m{n}"));
                log(
                    "warn",
                    &format!("skipping message {number} that this build cannot read: {error}"),
                );
            }
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use facade_base::model::message::{DeliveredVia, DeliveryFailure, DeliveryStatus, TextWritten};

    use super::*;
    use crate::messages::tests::message;

    /// A test's own framework folder, deleted when it is dropped.
    struct Framework(PathBuf);

    impl Framework {
        fn new(test: &str) -> Framework {
            let dir =
                std::env::temp_dir().join(format!("facade-messages-{test}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Framework(dir)
        }

        fn open(&self) -> Arc<Store> {
            Store::open(&self.0, &[]).unwrap().store
        }
    }

    impl Drop for Framework {
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
            delivered_via: Some(DeliveredVia::ReadByRecipient),
            delivered_at: Some(at.into()),
        }
    }

    #[test]
    fn a_handoff_witness_distinguishes_a_commit_from_rollback_and_a_partial_change() {
        let framework = Framework::new("paste-witness");
        let store = framework.open();
        let table = store.message_table();
        for _ in 0..2 {
            store.insert_message(&message(0, "a2"), None).unwrap();
        }
        table.begin_paste(&[1]).unwrap();
        let delivered = read_at("2026-11-10T00:00:01.000Z");
        for rollback in [true, false] {
            let mut witness = None;
            let result = table.write_batch(|batch| {
                let written = MessageTable::write_paste_in(
                    batch,
                    &[(1, &delivered)],
                    &[],
                    &[],
                    false,
                    Some(2),
                )??;
                assert_eq!(written.settlement.settled, [1]);
                assert!(written.began);
                witness = Some(written.facts);
                if rollback {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                Ok(())
            });
            let witness = witness.unwrap();
            let states = || {
                table
                    .verify_write(|connection| witness.states(connection))
                    .unwrap()
            };
            if rollback {
                assert!(matches!(result, crate::store::BatchResult::Aborted(_)));
                assert_eq!(states(), (true, false));
            } else {
                assert!(matches!(result, crate::store::BatchResult::Committed));
                assert_eq!(states(), (false, true));
                let result = table.write_batch(|batch| {
                    assert!(MessageTable::release_paste_in(batch, 2)??.0);
                    Ok(())
                });
                assert!(matches!(result, crate::store::BatchResult::Committed));
                assert_eq!(states(), (false, false));
            }
        }
    }

    #[test]
    fn a_request_id_keeps_one_message_per_sender_and_recipient_within_the_hour() {
        let framework = Framework::new("send-request");
        let route = SendRoute {
            recipient: AgentRef {
                machine_id: "remote-machine".into(),
                agent_id: "a2".into(),
            },
            reply: Some(MessageRef {
                machine_id: "origin-machine".into(),
                message_id: "m7".into(),
            }),
        };
        {
            let store = framework.open();
            let (_, replay) = store
                .message_table()
                .keep_send_target("a1", "r1", "helper", &route, crate::send_route_cutoff)
                .unwrap();
            assert!(!replay);
        }
        let store = framework.open();
        let retained = store
            .message_table()
            .send_target("a1", "r1", "helper", crate::send_route_cutoff)
            .unwrap()
            .unwrap();
        assert_eq!(retained.recipient, route.recipient);
        assert_eq!(retained.reply, route.reply);
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
        let table = store.message_table();
        let stopped = failure(DeliveryFailure::Timeout);
        assert_eq!(
            table
                .settle_with_withdrawals(&[(1, &stopped)], &[], &[1])
                .unwrap()
                .settled,
            [1]
        );
        assert!(!table.keeps_message(1).unwrap());
        assert!(table.inbox_message("a2", 1).unwrap().is_none());
        assert_eq!(numbers(&table.inbox_last("a2", true, 2).unwrap()), ["m2"]);
        let repeated = store
            .find_request(
                "a1",
                "a2",
                RequestId {
                    id: "r1",
                    since: within,
                    caller_window_id: Some("other-window"),
                },
            )
            .unwrap()
            .unwrap();
        assert!(repeated.withdrawn);
        assert!(repeated.message.text.is_empty());
        assert_eq!(repeated.message.message_id, "m1");
        assert_eq!(repeated.message.delivery, stopped);
        assert!(matches!(keep(&message(0, "a2"), "r1", within),
                Kept::Earlier(kept) if kept.withdrawn && kept.message.message_id == "m1"));
        let after_the_hour = keep(&message(0, "a2"), "r1", "2026-11-10T00:00:00.001Z");
        assert!(matches!(after_the_hour, Kept::New(new) if new.message_id == "m3"));
        assert!(
            matches!(keep(&message(0, "a3"), "r1", within), Kept::New(new) if new.message_id == "m4")
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
        let message = message(0, "a2");
        let request = RequestId {
            id: "routed",
            since: "2000-01-01T00:00:00.000Z",
            caller_window_id: None,
        };
        let binding = SendRouteBinding {
            target: "worker".into(),
            route: SendRoute {
                recipient: AgentRef {
                    machine_id: "local".into(),
                    agent_id: "a2".into(),
                },
                reply: None,
            },
        };
        let routes = store.message_table();
        let retained = || {
            routes
                .send_target(
                    &message.from,
                    request.id,
                    &binding.target,
                    crate::send_route_cutoff,
                )
                .unwrap()
        };
        assert!(
            routes
                .insert_message(&message, Some(request), false, Some(&binding))
                .is_err()
        );
        assert!(
            retained().is_none(),
            "a failed message leaves no route or number"
        );
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER refuse")
            .unwrap();
        assert_eq!(
            routes
                .insert_message(&message, Some(request), false, Some(&binding))
                .unwrap()
                .into_message()
                .message_id,
            "m2",
            "the refused message took no number"
        );
        assert!(retained().is_some_and(|route| route == binding.route));
    }

    /// Every field of a message, its delivery and its paste survive a reopen.
    #[test]
    fn a_message_its_delivery_and_its_paste_survive_a_reopen() {
        let framework = Framework::new("reopen");
        let store = framework.open();
        let command = Message {
            from: "command_line".into(),
            from_name: None,
            reply_to: Some("m9".into()),
            command_line_reply: true,
            text: "two\nlines\tand a tab".into(),
            ..message(0, "a2")
        };
        let from_elsewhere = Message {
            from_window: Some("Design".into()),
            ..message(0, "a3")
        };
        let kept = [
            store
                .insert_message(
                    &command,
                    Some(RequestId {
                        id: "command-request",
                        since: &command.at,
                        caller_window_id: None,
                    }),
                )
                .unwrap()
                .into_message(),
            store
                .insert_message(&message(0, "a2"), None)
                .unwrap()
                .into_message(),
            store
                .message_table()
                .insert_message(&from_elsewhere, None, true, None)
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
        let store = framework.open();
        let table = store.message_table();
        let request = table.command_request("a2", 1).unwrap().unwrap();
        assert_eq!(request.request_id, "command-request");
        assert_eq!(
            request.origin_machine,
            local_machine(&store.connection.lock().unwrap()).unwrap()
        );
        let pending = store.message_table().pending_messages().unwrap();
        assert_eq!(
            pending,
            [
                KeptMessage {
                    message: kept[0].clone(),
                    paste: Some(1),
                    result_owed: None,
                    notify_failure: false,
                    window_delivery: None,
                    withdrawn: false,
                },
                KeptMessage {
                    message: kept[2].clone(),
                    paste: None,
                    result_owed: None,
                    notify_failure: true,
                    window_delivery: None,
                    withdrawn: false,
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
        let prompt = facade_base::model::message::PromptOutcome {
            message_id: prompt.message_id.clone(),
            delivery: delivery.clone(),
        };
        let outcome = facade_base::model::message::StartOutcome { agent, prompt };
        Message {
            message_id: reference.message_id.clone(),
            message_ref: Some(reference.clone()),
            from: facade_base::model::message::FACADE.into(),
            from_name: None,
            to: "a1".into(),
            text: facade_base::model::message::start_result_text(&outcome),
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
        let framework = Framework::new("prompt");
        let store = framework.open();
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
                notify_failure: false,
                window_delivery: None,
                withdrawn: false,
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
        let store = framework.open();
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
                true => drop(store.delete("a1", crate::an_hour_ago).unwrap()),
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
            store.delete("a1", crate::an_hour_ago).unwrap();
            store.delete("a2", crate::an_hour_ago).unwrap();
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
        let machine_id = local_machine(&store.connection.lock().unwrap()).unwrap();
        for (to, from_machine_id, reply) in [
            ("a2", Some("another-machine".into()), true),
            ("a3", None, true),
            ("a2", Some(machine_id.clone()), true),
            ("a2", None, true),
            ("a2", None, false),
        ] {
            store
                .insert_message(
                    &Message {
                        from_machine_id,
                        reply_to: reply.then(|| "m9".into()),
                        ..message(0, to)
                    },
                    None,
                )
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
        let table = store.message_table();
        table.begin_paste(&[4]).unwrap();
        let page = InboxPage {
            machine_id: &machine_id,
            after: None,
            last: None,
            limit: 1,
            reply_to: Some((&machine_id, 9)),
            now: "2026-11-10T00:00:01.000Z",
        };
        assert_eq!(numbers(&table.readable_inbox("a2", &page).unwrap()), ["m1"]);
        let sender = AgentRef {
            machine_id: machine_id.clone(),
            agent_id: "a1".into(),
        };
        assert_eq!(
            numbers(&table.readable_replies("a2", &page, &sender).unwrap()),
            ["m3"],
            "the first local reply stays readable after delivery"
        );
        let page = InboxPage {
            after: Some(3),
            ..page
        };
        assert!(
            table
                .readable_replies("a2", &page, &sender)
                .unwrap()
                .is_empty()
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
        store.delete("a1", crate::an_hour_ago).unwrap();
        assert!(store.message_table().inbox("a1").unwrap().is_empty());
        assert_eq!(numbers(&store.message_table().inbox("a2").unwrap()), ["m2"]);
        store.delete_inbox("a2", crate::an_hour_ago).unwrap();
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
        let table = store.message_table();
        let number = table.reserve_result_number().unwrap();
        let reply = Message {
            reply_to: Some("m1".into()),
            delivery: Delivery {
                delivered_via: Some(DeliveredVia::ReturnedToRequest),
                ..read_at("2026-11-10T00:00:00.000Z")
            },
            ..message(number, "#c1")
        };
        let request = RequestId {
            id: "confirmed-reply",
            since: "2026-11-09T23:00:00.000Z",
            caller_window_id: None,
        };
        assert_eq!(
            table.keep_command_reply(&reply, Some(request)).unwrap(),
            reply
        );
        assert!(table.message(number).unwrap().is_none());
        assert!(table.inbox("#c1").unwrap().is_empty());
        assert_eq!(
            store
                .message_table()
                .expire_messages(
                    "2026-10-12T00:00:00.000Z",
                    || request.since.to_string(),
                    crate::send_route_cutoff
                )
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
        assert_eq!(
            table.keep_command_reply(&reply, Some(request)).unwrap(),
            reply
        );
        store
            .message_table()
            .expire_messages(
                "2026-12-01T00:00:00.000Z",
                || "2026-11-10T00:00:00.001Z".to_string(),
                crate::send_route_cutoff,
            )
            .unwrap();
        let local = local_machine(&store.connection.lock().unwrap()).unwrap();
        assert!(
            table
                .find_request(&local, &reply.from, &reply.to, request)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .insert_message(&message(0, "a2"), None)
                .unwrap()
                .into_message()
                .message_id,
            "m4"
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
