//! Keeps agent records, agent and message numbers, messages, guests and editor windows in
//! `$FACADE_HOME/framework/facade.db`, with SQLite in WAL mode and `synchronous=FULL`.
//!
//! The daemon alone holds the connection. Its parts get table handles without independent
//! transactions. A write across tables is one transaction here: a record with its
//! members and its start's prompt, an agent or a guest with its inbox, and a settlement that writes
//! a result only for a caller still there.
//!
//! The first open creates the schema, seeds the counters and records this machine's ID in one
//! transaction. Agent numbers start above every agent the keeper holds. A CLI the keeper holds
//! without a record belongs to a start or removal that was cut short, or to a store that was lost,
//! and recovery stops it.
//!
//! An exit's reason is kept by name, and a name this build does not know reads as unknown. A rule
//! or session this build cannot read leaves the agent without it and the row as it is. A row that
//! cannot be read at all is logged and skipped, and its ID still keeps the run, screen files and
//! session files that go with it from cleanup. A database that cannot be read stops the start.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[cfg(test)]
use facade_base::model::machine::WindowDescription;
use facade_base::model::message::MessageRef;
use facade_base::process::{EndReason, ProcessExit, ProcessIdentity};
use facade_base::{files, settings};
use facade_base::{model::machine::WindowRef, model::message::Message};
use facade_rules::entries::{self, LaunchOptions};
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags, Row, params};

use crate::StartKey;

mod batch;
mod guests;
mod integrations;
mod machines;
mod membership;
mod messages;
mod windows;

pub(crate) use batch::{Batch, BatchResult, CommitUnknown};
pub(crate) use guests::{GuestRecord, GuestTable};
pub(crate) use messages::{
    CommandRequest, Gone, InboxPage, Kept, KeptMessage, MessageTable, PasteWrite, RequestId,
    SaveRejection, SendRoute, SendRouteBinding, Settlement,
};
#[cfg(test)]
use windows::WindowTable;

const SCHEMA_VERSION: i64 = 6;
const FILE_NAME: &str = "facade.db";

const SCHEMA: &str = "
	CREATE TABLE numbers (next INTEGER NOT NULL);
	CREATE TABLE message_numbers (next INTEGER NOT NULL);
	CREATE TABLE agents (
		agent_id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		cli TEXT NOT NULL,
		cwd TEXT NOT NULL,
		pid INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		exit_code INTEGER,
		exit_signal TEXT,
		exit_at TEXT,
		exit_reason TEXT,
		rule TEXT,
		session TEXT,
		creator TEXT,
		creator_machine_id TEXT,
		start_machine_id TEXT NOT NULL,
		start_window_id TEXT,
		root TEXT NOT NULL,
		root_machine_id TEXT NOT NULL,
		yolo INTEGER NOT NULL,
		request_id TEXT,
		prompt INTEGER,
		result_message_id TEXT,
		result_message_machine_id TEXT,
		location_id TEXT NOT NULL,
		location_machine_id TEXT,
		location_window_id TEXT
	);
	CREATE TABLE machine (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		machine_id TEXT NOT NULL,
		name TEXT NOT NULL
	);
";

fn log(level: &str, message: &str) {
    facade_base::log::write("daemon", level, message);
}

/// A logical editor window, in allocation order, and the instance last bound to it.
#[cfg(test)]
pub(crate) struct WindowRow {
    pub(crate) window_id: String,
    pub(crate) sequence: u64,
    pub(crate) description: WindowDescription,
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
    /// Its member windows, sorted by machine and logical ID.
    pub(crate) windows: Vec<WindowRef>,
    /// The window that supplied the run's location, when it started from an editor location.
    pub(crate) location_source_window: Option<WindowRef>,
    /// The agent that started it, none where the person did.
    pub(crate) creator: Option<String>,
    pub(crate) creator_machine_id: Option<String>,
    pub(crate) start_machine_id: String,
    pub(crate) start_window_id: Option<String>,
    /// The first agent of its creation tree.
    pub(crate) root: String,
    pub(crate) root_machine_id: String,
    /// Its run's YOLO.
    pub(crate) yolo: bool,
    /// The creator's own ID of its start, where it gave one: the same ID within the hour answers
    /// this agent again.
    pub(crate) request_id: Option<String>,
    /// The number of its start's prompt, which a repeated start answers again. The result the
    /// prompt owes, where it owes one, has the next number.
    pub(crate) prompt: Option<u64>,
    /// Its location's ID: the location its folder is, or the innermost one its folder is inside.
    pub(crate) location_id: String,
}

/// The record and the receipts kept for a repeated start.
pub(crate) struct KeptStart {
    pub(crate) agent_id: String,
    pub(crate) prompt: Option<u64>,
    pub(crate) result: Option<MessageRef>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum CreationSource {
    Agent,
    CommandLine,
    VsCode,
}

impl CreationSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::CommandLine => "command_line",
            Self::VsCode => "vs_code",
        }
    }
}

pub(crate) struct InitialLaunch<'a> {
    pub(crate) source: CreationSource,
    pub(crate) options: &'a facade_rules::entries::LaunchOptions,
    pub(crate) relay: &'a RelayRunRecord,
    pub(crate) command: Option<&'a str>,
}

#[derive(Default)]
pub(crate) struct LaunchDetails {
    pub(crate) started_at: Option<String>,
    pub(crate) source: Option<CreationSource>,
    pub(crate) options: Option<facade_rules::entries::LaunchOptions>,
}

/// The run identity retained for a reconnecting relay. It is never part of an agent view.
pub(crate) struct RelayRunRecord {
    pub(crate) process: ProcessIdentity,
    pub(crate) version: u32,
    pub(crate) digest: Option<[u8; 32]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RemovalCause {
    Expired,
    Removed,
}

/// The store as the daemon's start reads it.
pub(crate) struct OpenedStore {
    pub(crate) store: Arc<Store>,
    pub(crate) machine_id: String,
    pub(crate) machine_name: String,
    /// Every record this build can read.
    pub(crate) records: Vec<AgentRecord>,
    /// Every agent ID in the table, also of the rows this build cannot read.
    pub(crate) agent_ids: HashSet<String>,
}

/// `facade.db`, with its one connection.
pub(crate) struct Store {
    connection: Mutex<Connection>,
    path: Option<std::path::PathBuf>,
    reader: Option<Mutex<Connection>>,
    read_admission: tokio::sync::Mutex<()>,
    #[cfg(test)]
    commits: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    abort_next_batch: std::sync::atomic::AtomicBool,
}

impl Store {
    /// Reads the recorded name while the service is sleeping. A nonempty WAL can hold the name
    /// or the entire table after an ordinary idle exit, so SQLite must read it.
    pub(crate) fn offline_machine_name(framework: &Path) -> Option<String> {
        let path = framework.join(FILE_NAME);
        let wal = framework.join(format!("{FILE_NAME}-wal"));
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI;
        let uri = if std::fs::metadata(wal).is_ok_and(|wal| wal.len() > 0) {
            format!("{}?mode=ro&readonly_shm=1", files::sqlite_file_uri(&path)?)
        } else {
            files::immutable_uri(&path)?
        };
        let db = Connection::open_with_flags(uri, flags).ok()?;
        db.query_row("SELECT name FROM machine WHERE singleton = 1", [], |row| {
            row.get(0)
        })
        .ok()
    }

    /// Opens the store in `framework`, initializing it the first time with agent numbers above every
    /// agent in `held`, the CLIs the keeper holds. Blocks. A database that cannot be read fails.
    pub(crate) fn open(framework: &Path, held: &[String]) -> anyhow::Result<OpenedStore> {
        let path = framework.join(FILE_NAME);
        make_private(framework, &path).map_err(|err| {
            anyhow::anyhow!("could not make {} private: {err}", framework.display())
        })?;
        let mut connection = Connection::open(&path)
            .map_err(|err| anyhow::anyhow!("could not open {}: {err}", path.display()))?;
        let unreadable =
            |err: rusqlite::Error| anyhow::anyhow!("could not read {}: {err}", path.display());
        // Leave a rejected store's committed WAL in place when this connection closes.
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .map_err(unreadable)?;
        let (has_tables, has_saved_connections): (bool, bool) = connection
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table'),
                        EXISTS (SELECT 1 FROM sqlite_schema
                                WHERE type = 'table' AND name = 'saved_connections')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(unreadable)?;
        anyhow::ensure!(
            !has_tables || has_saved_connections,
            "{} belongs to an older development build. Remove {} before restarting Facade.",
            path.display(),
            framework.display()
        );
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, false)
            .map_err(unreadable)?;
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
        #[cfg(windows)]
        connection
            .pragma_update(None, "cache_size", -128)
            .map_err(unreadable)?;
        if !has_tables {
            initialize(&mut connection, held)
                .map_err(|err| anyhow::anyhow!("could not initialize {}: {err}", path.display()))?;
        }
        migrate(&mut connection, || {
            settings::read().unwrap_or_else(|error| {
                log(
                    "warn",
                    &format!("could not read settings to migrate launch options: {error}"),
                );
                settings::Settings::default()
            })
        })
        .map_err(|err| anyhow::anyhow!("could not migrate {}: {err}", path.display()))?;
        let (machine_id, machine_name) = connection
            .query_row(
                "SELECT machine_id, name FROM machine WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(unreadable)?;
        let (records, agent_ids) = read_records(&connection).map_err(unreadable)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let reader = Connection::open_with_flags(&path, flags).map_err(unreadable)?;
        #[cfg(windows)]
        reader
            .pragma_update(None, "cache_size", -128)
            .map_err(unreadable)?;
        Ok(OpenedStore {
            store: Arc::new(Store {
                connection: Mutex::new(connection),
                path: Some(path),
                reader: Some(Mutex::new(reader)),
                read_admission: tokio::sync::Mutex::new(()),
                #[cfg(test)]
                commits: std::sync::atomic::AtomicUsize::new(0),
                #[cfg(test)]
                abort_next_batch: std::sync::atomic::AtomicBool::new(false),
            }),
            machine_id,
            machine_name,
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
        let done = (|| -> anyhow::Result<T> {
            let transaction = connection.transaction()?;
            let value = work(&transaction)?;
            match self.commit(transaction) {
                BatchResult::Committed => Ok(value),
                BatchResult::Aborted(error) => Err(error),
                BatchResult::Uncertain(error) | BatchResult::Unverified(error) => {
                    Err(CommitUnknown(error).into())
                }
            }
        })();
        done.map_err(|error| error.context(format!("could not {}", what())))
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

    /// Reads the last committed WAL snapshot while the write connection may be committing.
    fn read<T>(
        &self,
        what: impl FnOnce() -> String,
        work: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> anyhow::Result<T> {
        let connection = self
            .reader
            .as_ref()
            .unwrap_or(&self.connection)
            .lock()
            .unwrap();
        work(&connection).map_err(|err| anyhow::anyhow!("could not {}: {err}", what()))
    }

    /// Releases both connections' unused statements and pager memory. Blocks.
    pub(crate) fn release_cache(&self) -> anyhow::Result<()> {
        let release = |connection: &Connection| {
            connection.flush_prepared_statement_cache();
            connection.release_memory()
        };
        self.with(|| "release unused database cache".to_owned(), release)?;
        if self.reader.is_some() {
            self.read(|| "release unused database read cache".to_owned(), release)?;
        }
        Ok(())
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

    /// Commits a new agent record and its initial members together. Blocks.
    #[cfg(test)]
    pub(crate) fn insert(&self, record: &AgentRecord) -> anyhow::Result<()> {
        self.insert_launch(record, None)
    }

    pub(crate) fn insert_launch(
        &self,
        record: &AgentRecord,
        launch: Option<&InitialLaunch<'_>>,
    ) -> anyhow::Result<()> {
        self.transaction(
            || format!("save the record of {}", record.agent_id),
            |connection| {
                insert_record(connection, record)?;
                if let Some(launch) = launch {
                    write_launch(connection, &record.agent_id, launch)?;
                }
                Ok(())
            },
        )
    }

    /// Commits a new agent record with its start's prompt, in one transaction: the prompt takes the
    /// next message number, and where it `owes_result`, the number after it is kept for its result.
    /// Returns the numbered prompt and its result's number. Blocks.
    #[cfg(test)]
    pub(crate) fn insert_with_prompt(
        &self,
        record: &AgentRecord,
        prompt: &Message,
        owes_result: bool,
        reserved: Option<&MessageRef>,
    ) -> anyhow::Result<(Message, Option<MessageRef>)> {
        self.insert_launch_with_prompt(record, prompt, owes_result, reserved, None)
    }

    pub(crate) fn insert_launch_with_prompt(
        &self,
        record: &AgentRecord,
        prompt: &Message,
        owes_result: bool,
        reserved: Option<&MessageRef>,
        launch: Option<&InitialLaunch<'_>>,
    ) -> anyhow::Result<(Message, Option<MessageRef>)> {
        let reserved = reserved
            .map(|reference| {
                messages::result_number(reference)
                    .map(|number| (reference.machine_id.as_str(), number))
            })
            .transpose()?;
        self.transaction(
            || format!("save the record of {} with its prompt", record.agent_id),
            |transaction| {
                insert_record(transaction, record)?;
                if let Some(launch) = launch {
                    write_launch(transaction, &record.agent_id, launch)?;
                }
                let prompt = messages::insert(transaction, prompt)?;
                let number = messages::number_of(&prompt);
                transaction.execute(
                    "UPDATE agents SET prompt = ?1 WHERE agent_id = ?2",
                    params![number as i64, record.agent_id],
                )?;
                let owed = owes_result
                    .then(|| messages::owe_result(transaction, number, reserved))
                    .transpose()?;
                if let Some(reference) = &owed {
                    transaction.execute(
                        "UPDATE agents SET result_message_id = ?1, result_message_machine_id = ?2 WHERE agent_id = ?3",
                        params![reference.message_id, reference.machine_id, record.agent_id],
                    )?;
                }
                Ok((prompt, owed))
            },
        )
    }

    /// Finds the original start record and receipt kept at or after `since`.
    pub(crate) fn find_start(
        &self,
        key: &StartKey,
        since: &str,
    ) -> anyhow::Result<Option<KeptStart>> {
        self.with(
            || "read a repeated start".to_string(),
            |connection| {
                let mut statement = connection.prepare(
                    "SELECT agent_id, prompt, result_message_id, result_message_machine_id FROM agents
                     WHERE request_id = ?1 AND creator IS ?2 AND start_machine_id = ?3
                     AND start_window_id IS ?4 AND created_at >= ?5 ORDER BY created_at LIMIT 1",
                )?;
                let mut rows = statement.query(params![key.request_id, key.agent_id, key.machine_id, key.window_id, since])?;
                let Some(row) = rows.next()? else { return Ok(None); };
                let prompt: Option<i64> = row.get(1)?;
                let result: Option<String> = row.get(2)?;
                let machine: Option<String> = row.get(3)?;
                let reference = result.zip(machine).map(|(message_id, machine_id)| MessageRef { machine_id, message_id });
                Ok(Some(KeptStart {
                    agent_id: row.get(0)?,
                    prompt: prompt.map(|number| number as u64),
                    result: reference,
                }))
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
                     exit_reason = ?4, run_auth_birth = NULL, run_credential_digest = NULL \
                     WHERE agent_id = ?5",
                    params![exit.code, exit.signal, exit.at, reason_name(exit), agent_id],
                )
            },
        )?;
        Ok(())
    }

    /// Commits a resumed run in one statement. A missing `started_at` means an uncommitted
    /// keeper run was recovered; an unmarked v2 row is still eligible for legacy adoption.
    pub(crate) fn record_restart(
        &self,
        agent_id: &str,
        pid: u32,
        yolo: bool,
        started_at: Option<&str>,
        relay: Option<&RelayRunRecord>,
        command: Option<&str>,
    ) -> anyhow::Result<()> {
        #[cfg(debug_assertions)]
        if failing_for_test("fail-restart-commit") {
            anyhow::bail!("the agent store is temporarily unavailable");
        }
        self.with(
            || format!("save the resumed run of {agent_id}"),
            |connection| {
                connection.execute(
                    "UPDATE agents SET pid = ?2, yolo = ?3, exit_code = NULL, \
                     exit_signal = NULL, exit_at = NULL, exit_reason = NULL, \
                     started_at = COALESCE(?4, started_at), \
                     run_auth_version = CASE WHEN ?4 IS NULL AND run_auth_version IS NULL \
                         THEN NULL ELSE 3 END, run_auth_birth = ?5, run_credential_digest = ?6, \
                     launch_command = ?7 \
                     WHERE agent_id = ?1",
                    params![
                        agent_id,
                        pid,
                        yolo,
                        started_at,
                        relay.map(|relay| &relay.process.birth),
                        relay
                            .and_then(|relay| relay.digest.as_ref())
                            .map(|digest| digest.as_slice()),
                        command,
                    ],
                )
            },
        )?;
        Ok(())
    }

    /// A migrated record can acquire legacy identification only from the keeper's held run.
    pub(crate) fn adopt_legacy_run(
        &self,
        agent_id: &str,
        process: &ProcessIdentity,
    ) -> anyhow::Result<()> {
        self.with(
            || format!("adopt the legacy run of {agent_id}"),
            |connection| {
                connection.execute(
                    "UPDATE agents SET run_auth_version = 2, run_auth_birth = ?3 \
                     WHERE agent_id = ?1 AND pid = ?2 AND exit_at IS NULL AND run_auth_version IS NULL",
                    params![agent_id, process.pid, process.birth],
                )
            },
        )?;
        Ok(())
    }

    /// The recorded active relay identity, where the current keeper run supplied one.
    pub(crate) fn relay_run(&self, agent_id: &str) -> anyhow::Result<Option<RelayRunRecord>> {
        use rusqlite::OptionalExtension;

        self.with(
            || format!("read the relay identity of {agent_id}"),
            |connection| {
                connection.query_row(
                    "SELECT pid, run_auth_birth, run_auth_version, run_credential_digest FROM agents \
                     WHERE agent_id = ?1 AND exit_at IS NULL AND run_auth_birth IS NOT NULL",
                    [agent_id],
                    |row| Ok(RelayRunRecord {
                        process: ProcessIdentity { pid: row.get(0)?, birth: row.get(1)? },
                        version: row.get(2)?,
                        digest: row.get::<_, Option<Vec<u8>>>(3)?.and_then(|digest| digest.try_into().ok()),
                    }),
                ).optional()
            },
        )
    }

    pub(crate) fn launch_details(&self, agent_id: &str) -> anyhow::Result<LaunchDetails> {
        use rusqlite::OptionalExtension;

        let details = self.read(
            || format!("read the launch details of {agent_id}"),
            |connection| connection.query_row(
                "SELECT started_at, creation_source, launch_options, creator, start_window_id, start_machine_id FROM agents WHERE agent_id = ?1",
                [agent_id],
                |row| {
                    let source: Option<String> = row.get(1)?;
                    let creator: Option<String> = row.get(3)?;
                    let start_window: Option<String> = row.get(4)?;
                    let start_machine: Option<String> = row.get(5)?;
                    let source = match source.as_deref() {
                        Some("agent") => Some(CreationSource::Agent),
                        Some("command_line") => Some(CreationSource::CommandLine),
                        Some("vs_code") => Some(CreationSource::VsCode),
                        None if creator.is_some() => Some(CreationSource::Agent),
                        None if start_window.is_some() => Some(CreationSource::VsCode),
                        None if start_machine.is_some() => Some(CreationSource::CommandLine),
                        _ => None,
                    };
                    Ok(LaunchDetails {
                        started_at: row.get(0)?,
                        source,
                        options: row.get::<_, Option<String>>(2)?.and_then(|data| serde_json::from_str(&data).ok()),
                    })
                },
            ).optional(),
        )?;
        Ok(details.unwrap_or_default())
    }

    pub(crate) fn launch_command(&self, agent_id: &str) -> anyhow::Result<Option<String>> {
        use rusqlite::OptionalExtension;

        self.with(
            || format!("read the launch command of {agent_id}"),
            |connection| {
                connection
                    .query_row(
                        "SELECT launch_command FROM agents WHERE agent_id = ?1",
                        [agent_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map(Option::flatten)
            },
        )
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
    pub(crate) fn delete(
        &self,
        agent_id: &str,
        receipt_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<Vec<Gone>> {
        self.delete_record(agent_id, None, receipt_cutoff)
    }

    /// Deletes a listed record and saves why it disappeared for stable Pin lookups.
    pub(crate) fn delete_listed(
        &self,
        agent_id: &str,
        cause: RemovalCause,
        receipt_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<Vec<Gone>> {
        self.delete_record(agent_id, Some(cause), receipt_cutoff)
    }

    fn delete_record(
        &self,
        agent_id: &str,
        cause: Option<RemovalCause>,
        receipt_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<Vec<Gone>> {
        self.transaction(
            || format!("delete the record of {agent_id}"),
            |transaction| {
                if let Some(cause) = cause {
                    transaction.execute(
                        "INSERT INTO agent_removals (agent_id, expired)
                         SELECT agent_id, ?2 FROM agents WHERE agent_id = ?1",
                        params![agent_id, cause == RemovalCause::Expired],
                    )?;
                }
                transaction.execute("DELETE FROM agents WHERE agent_id = ?1", [agent_id])?;
                transaction.execute("DELETE FROM agent_windows WHERE agent_id = ?1", [agent_id])?;
                messages::delete_inbox(transaction, agent_id, &receipt_cutoff())
            },
        )
    }

    pub(crate) fn removal_cause(&self, agent_id: &str) -> anyhow::Result<Option<RemovalCause>> {
        use rusqlite::OptionalExtension;

        self.with(
            || format!("read the removal cause of {agent_id}"),
            |connection| {
                connection
                    .query_row(
                        "SELECT expired FROM agent_removals WHERE agent_id = ?1",
                        [agent_id],
                        |row| {
                            Ok(if row.get(0)? {
                                RemovalCause::Expired
                            } else {
                                RemovalCause::Removed
                            })
                        },
                    )
                    .optional()
            },
        )
    }

    /// Deletes a guest's record and its inbox, in one transaction. The messages it sent stay in
    /// their recipients' inboxes. Returns the messages deleted. Blocks.
    pub(crate) fn delete_guest(
        &self,
        agent_id: &str,
        receipt_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<Vec<Gone>> {
        self.transaction(
            || format!("delete the record of guest {agent_id}"),
            |transaction| {
                transaction.execute("DELETE FROM guests WHERE agent_id = ?1", [agent_id])?;
                messages::delete_inbox(transaction, agent_id, &receipt_cutoff())
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

    #[cfg(test)]
    pub(crate) fn window_table(self: &Arc<Self>) -> WindowTable {
        WindowTable::new(self.clone())
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
        initialize(&mut connection, &[]).unwrap();
        migrate(&mut connection, settings::Settings::default).unwrap();
        Arc::new(Store {
            connection: Mutex::new(connection),
            path: None,
            reader: None,
            read_admission: tokio::sync::Mutex::new(()),
            commits: std::sync::atomic::AtomicUsize::new(0),
            abort_next_batch: std::sync::atomic::AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    pub(crate) fn abort_next_batch(&self) {
        self.abort_next_batch
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn commits(&self) -> usize {
        self.commits.load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    fn note_commit(&self) {
        self.commits
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
}

/// Whether a test asked the store to fail a write, by the file `name` in `framework/`.
#[cfg(debug_assertions)]
fn failing_for_test(name: &str) -> bool {
    facade_base::paths::framework_dir().is_ok_and(|framework| framework.join(name).exists())
}

/// Makes `framework/`, the database and its WAL and SHM files private: they name each agent's CLI and
/// folder. SQLite gives the files it creates the database file's permissions.
fn make_private(framework: &Path, database: &Path) -> std::io::Result<()> {
    files::make_private(framework)?;
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

/// Writes `record` as a new row of `agents`.
fn insert_record(connection: &Connection, record: &AgentRecord) -> rusqlite::Result<()> {
    let exit = record.exit.as_ref();
    let source = record.location_source_window.as_ref();
    connection.execute(
        "INSERT INTO agents (agent_id, name, cli, cwd, pid, created_at, exit_code, exit_signal, \
         exit_at, exit_reason, rule, session, creator, creator_machine_id, start_machine_id, start_window_id, root, root_machine_id, \
         yolo, request_id, prompt, location_id, location_machine_id, location_window_id, started_at, run_auth_version) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?6, 3)",
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
            record.creator,
            record.creator_machine_id,
            record.start_machine_id,
            record.start_window_id,
            record.root,
            record.root_machine_id,
            record.yolo,
            record.request_id,
            record.prompt.map(|number| number as i64),
            record.location_id,
            source.map(|window| &window.machine_id),
            source.map(|window| &window.window_id),
        ],
    )?;
    membership::insert(connection, &record.agent_id, &record.windows)
}

fn write_launch(
    connection: &Connection,
    id: &str,
    launch: &InitialLaunch<'_>,
) -> rusqlite::Result<()> {
    let auth = launch.relay;
    let options = serde_json::to_string(launch.options)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    connection.execute(
        "UPDATE agents SET creation_source = ?2, launch_options = ?3, run_auth_version = ?4,
         run_auth_birth = ?5, run_credential_digest = ?6, launch_command = ?7 WHERE agent_id = ?1",
        params![
            id,
            launch.source.as_str(),
            options,
            auth.version,
            auth.process.birth,
            auth.digest.as_ref().map(|digest| digest.as_slice()),
            launch.command,
        ],
    )?;
    Ok(())
}

/// Creates the schema and counters in one transaction. No number the keeper holds goes out again.
fn initialize(connection: &mut Connection, held: &[String]) -> rusqlite::Result<()> {
    let next = held
        .iter()
        .filter_map(|id| crate::agent_number(id).checked_add(1))
        .max()
        .unwrap_or(1);
    let transaction = connection.transaction()?;
    transaction.execute_batch(SCHEMA)?;
    integrations::add_table(&transaction)?;
    machines::add_tables(&transaction)?;
    messages::add_table(&transaction)?;
    windows::add_table(&transaction)?;
    guests::add_table(&transaction)?;
    membership::add_table(&transaction)?;
    transaction.execute("INSERT INTO numbers (next) VALUES (?1)", [next as i64])?;
    transaction.execute("INSERT INTO message_numbers (next) VALUES (1)", [])?;
    let hostname = facade_base::system::hostname().unwrap_or_default();
    let machine_name = facade_base::address::default_machine_name(&hostname);
    transaction.execute(
        "INSERT INTO machine (singleton, machine_id, name) VALUES (1, ?1, ?2)",
        params![machine_uuid(), machine_name],
    )?;
    transaction.commit()
}

/// Preserves the v2 machine sources for workspace import. Window descriptions and memberships
/// already live in their own tables and remain the source for the legacy lookup.
fn migrate(
    connection: &mut Connection,
    read_settings: impl FnOnce() -> settings::Settings,
) -> anyhow::Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    if version < 3 {
        machines::snapshot_legacy_machines(&transaction)?;
        machines::migrate_routes(&transaction)?;
        messages::migrate_send_routes(&transaction)?;
        if version == 0 {
            transaction.execute("ALTER TABLE guests ADD COLUMN yolo INTEGER", [])?;
        }
        if version < 2 {
            messages::migrate_withdrawals(&transaction)?;
        }
        transaction.execute_batch(
            "ALTER TABLE agents ADD COLUMN started_at TEXT;
             ALTER TABLE agents ADD COLUMN run_auth_version INTEGER;
             ALTER TABLE agents ADD COLUMN run_auth_birth TEXT;
             ALTER TABLE agents ADD COLUMN run_credential_digest BLOB;
             ALTER TABLE agents ADD COLUMN creation_source TEXT;
             ALTER TABLE agents ADD COLUMN launch_options TEXT;
             CREATE TABLE agent_removals (agent_id TEXT PRIMARY KEY, expired INTEGER NOT NULL);",
        )?;
        snapshot_launch_options(&transaction, read_settings)?;
    }
    if version < 4 {
        transaction.execute("ALTER TABLE agents ADD COLUMN launch_command TEXT", [])?;
    }
    if version < 5 {
        messages::migrate_command_line_replies(&transaction)?;
    }
    if version < 6 {
        messages::migrate_failure_notices(&transaction)?;
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

/// Old records take their configured choices once. Their original CLI arguments are unknown.
fn snapshot_launch_options(
    connection: &Connection,
    read_settings: impl FnOnce() -> settings::Settings,
) -> anyhow::Result<()> {
    let missing: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM agents WHERE launch_options IS NULL)",
        [],
        |row| row.get(0),
    )?;
    if !missing {
        return Ok(());
    }
    let mut set_options = connection.prepare(
        "UPDATE agents SET launch_options = ?2 WHERE cli = ?1 AND launch_options IS NULL",
    )?;
    for entry in entries::read(&read_settings()) {
        if entry.model.is_some() || entry.effort.is_some() {
            let options = LaunchOptions {
                args: Vec::new(),
                model: entry.model,
                effort: entry.effort,
            };
            set_options.execute(params![entry.name, serde_json::to_string(&options)?])?;
        }
    }
    connection.execute(
        "UPDATE agents SET launch_options = ?1 WHERE launch_options IS NULL",
        [serde_json::to_string(&LaunchOptions::default())?],
    )?;
    Ok(())
}

pub(super) fn machine_uuid() -> String {
    let first = facade_base::random_u64();
    let second = facade_base::random_u64();
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        first >> 32,
        (first >> 16) & 0xffff,
        (first & 0x0fff) | 0x4000,
        ((second >> 48) & 0x3fff) | 0x8000,
        second & 0xffff_ffff_ffff,
    )
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
        match read_record(connection, row) {
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

fn read_record(connection: &Connection, row: &Row) -> rusqlite::Result<AgentRecord> {
    // A value this build cannot read leaves the agent without it; the row keeps it.
    fn optional<T: rusqlite::types::FromSql>(row: &Row, column: &str) -> Option<T> {
        row.get::<_, Option<T>>(column).ok().flatten()
    }
    let agent_id: String = row.get("agent_id")?;
    let exit_at: Option<String> = row.get("exit_at")?;
    let (code, signal) = (row.get("exit_code")?, row.get("exit_signal")?);
    let reason: Option<String> = row.get("exit_reason")?;
    let source = optional(row, "location_machine_id").zip(optional(row, "location_window_id"));
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
        windows: membership::read(connection, &agent_id)?,
        location_source_window: source.map(|(machine_id, window_id)| WindowRef {
            machine_id,
            window_id,
        }),
        creator: optional(row, "creator"),
        creator_machine_id: optional(row, "creator_machine_id"),
        start_machine_id: row.get("start_machine_id")?,
        start_window_id: optional(row, "start_window_id"),
        root: row.get("root")?,
        root_machine_id: row.get("root_machine_id")?,
        yolo: row.get("yolo")?,
        request_id: optional(row, "request_id"),
        prompt: optional::<i64>(row, "prompt").map(|number| number as u64),
        location_id: row.get("location_id")?,
        agent_id,
    })
}

/// The table handles' methods on the store itself, so that the store's tests read as one.
#[cfg(test)]
impl Store {
    pub(crate) fn insert_message(
        self: &Arc<Self>,
        message: &Message,
        request: Option<RequestId>,
    ) -> anyhow::Result<Kept> {
        self.message_table()
            .insert_message(message, request, false, None)
    }
    pub(crate) fn test_machine_id(&self) -> String {
        self.connection
            .lock()
            .unwrap()
            .query_row("SELECT machine_id FROM machine", [], |row| row.get(0))
            .unwrap()
    }

    pub(crate) fn find_request(
        self: &Arc<Self>,
        from: &str,
        to: &str,
        request: RequestId,
    ) -> anyhow::Result<Option<KeptMessage>> {
        self.message_table()
            .find_request(&self.test_machine_id(), from, to, request)
    }
    pub(crate) fn settle_messages(
        self: &Arc<Self>,
        settled: &[(u64, &facade_base::model::message::Delivery)],
        results: &[(u64, Message)],
    ) -> anyhow::Result<Settlement> {
        self.message_table().settle_messages(settled, results)
    }
    pub(crate) fn record_reads(
        self: &Arc<Self>,
        read: &[(u64, &facade_base::model::message::Delivery)],
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
    pub(crate) fn delete_inbox(
        &self,
        owner: &str,
        receipt_cutoff: impl FnOnce() -> String,
    ) -> anyhow::Result<Vec<Gone>> {
        self.transaction(
            || "delete an inbox".to_string(),
            |transaction| messages::delete_inbox(transaction, owner, &receipt_cutoff()),
        )
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn framework(test: &str) -> crate::test_folder::TestFolder {
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
            windows: vec![WindowRef {
                machine_id: "test-machine".into(),
                window_id: "terminal".into(),
            }],
            location_source_window: None,
            creator: None,
            creator_machine_id: None,
            start_machine_id: "test-machine".into(),
            start_window_id: None,
            root: id.into(),
            root_machine_id: "test-machine".into(),
            yolo: true,
            request_id: None,
            prompt: None,
            location_id: facade_base::model::machine::location_id("/work"),
        }
    }

    #[test]
    fn records_numbers_and_exits_survive_a_reopen_and_a_number_is_never_handed_out_twice() {
        let framework = framework("reopen");
        let opened = Store::open(&framework, &[]).unwrap();
        assert!(opened.records.is_empty());
        let machine_id = opened.machine_id;
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
        let opened = Store::open(&framework, &[]).unwrap();
        assert_eq!(opened.machine_id, machine_id);
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
        opened.store.delete("a1", crate::an_hour_ago).unwrap();
        opened.store.record_exit("a1", &exit).unwrap();
        assert!(
            Store::open(&framework, &[]).unwrap().records.is_empty(),
            "an exit after removal must not bring the record back"
        );
    }

    #[test]
    fn an_old_development_store_is_rejected_without_updating_it() {
        let framework = framework("old-development");
        let database = framework.join("facade.db");
        let wal = framework.join("facade.db-wal");
        let connection = Connection::open(&database).unwrap();
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE numbers (next INTEGER NOT NULL);
                 INSERT INTO numbers VALUES (3);
                 PRAGMA wal_checkpoint(TRUNCATE);
                 UPDATE numbers SET next = 7;",
            )
            .unwrap();
        drop(connection);
        let original = std::fs::read(&database).unwrap();
        let original_wal = std::fs::read(&wal).unwrap();
        assert!(!original_wal.is_empty());
        let error = Store::open(&framework, &[])
            .err()
            .expect("accepted an old store");
        assert_eq!(
            error.to_string(),
            format!(
                "{} belongs to an older development build. Remove {} before restarting Facade.",
                database.display(),
                framework.display()
            )
        );
        assert!(
            std::fs::read(&database).unwrap() == original,
            "the database changed"
        );
        assert!(
            std::fs::read(&wal).unwrap() == original_wal,
            "the WAL changed"
        );
    }

    #[test]
    fn a_new_store_numbers_agents_above_the_keeper_s_and_records_none_of_them() {
        let framework = framework("adopt");
        // An interrupted initialization leaves a database file. Retry initialization rather than
        // treating the empty schema as initialized.
        Connection::open(framework.join("facade.db"))
            .unwrap()
            .execute_batch("PRAGMA journal_mode=WAL;")
            .unwrap();
        let opened = Store::open(&framework, &["a4".into(), "a9".into()]).unwrap();
        assert!(opened.records.is_empty());
        assert_eq!(opened.store.number_table().allocate_number().unwrap(), 10);
    }

    #[test]
    fn a_row_this_build_cannot_read_stays_as_it_is_and_still_names_its_agent() {
        let framework = framework("unreadable");
        let store = Store::open(&framework, &[]).unwrap().store;
        store.insert(&record("a1")).unwrap();
        store.insert(&record("a2")).unwrap();
        drop(store);
        let connection = Connection::open(framework.join("facade.db")).unwrap();
        connection
            .execute(
                "UPDATE agents SET pid = 'not a number' WHERE agent_id = 'a2'",
                [],
            )
            .unwrap();
        drop(connection);
        for _ in 0..2 {
            let opened = Store::open(&framework, &[]).unwrap();
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
        let connection = Connection::open(framework.join("facade.db")).unwrap();
        let kept: String = connection
            .query_row("SELECT pid FROM agents WHERE agent_id = 'a2'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, "not a number", "the row must not be rewritten");
    }

    #[test]
    fn an_exit_reason_this_build_does_not_know_keeps_the_agent_ended_and_the_stored_name() {
        let framework = framework("reason");
        let store = Store::open(&framework, &[]).unwrap().store;
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
        let connection = Connection::open(framework.join("facade.db")).unwrap();
        connection
            .execute(
                "UPDATE agents SET exit_at = 'later', exit_reason = 'eaten_by_a_grue' \
                 WHERE agent_id = 'a2'",
                [],
            )
            .unwrap();
        drop(connection);
        let opened = Store::open(&framework, &[]).unwrap();
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
        let connection = Connection::open(framework.join("facade.db")).unwrap();
        let kept: String = connection
            .query_row(
                "SELECT exit_reason FROM agents WHERE agent_id = 'a2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, "eaten_by_a_grue", "the stored name is not rewritten");
    }

    /// An agent's creator, the first agent of its tree and its run's YOLO survive a reopen as they
    /// were written.
    #[test]
    fn an_agent_s_creation_tree_and_yolo_survive_a_reopen() {
        let framework = framework("tree");
        let store = Store::open(&framework, &[]).unwrap().store;
        let child = AgentRecord {
            creator: Some("a1".into()),
            creator_machine_id: Some("creator-machine".into()),
            root: "a1".into(),
            root_machine_id: "root-machine".into(),
            yolo: false,
            ..record("a2")
        };
        store.insert(&record("a1")).unwrap();
        store.insert(&child).unwrap();
        drop(store);
        let mut records = Store::open(&framework, &[]).unwrap().records;
        records.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        assert_eq!(records, [record("a1"), child]);
    }

    #[test]
    fn a_resume_s_commit_sets_the_process_and_clears_the_exit_and_a_session_never_brings_a_record_back()
     {
        let framework = framework("restart");
        let mut connection = Connection::open(framework.join("facade.db")).unwrap();
        initialize(&mut connection, &[]).unwrap();
        let old = record("a1");
        connection
            .execute(
                "INSERT INTO agents (agent_id, name, cli, cwd, pid, created_at, rule, \
                 start_machine_id, root, root_machine_id, yolo, location_id, exit_code, exit_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, 't')",
                params![
                    old.agent_id,
                    old.name,
                    old.cli,
                    old.cwd,
                    old.pid,
                    old.created_at,
                    old.rule,
                    old.start_machine_id,
                    old.root,
                    old.root_machine_id,
                    old.yolo,
                    old.location_id,
                ],
            )
            .unwrap();
        membership::insert(&connection, &old.agent_id, &old.windows).unwrap();
        migrate(&mut connection, || {
            settings::parse(
                r#"{"clis":{"claude":{"model":"sonnet","effort":"high","args":["--verbose"]}}}"#,
                "facade.json",
            )
            .unwrap()
        })
        .unwrap();
        migrate(&mut connection, || {
            panic!("a migrated store must keep its saved options")
        })
        .unwrap();
        drop(connection);

        let store = Store::open(&framework, &[]).unwrap().store;
        store
            .record_session("a1", Some("86da4482-2bae-4a45-b193-a5664c19826a"))
            .unwrap();
        store
            .record_restart(
                "a1",
                77,
                false,
                Some("2026-11-09T17:26:00.123Z"),
                None,
                None,
            )
            .unwrap();
        drop(store);
        let opened = Store::open(&framework, &[]).unwrap();
        let session = Some("86da4482-2bae-4a45-b193-a5664c19826a".into());
        let resumed = AgentRecord {
            pid: 77,
            session,
            yolo: false,
            ..record("a1")
        };
        assert_eq!(opened.records, [resumed]);
        assert_eq!(
            opened.store.launch_details("a1").unwrap().options,
            Some(LaunchOptions {
                args: Vec::new(),
                model: Some("sonnet".into()),
                effort: Some("high".into()),
            })
        );
        opened.store.delete("a1", crate::an_hour_ago).unwrap();
        opened.store.record_session("a1", None).unwrap();
        opened
            .store
            .record_restart("a1", 78, true, Some("2026-11-09T17:27:00.123Z"), None, None)
            .unwrap();
        assert!(
            Store::open(&framework, &[]).unwrap().records.is_empty(),
            "a late write must not bring the record back"
        );
    }

    #[test]
    fn a_rule_or_session_this_build_cannot_read_leaves_the_agent_without_it_and_the_row_as_it_is() {
        let framework = framework("oddcolumns");
        let store = Store::open(&framework, &[]).unwrap().store;
        store.insert(&record("a1")).unwrap();
        store.insert(&record("a2")).unwrap();
        drop(store);
        let connection = Connection::open(framework.join("facade.db")).unwrap();
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
        let opened = Store::open(&framework, &[]).unwrap();
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
        let connection = Connection::open(framework.join("facade.db")).unwrap();
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
        let framework = framework("garbage");
        std::fs::write(framework.join("facade.db"), vec![b'x'; 4096]).unwrap();
        assert!(Store::open(&framework, &["a1".into()]).is_err());
    }

    /// Message numbers count on their own from 1 and continue after a reopen. A new name survives
    /// a reopen.
    #[test]
    fn message_numbers_and_new_names_survive_a_reopen() {
        let framework = framework("messages");
        let store = Store::open(&framework, &[]).unwrap().store;
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
        let opened = Store::open(&framework, &[]).unwrap();
        assert_eq!(numbered(&opened.store), "m3");
        assert_eq!(opened.records[0].name, "Renamed");
    }
}
