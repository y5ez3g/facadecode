//! What the protocol server asks of the daemon: who a connection is, and what each operation does.
//! The server reads, decodes and answers; here each call meets the agents, the messages and the
//! windows. Topics are in `topics.rs`, relays in `relays.rs`.

use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{
    self, AgentArgs, AgentInspect, AgentRemove, AgentRename, AgentResize, AgentResume, AgentScreen,
    AgentSend, AgentStart, AgentState, AgentStop, AgentType, AgentsChange, ClientKind,
    DAEMON_PROTOCOL_VERSION, DEFAULT_SCREEN_LINES, DaemonLog, DaemonLogArgs, DaemonLogResult,
    DaemonUpgrade, HandOver, HelloParams, HelloResult, HookIdle, HookPrompt, HookSession,
    HookSessionEnd, HookSessionStart, HookTurnEnd, InputInfo, InputState, InspectResult,
    IntegrationAdd, IntegrationList, IntegrationRemove, MAX_SCREEN_LINES, RenameArgs, ResizeArgs,
    ResumeArgs, ScreenArgs, ScreenBuffer, ScreenText, SendArgs, SessionStartResult, StartArgs,
    TypeArgs, WindowDescription, WindowUpdate, WorktreeCreate, WorktreeCreateArgs,
};
use facade_base::daemon_client::Identity;
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::operations::{EmptyResult, Operation};
use facade_base::process::ProcessState;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{oneshot, watch};

use crate::agent::{AgentCommand, AgentHandle, Input, MAX_INPUT_BYTES, ToolsConnection};
use crate::agent::{Typing, TypingAnswer};
use crate::delivery::InputWait;
use crate::lifecycle::{Work, WorkGuard};
use crate::presence::HookTarget;
use crate::records;
use crate::server::{self, Client, RelayLines, WhenFull};
use crate::windows::WindowConnection;
use crate::{Cancel, Daemon, Sender};

/// How long an agent has to answer an inspection.
const INSPECT_TIMEOUT: Duration = Duration::from_secs(10);

/// What a connection holds while it is open: its window's presence, or its agent's tools.
pub(crate) struct Presence {
    _window: Option<WindowConnection>,
    _tools: Option<ToolsConnection>,
}

/// The highest number `numbers_given` takes, 2^53 - 1: the largest a JSON number holds exactly.
const MAX_NUMBER_GIVEN: u64 = (1 << 53) - 1;

impl server::Service for Daemon {
    type Hold = Presence;
    type Work = WorkGuard;

    async fn hello(
        self: &Arc<Self>,
        hello: HelloParams,
        _peer_pid: Option<u32>,
    ) -> Result<(HelloResult, Client, Presence), ErrorBody> {
        // The session the client's CLI names decides first: a command a guest's model runs acts
        // for the guest.
        let named = hello
            .agent
            .as_deref()
            .map(records::normalize_agent_reference);
        let agent = self.agent_of_sessions(&hello.sessions).or(named);
        let mut presence = Presence {
            _window: None,
            _tools: None,
        };
        let mut window = None;
        if let Some(given) = hello.numbers_given {
            if hello.kind != ClientKind::Ide {
                let message = "only an ide client tells the numbers its editor gave";
                return Err(ErrorBody::invalid_argument(message));
            }
            if given.agent.max(given.message) > MAX_NUMBER_GIVEN {
                let message = "numbers_given takes numbers up to 2^53 - 1";
                return Err(ErrorBody::invalid_argument(message));
            }
            crate::blocking_in_place(|| {
                self.records.raise_above(given.agent)?;
                self.messages.raise_above(given.message)
            })
            .map_err(ErrorBody::internal)?;
        }
        match (hello.kind, hello.window) {
            (ClientKind::Ide, Some(_)) if agent.is_some() => {
                let message = "an ide client acts for the person, not for an agent";
                return Err(ErrorBody::invalid_argument(message));
            }
            (ClientKind::Ide, Some(description)) => {
                let id = description.id.clone();
                presence._window = Some(self.window_connected(description).await?);
                window = Some(id);
            }
            (ClientKind::Ide, None) => {
                return Err(ErrorBody::invalid_argument(
                    "an ide client describes its window",
                ));
            }
            (_, Some(_)) => {
                return Err(ErrorBody::invalid_argument(
                    "only an ide client describes a window",
                ));
            }
            (_, None) => {}
        }
        if hello.kind == ClientKind::Mcp {
            let Some(id) = agent.as_deref() else {
                let message = "an mcp client names the agent it acts for";
                return Err(ErrorBody::invalid_argument(message));
            };
            // From now on it counts for its agent's tools, so its agent must be listed: a Facade
            // server that comes before its agent's start lists it tries again.
            let Some(listed) = self.get_agent(id) else {
                return Err(not_listed(id));
            };
            presence._tools = Some(listed.tools_connected());
        }
        let result = HelloResult {
            protocol: hello.protocol[1].min(DAEMON_PROTOCOL_VERSION),
            build: facade_base::build_id(),
            pid: std::process::id(),
            agent: agent.clone(),
            agents: self.agents().len(),
            keeper: self.runs.keeper_info(),
            topics: daemon::topic_names(),
            ops: daemon::operation_names(),
        };
        let client = Client {
            identity: Identity {
                kind: hello.kind,
                agent: agent.clone(),
                sessions: hello.sessions,
            },
            window,
            agent,
        };
        Ok((result, client, presence))
    }

    async fn call(
        self: &Arc<Self>,
        client: &Client,
        operation: &str,
        args: Value,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        // A call counts until it is answered. A send counts apart: a takeover's drain does not
        // wait for one, as the store keeps its message for the next daemon.
        let work = if operation == AgentSend::NAME {
            Work::Send
        } else {
            Work::Call
        };
        let Some(_working) = self.lifecycle.begin(work) else {
            return Err(ErrorBody::new(Reason::Unavailable, "Facade is exiting"));
        };
        self.run_operation(client, operation, args, when_full, cancel)
            .await
    }

    async fn watch(
        self: &Arc<Self>,
        client: &Client,
        topic: &str,
        args: Value,
        viewer: u64,
    ) -> Result<server::Watch, ErrorBody> {
        self.start_watch(client, topic, args, viewer).await
    }

    async fn unwatch(self: &Arc<Self>, client: &Client, topic: &str, viewer: u64) {
        self.end_watch(client, topic, viewer).await;
    }

    async fn relay(
        self: &Arc<Self>,
        params: Value,
        peer_pid: Option<u32>,
    ) -> Result<(Value, Arc<dyn RelayLines>), ErrorBody> {
        self.accept_relay(params, peer_pid).await
    }

    fn closing(&self) -> watch::Receiver<Option<String>> {
        self.lifecycle.closing()
    }

    fn draining(&self) -> Option<ErrorBody> {
        self.lifecycle.draining()
    }

    fn work(&self) -> Option<WorkGuard> {
        self.lifecycle.begin(Work::Connection)
    }
}

impl Daemon {
    /// Runs `operation` for `client`: decodes its arguments, finds the agent it names within the
    /// client's reach, and asks the part of the daemon that does it.
    async fn run_operation(
        self: &Arc<Self>,
        client: &Client,
        operation: &str,
        args: Value,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let acting = client.agent.as_deref();
        match operation {
            AgentStart::NAME => {
                let args: StartArgs = decode_arguments(args)?;
                let by_model = client.identity.kind == ClientKind::Mcp;
                let args = self.checked_start(args, acting, by_model).await?;
                let started = self.start(args, self.sender_of(acting), by_model).await?;
                Ok(value_of(started))
            }
            AgentResume::NAME => {
                let args: ResumeArgs = decode_arguments(args)?;
                check_size(args.cols, args.rows)?;
                let agent = self.terminal_agent(&args.agent, acting)?;
                Ok(value_of(self.resume(&agent, args).await?))
            }
            AgentInspect::NAME => {
                let AgentArgs { agent } = decode_arguments(args)?;
                let agent = self.reached_agent(&agent, acting)?;
                Ok(value_of(self.inspect(&agent).await?))
            }
            AgentStop::NAME => {
                let AgentArgs { agent } = decode_arguments(args)?;
                let agent = self.terminal_agent(&agent, acting)?;
                Ok(value_of(self.stop(&agent).await?))
            }
            AgentRemove::NAME => {
                let AgentArgs { agent } = decode_arguments(args)?;
                let agent = self.terminal_agent(&agent, acting)?;
                self.remove(&agent).await?;
                Ok(value_of(EmptyResult {}))
            }
            AgentScreen::NAME => {
                let args: ScreenArgs = decode_arguments(args)?;
                Ok(value_of(self.read_screen(args, acting).await?))
            }
            AgentType::NAME => {
                let args: TypeArgs = decode_arguments(args)?;
                self.type_into(args, acting, when_full, cancel).await?;
                Ok(value_of(EmptyResult {}))
            }
            AgentResize::NAME => {
                let args: ResizeArgs = decode_arguments(args)?;
                check_size(args.cols, args.rows)?;
                let agent = self.terminal_agent(&args.agent, acting)?;
                if !agent.send(AgentCommand::Resize(args.cols, args.rows)).await {
                    return Err(actor_stopped(&agent));
                }
                Ok(value_of(EmptyResult {}))
            }
            AgentRename::NAME => {
                let args: RenameArgs = decode_arguments(args)?;
                let agent = self.reached_agent(&args.agent, acting)?;
                Ok(value_of(self.rename(&agent, &args.name).await?))
            }
            AgentSend::NAME => {
                let args: SendArgs = decode_arguments(args)?;
                Ok(value_of(self.send(acting, args, cancel).await?))
            }
            HookSessionStart::NAME => {
                let session: HookSession = decode_arguments(args)?;
                Ok(value_of(self.session_started(client, session).await?))
            }
            HookPrompt::NAME => {
                let session: HookSession = decode_arguments(args)?;
                let HookTarget::Guest(guest) =
                    self.hook_target(client.agent.as_deref(), &session).await?
                else {
                    return Ok(value_of(HandOver::default()));
                };
                self.heard_from(&guest, session.env.as_ref(), true).await;
                self.set_guest_state(&guest, AgentState::Working);
                self.guests.follow_turn(guest.id(), &session);
                let messages = self.messages.take(guest.id())?;
                Ok(value_of(HandOver { messages }))
            }
            HookTurnEnd::NAME => {
                let session: HookSession = decode_arguments(args)?;
                let HookTarget::Guest(guest) =
                    self.hook_target(client.agent.as_deref(), &session).await?
                else {
                    return Ok(value_of(HandOver::default()));
                };
                self.heard_from(&guest, session.env.as_ref(), false).await;
                self.set_guest_state(&guest, AgentState::Idle);
                let messages = self.messages.take(guest.id())?;
                Ok(value_of(HandOver { messages }))
            }
            HookIdle::NAME => {
                let session: HookSession = decode_arguments(args)?;
                if let HookTarget::Guest(guest) =
                    self.hook_target(client.agent.as_deref(), &session).await?
                {
                    self.heard_from(&guest, session.env.as_ref(), false).await;
                    self.set_guest_state(&guest, AgentState::Idle);
                }
                Ok(value_of(EmptyResult {}))
            }
            HookSessionEnd::NAME => {
                let session: HookSession = decode_arguments(args)?;
                self.end_guest(&session.cli, &session.session);
                Ok(value_of(EmptyResult {}))
            }
            IntegrationAdd::NAME => {
                let added = self.guests.integration_add(decode_arguments(args)?).await?;
                Ok(value_of(added))
            }
            IntegrationRemove::NAME => {
                let removed = self
                    .guests
                    .integration_remove(decode_arguments(args)?)
                    .await?;
                Ok(value_of(removed))
            }
            IntegrationList::NAME => {
                let listed = self
                    .guests
                    .integration_list(decode_or_default(args)?)
                    .await?;
                Ok(value_of(listed))
            }
            WindowUpdate::NAME => {
                let description: WindowDescription = decode_arguments(args)?;
                let Some(window) = client.window.as_deref() else {
                    let message = "only an ide client describes a window";
                    return Err(ErrorBody::invalid_argument(message));
                };
                if description.id != window {
                    return Err(ErrorBody::invalid_argument(format!(
                        "this client is window {window}'s; it cannot describe window {}",
                        description.id
                    )));
                }
                self.window_updated(description).await?;
                Ok(value_of(EmptyResult {}))
            }
            WorktreeCreate::NAME => {
                let args: WorktreeCreateArgs = decode_arguments(args)?;
                Ok(value_of(self.create_worktree(args).await?))
            }
            DaemonUpgrade::NAME => Ok(value_of(
                self.lifecycle
                    .take_over(decode_arguments(args)?, self.clone())
                    .await?,
            )),
            DaemonLog::NAME => {
                if client.agent.is_some() {
                    return Err(ErrorBody::refused("daemon.log is for the person's clients"));
                }
                let args: DaemonLogArgs = decode_or_default(args)?;
                let lines = args.lines.unwrap_or(crate::lifecycle::MAX_LOG_LINES);
                let lines = crate::blocking_in_place(|| crate::lifecycle::last_lines(lines))?;
                Ok(value_of(DaemonLogResult { lines }))
            }
            other => Err(ErrorBody::invalid_argument(format!(
                "unknown operation {other}; supported operations: {}",
                daemon::operation_names().join(", ")
            ))),
        }
    }

    /// The answer to a session-start hook. A guest's session, or a part of one such as a
    /// subagent's, acts for the guest, and its model is told so; Facade's skill follows the
    /// instructions, as a run's comes beside them.
    async fn session_started(
        self: &Arc<Self>,
        client: &Client,
        session: HookSession,
    ) -> Result<SessionStartResult, ErrorBody> {
        let (HookTarget::Guest(guest) | HookTarget::Part(guest)) =
            self.hook_target(client.agent.as_deref(), &session).await?
        else {
            return Ok(SessionStartResult::default());
        };
        // The environment a session-start hook gives is its CLI's own, not a subagent's: an agent
        // it starts runs with it.
        if session.parent.is_none() {
            self.guests
                .keep_environment(guest.id(), session.env.as_ref());
        }
        self.heard_from(&guest, None, true).await;
        let instructions = format!(
            "{}\n\n{}",
            facade_base::instructions::for_guest(Some(guest.id())),
            facade_base::skill::text()
        );
        Ok(SessionStartResult {
            instructions: Some(instructions),
            agent_id: Some(guest.id().to_string()),
        })
    }

    /// A guest's state as its hooks tell it, shown to the agents' watchers where it changed.
    fn set_guest_state(&self, guest: &AgentHandle, state: AgentState) {
        if let Some(info) = guest.set_guest_state(state) {
            let _ = self.changes.send(AgentsChange::Updated {
                agent: Box::new(info),
            });
        }
    }

    /// The arguments of a start, checked. A start from facade-mcp names one CLI of Facade's
    /// settings file and nothing more, and runs with its agent's own environment, as a CLI chooses
    /// what it gives its MCP server.
    async fn checked_start(
        &self,
        mut args: StartArgs,
        acting: Option<&str>,
        by_model: bool,
    ) -> Result<StartArgs, ErrorBody> {
        if args
            .command
            .first()
            .is_none_or(|program| program.is_empty())
        {
            return Err(ErrorBody::invalid_argument(
                "command must start with the CLI program",
            ));
        }
        if !std::path::Path::new(&args.cwd).is_absolute() {
            let message = format!("cwd must be an absolute path, not {}", args.cwd);
            return Err(ErrorBody::invalid_argument(message));
        }
        check_size(args.cols, args.rows)?;
        if by_model {
            if args.command.len() > 1 {
                return Err(ErrorBody::invalid_argument(
                    "a start from facade-mcp names one CLI of Facade's settings file, and \
                     nothing more",
                ));
            }
            if args.session.is_some() {
                return Err(ErrorBody::invalid_argument(
                    "a start from facade-mcp continues no session",
                ));
            }
            if let Some(agent) = acting {
                args.env = self.environment_of(agent).await?;
            }
        }
        Ok(args)
    }

    /// What `agent` shows: a guest's input cannot be read, as its terminal is its own.
    async fn inspect(&self, agent: &AgentHandle) -> Result<InspectResult, ErrorBody> {
        if agent.is_guest() {
            return Ok(InspectResult {
                agent: agent.info(),
                rule: None,
                input: InputInfo {
                    state: InputState::Unknown,
                    evidence: "it runs in a terminal of its own, which Facade cannot read".into(),
                    mechanism: None,
                    hidden: None,
                },
                session_tracking: true,
            });
        }
        let (reply, inspected) = oneshot::channel();
        if !agent.send(AgentCommand::Inspect { reply }).await {
            return Err(actor_stopped(agent));
        }
        let inspection = match tokio::time::timeout(INSPECT_TIMEOUT, inspected).await {
            Ok(inspection) => inspection.map_err(|_| actor_stopped(agent))?,
            Err(_) => {
                let message = format!(
                    "#{} did not answer within {} seconds",
                    agent.id(),
                    INSPECT_TIMEOUT.as_secs()
                );
                return Err(ErrorBody::new(Reason::Unavailable, message));
            }
        };
        Ok(InspectResult {
            agent: inspection.agent,
            rule: agent.rule().map(str::to_string),
            input: inspection.input,
            session_tracking: inspection.session_tracking,
        })
    }

    /// The last `args.lines` lines of an agent's screen, as text.
    async fn read_screen(
        &self,
        args: ScreenArgs,
        acting: Option<&str>,
    ) -> Result<ScreenText, ErrorBody> {
        let lines = args.lines.unwrap_or(DEFAULT_SCREEN_LINES);
        if !(1..=MAX_SCREEN_LINES).contains(&lines) {
            let message = format!("lines must be between 1 and {MAX_SCREEN_LINES}");
            return Err(ErrorBody::invalid_argument(message));
        }
        let agent = self.terminal_agent(&args.agent, acting)?;
        let (reply, read) = oneshot::channel();
        let command = AgentCommand::ReadScreen {
            lines: lines as usize,
            reply,
        };
        if !agent.send(command).await {
            return Err(actor_stopped(&agent));
        }
        let read = read.await.map_err(|_| actor_stopped(&agent))?;
        // An ended agent's screen is as its exit left it.
        let observed_at = agent
            .exit()
            .borrow()
            .as_ref()
            .map_or_else(facade_base::time::iso_now, |exit| exit.at.clone());
        Ok(ScreenText {
            agent_id: agent.id().to_string(),
            process: agent.info().process,
            observed_at,
            buffer: if read.alternate {
                ScreenBuffer::Alternate
            } else {
                ScreenBuffer::Normal
            },
            text: read.text,
            line_count: read.lines as u32,
            older_lines: read.older,
            trimmed: read.trimmed,
        })
    }

    /// Types an `agent.type` call's input into its agent. Text and keys are answered once they
    /// reached the terminal, or with what was typed before typing stopped.
    async fn type_into(
        &self,
        args: TypeArgs,
        acting: Option<&str>,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> Result<(), ErrorBody> {
        crate::gate_for_test("before-type-input");
        let TypeArgs {
            agent,
            raw,
            text,
            enter,
            keys,
        } = args;
        let (input, typed) = input_of(raw, text, enter, keys, self.sender_of(acting))?;
        if input.most_bytes() > MAX_INPUT_BYTES {
            let message = format!(
                "agent.type accepts at most {} KiB of input as written, a paste counted with its \
                 brackets and Enter",
                MAX_INPUT_BYTES / 1024
            );
            return Err(ErrorBody::new(Reason::CapacityExceeded, message));
        }
        let agent = self.terminal_agent(&agent, acting)?;
        let wait = match when_full {
            WhenFull::Refuse => InputWait::Refuse,
            WhenFull::Wait => InputWait::UntilCancelled(cancel),
        };
        let handed = self.hand_input(&agent, input, wait).await;
        let Some(typed) = typed else {
            return handed;
        };
        handed.map_err(|mut refused| {
            if matches!(refused.data.reason, Reason::Ended | Reason::Unavailable) {
                refused.message.push_str("; nothing was typed");
            }
            refused
        })?;
        typed.await.map_err(|_| actor_stopped(&agent))?
    }

    /// Who a client acting for `agent` speaks as: that agent, with its name now, or else the
    /// person.
    pub(crate) fn sender_of(&self, agent: Option<&str>) -> Sender {
        match agent {
            Some(id) => Sender {
                from: id.to_string(),
                from_name: self.get_agent(id).map(|agent| agent.info().name),
            },
            None => Sender::person(),
        }
    }

    /// The agent `reference` names within the reach of a client acting for `acting`, or for the
    /// person.
    pub(crate) fn reached_agent(
        &self,
        reference: &str,
        acting: Option<&str>,
    ) -> Result<AgentHandle, ErrorBody> {
        self.resolve_agent(reference, &self.reach_of(acting))
    }

    /// The agent `reference` names, as [`Daemon::reached_agent`] finds it, for an operation on its
    /// terminal, which a guest's is not.
    pub(crate) fn terminal_agent(
        &self,
        reference: &str,
        acting: Option<&str>,
    ) -> Result<AgentHandle, ErrorBody> {
        let agent = self.reached_agent(reference, acting)?;
        crate::operations::refuse_guest_terminal(&agent)?;
        Ok(agent)
    }

    /// The running agent that has one of `sessions`, a guest or an agent Facade started, the
    /// newest where several do. A part of a session acts for the agent of the whole.
    fn agent_of_sessions(&self, sessions: &[String]) -> Option<String> {
        if sessions.is_empty() {
            return None;
        }
        let wholes = self.guests.whole_sessions(sessions);
        self.agent_infos()
            .into_iter()
            .rev()
            .find(|info| {
                info.process == ProcessState::Running
                    && info
                        .session
                        .as_ref()
                        .is_some_and(|session| wholes.contains(session))
            })
            .map(|info| info.agent_id)
    }
}

/// Reads the input of an `agent.type` call: exactly one of raw bytes, text from `sender`, or keys.
/// Text and keys come with the answer the typist gives once they reached the terminal.
fn input_of(
    raw: Option<String>,
    text: Option<String>,
    enter: bool,
    keys: Option<Vec<String>>,
    sender: Sender,
) -> Result<(Input, Option<TypingAnswer>), ErrorBody> {
    let typing = match (raw, text, keys) {
        (None, None, None) => {
            return Err(ErrorBody::invalid_argument(
                "agent.type takes one of raw, text, or keys",
            ));
        }
        (Some(_), None, None) | (None, None, Some(_)) if enter => {
            return Err(ErrorBody::invalid_argument("enter goes only with text"));
        }
        (Some(raw), None, None) => {
            let bytes = facade_base::base64::decode(&raw)
                .map_err(|err| ErrorBody::invalid_argument(format!("raw is not base64: {err}")))?;
            return Ok((Input::Raw(bytes), None));
        }
        (None, Some(text), None) => Typing::text(text, enter, sender),
        (None, None, Some(keys)) => Typing::keys(&keys),
        _ => {
            let message = "agent.type takes only one of raw, text, or keys";
            return Err(ErrorBody::invalid_argument(message));
        }
    };
    let (typing, typed) = typing.map_err(ErrorBody::invalid_argument)?;
    Ok((Input::Typed(typing), Some(typed)))
}

fn check_size(cols: u16, rows: u16) -> Result<(), ErrorBody> {
    if cols < 2 || rows < 1 {
        let message = "terminal size must be at least 2 columns and 1 row";
        return Err(ErrorBody::invalid_argument(message));
    }
    Ok(())
}

pub(crate) fn not_listed(id: &str) -> ErrorBody {
    facade_base::service::mark_for_test("refused-mcp-hello");
    let message = format!("#{id}, the agent this client acts for, is not listed");
    ErrorBody::new(Reason::NotFound, message)
}

pub(crate) fn actor_stopped(agent: &AgentHandle) -> ErrorBody {
    let message = format!("agent #{} is unavailable: its actor stopped", agent.id());
    ErrorBody::new(Reason::Unavailable, message)
}

pub(crate) fn value_of(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol value must serialize")
}

/// Arguments that may be left out, read as their defaults then.
pub(crate) fn decode_or_default<T: serde::de::DeserializeOwned + Default>(
    args: Value,
) -> Result<T, ErrorBody> {
    if args.is_null() {
        Ok(T::default())
    } else {
        decode_arguments(args)
    }
}
