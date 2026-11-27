//! Keeping one daemon alive on Windows. The supervisor starts `framework\bin\facade.exe daemon`,
//! expects a ping every second, ends a daemon that goes quiet for [`PING_TIMEOUT`], and schedules
//! the next start with exponential backoff once a daemon ended. A daemon's end comes to the port
//! as a wait completion packet.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
use facade_base::unix_process::{self, Observed, ProcessObservation, WaitPacket};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_TERMINATE, TerminateProcess,
};

use super::port::Port;
use crate::log;
use facade_base::startup::Attempt;

use crate::runtime::{
    self, MAX_RESTART_DELAY, MIN_RESTART_DELAY, PING_TIMEOUT, RESTART_DELAY_RESET,
};

/// The exit code of a daemon ended for its silence.
const KILLED_CODE: u32 = 1;

pub(super) struct Supervisor {
    phase: Phase,
    framework: PathBuf,
    startup: Option<Attempt>,
    /// Wait before the next start; doubles after each end, up to [`MAX_RESTART_DELAY`].
    backoff: Duration,
}

enum Phase {
    /// A daemon is up (or believed up) and being watched.
    Up(Box<Watched>),
    /// No daemon; the next one starts at this instant.
    Down(Instant),
}

struct Watched {
    process: ProcessIdentity,
    startup: Option<Attempt>,
    report: Option<service::StartupReport>,
    /// How its end is seen; None where it cannot be, and only its pings show it lives.
    end: Option<End>,
    /// Start of watching; the watchdog counts from here until the first ping.
    from: Instant,
    last_ping: Option<Instant>,
    /// It was ended and its end has not been seen yet.
    killed: bool,
}

/// A daemon's process and the wait for its end.
struct End {
    /// The wait, let go of before the process.
    _packet: WaitPacket,
    key: usize,
    /// The process, with the access a wait and its exit code need.
    handle: OwnedHandle,
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
    /// The state a new keeper begins in: watching the daemon that holds `framework\daemon.lock` (that
    /// daemon started this keeper), or about to start one.
    pub(super) fn new(
        framework: &Path,
        port: &mut Port,
        now: Instant,
        startup: Option<Attempt>,
    ) -> Supervisor {
        let mut phase = match service::live_holder(framework, Service::Daemon) {
            Ok(Some(process)) => observe(process, port, now),
            _ => Phase::Down(now),
        };
        let startup = startup.or_else(|| Attempt::current(framework));
        if let Phase::Up(watched) = &mut phase {
            (watched.startup, watched.last_ping) =
                runtime::watched_startup(startup.clone(), &watched.process, now);
        }
        Supervisor {
            phase,
            framework: framework.to_path_buf(),
            startup,
            backoff: MIN_RESTART_DELAY,
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

    /// Whether `key` is the watched daemon's end.
    pub(super) fn is_end(&self, key: usize) -> bool {
        self.watched()
            .and_then(|watched| watched.end.as_ref())
            .is_some_and(|end| end.key == key)
    }

    /// The exit code of the watched daemon once its wait completed.
    pub(super) fn exit_code(&self) -> Option<u32> {
        let end = self.watched()?.end.as_ref()?;
        let mut code = 0u32;
        // SAFETY: the handle is open and allows reading the exit code.
        (unsafe { GetExitCodeProcess(end.handle.as_raw_handle(), &mut code) } != 0).then_some(code)
    }

    /// A proved daemon connected. If it is not the daemon being watched, it becomes the one.
    pub(super) fn connected(&mut self, process: &ProcessIdentity, port: &mut Port, now: Instant) {
        if self
            .watched()
            .is_some_and(|watched| &watched.process == process)
        {
            return;
        }
        self.phase = observe(process.clone(), port, now);
        if let Phase::Up(watched) = &mut self.phase {
            (watched.startup, watched.last_ping) =
                runtime::watched_startup(Attempt::current(&self.framework), process, now);
        }
    }

    /// Starts the complete selected daemon image.
    pub(super) fn launch(&mut self, port: &mut Port, now: Instant) -> anyhow::Result<()> {
        let startup = match self.startup.take().filter(Attempt::can_continue) {
            Some(attempt) => attempt,
            None => Attempt::begin(&self.framework)?,
        };
        let (launcher, candidate) = facade_base::programs::start_daemon(&self.framework, &startup)?;
        let (process, report) = candidate.into_parts();
        let pid = process.pid();
        let _ = startup.record("keeper", "daemon process created");
        self.startup = Some(startup.clone());
        let started = process;
        // Holding the process keeps its ID, so a daemon that died at once still has a birth here.
        let birth = unix_process::birth(pid)?.unwrap_or_default();
        let process = ProcessIdentity { pid, birth };
        let _ = startup.daemon_created(&process);
        let handle = started.as_handle().try_clone_to_owned()?;
        let end = watch_end(handle, port)?;
        log(
            "info",
            &format!("started daemon {pid} from {}", launcher.display()),
        );
        self.phase = Phase::Up(Box::new(Watched {
            process,
            startup: Some(startup),
            report: Some(report),
            end: Some(end),
            from: now,
            last_ping: None,
            killed: false,
        }));
        Ok(())
    }

    pub(super) fn ping(&mut self, now: Instant) {
        if let Phase::Up(watched) = &mut self.phase {
            if watched.last_ping.is_none() {
                if !runtime::admit_first_ping(watched.startup.as_ref(), &watched.process) {
                    return;
                }
                log(
                    "info",
                    &format!(
                        "first authenticated ping from daemon {}",
                        watched.process.pid
                    ),
                );
            }
            watched.last_ping = Some(now);
        }
    }

    /// When [`Supervisor::due`] next has something to do.
    pub(super) fn deadline(&self) -> Option<Instant> {
        match &self.phase {
            Phase::Up(watched) if watched.killed => None,
            Phase::Up(watched) => Some(match (watched.last_ping, &watched.startup) {
                (Some(ping), _) => ping + PING_TIMEOUT,
                (None, Some(attempt)) => attempt.status().0.deadline(),
                (None, None) => watched.from + PING_TIMEOUT,
            }),
            Phase::Down(at) => Some(*at),
        }
    }

    pub(super) fn due(&self, now: Instant) -> Due {
        if self.watched().is_some_and(|watched| {
            !watched.killed
                && watched.last_ping.is_none()
                && watched
                    .startup
                    .as_ref()
                    .is_some_and(|attempt| attempt.status().0.exhausted())
        }) {
            return Due::Watchdog;
        }
        match self.deadline() {
            Some(at) if at <= now && self.is_up() => Due::Watchdog,
            Some(at) if at <= now => Due::Start,
            _ => Due::Nothing,
        }
    }

    /// Ends a silent daemon. Returns true when the keeper must treat it as ended right away;
    /// otherwise its end comes to the port, and the next daemon starts only after it, so that no
    /// two daemons take the terminals' ends at once.
    pub(super) fn kill(&mut self) -> bool {
        let Phase::Up(watched) = &mut self.phase else {
            return false;
        };
        watched.killed = true;
        let pid = watched.process.pid;
        if watched.end.is_none() {
            log(
                "warn",
                &format!("daemon {pid} cannot be watched, so it is not ended"),
            );
            return true;
        }
        if let Err(err) = terminate(pid) {
            log("warn", &format!("ending daemon {pid} failed: {err}"));
        }
        false
    }

    pub(super) fn waited_for_startup(&self) -> bool {
        self.watched()
            .is_some_and(|watched| watched.startup.is_some() && watched.last_ping.is_none())
    }

    pub(super) fn report_end(&mut self, how: &str, restarting: bool) {
        let Phase::Up(watched) = &mut self.phase else {
            return;
        };
        let Some(attempt) = &watched.startup else {
            return;
        };
        let report = watched
            .report
            .as_mut()
            .and_then(|report| report.read(Duration::ZERO));
        let reason = match &report {
            Some(service::Report::Failed(error)) => error.as_str(),
            Some(service::Report::Contention) => return,
            _ => how,
        };
        if restarting {
            let _ = attempt.fail_daemon(
                &watched.process,
                self.framework.join("logs/daemon.log"),
                reason,
            );
        } else {
            let _ = attempt.finish(&self.framework, &watched.process, reason);
        }
    }

    /// Schedules a proved clean takeover immediately. Other ends use the crash backoff.
    pub(super) fn ended(&mut self, now: Instant, clean_exit: bool) {
        if clean_exit
            && self
                .watched()
                .is_some_and(|watched| watched.last_ping.is_some())
            && facade_base::programs::clean_takeover_published(&self.framework)
        {
            self.phase = Phase::Down(now);
            self.backoff = MIN_RESTART_DELAY;
            log(
                "info",
                "scheduled an immediate restart for the clean takeover",
            );
            return;
        }
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

/// Starts watching a daemon the keeper did not start. A daemon that is already gone means a new
/// one is due now.
fn observe(process: ProcessIdentity, port: &mut Port, now: Instant) -> Phase {
    let end = match ProcessObservation::open(&process) {
        Ok(Observed::Ended) => return Phase::Down(now),
        Ok(Observed::Watching(watch)) => watch
            .as_handle()
            .try_clone_to_owned()
            .and_then(|handle| watch_end(handle, port)),
        Err(err) => Err(err),
    };
    let end = match end {
        Ok(end) => Some(end),
        Err(err) => {
            log(
                "warn",
                &format!(
                    "daemon {}: cannot watch its end ({err}); only its pings show it lives",
                    process.pid
                ),
            );
            None
        }
    };
    Phase::Up(Box::new(Watched {
        process,
        startup: None,
        report: None,
        end,
        from: now,
        last_ping: None,
        killed: false,
    }))
}

/// Arms the wait for the end of the process `handle` under a new key.
fn watch_end(handle: OwnedHandle, port: &mut Port) -> io::Result<End> {
    let key = port.key();
    let packet = WaitPacket::arm(port.handle(), handle.as_handle(), key)?;
    Ok(End {
        handle,
        key,
        _packet: packet,
    })
}

/// Ends process `pid`, which the keeper holds a handle to, so the ID is still that process's.
fn terminate(pid: u32) -> io::Result<()> {
    // SAFETY: opens a new handle, owned here alone.
    let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle was just opened for this process alone.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    // SAFETY: the handle is open and allows ending the process.
    if unsafe { TerminateProcess(process.as_raw_handle(), KILLED_CODE) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
