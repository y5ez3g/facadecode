//! The agent operations that join several parts of the daemon: start, resume, stop, remove,
//! rename, a run's exit, and the environment an agent's CLI started with. Each keeps the order the
//! parts are called in (docs/framework/ARCHITECTURE.md): the number before the process, the process before
//! the record, the record before the actor and the list, and the transaction before the list
//! changes.

use std::collections::{BTreeMap, hash_map::Entry};
use std::sync::Arc;
use std::time::Duration;

use facade_base::api_v1::daemon::Caller;
use facade_base::instructions::{self, Creator, ManagedRun};
use facade_base::model::agent::AgentLabel;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::{model::agent::AgentRef, model::message::MessageRef};
use facade_base::{
    model::agent::{AgentsUpdate, ManagedAgent, ManagedAgentState, ToolsState},
    model::machine::location_id,
    model::message::Message,
};
use facade_rules::{LaunchOrigin, LaunchPolicy};
use std::path::Path;
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent::{self, ActorStart, AgentCommand, AgentHandle, Kept, ScreenStart, StateStart};
use crate::command_line::{self, Configured};
use crate::lifecycle::Work;
use crate::messages::{self, Due, OwedResult, PromptWatch};
use crate::runs::{ExitSink, FirstRead, RunExit, RunKind, RunRequest};
use crate::store::{AgentRecord, CreationSource, InitialLaunch, RelayRunRecord, RemovalCause};
use crate::windows::Destination;
use crate::{
    Daemon, Sender, StartKey, agent_number, an_hour_ago, blocking, effect_time_left, gate_for_test,
    log, pause_for_test,
};

/// The exit wait once the keeper took `agent.stop`, its 3 seconds before SIGKILL included.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a resume waits for the ended run's exit to be saved and its session read.
const PREVIOUS_RUN_TIMEOUT: Duration = Duration::from_secs(30);
struct RunInstructions<'a> {
    address: String,
    folder: &'a str,
    machine: String,
    source: Option<CreationSource>,
    creator_address: Option<String>,
    creator_name: Option<&'a str>,
    yolo: bool,
}

impl RunInstructions<'_> {
    fn context(&self) -> ManagedRun<'_> {
        let creator = match self.source {
            Some(CreationSource::Agent) => {
                self.creator_address
                    .as_deref()
                    .map(|address| Creator::Agent {
                        address,
                        name: self.creator_name,
                    })
            }
            Some(CreationSource::CommandLine) => Some(Creator::CommandLine),
            Some(CreationSource::VsCode) => Some(Creator::VsCode),
            None => None,
        };
        ManagedRun {
            folder: self.folder,
            machine: &self.machine,
            creator,
            yolo: self.yolo,
        }
    }
}

/// The CLI rule and session ID on this machine.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct SessionKey {
    rule: String,
    session: String,
}

struct SessionClaim<'a> {
    daemon: &'a Daemon,
    key: SessionKey,
}

impl Drop for SessionClaim<'_> {
    fn drop(&mut self) {
        self.daemon
            .claimed_sessions
            .lock()
            .unwrap()
            .remove(&self.key);
    }
}

pub(crate) struct StartOrigin {
    pub(crate) caller: Caller,
    pub(crate) sender: Sender,
    pub(crate) launch: LaunchOrigin,
    pub(crate) unattended: bool,
    pub(crate) deadline: Option<std::time::Instant>,
}

impl StartOrigin {
    fn source(&self) -> CreationSource {
        match self.caller {
            Caller::Agent { .. } => CreationSource::Agent,
            Caller::Terminal { .. } => CreationSource::CommandLine,
            Caller::Ide { .. } => CreationSource::VsCode,
        }
    }

    fn key(&self, request_id: String) -> StartKey {
        StartKey {
            machine_id: self.caller.machine_id().to_string(),
            agent_id: match &self.caller {
                Caller::Agent { agent, .. } => Some(agent.agent_id.clone()),
                _ => None,
            },
            window_id: None,
            request_id,
        }
    }
}
/// A start's answer, once it has one.
/// Launch options resolved by the daemon before reserving a run.
pub(crate) struct StartRequest {
    pub(crate) cli: String,
    pub(crate) args: Vec<String>,
    pub(crate) folder: Option<String>,
    pub(crate) worktree: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) colors: facade_screen::TerminalColors,
    pub(crate) call_id: Option<String>,
    pub(crate) result_message_id: Option<String>,
    pub(crate) result_message_machine_id: Option<String>,
    pub(crate) request_id: Option<String>,
}

#[derive(Clone)]
pub(crate) struct Started {
    pub(crate) agent: ManagedAgent,
    pub(crate) prompt: Option<facade_base::model::message::Message>,
    pub(crate) result_message_id: Option<String>,
    pub(crate) result_message_machine_id: Option<String>,
    pub(crate) repeated: bool,
}

pub(crate) struct StopResult {
    pub(crate) exit: ProcessExit,
    pub(crate) already_ended: bool,
}

pub(crate) struct RestartRequest {
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) unattended: bool,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    /// None keeps the colors the agent's screen already has.
    pub(crate) colors: Option<facade_screen::TerminalColors>,
}

pub(crate) type StartAnswer = Option<Result<Started, ErrorBody>>;

/// A start under way with a request ID: the calls that repeat it meanwhile get its answer. It
/// lets go of its key once it answers, or ends without one; the record keeps the ID from then on.
struct StartUnderWay {
    daemon: Arc<Daemon>,
    key: StartKey,
    answer: watch::Sender<StartAnswer>,
}

impl StartUnderWay {
    fn answer(&self, answer: Result<Started, ErrorBody>) {
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
    Arc::new(
        move |RunExit {
                  run,
                  exit,
                  stopped,
                  stopped_by,
              }| {
            let mailbox = mailbox.clone();
            tokio::spawn(async move {
                let _ = mailbox
                    .send(AgentCommand::ProcessExited {
                        run,
                        exit,
                        stopped,
                        stopped_by,
                    })
                    .await;
            });
        },
    )
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

/// The error of an agent whose actor stopped.
pub(crate) fn agent_stopped(id: &str) -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        format!("agent {id} is unavailable: its actor stopped"),
    )
}

impl Daemon {
    /// The listed agents, in number order.
    pub(crate) fn agents(&self) -> Vec<AgentHandle> {
        let mut agents: Vec<AgentHandle> = self.agents.lock().unwrap().values().cloned().collect();
        agents.sort_by_key(|agent| agent_number(agent.id()));
        agents
    }

    /// The listed agents' records, in number order.
    pub(crate) fn agent_infos(&self) -> Vec<ManagedAgent> {
        self.agents().iter().map(AgentHandle::info).collect()
    }

    /// The agent with ID `id`, if it is listed.
    pub(crate) fn get_agent(&self, id: &str) -> Option<AgentHandle> {
        self.agents.lock().unwrap().get(id).cloned()
    }

    /// Tells the `agents` topic that `info` is an agent's record now.
    pub(crate) fn publish(&self, info: ManagedAgent) {
        let _ = self.changes.send(AgentsUpdate::Updated {
            agent: Box::new(info),
        });
    }

    /// Uses the same active roster as list, then checks local names under the reservation lock.
    pub(crate) async fn reserve_name(
        self: &Arc<Self>,
        names: Option<&[String]>,
    ) -> Result<String, ErrorBody> {
        let caller = Caller::Terminal {
            machine_id: self.machine_id.clone(),
        };
        let snapshot = self.list_active_agents(&caller, None).await?;
        let mut taken: Vec<String> = snapshot
            .agents
            .into_iter()
            .filter(|agent| agent.reference.machine_id != self.machine_id)
            .map(|agent| agent.name)
            .collect();
        let agents = self.agents.lock().unwrap();
        taken.extend(agents.values().filter_map(|agent| {
            let info = agent.info();
            (info.process == ProcessState::Running).then_some(info.name)
        }));
        Ok(self.records.reserve_active_name(&taken, names))
    }

    /// Starts and installs a managed run, with the same request key on retries.
    pub(crate) async fn start(
        self: &Arc<Self>,
        args: StartRequest,
        origin: StartOrigin,
    ) -> Result<Started, ErrorBody> {
        let Some(request_id) = args.request_id.clone() else {
            return self.start_once(args, origin, None).await;
        };
        check_request_id(&request_id)?;
        let key = origin.key(request_id.clone());
        let from = origin.sender.from.clone();
        let under_way = {
            let mut starting = self.starting.lock().unwrap();
            if let Some(answer) = starting.get(&key) {
                Err(answer.clone())
            } else if let Some(answer) = self.started_before(&key)? {
                log(
                    "info",
                    &format!(
                        "#{}'s start request {request_id} answers #{} again, as it stands",
                        from, answer.agent.agent_id
                    ),
                );
                return Ok(answer);
            } else {
                effect_time_left(origin.deadline)?;
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
                let answer = self.start_once(args, origin, None).await;
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
                    from, answer.agent.agent_id
                ),
            );
        }
        answer.map(|answer| Started {
            repeated: true,
            ..answer
        })
    }

    /// The agent `creator` (none for the person) started with `request_id` within the hour, as a
    /// repeat answers it: as it stands now, with its prompt as it stands, and the result an
    /// agent's start is owed.
    fn started_before(&self, key: &StartKey) -> Result<Option<Started>, ErrorBody> {
        let since = an_hour_ago();
        let found = crate::blocking_in_place(|| self.store.find_start(key, &since))
            .map_err(ErrorBody::internal)?;
        let Some(kept) = found else {
            return Ok(None);
        };
        let Some(agent) = self.get_agent(&kept.agent_id) else {
            return Ok(None);
        };
        Ok(Some(Started {
            agent: agent.info(),
            prompt: kept
                .prompt
                .and_then(|number| self.messages.message(&format!("m{number}"))),
            result_message_machine_id: kept
                .result
                .as_ref()
                .map(|reference| reference.machine_id.clone()),
            result_message_id: kept.result.map(|reference| reference.message_id),
            repeated: true,
        }))
    }

    /// One start: its CLI's entry, model, effort and prompt checked first, then its worktree made
    /// where it asks for one, then its CLI started there (CLIS-4.2). A start that fails after making
    /// its worktree says that the worktree stays.
    async fn start_once(
        self: &Arc<Self>,
        args: StartRequest,
        origin: StartOrigin,
        session: Option<String>,
    ) -> Result<Started, ErrorBody> {
        effect_time_left(origin.deadline)?;
        gate_for_test("before-start-run");
        let (settings, mut configured, destination) = self
            .check_local_start(&args, origin.launch == LaunchOrigin::Agent)
            .await?;
        if let Some(session) = session.as_deref() {
            command_line::check_session(&configured, session)?;
        }
        effect_time_left(origin.deadline)?;
        let Some(branch) = args.worktree.as_deref() else {
            return self
                .start_in(args, origin, &settings, configured, destination, session)
                .await;
        };
        let branch = branch.to_owned();
        let made = self
            .windows
            .create_local_worktree(Path::new(&destination.cwd), &branch)
            .await?;
        let start = async {
            configured.find_program(&made.path, &settings, &args.env)?;
            let destination = Destination {
                cwd: made.path.clone(),
                location_id: made.location_id,
            };
            self.start_in(args, origin, &settings, configured, destination, session)
                .await
        };
        start.await.map_err(|mut error| {
            error.message.push_str(&format!(
                "; the worktree {} on branch {branch} was created and stays",
                made.path
            ));
            error.data.kept = Some(facade_base::model::machine::Kept {
                branch: Some(branch),
                path: Some(made.path),
            });
            error
        })
    }

    pub(crate) async fn start_saved_session(
        self: &Arc<Self>,
        args: StartRequest,
        origin: StartOrigin,
        session: String,
    ) -> Result<Started, ErrorBody> {
        self.start_once(args, origin, Some(session)).await
    }

    async fn check_local_start(
        &self,
        args: &StartRequest,
        by_model: bool,
    ) -> Result<(facade_base::settings::Settings, Configured, Destination), ErrorBody> {
        let folder = args
            .folder
            .as_deref()
            .ok_or_else(|| ErrorBody::internal("start folder was not resolved"))?;
        crate::service::check_size(args.cols, args.rows)?;
        let settings = command_line::read_settings()?;
        let mut configured = command_line::configure(&settings, args, folder, by_model)?;
        if let Some(prompt) = args.prompt.as_deref() {
            facade_base::model::message::check_message_text(prompt).map_err(|why| {
                ErrorBody::invalid_argument(format!("the prompt cannot go as a message: {why}"))
            })?;
            if configured.rule.is_none() {
                return Err(ErrorBody::new(
                    Reason::Unsupported,
                    format!(
                        "{} is a custom program and cannot receive a prompt",
                        configured.cli
                    ),
                ));
            }
        }
        crate::windows::preflight(Path::new(folder), args.worktree.as_deref()).await?;
        let destination = Destination {
            cwd: folder.to_string(),
            location_id: location_id(folder),
        };
        configured.find_program(&destination.cwd, &settings, &args.env)?;
        Ok((settings, configured, destination))
    }

    async fn start_in(
        self: &Arc<Self>,
        args: StartRequest,
        origin: StartOrigin,
        settings: &facade_base::settings::Settings,
        configured: Configured,
        destination: Destination,
        session: Option<String>,
    ) -> Result<Started, ErrorBody> {
        let Some(_starting) = self.lifecycle.begin(Work::Start) else {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                "Facade is exiting; start the agent again",
            ));
        };
        let folder = destination.cwd;
        let location = destination.location_id;
        let yolo = settings.yolo;
        let policy = LaunchPolicy {
            origin: origin.launch,
            unattended: origin.unattended,
            yolo: yolo.then_some(Path::new(&folder)),
        };
        let allow_auto_trust = policy.startup_folder().is_some();
        let rule = configured.rule;
        let reservation = self.runs.reserve_start();
        let id = self.records.next_id().await?;
        let _session = rule
            .zip(session.as_deref())
            .map(|(rule, session)| {
                self.claim_session(
                    &id,
                    &rule.cli,
                    session,
                    policy.origin == LaunchOrigin::Person,
                )
            })
            .transpose()?;
        let (creator, root) = match &origin.caller {
            Caller::Agent { agent, root, .. } => (
                Some(crate::api::agent_ref(agent.clone())),
                crate::api::agent_ref(root.clone()),
            ),
            _ => (
                None,
                AgentRef {
                    machine_id: self.machine_id.clone(),
                    agent_id: id.clone(),
                },
            ),
        };
        let sender = &origin.sender;
        let given = args
            .name
            .as_deref()
            .map(|name| name.trim_matches(facade_base::settings::is_space))
            .filter(|name| !name.is_empty());
        let name = match given {
            Some(name) => name.to_string(),
            None => self.reserve_name(settings.names.as_deref()).await?,
        };
        let release_name = || {
            if given.is_none() {
                self.records.release_name(&name);
            }
        };
        if let Err(error) = reservation.wait_for_keeper().await {
            release_name();
            return Err(error);
        }
        let creator_name = sender.from_name.as_deref();
        let request = RunRequest {
            id: &id,
            rule,
            words: &configured.options.args,
            program: configured.program.as_deref(),
            plain_program: &args.cli,
            inherited: configured.env.clone(),
            cwd: &folder,
            policy,
            session: session.as_deref(),
            kind: RunKind::Start,
        };
        let prepared = self
            .prepare_run(
                request,
                Some(origin.source()),
                creator.as_ref(),
                creator_name,
            )
            .await;
        let mut prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                release_name();
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
                release_name();
                return Err(error);
            }
        };
        pause_for_test("after-run-start");
        let info = ManagedAgent {
            address: None,
            label: None,
            unreachable: false,
            agent_id: id.clone(),
            name: name.clone(),
            cli: configured.cli.clone(),
            location_id: location,
            cwd: folder,
            machine_id: self.machine_id.clone(),
            windows: Vec::new(),
            location_source_window: None,
            pid: Some(started.pid),
            process: ProcessState::Running,
            cols: Some(args.cols),
            rows: Some(args.rows),
            created_at: facade_base::time::iso_now(),
            creator: creator.as_ref().map(|agent| agent.agent_id.clone()),
            creator_machine_id: creator.as_ref().map(|agent| agent.machine_id.clone()),
            root: root.agent_id.clone(),
            root_machine_id: Some(root.machine_id.clone()),
            yolo,
            exit: None,
            session,
            state: ManagedAgentState::Starting,
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
            run_birth: Some(started.process.birth.clone()),
            created_at: info.created_at.clone(),
            exit: None,
            creator_stop: false,
            rule: rule.map(|rule| rule.cli.clone()),
            session: info.session.clone(),
            windows: info.windows.clone(),
            location_source_window: info.location_source_window.clone(),
            creator: info.creator.clone(),
            creator_machine_id: info.creator_machine_id.clone(),
            start_machine_id: origin.caller.machine_id().to_string(),
            start_window_id: None,
            root: root.agent_id,
            root_machine_id: root.machine_id,
            yolo,
            request_id: args.request_id.clone(),
            prompt: None,
            location_id: info.location_id.clone(),
        };
        // The prompt is committed with the record, so that a start answered with it never loses
        // it; its delivery time begins once the CLI's tools connected or will not.
        let store = self.store.clone();
        let source = origin.source();
        let options = configured.options;
        let launch_command = prepared.launch_command.clone();
        let relay = RelayRunRecord {
            process: started.process.clone(),
            version: 3,
            digest: started
                .credential
                .as_ref()
                .map(|credential| credential.digest),
        };
        let kept = match args.prompt.clone() {
            None => {
                blocking(move || {
                    store
                        .insert_launch(
                            &record,
                            Some(&InitialLaunch {
                                source,
                                options: &options,
                                relay: &relay,
                                command: launch_command.as_deref(),
                            }),
                        )
                        .map(|()| None)
                })
                .await
            }
            Some(text) => {
                let message = Message {
                    call_id: args.call_id.clone(),
                    from_machine_id: (origin.caller.machine_id() != self.machine_id)
                        .then(|| origin.caller.machine_id().to_string()),
                    from_window: None,
                    ..crate::delivery::pending_message(sender.clone(), &id, text, None, None)
                };
                let owes = creator.is_some();
                let reserved = args
                    .result_message_machine_id
                    .clone()
                    .zip(args.result_message_id.clone())
                    .map(|(machine_id, message_id)| MessageRef {
                        machine_id,
                        message_id,
                    });
                blocking(move || {
                    store
                        .insert_launch_with_prompt(
                            &record,
                            &message,
                            owes,
                            reserved.as_ref(),
                            Some(&InitialLaunch {
                                source,
                                options: &options,
                                relay: &relay,
                                command: launch_command.as_deref(),
                            }),
                        )
                        .map(Some)
                })
                .await
            }
        };
        let kept = match kept {
            Ok(kept) => kept,
            Err(error) => {
                release_name();
                self.runs.remove_folders(&id);
                self.runs.abandon(&id);
                return Err(error);
            }
        };
        gate_for_test("after-start-record");
        let screen = self.screens.folder(&id);
        let actor = ActorStart {
            colors: args.colors,
            info: info.clone(),
            master: Some(started.master),
            screen: ScreenStart::New(screen.clone()),
            untouched_input: info.session.is_none(),
            rule: rule.map(|rule| rule.cli.clone()),
            captures: prepared.captures,
            launch_command: prepared.launch_command.take(),
            deliveries: self.messages.delivery_handle(),
            observed_loss: false,
            state: StateStart {
                tools_config: prepared.tools_config.take(),
                file: agent::state_file(&screen),
                kept: Kept::new_run(prepared.tools),
                started: tokio::time::Instant::now(),
            },
        };
        let handle =
            match agent::spawn_with_trust(actor, rx, tx, self.changes.clone(), allow_auto_trust) {
                Ok(handle) => handle
                    .with_start_prompt(kept.as_ref().map(|(prompt, _)| messages::number(prompt))),
                Err(err) => {
                    release_name();
                    self.runs.remove_folders(&id);
                    let (store, removed) = (self.store.clone(), id.clone());
                    let _ = blocking(move || store.delete(&removed, an_hour_ago)).await;
                    self.runs.abandon(&id);
                    return Err(ErrorBody::internal(format!(
                        "could not read agent {id}'s terminal: {err}"
                    )));
                }
            };
        // A prompt holds the run's messages from before the agent is listed, so that none goes
        // ahead of it.
        let mut watch_prompt = None;
        let prompt = match kept {
            Some((mut prompt, owed)) => {
                let owes = owed.clone().map(|reference| {
                    let agent = handle.clone();
                    let started_prompt = PromptWatch::new(messages::number(&prompt));
                    watch_prompt = Some(started_prompt.clone());
                    OwedResult::new(reference, started_prompt, move || {
                        agent.prompt_result_facts()
                    })
                });
                let settled = self.messages.deliver_prompt(prompt.clone(), owes);
                let (ready, started) = oneshot::channel();
                if prompt.from_name.is_none() && prompt.from_machine_id.is_none() {
                    prompt.from_name = self.get_agent(&prompt.from).map(|agent| agent.info().name);
                }
                // The text the actor charges is the text it will paste once the start settles.
                let text = self.message_text(&prompt);
                handle
                    .send(AgentCommand::AwaitPrompt {
                        text: text.clone(),
                        ready,
                    })
                    .await;
                Some((prompt, owed, settled, started, text))
            }
            None => None,
        };
        let early_exit = {
            let mut agents = self.agents.lock().unwrap();
            agents.insert(id.clone(), handle.clone());
            release_name();
            self.publish(info.clone());
            self.runs.installed_run(&id, agent::FIRST_RUN)
        };
        self.watch_creator(&handle, watch_prompt).await;
        // Listed now: the plugin's hold goes, and the session is followed.
        prepared.let_go_of_plugin();
        if self.runs.captures(&id) {
            self.runs.follow_session(
                &id,
                agent::FIRST_RUN,
                info.session.clone(),
                handle.output_seen(),
                FirstRead::Now,
            );
        }
        let (prompt, result) = match prompt {
            Some((prompt, owed, settled, started, text)) => {
                tokio::spawn(self.clone().send_start_prompt(
                    handle.clone(),
                    prompt.clone(),
                    text,
                    settled,
                    started,
                ));
                (Some(prompt), owed)
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
        Ok(Started {
            agent: info,
            prompt,
            result_message_machine_id: result
                .as_ref()
                .map(|reference| reference.machine_id.clone()),
            result_message_id: result.map(|reference| reference.message_id),
            repeated: false,
        })
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
                format!("{id}'s environment is unavailable: {why}; nothing was started"),
            )
        };
        let agent = self.get_agent(id).ok_or_else(|| {
            ErrorBody::new(
                Reason::NotFound,
                format!("{id}, the agent this start acts for, is not listed"),
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
        caller: &Caller,
        deadline: Option<std::time::Instant>,
    ) -> Result<(StopResult, AgentLabel), ErrorBody> {
        let _changing = agent.lock_run_change().await;
        gate_for_test("before-stop-run");
        effect_time_left(deadline)?;
        let stopped_by = match caller {
            Caller::Agent { agent, .. } => Some(crate::api::agent_ref(agent.clone())),
            _ => None,
        };
        let result = self.stop_run(agent, stopped_by).await?;
        Ok((result, self.agent_label(agent)?))
    }

    /// Stops `agent`'s run while the caller holds its run change: only the keeper signals a CLI.
    /// Waits up to 30 seconds for its exit. A run that ended before is left as it was.
    pub(crate) async fn stop_run(
        &self,
        agent: &AgentHandle,
        stopped_by: Option<AgentRef>,
    ) -> Result<StopResult, ErrorBody> {
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
                "agent {id} cannot be stopped: its actor stopped; nothing was sent"
            )));
        }
        let _stopping = self.lifecycle.begin(Work::Stop);
        // The console hangs up only once every copy of its signal pipe is closed: the actor's
        // first, then keeper_link's, then the keeper's.
        let (reply, let_go) = oneshot::channel();
        if !agent.send(AgentCommand::LetGoBeforeStop { reply }).await || let_go.await.is_err() {
            return Err(agent_stopped(&id));
        }
        let (run, info) = agent.installed_record();
        let by_creator = stopped_by.is_some() && stopped_by == info.creator_ref();
        let running = self.runs.stop(&id, run, stopped_by, by_creator).await?;
        match tokio::time::timeout(STOP_TIMEOUT, exit.wait_for(Option::is_some)).await {
            Ok(Ok(exit)) => Ok(StopResult {
                exit: exit.clone().expect("a recorded exit"),
                already_ended: !running,
            }),
            Ok(Err(_)) => Err(agent_stopped(&id)),
            Err(_) => Err(ErrorBody::new(
                Reason::Unavailable,
                format!(
                    "agent {id} did not end within the {}-second stop wait",
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
            let mut observed = agent.exit();
            let _ = observed.wait_for(Option::is_some).await;
            pause_for_test("before-exit-commit");
            let notice = daemon
                .creator_end_notice(&agent)
                .filter(|_| !daemon.runs.creator_stopped(&id, None));
            let first_prompt = agent.start_prompt();
            let mut delay = Duration::from_millis(500);
            let saved = loop {
                let (recorder, saved, exited) = (daemon.clone(), id.clone(), exit.clone());
                let due = Due::now();
                let local = notice
                    .as_ref()
                    .filter(|(creator, _)| creator.machine_id == daemon.machine_id)
                    .map(|(creator, notice)| daemon.local_notice(creator, notice, &due));
                let result = match local.transpose() {
                    Ok(local) => {
                        blocking(move || {
                            recorder.messages.record_exit(
                                &recorder.store,
                                &saved,
                                &exited,
                                first_prompt,
                                local,
                                &due,
                            )
                        })
                        .await
                    }
                    Err(error) => Err(error),
                };
                match result {
                    Ok(saved) => break saved,
                    Err(error) => {
                        daemon.lifecycle.delay_exit(&format!(
                            "could not save the exit of {id}: {}",
                            error.message
                        ));
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                }
            };
            if saved
                && let Some((creator, notice)) = notice
                && creator.machine_id != daemon.machine_id
            {
                daemon.route_notice(creator, notice);
            }
            daemon.lifecycle.clear_exit_delay();
            let mut settled = agent.settled();
            let _ = settled.wait_for(|settled| *settled).await;
            daemon.release_ended_run(&id).await;
            drop(saving);
        });
        let agents = self.agents.lock().unwrap();
        self.runs
            .keep_exit_task(&writer, task, || agents.contains_key(&writer));
    }

    /// Releases a run and gives unused display and database storage back once all runs settled.
    pub(crate) async fn release_ended_run(&self, id: &str) {
        if self.runs.release(id) && self.runs.busy().is_none() {
            agent::release_view_storage();
            let store = self.store.clone();
            if let Err(error) = blocking(move || store.release_cache()).await {
                log("warn", &error.message);
            }
        }
    }

    /// Removes an agent: stops it first, then deletes its record with its inbox in one transaction,
    /// then its actor, run, screen and run folders.
    pub(crate) async fn remove(self: &Arc<Self>, agent: &AgentHandle) -> Result<(), ErrorBody> {
        let _changing = agent.lock_run_change().await;
        if agent.exit().borrow().is_none() {
            self.stop_run(agent, None).await?;
        }
        self.remove_stopped(agent, RemovalCause::Removed).await
    }

    /// Expires stopped records under the same run lock that protects a resume.
    pub(crate) async fn expire_agents(self: &Arc<Self>, before: &str) {
        let expired = |agent: &AgentHandle| {
            agent
                .exit()
                .borrow()
                .as_ref()
                .is_some_and(|exit| exit.at.as_str() < before)
        };
        for agent in self.agents().into_iter().filter(expired) {
            let _changing = agent.lock_run_change().await;
            if expired(&agent)
                && self.get_agent(agent.id()).is_some()
                && let Err(error) = self.remove_stopped(&agent, RemovalCause::Expired).await
            {
                log(
                    "warn",
                    &format!("could not expire agent {}: {}", agent.id(), error.message),
                );
            }
        }
    }

    /// Removes the record and files of an agent whose run lock the caller holds.
    async fn remove_stopped(
        &self,
        agent: &AgentHandle,
        cause: RemovalCause,
    ) -> Result<(), ErrorBody> {
        let id = agent.id().to_string();
        if !self
            .runs
            .previous_run_ended(&id, PREVIOUS_RUN_TIMEOUT)
            .await
        {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                format!("{id}'s ended run is still being saved; try again"),
            ));
        }
        self.runs.end_session_following(&id).await;
        let (store, deleted) = (self.store.clone(), id.clone());
        blocking(move || store.delete_listed(&deleted, cause, an_hour_ago)).await?;
        pause_for_test("after-record-delete");
        if self.agents.lock().unwrap().remove(&id).is_some() {
            let _ = self.changes.send(AgentsUpdate::Removed {
                agent_id: id.clone(),
                machine_id: self.machine_id.clone(),
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

    fn claim_session(
        &self,
        agent_id: &str,
        rule: &str,
        session: &str,
        show_owner: bool,
    ) -> Result<SessionClaim<'_>, ErrorBody> {
        let key = SessionKey {
            rule: rule.to_owned(),
            session: session.to_owned(),
        };
        let claimed_by = {
            let mut claims = self.claimed_sessions.lock().unwrap();
            match claims.entry(key.clone()) {
                Entry::Occupied(claim) => Some(claim.get().clone()),
                Entry::Vacant(claim) => {
                    claim.insert(agent_id.to_owned());
                    None
                }
            }
        };
        let in_use = |owner: &str| {
            let message = if show_owner {
                let reference = AgentRef {
                    agent_id: owner.to_owned(),
                    machine_id: self.machine_id.clone(),
                };
                let address = self.agent_address(&reference).unwrap_or_else(|_| {
                    facade_base::address::selector::format_agent_address(
                        &reference.agent_id,
                        &facade_base::address::selector::exact_machine_selector(
                            &reference.machine_id,
                        ),
                    )
                });
                format!("{rule} session {session} is in use by {address}; stop it before resuming")
            } else {
                format!("{rule} session {session} is already in use")
            };
            let error = ErrorBody::refused(message);
            if show_owner && let Some(agent) = self.get_agent(owner) {
                self.with_agent_error(&agent, error)
            } else {
                error
            }
        };
        if let Some(owner) = claimed_by {
            return Err(in_use(&owner));
        }
        let claim = SessionClaim { daemon: self, key };
        if let Some(owner) = self.agents().into_iter().find(|agent| {
            agent.id() != agent_id
                && agent.rule() == Some(rule)
                && agent.exit().borrow().is_none()
                && agent.info().session.as_deref() == Some(session)
        }) {
            return Err(in_use(owner.id()));
        }
        Ok(claim)
    }

    /// Resumes an ended agent in its recorded folder and session. An overlapping request returns
    /// the current record if a new run was installed while it waited.
    pub(crate) async fn resume(
        self: &Arc<Self>,
        agent: &AgentHandle,
        args: RestartRequest,
    ) -> Result<ManagedAgent, ErrorBody> {
        let id = agent.id().to_string();
        let unavailable = |message: String| ErrorBody::new(Reason::Unavailable, message);
        let busy = || unavailable(format!("agent {id} is running or already resuming"));
        let (when_called, then) = agent.installed_record();
        if then.process == ProcessState::Running {
            return Err(busy());
        }
        let _changing = agent.lock_run_change().await;
        if self.get_agent(&id).is_none() {
            return Err(ErrorBody::new(
                Reason::NotFound,
                format!("agent {id} is no longer listed"),
            ));
        }
        let (installed, info) = agent.installed_record();
        if installed != when_called {
            return Ok(info);
        }
        let Some(_starting) = self.lifecycle.begin(Work::Start) else {
            return Err(unavailable(
                "Facade is exiting; resume the agent again".into(),
            ));
        };
        let Some(rule_name) = agent.rule() else {
            return Err(unavailable(format!(
                "{id} was not started by a CLI rule, so Facade cannot resume it"
            )));
        };
        let rule = facade_rules::find(rule_name)
            .map_err(unavailable)?
            .ok_or_else(|| {
                unavailable(format!("{id}'s CLI rule {rule_name} is not in this build"))
            })?;
        let no_saved_session = || {
            unavailable(format!(
                "{id} has no session to resume yet: its CLI has not saved one, as when no turn has run"
            ))
        };
        let Some(session) = info.session.clone() else {
            if self.runs.has_unsaved_session(&id).await {
                return Err(no_saved_session());
            }
            return Err(unavailable(format!(
                "{id} has no recorded session to resume"
            )));
        };
        let _session_claim = self.claim_session(&id, rule_name, &session, true)?;
        if !std::path::Path::new(&info.cwd).is_dir() {
            return Err(unavailable(format!(
                "the folder {} no longer exists",
                info.cwd
            )));
        }
        // A resume is a new launch: YOLO and the entry come from the settings file as it is now,
        // the entry of the same kind as the agent ran (RULES-4.2, CONFIGURATION-3.4).
        let settings = command_line::read_settings()?;
        let yolo = settings.yolo;
        let details = crate::blocking_in_place(|| self.store.launch_details(&id))
            .map_err(ErrorBody::internal)?;
        let options = details.options.ok_or_else(|| {
            ErrorBody::internal(format!("the saved launch options for {id} are unavailable"))
        })?;
        let resumed =
            command_line::resume_entry(&settings, rule, &info.cli, &info.cwd, &args.env, options)?;
        if rule.session.resume_requires_saved_session
            && crate::blocking_in_place(|| {
                self.saved_session(rule, &info, &resumed.env, &resumed.words)
            })?
            .is_none()
        {
            return Err(no_saved_session());
        }
        let (creator, creator_name) = self.recorded_creator(&info);
        let request = RunRequest {
            id: &id,
            rule: Some(rule),
            words: &resumed.words,
            program: resumed.program.as_deref(),
            plain_program: &rule.cli,
            inherited: resumed.env.clone(),
            cwd: &info.cwd,
            policy: LaunchPolicy {
                origin: LaunchOrigin::Person,
                unattended: args.unattended,
                yolo: yolo.then_some(Path::new(&info.cwd)),
            },
            session: Some(&session),
            kind: RunKind::Resume,
        };
        let mut prepared = self
            .prepare_run(
                request,
                details.source,
                creator.as_ref(),
                creator_name.as_deref(),
            )
            .await?;
        if !self
            .runs
            .previous_run_ended(&id, PREVIOUS_RUN_TIMEOUT)
            .await
        {
            return Err(unavailable(format!(
                "{id}'s ended run is still being saved; try again"
            )));
        }
        let reservation = self.runs.reserve_start();
        reservation.wait_for_keeper().await?;
        // Hooks and servers of earlier runs must not reach the new run's files.
        crate::blocking_in_place(|| self.runs.replace_folders(&id, &prepared))?;
        // Reserve the run before Keeper starts it so an early exit reaches the actor.
        // The ended screen is kept until the committed terminal is installed.
        let number = agent.run() + 1;
        let (reply, restart_ready) = oneshot::channel();
        let restart = AgentCommand::PrepareRestart {
            run: number,
            cols: args.cols,
            rows: args.rows,
            reply,
        };
        if !agent.send(restart).await {
            return Err(agent_stopped(&id));
        }
        restart_ready.await.map_err(|_| agent_stopped(&id))?;
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
        let (store, committed) = (self.store.clone(), id.clone());
        let started_at = facade_base::time::iso_now();
        let launch_command = prepared.launch_command.clone();
        let process = started.process.clone();
        let digest = started
            .credential
            .as_ref()
            .map(|credential| credential.digest);
        if let Err(error) = blocking(move || {
            store.record_restart(
                &committed,
                &process,
                yolo,
                Some(&started_at),
                digest.as_ref(),
                launch_command.as_deref(),
            )
        })
        .await
        {
            self.runs.abandon(&id);
            return Err(error);
        }
        agent.set_yolo(yolo);
        let (reply, installed) = oneshot::channel();
        let install = AgentCommand::InstallRun {
            run: number,
            master: started.master,
            pid: started.pid,
            captures: prepared.captures,
            launch_command: prepared.launch_command.take(),
            tools: prepared.tools,
            tools_config: prepared.tools_config.take(),
            colors: args.colors,
            allow_auto_trust: args.unattended && yolo,
            reply,
        };
        if !agent.send(install).await {
            self.runs.abandon(&id);
            return Err(agent_stopped(&id));
        }
        let info = installed.await.map_err(|_| {
            self.runs.abandon(&id);
            agent_stopped(&id)
        })?;
        let early_exit = {
            let _agents = self.agents.lock().unwrap();
            self.runs.installed_run(&id, number)
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

    async fn prepare_run(
        &self,
        request: RunRequest<'_>,
        source: Option<CreationSource>,
        creator: Option<&AgentRef>,
        creator_name: Option<&str>,
    ) -> Result<crate::runs::PreparedRun, ErrorBody> {
        let projection = self.run_instructions(
            request.id,
            request.cwd,
            request.policy.yolo.is_some(),
            source,
            creator,
            creator_name,
        )?;
        self.runs
            .prepare_managed(request, &projection.address, &projection.context())
            .await
    }

    /// Renders instructions from the verified run's installed record and original creation source.
    pub(super) fn instructions_for_current_run(
        &self,
        info: &ManagedAgent,
    ) -> Result<String, ErrorBody> {
        let source = crate::blocking_in_place(|| self.store.launch_details(&info.agent_id))
            .map_err(ErrorBody::internal)?
            .source;
        let (creator, creator_name) = self.recorded_creator(info);
        let projection = self.run_instructions(
            &info.agent_id,
            &info.cwd,
            info.yolo,
            source,
            creator.as_ref(),
            creator_name.as_deref(),
        )?;
        Ok(instructions::for_managed(
            &projection.address,
            &projection.context(),
        ))
    }

    fn recorded_creator(&self, info: &ManagedAgent) -> (Option<AgentRef>, Option<String>) {
        let creator = info.creator.as_ref().map(|agent_id| AgentRef {
            agent_id: agent_id.clone(),
            machine_id: info
                .creator_machine_id
                .clone()
                .unwrap_or_else(|| self.machine_id.clone()),
        });
        let name = creator
            .as_ref()
            .filter(|creator| creator.machine_id == self.machine_id)
            .and_then(|creator| self.get_agent(&creator.agent_id))
            .map(|creator| creator.info().name);
        (creator, name)
    }

    fn run_instructions<'a>(
        &self,
        id: &str,
        folder: &'a str,
        yolo: bool,
        source: Option<CreationSource>,
        creator: Option<&AgentRef>,
        creator_name: Option<&'a str>,
    ) -> Result<RunInstructions<'a>, ErrorBody> {
        let reference = AgentRef {
            machine_id: self.machine_id.clone(),
            agent_id: id.to_owned(),
        };
        let machine = self.network.local_hello().name;
        let address = self.agent_address(&reference)?;
        let creator_address = creator
            .map(|creator| self.agent_address(creator))
            .transpose()?;
        Ok(RunInstructions {
            address,
            folder,
            machine,
            source,
            creator_address,
            creator_name,
            yolo,
        })
    }

    /// Renames an agent and returns its record. A blank name gets a default name, as a start
    /// without one does (LIFECYCLE-2.1).
    pub(crate) async fn rename(
        self: &Arc<Self>,
        agent: &AgentHandle,
        name: &str,
    ) -> Result<(ManagedAgent, String), ErrorBody> {
        let id = agent.id().to_string();
        let name = name.trim_matches(facade_base::settings::is_space);
        let reserved = name.is_empty();
        let name = match name {
            "" => {
                self.reserve_name(command_line::settings_names().as_deref())
                    .await?
            }
            name => name.to_string(),
        };
        if agent.is_guest() {
            let renamed = crate::blocking_in_place(|| {
                let agents = self.agents.lock().unwrap();
                let gone = || ErrorBody::new(Reason::NotFound, "the guest is no longer connected");
                let guest = agents.get(&id).ok_or_else(gone)?;
                let previous = guest.info().name;
                if !self
                    .store
                    .guest_table()
                    .rename_guest(&id, &name)
                    .map_err(ErrorBody::internal)?
                {
                    return Err(gone());
                }
                let renamed = guest.rename_guest(name.clone());
                self.publish(renamed.clone());
                Ok((renamed, previous))
            });
            if reserved {
                self.records.release_name(&name);
            }
            return renamed;
        }
        let _changing = agent.lock_run_change().await;
        let previous = agent.info().name;
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
        if reserved {
            self.records.release_name(&name);
        }
        renamed.map(|info| (info, previous))
    }
}
