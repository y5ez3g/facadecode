//! Manages agents and serves clients in one Facade home. A client starts the daemon; the daemon
//! starts the keeper for its first run. Each service keeps a copy of every terminal, so either can
//! replace the other after it ends. The daemon recovers readable agent records, exits, checkpoints
//! and screen logs before it accepts clients (`recovery.rs`), and exits after 30 idle seconds
//! (`lifecycle/`).
//!
//! Its parts each own their data and are joined here, never to each other:
//!
//! - `agent`: each agent's actor, terminal, screen, state, typist, viewers and readiness;
//! - `messages`: messages being delivered, and their numbers;
//! - `runs`: the keeper link, the runs it holds, and how a run is prepared;
//! - `records`: agent numbers, names and reach;
//! - `windows`: working locations;
//! - `guests`: sessions people start that join, MCP members, and integrations;
//! - `lifecycle`: work under way, idle exit, takeover and the daemon log;
//! - `network`: SSH sessions, machine routes and forwarding;
//! - `server`: client connections; `mcp`: Facade's MCP tools behind each relay.
//!
//! This level keeps the list of agents, the store and every write across its tables, and the
//! order in which the parts are called (`operations.rs`, `delivery.rs`, `presence.rs`,
//! `topics.rs`, `relays.rs`, `service.rs`, `recovery.rs`).

#![expect(
    clippy::result_large_err,
    reason = "The API v1 boundaries use the shared structured wire error by value."
)]

mod agent;
mod guests;
mod lifecycle;
mod mcp;
mod messages;
mod network;
mod records;
mod runs;
mod server;
mod windows;

mod api;
mod command_line;
mod command_replies;
mod delivery;
mod machine_service;
mod network_operations;
mod operations;
mod presence;
mod recovery;
mod relays;
mod remote_agents;
mod resume;
mod service;
mod store;
#[cfg(test)]
mod testing;
mod topics;
mod waits;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use facade_base::api_v1::{ApiVersion, daemon as wire};
use facade_base::model::agent::AgentsUpdate;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::machine::new_boot_id;
use facade_base::process::ProcessState;
use facade_base::programs::Held;
use facade_base::service::{self as base_service, Locked, StartupChannel};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use agent::{AgentCommand, AgentHandle, Screens};
use guests::Guests;
use lifecycle::{Lifecycle, LifecycleActivity, Work};
use messages::Messages;
use network::Network;
use operations::{SessionKey, StartAnswer};
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

/// How long a request ID answers again.
const REQUEST_HOUR: Duration = Duration::from_secs(60 * 60);

/// The longest a message may take from its call reaching the daemon to its delivery.
const DELIVERY_TIME: Duration = Duration::from_millis(29_500);
const MAX_TERMINAL_SEND: Duration = Duration::from_secs(300);
const PASTE_SEPARATOR: &str = "\n\n";

/// The time an hour before now, as request IDs look back to.
fn an_hour_ago() -> String {
    facade_base::time::iso_time(
        SystemTime::now()
            .checked_sub(REQUEST_HOUR)
            .unwrap_or(SystemTime::UNIX_EPOCH),
    )
}

/// The origin sets a route before the receiver dates its receipt. Keep the route for the
/// one-hour receipt window plus the maximum time a send can spend getting there.
fn send_route_cutoff() -> String {
    let age = REQUEST_HOUR.saturating_add(delivery_ceiling());
    facade_base::time::iso_time(
        SystemTime::now()
            .checked_sub(age)
            .unwrap_or(SystemTime::UNIX_EPOCH),
    )
}

/// The largest persisted delivery window this daemon can admit.
pub(crate) fn delivery_ceiling() -> Duration {
    delivery_limit().max(MAX_TERMINAL_SEND)
}

/// The longest a message may take from its call reaching the daemon to its delivery. A debug build
/// reads a longer one from `FACADE_TEST_DELIVERY_MS`, once.
fn delivery_limit() -> Duration {
    static LIMIT: OnceLock<Duration> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        #[cfg(debug_assertions)]
        if let Some(ms) = std::env::var("FACADE_TEST_DELIVERY_MS")
            .ok()
            .and_then(|ms| ms.parse::<u64>().ok())
        {
            return Duration::from_millis(ms);
        }
        DELIVERY_TIME
    })
}

/// The number of agent ID `id`, such as 3 for `a3`, to sort by; the largest for anything else.
fn agent_number(id: &str) -> u64 {
    let digits = id.strip_prefix('a').unwrap_or("");
    digits.parse().unwrap_or(u64::MAX)
}

/// The person, as a message's sender or recipient names it.
pub(crate) const HUMAN: &str = "human";

/// A request is scoped to its caller and the machine holding the start.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct StartKey {
    pub(crate) machine_id: String,
    pub(crate) agent_id: Option<String>,
    pub(crate) window_id: Option<String>,
    pub(crate) request_id: String,
}

/// The SSH destination and optional Facade home saved for a machine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SavedConnection {
    pub(crate) machine_id: String,
    pub(crate) ssh_destination: String,
    pub(crate) remote_home: Option<String>,
}

/// A saved SSH connection and its normalized login arguments.
pub(crate) struct SavedSsh {
    pub(crate) config: SavedConnection,
    pub(crate) argv: Vec<String>,
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

pub(crate) fn effect_deadline_passed() -> ErrorBody {
    ErrorBody::new(
        Reason::OperationTimeout,
        "the call's deadline passed before it could take effect",
    )
}

/// Time left to begin the effect itself. Request-key receipt lookups may outlive this budget.
pub(crate) fn effect_time_left(deadline: Option<Instant>) -> Result<Option<Duration>, ErrorBody> {
    deadline
        .map(|deadline| {
            deadline
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
                .ok_or_else(effect_deadline_passed)
        })
        .transpose()
}

/// A call's cancellation, which its client's `cancel` asks for. A closed connection asks for none.
#[derive(Clone, Default)]
pub(crate) struct Cancel(Option<watch::Receiver<bool>>);

impl Cancel {
    /// The cancellation `cancel` asks for once it turns true.
    pub(crate) fn of(cancel: watch::Receiver<bool>) -> Cancel {
        Cancel(Some(cancel))
    }

    pub(crate) fn is_requested(&self) -> bool {
        self.0.as_ref().is_some_and(|cancel| *cancel.borrow())
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
    machine_id: String,
    network: Network,
    machine_changes: tokio::sync::Mutex<()>,
    machine_views: broadcast::Sender<()>,
    remote_agents: Mutex<remote_agents::RemoteAgents>,
    remote_changes: broadcast::Sender<facade_base::api_v1::daemon::AgentsChange>,
    /// Changes for clients following the `agents` topic.
    changes: broadcast::Sender<AgentsUpdate>,
    lifecycle: Arc<Lifecycle>,
    /// The starts under way with a request ID: a second call with the same ID waits for the
    /// first one's answer.
    starting: Mutex<HashMap<StartKey, watch::Receiver<StartAnswer>>>,
    claimed_sessions: Mutex<HashMap<SessionKey, String>>,
    screens: Screens,
    messages: Arc<Messages>,
    relay_send_store: tokio::sync::Mutex<()>,
    command_replies: command_replies::CommandReplies,
    runs: Runs,
    records: Records,
    windows: Windows,
    guests: Guests,
    /// `framework/results/`, MCP results too long to return inline.
    results: PathBuf,
    /// What each open watch lets go of when it ends, by its viewer number.
    watch_ends: Mutex<HashMap<u64, topics::ViewerBinding>>,
}

impl LifecycleActivity for Daemon {
    async fn announce_machine_sleeping(&self) {
        self.network.announce_sleeping().await;
    }

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

    fn running_managed_agents(&self) -> Vec<wire::AgentLabel> {
        self.agents()
            .into_iter()
            .filter_map(|agent| {
                let info = agent.info();
                if info.guest || info.process != ProcessState::Running {
                    return None;
                }
                let reference = info.reference();
                let address = self.agent_address(&reference).unwrap_or_else(|_| {
                    facade_base::address::selector::format_agent_address(
                        &reference.agent_id,
                        &reference.machine_id,
                    )
                });
                let label = service::agent_label_of(info, address, agent.rule().is_some());
                Some(wire::AgentLabel {
                    reference: api::wire_ref(&label.reference),
                    address: label.address,
                    kind: wire::AgentKind::Managed,
                    name: label.name,
                    cli: label.cli,
                    state: label.state,
                    resumable: label.resumable,
                })
            })
            .collect()
    }

    fn running_count(&self) -> usize {
        self.active_count()
    }

    fn keeper_api_version(&self) -> Option<ApiVersion> {
        self.runs.keeper_api_version()
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

/// Reads the committed name of the local machine while its daemon is sleeping.
pub fn offline_machine_name() -> Option<String> {
    Store::offline_machine_name(&facade_base::paths::framework_dir().ok()?)
}

/// Runs the daemon: `facade daemon`. The keeper starts it in the background; it can also run in
/// the foreground.
pub fn run() -> anyhow::Result<()> {
    let mut channel = StartupChannel::take();
    base_service::close_inherited(channel.as_ref())
        .map_err(|err| failed(&mut channel, err.into()))?;
    facade_base::limits::raise_open_files();
    let workers = if cfg!(windows) {
        2
    } else {
        std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .clamp(2, 16)
    };
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder
        .worker_threads(workers)
        .thread_name("facade-worker")
        .enable_all();
    #[cfg(windows)]
    builder
        .max_blocking_threads(10)
        .thread_keep_alive(Duration::from_millis(150));
    let runtime = builder
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
    let framework = base_service::create_private_home()?;
    // The lock comes before the store, the keeper and the socket: a daemon that does not get it
    // changes nothing.
    match base_service::lock_home(&framework, base_service::Service::Daemon)? {
        Locked::Held => {
            pause_for_test("after-daemon-lock");
            gate_for_test("after-daemon-lock");
            #[cfg(debug_assertions)]
            if framework.join("die-after-lock").exists() {
                use std::io::Write;
                let mut launches = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(framework.join("test-launches"))?;
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
    lifecycle::take_clean_end(&framework);
    let program = facade_base::programs::install_running()?;
    let held = Arc::new(Held::open(&program, &facade_base::build_id())?);
    let (run_events, run_events_rx) = mpsc::unbounded_channel::<RunEvent>();
    let runs = Runs::new(&framework, held.clone(), run_events);
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
        let framework = framework.clone();
        let ids: Vec<String> = held_agents
            .iter()
            .map(|agent| agent.agent_id.clone())
            .collect();
        tokio::task::spawn_blocking(move || Store::open(&framework, &ids)).await??
    };
    progress.advance();
    let store = opened.store.clone();
    let records = Records::new(store.number_table());
    let readable: std::collections::HashSet<String> = opened
        .records
        .iter()
        .map(|record| record.agent_id.clone())
        .collect();
    records.keep_unreadable(opened.agent_ids.difference(&readable).cloned().collect());
    let messages = Arc::new(Messages::new(
        store.message_table(),
        opened.machine_id.clone(),
    ));
    let (network_events, network_events_rx) = mpsc::unbounded_channel();
    let home = framework
        .parent()
        .expect("framework is inside the Facade home");
    let control_dir = facade_base::ssh::ssh_control_dir(home)?;
    let network = Network::new(
        wire::ConnectedMachine {
            machine_id: opened.machine_id.clone(),
            boot_id: new_boot_id(),
            name: opened.machine_name,
            build: facade_base::build_id(),
            ssh_cleans_processes: facade_base::system::ssh_cleans_processes(Duration::from_secs(1))
                .await,
        },
        control_dir,
        network_events,
    );
    let daemon = Arc::new(Daemon {
        agents: Mutex::default(),
        changes: broadcast::channel(MAX_QUEUED_AGENT_CHANGES).0,
        lifecycle: Lifecycle::new(),
        starting: Mutex::default(),
        claimed_sessions: Mutex::default(),
        screens: Screens::new(framework.join("screens")),
        windows: Windows::default(),
        guests: Guests::new(store.guest_table()),
        results: mcp::results_folder(&framework),
        watch_ends: Mutex::default(),
        messages,
        relay_send_store: tokio::sync::Mutex::default(),
        command_replies: command_replies::CommandReplies::default(),
        runs,
        records,
        machine_id: opened.machine_id,
        network,
        machine_changes: tokio::sync::Mutex::new(()),
        machine_views: broadcast::channel(MAX_QUEUED_AGENT_CHANGES).0,
        remote_agents: Mutex::default(),
        remote_changes: broadcast::channel(MAX_QUEUED_AGENT_CHANGES).0,
        store,
    });
    daemon.sweep(SystemTime::now());
    gate_for_test("before-recovery");
    let recovered_prompts = opened
        .records
        .iter()
        .filter_map(|record| record.prompt)
        .collect::<HashSet<_>>();
    daemon
        .recover(held_agents, opened.records, &opened.agent_ids, &progress)
        .await?;
    daemon.expire_agents(&kept_since(SystemTime::now())).await;
    daemon.restore_guests()?;
    daemon.take_up_messages(&recovered_prompts).await?;
    // A plugin whose runs ended while no daemon ran goes now.
    let users = daemon
        .agents()
        .iter()
        .filter_map(|agent| Some((agent.rule()?.to_string(), PathBuf::from(agent.info().cwd))))
        .collect();
    daemon.runs.let_go_of_unused_plugins(users);
    daemon.runs.serve_keeper();
    if let Some(results) = daemon.messages.take_results() {
        tokio::spawn(delivery::deliver_results(daemon.clone(), results));
    }
    tokio::spawn(follow_runs(daemon.clone(), run_events_rx));
    tokio::spawn(sweep_every_hour(daemon.clone()));
    // Clients are accepted only after recovery, so that they see every readable agent.
    let listener = server::bind()?;
    let lifecycle = daemon.lifecycle.clone();
    daemon.network.set_session_work(move |work| {
        let work = match work {
            network::SessionWork::Call => Work::Call,
            network::SessionWork::Viewer | network::SessionWork::Foreground => Work::MachineSession,
        };
        lifecycle
            .begin(work)
            .map(|guard| Box::new(guard) as network::SessionHold)
    });
    let weak_daemon = Arc::downgrade(&daemon);
    daemon.network.set_target(move |request| {
        let Some(daemon) = weak_daemon.upgrade() else {
            return false;
        };
        tokio::spawn(async move { daemon.serve_target(request).await });
        true
    });
    daemon.restore_machine_connections()?;
    tokio::spawn(machine_service::follow_network(
        daemon.clone(),
        network_events_rx,
    ));
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
            RunEvent::StopAccepted(stop) => daemon.runs.confirm_stop(stop),
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
        let before = kept_since(now);
        daemon.end_unheard_guests(&before);
        daemon.expire_agents(&before).await;
        let sweeping = daemon.clone();
        let _ = tokio::task::spawn_blocking(move || sweeping.sweep(now)).await;
    }
}

fn kept_since(now: SystemTime) -> String {
    facade_base::time::iso_time(
        now.checked_sub(messages::KEPT_FOR)
            .unwrap_or(SystemTime::UNIX_EPOCH),
    )
}
