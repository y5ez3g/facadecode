//! A guest's server: `facade-mcp --guest <cli>`, in a CLI's user configuration, serves the sessions
//! of that CLI the person starts, each tool call acting for the session it names, which joins as a
//! guest first.

use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// The record of the agent that has `session`.
fn with_session(home: &TestHome, session: &str) -> Option<Value> {
    let listed: Value =
        facade_scenarios::serde_json::from_str(&stdout(&home.run_facade(&["list", "--json"])))
            .ok()?;
    listed["agents"]
        .as_array()?
        .iter()
        .find(|agent| agent["session"] == session)
        .cloned()
}

/// A server that serves many sessions, as Codex's and OpenCode's do, acts for the session each call
/// names in its `_meta`: the session joins as a guest at its first call, and a message sent then
/// comes from it. A message to a guest waits for its next turn, which the send says at once. A call
/// that names no session does nothing.
#[test]
fn a_guest_server_acts_for_the_session_each_call_names() {
    let home = TestHome::new("guestserver");
    let mut wire = connect(&home);
    let host = start_script(&mut wire, &home, "host", "echo READY; sleep 60");
    let mut server = McpTestClient::open_guest(&home, "codex", &[]);
    assert!(
        server.initialized()["result"].get("instructions").is_none(),
        "Codex's session-start hook tells its model"
    );
    let listed = server.call_in("list_agents", json!({}), json!({ "sessionId": "codex-1" }));
    assert_eq!(listed["status"], "success", "{listed}");
    let guest = with_session(&home, "codex-1").expect("the session did not join at its first call");
    assert_eq!(
        (&guest["cli"], &guest["guest"]),
        (&json!("codex"), &json!(true))
    );
    server.call_in(
        "send_message",
        json!({ "to": host, "text": "from the session" }),
        json!({ "sessionId": "codex-1" }),
    );
    let mut reader = DaemonTestClient::open(&home);
    reader.hello("terminal", DAEMON_RANGE, json!({ "agent": host }));
    let inbox = reader.request("watch", json!({ "topic": "messages" }));
    assert_eq!(
        inbox["result"]["snapshot"]["messages"][0]["from"], guest["agent_id"],
        "{inbox}"
    );
    server.call_in(
        "list_agents",
        json!({}),
        json!({ "ai.opencode/sessionID": "codex-2" }),
    );
    assert!(
        with_session(&home, "codex-2").is_some_and(|other| other["agent_id"] != guest["agent_id"]),
        "each session is a guest of its own"
    );
    let to_guest = server.call_in(
        "send_message",
        json!({ "to": guest["agent_id"], "text": "from the other" }),
        json!({ "sessionId": "codex-2" }),
    );
    assert_eq!(
        (&to_guest["status"], &to_guest["data"]["delivery"]),
        (&json!("success"), &json!("waiting_in_inbox")),
        "{to_guest}"
    );
    let nameless = server.call("list_agents", json!({}));
    assert_eq!(nameless["status"], "failure", "{nameless}");
    assert!(
        nameless["message"]
            .as_str()
            .unwrap_or_default()
            .contains("names no session of codex"),
        "{nameless}"
    );
}

/// A server started for one session, as Claude Code, Pi and Muse Code start theirs, knows its
/// session from its environment: it joins as the server starts. Its session-start hook tells its
/// model its ID and instructions, so the server tells it nothing.
#[test]
fn a_guest_server_for_one_session_joins_it_as_it_starts() {
    let home = TestHome::new("guestserverone");
    connect(&home);
    let server = McpTestClient::open_guest(&home, "claude", &[("CLAUDE_CODE_SESSION_ID", "c1")]);
    assert!(
        server.initialized()["result"].get("instructions").is_none(),
        "{}",
        server.initialized()
    );
    assert_eq!(
        with_session(&home, "c1").expect("the session joined")["agent_id"],
        "a1"
    );
}

/// A guest's server serves whatever its variables and words: a variable that is not UTF-8, which
/// JSON cannot carry, is left out of the environment its session joins with, and a word that is not
/// UTF-8 is left aside.
#[cfg(unix)]
#[test]
fn a_guest_server_with_a_variable_or_a_word_that_is_not_utf8_serves() {
    use std::os::unix::ffi::OsStrExt;
    let home = TestHome::new("notutf8server");
    connect(&home);
    let not_utf8 = std::ffi::OsStr::from_bytes(b"caf\xe9");
    let server = |session: &str, word: Option<&std::ffi::OsStr>| {
        let mut command = home.command(&test_binaries().mcp);
        command
            .args(["--guest", "claude"])
            .args(word)
            .env("CLAUDE_CODE_SESSION_ID", session)
            .env("PATH", home.path_with_test_programs());
        if word.is_none() {
            command.env("NOT_UTF8", not_utf8);
        }
        McpTestClient::spawn(&home, command)
    };
    let mut with_variable = server("c1", None);
    assert!(with_session(&home, "c1").is_some(), "the session joined");
    let listed = with_variable.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    server("c2", Some(not_utf8));
    assert!(with_session(&home, "c2").is_some(), "the session joined");
}

/// OpenCode's model takes a guest's instructions from its server alone, so that server gives them,
/// and Facade's skill after them. The other guests' servers give neither: their session-start hook
/// gives both, so that each model is told once.
#[test]
fn an_opencode_guest_s_server_gives_the_skill_after_its_instructions() {
    let home = TestHome::new("guestskill");
    connect(&home);
    let told = |server: &McpTestClient| {
        server.initialized()["result"]["instructions"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };
    let opencode = McpTestClient::open_guest(&home, "opencode", &[]);
    let instructions = facade_base::instructions::for_guest(None);
    assert_eq!(
        told(&opencode),
        format!("{instructions}\n\n{}", facade_base::skill::text()),
        "the instructions, then the skill"
    );
    let claude = McpTestClient::open_guest(&home, "claude", &[("CLAUDE_CODE_SESSION_ID", "c1")]);
    assert!(
        claude.initialized()["result"].get("instructions").is_none(),
        "Claude Code's hook gives both: {}",
        told(&claude)
    );
}

/// Runs `facade hook <event> --cli <cli>` for `session`, as `cli`'s hook would, with `env`, and
/// returns what it printed.
fn guest_hook(
    home: &TestHome,
    cli: &str,
    event: &str,
    session: &str,
    env: &[(&str, &str)],
) -> String {
    let input = match cli {
        "agy" => json!({ "hookEventName": "SessionStart", "conversationId": session }),
        _ => json!({ "hook_event_name": "SessionStart", "session_id": session }),
    };
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", event, "--cli", cli])
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        input.to_string().as_bytes(),
    )
    .unwrap();
    stdout(&child.wait_with_output().unwrap())
}

/// Reports `session` as the session of `agent`'s run, as its CLI's session-start hook in the run
/// does.
fn report_run_session(home: &TestHome, agent: &str, session: &str) {
    let runs: Vec<_> = std::fs::read_dir(home.path.join("core/runs").join(agent))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", "session-start"])
        .arg(runs[0].join("session"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    let input = json!({ "hook_event_name": "SessionStart", "session_id": session });
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        input.to_string().as_bytes(),
    )
    .unwrap();
    assert!(child.wait().unwrap().success());
}

/// A session nested in a Facade run of its own CLI, as `claude -p` that the run's model starts,
/// inherits the run's `FACADE_AGENT` but is a guest of its own, on all six: its hooks join it, and
/// its guest server serves it. A run's own session is the one Facade records for the run: there the
/// hooks change nothing, Muse Code's guest entry serves the run, and Antigravity's steps aside for
/// the run's plugin, saying why. A server many sessions share, as OpenCode's background service
/// that a nested `opencode` started with the variable, serves each other session as a guest.
#[test]
fn a_session_nested_in_a_run_of_its_own_cli_is_a_guest_of_its_own() {
    let home = TestHome::new("nested");
    connect(&home);
    let folder = home.project.parent().unwrap().to_path_buf();
    let bin = folder.join("bin");
    let path = format!("{}{PATH_SEPARATOR}{}", bin.display(), SYSTEM_PATH.as_str());
    let tools = |server: &mut McpTestClient| {
        server.request("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .map_or(0, Vec::len)
    };
    for (index, cli) in ["claude", "codex", "opencode", "pi", "muse", "agy"]
        .into_iter()
        .enumerate()
    {
        stand_in(&bin, cli, &folder.join(format!("{cli}.argv")));
        let name = format!("{cli}run");
        let started = home
            .facade_in_an_empty_home()
            .env("PATH", &path)
            .args(["start", "--name", &name, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            started.status.success(),
            "{cli}: {}{}",
            stdout(&started),
            stderr(&started)
        );
        let run = home.agent_from_list_json(&name).expect("the run")["agent_id"]
            .as_str()
            .unwrap()
            .to_string();
        // A run's session is reported as its CLI names it: a UUID here.
        let (own, nested) = (
            format!("0000000{index}-0000-4000-8000-000000000001"),
            format!("0000000{index}-0000-4000-8000-000000000002"),
        );
        report_run_session(&home, &run, &own);
        assert!(
            wait_until(secs(10), || home
                .agent_from_list_json(&name)
                .is_some_and(|agent| agent["session"] == own)),
            "{cli}"
        );
        let in_run = [("FACADE_AGENT", run.as_str())];
        let nothing = if cli == "agy" { "{}\n" } else { "" };
        assert_eq!(
            guest_hook(&home, cli, "session-start", &own, &in_run),
            nothing,
            "{cli}: the run's own session"
        );
        assert_ne!(
            with_session(&home, &own).expect("the run")["guest"],
            true,
            "{cli}"
        );
        let told = guest_hook(&home, cli, "session-start", &nested, &in_run);
        assert!(told.contains("You are Facade guest #"), "{cli}: {told}");
        let variable = facade_rules::session_variable(cli).unwrap();
        let meta = json!({
            "sessionId": nested, "ai.opencode/sessionID": nested,
            "antigravity.google/root_conversation_id": nested,
        });
        let mut server =
            McpTestClient::open_guest(&home, cli, &[("FACADE_AGENT", &run), (variable, &nested)]);
        assert_eq!(tools(&mut server), 8, "{cli}: the nested session's server");
        let listed = server.call_in("list_agents", json!({}), meta);
        assert_eq!(listed["status"], "success", "{cli}: {listed}");
        assert_eq!(
            with_session(&home, &nested).expect("the nested guest")["guest"],
            true,
            "{cli}"
        );
        let mut in_own =
            McpTestClient::open_guest(&home, cli, &[("FACADE_AGENT", &run), (variable, &own)]);
        match cli {
            "muse" => {
                assert_eq!(
                    tools(&mut in_own),
                    8,
                    "Muse Code's guest entry serves the run's own session"
                );
                assert_eq!(in_own.call("list_agents", json!({}))["status"], "success");
            }
            "agy" => {
                assert_eq!(
                    tools(&mut in_own),
                    0,
                    "Antigravity's steps aside for the run's plugin"
                );
                let refused = in_own.call("list_agents", json!({}));
                assert!(
                    refused["message"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("has a server of its own"),
                    "{refused}"
                );
            }
            // Their runs never start the guest's entry: any session it serves is a guest's.
            _ => assert_eq!(tools(&mut in_own), 8, "{cli}"),
        }
        assert_ne!(
            with_session(&home, &own).expect("the run")["guest"],
            true,
            "{cli}: the run's own session stays the run's"
        );
    }
    // OpenCode's background service, started by a nested `opencode`, serves every later session
    // with the run's variable.
    let run = home.agent_from_list_json("opencoderun").unwrap()["agent_id"]
        .as_str()
        .unwrap()
        .to_string();
    let mut service = McpTestClient::open_guest(&home, "opencode", &[("FACADE_AGENT", &run)]);
    let later = service.call_in(
        "list_agents",
        json!({}),
        json!({ "ai.opencode/sessionID": "ses_later" }),
    );
    assert_eq!(later["status"], "success", "{later}");
    assert_eq!(
        with_session(&home, "ses_later").expect("a later session of the service")["guest"],
        true
    );
}

/// A guest's server reads its own CLI's session variable alone. Pi started from a Claude Code
/// session's shell has both CLIs' variables; its server serves Pi's session, and no guest joins for
/// the Claude Code session it runs under (Core Review's S11).
#[test]
fn a_guest_server_takes_its_own_cli_s_session_whatever_else_it_inherits() {
    let home = TestHome::new("guestownvar");
    connect(&home);
    let server = McpTestClient::open_guest(
        &home,
        "pi",
        &[
            ("CLAUDE_CODE_SESSION_ID", "claude-outer"),
            ("PI_SESSION_ID", "pi-inner"),
        ],
    );
    server.initialized();
    assert_eq!(
        with_session(&home, "pi-inner").expect("Pi's own session joined")["cli"],
        "pi"
    );
    assert!(
        with_session(&home, "claude-outer").is_none(),
        "a guest joined for the session Pi runs under"
    );
}

/// An agent started from a guest's shell gets none of the CLIs' session variables, so a `facade`
/// command in its terminal acts for it, not for the guest that started it (Core Review's S12): its
/// message comes from it. The command runs once the start has answered, when the helper is listed:
/// one that came before would be refused, as its sender would not be listed yet.
#[test]
fn a_started_agent_s_commands_act_for_it_not_for_the_guest_that_started_it() {
    let home = TestHome::new("guestinherit");
    let mut wire = connect(&home);
    let host = start_script(&mut wire, &home, "host", "echo READY; sleep 60");
    let mut server = McpTestClient::open_guest(&home, "opencode", &[]);
    server.call_in(
        "list_agents",
        json!({}),
        json!({ "ai.opencode/sessionID": "ses_guest" }),
    );
    let guest = with_session(&home, "ses_guest").expect("the session joined")["agent_id"].clone();
    let facade = sh_path(&test_binaries().facade);
    let script = format!(
        "env | grep -c _SESSION_ID; echo STARTED; read go; {facade} send {host} \
         from-the-helper; sleep 60"
    );
    let env = json!({
        "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path, "OPENCODE_SESSION_ID": "ses_guest",
        "CLAUDE_CODE_SESSION_ID": "c-x",
    });
    let args = json!({
        "command": [SH.as_str(), "-c", script], "name": "helper", "cwd": home.project, "env": env,
        "cols": 80, "rows": 24,
    });
    let started = wire.call("agent.start", args);
    let helper = started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"))
        .to_string();
    assert!(
        wait_for_screen_text(&home, "helper", "STARTED"),
        "{}",
        home.screen("helper")
    );
    assert!(
        home.screen("helper").starts_with("0\n"),
        "the helper kept a session variable: {}",
        home.screen("helper")
    );
    home.run_facade_ok(&["type", "helper", "--key", "Enter"]);
    let mut reader = DaemonTestClient::open(&home);
    reader.hello("terminal", DAEMON_RANGE, json!({ "agent": host }));
    let mut from = Value::Null;
    assert!(
        wait_until(secs(10), || {
            let inbox = reader.request("watch", json!({ "topic": "messages" }));
            reader.request("unwatch", json!({ "watch": inbox["result"]["watch"] }));
            from = inbox["result"]["snapshot"]["messages"][0]["from"].clone();
            !from.is_null()
        }),
        "no message reached the host: {}",
        home.screen("helper")
    );
    assert_eq!(
        from,
        json!(helper),
        "the helper's message came from {from}; the guest is {guest}"
    );
}

/// The environment of the process `pid` names, as the system has it.
fn environment_of(pid: u32) -> std::collections::BTreeMap<String, String> {
    let birth = facade_base::unix_process::birth(pid)
        .unwrap()
        .expect("the process runs");
    let identity = facade_base::process::ProcessIdentity { pid, birth };
    facade_base::unix_process::environment(&identity)
        .unwrap()
        .expect("its environment")
}

/// A guest's model starts an agent with `start_agent`, which runs with the environment the guest's
/// CLI gave: from a server of one session, the server's own, given as the session joins; from a
/// server many sessions share, the one the session-start hook gave (Core Review's M2), which a
/// subagent's session start leaves alone (N21). A guest whose CLI has given none is told so.
#[test]
fn a_guest_starts_an_agent_with_its_cli_s_environment() {
    let home = TestHome::new("gueststart");
    connect(&home);
    // A guest starts an agent at its own location, in the terminal window.
    let start = |server: &mut McpTestClient, session: &str, name: &str, meta: Value| {
        let path = with_session(&home, session).expect("the session joined")["cwd"].clone();
        let arguments = json!({ "name": name, "cli": "fake", "window": "terminal", "path": path });
        server.call_in("start_agent", arguments, meta)
    };
    let pid_of = |name: &str| -> u32 {
        let listed: Value =
            facade_scenarios::serde_json::from_str(&stdout(&home.run_facade(&["list", "--json"])))
                .unwrap();
        let agent = listed["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|agent| agent["name"] == name)
            .cloned()
            .expect("the agent is listed");
        agent["pid"].as_u64().expect("a pid") as u32
    };
    let mut claude = McpTestClient::open_guest(
        &home,
        "claude",
        &[("CLAUDE_CODE_SESSION_ID", "c1"), ("GUEST_MARK", "server")],
    );
    claude.initialized();
    let started = start(&mut claude, "c1", "first", Value::Null);
    assert_eq!(started["status"], "success", "{started}");
    assert_eq!(
        environment_of(pid_of("first"))
            .get("GUEST_MARK")
            .map(String::as_str),
        Some("server")
    );

    let mut hook = home.command(&test_binaries().facade);
    hook.args(["hook", "session-start", "--cli", "codex"])
        .env("GUEST_MARK", "hook");
    let mut child = hook
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        json!({ "hook_event_name": "SessionStart", "session_id": "x1" })
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    child.wait_with_output().unwrap();
    let mut subagent = home.command(&test_binaries().facade);
    subagent
        .args(["hook", "session-start", "--cli", "codex"])
        .env("GUEST_MARK", "subagent");
    let mut child = subagent
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let part = json!({
        "hook_event_name": "SessionStart", "session_id": "x1-sub", "parent_session_id": "x1",
    });
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        part.to_string().as_bytes(),
    )
    .unwrap();
    child.wait_with_output().unwrap();
    let mut codex = McpTestClient::open_guest(&home, "codex", &[("GUEST_MARK", "shared server")]);
    let started = start(&mut codex, "x1", "second", json!({ "sessionId": "x1" }));
    assert_eq!(started["status"], "success", "{started}");
    assert_eq!(
        environment_of(pid_of("second"))
            .get("GUEST_MARK")
            .map(String::as_str),
        Some("hook"),
        "the hook's, not the server's"
    );
}

/// A `facade-mcp` outside any Facade run and without `--guest`, as an MCP client that is none of
/// the CLIs runs it, joining as a member. Returns it and its record.
fn member(home: &TestHome) -> (McpTestClient, Value) {
    let member = McpTestClient::spawn(home, home.command(&test_binaries().mcp));
    let listed: Value =
        facade_scenarios::serde_json::from_str(&home.run_facade_ok(&["list", "--json"])).unwrap();
    let record = listed["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["guest"] == true)
        .cloned()
        .unwrap_or_else(|| panic!("the member is not listed: {listed}"));
    let id = record["agent_id"].as_str().unwrap();
    assert!(
        member.initialized()["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains(&format!("#{id}")),
        "it is told who it is"
    );
    (member, record)
}

/// Any MCP client becomes a member: it joins at initialize, is listed while its connection lasts,
/// reads the messages sent to it, and leaves with its relay.
#[test]
fn an_mcp_client_joins_as_a_member_reads_its_messages_and_leaves_with_its_relay() {
    let home = TestHome::new("member");
    let ada = home.start_named_fake("ada", &[]);
    let (mut member, record) = member(&home);
    let id = record["agent_id"].as_str().unwrap().to_string();
    let sent = McpTestClient::open(&home, &ada.id).call(
        "send_message",
        json!({ "to": format!("#{id}"), "text": "for the member" }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    let read = member.call("read_messages", json!({}));
    assert_eq!(
        read["data"]["messages"][0]["text"], "for the member",
        "{read}"
    );
    let (_, status) = member.close(secs(20));
    assert!(status.success(), "{status:?}");
    assert!(
        wait_until(secs(10), || !home
            .list_table()
            .column("ID")
            .contains(&id.as_str())),
        "the member stayed after its relay ended: {}",
        home.run_facade_ok(&["list"])
    );
}

/// A member outlasts the daemon: its relay reconnects to the next daemon, which knows it by the
/// same number, with the message that waited for it.
#[test]
fn a_member_and_what_waits_for_it_outlast_a_daemon_restart() {
    let home = TestHome::new("memberkept");
    let ada = home.start_named_fake("ada", &[]);
    let (mut member, record) = member(&home);
    let id = record["agent_id"].as_str().unwrap().to_string();
    let sent = McpTestClient::open(&home, &ada.id).call(
        "send_message",
        json!({ "to": format!("#{id}"), "text": "kept for the member" }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    let old = home.kill_daemon();
    assert!(
        wait_until(secs(10), || home
            .hello_result()
            .is_some_and(|hello| hello["pid"].as_i64() != Some(old as i64))),
        "no daemon took over"
    );
    let read = member.call("read_messages", json!({}));
    assert_eq!(
        read["data"]["messages"][0]["text"], "kept for the member",
        "{read}"
    );
    let kept = home.agent_from_list_json(record["name"].as_str().unwrap());
    assert_eq!(
        kept.as_ref()
            .map(|kept| (&kept["agent_id"], &kept["guest"])),
        Some((&json!(id), &json!(true))),
        "{kept:?}"
    );
}

/// A read delivers only the messages it returns: `last` takes the newest of the whole inbox, and
/// the rest stay to be read; a read of more than a page says where the next one starts.
#[test]
fn a_read_delivers_only_what_it_returns_and_last_is_the_newest() {
    let home = TestHome::new("memberread");
    let ada = home.start_named_fake("ada", &[]);
    let (mut member, record) = member(&home);
    let to = format!("#{}", record["agent_id"].as_str().unwrap());
    let mut sender = McpTestClient::open(&home, &ada.id);
    let mut send = |from: u32, to_number: u32| {
        for n in from..=to_number {
            let sent = sender.call(
                "send_message",
                json!({ "to": to, "text": format!("message {n}") }),
            );
            assert_eq!(sent["data"]["delivery"], "waiting_in_inbox", "{sent}");
        }
    };
    let mut read = |arguments: Value| {
        let read = member.call("read_messages", arguments);
        assert_eq!(read["status"], "success", "{read}");
        let texts: Vec<String> = read["data"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["text"].as_str().unwrap().to_string())
            .collect();
        (texts, read["data"].get("next_cursor").cloned())
    };
    let numbered = |numbers: std::ops::RangeInclusive<u32>| -> Vec<String> {
        numbers.map(|n| format!("message {n}")).collect()
    };

    send(1, 3);
    assert_eq!(read(json!({ "last": 1 })), (numbered(3..=3), None));
    assert_eq!(
        read(json!({})),
        (numbered(1..=2), None),
        "the older two wait"
    );
    assert_eq!(read(json!({})), (Vec::new(), None));

    send(4, 111);
    assert_eq!(read(json!({ "last": 1 })), (numbered(111..=111), None));
    let (first, next) = read(json!({}));
    assert_eq!(first, numbered(4..=103));
    let next = next.expect("a cursor for the next page");
    assert_eq!(read(json!({})), (numbered(104..=110), None));
    let (after, more) = read(json!({ "after": next }));
    assert_eq!((after, more), (numbered(104..=111), None));
}
