//! Messages: `facade send` and `facade rename`, delivery by each agent's typist with its draft
//! protected, the `messages` topic whose snapshot delivers what it returns, its waiting watch and
//! `facade messages`, and who a client acts for.

use std::process::{Child, Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Runs `facade` as a command in agent `agent`'s terminal does: acting for that agent.
fn facade_as(home: &TestHome, agent: &str, args: &[&str]) -> Output {
    home.command(&test_binaries().facade)
        .env("FACADE_AGENT", agent)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("could not run facade")
}

/// Starts `facade send` in the background.
fn send_in_background(home: &TestHome, args: &[&str]) -> Child {
    let mut command = home.command(&test_binaries().facade);
    command
        .arg("send")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.spawn().expect("could not run facade send")
}

/// A connection acting for `agent` that watches its inbox as `args` select it. Returns the watch
/// and its snapshot.
fn watch_inbox(home: &TestHome, agent: &str, args: Value) -> (DaemonTestClient, u64, Value) {
    let mut wire = DaemonTestClient::open(home);
    let welcome = wire.hello("terminal", [1, 1], json!({ "agent": agent }));
    assert!(welcome["result"].is_object(), "{welcome}");
    let watching = wire.request("watch", json!({ "topic": "messages", "args": args }));
    let watch = watching["result"]["watch"]
        .as_u64()
        .unwrap_or_else(|| panic!("{watching}"));
    (wire, watch, watching["result"]["snapshot"].clone())
}

/// Waits until the inbox watch sees a message whose delivery is `status`.
fn wait_for_delivery(inbox: &DaemonTestClient, watch: u64, message: &str, status: &str) -> bool {
    wait_until(secs(30), || {
        inbox.changes(watch).iter().any(|changed| {
            changed["change"]["message"]["message_id"] == message
                && changed["change"]["message"]["delivery"]["status"] == status
        })
    })
}

/// Puts a draft into the agent's input, as a person typing does, and waits until its screen shows
/// it.
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

/// A message is pasted as one draft under a header naming its sender and number, and submitted. A
/// command in an agent's terminal sends as that agent, and a reply names the message it answers.
#[test]
fn a_message_is_typed_into_its_recipient_s_input_under_a_header_naming_its_sender() {
    let home = TestHome::new("send");
    home.start_named_fake("ada", &[]);
    home.start_named_fake("bob", &[]);
    assert_eq!(
        home.run_facade_ok(&["send", "ada", "hi ada"]).trim(),
        "m1 delivered to a1"
    );
    let replied = facade_as(
        &home,
        "a1",
        &["send", "@bob", "hi bob\nsecond line", "--reply-to", "#m1"],
    );
    assert_eq!(
        stdout(&replied).trim(),
        "m2 delivered to a2",
        "{}",
        stderr(&replied)
    );
    assert_eq!(
        home.submitted_messages(),
        [
            "📨 Message from #human · #m1\nhi ada",
            "📨 Message from ada (#a1) · #m2 · Reply to #m1\nhi bob\nsecond line"
        ]
    );
    let screen = home.screen("bob");
    assert!(
        screen
            .contains("> 📨 Message from ada (#a1) · #m2 · Reply to #m1\n  hi bob\n  second line"),
        "the test CLI shows every line: {screen}"
    );

    let refused = |output: Output| {
        assert!(!output.status.success(), "{}", stdout(&output));
        stderr(&output)
    };
    assert!(
        refused(home.run_facade(&["send", "ada", "x", "--reply-to", "m2"]))
            .contains("no message m2 is in the sender's inbox")
    );
    assert!(
        refused(home.run_facade(&["send", "ada", " \t"]))
            .contains("text is blank: a message needs text")
    );
    assert!(
        refused(home.run_facade(&["send", "ada", "a\u{7}b"])).contains("control character U+0007")
    );
    assert_eq!(
        refused(home.run_facade(&["send", "nobody", "x"])),
        "error: no agent 'nobody'\n  tip: run 'facade list' to see your agents\n"
    );
    for person in ["#human", "#HUMAN", "human", "@Human"] {
        assert!(
            refused(home.run_facade(&["send", person, "x"]))
                .contains("a message to the person must come from an agent"),
            "{person}"
        );
    }
    let terminal = "#a1 runs in the terminal window, not in an editor window, where Facade could \
                    tell the person";
    assert!(refused(facade_as(&home, "a1", &["send", "#human", "x"])).contains(terminal));
    assert!(
        refused(facade_as(&home, "a9", &["send", "ada", "x"]))
            .contains("#a9, the agent this message would come from, is not listed")
    );
    home.run_facade_ok(&["stop", "bob"]);
    // An ended agent is named by the ID the service gives, however the reader named it.
    for bob in ["a2", "#a2", "2", "bob", "@bob"] {
        assert_eq!(
            refused(home.run_facade(&["send", bob, "x"])),
            "error: a2 has ended\n  tip: run 'facade inspect a2' to check for a saved session\n",
            "{bob}"
        );
    }
    // Once an agent is named human, `human` names it and the human both; `#human` is still the
    // human.
    home.run_facade_ok(&["rename", "ada", "Human"]);
    for given in ["human", "@human"] {
        assert_eq!(
            refused(home.run_facade(&["send", given, "x"])),
            format!(
                "error: '{given}' matches both the human and an agent named human\n  tip: quote \
                 '#human' for the human, or run 'facade list' for the agent's ID\n"
            )
        );
    }
    assert!(
        refused(home.run_facade(&["send", "#human", "x"]))
            .contains("a message to the person must come from an agent")
    );
    assert_eq!(
        home.submitted_messages().len(),
        2,
        "a refused message is never typed"
    );
}

/// A sender's name shows on its message's header line whatever it holds, so the recipient's CLI
/// takes the message whole, once.
#[test]
fn a_sender_s_name_cannot_break_out_of_its_message_s_header() {
    let home = TestHome::new("sendname");
    home.start_named_fake("evil\u{1b}[201~\rINJECTED", &[]);
    home.start_named_fake("bob", &[]);
    let sent = facade_as(&home, "a1", &["send", "bob", "hi"]);
    assert!(sent.status.success(), "{}", stderr(&sent));
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from evil [201~ INJECTED (#a1) · #m1\nhi"]
    );
    let listed = home.run_facade_ok(&["list"]);
    assert!(
        !listed.contains('\u{1b}') && !listed.contains('\r') && listed.lines().count() == 3,
        "{listed:?}"
    );
}

/// A message a draft holds until its deadline fails, and its send says the draft held it.
#[test]
fn a_send_a_draft_held_until_its_deadline_says_so() {
    let home = TestHome::new("sendheld");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let sent = home.run_facade(&["send", "worker", "hello"]);
    assert_eq!(sent.status.code(), Some(1));
    let said = stderr(&sent);
    assert!(
        said.starts_with("error: m1 was not delivered to a1: ")
            && said.contains("a draft held a1's input until the deadline")
            && !said.contains("(failed)"),
        "{said}"
    );
    assert!(home.submitted_messages().is_empty());
}

/// The typist never types a message over a draft: the message waits until the input is empty, then
/// goes in alone.
#[test]
fn a_message_waits_while_a_draft_holds_the_input_and_never_types_over_it() {
    let home = TestHome::new("senddraft");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch, snapshot) = watch_inbox(&home, "a1", json!({}));
    assert_eq!(snapshot, json!({ "messages": [] }));
    let send = send_in_background(&home, &["worker", "hello"]);
    assert!(
        wait_for_delivery(&inbox, watch, "m1", "pending"),
        "{:?}",
        inbox.changes(watch)
    );
    // The person clears the draft; keys go before a message waiting for the input.
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    let sent = send.wait_with_output().unwrap();
    assert_eq!(
        stdout(&sent).trim(),
        "m1 delivered to a1",
        "{}",
        stderr(&sent)
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from #human · #m1\nhello"],
        "the draft was never typed over"
    );
    assert!(wait_for_delivery(&inbox, watch, "m1", "success"));
    let delivered = inbox.changes(watch).last().unwrap()["change"]["message"]["delivery"].clone();
    assert_eq!(
        (
            &delivered["delivered_via"],
            &delivered["text_written"],
            &delivered["enter_written"]
        ),
        (&json!("terminal"), &json!("full"), &json!(true))
    );
}

/// Reading a message that waits for the input delivers it: its sender learns it was read, and it is
/// never typed.
#[test]
fn a_read_delivers_a_waiting_message_so_it_is_never_typed() {
    let home = TestHome::new("sendread");
    home.start_named_fake("worker", &[]);
    home.start_named_fake("other", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    // A message to another agent is not in this inbox.
    assert_eq!(
        home.run_facade_ok(&["send", "other", "not for a1"]).trim(),
        "m1 delivered to a2"
    );
    let send = send_in_background(&home, &["worker", "read me"]);
    assert!(wait_for_delivery(&inbox, watch, "m2", "pending"));
    assert!(
        inbox
            .changes(watch)
            .iter()
            .all(|changed| changed["change"]["message"]["to"] == "a1"),
        "{:?}",
        inbox.changes(watch)
    );
    let (_, _, read) = watch_inbox(&home, "a1", json!({}));
    let message = &read["messages"][0];
    assert_eq!(
        (&message["message_id"], &message["from"], &message["text"]),
        (&json!("m2"), &json!("human"), &json!("read me"))
    );
    assert_eq!(
        (
            &message["delivery"]["status"],
            &message["delivery"]["delivered_via"]
        ),
        (&json!("success"), &json!("read"))
    );
    let sent = send.wait_with_output().unwrap();
    assert_eq!(stdout(&sent).trim(), "m2 read by a1", "{}", stderr(&sent));
    // The draft clears and a later message goes in alone: the one read was dropped from the typist.
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "next"]).trim(),
        "m3 delivered to a1"
    );
    assert_eq!(
        home.submitted_messages(),
        [
            "📨 Message from #human · #m1\nnot for a1",
            "📨 Message from #human · #m3\nnext"
        ]
    );
    let (_, _, unread) = watch_inbox(&home, "a1", json!({}));
    assert_eq!(unread["messages"], json!([]), "nothing is returned twice");
    let (_, _, all) = watch_inbox(&home, "a1", json!({ "all": true }));
    let via: Vec<&Value> = all["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| &message["delivery"]["delivered_via"])
        .collect();
    assert_eq!(via, [&json!("read"), &json!("terminal")]);
    let (mut other, _, _) = watch_inbox(&home, "a1", json!({}));
    let not_mine = other.request(
        "watch",
        json!({ "topic": "messages", "args": { "ids": ["m1"] } }),
    );
    assert_eq!(error_reason(&not_mine), "not_found");
}

#[test]
fn rename_trims_a_name_and_gives_a_blank_one_a_default() {
    let home = TestHome::new("rename");
    home.start_named_fake("worker", &[]);
    home.start_named_fake("other", &[]);
    let mut agents = DaemonTestClient::open(&home);
    agents.hello("terminal", [1, 1], json!({}));
    let watch = agents.request("watch", json!({ "topic": "agents" }))["result"]["watch"]
        .as_u64()
        .unwrap();
    assert_eq!(
        home.run_facade_ok(&["rename", "worker", "  Neo  "]),
        "a1 Neo\n"
    );
    let updated = |name: &str| {
        agents.changes(watch).iter().any(|changed| {
            changed["change"]["kind"] == "updated" && changed["change"]["agent"]["name"] == name
        })
    };
    assert!(
        wait_until(secs(10), || updated("Neo")),
        "{:?}",
        agents.changes(watch)
    );
    assert!(
        home.list_table()
            .row("NAME", "Neo")
            .is_some_and(|row| row[0] == "a1"),
        "{:?}",
        home.list_table()
    );
    let sent = facade_as(&home, "a1", &["send", "other", "hi"]);
    assert!(sent.status.success(), "{}", stderr(&sent));
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from Neo (#a1) · #m1\nhi"],
        "a message carries its sender's name when it was sent"
    );
    let renamed = home.run_facade_ok(&["rename", "a1", " "]);
    let name = renamed.trim().strip_prefix("a1 ").unwrap_or_default();
    assert!(!name.is_empty() && name != "Neo", "{renamed}");
    assert_eq!(home.agent_from_watch(name).unwrap()["agent_id"], "a1");
    let unknown = home.run_facade(&["rename", "nobody", "x"]);
    assert!(
        unknown.status.code() == Some(1)
            && stderr(&unknown)
                == "error: no agent 'nobody'\n  tip: run 'facade list' to see your agents\n",
        "{}",
        stderr(&unknown)
    );
}

/// Message records live in the daemon's memory, but their numbers come from the store: a new daemon
/// never gives one twice.
#[test]
fn message_numbers_are_never_given_twice_across_daemons() {
    let home = TestHome::new("sendnumbers");
    home.start_named_fake("worker", &[]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "first"]).trim(),
        "m1 delivered to a1"
    );
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "second"]).trim(),
        "m2 delivered to a1"
    );
}

/// Facade sets `FACADE_AGENT` and `FACADE_HOME` in every agent's environment, so a command in its
/// terminal acts for it. The `messages` topic reads the inbox of the agent a client acts for, which
/// must be listed; an `mcp` client always names one, listed when it says hello.
#[test]
fn a_client_acts_for_the_agent_its_hello_names() {
    let home = TestHome::new("actsfor");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "env",
        "echo \"agent=$FACADE_AGENT\"; echo \"home=$FACADE_HOME\"; sleep 60",
    );
    assert!(
        wait_for_screen_text(&home, &agent, "home="),
        "{}",
        home.screen(&agent)
    );
    let screen = home.screen(&agent);
    assert!(screen.contains(&format!("agent={agent}")), "{screen}");
    let canonical = facade_base::files::real_path(&home.path).unwrap();
    assert!(
        screen.contains(&format!("home={}", canonical.display()))
            || screen.contains(&format!("home={}", home.path.display())),
        "{screen}"
    );

    let mut mcp = DaemonTestClient::open(&home);
    let nameless = mcp.hello("mcp", [1, 1], json!({}));
    assert_eq!(error_reason(&nameless), "invalid_argument", "{nameless}");
    let nobody = wire.request("watch", json!({ "topic": "messages" }));
    assert!(
        nobody["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("this client acts for none"),
        "{nobody}"
    );
    let unlisted = DaemonTestClient::open(&home).hello("mcp", [1, 1], json!({ "agent": "#a9" }));
    assert_eq!(error_reason(&unlisted), "not_found", "{unlisted}");
    assert!(
        unlisted["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("#a9, the agent this client acts for, is not listed"),
        "{unlisted}"
    );
    let mut gone = DaemonTestClient::open(&home);
    gone.hello("terminal", [1, 1], json!({ "agent": "#a9" }));
    let refused = gone.request("watch", json!({ "topic": "messages" }));
    assert_eq!(error_reason(&refused), "not_found", "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("#a9, the agent this client acts for, is not listed"),
        "{refused}"
    );
}

/// Waits up to `timeout` for a command started in the background, and returns its output, or none
/// if it is still running.
fn output_within(mut child: Child, timeout: std::time::Duration) -> Option<Output> {
    if !wait_until(timeout, || {
        child.try_wait().is_ok_and(|status| status.is_some())
    }) {
        let _ = child.kill();
        return None;
    }
    child.wait_with_output().ok()
}

/// A message pasted into a CLI that never reads its input fails by its deadline: its send answers
/// within 30 seconds, saying that what of it reaches the terminal is not known, as its paste is
/// still queued, and no Enter follows it, so the CLI never submits it. Input already waiting for
/// the terminal fills what it holds unread, a few KiB on macOS and up to 640 KiB on Linux, so the
/// paste stays queued behind it on both.
#[test]
fn a_message_to_a_cli_that_reads_no_input_fails_within_30_seconds_and_is_never_submitted() {
    let home = TestHome::new("sendunread");
    let deaf = home.start_named_fake("deaf", &[("FAKECLI_IGNORE_INPUT", "1")]);
    let mut wire = connect(&home);
    let waiting = wire.call(
        "agent.type",
        json!({
            "agent": deaf.id, "raw": facade_base::base64::encode(&vec![b'w'; 960 * 1024]),
        }),
    );
    assert!(waiting["result"].is_object(), "{waiting}");
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    let started = std::time::Instant::now();
    let send = send_in_background(&home, &["deaf", &"x".repeat(4000)]);
    // A second message waits behind the first's stuck paste: nothing of it is typed, so it is
    // withdrawn at its deadline.
    std::thread::sleep(secs(1));
    let second_started = std::time::Instant::now();
    let second = send_in_background(&home, &["deaf", "behind"]);
    let sent = output_within(send, secs(45)).expect("facade send answers");
    let took = started.elapsed();
    assert!(
        !sent.status.success() && took < std::time::Duration::from_millis(30_500),
        "answered after {took:?}: {}",
        stderr(&sent)
    );
    let behind = output_within(second, secs(45)).expect("the second send answers");
    let took = second_started.elapsed();
    assert!(
        !behind.status.success() && took < std::time::Duration::from_millis(30_500),
        "answered after {took:?}: {}",
        stderr(&behind)
    );
    assert!(
        wait_until(secs(30), || inbox.changes(watch).iter().any(
            |changed| changed["change"] == json!({ "kind": "removed", "message_id": "m2" })
        )),
        "{:?}",
        inbox.changes(watch)
    );
    assert!(
        wait_for_delivery(&inbox, watch, "m1", "failure"),
        "{:?}",
        inbox.changes(watch)
    );
    let delivery = inbox
        .changes(watch)
        .into_iter()
        .rev()
        .find(|change| change["change"]["message"]["message_id"] == "m1")
        .unwrap()["change"]["message"]["delivery"]
        .clone();
    // A pseudo console's host reads its input whether or not the CLI does, so on Windows all of the
    // paste is typed and only its Enter is held back.
    #[cfg(unix)]
    let written = (json!("unknown"), None);
    #[cfg(windows)]
    let written = (json!("full"), Some(&json!(false)));
    assert_eq!(
        (
            &delivery["reason"],
            &delivery["text_written"],
            delivery.get("enter_written")
        ),
        (&json!("submission_unconfirmed"), &written.0, written.1)
    );
    assert!(home.submitted_messages().is_empty());
}

/// A recipient removed while a send waits for its answer takes the message's record with it: the
/// send still answers, with the message as it was settled.
#[test]
fn a_send_whose_recipient_is_removed_before_its_answer_still_answers() {
    let home = TestHome::new("sendremoved");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-send-answer")]);
    home.start_named_fake("worker", &[]);
    let send = send_in_background(&home, &["worker", "hello"]);
    home.wait_for_gate("before-send-answer");
    home.run_facade_ok(&["remove", "worker"]);
    home.release_gate("before-send-answer");
    let sent = output_within(send, secs(10)).expect("facade send answers");
    assert_eq!(
        stdout(&sent).trim(),
        "m1 delivered to a1",
        "{}",
        stderr(&sent)
    );
}

/// A message longer than 8,000 characters or 540 lines is refused before it is kept or numbered, in
/// the same words whoever receives it. The longest is taken, by Antigravity too, the CLI that takes
/// a paste slowest.
#[test]
fn a_message_too_long_for_any_cli_is_refused_before_it_is_kept() {
    let home = TestHome::new("sendlong");
    let programs = home.path.join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let started = home
        .command(&test_binaries().facade)
        .args(["start", "--name", "slow", "agy"])
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    home.start_named_fake("quick", &[]);
    let lines = |count: usize| vec!["x"; count].join("\n");
    for agent in ["slow", "quick"] {
        let refused = home.run_facade(&["send", agent, &lines(541)]);
        assert!(!refused.status.success(), "{}", stdout(&refused));
        assert!(
            stderr(&refused).contains(
                "text has 541 lines; a message carries at most 540: send it in shorter parts"
            ),
            "{}",
            stderr(&refused)
        );
    }
    let (inbox, watch, snapshot) = watch_inbox(&home, "a1", json!({ "all": true }));
    assert_eq!(snapshot, json!({ "messages": [] }), "no message was kept");
    // The longest is kept, under the first number: the refusals took none.
    let kept = send_in_background(&home, &["slow", &lines(540)]);
    assert!(
        wait_for_delivery(&inbox, watch, "m1", "pending"),
        "{:?}",
        inbox.changes(watch)
    );
    assert!(
        output_within(kept, std::time::Duration::from_millis(100)).is_none(),
        "it is being delivered"
    );
}

/// A command acts for the agent whose session its CLI names, an agent Facade started as much as a
/// guest, without `FACADE_AGENT`: `facade messages` there reads that agent's inbox. Outside any
/// agent's terminal it says so, and starts no daemon.
#[test]
fn a_command_acts_for_the_agent_whose_session_its_cli_names() {
    let home = TestHome::new("sessioncommand");
    let outside = home.run_facade(&["messages"]);
    assert!(
        !outside.status.success() && !socket_exists(&home.daemon_socket()),
        "{}",
        stderr(&outside)
    );
    let session = "0a1b2c3d-1111-2222-3333-444455556666";
    home.start_named_fake("worker", &[("FAKECLI_SESSION", session)]);
    assert!(wait_until(secs(10), || home
        .agent_from_list_json("worker")
        .is_some_and(|agent| agent["session"] == session)));
    type_draft(&home, "worker", "my draft");
    let (follower, watch, _) = watch_inbox(&home, "a1", json!({}));
    let send = send_in_background(&home, &["worker", "found by session"]);
    assert!(
        wait_for_delivery(&follower, watch, "m1", "pending"),
        "{:?}",
        follower.changes(watch)
    );
    let mut command = home.command(&test_binaries().facade);
    let read = command
        .env("CODEX_SESSION_ID", session)
        .args(["messages"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        stdout(&read),
        "📨 Message from #human · #m1\nfound by session\n",
        "{}",
        stderr(&read)
    );
    assert_eq!(
        stdout(&send.wait_with_output().unwrap()).trim(),
        "m1 read by a1"
    );
}

/// `facade messages` in an agent's terminal prints the messages waiting for it and so delivers
/// them, and nothing once none waits. Elsewhere it says it reads the inbox of the agent whose
/// terminal it runs in.
#[test]
fn facade_messages_prints_and_delivers_what_waits_for_the_agent_of_its_terminal() {
    let home = TestHome::new("messagescmd");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (follower, watch, _) = watch_inbox(&home, "a1", json!({}));
    let send = send_in_background(&home, &["worker", "read me"]);
    assert!(wait_for_delivery(&follower, watch, "m1", "pending"));
    let read = facade_as(&home, "a1", &["messages"]);
    assert!(read.status.success(), "{}", stderr(&read));
    assert_eq!(stdout(&read), "📨 Message from #human · #m1\nread me\n");
    assert_eq!(
        stdout(&send.wait_with_output().unwrap()).trim(),
        "m1 read by a1"
    );
    let again = facade_as(&home, "a1", &["messages"]);
    assert_eq!(
        (again.status.code(), stdout(&again), stderr(&again)),
        (Some(0), String::new(), "No messages waiting.\n".to_string()),
        "nothing is printed twice"
    );
    let unlisted = facade_as(&home, "a9", &["messages"]);
    let said = stderr(&unlisted);
    assert!(
        unlisted.status.code() == Some(1)
            && said.starts_with("error: ")
            && said.contains("a9")
            && !said.contains("(not_found)"),
        "{said}"
    );
    let elsewhere = home.run_facade(&["messages"]);
    assert_eq!(
        (elsewhere.status.code(), stderr(&elsewhere)),
        (
            Some(1),
            "error: 'facade messages' reads an agent's inbox and must run in that agent's \
             terminal\n  tip: messages for the human appear in the editor window\n"
                .to_string()
        )
    );
}

/// What the store keeps of message `number`: its status, its reason, how much of it was typed, how
/// it was delivered, and the paste it went in. Read from `facade.db` itself, since a read through
/// Facade would deliver the message.
type Kept = (String, Option<String>, String, Option<String>, Option<i64>);

fn kept(home: &TestHome, number: u64) -> Option<Kept> {
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).ok()?;
    connection
        .query_row(
            "SELECT status, reason, text_written, delivered_via, paste FROM messages \
             WHERE number = ?1",
            [number as i64],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .ok()
}

/// How long the store gives message `number` to be delivered: from its send to its deadline, which
/// it keeps while the message is pending.
fn time_to_deliver(home: &TestHome, number: u64) -> Option<std::time::Duration> {
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).ok()?;
    let (at, deadline): (String, String) = connection
        .query_row(
            "SELECT at, deadline FROM messages WHERE number = ?1",
            [number as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let time = |iso: &str| facade_base::time::parse_iso_time(iso);
    time(&deadline)?.duration_since(time(&at)?).ok()
}

/// Waits until message `number` is settled in the store, and returns what became of it.
fn settled(home: &TestHome, number: u64) -> Kept {
    let mut found = None;
    let done = wait_until(secs(40), || {
        found = kept(home, number).filter(|kept| kept.0 != "pending");
        found.is_some()
    });
    assert!(
        done,
        "#m{number} was not settled: {:?}\n{}",
        kept(home, number),
        home.daemon_log()
    );
    found.unwrap()
}

/// Waits until the daemon stopped itself at debug pause point `point`, kills it there as a crash
/// would, and waits for the next daemon the keeper starts.
fn crash_at(home: &TestHome, point: &str) {
    assert!(
        wait_until(secs(30), || home
            .path
            .join(format!("core/paused-at-{point}"))
            .exists()),
        "the daemon did not reach {point}: {}",
        home.daemon_log()
    );
    let (pid, _) = home
        .lock_record("daemon")
        .expect("the daemon's lock record");
    kill_process(pid);
    home.wait_for_daemon_after(pid, secs(30))
        .expect("the keeper starts the next daemon");
}

/// Kills the daemon, as a crash would, and waits for the next daemon the keeper starts.
fn crash(home: &TestHome) {
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
}

/// A send cut off by its daemon's crash says that what became of its message is not known.
fn cut_off(send: Child) {
    let sent = send.wait_with_output().unwrap();
    assert!(
        !sent.status.success() && stderr(&sent).contains("the outcome is unknown"),
        "{}{}",
        stdout(&sent),
        stderr(&sent)
    );
}

/// Messages outlive their daemon. A read message, a typed one and one that failed keep what became
/// of them across a crash, a cursor from before still pages on, and numbers go on. The failed one
/// is still not delivered: a later read delivers it.
#[test]
fn messages_and_what_became_of_them_outlive_their_daemon() {
    let home = TestHome::new("restartkept");
    // A send, a crash and the next daemon's recovery can take a loaded machine longer than a send's
    // 29.5 seconds.
    home.start_facade_with(&[("FACADE_TEST_DELIVERY_MS", "120000")]);
    home.start_named_fake("worker", &[]);
    let mut wire = connect(&home);
    let plain = start_script(&mut wire, &home, "plain", "sleep 600");
    type_draft(&home, "worker", "my draft");
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    let read = send_in_background(&home, &["worker", "read me"]);
    assert!(wait_for_delivery(&inbox, watch, "m1", "pending"));
    watch_inbox(&home, "a1", json!({}));
    assert_eq!(
        stdout(&read.wait_with_output().unwrap()).trim(),
        "m1 read by a1"
    );
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "typed"]).trim(),
        "m2 delivered to a1"
    );
    assert!(
        !home
            .run_facade(&["send", "plain", "no reader"])
            .status
            .success()
    );
    assert_eq!(
        kept(&home, 3).map(|kept| kept.1),
        Some(Some("unsupported".into()))
    );
    let (_, _, before) = watch_inbox(&home, "a1", json!({ "all": true }));
    let (_, _, first) = watch_inbox(&home, "a1", json!({ "all": true, "limit": 1 }));
    crash(&home);
    let (_, _, after) = watch_inbox(&home, "a1", json!({ "all": true }));
    assert_eq!(
        after, before,
        "every message and every fact of its delivery"
    );
    let (_, _, next) = watch_inbox(
        &home,
        "a1",
        json!({ "all": true, "cursor": first["next_cursor"] }),
    );
    assert_eq!(next["messages"][0]["message_id"], "m2", "{next}");
    let (_, _, failed) = watch_inbox(&home, &plain, json!({}));
    assert_eq!(
        (
            &failed["messages"][0]["message_id"],
            &failed["messages"][0]["delivery"]["delivered_via"]
        ),
        (&json!("m3"), &json!("read"))
    );
    // The daemon the keeper started after the crash gives a send the test's two minutes too, as a
    // draft holds it pending.
    type_draft(&home, "worker", "a draft");
    let after = send_in_background(&home, &["worker", "after"]);
    let mut given = None;
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            given = time_to_deliver(&home, 4);
            given.is_some()
        }),
        "#m4 is kept pending: {:?}",
        kept(&home, 4)
    );
    assert!(
        given.is_some_and(|given| given > secs(119) && given < secs(121)),
        "#m4 had {given:?} to be delivered"
    );
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        stdout(&after.wait_with_output().unwrap()).trim(),
        "m4 delivered to a1"
    );
}

/// A message waiting behind a draft when its daemon crashes is typed by the next daemon once the
/// draft clears: once, and within the deadline it was given when it was sent. Its send was cut off,
/// and says what became of it is not known.
#[test]
fn a_message_waiting_when_its_daemon_crashes_is_typed_once_by_the_next() {
    let home = TestHome::new("restartwaiting");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    let send = send_in_background(&home, &["worker", "hello"]);
    assert!(wait_for_delivery(&inbox, watch, "m1", "pending"));
    let pending = inbox
        .changes(watch)
        .into_iter()
        .find(|changed| changed["change"]["message"]["message_id"] == "m1")
        .unwrap();
    let deadline = pending["change"]["message"]["delivery"]["deadline"]
        .as_str()
        .unwrap()
        .to_string();
    crash(&home);
    cut_off(send);
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        settled(&home, 1),
        (
            "success".into(),
            None,
            "full".into(),
            Some("terminal".into()),
            Some(1)
        )
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from #human · #m1\nhello"],
        "typed once"
    );
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    let delivered_at: String = connection
        .query_row(
            "SELECT delivered_at FROM messages WHERE number = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        delivered_at < deadline,
        "delivered at {delivered_at}, its deadline {deadline}"
    );
}

/// Messages that fill their recipient's waiting input when the daemon crashes do not hold up the
/// next daemon: it serves at once, and its keeper never finds it stalled. What does not fit waits
/// for room, as a send's message does, and no message outlives the deadline it had from its send.
#[test]
fn messages_that_fill_their_recipient_s_input_at_a_crash_do_not_hold_up_the_next_daemon() {
    let home = TestHome::new("restartfull");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    // 40 messages of 8,000 four-byte characters are more than the 1 MiB of input an agent keeps
    // waiting. A connection runs at most 16 calls at once.
    let text = "😀".repeat(8000);
    let mut senders: Vec<DaemonTestClient> = (0..3).map(|_| connect(&home)).collect();
    for n in 0..40 {
        senders[n % 3].send(
            "call",
            json!({ "op": "agent.send", "args": { "to": "worker", "text": text } }),
        );
    }
    assert!(
        wait_until(secs(10), || kept(&home, 40).is_some()),
        "{}",
        home.daemon_log()
    );
    let store = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    let last: String = store
        .query_row("SELECT max(deadline) FROM messages", [], |row| row.get(0))
        .unwrap();
    let old = home.kill_daemon();
    let crashed = std::time::Instant::now();
    home.wait_for_daemon_after(old, secs(40))
        .expect("the keeper starts the next daemon");
    assert!(
        crashed.elapsed() < secs(10),
        "the next daemon served {:?} after the crash",
        crashed.elapsed()
    );
    // The draft holds the input, so every message is withdrawn by its deadline, nothing of it typed.
    let remaining = || {
        store
            .query_row("SELECT count(*) FROM messages", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    };
    let by_then = facade_base::time::parse_iso_time(&last).unwrap() + secs(5);
    assert!(
        wait_until(
            by_then
                .duration_since(std::time::SystemTime::now())
                .unwrap_or_default(),
            || remaining() == 0
        ),
        "{} messages were not withdrawn",
        remaining()
    );
    assert!(home.submitted_messages().is_empty());
    assert!(
        !home.keeper_log().contains("sent no ping"),
        "{}",
        home.keeper_log()
    );
}

/// A message whose paste is in the input when its daemon crashes, its Enter not sent yet, is never
/// pasted again: the next daemon presses Enter over the message's own draft, and the message is
/// submitted once. The log says the CLI may still be inside the paste.
#[test]
fn a_paste_in_the_input_when_its_daemon_crashes_gets_its_enter_from_the_next() {
    let home = TestHome::new("restartpasted");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "before-message-enter")]);
    home.start_named_fake("worker", &[]);
    let send = send_in_background(&home, &["worker", "hello"]);
    crash_at(&home, "before-message-enter");
    cut_off(send);
    assert_eq!(
        settled(&home, 1),
        (
            "success".into(),
            None,
            "full".into(),
            Some("terminal".into()),
            Some(1)
        )
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from #human · #m1\nhello"],
        "submitted once"
    );
    assert!(
        home.daemon_log()
            .contains("#a1's CLI may still be inside a paste"),
        "{}",
        home.daemon_log()
    );
}

/// A paste in the input when its daemon crashes goes first in the next daemon. A message kept
/// before the crash, which waited behind it, is typed once the paste got its Enter and was
/// delivered: each is submitted once, in that order.
#[test]
fn a_paste_in_the_input_when_its_daemon_crashes_goes_before_the_message_behind_it() {
    let home = TestHome::new("restartorder");
    // The sends, the crash and the next daemon's recovery can take a loaded machine longer than a
    // send's 29.5 seconds.
    home.start_facade_with(&[
        ("FACADE_TEST_PAUSE_AT", "before-message-enter"),
        ("FACADE_TEST_DELIVERY_MS", "120000"),
    ]);
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    // Two messages too long to go in one paste of 32 KiB: the first is pasted alone, and the second
    // waits behind it.
    let (long, short) = ("😀".repeat(8000), "😀".repeat(300));
    let first = send_in_background(&home, &["worker", &long]);
    assert!(wait_for_delivery(&inbox, watch, "m1", "pending"));
    let second = send_in_background(&home, &["worker", &short]);
    assert!(wait_for_delivery(&inbox, watch, "m2", "pending"));
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    crash_at(&home, "before-message-enter");
    cut_off(first);
    cut_off(second);
    assert_eq!(
        settled(&home, 1),
        (
            "success".into(),
            None,
            "full".into(),
            Some("terminal".into()),
            Some(1)
        )
    );
    assert_eq!(
        settled(&home, 2),
        (
            "success".into(),
            None,
            "full".into(),
            Some("terminal".into()),
            Some(2)
        )
    );
    let pasted = [
        format!("📨 Message from #human · #m1\n{long}"),
        format!("📨 Message from #human · #m2\n{short}"),
    ];
    assert_eq!(home.submitted_messages(), pasted, "each once, in order");
}

/// A message whose paste's beginning was recorded when its daemon crashed, but none of it written,
/// is never typed: the next daemon holds the input for it until its deadline, when it fails as
/// unconfirmed, what of it was typed unknown. A later read delivers it, with no second result.
#[test]
fn a_paste_recorded_but_not_written_when_its_daemon_crashes_is_never_typed() {
    let home = TestHome::new("restartrecorded");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-paste-commit")]);
    home.start_named_fake("worker", &[]);
    let send = send_in_background(&home, &["worker", "hello"]);
    crash_at(&home, "after-paste-commit");
    cut_off(send);
    assert_eq!(
        kept(&home, 1).unwrap().4,
        Some(1),
        "its paste's beginning was recorded"
    );
    assert_eq!(
        settled(&home, 1),
        (
            "failure".into(),
            Some("submission_unconfirmed".into()),
            "unknown".into(),
            None,
            Some(1)
        )
    );
    assert!(home.submitted_messages().is_empty(), "never typed");
    assert!(
        !home.screen("worker").contains("hello"),
        "{}",
        home.screen("worker")
    );
    let read = facade_as(&home, "a1", &["messages"]);
    assert!(
        stdout(&read).contains("📨 Message from #human · #m1\nhello"),
        "{}",
        stdout(&read)
    );
    assert_eq!(kept(&home, 1).unwrap().3.as_deref(), Some("read"));
}

/// A read stopped between its record and its answer when its daemon crashes delivered the message:
/// the next daemon never types it, and the next message goes in alone once the draft holding the
/// input clears.
#[test]
fn a_message_read_when_its_daemon_crashes_is_never_typed_by_the_next() {
    let home = TestHome::new("restartread");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-read-commit")]);
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    let send = send_in_background(&home, &["worker", "read me"]);
    assert!(wait_for_delivery(&inbox, watch, "m1", "pending"));
    let mut reader = DaemonTestClient::open(&home);
    reader.hello("terminal", [1, 1], json!({ "agent": "a1" }));
    reader.send("watch", json!({ "topic": "messages", "args": {} }));
    crash_at(&home, "after-read-commit");
    cut_off(send);
    assert_eq!(
        kept(&home, 1).unwrap().3.as_deref(),
        Some("read"),
        "the read delivered it before it answered"
    );
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "next"]).trim(),
        "m2 delivered to a1"
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from #human · #m2\nnext"],
        "the read message is never typed"
    );
}

/// A message whose recipient ended while no daemon ran fails as ended in the next daemon. The
/// keeper, holding no CLI once the recipient ended, exits with the daemon; the next command starts
/// Facade again, and the agent is ended there, its terminal closed.
#[test]
fn a_message_whose_recipient_ended_while_no_daemon_ran_fails_as_ended() {
    let home = TestHome::new("restartended");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let cli = home.agent_from_list_json("worker").unwrap()["pid"]
        .as_i64()
        .unwrap() as i32;
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    let send = send_in_background(&home, &["worker", "hello"]);
    assert!(wait_for_delivery(&inbox, watch, "m1", "pending"));
    let (daemon, _) = home.lock_record("daemon").unwrap();
    pause_process(daemon);
    kill_process(cli);
    kill_process(daemon);
    cut_off(send);
    home.run_facade_ok(&["list"]);
    assert_eq!(
        settled(&home, 1),
        (
            "failure".into(),
            Some("ended".into()),
            "none".into(),
            None,
            None
        )
    );
}

/// Removing an agent deletes its inbox and keeps what it sent in its recipients' inboxes, across a
/// restart too.
#[test]
fn a_removed_agent_s_inbox_goes_and_what_it_sent_stays() {
    let home = TestHome::new("removedinbox");
    home.start_named_fake("worker", &[]);
    home.start_named_fake("other", &[]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "to worker"]).trim(),
        "m1 delivered to a1"
    );
    assert_eq!(
        stdout(&facade_as(&home, "a1", &["send", "other", "from worker"])).trim(),
        "m2 delivered to a2"
    );
    home.run_facade_ok(&["remove", "worker"]);
    assert!(kept(&home, 1).is_none() && kept(&home, 2).is_some());
    crash(&home);
    let (_, _, all) = watch_inbox(&home, "a2", json!({ "all": true }));
    assert_eq!(
        (
            &all["messages"][0]["message_id"],
            &all["messages"][0]["from"]
        ),
        (&json!("m2"), &json!("a1")),
        "{all}"
    );
    assert!(kept(&home, 1).is_none());
}

/// Messages kept for 30 days are deleted as a daemon starts, with the long-read files that hold
/// them; newer ones and their files stay, across an idle exit, and numbers go on.
#[test]
fn messages_older_than_30_days_go_with_their_files_as_a_daemon_starts() {
    let home = TestHome::new("expiry");
    connect(&home);
    home.wait_for_idle_exit();
    let month_ago = facade_base::time::iso_time(
        std::time::SystemTime::now() - std::time::Duration::from_secs(31 * 24 * 60 * 60),
    );
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    for (number, at) in [(1, month_ago.as_str()), (2, &facade_base::time::iso_now())] {
        connection
            .execute(
                "INSERT INTO messages (number, \"from\", \"to\", text, at, status, text_written, \
                 enter_written, delivered_via, delivered_at)
				 VALUES (?1, 'human', 'a9', 'hi', ?2, 'success', 'full', 1, 'terminal', ?2)",
                rusqlite::params![number, at],
            )
            .unwrap();
    }
    connection
        .execute("UPDATE message_numbers SET next = 3", [])
        .unwrap();
    drop(connection);
    let results = home.path.join("core/results");
    facade_base::files::create_private_folder_all(&results).unwrap();
    for name in [
        "messages-m1-20261011T000000000Z-1-0.txt",
        "messages-m2-20261111T000000000Z-1-1.txt",
    ] {
        std::fs::write(results.join(name), "x").unwrap();
    }
    connect(&home);
    assert!(
        kept(&home, 1).is_none() && kept(&home, 2).is_some(),
        "the message from 31 days ago went"
    );
    let left: Vec<String> = std::fs::read_dir(&results)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, ["messages-m2-20261111T000000000Z-1-1.txt"]);
    let next: i64 = rusqlite::Connection::open(home.path.join("core/facade.db"))
        .unwrap()
        .query_row("SELECT next FROM message_numbers", [], |row| row.get(0))
        .unwrap();
    assert_eq!(next, 3, "numbers go on");
}

/// A message whose recipient is not listed after a restart, as an agent whose record this build
/// cannot read, waits for a read until its deadline, then is withdrawn with nothing typed.
#[test]
fn a_message_whose_recipient_is_not_listed_after_a_restart_fails_at_its_deadline() {
    let home = TestHome::new("restartunlisted");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch, _) = watch_inbox(&home, "a1", json!({}));
    let send = send_in_background(&home, &["worker", "hello"]);
    assert!(wait_for_delivery(&inbox, watch, "m1", "pending"));
    let store = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    store
        .execute(
            "UPDATE agents SET pid = 'unreadable' WHERE agent_id = 'a1'",
            [],
        )
        .unwrap();
    crash(&home);
    cut_off(send);
    assert!(
        home.agents().is_empty(),
        "an agent whose record this build cannot read is not listed"
    );
    assert!(
        wait_until(secs(40), || kept(&home, 1).is_none()),
        "{:?}",
        kept(&home, 1)
    );
    assert!(home.submitted_messages().is_empty());
}

/// Agent and message numbers continue above the highest an editor gave before, as its window's
/// client says in `hello`.
#[test]
fn numbers_continue_above_those_an_editor_gave() {
    let home = TestHome::new("numbersgiven");
    let folder = std::fs::canonicalize(&home.project).unwrap();
    let window = json!({
        "id": "win-1", "label": "win-1 window", "environment": "local", "workspace": "k1",
        "folders": [folder],
    });
    let _editor = ide_with(
        &home,
        &window,
        json!({ "numbers_given": { "agent": 41, "message": 230 } }),
    );
    let ada = home.start_named_fake("ada", &[]);
    assert_eq!(ada.id, "a42");
    assert_eq!(
        home.run_facade_ok(&["send", "ada", "hi ada"]).trim(),
        "m231 delivered to a42"
    );
}
