//! Resolves targets in the caller's machine view and forwards only exact references.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use facade_base::address::selector::{
    AgentAddress, AgentKey, parse_agent_address, parse_machine_selector,
};
use facade_base::api_v1::daemon::Caller;
use facade_base::api_v1::{Operation, daemon as wire};
use facade_base::model::machine::MachineQueryResult;
use facade_base::model::machine::MachineState;
use facade_base::{
    jsonrpc::decode_arguments,
    model::error::{ErrorBody, Reason},
};
use facade_base::{
    model::agent::AgentRef,
    model::machine::{MachineIdentity, MachineQueryStatus},
};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::api;
use crate::machine_service::{machine_address_part, offline_machine, project_machine_query};
use crate::network::{RequestFailure, TargetReply, TargetRequest};
use crate::records::{self, LookupCandidate, OperationTarget, Reach};
use crate::server::{Watch, WatchChange, WhenFull};
use crate::{Cancel, Daemon, blocking_in_place};

pub(crate) const LIST_DEADLINE: Duration = Duration::from_secs(3);

type SessionNames = BTreeMap<wire::AgentRef, String>;

pub(crate) struct QueriedAgents {
    pub(crate) agents: Vec<LookupCandidate>,
    pub(crate) machines: Vec<MachineQueryResult>,
    session_names: SessionNames,
}

impl Daemon {
    pub(crate) async fn addressed_agent(
        self: &Arc<Self>,
        caller: &Caller,
        target: wire::AgentTarget,
        operation: OperationTarget,
    ) -> Result<AgentRef, ErrorBody> {
        let input = match target {
            wire::AgentTarget::Reference(reference) => return Ok(api::agent_ref(reference)),
            wire::AgentTarget::Selector(agent) => agent,
        };
        let parsed = parse_agent_address(&input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let reach = Reach::from(caller);
        let resolve = |key: AgentKey<'_>, rows: &[LookupCandidate]| {
            records::lookup(key, &reach, operation, rows)
        };
        match parsed {
            AgentAddress::Local(key) => {
                let QueriedAgents {
                    agents: rows,
                    machines,
                    ..
                } = self.query_agents(caller, None, false).await?;
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
                        let QueriedAgents {
                            agents: rows,
                            machines,
                            ..
                        } = self.query_agents(caller, None, false).await?;
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
                let selected = self
                    .query_agents(caller, Some(&target.machine_id), false)
                    .await?
                    .agents;
                let Some(literal) = literal_name else {
                    return resolve(agent, &selected);
                };
                let QueriedAgents {
                    agents: awake,
                    machines: states,
                    ..
                } = self.query_agents(caller, None, false).await?;
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

    pub(crate) async fn query_agents(
        self: &Arc<Self>,
        caller: &Caller,
        machine: Option<&str>,
        active: bool,
    ) -> Result<QueriedAgents, ErrorBody> {
        if let Some(machine) = machine
            && machine != self.machine_id
        {
            self.ensure_machine_route(machine, caller).await?;
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
        scope: wire::Scope,
    ) -> Result<QueriedAgents, ErrorBody> {
        let machine = match scope {
            wire::Scope::Reachable => None,
            wire::Scope::Local => Some(self.machine_id.clone()),
            wire::Scope::Machine { machine } => self.machine_for(Some(&machine))?,
        };
        if machine.as_deref() == Some(self.machine_id.as_str()) {
            return self
                .query_agents(caller, Some(&self.machine_id), true)
                .await;
        }
        let rows = self
            .probe_machine_queries(machine.as_deref(), caller)
            .await?;
        self.read_agent_records(caller, rows, true, false).await
    }

    /// Establishes the reachable routes without waking a machine and records each probe's result.
    pub(crate) async fn probe_machine_queries(
        &self,
        machine: Option<&str>,
        caller: &Caller,
    ) -> Result<Vec<MachineQueryResult>, ErrorBody> {
        let candidates =
            machine.map_or_else(|| self.network.query_machines(), |id| vec![id.to_owned()]);
        let mut jobs = JoinSet::new();
        for id in candidates.into_iter().filter(|id| *id != self.machine_id) {
            let network = self.network.clone();
            let caller = caller.clone();
            jobs.spawn(async move {
                let result = network
                    .probe_route(&id, &caller)
                    .await
                    .map_err(api::received_error);
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
                    || row.state == wire::MachineState::Online
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
        rows: Vec<MachineQueryResult>,
        active: bool,
        strict: bool,
    ) -> Result<QueriedAgents, ErrorBody> {
        let visible = self.machine_identities()?;
        let mut jobs = JoinSet::new();
        let deadline = Instant::now() + LIST_DEADLINE;
        let mut agents = Vec::new();
        let mut machines = BTreeMap::new();
        let include_sessions = active && matches!(caller, Caller::Terminal { .. });
        for mut result in rows {
            if result.machine_id == self.machine_id {
                result.status = MachineQueryStatus::Answered;
                agents = if active {
                    self.local_agent_records(caller, true)?
                } else {
                    // The selector checks reach and reports refusals without target details.
                    self.agents()
                        .iter()
                        .map(|agent| self.lookup_candidate(agent))
                        .collect::<Result<_, _>>()?
                };
            } else if result.state == MachineState::Online || strict {
                let daemon = self.clone();
                let id = result.machine_id.clone();
                let request = wire::ForwardParams {
                    route: Vec::new(),
                    caller: caller.clone(),
                    request: wire::ForwardRequest::Call(api::call::<wire::InternalAgentRecords>(
                        wire::InternalAgentRecordsArgs { active },
                    )),
                    time_left_ms: None,
                    from_name: None,
                    start_result: None,
                };
                jobs.spawn(async move {
                    let result = daemon
                        .network
                        .call_with_receipt(&id, request, Some(deadline))
                        .await;
                    (id, result)
                });
            }
            machines.insert(result.machine_id.clone(), result);
        }
        let mut session_names = if include_sessions {
            self.session_names(&agents, deadline).await
        } else {
            SessionNames::new()
        };
        while let Some(task) = jobs.join_next().await {
            let (id, reply) = task.map_err(ErrorBody::internal)?;
            let row = machines.get_mut(&id).expect("each active query has a row");
            match reply {
                Ok((value, received_at)) => match observe_agent_reply(row, value, received_at) {
                    Ok(records) => {
                        for record in records
                            .into_iter()
                            .filter(|record| record.agent.reference.machine_id == id)
                        {
                            if include_sessions && let Some(name) = record.session_name {
                                session_names.insert(record.agent.reference.clone(), name);
                            }
                            agents.push(LookupCandidate {
                                info: record.agent,
                                has_rule: record.has_rule,
                            });
                        }
                    }
                    Err(error) if strict => return Err(self.machine_failure(&id, error)),
                    Err(error) => row.error = Some(error.message),
                },
                Err(error) if strict => {
                    return Err(self.machine_failure(&id, api::received_error(error.into())));
                }
                Err(error) => {
                    row.status = match &error {
                        RequestFailure::TimedOut(_) => MachineQueryStatus::TimedOut,
                        RequestFailure::Unreachable(_) => MachineQueryStatus::Unavailable,
                        RequestFailure::Failed(_, _) => MachineQueryStatus::Error,
                    };
                    let error: facade_base::api_v1::ErrorBody = error.into();
                    row.error = Some(error.message);
                }
            }
        }
        for candidate in &mut agents {
            let agent = &mut candidate.info;
            let machine = machine_address_part(&agent.reference.machine_id, &visible)?;
            agent.address = facade_base::address::selector::format_agent_address(
                &agent.reference.agent_id,
                &machine,
            );
        }
        Ok(QueriedAgents {
            agents,
            machines: machines.into_values().collect(),
            session_names,
        })
    }

    pub(crate) async fn session_names(
        self: &Arc<Self>,
        agents: &[LookupCandidate],
        deadline: Instant,
    ) -> SessionNames {
        let mut names = SessionNames::new();
        for candidate in agents {
            let reference = &candidate.info.reference;
            let Some(session) = candidate.info.session.as_deref() else {
                continue;
            };
            let Some(agent) = self.get_agent(&reference.agent_id) else {
                continue;
            };
            let info = agent.info();
            if info.session.as_deref() != Some(session) {
                continue;
            }
            match tokio::time::timeout_at(deadline, self.native_session_name(&agent, &info)).await {
                Ok(Some(name)) => {
                    names.insert(reference.clone(), name);
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
        names
    }

    pub(crate) fn local_agent_records(
        &self,
        caller: &Caller,
        active: bool,
    ) -> Result<Vec<LookupCandidate>, ErrorBody> {
        let reach = Reach::from(caller);
        self.agents()
            .iter()
            .filter(|agent| {
                let info = agent.info();
                reach.reaches(&info)
                    && (!active || info.process == facade_base::process::ProcessState::Running)
            })
            .map(|agent| self.lookup_candidate(agent))
            .collect()
    }

    pub(crate) async fn list_active_agents(
        self: &Arc<Self>,
        caller: &Caller,
        machine: Option<&str>,
    ) -> Result<wire::AgentListResult, ErrorBody> {
        let machine = self.machine_for(machine)?;
        Ok(agent_list_result(
            self.query_agents(caller, machine.as_deref(), true).await?,
        ))
    }

    pub(crate) async fn list_scoped_agents(
        self: &Arc<Self>,
        caller: &Caller,
        scope: wire::Scope,
    ) -> Result<wire::AgentListResult, ErrorBody> {
        if let wire::Scope::Machine { machine } = scope {
            return self.list_active_agents(caller, Some(&machine)).await;
        }
        Ok(agent_list_result(
            self.query_scoped_agents(caller, scope).await?,
        ))
    }

    pub(crate) fn machine_for(&self, selector: Option<&str>) -> Result<Option<String>, ErrorBody> {
        selector
            .map(|selector| {
                self.select_machine(machine_selector(selector)?)
                    .map(|row| row.machine_id)
            })
            .transpose()
    }

    pub(crate) async fn network_call<O: Operation>(
        &self,
        target: &str,
        caller: &Caller,
        args: O::Args,
        time_left: Option<Duration>,
    ) -> Result<Value, ErrorBody> {
        self.forward_call(target, caller, api::call::<O>(args), None, None, time_left)
            .await
    }

    pub(crate) async fn forward_call(
        &self,
        target: &str,
        caller: &Caller,
        call: wire::CallParams,
        from_name: Option<String>,
        start_result: Option<wire::MessageRef>,
        time_left: Option<Duration>,
    ) -> Result<Value, ErrorBody> {
        let request = wire::ForwardParams {
            route: Vec::new(),
            caller: caller.clone(),
            request: wire::ForwardRequest::Call(call),
            time_left_ms: None,
            from_name,
            start_result,
        };
        let deadline = time_left.map(|left| tokio::time::Instant::now() + left);
        self.call_peer(target, request, deadline).await
    }

    pub(crate) async fn call_peer(
        &self,
        target: &str,
        request: wire::ForwardParams,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<Value, ErrorBody> {
        self.network
            .call_with_receipt(target, request, deadline)
            .await
            .map(|(value, _)| value)
            .map_err(|failure| {
                let error = self.project_remote_error(api::received_error(failure.into()));
                if error.data.unavailable.is_some() || error.data.ssh_interaction.is_some() {
                    self.machine_failure(target, error)
                } else {
                    error
                }
            })
    }

    pub(crate) async fn serve_target(self: &Arc<Self>, request: TargetRequest) {
        let TargetRequest {
            forward,
            cancelled,
            reply,
        } = request;
        let mut cancel = Cancel::of(cancelled);
        let caller = forward.caller;
        match forward.request {
            wire::ForwardRequest::Watch(params) => {
                let watch = match wire::decode_watch(params, wire::ClientKind::Machine) {
                    Ok(watch) => watch,
                    Err(error) => {
                        let _ = reply.send(TargetReply::Call(Err(error)));
                        return;
                    }
                };
                let viewer = crate::server::next_viewer();
                let Watch {
                    snapshot,
                    mut changes,
                } = match self.start_watch(&caller, watch, viewer, true).await {
                    Ok(watch) => watch,
                    Err(error) => {
                        let _ = reply.send(TargetReply::Call(Err(api::project_error(error))));
                        return;
                    }
                };
                let view = self.attach_binding(viewer);
                let (send, receive) = mpsc::channel(64);
                if reply
                    .send(TargetReply::Watch {
                        snapshot,
                        changes: receive,
                        view,
                    })
                    .is_ok()
                {
                    let copy = async {
                        while let Some(change) = changes.recv().await {
                            let change = match change {
                                WatchChange::Change(value) => Ok(value),
                                WatchChange::Ended(error) => Err(error),
                                WatchChange::Disconnect => {
                                    Err(api::error("unavailable", "the watch fell behind"))
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
            }
            wire::ForwardRequest::Call(params) => {
                let outcome = match wire::decode_call(params, wire::ClientKind::Machine) {
                    Ok(call) => {
                        self.run_api_call(
                            &caller,
                            call,
                            WhenFull::Refuse,
                            cancel,
                            Some(crate::service::Forwarded {
                                from_name: forward.from_name,
                                start_result: forward.start_result,
                                remaining: forward.time_left_ms.map(Duration::from_millis),
                            }),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
                let _ = reply.send(TargetReply::Call(outcome));
            }
        }
    }
}

fn agent_list_result(
    QueriedAgents {
        agents,
        machines,
        mut session_names,
    }: QueriedAgents,
) -> wire::AgentListResult {
    let mut agents: Vec<_> = agents
        .iter()
        .map(|agent| match session_names.remove(&agent.info.reference) {
            Some(name) => records::list_row_with_session(&agent.info, Some(name)),
            None => records::list_row(&agent.info),
        })
        .collect();
    agents.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| a.reference.cmp(&b.reference))
    });
    wire::AgentListResult {
        agents,
        machines: machines.into_iter().map(api::machine_query).collect(),
    }
}

fn observe_probe_failure(row: &mut MachineQueryResult, error: &ErrorBody) {
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

fn unanswered_lookup(machines: &[MachineQueryResult]) -> Option<ErrorBody> {
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
    error.data.unavailable = Some(facade_base::model::machine::Unavailable {
        execution: facade_base::model::machine::ExecutionOutcome::NotExecuted,
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
    row: &mut MachineQueryResult,
    value: Value,
    received_at: SystemTime,
) -> Result<Vec<wire::AgentLookupCandidate>, ErrorBody> {
    row.last_seen = Some(facade_base::time::iso_time(received_at));
    let records = decode_arguments(value);
    row.status = if records.is_ok() {
        MachineQueryStatus::Answered
    } else {
        MachineQueryStatus::Error
    };
    records
}

pub(crate) fn machine_selector(
    text: &str,
) -> Result<facade_base::address::selector::MachineSelector<'_>, ErrorBody> {
    parse_machine_selector(text).map_err(|error| ErrorBody::invalid_argument(error.to_string()))
}

pub(crate) fn machine_query_result(
    machine: wire::MachineInfo,
    status: MachineQueryStatus,
) -> MachineQueryResult {
    MachineQueryResult {
        short_id: machine.short_id,
        machine_id: machine.machine_id,
        name: machine.name,
        selector: machine.selector,
        build: machine.build,
        state: match machine.state {
            wire::MachineState::Online => MachineState::Online,
            wire::MachineState::Connecting => MachineState::Connecting,
            wire::MachineState::Disconnected => MachineState::Disconnected,
            wire::MachineState::Sleeping => MachineState::Sleeping,
            wire::MachineState::Unreachable | wire::MachineState::Unknown => {
                MachineState::Unreachable
            }
            wire::MachineState::SshInteractionRequired => MachineState::SshInteractionRequired,
        },
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
            let mut row = MachineQueryResult {
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
