//! Machine connections and routing. The daemon supplies trusted streams, saved connection
//! settings, and the handler for requests that reach this machine.

mod advertise;
mod routes;
mod saved;
mod session;
mod ssh;
mod topology;
mod wake;
mod wire;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use facade_base::daemon::{WatchParams, methods};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{
    ConnectFailedParams, ConnectedParams, ConnectionKind, ConnectionOutcome, ExecutionOutcome,
    ForwardParams, MachineHello, MachineInfo, MachineResponseState, MachineTransport,
};
use facade_base::v3;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};

use self::session::{
    Deadline, Delivery, Output, Peer, Pending, Reply, SessionHandler, deadline_after, remaining,
};
use self::topology::{Link, Origin, Topology};
use self::wire::{Forward, Reader};
use crate::SavedConnection;
use crate::lifecycle::WorkGuard;

pub(crate) use self::session::Subscription;
pub(crate) use self::wire::OutboundCaller;

#[derive(Debug)]
pub(crate) enum RequestFailure {
    Unreachable(ErrorBody),
    TimedOut(ErrorBody),
    Failed(ErrorBody, Option<SystemTime>),
}

impl RequestFailure {
    fn from_reply(error: ErrorBody, received_at: SystemTime) -> Self {
        // A relay can report that its route to the target ended using the v2 transport error.
        if error.data.reason != Reason::Unavailable || error.data.unavailable.is_none() {
            return Self::Failed(error, Some(received_at));
        }
        if wire::reports_timeout(&error) {
            return Self::TimedOut(error);
        }
        Self::Unreachable(error)
    }

    pub(crate) fn observation(&self) -> (MachineResponseState, Option<SystemTime>) {
        match self {
            Self::Unreachable(_) => (MachineResponseState::Unreachable, None),
            Self::TimedOut(_) => (MachineResponseState::TimedOut, None),
            Self::Failed(_, at) => (MachineResponseState::Failed, *at),
        }
    }
}

impl From<RequestFailure> for ErrorBody {
    fn from(failure: RequestFailure) -> Self {
        match failure {
            RequestFailure::Unreachable(error)
            | RequestFailure::TimedOut(error)
            | RequestFailure::Failed(error, _) => error,
        }
    }
}

#[derive(Clone)]
pub(crate) struct Network(Arc<Inner>);

type BeginForwardWork = dyn Fn() -> Option<WorkGuard> + Send + Sync;
type DispatchV3Target = dyn Fn(V3TargetRequest) -> bool + Send + Sync;

struct Inner {
    state: Mutex<Topology>,
    control_dir: Option<PathBuf>,
    events: mpsc::UnboundedSender<Event>,
    forward_work: OnceLock<Box<BeginForwardWork>>,
    dispatch_v3_target: OnceLock<Box<DispatchV3Target>>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct SessionId(u64);

pub(crate) struct FrontConnection {
    pub(crate) transport: MachineTransport,
    pub(crate) expected_machine_id: Option<String>,
    pub(crate) kind: ConnectionKind,
}

pub(crate) struct SavedSsh {
    pub(crate) config: SavedConnection,
    pub(crate) argv: Vec<String>,
}

pub(crate) enum Event {
    SessionOpened {
        session: SessionId,
        machine: MachineHello,
    },
    SessionClosed {
        session: SessionId,
        machine_id: String,
    },
    ConnectionFailed {
        config: SavedConnection,
        error: ErrorBody,
    },
    RoutesChanged {
        machines: Vec<MachineInfo>,
    },
    Target(TargetRequest),
}

pub(crate) struct TargetRequest<P = ForwardParams> {
    pub(crate) forward: P,
    pub(crate) cancelled: watch::Receiver<bool>,
    pub(crate) reply: oneshot::Sender<TargetReply>,
}

pub(crate) type V3TargetRequest = TargetRequest<v3::ForwardParams>;

pub(crate) enum TargetReply {
    Call(Result<Value, ErrorBody>),
    Watch {
        snapshot: Value,
        changes: mpsc::Receiver<Result<Value, ErrorBody>>,
    },
}

impl Network {
    pub(crate) fn new(
        local: MachineHello,
        control_dir: Option<PathBuf>,
        events: mpsc::UnboundedSender<Event>,
    ) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(Topology::new(local)),
            control_dir,
            events,
            forward_work: OnceLock::new(),
            dispatch_v3_target: OnceLock::new(),
        }))
    }

    pub(crate) fn set_forward_work(
        &self,
        begin: impl Fn() -> Option<WorkGuard> + Send + Sync + 'static,
    ) {
        assert!(self.0.forward_work.set(Box::new(begin)).is_ok());
    }

    pub(crate) fn set_target_v3(
        &self,
        dispatch: impl Fn(V3TargetRequest) -> bool + Send + Sync + 'static,
    ) {
        assert!(self.0.dispatch_v3_target.set(Box::new(dispatch)).is_ok());
    }

    pub(crate) fn local_hello(&self) -> MachineHello {
        self.0.state.lock().unwrap().local.clone()
    }

    /// Checks an inbound introduction before the server sends a successful hello response.
    pub(crate) fn check_peer(&self, remote: &MachineHello) -> Result<(), ErrorBody> {
        self.0
            .state
            .lock()
            .unwrap()
            .check_peer(remote, &Origin::Incoming)
    }

    /// The live table, including configured connections on the local row.
    pub(crate) fn machines(&self) -> Vec<MachineInfo> {
        self.0.state.lock().unwrap().legacy_machines()
    }

    pub(crate) fn machines_v3(&self) -> Vec<v3::MachineInfo> {
        self.0.state.lock().unwrap().machines()
    }

    pub(crate) fn has_connections(&self) -> bool {
        let state = self.0.state.lock().unwrap();
        !state.saved.is_empty() || !state.links.is_empty()
    }

    pub(crate) fn rename_local(&self, name: String) {
        let mut state = self.0.state.lock().unwrap();
        state.local.name = name;
        state.publish(&self.0.events, None);
    }

    /// Takes over an authenticated stream after the server has answered its machine hello.
    pub(crate) async fn accept<R, W>(
        &self,
        remote: MachineHello,
        read: R,
        write: W,
    ) -> Result<(), ErrorBody>
    where
        R: AsyncBufRead + Unpin + Send,
        W: AsyncWrite + Unpin + Send,
    {
        self.accept_with_work(remote, read, write, None).await
    }

    pub(crate) async fn accept_with_work<R, W>(
        &self,
        remote: MachineHello,
        read: R,
        mut write: W,
        initial_work: Option<WorkGuard>,
    ) -> Result<(), ErrorBody>
    where
        R: AsyncBufRead + Unpin + Send,
        W: AsyncWrite + Unpin + Send,
    {
        let mut read = Reader::new(read);
        let (registered, output) = self
            .handshake(&mut read, &mut write, remote, Origin::Incoming)
            .await?;
        registered.activate()?;
        drop(initial_work);
        registered.run(read, write, output).await
    }

    /// Takes over the foreground client stream after its connect authorization response.
    pub(crate) async fn connect<R, W, F>(
        &self,
        connection: FrontConnection,
        read: R,
        write: W,
        on_connected: F,
    ) -> Result<(), ErrorBody>
    where
        R: AsyncBufRead + Unpin + Send,
        W: AsyncWrite + Unpin + Send,
        F: FnOnce(&MachineHello) -> Result<bool, ErrorBody> + Send,
    {
        self.connect_with_saved(connection, read, write, None, |remote| {
            on_connected(remote).map(|first| (first, None))
        })
        .await
    }

    /// Registers the existing session after the parent commits its saved connection.
    pub(crate) async fn connect_with_saved<R, W, F>(
        &self,
        connection: FrontConnection,
        read: R,
        mut write: W,
        initial_work: Option<WorkGuard>,
        on_connected: F,
    ) -> Result<(), ErrorBody>
    where
        R: AsyncBufRead + Unpin + Send,
        W: AsyncWrite + Unpin + Send,
        F: FnOnce(&MachineHello) -> Result<(bool, Option<SavedSsh>), ErrorBody> + Send,
    {
        let mut read = Reader::new(read);
        let prepared = async {
            if connection.transport == MachineTransport::Bridge
                && connection.kind != ConnectionKind::Temporary
            {
                return Err(ErrorBody::invalid_argument(
                    "A bridge connection is temporary.",
                ));
            }
            let remote = wire::introduce(&mut read, &mut write, self.local_hello()).await?;
            expected(&remote, connection.expected_machine_id.as_deref())?;
            let origin = Origin::Front(connection);
            let (registered, output) = self
                .handshake(&mut read, &mut write, remote.clone(), origin)
                .await?;
            let (first_connection, saved) = on_connected(&remote)?;
            registered.activate_with_saved(saved)?;
            Ok::<_, ErrorBody>((registered, output, remote, first_connection))
        }
        .await;
        let (registered, output, machine, first_connection) = match prepared {
            Ok(session) => session,
            Err(error) => {
                let notification = ConnectionOutcome::Failed(ConnectFailedParams {
                    error: error.clone(),
                })
                .into_notification();
                let _ = wire::send(&mut write, &notification).await;
                return Err(error);
            }
        };
        let notification = ConnectionOutcome::Connected(ConnectedParams {
            machine,
            first_connection,
        })
        .into_notification();
        wire::send(&mut write, &notification).await?;
        drop(initial_work);
        registered.run(read, write, output).await
    }

    pub(crate) async fn call(
        &self,
        target: &str,
        caller: impl Into<OutboundCaller>,
        method: String,
        params: Value,
        time_left: Option<Duration>,
        request_id: Option<String>,
    ) -> Result<Value, ErrorBody> {
        let (value, _) = self
            .call_with_receipt(
                target,
                caller,
                method,
                params,
                deadline_after(time_left),
                request_id,
            )
            .await?;
        Ok(value)
    }

    pub(crate) async fn call_with_receipt(
        &self,
        target: &str,
        caller: impl Into<OutboundCaller>,
        method: String,
        params: Value,
        deadline: Option<tokio::time::Instant>,
        request_id: Option<String>,
    ) -> Result<(Value, SystemTime), RequestFailure> {
        let forward = Forward::from_origin(caller, method, params, request_id);
        match self
            .request(target, forward, deadline)
            .map_err(RequestFailure::Unreachable)?
            .answer(deadline)
            .await?
        {
            Reply::Call {
                result,
                received_at,
            } => result
                .map(|value| (value, received_at))
                .map_err(|error| RequestFailure::from_reply(error, received_at)),
            Reply::Watch { received_at, .. } => Err(RequestFailure::Failed(
                ErrorBody::invalid_argument("Expected a call response."),
                Some(received_at),
            )),
        }
    }

    pub(crate) async fn watch(
        &self,
        target: &str,
        caller: impl Into<OutboundCaller>,
        params: WatchParams,
        time_left: Option<Duration>,
    ) -> Result<Subscription, ErrorBody> {
        Ok(self
            .watch_with_receipt(target, caller, params, time_left)
            .await?)
    }

    pub(crate) async fn watch_with_receipt(
        &self,
        target: &str,
        caller: impl Into<OutboundCaller>,
        params: WatchParams,
        time_left: Option<Duration>,
    ) -> Result<Subscription, RequestFailure> {
        let deadline = deadline_after(time_left);
        let forward = Forward::from_origin(
            caller,
            methods::WATCH.to_owned(),
            serde_json::to_value(params).expect("watch parameters serialize"),
            None,
        );
        let mut pending = self
            .request(target, forward, deadline)
            .map_err(RequestFailure::Unreachable)?;
        match pending.answer(deadline).await? {
            Reply::Watch {
                snapshot,
                changes,
                received_at,
            } => Ok(pending.watch(snapshot, changes, received_at)),
            Reply::Call {
                result: Err(error),
                received_at,
            } => Err(RequestFailure::from_reply(error, received_at)),
            Reply::Call { received_at, .. } => Err(RequestFailure::Failed(
                ErrorBody::invalid_argument("Expected a watch response."),
                Some(received_at),
            )),
        }
    }

    fn request(
        &self,
        target: &str,
        mut forward: Forward,
        deadline: Deadline,
    ) -> Result<Pending, ErrorBody> {
        let state = self.0.state.lock().unwrap();
        let identity = state.identity(target);
        let Some((peer, machine)) = state.route(target) else {
            return Err(wire::unavailable(
                identity,
                ExecutionOutcome::NotExecuted,
                "There is no route to this machine.",
            ));
        };
        forward.route = machine.route.clone().expect("selected route");
        peer.request(forward, deadline, identity)
    }

    /// Keeps the sender's route, caller, request ID and application payload together.
    async fn receive(
        &self,
        source: SessionId,
        mut forward: Forward,
        deadline: Deadline,
        cancelled: watch::Receiver<bool>,
    ) -> Result<Delivery, ErrorBody> {
        let wake = forward.method() == wake::METHOD;
        let (next, identity, protocol) = {
            let state = self.0.state.lock().unwrap();
            let Some(source) = state.links.get(&source) else {
                return Err(ErrorBody::new(
                    Reason::Cancelled,
                    "The machine session closed.",
                ));
            };
            if forward.route.first() != Some(&state.local.machine_id) {
                return Err(ErrorBody::invalid_argument(
                    "The route does not lead to this machine.",
                ));
            }
            let mut seen = BTreeSet::from([source.remote.machine_id.as_str()]);
            if forward.route.iter().any(|hop| !seen.insert(hop.as_str())) {
                return Err(ErrorBody::invalid_argument("The route repeats a machine."));
            }
            let target = forward.route.last().expect("route starts here");
            (
                forward.route.get(1),
                state.identity(target),
                source.remote.protocol_range[1],
            )
        };

        if let Some(next) = next {
            let _work = match self.0.forward_work.get() {
                Some(begin) if forward.method() != methods::WATCH => {
                    Some(begin().ok_or_else(|| {
                        wire::unavailable(
                            identity.clone(),
                            ExecutionOutcome::NotExecuted,
                            "The machine is shutting down.",
                        )
                    })?)
                }
                _ => None,
            };
            if wake {
                self.ensure_saved_hop(next).await?;
            }
            let peer = self
                .0
                .state
                .lock()
                .unwrap()
                .direct(next)
                .cloned()
                .ok_or_else(|| {
                    wire::unavailable(
                        identity.clone(),
                        ExecutionOutcome::NotExecuted,
                        &format!("The next machine on the route, {next}, is unavailable."),
                    )
                })?;
            forward.route.remove(0);
            let mut pending = peer.request(forward, deadline, identity)?;
            let response = pending.answer(deadline).await?;
            return Ok(Delivery::Relayed(pending, response));
        }

        if wake {
            return Ok(Delivery::Local(TargetReply::Call(Ok(Value::Null))));
        }

        forward.time_left_ms = remaining(deadline);
        if forward.time_left_ms == Some(0) {
            return Err(wire::unavailable(
                identity,
                ExecutionOutcome::NotExecuted,
                wire::TIMEOUT_BEFORE_TARGET,
            ));
        }
        let params = forward.encode();
        let (reply, result) = oneshot::channel();
        let dispatched = if protocol >= v3::DAEMON_PROTOCOL_RANGE[0] {
            let request = TargetRequest {
                forward: decode_arguments(params)?,
                cancelled,
                reply,
            };
            self.0
                .dispatch_v3_target
                .get()
                .is_some_and(|dispatch| dispatch(request))
        } else {
            self.0
                .events
                .send(Event::Target(TargetRequest {
                    forward: decode_arguments(params)?,
                    cancelled,
                    reply,
                }))
                .is_ok()
        };
        if !dispatched {
            return Err(wire::unavailable(
                identity.clone(),
                ExecutionOutcome::NotExecuted,
                "The machine is shutting down.",
            ));
        }
        tokio::select! {
            biased;
            answer = result => {
                answer.map(Delivery::Local).map_err(|_| {
                    wire::unavailable(identity, ExecutionOutcome::OutcomeUnknown, "The machine stopped processing the request.")
                })
            },
            () = session::expires(deadline) => {
                Err(wire::unavailable(identity, ExecutionOutcome::OutcomeUnknown, wire::REQUEST_TIMEOUT))
            },
        }
    }

    async fn handshake(
        &self,
        read: &mut Reader<impl AsyncBufRead + Unpin>,
        write: &mut (impl AsyncWrite + Unpin),
        remote: MachineHello,
        origin: Origin,
    ) -> Result<(Registered, mpsc::UnboundedReceiver<Output>), ErrorBody> {
        let protocol = remote.protocol_range[1];
        wire::exchange_tables(read, write, protocol, self.machines_v3(), |table| {
            self.reserve(remote, origin, table)
        })
        .await
    }

    fn reserve(
        &self,
        remote: MachineHello,
        origin: Origin,
        table: v3::AdvertiseParams,
    ) -> Result<(Registered, mpsc::UnboundedReceiver<Output>), ErrorBody> {
        let mut state = self.0.state.lock().unwrap();
        state.check_peer(&remote, &origin)?;
        let table = state.validate_table(None, &remote, &origin, table)?;
        let id = SessionId(state.number());
        let (peer, output) = Peer::new();
        state.pending_links.insert(
            id,
            Link {
                remote,
                origin,
                peer: peer.clone(),
                table,
            },
        );
        Ok((
            Registered {
                network: self.clone(),
                id,
                peer,
            },
            output,
        ))
    }

    fn replace_table(&self, session: SessionId, table: Value) -> Result<(), ErrorBody> {
        let mut state = self.0.state.lock().unwrap();
        let Some(link) = state.links.get(&session) else {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "The machine session closed.",
            ));
        };
        let protocol = link.remote.protocol_range[1];
        let table = match advertise::decode(protocol, table).and_then(|table| {
            state.validate_table(Some(session), &link.remote, &link.origin, table)
        }) {
            Ok(table) => table,
            Err(error) => {
                self.close_link(&mut state, session);
                return Err(error);
            }
        };
        state.links.get_mut(&session).expect("live session").table = table;
        state.publish(&self.0.events, None);
        Ok(())
    }

    fn close_link(&self, state: &mut Topology, id: SessionId) {
        if let Some(link) = state.links.remove(&id) {
            link.peer.close();
            if let Origin::Saved {
                machine_id,
                generation,
                ..
            } = link.origin
                && let Some(saved) = state.saved.get_mut(&machine_id)
                && saved.generation == generation
            {
                saved.active = None;
                saved.last_seen = Some(SystemTime::now());
                saved.changed.notify_one();
            }
            let _ = self.0.events.send(Event::SessionClosed {
                session: id,
                machine_id: link.remote.machine_id,
            });
            state.publish(&self.0.events, None);
        }
    }
}

struct Registered {
    network: Network,
    id: SessionId,
    peer: Arc<Peer>,
}

#[derive(Clone)]
struct SessionHandle {
    network: Network,
    source: SessionId,
}

impl SessionHandler for SessionHandle {
    fn replace_table(&self, table: Value) -> Result<(), ErrorBody> {
        self.network.replace_table(self.source, table)
    }

    async fn receive(
        &self,
        forward: Forward,
        deadline: Deadline,
        cancelled: watch::Receiver<bool>,
    ) -> Result<Delivery, ErrorBody> {
        self.network
            .receive(self.source, forward, deadline, cancelled)
            .await
    }
}

impl Registered {
    /// Turns the reserved identities into visible routes once both sides confirmed.
    fn activate(&self) -> Result<(), ErrorBody> {
        self.activate_with_saved(None)
    }

    fn activate_with_saved(&self, saved: Option<SavedSsh>) -> Result<(), ErrorBody> {
        let mut state = self.network.0.state.lock().unwrap();
        let mut link = state.pending_links.remove(&self.id).expect("reserved link");
        if let Some(saved) = saved {
            link.origin = self
                .network
                .adopt_saved(&mut state, saved, self.id, &link.remote);
        } else if let Origin::Saved {
            machine_id,
            generation,
            ..
        } = &link.origin
        {
            let saved = state
                .saved
                .get_mut(machine_id)
                .filter(|saved| saved.generation == *generation)
                .ok_or_else(|| {
                    ErrorBody::new(Reason::Cancelled, "The saved connection was replaced.")
                })?;
            saved.opened(self.id, &link.remote);
        }
        let events = &self.network.0.events;
        let _ = events.send(Event::SessionOpened {
            session: self.id,
            machine: link.remote.clone(),
        });
        state.links.insert(self.id, link);
        state.publish(events, Some(self.id));
        Ok(())
    }

    async fn run<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
        self,
        read: Reader<R>,
        write: W,
        output: mpsc::UnboundedReceiver<Output>,
    ) -> Result<(), ErrorBody> {
        let handler = SessionHandle {
            network: self.network.clone(),
            source: self.id,
        };
        self.peer.run(handler, read, write, output).await
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        let mut state = self.network.0.state.lock().unwrap();
        state.pending_links.remove(&self.id);
        self.network.close_link(&mut state, self.id);
    }
}

fn expected(remote: &MachineHello, expected: Option<&str>) -> Result<(), ErrorBody> {
    if let Some(expected) = expected
        && remote.machine_id != expected
    {
        return Err(ErrorBody::new(
            Reason::Refused,
            format!(
                "The saved connection expects machine ID {expected}, but {} reported {}.",
                remote.name, remote.machine_id
            ),
        ));
    }
    Ok(())
}
