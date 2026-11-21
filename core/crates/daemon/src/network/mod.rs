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
use std::time::SystemTime;

use facade_base::api_v1::daemon::{
    self, AdvertiseParams, AgentRef, AgentTarget, AttachBinding, Caller, ClientKind,
    ConnectFailedParams, ConnectedMachine, ConnectedParams, ConnectionKind, DaemonCall,
    DaemonWatch, ForwardParams, ForwardRequest, MachineInfo, MachineSleepingParams,
    MachineTransport, ResumeTarget, StopSelection, methods,
};
use facade_base::api_v1::{ApiVersion, EmptyResult, ErrorBody, Notification, decode_arguments};
use facade_base::model::machine::{ExecutionOutcome, MachineIdentity, MachineResponseState};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};

use self::session::{Deadline, Delivery, Output, Peer, Pending, Reply, SessionHandler, remaining};
use self::topology::{Link, Origin, Topology};
use self::wire::Reader;
use crate::{SavedConnection, SavedSsh};

pub(crate) use self::routes::is_uuid_v4;
pub(crate) use self::session::{Subscription, WatchRoute};

#[derive(Debug)]
pub(crate) enum RequestFailure {
    Unreachable(ErrorBody),
    TimedOut(ErrorBody),
    Failed(ErrorBody, Option<SystemTime>),
}

impl RequestFailure {
    fn from_reply(error: ErrorBody, received_at: SystemTime) -> Self {
        // A relay can report that its route to the target ended.
        if error.data.reason != "unavailable"
            || !error.data.details.as_ref().is_some_and(|details| {
                details.contains_key("execution") && details.contains_key("machine")
            })
        {
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
type DispatchTarget = dyn Fn(TargetRequest) -> bool + Send + Sync;

struct Inner {
    state: Mutex<Topology>,
    control_dir: Option<PathBuf>,
    events: mpsc::UnboundedSender<Event>,
    session_work: OnceLock<Arc<BeginSessionWork>>,
    dispatch_target: OnceLock<Box<DispatchTarget>>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct SessionId(u64);

pub(crate) struct FrontConnection {
    pub(crate) transport: MachineTransport,
    pub(crate) expected_machine_id: Option<String>,
    pub(crate) kind: ConnectionKind,
}

pub(crate) struct MachineGreeting {
    pub(crate) machine: ConnectedMachine,
    pub(crate) api_version: ApiVersion,
    pub(crate) foreground: bool,
}

pub(crate) enum Event {
    SessionOpened {
        session: SessionId,
        machine: ConnectedMachine,
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
}

pub(crate) struct TargetRequest {
    pub(crate) forward: ForwardParams,
    pub(crate) cancelled: watch::Receiver<bool>,
    pub(crate) reply: oneshot::Sender<TargetReply>,
}

pub(crate) enum TargetReply {
    Call(Result<Value, ErrorBody>),
    Watch {
        snapshot: Value,
        changes: mpsc::Receiver<Result<Value, ErrorBody>>,
        view: Option<AttachBinding>,
    },
}

impl Network {
    pub(crate) fn new(
        local: ConnectedMachine,
        control_dir: Option<PathBuf>,
        events: mpsc::UnboundedSender<Event>,
    ) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(Topology::new(local)),
            control_dir,
            events,
            session_work: OnceLock::new(),
            dispatch_target: OnceLock::new(),
        }))
    }

    pub(crate) fn set_session_work(
        &self,
        begin: impl Fn(SessionWork) -> Option<SessionHold> + Send + Sync + 'static,
    ) {
        assert!(self.0.session_work.set(Arc::new(begin)).is_ok());
    }

    pub(crate) fn set_target(
        &self,
        dispatch: impl Fn(TargetRequest) -> bool + Send + Sync + 'static,
    ) {
        assert!(self.0.dispatch_target.set(Box::new(dispatch)).is_ok());
    }

    pub(crate) fn local_hello(&self) -> ConnectedMachine {
        self.0.state.lock().unwrap().local.clone()
    }

    /// Checks an inbound introduction before the server sends a successful hello response.
    pub(crate) fn check_peer(&self, remote: &MachineGreeting) -> Result<(), ErrorBody> {
        self.0
            .state
            .lock()
            .unwrap()
            .check_peer(remote, &Origin::Incoming)
    }

    /// The live table with local SSH details for caller-specific filtering.
    pub(crate) fn machines(&self) -> Vec<MachineInfo> {
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
        F: FnOnce(ConnectedMachine) -> C + Send,
        C: Future<Output = Result<(bool, Option<SavedSsh>, G), ErrorBody>> + Send,
        G: Send,
    {
        let mut read = Reader::new(read);
        let prepared = async {
            if matches!(connection.transport, MachineTransport::Bridge)
                && connection.kind != ConnectionKind::Temporary
            {
                return Err(ErrorBody::invalid_argument(
                    "A bridge connection is temporary.",
                ));
            }
            let foreground = connection.kind == ConnectionKind::Temporary
                && matches!(connection.transport, MachineTransport::Ssh(_));
            let remote =
                wire::introduce(&mut read, &mut write, self.local_hello(), foreground).await?;
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
                let notification = Notification::new(
                    methods::CONNECT_FAILED,
                    ConnectFailedParams {
                        error: error.clone(),
                    },
                );
                let _ = wire::send(&mut write, &notification).await;
                return Err(error);
            }
        };
        let notification = Notification::new(
            methods::CONNECTED,
            ConnectedParams {
                machine,
                first_connection,
            },
        );
        wire::send(&mut write, &notification).await?;
        drop(initial_work);
        let result = registered.run(read, write, output).await;
        registered.finish(result.as_ref().err().cloned().map(Into::into));
        result
    }

    pub(crate) async fn call_with_receipt(
        &self,
        target: &str,
        forward: ForwardParams,
        deadline: Deadline,
    ) -> Result<(Value, SystemTime), RequestFailure> {
        if !matches!(&forward.request, ForwardRequest::Call(_)) {
            return Err(RequestFailure::Failed(
                ErrorBody::invalid_argument("Expected a forwarded call."),
                None,
            ));
        }
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

    pub(crate) async fn watch_with_receipt(
        &self,
        target: &str,
        forward: ForwardParams,
        deadline: Deadline,
    ) -> Result<Subscription, RequestFailure> {
        if !matches!(&forward.request, ForwardRequest::Watch(_)) {
            return Err(RequestFailure::Failed(
                ErrorBody::invalid_argument("Expected a forwarded watch."),
                None,
            ));
        }
        let mut pending = self
            .request(target, forward, deadline)
            .map_err(RequestFailure::Unreachable)?;
        match pending.answer(deadline).await? {
            Reply::Watch {
                snapshot,
                changes,
                received_at,
                view,
            } => Ok(pending.watch(snapshot, changes, received_at, view)),
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
        mut forward: ForwardParams,
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

    /// Checks the admitted source and remaining path before forwarding or dispatching.
    async fn receive(
        &self,
        source: SessionId,
        mut forward: ForwardParams,
        deadline: Deadline,
        cancelled: watch::Receiver<bool>,
        resize_route: Option<&WatchRoute>,
    ) -> Result<Delivery, ErrorBody> {
        let identity = {
            let state = self.0.state.lock().unwrap();
            let link = state
                .links
                .get(&source)
                .ok_or_else(|| wire::error("cancelled", "The machine session closed."))?;
            if link.api_version != ApiVersion::MIN {
                return Err(ErrorBody::invalid_argument(
                    "Unexpected machine API version.",
                ));
            }
            let origin = caller_machine(&forward.caller);
            if !is_uuid_v4(origin)
                || (origin != link.remote.machine_id
                    && !link
                        .table
                        .get(origin)
                        .is_some_and(|row| row.route.is_some()))
            {
                return Err(wire::error(
                    "refused",
                    "The forwarding caller does not match a route from the authenticated machine.",
                ));
            }
            if forward.route.first() != Some(&state.local.machine_id) {
                return Err(ErrorBody::invalid_argument(
                    "The route does not lead to this machine.",
                ));
            }
            let mut seen = BTreeSet::from([link.remote.machine_id.as_str()]);
            if forward
                .route
                .iter()
                .any(|hop| !is_uuid_v4(hop) || !seen.insert(hop.as_str()) || hop == origin)
            {
                return Err(ErrorBody::invalid_argument(
                    "Invalid or repeated machine on the route.",
                ));
            }
            state.identity(forward.route.last().expect("route starts here"))
        };
        let route_attempt = validate_request(&forward, &identity.machine_id)?;

        if forward.route.len() > 1 {
            forward.route.remove(0);
            if let Some(route) = resize_route {
                return route.relay_resize(forward, deadline).await;
            }
            let next = &forward.route[0];
            if let Some(attempt) = route_attempt {
                tokio::select! {
                    result = self.open_saved_hop(next, attempt) => result?,
                    () = session::expires(deadline) => return Err(wire::unavailable(
                        identity, ExecutionOutcome::NotExecuted, wire::TIMEOUT_BEFORE_TARGET,
                    )),
                }
            }
            let peer = {
                let state = self.0.state.lock().unwrap();
                state
                    .direct_link(next)
                    .map(|link| link.peer.clone())
                    .ok_or_else(|| {
                        wire::unavailable(
                            identity.clone(),
                            ExecutionOutcome::NotExecuted,
                            &format!("The next machine on the route, {next}, is unavailable."),
                        )
                    })?
            };
            let mut pending = peer.request(forward, deadline, identity)?;
            let response = pending.answer(deadline).await?;
            return Ok(Delivery::Relayed(pending, response));
        }

        forward.time_left_ms = remaining(deadline);
        if forward.time_left_ms == Some(0) {
            return Err(wire::unavailable(
                identity,
                ExecutionOutcome::NotExecuted,
                wire::TIMEOUT_BEFORE_TARGET,
            ));
        }
        if route_attempt.is_some() {
            return Ok(Delivery::Local(TargetReply::Call(Ok(serde_json::json!(
                EmptyResult {}
            )))));
        }
        let (reply, result) = oneshot::channel();
        let dispatched = self.0.dispatch_target.get().is_some_and(|dispatch| {
            dispatch(TargetRequest {
                forward,
                cancelled,
                reply,
            })
        });
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
                && matches!(front.transport, MachineTransport::Ssh(_)));
        let machines = {
            let state = self.0.state.lock().unwrap();
            state.check_peer(&remote, &origin)?;
            state.machines()
        };
        let (registered, output) =
            wire::exchange_tables(read, write, advertise::encode(machines), |table| {
                self.reserve(remote, origin, table)
            })
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
        table: AdvertiseParams,
    ) -> Result<(Registered, mpsc::UnboundedReceiver<Output>), ErrorBody> {
        let mut state = self.0.state.lock().unwrap();
        state.check_peer(&remote, &origin)?;
        let api_version = remote.api_version;
        let remote = remote.machine;
        let table = state.validate_table(None, &remote, &origin, table)?;
        let id = SessionId(state.number());
        let (peer, output) = Peer::new(self.0.session_work.get().cloned());
        state.pending_links.insert(
            id,
            Link {
                api_version,
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
            return Err(wire::error("cancelled", "The machine session closed."));
        };
        let table = state.validate_table(
            Some(session),
            &link.remote,
            &link.origin,
            decode_arguments(table)?,
        )?;
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
            .map(|link| link.peer.clone())
            .collect();
        let receipts: Vec<_> = peers
            .iter()
            .map(|peer| {
                peer.notify_drained(Notification::new(
                    methods::MACHINE_SLEEPING,
                    MachineSleepingParams {},
                ))
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

    fn identity(&self, machine_id: &str) -> MachineIdentity {
        self.network.0.state.lock().unwrap().identity(machine_id)
    }

    async fn receive(
        &self,
        forward: ForwardParams,
        deadline: Deadline,
        cancelled: watch::Receiver<bool>,
        resize_route: Option<&WatchRoute>,
    ) -> Result<Delivery, ErrorBody> {
        self.network
            .receive(self.source, forward, deadline, cancelled, resize_route)
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
                .ok_or_else(|| wire::error("cancelled", "The saved connection was replaced."))?;
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

fn expected(remote: &ConnectedMachine, expected: Option<&str>) -> Result<(), ErrorBody> {
    if let Some(expected) = expected
        && remote.machine_id != expected
    {
        let mut error = wire::error(
            "machine_id_mismatch",
            format!(
                "The saved connection expects machine ID {expected}, but {} reported {}.",
                remote.name, remote.machine_id
            ),
        );
        wire::detail(&mut error, "expected_machine_id", Value::from(expected));
        wire::detail(
            &mut error,
            "machine_id",
            Value::from(remote.machine_id.as_str()),
        );
        return Err(error);
    }
    Ok(())
}

fn caller_machine(caller: &Caller) -> &str {
    match caller {
        Caller::Terminal { machine_id } | Caller::Ide { machine_id } => machine_id,
        Caller::Agent { agent, .. } => &agent.machine_id,
    }
}

fn validate_request(
    forward: &ForwardParams,
    target: &str,
) -> Result<Option<wake::RouteAttempt>, ErrorBody> {
    let exact = |reference: &AgentRef| {
        if reference.machine_id == target && !reference.agent_id.is_empty() {
            Ok(())
        } else {
            Err(ErrorBody::invalid_argument(
                "A forwarded agent reference must belong to the destination machine.",
            ))
        }
    };
    let exact_target = |selector: &AgentTarget| match selector {
        AgentTarget::Reference(reference) => exact(reference),
        AgentTarget::Selector(_) => Err(ErrorBody::invalid_argument(
            "A forwarded agent target must be an exact reference.",
        )),
    };
    match &forward.request {
        ForwardRequest::Call(call) => match daemon::decode_call(call.clone(), ClientKind::Machine)?
        {
            DaemonCall::InternalEnsureRoute(args) => {
                return Ok(Some(wake::RouteAttempt::new(args.wake)));
            }
            DaemonCall::AgentInspect(args) | DaemonCall::AgentRemove(args) => {
                exact_target(&args.target)?
            }
            DaemonCall::AgentRename(args) => exact_target(&args.target)?,
            DaemonCall::AgentScreen(args) => exact_target(&args.target)?,
            DaemonCall::AgentType(args) => exact_target(&args.target)?,
            DaemonCall::AgentSend(args) => exact_target(&args.to)?,
            DaemonCall::AgentStop(args) => {
                let StopSelection::Targets { targets } = args.selection else {
                    return Err(ErrorBody::invalid_argument(
                        "A forwarded stop requires an exact list of agent references.",
                    ));
                };
                for target in &targets {
                    exact_target(target)?;
                }
            }
            DaemonCall::AgentResume(args) => match args.target {
                ResumeTarget::Agent { reference } => exact(&reference)?,
                ResumeTarget::Session { machine_id, .. } if machine_id == target => {}
                _ => {
                    return Err(ErrorBody::invalid_argument(
                        "A forwarded resume requires an exact target on the destination machine.",
                    ));
                }
            },
            DaemonCall::InternalDeliverStartResult(args) => exact(&args.recipient)?,
            DaemonCall::InternalDeliverWaitNotice(args) => exact(&args.recipient)?,
            _ => {}
        },
        ForwardRequest::Watch(watch) => {
            if let DaemonWatch::Attach(args) =
                daemon::decode_watch(watch.clone(), ClientKind::Machine)?
            {
                exact_target(&args.target)?;
            }
        }
    }
    Ok(None)
}
