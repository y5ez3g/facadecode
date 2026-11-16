//! Keeps agent records, agent and message numbers, messages, guests, editor windows and the files of
//! the CLIs' integrations in `$FACADE_HOME/core/facade.db`, with SQLite in WAL mode and
//! `synchronous=FULL`. The schema only grows: a later build may add tables and columns, never
//! rename, change or remove one.
//!
//! The daemon alone holds the connection. Each part of the daemon gets the handle of its own table
//! (`NumberTable`, `MessageTable`, `GuestTable`, `WindowTable`, `IntegrationTable`), with no
//! transaction of its own. A write across tables is one transaction here: a record with its start's
//! prompt, an agent or a guest with its inbox, a window's agents moving to the window that took it
//! over, and a settlement that writes a result only for a caller still there.
//!
//! The first open is one transaction: it creates the schema, imports `core/numbers`, starts the
//! agent numbers above every agent the keeper holds, and writes an `initialized` row; without that
//! row the next open tries again. A CLI the keeper holds without a record belongs to a start or a
//! removal that was cut short, or to a store that was lost, and recovery stops it.
//!
//! An exit's reason is kept by name, and a name this build does not know reads as unknown. A rule
//! or session this build cannot read leaves the agent without it and the row as it is. A row that
//! cannot be read at all is logged and skipped, and its ID still keeps the run, screen files and
//! session files that go with it from cleanup. A database that cannot be read stops the start.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use facade_base::daemon::{Message, TERMINAL_WINDOW};
use facade_base::files;
use facade_base::process::{EndReason, ProcessExit};
use rusqlite::{Connection, Row, params};

mod guests;
mod integrations;
mod messages;
mod windows;

pub(crate) use guests::{GuestRecord, GuestTable};
pub(crate) use integrations::{IntegrationFile, IntegrationTable};
pub(crate) use messages::{Gone, Kept, KeptMessage, MessageTable, RequestId, Settlement};
pub(crate) use windows::WindowTable;

/// The tables of the first schema. A transaction that failed before its commit runs them again.
const SCHEMA: &str = "
	CREATE TABLE IF NOT EXISTS numbers (next INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS agents (
		agent_id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		cli TEXT NOT NULL,
		cwd TEXT NOT NULL,
		pid INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		exit_code INTEGER,
		exit_signal TEXT,
		exit_at TEXT,
		exit_reason TEXT
	);
	CREATE TABLE IF NOT EXISTS initialized (at TEXT NOT NULL);
";

/// The columns `agents` gained after its first schema, with their types.
const AGENT_COLUMNS: [(&str, &str); 10] = [
    ("exit_reason", "TEXT"),
    ("rule", "TEXT"),
    ("session", "TEXT"),
    ("window_id", "TEXT"),
    ("creator", "TEXT"),
    ("root", "TEXT"),
    ("yolo", "INTEGER"),
    ("request_id", "TEXT"),
    ("prompt", "INTEGER"),
    ("location_id", "TEXT"),
];

fn log(level: &str, message: &str) {
    facade_base::log::write("daemon", level, message);
}

/// An agent's lasting record. Its checkpoint and screen log keep its title and terminal size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentRecord {
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) cli: String,
    pub(crate) cwd: String,
    pub(crate) pid: u32,
    pub(crate) created_at: String,
    pub(crate) exit: Option<ProcessExit>,
    /// The CLI rule the agent was started by, by name: proof that its start used that rule, which
    /// `cli` alone is not.
    pub(crate) rule: Option<String>,
    /// The session its CLI last reported.
    pub(crate) session: Option<String>,
    /// Its window: an editor window's ID, or `terminal`, as for a record from before windows.
    pub(crate) window_id: String,
    /// The agent that started it, none where the person did.
    pub(crate) creator: Option<String>,
    /// The first agent of its creation tree; a record from before creation trees is its own.
    pub(crate) root: String,
    /// Its run's YOLO; off for a record from before, as core started every CLI then.
    pub(crate) yolo: bool,
    /// The creator's own ID of its start, where it gave one: the same ID within the hour answers
    /// this agent again.
    pub(crate) request_id: Option<String>,
    /// The number of its start's prompt, which a repeated start answers again. The result the
    /// prompt owes, where it owes one, has the next number.
    pub(crate) prompt: Option<u64>,
    /// Its location's ID: the location its folder is, or the innermost one its folder is inside.
    /// None in a record from before it, whose location is its folder's.
    pub(crate) location_id: Option<String>,
}

/// The store as the daemon's start reads it.
pub(crate) struct OpenedStore {
    pub(crate) store: Arc<Store>,
    /// Every record this build can read.
    pub(crate) records: Vec<AgentRecord>,
    /// Every agent ID in the table, also of the rows this build cannot read.
    pub(crate) agent_ids: HashSet<String>,
}

/// `facade.db`, with its one connection.
pub(crate) struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    /// Opens the store in `core`, initializing it the first time with agent numbers above every
    /// agent in `held`, the CLIs the keeper holds. Blocks. A database that cannot be read fails.
    pub(crate) fn open(core: &Path, held: &[String]) -> anyhow::Result<OpenedStore> {
        let path = core.join("facade.db");
        make_private(core, &path)
            .map_err(|err| anyhow::anyhow!("could not make {} private: {err}", core.display()))?;
        let mut connection = Connection::open(&path)
            .map_err(|err| anyhow::anyhow!("could not open {}: {err}", path.display()))?;
        let unreadable =
            |err: rusqlite::Error| anyhow::anyhow!("could not read {}: {err}", path.display());
        let mode: String = connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
            .map_err(unreadable)?;
        anyhow::ensure!(
            mode.eq_ignore_ascii_case("wal"),
            "could not use write-ahead logging for {}: SQLite chose {mode}",
            path.display()
        );
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(unreadable)?;
        let numbers_file = NumbersFile(core.join("numbers"));
        if !is_initialized(&connection).map_err(unreadable)? {
            initialize(&mut connection, numbers_file.read()?, held)
                .map_err(|err| anyhow::anyhow!("could not initialize {}: {err}", path.display()))?;
            numbers_file.remove();
        } else if let Some(next) = numbers_file.read()? {
            // An import cut short after its commit: the larger counter wins, so that neither a
            // second import nor the file's deletion hands a number out twice.
            connection
                .execute("UPDATE numbers SET next = max(next, ?1)", [next as i64])
                .map_err(unreadable)?;
            numbers_file.remove();
        }
        grow(&mut connection)
            .map_err(|err| anyhow::anyhow!("could not update {}: {err}", path.display()))?;
        let (records, agent_ids) = read_records(&connection).map_err(unreadable)?;
        Ok(OpenedStore {
            store: Arc::new(Store {
                connection: Mutex::new(connection),
            }),
            records,
            agent_ids,
        })
    }

    /// Runs `work` in one transaction and commits it. Blocks.
    fn transaction<T>(
        &self,
        what: impl FnOnce() -> String,
        work: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> anyhow::Result<T> {
        let mut connection = self.connection.lock().unwrap();
        let done = connection.transaction().and_then(|transaction| {
            let value = work(&transaction)?;
            transaction.commit()?;
            Ok(value)
        });
        done.map_err(|err| anyhow::anyhow!("could not {}: {err}", what()))
    }

    /// Runs one statement's `work` on the connection. Blocks.
    fn with<T>(
        &self,
        what: impl FnOnce() -> String,
        work: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> anyhow::Result<T> {
        let connection = self.connection.lock().unwrap();
        work(&connection).map_err(|err| anyhow::anyhow!("could not {}: {err}", what()))
    }

    /// Commits agent `agent_id`'s new name. Blocks.
    pub(crate) fn rename(&self, agent_id: &str, name: &str) -> anyhow::Result<()> {
        self.with(
            || format!("save the name of {agent_id}"),
            |connection| {
                connection.execute(
                    "UPDATE agents SET name = ?1 WHERE agent_id = ?2",
                    [name, agent_id],
                )
            },
        )?;
        Ok(())
    }

    /// Commits a new agent record. Blocks.
    pub(crate) fn insert(&self, record: &AgentRecord) -> anyhow::Result<()> {
        self.with(
            || format!("save the record of {}", record.agent_id),
            |connection| insert_record(connection, record),
        )
    }

    /// Commits a new agent record with its start's prompt, in one transaction: the prompt takes the
    /// next message number, and where it `owes_result`, the number after it is kept for its result.
    /// Returns the numbered prompt and its result's number. Blocks.
    pub(crate) fn insert_with_prompt(
        &self,
        record: &AgentRecord,
        prompt: &Message,
        owes_result: bool,
    ) -> anyhow::Result<(Message, Option<u64>)> {
        self.transaction(
            || format!("save the record of {} with its prompt", record.agent_id),
            |transaction| {
                insert_record(transaction, record)?;
                let prompt = messages::insert(transaction, prompt)?;
                let number = messages::number_of(&prompt);
                transaction.execute(
                    "UPDATE agents SET prompt = ?1 WHERE agent_id = ?2",
                    params![number as i64, record.agent_id],
                )?;
                let owed = owes_result
                    .then(|| messages::owe_result(transaction, number))
                    .transpose()?;
                Ok((prompt, owed))
            },
        )
    }

    /// The agent `creator` (none for the person) started with request ID `request_id` at `since`
    /// or later: its ID, and its start's prompt's number where it had one. Blocks.
    pub(crate) fn find_start(
        &self,
        creator: Option<&str>,
        request_id: &str,
        since: &str,
    ) -> anyhow::Result<Option<(String, Option<u64>)>> {
        self.with(
            || "read the agent records".to_string(),
            |connection| {
                let mut statement = connection.prepare(
                    "SELECT agent_id, prompt FROM agents WHERE request_id = ?1 AND creator IS ?2 \
                     AND created_at >= ?3 ORDER BY created_at LIMIT 1",
                )?;
                let mut rows = statement.query(params![request_id, creator, since])?;
                let Some(row) = rows.next()? else {
                    return Ok(None);
                };
                let prompt: Option<i64> = row.get(1)?;
                Ok(Some((row.get(0)?, prompt.map(|number| number as u64))))
            },
        )
    }

    /// Commits an agent's exit. A deleted record stays deleted: a late exit never brings a removed
    /// agent back. Blocks.
    pub(crate) fn record_exit(&self, agent_id: &str, exit: &ProcessExit) -> anyhow::Result<()> {
        #[cfg(debug_assertions)]
        if failing_for_test("fail-exit-commit") {
            facade_base::service::mark_for_test("failed-exit-commit");
            anyhow::bail!("the exit store is temporarily unavailable");
        }
        self.with(
            || format!("save the exit of {agent_id}"),
            |connection| {
                connection.execute(
                    "UPDATE agents SET exit_code = ?1, exit_signal = ?2, exit_at = ?3, \
                     exit_reason = ?4 WHERE agent_id = ?5",
                    params![exit.code, exit.signal, exit.at, reason_name(exit), agent_id],
                )
            },
        )?;
        Ok(())
    }

    /// Commits a resumed run in one statement: its process ID, window and YOLO, and no exit. Blocks.
    pub(crate) fn record_restart(
        &self,
        agent_id: &str,
        pid: u32,
        window_id: &str,
        yolo: bool,
    ) -> anyhow::Result<()> {
        #[cfg(debug_assertions)]
        if failing_for_test("fail-restart-commit") {
            anyhow::bail!("the agent store is temporarily unavailable");
        }
        self.with(
            || format!("save the resumed run of {agent_id}"),
            |connection| {
                connection.execute(
                    "UPDATE agents SET pid = ?2, window_id = ?3, yolo = ?4, exit_code = NULL, \
                     exit_signal = NULL, exit_at = NULL, exit_reason = NULL WHERE agent_id = ?1",
                    params![agent_id, pid, window_id, yolo],
                )
            },
        )?;
        Ok(())
    }

    /// Commits the session an agent's CLI reported; nothing once the record is deleted. Blocks.
    pub(crate) fn record_session(
        &self,
        agent_id: &str,
        session: Option<&str>,
    ) -> anyhow::Result<()> {
        #[cfg(debug_assertions)]
        if failing_for_test("fail-session-commit") {
            anyhow::bail!("the agent store is temporarily unavailable");
        }
        self.with(
            || format!("save the session of {agent_id}"),
            |connection| {
                connection.execute(
                    "UPDATE agents SET session = ?1 WHERE agent_id = ?2",
                    params![session, agent_id],
                )
            },
        )?;
        Ok(())
    }

    /// Deletes an agent's record and its inbox, in one transaction. The messages it sent stay in
    /// their recipients' inboxes. Returns the messages deleted. Blocks.
    pub(crate) fn delete(&self, agent_id: &str) -> anyhow::Result<Vec<Gone>> {
        self.transaction(
            || format!("delete the record of {agent_id}"),
            |transaction| {
                transaction.execute("DELETE FROM agents WHERE agent_id = ?1", [agent_id])?;
                messages::delete_inbox(transaction, agent_id)
            },
        )
    }

    /// Deletes a guest's record and its inbox, in one transaction. The messages it sent stay in
    /// their recipients' inboxes. Returns the messages deleted. Blocks.
    pub(crate) fn delete_guest(&self, agent_id: &str) -> anyhow::Result<Vec<Gone>> {
        self.transaction(
            || format!("delete the record of guest {agent_id}"),
            |transaction| {
                transaction.execute("DELETE FROM guests WHERE agent_id = ?1", [agent_id])?;
                messages::delete_inbox(transaction, agent_id)
            },
        )
    }

    /// Moves every agent of window `from` to window `to` and deletes `from`'s row, in one
    /// transaction. Blocks.
    pub(crate) fn take_over(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.transaction(
            || format!("move the agents of window {from} to window {to}"),
            |transaction| {
                transaction.execute(
                    "UPDATE agents SET window_id = ?2 WHERE window_id = ?1",
                    [from, to],
                )?;
                transaction.execute("DELETE FROM windows WHERE window_id = ?1", [from])?;
                Ok(())
            },
        )
    }

    /// The handles of the tables the daemon's parts own.
    pub(crate) fn number_table(self: &Arc<Self>) -> NumberTable {
        NumberTable(self.clone())
    }

    pub(crate) fn message_table(self: &Arc<Self>) -> MessageTable {
        MessageTable::new(self.clone())
    }

    pub(crate) fn guest_table(self: &Arc<Self>) -> GuestTable {
        GuestTable::new(self.clone())
    }

    pub(crate) fn window_table(self: &Arc<Self>) -> WindowTable {
        WindowTable::new(self.clone())
    }

    pub(crate) fn integration_table(self: &Arc<Self>) -> IntegrationTable {
        IntegrationTable::new(self.clone())
    }

    /// Makes every later write fail, as a store that cannot be written does, until it is turned
    /// off again. For tests.
    #[cfg(test)]
    pub(crate) fn set_read_only(&self, read_only: bool) {
        self.connection
            .lock()
            .unwrap()
            .pragma_update(None, "query_only", read_only)
            .unwrap();
    }

    /// A store in memory, as an empty `facade.db` starts, for tests that need no file.
    #[cfg(test)]
    pub(crate) fn in_memory() -> Arc<Store> {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&mut connection, None, &[]).unwrap();
        grow(&mut connection).unwrap();
        Arc::new(Store {
            connection: Mutex::new(connection),
        })
    }
}

/// The handle of the agent number counter: records alone hands numbers out.
#[derive(Clone)]
pub(crate) struct NumberTable(Arc<Store>);

impl NumberTable {
    /// Takes the next agent number and commits the counter. A start that fails still uses its
    /// number up. Blocks.
    pub(crate) fn allocate_number(&self) -> anyhow::Result<u64> {
        let number: i64 = self.0.with(
            || "allocate an agent number".to_string(),
            |connection| {
                connection.query_row(
                    "UPDATE numbers SET next = next + 1 RETURNING next - 1",
                    [],
                    |row| row.get(0),
                )
            },
        )?;
        Ok(number as u64)
    }

    /// Raises the counter so the next agent number is above `given`; one already above stays.
    /// Blocks.
    pub(crate) fn raise_above(&self, given: u64) -> anyhow::Result<()> {
        self.0.with(
            || "raise the agent counter".to_string(),
            |connection| {
                connection.execute(
                    "UPDATE numbers SET next = MAX(next, ?1 + 1)",
                    [given as i64],
                )
            },
        )?;
        Ok(())
    }
}

/// Whether a test asked the store to fail a write, by the file `name` in `core/`.
#[cfg(debug_assertions)]
fn failing_for_test(name: &str) -> bool {
    facade_base::paths::core_dir().is_ok_and(|core| core.join(name).exists())
}

/// Makes `core/`, the database and its WAL and SHM files private: they name each agent's CLI and
/// folder. SQLite gives the files it creates the database file's permissions.
fn make_private(core: &Path, database: &Path) -> std::io::Result<()> {
    files::make_private(core)?;
    files::private_options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(database)?;
    for suffix in ["", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", database.display()));
        if let Err(err) = files::make_private(&file)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            return Err(err);
        }
    }
    Ok(())
}

/// An exit's reason as it is kept. A reason this build does not know is never written.
fn reason_name(exit: &ProcessExit) -> Option<&'static str> {
    exit.reason
        .filter(|reason| *reason != EndReason::Unknown)
        .map(EndReason::as_str)
}

/// Adds what a store from an earlier build lacks: the later columns of `agents`, then the later
/// tables, each step in one transaction.
fn grow(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    let columns = column_names(&transaction, "agents")?;
    for (column, kind) in AGENT_COLUMNS {
        if !columns.iter().any(|name| name == column) {
            transaction.execute_batch(&format!("ALTER TABLE agents ADD COLUMN {column} {kind}"))?;
        }
    }
    transaction.commit()?;
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS message_numbers (next INTEGER NOT NULL);
		INSERT INTO message_numbers (next) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM message_numbers);",
    )?;
    transaction.commit()?;
    integrations::add_table(connection)?;
    messages::add_table(connection)?;
    windows::add_table(connection)?;
    guests::add_table(connection)
}

/// The names of `table`'s columns.
fn column_names(connection: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    connection
        .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect()
}

/// Writes `record` as a new row of `agents`.
fn insert_record(connection: &Connection, record: &AgentRecord) -> rusqlite::Result<()> {
    let exit = record.exit.as_ref();
    connection.execute(
        "INSERT INTO agents (agent_id, name, cli, cwd, pid, created_at, exit_code, exit_signal, \
         exit_at, exit_reason, rule, session, window_id, creator, root, yolo, request_id, prompt, \
         location_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            record.agent_id,
            record.name,
            record.cli,
            record.cwd,
            record.pid,
            record.created_at,
            exit.and_then(|exit| exit.code),
            exit.and_then(|exit| exit.signal.clone()),
            exit.map(|exit| exit.at.clone()),
            exit.and_then(reason_name),
            record.rule,
            record.session,
            record.window_id,
            record.creator,
            record.root,
            record.yolo,
            record.request_id,
            record.prompt.map(|number| number as i64),
            record.location_id,
        ],
    )?;
    Ok(())
}

/// Whether the `initialized` row was committed.
fn is_initialized(connection: &Connection) -> rusqlite::Result<bool> {
    let has_table: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'initialized')",
        [],
        |row| row.get(0),
    )?;
    if !has_table {
        return Ok(false);
    }
    connection.query_row("SELECT EXISTS (SELECT 1 FROM initialized)", [], |row| {
        row.get(0)
    })
}

/// Creates the first schema in one transaction: imports the counter, raises it above every agent
/// in `held` so that no number the keeper still holds goes out again, and writes `initialized`.
fn initialize(
    connection: &mut Connection,
    imported: Option<u64>,
    held: &[String],
) -> rusqlite::Result<()> {
    let next = held
        .iter()
        .filter_map(|id| crate::records::agent_number(id).checked_add(1))
        .fold(imported.unwrap_or(1).max(1), u64::max);
    let transaction = connection.transaction()?;
    transaction.execute_batch(SCHEMA)?;
    transaction.execute("DELETE FROM numbers", [])?;
    transaction.execute("INSERT INTO numbers (next) VALUES (?1)", [next as i64])?;
    transaction.execute(
        "INSERT INTO initialized (at) VALUES (?1)",
        [facade_base::time::iso_now()],
    )?;
    transaction.commit()
}

/// Every record this build can read, and every agent ID in the table.
fn read_records(connection: &Connection) -> rusqlite::Result<(Vec<AgentRecord>, HashSet<String>)> {
    let agent_ids = connection
        .prepare("SELECT CAST(agent_id AS TEXT) FROM agents")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<HashSet<String>>>()?;
    let mut statement = connection.prepare("SELECT CAST(agent_id AS TEXT), * FROM agents")?;
    let mut rows = statement.query([])?;
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        match read_record(row) {
            Ok(record) => records.push(record),
            Err(err) => {
                let id: Option<String> = row.get(0).ok();
                log(
                    "warn",
                    &format!(
                        "skipping the agent record {} that this build cannot read: {err}; its run \
                         is left alone",
                        id.as_deref().unwrap_or("with no ID")
                    ),
                );
            }
        }
    }
    Ok((records, agent_ids))
}

fn read_record(row: &Row) -> rusqlite::Result<AgentRecord> {
    // A value this build cannot read leaves the agent without it; the row keeps it.
    fn optional<T: rusqlite::types::FromSql>(row: &Row, column: &str) -> Option<T> {
        row.get::<_, Option<T>>(column).ok().flatten()
    }
    let agent_id: String = row.get("agent_id")?;
    let exit_at: Option<String> = row.get("exit_at")?;
    let (code, signal) = (row.get("exit_code")?, row.get("exit_signal")?);
    let reason: Option<String> = row.get("exit_reason")?;
    Ok(AgentRecord {
        name: row.get("name")?,
        cli: row.get("cli")?,
        cwd: row.get("cwd")?,
        pid: row.get("pid")?,
        created_at: row.get("created_at")?,
        exit: exit_at.map(|at| ProcessExit {
            code,
            signal,
            reason: reason.as_deref().map(EndReason::from_name),
            at,
        }),
        rule: optional(row, "rule"),
        session: optional::<String>(row, "session").filter(|session| {
            facade_rules::parse_session_id(session).is_some_and(|id| id == *session)
        }),
        window_id: row
            .get::<_, Option<String>>("window_id")?
            .unwrap_or_else(|| TERMINAL_WINDOW.to_string()),
        creator: optional(row, "creator"),
        root: optional(row, "root").unwrap_or_else(|| agent_id.clone()),
        yolo: optional(row, "yolo").unwrap_or(false),
        request_id: optional(row, "request_id"),
        prompt: optional::<i64>(row, "prompt").map(|number| number as u64),
        location_id: optional(row, "location_id"),
        agent_id,
    })
}

/// `core/numbers`: the next agent number from before the store, imported once.
struct NumbersFile(PathBuf);

impl NumbersFile {
    /// The next number, or None without the file. A file that does not hold one is an error, never
    /// a reset to 1.
    fn read(&self) -> anyhow::Result<Option<u64>> {
        let text = match std::fs::read_to_string(&self.0) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => anyhow::bail!("could not read {}: {err}", self.0.display()),
        };
        match text.trim().parse::<u64>() {
            Ok(next) if next >= 1 => Ok(Some(next)),
            _ => anyhow::bail!(
                "invalid agent counter in {}: {text:?}; set a valid next number before restarting \
                 Facade",
                self.0.display()
            ),
        }
    }

    /// Deletes the file once the store holds its number.
    fn remove(&self) {
        if let Err(err) = std::fs::remove_file(&self.0)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            log(
                "warn",
                &format!(
                    "could not delete {} after importing it: {err}",
                    self.0.display()
                ),
            );
        }
    }
}

/// The table handles' methods on the store itself, so that the store's tests read as one.
#[cfg(test)]
impl Store {
    pub(crate) fn allocate_number(self: &Arc<Self>) -> anyhow::Result<u64> {
        self.number_table().allocate_number()
    }
    pub(crate) fn insert_message(
        self: &Arc<Self>,
        message: &Message,
        request: Option<RequestId>,
    ) -> anyhow::Result<Kept> {
        self.message_table().insert_message(message, request)
    }
    pub(crate) fn find_request(
        self: &Arc<Self>,
        from: &str,
        request: RequestId,
    ) -> anyhow::Result<Option<KeptMessage>> {
        self.message_table().find_request(from, request)
    }
    pub(crate) fn settle_messages(
        self: &Arc<Self>,
        settled: &[(u64, &facade_base::daemon::Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.message_table().settle_messages(settled, results)
    }
    pub(crate) fn record_reads(
        self: &Arc<Self>,
        read: &[(u64, &facade_base::daemon::Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.message_table().record_reads(read, results)
    }
    pub(crate) fn message(self: &Arc<Self>, number: u64) -> anyhow::Result<Option<Message>> {
        self.message_table().message(number)
    }
    pub(crate) fn begin_prompt(
        self: &Arc<Self>,
        number: u64,
        deadline: &str,
        from_name: Option<&str>,
    ) -> anyhow::Result<bool> {
        self.message_table()
            .begin_prompt(number, deadline, from_name)
    }
    pub(crate) fn keep_guest(self: &Arc<Self>, guest: &GuestRecord) -> anyhow::Result<()> {
        self.guest_table().keep_guest(guest)
    }
    pub(crate) fn heard_from_guest(self: &Arc<Self>, id: &str, at: &str) -> anyhow::Result<()> {
        self.guest_table().heard_from_guest(id, at)
    }
    pub(crate) fn guests(self: &Arc<Self>) -> anyhow::Result<Vec<GuestRecord>> {
        self.guest_table().guests()
    }
    pub(crate) fn guests_heard_before(
        self: &Arc<Self>,
        before: &str,
    ) -> anyhow::Result<Vec<GuestRecord>> {
        self.guest_table().guests_heard_before(before)
    }
    pub(crate) fn delete_inbox(&self, owner: &str) -> anyhow::Result<Vec<Gone>> {
        self.transaction(
            || "delete an inbox".to_string(),
            |transaction| messages::delete_inbox(transaction, owner),
        )
    }
    pub(crate) fn windows(
        self: &Arc<Self>,
    ) -> anyhow::Result<Vec<facade_base::daemon::WindowDescription>> {
        self.window_table().windows()
    }
    pub(crate) fn keep_integration_file(
        self: &Arc<Self>,
        cli: &str,
        file: &str,
        before: Option<&[u8]>,
        written: &[u8],
        at: &str,
    ) -> anyhow::Result<()> {
        self.integration_table()
            .keep_integration_file(cli, file, before, written, at)
    }
    pub(crate) fn forget_integration_file(
        self: &Arc<Self>,
        cli: &str,
        file: &str,
    ) -> anyhow::Result<()> {
        self.integration_table().forget_integration_file(cli, file)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn core(test: &str) -> crate::test_folder::TestFolder {
        crate::test_folder::TestFolder::new(&format!("store-{test}"))
    }

    pub(crate) fn record(id: &str) -> AgentRecord {
        AgentRecord {
            agent_id: id.into(),
            name: "Pixel".into(),
            cli: "claude".into(),
            cwd: "/work".into(),
            pid: 42,
            created_at: "2026-11-09T17:22:05.123Z".into(),
            exit: None,
            rule: Some("claude".into()),
            session: None,
            window_id: "terminal".into(),
            creator: None,
            root: id.into(),
            yolo: true,
            request_id: None,
            prompt: None,
            location_id: None,
        }
    }

    #[test]
    fn records_numbers_and_exits_survive_a_reopen_and_a_number_is_never_handed_out_twice() {
        let core = core("reopen");
        let opened = Store::open(&core, &[]).unwrap();
        assert!(opened.records.is_empty());
        let store = opened.store;
        assert_eq!(store.number_table().allocate_number().unwrap(), 1);
        store.insert(&record("a1")).unwrap();
        // A failed start still consumes the number committed for it.
        assert_eq!(store.number_table().allocate_number().unwrap(), 2);
        let exit = ProcessExit {
            code: None,
            signal: Some("SIGHUP".into()),
            reason: None,
            at: "2026-11-09T17:25:40.017Z".into(),
        };
        store.record_exit("a1", &exit).unwrap();
        drop(store);
        let opened = Store::open(&core, &[]).unwrap();
        assert_eq!(
            opened.records,
            vec![AgentRecord {
                exit: Some(exit.clone()),
                ..record("a1")
            }]
        );
        assert_eq!(
            opened.store.number_table().allocate_number().unwrap(),
            3,
            "numbers continue after a reopen and skip the uncommitted start"
        );
        opened.store.delete("a1").unwrap();
        opened.store.record_exit("a1", &exit).unwrap();
        assert!(
            Store::open(&core, &[]).unwrap().records.is_empty(),
            "an exit after removal must not bring the record back"
        );
    }

    /// A file of an integration keeps what it held before Facade's entries and when Facade first
    /// wrote it; a later write keeps what Facade wrote now, and what it held before as the write
    /// says. The record lasts until Facade's entries are out.
    #[test]
    fn an_integration_s_files_keep_what_they_held_before_until_facade_s_entries_are_out() {
        let core = core("integration");
        let store = Store::open(&core, &[]).unwrap().store;
        store
            .keep_integration_file(
                "codex",
                "/u/.codex/config.toml",
                Some(b"model = 1\n"),
                b"one",
                "t1",
            )
            .unwrap();
        store
            .keep_integration_file("codex", "/u/.codex/hooks.json", None, b"two", "t2")
            .unwrap();
        store
            .keep_integration_file(
                "codex",
                "/u/.codex/config.toml",
                Some(b"model = 2\n"),
                b"three",
                "t3",
            )
            .unwrap();
        drop(store);
        let store = Store::open(&core, &[]).unwrap().store;
        let kept = store
            .integration_table()
            .integration_files("codex")
            .unwrap();
        let file = |file: &str, before: Option<&[u8]>, written: &[u8], at: &str| IntegrationFile {
            file: file.into(),
            before: before.map(<[u8]>::to_vec),
            written: written.to_vec(),
            added_at: at.into(),
        };
        assert_eq!(
            kept,
            [
                file(
                    "/u/.codex/config.toml",
                    Some(b"model = 2\n"),
                    b"three",
                    "t1"
                ),
                file("/u/.codex/hooks.json", None, b"two", "t2")
            ]
        );
        assert!(
            store
                .integration_table()
                .integration_files("claude")
                .unwrap()
                .is_empty()
        );
        store
            .forget_integration_file("codex", "/u/.codex/hooks.json")
            .unwrap();
        assert_eq!(
            store
                .integration_table()
                .integration_files("codex")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn the_old_counter_is_imported_once_and_an_invalid_one_stops_the_open() {
        let core = core("import");
        std::fs::write(core.join("numbers"), "7\n").unwrap();
        let store = Store::open(&core, &[]).unwrap().store;
        assert!(
            !core.join("numbers").exists(),
            "the counter file is deleted after the import commits"
        );
        assert_eq!(store.number_table().allocate_number().unwrap(), 7);
        drop(store);
        // Retry an import interrupted after commit but before the text file was deleted. The
        // counter must not decrease.
        std::fs::write(core.join("numbers"), "3\n").unwrap();
        assert_eq!(
            Store::open(&core, &[])
                .unwrap()
                .store
                .allocate_number()
                .unwrap(),
            8
        );
        std::fs::write(core.join("numbers"), "seven\n").unwrap();
        assert!(
            Store::open(&core, &[]).is_err(),
            "an invalid counter must fail instead of resetting numbering"
        );
    }

    #[test]
    fn a_new_store_numbers_agents_above_the_keeper_s_and_records_none_of_them() {
        let core = core("adopt");
        // An interrupted initialization leaves a database file. Retry initialization rather than
        // treating the empty schema as initialized.
        Connection::open(core.join("facade.db"))
            .unwrap()
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE numbers (next INTEGER NOT NULL);")
            .unwrap();
        let opened = Store::open(&core, &["a4".into(), "a9".into()]).unwrap();
        assert!(opened.records.is_empty());
        assert_eq!(opened.store.number_table().allocate_number().unwrap(), 10);
    }

    #[test]
    fn a_row_this_build_cannot_read_stays_as_it_is_and_still_names_its_agent() {
        let core = core("unreadable");
        let store = Store::open(&core, &[]).unwrap().store;
        store.insert(&record("a1")).unwrap();
        store.insert(&record("a2")).unwrap();
        drop(store);
        let connection = Connection::open(core.join("facade.db")).unwrap();
        connection
            .execute(
                "UPDATE agents SET pid = 'not a number' WHERE agent_id = 'a2'",
                [],
            )
            .unwrap();
        drop(connection);
        for _ in 0..2 {
            let opened = Store::open(&core, &[]).unwrap();
            assert_eq!(
                opened
                    .records
                    .iter()
                    .map(|record| record.agent_id.as_str())
                    .collect::<Vec<_>>(),
                ["a1"]
            );
            assert!(
                opened.agent_ids.contains("a2"),
                "the unreadable row still names its agent"
            );
        }
        let connection = Connection::open(core.join("facade.db")).unwrap();
        let kept: String = connection
            .query_row("SELECT pid FROM agents WHERE agent_id = 'a2'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, "not a number", "the row must not be rewritten");
    }

    #[test]
    fn an_exit_reason_this_build_does_not_know_keeps_the_agent_ended_and_the_stored_name() {
        let core = core("reason");
        let store = Store::open(&core, &[]).unwrap().store;
        store.insert(&record("a1")).unwrap();
        let closed = ProcessExit {
            code: None,
            signal: None,
            reason: Some(EndReason::TerminalClosed),
            at: "2026-11-10T00:00:00.000Z".into(),
        };
        store.record_exit("a1", &closed).unwrap();
        store.insert(&record("a2")).unwrap();
        drop(store);
        let connection = Connection::open(core.join("facade.db")).unwrap();
        connection
            .execute(
                "UPDATE agents SET exit_at = 'later', exit_reason = 'eaten_by_a_grue' \
                 WHERE agent_id = 'a2'",
                [],
            )
            .unwrap();
        drop(connection);
        let opened = Store::open(&core, &[]).unwrap();
        let exits: Vec<Option<EndReason>> = opened
            .records
            .iter()
            .map(|record| record.exit.as_ref().and_then(|exit| exit.reason))
            .collect();
        assert_eq!(
            exits,
            [Some(EndReason::TerminalClosed), Some(EndReason::Unknown)],
            "the row stays readable and ended"
        );
        drop(opened);
        let connection = Connection::open(core.join("facade.db")).unwrap();
        let kept: String = connection
            .query_row(
                "SELECT exit_reason FROM agents WHERE agent_id = 'a2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, "eaten_by_a_grue", "the stored name is not rewritten");
    }

    #[test]
    fn a_store_from_before_exit_reasons_rules_and_sessions_gains_the_columns_and_keeps_its_rows() {
        let core = core("migrate");
        let connection = Connection::open(core.join("facade.db")).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
				CREATE TABLE numbers (next INTEGER NOT NULL); INSERT INTO numbers VALUES (3);
				CREATE TABLE agents (agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, cli TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER NOT NULL,
					created_at TEXT NOT NULL, exit_code INTEGER, exit_signal TEXT, exit_at TEXT);
				INSERT INTO agents VALUES ('a2', 'Pixel', 'claude', '/work', 42, 't', 0, NULL, 'u');
				CREATE TABLE initialized (at TEXT NOT NULL); INSERT INTO initialized VALUES ('t');",
            )
            .unwrap();
        drop(connection);
        let opened = Store::open(&core, &[]).unwrap();
        assert_eq!(opened.records.len(), 1);
        assert_eq!(
            opened.records[0]
                .exit
                .as_ref()
                .map(|exit| (exit.code, exit.reason)),
            Some((Some(0), None))
        );
        assert_eq!(
            (
                opened.records[0].rule.as_deref(),
                opened.records[0].session.as_deref()
            ),
            (None, None),
            "an earlier agent has no rule or session"
        );
        let tree = (
            opened.records[0].creator.as_deref(),
            opened.records[0].root.as_str(),
            opened.records[0].yolo,
        );
        assert_eq!(
            tree,
            (None, "a2", false),
            "an earlier agent is its own tree's first, launched with YOLO off as core launched \
             every CLI then"
        );
        let connection = opened.store.connection.lock().unwrap();
        let columns: Vec<String> = connection
            .prepare("SELECT name FROM pragma_table_info('agents')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let added = [
            "exit_reason",
            "rule",
            "session",
            "window_id",
            "creator",
            "root",
            "yolo",
        ];
        assert!(
            added
                .iter()
                .all(|column| columns.iter().any(|name| name == column)),
            "{columns:?}"
        );
        drop(connection);
        assert_eq!(opened.store.number_table().allocate_number().unwrap(), 3);
        drop(opened);
        assert_eq!(
            Store::open(&core, &[]).unwrap().records.len(),
            1,
            "opening again changes nothing"
        );
    }

    /// An agent's creator, the first agent of its tree and its run's YOLO survive a reopen as they
    /// were written.
    #[test]
    fn an_agent_s_creation_tree_and_yolo_survive_a_reopen() {
        let core = core("tree");
        let store = Store::open(&core, &[]).unwrap().store;
        let child = AgentRecord {
            creator: Some("a1".into()),
            root: "a1".into(),
            yolo: false,
            ..record("a2")
        };
        store.insert(&record("a1")).unwrap();
        store.insert(&child).unwrap();
        drop(store);
        let mut records = Store::open(&core, &[]).unwrap().records;
        records.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        assert_eq!(records, [record("a1"), child]);
    }

    #[test]
    fn a_resume_s_commit_sets_the_process_and_clears_the_exit_and_a_session_never_brings_a_record_back()
     {
        let core = core("restart");
        let store = Store::open(&core, &[]).unwrap().store;
        store
            .insert(&AgentRecord {
                exit: Some(ProcessExit {
                    code: Some(1),
                    signal: None,
                    reason: None,
                    at: "t".into(),
                }),
                ..record("a1")
            })
            .unwrap();
        store
            .record_session("a1", Some("86da4482-2bae-4a45-b193-a5664c19826a"))
            .unwrap();
        store.record_restart("a1", 77, "win-2", false).unwrap();
        drop(store);
        let opened = Store::open(&core, &[]).unwrap();
        let session = Some("86da4482-2bae-4a45-b193-a5664c19826a".into());
        let resumed = AgentRecord {
            pid: 77,
            session,
            window_id: "win-2".into(),
            yolo: false,
            ..record("a1")
        };
        assert_eq!(opened.records, [resumed]);
        opened.store.delete("a1").unwrap();
        opened.store.record_session("a1", None).unwrap();
        opened
            .store
            .record_restart("a1", 78, "terminal", true)
            .unwrap();
        assert!(
            Store::open(&core, &[]).unwrap().records.is_empty(),
            "a late write must not bring the record back"
        );
    }

    #[test]
    fn a_rule_or_session_this_build_cannot_read_leaves_the_agent_without_it_and_the_row_as_it_is() {
        let core = core("oddcolumns");
        let store = Store::open(&core, &[]).unwrap().store;
        store.insert(&record("a1")).unwrap();
        store.insert(&record("a2")).unwrap();
        drop(store);
        let connection = Connection::open(core.join("facade.db")).unwrap();
        connection
            .execute(
                "UPDATE agents SET rule = X'FF', session = 'not-a-session' WHERE agent_id = 'a1'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE agents SET session = '86DA4482-2BAE-4A45-B193-A5664C19826A' \
                 WHERE agent_id = 'a2'",
                [],
            )
            .unwrap();
        drop(connection);
        let opened = Store::open(&core, &[]).unwrap();
        let fields: Vec<(Option<String>, Option<String>)> = opened
            .records
            .iter()
            .map(|record| (record.rule.clone(), record.session.clone()))
            .collect();
        assert_eq!(
            fields,
            [(None, None), (Some("claude".into()), None)],
            "both agents stay listed without what cannot be read"
        );
        drop(opened);
        let connection = Connection::open(core.join("facade.db")).unwrap();
        let kept: (Vec<u8>, String) = connection
            .query_row(
                "SELECT rule, session FROM agents WHERE agent_id = 'a1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            kept,
            (vec![0xFF], "not-a-session".to_string()),
            "the stored values are not rewritten"
        );
    }

    #[test]
    fn a_database_that_cannot_be_read_is_an_error_not_an_empty_store() {
        let core = core("garbage");
        std::fs::write(core.join("facade.db"), vec![b'x'; 4096]).unwrap();
        assert!(Store::open(&core, &["a1".into()]).is_err());
    }

    /// Message numbers count on their own from 1 and continue after a reopen, also in a store
    /// created before they existed. A new name survives a reopen.
    #[test]
    fn message_numbers_and_new_names_survive_a_reopen() {
        let core = core("messages");
        // A store of an earlier build: initialized, without the message counter.
        Store::open(&core, &[])
            .unwrap()
            .store
            .connection
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE message_numbers")
            .unwrap();
        let store = Store::open(&core, &[]).unwrap().store;
        let message = || crate::messages::tests::message(0, "a2");
        let numbered = |store: &Arc<Store>| {
            store
                .insert_message(&message(), None)
                .unwrap()
                .into_message()
                .message_id
        };
        assert_eq!(
            (numbered(&store), numbered(&store)),
            ("m1".to_string(), "m2".to_string())
        );
        assert_eq!(
            store.number_table().allocate_number().unwrap(),
            1,
            "agent numbers count on their own"
        );
        store.insert(&record("a1")).unwrap();
        store.rename("a1", "Renamed").unwrap();
        drop(store);
        let opened = Store::open(&core, &[]).unwrap();
        assert_eq!(numbered(&opened.store), "m3");
        assert_eq!(opened.records[0].name, "Renamed");
    }
}
