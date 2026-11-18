//! The command line's grammar and output on the built `facade`: several agents in one command,
//! IDs that scripts take back, `start`'s options, `status` that starts nothing, and the commands
//! that reach no Facade.

use std::process::{Output, Stdio};

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

/// `stop` goes through the agents in order: it prints each one it stopped as given, says why one
/// failed, goes on, and exits 1.
#[test]
fn stop_prints_each_agent_it_stopped_and_fails_for_one_that_is_not_there() {
    let home = TestHome::new("stopmany");
    let worker = home.start_fake("w1");
    assert_eq!(
        said(&home.run_facade(&["stop", "nobody", "w1"])),
        (
            "w1\n".to_string(),
            "error: no agent 'nobody'\n  tip: run 'facade list' to see your agents\n".to_string(),
            Some(1)
        )
    );
    assert!(!alive(&worker.process), "w1 still runs");
    assert_eq!(home.list_state("w1").as_deref(), Some("stopped"));
}

/// `facade ls -q` prints one bare ID a line, which `facade rm` takes back through a shell's
/// substitution. With no agents, `list` hints how to start one and `ls -q` prints nothing at all.
#[test]
fn rm_takes_the_ids_that_ls_q_prints() {
    let home = TestHome::new("rmquiet");
    let first = home.start_fake("w1");
    home.start_fake("w2");
    assert_eq!(
        said(&home.run_facade(&["ls", "-q"])),
        ("a1\na2\n".to_string(), String::new(), Some(0))
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
        ("a1\na2\n".to_string(), String::new(), Some(0))
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
        (
            String::new(),
            "No agents. Run 'facade start claude' to start one.\n".to_string(),
            Some(0)
        )
    );
    // The JSON holds every machine's answer beside the agents.
    let (json, said_on_stderr, code) = said(&home.run_facade(&["list", "--json"]));
    assert_eq!((said_on_stderr.as_str(), code), ("", Some(0)));
    let listed: Value = facade_scenarios::serde_json::from_str(&json).unwrap();
    assert_eq!(listed["agents"], json!([]), "{json}");
    assert_eq!(listed["machines"][0]["status"], "answered", "{json}");
    let both = home.run_facade(&["list", "-q", "--json"]);
    assert_eq!(both.status.code(), Some(2), "{}", stderr(&both));
}

/// `start -d` starts in the background and prints the agent's bare ID alone.
#[test]
fn start_d_prints_a_bare_id() {
    let home = TestHome::new("startdetach");
    let started = facade(&home, &["start", "-d", "--name", "w1", "fake"]);
    assert_eq!(said(&started), ("a1\n".to_string(), String::new(), Some(0)));
    assert_eq!(home.agent_record("a1").unwrap()["process"], "running");
    let started = facade(&home, &["start", "--detach", "fake"]);
    assert_eq!(said(&started), ("a2\n".to_string(), String::new(), Some(0)));
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
        assert_eq!(
            said(&started),
            (format!("a{}\n", number + 1), String::new(), Some(0)),
            "{prompt}"
        );
        let wanted = format!("📨 Message from #human · #m{}\n{prompt}", number + 1);
        assert!(
            wait_until(secs(40), || home.submitted_messages().contains(&wanted)),
            "{prompt}: {:?}",
            home.submitted_messages()
        );
        assert!(home.agent_from_watch(name).is_some(), "{name}");
    }
}

/// Every word after PROGRAM is the program's, `--help`, `--name` and `--` among them.
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
            SH.as_str(),
            "-c",
            script,
            "sh",
            "--help",
            "--name",
            "x",
            "--",
            "-d",
            "y",
        ],
    );
    assert_eq!(said(&started), ("a1\n".to_string(), String::new(), Some(0)));
    assert!(
        wait_until(secs(10), || home
            .screen("echoer")
            .contains("given:--help --name x -- -d y")),
        "{}",
        home.screen("echoer")
    );
}

/// An option of the program's put before it is a usage error, found before Facade is reached.
#[test]
fn an_unknown_option_before_the_program_exits_2_without_reaching_facade() {
    let home = TestHome::new("startoption");
    assert_eq!(
        said(&facade(&home, &["start", "--model", "opus", "claude"])),
        (
            String::new(),
            "error: unexpected option '--model' before the program\n  tip: put the program's \
             options after its name: 'facade start claude --model opus'\n"
                .to_string(),
            Some(2)
        )
    );
    assert!(!reached(&home), "the usage error reached Facade");
}

/// `status` where nothing runs says so, shows the Facade home, and starts nothing.
#[test]
fn status_on_an_empty_home_starts_nothing() {
    let home = TestHome::new("statusempty");
    assert_eq!(
        said(&home.run_facade(&["status"])),
        (
            format!(
                "Facade did not respond.\n  Home:      {}\n",
                home.path.display()
            ),
            "Facade starts by itself when a command needs it.\n".to_string(),
            Some(0)
        )
    );
    let json = home.run_facade(&["status", "--json"]);
    assert_eq!(
        said(&json),
        (
            format!(
                "{}\n",
                facade_scenarios::serde_json::to_string_pretty(
                    &json!({ "running": false, "home": home.path.display().to_string() })
                )
                .unwrap()
            ),
            String::new(),
            Some(0)
        )
    );
    assert!(
        !socket_exists(&home.daemon_socket()) && home.processes().is_empty(),
        "status started Facade"
    );
}

/// `status` where Facade runs shows this command's version, the services and the agent count, and
/// changes nothing.
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
    assert_eq!(
        said(&home.run_facade(&["status"])),
        (
            format!(
                "Facade is running.\n  Home:      {}\n  Version:   {version}\n  Daemon:    pid \
                 {daemon}\n  Keeper:    pid {keeper}\n  Agents:    1\n",
                home.path.display()
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
            "running": true,
            "home": home.path.display().to_string(),
            "version": version,
            "daemon": { "pid": daemon, "build": version },
            "keeper": { "pid": keeper, "build": version },
            "agents": 1,
        })
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
                && out.contains("integration")
                && out.contains("ls")
                && out.contains("opencode")
                && out.contains("powershell")
                && !out.contains("keeper"),
            "{shell}: completes the public commands, aliases, the integration CLIs and the shells, \
             and no hidden command: {code:?} {err}\n{out}"
        );
    }
    let unknown = home.run_facade(&["completion", "cmd"]);
    assert_eq!(unknown.status.code(), Some(2), "{}", stderr(&unknown));
    assert!(!reached(&home), "a command that needs no Facade reached it");
}
