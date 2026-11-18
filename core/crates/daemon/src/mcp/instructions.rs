//! What the server tells the model as it starts, in the answer to `initialize`. The words are
//! base's; here the server gathers what they name, asking the daemon.

use std::time::Duration;

use facade_base::daemon::{AgentArgs, AgentInspect, WindowsTopic};
use facade_base::instructions::{Run, for_agent, for_mcp_client, place_of};
use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::AgentRef;
use facade_base::operations::NoArgs;

use super::{Relay, Serves, daemon_calls, guest_sessions};

/// How long the instructions wait for the daemon to say who and where their agent is.
const PLACE_TIMEOUT: Duration = Duration::from_secs(2);

/// What a guest's server that steps aside in a Facade run tells the model.
const ASIDE: &str = "This Facade server serves no tools here: the Facade run it started in has a \
                     server of its own.";

/// The instructions for the model of a client the server `serves`, where it tells it any. A client
/// no one serves, named `client` in its `initialize`, joins as a member first; where it cannot, the
/// daemon's refusal.
pub(super) fn at_start(
    relay: &Relay,
    serves: &Serves,
    client: Option<&str>,
) -> Result<Option<String>, ErrorBody> {
    Ok(match serves {
        // Unit tests have no daemon to ask where the agent works.
        Serves::Agent(agent) if cfg!(test) => Some(for_agent(agent, None)),
        Serves::Agent(agent) => Some(read_for_agent(relay, agent)),
        Serves::Guest(cli) => guest_sessions::at_start(relay, cli),
        Serves::Member(member) => Some(for_member(relay, member)),
        Serves::Nobody => Some(for_member(relay, &relay.member_or_join(client)?)),
        Serves::Aside => Some(ASIDE.to_string()),
    })
}

/// The instructions for the CLI of `agent`, with its run as the daemon says now: where it works,
/// who started it, by name where that agent is still listed, and its YOLO. Without its run where
/// the daemon does not answer within two seconds or cannot read them. It reads as a `facade`
/// command does: a connection as the agent's server would tell the daemon that its tools are there
/// before the CLI asked for them.
fn read_for_agent(relay: &Relay, agent: &str) -> String {
    let read = || {
        let mut client =
            daemon_calls::open(relay, &daemon_calls::as_command(), PLACE_TIMEOUT).ok()?;
        let mut inspect = |agent: String| {
            client
                .call::<AgentInspect>(AgentArgs { agent })
                .map(|inspected| inspected.agent)
        };
        let me = inspect(agent.to_string()).ok()?;
        let creator = me.creator.as_ref().map(|id| {
            let machine_id = me.creator_machine_id.as_deref().unwrap_or(&me.machine_id);
            if machine_id == me.machine_id {
                let name = inspect(id.clone()).ok().map(|creator| creator.name);
                return (id.clone(), name);
            }
            let address = AgentRef {
                machine_id: machine_id.to_string(),
                agent_id: id.clone(),
            }
            .exact_address();
            (address.trim_start_matches('#').to_string(), None)
        });
        let windows = client.snapshot::<WindowsTopic>(NoArgs {}).ok()?;
        Some((me, creator, windows))
    };
    let Some((me, creator, windows)) = read() else {
        return for_agent(agent, None);
    };
    let run = Run {
        place: place_of(&me, &windows),
        creator: creator
            .as_ref()
            .map(|(id, name)| (id.as_str(), name.as_deref())),
        yolo: me.yolo,
    };
    for_agent(agent, Some(&run))
}

/// The instructions for member `member`. A member that has just joined has a new ID, so no message
/// waits for it yet; reading its inbox to count them would deliver them.
fn for_member(relay: &Relay, member: &str) -> String {
    let name = daemon_calls::open(relay, &daemon_calls::as_command(), PLACE_TIMEOUT)
        .ok()
        .and_then(|mut client| {
            let agent = member.to_string();
            client.call::<AgentInspect>(AgentArgs { agent }).ok()
        })
        .map(|inspected| inspected.agent.name);
    for_mcp_client(member, name.as_deref().unwrap_or(member), 0)
}
