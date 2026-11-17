//! The agent operations that join several parts of the daemon: start, resume, stop, remove,
//! rename, a run's exit, and the environment an agent's CLI started with. Each keeps the order the
//! parts are called in (docs/core/ARCHITECTURE.md): the number before the process, the process before
//! the record, the record before the actor and the list, and the transaction before the list
//! changes.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use facade_base::daemon::{
    AgentInfo, AgentState, AgentsChange, Message, ResumeArgs, StartArgs, StartResult, StopResult,
    TERMINAL_WINDOW, ToolsState,
};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::process::{ProcessExit, ProcessState};
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent::{self, ActorStart, AgentCommand, AgentHandle, Kept, ScreenStart, StateStart};
use crate::command_line::{self, Configured};
use crate::lifecycle::Work;
use crate::messages::OwedResult;
use crate::records::{self, Named, Reach};
use crate::runs::{ExitSink, FirstRead, RunExit, RunKind, RunRequest};
use crate::store::AgentRecord;
use crate::{Daemon, HUMAN, Sender, blocking, gate_for_test, log, pause_for_test};

/// The exit wait once the keeper took `agent.stop`, its 3 seconds before SIGKILL included.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a resume waits for the ended run's exit to be saved and its session read.
const PREVIOUS_RUN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request ID answers again.
const REQUEST_HOUR: Duration = Duration::from_secs(60 * 60);

/// A start's creator, none for the person, and its request ID.
pub(crate) type StartKey = (Option<String>, String);
/// A start's answer, once it has one.
pub(crate) type StartAnswer = Option<Result<StartResult, ErrorBody>>;

/// A start under way with a request ID: the calls that repeat it meanwhile get its answer. It
/// lets go of its key once it answers, or ends without one; the record keeps the ID from then on.
struct StartUnderWay {
    daemon: Arc<Daemon>,
    key: StartKey,
    answer: watch::Sender<StartAnswer>,
}

impl StartUnderWay {
    fn answer(&self, answer: Result<StartResult, ErrorBody>) {
        self.daemon.starting.lock().unwrap().remove(&self.key);
        self.answer.send_replace(Some(answer));
    }
}

impl Drop for StartUnderWay {
    fn drop(&mut self) {
        self.daemon.starting.lock().unwrap().remove(&self.key);
    }
}

/// Where an early exit of a run goes: the actor's mailbox, made before the actor, so that an exit
/// that comes first waits there for it.
pub(crate) fn exit_sink(mailbox: mpsc::Sender<AgentCommand>) -> ExitSink {
    Arc::new(move |RunExit { run, exit, stopped }| {
        let mailbox = mailbox.clone();
        tokio::spawn(async move {
            let _ = mailbox
                .send(AgentCommand::ProcessExited { run, exit, stopped })
                .await;
        });
    })
}

/// How a log line names a call's request ID, where it has one.
pub(crate) fn request_words(request_id: Option<&str>) -> String {
    request_id
        .map(|id| format!(", request {id}"))
        .unwrap_or_default()
}

/// Refuses a request ID that is not 1 to 200 characters.
pub(crate) fn check_request_id(request_id: &str) -> Result<(), ErrorBody> {
    let count = request_id.chars().count();
    if (1..=200).contains(&count) {
        return Ok(());
    }
    Err(ErrorBody::invalid_argument(format!(
        "request_id must be 1 to 200 characters, not {count}"
    )))
}

/// The time an hour before now, as request IDs look back to.
pub(crate) fn an_hour_ago() -> String {
    facade_base::time::iso_time(
        SystemTime::now()
            .checked_sub(REQUEST_HOUR)
            .unwrap_or(SystemTime::UNIX_EPOCH),
    )
}

/// The error of an agent whose actor stopped.
pub(crate) fn agent_stopped(id: &str) -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        format!("agent #{id} is unavailable: its actor stopped"),
    )
}

impl Daemon {
    /// The listed agents, in number order.
    pub(crate) fn agents(&self) -> Vec<AgentHandle> {
        let mut agents: Vec<AgentHandle> = self.agents.lock().unwrap().values().cloned().collect();
        agents.sort_by_key(|agent| records::agent_number(agent.id()));
        agents
    }

    /// The listed agents' records, in number order.
    pub(crate) fn agent_infos(&self) -> Vec<AgentInfo> {
        self.agents().iter().map(AgentHandle::info).collect()
    }

    /// The agent with ID `id`, if it is listed.
    pub(crate) fn get_agent(&self, id: &str) -> Option<AgentHandle> {
        self.agents.lock().unwrap().get(id).cloned()
    }

    /// Tells the `agents` topic that `info` is an agent's record now.
    pub(crate) fn publish(&self, info: AgentInfo) {
        let _ = self.changes.send(AgentsChange::Updated {
            agent: Box::new(info),
        });
    }

    /// The reach of a client acting for `caller`, or for the person.
    pub(crate) fn reach_of(&self, caller: Option<&str>) -> Reach {
        let info = caller
            .and_then(|id| self.get_agent(id))
            .map(|agent| agent.info());
        records::reach_of(caller, info.as_ref())
    }

    /// What `reference` names among the agents in `reach` (RULES-2.3).
    pub(crate) fn resolve_named(
        &self,
        reference: &str,
        reach: &Reach,
        running_only: bool,
    ) -> Result<Option<AgentHandle>, ErrorBody> {
        match records::resolve(&self.agent_infos(), reference, reach, running_only)? {
            Named::Person => Ok(None),
            Named::Agent(id) => self.get_agent(&id).map(Some).ok_or_else(|| {
                ErrorBody::new(
                    Reason::NotFound,
                    format!("no agent {reference}; nothing was done"),
                )
            }),
        }
    }

    /// The agent `reference` names among the agents in `reach`; the person is no agent.
    pub(crate) fn resolve_agent(
        &self,
        reference: &str,
        reach: &Reach,
    ) -> Result<AgentHandle, ErrorBody> {
        self.resolve_named(reference, reach, false)?.ok_or_else(|| {
            ErrorBody::invalid_argument(format!("{} is the person, not an agent", reference.trim()))
        })
    }

    /// Reserves a default name for agent `id` in window `window` until it is listed: the names of
    /// the window's agents are taken under the list's lock, before records' own.
    pub(crate) fn reserve_name(&self, window: &str, id: &str, names: Option<&[String]>) -> String {
        let agents = self.agents.lock().unwrap();
        let taken: Vec<String> = agents
            .values()
            .map(AgentHandle::info)
            .filter(|info| info.window_id == window)
            .map(|info| info.name)
            .collect();
        self.records.reserve_name(taken, id, names)
    }

    /// Starts a CLI as [`facade_base::daemon::AgentStart`] says. A start with its creator's own
    /// request ID looks for it first: a start with that ID under way, whose answer it waits for,
    /// or an agent the same creator started with it within the hour, which it answers as it stands
    /// now, starting nothing. A start that failed keeps no ID.
    pub(crate) async fn start(
        self: &Arc<Self>,
        args: StartArgs,
        sender: Sender,
        by_model: bool,
    ) -> Result<StartResult, ErrorBody> {
        let Some(request_id) = args.request_id.clone() else {
            return self.start_once(args, sender, by_model).await;
        };
        check_request_id(&request_id)?;
        let creator = (sender.from != HUMAN).then(|| sender.from.clone());
        let key: StartKey = (creator, request_id.clone());
        let under_way = {
            let mut starting = self.starting.lock().unwrap();
            if let Some(answer) = starting.get(&key) {
                Err(answer.clone())
            } else if let Some(answer) = self.started_before(key.0.as_deref(), &key.1)? {
                log(
                    "info",
                    &format!(
                        "#{}'s start request {request_id} answers #{} again, as it stands",
                        sender.from, answer.agent.agent_id
                    ),
                );
                return Ok(answer);
            } else {
                let (answer, answered) = watch::channel(None);
                starting.insert(key.clone(), answered);
                Ok(StartUnderWay {
                    daemon: self.clone(),
                    key,
                    answer,
                })
            }
        };
        let mut answered = match under_way {
            Ok(held) => {
                let answer = self.start_once(args, sender, by_model).await;
                held.answer(answer.clone());
                return answer;
            }
            Err(answered) => answered,
        };
        let answer = match answered.wait_for(Option::is_some).await {
            Ok(answer) => answer.clone().expect("an answered start"),
            Err(_) => Err(ErrorBody::new(
                Reason::Internal,
                "the start this call repeats ended without an answer; start it again",
            )),
        };
        if let Ok(answer) = &answer {
            log(
                "info",
                &format!(
                    "#{}'s start request {request_id} answers #{} again, as it started",
                    sender.from, answer.agent.agent_id
                ),
            );
        }
        answer.map(|answer| StartResult {
            repeated: true,
            ..answer
        })
    }

    /// The agent `creator` (none for the person) started with `request_id` within the hour, as a
    /// repeat answers it: as it stands now, with its prompt as it stands, and the result an
    /// agent's start is owed.
    fn started_before(
        &self,
        creator: Option<&str>,
        request_id: &str,
    ) -> Result<Option<StartResult>, ErrorBody> {
        let since = an_hour_ago();
        let found = crate::blocking_in_place(|| self.store.find_start(creator, request_id, &since))
            .map_err(ErrorBody::internal)?;
        let Some((agent, prompt)) =
            found.and_then(|(id, prompt)| Some((self.get_agent(&id)?, prompt)))
        else {
            return Ok(None);
        };
        // The result an agent's start is owed took the number right after its prompt's.
        let result_message_id = prompt
            .filter(|_| creator.is_some())
            .map(|number| format!("m{}", number + 1));
        Ok(Some(StartResult {
            agent: agent.info(),
            prompt: prompt.and_then(|number| self.messages.message(&format!("m{number}"))),
            result_message_id,
            repeated: true,
        }))
    }

    /// One start: its CLI's entry, model, effort and prompt checked first, then its worktree made
    /// where it asks for one, then its CLI started there (CLIS-4.2). A start that fails after making
    /// its worktree says that the worktree stays.
    async fn start_once(
        self: &Arc<Self>,
        mut args: StartArgs,
        sender: Sender,
        by_model: bool,
    ) -> Result<StartResult, ErrorBody> {
        gate_for_test("before-start-run");
        // One reading of the settings file gives the start its YOLO, names and entry (RULES-4.3).
        let settings = command_line::read_settings()?;
        let configured = command_line::configure(&settings, &args, by_model)?;
        if let Some(session) = args.session.as_deref() {
            command_line::check_session(&configured, &args.command[0], session)?;
        }
        if let Some(prompt) = args.prompt.as_deref() {
            command_line::check_start_prompt(prompt, &configured, &args.command[0])?;
            let widest = crate::delivery::pending_message(
                sender.clone(),
                "a999999999",
                prompt.to_owned(),
                None,
                None,
            );
            crate::delivery::check_fits(
                configured.rule,
                "the new agent",
                &widest,
                "start it with a shorter prompt and send the rest as messages",
            )?;
        }
        let Some(worktree) = args.worktree.take() else {
            return self.start_in(args, sender, &settings, configured).await;
        };
        let branch = worktree.branch.clone();
        let made = self
            .create_worktree(facade_base::daemon::WorktreeCreateArgs {
                window_id: args
                    .window_id
                    .clone()
                    .unwrap_or_else(|| TERMINAL_WINDOW.to_string()),
                cwd: args.cwd.clone(),
                worktree,
            })
            .await?;
        args.cwd = made.path.clone();
        self.start_in(args, sender, &settings, configured)
            .await
            .map_err(|mut error| {
                error.message.push_str(&format!(
                    "; the worktree {} on branch {branch} was created and stays",
                    made.path
                ));
                error.data.kept = Some(facade_base::daemon::Kept {
                    branch: Some(branch),
                    path: Some(made.path),
                });
                error
            })
    }

    /// Starts the CLI `configured` in `args.cwd`, in the order a start keeps (docs/core/ARCHITECTURE.md).
    async fn start_in(
        self: &Arc<Self>,
        mut args: StartArgs,
        sender: Sender,
        settings: &facade_base::settings::Settings,
        mut configured: Configured,
    ) -> Result<StartResult, ErrorBody> {
        let Some(_starting) = self.lifecycle.begin(Work::Start) else {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                "Facade is exiting; start the agent again",
            ));
        };
        let window = args
            .window_id
            .take()
            .unwrap_or_else(|| TERMINAL_WINDOW.to_string());
        let destination = self.windows.check_destination(&window, &args.cwd)?;
        args.cwd = destination.cwd;
        let location = destination.location_id;
        configured.find_program(&args.cwd)?;
        let yolo = settings.yolo;
        let rule = configured.rule;
        let reservation = self.runs.reserve_start();
        let id = self.records.next_id().await?;
        let (creator, root) = self.tree_of(&sender, &id);
        let given = args
            .name
            .as_deref()
            .map(|name| name.trim_matches(facade_base::settings::is_space))
            .filter(|name| !name.is_empty());
        let name = match given {
            Some(name) => name.to_string(),
            None => self.reserve_name(&window, &id, settings.names.as_deref()),
        };
        if let Err(error) = reservation.wait_for_keeper().await {
            self.records.release_name(&name);
            return Err(error);
        }
        let creator_name = sender.from_name.as_deref();
        let label = self.windows.label(&window);
        let request = RunRequest {
            id: &id,
            rule,
            words: &configured.words,
            program: configured.program.as_deref(),
            plain_program: &args.command[0],
            inherited: configured.env.clone(),
            cwd: &args.cwd,
            location_id: &location,
            window_id: &window,
            window_label: &label,
            creator: creator.as_deref().map(|creator| (creator, creator_name)),
            yolo,
            session: args.session.as_deref(),
            kind: RunKind::Start,
        };
        let mut prepared = match self.runs.prepare(request).await {
            Ok(prepared) => prepared,
            Err(error) => {
                self.records.release_name(&name);
                return Err(error);
            }
        };
        let (tx, rx) = mpsc::channel(agent::MAX_QUEUED_COMMANDS);
        let started = self
            .runs
            .start(
                reservation,
                &id,
                agent::FIRST_RUN,
                &prepared,
                args.cols,
                args.rows,
                exit_sink(tx.clone()),
            )
            .await;
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                self.records.release_name(&name);
                return Err(error);
            }
        };
        pause_for_test("after-run-start");
        let info = AgentInfo {
            agent_id: id.clone(),
            name: name.clone(),
            cli: configured.cli.clone(),
            location_id: location,
            cwd: args.cwd.clone(),
            window_id: window.clone(),
            pid: Some(started.pid),
            process: ProcessState::Running,
            cols: Some(args.cols),
            rows: Some(args.rows),
            created_at: facade_base::time::iso_now(),
            creator: creator.clone(),
            root: root.clone(),
            yolo,
            exit: None,
            session: None,
            state: AgentState::Starting,
            state_detail: None,
            said: None,
            tools_state: ToolsState::NotInjected,
            tools_reason: None,
            guest: false,
        };
        let record = AgentRecord {
            agent_id: id.clone(),
            name: name.clone(),
            cli: info.cli.clone(),
            cwd: info.cwd.clone(),
            pid: started.pid,
            created_at: info.created_at.clone(),
            exit: None,
            rule: rule.map(|rule| rule.cli.clone()),
            session: None,
            window_id: window.clone(),
            creator,
            root,
            yolo,
            request_id: args.request_id.clone(),
            prompt: None,
            location_id: Some(info.location_id.clone()),
        };
        // The prompt is committed with the record, so that a start answered with it never loses
        // it; its delivery time begins once the CLI's tools connected or will not.
        let store = self.store.clone();
        let kept = match args.prompt.clone() {
            None => blocking(move || store.insert(&record).map(|()| None)).await,
            Some(text) => {
                let message = Message {
                    call_id: args.call_id.clone(),
                    ..crate::delivery::pending_message(sender.clone(), &id, text, None, None)
                };
                let owes = sender.from != HUMAN;
                blocking(move || store.insert_with_prompt(&record, &message, owes).map(Some)).await
            }
        };
        let kept = match kept {
            Ok(kept) => kept,
            Err(error) => {
                self.records.release_name(&name);
                self.runs.remove_folders(&id);
                self.runs.abandon(&id);
                return Err(error);
            }
        };
        gate_for_test("after-start-record");
        let screen = self.screens.folder(&id);
        let actor = ActorStart {
            colors: self.window_colors(&window),
            info: info.clone(),
            master: Some(started.master),
            screen: ScreenStart::New(screen.clone()),
            rule: rule.map(|rule| rule.cli.clone()),
            captures: prepared.captures,
            deliveries: self.messages.delivery_handle(),
            state: StateStart {
                file: agent::state_file(&screen),
                kept: Kept::new_run(prepared.version.clone(), prepared.tools),
                started: tokio::time::Instant::now(),
            },
        };
        let handle = match agent::spawn(actor, rx, tx, self.changes.clone()) {
            Ok(handle) => handle,
            Err(err) => {
                self.records.release_name(&name);
                self.runs.remove_folders(&id);
                let (store, removed) = (self.store.clone(), id.clone());
                let _ = blocking(move || store.delete(&removed)).await;
                self.runs.abandon(&id);
                return Err(ErrorBody::internal(format!(
                    "could not read agent {id}'s terminal: {err}"
                )));
            }
        };
        // A prompt holds the run's messages from before the agent is listed, so that none goes
        // ahead of it.
        let prompt = match kept {
            Some((prompt, owed)) => {
                let owes = owed.map(|number| {
                    let agent = handle.clone();
                    OwedResult {
                        number,
                        agent: Arc::new(move || agent.info()),
                    }
                });
                let settled = self.messages.deliver_prompt(prompt.clone(), owes);
                let (ready, started) = oneshot::channel();
                handle.send(AgentCommand::AwaitPrompt { ready }).await;
                Some((prompt, owed, settled, started))
            }
            None => None,
        };
        let early_exit = {
            let mut agents = self.agents.lock().unwrap();
            agents.insert(id.clone(), handle.clone());
            self.records.release_name(&name);
            self.publish(info.clone());
            self.runs.installed(&id)
        };
        // Listed now: the plugin's hold goes, and the session is followed.
        prepared.let_go_of_plugin();
        if self.runs.captures(&id) {
            self.runs.follow_session(
                &id,
                agent::FIRST_RUN,
                None,
                handle.output_seen(),
                FirstRead::Now,
            );
        }
        let (prompt, result_message_id) = match prompt {
            Some((prompt, owed, settled, started)) => {
                tokio::spawn(self.clone().send_start_prompt(
                    handle.clone(),
                    prompt.clone(),
                    settled,
                    started,
                ));
                (Some(prompt), owed.map(|number| format!("m{number}")))
            }
            None => (None, None),
        };
        // An exit that came before the agent was listed is saved now.
        if let Some(exit) = early_exit {
            self.settle_exit(id.clone(), exit, handle);
        }
        let call = args
            .call_id
            .as_deref()
            .map(|call| format!(", call {call}"))
            .unwrap_or_default();
        log(
            "info",
            &format!(
                "#{} started #{}{call}{}",
                sender.from,
                info.agent_id,
                request_words(args.request_id.as_deref())
            ),
        );
        Ok(StartResult {
            agent: info,
            prompt,
            result_message_id,
            repeated: false,
        })
    }

    /// Where new agent `id` that `sender` starts goes in the creation trees (RULES-2.2): an
    /// agent's start joins its creator's tree, and the person's starts a tree of its own. A creator
    /// no longer listed counts as its own tree's first.
    fn tree_of(&self, sender: &Sender, id: &str) -> (Option<String>, String) {
        if sender.from == HUMAN {
            return (None, id.to_string());
        }
        let root = self
            .get_agent(&sender.from)
            .map_or_else(|| sender.from.clone(), |creator| creator.info().root);
        (Some(sender.from.clone()), root)
    }

    /// The environment agent `id`'s CLI started with, less what its rule added, for a start its
    /// Facade server asks for. A guest's is the one its hooks or server gave.
    pub(crate) async fn environment_of(
        &self,
        id: &str,
    ) -> Result<BTreeMap<String, String>, ErrorBody> {
        let unreadable = |why: String| {
            ErrorBody::new(
                Reason::Unavailable,
                format!("#{id}'s environment is unavailable: {why}; nothing was started"),
            )
        };
        let agent = self.get_agent(id).ok_or_else(|| {
            ErrorBody::new(
                Reason::NotFound,
                format!("#{id}, the agent this start acts for, is not listed"),
            )
        })?;
        if agent.is_guest() {
            return self.guests.environment(id).ok_or_else(|| {
                unreadable("its CLI has not given it yet: its session-start hook gives it".into())
            });
        }
        if agent.exit().borrow().is_some() {
            return Err(unreadable("its CLI is not running".into()));
        }
        let read = crate::blocking_in_place(|| self.runs.environment_of(id))
            .map_err(|err| unreadable(err.to_string()))?;
        let rule = agent
            .rule()
            .and_then(|name| facade_rules::find(name).ok().flatten());
        command_line::creator_environment(read, rule).map_err(|why| unreadable(why.into()))
    }

    /// Stops a running agent and returns its exit (`agent.stop`), once a resume of it finished.
    pub(crate) async fn stop(
        self: &Arc<Self>,
        agent: &AgentHandle,
    ) -> Result<StopResult, ErrorBody> {
        let _changing = agent.lock_run_change().await;
        gate_for_test("before-stop-run");
        self.stop_run(agent).await
    }

    /// Stops `agent`'s run while the caller holds its run change: only the keeper signals a CLI.
    /// Waits up to 10 seconds for its exit. A run that ended before is left as it was.
    async fn stop_run(&self, agent: &AgentHandle) -> Result<StopResult, ErrorBody> {
        let id = agent.id().to_string();
        let mut exit = agent.exit();
        if let Some(exit) = exit.borrow().clone() {
            return Ok(StopResult {
                exit,
                already_ended: true,
            });
        }
        if agent.is_closed() {
            return Err(ErrorBody::internal(format!(
                "agent #{id} cannot be stopped: its actor stopped; nothing was sent"
            )));
        }
        let _stopping = self.lifecycle.begin(Work::Stop);
        // The console hangs up only once every copy of its signal pipe is closed: the actor's
        // first, then keeper_link's, then the keeper's.
        let (reply, let_go) = oneshot::channel();
        if !agent.send(AgentCommand::LetGoBeforeStop { reply }).await || let_go.await.is_err() {
            return Err(agent_stopped(&id));
        }
        let running = self.runs.stop(&id).await?;
        match tokio::time::timeout(STOP_TIMEOUT, exit.wait_for(Option::is_some)).await {
            Ok(Ok(exit)) => Ok(StopResult {
                exit: exit.clone().expect("a recorded exit"),
                already_ended: !running,
            }),
            Ok(Err(_)) => Err(agent_stopped(&id)),
            Err(_) => Err(ErrorBody::new(
                Reason::Unavailable,
                format!(
                    "agent #{id} did not end within the {}-second stop wait",
                    STOP_TIMEOUT.as_secs()
                ),
            )),
        }
    }

    /// Records the first exit the keeper reported for run `id`: runs hands it to the actor at once,
    /// and a listed agent's exit is saved. A start or resume that has not committed its run saves
    /// the exit itself once it does.
    pub(crate) fn record_exit(self: &Arc<Self>, id: &str, exit: ProcessExit) {
        let listed = {
            let agents = self.agents.lock().unwrap();
            let recorded = self.runs.record_exit(id, exit.clone());
            if !recorded.known {
                log(
                    "warn",
                    &format!("an exit was reported for unknown agent {id}"),
                );
            }
            recorded
                .committed
                .then(|| agents.get(id).cloned())
                .flatten()
        };
        if let Some(agent) = listed {
            self.settle_exit(id.to_string(), exit, agent);
        }
    }

    /// Saves the exit of `agent`'s run, retrying until the store takes it, then lets go of the run
    /// once viewers had it. A resume waits for this.
    pub(crate) fn settle_exit(self: &Arc<Self>, id: String, exit: ProcessExit, agent: AgentHandle) {
        let daemon = self.clone();
        let saving = self.lifecycle.begin(Work::ExitCommit);
        let writer = id.clone();
        let task = tokio::spawn(async move {
            pause_for_test("before-exit-commit");
            let mut delay = Duration::from_millis(500);
            loop {
                let (store, saved, exited) = (daemon.store.clone(), id.clone(), exit.clone());
                match blocking(move || store.record_exit(&saved, &exited)).await {
                    Ok(()) => break,
                    Err(error) => {
                        daemon.idle_delay.delayed(&format!(
                            "could not save the exit of {id}: {}",
                            error.message
                        ));
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                }
            }
            daemon.idle_delay.cleared();
            let mut settled = agent.settled();
            let _ = settled.wait_for(|settled| *settled).await;
            daemon.runs.release(&id);
            drop(saving);
        });
        self.runs.keep_exit_task(&writer, task);
    }

    /// Removes an agent: stops it first, then deletes its record with its inbox in one transaction,
    /// then its actor, run, screen and run folders.
    pub(crate) async fn remove(self: &Arc<Self>, agent: &AgentHandle) -> Result<(), ErrorBody> {
        let _changing = agent.lock_run_change().await;
        if agent.exit().borrow().is_none() {
            self.stop_run(agent).await?;
        }
        let id = agent.id().to_string();
        self.runs.end_session_following(&id).await;
        let (store, deleted) = (self.store.clone(), id.clone());
        blocking(move || store.delete(&deleted)).await?;
        pause_for_test("after-record-delete");
        if self.agents.lock().unwrap().remove(&id).is_some() {
            let _ = self.changes.send(AgentsChange::Removed {
                agent_id: id.clone(),
            });
        }
        let (reply, removed) = oneshot::channel();
        if agent.send(AgentCommand::Remove { reply }).await {
            let _ = removed.await;
        }
        self.runs.remove(&id);
        if let Err(err) = crate::blocking_in_place(|| self.screens.remove(&id)) {
            log(
                "warn",
                &format!("could not delete the screen folder of removed agent {id}: {err}"),
            );
        }
        self.runs.remove_folders(&id);
        // The transaction deleted the inbox already: nothing to tell watchers.
        self.messages.drop_inbox(&id, Vec::new());
        Ok(())
    }

    /// Starts an ended agent's CLI again in its terminal, in its recorded session and folder, in
    /// window `args.window_id`, and returns the running record (`agent.resume`). The agent keeps
    /// its ID, name, record and screen. The new process ID and cleared exit are committed before
    /// the actor installs the terminal; where the commit fails, the new run is stopped.
    pub(crate) async fn resume(
        self: &Arc<Self>,
        agent: &AgentHandle,
        args: ResumeArgs,
    ) -> Result<AgentInfo, ErrorBody> {
        let id = agent.id().to_string();
        let unavailable = |message: String| ErrorBody::new(Reason::Unavailable, message);
        let busy = || unavailable(format!("agent #{id} is running or already resuming"));
        let Some(_changing) = agent.try_lock_run_change() else {
            return Err(busy());
        };
        if agent.exit().borrow().is_none() {
            return Err(busy());
        }
        let Some(_starting) = self.lifecycle.begin(Work::Start) else {
            return Err(unavailable(
                "Facade is exiting; resume the agent again".into(),
            ));
        };
        let Some(rule_name) = agent.rule() else {
            return Err(unavailable(format!(
                "#{id} was not started by a CLI rule, so Facade cannot resume it"
            )));
        };
        let rule = facade_rules::find(rule_name)
            .map_err(unavailable)?
            .ok_or_else(|| {
                unavailable(format!("#{id}'s CLI rule {rule_name} is not in this build"))
            })?;
        let info = agent.info();
        let Some(session) = info.session.clone() else {
            let message = if self.runs.has_unsaved_session(&id).await {
                format!(
                    "#{id} has no session to resume yet: its CLI has not saved one, as when no turn has run"
                )
            } else {
                format!("#{id} has no recorded session to resume")
            };
            return Err(unavailable(message));
        };
        let window = args
            .window_id
            .clone()
            .unwrap_or_else(|| TERMINAL_WINDOW.to_string());
        self.windows.check_destination(&window, &info.cwd)?;
        // A resume is a new launch: YOLO and the entry come from the settings file as it is now,
        // the entry of the same kind as the agent ran (RULES-4.2, CONFIGURATION-3.4).
        let settings = command_line::read_settings()?;
        let yolo = settings.yolo;
        let resumed = command_line::resume_entry(&settings, rule, &info.cli, &info.cwd, &args.env)?;
        let creator_name = info
            .creator
            .as_deref()
            .and_then(|creator| self.get_agent(creator))
            .map(|creator| creator.info().name);
        let label = self.windows.label(&window);
        let request = RunRequest {
            id: &id,
            rule: Some(rule),
            words: &resumed.words,
            program: resumed.program.as_deref(),
            plain_program: &rule.cli,
            inherited: resumed.env.clone(),
            cwd: &info.cwd,
            location_id: &info.location_id,
            window_id: &window,
            window_label: &label,
            creator: info
                .creator
                .as_deref()
                .map(|creator| (creator, creator_name.as_deref())),
            yolo,
            session: Some(&session),
            kind: RunKind::Resume,
        };
        let mut prepared = self.runs.prepare(request).await?;
        if !self
            .runs
            .previous_run_ended(&id, PREVIOUS_RUN_TIMEOUT)
            .await
        {
            return Err(unavailable(format!(
                "#{id}'s ended run is still being saved; try again"
            )));
        }
        let reservation = self.runs.reserve_start();
        reservation.wait_for_keeper().await?;
        // Hooks and servers of earlier runs must not reach the new run's files.
        crate::blocking_in_place(|| self.runs.replace_folders(&id, &prepared))?;
        let number = agent.run() + 1;
        let (reply, prepared_screen) = oneshot::channel();
        let restart = AgentCommand::PrepareRestart {
            run: number,
            cols: args.cols,
            rows: args.rows,
            reply,
        };
        if !agent.send(restart).await {
            return Err(agent_stopped(&id));
        }
        prepared_screen.await.map_err(|_| agent_stopped(&id))?;
        let started = self
            .runs
            .start(
                reservation,
                &id,
                number,
                &prepared,
                args.cols,
                args.rows,
                exit_sink(agent.mailbox()),
            )
            .await?;
        gate_for_test("before-restart-commit");
        let (store, committed, pid, window_id) =
            (self.store.clone(), id.clone(), started.pid, window.clone());
        if let Err(error) =
            blocking(move || store.record_restart(&committed, pid, &window_id, yolo)).await
        {
            self.runs.abandon(&id);
            return Err(error);
        }
        agent.set_window_and_yolo(&window, yolo);
        // Before the run is installed, so its first color query gets them as a reply.
        agent
            .send(AgentCommand::SetColors(self.window_colors(&window)))
            .await;
        let (reply, installed) = oneshot::channel();
        let install = AgentCommand::InstallRun {
            run: number,
            master: started.master,
            pid: started.pid,
            captures: prepared.captures,
            version: prepared.version.clone(),
            tools: prepared.tools,
            reply,
        };
        if !agent.send(install).await {
            return Err(agent_stopped(&id));
        }
        let info = installed.await.map_err(|_| agent_stopped(&id))?;
        let early_exit = {
            let _agents = self.agents.lock().unwrap();
            self.runs.installed(&id)
        };
        let captures = prepared.captures;
        prepared.let_go_of_plugin();
        if captures {
            self.runs.follow_session(
                &id,
                number,
                info.session.clone(),
                agent.output_seen(),
                FirstRead::Now,
            );
        }
        // An exit that came before the resume committed its run is saved now.
        if let Some(exit) = early_exit {
            self.settle_exit(id, exit, agent.clone());
        }
        Ok(info)
    }

    /// Renames an agent and returns its record. A blank name gets a default name, as a start
    /// without one does (LIFECYCLE-2.1).
    pub(crate) async fn rename(
        &self,
        agent: &AgentHandle,
        name: &str,
    ) -> Result<AgentInfo, ErrorBody> {
        let id = agent.id().to_string();
        let name = match name.trim_matches(facade_base::settings::is_space) {
            "" => self.reserve_name(
                &agent.info().window_id,
                &id,
                command_line::settings_names().as_deref(),
            ),
            name => name.to_string(),
        };
        let (store, saved, saving) = (self.store.clone(), id.clone(), name.clone());
        let renamed = match blocking(move || store.rename(&saved, &saving)).await {
            Err(error) => Err(error),
            Ok(()) => {
                let (reply, renamed) = oneshot::channel();
                let rename = AgentCommand::Rename {
                    name: name.clone(),
                    reply,
                };
                if agent.send(rename).await {
                    renamed.await.map_err(|_| agent_stopped(&id))
                } else {
                    Err(agent_stopped(&id))
                }
            }
        };
        self.records.release_name(&name);
        renamed
    }
}

/// Refuses an operation on a guest's terminal, which is not Facade's.
pub(crate) fn refuse_guest_terminal(agent: &AgentHandle) -> Result<(), ErrorBody> {
    if !agent.is_guest() {
        return Ok(());
    }
    Err(ErrorBody::new(
        Reason::Unavailable,
        format!(
            "#{} runs in a terminal of its own; start it with `facade start` for Facade to read, \
             type into or stop it",
            agent.id()
        ),
    ))
}
