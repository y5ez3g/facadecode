//! One CLI the keeper holds on Windows: its process, whose end comes to the port as a wait
//! completion packet, and the keeper's copy of its terminal, which holds its job. The keeper writes
//! nothing to and reads nothing from the terminal; holding it is the whole point.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, OwnedHandle};
use std::time::{Duration, Instant};

use facade_base::api_v1::ProcessExit;
use facade_base::api_v1::keeper::HeldAgent;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::process::ProcessIdentity;
use facade_base::terminal::PtyMaster;
use facade_base::unix_process::{self, Observed, Presence, ProcessObservation, WaitPacket};
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess};

use super::console::ConPty;
use super::port::Port;
use crate::log;
use crate::runtime::{KeeperStartArgs, STOP_TIMEOUT};

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

pub(super) enum Adoption {
    Held(Cli),
    Ended(ProcessExit),
}

impl Cli {
    /// Starts the CLI that `args` describes in a new console and returns it. Returns as soon as
    /// the program is running; it does not wait for the CLI.
    pub(super) fn spawn(
        args: &KeeperStartArgs,
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
                    format!("could not watch {} ({pid}): {err}", args.launch.program),
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

    /// Takes over a CLI another keeper started, with the terminal the daemon handed in. A live
    /// process with a different birth cannot be adopted.
    pub(super) fn adopt(
        agent: String,
        process: ProcessIdentity,
        master: PtyMaster,
        port: &mut Port,
    ) -> Result<Adoption, ErrorBody> {
        let watch_error = |err| cannot_watch(&agent, &process, err);
        let Some(birth) = unix_process::birth(process.pid).map_err(watch_error)? else {
            return Ok(Adoption::Ended(process_exit(None)));
        };
        if birth != process.birth {
            let current = ProcessIdentity {
                pid: process.pid,
                birth,
            };
            if unix_process::presence(&current).map_err(watch_error)? == Presence::Running {
                return Err(ErrorBody::invalid_argument(format!(
                    "{agent}'s CLI birth does not match process {}",
                    process.pid
                )));
            }
            return Ok(Adoption::Ended(process_exit(None)));
        }
        let watch = match ProcessObservation::open(&process).map_err(watch_error)? {
            Observed::Ended => return Ok(Adoption::Ended(process_exit(None))),
            Observed::Watching(watch) => watch,
        };
        if watch.ended().map_err(watch_error)? == Some(true) {
            return Ok(Adoption::Ended(process_exit(Some(watch.as_handle()))));
        }
        let key = port.key();
        let watched = watch.as_handle().try_clone_to_owned().and_then(|handle| {
            let ended = WaitPacket::arm(port.handle(), handle.as_handle(), key)?;
            Ok((handle, ended))
        });
        let (handle, ended) = watched.map_err(watch_error)?;
        Ok(Adoption::Held(Cli {
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
            agent_id: self.agent.clone(),
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
        process_exit(Some(self.handle.as_handle()))
    }
}

fn process_exit(handle: Option<BorrowedHandle<'_>>) -> ProcessExit {
    let code = handle.and_then(|handle| {
        let mut code = 0u32;
        // SAFETY: the handle is open and allows reading the exit code.
        let read = unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) };
        // Carried as an i32: 0xC000013A is -1073741510.
        (read != 0).then_some(code as i32)
    });
    ProcessExit {
        at: facade_base::time::iso_now(),
        code,
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
