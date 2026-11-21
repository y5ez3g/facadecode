//! How the command line reaches the Orchestrator and installs a running replacement. Status,
//! installers and passive machine links can check for an existing service without starting it.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use facade_base::api_v1::daemon::{
    self, AgentLabel, DaemonUpgrade, DaemonUpgradeArgs, DaemonUpgradeResult,
};
use facade_base::api_v1::daemon_client::DaemonClient;
use facade_base::api_v1::{
    ApiVersion, ApiVersions, ErrorBody, NoArgs, Request, ServerMessage, encode_line, keeper,
    read_server_message,
};
use facade_base::daemon_client::{takeover_timeout, transient_transport};
use facade_base::paths::ClientSocket;
use facade_base::service::{self, Candidate, Report, Service};

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
    let client = open_terminal(&socket, until, &mut |_| true).map_err(explicit)?;
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

fn connect_with_takeover(
    purpose: Purpose,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure> {
    let ours = facade_base::build_id();
    let mut client = reach_daemon(
        purpose != Purpose::Install,
        cancelled,
        DAEMON_CONNECT_TIMEOUT,
        purpose.deadline(),
        |socket, until| open_terminal(socket, until, opening),
    )?;
    let running = &client.hello_result.build;
    if running == &ours || purpose != Purpose::Install && !facade_base::takes_over(&ours, running) {
        return Ok(client);
    }

    let asked = Instant::now();
    let handed = ask_to_take_over(&mut client, &ours, purpose.deadline(), cancelled)?;
    let timeout = takeover_timeout();
    let until = Instant::now() + timeout;
    let until = purpose
        .deadline()
        .map_or(until, |deadline| deadline.min(until));
    let replacement = wait_for_closing(client, until, cancelled)
        .and_then(|()| {
            reach_daemon(false, cancelled, timeout, Some(until), |socket, until| {
                Ok(open_terminal(socket, until, opening)?
                    .filter(|client| client.hello_result.build == ours))
            })
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
                &ours,
                &handed.from,
                &format!("{count} {}", if count == 1 { "agent" } else { "agents" }),
                asked.elapsed(),
                purpose != Purpose::Command,
            )
        );
    }
    Ok(replacement)
}

/// The old daemon can refuse new hellos until its replacement is ready.
fn open_terminal(
    socket: &Path,
    until: Instant,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> anyhow::Result<Option<DaemonClient>> {
    match DaemonClient::connect(socket, until, opening) {
        Err(error)
            if error
                .downcast_ref::<ErrorBody>()
                .is_some_and(|body| body.data.reason == "upgrading") =>
        {
            Ok(None)
        }
        result => result,
    }
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

/// Sends the handover request on the connection that negotiated terminal access.
fn ask_to_take_over(
    client: &mut DaemonClient,
    ours: &str,
    deadline: Option<Instant>,
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
    if let Some(until) = deadline {
        client
            .writer
            .set_write_timeout(Some(time_left(until, cancelled)?))
            .map_err(permanent)?;
    }
    let result = match client.begin_call::<DaemonUpgrade>(upgrade) {
        Ok(id) => {
            if let Some(until) = deadline {
                client
                    .writer
                    .set_read_timeout(Some(time_left(until, cancelled)?))
                    .map_err(permanent)?;
            }
            client.result::<DaemonUpgrade>(id)
        }
        Err(error) => Err(error),
    };
    if let Some(until) = deadline {
        time_left(until, cancelled)?;
    }
    result.map_err(|error| {
        let blockers = error
            .downcast_ref::<ErrorBody>()
            .filter(|body| body.data.reason == "protocol_incompatible")
            .and_then(|body| body.data.details.as_ref()?.get("agents"))
            .and_then(|agents| serde_json::from_value(agents.clone()).ok())
            .unwrap_or_default();
        permanent(TakeoverRefusal {
            message: errors::takeover_refused(ours, &running, &error),
            blockers,
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
    overall_deadline: Option<Instant>,
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
    let deadline = overall_deadline.map_or(started + timeout, |until| until.min(started + timeout));
    let wait = deadline.saturating_duration_since(started);
    let mut keeper = StartedKeeper::default();
    loop {
        if cancelled() {
            return Err(ConnectFailure::Cancelled);
        }
        let opened = if Instant::now() < deadline {
            open(&socket, deadline)
        } else {
            Ok(None)
        };
        if cancelled() {
            return Err(ConnectFailure::Cancelled);
        }
        if let Some(client) = opened.map_err(permanent)?
            && Instant::now() < deadline
        {
            return Ok(client);
        }
        keeper.check(&logs)?;
        let daemon_runs = service::live_holder(&home, Service::Daemon)
            .map_err(permanent)?
            .is_some();
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
        if start_if_idle
            && !daemon_runs
            && keeper.0.is_none()
            && service::live_holder(&home, Service::Keeper)
                .map_err(permanent)?
                .is_none()
        {
            keeper.start().map_err(permanent)?;
        }
        std::thread::sleep(RETRY_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
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
