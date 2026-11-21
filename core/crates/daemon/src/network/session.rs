//! Requests, responses and watches multiplexed over one machine link.

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Poll, ready};
use std::time::{Duration, SystemTime};

use facade_base::daemon::{CancelParams, ChangedParams, UnwatchParams, WatchEndedParams, methods};
use facade_base::jsonrpc::{
    ErrorBody, MAX_LINE_BYTES, Notification, Reason, Response, decode_arguments,
};
use facade_base::machine::{ExecutionOutcome, MachineIdentity};
use facade_base::v3::{self, AttachBinding, ForwardWatchResult, MachineState};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use super::activity::{Activity, SessionActivity};
use super::wire::{self, Forward, Frame, Reader};
use super::{BeginSessionWork, RequestFailure, SessionWork, TargetReply};

type Change = Result<Value, ErrorBody>;
type Answer = Result<Reply, RequestFailure>;
pub(super) type Deadline = Option<Instant>;

pub(crate) struct ReceivedChange {
    pub(crate) value: Value,
    pub(crate) received_at: SystemTime,
}

type WatchUpdate = Result<ReceivedChange, RequestFailure>;

fn change_result(update: WatchUpdate) -> Change {
    update.map(|change| change.value).map_err(Into::into)
}

/// Applies machine frames to the routes of this connection.
pub(super) trait SessionHandler: Clone + Send + Sync + 'static {
    fn replace_table(&self, table: Value) -> Result<(), ErrorBody>;
    fn sleeping(&self);
    fn identity(&self, machine_id: &str) -> MachineIdentity;

    fn receive(
        &self,
        forward: Forward,
        deadline: Deadline,
        cancelled: watch::Receiver<bool>,
    ) -> impl Future<Output = Result<Delivery, ErrorBody>> + Send;
}

pub(crate) struct Subscription {
    pub(crate) snapshot: Value,
    pub(crate) received_at: SystemTime,
    pub(crate) attach: Option<AttachBinding>,
    changes: mpsc::UnboundedReceiver<WatchUpdate>,
    _request: Pending,
}

impl Subscription {
    /// The final item is an error if the remote watch or its link ended.
    pub(crate) async fn next(&mut self) -> Option<Result<Value, ErrorBody>> {
        self.next_with_receipt().await.map(change_result)
    }

    pub(crate) async fn next_with_receipt(&mut self) -> Option<WatchUpdate> {
        self.changes.recv().await
    }

    pub(crate) fn route(&self) -> WatchRoute {
        WatchRoute {
            peer: self._request.peer.clone(),
            request: self._request.id,
            machine: self._request.machine.clone(),
            route: self._request.route.clone(),
        }
    }
}

/// A request sent along the route already used by a live watch.
#[derive(Clone)]
pub(crate) struct WatchRoute {
    peer: Arc<Peer>,
    request: u64,
    machine: MachineIdentity,
    route: Vec<String>,
}

impl WatchRoute {
    pub(crate) async fn call(
        &self,
        caller: facade_base::v3::Caller,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ErrorBody> {
        if !matches!(
            self.peer.state.lock().unwrap().outgoing.get(&self.request),
            Some(Outgoing::Watching {
                activity: Some(_),
                ..
            })
        ) {
            return Err(ErrorBody::new(
                Reason::NotFound,
                "the remote terminal watch ended",
            ));
        }
        let mut forward = Forward::from_origin(caller, method.to_owned(), params, None);
        forward.route = self.route.clone();
        let deadline = deadline_after(Some(timeout));
        match self
            .peer
            .request(forward, deadline, self.machine.clone())?
            .answer(deadline)
            .await?
        {
            Reply::Call { result, .. } => result,
            Reply::Watch { .. } => Err(ErrorBody::invalid_argument("Expected a resize response.")),
        }
    }
}

pub(super) enum Reply {
    Call {
        result: Result<Value, ErrorBody>,
        received_at: SystemTime,
    },
    Watch {
        snapshot: Value,
        changes: mpsc::UnboundedReceiver<WatchUpdate>,
        received_at: SystemTime,
        attach: Option<AttachBinding>,
    },
}

pub(super) enum Delivery {
    Local(TargetReply),
    Relayed(Pending, Reply),
}

enum Changes {
    Local(mpsc::Receiver<Change>),
    Relayed {
        changes: mpsc::UnboundedReceiver<WatchUpdate>,
        _pending: Pending,
    },
}

impl Changes {
    async fn next(&mut self) -> Option<Change> {
        match self {
            Self::Local(changes) => changes.recv().await,
            Self::Relayed { changes, .. } => changes.recv().await.map(change_result),
        }
    }
}

pub(super) struct Pending {
    peer: Arc<Peer>,
    id: u64,
    machine: MachineIdentity,
    route: Vec<String>,
    reply: oneshot::Receiver<Answer>,
}

impl Pending {
    pub(super) async fn answer(&mut self, deadline: Deadline) -> Answer {
        tokio::select! {
            biased;
            answer = &mut self.reply => answer.unwrap_or_else(|_| {
                Err(RequestFailure::Unreachable(wire::unavailable(
                    self.machine.clone(),
                    ExecutionOutcome::OutcomeUnknown,
                    "The machine session closed.",
                )))
            }),
            () = expires(deadline) => {
                let sent = self.peer.release(self.id);
                // The writer or disconnect can finish this waiter as its deadline fires.
                if sent.is_none() && let Ok(answer) = self.reply.try_recv() {
                    return answer;
                }
                Err(RequestFailure::TimedOut(wire::unavailable(
                    self.machine.clone(),
                    execution(sent.unwrap_or(true)),
                    wire::REQUEST_TIMEOUT,
                )))
            },
        }
    }

    pub(super) fn watch(
        self,
        snapshot: Value,
        changes: mpsc::UnboundedReceiver<WatchUpdate>,
        received_at: SystemTime,
        attach: Option<AttachBinding>,
    ) -> Subscription {
        Subscription {
            snapshot,
            received_at,
            attach,
            changes,
            _request: self,
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        let _ = self.peer.release(self.id);
    }
}

fn execution(sent: bool) -> ExecutionOutcome {
    if sent {
        ExecutionOutcome::OutcomeUnknown
    } else {
        ExecutionOutcome::NotExecuted
    }
}

pub(super) fn deadline_after(left: Option<Duration>) -> Deadline {
    left.and_then(|left| Instant::now().checked_add(left))
}

pub(super) fn remaining(deadline: Deadline) -> Option<u64> {
    deadline.map(|until| {
        u64::try_from(until.saturating_duration_since(Instant::now()).as_millis())
            .unwrap_or(u64::MAX)
    })
}

pub(super) async fn expires(deadline: Deadline) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

pub(super) struct Peer {
    state: Mutex<State>,
    outbox: mpsc::UnboundedSender<Output>,
    stopped: watch::Sender<bool>,
    capabilities: Vec<String>,
    activity: Arc<Activity>,
    begin_work: Option<Arc<BeginSessionWork>>,
}

struct State {
    open: bool,
    next: u64,
    outgoing: HashMap<u64, Outgoing>,
    watches: HashMap<u64, u64>,
    incoming: HashMap<u64, watch::Sender<bool>>,
    foreground: Option<SessionActivity>,
}

enum Outgoing {
    Waiting {
        machine: MachineIdentity,
        sent: bool,
        reply: oneshot::Sender<Answer>,
        activity: Option<SessionActivity>,
    },
    Watching {
        machine: MachineIdentity,
        watch: u64,
        changes: mpsc::UnboundedSender<WatchUpdate>,
        activity: Option<SessionActivity>,
    },
}

pub(super) enum Output {
    Forward {
        id: u64,
        forward: Forward,
        deadline: Deadline,
    },
    Response(Response),
    Notification(Notification, Option<oneshot::Sender<()>>),
}

enum ReadEnd {
    Closed,
    Rejected(ErrorBody),
}

impl Peer {
    pub(super) fn new(
        capabilities: Vec<String>,
        begin_work: Option<Arc<BeginSessionWork>>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Output>) {
        let (outbox, output) = mpsc::unbounded_channel();
        let peer = Arc::new(Self {
            state: Mutex::new(State {
                open: true,
                next: wire::FIRST_REQUEST_ID,
                outgoing: HashMap::new(),
                watches: HashMap::new(),
                incoming: HashMap::new(),
                foreground: None,
            }),
            outbox,
            stopped: watch::channel(false).0,
            capabilities,
            activity: Arc::default(),
            begin_work,
        });
        (peer, output)
    }

    pub(super) fn notify(&self, notification: Notification) {
        let _ = self.outbox.send(Output::Notification(notification, None));
    }

    pub(super) fn notify_drained(&self, notification: Notification) -> oneshot::Receiver<()> {
        let (flushed, receipt) = oneshot::channel();
        let _ = self
            .outbox
            .send(Output::Notification(notification, Some(flushed)));
        receipt
    }

    pub(super) fn capabilities(&self) -> &[String] {
        &self.capabilities
    }

    pub(super) fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|cap| cap == capability)
    }

    pub(super) fn start_idle(&self) {
        self.activity.start();
    }

    fn hold(&self, kind: SessionWork) -> Result<SessionActivity, &'static str> {
        let work = match &self.begin_work {
            Some(begin) => Some(begin(kind).ok_or("The machine is shutting down.")?),
            None => None,
        };
        self.activity
            .hold(work)
            .ok_or("The machine session closed.")
    }

    pub(super) fn begin_foreground(&self) -> Result<(), ErrorBody> {
        let activity = self
            .hold(SessionWork::Foreground)
            .map_err(|detail| ErrorBody::new(Reason::Unavailable, detail))?;
        self.state.lock().unwrap().foreground = Some(activity);
        Ok(())
    }

    fn project_error(&self, mut error: ErrorBody) -> ErrorBody {
        if !self.supports(v3::CAP_MACHINE_DISCONNECTED) {
            for row in &mut error.data.machines {
                if row.state == MachineState::Disconnected {
                    row.state = MachineState::Unreachable;
                }
            }
        }
        error
    }

    fn reply(&self, response: Response) {
        let _ = self.outbox.send(Output::Response(response));
    }

    pub(super) fn request(
        self: &Arc<Self>,
        forward: Forward,
        deadline: Deadline,
        machine: MachineIdentity,
    ) -> Result<Pending, ErrorBody> {
        let unavailable = || {
            wire::unavailable(
                machine.clone(),
                ExecutionOutcome::NotExecuted,
                "The machine session closed.",
            )
        };
        let activity = forward
            .work()
            .map(|kind| {
                self.hold(kind).map_err(|detail| {
                    wire::unavailable(machine.clone(), ExecutionOutcome::NotExecuted, detail)
                })
            })
            .transpose()?;
        let mut state = self.state.lock().unwrap();
        if !state.open || *self.stopped.borrow() {
            return Err(unavailable());
        }
        let id = state.next;
        state.next += 1;
        let (reply, receiver) = oneshot::channel();
        let route = if forward.method() == methods::WATCH {
            forward.route.clone()
        } else {
            Vec::new()
        };
        self.outbox
            .send(Output::Forward {
                id,
                forward,
                deadline,
            })
            .map_err(|_| unavailable())?;
        state.outgoing.insert(
            id,
            Outgoing::Waiting {
                machine: machine.clone(),
                sent: false,
                reply,
                activity,
            },
        );
        Ok(Pending {
            peer: self.clone(),
            id,
            machine,
            route,
            reply: receiver,
        })
    }

    fn release(&self, id: u64) -> Option<bool> {
        let mut state = self.state.lock().unwrap();
        match state.outgoing.remove(&id) {
            Some(Outgoing::Waiting { sent, .. }) => {
                if sent {
                    self.notify(Notification::new(methods::CANCEL, CancelParams { id }));
                }
                Some(sent)
            }
            Some(Outgoing::Watching { watch, .. }) => {
                state.watches.remove(&watch);
                self.notify(Notification::new(methods::UNWATCH, UnwatchParams { watch }));
                Some(true)
            }
            None => None,
        }
    }

    /// Completes every waiter and releases inbound work even when callers still hold this peer.
    pub(super) fn stop(&self) {
        self.stopped.send_replace(true);
    }

    pub(super) fn close(&self) {
        let (incoming, outgoing, foreground) = {
            let mut state = self.state.lock().unwrap();
            if !state.open {
                return;
            }
            state.open = false;
            self.stop();
            state.watches.clear();
            (
                std::mem::take(&mut state.incoming),
                std::mem::take(&mut state.outgoing),
                state.foreground.take(),
            )
        };
        drop(foreground);
        for (_, cancellation) in incoming {
            cancellation.send_replace(true);
        }
        for (_, outgoing) in outgoing {
            match outgoing {
                Outgoing::Waiting {
                    machine,
                    sent,
                    reply,
                    ..
                } => {
                    let _ = reply.send(Err(RequestFailure::Unreachable(wire::unavailable(
                        machine,
                        execution(sent),
                        "The machine session closed.",
                    ))));
                }
                Outgoing::Watching {
                    machine, changes, ..
                } => {
                    let _ = changes.send(Err(RequestFailure::Unreachable(wire::unavailable(
                        machine,
                        ExecutionOutcome::OutcomeUnknown,
                        "The subscription ended when the machine session closed.",
                    ))));
                }
            }
        }
    }

    fn response(&self, response: Response) -> Result<(), ErrorBody> {
        let received_at = SystemTime::now();
        let result = match (response.error, response.result) {
            (Some(error), None) => Err(error),
            (None, Some(value)) => Ok(value),
            _ => return Err(ErrorBody::invalid_argument("Invalid machine response.")),
        };
        let Some(id) = response.id else {
            return Err(result.err().unwrap_or_else(|| {
                ErrorBody::invalid_argument("A machine response is missing its ID.")
            }));
        };
        let mut state = self.state.lock().unwrap();
        let Some(Outgoing::Waiting { .. }) = state.outgoing.get(&id) else {
            // A dropped waiter may race with a successful watch response already on the wire.
            if !state.outgoing.contains_key(&id)
                && let Ok(value) = result
                && let Some(watch) = watch_number(&value)
            {
                self.notify(Notification::new(methods::UNWATCH, UnwatchParams { watch }));
            }
            return Ok(());
        };
        // Validate the watch metadata before removing the waiter, so a protocol error on this
        // connection still wakes it through the normal close path.
        let watch = result.as_ref().ok().and_then(watch_number);
        if watch.is_some_and(|watch| state.watches.contains_key(&watch)) {
            return Err(ErrorBody::invalid_argument(
                "The peer reused an active watch number.",
            ));
        }
        let watch = watch
            .map(|_| {
                decode_arguments::<ForwardWatchResult>(
                    result.as_ref().expect("watch result").clone(),
                )
            })
            .transpose()?;
        let Some(Outgoing::Waiting {
            machine,
            reply,
            mut activity,
            ..
        }) = state.outgoing.remove(&id)
        else {
            unreachable!();
        };
        if let Some(ForwardWatchResult {
            watch,
            snapshot,
            attach,
        }) = watch
        {
            if ended_snapshot(&snapshot) {
                let _ = activity.take();
            }
            let (changes, receiver) = mpsc::unbounded_channel();
            state.watches.insert(watch, id);
            state.outgoing.insert(
                id,
                Outgoing::Watching {
                    machine,
                    watch,
                    changes,
                    activity,
                },
            );
            let _ = reply.send(Ok(Reply::Watch {
                snapshot,
                changes: receiver,
                received_at,
                attach: attach.filter(|_| self.supports(v3::CAP_ATTACH)),
            }));
        } else {
            let _ = reply.send(Ok(Reply::Call {
                result,
                received_at,
            }));
        }
        Ok(())
    }

    fn changed(&self, ChangedParams { watch, change }: ChangedParams) {
        let received_at = SystemTime::now();
        let mut state = self.state.lock().unwrap();
        let mut ended = None;
        if let Some(id) = state.watches.get(&watch).copied()
            && let Some(Outgoing::Watching {
                changes, activity, ..
            }) = state.outgoing.get_mut(&id)
        {
            if activity.is_some() && ended_change(&change) {
                ended = activity.take();
            }
            let _ = changes.send(Ok(ReceivedChange {
                value: change,
                received_at,
            }));
        }
        drop(state);
        drop(ended);
    }

    fn watch_ended(&self, WatchEndedParams { watch, error }: WatchEndedParams) {
        let received_at = SystemTime::now();
        let mut state = self.state.lock().unwrap();
        if let Some(id) = state.watches.remove(&watch)
            && let Some(Outgoing::Watching { changes, .. }) = state.outgoing.remove(&id)
        {
            let _ = changes.send(Err(RequestFailure::from_reply(error, received_at)));
        }
    }

    fn cancel_incoming(&self, id: u64) {
        if let Some(cancellation) = self.state.lock().unwrap().incoming.get(&id) {
            cancellation.send_replace(true);
        }
    }

    fn begin(self: &Arc<Self>, id: u64) -> Result<Incoming, ErrorBody> {
        use std::collections::hash_map::Entry;

        let mut state = self.state.lock().unwrap();
        if !state.open {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                "The machine session closed.",
            ));
        }
        let Entry::Vacant(entry) = state.incoming.entry(id) else {
            return Err(ErrorBody::invalid_argument(
                "The peer reused an active request ID.",
            ));
        };
        let (cancel, cancelled) = watch::channel(false);
        entry.insert(cancel);
        Ok(Incoming {
            id,
            peer: self.clone(),
            cancelled,
        })
    }

    pub(super) async fn run<R, W, H>(
        self: &Arc<Self>,
        handler: H,
        mut read: Reader<R>,
        mut write: W,
        mut output: mpsc::UnboundedReceiver<Output>,
    ) -> Result<(), ErrorBody>
    where
        R: AsyncBufRead + Unpin,
        W: AsyncWrite + Unpin,
        H: SessionHandler,
    {
        let mut stopped = self.stopped.subscribe();
        let mut writing_frame = false;
        let ended = tokio::select! {
            result = self.read(&handler, &mut read) => result?,
            result = self.write(&mut write, &mut output, &mut writing_frame) => {
                result?;
                ReadEnd::Closed
            }
            _ = stopped.wait_for(|stopped| *stopped) => ReadEnd::Closed,
            () = self.activity.reap() => ReadEnd::Closed,
        };
        if let ReadEnd::Rejected(error) = ended {
            self.close();
            // If dropping the write left a partial line, another line would corrupt the diagnostic.
            if !writing_frame {
                wire::reject(&mut write, None, &error).await;
            }
            return Err(error);
        }
        Ok(())
    }

    async fn read(
        self: &Arc<Self>,
        handler: &impl SessionHandler,
        read: &mut Reader<impl AsyncBufRead + Unpin>,
    ) -> Result<ReadEnd, ErrorBody> {
        while let Some(frame) = read.next().await? {
            match frame {
                Frame::Response(response) if response.jsonrpc == "2.0" => {
                    self.response(response)?;
                }
                Frame::Request(request) if request.jsonrpc == "2.0" => {
                    match (request.method.as_str(), request.id) {
                        (methods::FORWARD, Some(id)) => {
                            let forward = Forward::decode(request.params)?;
                            let deadline =
                                deadline_after(forward.time_left_ms.map(Duration::from_millis));
                            let incoming = self.begin(id)?;
                            tokio::spawn(incoming.serve(handler.clone(), forward, deadline));
                        }
                        (methods::ADVERTISE, None) => {
                            if let Err(error) = handler.replace_table(request.params) {
                                return Ok(ReadEnd::Rejected(error));
                            }
                        }
                        (v3::MACHINE_SLEEPING, None)
                            if self.supports(v3::CAP_MACHINE_DISCONNECTED) =>
                        {
                            if !request
                                .params
                                .as_object()
                                .is_some_and(|args| args.is_empty())
                            {
                                return Err(ErrorBody::invalid_argument(
                                    "Expected an empty sleep notice.",
                                ));
                            }
                            handler.sleeping();
                            return Ok(ReadEnd::Closed);
                        }
                        (methods::CANCEL, None) => {
                            let CancelParams { id } = decode_arguments(request.params)?;
                            self.cancel_incoming(id);
                        }
                        (methods::UNWATCH, None) => {
                            let UnwatchParams { watch } = decode_arguments(request.params)?;
                            self.cancel_incoming(watch);
                        }
                        (methods::CHANGED, None) => self.changed(decode_arguments(request.params)?),
                        (methods::WATCH_ENDED, None) => {
                            self.watch_ended(decode_arguments(request.params)?);
                        }
                        _ => {
                            return Err(ErrorBody::invalid_argument("Unexpected machine request."));
                        }
                    }
                }
                _ => return Err(ErrorBody::invalid_argument("Expected JSON-RPC 2.0.")),
            }
        }
        Ok(ReadEnd::Closed)
    }

    async fn write(
        &self,
        writer: &mut (impl AsyncWrite + Unpin),
        output: &mut mpsc::UnboundedReceiver<Output>,
        writing_frame: &mut bool,
    ) -> Result<(), ErrorBody> {
        while let Some(output) = output.recv().await {
            *writing_frame = true;
            match output {
                Output::Forward {
                    id,
                    forward,
                    deadline,
                } => {
                    self.write_forward(writer, id, forward, deadline).await?;
                }
                Output::Response(response) => wire::send(writer, &response).await?,
                Output::Notification(notification, flushed) => {
                    wire::send(writer, &notification).await?;
                    if let Some(flushed) = flushed {
                        let _ = flushed.send(());
                    }
                }
            }
            *writing_frame = false;
        }
        Ok(())
    }

    async fn write_forward(
        &self,
        writer: &mut (impl AsyncWrite + Unpin),
        id: u64,
        forward: Forward,
        deadline: Deadline,
    ) -> Result<(), ErrorBody> {
        let left = remaining(deadline);
        if left == Some(0) {
            self.fail_unwritten(id, write_timeout);
            return Ok(());
        }
        let line = wire::forward_line(id, forward, deadline.is_some());
        let end_bytes = left.map_or(0, |left| wire::forward_end(left).len());
        if line.len() + end_bytes > MAX_LINE_BYTES {
            self.fail_unwritten(id, |_| {
                RequestFailure::Failed(ErrorBody::line_too_long(), None)
            });
            return Ok(());
        }

        let mut started = false;
        let writing = async {
            let Some(first) = self.write_first(writer, id, &line).await? else {
                return Ok(());
            };
            started = true;
            writer.write_all(&line[first..]).await?;
            if let Some(deadline) = deadline {
                writer.flush().await?;
                write_forward_end(writer, deadline).await?;
            }
            writer.flush().await
        };
        let written = tokio::select! {
            biased;
            () = expires(deadline) => None,
            result = writing => Some(result),
        };
        match written {
            Some(result) => result.map_err(wire::io_error),
            None if !started => {
                self.fail_unwritten(id, write_timeout);
                Ok(())
            }
            None => Err(wire::io_error(io::Error::new(
                io::ErrorKind::TimedOut,
                "the request timed out while writing its machine frame",
            ))),
        }
    }

    /// Coordinates the first successful write with cancellation so a wholly unsent request
    /// can still be reported as not executed.
    async fn write_first(
        &self,
        writer: &mut (impl AsyncWrite + Unpin),
        id: u64,
        line: &[u8],
    ) -> io::Result<Option<usize>> {
        poll_fn(|cx| {
            let mut state = self.state.lock().unwrap();
            let Some(Outgoing::Waiting { sent, .. }) = state.outgoing.get_mut(&id) else {
                return Poll::Ready(Ok(None));
            };
            let count = ready!(Pin::new(&mut *writer).poll_write(cx, line))?;
            if count == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
            *sent = true;
            Poll::Ready(Ok(Some(count)))
        })
        .await
    }

    fn fail_unwritten(&self, id: u64, error: impl FnOnce(MachineIdentity) -> RequestFailure) {
        let mut state = self.state.lock().unwrap();
        if let Some(Outgoing::Waiting { machine, reply, .. }) = state.outgoing.remove(&id) {
            let _ = reply.send(Err(error(machine)));
        }
    }
}

async fn write_forward_end(
    writer: &mut (impl AsyncWrite + Unpin),
    deadline: Instant,
) -> io::Result<()> {
    // Use fresh time when the writer first takes the suffix, including a wait for write readiness.
    let (end, count) = poll_fn(|cx| -> Poll<io::Result<(String, usize)>> {
        let left = remaining(Some(deadline)).expect("timed write");
        if left == 0 {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let end = wire::forward_end(left);
        let count = ready!(Pin::new(&mut *writer).poll_write(cx, end.as_bytes()))?;
        if count == 0 {
            return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
        }
        Poll::Ready(Ok((end, count)))
    })
    .await?;
    writer.write_all(&end.as_bytes()[count..]).await
}

fn write_timeout(machine: MachineIdentity) -> RequestFailure {
    RequestFailure::TimedOut(wire::unavailable(
        machine,
        ExecutionOutcome::NotExecuted,
        wire::TIMEOUT_BEFORE_SEND,
    ))
}

/// A watch response has session metadata alongside its unchanged application snapshot.
fn watch_number(result: &Value) -> Option<u64> {
    let object = result.as_object()?;
    if object.contains_key("snapshot")
        && (object.len() == 2 || object.len() == 3 && object.contains_key("attach"))
    {
        return object.get("watch")?.as_u64();
    }
    None
}

fn ended_snapshot(snapshot: &Value) -> bool {
    snapshot.get("process").and_then(Value::as_str) == Some("ended")
        || snapshot.get("exit").is_some_and(|exit| !exit.is_null())
}

fn ended_change(change: &Value) -> bool {
    matches!(
        change.get("kind").and_then(Value::as_str),
        Some("exit" | "removed")
    )
}

struct Incoming {
    id: u64,
    peer: Arc<Peer>,
    cancelled: watch::Receiver<bool>,
}

impl Incoming {
    async fn serve(mut self, handler: impl SessionHandler, forward: Forward, deadline: Deadline) {
        let activity = match forward.work().map(|kind| self.peer.hold(kind)).transpose() {
            Ok(activity) => activity,
            Err(detail) => {
                let machine = handler.identity(forward.route.last().map_or("", String::as_str));
                let error = wire::unavailable(machine, ExecutionOutcome::NotExecuted, detail);
                self.peer.reply(Response::failed(Some(self.id), error));
                return;
            }
        };
        let mut cancelled = self.cancelled.clone();
        let result = tokio::select! {
            biased;
            _ = cancelled.wait_for(|cancelled| *cancelled) => return,
            result = handler.receive(forward, deadline, self.cancelled.clone()) => result,
        };
        let result = match result {
            Err(error) => Err(error),
            Ok(Delivery::Local(TargetReply::Call(result))) => result,
            Ok(Delivery::Local(TargetReply::Watch {
                snapshot,
                changes,
                attach,
            })) => {
                return self
                    .watch(snapshot, Changes::Local(changes), attach, activity)
                    .await;
            }
            Ok(Delivery::Relayed(_, Reply::Call { result, .. })) => result,
            Ok(Delivery::Relayed(
                pending,
                Reply::Watch {
                    snapshot,
                    changes,
                    attach,
                    ..
                },
            )) => {
                return self
                    .watch(
                        snapshot,
                        Changes::Relayed {
                            changes,
                            _pending: pending,
                        },
                        attach,
                        activity,
                    )
                    .await;
            }
        };
        match result {
            Ok(value) => self.peer.reply(Response::ok(self.id, value)),
            Err(error) => self.peer.reply(Response::failed(
                Some(self.id),
                self.peer.project_error(error),
            )),
        }
    }

    async fn watch(
        &mut self,
        snapshot: Value,
        mut changes: Changes,
        mut attach: Option<AttachBinding>,
        mut activity: Option<SessionActivity>,
    ) {
        if ended_snapshot(&snapshot) {
            let _ = activity.take();
            attach = None;
        }
        self.peer.reply(Response::ok(
            self.id,
            ForwardWatchResult {
                watch: self.id,
                snapshot,
                attach: attach.filter(|_| self.peer.supports(v3::CAP_ATTACH)),
            },
        ));
        loop {
            let change = tokio::select! {
                biased;
                _ = self.cancelled.wait_for(|cancelled| *cancelled) => return,
                change = changes.next() => change,
            };
            match change {
                Some(Ok(change)) => {
                    if activity.is_some() && ended_change(&change) {
                        let _ = activity.take();
                    }
                    self.peer.notify(Notification::new(
                        methods::CHANGED,
                        ChangedParams {
                            watch: self.id,
                            change,
                        },
                    ));
                }
                ended => {
                    let error = ended.and_then(Result::err).unwrap_or_else(|| {
                        ErrorBody::new(Reason::Unavailable, "The subscription ended.")
                    });
                    self.peer.notify(Notification::new(
                        methods::WATCH_ENDED,
                        WatchEndedParams {
                            watch: self.id,
                            error: self.peer.project_error(error),
                        },
                    ));
                    return;
                }
            }
        }
    }
}

impl Drop for Incoming {
    fn drop(&mut self) {
        if let Some(cancel) = self.peer.state.lock().unwrap().incoming.remove(&self.id) {
            cancel.send_replace(true);
        }
    }
}
