//! The command line's grammar and output on the built `facade`: several agents in one command,
//! IDs that scripts take back, `start`'s options, `status` that starts nothing, and the commands
//! that reach no Facade.

use std::path::Path;
use std::process::{Output, Stdio};

use facade_base::files::real_path;
use facade_scenarios::serde_json::{Value, json};
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

/// `stop` goes through the agents in order: it prints the address of each one it stopped, says why
/// one failed, goes on, and exits 1.
#[test]
fn stop_prints_each_agent_it_stopped_and_fails_for_one_that_is_not_there() {
    let home = TestHome::new("stopmany");
    let worker = home.start_fake("w1");
    let w1 = address(&home, &worker.id);
    assert_eq!(
        said(&home.run_facade(&["stop", "nobody", "w1"])),
        (
            format!("{w1}\n"),
            "error: no agent \"nobody\" was found\n".to_string(),
            Some(1)
        )
    );
    assert!(!alive(&worker.process), "w1 still runs");
    // The list shows running agents alone.
    assert_eq!(home.list_state("w1"), None);
}

/// `facade ls -q` prints one address a line, newest start first, which `facade rm` takes back
/// through a shell's substitution. With no agents, `list` says so and `ls -q` prints nothing at
/// all.
#[test]
fn rm_takes_the_ids_that_ls_q_prints() {
    let home = TestHome::new("rmquiet");
    let first = home.start_fake("w1");
    home.start_fake("w2");
    let (a1, a2) = (address(&home, "a1"), address(&home, "a2"));
    assert_eq!(
        said(&home.run_facade(&["ls", "-q"])),
        (format!("{a2}\n{a1}\n"), String::new(), Some(0))
    );
    let removed = home
        .command(shell())
        .args(["-c", "\"$0\" rm $(\"$0\" ls -q)"])
        .arg(&test_binaries().facade)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        said(&removed),
        (format!("{a2}\n{a1}\n"), String::new(), Some(0))
    );
    assert!(home.agents().is_empty(), "{:?}", home.agents());
    assert!(
        wait_until(secs(10), || !alive(&first.process)),
        "rm stops a running agent"
    );
    assert_eq!(
        said(&home.run_facade(&["ls", "-q"])),
        (String::new(), String::new(), Some(0))
    );
    assert_eq!(
        said(&home.run_facade(&["list"])),
        (String::new(), "No agents.\n".to_string(), Some(0))
    );
    // The JSON holds a line for each machine, with its state, beside the agents.
    let (json, said_on_stderr, code) = said(&home.run_facade(&["list", "--json"]));
    assert_eq!((said_on_stderr.as_str(), code), ("", Some(0)));
    let listed: Value = facade_scenarios::serde_json::from_str(&json).unwrap();
    assert_eq!(listed["agents"], json!([]), "{json}");
    assert_eq!(
        listed["machines"].as_array().map(Vec::len),
        Some(1),
        "{json}"
    );
    assert_eq!(listed["machines"][0]["state"], "online", "{json}");
    let both = home.run_facade(&["list", "-q", "--json"]);
    assert_eq!(both.status.code(), Some(2), "{}", stderr(&both));
}

/// `start -d` starts in the background and prints the agent's address alone.
#[test]
fn start_d_prints_a_bare_id() {
    let home = TestHome::new("startdetach");
    let started = facade(&home, &["start", "-d", "--name", "w1", "fake"]);
    assert_eq!(
        said(&started),
        (
            format!("{}\n", address(&home, "a1")),
            String::new(),
            Some(0)
        )
    );
    assert_eq!(home.agent_record("a1").unwrap()["process"], "running");
    let started = facade(&home, &["start", "--detach", "fake"]);
    assert_eq!(
        said(&started),
        (
            format!("{}\n", address(&home, "a2")),
            String::new(),
            Some(0)
        )
    );
}

/// `list --json` gives the protocol's roster row, and `inspect --json` the same facts as its text
/// and the protocol's record, under the same names.
#[test]
fn agent_json_uses_folder_and_last_input_with_the_v2_values() {
    let home = TestHome::new("agentjson");
    let worker = home.start_fake("worker");
    assert!(wait_for_screen_text(&home, &worker.id, "❯"));
    let mut wire = connect(&home);
    let listed: Value = serde_json::from_str(&home.run_facade_ok(&["list", "--json"])).unwrap();
    let mut row = wire.call("agent.list", json!({}))["result"]["agents"][0].clone();
    // The row without the reference a client keeps for later calls.
    row.as_object_mut().unwrap().shift_remove("reference");
    assert_eq!(listed["agents"][0], row);

    let record = home.agent_record(&worker.id).unwrap();
    let inspected: Value =
        serde_json::from_str(&home.run_facade_ok(&["inspect", "--json", &worker.id])).unwrap();
    assert_eq!(
        [
            &inspected["id"],
            &inspected["name"],
            &inspected["type"],
            &inspected["cli"],
            &inspected["folder"],
            &inspected["args"],
            &inspected["yolo"],
        ],
        [
            &record["address"],
            &record["name"],
            &record["type"],
            &record["cli"],
            &record["cwd"],
            &record["args"],
            &record["yolo"],
        ],
        "{inspected}"
    );
    let text = home.run_facade_ok(&["inspect", &worker.id]);
    let line = |label: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(&format!("{label}:")))
            .map(str::trim)
            .unwrap_or_else(|| panic!("no {label} in {text}"))
            .to_string()
    };
    assert_eq!(
        [line("ID"), line("Name"), line("Folder")],
        [&inspected["id"], &inspected["name"], &inspected["folder"]]
            .map(|value| value.as_str().unwrap().to_string()),
        "{text}"
    );
}

/// The values of `--name` and `--prompt` may begin with a dash, even one that spells an option of
/// Facade's.
#[test]
fn a_prompt_that_starts_with_a_dash_is_one_value() {
    let home = TestHome::new("dashprompt");
    for (number, (name, prompt)) in [("p1", "-d"), ("-p2", "-x is wrong"), ("p3", "--help")]
        .into_iter()
        .enumerate()
    {
        let started = facade(
            &home,
            &["start", "-d", "--name", name, "--prompt", prompt, "fake"],
        );
        let id = format!("a{}", number + 1);
        assert_eq!(
            said(&started),
            (format!("{}\n", address(&home, &id)), String::new(), Some(0)),
            "{prompt}"
        );
        let wanted = format!(
            "📨 Message from the command line · m{}\n{prompt}",
            number + 1
        );
        assert!(
            wait_until(secs(40), || home.submitted_messages().contains(&wanted)),
            "{prompt}: {:?}",
            home.submitted_messages()
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
            format!("{}\n", address(&home, "a1")),
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

/// An option of the CLI's put before it is a usage error, found before Facade is reached.
/// (`--model` and `--effort` are Facade's own options of `start`.)
#[test]
fn an_unknown_option_before_the_program_exits_2_without_reaching_facade() {
    let home = TestHome::new("startoption");
    assert_eq!(
        said(&facade(&home, &["start", "--verbose", "claude"])),
        (
            String::new(),
            "error: unexpected option '--verbose' before the CLI\n  tip: put CLI-specific options \
             after the CLI name\n"
                .to_string(),
            Some(2)
        )
    );
    assert!(!reached(&home), "the usage error reached Facade");
}

/// Use the invoking shell's directory for default and relative folders, even with a local selector.
#[test]
fn start_folder_uses_the_invoking_shell_for_local_paths() {
    let home = TestHome::new("startfolder");
    let listed: Value =
        serde_json::from_str(&home.run_facade_ok(&["machine", "list", "--json"])).unwrap();
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
        (&["--folder", "my app"], &app_folder),
        (&["--folder", app_folder.to_str().unwrap()], &app_folder),
        (&["--machine", name], &shell_folder),
        (&["--machine", &selector, "--folder", "my app"], &app_folder),
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

/// Former options and an explicitly empty folder fail before a daemon is reached.
#[test]
fn start_refuses_old_options_and_an_empty_folder() {
    let home = TestHome::new("startopts");
    for arguments in [
        &["start", "--cwd", "/work", "fake"][..],
        &["start", "--machine", "gpu", "--cwd=/work", "fake"][..],
    ] {
        let (out, err, code) = said(&facade(&home, arguments));
        assert_eq!((out.as_str(), code), ("", Some(2)), "{err}");
        assert!(err.contains("unexpected option '--cwd"), "{err}");
        assert!(err.contains("tip: use '--folder'"), "{err}");
    }
    let (out, err, code) = said(&facade(&home, &["start", "--folder", "", "fake"]));
    assert_eq!((out.as_str(), code), ("", Some(2)), "{err}");
    assert!(err.contains("--folder <FOLDER>"), "{err}");
    let (out, err, code) = said(&facade(&home, &["start", "--on", "gpu", "fake"]));
    assert_eq!((out.as_str(), code), ("", Some(2)), "{err}");
    assert!(err.starts_with("error: ") && err.contains("--on"), "{err}");
    assert!(!reached(&home), "a usage error reached Facade");
}

/// `machine list` on a lone machine prints its table row and says how to connect another; a
/// machine nobody has is a catalog error.
#[test]
fn machine_list_and_remove_on_a_lone_machine() {
    let home = TestHome::new("machinelone");
    let (out, err, code) = said(&facade(&home, &["machine", "list"]));
    assert_eq!(out.lines().count(), 2, "{out}");
    let table = Table::parse(&out);
    assert_eq!(
        table.header,
        [
            "NAME",
            "ID",
            "SELECTOR",
            "VERSION",
            "STATE",
            "ROUTE",
            "LAST SEEN",
            "SAVED"
        ],
        "{out}"
    );
    let listed: Value =
        serde_json::from_str(&home.run_facade_ok(&["machine", "list", "--json"])).unwrap();
    let local = &listed["machines"][0];
    let row = &table.rows[0];
    // The ID's first 8 digits, and a selector that finds this machine alone: its name.
    assert_eq!(
        [
            table.cell(row, "NAME"),
            table.cell(row, "ID"),
            table.cell(row, "SELECTOR"),
            table.cell(row, "STATE"),
            table.cell(row, "ROUTE"),
        ],
        [
            local["name"].as_str().unwrap(),
            &local["machine_id"].as_str().unwrap()[..8],
            local["name"].as_str().unwrap(),
            "online",
            "this machine",
        ],
        "{out}"
    );
    assert_eq!(
        (err.as_str(), code),
        (
            "No other machines. Run 'facade machine add <DESTINATION>' to connect one.\n",
            Some(0)
        )
    );
    assert_eq!(
        said(&facade(&home, &["machine", "remove", "nowhere"])),
        (
            String::new(),
            "error: no machine 'nowhere'\n  tip: run 'facade machine list' to see your machines\n"
                .to_string(),
            Some(1)
        )
    );
}

/// `status` where nothing runs says the Orchestrator sleeps, shows the Facade home, the settings
/// file and the version, and starts nothing.
#[test]
fn status_on_an_empty_home_starts_nothing() {
    let home = TestHome::new("statusempty");
    let version = env!("CARGO_PKG_VERSION");
    let settings = home.path.join("facade.json");
    assert_eq!(
        said(&home.run_facade(&["status"])),
        (
            format!(
                "Orchestrator sleeping.\n  Home:      {}\n  Settings:  {}\n  Version:   {version}\n",
                home.path.display(),
                settings.display()
            ),
            String::new(),
            Some(0)
        )
    );
    let json: Value =
        facade_scenarios::serde_json::from_str(&home.run_facade_ok(&["status", "--json"])).unwrap();
    assert_eq!(
        json,
        json!({
            "running": false,
            "home": home.path.display().to_string(),
            "settings_file": settings.display().to_string(),
            "version": version,
        })
    );
    assert!(
        !socket_exists(&home.daemon_socket()) && home.processes().is_empty(),
        "status started Facade"
    );
}

/// `status` where Facade runs shows the home, the settings file, this command's version, both
/// services' process IDs, the agent count and the machines, and changes nothing.
#[test]
fn status_shows_a_running_facade() {
    let home = TestHome::new("statusrunning");
    home.start_fake("w1");
    let hello = home.hello_result().unwrap();
    let (daemon, keeper) = (
        hello["pid"].as_i64().unwrap(),
        hello["keeper"]["pid"].as_i64().unwrap(),
    );
    let version = env!("CARGO_PKG_VERSION");
    let settings = home.path.join("facade.json");
    let machines: Value =
        serde_json::from_str(&home.run_facade_ok(&["machine", "list", "--json"])).unwrap();
    let machine = machines["machines"][0]["name"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        said(&home.run_facade(&["status"])),
        (
            format!(
                "Orchestrator running.\n  Home:      {}\n  Settings:  {}\n  Version:   {version}\n  \
                 Daemon:    pid {daemon}\n  Keeper:    pid {keeper}\n  Agents:    1\n  Machines:  \
                 {machine}\n",
                home.path.display(),
                settings.display()
            ),
            String::new(),
            Some(0)
        )
    );
    let json: Value =
        facade_scenarios::serde_json::from_str(&home.run_facade_ok(&["status", "--json"])).unwrap();
    assert_eq!(
        (
            &json["running"],
            &json["home"],
            &json["settings_file"],
            &json["version"],
            &json["daemon_pid"],
            &json["keeper_pid"],
            &json["agents"],
            &json["machines"][0]["name"],
        ),
        (
            &json!(true),
            &json!(home.path.display().to_string()),
            &json!(settings.display().to_string()),
            &json!(version),
            &json!(daemon),
            &json!(keeper),
            &json!(1),
            &json!(machine),
        ),
        "{json}"
    );
    assert_eq!(home.daemon_pid(), Some(daemon as i32));
}

/// `version` and `completion` print what they make without reaching Facade.
#[test]
fn version_and_completion_reach_no_facade() {
    let home = TestHome::new("version");
    let version = env!("CARGO_PKG_VERSION");
    let line = format!("facade {version}\n");
    assert_eq!(
        said(&home.run_facade(&["version"])),
        (line.clone(), String::new(), Some(0))
    );
    assert_eq!(
        said(&home.run_facade(&["-V"])),
        (line, String::new(), Some(0))
    );
    assert_eq!(
        said(&home.run_facade(&["version", "--json"])),
        (
            format!("{{\n  \"version\": \"{version}\"\n}}\n"),
            String::new(),
            Some(0)
        )
    );
    for shell in ["bash", "zsh", "fish", "powershell"] {
        let (out, err, code) = said(&home.run_facade(&["completion", shell]));
        assert!(
            code == Some(0)
                && err.is_empty()
                && out.contains("facade")
                && out.contains("ls")
                && out.contains("resume")
                && out.contains("upgrade")
                && out.contains("powershell")
                && !out.contains("integration")
                && !out.contains("keeper"),
            "{shell}: completes the public commands, aliases and the shells, and no hidden or \
             removed command: {code:?} {err}\n{out}"
        );
    }
    let unknown = home.run_facade(&["completion", "cmd"]);
    assert_eq!(unknown.status.code(), Some(2), "{}", stderr(&unknown));
    assert!(!reached(&home), "a command that needs no Facade reached it");
}
