//! Reaching the daemon for a tool: opening a connection within a time, and what a failed daemon
//! call answers.

use std::time::{Duration, Instant};

use facade_base::api_v1::{ErrorBody, daemon_client::DaemonClient};
use facade_base::model::error::ErrorBody as RelayError;
use serde_json::Value;

use super::envelope;

/// How long a call waits for the daemon to answer, as a `facade` command does. While an agent runs,
/// the keeper replaces a daemon that ended well within it.
pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a call asks again while the daemon hands over to a newer build.
const RETRY_INTERVAL: Duration = Duration::from_millis(25);

/// A connection from `connect`, waiting up to `timeout` while the daemon hands over to a newer build
/// and takes no new client. A failure result where none opens.
pub(super) fn open_with(
    connect: impl Fn() -> anyhow::Result<Option<DaemonClient>>,
    timeout: Duration,
) -> Result<DaemonClient, Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let unavailable = match connect() {
            Ok(Some(client)) => return Ok(client),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(RETRY_INTERVAL);
                continue;
            }
            Ok(None) => format!(
                "the Orchestrator did not respond within {} seconds; nothing was done",
                timeout.as_secs()
            ),
            Err(err) => {
                if let Some(error) = err.downcast_ref::<ErrorBody>() {
                    return Err(envelope::daemon_refusal(error));
                }
                if let Some(error) = err.downcast_ref::<RelayError>() {
                    return Err(envelope::refusal(error));
                }
                format!("cannot reach Facade: {err:#}; nothing was done")
            }
        };
        return Err(envelope::failure("unavailable", unavailable));
    }
}

/// What a failed daemon call answers: the daemon's refusal, which changed nothing, or, for a call
/// cut off after it went out, `consequence`, which says what it may have changed.
pub(super) fn failed(err: &anyhow::Error, consequence: &str) -> Value {
    if let Some(error) = err.downcast_ref::<ErrorBody>() {
        return envelope::daemon_refusal(error);
    }
    envelope::failure(
        "unavailable",
        format!("Facade stopped answering before it finished: {err:#}; {consequence}"),
    )
}
