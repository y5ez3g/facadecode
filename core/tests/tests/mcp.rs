//! `facade-mcp`, run as an agent's CLI runs it: its tools against a real daemon, the result
//! envelope, and its own start and end. And how each CLI Facade starts is given the tools, and
//! whether it can use them.

use std::io::Write;
use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// A connection acting for `agent` that follows its inbox from an empty snapshot.
fn follow_inbox(home: &TestHome, agent: &str) -> (DaemonTestClient, u64) {
    let mut wire = DaemonTestClient::open(home);
    assert!(wire.hello("terminal", DAEMON_RANGE, json!({ "agent": agent }))["result"].is_object());
    let watching = wire.request("watch", json!({ "topic": "messages" }));
    assert_eq!(
        watching["result"]["snapshot"]["messages"],
        json!([]),
        "{watching}"
    );
    (wire, watching["result"]["watch"].as_u64().unwrap())
}

/// Waits until the inbox has `count` messages pending.
fn wait_for_pending(inbox: &DaemonTestClient, watch: u64, count: usize) -> bool {
    wait_until(secs(30), || {
        inbox
            .changes(watch)
            .iter()
            .filter(|changed| changed["change"]["message"]["delivery"]["status"] == "pending")
            .count()
            >= count
    })
}

fn type_draft(home: &TestHome, agent: &str, draft: &str) {
    home.run_facade_ok(&["type", agent, draft]);
    assert!(
        wait_until(secs(10), || home
            .screen(agent)
            .contains(&format!("❯ {draft}"))),
        "{}",
        home.screen(agent)
    );
}

/// Both accepted argument shorthands use the public limit and reject invalid batches before typing.
#[test]
fn press_keys_checks_normalized_batches_before_typing() {
    let home = TestHome::new("mcpkeys");
    let pressed = home.project.join("pressed");
    let agent = home.start_named_fake("ada", &[("FAKECLI_KEYS", pressed.to_str().unwrap())]);
    assert!(wait_for_screen_text(&home, &agent.id, "❯"));
    let mut client = McpTestClient::open(&home, &agent.id);

    let mut keys = vec!["界"];
    keys.extend(std::iter::repeat_n("A", 99));
    let arguments = json!({ "agent": agent.id, "keys": json!(keys).to_string() });
    let result = client.call("press_keys", arguments);
    assert_eq!(result["status"], "success", "{result}");

    let result = client.call("press_keys", json!({ "agent": agent.id, "keys": [] }));
    assert_eq!(result["reason"], "invalid_argument", "{result}");

    let too_many = json!(vec!["z"; 101]).to_string();
    let result = client.call("press_keys", json!({ "agent": agent.id, "keys": too_many }));
    assert_eq!(result["reason"], "invalid_argument", "{result}");
    assert!(
        result["message"].as_str().unwrap().contains("at most 100"),
        "{result}"
    );

    let result = client.call(
        "press_keys",
        json!({ "agent": agent.id, "keys": ["z", "eScApE"] }),
    );
    assert_eq!(result["reason"], "invalid_argument", "{result}");
    assert!(
        result["message"].as_str().unwrap().contains(r#"Use "Esc""#),
        "{result}"
    );

    let result = client.call("press_keys", json!({ "agent": agent.id, "keys": "eSc" }));
    assert_eq!(result["status"], "success", "{result}");
    let result = client.call(
        "press_keys",
        json!({ "agent": agent.id, "keys": ["ENTER"] }),
    );
    assert_eq!(result["status"], "success", "{result}");

    let mut expected = Vec::from("界".as_bytes());
    expected.extend_from_slice(&[b'A'; 99]);
    expected.extend_from_slice(b"\x1b\r");
    assert!(
        wait_until(secs(10), || std::fs::read(&pressed)
            .is_ok_and(|bytes| bytes == expected)),
        "{:?}",
        std::fs::read(&pressed)
    );
}

/// Messages whose text adds up to more than 8,000 characters are returned without it; their text is
/// in a file only this user can read, each message whole between lines naming it.
#[test]
fn a_long_read_puts_the_messages_in_a_file() {
    let home = TestHome::new("mcpfile");
    home.start_named_fake("ada", &[]);
    home.start_named_fake("bob", &[]);
    type_draft(&home, "ada", "hold");
    let (inbox, watch) = follow_inbox(&home, "a1");
    let mut bob = McpTestClient::open(&home, "a2");
    let long = ["x".repeat(5000), "y".repeat(5000)];
    for text in &long {
        bob.send(
            "tools/call",
            json!({ "name": "send_message", "arguments": { "to": "#a1", "text": text } }),
        );
    }
    assert!(wait_for_pending(&inbox, watch, 2));
    let mut ada = McpTestClient::open(&home, "a1");
    let read = ada.call("read_messages", json!({}));
    let path = std::path::PathBuf::from(read["data"]["file"].as_str().expect("a file"));
    assert!(
        path.starts_with(home.path.join("core/results"))
            || path.starts_with(
                facade_base::files::real_path(&home.path)
                    .unwrap()
                    .join("core/results")
            ),
        "{}",
        path.display()
    );
    // Only this user may read it: by its mode on Unix; on Windows by the home's permissions.
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions())
            & 0o777,
        0o600
    );
    let messages: Value =
        facade_scenarios::serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut texts: Vec<&str> = messages
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["text"].as_str().unwrap())
        .collect();
    // The two sends ran at once, so either text may have the lower number.
    texts.sort_unstable();
    assert_eq!(texts, [long[0].as_str(), long[1].as_str()]);
    assert_eq!(messages[0]["from"], "@bob #a2");
}

/// facade-mcp serves the agent Facade started it for; started outside a Facade run, it joins as a
/// member. At the end of its input it answers the calls still under way, then exits.
#[test]
fn facade_mcp_serves_its_agent_until_its_input_ends() {
    let home = TestHome::new("mcpends");
    home.start_facade_with(&[]);
    // Started outside a Facade run and without --guest, it joins as a member at initialize.
    let mut unconfigured = home
        .command(&test_binaries().mcp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let lines = [
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" },
        }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "list_agents", "arguments": {} },
        }),
    ];
    // As a client does, it waits for the answer to initialize before its other requests.
    let mut input = unconfigured.stdin.take().unwrap();
    let mut output = std::io::BufReader::new(unconfigured.stdout.take().unwrap());
    let mut written = String::new();
    input
        .write_all(format!("{}\n", lines[0]).as_bytes())
        .unwrap();
    std::io::BufRead::read_line(&mut output, &mut written).unwrap();
    for line in &lines[1..] {
        input.write_all(format!("{line}\n").as_bytes()).unwrap();
    }
    drop(input);
    std::io::Read::read_to_string(&mut output, &mut written).unwrap();
    assert!(unconfigured.wait().unwrap().success());
    let answers: Vec<Value> = written
        .lines()
        .map(|line| facade_scenarios::serde_json::from_str(line).unwrap())
        .collect();
    let answered = |id: u64| {
        answers
            .iter()
            .find(|answer| answer["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert!(
        answered(1)["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("#a1"),
        "it is told who it is: {answers:?}"
    );
    assert_eq!(
        answered(2)["result"]["tools"].as_array().map(Vec::len),
        Some(8)
    );
    assert_eq!(
        answered(3)["result"]["structuredContent"]["status"],
        "success"
    );

    let ada = home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open(&home, &ada.id);
    let ping = ada.send("ping", json!({}));
    let listed = ada.send(
        "tools/call",
        json!({ "name": "list_agents", "arguments": {} }),
    );
    let (answers, status) = ada.close(secs(20));
    assert!(status.success(), "{status:?}");
    let answered = |id: u64| {
        answers
            .iter()
            .find(|answer| answer["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(answered(ping)["result"], json!({}));
    assert_eq!(
        answered(listed)["result"]["structuredContent"]["data"]["agents"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
}

/// A long read whose file cannot be written returns the messages whole: the read delivered them, so
/// they must not be lost.
#[test]
fn a_long_read_whose_file_cannot_be_written_returns_the_messages_whole() {
    let home = TestHome::new("mcpnofile");
    home.start_named_fake("ada", &[]);
    home.start_named_fake("bob", &[]);
    type_draft(&home, "ada", "hold");
    let (inbox, watch) = follow_inbox(&home, "a1");
    let mut bob = McpTestClient::open(&home, "a2");
    let long = ["x".repeat(5000), "y".repeat(5000)];
    for text in &long {
        bob.send(
            "tools/call",
            json!({ "name": "send_message", "arguments": { "to": "#a1", "text": text } }),
        );
    }
    assert!(wait_for_pending(&inbox, watch, 2));
    // A file where the results folder goes: no result file can be written.
    std::fs::write(home.path.join("core/results"), "").unwrap();
    let read = McpTestClient::open(&home, "a1").call("read_messages", json!({}));
    assert_eq!(
        (&read["status"], read["data"].get("file")),
        (&json!("success"), None),
        "{read}"
    );
    let mut texts: Vec<&str> = read["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["text"].as_str())
        .collect();
    texts.sort_unstable();
    assert_eq!(texts, [long[0].as_str(), long[1].as_str()]);
}

/// A long screen comes whole in a text file only this user can read. A file error tells the caller
/// to ask for fewer lines.
#[test]
fn a_long_screen_comes_as_a_file() {
    let home = TestHome::new("mcpscreenfile");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "long",
        "for i in $(seq 1 120); do printf 'line %03d [%s]\\n' $i \
         'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done; echo READY; sleep 60",
    );
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let mut reader = McpTestClient::open(&home, &agent);
    let arguments = json!({ "agent": agent, "lines": 200 });
    let results = home.path.join("core/results");
    std::fs::write(&results, "").unwrap();
    let failed = reader.call("read_screen", arguments.clone());
    assert_eq!(failed["status"], "failure", "{failed}");
    assert_eq!(failed["reason"], "unavailable", "{failed}");
    assert!(
        failed["message"]
            .as_str()
            .is_some_and(|message| message.ends_with("; set 'lines' to a smaller number")),
        "{failed}"
    );
    std::fs::remove_file(results).unwrap();
    let read = reader.call("read_screen", arguments);
    assert!(
        read["data"].get("text").is_none() && read["data"]["ended"] == false,
        "{read}"
    );
    let path = std::path::PathBuf::from(read["data"]["file"].as_str().expect("a file"));
    // Only this user may read it: by its mode on Unix; on Windows by the home's permissions.
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions())
            & 0o777,
        0o600
    );
    let screen = std::fs::read_to_string(&path).unwrap();
    assert!(
        screen.starts_with("line 001 \\[xxx") && screen.contains("line 120 \\["),
        "{}",
        &screen[..40]
    );
}

/// A stop whose exit is not seen within the daemon's stop wait says the termination is unconfirmed:
/// the stop went out and goes on, so its effects are partial; the process state is unknown, and
/// list_agents shows how it ended once it did.
#[test]
fn a_stop_that_runs_out_of_time_says_its_termination_is_unconfirmed() {
    let home = TestHome::new("mcpstopwait");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-exit-reaches-agent")]);
    home.start_named_fake("ada", &[]);
    home.start_named_fake("helper", &[]);
    let mut ada = McpTestClient::open(&home, "a1");
    let stopped = ada.call("stop_agent", json!({ "agent": "helper" }));
    assert_eq!(stopped["reason"], "stop_unconfirmed", "{stopped}");
    home.release_gate("before-exit-reaches-agent");
    let ended = || ada.call("list_agents", json!({}))["data"]["agents"][1]["state"] == "ended";
    assert!(wait_until(secs(10), ended), "the stop went on");
}

/// A daemon that starts deletes the result files no one can use any more: a file of messages once
/// the first message in it is no longer kept, or whose name gives no message, and files of screens
/// older than thirty days. Other files stay.
#[test]
fn a_starting_daemon_deletes_result_files_no_one_can_use() {
    let home = TestHome::new("mcpcleanup");
    connect(&home);
    home.wait_for_idle_exit();
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    connection
        .execute(
            "INSERT INTO messages (number, \"from\", \"to\", text, at, status, text_written) \
             VALUES (1, 'human', 'a1', 'hi', ?1, 'failure', 'none')",
            [facade_base::time::iso_now()],
        )
        .unwrap();
    drop(connection);
    let results = home.path.join("core/results");
    facade_base::files::create_private_folder_all(&results).unwrap();
    let month = std::time::Duration::from_secs(31 * 24 * 60 * 60);
    for (name, age) in [
        (
            "messages-20261111T000000000Z-1-0.txt",
            std::time::Duration::ZERO,
        ),
        ("messages-m1-20261111T000000000Z-1-1.txt", month),
        (
            "messages-m9-20261111T000000000Z-1-2.txt",
            std::time::Duration::ZERO,
        ),
        ("screen-20261010T000000000Z-1-0.json", month),
        (
            "screen-20261111T000000000Z-1-1.json",
            std::time::Duration::ZERO,
        ),
        ("notes.txt", month),
    ] {
        std::fs::write(results.join(name), "x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(results.join(name))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - age)
            .unwrap();
    }
    connect(&home);
    let mut left: Vec<String> = std::fs::read_dir(&results)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort_unstable();
    assert_eq!(
        left,
        [
            "messages-m1-20261111T000000000Z-1-1.txt",
            "notes.txt",
            "screen-20261111T000000000Z-1-1.json"
        ],
        "a file of messages goes with its first message, whatever its age"
    );
}

/// A CLI started by its rule is given Facade's tools: the test CLI runs facade-mcp, whose
/// connection makes them available, and the run has a folder of its own. Once that server ends
/// while the CLI goes on, the tools are unavailable and the agent is an error, saying why.
#[test]
fn a_cli_started_by_its_rule_gets_facade_s_tools_while_their_server_is_connected() {
    let home = TestHome::new("mcpwired");
    home.start_named_fake("ada", &[]);
    home.start_named_fake("bob", &[]);
    let row = |home: &TestHome| home.agent_from_list_json("ada").unwrap();
    assert!(
        wait_until(secs(10), || row(&home)["tools_state"] == "available"),
        "{}",
        row(&home)
    );
    assert_eq!(
        std::fs::read_dir(home.path.join("core/runs/a1"))
            .unwrap()
            .count(),
        1,
        "a folder for the run"
    );
    let mut bob = McpTestClient::open(&home, "a2");
    home.run_facade_ok(&["type", "ada", "/fake mcp stop", "--enter"]);
    assert!(
        wait_until(secs(10), || row(&home)["tools_state"] == "unavailable"),
        "{}",
        row(&home)
    );
    let row = row(&home);
    assert_eq!(
        (&row["tools_reason"], &row["state"], &row["state_detail"]),
        (
            &json!("disconnected"),
            &json!("error"),
            &json!({ "reason": "tools_unavailable" })
        )
    );
    assert_eq!(
        bob.call("list_agents", json!({}))["data"]["agents"][0]["state"],
        "error"
    );
}

/// A prompt given to `facade start claude` stays its prompt: Claude Code's `--mcp-config` and
/// `--allowedTools` take every value up to the next option, so an option that takes one value comes
/// between them and the person's words.
#[test]
fn a_prompt_given_to_claude_stays_its_prompt() {
    let home = TestHome::new("claudeprompt");
    let folder = home.project.parent().unwrap().to_path_buf();
    let (bin, argv) = (folder.join("bin"), folder.join("argv"));
    stand_in(&bin, "claude", &argv);
    let path = format!("{}{PATH_SEPARATOR}{}", bin.display(), SYSTEM_PATH.as_str());
    let started = home
        .facade_in_an_empty_home()
        .env("PATH", &path)
        .args(["start", "claude", "fix the bug"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let args = arguments(&argv);
    let at = args
        .iter()
        .position(|arg| arg == "--allowedTools")
        .unwrap_or_else(|| panic!("{args:?}"));
    assert_eq!(args[at + 1], "mcp__facade", "{args:?}");
    assert!(
        args[at + 2].starts_with('-'),
        "the next word is an option: {args:?}"
    );
    assert_eq!(
        args.last().map(String::as_str),
        Some("fix the bug"),
        "{args:?}"
    );
}

/// `facade start --prompt` gives the agent its first message once its CLI's tools connected,
/// however long after the start that is, as its time to be delivered counts from then: the person's
/// words under a header naming them, as `facade send` sends them, and what was last said to the
/// agent.
#[test]
fn a_start_prompt_is_the_agent_s_first_message_once_its_tools_connected() {
    let home = TestHome::new("startprompt");
    let path = home.path_with_test_programs();
    let started = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .env("FAKECLI_MCP_DELAY_MS", "32000")
        .args(["start", "--prompt", "say hi", "--name", "ada", "fake"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    // The CLI starts its Facade server 32 seconds after its own start, past the 29.5 seconds a
    // message has to be delivered: the CLI shows its empty input while its tools connect.
    assert!(
        wait_until(secs(30), || home.screen("ada").contains("❯")),
        "{}",
        home.screen("ada")
    );
    std::thread::sleep(secs(25));
    assert_eq!(
        home.agent_from_list_json("ada").unwrap()["tools_state"],
        "connecting"
    );
    assert_eq!(
        home.submitted_messages(),
        Vec::<String>::new(),
        "the prompt waits for the tools"
    );
    assert!(
        wait_until(secs(30), || !home.submitted_messages().is_empty()),
        "{}",
        home.screen("ada")
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from #human · #m1\nsay hi"]
    );
    // What was said is recorded once the daemon has seen the CLI take the prompt, a moment after
    // the CLI logs it.
    let said = || {
        home.agent_from_list_json("ada")
            .is_some_and(|row| row["said"]["text"] == "say hi")
    };
    assert!(
        wait_until(secs(10), said),
        "{:?}",
        home.agent_from_list_json("ada")
    );
    let row = home.agent_from_list_json("ada").unwrap();
    assert_eq!(
        (
            &row["tools_state"],
            &row["said"]["text"],
            &row["said"]["from"]
        ),
        (&json!("available"), &json!("say hi"), &json!("human")),
        "{row}"
    );
    assert!(
        wait_until(secs(10), || home
            .daemon_log()
            .contains("#a1's start prompt, m1, was delivered")),
        "{}",
        home.daemon_log()
    );
}

/// A CLI's tools connect once its Facade server answered the CLI's `tools/list`, not its
/// `initialize`: while that answer is held, the tools read `connecting` and a start's prompt waits,
/// though the server answered `initialize`, which reads where the agent works.
#[test]
fn the_tools_connect_once_the_cli_has_asked_for_them() {
    let home = TestHome::new("toolslisted");
    let started = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .env("FACADE_TEST_GATES", "mcp-before-tools-list")
        .args(["start", "--prompt", "say hi", "--name", "ada", "fake"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    home.wait_for_gate("mcp-before-tools-list");
    assert!(
        wait_until(secs(30), || home.screen("ada").contains("❯")),
        "{}",
        home.screen("ada")
    );
    std::thread::sleep(secs(2));
    assert_eq!(
        home.agent_from_list_json("ada").unwrap()["tools_state"],
        "connecting"
    );
    assert_eq!(
        home.submitted_messages(),
        Vec::<String>::new(),
        "the prompt waits for the tools"
    );
    home.release_gate("mcp-before-tools-list");
    assert!(
        wait_until(secs(30), || !home.submitted_messages().is_empty()),
        "{}",
        home.screen("ada")
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from #human · #m1\nsay hi"]
    );
    assert_eq!(
        home.agent_from_list_json("ada").unwrap()["tools_state"],
        "available"
    );
}

/// A prompt given by `facade start` in an agent's terminal comes from that agent, as a
/// `facade send` there does, named as that agent is named when the prompt goes, though its terminal
/// ran the start before the agent was listed.
#[test]
fn a_start_prompt_from_an_agent_s_terminal_comes_from_that_agent() {
    let home = TestHome::new("startpromptfrom");
    home.start_facade_with(&[(
        "FACADE_TEST_GATES",
        "after-run-start-response,mcp-before-tools-list",
    )]);
    let mut wire = connect(&home);
    let (facade, path, log) = (
        test_binaries().facade.display().to_string(),
        home.path_with_test_programs(),
        home.fake_log.display().to_string(),
    );
    let script = format!(
        "FAKECLI_LOG='{log}' PATH='{path}' '{facade}' start --prompt 'from the boss' --name child \
         fake </dev/null; sleep 60"
    );
    let env = json!({ "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path });
    let args = json!({
        "command": [SH.as_str(), "-c", script], "name": "boss", "cwd": home.project, "env": env,
        "cols": 80, "rows": 24,
    });
    let starting = wire.send("call", json!({ "op": "agent.start", "args": args }));
    // The boss's start is held before it is listed, while its terminal starts the child, whose
    // Facade server is held as it answers the child's CLI's `tools/list`.
    home.wait_for_gate("after-run-start-response");
    home.wait_for_gate("mcp-before-tools-list");
    home.release_gate("after-run-start-response");
    let boss = wire
        .wait_for_response(starting, secs(30))
        .expect("the boss started")["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap()
        .to_string();
    home.release_gate("mcp-before-tools-list");
    assert!(
        wait_until(secs(30), || !home.submitted_messages().is_empty()),
        "{}",
        home.screen(&boss)
    );
    assert_eq!(
        home.submitted_messages(),
        [format!(
            "📨 Message from boss (#{boss}) · #m1\nfrom the boss"
        )]
    );
}

/// A prompt that could not be sent is refused before anything starts: one a message could not
/// carry, as one of more than 540 lines, whatever CLI it goes to, and one for a program that is no
/// CLI of facade.json, whose input Facade cannot read.
#[test]
fn a_start_prompt_that_could_not_be_sent_starts_nothing() {
    let home = TestHome::new("startpromptrefused");
    let path = home.path_with_test_programs();
    let lines = vec!["a line"; 600].join("\n");
    let not_a_cli = format!(
        "only a CLI of facade.json takes a prompt, as Facade reads its input to send it; {} is not \
         one",
        SH.as_str()
    );
    for (prompt, cli, said) in [
        (
            "  ",
            "fake",
            "the prompt cannot go as a message: text is blank",
        ),
        ("hi", SH.as_str(), not_a_cli.as_str()),
        (
            lines.as_str(),
            "agy",
            "the prompt cannot go as a message: text has 600 lines; a message carries at most 540",
        ),
    ] {
        let refused = home
            .command(&test_binaries().facade)
            .env("PATH", &path)
            .args(["start", "--prompt", prompt, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            !refused.status.success() && stderr(&refused).contains(said),
            "{cli}: {}",
            stderr(&refused)
        );
    }
    assert_eq!(home.agents(), Vec::<Value>::new(), "nothing started");
}

/// A Facade server that says hello before its agent is listed is refused, and tries again: once the
/// start lists the agent, its tools are there.
#[test]
fn a_server_refused_before_its_agent_is_listed_tries_again() {
    let home = TestHome::new("mcpearly");
    home.start_facade_with(&[("FACADE_TEST_GATES", "after-run-start-response")]);
    let mut start = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(["start", "--name", "ada", "fake"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    home.wait_for_gate("after-run-start-response");
    // The test CLI runs its server at once: it says hello while the start holds the agent's
    // listing.
    home.wait_for_gate("refused-mcp-hello");
    home.release_gate("after-run-start-response");
    assert!(start.wait().unwrap().success());
    let tools = || home.agent_from_list_json("ada").unwrap()["tools_state"].clone();
    assert!(
        wait_until(secs(10), || tools() == "available"),
        "{}",
        tools()
    );
}

/// A `facade` command acting for an agent sends its own environment: only a start from an agent's
/// Facade server takes that agent's. A command in a shell agent's terminal, whose environment macOS
/// would hide, starts an agent with a variable of its own.
#[test]
fn a_facade_command_in_an_agent_s_terminal_starts_with_its_own_environment() {
    let home = TestHome::new("terminalenv");
    let mut wire = connect(&home);
    let facade = test_binaries().facade.display().to_string();
    let path = home.path_with_test_programs();
    let script = format!(
        "PATH='{path}' FAKECLI_NAME='named by the command' '{facade}' start --name child fake \
         </dev/null; sleep 60"
    );
    let shell = start_script(&mut wire, &home, "shell", &script);
    assert!(
        wait_until(secs(30), || home.agent_from_list_json("child").is_some()),
        "{}",
        home.screen(&shell)
    );
    assert!(
        wait_until(secs(30), || home
            .screen("child")
            .contains("named by the command (Facade test CLI)")),
        "{}",
        home.screen("child")
    );
}

/// A Muse Code run gets Facade's server by `-c` for the run alone, with a hook that gives the model
/// its instructions, unless a project MCP file it reads names a `facade` server, beside which Muse
/// Code would refuse to run: then it starts without the tools, and the file stays as it is. A
/// stand-in `muse` keeps its arguments.
#[test]
fn a_muse_code_run_gets_its_server_by_c_unless_its_project_names_one() {
    let home = TestHome::new("museserver");
    let folder = home.project.parent().unwrap().to_path_buf();
    let argv = folder.join("argv");
    stand_in(&folder.join("bin"), "muse", &argv);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        folder.join("bin").display(),
        SYSTEM_PATH.as_str()
    );
    let start = |name: &str| {
        let started = home
            .facade_in_an_empty_home()
            .env("PATH", &path)
            .args(["start", "--name", name, "muse"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{}", stderr(&started));
        arguments(&argv)
    };
    let given = |args: &[String], key: &str| {
        args.iter().find_map(|arg| {
            arg.strip_prefix(&format!("{key}="))
                .map(|value| serde_json::from_str::<Value>(value).unwrap())
        })
    };
    let ada = start("ada");
    let server = given(&ada, "mcpServers.facade").unwrap_or_else(|| panic!("{ada:?}"));
    assert_eq!(
        (&server["mode"], &server["env"]["FACADE_AGENT"]),
        (&json!("optional"), &json!("${FACADE_AGENT}")),
        "{server}"
    );
    let hook = given(&ada, "hooks").unwrap();
    // On Windows the command is encoded PowerShell, its script `& '…' 'hook' 'instructions' 'muse'`.
    let command = hook["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    #[cfg(windows)]
    let command = powershell_script(command).unwrap_or_default();
    assert!(
        command.ends_with("hook instructions muse")
            || command.ends_with("'hook' 'instructions' 'muse'; exit $LASTEXITCODE"),
        "{hook}"
    );
    assert_eq!(
        home.agent_from_list_json("ada").unwrap()["tools_state"],
        "connecting"
    );

    let mine = r#"{ "mcpServers": { "facade": { "command": "mine" } } }"#;
    std::fs::write(home.project.join(".mcp.json"), mine).unwrap();
    let bob = start("bob");
    assert!(given(&bob, "mcpServers.facade").is_none(), "{bob:?}");
    // Its session is reported all the same: the run's session hook alone, without the tools' hooks.
    let hooks = given(&bob, "hooks").unwrap_or_else(|| panic!("{bob:?}"));
    assert_eq!(
        hooks.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["SessionStart"],
        "{hooks}"
    );
    let command = hooks["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    #[cfg(windows)]
    let command = powershell_script(command).unwrap_or_default();
    assert!(
        command.contains(" hook session-start ") || command.contains(" 'hook' 'session-start' "),
        "{hooks}"
    );
    let row = home.agent_from_list_json("bob").unwrap();
    assert_eq!(
        (&row["tools_state"], &row["tools_reason"]),
        (&json!("unavailable"), &json!("not_given")),
        "{row}"
    );
    assert_eq!(
        std::fs::read_to_string(home.project.join(".mcp.json")).unwrap(),
        mine
    );
}

/// A daemon that starts again lets go of the plugin of a folder whose Antigravity runs ended while
/// no daemon ran.
#[test]
fn a_daemon_that_starts_again_lets_go_of_a_plugin_whose_runs_ended_meanwhile() {
    let home = TestHome::new("agyrecover");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let started = home
        .facade_in_an_empty_home()
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .args(["start", "--name", "ada", "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let plugin = home.project.join(".agents/plugins/facade");
    assert!(plugin.join("mcp_config.json").exists());
    let pid = home.agent_from_list_json("ada").unwrap()["pid"]
        .as_i64()
        .unwrap() as i32;
    let old = home.kill_daemon();
    let cli = process_identity(pid);
    kill_process(pid);
    assert!(wait_until(secs(10), || !alive(&cli)), "the CLI ended");
    home.run_facade_ok(&["list"]);
    home.wait_for_daemon_after(old, secs(10))
        .expect("a daemon started again");
    assert!(
        wait_until(secs(10), || !home.project.join(".agents").exists()),
        "the plugin goes"
    );
}

/// A daemon that starts again lets go of the plugin of a folder whose Antigravity run ended while
/// the daemon before it could not let go of it: that daemon ended between the run's end and its
/// letting go.
#[test]
fn a_daemon_that_starts_again_lets_go_of_a_plugin_its_predecessor_kept() {
    let home = TestHome::new("agyleftover");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-plugin-let-go")]);
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let started = home
        .facade_in_an_empty_home()
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .args(["start", "--name", "ada", "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    assert!(
        home.project
            .join(".agents/plugins/facade/mcp_config.json")
            .exists()
    );
    home.run_facade_ok(&["stop", "ada"]);
    home.wait_for_gate("before-plugin-let-go");
    let old = home.kill_daemon();
    home.run_facade_ok(&["list"]);
    home.wait_for_daemon_after(old, secs(10))
        .expect("a daemon started again");
    assert!(
        wait_until(secs(10), || !home.project.join(".agents").exists()),
        "the plugin goes"
    );
}

/// An Antigravity run gets Facade's plugin in the folder it starts in, the only file Facade writes
/// into the person's project, and its start readies the tools through the CLI's MCP panel before
/// its first turn. The plugin's hook gives the model its instructions, and the plugin holds the
/// skill; the runs in a folder share the plugin, and it goes once the last of them ends. A plugin
/// of the person's own there is left as it is, and the run starts without the tools. The test CLI
/// draws Antigravity's screen.
#[test]
fn an_antigravity_run_gets_the_plugin_and_readies_its_tools_before_its_first_turn() {
    let home = TestHome::new("agyplugin");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let start = |name: &str| {
        let mut command = home.facade_in_an_empty_home();
        let started = command
            .env("PATH", &path)
            .env("FAKECLI_LOOK", "agy")
            .args(["start", "--name", name, "agy"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{}", stderr(&started));
    };
    let row = |name: &str| home.agent_from_list_json(name).unwrap();
    let plugin = home.project.join(".agents/plugins/facade");
    start("ada");
    let mut files: Vec<String> = std::fs::read_dir(&plugin)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort_unstable();
    assert_eq!(
        files,
        ["hooks.json", "mcp_config.json", "plugin.json", "skills"]
    );
    assert_eq!(
        std::fs::read_to_string(plugin.join("skills/facade/SKILL.md")).unwrap(),
        facade_base::skill::text(),
        "and the skill"
    );
    let servers: Value =
        serde_json::from_str(&std::fs::read_to_string(plugin.join("mcp_config.json")).unwrap())
            .unwrap();
    let launcher = home
        .path
        .join("core")
        .join("bin")
        .join(program_name("facade-mcp"))
        .display()
        .to_string();
    assert_eq!(
        servers["mcpServers"]["facade"]["command"],
        launcher.as_str(),
        "the plugin names the launcher"
    );
    let hooks: Value =
        serde_json::from_str(&std::fs::read_to_string(plugin.join("hooks.json")).unwrap()).unwrap();
    let hook = hooks["facade"]["PreInvocation"][0]["command"]
        .as_str()
        .unwrap_or_default();
    // Quoted for sh on Unix ('…'), and for cmd.exe on Windows (@"…").
    let program = hook.strip_suffix(" hook instructions agy").map(|program| {
        program
            .trim_start_matches('@')
            .trim_matches('"')
            .trim_matches('\'')
    });
    assert_eq!(
        program,
        Some(
            home.path
                .join("core")
                .join("bin")
                .join(program_name("facade"))
                .display()
                .to_string()
                .as_str()
        ),
        "and its hook: {hook}"
    );
    assert!(
        wait_until(secs(15), || row("ada")["tools_state"] == "available"),
        "{}",
        row("ada")
    );
    assert!(
        home.submitted_messages()
            .iter()
            .any(|message| message == "/mcp"),
        "the start opened the panel"
    );
    let input = || {
        serde_json::from_str::<Value>(&home.run_facade_ok(&["inspect", "ada", "--json"]))
            .unwrap()["input"]
            .clone()
    };
    assert!(
        wait_until(secs(15), || input()["state"] == "usable"),
        "the panel closed: {} {}",
        input(),
        home.screen("ada")
    );
    home.run_facade_ok(&["send", "ada", "hello"]);
    // The hook says where the agent works, as facade-mcp's instructions say it to the other CLIs.
    let instructions = |messages: Vec<String>| {
        messages.iter().any(|message| {
            message.starts_with("PreInvocation ")
                && message.contains("You are Facade agent #a1, working in ")
        })
    };
    assert!(
        wait_until(secs(10), || instructions(home.submitted_messages())),
        "{:?}",
        home.submitted_messages()
    );

    start("bob");
    home.run_facade_ok(&["stop", "ada"]);
    assert!(plugin.join("mcp_config.json").exists(), "bob's run uses it");
    home.run_facade_ok(&["stop", "bob"]);
    assert!(
        wait_until(secs(10), || !home.project.join(".agents").exists()),
        "the plugin goes with the folder's last run"
    );

    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("plugin.json"), r#"{"name":"mine"}"#).unwrap();
    start("carol");
    let carol = row("carol");
    assert_eq!(
        (&carol["tools_state"], &carol["tools_reason"]),
        (&json!("unavailable"), &json!("not_given")),
        "{carol}"
    );
    assert_eq!(
        std::fs::read_to_string(plugin.join("plugin.json")).unwrap(),
        r#"{"name":"mine"}"#
    );
    assert_eq!(
        std::fs::read_dir(&plugin).unwrap().count(),
        1,
        "nothing written beside it"
    );
}

/// An Antigravity run's first turn has Facade's tools. Keys the person types in an attached
/// terminal while the start readies them, through a panel that shows them ready two seconds late,
/// wait until that is done, then go in.
#[test]
fn keys_typed_while_an_antigravity_start_readies_its_tools_wait_for_it() {
    let home = TestHome::new("agyhold");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let mut command = home.facade_in_an_empty_home();
    command
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .env("FAKECLI_PANEL_DELAY_MS", "2000");
    let started = command
        .args(["start", "--name", "ada", "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", "ada"]),
        80,
        24,
    );
    term.send(b"hello\r");
    assert!(
        wait_until(secs(30), || home
            .submitted_messages()
            .iter()
            .any(|message| message == "hello")),
        "{:?}",
        home.submitted_messages()
    );
    let messages = home.submitted_messages();
    assert_eq!(
        messages.first().map(String::as_str),
        Some("/mcp"),
        "the start went first: {messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|message| message == "turn without Facade's server"),
        "the first turn had the tools: {messages:?}"
    );
    assert!(
        wait_until(
            secs(10),
            || home.agent_from_list_json("ada").unwrap()["tools_state"] == "available"
        ),
        "{}",
        home.agent_from_list_json("ada").unwrap()
    );
}

/// A start prompt to Antigravity goes once its start readied its tools, through a panel that shows
/// them ready two seconds late, so that the prompt's turn has them.
#[test]
fn a_start_prompt_to_antigravity_goes_once_its_tools_are_ready() {
    let home = TestHome::new("agyprompt");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let mut command = home.facade_in_an_empty_home();
    command
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .env("FAKECLI_PANEL_DELAY_MS", "2000");
    let started = command
        .args(["start", "--prompt", "say hi", "--name", "ada", "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let prompt = "📨 Message from #human · #m1\nsay hi";
    assert!(
        wait_until(secs(30), || home
            .submitted_messages()
            .iter()
            .any(|message| message == prompt)),
        "{:?}",
        home.submitted_messages()
    );
    let messages = home.submitted_messages();
    assert_eq!(
        messages.first().map(String::as_str),
        Some("/mcp"),
        "the start readied the tools first: {messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|message| message == "turn without Facade's server"),
        "the prompt's turn had the tools: {messages:?}"
    );
}

/// Runs `facade hook <hook> <cli>` as the CLI's hook would, with `input` on standard input and the
/// variables `env`, and returns what it printed.
fn run_hook(home: &TestHome, hook: &str, cli: &str, input: &str, env: &[(&str, &str)]) -> String {
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", hook, cli])
        .env_remove("MUSE_SESSION_ID")
        .envs(env.iter().copied());
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success() && output.stderr.is_empty(),
        "{output:?}"
    );
    String::from_utf8(output.stdout).unwrap()
}

/// The hook that gives the model of a CLI that shows it no server's instructions those its run's
/// start wrote in the run's folder: Muse Code's to the session the run starts alone, not to one a
/// subagent starts, followed by the skill there, and Antigravity's to each invocation, whose plugin
/// holds the skill. Outside an agent's run, or without its run's files, it gives none.
#[test]
fn the_instructions_hook_gives_the_run_s_own_session_its_agent_s_instructions() {
    let home = TestHome::new("instructionshook");
    let starts =
        |session: &str| format!(r#"{{"hook_event_name":"SessionStart","session_id":"{session}"}}"#);
    let run = [("FACADE_AGENT", "a3"), ("MUSE_SESSION_ID", "s1")];
    assert_eq!(
        run_hook(&home, "instructions", "muse", &starts("s1"), &run),
        "",
        "no files of the run's"
    );
    // The run's folder, as its start wrote it.
    let folder = home.path.join("core/runs/a3/5a1f00d1c0ffee00");
    std::fs::create_dir_all(folder.join("skills/facade")).unwrap();
    let (instructions, skill) = (
        "You are Facade agent #a3, as your run began.",
        "The skill of the build that started the run.",
    );
    std::fs::write(folder.join("instructions.md"), instructions).unwrap();
    std::fs::write(folder.join("skills/facade/SKILL.md"), skill).unwrap();
    let given: Value = serde_json::from_str(&run_hook(
        &home,
        "instructions",
        "muse",
        &starts("s1"),
        &run,
    ))
    .unwrap();
    assert_eq!(
        given["hookSpecificOutput"]["hookEventName"], "SessionStart",
        "{given}"
    );
    assert_eq!(
        given["hookSpecificOutput"]["additionalContext"],
        format!("{instructions}\n\n{skill}"),
        "the instructions, then the skill"
    );
    for (input, env) in [
        (starts("s2"), &run[..]),
        (starts("s1"), &run[1..]),
        (
            r#"{"hook_event_name":"Stop","session_id":"s1"}"#.to_string(),
            &run[..],
        ),
        ("{not json".to_string(), &run[..]),
    ] {
        assert_eq!(
            run_hook(&home, "instructions", "muse", &input, env),
            "",
            "{input} {env:?}"
        );
    }
    let given: Value =
        serde_json::from_str(&run_hook(&home, "instructions", "agy", "{}", &run[..1])).unwrap();
    assert_eq!(
        given["injectSteps"][0]["ephemeralMessage"], instructions,
        "the instructions alone"
    );
    assert_eq!(run_hook(&home, "instructions", "agy", "{}", &[]), "{}");
}

/// The instructions Muse Code's and Antigravity's runs take from their hook, which their start
/// wrote, say where the run's agent works, as facade-mcp's instructions say it to the other CLIs:
/// its folder, its window by name and ID, and its location (Core Review's S15), then who started it
/// and what its run's YOLO reaches.
#[test]
fn the_instructions_hook_says_where_the_run_s_agent_works() {
    let home = TestHome::new("instructionsplace");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let starts = r#"{"hook_event_name":"SessionStart","session_id":"s1"}"#;
    for cli in ["muse", "agy"] {
        install_program(&programs, cli, &test_binaries().fakecli);
        let mut command = home.facade_in_an_empty_home();
        match cli {
            "agy" => command.env("FAKECLI_LOOK", "agy"),
            _ => command.env(
                "FAKECLI_MCP",
                home.path
                    .join("core")
                    .join("bin")
                    .join(program_name("facade-mcp")),
            ),
        };
        let started = command
            .env("PATH", &path)
            .args(["start", "--name", cli, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{cli}: {}", stderr(&started));
        let record = home.agent_from_list_json(cli).expect("the agent is listed");
        let id = record["agent_id"].as_str().unwrap();
        let place = format!(
            "You are Facade agent #{id}, working in {} in window \"Terminal\" (window terminal).",
            record["cwd"].as_str().unwrap(),
        );
        let run = [("FACADE_AGENT", id), ("MUSE_SESSION_ID", "s1")];
        let given: Value = serde_json::from_str(&run_hook(
            &home,
            "instructions",
            cli,
            if cli == "muse" { starts } else { "{}" },
            &run,
        ))
        .unwrap();
        let told = given["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .or(given["injectSteps"][0]["ephemeralMessage"].as_str())
            .unwrap_or_default();
        let started_by = format!("{place} Your creator is the person (#human). These tools");
        assert!(
            told.starts_with(&started_by)
                && told.contains(" Your run has YOLO on, so they reach every agent. "),
            "{cli}: {told}"
        );
    }
}

/// The hook that approves Facade's own tools where Muse Code would ask the person: a call of a tool
/// of Facade's server, with or without the run's variables, which Muse Code passes to no hook. Any
/// other tool is left to Muse Code.
#[test]
fn the_approve_hook_approves_facade_s_own_tools_alone() {
    let home = TestHome::new("approvehook");
    let asks = |tool: &str| {
        format!(
            r#"{{"hook_event_name":"PermissionRequest","session_id":"s1","tool_name":"{tool}","tool_input":{{}}}}"#
        )
    };
    let run = [("FACADE_AGENT", "a3")];
    let allowed = json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" },
        },
    });
    for env in [&run[..], &[][..]] {
        let given: Value = serde_json::from_str(&run_hook(
            &home,
            "approve",
            "muse",
            &asks("mcp__facade__send_message"),
            env,
        ))
        .unwrap();
        assert_eq!(given, allowed, "{env:?}");
    }
    for (input, env) in [
        (asks("mcp__other__send_message"), &run[..]),
        (asks("shell"), &run[..]),
        (
            asks("mcp__facade__send_message").replace("PermissionRequest", "PreToolUse"),
            &run[..],
        ),
        ("{not json".to_string(), &[][..]),
    ] {
        assert_eq!(
            run_hook(&home, "approve", "muse", &input, env),
            "",
            "{input} {env:?}"
        );
    }
}

/// A daemon that replaces another finds the tools there again: the CLI's server connects to it at
/// once.
#[test]
fn a_daemon_that_replaces_another_finds_the_tools_there_again() {
    let home = TestHome::new("mcpreconnect");
    let agent = home.start_named_fake("ada", &[]);
    let started = std::time::Instant::now();
    let mut polls = Vec::new();
    let tools = |home: &TestHome, polls: &mut Vec<Value>, phase: &str| {
        let begin = reconnect_time(started);
        let record = home.agent_from_list_json("ada").unwrap();
        let state = record["tools_state"].clone();
        polls.push(json!({ "phase": phase, "begin": begin,
            "end": reconnect_time(started), "record": record }));
        state
    };
    assert!(
        wait_until(secs(10), || tools(&home, &mut polls, "initial")
            == "available"),
        "{}",
        tools(&home, &mut polls, "initial failure value")
    );
    // This read precedes the kill; it is not the kill instant or proof of what recovery reads.
    let before_kill = reconnect_state(&home, &agent, started);
    let kill_begin = reconnect_time(started);
    let old = home.kill_daemon();
    let kill_end = reconnect_time(started);
    let replacement_begin = reconnect_time(started);
    let replacement = home
        .wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    let replacement_end = reconnect_time(started);
    let available = wait_until(secs(10), || {
        tools(&home, &mut polls, "replacement") == "available"
    });
    if !available {
        // Freeze the original assertion's extra tools() read before any late diagnostic reads.
        let failure = format!("{}", tools(&home, &mut polls, "original failure value"));
        let diagnostic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reconnect_diagnostics(
                &home,
                &agent,
                started,
                json!({
                    "agent_id": agent.id, "agent_pid": agent.pid, "polls": polls,
                    "before_kill": before_kill,
                    "kill": { "begin": kill_begin, "end": kill_end, "returned_old_pid": old },
                    "replacement": { "begin": replacement_begin, "end": replacement_end,
                        "hello_returned_new_pid": replacement },
                    "original_failure": failure,
                    "limits": "pre-kill sampling window, not kill instant or recovery input; sampling affects scheduling; late inspect is current public state",
                }),
            );
        }));
        if diagnostic.is_err() {
            let _ = writeln!(
                std::io::stderr(),
                "MCP reconnect diagnostics unavailable: diagnostic panicked"
            );
        }
        assert!(available, "{failure}");
    }
}

/// UTC epoch and monotonic times share the case's origin, without a clock/hash dependency.
fn reconnect_time(started: std::time::Instant) -> Value {
    let utc = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(time) => json!(time.as_nanos().to_string()),
        Err(error) => json!({ "unavailable": error.to_string() }),
    };
    json!({ "utc_unix_ns": utc, "monotonic_elapsed_ns": started.elapsed().as_nanos().to_string() })
}

/// One open and one read of this agent's state, with metadata from that same handle. No default facts.
fn reconnect_state(home: &TestHome, agent: &TestAgent, started: std::time::Instant) -> Value {
    let begin = reconnect_time(started);
    let file = home.path.join("core/screens").join(&agent.id).join("state");
    let mut raw = Vec::new();
    let mut metadata = json!({ "unavailable": "state was not opened" });
    let error = match std::fs::File::open(&file) {
        Ok(mut handle) => {
            metadata = match handle.metadata() {
                Ok(metadata) => {
                    json!({ "len": metadata.len(), "handle_metadata": format!("{metadata:?}") })
                }
                Err(error) => json!({ "unavailable": error.to_string() }),
            };
            std::io::Read::read_to_end(&mut handle, &mut raw)
                .err()
                .map(|error| error.to_string())
        }
        Err(error) => Some(error.to_string()),
    };
    json!({ "file": file, "begin": begin, "end": reconnect_time(started),
        "metadata": metadata, "len": raw.len(), "raw_bytes": raw, "unavailable": error })
}

/// Only the reconnect case's second failed wait calls this; its original assertion still decides failure.
fn reconnect_diagnostics(
    home: &TestHome,
    agent: &TestAgent,
    started: std::time::Instant,
    mut evidence: Value,
) {
    evidence["diagnostic_begin"] = reconnect_time(started);
    let deadline = std::time::Instant::now() + secs(2);
    evidence["public"] = json!({ "hello": { "unavailable": "not connected" },
        "inspect": { "unavailable": "no successful diagnostic hello" } });
    if let Some(mut wire) = DaemonTestClient::try_open(home) {
        for (label, method, params) in [
            (
                "hello",
                "hello",
                json!({ "protocol": DAEMON_RANGE, "build": "test", "kind": "terminal" }),
            ),
            (
                "inspect",
                "call",
                json!({ "op": "agent.inspect", "args": { "agent": agent.id } }),
            ),
        ] {
            let begin = reconnect_time(started);
            let response = if std::time::Instant::now() < deadline {
                wire.try_send(method, params).and_then(|id| {
                    wire.wait_for_response(
                        id,
                        deadline.saturating_duration_since(std::time::Instant::now()),
                    )
                })
            } else {
                None
            };
            let answered = response
                .as_ref()
                .is_some_and(|response| response.get("result").is_some());
            evidence["public"][label] = json!({ "begin": begin, "end": reconnect_time(started),
                "response": response.unwrap_or_else(|| json!({ "unavailable": "send failed or shared 2s response deadline expired" })) });
            if label == "hello" && !answered {
                break;
            }
        }
    }
    evidence["after_failure"] = reconnect_state(home, agent, started);
    for (label, file) in [
        ("daemon.log", home.path.join("core/logs/daemon.log")),
        ("keeper.log", home.path.join("core/logs/keeper.log")),
        ("fake.log", home.fake_log.clone()),
    ] {
        let begin = reconnect_time(started);
        evidence["logs"][label] = match std::fs::read_to_string(&file) {
            Ok(text) => {
                json!({ "file": file, "begin": begin, "end": reconnect_time(started), "text": text })
            }
            Err(error) => {
                json!({ "file": file, "begin": begin, "end": reconnect_time(started), "unavailable": error.to_string() })
            }
        };
    }
    evidence["diagnostic_end"] = reconnect_time(started);
    // TestHome::drop removes folder(), so its unique sibling survives without KEEP or other cases' data.
    let package = home.folder().with_file_name(format!(
        "{}-reconnect-diagnostics",
        home.folder().file_name().unwrap().to_string_lossy()
    ));
    evidence["package"] = json!(package);
    let output = format!("{evidence:#}");
    let write = std::fs::create_dir(&package)
        .and_then(|()| std::fs::write(package.join("diagnostics.json"), &output));
    if let Err(error) = write {
        let _ = writeln!(
            std::io::stderr(),
            "MCP reconnect diagnostic package unavailable: {error}"
        );
    }
    let _ = writeln!(
        std::io::stderr(),
        "MCP reconnect failure diagnostics:\n{output}"
    );
}

/// A start from facade-mcp gets its agent's environment, read from that agent's CLI, whatever the
/// CLI gives its MCP server: here nothing but FACADE_HOME and FACADE_AGENT. A creator whose
/// environment cannot be read starts nothing.
#[test]
fn an_agent_started_through_facade_mcp_gets_its_creator_s_environment() {
    let home = TestHome::new("mcpenv");
    home.start_named_fake("boss", &[("FAKECLI_NAME", "named by the boss")]);
    let mut boss = McpTestClient::open_stripped(&home, "a1");
    let cwd = home.agent_from_list_json("boss").unwrap()["cwd"]
        .as_str()
        .unwrap()
        .to_string();
    let start =
        |name: &str| json!({ "name": name, "cli": "fake", "window": "terminal", "path": cwd });
    // A CLI calls its tools once it runs.
    assert!(wait_until(secs(10), || home
        .agent_from_list_json("boss")
        .is_some_and(|boss| boss["process"] == "running")));
    let started = boss.call("start_agent", start("helper"));
    assert_eq!(started["status"], "success", "{started}");
    assert!(
        wait_until(secs(30), || home
            .screen("helper")
            .contains("named by the boss (Facade test CLI)")),
        "{}",
        home.screen("helper")
    );
    home.run_facade_ok(&["stop", "boss"]);
    let ended = boss.call("start_agent", start("late"));
    assert!(
        ended["message"].as_str().unwrap().contains(
            "#a1's environment is unavailable: its CLI is not running; nothing was started"
        ),
        "{ended}"
    );
    #[cfg(target_os = "macos")]
    {
        // Either report is right: whether macOS lets the environment of its own programs, such as
        // the shell and `sleep`, be read depends on the machine (SIP).
        let mut wire = connect(&home);
        let shell = start_script(&mut wire, &home, "shell", "sleep 60");
        let hidden =
            McpTestClient::open_stripped(&home, &shell).call("start_agent", start("hidden"));
        let message = hidden["message"].as_str().unwrap();
        assert!(
            message.contains("the environment read from its CLI has no FACADE_AGENT")
                || message.contains("was not found on the PATH of a terminal"),
            "{hidden}"
        );
    }
    assert!(
        home.agent_from_list_json("late").is_none()
            && home.agent_from_list_json("hidden").is_none(),
        "nothing more started"
    );
}

/// A daemon that ends during an Antigravity start, before its record was saved, leaves no plugin in
/// the project: the next daemon lets go of the plugin that start placed, as its run folder named it
/// before the plugin went there, whether it ended right after placing it or after the keeper
/// started the run, which the next daemon stops and removes.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn an_antigravity_start_cut_before_its_record_leaves_no_plugin() {
    for (point, keeper) in [("after-plugin-placed", false), ("after-run-start", true)] {
        let home = TestHome::new("agyhalf");
        let own = home.project.parent().unwrap().join("home");
        std::fs::create_dir_all(&own).unwrap();
        let programs = home.project.parent().unwrap().join("programs");
        std::fs::create_dir_all(&programs).unwrap();
        install_program(&programs, "agy", &test_binaries().fakecli);
        let path = format!(
            "{}{PATH_SEPARATOR}{}",
            programs.display(),
            home.path_with_test_programs()
        );
        home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", point)]);
        let daemon = home
            .hello_result()
            .and_then(|hello| hello["pid"].as_i64())
            .unwrap() as i32;
        let mut wire = DaemonTestClient::open(&home);
        assert!(wire.hello("terminal", DAEMON_RANGE, json!({}))["result"].is_object());
        let env = json!({
            "PATH": path, "HOME": own, "XDG_CONFIG_HOME": own.join(".config"),
            "FACADE_HOME": home.path, "FAKECLI_LOOK": "agy",
        });
        let args = json!({
            "command": ["agy"], "name": "half", "cwd": home.project, "env": env, "cols": 80,
            "rows": 24,
        });
        wire.send("call", json!({ "op": "agent.start", "args": args }));
        assert!(
            wait_until(secs(15), || stopped(daemon)),
            "{point}: the daemon did not stop: {}",
            home.daemon_log()
        );
        let plugin = home.project.join(".agents/plugins/facade");
        assert!(
            plugin.join("mcp_config.json").exists(),
            "{point}: the start placed the plugin"
        );
        kill_process(daemon);
        // The keeper replaces a daemon that ends once it runs the agent; before that, the next
        // command starts one.
        if keeper {
            home.wait_for_daemon_after(daemon, secs(30))
                .expect("a replacement daemon");
        } else {
            home.start_facade_with(&[]);
        }
        assert!(home.agents().is_empty(), "{point}: {:?}", home.agents());
        assert!(
            wait_until(secs(15), || !home.project.join(".agents").exists()),
            "{point}: the plugin stays: {}",
            home.daemon_log()
        );
    }
}

/// The calls whose responses a golden file records, each with its response. What differs from one
/// run to the next is written as a placeholder: the test's folder, the location IDs of its project
/// and its Facade home, the build's version, and each time in Facade's form.
struct Golden {
    cases: serde_json::Map<String, Value>,
    /// Texts that differ from run to run, longest first, each with what stands for it.
    placeholders: Vec<(String, &'static str)>,
}

impl Golden {
    /// Responses given in `home`, whose runs work in its project and whose guests in its Facade home,
    /// where their servers start.
    fn new(home: &TestHome) -> Golden {
        let canonical =
            |path: &std::path::Path| facade_base::files::real_path(path).unwrap_or(path.into());
        let mut placeholders = Vec::new();
        for folder in [home.folder().to_path_buf(), canonical(home.folder())] {
            placeholders.push((folder.to_string_lossy().into_owned(), "<test>"));
        }
        for (folder, placeholder) in [
            (&home.project, "<project location>"),
            (&home.path, "<home location>"),
        ] {
            for path in [folder.clone(), canonical(folder)] {
                let location = facade_base::daemon::location_id(&path.to_string_lossy());
                placeholders.push((location, placeholder));
            }
        }
        placeholders.push((env!("CARGO_PKG_VERSION").to_string(), "<version>"));
        let hello = home.hello_result().expect("the golden test's daemon");
        let machine = hello["machine_id"].as_str().expect("the machine ID");
        let selector = facade_base::address::exact_machine_selector(machine);
        home.run_facade_ok(&["machine", "rename", &selector, "golden-host"]);
        placeholders.push((machine.to_string(), "<machine ID>"));
        placeholders.push((selector, "id:<compact machine ID>"));
        placeholders.push((
            facade_base::address::short_machine_id(machine),
            "<short machine ID>",
        ));
        placeholders.sort_by_key(|(text, _)| std::cmp::Reverse(text.len()));
        Golden {
            cases: serde_json::Map::new(),
            placeholders,
        }
    }

    /// Records `response` to `call` as case `case`.
    fn record(&mut self, case: &str, call: Value, response: &Value) {
        let recorded = self.with_placeholders(&json!({ "call": call, "response": response }));
        assert!(
            self.cases.insert(case.to_string(), recorded).is_none(),
            "case {case:?} is recorded twice"
        );
    }

    /// Calls `tool` with `arguments` and records its result envelope as case `case`.
    fn call(
        &mut self,
        client: &mut McpTestClient,
        case: &str,
        tool: &str,
        arguments: Value,
    ) -> Value {
        self.call_in(client, case, tool, arguments, Value::Null)
    }

    /// Calls `tool` with `arguments`, and with `meta` as its `_meta` unless it is null, as a CLI
    /// names a call's session there, and records its result envelope as case `case`.
    fn call_in(
        &mut self,
        client: &mut McpTestClient,
        case: &str,
        tool: &str,
        arguments: Value,
        meta: Value,
    ) -> Value {
        let envelope = client.call_in(tool, arguments.clone(), meta.clone());
        let mut call = json!({ "tool": tool, "arguments": arguments });
        if !meta.is_null() {
            call["_meta"] = meta;
        }
        self.record(case, call, &envelope);
        envelope
    }

    /// `value` with each placeholder in place of what it stands for, and each time in Facade's form
    /// as `<time>`. A time in any other form stays as it is, so that a change to the form shows.
    fn with_placeholders(&self, value: &Value) -> Value {
        match value {
            Value::Object(members) => Value::Object(
                members
                    .iter()
                    .map(|(name, member)| (name.clone(), self.with_placeholders(member)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| self.with_placeholders(item))
                    .collect(),
            ),
            Value::String(text) if is_facade_time(text) => json!("<time>"),
            Value::String(text) => Value::String(slashed_after_placeholders(
                &self
                    .placeholders
                    .iter()
                    .fold(text.clone(), |text, (varies, placeholder)| {
                        text.replace(varies.as_str(), placeholder)
                    }),
            )),
            other => other.clone(),
        }
    }

    /// Checks the recorded responses against `core/tests/golden/<name>`, after writing them there
    /// where `FACADE_REGENERATE` is set. The file holds each response's values with their keys in
    /// order.
    fn check(self, name: &str) {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("golden")
            .join(name);
        let cases = Value::Object(self.cases);
        let now = format!("{}\n", serde_json::to_string_pretty(&cases).unwrap());
        if std::env::var_os("FACADE_REGENERATE").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &now).unwrap();
        }
        // A checkout may turn the file's line endings into CRLF, as Git does on Windows.
        let recorded = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        if recorded == now {
            return;
        }
        let recorded: Value = serde_json::from_str(&recorded).unwrap_or_default();
        let differs = cases.as_object().unwrap().iter().find(|(case, response)| {
            recorded.get(case.as_str()).map(Value::to_string) != Some(response.to_string())
        });
        let how = match differs {
            Some((case, now)) => {
                format!(
                    "case {case:?}\nrecorded: {}\nnow:      {now}",
                    recorded[case]
                )
            }
            None => "its cases differ in number or order".to_string(),
        };
        panic!(
            "core/tests/golden/{name} differs: {how}\nWhere the change is meant, regenerate it: \
             FACADE_REGENERATE=1 cargo test -p facade-scenarios --test mcp golden_file_records"
        );
    }
}

/// Over a relay connection, a `send_message` its client cancels while its message waits is
/// withdrawn, and answered all the same, so that every request has one answer: MCP has the client
/// ignore it.
#[test]
fn a_send_cancelled_over_a_relay_connection_is_withdrawn_and_answered() {
    let home = TestHome::new("relaycancel");
    home.start_named_fake("worker", &[]);
    home.start_named_fake("boss", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch) = follow_inbox(&home, "a1");
    let mut boss = McpTestClient::relay(&home, &[], &[("FACADE_AGENT", "a2")]);
    let held = boss.send(
        "tools/call",
        json!({ "name": "send_message", "arguments": { "to": "#a1", "text": "held" } }),
    );
    assert!(
        wait_for_pending(&inbox, watch, 1),
        "{:?}",
        inbox.changes(watch)
    );
    let cancel = json!({
        "jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": { "requestId": held, "reason": "changed my mind" },
    });
    boss.write(&cancel.to_string());
    let answered = boss
        .answer(held, secs(10))
        .expect("the cancelled call's answer");
    assert_eq!(
        answered["error"],
        json!({ "code": -32800, "message": "the client cancelled this call; nothing was sent" }),
        "{answered}"
    );
    assert!(
        wait_until(secs(10), || home
            .daemon_log()
            .contains("withdrawn by its send's cancel")),
        "{}",
        home.daemon_log()
    );
}

/// The way a golden test reaches the MCP server: through the `facade-mcp` program, or straight to
/// the daemon's own server over a relay connection, as the relay reaches it. Both get the same
/// responses.
#[derive(Clone, Copy)]
enum Through {
    Program,
    Relay,
}

impl Through {
    /// The MCP server of `agent`.
    fn open(self, home: &TestHome, agent: &str) -> McpTestClient {
        match self {
            Through::Program => McpTestClient::open(home, agent),
            Through::Relay => McpTestClient::relay(home, &[], &[("FACADE_AGENT", agent)]),
        }
    }

    /// The server in `cli`'s own settings, `--guest <cli>`, with `env` in its environment.
    fn open_guest(self, home: &TestHome, cli: &str, env: &[(&str, &str)]) -> McpTestClient {
        match self {
            Through::Program => McpTestClient::open_guest(home, cli, env),
            Through::Relay => McpTestClient::relay(home, &["--guest", cli], env),
        }
    }
}

/// Waits until the tools of each agent `named` are there: its CLI's own server has answered its
/// `tools/list`, as the test CLI's does soon after it starts.
fn wait_for_tools(home: &TestHome, named: &[&str]) {
    for name in named {
        assert!(
            wait_until(secs(30), || home
                .agent_from_list_json(name)
                .is_some_and(|row| row["tools_state"] == "available")),
            "{name}'s tools: {:?}",
            home.agent_from_list_json(name)
        );
    }
}

/// `text` with each path that follows a placeholder, such as `<test>\project`, written with `/`, as
/// the golden files record it on every system. On Unix nothing changes.
fn slashed_after_placeholders(text: &str) -> String {
    if cfg!(unix) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut in_path = false;
    for c in text.chars() {
        match c {
            '>' => in_path = true,
            '\\' if in_path => {
                out.push('/');
                continue;
            }
            c if c.is_whitespace() || c == '"' || c == '\'' || c == ',' => in_path = false,
            _ => {}
        }
        out.push(c);
    }
    out
}

/// Whether `text` is a time as Facade writes one: UTC, with milliseconds, such as
/// `2026-11-14T21:41:37.642Z`. The form is written out here rather than read from Facade's own
/// code, so that a change to the form shows.
fn is_facade_time(text: &str) -> bool {
    const FORM: &str = "dddd-dd-ddTdd:dd:dd.dddZ";
    text.len() == FORM.len()
        && text
            .bytes()
            .zip(FORM.bytes())
            .all(|(byte, form)| match form {
                b'd' => byte.is_ascii_digit(),
                _ => byte == form,
            })
}

/// Each tool responds to its usual calls, and to the most common mistakes with it, as
/// `core/tests/golden/mcp-responses.json` records: each response's values, with their keys in
/// order, and the model's text reading as the same value as the structured result. Moving the tools
/// changes none of them; a change meant to a response regenerates the file in the same commit.
#[test]
fn each_tool_responds_as_its_golden_file_records() {
    each_tool_responds_as_recorded(Through::Program);
}

/// The daemon's own MCP server, reached over a relay connection, responds as `facade-mcp` does.
#[test]
fn each_tool_responds_through_a_relay_connection_as_its_golden_file_records() {
    each_tool_responds_as_recorded(Through::Relay);
}

fn each_tool_responds_as_recorded(through: Through) {
    let home = TestHome::new("mcpgolden");
    home.start_named_fake("ada", &[]);
    home.start_named_fake("bob", &[]);
    wait_for_tools(&home, &["ada", "bob"]);
    let cwd = home.agent_from_list_json("ada").unwrap()["cwd"].clone();
    let mut ada = through.open(&home, "a1");
    let mut golden = Golden::new(&home);
    golden.record(
        "initialize",
        json!({ "method": "initialize" }),
        &ada.initialized(),
    );
    let listed = ada.request("tools/list", json!({}));
    golden.record("tools/list", json!({ "method": "tools/list" }), &listed);

    golden.call(&mut ada, "list_agents", "list_agents", json!({}));
    golden.call(
        &mut ada,
        "start_agent",
        "start_agent",
        json!({ "name": "helper", "cli": "fake", "window": "terminal", "path": cwd }),
    );
    golden.call(
        &mut ada,
        "start_agent without a path",
        "start_agent",
        json!({ "name": "other", "cli": "fake", "window": "terminal" }),
    );
    golden.call(
        &mut ada,
        "start_agent of a CLI that is not configured",
        "start_agent",
        json!({ "name": "other", "cli": "nope", "window": "terminal", "path": cwd }),
    );

    golden.call(
        &mut ada,
        "send_message",
        "send_message",
        json!({ "to": "#a2", "text": "hello bob" }),
    );
    golden.call(
        &mut ada,
        "send_message without a recipient",
        "send_message",
        json!({ "text": "hello" }),
    );
    golden.call(
        &mut ada,
        "send_message to an agent that does not exist",
        "send_message",
        json!({ "to": "#a9", "text": "hello" }),
    );
    golden.call(
        &mut ada,
        "send_message to the person from the terminal window",
        "send_message",
        json!({ "to": "#human", "text": "bob has the task" }),
    );
    golden.call(
        &mut ada,
        "read_messages with nothing new",
        "read_messages",
        json!({}),
    );
    // Bob's reply waits behind Ada's draft until Ada reads it; the CLI gets bob's response whole.
    type_draft(&home, "ada", "my draft");
    let (inbox, watch) = follow_inbox(&home, "a1");
    let mut bob = through.open(&home, "a2");
    let reply = json!({
        "name": "send_message", "arguments": { "to": "@ada", "text": "hi ada", "reply_to": "#m1" },
    });
    let replying = bob.send("tools/call", reply.clone());
    assert!(
        wait_for_pending(&inbox, watch, 1),
        "{:?}",
        inbox.changes(watch)
    );
    golden.call(
        &mut ada,
        "read_messages of a message held back by a draft",
        "read_messages",
        json!({}),
    );
    let replied = bob
        .answer(replying, secs(40))
        .expect("bob's send is answered");
    golden.record(
        "tools/call",
        json!({ "method": "tools/call", "params": reply }),
        &replied,
    );
    home.run_facade_ok(&["type", "ada", "--key", "Ctrl+C"]);
    golden.call(
        &mut ada,
        "read_messages after a message",
        "read_messages",
        json!({ "after": "#m1" }),
    );
    golden.call(
        &mut ada,
        "read_messages of the last message",
        "read_messages",
        json!({ "last": 1 }),
    );

    assert!(
        wait_for_screen_text(&home, "helper", "❯"),
        "{}",
        home.screen("helper")
    );
    golden.call(
        &mut ada,
        "type_text",
        "type_text",
        json!({ "agent": "@helper", "text": "hello there", "enter": true }),
    );
    golden.call(
        &mut ada,
        "type_text to an agent that does not exist",
        "type_text",
        json!({ "agent": "#a9", "text": "hello" }),
    );
    golden.call(
        &mut ada,
        "type_text with empty text and enter",
        "type_text",
        json!({ "agent": "@helper", "text": "", "enter": true }),
    );
    golden.call(
        &mut ada,
        "type_text with a control character",
        "type_text",
        json!({ "agent": "@helper", "text": "before\u{1b}after" }),
    );
    golden.call(
        &mut ada,
        "press_keys",
        "press_keys",
        json!({ "agent": "@helper", "keys": ["h", "i", "Enter"] }),
    );
    golden.call(
        &mut ada,
        "press_keys with names from the v2 daemon",
        "press_keys",
        json!({
            "agent": "@helper",
            "keys": ["Escape", "Return", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"],
        }),
    );
    golden.call(
        &mut ada,
        "press_keys of a key it does not know",
        "press_keys",
        json!({ "agent": "@helper", "keys": ["Hyper+Q"] }),
    );
    // The test CLI logs a submitted line before it draws it: the screen is read once it shows the
    // last one.
    assert!(
        wait_for_screen_text(&home, "helper", "> hi"),
        "{}",
        home.screen("helper")
    );
    golden.call(
        &mut ada,
        "read_screen",
        "read_screen",
        json!({ "agent": "@helper" }),
    );
    golden.call(
        &mut ada,
        "press_keys of Esc",
        "press_keys",
        json!({ "agent": "@helper", "keys": ["Esc"] }),
    );
    golden.call(
        &mut ada,
        "read_screen of lines that are not a number",
        "read_screen",
        json!({ "agent": "@helper", "lines": "12" }),
    );
    golden.call(
        &mut ada,
        "read_screen with the old last argument",
        "read_screen",
        json!({ "agent": "@helper", "last": 4 }),
    );
    golden.call(
        &mut ada,
        "read_screen with both last and lines",
        "read_screen",
        json!({ "agent": "@helper", "last": 4, "lines": 4 }),
    );
    let retried = golden.call(
        &mut ada,
        "read_screen retried with lines",
        "read_screen",
        json!({ "agent": "@helper", "lines": 4 }),
    );
    assert_eq!(retried["status"], "success", "{retried}");
    assert_eq!(retried["data"]["ended"], false);
    assert_eq!(retried["data"]["text"].as_str().unwrap().lines().count(), 4);
    golden.call(
        &mut ada,
        "read_screen of an agent that does not exist",
        "read_screen",
        json!({ "agent": "#a9" }),
    );
    golden.call(
        &mut ada,
        "stop_agent",
        "stop_agent",
        json!({ "agent": "@helper" }),
    );
    golden.call(
        &mut ada,
        "stop_agent of an agent that does not exist",
        "stop_agent",
        json!({ "agent": "#a9" }),
    );

    golden.call(
        &mut ada,
        "start_agent with a prompt",
        "start_agent",
        json!({
            "name": "twin", "cli": "fake", "window": "terminal", "path": cwd,
            "prompt": "Read the README and summarize it.",
        }),
    );
    golden.check("mcp-responses.json");
}

/// The server in each CLI's own settings serves that CLI's sessions, which join as guests, each
/// session named as its CLI names it: in the server's environment as the server starts, or in each
/// call's `_meta`. Each server responds as `core/tests/golden/mcp-guest-responses.json` records,
/// with a run's tools: `initialize` and a `list_agents` for each CLI, and a message to a guest,
/// which waits for its next turn. A Muse Code run's own entry serves the run; an Antigravity run's
/// steps aside for the run's plugin.
#[test]
fn each_cli_s_guest_server_responds_as_its_golden_file_records() {
    each_cli_s_guest_server_responds_as_recorded(Through::Program);
}

/// The daemon's own MCP server, reached over a relay connection, serves each CLI's guests as
/// `facade-mcp --guest` does.
#[test]
fn each_cli_s_guest_server_responds_through_a_relay_connection_as_its_golden_file_records() {
    each_cli_s_guest_server_responds_as_recorded(Through::Relay);
}

fn each_cli_s_guest_server_responds_as_recorded(through: Through) {
    let home = TestHome::new("mcpgoldguest");
    // A guest takes a name at random from the suggested names, where the settings file names none;
    // from a list of none it takes its ID, the same each time.
    std::fs::write(home.path.join("facade.json"), "{ \"names\": [] }\n").unwrap();
    home.start_named_fake("host", &[]);
    wait_for_tools(&home, &["host"]);
    let mut host = through.open(&home, "a1");
    let tools = host.request("tools/list", json!({}))["result"].clone();
    let mut golden = Golden::new(&home);
    // In each call's `_meta`, under the CLI's key, or else in the server's environment.
    for (cli, meta_key) in [
        ("claude", None),
        ("codex", Some("sessionId")),
        ("agy", Some("antigravity.google/root_conversation_id")),
        ("muse", None),
        ("opencode", Some("ai.opencode/sessionID")),
        ("pi", None),
    ] {
        let session = format!("{cli}-golden");
        let variable = facade_rules::session_variable(cli).unwrap();
        let named = meta_key.is_none().then_some((variable, session.as_str()));
        let mut server = through.open_guest(&home, cli, named.as_slice());
        let mut started = json!({ "method": "initialize", "server": ["--guest", cli] });
        if named.is_some() {
            started["environment"] = json!({ variable: session });
        }
        golden.record(
            &format!("initialize by {cli}'s guest server"),
            started,
            &server.initialized(),
        );
        assert_eq!(
            server.request("tools/list", json!({}))["result"],
            tools,
            "{cli}'s guests get a run's tools"
        );
        golden.call_in(
            &mut server,
            &format!("list_agents by {cli}'s guest"),
            "list_agents",
            json!({}),
            meta_key.map_or(Value::Null, |key| json!({ key: session })),
        );
    }
    golden.call(
        &mut host,
        "send_message to a guest",
        "send_message",
        json!({ "to": "#a3", "text": "hello guest" }),
    );

    let programs = home.project.parent().unwrap().join("programs");
    stand_in(&programs, "muse", &programs.join("muse-arguments"));
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    for (cli, name) in [("muse", "muser"), ("agy", "voyager")] {
        let started = home
            .facade_in_an_empty_home()
            .env("PATH", &path)
            .env("FAKECLI_LOOK", cli)
            .args(["start", "--name", name, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{}", stderr(&started));
        let run = started_id(&stdout(&started));
        let mut entry = through.open_guest(&home, cli, &[("FACADE_AGENT", &run)]);
        let server = json!({ "method": "initialize", "server": ["--guest", cli], "environment": { "FACADE_AGENT": run } });
        golden.record(
            &format!("initialize by the {cli} run's own entry"),
            server,
            &entry.initialized(),
        );
        let listed = entry.request("tools/list", json!({}));
        if cli == "muse" {
            assert_eq!(
                listed["result"], tools,
                "a Muse Code run's entry serves the run"
            );
        } else {
            golden.record(
                "tools/list by the agy run's own entry",
                json!({ "method": "tools/list", "server": ["--guest", cli] }),
                &listed,
            );
        }
    }
    golden.check("mcp-guest-responses.json");
}

/// A line of 1 MiB goes through the relay each way, and the connection goes on: a request whose
/// method is that long, which the daemon's answer names in full, then a ping.
#[test]
fn a_line_of_a_mebibyte_goes_through_the_relay_each_way() {
    let home = TestHome::new("relaymib");
    home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open(&home, "a1");
    let method = "x".repeat(1 << 20);
    let long = ada.send(&method, json!({}));
    let answered = ada
        .answer(long, secs(30))
        .expect("the long line is answered");
    assert_eq!(answered["error"]["code"], -32601);
    assert!(
        answered["error"]["message"]
            .as_str()
            .is_some_and(|message| message.len() > 1 << 20),
        "the answer names the method in full"
    );
    assert_eq!(ada.request("ping", json!({}))["result"], json!({}));
}
