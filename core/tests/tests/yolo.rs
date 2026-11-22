//! YOLO, folder trust, creation trees and reach (RULES-2.2, 4.2, 4.3; CLIS-1.3, 3.3; MCP-3.1;
//! CONFIGURATION-1.4, 4.1): each launch reads `yolo` from Facade's settings file, `facade.json`, as
//! it is accepted, and keeps it for its run; a file that cannot be read as it must refuses it; with
//! YOLO on its CLI runs without asking and trusts the launch's folder, Claude Code's question
//! answered on its screen; an agent's record says who started it and the first agent of its tree;
//! and an agent whose run has YOLO off reaches only its creation tree.

use std::path::Path;
use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// `path` with symbolic links resolved, as Facade gives folders.
fn real(path: &Path) -> String {
    facade_base::files::real_path(path)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

/// Writes Facade's settings file, `facade.json` in the test's Facade home, as `text`.
fn settings(home: &TestHome, text: &str) {
    std::fs::create_dir_all(&home.path).unwrap();
    std::fs::write(home.path.join("facade.json"), text).unwrap();
}

/// Agent `name`'s record, as the `agents` topic gives it.
fn record(home: &TestHome, name: &str) -> Value {
    home.agents()
        .into_iter()
        .find(|agent| agent["name"] == name)
        .unwrap_or_else(|| panic!("no agent {name}"))
}

/// The machine part of the addresses Facade gives in this test's home.
fn host(home: &TestHome) -> String {
    let address = home.agents()[0]["address"].as_str().unwrap().to_string();
    address.split_once('@').unwrap().1.to_string()
}

/// Each launch reads `yolo` from Facade's settings file, `facade.json`, as it is accepted, and
/// keeps it for its run: a start from a terminal or from an editor alike. A missing file, an empty
/// one, and one without `yolo` mean on. A daemon that starts again reads the file as it is then.
/// `facade inspect` says a run's YOLO.
#[test]
fn each_launch_reads_yolo_from_the_settings_file_and_keeps_it_for_its_run() {
    let home = TestHome::new("yolofile");
    let folder = real(&home.project);
    home.start_named_fake("missing", &[]);
    assert_eq!(record(&home, "missing")["yolo"], true, "no file: on");
    settings(&home, "");
    home.start_named_fake("empty", &[]);
    assert_eq!(record(&home, "empty")["yolo"], true, "an empty file: on");
    settings(&home, "{ // nothing said of yolo\n}");
    home.start_named_fake("unsaid", &[]);
    assert_eq!(record(&home, "unsaid")["yolo"], true, "no yolo: on");
    settings(&home, r#"{"yolo": false}"#);
    home.start_named_fake("off", &[]);
    assert_eq!(record(&home, "off")["yolo"], false);
    let mut editor = DaemonTestClient::open(&home);
    editor.hello("ide", DAEMON_API_VERSIONS, json!({}));
    let env = json!({ "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path });
    let from_the_editor = editor.call(
        "agent.start",
        json!({
            "cli": "fake", "name": "from-the-editor", "folder": folder, "env": env,
            "size": { "cols": 80, "rows": 24 },
        }),
    );
    assert_eq!(
        from_the_editor["result"]["agent"]["yolo"], false,
        "an editor's start reads the same file: {from_the_editor}"
    );
    settings(
        &home,
        "{\n  \"yolo\": true, // with a comment and a trailing comma\n}",
    );
    home.start_named_fake("on", &[]);
    assert_eq!(record(&home, "on")["yolo"], true);
    assert_eq!(
        record(&home, "off")["yolo"],
        false,
        "a run keeps the YOLO it launched with"
    );
    settings(&home, r#"{"yolo": false}"#);
    drop(editor);
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    home.start_named_fake("after-restart", &[]);
    assert_eq!(record(&home, "after-restart")["yolo"], false);
    assert_eq!(record(&home, "on")["yolo"], true, "kept across the restart");
    let yolo = |agent: &str| {
        status_field(&home.run_facade_ok(&["status", agent]), "YOLO").map(str::to_string)
    };
    assert_eq!(yolo("after-restart").as_deref(), Some("off"));
    assert_eq!(yolo("on").as_deref(), Some("on"));
}

/// A settings file Facade cannot read as it must refuses every start that uses what is wrong:
/// `yolo`, which every start reads, `facade start` and `start_agent` alike, saying each of its
/// problems with the file's path, line and column, and nothing starts (CONFIGURATION-4.1). Fixed,
/// the next start goes.
#[test]
fn a_settings_file_that_cannot_be_read_refuses_every_start() {
    let home = TestHome::new("yolobadfile");
    home.start_named_fake("ada", &[]);
    let cwd = record(&home, "ada")["cwd"].as_str().unwrap().to_string();
    let file = home.path.join("facade.json").display().to_string();
    settings(&home, "{\n  \"yolo\": \"false\",\n  \"colour\": 1\n}");
    let said = format!(
        "{file}:2:3: yolo must be true or false; received string; {file}:3:3: \"colour\" is not a \
         Facade setting; the settings are yolo, names and clis"
    );
    let mut command = home.command(&test_binaries().facade);
    let refused = command
        .env("PATH", home.path_with_test_programs())
        .args(["start", "-d", "--name", "nope", "fake"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        !refused.status.success() && stderr(&refused).contains(&said),
        "{}",
        stderr(&refused)
    );
    let mut ada = McpTestClient::open(&home, "a1");
    let start = |name: &str| json!({ "name": name, "cli": "fake", "folder": cwd });
    let mcp = ada.call("start_agent", start("nope"));
    assert_eq!(mcp["reason"], "invalid_settings", "{mcp}");
    assert!(
        mcp["message"]
            .as_str()
            .is_some_and(|message| message.starts_with(&said)),
        "{mcp}"
    );
    assert_eq!(home.agents().len(), 1, "nothing started");
    settings(&home, r#"{"yolo": false,}"#);
    assert_eq!(ada.call("start_agent", start("fixed"))["status"], "success");
    assert_eq!(record(&home, "fixed")["yolo"], false);
}

/// An agent started by an agent's client records its creator and joins its creator's tree, whose
/// first agent stays the root down the generations. A command in an agent's terminal acts for the
/// command line, as the person's start does, which is the first of a tree of its own. The
/// instructions name the creator.
#[test]
fn a_child_joins_its_creator_s_tree_and_the_person_s_start_heads_its_own() {
    let home = TestHome::new("yolotrees");
    home.start_named_fake("ada", &[]);
    let host = host(&home);
    let cwd = record(&home, "ada")["cwd"].as_str().unwrap().to_string();
    let mut ada = McpTestClient::open(&home, "a1");
    let child = |server: &mut McpTestClient, name: &str| {
        let started = server.call(
            "start_agent",
            json!({ "name": name, "cli": "fake", "folder": cwd }),
        );
        assert_eq!(started["status"], "success", "{started}");
        record(&home, name)
    };
    let bea = child(&mut ada, "bea");
    let ada_ref = record(&home, "ada")["reference"].clone();
    assert_eq!(
        (
            &bea["reference"]["agent_id"],
            &bea["creator"],
            &bea["root"],
            &bea["yolo"]
        ),
        (&json!("a2"), &ada_ref, &ada_ref, &json!(true))
    );
    let mut bea_server = McpTestClient::open(&home, "a2");
    let started_by = format!(" You were started by ada (a1@{host}). ");
    assert!(
        bea_server.initialized()["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains(&started_by),
        "{}",
        bea_server.initialized()
    );
    let cy = child(&mut bea_server, "cy");
    assert_eq!(
        (&cy["creator"], &cy["root"]),
        (&bea["reference"], &ada_ref),
        "a grandchild's tree is its grandparent's"
    );
    let in_terminal = home
        .command(&test_binaries().facade)
        .env("FACADE_AGENT", "a2")
        .env("PATH", home.path_with_test_programs())
        .args(["start", "-d", "--name", "dee", "fake"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(in_terminal.status.success(), "{}", stderr(&in_terminal));
    let dee = record(&home, "dee");
    assert_eq!(
        (dee.get("creator"), &dee["root"]),
        (None, &dee["reference"]),
        "a command in bea's terminal acts for the command line: {dee}"
    );
    home.start_named_fake("eve", &[]);
    let eve = record(&home, "eve");
    assert_eq!(
        (eve.get("creator"), &eve["root"]),
        (None, &eve["reference"]),
        "the person's start is the first of its own tree"
    );
    assert!(
        ada.initialized()["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains(" You were started from the command line. "),
        "{}",
        ada.initialized()
    );
}

/// An agent whose run has YOLO off finds, lists, reads, types into, stops and sends to only the
/// agents of its creation tree: any other agent is refused as out of its reach, with nothing done,
/// by its number and by its name alike, without its address. An agent whose run has YOLO on, and
/// the person, reach every agent.
#[test]
fn an_agent_whose_run_has_yolo_off_reaches_only_its_creation_tree() {
    let home = TestHome::new("yoloreach");
    let folder = real(&home.project);
    settings(&home, r#"{"yolo": false}"#);
    home.start_named_fake("ada", &[]);
    home.start_named_fake("bob", &[]);
    let host = host(&home);
    let mut ada = McpTestClient::open(&home, "a1");
    let started = ada.call(
        "start_agent",
        json!({ "name": "cy", "cli": "fake", "folder": folder }),
    );
    assert_eq!(started["status"], "success", "{started}");
    let root = record(&home, "ada")["reference"].clone();
    assert_eq!(record(&home, "cy")["root"], root);
    let listed = ada.call("list_agents", json!({}));
    let mut ids: Vec<&str> = listed["data"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        [format!("a1@{host}"), format!("a3@{host}")],
        "{listed}"
    );
    for (tool, arguments) in [
        ("read_screen", json!({ "agent": "a2" })),
        (
            "type_text",
            json!({ "agent": "a2", "text": "typed from outside" }),
        ),
        ("press_keys", json!({ "agent": "a2", "keys": ["Enter"] })),
        (
            "send_message",
            json!({ "to": "a2", "text": "sent from outside" }),
        ),
        ("stop_agent", json!({ "agent": "a2" })),
    ] {
        let refused = ada.call(tool, arguments);
        assert_eq!(refused["reason"], "refused", "{tool}: {refused}");
    }
    let named = ada.call("send_message", json!({ "to": "bob", "text": "hi" }));
    assert!(
        named["reason"] == "refused"
            && !named["message"]
                .as_str()
                .unwrap_or_default()
                .contains(&format!("a2@{host}")),
        "by its name as by its number, without its address: {named}"
    );
    assert_eq!(record(&home, "bob")["process"], "running");
    assert!(
        !home.screen("bob").contains("from outside"),
        "{}",
        home.screen("bob")
    );
    assert!(home.submitted_messages().is_empty(), "nothing reached bob");
    settings(&home, r#"{"yolo": true}"#);
    home.start_named_fake("dan", &[]);
    let mut dan = McpTestClient::open(&home, "a4");
    let all = dan.call("list_agents", json!({}));
    assert_eq!(
        all["data"]["agents"].as_array().map(Vec::len),
        Some(4),
        "{all}"
    );
    let launched = ada.call(
        "start_agent",
        json!({ "name": "eve", "cli": "fake", "folder": folder }),
    );
    assert_eq!(launched["status"], "success", "{launched}");
    let eve = record(&home, "eve");
    assert_eq!(
        (&eve["yolo"], &eve["root"]),
        (&json!(true), &root),
        "its tree is ada's, its YOLO the file's"
    );
    assert_eq!(
        dan.call("read_screen", json!({ "agent": "a2" }))["status"],
        "success"
    );
    assert!(
        home.run_facade_ok(&["screen", "bob"]).contains("fakecli"),
        "the person reaches every agent"
    );

    let (_guest, guest_list, joined) = guest(&home);
    let visible = guest_list["data"]["agents"].as_array().unwrap();
    assert_eq!(visible.len(), 6, "{guest_list}");
    for (name, number) in [
        ("ada", "a1"),
        ("bob", "a2"),
        ("cy", "a3"),
        ("dan", "a4"),
        ("eve", "a5"),
    ] {
        let address = format!("{number}@{host}");
        let row = visible.iter().find(|row| row["id"] == address).unwrap();
        assert_eq!(
            (row["name"].as_str(), row["type"].as_str()),
            (Some(name), Some("managed"))
        );
        assert_eq!(row["cli"], "fake", "{row}");
    }
    let guest_row = visible
        .iter()
        .find(|row| row["id"] == joined["address"])
        .unwrap();
    assert_eq!(guest_row["type"], "guest", "{guest_row}");
    assert_eq!(guest_row["state"], "online", "{guest_row}");
    let roster = connect(&home).call_ok("agent.list", json!({}));
    let records = roster["agents"].as_array().unwrap();
    assert_eq!(records.len(), visible.len(), "{roster}");
    for mcp in visible {
        let row = records
            .iter()
            .find(|row| row["address"] == mcp["id"])
            .unwrap();
        for key in ["name", "type", "cli"] {
            assert_eq!(row[key], mcp[key], "{row}");
        }
        assert_eq!(
            row["reference"]["machine_id"], joined["reference"]["machine_id"],
            "{row}"
        );
        assert_eq!(
            row["reference"]["agent_id"].as_str(),
            mcp["id"]
                .as_str()
                .and_then(|address| address.split_once('@').map(|(id, _)| id)),
            "{row}"
        );
    }
    let restricted = ada.call("list_agents", json!({}));
    assert_eq!(restricted["status"], "success", "{restricted}");
    let mut names: Vec<&str> = restricted["data"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["ada", "cy", "eve"], "{restricted}");
}

/// Refused calls to an unrelated peer agent leave its run, inbox and saved connection intact.
#[test]
fn a_refused_peer_action_preserves_the_run_inbox_files_and_saved_route() {
    let home = TestHome::new("yolo-peer-local");
    let peer = TestHome::new("yolo-peer-remote");
    settings(&home, r#"{"yolo": false}"#);
    settings(&peer, r#"{"yolo": true}"#);
    let caller = home.start_fake("caller");
    let worker = peer.start_fake("worker");
    let peer_id = peer.hello_result().unwrap()["machine_id"]
        .as_str()
        .unwrap()
        .to_owned();
    peer.run_facade_ok(&["machine", "rename", &peer_id, "denial-peer"]);
    let address = format!("{}@denial-peer", worker.id);
    install_machine_ssh(
        &[("caller", &home), ("denial-peer", &peer)],
        &test_binaries().facade,
    );
    home.run_facade_ok(&[
        "machine",
        "add",
        "--home",
        peer.path.to_str().unwrap(),
        "denial-peer",
    ]);
    assert!(
        home.run_facade_ok(&["screen", &address])
            .contains("fakecli")
    );

    let route = || {
        let roster = connect(&home).call_ok("machine.list", json!({}));
        let machines = roster["machines"].as_array().unwrap();
        let remote = machines
            .iter()
            .find(|row| row["machine_id"] == peer_id)
            .unwrap();
        let saved = machines
            .iter()
            .flat_map(|row| row["connections"].as_array().unwrap())
            .find(|link| link["kind"] == "saved" && link["machine_id"] == peer_id)
            .unwrap();
        (remote["route"].clone(), saved.clone())
    };
    let saved_route = route();
    assert_eq!(saved_route.0, json!([peer_id]));
    assert_eq!(saved_route.1["state"], "connected");

    let run = facade_rules::run_folder(&peer.path.join("core/runs"), &worker.id).unwrap();
    let files = [
        home.path.join("facade.json"),
        peer.path.join("facade.json"),
        run.join("mcp.json"),
    ];
    let contents = files.each_ref().map(|path| std::fs::read(path).unwrap());
    peer.run_facade_ok(&["send", &address, "already delivered"]);
    peer.run_facade_ok(&["type", &address, "keep this draft"]);
    assert!(wait_for_screen_text(&peer, &address, "❯ keep this draft"));
    let mut inbox = McpTestClient::open_configured(&peer, &worker.id);
    let inbox_contents = |inbox: &mut McpTestClient| {
        let reply = inbox.call("read_messages", json!({ "last": 10 }));
        assert_eq!(reply["status"], "success", "{reply}");
        reply["data"]["messages"].clone()
    };
    let messages = inbox_contents(&mut inbox);
    assert_eq!(messages.as_array().unwrap().len(), 1, "{messages}");
    assert_eq!(messages[0]["text"], "already delivered", "{messages}");
    let submitted = peer.submitted_messages();
    let reference = peer.inspect_agent(&address)["agent"]["reference"].clone();

    let mut mcp = McpTestClient::open_configured(&home, &caller.id);
    for (tool, args) in [
        ("read_screen", json!({ "agent": address })),
        (
            "type_text",
            json!({ "agent": address, "text": "refused input", "enter": true }),
        ),
        (
            "send_message",
            json!({ "to": address, "text": "refused message" }),
        ),
        ("stop_agent", json!({ "agent": address })),
    ] {
        let refused = mcp.call(tool, args);
        assert_eq!(refused["reason"], "refused", "{tool}: {refused}");
    }

    assert_eq!(route(), saved_route);
    for (path, before) in files.iter().zip(contents) {
        assert!(
            std::fs::read(path).unwrap() == before,
            "{} changed",
            path.display()
        );
    }
    let agents = peer.agents();
    assert_eq!(agents.len(), 1, "{agents:?}");
    assert_eq!(agents[0]["reference"], reference);
    assert_eq!(agents[0]["process"], "running");
    assert_eq!(process_identity(worker.pid), worker.process);
    assert!(alive(&worker.process) && alive(&caller.process));
    assert_eq!(inbox_contents(&mut inbox), messages);
    assert_eq!(peer.submitted_messages(), submitted);
    assert!(
        home.run_facade_ok(&["screen", &address])
            .contains("❯ keep this draft")
    );
}

/// A guest, an MCP connection that no managed agent's CLI made, joined at its first tool call:
/// it, its roster, and its record.
fn guest(home: &TestHome) -> (McpTestClient, Value, Value) {
    let mut guest = McpTestClient::spawn(home, home.command(&test_binaries().mcp));
    let roster = guest.call("list_agents", json!({}));
    let address = roster["data"]["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["type"] == "guest"))
        .and_then(|agent| agent["id"].as_str())
        .unwrap_or_else(|| panic!("the connection is no guest: {roster}"))
        .to_string();
    let id = address.split_once('@').unwrap().0.to_string();
    let record = home.agent_record(&id).expect("the guest's record");
    (guest, roster, record)
}

/// A guest takes `yolo` from the settings file as it joins, for its reach alone (Core Review's
/// N25): with it off, the guest's tools reach only the tree it heads, and refuse any other agent as
/// out of it; with it on, every agent. A guest keeps the YOLO it joined with for its connection,
/// across a restart of the daemon too; and one that joins while the file cannot be read reaches
/// only its own tree.
#[test]
fn a_guest_takes_yolo_from_the_settings_file_as_it_joins_for_its_reach() {
    let home = TestHome::new("yologuest");
    home.start_named_fake("bob", &[]);
    settings(&home, r#"{"yolo": false}"#);
    let (mut off, listed, joined) = guest(&home);
    assert_eq!(
        (&joined["type"], &joined["yolo"], &joined["root"]),
        (&json!("guest"), &json!(false), &joined["reference"]),
        "{joined}"
    );
    assert_eq!(
        listed["data"]["agents"].as_array().map(Vec::len),
        Some(1),
        "{listed}"
    );
    let refused = off.call("read_screen", json!({ "agent": "a1" }));
    assert_eq!(refused["reason"], "refused", "{refused}");
    settings(&home, r#"{"yolo": true}"#);
    let (mut on, all, joined_on) = guest(&home);
    assert_eq!(joined_on["yolo"], true, "{joined_on}");
    assert_eq!(
        all["data"]["agents"].as_array().map(Vec::len),
        Some(3),
        "{all}"
    );
    assert_eq!(
        on.call("read_screen", json!({ "agent": "a1" }))["status"],
        "success"
    );
    let off_id = joined["reference"]["agent_id"].as_str().unwrap();
    assert_eq!(
        home.agent_record(off_id).unwrap()["yolo"],
        false,
        "the YOLO it joined with"
    );
    assert_eq!(
        off.call("read_screen", json!({ "agent": "a1" }))["reason"],
        "refused"
    );
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    assert_eq!(
        off.call("read_screen", json!({ "agent": "a1" }))["reason"],
        "refused",
        "its connection keeps the YOLO it joined with"
    );
    assert_eq!(home.agent_record(off_id).unwrap()["yolo"], false);
    settings(&home, r#"{"yolo": "yes"}"#);
    let (_unread, _, unread) = guest(&home);
    assert_eq!(
        unread["yolo"], false,
        "a file that cannot be read gives a guest only its own tree"
    );
}

/// A resume is a new launch: it reads `yolo` from the settings file as it is then, not the run's
/// before, and a file that cannot be read refuses it, as it refuses a start.
#[test]
fn a_resume_reads_yolo_from_the_settings_file_as_a_start_does() {
    const SESSION: &str = "2f6c0f0e-6a87-4b3d-9d1e-5f0b1e2c3d4a";
    let home = TestHome::new("yoloresume");
    let first = home.start_named_fake("worker", &[("FAKECLI_SESSION", SESSION)]);
    assert!(wait_until(secs(10), || record(&home, "worker")
        .get("session")
        .and_then(Value::as_str)
        == Some(SESSION)));
    assert_eq!(record(&home, "worker")["yolo"], true);
    let stopped = connect(&home).call_ok(
        "agent.stop",
        json!({ "selection": { "kind": "targets", "targets": [first.id] } }),
    );
    assert_eq!(stopped["items"][0]["status"], "stopped", "{stopped}");
    let resume = || {
        home.command(&test_binaries().facade)
            .env("PATH", home.path_with_test_programs())
            .args(["resume", "-d", "worker"])
            .stdin(Stdio::null())
            .output()
    };
    settings(&home, r#"{"yolo": 0}"#);
    let refused = resume().unwrap();
    assert!(
        !refused.status.success()
            && stderr(&refused).contains(":1:2: yolo must be true or false; received number"),
        "{}",
        stderr(&refused)
    );
    settings(&home, r#"{"yolo": false}"#);
    let resumed = resume().unwrap();
    assert!(
        resumed.status.success(),
        "{}{}",
        stdout(&resumed),
        stderr(&resumed)
    );
    assert_eq!(
        (
            &record(&home, "worker")["yolo"],
            &record(&home, "worker")["process"]
        ),
        (&json!(false), &json!("running"))
    );
}

#[cfg(unix)]
/// A stand-in for Claude Code 2.1.322 in `bin`: it asks its question about trusting the folder as
/// Claude Code does, behind a hidden cursor. It draws the question, its selection on the answer
/// that refuses, asks the terminal for its attributes, and draws the question again 150 ms after
/// the reply, its selection reset; the keys that came before then are lost, and it writes them to
/// `lost` in `keys`. Then it writes each key it takes to a file there: Down to `down`, then, its
/// selection moved to the answer that trusts, Enter to `enter`. Answered, it does as `answered`
/// says, then asks once more, and writes what it takes then to `again`.
fn claude_asking(bin: &Path, keys: &Path, answered: Answered) {
    std::fs::create_dir_all(bin).unwrap();
    std::fs::create_dir_all(keys).unwrap();
    let question = r"printf '\033[2J\033[H\033[?25l Accessing workspace:\r\n\r\n /work/probe\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n %sNo, exit\r\n %sYes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel' ";
    // Asked once more, the question is drawn over the screen. The shell writes it a line at a time:
    // on a cleared screen, a question that stays on would be off the screen until its line came, as
    // `Answered::Redrawn` makes it on purpose.
    let again = question.replacen(r"\033[2J", "", 1);
    let keys = keys.display();
    let after = match answered {
        Answered::Leaves => format!(
            r"printf '\033[2J\033[H\033[?25h trusted\r\n'; while [ ! -e '{keys}/ask' ]; do sleep 0.05; done"
        ),
        Answered::Draws => format!(
            r"printf '\033[2J\033[H\033[?25h trusted\r\n'; i=0; while [ ! -e '{keys}/ask' ]; do printf '\r working %d ' $i; i=$((i+1)); sleep 0.1; done"
        ),
        Answered::Stays => "sleep 1".to_string(),
        Answered::Redrawn => r"sleep 1; printf '\033[2J\033[H'; sleep 0.3".to_string(),
    };
    let script = format!(
        "#!/bin/sh\nstty raw -echo\n{question}'❯ ' '  '\nprintf '\\033[c'\nwhile [ \"$(dd bs=1 \
         count=1 2>/dev/null)\" != c ]; do :; done\n\
         sleep 0.15\nstty min 0 time 0\ndd bs=64 count=1 of='{keys}/lost' 2>/dev/null\nstty min 1 \
         time 0\n\
         {question}'❯ ' '  '\ndd bs=1 count=3 of='{keys}/down' 2>/dev/null\n{question}'  ' '❯ '\n\
         dd bs=1 count=1 of='{keys}/enter' 2>/dev/null\n\
         {after}\n{again}'❯ ' '  '\ndd bs=1 count=1 of='{keys}/again' 2>/dev/null\n\
         exec sleep 600\n"
    );
    install_script(bin, "claude", &script);
}

#[cfg(unix)]
/// What the stand-in for Claude Code does once its question is answered, before it asks once more.
#[derive(Clone, Copy)]
enum Answered {
    /// It clears the question, and asks once more when the test writes `ask` in its key folder.
    Leaves,
    /// It clears the question and draws a line every 100 ms, as a CLI working on a prompt does,
    /// until the test writes `ask` in its key folder; then it asks once more.
    Draws,
    /// It keeps the question on, and asks once more a second later, over it.
    Stays,
    /// It keeps the question on, and asks once more a second later on a cleared screen, drawing the
    /// question 0.3 s after the clear: the frame read in two parts, as a loaded machine can read
    /// it.
    Redrawn,
}

#[cfg(unix)]
/// What the stand-in wrote to its key file `name`, or None before it opened it.
fn key(keys: &Path, name: &str) -> Option<Vec<u8>> {
    std::fs::read(keys.join(name)).ok()
}

/// A run with YOLO on answers Claude Code's question about trusting the folder once, as a person
/// would, each key once the screen is still, as Claude Code 2.1.322 loses the keys that come before
/// it draws its question again: Down, then Enter once the selection shows on the answer that
/// trusts, and nothing when it comes back. The question is answered once no read has shown it for a
/// second, even while the CLI keeps drawing; one that stays on is left to the person, even when it
/// is drawn again on a cleared screen, which shows no question for a moment. A run with YOLO off
/// types nothing: the question waits for the person.
// Its stand-in is a sh script that reads keys, which MSYS sh under a pseudo console does not get.
#[cfg(unix)]
#[test]
fn claude_code_s_trust_question_is_answered_once_with_yolo_on_and_left_to_the_person_with_yolo_off()
{
    let home = TestHome::new("yolotrust");
    let base = home.project.parent().unwrap().to_path_buf();
    // Each run has a stand-in of its own: a shell reads its script as it runs it.
    let start = |wire: &mut DaemonTestClient, name: &str, answered: Answered| {
        let (bin, keys) = (
            base.join(format!("bin-{name}")),
            base.join(format!("keys-{name}")),
        );
        claude_asking(&bin, &keys, answered);
        let path = format!("{}{PATH_SEPARATOR}{}", bin.display(), SYSTEM_PATH.as_str());
        let args = json!({
            "cli": "claude", "name": name, "folder": home.project,
            "env": { "PATH": path, "FACADE_HOME": home.path }, "size": { "cols": 80, "rows": 24 },
        });
        assert!(wire.call("agent.start", args)["result"].is_object());
        keys
    };
    let typed = |keys: &[u8]| keys.windows(3).any(|key| key == b"\x1b[B") || keys.contains(&b'\r');
    let on_keys = start(&mut connect(&home), "on", Answered::Leaves);
    assert!(
        wait_until(LOADED_TIMEOUT, || key(&on_keys, "enter")
            .is_some_and(|key| !key.is_empty())),
        "{}",
        home.screen("on")
    );
    let lost = key(&on_keys, "lost").unwrap();
    assert!(
        !typed(&lost),
        "no key before the question was drawn again: {lost:?}"
    );
    assert_eq!(
        (
            key(&on_keys, "down").unwrap(),
            key(&on_keys, "enter").unwrap()
        ),
        (b"\x1b[B".to_vec(), b"\r".to_vec())
    );
    let answered =
        "#a1: its CLI's question about trusting the launch's folder was answered, as YOLO is on";
    assert!(
        wait_until(LOADED_TIMEOUT, || home.daemon_log().contains(answered)),
        "{}",
        home.daemon_log()
    );
    std::fs::write(on_keys.join("ask"), "").unwrap();
    assert!(
        wait_until(LOADED_TIMEOUT, || key(&on_keys, "again").is_some()),
        "the question came back: {}",
        home.screen("on")
    );
    std::thread::sleep(secs(2));
    assert_eq!(
        key(&on_keys, "again"),
        Some(Vec::new()),
        "the question coming back is the person's"
    );
    settings(&home, r#"{"yolo": false}"#);
    let off_keys = start(&mut connect(&home), "off", Answered::Leaves);
    let waiting = wait_until(LOADED_TIMEOUT, || {
        record(&home, "off")["state"] == "waiting_for_you"
    });
    assert!(waiting, "{}", record(&home, "off"));
    std::thread::sleep(secs(3));
    assert_eq!(
        key(&off_keys, "down"),
        Some(Vec::new()),
        "nothing is typed with YOLO off"
    );
    settings(&home, r#"{"yolo": true}"#);
    let stays_keys = start(&mut connect(&home), "stays", Answered::Stays);
    assert!(
        wait_until(LOADED_TIMEOUT, || key(&stays_keys, "enter")
            .is_some_and(|key| !key.is_empty())),
        "{}",
        home.screen("stays")
    );
    let left = "#a3: its CLI's question about trusting the launch's folder was not answered: it \
                stayed on the screen after its answer, so it \
                was left to the person";
    assert!(
        wait_until(LOADED_TIMEOUT, || home.daemon_log().contains(left)),
        "{}",
        home.daemon_log()
    );
    // The stand-in asks again a second after its answer, which a loaded machine can make later than
    // the daemon's note.
    assert!(
        wait_until(LOADED_TIMEOUT, || key(&stays_keys, "again").is_some()),
        "the question came back: {}",
        home.screen("stays")
    );
    std::thread::sleep(secs(2));
    assert_eq!(
        key(&stays_keys, "again"),
        Some(Vec::new()),
        "nothing more is typed for a question that stays on"
    );
    assert!(
        !home
            .daemon_log()
            .contains("#a3: its CLI's question about trusting the launch's folder was answered")
    );
    // Drawn again on a cleared screen, the question is off it for 0.3 s: not long enough to count
    // as gone.
    let redrawn_keys = start(&mut connect(&home), "redrawn", Answered::Redrawn);
    assert!(
        wait_until(LOADED_TIMEOUT, || key(&redrawn_keys, "enter")
            .is_some_and(|key| !key.is_empty())),
        "{}",
        home.screen("redrawn")
    );
    let left = left.replace("#a3", "#a4");
    assert!(
        wait_until(LOADED_TIMEOUT, || home.daemon_log().contains(&left)),
        "{}",
        home.daemon_log()
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || key(&redrawn_keys, "again").is_some()),
        "the question came back: {}",
        home.screen("redrawn")
    );
    std::thread::sleep(secs(2));
    assert_eq!(
        key(&redrawn_keys, "again"),
        Some(Vec::new()),
        "nothing more is typed for a question drawn again"
    );
    assert!(
        !home
            .daemon_log()
            .contains("#a4: its CLI's question about trusting the launch's folder was answered")
    );
    // A CLI that keeps drawing once its question left, as one working on a prompt does, was
    // answered all the same.
    let draws_keys = start(&mut connect(&home), "draws", Answered::Draws);
    assert!(
        wait_until(LOADED_TIMEOUT, || key(&draws_keys, "enter")
            .is_some_and(|key| !key.is_empty())),
        "{}",
        home.screen("draws")
    );
    let answered = answered.replace("#a1", "#a5");
    assert!(
        wait_until(LOADED_TIMEOUT, || home.daemon_log().contains(&answered)),
        "{}",
        home.daemon_log()
    );
    std::fs::write(draws_keys.join("ask"), "").unwrap();
    assert!(
        !home.daemon_log().contains(
            "#a5: its CLI's question about trusting the launch's folder was not answered"
        )
    );
}

/// What the rule of each of the six CLIs adds with YOLO on, as its stand-in records its arguments
/// after the rule's launch arguments: `${folder}` stands for the launch's folder.
fn yolo_arguments(cli: &str) -> &'static [&'static str] {
    match cli {
        "claude" => &["--dangerously-skip-permissions"],
        "codex" => &[
            "--dangerously-bypass-approvals-and-sandbox",
            "-c",
            "projects={ \"${folder}\" = { trust_level = \"trusted\" } }",
        ],
        "agy" => &["--mode", "accept-edits", "--dangerously-skip-permissions"],
        "muse" => &[
            "--disable-approval",
            "--disable-sandbox",
            "--trust-workspace",
        ],
        "opencode" => &["--auto"],
        _ => &["--approve"],
    }
}

/// How many arguments each CLI's rule gives every launch of it, before YOLO's.
fn launch_arguments(cli: &str) -> usize {
    if matches!(cli, "codex" | "opencode") {
        1
    } else {
        0
    }
}

/// The run settings a stand-in was given, where it was: their JSON, or the run's file that holds
/// them.
fn run_settings(args: &[String]) -> Option<Value> {
    let at = args.iter().position(|arg| arg == "--settings")?;
    let given = &args[at + 1];
    let text = match given.starts_with('{') {
        true => given.clone(),
        false => std::fs::read_to_string(given).ok()?,
    };
    facade_scenarios::serde_json::from_str(&text).ok()
}

/// Each of the six CLIs launched with YOLO on runs without asking and trusts its folder by what its
/// rule says, and Claude Code and Antigravity take run settings for it; launched with YOLO off, it
/// gets none of it.
#[test]
fn each_cli_launches_with_yolo_on_as_its_rule_says_and_with_yolo_off_as_it_natively_runs() {
    let home = TestHome::new("yololaunches");
    let base = home.project.parent().unwrap().to_path_buf();
    let (bin, argv) = (base.join("bin"), base.join("argv"));
    let path = format!("{}{PATH_SEPARATOR}{}", bin.display(), SYSTEM_PATH.as_str());
    let launch = |cli: &str, name: &str| {
        stand_in(&bin, cli, &argv);
        let started = home
            .facade_in_an_empty_home()
            .env("PATH", &path)
            .args(["start", "-d", "--name", name, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{cli}: {}", stderr(&started));
        (
            arguments(&argv),
            record(&home, name)["cwd"].as_str().unwrap().to_string(),
        )
    };
    let clis = ["claude", "codex", "agy", "muse", "opencode", "pi"];
    for cli in clis {
        let (args, folder) = launch(cli, &format!("{cli}-on"));
        // Codex keys Windows projects by an ASCII-lowercase path. In TOML each backslash is escaped.
        #[cfg(unix)]
        let in_toml = folder.clone();
        #[cfg(windows)]
        let in_toml = folder.to_ascii_lowercase().replace('\\', "\\\\");
        let at = launch_arguments(cli);
        let added: Vec<String> = yolo_arguments(cli)
            .iter()
            .map(|arg| arg.replace("${folder}", &in_toml))
            .collect();
        assert_eq!(
            args.get(at..at + added.len()),
            Some(added.as_slice()),
            "{cli}: {args:?}"
        );
        let settings = run_settings(&args);
        match cli {
            "claude" => assert_eq!(
                settings.as_ref().map(|settings| (
                    &settings["skipDangerousModePermissionPrompt"],
                    &settings["sandbox"]
                )),
                Some((&json!(true), &json!({ "enabled": false })))
            ),
            "agy" => assert_eq!(
                settings.map(|settings| (
                    settings["trustedWorkspaces"].clone(),
                    settings["enableTerminalSandbox"].clone()
                )),
                Some((json!([folder]), json!(false)))
            ),
            _ => {}
        }
    }
    settings(&home, r#"{"yolo": false}"#);
    for cli in clis {
        let (args, _) = launch(cli, &format!("{cli}-off"));
        assert!(
            !args.iter().any(|arg| arg == yolo_arguments(cli)[0]),
            "{cli}: {args:?}"
        );
        let settings = run_settings(&args).unwrap_or_default();
        assert!(
            settings.get("skipDangerousModePermissionPrompt").is_none()
                && settings.get("sandbox").is_none(),
            "{cli}: {settings}"
        );
        assert!(
            settings.get("trustedWorkspaces").is_none()
                && settings.get("enableTerminalSandbox").is_none(),
            "{cli}: {settings}"
        );
    }
}
