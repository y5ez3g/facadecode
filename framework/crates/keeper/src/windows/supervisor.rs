//! Keeping one daemon alive on Windows. The supervisor starts `framework\bin\facade.exe daemon`,
//! expects a ping every second, ends a daemon that goes quiet for [`PING_TIMEOUT`], and schedules
//! the next start with exponential backoff once a daemon ended. A daemon's end comes to the port
//! as a wait completion packet.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::time::{Duration, Instant};

use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
use facade_base::unix_process::{self, Observed, ProcessObservation, WaitPacket};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_TERMINATE, TerminateProcess,
};

use super::port::Port;
use crate::log;
use crate::runtime::{MAX_RESTART_DELAY, MIN_RESTART_DELAY, PING_TIMEOUT, RESTART_DELAY_RESET};

/// The exit code of a daemon ended for its silence.
const KILLED_CODE: u32 = 1;

pub(super) struct Supervisor {
    phase: Phase,
    /// Wait before the next start; doubles after each end, up to [`MAX_RESTART_DELAY`].
    backoff: Duration,
}

enum Phase {
    /// A daemon is up (or believed up) and being watched.
    Up(Watched),
    /// No daemon; the next one starts at this instant.
    Down(Instant),
}

struct Watched {
    process: ProcessIdentity,
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
    pub(super) fn new(framework: &Path, port: &mut Port, now: Instant) -> Supervisor {
        let phase = match service::live_holder(framework, Service::Daemon) {
            Ok(Some(process)) => observe(process, port, now),
            _ => Phase::Down(now),
        };
        Supervisor {
            phase,
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

    /// How the watched daemon ended, once its key completed.
    pub(super) fn how_it_ended(&self) -> String {
        let Some(end) = self.watched().and_then(|watched| watched.end.as_ref()) else {
            return "ended".into();
        };
        let mut code = 0u32;
        // SAFETY: the handle is open and allows reading the exit code.
        if unsafe { GetExitCodeProcess(end.handle.as_raw_handle(), &mut code) } == 0 {
            return "ended".into();
        }
        format!("ended with code {}", code as i32)
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
    }

    /// Starts the daemon through the launcher, so whichever build the launcher points at runs.
    pub(super) fn launch(&mut self, port: &mut Port, now: Instant) -> anyhow::Result<()> {
        let launcher = facade_base::programs::launcher(facade_base::programs::PROGRAMS[0])?;
        let started = service::launch(Service::Daemon, &launcher, &[])?.into_process();
        let pid = started.pid();
        // Holding the process keeps its ID, so a daemon that died at once still has a birth here.
        let birth = unix_process::birth(pid)?.unwrap_or_default();
        let handle = started.as_handle().try_clone_to_owned()?;
        let end = watch_end(handle, port)?;
        log(
            "info",
            &format!("started daemon {pid} from {}", launcher.display()),
        );
        self.phase = Phase::Up(Watched {
            process: ProcessIdentity { pid, birth },
            end: Some(end),
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
    Phase::Up(Watched {
        process,
        end,
        from: now,
        last_ping: None,
        killed: false,
    })
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
