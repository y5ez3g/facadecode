//! Authenticated keeper transport. A connection owns its sockets, outstanding calls and exit gate.

use std::collections::HashMap;
use std::fmt;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::descriptors::{DescriptorLines, send_line};
use facade_base::jsonrpc::{ErrorBody, Reason, Request, ServerMessage, encode_line};
use facade_base::keeper::{self, AgentChange, DaemonPing, HelloParams, HelloResult, methods};
use facade_base::operations::{CallParams, NoArgs, Operation};
use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
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
type Response = Result<(Value, Vec<OwnedFd>), CallError>;
type Outgoing = (Vec<u8>, Option<OwnedFd>);

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
    descriptors: usize,
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

// Shutting down the original socket also wakes readers holding cloned descriptors.
struct Socket(UnixStream);
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
    pub async fn call<O: Operation>(
        &self,
        args: &O::Args,
        count: usize,
    ) -> Result<(O::Result, Vec<OwnedFd>), CallError> {
        let (value, fds) = self
            .request(methods::CALL, call_params::<O>(args), count, None)
            .await?;
        Ok((decode::<O>(value).map_err(CallError::Unknown)?, fds))
    }

    pub async fn send_master<O: Operation>(
        &self,
        args: &O::Args,
        fd: &OwnedFd,
    ) -> Result<O::Result, ErrorBody> {
        let descriptor = fd.try_clone().map_err(|error| {
            ErrorBody::new(
                Reason::Unavailable,
                format!("could not copy the descriptor for {}: {error}", O::NAME),
            )
        })?;
        let (value, _) = self
            .request(methods::CALL, call_params::<O>(args), 0, Some(descriptor))
            .await?;
        decode::<O>(value)
    }

    async fn request(
        &self,
        method: &str,
        params: impl Serialize,
        count: usize,
        fd: Option<OwnedFd>,
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
                descriptors: count,
                expired: false,
            },
        );
        let line = encode_line(&Request::new(Some(number), method, params));
        if let Err(error) = self.outgoing.try_send((line, fd)) {
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
                // Keep descriptor counts until the corresponding response arrives, even late.
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
                let _ = connection.call::<DaemonPing>(&NoArgs {}, 0).await;
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
        let socket = UnixStream::connect(address).map_err(|error| {
            ConnectError::Unreachable(format!("could not connect to the keeper: {error}"))
        })?;
        let peer = service::peer(&socket).map_err(|error| {
            ConnectError::Unreachable(format!("could not connect to the keeper: {error}"))
        })?;
        // SAFETY: getuid takes no arguments and always succeeds.
        if peer.uid != unsafe { libc::getuid() } {
            return Err(ConnectError::NotTheKeeper(format!(
                "process {} at the keeper socket belongs to another user",
                peer.pid
            )));
        }
        let authenticated = service::authenticate(&socket, core, Service::Keeper);
        let mut connection = Self::hello(socket, &peer, events, wakeup).await?;
        if keeper::shared_version(PROTOCOL, connection.hello.protocol).is_none() {
            return Err(ConnectError::Incompatible { pid: peer.pid });
        }
        let identity = authenticated.map_err(ConnectError::NotTheKeeper)?;
        if expected.is_some_and(|wanted| wanted != &identity) {
            return Err(ConnectError::NotTheKeeper(format!(
                "keeper {} is not the keeper this daemon was following",
                identity.pid
            )));
        }
        connection.identity = identity;
        facade_base::log::write(
            "daemon",
            "info",
            &format!(
                "connected to keeper {} (keeper protocol {:?}, build {})",
                peer.pid, connection.hello.protocol, connection.hello.build
            ),
        );
        Ok(Arc::new(connection))
    }

    async fn hello(
        stream: UnixStream,
        peer: &service::Peer,
        events: mpsc::UnboundedSender<RunEvent>,
        wakeup: watch::Sender<u64>,
    ) -> Result<Self, ConnectError> {
        let socket = Socket(stream);
        let writing = socket.0.try_clone().map_err(connection_io)?;
        let reading = socket.0.try_clone().map_err(connection_io)?;
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
                    let fds: Vec<_> = carried.iter().map(AsFd::as_fd).collect();
                    if let Err(error) = send_line(writing.as_fd(), &line, &fds, None) {
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
            identity: ProcessIdentity {
                pid: peer.pid,
                birth: String::new(),
            },
            hello: HelloResult {
                protocol: [0, 0],
                build: String::new(),
                agents: vec![],
            },
        };
        let value = match connection
            .request(methods::HELLO, HelloParams { protocol: PROTOCOL }, 0, None)
            .await
        {
            Ok((value, _)) => value,
            Err(error) if error.body().data.reason == Reason::ProtocolIncompatible => {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "keeper {} refused this daemon: {}",
                        peer.pid,
                        error.body().message
                    ),
                );
                return Err(ConnectError::Incompatible { pid: peer.pid });
            }
            Err(error) => {
                return Err(ConnectError::Unreachable(format!(
                    "keeper {} did not accept this daemon: {}",
                    peer.pid,
                    error.body().message
                )));
            }
        };
        connection.hello = serde_json::from_value(value).map_err(|error| {
            facade_base::log::write(
                "daemon",
                "warn",
                &format!(
                    "keeper {} sent a hello result this build cannot read: {error}",
                    peer.pid
                ),
            );
            connection.fence();
            ConnectError::Incompatible { pid: peer.pid }
        })?;
        Ok(connection)
    }
}

fn read(socket: UnixStream, io: &Transport) -> anyhow::Result<()> {
    let mut incoming = DescriptorLines::new(socket);
    while let Some((begin, bytes)) = incoming.next_line()? {
        let response = match serde_json::from_slice::<ServerMessage>(&bytes) {
            Ok(ServerMessage::Response(response)) => response,
            Ok(ServerMessage::Notification(message)) => {
                if message.method == methods::CHANGED {
                    match serde_json::from_value::<AgentChange>(message.params) {
                        Ok(AgentChange::Exit { agent, exit }) => io
                            .exits
                            .lock()
                            .unwrap()
                            .receive(RunEvent::Exited { id: agent, exit }),
                        Ok(AgentChange::Unknown) => {}
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
        let result = if let Some(error) = response.error {
            Err(CallError::Refused(error))
        } else {
            let fds = if call.descriptors == 0 {
                Ok(vec![])
            } else {
                incoming.take(begin, call.descriptors)
            };
            fds.map(|fds| (response.result.unwrap_or(Value::Null), fds))
                .map_err(|came| {
                    CallError::Unknown(ErrorBody::new(
                        Reason::Internal,
                        format!(
                            "the keeper response carried {came} descriptors; {} were expected",
                            call.descriptors
                        ),
                    ))
                })
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
    use std::io::{Read, Write};

    #[tokio::test]
    async fn a_failed_hello_closes_both_socket_threads() {
        let (client, mut server) = UnixStream::pair().unwrap();
        // SAFETY: getuid has no preconditions.
        let peer = service::Peer {
            uid: unsafe { libc::getuid() },
            pid: std::process::id(),
        };
        let peer_thread = std::thread::spawn(move || {
            let mut byte = [0];
            loop {
                server.read_exact(&mut byte).unwrap();
                if byte[0] == b'\n' {
                    break;
                }
            }
            server
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\
                      \"fixture refusal\",\"data\":{\"reason\":\"refused\"}}}\n",
                )
                .unwrap();
            server
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            server.read(&mut byte)
        });
        let (events, _) = mpsc::unbounded_channel();
        assert!(
            KeeperClient::hello(client, &peer, events, tokio::sync::watch::channel(0).0)
                .await
                .is_err()
        );
        assert!(
            matches!(peer_thread.join().unwrap(), Ok(0)),
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
