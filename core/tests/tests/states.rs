//! Agent states and what was last said to an agent. The fake CLI reports its status over OSC 7501
//! with `FAKECLI_STATUS=1` and is driven by `/fake` messages; a script named `muse` draws Muse
//! Code's screen, which its rule reads.

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Starts a fake CLI that reports its status, with more environment variables.
fn reporting(home: &TestHome, name: &str, more: &[(&str, &str)]) -> TestAgent {
    let mut env = vec![("FAKECLI_STATUS", "1")];
    env.extend_from_slice(more);
    home.start_fake_with(name, &env)
}

/// The agent's record in `facade list --json` once its state is `state`.
fn reaches(home: &TestHome, name: &str, state: &str) -> Value {
    let mut agent = Value::Null;
    let reached = wait_until(secs(20), || {
        agent = home.agent_from_list_json(name).unwrap_or_default();
        agent["state"] == state
    });
    assert!(reached, "{name} did not become {state}: {agent}");
    agent
}

/// Submits `text` with Enter, as `facade type --enter` does.
fn submit(home: &TestHome, name: &str, text: &str) {
    home.run_facade_ok(&["type", name, text, "--enter"]);
}

/// Shows the agent in an attached terminal.
fn attach(home: &TestHome, name: &str) -> TestTerminal {
    let term = TestTerminal::spawn(
        home.command(&test_binaries().facade).args(["attach", name]),
        80,
        24,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯")),
        "{}",
        term.text()
    );
    term
}

#[test]
fn an_agent_is_starting_until_its_cli_shows_what_it_does() {
    let home = TestHome::new("starting");
    // Ready only after the test ends: the CLI shows nothing until it takes a message.
    reporting(&home, "w1", &[("FAKECLI_STATUS_DELAY_MS", "600000")]);
    let agent = home.agent_from_list_json("w1").unwrap();
    assert_eq!(
        (&agent["state"], agent.get("state_detail")),
        (&json!("starting"), None)
    );
    assert!(
        wait_for_screen_text(&home, "w1", "status reports taken"),
        "the daemon answers the CLI that asks whether it takes reports"
    );
    assert_eq!(
        home.agent_from_list_json("w1").unwrap()["state"],
        "starting",
        "a CLI that asked is still starting"
    );
    submit(&home, "w1", "hello");
    reaches(&home, "w1", "working");
}

#[test]
fn a_turn_is_working_then_just_done_until_a_terminal_shows_the_agent() {
    let home = TestHome::new("turn");
    reporting(&home, "w1", &[("FAKECLI_TURN_MS", "3000")]);
    reaches(&home, "w1", "idle");
    assert!(
        home.agent_from_list_json("w1")
            .unwrap()
            .get("said")
            .is_none(),
        "nothing was said yet"
    );
    submit(&home, "w1", "fix the\nbuild");
    let working = reaches(&home, "w1", "working");
    assert_eq!(working["said"]["text"], "fix the build", "said is one line");
    home.run_facade_ok(&["type", "w1", "half a thought"]);
    reaches(&home, "w1", "just_done");
    assert_eq!(
        home.agent_from_list_json("w1").unwrap()["said"]["text"],
        "fix the build",
        "text without Enter says nothing"
    );
    assert_eq!(home.list_state("w1").as_deref(), Some("turn finished"));
    let inspected = home.run_facade_ok(&["inspect", "w1"]);
    assert!(
        inspected.lines().any(|line| line.starts_with("Last input:")
            && line.contains("human, ")
            && line.ends_with(": fix the build")),
        "{inspected}"
    );
    let _term = attach(&home, "w1");
    reaches(&home, "w1", "idle");
}

#[test]
fn a_turn_that_ends_while_a_terminal_shows_the_agent_is_idle() {
    let home = TestHome::new("watched");
    reporting(&home, "w1", &[("FAKECLI_TURN_MS", "1500")]);
    let _term = attach(&home, "w1");
    submit(&home, "w1", "go");
    reaches(&home, "w1", "working");
    reaches(&home, "w1", "idle");
}

#[test]
fn waiting_for_you_says_what_for_an_error_says_the_cli_s_words_and_a_report_taken_back_is_unknown()
{
    let home = TestHome::new("waiting");
    reporting(&home, "w1", &[]);
    reaches(&home, "w1", "idle");
    submit(&home, "w1", "/fake block permission Run npm test?");
    let waiting = reaches(&home, "w1", "waiting_for_you");
    assert_eq!(
        waiting["state_detail"],
        json!({ "kind": "permission", "text": "Run npm test?" })
    );
    assert_eq!(
        home.list_state("w1").as_deref(),
        Some("waiting for you: permission")
    );
    let inspected = home.run_facade_ok(&["inspect", "w1"]);
    let state = inspected
        .split_once("\nState:")
        .map(|(_, rest)| rest.lines().take(2).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(
        state.len() == 2
            && state[0].trim() == "waiting for you: permission"
            && state[1].trim() == "Run npm test?",
        "{inspected}"
    );
    submit(&home, "w1", "/fake error Out of credits");
    let error = reaches(&home, "w1", "error");
    assert_eq!(error["state_detail"], json!({ "text": "Out of credits" }));
    submit(&home, "w1", "/fake clear");
    let unknown = reaches(&home, "w1", "unknown");
    assert_eq!(unknown["state_detail"], json!({ "reason": "taken_back" }));
    let inspected = home.run_facade_ok(&["inspect", "w1"]);
    assert!(
        inspected
            .lines()
            .any(|line| line.starts_with("State:") && line[6..].trim_start().starts_with("unknown")),
        "{inspected}"
    );
    assert!(
        inspected.lines().any(|line| line.starts_with("Last input:")
            && line.contains("human, ")
            && line.ends_with(": /fake clear")),
        "{inspected}"
    );
}

#[test]
fn an_ended_agent_says_whether_it_ended_normally_was_stopped_or_crashed() {
    let home = TestHome::new("ended");
    for name in ["normal", "crashed", "stopped"] {
        reporting(&home, name, &[]);
    }
    submit(&home, "normal", "/fake exit 0");
    submit(&home, "crashed", "/fake exit 3");
    home.run_facade_ok(&["stop", "stopped"]);
    for (name, how) in [
        ("normal", "normal"),
        ("crashed", "crashed"),
        ("stopped", "stopped"),
    ] {
        let ended = reaches(&home, name, "ended");
        assert_eq!(ended["state_detail"], json!({ "how": how }), "{name}");
    }
    let table = home.list_table();
    assert!(
        ["normal", "crashed", "stopped"]
            .iter()
            .map(|name| table.cell(table.row("NAME", name).unwrap(), "STATE"))
            .eq(["exited: code 0", "exited: code 3", "stopped"]),
        "{table:?}"
    );
}

#[test]
fn states_and_said_survive_a_killed_daemon() {
    let home = TestHome::new("statekill");
    reporting(&home, "asking", &[]);
    reporting(&home, "done", &[("FAKECLI_TURN_MS", "200")]);
    reporting(&home, "stopped", &[]);
    submit(&home, "asking", "/fake block question Which branch?");
    reaches(&home, "asking", "waiting_for_you");
    submit(&home, "done", "ship it");
    reaches(&home, "done", "just_done");
    home.run_facade_ok(&["stop", "stopped"]);
    reaches(&home, "stopped", "ended");
    let before: Vec<Value> = ["asking", "done", "stopped"]
        .iter()
        .map(|name| home.agent_from_list_json(name).unwrap())
        .collect();
    // The facts are written beside each screen off the actor; wait until they landed.
    for (agent, fact) in
        before
            .iter()
            .zip(["\"blocked\"", "\"just_done\":true", "\"stopped\":true"])
    {
        let file = home
            .path
            .join("core/screens")
            .join(agent["agent_id"].as_str().unwrap())
            .join("state");
        assert!(
            wait_until(secs(10), || std::fs::read_to_string(&file)
                .is_ok_and(|kept| kept.contains(fact))),
            "{} keeps {fact}",
            agent["name"]
        );
    }
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(20))
        .expect("a new daemon answers");
    for agent in before {
        let after = home
            .agent_from_list_json(agent["name"].as_str().unwrap())
            .unwrap();
        for field in ["state", "state_detail", "said"] {
            assert_eq!(
                after.get(field),
                agent.get(field),
                "{field} of {}",
                agent["name"]
            );
        }
    }
}

/// A wait for the person is published at once, while other changes wait for their batch, here held
/// back for a minute.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "holds back the batch through a debug build's setting"
)]
fn a_wait_for_the_person_is_published_at_once() {
    let home = TestHome::new("waitatonce");
    home.start_facade_with(&[("FACADE_TEST_PUBLISH_AFTER_MS", "60000")]);
    reporting(&home, "w1", &[]);
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    let watch = wire.request("watch", json!({ "topic": "agents", "args": {} }))["result"]["watch"]
        .as_u64()
        .unwrap();
    submit(&home, "w1", "/fake block permission Run it?");
    let waiting = |wire: &DaemonTestClient| {
        wire.changes(watch)
            .iter()
            .any(|change| change["change"]["agent"]["state"] == "waiting_for_you")
    };
    assert!(
        wait_until(secs(10), || waiting(&wire)),
        "{:?}",
        wire.changes(watch)
    );
}

/// The agent's record once its `said` is `text`.
fn said(home: &TestHome, name: &str, text: &str) -> Value {
    let mut agent = Value::Null;
    let reached = wait_until(secs(10), || {
        agent = home.agent_from_list_json(name).unwrap_or_default();
        agent["said"]["text"] == text
    });
    assert!(reached, "{name} was not said {text:?}: {agent}");
    agent
}

/// The person types into an agent's input in an attached terminal: `keys`, then once the CLI draws
/// `drawn`, Ctrl+C, which clears the fake CLI's input. Returns once its input is empty again.
fn type_then_clear(home: &TestHome, term: &TestTerminal, keys: &[u8], drawn: &str) {
    term.send(keys);
    assert!(
        term.wait_for(secs(5), |text| text.contains(drawn)),
        "{drawn}: {}",
        term.text()
    );
    term.send(b"\x03");
    assert!(
        wait_until(secs(5), || home
            .screen("w1")
            .lines()
            .any(|line| line == "❯")),
        "{}",
        home.screen("w1")
    );
}

/// What the person submits with Enter in an attached terminal is said once the CLI takes it,
/// whether its keys came before the Enter or with it, and drawn late. A draft ending in `\`, which
/// CLIs take as a line break, Alt+Enter, and an Enter inside a paste submit nothing, even when the
/// draft is cleared afterwards.
#[test]
fn the_person_s_enter_is_said_once_the_cli_takes_what_it_submits() {
    let home = TestHome::new("personenter");
    // An Enter sent with its keys waits for the CLI to draw them, 150 ms at most. This test is
    // about what is said, so it gives the CLI longer, however slow the machine.
    home.start_facade_with(&[("FACADE_TEST_ENTER_HELD_MS", "10000")]);
    let cli = home.start_named_fake("w1", &[]);
    let term = attach(&home, "w1");
    term.send(b"fix the build");
    assert!(
        term.wait_for(secs(5), |text| text.contains("❯ fix the build")),
        "{}",
        term.text()
    );
    term.send(b"\r");
    let agent = said(&home, "w1", "fix the build");
    assert_eq!(
        (&agent["said"]["from"], agent["said"].get("from_name")),
        (&json!("human"), None)
    );
    // Keys and their Enter in one write, which the CLI draws 300 ms later.
    pause_process(cli.pid);
    term.send(b"ship it\r");
    std::thread::sleep(std::time::Duration::from_millis(300));
    resume_process(cli.pid);
    said(&home, "w1", "ship it");
    term.send(b"line one\\\r");
    assert!(
        term.wait_for(secs(5), |text| text.contains("> line one\\")),
        "{}",
        term.text()
    );
    type_then_clear(&home, &term, b"alt\x1b\r", "❯ alt");
    type_then_clear(
        &home,
        &term,
        b"draft \x1b[200~a\rb\x1b[201~",
        "❯ draft [Pasted text #1 +1 lines]",
    );
    assert_eq!(
        home.agent_from_list_json("w1").unwrap()["said"]["text"],
        "ship it"
    );
}

/// An Enter whose keys the CLI does not draw within 150 ms goes without its input read: nothing is
/// said, not even the draft the CLI showed before those keys.
#[test]
fn an_enter_whose_keys_are_not_drawn_in_time_says_nothing() {
    let home = TestHome::new("undrawnenter");
    let cli = home.start_named_fake("w1", &[]);
    let term = attach(&home, "w1");
    term.send(b"fix ");
    assert!(
        term.wait_for(secs(5), |text| text.contains("❯ fix")),
        "{}",
        term.text()
    );
    pause_process(cli.pid);
    term.send(b"the build\r");
    std::thread::sleep(secs(3));
    resume_process(cli.pid);
    assert!(
        wait_until(secs(10), || home
            .submitted_messages()
            .iter()
            .any(|text| text == "fix the build")),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(home.agent_from_list_json("w1").unwrap().get("said"), None);
}

/// A CLI that draws the keys before an Enter inside a synchronized update has its draft read once
/// it ends the update, as its screen shows the keys only then: the draft is said.
#[test]
fn an_enter_s_draft_is_read_once_the_synchronized_update_that_draws_it_ends() {
    let home = TestHome::new("syncenter");
    // The held Enter's bound is long here, so that the draft is read when the update ends, however
    // slow the machine.
    home.start_facade_with(&[("FACADE_TEST_ENTER_HELD_MS", "10000")]);
    let programs = home.project.parent().unwrap().join("bin");
    std::fs::create_dir_all(&programs).unwrap();
    // The test CLI's input, its keys drawn inside a synchronized update that stays open half a
    // second; Enter empties it.
    let script = r#"#!/bin/sh
stty raw -echo
draw() { printf '\033[2J\033[H❯ %s' "$1"; }
draft=''
draw ''
while :; do
	keys=$(dd bs=64 count=1 2>/dev/null)
	case "$keys" in
	*"$(printf '\r')"*) draft=''; draw ''; continue ;;
	esac
	draft="$draft$keys"
	printf '\033[?2026h'
	draw "$draft"
	sleep 0.5
	printf '\033[?2026l'
done
"#;
    install_script(&programs, "facade-fakecli", script);
    let mut wire = connect(&home);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        SYSTEM_PATH.as_str()
    );
    let args = json!({
        "command": ["fake"], "name": "sync", "cwd": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    assert!(wire.call("agent.start", args)["result"].is_object());
    let term = attach(&home, "sync");
    assert!(
        term.wait_for(secs(5), |text| text.contains("❯")),
        "{}",
        term.text()
    );
    term.send(b"ship it\r");
    said(&home, "sync", "ship it");
}

/// A long paste that the CLI shows as its placeholder is said as the text the person pasted, with
/// what was typed around it.
#[test]
fn a_pasted_text_is_said_as_itself_not_as_its_placeholder() {
    let home = TestHome::new("pastesaid");
    home.start_named_fake("w1", &[]);
    let term = attach(&home, "w1");
    term.send(b"look at \x1b[200~first line\rsecond line\x1b[201~");
    assert!(
        term.wait_for(secs(5), |text| text
            .contains("❯ look at [Pasted text #1 +1 lines]")),
        "{}",
        term.text()
    );
    term.send(b"\r");
    said(&home, "w1", "look at first line second line");
}

/// Two long pastes before one Enter are each said as the text the person pasted, in order, and the
/// next Enter's paste as its own.
#[test]
fn two_pasted_texts_before_one_enter_are_each_said_as_themselves() {
    let home = TestHome::new("pastestwo");
    home.start_named_fake("w1", &[]);
    let term = attach(&home, "w1");
    term.send(
        b"look at \x1b[200~first line\rsecond line\x1b[201~ and \x1b[200~third line\rfourth \
          line\x1b[201~",
    );
    let shown = "❯ look at [Pasted text #1 +1 lines] and [Pasted text #2 +1 lines]";
    assert!(
        term.wait_for(secs(5), |text| text.contains(shown)),
        "{}",
        term.text()
    );
    term.send(b"\r");
    said(
        &home,
        "w1",
        "look at first line second line and third line fourth line",
    );
    // The next Enter gives back its own paste, though the ones before were of its size.
    term.send(b"\x1b[200~fifth line\rsixth line\x1b[201~");
    assert!(
        term.wait_for(secs(5), |text| text.contains("❯ [Pasted text #3 +1 lines]")),
        "{}",
        term.text()
    );
    term.send(b"\r");
    said(&home, "w1", "fifth line sixth line");
}

/// An Enter the CLI answers with a question of its own in place of its input takes the draft: it is
/// said.
// Its stand-in is a sh script that reads keys, which MSYS sh under a pseudo console does not get.
#[cfg(unix)]
#[test]
fn an_enter_the_cli_answers_with_a_question_is_said() {
    let home = TestHome::new("enterquestion");
    let programs = home.project.parent().unwrap().join("bin");
    std::fs::create_dir_all(&programs).unwrap();
    // Muse Code's input frame across the screen, its draft as typed; Enter draws a menu in its
    // place.
    let script = r#"#!/bin/sh
stty raw -echo
draw() {
	printf '\033[2J\033[H  Muse Code 1.4.14\r\n\r\nRULE\r\n❯ %s\r\nRULE\r\n  model · effort · folder' "$1"
	printf '\033[4;%dH' $((3 + ${#1}))
}
draft=''
draw ''
while :; do
	c=$(dd bs=1 count=1 2>/dev/null)
	[ "$c" = "$(printf '\r')" ] && break
	draft="$draft$c"
	draw "$draft"
done
printf '\033[2J\033[H  Muse Code 1.4.14\r\n\r\nWhich one?\r\n⟩ 1  Yes\r\n  2  No\r\n'
exec sleep 600
"#.replace("RULE", &"─".repeat(80));
    install_script(&programs, "muse", &script);
    let mut wire = connect(&home);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        SYSTEM_PATH.as_str()
    );
    let args = json!({
        "command": ["muse"], "name": "muse", "cwd": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    assert!(wire.call("agent.start", args)["result"].is_object());
    let term = attach(&home, "muse");
    term.send(b"ship it");
    assert!(
        term.wait_for(secs(5), |text| text.contains("❯ ship it")),
        "{}",
        term.text()
    );
    term.send(b"\r");
    assert!(
        term.wait_for(secs(5), |text| text.contains("⟩ 1  Yes")),
        "{}",
        term.text()
    );
    said(&home, "muse", "ship it");
}

/// An Enter the CLI does not take, its draft still there when the time to take it ends, says
/// nothing.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test markers of debug builds"
)]
fn an_enter_the_cli_does_not_take_says_nothing() {
    let home = TestHome::new("untaken");
    home.start_facade_with(&[("FACADE_TEST_GATES", "submission-untaken")]);
    home.start_named_fake("w1", &[("FAKECLI_IGNORE_ENTER", "1")]);
    let term = attach(&home, "w1");
    term.send(b"kept");
    assert!(
        term.wait_for(secs(5), |text| text.contains("❯ kept")),
        "{}",
        term.text()
    );
    // The Enter goes once its draft is drawn. Sent with the text, it waits for the CLI to draw it
    // for 150 ms at most, and under load it then goes unread: that says nothing either, but follows
    // no submission to its end.
    term.send(b"\r");
    home.wait_for_gate("submission-untaken");
    assert!(
        home.agent_from_list_json("w1")
            .unwrap()
            .get("said")
            .is_none()
    );
}

/// Text typed with Enter by a command in an agent's terminal, and a message an agent sends, are
/// said by that agent; a message from the person is the person's.
#[test]
fn what_an_agent_types_or_sends_is_said_by_that_agent() {
    let home = TestHome::new("saidby");
    let ada = home.start_named_fake("ada", &[]);
    home.start_named_fake("bob", &[]);
    let as_ada = |args: &[&str]| {
        let output = home
            .command(&test_binaries().facade)
            .args(args)
            .env("FACADE_AGENT", &ada.id)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {}", stderr(&output));
    };
    as_ada(&["type", "bob", "from ada", "--enter"]);
    let typed = said(&home, "bob", "from ada");
    assert_eq!(
        (&typed["said"]["from"], &typed["said"]["from_name"]),
        (&json!(ada.id), &json!("ada"))
    );
    as_ada(&["send", "bob", "run the tests"]);
    said(&home, "bob", "run the tests");
    let inspected = home.run_facade_ok(&["inspect", "bob"]);
    assert!(
        inspected.lines().any(|line| line.starts_with("Last input:")
            && line.contains(&format!(" {}, ", ada.id))
            && line.ends_with(": run the tests")),
        "{inspected}"
    );
    home.run_facade_ok(&["send", "bob", "hello"]);
    let sent = said(&home, "bob", "hello");
    assert_eq!(
        (&sent["said"]["from"], sent["said"].get("from_name")),
        (&json!("human"), None)
    );
}

/// An agent whose daemon ends while it stops it, before the exit is saved, is listed as ended by
/// the next daemon: the keeper let go of the CLI as it ended, so its terminal closed (the accepted
/// degrade).
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn an_agent_stopped_while_its_daemon_failed_is_listed_as_ended() {
    let home = TestHome::new("stoppedlost");
    let marker = home.path.join("core/paused-at-before-exit-commit");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(&marker, "").unwrap();
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "before-exit-commit")]);
    reporting(&home, "w1", &[]);
    std::fs::remove_file(&marker).unwrap();
    let daemon = home.lock_record("daemon").unwrap().0;
    let mut wire = connect(&home);
    wire.send(
        "call",
        json!({ "op": "agent.stop", "args": { "agent": "w1" } }),
    );
    assert!(
        wait_until(secs(10), || stopped(daemon)),
        "the daemon did not stop before saving the exit"
    );
    kill_process(daemon);
    reaches(&home, "w1", "ended");
}

/// OpenCode reports a turn whose model call failed as a turn that ended, and draws the error on its
/// screen: the agent shows the error, in OpenCode's words.
#[test]
fn opencode_s_failed_model_call_is_an_error() {
    let home = TestHome::new("opencodeerror");
    let programs = home.project.parent().unwrap().join("bin");
    std::fs::create_dir_all(&programs).unwrap();
    let turn = " • New session\\r\\n\\r\\n  ┃\\r\\n  ┃  say hi\\r\\n  ┃\\r\\n\\r\\n     Error: \
                stand-in model: recorded, not answered\\r\\n\\r\\n     Build · m1 · \
                113ms\\r\\n\\r\\n  ┃\\r\\n  ┃  Build · m1 Stand-in\\r\\n  \
                ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\\r\\n  /work/probe  ctrl+p commands";
    let script = format!(
        "#!/bin/sh\nprintf '\\033]7501;state=working\\007'\nsleep 1\nprintf \
         '\\033[2J\\033[H{turn}\\033]7501;state=done\\007'\nexec sleep 600\n"
    );
    install_script(&programs, "opencode", &script);
    let mut wire = connect(&home);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        SYSTEM_PATH.as_str()
    );
    let args = json!({
        "command": ["opencode"], "name": "opencode", "cwd": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    assert!(wire.call("agent.start", args)["result"].is_object());
    let agent = reaches(&home, "opencode", "error");
    assert_eq!(
        agent["state_detail"]["text"], "stand-in model: recorded, not answered",
        "{agent}"
    );
}

/// Turns YOLO off in Facade's settings file, `facade.json`, for the launches after it: the
/// questions their CLIs ask on their screens, Claude Code's trust question among them, are then the
/// person's to answer.
fn yolo_off(home: &TestHome) {
    std::fs::create_dir_all(&home.path).unwrap();
    std::fs::write(home.path.join("facade.json"), r#"{"yolo": false}"#).unwrap();
}

/// A question of the CLI's own on its screen, in place of its input, waits for the person, also
/// while the CLI starts and its tools have not connected: Claude Code's trust question, behind a
/// hidden cursor, in a run with YOLO off.
#[test]
fn a_question_on_the_screen_waits_for_the_person_while_the_cli_starts() {
    let home = TestHome::new("trustquestion");
    yolo_off(&home);
    let programs = home.project.parent().unwrap().join("bin");
    std::fs::create_dir_all(&programs).unwrap();
    let question = " Accessing workspace:\\r\\n\\r\\n /work/probe\\r\\n\\r\\n Quick safety check: \
                    Is this a project you created or one you trust?\\r\\n\\r\\n ❯ No, exit\\r\\n   \
                    Yes, I trust this folder\\r\\n\\r\\n Enter to confirm · Esc to cancel";
    let script = format!(
        "#!/bin/sh\nprintf '\\033[2J\\033[H{question}\\033[?25l\\033[7;2H'\nexec sleep 600\n"
    );
    install_script(&programs, "claude", &script);
    let mut wire = connect(&home);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        SYSTEM_PATH.as_str()
    );
    let args = json!({
        "command": ["claude"], "name": "claude", "cwd": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    assert!(wire.call("agent.start", args)["result"].is_object());
    let agent = reaches(&home, "claude", "waiting_for_you");
    assert_eq!(
        (
            agent["state_detail"]["kind"].as_str(),
            agent["tools_state"].as_str()
        ),
        (Some("unknown"), Some("connecting")),
        "{agent}"
    );
}

/// An Enter that answers a question the CLI shows, Claude Code's trust question here in a run with
/// YOLO off, asks it for nothing: its start-up work after the answer is no turn, and it goes on
/// starting, its tools not yet connected. An Enter once the question went asks it.
#[test]
fn an_enter_that_answers_the_cli_s_question_asks_for_nothing() {
    let home = TestHome::new("answered");
    yolo_off(&home);
    let programs = home.project.parent().unwrap().join("bin");
    std::fs::create_dir_all(&programs).unwrap();
    let question = " Accessing workspace:\\r\\n\\r\\n /work/probe\\r\\n\\r\\n Quick safety check: \
                    Is this a project you created or one you trust?\\r\\n\\r\\n ❯ No, exit\\r\\n   \
                    Yes, I trust this folder\\r\\n\\r\\n Enter to confirm · Esc to cancel";
    let work = "printf '\\033]7501;state=working\\033\\\\'\nsleep 1\nprintf \
                '\\033]7501;state=idle\\033\\\\'";
    let script = format!(
        "#!/bin/sh\nprintf '\\033[2J\\033[H{question}\\033[?25l\\033[7;2H'\nread answer\nprintf \
         '\\033[2J\\033[H\\033[?25h'\n{work}\nread line\n{work}\nexec sleep 600\n"
    );
    install_script(&programs, "claude", &script);
    let mut wire = connect(&home);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        SYSTEM_PATH.as_str()
    );
    let args = json!({
        "command": ["claude"], "name": "claude", "cwd": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    assert!(wire.call("agent.start", args)["result"].is_object());
    reaches(&home, "claude", "waiting_for_you");
    home.run_facade_ok(&["type", "claude", "--key", "Enter"]);
    reaches(&home, "claude", "working");
    reaches(&home, "claude", "starting");
    home.run_facade_ok(&["type", "claude", "--key", "Enter"]);
    reaches(&home, "claude", "just_done");
}

/// Muse Code's screen shows what it does: working while it starts. That work is no turn, also with
/// words after its name, which are the CLI's own: once it rests, each run reads starting again,
/// never just done, as Muse Code is given Facade's tools, which this script never connects.
#[test]
fn muse_code_s_screen_shows_what_it_does() {
    let home = TestHome::new("musescreen");
    let programs = home.project.parent().unwrap().join("bin");
    std::fs::create_dir_all(&programs).unwrap();
    let frame = "────────\\r\\n❯ \\r\\n────────\\r\\n  model · effort · folder";
    let script = format!(
        "#!/bin/sh\nprintf '\\033[2J\\033[H◈ Thinking (3s · esc to interrupt)\\r\\n{frame}'\nsleep \
         3\nprintf '\\033[2J\\033[H  Muse Code 1.4.14\\r\\n\\r\\n{frame}'\nexec sleep 600\n"
    );
    install_script(&programs, "muse", &script);
    let mut wire = connect(&home);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        SYSTEM_PATH.as_str()
    );
    for (name, command) in [
        ("muse", json!(["muse"])),
        ("words", json!(["muse", "hello"])),
    ] {
        let args = json!({
            "command": command, "name": name, "cwd": home.project,
            "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
        });
        assert!(wire.call("agent.start", args)["result"].is_object());
    }
    reaches(&home, "muse", "working");
    reaches(&home, "words", "working");
    for name in ["muse", "words"] {
        let agent = reaches(&home, name, "starting");
        assert_eq!(agent["tools_state"], "connecting", "no turn: {agent}");
    }
}

/// Work a CLI does before it is asked to do anything is no turn, also after it first rested, as
/// Codex 0.167.0 works on after its first idle when it starts slowly. An Enter typed through
/// Facade, alone, asks it to do something.
#[test]
fn work_no_one_asked_for_is_no_turn() {
    let home = TestHome::new("unasked");
    let programs = home.project.parent().unwrap().join("bin");
    std::fs::create_dir_all(&programs).unwrap();
    let script = "#!/bin/sh\nr() { printf '\\033]7501;state=%s\\033\\\\' \"$1\"; }\nr idle\n\
                  sleep 1\nr working\nsleep 1\nr idle\nread line\nr working\nsleep 1\nr idle\n\
                  exec sleep 600\n";
    install_script(&programs, "starter", script);
    let mut wire = connect(&home);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        SYSTEM_PATH.as_str()
    );
    let args = json!({
        "command": ["starter"], "name": "starter", "cwd": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    assert!(wire.call("agent.start", args)["result"].is_object());
    reaches(&home, "starter", "working");
    reaches(&home, "starter", "idle");
    home.run_facade_ok(&["type", "starter", "--key", "Enter"]);
    reaches(&home, "starter", "just_done");
}

/// An agent that another agent started and that has waited for the person for 20 seconds is told
/// to its creator once, with what it waits for.
#[test]
fn an_agent_waiting_for_the_person_for_20_seconds_is_told_to_its_creator_once() {
    let home = TestHome::new("waitingtold");
    // The agents boss starts report their status as boss does: they get boss's environment.
    let boss = home.start_named_fake("boss", &[("FAKECLI_STATUS", "1")]);
    let cwd = home.agent_from_list_json("boss").unwrap()["cwd"].clone();
    let mut server = McpTestClient::open(&home, &boss.id);
    let started = server.call(
        "start_agent",
        json!({ "name": "child", "cli": "fake", "window": "terminal", "folder": cwd }),
    );
    assert_eq!(started["status"], "success", "{started}");
    let child = home.agent_from_list_json("child").unwrap()["agent_id"]
        .as_str()
        .unwrap()
        .to_string();
    reaches(&home, "child", "idle");
    submit(&home, "child", "/fake block permission Run npm test?");
    reaches(&home, "child", "waiting_for_you");
    let told = || -> Vec<String> {
        home.submitted_messages()
            .into_iter()
            .filter(|text| text.starts_with("🔔") && text.contains(&format!("#{child}")))
            .collect()
    };
    assert!(
        wait_until(secs(40), || !told().is_empty()),
        "boss was not told: {:?}",
        home.submitted_messages()
    );
    assert!(told()[0].contains("permission"), "{:?}", told());
    // Still waiting 20 seconds later, it is not told again.
    std::thread::sleep(secs(21));
    assert_eq!(told().len(), 1, "{:?}", told());
}
