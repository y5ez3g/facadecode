//! Verify live routes and ask each machine on a saved path to open its own connection.

use std::collections::BTreeSet;
use std::sync::Arc;

use facade_base::api_v1::daemon::{
    Caller, ForwardParams, ForwardRequest, InternalEnsureRoute, InternalEnsureRouteArgs,
};
use facade_base::api_v1::{CallParams, EmptyResult, ErrorBody, Operation, decode_arguments};
use facade_base::model::machine::{ExecutionOutcome, MachineIdentity};
use serde_json::json;

use super::routes::is_uuid_v4;
use super::session::Reply;
use super::topology::{LinkRecheck, Topology};
use super::{Network, SessionId, wire};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RouteAttempt {
    Passive,
    Wake,
}

impl RouteAttempt {
    pub(super) fn new(wake: bool) -> Self {
        if wake { Self::Wake } else { Self::Passive }
    }

    fn request(self, route: Vec<String>, caller: Caller) -> ForwardParams {
        ForwardParams {
            route,
            caller,
            request: ForwardRequest::Call(CallParams {
                op: InternalEnsureRoute::NAME.to_owned(),
                args: json!(InternalEnsureRouteArgs {
                    wake: self == Self::Wake
                }),
            }),
            time_left_ms: None,
            from_name: None,
            start_result: None,
        }
    }
}
impl Network {
    /// The replacement can route immediately. Only a response on the earlier stream can put
    /// that stream back in the route table. The earlier session owns the check until it answers,
    /// closes, or is checked again on a subsequent reconnect.
    pub(super) fn recheck_foreground_link(
        &self,
        state: &mut Topology,
        id: SessionId,
        replacement: SessionId,
    ) {
        let caller = Caller::Terminal {
            machine_id: state.local.machine_id.clone(),
        };
        let link = state.links.get_mut(&id).expect("earlier foreground link");
        let machine = MachineIdentity {
            machine_id: link.remote.machine_id.clone(),
            name: link.remote.name.clone(),
        };
        let request = RouteAttempt::Passive.request(vec![machine.machine_id.clone()], caller);
        let Ok(mut pending) = link.peer.request(request, None, machine) else {
            self.withdraw_link(state, id, None);
            return;
        };
        let network = Arc::downgrade(&self.0);
        let task = tokio::spawn(async move {
            if !matches!(pending.answer(None).await, Ok(Reply::Call { .. })) {
                return;
            }
            let Some(network) = network.upgrade() else {
                return;
            };
            let mut state = network.state.lock().unwrap();
            if let Some(link) = state.links.get_mut(&id)
                && link
                    .recheck
                    .as_ref()
                    .is_some_and(|check| check.replacement == replacement)
            {
                link.recheck = None;
                state.publish(&network.events, None);
            }
        });
        link.recheck = Some(LinkRecheck { replacement, task });
    }

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
        let forward = attempt.request(route, caller.clone());
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
