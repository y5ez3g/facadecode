//! Resolves targets in the caller's machine view and forwards only exact references.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use facade_base::daemon::{WatchParams, WindowRef};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{AgentRef, MachineIdentity, MachineQueryArgs, MachineQueryStatus};
use facade_base::operations::{CallParams, Operation, Topic};
use facade_base::v3::address::{
    AgentAddress, AgentKey, parse_agent_address, parse_machine_selector,
};
use facade_base::v3::{self, AgentTarget, Caller, ForwardCall, MachineState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::lifecycle::Work;
use crate::machine_service::{machine_address_part, offline_machine, project_machine_query};
use crate::network::{RequestFailure, TargetReply, TargetRequest, V3TargetRequest};
use crate::records::{self, LookupCandidate, OperationTarget, Reach};
use crate::resume::ResumeListOrigin;
use crate::server::{Watch, WatchChange, WhenFull};
use crate::service::{decode_or_default, value_of};
use crate::store::LegacyWindow;
use crate::{Cancel, Daemon, blocking_in_place};

#[derive(Serialize, Deserialize)]
struct LegacyWindowSet {
    windows: Vec<WindowRef>,
    sources: Vec<MachineIdentity>,
}

const LIST_DEADLINE: Duration = Duration::from_secs(3);
const AGENT_RECORDS: &str = "machine.agent_records";
const LEGACY_WINDOWS: &str = "machine.legacy_windows";
const LEGACY_MEMBERS: &str = "machine.legacy_members";

/// Which parts of the running machine's records a lookup asks for.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct RecordsQuery {
    #[serde(default)]
    active: bool,
}

impl Daemon {
    pub(crate) async fn addressed_agent(
        self: &Arc<Self>,
        caller: &Caller,
        target: v3::AgentTarget,
        operation: OperationTarget,
    ) -> Result<AgentRef, ErrorBody> {
        let input = match target {
            AgentTarget::Reference { reference } => return Ok(reference),
            AgentTarget::Address { agent } => agent,
        };
        let parsed = parse_agent_address(&input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let reach = Reach::from(caller);
        let resolve = |key: AgentKey<'_>, rows: &[LookupCandidate]| {
            records::lookup(key, &reach, operation, rows)
        };
        match parsed {
            AgentAddress::Local(key) => {
                let (rows, machines) = self.query_agents(caller, None, false).await?;
                let found = resolve(key, &rows);
                if found
                    .as_ref()
                    .is_err_and(|error| error.data.reason == Reason::NotFound)
                    && let Some(error) = unanswered_lookup(&machines)
                {
                    return Err(error);
                }
                found
            }
            AgentAddress::Qualified {
                agent,
                machine,
                literal_name,
            } => {
                let target = match self.select_machine(machine) {
                    Ok(target) => target,
                    Err(error)
                        if error.data.reason == Reason::NotFound && literal_name.is_some() =>
                    {
                        let literal = AgentKey::Name(literal_name.expect("literal name"));
                        let (rows, machines) = self.query_agents(caller, None, false).await?;
                        let found = resolve(literal, &rows);
                        if found
                            .as_ref()
                            .is_err_and(|error| error.data.reason == Reason::NotFound)
                            && let Some(error) = unanswered_lookup(&machines)
                        {
                            return Err(error);
                        }
                        return found;
                    }
                    Err(error) => return Err(error),
                };
                if let AgentKey::Number(number) = agent {
                    return Ok(AgentRef {
                        agent_id: number.to_owned(),
                        machine_id: target.machine_id,
                    });
                }
                let (selected, _) = self
                    .query_agents(caller, Some(&target.machine_id), false)
                    .await?;
                let Some(literal) = literal_name else {
                    return resolve(agent, &selected);
                };
                let (awake, states) = self.query_agents(caller, None, false).await?;
                let literal = AgentKey::Name(literal);
                if let Some(error) = unanswered_lookup(&states)
                    && resolve(literal, &awake)
                        .is_err_and(|error| error.data.reason == Reason::NotFound)
                {
                    return Err(error);
                }
                records::lookup_matches(
                    AgentKey::Name(&input),
                    &reach,
                    operation,
                    selected
                        .iter()
                        .filter(|candidate| candidate.matches(agent))
                        .chain(awake.iter().filter(|candidate| candidate.matches(literal))),
                )
            }
        }
    }

    async fn query_agents(
        self: &Arc<Self>,
        caller: &Caller,
        machine: Option<&str>,
        active: bool,
    ) -> Result<(Vec<LookupCandidate>, Vec<v3::MachineQueryResult>), ErrorBody> {
        if let Some(machine) = machine
            && machine != self.machine_id
        {
            self.ensure_machine_route(machine).await?;
        }
        let rows: Vec<_> = self
            .public_machines()?
            .into_iter()
            .filter(|row| machine.is_none_or(|id| row.machine_id == id))
            .map(|row| machine_query_result(row, MachineQueryStatus::Unavailable))
            .collect();
        if let Some(id) = machine.filter(|_| rows.is_empty()) {
            return Err(self.machine_failure(
                id,
                ErrorBody::new(
                    Reason::Unavailable,
                    "the selected machine is no longer connected",
                ),
            ));
        }
        self.read_agent_records(caller, rows, active, machine.is_some())
            .await
    }

    /// A scope query can wait for saved routes, with no waking call at any hop.
    pub(crate) async fn query_scoped_agents(
        self: &Arc<Self>,
        caller: &Caller,
        scope: v3::Scope,
    ) -> Result<(Vec<LookupCandidate>, Vec<v3::MachineQueryResult>), ErrorBody> {
        let machine = match scope {
            v3::Scope::Reachable => None,
            v3::Scope::Local => Some(self.machine_id.clone()),
            v3::Scope::Machine { machine } => self.machine_for(Some(&machine))?,
        };
        if machine.as_deref() == Some(self.machine_id.as_str()) {
            return self
                .query_agents(caller, Some(&self.machine_id), true)
                .await;
        }
        let rows = self.probe_machine_queries(machine.as_deref()).await?;
        self.read_agent_records(caller, rows, true, false).await
    }

    /// Establishes the reachable routes without waking a machine and records each probe's result.
    pub(crate) async fn probe_machine_queries(
        &self,
        machine: Option<&str>,
    ) -> Result<Vec<v3::MachineQueryResult>, ErrorBody> {
        let candidates =
            machine.map_or_else(|| self.network.query_machines(), |id| vec![id.to_owned()]);
        let mut jobs = JoinSet::new();
        for id in candidates.into_iter().filter(|id| *id != self.machine_id) {
            let network = self.network.clone();
            jobs.spawn(async move {
                let result = network.probe_route(&id).await;
                (id, result)
            });
        }
        let mut probes = BTreeMap::new();
        while let Some(job) = jobs.join_next().await {
            let (id, result) = job.map_err(ErrorBody::internal)?;
            probes.insert(id, result);
        }
        let visible = self.machine_identities()?;
        let mut rows = self.public_machines()?;
        // The first table exchange can expose additional live destinations. A remembered
        // destination without a current row still gets an outcome for its passive probe.
        rows.retain(|row| {
            machine.is_none_or(|id| row.machine_id == id)
                && (row.machine_id == self.machine_id
                    || row.state == MachineState::Online
                    || probes.contains_key(&row.machine_id))
        });
        let missing: Vec<_> = probes
            .keys()
            .filter(|id| !rows.iter().any(|row| row.machine_id == **id))
            .collect();
        if !missing.is_empty() {
            let names = blocking_in_place(|| self.store.known_machine_names())
                .map_err(ErrorBody::internal)?;
            for id in missing {
                rows.push(offline_machine(MachineIdentity {
                    machine_id: id.clone(),
                    name: names.get(id).cloned().unwrap_or_else(|| id.clone()),
                }));
            }
        }
        Ok(rows
            .into_iter()
            .map(|row| {
                let mut result = machine_query_result(row, MachineQueryStatus::Unavailable);
                if result.state != MachineState::Online
                    && let Some(probe) = probes.get(&result.machine_id)
                {
                    project_machine_query(&mut result, &visible);
                    if let Err(error) = probe {
                        observe_probe_failure(&mut result, error);
                    } else {
                        result.state = MachineState::Unreachable;
                        result.error =
                            Some("the machine disconnected before it could be queried".into());
                    }
                }
                result
            })
            .collect())
    }

    async fn read_agent_records(
        self: &Arc<Self>,
        caller: &Caller,
        rows: Vec<v3::MachineQueryResult>,
        active: bool,
        strict: bool,
    ) -> Result<(Vec<LookupCandidate>, Vec<v3::MachineQueryResult>), ErrorBody> {
        let visible = self.machine_identities()?;
        let mut jobs = JoinSet::new();
        let deadline = tokio::time::Instant::now() + LIST_DEADLINE;
        let mut agents = Vec::new();
        let mut machines = BTreeMap::new();
        let query = RecordsQuery { active };
        for mut result in rows {
            if result.machine_id == self.machine_id {
                result.status = MachineQueryStatus::Answered;
                agents = self.local_agent_records(caller, query)?;
            } else if result.state == MachineState::Online || strict {
                let daemon = self.clone();
                let id = result.machine_id.clone();
                let caller = caller.clone();
                let call = ForwardCall {
                    call: CallParams {
                        op: AGENT_RECORDS.into(),
                        args: value_of(query),
                    },
                    by_model: false,
                    from_name: None,
                    recipient: None,
                };
                jobs.spawn(async move {
                    let result = daemon
                        .network
                        .call_with_receipt(
                            &id,
                            caller,
                            "call".into(),
                            value_of(call),
                            Some(deadline),
                            None,
                        )
                        .await;
                    (id, result)
                });
            }
            machines.insert(result.machine_id.clone(), result);
        }
        while let Some(task) = jobs.join_next().await {
            let (id, reply) = task.map_err(ErrorBody::internal)?;
            let row = machines.get_mut(&id).expect("each active query has a row");
            match reply {
                Ok((value, received_at)) => match observe_agent_reply(row, value, received_at) {
                    Ok(mut records) => {
                        records.retain(|record| record.info.machine_id == id);
                        agents.extend(records);
                    }
                    Err(error) if strict => return Err(self.machine_failure(&id, error)),
                    Err(error) => row.error = Some(error.message),
                },
                Err(error) if strict => {
                    return Err(self.machine_failure(&id, error.into()));
                }
                Err(error) => {
                    row.status = match &error {
                        RequestFailure::TimedOut(_) => MachineQueryStatus::TimedOut,
                        RequestFailure::Unreachable(_) => MachineQueryStatus::Unavailable,
                        RequestFailure::Failed(_, _) => MachineQueryStatus::Error,
                    };
                    row.error = Some(ErrorBody::from(error).message);
                }
            }
        }
        for candidate in &mut agents {
            let agent = &mut candidate.info;
            let machine = machine_address_part(&agent.machine_id, &visible)?;
            agent.address =
                facade_base::v3::address::format_agent_address(&agent.reference(), &machine);
        }
        Ok((agents, machines.into_values().collect()))
    }

    fn local_agent_records(
        &self,
        caller: &Caller,
        query: RecordsQuery,
    ) -> Result<Vec<LookupCandidate>, ErrorBody> {
        let reach = Reach::from(caller);
        self.agents()
            .iter()
            .filter(|agent| {
                let info = agent.info();
                !query.active
                    || (info.process == facade_base::process::ProcessState::Running
                        && reach.reaches(&info))
            })
            .map(|agent| self.lookup_candidate(agent))
            .collect()
    }

    pub(crate) async fn list_agents_v3(
        self: &Arc<Self>,
        caller: &Caller,
        args: MachineQueryArgs,
    ) -> Result<v3::AgentListResult, ErrorBody> {
        let machine = self.machine_for(args.machine.as_deref())?;
        let (agents, machines) = self.query_agents(caller, machine.as_deref(), true).await?;
        Ok(agent_list_result(agents, machines))
    }

    pub(crate) async fn list_scoped_agents(
        self: &Arc<Self>,
        caller: &Caller,
        scope: v3::Scope,
    ) -> Result<v3::AgentListResult, ErrorBody> {
        if let v3::Scope::Machine { machine } = scope {
            return self
                .list_agents_v3(
                    caller,
                    MachineQueryArgs {
                        machine: Some(machine),
                    },
                )
                .await;
        }
        let (agents, machines) = self.query_scoped_agents(caller, scope).await?;
        Ok(agent_list_result(agents, machines))
    }

    pub(crate) fn machine_for(&self, selector: Option<&str>) -> Result<Option<String>, ErrorBody> {
        selector
            .map(|selector| {
                self.select_machine(machine_selector(selector)?)
                    .map(|row| row.machine_id)
            })
            .transpose()
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
        self.forward_call(
            target,
            caller,
            ForwardCall {
                call: CallParams {
                    op: operation.into(),
                    args,
                },
                by_model: false,
                from_name: None,
                recipient: None,
            },
            time_left,
            request_id,
        )
        .await
    }

    pub(crate) async fn forward_call(
        &self,
        target: &str,
        caller: Caller,
        forwarded: ForwardCall,
        time_left: Option<Duration>,
        request_id: Option<String>,
    ) -> Result<Value, ErrorBody> {
        self.network
            .call(
                target,
                caller,
                "call".into(),
                value_of(forwarded),
                time_left,
                request_id,
            )
            .await
            .map_err(|error| {
                let error = self.project_remote_error(error);
                if error.data.unavailable.is_some() || error.data.ssh_interaction.is_some() {
                    self.machine_failure(target, error)
                } else {
                    error
                }
            })
    }

    pub(crate) async fn import_legacy_workspace(
        self: &Arc<Self>,
        caller: &Caller,
        selection: v3::LegacyWorkspaceArgs,
    ) -> Result<v3::LegacyWorkspaceResult, ErrorBody> {
        if !matches!(caller, Caller::Ide { .. }) {
            return Err(ErrorBody::refused(
                "only an editor can import a legacy workspace",
            ));
        }
        let owner = selection.machine_id.clone();
        let local = owner == self.machine_id;
        let imported: LegacyWindowSet = if local {
            self.legacy_workspace_windows(selection)?
        } else {
            self.network.ensure_route(&owner).await?;
            decode_arguments(
                self.network_call(
                    &owner,
                    caller.clone(),
                    LEGACY_WINDOWS,
                    value_of(selection),
                    None,
                    None,
                )
                .await?,
            )?
        };
        let mut agents = self.legacy_workspace_members(&imported.windows)?;
        let mut machines = Vec::new();
        let visible = self.machine_identities()?;
        let mut jobs = JoinSet::new();
        for MachineIdentity { machine_id, name } in imported.sources {
            if machine_id == self.machine_id {
                continue;
            }
            let (daemon, caller, windows) =
                (self.clone(), caller.clone(), imported.windows.clone());
            jobs.spawn(async move {
                let result = async {
                    daemon.network.ensure_route(&machine_id).await?;
                    decode_arguments::<Vec<AgentRef>>(
                        daemon
                            .network_call(
                                &machine_id,
                                caller,
                                LEGACY_MEMBERS,
                                value_of(windows),
                                None,
                                None,
                            )
                            .await?,
                    )
                }
                .await;
                (machine_id, name, result)
            });
        }
        let now = self.public_machines()?;
        while let Some(task) = jobs.join_next().await {
            let (id, name, reply) = task.map_err(ErrorBody::internal)?;
            let mut row = match now.iter().find(|row| row.machine_id == id) {
                Some(row) => row.clone(),
                None => v3::MachineInfo {
                    selector: machine_address_part(&id, &visible)?,
                    machine_id: id.clone(),
                    name,
                    boot_id: None,
                    build: None,
                    route: None,
                    state: MachineState::Unreachable,
                    last_seen: None,
                    ssh_error: None,
                    connections: Vec::new(),
                    capabilities: Vec::new(),
                },
            };
            let status = match reply {
                Ok(members) => {
                    agents.extend(members.into_iter().filter(|agent| agent.machine_id == id));
                    row.state = MachineState::Online;
                    MachineQueryStatus::Answered
                }
                Err(error) => machine_query_failure(&error),
            };
            machines.push(machine_query_result(row, status));
        }
        agents.sort();
        agents.dedup();
        machines.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
        Ok(v3::LegacyWorkspaceResult { agents, machines })
    }

    fn legacy_workspace_windows(
        &self,
        args: v3::LegacyWorkspaceArgs,
    ) -> Result<LegacyWindowSet, ErrorBody> {
        if args.machine_id != self.machine_id {
            return Err(ErrorBody::invalid_argument(
                "the workspace selector belongs to a different machine",
            ));
        }
        let selector = match (
            args.workspace_key.as_deref(),
            args.window_id.as_deref(),
            args.instance_id.as_deref(),
        ) {
            (Some(key), None, None) => LegacyWindow::Workspace(key),
            (None, Some(id), None) => LegacyWindow::Logical(id),
            (None, None, Some(id)) => LegacyWindow::Instance(id),
            _ => {
                return Err(ErrorBody::invalid_argument(
                    "give one legacy workspace selector",
                ));
            }
        };
        blocking_in_place(|| {
            let ids = self.store.window_table().legacy_ids(selector)?;
            let sources = if ids.is_empty() {
                Vec::new()
            } else {
                self.store.legacy_machines()?
            };
            let windows = ids.into_iter().map(|id| self.local_window(id)).collect();
            Ok::<_, anyhow::Error>(LegacyWindowSet { windows, sources })
        })
        .map_err(ErrorBody::internal)
    }

    fn legacy_workspace_members(&self, windows: &[WindowRef]) -> Result<Vec<AgentRef>, ErrorBody> {
        blocking_in_place(|| self.store.membership_table().legacy_agents(windows))
            .map_err(ErrorBody::internal)
    }

    async fn accept_machine_call(
        self: &Arc<Self>,
        caller: Caller,
        call: ForwardCall,
        request_id: Option<String>,
        remaining: Option<Duration>,
        cancel: Cancel,
    ) -> Result<Value, ErrorBody> {
        let operation = call.call.op.as_str();
        let args = call.call.args;
        match operation {
            v3::AgentResumeList::NAME => Ok(value_of(
                self.resume_candidates(
                    &caller,
                    decode_or_default(args)?,
                    ResumeListOrigin::Forwarded,
                )
                .await?,
            )),
            crate::resume::RESUME_RECORDS => {
                require_person(&caller)?;
                Ok(value_of(
                    self.local_resume_candidates(&decode_arguments(args)?, false)
                        .await?,
                ))
            }
            AGENT_RECORDS => Ok(value_of(
                self.local_agent_records(&caller, decode_arguments(args)?)?,
            )),
            LEGACY_WINDOWS if matches!(caller, Caller::Ide { .. }) => Ok(value_of(
                self.legacy_workspace_windows(decode_arguments(args)?)?,
            )),
            LEGACY_MEMBERS if matches!(caller, Caller::Ide { .. }) => {
                let windows: Vec<WindowRef> = decode_arguments(args)?;
                Ok(value_of(self.legacy_workspace_members(&windows)?))
            }
            crate::waits::DELIVER_WAIT_NOTICE => {
                self.deliver_wait_notice(&caller, decode_arguments(args)?, remaining)
                    .await?;
                Ok(value_of(v3::EmptyResult {}))
            }
            _ => {
                self.run_operation(
                    &caller,
                    operation,
                    args,
                    WhenFull::Refuse,
                    cancel,
                    Some(crate::service::Forwarded {
                        recipient: call.recipient,
                        from_name: call.from_name,
                        request_id,
                        remaining,
                    }),
                )
                .await
            }
        }
    }

    pub(crate) async fn serve_target(self: &Arc<Self>, request: V3TargetRequest) {
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
            let shared = params.topic == v3::AttachTopic::NAME;
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
            let attach = if shared {
                self.attach_binding(viewer)
            } else {
                None
            };
            let (send, receive) = mpsc::channel(64);
            if reply
                .send(TargetReply::Watch {
                    snapshot,
                    changes: receive,
                    attach,
                })
                .is_ok()
            {
                let copy = async {
                    while let Some(change) = changes.recv().await {
                        let change = match change {
                            WatchChange::Change(value) => Ok(value),
                            WatchChange::Ended(error) => Err(error),
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
            if forward.method == v3::AttachResize::NAME {
                let Some(_active) = self.lifecycle.begin(Work::Call) else {
                    return Err(ErrorBody::new(Reason::Unavailable, "Facade is exiting"));
                };
                if cancel.is_requested() {
                    return Err(ErrorBody::new(
                        Reason::Cancelled,
                        "the resize was cancelled",
                    ));
                }
                self.resize_forwarded_viewer(&forward.caller, decode_arguments(forward.params)?)
                    .await?;
                return Ok(value_of(v3::EmptyResult {}));
            }
            if forward.method != "call" {
                return Err(ErrorBody::invalid_argument("unknown forwarded method"));
            }
            let call: ForwardCall = decode_arguments(forward.params)?;
            let work = if call.call.op == v3::AgentSend::NAME {
                Work::Send
            } else {
                Work::Call
            };
            let Some(_active) = self.lifecycle.begin(work) else {
                return Err(ErrorBody::new(Reason::Unavailable, "Facade is exiting"));
            };
            self.accept_machine_call(
                forward.caller,
                call,
                forward.request_id,
                forward.time_left_ms.map(Duration::from_millis),
                cancel,
            )
            .await
        }
        .await;
        let _ = reply.send(TargetReply::Call(outcome));
    }
}

fn agent_list_result(
    agents: Vec<LookupCandidate>,
    machines: Vec<v3::MachineQueryResult>,
) -> v3::AgentListResult {
    let mut agents: Vec<_> = agents
        .iter()
        .map(|agent| records::list_row(&agent.info))
        .collect();
    agents.sort_by(|a, b| {
        b.row
            .started_at
            .cmp(&a.row.started_at)
            .then_with(|| a.reference.cmp(&b.reference))
    });
    v3::AgentListResult { agents, machines }
}

fn observe_probe_failure(row: &mut v3::MachineQueryResult, error: &ErrorBody) {
    let sleeping = error
        .data
        .machines
        .iter()
        .find(|machine| machine.state == MachineState::Sleeping);
    row.state = if sleeping.is_some_and(|machine| machine.machine_id == row.machine_id) {
        MachineState::Sleeping
    } else if error.data.reason == Reason::SshInteractionRequired {
        MachineState::SshInteractionRequired
    } else {
        MachineState::Unreachable
    };
    row.status = if row.state == MachineState::SshInteractionRequired {
        MachineQueryStatus::Unavailable
    } else {
        machine_query_failure(error)
    };
    row.error = Some(match sleeping {
        Some(machine) if machine.machine_id != row.machine_id => {
            format!("{} on the saved route is sleeping.", machine.name)
        }
        _ => error.message.clone(),
    });
}

fn unanswered_lookup(machines: &[v3::MachineQueryResult]) -> Option<ErrorBody> {
    let unanswered: Vec<_> = machines
        .iter()
        .filter(|machine| {
            machine.state == MachineState::Online && machine.status != MachineQueryStatus::Answered
        })
        .map(|machine| MachineIdentity {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
        })
        .collect();
    if unanswered.is_empty() {
        return None;
    }
    let mut error = ErrorBody::new(
        Reason::Unavailable,
        format!(
            "could not finish the lookup on {}",
            unanswered
                .iter()
                .map(|machine| machine.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    );
    error.data.unavailable = Some(facade_base::machine::Unavailable {
        execution: facade_base::machine::ExecutionOutcome::NotExecuted,
        machine: None,
        window: None,
        matches: Vec::new(),
        unanswered,
    });
    error.data.machines = machines
        .iter()
        .filter(|machine| machine.error.is_some())
        .cloned()
        .collect();
    Some(error)
}

fn observe_agent_reply(
    row: &mut v3::MachineQueryResult,
    value: Value,
    received_at: SystemTime,
) -> Result<Vec<LookupCandidate>, ErrorBody> {
    row.last_seen = Some(facade_base::time::iso_time(received_at));
    let records = decode_arguments(value);
    row.status = if records.is_ok() {
        MachineQueryStatus::Answered
    } else {
        MachineQueryStatus::Error
    };
    records
}

pub(crate) fn machine_selector(text: &str) -> Result<v3::address::MachineSelector<'_>, ErrorBody> {
    parse_machine_selector(text).map_err(|error| ErrorBody::invalid_argument(error.to_string()))
}

pub(crate) fn machine_query_result(
    machine: v3::MachineInfo,
    status: MachineQueryStatus,
) -> v3::MachineQueryResult {
    v3::MachineQueryResult {
        short_id: v3::address::short_machine_id(&machine.machine_id),
        machine_id: machine.machine_id,
        name: machine.name,
        selector: machine.selector,
        build: machine.build,
        state: machine.state,
        status,
        last_seen: machine.last_seen,
        ssh_error: machine.ssh_error,
        error: None,
    }
}

pub(crate) fn machine_query_failure(error: &ErrorBody) -> MachineQueryStatus {
    match error.data.reason {
        Reason::Unavailable => MachineQueryStatus::Unavailable,
        _ => MachineQueryStatus::Error,
    }
}

pub(crate) fn require_person(caller: &Caller) -> Result<(), ErrorBody> {
    if matches!(caller, Caller::Agent { .. }) {
        Err(ErrorBody::refused(
            "only a person can change machine connections",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::UNIX_EPOCH;

    #[test]
    fn agent_list_replies_use_the_origin_receive_time() {
        let received_at = UNIX_EPOCH + Duration::from_secs(1_795_000_000);
        for (reply, status) in [
            (json!([]), MachineQueryStatus::Answered),
            (json!({}), MachineQueryStatus::Error),
        ] {
            let mut row = v3::MachineQueryResult {
                machine_id: "peer".into(),
                short_id: "peer".into(),
                name: "gpu".into(),
                selector: "gpu".into(),
                build: None,
                state: MachineState::Online,
                status: MachineQueryStatus::Unavailable,
                last_seen: Some("2000-01-01T00:00:00.000Z".into()),
                ssh_error: None,
                error: None,
            };
            let result = observe_agent_reply(&mut row, reply, received_at);
            assert_eq!(row.status, status);
            assert_eq!(result.is_ok(), status == MachineQueryStatus::Answered);
            assert_eq!(
                row.last_seen,
                Some(facade_base::time::iso_time(received_at))
            );
        }
    }
}
