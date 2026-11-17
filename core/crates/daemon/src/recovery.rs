//! Startup recovery: before any client is served, every agent the store keeps comes back, and the
//! messages the daemon before this one left pending are taken up again.
//!
//! An agent's record meets the keeper's run of the same ID, if the keeper holds one:
//!
//! | Record | Keeper's run | The agent comes back |
//! |---|---|---|
//! | Readable, with exit | Its recorded process | Ended with the saved exit; the run is released once its output drains |
//! | Readable, with exit | Another process | As a resume the daemon before did not commit: its process is committed first |
//! | Readable, no exit | Held | Running, its terminal taken back and its screen recovered |
//! | Readable, no exit | None | Ended as `terminal_closed`; the recorded process ID is never signalled |
//! | None | Held | Not at all: the run is stopped |
//! | Unreadable | Held | Not listed; its terminal is held and its files stay |
//!
//! At most 16 agents recover at once. A running agent whose CLI reports its session reads it once
//! and commits a changed one before serving, then keeps following it.
//!
//! A pending message keeps what is left of its deadline, never more than a whole delivery's time,
//! and `messages::decide` says what becomes of it. For each running agent, the paste its typist was
//! in goes first, then its other messages in the order they were sent; each agent's typist is fed
//! in a task of its own, so serving does not wait for room in any agent's input.
//!
//! Runs takes back each terminal the keeper holds (`take_back`), registers the recovered runs
//! (`register_recovered`) and stops or holds the ones no readable record owns
//! (`take_keeper_only`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use facade_base::daemon::{
    AgentInfo, AgentState, DeliveryFailure, Message, TextWritten, ToolsState, typed_text,
};
use facade_base::keeper::HeldAgent;
use facade_base::process::{EndReason, ProcessExit, ProcessState};
use facade_base::terminal::PtyMaster;
use tokio::sync::{Semaphore, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::agent::{
    self, ActorStart, AgentHandle, Input, MessageTyping, ScreenStart, StateStart, Submission,
};
use crate::lifecycle::Work;
use crate::messages::{self, Outcome, OwedResult, Recipient, Settled, TakeUp};
use crate::operations::exit_sink;
use crate::store::{AgentRecord, KeptMessage};
use crate::{Daemon, Sender, blocking_in_place};

/// How many agents recover at once: bounds the keeper's requests and the memory screen replays
/// take.
const MAX_RECOVERIES_IN_FLIGHT: usize = 16;

fn log(level: &str, message: &str) {
    facade_base::log::write("daemon", level, message);
}

/// How far recovery has come, counted in steps.
pub(crate) struct RecoveryProgress {
    steps: Arc<AtomicU64>,
}

impl RecoveryProgress {
    pub(crate) fn start() -> RecoveryProgress {
        RecoveryProgress {
            steps: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) fn advance(&self) {
        self.steps.fetch_add(1, Ordering::Relaxed);
    }
}

/// What is left to do for a recovered agent once it is listed.
enum Then {
    Nothing,
    /// Its exit was found now: save it.
    SaveExit(ProcessExit),
    /// Its saved exit stands: release its run once its output is drained.
    ReleaseWhenSettled,
}

/// One agent back from recovery, not listed yet.
struct Recovered {
    handle: AgentHandle,
    then: Then,
    follows_session: bool,
}

/// A message delivered again, with the receiver of its settlement.
type Delivering = (Message, watch::Receiver<Option<Settled>>);

/// A paste a typist was in before the restart: every message that went in it as it was pasted,
/// those still pending, and the earliest of their deadlines.
struct BegunPaste {
    typings: Vec<MessageTyping>,
    pending: Vec<Delivering>,
    deadline: Instant,
}

/// What one running agent's typist is given at a restart.
#[derive(Default)]
struct TypistWork {
    /// Pastes begun before the restart, by number: the earliest deadline and the pending messages.
    pastes: BTreeMap<u64, (Instant, Vec<Delivering>)>,
    /// Messages to deliver, in the order they were sent, with their deadlines.
    messages: Vec<(Instant, Delivering)>,
}

impl Daemon {
    /// Recovers and lists every readable agent. Registers every run the keeper holds, those of
    /// unreadable records too, and stops the rest; deletes screen and run folders without records.
    /// Fails where a terminal cannot be taken back from the keeper.
    pub(crate) async fn recover(
        self: &Arc<Self>,
        held: Vec<HeldAgent>,
        records: Vec<AgentRecord>,
        agent_ids: &HashSet<String>,
        progress: &RecoveryProgress,
    ) -> anyhow::Result<()> {
        let mut held: HashMap<String, HeldAgent> =
            held.into_iter().map(|run| (run.id.clone(), run)).collect();
        let slots = Arc::new(Semaphore::new(MAX_RECOVERIES_IN_FLIGHT));
        let mut recoveries = JoinSet::new();
        for record in records {
            let run = held.remove(&record.agent_id);
            let (daemon, slots, steps) = (self.clone(), slots.clone(), progress.steps.clone());
            recoveries.spawn(async move {
                let _slot = slots.acquire_owned().await?;
                daemon.recover_agent(record, run, steps).await
            });
        }
        // What is left has no readable record: unreadable ones are held, the rest stopped.
        for (id, run) in held {
            let unreadable = self.records.is_unreadable(&id);
            self.runs
                .take_keeper_only(
                    run,
                    if unreadable {
                        crate::runs::KeeperOnly::Unreadable
                    } else {
                        crate::runs::KeeperOnly::NoRecord
                    },
                )
                .await
                .map_err(|error| {
                    anyhow::anyhow!("could not take back a run from the keeper: {error}")
                })?;
            progress.advance();
        }
        // Unreadable records count as records here: their folders stay.
        blocking_in_place(|| {
            self.screens.delete_without_records(agent_ids);
            self.runs.delete_folders_without_records(agent_ids);
        });
        let mut recovered = Vec::new();
        while let Some(agent) = recoveries.join_next().await {
            recovered.push(agent??);
        }
        self.list_recovered(recovered);
        Ok(())
    }

    /// Lists the recovered agents at once, then starts what each still needs.
    fn list_recovered(self: &Arc<Self>, recovered: Vec<Recovered>) {
        {
            let mut agents = self.agents.lock().unwrap();
            for agent in &recovered {
                agents.insert(agent.handle.id().to_owned(), agent.handle.clone());
            }
        }
        for Recovered {
            handle,
            then,
            follows_session,
        } in recovered
        {
            let id = handle.id().to_owned();
            if follows_session {
                // Recovery read the session file before serving: the next read follows output.
                let committed = handle.info().session;
                self.runs.follow_session(
                    &id,
                    agent::FIRST_RUN,
                    committed,
                    handle.output_seen(),
                    crate::runs::FirstRead::AfterOutput,
                );
            }
            match then {
                Then::Nothing => {}
                Then::SaveExit(exit) => self.settle_exit(id, exit, handle),
                Then::ReleaseWhenSettled => {
                    let (daemon, work) = (self.clone(), self.lifecycle.begin(Work::ExitCommit));
                    tokio::spawn(async move {
                        let _work = work;
                        let mut settled = handle.settled();
                        let _ = settled.wait_for(|settled| *settled).await;
                        daemon.runs.release(&id);
                    });
                }
            }
        }
    }

    /// Brings one agent back: commits a resume the daemon before left uncommitted, takes back its
    /// terminal, recovers its screen, registers its run, catches up on its session and starts its
    /// actor.
    async fn recover_agent(
        self: Arc<Self>,
        mut record: AgentRecord,
        run: Option<HeldAgent>,
        steps: Arc<AtomicU64>,
    ) -> anyhow::Result<Recovered> {
        let id = record.agent_id.clone();
        if let Some(run) = &run
            && record.exit.is_some()
            && run.pid != record.pid
        {
            self.commit_uncommitted_resume(&mut record, run)?;
        }
        let master = match &run {
            Some(run) => Some(self.runs.take_back(run).await.map_err(|error| {
                anyhow::anyhow!("could not take back the terminal of {id} from the keeper: {error}")
            })?),
            None => None,
        };
        let terminal = master.as_ref().and_then(PtyMaster::size);
        let (screen, cols, rows) = self
            .recover_screen(&id, run.is_some(), terminal, &steps)
            .await?;
        let (process, exit, then) = ended_or_running(&id, record.exit.as_ref(), run.is_some());
        let (tx, rx) = mpsc::channel(agent::MAX_QUEUED_COMMANDS);
        if let (Some(run), Some(master)) = (&run, &master) {
            let cwd = Path::new(&record.cwd);
            self.runs.register_recovered(
                run,
                master,
                exit.clone(),
                agent::FIRST_RUN,
                record.rule.as_deref(),
                cwd,
                exit_sink(tx.clone()),
            )?;
        }
        let follows_session = process == ProcessState::Running && self.runs.captures(&id);
        if follows_session {
            self.catch_up_on_session(&mut record).await;
        }
        let info = AgentInfo {
            agent_id: id.clone(),
            location_id: facade_base::daemon::location_id(&record.cwd),
            pid: Some(run.as_ref().map_or(record.pid, |run| run.pid)),
            process,
            cols: Some(cols),
            rows: Some(rows),
            exit,
            // The actor reads the state from the facts kept beside the screen, and the screen.
            state: AgentState::Unknown,
            state_detail: None,
            said: None,
            tools_state: ToolsState::NotInjected,
            tools_reason: None,
            guest: false,
            name: record.name,
            cli: record.cli,
            cwd: record.cwd,
            window_id: record.window_id,
            created_at: record.created_at,
            creator: record.creator,
            root: record.root,
            yolo: record.yolo,
            session: record.session,
        };
        let state = self.kept_state(&id, &info, run.as_ref()).await?;
        let actor = ActorStart {
            info,
            master,
            screen,
            rule: record.rule,
            captures: follows_session,
            deliveries: self.messages.delivery_handle(),
            state,
        };
        let handle = agent::spawn(actor, rx, tx, self.changes.clone())?;
        steps.fetch_add(1, Ordering::Relaxed);
        Ok(Recovered {
            handle,
            then,
            follows_session,
        })
    }

    /// A resume the daemon before started and never committed: the keeper's run is the agent's
    /// now. Commits its process; the record's window and YOLO stand, as the resume's were not kept.
    fn commit_uncommitted_resume(
        &self,
        record: &mut AgentRecord,
        run: &HeldAgent,
    ) -> anyhow::Result<()> {
        let id = &record.agent_id;
        blocking_in_place(|| {
            self.store
                .record_restart(id, run.pid, &record.window_id, record.yolo)
        })?;
        log(
            "info",
            &format!("committed the resumed run of {id}, process {}", run.pid),
        );
        record.pid = run.pid;
        record.exit = None;
        Ok(())
    }

    /// The agent's screen and its size. A held run's screen is replayed from its log; an ended
    /// agent's stays in its files until something reads, shows or resumes it, so only its size is
    /// read now.
    async fn recover_screen(
        &self,
        id: &str,
        held: bool,
        terminal: Option<(u16, u16)>,
        steps: &Arc<AtomicU64>,
    ) -> anyhow::Result<(ScreenStart, u16, u16)> {
        let folder = self.screens.folder(id);
        if !held {
            let (cols, rows) =
                tokio::task::spawn_blocking(move || agent::saved_size(&folder)).await?;
            return Ok((ScreenStart::Released, cols, rows));
        }
        // After a clean handover the log is whole, and output goes on in it.
        let handed_over_cleanly = crate::takeover::handed_over_cleanly();
        let (agent_id, steps) = (id.to_owned(), steps.clone());
        let recovered = tokio::task::spawn_blocking(move || {
            let step = || {
                steps.fetch_add(1, Ordering::Relaxed);
            };
            if handed_over_cleanly {
                agent::recover_after_clean_end(&folder, &agent_id, terminal, &step)
            } else {
                agent::recover(&folder, &agent_id, terminal, &step)
            }
        })
        .await?;
        facade_base::service::mark_for_test(&format!("screen-replayed-{id}"));
        let (cols, rows) = (recovered.screen.cols(), recovered.screen.rows());
        let screen = ScreenStart::Recovered {
            screen: Box::new(recovered.screen),
            log: recovered.log,
            handed_over_cleanly,
        };
        Ok((screen, cols, rows))
    }

    /// While no daemon read it, a running CLI may have reported a new session: read it once and
    /// commit a changed one. A failed commit is tried again on the follower's next read.
    async fn catch_up_on_session(&self, record: &mut AgentRecord) {
        let Some(reported) = self.runs.read_session(&record.agent_id).await else {
            return;
        };
        if reported == record.session {
            return;
        }
        let id = &record.agent_id;
        match blocking_in_place(|| self.store.record_session(id, reported.as_deref())) {
            Ok(()) => record.session = reported,
            Err(error) => log("warn", &format!("{error:#}; trying again on the next read")),
        }
    }

    /// What the daemon before kept of the agent's state, read before serving. A run with a stop
    /// pending was stopped by Facade.
    async fn kept_state(
        &self,
        id: &str,
        info: &AgentInfo,
        run: Option<&HeldAgent>,
    ) -> anyhow::Result<StateStart> {
        let file = agent::state_file(&self.screens.folder(id));
        let mut kept = tokio::task::spawn_blocking({
            let file = file.clone();
            move || agent::read_kept(&file)
        })
        .await?;
        kept.stopped |= run.is_some_and(|run| run.stopping);
        let started = run
            .and_then(|_| facade_base::time::parse_iso_time(&info.created_at))
            .map_or_else(Instant::now, agent::instant_of);
        Ok(StateStart {
            file,
            kept,
            started,
        })
    }

    /// Takes up the messages the daemon before left pending, before clients are served (see the
    /// module's comment). A typist settles one paste before it begins the next, so an agent has at
    /// most one begun paste; more, which only a settlement the store could not write leaves, all
    /// fail as unconfirmed.
    pub(crate) fn take_up_messages(self: &Arc<Self>) -> anyhow::Result<()> {
        // Deadlines are fixed now: time waiting for room in an input never lengthens a later one.
        let (now, started) = (SystemTime::now(), Instant::now());
        let mut typists: BTreeMap<String, TypistWork> = BTreeMap::new();
        for kept in self.messages.pending()? {
            self.take_up(kept, now, started, &mut typists);
        }
        for (id, work) in typists {
            let agent = self.get_agent(&id).expect("a running recipient");
            let begun = self.begun_paste(&id, work.pastes)?;
            tokio::spawn(self.clone().feed_typist(agent, begun, work.messages));
        }
        Ok(())
    }

    /// Takes up one pending message: settles it, leaves it waiting, or gives it to its typist.
    fn take_up(
        self: &Arc<Self>,
        KeptMessage {
            message,
            paste,
            result_owed,
        }: KeptMessage,
        now: SystemTime,
        started: Instant,
        typists: &mut BTreeMap<String, TypistWork>,
    ) {
        let recipient = self.get_agent(&message.to);
        // A guest's messages wait for its next turn, with no deadline.
        if recipient.as_ref().is_some_and(AgentHandle::is_guest) {
            return;
        }
        let whereabouts = match &recipient {
            None => Recipient::NotListed,
            Some(agent) if agent.exit().borrow().is_some() => Recipient::Ended,
            Some(_) => Recipient::Running,
        };
        let decided = messages::decide(&message, paste, whereabouts, now);
        // A start's prompt still owes its result, which describes its agent as the prompt settles.
        let owes = result_owed
            .zip(recipient)
            .map(|(number, agent)| OwedResult {
                number,
                agent: Arc::new(move || agent.info()),
            });
        let number = messages::number(&message);
        let settled = self
            .messages
            .take_up(message.clone(), paste.is_some(), owes);
        if message.delivery.deadline.is_none() && !matches!(decided, TakeUp::Settle(_)) {
            // A prompt whose delivery had not begun begins it now; a later restart keeps the rest.
            let deadline = facade_base::time::iso_time(now + messages::delivery_limit());
            self.messages.begin_prompt(number, &deadline, None);
        }
        let to = message.to.clone();
        match decided {
            TakeUp::Settle(outcome) => self.messages.settle(&[number], outcome),
            TakeUp::Wait(left) => self.await_settlement((message, settled), started + left),
            TakeUp::Type(left) => typists
                .entry(to)
                .or_default()
                .messages
                .push((started + left, (message, settled))),
            TakeUp::FinishPaste { paste, left } => {
                let deadline = started + left;
                let (earliest, pending) = typists
                    .entry(to)
                    .or_default()
                    .pastes
                    .entry(paste)
                    .or_insert((deadline, Vec::new()));
                *earliest = (*earliest).min(deadline);
                pending.push((message, settled));
            }
        }
    }

    /// The one paste `id`'s typist is to finish, rebuilt as it was pasted. Logs that its CLI may
    /// still be inside a paste; fails them all as unconfirmed where there is more than one.
    fn begun_paste(
        &self,
        id: &str,
        pastes: BTreeMap<u64, (Instant, Vec<Delivering>)>,
    ) -> anyhow::Result<Option<BegunPaste>> {
        if pastes.is_empty() {
            return Ok(None);
        }
        let pending = || {
            pastes
                .values()
                .flat_map(|(_, pending)| pending.iter().map(|(m, _)| m))
        };
        let ids: Vec<String> = pending()
            .map(|message| format!("#{}", message.message_id))
            .collect();
        log(
            "warn",
            &format!(
                "#{id}'s CLI may still be inside a paste: the daemon before this one ended while \
                 pasting {} into it",
                ids.join(", ")
            ),
        );
        if pastes.len() > 1 {
            let numbers: Vec<u64> = pending().map(messages::number).collect();
            self.messages.settle(&numbers, Outcome::UNCONFIRMED);
            return Ok(None);
        }
        let (paste, (deadline, pending)) = pastes.into_iter().next().expect("one paste");
        let typings = self
            .messages
            .paste_messages(paste)?
            .iter()
            .map(|message| {
                let said = Submission {
                    text: message.text.clone(),
                    sender: Sender {
                        from: message.from.clone(),
                        from_name: message.from_name.clone(),
                    },
                };
                MessageTyping::new(
                    typed_text(message),
                    messages::number(message),
                    deadline,
                    said,
                )
            })
            .collect();
        Ok(Some(BegunPaste {
            typings,
            pending,
            deadline,
        }))
    }

    /// Feeds `agent`'s typist what the restart took up for it: the begun paste, then its messages.
    /// Each waits for room in the agent's input until its deadline, as a sent message does.
    async fn feed_typist(
        self: Arc<Self>,
        agent: AgentHandle,
        begun: Option<BegunPaste>,
        messages: Vec<(Instant, Delivering)>,
    ) {
        if let Some(begun) = begun {
            self.finish_paste(&agent, begun).await;
        }
        for (deadline, (message, settled)) in messages {
            if self.hand_to_typist(&agent, &message, deadline).await {
                self.await_settlement((message, settled), deadline);
            }
        }
    }

    /// Gives `agent`'s typist the begun paste to finish; its pending messages settle by its
    /// deadline.
    async fn finish_paste(self: &Arc<Self>, agent: &AgentHandle, begun: BegunPaste) {
        let BegunPaste {
            typings,
            pending,
            deadline,
        } = begun;
        let numbers: Vec<u64> = pending
            .iter()
            .map(|(message, _)| messages::number(message))
            .collect();
        let handed = tokio::time::timeout_at(
            deadline,
            self.hand_input(
                agent,
                Input::BegunPaste(typings),
                crate::delivery::InputWait::Always,
            ),
        )
        .await;
        match handed {
            Ok(Ok(())) => {
                for delivering in pending {
                    self.await_settlement(delivering, deadline);
                }
            }
            Ok(Err(_ended)) => {
                let ended = Outcome::Failed {
                    reason: DeliveryFailure::Ended,
                    text_written: TextWritten::Unknown,
                    enter_written: None,
                };
                self.messages.settle(&numbers, ended);
            }
            Err(_late) => self.messages.settle(&numbers, Outcome::UNCONFIRMED),
        }
    }

    /// Settles a message taken up at the restart, in a task of its own, where nothing else settles
    /// it by `deadline` and the graces. Nobody waits for its response.
    fn await_settlement(self: &Arc<Self>, (message, mut settled): Delivering, deadline: Instant) {
        let (daemon, number) = (self.clone(), messages::number(&message));
        tokio::spawn(async move {
            daemon
                .messages
                .settle_by_deadline(number, &mut settled, deadline)
                .await;
        });
    }
}

/// Whether a recovered agent is running or ended, its exit, and what is left once it is listed. A
/// saved exit wins over a held run, even one the keeper reports running.
fn ended_or_running(
    id: &str,
    saved: Option<&ProcessExit>,
    held: bool,
) -> (ProcessState, Option<ProcessExit>, Then) {
    match (saved, held) {
        (Some(exit), true) => (
            ProcessState::Ended,
            Some(exit.clone()),
            Then::ReleaseWhenSettled,
        ),
        (Some(exit), false) => (ProcessState::Ended, Some(exit.clone()), Then::Nothing),
        (None, true) => (ProcessState::Running, None, Then::Nothing),
        (None, false) => {
            log(
                "warn",
                &format!(
                    "no keeper or daemon held {id}'s terminal, so it closed; listing it as ended"
                ),
            );
            let exit = ProcessExit {
                code: None,
                signal: None,
                reason: Some(EndReason::TerminalClosed),
                at: facade_base::time::iso_now(),
            };
            (
                ProcessState::Ended,
                Some(exit.clone()),
                Then::SaveExit(exit),
            )
        }
    }
}
