//! Manages agents and serves clients in one Facade home. A client starts the daemon; the daemon
//! starts the keeper for its first run. Each service keeps a copy of every terminal, so either can
//! replace the other after it ends. The daemon recovers readable agent records, exits, checkpoints
//! and screen logs before it accepts clients (`recovery.rs`), and exits after five idle seconds
//! (`lifecycle/`).
//!
//! Its parts each own their data and are joined here, never to each other:
//!
//! - `agent`: each agent's actor, terminal, screen, state, typist, viewers and readiness;
//! - `messages`: messages being delivered, and their numbers;
//! - `runs`: the keeper link, the runs it holds, and how a run is prepared;
//! - `records`: agent numbers, names and reach;
//! - `windows`: editor windows and their locations;
//! - `guests`: sessions people start that join, MCP members, and integrations;
//! - `lifecycle`: work under way, idle exit, takeover and the daemon log;
//! - `server`: client connections; `mcp`: Facade's MCP tools behind each relay.
//!
//! This level keeps the list of agents, the store and every write across its tables, and the
//! order in which the parts are called (`operations.rs`, `delivery.rs`, `presence.rs`,
//! `topics.rs`, `relays.rs`, `service.rs`, `recovery.rs`).

mod agent;
mod guests;
mod lifecycle;
mod mcp;
mod messages;
mod records;
mod runs;
mod server;
mod windows;

mod command_line;
mod delivery;
mod operations;
mod presence;
mod recovery;
mod relays;
mod service;
mod store;
#[cfg(test)]
mod testing;
mod topics;
mod waits;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use facade_base::daemon::{AgentsChange, WindowRef};
use facade_base::jsonrpc::ErrorBody;
use facade_base::programs::Held;
use facade_base::service::{self as base_service, Locked, StartupChannel};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use agent::{AgentCommand, AgentHandle, Screens};
use guests::Guests;
use lifecycle::{Lifecycle, LifecycleActivity};
use messages::Messages;
use operations::{StartAnswer, StartKey};
use records::Records;
use runs::{FoundKeeper, RunEvent, Runs};
use store::Store;
use windows::Windows;

#[cfg(test)]
pub(crate) use testing::test_folder;

/// The queued agent changes allowed before a client must get a complete list instead.
const MAX_QUEUED_AGENT_CHANGES: usize = 1024;
/// How often a running daemon deletes old messages, guests not heard from, and result files no one
/// can use.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// The person, as a message's sender or recipient names it.
pub(crate) const HUMAN: &str = "human";

/// A window and the daemon-local generation of its current instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowBinding {
    pub(crate) window: WindowRef,
    pub(crate) generation: u64,
}

/// Who said something to an agent: an agent, by ID and its name then, or the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Sender {
    /// An agent ID, or [`HUMAN`].
    pub(crate) from: String,
    pub(crate) from_name: Option<String>,
}

impl Sender {
    pub(crate) fn person() -> Sender {
        Sender {
            from: HUMAN.into(),
            from_name: None,
        }
    }
}

/// How a run's CLI was given Facade's tools.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolsGiven {
    /// Not given: the CLI has no rule, or its rule gives none.
    #[default]
    NotInjected,
    /// Given: the CLI starts Facade's MCP server.
    Injected,
    /// Its rule gives them, but Facade could not; the log says why.
    NotGiven,
}

/// A call's cancellation, which its client's `cancel` asks for. A closed connection asks for none.
#[derive(Clone, Default)]
pub(crate) struct Cancel(Option<watch::Receiver<bool>>);

impl Cancel {
    /// The cancellation `cancel` asks for once it turns true.
    pub(crate) fn of(cancel: watch::Receiver<bool>) -> Cancel {
        Cancel(Some(cancel))
    }

    /// Waits until the call is cancelled: never where it cannot be.
    pub(crate) async fn requested(&mut self) {
        if let Some(cancel) = self.0.as_mut()
            && cancel.wait_for(|cancelled| *cancelled).await.is_ok()
        {
            return;
        }
        std::future::pending().await
    }
}

fn log(level: &str, message: &str) {
    facade_base::log::write("daemon", level, message);
}

/// A test barrier: holds here while a test asks, in debug builds only. On a worker of the
/// multi-thread runtime its other tasks move to another thread first.
pub(crate) fn gate_for_test(point: &str) {
    #[cfg(debug_assertions)]
    if std::env::var("FACADE_TEST_GATES")
        .is_ok_and(|gates| gates.split(',').any(|gate| gate == point))
        && tokio::runtime::Handle::try_current().is_ok_and(|handle| {
            handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread
        })
    {
        tokio::task::block_in_place(|| base_service::gate_for_test(point));
        return;
    }
    base_service::gate_for_test(point);
}

/// A test pause, in debug builds only.
pub(crate) fn pause_for_test(point: &str) {
    base_service::pause_for_test(point);
}

/// Runs blocking work, such as a store write, on this thread; on a worker of the multi-thread
/// runtime, the worker's other tasks move to another thread first.
pub(crate) fn blocking_in_place<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

/// Runs blocking work on a blocking worker; a failure is an internal error.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, ErrorBody> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(ErrorBody::internal)?
        .map_err(ErrorBody::internal)
}

/// The daemon: its parts, the agent list and the store that joins them.
pub(crate) struct Daemon {
    /// Lock order: this lock first, then at most one lock of a part, through its methods; the
    /// parts' locks never nest, and the keeper link's and each actor's record are leaf locks.
    agents: Mutex<HashMap<String, AgentHandle>>,
    store: Arc<Store>,
    /// Changes for clients following the `agents` topic.
    changes: broadcast::Sender<AgentsChange>,
    lifecycle: Arc<Lifecycle>,
    /// The starts under way with a request ID: a second call with the same ID waits for the
    /// first one's answer.
    starting: Mutex<HashMap<StartKey, watch::Receiver<StartAnswer>>>,
    screens: Screens,
    messages: Arc<Messages>,
    runs: Runs,
    records: Records,
    windows: Windows,
    guests: Guests,
    /// `core/results/`, MCP results too long to return inline.
    results: PathBuf,
    /// What each open watch lets go of when it ends, by its viewer number.
    watch_ends: Mutex<HashMap<u64, topics::WatchEnd>>,
}

impl LifecycleActivity for Daemon {
    fn holds_agents(&self) -> bool {
        self.agents
            .lock()
            .unwrap()
            .values()
            .any(|agent| agent.is_guest() || agent.exit().borrow().is_none())
    }

    fn runs_busy(&self) -> Option<String> {
        self.runs.busy()
    }

    fn guest_listed(&self) -> bool {
        self.guests.any_guest()
    }

    fn screen_writes(&self) -> usize {
        agent::screen_writes()
    }

    fn running_count(&self) -> usize {
        self.agents()
            .iter()
            .filter(|agent| agent.exit().borrow().is_none())
            .count()
    }

    fn keeper_protocol(&self) -> Option<[u32; 2]> {
        self.runs.keeper_protocol()
    }

    fn keeper_build(&self) -> Option<String> {
        self.runs.keeper_info().map(|keeper| keeper.build)
    }

    async fn settle_pastes(&self) -> Vec<oneshot::Receiver<()>> {
        let mut pastes = Vec::new();
        for agent in self.agents() {
            let (reply, settled) = oneshot::channel();
            if agent.send(AgentCommand::SettlePaste { reply }).await {
                pastes.push(settled);
            }
        }
        pastes
    }

    async fn quiet_agents(&self, deadline: tokio::time::Instant) -> bool {
        let mut all_quiet = true;
        for agent in self.agents() {
            let (reply, quiet) = oneshot::channel();
            let quieted = agent.send(AgentCommand::Quiesce { reply }).await
                && matches!(tokio::time::timeout_at(deadline, quiet).await, Ok(Ok(())));
            all_quiet &= quieted || agent.exit().borrow().is_some();
        }
        all_quiet
    }
}

/// Runs the daemon: `facade daemon`. The keeper starts it in the background; it can also run in
/// the foreground.
pub fn run() -> anyhow::Result<()> {
    let mut channel = StartupChannel::take();
    base_service::close_inherited(channel.as_ref())
        .map_err(|err| failed(&mut channel, err.into()))?;
    facade_base::limits::raise_open_files();
    let workers = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(2, 16);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .thread_name("facade-worker")
        .enable_all()
        .build()
        .map_err(|err| failed(&mut channel, err.into()))?;
    runtime.block_on(async {
        let started = start_and_serve(&mut channel).await;
        started.map_err(|err| failed(&mut channel, err))
    })
}

/// Reports a failed start on the startup channel, which the starting command prints.
fn failed(channel: &mut Option<StartupChannel>, err: anyhow::Error) -> anyhow::Error {
    if let Some(channel) = channel.take() {
        channel.failed(&format!("{err:#}"));
    }
    err
}

async fn start_and_serve(channel: &mut Option<StartupChannel>) -> anyhow::Result<()> {
    let core = base_service::create_private_home()?;
    // The lock comes before the store, the keeper and the socket: a daemon that does not get it
    // changes nothing.
    match base_service::lock_home(&core, base_service::Service::Daemon)? {
        Locked::Held => {
            pause_for_test("after-daemon-lock");
            #[cfg(debug_assertions)]
            if core.join("die-after-lock").exists() {
                use std::io::Write;
                let mut launches = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(core.join("test-launches"))?;
                writeln!(launches, "{}", std::process::id())?;
                std::process::exit(1);
            }
        }
        Locked::Contended => {
            log("info", "another daemon holds the daemon lock; exiting");
            if let Some(channel) = channel.take() {
                channel.contention();
            }
            return Ok(());
        }
    }
    lifecycle::take_clean_end(&core);
    let program = facade_base::programs::install_running()?;
    let held = Arc::new(Held::open(&program, &facade_base::build_id())?);
    let (run_events, run_events_rx) = mpsc::unbounded_channel::<RunEvent>();
    let runs = Runs::new(&core, held.clone(), run_events);
    let held_agents = match runs.find_keeper_at_startup().await? {
        FoundKeeper::Connected { build, held } => {
            // The launchers every run names point at this build once the keeper is found; the
            // folder of the build it runs from stays.
            facade_base::programs::point_launchers_at(&facade_base::build_id(), &[build])?;
            held
        }
        FoundKeeper::Absent => {
            facade_base::programs::point_launchers_at(&facade_base::build_id(), &[])?;
            Vec::new()
        }
    };
    let progress = recovery::RecoveryProgress::start();
    let opened = {
        let core = core.clone();
        let ids: Vec<String> = held_agents.iter().map(|agent| agent.id.clone()).collect();
        tokio::task::spawn_blocking(move || Store::open(&core, &ids)).await??
    };
    progress.advance();
    let store = opened.store.clone();
    let records = Records::new(store.number_table(), store.membership_table());
    let readable: std::collections::HashSet<String> = opened
        .records
        .iter()
        .map(|record| record.agent_id.clone())
        .collect();
    records.keep_unreadable(opened.agent_ids.difference(&readable).cloned().collect());
    let messages = Arc::new(Messages::new(store.message_table()));
    let (window_events, window_events_rx) = mpsc::unbounded_channel();
    let (guest_events, guest_events_rx) = mpsc::unbounded_channel();
    let daemon = Arc::new(Daemon {
        agents: Mutex::default(),
        changes: broadcast::channel(MAX_QUEUED_AGENT_CHANGES).0,
        lifecycle: Lifecycle::new(),
        starting: Mutex::default(),
        screens: Screens::new(core.join("screens")),
        windows: Windows::new(store.window_table(), window_events),
        guests: Guests::new(
            store.guest_table(),
            store.integration_table(),
            held.clone(),
            guest_events,
        ),
        results: mcp::results_folder(&core),
        watch_ends: Mutex::default(),
        messages,
        runs,
        records,
        store,
    });
    daemon.sweep(SystemTime::now());
    gate_for_test("before-recovery");
    daemon
        .recover(held_agents, opened.records, &opened.agent_ids, &progress)
        .await?;
    daemon.restore_guests()?;
    daemon.take_up_messages()?;
    // Restore disconnected windows from the recovered agent records before accepting clients.
    daemon.restore_windows();
    // A plugin whose runs ended while no daemon ran goes now.
    let users = daemon
        .agents()
        .iter()
        .filter_map(|agent| Some((agent.rule()?.to_string(), PathBuf::from(agent.info().cwd))))
        .collect();
    daemon.runs.let_go_of_unused_plugins(users);
    // Integrations an earlier version wrote, as before a takeover, are written anew.
    tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.guests.bring_integrations_up_to_date().await }
    });
    daemon.runs.serve_keeper();
    if let Some(results) = daemon.messages.take_results() {
        tokio::spawn(delivery::deliver_results(daemon.clone(), results));
    }
    tokio::spawn(follow_runs(daemon.clone(), run_events_rx));
    tokio::spawn(presence::follow_windows(daemon.clone(), window_events_rx));
    tokio::spawn(presence::follow_guests(daemon.clone(), guest_events_rx));
    tokio::spawn(sweep_every_hour(daemon.clone()));
    tokio::spawn(waits::follow_waits(daemon.clone()));
    // Clients are accepted only after recovery, so that they see every readable agent.
    let listener = server::bind()?;
    if let Some(channel) = channel.take() {
        channel.started();
    }
    let (closing, closed) = watch::channel(false);
    let (paused, observed_paused) = watch::channel(false);
    tokio::spawn(
        daemon
            .lifecycle
            .clone()
            .exit_when_idle(daemon.clone(), closing, observed_paused),
    );
    server::serve(listener, daemon, closed, paused).await
}

/// Handles what runs report, as it comes: a run's first exit, and a session its CLI reported,
/// committed before the agent is told.
async fn follow_runs(daemon: Arc<Daemon>, mut events: mpsc::UnboundedReceiver<RunEvent>) {
    while let Some(event) = events.recv().await {
        match event {
            RunEvent::Exited { id, exit } => daemon.record_exit(&id, exit),
            RunEvent::Session {
                id,
                run,
                session,
                committed,
            } => {
                let daemon = daemon.clone();
                tokio::spawn(async move {
                    let saved = daemon.record_session(&id, run, session).await;
                    let _ = committed.send(saved);
                });
            }
        }
    }
}

impl Daemon {
    /// Commits the session run `run` of agent `id` reported, then tells the agent. False where
    /// the commit failed: the next read tries again.
    async fn record_session(&self, id: &str, run: u64, session: Option<String>) -> bool {
        let Some(agent) = self.get_agent(id).filter(|agent| agent.run() == run) else {
            return true;
        };
        gate_for_test("before-session-commit");
        let (store, saved, saving) = (self.store.clone(), id.to_string(), session.clone());
        if let Err(error) = blocking(move || store.record_session(&saved, saving.as_deref())).await
        {
            log(
                "warn",
                &format!("could not save the session of {id}: {}", error.message),
            );
            return false;
        }
        agent
            .send(agent::AgentCommand::RecordSession(session))
            .await;
        true
    }

    /// The hourly cleanup, in this order: guests not heard from for as long as messages are
    /// kept end, messages kept for 30 days go, then the result files no one can use.
    fn sweep(&self, now: SystemTime) {
        match self.messages.expire(now) {
            Ok(0) => {}
            Ok(deleted) => log(
                "info",
                &format!("deleted {deleted} messages kept for 30 days"),
            ),
            Err(err) => log("warn", &format!("{err:#}")),
        }
        mcp::clean_results(&self.results, now, &|number| self.messages.keeps(number));
        if let Err(err) = lifecycle::prune(now) {
            log(
                "warn",
                &format!("could not prune the daemon's log: {err:#}"),
            );
        }
    }
}

async fn sweep_every_hour(daemon: Arc<Daemon>) {
    let first = tokio::time::Instant::now() + SWEEP_INTERVAL;
    let mut hours = tokio::time::interval_at(first, SWEEP_INTERVAL);
    loop {
        hours.tick().await;
        let now = SystemTime::now();
        let kept_since = now
            .checked_sub(messages::KEPT_FOR)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        daemon.end_unheard_guests(&facade_base::time::iso_time(kept_since));
        let sweeping = daemon.clone();
        let _ = tokio::task::spawn_blocking(move || sweeping.sweep(now)).await;
    }
}
