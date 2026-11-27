//! The keeper and the daemon, as services of a Facade home.
//!
//! **The lock.** Before a service opens its store or sockets, it checks that the home is this
//! user's and takes its lock, `framework/keeper.lock` or `framework/daemon.lock`, until it exits. It writes who it
//! is, `{"pid":…,"birth":"…"}`, into the lock file, which is never replaced; that record is how
//! the other service, and its clients, know it. A process that cannot take the lock leaves the
//! holder's record, store and sockets as they are.
//!
//! **The start.** A service is started detached from its caller, reading nothing and writing to
//! its log: on Unix in a session of its own; on Windows without a console or window. It holds no
//! handle or descriptor it inherited but its startup channel and its log, and tells on that
//! channel, once, how its start went: it started, another process holds the lock, or it failed and
//! why. On Unix the lock is `flock`'s, on Windows `LockFileEx`'s.

use std::fs::{File, OpenOptions};
use std::io::{self, PipeReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::fs::{DirBuilder, Permissions};
#[cfg(unix)]
use std::io::PipeWriter;
#[cfg(unix)]
use std::os::fd::{AsFd, AsRawFd, FromRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::process::{Child, Command, Stdio};

#[cfg(unix)]
use nix::errno::Errno;
#[cfg(unix)]
use nix::fcntl::{FcntlArg, FdFlag, Flock, FlockArg};

use super::socket_paths::ClientSocket;
#[cfg(unix)]
use super::startup::{self, Attempt};
use super::unix_process::{Presence, presence};
#[cfg(unix)]
use super::unix_process::{birth, fork_lock, own_identity};
use crate::process::{ProcessExit, ProcessIdentity};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;
#[cfg(windows)]
use windows::{Child, readable_by, stop_self};

/// The environment variable that names a started service's startup channel.
const STARTUP_CHANNEL: &str = "FACADE_STARTUP_CHANNEL";

/// The user this process runs as.
#[cfg(unix)]
fn this_user() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

// The services and their home.

/// A Facade home's two services.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Service {
    Keeper,
    Daemon,
}

impl Service {
    /// Its `facade` command, its lock file in `framework/`, and its log in `framework/logs/`.
    fn names(self) -> [&'static str; 3] {
        match self {
            Service::Keeper => ["keeper", "keeper.lock", "keeper.log"],
            Service::Daemon => ["daemon", "daemon.lock", "daemon.log"],
        }
    }

    /// The `facade` command that runs the service.
    pub fn command(self) -> &'static str {
        self.names()[0]
    }

    /// The service's lock file in `framework/`.
    pub fn lock_name(self) -> &'static str {
        self.names()[1]
    }

    fn log_name(self) -> &'static str {
        self.names()[2]
    }
}

/// Makes the home and its `framework/` and `framework/logs/` where they are missing, checks that they are
/// this user's before anything in them is trusted, makes `framework/` and `framework/logs/` this user's
/// alone, and returns `framework/`. The home's own mode is the person's to choose: a home its group may
/// write, as a umask of 002 makes it, is used as it is. The person may choose the home through a
/// symbolic link: what it leads to is checked.
#[cfg(unix)]
pub fn create_private_home() -> anyhow::Result<PathBuf> {
    let home = crate::paths::facade_home()?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&home)?;
    refuse_unless_ours(&home.canonicalize()?)?;
    let framework = home.join("framework");
    make_private_dir(&framework)?;
    make_private_dir(&framework.join("logs"))?;
    Ok(framework)
}

/// Makes `dir` where it is missing, checks it is this user's, and makes it this user's alone.
#[cfg(unix)]
fn make_private_dir(dir: &Path) -> anyhow::Result<()> {
    if let Err(err) = DirBuilder::new().mode(0o700).create(dir)
        && err.kind() != io::ErrorKind::AlreadyExists
    {
        return Err(err.into());
    }
    refuse_unless_ours(dir)?;
    std::fs::set_permissions(dir, Permissions::from_mode(0o700))?;
    Ok(())
}

/// Refuses `dir` unless it is a folder of this user's.
#[cfg(unix)]
fn refuse_unless_ours(dir: &Path) -> anyhow::Result<()> {
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.uid() != this_user() {
        anyhow::bail!(
            "cannot use {}: it is not a directory owned by this user",
            dir.display()
        );
    }
    Ok(())
}

// The lock each service holds.

/// What came of trying to take a service's lock.
pub enum Locked {
    /// This process holds the lock, with its identity in the lock file, until it exits.
    Held,
    /// Another process holds the lock.
    Contended,
}

/// A service's lock file, opened only as a regular file of this user's: never through a symbolic
/// link, and never waiting on a FIFO.
#[cfg(unix)]
struct LockFile(PathBuf);

#[cfg(unix)]
impl LockFile {
    fn of(framework: &Path, service: Service) -> LockFile {
        LockFile(framework.join(service.lock_name()))
    }

    fn open(&self, options: &mut OpenOptions) -> io::Result<File> {
        let refused = || {
            let why = format!(
                "cannot use {}: it is not a regular file owned by this user",
                self.0.display()
            );
            io::Error::new(io::ErrorKind::PermissionDenied, why)
        };
        let not_ours = |meta: &std::fs::Metadata| !meta.is_file() || meta.uid() != this_user();
        let opened = options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.0);
        let file = match opened {
            Ok(file) => file,
            Err(err) if err.raw_os_error() == Some(libc::ELOOP) => return Err(refused()),
            Err(err) => {
                let there = std::fs::symlink_metadata(&self.0);
                return Err(if there.is_ok_and(|meta| not_ours(&meta)) {
                    refused()
                } else {
                    err
                });
            }
        };
        if not_ours(&file.metadata()?) {
            return Err(refused());
        }
        Ok(file)
    }

    /// Takes the lock without waiting, making the file where it is missing and never emptying it.
    /// None where another process holds it. A failure says the lock was taken to `doing`.
    fn try_lock(&self, doing: &str) -> anyhow::Result<Option<Flock<File>>> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600);
        let file = self.open(&mut options)?;
        let lock = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => lock,
            Err((_, Errno::EWOULDBLOCK)) => return Ok(None),
            Err((_, err)) => anyhow::bail!("could not {doing} {}: {err}", self.0.display()),
        };
        lock.set_permissions(Permissions::from_mode(0o600))?;
        Ok(Some(lock))
    }

    /// The identity written in the file; None where the file is missing, empty or incomplete.
    fn record(&self) -> io::Result<Option<ProcessIdentity>> {
        let mut file = match self.open(OpenOptions::new().read(true)) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            opened => opened?,
        };
        let mut text = Vec::new();
        file.read_to_end(&mut text)?;
        Ok(serde_json::from_slice(&text).ok())
    }
}

/// Takes `service`'s lock without waiting. Where this process gets it, writes this process's
/// identity into the lock file as one JSON line, and holds the lock until this process exits.
#[cfg(unix)]
pub fn lock_home(framework: &Path, service: Service) -> anyhow::Result<Locked> {
    let Some(mut lock) = LockFile::of(framework, service).try_lock("lock")? else {
        return Ok(Locked::Contended);
    };
    let mut record = serde_json::to_vec(&own_identity()?)?;
    record.push(b'\n');
    lock.set_len(0)?;
    lock.write_all(&record)?;
    lock.sync_data()?;
    // Never let go here: the system lets go of the lock when this process ends, after every task
    // that writes the home's files.
    std::mem::forget(lock);
    Ok(Locked::Held)
}

/// The identity in `service`'s lock file; None where the file is missing, empty or incomplete.
#[cfg(unix)]
pub fn lock_record(framework: &Path, service: Service) -> io::Result<Option<ProcessIdentity>> {
    LockFile::of(framework, service).record()
}

/// The process in `service`'s lock file, unless it has surely ended: a check that tells nothing
/// keeps it.
pub fn live_holder(framework: &Path, service: Service) -> io::Result<Option<ProcessIdentity>> {
    let ended = |holder: &ProcessIdentity| matches!(presence(holder), Ok(Presence::Ended));
    Ok(lock_record(framework, service)?.filter(|holder| !ended(holder)))
}

/// Finds the socket named by a live daemon whose home has the same path components as `home`.
/// The caller authenticates the connection against the returned lock holder before using it.
pub fn alternate_daemon_socket(home: &Path) -> anyhow::Result<Option<(PathBuf, ProcessIdentity)>> {
    let Some((running_home, holder)) = running_daemon_home(home)? else {
        return Ok(None);
    };
    if running_home == home && running_home.as_os_str() != home.as_os_str() {
        let socket = crate::paths::daemon_socket_for(&running_home)?;
        Ok(Some((socket, holder)))
    } else {
        Ok(None)
    }
}

/// The home spelling in the environment of the identified daemon that holds this home's lock.
pub(crate) fn running_daemon_home(home: &Path) -> io::Result<Option<(PathBuf, ProcessIdentity)>> {
    let Some(holder) = live_holder(&home.join("framework"), Service::Daemon)? else {
        return Ok(None);
    };
    let Some(environment) = super::unix_process::environment(&holder).ok().flatten() else {
        return Ok(None);
    };
    let Ok(running_home) =
        crate::paths::home_from(|name| super::system::env_var(&environment, name).map(Into::into))
    else {
        return Ok(None);
    };
    Ok(Some((running_home, holder)))
}

/// At the daemon's start, while the keeper's lock file names no keeper: the keeper's lock, where no
/// process holds it. The daemon keeps it through its recovery, so that no keeper starts meanwhile.
/// None where another process holds it.
#[cfg(unix)]
pub fn lock_keeper_if_unowned(framework: &Path) -> anyhow::Result<Option<Flock<File>>> {
    LockFile::of(framework, Service::Keeper).try_lock("check")
}

/// Checks that the process at the other end of `stream` is this user's and holds `service`'s
/// lock, by its process ID and birth value. Returns its identity, or why it is not that process.
#[cfg(unix)]
pub fn authenticate(
    stream: &impl AsFd,
    framework: &Path,
    service: Service,
) -> Result<ProcessIdentity, String> {
    let Peer { pid, uid } =
        peer(stream).map_err(|err| format!("could not identify the peer: {err}"))?;
    if uid != this_user() {
        return Err(format!("process {pid} belongs to another user"));
    }
    let holder = lock_record(framework, service).map_err(|err| err.to_string())?;
    let holds = |holder: &ProcessIdentity| {
        holder.pid == pid && birth(pid).ok().flatten().as_ref() == Some(&holder.birth)
    };
    match holder {
        Some(holder) if holds(&holder) => Ok(holder),
        _ => Err(format!(
            "process {pid} does not hold {}",
            service.lock_name()
        )),
    }
}

/// The process at the other end of a Unix socket, as the kernel tells it.
#[derive(Clone, Copy, Debug)]
#[cfg(unix)]
pub struct Peer {
    pub uid: u32,
    pub pid: u32,
}

/// The user and process at the other end of `stream`, from the kernel.
#[cfg(unix)]
pub fn peer(stream: &impl AsFd) -> io::Result<Peer> {
    use nix::sys::socket::getsockopt;
    #[cfg(target_os = "linux")]
    let (uid, pid) = {
        let credentials = getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)?;
        (credentials.uid(), credentials.pid())
    };
    #[cfg(target_os = "macos")]
    let (uid, pid) = {
        let (user, _) = nix::unistd::getpeereid(stream.as_fd())?;
        let pid = getsockopt(stream, nix::sys::socket::sockopt::LocalPeerPid)?;
        (user.as_raw(), pid)
    };
    Ok(Peer {
        uid,
        pid: pid as u32,
    })
}

/// Points this process's standard error at `file`, appended to and made, private, where it is
/// missing: where a service whose log file was replaced writes from then on. Blocks while it
/// opens the file.
#[cfg(unix)]
pub fn redirect_stderr(file: &Path) -> io::Result<()> {
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(file)?;
    nix::unistd::dup2_stderr(&log)?;
    Ok(())
}

// Starting a service.

/// Starts `program`, a `facade`, as `program <service> <words>`: under the fork lock, in a session
/// of its own, reading /dev/null, its output appended to its log, with a startup channel.
#[cfg(unix)]
pub fn launch(service: Service, program: &Path, words: &[&str]) -> anyhow::Result<Candidate> {
    launch_with_startup(service, program, words, None, None)
}

#[cfg(unix)]
pub fn launch_with_startup(
    service: Service,
    program: &Path,
    words: &[&str],
    attempt: Option<&Attempt>,
    lease: Option<&File>,
) -> anyhow::Result<Candidate> {
    let log_path = create_private_home()?.join("logs").join(service.log_name());
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(log_path)?;
    let _forks = fork_lock();
    let (channel, their_end) = std::io::pipe()?;
    let mut command = service_command(service, program, words, &their_end, log, attempt, lease)?;
    let child = command.spawn()?;
    drop(their_end);
    Ok(Candidate {
        child,
        report: StartupReport {
            channel: Some(channel),
            received: Vec::new(),
        },
    })
}

/// The command that starts `service`, given `channel` to report on and `log` for its output.
#[cfg(unix)]
fn service_command(
    service: Service,
    program: &Path,
    words: &[&str],
    channel: &PipeWriter,
    log: File,
    attempt: Option<&Attempt>,
    lease: Option<&File>,
) -> io::Result<Command> {
    let channel = channel.as_raw_fd();
    let lease = lease.map(AsRawFd::as_raw_fd);
    let mut command = Command::new(program);
    command.arg(service.command()).args(words);
    command.env(STARTUP_CHANNEL, channel.to_string());
    command
        .env_remove(startup::GENERATION_ENV)
        .env_remove(startup::LEASE_ENV);
    if let Some(attempt) = attempt {
        command.env(startup::GENERATION_ENV, attempt.generation());
    }
    if let Some(fd) = lease {
        command.env(startup::LEASE_ENV, fd.to_string());
    }
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: setsid and fcntl are async-signal-safe and change only the new process.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0
                || libc::fcntl(channel, libc::F_SETFD, 0) < 0
                || lease.is_some_and(|fd| libc::fcntl(fd, libc::F_SETFD, 0) < 0)
            {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    Ok(command)
}

/// What a started service reported on its startup channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Report {
    /// It holds its lock and started.
    Started,
    /// Another process holds the lock; it exits having changed nothing.
    Contention,
    /// It could not start, for the reason given.
    Failed(String),
    /// It exited without a report.
    Silent,
}

impl Report {
    /// The report a line on the channel gives.
    fn of_line(line: &str) -> Report {
        match line {
            "started" => Report::Started,
            "contention" => Report::Contention,
            _ => Report::Failed(line.strip_prefix("failed ").unwrap_or(line).to_string()),
        }
    }
}

/// A service started in the background, until it reports.
pub struct Candidate {
    child: Child,
    report: StartupReport,
}

/// The report on a created service's own startup channel.
pub struct StartupReport {
    /// The startup channel, until the report.
    channel: Option<PipeReader>,
    /// What came on it so far.
    received: Vec<u8>,
}

impl Candidate {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn report(&mut self, timeout: Duration) -> Option<Report> {
        self.report.read(timeout)
    }

    /// The process and its report may be watched independently.
    pub fn into_parts(self) -> (ServiceProcess, StartupReport) {
        (ServiceProcess(self.child), self.report)
    }

    pub fn into_process(self) -> ServiceProcess {
        ServiceProcess(self.child)
    }

    #[cfg(unix)]
    pub fn into_child(self) -> Child {
        self.child
    }
}

impl StartupReport {
    /// The report once it arrives, or none if it has not yet arrived or was already taken.
    pub fn read(&mut self, timeout: Duration) -> Option<Report> {
        let mut channel = self.channel.take()?;
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(newline) = self.received.iter().position(|&byte| byte == b'\n') {
                return Some(Report::of_line(&String::from_utf8_lossy(
                    &self.received[..newline],
                )));
            }
            match readable_by(&channel, deadline) {
                Ok(true) => {}
                Ok(false) => {
                    self.channel = Some(channel);
                    return None;
                }
                Err(_) => return Some(Report::Silent),
            }
            let mut chunk = [0u8; 4096];
            match channel.read(&mut chunk) {
                Ok(0) => return Some(Report::Silent),
                Ok(read) => self.received.extend_from_slice(&chunk[..read]),
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return Some(Report::Silent),
            }
        }
    }
}

/// Whether `channel` has something to read, or has ended, before `deadline`.
#[cfg(unix)]
fn readable_by(channel: &PipeReader, deadline: Instant) -> io::Result<bool> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let mut wanted = libc::pollfd {
            fd: channel.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let millis = left.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: one valid pollfd for the duration of the call.
        match Errno::result(unsafe { libc::poll(&mut wanted, 1, millis) }) {
            Ok(ready) => return Ok(ready > 0),
            Err(Errno::EINTR) => {}
            Err(err) => return Err(err.into()),
        }
    }
}

/// A started service's startup channel.
pub struct StartupChannel(File);

impl StartupChannel {
    /// The startup channel the environment names, where this process was started with one. Call it
    /// before any thread starts.
    #[cfg(unix)]
    pub fn take() -> Option<StartupChannel> {
        let named = std::env::var(STARTUP_CHANNEL).ok()?;
        let fd = named.parse::<RawFd>().ok().filter(|&fd| fd > 2)?;
        // SAFETY: fcntl only reads the descriptor's flags; it fails for one that is not open.
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
            return None;
        }
        // SAFETY: the starting process passed this open descriptor for this process alone; nothing
        // else in it owns the descriptor.
        let channel = unsafe { File::from_raw_fd(fd) };
        let _ = nix::fcntl::fcntl(&channel, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC));
        Some(StartupChannel(channel))
    }

    #[cfg(unix)]
    pub fn raw_fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }

    pub fn started(self) {
        self.tell("started");
    }

    pub fn contention(self) {
        self.tell("contention");
    }

    /// Reports a failure, which the starting command prints, as one line.
    pub fn failed(self, message: &str) {
        let message = message.replace('\n', " ");
        self.tell(&format!("failed {message}"));
    }

    /// Writes `line`. Where the starting command is gone, there is no one to tell.
    fn tell(mut self, line: &str) {
        let _ = writeln!(self.0, "{line}");
    }
}

/// When to start a service again, shared by both services. Losing the lock to another process
/// leaves it as it is; a minute of healthy running starts it over.
#[derive(Clone, Debug)]
pub struct RestartBackoff {
    pub delay: Duration,
    pub at: Option<Instant>,
}

impl RestartBackoff {
    pub const FIRST_DELAY: Duration = Duration::from_millis(500);
    pub const MAX_DELAY: Duration = Duration::from_secs(30);
    /// How long a service runs before its delay starts over.
    pub const HEALTHY_AFTER: Duration = Duration::from_secs(60);
    /// How long a start waits for the service's report.
    pub const STARTUP_REPORT_TIMEOUT: Duration = Duration::from_secs(10);
    /// How long a check that a service ended waits.
    pub const END_CHECK_TIMEOUT: Duration = Duration::from_millis(500);

    /// Sets the next start at `now` plus the delay, and returns that delay; each one doubles the
    /// next, up to [`Self::MAX_DELAY`].
    pub fn schedule(&mut self, now: Instant) -> Duration {
        let next = (self.delay * 2).min(Self::MAX_DELAY);
        let delay = std::mem::replace(&mut self.delay, next);
        self.at = Some(now + delay);
        delay
    }

    /// Starts the delay over where the service has run since `since` for
    /// [`Self::HEALTHY_AFTER`].
    pub fn healthy(&mut self, since: Instant, now: Instant) {
        if now.saturating_duration_since(since) < Self::HEALTHY_AFTER {
            return;
        }
        self.delay = Self::FIRST_DELAY;
    }
}

impl Default for RestartBackoff {
    fn default() -> RestartBackoff {
        RestartBackoff {
            delay: RestartBackoff::FIRST_DELAY,
            at: None,
        }
    }
}

// The descriptors a service starts with.

/// Closes the descriptors this process inherited above standard error, but those in `keep`, before
/// they can pass to another process.
#[cfg(unix)]
pub fn close_inherited_fds(keep: &[RawFd]) -> io::Result<()> {
    if cfg!(debug_assertions) && test_file("fail-fd-enumeration").is_some_and(|file| file.exists())
    {
        return Err(io::Error::other(
            "could not enumerate inherited descriptors",
        ));
    }
    let inherited = open_fds()?
        .into_iter()
        .filter(|fd| *fd > 2 && !keep.contains(fd));
    for fd in inherited {
        // SAFETY: this runs at startup, before any thread, and no Rust value owns an inherited
        // descriptor. The listing's own descriptor is closed already, and closing its number again
        // fails harmlessly, as nothing opened in between.
        let closed = Errno::result(unsafe { libc::close(fd) });
        if let Err(err) = closed
            && err != Errno::EBADF
        {
            return Err(err.into());
        }
    }
    Ok(())
}

/// The descriptors open in this process, as the system lists them. The listing's own descriptor is
/// among them, closed by the time they are returned.
#[cfg(unix)]
pub fn open_fds() -> io::Result<Vec<RawFd>> {
    let listing = if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    };
    let number = |entry: std::fs::DirEntry| entry.file_name().to_str()?.parse().ok();
    let entries = std::fs::read_dir(listing)?;
    entries
        .map(|entry| entry.map(number))
        .filter_map(Result::transpose)
        .collect()
}

// Points a scenario test stops or marks a service at, in a debug build.

/// `framework/<name>`, where there is a home.
fn test_file(name: &str) -> Option<PathBuf> {
    Some(crate::paths::framework_dir().ok()?.join(name))
}

/// Makes the file `framework/<marker>`, and returns `framework/` where this call made it first.
fn first_to_reach(marker: &str) -> Option<PathBuf> {
    let path = test_file(marker)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()?;
    path.parent().map(Path::to_path_buf)
}

/// In a debug build, stops this process the first time it reaches `point` in this
/// home, where `FACADE_TEST_PAUSE_AT` names that point. A scenario test stops a service at an exact
/// step this way; the file `framework/paused-at-<point>` shows it got there.
pub fn pause_for_test(point: &str) {
    let wanted = || std::env::var_os("FACADE_TEST_PAUSE_AT").is_some_and(|at| at == point);
    if cfg!(debug_assertions) && wanted() && first_to_reach(&format!("paused-at-{point}")).is_some()
    {
        stop_self();
    }
}

/// In a debug build where `FACADE_TEST_GATES` is set, marks that this process reached `point`, by
/// the file `framework/reached-<point>`, and goes on.
pub fn mark_for_test(point: &str) {
    if !cfg!(debug_assertions) || std::env::var_os("FACADE_TEST_GATES").is_none() {
        return;
    }
    if let Some(marker) = test_file(&format!("reached-{point}")) {
        let _ = File::create(marker);
    }
}

/// In a debug build where `FACADE_TEST_GATES` lists `point`, holds the calling thread the first
/// time it reaches it, marked by `framework/reached-<point>`, until the test makes
/// `framework/release-<point>`.
pub fn gate_for_test(point: &str) {
    let listed = || {
        let gates = std::env::var("FACADE_TEST_GATES");
        gates.is_ok_and(|gates| gates.split(',').any(|gate| gate == point))
    };
    if !cfg!(debug_assertions) || !listed() {
        return;
    }
    let Some(framework) = first_to_reach(&format!("reached-{point}")) else {
        return;
    };
    let release = framework.join(format!("release-{point}"));
    while !release.exists() {
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Stops this process, as a debugger or SIGSTOP would, until a test lets it go on.
#[cfg(unix)]
fn stop_self() {
    let _ = nix::sys::signal::raise(nix::sys::signal::Signal::SIGSTOP);
}

// A started service's process.

/// A started service's process, until it ends.
pub struct ServiceProcess(Child);

impl ServiceProcess {
    pub fn pid(&self) -> u32 {
        self.0.id()
    }

    /// Its exit, where it has ended, without waiting.
    pub fn try_wait(&mut self) -> io::Result<Option<ProcessExit>> {
        Ok(self.0.try_wait()?.map(exit_of))
    }

    /// Waits for it to end, and returns its exit.
    pub fn wait(mut self) -> io::Result<ProcessExit> {
        self.0.wait().map(exit_of)
    }

    /// Lets the service keep running. Unix waits for its exit in the background and Windows
    /// releases the process handle immediately.
    pub fn reap_in_background(self) {
        #[cfg(unix)]
        std::thread::spawn(move || self.wait());
        #[cfg(windows)]
        drop(self);
    }
}

/// The process's handle, which a wait can use.
#[cfg(windows)]
impl std::os::windows::io::AsHandle for ServiceProcess {
    fn as_handle(&self) -> std::os::windows::io::BorrowedHandle<'_> {
        self.0.as_handle()
    }
}

/// The exit `status` tells, at this moment: by its code, or on Unix by its signal.
fn exit_of(status: std::process::ExitStatus) -> ProcessExit {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|number| {
            nix::sys::signal::Signal::try_from(number).map_or_else(
                |_| format!("signal {number}"),
                |signal| signal.as_str().to_string(),
            )
        })
    };
    #[cfg(windows)]
    let signal = None;
    ProcessExit {
        code: status.code(),
        signal,
        reason: None,
        at: crate::time::iso_now(),
    }
}

// What a service does as it starts and ends.

/// Lets go of what this process inherited from the one that started it, but `keep`, before any of
/// it can pass to another process: Unix closes every descriptor above standard error; Windows does
/// nothing, as a service inherits only what [`launch`] chose.
pub fn close_inherited(keep: Option<&StartupChannel>, lease: Option<&File>) -> io::Result<()> {
    #[cfg(unix)]
    return close_inherited_fds(
        &keep
            .map(StartupChannel::raw_fd)
            .into_iter()
            .chain(lease.map(AsRawFd::as_raw_fd))
            .collect::<Vec<_>>(),
    );
    #[cfg(windows)]
    {
        let _ = (keep, lease);
        Ok(())
    }
}

/// Takes the launcher's reservation reference before the keeper closes other inherited files.
#[cfg(unix)]
pub fn take_startup_lease() -> Option<File> {
    let value = std::env::var(startup::LEASE_ENV).ok()?;
    if std::env::var(STARTUP_CHANNEL).is_ok_and(|channel| channel == value) {
        return None;
    }
    let fd = value.parse::<RawFd>().ok().filter(|&fd| fd > 2)?;
    // SAFETY: fcntl checks the inherited descriptor before it is taken.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return None;
    }
    // SAFETY: the launcher gave the child this descriptor alone as its startup reference.
    Some(unsafe { File::from_raw_fd(fd) })
}

/// Checks that the process serving `socket` is this user's and holds `service`'s lock, by its
/// process ID and birth value. Returns its identity, or why it is not that process.
pub fn authenticate_server(
    socket: &ClientSocket,
    framework: &Path,
    service: Service,
) -> Result<ProcessIdentity, String> {
    #[cfg(unix)]
    return authenticate(socket, framework, service);
    #[cfg(windows)]
    windows::server_identity(socket, framework, service)
}

/// Returns once this process is asked to end: Unix by SIGTERM or SIGINT. On Windows a service runs
/// without a console, so nothing asks it and this never returns.
pub async fn termination_requested() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut terminate), Ok(mut interrupt)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    }
    #[cfg(windows)]
    std::future::pending::<()>().await;
}

/// Lets a write to output that closed early end this command, as a Unix command's does: Unix puts
/// SIGPIPE's action back to its default; Windows does nothing. Call it before any thread starts.
pub fn default_broken_pipe() {
    #[cfg(unix)]
    // SAFETY: called before any thread starts; it only puts SIGPIPE's default action back.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_folder::TestFolder;

    fn framework(test: &str) -> TestFolder {
        TestFolder::new(&format!("service-{test}"))
    }

    #[test]
    fn a_released_service_is_reaped_after_it_exits() {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        let mut child = Command::new("sh")
            .args(["-c", "read line"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let pid = Pid::from_raw(child.id() as i32);
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                ServiceProcess(child).reap_in_background();
                sent.send(()).unwrap();
            });
            let released = received.recv_timeout(Duration::from_secs(10));
            let running = kill(pid, None);
            drop(input);
            assert!(released.is_ok(), "releasing the running child returned");
            assert!(running.is_ok(), "releasing did not kill it");
        });
        let limit = Instant::now() + Duration::from_secs(10);
        while kill(pid, None) != Err(Errno::ESRCH) {
            assert!(Instant::now() < limit, "the exited child was reaped");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_lock_holder_records_its_identity_and_the_file_is_never_replaced() {
        let framework = framework("lock");
        std::fs::write(framework.join("daemon.lock"), "").unwrap();
        let inode = std::fs::metadata(framework.join("daemon.lock"))
            .unwrap()
            .ino();
        assert_eq!(
            lock_record(&framework, Service::Daemon).unwrap(),
            None,
            "an empty record is no record"
        );
        assert!(matches!(
            lock_home(&framework, Service::Daemon).unwrap(),
            Locked::Held
        ));
        assert_eq!(
            lock_record(&framework, Service::Daemon).unwrap(),
            Some(super::super::unix_process::own_identity().unwrap())
        );
        assert_eq!(
            live_holder(&framework, Service::Daemon).unwrap(),
            lock_record(&framework, Service::Daemon).unwrap()
        );
        assert_eq!(
            std::fs::metadata(framework.join("daemon.lock"))
                .unwrap()
                .ino(),
            inode,
            "the lock file keeps its inode"
        );
    }

    #[test]
    fn an_unowned_keeper_lock_can_be_held_and_an_owned_one_cannot() {
        let framework = framework("unowned");
        let held = lock_keeper_if_unowned(&framework)
            .unwrap()
            .expect("no keeper holds the lock");
        assert!(
            lock_keeper_if_unowned(&framework).unwrap().is_none(),
            "a held lock is not unowned"
        );
        drop(held);
        assert!(lock_keeper_if_unowned(&framework).unwrap().is_some());
    }

    #[test]
    fn a_peer_is_this_user_s_process_holding_the_lock() {
        let framework = framework("peer");
        let (ours, theirs) = std::os::unix::net::UnixStream::pair().unwrap();
        assert!(
            authenticate(&ours, &framework, Service::Keeper).is_err(),
            "no record names the peer"
        );
        assert!(matches!(
            lock_home(&framework, Service::Keeper).unwrap(),
            Locked::Held
        ));
        let me = super::super::unix_process::own_identity().unwrap();
        assert_eq!(
            authenticate(&ours, &framework, Service::Keeper),
            Ok(me.clone())
        );
        std::fs::write(
            framework.join("keeper.lock"),
            serde_json::to_string(&ProcessIdentity {
                birth: "0".into(),
                ..me
            })
            .unwrap(),
        )
        .unwrap();
        assert!(
            authenticate(&theirs, &framework, Service::Keeper).is_err(),
            "a record with another birth names another process"
        );
    }
}
