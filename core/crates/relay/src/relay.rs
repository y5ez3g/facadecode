//! The relay's one loop: it waits for a line from the CLI or the daemon and passes
//! it on. A request the daemon has not responded to is pending. When the daemon's connection
//! ends, as when a newer Facade takes over, the relay connects again, gives the next daemon the
//! pending requests, then the lines that came meanwhile. Where no one listens, it starts Facade
//! once for each time it is disconnected.

#[cfg(unix)]
use std::fs::File;
use std::io::{self, StdoutLock, Write};
use std::mem;
#[cfg(unix)]
use std::os::fd::AsFd;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::windows::{Events, Input};
#[cfg(unix)]
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

use crate::daemon::{self, DaemonLink, Hello};
use crate::jsonrpc::{self, Message};
use crate::lines::Lines;

/// The first wait before the relay tries a daemon again, and the longest.
const MIN_RECONNECT_DELAY: Duration = Duration::from_millis(100);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(2);

/// Writes a fact to standard error, where the CLI keeps what its MCP servers say.
pub(crate) fn log(level: &str, fact: &str) {
    eprintln!("facade-mcp: {level}: {fact}");
}

/// Relays between standard input and output and the daemon at `socket`, saying `hello`, until
/// the CLI's input ends and every request has its response, or no daemon is connected then.
pub(crate) fn run(socket: PathBuf, hello: Hello) -> ExitCode {
    #[cfg(unix)]
    let input = match io::stdin().as_fd().try_clone_to_owned() {
        Ok(input) => File::from(input),
        Err(err) => {
            log("error", &format!("cannot open its standard input: {err}"));
            return ExitCode::FAILURE;
        }
    };
    #[cfg(windows)]
    let (events, input) = match Events::new() {
        Ok(pair) => pair,
        Err(err) => {
            log("error", &format!("cannot open its standard input: {err}"));
            return ExitCode::FAILURE;
        }
    };
    let mut relay = Relay {
        socket,
        hello,
        input: Some(input),
        #[cfg(windows)]
        events,
        cli_lines: Lines::default(),
        output: io::stdout().lock(),
        daemon: Daemon::ended(),
        reconnect_delay: MIN_RECONNECT_DELAY,
        pending: Vec::new(),
        held: Vec::new(),
    };
    loop {
        if relay.is_done() {
            return ExitCode::SUCCESS;
        }
        relay.connect_when_due();
        #[cfg(unix)]
        let (cli_ready, daemon_ready) = relay.wait();
        #[cfg(windows)]
        let (cli_ready, daemon_ready) = match relay.wait() {
            Ok(ready) => ready,
            Err(err) => {
                log("error", &format!("cannot wait for input: {err}"));
                return ExitCode::FAILURE;
            }
        };
        if cli_ready {
            relay.read_cli();
        }
        if daemon_ready && relay.read_daemon().is_err() {
            return ExitCode::FAILURE;
        }
    }
}

/// The relay's daemon, as it stands.
enum Daemon {
    /// Connected: lines from the CLI go to it.
    Connected { link: DaemonLink },
    /// It said `closing`: lines from the CLI wait for the next daemon, and its responses still
    /// go to the CLI until it closes.
    Closing { link: DaemonLink },
    /// Not connected: the relay tries again at `next_try`. Since it was last connected, `logged`:
    /// it logged why; `started_facade`: it ran `facade daemon --detach`.
    Disconnected {
        next_try: Instant,
        logged: bool,
        started_facade: bool,
    },
}

impl Daemon {
    /// Not connected yet, or the connection ended: try at once.
    fn ended() -> Daemon {
        Daemon::Disconnected {
            next_try: Instant::now(),
            logged: false,
            started_facade: false,
        }
    }

    fn link(&mut self) -> Option<&mut DaemonLink> {
        match self {
            Daemon::Connected { link } | Daemon::Closing { link } => Some(link),
            Daemon::Disconnected { .. } => None,
        }
    }
}

/// A request the daemon has not responded to: its `id` as written, and its line.
struct Pending {
    id: Vec<u8>,
    line: Vec<u8>,
}

struct Relay {
    socket: PathBuf,
    hello: Hello,
    /// The CLI's input, until it ends.
    #[cfg(unix)]
    input: Option<File>,
    #[cfg(windows)]
    input: Option<Input>,
    #[cfg(windows)]
    events: Events,
    cli_lines: Lines,
    output: StdoutLock<'static>,
    daemon: Daemon,
    /// The wait before the next try: from the shortest, doubling up to the longest.
    reconnect_delay: Duration,
    pending: Vec<Pending>,
    /// Lines from the CLI that wait for a daemon to take them.
    held: Vec<Vec<u8>>,
}

impl Relay {
    /// The CLI's input ended, and no request waits for a connected daemon's response.
    fn is_done(&self) -> bool {
        let connected = !matches!(self.daemon, Daemon::Disconnected { .. });
        self.input.is_none() && (self.pending.is_empty() || !connected)
    }

    /// Blocks until the CLI's input or the daemon has something, or, while no daemon is
    /// connected, until it is time to try again. Gives which of the two has something.
    #[cfg(unix)]
    fn wait(&self) -> (bool, bool) {
        let cli = self
            .input
            .as_ref()
            .map(|input| PollFd::new(input.as_fd(), PollFlags::POLLIN));
        let (daemon, timeout) = match &self.daemon {
            Daemon::Connected { link } | Daemon::Closing { link } => (
                Some(PollFd::new(link.stream.as_fd(), PollFlags::POLLIN)),
                PollTimeout::NONE,
            ),
            Daemon::Disconnected { next_try, .. } => {
                let left = next_try.saturating_duration_since(Instant::now());
                let timeout = PollTimeout::try_from(left).unwrap_or(PollTimeout::MAX);
                (None, timeout)
            }
        };
        let (has_cli, has_daemon) = (cli.is_some(), daemon.is_some());
        let mut fds: Vec<PollFd> = cli.into_iter().chain(daemon).collect();
        if poll(&mut fds, timeout).is_err() {
            // Interrupted by a signal: the loop waits again.
            return (false, false);
        }
        let has_events = |fd: Option<&PollFd>| {
            fd.and_then(PollFd::revents)
                .is_some_and(|events| !events.is_empty())
        };
        (
            has_cli && has_events(fds.first()),
            has_daemon && has_events(fds.last()),
        )
    }

    #[cfg(windows)]
    fn wait(&mut self) -> io::Result<(bool, bool)> {
        let timeout = match self.daemon {
            Daemon::Disconnected { next_try, .. } => {
                Some(next_try.saturating_duration_since(Instant::now()))
            }
            _ => None,
        };
        self.events.wait(
            self.input.as_mut(),
            self.daemon.link().map(|link| &mut link.stream),
            timeout,
        )
    }

    /// Connects once the wait is over, and gives the daemon the pending requests, then the held
    /// lines. Where no one listens, it first starts Facade, once.
    fn connect_when_due(&mut self) {
        let Daemon::Disconnected {
            next_try,
            logged,
            mut started_facade,
        } = self.daemon
        else {
            return;
        };
        if Instant::now() < next_try {
            return;
        }
        let link = match self.open() {
            Ok(link) => link,
            Err(err) => {
                if !logged {
                    log("warn", &format!("{err}; trying again"));
                }
                let no_one_listens = matches!(
                    err.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                );
                let mut delay = self.reconnect_delay;
                self.reconnect_delay = (delay * 2).min(MAX_RECONNECT_DELAY);
                if no_one_listens && !started_facade {
                    started_facade = true;
                    match daemon::start_facade() {
                        Ok(()) => delay = Duration::ZERO,
                        Err(why) => log("warn", &format!("{why}; trying again")),
                    }
                }
                self.daemon = Daemon::Disconnected {
                    next_try: Instant::now() + delay,
                    logged: true,
                    started_facade,
                };
                return;
            }
        };
        if logged {
            log("info", "connected to Facade");
        }
        self.hello.reconnect = true;
        self.reconnect_delay = MIN_RECONNECT_DELAY;
        self.daemon = Daemon::Connected { link };
        for line in mem::take(&mut self.held) {
            self.handle_cli_line(line);
        }
    }

    /// Opens a link to the daemon and writes it the pending requests.
    fn open(&mut self) -> io::Result<DaemonLink> {
        let mut link = DaemonLink::open(
            &self.socket,
            &self.hello,
            #[cfg(windows)]
            &mut self.events,
        )?;
        for pending in &self.pending {
            link.stream.write_all(&pending.line).map_err(|err| {
                io::Error::other(format!(
                    "Facade closed as it took the pending requests: {err}"
                ))
            })?;
        }
        Ok(link)
    }

    /// Reads what the CLI wrote and passes each whole line on. A failed read counts as the end
    /// of the input.
    fn read_cli(&mut self) {
        let Some(input) = &mut self.input else {
            return;
        };
        if !matches!(self.cli_lines.fill(input), Ok(1..)) {
            self.input = None;
            return;
        }
        while let Some(line) = self.cli_lines.next_line() {
            self.handle_cli_line(line);
        }
    }

    /// Passes a line from the CLI on to the daemon, or holds it while no daemon takes lines.
    fn handle_cli_line(&mut self, line: Vec<u8>) {
        let Daemon::Connected { link } = &mut self.daemon else {
            self.held.push(line);
            return;
        };
        if link.stream.write_all(&line).is_err() {
            self.held.push(line);
            self.daemon = Daemon::ended();
            return;
        }
        if let Message::Request { id } = jsonrpc::read(&line) {
            let id = id.to_vec();
            self.pending.push(Pending { id, line });
        }
    }

    /// Reads what the daemon sent and handles each whole line. Fails where the CLI's output
    /// cannot be written.
    fn read_daemon(&mut self) -> io::Result<()> {
        let Some(link) = self.daemon.link() else {
            return Ok(());
        };
        if !matches!(link.lines.fill(&mut link.stream), Ok(1..)) {
            self.daemon = Daemon::ended();
            return Ok(());
        }
        while let Some(line) = self.daemon.link().and_then(|link| link.lines.next_line()) {
            self.handle_daemon_line(&line)?;
        }
        Ok(())
    }

    /// Responds to `closing`, or passes a line on to the CLI, a response ending its request.
    fn handle_daemon_line(&mut self, line: &[u8]) -> io::Result<()> {
        match jsonrpc::read(line) {
            Message::Notification {
                method: b"\"closing\"",
            } => {
                self.daemon = match mem::replace(&mut self.daemon, Daemon::ended()) {
                    Daemon::Connected { mut link } => {
                        // A failed write means the connection ended, which the next read finds;
                        // the relay connects again either way.
                        let _ = link.respond_to_closing();
                        Daemon::Closing { link }
                    }
                    daemon => daemon,
                };
                return Ok(());
            }
            Message::Response { id, .. } => {
                if let Some(at) = self.pending.iter().position(|pending| pending.id == id) {
                    self.pending.remove(at);
                }
            }
            Message::Request { .. } | Message::Notification { .. } | Message::Other => {}
        }
        self.output.write_all(line)?;
        self.output.flush()
    }
}
