//! Public Shell grammar, output streams and the records behind the output.

use std::path::Path;
use std::process::{Output, Stdio};

use facade_base::files::real_path;
use facade_scenarios::serde_json::json;
use facade_scenarios::*;

/// `facade <args>` with the test programs on `PATH`, so that `fake` names the test CLI.
fn facade(home: &TestHome, args: &[&str]) -> Output {
    home.command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("could not run facade")
}

/// What a command printed and how it exited: stdout, stderr, the exit code.
fn said(output: &Output) -> (String, String, Option<i32>) {
    (stdout(output), stderr(output), output.status.code())
}

/// Whether anything of Facade runs or ran for this home: a socket, or its core folder.
fn reached(home: &TestHome) -> bool {
    socket_exists(&home.daemon_socket()) || home.path.join("core").exists()
}

/// The copyable address Facade gives the agent with this ID, such as `a1@host`.
fn address(home: &TestHome, id: &str) -> String {
    home.agent_record(id).expect("the agent is recorded")["address"]
        .as_str()
        .expect("an address")
        .to_string()
}

/// An explicit stop confirms each process exit and stops each resolved reference once.
#[test]
fn stop_confirms_each_explicit_target_once() {
    let home = TestHome::new("stopmany");
    let first = home.start_fake("w1");
    let second = home.start_fake("w2");
    assert!(alive(&first.process) && alive(&second.process));
    assert_eq!(
        said(&home.run_facade(&["stop", "nobody"])),
        (
            String::new(),
            "error: No active agent or guest matches \"nobody\".\nRun 'facade list' to find an agent.\n".into(),
            Some(1)
        )
    );
    assert_eq!(
        said(&home.run_facade(&["stop", &first.address])),
        (
            format!("Stopped w1 ({}).\n", first.address),
            String::new(),
            Some(0)
        )
    );
    assert!(!alive(&first.process), "w1 still runs");
    assert!(alive(&second.process), "w2 stopped too");
    assert_eq!(home.list_state("w1"), None);

    let third = home.start_fake("w3");
    assert_eq!(
        said(&home.run_facade(&["stop", "w2", &second.id, &third.address])),
        (
            format!(
                "Stopped w2 ({}).\nStopped w3 ({}).\n",
                second.address, third.address
            ),
            String::new(),
            Some(0)
        )
    );
    assert!(!alive(&second.process) && !alive(&third.process));
}

#[test]
fn stop_keeps_successful_receipts_when_other_targets_fail_and_scopes_skip_guests() {
    let home = TestHome::new("stopscope");
    let first = home.start_fake("Pixel");
    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    assert_eq!(guest.call("list_agents", json!({}))["status"], "success");
    let listed = home.list_table();
    let guest_ref = listed.cell(listed.row("TYPE", "Guest").unwrap(), "REF");
    home.run_facade_ok(&["rename", guest_ref, "Cursor"]);

    assert_eq!(
        said(&home.run_facade(&["stop", &first.id, "nobody", guest_ref])),
        (
            format!("Stopped Pixel ({}).\n", first.address),
            format!(
                "error: No active agent or guest matches \"nobody\".\n\
                 error: Cursor ({guest_ref}) is a guest and cannot be stopped by Facade.\n\
                 Run 'facade list' to check active agents.\n"
            ),
            Some(1)
        )
    );
    assert!(!alive(&first.process));

    let second = home.start_fake("Nova");
    assert_eq!(
        said(&home.run_facade(&["stop", "--local"])),
        (
            format!("Stopped Nova ({}).\n", second.address),
            format!(
                "note: skipped 1 connected guest (Cursor {guest_ref}); stop guests from their host apps.\n"
            ),
            Some(0)
        )
    );
    assert!(!alive(&second.process));
    assert_eq!(home.list_table().column("REF"), [guest_ref]);
}

#[test]
fn conflicting_list_resume_and_stop_scopes_are_usage_errors_without_starting_facade() {
    let home = TestHome::new("scopeusage");
    let conflict = "error: Cannot combine '--local' with '--machine'.\n";
    let resume_usage = "Usage:\n  facade resume [--local | --machine <MACHINE>]\n  facade resume [-d|--detach] <REFERENCE>\nRun 'facade resume --help' for all options.\n";
    for (args, expected) in [
        (
            &["list", "--local", "--machine", "devbox"][..],
            format!(
                "{conflict}Usage: facade list [--local | --machine <MACHINE>]\nRun 'facade list --help' for all options.\n"
            ),
        ),
        (
            &["resume", "--local", "--machine", "devbox"],
            format!(
                "{conflict}Usage: facade resume [--local | --machine <MACHINE>]\nRun 'facade resume --help' for all options.\n"
            ),
        ),
        (
            &["resume", "--local", "a5@laptop"],
            format!(
                "error: '--local' can only be used to list resumable agents and sessions, not with '-d' or <REFERENCE>.\n{resume_usage}"
            ),
        ),
        (
            &["resume", "--machine", "devbox", "a5@devbox"],
            format!(
                "error: '--machine' can only be used to list resumable agents and sessions, not with '-d' or <REFERENCE>.\n{resume_usage}"
            ),
        ),
        (
            &["resume", "-d"],
            "error: Choose an agent or session to resume in the background.\n\
             Usage: facade resume [-d|--detach] <REFERENCE>\n\
             Example: facade resume -d a5@laptop\n\
             Run 'facade resume' to see resumable agents and sessions.\n"
                .into(),
        ),
        (
            &["stop", "--all", "Nova"],
            "error: Cannot combine '--all' with <AGENT> targets.\n".into(),
        ),
        (
            &["stop", "--all", "--local"],
            "error: Cannot combine '--all' with '--local'.\n".into(),
        ),
        (&["stop", "--local", "--machine", "devbox"], conflict.into()),
    ] {
        assert_eq!(
            said(&home.run_facade(args)),
            (String::new(), expected, Some(2)),
            "facade {args:?}"
        );
        assert!(!reached(&home), "facade {args:?} started services");
    }
}

#[test]
fn misplaced_machine_add_options_never_reach_ssh() {
    let home = TestHome::new("add-usage");
    install_machine_ssh(&[("devbox", &home)], &test_binaries().facade);
    assert_eq!(
        said(&home.run_facade(&["machine", "add", "devbox", "--bidirectional"])),
        (
            String::new(),
            "error: Put '--bidirectional' before the SSH arguments and destination.\n\
             Usage: facade machine add [OPTIONS] <SSH_ARGS>...\n\
             Run 'facade machine add --help' for all options.\n"
                .into(),
            Some(2)
        )
    );
    for args in [
        ["machine", "add", "-p", "2222", "--bidirectional", "devbox"],
        ["machine", "add", "devbox", "--home", "other-home", "unused"],
        [
            "machine",
            "add",
            "-p",
            "2222",
            "--home=other-home",
            "devbox",
        ],
    ] {
        let (out, error, code) = said(&home.run_facade(&args));
        assert_eq!((out.as_str(), code), ("", Some(2)), "{args:?}: {error}");
        assert!(error.starts_with("error: Put "), "{args:?}: {error}");
    }
    assert!(!reached(&home));
    assert!(!home.folder().join("ssh-attempts").exists());
}

/// The table's references name the records in their roster order and can be copied into operations.
#[test]
fn roster_refs_work_for_operations_and_removal_keeps_the_empty_roster() {
    let home = TestHome::new("rosterrefs");
    let first = home.start_fake("w1");
    let second = home.start_fake("w2");
    let table = home.list_table();
    assert_eq!(table.column("REF"), [&second.address, &first.address]);
    for reference in table.column("REF") {
        let removed = connect(&home).call_ok("agent.remove", json!({ "agent": reference }));
        assert_eq!(removed["address"], reference);
    }
    assert!(home.agents().is_empty(), "{:?}", home.agents());
    assert!(!alive(&first.process) && !alive(&second.process));

    assert_eq!(
        said(&home.run_facade(&["list"])),
        (
            String::new(),
            "No active agents.\nStart one with 'facade start codex', or run 'facade resume' to find saved sessions.\n".into(),
            Some(0)
        )
    );
    let listed = home.agent_list();
    assert_eq!(listed["agents"], json!([]), "{listed}");
    assert_eq!(listed["machines"].as_array().map(Vec::len), Some(1));
    assert_eq!(listed["machines"][0]["state"], "online", "{listed}");

    for option in ["-q", "--quiet", "--json"] {
        let (out, err, code) = said(&home.run_facade(&["list", option]));
        assert_eq!((out.as_str(), code), ("", Some(2)), "{err}");
        assert!(err.contains(option), "{err}");
    }
}

#[test]
fn detached_start_names_the_running_agent() {
    let home = TestHome::new("startdetach");
    for (id, options) in [
        ("a1", &["-d", "--name", "w1"][..]),
        ("a2", &["--detach"][..]),
    ] {
        let args = [&["start"][..], options, &["fake"]].concat();
        let started = facade(&home, &args);
        assert_eq!(started.status.code(), Some(0), "{}", stderr(&started));
        let record = home.agent_record(id).expect("a started agent");
        let name = record["name"].as_str().expect("the agent's name");
        let reference = record["address"].as_str().unwrap();
        assert_eq!(
            said(&started),
            (
                format!("Started {name} ({reference}) in the background.\n"),
                String::new(),
                Some(0)
            )
        );
        assert_eq!(record["process"], "running");
        if id == "a1" {
            assert_eq!(name, "w1");
        }
    }
}

/// The roster, inspection and Shell views refer to the same live process.
#[test]
fn agent_list_inspect_and_status_agree_on_the_record() {
    let home = TestHome::new("agentviews");
    let worker = home.start_fake("worker");
    assert!(wait_for_screen_text(&home, &worker.id, "❯"));
    let record = home.agent_record(&worker.id).unwrap();
    let listed = home.agent_list();
    let row = &listed["agents"][0];
    for (row_key, record_key) in [
        ("id", "address"),
        ("name", "name"),
        ("type", "type"),
        ("cli", "cli"),
        ("folder", "cwd"),
    ] {
        assert_eq!(row[row_key], record[record_key], "{row}");
    }
    assert_eq!(
        row["reference"],
        json!({
            "agent_id": record["agent_id"], "machine_id": record["machine_id"]
        })
    );

    let inspected = home.inspect_agent(&worker.id);
    let agent = &inspected["agent"];
    for key in [
        "address", "name", "type", "cli", "cwd", "args", "yolo", "pid",
    ] {
        assert_eq!(agent[key], record[key], "{inspected}");
    }
    let table = home.list_table();
    let row = table.row("NAME", "worker").expect("the active worker");
    assert_eq!(table.cell(row, "REF"), worker.address);
    assert_eq!(table.cell(row, "WORKING DIRECTORY"), agent["cwd"]);
    let detail = home.run_facade_ok(&["status", &worker.id]);
    assert_eq!(
        detail.lines().next().unwrap(),
        format!("worker ({})", worker.address)
    );
    assert_eq!(
        status_field(&detail, "Working directory"),
        agent["cwd"].as_str(),
        "{detail}"
    );
    assert_eq!(
        status_field(&detail, "PID"),
        Some(worker.pid.to_string().as_str()),
        "{detail}"
    );
}

/// CLI arguments and a name can begin with a dash, even when a word spells an option of Facade.
#[test]
fn a_cli_argument_that_starts_with_a_dash_is_one_value() {
    let home = TestHome::new("dashargs");
    for (number, (name, arg)) in [("p1", "-d"), ("-p2", "-x is wrong"), ("p3", "--help")]
        .into_iter()
        .enumerate()
    {
        let args = home.folder().join(format!("argv-{number}.json"));
        let started = home
            .command(&test_binaries().facade)
            .env("FAKECLI_ARGS", &args)
            .args(["start", "-d", "--name", name, "fake", arg])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(started.status.code(), Some(0), "{}", stderr(&started));
        let id = format!("a{}", number + 1);
        assert_eq!(
            stdout(&started),
            format!(
                "Started {name} ({}) in the background.\n",
                address(&home, &id)
            ),
        );
        assert!(
            wait_until(LOADED_TIMEOUT, || std::fs::read_to_string(&args)
                .ok()
                .and_then(
                    |output| facade_scenarios::serde_json::from_str::<Vec<String>>(&output).ok()
                )
                .is_some_and(|argv| argv.iter().any(|word| word == arg))),
            "missing argument {arg:?}"
        );
        assert!(home.agent_from_watch(name).is_some(), "{name}");
    }
}

/// Options after PROGRAM belong to that program, including current and former Facade options.
#[test]
fn every_word_after_the_program_is_the_program_s() {
    let home = TestHome::new("programwords");
    let script = "printf 'given:%s\\n' \"$*\"; sleep 60";
    let started = facade(
        &home,
        &[
            "start",
            "-d",
            "--name",
            "echoer",
            home.shell_cli(),
            "-c",
            script,
            "sh",
            "--help",
            "--name",
            "x",
            "--machine",
            "gpu",
            "--folder",
            "app",
            "--cwd",
            "old",
            "--",
            "-d",
            "y",
        ],
    );
    assert_eq!(
        said(&started),
        (
            format!(
                "Started echoer ({}) in the background.\n",
                address(&home, "a1")
            ),
            String::new(),
            Some(0)
        )
    );
    assert!(
        wait_until(secs(10), || home.screen("echoer").contains(
            "given:--help --name x --machine gpu --folder app --cwd old -- -d y"
        )),
        "{}",
        home.screen("echoer")
    );
}

/// A CLI option before its name is refused before Facade is reached.
#[test]
fn an_unknown_option_before_the_program_exits_2_without_reaching_facade() {
    let home = TestHome::new("startoption");
    assert_eq!(
        said(&facade(&home, &["start", "--model", "codex"])),
        (
            String::new(),
            concat!(
                "error: Unknown option '--model' before <CLI>.\n",
                "Put Facade options before the CLI name, and CLI options after it.\n",
                "Example: facade start codex --model ...\n",
                "Run 'facade start --help' for Facade options.\n"
            )
            .into(),
            Some(2)
        )
    );
    assert!(!reached(&home), "the usage error reached Facade");
}

/// Use the invoking shell's directory for default and relative folders, even with a local selector.
#[test]
fn start_workdir_uses_the_invoking_shell_for_local_paths() {
    let home = TestHome::new("startfolder");
    let listed = connect(&home).call_ok("machine.list", json!({}));
    let local = &listed["machines"][0];
    let machine_id = local["machine_id"].as_str().unwrap();
    let name = local["name"].as_str().unwrap();
    // A machine is selected by its name or its ID, the first 8 digits enough.
    let selector = machine_id[..8].to_string();
    let shell_folder = home.project.join("shell");
    let app_folder = shell_folder.join("my app");
    std::fs::create_dir_all(&app_folder).unwrap();
    let cases: &[(&[&str], &Path)] = &[
        (&[], &shell_folder),
        (&["--workdir", "my app"], &app_folder),
        (&["--workdir", app_folder.to_str().unwrap()], &app_folder),
        (&["--machine", name], &shell_folder),
        (
            &["--machine", &selector, "--workdir", "my app"],
            &app_folder,
        ),
    ];
    for (options, folder) in cases {
        let started = home
            .command(&test_binaries().facade)
            .env("PATH", home.path_with_test_programs())
            .current_dir(&shell_folder)
            .args(["start", "-d"])
            .args(*options)
            .arg("fake")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            started.status.success(),
            "{options:?}: {}",
            stderr(&started)
        );
        let id = started_id(&stdout(&started));
        let record = home.agent_record(&id).unwrap();
        assert_eq!(record["machine_id"], machine_id, "{record}");
        let started_folder = Path::new(record["cwd"].as_str().unwrap());
        assert_eq!(
            real_path(started_folder).unwrap(),
            real_path(folder).unwrap(),
            "{record}"
        );
    }
}

#[test]
fn start_refuses_old_options_and_an_empty_workdir() {
    let home = TestHome::new("startopts");
    for arguments in [
        &["start", "--cwd", "/work", "fake"][..],
        &["start", "--machine", "gpu", "--cwd=/work", "fake"][..],
        &["start", "--folder", "/work", "fake"][..],
        &["start", "--on", "gpu", "fake"][..],
        &["start", "--workdir", "", "fake"][..],
    ] {
        let (out, err, code) = said(&facade(&home, arguments));
        assert_eq!((out.as_str(), code), ("", Some(2)), "{err}");
        assert!(err.starts_with("error: "), "{err}");
        let option = arguments
            .iter()
            .rev()
            .find(|word| word.starts_with("--"))
            .unwrap();
        assert!(err.contains(option.split('=').next().unwrap()), "{err}");
        assert!(
            !reached(&home),
            "a usage error reached Facade: {arguments:?}"
        );
    }
}

/// The isolated machine still has a table row and a hint on stderr.
#[test]
fn machine_list_and_remove_on_a_lone_machine() {
    let home = TestHome::new("machinelone");
    let (out, err, code) = said(&facade(&home, &["machine", "list"]));
    let table = Table::parse(&out);
    assert_eq!(
        table.header,
        ["NAME", "ID", "STATE", "VERSION", "ROUTE", "SAVED"]
    );
    assert_eq!(table.rows.len(), 1, "{out}");
    let listed = connect(&home).call_ok("machine.list", json!({}));
    let local = &listed["machines"][0];
    let row = &table.rows[0];
    assert_eq!(table.cell(row, "NAME"), local["name"]);
    let id = local["machine_id"].as_str().expect("a v3 machine ID");
    assert_eq!(
        table.cell(row, "ID"),
        facade_base::address::short_machine_id(id)
    );
    for (column, expected) in [("STATE", "Local"), ("ROUTE", "-"), ("SAVED", "-")] {
        assert_eq!(table.cell(row, column), expected, "{out}");
    }
    assert_eq!(
        (err.as_str(), code),
        (
            "No other machines. Connect one with 'facade machine add devbox'.\n",
            Some(0)
        )
    );
    assert_eq!(
        said(&facade(&home, &["machine", "remove", "nowhere"])),
        (
            String::new(),
            "error: Unknown machine \"nowhere\".\nRun 'facade machine list' to see known machines.\n".into(),
            Some(1)
        )
    );
}

#[test]
fn status_on_an_empty_home_starts_nothing() {
    let home = TestHome::new("statusempty");
    let version = env!("CARGO_PKG_VERSION");
    let (out, err, code) = said(&home.run_facade(&["status"]));
    assert_eq!((err.as_str(), code), ("", Some(0)));
    assert!(
        out.starts_with(&format!("Facade {version} is not running on ")),
        "{out}"
    );
    for label in [
        "Active agents",
        "Connected machines",
        "Daemon PID",
        "Keeper PID",
    ] {
        assert_eq!(status_field(&out, label), Some("-"), "{out}");
    }
    for (label, path) in [
        ("Home", home.path.clone()),
        ("Settings", home.path.join("facade.json")),
    ] {
        assert_eq!(status_field(&out, label), path.to_str(), "{out}");
    }
    assert_eq!(
        status_field(&out, "Guest MCP"),
        Some("Add \"facade-mcp\" as a stdio server."),
        "{out}"
    );
    assert!(
        !socket_exists(&home.daemon_socket()) && home.processes().is_empty(),
        "status started Facade"
    );
}

#[test]
fn status_shows_a_running_facade() {
    let home = TestHome::new("statusrunning");
    home.start_fake("w1");
    let hello = home.hello_result().unwrap();
    let daemon = hello["pid"].as_i64().unwrap();
    let keeper = hello["keeper"]["pid"].as_i64().unwrap();
    let local = connect(&home).call_ok("machine.list", json!({}))["machines"][0].clone();
    let name = local["name"].as_str().unwrap();
    let version = env!("CARGO_PKG_VERSION");
    let (out, err, code) = said(&home.run_facade(&["status"]));
    assert_eq!((err.as_str(), code), ("", Some(0)));
    assert_eq!(
        out.lines().next().unwrap(),
        format!("Facade {version} is running on {name}.")
    );
    for (label, value) in [
        ("Active agents", "1".into()),
        ("Connected machines", "-".into()),
        ("Home", home.path.display().to_string()),
        (
            "Settings",
            home.path.join("facade.json").display().to_string(),
        ),
        ("Daemon PID", daemon.to_string()),
        ("Keeper PID", keeper.to_string()),
    ] {
        assert_eq!(status_field(&out, label), Some(value.as_str()), "{out}");
    }
    let launcher = home
        .path
        .join("core")
        .join("bin")
        .join(format!("facade-mcp{}", std::env::consts::EXE_SUFFIX));
    assert!(
        launcher.is_file(),
        "missing launcher {}",
        launcher.display()
    );
    assert_eq!(
        status_field(&out, "Guest MCP"),
        Some(format!("Add \"{}\" as a stdio server.", launcher.display()).as_str()),
        "{out}"
    );
    let result = connect(&home).call_ok("daemon.status", json!({}));
    assert_eq!(result["home"], home.path.to_str().unwrap());
    assert_eq!(
        result["settings_file"],
        home.path.join("facade.json").to_str().unwrap()
    );
    assert_eq!(result["daemon_pid"], daemon);
    assert_eq!(result["keeper_pid"], keeper);
    assert_eq!(result["agents"], 1);
    assert_eq!(home.daemon_pid(), Some(daemon as i32));
}

#[test]
fn attach_without_a_console_explains_how_to_read_the_screen() {
    let home = TestHome::new("attachwithoutconsole");
    assert_eq!(
        said(&facade(&home, &["attach", "a3"])),
        (
            String::new(),
            "error: 'facade attach' requires an interactive terminal.\n\
             Use 'facade screen a3' to read its recent output.\n"
                .into(),
            Some(1)
        )
    );
    assert!(!reached(&home));
}

/// Version flags and rejected former commands neither start nor contact the daemon.
#[test]
fn version_flags_and_retired_commands_reach_no_facade() {
    let home = TestHome::new("version");
    for flag in ["-V", "--version"] {
        assert_eq!(
            said(&home.run_facade(&[flag])),
            (
                format!("facade {}\n", env!("CARGO_PKG_VERSION")),
                String::new(),
                Some(0)
            )
        );
    }
    assert_eq!(
        said(&home.run_facade(&["-v"])),
        (
            String::new(),
            "error: Unknown option '-v'.\nRun 'facade --version' to print the CLI version.\n"
                .into(),
            Some(2)
        )
    );
    for name in ["ls", "rm", "remove", "inspect", "version", "completion"] {
        for args in [&[name][..], &[name, "--help"], &["help", name]] {
            assert_eq!(
                said(&home.run_facade(args)),
                (
                    String::new(),
                    format!(
                        "error: Unknown command {name:?}.\nRun 'facade --help' for available commands.\n"
                    ),
                    Some(2)
                )
            );
        }
    }
    assert!(!reached(&home), "a command that needs no Facade reached it");
}
