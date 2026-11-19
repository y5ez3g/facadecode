//! The error catalog's lines, and how a service's failure becomes a catalog row or keeps the
//! service's words.

use std::path::PathBuf;

use facade_base::jsonrpc::{ErrorBody, Reason};

use facade_base::machine::{ExecutionOutcome, MachineIdentity, Unavailable};

use crate::errors::{
    Change, Problem, about_agent, about_change, about_send, bare_id, ended_agent, ended_by_name,
    words,
};

fn given(text: &str) -> String {
    text.to_string()
}

/// Every row of the catalog the command line words without a service, and its exit code.
#[test]
fn each_catalog_row_prints_its_error_and_tip() {
    let rows: Vec<(Problem, &str, i32)> = vec![
        (
            Problem::NoAgent { given: given("a9") },
            "error: no agent 'a9'\n  tip: run 'facade list' to see your agents",
            1,
        ),
        (
            Problem::SeveralNamed {
                given: given("Ada"),
            },
            "error: more than one agent is named 'Ada'\n  tip: run 'facade list' and use the agent's ID",
            1,
        ),
        (
            Problem::HumanCollision {
                given: given("@human"),
                sending: true,
            },
            "error: '@human' matches both the human and an agent named human\n  tip: quote '#human' \
             for the human, or run 'facade list' for the agent's ID",
            1,
        ),
        (
            Problem::HumanCollision {
                given: given("human"),
                sending: false,
            },
            "error: 'human' matches both the human and an agent named human\n  tip: run 'facade \
             list' and use the agent's ID",
            1,
        ),
        (
            Problem::Ended { agent: given("a3") },
            "error: a3 has ended\n  tip: run 'facade inspect a3' to check for a saved session",
            1,
        ),
        (
            Problem::StillRunning { id: given("a3") },
            "error: a3 is still running\n  tip: run 'facade attach a3' to watch it",
            1,
        ),
        (
            Problem::PlainProgram { id: given("a3") },
            "error: a3 was started as a plain program and cannot resume",
            1,
        ),
        (
            Problem::Guest { id: given("a6") },
            "error: a6 was started outside Facade, so Facade cannot control it\n  tip: use the \
             program where the guest is running",
            1,
        ),
        (
            Problem::NotInteractive { given: given("a3") },
            "error: 'facade attach' needs an interactive terminal\n  tip: run 'facade screen a3' to \
             see its recent output",
            1,
        ),
        (
            Problem::NotAgentTerminal,
            "error: 'facade messages' reads an agent's inbox and must run in that agent's \
             terminal\n  tip: messages for the human appear in the editor window",
            1,
        ),
        (
            Problem::UnknownStartOption {
                option: given("--model"),
            },
            "error: unexpected option '--model' before the program\n  tip: put the program's \
             options after its name: 'facade start claude --model opus'",
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
                message: given("m42"),
                to: given("a3"),
                why: given("a draft held #a3's input until the deadline; nothing was typed"),
            },
            "error: m42 was not delivered to a3: a draft held #a3's input until the deadline; \
             nothing was typed",
            1,
        ),
    ];
    for (problem, lines, code) in rows {
        assert_eq!(problem.to_string(), lines, "{problem:?}");
        assert_eq!(problem.exit_code(), code, "{problem:?}");
    }
}

#[test]
fn an_unreachable_facade_names_the_log_to_check() {
    let log = PathBuf::from("/home/you/.facade/core/logs/keeper.log");
    let problem = Problem::Unreachable {
        why: given("the Facade keeper exited before it started"),
        log: Some(log.clone()),
    };
    assert_eq!(
        problem.to_string(),
        format!(
            "error: could not connect to Facade: the Facade keeper exited before it started\n  \
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
        "error: could not connect to Facade: permission denied"
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

#[test]
fn an_id_form_gives_a_bare_id_and_a_name_none() {
    for (given, id) in [
        ("a3", Some("a3")),
        ("#a3", Some("a3")),
        ("3", Some("a3")),
        ("Ada", None),
        ("a", None),
        ("#", None),
        ("a3b", None),
    ] {
        assert_eq!(bare_id(given).as_deref(), id, "{given}");
    }
}

/// A service failure, as the command's call returns it.
fn refused(reason: Reason, message: &str) -> anyhow::Error {
    anyhow::Error::new(ErrorBody::new(reason, message))
}

#[test]
fn a_service_refusal_about_one_agent_becomes_its_catalog_row() {
    let row = |given: &str, reason: Reason, message: &str| {
        words(&about_agent(given, refused(reason, message)))
    };
    assert_eq!(
        row(
            "a9",
            Reason::NotFound,
            "no agent a9; nothing was done; you can reach #a1 Ada"
        ),
        "error: no agent 'a9'\n  tip: run 'facade list' to see your agents"
    );
    assert_eq!(
        row(
            "Ada",
            Reason::AmbiguousReference,
            "Ada names #a1 and #a2; nothing was done"
        ),
        "error: more than one agent is named 'Ada'\n  tip: run 'facade list' and use the agent's ID"
    );
    assert_eq!(
        row(
            "@Human",
            Reason::AmbiguousReference,
            "human names the person and #a1"
        ),
        "error: '@Human' matches both the human and an agent named human\n  tip: run 'facade \
         list' and use the agent's ID"
    );
    // The service's words name the ended agent's ID, however the reader named it.
    for given in ["a1", "#a1", "1", "worker", "7"] {
        assert_eq!(
            row(given, Reason::Ended, "#a1 ended; nothing was typed"),
            "error: a1 has ended\n  tip: run 'facade inspect a1' to check for a saved session",
            "{given}"
        );
    }
    // Other words of an ended agent, and input that partly reached the terminal, stay the
    // service's.
    assert_eq!(
        row(
            "a1",
            Reason::Ended,
            "the terminal closed; nothing was typed"
        ),
        "error: the terminal closed; nothing was typed"
    );
    assert_eq!(
        row(
            "a1",
            Reason::PartialInput,
            "#a1 ended after 3 of 9 characters were typed; nothing was done"
        ),
        "error: #a1 ended after 3 of 9 characters were typed"
    );
    assert_eq!(
        row(
            "a1",
            Reason::Unavailable,
            "#a1 has no recorded session; nothing was done"
        ),
        "error: #a1 has no recorded session"
    );
}

#[test]
fn a_send_to_an_ended_agent_names_it_by_the_id_the_service_gives() {
    let sent = |to: &str, message: &str| words(&about_send(to, refused(Reason::Ended, message)));
    for to in ["a2", "#a2", "2", "bob"] {
        assert_eq!(
            sent(to, "#a2 ended; it takes no messages"),
            "error: a2 has ended\n  tip: run 'facade inspect a2' to check for a saved session",
            "{to}"
        );
    }
    // One ended agent of that name is named by its ID; several keep the service's words.
    for to in ["bob", "@bob"] {
        assert_eq!(
            sent(to, &format!("{to} ended: #a2 takes no messages")),
            "error: a2 has ended\n  tip: run 'facade inspect a2' to check for a saved session",
            "{to}"
        );
    }
    assert_eq!(
        sent("bob", "bob ended: #a2, #a3 takes no messages"),
        "error: bob ended: #a2, #a3 takes no messages"
    );
    assert_eq!(
        sent("a2", "#a2 was removed with its messages; nothing was done"),
        "error: #a2 was removed with its messages"
    );
}

#[test]
fn only_the_exact_ended_words_give_an_id() {
    for (message, id) in [
        ("#a1 ended; nothing was typed", Some("a1")),
        ("#a12 ended; it takes no messages", Some("a12")),
        ("#a1 ended; nothing was typed yet", None),
        ("a1 ended; nothing was typed", None),
        ("#a ended; nothing was typed", None),
        ("#a1x ended; it takes no messages", None),
        ("bob ended: #a2 takes no messages", None),
        ("#a1 ended", None),
    ] {
        assert_eq!(ended_agent(message).as_deref(), id, "{message}");
    }
}

/// A send to a name of one ended agent: the service names it after the reference as given.
#[test]
fn only_one_ended_agent_of_the_name_as_given_gives_an_id() {
    for (to, message, id) in [
        ("bob", "bob ended: #a2 takes no messages", Some("a2")),
        ("@bob", "@bob ended: #a2 takes no messages", Some("a2")),
        (
            "Ada Lovelace",
            "Ada Lovelace ended: #a7 takes no messages",
            Some("a7"),
        ),
        ("bob", "bob ended: #a2, #a3 takes no messages", None),
        ("bob", "ada ended: #a2 takes no messages", None),
        ("bob", "bob ended: #a2 takes no messages now", None),
        ("bob", "bob ended: a2 takes no messages", None),
        ("bob", "bob ended: #a takes no messages", None),
        ("bob", "bob ended: #a1x takes no messages", None),
    ] {
        assert_eq!(ended_by_name(to, message).as_deref(), id, "{to}: {message}");
    }
}

#[test]
fn a_send_to_a_name_the_human_shares_gets_the_send_tip() {
    let said = words(&about_send(
        "human",
        refused(Reason::AmbiguousReference, "human names the person and #a1"),
    ));
    assert_eq!(
        said,
        "error: 'human' matches both the human and an agent named human\n  tip: quote '#human' for \
         the human, or run 'facade list' for the agent's ID"
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
            "error: could not find facade on gpu\n  tip: install Facade on gpu and add its folder to \
             the PATH that SSH commands use",
        ),
        (
            Problem::Version {
                machine: given("gpu"),
                theirs: given("0.1.5"),
                ours: given("0.1.7"),
            },
            "error: gpu runs Facade 0.1.5, which cannot connect to Facade 0.1.7\n  tip: install \
             Facade 0.1.7 on gpu",
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
             'facade list' to check",
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
         'facade list' to check"
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
        "error: no agent 'Pixel' on the machines that responded; gpu did not respond\n  tip: run \
         'facade list' to see your agents"
    );
}
