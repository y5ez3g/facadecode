//! Wake requests use a remembered path and ask each machine to open its own saved connection.

use std::collections::BTreeSet;

use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::{ExecutionOutcome, MachineIdentity};
use facade_base::v3;

use super::Network;
use super::routes::is_uuid_v4;
use super::session::Reply;
use super::topology::Link;
use super::wire::{self, Forward};

/// Internal to authenticated machine sessions.
const ENSURE_ROUTE: &str = "machine.ensure_route";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RouteAttempt {
    Passive,
    Wake,
}

impl RouteAttempt {
    fn method(self) -> &'static str {
        match self {
            Self::Passive => v3::MACHINE_PROBE_ROUTE,
            Self::Wake => ENSURE_ROUTE,
        }
    }

    pub(super) fn for_method(method: &str) -> Option<Self> {
        match method {
            v3::MACHINE_PROBE_ROUTE => Some(Self::Passive),
            ENSURE_ROUTE => Some(Self::Wake),
            _ => None,
        }
    }
}

impl Network {
    pub(crate) fn remembered_route(&self, machine_id: &str) -> Option<Vec<String>> {
        let state = self.0.state.lock().unwrap();
        state.remembered_routes.get(machine_id).cloned()
    }

    pub(crate) fn remember_route(&self, machine_id: String, route: Vec<String>) {
        let mut state = self.0.state.lock().unwrap();
        let mut seen = BTreeSet::from([state.local.machine_id.as_str()]);
        if route.len() > 1
            && route.last() == Some(&machine_id)
            && route
                .iter()
                .all(|hop| is_uuid_v4(hop) && seen.insert(hop.as_str()))
        {
            state.remembered_routes.insert(machine_id, route);
        }
    }

    pub(crate) async fn ensure_route(&self, machine_id: &str) -> Result<(), ErrorBody> {
        self.open_route(machine_id, RouteAttempt::Wake).await
    }

    pub(crate) async fn probe_route(&self, machine_id: &str) -> Result<(), ErrorBody> {
        self.open_route(machine_id, RouteAttempt::Passive).await
    }

    pub(crate) fn query_machines(&self) -> Vec<String> {
        self.0.state.lock().unwrap().query_machines()
    }

    pub(crate) fn route_supports(&self, machine_id: &str, capability: &str) -> bool {
        self.0
            .state
            .lock()
            .unwrap()
            .route_supports(machine_id, capability)
    }

    async fn open_route(&self, machine_id: &str, attempt: RouteAttempt) -> Result<(), ErrorBody> {
        let (route, identity) = {
            let state = self.0.state.lock().unwrap();
            if machine_id == state.local.machine_id || state.route(machine_id).is_some() {
                return Ok(());
            }
            let identity = state.identity(machine_id);
            let route = state.wake_path(machine_id).ok_or_else(|| {
                wire::unavailable(
                    identity.clone(),
                    ExecutionOutcome::NotExecuted,
                    "There is no saved route to this machine.",
                )
            })?;
            (route, identity)
        };
        let first = &route[0];
        self.open_saved_hop(first, attempt).await?;
        if route.len() == 1 {
            return Ok(());
        }
        let peer = {
            let state = self.0.state.lock().unwrap();
            if attempt == RouteAttempt::Passive && state.route(machine_id).is_some() {
                return Ok(());
            }
            let link = state.direct_link(first).ok_or_else(|| {
                wire::unavailable(
                    identity.clone(),
                    ExecutionOutcome::NotExecuted,
                    "The first machine on the saved route disconnected.",
                )
            })?;
            if attempt == RouteAttempt::Passive && !link.peer.supports(v3::CAP_MACHINE_PROBE_ROUTE)
            {
                return legacy_probe(link, &route, identity);
            }
            link.peer.clone()
        };
        let forward = Forward::control(route, attempt.method());
        match peer
            .request(forward, None, identity.clone())?
            .answer(None)
            .await?
        {
            Reply::Call { result, .. } => result?,
            Reply::Watch { .. } => {
                return Err(ErrorBody::invalid_argument(match attempt {
                    RouteAttempt::Passive => "Expected a probe response.",
                    RouteAttempt::Wake => "Expected a wake response.",
                }));
            }
        };
        if self.0.state.lock().unwrap().route(machine_id).is_some() {
            Ok(())
        } else {
            Err(wire::unavailable(
                identity,
                ExecutionOutcome::NotExecuted,
                "The saved route was not established.",
            ))
        }
    }
}

/// Legacy sessions can forward over an established path but cannot open one passively.
pub(super) fn legacy_probe(
    link: &Link,
    route: &[String],
    identity: MachineIdentity,
) -> Result<(), ErrorBody> {
    if let Some(row) = link.table.get(&identity.machine_id)
        && row.route.as_deref() == Some(route)
    {
        return Ok(());
    }
    Err(wire::unavailable(
        identity,
        ExecutionOutcome::NotExecuted,
        "A machine on the route does not support probing for a connection.",
    ))
}
