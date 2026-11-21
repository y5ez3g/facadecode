//! CLI rules: a rule's name starts its CLI as the rule says, a custom program of the settings file
//! runs as given, and `inspect` reads an agent's input from its screen without typing.

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// `agent.inspect` for an agent.
fn inspect(home: &TestHome, agent: &str) -> Value {
    home.inspect_agent(agent)
}

#[test]
fn a_rule_s_name_runs_its_cli_and_a_custom_program_runs_as_given() {
    let home = TestHome::new("named");
    home.start_named_fake("named", &[]);
    home.add_custom_cli("raw", &test_binaries().fakecli);
    home.run_facade_ok(&["start", "-d", "--name", "raw", "raw"]);
    let named = home.listed_agent("named").unwrap();
    let raw = home.listed_agent("raw").unwrap();
    assert_eq!(
        (named["cli"].as_str(), raw["cli"].as_str()),
        (Some("fake"), Some("raw")),
        "a custom program keeps its entry's name"
    );
    assert_eq!(inspect(&home, "named")["rule"], "fake");
    assert!(
        inspect(&home, "raw").get("rule").is_none(),
        "a custom program has no rule"
    );
    let plain = home.run_facade_ok(&["status", "raw"]);
    assert_eq!(status_field(&plain, "CLI"), Some("raw"), "{plain}");
    assert_eq!(status_field(&plain, "Session"), Some("-"), "{plain}");
    let help = home.run_facade_ok(&["start", "--help"]);
    assert!(
        help.contains("claude") && !help.contains("fake"),
        "the help names what a release carries: {help}"
    );
}

/// A CLI of the settings file whose program cannot run where it starts is `not_found`, said by its
/// setting, and so is a program that is no CLI of the settings file; a folder that does not exist
/// is refused, saying so, and so is a relative folder.
#[test]
fn a_program_or_folder_that_cannot_be_used_is_refused_and_a_relative_folder_too() {
    let home = TestHome::new("unusable");
    let mut wire = connect(&home);
    // A folder from the root: on Windows one names its drive, or it is relative.
    #[cfg(unix)]
    let no_folder = "/no/such/folder".to_string();
    #[cfg(windows)]
    let no_folder = format!(
        r"{}\no\such\folder",
        &home.project.display().to_string()[..2]
    );
    let shell = home.shell_cli();
    let start = |wire: &mut DaemonTestClient, cli: &str, folder: &str, path: &str| {
        wire.call(
            "agent.start",
            json!({
                "cli": cli, "folder": folder, "env": { "PATH": path, "FACADE_HOME": home.path },
                "size": { "cols": 80, "rows": 24 },
            }),
        )
    };
    let project = home.project.display().to_string();
    let missing = start(&mut wire, "fake", &project, SYSTEM_PATH.as_str());
    assert_eq!(
        error_reason(&missing),
        "not_found",
        "a CLI's program missing from PATH"
    );
    let said = "facade-fakecli was not found on the PATH of a terminal in ";
    assert!(
        missing["error"]["message"]
            .as_str()
            .is_some_and(|message| message.starts_with(said)
                && message.ends_with(
                    ", and clis.fake.program does not name its location\nAvailable CLIs: sh."
                )),
        "{missing}"
    );
    let unknown = start(
        &mut wire,
        "/no/such/program",
        &project,
        SYSTEM_PATH.as_str(),
    );
    assert_eq!(unknown["error"]["code"], -32602, "{unknown}");
    assert_eq!(error_reason(&unknown), "invalid_argument", "{unknown}");
    assert!(
        unknown["error"]["data"]["details"]["available_clis"]
            .as_array()
            .is_some_and(|clis| clis.contains(&json!(shell))),
        "{unknown}"
    );
    let program = start(&mut wire, shell, no_folder.as_str(), SYSTEM_PATH.as_str());
    let named = start(
        &mut wire,
        "fake",
        no_folder.as_str(),
        &home.path_with_test_programs(),
    );
    let gone = format!("the folder {no_folder} does not exist");
    for refused in [program, named] {
        assert_eq!(
            (error_reason(&refused), refused["error"]["message"].as_str()),
            ("invalid_argument", Some(gone.as_str())),
            "a missing folder, for a custom program and a rule's CLI: {refused}"
        );
    }
    assert_eq!(
        error_reason(&start(&mut wire, shell, "project", SYSTEM_PATH.as_str())),
        "invalid_argument",
        "a relative folder"
    );
    assert!(home.agents().is_empty(), "nothing starts");
    assert!(
        !home
            .path
            .join("core/runs")
            .read_dir()
            .is_ok_and(|mut entries| entries.next().is_some()),
        "no run folder is left behind"
    );
}

#[test]
fn inspect_reads_the_input_from_the_screen_without_typing() {
    let home = TestHome::new("inspect");
    let agent = home.start_named_fake("reader", &[]);
    let mut wire = connect(&home);
    let input = |home: &TestHome| inspect(home, "reader")["input"].clone();
    assert!(
        wait_until(secs(10), || input(&home)["state"] == "usable"),
        "{}",
        input(&home)
    );
    assert_eq!(
        input(&home),
        json!({
            "state": "usable", "evidence": "the prompt row at row 28 is empty",
            "mechanism": "prompt_row",
        })
    );
    type_raw(&mut wire, &agent.id, "half a thought");
    assert!(
        wait_until(secs(10), || input(&home)["state"] == "draft"),
        "{}",
        input(&home)
    );
    assert!(
        !input(&home)["evidence"]
            .as_str()
            .unwrap()
            .contains("thought"),
        "evidence never holds the draft"
    );
    assert!(
        home.submitted_messages().is_empty(),
        "inspect sends no keys"
    );
    // The test CLI runs the Facade server its rule gives it, which connects.
    assert!(
        wait_until(
            secs(10),
            || inspect(&home, "reader")["agent"]["tools_state"] == "available"
        ),
        "{}",
        inspect(&home, "reader")
    );
    let plain = home.run_facade_ok(&["status", "reader"]);
    let mut lines = plain.lines();
    let address = &agent.address;
    assert_eq!(
        lines.next(),
        Some(format!("reader ({address})").as_str()),
        "{plain}"
    );
    let fields: Vec<_> = lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (label, value) = line.split_once("  ").unwrap_or_else(|| panic!("{plain}"));
            assert_eq!(
                line.len() - value.trim_start().len(),
                "Working directory".len() + 2,
                "{plain}"
            );
            label
        })
        .collect();
    assert_eq!(
        fields,
        [
            "State",
            "CLI",
            "PID",
            "Working directory",
            "Launch command",
            "Type",
            "Machine",
            "Title",
            "Session",
            "Started by",
            "Attached in",
            "YOLO"
        ],
        "{plain}"
    );
    assert!(
        status_field(&plain, "Working directory")
            .map(std::path::Path::new)
            .is_some_and(|folder| folder.is_absolute() && folder.ends_with("project")),
        "{plain}"
    );
    for (label, expected) in [
        ("Type", Some("Managed")),
        (
            "Machine",
            address.split_once('@').map(|(_, machine)| machine),
        ),
        ("CLI", Some("fake")),
        ("Session", Some("-")),
        ("Started by", Some("Shell")),
        ("Attached in", Some("-")),
        ("YOLO", Some("on")),
    ] {
        assert_eq!(status_field(&plain, label), expected, "{plain}");
    }
    let inspection = inspect(&home, "reader");
    let record = &inspection["agent"];
    assert_eq!(record["args"], json!([]));
    assert!(
        record["model"].is_null() && record["effort"].is_null(),
        "{record}"
    );
    assert_eq!(inspection["viewers"], json!([]));
    let stopped = wire.call_ok(
        "agent.stop",
        json!({ "selection": { "kind": "targets", "targets": [agent.id] } }),
    );
    assert_eq!(stopped["items"][0]["status"], "stopped", "{stopped}");
    let ended = inspect(&home, "reader");
    assert_eq!(
        (
            ended["input"]["state"].as_str(),
            ended["input"]["evidence"].as_str()
        ),
        (Some("unknown"), Some("the agent ended"))
    );
    assert_eq!(ended["session_tracking"], false);
}

#[test]
fn hello_offers_inspect_and_resume() {
    let home = TestHome::new("ops");
    home.run_facade_ok(&["daemon", "--detach"]);
    assert!(wait_until(secs(10), || home.hello_result().is_some()));
    let ops: Vec<String> = home.hello_result().unwrap()["ops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|op| op.as_str().unwrap().to_string())
        .collect();
    assert!(
        ops.contains(&"agent.inspect".to_string()) && ops.contains(&"agent.resume".to_string()),
        "{ops:?}"
    );
}
