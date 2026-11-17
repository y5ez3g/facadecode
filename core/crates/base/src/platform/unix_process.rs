//! Processes, as the keeper and the daemon see them.
//!
//! - **Who**: a process is its ID and its birth value, a [`ProcessIdentity`]. Where no process has
//!   the ID, or the one that has it was born at another moment, the process has ended.
//! - **Its exit**: a parent learns its child's exit from `waitid` or `waitpid`. For any other
//!   process, the system says when it ends: a Linux process descriptor, a macOS kqueue, or, on
//!   Linux without process descriptors, `/proc/<pid>/stat` read every 250 ms. Output ending on a
//!   PTY says nothing: a CLI may close its terminal and run on, and a descendant may keep it open.
//! - **Its group**: a group is signalled only while a process recorded in it shows it is the same
//!   group.

use std::collections::BTreeMap;
use std::io;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

#[cfg(unix)]
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};

#[cfg(unix)]
use nix::errno::Errno;
#[cfg(unix)]
use nix::sys::signal::Signal;
#[cfg(unix)]
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
#[cfg(unix)]
use nix::unistd::Pid;

#[cfg(unix)]
use crate::process::ProcessExit;
use crate::process::ProcessIdentity;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use super::io_thread::WaitPacket;
#[cfg(windows)]
use windows as os;
#[cfg(windows)]
pub use windows::{birth, monotonic_now, presence};

// The exits of this process's children.

/// The exit `status` reports, where it reports one: by its code, or by its signal, named alike on
/// every system.
#[cfg(unix)]
pub fn exit_from_status(status: WaitStatus) -> Option<ProcessExit> {
    let (code, signal) = match status {
        WaitStatus::Exited(_, code) => (Some(code), None),
        WaitStatus::Signaled(_, signal, _) => (None, Some(signal.as_str().to_string())),
        _ => return None,
    };
    Some(exit_now(code, signal))
}

/// Reaps child `pid` where it has ended, and returns its exit. A failure, `ECHILD` for a process
/// that is not this process's child among them, is no exit.
#[cfg(unix)]
pub fn reap_child(pid: i32) -> Option<ProcessExit> {
    match waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG)) {
        Ok(status) => exit_from_status(status),
        Err(_) => None,
    }
}

/// Child `pid`'s exit, left unreaped, so that its process ID and group ID stay its own. A child
/// that stopped, went on or is traced has not exited, though macOS reports those too.
#[cfg(unix)]
pub fn peek_child_exit(pid: i32) -> Option<ProcessExit> {
    let info = waited_unreaped(pid)?;
    // SAFETY: waitid filled the status of the child it reported.
    let status = unsafe { info.si_status() };
    match info.si_code {
        libc::CLD_EXITED => Some(exit_now(Some(status), None)),
        libc::CLD_KILLED | libc::CLD_DUMPED => {
            let name = match Signal::try_from(status) {
                Ok(signal) => signal.as_str().to_string(),
                Err(_) => format!("signal {status}"),
            };
            Some(exit_now(None, Some(name)))
        }
        _ => None,
    }
}

/// What `waitid` reports of child `pid` without waiting or reaping it; None where it reports
/// nothing.
#[cfg(unix)]
fn waited_unreaped(pid: i32) -> Option<libc::siginfo_t> {
    // SAFETY: an all-zero siginfo_t is valid.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let options = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    // SAFETY: waitid writes within the siginfo_t it is given.
    let result = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, options) };
    // SAFETY: si_pid stays zero where waitid found no child to report.
    let reported = result == 0 && unsafe { info.si_pid() } != 0;
    reported.then_some(info)
}

/// An exit that happened now.
#[cfg(unix)]
fn exit_now(code: Option<i32>, signal: Option<String>) -> ProcessExit {
    let at = crate::time::iso_now();
    ProcessExit {
        code,
        signal,
        reason: None,
        at,
    }
}

// Deadlines, kept on the clock that does not jump.

/// Nanoseconds on this machine's `CLOCK_MONOTONIC`, the clock of stop deadlines.
#[cfg(unix)]
pub fn monotonic_now() -> u64 {
    // SAFETY: an all-zero timespec is valid.
    let mut now: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: clock_gettime writes one timespec, for a clock every supported system has.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) };
    let seconds = now.tv_sec as u64;
    seconds
        .saturating_mul(1_000_000_000)
        .saturating_add(now.tv_nsec as u64)
}

/// The moment `CLOCK_MONOTONIC` reads `at` nanoseconds; now, once it has.
pub fn instant_at(at: u64) -> Instant {
    let left = Duration::from_nanos(at.saturating_sub(monotonic_now()));
    Instant::now() + left
}

// Who a process is.

/// What the kernel says of a process.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg(unix)]
pub struct ProcessSnapshot {
    pub birth: String,
    /// Its process group.
    pub group: i32,
    /// Whether all of the process has ended and only its exit status is left; None where the
    /// kernel does not tell.
    pub exited: Option<bool>,
}

/// What the kernel says of process `pid`; None where no process has that ID.
#[cfg(unix)]
pub fn snapshot(pid: u32) -> io::Result<Option<ProcessSnapshot>> {
    os::snapshot(pid)
}

/// The birth value of process `pid`; None where no process has that ID.
#[cfg(unix)]
pub fn birth(pid: u32) -> io::Result<Option<String>> {
    snapshot(pid).map(|found| found.map(|found| found.birth))
}

/// This process's identity.
pub fn own_identity() -> io::Result<ProcessIdentity> {
    let pid = std::process::id();
    match birth(pid)? {
        Some(birth) => Ok(ProcessIdentity { pid, birth }),
        None => Err(io::Error::other("this process has no birth value")),
    }
}

/// Whether an identified process still runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    Running,
    Ended,
    /// The kernel did not say enough; check again later.
    Inconclusive,
}

/// Whether the process `identity` still runs. One the kernel no longer has, one born at another
/// moment, and one that exited all through have ended.
#[cfg(unix)]
pub fn presence(identity: &ProcessIdentity) -> io::Result<Presence> {
    let same = snapshot(identity.pid)?.filter(|found| found.birth == identity.birth);
    Ok(match same.map(|found| found.exited) {
        None | Some(Some(true)) => Presence::Ended,
        Some(Some(false)) => Presence::Running,
        Some(None) => Presence::Inconclusive,
    })
}

// Watching a process that is not this process's child until it ends.

/// How often `/proc/<pid>/stat` is read while a process is watched without a process descriptor.
pub const PROC_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// How the system lets a process be watched, or that it has ended already.
#[cfg(unix)]
enum Watch {
    Ended,
    /// A descriptor that becomes readable when the process ends.
    Event(OwnedFd),
    /// No descriptor: the process's record is read every [`PROC_POLL_INTERVAL`]. Only Linux,
    /// without process descriptors, watches so.
    #[cfg_attr(not(target_os = "linux"), expect(dead_code))]
    Proc,
}

/// Watches a process that is not this process's child until it ends. On Windows it holds the
/// process's handle, which also keeps its ID from passing to another process meanwhile.
pub struct ProcessObservation {
    identity: ProcessIdentity,
    #[cfg(unix)]
    exit_event: Option<OwnedFd>,
    #[cfg(windows)]
    process: std::os::windows::io::OwnedHandle,
}

/// What starting to watch a process found.
pub enum Observed {
    /// It had ended already.
    Ended,
    Watching(ProcessObservation),
}

impl ProcessObservation {
    /// Starts watching the process `identity`. One the kernel no longer has, or one born at another
    /// moment, has ended. A failure for permission or resources proves nothing; the caller tries
    /// again.
    #[cfg(unix)]
    pub fn open(identity: &ProcessIdentity) -> io::Result<Observed> {
        let exit_event = match os::watch(identity)? {
            Watch::Ended => return Ok(Observed::Ended),
            Watch::Event(event) => Some(event),
            Watch::Proc => None,
        };
        let identity = identity.clone();
        Ok(Observed::Watching(ProcessObservation {
            identity,
            exit_event,
        }))
    }

    pub fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }

    /// The descriptor that becomes readable when the process ends. None where there is none: then
    /// ask [`ProcessObservation::ended`] every [`PROC_POLL_INTERVAL`].
    #[cfg(unix)]
    pub fn descriptor(&self) -> Option<BorrowedFd<'_>> {
        self.exit_event.as_ref().map(AsFd::as_fd)
    }

    /// Whether the process has ended, without waiting; None where the kernel does not tell.
    #[cfg(unix)]
    pub fn ended(&self) -> io::Result<Option<bool>> {
        if let Some(event) = &self.exit_event {
            if readable(event.as_fd(), Duration::ZERO)? {
                return Ok(Some(true));
            }
            if os::NO_EVENT_MEANS_RUNNING {
                return Ok(Some(false));
            }
        }
        Ok(match presence(&self.identity)? {
            Presence::Ended => Some(true),
            Presence::Running => Some(false),
            Presence::Inconclusive => None,
        })
    }

    /// Waits up to `timeout` for the process to end, and returns whether it did.
    #[cfg(unix)]
    pub fn wait(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        while self.ended()? != Some(true) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(false);
            }
            let pause = left.min(PROC_POLL_INTERVAL);
            match &self.exit_event {
                Some(event) => drop(readable(event.as_fd(), pause)?),
                None => std::thread::sleep(pause),
            }
        }
        Ok(true)
    }

    /// Sends `signal` to the process, and returns false where it has ended. A Linux process
    /// descriptor reaches only this process; otherwise the birth value is checked right before the
    /// signal goes to the ID, which leaves a short moment in which the ID could pass to another.
    #[cfg(unix)]
    pub fn signal(&self, signal: Signal) -> io::Result<bool> {
        os::signal(self.descriptor(), &self.identity, signal)
    }
}

/// Waits up to `timeout` for the process `identity` to end, and returns whether it did.
pub fn wait_for_end(identity: &ProcessIdentity, timeout: Duration) -> io::Result<bool> {
    let Observed::Watching(observation) = ProcessObservation::open(identity)? else {
        return Ok(true);
    };
    observation.wait(timeout)
}

/// Sends `signal` to the ID of the process `identity` right after checking its birth value, and
/// returns false where it has ended.
#[cfg(unix)]
fn signal_checked(identity: &ProcessIdentity, signal: Signal) -> io::Result<bool> {
    if presence(identity)? == Presence::Ended {
        return Ok(false);
    }
    let pid = Pid::from_raw(identity.pid as i32);
    match nix::sys::signal::kill(pid, signal) {
        Err(Errno::ESRCH) => Ok(false),
        sent => sent.map(|()| true).map_err(io::Error::from),
    }
}

/// Whether `fd` becomes readable within `timeout`, waiting through interruptions.
#[cfg(unix)]
fn readable(fd: BorrowedFd<'_>, timeout: Duration) -> io::Result<bool> {
    use std::os::fd::AsRawFd;
    let mut wanted = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
    loop {
        // SAFETY: one valid pollfd for the duration of the call.
        let ready = unsafe { libc::poll(&mut wanted, 1, millis) };
        match Errno::result(ready) {
            Ok(ready) => return Ok(ready > 0),
            Err(Errno::EINTR) => {}
            Err(err) => return Err(err.into()),
        }
    }
}

// Process groups.

/// What came of signalling a process group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg(unix)]
pub enum GroupSignal {
    Sent,
    /// Neither the leader nor a recorded member showed the group is still the same; nothing was
    /// sent.
    Unverified,
    /// No process was left in the group.
    Ended,
}

/// The processes in process group `group`.
#[cfg(unix)]
pub fn group_members(group: i32) -> io::Result<Vec<ProcessIdentity>> {
    os::group_members(group)
}

/// The processes among `pids` that are in `group`, with their birth values.
#[cfg(unix)]
fn identities_in(group: i32, pids: impl Iterator<Item = u32>) -> Vec<ProcessIdentity> {
    let in_group = |pid: u32| {
        let found = snapshot(pid).ok().flatten()?;
        let birth = found.birth;
        (found.group == group).then_some(ProcessIdentity { pid, birth })
    };
    pids.filter_map(in_group).collect()
}

/// Shows that process group `group` is still the recorded one, by its `leader` or one of the
/// `members` recorded before, then adds the group's current processes to `members`. Returns whether
/// it was shown. A process that took a reused group ID cannot show the group itself.
#[cfg(unix)]
pub fn refresh_group_members(
    group: i32,
    leader: &ProcessIdentity,
    members: &mut Vec<ProcessIdentity>,
) -> io::Result<bool> {
    let mut unreadable = None;
    let proven = std::iter::once(leader)
        .chain(members.iter())
        .any(|witness| match proves(witness, group) {
            Ok(proves) => proves,
            Err(err) => {
                unreadable = Some(err);
                false
            }
        });
    if !proven {
        return unreadable.map_or(Ok(false), Err);
    }
    for member in group_members(group)? {
        if !members.contains(&member) {
            members.push(member);
        }
    }
    Ok(true)
}

/// Whether `witness` still runs in `group`, unreaped where it ended.
#[cfg(unix)]
fn proves(witness: &ProcessIdentity, group: i32) -> io::Result<bool> {
    if cfg!(debug_assertions) && proof_read_fails(witness.pid) {
        return Err(io::Error::other("the process identity could not be read"));
    }
    let found = snapshot(witness.pid)?;
    Ok(found.is_some_and(|found| found.birth == witness.birth && found.group == group))
}

/// In a test of a debug build: whether `core/fail-proof-read` names `pid`, and it is the first
/// read since, which removes it.
#[cfg(unix)]
fn proof_read_fails(pid: u32) -> bool {
    let Ok(core) = crate::paths::core_dir() else {
        return false;
    };
    let fault = core.join("fail-proof-read");
    let named = std::fs::read_to_string(&fault).is_ok_and(|text| text.trim() == pid.to_string());
    named && std::fs::remove_file(&fault).is_ok()
}

/// Sends `signal` to process group `group` only where its `leader`, unreaped if it ended, shows it
/// is the same group. The group can end, and its ID pass on, between the check and the signal; a
/// signal to a group's number cannot rule that out.
#[cfg(unix)]
pub fn signal_group(
    group: i32,
    leader: &ProcessIdentity,
    signal: Signal,
) -> io::Result<GroupSignal> {
    if !refresh_group_members(group, leader, &mut Vec::new())? {
        let anyone_left = !group_members(group)?.is_empty();
        return Ok(if anyone_left {
            GroupSignal::Unverified
        } else {
            GroupSignal::Ended
        });
    }
    let Err(refused) = nix::sys::signal::killpg(Pid::from_raw(group), signal) else {
        return Ok(GroupSignal::Sent);
    };
    match refused {
        Errno::ESRCH => Ok(GroupSignal::Ended),
        // macOS refuses a group whose one process is its leader still exiting, its cleanup held by
        // terminal output nobody read.
        Errno::EPERM if leader_exiting_alone(group, leader)? => Ok(GroupSignal::Ended),
        refused => Err(refused.into()),
    }
}

/// Whether `leader` is exiting and is the one process left in `group`.
#[cfg(unix)]
fn leader_exiting_alone(group: i32, leader: &ProcessIdentity) -> io::Result<bool> {
    if !os::leader_exiting(group, leader)? {
        return Ok(false);
    }
    let members = group_members(group)?;
    Ok(members.iter().all(|member| member == leader))
}

/// Logs, as `service`, what came of signalling the group of run `run`. A caller that keeps trying
/// until a deadline logs each stretch of failures once.
#[cfg(unix)]
pub fn log_group_signal(
    service: &str,
    run: &str,
    signal: Signal,
    result: &io::Result<GroupSignal>,
) {
    let signal = signal.as_str();
    let (level, message) = match result {
        Ok(GroupSignal::Ended) => return,
        Ok(GroupSignal::Sent) => (
            "info",
            format!("sent {signal} to the process group of run {run}"),
        ),
        Ok(GroupSignal::Unverified) => (
            "warn",
            format!(
                "run {run}: skipped {signal}; the process group identity could not be verified"
            ),
        ),
        Err(err) => ("warn", format!("run {run}: could not send {signal}: {err}")),
    };
    crate::log::write(service, level, &message);
}

// Where a process comes from.

/// The parent of process `pid`; None where no process has that ID.
pub fn parent(pid: u32) -> io::Result<Option<u32>> {
    os::parent(pid)
}

/// The name the system lists process `pid` under; None where no process has that ID.
pub fn name(pid: u32) -> io::Result<Option<String>> {
    os::name(pid)
}

/// The processes `pid` descends from, its parent first, up to and leaving out the system's first
/// process. The line stops early at a parent that ended meanwhile or cannot be read.
pub fn ancestors(pid: u32) -> Vec<u32> {
    let mut line = Vec::new();
    let mut at = pid;
    while let Ok(Some(up)) = parent(at)
        && up > 1
        && up != pid
        && !line.contains(&up)
    {
        line.push(up);
        at = up;
    }
    line
}

/// The process of the program that runs this one: its nearest ancestor that is not a shell, as a
/// CLI runs its hooks through `sh -c`. None where none that can be read is one.
pub fn calling_program() -> Option<u32> {
    calling_program_of(std::process::id())
}

/// The process of the program that runs process `pid`, as [`calling_program`] finds it.
pub fn calling_program_of(pid: u32) -> Option<u32> {
    let line = ancestors(pid).into_iter();
    nearest_program(line.map(|up| (up, name(up).ok().flatten())))
}

/// The first process of `line`, given with its name, whose name is known and is not a shell's:
/// a CLI runs its hooks through `sh -c` on Unix, and through Git Bash or `cmd.exe` on Windows.
fn nearest_program(line: impl IntoIterator<Item = (u32, Option<String>)>) -> Option<u32> {
    let is_program = |name: &str| !["sh", "bash", "zsh", "dash", "cmd"].contains(&name);
    for (pid, name) in line {
        if name.as_deref().is_some_and(is_program) {
            return Some(pid);
        }
    }
    None
}

// What a process started with.

/// The environment the process `identity` started with, by name, leaving out entries that are not
/// UTF-8 or have no name; None once no process has that identity. Only this user's processes can
/// be read: through `sysctl(KERN_PROCARGS2)` on macOS, `/proc/<pid>/environ` on Linux.
pub fn environment(identity: &ProcessIdentity) -> io::Result<Option<BTreeMap<String, String>>> {
    let entries = while_same(identity, || os::environment(identity.pid))?;
    Ok(entries.map(|entries| entries.into_iter().filter_map(variable).collect()))
}

/// Runs `read` where `identity` names one process before and after it, so that what it read is
/// that process's; None where it does not.
fn while_same<T>(
    identity: &ProcessIdentity,
    read: impl FnOnce() -> io::Result<T>,
) -> io::Result<Option<T>> {
    let same = || birth(identity.pid).map(|now| now.as_ref() == Some(&identity.birth));
    if !same()? {
        return Ok(None);
    }
    let read = read();
    if !same()? {
        return Ok(None);
    }
    read.map(Some)
}

/// An environment entry `name=value`; None where it is not UTF-8 or has no name.
fn variable(entry: Vec<u8>) -> Option<(String, String)> {
    let entry = String::from_utf8(entry).ok()?;
    match entry.split_once('=') {
        Some((name, value)) if !name.is_empty() => Some((name.to_string(), value.to_string())),
        _ => None,
    }
}

/// The environment's entries in a `KERN_PROCARGS2` buffer, which holds, each string ending in a
/// NUL: `argc` as a native-endian int, the program's path, NUL padding, `argc` arguments, and the
/// entries up to an empty one or the end. None where there are fewer arguments than it says.
#[cfg(any(target_os = "macos", all(test, unix)))]
fn procargs_environment(buffer: &[u8]) -> Option<Vec<Vec<u8>>> {
    let (argc, rest) = buffer.split_first_chunk::<4>()?;
    let argc = i32::from_ne_bytes(*argc);
    let after_path = &rest[rest.iter().position(|&byte| byte == 0)?..];
    let Some(first) = after_path.iter().position(|&byte| byte != 0) else {
        return (argc == 0).then(Vec::new);
    };
    let mut strings = after_path[first..].split(|&byte| byte == 0);
    let arguments = usize::try_from(argc).unwrap_or(0);
    if strings.by_ref().take(arguments).count() < arguments {
        return None;
    }
    let entries = strings
        .skip_while(|entry| entry.is_empty())
        .take_while(|entry| !entry.is_empty());
    Some(entries.map(<[u8]>::to_vec).collect())
}

// This machine, its sockets and its forks.

/// When this machine last started, as its kernel says: `kern.boottime` on macOS, `btime` in
/// `/proc/stat` on Linux. None where it cannot be read.
pub fn boot_time() -> Option<SystemTime> {
    os::boot_time()
}

/// The process at the other end of a Unix socket; None where the kernel does not say.
#[cfg(unix)]
pub fn peer_pid(socket: BorrowedFd<'_>) -> Option<u32> {
    use nix::sys::socket::getsockopt;
    #[cfg(target_os = "linux")]
    let pid = getsockopt(&socket, nix::sys::socket::sockopt::PeerCredentials)
        .ok()?
        .pid();
    #[cfg(target_os = "macos")]
    let pid = getsockopt(&socket, nix::sys::socket::sockopt::LocalPeerPid).ok()?;
    u32::try_from(pid).ok()
}

/// Held by every fork in this process. Where received descriptors cannot be made close-on-exec
/// atomically, receiving them holds it too, so no child inherits one in between.
pub static FORK_LOCK: Mutex<()> = Mutex::new(());

/// Takes [`FORK_LOCK`], also after a thread panicked holding it.
pub fn fork_lock() -> MutexGuard<'static, ()> {
    FORK_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The system's number for the signal `name`, such as `SIGKILL`; None for a name it does not have,
/// and on Windows, which has no signals.
pub fn signal_number(name: &str) -> Option<i32> {
    #[cfg(unix)]
    return name.parse::<Signal>().ok().map(|signal| signal as i32);
    #[cfg(windows)]
    {
        let _ = name;
        None
    }
}

#[cfg(unix)]
impl ProcessObservation {
    /// Returns once the process ended: when its descriptor becomes readable on tokio's reactor, and
    /// checked every [`PROC_POLL_INTERVAL`] too, or only so without a descriptor. Needs a tokio
    /// runtime.
    pub async fn until_ended(&self) {
        use tokio::io::Interest;
        use tokio::io::unix::AsyncFd;
        let watched = self
            .exit_event
            .as_ref()
            .and_then(|event| event.try_clone().ok())
            // SAFETY: the copy is owned by the AsyncFd, so it stays open, and the same descriptor,
            // for as long as it is registered.
            .and_then(|copy| {
                unsafe { AsyncFd::register_with_interest(copy, Interest::READABLE) }.ok()
            });
        while !matches!(self.ended(), Ok(Some(true))) {
            match &watched {
                Some(watched) => {
                    let _ = tokio::time::timeout(PROC_POLL_INTERVAL, watched.readable()).await;
                }
                None => tokio::time::sleep(PROC_POLL_INTERVAL).await,
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod os {
    use std::io;
    use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
    use std::sync::OnceLock;
    use std::time::{Duration, SystemTime};

    use nix::errno::Errno;
    use nix::sys::signal::Signal;

    use super::{Presence, ProcessSnapshot, Watch, identities_in, presence};
    use crate::process::ProcessIdentity;

    /// A process descriptor that is not readable yet belongs to a process that still runs.
    pub(super) const NO_EVENT_MEANS_RUNNING: bool = true;

    /// Whether this process watches others by process descriptor, chosen once, by the first watch.
    static PROCESS_DESCRIPTORS: OnceLock<bool> = OnceLock::new();

    /// A `/proc/<pid>/stat` line, split after the command name, which may itself hold spaces and
    /// parentheses.
    pub(super) struct Stat<'a>(Vec<&'a str>);

    impl<'a> Stat<'a> {
        pub(super) fn parse(line: &'a str) -> Option<Stat<'a>> {
            let after_name = line.get(line.rfind(')')? + 1..)?;
            Some(Stat(after_name.split_whitespace().collect()))
        }

        /// Field `number`, as proc(5) numbers them from 1, the process ID; the state is field 3.
        fn field(&self, number: usize) -> Option<&'a str> {
            self.0.get(number - 3).copied()
        }

        /// The parent, field 4.
        pub(super) fn parent(&self) -> Option<u32> {
            self.field(4)?.parse().ok()
        }

        /// The state (field 3), the group (5), the thread count (20) and the start time, the birth
        /// (22). A leader in state Z or X has ended all through only as the one thread left; with
        /// other threads, it runs; a count of zero, or none, tells nothing.
        pub(super) fn snapshot(&self) -> Option<ProcessSnapshot> {
            let state = self.field(3)?.chars().next()?;
            let group = self.field(5)?.parse().ok()?;
            let threads = self.field(20).and_then(|count| count.parse::<i64>().ok());
            let birth = self
                .field(22)
                .filter(|start| start.parse::<u64>().is_ok())?;
            let exited = match threads {
                _ if !matches!(state, 'Z' | 'X') => Some(false),
                Some(1) => Some(true),
                Some(count) if count > 1 => Some(false),
                _ => None,
            };
            Some(ProcessSnapshot {
                birth: birth.to_string(),
                group,
                exited,
            })
        }
    }

    /// `/proc/<pid>/<file>`; None where no process has that ID.
    fn read(pid: u32, file: &str) -> io::Result<Option<String>> {
        match std::fs::read_to_string(format!("/proc/{pid}/{file}")) {
            Ok(text) => Ok(Some(text)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) if err.raw_os_error() == Some(libc::ESRCH) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// What `take` reads from process `pid`'s stat line; None where no process has that ID.
    fn from_stat<T>(pid: u32, take: impl FnOnce(&Stat) -> Option<T>) -> io::Result<Option<T>> {
        let Some(line) = read(pid, "stat")? else {
            return Ok(None);
        };
        let taken = Stat::parse(&line).and_then(|stat| take(&stat));
        let unreadable = format!("unreadable /proc/{pid}/stat");
        taken
            .map(Some)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, unreadable))
    }

    pub(super) fn snapshot(pid: u32) -> io::Result<Option<ProcessSnapshot>> {
        from_stat(pid, |stat| stat.snapshot())
    }

    pub(super) fn parent(pid: u32) -> io::Result<Option<u32>> {
        from_stat(pid, |stat| stat.parent())
    }

    /// `/proc/<pid>/comm`, the name the process runs under.
    pub(super) fn name(pid: u32) -> io::Result<Option<String>> {
        let comm = read(pid, "comm")?;
        Ok(comm.map(|comm| comm.trim_end_matches('\n').to_string()))
    }

    /// The entries of `/proc/<pid>/environ`, the environment the process started with.
    pub(super) fn environment(pid: u32) -> io::Result<Vec<Vec<u8>>> {
        let environ = std::fs::read(format!("/proc/{pid}/environ"))?;
        let entries = environ.split(|&byte| byte == 0);
        Ok(entries
            .filter(|entry| !entry.is_empty())
            .map(<[u8]>::to_vec)
            .collect())
    }

    /// `btime` in `/proc/stat`: when the machine started, in seconds since the epoch.
    pub(super) fn boot_time() -> Option<SystemTime> {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        let btime = stat.lines().find_map(|line| line.strip_prefix("btime "))?;
        let seconds = btime.trim().parse().ok()?;
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
    }

    pub(super) fn group_members(group: i32) -> io::Result<Vec<ProcessIdentity>> {
        let listing = std::fs::read_dir("/proc")?.flatten();
        let pids = listing.filter_map(|entry| entry.file_name().to_str()?.parse().ok());
        Ok(identities_in(group, pids))
    }

    /// Whether `leader` still leads `group` and has exited all through.
    pub(super) fn leader_exiting(group: i32, leader: &ProcessIdentity) -> io::Result<bool> {
        let found = snapshot(leader.pid)?;
        Ok(found.is_some_and(|found| {
            found.birth == leader.birth && found.group == group && found.exited == Some(true)
        }))
    }

    pub(super) fn watch(identity: &ProcessIdentity) -> io::Result<Watch> {
        let watch = if uses_process_descriptors() {
            watch_from_pidfd_open(pidfd_open(identity.pid))?
        } else {
            Watch::Proc
        };
        // A descriptor opened by ID may be a later process's: its birth value decides.
        if matches!(watch, Watch::Ended) || presence(identity)? == Presence::Ended {
            return Ok(Watch::Ended);
        }
        Ok(watch)
    }

    /// How a process is watched, by what `pidfd_open` gave for its ID: by its descriptor; through
    /// `/proc` where the kernel said `EINVAL`, as for a process just released before its ID is
    /// free, which the birth check then finds ended; not at all where `ESRCH` says no process has
    /// the ID. Any other failure is the caller's.
    pub(super) fn watch_from_pidfd_open(opened: io::Result<OwnedFd>) -> io::Result<Watch> {
        let failure = match opened {
            Ok(descriptor) => return Ok(Watch::Event(descriptor)),
            Err(failure) => failure,
        };
        match failure.raw_os_error() {
            Some(libc::ESRCH) => Ok(Watch::Ended),
            Some(libc::EINVAL) => Ok(Watch::Proc),
            _ => Err(failure),
        }
    }

    fn uses_process_descriptors() -> bool {
        *PROCESS_DESCRIPTORS.get_or_init(|| {
            probe_selects_descriptors(pidfd_open(std::process::id())).unwrap_or(false)
        })
    }

    /// Whether a probe, opening a process descriptor for this process, chooses process
    /// descriptors: success does; `ENOSYS` or `EPERM` chooses reading `/proc`; any other failure is
    /// returned.
    pub(super) fn probe_selects_descriptors(probe: io::Result<OwnedFd>) -> io::Result<bool> {
        let Err(failure) = probe else {
            return Ok(true);
        };
        match failure.raw_os_error() {
            Some(libc::ENOSYS | libc::EPERM) => Ok(false),
            _ => Err(failure),
        }
    }

    /// A new process descriptor for `pid`, close-on-exec.
    fn pidfd_open(pid: u32) -> io::Result<OwnedFd> {
        // SAFETY: pidfd_open takes a process ID and flags and returns a new descriptor.
        let opened = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        let fd = Errno::result(opened)?;
        // SAFETY: the kernel just made the descriptor; nothing else owns it.
        Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
    }

    /// Sends `signal` through the process descriptor `event` where there is one; else to the ID,
    /// after a birth check.
    pub(super) fn signal(
        event: Option<BorrowedFd<'_>>,
        identity: &ProcessIdentity,
        signal: Signal,
    ) -> io::Result<bool> {
        let Some(event) = event else {
            return super::signal_checked(identity, signal);
        };
        // SAFETY: pidfd_send_signal takes a process descriptor the caller holds, a signal, no info
        // and no flags.
        let sent = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                event.as_raw_fd(),
                signal as libc::c_int,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        match Errno::result(sent) {
            Ok(_) => Ok(true),
            Err(Errno::ESRCH) => Ok(false),
            Err(err) => Err(err.into()),
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    use std::io;
    use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
    use std::time::{Duration, SystemTime};

    use nix::sys::signal::Signal;

    use super::{Presence, ProcessSnapshot, Watch, identities_in, presence};
    use crate::process::ProcessIdentity;

    /// A kqueue without the exit event leaves the process's record to tell.
    pub(super) const NO_EVENT_MEANS_RUNNING: bool = false;

    /// The size of `struct kinfo_proc` from `<sys/sysctl.h>` for 64-bit processes, and where its
    /// fields read here lie: `kp_proc.p_un.__p_starttime` (seconds, then microseconds),
    /// `kp_proc.p_flag`, `kp_proc.p_stat`, `kp_proc.p_pid`, `kp_eproc.e_ppid` and
    /// `kp_eproc.e_pgid`. They are the macOS 11+ arm64 and x86_64 layout, which a test checks on
    /// the machine it runs on.
    const KINFO_PROC_BYTES: usize = 648;
    const START_SECONDS_AT: usize = 0;
    const START_MICROS_AT: usize = 8;
    const FLAGS_AT: usize = 32;
    const STATE_AT: usize = 36;
    const PID_AT: usize = 40;
    const PARENT_AT: usize = 560;
    const GROUP_AT: usize = 564;
    /// `p_stat` of a process that exited and waits to be reaped.
    const ZOMBIE: u8 = 5;
    /// `P_WEXIT` from `<sys/proc.h>`: the kernel has begun the process's exit.
    const WORKING_ON_EXIT: u32 = 0x00002000;

    /// Asks `sysctl` for `name`, which writes at most `size` bytes at `into`; returns how many it
    /// wrote.
    ///
    /// # Safety
    ///
    /// `into` must point at `size` writable bytes.
    unsafe fn sysctl(
        name: &mut [libc::c_int],
        into: *mut libc::c_void,
        size: usize,
    ) -> io::Result<usize> {
        let mut written = size;
        let length = name.len() as libc::c_uint;
        let null = std::ptr::null_mut();
        // SAFETY: the caller's promise; sysctl writes at most `written` bytes and stores how many.
        let result =
            unsafe { libc::sysctl(name.as_mut_ptr(), length, into, &mut written, null, 0) };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(written)
    }

    /// The kernel's record of a process, from `sysctl(KERN_PROC_PID)`. Unlike `proc_pidinfo`, it
    /// still finds a process that exited and waits to be reaped.
    struct Record([u64; KINFO_PROC_BYTES / 8]);

    impl Record {
        /// The record for ID `pid`; None where no process has it. [`Record::of`] checks it is
        /// that process's.
        fn read(pid: u32) -> io::Result<Option<Record>> {
            // u64 elements keep the record aligned for its fields.
            let mut words = [0u64; KINFO_PROC_BYTES / 8];
            let mut name = [
                libc::CTL_KERN,
                libc::KERN_PROC,
                libc::KERN_PROC_PID,
                pid as libc::c_int,
            ];
            // SAFETY: `words` holds KINFO_PROC_BYTES bytes.
            let size = unsafe { sysctl(&mut name, words.as_mut_ptr().cast(), KINFO_PROC_BYTES) }?;
            match size {
                0 => Ok(None),
                KINFO_PROC_BYTES => Ok(Some(Record(words))),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("sysctl returned {size} bytes for process {pid}"),
                )),
            }
        }

        /// The record, where it is process `pid`'s.
        fn of(self, pid: u32) -> io::Result<Record> {
            if self.i32_at(PID_AT) == pid as i32 {
                return Ok(self);
            }
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("sysctl returned a different process for {pid}"),
            ))
        }

        fn bytes(&self) -> &[u8] {
            // SAFETY: the record is KINFO_PROC_BYTES initialized bytes.
            unsafe { std::slice::from_raw_parts(self.0.as_ptr().cast::<u8>(), KINFO_PROC_BYTES) }
        }

        fn i32_at(&self, at: usize) -> i32 {
            let bytes = self.bytes()[at..at + 4].try_into().expect("four bytes");
            i32::from_ne_bytes(bytes)
        }

        fn snapshot(&self) -> ProcessSnapshot {
            let seconds = self.bytes()[START_SECONDS_AT..START_SECONDS_AT + 8].try_into();
            let seconds = i64::from_ne_bytes(seconds.expect("eight bytes"));
            let micros = self.i32_at(START_MICROS_AT);
            ProcessSnapshot {
                birth: format!("{seconds}.{micros:06}"),
                group: self.i32_at(GROUP_AT),
                exited: Some(self.bytes()[STATE_AT] == ZOMBIE),
            }
        }
    }

    /// Process `pid`'s record, checked to be its own.
    fn checked(pid: u32) -> io::Result<Option<Record>> {
        Record::read(pid)?.map(|record| record.of(pid)).transpose()
    }

    pub(super) fn snapshot(pid: u32) -> io::Result<Option<ProcessSnapshot>> {
        Ok(checked(pid)?.map(|record| record.snapshot()))
    }

    pub(super) fn parent(pid: u32) -> io::Result<Option<u32>> {
        Ok(checked(pid)?.map(|record| record.i32_at(PARENT_AT) as u32))
    }

    /// The name `proc_name` gives the process.
    pub(super) fn name(pid: u32) -> io::Result<Option<String>> {
        let mut buffer = [0u8; 256];
        let size = buffer.len() as u32;
        // SAFETY: proc_name writes at most `size` bytes and returns how many it wrote.
        let written =
            unsafe { libc::proc_name(pid as libc::c_int, buffer.as_mut_ptr().cast(), size) };
        if written <= 0 {
            let failed = io::Error::last_os_error();
            return match Record::read(pid)? {
                None => Ok(None),
                Some(_) => Err(failed),
            };
        }
        let name = String::from_utf8_lossy(&buffer[..written as usize]);
        Ok(Some(name.into_owned()))
    }

    /// The environment's entries the process started with, from `sysctl(KERN_PROCARGS2)`.
    pub(super) fn environment(pid: u32) -> io::Result<Vec<Vec<u8>>> {
        let mut most: libc::c_int = 0;
        let mut argmax = [libc::CTL_KERN, libc::KERN_ARGMAX];
        // SAFETY: `most` is one c_int.
        unsafe {
            sysctl(
                &mut argmax,
                (&raw mut most).cast(),
                size_of::<libc::c_int>(),
            )
        }?;
        let mut buffer = vec![0u8; usize::try_from(most).unwrap_or(0)];
        let mut procargs = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        // SAFETY: the buffer holds its length in bytes.
        let size = unsafe { sysctl(&mut procargs, buffer.as_mut_ptr().cast(), buffer.len()) }?;
        buffer.truncate(size);
        let unreadable = || {
            let why = format!("unreadable arguments of process {pid}");
            io::Error::new(io::ErrorKind::InvalidData, why)
        };
        super::procargs_environment(&buffer).ok_or_else(unreadable)
    }

    /// `kern.boottime`: when the machine started.
    pub(super) fn boot_time() -> Option<SystemTime> {
        // SAFETY: an all-zero timeval is valid.
        let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
        let mut name = [libc::CTL_KERN, libc::KERN_BOOTTIME];
        let size = size_of::<libc::timeval>();
        // SAFETY: `boot` is one timeval.
        unsafe { sysctl(&mut name, (&raw mut boot).cast(), size) }.ok()?;
        let since_epoch =
            || Duration::from_secs(boot.tv_sec as u64) + Duration::from_micros(boot.tv_usec as u64);
        (boot.tv_sec > 0).then(|| SystemTime::UNIX_EPOCH + since_epoch())
    }

    pub(super) fn group_members(group: i32) -> io::Result<Vec<ProcessIdentity>> {
        let mut pids: Vec<libc::pid_t> = vec![0; 256];
        let listed = loop {
            let size = (pids.len() * size_of::<libc::pid_t>()) as libc::c_int;
            // SAFETY: proc_listpgrppids writes at most `size` bytes of process IDs and returns how
            // many it wrote.
            let count = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), size) };
            let Ok(count) = usize::try_from(count) else {
                return Err(io::Error::last_os_error());
            };
            if count < pids.len() {
                break count;
            }
            pids.resize(pids.len() * 2, 0);
        };
        let positive = pids[..listed].iter().filter(|&&pid| pid > 0);
        Ok(identities_in(group, positive.map(|&pid| pid as u32)))
    }

    /// Whether `leader` still leads `group` and is exiting. Asked only after a group signal got
    /// EPERM, together with whether it is the group's one process: its exit may wait for PTY output
    /// nobody read, which closing a removed run's master lets go. XNU sets `P_WEXIT` before every
    /// thread has ended, so presence and exits never take this flag as proof of an exit.
    pub(super) fn leader_exiting(group: i32, leader: &ProcessIdentity) -> io::Result<bool> {
        let Some(record) = checked(leader.pid)? else {
            return Ok(false);
        };
        let found = record.snapshot();
        let exiting = record.i32_at(FLAGS_AT) as u32 & WORKING_ON_EXIT != 0;
        let same = found.birth == leader.birth && found.group == group;
        Ok(same && (exiting || found.exited == Some(true)))
    }

    #[cfg(test)]
    pub(super) fn check_record_ids(pid: u32) {
        let record = Record::read(pid).unwrap().unwrap();
        // SAFETY: these process-ID queries have no preconditions.
        assert_eq!(record.i32_at(PID_AT), unsafe { libc::getpid() });
        // SAFETY: getppid has no preconditions.
        assert_eq!(record.i32_at(PARENT_AT), unsafe { libc::getppid() });
        // SAFETY: getpgrp has no preconditions.
        assert_eq!(record.i32_at(GROUP_AT), unsafe { libc::getpgrp() });
        assert_eq!(
            record.of(pid.wrapping_add(1)).err().map(|err| err.kind()),
            Some(io::ErrorKind::InvalidData)
        );
    }

    /// A kqueue that reports the exit of the process `identity`, after checking its birth value
    /// before and after the registration, which may have found a later process with the same ID.
    pub(super) fn watch(identity: &ProcessIdentity) -> io::Result<Watch> {
        if presence(identity)? == Presence::Ended {
            return Ok(Watch::Ended);
        }
        // SAFETY: kqueue takes no arguments and returns a new descriptor, which a forked child does
        // not inherit.
        let queue = unsafe { libc::kqueue() };
        if queue < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the kernel just made the descriptor; nothing else owns it.
        let queue = unsafe { OwnedFd::from_raw_fd(queue) };
        if let Err(failure) = register_exit(&queue, identity.pid) {
            if failure.raw_os_error() == Some(libc::ESRCH) {
                return Ok(Watch::Ended);
            }
            return Err(failure);
        }
        if presence(identity)? == Presence::Ended {
            return Ok(Watch::Ended);
        }
        Ok(Watch::Event(queue))
    }

    /// Asks `queue` to report process `pid`'s exit, once.
    fn register_exit(queue: &OwnedFd, pid: u32) -> io::Result<()> {
        let exit = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let (no_events, no_timeout) = (std::ptr::null_mut(), std::ptr::null());
        // SAFETY: kevent reads one change and writes no events.
        let added = unsafe { libc::kevent(queue.as_raw_fd(), &exit, 1, no_events, 0, no_timeout) };
        if added < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// A kqueue cannot signal: the signal goes to the ID after a birth check.
    pub(super) fn signal(
        _event: Option<BorrowedFd<'_>>,
        identity: &ProcessIdentity,
        signal: Signal,
    ) -> io::Result<bool> {
        super::signal_checked(identity, signal)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_folder::TestFolder;

    /// A `KERN_PROCARGS2` buffer as macOS gives it: argc, the executable's path, padding, the
    /// arguments, the environment, and the strings after it that are not the environment. The
    /// machine's start is in the past, and after 2020.
    #[test]
    fn the_machine_s_start_is_read_from_its_kernel() {
        let boot = boot_time().expect("the kernel says when the machine started");
        let after =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_577_836_800);
        assert!(
            boot < std::time::SystemTime::now() && boot > after,
            "{boot:?}"
        );
    }

    #[test]
    fn the_environment_is_read_after_the_arguments_of_a_kern_procargs2_buffer() {
        let mut buffer = 3i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(
            b"/opt/bin/fake\0\0\0\0fake\0\0--name=a b\0A=1\0EMPTY=\0B=two=2\0\0ptr_munge=x\0\0",
        );
        let entries = procargs_environment(&buffer).unwrap();
        assert_eq!(
            entries,
            [b"A=1".to_vec(), b"EMPTY=".to_vec(), b"B=two=2".to_vec()],
            "an empty argument counts as one"
        );
        let mut bare = 0i32.to_ne_bytes().to_vec();
        bare.extend_from_slice(b"/opt/bin/fake\0\0\0");
        assert_eq!(
            procargs_environment(&bare),
            Some(Vec::new()),
            "no arguments and no environment"
        );
        let mut short = 4i32.to_ne_bytes().to_vec();
        short.extend_from_slice(b"/opt/bin/fake\0\0fake\0--x\0");
        assert_eq!(
            procargs_environment(&short),
            None,
            "fewer arguments than it says"
        );
        assert_eq!(procargs_environment(&[1, 0]), None);
    }

    /// A process's environment is the one it started with, and a reused identity reads as none. The
    /// process is this test program again: macOS keeps the environment of its own programs, such as
    /// `/bin/sleep`, from other processes. It is read once the child says it runs: on Linux,
    /// `/proc/<pid>/environ` reads empty between a spawn and the new program's start.
    #[test]
    fn a_process_s_environment_is_read_by_its_identity() {
        use std::io::BufRead;
        if std::env::var_os("FACADE_TEST_ENVIRONMENT_CHILD").is_some() {
            println!("running");
            std::thread::sleep(Duration::from_secs(60));
            return;
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "platform::unix_process::tests::a_process_s_environment_is_read_by_its_identity",
                "--nocapture",
            ])
            .env_clear()
            .env("FACADE_TEST_ENVIRONMENT_CHILD", "1")
            .env("MARK", "from the start")
            .env("TWO", "a=b")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let output = std::io::BufReader::new(child.stdout.take().expect("the child's output"));
        assert!(
            output
                .lines()
                .any(|line| line.is_ok_and(|line| line == "running")),
            "the child runs"
        );
        let identity = ProcessIdentity {
            pid: child.id(),
            birth: birth(child.id()).unwrap().unwrap(),
        };
        let read = environment(&identity).unwrap().unwrap();
        assert_eq!(
            (
                read.get("MARK").map(String::as_str),
                read.get("TWO").map(String::as_str)
            ),
            (Some("from the start"), Some("a=b")),
            "{read:?}"
        );
        assert_eq!(
            environment(&ProcessIdentity {
                birth: format!("{}0", identity.birth),
                ..identity.clone()
            })
            .unwrap(),
            None,
            "another birth"
        );
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(
            environment(&identity).unwrap(),
            None,
            "an ended process has none"
        );
    }

    #[test]
    fn a_process_is_identified_by_its_birth_and_a_reused_identity_reads_as_ended() {
        let me = own_identity().unwrap();
        assert_eq!(presence(&me).unwrap(), Presence::Running);
        assert_eq!(
            presence(&ProcessIdentity {
                birth: format!("{}0", me.birth),
                ..me.clone()
            })
            .unwrap(),
            Presence::Ended,
            "another birth is another process"
        );
        let home = TestFolder::new("observed-child");
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .env("FACADE_HOME", &home)
            .spawn()
            .unwrap();
        let identity = ProcessIdentity {
            pid: child.id(),
            birth: birth(child.id()).unwrap().unwrap(),
        };
        let Observed::Watching(observation) = ProcessObservation::open(&identity).unwrap() else {
            panic!("the child runs")
        };
        assert!(!observation.wait(Duration::from_millis(100)).unwrap());
        assert!(observation.signal(Signal::SIGKILL).unwrap());
        assert!(
            observation.wait(Duration::from_secs(5)).unwrap(),
            "the exit is seen before the child is reaped"
        );
        child.wait().unwrap();
        assert!(matches!(
            ProcessObservation::open(&identity).unwrap(),
            Observed::Ended
        ));
        assert!(
            !signal_checked(&identity, Signal::SIGKILL).unwrap(),
            "an ended identity is never signalled"
        );
    }

    #[test]
    fn a_group_is_signalled_only_while_its_leader_or_a_recorded_member_proves_it() {
        use std::os::unix::process::CommandExt;
        let home = TestFolder::new("proved-group");
        let mut leader = std::process::Command::new("/bin/sleep")
            .arg("60")
            .env("FACADE_HOME", &home)
            .process_group(0)
            .spawn()
            .unwrap();
        let group = leader.id() as i32;
        let identity = ProcessIdentity {
            pid: leader.id(),
            birth: birth(leader.id()).unwrap().unwrap(),
        };
        assert_eq!(
            group_members(group).unwrap(),
            std::slice::from_ref(&identity)
        );
        let stranger = ProcessIdentity {
            pid: identity.pid,
            birth: "0".into(),
        };
        assert_eq!(
            signal_group(group, &stranger, Signal::SIGKILL).unwrap(),
            GroupSignal::Unverified,
            "a reused leader ID proves nothing"
        );
        assert!(leader.try_wait().unwrap().is_none(), "nothing was sent");
        assert_eq!(
            signal_group(group, &identity, Signal::SIGKILL).unwrap(),
            GroupSignal::Sent,
            "the leader proves the group"
        );
        leader.wait().unwrap();
        assert_eq!(
            signal_group(group, &identity, Signal::SIGKILL).unwrap(),
            GroupSignal::Ended,
            "an empty group has ended without a skipped signal"
        );
    }

    #[test]
    fn a_process_that_is_not_a_child_has_no_exit_to_reap() {
        // ECHILD proves nothing: it must never read as an exit.
        assert_eq!(reap_child(1), None);
        assert_eq!(peek_child_exit(1), None);
    }

    /// A child stopped by SIGSTOP and continued by SIGCONT has not exited; one killed has, by its
    /// signal.
    #[test]
    fn a_stopped_or_continued_child_has_not_exited_and_a_killed_one_has_by_its_signal() {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        /// Kills and reaps the child however the test ends, so a stopped child outlives no failure.
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let null = std::process::Stdio::null;
        let child = Child(
            std::process::Command::new("/bin/sleep")
                .arg("30")
                .stdin(null())
                .stdout(null())
                .stderr(null())
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id() as i32;
        let stopped = || {
            let state = std::process::Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&state.stdout)
                .trim_start()
                .starts_with('T')
        };
        // Up to two seconds for `done`.
        let waits = |done: &dyn Fn() -> bool| {
            (0..400).any(|_| {
                let now = done();
                if !now {
                    std::thread::sleep(Duration::from_millis(5));
                }
                now
            })
        };
        kill(Pid::from_raw(pid), Signal::SIGSTOP).unwrap();
        assert!(waits(&stopped), "the child stops");
        assert_eq!(peek_child_exit(pid), None, "a stopped child has not exited");
        kill(Pid::from_raw(pid), Signal::SIGCONT).unwrap();
        assert!(waits(&|| !stopped()), "the child goes on");
        assert_eq!(
            peek_child_exit(pid),
            None,
            "a continued child has not exited"
        );
        kill(Pid::from_raw(pid), Signal::SIGKILL).unwrap();
        assert!(
            waits(&|| peek_child_exit(pid).is_some()),
            "the killed child's exit shows"
        );
        assert_eq!(
            peek_child_exit(pid).and_then(|exit| exit.signal).as_deref(),
            Some("SIGKILL")
        );
    }

    #[test]
    fn an_exited_child_waiting_to_be_reaped_keeps_its_birth_and_group() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        let running = snapshot(pid).unwrap();
        // Wait for the exit without reaping, as a keeper does for a stopped leader.
        assert!((0..200).any(|_| {
            std::thread::sleep(Duration::from_millis(5));
            peek_child_exit(pid as i32).is_some()
        }));
        let exited = snapshot(pid)
            .unwrap()
            .expect("an unreaped child is still there");
        assert_eq!(exited.exited, Some(true));
        if let Some(running) = running {
            assert_eq!(
                (running.birth, running.group),
                (exited.birth, exited.group),
                "the same process"
            );
        }
        child.wait().unwrap();
        assert_eq!(snapshot(pid).unwrap(), None);
    }

    #[test]
    fn a_deadline_on_the_monotonic_clock_becomes_a_local_moment() {
        let now = monotonic_now();
        let soon = instant_at(now + 2_000_000_000);
        let left = soon.saturating_duration_since(Instant::now());
        assert!(
            left > Duration::from_millis(1500) && left <= Duration::from_secs(2),
            "{left:?}"
        );
        assert!(
            instant_at(now.saturating_sub(1)) <= Instant::now(),
            "an overdue deadline is due now"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_enosys_or_eperm_from_the_self_probe_selects_reading_proc() {
        let error = |code| Err(io::Error::from_raw_os_error(code));
        // The decision does not depend on what the descriptor is; any open one stands in for a
        // probe that succeeded.
        let opened = Ok(std::os::fd::OwnedFd::from(std::io::pipe().unwrap().0));
        assert!(os::probe_selects_descriptors(opened).unwrap());
        assert!(!os::probe_selects_descriptors(error(libc::ENOSYS)).unwrap());
        assert!(!os::probe_selects_descriptors(error(libc::EPERM)).unwrap());
        assert!(
            os::probe_selects_descriptors(error(libc::EMFILE)).is_err(),
            "other errors fail startup"
        );
    }

    /// A process the kernel refuses a descriptor for with `EINVAL`, as one just released, is
    /// observed through `/proc`, whose birth check says whether it ended; `ESRCH` says it ended,
    /// and any other error is the caller's.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_process_pidfd_open_refuses_with_einval_is_observed_through_proc() {
        let error = |code| Err(io::Error::from_raw_os_error(code));
        assert!(matches!(
            os::watch_from_pidfd_open(error(libc::EINVAL)),
            Ok(Watch::Proc)
        ));
        assert!(matches!(
            os::watch_from_pidfd_open(error(libc::ESRCH)),
            Ok(Watch::Ended)
        ));
        assert!(os::watch_from_pidfd_open(error(libc::EMFILE)).is_err());
        let opened = Ok(std::os::fd::OwnedFd::from(std::io::pipe().unwrap().0));
        assert!(matches!(
            os::watch_from_pidfd_open(opened),
            Ok(Watch::Event(_))
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_zombie_leader_proves_an_exit_only_with_exactly_one_thread() {
        let stat = |state: &str, threads: &str| {
            format!("42 (a (b) c) {state} 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 {threads} 0 777 0 0")
        };
        let read = |state, threads| {
            os::Stat::parse(&stat(state, threads))
                .and_then(|stat| stat.snapshot())
                .map(|found| (found.group, found.birth, found.exited))
        };
        assert_eq!(read("S", "3"), Some((42, "777".into(), Some(false))));
        assert_eq!(read("Z", "1"), Some((42, "777".into(), Some(true))));
        assert_eq!(read("X", "1"), Some((42, "777".into(), Some(true))));
        assert_eq!(
            read("Z", "2"),
            Some((42, "777".into(), Some(false))),
            "a zombie leader with a live worker still runs"
        );
        assert_eq!(
            read("Z", "0"),
            Some((42, "777".into(), None)),
            "a zero count settles nothing"
        );
        assert_eq!(
            read("Z", "many"),
            Some((42, "777".into(), None)),
            "a malformed count settles nothing"
        );
        assert_eq!(
            os::Stat::parse("42 (truncated").and_then(|stat| stat.snapshot()),
            None
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn the_macos_process_record_agrees_with_libproc_and_process_ids() {
        let pid = std::process::id();
        os::check_record_ids(pid);
        let record = snapshot(pid).unwrap().unwrap();
        // SAFETY: every field of proc_bsdinfo admits a zero representation.
        let mut bsd: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&bsd) as i32;
        // SAFETY: proc_pidinfo receives a valid structure and its exact length.
        let read = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut bsd as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        assert_eq!(read, size);
        assert_eq!(bsd.pbi_pid, pid);
        // SAFETY: getppid has no preconditions.
        assert_eq!(bsd.pbi_ppid, unsafe { libc::getppid() } as u32);
        // SAFETY: getpgrp has no preconditions.
        assert_eq!(record.group, unsafe { libc::getpgrp() });
        assert_eq!(
            record.birth,
            format!("{}.{:06}", bsd.pbi_start_tvsec, bsd.pbi_start_tvusec)
        );
        assert_eq!(record.exited, Some(false));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn an_exiting_leader_blocked_on_unread_output_has_no_group_signal_recipient() {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        let home = TestFolder::new("exiting-group");
        let ready = home.join("written");
        let forks = fork_lock();
        let pty = nix::pty::openpty(None, None).unwrap();
        for fd in [&pty.master, &pty.slave] {
            nix::fcntl::fcntl(
                fd,
                nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::FD_CLOEXEC),
            )
            .unwrap();
        }
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "printf FINAL; echo done > written; exit 5"])
            .env("FACADE_HOME", &home)
            .current_dir(&home);
        command
            .stdin(Stdio::from(pty.slave.try_clone().unwrap()))
            .stdout(Stdio::from(pty.slave.try_clone().unwrap()))
            .stderr(Stdio::null());
        // SAFETY: the child uses only async-signal-safe calls after fork; descriptor zero is its
        // PTY slave.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        drop(command);
        drop(pty.slave);
        drop(forks);
        let identity = ProcessIdentity {
            pid: child.id(),
            birth: birth(child.id()).unwrap().unwrap(),
        };
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until
            && (!ready.exists() || !os::leader_exiting(child.id() as i32, &identity).unwrap())
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let waiting = peek_child_exit(child.id() as i32);
        let before = presence(&identity);
        let outcome = signal_group(child.id() as i32, &identity, Signal::SIGKILL);
        // Release unread output before checking assertions, so the child can finish kernel exit
        // cleanup.
        drop(pty.master);
        let status = child.wait().unwrap();
        std::fs::remove_dir_all(home).unwrap();
        assert!(
            waiting.is_none(),
            "the terminal holds the exit before it becomes waitable"
        );
        assert_eq!(
            before.unwrap(),
            Presence::Running,
            "working on exit does not prove that every thread ended"
        );
        assert_eq!(outcome.unwrap(), GroupSignal::Ended);
        assert_eq!(status.code(), Some(5));
        assert!(
            snapshot(identity.pid).unwrap().is_none(),
            "normal reaping releases the leader"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_zombie_only_group_has_ended_when_macos_refuses_its_signal() {
        use std::os::unix::process::CommandExt;
        let home = TestFolder::new("zombie-group");
        let mut child = std::process::Command::new("/usr/bin/true")
            .env("FACADE_HOME", &home)
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let until = Instant::now() + Duration::from_secs(5);
        while peek_child_exit(pid as i32).is_none() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(10));
        }
        let identity = ProcessIdentity {
            pid,
            birth: birth(pid).unwrap().unwrap(),
        };
        let outcome = signal_group(pid as i32, &identity, Signal::SIGKILL);
        child.wait().unwrap();
        assert_eq!(outcome.unwrap(), GroupSignal::Ended);
    }

    /// A process's ancestors run from its parent up: a shell's background child has the shell, then
    /// this test, then this test's own ancestors. A process that ended has no parent.
    #[test]
    fn a_process_s_ancestors_run_from_its_parent_up() {
        use std::io::BufRead;
        let mut shell = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .env(
                "FACADE_HOME",
                std::env::temp_dir().join(format!("facade-ancestors-{}", std::process::id())),
            )
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(shell.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let sleeper: u32 = line.trim().parse().unwrap();
        let mine = ancestors(std::process::id());
        assert_eq!(
            mine.first().copied(),
            Some(std::os::unix::process::parent_id())
        );
        assert_eq!(
            ancestors(sleeper),
            [&[shell.id(), std::process::id()][..], &mine[..]].concat()
        );
        nix::sys::signal::kill(Pid::from_raw(sleeper as i32), Signal::SIGKILL).unwrap();
        shell.wait().unwrap();
        assert_eq!(parent(sleeper).unwrap(), None, "the shell reaped its child");
    }

    /// A process's name is the one it runs under; a process that ended has none. The program that
    /// runs a process is its nearest ancestor that is not a shell, as a hook run through `sh -c`
    /// finds the CLI that ran it.
    #[test]
    fn a_process_is_named_and_the_program_that_runs_one_is_its_nearest_ancestor_but_a_shell() {
        let mut sleeper = std::process::Command::new("/bin/sleep")
            .arg("60")
            .env("FACADE_HOME", std::env::temp_dir())
            .spawn()
            .unwrap();
        // On Linux, the spawn returns once the program took over the child, a moment before the
        // kernel names the child for it: until then it has the name of the thread that spawned it,
        // as `unix_process::t`. A loaded machine has taken over a second.
        let named_at = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while name(sleeper.id()).unwrap().as_deref() != Some("sleep")
            && std::time::Instant::now() < named_at
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(name(sleeper.id()).unwrap().as_deref(), Some("sleep"));
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
        assert_eq!(name(sleeper.id()).unwrap(), None, "ended and reaped");
        let named = |name: &str| Some(name.to_string());
        assert_eq!(
            nearest_program([
                (9, named("sh")),
                (8, named("zsh")),
                (7, named("agy")),
                (6, named("launchd"))
            ]),
            Some(7)
        );
        assert_eq!(
            nearest_program([(9, None), (8, named("bash")), (7, named("codex"))]),
            Some(7),
            "one that cannot be read is passed"
        );
        assert_eq!(
            nearest_program([(9, named("sh")), (8, named("dash"))]),
            None
        );
    }

    /// `/proc/<pid>/stat` names the parent after the state, past a command name that may hold
    /// spaces and parentheses.
    #[test]
    #[cfg(target_os = "linux")]
    fn the_parent_is_read_past_the_command_name() {
        assert_eq!(
            os::Stat::parse("4242 (a) b (c) S 17 4242 4242 0 -1 4194304")
                .and_then(|stat| stat.parent()),
            Some(17)
        );
        assert_eq!(
            os::Stat::parse("4242 (sh)").and_then(|stat| stat.parent()),
            None
        );
    }
}
