//! The actor-bound connection used by the normal MCP endpoint.

use std::sync::{Mutex, PoisonError};

use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::AgentRef;
use facade_base::v3::AgentKind;
use serde_json::Value;

use super::Relay;
use crate::{Cancel, messages::InboxRead};

#[derive(Clone)]
pub(crate) struct ActorIdentity {
    pub(crate) reference: AgentRef,
    pub(crate) kind: AgentKind,
}

pub(crate) type Authenticate = Box<
    dyn Fn(Option<&str>, Option<&Value>, Option<&str>) -> Result<ActorIdentity, ErrorBody>
        + Send
        + Sync,
>;

pub(crate) type ActorConnect =
    Box<dyn Fn(&AgentRef) -> anyhow::Result<Option<DaemonClient>> + Send + Sync>;

pub(crate) type ReadInbox =
    Box<dyn Fn(&AgentRef, InboxRead, Cancel) -> Result<Value, ErrorBody> + Send + Sync>;

/// Holds a tools-ready connection only for a run the daemon can verify without joining a Guest.
pub(crate) type Ready =
    Box<dyn Fn(Option<&str>) -> anyhow::Result<Option<DaemonClient>> + Send + Sync>;

pub(crate) struct ActorServices {
    pub(crate) authenticate: Authenticate,
    pub(crate) connect: ActorConnect,
    pub(crate) read_inbox: ReadInbox,
    pub(crate) ready: Ready,
}

pub(super) struct Verified {
    pub(super) services: ActorServices,
    connection: Mutex<Connection>,
}

#[derive(Default)]
struct Connection {
    client_name: Option<String>,
    actor: Option<ActorIdentity>,
}

impl Verified {
    pub(super) fn new(services: ActorServices) -> Self {
        Self {
            services,
            connection: Mutex::default(),
        }
    }

    pub(super) fn initialize(&self, client_name: Option<&str>) {
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if connection.actor.is_none() {
            connection.client_name = client_name.map(str::to_string);
        }
    }

    pub(super) fn actor(
        &self,
        relay: &Relay,
        meta: Option<&Value>,
    ) -> Result<ActorIdentity, ErrorBody> {
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(actor) = &connection.actor {
            return Ok(actor.clone());
        }
        let actor = (self.services.authenticate)(
            credential(relay),
            meta,
            connection.client_name.as_deref(),
        )?;
        connection.actor = Some(actor.clone());
        Ok(actor)
    }

    pub(super) fn hold_presence(&self, relay: &Relay) {
        let mut presence = relay
            .presence
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if presence.is_none() {
            match (self.services.ready)(credential(relay)) {
                Ok(held) => *presence = held,
                // The callback can inspect private run material. Keep it out of logs.
                Err(_) => facade_base::log::write(
                    "facade-mcp",
                    "warn",
                    "could not show that the verified run's tools are there",
                ),
            }
        }
    }
}

fn credential(relay: &Relay) -> Option<&str> {
    relay
        .hello
        .args
        .windows(2)
        .find_map(|pair| (pair[0] == facade_rules::RUN_CREDENTIAL_ARG).then_some(pair[1].as_str()))
}
