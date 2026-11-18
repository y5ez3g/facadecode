//! The agent operations that join several parts of the daemon: start, resume, stop, remove,
//! rename, a run's exit, and the environment an agent's CLI started with. Each keeps the order the
//! parts are called in (docs/core/ARCHITECTURE.md): the number before the process, the process before
//! the record, the record before the actor and the list, and the transaction before the list
//! changes.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use facade_base::daemon::{
    AgentInfo, AgentStartArgs, AgentState, AgentsChange, Message, ResumeArgs, StartResult,
    StopResult, TERMINAL_WINDOW, ToolsState, WindowRef,
};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{AgentRef, Caller, MessageRef};
use facade_base::process::{ProcessExit, ProcessState};
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent::{
    self, ActorStart, AgentCommand, AgentHandle, Kept, ScreenStart, StateStart, WindowColors,
};
use crate::command_line::{self, Configured};
use crate::lifecycle::Work;
use crate::messages::OwedResult;
use crate::records::{self, Named, Reach};
use crate::runs::{ExitSink, FirstRead, RunExit, RunKind, RunRequest};
use crate::store::AgentRecord;
use crate::windows::Destination;
use crate::{Daemon, HUMAN, Sender, WindowBinding, blocking, gate_for_test, log, pause_for_test};

/// The exit wait once the keeper took `agent.stop`, its 3 seconds before SIGKILL included.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a resume waits for the ended run's exit to be saved and its session read.
const PREVIOUS_RUN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request ID answers again.
const REQUEST_HOUR: Duration = Duration::from_secs(60 * 60);

/// A request is scoped to its caller and the machine holding the start.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct StartKey {
    pub(crate) machine_id: String,
    pub(crate) agent_id: Option<String>,
    pub(crate) window_id: Option<String>,
    pub(crate) request_id: String,
}

pub(crate) struct StartOrigin {
    pub(crate) caller: Caller,
    pub(crate) sender: Sender,
    pub(crate) by_model: bool,
    pub(crate) from_window: Option<String>,
    pub(crate) colors: Option<facade_base::daemon::TerminalColors>,
}

impl StartOrigin {
    fn editor(&self) -> Option<WindowRef> {
        match &self.caller {
            Caller::Ide { window } => Some(window.clone()),
            _ => None,
        }
    }

    fn key(&self, request_id: String) -> StartKey {
        StartKey {
            machine_id: self.caller.machine_id().to_string(),
            agent_id: match &self.caller {
                Caller::Agent { agent, .. } => Some(agent.agent_id.clone()),
                _ => None,
            },
            window_id: self.editor().map(|window| window.window_id),
            request_id,
        }
    }
}
/// A start's answer, once it has one.
pub(crate) type StartAnswer = Option<Result<StartResult, ErrorBody>>;

struct StartWindows {
    members: Vec<WindowRef>,
    colors: Option<WindowColors>,
}

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

    /// Reserves a default name across the initial members, under the list's lock before records'.
    pub(crate) fn reserve_name(
        &self,
        windows: &[WindowRef],
        id: &str,
        names: Option<&[String]>,
    ) -> String {
        let agents = self.agents.lock().unwrap();
        let listed: Vec<AgentInfo> = agents.values().map(AgentHandle::info).collect();
        self.records.reserve_name(windows, &listed, id, names)
    }

    fn start_windows(
        &self,
        explicit: Option<WindowRef>,
        editor: Option<WindowRef>,
        sender: &Sender,
    ) -> Result<StartWindows, ErrorBody> {
        // A CLI can start a child before its own record is listed.
        let parent = if sender.from == HUMAN {
            None
        } else {
            self.get_agent(&sender.from)
        };
        let mut members = match explicit {
            Some(window) => {
                if window.machine_id == self.machine_id {
                    self.windows.check_member(&window)?;
                }
                vec![window]
            }
            None => match &parent {
                Some(parent) => parent.info().windows,
                None => vec![
                    editor
                        .clone()
                        .unwrap_or_else(|| self.local_window(TERMINAL_WINDOW)),
                ],
            },
        };
        members.sort();
        members.dedup();
        if members.is_empty() {
            return Err(ErrorBody::internal(
                "the starting agent has no member window",
            ));
        }
        let preferred = editor
            .or_else(|| parent.and_then(|parent| parent.color_source()))
            .filter(|window| members.contains(window));
        let colors = preferred
            .and_then(|window| {
                self.window_colors(&window)
                    .map(|colors| WindowColors { window, colors })
            })
            .or_else(|| self.first_member_colors(&members));
        Ok(StartWindows { members, colors })
    }

    fn instructions_window<'a>(&self, windows: &'a [WindowRef]) -> Option<(String, &'a str)> {
        let [window] = windows else {
            return None;
        };
        Some((self.windows.label(window), window.window_id.as_str()))
    }

    /// Starts a CLI as [`facade_base::daemon::AgentStart`] says. A start with its creator's own
    /// request ID looks for it first: a start with that ID under way, whose answer it waits for,
    /// or an agent the same creator started with it within the hour, which it answers as it stands
    /// now, starting nothing. A start that failed keeps no ID.
    pub(crate) async fn start(
        self: &Arc<Self>,
        args: AgentStartArgs,
        origin: StartOrigin,
    ) -> Result<StartResult, ErrorBody> {
        let Some(request_id) = args.request_id.clone() else {
            return self.start_once(args, origin).await;
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
                let answer = self.start_once(args, origin).await;
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
        answer.map(|answer| StartResult {
            repeated: true,
            ..answer
        })
    }

    /// The agent `creator` (none for the person) started with `request_id` within the hour, as a
    /// repeat answers it: as it stands now, with its prompt as it stands, and the result an
    /// agent's start is owed.
    fn started_before(&self, key: &StartKey) -> Result<Option<StartResult>, ErrorBody> {
        let since = an_hour_ago();
        let found = crate::blocking_in_place(|| self.store.find_start(key, &since))
            .map_err(ErrorBody::internal)?;
        let Some(kept) = found else {
            return Ok(None);
        };
        let Some(agent) = self.get_agent(&kept.agent_id) else {
            return Ok(None);
        };
        Ok(Some(StartResult {
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
        mut args: AgentStartArgs,
        origin: StartOrigin,
    ) -> Result<StartResult, ErrorBody> {
        let folder = self.prepare_start(&mut args, origin.by_model).await?;
        gate_for_test("before-start-run");
        // One reading of the settings file gives the start its YOLO, names and entry (RULES-4.3).
        let settings = command_line::read_settings()?;
        let configured = self.configure_start(&settings, &args, &origin, &folder)?;
        let windows = self.windows_for_start(&mut args, &origin)?;
        let Some(worktree) = args.worktree.take() else {
            return self
                .start_in(args, origin, &settings, configured, windows, &folder)
                .await;
        };
        self.windows
            .check_destination(args.location_source_window.as_ref(), &folder)?;
        let branch = worktree.branch.clone();
        let made = self
            .create_worktree(facade_base::daemon::WorktreeCreateArgs {
                window_id: args.location_source_window.as_ref().map_or_else(
                    || TERMINAL_WINDOW.to_owned(),
                    |window| window.window_id.clone(),
                ),
                cwd: folder,
                worktree,
            })
            .await?;
        self.start_in(args, origin, &settings, configured, windows, &made.path)
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

    fn configure_start(
        &self,
        settings: &facade_base::settings::Settings,
        args: &AgentStartArgs,
        origin: &StartOrigin,
        folder: &str,
    ) -> Result<Configured, ErrorBody> {
        let configured = command_line::configure(settings, args, folder, origin.by_model)?;
        let program = &args.launch.program;
        if let Some(session) = args.session.as_deref() {
            command_line::check_session(&configured, program, session)?;
        }
        if let Some(prompt) = args.prompt.as_deref() {
            command_line::check_start_prompt(prompt, &configured, program)?;
            let widest = Message {
                from_machine_id: (origin.caller.machine_id() != self.machine_id)
                    .then(|| origin.caller.machine_id().to_string()),
                from_window: origin.from_window.clone(),
                ..crate::delivery::pending_message(
                    origin.sender.clone(),
                    "a999999999",
                    prompt.to_owned(),
                    None,
                    None,
                )
            };
            crate::delivery::check_fits(
                configured.rule,
                "the new agent",
                &widest,
                "start it with a shorter prompt and send the rest as messages",
                |message| self.message_text(message),
            )?;
        }
        Ok(configured)
    }

    fn windows_for_start(
        &self,
        args: &mut AgentStartArgs,
        origin: &StartOrigin,
    ) -> Result<StartWindows, ErrorBody> {
        let Some(mut members) = args.initial_windows.take() else {
            return self.start_windows(args.window.take(), origin.editor(), &origin.sender);
        };
        members.sort();
        members.dedup();
        if members.is_empty() {
            return Err(ErrorBody::invalid_argument(
                "the forwarded start has no member window",
            ));
        }
        let colors = origin
            .editor()
            .filter(|window| members.contains(window))
            .zip(
                origin
                    .colors
                    .as_ref()
                    .and_then(|colors| crate::presence::terminal_colors(colors).ok()),
            )
            .map(|(window, colors)| WindowColors { window, colors })
            .or_else(|| self.first_member_colors(&members));
        Ok(StartWindows { members, colors })
    }

    pub(crate) async fn preflight_start(
        &self,
        mut args: AgentStartArgs,
        origin: &StartOrigin,
    ) -> Result<(), ErrorBody> {
        let folder = self.prepare_start(&mut args, origin.by_model).await?;
        let settings = command_line::read_settings()?;
        let mut configured = self.configure_start(&settings, &args, origin, &folder)?;
        self.windows_for_start(&mut args, origin)?;
        self.start_destination(&args, &mut configured, &folder)?;
        Ok(())
    }

    fn start_destination(
        &self,
        args: &AgentStartArgs,
        configured: &mut Configured,
        folder: &str,
    ) -> Result<Destination, ErrorBody> {
        let destination = self
            .windows
            .check_destination(args.location_source_window.as_ref(), folder)?;
        configured.find_program(&destination.cwd)?;
        Ok(destination)
    }

    /// Starts the CLI in `folder`, in the order a start keeps (docs/core/ARCHITECTURE.md).
    async fn start_in(
        self: &Arc<Self>,
        args: AgentStartArgs,
        origin: StartOrigin,
        settings: &facade_base::settings::Settings,
        mut configured: Configured,
        windows: StartWindows,
        folder: &str,
    ) -> Result<StartResult, ErrorBody> {
        let Some(_starting) = self.lifecycle.begin(Work::Start) else {
            return Err(ErrorBody::new(
                Reason::Unavailable,
                "Facade is exiting; start the agent again",
            ));
        };
        let destination = self.start_destination(&args, &mut configured, folder)?;
        let folder = destination.cwd;
        let location = destination.location_id;
        let yolo = settings.yolo;
        let rule = configured.rule;
        let reservation = self.runs.reserve_start();
        let id = self.records.next_id().await?;
        let (creator, root) = match &origin.caller {
            Caller::Agent { agent, root, .. } => (Some(agent.clone()), root.clone()),
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
            None => self.reserve_name(&windows.members, &id, settings.names.as_deref()),
        };
        if let Err(error) = reservation.wait_for_keeper().await {
            self.records.release_name(&name);
            return Err(error);
        }
        let creator_name = sender.from_name.as_deref();
        let place = self.instructions_window(&windows.members);
        let request = RunRequest {
            id: &id,
            rule,
            words: &configured.words,
            program: configured.program.as_deref(),
            plain_program: &args.launch.program,
            inherited: configured.env.clone(),
            cwd: &folder,
            location_id: &location,
            window: place.as_ref().map(|(label, id)| (label.as_str(), *id)),
            creator: creator
                .as_ref()
                .map(|creator| (creator.agent_id.as_str(), creator_name)),
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
            address: None,
            label: None,
            unreachable: false,
            agent_id: id.clone(),
            name: name.clone(),
            cli: configured.cli.clone(),
            location_id: location,
            cwd: folder,
            machine_id: self.machine_id.clone(),
            windows: windows.members,
            location_source_window: args.location_source_window,
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
            windows: info.windows.clone(),
            location_source_window: info.location_source_window.clone(),
            creator: info.creator.clone(),
            creator_machine_id: info.creator_machine_id.clone(),
            start_machine_id: origin.caller.machine_id().to_string(),
            start_window_id: origin.editor().map(|window| window.window_id),
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
        let kept = match args.prompt.clone() {
            None => blocking(move || store.insert(&record).map(|()| None)).await,
            Some(text) => {
                let message = Message {
                    call_id: args.call_id.clone(),
                    from_machine_id: (origin.caller.machine_id() != self.machine_id)
                        .then(|| origin.caller.machine_id().to_string()),
                    from_window: origin.from_window.clone(),
                    ..crate::delivery::pending_message(sender.clone(), &id, text, None, None)
                };
                let owes = sender.from != HUMAN;
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
                        .insert_with_prompt(&record, &message, owes, reserved.as_ref())
                        .map(Some)
                })
                .await
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
            colors: windows
                .colors
                .as_ref()
                .map_or_else(Default::default, |colors| colors.colors),
            info: info.clone(),
            master: Some(started.master),
            screen: ScreenStart::New(screen.clone()),
            untouched_input: args.session.is_none(),
            rule: rule.map(|rule| rule.cli.clone()),
            captures: prepared.captures,
            deliveries: self.messages.delivery_handle(),
            state: StateStart {
                file: agent::state_file(&screen),
                kept: Kept::new_run(prepared.version.clone(), prepared.tools),
                started: tokio::time::Instant::now(),
            },
        };
        let color_source = windows.colors.map(|colors| colors.window);
        let handle =
            match agent::spawn_with_color_source(actor, rx, tx, self.changes.clone(), color_source)
            {
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
                let owes = owed.clone().map(|reference| {
                    let agent = handle.clone();
                    OwedResult {
                        reference,
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
        let (prompt, result) = match prompt {
            Some((prompt, owed, settled, started)) => {
                tokio::spawn(self.clone().send_start_prompt(
                    handle.clone(),
                    prompt.clone(),
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
        Ok(StartResult {
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
    pub(crate) async fn stop_run(&self, agent: &AgentHandle) -> Result<StopResult, ErrorBody> {
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
                        daemon.lifecycle.delay_exit(&format!(
                            "could not save the exit of {id}: {}",
                            error.message
                        ));
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                }
            }
            daemon.lifecycle.clear_exit_delay();
            let mut settled = agent.settled();
            let _ = settled.wait_for(|settled| *settled).await;
            daemon.runs.release(&id);
            drop(saving);
        });
        self.runs.keep_exit_task(&writer, task);
    }

    /// Adds the calling editor to an agent. The actor publishes the committed member set.
    pub(crate) async fn adopt(
        &self,
        agent: &AgentHandle,
        window: &WindowRef,
        binding: Option<&WindowBinding>,
    ) -> Result<AgentInfo, ErrorBody> {
        if agent.is_guest() {
            return Err(ErrorBody::refused("a guest stays in its original window"));
        }
        let id = agent.id();
        let missing =
            || ErrorBody::new(Reason::NotFound, format!("agent #{id} is no longer listed"));
        let _changing = agent.lock_run_change().await;
        if self.get_agent(id).is_none() {
            return Err(missing());
        }
        if binding.is_some_and(|binding| !self.windows.is_current(binding)) {
            return Err(ErrorBody::refused("this editor window is no longer bound"));
        }
        let current = agent.info();
        if current.windows.contains(window) {
            return Ok(current);
        }
        let windows = self.records.add_window(id, window)?.ok_or_else(missing)?;
        let (reply, updated) = oneshot::channel();
        if !agent
            .send(AgentCommand::UpdateWindows { windows, reply })
            .await
        {
            return Err(agent_stopped(id));
        }
        updated.await.map_err(|_| agent_stopped(id))
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

    /// Resumes an ended agent in its recorded folder and session. An overlapping request returns
    /// the current record if a new run was installed while it waited.
    pub(crate) async fn resume(
        self: &Arc<Self>,
        agent: &AgentHandle,
        args: ResumeArgs,
    ) -> Result<AgentInfo, ErrorBody> {
        let id = agent.id().to_string();
        let unavailable = |message: String| ErrorBody::new(Reason::Unavailable, message);
        let busy = || unavailable(format!("agent #{id} is running or already resuming"));
        let (when_called, then) = agent.installed_record();
        if then.process == ProcessState::Running {
            return Err(busy());
        }
        let _changing = agent.lock_run_change().await;
        if self.get_agent(&id).is_none() {
            return Err(ErrorBody::new(
                Reason::NotFound,
                format!("agent #{id} is no longer listed"),
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
                "#{id} was not started by a CLI rule, so Facade cannot resume it"
            )));
        };
        let rule = facade_rules::find(rule_name)
            .map_err(unavailable)?
            .ok_or_else(|| {
                unavailable(format!("#{id}'s CLI rule {rule_name} is not in this build"))
            })?;
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
        let resumed = command_line::resume_entry(&settings, rule, &info.cli, &info.cwd, &args.env)?;
        let creator_name = info
            .creator
            .as_deref()
            .and_then(|creator| self.get_agent(creator))
            .map(|creator| creator.info().name);
        let place = self.instructions_window(&info.windows);
        let request = RunRequest {
            id: &id,
            rule: Some(rule),
            words: &resumed.words,
            program: resumed.program.as_deref(),
            plain_program: &rule.cli,
            inherited: resumed.env.clone(),
            cwd: &info.cwd,
            location_id: &info.location_id,
            window: place.as_ref().map(|(label, id)| (label.as_str(), *id)),
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
        let (store, committed, pid) = (self.store.clone(), id.clone(), started.pid);
        if let Err(error) = blocking(move || store.record_restart(&committed, pid, yolo)).await {
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
                &agent.info().windows,
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
