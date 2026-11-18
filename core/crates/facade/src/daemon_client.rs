//! How a command reaches the daemon. Most commands start Facade when nothing answers; a hook and
//! the search for a terminal's agent only talk to one that runs. Help, argument errors and the
//! version need no daemon.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use facade_base::daemon::{
    ClientKind, DAEMON_PROTOCOL_VERSION, DaemonUpgrade, MIN_DAEMON_PROTOCOL_VERSION, UpgradeArgs,
    UpgradeResult,
};
use facade_base::daemon_client::{DaemonClient, Identity, takeover_timeout};
use facade_base::keeper::{KEEPER_PROTOCOL_VERSION, MIN_KEEPER_PROTOCOL_VERSION};
use facade_base::paths::ClientSocket;
use facade_base::service::{self, Candidate, Report, Service};

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

/// One attempt to reach the daemon again, as [`reconnect`] makes it: whether the caller has
/// cancelled, and a look at each connection before hello. A takeover has its own deadline after
/// the initial connection.
pub(crate) type Reconnect = dyn Fn(
    &dyn Fn() -> bool,
    &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure>;

/// Wraps an error that another attempt would only repeat.
fn permanent(error: impl Into<anyhow::Error>) -> ConnectFailure {
    ConnectFailure::Permanent(error.into())
}

/// The agent whose terminal Facade started this command in, by its `FACADE_AGENT`.
pub(super) fn terminal_agent() -> Option<String> {
    let agent = std::env::var("FACADE_AGENT").ok()?;
    (!agent.is_empty()).then_some(agent)
}

/// Who this command is to the daemon: a terminal, acting for `agent`, under the CLI sessions its
/// environment names when `with_sessions`.
fn identity_for(agent: Option<String>, with_sessions: bool) -> Identity {
    let mut sessions = Vec::new();
    if with_sessions {
        for (_, variables) in facade_rules::SESSION_VARIABLES {
            if let Some(session) = std::env::var(variables[0]).ok().filter(|s| !s.is_empty()) {
                sessions.push(session);
            }
        }
    }
    Identity {
        kind: ClientKind::Terminal,
        agent,
        sessions,
    }
}

/// Says hello to a daemon that already runs. None when nothing answers within 2 seconds.
fn hello_if_running(socket: &Path, identity: &Identity) -> anyhow::Result<Option<DaemonClient>> {
    DaemonClient::connect(
        socket,
        identity,
        Instant::now() + RUNNING_TIMEOUT,
        &mut |_| true,
    )
}

/// Connects, acting for `agent`, to a daemon that runs, for a hook, which never starts Facade.
pub(super) fn connect_running(agent: Option<String>) -> Option<DaemonClient> {
    let socket = facade_base::paths::daemon_socket().ok()?;
    hello_if_running(&socket, &identity_for(agent, false))
        .ok()
        .flatten()
}

/// The agent of this command's terminal. A daemon that runs knows it by a CLI session the
/// environment names: a guest, or an agent Facade started. Otherwise, and with no session named,
/// it is the agent Facade started the terminal for, if any.
pub(super) fn agent_of_terminal() -> anyhow::Result<Option<String>> {
    let identity = identity_for(terminal_agent(), true);
    if identity.sessions.is_empty() {
        return Ok(identity.agent);
    }
    let socket = facade_base::paths::daemon_socket()?;
    let known = hello_if_running(&socket, &identity)?.map(|client| client.hello_result.agent);
    Ok(known.unwrap_or(identity.agent))
}

/// Connects to the daemon within one attempt, starting Facade where nothing answers.
pub(super) fn connect_or_start() -> anyhow::Result<DaemonClient> {
    Ok(first_connection(&identity_for(terminal_agent(), true))?)
}

/// Connects as [`connect_or_start`] does, acting for `agent`.
pub(super) fn connect_or_start_for(agent: &str) -> anyhow::Result<DaemonClient> {
    let identity = identity_for(Some(agent.to_string()), false);
    Ok(first_connection(&identity)?)
}

/// Makes a command's first connection with default callbacks.
fn first_connection(identity: &Identity) -> Result<DaemonClient, ConnectFailure> {
    attempt_as(identity, &|| false, &mut |_| true)
}

/// Reconnects an attached terminal. `cancelled` ends the attempt. `opening` sees each
/// connection before hello and can close it.
pub(super) fn reconnect(
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure> {
    attempt_as(&identity_for(terminal_agent(), true), cancelled, opening)
}

/// Reaches the daemon and asks an eligible older build to hand over before using the connection.
fn attempt_as(
    identity: &Identity,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> Result<DaemonClient, ConnectFailure> {
    let mut client = reach(identity, cancelled, opening, DAEMON_CONNECT_TIMEOUT)?;
    let ours = facade_base::build_id();
    if facade_base::takes_over(&ours, &client.hello_result.build)
        && let Some(handed) = ask_to_take_over(&mut client, &ours)?
    {
        drop(client);
        client = follow_takeover(identity, cancelled, opening, &ours, handed)?;
    }
    // A test can hold a command here, after its hello and before its call.
    service::gate_for_test("command-connected");
    Ok(client)
}

/// Asks the Facade `client` reached, of an older build, to hand over to this one. None where it
/// refuses, which the command reports on one line before it goes on with that Facade.
fn ask_to_take_over(
    client: &mut DaemonClient,
    ours: &str,
) -> Result<Option<(Instant, UpgradeResult)>, ConnectFailure> {
    let asked = Instant::now();
    let program = facade_base::this_program().map_err(permanent)?;
    let speaks = |variable, low, high| test_range(variable).unwrap_or([low, high]);
    let upgrade = UpgradeArgs {
        program: program.display().to_string(),
        build: ours.to_string(),
        daemon_protocol: speaks(
            "FACADE_TEST_DAEMON_PROTOCOL",
            MIN_DAEMON_PROTOCOL_VERSION,
            DAEMON_PROTOCOL_VERSION,
        ),
        keeper_protocol: speaks(
            "FACADE_TEST_KEEPER_PROTOCOL",
            MIN_KEEPER_PROTOCOL_VERSION,
            KEEPER_PROTOCOL_VERSION,
        ),
    };
    match client.call::<DaemonUpgrade>(upgrade) {
        Ok(handed) => Ok(Some((asked, handed))),
        Err(error) => {
            let theirs = &client.hello_result.build;
            eprintln!("facade: Facade {ours} could not take over from {theirs}: {error:#}");
            Ok(None)
        }
    }
}

/// Waits, after a handover began, for the daemon of this build, and says on one line how it went.
/// A command goes on with the older build if it answers again.
fn follow_takeover(
    identity: &Identity,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
    ours: &str,
    (asked, handed): (Instant, UpgradeResult),
) -> Result<DaemonClient, ConnectFailure> {
    let timeout = takeover_timeout();
    match reach(identity, cancelled, opening, timeout) {
        Ok(client) if client.hello_result.build == ours => {
            eprintln!(
                "facade: Facade {ours} took over from {}; {} kept running ({:.1} s)",
                handed.from,
                facade_base::daemon::agents_word(handed.agents),
                asked.elapsed().as_secs_f64()
            );
            Ok(client)
        }
        Ok(client) => {
            let logs = logs_folder().map(|logs| logs.display().to_string());
            eprintln!(
                "facade: Facade {ours} could not take over. Build {} is running. See {}",
                client.hello_result.build,
                logs.unwrap_or_default()
            );
            Ok(client)
        }
        Err(ConnectFailure::Timeout(error)) => {
            let error = error.context(format!(
                "Facade {ours} did not answer within {} seconds of taking over",
                timeout.as_secs()
            ));
            Err(ConnectFailure::Timeout(error))
        }
        Err(failure) => Err(failure),
    }
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

/// The folder of Facade's logs, which an error that Facade did not start points to.
fn logs_folder() -> anyhow::Result<PathBuf> {
    Ok(facade_base::paths::core_dir()?.join("logs"))
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
            Some(Report::Failed(why)) => Err(permanent(anyhow::anyhow!(why))),
            Some(Report::Silent) => Err(permanent(anyhow::anyhow!(silent_keeper(logs)))),
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
fn silent_keeper(logs: &Path) -> String {
    let log = logs.join("keeper.log");
    let last = std::fs::read_to_string(&log).ok().and_then(|text| {
        let line = text.lines().rev().find(|line| !line.trim().is_empty())?;
        Some(line.trim().to_string())
    });
    match last {
        Some(line) => format!(
            "the Facade keeper exited before it started, saying: {line}; see {}",
            log.display()
        ),
        None => format!(
            "the Facade keeper exited before it started and logged nothing; see {}",
            logs.display()
        ),
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

/// Reaches the daemon within `timeout`. While nothing answers, it starts a keeper,
/// which starts the daemon, only where nothing holds the daemon lock and no keeper runs: a daemon
/// that holds the lock may be recovering, and a keeper that runs starts its own daemon.
fn reach(
    identity: &Identity,
    cancelled: &dyn Fn() -> bool,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
    timeout: Duration,
) -> Result<DaemonClient, ConnectFailure> {
    let home = service::create_private_home().map_err(permanent)?;
    let logs = home.join("logs");
    let socket = facade_base::paths::daemon_socket().map_err(permanent)?;
    let deadline = Instant::now() + timeout;
    let mut keeper = StartedKeeper::default();
    loop {
        if cancelled() {
            return Err(ConnectFailure::Cancelled);
        }
        if let Some(client) =
            DaemonClient::connect(&socket, identity, deadline, opening).map_err(permanent)?
        {
            return Ok(client);
        }
        keeper.check(&logs)?;
        let daemon_runs = service::live_holder(&home, Service::Daemon)
            .map_err(permanent)?
            .is_some();
        if !daemon_runs
            && keeper.0.is_none()
            && service::live_holder(&home, Service::Keeper)
                .map_err(permanent)?
                .is_none()
        {
            keeper.start().map_err(permanent)?;
        }
        if Instant::now() >= deadline {
            let why = if daemon_runs {
                anyhow::anyhow!("Facade is still starting; see {}", logs.display())
            } else {
                anyhow::anyhow!(
                    "the Facade daemon did not start within {} seconds; see {}",
                    timeout.as_secs(),
                    logs.display()
                )
            };
            return Err(ConnectFailure::Timeout(why));
        }
        std::thread::sleep(RETRY_INTERVAL);
    }
}

/// `facade daemon --detach`: starts Facade in the background for an editor or another program, the
/// way a command reaches it. A daemon still starting after 10 seconds counts as started, with its
/// note on standard error; a failure to start is returned at once. The caller confirms with hello.
pub(super) fn detach() -> anyhow::Result<i32> {
    match first_connection(&identity_for(terminal_agent(), true)) {
        Err(ConnectFailure::Timeout(still)) => eprintln!("facade: {still:#}"),
        Err(failure) => return Err(failure.into()),
        Ok(_) => {}
    }
    Ok(0)
}
