//! Machine connections and routing. The daemon supplies trusted streams, saved connection
//! settings, and the handler for requests that reach this machine.

mod activity;
mod advertise;
mod routes;
mod saved;
mod session;
mod ssh;
mod topology;
mod wake;
mod wire;

use std::collections::BTreeSet;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use facade_base::daemon::{WatchParams, methods};
use facade_base::jsonrpc::{ErrorBody, Notification, Reason, decode_arguments};
use facade_base::machine::{
    ConnectFailedParams, ConnectedParams, ConnectionKind, ConnectionOutcome, ExecutionOutcome,
    ForwardParams, MachineHello, MachineInfo, MachineResponseState, MachineTransport,
};
use facade_base::operations::EmptyResult;
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

pub(crate) use self::routes::is_uuid_v4;
pub(crate) use self::session::{Subscription, WatchRoute};
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

pub(crate) type SessionHold = Box<dyn Send>;

#[derive(Clone, Copy)]
pub(crate) enum SessionWork {
    Call,
    Viewer,
    Foreground,
}

type BeginSessionWork = dyn Fn(SessionWork) -> Option<SessionHold> + Send + Sync;
type DispatchV3Target = dyn Fn(V3TargetRequest) -> bool + Send + Sync;

struct Inner {
    state: Mutex<Topology>,
    control_dir: Option<PathBuf>,
    events: mpsc::UnboundedSender<Event>,
    session_work: OnceLock<Arc<BeginSessionWork>>,
    dispatch_v3_target: OnceLock<Box<DispatchV3Target>>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct SessionId(u64);

pub(crate) struct FrontConnection {
    pub(crate) transport: MachineTransport,
    pub(crate) expected_machine_id: Option<String>,
    pub(crate) kind: ConnectionKind,
}

pub(crate) struct MachineGreeting {
    pub(crate) machine: MachineHello,
    pub(crate) capabilities: Vec<String>,
    pub(crate) foreground: bool,
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
        attach: Option<v3::AttachBinding>,
    },
}

impl Network {
    pub(crate) fn new(
        local: MachineHello,
        capabilities: Vec<String>,
        control_dir: Option<PathBuf>,
        events: mpsc::UnboundedSender<Event>,
    ) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(Topology::new(local, capabilities)),
            control_dir,
            events,
            session_work: OnceLock::new(),
            dispatch_v3_target: OnceLock::new(),
        }))
    }

    pub(crate) fn set_session_work(
        &self,
        begin: impl Fn(SessionWork) -> Option<SessionHold> + Send + Sync + 'static,
    ) {
        assert!(self.0.session_work.set(Arc::new(begin)).is_ok());
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

    fn greeting(&self, foreground: bool) -> MachineGreeting {
        let state = self.0.state.lock().unwrap();
        MachineGreeting {
            machine: state.local.clone(),
            capabilities: state.capabilities.clone(),
            foreground,
        }
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

    pub(crate) fn rename_local(&self, name: String) {
        let mut state = self.0.state.lock().unwrap();
        state.local.name = name;
        state.publish(&self.0.events, None);
    }

    pub(crate) async fn accept_with_work<R, W>(
        &self,
        remote: MachineGreeting,
        read: R,
        mut write: W,
        initial_work: Option<SessionHold>,
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
        let result = registered.run(read, write, output).await;
        registered.finish(result.as_ref().err().cloned().map(Into::into));
        result
    }

    /// Registers the existing session after the parent commits its saved connection.
    pub(crate) async fn connect_with_saved<R, W, F, C, G>(
        &self,
        connection: FrontConnection,
        read: R,
        mut write: W,
        initial_work: Option<SessionHold>,
        on_connected: F,
    ) -> Result<(), ErrorBody>
    where
        R: AsyncBufRead + Unpin + Send,
        W: AsyncWrite + Unpin + Send,
        F: FnOnce(MachineHello) -> C + Send,
        C: Future<Output = Result<(bool, Option<SavedSsh>, G), ErrorBody>> + Send,
        G: Send,
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
            let foreground = connection.kind == ConnectionKind::Temporary
                && matches!(connection.transport, MachineTransport::Ssh { .. });
            let remote = wire::introduce(&mut read, &mut write, self.greeting(foreground)).await?;
            expected(&remote.machine, connection.expected_machine_id.as_deref())?;
            let machine = remote.machine.clone();
            let origin = Origin::Front(connection);
            let (registered, output) = self
                .handshake(&mut read, &mut write, remote, origin)
                .await?;
            let (first_connection, saved, mutation) = on_connected(machine.clone()).await?;
            registered.activate_with_saved(saved)?;
            drop(mutation);
            Ok::<_, ErrorBody>((registered, output, machine, first_connection))
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
        let result = registered.run(read, write, output).await;
        registered.finish(result.as_ref().err().cloned().map(Into::into));
        result
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
                attach,
            } => Ok(pending.watch(snapshot, changes, received_at, attach)),
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
        let (peer, identity) = {
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
            (peer.clone(), identity)
        };
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
        let route_attempt = wake::RouteAttempt::for_method(forward.method());
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
            if let Some(attempt) = route_attempt {
                self.open_saved_hop(next, attempt).await?;
            }
            let peer = {
                let state = self.0.state.lock().unwrap();
                let link = state.direct_link(next).ok_or_else(|| {
                    wire::unavailable(
                        identity.clone(),
                        ExecutionOutcome::NotExecuted,
                        &format!("The next machine on the route, {next}, is unavailable."),
                    )
                })?;
                if route_attempt == Some(wake::RouteAttempt::Passive)
                    && !link.peer.supports(v3::CAP_MACHINE_PROBE_ROUTE)
                {
                    return wake::legacy_probe(link, &forward.route[1..], identity)
                        .map(|()| Delivery::Local(TargetReply::Call(Ok(Value::Null))));
                }
                link.peer.clone()
            };
            forward.route.remove(0);
            let mut pending = peer.request(forward, deadline, identity)?;
            let response = pending.answer(deadline).await?;
            return Ok(Delivery::Relayed(pending, response));
        }

        if route_attempt.is_some() {
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
        remote: MachineGreeting,
        origin: Origin,
    ) -> Result<(Registered, mpsc::UnboundedReceiver<Output>), ErrorBody> {
        let foreground = remote.foreground
            || matches!(&origin, Origin::Front(front) if front.kind == ConnectionKind::Temporary
                && matches!(front.transport, MachineTransport::Ssh { .. }));
        let protocol = remote.machine.protocol_range[1];
        let machines = self.machines_v3();
        let (registered, output) = wire::exchange_tables(
            read,
            write,
            advertise::encode(protocol, &remote.capabilities, machines),
            |table| self.reserve(remote, origin, table),
            protocol,
        )
        .await?;
        if foreground {
            registered.peer.begin_foreground()?;
        }
        Ok((registered, output))
    }

    fn reserve(
        &self,
        remote: MachineGreeting,
        origin: Origin,
        table: v3::AdvertiseParams,
    ) -> Result<(Registered, mpsc::UnboundedReceiver<Output>), ErrorBody> {
        let mut state = self.0.state.lock().unwrap();
        let MachineGreeting {
            machine: remote,
            capabilities,
            ..
        } = remote;
        state.check_peer(&remote, &origin)?;
        let table = state.validate_table(None, &remote, &origin, &capabilities, table)?;
        let id = SessionId(state.number());
        let (peer, output) = Peer::new(capabilities, self.0.session_work.get().cloned());
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
        let table = advertise::decode(protocol, table).and_then(|table| {
            state.validate_table(
                Some(session),
                &link.remote,
                &link.origin,
                link.peer.capabilities(),
                table,
            )
        })?;
        state.links.get_mut(&session).expect("live session").table = table;
        state.publish(&self.0.events, None);
        Ok(())
    }

    fn withdraw_link(
        &self,
        state: &mut Topology,
        id: SessionId,
        failure: Option<ssh::FailedAttempt>,
    ) -> bool {
        if let Some(link) = state.links.remove(&id) {
            link.peer.stop();
            if let Some(saved) = state.saved.get_mut(&link.remote.machine_id) {
                if saved.active == Some(id) {
                    saved.active = None;
                }
                saved.last_seen = Some(SystemTime::now());
                if let Some(failure) = failure
                    && !saved
                        .failure
                        .as_ref()
                        .is_some_and(|failure| failure.sleeping)
                    && !state
                        .links
                        .values()
                        .any(|live| live.remote.machine_id == link.remote.machine_id)
                {
                    saved.failure = Some(failure);
                }
            }
            let _ = self.0.events.send(Event::SessionClosed {
                session: id,
                machine_id: link.remote.machine_id,
            });
            return true;
        }
        false
    }

    pub(crate) async fn announce_sleeping(&self) {
        let peers: Vec<_> = self
            .0
            .state
            .lock()
            .unwrap()
            .links
            .values()
            .filter(|link| link.peer.supports(v3::CAP_MACHINE_DISCONNECTED))
            .map(|link| link.peer.clone())
            .collect();
        let receipts: Vec<_> = peers
            .iter()
            .map(|peer| {
                peer.notify_drained(Notification::new(v3::MACHINE_SLEEPING, EmptyResult {}))
            })
            .collect();
        let _ = tokio::time::timeout(wire::CLOSE_GRACE, async {
            for receipt in receipts {
                let _ = receipt.await;
            }
        })
        .await;
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

    fn sleeping(&self) {
        self.network
            .0
            .state
            .lock()
            .unwrap()
            .observe_sleeping(self.source);
    }

    fn identity(&self, machine_id: &str) -> v3::MachineIdentity {
        self.network.0.state.lock().unwrap().identity(machine_id)
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
        } else if let Some(saved) = state.saved.get_mut(&link.remote.machine_id) {
            saved.seen(&link.remote);
        }
        state.clear_sleeping(&link.remote.machine_id);
        let events = &self.network.0.events;
        self.peer.start_idle();
        let _ = events.send(Event::SessionOpened {
            session: self.id,
            machine: link.remote.clone(),
        });
        state.links.insert(self.id, link);
        state.publish(events, Some(self.id));
        Ok(())
    }

    async fn run<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
        &self,
        read: Reader<R>,
        write: W,
        output: mpsc::UnboundedReceiver<Output>,
    ) -> Result<(), ErrorBody> {
        let handler = SessionHandle {
            network: self.network.clone(),
            source: self.id,
        };
        let result = self.peer.run(handler, read, write, output).await;
        self.peer.close();
        result
    }

    fn finish(&self, failure: Option<ssh::FailedAttempt>) {
        let mut state = self.network.0.state.lock().unwrap();
        state.pending_links.remove(&self.id);
        if self.network.withdraw_link(&mut state, self.id, failure) {
            state.publish(&self.network.0.events, None);
        }
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        self.finish(None);
        self.peer.close();
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
