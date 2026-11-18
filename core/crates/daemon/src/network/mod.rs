//! Machine connections and routing. The daemon supplies trusted streams, saved connection
//! settings, and the handler for requests that reach this machine.

mod routes;
mod saved;
mod session;
mod ssh;
mod topology;
mod wire;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::daemon::{WatchParams, methods};
use facade_base::jsonrpc::{ErrorBody, Notification, Reason, decode_arguments};
use facade_base::machine::{
    AdvertiseParams, Caller, ConnectFailedParams, ConnectedParams, ConnectionKind,
    ExecutionOutcome, ForwardParams, MachineHello, MachineInfo, MachineTransport,
};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};

use self::session::{Deadline, Delivery, Output, Peer, Pending, Reply, deadline_after, remaining};
use self::topology::{Link, Origin, Topology};
use self::wire::{Forward, Reader};
use crate::SavedConnection;

pub(crate) use self::session::Subscription;

#[derive(Clone)]
pub(crate) struct Network(Arc<Inner>);

struct Inner {
    state: Mutex<Topology>,
    control_dir: Option<PathBuf>,
    events: mpsc::UnboundedSender<Event>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct SessionId(u64);

pub(crate) struct FrontConnection {
    pub(crate) transport: MachineTransport,
    pub(crate) expected_machine_id: Option<String>,
    pub(crate) kind: ConnectionKind,
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
        }))
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
        mut write: W,
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
        registered.run(read, write, output).await
    }

    /// Takes over the foreground client stream after its connect authorization response.
    pub(crate) async fn connect<R, W, F>(
        &self,
        connection: FrontConnection,
        read: R,
        mut write: W,
        on_connected: F,
    ) -> Result<(), ErrorBody>
    where
        R: AsyncBufRead + Unpin + Send,
        W: AsyncWrite + Unpin + Send,
        F: FnOnce(&MachineHello) -> Result<bool, ErrorBody> + Send,
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
            let first_connection = on_connected(&remote)?;
            registered.activate()?;
            Ok::<_, ErrorBody>((registered, output, remote, first_connection))
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
        wire::send(
            &mut write,
            &Notification::new(
                methods::CONNECTED,
                ConnectedParams {
                    machine,
                    first_connection,
                },
            ),
        )
        .await?;
        registered.run(read, write, output).await
    }

    pub(crate) async fn call(
        &self,
        target: &str,
        caller: Caller,
        method: String,
        params: Value,
        time_left: Option<Duration>,
        request_id: Option<String>,
    ) -> Result<Value, ErrorBody> {
        let deadline = deadline_after(time_left);
        let forward = ForwardParams {
            route: Vec::new(),
            caller,
            time_left_ms: None,
            request_id,
            method,
            params,
        };
        match self
            .request(target, Forward::from_origin(forward), deadline)?
            .answer(deadline)
            .await?
        {
            Reply::Call(value) => Ok(value),
            Reply::Watch { .. } => Err(ErrorBody::invalid_argument("Expected a call response.")),
        }
    }

    pub(crate) async fn watch(
        &self,
        target: &str,
        caller: Caller,
        params: WatchParams,
        time_left: Option<Duration>,
    ) -> Result<Subscription, ErrorBody> {
        let deadline = deadline_after(time_left);
        let forward = ForwardParams {
            route: Vec::new(),
            caller,
            time_left_ms: None,
            request_id: None,
            method: methods::WATCH.to_owned(),
            params: serde_json::to_value(params).expect("watch parameters serialize"),
        };
        let mut pending = self.request(target, Forward::from_origin(forward), deadline)?;
        match pending.answer(deadline).await? {
            Reply::Watch { snapshot, changes } => Ok(pending.watch(snapshot, changes)),
            Reply::Call(_) => Err(ErrorBody::invalid_argument("Expected a watch response.")),
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
        let (peer, identity) = {
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
            let identity = state.identity(target);
            let peer = match forward.route.get(1) {
                Some(next) => Some(state.direct(next).cloned().ok_or_else(|| {
                    wire::unavailable(
                        identity.clone(),
                        ExecutionOutcome::NotExecuted,
                        &format!("The next machine on the route, {next}, is unavailable."),
                    )
                })?),
                None => None,
            };
            (peer, identity)
        };

        if let Some(peer) = peer {
            forward.route.remove(0);
            let mut pending = peer.request(forward, deadline, identity)?;
            let response = pending.answer(deadline).await?;
            return Ok(Delivery::Relayed(pending, response));
        }

        forward.time_left_ms = remaining(deadline);
        if forward.time_left_ms == Some(0) {
            return Err(wire::unavailable(
                identity,
                ExecutionOutcome::NotExecuted,
                "The request timed out before reaching the machine.",
            ));
        }
        let forward = decode_arguments(forward.encode())?;
        let (reply, result) = oneshot::channel();
        self.0
            .events
            .send(Event::Target(TargetRequest {
                forward,
                cancelled,
                reply,
            }))
            .map_err(|_| {
                wire::unavailable(
                    identity.clone(),
                    ExecutionOutcome::NotExecuted,
                    "The machine is shutting down.",
                )
            })?;
        tokio::select! {
            biased;
            answer = result => {
                answer.map(Delivery::Local).map_err(|_| {
                    wire::unavailable(identity, ExecutionOutcome::OutcomeUnknown, "The machine stopped processing the request.")
                })
            },
            () = session::expires(deadline) => {
                Err(wire::unavailable(identity, ExecutionOutcome::OutcomeUnknown, "The request timed out."))
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
        wire::exchange_tables(read, write, self.machines(), |table| {
            self.reserve(remote, origin, table)
        })
        .await
    }

    fn reserve(
        &self,
        remote: MachineHello,
        origin: Origin,
        table: AdvertiseParams,
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

    fn replace_table(&self, session: SessionId, table: AdvertiseParams) -> Result<(), ErrorBody> {
        let mut state = self.0.state.lock().unwrap();
        let Some(link) = state.links.get(&session) else {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "The machine session closed.",
            ));
        };
        let table = match state.validate_table(Some(session), &link.remote, &link.origin, table) {
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

impl Registered {
    /// Turns the reserved identities into visible routes once both sides confirmed.
    fn activate(&self) -> Result<(), ErrorBody> {
        let mut state = self.network.0.state.lock().unwrap();
        let link = state.pending_links.remove(&self.id).expect("reserved link");
        if let Origin::Saved {
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
            saved.active = Some(self.id);
            saved.interaction = None;
            for waiting in saved.waiters.drain(..) {
                let _ = waiting.send(Ok(link.remote.clone()));
            }
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
        self.peer
            .run(&self.network, self.id, read, write, output)
            .await
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
