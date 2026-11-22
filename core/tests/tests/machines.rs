//! Machine connections through the Facade command and its SSH transport.

use std::ffi::OsString;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
        "kind": "machine", "api_versions": [1], "build": "test",
        "machine": {
            "machine_id": "67cafe12-9a12-4b73-8e9f-cc2d44289832",
            "boot_id": "833b79e1-0fca-44f9-b480-1d8072f3d975", "name": "peer",
        },
    });
    let valid = hello(machine.clone());
    let mut relay = machine;
    relay["relay"] = json!({});
    let serve = |input: String, no_start| {
        let mut command = home.command(&test_binaries().facade);
        command.args(["machine", "serve"]);
        if no_start {
            command.arg("--no-start");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
        child.wait_with_output().unwrap()
    };
    for first in [
        hello(json!({ "kind": "terminal", "api_versions": [1], "build": "test" })),
        hello(json!({ "kind": "machine", "api_versions": [1], "build": "test" })),
        hello(relay),
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "call",
            "params": { "op": "machine.list", "args": {} },
        }),
    ] {
        // A valid introduction in the second frame must not start a session.
        let output = serve(format!("{first}\n{valid}\n"), false);
        for line in stdout(&output).lines() {
            let reply: Value = serde_json::from_str(line).unwrap();
            assert!(reply.get("result").is_none(), "{first}: {reply}");
        }
        assert!(!home.path.join("core").exists(), "{first}: daemon started");
    }

    let passive = serve(format!("{valid}\n"), true);
    assert_eq!(passive.status.code(), Some(3), "{passive:?}");
    assert!(passive.stdout.is_empty(), "{passive:?}");
    assert!(
        !home.path.join("core").exists(),
        "the passive entry opened a daemon"
    );

    // A valid introduction reaches the actual daemon and selects the API version.
    let output = serve(format!("{valid}\n"), false);
    assert!(output.status.success(), "{}", stderr(&output));
    let first = stdout(&output);
    let reply: Value =
        serde_json::from_str(first.lines().next().expect("the machine hello reply")).unwrap();
    assert_eq!(reply["id"], valid["id"], "{reply}");
    assert_eq!(reply["result"]["api_version"], 1, "{reply}");
    assert!(reply["result"]["machine"]["boot_id"].is_string(), "{reply}");
}

#[test]
fn machine_serve_refuses_invalid_v1_offers_before_opening_the_daemon() {
    let home = TestHome::new("machine-v1-offer");
    let introduction = json!({
        "kind": "machine", "build": "test",
        "machine": {
            "machine_id": "67cafe12-9a12-4b73-8e9f-cc2d44289832",
            "boot_id": "833b79e1-0fca-44f9-b480-1d8072f3d975",
            "name": "peer",
        },
    });
    let hello = |id, offer: Value| {
        let mut params = introduction.clone();
        params
            .as_object_mut()
            .unwrap()
            .extend(offer.as_object().unwrap().clone());
        json!({ "jsonrpc": "2.0", "id": id, "method": "hello", "params": params })
    };
    let continuation = hello(18, json!({ "api_versions": [1] }));
    let invalid = json!({
        "code": -32602,
        "message": "Provide hello.params.api_versions as a non-empty array of positive integers. Use a Facade API v1 build.",
        "data": { "reason": "invalid_argument" },
    });
    let disjoint = json!({
        "code": -32000,
        "message": "No common daemon API version.",
        "data": { "reason": "protocol_incompatible", "details": { "supported_api_versions": [1] } },
    });
    let cases = [
        (json!({}), &invalid),
        (json!({ "protocol": [3, 3] }), &invalid),
        (json!({ "api_versions": null }), &invalid),
        (json!({ "api_versions": [] }), &invalid),
        (json!({ "api_versions": "1" }), &invalid),
        (json!({ "api_versions": [0] }), &invalid),
        (json!({ "api_versions": [2] }), &disjoint),
    ];
    for (offer, error) in cases {
        let first = hello(17, offer);
        let mut child = home
            .command(&test_binaries().facade)
            .args(["machine", "serve"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // A valid second frame must not open a daemon after the first is refused.
        writeln!(child.stdin.take().unwrap(), "{first}\n{continuation}").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{first}: {output:?}");
        assert!(output.stderr.is_empty(), "{first}: {}", stderr(&output));
        assert!(output.stdout.ends_with(b"\n"), "{first}: {output:?}");
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            reply,
            json!({ "jsonrpc": "2.0", "id": 17, "error": error }),
            "{first}"
        );
        assert!(!home.path.join("core").exists(), "{first}: daemon opened");
    }
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

fn saved_ssh(machine: &Value, initiator: &str, peer: &str) -> Value {
    machine["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|link| {
            link["kind"] == "saved"
                && link["initiator_machine_id"] == initiator
                && link["machine_id"] == peer
        })
        .cloned()
        .unwrap_or_else(|| panic!("no saved SSH link from {initiator} to {peer}: {machine}"))
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

fn add_saved(home: &TestHome, destination: &str, other: &TestHome) -> String {
    home.run_facade_ok(&[
        "machine",
        "add",
        "--home",
        other.path.to_str().unwrap(),
        destination,
    ])
}

#[test]
#[ignore = "requires the exact isolated accepted CLI binary in FACADE_TEST_API_V1_PRERELEASE"]
fn cold_cutover_keeps_prerelease_agent_records_and_saved_transport() {
    let old = std::path::PathBuf::from(
        std::env::var_os("FACADE_TEST_API_V1_PRERELEASE").expect("the accepted CLI artifact"),
    );
    assert!(old.is_absolute() && old.is_file(), "{}", old.display());
    let local = TestHome::new("v1-cutover-a");
    let remote = TestHome::new("v1-cutover-b");
    let session = "86da4482-2bae-4a45-b193-a5664c19826a";
    let keys = local.folder().join("cli-keys");
    let transcripts = local.folder().join("transcripts");
    std::fs::create_dir(&transcripts).unwrap();
    let transcript = transcripts.join(format!("{session}.jsonl"));
    std::fs::write(
        local.path.join("facade.json"),
        json!({ "clis": { "fake": {
            "type": "claude", "command": test_binaries().fakecli,
            "env": { "FAKECLI_LOOK": "claude", "FAKECLI_SESSION": session,
                "FAKECLI_TRANSCRIPTS": transcripts, "FAKECLI_KEYS": keys }
        } } })
        .to_string(),
    )
    .unwrap();
    let machines = [("laptop", &local), ("devbox", &remote)];
    install_machine_ssh(&machines, &old);
    let old_call = |home: &TestHome, args: &[&str]| {
        let output = home
            .command(&old)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {}", stderr(&output));
        stdout(&output)
    };
    let open_old = |home: &TestHome, name: &str| {
        old_call(home, &["daemon", "--detach"]);
        let mut wire = DaemonTestClient::open(home);
        let hello = wire.hello_prerelease("terminal", [3, 3], json!({}));
        assert_eq!(hello["result"]["protocol"], 3, "{hello}");
        let id = hello["result"]["machine_id"].as_str().unwrap().to_string();
        old_call(home, &["machine", "rename", &id, name]);
        (wire, id)
    };
    let (mut prior, local_id) = open_old(&local, "laptop");
    let (remote_wire, remote_id) = open_old(&remote, "devbox");
    drop(remote_wire);
    let out = old_call(&local, &["start", "-d", "--name", "kept", "fake"]);
    let address = started_ref(&out);
    let text = "cold cutover delivery from the old Daemon";
    let send = json!({
        "to": address, "text": text, "request_id": "cold-cutover-prior-terminal-send"
    });
    let receipt = prior.call_ok("agent.send", send.clone());
    assert_eq!(receipt["id"], "m1@laptop", "{receipt}");
    assert!(receipt.get("repeated").is_none(), "{receipt}");
    assert_eq!(receipt["message"]["from"], "command_line", "{receipt}");
    assert_eq!(receipt["message"]["text"], text, "{receipt}");
    assert_eq!(
        receipt["message"]["delivery"]["status"], "success",
        "{receipt}"
    );
    assert_eq!(
        receipt["message"]["delivery"]["delivered_via"], "terminal",
        "{receipt}"
    );
    assert_eq!(
        receipt["message"]["delivery"]["text_written"], "full",
        "{receipt}"
    );
    assert_eq!(
        receipt["message"]["delivery"]["enter_written"], true,
        "{receipt}"
    );
    let repeat = |wire: &mut DaemonTestClient| {
        let replay = wire.call_ok("agent.send", send.clone());
        assert_eq!(replay["repeated"], true, "{replay}");
        assert_eq!(replay["id"], receipt["id"], "{replay}");
        assert_eq!(replay["message"], receipt["message"], "{replay}");
        assert_eq!(
            replay["recipient"]["reference"], receipt["recipient"]["reference"],
            "{replay}"
        );
        replay
    };
    let mut old_reconnect = DaemonTestClient::open(&local);
    let hello = old_reconnect.hello_prerelease("terminal", [3, 3], json!({}));
    assert_eq!(hello["result"]["machine_id"], local_id, "{hello}");
    let prior_replay = repeat(&mut old_reconnect);
    drop(old_reconnect);
    assert!(wait_until(LOADED_TIMEOUT, || {
        transcript.is_file()
            && prior.call_ok("agent.inspect", json!({ "agent": address }))["agent"]["session"]
                == session
    }));
    let original_keys = std::fs::read(&keys).unwrap();
    let header = "📨 Message from the command line · m1";
    assert_eq!(
        original_keys,
        format!("📨 Message from \x1b[200~the command line · m1\r{text}\x1b[201~\r").as_bytes()
    );
    let original_transcript = std::fs::read(&transcript).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&original_transcript).unwrap(),
        json!({ "message": format!("{header}\n{text}") })
    );
    old_call(&local, &["stop", address]);
    let record = prior.call_ok("agent.inspect", json!({ "agent": address }))["agent"].clone();
    assert_eq!(record["process"], "ended", "{record}");
    assert_eq!(record["machine_id"], local_id, "{record}");
    assert_eq!(record["session"], session, "{record}");
    assert_eq!(receipt["message"]["to"], record["agent_id"], "{receipt}");
    old_call(
        &local,
        &[
            "machine",
            "add",
            "--home",
            remote.path.to_str().unwrap(),
            "-p",
            "2222",
            "devbox",
        ],
    );
    let old_roster = prior.call_ok("machine.list", json!({}));
    let old_peer = machine_in(&old_roster, &remote_id).expect("the prerelease peer");
    // The initiating machine owns the saved transport, including while the peer is online.
    let old_row = machine_in(&old_roster, &local_id).expect("the prerelease initiator");
    let old_route = saved_ssh(&old_row, &local_id, &remote_id);
    assert_eq!(old_route["remote_home"], json!(remote.path));
    assert!(!old_route["ssh_args"].as_array().unwrap().is_empty());
    let old_keeper = local.lock_record("keeper").expect("the prerelease keeper");
    let old_daemon = local.lock_record("daemon").expect("the prerelease daemon");
    drop(prior);
    local.kill_home_processes();
    remote.kill_home_processes();
    assert!(!alive(&facade_base::process::ProcessIdentity {
        pid: old_keeper.0 as u32,
        birth: old_keeper.1
    }));
    assert!(!alive(&facade_base::process::ProcessIdentity {
        pid: old_daemon.0 as u32,
        birth: old_daemon.1
    }));
    let previous = ssh_attempts(&remote);
    install_machine_ssh(&machines, &test_binaries().facade);

    let mut current = connect(&local);
    let welcome = local.hello_result().unwrap();
    assert_eq!(welcome["api_version"], 1);
    assert_eq!(welcome["machine_id"], local_id);
    let reference = json!({ "machine_id": local_id, "agent_id": record["agent_id"] });
    assert_eq!(receipt["recipient"]["reference"], reference);
    let after = current.call_ok("agent.inspect", json!({ "target": reference }));
    assert_eq!(after["agent"]["reference"], reference);
    for field in [
        "address", "name", "cli", "cwd", "process", "exit", "session",
    ] {
        assert_eq!(after["agent"][field], record[field], "{field}: {after}");
    }
    let migrated_replay = repeat(&mut current);
    let mut fresh = send;
    fresh["request_id"] = json!("cold-cutover-new-request");
    let denied = current.call("agent.send", fresh);
    assert_eq!(error_reason(&denied), "ended", "{denied}");
    assert_eq!(std::fs::read(&keys).unwrap(), original_keys);
    assert_eq!(std::fs::read(&transcript).unwrap(), original_transcript);
    let roster = current.call_ok("machine.list", json!({}));
    let cold_peer = machine_in(&roster, &remote_id).unwrap();
    assert_eq!(cold_peer["state"], "disconnected");
    let row = machine_in(&roster, &local_id).unwrap();
    let route = saved_ssh(&row, &local_id, &remote_id);
    assert_eq!(route["transport"]["kind"], "ssh", "{route}");
    for field in ["ssh_destination", "ssh_args", "remote_home"] {
        assert_eq!(
            route["transport"][field], old_route[field],
            "{field}: {route}"
        );
    }
    let attempts = ssh_attempts(&remote);
    assert_eq!(attempts, previous, "the cold read does not dial");
    drop(connect(&remote));
    assert_eq!(remote.hello_result().unwrap()["machine_id"], remote_id);
    println!(
        "Facade cold cutover evidence {}",
        json!({
            "prior": { "protocol": 3, "agent": record, "saved": old_route, "peer": old_peer },
            "candidate": { "api_version": welcome["api_version"], "agent": after["agent"],
                "saved": route, "peer": cold_peer },
            "ssh_attempts": { "before": previous, "after": attempts },
            "receipt": { "original": receipt, "prior_replay": prior_replay, "candidate_replay": migrated_replay },
            "new_request": denied, "cli_bytes": original_keys,
            "transcript": String::from_utf8_lossy(&original_transcript)
        })
    );
}

#[test]
fn an_authenticated_batch_readd_updates_the_same_saved_machine() {
    let local = TestHome::new("readd-local");
    let remote = TestHome::new("readd-remote");
    install_machine_ssh(
        &[("laptop", &local), ("devbox", &remote)],
        &test_binaries().facade,
    );
    let local_id = name_machine(&local, "laptop");
    let remote_id = name_machine(&remote, "devbox");
    add_saved(&local, "devbox", &remote);
    let attempts = ssh_attempts(&remote);
    let serves = ssh_serves(&remote);

    let remote_home = remote.path.to_str().unwrap();
    local.run_facade_ok(&[
        "machine",
        "add",
        "--home",
        remote_home,
        "-p",
        "2222",
        "devbox",
    ]);
    let machine = machine_json(&local, &local_id).expect("the local roster row");
    let saved = saved_ssh(&machine, &local_id, &remote_id);
    assert_eq!(
        saved["transport"]["ssh_args"],
        json!(["-p", "2222", "devbox"])
    );
    assert_eq!(saved["transport"]["remote_home"], remote_home);
    let after = ssh_attempts(&remote);
    let new_attempts = after.strip_prefix(&attempts).unwrap();
    assert!(new_attempts.contains("batch 2222 "), "{after}");
    assert!(
        new_attempts.lines().all(|line| line.starts_with("batch ")),
        "{after}"
    );
    assert!(
        !ssh_serves(&remote)
            .strip_prefix(&serves)
            .unwrap()
            .contains("admin")
    );
}

#[test]
fn a_guarded_removal_matches_the_exact_saved_id_even_when_a_name_matches() {
    let local = TestHome::new("guarded-remove-local");
    let remote = TestHome::new("guarded-remove-remote");
    install_machine_ssh(
        &[("laptop", &local), ("devbox", &remote)],
        &test_binaries().facade,
    );
    let local_id = name_machine(&local, "laptop");
    // The name is a valid full machine ID, but it belongs to no machine in this pair.
    let absent_id = "6cac4a9c-6bf1-4513-96f5-d5b2bb9aa13d";
    let remote_id = name_machine(&remote, absent_id);
    assert_ne!(remote_id, absent_id);
    add_saved(&local, "devbox", &remote);
    let attempts = ssh_attempts(&remote);

    let mut daemon = connect(&local);
    let absent = daemon.call(
        "machine.remove",
        json!({ "machine": absent_id, "expected_machine_id": absent_id }),
    );
    assert_eq!(error_reason(&absent), "not_found", "{absent}");
    let saved = machine_json(&local, &local_id).expect("the local roster row");
    assert_eq!(saved_ssh(&saved, &local_id, &remote_id)["kind"], "saved");

    let removed = daemon.call_ok(
        "machine.remove",
        json!({ "machine": remote_id, "expected_machine_id": remote_id }),
    );
    assert_eq!(removed["machine_id"], remote_id);
    assert_eq!(ssh_attempts(&remote), attempts);
}

/// A saved destination must introduce its original machine before it can serve any agent.
#[test]
fn a_saved_destination_refuses_a_different_peer_and_keeps_exact_agent_refs() {
    let local = TestHome::new("wrong-peer-origin");
    let peer = TestHome::new("wrong-peer-expected");
    let other = TestHome::new("wrong-peer-unexpected");
    let facade = &test_binaries().facade;
    install_machine_ssh(
        &[("origin", &local), ("devbox", &peer), ("other", &other)],
        facade,
    );
    let local_id = name_machine(&local, "origin");
    let peer_id = name_machine(&peer, "devbox");
    let other_id = name_machine(&other, "other");
    assert_ne!(peer_id, other_id);
    let local_run = local.start_fake_with("worker", &[("FAKECLI_NAME", "local marker")]);
    let peer_run = peer.start_fake_with("worker", &[("FAKECLI_NAME", "peer marker")]);
    assert_eq!(local_run.id, peer_run.id);
    assert!(add_saved(&local, "devbox", &peer).contains("Saved the connection to devbox."));
    wait_for_route(&local, &peer_id, &[&peer_id]);
    let saved = || {
        saved_ssh(
            &machine_json(&local, &local_id).unwrap(),
            &local_id,
            &peer_id,
        )
    };
    let before = saved();
    assert_eq!(before["transport"]["ssh_destination"], "devbox");
    assert_eq!(before["state"], "connected");

    // Relay a new connection for the saved destination to the other real daemon.
    let other_run = other.start_fake("other worker");
    let connections_before = machine_json(&local, &local_id).unwrap()["connections"].clone();
    let mut opening = ManualReadClient::open(&local);
    opening.send(
        1,
        "call",
        json!({ "op": "machine.connect", "args": { "kind": "saved", "transport": before["transport"] } }),
    );
    let authorized = opening
        .read_message()
        .expect("machine connection authorization");
    assert_eq!(authorized["id"], 1, "{authorized}");
    assert_eq!(
        authorized["result"]["expected_machine_id"], peer_id,
        "{authorized}"
    );
    let hello = opening
        .read_message()
        .expect("the origin daemon's machine hello");
    assert_eq!(hello["method"], "hello", "{hello}");
    assert_eq!(
        hello["params"]["machine"]["machine_id"], local_id,
        "{hello}"
    );
    let mut remote = other
        .command(facade)
        .args(["machine", "serve", "--no-start"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(remote.stdin.take().unwrap(), "{hello}").unwrap();
    let served = remote.wait_with_output().unwrap();
    let output = stdout(&served);
    let reply: Value = serde_json::from_str(
        output
            .lines()
            .next()
            .expect("the other daemon's hello reply"),
    )
    .unwrap();
    assert_eq!(reply["id"], hello["id"], "{reply}");
    assert_eq!(reply["result"]["api_version"], 1, "{reply}");
    assert_eq!(reply["result"]["machine_id"], other_id, "{reply}");
    writeln!(opening.writer, "{reply}").unwrap();
    let refused = opening.read_message().expect("the mismatch notification");
    assert_eq!(refused["method"], "connect_failed", "{refused}");
    assert_eq!(refused["jsonrpc"], "2.0", "{refused}");
    assert!(refused.get("id").is_none(), "{refused}");
    let after = opening
        .read_frame()
        .expect("the refused handoff ends cleanly");
    assert!(after.is_none(), "unexpected frame after refusal: {after:?}");
    let error = &refused["params"]["error"]["data"];
    assert_eq!(error["reason"], "machine_id_mismatch", "{refused}");
    assert_eq!(
        error["details"]["expected_machine_id"], peer_id,
        "{refused}"
    );
    assert_eq!(error["details"]["machine_id"], other_id, "{refused}");
    assert!(alive(&other_run.process));
    assert!(machine_json(&local, &other_id).is_none());
    assert_eq!(
        machine_json(&local, &local_id).unwrap()["connections"],
        connections_before,
        "the failed handoff records no successful connection",
    );
    assert_eq!(saved(), before);
    wait_for_route(&local, &peer_id, &[&peer_id]);

    let mut wire = connect(&local);
    let ambiguous = wire.call("agent.inspect", json!({ "target": "worker" }));
    assert_eq!(
        error_reason(&ambiguous),
        "ambiguous_reference",
        "{ambiguous}"
    );
    let candidates = ambiguous["error"]["data"]["details"]["candidates"]
        .as_array()
        .unwrap();
    assert_eq!(candidates.len(), 2, "{ambiguous}");
    for (machine, worker, marker) in [
        (&local_id, &local_run, "local marker"),
        (&peer_id, &peer_run, "peer marker"),
    ] {
        assert!(candidates.contains(&json!(worker.address)), "{ambiguous}");
        let reference = json!({ "machine_id": machine, "agent_id": worker.id });
        let found = wire.call_ok("agent.inspect", json!({ "target": reference }));
        assert_eq!(found["agent"]["reference"], reference, "{found}");
        assert_eq!(found["agent"]["pid"], worker.pid, "{found}");
        assert_eq!(process_identity(worker.pid), worker.process);
        let screen = wire.call_ok("agent.screen", json!({ "target": reference }));
        assert!(
            screen["text"].as_str().unwrap().contains(marker),
            "{screen}"
        );
    }
}

#[test]
fn cold_roster_and_local_lists_never_use_a_saved_ssh_route() {
    let local = TestHome::new("cold-local");
    let remote = TestHome::new("cold-remote");
    install_machine_ssh(
        &[("laptop", &local), ("devbox", &remote)],
        &test_binaries().facade,
    );
    name_machine(&local, "laptop");
    name_machine(&remote, "devbox");
    remote.start_fake("RemoteWorker");
    let session = "86da4482-2bae-4a45-b193-a5664c19826a";
    let saved = local.start_fake_with("Ada", &[("FAKECLI_SESSION", session)]);
    assert!(wait_until(LOADED_TIMEOUT, || local
        .inspect_agent(&saved.address)["agent"]["session"]
        == session));
    local.run_facade_ok(&["stop", &saved.address]);
    add_saved(&local, "devbox", &remote);
    let attempts = ssh_attempts(&remote);
    assert!(!attempts.is_empty());

    // Each command starts with its own cold daemon and the same committed saved route.
    local.kill_home_processes();
    assert!(local.hello_result().is_none());
    let roster = local.run_facade(&["machine", "list"]);
    assert_eq!(
        (roster.status.code(), stderr(&roster)),
        (Some(0), String::new())
    );
    let roster = Table::parse(&stdout(&roster));
    let saved_machine = roster.row("NAME", "devbox").expect("the saved machine");
    assert_eq!(roster.cell(saved_machine, "STATE"), "Disconnected");
    assert_eq!(roster.cell(saved_machine, "ROUTE"), "Direct");
    assert_eq!(roster.cell(saved_machine, "SAVED"), "Yes");
    assert_eq!(ssh_attempts(&remote), attempts);

    local.kill_home_processes();
    assert!(local.hello_result().is_none());
    let listed = local.run_facade(&["list", "--local"]);
    assert_eq!(listed.status.code(), Some(0), "{}", stderr(&listed));
    assert!(listed.stdout.is_empty());
    assert_eq!(
        stderr(&listed),
        "No active agents on laptop.\nStart one with 'facade start codex', or run 'facade resume' to find saved sessions.\n"
    );
    assert_eq!(ssh_attempts(&remote), attempts);

    local.kill_home_processes();
    assert!(local.hello_result().is_none());
    let resumed = local.run_facade(&["resume", "--local"]);
    assert_eq!(resumed.status.code(), Some(0), "{}", stderr(&resumed));
    assert_eq!(
        stderr(&resumed),
        "Resume one with 'facade resume <REFERENCE>'.\n"
    );
    let table = Table::parse(&stdout(&resumed));
    assert_eq!(table.column("REF"), [saved.address.as_str()]);
    assert_eq!(table.column("TYPE"), ["Managed"]);
    assert_eq!(ssh_attempts(&remote), attempts);

    local.kill_home_processes();
    assert!(local.hello_result().is_none());
    let stopped = local.run_facade(&["stop", "--local"]);
    assert_eq!(stopped.status.code(), Some(0), "{}", stderr(&stopped));
    assert!(stopped.stdout.is_empty());
    assert_eq!(
        stderr(&stopped),
        "No running managed agents to stop on laptop.\n"
    );
    assert_eq!(ssh_attempts(&remote), attempts);
}

#[test]
fn reachable_list_and_stop_query_awake_peers_without_waking_sleeping_ones() {
    let local = TestHome::new("scope-local");
    let awake = TestHome::new("scope-awake");
    let sleeping = TestHome::new("scope-sleeping");
    let unavailable = TestHome::new("scope-login");
    install_machine_ssh(
        &[
            ("laptop", &local),
            ("devbox", &awake),
            ("staging", &sleeping),
            ("gpu", &unavailable),
        ],
        &test_binaries().facade,
    );
    let local_id = name_machine(&local, "laptop");
    let awake_id = name_machine(&awake, "devbox");
    name_machine(&sleeping, "staging");
    name_machine(&unavailable, "gpu");
    for (destination, peer) in [
        ("devbox", &awake),
        ("staging", &sleeping),
        ("gpu", &unavailable),
    ] {
        add_saved(&local, destination, peer);
    }
    local.kill_home_processes();
    sleeping.kill_home_processes();
    unavailable.kill_home_processes();
    std::fs::write(unavailable.folder().join("ssh-needs-login"), []).unwrap();
    assert!(sleeping.hello_result().is_none() && unavailable.hello_result().is_none());
    let session = "3182c480-42a0-4aa0-b112-58e2c865031c";
    let worker = awake.start_fake_with(
        "Worker",
        &[("FAKECLI_SESSION", session), ("FAKECLI_STATUS", "1")],
    );
    assert!(wait_until(LOADED_TIMEOUT, || awake
        .inspect_agent(&worker.address)["agent"]["session"]
        == session));
    let local_session = "77bc3b1c-ba9c-41c3-9043-1a5c63e71b77";
    let pixel = local.start_fake_with("Pixel", &[("FAKECLI_SESSION", local_session)]);
    assert!(wait_until(LOADED_TIMEOUT, || local
        .inspect_agent(&pixel.address)["agent"]["session"]
        == local_session));

    let previous = ssh_serves(&sleeping);
    let named = local.run_facade(&["stop", "--machine", "staging"]);
    assert_eq!(named.status.code(), Some(0), "{}", stderr(&named));
    assert!(named.stdout.is_empty());
    assert_eq!(
        stderr(&named),
        "No running managed agents to stop on staging.\n"
    );
    assert_eq!(ssh_serves(&sleeping), format!("{previous}no-start\n"));
    assert!(sleeping.hello_result().is_none());
    assert!(alive(&worker.process) && alive(&pixel.process));

    let previous = ssh_serves(&sleeping);
    let listed = local.run_facade(&["list"]);
    assert_eq!(listed.status.code(), Some(0), "{}", stderr(&listed));
    let table = Table::parse(&stdout(&listed));
    assert_eq!(table.column("REF"), [&pixel.address, &worker.address]);
    let warning = stderr(&listed);
    assert!(
        warning.starts_with("warning: ") && warning.contains("gpu"),
        "{warning}"
    );
    assert!(
        warning.ends_with("Run 'facade machine list' to check machine status.\n"),
        "{warning}"
    );
    assert_eq!(ssh_serves(&sleeping), format!("{previous}no-start\n"));
    assert!(sleeping.hello_result().is_none());

    assert!(wait_until(LOADED_TIMEOUT, || awake
        .inspect_agent(&worker.address)["agent"]["state"]
        == "idle"));
    let remote_only = local.run_facade(&["list", "--machine", "devbox"]);
    assert_eq!(
        (remote_only.status.code(), stderr(&remote_only)),
        (Some(0), String::new())
    );
    let remote_only = Table::parse(&stdout(&remote_only));
    assert_eq!(remote_only.column("REF"), [worker.address.as_str()]);
    assert_eq!(remote_only.column("NAME"), ["Worker"]);
    assert_eq!(remote_only.column("STATE"), ["Idle"]);
    assert!(alive(&worker.process) && alive(&pixel.process));

    let previous = ssh_serves(&sleeping);
    let stopped = local.run_facade(&["stop", "--all"]);
    assert_eq!(stopped.status.code(), Some(1), "{}", stderr(&stopped));
    assert_eq!(
        stdout(&stopped),
        format!(
            "Stopped Pixel ({}).\nStopped Worker ({}).\n",
            pixel.address, worker.address
        )
    );
    assert_eq!(
        stderr(&stopped),
        "error: Could not connect to machine \"gpu\": SSH needs interaction.\nRun 'facade machine list' to check machine status.\n"
    );
    assert_eq!(ssh_serves(&sleeping), format!("{previous}no-start\n"));
    assert!(!alive(&worker.process) && !alive(&pixel.process));
    assert!(sleeping.hello_result().is_none() && unavailable.hello_result().is_none());

    let previous = ssh_serves(&sleeping);
    let named = local.run_facade(&["list", "--machine", "staging"]);
    assert_eq!(named.status.code(), Some(0), "{}", stderr(&named));
    assert!(named.stdout.is_empty());
    assert_eq!(
        stderr(&named),
        "No active agents on staging.\nStart one with 'facade start --machine staging codex', or run 'facade resume --machine staging' to find saved sessions.\n"
    );
    assert_eq!(ssh_serves(&sleeping), format!("{previous}wake\n"));
    assert!(sleeping.hello_result().is_some());

    let previous = ssh_serves(&awake);
    local.kill_home_processes();
    assert!(local.hello_result().is_none() && awake.hello_result().is_some());
    let reachable = local.run_facade(&["resume"]);
    assert_eq!(reachable.status.code(), Some(0), "{}", stderr(&reachable));
    let table = Table::parse(&stdout(&reachable));
    assert!(table.column("REF").contains(&worker.address.as_str()));
    assert_eq!(ssh_serves(&awake), format!("{previous}no-start\n"));

    let resumable = local.run_facade(&["resume", "--machine", "devbox"]);
    assert_eq!(resumable.status.code(), Some(0), "{}", stderr(&resumable));
    assert_eq!(
        stderr(&resumable),
        "Resume one with 'facade resume <REFERENCE>'.\n"
    );
    let table = Table::parse(&stdout(&resumable));
    assert_eq!(table.column("TYPE"), ["Managed"]);
    assert_eq!(table.column("REF"), [worker.address.as_str()]);
    // Query each eligible stopped run from the same caller, changing only the machine.
    let folder = real_path(&awake.project).unwrap();
    let mut client = connect(&local);
    for (selector, holder, machine_id, run, name, session) in [
        ("laptop", &local, &local_id, &pixel, "Pixel", local_session),
        ("devbox", &awake, &awake_id, &worker, "Worker", session),
    ] {
        let stopped = holder.inspect_agent(&run.address)["agent"].clone();
        let reference = &stopped["reference"];
        let expected_folder = real_path(&holder.project).unwrap();
        assert_eq!(stopped["process"], "ended", "{stopped}");
        assert_eq!(reference["machine_id"], *machine_id, "{stopped}");
        assert_eq!(stopped["session"], session, "{stopped}");
        assert_eq!(stopped["cwd"], json!(expected_folder), "{stopped}");
        let listed = client.call_ok(
            "agent.resume_list",
            json!({
                "scope": { "kind": "machine", "machine": selector },
                "folder": folder, "folder_scope": "all",
            }),
        );
        let [machine] = listed["machines"].as_array().unwrap().as_slice() else {
            panic!("expected only {selector} to answer: {listed}");
        };
        assert_eq!(machine["machine_id"], *machine_id, "{listed}");
        assert_eq!(machine["name"], selector, "{listed}");
        assert_eq!(machine["status"], "answered", "{listed}");
        let [item] = listed["items"].as_array().unwrap().as_slice() else {
            panic!("expected only {name} to be resumable on {selector}: {listed}");
        };
        assert_eq!(
            item["target"],
            json!({ "kind": "agent", "reference": reference }),
            "{listed}"
        );
        assert_eq!(item["agent"], *reference, "{listed}");
        assert_eq!(item["machine_id"], *machine_id, "{listed}");
        assert_eq!(item["cli"], "fake", "{listed}");
        assert_eq!(item["folder"], json!(expected_folder), "{listed}");
        assert_eq!(item["session"], session, "{listed}");
        assert_eq!(item["name"], name, "{listed}");
        assert_eq!(item["stopped"], true, "{listed}");
        println!("agent.resume_list selected {selector} {machine_id}: {item}");
    }

    let resumed = local.run_facade(&["resume", "-d", table.column("REF")[0]]);
    assert_eq!(resumed.status.code(), Some(0), "{}", stderr(&resumed));
    assert!(resumed.stderr.is_empty(), "{}", stderr(&resumed));
    assert_eq!(
        stdout(&resumed),
        format!("Resumed Worker ({}) in the background.\n", worker.address)
    );
    assert_ne!(
        awake.started_agent(&stdout(&resumed)).process,
        worker.process
    );
}

#[test]
fn a_foreground_connection_keeps_both_daemons_awake_until_it_closes() {
    let local = TestHome::new("foreground-laptop");
    let remote = TestHome::new("foreground-devbox");
    install_machine_ssh(
        &[("laptop", &local), ("devbox", &remote)],
        &test_binaries().facade,
    );
    let local_id = name_machine(&local, "laptop");
    let remote_id = name_machine(&remote, "devbox");
    let link = MachineLink::open(&local, "devbox", &remote);
    wait_for_route(&local, &remote_id, &[&remote_id]);
    wait_for_route(&remote, &local_id, &[&local_id]);
    let local_daemon = local.daemon_pid().expect("local daemon");
    let remote_daemon = remote.daemon_pid().expect("remote daemon");
    let attempts = ssh_attempts(&remote);

    std::thread::sleep(secs(32));

    assert_eq!(
        local.daemon_pid(),
        Some(local_daemon),
        "{}",
        local.daemon_log()
    );
    assert_eq!(
        remote.daemon_pid(),
        Some(remote_daemon),
        "{}",
        remote.daemon_log()
    );
    assert_eq!(ssh_attempts(&remote), attempts);
    let reverse = remote.run_facade_ok(&["machine", "list"]);
    let table = Table::parse(&reverse);
    let row = table
        .row("NAME", "laptop")
        .expect("the foreground peer on the receiving side");
    assert_eq!(table.cell(row, "STATE"), "Online");
    drop(link);

    local.wait_for_idle_exit();
    remote.wait_for_idle_exit();
    assert_eq!(ssh_attempts(&remote), attempts);
}

#[test]
fn a_saved_watch_keeps_ssh_open_until_detach_and_idle_dials_nothing() {
    let local = TestHome::new("watch-laptop");
    let remote = TestHome::new("watch-devbox");
    install_machine_ssh(
        &[("laptop", &local), ("devbox", &remote)],
        &test_binaries().facade,
    );
    name_machine(&local, "laptop");
    let remote_id = name_machine(&remote, "devbox");
    local.start_fake("Local");
    let worker = remote.start_fake("Remote");
    add_saved(&local, "devbox", &remote);
    let mut viewer = TestTerminal::spawn(
        local
            .command(&test_binaries().facade)
            .args(["attach", &worker.address]),
        100,
        30,
    );
    assert!(viewer.wait_for(LOADED_TIMEOUT, |screen| screen.contains("❯")));
    let attempts = ssh_attempts(&remote);
    std::thread::sleep(secs(32));
    remote.run_facade_ok(&["type", &worker.address, "still attached"]);
    assert!(
        viewer.wait_for(LOADED_TIMEOUT, |screen| screen.contains("still attached")),
        "{}",
        viewer.text()
    );
    assert_eq!(ssh_attempts(&remote), attempts);

    viewer.send(b"\x1d");
    assert!(
        viewer
            .wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            machine_json(&local, &remote_id).is_some_and(|machine| machine.get("route").is_none())
        }),
        "the idle saved transport stayed alive: {}",
        local.daemon_log()
    );
    let roster = Table::parse(&local.run_facade_ok(&["machine", "list"]));
    let row = roster
        .row("NAME", "devbox")
        .expect("the saved direct route");
    assert_eq!(roster.cell(row, "STATE"), "Disconnected");
    std::thread::sleep(secs(12));
    assert_eq!(
        ssh_attempts(&remote),
        attempts,
        "the daemon did not dial a disconnected route again"
    );
    assert!(alive(&worker.process));
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

/// Relays the real handoff between two daemons and records each side of the machine protocol.
struct ObservedMachineLink {
    front_socket: facade_base::paths::ClientSocket,
    peer_socket: facade_base::paths::ClientSocket,
    pumps: Option<[std::thread::JoinHandle<()>; 2]>,
    from_front: std::sync::mpsc::Receiver<Value>,
    from_peer: std::sync::mpsc::Receiver<Value>,
}

const LIVE_ADVERTISE_PROBE: u64 = 10_000;

struct AdvertiseProbe {
    allow_live_tables: AtomicBool,
    destination: String,
}

fn advertises_route(frame: &Value, destination: &str) -> bool {
    frame["method"] == "advertise"
        && frame["params"]["machines"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["machine_id"] == destination && row["route"] == json!([destination]))
        })
}

impl ObservedMachineLink {
    fn open(front: &TestHome, peer: &TestHome) -> Self {
        Self::with_advertise_probe(front, peer, None)
    }

    fn with_advertise_probe(
        front: &TestHome,
        peer: &TestHome,
        probe: Option<Arc<AdvertiseProbe>>,
    ) -> Self {
        let mut outgoing = ManualReadClient::open(front);
        outgoing.send(
            1,
            "call",
            json!({ "op": "machine.connect", "args": {
            "kind": "temporary", "transport": { "kind": "bridge" }
        } }),
        );
        let authorization = outgoing
            .read_frame()
            .unwrap()
            .expect("authorize the handoff");
        assert_eq!(authorization["id"], 1, "{authorization}");
        assert_eq!(
            authorization["result"]["transport"]["kind"], "bridge",
            "{authorization}"
        );
        let incoming = ManualReadClient::before_hello(peer);
        let front_socket = outgoing.writer.try_clone().unwrap();
        let peer_socket = incoming.writer.try_clone().unwrap();
        let relay = |mut source: ManualReadClient,
                     mut target: facade_base::paths::ClientSocket,
                     front: bool| {
            let (observed, frames) = std::sync::mpsc::channel();
            let probe = probe.clone();
            let pump = std::thread::spawn(move || {
                let mut probed = false;
                while let Ok(Some(frame)) = source.read_frame() {
                    // The foreground Shell consumes this local handoff result before forwarding.
                    let endpoint_notice = front
                        && matches!(
                            frame["method"].as_str(),
                            Some("connected" | "connect_failed")
                        );
                    let _ = observed.send(frame.clone());
                    let live_table = frame["method"] == "advertise" && frame.get("id").is_none();
                    let control_reply = probe.is_some()
                        && front
                        && frame["id"] == LIVE_ADVERTISE_PROBE
                        && frame.get("method").is_none();
                    let held_table = !front
                        && live_table
                        && probe
                            .as_ref()
                            .is_some_and(|probe| !probe.allow_live_tables.load(Ordering::SeqCst));
                    if endpoint_notice || control_reply || held_table {
                        continue;
                    }
                    if writeln!(target, "{frame}").is_err() {
                        break;
                    }
                    if !front
                        && live_table
                        && !probed
                        && probe
                            .as_ref()
                            .is_some_and(|probe| advertises_route(&frame, &probe.destination))
                    {
                        // An ID-bearing copy immediately after the live notification is an ordered
                        // barrier. Its error is observed here and never sent to the other Daemon.
                        let mut control = frame;
                        control["id"] = json!(LIVE_ADVERTISE_PROBE);
                        if writeln!(target, "{control}").is_err() {
                            break;
                        }
                        probed = true;
                    }
                }
            });
            (pump, frames)
        };
        let (forward, from_front) = relay(outgoing, peer_socket.try_clone().unwrap(), true);
        let (returning, from_peer) = relay(incoming, front_socket.try_clone().unwrap(), false);
        Self {
            front_socket,
            peer_socket,
            pumps: Some([forward, returning]),
            from_front,
            from_peer,
        }
    }
}

impl Drop for ObservedMachineLink {
    fn drop(&mut self) {
        let _ = self.front_socket.shutdown(std::net::Shutdown::Both);
        let _ = self.peer_socket.shutdown(std::net::Shutdown::Both);
        for pump in self.pumps.take().unwrap() {
            let _ = pump.join();
        }
    }
}

fn observed_frame(
    frames: &std::sync::mpsc::Receiver<Value>,
    expected: &str,
    mut matches: impl FnMut(&Value) -> bool,
) -> Value {
    let deadline = std::time::Instant::now() + LOADED_TIMEOUT;
    loop {
        let frame = frames
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .unwrap_or_else(|error| panic!("expected {expected}: {error}"));
        if matches(&frame) {
            return frame;
        }
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

/// Initial tables are acknowledged after machine hello. Later announcements are id-less.
#[test]
fn initial_and_live_machine_advertisements_route_exact_calls() {
    let origin = TestHome::new("advertise-origin");
    let middle = TestHome::new("advertise-middle");
    let first = TestHome::new("advertise-first");
    let later = TestHome::new("advertise-later");
    install_machine_ssh(
        &[("middle", &middle), ("first", &first), ("later", &later)],
        &test_binaries().facade,
    );
    let origin_id = name_machine(&origin, "origin");
    let middle_id = name_machine(&middle, "middle");
    let first_id = name_machine(&first, "first");
    let later_id = name_machine(&later, "later");
    let initial_run = first.start_fake("worker");
    let later_run = later.start_fake("worker");
    assert_eq!(initial_run.id, later_run.id);
    let _first_link = MachineLink::open(&middle, "first", &first);
    wait_for_route(&middle, &first_id, &[&first_id]);
    assert!(machine_json(&origin, &first_id).is_none());
    assert!(machine_json(&origin, &later_id).is_none());

    let probe = Arc::new(AdvertiseProbe {
        allow_live_tables: AtomicBool::new(false),
        destination: later_id.clone(),
    });
    let bridge = ObservedMachineLink::with_advertise_probe(&origin, &middle, Some(probe.clone()));
    let welcomed = observed_frame(&bridge.from_peer, "authenticated machine hello", |frame| {
        frame["id"] == 0 && frame["result"]["machine_id"] == middle_id
    });
    assert_eq!(welcomed["result"]["api_version"], 1, "{welcomed}");
    let announced = observed_frame(&bridge.from_peer, "ID-bearing initial table", |frame| {
        frame["id"].is_u64() && advertises_route(frame, &first_id)
    });
    let table_id = announced["id"].as_u64().unwrap();
    let receipt = observed_frame(
        &bridge.from_front,
        "correlated initial table success",
        |frame| frame["id"] == table_id && frame.get("method").is_none(),
    );
    assert_eq!(
        receipt,
        json!({"jsonrpc": "2.0", "id": table_id, "result": {}})
    );

    let mut caller = connect(&origin);
    let verify_call = |caller: &mut DaemonTestClient, target: &str, worker: &TestAgent| {
        wait_for_route(&origin, target, &[&middle_id, target]);
        let reference = json!({ "machine_id": target, "agent_id": worker.id });
        let id = caller.send(
            "call",
            json!({ "op": "agent.inspect", "args": { "target": reference } }),
        );
        let forwarded = observed_frame(&bridge.from_front, "the exact routed call", |frame| {
            frame["method"] == "forward" && frame["params"]["params"]["op"] == "agent.inspect"
        });
        assert_eq!(
            forwarded["params"]["route"],
            json!([middle_id, target]),
            "{forwarded}"
        );
        assert_eq!(
            forwarded["params"]["caller"]["machine_id"], origin_id,
            "{forwarded}"
        );
        assert_eq!(
            forwarded["params"]["params"]["args"]["target"], reference,
            "{forwarded}"
        );
        let peer_id = forwarded["id"]
            .as_u64()
            .expect("the forwarded call has an ID");
        let peer = observed_frame(&bridge.from_peer, "the peer's correlated result", |frame| {
            frame["id"] == peer_id && frame.get("method").is_none()
        });
        let answer = caller
            .wait_for_response(id, LOADED_TIMEOUT)
            .expect("the caller receives its answer");
        assert_eq!(answer["id"], id, "{answer}");
        assert_eq!(peer["result"]["agent"]["reference"], reference, "{peer}");
        assert_eq!(
            answer["result"]["agent"]["reference"], reference,
            "{answer}"
        );
        assert_eq!(answer["result"]["agent"]["pid"], worker.pid, "{answer}");
        assert_eq!(process_identity(worker.pid), worker.process);
    };
    // The bridge discards id-less peer tables here, so the initial table owns this route.
    verify_call(&mut caller, &first_id, &initial_run);
    assert!(machine_json(&origin, &later_id).is_none());

    probe.allow_live_tables.store(true, Ordering::SeqCst);
    let _later_link = MachineLink::open(&middle, "later", &later);
    let notification = observed_frame(&bridge.from_peer, "id-less route announcement", |frame| {
        frame.get("id").is_none() && advertises_route(frame, &later_id)
    });
    assert_eq!(notification["jsonrpc"], "2.0", "{notification}");
    wait_for_route(&origin, &later_id, &[&middle_id, &later_id]);
    let rejected = observed_frame(
        &bridge.from_front,
        "the post-announcement barrier",
        |frame| {
            if frame["id"] == LIVE_ADVERTISE_PROBE && frame.get("method").is_none() {
                return true;
            }
            assert!(
                frame.get("result").is_none() && frame.get("error").is_none(),
                "the id-less table received an unexpected response: {frame}"
            );
            false
        },
    );
    assert_eq!(
        rejected,
        json!({ "jsonrpc": "2.0", "id": LIVE_ADVERTISE_PROBE,
                "error": {"code": -32601, "message": "Unexpected machine request.",
                          "data": {"reason": "invalid_argument"}} }),
    );
    verify_call(&mut caller, &later_id, &later_run);
    println!(
        "initial table {table_id} routed {first_id}; live notification routed {later_id}; only the barrier got a reply"
    );
}

/// Location and CLI queries use the target machine. The remote start creates the worktree from
/// that repository's current HEAD, and both Attach clients reach the same terminal.
#[test]
fn a_remote_start_opens_a_worktree_at_the_remote_head() {
    let local = TestHome::new("worktree-local");
    let remote = TestHome::new("worktree-remote");
    check_remote_worktree(&local, &remote, &test_binaries().fakecli, |_, _, _| {});
}

fn worktree_git(home: &TestHome, folder: &Path, args: &[&str]) -> String {
    let output = home
        .command("git")
        .current_dir(folder)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {}", stderr(&output));
    stdout(&output).trim_end_matches(['\r', '\n']).to_string()
}

// Keep the two real Shell Attach views alive for the optional editor observation.
fn check_remote_worktree(
    local: &TestHome,
    remote: &TestHome,
    worker: &Path,
    observe: impl FnOnce(&str, &Value, [&TestTerminal; 2]),
) {
    let programs = test_binaries();
    let settings = |home: &TestHome, clis: Value| {
        std::fs::write(
            home.path.join("facade.json"),
            json!({ "yolo": true, "clis": clis }).to_string(),
        )
        .unwrap();
    };
    settings(
        local,
        json!({ "laptop-only": { "type": "fake", "command": programs.fakecli } }),
    );
    settings(
        remote,
        json!({
            "devbox-only": {
                "type": "fake", "command": worker,
                "env": { "FAKECLI_STARTS": remote.folder().join("worker-pids") },
            },
            "devbox-missing": { "type": "fake", "command": remote.folder().join("missing-cli") },
        }),
    );
    install_machine_ssh(
        &[("qa-laptop", local), ("devbox", remote)],
        &programs.facade,
    );
    let local_id = name_machine(local, "qa-laptop");
    let remote_id = name_machine(remote, "devbox");

    let git = |folder, args: &[&str]| worktree_git(remote, folder, args);
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
    let attempts = ssh_attempts(remote);
    assert!(!attempts.is_empty(), "add did not try SSH");
    assert!(
        attempts
            .lines()
            .all(|attempt| attempt.starts_with("batch 2222 ")),
        "add should reuse the existing noninteractive login: {attempts}"
    );
    let status = connect(local).call_ok(
        "daemon.status",
        json!({ "scope": { "kind": "machine", "machine": "devbox" } }),
    );
    assert_eq!(
        real_path(Path::new(status["home"].as_str().unwrap())).unwrap(),
        real_path(&remote.path).unwrap(),
        "the first call immediately reaches the saved machine"
    );
    assert_eq!(
        ssh_attempts(remote),
        attempts,
        "the first operation reuses the saved machine session"
    );
    let machine = machine_json(local, &remote_id).expect("the saved devbox");
    assert_eq!(machine["state"], "online", "{machine}");
    assert_eq!(machine["route"], json!([remote_id]), "{machine}");
    let connection = saved_ssh(
        &machine_json(local, &local_id).unwrap(),
        &local_id,
        &remote_id,
    );
    assert_eq!(connection["state"], "connected");
    assert_eq!(
        connection["transport"]["ssh_args"],
        json!(["-p", "2222", "devbox"])
    );
    assert_eq!(connection["transport"]["remote_home"], remote_home);

    let env = local
        .isolating_env()
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut wire = connect(local);
    let local_clis = wire.call_ok("cli.list", json!({ "folder": local.project, "env": env }));
    assert!(
        local_clis["clis"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cli| cli["cli"] == "laptop-only" && cli["available"] == true),
        "{local_clis}"
    );
    let locations = wire.call_ok(
        "location.list",
        json!({ "scope": { "kind": "machine", "machine": "devbox" }, "folders": [folder] }),
    );
    assert!(
        locations["locations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|location| location["path"] == json!(folder) && location["kind"] == "main"),
        "{locations}"
    );
    let available = wire.call_ok(
        "cli.list",
        json!({ "scope": { "kind": "machine", "machine": "devbox" }, "folder": folder, "env": env }),
    );
    let remote_clis = available["clis"].as_array().expect("the remote CLI list");
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
    let mut relay = McpTestClient::open_configured(local, &observer.id);
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
    assert_eq!(agent["reference"]["machine_id"], remote_id);
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
    observe(&local_id, agent, [&first, &second]);
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

    assert_eq!(
        local.run_facade_ok(&["stop", address]),
        format!("Stopped worker ({address}).\n")
    );
    remote.wait_for_idle_exit();
    local.run_facade_ok(&["list"]);
    let sleeping = wait_for_machine_state(local, &remote_id, "sleeping");
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
    let roster = local.agent_list();
    let peer = machine_in(&roster, &remote_id).expect("the saved machine remains listed");
    assert_eq!(peer["state"], "sleeping", "{roster}");
    assert_eq!(peer["status"], "unavailable", "{roster}");
    assert!(
        remote.hello_result().is_none(),
        "a bare roster leaves the peer asleep"
    );

    let status = connect(local).call_ok(
        "daemon.status",
        json!({ "scope": { "kind": "machine", "machine": "devbox" } }),
    );
    assert_eq!(
        real_path(Path::new(status["home"].as_str().unwrap())).unwrap(),
        real_path(&remote.path).unwrap(),
        "naming the saved machine wakes its daemon"
    );
    assert_eq!(remote.hello_result().unwrap()["machine_id"], remote_id);
    wait_for_route(local, &remote_id, &[&remote_id]);
}

/// The same routed worktree and live worker are visible to Shell and to the actual Extension.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
#[ignore = "requires the isolated VS Code bridge and Xvfb display from the editor test runner"]
fn a_remote_worktree_is_shared_by_the_shell_and_editor() {
    let fixture_file = |name: &str| {
        let path = std::path::PathBuf::from(
            std::env::var_os(name)
                .unwrap_or_else(|| panic!("set {name} to the absolute fixture path")),
        );
        assert!(
            path.is_absolute() && path.is_file(),
            "{name} must name an absolute fixture file: {path:?}"
        );
        path
    };
    let node = fixture_file("FACADE_TEST_REMOTE_WORKTREE_NODE");
    let bridge = fixture_file("FACADE_TEST_REMOTE_WORKTREE_BRIDGE");
    let vscode = fixture_file("VSCODE_EXECUTABLE");
    let display =
        std::env::var_os("DISPLAY").expect("run this fixture on the editor runner's Xvfb display");
    let local = TestHome::new("worktree-local");
    let remote = TestHome::new("worktree-remote");
    let git = |args: &[&str]| worktree_git(&local, &local.project, args);
    let tracked = local.project.join("keep.txt");
    let untracked = local.project.join("untracked.txt");
    git(&["init", "-q", "-b", "local-trunk"]);
    std::fs::write(&tracked, b"committed locally\n").unwrap();
    git(&["add", "keep.txt"]);
    git(&[
        "-c",
        "user.name=Facade QA",
        "-c",
        "user.email=qa@example.invalid",
        "commit",
        "-qm",
        "local HEAD",
    ]);
    std::fs::write(&tracked, b"staged local change\n").unwrap();
    git(&["add", "keep.txt"]);
    std::fs::write(&tracked, b"unstaged local change\n").unwrap();
    std::fs::write(&untracked, b"untracked local file\n").unwrap();
    let git_snapshot = || {
        let state: [&[&str]; 6] = [
            &["rev-parse", "HEAD"],
            &["symbolic-ref", "HEAD"],
            &["show-ref"],
            &["status", "--porcelain=v1", "--untracked-files=all"],
            &["ls-files", "--stage"],
            &["worktree", "list", "--porcelain"],
        ];
        (
            state.map(|args| (args, git(args))),
            [&tracked, &untracked].map(|file| std::fs::read(file).unwrap()),
        )
    };
    let local_before = git_snapshot();

    let editor_runtime = local.folder().join("editor-runtime");
    facade_base::files::create_private_folder_all(&editor_runtime).unwrap();
    // Keep the running executable's identity stable if Cargo relinks another test's binaries.
    let worker = remote.folder().join("facade-fakecli");
    std::fs::copy(&test_binaries().fakecli, &worker).unwrap();
    check_remote_worktree(&local, &remote, &worker, |origin, agent, shells| {
        let address = agent["address"].as_str().expect("the remote address");
        let pid = agent["pid"].as_u64().expect("the remote PID");
        let cwd = Path::new(agent["cwd"].as_str().expect("the remote cwd"));
        assert_eq!(agent["process"], "running");
        let expected = json!({ "reference": agent["reference"], "pid": pid, "cwd": cwd });
        let proc = Path::new("/proc").join(pid.to_string());
        let check_process = || {
            for home in [&local, &remote] {
                let observed = home.inspect_agent(address);
                for field in ["reference", "pid", "cwd", "process"] {
                    assert_eq!(observed["agent"][field], agent[field], "{address}: {field}");
                }
            }
            assert_eq!(std::fs::read_link(proc.join("cwd")).unwrap(), cwd);
            assert_eq!(
                std::fs::read_link(proc.join("exe")).unwrap(),
                real_path(&worker).unwrap(),
            );
        };
        check_process();

        let marker = "Editor typed into the remote worktree";
        let mut command = local.command(&node);
        command
            .env("VSCODE_EXECUTABLE", &vscode)
            .env("DISPLAY", &display)
            .env("XDG_RUNTIME_DIR", &editor_runtime)
            .env("XDG_DATA_HOME", local.folder().join("editor-data"))
            .env("XDG_CACHE_HOME", local.folder().join("editor-cache"))
            .env("XDG_STATE_HOME", local.folder().join("editor-state"))
            .arg(&bridge)
            .arg(&local.project)
            .arg(&local.path)
            .arg(origin)
            .arg(address)
            .arg(expected.to_string())
            .arg(marker)
            .stdin(Stdio::null());
        if let Some(authority) = std::env::var_os("XAUTHORITY") {
            command.env("XAUTHORITY", authority);
        }
        let output = command.output().expect("launch the isolated editor bridge");
        assert!(
            output.status.success(),
            "{}\n{}",
            stdout(&output),
            stderr(&output)
        );
        println!("remote editor evidence {}", stdout(&output).trim());
        for shell in shells {
            assert!(
                shell.wait_for(LOADED_TIMEOUT, |screen| screen.contains(marker)),
                "{}",
                shell.text()
            );
        }
        assert!(remote.screen(address).contains(marker));
        check_process();
        assert_eq!(
            std::fs::read_to_string(remote.folder().join("worker-pids"))
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            [pid.to_string()],
            "the remote fake CLI launched once at the original PID",
        );
    });
    assert_eq!(
        git_snapshot(),
        local_before,
        "the local Git state and file bytes stayed unchanged"
    );
    assert!(!local.project.with_extension("worktrees").exists());
    println!(
        "both Shell views read the editor input; one original worker PID; local Git snapshot unchanged"
    );
}

fn ssh_attempts(home: &TestHome) -> String {
    std::fs::read_to_string(home.folder().join("ssh-attempts")).unwrap_or_default()
}

fn ssh_serves(home: &TestHome) -> String {
    std::fs::read_to_string(home.folder().join("ssh-serves")).unwrap_or_default()
}

fn run_using(home: &TestHome, program: &Path, args: &[&str]) -> std::process::Output {
    home.command(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("could not run Facade")
}

fn run_using_ok(home: &TestHome, program: &Path, args: &[&str]) -> String {
    let output = run_using(home, program, args);
    assert!(
        output.status.success(),
        "{} {args:?}: {}",
        program.display(),
        stderr(&output)
    );
    stdout(&output)
}

/// Replay against the independently published package on the same platform. The full gate
/// exercises the compatibility wire paths without requiring release archives in CI.
#[test]
#[ignore = "requires the independently published 0.1.6 package in FACADE_TEST_PUBLISHED_016"]
fn published_016_and_current_cold_dial_each_other() {
    let package = std::path::PathBuf::from(std::env::var_os("FACADE_TEST_PUBLISHED_016").unwrap());
    assert!(package.is_absolute(), "provide an absolute package path");
    let published = package.join(program_name("facade"));
    let programs = test_binaries();
    assert!(published.is_file() && published != programs.facade);

    for (caller, holder) in [
        (programs.facade.as_path(), published.as_path()),
        (published.as_path(), programs.facade.as_path()),
    ] {
        let source = TestHome::new("cold-caller");
        let remote = TestHome::new("cold-holder");
        install_machine_ssh_with_programs(&[
            ("caller", &source, caller),
            ("holder", &remote, holder),
        ]);
        assert_eq!(
            run_using_ok(&source, &published, &["--version"]),
            "facade 0.1.6\n"
        );
        for (program, home, name) in [(caller, &source, "caller"), (holder, &remote, "holder")] {
            run_using_ok(home, program, &["machine", "list"]);
            let hello = home.hello_result().expect("the daemon is listening");
            let id = hello["machine_id"].as_str().unwrap();
            run_using_ok(home, program, &["machine", "rename", id, name]);
        }
        // The published release has no debug CLI entry. Both builds run the same test program.
        remote.add_custom_cli("qa-fake", &programs.fakecli);
        let started = run_using_ok(
            &remote,
            holder,
            &["start", "-d", "-n", "PeerWorker", "qa-fake"],
        );
        let address = started_ref(&started);
        let kept = remote.started_agent(&started);
        assert!(address.ends_with("@holder"), "{started}");
        assert!(wait_for_screen_text(&remote, address, "❯"));

        if holder == published.as_path() {
            for args in [
                ["list", "--local"],
                ["resume", "--local"],
                ["stop", "--all"],
            ] {
                let output = run_using(&remote, caller, &args);
                assert_eq!(
                    output.status.code(),
                    Some(1),
                    "{args:?}: {}",
                    stderr(&output)
                );
                assert!(output.stdout.is_empty());
                assert!(
                    stderr(&output).contains("facade upgrade"),
                    "{args:?}: {}",
                    stderr(&output)
                );
            }
            assert!(
                alive(&kept.process),
                "an unsupported scope left the old agent running"
            );
        }

        let home = remote.path.to_str().unwrap();
        let added = run_using_ok(
            &source,
            caller,
            &["machine", "add", "--home", home, "holder"],
        );
        assert!(added.contains("Saved the connection to holder."), "{added}");
        source.wait_for_idle_exit();
        let before = ssh_attempts(&remote);
        assert!(!before.is_empty());
        assert!(source.hello_result().is_none());
        assert!(alive(&kept.process));

        let output = run_using_ok(&source, caller, &["list", "--machine", "holder"]);
        let table = Table::parse(&output);
        assert_eq!(table.column("REF"), [address], "{output}");
        assert_eq!(table.column("NAME"), ["PeerWorker"], "{output}");
        assert!(
            ssh_attempts(&remote).len() > before.len(),
            "cold lookup did not dial SSH"
        );
        let receipt = run_using_ok(&source, caller, &["type", address, "mixed-build hello"]);
        assert_eq!(
            receipt,
            format!("Typed into PeerWorker ({address})'s terminal.\n")
        );
        assert!(wait_for_screen_text(&remote, address, "mixed-build hello"));
        assert!(alive(&kept.process));
    }
}

#[cfg(unix)]
mod authorization {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    struct Keys {
        authorized: PathBuf,
        initial: String,
        host_key: String,
        known_hosts: PathBuf,
        initial_trust: String,
    }

    fn generate(home: &TestHome, path: &Path) -> String {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let result = home
            .command("/usr/bin/ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(path)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(result.status.success(), "{}", stderr(&result));
        fs::read_to_string(path.with_extension("pub")).unwrap()
    }

    fn keys(home: &TestHome) -> Keys {
        let initial = generate(home, &home.folder().join("existing-login-key"));
        let host_key = generate(
            home,
            &home.folder().join("ssh-host-keys/ssh_host_ed25519_key"),
        );
        let ssh = home.user_home().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        let authorized = ssh.join("authorized_keys");
        fs::write(&authorized, &initial).unwrap();
        fs::set_permissions(&authorized, fs::Permissions::from_mode(0o600)).unwrap();
        let known_hosts = ssh.join("known_hosts");
        let initial_trust = format!("qa-other.invalid {host_key}");
        fs::write(&known_hosts, &initial_trust).unwrap();
        fs::set_permissions(&known_hosts, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(home.folder().join("ssh-password-only"), []).unwrap();
        Keys {
            authorized,
            initial,
            host_key,
            known_hosts,
            initial_trust,
        }
    }

    fn authorize_arguments<'a>(home: &'a TestHome, destination: &'a str) -> [&'a str; 6] {
        [
            "machine",
            "add",
            "--bidirectional",
            "--home",
            home.path.to_str().unwrap(),
            destination,
        ]
    }

    fn add_pair(local: &TestHome, remote: &TestHome) -> std::process::Output {
        local
            .command(&test_binaries().facade)
            .env(
                "FACADE_TEST_SSH_HOST_KEYS",
                local.folder().join("ssh-host-keys"),
            )
            .args(authorize_arguments(remote, "devbox"))
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    fn kept_key(home: &TestHome, by: &Keys, name: &str, id: &str) {
        let private = home.path.join("core/ssh/id_ed25519");
        assert_eq!(
            fs::metadata(&private).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let key = fs::read_to_string(private.with_extension("pub")).unwrap();
        let key = key.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
        let text = fs::read_to_string(&by.authorized).unwrap();
        assert!(
            text.starts_with(&by.initial),
            "the previous authorization remains"
        );
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with(&key)
                    && line.ends_with(&format!("# facade:{name}:{id}")))
                .count(),
            1,
            "{text}"
        );
    }

    fn pair(local: &TestHome, remote: &TestHome) -> (String, String, Keys, Keys) {
        let local_keys = keys(local);
        let remote_keys = keys(remote);
        install_machine_ssh(
            &[("laptop", local), ("devbox", remote)],
            &test_binaries().facade,
        );
        let local_id = name_machine(local, "laptop");
        let remote_id = name_machine(remote, "devbox");
        (local_id, remote_id, local_keys, remote_keys)
    }

    #[test]
    fn bidirectional_add_proves_each_key_then_removes_only_the_paired_authorizations() {
        let local = TestHome::new("key-laptop");
        let remote = TestHome::new("key-devbox");
        let (local_id, remote_id, local_keys, remote_keys) = pair(&local, &remote);
        let result = add_pair(&local, &remote);
        assert_eq!(
            result.status.code(),
            Some(0),
            "{}\n{}",
            stdout(&result),
            stderr(&result)
        );
        let receipts = stdout(&result);
        let lines: Vec<_> = receipts.lines().collect();
        assert_eq!(lines.len(), 4, "{receipts}");
        assert!(
            lines[0].starts_with("Installed Facade SSH key on devbox (allows "),
            "{receipts}"
        );
        assert!(
            lines[1].starts_with("Installed devbox's Facade SSH key on laptop (allows "),
            "{receipts}"
        );
        assert!(
            lines[2].starts_with("Saved forward connection to devbox ("),
            "{receipts}"
        );
        assert!(
            lines[3].starts_with("Saved return connection from devbox to laptop (")
                && lines[3].ends_with("@192.0.2.1)."),
            "{receipts}"
        );
        kept_key(&local, &remote_keys, "laptop", &local_id);
        kept_key(&remote, &local_keys, "devbox", &remote_id);
        let trust = fs::read_to_string(&remote_keys.known_hosts).unwrap();
        let new_trust = trust.strip_prefix(&remote_keys.initial_trust).unwrap();
        assert_eq!(new_trust.lines().count(), 1, "{trust}");
        let mut fields = new_trust.split_whitespace();
        assert_eq!(fields.next(), Some("192.0.2.1"));
        assert_eq!(
            fields.take(2).collect::<Vec<_>>(),
            local_keys
                .host_key
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>(),
        );
        assert!(
            ssh_attempts(&remote)
                .lines()
                .any(|attempt| attempt.starts_with("interactive "))
        );
        assert!(ssh_serves(&remote).lines().any(|entry| entry == "admin"));

        for (source, destination, name) in
            [(&local, &remote, "devbox"), (&remote, &local, "laptop")]
        {
            source.kill_home_processes();
            destination.kill_home_processes();
            let attempts = ssh_attempts(destination);
            let listed = source.run_facade(&["list", "--machine", name]);
            assert_eq!(listed.status.code(), Some(0), "{}", stderr(&listed));
            assert!(stderr(&listed).starts_with(&format!("No active agents on {name}.\n")));
            assert!(
                ssh_attempts(destination).len() > attempts.len(),
                "the saved route is cold"
            );
        }

        let removed = local.run_facade(&["machine", "remove", "--bidirectional", "devbox"]);
        assert_eq!(
            removed.status.code(),
            Some(0),
            "{}\n{}",
            stdout(&removed),
            stderr(&removed)
        );
        assert_eq!(
            stdout(&removed),
            "Removed the saved connection to devbox.\nRemoved the saved return connection from devbox to laptop.\n"
        );
        assert!(removed.stderr.is_empty(), "{}", stderr(&removed));
        assert_eq!(
            fs::read_to_string(local_keys.authorized).unwrap(),
            local_keys.initial
        );
        assert_eq!(
            fs::read_to_string(remote_keys.authorized).unwrap(),
            remote_keys.initial
        );
    }

    #[test]
    fn failed_return_proof_rolls_back_just_the_return_and_leaves_the_forward_saved() {
        let local = TestHome::new("return-fails-laptop");
        let remote = TestHome::new("return-fails-devbox");
        let (local_id, remote_id, local_keys, remote_keys) = pair(&local, &remote);
        fs::write(local.folder().join("ssh-proof-other-key"), []).unwrap();
        let result = add_pair(&local, &remote);
        assert_eq!(
            result.status.code(),
            Some(1),
            "{}\n{}",
            stdout(&result),
            stderr(&result)
        );
        assert!(stdout(&result).contains("Saved forward connection to devbox ("));
        assert!(
            stderr(&result).contains("Could not connect from devbox back to "),
            "{}",
            stderr(&result)
        );
        kept_key(&local, &remote_keys, "laptop", &local_id);
        assert_eq!(
            fs::read_to_string(&local_keys.authorized).unwrap(),
            local_keys.initial
        );
        let trust = fs::read_to_string(&remote_keys.known_hosts).unwrap();
        assert!(
            trust
                .strip_prefix(&remote_keys.initial_trust)
                .is_some_and(|remaining| remaining.trim().is_empty()),
            "return rollback must preserve the native trust file: {trust}",
        );
        let machine = machine_json(&local, &local_id).unwrap();
        assert_eq!(saved_ssh(&machine, &local_id, &remote_id)["kind"], "saved");

        let attempts = ssh_attempts(&remote);
        let result = local.run_facade(&["machine", "remove", "devbox"]);
        assert_eq!(result.status.code(), Some(0), "{}", stderr(&result));
        assert_eq!(stdout(&result), "Removed the saved connection to devbox.\n");
        assert_eq!(ssh_attempts(&remote), attempts, "default removal is local");
        kept_key(&local, &remote_keys, "laptop", &local_id);
    }

    #[test]
    fn reciprocal_remove_revokes_the_peer_key_when_the_return_route_is_already_absent() {
        let local = TestHome::new("no-return-laptop");
        let remote = TestHome::new("no-return-devbox");
        let (local_id, _, local_keys, remote_keys) = pair(&local, &remote);
        let added = add_pair(&local, &remote);
        assert_eq!(added.status.code(), Some(0), "{}", stderr(&added));

        // Remove the saved route at the daemon boundary, leaving its SSH grants intact.
        connect(&remote).call_ok(
            "machine.remove",
            json!({ "machine": local_id, "expected_machine_id": local_id }),
        );
        kept_key(&local, &remote_keys, "laptop", &local_id);

        let removed = local.run_facade(&["machine", "remove", "--bidirectional", "devbox"]);
        assert_eq!(removed.status.code(), Some(0), "{}", stderr(&removed));
        assert_eq!(
            stdout(&removed),
            "Removed the saved connection to devbox.\nNo saved return connection from devbox to laptop.\n"
        );
        assert!(removed.stderr.is_empty(), "{}", stderr(&removed));
        assert_eq!(
            fs::read_to_string(local_keys.authorized).unwrap(),
            local_keys.initial
        );
        assert_eq!(
            fs::read_to_string(remote_keys.authorized).unwrap(),
            remote_keys.initial
        );
    }

    #[test]
    fn bidirectional_remove_confirms_peer_identity_before_revoking_remote_authorization() {
        let local = TestHome::new("remove-laptop");
        let remote = TestHome::new("remove-devbox");
        let (local_id, remote_id, local_keys, remote_keys) = pair(&local, &remote);
        let result = add_pair(&local, &remote);
        assert_eq!(
            result.status.code(),
            Some(0),
            "{}\n{}",
            stdout(&result),
            stderr(&result)
        );
        let remote_authorization = fs::read_to_string(&remote_keys.authorized).unwrap();

        remote.kill_home_processes();
        let wrong_id = "8abd1e14-8b27-42c0-8eb6-6b687b7b9af0";
        assert_ne!(wrong_id, remote_id);
        rusqlite::Connection::open(remote.path.join("core/facade.db"))
            .unwrap()
            .execute("UPDATE machine SET machine_id = ?1", [wrong_id])
            .unwrap();
        let result = local.run_facade(&["machine", "remove", "--bidirectional", "devbox"]);
        assert_eq!(
            result.status.code(),
            Some(1),
            "{}\n{}",
            stdout(&result),
            stderr(&result)
        );
        assert_eq!(stdout(&result), "Removed the saved connection to devbox.\n");
        let error = stderr(&result);
        assert!(
            error.starts_with("error: Could not confirm removal on devbox: "),
            "{error}"
        );
        assert_eq!(
            error.lines().skip(1).collect::<Vec<_>>(),
            [
                "Check the return connection and SSH authorization on devbox.".to_owned(),
                format!(
                    "On devbox, use 'facade machine list' to verify the saved return connection to laptop (machine ID {local_id}). If confirmed, run 'facade machine remove <MACHINE>' with the ID shown for that row."
                ),
            ],
        );
        assert_eq!(
            fs::read_to_string(local_keys.authorized).unwrap(),
            local_keys.initial
        );
        assert_eq!(
            fs::read_to_string(remote_keys.authorized).unwrap(),
            remote_authorization
        );
    }
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
        .map(|agent| agent["address"].as_str().unwrap())
        .collect();
    assert_eq!(ids, expected);
    assert!(agents.windows(2).all(|pair| {
        pair[0]["started_at"].as_str().unwrap() >= pair[1]["started_at"].as_str().unwrap()
    }));
    assert!(agents.iter().all(|agent| agent["type"] == "managed"
        && agent.get("id").is_none()
        && agent.get("agent_id").is_none()
        && agent.get("label").is_none()));

    for agent in &mut agents {
        let agent = agent.as_object_mut().unwrap();
        agent.shift_remove("reference");
        let address = agent.shift_remove("address").unwrap();
        agent.insert("id".into(), address);
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
    let id = worker["reference"]["agent_id"].as_str().unwrap();
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
    assert_eq!(worker["reference"]["machine_id"], second_id, "{worker}");
    let remote = connect(&first).call("agent.inspect", json!({ "target": target }));
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
            let refused = wire.call("agent.screen", json!({ "target": target }));
            error_reason(&refused) == "unavailable"
        }),
        "the remote target is still reachable after dropping the link"
    );
    assert_eq!(terminal.output_count(ATTACH_RECONNECT_NOTE), 0);
    assert_eq!(second.agent_record(id).unwrap()["pid"], worker["pid"]);
    assert!(terminal.wait_exit(secs(0)).is_none(), "{}", terminal.text());
    first.wait_for_gate("attach-disconnected");
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
    assert_eq!(agent["reference"]["machine_id"], second_id, "{agent}");

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
        first["error"]["data"]["details"]["execution"], "outcome_unknown",
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
        offline["error"]["data"]["details"]["execution"], "outcome_unknown",
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

/// Once the peer accepts raw input, a cut link can hide the result while the bytes still arrive.
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn raw_input_on_a_cut_peer_link_reports_unknown_and_arrives_once() {
    let local = TestHome::new("raw-cut-origin");
    let peer = TestHome::new("raw-cut-peer");
    install_machine_ssh(
        &[("origin", &local), ("peer", &peer)],
        &test_binaries().facade,
    );
    let gate = "before-type-input";
    peer.start_facade_with(&[("FACADE_TEST_GATES", gate)]);
    name_machine(&local, "origin");
    let peer_id = name_machine(&peer, "peer");
    let keys = peer.project.join("raw-keys");
    let worker = peer.start_fake_with("worker", &[("FAKECLI_KEYS", keys.to_str().unwrap())]);
    let reference = peer.inspect_agent(&worker.address)["agent"]["reference"].clone();
    assert!(wait_until(LOADED_TIMEOUT, || keys.is_file()));
    let link = MachineLink::open(&local, "peer", &peer);
    wait_for_route(&local, &peer_id, &[&peer_id]);

    let text = "raw input 界";
    let bytes = format!("{text}\r");
    let mut origin = connect(&local);
    let input = origin.send(
        "call",
        json!({
            "op": "agent.type",
            "args": { "target": reference,
                "input": { "kind": "raw", "raw": facade_base::base64::encode(bytes.as_bytes()) } },
        }),
    );
    peer.wait_for_gate(gate);
    // The forwarded request is executing on the peer, with no terminal bytes written yet.
    assert!(std::fs::read(&keys).unwrap().is_empty());
    drop(link);
    let lost = origin
        .wait_for_response(input, LOADED_TIMEOUT)
        .expect("the origin reports the cut peer link");
    assert_eq!(lost["id"], input, "{lost}");
    assert_eq!(error_reason(&lost), "unavailable", "{lost}");
    let details = &lost["error"]["data"]["details"];
    assert_eq!(details["execution"], "outcome_unknown", "{lost}");
    assert_eq!(details["machine"]["machine_id"], peer_id, "{lost}");
    assert!(std::fs::read(&keys).unwrap().is_empty());

    peer.release_gate(gate);
    assert!(wait_until(LOADED_TIMEOUT, || peer.submitted_messages() == [text]));
    assert_eq!(std::fs::read(&keys).unwrap(), bytes.as_bytes());
    assert_eq!(process_identity(worker.pid), worker.process);

    let _link = MachineLink::open(&local, "peer", &peer);
    wait_for_route(&local, &peer_id, &[&peer_id]);
    let screen = origin.call_ok("agent.screen", json!({ "target": reference }));
    assert!(screen["text"].as_str().unwrap().contains(text), "{screen}");
    let next = "new input after reconnect";
    type_raw(&mut origin, &worker.address, &format!("{next}\r"));
    assert!(wait_until(LOADED_TIMEOUT, || peer.submitted_messages() == [text, next]));
    assert_eq!(
        std::fs::read(&keys).unwrap(),
        format!("{bytes}{next}\r").as_bytes()
    );
}

/// Only a forwarded call may read the holder's internal agent records.
#[test]
fn authenticated_peer_lists_exact_holder_records_and_local_access_is_refused() {
    let local = TestHome::new("records-origin");
    let peer = TestHome::new("records-peer");
    let local_id = name_machine(&local, "origin");
    let peer_id = name_machine(&peer, "peer");
    let local_run = local.start_fake("worker");
    let peer_run = peer.start_fake("worker");
    assert_eq!(local_run.id, peer_run.id);
    assert_ne!(local_run.address, peer_run.address);
    let expected = json!({ "machine_id": peer_id, "agent_id": peer_run.id });
    let bridge = ObservedMachineLink::open(&local, &peer);
    wait_for_route(&local, &peer_id, &[&peer_id]);

    let mut person = connect(&local);
    let listed = person.call_ok(
        "agent.list",
        json!({ "scope": { "kind": "machine", "machine": peer_id } }),
    );
    let listed = listed["agents"]
        .as_array()
        .expect("the selected peer's roster");
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0]["reference"], expected);
    assert_eq!(listed[0]["address"], peer_run.address);
    let request = observed_frame(&bridge.from_front, "the forwarded record query", |frame| {
        frame["method"] == "forward" && frame["params"]["params"]["op"] == "internal.agent_records"
    });
    assert_eq!(
        request["params"]["caller"],
        json!({ "kind": "terminal", "machine_id": local_id }),
        "{request}"
    );
    assert_eq!(request["params"]["route"], json!([peer_id]), "{request}");
    assert_eq!(
        request["params"]["params"]["args"],
        json!({ "active": true }),
        "{request}"
    );
    let response = observed_frame(
        &bridge.from_peer,
        "the holder's correlated records",
        |frame| frame["id"] == request["id"],
    );
    let records = response["result"].as_array().expect("the holder's records");
    assert_eq!(records.len(), 1, "{response}");
    assert_eq!(records[0]["agent"]["reference"], expected, "{response}");
    assert_eq!(
        records[0]["agent"]["address"], peer_run.address,
        "{response}"
    );
    assert_eq!(records[0]["agent"]["pid"], peer_run.pid, "{response}");

    let denied = connect(&peer).call("internal.agent_records", json!({ "active": true }));
    assert_eq!(error_reason(&denied), "refused", "{denied}");
    assert!(denied.get("result").is_none(), "{denied}");
    assert_eq!(
        denied["error"]["message"],
        "internal.agent_records is unavailable to this client"
    );
    assert!(alive(&peer_run.process) && alive(&local_run.process));
}

/// The first hop stays authenticated while a live subscription loses and regains its provider.
#[test]
fn a_forwarded_attach_maps_live_peer_changes_and_watch_end() {
    let origin = TestHome::new("watch-front");
    let middle = TestHome::new("watch-middle");
    let provider = TestHome::new("watch-provider");
    install_machine_ssh(
        &[("middle", &middle), ("provider", &provider)],
        &test_binaries().facade,
    );
    let origin_id = name_machine(&origin, "origin");
    let middle_id = name_machine(&middle, "middle");
    let provider_id = name_machine(&provider, "provider");
    let remote_keys = provider.folder().join("forwarded-keys");
    let local_keys = origin.folder().join("local-keys");
    let remote_sizes = provider.folder().join("forwarded-sizes");
    let local_sizes = origin.folder().join("local-sizes");
    let worker = provider.start_fake_with(
        "worker",
        &[
            ("FAKECLI_KEYS", remote_keys.to_str().unwrap()),
            ("FAKECLI_SIZE_LOG", remote_sizes.to_str().unwrap()),
        ],
    );
    let decoy = origin.start_fake_with(
        "worker",
        &[
            ("FAKECLI_KEYS", local_keys.to_str().unwrap()),
            ("FAKECLI_SIZE_LOG", local_sizes.to_str().unwrap()),
        ],
    );
    assert_eq!(worker.id, decoy.id);
    assert_ne!(worker.address, decoy.address);
    let exact = provider.inspect_agent(&worker.address)["agent"]["reference"].clone();
    assert_eq!(exact["machine_id"], provider_id);
    assert!(wait_for_screen_text(&provider, &worker.address, "❯"));
    let downstream = MachineLink::open(&middle, "provider", &provider);
    wait_for_route(&middle, &provider_id, &[&provider_id]);

    let mut roster = ManualReadClient::open(&origin);
    roster.send(1, "watch", json!({ "topic": "machines", "args": {} }));
    let initial = roster.read_frame().unwrap().expect("the machine snapshot");
    assert_eq!(initial["id"], 1);
    let roster_watch = initial["result"]["watch"].as_u64().unwrap();
    let machines = initial["result"]["snapshot"]
        .as_array()
        .expect("the machine roster array");
    assert_eq!(machines.len(), 1, "{initial}");
    assert_eq!(machines[0]["machine_id"], origin_id, "{initial}");
    assert_eq!(machines[0]["connections"], json!([]), "{initial}");

    let bridge = ObservedMachineLink::open(&origin, &middle);
    let hello = observed_frame(
        &bridge.from_front,
        "the origin's machine introduction",
        |frame| frame["method"] == "hello",
    );
    assert_eq!(hello["id"], 0, "{hello}");
    assert_eq!(hello["params"]["kind"], "machine", "{hello}");
    assert_eq!(hello["params"]["api_versions"], json!([1]), "{hello}");
    assert_eq!(
        hello["params"]["machine"]["machine_id"], origin_id,
        "{hello}"
    );
    assert_eq!(hello["params"]["machine"]["name"], "origin", "{hello}");
    let connected = observed_frame(&bridge.from_front, "the handoff notification", |frame| {
        frame["method"] == "connected"
    });
    assert!(connected.get("id").is_none(), "{connected}");
    assert_eq!(connected["jsonrpc"], "2.0", "{connected}");
    assert_eq!(
        connected["params"]["machine"]["machine_id"], middle_id,
        "{connected}"
    );
    assert_eq!(
        connected["params"]["machine"]["name"], "middle",
        "{connected}"
    );
    let greeting = observed_frame(&bridge.from_peer, "the peer's machine hello", |frame| {
        frame["id"] == hello["id"]
    });
    assert_eq!(greeting["result"]["api_version"], 1, "{greeting}");
    assert_eq!(greeting["result"]["machine_id"], middle_id, "{greeting}");
    assert!(
        greeting["result"]["machine"]["boot_id"].is_string(),
        "{greeting}"
    );
    assert_eq!(
        connected["params"]["machine"]["boot_id"], greeting["result"]["machine"]["boot_id"],
        "{connected}"
    );
    let mut peer_update = false;
    let mut connection_update = false;
    while !peer_update || !connection_update {
        let frame = roster
            .read_frame()
            .unwrap()
            .expect("a machine roster update");
        assert_eq!(frame["method"], "changed", "{frame}");
        assert_eq!(frame["params"]["watch"], roster_watch, "{frame}");
        assert!(frame.get("id").is_none(), "{frame}");
        let change = &frame["params"]["change"];
        if change["kind"] != "updated" {
            continue;
        }
        let machine = &change["machine"];
        peer_update |= machine["machine_id"] == middle_id
            && machine["state"] == "online"
            && machine["route"] == json!([middle_id]);
        connection_update |= machine["machine_id"] == origin_id
            && machine["connections"]
                .as_array()
                .unwrap()
                .iter()
                .any(|connection| {
                    connection["machine_id"] == middle_id
                        && connection["initiator_machine_id"] == origin_id
                        && connection["kind"] == "temporary"
                        && connection["state"] == "connected"
                });
    }
    drop(roster);
    wait_for_route(&origin, &provider_id, &[&middle_id, &provider_id]);

    // The same introduction with a disjoint offer cannot enter the machine protocol.
    let mut invalid = ManualReadClient::before_hello(&middle);
    let mut params = hello["params"].clone();
    params["api_versions"] = json!([2]);
    invalid.send(7, "hello", params);
    let rejection = invalid
        .read_message()
        .expect("the disjoint hello is refused");
    assert_eq!(rejection["id"], 7, "{rejection}");
    assert_eq!(rejection["error"]["code"], -32000, "{rejection}");
    assert_eq!(
        error_reason(&rejection),
        "protocol_incompatible",
        "{rejection}"
    );
    assert_eq!(
        rejection["error"]["data"]["details"]["supported_api_versions"],
        json!([1]),
        "{rejection}"
    );
    invalid.send(8, "forward", json!({}));
    let refused = invalid
        .read_message()
        .expect("the unadmitted session is refused");
    assert_eq!(refused["id"], 8, "{refused}");
    assert_eq!(refused["error"]["message"], "send hello first", "{refused}");
    drop(invalid);
    wait_for_route(&middle, &origin_id, &[&origin_id]);
    println!(
        "machine hello {origin_id} -> {middle_id} selected v1, disjoint offer stayed unadmitted"
    );

    let mut user = ManualReadClient::open(&origin);
    let args = json!({ "topic": "attach", "args": { "target": exact } });
    user.send(1, "watch", args.clone());
    let local = user
        .read_frame()
        .unwrap()
        .expect("the local watch snapshot");
    assert_eq!(local["id"], 1, "{local}");
    let local_watch = local["result"]["watch"].as_u64().unwrap();
    assert_eq!(local["result"]["snapshot"]["reference"], exact, "{local}");
    let forward = observed_frame(&bridge.from_front, "the forwarded watch", |frame| {
        frame["method"] == "forward"
            && frame["params"]["method"] == "watch"
            && frame["params"]["params"]["topic"] == "attach"
    });
    assert_eq!(
        forward["params"]["caller"]["machine_id"], origin_id,
        "{forward}"
    );
    assert_eq!(
        forward["params"]["params"]["args"]["target"], exact,
        "{forward}"
    );
    let accepted = observed_frame(&bridge.from_peer, "the peer watch snapshot", |frame| {
        frame["id"] == forward["id"]
    });
    let peer_watch = accepted["result"]["watch"]
        .as_u64()
        .expect("the peer watch ID");
    assert_ne!(local_watch, peer_watch);
    assert_eq!(
        accepted["result"]["snapshot"]["reference"], exact,
        "{accepted}"
    );
    let initial_size = accepted["result"]["snapshot"]["size"].clone();
    assert_eq!(local["result"]["snapshot"]["size"], initial_size, "{local}");
    let binding = accepted["result"]["view"].clone();
    let holder_boot = machine_json(&middle, &provider_id).unwrap()["boot_id"].clone();
    assert!(holder_boot.is_string(), "{holder_boot}");
    assert_eq!(binding["boot_id"], holder_boot, "{accepted}");
    assert!(binding["viewer"].is_u64(), "{accepted}");

    let marker = "output from the exact remote worker";
    assert!(wait_until(LOADED_TIMEOUT, || remote_keys.is_file()
        && local_keys.is_file()));
    assert_eq!(std::fs::read(&remote_keys).unwrap(), b"");
    assert_eq!(std::fs::read(&local_keys).unwrap(), b"");
    let mut terminal = connect(&origin);
    let input = json!({ "kind": "raw", "raw": facade_base::base64::encode(marker.as_bytes()) });
    let typed = terminal.send(
        "call",
        json!({ "op": "agent.type", "args": { "target": exact, "input": input } }),
    );
    let forwarded_input = observed_frame(&bridge.from_front, "the forwarded raw input", |frame| {
        frame["method"] == "forward" && frame["params"]["params"]["op"] == "agent.type"
    });
    let forwarded_id = forwarded_input["id"].as_u64().expect("a peer request ID");
    assert_eq!(
        forwarded_input["params"]["caller"],
        json!({ "kind": "terminal", "machine_id": origin_id }),
        "{forwarded_input}"
    );
    assert_eq!(
        forwarded_input["params"]["route"],
        json!([middle_id, provider_id]),
        "{forwarded_input}"
    );
    assert_eq!(
        forwarded_input["params"]["params"]["args"],
        json!({ "target": exact, "input": input }),
        "{forwarded_input}"
    );
    let output = |frame: &Value| {
        frame["params"]["change"]["data"]
            .as_str()
            .map(|data| facade_base::base64::decode(data).unwrap())
    };
    let mut peer_bytes = Vec::new();
    let mut peer_receipt = None;
    let peer_change = observed_frame(
        &bridge.from_peer,
        "the remote worker's id-less output",
        |frame| {
            if frame["id"] == forwarded_id {
                peer_receipt = Some(frame.clone());
                return false;
            }
            if frame["method"] != "changed"
                || frame["params"]["watch"] != peer_watch
                || frame["params"]["change"]["kind"] != "output"
            {
                return false;
            }
            assert!(frame.get("id").is_none(), "{frame}");
            peer_bytes.extend(output(frame).unwrap());
            peer_bytes
                .windows(marker.len())
                .any(|bytes| bytes == marker.as_bytes())
        },
    );
    let peer_receipt = peer_receipt.unwrap_or_else(|| {
        observed_frame(&bridge.from_peer, "the forwarded input reply", |frame| {
            frame["id"] == forwarded_id
        })
    });
    let accepted = terminal
        .wait_for_response(typed, LOADED_TIMEOUT)
        .expect("the original call answers");
    assert_eq!(
        accepted,
        json!({ "jsonrpc": "2.0", "id": typed, "result": {} }),
        "{accepted}"
    );
    assert_eq!(
        peer_receipt,
        json!({ "jsonrpc": "2.0", "id": forwarded_id, "result": {} }),
        "{peer_receipt}"
    );
    assert_eq!(std::fs::read(&remote_keys).unwrap(), marker.as_bytes());
    assert_eq!(std::fs::read(&local_keys).unwrap(), b"");
    assert_eq!(process_identity(decoy.pid), decoy.process);
    println!(
        "terminal request {typed} used peer request {forwarded_id} for {exact}, local input stayed empty"
    );
    let mut local_bytes = Vec::new();
    loop {
        let frame = user
            .read_frame()
            .unwrap()
            .expect("the local watch receives the peer output");
        assert_eq!(frame["method"], "changed", "{frame}");
        assert!(frame.get("id").is_none(), "{frame}");
        assert_eq!(frame["params"]["watch"], local_watch, "{frame}");
        if frame["params"]["change"]["kind"] != "output" {
            continue;
        }
        local_bytes.extend(output(&frame).unwrap());
        if local_bytes
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes())
        {
            assert_eq!(frame["params"]["change"], peer_change["params"]["change"]);
            break;
        }
    }

    // Resize the exact watch from its owning socket, then observe the holder's redraw and PTY.
    let grid_line = |size: &Value| format!("{}x{}", size["cols"], size["rows"]);
    let measured = |path: &Path| std::fs::read_to_string(path).unwrap_or_default();
    let initial_grid = grid_line(&initial_size);
    assert!(
        measured(&remote_sizes).lines().last() == Some(&initial_grid),
        "the remote process reported {}, expected {initial_grid}",
        measured(&remote_sizes)
    );
    let decoy_grid = measured(&local_sizes);
    assert!(!decoy_grid.is_empty());
    let new_size = json!({ "cols": 103, "rows": 31 });
    assert_ne!(initial_size, new_size);
    let resize_id = 9;
    user.send(
        resize_id,
        "call",
        json!({
            "op": "attach.resize", "args": { "watch": local_watch, "size": new_size },
        }),
    );
    let resize = observed_frame(&bridge.from_front, "the forwarded Attach resize", |frame| {
        frame["method"] == "forward" && frame["params"]["params"]["op"] == "internal.attach_resize"
    });
    let peer_resize = resize["id"].as_u64().expect("the peer resize request ID");
    assert_eq!(
        resize["params"]["route"],
        json!([middle_id, provider_id]),
        "{resize}"
    );
    assert_eq!(
        resize["params"]["caller"]["machine_id"], origin_id,
        "{resize}"
    );
    assert_eq!(resize["params"]["method"], "call", "{resize}");
    assert_eq!(
        resize["params"]["params"]["args"],
        json!({ "viewer": binding["viewer"], "boot_id": holder_boot, "size": new_size }),
        "{resize}"
    );
    let redraw = |frame: &Value, watch| {
        frame["method"] == "changed"
            && frame["params"]["watch"] == watch
            && frame["params"]["change"]["kind"] == "redraw"
            && frame["params"]["change"]["size"] == new_size
    };
    let mut peer_ack = false;
    let mut peer_redraw = None;
    observed_frame(
        &bridge.from_peer,
        "the holder's resize reply and redraw",
        |frame| {
            if frame["id"] == peer_resize {
                assert_eq!(
                    *frame,
                    json!({ "jsonrpc": "2.0", "id": peer_resize, "result": {} }),
                    "{frame}"
                );
                peer_ack = true;
            }
            if redraw(frame, peer_watch) {
                assert!(frame.get("id").is_none(), "{frame}");
                peer_redraw = Some(frame["params"]["change"].clone());
            }
            peer_ack && peer_redraw.is_some()
        },
    );
    let mut local_ack = false;
    let mut local_redraw = false;
    while !local_ack || !local_redraw {
        let frame = user
            .read_frame()
            .unwrap()
            .expect("the owning watch stays open");
        if frame["id"] == resize_id {
            assert_eq!(
                frame,
                json!({ "jsonrpc": "2.0", "id": resize_id, "result": {} }),
                "{frame}"
            );
            local_ack = true;
        }
        if redraw(&frame, local_watch) {
            assert!(frame.get("id").is_none(), "{frame}");
            assert_eq!(frame["params"]["change"], *peer_redraw.as_ref().unwrap());
            local_redraw = true;
        }
    }
    let new_grid = grid_line(&new_size);
    assert!(
        wait_until(LOADED_TIMEOUT, || measured(&remote_sizes).lines().last()
            == Some(&new_grid)),
        "the remote process reported {}, expected {new_grid}",
        measured(&remote_sizes)
    );
    assert_eq!(process_identity(worker.pid), worker.process);
    assert_eq!(measured(&local_sizes), decoy_grid);
    println!(
        "Attach resize {resize_id} forwarded as {peer_resize} to {exact}, watch {peer_watch} redrew as local {local_watch}, PID {} measured {} -> {}",
        worker.pid, initial_grid, new_grid
    );

    drop(downstream);
    let ended = observed_frame(
        &bridge.from_peer,
        "the peer ends its forwarded watch",
        |frame| frame["method"] == "watch_ended" && frame["params"]["watch"] == peer_watch,
    );
    assert!(ended.get("id").is_none(), "{ended}");
    assert_eq!(ended["params"]["watch"], peer_watch, "{ended}");
    assert_eq!(
        ended["params"]["error"]["data"]["reason"], "unavailable",
        "{ended}"
    );
    loop {
        let frame = user
            .read_frame()
            .unwrap()
            .expect("the owning local watch ends");
        assert!(frame.get("id").is_none(), "{frame}");
        assert_eq!(frame["params"]["watch"], local_watch, "{frame}");
        if frame["method"] == "watch_ended" {
            assert_eq!(
                frame["params"]["error"]["data"]["reason"],
                ended["params"]["error"]["data"]["reason"],
                "{frame}"
            );
            break;
        }
        assert_eq!(frame["method"], "changed", "{frame}");
    }
    wait_for_route(&origin, &middle_id, &[&middle_id]);
    let _downstream = MachineLink::open(&middle, "provider", &provider);
    wait_for_route(&origin, &provider_id, &[&middle_id, &provider_id]);
    user.send(2, "watch", args);
    let fresh = user
        .read_frame()
        .unwrap()
        .expect("a new watch after the provider returns");
    assert_eq!(fresh["id"], 2, "{fresh}");
    let fresh_watch = fresh["result"]["watch"]
        .as_u64()
        .expect("the fresh watch ID");
    assert_ne!(fresh_watch, local_watch);
    let snapshot = &fresh["result"]["snapshot"];
    assert_eq!(snapshot["reference"], exact, "{fresh}");
    let redraw = facade_base::base64::decode(snapshot["redraw"].as_str().unwrap()).unwrap();
    assert!(
        redraw
            .windows(marker.len())
            .any(|bytes| bytes == marker.as_bytes()),
        "{fresh}"
    );
    assert_eq!(process_identity(worker.pid), worker.process);
}

/// Losing the link does not replace its remote CLI or retarget calls to a same-named local run.
#[test]
fn a_lost_route_recovers_to_the_same_live_remote_terminal() {
    let local = TestHome::new("route-recover-local");
    let peer = TestHome::new("route-recover-peer");
    install_machine_ssh(
        &[("origin", &local), ("peer", &peer)],
        &test_binaries().facade,
    );
    name_machine(&local, "origin");
    let peer_id = name_machine(&peer, "peer");
    let worker = peer.start_fake("worker");
    let decoy = local.start_fake("worker");
    assert_eq!(worker.id, decoy.id);
    assert_ne!(worker.address, decoy.address);

    let original = peer.inspect_agent(&worker.address)["agent"].clone();
    let reference = &original["reference"];
    assert_eq!(reference["machine_id"], peer_id);
    let daemon = peer.lock_record("daemon").unwrap();
    let keeper = peer.lock_record("keeper").unwrap();
    let link = MachineLink::open(&local, "peer", &peer);
    wait_for_route(&local, &peer_id, &[&peer_id]);
    let mut origin = connect(&local);
    let inspect = |origin: &mut DaemonTestClient| {
        origin.call_ok("agent.inspect", json!({ "target": reference }))["agent"].clone()
    };
    let reachable = inspect(&mut origin);
    assert_eq!(reachable["reference"], *reference);
    assert_eq!(reachable["pid"], worker.pid);
    local.run_facade_ok(&["type", &worker.address, "from before the cut"]);
    assert!(wait_for_screen_text(
        &peer,
        &worker.address,
        "❯ from before the cut"
    ));
    assert!(peer.submitted_messages().is_empty());

    drop(link);
    assert!(
        wait_until(LOADED_TIMEOUT, || machine_json(&local, &peer_id)
            .is_none_or(|row| row.get("route").is_none())),
        "the cut peer still has a route: {}",
        machines_json(&local)
    );
    let lost = origin.call("agent.screen", json!({ "target": reference }));
    assert_eq!(error_reason(&lost), "unavailable", "{lost}");
    assert!(alive(&worker.process));
    assert!(wait_for_screen_text(
        &peer,
        &worker.address,
        "❯ from before the cut"
    ));

    let _replacement_link = MachineLink::open(&local, "peer", &peer);
    wait_for_route(&local, &peer_id, &[&peer_id]);
    let recovered = inspect(&mut origin);
    assert_eq!(recovered["reference"], *reference);
    assert_eq!(recovered["address"], worker.address);
    assert_eq!(recovered["pid"], worker.pid);
    assert_eq!(process_identity(worker.pid), worker.process);
    assert_eq!(peer.lock_record("daemon"), Some(daemon));
    assert_eq!(peer.lock_record("keeper"), Some(keeper));
    assert!(
        local
            .run_facade_ok(&["screen", &worker.address])
            .contains("❯ from before the cut")
    );
    local.run_facade_ok(&["type", &worker.address, " and after", "--enter"]);
    assert!(wait_until(LOADED_TIMEOUT, || {
        peer.submitted_messages() == ["from before the cut and after"]
    }));
    assert!(alive(&decoy.process));
    assert!(local.submitted_messages().is_empty());
}

/// The authenticated route request opens the intermediate's saved hop before forwarding the call.
#[test]
fn ensure_route_reopens_the_intermediates_saved_hop() {
    let origin = TestHome::new("ensure-origin");
    let middle = TestHome::new("ensure-middle");
    let provider = TestHome::new("ensure-provider");
    install_machine_ssh(
        &[("middle", &middle), ("provider", &provider)],
        &test_binaries().facade,
    );
    let origin_id = name_machine(&origin, "origin");
    let middle_id = name_machine(&middle, "middle");
    let provider_id = name_machine(&provider, "provider");
    let worker = provider.start_fake("worker");
    let reference = json!({ "machine_id": provider_id, "agent_id": worker.id });
    let marker = "terminal kept behind the saved hop";
    provider.run_facade_ok(&["type", &worker.address, marker]);
    assert!(wait_for_screen_text(&provider, &worker.address, marker));
    add_saved(&middle, "provider", &provider);
    wait_for_route(&middle, &provider_id, &[&provider_id]);
    let saved = || {
        saved_ssh(
            &machine_json(&middle, &middle_id).unwrap(),
            &middle_id,
            &provider_id,
        )
    };
    let transport = saved()["transport"].clone();
    assert_eq!(transport["ssh_destination"], "provider");
    assert_eq!(transport["remote_home"], json!(provider.path));
    let bridge = ObservedMachineLink::open(&origin, &middle);
    wait_for_route(&origin, &provider_id, &[&middle_id, &provider_id]);

    let old = provider.kill_daemon();
    provider
        .wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the provider recovers its live agent");
    let no_route = |home: &TestHome| {
        machine_json(home, &provider_id).is_none_or(|row| row.get("route").is_none())
    };
    assert!(wait_until(LOADED_TIMEOUT, || no_route(&middle) && no_route(&origin)));
    assert_eq!(saved()["state"], "disconnected");
    assert_eq!(saved()["transport"], transport);
    assert_eq!(process_identity(worker.pid), worker.process);

    let hold = provider.folder().join("ssh-hold");
    std::fs::write(&hold, []).unwrap();
    let attempts = ssh_attempts(&provider);
    let serves = ssh_serves(&provider);
    let mut caller = connect(&origin);
    let denied = caller.call("internal.ensure_route", json!({ "wake": true }));
    assert_eq!(error_reason(&denied), "refused", "{denied}");
    assert_eq!(ssh_attempts(&provider), attempts);
    let screen_call = caller.send(
        "call",
        json!({ "op": "agent.screen", "args": { "target": reference } }),
    );
    let ensure = observed_frame(
        &bridge.from_front,
        "the authenticated route wake",
        |frame| {
            frame["method"] == "forward"
                && frame["params"]["params"]["op"] == "internal.ensure_route"
        },
    );
    let ensure_id = ensure["id"].as_u64().expect("a peer wake request");
    assert_eq!(
        ensure["params"]["route"],
        json!([middle_id, provider_id]),
        "{ensure}"
    );
    assert_eq!(
        ensure["params"]["caller"],
        json!({ "kind": "terminal", "machine_id": origin_id }),
        "{ensure}"
    );
    assert_eq!(
        ensure["params"]["params"]["args"],
        json!({ "wake": true }),
        "{ensure}"
    );
    assert!(wait_until(LOADED_TIMEOUT, || ssh_attempts(&provider) != attempts));
    assert_eq!(ssh_serves(&provider), serves);
    let dialing = wait_for_machine_state(&middle, &provider_id, "connecting");
    assert!(dialing.get("route").is_none(), "{dialing}");
    assert_eq!(saved()["state"], "disconnected");
    assert!(no_route(&middle) && no_route(&origin));
    assert!(
        caller
            .wait_for_response(screen_call, std::time::Duration::ZERO)
            .is_none(),
        "the exact call is still blocked by the saved hop"
    );

    std::fs::remove_file(hold).unwrap();
    let opened = observed_frame(
        &bridge.from_peer,
        "the correlated route-wake receipt",
        |frame| frame["id"] == ensure_id && frame.get("method").is_none(),
    );
    assert_eq!(
        opened,
        json!({ "jsonrpc": "2.0", "id": ensure_id, "result": {} })
    );
    assert_eq!(ssh_serves(&provider), format!("{serves}wake\n"));
    wait_for_route(&middle, &provider_id, &[&provider_id]);
    wait_for_route(&origin, &provider_id, &[&middle_id, &provider_id]);
    assert_eq!(saved()["transport"], transport);
    assert_eq!(saved()["state"], "connected");

    let forwarded = observed_frame(
        &bridge.from_front,
        "the call on the opened route",
        |frame| frame["method"] == "forward" && frame["params"]["params"]["op"] == "agent.screen",
    );
    assert_eq!(
        forwarded["params"]["route"],
        json!([middle_id, provider_id]),
        "{forwarded}"
    );
    assert_eq!(
        forwarded["params"]["params"]["args"]["target"], reference,
        "{forwarded}"
    );
    let forwarded_id = forwarded["id"].as_u64().expect("a peer call ID");
    let response = observed_frame(
        &bridge.from_peer,
        "the provider's screen response",
        |frame| frame["id"] == forwarded_id && frame.get("method").is_none(),
    );
    assert!(
        response["result"]["text"]
            .as_str()
            .is_some_and(|text| text.contains(marker)),
        "{response}"
    );
    let received = caller
        .wait_for_response(screen_call, LOADED_TIMEOUT)
        .expect("the caller's screen result");
    assert_eq!(received["id"], screen_call, "{received}");
    assert_eq!(
        received["result"]["text"], response["result"]["text"],
        "{received}"
    );
    assert_eq!(process_identity(worker.pid), worker.process);
    println!(
        "ensure-route {ensure_id} woke {provider_id} through {middle_id}; peer call {forwarded_id} read CLI {}",
        worker.pid
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
    let hello = editor.hello("ide", DAEMON_API_VERSIONS, json!({}));
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
    assert_eq!(row["address"], format!("{}@remote", teller.id));
    let inspected = editor.call("agent.inspect", json!({ "target": row["reference"] }));
    assert_eq!(
        inspected["result"]["agent"]["address"], row["address"],
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

    let adopt = editor.call("agent.adopt", json!({ "target": row["reference"] }));
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

/// Finish the accepted editor's import before cutting two isolated machines over to v1.
#[test]
#[ignore = "requires the exact isolated accepted CLI binary in FACADE_TEST_API_V1_PRERELEASE"]
fn a_legacy_workspace_import_recovers_both_machines_before_cold_cutover() {
    let prerelease = std::path::PathBuf::from(
        std::env::var_os("FACADE_TEST_API_V1_PRERELEASE").expect("the accepted CLI artifact"),
    );
    assert!(
        prerelease.is_absolute() && prerelease.is_file(),
        "{}",
        prerelease.display()
    );
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
    let first_welcome = first.hello_prerelease("ide", [2, 2], describe("legacy-first"));
    let local_id = first_welcome["result"]["machine_id"].as_str().unwrap();
    let first_window = &first_welcome["result"]["window"];
    assert_eq!(first_welcome["result"]["build"], V2_TEST_BUILD);
    assert_eq!(first_window["machine_id"], local_id, "{first_welcome}");
    let mut second = DaemonTestClient::open(&local);
    let second_welcome = second.hello_prerelease("ide", [2, 2], describe("legacy-second"));
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
    let peer_welcome = peer.hello_prerelease("terminal", [2, 2], json!({}));
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

    install_machine_ssh(&endpoints, &prerelease);
    let call = |home: &TestHome, args: &[&str]| {
        let output = home
            .command(&prerelease)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {}", stderr(&output));
    };
    for home in [&local, &remote] {
        call(home, &["daemon", "--takeover"]);
    }
    let mut editor = DaemonTestClient::open(&local);
    let hello = editor.hello_prerelease("ide", [3, 3], json!({}));
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

    call(
        &local,
        &[
            "machine",
            "add",
            "--home",
            remote.path.to_str().unwrap(),
            "qa-peer",
        ],
    );
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
        (&owner_ref, local_run, first_window),
        (&peer_ref, peer_run, second_window),
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
    // Persist distinct names so both display addresses remain stable across the cold restart.
    call(&local, &["machine", "rename", local_id, "qa-owner"]);
    call(&remote, &["machine", "rename", peer_id, "qa-peer"]);
    let before = [(&local, owner_ref), (&remote, peer_ref)].map(|(home, reference)| {
        let mut wire = DaemonTestClient::open(home);
        let hello = wire.hello_prerelease("terminal", [3, 3], json!({}));
        assert_eq!(hello["result"]["machine_id"], reference["machine_id"]);
        let live = wire.call_ok("agent.inspect", json!({ "reference": reference }));
        call(home, &["stop", live["agent"]["address"].as_str().unwrap()]);
        let finished = wire.call_ok("agent.inspect", json!({ "reference": reference }));
        assert_eq!(finished["agent"]["process"], "ended", "{finished}");
        (home, reference, finished["agent"].clone())
    });
    drop(editor);
    for home in [&local, &remote] {
        home.kill_home_processes();
    }
    install_machine_ssh(&endpoints, &test_binaries().facade);
    for (home, reference, finished) in before {
        let mut editor = connect(home);
        let kept = editor.call_ok("agent.inspect", json!({ "target": reference }));
        assert_eq!(kept["agent"]["reference"], reference, "{kept}");
        for field in ["name", "address", "process", "exit"] {
            assert_eq!(kept["agent"][field], finished[field], "{field}: {kept}");
        }
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
    assert!(wait_for_screen_text(
        &third,
        &distant.address,
        "through the middle"
    ));
    assert!(
        first
            .run_facade_ok(&["screen", "lookout"])
            .contains("through the middle")
    );

    let nearby = first.start_named_fake("lookout", &[]);
    // Both machines have an a1 and first reaches third: the address names the nearby one alone.
    assert!(wait_for_screen_text(&first, &nearby.address, "❯"));
    let refused = connect(&first).call("agent.screen", json!({ "target": "lookout" }));
    assert_eq!(error_reason(&refused), "ambiguous_reference", "{refused}");
    let candidates = refused["error"]["data"]["details"]["candidates"]
        .as_array()
        .unwrap();
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
    let ssh = saved_ssh(
        &machine_json(&first, &first_id).unwrap(),
        &first_id,
        &third_id,
    );
    assert_eq!(ssh["state"], "connected");
    assert_eq!(ssh["transport"]["ssh_destination"], "third");
    assert_eq!(ssh["transport"]["ssh_args"], json!(["-p", "2222", "third"]));
    assert_eq!(ssh["transport"]["remote_home"], home);
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
    assert!(wait_until(LOADED_TIMEOUT, || {
        machine_json(&first, &third_id).is_some_and(|row| row.get("route").is_none())
    }));
    std::thread::scope(|scope| {
        let probe = scope.spawn(|| first.run_facade(&["list"]));
        let connecting = wait_until(secs(15), || {
            machine_json(&first, &third_id).is_some_and(|row| row["state"] == "connecting")
        });
        let listed = connect(&first).call_ok("agent.list", json!({ "scope": { "kind": "local" } }));
        let pending = machine_json(&first, &third_id).unwrap();
        std::fs::write(third.folder().join("ssh-offline"), []).unwrap();
        std::fs::remove_file(hold).unwrap();
        let probe = probe.join().unwrap();
        assert!(
            connecting,
            "the reachable list did not start an SSH attempt"
        );
        assert_eq!(pending["state"], "connecting", "{pending}");
        assert!(machine_in(&listed, &third_id).is_none(), "{listed}");
        assert!(
            listed["agents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|agent| agent["name"] == "other"),
            "{listed}"
        );
        assert!(probe.status.success(), "{}", stderr(&probe));
    });
    let disconnected = wait_for_machine_state(&first, &third_id, "unreachable");
    assert!(disconnected.get("unreachable").is_none(), "{disconnected}");
    assert!(disconnected.get("route").is_none(), "{disconnected}");
    let direct = saved_ssh(
        &machine_json(&first, &first_id).unwrap(),
        &first_id,
        &third_id,
    );
    assert_eq!(direct["state"], "disconnected", "{disconnected}");
    assert_eq!(direct["transport"], ssh["transport"]);
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
    first.run_facade_ok(&["list"]);
    let needs_login = wait_for_machine_state(&first, &third_id, "ssh_interaction_required");
    let direct = saved_ssh(
        &machine_json(&first, &first_id).unwrap(),
        &first_id,
        &third_id,
    );
    assert_eq!(direct["state"], "ssh_interaction_required");
    assert_eq!(direct["transport"], ssh["transport"]);
    let repair = &direct["ssh_interaction"];
    assert_eq!(
        repair["command"],
        json!([
            "facade", "machine", "add", "--home", home, "-p", "2222", "third"
        ])
    );
    assert!(
        repair["message"]
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

    let refused = connect(&first).call("agent.screen", json!({ "target": target }));
    assert_eq!(
        error_reason(&refused),
        "ssh_interaction_required",
        "{refused}"
    );
    assert_eq!(refused["error"]["data"]["details"], *repair, "{refused}");
    assert!(
        connect(&first).call("agent.screen", json!({ "target": "other" }))["result"].is_object(),
        "the offline saved peer does not block a unique reachable agent"
    );
    first.run_facade_ok(&["machine", "remove", "lookout-host"]);
    assert!(
        connect(&first).call("agent.screen", json!({ "target": "other" }))["result"].is_object()
    );
}
