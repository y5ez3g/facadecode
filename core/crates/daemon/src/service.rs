//! Daemon operations after the server has authenticated the caller.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use facade_base::api_v1::daemon::Caller;
use facade_base::api_v1::{self, ApiVersion, Operation, daemon as wire};
use facade_base::model::agent::AgentCreator;
use facade_base::model::agent::AgentKind;
use facade_base::model::agent::AgentLabel;
use facade_base::model::agent::AgentState;
use facade_base::model::agent::CreatorKind;
use facade_base::model::agent::ManagedAgent;
use facade_base::model::machine::location_id;
use facade_base::model::message::Message;
use facade_base::model::message::StartOutcome;
use facade_base::model::terminal::DEFAULT_SCREEN_LINES;
use facade_base::model::terminal::MAX_SCREEN_LINES;
use facade_base::model::terminal::TerminalColors;
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::sockets::{ServerReader, ServerWriter};
use facade_base::{
    jsonrpc::decode_arguments,
    model::error::{ErrorBody, Reason},
};
use facade_base::{model::agent::AgentRef, model::machine::MachineQueryStatus};
use facade_base::{
    model::agent::ManagedAgentState,
    model::terminal::{InputInfo, InputState, ScreenBuffer},
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::sync::{oneshot, watch};

use crate::agent::{AgentCommand, AgentHandle, Input, MAX_INPUT_BYTES, Typing, TypingAnswer};
use crate::api;
use crate::delivery::InputWait;
use crate::lifecycle::{Work, WorkGuard};
use crate::machine_service::MachineStream;
use crate::network_operations::{
    LIST_DEADLINE, QueriedAgents, machine_query_result, machine_selector, require_person,
};
use crate::operations::StartOrigin;
use crate::records::{self, LookupCandidate, OperationTarget, Reach};
use crate::server::{self, Client, RelayLines, WhenFull};
use crate::store::CreationSource;
use crate::{Cancel, Daemon, Sender, blocking_in_place};

const INSPECT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Forwarded {
    pub(crate) from_name: Option<String>,
    pub(crate) start_result: Option<wire::MessageRef>,
    pub(crate) remaining: Option<Duration>,
}

enum StopRoute {
    Explicit,
    Live,
}

enum AgentAction {
    Inspect,
    Remove,
    Screen(Option<u16>),
    Type(wire::TerminalInput),
    Rename(String),
}

impl AgentAction {
    fn operation(&self) -> (&'static str, OperationTarget) {
        match self {
            Self::Inspect => (wire::AgentInspect::NAME, OperationTarget::Inspect),
            Self::Remove => (wire::AgentRemove::NAME, OperationTarget::Remove),
            Self::Screen(_) => (wire::AgentScreen::NAME, OperationTarget::ReadScreen),
            Self::Type(_) => (wire::AgentType::NAME, OperationTarget::Type),
            Self::Rename(_) => (wire::AgentRename::NAME, OperationTarget::Rename),
        }
    }

    fn call(self, reference: &AgentRef) -> wire::CallParams {
        let target = wire::AgentTarget::Reference(api::wire_ref(reference));
        match self {
            Self::Inspect => api::call::<wire::AgentInspect>(wire::AgentTargetArgs { target }),
            Self::Remove => api::call::<wire::AgentRemove>(wire::AgentTargetArgs { target }),
            Self::Screen(lines) => {
                api::call::<wire::AgentScreen>(wire::ScreenArgs { target, lines })
            }
            Self::Type(input) => {
                api::call::<wire::AgentType>(wire::AgentTypeArgs { target, input })
            }
            Self::Rename(name) => api::call::<wire::AgentRename>(wire::RenameArgs { target, name }),
        }
    }
}

impl server::Service for Daemon {
    type Hold = ();
    type Work = WorkGuard;
    type Machine = MachineStream;

    async fn machine_hello(
        self: &Arc<Self>,
        hello: wire::HelloParams,
        api_version: ApiVersion,
        _peer_pid: Option<u32>,
    ) -> Result<(wire::HelloResult, Self::Machine), api_v1::ErrorBody> {
        self.machine_hello_plan(hello, api_version)
    }

    async fn machine_connect(
        self: &Arc<Self>,
        client: &Client,
        args: wire::MachineConnectArgs,
    ) -> Result<(wire::MachineConnectResult, Self::Machine), api_v1::ErrorBody> {
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
        hello: wire::HelloParams,
        api_version: ApiVersion,
        _peer_pid: Option<u32>,
    ) -> Result<(wire::HelloResult, Client, ()), api_v1::ErrorBody> {
        let result = wire::HelloResult {
            api_version,
            build: facade_base::build_id(),
            machine_id: self.machine_id.clone(),
            pid: std::process::id(),
            agent_count: self.active_count() as u64,
            keeper: self.runs.keeper_info(),
            machine: None,
            topics: wire::topic_names(hello.kind),
            ops: wire::operation_names(hello.kind),
        };
        let client = Client {
            kind: hello.kind,
            api_version,
            verified_actor: None,
        };
        Ok((result, client, ()))
    }

    async fn call(
        self: &Arc<Self>,
        client: &Client,
        call: wire::DaemonCall,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> Result<Value, api_v1::ErrorBody> {
        let caller = self.local_caller(client).map_err(api::project_error)?;
        self.run_api_call(&caller, call, when_full, cancel, None)
            .await
    }

    async fn watch(
        self: &Arc<Self>,
        client: &Client,
        watch: wire::DaemonWatch,
        viewer: u64,
    ) -> Result<server::Watch, api_v1::ErrorBody> {
        let caller = self.local_caller(client).map_err(api::project_error)?;
        self.start_watch(&caller, watch, viewer, false)
            .await
            .map_err(api::project_error)
    }

    async fn watch_shell(
        self: &Arc<Self>,
        client: &Client,
        args: wire::AttachArgs,
        viewer: u64,
    ) -> Result<server::ShellWatch, api_v1::ErrorBody> {
        let caller = self.local_caller(client).map_err(api::project_error)?;
        self.start_shell_watch(&caller, args, viewer)
            .await
            .map_err(api::project_error)
    }

    async fn unwatch(self: &Arc<Self>, _client: &Client, _topic: &str, viewer: u64) {
        self.end_viewer(viewer).await;
    }

    async fn resize_viewer(
        self: &Arc<Self>,
        client: &Client,
        viewer: u64,
        size: api_v1::Size,
        colors: Option<wire::TerminalColors>,
    ) -> Result<(), api_v1::ErrorBody> {
        let Some(_active) = self.lifecycle.begin(Work::Call) else {
            return Err(api::error("unavailable", "Facade is exiting"));
        };
        let caller = self.local_caller(client).map_err(api::project_error)?;
        self.resize_active_viewer(&caller, viewer, size, colors)
            .await
            .map_err(api::project_error)
    }

    async fn relay(
        self: &Arc<Self>,
        params: Value,
        peer_pid: Option<u32>,
    ) -> Result<(Value, Arc<dyn RelayLines>), api_v1::ErrorBody> {
        self.accept_relay(params, peer_pid)
            .await
            .map_err(api::project_error)
    }

    fn closing(&self) -> watch::Receiver<Option<String>> {
        self.lifecycle.closing()
    }

    fn draining(&self) -> Option<api_v1::ErrorBody> {
        self.lifecycle.draining()
    }

    fn work(&self) -> Option<WorkGuard> {
        self.lifecycle.begin(Work::Connection)
    }
}

impl Daemon {
    pub(crate) async fn run_api_call(
        self: &Arc<Self>,
        caller: &Caller,
        call: wire::DaemonCall,
        when_full: WhenFull,
        cancel: Cancel,
        incoming: Option<Forwarded>,
    ) -> Result<Value, api_v1::ErrorBody> {
        let work = if matches!(call, wire::DaemonCall::AgentSend(_)) {
            Work::Send
        } else {
            Work::Call
        };
        let Some(_active) = self.lifecycle.begin(work) else {
            return Err(api::error("unavailable", "Facade is exiting"));
        };
        if let wire::DaemonCall::DaemonUpgrade(args) = call {
            if incoming.is_some() || !matches!(caller, Caller::Terminal { .. }) {
                return Err(api::error(
                    "refused",
                    "only a local terminal can upgrade the daemon",
                ));
            }
            return self
                .lifecycle
                .take_over(args, self.clone())
                .await
                .map(value_of);
        }
        self.dispatch_api_call(caller, call, when_full, cancel, incoming)
            .await
            .map_err(api::project_error)
    }

    async fn dispatch_api_call(
        self: &Arc<Self>,
        caller: &Caller,
        call: wire::DaemonCall,
        when_full: WhenFull,
        cancel: Cancel,
        incoming: Option<Forwarded>,
    ) -> Result<Value, ErrorBody> {
        use wire::DaemonCall::*;
        let forwarded = incoming.is_some();
        match call {
            AgentList(args) => {
                let scope = args.scope.unwrap_or(wire::Scope::Reachable);
                let result = self.list_scoped_agents(caller, scope).await?;
                Ok(value_of(result))
            }
            AgentStop(args) => {
                let result = if forwarded {
                    self.stop_forwarded(caller, args.selection, cancel).await?
                } else {
                    self.stop_selection(caller, args.selection, cancel).await?
                };
                Ok(value_of(result))
            }
            AgentResumeList(args) => self
                .api_resume_candidates(caller, args, forwarded)
                .await
                .map(value_of),
            AgentResume(args) => self.api_resume(caller, args, forwarded).await.map(value_of),
            AgentStart(args) => {
                if forwarded && matches!(args.scope, Some(wire::SingleMachineScope::Machine { .. }))
                {
                    return Err(ErrorBody::invalid_argument(
                        "a forwarded start needs local scope",
                    ));
                }
                self.start_request(caller, args, incoming, cancel).await
            }
            AgentSend(args) => self
                .route_send(caller, args, incoming, cancel)
                .await
                .map(value_of),
            AgentInspect(args) => {
                self.agent_operation(
                    caller,
                    AgentAction::Inspect,
                    args.target,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentRemove(args) => {
                self.agent_operation(
                    caller,
                    AgentAction::Remove,
                    args.target,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentRename(args) => {
                self.agent_operation(
                    caller,
                    AgentAction::Rename(args.name),
                    args.target,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentScreen(args) => {
                self.agent_operation(
                    caller,
                    AgentAction::Screen(args.lines),
                    args.target,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentType(args) => {
                self.agent_operation(
                    caller,
                    AgentAction::Type(args.input),
                    args.target,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            CliList(args) => self.cli_list_request(caller, args, forwarded).await,
            LocationList(args) => self.location_request(caller, args, forwarded).await,
            DaemonStatus(args) => self.status_request(caller, args, forwarded).await,
            MachineList(_) => {
                let disclose = matches!(caller, Caller::Terminal { .. } | Caller::Ide { .. });
                let machines: Vec<_> = self
                    .public_machines()?
                    .into_iter()
                    .map(|machine| api::project_machine(machine, disclose))
                    .collect();
                Ok(json!({ "machines": machines }))
            }
            MachineRemove(args) => {
                require_person(caller)?;
                Ok(value_of(self.remove_machine(args).await?))
            }
            MachineRename(args) => {
                require_person(caller)?;
                if !forwarded {
                    let target = self.select_machine(machine_selector(&args.machine)?)?;
                    if target.machine_id != self.machine_id {
                        self.ensure_machine_route(&target.machine_id, caller)
                            .await?;
                        return self
                            .network_call::<wire::MachineRename>(
                                &target.machine_id,
                                caller,
                                args,
                                None,
                            )
                            .await;
                    }
                }
                Ok(value_of(self.rename_local_machine(args.name).await?))
            }
            DaemonLog(args) => {
                require_person(caller)?;
                let lines = args.lines.unwrap_or(crate::lifecycle::MAX_LOG_LINES);
                Ok(value_of(wire::LogResult {
                    lines: blocking_in_place(|| crate::lifecycle::last_lines(lines))?,
                }))
            }
            InternalAgentRecords(args) if forwarded => {
                let records = self.local_agent_records(caller, args.active)?;
                let mut names = if args.active && matches!(caller, Caller::Terminal { .. }) {
                    let remaining = incoming
                        .and_then(|call| call.remaining)
                        .unwrap_or(LIST_DEADLINE)
                        .min(LIST_DEADLINE)
                        .saturating_sub(crate::messages::RESPONSE_GRACE);
                    self.session_names(&records, tokio::time::Instant::now() + remaining)
                        .await
                } else {
                    Default::default()
                };
                Ok(value_of(
                    records
                        .into_iter()
                        .map(|record| wire::AgentLookupCandidate {
                            session_name: names.remove(&record.info.reference),
                            agent: record.info,
                            has_rule: record.has_rule,
                        })
                        .collect::<Vec<_>>(),
                ))
            }
            InternalResumeRecords(_) if forwarded => {
                require_person(caller)?;
                let records = self
                    .local_resume_candidates(
                        &crate::resume::ResumeFilter {
                            all: true,
                            ..Default::default()
                        },
                        false,
                        matches!(caller, Caller::Terminal { .. }),
                    )
                    .await?;
                Ok(value_of(
                    records
                        .into_iter()
                        .map(crate::resume::ResumeCandidate::into_wire)
                        .collect::<Vec<_>>(),
                ))
            }
            InternalAttachResize(args) if forwarded => {
                self.resize_forwarded_viewer(caller, args).await?;
                Ok(json!({}))
            }
            InternalDeliverStartResult(args) if forwarded => {
                self.accept_start_result(caller, args, incoming.and_then(|call| call.remaining))
                    .await?;
                Ok(json!({}))
            }
            InternalDeliverWaitNotice(args) if forwarded => {
                self.deliver_wait_notice(
                    caller,
                    decode_arguments(value_of(args))?,
                    incoming.and_then(|call| call.remaining),
                )
                .await?;
                Ok(json!({}))
            }
            InternalCommandReply(args) if forwarded => {
                self.accept_command_reply(caller, args)?;
                Ok(value_of(api_v1::EmptyResult {}))
            }
            _ => Err(ErrorBody::refused(
                "the operation is unavailable on this connection",
            )),
        }
    }

    async fn stop_selection(
        self: &Arc<Self>,
        caller: &Caller,
        selection: wire::StopSelection,
        cancel: Cancel,
    ) -> Result<wire::BatchStopResult, ErrorBody> {
        let mut items = Vec::new();
        let machines = match selection {
            wire::StopSelection::Targets { targets } => {
                if targets.is_empty() {
                    return Err(ErrorBody::invalid_argument(
                        "give at least one agent to stop",
                    ));
                }
                let mut seen = BTreeSet::new();
                let mut selected = Vec::new();
                for target in targets {
                    let resolved = self
                        .addressed_agent(caller, target.clone(), OperationTarget::Stop)
                        .await;
                    let reference = match &resolved {
                        Ok(reference) => Some(reference.clone()),
                        Err(error) => {
                            single_error_agent(error).map(|agent| agent.reference.clone())
                        }
                    };
                    if reference.as_ref().is_none_or(|id| seen.insert(id.clone())) {
                        selected.push((target, reference, resolved));
                    }
                }
                for (target, reference, resolved) in selected {
                    let result = match resolved {
                        Ok(reference) => {
                            self.stop_selected(
                                caller,
                                reference,
                                StopRoute::Explicit,
                                cancel.clone(),
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    };
                    items.push(self.stop_item(target, reference, None, result));
                }
                Vec::new()
            }
            wire::StopSelection::All { scope } => {
                require_person(caller)?;
                let QueriedAgents {
                    mut agents,
                    machines,
                    ..
                } = self.query_scoped_agents(caller, scope).await?;
                agents.sort_by(|a, b| {
                    b.info
                        .started_at
                        .cmp(&a.info.started_at)
                        .then_with(|| a.info.reference.cmp(&b.info.reference))
                });
                for candidate in agents {
                    let agent = candidate.label();
                    let reference = agent.reference.clone();
                    let target = wire::AgentTarget::Reference(api::wire_ref(&reference));
                    if candidate.info.kind == AgentKind::Guest {
                        items.push(wire::StopItem {
                            target,
                            agent: Some(api::wire_label(agent)),
                            outcome: wire::StopOutcome::Skipped,
                        });
                        continue;
                    }
                    let result = self
                        .stop_selected(caller, reference.clone(), StopRoute::Live, cancel.clone())
                        .await;
                    items.push(self.stop_item(target, Some(reference), Some(agent), result));
                }
                machines
            }
        };
        Ok(wire::BatchStopResult {
            items,
            machines: (!machines.is_empty())
                .then(|| machines.into_iter().map(api::machine_query).collect()),
        })
    }

    async fn stop_forwarded(
        self: &Arc<Self>,
        caller: &Caller,
        selection: wire::StopSelection,
        cancel: Cancel,
    ) -> Result<wire::BatchStopResult, ErrorBody> {
        if !matches!(&selection, wire::StopSelection::Targets { targets }
            if targets.iter().all(|target| matches!(target, wire::AgentTarget::Reference(reference)
                if reference.machine_id == self.machine_id)))
        {
            return Err(ErrorBody::invalid_argument(
                "a forwarded stop needs exact references on this machine",
            ));
        }
        self.stop_selection(caller, selection, cancel).await
    }

    async fn stop_selected(
        self: &Arc<Self>,
        caller: &Caller,
        reference: AgentRef,
        route: StopRoute,
        cancel: Cancel,
    ) -> Result<(ProcessExit, AgentLabel), ErrorBody> {
        if cancel.is_requested() {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "the stop was cancelled before it ran",
            ));
        }
        if reference.machine_id != self.machine_id {
            let from_name = match route {
                StopRoute::Explicit => {
                    self.ensure_machine_route(&reference.machine_id, caller)
                        .await?;
                    sender_from(caller, self.caller_name(caller)).from_name
                }
                // A scoped stop uses the existing route without waking the peer.
                StopRoute::Live => None,
            };
            let target = wire::AgentTarget::Reference(api::wire_ref(&reference));
            let call = api::call::<wire::AgentStop>(wire::StopArgs {
                selection: wire::StopSelection::Targets {
                    targets: vec![target],
                },
            });
            let response = self
                .forward_call(&reference.machine_id, caller, call, from_name, None, None)
                .await?;
            let (exit, mut label) = api::stop_receipt(response)?;
            self.project_agent_label(&reference, &mut label)?;
            return Ok((exit, label));
        }
        let agent = self.local_target(caller, &reference, OperationTarget::Stop)?;
        let address = self.agent_address(&reference)?;
        let (result, label) = self
            .stop(&agent)
            .await
            .map_err(|error| self.with_agent_error(&agent, error))?;
        if result.already_ended {
            let mut error = ErrorBody::new(Reason::Ended, format!("{address} has already stopped"));
            error.data.agents.push(label);
            return Err(error);
        }
        Ok((result.exit, label))
    }

    fn stop_item(
        &self,
        target: wire::AgentTarget,
        reference: Option<AgentRef>,
        fallback: Option<AgentLabel>,
        result: Result<(ProcessExit, AgentLabel), ErrorBody>,
    ) -> wire::StopItem {
        let (agent, outcome) = match result {
            Ok((exit, label)) => (Some(label), wire::StopOutcome::Stopped { exit }),
            Err(error) => {
                let agent = single_error_agent(&error)
                    .filter(|agent| reference.as_ref().is_none_or(|id| id == &agent.reference))
                    .cloned()
                    .or(fallback);
                (
                    agent,
                    wire::StopOutcome::Failed {
                        error: api::project_error(error),
                    },
                )
            }
        };
        wire::StopItem {
            target,
            agent: agent.map(api::wire_label),
            outcome,
        }
    }

    async fn start_request(
        self: &Arc<Self>,
        caller: &Caller,
        mut args: wire::StartArgs,
        incoming: Option<Forwarded>,
        cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let by_model = matches!(caller, Caller::Agent { .. });
        if by_model && !args.args.is_empty() {
            return Err(ErrorBody::invalid_argument(
                "start_agent accepts a configured CLI without trailing arguments",
            ));
        }
        let machine = api::single_machine(args.scope.take());
        let name = incoming
            .as_ref()
            .and_then(|call| call.from_name.clone())
            .or_else(|| match caller {
                Caller::Agent { agent, .. } if agent.machine_id == self.machine_id => self
                    .get_agent(&agent.agent_id)
                    .map(|agent| agent.info().name),
                _ => None,
            });
        if incoming.is_none()
            && let Some(machine) = self.machine_for(machine.as_deref())?
            && machine != self.machine_id
        {
            self.ensure_machine_route(&machine, caller).await?;
            args.env = Some(Default::default());
            if args.folder_is_default {
                args.folder = None;
            }
            let start_result = if by_model && args.prompt.is_some() {
                Some(wire::MessageRef {
                    message_id: self.messages.reserve_result()?.message_id,
                    machine_id: self.machine_id.clone(),
                })
            } else {
                None
            };
            let call = api::call::<wire::AgentStart>(args);
            let result = self
                .forward_call(&machine, caller, call, name, start_result, None)
                .await?;
            let mut result: wire::StartResult = decode_arguments(result)?;
            result.agent.address =
                self.agent_address(&api::agent_ref(result.agent.reference.clone()))?;
            return Ok(value_of(result));
        }
        let start_result = incoming.as_ref().and_then(|call| call.start_result.clone());
        if let Some(result) = &start_result
            && (!by_model || args.prompt.is_none() || result.machine_id != caller.machine_id())
        {
            return Err(ErrorBody::invalid_argument(
                "the start result is not reserved on the creator's machine",
            ));
        }
        if incoming.is_some() {
            args.env = None;
            if args.folder_is_default {
                args.folder = None;
            }
        }
        let mut args = api::start_args(args, start_result);
        let caller_folder = if let Caller::Agent { agent, .. } = caller
            && agent.machine_id == self.machine_id
        {
            let handle = self
                .get_agent(&agent.agent_id)
                .ok_or_else(|| not_listed(&agent.agent_id))?;
            args.env = self.environment_of(&agent.agent_id).await?;
            (!handle.is_guest()).then(|| handle.info().cwd)
        } else {
            None
        };
        let folder = match (args.folder.take(), caller_folder) {
            (Some(folder), caller_folder) => Some(start_folder(Some(folder), caller_folder, None)?),
            (None, caller_folder) => caller_folder,
        };
        let (env, folder) = self.launch_context(folder, args.env).await?;
        args.folder = Some(folder);
        args.env = env;

        let origin = StartOrigin {
            caller: caller.clone(),
            sender: sender_from(caller, name),
            by_model,
        };
        // Once a start has a run, let it install even if its call is cancelled.
        if cancel.is_requested() {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "the start was cancelled before it ran",
            ));
        }
        Ok(value_of(
            self.public_start(self.start(args, origin).await?)?,
        ))
    }

    async fn agent_operation(
        self: &Arc<Self>,
        caller: &Caller,
        action: AgentAction,
        target: wire::AgentTarget,
        when_full: WhenFull,
        cancel: Cancel,
        incoming: Option<Forwarded>,
    ) -> Result<Value, ErrorBody> {
        let (operation, capability) = action.operation();
        let sequence = matches!(
            action,
            AgentAction::Type(wire::TerminalInput::Sequence { .. })
        );
        let reference = if incoming.is_some() {
            match target {
                wire::AgentTarget::Reference(reference)
                    if reference.machine_id == self.machine_id =>
                {
                    api::agent_ref(reference)
                }
                _ => {
                    return Err(ErrorBody::invalid_argument(
                        "a forwarded operation needs the exact local agent reference",
                    ));
                }
            }
        } else {
            self.addressed_agent(caller, target, capability).await?
        };
        if reference.machine_id != self.machine_id {
            self.ensure_machine_route(&reference.machine_id, caller)
                .await?;
            let name = sender_from(caller, self.caller_name(caller)).from_name;
            let result = self
                .forward_call(
                    &reference.machine_id,
                    caller,
                    action.call(&reference),
                    name,
                    None,
                    None,
                )
                .await
                .map_err(|mut error| {
                    if sequence && error.data.reason == Reason::PartialInput {
                        error
                            .data
                            .agents
                            .retain(|label| label.reference == reference);
                    }
                    error
                })?;
            return self.project_remote_response(operation, &reference, result);
        }
        let agent = self.local_target(caller, &reference, capability)?;
        let address = self.agent_address(&reference)?;
        let result: Result<Value, ErrorBody> = async {
            let result = match action {
                AgentAction::Inspect => value_of(
                    self.inspect(&agent, matches!(caller, Caller::Terminal { .. }))
                        .await?,
                ),
                AgentAction::Remove => {
                    self.remove(&agent).await?;
                    value_of(wire::RemoveResult {
                        reference: api::wire_ref(&reference),
                        address,
                    })
                }
                AgentAction::Screen(lines) => {
                    value_of(self.read_screen_of(&agent, lines, address).await?)
                }
                AgentAction::Type(input) => {
                    let label = if matches!(input, wire::TerminalInput::Raw { .. }) {
                        None
                    } else {
                        Some(self.agent_label(&agent)?)
                    };
                    let from_name = incoming
                        .and_then(|call| call.from_name)
                        .or_else(|| self.caller_name(caller));
                    self.type_into_agent(
                        &agent,
                        input,
                        sender_from(caller, from_name),
                        when_full,
                        cancel,
                    )
                    .await?;
                    value_of(wire::TypeResult {
                        agent: label.map(api::wire_label),
                    })
                }
                AgentAction::Rename(name) => {
                    let (renamed, previous_name) = self.rename(&agent, &name).await?;
                    value_of(wire::RenameResult {
                        agent: self.public_agent(renamed)?,
                        previous_name: Some(previous_name),
                    })
                }
            };
            Ok(result)
        }
        .await;
        result.map_err(|error| {
            if error.data.reason == Reason::PartialInput && !sequence {
                return error;
            }
            self.with_agent_error(&agent, error)
        })
    }

    pub(crate) fn local_target(
        &self,
        caller: &Caller,
        reference: &AgentRef,
        operation: OperationTarget,
    ) -> Result<AgentHandle, ErrorBody> {
        let Some(agent) = self.get_agent(&reference.agent_id) else {
            let address = self.agent_address(reference)?;
            let mut error =
                ErrorBody::new(Reason::NotFound, format!("no agent {address:?} was found"));
            if !matches!(caller, Caller::Agent { .. }) {
                error.data.record_removal =
                    blocking_in_place(|| self.store.removal_cause(&reference.agent_id))
                        .map_err(ErrorBody::internal)?
                        .map(|cause| match cause {
                            crate::store::RemovalCause::Expired => {
                                facade_base::model::error::AgentRemoval::Expired
                            }
                            crate::store::RemovalCause::Removed => {
                                facade_base::model::error::AgentRemoval::Removed
                            }
                        });
            }
            return Err(error);
        };
        let info = agent.info();
        let reach = Reach::from(caller);
        if !reach.reaches(&info) {
            return Err(reach.refusal(&reference.agent_id));
        }
        records::lookup(
            facade_base::address::selector::AgentKey::Number(&reference.agent_id),
            &reach,
            operation,
            &[self.lookup_candidate(&agent)?],
        )?;
        Ok(agent)
    }

    fn project_remote_response(
        &self,
        operation: &str,
        reference: &AgentRef,
        mut response: Value,
    ) -> Result<Value, ErrorBody> {
        if operation == wire::AgentScreen::NAME {
            let mut screen: wire::ScreenText = decode_arguments(response)?;
            if api::agent_ref(screen.reference.clone()) != *reference {
                return Err(ErrorBody::refused("the machine reported a different agent"));
            }
            screen.address = self.agent_address(reference)?;
            return Ok(value_of(screen));
        }
        if operation == wire::AgentRemove::NAME {
            response["address"] = value_of(self.agent_address(reference)?);
        }
        if matches!(
            operation,
            wire::AgentInspect::NAME | wire::AgentRename::NAME
        ) {
            response["agent"]["address"] = value_of(self.agent_address(reference)?);
        }
        if operation == wire::AgentInspect::NAME && response["started_by"]["kind"] == "agent" {
            let info: wire::AgentInfo = decode_arguments(response["agent"].clone())?;
            if let Some(creator) = info.creator {
                response["started_by"]["address"] =
                    value_of(self.agent_address(&api::agent_ref(creator))?);
            }
        }
        if operation == wire::AgentType::NAME
            && let Some(agent) = response.get_mut("agent").filter(|agent| !agent.is_null())
        {
            let mut label: AgentLabel = decode_arguments(agent.take())?;
            self.project_agent_label(reference, &mut label)?;
            *agent = value_of(api::wire_label(label));
        }
        Ok(response)
    }

    pub(crate) fn project_agent_label(
        &self,
        reference: &AgentRef,
        label: &mut AgentLabel,
    ) -> Result<(), ErrorBody> {
        if label.reference != *reference {
            return Err(ErrorBody::refused("the machine reported a different agent"));
        }
        label.address = self.agent_address(reference)?;
        Ok(())
    }

    pub(crate) fn project_remote_error(&self, mut error: ErrorBody) -> ErrorBody {
        let data = &mut *error.data;
        let mut projected = std::collections::BTreeMap::new();
        for label in &mut data.agents {
            if let Ok(address) = self.agent_address(&label.reference) {
                let original = std::mem::replace(&mut label.address, address);
                projected.insert(original, &label.address);
            }
        }
        for candidate in &mut data.candidates {
            if let Some(&address) = projected.get(candidate) {
                candidate.clone_from(address);
            }
        }
        if !data.machines.is_empty()
            && let Ok(visible) = self.machine_identities()
        {
            for row in &mut data.machines {
                crate::machine_service::project_machine_query(row, &visible);
            }
        }
        error
    }

    pub(crate) fn agent_label(&self, agent: &AgentHandle) -> Result<AgentLabel, ErrorBody> {
        let info = agent.info();
        let address = self.agent_address(&info.reference())?;
        Ok(agent_label_of(info, address, agent.rule().is_some()))
    }

    /// Adds evidence about an agent which the caller was already authorized to operate on.
    pub(crate) fn with_agent_error(&self, agent: &AgentHandle, mut error: ErrorBody) -> ErrorBody {
        if error.data.agents.is_empty()
            && let Ok(label) = self.agent_label(agent)
        {
            error.data.agents.push(label);
        }
        error
    }

    pub(crate) fn caller_name(&self, caller: &Caller) -> Option<String> {
        let Caller::Agent { agent, .. } = caller else {
            return None;
        };
        (agent.machine_id == self.machine_id)
            .then(|| self.get_agent(&agent.agent_id))
            .flatten()
            .map(|handle| handle.info().name)
    }

    pub(crate) fn lookup_candidate(
        &self,
        agent: &AgentHandle,
    ) -> Result<LookupCandidate, ErrorBody> {
        Ok(LookupCandidate {
            info: self.public_agent(agent.info())?,
            has_rule: agent.rule().is_some(),
        })
    }

    pub(crate) fn public_agent(&self, info: ManagedAgent) -> Result<wire::AgentInfo, ErrorBody> {
        let local = info.machine_id == self.machine_id;
        let fields = if local {
            blocking_in_place(|| self.store.launch_details(&info.agent_id))
                .map_err(ErrorBody::internal)?
        } else {
            crate::store::LaunchDetails::default()
        };
        let options = fields.options.unwrap_or_default();
        let address = self.agent_address(&info.reference())?;
        let title = local
            .then(|| self.get_agent(&info.agent_id))
            .flatten()
            .and_then(|agent| agent.title());
        let (kind, state) = if info.guest {
            (AgentKind::Guest, AgentState::Online)
        } else {
            (AgentKind::Managed, public_state(info.state))
        };
        let creator_kind = fields
            .source
            .or_else(|| info.creator.as_ref().map(|_| CreationSource::Agent))
            .map(|source| match source {
                CreationSource::Agent => CreatorKind::Agent,
                CreationSource::CommandLine => CreatorKind::CommandLine,
                CreationSource::VsCode => CreatorKind::VsCode,
            });
        Ok(wire::AgentInfo {
            reference: api::wire_ref(&info.reference()),
            address,
            kind,
            state,
            creator_kind,
            title,
            args: options.args,
            model: options.model,
            effort: options.effort,
            started_at: fields.started_at.unwrap_or_else(|| info.created_at.clone()),
            label: None,
            unreachable: false,
            name: info.name,
            cli: info.cli,
            cwd: info.cwd,
            pid: info.pid,
            process: info.process.into(),
            size: info
                .cols
                .zip(info.rows)
                .map(|(cols, rows)| api_v1::Size { cols, rows }),
            created_at: info.created_at,
            creator: info.creator.map(|agent_id| wire::AgentRef {
                machine_id: info
                    .creator_machine_id
                    .unwrap_or_else(|| info.machine_id.clone()),
                agent_id,
            }),
            root: wire::AgentRef {
                machine_id: info.root_machine_id.unwrap_or(info.machine_id),
                agent_id: info.root,
            },
            yolo: info.yolo,
            exit: info.exit,
            session: info.session,
            state_detail: info.state_detail,
            said: info.said,
            tools_state: info.tools_state,
            tools_reason: info.tools_reason,
        })
    }

    pub(crate) fn public_message(&self, message: Message) -> Result<wire::Message, ErrorBody> {
        let text = match &message.result {
            Some(result) => {
                crate::delivery::render_start_result(result, &self.machine_identities()?)?
            }
            None => message.text,
        };
        let result = message
            .result
            .map(|result| {
                self.public_agent(result.agent)
                    .map(|agent| wire::StartOutcome {
                        agent,
                        prompt: result.prompt,
                    })
            })
            .transpose()?;
        Ok(wire::Message {
            message_id: message.message_id,
            message_ref: message.message_ref.map(api::wire_message_ref),
            from: if message.from == "human" {
                "command_line".into()
            } else {
                message.from
            },
            from_name: message.from_name,
            from_machine_id: message.from_machine_id,
            to: message.to,
            text,
            reply_to: message.reply_to,
            reply_to_machine_id: message.reply_to_machine_id,
            call_id: message.call_id,
            result,
            at: message.at,
            delivery: message.delivery,
        })
    }

    fn public_start(
        &self,
        started: crate::operations::Started,
    ) -> Result<wire::StartResult, ErrorBody> {
        Ok(wire::StartResult {
            agent: self.public_agent(started.agent)?,
            prompt: started
                .prompt
                .map(|prompt| self.public_message(prompt))
                .transpose()?,
            result_message_id: started.result_message_id,
            result_message_machine_id: started.result_message_machine_id,
            repeated: started.repeated,
        })
    }

    fn started_by(&self, agent: &wire::AgentInfo) -> Result<Option<AgentCreator>, ErrorBody> {
        Ok(match agent.creator_kind {
            Some(CreatorKind::Agent) => agent
                .creator
                .as_ref()
                .map(|creator| {
                    self.agent_address(&api::agent_ref(creator.clone()))
                        .map(|address| AgentCreator::Agent { address })
                })
                .transpose()?,
            Some(CreatorKind::CommandLine) => Some(AgentCreator::CommandLine),
            Some(CreatorKind::VsCode) => Some(AgentCreator::VsCode),
            None => None,
        })
    }

    async fn inspect(
        self: &Arc<Self>,
        agent: &AgentHandle,
        include_session_name: bool,
    ) -> Result<wire::InspectResult, ErrorBody> {
        if agent.is_guest() {
            return Ok(wire::InspectResult {
                agent: self.public_agent(agent.info())?,
                started_by: None,
                rule: None,
                input: InputInfo {
                    state: InputState::Unknown,
                    evidence: "The guest runs in its own terminal.".into(),
                    mechanism: None,
                    hidden: None,
                },
                session_tracking: false,
                viewers: Vec::new(),
                attachments: Vec::new(),
                launch_command: None,
                session_name: None,
            });
        }
        let (reply, inspected) = oneshot::channel();
        if !agent.send(AgentCommand::Inspect { reply }).await {
            return Err(actor_stopped(agent));
        }
        let facts = tokio::time::timeout(INSPECT_TIMEOUT, inspected)
            .await
            .map_err(|_| {
                ErrorBody::new(Reason::Unavailable, "the agent did not answer inspection")
            })?
            .map_err(|_| actor_stopped(agent))?;
        let session_name = if include_session_name {
            tokio::time::timeout(LIST_DEADLINE, self.native_session_name(agent, &facts.agent))
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let mut info = self.public_agent(facts.agent)?;
        info.title = facts.title;
        Ok(wire::InspectResult {
            started_by: self.started_by(&info)?,
            agent: info,
            rule: agent.rule().map(str::to_owned),
            input: facts.input,
            session_tracking: facts.session_tracking,
            viewers: facts.viewers,
            attachments: facts.attachments,
            launch_command: facts.launch_command,
            session_name,
        })
    }

    async fn read_screen_of(
        &self,
        agent: &AgentHandle,
        lines: Option<u16>,
        address: String,
    ) -> Result<wire::ScreenText, ErrorBody> {
        let lines = lines.unwrap_or(DEFAULT_SCREEN_LINES);
        if !(1..=MAX_SCREEN_LINES).contains(&lines) {
            return Err(ErrorBody::invalid_argument(format!(
                "lines must be between 1 and {}",
                MAX_SCREEN_LINES
            )));
        }
        let (reply, read) = oneshot::channel();
        if !agent
            .send(AgentCommand::ReadScreen {
                lines: lines as usize,
                reply,
            })
            .await
        {
            return Err(actor_stopped(agent));
        }
        let (screen, info) = read.await.map_err(|_| actor_stopped(agent))?;
        let observed_at = info
            .exit
            .as_ref()
            .map_or_else(facade_base::time::iso_now, |exit| exit.at.clone());
        Ok(wire::ScreenText {
            reference: api::wire_ref(&info.reference()),
            address,
            name: Some(info.name),
            process: info.process.into(),
            observed_at,
            buffer: if screen.alternate {
                ScreenBuffer::Alternate
            } else {
                ScreenBuffer::Normal
            },
            text: screen.text,
            line_count: screen.lines as u32,
            older_lines: screen.older,
            trimmed: screen.trimmed,
        })
    }

    async fn type_into_agent(
        &self,
        agent: &AgentHandle,
        input: wire::TerminalInput,
        sender: Sender,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> Result<(), ErrorBody> {
        crate::gate_for_test("before-type-input");
        let typing_bytes = input.typing_bytes();
        let (input, typed) = input_of(input, sender)?;
        if typing_bytes.unwrap_or_else(|| input.most_bytes()) > MAX_INPUT_BYTES {
            return Err(ErrorBody::new(
                Reason::CapacityExceeded,
                format!(
                    "agent.type accepts at most {} KiB of input",
                    MAX_INPUT_BYTES / 1024
                ),
            ));
        }
        let wait = match when_full {
            WhenFull::Refuse => InputWait::Refuse,
            WhenFull::Wait => InputWait::UntilCancelled(cancel),
        };
        self.hand_input(agent, input, wait).await?;
        if let Some(typed) = typed {
            typed.await.map_err(|_| actor_stopped(agent))??;
        }
        Ok(())
    }

    async fn cli_list_request(
        &self,
        caller: &Caller,
        mut args: wire::CliListArgs,
        forwarded: bool,
    ) -> Result<Value, ErrorBody> {
        if !forwarded
            && let Some(id) = self.machine_for(api::single_machine(args.scope.take()).as_deref())?
            && id != self.machine_id
        {
            self.ensure_machine_route(&id, caller).await?;
            args.env = None;
            return self
                .network_call::<wire::CliList>(&id, caller, args, None)
                .await;
        }
        Ok(value_of(
            self.cli_list(args.folder, args.env.unwrap_or_default())
                .await?,
        ))
    }

    async fn location_request(
        &self,
        caller: &Caller,
        mut args: wire::LocationListArgs,
        forwarded: bool,
    ) -> Result<Value, ErrorBody> {
        if !forwarded
            && let Some(id) = self.machine_for(api::single_machine(args.scope.take()).as_deref())?
            && id != self.machine_id
        {
            self.ensure_machine_route(&id, caller).await?;
            return self
                .network_call::<wire::LocationList>(&id, caller, args, None)
                .await;
        }
        let recent = args.folders.is_empty();
        if recent {
            let (_, home) = self.login_environment().await?;
            let mut stored = self.agent_infos();
            stored.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            args.folders.push(home);
            for record in stored {
                if !args.folders.contains(&record.cwd) && Path::new(&record.cwd).is_dir() {
                    args.folders.push(record.cwd);
                }
            }
        }
        let mut locations = Vec::new();
        for folder in args.folders {
            let path = Path::new(&folder);
            crate::windows::preflight(path, None).await?;
            let catalog =
                crate::windows::read_locations(std::slice::from_ref(&folder), &Default::default())
                    .await;
            locations.extend(
                catalog
                    .locations()
                    .iter()
                    .map(|location| wire::LocationInfo {
                        location_id: location.location_id.clone(),
                        label: location.label.clone(),
                        path: location.path.clone(),
                        kind: location.kind,
                        source_folder: (!recent).then(|| folder.clone()),
                    }),
            );
        }
        Ok(value_of(wire::LocationListResult { locations }))
    }

    async fn status_request(
        &self,
        caller: &Caller,
        mut args: wire::StatusArgs,
        forwarded: bool,
    ) -> Result<Value, ErrorBody> {
        require_person(caller)?;
        if !forwarded
            && let Some(id) = self.machine_for(api::single_machine(args.scope.take()).as_deref())?
            && id != self.machine_id
        {
            self.ensure_machine_route(&id, caller).await?;
            return self
                .network_call::<wire::DaemonStatus>(&id, caller, wire::StatusArgs::default(), None)
                .await;
        }
        Ok(value_of(wire::StatusResult {
            home: facade_base::paths::facade_home()
                .map_err(ErrorBody::internal)?
                .display()
                .to_string(),
            settings_file: facade_base::settings::settings_file()
                .map_err(ErrorBody::internal)?
                .display()
                .to_string(),
            build: facade_base::build_id(),
            daemon_pid: std::process::id(),
            keeper_pid: self.runs.keeper_info().map(|keeper| keeper.pid),
            agent_count: self.active_count() as u64,
            machines: self
                .public_machines()?
                .into_iter()
                .filter(|machine| machine.state == wire::MachineState::Online)
                .map(|machine| {
                    api::machine_query(machine_query_result(machine, MachineQueryStatus::Answered))
                })
                .collect(),
        }))
    }

    pub(crate) fn active_count(&self) -> usize {
        self.agents()
            .iter()
            .filter(|agent| {
                let info = agent.info();
                !info.guest && info.process == ProcessState::Running
            })
            .count()
    }
}

pub(crate) fn stored_message(message: wire::Message) -> Message {
    let result = message.result.map(|result| {
        let agent = result.agent;
        let state = match agent.state {
            AgentState::Starting => ManagedAgentState::Starting,
            AgentState::Working => ManagedAgentState::Working,
            AgentState::WaitingForYou => ManagedAgentState::WaitingForYou,
            AgentState::JustDone => ManagedAgentState::JustDone,
            AgentState::Idle => ManagedAgentState::Idle,
            AgentState::Error => ManagedAgentState::Error,
            AgentState::Ended => ManagedAgentState::Ended,
            _ => ManagedAgentState::Unknown,
        };
        StartOutcome {
            prompt: result.prompt,
            agent: ManagedAgent {
                agent_id: agent.reference.agent_id,
                address: Some(agent.address),
                label: agent.label,
                unreachable: agent.unreachable,
                name: agent.name,
                cli: agent.cli,
                location_id: location_id(&agent.cwd),
                cwd: agent.cwd,
                machine_id: agent.reference.machine_id.clone(),
                windows: Vec::new(),
                location_source_window: None,
                pid: agent.pid,
                process: match agent.process {
                    wire::ProcessState::Running => ProcessState::Running,
                    wire::ProcessState::Ended => ProcessState::Ended,
                    wire::ProcessState::Unknown => ProcessState::Unknown,
                },
                cols: agent.size.map(|size| size.cols),
                rows: agent.size.map(|size| size.rows),
                created_at: agent.created_at,
                creator_machine_id: agent
                    .creator
                    .as_ref()
                    .filter(|creator| creator.machine_id != agent.reference.machine_id)
                    .map(|creator| creator.machine_id.clone()),
                creator: agent.creator.map(|creator| creator.agent_id),
                root_machine_id: (agent.root.machine_id != agent.reference.machine_id)
                    .then_some(agent.root.machine_id),
                root: agent.root.agent_id,
                yolo: agent.yolo,
                exit: agent.exit,
                session: agent.session,
                state,
                state_detail: agent.state_detail,
                said: agent.said,
                tools_state: agent.tools_state,
                tools_reason: agent.tools_reason,
                guest: agent.kind == AgentKind::Guest,
            },
        }
    });
    Message {
        message_id: message.message_id,
        message_ref: message.message_ref.map(api::message_ref),
        from: message.from,
        from_name: message.from_name,
        from_machine_id: message.from_machine_id,
        to: message.to,
        text: message.text,
        reply_to: message.reply_to,
        reply_to_machine_id: message.reply_to_machine_id,
        command_line_reply: false,
        from_window: None,
        call_id: message.call_id,
        result,
        at: message.at,
        delivery: message.delivery,
    }
}

pub(crate) fn terminal_colors(
    caller: &Caller,
    colors: Option<wire::TerminalColors>,
) -> Result<Option<facade_screen::TerminalColors>, ErrorBody> {
    match colors {
        Some(colors) if matches!(caller, Caller::Ide { .. }) => {
            crate::presence::terminal_colors(&TerminalColors {
                foreground: colors.foreground,
                background: colors.background,
                cursor: colors.cursor,
            })
            .map(Some)
        }
        Some(_) => Err(ErrorBody::refused("only an editor sets terminal colors")),
        None => Ok(None),
    }
}

fn single_error_agent(error: &ErrorBody) -> Option<&AgentLabel> {
    match error.data.agents.as_slice() {
        [agent] => Some(agent),
        _ => None,
    }
}

pub(crate) fn agent_label_of(info: ManagedAgent, address: String, has_rule: bool) -> AgentLabel {
    AgentLabel {
        reference: info.reference(),
        address,
        name: info.name,
        cli: info.cli,
        state: if info.guest {
            AgentState::Online
        } else {
            public_state(info.state)
        },
        resumable: has_rule && info.session.is_some(),
    }
}

fn public_state(state: ManagedAgentState) -> AgentState {
    match state {
        ManagedAgentState::Starting => AgentState::Starting,
        ManagedAgentState::Working => AgentState::Working,
        ManagedAgentState::WaitingForYou => AgentState::WaitingForYou,
        ManagedAgentState::JustDone => AgentState::JustDone,
        ManagedAgentState::Idle => AgentState::Idle,
        ManagedAgentState::Error => AgentState::Error,
        ManagedAgentState::Ended => AgentState::Ended,
        ManagedAgentState::Unknown => AgentState::Unknown,
        _ => AgentState::Unrecognized,
    }
}

pub(crate) fn sender_from(caller: &Caller, from_name: Option<String>) -> Sender {
    match caller {
        Caller::Agent { agent, .. } => Sender {
            from: agent.agent_id.clone(),
            from_name,
        },
        _ => Sender {
            from: "command_line".into(),
            from_name: None,
        },
    }
}

/// Validates an `agent.type` call and builds one unit of input. Typed calls answer once their
/// bytes have reached the terminal.
fn input_of(
    input: wire::TerminalInput,
    sender: Sender,
) -> Result<(Input, Option<TypingAnswer>), ErrorBody> {
    let typing = match input {
        wire::TerminalInput::Raw { raw } => {
            let bytes = facade_base::base64::decode(&raw)
                .map_err(|err| ErrorBody::invalid_argument(format!("raw is not base64: {err}")))?;
            return Ok((Input::Raw(bytes), None));
        }
        wire::TerminalInput::Text { text, enter } => Typing::text(text, enter, sender),
        wire::TerminalInput::Keys { keys } => Typing::keys(&keys),
        wire::TerminalInput::Sequence { steps } => Typing::sequence(steps),
    };
    let (typing, typed) = typing.map_err(ErrorBody::invalid_argument)?;
    Ok((Input::Typed(typing), Some(typed)))
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
    let message = format!("{id}, the agent this client acts for, is not listed");
    ErrorBody::new(Reason::NotFound, message)
}

pub(crate) fn actor_stopped(agent: &AgentHandle) -> ErrorBody {
    let message = format!("agent {} is unavailable: its actor stopped", agent.id());
    ErrorBody::new(Reason::Unavailable, message)
}

pub(crate) fn value_of(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol value must serialize")
}
