//! The connected machines' contributions to this home's editor agent views.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use facade_base::address::{display_machine_selector, exact_machine_selector};
use facade_base::daemon::{
    AgentInfo, AgentMachineView, AgentsChange, AgentsSnapshot, AgentsTopic, AgentsUpdate,
    AgentsWatchArgs, WatchParams,
};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{
    AgentRef, Caller, MachineIdentity, MachineInfo, MachineResponseState, MachineStateRow,
};
use facade_base::operations::Topic;
use tokio::task::AbortHandle;

use crate::Daemon;
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
    fn view(&self) -> AgentMachineView {
        AgentMachineView {
            row: self.row.clone(),
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
    pub(crate) fn remote_agent_states(&self) -> Vec<AgentMachineView> {
        self.remote_agents
            .lock()
            .unwrap()
            .0
            .values()
            .map(Source::view)
            .collect()
    }

    /// Replaces a subscription when its route changes. An unavailable machine contributes state.
    pub(crate) fn follow_remote_agents(self: &Arc<Self>, machines: &[MachineInfo]) {
        let mut view = self.remote_agents.lock().unwrap();
        for (id, source) in view.0.iter_mut() {
            if !source.row.unreachable
                && !machines
                    .iter()
                    .any(|row| &row.machine_id == id && !row.is_unreachable())
            {
                source.reset(MachineResponseState::Unreachable, None);
                let _ = self.changes.send(AgentsUpdate::MachineState {
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
                row: MachineStateRow::from(row),
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
        let _ = self.changes.send(AgentsUpdate::MachineState {
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
                            let error = ErrorBody::from(failure);
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
                    let _ = daemon.changes.send(AgentsUpdate::MachineState {
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
            .machines()
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
        let args = AgentsWatchArgs {
            member_machine_id: Some(self.machine_id.clone()),
        };
        let caller = Caller::Terminal {
            machine_id: self.machine_id.clone(),
        };
        let watch = WatchParams {
            topic: AgentsTopic::NAME.to_string(),
            args: value_of(args),
        };
        let mut subscription = self
            .network
            .watch_with_receipt(machine_id, caller, watch, None)
            .await?;
        let received_at = subscription.received_at;
        let snapshot: AgentsSnapshot = decode_arguments(std::mem::take(&mut subscription.snapshot))
            .map_err(|error| RequestFailure::Failed(error, Some(received_at)))?;
        let machines = self
            .machine_table()
            .map_err(|error| RequestFailure::Failed(error, Some(received_at)))?;
        let agents = snapshot
            .agents
            .into_iter()
            .filter(|agent| self.remote_member(agent, machine_id))
            .map(|mut agent| {
                self.project_agent(&mut agent, &machines);
                (agent.agent_id.clone(), agent)
            })
            .collect();
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
            let _ = self.changes.send(AgentsUpdate::MachineState {
                machine: source.view(),
            });
        }
        while let Some(change) = subscription.next_with_receipt().await {
            let change = change?;
            let received_at = change.received_at;
            let mut change: AgentsChange = decode_arguments(change.value)
                .map_err(|error| RequestFailure::Failed(error, Some(received_at)))?;
            if let AgentsChange::Updated { agent } = &mut change {
                let machines = self
                    .machine_table()
                    .map_err(|error| RequestFailure::Failed(error, Some(received_at)))?;
                self.project_agent(agent, &machines);
            }
            let mut view = self.remote_agents.lock().unwrap();
            let Some(source) = view
                .0
                .get_mut(machine_id)
                .filter(|source| source.generation == generation)
            else {
                return Ok(());
            };
            let update = match change {
                AgentsChange::Updated { agent } if self.remote_member(&agent, machine_id) => {
                    source.agents.insert(agent.agent_id.clone(), *agent.clone());
                    AgentsUpdate::Updated { agent }
                }
                AgentsChange::Removed {
                    machine_id: source_id,
                    agent_id,
                } if source_id == machine_id => {
                    source.agents.remove(&agent_id);
                    AgentsUpdate::Removed {
                        machine_id: source_id,
                        agent_id,
                    }
                }
                _ => continue,
            };
            let _ = self.changes.send(update);
        }
        Ok(())
    }

    fn remote_member(&self, agent: &AgentInfo, machine_id: &str) -> bool {
        agent.machine_id == machine_id
            && !agent.guest
            && agent
                .windows
                .iter()
                .any(|window| window.machine_id == self.machine_id)
    }

    pub(crate) fn project_agent(&self, agent: &mut AgentInfo, machines: &[MachineInfo]) {
        let reference = AgentRef {
            machine_id: agent.machine_id.clone(),
            agent_id: agent.agent_id.clone(),
        };
        let known: Vec<_> = machines
            .iter()
            .map(|machine| MachineIdentity {
                machine_id: machine.machine_id.clone(),
                name: machine.name.clone(),
            })
            .collect();
        let selector = known
            .iter()
            .find(|identity| identity.machine_id == agent.machine_id)
            .map_or_else(
                || exact_machine_selector(&agent.machine_id),
                |identity| display_machine_selector(identity, &known),
            );
        agent.address = Some(reference.address(&selector));
        agent.label = Some(reference.label(&self.machine_id, &selector));
        agent.unreachable = agent.machine_id != self.machine_id
            && !machines
                .iter()
                .any(|machine| machine.machine_id == agent.machine_id && !machine.is_unreachable());
    }
}
