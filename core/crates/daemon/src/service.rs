//! Daemon operations after the server has authenticated the caller.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use facade_base::api_v1::{self, ApiVersion, daemon as wire};
use facade_base::daemon::{self, AgentState, InputInfo, InputState, ScreenBuffer};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{AgentRef, MachineQueryStatus};
use facade_base::operations::{CallParams, Operation};
use facade_base::process::ProcessState;
use facade_base::sockets::{ServerReader, ServerWriter};
use facade_base::v3::{self, AgentTarget, Caller, ForwardCall};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::sync::{oneshot, watch};

use crate::agent::{AgentCommand, AgentHandle, Input, MAX_INPUT_BYTES, Typing, TypingAnswer};
use crate::api;
use crate::delivery::InputWait;
use crate::lifecycle::{Work, WorkGuard};
use crate::machine_service::MachineStream;
use crate::network_operations::{machine_query_result, machine_selector, require_person};
use crate::operations::StartOrigin;
use crate::records::{self, LookupCandidate, OperationTarget, Reach};
use crate::server::{self, Client, RelayLines, WhenFull};
use crate::store::CreationSource;
use crate::{Cancel, Daemon, Sender, blocking_in_place};

const INSPECT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Forwarded {
    pub(crate) recipient: Option<AgentRef>,
    pub(crate) from_name: Option<String>,
    pub(crate) start_result: Option<wire::MessageRef>,
    pub(crate) remaining: Option<Duration>,
}

enum StopRoute {
    Explicit,
    Live,
}

impl From<&Caller> for Reach {
    fn from(caller: &Caller) -> Self {
        match caller {
            Caller::Agent {
                agent,
                root,
                yolo: false,
            } => Self::Tree {
                agent: agent.clone(),
                root: root.clone(),
            },
            _ => Self::All,
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
            keeper: self.runs.keeper_info().map(|keeper| wire::KeeperInfo {
                pid: keeper.pid,
                build: keeper.build,
            }),
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
        self.resize_active_viewer(
            &caller,
            viewer,
            v3::ScreenSize {
                cols: size.cols,
                rows: size.rows,
            },
            colors,
        )
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
        mut incoming: Option<Forwarded>,
    ) -> Result<Value, ErrorBody> {
        use wire::DaemonCall::*;
        let forwarded = incoming.is_some();
        match call {
            AgentList(args) => {
                let scope = args.scope.map_or(v3::Scope::Reachable, api::scope);
                let result = self.list_scoped_agents(caller, scope).await?;
                Ok(api::list_result(result))
            }
            AgentStop(args) => {
                let selection = api::stop_selection(args.selection);
                let result = if forwarded {
                    self.stop_forwarded(caller, selection, cancel).await?
                } else {
                    self.stop_selection(caller, selection, cancel).await?
                };
                Ok(api::stop_result(result))
            }
            AgentResumeList(args) => Ok(api::resume_list_result(
                self.api_resume_candidates(caller, args, forwarded).await?,
            )),
            AgentResume(args) => Ok(api::project_call_result(
                v3::AgentResume::NAME,
                value_of(self.api_resume(caller, args, forwarded).await?),
            )),
            AgentStart(args) => {
                if forwarded && matches!(args.scope, Some(wire::SingleMachineScope::Machine { .. }))
                {
                    return Err(ErrorBody::invalid_argument(
                        "a forwarded start needs local scope",
                    ));
                }
                Ok(api::project_call_result(
                    v3::AgentStart::NAME,
                    self.start_request(caller, api::start_args(args), incoming, cancel)
                        .await?,
                ))
            }
            AgentSend(args) => {
                let (mut args, recipient) = api::send_args(args)?;
                if let Some(call) = &mut incoming {
                    if let Some(recipient) = &recipient {
                        args.to = recipient.agent_id.clone();
                    }
                    call.recipient = recipient.clone();
                }
                self.route_send(caller, args, recipient, incoming, cancel)
                    .await
                    .map(|result| api::project_call_result(v3::AgentSend::NAME, result))
            }
            AgentInspect(args) => {
                self.api_agent_operation(
                    caller,
                    v3::AgentInspect::NAME,
                    args.target,
                    Value::Null,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentRemove(args) => {
                self.api_agent_operation(
                    caller,
                    v3::AgentRemove::NAME,
                    args.target,
                    Value::Null,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentRename(args) => {
                self.api_agent_operation(
                    caller,
                    v3::AgentRename::NAME,
                    args.target,
                    json!({"name": args.name}),
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentScreen(args) => {
                self.api_agent_operation(
                    caller,
                    v3::AgentScreen::NAME,
                    args.target,
                    json!({"lines": args.lines}),
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            AgentType(args) => {
                let fields = api::type_fields(args.input);
                self.api_agent_operation(
                    caller,
                    v3::AgentType::NAME,
                    args.target,
                    fields,
                    when_full,
                    cancel,
                    incoming,
                )
                .await
            }
            CliList(args) => {
                self.cli_list_request(
                    caller,
                    v3::CliListArgs {
                        machine: api::single_machine(args.scope),
                        folder: args.folder,
                        env: args.env.unwrap_or_default(),
                    },
                    forwarded,
                )
                .await
            }
            LocationList(args) => {
                self.location_request(
                    caller,
                    v3::LocationListArgs {
                        machine: api::single_machine(args.scope),
                        folders: args.folders,
                    },
                    forwarded,
                )
                .await
            }
            DaemonStatus(args) => self
                .status_request(
                    caller,
                    v3::StatusArgs {
                        machine: api::single_machine(args.scope),
                    },
                    forwarded,
                )
                .await
                .map(|result| api::project_call_result(v3::DaemonStatus::NAME, result)),
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
                            .network_call(
                                &target.machine_id,
                                caller.clone(),
                                v3::MachineRename::NAME,
                                value_of(args),
                                None,
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
                Ok(value_of(daemon::DaemonLogResult {
                    lines: blocking_in_place(|| crate::lifecycle::last_lines(lines))?,
                }))
            }
            InternalAgentRecords(args) if forwarded => {
                let records = self.local_agent_records(caller, args.active)?;
                Ok(value_of(
                    records
                        .into_iter()
                        .map(|record| {
                            let mut agent = value_of(record.info);
                            api::project_agent(&mut agent);
                            json!({ "agent": agent, "has_rule": record.has_rule })
                        })
                        .collect::<Vec<_>>(),
                ))
            }
            InternalResumeRecords(_) if forwarded => {
                require_person(caller)?;
                let records = self
                    .local_resume_candidates(
                        &v3::ResumeListArgs {
                            all: true,
                            ..Default::default()
                        },
                        false,
                    )
                    .await?;
                Ok(value_of(
                    records
                        .into_iter()
                        .map(api::resume_candidate)
                        .collect::<Vec<_>>(),
                ))
            }
            InternalAttachResize(args) if forwarded => {
                self.resize_forwarded_viewer(caller, args).await?;
                Ok(json!({}))
            }
            InternalDeliverStartResult(args) if forwarded => {
                let mut message = value_of(&args.message);
                api::receive_message(&mut message);
                self.accept_start_result(
                    caller,
                    v3::AgentDeliverStartResultArgs {
                        recipient: api::agent_ref(args.recipient),
                        message: decode_arguments(message)?,
                    },
                    incoming.and_then(|call| call.remaining),
                )
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
            _ => Err(ErrorBody::refused(
                "the operation is unavailable on this connection",
            )),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn api_agent_operation(
        self: &Arc<Self>,
        caller: &Caller,
        operation: &str,
        target: wire::AgentTarget,
        args: Value,
        when_full: WhenFull,
        cancel: Cancel,
        incoming: Option<Forwarded>,
    ) -> Result<Value, ErrorBody> {
        let target = api::target(target);
        self.agent_operation(caller, operation, target, args, when_full, cancel, incoming)
            .await
            .map(|result| api::project_call_result(operation, result))
    }

    async fn stop_selection(
        self: &Arc<Self>,
        caller: &Caller,
        selection: v3::StopSelection,
        cancel: Cancel,
    ) -> Result<v3::BatchStopResult, ErrorBody> {
        let mut items = Vec::new();
        let machines = match selection {
            v3::StopSelection::Targets { targets } => {
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
            v3::StopSelection::All { scope } => {
                require_person(caller)?;
                let (mut agents, machines) = self.query_scoped_agents(caller, scope).await?;
                agents.sort_by(|a, b| {
                    b.info
                        .started_at
                        .cmp(&a.info.started_at)
                        .then_with(|| a.info.reference().cmp(&b.info.reference()))
                });
                for candidate in agents {
                    let agent = candidate.label();
                    let reference = agent.reference.clone();
                    let target = AgentTarget::Reference {
                        reference: reference.clone(),
                    };
                    if candidate.info.kind == v3::AgentKind::Guest {
                        items.push(v3::StopItem {
                            target,
                            reference: Some(reference),
                            address: Some(agent.address.clone()),
                            agent: Some(agent),
                            outcome: v3::StopOutcome::Skipped,
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
        Ok(v3::BatchStopResult { items, machines })
    }

    async fn stop_forwarded(
        self: &Arc<Self>,
        caller: &Caller,
        selection: v3::StopSelection,
        cancel: Cancel,
    ) -> Result<v3::BatchStopResult, ErrorBody> {
        if !matches!(&selection, v3::StopSelection::Targets { targets }
            if targets.iter().all(|target| matches!(target, AgentTarget::Reference { reference }
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
    ) -> Result<v3::StopResult, ErrorBody> {
        if cancel.is_requested() {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "the stop was cancelled before it ran",
            ));
        }
        let target = AgentTarget::Reference {
            reference: reference.clone(),
        };
        let args = value_of(&target);
        let response =
            if matches!(route, StopRoute::Live) && reference.machine_id != self.machine_id {
                // A scoped stop uses the existing exact operation without a waking lookup.
                let result = self
                    .network_call(
                        &reference.machine_id,
                        caller.clone(),
                        v3::AgentStop::NAME,
                        args,
                        None,
                        None,
                    )
                    .await?;
                self.project_remote_response(v3::AgentStop::NAME, &reference, result)?
            } else {
                self.agent_operation(
                    caller,
                    v3::AgentStop::NAME,
                    target,
                    args,
                    WhenFull::Refuse,
                    cancel,
                    None,
                )
                .await?
            };
        let stopped: v3::StopResult = decode_arguments(response)?;
        if stopped.reference != reference {
            return Err(ErrorBody::refused("the machine reported a different agent"));
        }
        Ok(stopped)
    }

    fn stop_item(
        &self,
        target: AgentTarget,
        reference: Option<AgentRef>,
        fallback: Option<v3::AgentLabel>,
        result: Result<v3::StopResult, ErrorBody>,
    ) -> v3::StopItem {
        let (address, agent, outcome) = match result {
            Ok(stopped) => (
                Some(stopped.address),
                stopped.agent.or(fallback),
                v3::StopOutcome::Stopped { exit: stopped.exit },
            ),
            Err(error) => {
                let agent = single_error_agent(&error)
                    .filter(|agent| reference.as_ref().is_none_or(|id| id == &agent.reference))
                    .cloned()
                    .or(fallback);
                let address = agent
                    .as_ref()
                    .map(|agent| agent.address.clone())
                    .or_else(|| {
                        reference
                            .as_ref()
                            .and_then(|reference| self.agent_address(reference).ok())
                    });
                (address, agent, v3::StopOutcome::Failed { error })
            }
        };
        v3::StopItem {
            target,
            reference,
            address,
            agent,
            outcome,
        }
    }

    async fn start_request(
        self: &Arc<Self>,
        caller: &Caller,
        mut args: v3::StartArgs,
        incoming: Option<Forwarded>,
        cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let by_model = matches!(caller, Caller::Agent { .. });
        if by_model && !args.args.is_empty() {
            return Err(ErrorBody::invalid_argument(
                "start_agent accepts a configured CLI without trailing arguments",
            ));
        }
        if incoming.is_none()
            && (args.result_message_id.is_some() || args.result_message_machine_id.is_some())
        {
            return Err(ErrorBody::invalid_argument(
                "the daemon reserves start result numbers",
            ));
        }
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
            && let Some(machine) = self.machine_for(args.machine.as_deref())?
            && machine != self.machine_id
        {
            self.ensure_machine_route(&machine, caller).await?;
            args.machine = None;
            args.env.clear();
            if args.folder_is_default {
                args.folder = None;
            }
            if by_model && args.prompt.is_some() {
                args.result_message_id = Some(self.messages.reserve_result()?.message_id);
                args.result_message_machine_id = Some(self.machine_id.clone());
            }
            let request_id = args.request_id.clone();
            let forwarded = ForwardCall {
                call: CallParams {
                    op: v3::AgentStart::NAME.to_owned(),
                    args: value_of(args),
                },
                by_model,
                from_name: name,
                recipient: None,
            };
            let result = self
                .forward_call(&machine, caller.clone(), forwarded, None, request_id)
                .await?;
            let mut result: v3::StartResult = decode_arguments(result)?;
            result.agent.address = self.agent_address(&result.agent.reference())?;
            return Ok(value_of(result));
        }
        if let Some(incoming) = incoming.as_ref() {
            if let Some(result) = &incoming.start_result {
                if !by_model || args.prompt.is_none() || result.machine_id != caller.machine_id() {
                    return Err(ErrorBody::invalid_argument(
                        "the start result is not reserved on the creator's machine",
                    ));
                }
                args.result_message_id = Some(result.message_id.clone());
                args.result_message_machine_id = Some(result.machine_id.clone());
            }
            args.env.clear();
            if args.folder_is_default {
                args.folder = None;
            }
        }
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

    #[allow(clippy::too_many_arguments)]
    async fn agent_operation(
        self: &Arc<Self>,
        caller: &Caller,
        operation: &str,
        target: AgentTarget,
        mut args: Value,
        when_full: WhenFull,
        cancel: Cancel,
        incoming: Option<Forwarded>,
    ) -> Result<Value, ErrorBody> {
        let capability = match operation {
            v3::AgentInspect::NAME => OperationTarget::Inspect,
            v3::AgentStop::NAME => OperationTarget::Stop,
            v3::AgentRemove::NAME => OperationTarget::Remove,
            v3::AgentScreen::NAME => OperationTarget::ReadScreen,
            v3::AgentType::NAME => OperationTarget::Type,
            v3::AgentRename::NAME => OperationTarget::Rename,
            _ => {
                return Err(ErrorBody::invalid_argument(format!(
                    "unknown operation {operation}"
                )));
            }
        };
        let mut fields = api::object(args);
        let reference = if incoming.is_some() {
            match target {
                AgentTarget::Reference { reference } if reference.machine_id == self.machine_id => {
                    reference
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
        fields.insert("reference".into(), value_of(&reference));
        args = Value::Object(fields);
        if reference.machine_id != self.machine_id {
            self.ensure_machine_route(&reference.machine_id, caller)
                .await?;
            let name = sender_from(caller, self.caller_name(caller)).from_name;
            let call = ForwardCall {
                call: CallParams {
                    op: operation.to_owned(),
                    args,
                },
                by_model: matches!(caller, Caller::Agent { .. }),
                from_name: name,
                recipient: None,
            };
            let result = self
                .forward_call(&reference.machine_id, caller.clone(), call, None, None)
                .await?;
            return self.project_remote_response(operation, &reference, result);
        }
        let agent = self.local_target(caller, &reference, capability)?;
        let address = self.agent_address(&reference)?;
        let result = async {
            let result = match operation {
                v3::AgentInspect::NAME => value_of(self.inspect(&agent).await?),
                v3::AgentStop::NAME => {
                    let (result, label) = self.stop(&agent).await?;
                    if result.already_ended {
                        let mut error =
                            ErrorBody::new(Reason::Ended, format!("{address} has already stopped"));
                        error.data.agents.push(label);
                        return Err(error);
                    }
                    value_of(v3::StopResult {
                        exit: result.exit,
                        address,
                        reference,
                        agent: Some(label),
                        already_ended: false,
                    })
                }
                v3::AgentRemove::NAME => {
                    self.remove(&agent).await?;
                    value_of(v3::RemoveResult { reference, address })
                }
                v3::AgentScreen::NAME => {
                    #[derive(serde::Deserialize)]
                    struct ScreenLines {
                        lines: Option<u16>,
                    }
                    let request: ScreenLines = decode_arguments(args)?;
                    value_of(self.read_screen_of(&agent, request.lines, address).await?)
                }
                v3::AgentType::NAME => {
                    let request: v3::AgentTypeArgs = decode_arguments(args)?;
                    let label = if request.raw.is_none() {
                        Some(self.agent_label(&agent)?)
                    } else {
                        None
                    };
                    let from_name = incoming
                        .and_then(|call| call.from_name)
                        .or_else(|| self.caller_name(caller));
                    self.type_into_agent(
                        &agent,
                        request,
                        sender_from(caller, from_name),
                        when_full,
                        cancel,
                    )
                    .await?;
                    value_of(v3::TypeResult { agent: label })
                }
                v3::AgentRename::NAME => {
                    let request: v3::AgentRenameArgs = decode_arguments(args)?;
                    let (renamed, previous_name) = self.rename(&agent, &request.name).await?;
                    value_of(v3::RenameResult {
                        agent: self.public_agent(renamed)?,
                        previous_name: Some(previous_name),
                    })
                }
                _ => unreachable!(),
            };
            Ok(result)
        }
        .await;
        result.map_err(|error| self.with_agent_error(&agent, error))
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
                                facade_base::jsonrpc::AgentRemoval::Expired
                            }
                            crate::store::RemovalCause::Removed => {
                                facade_base::jsonrpc::AgentRemoval::Removed
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
            v3::address::AgentKey::Number(&reference.agent_id),
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
        if operation == v3::AgentScreen::NAME {
            let mut screen: wire::ScreenText = decode_arguments(response)?;
            if api::agent_ref(screen.reference.clone()) != *reference {
                return Err(ErrorBody::refused("the machine reported a different agent"));
            }
            screen.address = self.agent_address(reference)?;
            return Ok(value_of(screen));
        }
        if matches!(
            operation,
            v3::AgentStop::NAME | v3::AgentRemove::NAME | v3::AgentRename::NAME
        ) {
            response["address"] = value_of(self.agent_address(reference)?);
        }
        if operation == v3::AgentInspect::NAME {
            response["agent"]["address"] = value_of(self.agent_address(reference)?);
            if response["started_by"]["kind"] == "agent" {
                let info: v3::AgentInfo = decode_arguments(response["agent"].clone())?;
                if let Some(agent_id) = info.creator {
                    let creator = AgentRef {
                        agent_id,
                        machine_id: info.creator_machine_id.unwrap_or(info.machine_id),
                    };
                    response["started_by"]["address"] = value_of(self.agent_address(&creator)?);
                }
            }
        }
        if matches!(operation, v3::AgentStop::NAME | v3::AgentType::NAME)
            && let Some(agent) = response.get_mut("agent").filter(|agent| !agent.is_null())
        {
            let mut label: v3::AgentLabel = decode_arguments(agent.take())?;
            self.project_agent_label(reference, &mut label)?;
            *agent = value_of(label);
        }
        Ok(response)
    }

    pub(crate) fn project_agent_label(
        &self,
        reference: &AgentRef,
        label: &mut v3::AgentLabel,
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

    pub(crate) fn agent_label(&self, agent: &AgentHandle) -> Result<v3::AgentLabel, ErrorBody> {
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

    pub(crate) fn public_agent(&self, info: daemon::AgentInfo) -> Result<v3::AgentInfo, ErrorBody> {
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
            (v3::AgentKind::Guest, v3::AgentState::Online)
        } else {
            (v3::AgentKind::Managed, public_state(info.state))
        };
        let creator_kind = fields
            .source
            .or_else(|| info.creator.as_ref().map(|_| CreationSource::Agent))
            .map(|source| match source {
                CreationSource::Agent => v3::CreatorKind::Agent,
                CreationSource::CommandLine => v3::CreatorKind::CommandLine,
                CreationSource::VsCode => v3::CreatorKind::VsCode,
            });
        Ok(v3::AgentInfo {
            address,
            kind,
            state,
            creator_kind,
            title,
            args: options.args,
            model: options.model,
            effort: options.effort,
            started_at: fields.started_at.unwrap_or_else(|| info.created_at.clone()),
            agent_id: info.agent_id,
            label: None,
            unreachable: false,
            name: info.name,
            cli: info.cli,
            cwd: info.cwd,
            machine_id: info.machine_id,
            pid: info.pid,
            process: info.process,
            cols: info.cols,
            rows: info.rows,
            created_at: info.created_at,
            creator: info.creator,
            creator_machine_id: info.creator_machine_id,
            root: info.root,
            root_machine_id: info.root_machine_id,
            yolo: info.yolo,
            exit: info.exit,
            session: info.session,
            state_detail: info.state_detail,
            said: info.said,
            tools_state: info.tools_state,
            tools_reason: info.tools_reason,
        })
    }

    pub(crate) fn public_message(
        &self,
        message: daemon::Message,
    ) -> Result<v3::Message, ErrorBody> {
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
                    .map(|agent| v3::StartOutcome {
                        agent,
                        prompt: result.prompt,
                    })
            })
            .transpose()?;
        Ok(v3::Message {
            message_id: message.message_id,
            message_ref: message.message_ref,
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
        started: daemon::AgentStartResult,
    ) -> Result<v3::StartResult, ErrorBody> {
        Ok(v3::StartResult {
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

    fn started_by(&self, agent: &v3::AgentInfo) -> Result<Option<v3::AgentCreator>, ErrorBody> {
        Ok(match agent.creator_kind {
            Some(v3::CreatorKind::Agent) => agent
                .creator
                .as_ref()
                .map(|agent_id| {
                    let reference = AgentRef {
                        machine_id: agent
                            .creator_machine_id
                            .clone()
                            .unwrap_or_else(|| agent.machine_id.clone()),
                        agent_id: agent_id.clone(),
                    };
                    self.agent_address(&reference)
                        .map(|address| v3::AgentCreator::Agent { address })
                })
                .transpose()?,
            Some(v3::CreatorKind::CommandLine) => Some(v3::AgentCreator::CommandLine),
            Some(v3::CreatorKind::VsCode) => Some(v3::AgentCreator::VsCode),
            None => None,
        })
    }

    async fn inspect(&self, agent: &AgentHandle) -> Result<v3::AgentInspectResult, ErrorBody> {
        if agent.is_guest() {
            return Ok(v3::AgentInspectResult {
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
        let mut info = self.public_agent(facts.agent)?;
        info.title = facts.title;
        Ok(v3::AgentInspectResult {
            started_by: self.started_by(&info)?,
            agent: info,
            rule: agent.rule().map(str::to_owned),
            input: facts.input,
            session_tracking: facts.session_tracking,
            viewers: facts.viewers,
            attachments: facts.attachments,
            launch_command: facts.launch_command,
        })
    }

    async fn read_screen_of(
        &self,
        agent: &AgentHandle,
        lines: Option<u16>,
        address: String,
    ) -> Result<wire::ScreenText, ErrorBody> {
        let lines = lines.unwrap_or(daemon::DEFAULT_SCREEN_LINES);
        if !(1..=daemon::MAX_SCREEN_LINES).contains(&lines) {
            return Err(ErrorBody::invalid_argument(format!(
                "lines must be between 1 and {}",
                daemon::MAX_SCREEN_LINES
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
        args: v3::AgentTypeArgs,
        sender: Sender,
        when_full: WhenFull,
        cancel: Cancel,
    ) -> Result<(), ErrorBody> {
        crate::gate_for_test("before-type-input");
        let (input, typed) = input_of(args.raw, args.text, args.enter, args.keys, sender)?;
        if input.most_bytes() > MAX_INPUT_BYTES {
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
        mut args: v3::CliListArgs,
        forwarded: bool,
    ) -> Result<Value, ErrorBody> {
        if !forwarded
            && let Some(id) = self.machine_for(args.machine.as_deref())?
            && id != self.machine_id
        {
            self.ensure_machine_route(&id, caller).await?;
            args.machine = None;
            args.env.clear();
            return self
                .network_call(
                    &id,
                    caller.clone(),
                    v3::CliList::NAME,
                    value_of(args),
                    None,
                    None,
                )
                .await;
        }
        Ok(value_of(self.cli_list(args.folder, args.env).await?))
    }

    async fn location_request(
        &self,
        caller: &Caller,
        mut args: v3::LocationListArgs,
        forwarded: bool,
    ) -> Result<Value, ErrorBody> {
        if !forwarded
            && let Some(id) = self.machine_for(args.machine.as_deref())?
            && id != self.machine_id
        {
            self.ensure_machine_route(&id, caller).await?;
            args.machine = None;
            return self
                .network_call(
                    &id,
                    caller.clone(),
                    v3::LocationList::NAME,
                    value_of(args),
                    None,
                    None,
                )
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
            crate::windows::locations::preflight(path, None).await?;
            let catalog =
                crate::windows::locations::read(std::slice::from_ref(&folder), &Default::default())
                    .await;
            locations.extend(catalog.locations().iter().map(|location| v3::LocationInfo {
                location_id: location.location_id.clone(),
                label: location.label.clone(),
                path: location.path.clone(),
                kind: location.kind,
                source_folder: (!recent).then(|| folder.clone()),
            }));
        }
        Ok(value_of(v3::LocationListResult { locations }))
    }

    async fn status_request(
        &self,
        caller: &Caller,
        args: v3::StatusArgs,
        forwarded: bool,
    ) -> Result<Value, ErrorBody> {
        require_person(caller)?;
        if !forwarded
            && let Some(id) = self.machine_for(args.machine.as_deref())?
            && id != self.machine_id
        {
            self.ensure_machine_route(&id, caller).await?;
            return self
                .network_call(
                    &id,
                    caller.clone(),
                    v3::DaemonStatus::NAME,
                    value_of(v3::StatusArgs::default()),
                    None,
                    None,
                )
                .await;
        }
        Ok(value_of(v3::StatusResult {
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
            agents: self.active_count(),
            machines: self
                .public_machines()?
                .into_iter()
                .filter(|machine| machine.state == v3::MachineState::Online)
                .map(|machine| machine_query_result(machine, MachineQueryStatus::Answered))
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

pub(crate) fn stored_message(message: v3::Message) -> daemon::Message {
    let result = message.result.map(|result| {
        let agent = result.agent;
        let state = match agent.state {
            v3::AgentState::Starting => AgentState::Starting,
            v3::AgentState::Working => AgentState::Working,
            v3::AgentState::WaitingForYou => AgentState::WaitingForYou,
            v3::AgentState::JustDone => AgentState::JustDone,
            v3::AgentState::Idle => AgentState::Idle,
            v3::AgentState::Error => AgentState::Error,
            v3::AgentState::Ended => AgentState::Ended,
            _ => AgentState::Unknown,
        };
        daemon::StartOutcome {
            prompt: result.prompt,
            agent: daemon::AgentInfo {
                agent_id: agent.agent_id,
                address: Some(agent.address),
                label: agent.label,
                unreachable: agent.unreachable,
                name: agent.name,
                cli: agent.cli,
                location_id: daemon::location_id(&agent.cwd),
                cwd: agent.cwd,
                machine_id: agent.machine_id,
                windows: Vec::new(),
                location_source_window: None,
                pid: agent.pid,
                process: agent.process,
                cols: agent.cols,
                rows: agent.rows,
                created_at: agent.created_at,
                creator: agent.creator,
                creator_machine_id: agent.creator_machine_id,
                root: agent.root,
                root_machine_id: agent.root_machine_id,
                yolo: agent.yolo,
                exit: agent.exit,
                session: agent.session,
                state,
                state_detail: agent.state_detail,
                said: agent.said,
                tools_state: agent.tools_state,
                tools_reason: agent.tools_reason,
                guest: agent.kind == v3::AgentKind::Guest,
            },
        }
    });
    daemon::Message {
        message_id: message.message_id,
        message_ref: message.message_ref,
        from: message.from,
        from_name: message.from_name,
        from_machine_id: message.from_machine_id,
        to: message.to,
        text: message.text,
        reply_to: message.reply_to,
        reply_to_machine_id: message.reply_to_machine_id,
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
            crate::presence::terminal_colors(&v3::TerminalColors {
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

fn single_error_agent(error: &ErrorBody) -> Option<&v3::AgentLabel> {
    match error.data.agents.as_slice() {
        [agent] => Some(agent),
        _ => None,
    }
}

pub(crate) fn agent_label_of(
    info: daemon::AgentInfo,
    address: String,
    has_rule: bool,
) -> v3::AgentLabel {
    v3::AgentLabel {
        reference: info.reference(),
        address,
        name: info.name,
        cli: info.cli,
        state: if info.guest {
            v3::AgentState::Online
        } else {
            public_state(info.state)
        },
        resumable: has_rule && info.session.is_some(),
    }
}

fn public_state(state: AgentState) -> v3::AgentState {
    match state {
        AgentState::Starting => v3::AgentState::Starting,
        AgentState::Working => v3::AgentState::Working,
        AgentState::WaitingForYou => v3::AgentState::WaitingForYou,
        AgentState::JustDone => v3::AgentState::JustDone,
        AgentState::Idle => v3::AgentState::Idle,
        AgentState::Error => v3::AgentState::Error,
        AgentState::Ended => v3::AgentState::Ended,
        AgentState::Unknown => v3::AgentState::Unknown,
        _ => v3::AgentState::Unrecognized,
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
