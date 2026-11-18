//! One CLI the keeper holds: its process (leader of its own session and process group) and the
//! keeper's copy of the PTY master. The keeper writes nothing to and reads nothing from the
//! terminal; holding the master is the whole point.

use std::io;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::{HeldAgent, KeeperStartArgs, STOP_TIMEOUT};
use facade_base::process::{ProcessExit, ProcessIdentity};
use facade_base::unix_process::{self, Observed, ProcessObservation};
use nix::sys::signal::Signal;
use nix::sys::wait::waitpid;
use nix::unistd::Pid;

use crate::{log, terminal};

/// Pause before a failed SIGKILL is tried again.
const KILL_RETRY_DELAY: Duration = Duration::from_millis(100);

pub(super) struct Cli {
    agent: String,
    process: ProcessIdentity,
    master: OwnedFd,
    tie: Tie,
    /// While a stop is under way: when the group gets SIGKILL.
    kill_deadline: Option<Instant>,
}

/// The keeper's relation to the CLI process, which decides how its end is noticed.
enum Tie {
    /// The keeper forked it. SIGCHLD reports the end, with code or signal.
    Parent,
    /// Handed over by `agent.sync`; a pidfd or kqueue descriptor turns readable at its end.
    Observed(ProcessObservation),
    /// Handed over, but the system would not let the keeper watch it. Only a stop or sync from
    /// the daemon deals with it.
    Blind,
}

impl Cli {
    /// Forks the CLI that `args` describes onto a new PTY and returns it, plus a second master
    /// for the daemon. Returns as soon as the program is running; it does not wait for the CLI.
    pub(super) fn spawn(args: &KeeperStartArgs) -> Result<(Cli, OwnedFd), ErrorBody> {
        let program = &args.launch.program;
        if program.is_empty() {
            return Err(ErrorBody::invalid_argument(
                "command must start with the CLI's program",
            ));
        }
        let terminal = terminal::open(args.cols.max(2), args.rows.max(1))?;
        let for_daemon = duplicate(terminal.master.as_fd(), "could not copy the terminal")?;
        let mut command = Command::new(program);
        command
            .args(&args.launch.args)
            .env_clear()
            .envs(&args.env)
            .current_dir(&args.launch.folder);
        command.stdin(stdio(&terminal.slave)?);
        command.stdout(stdio(&terminal.slave)?);
        command.stderr(stdio(&terminal.slave)?);
        // SAFETY: `own_terminal` only makes async-signal-safe calls, as `pre_exec` requires.
        unsafe {
            command.pre_exec(own_terminal);
        }
        let child = command.spawn().map_err(|err| {
            ErrorBody::new(
                Reason::Unavailable,
                format!("could not start {program}: {err}"),
            )
        })?;
        let pid = child.id();
        let process = match unix_process::birth(pid) {
            Ok(Some(birth)) => ProcessIdentity { pid, birth },
            other => {
                discard_child(pid);
                let detail = match other {
                    Err(err) => err.to_string(),
                    Ok(_) => "it ended at once".into(),
                };
                return Err(ErrorBody::new(
                    Reason::Unavailable,
                    format!("could not read the birth of {program} ({pid}): {detail}"),
                ));
            }
        };
        let cli = Cli {
            agent: args.agent.clone(),
            process,
            master: terminal.master,
            tie: Tie::Parent,
            kill_deadline: None,
        };
        Ok((cli, for_daemon))
    }

    /// Takes over a CLI another keeper started, with the master the daemon handed in. None when
    /// that process is already gone.
    pub(super) fn adopt(agent: String, process: ProcessIdentity, master: OwnedFd) -> Option<Cli> {
        let tie = match ProcessObservation::open(&process) {
            Ok(Observed::Ended) => return None,
            Ok(Observed::Watching(watch)) if watch.descriptor().is_some() => Tie::Observed(watch),
            Ok(Observed::Watching(_)) => {
                log(
                    "warn",
                    &format!(
                        "{agent} ({}): no process descriptor here, so its end goes unseen",
                        process.pid
                    ),
                );
                Tie::Blind
            }
            Err(err) => {
                log(
                    "warn",
                    &format!("{agent} ({}): cannot watch its end: {err}", process.pid),
                );
                Tie::Blind
            }
        };
        Some(Cli {
            agent,
            process,
            master,
            tie,
            kill_deadline: None,
        })
    }

    pub(super) fn process(&self) -> &ProcessIdentity {
        &self.process
    }

    /// How the CLI appears in `hello`'s list.
    pub(super) fn as_held(&self) -> HeldAgent {
        HeldAgent {
            id: self.agent.clone(),
            pid: self.process.pid,
            birth: self.process.birth.clone(),
            stopping: self.is_stopping(),
        }
    }

    pub(super) fn is_parent(&self) -> bool {
        matches!(self.tie, Tie::Parent)
    }

    pub(super) fn is_stopping(&self) -> bool {
        self.kill_deadline.is_some()
    }

    pub(super) fn kill_deadline(&self) -> Option<Instant> {
        self.kill_deadline
    }

    /// For a handed-over CLI: the descriptor that becomes readable when it ends.
    pub(super) fn end_signal(&self) -> Option<BorrowedFd<'_>> {
        match &self.tie {
            Tie::Observed(watch) => watch.descriptor(),
            Tie::Parent | Tie::Blind => None,
        }
    }

    /// A fresh duplicate of the keeper's master, to hand to the daemon.
    pub(super) fn share_master(&self) -> Result<OwnedFd, ErrorBody> {
        let what = format!("could not copy {}'s terminal", self.agent);
        duplicate(self.master.as_fd(), &what)
    }

    /// First step of a stop: SIGHUP to the group now, SIGKILL at [`STOP_TIMEOUT`] unless the CLI
    /// ends sooner. Asking again changes nothing.
    pub(super) fn begin_stop(&mut self, now: Instant) {
        if self.is_stopping() {
            return;
        }
        // Failures are logged inside; the SIGKILL deadline holds regardless.
        let _ = self.signal_group(Signal::SIGHUP);
        self.kill_deadline = Some(now + STOP_TIMEOUT);
    }

    /// SIGKILL to the group. If sending fails, it is attempted again after [`KILL_RETRY_DELAY`].
    pub(super) fn kill_group(&mut self, now: Instant) {
        let sent = self.signal_group(Signal::SIGKILL).is_ok();
        self.kill_deadline = if sent {
            None
        } else {
            Some(now + KILL_RETRY_DELAY)
        };
    }

    /// Signals the process group, but only after the leader's pid, birth and group prove the
    /// group still belongs to this CLI.
    fn signal_group(&self, signal: Signal) -> io::Result<unix_process::GroupSignal> {
        let group = self.process.pid as i32;
        let result = unix_process::signal_group(group, &self.process, signal);
        unix_process::log_group_signal("keeper", &self.agent, signal, &result);
        result
    }

    /// For a CLI the keeper forked: its exit, if it has exited. The zombie is left in place so
    /// the pid and group stay reserved until [`Cli::forget`].
    pub(super) fn exited(&self) -> Option<ProcessExit> {
        if self.is_parent() {
            unix_process::peek_child_exit(self.process.pid as i32)
        } else {
            None
        }
    }

    /// Drops the CLI after its end: reaps the zombie if the keeper is the parent, and closes the
    /// keeper's master by dropping it.
    pub(super) fn forget(self) {
        if self.is_parent() {
            unix_process::reap_child(self.process.pid as i32);
        }
    }
}

/// An exit the keeper cannot know the details of, stamped now.
pub(super) fn exit_unknown() -> ProcessExit {
    ProcessExit {
        at: facade_base::time::iso_now(),
        code: None,
        signal: None,
        reason: None,
    }
}

/// Runs in the child between fork and exec. The keeper blocks and catches signals; the CLI must
/// start with every signal at its default and nothing blocked, or Ctrl+C would do nothing. Then
/// the child becomes a session leader and takes the PTY on fd 0 as its controlling terminal.
fn own_terminal() -> io::Result<()> {
    const RESET: [libc::c_int; 9] = [
        libc::SIGCHLD,
        libc::SIGHUP,
        libc::SIGINT,
        libc::SIGPIPE,
        libc::SIGQUIT,
        libc::SIGTERM,
        libc::SIGTSTP,
        libc::SIGTTIN,
        libc::SIGTTOU,
    ];
    // SAFETY: signal, sigemptyset, sigprocmask, setsid and ioctl are all async-signal-safe.
    let failed = unsafe {
        for signal in RESET {
            libc::signal(signal, libc::SIG_DFL);
        }
        let mut empty: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut empty);
        libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) == -1
            || libc::setsid() == -1
            || libc::ioctl(libc::STDIN_FILENO, libc::TIOCSCTTY as _, 0) == -1
    };
    if failed {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Kills and reaps a child the keeper gave up on before anyone learned of it. It is unreaped, so
/// its pid cannot have been reused. Errors only mean it is already gone.
fn discard_child(pid: u32) {
    let pid = Pid::from_raw(pid as i32);
    let _ = nix::sys::signal::kill(pid, Signal::SIGKILL);
    let _ = waitpid(pid, None);
}

fn duplicate(fd: BorrowedFd<'_>, what: &str) -> Result<OwnedFd, ErrorBody> {
    fd.try_clone_to_owned()
        .map_err(|err| ErrorBody::new(Reason::Unavailable, format!("{what}: {err}")))
}

fn stdio(slave: &OwnedFd) -> Result<Stdio, ErrorBody> {
    duplicate(slave.as_fd(), "could not use the terminal").map(Stdio::from)
}
