//! An agent: one actor task that owns its terminal, screen, state, typist, viewers and the start of
//! each run, and the handle the rest of the daemon reaches it through.
//!
//! The actor answers commands before it reads more output, and reads at most 64 KiB at a time.
//! Output goes into the screen log before the screen parses it. Each run of the CLI has a number:
//! input and exits name the run they are meant for, so nothing meant for an ended run reaches the
//! run that resumes the agent in the same terminal.
//!
//! The parts the actor owns never call one another; `actor.rs` passes what one learns to the next.

mod actor;
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

use facade_base::daemon::{AgentInfo, AgentsUpdate, InputInfo};
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::terminal::PtyMaster;
use facade_screen::{Screen, TerminalColors};
use tokio::sync::{Notify, broadcast, mpsc, oneshot, watch};
use tokio::time::Instant;

use crate::messages::DeliveryHandle;
use crate::{Sender, ToolsGiven};

pub(crate) use screen::{ScreenLog, recover, recover_after_clean_end, saved_size, screen_writes};
pub(crate) use state::{Kept, instant_of, read_kept, state_file};
pub(crate) use typist::{MessageTyping, Typing, TypingAnswer};
pub(crate) use viewers::{ViewerChange, ViewerSender, ViewerSnapshot, viewer_channel};

/// Rows of scrollback each agent's screen keeps.
pub(crate) const SCROLLBACK_ROWS: usize = 10_000;
/// The most bytes of input that may wait for an agent's terminal.
pub(crate) const MAX_INPUT_BYTES: usize = 1024 * 1024;
/// The room of an agent's command channel.
pub(crate) const MAX_QUEUED_COMMANDS: usize = 1024;
/// The number of an agent's first run.
pub(crate) const FIRST_RUN: u64 = 1;

/// What a terminal sends before and after a bracketed paste.
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
/// The pause after an Escape, so that the CLI does not read it with the next key as Alt.
const ESCAPE_DELAY: Duration = Duration::from_millis(50);
/// How long a run's start may take before its CLI should show its input.
const START_TIMEOUT: Duration = Duration::from_secs(60);

// The screen log sizes its largest record by what one feed takes; a read never brings more.
const _: () = assert!(terminal::MAX_READ_BYTES <= screen::MAX_FEED_BYTES);

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
    /// Text or keys from a program, which the typist types in turn.
    Typed(Typing),
    /// A message for the typist to deliver into the CLI's input.
    Message(MessageTyping),
    /// The messages of a paste an earlier daemon began, in their order: the typist finishes it
    /// without typing it again.
    BegunPaste(Vec<MessageTyping>),
}

impl Input {
    /// The most bytes this input writes into the terminal.
    pub(crate) fn most_bytes(&self) -> usize {
        match self {
            Input::Raw(keys) => keys.len(),
            Input::Typed(typing) => typing.most_bytes(),
            Input::Message(message) => message.most_bytes(),
            // What is left of a begun paste is its Enter.
            Input::BegunPaste(_) => 1,
        }
    }
}

/// An agent's record, its input as its rule reads the screen now, and whether its session is
/// followed, taken at one moment.
pub(crate) struct Inspection {
    pub(crate) agent: AgentInfo,
    pub(crate) input: InputInfo,
    pub(crate) session_tracking: bool,
    pub(crate) viewers: Vec<String>,
    pub(crate) title: Option<String>,
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
    Resize(u16, u16),
    /// Resizes the terminal and applies colors already authorized by the service.
    ResizeTerminal {
        cols: u16,
        rows: u16,
        colors: Option<TerminalColors>,
    },
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
        tx: ViewerSender,
        keep_scrollback: bool,
        include_scrollback: bool,
        reply: oneshot::Sender<ViewerSnapshot>,
    },
    RemoveViewer {
        viewer: u64,
    },
    ReadScreen {
        lines: usize,
        reply: oneshot::Sender<facade_screen::Reading>,
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
    },
    /// The session the CLI reported, already committed; the record shows it from now on.
    RecordSession(Option<String>),
    /// Readies the screen for run `run` of an ended agent: input for earlier runs is refused from
    /// now on, the ended run's terminal is let go, viewers get its end, and the screen gets a fresh
    /// terminal's modes at the new size, all through the screen log. Replies when done.
    PrepareRestart {
        run: u64,
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<()>,
    },
    /// Installs run `run`'s terminal once its process and cleared exit are committed, and replies
    /// with the running record. A run that ended meanwhile then ends at once.
    InstallRun {
        run: u64,
        master: PtyMaster,
        pid: u32,
        captures: bool,
        /// The CLI's version as its installation names it.
        version: Option<String>,
        tools: ToolsGiven,
        reply: oneshot::Sender<AgentInfo>,
    },
    /// Tells viewers the agent is removed, waits for a checkpoint being written, replies and ends
    /// the actor. The screen folder may go after the reply.
    Remove {
        reply: oneshot::Sender<()>,
    },
    /// Holds the messages of a run's start behind its prompt until [`AgentCommand::StartPrompt`].
    /// `ready` is told once the start settled: its CLI's tools connected or will not.
    AwaitPrompt {
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
        reply: oneshot::Sender<AgentInfo>,
    },
}

/// What an actor starts from.
pub(crate) struct ActorStart {
    pub(crate) info: AgentInfo,
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
    /// Where the typist settles the messages it delivers.
    pub(crate) deliveries: DeliveryHandle,
    pub(crate) state: StateStart,
}

/// What an agent's state starts from.
pub(crate) struct StateStart {
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
    },
    /// An ended agent with no terminal: the screen stays in its files until something needs it.
    Released,
}

/// Starts the actor of an agent at run [`FIRST_RUN`]. `rx` and `tx` are made before the CLI starts
/// or is recovered, so that an exit sent meanwhile waits for the actor.
pub(crate) fn spawn(
    start: ActorStart,
    rx: mpsc::Receiver<AgentCommand>,
    tx: mpsc::Sender<AgentCommand>,
    changes: broadcast::Sender<AgentsUpdate>,
) -> anyhow::Result<AgentHandle> {
    let shared = Arc::new(Shared::new(start.info.clone()));
    let room = Arc::new(Notify::new());
    let (exit_tx, exit) = watch::channel(start.info.exit.clone());
    let (settled_tx, settled) = watch::channel(false);
    let (output_tx, output) = watch::channel(());
    // Followed from before the agent can be found, so no connection of its tools is missed.
    let (tools_tx, tools_rx) = watch::channel(0);
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
        _tools: tools,
        tools_connections: tools_rx,
    };
    actor::spawn(start, links, rx)?;
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
    info: AgentInfo,
    installed_run: u64,
    title: Option<String>,
}

impl Shared {
    fn new(info: AgentInfo) -> Self {
        Self {
            record: Mutex::new(Record {
                info,
                installed_run: FIRST_RUN,
                title: None,
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
    run_change: Arc<tokio::sync::Mutex<()>>,
    tools: Arc<watch::Sender<usize>>,
}

impl AgentHandle {
    /// The handle of guest `info`, a session the person started in a terminal that is not
    /// Facade's. No actor answers it: whatever is sent finds the channel closed.
    pub(crate) fn guest(info: AgentInfo) -> AgentHandle {
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
            run_change: Arc::new(tokio::sync::Mutex::new(())),
            tools: Arc::new(watch::channel(0).0),
        }
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// A copy of the agent's record.
    pub(crate) fn info(&self) -> AgentInfo {
        self.shared.record.lock().unwrap().info.clone()
    }

    /// The full title supplied by the terminal, for the caller to project.
    pub(crate) fn title(&self) -> Option<String> {
        self.shared.record.lock().unwrap().title.clone()
    }

    /// The installed run number and record as they stand under the same lock.
    pub(crate) fn installed_record(&self) -> (u64, AgentInfo) {
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

    /// Counts one open connection of the agent's Facade server, until the result is dropped:
    /// while one is open, its tools are there.
    pub(crate) fn tools_connected(&self) -> ToolsConnection {
        self.tools.send_modify(|open| *open += 1);
        ToolsConnection(self.tools.clone())
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
    pub(crate) fn rename_guest(&self, name: String) -> AgentInfo {
        let mut record = self.shared.record.lock().unwrap();
        record.info.name = name;
        record.info.clone()
    }

    /// A guest ended.
    pub(crate) fn mark_ended(&self) {
        self.shared.record.lock().unwrap().info.process = ProcessState::Ended;
    }
}

/// One open connection of an agent's Facade server; dropping it closes it.
pub(crate) struct ToolsConnection(Arc<watch::Sender<usize>>);

impl Drop for ToolsConnection {
    fn drop(&mut self) {
        self.0.send_modify(|open| *open -= 1);
    }
}

/// `core/screens/`: one folder per agent, made and deleted here.
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
