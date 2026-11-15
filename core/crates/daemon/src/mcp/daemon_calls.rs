//! Reaching the daemon for a tool: who a connection is, opening one within a time, and what a
//! failed daemon call answers.

use std::time::{Duration, Instant};

use facade_base::daemon::ClientKind;
use facade_base::daemon_client::{DaemonClient, Identity};
use facade_base::jsonrpc::ErrorBody;
use serde_json::Value;

use super::Relay;
use super::envelope;

/// How long a call waits for the daemon to answer, as a `facade` command does. While an agent runs,
/// the keeper replaces a daemon that ended well within it.
pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a call asks again while the daemon hands over to a newer build.
const RETRY_INTERVAL: Duration = Duration::from_millis(25);

/// A connection as the MCP server of `agent`: its calls act for that agent.
pub(super) fn as_agent(agent: &str) -> Identity {
    Identity {
        kind: ClientKind::Mcp,
        agent: Some(agent.to_string()),
        sessions: Vec::new(),
    }
}

/// A connection that acts for no agent, as a `facade` command's does. It reads without telling the
/// daemon that any agent's tools are there.
pub(super) fn as_command() -> Identity {
    Identity {
        kind: ClientKind::Terminal,
        agent: None,
        sessions: Vec::new(),
    }
}

/// A connection for `identity`, waiting up to `timeout` while the daemon hands over to a newer build
/// and takes no new client. A failure result where none opens.
pub(super) fn open(
    relay: &Relay,
    identity: &Identity,
    timeout: Duration,
) -> Result<DaemonClient, Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let unavailable = match (relay.connect)(identity) {
            Ok(Some(client)) => return Ok(client),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(RETRY_INTERVAL);
                continue;
            }
            Ok(None) => format!(
                "Facade did not answer within {} seconds; nothing was done",
                timeout.as_secs()
            ),
            Err(err) => match err.downcast_ref::<ErrorBody>() {
                Some(error) => return Err(envelope::refusal(error)),
                None => format!("cannot reach Facade: {err:#}; nothing was done"),
            },
        };
        return Err(envelope::failure("unavailable", unavailable));
    }
}

/// A connection as the MCP server of `agent`, within the usual 10 seconds.
pub(super) fn open_as_agent(relay: &Relay, agent: &str) -> Result<DaemonClient, Value> {
    open(relay, &as_agent(agent), CONNECT_TIMEOUT)
}

/// What a failed daemon call answers: the daemon's refusal, which changed nothing, or, for a call
/// cut off after it went out, `consequence`, which says what it may have changed.
pub(super) fn failed(err: &anyhow::Error, consequence: &str) -> Value {
    if let Some(error) = err.downcast_ref::<ErrorBody>() {
        return envelope::refusal(error);
    }
    envelope::failure(
        "unavailable",
        format!("Facade stopped answering before it finished: {err:#}; {consequence}"),
    )
}
