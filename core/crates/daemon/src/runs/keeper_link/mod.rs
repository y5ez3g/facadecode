//! Owns keeper connectivity and terminal ownership. Registry locks precede pending-start locks;
//! the keeper connection lock is a leaf. No socket request or exit sink runs with those locks held.

mod client;
mod registry;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant as ClockInstant};

use anyhow::Context;
use facade_base::api_v1::ApiVersion;
use facade_base::api_v1::keeper::{StartArgs, StopArgs, SyncArgs};
use facade_base::daemon::KeeperInfo;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::KeeperHeldAgent;
use facade_base::process::{ProcessExit, ProcessIdentity};
use facade_base::service::{self, Report, RestartBackoff, Service};
use facade_base::terminal::PtyMaster;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use super::{
    ExitRecorded, ExitSink, FoundKeeper, RunCredentialRecord, RunEvent, RunExit, RunIdentity,
    RunKind, StartedRun,
};
use client::{ConnectError, KeeperClient};
use registry::{Run, RunRegistry, RunRole};

const READY_WAIT: Duration = Duration::from_secs(10);

/// Result of recording an exit; repeated exits never reach an exit sink a second time.
pub(crate) enum RecordedExit {
    /// Neither a registered run nor a pending start owns this ID.
    Unknown,
    /// The first exit was already retained and delivered.
    Repeated,
    /// Retained for the daemon to save after installation.
    Kept(ExitRecorded),
    /// An ended cleanup run was released with this exit.
    Dropped,
}

/// Recovery's decision about a run missing from the readable records.
pub(crate) enum KeeperOnly {
    /// Hold the terminal without changing the unreadable record.
    Unreadable,
    /// Stop the run because no record owns it.
    NoRecord,
}

#[derive(Clone)]
enum Phase {
    Absent,
    Connecting,
    Ready(Arc<KeeperClient>),
}

struct Connection {
    phase: Phase,
    first: Option<Arc<KeeperClient>>,
    identity: Option<ProcessIdentity>,
    build: Option<String>,
    api_version: Option<ApiVersion>,
    requested: bool,
    reservations: usize,
    sent: usize,
    handing_over: bool,
    backoff: RestartBackoff,
    ready_at: Option<ClockInstant>,
}

/// Keeper link and all terminals retained for reconnection. Created once per daemon.
pub(crate) struct KeeperLink {
    core: PathBuf,
    events: mpsc::UnboundedSender<RunEvent>,
    connection: Mutex<Connection>,
    changes: watch::Sender<u64>,
    runs: RunRegistry,
    owner: Weak<KeeperLink>,
}

/// Counts a start until registration or failure, including time spent preparing it.
pub(crate) struct StartReservation {
    link: Arc<KeeperLink>,
    keeper: Mutex<Option<Arc<KeeperClient>>>,
    sent: bool,
}

impl StartReservation {
    /// Waits for readiness, asking the link to start a keeper if absent. Holds no lock while waiting.
    pub(crate) async fn wait_for_keeper(&self) -> Result<(), ErrorBody> {
        let keeper = self.link.wait_ready(true).await.ok_or_else(|| {
            ErrorBody::new(
                Reason::Unavailable,
                "the keeper did not become ready within 10 seconds; the agent was not started",
            )
        })?;
        *self.keeper.lock().unwrap() = Some(keeper);
        Ok(())
    }
}

impl Drop for StartReservation {
    fn drop(&mut self) {
        {
            let mut state = self.link.connection.lock().unwrap();
            state.reservations -= 1;
            if self.sent {
                state.sent -= 1;
            }
        }
        self.link.wake();
    }
}

impl KeeperLink {
    /// Creates terminal ownership and the connection's leaf lock; starts no task yet.
    pub(crate) fn new(core: PathBuf, events: mpsc::UnboundedSender<RunEvent>) -> Arc<KeeperLink> {
        Arc::new_cyclic(|owner| Self {
            core,
            events,
            owner: owner.clone(),
            runs: RunRegistry::default(),
            changes: watch::channel(0).0,
            connection: Mutex::new(Connection {
                phase: Phase::Absent,
                first: None,
                identity: None,
                build: None,
                api_version: None,
                requested: false,
                reservations: 0,
                sent: 0,
                handing_over: false,
                backoff: RestartBackoff::default(),
                ready_at: None,
            }),
        })
    }

    /// Reserves a start synchronously under the connection lock.
    pub(crate) fn reserve_start(self: &Arc<Self>) -> StartReservation {
        self.connection.lock().unwrap().reservations += 1;
        StartReservation {
            link: Arc::clone(self),
            keeper: Mutex::new(None),
            sent: false,
        }
    }

    /// Sends a reserved start and keeps a terminal copy before returning. Waits without locks.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn send_start(
        &self,
        mut reservation: StartReservation,
        id: &str,
        number: u64,
        args: StartArgs,
        exits: ExitSink,
        kind: RunKind,
        credential_digest: Option<[u8; 32]>,
    ) -> Result<StartedRun, ErrorBody> {
        let selected = reservation.keeper.lock().unwrap().clone();
        let keeper = match selected {
            Some(keeper) => keeper,
            None => {
                reservation.wait_for_keeper().await?;
                reservation
                    .keeper
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("keeper was selected")
            }
        };
        self.runs
            .begin(id, number, Arc::clone(&exits), credential_digest);
        reservation.sent = true;
        self.connection.lock().unwrap().sent += 1;
        let response = keeper.start(&args).await;
        let started = match response {
            Err(error) => {
                if error.uncertain() {
                    keeper.fence();
                }
                Err(error.into())
            }
            Ok((process, master)) => match master.try_clone() {
                Err(error) => {
                    keeper.fence();
                    Err(ErrorBody::new(
                        Reason::Unavailable,
                        format!("could not keep {id}'s terminal: {error}"),
                    ))
                }
                Ok(copy) => {
                    if kind == RunKind::Start {
                        crate::gate_for_test("after-run-start-response");
                    }
                    let identity = ProcessIdentity {
                        pid: process.pid,
                        birth: process.birth,
                    };
                    let credential = credential_digest.map(|digest| RunCredentialRecord {
                        digest,
                        process: identity.clone(),
                    });
                    self.runs.register(
                        id,
                        Run {
                            identity: identity.clone(),
                            master: copy,
                            exit: None,
                            stopping: false,
                            role: RunRole::Agent,
                            committed: kind == RunKind::Start,
                            installed: false,
                            number,
                            exits: Some(exits),
                            credential_digest,
                        },
                    );
                    Ok(StartedRun {
                        pid: identity.pid,
                        process: identity,
                        master,
                        credential,
                    })
                }
            },
        };
        if started.is_err() {
            self.runs.cancel(id);
        }
        drop(reservation);
        if started.is_ok() && kind == RunKind::Start {
            crate::pause_for_test("after-run-start");
        }
        started
    }

    /// Marks a registered run stopping and lets go of its copy of the terminal before the stop,
    /// then waits for a ready keeper and its response.
    pub(crate) async fn stop(&self, id: &str) -> Result<bool, ErrorBody> {
        let running = self.runs.request_stop(id)?;
        if running {
            let keeper = self.wait_ready(false).await.ok_or_else(|| {
                ErrorBody::new(
                    Reason::Unavailable,
                    format!(
                        "the keeper did not become ready within 10 seconds; #{id} was not \
                         stopped yet"
                    ),
                )
            })?;
            Self::stop_with(&keeper, id).await?;
        }
        Ok(running)
    }

    /// Records the first exit and invokes its sink after releasing registry and pending locks.
    pub(crate) fn record_exit(&self, id: &str, exit: ProcessExit) -> RecordedExit {
        self.runs.exit(id, exit)
    }

    /// Marks a run committed and returns its early exit. Takes registry then pending locks.
    pub(crate) fn installed(&self, id: &str, number: Option<u64>) -> Option<ProcessExit> {
        self.runs.installed(id, number)
    }

    /// Waits up to the keeper readiness interval for the credential's run to be installed.
    pub(crate) async fn verify_credential(
        &self,
        credential: &str,
    ) -> Result<Option<RunIdentity>, ErrorBody> {
        self.runs.verify_credential(credential, READY_WAIT).await
    }

    /// Releases an ended run synchronously; a running run remains held.
    pub(crate) fn release(&self, id: &str) -> bool {
        self.runs.release(id)
    }

    /// Converts a failed start into cleanup, lets go of its copy of the terminal before the stop,
    /// and asks a ready keeper to stop it in a task.
    pub(crate) fn abandon(&self, id: &str) {
        if self.runs.abandon(id) {
            let link = self.owner.upgrade().expect("link is still owned");
            let id = id.to_owned();
            tokio::spawn(async move {
                if let Some(keeper) = link.wait_ready(false).await
                    && let Err(error) = Self::stop_with(&keeper, &id).await
                {
                    facade_base::log::write(
                        "daemon",
                        "warn",
                        &format!("could not ask the keeper to stop {id}: {}", error.message),
                    );
                }
            });
        }
    }

    /// A removed agent's running terminal becomes cleanup; an ended one is released now.
    pub(crate) fn remove(&self, id: &str) -> bool {
        self.runs.remove(id)
    }

    /// Waits until the earlier run is ended and releases it, using the caller's deadline.
    pub(crate) async fn ended_run_released(&self, id: &str, deadline: Instant) -> bool {
        self.runs.ended_run_released(id, deadline).await
    }

    /// Reads the identity of a run still running under the registry lock.
    pub(crate) fn running_process(&self, id: &str) -> Option<ProcessIdentity> {
        self.runs.process(id)
    }

    /// Recovery: obtains a held run's terminal from the startup connection, before readiness.
    pub(crate) async fn take_back(&self, held: &KeeperHeldAgent) -> Result<PtyMaster, ErrorBody> {
        let keeper = self.recovery_keeper()?;
        Self::terminal(&keeper, held).await
    }

    /// Recovery: keeps a second terminal copy and the run's exit sink. Blocking, no I/O waits.
    pub(crate) fn register_recovered(
        &self,
        held: &KeeperHeldAgent,
        master: &PtyMaster,
        exit: Option<ProcessExit>,
        number: u64,
        exits: ExitSink,
    ) -> std::io::Result<()> {
        let copy = master.try_clone()?;
        self.runs.recovered(
            &held.id,
            Run {
                master: copy,
                identity: ProcessIdentity {
                    pid: held.pid,
                    birth: held.birth.clone(),
                },
                exit,
                stopping: held.stopping,
                role: RunRole::Agent,
                committed: true,
                installed: true,
                number,
                exits: Some(exits),
                credential_digest: None,
            },
        );
        Ok(())
    }

    pub(crate) fn restore_credential(
        &self,
        held: &KeeperHeldAgent,
        number: u64,
        credential: RunCredentialRecord,
    ) -> bool {
        self.runs.restore_credential(held, number, credential)
    }

    /// Recovery: retains unreadable runs untouched; asks the keeper to stop unrecorded ones.
    pub(crate) async fn take_keeper_only(
        &self,
        held: KeeperHeldAgent,
        record: KeeperOnly,
    ) -> Result<(), ErrorBody> {
        let keeper = self.recovery_keeper()?;
        match record {
            KeeperOnly::NoRecord => Self::stop_unrecorded(&keeper, &held.id).await,
            KeeperOnly::Unreadable => {
                let master = Self::terminal(&keeper, &held).await?;
                self.runs.recovered(
                    &held.id,
                    Run {
                        master,
                        identity: ProcessIdentity {
                            pid: held.pid,
                            birth: held.birth.clone(),
                        },
                        exit: None,
                        stopping: held.stopping,
                        role: RunRole::Unreadable,
                        committed: true,
                        installed: false,
                        number: 0,
                        exits: None,
                        credential_digest: None,
                    },
                );
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "leaving {}'s CLI alone: this build cannot read its agent record",
                        held.id
                    ),
                );
                Ok(())
            }
        }
    }

    /// Returns lifecycle's first reason to stay, reading each lock separately.
    pub(crate) fn busy(&self) -> Option<String> {
        if self.connection.lock().unwrap().handing_over {
            return Some("runs are being handed to the keeper".into());
        }
        if let Some(reason) = self.runs.busy() {
            return Some(reason);
        }
        let state = self.connection.lock().unwrap();
        if state.reservations > 0 || state.requested || matches!(state.phase, Phase::Connecting) {
            Some("the keeper is being started or a start is waiting".into())
        } else {
            None
        }
    }

    /// Reads the last authenticated keeper's process ID and build, retained across reconnects.
    pub(crate) fn keeper_info(&self) -> Option<KeeperInfo> {
        let state = self.connection.lock().unwrap();
        Some(KeeperInfo {
            pid: state.identity.as_ref()?.pid,
            build: state.build.clone()?,
        })
    }

    /// Reads the API version selected by the last reconciled keeper.
    pub(crate) fn keeper_api_version(&self) -> Option<ApiVersion> {
        self.connection.lock().unwrap().api_version
    }

    /// Finds the keeper holding the startup lock and waits at most ten seconds for its hello.
    pub(crate) async fn find_at_startup(&self) -> anyhow::Result<FoundKeeper> {
        let deadline = Instant::now() + READY_WAIT;
        let mut logged = false;
        loop {
            let Some(holder) = service::live_holder(&self.core, Service::Keeper)? else {
                return Ok(FoundKeeper::Absent);
            };
            match self.connect(&holder).await {
                Ok(keeper) => {
                    let found = FoundKeeper::Connected {
                        build: keeper.hello.build.clone(),
                        held: keeper
                            .hello
                            .agents
                            .iter()
                            .map(|agent| KeeperHeldAgent {
                                id: agent.agent_id.clone(),
                                pid: agent.pid,
                                birth: agent.birth.clone(),
                                stopping: agent.stopping,
                            })
                            .collect(),
                    };
                    let mut state = self.connection.lock().unwrap();
                    state.first = Some(keeper);
                    state.phase = Phase::Connecting;
                    return Ok(found);
                }
                Err(ConnectError::Incompatible { pid }) => {
                    anyhow::bail!(ConnectError::refusal(pid))
                }
                Err(error) => {
                    if Instant::now() >= deadline {
                        anyhow::bail!("keeper {} did not accept this daemon: {error}", holder.pid);
                    }
                    if !logged {
                        logged = true;
                        facade_base::log::write(
                            "daemon",
                            "warn",
                            &format!(
                                "waiting for keeper {} to accept this daemon: {error}",
                                holder.pid
                            ),
                        );
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Starts the link task after recovery has registered the startup keeper's runs.
    pub(crate) fn serve(self: &Arc<Self>) {
        let link = Arc::clone(self);
        tokio::spawn(async move {
            link.run().await;
        });
    }

    fn wake(&self) {
        self.changes.send_modify(|n| *n += 1);
    }

    async fn wait_ready(&self, request: bool) -> Option<Arc<KeeperClient>> {
        let mut changes = self.changes.subscribe();
        let deadline = Instant::now() + READY_WAIT;
        loop {
            let should_wake = {
                let mut state = self.connection.lock().unwrap();
                match &state.phase {
                    Phase::Ready(keeper) => return Some(Arc::clone(keeper)),
                    Phase::Absent if request => {
                        state.requested = true;
                        true
                    }
                    _ => false,
                }
            };
            if should_wake {
                self.wake();
            }
            if tokio::time::timeout_at(deadline, changes.changed())
                .await
                .is_err()
            {
                return None;
            }
        }
    }

    fn recovery_keeper(&self) -> Result<Arc<KeeperClient>, ErrorBody> {
        let state = self.connection.lock().unwrap();
        state
            .first
            .clone()
            .or_else(|| match &state.phase {
                Phase::Ready(keeper) => Some(Arc::clone(keeper)),
                _ => None,
            })
            .ok_or_else(|| ErrorBody::new(Reason::Unavailable, "the keeper is not connected"))
    }

    async fn terminal(
        keeper: &KeeperClient,
        held: &KeeperHeldAgent,
    ) -> Result<PtyMaster, ErrorBody> {
        let args = SyncArgs {
            agent_id: held.id.clone(),
            pid: held.pid,
            birth: held.birth.clone(),
        };
        keeper.take_terminal(&args).await
    }

    async fn stop_with(keeper: &KeeperClient, id: &str) -> Result<(), ErrorBody> {
        keeper
            .stop(&StopArgs {
                agent_id: id.into(),
            })
            .await
    }

    async fn stop_unrecorded(keeper: &KeeperClient, id: &str) -> Result<(), ErrorBody> {
        facade_base::log::write(
            "daemon",
            "info",
            &format!("stopping {id}'s CLI: it has no live agent record"),
        );
        Self::stop_with(keeper, id).await
    }

    async fn connect(&self, holder: &ProcessIdentity) -> Result<Arc<KeeperClient>, ConnectError> {
        let keeper = KeeperClient::connect(
            &self.core,
            holder,
            self.events.clone(),
            self.changes.clone(),
        )
        .await?;
        keeper.ping();
        {
            let mut state = self.connection.lock().unwrap();
            state.identity = Some(keeper.identity.clone());
            state.build = Some(keeper.hello.build.clone());
        }
        Ok(keeper)
    }

    fn ready(&self, keeper: Arc<KeeperClient>) {
        {
            let mut state = self.connection.lock().unwrap();
            state.phase = Phase::Ready(Arc::clone(&keeper));
            state.api_version = Some(keeper.hello.api_version);
            state.requested = false;
            state.ready_at = Some(ClockInstant::now());
        }
        keeper.deliver_exits();
        self.wake();
    }

    async fn reconcile(&self, keeper: &KeeperClient) -> Result<(), ErrorBody> {
        let mut changes = self.changes.subscribe();
        while self.connection.lock().unwrap().sent != 0 {
            let _ = changes.changed().await;
        }
        let mut plan = self
            .runs
            .reconcile(keeper.identity.pid, &keeper.hello.agents)?;
        for held in plan.unrecorded {
            Self::stop_unrecorded(keeper, &held.agent_id).await?;
        }
        for (args, master, stopping) in self.runs.missing(&keeper.hello.agents)? {
            if stopping {
                plan.stops.push(args.agent_id.clone());
            }
            keeper.give_terminal(&args, master).await?;
        }
        for id in plan.stops {
            Self::stop_with(keeper, &id).await?;
        }
        Ok(())
    }

    async fn run(self: Arc<Self>) {
        let first = self.connection.lock().unwrap().first.take();
        if let Some(keeper) = first {
            self.finish_connection(keeper, false).await;
        }
        let mut changes = self.changes.subscribe();
        loop {
            let phase = self.connection.lock().unwrap().phase.clone();
            match phase {
                Phase::Connecting => self.reconnect().await,
                Phase::Absent => {
                    let need =
                        self.runs.needs_keeper() || self.connection.lock().unwrap().requested;
                    if need {
                        self.connection.lock().unwrap().phase = Phase::Connecting;
                        self.wake();
                    } else {
                        let _ =
                            tokio::time::timeout(Duration::from_secs(1), changes.changed()).await;
                    }
                }
                Phase::Ready(keeper) => {
                    let mut closed = keeper.closed();
                    let _ = closed.wait_for(|closed| *closed).await;
                    keeper.fence();
                    let need =
                        self.runs.needs_keeper() || self.connection.lock().unwrap().requested;
                    {
                        let mut state = self.connection.lock().unwrap();
                        state.phase = if need {
                            Phase::Connecting
                        } else {
                            Phase::Absent
                        };
                        if let Some(at) = state.ready_at.take() {
                            state.backoff.healthy(at, ClockInstant::now());
                        }
                    }
                    facade_base::log::write(
                        "daemon",
                        "warn",
                        &format!(
                            "the connection to keeper {} closed; reconnecting",
                            keeper.identity.pid
                        ),
                    );
                    self.wake();
                }
            }
        }
    }

    async fn reconnect(&self) {
        let at = self.connection.lock().unwrap().backoff.at.take();
        if let Some(at) = at {
            tokio::time::sleep_until(at.into()).await;
        }
        let last = self.connection.lock().unwrap().identity.take();
        match self.connect_or_start(last).await {
            Ok(keeper) => self.finish_connection(keeper, true).await,
            Err(error) => {
                let delay = self
                    .connection
                    .lock()
                    .unwrap()
                    .backoff
                    .schedule(ClockInstant::now());
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "could not use a keeper: {error:#}; trying again in {:.1} s",
                        delay.as_secs_f64()
                    ),
                );
            }
        }
    }

    async fn finish_connection(&self, keeper: Arc<KeeperClient>, handover: bool) {
        self.connection.lock().unwrap().handing_over = handover;
        match self.reconcile(&keeper).await {
            Ok(()) => {
                if handover {
                    facade_base::log::write(
                        "daemon",
                        "info",
                        &format!(
                            "keeper {} holds every terminal this daemon holds",
                            keeper.identity.pid
                        ),
                    );
                }
                self.ready(keeper);
            }
            Err(error) => {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "could not hand the terminals to keeper {}: {}; reconnecting",
                        keeper.identity.pid, error.message
                    ),
                );
                keeper.fence();
                if handover {
                    self.connection
                        .lock()
                        .unwrap()
                        .backoff
                        .schedule(ClockInstant::now());
                }
            }
        }
        self.connection.lock().unwrap().handing_over = false;
    }

    async fn connect_or_start(
        &self,
        last: Option<ProcessIdentity>,
    ) -> anyhow::Result<Arc<KeeperClient>> {
        if let Some(holder) = service::live_holder(&self.core, Service::Keeper)
            .context("could not read the keeper lock")?
        {
            return Ok(self.connect(&holder).await?);
        }
        if let Some(last) = last {
            facade_base::log::write(
                "daemon",
                "warn",
                &format!(
                    "keeper {} ended; holding the terminals and starting another",
                    last.pid
                ),
            );
        }
        let candidate = tokio::task::spawn_blocking(|| {
            let program = facade_base::programs::launcher("facade")?;
            service::launch(Service::Keeper, &program, &[])
        })
        .await?
        .context("could not start a keeper")?;
        let pid = candidate.pid();
        facade_base::log::write("daemon", "info", &format!("started keeper {pid}"));
        let (report, process) = tokio::task::spawn_blocking(move || {
            let mut candidate = candidate;
            let report = candidate.report(RestartBackoff::STARTUP_REPORT_TIMEOUT);
            (report, candidate.into_process())
        })
        .await?;
        tokio::task::spawn_blocking(move || process.wait());
        match report {
            Some(Report::Started | Report::Contention) => {}
            Some(Report::Failed(message)) => {
                anyhow::bail!("keeper {pid} could not start: {message}")
            }
            Some(Report::Silent) | None => {
                anyhow::bail!("keeper {pid} did not report that it started")
            }
        }
        let holder = service::live_holder(&self.core, Service::Keeper)
            .context("could not read the keeper lock")?
            .context("no keeper holds the keeper lock")?;
        Ok(self.connect(&holder).await?)
    }
}
