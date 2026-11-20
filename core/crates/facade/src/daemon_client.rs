//! How the command line reaches the Orchestrator and installs a running replacement. Status,
//! installers and passive machine links can check for an existing service without starting it.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use facade_base::daemon::{ClientKind, DaemonUpgradeArgs, DaemonUpgradeResult};
use facade_base::daemon_client::{
    DaemonClient, Identity, UpgradeClient, takeover_timeout, transient_transport,
};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::{KEEPER_PROTOCOL_VERSION, MIN_KEEPER_PROTOCOL_VERSION};
use facade_base::paths::ClientSocket;
use facade_base::service::{self, Candidate, Report, Service};
use facade_base::v3::{AgentLabel, DAEMON_PROTOCOL_RANGE, TAKEOVER_DAEMON_PROTOCOL_RANGE};

use crate::errors::{self, Problem, ServeFailure};

/// The wait for the initial connection, including time to start the daemon.
const DAEMON_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest a daemon that already runs has to answer where nothing starts one.
const RUNNING_TIMEOUT: Duration = Duration::from_secs(2);
/// The wait between two tries to connect within one attempt.
const RETRY_INTERVAL: Duration = Duration::from_millis(25);

/// Why one attempt to reach the daemon failed.
#[derive(Debug)]
pub(crate) enum ConnectFailure {
    /// The wait for a daemon to say hello expired. Another attempt may reach one.
    Timeout(anyhow::Error),
    /// Trying again does not help: a permission, protocol or settings error, or a daemon that
    /// could not start.
    Permanent(anyhow::Error),
    /// The caller cancelled the attempt.
    Cancelled,
}

impl From<ConnectFailure> for anyhow::Error {
    fn from(failure: ConnectFailure) -> anyhow::Error {
        match failure {
            ConnectFailure::Cancelled => anyhow::anyhow!("cancelled"),
            ConnectFailure::Timeout(error) | ConnectFailure::Permanent(error) => error,
        }
    }
}

/// One attempt to reach the daemon again, as [`reconnect`] makes it: the attachment's overall
/// deadline, whether the caller has cancelled, and a look at each connection before hello.
pub(crate) type Reconnect = dyn Fn(
    Instant,
    &dyn Fn() -> bool,
    &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure>;

/// Wraps an error that another attempt would only repeat.
fn permanent(error: impl Into<anyhow::Error>) -> ConnectFailure {
    ConnectFailure::Permanent(error.into())
}

/// The command line uses the same identity in every shell.
fn shell_identity() -> Identity {
    Identity {
        kind: ClientKind::Terminal,
        agent: None,
        sessions: Vec::new(),
    }
}

/// Connects to the daemon within one attempt, starting Facade where nothing answers.
pub(super) fn connect_or_start() -> anyhow::Result<DaemonClient> {
    first_connection().map_err(unreachable)
}

/// Makes a command's first connection with default callbacks.
fn first_connection() -> Result<DaemonClient, ConnectFailure> {
    let client = connect_with_takeover(Purpose::Command, &|| false, &mut |_| true)?;
    // A test can hold a command here, after its hello and before its call.
    service::gate_for_test("command-connected");
    Ok(client)
}

/// The failure of a command's attempt to reach Facade, for the reader: why, and the log that says
/// more where one does.
fn unreachable(failure: ConnectFailure) -> anyhow::Error {
    let error = anyhow::Error::from(failure);
    let (why, log) = match error
        .chain()
        .next()
        .and_then(|cause| cause.downcast_ref::<Unstarted>())
    {
        Some(unstarted) => (unstarted.why.clone(), Some(unstarted.log.clone())),
        None => (errors::cause(&error), None),
    };
    Problem::Unreachable { why, log }.into()
}

/// Probes the running Orchestrator without waking or upgrading it.
pub(super) fn probe() -> anyhow::Result<Option<DaemonClient>> {
    let socket = facade_base::paths::daemon_socket().map_err(explicit)?;
    let until = Instant::now() + RUNNING_TIMEOUT;
    let client = DaemonClient::connect_v3(&socket, &shell_identity(), until, &mut |_| true)
        .map_err(explicit)?;
    if client.is_none() && services_running(&facade_base::paths::core_dir()?)? {
        return Err(explicit(anyhow::anyhow!(errors::daemon_slow(
            true,
            RUNNING_TIMEOUT.as_secs()
        ))));
    }
    Ok(client)
}

/// An explicit failure to reach a daemon that runs, such as an unusable home, a permission error
/// or no shared protocol version, as the catalog row.
fn explicit(error: anyhow::Error) -> anyhow::Error {
    Problem::Unreachable {
        why: errors::cause(&error),
        log: None,
    }
    .into()
}

/// Facade did not start: why, the log that says more, the words `facade daemon --detach` has
/// always printed for it, and whether a daemon holds the lock and is still starting.
#[derive(Debug)]
struct Unstarted {
    why: String,
    log: PathBuf,
    hidden: String,
    starting: bool,
}

impl std::fmt::Display for Unstarted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.hidden)
    }
}

impl std::error::Error for Unstarted {}

/// Reconnects an attached terminal. Detaching can close any socket that has not finished hello.
pub(super) fn reconnect(
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure> {
    let mut client = connect_with_takeover(Purpose::Attachment(deadline), cancelled, opening)?;
    client.disable_auto_reconnect();
    Ok(client)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Purpose {
    Command,
    Attachment(Instant),
    Background,
    Install,
}

impl Purpose {
    fn deadline(self) -> Option<Instant> {
        match self {
            Self::Attachment(deadline) => Some(deadline),
            _ => None,
        }
    }
}

enum Contact {
    Current(DaemonClient),
    Legacy(UpgradeClient),
}

/// Only a verified protocol 2 peer needs a compatibility hello. Other mismatches keep the
/// daemon's original error and upgrade instructions.
fn speaks_v2(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ErrorBody>().is_some_and(|body| {
        body.data.reason == Reason::IncompatibleProtocol
            && body.data.protocol.as_ref().is_some_and(|protocol| {
                protocol.local_protocol[1] == TAKEOVER_DAEMON_PROTOCOL_RANGE[0]
            })
    })
}

fn connect_with_takeover(
    purpose: Purpose,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure> {
    let identity = shell_identity();
    let ours = facade_base::build_id();
    let deadline = purpose.deadline();
    let contact = reach_daemon(
        purpose != Purpose::Install,
        cancelled,
        DAEMON_CONNECT_TIMEOUT,
        deadline,
        |socket, until| match DaemonClient::connect_v3(socket, &identity, until, opening) {
            Ok(client) => Ok(client.map(Contact::Current)),
            Err(error) if speaks_v2(&error) => open_upgrade(socket, until, opening, deadline)
                .map(|client| client.map(Contact::Legacy)),
            Err(error) => Err(error),
        },
    )?;
    let mut upgrade = match contact {
        Contact::Current(client) => {
            let running = &client.hello_result.build;
            if running == &ours
                || purpose != Purpose::Install && !facade_base::takes_over(&ours, running)
            {
                return Ok(client);
            }
            drop(client);
            reach_daemon(
                false,
                cancelled,
                DAEMON_CONNECT_TIMEOUT,
                deadline,
                |socket, until| open_upgrade(socket, until, opening, deadline),
            )?
        }
        Contact::Legacy(upgrade) => upgrade,
    };
    // Another client may have completed the takeover while this one was opening its connection.
    let took_over = if upgrade.hello_result().build == ours
        && upgrade.hello_result().protocol == DAEMON_PROTOCOL_RANGE[1]
    {
        None
    } else {
        Some(ask_to_take_over(&mut upgrade, &ours, purpose)?)
    };
    drop(upgrade);
    follow_takeover(&identity, cancelled, opening, &ours, took_over, purpose)
}

/// The compatibility hello clears its socket's read timeout. An attachment also bounds the
/// upgrade request that follows it by the overall reconnect deadline.
fn open_upgrade(
    socket: &Path,
    until: Instant,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
    attachment_deadline: Option<Instant>,
) -> anyhow::Result<Option<UpgradeClient>> {
    let Some(deadline) = attachment_deadline else {
        return UpgradeClient::connect(socket, until, opening);
    };
    let mut stream = None;
    let client = UpgradeClient::connect(socket, until, &mut |candidate| {
        stream = Some(candidate.try_clone());
        opening(candidate)
    })?;
    if let (Some(_), Some(stream)) = (&client, stream) {
        let stream = stream?;
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        stream.set_read_timeout(Some(remaining))?;
        stream.set_write_timeout(Some(remaining))?;
    }
    Ok(client)
}

/// The existing diagnostic and the agents that blocked a keeper takeover, when known.
#[derive(Debug)]
struct TakeoverRefusal {
    message: String,
    blockers: Vec<AgentLabel>,
}

impl std::fmt::Display for TakeoverRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TakeoverRefusal {}

/// Sends the handover request using the negotiated compatibility connection.
fn ask_to_take_over(
    client: &mut UpgradeClient,
    ours: &str,
    purpose: Purpose,
) -> Result<(Instant, DaemonUpgradeResult), ConnectFailure> {
    let asked = Instant::now();
    let program = facade_base::this_program().map_err(permanent)?;
    let upgrade = DaemonUpgradeArgs {
        program: program.display().to_string(),
        build: ours.to_string(),
        daemon_protocol_range: test_range("FACADE_TEST_DAEMON_PROTOCOL")
            .unwrap_or(TAKEOVER_DAEMON_PROTOCOL_RANGE),
        keeper_protocol_range: test_range("FACADE_TEST_KEEPER_PROTOCOL")
            .unwrap_or([MIN_KEEPER_PROTOCOL_VERSION, KEEPER_PROTOCOL_VERSION]),
    };
    client
        .upgrade(upgrade)
        .map(|handed| (asked, handed))
        .map_err(|error| {
            let mut message = errors::takeover_refused(ours, &client.hello_result().build, &error);
            let blockers = if client.hello_result().protocol == TAKEOVER_DAEMON_PROTOCOL_RANGE[0]
                && !matches!(purpose, Purpose::Attachment(_))
            {
                add_legacy_keeper_diagnostic(client, &error, &mut message)
            } else {
                error
                    .downcast::<ErrorBody>()
                    .ok()
                    .filter(|body| body.data.reason == Reason::IncompatibleProtocol)
                    .map_or_else(Vec::new, |body| body.data.agents)
            };
            permanent(TakeoverRefusal { message, blockers })
        })
}

/// The v2 keeper refusal does not give the user the addresses of the running agents.
fn add_legacy_keeper_diagnostic(
    client: &mut UpgradeClient,
    error: &anyhow::Error,
    message: &mut String,
) -> Vec<AgentLabel> {
    let keeper_refused = error.downcast_ref::<ErrorBody>().is_some_and(|body| {
        body.data.reason == Reason::IncompatibleProtocol
            && body.message.contains("the running keeper speaks")
    });
    if !keeper_refused {
        return Vec::new();
    }
    let Ok(listed) = client.legacy_agents() else {
        return Vec::new();
    };
    let local_id = &client.hello_result().machine_id;
    // The legacy diagnostic asks only this machine. Its name may be shared by a peer.
    let selector = facade_base::v3::address::exact_machine_selector(local_id);
    let blockers: Vec<_> = listed
        .agents
        .into_iter()
        .filter(|agent| {
            !agent.guest && agent.process == facade_base::process::ProcessState::Running
        })
        .filter(|agent| &agent.machine_id == local_id)
        .map(|agent| {
            let reference = agent.reference();
            AgentLabel {
                address: facade_base::v3::address::format_agent_address(&reference, &selector),
                reference,
                name: agent.name,
                cli: agent.cli,
                state: legacy_agent_state(agent.state),
                resumable: agent.session.is_some(),
            }
        })
        .collect();
    if !blockers.is_empty() {
        let addresses: Vec<_> = blockers
            .iter()
            .map(|agent| agent.address.as_str())
            .collect();
        message.push_str(&format!(
            "\n  tip: stop {} and retry the upgrade",
            addresses.join(", ")
        ));
    }
    blockers
}

fn legacy_agent_state(state: facade_base::daemon::AgentState) -> facade_base::v3::AgentState {
    use facade_base::{daemon::AgentState as Old, v3::AgentState as Current};

    match state {
        Old::Starting => Current::Starting,
        Old::Working => Current::Working,
        Old::WaitingForYou => Current::WaitingForYou,
        Old::JustDone => Current::JustDone,
        Old::Idle => Current::Idle,
        Old::Error => Current::Error,
        Old::Ended => Current::Ended,
        Old::Unknown => Current::Unknown,
        Old::Unrecognized => Current::Unrecognized,
    }
}

/// An accepted update still needs to start the expected build and answer a new v3 hello.
fn follow_takeover(
    identity: &Identity,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
    ours: &str,
    handed: Option<(Instant, DaemonUpgradeResult)>,
    purpose: Purpose,
) -> Result<DaemonClient, ConnectFailure> {
    let timeout = takeover_timeout();
    let client = reach_daemon(
        false,
        cancelled,
        timeout,
        purpose.deadline(),
        |socket, until| match DaemonClient::connect_v3(socket, identity, until, opening) {
            Ok(client) => Ok(client.filter(|client| client.hello_result.build == ours)),
            Err(error) if speaks_v2(&error) => Ok(None),
            Err(error) => Err(error),
        },
    )
    .map_err(|failure| match failure {
        ConnectFailure::Timeout(error) => {
            ConnectFailure::Timeout(error.context(errors::takeover_silent(ours, timeout.as_secs())))
        }
        failure => failure,
    })?;
    if let Some((asked, handed)) = handed
        && !matches!(purpose, Purpose::Attachment(_))
    {
        eprintln!(
            "{}",
            errors::took_over(
                ours,
                &handed.from,
                &facade_base::daemon::agents_word(handed.agent_count),
                asked.elapsed(),
                purpose != Purpose::Command,
            )
        );
    }
    Ok(client)
}

/// The protocol versions `variable` says this build speaks, as `low,high`: a test of a debug build
/// plays a build whose versions differ. None in a release build.
fn test_range(variable: &str) -> Option<[u32; 2]> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let range = std::env::var(variable).ok()?;
    let (low, high) = range.split_once(',')?;
    Some([low.parse().ok()?, high.parse().ok()?])
}

/// The keeper one attempt started, if any. Whatever way the attempt ends, a thread waits for the
/// keeper's process, so that it never stays a zombie of this command.
#[derive(Default)]
struct StartedKeeper(Option<Candidate>);

impl StartedKeeper {
    /// Starts a keeper through the launcher; the keeper starts the daemon. Installs this build
    /// first, and points the launcher at it where the launcher names no build, an older one, or
    /// one without a version, which no build could ever take over from.
    fn start(&mut self) -> anyhow::Result<()> {
        let ours = facade_base::build_id();
        facade_base::programs::install_running()?;
        let named = facade_base::programs::current_build();
        if named.is_none_or(|named| {
            facade_base::version_of(&named).is_none() || facade_base::takes_over(&ours, &named)
        }) {
            facade_base::programs::point_launchers_at(&ours, &[])?;
        }
        let launcher = facade_base::programs::launcher("facade")?;
        self.0 = Some(service::launch(Service::Keeper, &launcher, &[])?);
        Ok(())
    }

    /// What the started keeper reported so far. One that lost the lock to another keeper is let
    /// go: the attempt waits for that other keeper's daemon.
    fn check(&mut self, logs: &Path) -> Result<(), ConnectFailure> {
        let Some(keeper) = self.0.as_mut() else {
            return Ok(());
        };
        match keeper.report(Duration::ZERO) {
            Some(Report::Failed(why)) => Err(permanent(Unstarted {
                hidden: why.to_string(),
                why: why.to_string(),
                log: logs.join("keeper.log"),
                starting: false,
            })),
            Some(Report::Silent) => Err(permanent(silent_keeper(logs))),
            Some(Report::Contention) => {
                *self = Self::default();
                Ok(())
            }
            Some(Report::Started) | None => Ok(()),
        }
    }
}

/// Says that the keeper exited before it reported, with the last line of its log, which says why:
/// most often that the program the launcher runs could not start.
fn silent_keeper(logs: &Path) -> Unstarted {
    let log = logs.join("keeper.log");
    let last = std::fs::read_to_string(&log).ok().and_then(|text| {
        let line = text.lines().rev().find(|line| !line.trim().is_empty())?;
        Some(line.trim().to_string())
    });
    let why = errors::keeper_exited(last.as_deref());
    let seen = if last.is_some() { log.as_path() } else { logs };
    let hidden = errors::see_log(&why, seen);
    Unstarted {
        why,
        log,
        hidden,
        starting: false,
    }
}

impl Drop for StartedKeeper {
    fn drop(&mut self) {
        if let Some(keeper) = self.0.take() {
            let process = keeper.into_process();
            std::thread::spawn(move || process.wait());
        }
    }
}

/// Opens the socket for an SSH machine hello. A passive link leaves a sleeping service idle.
pub(super) fn machine_socket(wake: bool) -> anyhow::Result<Option<ClientSocket>> {
    if !wake && !services_running(&facade_base::paths::core_dir()?)? {
        return Ok(None);
    }
    let socket = reach_daemon(
        wake,
        &|| false,
        if wake {
            DAEMON_CONNECT_TIMEOUT
        } else {
            RUNNING_TIMEOUT
        },
        None,
        |socket, _| match ClientSocket::connect(socket) {
            Ok(client) => Ok(Some(client)),
            Err(error) if transient_transport(&error) => Ok(None),
            Err(why) => Err(ServeFailure::Socket {
                path: socket.to_path_buf(),
                why,
            }
            .into()),
        },
    )?;
    Ok(Some(socket))
}

/// Waits for the daemon to answer, starting the keeper only for callers that need a service.
fn reach_daemon<T>(
    start_if_idle: bool,
    cancelled: &dyn Fn() -> bool,
    timeout: Duration,
    attachment_deadline: Option<Instant>,
    mut open: impl FnMut(&Path, Instant) -> anyhow::Result<Option<T>>,
) -> Result<T, ConnectFailure> {
    let home = if start_if_idle {
        service::create_private_home()
    } else {
        facade_base::paths::core_dir()
    }
    .map_err(permanent)?;
    let logs = home.join("logs");
    let socket = facade_base::paths::daemon_socket().map_err(permanent)?;
    let started = Instant::now();
    let deadline =
        attachment_deadline.map_or(started + timeout, |until| until.min(started + timeout));
    let wait = deadline.saturating_duration_since(started);
    let mut keeper = StartedKeeper::default();
    loop {
        if cancelled() {
            return Err(ConnectFailure::Cancelled);
        }
        if let Some(client) = open(&socket, deadline).map_err(permanent)? {
            return Ok(client);
        }
        keeper.check(&logs)?;
        let daemon_runs = service::live_holder(&home, Service::Daemon)
            .map_err(permanent)?
            .is_some();
        if start_if_idle
            && !daemon_runs
            && keeper.0.is_none()
            && service::live_holder(&home, Service::Keeper)
                .map_err(permanent)?
                .is_none()
        {
            keeper.start().map_err(permanent)?;
        }
        if Instant::now() >= deadline {
            let seconds = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
            let why = errors::daemon_slow(daemon_runs, seconds);
            let hidden = errors::see_log(&why, &logs);
            let log = logs.join("daemon.log");
            let starting = daemon_runs;
            return Err(ConnectFailure::Timeout(
                Unstarted {
                    why,
                    log,
                    hidden,
                    starting,
                }
                .into(),
            ));
        }
        std::thread::sleep(RETRY_INTERVAL);
    }
}

/// Whether a daemon that holds the lock is still starting, as opposed to none having started.
fn still_starting(error: &anyhow::Error) -> bool {
    error
        .chain()
        .next()
        .and_then(|cause| cause.downcast_ref::<Unstarted>())
        .is_some_and(|unstarted| unstarted.starting)
}

/// `facade daemon --detach` starts the service for an editor, which confirms with its own hello.
pub(super) fn detach() -> anyhow::Result<i32> {
    match connect_with_takeover(Purpose::Background, &|| false, &mut |_| true) {
        Err(ConnectFailure::Timeout(still)) if still_starting(&still) => {
            eprintln!("facade: {still:#}")
        }
        Err(failure) => return Err(failure.into()),
        Ok(_) => {}
    }
    Ok(0)
}

fn services_running(core: &Path) -> std::io::Result<bool> {
    Ok(service::live_holder(core, Service::Daemon)?.is_some()
        || service::live_holder(core, Service::Keeper)?.is_some())
}

/// Connects only to running services and waits for this build to take over.
pub(super) fn takeover() -> anyhow::Result<i32> {
    if services_running(&facade_base::paths::core_dir()?)?
        && let Err(failure) = connect_with_takeover(Purpose::Install, &|| false, &mut |_| true)
    {
        let error = anyhow::Error::from(failure);
        if std::env::var("FACADE_UPGRADE_REPORT").as_deref() == Ok("1")
            && let Some(refusal) = error.downcast_ref::<TakeoverRefusal>()
            && !refusal.blockers.is_empty()
            && let Ok(payload) = serde_json::to_string(&refusal.blockers)
        {
            let mut stdout = std::io::stdout().lock();
            let _ =
                writeln!(stdout, "facade-upgrade-blockers {payload}").and_then(|()| stdout.flush());
        }
        return Err(error);
    }
    Ok(0)
}
