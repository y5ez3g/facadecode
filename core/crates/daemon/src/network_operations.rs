//! Entry and destination operations for the machine network.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use facade_base::address::{
    AgentAddress, exact_machine_selector, parse_agent_address, parse_machine_selector,
};
use facade_base::daemon::{
    AgentAdopt, AgentInfo, AgentInspect, AgentRemove, AgentRename, AgentResize, AgentResume,
    AgentScreen, AgentSend, AgentSendArgs, AgentSendResult, AgentStop, AgentType, WatchParams,
};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{
    AgentList, AgentListResult, AgentRef, Caller, CliList, ExecutionOutcome, ForwardCall,
    LocationList, LocationListResult, MachineAdd, MachineIdentity, MachineInfo, MachineList,
    MachineListResult, MachineQueryArgs, MachineQueryStatus, MachineRemove, MachineRemoveArgs,
    MachineRename, MachineRenameArgs, MachineResponseState, MachineStateRow, Unavailable,
    WindowLocation,
};
use facade_base::operations::{CallParams, Operation};
use facade_base::process::ProcessState;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::{Instant, timeout_at};

use crate::agent::AgentHandle;
use crate::messages::Due;
use crate::network::{TargetReply, TargetRequest};
use crate::records::{self, Named, Reach};
use crate::server::{Client, Watch, WatchChange};
use crate::service::value_of;
use crate::{Cancel, Daemon};

const LIST_DEADLINE: Duration = Duration::from_secs(3);

#[derive(Default)]
struct AgentListing {
    agents: Vec<AgentInfo>,
    machines: Vec<MachineStateRow>,
}

impl From<AgentListing> for AgentListResult {
    fn from(list: AgentListing) -> Self {
        Self {
            agents: list.agents,
            machines: list.machines.into_iter().map(Into::into).collect(),
        }
    }
}

impl Daemon {
    /// Selects a target at the origin, then uses an ID for local and forwarded calls alike.
    pub(crate) async fn route_agent_operation(
        self: &Arc<Self>,
        client: &Client,
        caller: &Caller,
        operation: &str,
        args: &mut Value,
        mut cancel: Cancel,
    ) -> Result<Option<Value>, ErrorBody> {
        let field = match operation {
            AgentAdopt::NAME
            | AgentInspect::NAME
            | AgentRemove::NAME
            | AgentRename::NAME
            | AgentResize::NAME
            | AgentResume::NAME
            | AgentScreen::NAME
            | AgentStop::NAME
            | AgentType::NAME => "agent",
            AgentSend::NAME => {
                self.sending_agent(caller)?;
                "to"
            }
            _ => return Ok(None),
        };
        let name = args.get(field).and_then(Value::as_str).ok_or_else(|| {
            ErrorBody::invalid_argument(format!("{field} must be an agent reference"))
        })?;
        let deadline = (operation == AgentSend::NAME)
            .then(|| Due::within(args.get("time_left_ms").and_then(Value::as_u64)).instant);
        if field == "to"
            && ["#human", "human", "@human"]
                .iter()
                .any(|value| name.trim().eq_ignore_ascii_case(value))
        {
            return Ok(None);
        }
        let resolving = self.addressed_agent(caller, name, field == "to");
        let resolved = match deadline {
            Some(deadline) => timeout_at(deadline, resolving)
                .await
                .map_err(|_| send_before_forwarding())?,
            None => resolving.await,
        };
        let target = match resolved {
            Ok(target) => target,
            Err(error) => {
                if let Some(deadline) = deadline
                    && matches!(error.data.reason, Reason::Ended | Reason::NotFound)
                    && args.get("request_id").is_some()
                {
                    let send: AgentSendArgs = decode_arguments(args.clone())?;
                    if let Some(request_id) = send.request_id.as_deref()
                        && let Some(to) =
                            timeout_at(deadline, self.local_send_recipient(caller, &send.to))
                                .await
                                .map_err(|_| send_before_forwarding())?
                        && let Some(answer) = self
                            .replay_ended_local_send(
                                caller,
                                &to,
                                request_id,
                                send.reply_to.as_deref(),
                                cancel,
                            )
                            .await?
                    {
                        return Ok(Some(value_of(AgentSendResult::from(answer))));
                    }
                }
                return Err(error);
            }
        };
        args[field] = Value::String(target.agent_id);
        if target.machine_id == self.machine_id {
            if let Some(deadline) = deadline {
                let left = send_time_left(deadline)?;
                args["time_left_ms"] = Value::from(left.as_millis() as u64);
            }
            return Ok(None);
        }
        if operation == AgentResume::NAME
            && let Some(object) = args.as_object_mut()
        {
            object.remove("env");
        }
        let mut forwarded = self.forwarded_call(client, operation, std::mem::take(args))?;
        let (time_left, request_id) = if let Some(deadline) = deadline {
            timeout_at(
                deadline,
                self.verify_forwarded_reply(caller, &mut forwarded.call.args),
            )
            .await
            .map_err(|_| send_before_forwarding())??;
            (
                Some(send_time_left(deadline)?),
                request_id(&forwarded.call.args),
            )
        } else {
            (None, None)
        };
        if cancel.is_requested() {
            return Err(ErrorBody::new(
                Reason::Cancelled,
                "the call was cancelled before forwarding",
            ));
        }
        if time_left.is_some()
            && let Some(args) = forwarded.call.args.as_object_mut()
        {
            // A malformed budget still gets the AgentSendArgs diagnostic it would get at the receiver.
            if args
                .get("time_left_ms")
                .is_some_and(|value| !value.is_null() && !value.is_u64())
            {
                let _: AgentSendArgs = decode_arguments(Value::Object(args.clone()))?;
            }
            args.remove("time_left_ms");
        }
        let result = self.network.call(
            &target.machine_id,
            caller.clone(),
            "call".to_string(),
            value_of(forwarded),
            time_left,
            request_id,
        );
        tokio::select! {
            biased;
            result = result => result.map(Some),
            () = cancel.requested() => Err(self.forwarded_outcome_unknown(&target.machine_id)),
        }
    }

    async fn local_send_recipient(
        self: &Arc<Self>,
        caller: &Caller,
        name: &str,
    ) -> Option<AgentHandle> {
        match parse_agent_address(name).ok()? {
            AgentAddress::Local(_) => self
                .resolve_named(name, &Reach::from(caller), false)
                .ok()
                .flatten(),
            AgentAddress::Qualified { machine, .. } => {
                if self.select_machine(machine).ok()?.machine_id != self.machine_id {
                    return None;
                }
                let target = self.addressed_agent(caller, name, false).await.ok()?;
                if target.machine_id != self.machine_id {
                    return None;
                }
                self.get_agent(&target.agent_id)
            }
        }
    }

    pub(crate) fn forwarded_outcome_unknown(&self, machine_id: &str) -> ErrorBody {
        let mut error = ErrorBody::new(
            Reason::Unavailable,
            "the forwarded call was cancelled before its outcome was known",
        );
        error.data.unavailable = Some(Unavailable {
            execution: ExecutionOutcome::OutcomeUnknown,
            machine: self
                .network
                .machines()
                .into_iter()
                .find(|row| row.machine_id == machine_id)
                .map(|row| MachineIdentity {
                    machine_id: row.machine_id,
                    name: row.name,
                }),
            window: None,
            matches: Vec::new(),
            unanswered: Vec::new(),
        });
        error
    }

    pub(crate) fn forwarded_call(
        &self,
        client: &Client,
        operation: &str,
        args: Value,
    ) -> Result<ForwardCall, ErrorBody> {
        let origin = client
            .agent
            .as_deref()
            .and_then(|agent| self.get_agent(agent))
            .map(|agent| agent.info());
        let from_window = origin
            .as_ref()
            .and_then(|agent| match agent.windows.as_slice() {
                [window] => Some(self.windows.name(window)),
                _ => None,
            });
        let window_colors = if matches!(
            operation,
            AgentResize::NAME
                | facade_base::daemon::AgentStart::NAME
                | facade_base::machine::AgentCheckStart::NAME
        ) {
            client
                .window
                .as_ref()
                .map(|binding| self.windows.colors_for_binding(binding))
                .transpose()?
                .flatten()
        } else {
            None
        };
        Ok(ForwardCall {
            call: CallParams {
                op: operation.to_string(),
                args,
            },
            by_model: client.identity.kind == facade_base::daemon::ClientKind::Mcp,
            from_name: origin.map(|agent| agent.name),
            from_window,
            window_colors,
        })
    }

    /// Resolves a reference at its entry machine, before any operation is sent.
    pub(crate) async fn addressed_agent(
        self: &Arc<Self>,
        caller: &Caller,
        input: &str,
        running_only: bool,
    ) -> Result<AgentRef, ErrorBody> {
        let address = parse_agent_address(input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let (name, selector, literal) = match address {
            AgentAddress::Local(reference) => {
                if let Some(id) = numbered_agent(reference) {
                    return Ok(AgentRef {
                        machine_id: self.machine_id.clone(),
                        agent_id: id,
                    });
                }
                (reference, None, None)
            }
            AgentAddress::Qualified {
                agent,
                machine,
                literal_name,
            } => match self.select_machine(machine) {
                Ok(target) => {
                    if let Some(id) = numbered_agent(agent) {
                        if target.is_unreachable() {
                            return Err(unreachable_machine(target));
                        }
                        return Ok(AgentRef {
                            machine_id: target.machine_id,
                            agent_id: id,
                        });
                    }
                    (
                        agent,
                        Some(exact_machine_selector(&target.machine_id)),
                        literal_name,
                    )
                }
                Err(error) if error.data.reason == Reason::NotFound => {
                    let Some(literal) = literal_name else {
                        return Err(error);
                    };
                    (
                        literal,
                        Some(exact_machine_selector(&self.machine_id)),
                        None,
                    )
                }
                Err(error) => return Err(error),
            },
        };
        let qualified = selector.is_some();
        let result = self
            .list_network_agents(caller, MachineQueryArgs { machine: selector })
            .await?;
        if !qualified
            && matches!(result.machines.as_slice(), [local] if local.machine_id == self.machine_id)
        {
            return match records::resolve(
                &result.agents,
                input,
                &Reach::from(caller),
                running_only,
            )? {
                Named::Agent(agent_id) => Ok(AgentRef {
                    machine_id: self.machine_id.clone(),
                    agent_id,
                }),
                Named::Person => Err(ErrorBody::invalid_argument(format!(
                    "{} is the person, not an agent",
                    input.trim()
                ))),
            };
        }
        let mut matched: Vec<_> = result
            .agents
            .iter()
            .filter(|agent| {
                (!running_only || agent.process != ProcessState::Ended)
                    && agent.name == name.strip_prefix('@').unwrap_or(name)
            })
            .map(reference_of)
            .collect();
        if let Some(literal) = literal {
            let reach = Reach::from(caller);
            matched.extend(
                self.agent_infos()
                    .into_iter()
                    .filter(|agent| {
                        reach.reaches(agent)
                            && (!running_only || agent.process != ProcessState::Ended)
                            && agent.name == literal.strip_prefix('@').unwrap_or(literal)
                    })
                    .map(|agent| reference_of(&agent)),
            );
        }
        matched.sort();
        matched.dedup();
        let unanswered: Vec<_> = result
            .machines
            .into_iter()
            .filter(|row| row.state != MachineResponseState::Responded)
            .map(|row| MachineIdentity {
                machine_id: row.machine_id,
                name: row.name,
            })
            .collect();
        if !unanswered.is_empty() {
            let mut error = ErrorBody::new(
                Reason::Unavailable,
                format!("not every machine answered the search for {input}"),
            );
            error.data.unavailable = Some(Unavailable {
                execution: ExecutionOutcome::NotExecuted,
                machine: qualified.then(|| unanswered[0].clone()),
                window: None,
                matches: matched.iter().map(AgentRef::exact_address).collect(),
                unanswered,
            });
            return Err(error);
        }
        match matched.len() {
            0 => {
                let mut candidates = Vec::new();
                let mut listed = Vec::new();
                for agent in &result.agents {
                    let address = reference_of(agent).exact_address();
                    listed.push(format!(
                        "{address} {}",
                        facade_base::daemon::display_name(&agent.name)
                    ));
                    candidates.push(address);
                }
                let reachable = if listed.is_empty() {
                    "no agents are listed".to_string()
                } else {
                    format!("you can reach {}", listed.join(", "))
                };
                let mut error = ErrorBody::new(
                    Reason::NotFound,
                    format!("no agent {input}; nothing was done; {reachable}"),
                );
                error.data.candidates = candidates;
                Err(error)
            }
            1 => Ok(matched.remove(0)),
            _ => {
                let mut error = ErrorBody::new(
                    Reason::AmbiguousReference,
                    format!("{input} names several agents"),
                );
                error.data.candidates = matched.iter().map(AgentRef::exact_address).collect();
                Err(error)
            }
        }
    }

    pub(crate) async fn network_call(
        &self,
        target: &str,
        caller: Caller,
        operation: &str,
        args: Value,
        time_left: Option<Duration>,
        request_id: Option<String>,
    ) -> Result<Value, ErrorBody> {
        self.network
            .call(
                target,
                caller,
                "call".to_string(),
                machine_call(operation, args),
                time_left,
                request_id,
            )
            .await
    }

    pub(crate) async fn serve_target(self: &Arc<Self>, request: TargetRequest) {
        let TargetRequest {
            forward,
            cancelled,
            reply,
        } = request;
        let mut cancel = Cancel::of(cancelled);
        if forward.method == "watch" {
            let params = match decode_arguments::<WatchParams>(forward.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = reply.send(TargetReply::Call(Err(error)));
                    return;
                }
            };
            let viewer = crate::server::next_viewer();
            let Watch {
                snapshot,
                mut changes,
            } = match self
                .start_forwarded_watch(&forward.caller, params, viewer)
                .await
            {
                Ok(watch) => watch,
                Err(error) => {
                    let _ = reply.send(TargetReply::Call(Err(error)));
                    return;
                }
            };
            let (send, receive) = mpsc::channel(64);
            if reply
                .send(TargetReply::Watch {
                    snapshot,
                    changes: receive,
                })
                .is_ok()
            {
                let copy = async {
                    while let Some(change) = changes.recv().await {
                        let change = match change {
                            WatchChange::Change(value) => Ok(value),
                            WatchChange::Disconnect => {
                                Err(ErrorBody::new(Reason::Unavailable, "the watch fell behind"))
                            }
                        };
                        let ended = change.is_err();
                        if send.send(change).await.is_err() || ended {
                            break;
                        }
                    }
                };
                tokio::select! {
                    () = copy => {},
                    () = cancel.requested() => {},
                    () = send.closed() => {},
                }
            }
            self.end_viewer(viewer).await;
            return;
        }
        let outcome = async {
            if forward.method != "call" {
                return Err(ErrorBody::invalid_argument("unknown forwarded method"));
            }
            let call: ForwardCall = decode_arguments(forward.params)?;
            if let Some(result) = self
                .machine_operation(&forward.caller, &call.call.op, call.call.args.clone(), true)
                .await
            {
                return result;
            }
            let remaining = forward.time_left_ms.map(Duration::from_millis);
            self.run_forwarded_operation(
                forward.caller,
                call,
                forward.request_id,
                remaining,
                cancel,
            )
            .await
        }
        .await;
        let _ = reply.send(TargetReply::Call(outcome));
    }

    pub(crate) async fn machine_operation(
        self: &Arc<Self>,
        caller: &Caller,
        operation: &str,
        args: Value,
        forwarded: bool,
    ) -> Option<Result<Value, ErrorBody>> {
        if !matches!(
            operation,
            MachineList::NAME
                | MachineAdd::NAME
                | MachineRemove::NAME
                | MachineRename::NAME
                | AgentList::NAME
                | CliList::NAME
                | LocationList::NAME
        ) {
            return None;
        }
        let result: Result<Value, ErrorBody> = async {
            match operation {
                MachineList::NAME if !forwarded => Ok(value_of(MachineListResult {
                    machines: self.machine_table()?,
                })),
                MachineAdd::NAME if !forwarded => {
                    check_person(caller)?;
                    Ok(value_of(self.add_machine(decode_arguments(args)?).await?))
                }
                MachineRemove::NAME if !forwarded => {
                    check_person(caller)?;
                    let MachineRemoveArgs { machine } = decode_arguments(args)?;
                    let target = self.select_machine(machine_selector(&machine)?)?;
                    Ok(value_of(self.remove_machine(&target.machine_id).await?))
                }
                MachineRename::NAME => {
                    check_person(caller)?;
                    let request: MachineRenameArgs = decode_arguments(args)?;
                    if !forwarded {
                        let target = self.select_machine(machine_selector(&request.machine)?)?;
                        if target.machine_id != self.machine_id {
                            return self
                                .network_call(
                                    &target.machine_id,
                                    caller.clone(),
                                    operation,
                                    value_of(request),
                                    None,
                                    None,
                                )
                                .await;
                        }
                    }
                    Ok(value_of(self.rename_local_machine(request.name).await?))
                }
                AgentList::NAME if forwarded => Ok(value_of(AgentListResult::from(
                    self.local_agent_list(caller)?,
                ))),
                AgentList::NAME => Ok(value_of(AgentListResult::from(
                    self.list_network_agents(caller, decode_arguments(args)?)
                        .await?,
                ))),
                CliList::NAME | LocationList::NAME => {
                    let request: MachineQueryArgs = decode_arguments(args)?;
                    if !forwarded && let Some(machine) = request.machine.as_deref() {
                        let target = self.select_machine(machine_selector(machine)?)?;
                        if target.machine_id != self.machine_id {
                            return self
                                .network_call(
                                    &target.machine_id,
                                    caller.clone(),
                                    operation,
                                    value_of(MachineQueryArgs { machine: None }),
                                    None,
                                    None,
                                )
                                .await;
                        }
                    }
                    if operation == CliList::NAME {
                        Ok(value_of(self.login_clis().await?))
                    } else {
                        Ok(value_of(LocationListResult {
                            locations: self
                                .window_infos()
                                .into_iter()
                                .flat_map(|window| {
                                    let reference = facade_base::daemon::WindowRef {
                                        machine_id: window.machine_id,
                                        window_id: window.window_id,
                                    };
                                    window.locations.into_iter().map(move |location| {
                                        WindowLocation {
                                            window: reference.clone(),
                                            location,
                                        }
                                    })
                                })
                                .collect(),
                        }))
                    }
                }
                _ => Err(ErrorBody::refused(
                    "this machine operation needs a local connection",
                )),
            }
        }
        .await;
        Some(result)
    }

    fn local_agent_list(&self, caller: &Caller) -> Result<AgentListing, ErrorBody> {
        let reach = Reach::from(caller);
        let mut agents = self.agent_infos();
        agents.retain(|agent| reach.reaches(agent));
        let machines = self.machine_table()?;
        for info in &mut agents {
            self.project_agent(info, &machines);
        }
        let own = machines
            .iter()
            .find(|machine| machine.machine_id == self.machine_id)
            .expect("the machine table includes this machine");
        let mut row = MachineStateRow::from(own);
        row.observe(MachineResponseState::Responded, Some(SystemTime::now()));
        Ok(AgentListing {
            agents,
            machines: vec![row],
        })
    }

    async fn list_network_agents(
        self: &Arc<Self>,
        caller: &Caller,
        request: MachineQueryArgs,
    ) -> Result<AgentListing, ErrorBody> {
        let all_machines = self.machine_table()?;
        let targets = match request.machine {
            Some(machine) => vec![self.select_machine(machine_selector(&machine)?)?],
            None => all_machines.clone(),
        };
        let deadline = Instant::now() + LIST_DEADLINE;
        let mut queries = JoinSet::new();
        for target in targets {
            let daemon = self.clone();
            let caller = caller.clone();
            queries.spawn(async move {
                if target.machine_id == daemon.machine_id {
                    return daemon.local_agent_list(&caller);
                }
                let mut row = MachineStateRow::from(&target);
                let mut agents = Vec::new();
                if !row.unreachable {
                    let params = machine_call(
                        AgentList::NAME,
                        value_of(MachineQueryArgs { machine: None }),
                    );
                    match daemon
                        .network
                        .call_with_receipt(
                            &row.machine_id,
                            caller,
                            "call".to_string(),
                            params,
                            Some(deadline),
                            None,
                        )
                        .await
                    {
                        Ok((value, received_at)) => {
                            agents = observe_agent_reply(&mut row, value, received_at);
                        }
                        Err(failure) => {
                            let (state, received_at) = failure.observation();
                            row.observe(state, received_at);
                        }
                    }
                }
                Ok(AgentListing {
                    agents,
                    machines: vec![row],
                })
            });
        }
        let mut list = AgentListing::default();
        while let Some(result) = queries.join_next().await {
            let mut answered = result.map_err(ErrorBody::internal)??;
            list.agents.append(&mut answered.agents);
            list.machines.append(&mut answered.machines);
        }
        // Group copies of the same agent before sorting by the timestamps of the retained rows.
        list.agents.sort_by(|left: &AgentInfo, right| {
            (&left.machine_id, &left.agent_id).cmp(&(&right.machine_id, &right.agent_id))
        });
        list.agents.dedup_by(|left, right| {
            left.machine_id == right.machine_id && left.agent_id == right.agent_id
        });
        list.agents.sort_by(|left, right| {
            (&left.created_at, &left.machine_id)
                .cmp(&(&right.created_at, &right.machine_id))
                .then_with(|| {
                    records::agent_number(&left.agent_id)
                        .cmp(&records::agent_number(&right.agent_id))
                })
        });
        list.machines
            .sort_by(|left, right| left.machine_id.cmp(&right.machine_id));
        for agent in &mut list.agents {
            self.project_agent(agent, &all_machines);
        }
        Ok(list)
    }
}

fn machine_call(operation: &str, args: Value) -> Value {
    value_of(ForwardCall {
        call: CallParams {
            op: operation.to_string(),
            args,
        },
        by_model: false,
        from_name: None,
        from_window: None,
        window_colors: None,
    })
}

fn observe_agent_reply(
    row: &mut MachineStateRow,
    value: Value,
    received_at: SystemTime,
) -> Vec<AgentInfo> {
    row.observe(MachineResponseState::Failed, Some(received_at));
    let Ok(list) = decode_arguments::<AgentListResult>(value) else {
        return Vec::new();
    };
    let Some(answering) = list.machines.into_iter().find(|machine| {
        machine.machine_id == row.machine_id && machine.status == MachineQueryStatus::Answered
    }) else {
        return Vec::new();
    };
    row.name = answering.name;
    row.build = answering.build;
    row.observe(MachineResponseState::Responded, Some(received_at));
    list.agents
}

pub(crate) fn request_id(args: &Value) -> Option<String> {
    args.get("request_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn send_time_left(deadline: Instant) -> Result<Duration, ErrorBody> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.as_millis() == 0 {
        Err(send_before_forwarding())
    } else {
        Ok(remaining)
    }
}

fn send_before_forwarding() -> ErrorBody {
    let mut error = ErrorBody::new(
        Reason::Unavailable,
        "the send's delivery time expired before it was sent",
    );
    error.data.unavailable = Some(Unavailable {
        execution: ExecutionOutcome::NotExecuted,
        machine: None,
        window: None,
        matches: Vec::new(),
        unanswered: Vec::new(),
    });
    error
}

fn unreachable_machine(target: MachineInfo) -> ErrorBody {
    let mut error = ErrorBody::new(
        Reason::Unavailable,
        format!("{} is unreachable", target.name),
    );
    error.data.unavailable = Some(Unavailable {
        execution: ExecutionOutcome::NotExecuted,
        machine: Some(MachineIdentity {
            machine_id: target.machine_id,
            name: target.name,
        }),
        window: None,
        matches: Vec::new(),
        unanswered: Vec::new(),
    });
    error
}

fn reference_of(info: &AgentInfo) -> AgentRef {
    AgentRef {
        machine_id: info.machine_id.clone(),
        agent_id: info.agent_id.clone(),
    }
}

fn numbered_agent(reference: &str) -> Option<String> {
    let number = if reference.starts_with('@') {
        reference
            .rsplit_once(' ')
            .map(|(_, tail)| tail)
            .filter(|tail| tail.starts_with('#'))?
    } else {
        reference
    };
    let id = crate::records::normalize_agent_reference(number);
    let digits = id.strip_prefix('a')?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then_some(id)
}

pub(crate) fn machine_selector(
    text: &str,
) -> Result<facade_base::address::MachineSelector<'_>, ErrorBody> {
    parse_machine_selector(text).map_err(|error| ErrorBody::invalid_argument(error.to_string()))
}

fn check_person(caller: &Caller) -> Result<(), ErrorBody> {
    if matches!(caller, Caller::Agent { .. }) {
        return Err(ErrorBody::refused(
            "only a person can manage machine connections",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::UNIX_EPOCH;

    use facade_base::machine::MachineQueryResult;
    use facade_base::time::iso_time;
    use serde_json::json;

    use super::*;

    #[test]
    fn agent_list_replies_use_the_origin_receive_time() {
        let received_at = UNIX_EPOCH + Duration::from_secs(1_795_000_000);
        let peer = json!({
            "agents": [],
            "machines": [{
                "machine_id": "peer", "short_id": "peer", "name": "gpu",
                "build": "0.1.6+test", "status": "answered",
                "answered_at": "2000-01-01T00:00:00.000Z",
            }],
        });
        for (reply, state) in [
            (peer, MachineResponseState::Responded),
            (json!({}), MachineResponseState::Failed),
        ] {
            let mut row = MachineStateRow {
                machine_id: "peer".into(),
                name: "gpu".into(),
                build: Some("0.1.6+test".into()),
                state: MachineResponseState::Waiting,
                unreachable: false,
                responded_at: None,
            };
            assert!(observe_agent_reply(&mut row, reply, received_at).is_empty());
            let wire = MachineQueryResult::from(row);
            let canonical = MachineStateRow::from(wire);
            assert_eq!(canonical.state, state);
            assert_eq!(canonical.responded_at, Some(iso_time(received_at)));
        }
    }
}
