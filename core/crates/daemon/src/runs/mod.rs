//! The runs: each CLI run Facade starts, from its start or resume until it ends and its exit is
//! saved.
//!
//! Two parts do the work, and this file joins them:
//!
//! - the keeper link talks to the keeper, which parents the CLIs; it keeps every run's terminal
//!   and its first exit until the daemon has saved that exit;
//! - the preparation composes a run's command line and environment, writes its run folder and
//!   Facade's plugin, and follows the session the CLI reports.
//!
//! The daemon hears of exits and sessions through [`RunEvent`]; an agent's actor hears of its
//! run's exit through the [`ExitSink`] given at launch.
//!
//! Locks: the run registry's before the pending starts' (both in the keeper link). Every other lock
//! here is a leaf, and this file never holds one while it calls either part.

mod keeper_link;
mod preparation;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::api_v1::{
    ApiVersion, Size,
    daemon::KeeperInfo,
    keeper::{HeldAgent, StartArgs},
};
use facade_base::instructions::{self, ManagedRun};
use facade_base::model::error::ErrorBody;
use facade_base::process::{ProcessExit, ProcessIdentity};
use facade_base::programs::Held;
use facade_base::start::StartCommand;
use facade_base::terminal::PtyMaster;
use facade_rules::Rule;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::ToolsGiven;
use keeper_link::{KeeperLink, RecordedExit};
use preparation::Preparation;

pub(crate) use keeper_link::{KeeperOnly, StartReservation};
pub(crate) use preparation::{FirstRead, PluginHold, RunFiles};

/// Where a run's exit goes: set up by the daemon at launch, it hands the exit to the agent's actor.
/// Called with no lock held.
pub(crate) type ExitSink = Arc<dyn Fn(RunExit) + Send + Sync>;

/// A run's exit as its agent's actor takes it.
pub(crate) struct RunExit {
    /// The agent's number for the run that ended.
    pub(crate) run: u64,
    pub(crate) exit: ProcessExit,
    /// Facade stopped the run.
    pub(crate) stopped: bool,
}

/// What the runs tell the daemon.
pub(crate) enum RunEvent {
    /// The keeper reported a run's exit.
    Exited { id: String, exit: ProcessExit },
    /// Run `run` of agent `id` reported another session. The daemon commits it first, then tells
    /// the agent, and says in `committed` whether the commit held; one that failed is tried again
    /// on the next read.
    Session {
        id: String,
        run: u64,
        session: Option<String>,
        committed: oneshot::Sender<bool>,
    },
}

/// What a run needs to be prepared: the CLI's rule and settings, where it starts, and who starts
/// it.
pub(crate) struct RunRequest<'a> {
    pub(crate) id: &'a str,
    /// The CLI's rule; without one the command runs as it is.
    pub(crate) rule: Option<&'static Rule>,
    /// The entry's words after the program.
    pub(crate) words: &'a [String],
    /// The entry's own program, run in place of its rule's.
    pub(crate) program: Option<&'a str>,
    /// The program a start without a rule runs where the entry names none.
    pub(crate) plain_program: &'a str,
    /// The environment the settings give the CLI; Facade's variables go on top.
    pub(crate) inherited: BTreeMap<String, String>,
    pub(crate) cwd: &'a str,
    /// The agent's location ID, which its instructions name.
    pub(crate) location_id: &'a str,
    /// The label and logical ID when the agent belongs to exactly one window.
    pub(crate) window: Option<(&'a str, &'a str)>,
    /// The agent that starts it, by ID and name.
    pub(crate) creator: Option<(&'a str, Option<&'a str>)>,
    pub(crate) yolo: bool,
    /// The session the command line continues: a resume's, or a start's that continues one. None
    /// for a start of a new session.
    pub(crate) session: Option<&'a str>,
    /// Whether this is the agent's first run or a resume of it.
    pub(crate) kind: RunKind,
}

/// A run ready for the keeper.
pub(crate) struct PreparedRun {
    /// The keeper's command line, including arguments private to this run.
    launch: StartCommand<String>,
    /// The running platform's display command with injected credentials removed.
    pub(crate) launch_command: Option<String>,
    pub(crate) env: BTreeMap<String, String>,
    /// The CLI reports its session to its run folder.
    pub(crate) captures: bool,
    /// The CLI's version, as its installation names it.
    pub(crate) version: Option<String>,
    pub(crate) tools: ToolsGiven,
    /// Facade's plugin in the folder the CLI starts in, held until the agent is listed.
    pub(crate) plugin: Option<PluginHold>,
    /// The run's folder and what goes in it.
    pub(crate) files: RunFiles,
    pub(crate) rule: Option<&'static Rule>,
    /// The request's kind: whether the run is the agent's first or a resume.
    pub(crate) kind: RunKind,
    credential_digest: Option<[u8; 32]>,
}

impl PreparedRun {
    /// The agent is listed as running: lets go of the plugin hold, as the run now counts as a user
    /// of the plugin.
    pub(crate) fn let_go_of_plugin(&mut self) {
        drop(self.plugin.take());
    }
}

/// Whether a run is the agent's first run or a resume of it. A start that continues a session is
/// still the agent's first run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunKind {
    Start,
    /// The run's exit waits to be saved until the daemon has committed the run
    /// ([`Runs::installed`]).
    Resume,
}

/// A run the keeper started.
pub(crate) struct StartedRun {
    pub(crate) pid: u32,
    pub(crate) process: ProcessIdentity,
    /// The terminal's master side; the runs keep a copy.
    pub(crate) master: PtyMaster,
    pub(crate) credential: Option<RunCredentialRecord>,
}

/// The verifier saved with a run, tied to the process reported by the keeper.
pub(crate) struct RunCredentialRecord {
    pub(crate) digest: [u8; 32],
    pub(crate) process: ProcessIdentity,
}

/// The installed run named by a private relay credential.
pub(crate) struct RunIdentity {
    pub(crate) agent_id: String,
    pub(crate) pid: u32,
    pub(crate) run: u64,
}

/// What became of an exit the keeper reported.
pub(crate) struct ExitRecorded {
    /// A run of that agent was registered or starting.
    pub(crate) known: bool,
    /// The exit is the agent's to save now, if the agent is listed.
    pub(crate) committed: bool,
}

/// The keeper found at daemon startup.
pub(crate) enum FoundKeeper {
    Absent,
    /// A keeper accepted this daemon: its build and the runs it holds.
    Connected {
        build: String,
        held: Vec<HeldAgent>,
    },
}

/// The runs and the keeper behind them.
pub(crate) struct Runs {
    link: Arc<KeeperLink>,
    preparation: Preparation,
    /// Each run's task that saves its exit, which a resume waits for.
    exit_tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl Runs {
    /// The runs of the Facade home whose core folder is `core`. Events go to `events`.
    pub(crate) fn new(
        core: &Path,
        held: Arc<Held>,
        events: mpsc::UnboundedSender<RunEvent>,
    ) -> Runs {
        Runs {
            link: KeeperLink::new(core.to_path_buf(), events.clone()),
            preparation: Preparation::new(core.join("runs"), held, events),
            exit_tasks: Mutex::default(),
        }
    }

    /// Finds the keeper that started this daemon, waiting up to 10 seconds for it to accept.
    pub(crate) async fn find_keeper_at_startup(&self) -> anyhow::Result<FoundKeeper> {
        self.link.find_at_startup().await
    }

    /// Keeps the keeper link for the daemon's life, in a task of its own: hands the startup
    /// keeper every terminal it lacks first.
    pub(crate) fn serve_keeper(&self) {
        self.link.serve();
    }

    /// Counts a start from now until its run is registered or it fails; the keeper link counts as
    /// busy meanwhile.
    pub(crate) fn reserve_start(&self) -> StartReservation {
        self.link.reserve_start()
    }

    /// Prepares a managed launch with instructions for its caller and its private relay.
    pub(crate) async fn prepare_managed(
        &self,
        request: RunRequest<'_>,
        address: &str,
        context: &ManagedRun<'_>,
    ) -> Result<PreparedRun, ErrorBody> {
        self.preparation
            .prepare(request, Some(instructions::for_managed(address, context)))
            .await
    }

    /// For a resume: removes the agent's earlier run folders, then creates this run's. Blocking.
    pub(crate) fn replace_folders(
        &self,
        id: &str,
        prepared: &PreparedRun,
    ) -> Result<(), ErrorBody> {
        self.preparation.replace_folders(id, prepared)
    }

    /// Has the keeper start run `number` of agent `id` and registers it before returning. An exit
    /// reported meanwhile goes to `exits`. A start that fails takes its run folder with it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn start(
        &self,
        reservation: StartReservation,
        id: &str,
        number: u64,
        prepared: &PreparedRun,
        cols: u16,
        rows: u16,
        exits: ExitSink,
    ) -> Result<StartedRun, ErrorBody> {
        let (command, cwd) = prepared.launch.clone().into_words();
        let args = StartArgs {
            agent_id: id.to_string(),
            command,
            env: prepared.env.clone(),
            cwd,
            size: Size {
                cols: cols.max(2),
                rows: rows.max(1),
            },
        };
        let launched = self
            .link
            .send_start(
                reservation,
                id,
                number,
                args,
                exits,
                prepared.kind,
                prepared.credential_digest,
            )
            .await;
        match &launched {
            Ok(_) => {
                let rule = prepared.rule.map(|rule| rule.cli.as_str());
                self.preparation
                    .plugin_used(id, rule, Path::new(&prepared.launch.folder));
            }
            Err(_) if prepared.kind == RunKind::Start => self.preparation.remove_folders(id),
            Err(_) => {}
        }
        launched
    }

    /// Confirms the specific generation after its record and terminal are installed.
    pub(crate) fn installed_run(&self, id: &str, number: u64) -> Option<ProcessExit> {
        self.link.installed(id, Some(number))
    }

    /// Verifies a relay credential, waiting for its run to be installed if it is starting.
    /// Call on a blocking worker with no daemon lock held.
    pub(crate) fn verify_credential(
        &self,
        credential: &str,
    ) -> Result<Option<RunIdentity>, ErrorBody> {
        tokio::runtime::Handle::current().block_on(self.link.verify_credential(credential))
    }

    /// Asks the keeper to stop agent `id`'s run, waiting up to 10 seconds for a ready keeper.
    /// Returns whether it was still running.
    pub(crate) async fn stop(&self, id: &str) -> Result<bool, ErrorBody> {
        self.link.stop(id).await
    }

    /// Records a run's first exit and hands it to the run's [`ExitSink`] once no lock is held.
    /// Called with the agents locked.
    pub(crate) fn record_exit(&self, id: &str, exit: ProcessExit) -> ExitRecorded {
        let recorded = self.link.record_exit(id, exit);
        self.preparation.run_ended(id);
        match recorded {
            RecordedExit::Unknown => ExitRecorded {
                known: false,
                committed: true,
            },
            RecordedExit::Repeated => ExitRecorded {
                known: true,
                committed: false,
            },
            RecordedExit::Kept(recorded) => recorded,
            RecordedExit::Dropped => {
                self.preparation.plugin_released(id);
                ExitRecorded {
                    known: true,
                    committed: false,
                }
            }
        }
    }

    /// Keeps the task saving agent `id`'s exit, which a resume waits for.
    pub(crate) fn keep_exit_task(&self, id: &str, task: JoinHandle<()>) {
        self.exit_tasks.lock().unwrap().insert(id.to_string(), task);
    }

    /// Waits up to `timeout` for agent `id`'s ended run to be done with: its exit saved, its
    /// session read a last time, and the run let go of. Returns false where it is not yet.
    pub(crate) async fn previous_run_ended(&self, id: &str, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        let task = self.exit_tasks.lock().unwrap().remove(id);
        if let Some(mut task) = task {
            if !task.is_finished() {
                facade_base::service::mark_for_test("waiting-for-previous-run");
            }
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                self.exit_tasks.lock().unwrap().insert(id.to_string(), task);
                return false;
            }
        }
        if !self.preparation.session_followed(id, deadline).await {
            return false;
        }
        let released = self.link.ended_run_released(id, deadline).await;
        if released {
            self.preparation.plugin_released(id);
        }
        released
    }

    /// Lets go of agent `id`'s run once its exit is saved and its output drained, and of Facade's
    /// plugin where it was the last run to use it.
    pub(crate) fn release(&self, id: &str) {
        if self.link.release(id) {
            self.preparation.plugin_released(id);
        }
    }

    /// Stops a run whose agent could not be listed or committed; it goes with its exit.
    pub(crate) fn abandon(&self, id: &str) {
        self.link.abandon(id);
    }

    /// Agent `id` was removed: its run is let go of now if it ended, else when it ends.
    pub(crate) fn remove(&self, id: &str) {
        if self.link.remove(id) {
            self.preparation.plugin_released(id);
        }
    }

    /// Waits until agent `id`'s session is no longer followed.
    pub(crate) async fn end_session_following(&self, id: &str) {
        self.preparation.end_session_following(id).await;
    }

    /// Follows run `run` of agent `id`'s session file until the run ends; `committed` is the
    /// session the store holds.
    pub(crate) fn follow_session(
        &self,
        id: &str,
        run: u64,
        committed: Option<String>,
        output: tokio::sync::watch::Receiver<()>,
        first: FirstRead,
    ) {
        self.preparation
            .follow_session(id, run, committed, output, first);
    }

    /// Reads agent `id`'s session file once: the session it reports, or None where it reports
    /// none.
    pub(crate) async fn read_session(&self, id: &str) -> Option<Option<String>> {
        self.preparation.read_session(id).await
    }

    /// Finds the current run's session report path. Blocking.
    pub(crate) fn session_report_path(&self, id: &str) -> Option<PathBuf> {
        self.preparation.session_report_path(id)
    }

    /// Whether the CLI reported a session whose saved file is not there yet.
    pub(crate) async fn has_unsaved_session(&self, id: &str) -> bool {
        self.preparation.has_unsaved_session(id).await
    }

    /// Whether agent `id`'s CLI reports its session to its run folder.
    pub(crate) fn captures(&self, id: &str) -> bool {
        self.preparation.captures(id)
    }

    /// Deletes agent `id`'s run folders.
    pub(crate) fn remove_folders(&self, id: &str) {
        self.preparation.remove_folders(id);
    }

    /// The environment agent `id`'s running CLI started with. `Ok(None)` where it is not running;
    /// an error where the system will not say. Blocking.
    pub(crate) fn environment_of(
        &self,
        id: &str,
    ) -> std::io::Result<Option<BTreeMap<String, String>>> {
        match self.link.running_process(id) {
            Some(process) => facade_base::unix_process::environment(&process),
            None => Ok(None),
        }
    }

    /// Why the runs keep the daemon from exiting, if they do.
    pub(crate) fn busy(&self) -> Option<String> {
        self.link.busy()
    }

    /// The keeper's process ID and build.
    pub(crate) fn keeper_info(&self) -> Option<KeeperInfo> {
        self.link.keeper_info()
    }

    /// The selected API version of the last keeper to reconcile with this daemon.
    pub(crate) fn keeper_api_version(&self) -> Option<ApiVersion> {
        self.link.keeper_api_version()
    }

    /// Recovery: takes back from the startup keeper the terminal of a run it holds.
    pub(crate) async fn take_back(&self, held: &HeldAgent) -> Result<PtyMaster, ErrorBody> {
        self.link.take_back(held).await
    }

    /// Recovery: registers a run taken back for a readable agent record, under run `number`, with
    /// `exit` where the record has one.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn register_recovered(
        &self,
        held: &HeldAgent,
        master: &PtyMaster,
        exit: Option<ProcessExit>,
        number: u64,
        rule: Option<&str>,
        cwd: &Path,
        exits: ExitSink,
    ) -> std::io::Result<()> {
        let running = exit.is_none();
        self.link
            .register_recovered(held, master, exit, number, exits)?;
        if running {
            self.preparation.plugin_used(&held.agent_id, rule, cwd);
        }
        Ok(())
    }

    /// Restores the saved verifier only for the active run recovered from this keeper entry.
    pub(crate) fn restore_credential(
        &self,
        held: &HeldAgent,
        number: u64,
        credential: RunCredentialRecord,
    ) -> bool {
        self.link.restore_credential(held, number, credential)
    }

    /// Recovery: a run only the keeper holds is held as it is where its record cannot be read, and
    /// stopped where it has none.
    pub(crate) async fn take_keeper_only(
        &self,
        held: HeldAgent,
        record: KeeperOnly,
    ) -> Result<(), ErrorBody> {
        self.link.take_keeper_only(held, record).await
    }

    /// Recovery: deletes the run folders of agents not in `kept`. Blocking.
    pub(crate) fn delete_folders_without_records(&self, kept: &HashSet<String>) {
        self.preparation.delete_folders_without_records(kept);
    }

    /// After recovery: lets go of Facade's plugin in each folder no run uses any more. `agents` is
    /// each agent's rule and folder.
    pub(crate) fn let_go_of_unused_plugins(&self, agents: Vec<(String, PathBuf)>) {
        self.preparation.let_go_of_unused_plugins(agents);
    }
}

fn credential_digest(credential: &str) -> [u8; 32] {
    Sha256::digest(credential.as_bytes()).into()
}
