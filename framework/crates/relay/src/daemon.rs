//! The relay's link to the daemon: it connects, checks that the daemon runs as the relay's own
//! user before it says anything, says hello, and responds to `closing`.

use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(windows)]
use crate::windows::{Events, Stream};
#[cfg(unix)]
use nix::unistd::Uid;

use crate::jsonrpc::{self, Message};
use crate::lines::Lines;

/// The version of the relay contract, the part of the daemon protocol the relay speaks.
const RELAY_CONTRACT: u32 = 1;
/// The relay's response to `closing`: it sends that daemon nothing after it.
const CLOSING_RESPONSE: &[u8] = b"{\"jsonrpc\":\"2.0\",\"method\":\"closing\",\"params\":{}}\n";

/// What the hello tells the daemon about the relay's process, which the CLI started.
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
}

impl DaemonLink {
    /// Connects to the daemon at `socket` and says `hello`, blocking until the daemon responds.
    /// Fails, saying why, where no daemon listens there, it runs as another user, or it refuses
    /// the hello, as it does before the agent is listed; the relay then tries again. Where no one
    /// listens, the error's kind is `NotFound` or `ConnectionRefused`.
    pub(crate) fn open(
        socket: &Path,
        hello: &RelayHelloParams,
        #[cfg(windows)] events: &mut Events,
    ) -> io::Result<DaemonLink> {
        let at = socket.display();
        let fail = |what: String| io::Error::other(what);
        // Its kind tells the relay whether anyone listens there.
        #[cfg(unix)]
        let connection = UnixStream::connect(socket);
        #[cfg(windows)]
        let connection = Stream::connect(socket, events);
        let mut stream = connection.map_err(|err| {
            io::Error::new(
                err.kind(),
                format!("cannot reach Facade Code Framework at {at}: {err}"),
            )
        })?;
        #[cfg(unix)]
        let user = peer_user(&stream).map_err(|err| {
            fail(format!(
                "cannot tell whose Facade Code Framework is at {at}: {err}"
            ))
        })?;
        #[cfg(unix)]
        if user != Uid::current() {
            return Err(fail(format!(
                "the Facade Code Framework at {at} is another user's"
            )));
        }
        stream.write_all(&hello.to_line()).map_err(|err| {
            fail(format!(
                "cannot say hello to Facade Code Framework at {at}: {err}"
            ))
        })?;
        let mut lines = Lines::default();
        let response = loop {
            if let Some(line) = lines.next_line() {
                break line;
            }
            match lines.fill(&mut stream) {
                Ok(0) => {
                    return Err(fail(format!(
                        "Facade Code Framework at {at} closed before it responded"
                    )));
                }
                Ok(_) => {}
                Err(err) => {
                    return Err(fail(format!(
                        "Facade Code Framework at {at} did not respond: {err}"
                    )));
                }
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
                "Facade Code Framework at {at} refused the hello: {}",
                said.trim_end()
            )));
        }
        Ok(DaemonLink { stream, lines })
    }

    /// Responds to the daemon's `closing`.
    pub(crate) fn respond_to_closing(&mut self) -> io::Result<()> {
        self.stream.write_all(CLOSING_RESPONSE)
    }
}

/// Runs `facade daemon --detach` from the relay's own folder, as a client does where no daemon
/// listens, and blocks until it returns, which takes up to 10 seconds while Facade Code Framework starts. Its
/// output goes to standard error: standard output carries MCP.
pub(crate) fn start_facade() -> Result<(), String> {
    let program = std::env::current_exe()
        .map_err(|err| format!("cannot find facade-mcp's own folder: {err}"))?
        .with_file_name(if cfg!(windows) {
            "facade.exe"
        } else {
            "facade"
        });
    let mut command = Command::new(&program);
    #[cfg(windows)]
    crate::windows::no_window(&mut command);
    let status = command
        .args(["daemon", "--detach"])
        .stdin(Stdio::null())
        .stdout(io::stderr())
        .status()
        .map_err(|err| format!("cannot run {}: {err}", program.display()))?;
    if !status.success() {
        return Err(format!(
            "{} daemon --detach failed: {status}",
            program.display()
        ));
    }
    Ok(())
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
