//! Requests, responses and watches multiplexed over one machine link.

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Poll, ready};
use std::time::Duration;

use facade_base::daemon::{
    CancelParams, ChangedParams, UnwatchParams, WatchEndedParams, WatchResult, methods,
};
use facade_base::jsonrpc::{
    ErrorBody, MAX_LINE_BYTES, Notification, Reason, Response, decode_arguments,
};
use facade_base::machine::{AdvertiseParams, ExecutionOutcome, MachineIdentity};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use super::TargetReply;
use super::wire::{self, Forward, Frame, Reader};

type Change = Result<Value, ErrorBody>;
type Answer = Result<Reply, ErrorBody>;
pub(super) type Deadline = Option<Instant>;

/// Applies machine frames to the routes of this connection.
pub(super) trait SessionHandler: Clone + Send + Sync + 'static {
    fn replace_table(&self, table: AdvertiseParams) -> Result<(), ErrorBody>;

    fn receive(
        &self,
        forward: Forward,
        deadline: Deadline,
        cancelled: watch::Receiver<bool>,
    ) -> impl Future<Output = Result<Delivery, ErrorBody>> + Send;
}

pub(crate) struct Subscription {
    pub(crate) snapshot: Value,
    changes: mpsc::UnboundedReceiver<Change>,
    _request: Pending,
}

impl Subscription {
    /// The final item is an error if the remote watch or its link ended.
    pub(crate) async fn next(&mut self) -> Option<Result<Value, ErrorBody>> {
        self.changes.recv().await
    }
}

pub(super) enum Reply {
    Call(Value),
    Watch {
        snapshot: Value,
        changes: mpsc::UnboundedReceiver<Change>,
    },
}

pub(super) enum Delivery {
    Local(TargetReply),
    Relayed(Pending, Reply),
}

enum Changes {
    Local(mpsc::Receiver<Change>),
    Relayed {
        changes: mpsc::UnboundedReceiver<Change>,
        _pending: Pending,
    },
}

impl Changes {
    async fn next(&mut self) -> Option<Change> {
        match self {
            Self::Local(changes) => changes.recv().await,
            Self::Relayed { changes, .. } => changes.recv().await,
        }
    }
}

pub(super) struct Pending {
    peer: Arc<Peer>,
    id: u64,
    machine: MachineIdentity,
    reply: oneshot::Receiver<Answer>,
}

impl Pending {
    pub(super) async fn answer(&mut self, deadline: Deadline) -> Answer {
        tokio::select! {
            biased;
            answer = &mut self.reply => answer.unwrap_or_else(|_| {
                Err(wire::unavailable(
                    self.machine.clone(),
                    ExecutionOutcome::OutcomeUnknown,
                    "The machine session closed.",
                ))
            }),
            () = expires(deadline) => {
                let sent = self.peer.release(self.id);
                // The writer or disconnect can finish this waiter as its deadline fires.
                if sent.is_none() && let Ok(answer) = self.reply.try_recv() {
                    return answer;
                }
                Err(wire::unavailable(
                    self.machine.clone(),
                    execution(sent.unwrap_or(true)),
                    "The request timed out.",
                ))
            },
        }
    }

    pub(super) fn watch(
        self,
        snapshot: Value,
        changes: mpsc::UnboundedReceiver<Change>,
    ) -> Subscription {
        Subscription {
            snapshot,
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
}

struct State {
    open: bool,
    next: u64,
    outgoing: HashMap<u64, Outgoing>,
    watches: HashMap<u64, u64>,
    incoming: HashMap<u64, watch::Sender<bool>>,
}

enum Outgoing {
    Waiting {
        machine: MachineIdentity,
        sent: bool,
        reply: oneshot::Sender<Answer>,
    },
    Watching {
        machine: MachineIdentity,
        watch: u64,
        changes: mpsc::UnboundedSender<Change>,
    },
}

pub(super) enum Output {
    Forward {
        id: u64,
        forward: Forward,
        deadline: Deadline,
    },
    Response(Response),
    Notification(Notification),
}

enum ReadEnd {
    Closed,
    Rejected(ErrorBody),
}

impl Peer {
    pub(super) fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<Output>) {
        let (outbox, output) = mpsc::unbounded_channel();
        let peer = Arc::new(Self {
            state: Mutex::new(State {
                open: true,
                next: wire::FIRST_REQUEST_ID,
                outgoing: HashMap::new(),
                watches: HashMap::new(),
                incoming: HashMap::new(),
            }),
            outbox,
            stopped: watch::channel(false).0,
        });
        (peer, output)
    }

    pub(super) fn notify(&self, notification: Notification) {
        let _ = self.outbox.send(Output::Notification(notification));
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
        let mut state = self.state.lock().unwrap();
        let unavailable = || {
            wire::unavailable(
                machine.clone(),
                ExecutionOutcome::NotExecuted,
                "The machine session closed.",
            )
        };
        if !state.open {
            return Err(unavailable());
        }
        let id = state.next;
        state.next += 1;
        let (reply, receiver) = oneshot::channel();
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
            },
        );
        Ok(Pending {
            peer: self.clone(),
            id,
            machine,
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
    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        if !state.open {
            return;
        }
        state.open = false;
        self.stopped.send_replace(true);
        for (_, cancellation) in state.incoming.drain() {
            cancellation.send_replace(true);
        }
        state.watches.clear();
        for (_, outgoing) in state.outgoing.drain() {
            match outgoing {
                Outgoing::Waiting {
                    machine,
                    sent,
                    reply,
                } => {
                    let _ = reply.send(Err(wire::unavailable(
                        machine,
                        execution(sent),
                        "The machine session closed.",
                    )));
                }
                Outgoing::Watching {
                    machine, changes, ..
                } => {
                    let _ = changes.send(Err(wire::unavailable(
                        machine,
                        ExecutionOutcome::OutcomeUnknown,
                        "The subscription ended when the machine session closed.",
                    )));
                }
            }
        }
    }

    fn response(&self, response: Response) -> Result<(), ErrorBody> {
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
        let Some(Outgoing::Waiting { machine, reply, .. }) = state.outgoing.remove(&id) else {
            unreachable!();
        };
        if let Some(watch) = watch {
            let WatchResult { snapshot, .. } = decode_arguments(result.expect("watch result"))?;
            let (changes, receiver) = mpsc::unbounded_channel();
            state.watches.insert(watch, id);
            state.outgoing.insert(
                id,
                Outgoing::Watching {
                    machine,
                    watch,
                    changes,
                },
            );
            let _ = reply.send(Ok(Reply::Watch {
                snapshot,
                changes: receiver,
            }));
        } else {
            let _ = reply.send(result.map(Reply::Call));
        }
        Ok(())
    }

    fn changed(&self, ChangedParams { watch, change }: ChangedParams) {
        let state = self.state.lock().unwrap();
        if let Some(id) = state.watches.get(&watch)
            && let Some(Outgoing::Watching { changes, .. }) = state.outgoing.get(id)
        {
            let _ = changes.send(Ok(change));
        }
    }

    fn watch_ended(&self, WatchEndedParams { watch, error }: WatchEndedParams) {
        let mut state = self.state.lock().unwrap();
        if let Some(id) = state.watches.remove(&watch)
            && let Some(Outgoing::Watching { changes, .. }) = state.outgoing.remove(&id)
        {
            let _ = changes.send(Err(error));
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
        };
        if let ReadEnd::Rejected(error) = ended {
            // The route and all waiters are already withdrawn. If dropping this write could
            // have left a partial line, another line would only corrupt the diagnostic.
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
                            if let Err(error) =
                                handler.replace_table(decode_arguments(request.params)?)
                            {
                                return Ok(ReadEnd::Rejected(error));
                            }
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
                Output::Notification(notification) => wire::send(writer, &notification).await?,
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
            self.fail_unwritten(id, |_| ErrorBody::line_too_long());
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

    fn fail_unwritten(&self, id: u64, error: impl FnOnce(MachineIdentity) -> ErrorBody) {
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

fn write_timeout(machine: MachineIdentity) -> ErrorBody {
    wire::unavailable(
        machine,
        ExecutionOutcome::NotExecuted,
        "The request timed out before it was sent.",
    )
}

/// A watch response has session metadata alongside its unchanged application snapshot.
fn watch_number(result: &Value) -> Option<u64> {
    let object = result.as_object()?;
    if object.len() == 2 && object.contains_key("snapshot") {
        return object.get("watch")?.as_u64();
    }
    None
}

struct Incoming {
    id: u64,
    peer: Arc<Peer>,
    cancelled: watch::Receiver<bool>,
}

impl Incoming {
    async fn serve(mut self, handler: impl SessionHandler, forward: Forward, deadline: Deadline) {
        let mut cancelled = self.cancelled.clone();
        let result = tokio::select! {
            biased;
            _ = cancelled.wait_for(|cancelled| *cancelled) => return,
            result = handler.receive(forward, deadline, self.cancelled.clone()) => result,
        };
        let result = match result {
            Err(error) => Err(error),
            Ok(Delivery::Local(TargetReply::Call(result))) => result,
            Ok(Delivery::Local(TargetReply::Watch { snapshot, changes })) => {
                return self.watch(snapshot, Changes::Local(changes)).await;
            }
            Ok(Delivery::Relayed(_, Reply::Call(value))) => Ok(value),
            Ok(Delivery::Relayed(pending, Reply::Watch { snapshot, changes })) => {
                return self
                    .watch(
                        snapshot,
                        Changes::Relayed {
                            changes,
                            _pending: pending,
                        },
                    )
                    .await;
            }
        };
        match result {
            Ok(value) => self.peer.reply(Response::ok(self.id, value)),
            Err(error) => self.peer.reply(Response::failed(Some(self.id), error)),
        }
    }

    async fn watch(&mut self, snapshot: Value, mut changes: Changes) {
        self.peer.reply(Response::ok(
            self.id,
            WatchResult {
                watch: self.id,
                snapshot,
            },
        ));
        loop {
            let change = tokio::select! {
                biased;
                _ = self.cancelled.wait_for(|cancelled| *cancelled) => return,
                change = changes.next() => change,
            };
            match change {
                Some(Ok(change)) => self.peer.notify(Notification::new(
                    methods::CHANGED,
                    ChangedParams {
                        watch: self.id,
                        change,
                    },
                )),
                ended => {
                    let error = ended.and_then(Result::err).unwrap_or_else(|| {
                        ErrorBody::new(Reason::Unavailable, "The subscription ended.")
                    });
                    self.peer.notify(Notification::new(
                        methods::WATCH_ENDED,
                        WatchEndedParams {
                            watch: self.id,
                            error,
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
