//! The relay's link to the daemon: it connects, checks that the daemon runs as the relay's own
//! user before it says anything, says hello, and responds to `closing`.

use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

#[cfg(windows)]
use crate::windows::{Events, OpeningStream, Stream};
#[cfg(unix)]
use nix::unistd::Uid;

use crate::jsonrpc::{self, Message};
use crate::lines::Lines;
use crate::startup::Ticket;

/// The version of the relay contract, the part of the daemon protocol the relay speaks.
const RELAY_CONTRACT: u32 = 1;
/// The relay's response to `closing`: it sends that daemon nothing after it.
const CLOSING_RESPONSE: &[u8] = b"{\"jsonrpc\":\"2.0\",\"method\":\"closing\",\"params\":{}}\n";

/// What the hello tells the daemon about the relay's process, which the CLI started.
#[derive(Clone)]
pub(crate) struct RelayHelloParams {
    /// Its words after its program.
    pub(crate) args: Vec<String>,
    /// Its environment's UTF-8 variables. They may hold keys, so only the relay's own user's
    /// daemon gets them.
    pub(crate) env: Vec<(String, String)>,
    /// The folder it runs in, where it can be read.
    pub(crate) cwd: Option<String>,
    /// It connected to a daemon before, so its CLI has the tools already.
    pub(crate) reconnect: bool,
}

impl RelayHelloParams {
    /// The hello as a line.
    fn to_line(&self) -> Vec<u8> {
        let args: Vec<String> = self.args.iter().map(|arg| jsonrpc::string(arg)).collect();
        let env: Vec<String> = (self.env.iter())
            .map(|(name, value)| format!("{}:{}", jsonrpc::string(name), jsonrpc::string(value)))
            .collect();
        let cwd = self.cwd.as_deref().map_or("null".into(), jsonrpc::string);
        format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\
             \"params\":{{\"relay\":{RELAY_CONTRACT},\"args\":[{}],\
             \"env\":{{{}}},\"cwd\":{cwd},\"reconnect\":{}}}}}\n",
            args.join(","),
            env.join(","),
            self.reconnect,
        )
        .into_bytes()
    }
}

/// A connection to a daemon that took the relay's hello.
pub(crate) struct DaemonLink {
    #[cfg(unix)]
    pub(crate) stream: UnixStream,
    #[cfg(windows)]
    pub(crate) stream: Stream,
    /// What the daemon sent that is no whole line yet.
    pub(crate) lines: Lines,
    pub(crate) request_context: bool,
}

pub(crate) struct OpeningLink {
    #[cfg(unix)]
    stream: UnixStream,
    #[cfg(windows)]
    stream: OpeningStream,
    lines: Lines,
    request_context: bool,
}

impl OpeningLink {
    /// Connects to the daemon at the socket and completes the MCP hello.
    /// Fails, saying why, where no daemon listens there, it runs as another user, or it refuses
    /// the hello, as it does before the agent is listed; the relay then tries again. Where no one
    /// listens, the error's kind is `NotFound` or `ConnectionRefused`.
    pub(crate) fn open(
        socket: &Path,
        hello: &RelayHelloParams,
        startup: Option<(&Path, &Ticket)>,
        until: Option<Instant>,
    ) -> io::Result<OpeningLink> {
        let at = socket.display();
        let fail = |what: String| io::Error::other(what);
        // Its kind tells the relay whether anyone listens there.
        #[cfg(unix)]
        let connection = UnixStream::connect(socket);
        #[cfg(windows)]
        let connection = OpeningStream::connect(socket, until);
        let mut stream = connection.map_err(|err| {
            io::Error::new(err.kind(), format!("cannot reach Facade at {at}: {err}"))
        })?;
        #[cfg(unix)]
        let user = peer_user(&stream)
            .map_err(|err| fail(format!("cannot tell whose Facade is at {at}: {err}")))?;
        #[cfg(unix)]
        if user != Uid::current() {
            return Err(fail(format!("the Facade at {at} is another user's")));
        }
        if let Some((framework, expected)) = startup {
            #[cfg(unix)]
            let pid = peer_pid(&stream)?;
            #[cfg(windows)]
            let pid = stream.peer_pid;
            if !expected.lock_matches(framework, pid) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the daemon at the socket differs from the startup candidate",
                ));
            }
        }
        #[cfg(unix)]
        if let Some(until) = until {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            stream.set_write_timeout(Some(left))?;
        }
        stream
            .write_all(&hello.to_line())
            .map_err(|err| fail(format!("cannot say hello to Facade at {at}: {err}")))?;
        let mut lines = Lines::default();
        let response = loop {
            if let Some(line) = lines.next_line() {
                break line;
            }
            if let Some(until) = until {
                let left = until.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io::ErrorKind::TimedOut.into());
                }
                #[cfg(unix)]
                stream.set_read_timeout(Some(left))?;
            }
            match lines.fill(&mut stream) {
                Ok(0) => return Err(fail(format!("Facade at {at} closed before it responded"))),
                Ok(_) => {}
                Err(err) => return Err(fail(format!("Facade at {at} did not respond: {err}"))),
            }
        };
        if jsonrpc::read(&response)
            != (Message::Response {
                id: b"1",
                error: false,
            })
        {
            let said = String::from_utf8_lossy(&response);
            return Err(fail(format!(
                "Facade at {at} refused the hello: {}",
                said.trim_end()
            )));
        }
        if let Some((framework, expected)) = startup {
            #[cfg(unix)]
            let pid = peer_pid(&stream)?;
            #[cfg(windows)]
            let pid = stream.peer_pid;
            if !expected.lock_matches(framework, pid) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the daemon changed while the relay was saying hello",
                ));
            }
        }
        #[cfg(unix)]
        if until.is_some() {
            stream.set_read_timeout(None)?;
            stream.set_write_timeout(None)?;
        }
        if until.is_some_and(|until| Instant::now() >= until) {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let request_context = jsonrpc::supports_request_context(&response);
        Ok(OpeningLink {
            stream,
            lines,
            request_context,
        })
    }

    /// Takes the proved link into the original relay loop before any queued MCP work is sent.
    pub(crate) fn attach(
        self,
        startup: Option<(&Path, &Ticket)>,
        #[cfg(windows)] events: &mut Events,
    ) -> io::Result<DaemonLink> {
        if let Some((framework, expected)) = startup {
            #[cfg(unix)]
            let pid = peer_pid(&self.stream)?;
            #[cfg(windows)]
            let pid = self.stream.peer_pid;
            if !expected.lock_matches(framework, pid) || expected.expired() {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "the startup socket no longer belongs to the current candidate",
                ));
            }
        }
        #[cfg(unix)]
        let stream = self.stream;
        #[cfg(windows)]
        let stream = Stream::attach(self.stream, events)?;
        Ok(DaemonLink {
            stream,
            lines: self.lines,
            request_context: self.request_context,
        })
    }
}

impl DaemonLink {
    /// Responds to the daemon's `closing`.
    pub(crate) fn respond_to_closing(&mut self) -> io::Result<()> {
        self.stream.write_all(CLOSING_RESPONSE)
    }
}

/// Runs the background entry from the relay's own folder, returning its lock ticket.
pub(crate) fn start_facade() -> io::Result<Option<Ticket>> {
    let program = std::env::current_exe()
        .map_err(|err| io::Error::other(format!("cannot find facade-mcp's own folder: {err}")))?
        .with_file_name(if cfg!(windows) {
            "facade.exe"
        } else {
            "facade"
        });
    let mut command = Command::new(&program);
    #[cfg(windows)]
    crate::windows::no_window(&mut command);
    let mut child = command
        .args(["daemon", "--detach"])
        .env("FACADE_STARTUP_REPORT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|err| io::Error::other(format!("cannot run {}: {err}", program.display())))?;
    let mut stdout = String::new();
    let read = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing startup output pipe"))?
        .take(16 * 1024 + 1)
        .read_to_string(&mut stdout);
    let status = child.wait().map_err(|err| {
        io::Error::other(format!("could not wait for {}: {err}", program.display()))
    })?;
    read.map_err(|err| {
        io::Error::other(format!(
            "could not read {}'s startup report: {err}",
            program.display()
        ))
    })?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "{} daemon --detach failed: {status}",
            program.display()
        )));
    }
    for line in stdout
        .lines()
        .filter(|line| !line.starts_with("facade-startup-locked "))
    {
        eprintln!("{line}");
    }
    Ok(Ticket::from_stdout(&stdout))
}

#[cfg(unix)]
fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    use nix::sys::socket::{getsockopt, sockopt};
    #[cfg(target_os = "linux")]
    let pid = getsockopt(stream, sockopt::PeerCredentials)?.pid();
    #[cfg(target_os = "macos")]
    let pid = getsockopt(stream, sockopt::LocalPeerPid)?;
    u32::try_from(pid).map_err(|_| io::Error::other("the daemon socket has no peer process"))
}

/// The user the process at the other end of `stream` runs as.
#[cfg(unix)]
fn peer_user(stream: &UnixStream) -> nix::Result<Uid> {
    #[cfg(target_os = "linux")]
    {
        use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
        getsockopt(stream, PeerCredentials).map(|peer| Uid::from_raw(peer.uid()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        nix::unistd::getpeereid(stream).map(|(user, _group)| user)
    }
}

#[cfg(test)]
mod tests {
    use super::RelayHelloParams;

    #[test]
    fn a_relay_sends_the_v1_hello_and_reconnect_frames() {
        let mut hello = RelayHelloParams {
            args: vec!["--guest".into(), "codex".into()],
            env: vec![("FACADE_TEST_VALUE".into(), "line\n\"quoted\" ☃".into())],
            cwd: Some("/work folder".into()),
            reconnect: false,
        };
        let mut frames = hello.to_line();
        hello.cwd = None;
        hello.reconnect = true;
        frames.extend(hello.to_line());
        let expected = include_str!("../tests/fixtures/relay-hello.jsonl").replace("\r\n", "\n");
        assert_eq!(frames.as_slice(), expected.as_bytes());
    }
}
