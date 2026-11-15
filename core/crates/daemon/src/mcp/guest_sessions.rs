//! A guest's server, `facade-mcp --guest <cli>` in a CLI's user configuration, serves the sessions
//! of that CLI the person starts. Each tool call acts for the session it names: in its `_meta`,
//! under the key the CLI's rule names, or in the server's environment, where the CLI starts one
//! server per session. A session Facade does not list yet joins as a guest first, as at its start.

use std::collections::BTreeMap;

use facade_base::daemon::{AgentArgs, AgentInspect, HookSession, HookSessionStart, is_session_id};
use facade_base::process::ProcessState;
use serde_json::Value;

use super::{Relay, Serves, daemon_calls, envelope};

/// Whom `facade-mcp --guest <cli>` serves: the sessions of `cli` that are no Facade run's own, each
/// call acting for the session it names, a session nested in a run included.
///
/// Only some CLIs' runs start the guest's entry for their own session as well
/// ([`facade_rules::runs_start_guest_entry`]). There it serves the run's agent, or steps aside for
/// the run's plugin ([`facade_rules::guest_entry_serves_run`]). A run's own session is known by its
/// ID: the one the daemon records for the run `FACADE_AGENT` names, where the server's CLI names its
/// own session. `FACADE_AGENT` alone decides nothing, as nested processes and shared services
/// inherit it.
pub(super) fn serves(relay: &Relay, cli: &str) -> Serves {
    let in_runs_own_session = facade_rules::runs_start_guest_entry(cli)
        .then(|| relay.variable("FACADE_AGENT"))
        .flatten()
        .and_then(|agent| {
            let recorded = recorded_session(relay, cli, agent)?;
            let own = own_session(relay, cli);
            is_runs_own(recorded.as_deref(), own.as_deref()).then_some(agent)
        });
    match in_runs_own_session {
        None => Serves::Guest(cli.to_string()),
        Some(agent) if facade_rules::guest_entry_serves_run(cli) => {
            Serves::Agent(agent.to_string())
        }
        Some(_) => Serves::Aside,
    }
}

/// The session the daemon records for `agent`, where it is a running agent Facade started with
/// `cli`'s rule: None where it is not, and Some(None) while it records none yet.
fn recorded_session(relay: &Relay, cli: &str, agent: &str) -> Option<Option<String>> {
    let mut client = daemon_calls::open(
        relay,
        &daemon_calls::as_command(),
        daemon_calls::CONNECT_TIMEOUT,
    )
    .ok()?;
    let agent = agent.to_string();
    let info = client.call::<AgentInspect>(AgentArgs { agent }).ok()?.agent;
    let a_run_of_cli = info.cli == cli && !info.guest && info.process == ProcessState::Running;
    a_run_of_cli.then_some(info.session)
}

/// Whether a server whose own session is `own` is in the run's own session, `recorded`: the same
/// session, or either not known, as before the run's start records its session.
fn is_runs_own(recorded: Option<&str>, own: Option<&str>) -> bool {
    match (recorded, own) {
        (Some(recorded), Some(own)) => recorded == own,
        _ => true,
    }
}

/// The session the server's environment names in `cli`'s own variable, as a server started for one
/// session has it. Another CLI's variable names another session: one this CLI runs under.
fn own_session(relay: &Relay, cli: &str) -> Option<String> {
    let variable = facade_rules::session_variable(cli)?;
    let session = relay.variable(variable).filter(|id| is_session_id(id))?;
    Some(session.to_string())
}

/// The session a tool call names in its `_meta`, under the key a CLI's rule names, as a server many
/// sessions share is told it.
fn meta_session(meta: &Value) -> Option<String> {
    facade_rules::session_meta_keys()
        .filter_map(|key| meta.get(key).and_then(Value::as_str))
        .find(|id| is_session_id(id))
        .map(str::to_string)
}

/// What a guest's server tells the model as it starts. A server started for one session joins it
/// now. The model is told its instructions and Facade's skill once: by the server where the CLI's
/// rule says the model takes them from the server alone, and otherwise by the CLI's session-start
/// hook, so that the server tells it nothing.
pub(super) fn at_start(relay: &Relay, cli: &str) -> Option<String> {
    let joined = own_session(relay, cli)
        .filter(|_| !cfg!(test))
        .and_then(|session| join(relay, cli, &session, Some(relay.hello.env.clone())).ok());
    if !facade_rules::instructions_from_server(cli) {
        return None;
    }
    Some(format!(
        "{}\n\n{}",
        facade_base::instructions::for_guest(joined.as_deref()),
        facade_base::skill::text()
    ))
}

/// The agent a tool call of `cli` acts for: the guest of the session the call names, which joins
/// first where Facade does not list it. A failure result where the call names no session, or
/// Facade cannot be reached.
pub(super) fn agent_for_call(relay: &Relay, cli: &str, meta: &Value) -> Result<String, Value> {
    if let Some(session) = meta_session(meta) {
        return join(relay, cli, &session, None);
    }
    match own_session(relay, cli) {
        Some(session) => join(relay, cli, &session, Some(relay.hello.env.clone())),
        None => {
            let message = format!(
                "this tool call names no session of {cli}, so Facade cannot tell whose it is; \
                 nothing was done"
            );
            Err(envelope::failure("configuration_invalid", message))
        }
    }
}

/// The guest of `cli`'s `session`, joining where Facade does not list it yet. `env` is the
/// environment of a server that is the session's own, as its CLI gave it: an agent the guest starts
/// runs with it where no hook gave one. A server many sessions share has the environment of
/// whichever process started it, and gives none.
fn join(
    relay: &Relay,
    cli: &str,
    session: &str,
    env: Option<BTreeMap<String, String>>,
) -> Result<String, Value> {
    let mut client = daemon_calls::open(
        relay,
        &daemon_calls::as_command(),
        daemon_calls::CONNECT_TIMEOUT,
    )?;
    // A CLI whose session ends with its process ends it with the process that runs the relay.
    let pid = facade_rules::session_ends_with_process(cli)
        .then(|| facade_base::unix_process::calling_program_of(relay.pid))
        .flatten();
    let started = client
        .call::<HookSessionStart>(HookSession {
            cli: cli.to_string(),
            session: session.to_string(),
            cwd: relay.hello.cwd.clone(),
            pid,
            parent: None,
            env,
            status_file: None,
        })
        .map_err(|err| daemon_calls::failed(&err, "nothing was done"))?;
    started.agent_id.ok_or_else(|| {
        let message =
            format!("Facade lists {cli}'s session {session} as no guest; nothing was done");
        envelope::failure("unavailable", message)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A server is in a run's own session where its session is the one recorded for the run, or
    /// either is not known yet; a session of its own that differs is nested in the run, a guest's.
    #[test]
    fn a_run_s_own_session_is_known_by_its_id() {
        assert!(is_runs_own(Some("s1"), Some("s1")));
        assert!(!is_runs_own(Some("s1"), Some("nested")));
        assert!(
            is_runs_own(None, Some("s1")),
            "before the run's start records its session"
        );
        assert!(
            is_runs_own(Some("s1"), None),
            "where the CLI names its server no session"
        );
    }

    /// A call's `_meta` names its session under the key a CLI's rule names; anything else names
    /// none.
    #[test]
    fn a_call_names_its_session_as_its_cli_does() {
        for key in facade_rules::session_meta_keys() {
            assert_eq!(
                meta_session(&json!({ key: "ses_e3274d49fffen6SKUCQGgsRrNF" })).as_deref(),
                Some("ses_e3274d49fffen6SKUCQGgsRrNF"),
                "{key}"
            );
        }
        assert_eq!(meta_session(&json!({ "sessionId": "not a session" })), None);
        assert_eq!(meta_session(&json!({ "progressToken": 2 })), None);
    }
}
