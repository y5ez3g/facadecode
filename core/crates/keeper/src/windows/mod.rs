//! The keeper on Windows: its state and its loop. Each turn of the loop works out the nearest
//! deadline, sleeps on the completion port, deals with whatever completed (a connection, the
//! link's read, a CLI's or the daemon's end), and finally with every deadline that has passed.
//! Anything that takes time is a deadline or a completion; the loop itself never waits on
//! anything but the port, except for a write to the daemon, for a second at most.

mod cli;
mod console;
mod link;
mod port;
mod requests;
mod supervisor;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use facade_base::jsonrpc::{ErrorBody, Notification, Response};
use facade_base::keeper::{KeeperAgentChange, methods};
use facade_base::process::ProcessExit;
use serde::Serialize;

use self::cli::Cli;
use self::console::ConPty;
use self::link::{Inbound, Link, Listener};
use self::port::Port;
use self::supervisor::{Due, Supervisor};
use crate::{log, prune_log_if_due};

/// Back-off after the wait itself fails, so a lasting failure cannot spin the CPU.
const WAIT_ERROR_DELAY: Duration = Duration::from_millis(100);

pub(super) struct Keeper {
    /// `<home>\core`, where the lock files live.
    core: PathBuf,
    /// The keeper's pipe.
    socket: PathBuf,
    port: Port,
    /// The pipe instance waiting for the next connection.
    listener: Listener,
    supervisor: Supervisor,
    next_log_prune: Instant,
    /// The current daemon's connection; a newly proved one takes its place.
    link: Option<Link>,
    /// The CLIs held, by agent ID.
    clis: HashMap<String, Cli>,
    /// The ConPTY package, from the first start on.
    conpty: Option<ConPty>,
}

impl Keeper {
    /// Sets up the keeper once it owns the keeper lock: the completion port, the first instance
    /// of its pipe, and the daemon it finds running.
    pub(super) fn bind(core: PathBuf) -> anyhow::Result<Keeper> {
        let mut port = Port::new()?;
        let socket = facade_base::paths::keeper_socket()?;
        let listener = Listener::open(&socket, &mut port)?;
        log(
            "info",
            &format!(
                "build {} serving on {}",
                facade_base::build_id(),
                socket.display()
            ),
        );
        let now = Instant::now();
        let supervisor = Supervisor::new(&core, &mut port, now);
        Ok(Keeper {
            core,
            socket,
            port,
            listener,
            supervisor,
            next_log_prune: now,
            link: None,
            clis: HashMap::new(),
            conpty: None,
        })
    }

    /// Serves forever; the process exits from inside the loop.
    pub(super) fn run(mut self) -> ! {
        if !self.supervisor.is_up() {
            self.start_daemon(Instant::now());
        }
        loop {
            self.turn();
        }
    }

    fn turn(&mut self) {
        let deadline = self
            .clis
            .values()
            .filter_map(Cli::kill_deadline)
            .chain(self.supervisor.deadline())
            .chain([self.next_log_prune])
            .min();
        let keys = match self.port.wait(deadline) {
            Ok(keys) => keys,
            Err(err) => {
                log(
                    "error",
                    &format!("waiting on the completion port failed: {err}"),
                );
                std::thread::sleep(WAIT_ERROR_DELAY);
                return;
            }
        };
        for key in keys {
            self.completed(key);
        }
        self.on_deadlines(Instant::now());
    }

    /// Deals with what completed under `key`. A key nothing holds any more belongs to something
    /// already let go of, and is ignored.
    fn completed(&mut self, key: usize) {
        if key == self.listener.key() {
            self.accept();
        } else if self.link.as_ref().is_some_and(|link| link.key() == key) {
            self.read_link();
        } else if self.supervisor.is_end(key) {
            let how = self.supervisor.how_it_ended();
            self.daemon_gone(&how, Instant::now());
        } else if let Some((agent, cli)) = self.clis.iter().find(|(_, cli)| cli.key() == key) {
            let (agent, exit) = (agent.clone(), cli.exit());
            self.cli_ended(&agent, exit);
        }
    }

    /// Takes the connection that came; one the daemon proves becomes the link. The next instance
    /// of the pipe waits for the next connection.
    fn accept(&mut self) {
        let next = match Listener::open(&self.socket, &mut self.port) {
            Ok(next) => next,
            Err(err) => self.exit(&format!(
                "could not listen on {}: {err}",
                self.socket.display()
            )),
        };
        let (pipe, key) = std::mem::replace(&mut self.listener, next).into_connected();
        if let Some(link) = Link::prove(pipe, key, &self.core) {
            let daemon = link.daemon().clone();
            log("info", &format!("daemon {} connected", daemon.pid));
            self.supervisor
                .connected(&daemon, &mut self.port, Instant::now());
            self.link = Some(link);
        }
    }

    fn read_link(&mut self) {
        let Some(link) = &mut self.link else {
            return;
        };
        for inbound in link.drain() {
            match inbound {
                Inbound::Line(text) => self.serve_line(&text),
                Inbound::Overlong => {
                    self.post(&Response::failed(None, ErrorBody::line_too_long()), None);
                    self.link = None;
                }
                Inbound::Closed => self.link = None,
            }
            if self.link.is_none() {
                return;
            }
        }
    }

    /// Writes one message to the daemon, with the terminal of the CLI `agent` if given. A link
    /// that cannot take it is dropped.
    fn post(&mut self, message: &impl Serialize, agent: Option<&str>) {
        let Keeper { link, clis, .. } = self;
        let Some(open) = link else {
            return;
        };
        let terminal = agent.and_then(|agent| clis.get(agent)).map(Cli::master);
        if let Err(err) = open.write(message, terminal) {
            log("warn", &format!("dropped the daemon's connection: {err}"));
            *link = None;
        }
    }

    /// Tells a daemon that has said hello that a CLI ended.
    fn report_exit(&mut self, agent: &str, exit: ProcessExit) {
        if !self.link.as_ref().is_some_and(Link::is_greeted) {
            return;
        }
        let change = KeeperAgentChange::Exit {
            agent: agent.to_string(),
            exit,
        };
        self.post(&Notification::new(methods::CHANGED, change), None);
    }

    /// A CLI ended. If it was being stopped, the rest of its job is ended now. Then the keeper
    /// lets go of its terminal and tells the daemon.
    fn cli_ended(&mut self, agent: &str, exit: ProcessExit) {
        let Some(mut cli) = self.clis.remove(agent) else {
            return;
        };
        if cli.is_stopping() {
            cli.kill_job(Instant::now());
        }
        drop(cli);
        log("info", &format!("{agent}'s CLI ended"));
        self.report_exit(agent, exit);
    }

    fn on_deadlines(&mut self, now: Instant) {
        for cli in self.clis.values_mut() {
            if cli.kill_deadline().is_some_and(|at| at <= now) {
                cli.kill_job(now);
            }
        }
        match self.supervisor.due(now) {
            Due::Nothing => {}
            Due::Watchdog => {
                let pid = self.supervisor.pid();
                log(
                    "warn",
                    &format!("daemon {pid} sent no ping for 15 seconds; ending it"),
                );
                if self.supervisor.kill() {
                    self.daemon_gone("was ended by the watchdog", now);
                }
            }
            Due::Start => {
                if self.clis.is_empty() {
                    self.exit("no daemon runs and no CLI is held");
                }
                self.start_daemon(now);
            }
        }
        prune_log_if_due(&self.core, now, &mut self.next_log_prune);
    }

    /// Launches the daemon; a failed launch counts as a daemon that ended at once, so the backoff
    /// schedules the next try.
    fn start_daemon(&mut self, now: Instant) {
        if let Err(err) = self.supervisor.launch(&mut self.port, now) {
            log("error", &format!("could not start the daemon: {err:#}"));
            self.supervisor.ended(now);
        }
    }

    /// The daemon is gone. With no CLI to look after the keeper has nothing left to do and exits;
    /// otherwise a new daemon is scheduled.
    fn daemon_gone(&mut self, how: &str, now: Instant) {
        let pid = self.supervisor.pid();
        if self.clis.is_empty() {
            self.exit(&format!("daemon {pid} {how} and no CLI is held"));
        }
        self.supervisor.ended(now);
        let held = self.clis.len();
        log(
            "warn",
            &format!("daemon {pid} {how}; the keeper holds {held} CLIs and starts another"),
        );
    }

    fn exit(&self, why: &str) -> ! {
        log("info", &format!("exiting: {why}"));
        std::process::exit(0)
    }
}
