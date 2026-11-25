//! The actor task: it owns the terminal, the logged screen, the state, the status glyph, the
//! typist, the viewers and the start of each run, and passes what one of them learns to the others.
//! None of them calls another.
//!
//! The record is shared with the handles under a leaf lock. Only the actor changes it once it runs,
//! and only here are changes published: at once for a start, an exit, a rename, a membership change
//! and a CLI that waits for the person or reports an error, otherwise batched.

use std::cell::OnceCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use facade_base::api_v1::Size;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::DeliveryFailure;
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::{
    model::agent::{AgentRef, AgentsUpdate, ManagedAgent, ManagedAgentState, ToolsState},
    model::terminal::{DEFAULT_TERMINAL_SIZE, InputInfo, InputState},
};
use facade_rules::{BoxReading, InputRule, Rule};
use facade_screen::{CursorRowWrites, ParsedOutput, TerminalColors};
use tokio::sync::{Notify, broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::glyph::Glyph;
use super::person::{
    ENTER_DRAWN_AFTER, ENTER_READ_AGAIN, HeldEnter, KeyOffset, PersonInput, PersonKeys, Submitting,
};
use super::readiness::{Press, Readiness, StartView};
use super::screen::LoggedScreen;
use super::state::{Kept, StateTracker, Viewing, keep};
use super::terminal::{Terminal, TerminalEvent, TerminalWait};
use super::typist::{BoxWrites, InputObservation, MessageTyping, Modes, Typing, Typist};
use super::viewers::{ViewKind, ViewerRequest, Viewers};
use super::{
    ActorStart, AgentCommand, FIRST_RUN, Input, InputRejection, Inspection, MAX_INPUT_BYTES,
    ScreenStart, Shared, Submission, WatchdogSink,
};
use crate::messages::{DeliveryHandle, PromptNotice, PromptWatch, Settled};
use crate::waits::Trouble;
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
    pub(super) changes: broadcast::Sender<AgentsUpdate>,
    /// Keeps the tools channel open while the actor runs.
    pub(super) _tools: Arc<watch::Sender<usize>>,
    pub(super) tools_connections: watch::Receiver<usize>,
}

/// Builds the actor from `start` and runs it on its own task.
pub(super) fn spawn(
    start: ActorStart,
    links: Links,
    commands: mpsc::Receiver<AgentCommand>,
    allow_auto_trust: bool,
) -> anyhow::Result<()> {
    let colors = start.colors;
    let recovered = !matches!(start.screen, ScreenStart::New(_));
    let mut actor = new_actor(start, links, recovered)?;
    // The record shows the state from the start.
    actor.record_state();
    tokio::spawn(async move {
        actor
            .run(commands, recovered, allow_auto_trust, colors)
            .await;
    });
    Ok(())
}

fn new_actor(start: ActorStart, links: Links, recovered: bool) -> anyhow::Result<Actor> {
    let ActorStart {
        info,
        master,
        screen,
        untouched_input,
        rule,
        captures,
        launch_command,
        deliveries,
        observed_loss,
        state,
        ..
    } = start;
    // The agent reads its CLI by the rule this build has under the rule's name.
    let rule: Option<&'static Rule> = rule
        .as_deref()
        .and_then(|name| facade_rules::find(name).ok().flatten());
    if let ScreenStart::Recovered { log: Some(log), .. } = &screen {
        links.shared.record.lock().unwrap().title = log.recovered_title.clone();
    }
    let mut tracker = {
        let replayed = match &screen {
            ScreenStart::Recovered {
                screen,
                restart_size: None,
                ..
            } => Some(screen.as_ref()),
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
    Ok(Actor {
        id: info.agent_id.clone(),
        links,
        terminal,
        screen: None,
        screen_start: Some(screen),
        state: tracker,
        glyph: Glyph::new(rule.and_then(|rule| rule.status_glyph.as_ref())),
        glyph_at: None,
        facts: state.file,
        kept: None,
        keeping: None,
        state_changed: false,
        state_at: None,
        observed_end: observed_loss,
        watchdog: None,
        trouble: None,
        watchdog_at: None,
        prompt_result: None,
        deliveries: deliveries.clone(),
        screen_status_at: None,
        typist: Typist::new(
            &info.agent_id,
            rule,
            rule.and_then(facade_rules::console_typing),
            deliveries,
        ),
        viewers: Viewers::new(),
        readiness: Readiness::new(rule, &info.agent_id),
        ready_at: None,
        person: PersonKeys::default(),
        escape_may_edit: false,
        held_enter: None,
        submitting: VecDeque::new(),
        held: VecDeque::new(),
        ordered_input: false,
        input_rule: rule.map(|rule| &rule.input),
        captures,
        launch_command,
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
        start_prompt_bytes: None,
        prompt_ready: None,
        quiet: false,
        quieting: None,
        settling: None,
        drawn_at: None,
        input_drawn_at: None,
        nudge_until: None,
        catch_up_at: None,
        publish_at: None,
        typist_at: None,
        replies_dropped: false,
        untouched_input,
        holds_input_for_probe: false,
    })
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
    glyph: Glyph,
    /// When the next working glyph frame is due.
    glyph_at: Option<Instant>,
    /// The file beside the screen that keeps the state's facts.
    facts: PathBuf,
    /// Hands changed facts to the task that keeps them; None while quiet or once removed.
    kept: Option<watch::Sender<Kept>>,
    keeping: Option<JoinHandle<()>>,
    /// Something the state rests on changed since the record last took it.
    state_changed: bool,
    observed_end: bool,
    watchdog: Option<(Option<PromptWatch>, WatchdogSink)>,
    trouble: Option<Trouble>,
    watchdog_at: Option<Instant>,
    prompt_result: Option<watch::Receiver<Option<Settled>>>,
    deliveries: DeliveryHandle,
    /// When to read the state again though nothing changed.
    state_at: Option<Instant>,
    /// When to read the CLI's screen for its status.
    screen_status_at: Option<Instant>,
    typist: Typist,
    viewers: Viewers,
    readiness: Readiness,
    ready_at: Option<Instant>,
    person: PersonKeys,
    /// An undecided escape sequence released into the input box.
    escape_may_edit: bool,
    held_enter: Option<HeldEnter>,
    /// Issued Enters in input order, each waiting for its preceding output to be observed.
    submitting: VecDeque<Submitting>,
    /// External input in the order it came, with when: each goes on once nothing makes it wait.
    held: VecDeque<(Instant, Input)>,
    /// Keep the held FIFO ordered through a sequence and the input it held back.
    ordered_input: bool,
    input_rule: Option<&'static InputRule>,
    /// Whether the running CLI reports its session.
    captures: bool,
    launch_command: Option<String>,
    /// Why the screen may not show the CLI's input yet; cleared once the CLI writes.
    undrawn: Option<&'static str>,
    /// The process state viewers' snapshots carry.
    process: ProcessState,
    exit: Option<ProcessExit>,
    exit_sent: bool,
    /// When to tell viewers the exit though the run's output has not all been read.
    drain_deadline: Option<Instant>,
    run: u64,
    /// The pending run and requested size. Its exit may arrive before its terminal.
    next_run: Option<(u64, Size)>,
    early_exit: Option<(ProcessExit, bool, Option<AgentRef>)>,
    /// A size waiting for a full log's checkpoint writer; input waits until it is applied.
    pending_size: Option<SizeRequest>,
    /// The preparation reply waiting for a full log's checkpoint writer.
    pending_restart: Option<oneshot::Sender<()>>,
    /// Bytes reserved for the first prompt while later messages wait behind it.
    start_prompt_bytes: Option<usize>,
    prompt_ready: Option<oneshot::Sender<()>>,
    /// A newer Facade takes over: no reading, no typing.
    quiet: bool,
    quieting: Option<oneshot::Sender<()>>,
    settling: Option<oneshot::Sender<()>>,
    /// When the CLI last sent output, for the startup wait.
    drawn_at: Option<Instant>,
    /// When CLI output last drew on the input cursor's row.
    input_drawn_at: Option<Instant>,
    nudge_until: Option<Instant>,
    catch_up_at: Option<Instant>,
    publish_at: Option<Instant>,
    typist_at: Option<Instant>,
    /// Dropped terminal-query replies were logged.
    replies_dropped: bool,
    /// Automatic delivery can probe an unstyled hint before it accepts any external input.
    untouched_input: bool,
    /// The probe of a fresh unstyled hint finishes before external keys reach the terminal.
    holds_input_for_probe: bool,
}

/// A size determined from the live viewers, or an exact size in a unit fixture.
enum SizeRequest {
    Shared,
    #[cfg(test)]
    Direct(Size),
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn wait_for_prompt(prompt: &mut Option<watch::Receiver<Option<Settled>>>) {
    if let Some(prompt) = prompt {
        let _ = prompt.wait_for(Option::is_some).await;
    } else {
        std::future::pending().await
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
        let agent = self.links.shared.record.lock().unwrap().info.clone();
        self.publish_record(agent);
    }

    fn publish_record(&self, agent: ManagedAgent) {
        let _ = self.links.changes.send(AgentsUpdate::Updated {
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
        &mut self,
        mut commands: mpsc::Receiver<AgentCommand>,
        recovered: bool,
        allow_auto_trust: bool,
        colors: TerminalColors,
    ) {
        Box::pin(self.begin(recovered, allow_auto_trust, colors)).await;
        // A recovered run's first viewer needs the glyph from its restored evidence.
        self.publish_state();
        loop {
            if !self.typist.pasting()
                && !self.holds_input_for_probe
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
            let held_at = self.held_wake();
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
                _ = sleep_until(self.watchdog_at), if self.watchdog.is_some() => self.report_trouble(),
                _ = wait_for_prompt(&mut self.prompt_result) => self.report_trouble(),
                // Continuous terminal output must not hold back a glyph frame.
                _ = sleep_until(self.glyph_at), if self.glyph_at.is_some() => self.advance_glyph(),
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
                // What this turn ends with lets the held input go.
                _ = sleep_until(held_at), if held_at.is_some() => {}
            }
            self.end_turn().await;
        }
    }

    /// What every turn of the loop ends with: the state into the record, the start prompt told the
    /// start settled, and an unneeded screen let go.
    async fn end_turn(&mut self) {
        self.release_held();
        if self.state_changed {
            self.publish_state();
        }
        if self.viewers.take_removed() {
            self.take_size(SizeRequest::Shared);
        }
        if self.viewers.is_watched()
            && let Some(interval) = self.glyph.frame_interval()
        {
            self.glyph_at
                .get_or_insert_with(|| Instant::now() + interval);
        } else {
            self.glyph_at = None;
        }
        if self.prompt_ready.is_some()
            && self.links.shared.record.lock().unwrap().info.tools_state != ToolsState::Connecting
            && let Some(ready) = self.prompt_ready.take()
        {
            let _ = ready.send(());
        }
        if self.screen_unneeded() {
            self.screen_mut().let_go().await;
        }
    }

    /// Sets the screen up, starts keeping the state's facts, and takes up a run that is under way.
    async fn begin(&mut self, recovered: bool, allow_auto_trust: bool, colors: TerminalColors) {
        let (cols, rows) = {
            let record = self.links.shared.record.lock().unwrap();
            (
                record.info.cols.unwrap_or(DEFAULT_TERMINAL_SIZE.0),
                record.info.rows.unwrap_or(DEFAULT_TERMINAL_SIZE.1),
            )
        };
        let folder = self.facts.parent().map(PathBuf::from).unwrap_or_default();
        let screen_start = self.screen_start.take().expect("the screen starts once");
        let (mut screen, handed_over, restart_size) = match screen_start {
            ScreenStart::New(folder) => (
                LoggedScreen::create(folder, &self.id, cols, rows).await,
                false,
                None,
            ),
            ScreenStart::Recovered {
                screen,
                log,
                handed_over_cleanly,
                restart_size,
            } => (
                LoggedScreen::recovered(folder, &self.id, *screen, log),
                handed_over_cleanly,
                restart_size,
            ),
            ScreenStart::Released => (LoggedScreen::released(folder, &self.id), false, None),
        };
        screen.set_colors(colors);
        self.screen = Some(screen);
        self.set_status_glyph(None);
        // The screen folder exists now; the facts are kept there.
        self.start_keeping();
        self.undrawn = match (recovered, handed_over) {
            (true, true) => None,
            (true, false) => Some("the CLI has not written since Facade recovered it"),
            (false, _) => Some("the CLI has not written yet"),
        };
        // A new run readies its tools and may answer its trust question.
        if !recovered && self.exit.is_none() {
            self.ready_at = self.readiness.begin(
                self.state.started(),
                self.state.tools_given(),
                allow_auto_trust,
            );
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
        if let Some((cols, rows)) = restart_size {
            self.restart_screen(cols, rows);
        } else {
            let (cols, rows) = self.size();
            // The last logged size; this also undoes a redraw nudge a failed daemon left.
            self.terminal.set_size(cols, rows);
        }
        if self.process != ProcessState::Running {
            return;
        }
        let (cols, rows) = self.size();
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
            #[cfg(test)]
            AgentCommand::ResizeTerminal(cols, rows) => {
                self.take_size(SizeRequest::Direct(Size { cols, rows }));
            }
            #[cfg(test)]
            AgentCommand::AddViewer {
                viewer,
                tx,
                keep_scrollback,
                include_scrollback,
                reply,
            } => {
                self.add_viewer(ViewerRequest {
                    viewer,
                    kind: ViewKind::Test,
                    size: None,
                    tx,
                    keep_scrollback,
                    include_scrollback,
                    reply,
                })
                .await;
            }
            AgentCommand::AttachViewer {
                viewer,
                name,
                attachment,
                allow_ended,
                report_activity,
                size,
                tx,
                keep_scrollback,
                include_scrollback,
                reply,
            } => {
                self.add_viewer(ViewerRequest {
                    viewer,
                    kind: ViewKind::Attach {
                        name,
                        attachment,
                        allow_ended,
                        report_activity,
                    },
                    size,
                    tx,
                    keep_scrollback,
                    include_scrollback,
                    reply,
                })
                .await;
            }
            AgentCommand::ResizeViewer {
                viewer,
                size,
                colors,
                reply,
            } => {
                let _ = reply.send(self.resize_viewer(viewer, size, colors));
            }
            AgentCommand::RemoveViewer { viewer } => self.viewers.remove(viewer),
            AgentCommand::ReadScreen { lines, reply } => {
                if self.screen_mut().hold().await {
                    self.record_title();
                    let info = self.links.shared.record.lock().unwrap().info.clone();
                    let _ = reply.send((self.screen().screen().read(lines), info));
                }
            }
            AgentCommand::Inspect { reply } => {
                let title_unknown = self.links.shared.record.lock().unwrap().title.is_none();
                if title_unknown && !self.screen().is_held() && self.screen_mut().hold().await {
                    self.record_title();
                }
                let (agent, title) = {
                    let record = self.links.shared.record.lock().unwrap();
                    (record.info.clone(), record.title.clone())
                };
                let _ = reply.send(Inspection {
                    agent,
                    input: self.read_input_box(self.untouched_input).info,
                    session_tracking: self.captures && !self.ended(),
                    viewers: if self.ended() {
                        Vec::new()
                    } else {
                        self.viewers.names()
                    },
                    attachments: if self.ended() {
                        Vec::new()
                    } else {
                        self.viewers.attachments()
                    },
                    title,
                    launch_command: self.launch_command.clone(),
                });
            }
            AgentCommand::ProcessExited {
                run,
                exit,
                stopped,
                stopped_by,
            } => {
                gate_for_test("before-exit-reaches-agent");
                if self.next_run.is_some_and(|(number, _)| number == run) {
                    self.early_exit.get_or_insert((exit, stopped, stopped_by));
                } else if run == self.run && self.exit.is_none() {
                    self.end_run(exit, stopped, stopped_by);
                }
            }
            AgentCommand::WatchCreator { prompt, report } => {
                self.watchdog = Some((prompt, report));
            }
            AgentCommand::RecordSession(session) => {
                let changed = {
                    let mut record = self.links.shared.record.lock().unwrap();
                    std::mem::replace(&mut record.info.session, session.clone()) != session
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
                launch_command,
                tools,
                reply,
            } => {
                let Some((_, Size { cols, rows })) =
                    self.next_run.filter(|(number, _)| *number == run)
                else {
                    return true;
                };
                if let Err(err) = self.terminal.install(master) {
                    log(
                        "warn",
                        &format!("could not read the resumed terminal of {}: {err}", self.id),
                    );
                    return true;
                }
                self.restart_screen(cols, rows);
                // Dropping old viewers at restart leaves the new run at its requested size.
                self.viewers.take_removed();
                self.catch_up_at = Some(Instant::now());
                self.next_run = None;
                (self.exit, self.exit_sent, self.drain_deadline) = (None, false, None);
                self.process = ProcessState::Running;
                self.observed_end = false;
                if let Some((prompt, _)) = &mut self.watchdog {
                    *prompt = None;
                }
                self.captures = captures;
                self.launch_command = launch_command;
                self.undrawn = Some("the CLI has not written since it resumed");
                self.input_drawn_at = None;
                self.links.settled.send_replace(false);
                let _ = self.links.exit.send(None);
                self.state.restarted(Instant::now(), tools);
                self.glyph.restart();
                self.glyph_at = None;
                self.set_status_glyph(None);
                self.typist.clear_probes();
                self.untouched_input = false;
                self.holds_input_for_probe = false;
                self.ready_at =
                    self.readiness
                        .begin(self.state.started(), self.state.tools_given(), false);
                self.record_state();
                let record = {
                    let mut record = self.links.shared.record.lock().unwrap();
                    record.installed_run = run;
                    record.info.pid = Some(pid);
                    record.info.process = ProcessState::Running;
                    record.info.exit = None;
                    record.info.clone()
                };
                self.publish_now();
                let _ = reply.send(record);
                if let Some((exit, stopped, stopped_by)) = self.early_exit.take() {
                    self.end_run(exit, stopped, stopped_by);
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
                self.holds_input_for_probe = false;
                // It reads no more, so the person's keys go as they come.
                self.let_enter_go();
                self.release_held();
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
                self.links.shared.record.lock().unwrap().info.name = name;
                self.publish();
                let _ = reply.send(self.links.shared.record.lock().unwrap().info.clone());
            }
            // A run that ended takes no prompt: dropping `ready` says so.
            AgentCommand::AwaitPrompt { text, ready } => {
                if !self.ended() {
                    self.start_prompt_bytes =
                        Some(MessageTyping::bytes_for(&text, self.typist.console()));
                    self.prompt_ready = Some(ready);
                }
            }
            AgentCommand::StartPrompt { run, prompt } => {
                self.start_prompt_bytes = None;
                if let Some(prompt) = prompt {
                    if run != self.run || self.exit.is_some() || !self.terminal.is_open() {
                        self.typist.fail_prompt(prompt, DeliveryFailure::Ended);
                    } else if prompt.most_bytes(self.typist.console()) > MAX_INPUT_BYTES {
                        self.typist.fail_prompt(prompt, DeliveryFailure::Timeout);
                    } else {
                        // The prompt takes the room held by its reservation.
                        self.typist.deliver_first(prompt);
                    }
                }
                self.type_next();
                self.links.room.notify_waiters();
            }
        }
        true
    }

    /// Takes input for run `run`, or says why not.
    fn take_input(&mut self, input: Input, run: u64) -> Result<(), InputRejection> {
        if run != self.run || self.exit.is_some() || !self.terminal.is_open() {
            return Err(InputRejection::AgentExited);
        }
        let bytes = input.most_bytes(self.typist.console());
        if bytes > MAX_INPUT_BYTES {
            return Err(InputRejection::TooLarge(bytes));
        }
        // Input sent after a resize must not reach the CLI before the new size.
        if self.pending_size.is_some() || bytes > self.room() {
            facade_base::service::mark_for_test("input-without-room");
            return Err(InputRejection::Backpressured(input));
        }
        match input {
            external @ (Input::Raw(_) | Input::Typed(_)) => {
                self.untouched_input &= matches!(external, Input::Raw(_));
                self.ordered_input |= external.is_sequence();
                self.held.push_back((Instant::now(), external));
                self.release_held();
            }
            message => {
                self.give_typist(message);
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
            Input::BegunPaste {
                messages,
                previous_text,
            } => self.typist.finish_paste(messages, Some(previous_text)),
            Input::Raw(_) => {}
        }
    }

    /// The room left for input, after queued input and the first prompt's reservation.
    fn room(&self) -> usize {
        let enter = self.held_enter.is_some();
        let console = self.typist.console();
        let held: usize = self
            .held
            .iter()
            .map(|(_, input)| input.most_bytes(console))
            .sum();
        let used = self.terminal.queued()
            + self.typist.held_bytes()
            + usize::from(enter)
            + held
            + self.start_prompt_bytes.unwrap_or(0);
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

    fn can_resize(&self) -> bool {
        self.process == ProcessState::Running && self.terminal.is_open()
    }

    fn resize_viewer(
        &mut self,
        viewer: u64,
        size: Size,
        colors: Option<TerminalColors>,
    ) -> Result<(), ErrorBody> {
        if !self.can_resize() || !self.viewers.update_capacity(viewer, size) {
            return Err(ErrorBody::new(
                Reason::NotFound,
                "reopen the terminal watch to resize it",
            ));
        }
        if let Some(colors) = colors {
            self.screen_mut().set_colors(colors);
        }
        self.take_size(SizeRequest::Shared);
        Ok(())
    }

    /// Applies a resize or leaves it for the checkpoint writer to make room.
    fn take_size(&mut self, request: SizeRequest) {
        if !self.can_resize() {
            return;
        }
        let size = match request {
            SizeRequest::Shared => self.viewers.shared_size(None),
            #[cfg(test)]
            SizeRequest::Direct(size) => Some(size),
        };
        let Some(Size { cols, rows }) = size else {
            if matches!(self.pending_size, Some(SizeRequest::Shared)) {
                self.pending_size = None;
                self.links.room.notify_waiters();
            }
            return;
        };
        if matches!(request, SizeRequest::Shared) && self.size() == (cols, rows) {
            if self.pending_size.take().is_some() {
                self.links.room.notify_waiters();
            }
            return;
        }
        if self.screen().is_full() {
            // The size waits for the checkpoint writer; the terminal leaves any nudge meanwhile.
            if self.nudge_until.take().is_some() {
                let (now_cols, now_rows) = self.size();
                self.terminal.set_size(now_cols, now_rows);
            }
            self.pending_size = Some(request);
            return;
        }
        self.apply_requested_size(cols, rows);
    }

    fn apply_requested_size(&mut self, cols: u16, rows: u16) {
        self.nudge_until = None;
        if self.resize(cols, rows) {
            self.publish_soon();
        } else {
            self.viewers.redraw_all();
        }
        if self.viewers.is_behind() {
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
            let mut record = self.links.shared.record.lock().unwrap();
            let info = &mut record.info;
            if (info.cols, info.rows) == (Some(cols), Some(rows)) {
                return false;
            }
            (info.cols, info.rows) = (Some(cols), Some(rows));
        }
        self.viewers.redraw_all();
        true
    }

    /// The checkpoint writer finished: a size can be applied and restart preparation can reply.
    fn after_checkpoint(&mut self) {
        if self.screen().is_full() {
            return;
        }
        if let Some(request) = self.pending_size.take() {
            self.take_size(request);
            self.links.room.notify_waiters();
        }
        self.admit_viewers();
        if let Some(reply) = self.pending_restart.take() {
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
                if self.submission_reached_edit()
                    || self
                        .submitting
                        .front()
                        .is_some_and(|s| self.submission_confirmed(s))
                {
                    self.follow_enter();
                }
                if self.terminal.queued() == 0
                    && let Some(reply) = self.quieting.take()
                {
                    let _ = reply.send(());
                }
            }
            TerminalEvent::WriteFailed(err) => {
                self.stop_input(&format!(
                    "{}'s terminal stopped taking input: {err}",
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
        let received = Instant::now();
        self.drawn_at = Some(received);
        let output = self.terminal.output().to_vec();
        let earlier = self.terminal.output_precedes_submission();
        if self.terminal.read_starts_at_submission() {
            self.screen_mut().mark_pending_frame_earlier();
        }
        let before_next = self.terminal.output_between_submissions();
        let fed = if self.observes_submission() || before_next {
            let (rule, ended) = (self.input_rule, self.ended());
            let (after_paste, position) = (
                self.terminal.output_follows_paste(),
                self.terminal.output_position(),
            );
            let after_enter = self.terminal.output_follows_first_submission();
            let submitting = &mut self.submitting;
            let typist = &self.typist;
            let mut observe = |screen: &facade_screen::Screen, writes: CursorRowWrites| {
                Self::observe_submissions(
                    submitting,
                    typist,
                    || read_box(rule, ended, None, screen, false),
                    writes,
                    after_paste,
                    (after_enter && writes == CursorRowWrites::Current).then_some(position),
                    before_next,
                );
            };
            self.screen
                .as_mut()
                .expect("the screen exists while the actor runs")
                .feed_observing(&output, Some(&mut observe))
        } else {
            self.screen_mut().feed(&output)
        };
        if !earlier && fed.cursor_row_cells_written {
            self.input_drawn_at = Some(received);
        }
        self.viewers.show(&fed);
        self.take_parsed(fed);
        self.admit_viewers();
        self.wake_behind_viewers();
        self.screen_mut().checkpoint_if_due();
        self.follow_output();
    }

    fn observes_submission(&self) -> bool {
        self.submitting
            .front()
            .is_some_and(|submission| submission.cleared_at.is_none())
            && (self.terminal.next_edit_is_provisional()
                || self
                    .terminal
                    .output_before_following_edit()
                    .is_none_or(|before| self.terminal.output_position() <= before))
    }

    fn submission_reached_edit(&self) -> bool {
        self.terminal
            .output_before_following_edit()
            .is_some_and(|before| self.terminal.output_position() >= before)
    }

    fn submission_cut_off(&self, submission: &Submitting) -> bool {
        (!submission.after_interaction || self.submitting.len() > 1)
            && !self.terminal.next_edit_is_provisional()
            && self.submission_reached_edit()
    }

    fn submission_confirmed(&self, submission: &Submitting) -> bool {
        submission.cleared_at.is_some_and(|frame| {
            self.terminal
                .submission_issued_before(submission.through, frame)
                && self
                    .terminal
                    .output_before_following_edit()
                    .is_none_or(|before| frame <= before)
        })
    }

    fn observe_submissions(
        submitting: &mut VecDeque<Submitting>,
        typist: &Typist,
        read: impl Fn() -> BoxReading,
        writes: CursorRowWrites,
        after_paste: bool,
        empty_at: Option<u64>,
        before_next: bool,
    ) {
        let reading = OnceCell::new();
        let frame = || reading.get_or_init(&read).clone();
        if let Some(first) = submitting.front_mut() {
            Self::observe_submission(
                first,
                typist,
                frame,
                after_paste && writes != CursorRowWrites::None,
                empty_at,
            );
        }
        if before_next && let Some(next) = submitting.get_mut(1) {
            Self::observe_submission(
                next,
                typist,
                frame,
                after_paste && writes == CursorRowWrites::Current,
                None,
            );
        }
    }

    /// The paste and its empty frame may already be waiting together when reads resume. Only a
    /// complete draft and the Enter's empty frame with no interaction between them count.
    fn observe_submission(
        submitting: &mut Submitting,
        typist: &Typist,
        read: impl FnOnce() -> BoxReading,
        after_paste: bool,
        empty_at: Option<u64>,
    ) {
        let Submitting {
            over,
            cleared_at,
            until,
            after_interaction,
            ..
        } = submitting;
        if cleared_at.is_some() || (!after_paste && over.is_none()) {
            return;
        }
        let frame = read();
        if frame.info.state == InputState::Interaction {
            *over = None;
            if let Some(deadline) = typist.draft_deadline() {
                *until = deadline;
                *after_interaction = true;
            }
        } else if after_paste && typist.shows_whole_paste(&frame) {
            *over = Some(Box::new(frame));
        } else if over.is_some() && Submitting::is_taken(&frame) {
            *cleared_at = empty_at;
        }
    }

    fn follow_output(&mut self) {
        // A quiet agent starts and types nothing more: the next daemon does.
        if self.quiet {
            return;
        }
        if self.person.unshown_until().is_some() && !self.typist.occupies_input() {
            let reading = self.read_screen_input();
            self.person.sees(&reading);
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
        if fed.title_change.is_some() {
            self.record_title();
        }
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
        if fed.title_change.is_some() {
            self.record_title();
        }
        self.viewers.show(&fed);
        self.screen_mut().checkpoint_if_due();
    }

    async fn add_viewer(&mut self, request: ViewerRequest) {
        // A screen that cannot be read back gives no snapshot: the watch fails.
        if self.screen_mut().hold().await {
            self.record_title();
            self.viewers.request(request);
            self.admit_viewers();
            self.state.seen();
            self.state_changed = true;
        }
    }

    fn admit_viewers(&mut self) {
        if self
            .screen()
            .screen()
            .synchronized_update_deadline()
            .is_some()
        {
            return;
        }
        let draining = self.exit.is_some() && !self.exit_sent;
        let waiting = self.viewers.take_waiting();
        if waiting.is_empty() {
            return;
        }
        let (name, working) = {
            let record = self.links.shared.record.lock().unwrap();
            (
                record.info.name.clone(),
                matches!(
                    record.info.state,
                    ManagedAgentState::Starting | ManagedAgentState::Working
                ),
            )
        };
        self.viewers.set_working(working);
        for request in waiting {
            if request.is_closed() {
                continue;
            }
            if (draining && request.kind.waits_for_exit())
                || (self.process == ProcessState::Running && self.pending_size.is_some())
            {
                self.viewers.request(request);
                continue;
            }
            if self.can_resize()
                && let Some(size) = self.viewers.shared_size(request.size)
                && self.size() != (size.cols, size.rows)
            {
                if self.screen().is_full() {
                    self.viewers.request(request);
                    continue;
                }
                self.apply_requested_size(size.cols, size.rows);
            }
            let screen = self
                .screen
                .as_ref()
                .expect("the screen exists while the actor runs");
            let exit = self.exit.as_ref().filter(|_| self.exit_sent);
            self.viewers
                .admit(request, screen.screen(), exit, self.process, &name);
        }
    }

    fn catch_up(&mut self) {
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        let behind = self.viewers.catch_up(screen.screen(), self.exit.as_ref());
        self.catch_up_at = behind.then(|| Instant::now() + CATCH_UP_INTERVAL);
    }

    fn wake_behind_viewers(&mut self) {
        if self.viewers.is_behind() {
            self.catch_up_at.get_or_insert_with(Instant::now);
        }
    }

    fn set_status_glyph(&mut self, glyph: Option<String>) {
        let viewer_output = self.screen_mut().set_status_glyph(glyph);
        self.viewers.show(&ParsedOutput {
            viewer_output,
            ..ParsedOutput::default()
        });
        self.wake_behind_viewers();
    }

    fn advance_glyph(&mut self) {
        self.glyph_at = None;
        let glyph = self.glyph.advance();
        self.set_status_glyph(glyph);
    }

    /// The CLI did not end its synchronized update in time: the log ends it at the same point.
    fn end_sync(&mut self) {
        self.screen_mut().checkpoint_if_due();
        let fed = self.screen_mut().end_synchronized_update();
        if fed.cursor_row_cells_written && !self.terminal.output_precedes_submission() {
            self.input_drawn_at = Some(Instant::now());
        }
        let before_next = self.terminal.output_between_submissions();
        if self.observes_submission() || before_next {
            let reading = self.read_screen_input();
            let writes = if fed.cursor_row_cells_written {
                CursorRowWrites::Current
            } else {
                CursorRowWrites::None
            };
            Self::observe_submissions(
                &mut self.submitting,
                &self.typist,
                || reading.clone(),
                writes,
                self.terminal.output_follows_paste(),
                (fed.cursor_row_cells_written && self.terminal.output_follows_first_submission())
                    .then(|| self.terminal.output_position()),
                before_next,
            );
        }
        if fed.title_change.is_some() {
            self.record_title();
        }
        self.viewers.show(&fed);
        self.queue_replies(fed.query_replies);
        self.admit_viewers();
        self.catch_up_at = Some(Instant::now());
        self.screen_mut().checkpoint_if_due();
        if fed.cursor_row_cells_written {
            self.follow_output();
        }
    }

    fn record_title(&mut self) {
        let title = self.screen().title();
        {
            let mut record = self.links.shared.record.lock().unwrap();
            if record.title.as_deref() == title {
                return;
            }
            record.title = title.map(str::to_owned);
        }
        self.publish_soon();
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
    fn end_run(&mut self, exit: ProcessExit, stopped: bool, stopped_by: Option<AgentRef>) {
        self.publish_at = None;
        self.state.ended(&exit, stopped);
        let creator = self.links.shared.record.lock().unwrap().info.creator_ref();
        self.observed_end = !stopped || stopped_by.is_none() || stopped_by != creator;
        self.process = ProcessState::Ended;
        self.exit = Some(exit.clone());
        self.record_state();
        self.report_trouble();
        self.publish();
        self.viewers.note_exit(Instant::now());
        self.stop_input(&format!("{} ended", self.id));
        self.readiness.end();
        self.ready_at = None;
        (self.start_prompt_bytes, self.prompt_ready) = (None, None);
        self.links.room.notify_waiters();
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
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        self.viewers.send_exit(screen.screen(), &exit);
        self.admit_viewers();
    }

    /// Reserves the next run and waits for room to log its eventual screen reset.
    async fn prepare_restart(
        &mut self,
        run: u64,
        cols: u16,
        rows: u16,
        reply: oneshot::Sender<()>,
    ) {
        // The new run's output goes on in the screen and its log.
        self.screen_mut().hold_with_log().await;
        self.record_title();
        // Input bound to the ended run is refused from now on, also for senders waiting for room.
        self.run = run;
        self.links.shared.run.store(run, Ordering::SeqCst);
        self.stop_input(&format!("{} is resuming", self.id));
        self.pending_size = None;
        self.links.room.notify_waiters();
        self.next_run = Some((run, Size { cols, rows }));
        self.early_exit = None;
        self.readiness.end();
        self.ready_at = None;
        self.nudge_until = None;
        self.terminal.detach();
        if self.screen().is_full() {
            self.pending_restart = Some(reply);
        } else {
            let _ = reply.send(());
        }
    }

    /// Viewers get the ended run's end. The actor records the cleared screen, fresh terminal modes
    /// and new size in the screen log.
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
    /// daemon, and its first row.
    fn read_screen_input(&self) -> BoxReading {
        self.read_input_box(false)
    }

    fn read_input_box(&self, untouched_input: bool) -> BoxReading {
        read_box(
            self.input_rule,
            self.ended(),
            self.undrawn,
            self.screen().screen(),
            untouched_input,
        )
    }

    /// Lets the typist take its next step and queues what it writes.
    fn type_next(&mut self) {
        self.typist_at = None;
        // A quiet agent types nothing: the next daemon types what is left.
        if self.quiet {
            return;
        }
        let now = Instant::now();
        self.finish_escape(now);
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        let modes = Modes {
            bracketed_paste: screen.screen().bracketed_paste(),
            application_cursor_keys: screen.screen().application_cursor_keys(),
            working: self.links.shared.record.lock().unwrap().info.state
                == ManagedAgentState::Working,
        };
        let written = self.terminal.written();
        let queued = written + self.terminal.queued() as u64;
        let probing = self.typist.probing();
        let pasting = self.typist.pasting();
        let (rule, ended, undrawn) = (self.input_rule, self.ended(), self.undrawn);
        let untouched_input = self.untouched_input;
        // The screen stays as it is during a step: it is read once, where the step needs it.
        let reading = OnceCell::new();
        let read_screen = || {
            let read = || read_box(rule, ended, undrawn, screen.screen(), untouched_input);
            reading.get_or_init(read).clone()
        };
        // With a paste in the input, what that shows may be the paste alone.
        if self.person.unshown_until().is_some() && !self.typist.occupies_input() {
            self.person.sees(&read_screen());
        }
        let unshown_until = self.person.unshown_until();
        // Messages wait behind what the run's start does first and behind the person's keys.
        let start_first = self.readiness.readies_tools() || self.start_prompt_bytes.is_some();
        let held_first = match self.held.front() {
            Some((_, Input::Raw(_))) => !pasting,
            first => self.holds_input_for_probe && first.is_some(),
        };
        let person_submitting = pasting && !self.submitting.is_empty();
        let partial_until = self.person.partial_until(now);
        let writes = if self.escape_may_edit {
            BoxWrites::AwaitingEscape
        } else if start_first || held_first || self.person_first(now) || person_submitting {
            BoxWrites::ObserveOnly
        } else {
            BoxWrites::Allowed
        };
        // The output proves the tracked Enter took the draft as soon as the frames show it.
        let submitted = self
            .submitting
            .front()
            .filter(|submission| self.submission_confirmed(submission))
            .and_then(|submission| submission.over.as_deref());
        let awaiting_after_interaction = self
            .submitting
            .front()
            .is_some_and(|submission| submission.after_interaction);
        let observe = || {
            let current = read_screen();
            InputObservation {
                current,
                submitted,
                awaiting_after_interaction,
            }
        };
        let step = self
            .typist
            .step(now, written, queued, modes, writes, &observe);
        let still_probing = self.typist.probing();
        if !probing && still_probing && untouched_input {
            self.holds_input_for_probe =
                !read_box(rule, ended, undrawn, screen.screen(), false).unsure;
        }
        if !pasting && self.typist.pasting() && !step.write.is_empty() {
            self.escape_may_edit = false;
            self.terminal.observe_paste_from(queued + 1);
        }
        self.terminal.push(&step.write);
        let shown_by = (unshown_until.into_iter())
            .chain(partial_until)
            .min()
            .filter(|_| self.typist.reads_input() || self.escape_may_edit);
        self.typist_at = step.wake.into_iter().chain(shown_by).min();
        let submitted = self.take_typed();
        if pasting && !self.typist.pasting() && !submitted {
            self.untouched_input = false;
        }
        if probing && !still_probing {
            self.holds_input_for_probe = false;
            if self.readiness.is_under_way() {
                self.ready_at = Some(Instant::now());
            }
        }
    }

    /// What the typist submitted is said to the agent, and an Enter it typed asks the CLI to do
    /// something, unless the start holds the other input and types its own keys alone.
    fn take_typed(&mut self) -> bool {
        let submission = self.typist.take_submitted();
        let submitted = submission.is_some();
        if let Some(submission) = submission {
            self.state.said(submission);
            self.state_changed = true;
        }
        if self.typist.take_entered() && !self.start_holds_input() {
            self.state.asked();
            self.state_changed = true;
        }
        submitted
    }

    /// Whether keys of the person's that went on come before what the typist writes into the input by
    /// itself: the input has yet to show them, they are in the middle of a paste or an escape
    /// sequence, or their Enter waits.
    fn person_first(&self, now: Instant) -> bool {
        self.held_enter.is_some()
            || self.person.unshown_until().is_some()
            || self.person.is_writing(now)
    }

    /// Whether the run's start holds keys and calls now. The input is read only while it might.
    fn start_holds_input(&self) -> bool {
        self.readiness.readies_tools()
            && self
                .readiness
                .holds_input(self.typist.recall(self.read_screen_input()).info.state)
    }

    /// One step of the run's start; the keys it asks for go to the typist.
    fn step_start(&mut self) {
        let now = Instant::now();
        let reading = self.typist.recall(self.read_screen_input());
        // An input that may hold a hint or a draft is probed; the start waits on what it finds.
        if reading.unsure && self.readiness.readies_tools() && !self.person_first(now) {
            self.typist.want_probe();
        }
        let input = reading.info.state;
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
    }

    /// Lets external input go on in the order it came, up to what has to wait.
    fn release_held(&mut self) {
        while let Some((came, next)) = self.held.front()
            && !self.waits(*came, next)
        {
            match self.held.pop_front().expect("held input") {
                (came, Input::Raw(keys)) => self.take_keys(came, keys),
                (_, typed) => {
                    self.give_typist(typed);
                    self.type_next();
                }
            }
            // A message that waited for it looks at the input again.
            if self.typist.reads_input() {
                self.typist_at = Some(Instant::now());
            }
        }
        self.ordered_input &= self.typist.sequence_pending() || !self.held.is_empty();
    }

    /// Whether `next`, the first held input, which came at `came`, waits: behind the probe under
    /// way, an ordered sequence, the person's Enter, what the run's start types, or a message that
    /// goes into the input.
    fn waits(&self, came: Instant, next: &Input) -> bool {
        // A quiet agent holds nothing back, as the next daemon has none of it.
        if self.quiet {
            return false;
        }
        if self.holds_input_for_probe
            || self.typist.sequence_pending()
            || (self.ordered_input && self.typist.types_calls())
            || self.held_enter.is_some()
            || self.start_holds_input()
        {
            return true;
        }
        match next {
            Input::Raw(keys) => {
                self.person.edits(keys)
                    && (self.person.due(came) > Instant::now() || self.paste_holds_keys())
            }
            // Let the first prompt arrive unless the native CLI is asking for input.
            sequence => {
                sequence.is_sequence()
                    && self.start_prompt_bytes.is_some()
                    && self.read_screen_input().info.state != InputState::Interaction
            }
        }
    }

    /// Whether the person's keys would mix into a message: its paste is in the input and the CLI has
    /// not taken it, for as long as a slow CLI takes. A menu or question of the CLI's own takes them
    /// at once.
    fn paste_holds_keys(&self) -> bool {
        let until = self.typist.paste_hold_until();
        until.is_some_and(|until| Instant::now() < until)
            && self.read_screen_input().info.state != InputState::Interaction
    }

    /// When the first held input may go though nothing else happens.
    fn held_wake(&self) -> Option<Instant> {
        let (came, _) = self.held.front()?;
        let now = Instant::now();
        [Some(self.person.due(*came)), self.typist.paste_hold_until()]
            .into_iter()
            .flatten()
            .filter(|at| *at > now)
            .min()
    }

    /// Drops queued input and fails the typist's calls: `why` typing stopped.
    fn stop_input(&mut self, why: &str) {
        self.terminal.clear();
        self.holds_input_for_probe = false;
        self.ordered_input = false;
        self.person = PersonKeys::default();
        self.escape_may_edit = false;
        self.held_enter = None;
        self.submitting.clear();
        // Held calls fail with the others; held keys go with the queued ones.
        for (_, input) in std::mem::take(&mut self.held) {
            self.give_typist(input);
        }
        self.typist.fail_all(self.terminal.written(), why);
        self.typist_at = None;
        self.take_typed();
    }

    /// The person's keys. An Enter that may submit the input waits, with the keys after it, until
    /// the input can be read; a CLI without a rule has no input to read.
    fn take_keys(&mut self, came: Instant, mut keys: Vec<u8>) {
        let PersonInput {
            edits,
            first_edit,
            partial_start,
            enter,
            ..
        } = self.person.read(&keys);
        if !self.submitting.is_empty() {
            let first = self.queued_through() + 1;
            match (first_edit, partial_start) {
                (Some(KeyOffset::Carried), _) => self.terminal.confirm_following_edit(),
                (Some(KeyOffset::Packet(at)), _) => {
                    self.terminal.forget_provisional_edit();
                    self.terminal
                        .observe_following_edit(first + at as u64, false);
                }
                (None, Some(KeyOffset::Carried)) => {}
                (None, Some(KeyOffset::Packet(at))) => {
                    self.terminal.forget_provisional_edit();
                    self.terminal
                        .observe_following_edit(first + at as u64, true);
                }
                (None, None) => self.terminal.forget_provisional_edit(),
            }
        }
        if edits {
            self.person.goes_on(came);
        }
        // The prefix keeps its original input context through classification and later frames.
        if first_edit == Some(KeyOffset::Carried) && self.escape_may_edit {
            self.note_input_edited();
        }
        if partial_start != Some(KeyOffset::Carried) {
            self.escape_may_edit = false;
        }
        let starts_escape =
            matches!(partial_start, Some(KeyOffset::Packet(_))) && !self.person.is_pasting();
        let edits_input = edits && (first_edit.is_some() || enter.is_some());
        if edits_input || starts_escape {
            self.observe_person_keys(edits_input, starts_escape);
        }
        let mut pastes = None;
        if let Some(enter) = enter {
            self.state.asked();
            self.state_changed = true;
            let after = keys.split_off(enter.at + 1);
            if !after.is_empty() {
                self.held.push_front((came, Input::Raw(after)));
            }
            if self.input_rule.is_some() {
                keys.pop();
                pastes = Some(enter.pastes);
            }
        }
        self.terminal.push(&keys);
        if let Some(pastes) = pastes {
            self.held_enter = Some(HeldEnter::new(came, self.queued_through(), pastes));
            if self.quiet {
                self.let_enter_go();
            } else {
                // What came before it may show already.
                self.follow_enter();
            }
        }
    }

    fn observe_person_keys(&mut self, edits_input: bool, starts_escape: bool) {
        let reading = self.read_screen_input();
        if reading.info.state == InputState::Interaction {
            // A menu or question of the CLI's own takes the keys in the input's place.
            self.person.sees(&reading);
        } else {
            self.escape_may_edit |= starts_escape;
            if edits_input {
                self.note_input_edited();
            }
        }
    }

    fn note_input_edited(&mut self) {
        self.untouched_input = false;
        self.typist.input_edited();
    }

    /// Resolves the provisional submission boundary when the escape wait ends.
    fn finish_escape(&mut self, now: Instant) {
        if self.person.finish_escape(now) {
            self.terminal.confirm_following_edit();
            if std::mem::take(&mut self.escape_may_edit) {
                self.note_input_edited();
            }
            let reading = self.read_screen_input();
            if reading.info.state == InputState::Interaction {
                self.person.sees(&reading);
            }
        }
    }

    /// Through which byte the input is queued.
    fn queued_through(&self) -> u64 {
        self.terminal.written() + self.terminal.queued() as u64
    }

    /// A held Enter goes now: an agent that reads its terminal no more cannot see the input drawn.
    fn let_enter_go(&mut self) {
        if let Some(held) = self.held_enter.as_mut() {
            held.release_now();
            self.follow_enter();
        }
    }

    /// When the CLI last drew the input, if it has the bytes through `sent_through` and drew after.
    fn drawn_since(&self, sent_through: u64) -> Option<Instant> {
        let written_at = self.terminal.written_at();
        self.input_drawn_at.filter(|drawn| {
            self.terminal.written() >= sent_through && written_at.is_none_or(|at| *drawn >= at)
        })
    }

    /// When to follow a held Enter or retire the oldest submission without new output.
    fn enter_wake(&self) -> Option<Instant> {
        let now = Instant::now();
        let held = self.held_enter.as_ref().map(|enter| {
            let quiet = self
                .drawn_since(enter.sent_through)
                .map(|drawn| (drawn + ENTER_DRAWN_AFTER).max(now + ENTER_READ_AGAIN));
            quiet.map_or(enter.release_at, |at| at.min(enter.release_at))
        });
        let submitted = self.submitting.front().map(|submission| {
            if self.submission_cut_off(submission) {
                now
            } else if self.terminal.next_edit_is_provisional()
                && (self.escape_may_edit || self.person.lone_escape())
            {
                let escape_wait = self.person.partial_until(now).unwrap_or(now);
                submission.until.min(escape_wait)
            } else {
                submission.until
            }
        });
        held.into_iter().chain(submitted).min()
    }

    fn follow_enter(&mut self) {
        let now = Instant::now();
        self.finish_escape(now);
        let finished = self.follow_submitted_enters(now);
        let released = self.follow_held_enter(now);
        if (finished || (released && self.submitting.is_empty())) && self.typist.reads_input() {
            self.typist_at = Some(now);
        }
    }

    /// Retires Enter evidence in the order its output became readable.
    fn follow_submitted_enters(&mut self, now: Instant) -> bool {
        let count = self.submitting.len();
        while let Some(submission) = self.submitting.front() {
            let confirmed = self.submission_confirmed(submission);
            if !confirmed && now < submission.until && !self.submission_cut_off(submission) {
                break;
            }

            // The typist can use this proof while the Enter is still at the head of the queue.
            if confirmed && self.typist.pasting() {
                self.type_next();
            }
            let submission = self.submitting.pop_front().expect("the oldest Enter");
            self.terminal
                .finish_observing_submission(submission.through);
            if confirmed && let Some(over) = submission.over {
                let draft = over.draft.unwrap_or_default();
                let text = match self.typist.paste_rule() {
                    // A long paste the CLI shows as a placeholder is said as what was pasted.
                    Some(rule) => facade_rules::with_paste_text(rule, &draft, &submission.pastes),
                    None => draft,
                };
                self.state.said(Submission {
                    text,
                    sender: Sender::person(),
                });
                self.state_changed = true;
            } else {
                if submission.after_interaction
                    && self.typist.draft_deadline() == Some(submission.until)
                    && let Some(next) = self.submitting.front_mut()
                {
                    // A newer Enter can still prove the batch by the same deadline.
                    next.after_interaction = true;
                    next.until = submission.until;
                }
                facade_base::service::mark_for_test("submission-untaken");
            }
        }
        self.submitting.len() != count
    }

    /// Lets Enter go when the preceding input was drawn, or when its hold expires.
    fn follow_held_enter(&mut self, now: Instant) -> bool {
        let Some(held) = self.held_enter.take() else {
            return false;
        };
        let drawn = self.drawn_since(held.sent_through);
        let whole = !self.screen().screen().is_drawing();
        let quiet = drawn.is_some_and(|drawn| now >= drawn + ENTER_DRAWN_AFTER);
        if !(whole && quiet) && now < held.release_at {
            self.held_enter = Some(held);
            return false;
        }
        let reading = whole.then(|| self.read_screen_input());
        let state = reading.as_ref().map(|reading| reading.info.state);
        let menu = state == Some(InputState::Interaction);
        let holds_draft = drawn.is_some() && state == Some(InputState::Draft);
        let over = reading.filter(|_| holds_draft);
        // A draft ending in a backslash is a line break to a CLI.
        let draft = over.as_ref().and_then(|reading| reading.draft.as_deref());
        let line_break = draft.is_some_and(|draft| draft.trim_end().ends_with('\\'));
        self.person.goes_on(held.came);
        self.terminal.push(b"\r");
        let through = self.queued_through();
        self.terminal.observe_following_edit(through, false);
        if !menu && !line_break {
            self.person.enters();
            let over = over.filter(|reading| reading.draft.is_some());
            if over.is_some() || self.typist.pasting() {
                self.terminal.observe_output_after(through);
                self.submitting
                    .push_back(Submitting::sent(over, held.pastes, through));
            }
        }
        true
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
        let asking = self.read_screen_input().info.state == InputState::Interaction;
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
        self.viewers.set_working(matches!(
            reading.state,
            ManagedAgentState::Starting | ManagedAgentState::Working
        ));
        if self.screen.is_some()
            && let Some(glyph) = self
                .glyph
                .update(&reading.state, self.state.has_report_evidence())
        {
            self.set_status_glyph(glyph);
        }
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
        let mut record = self.links.shared.record.lock().unwrap();
        let info = &mut record.info;
        if self.process == ProcessState::Ended {
            info.process = self.process;
            info.exit.clone_from(&self.exit);
        }
        let same = info.state == reading.state
            && info.state_detail == reading.detail
            && info.said == said
            && info.tools_state == reading.tools
            && info.tools_reason == reading.tools_reason;
        (info.state, info.state_detail, info.said) = (reading.state, reading.detail, said);
        (info.tools_state, info.tools_reason) = (reading.tools, reading.tools_reason);
        let trouble = Trouble::observe(info, self.observed_end);
        let urgent = matches!(
            info.state,
            ManagedAgentState::WaitingForYou | ManagedAgentState::Error
        );
        if trouble != self.trouble {
            self.trouble = trouble;
            self.watchdog_at = trouble.map(|trouble| trouble.deadline(Instant::now()));
            self.prompt_result = None;
            record.incident += 1;
        }
        (!same).then_some(urgent)
    }

    fn report_trouble(&mut self) {
        let (Some((prompt, report)), Some(trouble)) = (&self.watchdog, self.trouble) else {
            return;
        };
        if self.watchdog_at.take().is_none() && self.prompt_result.take().is_none() {
            return;
        }
        let (info, incident) = {
            let record = self.links.shared.record.lock().unwrap();
            (record.info.clone(), record.incident)
        };
        if let Some(prompt) = prompt {
            let reason = match trouble {
                Trouble::Waiting(_) => DeliveryFailure::InputInteraction,
                Trouble::Error => DeliveryFailure::Timeout,
                Trouble::Ended => DeliveryFailure::Ended,
            };
            match self
                .deliveries
                .prompt_notice(prompt, &info, incident, reason)
            {
                PromptNotice::Owned => return,
                PromptNotice::InFlight(settled) => {
                    self.prompt_result = Some(settled);
                    return;
                }
                PromptNotice::Report => {}
            }
        }
        report(info, trouble);
    }

    fn publish_state(&mut self) {
        match self.record_state() {
            Some(true) => self.publish_now(),
            Some(false) => self.publish_soon(),
            None => {}
        }
    }
}

/// A CLI's input as `rule` reads `screen`, with a draft's text and its first row. Unknown without a
/// rule, once the run `ended`, or while the screen may not show the input yet, `undrawn` saying why.
fn read_box(
    rule: Option<&InputRule>,
    ended: bool,
    undrawn: Option<&str>,
    screen: &facade_screen::Screen,
    untouched_input: bool,
) -> BoxReading {
    let unknown = |evidence: &str, rule: Option<&InputRule>| BoxReading {
        info: InputInfo {
            state: InputState::Unknown,
            evidence: evidence.to_string(),
            mechanism: rule.map(InputRule::mechanism),
            hidden: None,
        },
        draft: None,
        line: None,
        unsure: false,
    };
    match (rule, undrawn) {
        (None, _) => unknown("the agent has no CLI rule to read its input by", None),
        (Some(rule), _) if ended => unknown("the agent ended", Some(rule)),
        (Some(rule), Some(why)) => unknown(why, Some(rule)),
        (Some(rule), None) => super::with_screen_view(screen, |view| {
            facade_rules::read_box_for_typing(rule, view, untouched_input)
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use facade_base::model::message::DeliveryStatus;
    use facade_base::terminal::{TestCli, test_terminal};

    use super::*;
    use crate::agent::tests::{claude_trust_frame, plain_claude_frame, record};
    use crate::agent::{MessageTyping, StateStart};
    use crate::messages::Messages;
    use crate::messages::tests::{message, messages, post_new};

    async fn actor_with_cli(folder: &Path, deliveries: DeliveryHandle) -> (Actor, TestCli) {
        let (master, cli) = test_terminal(80, 24).unwrap();
        let info = record(ProcessState::Running, None, 80, 24);
        let (tools, tools_connections) = watch::channel(0);
        let links = Links {
            shared: Arc::new(Shared::new(info.clone())),
            room: Arc::new(Notify::new()),
            exit: watch::channel(None).0,
            settled: watch::channel(false).0,
            output: watch::channel(()).0,
            changes: broadcast::channel(16).0,
            _tools: Arc::new(tools),
            tools_connections,
        };
        let start = ActorStart {
            info,
            master: Some(master),
            screen: ScreenStart::New(folder.to_owned()),
            untouched_input: false,
            colors: TerminalColors::default(),
            rule: Some("claude".into()),
            captures: false,
            launch_command: None,
            deliveries,
            observed_loss: false,
            state: StateStart {
                file: super::super::state::state_file(folder),
                kept: Kept::default(),
                started: Instant::now(),
            },
        };
        let mut actor = new_actor(start, links, false).unwrap();
        actor.screen = Some(LoggedScreen::create(folder.to_owned(), "a1", 80, 24).await);
        (actor, cli)
    }

    /// Sends a paste without reading any of its output yet.
    async fn waiting_for_the_paste_frame(
        folder: &Path,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (messages, _) = messages();
        let (mut actor, cli) = actor_with_cli(folder, messages.delivery_handle()).await;
        draw_input(&mut actor, "");
        let deadline = Instant::now() + Duration::from_secs(20);
        let settled = queue_a_message(&mut actor, &messages, deadline);
        actor.type_next();
        write_input(&mut actor).await;
        (actor, cli, settled)
    }

    fn queue_a_message(
        actor: &mut Actor,
        messages: &Messages,
        deadline: Instant,
    ) -> watch::Receiver<Option<Settled>> {
        let text = "a message";
        let (kept, settled) = post_new(messages, message(0, "a1"));
        actor.typist.deliver(MessageTyping::new(
            text.into(),
            crate::messages::number(&kept),
            deadline,
            Submission {
                text: text.into(),
                sender: Sender::person(),
            },
        ));
        settled
    }

    /// Sends a paste and queues a person's Enter over it. The test controls the order of
    /// terminal writes and frames so that a frame can reach the actor ahead of the Enter.
    async fn waiting_for_the_person_s_enter(
        folder: &Path,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (mut actor, cli, settled) = waiting_for_the_paste_frame(folder).await;
        draw_input(&mut actor, "a message");
        actor.type_next();
        let over = actor.read_screen_input();
        assert_eq!(over.draft.as_deref(), Some("a message"));
        actor.terminal.push(b"\r");
        let through = actor.queued_through();
        actor.terminal.observe_output_after(through);
        actor
            .submitting
            .push_back(Submitting::sent(Some(over), Vec::new(), through));
        draw_input(&mut actor, "");
        (actor, cli, settled)
    }

    fn draw_input(actor: &mut Actor, draft: &str) {
        actor.feed_own(plain_claude_frame(draft, "").as_bytes());
        actor.input_drawn_at = Some(Instant::now());
    }

    async fn write_input(actor: &mut Actor) {
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready(TerminalWait::WriteOnly),
        )
        .await
        .expect("the terminal takes the queued input");
        assert!(matches!(event, TerminalEvent::Wrote));
    }

    async fn read_output(actor: &mut Actor, cli: &mut TestCli, bytes: &[u8]) {
        cli.write_output(bytes).unwrap();
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready(TerminalWait::ReadAndWrite),
        )
        .await
        .expect("output reaches the actor");
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
    }

    fn synchronized(frame: &str) -> String {
        format!("\x1b[?2026h{frame}\x1b[?2026l")
    }

    /// Queues the CLI's frames while the actor only writes, then passes it the person's Enter.
    async fn enter_while_reads_are_paused(
        home: &Path,
        before_enter: &str,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(home).await;
        let paste = b"\x1b[200~a message\x1b[201~";
        let mut input = [0; 64];
        let mut read = 0;
        while read < paste.len() {
            read += cli.read_input(&mut input[read..]).unwrap();
        }
        assert_eq!(&input[..read], paste);
        if !before_enter.is_empty() {
            cli.write_output(before_enter.as_bytes()).unwrap();
        }
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        actor.take_keys(Instant::now(), vec![b'\r']);
        actor.held_enter.as_mut().unwrap().release_now();
        actor.follow_enter();
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        assert_eq!(cli.read_input(&mut input).unwrap(), 1);
        assert_eq!(input[0], b'\r');
        (actor, cli, settled)
    }

    async fn read_buffered_frames(actor: &mut Actor, mut left: usize) {
        while left > 0 {
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor.terminal.ready(TerminalWait::ReadAndWrite),
            )
            .await
            .expect("buffered output can be read again");
            assert!(matches!(event, TerminalEvent::Read));
            left -= actor.terminal.output().len();
            actor.take_terminal(event);
        }
    }

    fn was_delivered(settled: &watch::Receiver<Option<Settled>>) -> bool {
        matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        )
    }

    /// While reads are paused, the CLI can draw both frames before the actor sees either one.
    async fn enter_while_output_waits(draft_before_enter: Option<bool>) -> bool {
        let home = crate::test_folder::TestFolder::new("actor-enter-with-output-waiting");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let before = if draft_before_enter == Some(true) {
            draft.as_str()
        } else {
            ""
        };
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, before).await;
        if draft_before_enter == Some(false) {
            cli.write_output(format!("{draft}{empty}").as_bytes())
                .unwrap();
        } else {
            cli.write_output(empty.as_bytes()).unwrap();
        }
        let left = empty.len() + draft_before_enter.map_or(0, |_| draft.len());
        read_buffered_frames(&mut actor, left).await;
        was_delivered(&settled)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_buffered_draft_followed_by_an_empty_frame_confirms_enter() {
        assert!(enter_while_output_waits(Some(true)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_draft_and_an_empty_frame_in_one_read_confirm_enter() {
        assert!(enter_while_output_waits(Some(false)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_frame_without_a_draft_cannot_confirm_enter() {
        assert!(!enter_while_output_waits(None).await);
    }

    async fn answered_buffered_menu(
        home: &Path,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let menu = synchronized(&claude_trust_frame(false));
        let before = format!("{draft}{menu}");
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(home, &before).await;
        let mut screen = facade_screen::Screen::new(80, 24, 0);
        screen.feed(menu.as_bytes());
        assert_eq!(
            read_box(actor.input_rule, false, None, &screen, false)
                .info
                .state,
            InputState::Interaction
        );

        let empty = synchronized(&format!("\x1b[?25h{}", plain_claude_frame("", "")));
        cli.write_output(empty.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, before.len() + empty.len()).await;
        assert!(settled.borrow().is_none(), "Enter only answered the menu");
        (actor, cli, settled)
    }

    #[tokio::test]
    async fn answering_a_buffered_menu_does_not_submit_the_preceding_draft() {
        let home = crate::test_folder::TestFolder::new("actor-enter-buffered-menu");
        let (mut actor, _cli, settled) = answered_buffered_menu(&home).await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(5)).await;
        actor.follow_enter();
        actor.type_next();
        assert!(
            settled.borrow().is_none(),
            "proof can still arrive by the deadline"
        );
        tokio::time::advance(Duration::from_secs(16)).await;
        actor.follow_enter();
        actor.type_next();
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the deadline settles delivery: {result:?}");
        };
        assert_eq!(
            message.delivery.reason,
            Some(DeliveryFailure::SubmissionUnconfirmed)
        );
    }

    #[tokio::test]
    async fn another_complete_draft_can_confirm_a_submission_after_a_menu() {
        let home = crate::test_folder::TestFolder::new("actor-enter-after-menu");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        read_buffered_frames(&mut actor, draft.len()).await;

        // An overlay can draw away from the cursor's row and leave the old draft in place.
        let question = claude_trust_frame(false).replacen("\x1b[2J\x1b[H", "\x1b7\x1b[5;1H", 1);
        let menu = synchronized(&format!("{question}\x1b8"));
        let mut screen = facade_screen::Screen::new(80, 24, 0);
        screen.feed(draft.as_bytes());
        assert!(!screen.feed(menu.as_bytes()).cursor_row_cells_written);
        assert_eq!(
            read_box(actor.input_rule, false, None, &screen, false)
                .info
                .state,
            InputState::Interaction
        );
        cli.write_output(menu.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, menu.len()).await;

        let empty = synchronized(&format!("\x1b[?25h{}", plain_claude_frame("", "")));
        cli.write_output(empty.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, empty.len()).await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(5)).await;
        actor.follow_enter();
        actor.type_next();
        assert!(
            settled.borrow().is_none(),
            "the draft before the menu was invalidated"
        );
        tokio::time::resume();

        cli.write_output(format!("{draft}{empty}").as_bytes())
            .unwrap();
        read_buffered_frames(&mut actor, draft.len() + empty.len()).await;
        assert!(was_delivered(&settled));
    }

    async fn edit_while_output_waits(key: u8, empty_before_edit: bool) -> bool {
        let home = crate::test_folder::TestFolder::new("actor-edit-with-output-waiting");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        if empty_before_edit {
            cli.write_output(empty.as_bytes()).unwrap();
        }
        // At the paste's hold limit, the next key goes while reads are still paused.
        actor.take_keys(Instant::now(), vec![key]);
        if key == b'\r' {
            actor.let_enter_go();
        }
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let mut input = [0; 1];
        assert_eq!(cli.read_input(&mut input).unwrap(), 1);
        assert_eq!(input, [key]);
        if !empty_before_edit {
            cli.write_output(empty.as_bytes()).unwrap();
        }
        read_buffered_frames(&mut actor, draft.len() + empty.len()).await;
        was_delivered(&settled)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_key_after_a_buffered_empty_frame_cannot_undo_delivery() {
        assert!(edit_while_output_waits(b'x', true).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ctrl_c_after_a_buffered_empty_frame_cannot_undo_delivery() {
        assert!(edit_while_output_waits(0x03, true).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn escape_after_a_buffered_empty_frame_cannot_undo_delivery() {
        assert!(edit_while_output_waits(0x1b, true).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_enter_cannot_undo_a_buffered_submission() {
        assert!(edit_while_output_waits(b'\r', true).await);
        assert!(!edit_while_output_waits(b'\r', false).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_held_enter_cannot_undo_a_buffered_submission() {
        let home = crate::test_folder::TestFolder::new("actor-held-enter-after-submission");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        cli.write_output(empty.as_bytes()).unwrap();
        actor.take_keys(Instant::now(), vec![b'\r']);
        assert!(actor.held_enter.is_some());
        read_buffered_frames(&mut actor, draft.len() + empty.len()).await;
        assert!(was_delivered(&settled));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_enter_can_submit_a_draft_redrawn_after_the_first() {
        let home = crate::test_folder::TestFolder::new("actor-next-enter-with-a-draft");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        cli.write_output(draft.as_bytes()).unwrap();
        actor.take_keys(Instant::now(), vec![b'\r']);
        actor.let_enter_go();
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let mut input = [0; 1];
        assert_eq!(cli.read_input(&mut input).unwrap(), 1);
        assert_eq!(input, [b'\r']);
        cli.write_output(empty.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, 2 * draft.len() + empty.len()).await;
        assert!(was_delivered(&settled));
    }

    async fn write_person_bytes(actor: &mut Actor, cli: &mut TestCli, bytes: &[u8]) {
        actor.take_keys(Instant::now(), bytes.to_vec());
        write_input(actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let mut input = vec![0; bytes.len()];
        let n = cli.read_input(&mut input).unwrap();
        assert_eq!(&input[..n], bytes);
    }

    async fn focus_while_output_waits(parts: &[&[u8]]) -> bool {
        let home = crate::test_folder::TestFolder::new("actor-focus-with-output-waiting");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        for part in parts {
            if actor.person.lone_escape() {
                actor.person.goes_on(Instant::now());
            }
            write_person_bytes(&mut actor, &mut cli, part).await;
        }
        cli.write_output(empty.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, draft.len() + empty.len()).await;
        was_delivered(&settled)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_focus_report_does_not_interrupt_a_submission() {
        for report in [b"\x1b[I", b"\x1b[O"] {
            assert!(focus_while_output_waits(&[report]).await);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_fragmented_focus_report_does_not_interrupt_a_submission() {
        for report in [b"\x1b[I", b"\x1b[O"] {
            for cut in 1..report.len() {
                let (prefix, rest) = report.split_at(cut);
                assert!(focus_while_output_waits(&[prefix, rest]).await);
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_submission_waits_for_a_split_report_to_be_classified() {
        let home = crate::test_folder::TestFolder::new("actor-split-focus-and-empty");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        write_person_bytes(&mut actor, &mut cli, b"\x1b[").await;
        cli.write_output(empty.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, draft.len() + empty.len()).await;
        assert!(
            settled.borrow().is_none(),
            "the report could still be a key"
        );
        write_person_bytes(&mut actor, &mut cli, b"O").await;
        assert!(was_delivered(&settled));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_focus_report_tail_and_second_enter_preserve_the_first_receipt() {
        let home = crate::test_folder::TestFolder::new("actor-focus-tail-and-enter");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        write_person_bytes(&mut actor, &mut cli, b"\x1b[").await;
        cli.write_output(empty.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, draft.len() + empty.len()).await;
        assert!(settled.borrow().is_none());
        assert!(
            actor
                .submitting
                .front()
                .is_some_and(|submission| submission.cleared_at.is_some())
        );

        // The report finishes in the same packet as the next Enter.
        actor.take_keys(Instant::now(), b"I\r".to_vec());
        actor.let_enter_go();
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let mut input = [0; 2];
        let mut read = 0;
        while read < input.len() {
            let n = cli.read_input(&mut input[read..]).unwrap();
            assert!(n > 0);
            read += n;
        }
        assert_eq!(input, *b"I\r");
        assert!(
            was_delivered(&settled),
            "the first Enter already submitted the message: {:?}",
            settled.borrow().as_ref()
        );
    }

    async fn edit_after_a_report_prefix(empty_before_edit: bool) -> bool {
        let home = crate::test_folder::TestFolder::new("actor-focus-before-edit");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        write_person_bytes(&mut actor, &mut cli, b"\x1b").await;
        if empty_before_edit {
            cli.write_output(empty.as_bytes()).unwrap();
        }
        // This terminal sends the rest of the report within the Escape interval.
        actor.person.goes_on(Instant::now());
        write_person_bytes(&mut actor, &mut cli, b"[Ix").await;
        if !empty_before_edit {
            cli.write_output(empty.as_bytes()).unwrap();
        }
        read_buffered_frames(&mut actor, draft.len() + empty.len()).await;
        was_delivered(&settled)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_edit_after_the_end_of_a_report_cuts_off_at_its_own_write() {
        assert!(edit_after_a_report_prefix(true).await);
        assert!(!edit_after_a_report_prefix(false).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_edit_before_the_empty_frame_cannot_confirm_enter() {
        for key in [b'x', 0x03, 0x1b] {
            assert!(!edit_while_output_waits(key, false).await);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_person_s_enter_still_waits_when_the_input_reads_empty_before_it_is_written() {
        let home = crate::test_folder::TestFolder::new("actor-enter-unwritten");
        let (mut actor, _cli, settled) = waiting_for_the_person_s_enter(&home).await;
        assert_eq!(actor.terminal.queued(), 1);
        actor.follow_enter();
        assert!(
            !actor.submitting.is_empty(),
            "a frame before the Enter reached the terminal cannot confirm it"
        );
        assert!(settled.borrow().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_written_person_s_enter_over_a_message_waits_for_a_new_frame() {
        let home = crate::test_folder::TestFolder::new("actor-enter-old-frame");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&home).await;
        write_input(&mut actor).await;
        let wrote = actor.terminal.written_at().unwrap();
        actor.input_drawn_at = Some(wrote - Duration::from_millis(1));
        actor.take_terminal(TerminalEvent::Wrote);
        assert!(
            settled.borrow().is_none(),
            "an empty frame from before the Enter reached the terminal cannot settle delivery"
        );
        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the new frame settles delivery: {result:?}");
        };
        assert_eq!(message.delivery.status, DeliveryStatus::Success);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_title_after_the_person_s_enter_does_not_confirm_the_old_empty_frame() {
        let home = crate::test_folder::TestFolder::new("actor-enter-title");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&home).await;
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        read_output(&mut actor, &mut cli, b"\x1b]2;new title\x07").await;
        assert_eq!(actor.screen().title(), Some("new title"));
        assert!(settled.borrow().is_none(), "the title drew no new input");
        assert!(
            !actor.submitting.is_empty(),
            "the person's Enter still needs evidence"
        );

        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert!(matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn positioning_the_cursor_cannot_confirm_an_old_empty_input() {
        let folder = crate::test_folder::TestFolder::new("actor-enter-cursor-only");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&folder).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        write_input(&mut actor).await;
        let wrote = actor.terminal.written_at().unwrap();
        actor.input_drawn_at = Some(wrote - Duration::from_millis(1));
        actor.take_terminal(TerminalEvent::Wrote);
        assert!(settled.borrow().is_none());

        let (column, row) = actor.screen().screen().view().cursor;
        let same_position = format!("\x1b[{};{}H", row + 1, column + 1);
        read_output(&mut actor, &mut cli, same_position.as_bytes()).await;
        assert_eq!(actor.screen().screen().view().cursor, (column, row));
        assert!(
            settled.borrow().is_none(),
            "only the cursor was positioned at its current cell: {:?}",
            settled.borrow()
        );
        assert!(!actor.submitting.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn drawing_outside_the_input_cannot_confirm_an_old_empty_input() {
        let folder = crate::test_folder::TestFolder::new("actor-enter-other-row");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&folder).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        write_input(&mut actor).await;
        let wrote = actor.terminal.written_at().unwrap();
        actor.input_drawn_at = Some(wrote - Duration::from_millis(1));
        actor.take_terminal(TerminalEvent::Wrote);

        read_output(&mut actor, &mut cli, b"\x1b7\x1b[7;1Hprogress\x1b8").await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        assert!(
            settled.borrow().is_none(),
            "the frame changed a different row: {:?}",
            settled.borrow()
        );
        assert!(!actor.submitting.is_empty());

        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert!(matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_frame_already_in_the_pipe_cannot_confirm_a_person_s_enter() {
        let folder = crate::test_folder::TestFolder::new("actor-enter-output-buffered");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&folder).await;
        draw_input(&mut actor, "a message");
        assert_eq!(actor.terminal.queued(), 1);
        cli.write_output(plain_claude_frame("", "").as_bytes())
            .unwrap();

        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        assert!(settled.borrow().is_none());
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready(TerminalWait::ReadAndWrite),
        )
        .await
        .expect("the earlier frame reaches the actor");
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        assert!(
            settled.borrow().is_none(),
            "the frame was in the pipe before the Enter was written: {:?}",
            settled.borrow()
        );
        assert!(!actor.submitting.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ending_an_old_synchronized_frame_cannot_confirm_a_person_s_enter() {
        let folder = crate::test_folder::TestFolder::new("actor-enter-synced-backlog");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&folder).await;
        draw_input(&mut actor, "a message");
        let frame = format!("\x1b[?2026h{}", plain_claude_frame("", ""));
        cli.write_output(frame.as_bytes()).unwrap();

        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready(TerminalWait::ReadAndWrite),
        )
        .await
        .expect("the old synchronized update reaches the actor");
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
        assert!(actor.screen().screen().is_drawing());

        read_output(&mut actor, &mut cli, b"\x1b[?2026l").await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        assert!(settled.borrow().is_none());
        assert!(!actor.submitting.is_empty());

        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert!(matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_frame_drawn_right_after_the_cli_takes_enter_confirms_it() {
        let folder = crate::test_folder::TestFolder::new("actor-enter-fast-cli");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&folder).await;
        draw_input(&mut actor, "a message");
        let paste = b"\x1b[200~a message\x1b[201~";
        let mut taken = [0; b"\x1b[200~a message\x1b[201~".len()];
        let mut read = 0;
        while read < taken.len() {
            let count = cli.read_input(&mut taken[read..]).unwrap();
            assert!(count > 0);
            read += count;
        }
        assert_eq!(&taken, paste);

        assert_eq!(actor.terminal.queued(), 1);
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let mut enter = [0];
        assert_eq!(cli.read_input(&mut enter).unwrap(), 1);
        assert_eq!(enter, [b'\r']);
        assert!(settled.borrow().is_none());

        // The only response is already available before the actor polls for output again.
        cli.write_output(plain_claude_frame("", "").as_bytes())
            .unwrap();
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready(TerminalWait::ReadAndWrite),
        )
        .await
        .expect("the CLI's response reaches the actor");
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        if let Some(wake) = actor.typist_at {
            tokio::time::sleep_until(wake + Duration::from_millis(2)).await;
            actor.type_next();
        }
        let result = settled.borrow();
        assert!(
            matches!(result.as_ref(), Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success),
            "the CLI took Enter and drew the whole empty input: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_empty_frame_in_the_same_read_as_an_old_sync_end_confirms_enter() {
        let end = "\x1b[?2026l";
        let response = format!("{end}{}", plain_claude_frame("", ""));
        let mut missed = Vec::new();
        for cut in [0, end.len() - 1, end.len(), end.len() + 1] {
            let folder = crate::test_folder::TestFolder::new("actor-enter-old-sync-end");
            let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&folder).await;
            draw_input(&mut actor, "a message");
            let old = format!("\x1b[?2026h{}", plain_claude_frame("a message", ""));
            cli.write_output(old.as_bytes()).unwrap();

            write_input(&mut actor).await;
            actor.take_terminal(TerminalEvent::Wrote);
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor.terminal.ready(TerminalWait::ReadAndWrite),
            )
            .await
            .expect("the old synchronized update reaches the actor");
            assert!(matches!(event, TerminalEvent::Read));
            actor.take_terminal(event);
            assert!(actor.screen().screen().is_drawing());

            let (first, later) = response.as_bytes().split_at(cut);
            if !first.is_empty() {
                read_output(&mut actor, &mut cli, first).await;
            }
            read_output(&mut actor, &mut cli, later).await;
            assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
            if !matches!(settled.borrow().as_ref(), Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success)
            {
                missed.push(cut);
            }
        }
        assert!(missed.is_empty(), "missing confirmation at cuts {missed:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_person_s_ctrl_c_voids_an_enter_that_left_the_message_unconfirmed() {
        let home = crate::test_folder::TestFolder::new("actor-enter-interrupted");
        let (mut actor, _cli, settled) = waiting_for_the_person_s_enter(&home).await;
        write_input(&mut actor).await;
        draw_input(&mut actor, "a message");
        // The paste's hold limit has passed and the person's interrupt can go in.
        actor.take_keys(Instant::now(), vec![0x03]);
        assert!(
            !actor.submitting.is_empty(),
            "the interrupt is still queued"
        );
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        assert!(actor.submitting.is_empty(), "the interrupt voids the Enter");
        draw_input(&mut actor, "");
        actor.type_next();
        assert!(!matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        ));
    }

    async fn draft_after_its_hold(
        home: &Path,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(home).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let mut paste = [0; b"\x1b[200~a message\x1b[201~".len()];
        let mut read = 0;
        while read < paste.len() {
            let n = cli.read_input(&mut paste[read..]).unwrap();
            assert!(n > 0);
            read += n;
        }
        assert_eq!(paste, *b"\x1b[200~a message\x1b[201~");
        draw_input(&mut actor, "a message");

        let hold = actor
            .typist
            .paste_hold_until()
            .expect("the paste holds keys");
        tokio::time::pause();
        tokio::time::advance(hold.saturating_duration_since(Instant::now())).await;
        tokio::time::resume();
        (actor, cli, settled)
    }

    async fn write_raw_escape(actor: &mut Actor, cli: &mut TestCli) {
        actor.take_input(Input::Raw(vec![0x1b]), actor.run).unwrap();
        write_input(actor).await;
        let mut key = [0];
        assert_eq!(cli.read_input(&mut key).unwrap(), 1);
        assert_eq!(key, [0x1b]);
        assert!(actor.held_enter.is_none() && actor.submitting.is_empty());
    }

    /// Puts the person's Escape on the wire just before a probe's second reading.
    async fn probe_waiting_for_escape(home: &Path) -> (Actor, TestCli, Arc<Messages>) {
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(home, messages.delivery_handle()).await;
        actor.feed_own(plain_claude_frame("", "\x1b[32mTry this\x1b[0m").as_bytes());
        assert!(actor.read_screen_input().unsure);
        actor.typist.want_probe();
        actor.type_next();
        assert!(actor.typist.probing());
        assert!(!actor.holds_input_for_probe);
        write_input(&mut actor).await;
        let mut key = [0];
        assert_eq!(cli.read_input(&mut key).unwrap(), 1);
        assert_eq!(key, [b' ']);
        actor.take_terminal(TerminalEvent::Wrote);
        read_output(&mut actor, &mut cli, plain_claude_frame(" ", "").as_bytes()).await;

        tokio::time::pause();
        let first_read = actor.typist_at.unwrap();
        tokio::time::advance(first_read.saturating_duration_since(Instant::now())).await;
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);
        let backspace_check = actor.typist_at.unwrap();
        let just_before = backspace_check - Duration::from_millis(5);
        tokio::time::advance(just_before.saturating_duration_since(Instant::now())).await;
        tokio::time::resume();
        write_raw_escape(&mut actor, &mut cli).await;

        tokio::time::pause();
        // Exclude native I/O scheduling time from the controlled classification interval.
        actor.person.goes_on(Instant::now());
        actor.take_terminal(TerminalEvent::Wrote);
        tokio::time::advance(backspace_check.saturating_duration_since(Instant::now())).await;
        assert!(actor.person.partial_until(Instant::now()).is_some());
        actor.type_next();
        let queued = actor.terminal.queued();
        if queued != 0 {
            tokio::time::resume();
            write_input(&mut actor).await;
            assert_eq!(cli.read_input(&mut key).unwrap(), 1);
            assert_eq!(key, [0x7f]);
        }
        assert_eq!(queued, 0, "the probe must wait for the person's Escape");
        (actor, cli, messages)
    }

    #[tokio::test]
    async fn a_probe_waits_for_a_standalone_escape_without_writing_backspace() {
        let home = crate::test_folder::TestFolder::new("actor-probe-standalone-escape");
        let (mut actor, _, _) = probe_waiting_for_escape(&home).await;
        let now = Instant::now();
        let classify_by = actor.person.partial_until(now).unwrap();
        assert_eq!(actor.typist_at, Some(classify_by));
        tokio::time::advance(classify_by - now).await;
        actor.type_next();
        assert!(!actor.person.lone_escape());
        assert!(!actor.typist.probing());
        assert_eq!(actor.terminal.queued(), 0);
    }

    #[tokio::test]
    async fn a_probe_resumes_after_an_escape_is_classified_as_a_focus_report() {
        let home = crate::test_folder::TestFolder::new("actor-probe-focus-report");
        let (mut actor, mut cli, _) = probe_waiting_for_escape(&home).await;
        tokio::time::resume();
        actor.person.goes_on(Instant::now());
        write_person_bytes(&mut actor, &mut cli, b"[I").await;
        assert_eq!(actor.terminal.queued(), 1);
        write_input(&mut actor).await;
        let mut key = [0];
        assert_eq!(cli.read_input(&mut key).unwrap(), 1);
        assert_eq!(key, [0x7f]);
    }

    #[tokio::test]
    async fn a_probe_ends_when_an_escape_sequence_stays_incomplete() {
        let home = crate::test_folder::TestFolder::new("actor-probe-incomplete-escape");
        let (mut actor, mut cli, _) = probe_waiting_for_escape(&home).await;
        tokio::time::resume();
        actor.person.goes_on(Instant::now());
        write_person_bytes(&mut actor, &mut cli, b"[").await;

        tokio::time::pause();
        let now = Instant::now();
        let classify_by = actor.person.partial_until(now).unwrap();
        assert_eq!(actor.typist_at, Some(classify_by));
        assert_eq!(actor.terminal.queued(), 0);
        tokio::time::advance(classify_by - now).await;
        actor.type_next();
        assert!(!actor.typist.probing());
        assert_eq!(actor.terminal.queued(), 0);

        tokio::time::resume();
        write_person_bytes(&mut actor, &mut cli, b"I").await;
        assert_eq!(
            actor.terminal.queued(),
            0,
            "the expired probe stays finished"
        );
    }

    #[tokio::test]
    async fn a_complete_empty_box_takes_the_next_paste_after_the_input_bound() {
        let home = crate::test_folder::TestFolder::new("actor-expired-escape-and-empty");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        draw_input(&mut actor, "the person's text");
        write_raw_escape(&mut actor, &mut cli).await;
        actor.person.goes_on(Instant::now());
        write_person_bytes(&mut actor, &mut cli, b"[").await;
        let deadline = Instant::now() + Duration::from_secs(20);
        let settled = queue_a_message(&mut actor, &messages, deadline);
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);

        tokio::time::pause();
        let now = Instant::now();
        let classify_by = actor.person.partial_until(now).unwrap();
        tokio::time::advance(classify_by - now).await;
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0, "the screen still shows a draft");
        tokio::time::resume();
        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);

        let expected = b"\x1b[200~a message\x1b[201~";
        assert_eq!(
            actor.terminal.queued(),
            expected.len(),
            "the expired prefix cannot hold the next paste"
        );
        write_input(&mut actor).await;
        let mut input = [0; 32];
        let mut read = 0;
        while read < expected.len() {
            let n = cli.read_input(&mut input[read..]).unwrap();
            assert!(n > 0);
            read += n;
        }
        assert_eq!(&input[..read], expected);
        assert!(settled.borrow().is_none());
    }

    #[tokio::test]
    async fn awaiting_escape_during_a_probe_keeps_a_waiting_messages_deadline() {
        let home = crate::test_folder::TestFolder::new("actor-probe-and-message-deadline");
        let (mut actor, mut cli, messages) = probe_waiting_for_escape(&home).await;
        tokio::time::resume();
        actor.person.goes_on(Instant::now());
        write_person_bytes(&mut actor, &mut cli, b"[").await;
        draw_input(&mut actor, "the person's text");
        assert_eq!(actor.read_screen_input().info.state, InputState::Draft);

        tokio::time::pause();
        let now = Instant::now();
        let deadline = now + Duration::from_millis(1500);
        let classify_by = actor.person.partial_until(now).unwrap();
        assert!(deadline < classify_by);
        let settled = queue_a_message(&mut actor, &messages, deadline);
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);
        assert!(settled.borrow().is_none());

        let wake = actor.typist_at.unwrap();
        tokio::time::advance(deadline - now).await;
        if wake <= deadline {
            actor.type_next();
        }
        assert!(
            matches!(
                settled.borrow().as_ref(),
                Some(Settled::Withdrawn(message)) if message.delivery.reason == Some(DeliveryFailure::InputDraft)
            ),
            "the receipt is due at the message's deadline, next wake was {wake:?}"
        );
        assert_eq!(wake, deadline);
        assert!(actor.typist.probing());
        assert_eq!(actor.terminal.queued(), 0);
    }

    #[tokio::test]
    async fn a_standalone_escape_invalidates_automatic_cleanup_without_an_enter() {
        let home = crate::test_folder::TestFolder::new("actor-escape-disowns-draft");
        let (mut actor, mut cli, settled) = draft_after_its_hold(&home).await;
        let deadline = actor
            .typist
            .draft_deadline()
            .expect("the paste has a deadline");
        write_raw_escape(&mut actor, &mut cli).await;
        // The CLI leaves the draft visible and the person sends no more input.
        tokio::time::pause();
        tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
        actor.type_next();
        assert_eq!(
            actor.terminal.queued(),
            0,
            "an Escape that reached the CLI must invalidate automatic cleanup"
        );
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the deadline settles delivery: {result:?}");
        };
        assert_eq!(
            message.delivery.reason,
            Some(DeliveryFailure::SubmissionUnconfirmed)
        );
    }

    async fn escape_around_a_menu(
        home: &Path,
        menu_first: bool,
    ) -> (Actor, watch::Receiver<Option<Settled>>) {
        let (mut actor, mut cli, settled) = draft_after_its_hold(home).await;
        let menu = synchronized(&claude_trust_frame(false));
        if menu_first {
            read_output(&mut actor, &mut cli, menu.as_bytes()).await;
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
        }
        write_raw_escape(&mut actor, &mut cli).await;
        assert!(actor.person.lone_escape());
        if !menu_first {
            read_output(&mut actor, &mut cli, menu.as_bytes()).await;
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
        }

        // The CLI shows a menu when the Escape is classified, then redraws the same draft.
        tokio::time::pause();
        let now = Instant::now();
        if let Some(until) = actor.person.partial_until(now) {
            tokio::time::advance(until - now).await;
        }
        actor.type_next();
        assert!(!actor.person.lone_escape());
        assert!(settled.borrow().is_none());

        let deadline = actor
            .typist
            .draft_deadline()
            .expect("the paste has a deadline");
        tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
        actor.feed_own(format!("\x1b[?25h{}", plain_claude_frame("a message", "")).as_bytes());
        assert_eq!(actor.read_screen_input().info.state, InputState::Draft);
        actor.type_next();
        (actor, settled)
    }

    #[tokio::test]
    async fn a_menu_redrawn_after_escape_cannot_hide_a_composer_edit() {
        let home = crate::test_folder::TestFolder::new("actor-escape-before-menu");
        let (actor, settled) = escape_around_a_menu(&home, false).await;
        assert_eq!(
            actor.terminal.queued(),
            0,
            "the earlier Escape touched the draft"
        );
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the deadline settles delivery: {result:?}");
        };
        assert_eq!(
            message.delivery.reason,
            Some(DeliveryFailure::SubmissionUnconfirmed)
        );
    }

    #[tokio::test]
    async fn an_escape_into_a_visible_menu_keeps_the_paste_under_care() {
        let home = crate::test_folder::TestFolder::new("actor-menu-before-escape");
        let (actor, _) = escape_around_a_menu(&home, true).await;
        assert_eq!(
            actor.terminal.queued(),
            "a message".len(),
            "the menu took the Escape"
        );
    }

    async fn draft_after_split_focus(
        home: &Path,
        menu_between: bool,
        tail: &[u8],
    ) -> (Actor, watch::Receiver<Option<Settled>>) {
        let (mut actor, mut cli, settled) = draft_after_its_hold(home).await;
        let deadline = actor
            .typist
            .draft_deadline()
            .expect("the paste has a deadline");
        write_raw_escape(&mut actor, &mut cli).await;
        if menu_between {
            actor.person.goes_on(Instant::now());
            let menu = synchronized(&claude_trust_frame(false));
            read_output(&mut actor, &mut cli, menu.as_bytes()).await;
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
        }
        assert!(actor.person.lone_escape());
        // The terminal completes the report within the Escape interval.
        actor.person.goes_on(Instant::now());
        actor
            .take_input(Input::Raw(tail.to_vec()), actor.run)
            .unwrap();
        write_input(&mut actor).await;
        let mut bytes = vec![0; tail.len()];
        let mut read = 0;
        while read < bytes.len() {
            let n = cli.read_input(&mut bytes[read..]).unwrap();
            assert!(n > 0);
            read += n;
        }
        assert_eq!(bytes, tail);
        assert!(!actor.person.lone_escape());

        tokio::time::pause();
        tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
        if menu_between {
            actor.feed_own(format!("\x1b[?25h{}", plain_claude_frame("a message", "")).as_bytes());
        }
        assert_eq!(actor.read_screen_input().info.state, InputState::Draft);
        actor.type_next();
        (actor, settled)
    }

    #[tokio::test]
    async fn a_fragmented_focus_report_leaves_an_expired_own_draft_erasable() {
        let home = crate::test_folder::TestFolder::new("actor-focus-and-expired-draft");
        let (actor, _) = draft_after_split_focus(&home, false, b"[I").await;
        assert_eq!(actor.terminal.queued(), "a message".len());
    }

    #[tokio::test]
    async fn a_split_focus_report_with_a_menu_between_its_bytes_keeps_cleanup() {
        let home = crate::test_folder::TestFolder::new("actor-focus-across-menu");
        let (actor, _) = draft_after_split_focus(&home, true, b"[I").await;
        assert_eq!(actor.terminal.queued(), "a message".len());
    }

    #[tokio::test]
    async fn a_personal_edit_after_a_split_focus_report_disowns_the_paste() {
        let home = crate::test_folder::TestFolder::new("actor-edit-after-split-focus");
        let (actor, settled) = draft_after_split_focus(&home, false, b"[Ix").await;
        assert_eq!(actor.terminal.queued(), 0);
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the deadline settles delivery: {result:?}");
        };
        assert_eq!(
            message.delivery.reason,
            Some(DeliveryFailure::SubmissionUnconfirmed)
        );
    }

    #[tokio::test]
    async fn an_unclassified_escape_defers_cleanup_beyond_the_receipt_deadline() {
        let home = crate::test_folder::TestFolder::new("actor-focus-pending-at-deadline");
        let (mut actor, mut cli, settled) = draft_after_its_hold(&home).await;
        let deadline = actor
            .typist
            .draft_deadline()
            .expect("the paste has a deadline");
        tokio::time::pause();
        let just_before = deadline - Duration::from_secs(1);
        tokio::time::advance(just_before.saturating_duration_since(Instant::now())).await;
        tokio::time::resume();
        write_raw_escape(&mut actor, &mut cli).await;
        actor.person.goes_on(Instant::now());
        write_person_bytes(&mut actor, &mut cli, b"[").await;
        assert!(actor.person.partial_until(deadline).is_some());

        tokio::time::pause();
        tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);
        assert!(matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message))
                if message.delivery.reason == Some(DeliveryFailure::SubmissionUnconfirmed)
        ));

        tokio::time::resume();
        actor.take_input(Input::Raw(vec![b'I']), actor.run).unwrap();
        write_input(&mut actor).await;
        let mut tail = [0];
        assert_eq!(cli.read_input(&mut tail).unwrap(), 1);
        assert_eq!(tail, [b'I']);
        actor.type_next();
        assert_eq!(actor.terminal.queued(), "a message".len());
    }

    #[tokio::test]
    async fn an_expired_escape_sequence_disowns_the_old_paste() {
        let home = crate::test_folder::TestFolder::new("actor-expired-escape-and-draft");
        let (mut actor, mut cli, settled) = draft_after_its_hold(&home).await;
        let deadline = actor.typist.draft_deadline().unwrap();
        write_person_bytes(&mut actor, &mut cli, b"\x1b[").await;

        tokio::time::pause();
        let now = Instant::now();
        let classify_by = actor.person.partial_until(now).unwrap();
        assert!(classify_by < deadline);
        tokio::time::advance(deadline - now).await;
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);
        assert!(matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message))
                if message.delivery.reason == Some(DeliveryFailure::SubmissionUnconfirmed)
        ));

        tokio::time::resume();
        write_person_bytes(&mut actor, &mut cli, b"I").await;
        assert_eq!(
            actor.terminal.queued(),
            0,
            "a late tail does not restore ownership"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_lone_escape_voids_the_person_s_enter_without_more_keys() {
        let home = crate::test_folder::TestFolder::new("actor-enter-lone-escape");
        let (mut actor, _cli, settled) = waiting_for_the_person_s_enter(&home).await;
        write_input(&mut actor).await;
        draw_input(&mut actor, "a message");
        actor.take_keys(Instant::now(), vec![0x1b]);
        write_input(&mut actor).await;
        draw_input(&mut actor, "");
        actor.type_next();
        assert!(
            settled.borrow().is_none(),
            "Escape could have cleared the draft"
        );
        tokio::time::sleep_until(actor.enter_wake().expect("the Escape must be classified")).await;
        actor.type_next();
        assert!(actor.enter_wake().is_some_and(|at| at <= Instant::now()));
        actor.follow_enter();
        assert!(actor.submitting.is_empty());
        actor.type_next();
        assert!(settled.borrow().is_none());
    }
}
