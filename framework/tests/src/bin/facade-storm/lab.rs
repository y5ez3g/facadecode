//! One storm's Facade home: its agents, its daemon connection, and its messages as the store keeps
//! them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use facade_scenarios::serde_json::{Map, Value, json};
use facade_scenarios::*;

use crate::client::{self, Rpc};
use crate::person::{COLS, ROWS};
use crate::tape::Tape;

pub struct Lab {
    pub home: TestHome,
    pub wire: Rpc,
    pub tapes: PathBuf,
    /// Its agents have the person's own environment: their home, logins and programs.
    pub person: bool,
}

#[derive(Clone, Debug)]
pub struct Agent {
    pub id: String,
    pub address: String,
    /// Its full reference, as `agent.type` takes it.
    pub reference: Value,
    pub pid: i32,
}

/// One row of the store's messages.
#[derive(Clone, Debug)]
pub struct Row {
    pub number: u64,
    pub from: String,
    pub to: String,
    pub text: String,
    pub status: String,
    pub reason: Option<String>,
    pub text_written: String,
    pub enter_written: Option<bool>,
    pub delivered_via: Option<String>,
    /// When it was kept, in milliseconds since 1970.
    pub at_ms: u64,
    /// When it was delivered, in milliseconds since 1970.
    pub delivered_ms: Option<u64>,
    pub withdrawn: bool,
}

impl Lab {
    /// A home of fake CLIs, its daemon running.
    pub fn fake(name: &str) -> anyhow::Result<Lab> {
        let home = TestHome::new(&format!("storm-{name}"));
        home.start_facade_with(&[]);
        let wire = client::terminal(&home.daemon_socket())?;
        let tapes = home.folder().join("tapes");
        std::fs::create_dir_all(&tapes)?;
        Ok(Lab {
            home,
            wire,
            tapes,
            person: false,
        })
    }

    /// Starts a fake CLI with `env`, without waiting for it to draw.
    pub fn start_fake(&self, name: &str, env: &[(&str, &str)]) -> anyhow::Result<Agent> {
        self.start_as("fake", name, env)
    }

    /// Starts a fake CLI that stands in for `cli`, read by `cli`'s own rule.
    pub fn start_as(&self, cli: &str, name: &str, env: &[(&str, &str)]) -> anyhow::Result<Agent> {
        let mut env = env.to_vec();
        let path;
        if cli != "fake" {
            let programs = self.home.folder().join("programs");
            std::fs::create_dir_all(&programs)?;
            if !programs.join(program_name(cli)).exists() {
                install_program(&programs, cli, &test_binaries().fakecli);
            }
            path = format!(
                "{}{PATH_SEPARATOR}{}",
                programs.display(),
                self.home.path_with_test_programs()
            );
            env.push(("PATH", &path));
            env.push(("FAKECLI_LOOK", cli));
        }
        let env = env.as_slice();
        let mut env: BTreeMap<String, String> = match self.person {
            true => {
                // The programs under test, then the person's own.
                let mut given = crate::real::person_env();
                let path = given
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
                    .map(|(_, path)| path.clone())
                    .unwrap_or_default();
                given.retain(|name, _| !name.eq_ignore_ascii_case("PATH"));
                let programs = test_binaries()
                    .fakecli
                    .parent()
                    .expect("a folder")
                    .to_owned();
                given.insert(
                    "PATH".into(),
                    format!("{}{PATH_SEPARATOR}{path}", programs.display()),
                );
                given
            }
            false => self
                .home
                .command("x")
                .get_envs()
                .filter_map(|(name, value)| {
                    Some((name.to_str()?.to_string(), value?.to_str()?.to_string()))
                })
                .chain([("PATH".to_string(), self.home.path_with_test_programs())])
                .collect(),
        }
        .into_iter()
        .chain(
            env.iter()
                .map(|(name, value)| (name.to_string(), value.to_string())),
        )
        .collect();
        env.insert("FAKECLI_TAPE".into(), self.tapes.display().to_string());
        let started = self.wire.call(
            "agent.start",
            json!({
                "name": name, "cli": cli, "folder": self.home.project, "env": env,
                "size": { "cols": COLS, "rows": ROWS },
            }),
        )?;
        Self::agent(&started["agent"])
    }

    /// Starts a fake CLI with `facade start` in a window, as a person does. Returns it and the window.
    pub fn start_in_window(
        &self,
        name: &str,
        env: &[(&str, &str)],
    ) -> anyhow::Result<(Agent, TestTerminal)> {
        let mut command = self.home.command(&test_binaries().facade);
        command
            .args(["start", "--name", name, "fake"])
            .env("FAKECLI_TAPE", &self.tapes)
            .env("PATH", self.home.path_with_test_programs())
            .envs(env.iter().copied());
        let window = TestTerminal::spawn(&mut command, COLS, ROWS);
        anyhow::ensure!(
            window.wait_for(Duration::from_secs(30), |text| text.contains('❯')),
            "facade start drew no input: {}",
            window.text()
        );
        let listed = self.wire.call("agent.list", json!({}))?;
        let info = listed["agents"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|agent| agent["name"] == name)
            .with_context(|| format!("{name} is not listed: {listed}"))?;
        Ok((Self::agent(info)?, window))
    }

    pub fn agent(info: &Value) -> anyhow::Result<Agent> {
        let reference = info["reference"].clone();
        Ok(Agent {
            id: reference["agent_id"]
                .as_str()
                .with_context(|| format!("no agent in {info}"))?
                .to_string(),
            address: info["address"].as_str().unwrap_or_default().to_string(),
            reference,
            pid: info["pid"].as_i64().unwrap_or_default() as i32,
        })
    }

    pub fn inspect(&self, agent: &Agent) -> anyhow::Result<Value> {
        self.wire
            .call("agent.inspect", json!({ "target": agent.reference }))
    }

    /// The state of `agent`'s input, as the daemon reads it.
    pub fn input_state(&self, agent: &Agent) -> String {
        self.inspect(agent)
            .ok()
            .and_then(|info| info["input"]["state"].as_str().map(str::to_string))
            .unwrap_or_else(|| "unread".into())
    }

    /// Waits until every agent's input is empty and its tools are connected.
    pub fn wait_ready(&self, agents: &[Agent], timeout: Duration) -> anyhow::Result<()> {
        let mut waiting: Vec<&Agent> = agents.iter().collect();
        let ready = wait_until(timeout, || {
            waiting.retain(|agent| {
                let Ok(info) = self.inspect(agent) else {
                    return true;
                };
                info["input"]["state"] != "usable"
                    || info["agent"]["tools_state"]
                        .as_str()
                        .is_some_and(|state| state == "connecting")
            });
            waiting.is_empty()
        });
        anyhow::ensure!(
            ready,
            "{} of {} agents were not ready, such as {}: {}",
            waiting.len(),
            agents.len(),
            waiting[0].id,
            self.inspect(waiting[0])?
        );
        Ok(())
    }

    pub fn tape(&self, agent: &str) -> Tape {
        Tape::read(&self.tapes.join(format!("{agent}.tape")))
    }

    pub fn database(&self) -> PathBuf {
        self.home.path.join("framework/facade.db")
    }

    /// Every message the store keeps, by number.
    pub fn rows(&self) -> anyhow::Result<BTreeMap<u64, Row>> {
        read_rows(&self.database())
    }

    /// The numbers of the messages to `agents` still being delivered.
    pub fn pending(&self) -> anyhow::Result<usize> {
        let connection = open(&self.database())?;
        Ok(connection.query_row(
            "SELECT count(*) FROM messages WHERE status = 'pending'",
            [],
            |row| row.get::<_, i64>(0),
        )? as usize)
    }

    /// Copies what a finding needs to `folder`: the store, the logs, the screens and the tapes.
    pub fn keep_evidence(&self, folder: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(folder)?;
        let connection = open(&self.database())?;
        let copy = folder.join("facade.db");
        let _ = std::fs::remove_file(&copy);
        connection.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])?;
        copy_tree(&self.tapes, &folder.join("tapes"))?;
        copy_tree(&self.home.path.join("framework/logs"), &folder.join("logs"))?;
        copy_tree(
            &self.home.path.join("framework/screens"),
            &folder.join("screens"),
        )?;
        Ok(())
    }
}

fn open(database: &Path) -> anyhow::Result<rusqlite::Connection> {
    let connection = rusqlite::Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("opening {}", database.display()))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(connection)
}

pub fn read_rows(database: &Path) -> anyhow::Result<BTreeMap<u64, Row>> {
    let connection = open(database)?;
    let mut statement = connection.prepare(
        "SELECT number, \"from\", \"to\", text, status, reason, text_written, enter_written, \
         delivered_via, withdrawn, \
         CAST(round((julianday(delivered_at) - 2440587.5) * 86400000) AS INTEGER), \
         CAST(round((julianday(at) - 2440587.5) * 86400000) AS INTEGER) \
         FROM messages ORDER BY number",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(Row {
            number: row.get::<_, i64>(0)? as u64,
            from: row.get(1)?,
            to: row.get(2)?,
            text: row.get(3)?,
            status: row.get(4)?,
            reason: row.get(5)?,
            text_written: row.get(6)?,
            enter_written: row.get::<_, Option<i64>>(7)?.map(|written| written != 0),
            delivered_via: row.get(8)?,
            withdrawn: row.get::<_, i64>(9)? != 0,
            delivered_ms: row.get::<_, Option<i64>>(10)?.map(|ms| ms as u64),
            at_ms: row.get::<_, Option<i64>>(11)?.unwrap_or_default() as u64,
        })
    })?;
    let mut out = BTreeMap::new();
    for row in rows {
        let row = row?;
        out.insert(row.number, row);
    }
    Ok(out)
}

fn copy_tree(from: &Path, to: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(to)?;
    let Ok(entries) = std::fs::read_dir(from) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            // A file the daemon holds may refuse a copy for a moment.
            for _ in 0..20 {
                if std::fs::copy(entry.path(), &target).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Ok(())
}

/// The variables of `map` as strings.
#[allow(dead_code)]
pub fn strings(map: &Map<String, Value>) -> BTreeMap<String, String> {
    map.iter()
        .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string())))
        .collect()
}
