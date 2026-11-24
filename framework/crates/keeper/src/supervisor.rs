//! Keeping one daemon alive. The supervisor starts `framework/bin/facade daemon`, expects a ping every
//! second, kills a daemon that goes quiet for [`PING_TIMEOUT`], and schedules the next start with
//! exponential backoff once a daemon ends.

use std::os::fd::BorrowedFd;
use std::path::Path;
use std::time::{Duration, Instant};

use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
use facade_base::unix_process::{self, Observed, ProcessObservation};
use nix::sys::signal::Signal;
use nix::unistd::Pid;

use crate::log;
use crate::runtime::{MAX_RESTART_DELAY, MIN_RESTART_DELAY, PING_TIMEOUT, RESTART_DELAY_RESET};

pub(super) struct Supervisor {
    phase: Phase,
    /// Wait before the next start; doubles after each end, up to [`MAX_RESTART_DELAY`].
    backoff: Duration,
    /// Daemons the keeper forked that another daemon has since replaced. They are reaped when
    /// they exit so no zombie is left behind.
    retired: Vec<Pid>,
}

enum Phase {
    /// A daemon is up (or believed up) and being watched.
    Up(Watched),
    /// No daemon; the next one starts at this instant.
    Down(Instant),
}

struct Watched {
    process: ProcessIdentity,
    how: Notice,
    /// Start of watching; the watchdog counts from here until the first ping.
    from: Instant,
    last_ping: Option<Instant>,
    /// SIGKILL is sent and the end has not been seen yet.
    killed: bool,
}

/// How the keeper will notice the daemon's end.
enum Notice {
    /// The keeper forked it: SIGCHLD.
    Sigchld,
    /// Someone else did: a process descriptor.
    Descriptor(ProcessObservation),
    /// Someone else did and the system offers no descriptor: only the silence of its pings.
    Pings,
}

/// What the supervisor wants done at a given instant.
pub(super) enum Due {
    Nothing,
    /// The running daemon missed its pings.
    Watchdog,
    /// No daemon is running and it is time to start one.
    Start,
}

impl Supervisor {
    /// The state a new keeper begins in: watching the daemon that holds `framework/daemon.lock` (that
    /// daemon started this keeper), or about to start one.
    pub(super) fn new(framework: &Path, now: Instant) -> Supervisor {
        let phase = match service::live_holder(framework, Service::Daemon) {
            Ok(Some(process)) => observe(process, now),
            _ => Phase::Down(now),
        };
        Supervisor {
            phase,
            backoff: MIN_RESTART_DELAY,
            retired: Vec::new(),
        }
    }

    fn watched(&self) -> Option<&Watched> {
        match &self.phase {
            Phase::Up(watched) => Some(watched),
            Phase::Down(_) => None,
        }
    }

    pub(super) fn is_up(&self) -> bool {
        self.watched().is_some()
    }

    /// The pid of the watched daemon, for log lines. 0 when there is none.
    pub(super) fn pid(&self) -> u32 {
        self.watched().map_or(0, |watched| watched.process.pid)
    }

    /// The descriptor that turns readable when a daemon the keeper did not fork ends.
    pub(super) fn end_signal(&self) -> Option<BorrowedFd<'_>> {
        match &self.watched()?.how {
            Notice::Descriptor(watch) => watch.descriptor(),
            Notice::Sigchld | Notice::Pings => None,
        }
    }

    /// A proved daemon connected. If it is not the daemon being watched, it becomes the one; a
    /// forked daemon it replaces is kept for reaping.
    pub(super) fn connected(&mut self, process: &ProcessIdentity, now: Instant) {
        if self
            .watched()
            .is_some_and(|watched| &watched.process == process)
        {
            return;
        }
        if let Some(pid) = self.forked_pid() {
            self.retired.push(pid);
        }
        self.phase = observe(process.clone(), now);
    }

    /// The daemon's pid if the keeper forked it and it is still being watched.
    fn forked_pid(&self) -> Option<Pid> {
        let watched = self.watched()?;
        matches!(watched.how, Notice::Sigchld).then(|| Pid::from_raw(watched.process.pid as i32))
    }

    /// Starts the daemon through the launcher, so whichever build the launcher points at runs.
    pub(super) fn launch(&mut self, now: Instant) -> anyhow::Result<()> {
        let launcher = facade_base::programs::launcher("facade")?;
        let pid = service::launch(Service::Daemon, &launcher, &[])?.pid();
        // A daemon that died instantly has no birth to read. The keeper is still its parent and
        // reaps it by pid, so an empty birth is harmless here.
        let birth = unix_process::birth(pid)?.unwrap_or_default();
        log(
            "info",
            &format!("started daemon {pid} from {}", launcher.display()),
        );
        self.phase = Phase::Up(Watched {
            process: ProcessIdentity { pid, birth },
            how: Notice::Sigchld,
            from: now,
            last_ping: None,
            killed: false,
        });
        Ok(())
    }

    pub(super) fn ping(&mut self, now: Instant) {
        if let Phase::Up(watched) = &mut self.phase {
            watched.last_ping = Some(now);
        }
    }

    /// When [`Supervisor::due`] next has something to do.
    pub(super) fn deadline(&self) -> Option<Instant> {
        match &self.phase {
            Phase::Up(watched) if watched.killed => None,
            Phase::Up(watched) => Some(watched.last_ping.unwrap_or(watched.from) + PING_TIMEOUT),
            Phase::Down(at) => Some(*at),
        }
    }

    pub(super) fn due(&self, now: Instant) -> Due {
        match self.deadline() {
            Some(at) if at <= now && self.is_up() => Due::Watchdog,
            Some(at) if at <= now => Due::Start,
            _ => Due::Nothing,
        }
    }

    /// SIGKILL for a silent daemon. Returns true when the keeper must treat it as ended right
    /// away; for a forked daemon SIGCHLD will report the end instead.
    pub(super) fn kill(&mut self) -> bool {
        let Phase::Up(watched) = &mut self.phase else {
            return false;
        };
        watched.killed = true;
        let pid = watched.process.pid;
        let outcome = match &watched.how {
            Notice::Sigchld => {
                // Unreaped, so the pid cannot belong to anyone else yet.
                let _ = nix::sys::signal::kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
                return false;
            }
            Notice::Descriptor(watch) => watch.signal(Signal::SIGKILL),
            Notice::Pings => match ProcessObservation::open(&watched.process) {
                Ok(Observed::Watching(watch)) => watch.signal(Signal::SIGKILL),
                Ok(Observed::Ended) => Ok(false),
                Err(err) => Err(err),
            },
        };
        if let Err(err) = outcome {
            log("warn", &format!("SIGKILL to daemon {pid} failed: {err}"));
        }
        true
    }

    /// After SIGCHLD: reaps a forked daemon that has exited and returns how it ended, and reaps
    /// any retired daemons that have exited.
    pub(super) fn reap(&mut self) -> Option<String> {
        self.retired
            .retain(|pid| unix_process::reap_child(pid.as_raw()).is_none());
        let exit = unix_process::reap_child(self.forked_pid()?.as_raw())?;
        Some(match (exit.code, exit.signal) {
            (Some(code), _) => format!("ended with code {code}"),
            (None, Some(signal)) => format!("ended by {signal}"),
            (None, None) => "ended".into(),
        })
    }

    /// The daemon is gone. The next start waits the current backoff, which resets first if the
    /// daemon had been up for [`RESTART_DELAY_RESET`], and doubles afterwards.
    pub(super) fn ended(&mut self, now: Instant) {
        let lasted = self
            .watched()
            .is_some_and(|watched| now.duration_since(watched.from) >= RESTART_DELAY_RESET);
        if lasted {
            self.backoff = MIN_RESTART_DELAY;
        }
        self.phase = Phase::Down(now + self.backoff);
        self.backoff = MAX_RESTART_DELAY.min(self.backoff * 2);
    }
}

/// Starts watching a daemon the keeper did not fork. A daemon that is already gone means a new
/// one is due now.
fn observe(process: ProcessIdentity, now: Instant) -> Phase {
    let how = match ProcessObservation::open(&process) {
        Ok(Observed::Ended) => return Phase::Down(now),
        Ok(Observed::Watching(watch)) if watch.descriptor().is_some() => Notice::Descriptor(watch),
        Ok(Observed::Watching(_)) => {
            log(
                "warn",
                &format!(
                    "daemon {}: no process descriptor here; only its pings show it lives",
                    process.pid
                ),
            );
            Notice::Pings
        }
        Err(err) => {
            log(
                "warn",
                &format!(
                    "daemon {}: cannot watch its end ({err}); only its pings show it lives",
                    process.pid
                ),
            );
            Notice::Pings
        }
    };
    Phase::Up(Watched {
        process,
        how,
        from: now,
        last_ping: None,
        killed: false,
    })
}
