//! The connected machines' contributions to this home's editor agent views.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use facade_base::api_v1::{self, daemon as wire};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{MachineResponseState, MachineStateRow};
use facade_base::operations::Topic;
use facade_base::v3::{
    self, AgentInfo, AgentMachineState, AgentSyncState, AgentsChange, AgentsSnapshot,
};
use tokio::task::AbortHandle;

use crate::Daemon;
use crate::api;
use crate::network::RequestFailure;
use crate::service::value_of;

#[derive(Default)]
pub(crate) struct RemoteAgents(BTreeMap<String, Source>);

struct Source {
    route: Option<(String, Vec<String>)>,
    generation: u64,
    row: MachineStateRow,
    agents: BTreeMap<String, AgentInfo>,
    task: Option<AbortHandle>,
}

impl Source {
    fn view(&self) -> AgentMachineState {
        let state = match self.row.state {
            MachineResponseState::Responded => AgentSyncState::Synced,
            MachineResponseState::Waiting => AgentSyncState::Pending,
            _ => AgentSyncState::Unreachable,
        };
        AgentMachineState {
            state,
            machine_id: self.row.machine_id.clone(),
            agents: (self.row.state == MachineResponseState::Responded)
                .then(|| self.agents.values().cloned().collect()),
        }
    }

    fn reset(&mut self, state: MachineResponseState, received_at: Option<SystemTime>) {
        self.route = None;
        self.generation += 1;
        self.row.observe(state, received_at);
        self.agents.clear();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Daemon {
    pub(crate) fn remote_agent_states(&self) -> Vec<AgentMachineState> {
        self.remote_agents
            .lock()
            .unwrap()
            .0
            .values()
            .map(Source::view)
            .collect()
    }

    /// Replaces a subscription when its route changes. An unavailable machine contributes state.
    pub(crate) fn follow_remote_agents(self: &Arc<Self>, machines: &[v3::MachineInfo]) {
        let mut view = self.remote_agents.lock().unwrap();
        for (id, source) in view.0.iter_mut() {
            if !source.row.unreachable
                && !machines
                    .iter()
                    .any(|row| &row.machine_id == id && row.route.is_some())
            {
                source.reset(MachineResponseState::Unreachable, None);
                let _ = self.remote_changes.send(AgentsChange::SyncUpdated {
                    machine: source.view(),
                });
            }
        }
        for row in machines
            .iter()
            .filter(|row| row.machine_id != self.machine_id)
        {
            let id = &row.machine_id;
            let route = row.boot_id.clone().zip(row.route.clone());
            let Some(route) = route else { continue };
            let source = view.0.entry(id.clone()).or_insert_with(|| Source {
                route: None,
                generation: 0,
                row: MachineStateRow {
                    machine_id: row.machine_id.clone(),
                    name: row.name.clone(),
                    build: row.build.clone(),
                    state: MachineResponseState::Waiting,
                    unreachable: false,
                    responded_at: None,
                },
                agents: BTreeMap::new(),
                task: None,
            });
            source.row.name.clone_from(&row.name);
            source.row.build.clone_from(&row.build);
            if source.route.as_ref() == Some(&route) {
                continue;
            }
            self.start_remote_agent_watch(route, source);
        }
    }

    fn start_remote_agent_watch(
        self: &Arc<Self>,
        route: (String, Vec<String>),
        source: &mut Source,
    ) {
        source.reset(MachineResponseState::Waiting, None);
        source.route = Some(route);
        let _ = self.remote_changes.send(AgentsChange::SyncUpdated {
            machine: source.view(),
        });
        let generation = source.generation;
        let daemon = self.clone();
        let id = source.row.machine_id.clone();
        source.task = Some(
            tokio::spawn(async move {
                let (state, received_at, retry) =
                    match daemon.watch_remote_agents(&id, generation).await {
                        Ok(()) => (MachineResponseState::Unreachable, None, true),
                        Err(failure) => {
                            let (state, received_at) = failure.observation();
                            let error = api::received_error(failure.into());
                            crate::log("warn", &error.message);
                            let retry =
                                matches!(error.data.reason, Reason::Unavailable | Reason::Internal);
                            (state, received_at, retry)
                        }
                    };
                let disconnected_generation = {
                    let mut view = daemon.remote_agents.lock().unwrap();
                    let Some(source) = view
                        .0
                        .get_mut(&id)
                        .filter(|source| source.generation == generation)
                    else {
                        return;
                    };
                    source.task.take();
                    source.reset(state, received_at);
                    let _ = daemon.remote_changes.send(AgentsChange::SyncUpdated {
                        machine: source.view(),
                    });
                    source.generation
                };
                if retry {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    daemon.retry_remote_agent_watch(&id, disconnected_generation);
                }
            })
            .abort_handle(),
        );
    }

    /// Only the disconnected generation can reclaim this machine's watch after the delay.
    fn retry_remote_agent_watch(self: &Arc<Self>, id: &str, disconnected_generation: u64) {
        let machine = self
            .network
            .machines_v3()
            .into_iter()
            .find(|row| row.machine_id == id);
        let Some(machine) = machine else { return };
        let Some(route) = machine.boot_id.zip(machine.route) else {
            return;
        };
        let mut view = self.remote_agents.lock().unwrap();
        if let Some(source) = view
            .0
            .get_mut(id)
            .filter(|source| source.generation == disconnected_generation)
        {
            source.row.name = machine.name;
            source.row.build = machine.build;
            self.start_remote_agent_watch(route, source);
        }
    }

    async fn watch_remote_agents(
        &self,
        machine_id: &str,
        generation: u64,
    ) -> Result<(), RequestFailure> {
        let watch = wire::ForwardParams {
            route: Vec::new(),
            caller: wire::Caller::Terminal {
                machine_id: self.machine_id.clone(),
            },
            request: wire::ForwardRequest::Watch(wire::WatchParams {
                topic: wire::AgentsTopic::NAME.to_string(),
                args: value_of(api_v1::NoArgs {}),
            }),
            time_left_ms: None,
            from_name: None,
            start_result: None,
        };
        let mut subscription = self
            .network
            .watch_with_receipt(machine_id, watch, None)
            .await?;
        let received_at = subscription.received_at;
        let snapshot: AgentsSnapshot = decode_arguments(api::agents_snapshot(
            std::mem::take(&mut subscription.snapshot),
            false,
        ))
        .map_err(|error| RequestFailure::Failed(api::project_error(error), Some(received_at)))?;
        let agents = snapshot
            .agents
            .into_iter()
            .filter(|agent| agent.machine_id == machine_id)
            .map(|mut agent| {
                agent.address = self.agent_address(&agent.reference())?;
                Ok((agent.agent_id.clone(), agent))
            })
            .collect::<Result<BTreeMap<_, _>, ErrorBody>>()
            .map_err(|error| {
                RequestFailure::Failed(api::project_error(error), Some(received_at))
            })?;
        {
            let mut view = self.remote_agents.lock().unwrap();
            let Some(source) = view
                .0
                .get_mut(machine_id)
                .filter(|source| source.generation == generation)
            else {
                return Ok(());
            };
            source.agents = agents;
            source
                .row
                .observe(MachineResponseState::Responded, Some(received_at));
            let _ = self.remote_changes.send(AgentsChange::SyncUpdated {
                machine: source.view(),
            });
        }
        while let Some(change) = subscription.next_with_receipt().await {
            let change = change?;
            let received_at = change.received_at;
            let mut change: AgentsChange =
                decode_arguments(api::agents_change(change.value, false)).map_err(|error| {
                    RequestFailure::Failed(api::project_error(error), Some(received_at))
                })?;
            if let AgentsChange::Updated { agent } = &mut change {
                agent.address = self.agent_address(&agent.reference()).map_err(|error| {
                    RequestFailure::Failed(api::project_error(error), Some(received_at))
                })?;
            }
            let mut view = self.remote_agents.lock().unwrap();
            let Some(source) = view
                .0
                .get_mut(machine_id)
                .filter(|source| source.generation == generation)
            else {
                return Ok(());
            };
            match &change {
                AgentsChange::Updated { agent } if agent.machine_id == machine_id => {
                    source.agents.insert(agent.agent_id.clone(), *agent.clone());
                }
                AgentsChange::Removed {
                    machine_id: source_id,
                    agent_id,
                    ..
                } if source_id == machine_id => {
                    source.agents.remove(agent_id);
                }
                _ => continue,
            };
            let _ = self.remote_changes.send(change);
        }
        Ok(())
    }
}
