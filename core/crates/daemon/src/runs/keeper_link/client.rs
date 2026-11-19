//! Authenticated keeper transport. A connection owns its sockets, outstanding calls and exit gate.

use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::jsonrpc::{ErrorBody, Reason, Request, ServerMessage, encode_line};
use facade_base::keeper::{
    self, DaemonPing, KeeperAgentChange, KeeperHelloParams, KeeperHelloResult, methods,
};
use facade_base::operations::{CallParams, NoArgs, Operation};
use facade_base::paths::ClientSocket;
use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
use facade_base::terminal::PtyMaster;
use facade_base::terminal_lines::{LineReceiver, LineSender};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use super::RunEvent;

const RESPONSE_WAIT: Duration = Duration::from_secs(10);
const OUTBOX_LIMIT: usize = 256;
const PROTOCOL: [u32; 2] = [
    keeper::MIN_KEEPER_PROTOCOL_VERSION,
    keeper::KEEPER_PROTOCOL_VERSION,
];
type Response = Result<(Value, Option<PtyMaster>), CallError>;
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
    fn body(&self) -> &ErrorBody {
        match self {
            Self::Refused(e) | Self::Unsent(e) | Self::Unknown(e) => e,
        }
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
            "keeper {pid} uses an incompatible Facade build; end that process and stop the running \
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

struct Waiting {
    sender: oneshot::Sender<Response>,
    expired: bool,
}

struct Transport {
    calls: Mutex<HashMap<u64, Waiting>>,
    closed: watch::Sender<bool>,
    exits: Mutex<ExitDelivery>,
}
impl Transport {
    fn disconnected(&self) {
        self.closed.send_replace(true);
        for (_, call) in self.calls.lock().unwrap().drain() {
            let _ = call.sender.send(Err(CallError::Unknown(disconnected())));
        }
    }
}

// Shutting down the original socket also wakes the reader and writer blocked on its clones.
struct Socket(ClientSocket);
impl Drop for Socket {
    fn drop(&mut self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
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

pub(super) struct KeeperClient {
    io: Arc<Transport>,
    socket: Socket,
    outgoing: SyncSender<Outgoing>,
    sequence: AtomicU64,
    pub hello: KeeperHelloResult,
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
fn call_params<O: Operation>(args: &O::Args) -> CallParams {
    CallParams {
        op: O::NAME.into(),
        args: serde_json::to_value(args).expect("protocol value must serialize"),
    }
}
fn decode<O: Operation>(value: Value) -> Result<O::Result, ErrorBody> {
    serde_json::from_value(value).map_err(|error| {
        ErrorBody::new(
            Reason::Internal,
            format!("invalid keeper result for {}: {error}", O::NAME),
        )
    })
}

impl KeeperClient {
    /// Calls an operation; its result comes with the terminal its response carried, if any.
    pub async fn call<O: Operation>(
        &self,
        args: &O::Args,
    ) -> Result<(O::Result, Option<PtyMaster>), CallError> {
        let (value, terminal) = self
            .request(methods::CALL, call_params::<O>(args), None)
            .await?;
        Ok((decode::<O>(value).map_err(CallError::Unknown)?, terminal))
    }

    /// Calls an operation whose request carries a copy of `master` as it is.
    pub async fn send_master<O: Operation>(
        &self,
        args: &O::Args,
        master: &PtyMaster,
    ) -> Result<O::Result, ErrorBody> {
        let copy = master.try_clone().map_err(|error| {
            ErrorBody::new(
                Reason::Unavailable,
                format!("could not copy the terminal for {}: {error}", O::NAME),
            )
        })?;
        let (value, _) = self
            .request(methods::CALL, call_params::<O>(args), Some(copy))
            .await?;
        decode::<O>(value)
    }

    async fn request(
        &self,
        method: &str,
        params: impl Serialize,
        terminal: Option<PtyMaster>,
    ) -> Response {
        if *self.io.closed.borrow() {
            return Err(CallError::Unsent(disconnected()));
        }
        let number = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.io.calls.lock().unwrap().insert(
            number,
            Waiting {
                sender,
                expired: false,
            },
        );
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
            Err(_) => {
                // A late response is still read, and the terminal it carries closed.
                if let Some(call) = self.io.calls.lock().unwrap().get_mut(&number) {
                    call.expired = true;
                }
                Err(CallError::Unknown(ErrorBody::new(
                    Reason::Unavailable,
                    "the keeper did not respond within 10 seconds; the outcome is unknown; check \
                     `facade list`",
                )))
            }
        }
    }

    pub fn fence(&self) {
        let _ = self.socket.0.shutdown(std::net::Shutdown::Both);
        self.io.disconnected();
    }
    pub fn closed(&self) -> watch::Receiver<bool> {
        self.io.closed.subscribe()
    }
    pub fn deliver_exits(&self) {
        self.io.exits.lock().unwrap().ready();
    }

    pub fn ping(self: &Arc<Self>) {
        let connection = Arc::clone(self);
        tokio::spawn(async move {
            let mut closed = connection.closed();
            while !*closed.borrow() {
                let _ = connection.call::<DaemonPing>(&NoArgs {}).await;
                let _ = tokio::time::timeout(Duration::from_secs(1), closed.changed()).await;
            }
        });
    }

    pub async fn connect(
        core: &Path,
        expected: Option<&ProcessIdentity>,
        events: mpsc::UnboundedSender<RunEvent>,
        wakeup: watch::Sender<u64>,
    ) -> Result<Arc<Self>, ConnectError> {
        let address = facade_base::paths::keeper_socket()
            .map_err(|error| ConnectError::Unreachable(format!("{error:#}")))?;
        let socket = ClientSocket::connect(address).map_err(|error| {
            ConnectError::Unreachable(format!("could not connect to the keeper: {error}"))
        })?;
        let identity = service::authenticate_server(&socket, core, Service::Keeper)
            .map_err(ConnectError::NotTheKeeper)?;
        let pid = identity.pid;
        let connection = Self::hello(socket, identity, events, wakeup).await?;
        if keeper::shared_version(PROTOCOL, connection.hello.protocol_range).is_none() {
            return Err(ConnectError::Incompatible { pid });
        }
        if expected.is_some_and(|wanted| wanted != &connection.identity) {
            return Err(ConnectError::NotTheKeeper(format!(
                "keeper {pid} is not the keeper this daemon was following"
            )));
        }
        facade_base::log::write(
            "daemon",
            "info",
            &format!(
                "connected to keeper {pid} (keeper protocol {:?}, build {})",
                connection.hello.protocol_range, connection.hello.build
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
        let socket = Socket(stream);
        let writing = socket.0.try_clone().map_err(connection_io)?;
        let writing = LineSender::new(writing, &identity).map_err(connection_io)?;
        let reading = LineReceiver::new(socket.0.try_clone().map_err(connection_io)?);
        let io = Arc::new(Transport {
            calls: Mutex::default(),
            closed: watch::channel(false).0,
            exits: Mutex::new(ExitDelivery {
                ready: false,
                pending: vec![],
                events,
            }),
        });
        let (outgoing, queued) = sync_channel::<Outgoing>(OUTBOX_LIMIT);
        let writer_io = Arc::clone(&io);
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
                        writer_io.disconnected();
                        return;
                    }
                    wakeup.send_modify(|n| *n += 1);
                }
            })
            .map_err(connection_io)?;
        let reader_io = Arc::clone(&io);
        std::thread::Builder::new()
            .name("keeper-reader".into())
            .spawn(move || {
                if let Err(error) = read(reading, &reader_io) {
                    facade_base::log::write(
                        "daemon",
                        "warn",
                        &format!("the keeper connection failed: {error}"),
                    );
                }
                reader_io.disconnected();
            })
            .map_err(connection_io)?;
        let mut connection = Self {
            io,
            socket,
            outgoing,
            sequence: AtomicU64::new(1),
            identity,
            hello: KeeperHelloResult {
                protocol_range: [0, 0],
                build: String::new(),
                held_agents: vec![],
            },
        };
        let value = match connection
            .request(
                methods::HELLO,
                KeeperHelloParams {
                    protocol_range: PROTOCOL,
                },
                None,
            )
            .await
        {
            Ok((value, _)) => value,
            Err(error) if error.body().data.reason == Reason::IncompatibleProtocol => {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!("keeper {pid} refused this daemon: {}", error.body().message),
                );
                return Err(ConnectError::Incompatible { pid });
            }
            Err(error) => {
                return Err(ConnectError::Unreachable(format!(
                    "keeper {pid} did not accept this daemon: {}",
                    error.body().message
                )));
            }
        };
        connection.hello = serde_json::from_value(value).map_err(|error| {
            facade_base::log::write(
                "daemon",
                "warn",
                &format!("keeper {pid} sent a hello result this build cannot read: {error}"),
            );
            connection.fence();
            ConnectError::Incompatible { pid }
        })?;
        Ok(connection)
    }
}

fn read(mut incoming: LineReceiver, io: &Transport) -> anyhow::Result<()> {
    while let Some((bytes, terminal)) = incoming.next_line()? {
        let response = match serde_json::from_slice::<ServerMessage>(&bytes) {
            Ok(ServerMessage::Response(response)) => response,
            Ok(ServerMessage::Notification(message)) => {
                if message.method == methods::CHANGED {
                    match serde_json::from_value::<KeeperAgentChange>(message.params) {
                        Ok(KeeperAgentChange::Exit { agent, exit }) => io
                            .exits
                            .lock()
                            .unwrap()
                            .receive(RunEvent::Exited { id: agent, exit }),
                        Ok(KeeperAgentChange::Unknown) => {}
                        Err(error) => facade_base::log::write(
                            "daemon",
                            "warn",
                            &format!("invalid keeper notification: {error}"),
                        ),
                    }
                }
                continue;
            }
            Err(error) => {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!("invalid keeper message: {error}"),
                );
                continue;
            }
        };
        let Some(number) = response.id else {
            facade_base::log::write(
                "daemon",
                "warn",
                &format!(
                    "the keeper rejected a daemon message: {:?}",
                    response.error.map(|error| error.message)
                ),
            );
            continue;
        };
        let call = io.calls.lock().unwrap().remove(&number);
        let Some(call) = call else {
            facade_base::log::write(
                "daemon",
                "warn",
                &format!("the keeper responded to unknown request {number}"),
            );
            continue;
        };
        let result = match response.error {
            Some(error) => Err(CallError::Refused(error)),
            None => Ok((response.result.unwrap_or(Value::Null), terminal)),
        };
        if call.expired {
            if result.is_ok() {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!("keeper request {number} succeeded after the caller stopped waiting"),
                );
            }
        } else {
            let _ = call.sender.send(result);
        }
    }
    facade_base::log::write("daemon", "warn", "the keeper closed its connection");
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
