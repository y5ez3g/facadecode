//! The actor task: it owns the terminal, the logged screen, the state, the typist, the viewers and
//! the start of each run, and passes what one of them learns to the others. None of them calls
//! another.
//!
//! The record is shared with the handles under a leaf lock. Only the actor changes it once it runs,
//! and only here are changes published: at once for a start, an exit, a rename and a CLI that waits
//! for the person or reports an error, otherwise batched.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use facade_base::daemon::{
    AgentState, AgentsChange, DEFAULT_TERMINAL_SIZE, InputInfo, InputState, ToolsState,
};
use facade_base::process::{ProcessExit, ProcessState};
use facade_rules::{InputRule, Rule};
use facade_screen::{ParsedOutput, TerminalColors};
use tokio::sync::{Notify, broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::person::{ENTER_DRAWN_AFTER, ENTER_READ_AGAIN, PersonKeys, Submitting};
use super::readiness::{Press, Readiness, StartView};
use super::screen::LoggedScreen;
use super::state::{Kept, StateTracker, Viewing, keep};
use super::terminal::{Terminal, TerminalEvent, TerminalWait};
use super::typist::{Modes, Reading, Typing, Typist};
use super::viewers::{ViewerRequest, Viewers};
use super::{
    ActorStart, AgentCommand, FIRST_RUN, Input, InputRejection, Inspection, MAX_INPUT_BYTES,
    ScreenStart, Shared, Submission,
};
use crate::{Sender, gate_for_test, pause_for_test};

/// How long size, title and state changes wait to go out together.
const PUBLISH_DELAY: Duration = Duration::from_millis(200);
/// How often viewers behind are looked at for room, though the CLI writes nothing.
const CATCH_UP_INTERVAL: Duration = Duration::from_millis(50);
/// The most output read at once from a terminal nobody read: before removal, and after recovery.
const MAX_DRAIN_BYTES: usize = 4 * 1024 * 1024;
/// How long a run's last output may take to arrive once its exit is known.
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
/// After recovery the terminal is one column narrower for this long, or until the CLI writes, so
/// that the CLI draws its screen again.
const REDRAW_NUDGE_TIMEOUT: Duration = Duration::from_millis(200);
/// How long output settles before the screen is read for the CLI's status.
const SCREEN_STATUS_DELAY: Duration = Duration::from_millis(200);

/// The batching delay, which a debug build lets a test set through `FACADE_TEST_PUBLISH_AFTER_MS`.
fn publish_delay() -> Duration {
    #[cfg(debug_assertions)]
    {
        static SET: std::sync::LazyLock<Option<Duration>> = std::sync::LazyLock::new(|| {
            std::env::var("FACADE_TEST_PUBLISH_AFTER_MS")
                .ok()
                .and_then(|ms| ms.parse().ok())
                .map(Duration::from_millis)
        });
        if let Some(set) = *SET {
            return set;
        }
    }
    PUBLISH_DELAY
}

fn log(level: &str, message: &str) {
    facade_base::log::write("daemon", level, message);
}

/// What the actor shares with the agent's handles.
pub(super) struct Links {
    pub(super) shared: Arc<Shared>,
    pub(super) room: Arc<Notify>,
    pub(super) exit: watch::Sender<Option<ProcessExit>>,
    pub(super) settled: watch::Sender<bool>,
    /// Marked at each output, for whoever follows the CLI's work, such as its session.
    pub(super) output: watch::Sender<()>,
    pub(super) changes: broadcast::Sender<AgentsChange>,
    /// Keeps the tools channel open while the actor runs.
    pub(super) _tools: Arc<watch::Sender<usize>>,
    pub(super) tools_connections: watch::Receiver<usize>,
}

/// Builds the actor from `start` and runs it on its own task.
pub(super) fn spawn(
    start: ActorStart,
    links: Links,
    commands: mpsc::Receiver<AgentCommand>,
) -> anyhow::Result<()> {
    let ActorStart {
        info,
        master,
        screen,
        colors,
        rule,
        captures,
        deliveries,
        state,
    } = start;
    // The agent reads its CLI by the rule this build has under the rule's name.
    let rule: Option<&'static Rule> = rule
        .as_deref()
        .and_then(|name| facade_rules::find(name).ok().flatten());
    let recovered = !matches!(screen, ScreenStart::New(_));
    let mut tracker = {
        let replayed = match &screen {
            ScreenStart::Recovered { screen, .. } => Some(screen.as_ref()),
            _ => None,
        };
        StateTracker::new(
            rule,
            state.started,
            state.kept,
            info.exit.as_ref(),
            replayed,
        )
    };
    if recovered {
        tracker.recovered(Instant::now());
    }
    let terminal = Terminal::new(master)?;
    let mut actor = Actor {
        id: info.agent_id.clone(),
        links,
        terminal,
        screen: None,
        screen_start: Some(screen),
        state: tracker,
        facts: state.file,
        kept: None,
        keeping: None,
        state_changed: false,
        state_at: Some(Instant::now()),
        screen_status_at: None,
        typist: Typist::new(
            rule.map(|rule| &rule.paste),
            rule.and_then(facade_rules::console_typing),
            deliveries,
        ),
        viewers: Viewers::new(),
        readiness: Readiness::new(rule, &info.agent_id),
        ready_at: None,
        person: PersonKeys::default(),
        submitting: None,
        held: VecDeque::new(),
        input_rule: rule.map(|rule| &rule.input),
        captures,
        undrawn: None,
        process: info.process,
        exit: info.exit.clone(),
        exit_sent: false,
        drain_deadline: None,
        run: FIRST_RUN,
        next_run: None,
        early_exit: None,
        pending_size: None,
        pending_restart: None,
        awaits_prompt: false,
        prompt_ready: None,
        quiet: false,
        quieting: None,
        settling: None,
        drawn_at: None,
        nudge_until: None,
        catch_up_at: None,
        publish_at: None,
        typist_at: None,
        replies_dropped: false,
    };
    // The record shows the state from the start.
    actor.record_state();
    // Read once more as the task begins.
    actor.state_at = Some(Instant::now());
    let yolo = info.yolo;
    tokio::spawn(actor.run(commands, recovered, yolo, colors));
    Ok(())
}

struct Actor {
    id: String,
    links: Links,
    terminal: Terminal,
    /// The screen, from once the actor task began.
    screen: Option<LoggedScreen>,
    /// What the screen starts from, taken as the task begins.
    screen_start: Option<ScreenStart>,
    state: StateTracker,
    /// The file beside the screen that keeps the state's facts.
    facts: PathBuf,
    /// Hands changed facts to the task that keeps them; None while quiet or once removed.
    kept: Option<watch::Sender<Kept>>,
    keeping: Option<JoinHandle<()>>,
    /// Something the state rests on changed since the record last took it.
    state_changed: bool,
    /// When to read the state again though nothing changed.
    state_at: Option<Instant>,
    /// When to read the CLI's screen for its status.
    screen_status_at: Option<Instant>,
    typist: Typist,
    viewers: Viewers,
    readiness: Readiness,
    ready_at: Option<Instant>,
    person: PersonKeys,
    submitting: Option<Submitting>,
    /// Keys and calls that came while the start readies the tools, in their order.
    held: VecDeque<Input>,
    input_rule: Option<&'static InputRule>,
    /// Whether the running CLI reports its session.
    captures: bool,
    /// Why the screen may not show the CLI's input yet; cleared once the CLI writes.
    undrawn: Option<&'static str>,
    /// The process state viewers' snapshots carry.
    process: ProcessState,
    exit: Option<ProcessExit>,
    exit_sent: bool,
    /// When to tell viewers the exit though the run's output has not all been read.
    drain_deadline: Option<Instant>,
    run: u64,
    /// While a resume starts its CLI: its run, and its exit if it came before its terminal.
    next_run: Option<u64>,
    early_exit: Option<(ProcessExit, bool)>,
    /// A size waiting for a full log's checkpoint writer; input waits until it is applied.
    pending_size: Option<(u16, u16)>,
    /// A restart waiting for a full log's checkpoint writer.
    pending_restart: Option<(u16, u16, oneshot::Sender<()>)>,
    /// Messages wait behind the run's start prompt until it comes.
    awaits_prompt: bool,
    prompt_ready: Option<oneshot::Sender<()>>,
    /// A newer Facade takes over: no reading, no typing.
    quiet: bool,
    quieting: Option<oneshot::Sender<()>>,
    settling: Option<oneshot::Sender<()>>,
    /// When the CLI last drew.
    drawn_at: Option<Instant>,
    nudge_until: Option<Instant>,
    catch_up_at: Option<Instant>,
    publish_at: Option<Instant>,
    typist_at: Option<Instant>,
    /// Dropped terminal-query replies were logged.
    replies_dropped: bool,
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

impl Actor {
    fn screen(&self) -> &LoggedScreen {
        self.screen
            .as_ref()
            .expect("the screen exists while the actor runs")
    }

    fn screen_mut(&mut self) -> &mut LoggedScreen {
        self.screen
            .as_mut()
            .expect("the screen exists while the actor runs")
    }

    /// The run ended, or a resume began: the CLI's screen says nothing of the current run.
    fn ended(&self) -> bool {
        self.exit.is_some() || self.next_run.is_some()
    }

    fn publish(&self) {
        let agent = self.links.shared.info.lock().unwrap().clone();
        let _ = self.links.changes.send(AgentsChange::Updated {
            agent: Box::new(agent),
        });
    }

    fn publish_soon(&mut self) {
        self.publish_at
            .get_or_insert_with(|| Instant::now() + publish_delay());
    }

    fn publish_now(&mut self) {
        self.publish_at = None;
        self.publish();
    }

    async fn run(
        mut self,
        mut commands: mpsc::Receiver<AgentCommand>,
        recovered: bool,
        yolo: bool,
        colors: TerminalColors,
    ) {
        self.begin(recovered, yolo, colors).await;
        loop {
            if !self.typist.pasting()
                && let Some(reply) = self.settling.take()
            {
                let _ = reply.send(());
            }
            let full = self.screen().is_full();
            let sync_at = self
                .screen()
                .screen()
                .synchronized_update_deadline()
                .map(Instant::from_std);
            let enter_at = self.enter_wake();
            let wait = if !self.terminal.is_closed() && !full && !self.quiet {
                TerminalWait::ReadAndWrite
            } else {
                TerminalWait::WriteOnly
            };
            let writing = self.screen().checkpoint_running();
            let screen = self
                .screen
                .as_mut()
                .expect("the screen exists while the actor runs");
            tokio::select! {
                biased;
                command = commands.recv() => {
                    let Some(command) = command else { break };
                    if !self.take_command(command).await {
                        break;
                    }
                }
                event = self.terminal.ready(wait) => self.take_terminal(event),
                Ok(()) = self.links.tools_connections.changed() => {
                    let open = *self.links.tools_connections.borrow_and_update() > 0;
                    self.state.tools_connection(open);
                    self.state_changed = true;
                }
                _ = sleep_until(self.typist_at), if self.typist_at.is_some() => self.type_next(),
                // The start's steps read the screen, which a quiet agent reads no more.
                _ = sleep_until(self.ready_at), if self.ready_at.is_some() && !self.quiet => {
                    self.step_start();
                    self.type_next();
                }
                written = screen.checkpoint_written(), if writing => {
                    self.screen_mut().finish_checkpoint(written);
                    self.after_checkpoint();
                }
                _ = sleep_until(sync_at), if sync_at.is_some() && !full => self.end_sync(),
                _ = sleep_until(self.nudge_until), if self.nudge_until.is_some() => {
                    self.end_nudge();
                }
                _ = sleep_until(self.drain_deadline), if self.drain_deadline.is_some() => {
                    self.send_exit();
                }
                _ = sleep_until(self.publish_at), if self.publish_at.is_some() => self.publish_now(),
                _ = sleep_until(self.catch_up_at), if self.catch_up_at.is_some() => self.catch_up(),
                _ = sleep_until(self.screen_status_at), if self.screen_status_at.is_some() => {
                    self.read_screen_status();
                }
                _ = sleep_until(self.state_at), if self.state_at.is_some() => {
                    self.state_changed = true;
                }
                _ = sleep_until(enter_at), if enter_at.is_some() => self.follow_enter(),
            }
            self.end_turn().await;
        }
    }

    /// What every turn of the loop ends with: the state into the record, the start prompt told the
    /// start settled, and an unneeded screen let go.
    async fn end_turn(&mut self) {
        if self.state_changed {
            match self.record_state() {
                Some(true) => self.publish_now(),
                Some(false) => self.publish_soon(),
                None => {}
            }
        }
        if self.prompt_ready.is_some()
            && self.links.shared.info.lock().unwrap().tools_state != ToolsState::Connecting
            && let Some(ready) = self.prompt_ready.take()
        {
            let _ = ready.send(());
        }
        if self.screen_unneeded() {
            self.screen_mut().let_go().await;
        }
    }

    /// Sets the screen up, starts keeping the state's facts, and takes up a run that is under way.
    async fn begin(&mut self, recovered: bool, yolo: bool, colors: TerminalColors) {
        let (cols, rows) = {
            let info = self.links.shared.info.lock().unwrap();
            (
                info.cols.unwrap_or(DEFAULT_TERMINAL_SIZE.0),
                info.rows.unwrap_or(DEFAULT_TERMINAL_SIZE.1),
            )
        };
        let folder = self.facts.parent().map(PathBuf::from).unwrap_or_default();
        let mut handed_over = false;
        let mut screen = match self.screen_start.take().expect("the screen starts once") {
            ScreenStart::New(folder) => LoggedScreen::create(folder, &self.id, cols, rows).await,
            ScreenStart::Recovered {
                screen,
                log,
                handed_over_cleanly,
            } => {
                handed_over = handed_over_cleanly;
                LoggedScreen::recovered(folder, &self.id, *screen, log)
            }
            ScreenStart::Released => LoggedScreen::released(folder, &self.id),
        };
        screen.set_colors(colors);
        self.screen = Some(screen);
        // The screen folder exists now; the facts are kept there.
        self.start_keeping();
        self.undrawn = match (recovered, handed_over) {
            (true, true) => None,
            (true, false) => Some("the CLI has not written since Facade recovered it"),
            (false, _) => Some("the CLI has not written yet"),
        };
        // A new run readies its tools and answers its trust question; a recovered one is under way.
        if !recovered && self.exit.is_none() {
            self.ready_at =
                self.readiness
                    .begin(self.state.started(), self.state.tools_given(), yolo);
        }
        // An agent recovered without a terminal has no output left to drain.
        if self.exit.is_some() && !self.terminal.is_open() {
            self.exit_sent = true;
            self.links.settled.send_replace(true);
        }
        if self.exit.is_some() && self.terminal.is_open() {
            // It ended while no daemon read its terminal: its last output, then viewers are told.
            self.drain_deadline = Some(Instant::now() + OUTPUT_DRAIN_TIMEOUT);
        }
        if !recovered || !self.terminal.is_open() {
            return;
        }
        let (cols, rows) = self.size();
        // The last logged size; this also undoes a redraw nudge a failed daemon left.
        self.terminal.set_size(cols, rows);
        if self.process != ProcessState::Running {
            return;
        }
        self.read_unread_output();
        // Its output may have changed the title since clients took their snapshots.
        self.publish();
        if handed_over {
            // The log is whole: the screen says now what the CLI shows of its status.
            self.screen_status_at = Some(Instant::now());
        } else {
            self.terminal.set_size(cols.saturating_sub(1).max(1), rows);
            pause_for_test("inside-nudge");
            self.nudge_until = Some(Instant::now() + REDRAW_NUDGE_TIMEOUT);
        }
    }

    fn size(&self) -> (u16, u16) {
        let screen = self.screen().screen();
        (screen.cols(), screen.rows())
    }

    fn start_keeping(&mut self) {
        let (kept, changes) = watch::channel(self.state.kept());
        self.kept = Some(kept);
        self.keeping = Some(tokio::spawn(keep(self.facts.clone(), changes)));
    }

    /// Ends the task keeping the facts once it wrote the last of them.
    async fn stop_keeping(&mut self) {
        drop(self.kept.take());
        if let Some(keeping) = self.keeping.take() {
            let _ = keeping.await;
        }
    }

    /// Answers one command. False once the actor is done.
    async fn take_command(&mut self, command: AgentCommand) -> bool {
        match command {
            AgentCommand::WriteInput { input, run, reply } => {
                let _ = reply.send(self.take_input(input, run));
            }
            AgentCommand::Resize(cols, rows) => self.take_size(cols, rows),
            AgentCommand::SetColors(colors) => self.screen_mut().set_colors(colors),
            AgentCommand::AddViewer {
                viewer,
                tx,
                keep_scrollback,
                include_scrollback,
                reply,
            } => {
                // A screen that cannot be read back gives no snapshot: the watch fails.
                if self.screen_mut().hold().await {
                    self.viewers.request(ViewerRequest {
                        viewer,
                        tx,
                        keep_scrollback,
                        include_scrollback,
                        reply,
                    });
                    self.admit_viewers();
                    self.state.seen();
                    self.state_changed = true;
                }
            }
            AgentCommand::RemoveViewer { viewer } => self.viewers.remove(viewer),
            AgentCommand::ReadScreen { lines, reply } => {
                if self.screen_mut().hold().await {
                    let _ = reply.send(self.screen().screen().read(lines));
                }
            }
            AgentCommand::Inspect { reply } => {
                let _ = reply.send(Inspection {
                    agent: self.links.shared.info.lock().unwrap().clone(),
                    input: self.read_draft().0,
                    session_tracking: self.captures && !self.ended(),
                });
            }
            AgentCommand::ProcessExited { run, exit, stopped } => {
                gate_for_test("before-exit-reaches-agent");
                if self.next_run == Some(run) {
                    self.early_exit.get_or_insert((exit, stopped));
                } else if run == self.run && self.exit.is_none() {
                    self.end_run(exit, stopped);
                }
            }
            AgentCommand::RecordSession(session) => {
                let changed = {
                    let mut info = self.links.shared.info.lock().unwrap();
                    std::mem::replace(&mut info.session, session.clone()) != session
                };
                if changed {
                    self.publish();
                }
            }
            AgentCommand::PrepareRestart {
                run,
                cols,
                rows,
                reply,
            } => self.prepare_restart(run, cols, rows, reply).await,
            AgentCommand::InstallRun {
                run,
                master,
                pid,
                captures,
                version,
                tools,
                reply,
            } => {
                if self.next_run != Some(run) {
                    return true;
                }
                if let Err(err) = self.terminal.install(master) {
                    log(
                        "warn",
                        &format!("could not read the resumed terminal of {}: {err}", self.id),
                    );
                    return true;
                }
                let (cols, rows) = self.size();
                self.terminal.set_size(cols, rows);
                self.next_run = None;
                (self.exit, self.exit_sent, self.drain_deadline) = (None, false, None);
                self.process = ProcessState::Running;
                self.captures = captures;
                self.undrawn = Some("the CLI has not written since it resumed");
                self.links.settled.send_replace(false);
                let _ = self.links.exit.send(None);
                self.state.restarted(Instant::now(), version, tools);
                let yolo = self.links.shared.info.lock().unwrap().yolo;
                self.ready_at =
                    self.readiness
                        .begin(self.state.started(), self.state.tools_given(), yolo);
                self.record_state();
                let record = {
                    let mut info = self.links.shared.info.lock().unwrap();
                    info.pid = Some(pid);
                    info.process = ProcessState::Running;
                    info.exit = None;
                    info.clone()
                };
                self.publish_now();
                let _ = reply.send(record);
                if let Some((exit, stopped)) = self.early_exit.take() {
                    self.end_run(exit, stopped);
                }
            }
            AgentCommand::Remove { reply } => {
                self.drain_for_removal();
                self.send_exit();
                let exit = self.exit.clone();
                let screen = self
                    .screen
                    .as_mut()
                    .expect("the screen exists while the actor runs");
                self.viewers.finish(screen.screen(), exit.as_ref());
                screen.finish().await;
                // The last facts are written before the screen folder goes.
                self.stop_keeping().await;
                let _ = reply.send(());
                return false;
            }
            AgentCommand::Quiesce { reply } => {
                gate_for_test("agent-quiesce");
                (self.quiet, self.typist_at) = (true, None);
                // It reads no more, so the person's keys go as they come.
                self.let_enter_go();
                // No read is under way once it replies, and what the last reads brought went
                // through the screen log, so the next daemon reads on from there.
                while self.terminal.stop_reading().await.is_some() {
                    self.take_output();
                }
                // The last facts are written before the next daemon reads them.
                self.stop_keeping().await;
                if self.terminal.queued() == 0 {
                    let _ = reply.send(());
                } else {
                    self.quieting = Some(reply);
                }
            }
            AgentCommand::LetGoBeforeStop { reply } => {
                self.terminal.let_go_before_stop();
                let _ = reply.send(());
            }
            AgentCommand::SettlePaste { reply } => {
                self.typist.hold_pastes();
                self.settling = Some(reply);
            }
            AgentCommand::Rename { name, reply } => {
                self.links.shared.info.lock().unwrap().name = name;
                self.publish();
                let _ = reply.send(self.links.shared.info.lock().unwrap().clone());
            }
            // A run that ended takes no prompt: dropping `ready` says so.
            AgentCommand::AwaitPrompt { ready } => {
                if !self.ended() {
                    (self.awaits_prompt, self.prompt_ready) = (true, Some(ready));
                }
            }
            AgentCommand::StartPrompt { run, prompt } => {
                self.awaits_prompt = false;
                if let Some(prompt) = prompt {
                    if run != self.run || self.exit.is_some() || !self.terminal.is_open() {
                        self.typist.fail_ended(prompt);
                    } else {
                        self.typist.deliver_first(prompt);
                    }
                }
                self.type_next();
            }
        }
        true
    }

    /// Takes input for run `run`, or says why not.
    fn take_input(&mut self, input: Input, run: u64) -> Result<(), InputRejection> {
        if run != self.run || self.exit.is_some() || !self.terminal.is_open() {
            return Err(InputRejection::AgentExited);
        }
        // Input sent after a resize must not reach the CLI before the new size.
        if self.pending_size.is_some() || input.most_bytes() > self.room() {
            facade_base::service::mark_for_test("input-without-room");
            return Err(InputRejection::Backpressured(input));
        }
        let holds = matches!(input, Input::Raw(_) | Input::Typed(_)) && self.start_holds_input();
        if holds {
            // The start readies the tools: other keys and calls wait, the person's too.
            self.held.push_back(input);
            return Ok(());
        }
        match input {
            Input::Raw(keys) => {
                self.take_keys(keys);
                if self.quiet {
                    self.let_enter_go();
                }
            }
            typed => {
                self.give_typist(typed);
                self.type_next();
            }
        }
        Ok(())
    }

    /// Hands a call or a message to the typist; keys are not its.
    fn give_typist(&mut self, input: Input) {
        match input {
            Input::Typed(typing) => self.typist.push(typing),
            Input::Message(message) => self.typist.deliver(message),
            Input::BegunPaste(messages) => self.typist.finish_paste(messages),
            Input::Raw(_) => {}
        }
    }

    /// The room left for input: the terminal's queue, and what the typist, the person's Enter and
    /// the start hold.
    fn room(&self) -> usize {
        let enter = self.submitting.as_ref().map_or(0, Submitting::held_bytes);
        let held: usize = self.held.iter().map(Input::most_bytes).sum();
        let used = self.terminal.queued() + self.typist.held_bytes() + enter + held;
        MAX_INPUT_BYTES.saturating_sub(used)
    }

    /// Queues the CLI's replies to terminal queries, dropping a batch that does not fit.
    fn queue_replies(&mut self, replies: Vec<u8>) {
        if replies.is_empty() || self.exit.is_some() {
            return;
        }
        if replies.len() <= self.room() {
            self.terminal.push(&replies);
        } else if !self.replies_dropped {
            self.replies_dropped = true;
            log(
                "warn",
                "waiting input is full; terminal-query replies are being dropped",
            );
        }
    }

    /// Size requested by a client. An agent without a terminal keeps its last screen.
    fn take_size(&mut self, cols: u16, rows: u16) {
        if !self.terminal.is_open() {
            return;
        }
        if self.screen().is_full() {
            // The size waits for the checkpoint writer; the terminal leaves any nudge meanwhile.
            if self.nudge_until.take().is_some() {
                let (now_cols, now_rows) = self.size();
                self.terminal.set_size(now_cols, now_rows);
            }
            self.pending_size = Some((cols, rows));
            return;
        }
        self.nudge_until = None;
        if self.resize(cols, rows) {
            self.publish_soon();
            self.catch_up_at = Some(Instant::now());
        }
    }

    /// Logs and applies a size to the screen, then to the terminal. Answers whether the record's
    /// size changed, which redraws viewers.
    fn resize(&mut self, cols: u16, rows: u16) -> bool {
        if (cols, rows) != self.size() {
            self.screen_mut().checkpoint_if_due();
        }
        self.screen_mut().resize(cols, rows);
        self.terminal.set_size(cols, rows);
        {
            let mut info = self.links.shared.info.lock().unwrap();
            if (info.cols, info.rows) == (Some(cols), Some(rows)) {
                return false;
            }
            (info.cols, info.rows) = (Some(cols), Some(rows));
        }
        self.viewers.redraw_all();
        true
    }

    /// The checkpoint writer finished: a size or a restart that waited for room goes now.
    fn after_checkpoint(&mut self) {
        if self.screen().is_full() {
            return;
        }
        if let Some((cols, rows)) = self.pending_size.take()
            && self.terminal.is_open()
        {
            if self.resize(cols, rows) {
                self.publish_soon();
                self.catch_up_at = Some(Instant::now());
            }
            self.links.room.notify_waiters();
        }
        if let Some((cols, rows, reply)) = self.pending_restart.take() {
            self.restart_screen(cols, rows);
            self.catch_up_at = Some(Instant::now());
            let _ = reply.send(());
        }
    }

    /// What the terminal did.
    fn take_terminal(&mut self, event: TerminalEvent) {
        match event {
            TerminalEvent::Read => self.take_output(),
            TerminalEvent::Closed => {
                // The CLI's side closed: a known exit goes to viewers now.
                if self.drain_deadline.is_some() {
                    self.send_exit();
                }
            }
            TerminalEvent::Wrote => {
                self.links.room.notify_waiters();
                if self.typist.busy() {
                    self.type_next();
                }
                if self.terminal.queued() == 0
                    && let Some(reply) = self.quieting.take()
                {
                    let _ = reply.send(());
                }
            }
            TerminalEvent::WriteFailed(err) => {
                self.stop_input(&format!(
                    "#{}'s terminal stopped taking input: {err}",
                    self.id
                ));
            }
        }
    }

    /// The CLI wrote: into the log and the screen, then to everyone who follows it.
    fn take_output(&mut self) {
        self.links.output.send_replace(());
        self.end_nudge();
        self.undrawn = None;
        self.drawn_at = Some(Instant::now());
        let output = self.terminal.output().to_vec();
        let fed = self.screen_mut().feed(&output);
        self.viewers.show(&fed);
        self.take_parsed(fed);
        self.admit_viewers();
        if self.catch_up_at.is_none() && self.viewers.is_behind() {
            self.catch_up_at = Some(Instant::now());
        }
        self.screen_mut().checkpoint_if_due();
        // A quiet agent starts and types nothing more: the next daemon does.
        if self.quiet {
            return;
        }
        // The CLI drew: the start, a message waiting for the input and the person's Enter look
        // again.
        if self.readiness.is_under_way() {
            self.step_start();
            self.type_next();
        } else if self.typist.reads_input() {
            self.type_next();
        }
        self.follow_enter();
    }

    /// The replies and status the screen found in output.
    fn take_parsed(&mut self, fed: ParsedOutput) {
        self.queue_replies(fed.query_replies);
        self.state_changed |= !fed.status.is_empty();
        self.state.take(fed.status);
        if self.state.reads_screen() || self.input_rule.is_some() {
            self.screen_status_at
                .get_or_insert_with(|| Instant::now() + SCREEN_STATUS_DELAY);
        }
    }

    /// Output the actor writes itself, such as a restart's reset: logged, parsed and shown.
    fn feed_own(&mut self, bytes: &[u8]) {
        let fed = self.screen_mut().feed(bytes);
        self.viewers.show(&fed);
        self.screen_mut().checkpoint_if_due();
    }

    fn admit_viewers(&mut self) {
        let told = if self.exit_sent {
            self.exit.clone()
        } else {
            None
        };
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        self.viewers
            .admit(screen.screen(), told.as_ref(), self.process);
    }

    fn catch_up(&mut self) {
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        let behind = self.viewers.catch_up(screen.screen(), self.exit.as_ref());
        self.catch_up_at = behind.then(|| Instant::now() + CATCH_UP_INTERVAL);
    }

    /// The CLI did not end its synchronized update in time: the log ends it at the same point.
    fn end_sync(&mut self) {
        self.screen_mut().checkpoint_if_due();
        let fed = self.screen_mut().end_synchronized_update();
        self.queue_replies(fed.query_replies);
        if fed.redraw_viewers {
            self.viewers.redraw_all();
        }
        self.admit_viewers();
        self.catch_up_at = Some(Instant::now());
        self.screen_mut().checkpoint_if_due();
    }

    /// Gives the terminal back its logged size after a redraw nudge.
    fn end_nudge(&mut self) {
        if self.nudge_until.take().is_some() {
            let (cols, rows) = self.size();
            self.terminal.set_size(cols, rows);
        }
    }

    /// Reads what a recovered CLI wrote while no daemon read it, so that the redraw the nudge asks
    /// for comes after it. No viewer is attached yet.
    fn read_unread_output(&mut self) {
        let mut read = 0;
        while read < MAX_DRAIN_BYTES && !self.screen().is_full() {
            let Some(n) = self.terminal.read_now() else {
                break;
            };
            read += n;
            let output = self.terminal.output().to_vec();
            let fed = self.screen_mut().feed(&output);
            self.take_parsed(fed);
            self.screen_mut().checkpoint_if_due();
        }
    }

    /// Reads the last output into the screen before removal, and ends an open synchronized update.
    fn drain_for_removal(&mut self) {
        if !self.terminal.is_open() {
            return;
        }
        let mut read = 0;
        while read < MAX_DRAIN_BYTES {
            let Some(n) = self.terminal.read_now() else {
                break;
            };
            read += n;
            let output = self.terminal.output().to_vec();
            let fed = self.screen_mut().feed(&output);
            self.viewers.show(&fed);
        }
        if self
            .screen()
            .screen()
            .synchronized_update_deadline()
            .is_some()
        {
            self.screen_mut().end_synchronized_update();
        }
    }

    /// The current run ended: the record says so first, input stops, and viewers get the exit once
    /// the run's output is read, or now if the terminal closed.
    fn end_run(&mut self, exit: ProcessExit, stopped: bool) {
        self.publish_at = None;
        self.state.ended(&exit, stopped);
        // Whatever waits on the run reads its end from the record, so the record goes first.
        {
            let mut info = self.links.shared.info.lock().unwrap();
            info.process = ProcessState::Ended;
            info.exit = Some(exit.clone());
        }
        self.process = ProcessState::Ended;
        self.record_state();
        self.publish();
        self.stop_input(&format!("#{} ended", self.id));
        self.readiness.end();
        self.ready_at = None;
        (self.awaits_prompt, self.prompt_ready) = (false, None);
        self.links.room.notify_waiters();
        self.exit = Some(exit.clone());
        let _ = self.links.exit.send(Some(exit));
        if self.terminal.is_closed() {
            self.send_exit();
        } else {
            self.drain_deadline = Some(Instant::now() + OUTPUT_DRAIN_TIMEOUT);
        }
    }

    /// Tells viewers the exit, once.
    fn send_exit(&mut self) {
        let Some(exit) = self.exit.clone() else {
            return;
        };
        if self.exit_sent {
            return;
        }
        (self.exit_sent, self.drain_deadline) = (true, None);
        self.links.settled.send_replace(true);
        self.viewers.send_exit(&exit);
    }

    /// Readies the screen for run `run`.
    async fn prepare_restart(
        &mut self,
        run: u64,
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<()>,
    ) {
        // The new run's output goes on in the screen and its log.
        self.screen_mut().hold_with_log().await;
        // Input bound to the ended run is refused from now on, also for senders waiting for room.
        self.run = run;
        self.links.shared.run.store(run, Ordering::SeqCst);
        self.stop_input(&format!("#{} is resuming", self.id));
        self.pending_size = None;
        self.links.room.notify_waiters();
        self.next_run = Some(run);
        self.early_exit = None;
        self.readiness.end();
        self.ready_at = None;
        self.nudge_until = None;
        self.terminal.detach();
        if self.screen().is_full() {
            self.pending_restart = Some((cols, rows, reply));
        } else {
            self.restart_screen(cols, rows);
            self.catch_up_at = Some(Instant::now());
            let _ = reply.send(());
        }
    }

    /// Viewers get the ended run's end, then the screen a fresh terminal's modes and the new size,
    /// all through the log.
    fn restart_screen(&mut self, cols: u16, rows: u16) {
        let exit = self.exit.clone();
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        self.viewers.finish_run(screen.screen(), exit.as_ref());
        let leave = self.screen().screen().leave_for_restart();
        self.feed_own(&leave);
        let reset = self.screen().screen().reset_for_restart();
        self.feed_own(&reset);
        self.resize(cols, rows);
    }

    /// Whether the screen can leave memory: the run ended and its terminal closed, viewers were
    /// told, none watches, no resume is under way and no checkpoint is being written.
    fn screen_unneeded(&self) -> bool {
        let screen = self.screen();
        screen.is_held()
            && self.terminal.is_closed()
            && self.exit.is_some()
            && self.exit_sent
            && self.next_run.is_none()
            && self.pending_restart.is_none()
            && !self.viewers.is_watched()
            && !screen.checkpoint_running()
    }

    /// The CLI's input as its rule reads the screen now, with a draft's text, which stays in the
    /// daemon.
    fn read_draft(&self) -> Reading {
        read_draft(
            self.input_rule,
            self.ended(),
            self.undrawn,
            self.screen().screen(),
        )
    }

    /// Lets the typist take its next step and queues what it writes.
    fn type_next(&mut self) {
        self.typist_at = None;
        // A quiet agent types nothing: the next daemon types what is left.
        if self.quiet {
            return;
        }
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        let modes = Modes {
            bracketed_paste: screen.screen().bracketed_paste(),
            application_cursor_keys: screen.screen().application_cursor_keys(),
        };
        let written = self.terminal.written();
        let queued = written + self.terminal.queued() as u64;
        // Messages wait behind what the run's start does first, as behind a draft.
        let first = if self.readiness.readies_tools() {
            Some("the run's start readies its tools first")
        } else if self.awaits_prompt {
            Some("the run's start prompt goes first")
        } else {
            None
        };
        let (rule, ended, undrawn) = (self.input_rule, self.ended(), self.undrawn);
        let read = || match first {
            Some(evidence) => (
                InputInfo {
                    state: InputState::Draft,
                    evidence: evidence.to_string(),
                    mechanism: rule.map(InputRule::mechanism),
                    hidden: None,
                },
                None,
            ),
            None => read_draft(rule, ended, undrawn, screen.screen()),
        };
        let step = self
            .typist
            .step(Instant::now(), written, queued, modes, &read);
        self.terminal.push(&step.write);
        self.typist_at = step.wake;
        self.take_typed();
    }

    /// What the typist submitted is said to the agent, and an Enter it typed asks the CLI to do
    /// something, unless the start holds the other input and types its own keys alone.
    fn take_typed(&mut self) {
        if let Some(submission) = self.typist.take_submitted() {
            self.state.said(submission);
            self.state_changed = true;
        }
        if self.typist.take_entered() && !self.start_holds_input() {
            self.state.asked();
            self.state_changed = true;
        }
    }

    /// Whether the run's start holds keys and calls now. The input is read only while it might.
    fn start_holds_input(&self) -> bool {
        self.readiness.readies_tools() && self.readiness.holds_input(self.read_draft().0.state)
    }

    /// One step of the run's start; the keys it asks for go to the typist.
    fn step_start(&mut self) {
        let now = Instant::now();
        let input = self.read_draft().0.state;
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        let view = StartView {
            screen: screen.screen(),
            input,
            works: self.state.works(),
            start_bound: self.state.start_bound(),
            drawn_at: self.drawn_at,
            typing: self.typist.types_calls(),
        };
        let typist = &mut self.typist;
        let mut press = |press: Press| {
            let (typing, _answer) = match press {
                Press::Text(text) => Typing::text(text, false, Sender::person()),
                Press::Keys(keys) => Typing::keys(&keys),
            }?;
            typist.push(typing);
            Ok(())
        };
        let step = self.readiness.step(now, &view, &mut press);
        self.ready_at = step.wake;
        if step.tools_not_started {
            self.state.tools_not_started();
            self.state_changed = true;
        }
        if step.release_held {
            self.release_held();
        }
    }

    /// The keys and calls held while the start readied the tools go on, in the order they came.
    fn release_held(&mut self) {
        for input in std::mem::take(&mut self.held) {
            match input {
                Input::Raw(keys) => self.take_keys(keys),
                other => self.give_typist(other),
            }
        }
    }

    /// Drops queued input and fails the typist's calls: `why` typing stopped.
    fn stop_input(&mut self, why: &str) {
        self.terminal.clear();
        (self.person, self.submitting) = (PersonKeys::default(), None);
        // Held calls fail with the others; held keys go with the queued ones.
        for input in std::mem::take(&mut self.held) {
            self.give_typist(input);
        }
        self.typist.fail_all(self.terminal.written(), why);
        self.typist_at = None;
        self.take_typed();
    }

    /// The person's keys. An Enter that may submit the input waits, with the keys after it, until
    /// the input can be read; a CLI without a rule has no input to read.
    fn take_keys(&mut self, keys: Vec<u8>) {
        let enter = self.person.enter(&keys);
        if enter.is_some() {
            self.state.asked();
            self.state_changed = true;
        }
        match (
            &mut self.submitting,
            enter.filter(|_| self.input_rule.is_some()),
        ) {
            (Some(Submitting::Held { keys: held, .. }), _) => held.extend(keys),
            (_, Some(enter)) => {
                self.terminal.push(&keys[..enter.at]);
                let sent_through = self.terminal.written() + self.terminal.queued() as u64;
                self.submitting = Some(Submitting::held(
                    keys[enter.at..].to_vec(),
                    sent_through,
                    enter.pastes,
                ));
            }
            (_, None) => self.terminal.push(&keys),
        }
    }

    /// A held Enter goes now: an agent that reads its terminal no more cannot see the input drawn.
    fn let_enter_go(&mut self) {
        if let Some(submitting) = self.submitting.as_mut() {
            submitting.release_now();
            self.follow_enter();
        }
    }

    /// When the CLI last drew, if it has the input through `sent_through` and drew after it.
    fn drawn_since(&self, sent_through: u64) -> Option<Instant> {
        let written_at = self.terminal.written_at();
        self.drawn_at.filter(|drawn| {
            self.terminal.written() >= sent_through && written_at.is_none_or(|at| *drawn >= at)
        })
    }

    /// When to follow the person's Enter again, though the CLI draws nothing.
    fn enter_wake(&self) -> Option<Instant> {
        match self.submitting.as_ref()? {
            Submitting::Held {
                sent_through,
                release_at,
                ..
            } => {
                let quiet = self.drawn_since(*sent_through).map(|drawn| {
                    (drawn + ENTER_DRAWN_AFTER).max(Instant::now() + ENTER_READ_AGAIN)
                });
                Some(quiet.map_or(*release_at, |at| at.min(*release_at)))
            }
            Submitting::Sent { until, .. } => Some(*until),
        }
    }

    /// Follows the person's Enter. A held Enter goes once the CLI drew what came before it and its
    /// screen stayed quiet, reading the draft it submits; by its bound it goes anyway. A sent
    /// Enter's draft is said once the CLI takes it.
    fn follow_enter(&mut self) {
        let now = Instant::now();
        match self.submitting.take() {
            Some(Submitting::Held {
                keys,
                sent_through,
                release_at,
                pastes,
            }) => {
                let drawn = self.drawn_since(sent_through);
                let whole = self
                    .screen()
                    .screen()
                    .synchronized_update_deadline()
                    .is_none();
                let quiet = drawn.is_some_and(|drawn| now >= drawn + ENTER_DRAWN_AFTER);
                if !(whole && quiet) && now < release_at {
                    self.submitting = Some(Submitting::Held {
                        keys,
                        sent_through,
                        release_at,
                        pastes,
                    });
                    return;
                }
                // A draft ending in `\` is a line break to a CLI, not a submission.
                let draft = (whole && drawn.is_some())
                    .then(|| self.read_draft())
                    .and_then(|(input, draft)| {
                        draft.filter(|draft| {
                            input.state == InputState::Draft && !draft.trim_end().ends_with('\\')
                        })
                    })
                    .map(|draft| match self.typist.paste_rule() {
                        // A long paste the CLI shows as a placeholder is said as what was pasted.
                        Some(rule) => facade_rules::with_paste_text(rule, &draft, &pastes),
                        None => draft,
                    });
                self.terminal.push(&keys);
                self.submitting = draft.map(|draft| Submitting::sent(draft, now));
            }
            Some(Submitting::Sent { draft, until }) => {
                let taken = matches!(
                    self.read_draft().0.state,
                    InputState::Usable | InputState::Interaction
                );
                if taken {
                    self.state.said(Submission {
                        text: draft,
                        sender: Sender::person(),
                    });
                    self.state_changed = true;
                } else if now < until {
                    self.submitting = Some(Submitting::Sent { draft, until });
                } else {
                    facade_base::service::mark_for_test("submission-untaken");
                }
            }
            None => {}
        }
    }

    /// Reads the CLI's status from its screen, once no frame is being drawn. An ended run's
    /// screen says nothing.
    fn read_screen_status(&mut self) {
        self.screen_status_at = None;
        if self.ended() {
            return;
        }
        if self
            .screen()
            .screen()
            .synchronized_update_deadline()
            .is_some()
        {
            self.screen_status_at = Some(Instant::now() + SCREEN_STATUS_DELAY);
            return;
        }
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        self.state.observe(screen.screen());
        // A menu or question of the CLI's own in place of its input waits for the person.
        let asking = self.read_draft().0.state == InputState::Interaction;
        self.state.asks(asking, Instant::now());
        self.state_changed = true;
    }

    /// Reads the state into the record and hands changed facts to the task that keeps them.
    /// `Some(true)` where the change goes out at once: the CLI waits for the person or reports an
    /// error.
    fn record_state(&mut self) -> Option<bool> {
        self.state_changed = false;
        let viewing = if self.viewers.is_watched() {
            Viewing::Watched
        } else {
            Viewing::Unwatched
        };
        let reading = self.state.read(Instant::now(), viewing);
        self.state_at = reading.wake;
        if let Some(kept) = self.kept.as_ref() {
            let facts = self.state.kept();
            kept.send_if_modified(|kept| {
                let changed = *kept != facts;
                *kept = facts;
                changed
            });
        }
        let said = self.state.said_line().cloned();
        let mut info = self.links.shared.info.lock().unwrap();
        let same = info.state == reading.state
            && info.state_detail == reading.detail
            && info.said == said
            && info.tools_state == reading.tools
            && info.tools_reason == reading.tools_reason;
        if same {
            return None;
        }
        (info.state, info.state_detail, info.said) = (reading.state, reading.detail, said);
        (info.tools_state, info.tools_reason) = (reading.tools, reading.tools_reason);
        Some(matches!(
            info.state,
            AgentState::WaitingForYou | AgentState::Error
        ))
    }
}

/// A CLI's input as `rule` reads `screen`, with a draft's text. Unknown without a rule, once the
/// run `ended`, or while the screen may not show the input yet, `undrawn` saying why.
fn read_draft(
    rule: Option<&InputRule>,
    ended: bool,
    undrawn: Option<&str>,
    screen: &facade_screen::Screen,
) -> Reading {
    let unknown = |evidence: &str, rule: Option<&InputRule>| {
        let info = InputInfo {
            state: InputState::Unknown,
            evidence: evidence.to_string(),
            mechanism: rule.map(InputRule::mechanism),
            hidden: None,
        };
        (info, None)
    };
    match (rule, undrawn) {
        (None, _) => unknown("the agent has no CLI rule to read its input by", None),
        (Some(rule), _) if ended => unknown("the agent ended", Some(rule)),
        (Some(rule), Some(why)) => unknown(why, Some(rule)),
        (Some(rule), None) => facade_rules::read_draft(rule, &screen.view()),
    }
}
