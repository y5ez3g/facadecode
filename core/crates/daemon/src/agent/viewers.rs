//! Delivers screen changes and replaces missed output with a complete frame.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use facade_base::process::{ProcessExit, ProcessState};
use facade_screen::{ParsedOutput, Screen};
use tokio::sync::{mpsc, oneshot, watch};

/// Incremental output allowed in each queue; a complete redraw may be larger.
const MAX_VIEWER_OUTPUT_BYTES: usize = 1024 * 1024;

/// A screen change sent to a viewer.
#[derive(Debug)]
pub(crate) enum ViewerChange {
    /// A full redraw after missed output, a resize, or a return to the main screen.
    Redraw {
        bytes: Vec<u8>,
        cols: u16,
        rows: u16,
    },
    /// Terminal output since the previous change.
    Output(Arc<[u8]>),
    /// The run ended after all its screen changes.
    Exit(ProcessExit),
    /// The agent was removed. No changes follow.
    Removed,
}

/// A viewer's initial screen, size, recorded exit, and process state, captured together.
pub(crate) struct ViewerSnapshot {
    pub(crate) redraw: Vec<u8>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) exit: Option<ProcessExit>,
    pub(crate) process: ProcessState,
}

/// A viewer asking for its snapshot.
pub(crate) struct ViewerRequest {
    pub(crate) viewer: u64,
    pub(crate) kind: ViewKind,
    pub(crate) tx: ViewerSender,
    pub(crate) keep_scrollback: bool,
    pub(crate) include_scrollback: bool,
    pub(crate) reply: oneshot::Sender<ViewerSnapshot>,
}

pub(crate) enum ViewKind {
    Legacy,
    Attach(Option<String>),
}

/// The viewers of one agent's screen.
pub(crate) struct Viewers {
    active: Vec<Viewer>,
    waiting: Vec<ViewerRequest>,
}

/// What must precede a viewer's next incremental output.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Drawing {
    Current,
    Redraw,
    RedrawThenExit,
}

/// One admitted viewer and the frame it is owed.
struct Viewer {
    id: u64,
    kind: ViewKind,
    tx: ViewerSender,
    keep_scrollback: bool,
    drawing: Drawing,
}

impl Viewers {
    /// Starts with no watches or snapshot requests.
    pub(crate) fn new() -> Viewers {
        Self {
            active: Vec::new(),
            waiting: Vec::new(),
        }
    }

    /// Whether a viewer watches or waits for its snapshot.
    pub(crate) fn is_watched(&self) -> bool {
        !(self.active.is_empty() && self.waiting.is_empty())
    }

    /// Whether any viewer needs a complete frame.
    pub(crate) fn is_behind(&self) -> bool {
        self.active.iter().any(|v| v.drawing != Drawing::Current)
    }

    /// Waits for a complete frame before replying to this request.
    pub(crate) fn request(&mut self, request: ViewerRequest) {
        self.waiting.push(request);
    }

    /// Removes a watch or its pending snapshot request.
    pub(crate) fn remove(&mut self, viewer: u64) {
        self.active.retain(|v| v.id != viewer);
        self.waiting.retain(|v| v.viewer != viewer);
    }

    /// Names of admitted connections, in admission order.
    pub(crate) fn names(&self) -> Vec<String> {
        self.active
            .iter()
            .filter_map(|v| match &v.kind {
                ViewKind::Attach(name) if !v.tx.queue.is_closed() => name.clone(),
                _ => None,
            })
            .collect()
    }

    /// Captures waiting watches after synchronized output has finished.
    pub(crate) fn admit(
        &mut self,
        screen: &Screen,
        exit: Option<&ProcessExit>,
        process: ProcessState,
    ) {
        if screen.synchronized_update_deadline().is_some() {
            return;
        }
        for request in self.waiting.drain(..) {
            let snapshot = ViewerSnapshot {
                redraw: screen.redraw(request.keep_scrollback, request.include_scrollback),
                cols: screen.cols(),
                rows: screen.rows(),
                exit: exit.cloned(),
                process,
            };
            if request.reply.send(snapshot).is_err()
                || (process != ProcessState::Running && matches!(request.kind, ViewKind::Attach(_)))
            {
                continue;
            }
            self.active.push(Viewer {
                id: request.viewer,
                kind: request.kind,
                tx: request.tx,
                keep_scrollback: request.keep_scrollback,
                drawing: Drawing::Current,
            });
        }
    }

    /// Sends parsed output, or marks watches for the redraw the parser requires.
    pub(crate) fn show(&mut self, fed: &ParsedOutput) {
        if fed.redraw_viewers {
            self.redraw_all();
        } else if !fed.viewer_output.is_empty() {
            let bytes: Arc<[u8]> = fed.viewer_output.as_slice().into();
            self.active.retain_mut(|v| {
                if v.drawing != Drawing::Current {
                    return true;
                }
                if v.tx.queue.is_closed() {
                    return false;
                }
                if v.tx.bytes() + bytes.len() > MAX_VIEWER_OUTPUT_BYTES {
                    v.drawing = Drawing::Redraw;
                    return true;
                }
                v.tx.send(ViewerChange::Output(bytes.clone()))
            });
        }
    }

    /// Makes the next visible frame a complete redraw for every watch.
    pub(crate) fn redraw_all(&mut self) {
        for v in &mut self.active {
            if v.drawing == Drawing::Current {
                v.drawing = Drawing::Redraw;
            }
        }
    }

    /// Delivers missed frames and exits when queues have room and the screen is complete.
    pub(crate) fn catch_up(&mut self, screen: &Screen, exit: Option<&ProcessExit>) -> bool {
        if screen.synchronized_update_deadline().is_none() {
            self.active.retain_mut(|v| {
                if v.drawing != Drawing::Current && v.tx.bytes() <= MAX_VIEWER_OUTPUT_BYTES / 2 {
                    v.draw(screen, exit)
                } else {
                    !v.tx.queue.is_closed()
                }
            });
        }
        self.is_behind()
    }

    /// Queues the run's exit immediately for current watches, after redraw for others.
    pub(crate) fn send_exit(&mut self, exit: &ProcessExit) {
        self.active.retain_mut(|v| match v.drawing {
            Drawing::Current => {
                v.tx.send(ViewerChange::Exit(exit.clone())) && matches!(v.kind, ViewKind::Legacy)
            }
            _ => {
                v.drawing = Drawing::RedrawThenExit;
                true
            }
        });
    }

    /// Completes the old run before resume; disconnects watches still over budget.
    pub(crate) fn finish_run(&mut self, screen: &Screen, exit: Option<&ProcessExit>) {
        self.active.retain_mut(|v| {
            if v.drawing == Drawing::Current {
                return !v.tx.queue.is_closed();
            }
            if v.tx.bytes() <= MAX_VIEWER_OUTPUT_BYTES {
                return v.draw(screen, exit);
            }
            v.tx.stalled.send_replace(true);
            false
        });
    }

    /// Sends the final frame and deferred exit before removal, then releases the watches.
    pub(crate) fn finish(&mut self, screen: &Screen, exit: Option<&ProcessExit>) {
        for mut v in self.active.drain(..) {
            if v.drawing != Drawing::Current {
                v.draw(screen, exit);
            }
            v.tx.send(ViewerChange::Removed);
        }
    }
}

impl Viewer {
    /// Enqueues the complete frame before any deferred exit, regardless of queue budget.
    fn draw(&mut self, screen: &Screen, exit: Option<&ProcessExit>) -> bool {
        let owes_exit = self.drawing == Drawing::RedrawThenExit;
        self.drawing = Drawing::Current;
        let frame = ViewerChange::Redraw {
            bytes: screen.redraw(self.keep_scrollback, false),
            cols: screen.cols(),
            rows: screen.rows(),
        };
        let mut alive = self.tx.send(frame);
        if let Some(exit) = exit.filter(|_| owes_exit) {
            alive &= self.tx.send(ViewerChange::Exit(exit.clone()));
            alive &= matches!(self.kind, ViewKind::Legacy);
        }
        alive
    }
}

/// The sending side of a viewer queue, accounting for bytes until reception.
pub(crate) struct ViewerSender {
    queue: mpsc::UnboundedSender<ViewerChange>,
    queued_bytes: Arc<AtomicUsize>,
    stalled: watch::Sender<bool>,
}

/// The receiving side of a viewer queue.
pub(crate) struct ViewerReceiver {
    queue: mpsc::UnboundedReceiver<ViewerChange>,
    queued_bytes: Arc<AtomicUsize>,
    stalled: watch::Receiver<bool>,
}

impl ViewerChange {
    fn payload_bytes(&self) -> usize {
        match self {
            Self::Output(bytes) => bytes.len(),
            Self::Redraw { bytes, .. } => bytes.len(),
            _ => 0,
        }
    }
}

impl ViewerSender {
    fn bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::Relaxed)
    }

    fn send(&self, change: ViewerChange) -> bool {
        if self.queue.is_closed() {
            return false;
        }
        self.queued_bytes
            .fetch_add(change.payload_bytes(), Ordering::Relaxed);
        self.queue.send(change).is_ok()
    }
}

impl ViewerReceiver {
    /// Waits for the next change, releasing its queue budget before returning it.
    pub(crate) async fn recv(&mut self) -> Option<ViewerChange> {
        self.queue.recv().await.inspect(|change| {
            self.queued_bytes
                .fetch_sub(change.payload_bytes(), Ordering::Relaxed);
        })
    }

    /// Waits for a resume to drop this stalled watch; normal removal never completes it.
    pub(crate) fn stalled(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let mut receiver = self.stalled.clone();
        async move {
            let closed = receiver.wait_for(|value| *value).await.is_err();
            if closed {
                std::future::pending::<()>().await;
            }
        }
    }
}

/// Creates one byte-counted queue and its disconnect watch.
pub(crate) fn viewer_channel() -> (ViewerSender, ViewerReceiver) {
    let (queue, receiver) = mpsc::unbounded_channel();
    let (stalled, watch) = watch::channel(false);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let tx = ViewerSender {
        queue,
        stalled,
        queued_bytes: Arc::clone(&queued_bytes),
    };
    let rx = ViewerReceiver {
        queue: receiver,
        stalled: watch,
        queued_bytes,
    };
    (tx, rx)
}
