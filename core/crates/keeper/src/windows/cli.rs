//! One CLI the keeper holds on Windows: its process, whose end comes to the port as a wait
//! completion packet, and the keeper's copy of its terminal, which holds its job. The keeper writes
//! nothing to and reads nothing from the terminal; holding it is the whole point.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, OwnedHandle};
use std::time::{Duration, Instant};

use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::{HeldAgent, STOP_TIMEOUT, StartArgs};
use facade_base::process::{ProcessExit, ProcessIdentity};
use facade_base::terminal::PtyMaster;
use facade_base::unix_process::{self, Observed, ProcessObservation, WaitPacket};
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess};

use super::console::ConPty;
use super::port::Port;
use crate::log;

/// Pause before a failed kill is tried again.
const KILL_RETRY_DELAY: Duration = Duration::from_millis(100);

/// The exit code a killed CLI's processes get.
const KILLED_CODE: u32 = 1;

pub(super) struct Cli {
    agent: String,
    process: ProcessIdentity,
    /// The wait for its end, which completes under `key`; let go of before the process.
    _ended: WaitPacket,
    key: usize,
    /// The process, with the access a wait and its exit code need. Holding it keeps its ID from
    /// passing to another process.
    handle: OwnedHandle,
    master: PtyMaster,
    /// While a stop is under way: when the job is killed.
    kill_deadline: Option<Instant>,
}

impl Cli {
    /// Starts the CLI that `args` describes in a new console and returns it. Returns as soon as
    /// the program is running; it does not wait for the CLI.
    pub(super) fn spawn(
        args: &StartArgs,
        conpty: &ConPty,
        port: &mut Port,
    ) -> Result<Cli, ErrorBody> {
        let started = conpty.start(args, args.cols.max(2), args.rows.max(1))?;
        let pid = started.pid;
        let watched = unix_process::birth(pid).and_then(|birth| {
            let birth = birth.ok_or_else(|| io::Error::other("no such process"))?;
            let key = port.key();
            let ended = WaitPacket::arm(port.handle(), started.process.as_handle(), key)?;
            Ok((birth, key, ended))
        });
        let (birth, key, ended) = match watched {
            Ok(watched) => watched,
            Err(err) => {
                // SAFETY: the process is this keeper's own and has not ended, as its handle is
                // held; nobody else knows of it yet.
                unsafe { TerminateProcess(started.process.as_raw_handle(), KILLED_CODE) };
                return Err(ErrorBody::new(
                    Reason::Unavailable,
                    format!("could not watch {} ({pid}): {err}", args.command[0]),
                ));
            }
        };
        Ok(Cli {
            agent: args.agent.clone(),
            process: ProcessIdentity { pid, birth },
            handle: started.process,
            key,
            _ended: ended,
            master: started.master,
            kill_deadline: None,
        })
    }

    /// Takes over a CLI another keeper started, with the terminal the daemon handed in. None when
    /// that process is already gone.
    pub(super) fn adopt(
        agent: String,
        process: ProcessIdentity,
        master: PtyMaster,
        port: &mut Port,
    ) -> Result<Option<Cli>, ErrorBody> {
        let watch = match ProcessObservation::open(&process) {
            Ok(Observed::Ended) => return Ok(None),
            Ok(Observed::Watching(watch)) => watch,
            Err(err) => return Err(cannot_watch(&agent, &process, err)),
        };
        let key = port.key();
        let watched = watch.as_handle().try_clone_to_owned().and_then(|handle| {
            let ended = WaitPacket::arm(port.handle(), handle.as_handle(), key)?;
            Ok((handle, ended))
        });
        let (handle, ended) = watched.map_err(|err| cannot_watch(&agent, &process, err))?;
        Ok(Some(Cli {
            agent,
            process,
            handle,
            key,
            _ended: ended,
            master,
            kill_deadline: None,
        }))
    }

    pub(super) fn process(&self) -> &ProcessIdentity {
        &self.process
    }

    /// The key the CLI's end completes under.
    pub(super) fn key(&self) -> usize {
        self.key
    }

    /// The keeper's copy of the terminal.
    pub(super) fn master(&self) -> &PtyMaster {
        &self.master
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

    pub(super) fn is_stopping(&self) -> bool {
        self.kill_deadline.is_some()
    }

    pub(super) fn kill_deadline(&self) -> Option<Instant> {
        self.kill_deadline
    }

    /// First step of a stop: hangs up by closing the keeper's copy of the signal pipe, after the
    /// daemon closed its own, so that the console ends and closes its programs; the job is killed
    /// at [`STOP_TIMEOUT`] unless the CLI ends sooner. Asking again changes nothing.
    pub(super) fn begin_stop(&mut self, now: Instant) {
        if self.is_stopping() {
            return;
        }
        self.master.let_go_before_stop();
        self.kill_deadline = Some(now + STOP_TIMEOUT);
    }

    /// Ends every process in the CLI's job. If that fails, it is tried again after
    /// [`KILL_RETRY_DELAY`].
    pub(super) fn kill_job(&mut self, now: Instant) {
        // SAFETY: the job's handle is open while the master is held.
        let killed = unsafe { TerminateJobObject(self.master.job().as_raw_handle(), KILLED_CODE) };
        self.kill_deadline = if killed != 0 {
            None
        } else {
            let err = io::Error::last_os_error();
            log(
                "warn",
                &format!(
                    "could not end {}'s CLI and its processes: {err}",
                    self.agent
                ),
            );
            Some(now + KILL_RETRY_DELAY)
        };
    }

    /// The CLI's exit, once its key completed.
    pub(super) fn exit(&self) -> ProcessExit {
        let mut code = 0u32;
        // SAFETY: the handle is open and allows reading the exit code.
        let read = unsafe { GetExitCodeProcess(self.handle.as_raw_handle(), &mut code) };
        ProcessExit {
            at: facade_base::time::iso_now(),
            // Carried as an i32: 0xC000013A is -1073741510.
            code: (read != 0).then_some(code as i32),
            signal: None,
            reason: None,
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

fn cannot_watch(agent: &str, process: &ProcessIdentity, err: io::Error) -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        format!("cannot watch {agent}'s CLI ({}): {err}", process.pid),
    )
}
