//! An agent: one actor task that owns its terminal, screen, state, status glyph, typist, viewers
//! and the start of each run, and the handle the rest of the daemon reaches it through.
//!
//! The actor answers commands before it reads more output, and reads at most 64 KiB at a time.
//! Output goes into the screen log before the screen parses it. Each run of the CLI has a number:
//! input and exits name the run they are meant for, so nothing meant for an ended run reaches the
//! run that resumes the agent in the same terminal.
//!
//! The parts the actor owns never call one another; `actor.rs` passes what one learns to the next.

mod actor;
mod glyph;
mod input_gate;
mod person;
mod readiness;
mod screen;
mod state;
mod terminal;
#[cfg(test)]
mod tests;
mod typist;
mod viewers;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::api_v1::{Size, daemon::AttachmentInfo};
use facade_base::key_input::{PASTE_END, PASTE_START};
use facade_base::model::error::ErrorBody;
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::terminal::PtyMaster;
use facade_base::{
    model::agent::{AgentRef, AgentsUpdate, ManagedAgent},
    model::terminal::InputInfo,
};
use facade_screen::{Screen, ScreenView, TerminalColors, VisibleCell};
use tokio::sync::{Notify, broadcast, mpsc, oneshot, watch};
use tokio::time::Instant;

use crate::messages::{DeliveryHandle, PromptWatch};
use crate::store::DraftProof;
use crate::waits::Trouble;
use crate::{Sender, ToolsGiven};

pub(crate) use facade_base::key_input::MAX_INPUT_BYTES;
pub(crate) use screen::{ScreenLog, recover, recover_after_clean_end, saved_size, screen_writes};
pub(crate) use state::{Kept, instant_of, read_kept, state_file};
pub(crate) use typist::{MessageTyping, Typing, TypingAnswer};
pub(crate) use viewers::{
    ViewerChange, ViewerSender, ViewerSnapshot, viewer_channel, viewer_channel_with_exit,
};

/// Rows of scrollback each agent's screen keeps.
pub(crate) const SCROLLBACK_ROWS: usize = 10_000;
/// The room of an agent's command channel.
pub(crate) const MAX_QUEUED_COMMANDS: usize = 1024;
/// The number of an agent's first run.
pub(crate) const FIRST_RUN: u64 = 1;

pub(crate) type WatchdogSink = Box<dyn Fn(ManagedAgent, Trouble) + Send>;

/// The pause after an Escape, so that the CLI does not read it with the next key as Alt.
const ESCAPE_DELAY: Duration = Duration::from_millis(50);
/// The longest a CLI takes to draw what it read: what the input shows is waited for this long. On
/// 2026-11-24 the slowest of 59 messages to a CLI on a machine starting ten others took 2.5 seconds.
const SLOWEST_DRAW: Duration = Duration::from_millis(2500);
/// How long a run's start may take before its CLI should show its input.
const START_TIMEOUT: Duration = Duration::from_secs(30);

// The screen log sizes its largest record by what one feed takes; a read never brings more.
const _: () = assert!(terminal::MAX_READ_BYTES <= screen::MAX_FEED_BYTES);

static VIEW_STORAGE: Mutex<Vec<ScreenView>> = Mutex::new(Vec::new());

/// Releases the row storage after all managed runs have settled.
pub(crate) fn release_view_storage() {
    let idle = std::mem::take(&mut *VIEW_STORAGE.lock().unwrap());
    drop(idle);
}

/// Keeps a few ordinary views' row allocations for subsequent input and state readings. A
/// reader fills its own storage and runs without the pool lock.
fn with_screen_view<T>(screen: &Screen, read: impl FnOnce(&ScreenView) -> T) -> T {
    const RETAINED_VIEWS: usize = 4;
    const RETAINED_VIEW_BYTES: usize = 160 * 1024;

    let mut view = VIEW_STORAGE.lock().unwrap().pop().unwrap_or_default();
    screen.refresh_view(&mut view);
    let result = read(&view);
    let bytes = view.rows.capacity() * size_of::<Vec<VisibleCell>>()
        + view.rows.iter().map(Vec::capacity).sum::<usize>() * size_of::<VisibleCell>()
        + view.continues.capacity();
    if bytes <= RETAINED_VIEW_BYTES {
        for row in &mut view.rows {
            row.clear();
        }
        let mut returned = VIEW_STORAGE.lock().unwrap();
        if returned.len() < RETAINED_VIEWS {
            returned.push(view);
        }
    }
    result
}

/// What was said to an agent, and who said it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Submission {
    pub(crate) text: String,
    pub(crate) sender: Sender,
}

/// Input for an agent's terminal.
#[derive(Debug)]
pub(crate) enum Input {
    /// Keys from an attached terminal, written as they come.
    Raw(Vec<u8>),
    /// Program input with a receipt once it reaches the terminal.
    Typed(Typing),
    /// A message for the typist to deliver into the CLI's input.
    Message(MessageTyping),
    /// The messages of a paste an earlier daemon began, in their order: the typist finishes it
    /// without typing it again.
    BegunPaste {
        messages: Vec<MessageTyping>,
        previous_text: Option<String>,
        draft: Option<DraftProof>,
    },
}

impl Input {
    fn is_sequence(&self) -> bool {
        matches!(self, Self::Typed(typing) if typing.is_sequence())
    }

    /// The most bytes this input writes into the terminal, as the `console` takes them where the
    /// CLI reads console input records.
    pub(crate) fn most_bytes(&self, console: Option<facade_rules::ConsoleTyping>) -> usize {
        match self {
            Input::Raw(keys) => keys.len(),
            Input::Typed(typing) => typing.most_bytes(console),
            Input::Message(message) => message.most_bytes(console),
            // A begun paste is either submitted or cleared by the typist.
            Input::BegunPaste { .. } => 1,
        }
    }
}

/// The agent record and current terminal facts, taken at one moment.
pub(crate) struct Inspection {
    pub(crate) agent: ManagedAgent,
    pub(crate) input: InputInfo,
    pub(crate) colors: TerminalColors,
    pub(crate) session_tracking: bool,
    pub(crate) viewers: Vec<String>,
    pub(crate) attachments: Vec<AttachmentInfo>,
    pub(crate) title: Option<String>,
    pub(crate) launch_command: Option<String>,
}

/// Says whether input was taken.
pub(crate) type InputReply = oneshot::Sender<Result<(), InputRejection>>;

/// Why input was not taken.
#[derive(Debug)]
pub(crate) enum InputRejection {
    /// The run the input was for ended.
    AgentExited,
    /// The waiting input is full, or a resize waits to take effect: the input comes back, to send
    /// again once [`AgentHandle::input_room_changed`] fires.
    Backpressured(Input),
    /// The input takes more of the terminal than all the room there is, these many bytes: it never
    /// fits.
    TooLarge(usize),
}

/// What the actor is asked to do.
pub(crate) enum AgentCommand {
    /// Takes input for run `run`, at most [`MAX_INPUT_BYTES`]. Input for any other run is refused
    /// as ended.
    WriteInput {
        input: Input,
        run: u64,
        reply: InputReply,
    },
    /// Applies an exact size to a unit fixture's terminal and screen.
    #[cfg(test)]
    ResizeTerminal(u16, u16),
    /// Adds a viewer: its snapshot goes through `reply` before any change.
    #[cfg(test)]
    AddViewer {
        viewer: u64,
        tx: ViewerSender,
        keep_scrollback: bool,
        include_scrollback: bool,
        reply: oneshot::Sender<ViewerSnapshot>,
    },
    /// Attaches to a running terminal and keeps the viewer's name for this watch.
    AttachViewer {
        viewer: u64,
        name: Option<String>,
        attachment: Option<AttachmentInfo>,
        allow_ended: bool,
        report_activity: bool,
        size: Option<Size>,
        tx: ViewerSender,
        keep_scrollback: bool,
        include_scrollback: bool,
        reply: oneshot::Sender<ViewerSnapshot>,
    },
    /// Reports a live shared viewer's capacity and any authorized colors.
    ResizeViewer {
        viewer: u64,
        size: Size,
        colors: Option<TerminalColors>,
        reply: oneshot::Sender<Result<(), ErrorBody>>,
    },
    RemoveViewer {
        viewer: u64,
    },
    ReadScreen {
        lines: usize,
        reply: oneshot::Sender<(facade_screen::Reading, ManagedAgent)>,
    },
    /// Reads the record, the input and whether the session is followed.
    Inspect {
        reply: oneshot::Sender<Inspection>,
    },
    /// Run `run` ended, `stopped` where Facade stopped it. An earlier run's exit is ignored; the
    /// exit of a run still being installed waits until it is.
    ProcessExited {
        run: u64,
        exit: ProcessExit,
        stopped: bool,
        stopped_by: Option<AgentRef>,
    },
    /// Enables reports to the creator once the startup prompt is registered.
    WatchCreator {
        prompt: Option<PromptWatch>,
        report: WatchdogSink,
    },
    /// The session the CLI reported, already committed; the record shows it from now on.
    RecordSession(Option<String>),
    /// Reserves run `run` and its size. Refuses input for earlier runs and lets go of the old
    /// terminal. Keeps the ended screen and replies when the log has room for the reset.
    PrepareRestart {
        run: u64,
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<()>,
    },
    /// Installs run `run`'s terminal once its process and cleared exit are committed. Finishes the
    /// old viewer frame, logs the screen reset and applies the new size before reading any output.
    /// Replies with the running record. A run that ended meanwhile then ends at once.
    InstallRun {
        run: u64,
        master: PtyMaster,
        pid: u32,
        captures: bool,
        launch_command: Option<String>,
        tools: ToolsGiven,
        tools_config: Option<PathBuf>,
        /// None leaves the screen's colors in use. Some replaces all of them, an omitted entry included.
        colors: Option<TerminalColors>,
        allow_auto_trust: bool,
        reply: oneshot::Sender<ManagedAgent>,
    },
    /// Tells viewers the agent is removed, waits for a checkpoint being written, replies and ends
    /// the actor. The screen folder may go after the reply.
    Remove {
        reply: oneshot::Sender<()>,
    },
    /// Holds the messages of a run's start behind its prompt until [`AgentCommand::StartPrompt`]
    /// and reserves room for the prompt's rendered text.
    /// The ready signal follows settled tools or a live initializer that can use native startup.
    AwaitPrompt {
        text: String,
        ready: oneshot::Sender<()>,
    },
    /// The start prompt of run `run`, typed before every waiting message, or None where none comes.
    StartPrompt {
        run: u64,
        prompt: Option<MessageTyping>,
    },
    /// A newer Facade takes over: stop typing and reading the terminal, write the state's last
    /// facts, and reply once no read is under way, what the last reads brought went through the
    /// screen log, and the queued input is written.
    Quiesce {
        reply: oneshot::Sender<()>,
    },
    /// The run is about to be stopped: the terminal lets go of its copy of what keeps it open, then
    /// replies. Reading, writing and the record go on until the run's exit.
    LetGoBeforeStop {
        reply: oneshot::Sender<()>,
    },
    /// A newer Facade takes over: begin no paste, and reply once a begun paste is settled.
    SettlePaste {
        reply: oneshot::Sender<()>,
    },
    /// Renames the agent, publishes the record, and replies with it.
    Rename {
        name: String,
        reply: oneshot::Sender<ManagedAgent>,
    },
}

/// What an actor starts from.
pub(crate) struct ActorStart {
    pub(crate) info: ManagedAgent,
    /// The terminal; None for an agent whose terminal closed.
    pub(crate) master: Option<PtyMaster>,
    pub(crate) screen: ScreenStart,
    /// A new session whose input cannot contain a draft from an earlier session.
    pub(crate) untouched_input: bool,
    /// The colors its screen replies to color queries with, from the first output on.
    pub(crate) colors: TerminalColors,
    /// The name of the CLI rule the agent was started by.
    pub(crate) rule: Option<String>,
    /// Whether the running CLI reports its session.
    pub(crate) captures: bool,
    pub(crate) launch_command: Option<String>,
    /// Where the typist settles the messages it delivers.
    pub(crate) deliveries: DeliveryHandle,
    /// Recovery just observed the loss of the terminal for this run.
    pub(crate) observed_loss: bool,
    pub(crate) state: StateStart,
}

/// What an agent's state starts from.
pub(crate) struct StateStart {
    /// A configuration file that names a Facade server, for connection diagnostics.
    pub(crate) tools_config: Option<PathBuf>,
    /// The file beside the screen that keeps the state's facts.
    pub(crate) file: PathBuf,
    /// What an earlier daemon kept there.
    pub(crate) kept: Kept,
    /// When the run's process started.
    pub(crate) started: Instant,
}

/// What an agent's screen starts from.
pub(crate) enum ScreenStart {
    /// An empty screen in this folder: its first checkpoint and log are written before any output
    /// is read.
    New(PathBuf),
    /// A recovered screen and its log, unless its files could not be read. `handed_over_cleanly`:
    /// the daemon before this one handed over cleanly, so the log holds every byte it read.
    Recovered {
        screen: Box<Screen>,
        log: Option<ScreenLog>,
        handed_over_cleanly: bool,
        /// The size of an adopted resume, whose replayed screen is cleared before reading output.
        restart_size: Option<(u16, u16)>,
    },
    /// An ended agent with no terminal: the screen stays in its files until something needs it.
    Released,
}

/// Starts the actor of an agent at run [`FIRST_RUN`]. `rx` and `tx` are made before the CLI starts
/// or is recovered, so that an exit sent meanwhile waits for the actor. Trust stays with the person.
pub(crate) fn spawn(
    start: ActorStart,
    rx: mpsc::Receiver<AgentCommand>,
    tx: mpsc::Sender<AgentCommand>,
    changes: broadcast::Sender<AgentsUpdate>,
) -> anyhow::Result<AgentHandle> {
    spawn_with_trust(start, rx, tx, changes, false)
}

/// Starts the actor with the daemon's explicit decision for this run's native trust prompt.
pub(crate) fn spawn_with_trust(
    start: ActorStart,
    rx: mpsc::Receiver<AgentCommand>,
    tx: mpsc::Sender<AgentCommand>,
    changes: broadcast::Sender<AgentsUpdate>,
    allow_auto_trust: bool,
) -> anyhow::Result<AgentHandle> {
    let shared = Arc::new(Shared::new(start.info.clone()));
    let room = Arc::new(Notify::new());
    let (exit_tx, exit) = watch::channel(start.info.exit.clone());
    let (settled_tx, settled) = watch::channel(false);
    let (output_tx, output) = watch::channel(());
    // Followed from before the agent can be found, so no connection of its tools is missed.
    let running = start.info.process == ProcessState::Running && start.info.exit.is_none();
    let (tools_tx, tools_rx) = watch::channel(ToolsConnections::new(FIRST_RUN, running));
    let tools = Arc::new(tools_tx);
    let handle = AgentHandle {
        id: start.info.agent_id.clone(),
        commands: tx,
        shared: shared.clone(),
        room: room.clone(),
        exit,
        settled,
        output,
        rule: start.rule.clone(),
        start_prompt: None,
        run_change: Arc::new(tokio::sync::Mutex::new(())),
        tools: tools.clone(),
    };
    let links = actor::Links {
        shared,
        room,
        exit: exit_tx,
        settled: settled_tx,
        output: output_tx,
        changes,
        tools,
        tools_connections: tools_rx,
    };
    actor::spawn(start, links, rx, allow_auto_trust)?;
    Ok(handle)
}

/// What the actor and its handles share about the agent and its runs.
struct Shared {
    /// A leaf lock: held only for a copy or a field update.
    record: Mutex<Record>,
    /// The run that newly admitted input is for, advanced before its terminal is installed.
    run: AtomicU64,
}

struct Record {
    info: ManagedAgent,
    incident: u64,
    installed_run: u64,
    title: Option<String>,
    observed_end: bool,
}

impl Shared {
    fn new(info: ManagedAgent) -> Self {
        Self {
            record: Mutex::new(Record {
                info,
                incident: 0,
                installed_run: FIRST_RUN,
                title: None,
                observed_end: false,
            }),
            run: AtomicU64::new(FIRST_RUN),
        }
    }
}

/// The way to an agent's actor. A guest's handle has no actor behind it.
#[derive(Clone)]
pub(crate) struct AgentHandle {
    id: String,
    commands: mpsc::Sender<AgentCommand>,
    shared: Arc<Shared>,
    room: Arc<Notify>,
    exit: watch::Receiver<Option<ProcessExit>>,
    settled: watch::Receiver<bool>,
    output: watch::Receiver<()>,
    rule: Option<String>,
    start_prompt: Option<u64>,
    run_change: Arc<tokio::sync::Mutex<()>>,
    tools: Arc<watch::Sender<ToolsConnections>>,
}

impl AgentHandle {
    /// The handle of guest `info`, a session the person started in a terminal that is not
    /// Facade's. No actor answers it: whatever is sent finds the channel closed.
    pub(crate) fn guest(info: ManagedAgent) -> AgentHandle {
        let (commands, _) = mpsc::channel(1);
        AgentHandle {
            id: info.agent_id.clone(),
            commands,
            shared: Arc::new(Shared::new(info)),
            room: Arc::new(Notify::new()),
            exit: watch::channel(None).1,
            settled: watch::channel(false).1,
            output: watch::channel(()).1,
            rule: None,
            start_prompt: None,
            run_change: Arc::new(tokio::sync::Mutex::new(())),
            tools: Arc::new(watch::channel(ToolsConnections::new(FIRST_RUN, false)).0),
        }
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// A copy of the agent's record.
    pub(crate) fn info(&self) -> ManagedAgent {
        self.shared.record.lock().unwrap().info.clone()
    }

    pub(crate) fn prompt_result_facts(&self) -> (ManagedAgent, u64) {
        let record = self.shared.record.lock().unwrap();
        (record.info.clone(), record.incident)
    }

    pub(crate) fn with_start_prompt(mut self, prompt: Option<u64>) -> Self {
        self.start_prompt = prompt;
        self
    }

    /// The prompt the installed run could still owe, if it was the original start.
    pub(crate) fn start_prompt(&self) -> Option<u64> {
        self.start_prompt.filter(|_| self.run() == FIRST_RUN)
    }

    pub(crate) fn observed_exit(&self) -> Option<ManagedAgent> {
        let record = self.shared.record.lock().unwrap();
        record.observed_end.then(|| record.info.clone())
    }

    /// The full title supplied by the terminal, for the caller to project.
    pub(crate) fn title(&self) -> Option<String> {
        self.shared.record.lock().unwrap().title.clone()
    }

    /// The installed run number and record as they stand under the same lock.
    pub(crate) fn installed_record(&self) -> (u64, ManagedAgent) {
        let record = self.shared.record.lock().unwrap();
        (record.installed_run, record.info.clone())
    }

    pub(crate) fn is_guest(&self) -> bool {
        self.shared.record.lock().unwrap().info.guest
    }

    /// The name of the CLI rule the agent was started by.
    pub(crate) fn rule(&self) -> Option<&str> {
        self.rule.as_deref()
    }

    /// The run that input sent now is for.
    pub(crate) fn run(&self) -> u64 {
        self.shared.run.load(Ordering::SeqCst)
    }

    /// The run's exit, once it is known.
    pub(crate) fn exit(&self) -> watch::Receiver<Option<ProcessExit>> {
        self.exit.clone()
    }

    /// Becomes true once viewers were told the exit, after the run's last output.
    pub(crate) fn settled(&self) -> watch::Receiver<bool> {
        self.settled.clone()
    }

    /// Marked changed each time the agent's terminal gives output: its CLI works.
    pub(crate) fn output_seen(&self) -> watch::Receiver<()> {
        self.output.clone()
    }

    /// Fires when input reached the terminal, a size input waited for was applied, or the run
    /// ended: a sender refused for room may try again.
    pub(crate) fn input_room_changed(&self) -> Arc<Notify> {
        self.room.clone()
    }

    /// Waits for the lock that serializes adoption, stop, removal and resume.
    pub(crate) async fn lock_run_change(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.run_change.clone().lock_owned().await
    }

    /// Whether no actor takes commands any more.
    pub(crate) fn is_closed(&self) -> bool {
        self.commands.is_closed()
    }

    /// The actor's command channel, for whoever reports a run's exit to it.
    pub(crate) fn mailbox(&self) -> mpsc::Sender<AgentCommand> {
        self.commands.clone()
    }

    /// Counts one verified connection to the installed run until the guard is dropped.
    pub(crate) fn hold_tools_connection(
        &self,
        run: u64,
        stage: ToolsStage,
    ) -> Option<ToolsConnection> {
        self.tools
            .send_if_modified(|connections| {
                if connections.run != run || !connections.accepting {
                    return false;
                }
                *connections.count(stage) += 1;
                connections.verified = true;
                true
            })
            .then(|| ToolsConnection {
                tools: self.tools.clone(),
                run,
                stage,
            })
    }

    #[cfg(test)]
    pub(crate) fn tools_connected(&self) -> ToolsConnection {
        self.hold_tools_connection(self.run(), ToolsStage::Listed)
            .expect("the test's run accepts tool connections")
    }

    /// Sends `command` to the actor, waiting for room. False where no actor takes it.
    pub(crate) async fn send(&self, command: AgentCommand) -> bool {
        self.commands.send(command).await.is_ok()
    }

    /// Records the committed YOLO setting for a resumed run.
    pub(crate) fn set_yolo(&self, yolo: bool) {
        self.shared.record.lock().unwrap().info.yolo = yolo;
    }

    /// Applies a guest's committed name. A guest has no actor to take the rename command.
    pub(crate) fn rename_guest(&self, name: String) -> ManagedAgent {
        let mut record = self.shared.record.lock().unwrap();
        record.info.name = name;
        record.info.clone()
    }

    /// A guest ended.
    pub(crate) fn mark_ended(&self) {
        self.shared.record.lock().unwrap().info.process = ProcessState::Ended;
    }
}

/// What the agent's CLI has completed with the Facade server.
#[derive(Clone, Copy)]
pub(crate) enum ToolsStage {
    Initialized,
    Listed,
}

#[derive(Clone, Copy)]
struct ToolsConnections {
    run: u64,
    /// Only a live, installed run accepts new leases.
    accepting: bool,
    initialized: usize,
    listed: usize,
    /// Keeps proof of a connection even if it closed before the actor read the watch.
    verified: bool,
}

impl ToolsConnections {
    fn new(run: u64, accepting: bool) -> Self {
        Self {
            run,
            accepting,
            initialized: 0,
            listed: 0,
            verified: false,
        }
    }

    fn count(&mut self, stage: ToolsStage) -> &mut usize {
        match stage {
            ToolsStage::Initialized => &mut self.initialized,
            ToolsStage::Listed => &mut self.listed,
        }
    }
}

/// One open connection at a verified stage of an agent's run.
pub(crate) struct ToolsConnection {
    tools: Arc<watch::Sender<ToolsConnections>>,
    run: u64,
    stage: ToolsStage,
}

impl Drop for ToolsConnection {
    fn drop(&mut self) {
        self.tools.send_if_modified(|connections| {
            if connections.run != self.run {
                return false;
            }
            *connections.count(self.stage) -= 1;
            true
        });
    }
}

/// `framework/screens/`: one folder per agent, made and deleted here.
pub(crate) struct Screens {
    folder: PathBuf,
}

impl Screens {
    pub(crate) fn new(folder: PathBuf) -> Screens {
        Screens { folder }
    }

    /// The folder of agent `id`'s screen.
    pub(crate) fn folder(&self, id: &str) -> PathBuf {
        self.folder.join(id)
    }

    /// Deletes agent `id`'s screen folder; one already gone is fine. Blocks.
    pub(crate) fn remove(&self, id: &str) -> std::io::Result<()> {
        match std::fs::remove_dir_all(self.folder(id)) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }

    /// Deletes the screen folders of agents not in `kept`, as recovery finds them. Blocks.
    pub(crate) fn delete_without_records(&self, kept: &HashSet<String>) {
        let entries = match std::fs::read_dir(&self.folder) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(err) => return warn_screens(&self.folder.display().to_string(), &err),
        };
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if kept.contains(&id) {
                continue;
            }
            facade_base::log::write(
                "daemon",
                "info",
                &format!("deleting the screen folder of {id}: it has no agent record"),
            );
            if let Err(err) = std::fs::remove_dir_all(entry.path()) {
                warn_screens(&id, &err);
            }
        }
    }
}

fn warn_screens(what: &str, err: &std::io::Error) {
    facade_base::log::write(
        "daemon",
        "warn",
        &format!("could not clean up the screen folders at {what}: {err}"),
    );
}
