//! Machine connections through the Facade command and its SSH transport.

use std::ffi::OsString;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Stdio};

use facade_base::address::exact_machine_selector;
use facade_base::machine::{
    AgentRef, ConnectionKind, ConnectionState, MachineInfo, MachineListResult, MessageRef,
};
use facade_base::ssh::{SshMode, decode_home_hex, machine_ssh_args};
use facade_scenarios::serde_json::{self, json};
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

fn table(home: &TestHome) -> Vec<MachineInfo> {
    serde_json::from_str::<MachineListResult>(&home.run_facade_ok(&["machine", "list", "--json"]))
        .unwrap()
        .machines
}

fn row(home: &TestHome, machine: &str) -> Option<MachineInfo> {
    table(home)
        .into_iter()
        .find(|row| row.machine_id == machine)
}

fn name_machine(home: &TestHome, name: &str) -> String {
    let id = table(home)
        .into_iter()
        .find(|row| row.route.as_deref() == Some(&[]))
        .expect("the local machine")
        .machine_id;
    home.run_facade_ok(&["machine", "rename", &exact_machine_selector(&id), name]);
    id
}

struct MachineLink(Child);

impl MachineLink {
    fn open(home: &TestHome, destination: &str, other: &TestHome) -> Self {
        let log = File::create(home.folder().join(format!("connect-{destination}.log"))).unwrap();
        Self(
            home.command(&test_binaries().facade)
                .args(["machine", "connect", destination, "--home"])
                .arg(&other.path)
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
            row(home, target)
                .and_then(|row| row.route)
                .is_some_and(|route| route == hops)
        }),
        "expected {target} via {hops:?}, found {:?}; {}",
        table(home),
        home.daemon_log()
    );
}

fn address(machine_id: &str, agent_id: &str) -> String {
    AgentRef {
        machine_id: machine_id.into(),
        agent_id: agent_id.into(),
    }
    .exact_address()
}

fn acting_for(home: &TestHome, agent: &str) -> DaemonTestClient {
    let mut client = DaemonTestClient::open(home);
    let hello = client.hello("terminal", DAEMON_RANGE, json!({ "agent": agent }));
    assert_eq!(hello["result"]["agent"], agent, "{hello}");
    client
}

fn watch_window(client: &mut DaemonTestClient, topic: &str) -> u64 {
    let response = client.request("watch", json!({ "topic": topic }));
    response["result"]["watch"]
        .as_u64()
        .unwrap_or_else(|| panic!("{response}"))
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

    let sender = first.start_named_fake("caller", &[]);
    let project = facade_base::files::real_path(&second.project).unwrap();
    let project = project.to_str().unwrap();
    first.run_facade_ok(&[
        "start", "--on", "second", "--cwd", project, "--name", "worker", "fake",
    ]);
    let worker = second
        .agent_from_list_json("worker")
        .expect("the remote run");
    let id = worker["agent_id"].as_str().unwrap();
    let target = address(&second_id, id);
    let from = address(&first_id, &sender.id);
    assert_eq!(worker["cwd"], project, "{worker}");
    assert_eq!(worker["machine_id"], second_id, "{worker}");
    assert_eq!(
        first.agent_from_list_json("worker").unwrap()["pid"],
        worker["pid"]
    );
    assert!(wait_for_screen_text(&second, id, "❯"));

    let sent = acting_for(&first, &sender.id).call(
        "agent.send",
        json!({ "to": target, "text": "request across machines" }),
    );
    assert_eq!(
        sent["result"]["message_ref"]["machine_id"], second_id,
        "{sent}"
    );
    assert!(wait_for_screen_text(&second, id, "request across machines"));
    let original: MessageRef =
        serde_json::from_value(sent["result"]["message_ref"].clone()).unwrap();
    let reply = acting_for(&second, id).call(
        "agent.send",
        json!({ "to": from, "text": "reply across machines", "reply_to": original.exact_address() }),
    );
    assert_eq!(
        reply["result"]["message_ref"]["machine_id"], first_id,
        "{reply}"
    );
    assert!(wait_for_screen_text(
        &first,
        &sender.id,
        "reply across machines"
    ));
    let inbox = acting_for(&first, &sender.id).request(
        "watch",
        json!({ "topic": "messages", "args": { "ids": [reply["result"]["message_id"]] } }),
    );
    let received = &inbox["result"]["snapshot"]["messages"][0];
    assert_eq!(
        received["message_ref"], reply["result"]["message_ref"],
        "{inbox}"
    );
    assert_eq!(received["reply_to"], original.message_id, "{received}");
    assert_eq!(
        received["reply_to_machine_id"], original.machine_id,
        "{received}"
    );
    assert!(
        first
            .run_facade_ok(&["screen", &target])
            .contains("request across machines")
    );
    first.run_facade_ok(&["type", &target, "typed from first", "--enter"]);
    assert!(wait_for_screen_text(&second, id, "typed from first"));

    let mut terminal = TestTerminal::spawn(
        first.command(&programs.facade).args(["attach", &target]),
        110,
        30,
    );
    assert!(
        terminal.wait_for(secs(10), |screen| screen.contains("typed from first")),
        "{}",
        terminal.text()
    );
    drop(link);
    assert!(
        terminal.wait_for_output(secs(15), "Keys you type now are not sent"),
        "{}",
        terminal.text()
    );
    let refused = connect(&first).call("agent.screen", json!({ "agent": target }));
    assert_eq!(error_reason(&refused), "unavailable", "{refused}");
    assert_eq!(
        second.agent_from_list_json("worker").unwrap()["pid"],
        worker["pid"]
    );
    assert!(terminal.wait_exit(secs(0)).is_none(), "{}", terminal.text());
    terminal.send(b"discard while disconnected");
    second.run_facade_ok(&["type", id, "drawn while disconnected", "--enter"]);
    let _link = MachineLink::open(&first, "second", &second);
    assert!(
        terminal.wait_for(secs(15), |screen| screen
            .contains("drawn while disconnected")),
        "{}",
        terminal.text()
    );
    terminal.send(b"typed after refresh\r");
    assert!(wait_for_screen_text(&second, id, "typed after refresh"));
    assert!(!second.screen(id).contains("discard while disconnected"));
    terminal.send(b"\x1d");
    assert!(
        terminal
            .wait_exit(secs(10))
            .is_some_and(|exit| exit.success())
    );

    first.run_facade_ok(&["stop", &target]);
    assert_eq!(
        second.agent_from_list_json("worker").unwrap()["process"],
        "ended"
    );
}

/// A window adopts the original agent across the link and receives the message from its running
/// machine on that window's messages subscription.
#[test]
fn a_window_adopts_a_remote_agent_and_receives_its_message() {
    let local = TestHome::new("machine-window");
    let remote = TestHome::new("machine-window-peer");
    install_machine_ssh(
        &[("local", &local), ("remote", &remote)],
        &test_binaries().facade,
    );
    let remote_id = name_machine(&remote, "remote");
    let (mut editor, window) = ide_binding(
        &local,
        &json!({
            "id": "desk", "label": "desk", "environment": "local", "folders": [local.project],
        }),
    );
    let agents = watch_window(&mut editor, "agents");
    let messages = watch_window(&mut editor, "messages");
    let _link = MachineLink::open(&local, "remote", &remote);
    wait_for_route(&local, &remote_id, &[&remote_id]);
    assert!(
        wait_until(secs(10), || editor.changes(agents).iter().any(|event| {
            let change = &event["change"];
            change["kind"] == "machine_state"
                && change["machine"]["machine_id"] == remote_id
                && change["machine"]["state"] == "synced"
                && change["machine"]["agents"].is_array()
        })),
        "{:?}",
        editor.changes(agents)
    );
    let orphan = remote.start_named_fake("teller", &[]);
    let adopted = editor.call(
        "agent.adopt",
        json!({ "agent": address(&remote_id, &orphan.id) }),
    );
    assert!(
        adopted["result"]["windows"]
            .as_array()
            .is_some_and(|members| members.contains(&json!(window))),
        "{adopted}"
    );
    assert!(
        wait_until(secs(10), || editor.changes(agents).iter().any(|event| {
            let agent = &event["change"]["agent"];
            agent["agent_id"] == orphan.id
                && agent["machine_id"] == remote_id
                && agent["pid"] == orphan.pid
        })),
        "{:?}",
        editor.changes(agents)
    );

    let sent = acting_for(&remote, &orphan.id).call(
        "agent.send",
        json!({ "to": "#human", "text": "the remote agent is ready" }),
    );
    assert_eq!(
        sent["result"]["windows"]["delivered"],
        json!([window]),
        "{sent}"
    );
    let number = &sent["result"]["message_ref"];
    assert_eq!(number["machine_id"], remote_id, "{sent}");
    assert!(
        wait_until(secs(10), || editor.changes(messages).iter().any(|event| {
            let message = &event["change"]["message"];
            message["message_ref"] == *number && message["text"] == "the remote agent is ready"
        })),
        "{:?}",
        editor.changes(messages)
    );
}

/// The direct route supersedes two hops. After the direct link is lost, calls use the remaining
/// route. A saved offline peer prevents even a unique name from being used.
#[test]
fn three_machines_switch_routes_and_resolve_names_only_when_all_answer() {
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
    let target = address(&third_id, &distant.id);
    third.run_facade_ok(&["type", &distant.id, "through the middle", "--enter"]);
    assert!(
        first
            .run_facade_ok(&["screen", "lookout"])
            .contains("through the middle")
    );

    let nearby = first.started_agent(&first.run_facade_ok(&["start", "--name", "lookout", "fake"]));
    assert!(wait_for_screen_text(&first, &nearby.id, "❯"));
    let refused = connect(&first).call("agent.screen", json!({ "agent": "lookout" }));
    assert_eq!(error_reason(&refused), "ambiguous_reference", "{refused}");
    let candidates = refused["error"]["data"]["candidates"].as_array().unwrap();
    assert!(
        candidates.contains(&json!(address(&first_id, &nearby.id))),
        "{refused}"
    );
    assert!(candidates.contains(&json!(target)), "{refused}");
    first.run_facade_ok(&["rename", &nearby.id, "other"]);

    first.run_facade_ok(&[
        "machine",
        "add",
        "third",
        "--home",
        third.path.to_str().unwrap(),
    ]);
    wait_for_route(&first, &third_id, &[&third_id]);
    assert!(
        row(&first, &third_id)
            .unwrap()
            .connections
            .iter()
            .any(|connection| {
                connection.kind == ConnectionKind::Saved
                    && connection.state == ConnectionState::Connected
            })
    );
    first.run_facade_ok(&["machine", "rename", "third", "lookout-host"]);
    assert!(wait_until(secs(10), || row(&middle, &third_id)
        .is_some_and(|machine| machine.name == "lookout-host")));

    name_machine(&duplicate, "duplicate");
    duplicate.kill_home_processes();
    rusqlite::Connection::open(duplicate.path.join("core/facade.db"))
        .unwrap()
        .execute("UPDATE machine SET machine_id = ?1", [&third_id])
        .unwrap();
    let conflict = first.run_facade(&[
        "machine",
        "connect",
        "duplicate",
        "--home",
        duplicate.path.to_str().unwrap(),
    ]);
    assert!(!conflict.status.success(), "{conflict:?}");
    assert!(
        stderr(&conflict).contains("is in use by two running daemons")
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

    first.run_facade_ok(&[
        "machine",
        "add",
        "third",
        "--home",
        third.path.to_str().unwrap(),
    ]);
    std::fs::write(third.folder().join("ssh-offline"), []).unwrap();
    drop(right);
    third.kill_home_processes();
    assert!(wait_until(secs(15), || row(&first, &third_id)
        .is_some_and(|machine| machine.route.is_none())));
    let refused = connect(&first).call("agent.screen", json!({ "agent": "other" }));
    assert_eq!(error_reason(&refused), "unavailable", "{refused}");
    assert_eq!(
        refused["error"]["data"]["unavailable"]["execution"], "not_executed",
        "{refused}"
    );
    assert!(
        refused["error"]["data"]["unavailable"]["unanswered"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["machine_id"] == third_id),
        "{refused}"
    );
    first.run_facade_ok(&["machine", "remove", "lookout-host"]);
    assert!(
        connect(&first).call("agent.screen", json!({ "agent": "other" }))["result"].is_object()
    );
}
