//! Wake requests use a remembered path and ask each machine to open its own saved connection.

use std::collections::BTreeSet;

use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::ExecutionOutcome;

use super::Network;
use super::routes::is_uuid_v4;
use super::session::Reply;
use super::wire::{self, Forward};

/// Internal to authenticated machine sessions.
pub(super) const METHOD: &str = "machine.ensure_route";

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
        self.ensure_saved_hop(first).await?;
        if route.len() == 1 {
            return Ok(());
        }
        let peer = self
            .0
            .state
            .lock()
            .unwrap()
            .direct(first)
            .cloned()
            .ok_or_else(|| {
                wire::unavailable(
                    identity.clone(),
                    ExecutionOutcome::NotExecuted,
                    "The first machine on the saved route disconnected.",
                )
            })?;
        let forward = Forward::control(route, METHOD);
        match peer
            .request(forward, None, identity.clone())?
            .answer(None)
            .await?
        {
            Reply::Call { result, .. } => result?,
            Reply::Watch { .. } => {
                return Err(ErrorBody::invalid_argument("Expected a wake response."));
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
