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
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use crate::windows::{Events, Input};
#[cfg(unix)]
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
#[cfg(unix)]
use nix::time::{ClockId, clock_gettime};

use crate::daemon::{self, DaemonLink, OpeningLink, RelayHelloParams};
use crate::jsonrpc::{self, Id, Message};
use crate::lines::Lines;
use crate::socket::Destination;
use crate::startup::{self, Task, Ticket};
#[cfg(unix)]
use crate::unix::ready_input_bytes;
#[cfg(windows)]
pub(crate) use crate::windows::monotonic_now;

/// The first wait before the relay tries a daemon again, and the longest.
const MIN_RECONNECT_DELAY: Duration = Duration::from_millis(100);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(2);

/// Writes a fact to standard error, where the CLI keeps what its MCP servers say.
pub(crate) fn log(level: &str, fact: &str) {
    eprintln!("facade-mcp: {level}: {fact}");
}

/// Relays between standard input and output and the daemon at `socket`, saying `hello`, until
/// the CLI's input ends and every request has its response, or no daemon is connected then.
pub(crate) fn run(destination: Destination, hello: RelayHelloParams) -> ExitCode {
    let Destination {
        home,
        socket,
        installed,
    } = destination;
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
        framework: home.join("framework"),
        home,
        socket,
        installed,
        launched_for: None,
        launched_shell: None,
        launch: None,
        opening: None,
        startup: None,
        notice_at: Instant::now(),
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
        let (cli_ready, daemon_ready) = match relay.wait() {
            Ok(ready) => ready,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => {
                log("error", &format!("cannot wait for input: {err}"));
                return ExitCode::FAILURE;
            }
        };
        if cli_ready {
            relay.read_cli(usize::MAX);
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
    Closing {
        link: DaemonLink,
        acknowledged: bool,
    },
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
            Daemon::Connected { link } | Daemon::Closing { link, .. } => Some(link),
            Daemon::Disconnected { .. } => None,
        }
    }
}

#[derive(Clone, Copy)]
enum Replay {
    First,
    Planned,
    Interrupted,
}

impl Replay {
    fn name(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Planned => "planned",
            Self::Interrupted => "interrupted",
        }
    }
}

/// A request that still needs a response.
struct Pending {
    id: Id,
    line: Vec<u8>,
    first_line_ns: u64,
    replay: Replay,
    cancelled: bool,
}

impl Pending {
    fn lost(&mut self, replay: Replay) {
        if !matches!(self.replay, Replay::Interrupted) {
            self.replay = replay;
        }
    }

    fn write_to(&self, link: &mut DaemonLink) -> io::Result<()> {
        if !link.request_context {
            return link.stream.write_all(&self.line);
        }
        let mut frame = Vec::with_capacity(self.line.len() + 128);
        write!(
            frame,
            "{{\"relay_request\":{{\"first_line_ns\":{},\"replay\":\"{}\",\"cancelled\":{}}},\"request\":",
            self.first_line_ns,
            self.replay.name(),
            self.cancelled,
        )?;
        frame.extend_from_slice(self.line.trim_ascii());
        frame.extend_from_slice(b"}\n");
        link.stream.write_all(&frame)
    }
}

enum ClientLine {
    Request(Pending),
    Other(Vec<u8>),
}

enum StartupReadiness {
    Waiting(Instant),
    Ready(Instant),
}

/// The published Shell, which can change while this relay continues to run.
#[derive(PartialEq, Eq)]
struct ShellPublication {
    image: PathBuf,
    bytes: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

impl ShellPublication {
    fn read(program: &Path) -> Option<Self> {
        let image = program.canonicalize().ok()?;
        let metadata = image.metadata().ok()?;
        Some(Self {
            image,
            bytes: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
        })
    }
}

struct Relay {
    framework: PathBuf,
    home: PathBuf,
    socket: PathBuf,
    installed: bool,
    /// The lock holder seen when we last asked the installed Shell for the socket.
    launched_for: Option<(u32, String)>,
    /// The Shell available at that time. It may be published after the relay.
    launched_shell: Option<ShellPublication>,
    launch: Option<Task<daemon::StartReport>>,
    opening: Option<Task<OpeningLink>>,
    startup: Option<Ticket>,
    notice_at: Instant,
    hello: RelayHelloParams,
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
    held: Vec<ClientLine>,
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
    fn wait(&self) -> io::Result<(bool, bool)> {
        let cli = self
            .input
            .as_ref()
            .map(|input| PollFd::new(input.as_fd(), PollFlags::POLLIN));
        let (daemon, timeout) = match &self.daemon {
            Daemon::Connected { link } | Daemon::Closing { link, .. } => (
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
        let startup = self
            .launch
            .as_ref()
            .map(|launch| launch.wake.as_fd())
            .or_else(|| self.opening.as_ref().map(|open| open.wake.as_fd()))
            .map(|fd| PollFd::new(fd, PollFlags::POLLIN));
        let mut fds: Vec<PollFd> = cli.into_iter().chain(daemon).chain(startup).collect();
        poll(&mut fds, timeout)?;
        let has_events = |fd: Option<&PollFd>| {
            fd.and_then(PollFd::revents)
                .is_some_and(|events| !events.is_empty())
        };
        Ok((
            has_cli && has_events(fds.first()),
            has_daemon && has_events(fds.get(usize::from(has_cli))),
        ))
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
            self.launch.is_some() || self.opening.is_some(),
        )
    }

    /// Observes the background launcher and resumes the original input loop while it is pending.
    fn connect_when_due(&mut self) {
        let Daemon::Disconnected {
            next_try,
            logged,
            started_facade,
        } = self.daemon
        else {
            return;
        };
        if let Some(launch) = &self.launch {
            let Some(result) = launch.completed() else {
                self.retry_at(Instant::now() + MIN_RECONNECT_DELAY, logged, started_facade);
                return;
            };
            self.launch = None;
            match result {
                Ok(report) => {
                    if let Some(socket) = report.socket {
                        self.socket = socket;
                    }
                    self.startup = report.ticket;
                }
                Err(why) => log("warn", &format!("{why}; trying again")),
            }
        } else if self.opening.is_none() && Instant::now() < next_try {
            return;
        }

        let startup_until = match self.startup_readiness() {
            Some(StartupReadiness::Ready(until)) => Some(until),
            Some(StartupReadiness::Waiting(again)) => {
                self.retry_at(again, logged, started_facade);
                return;
            }
            None => None,
        };

        let expected = self.startup.clone();
        let opening = if let Some(task) = &self.opening {
            let Some(result) = task.completed() else {
                self.retry_at(Instant::now() + MIN_RECONNECT_DELAY, logged, started_facade);
                return;
            };
            self.opening = None;
            result
        } else if let (Some(ticket), Some(until)) = (&expected, startup_until) {
            let (framework, socket, hello, ticket) = (
                self.framework.clone(),
                self.socket.clone(),
                self.hello.clone(),
                ticket.clone(),
            );
            match Task::start(
                move || {
                    OpeningLink::open(
                        &socket,
                        &hello,
                        Some((&framework, &ticket)),
                        None,
                        Some(until),
                    )
                },
                #[cfg(windows)]
                self.events.startup_waker(),
            ) {
                Ok(task) => {
                    self.opening = Some(task);
                    self.retry_at(Instant::now() + MIN_RECONNECT_DELAY, logged, started_facade);
                    return;
                }
                Err(error) => Err(error),
            }
        } else {
            OpeningLink::open(
                &self.socket,
                &self.hello,
                None,
                self.installed.then_some(self.framework.as_path()),
                None,
            )
        };
        let link = match opening.and_then(|link| self.adopt(link, expected.as_ref())) {
            Ok(link) => link,
            Err(err) => {
                self.retry_open(&err, logged, started_facade);
                return;
            }
        };
        if logged {
            log("info", "connected to Facade");
        }
        self.startup = None;
        self.hello.reconnect = true;
        self.reconnect_delay = MIN_RECONNECT_DELAY;
        self.daemon = Daemon::Connected { link };
        for line in mem::take(&mut self.held) {
            self.forward(line);
        }
    }

    fn startup_readiness(&mut self) -> Option<StartupReadiness> {
        let ticket = self.startup.as_mut()?;
        let latest = ticket.refresh_window(&self.framework);
        let observation = ticket.view(&self.framework);
        let now = Instant::now();
        let until = ticket.until();
        let detail = observation
            .as_ref()
            .filter(|view| view.status == "failed")
            .map(|view| view.detail.as_str())
            .or(latest.as_deref())
            .unwrap_or("waiting for the daemon lock owner");
        let failed = observation
            .as_ref()
            .is_some_and(|view| view.status == "failed");
        if failed || ticket.expired() {
            if !ticket.diagnosed {
                if failed {
                    log("warn", detail);
                } else {
                    log(
                        "warn",
                        &format!("the Orchestrator startup deadline elapsed ({detail})"),
                    );
                }
                ticket.diagnosed = true;
            }
            self.opening = None;
            let again = if let Some(next) = ticket.replacement(&self.framework) {
                self.startup = Some(next);
                now
            } else {
                now + MAX_RECONNECT_DELAY
            };
            return Some(StartupReadiness::Waiting(again));
        }
        if now >= self.notice_at && ticket.ten_seconds_in() {
            log(
                "info",
                &format!("the Orchestrator is still starting ({detail})"),
            );
            self.notice_at = now + Duration::from_secs(10);
        }
        if observation.is_none_or(|view| view.status == "ready") {
            return Some(StartupReadiness::Ready(until));
        }
        let again = if let Some(next) = ticket.replacement(&self.framework) {
            self.startup = Some(next);
            now
        } else {
            until.min(now + MIN_RECONNECT_DELAY)
        };
        Some(StartupReadiness::Waiting(again))
    }

    fn retry_open(&mut self, err: &io::Error, logged: bool, mut started_facade: bool) {
        if let Some(ticket) = &self.startup
            && let Some(next) = ticket.replacement(&self.framework)
        {
            if let Some(view) = ticket.view(&self.framework)
                && view.status == "failed"
            {
                log("warn", &view.detail);
            }
            self.startup = Some(next);
            self.retry_at(Instant::now(), true, started_facade);
            return;
        }
        if !logged {
            log("warn", &format!("{err}; trying again"));
        }
        let may_launch = matches!(
            err.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
        ) || (self.installed && err.kind() == io::ErrorKind::ConnectionAborted);
        let mut delay = self.reconnect_delay;
        self.reconnect_delay = (delay * 2).min(MAX_RECONNECT_DELAY);
        if may_launch {
            let holder = self
                .installed
                .then(|| startup::daemon_lock(&self.framework))
                .flatten();
            let program = daemon::facade_program();
            let shell = self
                .installed
                .then(|| program.as_deref().ok().and_then(ShellPublication::read))
                .flatten();
            let published = shell.is_some() && shell != self.launched_shell;
            if !started_facade || holder.is_some() && holder != self.launched_for || published {
                started_facade = true;
                self.launched_for = holder;
                self.launched_shell = shell;
                let home = self.home.clone();
                let installed = self.installed;
                match Task::start(
                    move || daemon::start_facade(&program?, &home, installed),
                    #[cfg(windows)]
                    self.events.startup_waker(),
                ) {
                    Ok(launch) => {
                        self.launch = Some(launch);
                        delay = MIN_RECONNECT_DELAY;
                    }
                    Err(why) => log(
                        "warn",
                        &format!("could not start Facade: {why}; trying again"),
                    ),
                }
            }
        }
        self.retry_at(Instant::now() + delay, true, started_facade);
    }

    fn retry_at(&mut self, next_try: Instant, logged: bool, started_facade: bool) {
        self.daemon = Daemon::Disconnected {
            next_try,
            logged,
            started_facade,
        };
    }
    /// Adopts the proved link and writes it the pending requests.
    fn adopt(&mut self, opening: OpeningLink, expected: Option<&Ticket>) -> io::Result<DaemonLink> {
        let mut link = opening.attach(
            expected.map(|ticket| (self.framework.as_path(), ticket)),
            #[cfg(windows)]
            &mut self.events,
        )?;
        if !self.pending.is_empty() || !self.held.is_empty() {
            self.take_ready_cli()?;
        }
        let failed =
            self.pending.iter().enumerate().find_map(|(at, pending)| {
                pending.write_to(&mut link).err().map(|error| (at, error))
            });
        if let Some((at, error)) = failed {
            for pending in self.pending.iter_mut().take(at + 1) {
                pending.lost(Replay::Interrupted);
            }
            return Err(io::Error::other(format!(
                "Facade closed as it took the pending requests: {error}"
            )));
        }
        Ok(link)
    }

    /// Applies complete cancellations already waiting in stdin before replaying any request.
    #[cfg(unix)]
    fn take_ready_cli(&mut self) -> io::Result<()> {
        if let Some(input) = self.input.as_mut() {
            let bytes = ready_input_bytes(input)?;
            drain_ready_input(bytes, |limit| self.read_cli(limit));
        }
        Ok(())
    }

    #[cfg(windows)]
    fn take_ready_cli(&mut self) -> io::Result<()> {
        self.events.mark_ready_input_end()?;
        loop {
            match self.wait() {
                Ok((true, _)) => {
                    self.read_cli(usize::MAX);
                }
                Ok((false, _)) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }

    /// Reads a chunk of at most `limit` bytes and passes each whole line on. Returns zero at the
    /// end of the input, including when a read fails.
    fn read_cli(&mut self, limit: usize) -> usize {
        let Some(input) = &mut self.input else {
            return 0;
        };
        let Ok(read @ 1..) = self.cli_lines.fill_up_to(input, limit) else {
            self.input = None;
            return 0;
        };
        while let Some(line) = self.cli_lines.next_line() {
            self.handle_cli_line(line);
        }
        read
    }

    /// Passes a line from the CLI on to the daemon, or holds it while no daemon takes lines.
    fn handle_cli_line(&mut self, line: Vec<u8>) {
        let read = match jsonrpc::read(&line) {
            Message::Request { id } => ClientLine::Request(Pending {
                id: Id::read(id),
                line,
                first_line_ns: monotonic_now(),
                replay: Replay::First,
                cancelled: false,
            }),
            Message::Notification { method } => {
                if let Some(id) = jsonrpc::cancelled_id(&line, method) {
                    self.note_cancellation(&id);
                }
                ClientLine::Other(line)
            }
            Message::Other if line.trim_ascii().starts_with(b"[") => {
                for id in jsonrpc::batch_cancellations(&line) {
                    self.note_cancellation(&id);
                }
                ClientLine::Other(line)
            }
            Message::Response { .. } | Message::Other => ClientLine::Other(line),
        };
        self.forward(read);
    }

    fn note_cancellation(&mut self, id: &Id) {
        let held = self.held.iter_mut().filter_map(|line| match line {
            ClientLine::Request(request) => Some(request),
            ClientLine::Other(_) => None,
        });
        if let Some(pending) = self
            .pending
            .iter_mut()
            .chain(held)
            .find(|request| &request.id == id)
        {
            pending.cancelled = true;
        }
    }

    fn forward(&mut self, line: ClientLine) {
        let Daemon::Connected { link } = &mut self.daemon else {
            self.held.push(line);
            return;
        };
        let written = match line {
            ClientLine::Request(request) => {
                let written = request.write_to(link);
                self.pending.push(request);
                written
            }
            ClientLine::Other(line) => link.stream.write_all(&line),
        };
        if written.is_err() {
            self.lose_daemon();
        }
    }

    fn lose_daemon(&mut self) {
        let replay = match &self.daemon {
            Daemon::Closing {
                link,
                acknowledged: true,
            } if link.request_context => Replay::Planned,
            _ => Replay::Interrupted,
        };
        for pending in &mut self.pending {
            pending.lost(replay);
        }
        self.daemon = Daemon::ended();
    }

    /// Reads what the daemon sent and handles each whole line. Fails where the CLI's output
    /// cannot be written.
    fn read_daemon(&mut self) -> io::Result<()> {
        let Some(link) = self.daemon.link() else {
            return Ok(());
        };
        if !matches!(link.lines.fill(&mut link.stream), Ok(1..)) {
            self.lose_daemon();
            return Ok(());
        }
        while let Some(line) = self.daemon.link().and_then(|link| link.lines.next_line()) {
            self.handle_daemon_line(&line)?;
        }
        Ok(())
    }

    /// Responds to `closing`, or passes a line on to the CLI, a response ending its request.
    fn handle_daemon_line(&mut self, line: &[u8]) -> io::Result<()> {
        let answered = match jsonrpc::read(line) {
            Message::Notification {
                method: b"\"closing\"",
            } => {
                self.daemon = match mem::replace(&mut self.daemon, Daemon::ended()) {
                    Daemon::Connected { mut link } => {
                        // A failed write means the connection ended, which the next read finds;
                        // the relay connects again either way.
                        let acknowledged = link.respond_to_closing().is_ok();
                        Daemon::Closing { link, acknowledged }
                    }
                    daemon => daemon,
                };
                return Ok(());
            }
            Message::Response { id, .. } => {
                let id = Id::read(id);
                self.pending.iter().position(|pending| pending.id == id)
            }
            Message::Request { .. } | Message::Notification { .. } | Message::Other => None,
        };
        self.output.write_all(line)?;
        self.output.flush()?;
        if let Some(at) = answered {
            self.pending.remove(at);
        }
        Ok(())
    }
}

/// Reads the Unix stdin prefix that was queued at one instant. Later input can keep `poll`
/// readable, but only the bytes in this prefix can precede the replay.
#[cfg(any(unix, test))]
fn drain_ready_input(mut remaining: usize, mut read: impl FnMut(usize) -> usize) {
    while remaining > 0 {
        let bytes = read(remaining);
        if bytes == 0 {
            break;
        }
        remaining -= bytes;
    }
}

/// The local daemon's monotonic clock, in nanoseconds on the same clock.
#[cfg(unix)]
pub(crate) fn monotonic_now() -> u64 {
    let Ok(now) = clock_gettime(ClockId::CLOCK_MONOTONIC) else {
        return 0;
    };
    let seconds = u64::try_from(now.tv_sec()).unwrap_or(0);
    let nanos = u64::try_from(now.tv_nsec()).unwrap_or(0);
    seconds.saturating_mul(1_000_000_000).saturating_add(nanos)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{self, Read};

    use super::{Lines, drain_ready_input, jsonrpc};

    #[test]
    fn a_readable_unix_stdin_cannot_delay_replay_past_its_ready_prefix() -> io::Result<()> {
        const CANCEL: &[u8] = b"[{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":1}}]\n";
        const LATER: &[u8] = b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";

        struct PollInput(VecDeque<u8>);

        impl PollInput {
            fn poll_readable(&self) -> bool {
                !self.0.is_empty()
            }
        }

        impl Read for PollInput {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                // A short read, with another notification arriving before every subsequent poll.
                let read = bytes.len().min(17).min(self.0.len());
                for (byte, queued) in bytes.iter_mut().zip(self.0.drain(..read)) {
                    *byte = queued;
                }
                self.0.extend(LATER);
                Ok(read)
            }
        }

        // The second line's opening byte is ready when hello completes. Its tail and a steady
        // stream of notifications arrive as the relay reads.
        let mut input = PollInput(CANCEL.iter().chain(LATER.first()).copied().collect());
        let ready_bytes = input.0.len();
        input.0.extend(LATER.iter().skip(1));
        let mut lines = Lines::default();
        let mut before_replay = Vec::new();
        let mut attempts = 0;
        drain_ready_input(ready_bytes, |limit| {
            assert!(input.poll_readable());
            attempts += 1;
            assert!(
                attempts <= ready_bytes,
                "replay starved while poll stayed readable"
            );
            let read = lines.fill_up_to(&mut input, limit).unwrap_or(0);
            while let Some(line) = lines.next_line() {
                before_replay.push(line);
            }
            read
        });

        assert_eq!(before_replay, [CANCEL]);
        assert!(before_replay.iter().any(|line| {
            jsonrpc::batch_cancellations(line).any(|id| id == jsonrpc::Id::read(b"1"))
        }));
        assert!(input.poll_readable(), "poll remains readable at replay");
        assert!(lines.next_line().is_none());
        let later = loop {
            assert!(lines.fill(&mut input)? > 0);
            if let Some(later) = lines.next_line() {
                break later;
            }
        };
        assert_eq!(later, LATER);
        Ok(())
    }
}
