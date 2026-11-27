//! How the command line reaches the Orchestrator and installs a running replacement. Status,
//! installers and passive machine links can check for an existing service without starting it.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::Context;
use facade_base::api_v1::daemon::{
    self, AgentLabel, DaemonUpgrade, DaemonUpgradeArgs, DaemonUpgradeResult,
};
use facade_base::api_v1::daemon_client::{DaemonClient, takeover_timeout, transient_transport};
use facade_base::api_v1::{
    ApiVersion, ApiVersions, ErrorBody, NoArgs, Request, ServerMessage, encode_line, keeper,
    read_server_message,
};
use facade_base::service::{self, Candidate, Report, Service};
use facade_base::unix_process::{Presence, presence};
use facade_base::{paths::ClientSocket, programs, startup};

use crate::errors::{self, Problem, ServeFailure};

/// The wait for the initial connection, including time to start the daemon.
const DAEMON_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest a daemon that already runs has to answer where nothing starts one.
const RUNNING_TIMEOUT: Duration = Duration::from_secs(2);
/// The wait between two tries to connect within one attempt.
const RETRY_INTERVAL: Duration = Duration::from_millis(25);
/// The observation cadence while a cold attempt may still be installing or recovering.
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);

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

/// Connects to the daemon within one attempt, starting Facade where nothing answers.
pub(super) fn connect_or_start() -> anyhow::Result<DaemonClient> {
    first_connection(None).map_err(unreachable)
}

/// Connects or starts Facade within the command's total deadline.
pub(super) fn connect_or_start_until(until: Instant) -> anyhow::Result<DaemonClient> {
    first_connection(Some(until)).map_err(unreachable)
}

fn first_connection(deadline: Option<Instant>) -> Result<DaemonClient, ConnectFailure> {
    let client = connect_with_takeover(Purpose::Command(deadline), &|| false, &mut |_| true)?;
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
    let client = connect_local(&socket, until, &mut |_| true).map_err(explicit)?;
    if client.is_none() && services_running(&facade_base::paths::framework_dir()?)? {
        return Err(explicit(anyhow::anyhow!(errors::daemon_slow(
            true,
            RUNNING_TIMEOUT.as_secs()
        ))));
    }
    Ok(client)
}

/// Tries the requested endpoint, then the one the same home's daemon bound under another spelling.
fn connect_local(
    socket: &Path,
    until: Instant,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> anyhow::Result<Option<DaemonClient>> {
    let client = DaemonClient::connect(socket, until, opening)?;
    if client.is_some() || Instant::now() >= until {
        return Ok(client);
    }
    let home = facade_base::paths::facade_home()?;
    let Some((alternate, holder)) = service::alternate_daemon_socket(&home)? else {
        return Ok(None);
    };
    let framework = home.join("framework");
    DaemonClient::connect(&alternate, until, &mut |stream| {
        service::authenticate_server(stream, &framework, Service::Daemon).as_ref() == Ok(&holder)
            && opening(stream)
    })
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
    Command(Option<Instant>),
    Attachment(Instant),
    Install,
}

impl Purpose {
    fn deadline(self) -> Option<Instant> {
        match self {
            Self::Command(deadline) => deadline,
            Self::Attachment(deadline) => Some(deadline),
            _ => None,
        }
    }
}

fn connect_with_takeover(
    purpose: Purpose,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure> {
    let ours = facade_base::build_id();
    let mut client = reach_daemon(
        if purpose == Purpose::Install {
            WaitMode::Existing
        } else {
            WaitMode::Active
        },
        cancelled,
        DAEMON_CONNECT_TIMEOUT,
        purpose.deadline(),
        |socket, until| connect_local(socket, until, opening),
    )?;
    let running = &client.hello_result.build;
    if !facade_base::takes_over(&ours, running)
        || programs::current_build()
            .is_some_and(|selected| selected != ours && !facade_base::takes_over(&ours, &selected))
    {
        return Ok(client);
    }

    let asked = Instant::now();
    let handed = ask_to_take_over(&mut client, &ours, purpose, cancelled)?;
    let timeout = takeover_timeout();
    let until = Instant::now() + timeout;
    let until = purpose
        .deadline()
        .map_or(until, |deadline| deadline.min(until));
    let replacement = wait_for_closing(client, until, cancelled)
        .and_then(|()| {
            // With no CLI to hold, the keeper can exit with the old daemon. Start the selected
            // services in that case so the already-awake home can finish its takeover.
            reach_daemon(
                WaitMode::Replacement,
                cancelled,
                timeout,
                Some(until),
                |socket, until| {
                    Ok(connect_local(socket, until, opening)?.filter(|client| {
                        let build = &client.hello_result.build;
                        build == &ours || facade_base::takes_over(build, &ours)
                    }))
                },
            )
        })
        .map_err(|failure| match failure {
            ConnectFailure::Timeout(error) => ConnectFailure::Timeout(
                error.context(errors::takeover_silent(&ours, timeout.as_secs())),
            ),
            failure => failure,
        })?;
    if !matches!(purpose, Purpose::Attachment(_)) {
        let count = handed.agent_count;
        eprintln!(
            "{}",
            errors::took_over(
                &replacement.hello_result.build,
                &handed.from,
                &format!("{count} {}", if count == 1 { "agent" } else { "agents" }),
                asked.elapsed(),
                !matches!(purpose, Purpose::Command(_)),
            )
        );
    }
    Ok(replacement)
}

/// The existing diagnostic and the agents that blocked a keeper takeover, when known.
#[derive(Debug)]
struct TakeoverRefusal {
    message: String,
    blockers: Vec<AgentLabel>,
    body: Option<ErrorBody>,
}

impl std::fmt::Display for TakeoverRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TakeoverRefusal {}

/// Sends the handover request on the connection that negotiated terminal access.
fn ask_to_take_over(
    client: &mut DaemonClient,
    ours: &str,
    purpose: Purpose,
    cancelled: &dyn Fn() -> bool,
) -> Result<DaemonUpgradeResult, ConnectFailure> {
    let running = client.hello_result.build.clone();
    let program = facade_base::this_program().map_err(permanent)?;
    let upgrade = DaemonUpgradeArgs {
        program: program.display().to_string(),
        build: ours.to_string(),
        daemon_api_versions: takeover_versions(daemon::SUPPORTED_API_VERSIONS),
        keeper_api_versions: takeover_versions(keeper::SUPPORTED_API_VERSIONS),
    };
    client.disable_auto_reconnect();
    let result = match purpose {
        Purpose::Command(Some(until)) => client.call_until::<DaemonUpgrade>(upgrade, until),
        Purpose::Attachment(until) => {
            client
                .writer
                .set_write_timeout(Some(time_left(until, cancelled)?))
                .map_err(permanent)?;
            match client.begin_call::<DaemonUpgrade>(upgrade) {
                Ok(id) => {
                    client
                        .writer
                        .set_read_timeout(Some(time_left(until, cancelled)?))
                        .map_err(permanent)?;
                    client.result::<DaemonUpgrade>(id)
                }
                Err(error) => Err(error),
            }
        }
        _ => client.call::<DaemonUpgrade>(upgrade),
    };
    if let Some(until) = purpose.deadline() {
        time_left(until, cancelled)?;
    }
    result.map_err(|error| {
        let body = error.downcast_ref::<ErrorBody>().cloned();
        let blockers = body
            .as_ref()
            .filter(|body| body.data.reason == "protocol_incompatible")
            .and_then(|body| body.data.details.as_ref()?.get("agents"))
            .and_then(|agents| serde_json::from_value(agents.clone()).ok())
            .unwrap_or_default();
        let mut message = errors::takeover_refused(ours, &running, &error);
        if facade_base::version_of(ours) == facade_base::version_of(&running)
            && error
                .downcast_ref::<ErrorBody>()
                .is_some_and(|body| body.data.reason == "refused")
            && let Ok(home) = facade_base::paths::facade_home()
        {
            message.push_str(&format!(
                ". Let agents finish and stop the daemon and keeper for {} before retrying",
                home.display()
            ));
        }
        permanent(TakeoverRefusal {
            message,
            blockers,
            body,
        })
    })
}

/// The upgrade receipt precedes closing. A connection that Base already acknowledged can be
/// dropped immediately. The next hello confirms the requested build even if the old stream ends
/// before the notification arrives.
fn wait_for_closing(
    client: DaemonClient,
    until: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), ConnectFailure> {
    if client.closing.is_some() {
        return Ok(());
    }
    let (mut reader, mut writer) = client.into_stream();
    let mut line = Vec::new();
    loop {
        let wait = time_left(until, cancelled)?;
        if let Err(error) = writer.set_read_timeout(Some(wait)) {
            return if transient_transport(&error) {
                Ok(())
            } else {
                Err(permanent(error))
            };
        }
        let message = read_server_message(&mut reader, &mut line);
        let remaining = time_left(until, cancelled)?;
        match message {
            Ok(Some(ServerMessage::Notification(notification)))
                if notification.method == "closing" =>
            {
                if writer.set_write_timeout(Some(remaining)).is_ok() {
                    let _ =
                        writer.write_all(&encode_line(&Request::new(None, "closing", NoArgs {})));
                }
                return Ok(());
            }
            Ok(Some(_)) => {}
            Ok(None) => return Ok(()),
            Err(error) if transient_transport(&error) => return Ok(()),
            Err(error) => return Err(permanent(error)),
        }
    }
}

fn time_left(until: Instant, cancelled: &dyn Fn() -> bool) -> Result<Duration, ConnectFailure> {
    if cancelled() {
        return Err(ConnectFailure::Cancelled);
    }
    let wait = until.saturating_duration_since(Instant::now());
    if wait.is_zero() {
        return Err(ConnectFailure::Timeout(
            std::io::Error::from(std::io::ErrorKind::TimedOut).into(),
        ));
    }
    Ok(wait.max(Duration::from_millis(1)))
}

fn takeover_versions(supported: &[ApiVersion]) -> ApiVersions {
    ApiVersions::new(supported.to_vec()).expect("each endpoint supports at least one API version")
}

/// The keeper one attempt started, if any, and its startup report.
#[derive(Default)]
struct StartedKeeper {
    worker: Option<std::sync::mpsc::Receiver<anyhow::Result<Option<Candidate>>>>,
    candidate: Option<Candidate>,
    retry: Option<Instant>,
}

impl StartedKeeper {
    fn start(&mut self) -> anyhow::Result<()> {
        if self.worker.is_some()
            || self.candidate.is_some()
            || self.retry.is_some_and(|when| Instant::now() < when)
        {
            return Ok(());
        }
        // Hand the child directly to its observer. If the observer leaves, the worker still owns
        // the child and releases it through Base.
        let (project, result) = std::sync::mpsc::sync_channel(0);
        std::thread::Builder::new()
            .name("start-keeper".into())
            .spawn(move || {
                if let Err(std::sync::mpsc::SendError(Ok(Some(candidate)))) =
                    project.send(programs::start_keeper())
                {
                    candidate.into_process().reap_in_background();
                }
            })?;
        self.worker = Some(result);
        self.retry = Some(Instant::now() + Duration::from_millis(200));
        Ok(())
    }

    fn check(&mut self, logs: &Path) -> Result<(), ConnectFailure> {
        if let Some(worker) = &self.worker {
            match worker.try_recv() {
                Ok(result) => {
                    self.worker = None;
                    self.candidate = result.map_err(permanent)?;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.worker = None;
                    return Err(permanent(anyhow::anyhow!("the keeper launch worker ended")));
                }
            }
        }
        let Some(keeper) = self.candidate.as_mut() else {
            return Ok(());
        };
        match keeper.report(Duration::ZERO) {
            Some(Report::Failed(why)) => Err(permanent(Unstarted {
                hidden: why.to_string(),
                why: why.to_string(),
                log: logs.join("keeper.log"),
            })),
            Some(Report::Silent) => Err(permanent(silent_keeper(logs))),
            Some(Report::Contention) => {
                if let Some(keeper) = self.candidate.take() {
                    keeper.into_process().reap_in_background();
                }
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
    Unstarted { why, log, hidden }
}

impl Drop for StartedKeeper {
    fn drop(&mut self) {
        if let Some(keeper) = self.candidate.take() {
            keeper.into_process().reap_in_background();
        }
    }
}
/// Opens the socket for an SSH machine hello. A passive link leaves a sleeping service idle.
pub(super) fn machine_socket(wake: bool) -> anyhow::Result<Option<ClientSocket>> {
    if !wake && !services_running(&facade_base::paths::framework_dir()?)? {
        return Ok(None);
    }
    let socket = reach_daemon(
        if wake {
            WaitMode::Active
        } else {
            WaitMode::Passive
        },
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum WaitMode {
    Active,
    Locked,
    Existing,
    Passive,
    Replacement,
}

impl WaitMode {
    fn starts(self) -> bool {
        matches!(self, Self::Active | Self::Locked | Self::Replacement)
    }

    fn observes(self) -> bool {
        matches!(self, Self::Active | Self::Locked | Self::Existing)
    }
}

fn startup_error(failure: startup::Failure) -> ConnectFailure {
    service::gate_for_test("startup-before-failure-report");
    let why = format!("{}: {}", failure.stage, failure.reason);
    permanent(Unstarted {
        hidden: errors::see_log(&why, &failure.log),
        why,
        log: failure.log,
    })
}

fn startup_timeout(logs: &Path, why: String) -> ConnectFailure {
    ConnectFailure::Timeout(
        Unstarted {
            hidden: errors::see_log(&why, logs),
            why,
            log: logs.join("daemon.log"),
        }
        .into(),
    )
}

static DISPATCHED_FAILURE: OnceLock<startup::DispatchedFailure> = OnceLock::new();

/// Records a completed diagnostic after the command has written it to stderr.
pub(super) fn acknowledge_startup_failure() {
    if let Some(dispatch) = DISPATCHED_FAILURE.get()
        && let Ok(home) = facade_base::paths::framework_dir()
    {
        let _ = startup::acknowledge(&home, dispatch);
    }
}

fn should_probe_daemon(may_serve: bool, deadline: Instant, now: Instant) -> bool {
    let left = deadline.saturating_duration_since(now);
    !left.is_zero() && (may_serve || left <= STARTUP_POLL_INTERVAL)
}

/// Reserve the end of the window for transport probes, even if no startup change was signalled.
fn next_observation(
    observes_startup: bool,
    deadline: Instant,
    now: Instant,
) -> (Instant, Duration) {
    if observes_startup && deadline.saturating_duration_since(now) > STARTUP_POLL_INTERVAL {
        (deadline - STARTUP_POLL_INTERVAL, STARTUP_POLL_INTERVAL)
    } else {
        (deadline, RETRY_INTERVAL)
    }
}

/// Waits for the daemon to answer, starting it only for callers that ask to wake the home.
fn reach_daemon<T>(
    mode: WaitMode,
    cancelled: &dyn Fn() -> bool,
    timeout: Duration,
    overall_deadline: Option<Instant>,
    mut open: impl FnMut(&Path, Instant) -> anyhow::Result<Option<T>>,
) -> Result<T, ConnectFailure> {
    let home = if mode.starts() {
        service::create_private_home()
    } else {
        facade_base::paths::framework_dir()
    }
    .map_err(permanent)?;
    let logs = home.join("logs");
    let socket = facade_base::paths::daemon_socket().map_err(permanent)?;
    service::gate_for_test("startup-before-observing-daemon");
    let first = Instant::now();
    let fallback = startup::Budget::fresh();
    let fixed = if mode.observes() {
        fallback.deadline()
    } else {
        first + timeout
    };
    let mut keeper = StartedKeeper::default();
    let mut startup_wait = None;
    let mut following = None::<startup::Attempt>;
    let mut followed_daemon = None;
    let mut notice_at = first + Duration::from_secs(10);
    let within_call = |deadline| overall_deadline.map_or(deadline, |until| until.min(deadline));
    let caller_expired = || overall_deadline.is_some_and(|until| Instant::now() >= until);
    let caller_timeout = "the command deadline elapsed while Facade was starting";
    let mut deadline = within_call(fixed);
    loop {
        if cancelled() {
            return Err(ConnectFailure::Cancelled);
        }
        if mode.observes() && caller_expired() {
            return Err(startup_timeout(&logs, caller_timeout.to_owned()));
        }
        let mut handoff_busy = false;
        if mode != WaitMode::Locked && (mode.observes() || mode == WaitMode::Replacement) {
            match startup::next_failure(
                &home,
                following.as_ref().zip(followed_daemon.as_ref()),
                overall_deadline,
            ) {
                Ok(Some(startup::StartupFailure::Followed(failure))) => {
                    return Err(startup_error(failure));
                }
                Ok(Some(startup::StartupFailure::Dispatched(dispatch))) => {
                    let failure = dispatch.failure.clone();
                    let _ = DISPATCHED_FAILURE.set(dispatch);
                    return Err(startup_error(failure));
                }
                Ok(None) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => handoff_busy = true,
                Err(error) => return Err(permanent(error)),
            }
        }
        let mut stage = "starting the keeper".to_owned();
        let mut launched = false;
        let mut budget = fallback;
        let mut holders = None;
        if mode.observes() {
            if let Some(current) =
                startup::Attempt::current(&home).filter(startup::Attempt::in_progress)
            {
                let daemon = service::live_holder(&home, Service::Daemon).map_err(permanent)?;
                let has_daemon = daemon
                    .as_ref()
                    .is_some_and(|daemon| current.follows(daemon));
                let holding_keeper = if has_daemon {
                    None
                } else {
                    service::live_holder(&home, Service::Keeper).map_err(permanent)?
                };
                let has_keeper = holding_keeper
                    .as_ref()
                    .is_some_and(|keeper| current.belongs_to_keeper(keeper));
                launched = !has_daemon && !has_keeper && current.launching().map_err(permanent)?;
                if following.is_none() && (launched || has_keeper || has_daemon) {
                    following = Some(current);
                }
                holders = Some((daemon, holding_keeper));
            }
            if let Some(attempt) = &following {
                if !handoff_busy && followed_daemon.is_none() {
                    let daemon = match &holders {
                        Some((daemon, _)) => daemon.clone(),
                        None => service::live_holder(&home, Service::Daemon).map_err(permanent)?,
                    };
                    followed_daemon = daemon.filter(|daemon| attempt.follows(daemon));
                    if followed_daemon.is_some() {
                        service::gate_for_test("startup-following-daemon");
                    }
                }
                (budget, stage) = attempt.status();
                deadline = within_call(budget.deadline());
            }
        }

        let followed_failure = || {
            following
                .as_ref()
                .zip(followed_daemon.as_ref())
                .and_then(|(attempt, daemon)| attempt.candidate_failure(daemon))
        };
        if mode != WaitMode::Locked
            && !caller_expired()
            && let Some(failure) = followed_failure()
        {
            return Err(startup_error(failure));
        }
        service::gate_for_test("startup-before-daemon-probe");
        let may_serve = holders.as_ref().is_none_or(|(daemon, _)| daemon.is_some());
        if !handoff_busy && should_probe_daemon(may_serve, deadline, Instant::now()) {
            let connected = match open(&socket, deadline) {
                Ok(connected) => connected,
                Err(error)
                    if mode == WaitMode::Locked
                        && error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                            error.kind() == std::io::ErrorKind::WouldBlock
                        }) =>
                {
                    handoff_busy = true;
                    None
                }
                Err(error) => return Err(permanent(error)),
            };
            if cancelled() {
                return Err(ConnectFailure::Cancelled);
            }
            if mode != WaitMode::Locked
                && !caller_expired()
                && let Some(failure) = followed_failure()
            {
                return Err(startup_error(failure));
            }
            if let Some(connected) = connected
                && Instant::now() < deadline
            {
                return Ok(connected);
            }
        }
        service::gate_for_test("startup-after-daemon-probe");
        if mode == WaitMode::Locked && !handoff_busy {
            match startup::peek_failure(&home) {
                Ok(Some(failure)) => return Err(startup_error(failure)),
                Ok(None) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => handoff_busy = true,
                Err(error) => return Err(permanent(error)),
            }
            if let Some(failure) = followed_failure() {
                return Err(startup_error(failure));
            }
        }
        if mode.observes() && caller_expired() {
            return Err(startup_timeout(&logs, caller_timeout.to_owned()));
        }
        keeper.check(&logs)?;
        let (daemon, holding_keeper) = match holders {
            Some(holders) => holders,
            None => {
                let daemon = service::live_holder(&home, Service::Daemon).map_err(permanent)?;
                let holding_keeper = if mode != WaitMode::Passive {
                    service::live_holder(&home, Service::Keeper).map_err(permanent)?
                } else {
                    None
                };
                (daemon, holding_keeper)
            }
        };
        if mode.observes() && following.is_none() {
            deadline = within_call(budget.deadline());
        }

        let now = Instant::now();
        if now >= deadline {
            // The followed generation can advance between any two startup observations.
            if let Some(attempt) = &following {
                (budget, stage) = attempt.status();
                deadline = within_call(budget.deadline());
                if Instant::now() < deadline {
                    continue;
                }
            }
            let why = if mode.observes() {
                let limit = if overall_deadline.is_some_and(|until| until <= budget.deadline()) {
                    caller_timeout
                } else {
                    budget.limit_reason()
                };
                format!("{limit} ({stage})")
            } else {
                let wait = deadline.saturating_duration_since(first);
                errors::daemon_slow(
                    daemon.is_some(),
                    wait.as_secs() + u64::from(wait.subsec_nanos() > 0),
                )
            };
            return Err(startup_timeout(&logs, why));
        }
        if mode.observes() && now >= notice_at {
            eprintln!("facade: Orchestrator is still starting ({stage})");
            notice_at = now + Duration::from_secs(10);
        }
        let wait_for_startup = mode.observes() && overall_deadline.is_none();
        if wait_for_startup && startup_wait.is_none() {
            startup_wait = Some(startup::StartupWait::open(&home));
        }
        if mode.starts()
            && !handoff_busy
            && !launched
            && daemon.is_none()
            && holding_keeper.is_none()
        {
            keeper.start().map_err(permanent)?;
        }
        let (next, interval) = next_observation(mode.observes(), deadline, Instant::now());
        if let Some(wait) = &mut startup_wait
            && !handoff_busy
            && interval == STARTUP_POLL_INTERVAL
        {
            wait.wait(next.min(notice_at), interval);
        } else {
            std::thread::sleep(interval.min(next.saturating_duration_since(Instant::now())));
        }
    }
}

/// Background startup succeeds as soon as there is a verified living daemon holding the lock.
pub(super) fn detach(installed_relay: bool) -> anyhow::Result<i32> {
    programs::validate_running_build()?;
    let home = facade_base::paths::framework_dir()?;
    let accepted = reach_daemon(
        WaitMode::Locked,
        &|| false,
        DAEMON_CONNECT_TIMEOUT,
        None,
        |_, _| {
            let accepted = startup::accept_detach(&home);
            service::gate_for_test("startup-after-detach-probe");
            Ok(accepted?)
        },
    )
    .map_err(|failure| report_editor_startup(failure.into()))?;
    if let Some(ticket) = accepted.ticket
        && std::env::var_os("FACADE_STARTUP_REPORT").as_deref() == Some(std::ffi::OsStr::new("1"))
    {
        println_or_end!("facade-startup-locked {}", serde_json::to_string(&ticket)?);
    }
    if installed_relay {
        let selected = facade_base::paths::facade_home()?;
        let active = facade_base::paths::active_installation_home(&selected);
        let key = facade_base::paths::home_key(active.as_deref().unwrap_or(&selected));
        println_or_end!("facade-startup-home-key {key}");
    }
    Ok(0)
}

/// Watches the attempt handed to an editor, without waking or replacing a service.
pub(super) fn await_startup(words: &[String]) -> anyhow::Result<i32> {
    if words.is_empty() {
        return await_unreported_startup();
    }
    let [generation, pid, birth] = words else {
        anyhow::bail!("missing startup identity")
    };
    let home = facade_base::paths::framework_dir()?;
    let attempt = startup::Attempt::of(&home, generation)
        .context("the startup attempt is no longer readable")?;
    let original = facade_base::process::ProcessIdentity {
        pid: pid.parse()?,
        birth: birth.clone(),
    };
    let socket = facade_base::paths::daemon_socket()?;
    let mut notice_at = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(failure) = attempt.candidate_failure(&original) {
            return Err(report_editor_startup(startup_error(failure).into()));
        }
        let keeper = service::live_holder(&home, Service::Keeper)?;
        let daemon = service::live_holder(&home, Service::Daemon)?;
        let observed = daemon.as_ref().and_then(|daemon| {
            if *daemon == original {
                return Some(attempt.clone());
            }
            attempt
                .daemon_ready(&original)
                .then(|| startup::Attempt::current(&home).filter(|next| next.follows(daemon)))?
        });
        let (budget, stage) = observed.as_ref().unwrap_or(&attempt).status();
        let deadline = budget.deadline();
        if budget.exhausted() {
            anyhow::bail!(
                "{} ({stage})\nSee {}",
                budget.limit_reason(),
                home.join("logs/daemon.log").display()
            );
        }
        if let (Some(daemon), Some(observed)) = (daemon.as_ref(), observed) {
            let mut prove = |stream: &ClientSocket| {
                service::authenticate_server(stream, &home, Service::Daemon).as_ref() == Ok(daemon)
            };
            if let Some(client) = DaemonClient::connect(&socket, deadline, &mut prove)?
                && client.hello_result.pid == daemon.pid
                && service::authenticate_server(&client.writer, &home, Service::Daemon).as_ref()
                    == Ok(daemon)
                && startup::Attempt::current(&home)
                    .is_some_and(|current| current.generation() == observed.generation())
            {
                return startup_ready(daemon.pid, budget.end());
            }
        } else if keeper.is_none()
            && matches!(presence(&original), Ok(Presence::Ended))
            && !attempt.daemon_ready(&original)
        {
            anyhow::bail!(
                "daemon {} exited before becoming ready ({stage})\nSee {}",
                original.pid,
                home.join("logs/daemon.log").display()
            );
        }
        if Instant::now() >= notice_at {
            eprintln!("facade: Orchestrator is still starting ({stage})");
            notice_at = Instant::now() + Duration::from_secs(10);
        }
        std::thread::sleep(
            STARTUP_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn await_unreported_startup() -> anyhow::Result<i32> {
    let home = facade_base::paths::framework_dir()?;
    let fallback = startup::Budget::fresh();
    let mut followed = None;
    let mut end = fallback.end();
    let client = reach_daemon(
        WaitMode::Existing,
        &|| false,
        startup::TOTAL,
        None,
        |socket, deadline| {
            if followed.is_none() {
                let daemon = service::live_holder(&home, Service::Daemon)?;
                let keeper = service::live_holder(&home, Service::Keeper)?;
                followed = startup::Attempt::current(&home).filter(|attempt| {
                    (attempt.in_progress() || !attempt.status().0.exhausted())
                        && (daemon
                            .as_ref()
                            .is_some_and(|daemon| attempt.follows(daemon))
                            || keeper
                                .as_ref()
                                .is_some_and(|keeper| attempt.belongs_to_keeper(keeper)))
                });
            }
            let budget = followed
                .as_ref()
                .map_or(fallback, |attempt| attempt.status().0);
            let mut holder = None;
            let mut authenticate = |stream: &ClientSocket| {
                holder = service::authenticate_server(stream, &home, Service::Daemon).ok();
                holder.is_some()
            };
            let client =
                DaemonClient::connect(socket, deadline.min(budget.deadline()), &mut authenticate)?
                    .filter(|client| {
                        holder.as_ref().is_some_and(|process| {
                            client.hello_result.pid == process.pid
                                && service::authenticate_server(
                                    &client.writer,
                                    &home,
                                    Service::Daemon,
                                )
                                .as_ref()
                                    == Ok(process)
                        })
                    });
            if client.is_some() {
                end = budget.end();
            }
            Ok(client)
        },
    )
    .map_err(|failure| report_editor_startup(failure.into()))?;
    startup_ready(client.hello_result.pid, end)
}

fn startup_ready(pid: u32, deadline: u64) -> anyhow::Result<i32> {
    anyhow::ensure!(
        startup::now() < deadline,
        "the Orchestrator startup deadline elapsed before editor hello"
    );
    println!(
        "facade-startup-ready {}",
        serde_json::json!({"pid": pid, "deadlineNs": deadline.to_string()})
    );
    Ok(0)
}
fn services_running(framework: &Path) -> std::io::Result<bool> {
    Ok(service::live_holder(framework, Service::Daemon)?.is_some()
        || service::live_holder(framework, Service::Keeper)?.is_some())
}

/// Selects a sleeping home's programs or waits for an admitted live takeover.
pub(super) fn takeover() -> anyhow::Result<i32> {
    if programs::select_running_if_idle()?.is_none()
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
        return Err(report_editor_startup(error));
    }
    Ok(0)
}

/// Reports typed daemon refusals separately from human diagnostics for editor startup.
fn report_editor_startup(error: anyhow::Error) -> anyhow::Error {
    if std::env::var("FACADE_EDITOR_STARTUP_REPORT").as_deref() != Ok("1") {
        return error;
    }
    let body = if let Some(refusal) = error.downcast_ref::<TakeoverRefusal>() {
        refusal.body.clone().map(|mut body| {
            body.message.clone_from(&refusal.message);
            body
        })
    } else {
        error.downcast_ref::<ErrorBody>().cloned().map(|mut body| {
            // A daemon from before API v1 rejects the new hello arguments.
            if body.code == -32602 && body.data.reason == "invalid_argument" {
                body.data.reason = "protocol_incompatible".into();
                body.message = format!(
                    "The running Framework did not accept daemon API v1. Use compatible Framework builds for the editor, Shell and participating SSH endpoints. {}",
                    body.message
                );
            }
            body
        })
    };
    if let Some(body) = body
        && matches!(
            body.data.reason.as_str(),
            "protocol_incompatible" | "refused"
        )
        && let Ok(payload) = serde_json::to_string(&body)
    {
        let mut stdout = std::io::stdout().lock();
        let _ =
            writeln!(stdout, "facade-editor-daemon-error {payload}").and_then(|()| stdout.flush());
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_daemon_in_the_last_snapshot_does_not_skip_the_final_probe() {
        let deadline = Instant::now() + Duration::from_secs(1);
        let near = deadline - Duration::from_millis(65);

        assert!(!should_probe_daemon(
            false,
            deadline,
            deadline - Duration::from_millis(101)
        ));
        assert!(should_probe_daemon(false, deadline, near));
        assert!(!should_probe_daemon(true, deadline, deadline));
    }

    #[test]
    fn waiting_for_startup_records_leaves_time_for_a_probe_without_an_event() {
        let now = Instant::now();
        let deadline = now + Duration::from_millis(150);

        let (next, cadence) = next_observation(true, deadline, now);
        assert_eq!(next, deadline - STARTUP_POLL_INTERVAL);
        assert_eq!(cadence, STARTUP_POLL_INTERVAL);
        assert!(should_probe_daemon(false, deadline, next));
        assert_eq!(
            next_observation(true, deadline, next),
            (deadline, RETRY_INTERVAL)
        );
    }
}
