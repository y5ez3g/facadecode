//! Machine connections through the Facade command and its SSH transport.

use std::ffi::OsString;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Stdio};

use facade_base::files::real_path;
use facade_base::ssh::{SshMode, decode_home_hex, machine_ssh_args};
use facade_scenarios::serde_json::{self, Value, json};
use facade_scenarios::*;

/// Stdio accepts a machine introduction as its first frame before opening the local daemon.
#[test]
fn machine_serve_passes_only_machine_hello_to_the_daemon() {
    let home = TestHome::new("machinefirst");
    let hello = |params| json!({ "jsonrpc": "2.0", "id": 1, "method": "hello", "params": params });
    let machine = json!({
        "kind": "machine", "protocol": DAEMON_RANGE, "build": "test",
        "machine": {
            "machine_id": "67cafe12-9a12-4b73-8e9f-cc2d44289832",
            "boot_id": "833b79e1-0fca-44f9-b480-1d8072f3d975", "name": "peer",
            "protocol": DAEMON_RANGE, "build": "test",
        },
    });
    let valid = hello(machine.clone());
    let mut relay = machine;
    relay["relay"] = json!({});
    let serve = |input: String| {
        let mut child = home
            .command(&test_binaries().facade)
            .args(["machine", "serve"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
        child.wait_with_output().unwrap()
    };
    for first in [
        hello(json!({ "kind": "terminal", "protocol": DAEMON_RANGE, "build": "test" })),
        hello(json!({ "kind": "machine", "protocol": DAEMON_RANGE, "build": "test" })),
        hello(relay),
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "call",
            "params": { "op": "machine.list", "args": {} },
        }),
    ] {
        // A valid introduction in the second frame must not start a session.
        let output = serve(format!("{first}\n{valid}\n"));
        assert_eq!(output.status.code(), Some(1), "{first}: {output:?}");
        assert!(output.stdout.is_empty(), "{first}: {output:?}");
        assert!(
            stderr(&output).contains("requires a machine hello as its first frame"),
            "{first}: {}",
            stderr(&output)
        );
        assert!(!home.path.join("core").exists(), "{first}: daemon started");
    }

    // A machine introduction reaches the daemon, which negotiates the protocol version.
    let mut future = valid;
    let version = json!([u32::MAX, u32::MAX]);
    future["params"]["protocol"] = version.clone();
    future["params"]["machine"]["protocol"] = version;
    let output = serve(format!("{future}\n"));
    assert!(output.status.success(), "{}", stderr(&output));
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["id"], future["id"], "{reply}");
    assert_eq!(error_reason(&reply), "protocol_incompatible", "{reply}");
}

/// All modes pass an encoded home in one word and keep interactive and saved options distinct.
#[test]
fn ssh_arguments_for_add_connect_and_saved_sessions() {
    const DESTINATION: &str = "qa@peer";
    const REMOTE_HOME: &str = "/two's 家";
    const HOME_HEX: &str = "2f74776f277320e5aeb6";
    let control = Path::new("/tmp/facade-qa-control");

    for mode in [SshMode::Add, SshMode::Connect, SshMode::Saved] {
        let mut expected = [
            "-T",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
        ]
        .map(OsString::from)
        .to_vec();
        if mode == SshMode::Saved {
            expected.extend(["-o", "BatchMode=yes"].map(OsString::from));
        }
        if cfg!(unix) {
            let options: &[&str] = match mode {
                SshMode::Add | SshMode::Saved => &[
                    "-o",
                    "ControlMaster=auto",
                    "-o",
                    "ControlPath=/tmp/facade-qa-control/%C",
                    "-o",
                    "ControlPersist=60s",
                ],
                SshMode::Connect => &["-o", "ControlMaster=no", "-o", "ControlPath=none"],
            };
            expected.extend(options.iter().map(OsString::from));
        }
        expected.extend(
            [
                "--",
                DESTINATION,
                "facade",
                "machine",
                "serve",
                "--home-hex",
                HOME_HEX,
            ]
            .map(OsString::from),
        );
        let words = machine_ssh_args(DESTINATION, Some(REMOTE_HOME), mode, Some(control)).unwrap();
        assert_eq!(words, expected, "{mode:?}");
    }
    assert_eq!(decode_home_hex(HOME_HEX).unwrap(), REMOTE_HOME);
}

fn machines_json(home: &TestHome) -> Value {
    connect(home).call_ok("machine.list", json!({}))
}

fn machine_in(listed: &Value, id: &str) -> Option<Value> {
    listed["machines"]
        .as_array()?
        .iter()
        .find(|row| row["machine_id"] == id)
        .cloned()
}

fn machine_json(home: &TestHome, id: &str) -> Option<Value> {
    machine_in(&machines_json(home), id)
}

fn wait_for_machine_state(home: &TestHome, id: &str, state: &str) -> Value {
    let mut found = None;
    assert!(
        wait_until(secs(15), || {
            found = machine_json(home, id).filter(|row| row["state"] == state);
            found.is_some()
        }),
        "could not observe {id} in state {state}: {}; {}",
        machines_json(home),
        home.daemon_log()
    );
    found.unwrap()
}

fn saved_ssh<'a>(machine: &'a Value, initiator: &str) -> &'a Value {
    machine["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|link| link["kind"] == "saved" && link["initiator_machine_id"] == initiator)
        .unwrap_or_else(|| panic!("no saved SSH link from {initiator}: {machine}"))
}

fn name_machine(home: &TestHome, name: &str) -> String {
    let _connection = connect(home);
    let hello = home.hello_result().expect("the local daemon");
    let id = hello["machine_id"]
        .as_str()
        .expect("the local machine")
        .to_string();
    let selector = id.replace('-', "");
    home.run_facade_ok(&["machine", "rename", &selector, name]);
    id
}

struct MachineLink(Child);

impl MachineLink {
    fn open(home: &TestHome, destination: &str, other: &TestHome) -> Self {
        Self::using(&test_binaries().facade, home, destination, other)
    }

    fn using(program: &Path, home: &TestHome, destination: &str, other: &TestHome) -> Self {
        let log = File::create(home.folder().join(format!("connect-{destination}.log"))).unwrap();
        Self(
            home.command(program)
                .args(["machine", "connect", "--home"])
                .arg(&other.path)
                .arg(destination)
                .stdin(Stdio::null())
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        )
    }
}

impl Drop for MachineLink {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_for_route(home: &TestHome, target: &str, hops: &[&str]) {
    assert!(
        wait_until(secs(15), || {
            machine_json(home, target).is_some_and(|row| row["route"] == json!(hops))
        }),
        "expected {target} via {hops:?}, found {:?}; {}",
        machines_json(home),
        home.daemon_log()
    );
}

/// Location and CLI queries use the target machine. The remote start creates the worktree from
/// that repository's current HEAD, and both Attach clients reach the same terminal.
#[test]
fn a_remote_start_opens_a_worktree_at_the_remote_head() {
    let local = TestHome::new("worktree-local");
    let remote = TestHome::new("worktree-remote");
    let programs = test_binaries();
    let settings = |home: &TestHome, clis: Value| {
        std::fs::write(
            home.path.join("facade.json"),
            json!({ "yolo": true, "clis": clis }).to_string(),
        )
        .unwrap();
    };
    settings(
        &local,
        json!({ "laptop-only": { "type": "fake", "command": programs.fakecli } }),
    );
    settings(
        &remote,
        json!({
            "devbox-only": { "type": "fake", "command": programs.fakecli },
            "devbox-missing": { "type": "fake", "command": remote.folder().join("missing-cli") },
        }),
    );
    install_machine_ssh(
        &[("qa-laptop", &local), ("devbox", &remote)],
        &programs.facade,
    );
    let local_id = name_machine(&local, "qa-laptop");
    let remote_id = name_machine(&remote, "devbox");

    let git = |folder: &std::path::Path, args: &[&str]| {
        let output = remote
            .command("git")
            .current_dir(folder)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {}", stderr(&output));
        stdout(&output).trim().to_string()
    };
    let commit = |message: &str| {
        git(
            &remote.project,
            &[
                "-c",
                "user.name=Facade QA",
                "-c",
                "user.email=qa@example.invalid",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                message,
            ],
        );
    };
    git(&remote.project, &["init", "-q", "-b", "main"]);
    commit("initial");
    git(&remote.project, &["switch", "-q", "-c", "remote-base"]);
    commit("current HEAD");
    let head = git(&remote.project, &["rev-parse", "HEAD"]);
    let folder = facade_base::files::real_path(&remote.project).unwrap();
    // Model a server that accepts its initial foreground login and rejects BatchMode.
    let password_only = remote.folder().join("ssh-password-only");
    std::fs::write(&password_only, []).unwrap();
    let remote_home = remote.path.to_str().unwrap();
    let add = local
        .command(&programs.facade)
        .args([
            "machine",
            "add",
            "--home",
            remote_home,
            "-p",
            "2222",
            "devbox",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let captured = std::thread::spawn(move || add.wait_with_output().unwrap());
    assert!(
        wait_until(LOADED_TIMEOUT, || captured.is_finished()),
        "machine add must return captured stdout and stderr while its SSH session stays open"
    );
    let output = captured.join().unwrap();
    let added = stdout(&output);
    assert!(output.status.success(), "{added}\n{}", stderr(&output));
    assert!(added.contains("Saved the connection to"), "{added}");
    let status = connect(&local).call_ok("daemon.status", json!({ "machine": "devbox" }));
    assert_eq!(
        real_path(Path::new(status["home"].as_str().unwrap())).unwrap(),
        real_path(&remote.path).unwrap(),
        "the first call immediately reaches the saved machine"
    );
    assert_eq!(
        std::fs::read_to_string(remote.folder().join("ssh-attempts"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["interactive 2222 login"],
        "add and the first operation use one foreground SSH stream"
    );
    let machine = machine_json(&local, &remote_id).expect("the saved devbox");
    assert_eq!(machine["state"], "online", "{machine}");
    assert_eq!(machine["route"], json!([remote_id]), "{machine}");
    let connection = saved_ssh(&machine, &local_id);
    assert_eq!(connection["state"], "connected");
    assert_eq!(connection["ssh_args"], json!(["-p", "2222", "devbox"]));
    assert_eq!(connection["remote_home"], remote_home);

    let env = local
        .isolating_env()
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut wire = connect(&local);
    let local_clis = wire.call("cli.list", json!({ "folder": local.project, "env": env }));
    assert!(
        local_clis["result"]["clis"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cli| cli["cli"] == "laptop-only" && cli["available"] == true),
        "{local_clis}"
    );
    let locations = wire.call(
        "location.list",
        json!({ "machine": "devbox", "folders": [folder] }),
    );
    assert!(
        locations["result"]["locations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|location| location["path"] == json!(folder) && location["kind"] == "main"),
        "{locations}"
    );
    let available = wire.call(
        "cli.list",
        json!({ "machine": "devbox", "folder": folder, "env": env }),
    );
    let remote_clis = available["result"]["clis"]
        .as_array()
        .expect("the remote CLI list");
    assert!(
        !remote_clis.iter().any(|cli| cli["cli"] == "laptop-only"),
        "{available}"
    );
    assert!(
        remote_clis
            .iter()
            .any(|cli| cli["cli"] == "devbox-only" && cli["available"] == true),
        "{available}"
    );
    let missing = remote_clis
        .iter()
        .find(|cli| cli["cli"] == "devbox-missing")
        .expect("a configured CLI");
    assert_eq!(missing["available"], false, "{missing}");
    assert!(
        missing["problem"].as_str().unwrap().contains("missing-cli"),
        "{missing}"
    );

    let observer = local.start_named_fake("observer", &[]);
    let mut relay = McpTestClient::open_configured(&local, &observer.id);
    let refused = relay.call(
        "start_agent",
        json!({ "machine": "devbox", "folder": folder, "cli": "laptop-only" }),
    );
    assert_eq!(refused["status"], "failure", "{refused}");
    let problem = refused["message"]
        .as_str()
        .expect("the CLI failure explains available choices");
    assert!(
        problem.contains("laptop-only") && problem.contains("devbox-only"),
        "{refused}"
    );
    assert!(
        remote.agents().is_empty(),
        "the remote machine started nothing"
    );

    let started = local.run_facade_ok(&[
        "start",
        "-d",
        "--machine",
        "devbox",
        "--workdir",
        folder.to_str().unwrap(),
        "--worktree",
        "feat-x",
        "--name",
        "worker",
        "devbox-only",
    ]);
    let address = started_ref(&started);
    assert!(address.ends_with("@devbox"), "{started}");
    let worktree = remote.project.with_extension("worktrees").join("feat-x");
    assert_eq!(git(&worktree, &["branch", "--show-current"]), "feat-x");
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), head);
    let inspected = local.inspect_agent(address);
    let agent = &inspected["agent"];
    let worktree = facade_base::files::real_path(&worktree).unwrap();
    assert_eq!(agent["address"], address);
    assert_eq!(agent["machine_id"], remote_id);
    assert_eq!(agent["cwd"], worktree.to_str().unwrap());
    assert_eq!(
        started,
        format!(
            "Started worker ({address}) in the background.\nWorktree: {}\n",
            worktree.display()
        )
    );

    let mut first = TestTerminal::spawn(
        local.command(&programs.facade).args(["attach", address]),
        88,
        24,
    );
    let mut second = TestTerminal::spawn(
        remote.command(&programs.facade).args(["attach", address]),
        88,
        24,
    );
    for terminal in [&first, &second] {
        assert!(terminal.wait_for(LOADED_TIMEOUT, |screen| screen.contains("❯")));
    }
    let marker = "typed through the remote worktree";
    first.send(format!("{marker}\r").as_bytes());
    for terminal in [&mut first, &mut second] {
        assert!(
            terminal.wait_for(LOADED_TIMEOUT, |screen| screen.contains(marker)),
            "{}",
            terminal.text()
        );
        terminal.send(b"\x1d");
        assert!(
            terminal
                .wait_exit(LOADED_TIMEOUT)
                .is_some_and(|exit| exit.success())
        );
    }
    assert!(remote.screen(address).contains(marker));

    // This phase models a saved login that also works without interaction.
    std::fs::remove_file(password_only).unwrap();
    assert_eq!(
        local.run_facade_ok(&["stop", address]),
        format!("Stopped worker ({address}).\n")
    );
    remote.wait_for_idle_exit();
    let sleeping = wait_for_machine_state(&local, &remote_id, "sleeping");
    assert!(sleeping.get("route").is_none(), "{sleeping}");
    let machine_table = local.run_facade(&["machine", "list"]);
    assert_eq!(
        machine_table.status.code(),
        Some(0),
        "{}",
        stderr(&machine_table)
    );
    assert!(
        machine_table.stderr.is_empty(),
        "{}",
        stderr(&machine_table)
    );
    let table = Table::parse(&stdout(&machine_table));
    let row = table.row("NAME", "devbox").expect("a saved machine row");
    assert_eq!(table.cell(row, "STATE"), "Sleeping");
    assert!(
        remote.hello_result().is_none(),
        "machine list leaves the peer asleep"
    );
    local.run_facade_ok(&["list"]);
    let roster = local.agent_list();
    let peer = machine_in(&roster, &remote_id).expect("the saved machine remains listed");
    assert_eq!(peer["state"], "sleeping", "{roster}");
    assert_eq!(peer["status"], "unavailable", "{roster}");
    assert!(
        remote.hello_result().is_none(),
        "a bare roster leaves the peer asleep"
    );

    let status = connect(&local).call_ok("daemon.status", json!({ "machine": "devbox" }));
    assert_eq!(
        real_path(Path::new(status["home"].as_str().unwrap())).unwrap(),
        real_path(&remote.path).unwrap(),
        "naming the saved machine wakes its daemon"
    );
    assert_eq!(remote.hello_result().unwrap()["machine_id"], remote_id);
    wait_for_route(&local, &remote_id, &[&remote_id]);
}

/// Both interfaces list the newest agents first and provide the same usable addresses.
#[test]
fn agent_lists_are_newest_first_across_machines() {
    let first = TestHome::new("list-first");
    let second = TestHome::new("list-second");
    install_machine_ssh(
        &[("first", &first), ("second", &second)],
        &test_binaries().facade,
    );
    name_machine(&first, "first");
    let second_id = name_machine(&second, "second");

    let caller = first.start_named_fake("caller", &[]);
    first.start_named_fake("local-2", &[]);
    second.start_named_fake("remote", &[]);
    for number in 3..=10 {
        first.start_named_fake(&format!("local-{number}"), &[]);
    }
    let _link = MachineLink::open(&first, "second", &second);
    wait_for_route(&first, &second_id, &[&second_id]);

    let expected = [
        "a10@first",
        "a9@first",
        "a8@first",
        "a7@first",
        "a6@first",
        "a5@first",
        "a4@first",
        "a3@first",
        "a1@second",
        "a2@first",
        "a1@first",
    ];
    let table = first.list_table();
    assert_eq!(table.column("REF"), expected);
    let listed = first.agent_list();
    let mut agents = listed["agents"].as_array().unwrap().clone();
    let ids: Vec<_> = agents
        .iter()
        .map(|agent| agent["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, expected);
    assert!(agents.windows(2).all(|pair| {
        pair[0]["started_at"].as_str().unwrap() >= pair[1]["started_at"].as_str().unwrap()
    }));
    assert!(agents.iter().all(|agent| agent["type"] == "managed"
        && agent.get("address").is_none()
        && agent.get("agent_id").is_none()
        && agent.get("label").is_none()));

    for agent in &mut agents {
        agent.as_object_mut().unwrap().shift_remove("reference");
    }
    let mut mcp = McpTestClient::open(&first, &caller.id);
    let response = mcp.call("list_agents", json!({}));
    assert_eq!(response["status"], "success", "{response}");
    let machines = response["data"]["machines"].as_array().unwrap();
    assert_eq!(machines.len(), 2, "{response}");
    for machine in machines {
        assert_eq!(machine["state"], "online", "{machine}");
        assert_eq!(machine["status"], "answered", "{machine}");
        assert!(machine.get("answered_at").is_none(), "{machine}");
        assert!(machine.get("responded_at").is_none(), "{machine}");
        assert!(machine.get("unreachable").is_none(), "{machine}");
    }
    let rows = response["data"]["agents"]
        .as_array()
        .expect("listed agents");
    assert_eq!(rows, &agents);

    let target = &rows[8]["id"];
    assert_eq!(target, "a1@second");
    let screen = mcp.call("read_screen", json!({ "agent": target }));
    assert_eq!(screen["status"], "success", "{screen}");

    name_machine(&second, "first");
    assert!(wait_until(secs(10), || machine_json(&first, &second_id)
        .is_some_and(|row| row["name"] == "first")));
    let duplicate = mcp.call("list_agents", json!({}));
    let target = &duplicate["data"]["agents"][8]["id"];
    let selector = target.as_str().unwrap().strip_prefix("a1@").unwrap();
    assert!(
        selector.len() >= 8 && second_id.replace('-', "").starts_with(selector),
        "{duplicate}"
    );
    let screen = mcp.call("read_screen", json!({ "agent": target }));
    assert_eq!(screen["status"], "success", "{screen}");
}

/// A temporary link is symmetric. The agent stays on its running machine through a disconnected
/// attach, and its terminal can be operated again once the screen is refreshed.
#[test]
fn two_machines_start_message_attach_and_stop_the_same_agent() {
    let first = TestHome::new("machine-first");
    let second = TestHome::new("machine-second");
    let programs = test_binaries();
    install_machine_ssh(&[("first", &first), ("second", &second)], &programs.facade);
    let first_id = name_machine(&first, "first");
    let second_id = name_machine(&second, "second");
    let link = MachineLink::open(&first, "second", &second);
    wait_for_route(&first, &second_id, &[&second_id]);
    wait_for_route(&second, &first_id, &[&first_id]);

    let listed = first.run_facade_ok(&["machine", "list"]);
    let remote_row = listed
        .lines()
        .find(|line| line.split_whitespace().next() == Some("second"))
        .expect("the remote machine has a row");
    let selector = remote_row.split_whitespace().nth(1).expect("the ID column");
    assert_eq!(selector, &second_id.replace('-', "")[..8], "{listed}");
    let sender = first.start_named_fake("caller", &[]);
    let project = facade_base::files::real_path(&second.project).unwrap();
    let project = project.to_str().unwrap();
    let started = first.run_facade_ok(&[
        "start",
        "-d",
        "--machine",
        selector,
        "--workdir",
        project,
        "--name",
        "worker",
        "fake",
    ]);
    let worker = second.agent_from_watch("worker").expect("the remote run");
    let id = worker["agent_id"].as_str().unwrap();
    // The command line names an agent of another machine with its machine: a1@second.
    let address = started_ref(&started);
    assert_eq!(address, format!("{id}@second"));
    assert_eq!(
        started,
        format!("Started worker ({address}) in the background.\n")
    );
    let target = format!("{id}@{}", second_id.replace('-', ""));
    let from = format!("{}@first", sender.id);
    assert_eq!(worker["cwd"], project, "{worker}");
    assert_eq!(worker["machine_id"], second_id, "{worker}");
    let remote = connect(&first).call("agent.inspect", json!({ "agent": target }));
    assert_eq!(remote["result"]["agent"]["pid"], worker["pid"], "{remote}");
    // Each machine has an a1 and reaches the other: the address names the worker alone.
    assert!(wait_for_screen_text(&second, &target, "❯"));

    let invalid_budget = connect(&first).call(
        "agent.send",
        json!({ "to": target, "text": "bad budget", "time_left_ms": "1000" }),
    );
    assert_eq!(
        error_reason(&invalid_budget),
        "invalid_argument",
        "{invalid_budget}"
    );
    assert!(
        invalid_budget["error"]["message"]
            .as_str()
            .unwrap()
            .contains("expected u64")
    );
    let mut caller = McpTestClient::open_configured(&first, &sender.id);
    let mut receiver = McpTestClient::open_configured(&second, id);
    let sent = caller.call(
        "send_message",
        json!({ "to": target, "text": "request across machines" }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["id"], "m1@second", "{sent}");
    assert!(wait_for_screen_text(
        &second,
        &target,
        "request across machines"
    ));
    let inbox = receiver.call("read_messages", json!({ "last": 1 }));
    assert_eq!(inbox["status"], "success", "{inbox}");
    let received = &inbox["data"]["messages"][0];
    assert_eq!(received["id"], "m1", "{inbox}");
    assert_eq!(received["from"], from);
    let reply = receiver.call(
        "send_message",
        json!({ "to": received["from"], "text": "reply across machines", "reply_to": received["id"] }),
    );
    assert_eq!(reply["status"], "success", "{reply}");
    let reply_id = reply["data"]["id"].as_str().unwrap();
    assert_eq!(reply_id, "m1@first", "{reply}");
    assert!(wait_for_screen_text(
        &first,
        &sender.address,
        "reply across machines"
    ));
    let expected = format!(
        "📨 Message from worker ({id}@second) · m1 · Reply to m1@second\nreply across machines"
    );
    assert_eq!(first.submitted_messages(), [expected]);
    let read = caller.call("read_messages", json!({ "last": 1 }));
    assert_eq!(read["status"], "success", "{read}");
    let message = &read["data"]["messages"][0];
    assert_eq!(message["from"], format!("{id}@second"), "{read}");
    assert_eq!(message["reply_to"], "m1@second", "{read}");
    assert_eq!(message["id"], "m1", "{read}");
    assert_eq!(message["text"], "reply across machines", "{read}");
    let sent = caller.call(
        "send_message",
        json!({
            "to": message["from"], "reply_to": message["id"], "text": "copied both addresses",
        }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["id"], "m2@second", "{sent}");
    assert!(sent["data"].get("address").is_none(), "{sent}");
    assert!(wait_for_screen_text(
        &second,
        &target,
        "copied both addresses"
    ));
    assert_eq!(
        second.submitted_messages(),
        [
            format!("📨 Message from caller ({from}) · m1\nrequest across machines"),
            format!(
                "📨 Message from caller ({from}) · m2 · Reply to m1@first\ncopied both addresses"
            ),
        ]
    );
    let after = caller.call("read_messages", json!({ "after": reply_id }));
    assert_eq!(after["status"], "success", "{after}");
    assert_eq!(after["data"]["messages"], json!([]), "{after}");
    let foreign = caller.call("read_messages", json!({ "after": sent["data"]["id"] }));
    assert_eq!(foreign["reason"], "invalid_argument", "{foreign}");

    // What the command line printed, and a name with its machine, name the same agent.
    for agent in [target.as_str(), address, "worker@second"] {
        assert!(
            first
                .run_facade_ok(&["screen", agent])
                .contains("request across machines"),
            "{agent}"
        );
    }
    first.run_facade_ok(&["type", &target, "typed from first", "--enter"]);
    assert!(wait_for_screen_text(&second, &target, "typed from first"));

    let mut terminal = TestTerminal::spawn(
        first
            .command(&programs.facade)
            .env("FACADE_TEST_GATES", "attach-evidence")
            .args(["attach", &target]),
        110,
        30,
    );
    assert!(
        terminal.wait_for(secs(10), |screen| screen.contains("typed from first")),
        "{}",
        terminal.text()
    );
    assert!(
        terminal.wait_for_output(secs(0), &format!("Attached to worker ({address}).")),
        "{}",
        terminal.text()
    );
    drop(link);
    let mut wire = connect(&first);
    assert!(
        wait_until(secs(15), || {
            let refused = wire.call("agent.screen", json!({ "agent": target }));
            error_reason(&refused) == "unavailable"
        }),
        "the remote target is still reachable after dropping the link"
    );
    assert_eq!(terminal.output_count(ATTACH_RECONNECT_NOTE), 0);
    assert_eq!(second.agent_record(id).unwrap()["pid"], worker["pid"]);
    assert!(terminal.wait_exit(secs(0)).is_none(), "{}", terminal.text());
    let discarded = b"discard while disconnected";
    terminal.send(discarded);
    first.wait_for_gate("attach-buffered-input");
    second.run_facade_ok(&["type", id, "drawn while disconnected", "--enter"]);
    let _link = MachineLink::open(&first, "second", &second);
    assert!(
        terminal.wait_for(secs(15), |screen| screen
            .contains("drawn while disconnected")),
        "{}",
        terminal.text()
    );
    assert!(terminal.wait_for_output(
        secs(5),
        &format!(
            "Reconnected to worker ({address}). {} bytes typed while disconnected were not sent",
            discarded.len()
        )
    ));
    terminal.send(b"typed after refresh\r");
    assert!(wait_for_screen_text(
        &second,
        &target,
        "typed after refresh"
    ));
    assert!(
        !second
            .screen(&target)
            .contains("discard while disconnected")
    );
    terminal.send(b"\x1d");
    assert!(
        terminal
            .wait_exit(secs(10))
            .is_some_and(|exit| exit.success())
    );

    assert!(
        terminal.wait_for_output(secs(0), &format!("Detached from worker ({address}).")),
        "{}",
        terminal.text()
    );
    assert_eq!(
        first.run_facade_ok(&["stop", &target]),
        format!("Stopped worker ({address}).\n")
    );
    assert_eq!(second.agent_record(id).unwrap()["process"], "ended");
}

/// A remote start defaults to the peer's login folder. Only the execution machine interprets an
/// explicit folder, and an ambiguous selector still fails through the daemon.
#[test]
fn start_folder_uses_the_remote_login_folder_and_requires_absolute_paths() {
    let first = TestHome::new("folder-first");
    let second = TestHome::new("folder-peer");
    let programs = test_binaries();
    install_machine_ssh(&[("second", &second), ("first", &first)], &programs.facade);
    let first_id = name_machine(&first, "first");
    let second_id = name_machine(&second, "second");
    let _link = MachineLink::open(&first, "second", &second);
    wait_for_route(&first, &second_id, &[&second_id]);

    // A start runs a CLI the running machine's settings list: the test CLI by its rule there.
    let fake = "fake";
    first.run_facade_ok(&[
        "start",
        "-d",
        "--machine",
        "second",
        "--name",
        "login",
        fake,
    ]);
    let agent = second.agent_from_watch("login").unwrap();
    let started_folder = Path::new(agent["cwd"].as_str().unwrap());
    assert_eq!(
        real_path(started_folder).unwrap(),
        real_path(&second.user_home()).unwrap(),
        "{agent}"
    );
    assert_eq!(agent["machine_id"], second_id, "{agent}");

    let refused = first.run_facade(&[
        "start",
        "-d",
        "--machine",
        "second",
        "--workdir",
        ".",
        "--name",
        "relative",
        fake,
    ]);
    // The invoking shell needs the selected machine to resolve this location.
    assert_eq!(refused.status.code(), Some(1), "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains("absolute path") && stderr(&refused).contains("second"),
        "{}",
        stderr(&refused)
    );
    assert!(second.listed_agent("relative").is_none());

    first.run_facade_ok(&["machine", "rename", &first_id.replace('-', ""), "second"]);
    let ambiguous =
        first.run_facade(&["start", "-d", "--machine", "second", "--workdir", ".", fake]);
    assert_eq!(ambiguous.status.code(), Some(1), "{}", stderr(&ambiguous));
    assert!(
        stderr(&ambiguous).contains("More than one machine is named"),
        "{}",
        stderr(&ambiguous)
    );
}

#[test]
fn a_cross_machine_send_replays_its_original_settlement_after_reconnect() {
    let origin = TestHome::new("send-origin");
    let peer = TestHome::new("send-peer");
    install_machine_ssh(
        &[("origin", &origin), ("peer", &peer)],
        &test_binaries().facade,
    );
    peer.start_facade_with(&[("FACADE_TEST_GATES", "before-send-answer")]);
    name_machine(&origin, "origin");
    let peer_id = name_machine(&peer, "peer");
    let worker = peer.start_named_fake("worker", &[]);
    let link = MachineLink::open(&origin, "peer", &peer);
    wait_for_route(&origin, &peer_id, &[&peer_id]);
    let text = "one cross-machine submission";
    let args = json!({ "to": "worker", "text": text, "request_id": "across-reconnect" });
    let mut sending = connect(&origin);
    let id = sending.send("call", json!({ "op": "agent.send", "args": args }));
    peer.wait_for_gate("before-send-answer");
    assert!(wait_until(secs(5), || peer
        .submitted_messages()
        .iter()
        .any(|message| message.contains(text))));
    drop(link);
    let first = sending
        .wait_for_response(id, LOADED_TIMEOUT)
        .expect("the cut link settles the call");
    assert_eq!(
        first["error"]["data"]["unavailable"]["execution"], "outcome_unknown",
        "{first}"
    );
    drop(sending);
    peer.release_gate("before-send-answer");
    peer.remove_agent(&worker.id);

    let replacement = origin.start_named_fake("worker", &[]);
    assert_eq!(
        replacement.id, worker.id,
        "machine-local numbers can coincide"
    );
    let daemon = origin.kill_daemon();
    origin
        .wait_for_daemon_after(daemon, LOADED_TIMEOUT)
        .expect("the origin restarted");
    let mut reconnected = connect(&origin);
    let offline = reconnected.call("agent.send", args.clone());
    assert_eq!(
        offline["error"]["data"]["unavailable"]["execution"], "outcome_unknown",
        "{offline}"
    );
    assert!(
        origin.submitted_messages().is_empty(),
        "nothing went to the replacement"
    );

    let _link = MachineLink::open(&origin, "peer", &peer);
    wait_for_route(&origin, &peer_id, &[&peer_id]);
    let replay = reconnected.call("agent.send", args);
    assert_eq!(replay["result"]["id"], "m1@peer", "{replay}");
    assert_eq!(replay["result"]["repeated"], true, "{replay}");
    assert_eq!(replay["result"]["message"]["to"], worker.id, "{replay}");
    assert_eq!(
        replay["result"]["message"]["delivery"]["status"], "success",
        "{replay}"
    );
    assert!(
        origin.submitted_messages().is_empty(),
        "the replacement did not receive the replay"
    );
    assert_eq!(
        peer.submitted_messages()
            .iter()
            .filter(|message| message.contains(text))
            .count(),
        1
    );
}

/// The editor selects the remote run by its roster reference, even when both runs have one number.
#[test]
fn the_editor_selects_the_remote_agent_by_its_roster_reference() {
    let local = TestHome::new("machine-window");
    let remote = TestHome::new("machine-window-peer");
    install_machine_ssh(
        &[("local", &local), ("remote", &remote)],
        &test_binaries().facade,
    );
    let local_id = name_machine(&local, "local");
    let remote_id = name_machine(&remote, "remote");
    let caller = local.start_named_fake("caller", &[]);
    let teller = remote.start_named_fake("teller", &[]);
    assert_eq!(caller.id, teller.id);
    let _link = MachineLink::open(&local, "remote", &remote);
    wait_for_route(&local, &remote_id, &[&remote_id]);
    let mut editor = DaemonTestClient::open(&local);
    let hello = editor.hello("ide", DAEMON_RANGE, json!({}));
    assert_eq!(hello["result"]["machine_id"], local_id, "{hello}");
    assert!(hello["result"].get("window").is_none(), "{hello}");
    let roster = editor.call("agent.list", json!({}));
    let agents = roster["result"]["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2, "{roster}");
    let row = agents
        .iter()
        .find(|row| row["reference"]["machine_id"] == remote_id)
        .unwrap();
    assert_eq!(row["reference"]["agent_id"], teller.id);
    assert_eq!(row["id"], format!("{}@remote", teller.id));
    let inspected = editor.call("agent.inspect", json!({ "reference": row["reference"] }));
    assert_eq!(
        inspected["result"]["agent"]["address"], row["id"],
        "{inspected}"
    );
    assert_eq!(
        inspected["result"]["agent"]["pid"], teller.pid,
        "{inspected}"
    );
    assert!(
        inspected["result"]["agent"].get("windows").is_none(),
        "{inspected}"
    );

    let adopt = editor.call("agent.adopt", json!({ "agent": row["id"] }));
    assert_eq!(error_reason(&adopt), "invalid_argument", "{adopt}");
    let mut mcp = McpTestClient::open_configured(&local, &caller.id);
    let listed = mcp.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    assert!(listed["data"].get("windows").is_none(), "{listed}");
    let human = mcp.call(
        "send_message",
        json!({ "to": "#human", "text": "obsolete destination" }),
    );
    assert_eq!(human["status"], "failure", "{human}");
    assert_eq!(human["reason"], "not_found", "{human}");
    let refused = mcp.call(
        "start_agent",
        json!({
            "name": "wrong-source", "cli": "fake", "machine": "remote",
            "folder": remote.project, "location_source_window": "desk",
        }),
    );
    assert_eq!(refused["status"], "failure", "{refused}");
    assert_eq!(refused["reason"], "invalid_argument", "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("location_source_window"),
        "{refused}"
    );
    assert!(local.listed_agent("wrong-source").is_none());
    assert!(remote.listed_agent("wrong-source").is_none());
}

/// Both v2 windows in the same workspace contribute their real membership after takeover.
#[test]
fn a_legacy_workspace_import_recovers_both_machines_after_adding_the_route() {
    let local = TestHome::new("import-owner");
    let remote = TestHome::new("import-peer");
    let old = v2_facade(&local);
    let endpoints = [("qa-owner", &local), ("qa-peer", &remote)];
    install_machine_ssh(&endpoints, &old);
    for home in [&local, &remote] {
        let outcome = home
            .command(&old)
            .args(["daemon", "--detach"])
            .output()
            .unwrap();
        assert!(outcome.status.success(), "{}", stderr(&outcome));
    }
    let workspace = "13300abc00000001";
    let describe = |id: &str| {
        json!({ "window": {
            "id": id, "label": id, "environment": "local",
            "workspace": workspace, "folders": [&local.project],
        } })
    };
    let mut first = DaemonTestClient::open(&local);
    let first_welcome = first.hello("ide", [2, 2], describe("legacy-first"));
    let local_id = first_welcome["result"]["machine_id"].as_str().unwrap();
    let first_window = &first_welcome["result"]["window"];
    assert_eq!(first_welcome["result"]["build"], V2_TEST_BUILD);
    assert_eq!(first_window["machine_id"], local_id, "{first_welcome}");
    let mut second = DaemonTestClient::open(&local);
    let second_welcome = second.hello("ide", [2, 2], describe("legacy-second"));
    let second_window = &second_welcome["result"]["window"];
    assert_eq!(second_window["machine_id"], local_id, "{second_welcome}");
    assert_ne!(second_window["window_id"], first_window["window_id"]);

    let start = |wire: &mut DaemonTestClient, home: &TestHome, name: &str| {
        let reply = wire.call(
            "agent.start",
            json!({ "command": [&test_binaries().fakecli], "cwd": home.project,
                "name": name, "cols": 80, "rows": 24 }),
        );
        assert_eq!(reply["result"]["agent"]["agent_id"], "a1", "{reply}");
        reply["result"]["agent"].clone()
    };
    let local_run = start(&mut first, &local, "legacy-local");
    assert_eq!(local_run["windows"], json!([first_window]), "{local_run}");
    let mut peer = DaemonTestClient::open(&remote);
    let peer_welcome = peer.hello("terminal", [2, 2], json!({}));
    let peer_id = peer_welcome["result"]["machine_id"].as_str().unwrap();
    assert_ne!(local_id, peer_id);
    let peer_run = start(&mut peer, &remote, "legacy-peer");
    let bridge = MachineLink::using(&old, &local, "qa-peer", &remote);
    assert!(
        wait_until(secs(15), || {
            let reply = second.call("machine.list", json!({}));
            reply["result"]["machines"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["machine_id"] == peer_id && row["route"].is_array())
            })
        }),
        "{}",
        local.daemon_log()
    );
    let peer_address = format!("a1@id:{}", peer_id.replace('-', ""));
    let adopted = second.call("agent.adopt", json!({ "agent": peer_address }));
    assert!(
        adopted["result"]["windows"]
            .as_array()
            .is_some_and(|windows| windows.contains(second_window)),
        "{adopted}"
    );
    drop((first, second, peer, bridge));

    install_machine_ssh(&endpoints, &test_binaries().facade);
    for home in [&local, &remote] {
        home.run_facade_ok(&["daemon", "--takeover"]);
    }
    let mut editor = DaemonTestClient::open(&local);
    let hello = editor.hello("ide", DAEMON_RANGE, json!({}));
    assert_eq!(hello["result"]["protocol"], 3, "{hello}");
    assert!(hello["result"].get("window").is_none(), "{hello}");
    let selector = json!({ "machine_id": local_id, "workspace_key": workspace });
    let owner_ref = json!({ "machine_id": local_id, "agent_id": "a1" });
    let peer_ref = json!({ "machine_id": peer_id, "agent_id": "a1" });
    let partial = editor.call("workspace.import_legacy", selector.clone());
    assert_eq!(partial["result"]["agents"], json!([owner_ref]), "{partial}");
    let partial_machines = partial["result"]["machines"].as_array().unwrap();
    assert_eq!(partial_machines.len(), 1, "{partial}");
    assert_eq!(partial_machines[0]["machine_id"], peer_id, "{partial}");
    assert_eq!(partial_machines[0]["status"], "unavailable", "{partial}");

    local.run_facade_ok(&[
        "machine",
        "add",
        "--home",
        remote.path.to_str().unwrap(),
        "qa-peer",
    ]);
    let complete = editor.call("workspace.import_legacy", selector);
    let complete_machines = complete["result"]["machines"].as_array().unwrap();
    assert_eq!(complete_machines.len(), 1, "{complete}");
    assert_eq!(complete_machines[0]["machine_id"], peer_id, "{complete}");
    assert_eq!(complete_machines[0]["status"], "answered", "{complete}");
    let members = complete["result"]["agents"].as_array().unwrap();
    assert_eq!(members.len(), 2, "{complete}");
    assert!(
        members.contains(&owner_ref) && members.contains(&peer_ref),
        "{complete}"
    );
    for (reference, run, window) in [
        (owner_ref, local_run, first_window),
        (peer_ref, peer_run, second_window),
    ] {
        let single = editor.call(
            "workspace.import_legacy",
            json!({ "machine_id": local_id, "window_id": window["window_id"] }),
        );
        assert_eq!(single["result"]["agents"], json!([reference]), "{single}");
        let live = editor.call("agent.inspect", json!({ "reference": reference }));
        assert_eq!(live["result"]["agent"]["pid"], run["pid"], "{live}");
        assert_eq!(
            live["result"]["agent"]["machine_id"], run["machine_id"],
            "{live}"
        );
    }
}

/// A direct saved route supersedes two hops. The roster keeps saved login details as the route
/// changes, and an offline machine does not block a lookup among the reachable machines.
#[test]
fn three_machines_switch_routes_and_keep_saved_ssh_diagnostics() {
    let first = TestHome::new("route-first");
    let middle = TestHome::new("route-middle");
    let third = TestHome::new("route-third");
    let duplicate = TestHome::new("route-duplicate");
    install_machine_ssh(
        &[
            ("first", &first),
            ("middle", &middle),
            ("third", &third),
            ("duplicate", &duplicate),
        ],
        &test_binaries().facade,
    );
    let first_id = name_machine(&first, "first");
    let middle_id = name_machine(&middle, "middle");
    let third_id = name_machine(&third, "third");
    let _left = MachineLink::open(&first, "middle", &middle);
    let right = MachineLink::open(&middle, "third", &third);
    wait_for_route(&first, &third_id, &[&middle_id, &third_id]);

    let distant = third.start_named_fake("lookout", &[]);
    let target = format!("{}@{}", distant.id, third_id.replace('-', ""));
    third.run_facade_ok(&["type", &distant.id, "through the middle", "--enter"]);
    assert!(
        first
            .run_facade_ok(&["screen", "lookout"])
            .contains("through the middle")
    );

    let nearby = first.start_named_fake("lookout", &[]);
    // Both machines have an a1 and first reaches third: the address names the nearby one alone.
    assert!(wait_for_screen_text(&first, &nearby.address, "❯"));
    let refused = connect(&first).call("agent.screen", json!({ "agent": "lookout" }));
    assert_eq!(error_reason(&refused), "ambiguous_reference", "{refused}");
    let candidates = refused["error"]["data"]["candidates"].as_array().unwrap();
    assert!(
        candidates.contains(&json!(format!("{}@first", nearby.id))),
        "{refused}"
    );
    assert!(
        candidates.contains(&json!(format!("{}@third", distant.id))),
        "{refused}"
    );
    first.run_facade_ok(&["rename", &nearby.address, "other"]);

    let home = third.path.to_str().unwrap();
    let add = ["machine", "add", "--home", home, "-p", "2222", "third"];
    first.run_facade_ok(&add);
    wait_for_route(&first, &third_id, &[&third_id]);
    let listed = first.run_facade_ok(&["machine", "list"]);
    let table = Table::parse(&listed);
    assert_eq!(
        table.header,
        ["NAME", "ID", "STATE", "VERSION", "ROUTE", "SAVED"]
    );
    let row = table.row("NAME", "third").expect("direct machine row");
    assert_eq!(table.cell(row, "ID"), &third_id[..8]);
    assert_eq!(table.cell(row, "STATE"), "Online");
    assert_eq!(table.cell(row, "ROUTE"), "Direct");
    assert_eq!(table.cell(row, "SAVED"), "Yes");
    let connected = machine_json(&first, &third_id).unwrap();
    assert_eq!(connected["state"], "online");
    assert_eq!(connected["route"], json!([third_id]));
    assert!(connected.get("unreachable").is_none(), "{connected}");
    let ssh = saved_ssh(&connected, &first_id);
    assert_eq!(ssh["state"], "connected");
    assert_eq!(ssh["ssh_destination"], "third");
    assert_eq!(ssh["ssh_args"], json!(["-p", "2222", "third"]));
    assert_eq!(ssh["remote_home"], home);
    let last_seen = connected["last_seen"]
        .as_str()
        .expect("a timestamp of the first connection");
    first.run_facade_ok(&["machine", "rename", "third", "lookout-host"]);
    assert!(wait_until(secs(10), || machine_json(&middle, &third_id)
        .is_some_and(|machine| machine["name"] == "lookout-host")));

    name_machine(&duplicate, "duplicate");
    duplicate.kill_home_processes();
    rusqlite::Connection::open(duplicate.path.join("core/facade.db"))
        .unwrap()
        .execute("UPDATE machine SET machine_id = ?1", [&third_id])
        .unwrap();
    let conflict = first.run_facade(&[
        "machine",
        "connect",
        "--home",
        duplicate.path.to_str().unwrap(),
        "duplicate",
    ]);
    assert!(!conflict.status.success(), "{conflict:?}");
    assert!(
        stderr(&conflict).contains("two running machines have the same ID")
            && stderr(&conflict).contains("SSH duplicate"),
        "{}",
        stderr(&conflict)
    );
    wait_for_route(&first, &third_id, &[&third_id]);

    first.run_facade_ok(&["machine", "remove", "lookout-host"]);
    wait_for_route(&first, &third_id, &[&middle_id, &third_id]);
    assert!(
        first
            .run_facade_ok(&["screen", &target])
            .contains("through the middle")
    );

    first.run_facade_ok(&add);
    let hold = third.folder().join("ssh-hold");
    std::fs::write(&hold, []).unwrap();
    drop(right);
    third.kill_home_processes();
    let connecting = wait_for_machine_state(&first, &third_id, "connecting");
    assert!(connecting.get("route").is_none(), "{connecting}");
    let listed = first.agent_list();
    assert_eq!(
        machine_in(&listed, &third_id).unwrap()["state"],
        "connecting",
        "{listed}"
    );
    assert!(
        listed["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|agent| agent["name"] == "other"),
        "{listed}"
    );

    std::fs::write(third.folder().join("ssh-offline"), []).unwrap();
    std::fs::remove_file(hold).unwrap();
    let disconnected = wait_for_machine_state(&first, &third_id, "unreachable");
    assert!(disconnected.get("unreachable").is_none(), "{disconnected}");
    assert!(disconnected.get("route").is_none(), "{disconnected}");
    let direct = saved_ssh(&disconnected, &first_id);
    assert_eq!(direct["state"], "unavailable", "{disconnected}");
    assert_eq!(direct["ssh_args"], ssh["ssh_args"]);
    assert_eq!(direct["remote_home"], ssh["remote_home"]);
    assert!(
        disconnected["last_seen"].as_str().unwrap() >= last_seen,
        "{disconnected}"
    );
    assert!(
        disconnected["ssh_error"]
            .as_str()
            .unwrap()
            .contains("ssh: connect to host third: Connection refused"),
        "{disconnected}"
    );

    std::fs::write(third.folder().join("ssh-needs-login"), []).unwrap();
    let needs_login = wait_for_machine_state(&first, &third_id, "ssh_interaction_required");
    let direct = saved_ssh(&needs_login, &first_id);
    assert_eq!(direct["state"], "ssh_interaction_required");
    assert_eq!(direct["ssh_args"], ssh["ssh_args"]);
    assert_eq!(direct["remote_home"], ssh["remote_home"]);
    let repair = &direct["ssh_interaction"];
    assert_eq!(
        repair["command"],
        json!([
            "facade", "machine", "add", "--home", home, "-p", "2222", "third"
        ])
    );
    assert!(
        repair["reason"]
            .as_str()
            .unwrap()
            .contains("Permission denied (publickey).")
    );
    assert!(
        needs_login["ssh_error"]
            .as_str()
            .unwrap()
            .contains("Permission denied (publickey).")
    );
    assert!(needs_login.get("route").is_none(), "{needs_login}");
    let denied = first.run_facade(&add);
    assert_eq!(denied.status.code(), Some(1), "{}", stderr(&denied));
    assert!(denied.stdout.is_empty(), "{}", stdout(&denied));
    assert!(
        stderr(&denied)
            .contains("Could not connect to third over SSH: Permission denied (publickey).")
            && stderr(&denied).contains("Check your SSH access"),
        "{}",
        stderr(&denied)
    );

    let listed = first.agent_list();
    let offline = machine_in(&listed, &third_id).unwrap();
    assert_eq!(offline["state"], "ssh_interaction_required");
    let mut mcp = McpTestClient::open(&first, &nearby.id);
    let listed = mcp.call("list_agents", json!({}));
    let mcp_offline = listed["data"]["machines"]
        .as_array()
        .unwrap_or_else(|| panic!("{listed}"))
        .iter()
        .find(|machine| machine["machine_id"] == third_id)
        .unwrap();
    assert_eq!(mcp_offline, &offline, "{listed}");

    let refused = connect(&first).call("agent.screen", json!({ "agent": target }));
    assert_eq!(
        error_reason(&refused),
        "ssh_interaction_required",
        "{refused}"
    );
    assert_eq!(
        refused["error"]["data"]["ssh_interaction"], *repair,
        "{refused}"
    );
    assert!(
        connect(&first).call("agent.screen", json!({ "agent": "other" }))["result"].is_object(),
        "the offline saved peer does not block a unique reachable agent"
    );
    first.run_facade_ok(&["machine", "remove", "lookout-host"]);
    assert!(
        connect(&first).call("agent.screen", json!({ "agent": "other" }))["result"].is_object()
    );
}
