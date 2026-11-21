//! Wake requests use a remembered path and ask each machine to open its own saved connection.

use std::collections::BTreeSet;

use facade_base::api_v1::daemon::{
    Caller, ForwardParams, ForwardRequest, InternalEnsureRoute, InternalEnsureRouteArgs,
};
use facade_base::api_v1::{CallParams, EmptyResult, ErrorBody, Operation, decode_arguments};
use facade_base::machine::ExecutionOutcome;
use serde_json::json;

use super::Network;
use super::routes::is_uuid_v4;
use super::session::Reply;
use super::wire;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RouteAttempt {
    Passive,
    Wake,
}

impl RouteAttempt {
    pub(super) fn new(wake: bool) -> Self {
        if wake { Self::Wake } else { Self::Passive }
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

    pub(crate) async fn ensure_route(
        &self,
        machine_id: &str,
        caller: &Caller,
    ) -> Result<(), ErrorBody> {
        self.open_route(machine_id, caller, RouteAttempt::Wake)
            .await
    }

    pub(crate) async fn probe_route(
        &self,
        machine_id: &str,
        caller: &Caller,
    ) -> Result<(), ErrorBody> {
        self.open_route(machine_id, caller, RouteAttempt::Passive)
            .await
    }

    pub(crate) fn query_machines(&self) -> Vec<String> {
        self.0.state.lock().unwrap().query_machines()
    }

    async fn open_route(
        &self,
        machine_id: &str,
        caller: &Caller,
        attempt: RouteAttempt,
    ) -> Result<(), ErrorBody> {
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
            link.peer.clone()
        };
        let forward = ForwardParams {
            route,
            caller: caller.clone(),
            request: ForwardRequest::Call(CallParams {
                op: InternalEnsureRoute::NAME.to_owned(),
                args: json!(InternalEnsureRouteArgs {
                    wake: attempt == RouteAttempt::Wake
                }),
            }),
            time_left_ms: None,
            from_name: None,
            start_result: None,
        };
        match peer
            .request(forward, None, identity.clone())?
            .answer(None)
            .await?
        {
            Reply::Call { result, .. } => {
                decode_arguments::<EmptyResult>(result?)?;
            }
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
