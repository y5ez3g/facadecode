//! Reaching the daemon for a tool: who a connection is, opening one within a time, and what a
//! failed daemon call answers.

use std::time::{Duration, Instant};

use facade_base::address::{AgentAddress, display_machine_selector, parse_agent_address};
use facade_base::daemon::ClientKind;
use facade_base::daemon_client::{DaemonClient, Identity};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{AgentRef, MachineIdentity, MachineList};
use facade_base::operations::NoArgs;
use serde_json::{Value, json};

use super::Relay;
use super::addresses::Addresses;
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
    open_with(|| (relay.legacy().connect)(identity), timeout)
}

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

/// Formats a numbered target in a lookup refusal. Routing passes the target's bare ID to
/// the lookup, while a tool answer displays the ID from the caller's machine.
pub(super) fn agent_failed(
    client: &mut DaemonClient,
    err: &anyhow::Error,
    requested: &str,
    consequence: &str,
    timeout: Option<Duration>,
) -> Value {
    let Some(error) = err.downcast_ref::<ErrorBody>() else {
        return failed(err, consequence);
    };
    let mut reply = envelope::refusal_with_addresses(
        error,
        &Addresses {
            here: &client.hello_result.machine_id,
            machines: &[],
        },
    );
    if let Some(message) = missing_agent_message(client, error, requested, timeout) {
        reply["message"] = json!(message);
    }
    reply
}

fn missing_agent_message(
    client: &mut DaemonClient,
    error: &ErrorBody,
    requested: &str,
    timeout: Option<Duration>,
) -> Option<String> {
    if error.data.reason != Reason::NotFound {
        return None;
    }
    let (id, details) = error.message.strip_prefix("no agent ")?.split_once(';')?;
    let digits = id.strip_prefix('a')?;
    if digits.is_empty() || !digits.bytes().all(|digit| digit.is_ascii_digit()) {
        return None;
    }

    let local = client.hello_result.machine_id.clone();
    let label = match parse_agent_address(requested).ok()? {
        AgentAddress::Local(reference) => {
            let number = if reference.starts_with('@') {
                reference.rsplit_once(' ')?.1.strip_prefix('#')?
            } else {
                reference.strip_prefix('#').unwrap_or(reference)
            };
            if number != id && number != digits {
                return None;
            }
            AgentRef {
                machine_id: local.clone(),
                agent_id: id.to_string(),
            }
            .label(&local, "")
        }
        AgentAddress::Qualified { agent, machine, .. } if agent == id => {
            let machines = machine_identities(client, timeout);
            let mut matched = machines.iter().filter(|row| machine.matches(row));
            match (matched.next(), matched.next()) {
                (Some(row), None) => AgentRef {
                    machine_id: row.machine_id.clone(),
                    agent_id: id.to_string(),
                }
                .label(&local, &display_machine_selector(row, &machines)),
                _ => requested.trim().to_string(),
            }
        }
        _ => return None,
    };
    Some(format!("no agent {label};{details}"))
}

/// Looks up display names without making the caller's result depend on the lookup.
pub(super) fn machine_identities(
    client: &mut DaemonClient,
    timeout: Option<Duration>,
) -> Vec<MachineIdentity> {
    if timeout.is_some()
        && client.writer.set_read_timeout(timeout).is_ok()
        && client.writer.set_write_timeout(timeout).is_ok()
        && let Ok(listed) = client.call::<MachineList>(NoArgs {})
    {
        return listed
            .machines
            .into_iter()
            .map(|machine| MachineIdentity {
                machine_id: machine.machine_id,
                name: machine.name,
            })
            .collect();
    }
    Vec::new()
}
