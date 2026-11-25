//! Calling the daemon for a verified actor and projecting its typed result.

use std::time::{Duration, Instant};

use facade_base::api_v1::{self, daemon::DaemonCall};

use super::{ActorIdentity, Relay};
use crate::{Cancel, delivery::SendControl, service::CallResult};

/// The maximum time used for a tool's daemon query.
pub(super) const CALL_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn call(
    relay: &Relay,
    actor: &ActorIdentity,
    operation: DaemonCall,
    deadline: Option<Instant>,
) -> Result<CallResult, api_v1::ErrorBody> {
    (relay.verified.services.call)(
        &actor.reference,
        operation,
        SendControl {
            deadline,
            ..SendControl::default()
        },
        Cancel::default(),
    )
    .await
}

pub(super) async fn query(
    relay: &Relay,
    actor: &ActorIdentity,
    operation: DaemonCall,
    deadline: Instant,
) -> Result<CallResult, api_v1::ErrorBody> {
    tokio::time::timeout_at(deadline.into(), call(relay, actor, operation, None))
        .await
        .map_err(|_| {
            crate::api::error(
                "unavailable",
                "Facade did not answer the query within its time",
            )
        })?
}

/// A response that crossed a machine connection has already been serialized by its holder.
macro_rules! result {
    ($response:expr, $variant:ident) => {
        match $response {
            Ok(crate::service::CallResult::$variant(result)) => Ok(result),
            Ok(crate::service::CallResult::Wire(result)) => {
                facade_base::api_v1::decode_arguments(result)
            }
            Ok(_) => Err(crate::api::error(
                "internal",
                "Facade returned the result of a different operation",
            )),
            Err(error) => Err(error),
        }
    };
}

pub(super) use result;
