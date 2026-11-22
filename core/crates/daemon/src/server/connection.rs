//! One connection, from its first line to its cleanup: it says hello, then each line it sends is
//! a request that the service answers.

use std::collections::HashMap;
use std::net::Shutdown;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::api_v1::daemon::{
    AgentRef, AgentTypeArgs, AgentsTopic, AttachResizeArgs, AttachShellTopic, AttachTopic,
    CancelParams, ClientKind, ClosingParams, DaemonCall, DaemonWatch, HelloParams, MachinesTopic,
    TerminalInput, UnwatchParams, WatchEndedParams, WatchParams, WatchResult, decode_call,
    decode_hello, decode_watch, methods, select_version,
};
use facade_base::api_v1::{
    ApiVersion, CallParams, EmptyResult, ErrorBody, MAX_LINE_BYTES, Notification, Response, Topic,
    decode_arguments, encode_line, parse_request,
};
use facade_base::sockets::{ServerPeer, ServerReader, ServerSocket};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, Semaphore, mpsc, watch};
use tokio::task::JoinHandle;

use super::lanes::{LaneContext, Lanes};
use super::outbox::Outbox;
use super::{Client, Service, WatchChange, WhenFull, operation_error};
use crate::Cancel;

/// The most calls one connection runs at once. Further calls wait for one to be answered.
const MAX_CALLS_IN_FLIGHT: usize = 16;
/// A connection that has not said hello by then is closed.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a client has to answer `closing`; one that does not, such as an older one, is cut off.
const CLOSING_ANSWERED_WITHIN: Duration = Duration::from_millis(200);

pub(super) type Reader = BufReader<ServerReader>;

/// The client end of a connection.
pub(super) struct Peer {
    /// Watched for the client closing while its reading waits, and shut down to cut the client
    /// off.
    socket: ServerPeer,
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

    /// Waits until the client closes, even with bytes still unread, and notes it. Reads no byte,
    /// so the connection's reader loses none.
    pub(super) async fn closed(&self) {
        self.socket.closed().await;
        self.closed.send_replace(true);
        self.give_up();
    }

    fn shut(&self, how: Shutdown) {
        self.socket.shutdown(how);
    }
}

/// A watch this connection started.
struct Watching {
    forwarder: JoinHandle<()>,
    /// Cleared before reporting the watch's end to the client.
    live: Arc<AtomicBool>,
    topic: &'static str,
    viewer: u64,
    /// The exact target of an Attach watch, as resolved by the service.
    reference: Option<AgentRef>,
}

impl Watching {
    fn is_live(&self) -> bool {
        self.live.load(Ordering::Relaxed)
    }
}

pub(super) struct Connection<S: Service> {
    pub(super) service: Arc<S>,
    pub(super) peer: Arc<Peer>,
    pub(super) outbox: Outbox,
    pub(super) peer_pid: Option<u32>,
    verified_actor: Option<AgentRef>,
    client: Option<Arc<Client>>,
    /// What the service gave the hello, held until the connection is cleaned up.
    hold: Option<S::Hold>,
    lanes: Lanes,
    call_slots: Arc<Semaphore>,
    /// Sends with a request ID under way, each with what tells it that `cancel` named it.
    calls: Arc<Mutex<HashMap<u64, watch::Sender<bool>>>>,
    watches: HashMap<u64, Watching>,
    last_watch: u64,
    /// Told when the client answers `closing`.
    pub(super) answered: Arc<Notify>,
    /// Tells the client `closing` once a newer Facade takes over.
    pub(super) teller: Option<JoinHandle<()>>,
}

/// What a request leaves the connection to do.
enum Next<M> {
    Read,
    End,
    /// Carry MCP from now on: the hello of a relay.
    Relay(u64, Value),
    /// Send the final ordinary RPC response and hand over the stream.
    Machine(MachineHandoff<M>),
}

struct MachineHandoff<M> {
    response: Response,
    machine: M,
}

/// Serves `socket` until the client closes, and cleans up after it.
pub(super) async fn serve<S: Service>(
    service: Arc<S>,
    socket: ServerSocket,
    verified_actor: Option<AgentRef>,
) -> anyhow::Result<()> {
    let Some(work) = service.work() else {
        return Ok(());
    };
    let peer_pid = socket.peer_pid();
    let (read, write, peer) = socket.into_split();
    let peer = Arc::new(Peer {
        socket: peer,
        closed: watch::channel(false).0,
        gave_up: AtomicBool::new(false),
    });
    let (outbox, writer) = Outbox::open(write);
    let mut connection = Connection {
        service: service.clone(),
        peer,
        outbox,
        peer_pid,
        verified_actor,
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
    let writer = writer.await;
    if let Some(MachineHandoff { response, machine }) = served? {
        let mut write = writer??;
        write.write_all(&encode_line(&response)).await?;
        write.flush().await?;
        // The handshake is finished. The machine session counts its own active work.
        drop(work);
        return service.serve_machine(machine, reader, write).await;
    }
    Ok(())
}

impl<S: Service> Connection<S> {
    async fn read_requests(
        &mut self,
        reader: &mut Reader,
    ) -> anyhow::Result<Option<MachineHandoff<S::Machine>>> {
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
                    Err(_) => return Ok(None),
                },
            };
            if read == 0 {
                self.peer.closed.send_replace(true);
                return Ok(None);
            }
            if self.peer.hung_up() {
                return Ok(None);
            }
            if line.len() > MAX_LINE_BYTES {
                // The rest of the line is no request of its own: answer and close.
                self.outbox.fail(None, ErrorBody::line_too_long()).await;
                return Ok(None);
            }
            if !line.ends_with(b"\n") {
                self.peer.closed.send_replace(true);
                return Ok(None);
            }
            match self.request(&line).await {
                Next::Read => {}
                Next::End => return Ok(None),
                Next::Machine(handoff) => return Ok(Some(handoff)),
                Next::Relay(id, params) => {
                    super::relay::serve(self, reader, id, params).await?;
                    return Ok(None);
                }
            }
        }
    }

    async fn request(&mut self, line: &[u8]) -> Next<S::Machine> {
        let request = match parse_request(line) {
            Ok(request) => request,
            Err(malformed) => {
                self.outbox.fail(malformed.id, malformed.error).await;
                return Next::Read;
            }
        };
        let (id, params) = (request.id, request.params);
        let method = request.method.as_str();
        if method == methods::HELLO {
            let Some(id) = id else { return Next::Read };
            if self.client.is_some() {
                let refused =
                    ErrorBody::invalid_argument("hello was already received on this connection");
                self.outbox.answer(Some(id), Err(refused)).await;
            } else if let Some(refused) = self.service.draining() {
                self.outbox.answer(Some(id), Err(refused)).await;
            } else if self.verified_actor.is_none() && super::is_relay_hello(&params) {
                if params["foreground"] == true {
                    self.outbox
                        .answer(Some(id), Err(foreground_requires_machine()))
                        .await;
                    return Next::End;
                }
                return Next::Relay(id, params);
            } else {
                return self.hello(id, params).await;
            }
            return Next::Read;
        }
        let Some(client) = self.client.clone() else {
            let refused = ErrorBody::invalid_argument("send hello first");
            self.outbox.answer(id, Err(refused)).await;
            return Next::Read;
        };
        match method {
            methods::CALL => return self.call(client, id, params, line.len()).await,
            methods::CANCEL => {
                let result = self.cancel(params);
                self.outbox.answer(id, result).await;
            }
            methods::WATCH => {
                let Some(id) = id else { return Next::Read };
                if let Err(error) = self.watch(client, id, params).await {
                    self.outbox.answer(Some(id), Err(error)).await;
                }
            }
            methods::UNWATCH => {
                let Some(id) = id else { return Next::Read };
                let result = self.unwatch(&client, params).await;
                self.outbox.answer(Some(id), result).await;
            }
            // The client's answer to `closing`: it sends nothing more.
            methods::CLOSING => {
                if id.is_some() {
                    let error = ErrorBody::invalid_argument("closing is a notification");
                    self.outbox.answer(id, Err(error)).await;
                    return Next::Read;
                }
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

    async fn hello(&mut self, id: u64, params: Value) -> Next<S::Machine> {
        let (hello, api_version) = match decode_hello(params).and_then(|hello| {
            let version = select_version(&hello.api_versions)?;
            Ok((hello, version))
        }) {
            Ok(hello) => hello,
            Err(error) => {
                self.outbox.answer(Some(id), Err(error)).await;
                return Next::Read;
            }
        };
        if (hello.kind == ClientKind::Mcp) != self.verified_actor.is_some() {
            let refused = operation_error(
                "refused",
                "an internal MCP connection requires a verified actor",
            );
            self.outbox.answer(Some(id), Err(refused)).await;
            return Next::End;
        }
        if hello.foreground && hello.kind != ClientKind::Machine {
            self.outbox
                .answer(Some(id), Err(foreground_requires_machine()))
                .await;
            return Next::Read;
        }
        if hello.kind == ClientKind::Machine {
            let accepted = self
                .service
                .machine_hello(hello, api_version, self.peer_pid)
                .await
                .map(|(mut result, machine)| {
                    result.api_version = api_version;
                    (result, machine)
                });
            return self.switch_to_machine(id, accepted, Next::End).await;
        }
        let result = self.say_hello(hello, api_version).await;
        let said = result.is_ok();
        self.outbox.answer(Some(id), result).await;
        if said {
            self.teller = Some(self.tell_closing());
        }
        Next::Read
    }

    async fn say_hello(
        &mut self,
        hello: HelloParams,
        api_version: ApiVersion,
    ) -> Result<Value, ErrorBody> {
        let kind = hello.kind;
        let (mut result, mut client, hold) = self
            .service
            .hello(hello, api_version, self.peer_pid)
            .await?;
        client.kind = kind;
        client.api_version = api_version;
        client.verified_actor = self.verified_actor.take();
        result.api_version = client.api_version;
        self.client = Some(Arc::new(client));
        self.hold = Some(hold);
        Ok(value_of(result))
    }

    /// Awaits Attach resize, queues input in its agent's lane, or starts an ordinary call.
    async fn call(
        &mut self,
        client: Arc<Client>,
        id: Option<u64>,
        params: Value,
        size: usize,
    ) -> Next<S::Machine> {
        let call = match decode_arguments(params)
            .and_then(|params: CallParams| decode_call(params, client.kind))
        {
            Ok(call) => call,
            Err(error) => {
                self.outbox.answer(id, Err(error)).await;
                return Next::Read;
            }
        };
        if id.is_none()
            && !matches!(
                &call,
                DaemonCall::AttachResize(_)
                    | DaemonCall::AgentType(AgentTypeArgs {
                        input: TerminalInput::Raw { .. },
                        ..
                    })
            )
        {
            return Next::Read;
        }
        // Raw input and resize notifications keep reaching the agent until `closing` is answered.
        if id.is_some()
            && !matches!(call, DaemonCall::DaemonUpgrade(_))
            && let Some(refused) = self.service.draining()
        {
            self.outbox.answer(id, Err(refused)).await;
            return Next::Read;
        }
        match call {
            DaemonCall::MachineConnect(args) => {
                let Some(id) = id else { return Next::Read };
                let accepted = self.service.machine_connect(&client, args).await;
                return self.switch_to_machine(id, accepted, Next::Read).await;
            }
            DaemonCall::AttachResize(args) => {
                // Wait for acknowledgment before reading later input or unwatch.
                let result = self.resize_viewer(&client, args).await;
                self.outbox.answer(id, result).await;
            }
            DaemonCall::AgentType(args) => {
                let context = LaneContext {
                    service: self.service.clone(),
                    client,
                    outbox: self.outbox.clone(),
                    peer: self.peer.clone(),
                };
                self.lanes.queue(&context, id, args, size).await;
            }
            call => {
                if let Some(id) = id {
                    self.start_call(client, id, call).await;
                }
            }
        }
        Next::Read
    }

    async fn start_call(&mut self, client: Arc<Client>, id: u64, call: DaemonCall) {
        let Ok(slot) = self.call_slots.clone().acquire_owned().await else {
            return;
        };
        let cancellable = matches!(call, DaemonCall::AgentSend(_));
        let cancel = if cancellable {
            let (named, cancel) = watch::channel(false);
            self.calls.lock().unwrap().insert(id, named);
            Cancel::of(cancel)
        } else {
            Cancel::default()
        };
        let (service, outbox, calls) = (
            self.service.clone(),
            self.outbox.clone(),
            self.calls.clone(),
        );
        tokio::spawn(async move {
            let result = service.call(&client, call, WhenFull::Refuse, cancel).await;
            if cancellable {
                calls.lock().unwrap().remove(&id);
            }
            outbox.answer(Some(id), result).await;
            drop(slot);
        });
    }

    async fn switch_to_machine(
        &mut self,
        id: u64,
        accepted: Result<(impl Serialize, S::Machine), ErrorBody>,
        refused: Next<S::Machine>,
    ) -> Next<S::Machine> {
        match accepted {
            Ok((response, machine)) => Next::Machine(MachineHandoff {
                response: Response::ok(id, response),
                machine,
            }),
            Err(error) => {
                self.outbox.answer(Some(id), Err(error)).await;
                refused
            }
        }
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
        id: u64,
        params: Value,
    ) -> Result<(), ErrorBody> {
        let watch = decode_watch(decode_arguments::<WatchParams>(params)?, client.kind)?;
        let topic = match &watch {
            DaemonWatch::Agents(_) => AgentsTopic::NAME,
            DaemonWatch::Machines(_) => MachinesTopic::NAME,
            DaemonWatch::Attach(_) => AttachTopic::NAME,
            DaemonWatch::AttachShell(_) => AttachShellTopic::NAME,
        };
        if let Some(refused) = self.service.draining() {
            return Err(refused);
        }
        let viewer = super::next_viewer();
        let started = self.service.watch(&client, watch, viewer).await?;
        let reference = if topic == AttachTopic::NAME {
            serde_json::from_value(started.snapshot["reference"].clone()).ok()
        } else {
            None
        };
        self.last_watch += 1;
        let number = self.last_watch;
        let answer = WatchResult {
            watch: number,
            snapshot: started.snapshot,
        };
        self.outbox.answer(Some(id), Ok(value_of(answer))).await;
        let live = Arc::new(AtomicBool::new(!started.changes.is_closed()));
        let forwarder = tokio::spawn(forward(
            self.outbox.clone(),
            self.peer.clone(),
            number,
            started.changes,
            live.clone(),
        ));
        self.watches.insert(
            number,
            Watching {
                forwarder,
                live,
                topic,
                viewer,
                reference,
            },
        );
        Ok(())
    }

    async fn resize_viewer(
        &mut self,
        client: &Client,
        AttachResizeArgs {
            watch,
            size,
            colors,
        }: AttachResizeArgs,
    ) -> Result<Value, ErrorBody> {
        let not_found = || {
            operation_error(
                "not_found",
                format!("no active attach watch {watch} on this connection"),
            )
        };
        let watching = self
            .watches
            .get(&watch)
            .filter(|watching| watching.topic == AttachTopic::NAME && watching.is_live())
            .ok_or_else(not_found)?;
        if let Some(reference) = &watching.reference {
            self.lanes.wait_for_input(reference, &self.peer).await;
        }
        if self.peer.hung_up() || !watching.is_live() {
            return Err(not_found());
        }
        self.service
            .resize_viewer(client, watching.viewer, size, colors)
            .await?;
        Ok(value_of(EmptyResult {}))
    }

    async fn unwatch(&mut self, client: &Client, params: Value) -> Result<Value, ErrorBody> {
        let UnwatchParams { watch } = decode_arguments(params)?;
        let Some(watching) = self.watches.remove(&watch) else {
            let message = format!("no watch {watch} on this connection");
            return Err(operation_error("not_found", message));
        };
        Self::end(&self.service, client, watching).await;
        Ok(value_of(EmptyResult {}))
    }

    async fn end(service: &Arc<S>, client: &Client, watching: Watching) {
        watching.forwarder.abort();
        service
            .unwatch(client, watching.topic, watching.viewer)
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
            let _ = teller.await;
        }
        let watches: Vec<Watching> = self.watches.drain().map(|(_, watching)| watching).collect();
        if let Some(client) = self.client.take() {
            for watching in watches {
                Self::end(&self.service, &client, watching).await;
            }
        }
    }
}

fn foreground_requires_machine() -> ErrorBody {
    operation_error(
        "refused",
        "only a machine hello can request foreground activity",
    )
}

/// Sends a watch's changes until it ends or the connection closes.
async fn forward(
    outbox: Outbox,
    peer: Arc<Peer>,
    number: u64,
    mut changes: mpsc::Receiver<WatchChange>,
    live: Arc<AtomicBool>,
) {
    while let Some(change) = changes.recv().await {
        match change {
            WatchChange::Change(change) => {
                if !outbox.change(number, change).await {
                    break;
                }
            }
            WatchChange::Ended(error) => {
                live.store(false, Ordering::Relaxed);
                let params = WatchEndedParams {
                    watch: number,
                    error,
                };
                outbox
                    .send(encode_line(&Notification::new(
                        methods::WATCH_ENDED,
                        params,
                    )))
                    .await;
                return;
            }
            WatchChange::Disconnect => {
                live.store(false, Ordering::Relaxed);
                super::log(
                    "warn",
                    "disconnecting a client whose watch fell too far behind",
                );
                peer.shut(Shutdown::Both);
                return;
            }
        }
    }
    live.store(false, Ordering::Relaxed);
}

pub(super) fn value_of(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol value must serialize")
}
