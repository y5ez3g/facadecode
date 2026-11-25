//! The daemon protocol server: the socket, its connections and what travels on them. A connection
//! says `hello`, then calls operations and watches topics; a relay's connection carries MCP after
//! its hello. The server reads lines, decodes them, hands each to the [`Service`] and writes the
//! answers and watch changes back. What an operation or a topic does is the service's business.

mod connection;
mod lanes;
mod outbox;
mod relay;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use facade_base::api_v1::daemon::{
    AttachArgs, ClientKind, DaemonCall, DaemonWatch, HelloParams, HelloResult, MachineConnectArgs,
    MachineConnectResult, TerminalColors,
};
use facade_base::api_v1::{ApiVersion, ErrorBody, ErrorData, Size};
use facade_base::sockets::{DaemonListener, ServerReader, ServerSocket, ServerWriter};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::{mpsc, oneshot, watch};

use crate::Cancel;
use crate::lifecycle::RelayLink;

pub(crate) use outbox::{MAX_OUTBOX_BYTES, Outbox, OutboxRoom};

/// Who a connection is, as its hello settled it.
pub(crate) struct Client {
    pub(crate) kind: ClientKind,
    pub(crate) api_version: ApiVersion,
}

/// An ID shared by local and forwarded watches on this daemon.
pub(crate) fn next_viewer() -> u64 {
    static NEXT_VIEWER: AtomicU64 = AtomicU64::new(1);
    NEXT_VIEWER.fetch_add(1, Ordering::Relaxed)
}

/// A watch the service started: its snapshot, then its changes. The watch ends when the sender of
/// `changes` is dropped.
pub(crate) struct Watch {
    pub(crate) snapshot: Value,
    pub(crate) changes: mpsc::Receiver<WatchChange>,
}

/// A Shell Attach watch and the exit time supplied independently of its screen feed.
pub(crate) struct ShellWatch {
    pub(crate) watch: Watch,
    pub(crate) exit: oneshot::Receiver<tokio::time::Instant>,
}

/// What a watch sends after its snapshot.
pub(crate) enum WatchChange {
    /// A change, sent to the client as it is.
    Change(Value),
    /// A remote watch ended with a reported reason.
    Ended(ErrorBody),
    /// The client fell too far behind to catch up: the server disconnects it, and it can watch a
    /// fresh snapshot.
    Disconnect,
}

/// What a call's input does when its agent has no room for it.
pub(crate) enum WhenFull {
    /// It fails at once with `capacity_exceeded`: a call with a request ID.
    Refuse,
    /// It waits for room until its [`Cancel`], which the server triggers once the client closes: a
    /// call without a request ID, such as an attached terminal's keys.
    Wait,
}

/// What the server asks of the daemon. The daemon's own layer implements it.
pub(crate) trait Service: Send + Sync + 'static {
    /// Held for as long as a connection that said hello is open, such as an editor window's
    /// presence.
    type Hold: Send;
    /// Counts local client work until dropped.
    type Work: Send;
    /// An authorized machine session, held until its last RPC response is written.
    type Machine: Send;

    /// Answers an admitted hello. The server attaches any verified actor after this returns.
    fn hello(
        self: &Arc<Self>,
        hello: HelloParams,
        api_version: ApiVersion,
        peer_pid: Option<u32>,
    ) -> impl Future<Output = Result<(HelloResult, Client, Self::Hold), ErrorBody>> + Send;

    /// Authorizes a machine hello after the server has checked its protocol version.
    fn machine_hello(
        self: &Arc<Self>,
        hello: HelloParams,
        api_version: ApiVersion,
        peer_pid: Option<u32>,
    ) -> impl Future<Output = Result<(HelloResult, Self::Machine), ErrorBody>> + Send;

    /// Authorizes changing this client's RPC connection to a machine session.
    fn machine_connect(
        self: &Arc<Self>,
        client: &Client,
        args: MachineConnectArgs,
    ) -> impl Future<Output = Result<(MachineConnectResult, Self::Machine), ErrorBody>> + Send;

    /// Runs the authorized machine session over the stream after its RPC response was written.
    fn serve_machine(
        self: &Arc<Self>,
        machine: Self::Machine,
        read: BufReader<ServerReader>,
        write: ServerWriter,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;

    /// Runs a decoded call for `client`.
    fn call(
        self: &Arc<Self>,
        client: &Client,
        call: DaemonCall,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> impl Future<Output = Result<Value, ErrorBody>> + Send;

    /// Starts watching `topic` for `client`. `viewer` is unique to this watch in this daemon.
    fn watch(
        self: &Arc<Self>,
        client: &Client,
        watch: DaemonWatch,
        viewer: u64,
    ) -> impl Future<Output = Result<Watch, ErrorBody>> + Send;

    /// Starts the sole watch of a dedicated Terminal connection.
    fn watch_shell(
        self: &Arc<Self>,
        _client: &Client,
        _args: AttachArgs,
        _viewer: u64,
    ) -> impl Future<Output = Result<ShellWatch, ErrorBody>> + Send {
        async {
            Err(operation_error(
                "unsupported",
                "this daemon does not support dedicated Shell Attach",
            ))
        }
    }

    /// Applies the capacity reported by an active Attach watch on this connection.
    fn resize_viewer(
        self: &Arc<Self>,
        client: &Client,
        viewer: u64,
        size: Size,
        colors: Option<TerminalColors>,
    ) -> impl Future<Output = Result<(), ErrorBody>> + Send;

    /// Ends a watch when its client unwatches it or closes.
    fn unwatch(
        self: &Arc<Self>,
        client: &Client,
        topic: &str,
        viewer: u64,
    ) -> impl Future<Output = ()> + Send;

    /// Accepts a relay whose hello `params` came from process `peer_pid`: the answer to its hello,
    /// and what answers its MCP lines.
    fn relay(
        self: &Arc<Self>,
        params: Value,
        peer_pid: Option<u32>,
    ) -> impl Future<Output = Result<RelayHandshake, ErrorBody>> + Send;

    /// The build of the newer Facade taking over, once there is one: every connection is told
    /// `closing`.
    fn closing(&self) -> watch::Receiver<Option<String>>;

    /// While a newer Facade takes over: the error that a new hello, call or watch gets.
    fn draining(&self) -> Option<ErrorBody>;

    /// Counts a new connection, or None while the daemon decides to exit.
    fn work(&self) -> Option<Self::Work>;
}

pub(crate) type RelayResponse = Pin<Box<dyn Future<Output = Option<Vec<u8>>> + Send>>;

pub(crate) struct RelayHandshake {
    pub(crate) answer: Value,
    pub(crate) lines: Arc<dyn RelayLines>,
    pub(crate) link: Arc<RelayLink>,
}

/// What answers one relay's MCP lines.
pub(crate) trait RelayLines: Send + Sync {
    /// Reads a line, applying a cancellation immediately or giving work for its response.
    fn take(&self, line: &[u8], arrived: Instant, outbox: &Outbox) -> Option<RelayResponse>;
    /// Waits for the cancellation effects of all requests read before closing was confirmed.
    fn settle_cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// The relay's connection ended. `closing_answered`: it answered `closing`, so it carries on
    /// with the newer daemon.
    fn ended(&self, closing_answered: bool);
}

/// Whether hello `params` are a relay's: they carry its relay contract.
pub(crate) fn is_relay_hello(params: &Value) -> bool {
    params.get("relay").is_some()
}

fn operation_error(reason: &str, message: impl Into<String>) -> ErrorBody {
    ErrorBody {
        code: -32000,
        message: message.into(),
        data: ErrorData {
            reason: reason.into(),
            details: None,
        },
    }
}

/// Binds the client socket. This daemon holds the daemon lock, so a socket already there belongs
/// to a daemon that ended.
pub(crate) fn bind() -> anyhow::Result<DaemonListener> {
    let path = facade_base::paths::daemon_socket()?;
    let listener = DaemonListener::bind(&path)?;
    let build = facade_base::build_id();
    log(
        "info",
        &format!("daemon {build} listening on {}", path.display()),
    );
    Ok(listener)
}

/// Accepts clients, one task each. While `closing` is true the daemon decides to exit: arriving
/// connections are closed before their hello, and `paused` says so. Once `closing` turns false
/// again, accepting goes on with the same listener.
pub(crate) async fn serve<S: Service>(
    mut listener: DaemonListener,
    service: Arc<S>,
    mut closing: watch::Receiver<bool>,
    paused: watch::Sender<bool>,
) -> anyhow::Result<()> {
    tokio::spawn(exit_on_signal());
    crate::gate_for_test("before-accept-loop");
    let mut was_paused = false;
    loop {
        let pause = *closing.borrow_and_update();
        if was_paused && !pause {
            crate::gate_for_test("before-resume-accepting");
        }
        was_paused = pause;
        paused.send_replace(pause);
        let socket = tokio::select! {
            accepted = listener.accept() => accepted?,
            _ = closing.changed() => continue,
        };
        if *closing.borrow() {
            continue;
        }
        tokio::spawn(serve_connection(service.clone(), socket));
    }
}

/// Serves one connected socket until it closes.
pub(crate) async fn serve_connection<S: Service>(service: Arc<S>, socket: ServerSocket) {
    if let Err(err) = connection::serve(service, socket).await {
        log("warn", &format!("a connection ended: {err}"));
    }
}

/// Once the daemon is asked to end, removes the daemon socket and exits.
async fn exit_on_signal() {
    facade_base::service::termination_requested().await;
    log("info", "shutdown requested; removing the daemon socket");
    if let Ok(path) = facade_base::paths::daemon_socket() {
        let _ = std::fs::remove_file(path);
    }
    std::process::exit(0)
}

fn log(level: &str, message: &str) {
    facade_base::log::write("daemon", level, message);
}

#[cfg(test)]
mod tests;
