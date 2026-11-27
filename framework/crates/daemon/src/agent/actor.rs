//! The actor task: it owns the terminal, the logged screen, the state, the status glyph, the
//! typist, the viewers and the start of each run, and passes what one of them learns to the others.
//! None of them calls another.
//!
//! The record is shared with the handles under a leaf lock. Only the actor changes it once it runs,
//! and only here are changes published: at once for a start, an exit, a rename, a membership change
//! and a CLI that waits for the person or reports an error, otherwise batched.

use std::cell::OnceCell;
use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use facade_base::api_v1::Size;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::DeliveryFailure;
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::{
    model::agent::{
        AgentRef, AgentsUpdate, ManagedAgent, ManagedAgentState, StateReason, ToolsReason,
        ToolsState, WaitKind,
    },
    model::terminal::{DEFAULT_TERMINAL_SIZE, InputInfo, InputState},
};
use facade_rules::{BoxReading, InputRule, Rule};
use facade_screen::{CursorRowWrites, InputEvent, ParsedOutput, StatusEvent, TerminalColors};
use tokio::sync::{Notify, broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::glyph::Glyph;
use super::input_gate::InputGate;
use super::person::{
    ENTER_DRAWN_AFTER, ENTER_READ_AGAIN, HeldEnter, KeyOffset, PersonInput, PersonKeys, Submitting,
};
use super::readiness::{Press, Readiness, StartView};
use super::screen::LoggedScreen;
use super::state::{Kept, StateTracker, Viewing, keep};
use super::terminal::{
    CheckedInput, DeliveryInput, MAX_READ_BYTES, ProbeKey, Terminal, TerminalEvent, TerminalWait,
    WriteFenceAction,
};
use super::typist::{
    BoxWrites, DeliveryWrite, InputObservation, MessageTyping, Modes, Typing, Typist,
};
use super::viewers::{ViewKind, ViewerRequest, Viewers};
use super::{
    ActorStart, AgentCommand, FIRST_RUN, Input, InputRejection, Inspection, MAX_INPUT_BYTES,
    ScreenStart, Shared, Submission, ToolsConnections, WatchdogSink,
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
const ERASE_SAVED_LINES: &[u8] = b"\x1b[3J";
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

fn update_write_fence(typist: &mut Typist, action: WriteFenceAction) -> io::Result<bool> {
    match action {
        WriteFenceAction::Prepare {
            offset,
            count,
            erase,
        } => typist
            .before_actor_write(offset, count, erase)
            .ok_or_else(|| io::Error::other("could not save paste cleanup before writing")),
        WriteFenceAction::CancelUnissuedErase => {
            typist.cancel_unissued_erase();
            Ok(false)
        }
    }
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
    /// The actor changes the generation and whether it accepts tool connections.
    pub(super) tools: Arc<watch::Sender<ToolsConnections>>,
    pub(super) tools_connections: watch::Receiver<ToolsConnections>,
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
    let mut input_gate = InputGate::default();
    input_gate.report(tracker.native_wait());
    if recovered {
        input_gate.recover(tracker.uses_native_reports(), tracker.answers_ask());
    }
    let terminal = Terminal::new(master)?;
    Ok(Actor {
        id: info.agent_id.clone(),
        links,
        terminal,
        screen: None,
        screen_start: Some(screen),
        state: tracker,
        tools_config: state.tools_config,
        input_gate,
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
        recovered_empty: false,
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
        delivery_frames: DeliveryFrames::default(),
        redraw_nudge: None,
        cleanup_frame_after_drain: false,
        catch_up_at: None,
        publish_at: None,
        typist_at: None,
        pending_delivery: None,
        pending_tool_write: None,
        replies_dropped: false,
        untouched_input,
        before_input_box: untouched_input && !recovered,
        start_rows: untouched_input && !recovered,
    })
}

/// The input frames drawn after the typist's current submission or erase.
#[derive(Default)]
struct DeliveryFrames {
    drawn: Option<BoxReading>,
    /// The empty frame's output position while it awaits confirmation.
    pending_empty_at: Option<u64>,
    /// When the ready output first confirmed an eligible, complete empty frame.
    confirmed_empty_at: Option<Instant>,
}

impl DeliveryFrames {
    fn observe(&mut self, reading: BoxReading, position: u64, before_edit: bool, typist: &Typist) {
        if self.confirmed_empty_at.is_none() {
            match typist.delivery_frame_state(&typist.recall(reading.clone())) {
                InputState::Usable if typist.accepts_new_empty_evidence() => {
                    self.pending_empty_at.get_or_insert(position);
                }
                state
                    if before_edit
                        && self.pending_empty_at.is_some()
                        && (state == InputState::Draft || reading.paste_tail.is_some())
                        && typist.redraws_delivery_draft(&reading) =>
                {
                    self.pending_empty_at = None;
                }
                _ => {}
            }
        }
        self.drawn = Some(reading);
    }

    fn confirm_empty(&mut self) {
        self.pending_empty_at = None;
        self.confirmed_empty_at.get_or_insert_with(Instant::now);
    }
}

struct HeldInput {
    came: Instant,
    input: Input,
    startup_menu_keys: bool,
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
    /// The run's configured server file, kept until a connection deadline is reported.
    tools_config: Option<PathBuf>,
    input_gate: InputGate,
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
    /// An undecided escape sequence in the input box's context.
    escape_may_edit: bool,
    held_enter: Option<HeldEnter>,
    /// Issued Enters in input order, each waiting for its preceding output to be observed.
    submitting: VecDeque<Submitting>,
    /// External input in the order it came, with when: each goes on once nothing makes it wait.
    held: VecDeque<HeldInput>,
    /// Keep the held FIFO ordered through a sequence and the input it held back.
    ordered_input: bool,
    input_rule: Option<&'static InputRule>,
    /// Whether the running CLI reports its session.
    captures: bool,
    launch_command: Option<String>,
    /// Why the screen may not show the CLI's input yet; cleared once the CLI writes.
    undrawn: Option<&'static str>,
    /// The live drain at takeover already showed an empty box. It can only finish cleanup.
    recovered_empty: bool,
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
    delivery_frames: DeliveryFrames,
    redraw_nudge: Option<RedrawNudge>,
    /// A recovered cleanup observes paint only after the output already readable has been read.
    cleanup_frame_after_drain: bool,
    catch_up_at: Option<Instant>,
    publish_at: Option<Instant>,
    typist_at: Option<Instant>,
    pending_delivery: Option<PendingDelivery>,
    pending_tool_write: Option<PendingToolWrite>,
    /// Dropped terminal-query replies were logged.
    replies_dropped: bool,
    /// Automatic delivery can probe an unstyled hint in a fresh, untouched input box.
    untouched_input: bool,
    /// The input box has yet to appear in a fresh run.
    before_input_box: bool,
    /// A new session whose conversation has not begun: what its start pushed off the screen can go.
    start_rows: bool,
}

enum RedrawNudge {
    Restart(Instant),
    RecoveredCleanup,
}

/// The last size requested for this paste's redraw. A paused CLI could remember any size that
/// reached its terminal, including one the prior daemon never observed it draw at.
#[derive(serde::Deserialize, serde::Serialize)]
struct CleanupResize {
    paste: u64,
    size: (u16, u16),
}

impl CleanupResize {
    fn reserve(path: &Path, paste: u64, requested: (u16, u16)) -> io::Result<Option<(u16, u16)>> {
        let previous = match std::fs::read(path) {
            Ok(bytes) => Some(serde_json::from_slice::<Self>(&bytes).map_err(io::Error::other)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let (cols, rows) = previous
            .filter(|last| last.paste == paste)
            .map_or(requested, |last| {
                (requested.0.min(last.size.0), requested.1.min(last.size.1))
            });
        // Descend through distinct sizes so a CLI that missed one or more resizes still sees a
        // change. Prefer moving its bottom-aligned composer by a row.
        let size = if rows > 1 {
            (cols, rows - 1)
        } else if cols > 1 {
            (cols - 1, requested.1)
        } else {
            return Ok(None);
        };
        let temporary = path.with_extension("next");
        let output = facade_base::files::create_private_file(&temporary)?;
        serde_json::to_writer(&output, &Self { paste, size }).map_err(io::Error::other)?;
        output.sync_all()?;
        drop(output);
        std::fs::rename(temporary, path)?;
        facade_base::files::sync_folder(path.parent().expect("an agent screen folder"))?;
        Ok(Some(size))
    }
}

struct PendingDelivery {
    write: Vec<u8>,
    kind: DeliveryWrite,
    deadline: Instant,
    read_through: Option<u64>,
}

impl PendingDelivery {
    fn matches(&self, kind: DeliveryWrite) -> bool {
        std::mem::discriminant(&self.kind) == std::mem::discriminant(&kind)
    }

    fn terminal_input(&mut self) -> DeliveryInput<'_> {
        DeliveryInput {
            bytes: &self.write,
            read_through: &mut self.read_through,
            deadline: self.deadline,
            pastes: matches!(self.kind, DeliveryWrite::Paste),
            framed: !matches!(self.kind, DeliveryWrite::Erase { .. }),
        }
    }
}

struct PendingToolWrite {
    write: Vec<u8>,
    deadline: Instant,
    read_through: Option<u64>,
}

impl PendingToolWrite {
    fn terminal_input(&mut self) -> CheckedInput<'_> {
        CheckedInput::ToolStart {
            bytes: &self.write,
            deadline: self.deadline,
            read_through: &mut self.read_through,
        }
    }
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
            let nudge_until = match self.redraw_nudge {
                Some(RedrawNudge::Restart(until)) => Some(until),
                _ => None,
            };
            let can_issue = self.delivery_can_issue();
            let can_write_tool = self.tool_write_can_issue();
            let writing = self.screen().checkpoint_running();
            let input = self
                .pending_tool_write
                .as_mut()
                .filter(|_| can_write_tool)
                .map(PendingToolWrite::terminal_input)
                .or_else(|| {
                    self.pending_delivery
                        .as_mut()
                        .filter(|_| can_issue)
                        .map(|delivery| CheckedInput::Delivery(delivery.terminal_input()))
                });
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
                event = self.terminal.ready_with_input(wait, input, |action| update_write_fence(&mut self.typist, action)) => self.take_terminal(event),
                Ok(()) = self.links.tools_connections.changed() => {
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
                _ = sleep_until(nudge_until), if nudge_until.is_some() => {
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
            && self.start_prompt_ready()
            && let Some(ready) = self.prompt_ready.take()
        {
            let _ = ready.send(());
        }
        if self.screen_unneeded() {
            self.screen_mut().let_go().await;
        }
    }

    /// Releases the first prompt after tools settle or while a live initializer awaits discovery.
    fn start_prompt_ready(&self) -> bool {
        let (tools, reason) = {
            let record = self.links.shared.record.lock().unwrap();
            (
                record.info.tools_state,
                record
                    .info
                    .state_detail
                    .as_ref()
                    .and_then(|detail| detail.reason),
            )
        };
        if tools != ToolsState::Connecting {
            return true;
        }
        let connections = *self.links.tools_connections.borrow();
        connections.run == self.run
            && connections.accepting
            && connections.initialized > 0
            && self
                .state
                .native_prompt_ready(reason == Some(StateReason::NotReady))
            && self.read_screen_input().info.state != InputState::Interaction
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
        let input_rule = self.input_rule;
        if self.input_gate.needs_recovery_redraw() {
            // Keep replayed paint and any frame already open on the earlier side of the boundary.
            self.screen_mut().mark_pending_frame_earlier();
        }
        self.screen_mut().observe_paint(input_rule.is_some());
        self.recovered_empty = self.read_unread_output()
            && input_rule.is_some_and(|rule| {
                facade_rules::read_box_after_paint(rule, self.screen().screen())
                    .info
                    .state
                    == InputState::Usable
            });
        self.screen_mut().observe_paint(false);
        // Its output may have changed the title since clients took their snapshots.
        self.publish();
        // The replayed composer may have crossed the handover without a complete live frame.
        let needs_redraw = self.state.watches_question_composer()
            || (self.state.native_wait().is_none() && self.input_gate.blocks_delivery());
        if handed_over && !needs_redraw {
            // The log is whole: the screen says now what the CLI shows of its status.
            self.screen_status_at = Some(Instant::now());
        } else {
            self.terminal.set_size(cols.saturating_sub(1).max(1), rows);
            pause_for_test("inside-nudge");
            self.redraw_nudge = Some(RedrawNudge::Restart(Instant::now() + REDRAW_NUDGE_TIMEOUT));
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
                    colors: self.screen().colors(),
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
                tools_config,
                colors,
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
                if let Some(colors) = colors {
                    self.screen_mut().set_colors(colors);
                }
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
                self.tools_config = tools_config;
                self.input_gate = InputGate::default();
                self.glyph.restart();
                self.glyph_at = None;
                self.set_status_glyph(None);
                self.typist.clear_probes();
                self.terminal.stop_observing_probe();
                self.untouched_input = false;
                self.before_input_box = false;
                self.start_rows = false;
                self.ready_at =
                    self.readiness
                        .begin(self.state.started(), self.state.tools_given(), false);
                self.record_state();
                if self.early_exit.is_none() {
                    // Offer the new generation before the installed record becomes visible.
                    self.links.tools.send_modify(|tools| tools.accepting = true);
                }
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
                self.pending_delivery = None;
                self.pending_tool_write = None;
                self.typist.hold_pastes();
                // It reads no more, so the person's keys go as they come.
                self.let_enter_go();
                self.release_held();
                // No read is under way once it replies, and what the last reads brought went
                // through the screen log, so the next daemon reads on from there.
                self.terminal.stop_reading().await;
                // The last facts are written before the next daemon reads them.
                self.stop_keeping().await;
                self.quieting = Some(reply);
                self.confirm_input_drained();
            }
            AgentCommand::LetGoBeforeStop { reply } => {
                self.terminal.let_go_before_stop();
                let _ = reply.send(());
            }
            AgentCommand::SettlePaste { reply } => {
                if self.typist.hold_pastes() {
                    self.pending_delivery = None;
                }
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
                let came = Instant::now();
                self.ordered_input |= external.is_sequence();
                let startup_menu_keys = self.untouched_input
                    && self.before_input_box
                    && !self.ordered_input
                    && self.held.is_empty()
                    && !self.waits(came, &external)
                    && !self.typist.types_calls()
                    && self.submitting.is_empty()
                    && match &external {
                        Input::Raw(keys) => super::person::menu_keys(keys),
                        Input::Typed(typing) => typing.menu_keys(),
                        _ => false,
                    }
                    && self.read_screen_input().info.state == InputState::Interaction;
                self.held.push_back(HeldInput {
                    came,
                    input: external,
                    startup_menu_keys,
                });
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
                draft,
            } => {
                self.typist.finish_paste(messages, previous_text, draft);
                let recovered_empty = std::mem::take(&mut self.recovered_empty);
                if self.typist.awaiting_cleanup_frame() {
                    self.observe_cleanup_frame(self.typist.recovering_cleanup());
                    if recovered_empty
                        && self.drain_cleanup_output()
                        && self.input_rule.is_some_and(|rule| {
                            facade_rules::read_box(rule, &self.screen().screen().view())
                                .info
                                .state
                                == InputState::Usable
                        })
                        && self.typist.finish_recovered_cleanup()
                    {
                        self.undrawn = None;
                        self.screen_mut().observe_paint(false);
                    }
                }
            }
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
            .map(|held| held.input.most_bytes(console))
            .sum();
        let used = self.terminal.queued()
            + self.typist.held_bytes()
            + self
                .pending_tool_write
                .as_ref()
                .map_or(0, |write| write.write.len())
            + usize::from(enter)
            + held
            + usize::from(self.typist.probing())
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
            self.screen_mut().set_named_colors(colors);
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
            self.end_nudge();
            self.pending_size = Some(request);
            return;
        }
        self.apply_requested_size(cols, rows);
    }

    fn apply_requested_size(&mut self, cols: u16, rows: u16) {
        self.redraw_nudge = None;
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
            if self.pending_delivery.take().is_some() {
                self.typist_at = Some(Instant::now());
            }
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
        if self.typist.reads_input() {
            self.type_next();
        }
    }

    /// What the terminal did.
    fn take_terminal(&mut self, event: TerminalEvent) {
        match event {
            TerminalEvent::Read => self.take_output(),
            TerminalEvent::Closed { checking_delivery } => {
                if checking_delivery && self.typist.pasting() {
                    self.type_next();
                    self.follow_submitted_enters(Instant::now());
                }
                // The CLI's side closed: a known exit goes to viewers now.
                if self.drain_deadline.is_some() {
                    self.send_exit();
                }
            }
            TerminalEvent::ReadFailed(error) => self.terminal_read_failed(error),
            TerminalEvent::Wrote => self.wrote_input(),
            TerminalEvent::DeliveryIssued { offset, wrote } => {
                let pending = self
                    .pending_delivery
                    .take()
                    .expect("the terminal issued its intent");
                self.delivery_frames = DeliveryFrames::default();
                if matches!(pending.kind, DeliveryWrite::Paste) {
                    self.screen_mut().observe_paint(false);
                    self.escape_may_edit = false;
                }
                if matches!(pending.kind, DeliveryWrite::Reveal | DeliveryWrite::Submit) {
                    self.input_drawn_at = None;
                    self.screen_mut().mark_pending_frame_earlier();
                }
                let length = if matches!(pending.kind, DeliveryWrite::Erase { .. }) {
                    self.terminal.issued_length(offset, wrote)
                } else {
                    pending.write.len()
                };
                self.typist.delivery_issued(pending.kind, offset, length);
                if matches!(pending.kind, DeliveryWrite::Erase { .. }) {
                    self.end_cleanup_nudge();
                }
                if wrote {
                    self.wrote_input();
                }
            }
            TerminalEvent::ToolWriteIssued { offset, wrote } => {
                self.pending_tool_write
                    .take()
                    .expect("the terminal issued a startup stroke");
                self.typist.tool_write_issued(offset);
                self.readiness.tool_write_issued();
                if wrote {
                    self.wrote_input();
                }
            }
            TerminalEvent::ToolWriteExpired => {
                self.step_start();
                self.type_next();
            }
            TerminalEvent::ProbeNeedsCheck(key) => self.check_probe_key(key),
            TerminalEvent::WriteFailed(err) => {
                self.stop_input(&format!(
                    "{}'s terminal stopped taking input: {err}",
                    self.id
                ));
            }
        }
    }

    fn confirm_input_drained(&mut self) {
        if self.terminal.queued() == 0
            && let Some(reply) = self.quieting.take()
        {
            let _ = reply.send(());
        }
    }

    fn terminal_read_failed(&mut self, error: std::io::Error) {
        if self.terminal.is_open() {
            self.terminal.detach();
        }
        self.stop_input(&format!(
            "{}'s terminal stopped returning output: {error}",
            self.id
        ));
        if self.drain_deadline.is_some() {
            self.send_exit();
        }
    }

    fn wrote_input(&mut self) {
        let written = self.terminal.input_through();
        if let Some(at) = self
            .typist
            .note_tool_write(written, self.terminal.written_at())
        {
            self.readiness.tool_write_arrived(at);
        }
        self.typist.wrote(written);
        self.typist.note_erasure_write(written);
        self.links.room.notify_waiters();
        if self.typist.busy() {
            self.type_next();
        }
        if self.readiness.readies_tools() {
            self.ready_at = Some(Instant::now());
        }
        self.confirm_input_drained();
    }

    /// The CLI wrote: into the log and the screen, then to everyone who follows it.
    fn take_output(&mut self) {
        self.apply_output();
        self.follow_output();
    }

    fn apply_output(&mut self) {
        self.links.output.send_replace(());
        if matches!(self.redraw_nudge, Some(RedrawNudge::Restart(_))) {
            self.end_nudge();
        }
        self.undrawn = None;
        let received = Instant::now();
        self.drawn_at = Some(received);
        let output = self.terminal.output().to_vec();
        let earlier = self.terminal.output_precedes_submission()
            || self.terminal.output_precedes_delivery_write()
            || self.terminal.output_precedes_draft_edit();
        if self.terminal.read_starts_at_following_edit()
            && self.submitting.front().is_some_and(|submission| {
                submission.cleared_at.is_some() && self.submission_covers_delivery(submission)
            })
            && !self.screen().screen().output_frame_complete()
        {
            // The confirmation was still provisional when this edit reached the terminal.
            let submission = self.submitting.front_mut().expect("the oldest Enter");
            submission.cleared_at = None;
            submission.confirmed_at = None;
        }
        if self.terminal.read_starts_at_cleanup()
            || (self.terminal.read_starts_at_paste() && self.typist.watches_paste_paint())
        {
            self.screen_mut().observe_paint(true);
        }
        if self.terminal.read_starts_after_write()
            || self.terminal.read_starts_at_paste()
            || self.terminal.read_starts_at_probe()
            || self.terminal.read_starts_at_draft_edit()
        {
            self.screen_mut().mark_pending_frame_earlier();
        }
        let (fed, drew_input) = self.feed_cli_output(&output);
        if !earlier && drew_input {
            self.input_drawn_at = Some(received);
        }
        self.viewers.show(&fed);
        self.take_parsed(fed);
        self.admit_viewers();
        self.wake_behind_viewers();
        self.screen_mut().checkpoint_if_due();
    }

    fn observes_submission(&self) -> bool {
        let before_edit = self
            .terminal
            .output_before_following_edit()
            .is_none_or(|before| self.terminal.output_position() <= before);
        self.submitting.front().is_some_and(|submission| {
            if submission.cleared_at.is_none() {
                before_edit || self.terminal.next_edit_is_provisional()
            } else {
                // A receipt for our paste still needs the output that was ready behind this frame.
                before_edit && self.submission_covers_delivery(submission)
            }
        })
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

    fn submission_confirmed(terminal: &Terminal, submission: &Submitting) -> bool {
        submission.cleared_at.is_some_and(|frame| {
            terminal.submission_issued_before(submission.through, frame)
                && terminal
                    .output_before_following_edit()
                    .is_none_or(|before| frame <= before)
        })
    }

    fn submitted_delivery_draft(&self) -> Option<&BoxReading> {
        Self::confirmed_delivery_draft(&self.submitting, &self.typist, &self.terminal)
    }

    fn submission_covers_delivery(&self, submission: &Submitting) -> bool {
        submission
            .over
            .as_deref()
            .is_some_and(|draft| self.typist.shows_whole_paste(draft))
    }

    fn submission_ready(&self, submission: &Submitting) -> bool {
        Self::submission_confirmed(&self.terminal, submission)
            && (!self.submission_covers_delivery(submission)
                || self
                    .terminal
                    .output_before_following_edit()
                    .is_some_and(|before| self.terminal.output_position() > before)
                || self.screen().screen().output_frame_complete())
    }

    fn confirmed_delivery_draft<'a>(
        submitting: &'a VecDeque<Submitting>,
        typist: &Typist,
        terminal: &Terminal,
    ) -> Option<&'a BoxReading> {
        submitting
            .front()
            .filter(|submission| {
                submission
                    .delivery_batch
                    .is_none_or(|batch| typist.delivery_batch() == Some(batch))
                    && Self::submission_confirmed(terminal, submission)
            })
            .and_then(|submission| submission.over.as_deref())
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
            confirmed_at,
            until,
            after_interaction,
            ..
        } = submitting;
        if let Some(cleared) = *cleared_at {
            if empty_at.is_some_and(|frame| frame >= cleared)
                && over
                    .as_deref()
                    .is_some_and(|draft| typist.shows_whole_paste(draft))
            {
                let frame = read();
                if frame.info.state == InputState::Draft && typist.redraws_delivery_draft(&frame) {
                    *cleared_at = None;
                    *confirmed_at = None;
                }
            }
            return;
        }
        if !after_paste && over.is_none() {
            return;
        }
        let frame = read();
        if frame.info.state == InputState::Interaction {
            *over = None;
            if let Some(deadline) = typist.draft_deadline() {
                *until = deadline;
                *after_interaction = true;
            }
        } else if after_paste
            && frame.info.state == InputState::Draft
            && typist.delivery_batch().is_some()
        {
            *over = typist.shows_whole_paste(&frame).then(|| Box::new(frame));
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
        } else if self.typist.reads_input() || self.typist.probing() {
            self.type_next();
        }
        self.follow_enter();
    }

    /// Uses the latest available frame for cleanup, including output in later reads of this
    /// already available prefix. A full log or the drain bound withholds authorization.
    fn drain_cleanup_output(&mut self) -> bool {
        let mut read = 0;
        while read < MAX_DRAIN_BYTES && !self.screen().is_full() {
            let Some(bytes) = self.terminal.read_now() else {
                return self.terminal.is_open();
            };
            read += bytes;
            self.apply_output();
        }
        false
    }

    /// Applies reports and complete frames in the order the CLI emitted them.
    fn feed_cli_output(&mut self, output: &[u8]) -> (ParsedOutput, bool) {
        let (rule, ended) = (self.input_rule, self.ended());
        let after_paste = self.terminal.output_follows_paste();
        let position = self.terminal.output_position();
        let read_start = self.terminal.output_read_start();
        let after_enter = self.terminal.output_follows_first_submission();
        let before_next = self.terminal.output_between_submissions();
        let observes_submission = self.observes_submission();
        let observes_delivery = self.terminal.output_follows_delivery_write();
        let after_probe = self.terminal.output_follows_probe();
        let before_edit = self.terminal.delivery_frame_precedes_edit(position);
        let untouched = self.untouched_input;
        let first_hint = untouched && self.before_input_box;
        let delivery = &mut self.delivery_frames;
        let state_changed = &mut self.state_changed;
        let (state, gate, typist, submitting, terminal) = (
            &mut self.state,
            &mut self.input_gate,
            &mut self.typist,
            &mut self.submitting,
            &mut self.terminal,
        );
        let mut drew_input = None;
        let mut observe = |event: InputEvent<'_>| match event {
            InputEvent::Status {
                event,
                start,
                sync_open,
            } => {
                let report_start = start.and_then(|offset| read_start.checked_add_signed(offset));
                let was_waiting = state.native_wait().is_some();
                state.take_event(event.clone(), sync_open);
                let native_wait = state.native_wait();
                gate.report(native_wait);
                if native_wait.is_some() {
                    let evidence = report_start.filter(|_| matches!(event, StatusEvent::Report(_)));
                    if native_wait == Some(WaitKind::Question)
                        && let Some(start) = evidence
                    {
                        observe_delivery_interaction(typist, submitting, terminal, start);
                    }
                    interrupt_submissions(typist, submitting, terminal, evidence);
                } else if was_waiting {
                    if sync_open {
                        gate.withdrew_in_sync();
                    }
                    disown_unproven_erase(typist, terminal, report_start);
                }
            }
            InputEvent::Frame(screen, terminal_writes) => {
                let watch = gate.blocks_delivery()
                    || typist.reads_input()
                    || observes_submission
                    || before_next
                    || observes_delivery
                    || state.watches_question_composer();
                if !watch && !after_probe {
                    return;
                }
                let frame_closed = screen.synchronized_update_deadline().is_none();
                let frame_follows_write = screen.frame_follows_input_boundary();
                let complete = frame_closed && frame_follows_write;
                let startup_menu = first_hint && gate.waits_for_startup_composer();
                let check_composer = complete
                    && (state.watches_question_composer()
                        || gate.needs_recovery_redraw()
                        || startup_menu);
                let (reading, redrawn) = read_gate_box(rule, ended, None, screen, check_composer);
                let writes = reading.frame_writes(screen, terminal_writes);
                *drew_input.get_or_insert(false) |= writes == CursorRowWrites::Current;
                if after_probe && writes == CursorRowWrites::Current {
                    let probe_reading = if untouched {
                        read_box(rule, ended, None, screen, true, false)
                    } else {
                        reading.clone()
                    };
                    typist.observe_probe_frame(probe_reading);
                }
                if !watch {
                    return;
                }
                if frame_closed
                    && state.observe_question_composer(
                        redrawn
                            && matches!(reading.info.state, InputState::Usable | InputState::Draft),
                    )
                {
                    *state_changed = true;
                }
                observe_gate_frame(
                    gate,
                    typist,
                    submitting,
                    terminal,
                    state.native_wait(),
                    &reading,
                    (writes, redrawn, frame_follows_write, frame_closed),
                );
                if startup_menu && complete && redrawn {
                    gate.startup_composer(&reading);
                }
                if !gate.blocks_delivery() && (observes_submission || before_next) {
                    Self::observe_submissions(
                        submitting,
                        typist,
                        || reading.clone(),
                        writes,
                        after_paste,
                        (after_enter && writes == CursorRowWrites::Current).then_some(position),
                        before_next,
                    );
                }
                if writes == CursorRowWrites::Current {
                    if observes_delivery {
                        let reading = if untouched {
                            read_box(rule, ended, None, screen, true, false)
                        } else {
                            reading
                        };
                        delivery.observe(reading, position, before_edit, typist);
                    } else if after_paste && typist.occupies_input() {
                        delivery.drawn = (reading.paste_tail.is_some()
                            || (frame_follows_write && typist.shows_collapsed_paste(&reading)))
                        .then_some(reading);
                    }
                }
            }
        };
        let fed = self
            .screen
            .as_mut()
            .expect("the screen exists while the actor runs")
            .feed_observing(output, &mut observe);
        let drew_input = drew_input.unwrap_or(fed.cursor_row_cells_written);
        (fed, drew_input)
    }

    /// Examines one finite prefix before the typist acts on an active delivery. An outstanding
    /// OS read or screen checkpoint resumes through the actor's ordinary read loop.
    fn read_ready_delivery_output(&mut self) -> std::io::Result<bool> {
        self.terminal.sample_ready_delivery_output()?;
        while self.terminal.delivery_output_pending() && !self.screen().is_full() {
            // Save the pre-edit state before consuming any frame drawn after that key.
            if self.terminal.delivery_read_reaches_edit()
                && self
                    .delivery_frames
                    .pending_empty_at
                    .is_some_and(|frame| self.terminal.delivery_frame_precedes_edit(frame))
                && self.complete_delivery_frame()
            {
                self.delivery_frames.confirm_empty();
            }
            if self.terminal.try_read_now(MAX_READ_BYTES)?.is_none() {
                break;
            }
            self.apply_output();
        }
        Ok(!self.terminal.delivery_output_pending())
    }

    fn complete_delivery_frame(&self) -> bool {
        let reading = self.read_input_box(self.untouched_input);
        self.screen().screen().output_frame_complete()
            && (self.typist.interaction_after_write()
                && self.typist.delivery_frame_state(&reading) == InputState::Unknown
                || self.typist.accepts_empty_evidence(reading))
    }

    /// The replies and status the screen found in output.
    fn take_parsed(&mut self, fed: ParsedOutput) {
        if fed.title_change.is_some() {
            self.record_title();
        }
        self.queue_replies(fed.query_replies);
        self.state_changed |= !fed.status.is_empty();
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
        let frame_follows_write = self.screen().screen().frame_follows_input_boundary();
        let fed = self.screen_mut().end_synchronized_update();
        let screen = self.screen().screen();
        let frame_complete = !screen.has_unfinished_unit();
        let (reading, menu_redrawn) =
            read_gate_box(self.input_rule, self.ended(), self.undrawn, screen, false);
        let terminal_writes = if fed.cursor_row_cells_written {
            CursorRowWrites::Current
        } else {
            CursorRowWrites::None
        };
        let drew_input = frame_follows_write
            && frame_complete
            && reading.frame_writes(screen, terminal_writes) == CursorRowWrites::Current;
        let writes = if drew_input
            && !self.terminal.output_precedes_submission()
            && !self.terminal.output_precedes_delivery_write()
        {
            self.input_drawn_at = Some(Instant::now());
            CursorRowWrites::Current
        } else {
            CursorRowWrites::None
        };
        if frame_complete
            && (self.input_gate.blocks_delivery()
                || self.typist.reads_input()
                || self.state.watches_question_composer())
        {
            // A timed-out update closes the frame already open at the question report.
            self.state.observe_question_composer(false);
            observe_gate_frame(
                &mut self.input_gate,
                &mut self.typist,
                &mut self.submitting,
                &mut self.terminal,
                self.state.native_wait(),
                &reading,
                (writes, menu_redrawn, frame_follows_write, true),
            );
        }
        let before_next = self.terminal.output_between_submissions();
        if !self.input_gate.blocks_delivery() && (self.observes_submission() || before_next) {
            Self::observe_submissions(
                &mut self.submitting,
                &self.typist,
                || reading.clone(),
                writes,
                self.terminal.output_follows_paste(),
                (drew_input && self.terminal.output_follows_first_submission())
                    .then(|| self.terminal.output_position()),
                before_next,
            );
        }
        if drew_input {
            if self.terminal.output_follows_delivery_write() {
                let position = self.terminal.output_position();
                let before_edit = self.terminal.delivery_frame_precedes_edit(position);
                self.delivery_frames
                    .observe(reading, position, before_edit, &self.typist);
            } else if self.typist.occupies_input() && self.terminal.output_follows_paste() {
                self.delivery_frames.drawn = (reading.paste_tail.is_some()
                    || self.typist.shows_collapsed_paste(&reading))
                .then_some(reading);
            }
        }
        if fed.title_change.is_some() {
            self.record_title();
        }
        self.viewers.show(&fed);
        self.queue_replies(fed.query_replies);
        self.admit_viewers();
        self.catch_up_at = Some(Instant::now());
        self.screen_mut().checkpoint_if_due();
        if drew_input
            || self.delivery_frames.pending_empty_at.is_some()
            || self.pending_delivery.is_some()
            || self.typist.pasting()
        {
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
        if self.redraw_nudge.take().is_some() {
            let (cols, rows) = self.size();
            self.terminal.set_size(cols, rows);
        }
    }

    fn end_cleanup_nudge(&mut self) {
        if matches!(self.redraw_nudge, Some(RedrawNudge::RecoveredCleanup)) {
            self.end_nudge();
        }
    }

    /// A cleanup carried through restart needs a whole redraw. Its observation opens only after
    /// the output already readable is read, so a frame drawn before cannot pass for the redraw;
    /// reading stopped by its bound or a full log leaves it closed until a later step. Keep the
    /// changed size until cleanup advances so a busy CLI cannot miss both resize events between
    /// its draws.
    fn observe_cleanup_frame(&mut self, recovered: bool) {
        self.cleanup_frame_after_drain = recovered && !self.drain_cleanup_output();
        if self.cleanup_frame_after_drain {
            self.screen_mut().observe_paint(false);
            return;
        }
        if recovered && let Some(paste) = self.typist.delivery_batch() {
            let path = self.facts.with_file_name("cleanup-resize");
            let requested = self.size();
            match crate::blocking_in_place(|| CleanupResize::reserve(&path, paste, requested)) {
                Ok(Some((cols, rows))) => {
                    self.terminal.set_size(cols, rows);
                    self.redraw_nudge = Some(RedrawNudge::RecoveredCleanup);
                }
                Ok(None) => {}
                Err(error) => log(
                    "warn",
                    &format!("#{} could not reserve a cleanup resize: {error}", self.id),
                ),
            }
        }
        self.screen_mut().observe_paint(true);
    }

    /// Reads what a recovered CLI wrote while no daemon read it, so that the redraw the nudge asks
    /// for comes after it. No viewer is attached yet.
    fn read_unread_output(&mut self) -> bool {
        let mut read = 0;
        while read < MAX_DRAIN_BYTES && !self.screen().is_full() {
            let Some(n) = self.terminal.read_now() else {
                break;
            };
            read += n;
            let output = self.terminal.output().to_vec();
            let (fed, _) = self.feed_cli_output(&output);
            self.take_parsed(fed);
            self.screen_mut().checkpoint_if_due();
        }
        read != 0
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
        self.links
            .tools
            .send_modify(|tools| tools.accepting = false);
        self.state.ended(&exit, stopped);
        let creator = self.links.shared.record.lock().unwrap().info.creator_ref();
        self.observed_end = !stopped || stopped_by.is_none() || stopped_by != creator;
        self.process = ProcessState::Ended;
        self.exit = Some(exit.clone());
        self.record_state();
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
        self.links
            .tools
            .send_replace(ToolsConnections::new(run, false));
        self.links.shared.run.store(run, Ordering::SeqCst);
        self.stop_input(&format!("{} is resuming", self.id));
        self.pending_size = None;
        self.links.room.notify_waiters();
        self.next_run = Some((run, Size { cols, rows }));
        self.early_exit = None;
        self.readiness.end();
        self.ready_at = None;
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
            false,
        )
    }

    /// Lets the typist take its next step and queues what it writes.
    fn type_next(&mut self) {
        let scheduled = self.typist_at.take();
        // A quiet agent types nothing: the next daemon types what is left.
        if self.quiet {
            self.pending_delivery = None;
            return;
        }
        let now = Instant::now();
        let drawn_after_write = self.drawn_since(self.terminal.input_through()).is_some();
        let may_settle = self.terminal.delivery_output_pending()
            || self
                .typist
                .needs_ready_delivery_output(now, drawn_after_write)
            || (self.typist.pasting()
                && (self.delivery_frames.pending_empty_at.is_some()
                    || self
                        .submitted_delivery_draft()
                        .is_some_and(|draft| self.typist.shows_whole_paste(draft))));
        if may_settle {
            match self.read_ready_delivery_output() {
                Ok(true) => {}
                Ok(false) => {
                    self.typist_at = scheduled.filter(|at| *at > Instant::now());
                    return;
                }
                Err(error) => {
                    self.terminal_read_failed(error);
                    return;
                }
            }
        }
        self.terminal.finish_delivery_output();
        let now = Instant::now();
        self.finish_escape(now);
        let expired_recovered = self.typist.expired_recovered_draft(now);
        let cleanup_frame = expired_recovered || self.typist.awaiting_cleanup_frame();
        let deferred = std::mem::take(&mut self.cleanup_frame_after_drain);
        // Both cases are recoveries: only a recovered cleanup defers its observation, and an
        // expired draft here is a recovered one.
        if cleanup_frame
            && (deferred
                || (expired_recovered
                    && !matches!(self.redraw_nudge, Some(RedrawNudge::RecoveredCleanup))))
        {
            self.observe_cleanup_frame(true);
        }
        let caught_up = !cleanup_frame
            || (!self.cleanup_frame_after_drain
                && self.drain_cleanup_output()
                && self.terminal.cleanup_output_seen());
        let previous = self.pending_delivery.take();
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs");
        let written = self.terminal.input_through();
        let queued = written + self.terminal.queued() as u64;
        let published_state = self.links.shared.record.lock().unwrap().info.state;
        let modes = Modes {
            bracketed_paste: screen.screen().bracketed_paste(),
            application_cursor_keys: screen.screen().application_cursor_keys(),
            working_for_submission: published_state == ManagedAgentState::Working
                || (published_state == ManagedAgentState::JustDone && self.state.works()),
            reveal_ready: published_state != ManagedAgentState::Working
                && self
                    .typist
                    .paste_rule()
                    .is_some_and(|rule| rule.tab_to_expand.is_some())
                && self.submitting.is_empty()
                && self.held_enter.is_none()
                && self.held.is_empty()
                && self.drawn_since(queued).is_some()
                && self.room() > 0,
        };
        let probing = self.typist.probing();
        let pasting = self.typist.pasting();
        let (rule, ended) = (self.input_rule, self.ended());
        let undrawn = self.undrawn;
        let cleanup_undrawn = if caught_up {
            undrawn
        } else {
            Some("the cleanup frame may have more terminal output")
        };
        let untouched_input = self.untouched_input;
        // The screen stays as it is during a step: it is read once, where the step needs it.
        let reading = OnceCell::new();
        let read_screen = || {
            let read = || {
                read_box(
                    rule,
                    ended,
                    undrawn,
                    screen.screen(),
                    untouched_input,
                    false,
                )
            };
            reading.get_or_init(read).clone()
        };
        // With a paste in the input, what that shows may be the paste alone.
        if self.person.unshown_until().is_some() && !self.typist.occupies_input() {
            self.person.sees(&read_screen());
        }
        let unshown_until = self.person.unshown_until();
        let native_wait = self.state.native_wait();
        // Messages wait behind what the run's start does first and behind the person's keys.
        let start_first = self.readiness.readies_tools() || self.start_prompt_bytes.is_some();
        let held_first = (probing && !self.held.is_empty())
            || (self
                .held
                .front()
                .is_some_and(|held| matches!(held.input, Input::Raw(_)))
                && (!pasting
                    || self
                        .typist
                        .paste_hold_until()
                        .is_none_or(|until| until <= now)));
        let partial_until = self.person.partial_until(now);
        let classifying = self.escape_may_edit
            || (probing && partial_until.is_some() && !self.person.is_pasting());
        let frame_incomplete = !screen.screen().output_frame_complete();
        if !frame_incomplete
            && self.typist.reads_input()
            && read_screen().info.state == InputState::Interaction
        {
            self.input_gate
                .frame(InputState::Interaction, false, native_wait);
            self.typist.saw_interaction();
        }
        if self.input_gate.has_post_wait_composer()
            && !frame_incomplete
            && native_wait.is_none()
            && !self.typist.occupies_input()
        {
            let current = read_screen();
            if current.unsure && self.typist.recall(current).info.state == InputState::Usable {
                self.input_gate
                    .frame(InputState::Usable, false, native_wait);
            }
        }
        let waits_for_frame = self.input_gate.blocks_delivery() || frame_incomplete;
        let can_probe = !held_first && !self.person.is_writing(now) && self.probe_frame_ready();
        let writes = if classifying {
            BoxWrites::AwaitingEscape
        } else if frame_incomplete
            || self.erase_waits_for_edit()
            || screen.is_full()
            || start_first
            || held_first
            || self.person_first(now)
            || (pasting && !self.submitting.is_empty())
        {
            BoxWrites::ObserveOnly
        } else if !waits_for_frame {
            BoxWrites::Allowed
        } else if can_probe {
            BoxWrites::ProbeOnly
        } else {
            BoxWrites::ObserveOnly
        };
        // The output proves the tracked Enter took the draft as soon as the frames show it.
        let submission_ready = self
            .submitting
            .front()
            .is_some_and(|submission| self.submission_ready(submission));
        if submission_ready {
            self.submitting
                .front_mut()
                .expect("the ready Enter")
                .confirmed_at
                .get_or_insert_with(Instant::now);
        }
        let submitted = self
            .submitting
            .front()
            .filter(|_| submission_ready)
            .and_then(|submission| {
                Self::confirmed_delivery_draft(&self.submitting, &self.typist, &self.terminal)
                    .zip(submission.confirmed_at)
            });
        let awaiting_after_interaction = self
            .submitting
            .front()
            .is_some_and(|submission| submission.after_interaction);
        if self
            .delivery_frames
            .pending_empty_at
            .is_some_and(|frame| self.terminal.delivery_frame_precedes_edit(frame))
            && self
                .terminal
                .delivery_frame_precedes_edit(self.terminal.output_position())
            && self.complete_delivery_frame()
        {
            self.delivery_frames.confirm_empty();
        }
        let empty_after_write = self.delivery_frames.confirmed_empty_at;
        let observe = || {
            let current = if cleanup_frame {
                read_box(rule, ended, cleanup_undrawn, screen.screen(), false, true)
            } else {
                read_screen()
            };
            InputObservation {
                after_write: !waits_for_frame
                    && self.delivery_frames.drawn.as_ref() == Some(&current),
                current,
                native_wait,
                waits_for_frame,
                can_probe,
                submitted,
                empty_after_write,
                awaiting_after_interaction,
            }
        };
        let mut step = self
            .typist
            .step(now, written, queued, modes, writes, &observe);
        let still_probing = self.typist.probing();
        if still_probing && !step.write.is_empty() {
            if self.typist.probe_is_erasing() {
                self.terminal.push_probe_erase(step.write[0]);
                step.write.clear();
            } else {
                self.terminal.observe_probe_from(queued + 1);
            }
        }
        let still_observing = self.typist.awaiting_cleanup_frame();
        if !cleanup_frame && still_observing {
            self.observe_cleanup_frame(self.typist.recovering_cleanup());
        } else if cleanup_frame && !still_observing {
            self.screen_mut().observe_paint(false);
            self.terminal.stop_observing_cleanup();
        }
        if !still_observing {
            self.end_cleanup_nudge();
        }
        if let Some(deadline) = step.tool_start_deadline {
            self.pending_tool_write = Some(PendingToolWrite {
                write: step.write,
                deadline,
                read_through: None,
            });
        } else if let Some(mut kind) = step.delivery {
            let previous = previous.filter(|previous| {
                previous.matches(kind)
                    && (!matches!(kind, DeliveryWrite::Erase { .. }) || now < previous.deadline)
            });
            let mut deadline = self.typist.delivery_deadline(kind);
            let read_through = previous.and_then(|previous| {
                deadline = deadline.min(previous.deadline);
                previous.read_through
            });
            if let DeliveryWrite::Erase { until, .. } = &mut kind {
                *until = deadline;
            }
            self.pending_delivery = Some(PendingDelivery {
                kind,
                write: step.write,
                deadline,
                read_through,
            });
        } else {
            self.terminal.push(&step.write);
            if !self.typist.occupies_input() {
                if !still_observing {
                    self.screen_mut().observe_paint(false);
                }
                self.terminal.stop_observing_delivery();
                self.delivery_frames = DeliveryFrames::default();
            }
        }
        let shown_by = (unshown_until.into_iter())
            .chain(partial_until)
            .min()
            .filter(|_| self.typist.reads_input() || classifying);
        self.typist_at = step
            .wake
            .into_iter()
            .chain(shown_by)
            .chain(self.pending_delivery.iter().map(|pending| pending.deadline))
            .min();
        let submitted = self.take_typed();
        if pasting && !self.typist.pasting() && !submitted {
            self.untouched_input = false;
        }
        if probing && !still_probing {
            self.finish_observing_probe();
            self.release_held();
            if self.input_gate.has_post_wait_composer() {
                self.typist_at = Some(now);
            }
        }
    }

    /// Offers the intent only while the actor's most recent observation still permits it.
    fn delivery_can_issue(&self) -> bool {
        let screen = self.screen().screen();
        self.pending_delivery.is_some()
            && !self.quiet
            && !self.terminal.delivery_output_pending()
            && !self.input_gate.blocks_delivery()
            && !self.erase_waits_for_edit()
            && !self.person_first(Instant::now())
            && !self.readiness.readies_tools()
            && self.start_prompt_bytes.is_none()
            && !screen.is_drawing()
            && !screen.has_unfinished_unit()
    }

    fn tool_write_can_issue(&self) -> bool {
        if self.pending_tool_write.is_none() || self.quiet || self.state.native_wait().is_some() {
            return false;
        }
        let screen = self.screen().screen();
        if !screen.output_frame_complete() {
            return false;
        }
        let reading = self.typist.recall(self.read_screen_input());
        self.readiness.tool_write_matches(
            screen,
            reading.info.state,
            reading.draft.as_deref(),
            !self.input_gate.blocks_delivery() && !self.state.works(),
        )
    }

    fn erase_waits_for_edit(&self) -> bool {
        self.typist.follows_erase() && self.terminal.draft_edit_is_pending()
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
            self.enters();
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
                .holds_input(if self.state.native_wait().is_some() {
                    InputState::Interaction
                } else {
                    self.typist.recall(self.read_screen_input()).info.state
                })
    }

    /// One step of the run's start; the keys it asks for go to the typist.
    fn step_start(&mut self) {
        let now = Instant::now();
        let revoked = self
            .pending_tool_write
            .take_if(|write| now >= write.deadline)
            .is_some();
        self.typist
            .withdraw_tool_writes(revoked, |deadline| now >= deadline);
        let reading = self.typist.recall(self.read_screen_input());
        let native_wait = self.state.native_wait().is_some();
        // An input that may hold a hint or a draft is probed once it is available.
        if reading.unsure
            && !native_wait
            && self.readiness.readies_tools()
            && !self.person_first(now)
        {
            self.typist.want_probe();
        }
        let screen = self
            .screen
            .as_ref()
            .expect("the screen exists while the actor runs")
            .screen();
        let asking = native_wait
            || (screen.output_frame_complete()
                && reading.info.state == InputState::Interaction
                && !self.readiness.in_tool_panel(screen));
        if asking && self.readiness.interrupt_tools_for_question() {
            let revoked = self.pending_tool_write.take().is_some();
            self.typist.withdraw_tool_writes(revoked, |_| true);
            self.state.tools_not_started();
            self.state_changed = true;
        }
        let input = if native_wait {
            InputState::Interaction
        } else if self.readiness.waiting_for_input()
            && reading.info.state != InputState::Interaction
            && (self.typist.probing()
                || self.person_first(now)
                || self.input_gate.blocks_delivery())
        {
            InputState::Unknown
        } else {
            reading.info.state
        };
        let view = StartView {
            screen,
            input,
            draft: reading.draft.as_deref(),
            works: self.state.works(),
            start_bound: if native_wait {
                None
            } else {
                self.state.start_bound()
            },
            drawn_at: self.drawn_at,
            typing: self.typist.types_calls(),
        };
        let typist = &mut self.typist;
        let mut press = |press: Press| {
            let ((mut typing, _answer), deadline) = match press {
                Press::ToolCommand { text, deadline } => {
                    (Typing::text(text, false, Sender::person())?, Some(deadline))
                }
                Press::ToolKey { key, deadline } => (Typing::keys(&[key])?, Some(deadline)),
                Press::Keys(keys) => (Typing::keys(&keys)?, None),
            };
            if let Some(deadline) = deadline {
                typing.start_tools_by(deadline);
            }
            typist.push(typing);
            Ok(())
        };
        let step = self.readiness.step(now, &view, &mut press);
        self.ready_at = step.wake;
        if step.answered {
            self.drop_start_rows();
        }
        if step.tools_not_started {
            self.state.tools_not_started();
            self.state_changed = true;
        }
    }

    /// Lets external input go on in the order it came, up to what has to wait.
    fn release_held(&mut self) {
        while let Some(held) = self.held.front()
            && !self.waits(held.came, &held.input)
        {
            // A fragmented sequence might edit the composer. Revoke the durable evidence
            // before the prefix goes on, while the typist waits for its classification.
            if matches!(&held.input, Input::Raw(keys) if self.person.edits(keys))
                && !self.release_draft_evidence()
            {
                return;
            }
            let HeldInput {
                came,
                input,
                startup_menu_keys,
            } = self.held.pop_front().expect("held input");
            match input {
                Input::Raw(keys) => self.take_keys(came, keys, startup_menu_keys),
                typed => {
                    self.untouched_input &= startup_menu_keys;
                    self.yield_start_input_to_person();
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

    /// Whether `next`, the first held input, which came at `came`, waits behind an ordered
    /// sequence, the person's Enter, the run's start keys, a hint probe or a message that goes into
    /// the input.
    fn waits(&self, came: Instant, next: &Input) -> bool {
        if self.terminal.erasure_under_way() {
            return true;
        }
        // A quiet agent holds nothing back, as the next daemon has none of it.
        if self.quiet {
            return false;
        }
        if self.typist.probing()
            || self.typist.sequence_pending()
            || (self.ordered_input && self.typist.types_calls())
            || self.held_enter.is_some()
            || (self.start_holds_input()
                && !(self.readiness.waiting_for_input() && matches!(next, Input::Raw(_))))
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
                    && !self.delivery_blocked()
            }
        }
    }

    /// Whether the person's keys would mix into a message: its paste is in the input and the CLI has
    /// not taken it, for as long as a slow CLI takes. A menu or question of the CLI's own takes them
    /// at once.
    fn paste_holds_keys(&self) -> bool {
        let until = self.typist.paste_hold_until();
        until.is_some_and(|until| Instant::now() < until) && !self.delivery_blocked()
    }

    fn delivery_blocked(&self) -> bool {
        self.input_gate.blocked() || self.read_screen_input().info.state == InputState::Interaction
    }

    /// When the first held input may go though nothing else happens.
    fn held_wake(&self) -> Option<Instant> {
        let came = self.held.front()?.came;
        let now = Instant::now();
        [Some(self.person.due(came)), self.typist.paste_hold_until()]
            .into_iter()
            .flatten()
            .filter(|at| *at > now)
            .min()
    }

    fn finish_observing_probe(&mut self) {
        self.terminal.stop_observing_probe();
        if self.readiness.is_under_way() {
            self.ready_at = Some(Instant::now());
        }
    }

    fn yield_start_input_to_person(&mut self) {
        if self.readiness.waiting_for_input() {
            let input = if self.state.native_wait().is_some() {
                InputState::Interaction
            } else {
                self.typist.recall(self.read_screen_input()).info.state
            };
            if self.readiness.yield_to_input(input) {
                self.state.tools_not_started();
                self.state_changed = true;
            }
        }
    }

    fn check_probe_key(&mut self, key: ProbeKey) {
        let untouched = key == ProbeKey::Space && self.untouched_input;
        let reading = self.current_probe_box(untouched);
        let allowed = match key {
            ProbeKey::Space => self.typist.can_write_probe_space(reading.as_ref()),
            ProbeKey::Backspace => self.typist.recheck_probe_erase(reading.as_ref()),
        };
        if allowed {
            self.terminal.approve_probe_key(key);
            return;
        }
        self.terminal.cancel_probe_key(key);
        match key {
            ProbeKey::Space => {
                self.typist.withdraw_probe_space();
                self.finish_observing_probe();
                self.typist_at = Some(Instant::now());
                log(
                    "warn",
                    &format!(
                        "#{}: a probe did not write its space because it could not confirm its original input box",
                        self.id
                    ),
                );
            }
            ProbeKey::Backspace => self.typist_at = Some(Instant::now()),
        }
        self.links.room.notify_waiters();
        self.confirm_input_drained();
    }

    /// The ready prefix must leave a complete ordinary input reading.
    fn current_probe_box(&mut self, untouched_input: bool) -> Option<BoxReading> {
        if self.quiet || !self.read_ready_probe_output() || !self.probe_frame_ready() {
            return None;
        }
        let reading = self.read_input_box(untouched_input);
        (reading.info.state != InputState::Interaction && !reading.is_unread()).then_some(reading)
    }

    fn probe_frame_ready(&self) -> bool {
        let screen = self.screen().screen();
        self.terminal.is_open()
            && self.state.native_wait().is_none()
            && self.input_gate.permits_probe()
            && screen.output_frame_complete()
    }

    /// Examines this readable prefix without waiting before sending a probe key.
    fn read_ready_probe_output(&mut self) -> bool {
        let mut remaining = match self.terminal.queued_output_bytes() {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => None,
            Err(_) => return false,
        };
        while remaining != Some(0) && !self.screen().is_full() {
            let Ok(Some(n)) = self.terminal.try_read_now(remaining.unwrap_or(usize::MAX)) else {
                return false;
            };
            self.apply_output();
            remaining = remaining.map(|left| left - n);
        }
        remaining == Some(0)
    }

    /// Keeps the person's keys in their queue until a saved draft observation is revoked.
    fn release_draft_evidence(&mut self) -> bool {
        let menu = self.delivery_blocked();
        let observing_paint = self.typist.awaiting_cleanup_frame();
        let released = if menu {
            self.typist.revoke_paste_observation()
        } else {
            self.typist.forget_paste_draft()
        };
        if released {
            if observing_paint && !menu {
                self.screen_mut().observe_paint(false);
                self.terminal.stop_observing_cleanup();
            }
            self.end_cleanup_nudge();
            return true;
        }
        let retry = Instant::now() + ENTER_READ_AGAIN;
        self.typist_at = Some(self.typist_at.map_or(retry, |at| at.min(retry)));
        false
    }

    /// Drops queued input and fails the typist's calls: `why` typing stopped.
    fn stop_input(&mut self, why: &str) {
        self.end_nudge();
        self.pending_delivery = None;
        self.pending_tool_write = None;
        self.terminal.clear();
        self.ordered_input = false;
        self.person = PersonKeys::default();
        self.escape_may_edit = false;
        self.held_enter = None;
        self.submitting.clear();
        // Held calls fail with the others; held keys go with the queued ones.
        for held in std::mem::take(&mut self.held) {
            self.give_typist(held.input);
        }
        self.typist.fail_all(self.terminal.input_through(), why);
        self.typist_at = None;
        if self.readiness.readies_tools() {
            self.ready_at = Some(Instant::now());
        }
        self.take_typed();
    }

    /// The person's keys. An Enter that may submit the input waits, with the keys after it, until
    /// the input can be read; a CLI without a rule has no input to read.
    fn take_keys(&mut self, came: Instant, mut keys: Vec<u8>, startup_menu_keys: bool) {
        self.typist.note_reveal_input();
        let PersonInput {
            edits,
            first_edit,
            first_draft_edit,
            last_draft_edit,
            partial_start,
            enter,
            ..
        } = self.person.read(&keys);
        let has_key = first_edit.is_some() || enter.is_some();
        if has_key && (!startup_menu_keys || first_edit == Some(KeyOffset::Carried)) {
            self.untouched_input = false;
        }
        let edits_input = edits && has_key;
        if edits_input {
            self.yield_start_input_to_person();
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
        if edits_input || starts_escape {
            self.observe_person_keys(edits_input, starts_escape);
        }

        if self.typist.occupies_input() {
            self.observe_draft_edits(first_draft_edit, last_draft_edit, partial_start);
        }
        let mut following_edit = first_edit;
        if let Some(submission) = self.submitting.back_mut() {
            if submission.delivery_batch.is_some() {
                following_edit = first_draft_edit;
            }
            if submission.wait_observed_after_edit
                && let Some(edit) = following_edit.or(partial_start)
            {
                submission.wait_observed_after_edit = false;
                if matches!(edit, KeyOffset::Packet(_)) {
                    self.terminal.discard_acknowledged_edit();
                }
            }
        }
        self.observe_edit_order(following_edit, partial_start);

        let mut pastes = None;
        if let Some(enter) = enter {
            self.enters();
            let after = keys.split_off(enter.at + 1);
            if !after.is_empty() {
                self.held.push_front(HeldInput {
                    came,
                    input: Input::Raw(after),
                    startup_menu_keys: false,
                });
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

    fn observe_edit_order(&mut self, first_edit: Option<KeyOffset>, partial: Option<KeyOffset>) {
        if self.submitting.is_empty() && !self.terminal.observes_delivery_write() {
            return;
        }
        let first = self.queued_through() + 1;
        match (first_edit, partial) {
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

    /// Records possible draft edits until output can establish where the keys went.
    fn observe_draft_edits(
        &mut self,
        first_edit: Option<KeyOffset>,
        last_edit: Option<KeyOffset>,
        partial: Option<KeyOffset>,
    ) {
        let first = self.queued_through() + 1;
        if partial != Some(KeyOffset::Carried) {
            self.terminal
                .classify_draft_edit(first_edit == Some(KeyOffset::Carried));
        }
        if let Some(KeyOffset::Packet(at)) = last_edit {
            self.terminal.watch_draft_edit(first + at as u64, false);
        }
        if let Some(KeyOffset::Packet(at)) = partial {
            self.terminal.watch_draft_edit(first + at as u64, true);
        }
        if self.erase_waits_for_edit() {
            self.pending_delivery
                .take_if(|intent| matches!(intent.kind, DeliveryWrite::Erase { .. }));
        }
    }

    fn observe_person_keys(&mut self, edits_input: bool, starts_escape: bool) {
        let reading = self.read_screen_input();
        if reading.info.state == InputState::Interaction {
            // A menu or question of the CLI's own takes the keys in the input's place.
            self.person.sees(&reading);
        } else if !(self.typist.follows_erase() && self.input_gate.blocked()) {
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
        let lone_escape = self.person.lone_escape();
        if self.person.finish_escape(now) {
            self.untouched_input = false;
            self.yield_start_input_to_person();
            self.terminal.confirm_following_edit();
            self.terminal.classify_draft_edit(true);
            if std::mem::take(&mut self.escape_may_edit) {
                self.note_input_edited();
            }
            let reading = self.read_screen_input();
            if reading.info.state == InputState::Interaction {
                self.person.sees(&reading);
                // A fresh menu may have been complete before this Escape's classification.
                if lone_escape && let Some(start) = self.input_gate.menu_redraw() {
                    self.terminal.acknowledge_draft_edit_in_menu(start);
                }
            }
        }
    }

    /// Through which byte the input is queued.
    fn queued_through(&self) -> u64 {
        self.terminal.input_through() + self.terminal.queued() as u64
    }

    /// An Enter, typed or the person's, asks the CLI to do something. One that answers a question
    /// of the CLI's own, which the screen still shows, may let the start's rows go.
    fn enters(&mut self) {
        if self.read_screen_input().info.state == InputState::Interaction {
            self.drop_start_rows();
        }
        self.state.asked();
        self.state_changed = true;
    }

    /// The person or Facade answers a question of the CLI's own before a new session's
    /// conversation begins: the rows the question pushed off the top of the screen go, as the CLI
    /// cannot erase them when it redraws. More than a screenful can be a conversation that the CLI
    /// goes on with.
    fn drop_start_rows(&mut self) {
        let screen = self.screen().screen();
        if self.start_rows
            && self.state.said_line().is_none()
            && (1..=usize::from(screen.rows())).contains(&screen.scrollback_rows())
        {
            self.feed_own(ERASE_SAVED_LINES);
        }
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
            self.terminal.input_through() >= sent_through
                && written_at.is_none_or(|at| *drawn >= at)
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
        let submitted = self
            .submitting
            .front()
            .filter(|_| !self.terminal.delivery_output_pending())
            .map(|submission| {
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
        if self.terminal.delivery_output_pending() {
            return false;
        }
        let count = self.submitting.len();
        while let Some(submission) = self.submitting.front() {
            // Give the typist the chance to settle using this Enter and the ready output before
            // removing it. That output may contain a redraw that withdraws confirmation.
            if Self::submission_confirmed(&self.terminal, submission) && self.typist.pasting() {
                self.type_next();
                if self.terminal.delivery_output_pending() {
                    break;
                }
            }
            let Some(submission) = self.submitting.front() else {
                break;
            };
            let confirmed = self.submission_ready(submission);
            if !confirmed && now < submission.until && !self.submission_cut_off(submission) {
                break;
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
        let waiting = self.input_gate.blocked();
        if !waiting && !(whole && quiet) && now < held.release_at {
            self.held_enter = Some(held);
            return false;
        }
        let reading = whole.then(|| self.read_screen_input());
        let state = reading.as_ref().map(|reading| reading.info.state);
        let menu = waiting || state == Some(InputState::Interaction);
        let holds_draft = drawn.is_some() && state == Some(InputState::Draft);
        let over = reading.filter(|_| holds_draft);
        // A draft ending in a backslash is a line break to a CLI.
        let draft = over.as_ref().and_then(|reading| reading.draft.as_deref());
        let line_break = draft.is_some_and(|draft| draft.trim_end().ends_with('\\'));
        if !self.release_draft_evidence() {
            self.held_enter = Some(held);
            return false;
        }
        self.person.goes_on(held.came);
        self.terminal.push(b"\r");
        let through = self.queued_through();
        if menu && let Some(batch) = self.typist.delivery_batch() {
            self.observe_menu_enter(batch, held.pastes, through);
            return true;
        }
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

    /// The menu's Enter and a later submission can share an output position for the same batch.
    fn observe_menu_enter(&mut self, batch: u64, pastes: Vec<String>, through: u64) {
        let same_batch = |submission: &Submitting| submission.delivery_batch == Some(batch);
        if let Some(previous) = self.submitting.pop_back_if(|previous| {
            same_batch(previous)
                && previous.wait_observed_after_edit
                && previous.cleared_at.is_none()
        }) {
            self.terminal.discard_last_submission(previous.through);
        } else if self.submitting.back().is_some_and(same_batch) {
            return;
        }
        let mut submission = Submitting::sent(None, pastes, through);
        submission.after_interaction = true;
        submission.delivery_batch = Some(batch);
        if let Some(deadline) = self.typist.draft_deadline() {
            submission.until = deadline;
        }
        self.terminal.observe_output_after(through);
        self.submitting.push_back(submission);
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
        let input = self.read_screen_input();
        let wait = (input.info.state == InputState::Interaction)
            .then_some(input.wait_kind.unwrap_or(WaitKind::Unknown));
        self.state.asks(wait, Instant::now());
        let input_shown = matches!(input.info.state, InputState::Usable | InputState::Draft);
        self.before_input_box &= !input_shown;
        self.state_changed = true;
    }

    /// Reads the state into the record and hands changed facts to the task that keeps them.
    /// `Some(true)` where the change goes out at once: the CLI waits for the person or reports an
    /// error.
    fn record_state(&mut self) -> Option<bool> {
        self.state_changed = false;
        let connections = *self.links.tools_connections.borrow_and_update();
        if connections.run == self.run {
            self.state.tools_connections(connections);
        }
        let viewing = if self.viewers.is_watched() {
            Viewing::Watched
        } else {
            Viewing::Unwatched
        };
        let reading = self.state.read(Instant::now(), viewing);
        if reading.tools_reason == Some(ToolsReason::NotConnected)
            && let Some(file) = self.tools_config.take()
        {
            log(
                "warn",
                &format!(
                    "#{}: {} names a facade server. Its connection to this managed run was not verified before the startup deadline",
                    self.id,
                    file.display(),
                ),
            );
        }
        self.start_rows &= !matches!(
            reading.state,
            ManagedAgentState::Working | ManagedAgentState::JustDone
        );
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
        record.observed_end = self.observed_end && self.process == ProcessState::Ended;
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
        let trouble = Trouble::observe(info);
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

fn interrupt_submissions(
    typist: &mut Typist,
    submitting: &mut VecDeque<Submitting>,
    terminal: &mut Terminal,
    evidence: Option<u64>,
) {
    typist.saw_interaction();
    let wait_after_edit =
        evidence.is_some_and(|start| terminal.acknowledge_draft_edit_in_menu(start));
    for submission in submitting
        .iter_mut()
        .filter(|submission| submission.cleared_at.is_none())
    {
        submission.over = None;
        if let Some(deadline) = typist.draft_deadline() {
            submission.until = deadline;
            submission.after_interaction = true;
            submission.delivery_batch = typist.delivery_batch();
        }
    }
    if wait_after_edit
        && let Some(submission) = submitting.front_mut()
        && submission.cleared_at.is_none()
    {
        submission.wait_observed_after_edit = true;
    }
}

fn observe_gate_frame(
    gate: &mut InputGate,
    typist: &mut Typist,
    submitting: &mut VecDeque<Submitting>,
    terminal: &mut Terminal,
    native_wait: Option<WaitKind>,
    reading: &BoxReading,
    (writes, redrawn, frame_follows_write, frame_closed): (CursorRowWrites, bool, bool, bool),
) {
    let needs_redraw = gate.needs_recovery_redraw();
    let input_was_written = writes == CursorRowWrites::Current;
    if frame_closed && !needs_redraw {
        gate.probe_frame(reading, input_was_written, native_wait);
    }
    let state = reading.info.state;
    let read_start = terminal.output_read_start();
    if state == InputState::Interaction {
        if frame_follows_write {
            observe_delivery_interaction(typist, submitting, terminal, read_start);
        }
        gate.frame(state, false, native_wait);
        if redrawn {
            gate.note_menu_redraw(read_start);
        }
        interrupt_submissions(typist, submitting, terminal, redrawn.then_some(read_start));
        return;
    }
    if input_was_written
        && native_wait.is_none()
        && matches!(state, InputState::Usable | InputState::Draft)
    {
        disown_unproven_erase(typist, terminal, Some(read_start));
    }
    let ordinary_frame = if needs_redraw {
        frame_closed && frame_follows_write && redrawn
    } else {
        input_was_written
    };
    if ordinary_frame {
        gate.frame(
            state,
            state == InputState::Draft && typist.owns_draft(reading),
            native_wait,
        );
    }
}

fn observe_delivery_interaction(
    typist: &mut Typist,
    submitting: &VecDeque<Submitting>,
    terminal: &Terminal,
    start: u64,
) {
    if Actor::confirmed_delivery_draft(submitting, typist, terminal)
        .is_some_and(|draft| typist.shows_whole_paste(draft))
    {
        return;
    }
    typist.saw_delivery_interaction(
        terminal.output_follows_paste_at(start),
        terminal.output_follows_delivery_write_at(start),
    );
}

fn disown_unproven_erase(typist: &mut Typist, terminal: &Terminal, evidence: Option<u64>) {
    if typist.follows_erase()
        && evidence.is_some_and(|start| terminal.output_follows_draft_edit(start))
    {
        typist.input_edited();
    }
}

/// Reads a CLI's input and whether the frame printed its menu. Unknown without a rule, once the run
/// `ended`, or while the screen may not show its input yet, `undrawn` saying why.
fn read_box(
    rule: Option<&InputRule>,
    ended: bool,
    undrawn: Option<&str>,
    screen: &facade_screen::Screen,
    untouched_input: bool,
    cleanup_frame: bool,
) -> BoxReading {
    let unknown = |evidence: &str, rule: Option<&InputRule>| {
        BoxReading::new(
            InputInfo {
                state: InputState::Unknown,
                evidence: evidence.to_string(),
                mechanism: rule.map(InputRule::mechanism),
                hidden: None,
            },
            None,
        )
    };
    match (rule, undrawn) {
        (None, _) => unknown("the agent has no CLI rule to read its input by", None),
        (Some(rule), _) if ended => unknown("the agent ended", Some(rule)),
        (Some(rule), Some(why)) => unknown(why, Some(rule)),
        (Some(rule), None) if cleanup_frame => facade_rules::read_box_after_paint(rule, screen),
        (Some(rule), None) if screen.observes_paint() => {
            facade_rules::read_box_for_screen(rule, screen, untouched_input)
        }
        (Some(rule), None) => super::with_screen_view(screen, |view| {
            facade_rules::read_box_for_typing(rule, view, untouched_input)
        }),
    }
}

fn read_gate_box(
    rule: Option<&InputRule>,
    ended: bool,
    undrawn: Option<&str>,
    screen: &facade_screen::Screen,
    check_composer: bool,
) -> (BoxReading, bool) {
    if check_composer && let (Some(rule), false, None) = (rule, ended, undrawn) {
        return facade_rules::read_box_with_redraw(rule, screen, false);
    }
    let reading = read_box(rule, ended, undrawn, screen, false, false);
    if reading.info.state == InputState::Interaction
        && let Some(rule) = rule
    {
        facade_rules::read_box_with_redraw(rule, screen, false)
    } else {
        (reading, false)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::SystemTime;

    use facade_base::model::message::{DeliveryStatus, TextWritten};
    use facade_base::terminal::{TestCli, test_terminal};

    use super::*;
    use crate::agent::tests::{claude_trust_frame, plain_claude_frame, record};
    use crate::agent::{MessageTyping, StateStart};
    use crate::messages::tests::{message, messages, post_new};
    use crate::messages::{Messages, Recipient, TakeUp, decide};

    /// A message is ready to paste, and the test controls the terminal afterward.
    async fn pending_paste(folder: &Path) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (messages, _) = messages();
        pending_paste_in(folder, &messages).await
    }

    async fn test_actor(folder: &Path, messages: &Messages) -> (Actor, TestCli) {
        test_actor_for(folder, messages, "claude").await
    }

    async fn test_actor_for(folder: &Path, messages: &Messages, rule: &str) -> (Actor, TestCli) {
        let (master, cli) = test_terminal(80, 24).unwrap();
        let info = record(ProcessState::Running, None, 80, 24);
        let (tools, tools_connections) = watch::channel(ToolsConnections::new(FIRST_RUN, true));
        let links = Links {
            shared: Arc::new(Shared::new(info.clone())),
            room: Arc::new(Notify::new()),
            exit: watch::channel(None).0,
            settled: watch::channel(false).0,
            output: watch::channel(()).0,
            changes: broadcast::channel(16).0,
            tools: Arc::new(tools),
            tools_connections,
        };
        let start = ActorStart {
            info,
            master: Some(master),
            screen: ScreenStart::New(folder.to_owned()),
            untouched_input: false,
            colors: TerminalColors::default(),
            rule: Some(rule.into()),
            captures: false,
            launch_command: None,
            deliveries: messages.delivery_handle(),
            observed_loss: false,
            state: StateStart {
                tools_config: None,
                file: super::super::state::state_file(folder),
                kept: Kept::default(),
                started: Instant::now(),
            },
        };
        let mut actor = new_actor(start, links, false).unwrap();
        actor.screen = Some(LoggedScreen::create(folder.to_owned(), "a1", 80, 24).await);
        (actor, cli)
    }

    #[tokio::test]
    async fn cursor_delivery_confirms_the_drawn_composer_after_a_complete_frame() {
        let home = crate::test_folder::TestFolder::new("cursor-drawn-input-receipt");
        let (messages, _) = messages();
        let (mut actor, mut cli) = test_actor_for(&home, &messages, "agent").await;
        // The Cursor recording puts an inverse caret in the composer and parks the hidden
        // terminal cursor below it. Replay the input row and the parked position.
        let empty = "\x1b[?25l\x1b[10;1H\x1b[2K  \x1b[2m→ \x1b[22m\x1b[7mP\x1b[27m\x1b[2mlan, search, build anything\x1b[22m\x1b[15;1H";
        read_output(&mut actor, &mut cli, synchronized(empty).as_bytes()).await;
        let read = actor.read_screen_input();
        assert_eq!(read.info.state, InputState::Usable);
        assert_eq!(read.line.unwrap().cursor, (4, 9));

        let settled = queue_a_message(
            &mut actor,
            &messages,
            Instant::now() + Duration::from_secs(20),
        );
        actor.type_next();
        issue_delivery(&mut actor).await;
        let bracketed = facade_rules::find("agent")
            .unwrap()
            .unwrap()
            .paste
            .brackets_delivery();
        expect_cli_input(
            &mut cli,
            if bracketed {
                b"\x1b[200~a message \x1b[201~"
            } else {
                b"a message "
            },
        );
        let draft = synchronized("\x1b[10;1H\x1b[2K  → a message \x1b[7m \x1b[27m\x1b[15;1H");
        read_output(&mut actor, &mut cli, draft.as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Draft);

        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(251)).await;
        tokio::time::resume();
        actor.type_next();
        assert!(matches!(
            actor.pending_delivery.as_ref().map(|offer| offer.kind),
            Some(DeliveryWrite::Submit)
        ));
        issue_delivery(&mut actor).await;
        expect_cli_input(&mut cli, b"\r");

        read_output(&mut actor, &mut cli, b"\x1b[15;1H\x1b[2K").await;
        assert!(
            settled.borrow().is_none(),
            "only the parked cursor's row changed"
        );

        let first = format!("\x1b[?2026h{empty}");
        read_output(&mut actor, &mut cli, first.as_bytes()).await;
        assert!(
            settled.borrow().is_none(),
            "the empty composer frame is still open"
        );
        read_output(&mut actor, &mut cli, b"\x1b[?2026l").await;
        assert!(
            was_delivered(&settled),
            "the completed frame erased the draft at the drawn cursor"
        );
    }

    async fn pending_paste_in(
        folder: &Path,
        messages: &Messages,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (mut actor, cli) = test_actor(folder, messages).await;
        draw_input(&mut actor, "");
        let timeout = Duration::from_secs(20);
        let mut pending = message(0, "a1");
        pending.text = "a message".into();
        pending.delivery.deadline = Some(facade_base::time::iso_time(SystemTime::now() + timeout));
        let (kept, settled) = post_new(messages, pending);
        queue_test_delivery(&mut actor, crate::messages::number(&kept), timeout);
        (actor, cli, settled)
    }

    fn queue_test_delivery(actor: &mut Actor, number: u64, time_left: Duration) {
        let text = "a message";
        actor.typist.deliver(MessageTyping::new(
            text.into(),
            number,
            Instant::now() + time_left,
            Submission {
                text: text.into(),
                sender: Sender::person(),
            },
        ));
        actor.type_next();
    }

    async fn actor_with_cli(folder: &Path, deliveries: DeliveryHandle) -> (Actor, TestCli) {
        let (master, cli) = test_terminal(80, 24).unwrap();
        let info = record(ProcessState::Running, None, 80, 24);
        let (tools, tools_connections) = watch::channel(ToolsConnections::new(FIRST_RUN, true));
        let links = Links {
            shared: Arc::new(Shared::new(info.clone())),
            room: Arc::new(Notify::new()),
            exit: watch::channel(None).0,
            settled: watch::channel(false).0,
            output: watch::channel(()).0,
            changes: broadcast::channel(16).0,
            tools: Arc::new(tools),
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
                tools_config: None,
                file: super::super::state::state_file(folder),
                kept: Kept::default(),
                started: Instant::now(),
            },
        };
        let mut actor = new_actor(start, links, false).unwrap();
        actor.screen = Some(LoggedScreen::create(folder.to_owned(), "a1", 80, 24).await);
        (actor, cli)
    }

    #[tokio::test]
    async fn a_persons_key_sees_the_requested_size_after_recovered_cleanup_is_revoked() {
        use crate::store::{CleanupProgress, DraftProof};

        let home = crate::test_folder::TestFolder::new("actor-recovered-resize-person-key");
        let (messages, _) = messages();
        let (mut actor, mut cli) = test_actor(&home, &messages).await;
        let original = cli.size();
        let text = "a message";
        draw_input(&mut actor, text);

        let mut pending = message(0, "a1");
        pending.text = text.into();
        pending.delivery.deadline = Some(facade_base::time::iso_now());
        let (kept, _) = post_new(&messages, pending);
        let number = crate::messages::number(&kept);
        let deliveries = messages.delivery_handle();
        assert_eq!(deliveries.begin_paste(&[number]), Some(vec![number]));
        let mut proof = DraftProof::observed([7; 32]);
        assert!(deliveries.observe_paste(number, &proof.digest));
        proof.cleanup = Some(CleanupProgress::default());
        assert!(deliveries.record_cleanup(number, proof));
        let typing = MessageTyping::new(
            text.into(),
            number,
            Instant::now() - Duration::from_secs(1),
            Submission {
                text: text.into(),
                sender: Sender::person(),
            },
        );
        let run = actor.run;
        actor
            .take_input(
                Input::BegunPaste {
                    messages: vec![typing],
                    previous_text: None,
                    draft: Some(proof),
                },
                run,
            )
            .unwrap();
        assert!(actor.typist.awaiting_cleanup_frame());
        assert_eq!(cli.size(), (original.0, original.1 - 1));

        actor.take_input(Input::Raw(b"x".to_vec()), run).unwrap();
        assert!(!actor.typist.awaiting_cleanup_frame());
        assert!(!actor.typist.reads_input());
        assert_eq!(
            cli.size(),
            original,
            "restore the size before writing the key"
        );
        assert_eq!(actor.terminal.queued(), 1);
        let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
        assert!(matches!(event, TerminalEvent::Wrote));
        actor.take_terminal(event);
        expect_cli_input(&mut cli, b"x");
        assert_eq!(cli.size(), original);
    }

    #[tokio::test]
    async fn an_expired_recovered_draft_needs_paint_before_its_first_erase() {
        let before = crate::test_folder::TestFolder::new("actor-recovery-first-paste");
        let after = crate::test_folder::TestFolder::new("actor-recovery-first-fresh-erase");
        let (messages, _) = messages();
        let (mut first, mut cli, _) = pending_paste_in(&before, &messages).await;
        issue_delivery(&mut first).await;
        let draft = plain_claude_frame("a message ", "");
        read_output(&mut first, &mut cli, draft.as_bytes()).await;
        let proof = messages
            .paste_messages(1)
            .unwrap()
            .draft
            .expect("saved draft");
        assert!(proof.cleanup.is_none());
        drop(first);

        let (mut recovered, mut cli) = test_actor(&after, &messages).await;
        draw_input(&mut recovered, "a message ");
        let text = "a message";
        let typing = MessageTyping::new(
            text.into(),
            1,
            Instant::now() - Duration::from_secs(1),
            Submission {
                text: text.into(),
                sender: Sender::person(),
            },
        );
        recovered
            .take_input(
                Input::BegunPaste {
                    messages: vec![typing],
                    previous_text: None,
                    draft: Some(proof),
                },
                recovered.run,
            )
            .unwrap();
        assert!(recovered.pending_delivery.is_none());
        // The console can restore the old cursor without painting the composer.
        read_output(&mut recovered, &mut cli, b"\x1b[3;13H").await;
        assert!(recovered.pending_delivery.is_none());

        read_output(&mut recovered, &mut cli, draft.as_bytes()).await;
        assert!(matches!(
            recovered.pending_delivery.as_ref().map(|write| write.kind),
            Some(DeliveryWrite::Erase { .. })
        ));
    }

    #[tokio::test]
    async fn a_frame_left_unread_when_recovered_cleanup_begins_is_no_cleanup_evidence() {
        use super::super::screen::{Checkpoint, ScreenLog};
        use crate::store::CleanupProgress;
        use tokio::sync::oneshot;

        // A planned cleanup begins with the paste; an expired draft begins on the typist's step.
        for planned in [true, false] {
            let before = crate::test_folder::TestFolder::new("actor-unread-cleanup-paste");
            let after = crate::test_folder::TestFolder::new("actor-unread-cleanup-recovery");
            let (messages, _) = messages();
            let (mut first, mut cli, _) = pending_paste_in(&before, &messages).await;
            issue_delivery(&mut first).await;
            let draft = plain_claude_frame("a message ", "");
            read_output(&mut first, &mut cli, draft.as_bytes()).await;
            let mut proof = messages
                .paste_messages(1)
                .unwrap()
                .draft
                .expect("saved draft");
            drop(first);
            if planned {
                proof.cleanup = Some(CleanupProgress::default());
                assert!(messages.delivery_handle().record_cleanup(1, proof));
            }

            let (mut recovered, mut cli) = test_actor(&after, &messages).await;
            let size = cli.size();
            // The restored screen shows the draft, and its full log waits for a checkpoint.
            let mut screen = facade_screen::Screen::new(80, 24, super::super::SCROLLBACK_ROWS);
            screen.feed(draft.as_bytes());
            let folder = after.join("screen");
            let (release, released) = oneshot::channel();
            let mut log = ScreenLog::create(folder.clone(), "a1", Checkpoint::capture(&screen));
            log.begin_stalled_checkpoint(Checkpoint::capture(&screen), released);
            log.fill_to_the_cap();
            recovered.screen = Some(LoggedScreen::recovered(folder, "a1", screen, Some(log)));
            recovered.input_drawn_at = Some(Instant::now());
            assert!(recovered.screen().is_full());
            // The CLI drew this frame before the recovery, and no daemon has read it yet.
            cli.write_output(draft.as_bytes()).unwrap();
            recovered.terminal.wait_for_queued_output(draft.len()).await;

            let text = "a message";
            let typing = MessageTyping::new(
                text.into(),
                1,
                Instant::now() - Duration::from_secs(1),
                Submission {
                    text: text.into(),
                    sender: Sender::person(),
                },
            );
            recovered
                .take_input(
                    Input::BegunPaste {
                        messages: vec![typing],
                        previous_text: None,
                        draft: Some(proof),
                    },
                    recovered.run,
                )
                .unwrap();
            assert!(recovered.pending_delivery.is_none());
            // Until the old output is read, nothing asks for the redraw or watches paint.
            assert_eq!(cli.size(), size, "planned: {planned}");
            assert!(
                !recovered.facts.with_file_name("cleanup-resize").exists(),
                "planned: {planned}"
            );
            assert!(
                !recovered.screen().screen().observes_paint(),
                "planned: {planned}"
            );

            release.send(()).unwrap();
            let written = recovered.screen_mut().checkpoint_written().await;
            recovered.screen_mut().finish_checkpoint(written);
            recovered.screen_mut().checkpoint_if_due();
            assert!(!recovered.screen().is_full());
            recovered.after_checkpoint();
            assert_eq!(
                recovered.terminal.output_position(),
                draft.len() as u64,
                "the old frame was read"
            );
            assert!(
                recovered.pending_delivery.is_none(),
                "a frame drawn before the observation is no cleanup evidence (planned: {planned})"
            );
            assert_eq!(
                cli.size(),
                (size.0, size.1 - 1),
                "the redraw is asked for once the old output is read"
            );
            assert!(
                recovered.facts.with_file_name("cleanup-resize").exists(),
                "the redraw size is reserved where the deferral was checked (planned: {planned})"
            );

            read_output(&mut recovered, &mut cli, draft.as_bytes()).await;
            assert!(
                matches!(
                    recovered.pending_delivery.as_ref().map(|write| write.kind),
                    Some(DeliveryWrite::Erase { .. })
                ),
                "a frame drawn after the old output is read is (planned: {planned})"
            );
        }
    }

    #[tokio::test]
    async fn a_declined_erase_does_not_leave_a_durable_write_fence() {
        for buffered_output in [true, false] {
            let home = crate::test_folder::TestFolder::new("actor-declined-erase-fence");
            let (messages, _) = messages();
            let (mut actor, mut cli, _) = pending_paste_in(&home, &messages).await;
            issue_delivery(&mut actor).await;
            let draft = plain_claude_frame("a message ", "");
            read_output(&mut actor, &mut cli, draft.as_bytes()).await;

            let due = actor.typist.draft_deadline().unwrap();
            tokio::time::pause();
            tokio::time::advance(due.saturating_duration_since(Instant::now())).await;
            tokio::time::resume();
            actor.type_next();
            let erase = actor.pending_delivery.as_mut().expect("offered erase");
            assert!(matches!(erase.kind, DeliveryWrite::Erase { .. }));
            let written = actor.terminal.written();
            let progress = || {
                messages
                    .paste_messages(1)
                    .unwrap()
                    .draft
                    .unwrap()
                    .cleanup
                    .unwrap()
            };
            assert_eq!(progress().written, 0);
            assert!(!progress().writing);

            if buffered_output {
                let title = b"\x1b]0;new title\x07";
                cli.write_output(title).unwrap();
                actor.terminal.wait_for_queued_output(title.len()).await;
                let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
                assert!(matches!(event, TerminalEvent::Read));
                actor.take_terminal(event);
            } else {
                // The platform checks its own clock, independent of the test's Tokio clock.
                erase.deadline =
                    Instant::from_std(std::time::Instant::now() - Duration::from_secs(1));
                let wait = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite);
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), wait)
                        .await
                        .is_err()
                );
            }

            assert_eq!(actor.terminal.written(), written);
            assert_eq!(progress().written, 0);
            assert!(
                !progress().writing,
                "unissued erase, buffered_output={buffered_output}"
            );
            actor.type_next();
            issue_delivery(&mut actor).await;
            assert!(actor.terminal.written() > written);
        }
    }

    /// Sends a paste and queues a person's Enter over it. The test controls the order of
    /// terminal writes and frames so that a frame can reach the actor ahead of the Enter.
    async fn waiting_for_the_paste_frame(
        folder: &Path,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (mut actor, cli, settled) = pending_paste(folder).await;
        issue_delivery(&mut actor).await;
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

    async fn next_input_or_output(actor: &mut Actor, wait: TerminalWait) -> TerminalEvent {
        let can_issue = actor.delivery_can_issue();
        let can_write_tool = actor.tool_write_can_issue();
        let pending = actor
            .pending_tool_write
            .as_mut()
            .filter(|_| can_write_tool)
            .map(PendingToolWrite::terminal_input)
            .or_else(|| {
                actor
                    .pending_delivery
                    .as_mut()
                    .filter(|_| can_issue)
                    .map(|delivery| CheckedInput::Delivery(delivery.terminal_input()))
            });
        tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready_with_input(wait, pending, |action| {
                update_write_fence(&mut actor.typist, action)
            }),
        )
        .await
        .expect("terminal I/O")
    }

    async fn issue_delivery(actor: &mut Actor) {
        let event = next_input_or_output(actor, TerminalWait::ReadAndWrite).await;
        let TerminalEvent::DeliveryIssued { wrote, .. } = event else {
            panic!("the terminal issued the proposed delivery write");
        };
        actor.take_terminal(event);
        if !wrote {
            write_input(actor).await;
            actor.take_terminal(TerminalEvent::Wrote);
        }
    }

    async fn write_input(actor: &mut Actor) {
        // Like the completion event for a pending PTY write, callers decide when to settle.
        if actor.pending_delivery.is_some() && actor.terminal.queued() == 0 {
            let event = next_input_or_output(actor, TerminalWait::ReadAndWrite).await;
            let TerminalEvent::DeliveryIssued { offset, wrote } = event else {
                panic!("the delivery intent was issued");
            };
            actor.take_terminal(TerminalEvent::DeliveryIssued {
                offset,
                wrote: false,
            });
            if wrote {
                return;
            }
        }
        loop {
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::WriteOnly, |offset, count| {
                        actor.typist.before_write(offset, count)
                    }),
            )
            .await
            .expect("the terminal takes the queued input");
            if matches!(event, TerminalEvent::ProbeNeedsCheck(_)) {
                actor.take_terminal(event);
            } else {
                assert!(matches!(event, TerminalEvent::Wrote));
                break;
            }
        }
    }

    async fn read_output(actor: &mut Actor, cli: &mut TestCli, bytes: &[u8]) {
        cli.write_output(bytes).unwrap();
        read_buffered_frames(actor, bytes.len()).await;
    }

    fn synchronized(frame: &str) -> String {
        format!("\x1b[?2026h{frame}\x1b[?2026l")
    }

    #[tokio::test]
    async fn copilot_restores_the_composer_cursor_after_closing_its_first_frame() {
        let home = crate::test_folder::TestFolder::new("actor-copilot-restored-cursor");
        let (messages, _) = messages();
        let (mut actor, mut cli) = test_actor_for(&home, &messages, "copilot").await;
        actor.untouched_input = true;
        actor.before_input_box = true;
        let _settled = queue_a_message(
            &mut actor,
            &messages,
            Instant::now() + Duration::from_secs(15),
        );
        let trust = synchronized(
            "\x1b[?25l\x1b[20;1H│ Do you trust the files in this folder? │\r\n│ ❯ 1. Yes │",
        );
        read_output(&mut actor, &mut cli, trust.as_bytes()).await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        assert!(actor.input_gate.blocks_delivery());

        let border = "─".repeat(80);
        let composer = synchronized(&format!(
            "\x1b[2J\x1b[21;1H{border}\x1b[22;1H❯ \x1b[23;1H{border}\x1b[24;1H Interactive · Allow All"
        ));
        read_output(&mut actor, &mut cli, composer.as_bytes()).await;
        assert!(
            actor.input_gate.blocks_delivery(),
            "the cursor is still hidden"
        );
        read_output(&mut actor, &mut cli, b"\x1b[22;3H\x1b[?25").await;
        assert!(
            actor.input_gate.blocks_delivery(),
            "the reveal is incomplete"
        );
        read_output(&mut actor, &mut cli, b"h").await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        assert!(!actor.input_gate.blocks_delivery());
    }

    /// Queues the CLI's frames while the actor only writes, then passes it the person's Enter.
    async fn enter_while_reads_are_paused(
        home: &Path,
        before_enter: &str,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(home).await;
        let paste = b"\x1b[200~a message \x1b[201~";
        let mut input = [0; 64];
        let mut read = 0;
        while read < paste.len() {
            read += cli.read_input(&mut input[read..]).unwrap();
        }
        assert_eq!(&input[..read], paste);
        if !before_enter.is_empty() {
            cli.write_output(before_enter.as_bytes()).unwrap();
            actor
                .terminal
                .wait_for_queued_output(before_enter.len())
                .await;
        }
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        actor.take_keys(Instant::now(), vec![b'\r'], false);
        actor.held_enter.as_mut().unwrap().release_now();
        actor.follow_enter();
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        assert_eq!(cli.read_input(&mut input).unwrap(), 1);
        assert_eq!(input[0], b'\r');
        (actor, cli, settled)
    }

    async fn read_buffered_frames(actor: &mut Actor, left: usize) {
        let end = actor.terminal.output_position() + left as u64;
        while actor.terminal.output_position() < end {
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::ReadAndWrite, |offset, count| {
                        actor.typist.before_write(offset, count)
                    }),
            )
            .await
            .expect("buffered output can be read again");
            assert!(matches!(event, TerminalEvent::Read));
            actor.take_terminal(event);
        }
    }

    fn pending_delivery_bytes(actor: &Actor) -> usize {
        actor
            .pending_delivery
            .as_ref()
            .map_or(0, |intent| intent.write.len())
    }

    fn was_delivered(settled: &watch::Receiver<Option<Settled>>) -> bool {
        matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        )
    }

    #[tokio::test]
    async fn an_automatic_enter_needs_an_empty_frame_after_its_write() {
        let empty = synchronized(&plain_claude_frame("", ""));
        let (open, close) = empty.split_at(empty.len() - "\x1b[?2026l".len());
        let old_then_new = format!("{close}{empty}");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty_then_draft = format!("{empty}{draft}");
        let empty_then_open = format!("{empty}{}", &draft[..draft.len() - close.len()]);
        let empty_then_start = format!("{empty}\x1b[?2026h");
        for (case, before_enter, after_enter, after_edit, delivered) in [
            ("new frame", "", empty.as_str(), None, true),
            (
                "empty then the same draft",
                "",
                empty_then_draft.as_str(),
                None,
                false,
            ),
            (
                "empty then an unfinished redraw",
                "",
                empty_then_open.as_str(),
                None,
                false,
            ),
            (
                "empty then an unfinished redraw crosses an edit",
                "",
                empty_then_open.as_str(),
                Some(close),
                false,
            ),
            (
                "empty then a synchronized update start",
                "",
                empty_then_start.as_str(),
                None,
                false,
            ),
            ("buffered frame", empty.as_str(), "", None, false),
            ("old frame ends", open, close, None, false),
            (
                "old frame then new",
                open,
                old_then_new.as_str(),
                None,
                true,
            ),
            ("new frame before edit", "", empty.as_str(), Some(""), true),
            (
                "first empty after edit",
                "",
                "",
                Some(empty.as_str()),
                false,
            ),
        ] {
            let home = crate::test_folder::TestFolder::new("automatic-enter-empty-order");
            let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(&home).await;
            let paste = b"\x1b[200~a message \x1b[201~";
            let mut received = [0; 64];
            let mut n = 0;
            while n < paste.len() {
                let count = cli.read_input(&mut received[n..]).unwrap();
                assert!(count > 0);
                n += count;
            }
            assert_eq!(&received[..n], paste);
            actor.take_terminal(TerminalEvent::Wrote);
            read_output(&mut actor, &mut cli, draft.as_bytes()).await;
            assert_eq!(
                actor.read_screen_input().draft.as_deref(),
                Some("a message")
            );

            tokio::time::pause();
            if actor.pending_delivery.is_none() {
                let wake = actor.typist_at.expect("wait for the draft to settle");
                tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
                actor.type_next();
            }
            assert_eq!(
                pending_delivery_bytes(&actor),
                1,
                "the automatic Enter is an unissued intent"
            );
            assert!(settled.borrow().is_none());
            tokio::time::resume();

            // The sampled write prefix has already been read. These bytes arrive before issue.
            actor.pending_delivery.as_mut().unwrap().read_through =
                Some(actor.terminal.output_position());
            cli.write_output(before_enter.as_bytes()).unwrap();
            actor
                .terminal
                .wait_for_queued_output(before_enter.len())
                .await;
            write_input(&mut actor).await;
            assert_eq!(cli.read_input(&mut received[..1]).unwrap(), 1);
            assert_eq!(received[0], b'\r');
            cli.write_output(after_enter.as_bytes()).unwrap();
            if let Some(after_edit) = after_edit {
                actor
                    .terminal
                    .wait_for_queued_output(before_enter.len() + after_enter.len())
                    .await;
                actor.take_keys(Instant::now(), vec![3], false);
                write_input(&mut actor).await;
                assert_eq!(cli.read_input(&mut received[..1]).unwrap(), 1);
                assert_eq!(received[0], 3);
                cli.write_output(after_edit.as_bytes()).unwrap();
            }
            let len = before_enter.len() + after_enter.len() + after_edit.unwrap_or_default().len();
            actor.terminal.wait_for_queued_output(len).await;
            actor.take_terminal(TerminalEvent::Wrote);
            read_buffered_frames(&mut actor, len).await;
            assert_eq!(was_delivered(&settled), delivered, "{case}");
            if case.starts_with("empty then") {
                assert!(
                    settled.borrow().is_none(),
                    "a redraw leaves the receipt pending"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_ready_original_draft_precedes_empty_frame_confirmation() {
        let empty = synchronized(&plain_claude_frame("", ""));
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let mut failures = Vec::new();
        let cases = [
            ("after confirmation", false, false, false),
            ("after the first read", true, false, false),
            #[cfg(windows)]
            ("before the first read returns", true, true, false),
            #[cfg(windows)]
            ("before the peer closes", true, true, true),
            #[cfg(windows)]
            ("only empty at EOF", false, false, true),
        ];
        for (case, already_ready, before_first_read, close_peer) in cases {
            let home = crate::test_folder::TestFolder::new("actor-ready-output-before-receipt");
            let (mut actor, mut cli, settled, _) = after_written_automatic_enter(&home).await;
            if before_first_read {
                use std::future::{Future, poll_fn};
                use std::task::Poll;
                let mut read = std::pin::pin!(
                    actor
                        .terminal
                        .ready(TerminalWait::ReadAndWrite, |_, _| true)
                );
                poll_fn(|cx| {
                    assert!(
                        read.as_mut().poll(cx).is_pending(),
                        "arm the empty PTY read"
                    );
                    Poll::Ready(())
                })
                .await;
            }
            let start = actor.terminal.output_position();
            cli.write_output(empty.as_bytes()).unwrap();
            if before_first_read {
                cli.write_output(draft.as_bytes()).unwrap();
            }
            let read = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::ReadAndWrite, |_, _| true),
            )
            .await
            .expect("the first PTY read returns the empty frame");
            assert!(matches!(read, TerminalEvent::Read));
            // A read takes what waits: a draft written before it may come in the same read.
            assert!(actor.terminal.output().starts_with(empty.as_bytes()));
            let end = start + (empty.len() + draft.len()) as u64;
            if already_ready && !before_first_read {
                cli.write_output(draft.as_bytes()).unwrap();
                actor.terminal.wait_for_queued_output(draft.len()).await;
            }
            let mut cli = Some(cli);
            if close_peer {
                drop(cli.take());
            }
            actor.take_terminal(read);
            let first_delivery = was_delivered(&settled);
            if first_delivery == already_ready {
                failures.push(case);
            }

            if !already_ready && let Some(cli) = &mut cli {
                cli.write_output(draft.as_bytes()).unwrap();
            }
            if already_ready || !close_peer {
                let left = (end - actor.terminal.output_position()) as usize;
                read_buffered_frames(&mut actor, left).await;
                assert_eq!(
                    actor.read_screen_input().draft.as_deref(),
                    Some("a message")
                );
                assert_eq!(was_delivered(&settled), first_delivery, "{case}");
            }
        }
        assert!(
            failures.is_empty(),
            "incorrect first receipt in {failures:?}"
        );
    }

    async fn after_written_automatic_enter(
        home: &Path,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>, Instant) {
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(home).await;
        let deadline = actor.typist.draft_deadline().unwrap();
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
        actor.take_terminal(TerminalEvent::Wrote);
        let draft = synchronized(&plain_claude_frame("a message", ""));
        read_output(&mut actor, &mut cli, draft.as_bytes()).await;
        write_automatic_enter(&mut actor, &mut cli).await;
        (actor, cli, settled, deadline)
    }

    #[tokio::test]
    async fn an_empty_frame_is_confirmed_only_when_the_ready_update_is_complete() {
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let empty_then_open = format!("{empty}\x1b[?2026h");
        for (person, on_time) in [(false, true), (true, true), (false, false), (true, false)] {
            let home = crate::test_folder::TestFolder::new("actor-stable-frame-deadline");
            let (mut actor, mut cli, settled, deadline) = if person {
                let (mut actor, cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
                let deadline = actor.typist.draft_deadline().unwrap();
                // Keep the tracked Enter eligible while the message approaches its deadline.
                actor.submitting.front_mut().unwrap().until = deadline + Duration::from_secs(1);
                read_buffered_frames(&mut actor, draft.len()).await;
                (actor, cli, settled, deadline)
            } else {
                after_written_automatic_enter(&home).await
            };

            tokio::time::pause();
            let before = deadline - Duration::from_millis(10);
            tokio::time::advance(before.saturating_duration_since(Instant::now())).await;
            read_output(&mut actor, &mut cli, empty_then_open.as_bytes()).await;
            assert!(Instant::now() < deadline);
            assert!(!actor.screen().screen().output_frame_complete());
            assert!(settled.borrow().is_none());

            let close_at = if on_time {
                deadline - Duration::from_millis(5)
            } else {
                deadline + Duration::from_millis(50)
            };
            tokio::time::advance(close_at.saturating_duration_since(Instant::now())).await;
            read_output(&mut actor, &mut cli, b"\x1b[?2026l").await;
            assert!(actor.screen().screen().output_frame_complete());
            assert!(settled.borrow().is_some());
            assert_eq!(was_delivered(&settled), on_time, "person: {person}");
            assert_eq!(actor.terminal.queued(), 0);
            tokio::time::resume();
        }
    }

    #[tokio::test]
    async fn already_confirmed_delivery_survives_later_output_while_enter_awaits_acknowledgement() {
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        for (case, later, complete) in [
            ("partial title", b"\x1b]2;later title".as_slice(), false),
            ("later draft", draft.as_bytes(), true),
        ] {
            let home = crate::test_folder::TestFolder::new("actor-confirmed-frame-late-ack");
            let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(&home).await;
            let deadline = actor.typist.draft_deadline().unwrap();
            expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
            actor.take_terminal(TerminalEvent::Wrote);
            read_output(&mut actor, &mut cli, draft.as_bytes()).await;
            issue_automatic_enter(&mut actor, &mut cli).await;
            actor.terminal.withhold_last_write_acknowledgement();

            tokio::time::pause();
            let on_time = deadline - Duration::from_millis(20);
            tokio::time::advance(on_time.saturating_duration_since(Instant::now())).await;
            read_output(&mut actor, &mut cli, empty.as_bytes()).await;
            let confirmed_at = actor.delivery_frames.confirmed_empty_at.unwrap();
            assert!(confirmed_at <= deadline);
            assert!(settled.borrow().is_none());

            read_output(&mut actor, &mut cli, later).await;
            assert_eq!(actor.screen().screen().output_frame_complete(), complete);
            assert_eq!(actor.delivery_frames.confirmed_empty_at, Some(confirmed_at));
            tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
            actor.type_next();
            assert!(was_delivered(&settled), "{case}: {:?}", *settled.borrow());
            assert_eq!(actor.terminal.queued(), 0);
            tokio::time::resume();
        }
    }

    #[tokio::test]
    async fn a_scrolled_empty_composer_confirms_the_head_and_releases_the_next_paste() {
        let folder = crate::test_folder::TestFolder::new("actor-scrolled-empty-receipt");
        let (messages, _) = messages();
        let (mut actor, mut cli, settled) = pending_paste_in(&folder, &messages).await;
        issue_delivery(&mut actor).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
        let border = "─".repeat(80);
        let draft =
            format!("\x1b[2J\x1b[22;1H{border}\r\n❯\u{a0}a message \r\n{border}\x1b[23;13H");
        read_output(&mut actor, &mut cli, draft.as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Draft);
        write_automatic_enter(&mut actor, &mut cli).await;
        let _next = queue_a_message(
            &mut actor,
            &messages,
            Instant::now() + Duration::from_secs(20),
        );

        // ConPTY draws the empty prompt and scrolls it up in the same output frame.
        let empty = "\x1b[23;1H\x1b[2K❯\u{a0}\x1b[24;1H\n\x1b[22;3H";
        read_output(&mut actor, &mut cli, empty.as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        assert!(
            was_delivered(&settled),
            "the new empty prompt survived the scroll"
        );
        assert!(actor.typist_at.is_some_and(|wake| wake <= Instant::now()));
        actor.type_next();
        assert!(matches!(
            actor.pending_delivery.as_ref().map(|offer| offer.kind),
            Some(DeliveryWrite::Paste)
        ));
        issue_delivery(&mut actor).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
    }

    async fn write_automatic_enter(actor: &mut Actor, cli: &mut TestCli) {
        issue_automatic_enter(actor, cli).await;
        actor.take_terminal(TerminalEvent::Wrote);
    }

    async fn issue_automatic_enter(actor: &mut Actor, cli: &mut TestCli) {
        tokio::time::pause();
        if actor.terminal.queued() == 0 {
            let wake = actor.typist_at.expect("wait for the draft to settle");
            tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
            actor.type_next();
        }
        tokio::time::resume();
        assert_eq!(pending_delivery_bytes(actor), 1);
        write_input(actor).await;
        expect_cli_input(cli, b"\r");
    }

    fn assert_interaction_warning(settled: &watch::Receiver<Option<Settled>>, enter_written: bool) {
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("expected a retained delivery with an interaction warning, got {result:?}");
        };
        assert_eq!(message.delivery.status, DeliveryStatus::Failure);
        assert_eq!(
            message.delivery.reason,
            Some(DeliveryFailure::InteractionAfterWrite)
        );
        assert_eq!(message.delivery.text_written, TextWritten::Full);
        assert_eq!(message.delivery.enter_written, Some(enter_written));
    }

    #[tokio::test]
    async fn a_menu_after_the_paste_warns_even_if_no_submission_key_went() {
        let home = crate::test_folder::TestFolder::new("actor-menu-after-paste");
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(&home).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
        let written = actor.terminal.written();
        read_output(&mut actor, &mut cli, MENU.as_bytes()).await;
        let deadline = actor
            .typist
            .draft_deadline()
            .expect("the paste has a deadline");
        tokio::time::pause();
        tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
        actor.type_next();
        assert_interaction_warning(&settled, false);
        assert_eq!(actor.terminal.written(), written);
    }

    #[tokio::test]
    async fn a_menu_and_the_empty_composer_settle_in_output_order() {
        let menu = synchronized(MENU);
        let empty = synchronized(&format!("\x1b[?25h{}", plain_claude_frame("", "")));
        for menu_first in [true, false] {
            let home = crate::test_folder::TestFolder::new("actor-menu-after-submit");
            let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(&home).await;
            expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
            draw_input(&mut actor, "a message");
            actor.type_next();
            let rule = actor.typist.paste_rule().unwrap();
            tokio::time::pause();
            tokio::time::advance(facade_rules::settle_time(rule, "a message ")).await;
            tokio::time::resume();
            actor.type_next();
            issue_delivery(&mut actor).await;
            expect_cli_input(&mut cli, b"\r");
            let [first, second] = if menu_first {
                [&menu, &empty]
            } else {
                [&empty, &menu]
            };
            let output = format!("{first}{second}");
            cli.write_output(output.as_bytes()).unwrap();
            read_buffered_frames(&mut actor, output.len()).await;
            if menu_first {
                assert_interaction_warning(&settled, true);
            } else {
                assert!(
                    was_delivered(&settled),
                    "the empty frame was already proven"
                );
            }
        }
    }

    async fn after_written_submission(
        home: &Path,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>, Instant) {
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(home).await;
        let deadline = actor.typist.draft_deadline().unwrap();
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
        draw_input(&mut actor, "a message");
        write_automatic_submission(&mut actor, &mut cli).await;
        (actor, cli, settled, deadline)
    }

    async fn write_automatic_submission(actor: &mut Actor, cli: &mut TestCli) {
        actor.type_next();
        let rule = actor.typist.paste_rule().unwrap();
        tokio::time::pause();
        tokio::time::advance(facade_rules::settle_time(rule, "a message ")).await;
        tokio::time::resume();
        actor.type_next();
        issue_delivery(actor).await;
        expect_cli_input(cli, b"\r");
    }

    async fn reach_receipt_deadline(actor: &mut Actor, deadline: Instant) {
        let until = deadline + crate::messages::RESPONSE_GRACE;
        tokio::time::pause();
        tokio::time::advance(until.saturating_duration_since(Instant::now())).await;
        actor.type_next();
        tokio::time::resume();
    }

    #[tokio::test]
    async fn h2_a_native_question_warns_with_an_unreadable_screen_before_proof() {
        let empty = synchronized(&plain_claude_frame("", ""));
        let unknown = synchronized("\x1b[2J\x1b[H\x1b[?25l");
        for empty_first in [true, false] {
            let home = crate::test_folder::TestFolder::new("actor-question-with-unknown-frame");
            let (mut actor, mut cli, settled, deadline) = after_written_submission(&home).await;
            let before = if empty_first { empty.as_str() } else { "" };
            let question = std::str::from_utf8(BLOCKED).unwrap();
            let output = format!("{before}{question}{unknown}{IDLE}");
            cli.write_output(output.as_bytes()).unwrap();
            read_buffered_frames(&mut actor, output.len()).await;
            assert_eq!(actor.read_screen_input().info.state, InputState::Unknown);
            if empty_first {
                assert!(was_delivered(&settled));
            } else {
                reach_receipt_deadline(&mut actor, deadline).await;
                assert_interaction_warning(&settled, true);
            }
        }
    }

    #[tokio::test]
    async fn h2_a_native_question_started_before_the_paste_is_older_evidence() {
        let home = crate::test_folder::TestFolder::new("actor-question-starts-before-paste");
        let (mut actor, mut cli, settled) = pending_paste(&home).await;
        // The intent had already examined its ready prefix. The next OSC starts before the system
        // takes the paste and finishes afterwards.
        actor.pending_delivery.as_mut().unwrap().read_through =
            Some(actor.terminal.output_position());
        let (report, last) = BLOCKED.split_at(BLOCKED.len() - 1);
        cli.write_output(report).unwrap();
        actor.terminal.wait_for_queued_output(report.len()).await;
        issue_delivery(&mut actor).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
        read_buffered_frames(&mut actor, report.len()).await;
        assert!(actor.screen().screen().has_unfinished_unit());
        read_output(&mut actor, &mut cli, last).await;
        assert_eq!(actor.state.native_wait(), Some(WaitKind::Question));

        let draft = format!("{IDLE}{}", plain_claude_frame("a message", ""));
        read_output(&mut actor, &mut cli, draft.as_bytes()).await;
        write_automatic_submission(&mut actor, &mut cli).await;
        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert!(
            was_delivered(&settled),
            "the question started before any delivery input"
        );
    }

    #[tokio::test]
    async fn h2_a_split_menu_opener_keeps_the_preceding_erased_composer() {
        let erase = "\x1b[2;3H\x1b[K";
        check_empty_before_a_split_menu(erase, &[(erase.len() + "\x1b[?2026".len(), true)]).await;
    }

    #[tokio::test]
    async fn h2_an_empty_composer_can_finish_its_cursor_move_across_reads() {
        let empty = plain_claude_frame("", "");
        let cursor_move = "\x1b[2;3H";
        assert!(empty.ends_with(cursor_move));
        check_empty_before_a_split_menu(
            &empty,
            &[
                (empty.len() - 1, true),
                (empty.len() - cursor_move.len(), false),
            ],
        )
        .await;
    }

    async fn check_empty_before_a_split_menu(empty: &str, splits: &[(usize, bool)]) {
        let output = format!("{empty}{}", synchronized(MENU));
        for (through, unfinished) in
            std::iter::once((output.len(), false)).chain(splits.iter().copied())
        {
            let home = crate::test_folder::TestFolder::new("actor-empty-before-split-menu");
            let (mut actor, mut cli, settled, deadline) = after_written_submission(&home).await;
            let (prefix, tail) = output.as_bytes().split_at(through);
            read_output(&mut actor, &mut cli, prefix).await;
            if !tail.is_empty() {
                assert_eq!(actor.screen().screen().has_unfinished_unit(), unfinished);
                assert!(settled.borrow().is_none());
                read_output(&mut actor, &mut cli, tail).await;
            }
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
            if settled.borrow().is_none() {
                reach_receipt_deadline(&mut actor, deadline).await;
            }
            assert!(
                was_delivered(&settled),
                "the menu followed the complete empty composer at split {through}: {:?}",
                settled.borrow().as_ref()
            );
        }
    }

    #[tokio::test]
    async fn h2_an_immediately_restored_draft_invalidates_the_empty_frame_before_a_menu() {
        let empty = synchronized(&plain_claude_frame("", ""));
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let menu = synchronized(MENU);
        let question = format!("{}{IDLE}", std::str::from_utf8(BLOCKED).unwrap());
        for between in ["", question.as_str()] {
            let home = crate::test_folder::TestFolder::new("actor-transient-empty-before-menu");
            let (mut actor, mut cli, settled, deadline) = after_written_submission(&home).await;
            let output = format!("{empty}{between}{draft}{menu}");
            read_output(&mut actor, &mut cli, output.as_bytes()).await;
            assert_eq!(actor.terminal.output(), output.as_bytes());
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
            reach_receipt_deadline(&mut actor, deadline).await;
            assert_interaction_warning(&settled, true);
        }
    }

    #[tokio::test]
    async fn h2_a_ready_draft_and_menu_precede_the_empty_frame_decision() {
        let empty = synchronized(&plain_claude_frame("", ""));
        let restored = synchronized(&plain_claude_frame("a message", ""));
        let menu = synchronized(MENU);
        let tail = format!("{restored}{menu}");
        for (already_ready, before_first_read) in [(false, false), (true, false), (true, true)] {
            let home = crate::test_folder::TestFolder::new("actor-ready-output-before-receipt");
            let (mut actor, mut cli, settled, deadline) = after_written_submission(&home).await;
            cli.write_output(empty.as_bytes()).unwrap();
            if before_first_read {
                cli.write_output(tail.as_bytes()).unwrap();
                actor
                    .terminal
                    .wait_for_queued_output(empty.len() + tail.len())
                    .await;
            }
            let mut cut = Some(actor.terminal.output_position() + empty.len() as u64);
            let first_frame = before_first_read.then_some(DeliveryInput {
                bytes: &[],
                read_through: &mut cut,
                deadline,
                pastes: false,
                framed: false,
            });
            let read = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready_with_delivery(TerminalWait::ReadAndWrite, first_frame, |_| Ok(false)),
            )
            .await
            .unwrap();
            assert!(matches!(read, TerminalEvent::Read));
            assert_eq!(actor.terminal.output(), empty.as_bytes());
            let end = actor.terminal.output_position() + tail.len() as u64;
            if already_ready && !before_first_read {
                cli.write_output(tail.as_bytes()).unwrap();
                actor.terminal.wait_for_queued_output(tail.len()).await;
            }
            actor.take_terminal(read);
            if !already_ready {
                assert!(was_delivered(&settled), "there is no output to wait for");
                cli.write_output(tail.as_bytes()).unwrap();
            }
            let left = (end - actor.terminal.output_position()) as usize;
            read_buffered_frames(&mut actor, left).await;
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
            if already_ready {
                reach_receipt_deadline(&mut actor, deadline).await;
                assert_interaction_warning(&settled, true);
            } else {
                assert!(
                    was_delivered(&settled),
                    "later output cannot change the receipt"
                );
            }
        }
    }

    #[tokio::test]
    async fn h2_the_original_paste_placeholder_restored_before_a_menu_voids_the_empty_frame() {
        for (restored, same) in [("[Pasted text #1]", true), ("[Pasted text #2]", false)] {
            let home = crate::test_folder::TestFolder::new("actor-transient-empty-placeholder");
            let (messages, _) = messages();
            let (mut actor, mut cli) = test_actor(&home, &messages).await;
            draw_input(&mut actor, "");

            let text = "a".repeat(801);
            let timeout = Duration::from_secs(20);
            let deadline = Instant::now() + timeout;
            let mut pending = message(0, "a1");
            pending.text.clone_from(&text);
            pending.delivery.deadline =
                Some(facade_base::time::iso_time(SystemTime::now() + timeout));
            let (kept, settled) = post_new(&messages, pending);
            actor.typist.deliver(MessageTyping::new(
                text.clone(),
                crate::messages::number(&kept),
                deadline,
                Submission {
                    text: text.clone(),
                    sender: Sender::person(),
                },
            ));
            actor.type_next();
            issue_delivery(&mut actor).await;
            expect_cli_input(&mut cli, format!("\x1b[200~{text} \x1b[201~").as_bytes());

            draw_input(&mut actor, "[Pasted text #1]");
            let reading = actor.read_screen_input();
            assert!(actor.typist.owns_draft(&reading));
            assert!(!actor.typist.shows_whole_paste(&reading));
            write_automatic_submission(&mut actor, &mut cli).await;

            let empty = synchronized(&plain_claude_frame("", ""));
            let restored = synchronized(&plain_claude_frame(restored, ""));
            let menu = synchronized(MENU);
            let output = format!("{empty}{restored}{menu}");
            read_output(&mut actor, &mut cli, output.as_bytes()).await;
            assert_eq!(actor.terminal.output(), output.as_bytes());
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
            if same {
                reach_receipt_deadline(&mut actor, deadline).await;
                assert_interaction_warning(&settled, true);
            } else {
                assert!(
                    was_delivered(&settled),
                    "another paste number is a distinct draft"
                );
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn h2_closed_peer_output_is_drained_before_settling_the_empty_frame() {
        let empty = synchronized(&plain_claude_frame("", ""));
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let menu = synchronized(MENU);
        for has_tail in [false, true] {
            let home = crate::test_folder::TestFolder::new("actor-ready-output-closed-pipe");
            let (mut actor, mut cli, settled, deadline) = after_written_submission(&home).await;
            let output = if has_tail {
                format!("{empty}{draft}{menu}")
            } else {
                empty.clone()
            };
            cli.write_output(output.as_bytes()).unwrap();
            let mut cut = Some(actor.terminal.output_position() + empty.len() as u64);
            let first_frame = DeliveryInput {
                bytes: &[],
                read_through: &mut cut,
                deadline,
                pastes: false,
                framed: false,
            };
            let read = tokio::time::timeout(
                Duration::from_secs(5),
                actor.terminal.ready_with_delivery(
                    TerminalWait::ReadAndWrite,
                    Some(first_frame),
                    |_| Ok(false),
                ),
            )
            .await
            .unwrap();
            assert!(matches!(read, TerminalEvent::Read));
            assert_eq!(actor.terminal.output(), empty.as_bytes());
            drop(cli);

            actor.take_terminal(read);
            tokio::time::timeout(Duration::from_secs(5), async {
                while actor.terminal.is_open() {
                    let event = actor
                        .terminal
                        .ready(TerminalWait::ReadAndWrite, |_, _| true)
                        .await;
                    actor.take_terminal(event);
                }
            })
            .await
            .expect("the closed peer's output reaches EOF");
            if has_tail {
                assert_eq!(
                    actor.read_screen_input().info.state,
                    InputState::Interaction
                );
                reach_receipt_deadline(&mut actor, deadline).await;
                assert_interaction_warning(&settled, true);
            } else {
                assert!(
                    was_delivered(&settled),
                    "EOF followed an intact empty composer"
                );
            }
        }
    }

    #[tokio::test]
    async fn h2_a_terminal_read_failure_does_not_confirm_a_provisional_empty_frame() {
        let home = crate::test_folder::TestFolder::new("actor-read-failure-before-receipt");
        let (mut actor, mut cli, settled, _) = after_written_submission(&home).await;
        let empty = synchronized(&plain_claude_frame("", ""));
        cli.write_output(empty.as_bytes()).unwrap();
        assert!(matches!(
            actor
                .terminal
                .ready(TerminalWait::ReadAndWrite, |_, _| true)
                .await,
            TerminalEvent::Read
        ));
        actor.apply_output();
        assert!(
            settled.borrow().is_none(),
            "the empty frame is only a candidate"
        );

        actor.take_terminal(TerminalEvent::ReadFailed(
            std::io::ErrorKind::PermissionDenied.into(),
        ));
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the written delivery has a receipt: {result:?}");
        };
        assert_eq!(message.delivery.status, DeliveryStatus::Failure);
        assert_eq!(message.delivery.reason, Some(DeliveryFailure::Ended));
        assert_eq!(message.delivery.text_written, TextWritten::Full);
        assert_eq!(message.delivery.enter_written, Some(true));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn h2_peer_eof_preserves_the_evidence_for_a_persons_enter() {
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        for (close_peer, eof_event) in [(false, false), (true, false), (true, true)] {
            let home = crate::test_folder::TestFolder::new("actor-manual-enter-before-eof");
            let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
            let deadline = actor.typist.draft_deadline().unwrap();
            read_buffered_frames(&mut actor, draft.len()).await;

            cli.write_output(empty.as_bytes()).unwrap();
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::ReadAndWrite, |_, _| true),
            )
            .await
            .expect("read the CLI's empty composer");
            assert!(matches!(event, TerminalEvent::Read));
            assert_eq!(actor.terminal.output(), empty.as_bytes());
            actor.apply_output();
            assert!(settled.borrow().is_none());
            assert!(
                Actor::confirmed_delivery_draft(&actor.submitting, &actor.typist, &actor.terminal)
                    .is_some_and(|draft| actor.typist.shows_whole_paste(draft))
            );

            if close_peer {
                drop(cli);
            }
            if eof_event {
                // The actor may resume through its read event while a receipt check is pending.
                actor.terminal.sample_ready_delivery_output().unwrap();
                assert!(actor.terminal.delivery_output_pending());
                actor.follow_enter();
                assert!(!actor.submitting.is_empty());
            } else {
                actor.follow_output();
            }
            if close_peer {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while actor.terminal.is_open() {
                        let event = actor
                            .terminal
                            .ready(TerminalWait::ReadAndWrite, |_, _| true)
                            .await;
                        actor.take_terminal(event);
                    }
                })
                .await
                .expect("read through peer EOF");
            }
            let settled_without_deadline = settled.borrow().is_some();
            if !settled_without_deadline {
                reach_receipt_deadline(&mut actor, deadline).await;
            }
            let result = settled.borrow();
            let Some(Settled::Kept(message)) = result.as_ref() else {
                panic!("the written delivery has a receipt: {result:?}");
            };
            assert_eq!(
                message.delivery.status,
                DeliveryStatus::Success,
                "close_peer={close_peer}, eof_event={eof_event}, reason={:?}, enter_written={:?}",
                message.delivery.reason,
                message.delivery.enter_written
            );
            assert_eq!(message.delivery.text_written, TextWritten::Full);
            assert_eq!(message.delivery.enter_written, Some(true));
            assert!(settled_without_deadline);
            assert!(actor.submitting.is_empty());
        }
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
            read_box(actor.input_rule, false, None, &screen, false, false)
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
        assert_interaction_warning(&settled, false);
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
            read_box(actor.input_rule, false, None, &screen, false, false)
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
        assert_interaction_warning(&settled, false);
    }

    #[tokio::test]
    async fn another_complete_draft_after_a_menu_keeps_the_delivery_warning() {
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
            read_box(actor.input_rule, false, None, &screen, false, false)
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
        assert_interaction_warning(&settled, false);
    }

    async fn edit_while_output_waits(key: u8, empty_before_edit: bool) -> bool {
        let home = crate::test_folder::TestFolder::new("actor-edit-with-output-waiting");
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        if empty_before_edit {
            cli.write_output(empty.as_bytes()).unwrap();
            actor
                .terminal
                .wait_for_queued_output(draft.len() + empty.len())
                .await;
        }
        // At the paste's hold limit, the next key goes while reads are still paused.
        actor.take_keys(Instant::now(), vec![key], false);
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
        actor
            .terminal
            .wait_for_queued_output(draft.len() + empty.len())
            .await;
        actor.take_keys(Instant::now(), vec![b'\r'], false);
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
        actor.terminal.wait_for_queued_output(2 * draft.len()).await;
        actor.take_keys(Instant::now(), vec![b'\r'], false);
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
        actor.take_keys(Instant::now(), bytes.to_vec(), false);
        write_input(actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        expect_cli_input(cli, bytes);
    }

    fn expect_cli_input(cli: &mut TestCli, bytes: &[u8]) {
        let mut input = vec![0; bytes.len()];
        let mut read = 0;
        while read < input.len() {
            let n = cli.read_input(&mut input[read..]).unwrap();
            assert!(n > 0);
            read += n;
        }
        assert_eq!(input, bytes);
    }

    #[tokio::test]
    async fn a_restored_marker_voids_the_empty_frame_only_for_the_same_paste() {
        let empty = synchronized(&plain_claude_frame("", ""));
        let menu = synchronized(&claude_trust_frame(false));
        for (restored, same) in [("[Pasted text #1]", true), ("[Pasted text #2]", false)] {
            let home = crate::test_folder::TestFolder::new("actor-transient-empty-placeholder");
            let (messages, _) = messages();
            let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
            draw_input(&mut actor, "");

            let text = "a".repeat(801);
            let deadline = Instant::now() + Duration::from_secs(20);
            let (kept, settled) = post_new(&messages, message(0, "a1"));
            actor.typist.deliver(MessageTyping::new(
                text.clone(),
                crate::messages::number(&kept),
                deadline,
                Submission {
                    text: text.clone(),
                    sender: Sender::person(),
                },
            ));
            actor.type_next();
            write_input(&mut actor).await;
            expect_cli_input(&mut cli, format!("\x1b[200~{text} \x1b[201~").as_bytes());
            actor.take_terminal(TerminalEvent::Wrote);

            let marker = synchronized(&plain_claude_frame("[Pasted text #1]", ""));
            read_output(&mut actor, &mut cli, marker.as_bytes()).await;
            assert_eq!(
                actor.read_screen_input().draft.as_deref(),
                Some("[Pasted text #1]")
            );
            write_automatic_enter(&mut actor, &mut cli).await;

            let restored = synchronized(&plain_claude_frame(restored, ""));
            let output = format!("{empty}{restored}{menu}");
            cli.write_output(output.as_bytes()).unwrap();
            read_buffered_frames(&mut actor, output.len()).await;
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
            assert_eq!(
                was_delivered(&settled),
                !same,
                "restored original marker: {same}"
            );
            if same {
                assert!(
                    settled.borrow().is_none(),
                    "the original paste is still pending"
                );
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_console_paste_needs_its_own_terminal_paint() {
        let home = crate::test_folder::TestFolder::new("actor-console-paste-paint");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let codex = facade_rules::find("codex").unwrap().unwrap();
        let fake = facade_rules::find("fake").unwrap().unwrap();
        actor.input_rule = Some(&fake.input);
        actor.typist = Typist::new(
            &actor.id,
            Some(codex),
            facade_rules::console_typing(codex),
            messages.delivery_handle(),
        );

        let padding = "\u{276f}            \x1b[1;3H";
        read_output(&mut actor, &mut cli, padding.as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);

        let text = "done \u{1f44d}\u{1f3fd}";
        let (kept, _) = post_new(&messages, message(0, "a1"));
        actor.typist.deliver(MessageTyping::new(
            text.into(),
            crate::messages::number(&kept),
            Instant::now() + Duration::from_secs(20),
            Submission {
                text: text.into(),
                sender: Sender::person(),
            },
        ));
        actor.type_next();
        let paste_bytes = pending_delivery_bytes(&actor);
        assert!(paste_bytes > 0);
        write_input(&mut actor).await;
        assert!(actor.typist.watches_paste_paint());
        assert_eq!(actor.terminal.written(), paste_bytes as u64);
        actor.take_terminal(TerminalEvent::Wrote);

        read_output(&mut actor, &mut cli, "done \u{1f44d}\x1b[C".as_bytes()).await;
        let prefix = actor.read_screen_input();
        assert!(
            prefix
                .paste_drawing
                .is_some_and(|drawn| drawn.final_spaces == 0),
            "{prefix:?}; after paste: {}; tracking: {}",
            actor.terminal.output_follows_paste(),
            actor.screen.as_ref().unwrap().screen().observes_paint(),
        );
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(2)).await;
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);
        tokio::time::resume();

        read_output(&mut actor, &mut cli, b"\x1b[D ").await;
        assert!(
            actor
                .read_screen_input()
                .paste_drawing
                .is_some_and(|drawn| drawn.final_spaces == 1)
        );
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(2)).await;
        actor.type_next();
        assert_eq!(pending_delivery_bytes(&actor), 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_ready_draft_also_voids_a_person_s_enter_empty_frame() {
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));

        for redraw_ready in [false, true] {
            let home = crate::test_folder::TestFolder::new("actor-person-enter-transient-empty");
            let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
            read_buffered_frames(&mut actor, draft.len()).await;

            cli.write_output(empty.as_bytes()).unwrap();
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::ReadAndWrite, |_, _| true),
            )
            .await
            .expect("read the CLI's empty input");
            assert!(matches!(event, TerminalEvent::Read));
            assert_eq!(actor.terminal.output(), empty.as_bytes());
            if redraw_ready {
                cli.write_output(draft.as_bytes()).unwrap();
            }
            actor.take_terminal(event);
            let drawn = actor.read_screen_input();
            let delivered = was_delivered(&settled);
            if redraw_ready {
                assert_eq!(
                    drawn.draft.as_deref(),
                    Some("a message"),
                    "the sample pulled in the ready full draft"
                );
                assert!(
                    !delivered,
                    "this was a transition, the same draft is still present"
                );
            } else {
                assert_eq!(drawn.info.state, InputState::Usable);
                assert!(delivered, "the real empty frame confirms the human Enter");
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_sync_begin_alone_keeps_a_person_s_empty_frame_provisional() {
        let plain = plain_claude_frame("a message", "");
        let draft = synchronized(&plain);
        let empty = synchronized(&plain_claude_frame("", ""));
        let home = crate::test_folder::TestFolder::new("actor-person-enter-bare-sync");
        let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
        read_buffered_frames(&mut actor, draft.len()).await;

        cli.write_output(empty.as_bytes()).unwrap();
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor
                .terminal
                .ready(TerminalWait::ReadAndWrite, |_, _| true),
        )
        .await
        .expect("read the CLI's empty input");
        assert!(matches!(event, TerminalEvent::Read));
        assert_eq!(actor.terminal.output(), empty.as_bytes());
        cli.write_output(b"\x1b[?2026h").unwrap();
        actor.take_terminal(event);
        let screen = actor.screen().screen();
        assert!(screen.synchronized_update_deadline().is_some());
        assert!(!screen.is_drawing(), "only the start marker was ready");
        assert!(settled.borrow().is_none());

        read_output(
            &mut actor,
            &mut cli,
            format!("{plain}\x1b[?2026l").as_bytes(),
        )
        .await;
        assert_eq!(
            actor.read_screen_input().draft.as_deref(),
            Some("a message")
        );
        assert!(!was_delivered(&settled));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn an_open_redraw_cannot_confirm_a_person_s_enter() {
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        let (open, close) = draft.split_at(draft.len() - "\x1b[?2026l".len());

        for edited in [false, true] {
            let home = crate::test_folder::TestFolder::new("actor-person-enter-open-frame");
            let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
            read_buffered_frames(&mut actor, draft.len()).await;

            read_output(&mut actor, &mut cli, format!("{empty}{open}").as_bytes()).await;
            assert!(actor.screen().screen().is_drawing());
            assert!(settled.borrow().is_none());

            if edited {
                actor.take_keys(Instant::now(), vec![3], false);
                write_input(&mut actor).await;
                let mut key = [0; 1];
                assert_eq!(cli.read_input(&mut key).unwrap(), 1);
                assert_eq!(key, [3]);
                actor.take_terminal(TerminalEvent::Wrote);
            }

            read_output(&mut actor, &mut cli, close.as_bytes()).await;
            assert_eq!(
                actor.read_screen_input().draft.as_deref(),
                Some("a message")
            );
            assert!(!was_delivered(&settled));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn peer_eof_preserves_the_person_s_enter_evidence() {
        let draft = synchronized(&plain_claude_frame("a message", ""));
        let empty = synchronized(&plain_claude_frame("", ""));
        for (close_peer, eof_event) in [(false, false), (true, false), (true, true)] {
            let home = crate::test_folder::TestFolder::new("actor-manual-enter-before-eof");
            let (mut actor, mut cli, settled) = enter_while_reads_are_paused(&home, &draft).await;
            read_buffered_frames(&mut actor, draft.len()).await;

            cli.write_output(empty.as_bytes()).unwrap();
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::ReadAndWrite, |_, _| true),
            )
            .await
            .expect("read the CLI's empty input");
            assert!(matches!(event, TerminalEvent::Read));
            assert_eq!(actor.terminal.output(), empty.as_bytes());
            actor.apply_output();
            assert!(settled.borrow().is_none());
            let draft = actor
                .submitted_delivery_draft()
                .expect("the person's Enter took the draft");
            assert!(actor.typist.shows_whole_paste(draft));

            if close_peer {
                drop(cli);
            }
            if eof_event {
                actor.terminal.sample_ready_delivery_output().unwrap();
                assert!(actor.terminal.delivery_output_pending());
                actor.follow_enter();
                assert!(!actor.submitting.is_empty());
            } else {
                actor.follow_output();
            }
            if close_peer {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while actor.terminal.is_open() {
                        let event = actor
                            .terminal
                            .ready(TerminalWait::ReadAndWrite, |_, _| true)
                            .await;
                        actor.take_terminal(event);
                    }
                })
                .await
                .expect("read through peer EOF");
            }
            let result = settled.borrow();
            let Some(Settled::Kept(message)) = result.as_ref() else {
                panic!("the written delivery has a receipt: {result:?}");
            };
            assert_eq!(message.delivery.status, DeliveryStatus::Success);
            assert_eq!(
                message.delivery.text_written,
                facade_base::model::message::TextWritten::Full
            );
            assert_eq!(message.delivery.enter_written, Some(true));
            assert!(actor.submitting.is_empty());
        }
    }

    #[tokio::test]
    async fn a_terminal_read_failure_does_not_confirm_a_pending_empty_frame() {
        use facade_base::model::message::{DeliveryFailure, TextWritten};

        let home = crate::test_folder::TestFolder::new("actor-read-failure-before-receipt");
        let (mut actor, mut cli, settled, _) = after_written_automatic_enter(&home).await;
        let empty = synchronized(&plain_claude_frame("", ""));
        cli.write_output(empty.as_bytes()).unwrap();
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor
                .terminal
                .ready(TerminalWait::ReadAndWrite, |_, _| true),
        )
        .await
        .expect("read the candidate empty input");
        assert!(matches!(event, TerminalEvent::Read));
        actor.apply_output();
        assert!(settled.borrow().is_none());

        actor.take_terminal(TerminalEvent::ReadFailed(
            std::io::ErrorKind::PermissionDenied.into(),
        ));
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the written delivery has a receipt: {result:?}");
        };
        assert_eq!(message.delivery.status, DeliveryStatus::Failure);
        assert_eq!(message.delivery.reason, Some(DeliveryFailure::Ended));
        assert_eq!(message.delivery.text_written, TextWritten::Full);
        assert_eq!(message.delivery.enter_written, Some(true));
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
        actor.take_keys(Instant::now(), b"I\r".to_vec(), false);
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
            actor
                .terminal
                .wait_for_queued_output(draft.len() + empty.len())
                .await;
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

    const BLOCKED: &[u8] = b"\x1b]7501;state=blocked:kind=question\x07";
    const PERMISSION: &[u8] = b"\x1b]7501;state=blocked:kind=permission\x07";
    const IDLE: &str = "\x1b]7501;state=idle\x07";
    const MENU: &str = "\x1b[2J\x1b[H\x1b[?25l Accessing workspace:\r\n\r\n /work/probe\r\n\r\n \
                        Quick safety check: Is this a project you created or one you trust?\r\n\r\n \
                        ❯ No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel";

    #[tokio::test]
    async fn muse_wait_ignores_paint_elsewhere_on_the_cursor_row() {
        let home = crate::test_folder::TestFolder::new("actor-muse-old-box-row-write");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let rule = facade_rules::find("muse").unwrap().unwrap();
        actor.input_rule = Some(&rule.input);
        actor.state = StateTracker::new(Some(rule), Instant::now(), Kept::default(), None, None);
        actor.typist = Typist::new(&actor.id, Some(rule), None, messages.delivery_handle());
        let composer = plain_claude_frame("", "");
        read_output(&mut actor, &mut cli, composer.as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        read_output(&mut actor, &mut cli, BLOCKED).await;
        let _settled = queue_a_message(
            &mut actor,
            &messages,
            Instant::now() + Duration::from_secs(20),
        );
        actor.type_next();
        assert!(actor.input_gate.blocks_delivery() && actor.pending_delivery.is_none());

        // The old complete box and its caret are unchanged. Only one distant cell is printed.
        read_output(&mut actor, &mut cli, b"\x1b[2;78H \x1b[2;3H").await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        if actor.pending_delivery.is_some() {
            issue_delivery(&mut actor).await;
            expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
            panic!(
                "PTY received the paste after a single distant blank, while the real question report was live"
            );
        }
        assert!(actor.input_gate.blocks_delivery());

        // Repeating just the prompt still leaves the frame's two borders from before the report.
        read_output(&mut actor, &mut cli, "\x1b[2;1H❯ ".as_bytes()).await;
        assert!(actor.input_gate.blocks_delivery() && actor.pending_delivery.is_none());

        read_output(&mut actor, &mut cli, composer.as_bytes()).await;
        assert_eq!(actor.state.native_wait(), None);
        assert!(!actor.input_gate.blocks_delivery());
        issue_delivery(&mut actor).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
    }

    #[tokio::test]
    async fn muse_wait_stays_settled_through_clean_handover() {
        let before = crate::test_folder::TestFolder::new("actor-muse-before-handover");
        let after = crate::test_folder::TestFolder::new("actor-muse-after-handover");
        let (messages, _) = messages();
        let rule = facade_rules::find("muse").unwrap().unwrap();
        let composer = plain_claude_frame("", "");
        let (mut old, mut cli) = actor_with_cli(&before, messages.delivery_handle()).await;
        old.input_rule = Some(&rule.input);
        old.state = StateTracker::new(Some(rule), Instant::now(), Kept::default(), None, None);
        read_output(&mut old, &mut cli, BLOCKED).await;
        read_output(&mut old, &mut cli, composer.as_bytes()).await;
        assert_eq!(old.state.native_wait(), None);
        assert!(!old.input_gate.blocks_delivery());
        let bytes = serde_json::to_vec(&old.state.kept()).unwrap();
        let kept = serde_json::from_slice(&bytes).unwrap();

        let (mut new, mut cli) = actor_with_cli(&after, messages.delivery_handle()).await;
        let mut screen = facade_screen::Screen::new(80, 24, 0);
        screen.feed(composer.as_bytes());
        new.input_rule = Some(&rule.input);
        new.state = StateTracker::new(Some(rule), Instant::now(), kept, None, Some(&screen));
        new.typist = Typist::new(&new.id, Some(rule), None, messages.delivery_handle());
        new.input_gate.report(new.state.native_wait());
        new.input_gate
            .recover(new.state.uses_native_reports(), new.state.answers_ask());
        new.screen_start = Some(ScreenStart::Recovered {
            screen: Box::new(screen),
            log: None,
            handed_over_cleanly: true,
            restart_size: None,
        });
        new.begin(true, false, TerminalColors::default()).await;
        new.read_screen_status();
        assert_eq!(new.read_screen_input().info.state, InputState::Usable);

        let _settled = queue_a_message(
            &mut new,
            &messages,
            Instant::now() + Duration::from_secs(20),
        );
        new.type_next();
        assert_eq!(
            new.state.native_wait(),
            None,
            "the completed report stays done"
        );
        assert!(
            new.redraw_nudge.is_some(),
            "native recovery requests fresh paint"
        );
        assert!(
            new.pending_delivery.is_none(),
            "the recovered screen is still old evidence"
        );

        read_output(&mut new, &mut cli, b"\x1b[2;78H \x1b[2;3H").await;
        if new.pending_delivery.is_some() {
            issue_delivery(&mut new).await;
            expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
            panic!("the CLI received a paste after only a distant blank on the recovered composer");
        }
        assert!(new.input_gate.blocks_delivery());

        read_output(&mut new, &mut cli, composer.as_bytes()).await;
        assert!(!new.input_gate.blocks_delivery());
        assert!(new.pending_delivery.is_some());

        // Another actual report is a fresh wait, even when it has the same kind.
        read_output(&mut new, &mut cli, BLOCKED).await;
        assert_eq!(new.state.native_wait(), Some(WaitKind::Question));
        assert!(new.input_gate.blocks_delivery() && new.pending_delivery.is_none());
    }

    #[tokio::test]
    async fn muse_wait_ignores_a_title_change_after_handover() {
        let composer = plain_claude_frame("", "");
        muse_active_question_survives_replay(
            "title-change",
            &[composer.as_bytes(), BLOCKED],
            b"\x1b]2;new title\x07",
        )
        .await;
    }

    #[tokio::test]
    async fn muse_wait_ignores_an_open_pre_report_frame_after_handover() {
        let composer = plain_claude_frame("", "");
        muse_active_question_survives_replay(
            "pre-report-sync",
            &[b"\x1b[?2026h", composer.as_bytes(), BLOCKED],
            b"\x1b[?2026l",
        )
        .await;
    }

    #[tokio::test]
    async fn muse_wait_requests_a_redraw_after_a_post_report_frame_crosses_handover() {
        let composer = plain_claude_frame("", "");
        muse_active_question_survives_replay(
            "post-report-sync",
            &[BLOCKED, b"\x1b[?2026h", composer.as_bytes()],
            b"\x1b[?2026l",
        )
        .await;
    }

    async fn muse_active_question_survives_replay(
        case: &str,
        recorded_output: &[&[u8]],
        live_output: &[u8],
    ) {
        let before = crate::test_folder::TestFolder::new(&format!("actor-muse-replay-{case}-old"));
        let after = crate::test_folder::TestFolder::new(&format!("actor-muse-replay-{case}-new"));
        let (messages, _) = messages();
        let rule = facade_rules::find("muse").unwrap().unwrap();
        let composer = plain_claude_frame("", "");
        let (mut old, mut cli) = actor_with_cli(&before, messages.delivery_handle()).await;
        old.input_rule = Some(&rule.input);
        old.state = StateTracker::new(Some(rule), Instant::now(), Kept::default(), None, None);
        for bytes in recorded_output {
            read_output(&mut old, &mut cli, bytes).await;
        }
        let open_sync = old.screen().screen().is_drawing();
        assert_eq!(old.state.native_wait(), Some(WaitKind::Question));
        let kept = serde_json::from_slice(&serde_json::to_vec(&old.state.kept()).unwrap()).unwrap();
        old.screen_mut().finish().await;
        let replayed =
            super::super::screen::recover_after_clean_end(&before, &old.id, Some((80, 24)), &|| {});
        assert!(replayed.log.is_some());
        assert_eq!(replayed.screen.is_drawing(), open_sync);
        drop(old);
        drop(cli);

        let (mut new, mut cli) = actor_with_cli(&after, messages.delivery_handle()).await;
        new.input_rule = Some(&rule.input);
        new.state = StateTracker::new(
            Some(rule),
            Instant::now(),
            kept,
            None,
            Some(&replayed.screen),
        );
        new.typist = Typist::new(&new.id, Some(rule), None, messages.delivery_handle());
        new.input_gate.report(new.state.native_wait());
        new.input_gate
            .recover(new.state.uses_native_reports(), new.state.answers_ask());
        new.screen_start = Some(ScreenStart::Recovered {
            screen: Box::new(replayed.screen),
            log: replayed.log,
            handed_over_cleanly: true,
            restart_size: None,
        });
        new.begin(true, false, TerminalColors::default()).await;
        assert_eq!(new.state.native_wait(), Some(WaitKind::Question));
        assert!(
            matches!(new.redraw_nudge, Some(RedrawNudge::Restart(_))),
            "an unresolved Muse question needs a new drawing after replay"
        );
        assert_eq!(cli.size(), (79, 24));
        let _settled = queue_a_message(
            &mut new,
            &messages,
            Instant::now() + Duration::from_secs(20),
        );
        new.type_next();
        assert!(new.pending_delivery.is_none() && new.input_gate.blocks_delivery());

        read_output(&mut new, &mut cli, live_output).await;
        assert_eq!(cli.size(), (80, 24));
        assert!(new.redraw_nudge.is_none());
        if new.pending_delivery.is_some() {
            issue_delivery(&mut new).await;
            expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
            panic!("the CLI received a paste using only the replayed composer");
        }
        assert_eq!(new.state.native_wait(), Some(WaitKind::Question));
        assert!(new.input_gate.blocks_delivery());

        read_output(&mut new, &mut cli, composer.as_bytes()).await;
        assert_eq!(new.state.native_wait(), None);
        assert!(!new.input_gate.blocks_delivery());
        issue_delivery(&mut new).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
    }

    #[tokio::test]
    async fn an_answer_that_asks_a_question_releases_delivery_after_a_fresh_composer() {
        let home = crate::test_folder::TestFolder::new("actor-answered-question-delivery");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let rule = facade_rules::find("muse").unwrap().unwrap();
        actor.input_rule = Some(&rule.input);
        actor.state = StateTracker::new(Some(rule), Instant::now(), Kept::default(), None, None);
        actor.typist = Typist::new(&actor.id, Some(rule), None, messages.delivery_handle());

        let border = "─".repeat(80);
        let composer = format!("\x1b[2J\x1b[H{border}\r\n❯ \r\n{border}\x1b[2;3H");
        read_output(&mut actor, &mut cli, composer.as_bytes()).await;
        actor.read_screen_status();
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);

        // Neither a still visible old composer nor an earlier synchronized drawing answers this.
        read_output(&mut actor, &mut cli, BLOCKED).await;
        let _settled = queue_a_message(
            &mut actor,
            &messages,
            Instant::now() + Duration::from_secs(20),
        );
        actor.type_next();
        assert!(actor.input_gate.blocks_delivery() && actor.pending_delivery.is_none());
        let report = std::str::from_utf8(BLOCKED).unwrap();
        let earlier = synchronized(&format!("{composer}{report}"));
        read_output(&mut actor, &mut cli, earlier.as_bytes()).await;
        assert!(actor.input_gate.blocks_delivery() && actor.pending_delivery.is_none());

        let menu = "\x1b[2J\x1b[HWhich one?\r\n⟩ 1  Yes\r\n  2  No";
        read_output(&mut actor, &mut cli, menu.as_bytes()).await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        assert!(actor.input_gate.blocks_delivery() && actor.pending_delivery.is_none());

        // A permission report waits even with a newly drawn ordinary composer.
        read_output(&mut actor, &mut cli, PERMISSION).await;
        let complete = synchronized(&composer);
        read_output(&mut actor, &mut cli, complete.as_bytes()).await;
        assert_eq!(actor.state.native_wait(), Some(WaitKind::Permission));
        assert!(actor.input_gate.blocks_delivery() && actor.pending_delivery.is_none());

        read_output(&mut actor, &mut cli, BLOCKED).await;
        let open = format!("\x1b[?2026h{composer}");
        read_output(&mut actor, &mut cli, open.as_bytes()).await;
        assert!(actor.input_gate.blocks_delivery() && actor.pending_delivery.is_none());
        read_output(&mut actor, &mut cli, b"\x1b[?2026l").await;
        actor.read_screen_status();
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        assert!(
            !actor.input_gate.blocks_delivery(),
            "Muse has finished and redrawn its composer"
        );
        assert_eq!(actor.state.native_wait(), None);
        assert!(actor.pending_delivery.is_some());
        issue_delivery(&mut actor).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ready_blocked_output_revokes_a_paste_while_the_composer_still_looks_empty() {
        let home = crate::test_folder::TestFolder::new("actor-paste-native-wait");
        let (mut actor, mut cli, settled) = pending_paste(&home).await;
        assert!(actor.pending_delivery.is_some());
        cli.write_output(BLOCKED).unwrap();
        actor.terminal.wait_for_queued_output(BLOCKED.len()).await;
        let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
        assert!(actor.input_gate.blocked());
        assert_eq!(actor.terminal.written(), 0);
        assert!(actor.pending_delivery.is_none() && settled.borrow().is_none());

        let preceding = format!("{}{IDLE}", plain_claude_frame("", ""));
        read_output(&mut actor, &mut cli, preceding.as_bytes()).await;
        assert!(
            actor.input_gate.blocked(),
            "the frame preceded the withdrawal"
        );
        assert_eq!(actor.state.native_wait(), None);
        assert!(actor.pending_delivery.is_none());

        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert!(!actor.input_gate.blocked());
        issue_delivery(&mut actor).await;
        assert!(actor.terminal.written() > 0 && settled.borrow().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_submission_intent_waits_for_reading_and_can_be_revoked_before_issue() {
        let home = crate::test_folder::TestFolder::new("actor-enter-native-wait");
        let (mut actor, mut cli, settled) = pending_paste(&home).await;
        issue_delivery(&mut actor).await;
        draw_input(&mut actor, "a message");
        actor.type_next();
        let rule = actor.typist.paste_rule().unwrap();
        tokio::time::sleep(facade_rules::settle_time(rule, "a message ")).await;
        actor.type_next();
        let written = actor.terminal.written();
        let pending = actor.pending_delivery.as_mut().unwrap();
        assert!(matches!(pending.kind, DeliveryWrite::Submit));

        let without_reads = actor.terminal.ready_with_delivery(
            TerminalWait::WriteOnly,
            Some(pending.terminal_input()),
            |_| Ok(false),
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), without_reads)
                .await
                .is_err()
        );
        assert_eq!(actor.terminal.written(), written);

        cli.write_output(BLOCKED).unwrap();
        actor.terminal.wait_for_queued_output(BLOCKED.len()).await;
        let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
        assert_eq!(actor.terminal.written(), written);
        assert!(actor.pending_delivery.is_none() && settled.borrow().is_none());

        let restored = format!("{IDLE}{}", plain_claude_frame("a message", ""));
        read_output(&mut actor, &mut cli, restored.as_bytes()).await;
        issue_delivery(&mut actor).await;
        assert_eq!(actor.terminal.written(), written + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn continuous_complete_composer_output_leaves_a_write_turn() {
        let home = crate::test_folder::TestFolder::new("actor-gate-output-prefix");
        let (mut actor, mut cli, _) = pending_paste(&home).await;
        let frame = plain_claude_frame("", "");
        cli.write_output(frame.as_bytes()).unwrap();
        actor.terminal.wait_for_queued_output(frame.len()).await;
        let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
        assert!(
            actor
                .pending_delivery
                .as_ref()
                .unwrap()
                .read_through
                .is_some()
        );
        let read = actor.terminal.output_position();
        cli.write_output(frame.as_bytes()).unwrap();
        actor.terminal.wait_for_queued_output(frame.len()).await;
        issue_delivery(&mut actor).await;
        assert_eq!(actor.terminal.output_position(), read);
        assert!(actor.terminal.written() > 0);
    }

    #[tokio::test]
    async fn manual_enters_through_a_wait_need_the_restored_draft_then_the_empty_frame() {
        for (restore_draft, keys_after_answer, edit_after_frame, delivered) in [
            (true, &b"\r"[..], None, true),
            (true, &b"\x02\r"[..], None, true),
            (false, &b"\r"[..], None, false),
            (true, &b"\r"[..], Some(0x03), false),
            (true, &b"\x7f"[..], None, false),
            (true, &b"\x15"[..], None, false),
            (true, &b"x\r"[..], None, false),
        ] {
            let home = crate::test_folder::TestFolder::new("actor-person-through-wait");
            let (mut actor, mut cli, settled) = pending_paste(&home).await;
            issue_delivery(&mut actor).await;
            draw_input(&mut actor, "a message");
            actor.type_next();
            read_output(&mut actor, &mut cli, PERMISSION).await;
            assert_eq!(actor.read_screen_input().info.state, InputState::Draft);
            assert!(
                !actor.paste_holds_keys(),
                "the report releases the delivery hold"
            );

            let written = actor.terminal.written();
            for key in std::iter::once(b'\r').chain(keys_after_answer.iter().copied()) {
                actor.take_keys(Instant::now(), vec![key], false);
                write_input(&mut actor).await;
                actor.take_terminal(TerminalEvent::Wrote);
            }
            let after_answer = written + 1 + keys_after_answer.len() as u64;
            assert_eq!(actor.terminal.written(), after_answer);
            assert!(settled.borrow().is_none());

            let mut output = IDLE.to_owned();
            if restore_draft {
                output.push_str("\x1b[?2026h");
                output.push_str(&plain_claude_frame("a message", ""));
                output.push_str("\x1b[?2026l");
            }
            if let Some(key) = edit_after_frame {
                read_output(&mut actor, &mut cli, output.as_bytes()).await;
                assert!(
                    settled.borrow().is_none(),
                    "a restored draft alone proves no delivery"
                );
                actor.take_keys(Instant::now(), vec![key], false);
                write_input(&mut actor).await;
                actor.take_terminal(TerminalEvent::Wrote);
                output.clear();
            }
            output.push_str("\x1b[?2026h");
            output.push_str(&plain_claude_frame("", ""));
            output.push_str("\x1b[?2026l");
            read_output(&mut actor, &mut cli, output.as_bytes()).await;

            if !delivered && settled.borrow().is_none() {
                assert!(!was_delivered(&settled));
                let deadline = actor.typist.draft_deadline().expect("the batch is pending");
                tokio::time::pause();
                tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
                actor.follow_enter();
                actor.type_next();
                tokio::time::resume();
            }
            let result = settled.borrow();
            let Some(Settled::Kept(message)) = result.as_ref() else {
                panic!(
                    "the batch has one receipt: {result:?}, keys {keys_after_answer:?}, later edit {edit_after_frame:?}"
                );
            };
            if delivered {
                assert_eq!(message.delivery.status, DeliveryStatus::Success);
            } else {
                assert_eq!(
                    message.delivery.status,
                    DeliveryStatus::Failure,
                    "keys after answer: {keys_after_answer:?}, edit after frame: {edit_after_frame:?}",
                );
                assert_eq!(
                    message.delivery.reason,
                    Some(DeliveryFailure::SubmissionUnconfirmed)
                );
                assert_eq!(message.delivery.text_written, TextWritten::Full);
                assert_eq!(message.delivery.enter_written, Some(false));
            }
            assert_eq!(
                actor.terminal.written(),
                after_answer + u64::from(edit_after_frame.is_some())
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_later_submission_after_editing_the_menu_keeps_the_warning() {
        submit_after_a_menu_edit(MENU.as_bytes(), InputState::Interaction).await;
    }

    #[tokio::test]
    async fn a_native_report_after_a_menu_edit_allows_a_later_proven_submission() {
        submit_after_a_menu_edit(PERMISSION, InputState::Draft).await;
    }

    async fn menu_after_a_person_edit(
        wait: &[u8],
        frame_state: InputState,
    ) -> (Actor, TestCli, watch::Receiver<Option<Settled>>) {
        let home = crate::test_folder::TestFolder::new("actor-edit-before-restored-draft");
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(&home).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
        draw_input(&mut actor, "a message");
        actor.type_next();
        read_output(&mut actor, &mut cli, PERMISSION).await;
        for &key in b"\r\x7f" {
            write_person_bytes(&mut actor, &mut cli, &[key]).await;
        }
        // The CLI acknowledged the edit while it was still in an interaction.
        read_output(&mut actor, &mut cli, wait).await;
        assert!(actor.state.native_wait().is_some());
        assert_eq!(actor.read_screen_input().info.state, frame_state);
        assert!(settled.borrow().is_none());
        (actor, cli, settled)
    }

    async fn submit_after_a_menu_edit(wait: &[u8], frame_state: InputState) {
        let (mut actor, mut cli, settled) = menu_after_a_person_edit(wait, frame_state).await;
        let written = actor.terminal.written();
        for _ in 0..2 {
            write_person_bytes(&mut actor, &mut cli, b"\r").await;
        }
        let output = format!(
            "{IDLE}\x1b[?25h{}{}",
            synchronized(&plain_claude_frame("a message", "")),
            synchronized(&plain_claude_frame("", "")),
        );
        cli.write_output(output.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, output.len()).await;
        if frame_state == InputState::Interaction {
            assert_interaction_warning(&settled, false);
        } else {
            assert!(
                was_delivered(&settled),
                "the later draft and empty frame prove submission: {:?}",
                settled.borrow().as_ref()
            );
        }
        assert_eq!(actor.terminal.written(), written + 2);
    }

    #[tokio::test]
    async fn a_later_draft_edit_still_blocks_proof_after_a_native_wait_report() {
        check_later_draft_edit(false).await;
    }

    #[tokio::test]
    async fn a_composer_edit_after_escape_cannot_use_an_earlier_native_wait() {
        check_later_draft_edit(true).await;
    }

    async fn check_later_draft_edit(close_with_escape: bool) {
        let (mut actor, mut cli, settled) =
            menu_after_a_person_edit(PERMISSION, InputState::Draft).await;
        if close_with_escape {
            write_person_bytes(&mut actor, &mut cli, b"\x1b").await;
            tokio::time::pause();
            tokio::time::advance(crate::agent::ESCAPE_DELAY + Duration::from_millis(1)).await;
            tokio::time::resume();
        }
        let restored = format!(
            "{IDLE}{}",
            synchronized(&plain_claude_frame("a message", ""))
        );
        cli.write_output(restored.as_bytes()).unwrap();

        // The CLI has restored the draft, but the actor has not read that output yet.
        write_person_bytes(&mut actor, &mut cli, b"x").await;
        write_person_bytes(&mut actor, &mut cli, b"\r").await;
        let empty = synchronized(&plain_claude_frame("", ""));
        cli.write_output(empty.as_bytes()).unwrap();
        read_buffered_frames(&mut actor, restored.len() + empty.len()).await;
        assert!(
            !was_delivered(&settled),
            "the native report only accounts for the earlier edit"
        );
    }

    async fn short_erase_waiting_in_a_menu(home: &Path) -> (Actor, TestCli, usize) {
        let (mut actor, mut cli, settled) = waiting_for_the_paste_frame(home).await;
        expect_cli_input(&mut cli, b"\x1b[200~a message \x1b[201~");
        draw_input(&mut actor, "a message");
        actor.type_next();
        let due = actor
            .typist
            .draft_deadline()
            .expect("the paste has a deadline");
        tokio::time::pause();
        tokio::time::advance(due.saturating_duration_since(Instant::now())).await;
        tokio::time::resume();
        actor.type_next();
        let erase = actor
            .pending_delivery
            .as_mut()
            .expect("the draft is offered for cleanup");
        assert!(matches!(erase.kind, DeliveryWrite::Erase { .. }));
        let remaining = erase.write.len() - 2;
        assert!(remaining > 0);
        let until = erase.deadline;
        // The terminal accepted just the first two independent Backspaces.
        erase.write.truncate(2);
        issue_delivery(&mut actor).await;
        expect_cli_input(&mut cli, b"\x7f\x7f");

        let mut wait = BLOCKED.to_vec();
        wait.extend_from_slice(MENU.as_bytes());
        read_output(&mut actor, &mut cli, &wait).await;
        assert!(actor.input_gate.blocked());
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        tokio::time::pause();
        tokio::time::advance(
            until.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
        )
        .await;
        tokio::time::resume();
        actor.type_next();
        assert!(settled.borrow().is_some());
        (actor, cli, remaining)
    }

    #[tokio::test]
    async fn a_short_erase_tail_never_types_over_a_person_s_new_draft() {
        let home = crate::test_folder::TestFolder::new("actor-short-erase-and-human-draft");
        let (mut actor, mut cli, _) = short_erase_waiting_in_a_menu(&home).await;
        // The CLI restores the old remainder, then takes the person's edit while reads are paused.
        write_person_bytes(&mut actor, &mut cli, b"\r").await;
        let restored = format!(
            "{IDLE}\x1b[?25h{}",
            synchronized(&plain_claude_frame("a messag", ""))
        );
        let restored_at = actor.terminal.output_position();
        cli.write_output(restored.as_bytes()).unwrap();
        actor.terminal.wait_for_queued_output(restored.len()).await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        write_person_bytes(&mut actor, &mut cli, b"\x15a m").await;
        let human = synchronized(&plain_claude_frame("a m", ""));
        cli.write_output(human.as_bytes()).unwrap();
        let end = restored_at + (restored.len() + human.len()) as u64;
        let readable = end.saturating_sub(actor.terminal.output_position()) as usize;
        read_buffered_frames(&mut actor, readable).await;
        assert_eq!(actor.read_screen_input().draft.as_deref(), Some("a m"));

        let written = actor.terminal.written();
        if actor.pending_delivery.is_some() {
            issue_delivery(&mut actor).await;
        }
        assert_eq!(
            actor.terminal.written(),
            written,
            "cleanup must leave the person's draft alone"
        );
    }

    #[tokio::test]
    async fn a_menu_only_edit_keeps_the_owned_erase_tail() {
        let (report, terminator) = BLOCKED.split_at(BLOCKED.len() - 1);
        for acknowledgement in [&[MENU.as_bytes()][..], &[BLOCKED], &[report, terminator]] {
            let home = crate::test_folder::TestFolder::new("actor-short-erase-and-menu-edit");
            let (mut actor, mut cli, remaining) = short_erase_waiting_in_a_menu(&home).await;
            write_person_bytes(&mut actor, &mut cli, b"\x7f").await;
            for output in acknowledgement {
                read_output(&mut actor, &mut cli, output).await;
            }
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
            expect_restored_erase_tail(&mut actor, &mut cli, remaining).await;
        }
    }

    #[tokio::test]
    async fn a_complete_menu_redraw_keeps_the_erase_tail_across_reads() {
        let split = MENU.find("No, exit").unwrap() + "No".len();
        for split in [MENU.len(), split] {
            let home = crate::test_folder::TestFolder::new("actor-menu-redraw-across-reads");
            let (mut actor, mut cli, remaining) = short_erase_waiting_in_a_menu(&home).await;
            read_output(&mut actor, &mut cli, IDLE.as_bytes()).await;
            write_person_bytes(&mut actor, &mut cli, b"\x7f").await;
            let (first, rest) = MENU.as_bytes().split_at(split);
            read_output(&mut actor, &mut cli, first).await;
            if !rest.is_empty() {
                read_output(&mut actor, &mut cli, rest).await;
            }
            assert_eq!(
                actor.read_screen_input().info.state,
                InputState::Interaction
            );
            expect_restored_erase_tail(&mut actor, &mut cli, remaining).await;
        }
    }

    #[tokio::test]
    async fn an_earlier_wait_withdrawal_preserves_the_later_proven_menu_edit() {
        for split in [0, IDLE.len() - 1] {
            let home = crate::test_folder::TestFolder::new("actor-old-withdrawal-before-menu-edit");
            let (mut actor, mut cli, remaining) = short_erase_waiting_in_a_menu(&home).await;

            let (prefix, unread) = IDLE.as_bytes().split_at(split);
            let preceding = if prefix.is_empty() {
                // Both reports are already in the pipe when Backspace reaches the new question.
                let preceding = [unread, BLOCKED].concat();
                cli.write_output(&preceding).unwrap();
                actor.terminal.wait_for_queued_output(preceding.len()).await;
                preceding.len()
            } else {
                // The old withdrawal started before the key. Only its terminator comes later.
                read_output(&mut actor, &mut cli, prefix).await;
                0
            };
            let position_before_edit = actor.terminal.output_position();
            write_person_bytes(&mut actor, &mut cli, b"\x7f").await;
            let mut acknowledged = if preceding == 0 {
                unread.to_vec()
            } else {
                Vec::new()
            };
            acknowledged.extend_from_slice(BLOCKED);
            acknowledged.extend_from_slice(MENU.as_bytes());
            cli.write_output(&acknowledged).unwrap();
            let end = position_before_edit + (preceding + acknowledged.len()) as u64;
            let readable = end.saturating_sub(actor.terminal.output_position()) as usize;
            read_buffered_frames(&mut actor, readable).await;
            assert!(actor.input_gate.blocked());

            expect_restored_erase_tail(&mut actor, &mut cli, remaining).await;
        }
    }

    async fn expect_restored_erase_tail(actor: &mut Actor, cli: &mut TestCli, remaining: usize) {
        write_person_bytes(actor, cli, b"\r").await;
        let restored = format!(
            "{IDLE}\x1b[?25h{}",
            synchronized(&plain_claude_frame("a messag", ""))
        );
        cli.write_output(restored.as_bytes()).unwrap();
        read_buffered_frames(actor, restored.len()).await;
        assert_eq!(actor.read_screen_input().draft.as_deref(), Some("a messag"));
        let before = actor.terminal.written();
        if actor.pending_delivery.is_some() {
            issue_delivery(actor).await;
        }
        assert_eq!(
            actor.terminal.written() - before,
            remaining as u64,
            "a menu edit leaves the original cleanup remainder owned"
        );
        expect_cli_input(cli, &vec![0x7f; remaining]);
    }

    #[tokio::test]
    async fn unrelated_output_cannot_refresh_the_stale_menu_for_cleanup() {
        for on_selected_row in [false, true] {
            check_stale_wait_cannot_authorize_cleanup(IDLE.as_bytes(), |actor| {
                let (cols, rows) = actor.size();
                let (row, column) = if on_selected_row {
                    (7, cols)
                } else {
                    (rows, 1)
                };
                format!("\x1b7\x1b[{row};{column}H*\x1b8").into_bytes()
            })
            .await;
        }
    }

    #[tokio::test]
    async fn a_wait_report_started_before_the_composer_edit_cannot_authorize_cleanup() {
        let (report, terminator) = BLOCKED.split_at(BLOCKED.len() - 1);
        check_stale_wait_cannot_authorize_cleanup(report, |_| terminator.to_vec()).await;
    }

    async fn check_stale_wait_cannot_authorize_cleanup(
        before_edit: &[u8],
        after_edit: impl FnOnce(&Actor) -> Vec<u8>,
    ) {
        let home = crate::test_folder::TestFolder::new("actor-stale-menu-and-person-draft");
        let (mut actor, mut cli, _) = short_erase_waiting_in_a_menu(&home).await;
        write_person_bytes(&mut actor, &mut cli, b"\r").await;
        // The editor takes the person's keys before it has repainted the composer.
        read_output(&mut actor, &mut cli, before_edit).await;
        write_person_bytes(&mut actor, &mut cli, b"\x15a m").await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        let after_edit = after_edit(&actor);
        read_output(&mut actor, &mut cli, &after_edit).await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        let human = format!(
            "{IDLE}\x1b[?25h{}",
            synchronized(&plain_claude_frame("a m", ""))
        );
        let written = actor.terminal.written();
        read_output(&mut actor, &mut cli, human.as_bytes()).await;
        assert_eq!(actor.read_screen_input().draft.as_deref(), Some("a m"));
        if let Some(pending) = &actor.pending_delivery {
            assert!(matches!(pending.kind, DeliveryWrite::Erase { .. }));
            issue_delivery(&mut actor).await;
        }
        assert_eq!(
            actor.terminal.written() - written,
            0,
            "input in the composer belongs to the person"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_interaction_separates_an_old_ordinary_enter_from_a_later_empty_frame() {
        for wait in [PERMISSION, MENU.as_bytes()] {
            let home = crate::test_folder::TestFolder::new("actor-old-draft-before-prompt");
            let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&home).await;
            draw_input(&mut actor, "a message");
            cli.write_output(wait).unwrap();
            actor.terminal.wait_for_queued_output(wait.len()).await;
            write_input(&mut actor).await;
            actor.take_terminal(TerminalEvent::Wrote);
            let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
            assert!(matches!(event, TerminalEvent::Read));
            actor.take_terminal(event);
            assert!(actor.input_gate.blocked());

            let empty = format!("{IDLE}\x1b[?25h{}", plain_claude_frame("", ""));
            read_output(&mut actor, &mut cli, empty.as_bytes()).await;
            let rule = actor.typist.paste_rule().unwrap();
            tokio::time::sleep(facade_rules::settle_time(rule, "a message ")).await;
            actor.type_next();
            assert!(
                !matches!(
                    settled.borrow().as_ref(),
                    Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
                ),
                "an Enter that answered the interaction never took the draft"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_ordinary_submission_can_be_proven_before_a_wait_in_the_same_read() {
        let home = crate::test_folder::TestFolder::new("actor-already-submitted-before-prompt");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&home).await;
        draw_input(&mut actor, "a message");
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);

        let mut output =
            format!("\x1b[?2026h{}\x1b[?2026l", plain_claude_frame("", "")).into_bytes();
        output.extend_from_slice(BLOCKED);
        read_output(&mut actor, &mut cli, &output).await;
        assert!(actor.input_gate.blocked());
        assert!(matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_split_focus_report_keeps_the_buffered_batch_submission() {
        let home = crate::test_folder::TestFolder::new("actor-focus-batch-submission");
        let (mut actor, mut cli, settled) = pending_paste(&home).await;
        issue_delivery(&mut actor).await;
        draw_input(&mut actor, "a message");
        actor.type_next();
        read_output(&mut actor, &mut cli, PERMISSION).await;
        for &key in b"\r\r\x1b" {
            actor.take_keys(Instant::now(), vec![key], false);
            write_input(&mut actor).await;
            actor.take_terminal(TerminalEvent::Wrote);
        }

        let output = format!(
            "{IDLE}\x1b[?2026h{}\x1b[?2026l\x1b[?2026h{}\x1b[?2026l",
            plain_claude_frame("a message", ""),
            plain_claude_frame("", ""),
        );
        read_output(&mut actor, &mut cli, output.as_bytes()).await;
        assert!(actor.person.lone_escape() && actor.person.partial_until(Instant::now()).is_some());
        assert!(
            settled.borrow().is_none(),
            "the key is still being classified"
        );
        actor.take_keys(Instant::now(), b"[I".to_vec(), false);
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        actor.type_next();
        assert!(matches!(
            settled.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn clean_handover_keeps_an_unissued_first_paste_waiting_for_a_fresh_attempt() {
        let home = crate::test_folder::TestFolder::new("actor-handover-unissued-paste");
        let (original, store) = messages();
        let (mut actor, mut cli, original_receipt) = pending_paste_in(&home, &original).await;
        assert!(actor.pending_delivery.is_some());
        read_output(&mut actor, &mut cli, BLOCKED).await;
        assert_eq!(actor.terminal.written(), 0);
        let reserved = original.pending().unwrap().pop().unwrap();
        assert_eq!(reserved.paste, Some(1), "the reservation is durable");

        let (reply, quiet) = oneshot::channel();
        assert!(actor.take_command(AgentCommand::Quiesce { reply }).await);
        quiet.await.unwrap();
        assert!(original_receipt.borrow().is_none());
        drop(actor);
        drop(original);

        let recovered = Messages::new(store.message_table(), store.test_machine_id());
        let pending = recovered.pending().unwrap().pop().unwrap();
        assert_eq!(
            pending.message.delivery.deadline,
            reserved.message.delivery.deadline
        );
        let TakeUp::Type(time_left) = decide(
            &pending.message,
            pending.paste,
            Recipient::Running,
            SystemTime::now(),
        ) else {
            panic!("the next daemon queues the message under the original deadline");
        };
        let receipt = recovered.take_up(pending.message, false, false, None);
        let next_home = crate::test_folder::TestFolder::new("actor-resume-unissued-paste");
        let (mut next, mut next_cli) = test_actor(&next_home, &recovered).await;
        read_output(&mut next, &mut next_cli, BLOCKED).await;
        queue_test_delivery(&mut next, 1, time_left);
        assert!(next.pending_delivery.is_none());
        let ready = format!("{IDLE}{}", plain_claude_frame("", ""));
        read_output(&mut next, &mut next_cli, ready.as_bytes()).await;
        issue_delivery(&mut next).await;
        assert_eq!(
            next.terminal.written(),
            b"\x1b[200~a message \x1b[201~".len() as u64
        );
        let draft = plain_claude_frame("a message", "");
        read_output(&mut next, &mut next_cli, draft.as_bytes()).await;
        let rule = next.typist.paste_rule().unwrap();
        tokio::time::sleep(facade_rules::settle_time(rule, "a message ")).await;
        next.type_next();
        issue_delivery(&mut next).await;
        let empty = plain_claude_frame("", "");
        read_output(&mut next, &mut next_cli, empty.as_bytes()).await;
        assert!(matches!(
            receipt.borrow().as_ref(),
            Some(Settled::Kept(message)) if message.delivery.status == DeliveryStatus::Success
        ));
        assert_eq!(
            next.terminal.written(),
            b"\x1b[200~a message \x1b[201~\r".len() as u64
        );
        assert!(recovered.pending().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_later_clear_preserves_a_submission_already_buffered_by_the_terminal() {
        for write_clear in [false, true] {
            let home = crate::test_folder::TestFolder::new("actor-person-before-clear");
            let (mut actor, mut cli, settled) = pending_paste(&home).await;
            issue_delivery(&mut actor).await;
            draw_input(&mut actor, "a message");
            actor.type_next();
            read_output(&mut actor, &mut cli, PERMISSION).await;
            for _ in 0..2 {
                actor.take_keys(Instant::now(), b"\r".to_vec(), false);
                write_input(&mut actor).await;
                actor.take_terminal(TerminalEvent::Wrote);
            }
            let output = format!(
                "{IDLE}\x1b[?2026h{}\x1b[?2026l\x1b[?2026h{}\x1b[?2026l",
                plain_claude_frame("a message", ""),
                plain_claude_frame("", ""),
            );
            cli.write_output(output.as_bytes()).unwrap();
            actor.terminal.wait_for_queued_output(output.len()).await;
            actor.take_keys(Instant::now(), b"\x03".to_vec(), false);
            if write_clear {
                write_input(&mut actor).await;
                actor.take_terminal(TerminalEvent::Wrote);
            } else {
                assert_eq!(actor.terminal.queued(), 1);
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut read = 0;
                while read < output.len() {
                    if let Some(count) = actor.terminal.read_now() {
                        read += count;
                        actor.take_terminal(TerminalEvent::Read);
                    } else {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
            })
            .await
            .expect("the earlier frames reach the actor");
            let result = settled.borrow();
            assert!(
                matches!(&*result, Some(Settled::Kept(message))
                    if message.delivery.status == DeliveryStatus::Success),
                "the earlier frames prove delivery before the interrupt: {result:?}"
            );
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
        let frame = plain_claude_frame("", "");
        cli.write_output(frame.as_bytes()).unwrap();
        actor.terminal.wait_for_queued_output(frame.len()).await;

        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        assert!(settled.borrow().is_none());
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor
                .terminal
                .ready(TerminalWait::ReadAndWrite, |offset, count| {
                    actor.typist.before_write(offset, count)
                }),
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
        actor.terminal.wait_for_queued_output(frame.len()).await;

        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor
                .terminal
                .ready(TerminalWait::ReadAndWrite, |offset, count| {
                    actor.typist.before_write(offset, count)
                }),
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
        let paste = b"\x1b[200~a message \x1b[201~";
        let mut taken = [0; b"\x1b[200~a message \x1b[201~".len()];
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
            actor
                .terminal
                .ready(TerminalWait::ReadAndWrite, |offset, count| {
                    actor.typist.before_write(offset, count)
                }),
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
            actor.terminal.wait_for_queued_output(old.len()).await;

            write_input(&mut actor).await;
            actor.take_terminal(TerminalEvent::Wrote);
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::ReadAndWrite, |offset, count| {
                        actor.typist.before_write(offset, count)
                    }),
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
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&home).await;
        write_input(&mut actor).await;
        draw_input(&mut actor, "a message");
        actor.take_keys(Instant::now(), vec![0x03], false);
        assert!(
            !actor.submitting.is_empty(),
            "the interrupt is still queued"
        );
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
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
        let mut paste = [0; b"\x1b[200~a message \x1b[201~".len()];
        let mut read = 0;
        while read < paste.len() {
            let n = cli.read_input(&mut paste[read..]).unwrap();
            assert!(n > 0);
            read += n;
        }
        assert_eq!(paste, *b"\x1b[200~a message \x1b[201~");
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

    #[tokio::test]
    async fn a_probe_releases_person_input_after_restoration_or_timeout() {
        for echo in [true, false] {
            let home = crate::test_folder::TestFolder::new("actor-probe-before-person");
            let (messages, _) = messages();
            let (mut actor, mut cli) = waiting_for_probe_space(&home, &messages).await;
            let (tab, receipt) =
                Typing::sequence(vec![facade_base::api_v1::daemon::InputStep::Key {
                    key: "Tab".into(),
                }])
                .unwrap();
            actor.take_input(Input::Typed(tab), actor.run).unwrap();
            actor
                .take_input(Input::Raw(b"x".to_vec()), actor.run)
                .unwrap();
            assert_eq!(actor.held.len(), 2);
            assert_eq!(actor.terminal.queued(), 0);

            tokio::time::pause();
            tokio::time::advance(Duration::from_millis(1500)).await;
            actor.type_next();
            assert!(actor.typist.probing());
            assert_eq!(actor.terminal.queued(), 0);
            tokio::time::resume();

            if echo {
                let space = synchronized(&plain_claude_frame(" ", ""));
                draw_probe_space(&mut actor, &mut cli, &space).await;
                assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, 0x7f);
                tokio::time::pause();
                tokio::time::advance(Duration::from_millis(1500)).await;
                actor.type_next();
                assert!(actor.typist.probing(), "Backspace still awaits its echo");
                assert_eq!(actor.terminal.queued(), 0);
                tokio::time::resume();

                let hint = plain_claude_frame("", "\x1b[32mTry this\x1b[0m");
                read_output(&mut actor, &mut cli, hint.as_bytes()).await;
                for _ in 0..2 {
                    if actor.typist.probing() {
                        advance_probe_read(&mut actor).await;
                    }
                }
            } else {
                tokio::time::pause();
                tokio::time::advance(Duration::from_millis(500)).await;
                actor.type_next();
                tokio::time::resume();
            }
            assert!(!actor.typist.probing());
            assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, b'\t');
            assert!(receipt.await.unwrap().is_ok());
            actor.release_held();
            assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, b'x');

            if !echo {
                let late = synchronized(&plain_claude_frame(" ", ""));
                read_output(&mut actor, &mut cli, late.as_bytes()).await;
                assert_eq!(actor.terminal.queued(), 0);
                assert!(!actor.typist.probing());
            }
        }
    }

    #[tokio::test]
    async fn a_probe_needs_a_complete_frame_after_the_space_write_to_erase() {
        let home = crate::test_folder::TestFolder::new("actor-probe-prewrite-echo");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let hint = plain_claude_frame("", "\x1b[32mTry this\x1b[0m");
        actor.feed_own(hint.as_bytes());
        let space = synchronized(&plain_claude_frame(" ", ""));
        let earlier = format!("{space}{}", synchronized(&hint));
        cli.write_output(earlier.as_bytes()).unwrap();
        actor.terminal.wait_for_queued_output(earlier.len()).await;
        actor.typist.want_probe();
        actor.type_next();
        assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, b' ');
        assert_eq!(actor.terminal.output_position(), earlier.len() as u64);

        advance_probe_read(&mut actor).await;
        assert_eq!(actor.terminal.queued(), 0);
        draw_probe_space(&mut actor, &mut cli, &space).await;
        assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, 0x7f);
    }

    async fn waiting_for_probe_space(home: &Path, messages: &Messages) -> (Actor, TestCli) {
        let (mut actor, mut cli) = actor_with_cli(home, messages.delivery_handle()).await;
        actor.feed_own(plain_claude_frame("", "\x1b[32mTry this\x1b[0m").as_bytes());
        actor.typist.want_probe();
        actor.type_next();
        assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, b' ');
        (actor, cli)
    }

    async fn advance_probe_read(actor: &mut Actor) {
        tokio::time::pause();
        let wake = actor
            .typist_at
            .expect("the probe has another reading to take");
        tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
        actor.type_next();
        tokio::time::resume();
    }

    async fn draw_probe_space(actor: &mut Actor, cli: &mut TestCli, space: &str) {
        read_output(actor, cli, space.as_bytes()).await;
        for _ in 0..2 {
            if actor.terminal.queued() == 0 {
                advance_probe_read(actor).await;
            }
        }
        assert_eq!(
            actor.terminal.queued(),
            1,
            "the fresh space permits Backspace"
        );
    }

    async fn read_one_probe_key(actor: &mut Actor, cli: &mut TestCli) -> u8 {
        assert_eq!(actor.terminal.queued(), 1);
        let [key]: [u8; 1] = read_queued_probe_input(actor, cli)
            .await
            .try_into()
            .unwrap();
        key
    }

    #[tokio::test]
    async fn a_buffered_menu_revokes_an_unissued_probe_space() {
        let home = crate::test_folder::TestFolder::new("actor-probe-space-before-menu");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let hint = plain_claude_frame("", "\x1b[32mTry this\x1b[0m");
        actor.feed_own(hint.as_bytes());
        actor.typist.want_probe();
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 1);

        let menu = synchronized(&claude_trust_frame(false));
        cli.write_output(menu.as_bytes()).unwrap();
        actor.terminal.wait_for_queued_output(menu.len()).await;
        assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, b"");
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        assert!(!actor.typist.probing());

        let ordinary = synchronized(&format!("\x1b[?25h{hint}"));
        read_output(&mut actor, &mut cli, ordinary.as_bytes()).await;
        actor.typist.want_probe();
        actor.type_next();
        assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, b' ');
    }

    #[tokio::test]
    async fn a_buffered_sync_begin_revokes_an_unissued_probe_space() {
        let home = crate::test_folder::TestFolder::new("actor-probe-space-open-update");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let hint = plain_claude_frame("", "\x1b[32mTry this\x1b[0m");
        actor.feed_own(hint.as_bytes());
        actor.typist.want_probe();
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 1);

        let opener = b"\x1b[?2026h";
        cli.write_output(opener).unwrap();
        actor.terminal.wait_for_queued_output(opener.len()).await;
        let keys = read_queued_probe_input(&mut actor, &mut cli).await;
        let screen = actor.screen().screen();
        assert!(screen.synchronized_update_deadline().is_some());
        assert!(!screen.is_drawing(), "only the opener reached the terminal");
        let menu = format!("{}\x1b[?2026l", claude_trust_frame(false));
        read_output(&mut actor, &mut cli, menu.as_bytes()).await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        assert!(keys.is_empty());
    }

    #[tokio::test]
    async fn a_resize_revokes_the_approval_of_a_probe_space() {
        let home = crate::test_folder::TestFolder::new("actor-probe-space-before-resize");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let hint = plain_claude_frame("", "\x1b[32mTry this\x1b[0m");
        actor.feed_own(hint.as_bytes());
        let before = actor.read_screen_input();
        assert!(before.unsure);
        actor.typist.want_probe();
        actor.type_next();
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready(TerminalWait::WriteOnly, |_, _| true),
        )
        .await
        .unwrap();
        assert!(matches!(
            event,
            TerminalEvent::ProbeNeedsCheck(ProbeKey::Space)
        ));
        actor.take_terminal(event);
        assert_eq!(actor.terminal.queued(), 1);
        let output = actor.terminal.output_position();

        actor.take_size(SizeRequest::Direct(Size { cols: 5, rows: 4 }));
        let current = actor.read_screen_input();
        assert!(!current.unsure || current.line != before.line);
        assert_eq!(actor.terminal.output_position(), output);
        assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, b"");
    }

    #[tokio::test]
    async fn an_approved_probe_space_is_revoked_by_a_later_question_report() {
        let home = crate::test_folder::TestFolder::new("actor-probe-space-before-question");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
        let hint = plain_claude_frame("", "\x1b[32mTry this\x1b[0m");
        actor.feed_own(hint.as_bytes());
        actor.typist.want_probe();
        actor.type_next();
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            actor.terminal.ready(TerminalWait::WriteOnly, |_, _| true),
        )
        .await
        .unwrap();
        assert!(matches!(
            event,
            TerminalEvent::ProbeNeedsCheck(ProbeKey::Space)
        ));
        actor.take_terminal(event);
        assert_eq!(actor.terminal.queued(), 1);

        let question = b"\x1b]7501;state=blocked:kind=question\x07";
        cli.write_output(question).unwrap();
        actor.terminal.wait_for_queued_output(question.len()).await;
        assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, b"");
        assert!(actor.state.native_wait().is_some());
        assert!(
            actor.read_screen_input().unsure,
            "the ordinary drawing is unchanged"
        );
        actor.typist.want_probe();
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);
    }

    #[tokio::test]
    async fn the_first_hint_after_startup_consent_can_be_probed() {
        for consent in [None, Some(false), Some(true)] {
            let home = crate::test_folder::TestFolder::new("actor-startup-consent-probe");
            let (messages, _) = messages();
            let (mut actor, mut cli) = test_actor_for(&home, &messages, "claude").await;
            actor.untouched_input = true;
            actor.before_input_box = true;
            let _settled = queue_a_message(
                &mut actor,
                &messages,
                Instant::now() + Duration::from_secs(15),
            );
            if let Some(named) = consent {
                read_output(&mut actor, &mut cli, MENU.as_bytes()).await;
                assert_eq!(
                    actor.read_screen_input().info.state,
                    InputState::Interaction
                );
                assert!(
                    actor.state.native_wait().is_none(),
                    "the screen identified the menu"
                );
                let keys = b"\x1b[B\r";
                if named {
                    let (call, answered) = Typing::keys(&["Down".into(), "Enter".into()]).unwrap();
                    actor.take_input(Input::Typed(call), actor.run).unwrap();
                    assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, keys);
                    assert!(answered.await.unwrap().is_ok());
                } else {
                    actor
                        .take_input(Input::Raw(keys.to_vec()), actor.run)
                        .unwrap();
                    actor.let_enter_go();
                    assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, keys);
                }
                assert!(
                    actor.untouched_input,
                    "startup consent keeps the first hint eligible"
                );
                read_output(&mut actor, &mut cli, b"\x1b]0;ready\x07").await;
                assert_eq!(
                    actor.terminal.queued(),
                    0,
                    "the old menu still holds the probe"
                );
            }
            let hint = plain_claude_frame("", "Try this");
            let frame = synchronized(&format!("\x1b[?25h{hint}"));
            read_output(&mut actor, &mut cli, frame.as_bytes()).await;
            assert!(actor.read_input_box(true).unsure);
            actor.type_next();
            assert_eq!(
                read_queued_probe_input(&mut actor, &mut cli).await,
                b" ",
                "consent={consent:?}"
            );
        }
    }

    #[tokio::test]
    async fn kiro_can_probe_the_first_redrawn_composer_after_startup_consent() {
        let home = crate::test_folder::TestFolder::new("actor-kiro-startup-probe");
        let (messages, _) = messages();
        let (mut actor, mut cli) = test_actor_for(&home, &messages, "kiro-cli").await;
        actor.untouched_input = true;
        actor.before_input_box = true;
        let _settled = queue_a_message(
            &mut actor,
            &messages,
            Instant::now() + Duration::from_secs(15),
        );
        let menu = synchronized(
            "\x1b[?25l\x1b[H ❯ No, exit\r\n   Yes, I accept\r\n  esc to cancel · ↑↓ to navigate · ↵ to select",
        );
        read_output(&mut actor, &mut cli, menu.as_bytes()).await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        assert_eq!(actor.terminal.queued(), 0);

        let composer = "\x1b[2J\x1b[4;1H› \x1b[7m \x1b[27;38;5;245m";
        let working = format!("{composer}Kiro is working · Type to steer · Ctrl+S to queue\x1b[0m");
        read_output(&mut actor, &mut cli, synchronized(&working).as_bytes()).await;
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);

        let first_hint = format!("\x1b[?2026h{composer}ask a question or describe a task ↵\x1b[0m");
        read_output(&mut actor, &mut cli, first_hint.as_bytes()).await;
        actor.type_next();
        assert_eq!(actor.terminal.queued(), 0);
        read_output(&mut actor, &mut cli, b"\x1b[?2026l").await;
        assert!(actor.read_screen_input().unsure);
        actor.type_next();
        assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, b" ");
        assert_eq!(pending_delivery_bytes(&actor), 0);
    }

    #[tokio::test]
    async fn a_fresh_hint_after_a_native_wait_can_be_probed() {
        for waiting_message in [false, true] {
            let home = crate::test_folder::TestFolder::new("actor-probe-after-native-wait");
            let (messages, _) = messages();
            let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
            let hint = plain_claude_frame("", "\x1b[32mTry this\x1b[0m");
            actor.feed_own(hint.as_bytes());
            actor.typist.want_probe();
            actor.type_next();
            assert_eq!(actor.terminal.queued(), 1);

            cli.write_output(b"\x1b]7501;state=blocked:kind=question\x07")
                .unwrap();
            assert!(
                read_queued_probe_input(&mut actor, &mut cli)
                    .await
                    .is_empty()
            );

            let _settled = waiting_message.then(|| {
                queue_a_message(
                    &mut actor,
                    &messages,
                    Instant::now() + Duration::from_secs(20),
                )
            });
            let check = |actor: &mut Actor| {
                if !waiting_message {
                    actor.typist.want_probe();
                }
                actor.type_next();
            };
            let draw = synchronized(&hint);
            read_output(&mut actor, &mut cli, draw.as_bytes()).await;
            assert_eq!(actor.state.native_wait(), Some(WaitKind::Question));
            check(&mut actor);
            assert_eq!(actor.terminal.queued(), 0, "the native wait remains active");

            // Even an identical frame assembled before the withdrawal is old when it closes.
            let begun = format!("\x1b[?2026h{hint}");
            read_output(&mut actor, &mut cli, begun.as_bytes()).await;
            read_output(&mut actor, &mut cli, IDLE.as_bytes()).await;
            assert_eq!(actor.state.native_wait(), None);
            check(&mut actor);
            assert_eq!(
                actor.terminal.queued(),
                0,
                "the withdrawal alone is not a new frame"
            );
            read_output(&mut actor, &mut cli, b"\x1b[?2026l").await;
            check(&mut actor);
            assert_eq!(actor.terminal.queued(), 0, "the preceding paint stays old");

            read_output(&mut actor, &mut cli, begun.as_bytes()).await;
            check(&mut actor);
            assert_eq!(actor.terminal.queued(), 0, "the new frame is still open");
            read_output(&mut actor, &mut cli, b"\x1b[?2026l").await;
            let reading = actor.read_screen_input();
            assert!(reading.unsure && reading.line.is_some());
            check(&mut actor);
            assert_eq!(
                actor.terminal.queued(),
                1,
                "the fresh, ordinary hint needs a probe"
            );
            let received = read_queued_probe_input(&mut actor, &mut cli).await;
            assert_eq!(
                received, b" ",
                "the PTY takes the fresh probe, waiting_message={waiting_message}"
            );
            assert_eq!(
                pending_delivery_bytes(&actor),
                0,
                "a possible hint is not yet proved empty"
            );

            if waiting_message {
                let echo = synchronized(&plain_claude_frame(" ", ""));
                read_output(&mut actor, &mut cli, echo.as_bytes()).await;
                tokio::time::pause();
                for _ in 0..2 {
                    if let Some(wake) = actor.typist_at {
                        tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
                        actor.type_next();
                    }
                }
                tokio::time::resume();
                assert!(
                    actor.input_gate.permits_probe(),
                    "the echoed probe still has an ordinary box"
                );
                let keys = read_queued_probe_input(&mut actor, &mut cli).await;
                assert_eq!(
                    keys,
                    b"\x7f",
                    "the PTY takes the verified erase; input {:?}",
                    actor.read_screen_input()
                );
                read_output(&mut actor, &mut cli, draw.as_bytes()).await;
                tokio::time::pause();
                for _ in 0..3 {
                    if let Some(wake) = actor.typist_at {
                        tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
                        actor.type_next();
                    }
                }
                tokio::time::resume();
                assert!(!actor.typist.probing());
                let paste = b"\x1b[200~a message \x1b[201~";
                assert_eq!(
                    pending_delivery_bytes(&actor),
                    paste.len(),
                    "the next message can use the freshly proved empty input"
                );
                write_input(&mut actor).await;
                expect_cli_input(&mut cli, paste);
            }
        }
    }

    async fn read_queued_probe_input(actor: &mut Actor, cli: &mut TestCli) -> Vec<u8> {
        let mut keys = Vec::with_capacity(actor.terminal.queued());
        while actor.terminal.queued() > 0 {
            let before = actor.terminal.written();
            let event = tokio::time::timeout(
                Duration::from_secs(5),
                actor
                    .terminal
                    .ready(TerminalWait::WriteOnly, |offset, count| {
                        actor.typist.before_write(offset, count)
                    }),
            )
            .await
            .expect("the terminal processes the queued input");
            assert!(matches!(
                event,
                TerminalEvent::Wrote | TerminalEvent::ProbeNeedsCheck(_)
            ));
            let end = keys.len() + (actor.terminal.written() - before) as usize;
            let mut read = keys.len();
            keys.resize(end, 0);
            while read < end {
                let n = cli.read_input(&mut keys[read..]).unwrap();
                assert!(n > 0);
                read += n;
            }
            actor.take_terminal(event);
        }
        keys
    }

    async fn actor_readying_tools(folder: &Path, deliveries: DeliveryHandle) -> (Actor, TestCli) {
        let (mut actor, mut cli) = actor_with_cli(folder, deliveries.clone()).await;
        let rule = facade_rules::find("agy").unwrap().unwrap();
        actor.input_rule = Some(&rule.input);
        actor.typist = Typist::new(&actor.id, Some(rule), None, deliveries);
        actor.readiness = Readiness::new(Some(rule), &actor.id);
        actor
            .readiness
            .begin(actor.state.started(), crate::ToolsGiven::Injected, false);
        read_output(&mut actor, &mut cli, agy_composer("", 0).as_bytes()).await;
        (actor, cli)
    }

    fn agy_composer(text: &str, caret: usize) -> String {
        let border = "─".repeat(80);
        format!(
            "\x1b[2J\x1b[HAntigravity CLI 1.4.12\r\n\r\n{border}\r\n> {text}\r\n{border}\r\n? for shortcuts\x1b[4;{}H",
            3 + caret
        )
    }

    async fn write_startup_input(actor: &mut Actor, cli: &mut TestCli, expected: &[u8]) {
        let event = next_input_or_output(actor, TerminalWait::ReadAndWrite).await;
        let TerminalEvent::ToolWriteIssued { wrote, .. } = event else {
            panic!("the terminal issued the startup stroke");
        };
        actor.take_terminal(event);
        if !wrote {
            write_input(actor).await;
            actor.take_terminal(TerminalEvent::Wrote);
        }
        expect_cli_input(cli, expected);
    }

    async fn echo_startup_command(actor: &mut Actor, cli: &mut TestCli) {
        write_startup_input(actor, cli, b"/mcp").await;
        read_output(actor, cli, agy_composer("/mcp", 4).as_bytes()).await;
        if actor.pending_tool_write.is_none() {
            let wake = actor.typist_at.expect("the paste's key interval");
            tokio::time::pause();
            tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
            actor.type_next();
            tokio::time::resume();
        }
        assert!(actor.pending_tool_write.is_some(), "Enter is pending");
    }

    #[tokio::test]
    async fn a_buffered_question_withdraws_pending_startup_strokes() {
        question_with_pending_startup(false).await;
    }

    #[tokio::test]
    async fn an_applied_question_withdraws_pending_startup_strokes() {
        question_with_pending_startup(true).await;
    }

    async fn question_with_pending_startup(already_read: bool) {
        for strokes_written in [1, 0, 2] {
            let home = crate::test_folder::TestFolder::new("actor-startup-question");
            let (messages, _) = messages();
            let (mut actor, mut cli) =
                actor_readying_tools(&home, messages.delivery_handle()).await;
            if strokes_written >= 1 {
                echo_startup_command(&mut actor, &mut cli).await;
            }
            if strokes_written == 2 {
                write_startup_input(&mut actor, &mut cli, b"\r").await;
                actor.feed_own(
                    "\x1b[2J\x1b[HMCP Servers\r\n\r\n> ✓ facade_facade\r\nesc Exit".as_bytes(),
                );
                actor.step_start();
                actor.type_next();
            }
            assert!(actor.pending_tool_write.is_some());
            let report = b"\x1b]7501;state=blocked:kind=question\x07";
            if already_read {
                read_output(&mut actor, &mut cli, report).await;
            } else {
                cli.write_output(report).unwrap();
                actor.terminal.wait_for_queued_output(report.len()).await;
                assert!(actor.terminal.queued_output_bytes().unwrap() >= report.len());
            }

            if actor.pending_tool_write.is_some() {
                let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
                if let TerminalEvent::ToolWriteIssued { wrote, .. } = event {
                    actor.take_terminal(event);
                    if !wrote {
                        write_input(&mut actor).await;
                        actor.take_terminal(TerminalEvent::Wrote);
                    }
                    let sent: &[u8] = match strokes_written {
                        0 => b"/mcp",
                        1 => b"\r",
                        _ => b"\x1b",
                    };
                    expect_cli_input(&mut cli, sent);
                    panic!(
                        "the PTY took {sent:?} over Question, report already read={already_read}"
                    );
                }
                assert!(matches!(event, TerminalEvent::Read));
                actor.take_terminal(event);
            }
            assert_eq!(actor.state.native_wait(), Some(WaitKind::Question));
            assert!(actor.pending_tool_write.is_none());
            actor
                .take_input(Input::Raw(b"x".to_vec()), actor.run)
                .unwrap();
            assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, b"x");
        }
    }

    #[tokio::test]
    async fn a_buffered_title_allows_the_rechecked_startup_enter() {
        let home = crate::test_folder::TestFolder::new("actor-startup-title");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_readying_tools(&home, messages.delivery_handle()).await;
        echo_startup_command(&mut actor, &mut cli).await;
        let title = b"\x1b]0;new title\x07";
        cli.write_output(title).unwrap();
        actor.terminal.wait_for_queued_output(title.len()).await;
        let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
        assert!(matches!(event, TerminalEvent::Read));
        actor.take_terminal(event);
        write_startup_input(&mut actor, &mut cli, b"\r").await;
    }

    #[tokio::test]
    async fn unissued_startup_keys_expire_before_the_pty_can_take_them() {
        for keys_already_written in [1, 0, 2] {
            let home = crate::test_folder::TestFolder::new("actor-startup-unissued-key");
            let (messages, _) = messages();
            let (mut actor, mut cli) =
                actor_readying_tools(&home, messages.delivery_handle()).await;
            if keys_already_written >= 1 {
                echo_startup_command(&mut actor, &mut cli).await;
            }
            if keys_already_written == 2 {
                write_startup_input(&mut actor, &mut cli, b"\r").await;
                actor.feed_own(
                    "\x1b[2J\x1b[HMCP Servers\r\n\r\n> ✓ facade_facade\r\nesc Exit".as_bytes(),
                );
                actor.step_start();
                actor.type_next();
            }
            assert!(
                actor.typist.types_calls(),
                "the next startup write is pending"
            );
            actor
                .take_input(Input::Raw(b"x".to_vec()), actor.run)
                .unwrap();

            let deadline = actor.state.start_bound().unwrap();
            tokio::time::pause();
            tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
            let expired = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
            assert!(matches!(expired, TerminalEvent::ToolWriteExpired));
            actor.take_terminal(expired);
            actor.release_held();
            tokio::time::resume();

            assert_eq!(
                read_queued_probe_input(&mut actor, &mut cli).await,
                b"x",
                "only the person's key goes after the bound, prior startup writes={keys_already_written}"
            );
        }
    }

    #[tokio::test]
    async fn an_enter_still_waiting_for_the_paste_interval_expires_with_startup() {
        let home = crate::test_folder::TestFolder::new("actor-startup-enter-between-keys");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_readying_tools(&home, messages.delivery_handle()).await;
        let deadline = actor.state.start_bound().unwrap();
        let before_deadline = deadline - Duration::from_millis(20);
        tokio::time::pause();
        tokio::time::advance(before_deadline.saturating_duration_since(Instant::now())).await;
        // Keep the virtual clock from automatically advancing while the real PTY writes.
        let (keep_clock, clock) = std::sync::mpsc::channel::<()>();
        let blocked = tokio::task::spawn_blocking(move || {
            let _ = clock.recv_timeout(Duration::from_secs(5));
        });
        write_startup_input(&mut actor, &mut cli, b"/mcp").await;
        drop(keep_clock);
        blocked.await.unwrap();
        actor.feed_own(agy_composer("/mcp", 4).as_bytes());
        actor.step_start();
        actor.type_next();
        assert!(actor.typist.types_calls());
        assert!(
            actor.pending_tool_write.is_none(),
            "Enter waits for the paste interval"
        );
        actor
            .take_input(Input::Raw(b"x".to_vec()), actor.run)
            .unwrap();

        tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
        actor.step_start();
        actor.type_next();
        actor.release_held();
        tokio::time::advance(Duration::from_secs(1)).await;
        actor.type_next();
        assert!(actor.pending_tool_write.is_none(), "Enter was withdrawn");
        tokio::time::resume();

        assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, b"x");
    }

    #[tokio::test]
    async fn an_expired_start_leaves_the_unsent_draft_for_the_person() {
        for (draft, caret) in [("/mcp words", 10), ("/mcp", 2), ("/mcp", 4)] {
            let home = crate::test_folder::TestFolder::new("actor-startup-unproved-erase");
            let (messages, _) = messages();
            let (mut actor, mut cli) =
                actor_readying_tools(&home, messages.delivery_handle()).await;
            write_startup_input(&mut actor, &mut cli, b"/mcp").await;
            actor
                .take_input(Input::Raw(b"x".to_vec()), actor.run)
                .unwrap();

            let deadline = actor.state.start_bound().unwrap();
            tokio::time::pause();
            tokio::time::advance(deadline.saturating_duration_since(Instant::now())).await;
            actor.feed_own(agy_composer(draft, caret).as_bytes());
            actor.step_start();
            actor.type_next();
            actor.release_held();
            tokio::time::resume();

            assert_eq!(
                read_queued_probe_input(&mut actor, &mut cli).await,
                b"x",
                "no erase is authorized at caret {caret} in {draft:?}"
            );
        }
    }

    #[tokio::test]
    async fn the_startup_panel_releases_keys_after_escape_reaches_the_pty_and_its_pause() {
        close_panel_and_release_keys(false, false).await;
    }

    #[tokio::test]
    async fn a_terminal_status_reply_does_not_complete_a_pending_startup_escape() {
        close_panel_and_release_keys(true, false).await;
    }

    #[tokio::test]
    async fn a_late_escape_receipt_does_not_restart_the_elapsed_key_gap() {
        close_panel_and_release_keys(true, true).await;
    }

    #[tokio::test]
    async fn a_probe_cannot_replace_the_late_escape_receipt_before_readiness_observes_it() {
        use crate::agent::ESCAPE_DELAY;

        let home = crate::test_folder::TestFolder::new("actor-close-then-probe");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_readying_tools(&home, messages.delivery_handle()).await;
        echo_startup_command(&mut actor, &mut cli).await;
        write_startup_input(&mut actor, &mut cli, b"\r").await;
        actor.feed_own("\x1b[2J\x1b[HMCP Servers\r\n\r\n> ✓ facade_facade\r\nesc Exit".as_bytes());
        actor.step_start();
        actor.type_next();
        assert!(actor.pending_tool_write.is_some());

        let event = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
        let TerminalEvent::ToolWriteIssued { offset, wrote } = event else {
            panic!("the system took the close key");
        };
        actor.take_terminal(TerminalEvent::ToolWriteIssued {
            offset,
            wrote: false,
        });
        if !wrote {
            write_input(&mut actor).await;
        }
        let reached = actor.terminal.written_at().unwrap();
        expect_cli_input(&mut cli, b"\x1b");

        // The CLI redraws its prompt before the actor receives the close key's write event.
        let prompt = agy_composer("\x1b[31mpossible hint\x1b[0m", 0);
        read_output(&mut actor, &mut cli, prompt.as_bytes()).await;
        assert!(
            actor.read_screen_input().unsure,
            "the new prompt requests a probe"
        );
        assert!(
            actor.typist.types_calls(),
            "the close still awaits its write event"
        );
        assert!(
            !actor.typist.probing(),
            "the probe is waiting behind the close"
        );

        tokio::time::pause();
        let after_gap = reached + ESCAPE_DELAY + Duration::from_millis(1);
        tokio::time::advance(after_gap.saturating_duration_since(Instant::now())).await;
        let before = actor.state.kept();
        actor.take_terminal(TerminalEvent::Wrote);
        assert!(actor.typist.probing(), "the next probe has its own receipt");
        actor.step_start();
        assert!(
            !actor.readiness.readies_tools(),
            "an elapsed Escape gap finishes startup"
        );
        assert_eq!(
            actor.state.kept(),
            before,
            "a successful Escape must not turn into a tool-readiness failure"
        );
    }

    async fn close_panel_and_release_keys(with_query: bool, delay_receipt: bool) {
        use crate::agent::ESCAPE_DELAY;

        let home = crate::test_folder::TestFolder::new("actor-startup-panel-drain");
        let (messages, _) = messages();
        let (mut actor, mut cli) = actor_readying_tools(&home, messages.delivery_handle()).await;
        echo_startup_command(&mut actor, &mut cli).await;
        write_startup_input(&mut actor, &mut cli, b"\r").await;

        let deadline = actor.state.start_bound().unwrap();
        actor.feed_own("\x1b[2J\x1b[HMCP Servers\r\n\r\n> ✓ facade_facade\r\nesc Exit".as_bytes());
        actor.step_start();
        actor.type_next();
        assert!(actor.pending_tool_write.is_some(), "Escape is pending");
        actor
            .take_input(Input::Raw(b"x".to_vec()), actor.run)
            .unwrap();

        if with_query {
            let query = b"\x1b[5n";
            cli.write_output(query).unwrap();
            actor.terminal.wait_for_queued_output(query.len()).await;
            let read = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
            assert!(matches!(read, TerminalEvent::Read));
            actor.take_terminal(read);
            let reply = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
            assert!(matches!(reply, TerminalEvent::Wrote));
            expect_cli_input(&mut cli, b"\x1b[0n");
            actor.take_terminal(reply);
            assert!(actor.pending_tool_write.is_some());
            assert!(
                actor.typist.types_calls(),
                "the status reply cannot complete the pending Escape"
            );
        }

        // Give Escape to the PTY before the bound and delay the actor's write receipt.
        let issued = next_input_or_output(&mut actor, TerminalWait::ReadAndWrite).await;
        let TerminalEvent::ToolWriteIssued { offset, wrote } = issued else {
            panic!("the terminal took the close key before the deadline");
        };
        actor.take_terminal(TerminalEvent::ToolWriteIssued {
            offset,
            wrote: false,
        });
        if !wrote {
            write_input(&mut actor).await;
        }
        let reached = actor.terminal.written_at().unwrap();
        let interval_end = reached + ESCAPE_DELAY;
        tokio::time::pause();
        expect_cli_input(&mut cli, b"\x1b");
        if delay_receipt {
            let after_deadline = deadline + ESCAPE_DELAY * 2;
            tokio::time::advance(after_deadline.saturating_duration_since(Instant::now())).await;
            assert!(Instant::now() >= interval_end);
        }
        actor.step_start();
        actor.release_held();
        assert_eq!(actor.terminal.queued(), 0, "x still waits for the receipt");
        actor.take_terminal(TerminalEvent::Wrote);
        if !delay_receipt && Instant::now() < interval_end {
            let halfway = reached + ESCAPE_DELAY / 2;
            tokio::time::advance(halfway.saturating_duration_since(Instant::now())).await;
            actor.step_start();
            actor.release_held();
            assert_eq!(
                actor.terminal.queued(),
                0,
                "the write's interval is still running"
            );
            tokio::time::advance(interval_end.saturating_duration_since(Instant::now())).await;
        }
        actor.step_start();
        actor.release_held();
        assert_eq!(
            actor.terminal.queued(),
            1,
            "the Escape's interval has elapsed"
        );
        tokio::time::resume();
        write_input(&mut actor).await;
        expect_cli_input(&mut cli, b"x");
    }

    #[tokio::test]
    async fn split_focus_keeps_startup_watching_until_a_persons_key_arrives() {
        let folder = crate::test_folder::TestFolder::new("actor-startup-passive-focus");
        let (messages, _) = messages();
        let (mut actor, _cli) = actor_with_cli(&folder, messages.delivery_handle()).await;
        let rule = facade_rules::find("agy").unwrap().unwrap();
        actor.input_rule = Some(&rule.input);
        actor.readiness = Readiness::new(Some(rule), &actor.id);
        actor.ready_at = actor
            .readiness
            .begin(Instant::now(), crate::ToolsGiven::Injected, false);
        assert!(actor.readiness.waiting_for_input());

        for fragment in [b"\x1b[".as_slice(), b"I"] {
            actor
                .take_input(Input::Raw(fragment.to_vec()), actor.run)
                .unwrap();
            assert!(actor.readiness.waiting_for_input());
        }
        assert!(!actor.typist.probing());
        actor
            .take_input(Input::Raw(b"x".to_vec()), actor.run)
            .unwrap();
        assert!(!actor.readiness.waiting_for_input());
        assert!(actor.held.is_empty());
        assert_eq!(actor.terminal.queued(), 4);
    }

    #[tokio::test]
    async fn a_split_probe_echo_and_title_keep_the_same_erase() {
        let home = crate::test_folder::TestFolder::new("actor-split-probe-echo-with-title");
        let (messages, _) = messages();
        let (mut actor, mut cli) = waiting_for_probe_space(&home, &messages).await;
        let space = plain_claude_frame(" ", "");
        let first = format!("\x1b[?2026h{space}");
        read_output(&mut actor, &mut cli, first.as_bytes()).await;
        read_output(&mut actor, &mut cli, b"\x1b]0;new title\x07").await;
        advance_probe_read(&mut actor).await;
        assert_eq!(actor.terminal.queued(), 0, "the redraw is still open");
        draw_probe_space(&mut actor, &mut cli, "\x1b[?2026l").await;
        assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, 0x7f);
    }

    #[tokio::test]
    async fn a_buffered_menu_revokes_an_automatic_probe_erase_until_the_box_returns() {
        let home = crate::test_folder::TestFolder::new("actor-auto-probe-erase-before-menu");
        let (messages, _) = messages();
        let (mut actor, mut cli) = waiting_for_probe_space(&home, &messages).await;
        draw_probe_space(&mut actor, &mut cli, &plain_claude_frame(" ", "")).await;
        assert_eq!(actor.terminal.queued(), 1);

        let menu = synchronized(&claude_trust_frame(false));
        cli.write_output(menu.as_bytes()).unwrap();
        actor.terminal.wait_for_queued_output(menu.len()).await;
        assert!(
            read_queued_probe_input(&mut actor, &mut cli)
                .await
                .is_empty()
        );
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );
        assert!(actor.typist.probing());

        let space = synchronized(&format!("\x1b[?25h{}", plain_claude_frame(" ", "")));
        draw_probe_space(&mut actor, &mut cli, &space).await;
        assert_eq!(read_queued_probe_input(&mut actor, &mut cli).await, b"\x7f");
    }

    #[tokio::test]
    async fn a_revoked_probe_erase_finishes_when_the_box_returns_empty() {
        let menu = synchronized(&claude_trust_frame(false));
        let empty = synchronized(&format!("\x1b[?25h{}", plain_claude_frame("", "")));

        for split in [true, false] {
            let home = crate::test_folder::TestFolder::new("actor-revoked-probe-erase-empty");
            let (messages, _) = messages();
            let (mut actor, mut cli) = waiting_for_probe_space(&home, &messages).await;
            draw_probe_space(&mut actor, &mut cli, &plain_claude_frame(" ", "")).await;
            assert_eq!(actor.terminal.queued(), 1);

            cli.write_output(menu.as_bytes()).unwrap();
            if split {
                actor.terminal.wait_for_queued_output(menu.len()).await;
                assert!(
                    read_queued_probe_input(&mut actor, &mut cli)
                        .await
                        .is_empty()
                );
                assert_eq!(
                    actor.read_screen_input().info.state,
                    InputState::Interaction
                );
                assert!(actor.typist.probing());
                read_output(&mut actor, &mut cli, empty.as_bytes()).await;
            } else {
                cli.write_output(empty.as_bytes()).unwrap();
                actor
                    .terminal
                    .wait_for_queued_output(menu.len() + empty.len())
                    .await;
                assert!(
                    read_queued_probe_input(&mut actor, &mut cli)
                        .await
                        .is_empty()
                );
            }
            assert_eq!(actor.read_screen_input().info.state, InputState::Usable);
            assert_eq!(actor.terminal.queued(), 0);
            tokio::time::pause();
            // The immediate recheck and two timed readings all fit before the echo deadline.
            let restored_by = Instant::now() + Duration::from_millis(350);
            for _ in 0..4 {
                if !actor.typist.probing() {
                    break;
                }
                let wake = actor
                    .typist_at
                    .expect("the probe schedules another reading");
                assert!(wake <= restored_by, "the restored box can settle now");
                tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
                actor.type_next();
                assert_eq!(actor.terminal.queued(), 0, "there is no space to erase");
            }
            tokio::time::resume();
            assert!(
                !actor.typist.probing(),
                "the restored input settles the probe"
            );

            let settled = queue_a_message(
                &mut actor,
                &messages,
                Instant::now() + Duration::from_secs(20),
            );
            actor.type_next();
            let paste = b"\x1b[200~a message \x1b[201~";
            assert_eq!(pending_delivery_bytes(&actor), paste.len(), "split={split}");
            issue_delivery(&mut actor).await;
            expect_cli_input(&mut cli, paste);
            assert!(settled.borrow().is_none());
        }
    }

    #[tokio::test]
    async fn quiesce_acknowledges_a_revoked_probe_erase_without_writing_it() {
        let home = crate::test_folder::TestFolder::new("actor-quiesce-probe-erase");
        let (messages, _) = messages();
        let (mut actor, mut cli) = waiting_for_probe_space(&home, &messages).await;
        draw_probe_space(&mut actor, &mut cli, &plain_claude_frame(" ", "")).await;
        assert_eq!(actor.terminal.queued(), 1);
        let (reply, mut drained) = oneshot::channel();
        assert!(actor.take_command(AgentCommand::Quiesce { reply }).await);
        assert_eq!(drained.try_recv(), Err(oneshot::error::TryRecvError::Empty));

        assert!(
            read_queued_probe_input(&mut actor, &mut cli)
                .await
                .is_empty()
        );
        assert_eq!(actor.terminal.queued(), 0);
        assert_eq!(drained.try_recv(), Ok(()));
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
        assert_eq!(pending_delivery_bytes(&actor), 0);

        tokio::time::pause();
        let now = Instant::now();
        let classify_by = actor.person.partial_until(now).unwrap();
        tokio::time::advance(classify_by - now).await;
        actor.type_next();
        assert_eq!(
            pending_delivery_bytes(&actor),
            0,
            "the screen still shows a draft"
        );
        tokio::time::resume();
        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Usable);

        let expected = b"\x1b[200~a message \x1b[201~";
        assert_eq!(
            pending_delivery_bytes(&actor),
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
    async fn waiting_for_probe_echoes_keeps_a_waiting_messages_deadline() {
        for issued in [false, true] {
            let home = crate::test_folder::TestFolder::new("actor-probe-and-message-deadline");
            let (messages, _) = messages();
            let (mut actor, mut cli) = actor_with_cli(&home, messages.delivery_handle()).await;
            actor.feed_own(plain_claude_frame("", "\x1b[32mTry this\x1b[0m").as_bytes());
            actor.typist.want_probe();
            actor.type_next();
            if issued {
                assert_eq!(read_one_probe_key(&mut actor, &mut cli).await, b' ');
            }
            let pending = usize::from(!issued);

            tokio::time::pause();
            actor
                .take_input(Input::Raw(b"\x1b[".to_vec()), actor.run)
                .unwrap();
            draw_input(&mut actor, "the person's text");
            assert_eq!(actor.read_screen_input().info.state, InputState::Draft);
            let now = Instant::now();
            let deadline = now + Duration::from_millis(1500);
            assert_eq!(actor.held.len(), 1);
            assert!(actor.person.partial_until(now).is_none());
            let settled = queue_a_message(&mut actor, &messages, deadline);
            actor.type_next();
            assert_eq!(actor.terminal.queued(), pending);
            assert!(settled.borrow().is_none());

            assert!(
                actor.typist_at.is_some_and(|at| at <= deadline),
                "issued={issued}"
            );
            tokio::time::advance(deadline - now).await;
            actor.type_next();
            assert!(
                matches!(
                    settled.borrow().as_ref(),
                    Some(Settled::Withdrawn(message)) if message.delivery.reason == Some(DeliveryFailure::InputDraft)
                ),
                "the receipt is due at the message's deadline, issued={issued}"
            );
            assert!(actor.typist.probing());
            assert_eq!(actor.terminal.queued(), pending);
            tokio::time::resume();
        }
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
        // A complete repaint after the key's write provides the menu-side evidence.
        read_output(&mut actor, &mut cli, menu.as_bytes()).await;
        assert_eq!(
            actor.read_screen_input().info.state,
            InputState::Interaction
        );

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
        let draft = format!("\x1b[?25h{}", plain_claude_frame("a message", ""));
        read_output(&mut actor, &mut cli, draft.as_bytes()).await;
        assert_eq!(actor.read_screen_input().info.state, InputState::Draft);
        actor.type_next();
        (actor, settled)
    }

    #[tokio::test]
    async fn a_menu_redrawn_after_escape_cannot_hide_a_composer_edit() {
        let home = crate::test_folder::TestFolder::new("actor-escape-before-menu");
        let (actor, settled) = escape_around_a_menu(&home, false).await;
        assert_eq!(
            pending_delivery_bytes(&actor),
            0,
            "the earlier Escape touched the draft"
        );
        let result = settled.borrow();
        let Some(Settled::Kept(message)) = result.as_ref() else {
            panic!("the deadline settles delivery: {result:?}");
        };
        assert_eq!(
            message.delivery.reason,
            Some(DeliveryFailure::InteractionAfterWrite)
        );
    }

    #[tokio::test]
    async fn an_escape_into_a_visible_menu_keeps_the_paste_under_care() {
        let home = crate::test_folder::TestFolder::new("actor-menu-before-escape");
        let (actor, _) = escape_around_a_menu(&home, true).await;
        assert_eq!(
            pending_delivery_bytes(&actor),
            "a message ".len(),
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
            let draft = format!("\x1b[?25h{}", plain_claude_frame("a message", ""));
            read_output(&mut actor, &mut cli, draft.as_bytes()).await;
        }
        assert_eq!(actor.read_screen_input().info.state, InputState::Draft);
        actor.type_next();
        (actor, settled)
    }

    #[tokio::test]
    async fn a_fragmented_focus_report_leaves_an_expired_own_draft_erasable() {
        let home = crate::test_folder::TestFolder::new("actor-focus-and-expired-draft");
        let (actor, _) = draft_after_split_focus(&home, false, b"[I").await;
        assert_eq!(pending_delivery_bytes(&actor), "a message ".len());
    }

    #[tokio::test]
    async fn a_split_focus_report_with_a_menu_between_its_bytes_keeps_cleanup() {
        let home = crate::test_folder::TestFolder::new("actor-focus-across-menu");
        let (actor, _) = draft_after_split_focus(&home, true, b"[I").await;
        assert_eq!(pending_delivery_bytes(&actor), "a message ".len());
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
        assert_eq!(pending_delivery_bytes(&actor), "a message ".len());
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

    #[tokio::test(start_paused = true)]
    async fn a_lone_escape_voids_the_person_s_enter_without_more_keys() {
        // The PTY still runs on the real clock. Hold Tokio's clock until the fixture advances it.
        let (keep_clock, clock) = std::sync::mpsc::channel::<()>();
        let blocked = tokio::task::spawn_blocking(move || {
            let _ = clock.recv_timeout(Duration::from_secs(5));
        });
        let home = crate::test_folder::TestFolder::new("actor-enter-lone-escape");
        let (mut actor, mut cli, settled) = waiting_for_the_person_s_enter(&home).await;
        write_input(&mut actor).await;
        draw_input(&mut actor, "a message");
        actor.take_keys(Instant::now(), vec![0x1b], false);
        write_input(&mut actor).await;
        actor.take_terminal(TerminalEvent::Wrote);
        read_output(&mut actor, &mut cli, plain_claude_frame("", "").as_bytes()).await;
        assert!(
            settled.borrow().is_none(),
            "Escape could have cleared the draft"
        );
        let wake = actor.enter_wake().expect("the Escape must be classified");
        tokio::time::advance(wake.saturating_duration_since(Instant::now())).await;
        actor.type_next();
        assert!(actor.enter_wake().is_some_and(|at| at <= Instant::now()));
        actor.follow_enter();
        assert!(actor.submitting.is_empty());
        actor.type_next();
        assert!(settled.borrow().is_none());
        drop(keep_clock);
        blocked.await.unwrap();
    }
}
