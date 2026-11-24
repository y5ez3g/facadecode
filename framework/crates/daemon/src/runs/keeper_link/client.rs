//! Authenticated keeper transport. A connection owns its sockets, outstanding calls and exit gate.

use std::collections::HashMap;
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use facade_base::api_v1::keeper::{
    self, AgentChange, AgentStart, AgentStop, AgentSync, DaemonPing, HelloParams, HelloResult,
    PingArgs, StartArgs, StartResult, StopArgs, SyncArgs, methods,
};
use facade_base::api_v1::{
    ApiVersions, CallParams, ErrorBody as WireError, Operation, Request, ResponseBody,
    ServerMessage, encode_line, read_server_message,
};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::paths::ClientSocket;
use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
use facade_base::terminal::PtyMaster;
use facade_base::terminal_lines::{LineReceiver, LineSender};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use super::{RunEvent, StopAccepted};

const RESPONSE_WAIT: Duration = Duration::from_secs(10);
const OUTBOX_LIMIT: usize = 256;
type Response = Result<Reply, CallError>;
type Outgoing = (Vec<u8>, Option<PtyMaster>);

pub(super) enum CallError {
    Refused(ErrorBody),
    Unsent(ErrorBody),
    Unknown(ErrorBody),
}

impl CallError {
    pub fn uncertain(&self) -> bool {
        matches!(self, Self::Unknown(_))
    }
}
impl From<CallError> for ErrorBody {
    fn from(error: CallError) -> Self {
        match error {
            CallError::Refused(e) | CallError::Unsent(e) | CallError::Unknown(e) => e,
        }
    }
}

#[derive(Debug)]
pub(super) enum ConnectError {
    Unreachable(String),
    NotTheKeeper(String),
    Incompatible { pid: u32 },
}
impl ConnectError {
    pub fn refusal(pid: u32) -> String {
        format!(
            "keeper {pid} uses an incompatible Keeper API; end that process and stop the running \
                 Facade before switching builds"
        )
    }
}
impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Incompatible { pid } => f.write_str(&Self::refusal(*pid)),
            Self::Unreachable(text) | Self::NotTheKeeper(text) => f.write_str(text),
        }
    }
}
impl std::error::Error for ConnectError {}

enum ExpectedReply {
    Hello(ApiVersions),
    Start,
    Stop(Option<StopAccepted>),
    SyncTakeBack,
    SyncAdopt,
    Ping,
}

enum Reply {
    Hello(HelloResult),
    Started(StartResult, PtyMaster),
    Terminal(PtyMaster),
    Empty,
}

impl ExpectedReply {
    fn name(&self) -> &'static str {
        match self {
            Self::Hello(_) => methods::HELLO,
            Self::Start => AgentStart::NAME,
            Self::Stop(_) => AgentStop::NAME,
            Self::SyncTakeBack | Self::SyncAdopt => AgentSync::NAME,
            Self::Ping => DaemonPing::NAME,
        }
    }

    fn decode(&self, value: Value, terminal: Option<PtyMaster>) -> anyhow::Result<Reply> {
        match (self, terminal) {
            (Self::Hello(offered), None) => {
                Ok(Reply::Hello(keeper::decode_hello_result(value, offered)?))
            }
            (Self::Start, Some(master)) => {
                Ok(Reply::Started(serde_json::from_value(value)?, master))
            }
            (Self::SyncTakeBack, Some(master)) => Ok(Reply::Terminal(master)),
            (Self::Stop(_) | Self::SyncAdopt | Self::Ping, None) => Ok(Reply::Empty),
            (_, Some(_)) => anyhow::bail!("the response carried an unexpected terminal"),
            (_, None) => anyhow::bail!("the response did not carry the required terminal"),
        }
    }
}

struct Waiting {
    expected: ExpectedReply,
    sender: oneshot::Sender<Response>,
}

struct Transport {
    socket: ClientSocket,
    calls: Mutex<HashMap<u64, Waiting>>,
    closed: watch::Sender<bool>,
    exits: Mutex<ExitDelivery>,
}
impl Transport {
    fn disconnect(&self, failure: Option<&anyhow::Error>) {
        let mut calls = self.calls.lock().unwrap();
        if self.closed.send_replace(true) {
            return;
        }
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
        for (number, waiting) in calls.drain() {
            let error = failure.map_or_else(disconnected, |failure| {
                let reason = if matches!(waiting.expected, ExpectedReply::Hello(_))
                    && failure
                        .downcast_ref::<WireError>()
                        .is_some_and(|error| error.data.reason == "protocol_incompatible")
                {
                    Reason::IncompatibleProtocol
                } else {
                    Reason::Unavailable
                };
                ErrorBody::new(
                    reason,
                    format!(
                        "keeper connection failed while awaiting {} request {number}: {failure:#}; \
                         the outcome is unknown; check `facade list`",
                        waiting.expected.name()
                    ),
                )
            });
            let _ = waiting.sender.send(Err(CallError::Unknown(error)));
        }
    }
}

struct ExitDelivery {
    ready: bool,
    pending: Vec<RunEvent>,
    events: mpsc::UnboundedSender<RunEvent>,
}
impl ExitDelivery {
    fn receive(&mut self, event: RunEvent) {
        if self.ready {
            let _ = self.events.send(event);
        } else {
            self.pending.push(event);
        }
    }
    fn ready(&mut self) {
        self.ready = true;
        for event in self.pending.drain(..) {
            let _ = self.events.send(event);
        }
    }
}

struct Session {
    io: Arc<Transport>,
    outgoing: SyncSender<Outgoing>,
    sequence: AtomicU64,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.io.disconnect(None);
    }
}

pub(super) struct KeeperClient {
    session: Session,
    pub hello: HelloResult,
    pub identity: ProcessIdentity,
}

fn disconnected() -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        "the keeper disconnected before responding; the outcome is unknown; check `facade list`",
    )
}

fn connection_io(error: std::io::Error) -> ConnectError {
    ConnectError::Unreachable(format!("could not use the keeper connection: {error}"))
}

fn refusal(error: WireError) -> ErrorBody {
    let reason =
        serde_json::from_value(Value::String(error.data.reason)).unwrap_or(Reason::Unknown);
    let mut body = ErrorBody::new(reason, error.message);
    body.code = error.code;
    body
}

impl Session {
    fn open(
        socket: ClientSocket,
        identity: &ProcessIdentity,
        events: mpsc::UnboundedSender<RunEvent>,
        wakeup: watch::Sender<u64>,
    ) -> Result<Self, ConnectError> {
        let writing = socket.try_clone().map_err(connection_io)?;
        let writing = LineSender::new(writing, identity).map_err(connection_io)?;
        let reading = LineReceiver::new(socket.try_clone().map_err(connection_io)?);
        let io = Arc::new(Transport {
            socket,
            calls: Mutex::default(),
            closed: watch::channel(false).0,
            exits: Mutex::new(ExitDelivery {
                ready: false,
                pending: vec![],
                events,
            }),
        });
        let (outgoing, queued) = sync_channel::<Outgoing>(OUTBOX_LIMIT);
        let session = Self {
            io,
            outgoing,
            sequence: AtomicU64::new(1),
        };
        let writer_io = Arc::clone(&session.io);
        std::thread::Builder::new()
            .name("keeper-writer".into())
            .spawn(move || {
                for (line, carried) in queued {
                    if let Err(error) = writing.send(&line, carried.as_ref()) {
                        facade_base::log::write(
                            "daemon",
                            "warn",
                            &format!("could not write to the keeper connection: {error}"),
                        );
                        writer_io.disconnect(None);
                        return;
                    }
                    wakeup.send_modify(|n| *n += 1);
                }
            })
            .map_err(connection_io)?;
        let reader_io = Arc::clone(&session.io);
        std::thread::Builder::new()
            .name("keeper-reader".into())
            .spawn(move || match read(reading, &reader_io) {
                Ok(()) => {
                    reader_io.disconnect(None);
                    facade_base::log::write("daemon", "warn", "the keeper closed its connection");
                }
                Err(error) => {
                    reader_io.disconnect(Some(&error));
                    facade_base::log::write(
                        "daemon",
                        "warn",
                        &format!("the keeper connection failed: {error:#}"),
                    );
                }
            })
            .map_err(connection_io)?;
        Ok(session)
    }

    async fn call<O: Operation>(
        &self,
        expected: ExpectedReply,
        args: &O::Args,
        terminal: Option<PtyMaster>,
    ) -> Response {
        let params = CallParams {
            op: O::NAME.into(),
            args: serde_json::to_value(args).expect("protocol value must serialize"),
        };
        self.request(expected, methods::CALL, params, terminal)
            .await
    }

    async fn request(
        &self,
        expected: ExpectedReply,
        method: &str,
        params: impl Serialize,
        terminal: Option<PtyMaster>,
    ) -> Response {
        let number = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut calls = self.io.calls.lock().unwrap();
            if *self.io.closed.borrow() {
                return Err(CallError::Unsent(disconnected()));
            }
            calls.insert(number, Waiting { expected, sender });
        }
        let line = encode_line(&Request::new(Some(number), method, params));
        if let Err(error) = self.outgoing.try_send((line, terminal)) {
            self.io.calls.lock().unwrap().remove(&number);
            let body = match error {
                TrySendError::Disconnected(_) => disconnected(),
                TrySendError::Full(_) => ErrorBody::new(
                    Reason::Unavailable,
                    format!("keeper request queue is full: {OUTBOX_LIMIT} requests are waiting"),
                ),
            };
            return Err(CallError::Unsent(body));
        }
        match tokio::time::timeout(RESPONSE_WAIT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CallError::Unknown(disconnected())),
            // Keep the expectation until the reply arrives or the connection closes.
            Err(_) => Err(CallError::Unknown(ErrorBody::new(
                Reason::Unavailable,
                "the keeper did not respond within 10 seconds; the outcome is unknown; check \
                 `facade list`",
            ))),
        }
    }
}

impl KeeperClient {
    pub async fn start(&self, args: &StartArgs) -> Result<(StartResult, PtyMaster), CallError> {
        let reply = self
            .session
            .call::<AgentStart>(ExpectedReply::Start, args, None)
            .await?;
        let Reply::Started(process, terminal) = reply else {
            unreachable!("start replies are decoded as Started");
        };
        Ok((process, terminal))
    }

    pub async fn stop(
        &self,
        args: &StopArgs,
        attribution: Option<StopAccepted>,
    ) -> Result<(), CallError> {
        self.session
            .call::<AgentStop>(ExpectedReply::Stop(attribution), args, None)
            .await?;
        Ok(())
    }

    pub async fn take_terminal(&self, args: &SyncArgs) -> Result<PtyMaster, ErrorBody> {
        let reply = self
            .session
            .call::<AgentSync>(ExpectedReply::SyncTakeBack, args, None)
            .await?;
        let Reply::Terminal(master) = reply else {
            unreachable!("sync take-back replies are decoded as Terminal");
        };
        Ok(master)
    }

    pub async fn give_terminal(&self, args: &SyncArgs, master: PtyMaster) -> Result<(), ErrorBody> {
        self.session
            .call::<AgentSync>(ExpectedReply::SyncAdopt, args, Some(master))
            .await?;
        Ok(())
    }

    pub fn fence(&self) {
        self.session.io.disconnect(None);
    }

    pub fn closed(&self) -> watch::Receiver<bool> {
        self.session.io.closed.subscribe()
    }

    pub fn deliver_exits(&self) {
        self.session.io.exits.lock().unwrap().ready();
    }

    pub fn ping(self: &Arc<Self>) {
        let connection = Arc::clone(self);
        tokio::spawn(async move {
            let mut closed = connection.closed();
            while !*closed.borrow() {
                let _ = connection
                    .session
                    .call::<DaemonPing>(ExpectedReply::Ping, &PingArgs {}, None)
                    .await;
                let _ = tokio::time::timeout(Duration::from_secs(1), closed.changed()).await;
            }
        });
    }

    pub async fn connect(
        framework: &Path,
        expected: &ProcessIdentity,
        events: mpsc::UnboundedSender<RunEvent>,
        wakeup: watch::Sender<u64>,
    ) -> Result<Arc<Self>, ConnectError> {
        let address = facade_base::paths::keeper_socket()
            .map_err(|error| ConnectError::Unreachable(format!("{error:#}")))?;
        let socket = ClientSocket::connect(address).map_err(|error| {
            ConnectError::Unreachable(format!("could not connect to the keeper: {error}"))
        })?;
        let identity = service::authenticate_server(&socket, framework, Service::Keeper)
            .map_err(ConnectError::NotTheKeeper)?;
        let pid = identity.pid;
        if expected != &identity {
            return Err(ConnectError::NotTheKeeper(format!(
                "keeper {pid} is not the keeper this daemon was following"
            )));
        }
        let connection = Self::hello(socket, identity, events, wakeup).await?;
        facade_base::log::write(
            "daemon",
            "info",
            &format!(
                "connected to keeper {pid} (Keeper API {}, build {})",
                connection.hello.api_version, connection.hello.build
            ),
        );
        Ok(Arc::new(connection))
    }

    /// Says hello on `stream`, whose other end is proved to be the keeper `identity`.
    async fn hello(
        stream: ClientSocket,
        identity: ProcessIdentity,
        events: mpsc::UnboundedSender<RunEvent>,
        wakeup: watch::Sender<u64>,
    ) -> Result<Self, ConnectError> {
        let pid = identity.pid;
        let session = Session::open(stream, &identity, events, wakeup)?;
        let offer = ApiVersions::new(keeper::SUPPORTED_API_VERSIONS.to_vec())
            .expect("the keeper API version set is nonempty");
        let reply = session
            .request(
                ExpectedReply::Hello(offer.clone()),
                methods::HELLO,
                HelloParams {
                    api_versions: offer,
                },
                None,
            )
            .await
            .map_err(|error| {
                let body = ErrorBody::from(error);
                if body.data.reason == Reason::IncompatibleProtocol {
                    facade_base::log::write(
                        "daemon",
                        "warn",
                        &format!("keeper {pid} refused this daemon: {}", body.message),
                    );
                    ConnectError::Incompatible { pid }
                } else {
                    ConnectError::Unreachable(format!(
                        "keeper {pid} did not accept this daemon: {}",
                        body.message
                    ))
                }
            })?;
        let Reply::Hello(hello) = reply else {
            unreachable!("hello replies are decoded as Hello");
        };
        Ok(Self {
            session,
            hello,
            identity,
        })
    }
}

fn read(mut incoming: LineReceiver, io: &Transport) -> anyhow::Result<()> {
    let mut buffer = Vec::new();
    let mut negotiated = false;
    while let Some((bytes, terminal)) = incoming.next_line()? {
        let mut line = bytes.as_slice().chain(b"\n".as_slice());
        match read_server_message(&mut line, &mut buffer)?
            .context("the keeper sent an empty frame")?
        {
            ServerMessage::Notification(message) => {
                anyhow::ensure!(terminal.is_none(), "keeper notification carried a terminal");
                anyhow::ensure!(negotiated, "keeper sent a notification before hello");
                if message.method == methods::CHANGED
                    && let AgentChange::Exit { agent_id, exit } =
                        serde_json::from_value(message.params).context("invalid keeper change")?
                {
                    io.exits
                        .lock()
                        .unwrap()
                        .receive(RunEvent::Exited { id: agent_id, exit });
                }
            }
            ServerMessage::Response(response) => {
                let mut calls = io.calls.lock().unwrap();
                let decoded = match response.body {
                    ResponseBody::Error(error) => {
                        anyhow::ensure!(
                            terminal.is_none(),
                            "keeper error response for request {:?} carried a terminal",
                            response.id
                        );
                        if response.id.is_none() {
                            facade_base::log::write(
                                "daemon",
                                "warn",
                                &format!(
                                    "the keeper refused a message without a request ID: {error}"
                                ),
                            );
                            continue;
                        }
                        Err(CallError::Refused(refusal(error)))
                    }
                    ResponseBody::Result(value) => {
                        let number = response
                            .id
                            .context("keeper success is missing a request ID")?;
                        anyhow::ensure!(
                            value.is_object(),
                            "keeper response for request {number} must be an object"
                        );
                        let Some(waiting) = calls.get(&number) else {
                            continue;
                        };
                        Ok(waiting.expected.decode(value, terminal).with_context(|| {
                            format!(
                                "invalid keeper {} response for request {number}",
                                waiting.expected.name()
                            )
                        })?)
                    }
                };
                if let Some(number) = response.id
                    && let Some(waiting) = calls.remove(&number)
                {
                    drop(calls);
                    if matches!(decoded, Ok(Reply::Hello(_))) {
                        negotiated = true;
                    }
                    if matches!(decoded, Ok(Reply::Empty))
                        && let ExpectedReply::Stop(Some(stop)) = waiting.expected
                    {
                        io.exits
                            .lock()
                            .unwrap()
                            .receive(RunEvent::StopAccepted(stop));
                    }
                    // The result owns its terminal until the waiting caller receives it.
                    if let Err(Ok(_)) = waiting.sender.send(decoded) {
                        facade_base::log::write(
                            "daemon",
                            "warn",
                            &format!(
                                "keeper request {number} succeeded after the caller stopped waiting"
                            ),
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn a_failed_hello_closes_both_socket_threads() {
        let (client, server) = facade_base::sockets::pair().unwrap();
        let identity = facade_base::unix_process::own_identity().unwrap();
        let peer_task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut line = Vec::new();
            server.read_until(b'\n', &mut line).await.unwrap();
            server
                .get_mut()
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\
                      \"fixture refusal\",\"data\":{\"reason\":\"refused\"}}}\n",
                )
                .await
                .unwrap();
            let mut byte = [0];
            tokio::time::timeout(Duration::from_secs(2), server.read(&mut byte)).await
        });
        let (events, _) = mpsc::unbounded_channel();
        assert!(
            KeeperClient::hello(client, identity, events, tokio::sync::watch::channel(0).0)
                .await
                .is_err()
        );
        assert!(
            matches!(peer_task.await.unwrap(), Ok(Ok(0))),
            "a refused handshake must shut down every socket copy"
        );
    }

    #[test]
    fn exits_wait_for_reconciliation_to_install_their_sinks() {
        let (events, mut received) = mpsc::unbounded_channel();
        let mut delivery = ExitDelivery {
            ready: false,
            pending: Vec::new(),
            events,
        };
        delivery.receive(RunEvent::Exited {
            id: "a1".into(),
            exit: facade_base::process::ProcessExit {
                code: Some(7),
                signal: None,
                reason: None,
                at: "t".into(),
            },
        });
        assert!(received.try_recv().is_err());
        delivery.ready();
        let event = received.try_recv().unwrap();
        assert!(matches!(
            event,
            RunEvent::Exited {
                exit: facade_base::process::ProcessExit { code: Some(7), .. },
                ..
            }
        ));
        assert!(
            received.try_recv().is_err(),
            "one notification after the boundary"
        );
    }
}
