//! A blocking daemon protocol client, used by the `facade` commands and by `facade-mcp`.

use std::collections::{BTreeMap, VecDeque};
use std::io::{self, BufReader, ErrorKind, Write};
use std::ops::RangeFrom;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::daemon::{
    CancelParams, ChangedParams, ClientKind, DAEMON_PROTOCOL_VERSION, HANDOVER_TIME, HelloParams,
    HelloResult, MIN_DAEMON_PROTOCOL_VERSION, UnwatchParams, WatchParams, WatchResult, methods,
};
use super::jsonrpc::{
    ErrorBody, Notification, Reason, Request, Response, ServerMessage, encode_line,
    read_server_message,
};
use super::operations::{CallParams, Operation, Topic};

/// The wait before a client that holds a connection to the daemon, such as an attached terminal or
/// an agent's Facade server, tries again after an attempt that reached no daemon.
pub const RECONNECT_DELAY: Duration = Duration::from_millis(500);

/// The time a client gives a newer build to answer once it takes over: the old daemon hands over,
/// then the keeper gets 10 seconds to start the new one.
pub fn takeover_timeout() -> Duration {
    HANDOVER_TIME + Duration::from_secs(10)
}

/// How often [`DaemonClient::connect_again`] looks for the daemon that takes over.
const TAKEOVER_POLL: Duration = Duration::from_millis(100);

/// The ID of the hello request; calls take the IDs after it.
const HELLO_ID: u64 = 1;

/// A call the daemon's end cut off before its answer: what it did is not known.
#[derive(Debug)]
pub struct Cut;

impl std::fmt::Display for Cut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "the daemon disconnected before responding; the outcome is unknown; check \
             `facade list`",
        )
    }
}

impl std::error::Error for Cut {}

/// A request ID of this process's own, for a send or a start a command makes:
/// `facade-<pid>-<ms since 1970>-1`.
pub fn made_request_id() -> String {
    let since_1970 = UNIX_EPOCH.elapsed().unwrap_or_default();
    format!("facade-{}-{}-1", std::process::id(), since_1970.as_millis())
}

/// The client's environment as the protocol carries it, in JSON: each variable whose name and value
/// are UTF-8. The others are left out, and their names returned apart so that the client can say
/// so where it is able to.
pub fn environment() -> (BTreeMap<String, String>, Vec<String>) {
    let mut carried = BTreeMap::new();
    let mut left_out = Vec::new();
    for (name, value) in std::env::vars_os() {
        match (name.to_str(), value.to_str()) {
            (Some(name), Some(value)) => {
                carried.insert(name.to_owned(), value.to_owned());
            }
            _ => left_out.push(name.to_string_lossy().into_owned()),
        }
    }
    (carried, left_out)
}

/// Who a client is, as its hello says.
#[derive(Clone, Debug)]
pub struct Identity {
    pub kind: ClientKind,
    /// The agent the client acts for.
    pub agent: Option<String>,
    /// The sessions the client's CLI names, which decide ahead of `agent`.
    pub sessions: Vec<String>,
}

/// Where a client connected, and as whom: what it needs to reach a daemon that takes over.
#[derive(Clone)]
struct Origin {
    socket: PathBuf,
    identity: Identity,
}

/// One connection to the daemon, past its hello.
pub struct DaemonClient {
    pub writer: UnixStream,
    pub hello_result: HelloResult,
    /// The build that takes over, once the daemon said `closing`.
    pub closing: Option<String>,
    reader: BufReader<UnixStream>,
    line: Vec<u8>,
    ids: RangeFrom<u64>,
    /// Notifications read while a call waited for its own response; `next_change` reads them
    /// first.
    unread: VecDeque<Notification>,
    /// None when the stream came from elsewhere, through [`DaemonClient::hello`]: such a client
    /// cannot connect again.
    origin: Option<Origin>,
}

impl DaemonClient {
    /// Connects to `socket` and says hello. Returns None if no daemon answered yet; permission and
    /// protocol errors are errors. `opening` sees the connection before hello and can close it by
    /// returning false. The hello waits until `until`.
    pub fn connect(
        socket: &Path,
        identity: &Identity,
        until: Instant,
        opening: &mut dyn FnMut(&UnixStream) -> bool,
    ) -> anyhow::Result<Option<Self>> {
        let stream = match UnixStream::connect(socket) {
            Err(err) if transient_transport(&err) => return Ok(None),
            Err(err) => anyhow::bail!("cannot connect to {}: {err}", socket.display()),
            Ok(stream) => stream,
        };
        if !opening(&stream) {
            return Ok(None);
        }
        let Some(mut client) = Self::hello_until(stream, identity, until)? else {
            return Ok(None);
        };
        client.origin = Some(Origin {
            socket: socket.to_owned(),
            identity: identity.clone(),
        });
        Ok(Some(client))
    }

    /// Says hello, waiting for the answer until `until`. None when what answered is no daemon to
    /// stay with: one that closes the connection around its hello, or that refuses it while a newer
    /// build takes over, is ending or handing over, and the next daemon is the one to talk to.
    fn hello_until(
        stream: UnixStream,
        identity: &Identity,
        until: Instant,
    ) -> anyhow::Result<Option<Self>> {
        let wait = until
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        // Setting a timeout fails on macOS once the peer has closed: that daemon is gone too.
        if stream.set_read_timeout(Some(wait)).is_err() {
            return Ok(None);
        }
        match Self::hello(stream, identity) {
            Ok(client) if client.writer.set_read_timeout(None).is_ok() => Ok(Some(client)),
            Ok(_) => Ok(None),
            Err(err) if upgrading(&err) => Ok(None),
            Err(err)
                if err
                    .downcast_ref::<io::Error>()
                    .is_some_and(transient_transport) =>
            {
                Ok(None)
            }
            Err(err) => Err(err),
        }
    }

    /// Completes hello on a connected stream before using any other method.
    pub fn hello(mut writer: UnixStream, identity: &Identity) -> anyhow::Result<Self> {
        let mut reader = BufReader::new(writer.try_clone()?);
        let mut line = Vec::new();
        let params = HelloParams {
            protocol: [MIN_DAEMON_PROTOCOL_VERSION, DAEMON_PROTOCOL_VERSION],
            build: crate::build_id(),
            kind: identity.kind,
            agent: identity.agent.clone(),
            sessions: identity.sessions.clone(),
            window: None,
        };
        writer.write_all(&encode_line(&Request::new(
            Some(HELLO_ID),
            methods::HELLO,
            params,
        )))?;
        let hello_result = hello_answer(read_server_message(&mut reader, &mut line)?)?;
        Ok(DaemonClient {
            writer,
            hello_result,
            closing: None,
            reader,
            line,
            ids: HELLO_ID + 1..,
            unread: VecDeque::new(),
            origin: None,
        })
    }

    /// Calls an operation and returns its result.
    pub fn call<O: Operation>(&mut self, args: O::Args) -> anyhow::Result<O::Result> {
        let params = call_params::<O>(args)?;
        self.exchange(methods::CALL, &params)
    }

    /// Calls an operation whose request ID makes it safe to repeat, as a send's or a start's is.
    /// One cut off by a newer Facade taking over, and with `after_crash` one cut off by any
    /// restart, goes again to the daemon that answers next, which answers what the first one did.
    /// Says whether it went again.
    pub fn call_with_request_id<O: Operation>(
        &mut self,
        args: O::Args,
        after_crash: bool,
    ) -> anyhow::Result<(O::Result, bool)>
    where
        O::Args: Clone,
    {
        match self.call::<O>(args.clone()) {
            Ok(result) => Ok((result, false)),
            Err(err) if err.is::<Cut>() && self.may_repeat_cut_call(after_crash) => {
                self.connect_again()?;
                let result = self.call::<O>(args)?;
                Ok((result, true))
            }
            Err(err) => Err(err),
        }
    }

    /// Whether a cut-off call can go again: to a daemon this client can reach again, that took
    /// over from the one that said `closing`, or that came after a crash where the caller allows.
    fn may_repeat_cut_call(&self, after_crash: bool) -> bool {
        self.origin.is_some() && (after_crash || self.closing.is_some())
    }

    /// Writes a call of an operation without waiting for its result, and returns the call's request
    /// ID: until [`DaemonClient::result`] reads its result, a [`cancel_line`] with that ID written
    /// to this connection names it.
    pub fn begin_call<O: Operation>(&mut self, args: O::Args) -> anyhow::Result<u64> {
        let params = call_params::<O>(args)?;
        self.ask(methods::CALL, &params)
    }

    /// The result of call `id`, which [`DaemonClient::begin_call`] wrote.
    pub fn result<O: Operation>(&mut self, id: u64) -> anyhow::Result<O::Result> {
        self.answer_to(id)
    }

    /// Starts a watch and returns its number and snapshot. Read changes through `next_change`.
    pub fn watch<T: Topic>(&mut self, args: T::Args) -> anyhow::Result<(u64, T::Snapshot)> {
        let params = WatchParams {
            topic: T::NAME.to_owned(),
            args: serde_json::to_value(args)?,
        };
        let started: WatchResult = self.exchange(methods::WATCH, &params)?;
        let snapshot = serde_json::from_value(started.snapshot)?;
        Ok((started.watch, snapshot))
    }

    /// Takes a topic snapshot and immediately ends its watch.
    pub fn snapshot<T: Topic>(&mut self, args: T::Args) -> anyhow::Result<T::Snapshot> {
        let (watch, snapshot) = self.watch::<T>(args)?;
        self.tell(methods::UNWATCH, UnwatchParams { watch })?;
        Ok(snapshot)
    }

    /// Reads the next change for this watch. Returns None on disconnection, or once a newer Facade
    /// takes over, and an error for an invalid message.
    pub fn next_change<T: Topic>(&mut self, watch: u64) -> anyhow::Result<Option<T::Change>> {
        while let Some(notification) = self.next_notification()? {
            match notification.method.as_str() {
                // The watch ends with this connection, as at a disconnection; whoever watches
                // answers the daemon.
                methods::CLOSING => {
                    self.closing = Some(closing_build(&notification));
                    return Ok(None);
                }
                methods::CHANGED => {}
                _ => continue,
            }
            match serde_json::from_value::<ChangedParams>(notification.params) {
                Ok(changed) if changed.watch == watch => {
                    return Ok(Some(serde_json::from_value(changed.change)?));
                }
                _ => {}
            }
        }
        Ok(None)
    }

    /// Connects again, to the daemon that took over, waiting up to [`takeover_timeout`] for one to
    /// answer.
    pub fn connect_again(&mut self) -> anyhow::Result<()> {
        let Origin { socket, identity } = self
            .origin
            .clone()
            .ok_or_else(|| anyhow::anyhow!("this connection cannot connect again"))?;
        let timeout = takeover_timeout();
        let until = Instant::now() + timeout;
        *self = loop {
            if let Some(client) = Self::connect(&socket, &identity, until, &mut |_| true)? {
                break client;
            }
            anyhow::ensure!(
                Instant::now() < until,
                "Facade did not answer within {} seconds of a newer build taking over",
                timeout.as_secs()
            );
            std::thread::sleep(TAKEOVER_POLL);
        };
        Ok(())
    }

    /// Answers the daemon's `closing`: this connection sends nothing more. A watcher that writes
    /// from another thread, as an attached terminal's keys do, answers once that writing has
    /// stopped, so each key reaches the agent from one daemon.
    pub fn respond_to_closing(&mut self) {
        // Nothing depends on the answer arriving: the daemon is on its way out.
        let _ = self.tell(methods::CLOSING, serde_json::json!({}));
    }

    /// Sends a request and reads its answer. A refusal as `upgrading` means the daemon did
    /// nothing: the request goes again once the daemon that takes over answers.
    fn exchange<T: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &impl Serialize,
    ) -> anyhow::Result<T> {
        loop {
            let id = self.ask(method, params)?;
            let answer = self.answer_to(id);
            if !matches!(&answer, Err(err) if upgrading(err)) || self.origin.is_none() {
                return answer;
            }
            self.connect_again()?;
        }
    }

    /// Writes a request that expects a response, under the next ID, and returns that ID.
    fn ask(&mut self, method: &str, params: &impl Serialize) -> anyhow::Result<u64> {
        let id = self.ids.next().expect("request IDs do not run out");
        self.write(&Request::new(Some(id), method, params))?;
        Ok(id)
    }

    /// Writes a notification: a request nothing answers.
    fn tell(&mut self, method: &str, params: impl Serialize) -> io::Result<()> {
        self.write(&Request::new(None, method, params))
    }

    fn write(&mut self, message: &impl Serialize) -> io::Result<()> {
        self.writer.write_all(&encode_line(message))
    }

    /// Reads until the response to request `id`, keeping the notifications that come before it
    /// for `next_change` and answering a `closing` on the way. A connection that ends first leaves
    /// the outcome unknown: [`Cut`].
    fn answer_to<T: DeserializeOwned>(&mut self, id: u64) -> anyhow::Result<T> {
        loop {
            match read_server_message(&mut self.reader, &mut self.line) {
                Ok(Some(ServerMessage::Response(response))) if answers(&response, id) => {
                    return response_result(response);
                }
                Ok(Some(ServerMessage::Response(_))) => {}
                Ok(Some(ServerMessage::Notification(notification))) => {
                    if notification.method == methods::CLOSING {
                        self.closing = Some(closing_build(&notification));
                        self.respond_to_closing();
                    } else {
                        self.unread.push_back(notification);
                    }
                }
                Err(err) if err.kind() == ErrorKind::InvalidData => return Err(err.into()),
                Ok(None) | Err(_) => return Err(Cut.into()),
            }
        }
    }

    /// The next notification: one kept while a call waited, else the next one on the connection.
    /// Responses here answer nothing still waited for. None once the connection ends.
    fn next_notification(&mut self) -> io::Result<Option<Notification>> {
        if let Some(kept) = self.unread.pop_front() {
            return Ok(Some(kept));
        }
        while let Some(message) = read_server_message(&mut self.reader, &mut self.line)? {
            if let ServerMessage::Notification(notification) = message {
                return Ok(Some(notification));
            }
        }
        Ok(None)
    }
}

/// Whether `response` answers request `id`. A response with no ID answers the line the daemon
/// could not read, which is the request waiting.
fn answers(response: &Response, id: u64) -> bool {
    response.id.is_none_or(|answered| answered == id)
}

/// A response's result as `T`, or its error.
fn response_result<T: DeserializeOwned>(response: Response) -> anyhow::Result<T> {
    match response.error {
        Some(error) => Err(error.into()),
        None => Ok(serde_json::from_value(response.result.unwrap_or_default())?),
    }
}

/// The build named by a `closing` notification, the one taking over.
fn closing_build(notification: &Notification) -> String {
    let build = notification.params.get("build").and_then(Value::as_str);
    build.unwrap_or_default().to_owned()
}

fn call_params<O: Operation>(args: O::Args) -> anyhow::Result<CallParams> {
    let args = serde_json::to_value(args)?;
    Ok(CallParams {
        op: O::NAME.to_owned(),
        args,
    })
}

/// What the daemon answered to hello, read as this build's protocol.
fn hello_answer(message: Option<ServerMessage>) -> anyhow::Result<HelloResult> {
    let response = match message {
        Some(ServerMessage::Response(response)) => response,
        Some(ServerMessage::Notification(_)) => {
            anyhow::bail!("the Facade daemon did not respond to hello")
        }
        None => {
            let closed = io::Error::new(
                ErrorKind::UnexpectedEof,
                "the Facade daemon closed before hello",
            );
            return Err(closed.into());
        }
    };
    if let Some(error) = response.error {
        return Err(error.into());
    }
    let result = response.result.unwrap_or_default();
    // Whatever version the daemon claims, an answer this build cannot read is another protocol's.
    HelloResult::deserialize(&result).map_err(|err| another_protocol(&result, err).into())
}

/// The error for a hello answer of another protocol: this build, and the build and protocol the
/// daemon names, where it names them.
fn another_protocol(result: &Value, err: serde_json::Error) -> ErrorBody {
    let said = |key: &str| match result.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "?".to_owned(),
    };
    let ours = crate::build_id();
    let (build, protocol) = (said("build"), said("protocol"));
    let versions = format!("{MIN_DAEMON_PROTOCOL_VERSION}-{DAEMON_PROTOCOL_VERSION}");
    ErrorBody::new(
        Reason::ProtocolIncompatible,
        format!(
            "the Facade daemon's answer to hello does not read as daemon protocol {versions} of \
             this client, {ours}: {err}; the daemon says build {build} and protocol {protocol}; \
             update Facade"
        ),
    )
}

/// The line that asks the daemon to withdraw call `id` of the connection it is written to, as far
/// as that call can be: a notification, which nothing answers but the call's own result.
pub fn cancel_line(id: u64) -> Vec<u8> {
    encode_line(&Request::new(None, methods::CANCEL, CancelParams { id }))
}

/// Whether `err` is a daemon's refusal while a newer Facade takes over: nothing was done, and the
/// next daemon answers.
pub fn upgrading(err: &anyhow::Error) -> bool {
    matches!(
        err.downcast_ref::<ErrorBody>(),
        Some(body) if body.data.reason == Reason::Upgrading
    )
}

/// The transport failures worth another try: the daemon is not there yet, or went away.
const RETRIED_KINDS: [ErrorKind; 9] = [
    ErrorKind::NotFound,
    ErrorKind::ConnectionRefused,
    ErrorKind::ConnectionReset,
    ErrorKind::ConnectionAborted,
    ErrorKind::BrokenPipe,
    ErrorKind::UnexpectedEof,
    ErrorKind::TimedOut,
    ErrorKind::WouldBlock,
    ErrorKind::Interrupted,
];

/// Whether a transport failure before a decoded hello can be retried. Decoded errors and invalid
/// data are permanent.
pub fn transient_transport(err: &io::Error) -> bool {
    RETRIED_KINDS.contains(&err.kind()) || err.raw_os_error() == Some(libc::EIO)
}

#[cfg(test)]
mod tests {
    use std::io::BufRead;

    use super::*;

    /// A stand-in daemon's socket, removed when the test ends, whether it passes or fails. It lives
    /// in `/tmp`: a socket's path holds at most 104 bytes on macOS, which a test's own temporary
    /// folder can pass.
    struct TestSocket(PathBuf);

    impl TestSocket {
        fn new(name: &str) -> TestSocket {
            let path = Path::new("/tmp").join(format!("facade-{name}-{}.sock", std::process::id()));
            let _ = std::fs::remove_file(&path);
            TestSocket(path)
        }
    }

    impl Drop for TestSocket {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn terminal() -> Identity {
        Identity {
            kind: ClientKind::Terminal,
            agent: None,
            sessions: Vec::new(),
        }
    }

    fn read_hello(stream: &UnixStream) {
        let mut hello = String::new();
        std::io::BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut hello)
            .unwrap();
    }

    /// A daemon whose answer to hello this build cannot read is another protocol's: the client says
    /// so, naming both builds, and panics at nothing a peer sends.
    #[test]
    fn an_answer_to_hello_this_build_cannot_read_is_another_protocol_s() {
        let socket = TestSocket::new("hello-unread");
        let listener = std::os::unix::net::UnixListener::bind(&socket.0).unwrap();
        let daemon = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_hello(&stream);
            let answer = serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "result": { "protocol": 9, "build": "9.9.9" },
            });
            stream.write_all(format!("{answer}\n").as_bytes()).unwrap();
            // Held open until the client read the answer.
            let mut rest = String::new();
            let _ = std::io::BufReader::new(stream).read_line(&mut rest);
        });
        let connected = DaemonClient::connect(
            &socket.0,
            &terminal(),
            Instant::now() + Duration::from_secs(5),
            &mut |_| true,
        );
        let err = connected
            .err()
            .expect("an answer this build cannot read fails");
        daemon.join().unwrap();
        let body = err
            .downcast_ref::<ErrorBody>()
            .unwrap_or_else(|| panic!("not a protocol's error: {err:#}"));
        assert_eq!(
            body.data.reason,
            Reason::ProtocolIncompatible,
            "{}",
            body.message
        );
        assert!(
            body.message.contains("build 9.9.9 and protocol 9")
                && body.message.contains(&crate::build_id()),
            "{}",
            body.message
        );
    }

    /// A daemon that closes right after it answers hello, as one handing over does, is no daemon
    /// yet: the client goes on to the next one, though macOS refuses the options of a socket whose
    /// peer closed.
    #[test]
    fn a_daemon_that_closes_right_after_its_hello_is_no_daemon_yet() {
        let socket = TestSocket::new("hello-closed");
        let listener = std::os::unix::net::UnixListener::bind(&socket.0).unwrap();
        let daemon = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_hello(&stream);
            let answer = serde_json::json!({
                "jsonrpc": "2.0", "id": 1,
                "result": {
                    "protocol": 1, "build": "0.2.0", "pid": 1, "agents": 0, "topics": [], "ops": [],
                },
            });
            stream.write_all(format!("{answer}\n").as_bytes()).unwrap();
            // The stream closes here, before the client reads the answer.
        });
        let connected = DaemonClient::connect(
            &socket.0,
            &terminal(),
            Instant::now() + Duration::from_secs(5),
            &mut |_| true,
        );
        daemon.join().unwrap();
        assert!(connected.is_ok(), "{:?}", connected.err());
    }

    /// A daemon that closed the connection before hello, as one that ends before it took the
    /// connection does, is no daemon yet.
    #[test]
    fn a_daemon_that_closed_the_connection_before_hello_is_no_daemon_yet() {
        let socket = TestSocket::new("hello-unanswered");
        let listener = std::os::unix::net::UnixListener::bind(&socket.0).unwrap();
        let mut daemon = Some(std::thread::spawn(move || drop(listener.accept().unwrap())));
        // The client goes on once the daemon closed the connection.
        let connected = DaemonClient::connect(
            &socket.0,
            &terminal(),
            Instant::now() + Duration::from_secs(5),
            &mut |_| {
                daemon.take().unwrap().join().unwrap();
                true
            },
        );
        assert!(
            matches!(connected, Ok(None)),
            "{:?}",
            connected.map(|client| client.is_some())
        );
    }
}
