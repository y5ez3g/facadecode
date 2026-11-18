//! What the protocol server asks of the daemon: who a connection is, and what each operation does.
//! The server reads, decodes and answers; here each call meets the agents, the messages and the
//! windows. Topics are in `topics.rs`, relays in `relays.rs`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{
    self, AgentAdopt, AgentArgs, AgentInspect, AgentRemove, AgentRename, AgentResize, AgentResume,
    AgentScreen, AgentSend, AgentStart, AgentStartArgs, AgentState, AgentStop, AgentType,
    AgentsUpdate, ClientKind, DAEMON_PROTOCOL_VERSION, DEFAULT_SCREEN_LINES, DaemonLogArgs,
    DaemonLogResult, DaemonUpgrade, HandOver, HelloParams, HelloResult, HookIdle, HookPrompt,
    HookSession, HookSessionEnd, HookSessionStart, HookTurnEnd, InputInfo, InputState,
    InspectResult, IntegrationAdd, IntegrationList, IntegrationRemove, LogRead, MAX_SCREEN_LINES,
    RenameArgs, ResizeArgs, ResumeArgs, ScreenArgs, ScreenBuffer, ScreenText, SendArgs, SendResult,
    SessionStartResult, StartArgs, TypeArgs, WindowDelivery, WindowDescription, WindowUpdate,
    WorktreeCreate, WorktreeCreateArgs,
};
use facade_base::daemon_client::Identity;
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{
    AgentCheckStart, AgentDeliverStartResult, Caller, ForwardCall, WindowDeliver,
};
use facade_base::operations::{EmptyResult, Operation};
use facade_base::process::ProcessState;
use facade_base::sockets::{ServerReader, ServerWriter};
use serde::Serialize;
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::{oneshot, watch};

use crate::agent::{
    AgentCommand, AgentHandle, Input, MAX_INPUT_BYTES, ToolsConnection, WindowColors,
};
use crate::agent::{Typing, TypingAnswer};
use crate::delivery::InputWait;
use crate::lifecycle::{Work, WorkGuard};
use crate::machine_service::MachineStream;
use crate::presence::HookTarget;
use crate::records::{self, Reach};
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
    type Machine = MachineStream;

    async fn machine_hello(
        self: &Arc<Self>,
        hello: HelloParams,
        peer_pid: Option<u32>,
    ) -> Result<(HelloResult, Self::Machine), ErrorBody> {
        if hello.agent.is_some() || self.agent_of_hello(&hello, peer_pid).is_some() {
            return Err(ErrorBody::refused(
                "a local agent cannot open a trusted machine session",
            ));
        }
        self.machine_hello_plan(hello)
    }

    async fn machine_connect(
        self: &Arc<Self>,
        client: &Client,
        args: Value,
    ) -> Result<(Value, Self::Machine), ErrorBody> {
        self.machine_connect_plan(client, args)
    }

    async fn serve_machine(
        self: &Arc<Self>,
        machine: Self::Machine,
        read: BufReader<ServerReader>,
        write: ServerWriter,
    ) -> anyhow::Result<()> {
        self.serve_machine_stream(machine, read, write).await
    }

    async fn hello(
        self: &Arc<Self>,
        hello: HelloParams,
        peer_pid: Option<u32>,
    ) -> Result<(HelloResult, Client, Presence), ErrorBody> {
        // The session the client's CLI names decides first: a command a guest's model runs acts
        // for the guest.
        let agent = self.agent_of_hello(&hello, peer_pid);
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
                let connection = self.window_connected(description).await?;
                window = Some(connection.binding().clone());
                presence._window = Some(connection);
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
            machine: None,
            protocol: hello.protocol[1].min(DAEMON_PROTOCOL_VERSION),
            build: facade_base::build_id(),
            machine_id: self.machine_id.clone(),
            window: window.as_ref().map(|binding| binding.window.clone()),
            pid: std::process::id(),
            agent: agent.clone(),
            agents: self.agents().len(),
            keeper: self.runs.keeper_info(),
            topics: crate::topics::topic_names(),
            ops: operation_names(),
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
        mut args: Value,
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
        let caller = self.local_caller(client)?;
        if let Some(answer) = self
            .machine_operation(&caller, operation, args.clone(), false)
            .await
        {
            return answer;
        }
        let response = if let Some(answer) = self
            .route_agent_operation(client, &caller, operation, &mut args, cancel.clone())
            .await?
        {
            answer
        } else {
            self.run_operation(client, operation, args, when_full, cancel)
                .await?
        };
        self.project_agent_response(operation, response)
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
            AgentStart::NAME | AgentCheckStart::NAME => {
                let args: StartArgs = decode_arguments(args)?;
                self.start_from_client(client, args, operation == AgentCheckStart::NAME, cancel)
                    .await
            }
            AgentAdopt::NAME => {
                let AgentArgs { agent } = decode_arguments(args)?;
                let binding = client
                    .window
                    .as_ref()
                    .filter(|_| client.identity.kind == ClientKind::Ide && acting.is_none())
                    .ok_or_else(|| {
                        ErrorBody::refused("only a bound editor window can adopt an agent")
                    })?;
                let agent = self.reached_agent(&agent, acting)?;
                Ok(value_of(
                    self.adopt(&agent, &binding.window, Some(binding)).await?,
                ))
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
                let info = agent.info();
                let command = match client.window.as_ref().filter(|binding| {
                    info.windows.contains(&binding.window) && self.windows.is_current(binding)
                }) {
                    Some(binding) => AgentCommand::ResizeFromWindow {
                        cols: args.cols,
                        rows: args.rows,
                        colors: WindowColors {
                            window: binding.window.clone(),
                            colors: self.window_colors(&binding.window).unwrap_or_default(),
                        },
                    },
                    None => AgentCommand::Resize(args.cols, args.rows),
                };
                if !agent.send(command).await {
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
                Ok(value_of(SendResult::from(
                    self.send(&self.local_caller(client)?, args, cancel).await?,
                )))
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
                let Some(binding) = client.window.as_ref() else {
                    let message = "only an ide client describes a window";
                    return Err(ErrorBody::invalid_argument(message));
                };
                self.window_updated(binding, description).await?;
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
            LogRead::NAME => {
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
                operation_names().join(", ")
            ))),
        }
    }

    async fn start_from_client(
        self: &Arc<Self>,
        client: &Client,
        mut args: StartArgs,
        preflight: bool,
        mut cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let caller = self.local_caller(client)?;
        if args.initial_windows.is_some()
            || args.result_message_id.is_some()
            || args.result_message_machine_id.is_some()
        {
            return Err(ErrorBody::invalid_argument(
                "the originating machine sets initial_windows and the reserved result reference",
            ));
        }
        let target = args
            .machine
            .take()
            .map(|machine| {
                self.select_machine(crate::network_operations::machine_selector(&machine)?)
                    .map(|info| info.machine_id)
            })
            .transpose()?
            .unwrap_or_else(|| self.machine_id.clone());
        let by_model = client.identity.kind == ClientKind::Mcp;
        if target == self.machine_id {
            let mut args = args.into_start(false);
            let folder = self
                .check_start(&mut args, client.agent.as_deref(), by_model, None)
                .await?;
            args.launch.folder = Some(folder);
            let origin = crate::operations::StartOrigin {
                sender: self.sender_of(client.agent.as_deref()),
                caller,
                by_model,
                from_window: None,
                colors: None,
            };
            return self.finish_start(args, origin, preflight).await;
        }
        let terminal = || facade_base::daemon::WindowRef {
            machine_id: target.clone(),
            window_id: facade_base::daemon::TERMINAL_WINDOW.to_string(),
        };
        let members = if let Some(window) = args.window.take() {
            if window.machine_id == self.machine_id {
                self.windows.check_member(&window)?;
            }
            vec![window]
        } else {
            match &caller {
                Caller::Ide { window } => vec![window.clone()],
                Caller::Agent { agent, .. } => self
                    .get_agent(&agent.agent_id)
                    .map_or_else(|| vec![terminal()], |parent| parent.info().windows),
                Caller::Terminal { .. } => vec![terminal()],
            }
        };
        args.initial_windows = Some(members);
        args.env.clear();
        if !preflight && matches!(caller, Caller::Agent { .. }) && args.prompt.is_some() {
            let reserved = self.messages.reserve_result()?;
            args.result_message_id = Some(reserved.message_id);
            args.result_message_machine_id = Some(reserved.machine_id);
        }
        let operation = if preflight {
            AgentCheckStart::NAME
        } else {
            AgentStart::NAME
        };
        let request_id = (!preflight).then(|| args.request_id.clone()).flatten();
        let forwarded = self.forwarded_call(client, operation, value_of(args.for_forwarding()))?;
        if cancel.is_requested() {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "the start was cancelled before forwarding",
            ));
        }
        let request = self.network.call(
            &target,
            caller,
            "call".to_string(),
            value_of(forwarded),
            None,
            request_id,
        );
        tokio::select! {
            biased;
            response = request => response,
            () = cancel.requested() => Err(self.forwarded_outcome_unknown(&target)),
        }
    }

    async fn accept_forwarded_start(
        self: &Arc<Self>,
        caller: &Caller,
        forwarded: ForwardCall,
        request_id: Option<String>,
        preflight: bool,
    ) -> Result<Value, ErrorBody> {
        let mut args: StartArgs = decode_arguments(forwarded.call.args)?;
        if args.initial_windows.as_ref().is_none_or(Vec::is_empty) {
            return Err(ErrorBody::invalid_argument(
                "the forwarded start is missing its verified member windows",
            ));
        }
        let owes_result =
            !preflight && matches!(caller, Caller::Agent { .. }) && args.prompt.is_some();
        if (owes_result
            && (args.result_message_machine_id.as_deref() != Some(caller.machine_id())
                || args.result_message_id.is_none()))
            || (!owes_result
                && (args.result_message_machine_id.is_some() || args.result_message_id.is_some()))
        {
            return Err(ErrorBody::invalid_argument(
                "the forwarded start's reserved result reference does not match the caller",
            ));
        }
        args.request_id = request_id;
        let origin = crate::operations::StartOrigin {
            caller: caller.clone(),
            sender: sender_from(caller, forwarded.from_name),
            by_model: forwarded.by_model,
            from_window: forwarded.from_window,
            colors: forwarded.window_colors,
        };
        self.finish_start(args.into_start(true), origin, preflight)
            .await
    }

    /// Takes the checked local folder, or resolves and checks a forwarded start on the
    /// running machine. An actual forwarded start calls this after claiming its request key.
    pub(crate) async fn prepare_start(
        &self,
        args: &mut AgentStartArgs,
        by_model: bool,
    ) -> Result<String, ErrorBody> {
        if args.initial_windows.is_none() {
            return Ok(args
                .launch
                .folder
                .take()
                .expect("the local folder was checked"));
        }
        let (environment, home) = self.login_environment().await?;
        args.env = environment;
        self.check_start(args, None, by_model, Some(home)).await
    }

    async fn finish_start(
        self: &Arc<Self>,
        args: AgentStartArgs,
        origin: crate::operations::StartOrigin,
        preflight: bool,
    ) -> Result<Value, ErrorBody> {
        if preflight {
            self.preflight_start(args, &origin).await?;
            Ok(value_of(EmptyResult {}))
        } else {
            Ok(value_of(self.start(args, origin).await?))
        }
    }

    /// Presents any returned agent from the client connection's machine.
    fn project_agent_response(
        &self,
        operation: &str,
        mut response: Value,
    ) -> Result<Value, ErrorBody> {
        let record = match operation {
            AgentStart::NAME | AgentInspect::NAME => response.get_mut("agent"),
            AgentAdopt::NAME | AgentRename::NAME | AgentResume::NAME => Some(&mut response),
            _ => None,
        };
        if let Some(record) = record {
            let mut agent = decode_arguments(std::mem::take(record))?;
            let machines = self
                .machine_table()
                .unwrap_or_else(|_| self.network.machines());
            self.project_agent(&mut agent, &machines);
            *record = value_of(agent);
        }
        Ok(response)
    }

    pub(crate) async fn run_forwarded_operation(
        self: &Arc<Self>,
        caller: Caller,
        call: ForwardCall,
        request_id: Option<String>,
        remaining: Option<Duration>,
        cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let operation = call.call.op.clone();
        let args = call.call.args.clone();
        let work = if operation == AgentSend::NAME {
            Work::Send
        } else {
            Work::Call
        };
        let Some(_active) = self.lifecycle.begin(work) else {
            return Err(ErrorBody::new(Reason::Unavailable, "Facade is exiting"));
        };
        let agent = |name: &str| self.resolve_agent(name, &Reach::from(&caller));
        let terminal = |name: &str| {
            let agent = agent(name)?;
            crate::operations::refuse_guest_terminal(&agent)?;
            Ok::<_, ErrorBody>(agent)
        };
        match operation.as_str() {
            AgentStart::NAME | AgentCheckStart::NAME => {
                self.accept_forwarded_start(
                    &caller,
                    call,
                    request_id,
                    operation == AgentCheckStart::NAME,
                )
                .await
            }
            AgentSend::NAME => {
                self.accept_forwarded_send(&caller, call, request_id, remaining, cancel)
                    .await
            }
            crate::delivery::VERIFY_HUMAN_REPLY => {
                self.verify_human_reply_at_store(&caller, decode_arguments(args)?)
            }
            WindowDeliver::NAME => Ok(value_of(WindowDelivery::from(
                self.deliver_forwarded_human(&caller, decode_arguments(args)?)?,
            ))),
            AgentDeliverStartResult::NAME => {
                self.deliver_forwarded_result(&caller, decode_arguments(args)?, remaining)
                    .await?;
                Ok(value_of(EmptyResult {}))
            }
            crate::presence::MACHINE_WINDOW_COLORS => {
                self.accept_window_colors(&caller, call.window_colors)
                    .await?;
                Ok(value_of(EmptyResult {}))
            }
            AgentAdopt::NAME => {
                let Caller::Ide { window } = &caller else {
                    return Err(ErrorBody::refused(
                        "only an editor window can adopt an agent",
                    ));
                };
                let AgentArgs { agent: target } = decode_arguments(args)?;
                Ok(value_of(self.adopt(&agent(&target)?, window, None).await?))
            }
            AgentInspect::NAME => {
                let AgentArgs { agent: target } = decode_arguments(args)?;
                Ok(value_of(self.inspect(&agent(&target)?).await?))
            }
            AgentResume::NAME => {
                let mut args: ResumeArgs = decode_arguments(args)?;
                check_size(args.cols, args.rows)?;
                let target = terminal(&args.agent)?;
                args.env = self.login_environment().await?.0;
                Ok(value_of(self.resume(&target, args).await?))
            }
            AgentStop::NAME => {
                let AgentArgs { agent: target } = decode_arguments(args)?;
                Ok(value_of(self.stop(&terminal(&target)?).await?))
            }
            AgentRemove::NAME => {
                let AgentArgs { agent: target } = decode_arguments(args)?;
                self.remove(&terminal(&target)?).await?;
                Ok(value_of(EmptyResult {}))
            }
            AgentRename::NAME => {
                let args: RenameArgs = decode_arguments(args)?;
                Ok(value_of(
                    self.rename(&agent(&args.agent)?, &args.name).await?,
                ))
            }
            AgentScreen::NAME => {
                let args: ScreenArgs = decode_arguments(args)?;
                let target = terminal(&args.agent)?;
                Ok(value_of(self.read_screen_of(&target, args.lines).await?))
            }
            AgentType::NAME => {
                let args: TypeArgs = decode_arguments(args)?;
                let target = terminal(&args.agent)?;
                self.type_into_agent(
                    &target,
                    args,
                    sender_from(&caller, call.from_name),
                    WhenFull::Refuse,
                    cancel,
                )
                .await?;
                Ok(value_of(EmptyResult {}))
            }
            AgentResize::NAME => {
                let args: ResizeArgs = decode_arguments(args)?;
                check_size(args.cols, args.rows)?;
                let target = terminal(&args.agent)?;
                let command = match &caller {
                    Caller::Ide { window } if target.info().windows.contains(window) => {
                        let colors = call
                            .window_colors
                            .as_ref()
                            .and_then(|colors| crate::presence::terminal_colors(colors).ok())
                            .unwrap_or_default();
                        AgentCommand::ResizeFromWindow {
                            cols: args.cols,
                            rows: args.rows,
                            colors: WindowColors {
                                window: window.clone(),
                                colors,
                            },
                        }
                    }
                    _ => AgentCommand::Resize(args.cols, args.rows),
                };
                if !target.send(command).await {
                    return Err(actor_stopped(&target));
                }
                Ok(value_of(EmptyResult {}))
            }
            _ => Err(ErrorBody::refused("this operation cannot be forwarded")),
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
        if session.part_of_session.is_none() {
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
            let _ = self.changes.send(AgentsUpdate::Updated {
                agent: Box::new(info),
            });
        }
    }

    /// Resolves the folder on this machine and checks the arguments of a start or preflight.
    /// Local facade-mcp starts take the acting agent's environment and resolve folders from its
    /// record. A forwarded start already has this machine's login environment.
    async fn check_start(
        &self,
        args: &mut AgentStartArgs,
        acting: Option<&str>,
        by_model: bool,
        login_folder: Option<String>,
    ) -> Result<String, ErrorBody> {
        if args.launch.program.is_empty() {
            return Err(ErrorBody::invalid_argument(
                "command must start with the CLI program",
            ));
        }
        let caller_folder = if by_model {
            acting
                .and_then(|id| self.get_agent(id))
                .map(|parent| parent.info().cwd)
        } else {
            None
        };
        let folder = start_folder(args.launch.folder.take(), caller_folder, login_folder)?;
        check_size(args.cols, args.rows)?;
        if by_model {
            if !args.launch.args.is_empty() {
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
        Ok(folder)
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
        let agent = self.terminal_agent(&args.agent, acting)?;
        self.read_screen_of(&agent, args.lines).await
    }

    async fn read_screen_of(
        &self,
        agent: &AgentHandle,
        lines: Option<u16>,
    ) -> Result<ScreenText, ErrorBody> {
        let lines = lines.unwrap_or(DEFAULT_SCREEN_LINES);
        if !(1..=MAX_SCREEN_LINES).contains(&lines) {
            let message = format!("lines must be between 1 and {MAX_SCREEN_LINES}");
            return Err(ErrorBody::invalid_argument(message));
        }
        let (reply, read) = oneshot::channel();
        let command = AgentCommand::ReadScreen {
            lines: lines as usize,
            reply,
        };
        if !agent.send(command).await {
            return Err(actor_stopped(agent));
        }
        let read = read.await.map_err(|_| actor_stopped(agent))?;
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
        let agent = self.terminal_agent(&args.agent, acting)?;
        self.type_into_agent(&agent, args, self.sender_of(acting), when_full, cancel)
            .await
    }

    async fn type_into_agent(
        &self,
        agent: &AgentHandle,
        args: TypeArgs,
        sender: Sender,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> Result<(), ErrorBody> {
        crate::gate_for_test("before-type-input");
        let TypeArgs {
            agent: _,
            raw,
            text,
            enter,
            keys,
        } = args;
        let (input, typed) = input_of(raw, text, enter, keys, sender)?;
        if input.most_bytes() > MAX_INPUT_BYTES {
            let message = format!(
                "agent.type accepts at most {} KiB of input as written, a paste counted with its \
                 brackets and Enter",
                MAX_INPUT_BYTES / 1024
            );
            return Err(ErrorBody::new(Reason::CapacityExceeded, message));
        }
        let wait = match when_full {
            WhenFull::Refuse => InputWait::Refuse,
            WhenFull::Wait => InputWait::UntilCancelled(cancel),
        };
        let handed = self.hand_input(agent, input, wait).await;
        let Some(typed) = typed else {
            return handed;
        };
        handed.map_err(|mut refused| {
            if matches!(refused.data.reason, Reason::Ended | Reason::Unavailable) {
                refused.message.push_str("; nothing was typed");
            }
            refused
        })?;
        typed.await.map_err(|_| actor_stopped(agent))?
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

    /// Identifies local callers before any RPC stream can be promoted to a machine session.
    fn agent_of_hello(&self, hello: &HelloParams, peer_pid: Option<u32>) -> Option<String> {
        self.agent_of_sessions(&hello.sessions)
            .or_else(|| {
                hello
                    .agent
                    .as_deref()
                    .map(records::normalize_agent_reference)
            })
            .or_else(|| {
                peer_pid.and_then(|pid| crate::blocking_in_place(|| self.agent_of_process(pid)))
            })
    }

    fn agent_of_process(&self, pid: u32) -> Option<String> {
        use facade_base::unix_process;

        if let Some(env) = unix_process::birth(pid).ok().flatten().and_then(|birth| {
            unix_process::environment(&facade_base::process::ProcessIdentity { pid, birth })
                .ok()
                .flatten()
        }) {
            let sessions: Vec<_> = facade_rules::SESSION_VARIABLES
                .iter()
                .filter_map(|(_, variables)| env.get(variables[0]).cloned())
                .collect();
            if let Some(agent) = self.agent_of_sessions(&sessions) {
                return Some(agent);
            }
            if let Some(id) = env
                .get("FACADE_AGENT")
                .map(|id| records::normalize_agent_reference(id))
                && self.get_agent(&id).is_some()
            {
                return Some(id);
            }
        }
        let ancestors = unix_process::ancestors(pid);
        self.agent_infos()
            .into_iter()
            .find(|agent| {
                agent.process == ProcessState::Running
                    && agent
                        .pid
                        .is_some_and(|owner| owner == pid || ancestors.contains(&owner))
            })
            .map(|agent| agent.agent_id)
    }
}

fn operation_names() -> Vec<String> {
    let mut names = daemon::operation_names();
    names.extend(facade_base::machine::operation_names());
    names
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

pub(crate) fn sender_from(caller: &Caller, from_name: Option<String>) -> Sender {
    match caller {
        Caller::Agent { agent, .. } => Sender {
            from: agent.agent_id.clone(),
            from_name,
        },
        _ => Sender::person(),
    }
}

pub(crate) fn check_size(cols: u16, rows: u16) -> Result<(), ErrorBody> {
    if cols < 2 || rows < 1 {
        let message = "terminal size must be at least 2 columns and 1 row";
        return Err(ErrorBody::invalid_argument(message));
    }
    Ok(())
}

fn start_folder(
    supplied: Option<String>,
    caller_folder: Option<String>,
    login_folder: Option<String>,
) -> Result<String, ErrorBody> {
    let folder = match (supplied, caller_folder) {
        (Some(folder), Some(caller)) if !folder.is_empty() && Path::new(&folder).is_relative() => {
            Path::new(&caller)
                .join(folder)
                .to_string_lossy()
                .into_owned()
        }
        (Some(folder), _) => folder,
        (None, caller) => caller.or(login_folder).unwrap_or_default(),
    };
    if !Path::new(&folder).is_absolute() {
        return Err(ErrorBody::invalid_argument(format!(
            "cwd must be an absolute path, not {folder}"
        )));
    }
    Ok(folder)
}

#[cfg(test)]
#[test]
fn start_folders_default_only_when_omitted() {
    let (caller, login) = if cfg!(windows) {
        (r"C:\caller", r"D:\login")
    } else {
        ("/caller", "/login")
    };
    let from_caller = |folder| start_folder(folder, Some(caller.into()), None);
    let on_remote = |folder| start_folder(folder, None, Some(login.into()));
    assert_eq!(from_caller(None).unwrap(), caller);
    assert_eq!(
        Path::new(&from_caller(Some("inside".into())).unwrap()),
        Path::new(caller).join("inside")
    );
    assert_eq!(on_remote(None).unwrap(), login);
    assert_eq!(on_remote(Some(caller.into())).unwrap(), caller);
    assert!(on_remote(Some("inside".into())).is_err());
    assert!(on_remote(Some(String::new())).is_err());
    assert!(from_caller(Some(String::new())).is_err());
    assert!(start_folder(None, None, None).is_err());
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
