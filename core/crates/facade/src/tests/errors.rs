//! The error catalog's lines, and how a service's failure becomes a catalog row or keeps the
//! service's words.

use std::path::PathBuf;

use facade_base::api_v1::daemon::{AgentLabel, SendWait};
use facade_base::api_v1::{ErrorBody, ErrorData};
use serde_json::{Value, json};

use crate::errors::{
    AgentCommand, Problem, about_connection, agent_failed, exit_code, send_failed, stop_diagnostic,
    stop_failed, words,
};

fn given(text: &str) -> String {
    text.to_string()
}

/// Every row of the catalog the command line words without a service, and its exit code.
#[test]
fn each_catalog_row_prints_its_error_and_tip() {
    let rows: Vec<(Problem, &str, i32)> = vec![
        (
            Problem::Ended {
                diagnostic: given("a3@laptop has ended"),
                agent: given("a3@laptop"),
            },
            "error: a3@laptop has ended\n  tip: run 'facade screen a3@laptop' for the last \
             screen or 'facade resume a3@laptop' to continue",
            1,
        ),
        (
            Problem::MissingCli {
                available: vec![given("example")],
            },
            concat!(
                "error: Choose a coding CLI to start.\n",
                "Available CLIs: example\n",
                "Usage: facade start [OPTIONS] <CLI> [CLI_ARGS]...\n",
                "Example: facade start codex\n",
                "Run 'facade start --help' for all options."
            ),
            2,
        ),
        (
            Problem::Settings {
                diagnostic: given("/home/you/.facade/facade.json:3:7: expected a string"),
            },
            "error: could not use the settings file: /home/you/.facade/facade.json:3:7: expected a \
             string\n  tip: fix the settings file and try again",
            1,
        ),
    ];
    for (problem, lines, code) in rows {
        assert_eq!(problem.to_string(), lines, "{problem:?}");
        assert_eq!(problem.exit_code(), code, "{problem:?}");
    }
}

#[test]
fn an_unreachable_orchestrator_names_the_log_to_check() {
    let log = PathBuf::from("/home/you/.facade/core/logs/keeper.log");
    let problem = Problem::Unreachable {
        why: given("the Orchestrator keeper exited before it started"),
        log: Some(log.clone()),
    };
    assert_eq!(
        problem.to_string(),
        format!(
            "error: could not connect to the Orchestrator: the Orchestrator keeper exited before it started\n  \
             tip: check '{}' for details",
            log.display()
        )
    );
    let problem = Problem::Unreachable {
        why: given("permission denied"),
        log: None,
    };
    assert_eq!(
        problem.to_string(),
        "error: could not connect to the Orchestrator: permission denied"
    );
}

/// A service failure, as the command's call returns it.
fn refused(reason: &str, message: &str) -> anyhow::Error {
    refusal(reason, message, Value::Null).into()
}

fn refusal(reason: &str, message: &str, details: Value) -> ErrorBody {
    ErrorBody {
        code: -32000,
        message: given(message),
        data: ErrorData {
            reason: given(reason),
            details: details.as_object().cloned(),
        },
    }
}

fn agent_label(
    agent_id: &str,
    machine: &str,
    name: &str,
    state: &str,
    resumable: bool,
) -> AgentLabel {
    serde_json::from_value(json!({
        "reference": { "agent_id": agent_id, "machine_id": machine },
        "address": format!("{agent_id}@{machine}"), "name": name, "cli": "fake",
        "type": if state == "online" { "guest" } else { "managed" },
        "state": state, "resumable": resumable,
    }))
    .expect("a public agent label")
}

#[test]
fn a_service_refusal_keeps_its_diagnostic_and_lists_its_candidates() {
    let row = |given: &str, reason: &str, message: &str| {
        words(&agent_failed(
            AgentCommand::Screen,
            given,
            refused(reason, message),
        ))
    };
    assert_eq!(
        row("a9", "not_found", "no agent a9"),
        "error: No agent or guest matches \"a9\".\nRun 'facade list' to find an agent."
    );
    let missing = agent_failed(
        AgentCommand::Stop,
        "nobody",
        refused("not_found", "no agent nobody"),
    );
    assert_eq!(
        stop_diagnostic(&missing, true),
        (
            given("error: No active agent or guest matches \"nobody\"."),
            Some("Run 'facade list' to check active agents."),
        )
    );
    let guest = stop_failed(
        "a5@laptop",
        Some(&agent_label("a5", "laptop", "Cursor", "online", false)),
        refusal("unsupported", "a5@laptop is a guest", Value::Null),
    );
    let guest_line = "error: Cursor (a5@laptop) is a guest and cannot be stopped by Facade.";
    assert_eq!(
        stop_diagnostic(&guest, false),
        (
            format!("{guest_line}\nStop it from the application running it."),
            None,
        )
    );
    assert_eq!(stop_diagnostic(&guest, true), (given(guest_line), None));

    let candidates = json!({ "candidates": ["a1@laptop", "a2@gpu"] });
    let multiple = refusal(
        "ambiguous_reference",
        "more than one agent matches Ada",
        candidates.clone(),
    );
    assert_eq!(
        words(&agent_failed(AgentCommand::Screen, "Ada", multiple.into())),
        "error: more than one agent matches Ada\n  tip: choose a1@laptop, a2@gpu"
    );

    let mut details = candidates;
    details["agents"] = json!([
        agent_label("a1", "laptop", "Ada", "idle", false),
        agent_label("a2", "gpu", "Ada", "working", false),
    ]);
    let multiple = refusal(
        "ambiguous_reference",
        "more than one agent matches Ada",
        details,
    );
    let error = agent_failed(AgentCommand::Screen, "Ada", multiple.into());
    let text = words(&error);
    assert!(text.starts_with("error: More than one active agent or guest is named \"Ada\"."));
    for candidate in ["a1@laptop", "a2@gpu", "Idle", "Working"] {
        assert!(text.contains(candidate), "{text}");
    }
    assert!(text.ends_with("Use an exact agent reference.\nExample: facade screen a1@laptop"));
    assert_eq!(exit_code(&error), 1);

    assert_eq!(
        row(
            "a1",
            "partial_input",
            "a1@laptop ended after 3 of 9 characters were typed"
        ),
        "error: a1@laptop ended after 3 of 9 characters were typed"
    );
    assert_eq!(
        row("a1", "unavailable", "a1@laptop has no recorded session"),
        "error: a1@laptop has no recorded session"
    );
}

#[test]
fn a_send_to_an_ended_agent_names_the_agent_the_service_gives() {
    let ended = refusal(
        "ended",
        "a2@gpu has ended",
        json!({ "agents": [agent_label("a2", "gpu", "Bob", "ended", true)] }),
    );
    let error = send_failed(SendWait::Delivery, "bob", 30, ended.into());
    assert_eq!(
        words(&error),
        "error: Bob (a2@gpu) has stopped and cannot receive messages.\n\
         Resume it with 'facade resume a2@gpu'."
    );
    assert_eq!(exit_code(&error), 1);
}

#[test]
fn a_settings_file_that_cannot_be_used_gets_the_fix_tip() {
    let said = words(&refused(
        "configuration_invalid",
        "/home/you/.facade/facade.json:3:7: expected a string; nothing was done",
    ));
    assert_eq!(
        said,
        "error: could not use the settings file: /home/you/.facade/facade.json:3:7: expected a \
         string\n  tip: fix the settings file and try again"
    );
}

/// The rows of failures between machines, from the facts the command and the service give.
#[test]
fn machine_rows_print_their_error_and_tip() {
    let rows: Vec<(Problem, &str)> = vec![
        (
            Problem::NoFacade {
                destination: given("gpu"),
            },
            "error: could not find facade on gpu\n  tip: run the Facade Code installer on gpu and try again",
        ),
        (
            Problem::SshLogin {
                machine: given("gpu"),
                repair: ["facade", "machine", "add", "gpu"].map(given).to_vec(),
            },
            "error: SSH to gpu needs you to log in\n  tip: run 'facade machine add gpu'",
        ),
        (
            Problem::NoMachine {
                given: given("lab"),
            },
            "error: no machine 'lab'\n  tip: run 'facade machine list' to see your machines",
        ),
    ];
    for (problem, printed) in rows {
        assert_eq!(problem.to_string(), printed);
        assert_eq!(problem.exit_code(), 1);
    }
    let message = "No offered API version is supported.";
    let incompatible = refusal(
        "protocol_incompatible",
        message,
        json!({ "supported_api_versions": [1] }),
    );
    let error = about_connection("gpu", incompatible.into());
    assert_eq!(words(&error), format!("error: {message}"));
    assert_eq!(exit_code(&error), 1);
}

/// A stop of a resolved agent whose machine stopped responding reports an unconfirmed exit.
#[test]
fn an_unconfirmed_remote_stop_names_the_resolved_agent() {
    let body = refusal(
        "unavailable",
        "gpu stopped responding",
        json!({
            "execution": "outcome_unknown",
            "machine": { "machine_id": "3f9a2c1d-0000-4000-8000-000000000000", "name": "gpu" },
        }),
    );
    let agent = agent_label("a17", "gpu", "Pixel", "idle", false);
    let error = stop_failed("a17@gpu", Some(&agent), body);
    assert_eq!(
        words(&error),
        "error: Could not confirm that Pixel (a17@gpu) stopped. Check it with 'facade status a17@gpu'."
    );
}

/// `stop` of a name that some machines did not answer says which, as any command does.
#[test]
fn a_name_search_some_machines_did_not_answer_names_them_for_stop() {
    let body = refusal(
        "unavailable",
        "not every machine answered the search for Pixel",
        json!({
            "execution": "not_executed",
            "unanswered": [{ "machine_id": "3f9a2c1d-0000-4000-8000-000000000000", "name": "gpu" }],
        }),
    );
    let error = agent_failed(AgentCommand::Stop, "Pixel", body.into());
    assert_eq!(
        words(&error),
        "error: not every machine answered the search for Pixel"
    );
}
