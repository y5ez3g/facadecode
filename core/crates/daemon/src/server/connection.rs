//! One connection, from its first line to its cleanup: it says hello, then each line it sends is
//! a request that the service answers.

use std::collections::HashMap;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::daemon::{
    AgentResize, AgentType, CancelParams, ClientKind, ClosingParams, DAEMON_PROTOCOL_VERSION,
    DaemonUpgrade, HelloParams, MIN_DAEMON_PROTOCOL_VERSION, UnwatchParams, WatchParams,
    WatchResult, methods,
};
use facade_base::jsonrpc::{
    ErrorBody, MAX_LINE_BYTES, Notification, Reason, decode_arguments, encode_line, parse_request,
};
use facade_base::operations::{CallParams, EmptyResult, Operation};
use nix::sys::socket::Shutdown;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedReadHalf;
use tokio::sync::{Notify, Semaphore, mpsc, watch};
use tokio::task::JoinHandle;

use super::lanes::{LaneContext, Lanes};
use super::outbox::Outbox;
use super::{Client, Service, WatchChange, WhenFull};
use crate::Cancel;

/// The most calls one connection runs at once. Further calls wait for one to be answered.
const MAX_CALLS_IN_FLIGHT: usize = 16;
/// A connection that has not said hello by then is closed.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a client has to answer `closing`; one that does not, such as an older one, is cut off.
const CLOSING_ANSWERED_WITHIN: Duration = Duration::from_millis(200);

/// Screen viewers, numbered across all connections.
static NEXT_VIEWER: AtomicU64 = AtomicU64::new(1);

pub(super) type Reader = BufReader<OwnedReadHalf>;

/// The client end of a connection.
pub(super) struct Peer {
    /// A copy of the socket: watched for the client closing while its reading waits, and shut
    /// down to cut the client off.
    socket: OwnedFd,
    /// True once the client closed: waiting input then stops waiting.
    closed: watch::Sender<bool>,
    /// The client closed while its input waited: input after it would arrive with a gap, so
    /// nothing more from it runs.
    gave_up: AtomicBool,
}

impl Peer {
    /// Whether nothing more from the client runs.
    pub(super) fn hung_up(&self) -> bool {
        self.gave_up.load(Ordering::SeqCst)
    }

    /// The cancellation of input that waits for room: asked for once the client closed.
    pub(super) fn hangup(&self) -> Cancel {
        Cancel::of(self.closed.subscribe())
    }

    /// Whether the client closed.
    pub(super) fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Notes that input waiting for room ended because the client closed.
    pub(super) fn give_up(&self) {
        self.gave_up.store(true, Ordering::SeqCst);
    }

    /// Waits until the client closes, even with bytes still unread, and notes it. Watches the copy
    /// of the socket, so the connection's reader neither loses bytes nor readiness.
    pub(super) async fn closed(&self) {
        wait_for_close(&self.socket).await;
        self.closed.send_replace(true);
        self.give_up();
    }

    fn shut(&self, how: Shutdown) {
        let _ = nix::sys::socket::shutdown(self.socket.as_raw_fd(), how);
    }
}

async fn wait_for_close(socket: &OwnedFd) {
    use tokio::io::Interest;
    use tokio::io::unix::AsyncFd;
    let Ok(copy) = socket.try_clone() else {
        return std::future::pending().await;
    };
    // SAFETY: the copy is owned by the AsyncFd, so it stays open, and the same descriptor, for as
    // long as it is registered.
    let Ok(watched) = (unsafe { AsyncFd::register_with_interest(copy, Interest::READABLE) }) else {
        return std::future::pending().await;
    };
    while let Ok(mut ready) = watched.readable().await {
        if ready.ready().is_read_closed() {
            return;
        }
        // Readable bytes belong to the reader: wait for more of them, or for the close.
        ready.clear_ready();
    }
}

/// A watch this connection started.
struct Watching {
    forwarder: JoinHandle<()>,
    topic: String,
    viewer: u64,
}

pub(super) struct Connection<S: Service> {
    pub(super) service: Arc<S>,
    pub(super) peer: Arc<Peer>,
    pub(super) outbox: Outbox,
    pub(super) peer_pid: Option<u32>,
    client: Option<Arc<Client>>,
    /// What the service gave the hello, held until the connection is cleaned up.
    hold: Option<S::Hold>,
    lanes: Lanes,
    call_slots: Arc<Semaphore>,
    /// Calls with a request ID under way, each with what tells it that `cancel` named it.
    calls: Arc<Mutex<HashMap<u64, watch::Sender<bool>>>>,
    watches: HashMap<u64, Watching>,
    last_watch: u64,
    /// Told when the client answers `closing`.
    pub(super) answered: Arc<Notify>,
    /// Tells the client `closing` once a newer Facade takes over.
    pub(super) teller: Option<JoinHandle<()>>,
}

/// What a request leaves the connection to do.
enum Next {
    Read,
    End,
    /// Carry MCP from now on: the hello of a relay.
    Relay(Option<u64>, Value),
}

/// Serves `socket` until the client closes, and cleans up after it.
pub(super) async fn serve<S: Service>(service: Arc<S>, socket: UnixStream) -> anyhow::Result<()> {
    let peer_pid = facade_base::unix_process::peer_pid(socket.as_fd());
    let peer = Arc::new(Peer {
        socket: socket.as_fd().try_clone_to_owned()?,
        closed: watch::channel(false).0,
        gave_up: AtomicBool::new(false),
    });
    let (read, write) = socket.into_split();
    let (outbox, writer) = Outbox::open(write);
    let mut connection = Connection {
        service,
        peer,
        outbox,
        peer_pid,
        client: None,
        hold: None,
        lanes: Lanes::default(),
        call_slots: Arc::new(Semaphore::new(MAX_CALLS_IN_FLIGHT)),
        calls: Arc::default(),
        watches: HashMap::new(),
        last_watch: 0,
        answered: Arc::new(Notify::new()),
        teller: None,
    };
    let mut reader = BufReader::new(read);
    let served = connection.read_requests(&mut reader).await;
    connection.clean_up().await;
    let _ = writer.await;
    served
}

impl<S: Service> Connection<S> {
    async fn read_requests(&mut self, reader: &mut Reader) -> anyhow::Result<()> {
        let hello_by = tokio::time::Instant::now() + HELLO_TIMEOUT;
        let mut line = Vec::new();
        loop {
            line.clear();
            // At most one byte past the line limit, so that a longer line, ended or not, is seen.
            let mut limited = (&mut *reader).take(MAX_LINE_BYTES as u64 + 1);
            let reading = limited.read_until(b'\n', &mut line);
            let read = match self.client {
                Some(_) => reading.await?,
                None => match tokio::time::timeout_at(hello_by, reading).await {
                    Ok(read) => read?,
                    Err(_) => return Ok(()),
                },
            };
            if read == 0 {
                self.peer.closed.send_replace(true);
                return Ok(());
            }
            if self.peer.hung_up() {
                return Ok(());
            }
            if line.len() > MAX_LINE_BYTES {
                // The rest of the line is no request of its own: answer and close.
                self.outbox.fail(ErrorBody::line_too_long()).await;
                return Ok(());
            }
            match self.request(&line).await {
                Next::Read => {}
                Next::End => return Ok(()),
                Next::Relay(id, params) => {
                    return super::relay::serve(self, reader, id, params).await;
                }
            }
        }
    }

    async fn request(&mut self, line: &[u8]) -> Next {
        let request = match parse_request(line) {
            Ok(request) => request,
            Err(error) => {
                self.outbox.fail(error).await;
                return Next::Read;
            }
        };
        let (id, params) = (request.id, request.params);
        let method = request.method.as_str();
        if method == methods::HELLO {
            if let Some(refused) = self.service.draining() {
                self.outbox.answer(id, Err(refused)).await;
            } else if super::is_relay_hello(&params) {
                return Next::Relay(id, params);
            } else {
                self.hello(id, params).await;
            }
            return Next::Read;
        }
        let Some(client) = self.client.clone() else {
            let refused = ErrorBody::invalid_argument("send hello first");
            self.outbox.answer(id, Err(refused)).await;
            return Next::Read;
        };
        match method {
            methods::CALL => self.call(client, id, params, line.len()).await,
            methods::CANCEL => {
                let result = self.cancel(params);
                self.outbox.answer(id, result).await;
            }
            methods::WATCH => {
                if let Err(error) = self.watch(client, id, params).await {
                    self.outbox.answer(id, Err(error)).await;
                }
            }
            methods::UNWATCH => {
                let result = self.unwatch(&client, params).await;
                self.outbox.answer(id, result).await;
            }
            // The client's answer to `closing`: it sends nothing more.
            methods::CLOSING => {
                self.answered.notify_one();
                return Next::End;
            }
            other => {
                let message = format!(
                    "unknown method {other}; daemon protocol methods are hello, call, watch, \
                     unwatch, and cancel"
                );
                self.outbox
                    .answer(id, Err(ErrorBody::method_not_found(message)))
                    .await;
            }
        }
        Next::Read
    }

    async fn hello(&mut self, id: Option<u64>, params: Value) {
        let result = match self.client {
            Some(_) => Err(ErrorBody::invalid_argument(
                "hello was already received on this connection",
            )),
            None => self.say_hello(params).await,
        };
        let said = result.is_ok();
        self.outbox.answer(id, result).await;
        if said {
            self.teller = Some(self.tell_closing());
        }
    }

    async fn say_hello(&mut self, params: Value) -> Result<Value, ErrorBody> {
        let hello: HelloParams = decode_arguments(params)?;
        let [oldest, newest] = hello.protocol;
        if newest.min(DAEMON_PROTOCOL_VERSION) < oldest.max(MIN_DAEMON_PROTOCOL_VERSION) {
            let message = format!(
                "daemon {} supports daemon protocol versions \
                 {MIN_DAEMON_PROTOCOL_VERSION}-{DAEMON_PROTOCOL_VERSION}; client supports \
                 {oldest}-{newest}; update Facade",
                facade_base::build_id()
            );
            return Err(ErrorBody::new(Reason::ProtocolIncompatible, message));
        }
        if hello.kind == ClientKind::Unknown {
            let message = "unsupported client kind; update Facade";
            return Err(ErrorBody::new(Reason::ProtocolIncompatible, message));
        }
        let (result, client, hold) = self.service.hello(hello, self.peer_pid).await?;
        self.client = Some(Arc::new(client));
        self.hold = Some(hold);
        Ok(value_of(result))
    }

    /// Runs a call in a task of its own, or in its agent's lane for typing and resizing.
    async fn call(&mut self, client: Arc<Client>, id: Option<u64>, params: Value, size: usize) {
        let call: CallParams = match decode_arguments(params) {
            Ok(call) => call,
            Err(error) => return self.outbox.answer(id, Err(error)).await,
        };
        let typing = matches!(call.op.as_str(), AgentType::NAME | AgentResize::NAME);
        // While a newer Facade takes over, a new call does nothing. An attached terminal's keys and
        // size, sent without an ID, are no new calls: they reach the agent until `closing` is
        // answered.
        let attached = typing && id.is_none();
        if call.op != DaemonUpgrade::NAME
            && !attached
            && let Some(refused) = self.service.draining()
        {
            return self.outbox.answer(id, Err(refused)).await;
        }
        if typing {
            let context = LaneContext {
                service: self.service.clone(),
                client,
                outbox: self.outbox.clone(),
                peer: self.peer.clone(),
            };
            return self
                .lanes
                .queue(&context, id, call.op, call.args, size)
                .await;
        }
        let Ok(slot) = self.call_slots.clone().acquire_owned().await else {
            return;
        };
        let (when_full, cancel) = match id {
            Some(id) => {
                let (named, cancel) = watch::channel(false);
                self.calls.lock().unwrap().insert(id, named);
                (WhenFull::Refuse, Cancel::of(cancel))
            }
            None => (WhenFull::Wait, Cancel::default()),
        };
        let (service, outbox, calls) = (
            self.service.clone(),
            self.outbox.clone(),
            self.calls.clone(),
        );
        tokio::spawn(async move {
            let result = service
                .call(&client, &call.op, call.args, when_full, cancel)
                .await;
            if let Some(id) = id {
                calls.lock().unwrap().remove(&id);
            }
            outbox.answer(id, result).await;
            drop(slot);
        });
    }

    /// Tells the call that `cancel` names that its client cancelled it, and answers `{}`: the
    /// call's own answer says what became of it. A call that already ended stays as it ended.
    fn cancel(&self, params: Value) -> Result<Value, ErrorBody> {
        let CancelParams { id } = decode_arguments(params)?;
        if let Some(call) = self.calls.lock().unwrap().get(&id) {
            call.send_replace(true);
        }
        Ok(value_of(EmptyResult {}))
    }

    /// Starts a watch and answers request `id` with its snapshot, before any of its changes. An
    /// error is left for the caller to answer.
    async fn watch(
        &mut self,
        client: Arc<Client>,
        id: Option<u64>,
        params: Value,
    ) -> Result<(), ErrorBody> {
        let WatchParams { topic, args } = decode_arguments(params)?;
        if let Some(refused) = self.service.draining() {
            return Err(refused);
        }
        let viewer = NEXT_VIEWER.fetch_add(1, Ordering::Relaxed);
        let started = self.service.watch(&client, &topic, args, viewer).await?;
        self.last_watch += 1;
        let number = self.last_watch;
        let answer = WatchResult {
            watch: number,
            snapshot: started.snapshot,
        };
        self.outbox.answer(id, Ok(value_of(answer))).await;
        let forwarder = tokio::spawn(forward(
            self.outbox.clone(),
            self.peer.clone(),
            number,
            started.changes,
        ));
        self.watches.insert(
            number,
            Watching {
                forwarder,
                topic,
                viewer,
            },
        );
        Ok(())
    }

    async fn unwatch(&mut self, client: &Client, params: Value) -> Result<Value, ErrorBody> {
        let UnwatchParams { watch } = decode_arguments(params)?;
        let Some(watching) = self.watches.remove(&watch) else {
            let message = format!("no watch {watch} on this connection");
            return Err(ErrorBody::new(Reason::NotFound, message));
        };
        Self::end(&self.service, client, watching).await;
        Ok(value_of(EmptyResult {}))
    }

    async fn end(service: &Arc<S>, client: &Client, watching: Watching) {
        watching.forwarder.abort();
        service
            .unwatch(client, &watching.topic, watching.viewer)
            .await;
    }

    /// Once a newer Facade takes over, tells the client `closing`. What it sent before answering,
    /// or within 0.2 seconds, still runs; then its reading ends.
    pub(super) fn tell_closing(&self) -> JoinHandle<()> {
        let mut closing = self.service.closing();
        let (outbox, peer, answered) = (
            self.outbox.clone(),
            self.peer.clone(),
            self.answered.clone(),
        );
        tokio::spawn(async move {
            let Ok(build) = closing
                .wait_for(Option::is_some)
                .await
                .map(|build| build.clone().unwrap_or_default())
            else {
                return;
            };
            let told = Notification::new(methods::CLOSING, ClosingParams { build });
            outbox.send(encode_line(&told)).await;
            let _ = tokio::time::timeout(CLOSING_ANSWERED_WITHIN, answered.notified()).await;
            peer.shut(Shutdown::Read);
        })
    }

    /// Ends what the connection started: its `closing` teller and its watches. Its hold goes with
    /// it.
    async fn clean_up(mut self) {
        if let Some(teller) = self.teller.take() {
            teller.abort();
        }
        let watches: Vec<Watching> = self.watches.drain().map(|(_, watching)| watching).collect();
        if let Some(client) = self.client.clone() {
            for watching in watches {
                Self::end(&self.service, &client, watching).await;
            }
        }
    }
}

/// Sends a watch's changes until it ends or the connection closes.
async fn forward(
    outbox: Outbox,
    peer: Arc<Peer>,
    number: u64,
    mut changes: mpsc::Receiver<WatchChange>,
) {
    while let Some(change) = changes.recv().await {
        match change {
            WatchChange::Change(change) => {
                if !outbox.change(number, change).await {
                    return;
                }
            }
            WatchChange::Disconnect => {
                super::log(
                    "warn",
                    "disconnecting a client whose watch fell too far behind",
                );
                peer.shut(Shutdown::Both);
                return;
            }
        }
    }
}

pub(super) fn value_of(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol value must serialize")
}
