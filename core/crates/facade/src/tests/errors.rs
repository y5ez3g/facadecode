//! The error catalog's lines, and how a service's failure becomes a catalog row or keeps the
//! service's words.

use std::path::PathBuf;

use facade_base::jsonrpc::{ErrorBody, Reason};

use facade_base::machine::{ExecutionOutcome, MachineIdentity, Unavailable};

use crate::errors::{Change, Problem, about_agent, about_change, words};

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
            Problem::NotInteractive { given: given("a3") },
            "error: 'facade attach' needs an interactive terminal\n  tip: run 'facade screen a3' to \
             see its recent output",
            1,
        ),
        (
            Problem::MissingCli {
                available: vec![given("example")],
            },
            "error: choose a CLI to start\n  tip: available CLIs: example",
            2,
        ),
        (
            Problem::UnknownStartOption {
                option: given("--unrecognized"),
            },
            "error: unexpected option '--unrecognized' before the CLI\n  tip: put CLI-specific \
             options after the CLI name",
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
        (
            Problem::NotDelivered {
                message: given("m42@laptop"),
                to: given("a3@laptop"),
                why: given("a draft held the input until the deadline; nothing was typed"),
            },
            "error: m42@laptop was not delivered to a3@laptop: a draft held the input until the \
             deadline; nothing was typed",
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

#[test]
fn an_unconfirmed_delivery_says_where_to_look() {
    let said = Problem::Unconfirmed {
        message: given("m42"),
        to: given("a3"),
        progress: given("the text was pasted and Enter was sent"),
    }
    .to_string();
    let (error, tip) = said.split_once('\n').expect("an error and a tip");
    assert!(
        error.starts_with("error: could not confirm delivery of m42 to a3")
            && error.contains("the text was pasted and Enter was sent"),
        "{said}"
    );
    assert_eq!(
        tip,
        "  tip: run 'facade screen a3' and look for m42 in the input box or recent output before \
         sending it again"
    );
}

/// A service failure, as the command's call returns it.
fn refused(reason: Reason, message: &str) -> anyhow::Error {
    anyhow::Error::new(ErrorBody::new(reason, message))
}

#[test]
fn a_service_refusal_keeps_its_diagnostic_and_lists_its_candidates() {
    let row = |given: &str, reason: Reason, message: &str| {
        words(&about_agent(given, refused(reason, message)))
    };
    assert_eq!(
        row("a9", Reason::NotFound, "no agent a9"),
        "error: no agent a9"
    );

    let mut multiple = ErrorBody::new(
        Reason::AmbiguousReference,
        "more than one agent matches Ada",
    );
    multiple.data.candidates = ["a1@laptop", "a2@gpu"].map(given).to_vec();
    assert_eq!(
        words(&about_agent("Ada", multiple.into())),
        "error: more than one agent matches Ada\n  tip: choose a1@laptop, a2@gpu"
    );

    assert_eq!(
        row(
            "a1",
            Reason::PartialInput,
            "a1@laptop ended after 3 of 9 characters were typed"
        ),
        "error: a1@laptop ended after 3 of 9 characters were typed"
    );
    assert_eq!(
        row(
            "a1",
            Reason::Unavailable,
            "a1@laptop has no recorded session"
        ),
        "error: a1@laptop has no recorded session"
    );
}

#[test]
fn a_send_to_an_ended_agent_names_the_agent_the_service_gives() {
    let mut ended = ErrorBody::new(Reason::Ended, "a2@gpu has ended");
    ended.data.candidates = vec![given("a2@gpu")];
    assert_eq!(
        words(&about_agent("bob", ended.into())),
        "error: a2@gpu has ended\n  tip: run 'facade screen a2@gpu' for the last screen or \
         'facade resume a2@gpu' to continue"
    );
}

#[test]
fn a_settings_file_that_cannot_be_used_gets_the_fix_tip() {
    let said = words(&refused(
        Reason::ConfigurationInvalid,
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
            Problem::SshFailed {
                destination: given("gpu"),
                why: given("Permission denied (publickey)."),
            },
            "error: could not connect to gpu over SSH: Permission denied (publickey).\n  tip: run \
             'ssh gpu' to check that you can log in",
        ),
        (
            Problem::NoFacade {
                destination: given("gpu"),
            },
            "error: could not find facade on gpu\n  tip: run the Facade Code installer on gpu and try again",
        ),
        (
            Problem::Version {
                machine: given("gpu"),
                theirs: given("0.1.5"),
                ours: given("0.1.7"),
            },
            "error: gpu runs Orchestrator 0.1.5, which cannot connect to 0.1.7\n  tip: install \
             Facade Code 0.1.7 on gpu",
        ),
        (
            Problem::SshLogin {
                machine: given("gpu"),
                repair: ["facade", "machine", "add", "gpu"].map(given).to_vec(),
            },
            "error: SSH to gpu needs you to log in\n  tip: run 'facade machine add gpu'",
        ),
        (
            Problem::MachineStoppedResponding {
                machine: given("gpu"),
                change: Some((Change::Stop, given("a17@gpu"))),
            },
            "error: could not confirm that a17@gpu stopped: gpu stopped responding\n  tip: run \
             'facade inspect a17@gpu' to check",
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
}

/// A call that never reached the agent's machine says so for the agent `stop` was given.
#[test]
fn an_unreachable_machine_names_what_was_not_done() {
    let mut body = ErrorBody::new(Reason::Unavailable, "gpu: The request did not run.");
    body.data.unavailable = Some(Unavailable {
        execution: ExecutionOutcome::OutcomeUnknown,
        machine: Some(MachineIdentity {
            machine_id: given("3f9a2c1d-0000-4000-8000-000000000000"),
            name: given("gpu"),
        }),
        window: None,
        matches: Vec::new(),
        unanswered: Vec::new(),
    });
    let error = about_change("a17@gpu", Change::Remove, body.into());
    assert_eq!(
        words(&error),
        "error: could not confirm that a17@gpu was removed: gpu stopped responding\n  tip: run \
         'facade inspect a17@gpu' to check"
    );
}

/// `stop` of a name that some machines did not answer says which, as any command does.
#[test]
fn a_name_search_some_machines_did_not_answer_names_them_for_stop() {
    let mut body = ErrorBody::new(
        Reason::Unavailable,
        "not every machine answered the search for Pixel",
    );
    body.data.unavailable = Some(Unavailable {
        execution: ExecutionOutcome::NotExecuted,
        machine: None,
        window: None,
        matches: Vec::new(),
        unanswered: vec![MachineIdentity {
            machine_id: given("3f9a2c1d-0000-4000-8000-000000000000"),
            name: given("gpu"),
        }],
    });
    let error = about_change("Pixel", Change::Stop, body.into());
    assert_eq!(
        words(&error),
        "error: not every machine answered the search for Pixel"
    );
}
