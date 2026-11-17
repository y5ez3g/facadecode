//! CLI rules: a rule's name starts its CLI as the rule says, any other program runs as given, and
//! `inspect` reads an agent's input from its screen without typing.

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// `facade inspect --json` for an agent.
fn inspect(home: &TestHome, agent: &str) -> Value {
    serde_json::from_str(&home.run_facade_ok(&["inspect", agent, "--json"]))
        .expect("inspect prints JSON")
}

#[test]
fn a_rule_s_name_runs_its_cli_and_a_path_runs_the_program_as_given() {
    let home = TestHome::new("named");
    home.start_named_fake("named", &[]);
    home.start_fake("raw");
    let named = home.agent_from_list_json("named").unwrap();
    let raw = home.agent_from_list_json("raw").unwrap();
    assert_eq!(
        (named["cli"].as_str(), raw["cli"].as_str()),
        (Some("fake"), Some("facade-fakecli")),
        "a path keeps its program's name"
    );
    assert_eq!(inspect(&home, "named")["rule"], "fake");
    assert!(
        inspect(&home, "raw").get("rule").is_none(),
        "a program started by its path has no rule"
    );
    let plain = home.run_facade_ok(&["inspect", "raw"]);
    assert!(
        plain.contains("Rule: none\n")
            && plain.contains("Session: unknown\n")
            && plain.contains("Session tracking: unavailable\n"),
        "{plain}"
    );
    let help = home.run_facade_ok(&["start", "--help"]);
    assert!(
        help.contains("(claude, codex, agy, muse, opencode, pi)") && !help.contains("fake"),
        "the help names what a release carries: {help}"
    );
}

/// A CLI of the settings file whose program cannot run where it starts is `not_found`, said by its
/// setting; a program started by its path that cannot run, and a folder that cannot be used, are
/// `unavailable`; a relative folder is refused.
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
    let start =
        |wire: &mut DaemonTestClient, command: Value, cwd: &str, path: &str| {
            wire.call("agent.start", json!({
                "command": command, "cwd": cwd, "env": { "PATH": path, "FACADE_HOME": home.path },
                "cols": 80, "rows": 24,
            }))
        };
    let project = home.project.display().to_string();
    let missing = start(&mut wire, json!(["fake"]), &project, SYSTEM_PATH.as_str());
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
                && message.ends_with(", and clis.fake.command does not name its location")),
        "{missing}"
    );
    assert_eq!(
        error_reason(&start(
            &mut wire,
            json!(["/no/such/program"]),
            &project,
            SYSTEM_PATH.as_str()
        )),
        "unavailable",
        "a missing program"
    );
    let fake = test_binaries().fakecli.display().to_string();
    assert_eq!(
        error_reason(&start(
            &mut wire,
            json!([fake]),
            no_folder.as_str(),
            SYSTEM_PATH.as_str()
        )),
        "unavailable",
        "a missing folder"
    );
    let named = start(
        &mut wire,
        json!(["fake"]),
        no_folder.as_str(),
        &home.path_with_test_programs(),
    );
    assert_eq!(
        error_reason(&named),
        "unavailable",
        "a missing folder for a rule's CLI"
    );
    assert_eq!(
        error_reason(&start(
            &mut wire,
            json!([fake]),
            "project",
            SYSTEM_PATH.as_str()
        )),
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
    let plain = home.run_facade_ok(&["inspect", "reader"]);
    let lines: Vec<&str> = plain.lines().collect();
    assert_eq!(lines.len(), 10, "{plain}");
    assert_eq!(
        (lines[0], lines[1]),
        (
            format!("#{} reader: fake, running", agent.id).as_str(),
            "Rule: fake"
        )
    );
    assert!(
        lines[2]
            .strip_prefix("Folder: ")
            .map(std::path::Path::new)
            .is_some_and(|folder| folder.is_absolute() && folder.ends_with("project")),
        "{plain}"
    );
    assert_eq!(
        &lines[3..],
        [
            "YOLO: on",
            "State: starting",
            "Tools: available",
            "Input: draft (prompt_row); the prompt row at row 28 holds text",
            "Said: nothing yet",
            "Session: unknown",
            "Session tracking: available"
        ]
    );
    wire.call("agent.stop", json!({ "agent": agent.id }));
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
