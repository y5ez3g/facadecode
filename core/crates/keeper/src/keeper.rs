//! The keeper's state and its loop. Each turn of the loop: work out the nearest deadline, sleep in
//! `poll`, then deal with whatever woke it (signals first, then sockets and ended processes), and
//! finally with every deadline that has passed. Anything that takes time is a deadline or an
//! event; the loop itself never waits on anything but `poll`.

mod requests;

use std::collections::HashMap;
use std::io;
use std::os::fd::{AsFd, BorrowedFd};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use facade_base::api_v1::keeper::{AgentChange, methods};
use facade_base::api_v1::{ErrorBody, Notification, ProcessExit, Response};
use serde::Serialize;

use crate::cli::{Cli, exit_unknown};
use crate::link::{Inbound, Link};
use crate::supervisor::{Due, Supervisor};
use crate::wake::Wake;
use crate::{log, prune_log_if_due};

/// Back-off after `poll` itself fails, so a lasting failure cannot spin the CPU.
const WAIT_ERROR_DELAY: Duration = Duration::from_millis(100);

pub(super) struct Keeper {
    /// `<home>/core`, where the lock files live.
    core: PathBuf,
    /// The listening socket's path, removed on exit.
    socket: PathBuf,
    listener: UnixListener,
    wake: Wake,
    supervisor: Supervisor,
    next_log_prune: Instant,
    /// The current daemon's connection; a newly proved one takes its place.
    link: Option<Link>,
    /// The CLIs held, by agent ID.
    clis: HashMap<String, Cli>,
}

/// What a polled descriptor stands for.
#[derive(Clone)]
enum Source {
    Listener,
    Link,
    /// A handed-over CLI ended.
    Cli(String),
    /// A daemon the keeper did not fork ended.
    Daemon,
}

impl Keeper {
    /// Sets up the keeper once it owns the keeper lock: signal handling, the open-files limit the
    /// CLIs will inherit, and the socket (any file already at that path is left over from a dead
    /// keeper, since this one holds the lock).
    pub(super) fn bind(core: PathBuf) -> anyhow::Result<Keeper> {
        facade_base::limits::raise_open_files();
        // SAFETY: SIG_IGN installs no handler code.
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
        }
        let wake = Wake::install()?;
        let socket = facade_base::paths::keeper_socket()?;
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket)?;
        listener.set_nonblocking(true)?;
        log(
            "info",
            &format!(
                "build {} serving on {}",
                facade_base::build_id(),
                socket.display()
            ),
        );
        let now = Instant::now();
        let supervisor = Supervisor::new(&core, now);
        Ok(Keeper {
            core,
            socket,
            listener,
            wake,
            supervisor,
            next_log_prune: now,
            link: None,
            clis: HashMap::new(),
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
        let (sources, woken) = {
            let Keeper {
                listener,
                wake,
                supervisor,
                link,
                clis,
                ..
            } = self;
            let mut fds: Vec<BorrowedFd<'_>> = vec![listener.as_fd()];
            let mut sources = vec![Source::Listener];
            if let Some(link) = link {
                fds.push(link.readable());
                sources.push(Source::Link);
            }
            for (agent, cli) in clis.iter() {
                if let Some(fd) = cli.end_signal() {
                    fds.push(fd);
                    sources.push(Source::Cli(agent.clone()));
                }
            }
            if let Some(fd) = supervisor.end_signal() {
                fds.push(fd);
                sources.push(Source::Daemon);
            }
            (sources, wake.wait(&fds, deadline))
        };
        let woken = match woken {
            Ok(woken) => woken,
            Err(err) => {
                log("error", &format!("poll failed: {err}"));
                std::thread::sleep(WAIT_ERROR_DELAY);
                return;
            }
        };
        // Exits are collected before a shutdown, so the daemon still hears of them.
        if woken.sigchld {
            self.collect_children();
        }
        if woken.shutdown {
            self.shut_down();
        }
        for position in woken.ready {
            match sources[position].clone() {
                Source::Listener => self.accept_all(),
                Source::Link => self.read_link(),
                Source::Cli(agent) => self.cli_ended(&agent, exit_unknown()),
                Source::Daemon => self.daemon_gone("ended", Instant::now()),
            }
        }
        self.on_deadlines(Instant::now());
    }

    /// Takes every pending connection; each one the daemon proves becomes the link.
    fn accept_all(&mut self) {
        loop {
            match self.listener.accept() {
                Ok((socket, _)) => {
                    if let Some(link) = Link::prove(socket, &self.core) {
                        let daemon = link.daemon().clone();
                        log("info", &format!("daemon {} connected", daemon.pid));
                        self.supervisor.connected(&daemon, Instant::now());
                        self.link = Some(link);
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => return,
                Err(err) => {
                    log("warn", &format!("accept failed: {err}"));
                    return;
                }
            }
        }
    }

    fn read_link(&mut self) {
        let Some(link) = &mut self.link else {
            return;
        };
        for inbound in link.drain() {
            match inbound {
                Inbound::Line(text, attached) => self.serve_line(&text, attached),
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

    /// Writes one message to the daemon. A link that cannot take it is dropped.
    fn post(&mut self, message: &impl Serialize, fd: Option<BorrowedFd<'_>>) {
        let Some(link) = &self.link else {
            return;
        };
        if let Err(err) = link.write(message, fd) {
            log("warn", &format!("dropped the daemon's connection: {err}"));
            self.link = None;
        }
    }

    /// Tells a daemon that has said hello that a CLI ended.
    fn report_exit(&mut self, agent: &str, exit: ProcessExit) {
        if self.link.as_ref().and_then(Link::api_version).is_none() {
            return;
        }
        let change = AgentChange::Exit {
            agent_id: agent.to_string(),
            exit,
        };
        self.post(&Notification::new(methods::CHANGED, change), None);
    }

    /// After SIGCHLD: every forked CLI that exited, then the forked daemon.
    fn collect_children(&mut self) {
        let exited: Vec<(String, ProcessExit)> = self
            .clis
            .iter()
            .filter_map(|(agent, cli)| cli.exited().map(|exit| (agent.clone(), exit)))
            .collect();
        for (agent, exit) in exited {
            self.cli_ended(&agent, exit);
        }
        if let Some(how) = self.supervisor.reap() {
            self.daemon_gone(&how, Instant::now());
        }
    }

    /// A CLI ended. If it was being stopped, the rest of its group gets SIGKILL now, while the
    /// unreaped leader can still prove whose group it is. Then the keeper lets go and tells the
    /// daemon.
    fn cli_ended(&mut self, agent: &str, exit: ProcessExit) {
        let Some(mut cli) = self.clis.remove(agent) else {
            return;
        };
        if cli.is_parent() && cli.is_stopping() {
            cli.kill_group(Instant::now());
        }
        cli.forget();
        log("info", &format!("{agent}'s CLI ended"));
        self.report_exit(agent, exit);
    }

    fn on_deadlines(&mut self, now: Instant) {
        for cli in self.clis.values_mut() {
            if cli.kill_deadline().is_some_and(|at| at <= now) {
                cli.kill_group(now);
            }
        }
        match self.supervisor.due(now) {
            Due::Nothing => {}
            Due::Watchdog => {
                let pid = self.supervisor.pid();
                log(
                    "warn",
                    &format!("daemon {pid} sent no ping for 15 seconds; sending SIGKILL"),
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
        if let Err(err) = self.supervisor.launch(now) {
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

    /// SIGTERM or SIGINT. CLIs in the middle of a stop are killed now, since nobody will be left
    /// to do it at their deadline; every other CLI keeps running.
    fn shut_down(&mut self) -> ! {
        let now = Instant::now();
        for cli in self.clis.values_mut().filter(|cli| cli.is_stopping()) {
            cli.kill_group(now);
        }
        self.exit("asked to end");
    }

    fn exit(&self, why: &str) -> ! {
        log("info", &format!("exiting: {why}"));
        let _ = std::fs::remove_file(&self.socket);
        std::process::exit(0)
    }
}
