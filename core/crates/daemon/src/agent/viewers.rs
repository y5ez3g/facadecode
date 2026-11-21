//! Delivers screen changes and replaces missed output with a complete frame.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use facade_base::process::{ProcessExit, ProcessState};
use facade_base::v3::{AttachmentInfo, AttachmentKind, ScreenSize};
use facade_screen::{ParsedOutput, Screen};
use tokio::sync::{mpsc, oneshot, watch};

use super::ViewerSizing;

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
    /// Whether the agent is starting or working changed.
    Activity(bool),
    /// The run ended after all its screen changes.
    Exit(ProcessExit, Option<String>),
    /// The agent was removed. No changes follow.
    Removed,
}

/// A viewer's initial screen, size, process state and requested activity, captured together.
pub(crate) struct ViewerSnapshot {
    pub(crate) name: String,
    pub(crate) redraw: Vec<u8>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) exit: Option<ProcessExit>,
    pub(crate) resume_hint: Option<String>,
    pub(crate) process: ProcessState,
    pub(crate) working: Option<bool>,
}

/// A viewer asking for its snapshot.
pub(crate) struct ViewerRequest {
    pub(crate) viewer: u64,
    pub(crate) kind: ViewKind,
    pub(crate) sizing: ViewerSizing,
    pub(crate) size: Option<ScreenSize>,
    pub(crate) tx: ViewerSender,
    pub(crate) keep_scrollback: bool,
    pub(crate) include_scrollback: bool,
    pub(crate) reply: oneshot::Sender<ViewerSnapshot>,
}

pub(crate) enum ViewKind {
    /// The watch unit tests open with `AddViewer`: it stays through the run's exit.
    #[cfg(test)]
    Test,
    Attach {
        name: Option<String>,
        attachment: Option<AttachmentInfo>,
        allow_ended: bool,
        report_activity: bool,
    },
}

impl ViewKind {
    fn reports_activity(&self) -> bool {
        matches!(
            self,
            Self::Attach {
                report_activity: true,
                ..
            }
        )
    }

    /// A Shell attachment shows the CLI's final instructions next to its exit receipt.
    fn resume_hint(&self, screen: &Screen) -> Option<String> {
        matches!(
            self,
            Self::Attach {
                attachment: Some(AttachmentInfo {
                    kind: AttachmentKind::Shell,
                    ..
                }),
                ..
            }
        )
        .then(|| final_resume_hint(screen))
    }

    /// Whether the viewer stays once told the run's exit. An attached viewer ends with the run.
    fn outlives_exit(&self) -> bool {
        match self {
            #[cfg(test)]
            ViewKind::Test => true,
            ViewKind::Attach { .. } => false,
        }
    }

    pub(crate) fn waits_for_exit(&self) -> bool {
        matches!(
            self,
            Self::Attach {
                allow_ended: true,
                ..
            }
        )
    }
}

impl ViewerRequest {
    pub(crate) fn is_closed(&self) -> bool {
        self.reply.is_closed() || self.tx.queue.is_closed()
    }
}

/// The viewers of one agent's screen.
pub(crate) struct Viewers {
    active: Vec<Viewer>,
    waiting: Vec<ViewerRequest>,
    working: bool,
    removed: bool,
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
    sizing: ViewerSizing,
    size: Option<ScreenSize>,
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
            working: false,
            removed: false,
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

    pub(crate) fn take_waiting(&mut self) -> Vec<ViewerRequest> {
        std::mem::take(&mut self.waiting)
    }

    /// Removes a watch or its pending snapshot request.
    pub(crate) fn remove(&mut self, viewer: u64) {
        self.retain_active(|v| v.id != viewer);
        self.waiting.retain(|v| v.viewer != viewer);
    }

    fn retain_active(&mut self, keep: impl FnMut(&mut Viewer) -> bool) {
        let count = self.active.len();
        self.active.retain_mut(keep);
        self.removed |= self.active.len() != count;
    }

    pub(crate) fn take_removed(&mut self) -> bool {
        std::mem::take(&mut self.removed)
    }

    pub(crate) fn has_sizing(&self, sizing: ViewerSizing) -> bool {
        self.active.iter().any(|v| v.sizing == sizing && v.live())
    }

    pub(crate) fn update_capacity(&mut self, viewer: u64, size: ScreenSize) -> bool {
        let Some(viewer) = self
            .active
            .iter_mut()
            .find(|v| v.id == viewer && v.sizing == ViewerSizing::Shared && v.live())
        else {
            return false;
        };
        viewer.size = Some(size);
        true
    }

    /// Each dimension is limited independently by the live shared viewers' reports.
    pub(crate) fn shared_size(&self, joining: Option<ScreenSize>) -> Option<ScreenSize> {
        self.active
            .iter()
            .filter(|v| v.sizing == ViewerSizing::Shared && v.live())
            .filter_map(|v| v.size)
            .chain(joining)
            .reduce(|a, b| ScreenSize {
                cols: a.cols.min(b.cols),
                rows: a.rows.min(b.rows),
            })
    }

    /// Names of admitted connections, in admission order.
    pub(crate) fn names(&self) -> Vec<String> {
        self.active
            .iter()
            .filter_map(|v| match &v.kind {
                ViewKind::Attach { name, .. } if !v.tx.queue.is_closed() => name.clone(),
                _ => None,
            })
            .collect()
    }

    pub(crate) fn attachments(&self) -> Vec<AttachmentInfo> {
        self.active
            .iter()
            .filter_map(|v| match &v.kind {
                ViewKind::Attach { attachment, .. } if !v.tx.queue.is_closed() => {
                    attachment.clone()
                }
                _ => None,
            })
            .collect()
    }

    /// Captures an initial frame and keeps the watch for the life of the run.
    pub(crate) fn admit(
        &mut self,
        request: ViewerRequest,
        screen: &Screen,
        exit: Option<&ProcessExit>,
        process: ProcessState,
        name: &str,
    ) {
        let snapshot = ViewerSnapshot {
            name: name.to_owned(),
            redraw: screen.redraw(request.keep_scrollback, request.include_scrollback),
            cols: screen.cols(),
            rows: screen.rows(),
            exit: exit.cloned(),
            resume_hint: if process == ProcessState::Ended {
                request.kind.resume_hint(screen)
            } else {
                None
            },
            process,
            working: request.kind.reports_activity().then_some(self.working),
        };
        if request.reply.send(snapshot).is_err() || request.tx.queue.is_closed() {
            self.removed |= request.sizing == ViewerSizing::Shared;
            return;
        }
        if process != ProcessState::Running && !request.kind.outlives_exit() {
            return;
        }
        self.active.push(Viewer {
            id: request.viewer,
            kind: request.kind,
            sizing: request.sizing,
            size: request.size,
            tx: request.tx,
            keep_scrollback: request.keep_scrollback,
            drawing: Drawing::Current,
        });
    }

    /// Sends a working-state transition to the viewers that requested activity.
    pub(crate) fn set_working(&mut self, working: bool) {
        if self.working == working {
            return;
        }
        self.working = working;
        self.retain_active(|v| {
            !v.kind.reports_activity() || v.tx.send(ViewerChange::Activity(working))
        });
    }

    /// Sends parsed output, or marks watches for the redraw the parser requires.
    pub(crate) fn show(&mut self, fed: &ParsedOutput) {
        if fed.redraw_viewers {
            self.redraw_all();
        } else if !fed.viewer_output.is_empty() {
            let bytes: Arc<[u8]> = fed.viewer_output.as_slice().into();
            self.retain_active(|v| {
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
            self.retain_active(|v| {
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
    pub(crate) fn send_exit(&mut self, screen: &Screen, exit: &ProcessExit) {
        self.retain_active(|v| match v.drawing {
            Drawing::Current => {
                v.tx.send(ViewerChange::Exit(exit.clone(), v.kind.resume_hint(screen)))
                    && v.kind.outlives_exit()
            }
            _ => {
                v.drawing = Drawing::RedrawThenExit;
                true
            }
        });
    }

    /// Completes the old run before resume; disconnects watches still over budget.
    pub(crate) fn finish_run(&mut self, screen: &Screen, exit: Option<&ProcessExit>) {
        self.retain_active(|v| {
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
    fn live(&self) -> bool {
        self.drawing != Drawing::RedrawThenExit && !self.tx.queue.is_closed()
    }

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
            alive &= self.tx.send(ViewerChange::Exit(
                exit.clone(),
                self.kind.resume_hint(screen),
            ));
            alive &= self.kind.outlives_exit();
        }
        alive
    }
}

/// Keeps the CLI's own recovery instruction at the bottom, including its command lines.
fn final_resume_hint(screen: &Screen) -> String {
    let lines = screen.text(6);
    let Some(start) = lines.iter().rposition(|line| {
        line.starts_with("To resume this session:") || line == "To continue this session, run:"
    }) else {
        return String::new();
    };
    let following = lines[start + 1..]
        .iter()
        .take_while(|line| line.starts_with(' ') || line.starts_with("Or run "));
    std::iter::once(&lines[start])
        .chain(following)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n")
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
