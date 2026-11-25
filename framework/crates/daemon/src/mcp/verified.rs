//! The actor and daemon operations of a relay.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

use facade_base::api_v1;
use facade_base::api_v1::daemon as wire;
use facade_base::api_v1::daemon::AgentKind;
use facade_base::model::agent::AgentRef;
use facade_base::model::error::ErrorBody;
use serde_json::Value;
use tokio::sync::Mutex;

use super::{InboxAnswer, InboxOutput, Relay};
use crate::{
    Cancel,
    delivery::SendControl,
    messages::{InboxRead, ReplyRead},
    service::CallResult,
};

#[derive(Clone)]
pub(crate) struct ActorIdentity {
    pub(crate) reference: AgentRef,
    pub(crate) kind: AgentKind,
    pub(crate) receives_terminal_messages: bool,
}

pub(crate) type ActorFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub(crate) type Authenticate = Box<
    dyn for<'a> Fn(
            Option<&'a str>,
            Option<&'a Value>,
            Option<&'a str>,
        ) -> ActorFuture<'a, Result<ActorIdentity, ErrorBody>>
        + Send
        + Sync,
>;

pub(crate) type ActorCall = Box<
    dyn for<'a> Fn(
            &'a AgentRef,
            wire::DaemonCall,
            SendControl,
            Cancel,
        ) -> ActorFuture<'a, Result<CallResult, api_v1::ErrorBody>>
        + Send
        + Sync,
>;

pub(crate) type ReadInbox = Box<
    dyn for<'a> Fn(
            &'a AgentRef,
            InboxRead,
            Cancel,
            Option<InboxOutput>,
        ) -> ActorFuture<'a, Result<InboxAnswer, ErrorBody>>
        + Send
        + Sync,
>;

pub(crate) type ReadReply = Box<
    dyn for<'a> Fn(
            &'a AgentRef,
            ReplyRead,
            Cancel,
            Option<InboxOutput>,
        ) -> ActorFuture<'a, Result<InboxAnswer, ErrorBody>>
        + Send
        + Sync,
>;

pub(crate) type DiscoverClis = Box<
    dyn for<'a> Fn(
            &'a AgentRef,
            &'a [wire::MachineQuery],
            Instant,
        ) -> ActorFuture<'a, BTreeMap<String, Result<Vec<String>, String>>>
        + Send
        + Sync,
>;

pub(crate) type ToolsPresence = Box<dyn Send + Sync>;

/// The instructions for the managed run the daemon verifies during initialization.
pub(crate) type ManagedInstructions = Box<
    dyn for<'a> Fn(Option<&'a str>) -> ActorFuture<'a, Result<Option<String>, ErrorBody>>
        + Send
        + Sync,
>;

/// Holds tools readiness for a run the daemon can verify without joining a Guest.
pub(crate) type Ready = Box<
    dyn for<'a> Fn(Option<&'a str>) -> ActorFuture<'a, anyhow::Result<Option<ToolsPresence>>>
        + Send
        + Sync,
>;

pub(crate) struct ActorServices {
    pub(crate) authenticate: Authenticate,
    pub(crate) call: ActorCall,
    pub(crate) read_inbox: ReadInbox,
    pub(crate) managed_instructions: ManagedInstructions,
    pub(crate) ready: Ready,
}

pub(super) struct Verified {
    pub(super) services: ActorServices,
    pub(super) read_reply: Option<ReadReply>,
    pub(super) discover_clis: Option<DiscoverClis>,
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
            read_reply: None,
            discover_clis: None,
            connection: Mutex::default(),
        }
    }

    pub(super) async fn initialize(
        &self,
        relay: &Relay,
        client_name: Option<&str>,
    ) -> Result<Option<String>, ErrorBody> {
        {
            let mut connection = self.connection.lock().await;
            if connection.actor.is_none() {
                connection.client_name = client_name.map(str::to_string);
            }
        }
        (self.services.managed_instructions)(credential(relay)).await
    }

    pub(super) async fn actor(
        &self,
        relay: &Relay,
        meta: Option<&Value>,
    ) -> Result<ActorIdentity, ErrorBody> {
        let mut connection = self.connection.lock().await;
        if let Some(actor) = &connection.actor {
            return Ok(actor.clone());
        }
        let actor = (self.services.authenticate)(
            credential(relay),
            meta,
            connection.client_name.as_deref(),
        )
        .await?;
        connection.actor = Some(actor.clone());
        Ok(actor)
    }

    pub(super) async fn hold_presence(&self, relay: &Relay) {
        let mut presence = relay.presence.lock().await;
        if presence.is_none() {
            match (self.services.ready)(credential(relay)).await {
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
