//! Messages: `facade send` and `facade rename`, delivery by each agent's typist with its draft
//! protected, a read that takes a waiting message so it is never typed, what a send's receipt and
//! its repeat by request ID say across a daemon crash, and a command in an agent's terminal acting
//! as the command line.

use std::process::{Child, Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Runs `facade` as a command in agent `agent`'s terminal does, with the agent's `FACADE_AGENT`:
/// it still acts as the command line.
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

/// An `agent.send` from the command line under way: its connection and the call's ID.
struct Sending(DaemonTestClient, u64);

/// Starts an `agent.send` of `text` to `to` from the command line, with request ID `request` where
/// given, without waiting for its receipt.
fn begin_send(home: &TestHome, to: &str, text: &str, request: Option<&str>) -> Sending {
    let mut wire = connect(home);
    let mut args = json!({ "to": to, "text": text });
    if let Some(request) = request {
        args["request_id"] = json!(request);
    }
    let call = wire.send("call", json!({ "op": "agent.send", "args": args }));
    Sending(wire, call)
}

impl Sending {
    /// The send's answer, once it comes, within the 30 seconds a send has and some to spare.
    fn answer(self) -> Value {
        let Sending(wire, call) = self;
        wire.wait_for_response(call, secs(45))
            .expect("the send answers")
    }

    /// The send's receipt, once it comes.
    fn receipt(self) -> Value {
        let answer = self.answer();
        assert!(answer["result"].is_object(), "{answer}");
        answer["result"].clone()
    }

    /// Whether the send has answered after `wait`.
    fn answered_within(&self, wait: std::time::Duration) -> bool {
        self.0.wait_for_response(self.1, wait).is_some()
    }
}

/// The receipt of a send repeated by its request ID on a new connection, after the first call was
/// cut off: it joins the message's delivery or answers what became of it.
fn repeat_send(home: &TestHome, to: &str, text: &str, request: &str) -> Value {
    let repeated = connect(home).call(
        "agent.send",
        json!({ "to": to, "text": text, "request_id": request }),
    );
    assert_eq!(repeated["result"]["repeated"], true, "{repeated}");
    repeated["result"].clone()
}

/// The delivery facts of a receipt: its status, reason, how much was typed, how it was delivered.
fn delivery_of(receipt: &Value) -> (Value, Value, Value, Value) {
    let delivery = &receipt["message"]["delivery"];
    (
        delivery["status"].clone(),
        delivery["reason"].clone(),
        delivery["text_written"].clone(),
        delivery["delivered_via"].clone(),
    )
}

/// A receipt's facts of a message typed and submitted: delivered through the terminal, all of it.
fn typed_in() -> (Value, Value, Value, Value) {
    (
        json!("success"),
        Value::Null,
        json!("full"),
        json!("terminal"),
    )
}

/// Agent `agent`'s address, such as `a1@laptop`.
fn address(home: &TestHome, agent: &str) -> String {
    home.agent_record(agent).unwrap()["address"]
        .as_str()
        .unwrap()
        .to_string()
}

/// The receipt address of message `message` on the machine agent `agent` runs on, such as
/// `m1@laptop`.
fn receipt_id(home: &TestHome, agent: &str, message: &str) -> String {
    let address = address(home, agent);
    let (_, machine) = address.split_once('@').unwrap();
    format!("{message}@{machine}")
}

/// The fake CLI agent `agent`'s own Facade tools.
fn delivered(home: &TestHome, agent: &str, message: &str) -> String {
    let record = home.agent_record(agent).expect("the recipient");
    let address = record["address"].as_str().unwrap();
    let name = record["name"].as_str().unwrap();
    let machine = address.split_once('@').unwrap().1;
    format!("Delivered {message}@{machine} to {name} ({address}).")
}

fn tools_of(home: &TestHome, agent: &str) -> McpTestClient {
    McpTestClient::open_configured(home, agent)
}

/// Reads agent `agent`'s inbox through its own `read_messages` with `arguments`, and returns the
/// messages it gave.
fn read_messages(tools: &mut McpTestClient, arguments: Value) -> Vec<Value> {
    let read = tools.call("read_messages", arguments);
    assert_eq!(read["status"], "success", "{read}");
    read["data"]["messages"].as_array().unwrap().clone()
}

/// The IDs of `messages`, as `read_messages` gives them.
fn ids(messages: &[Value]) -> Vec<&str> {
    messages
        .iter()
        .map(|message| message["id"].as_str().unwrap())
        .collect()
}

/// Waits until message `number` is kept and waits for its recipient's input. Read from `facade.db`
/// itself: a read through Facade would deliver it, and a send's receipt comes only once it is
/// settled.
fn wait_pending(home: &TestHome, number: u64) {
    assert!(
        wait_until(secs(30), || kept(home, number)
            .is_some_and(|kept| kept.0 == "pending")),
        "#m{number} is not pending: {:?}\n{}",
        kept(home, number),
        home.daemon_log()
    );
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
/// managed relay replies using its inbox number. The sender still gets the full receipt address.
#[test]
fn a_message_is_typed_into_its_recipient_s_input_under_a_header_naming_its_sender() {
    let home = TestHome::new("send");
    let ada = home.start_named_fake("ada", &[]);
    let bob = home.start_named_fake("bob", &[]);
    let hello = home.hello_result().unwrap();
    home.run_facade_ok(&[
        "machine",
        "rename",
        hello["machine_id"].as_str().unwrap(),
        "laptop",
    ]);
    let mut ada_relay = McpTestClient::open_configured(&home, &ada.id);
    let mut bob_relay = McpTestClient::open_configured(&home, &bob.id);
    let ada_address = format!("{}@laptop", ada.id);
    let bob_address = format!("{}@laptop", bob.id);

    let from_command = facade_as(
        &home,
        "a9",
        &["send", "ada", "hi from the command line", "-w"],
    );
    assert!(from_command.status.success(), "{}", stderr(&from_command));
    assert_eq!(
        stdout(&from_command).trim(),
        delivered(&home, &ada.id, "m1")
    );
    let sent = bob_relay.call(
        "send_message",
        json!({ "to": ada_address, "text": "hi ada", "wait_for": "delivery", "timeout_seconds": 30 }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["id"], "m2@laptop", "{sent}");
    let inbox = ada_relay.call("read_messages", json!({ "last": 1 }));
    assert_eq!(inbox["status"], "success", "{inbox}");
    let original = &inbox["data"]["messages"][0];
    assert_eq!(original["id"], "m2", "{inbox}");
    assert_eq!(original["from"], bob_address, "{inbox}");
    assert_eq!(original["text"], "hi ada", "{inbox}");
    let reply = ada_relay.call(
        "send_message",
        json!({
            "to": original["from"], "text": "hi bob\nsecond line", "reply_to": original["id"],
            "wait_for": "delivery", "timeout_seconds": 30,
        }),
    );
    assert_eq!(reply["status"], "success", "{reply}");
    assert_eq!(reply["data"]["id"], "m3@laptop", "{reply}");
    assert!(wait_for_screen_text(&home, &bob.id, "second line"));
    assert_eq!(
        home.submitted_messages(),
        [
            "📨 Message m1 from command line\nhi from the command line ".to_owned(),
            format!("📨 Message m2 from bob ({bob_address})\nhi ada "),
            format!(
                "📨 Message m3 from ada ({ada_address}) · in reply to m2\nhi bob\nsecond line "
            ),
        ]
    );
    let screen = home.screen("bob");
    assert!(
        screen.contains(&format!(
            "> 📨 Message m3 from ada ({ada_address}) · in reply to m2\n  hi bob\n  second line"
        )),
        "the test CLI shows every line: {screen}"
    );
    let read = bob_relay.call("read_messages", json!({ "last": 1 }));
    assert_eq!(read["status"], "success", "{read}");
    let shown = &read["data"]["messages"][0];
    assert_eq!(shown["id"], "m3", "{read}");
    assert_eq!(shown["reply_to"], "m2", "{read}");

    let mut wire = connect(&home);
    let refused = wire.call(
        "agent.send",
        json!({ "to": bob_address, "text": "x", "reply_to": "m2" }),
    );
    assert_eq!(error_reason(&refused), "invalid_argument", "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("the command line has no inbox"),
        "{refused}"
    );
    let refused = ada_relay.call(
        "send_message",
        json!({ "to": bob_address, "text": "x", "reply_to": "m1" }),
    );
    assert_eq!(refused["status"], "failure", "{refused}");
    assert_eq!(refused["reason"], "invalid_argument", "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("the original message came from the command line"),
        "{refused}"
    );

    let refused = |output: Output| {
        assert!(!output.status.success(), "{}", stdout(&output));
        stderr(&output)
    };
    assert!(
        refused(home.run_facade(&["send", "ada", " \t"])).contains("Message text cannot be empty.")
    );
    assert!(
        refused(home.run_facade(&["send", "ada", "a\u{7}b"])).contains("control character U+0007")
    );
    for missing in ["nobody", "#human", "#HUMAN", "human", "@Human"] {
        let failure = wire.call("agent.send", json!({ "to": missing, "text": "x" }));
        assert_eq!(error_reason(&failure), "not_found", "{failure}");
        assert_eq!(
            failure["error"]["message"],
            format!("no agent {missing:?} was found")
        );
    }
    home.run_facade_ok(&["stop", &bob_address]);
    for target in [bob.id.as_str(), bob_address.as_str(), "bob"] {
        let failure = wire.call("agent.send", json!({ "to": target, "text": "x" }));
        assert_eq!(error_reason(&failure), "ended", "{failure}");
        assert!(
            failure["error"]["message"]
                .as_str()
                .unwrap()
                .contains(&bob_address),
            "{failure}"
        );
    }
    assert_eq!(
        home.submitted_messages().len(),
        3,
        "a refused message is never typed"
    );
    home.run_facade_ok(&["rename", &ada_address, "human"]);
    assert_eq!(
        home.run_facade_ok(&["send", "human", "an Agent named human", "-w"])
            .trim(),
        delivered(&home, &ada.id, "m4")
    );
    assert!(wait_for_screen_text(&home, &ada.id, "an Agent named human"));
}

/// A sender's name shows on its message's header line whatever it holds, so the recipient's CLI
/// takes the message whole, once.
#[test]
fn a_sender_s_name_cannot_break_out_of_its_message_s_header() {
    let home = TestHome::new("sendname");
    let evil = home.start_named_fake("evil\u{1b}[201~\rINJECTED", &[]);
    home.start_named_fake("bob", &[]);
    let sent = tools_of(&home, &evil.id).call(
        "send_message",
        json!({ "to": "bob", "text": "hi", "wait_for": "delivery", "timeout_seconds": 30 }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(
        home.submitted_messages(),
        [format!(
            "📨 Message m1 from evil [201~ INJECTED ({})\nhi ",
            address(&home, &evil.id)
        )]
    );
    let listed = home.run_facade_ok(&["list"]);
    assert!(
        !listed.contains('\u{1b}') && !listed.contains('\r') && listed.lines().count() == 3,
        "{listed:?}"
    );
}

/// A CLI that keeps the paste after Enter has taken no message. The receipt still records that
/// the text and Enter reached its terminal.
#[test]
fn a_send_fails_when_its_cli_keeps_the_draft_after_enter() {
    let home = TestHome::new("kept-after-enter");
    home.start_facade_with(&[("FACADE_TEST_DELIVERY_MS", "5000")]);
    home.start_named_fake("worker", &[("FAKECLI_IGNORE_ENTER", "1")]);
    let receipt = begin_send(&home, "worker", "still in the input", None).receipt();
    let delivery = &receipt["message"]["delivery"];
    assert_eq!(delivery["status"], "failure", "{receipt}");
    assert_eq!(delivery["reason"], "submission_unconfirmed", "{receipt}");
    assert_eq!(delivery["text_written"], "full", "{receipt}");
    assert_eq!(delivery["enter_written"], true, "{receipt}");
    assert!(home.submitted_messages().is_empty());
}

/// The CLI ignores its first Enter and takes the same paste on a later one.
#[test]
fn a_send_repeats_enter_when_its_cli_keeps_the_same_draft() {
    let home = TestHome::new("repeat-enter");
    let keys = home.folder().join("keys");
    home.start_named_fake(
        "worker",
        &[
            ("FAKECLI_IGNORE_FIRST_ENTER", "1"),
            ("FAKECLI_KEYS", keys.to_str().unwrap()),
        ],
    );
    let receipt = begin_send(&home, "worker", "send this once @worker", None).receipt();
    assert_eq!(delivery_of(&receipt), typed_in(), "{receipt}");
    let keys = std::fs::read(keys).unwrap();
    let tail = b"@worker \x1b[201~";
    let end = keys
        .windows(tail.len())
        .position(|part| part == tail)
        .unwrap()
        + tail.len();
    assert_eq!(keys[end..].iter().filter(|&&key| key == b'\r').count(), 2);
    let submitted = home.submitted_messages();
    assert_eq!(submitted.len(), 1, "{submitted:?}");
    assert!(submitted[0].ends_with("send this once @worker "));
}

/// A message a draft holds until its deadline fails, and its send says the draft held it.
#[test]
fn a_send_a_draft_held_until_its_deadline_says_so() {
    let home = TestHome::new("sendheld");
    let worker = home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let sent = home.run_facade(&["send", "worker", "hello", "-w"]);
    assert_eq!(sent.status.code(), Some(1));
    let said = stderr(&sent);
    assert!(
        said.starts_with(&format!(
            "error: Could not deliver {} to worker ({}). ",
            receipt_id(&home, &worker.id, "m1"),
            worker.address
        )) && said.contains("Its terminal has an unfinished draft.")
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
    let send = begin_send(&home, "worker", "hello", None);
    wait_pending(&home, 1);
    // The person clears the draft; keys go before a message waiting for the input.
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    let receipt = send.receipt();
    assert_eq!(receipt["message"]["message_id"], "m1", "{receipt}");
    assert_eq!(delivery_of(&receipt), typed_in(), "{receipt}");
    assert_eq!(
        receipt["message"]["delivery"]["enter_written"], true,
        "{receipt}"
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message m1 from command line\nhello "],
        "the draft was never typed over"
    );
}

/// A CLI at work redraws frame after frame, and a frame reaches Facade in pieces. Messages go in one
/// after the other all the same. The test CLI redraws whenever it reads something; the question in
/// its name, which its terminal answers, has it redraw without a pause.
#[test]
fn messages_go_into_a_cli_that_redraws_without_a_pause() {
    for sync in ["0", "1"] {
        let home = TestHome::new("busyredraw");
        let keys = home.folder().join("keys");
        std::fs::write(&keys, []).unwrap();
        let worker = home.start_fake_with(
            "worker",
            &[
                ("FAKECLI_NAME", "worker\u{1b}[c"),
                ("FAKECLI_SYNC", sync),
                ("FAKECLI_KEYS", keys.to_str().unwrap()),
            ],
        );
        let answers = || {
            let read = std::fs::read(&keys).unwrap();
            read.windows(3).filter(|bytes| bytes == b"\x1b[?").count()
        };
        let drawn = answers();
        let sends: Vec<Sending> = (1..=5)
            .map(|number| begin_send(&home, &worker.id, &format!("{number}\nof five"), None))
            .collect();
        for send in sends {
            let receipt = send.receipt();
            assert_eq!(delivery_of(&receipt), typed_in(), "sync {sync}: {receipt}");
        }
        let drawn = answers() - drawn;
        assert!(drawn > 20, "sync {sync}: it drew {drawn} frames");
        // A send is answered once its message's Enter is written, and the CLI reads that next.
        wait_until(secs(10), || home.submitted_messages().len() >= 5);
        let submitted = home.submitted_messages();
        let mut texts: Vec<&str> = submitted
            .iter()
            .filter_map(|message| Some(message.split_once('\n')?.1))
            .collect();
        texts.sort();
        let expected: Vec<String> = (1..=5).map(|number| format!("{number}\nof five")).collect();
        let pasted: Vec<_> = expected.iter().map(|text| format!("{text} ")).collect();
        assert_eq!(texts, pasted, "sync {sync}: {submitted:?}");
    }
}

/// Opens the person's window on agent `agent`: `facade attach` in a terminal of its own.
fn attached(home: &TestHome, agent: &str) -> TestTerminal {
    let term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", agent]),
        80,
        24,
    );
    assert!(
        term.wait_for(secs(30), |text| text.contains('❯')),
        "{}",
        term.text()
    );
    term
}

/// Starts a send of `text` to the paused agent `to` and waits until its paste, message `number`,
/// has begun: the CLI has not read it.
fn begin_paste(home: &TestHome, to: &str, text: &str, number: u64) -> Sending {
    let send = begin_send(home, to, text, None);
    assert!(
        wait_until(secs(30), || kept(home, number)
            .is_some_and(|kept| kept.4.is_some())),
        "#m{number}'s paste has not begun: {:?}",
        kept(home, number)
    );
    send
}

/// What a terminal reports with nothing typed does not stop a message that is going in: the wheel,
/// a mouse move, the focus, a modifier alone and a key let go. An attached terminal's focus reports
/// come the same way.
#[test]
fn a_message_goes_in_whatever_the_person_s_terminal_reports_meanwhile() {
    let home = TestHome::new("sendreports");
    let worker = home.start_named_fake("worker", &[]);
    let term = attached(&home, "worker");
    let mut wire = connect(&home);
    let reports = [
        ("the wheel", "\x1b[<64;6;8M"),
        ("a mouse move", "\x1b[<35;6;8M"),
        ("the focus", "\x1b[O\x1b[I"),
        (
            "a modifier alone",
            "\x1b[16;42;0;1;16;1_\x1b[16;42;0;0;0;1_",
        ),
        ("a key let go", "\x1b[13;28;13;0;0;1_"),
        ("the focus of an attached terminal", ""),
    ];
    for (index, (what, report)) in reports.into_iter().enumerate() {
        pause_process(worker.pid);
        let send = begin_paste(&home, "worker", what, index as u64 + 1);
        if report.is_empty() {
            term.send(b"\x1b[O\x1b[I");
            std::thread::sleep(std::time::Duration::from_millis(300));
        } else {
            type_raw(&mut wire, &worker.id, report);
        }
        resume_process(worker.pid);
        let receipt = send.receipt();
        assert_eq!(delivery_of(&receipt), typed_in(), "{what}: {receipt}");
        // Its Enter is written, and the CLI reads that and empties its input next.
        assert!(
            wait_until(secs(30), || home.submitted_messages().len() > index
                && home.inspect_agent("worker")["input"]["state"] == "usable"),
            "{what}: {}",
            home.screen("worker")
        );
    }
    let messages: Vec<String> = (1..=reports.len())
        .map(|number| {
            format!(
                "📨 Message m{number} from command line\n{} ",
                reports[number - 1].0
            )
        })
        .collect();
    assert_eq!(home.submitted_messages(), messages);
}

/// A message that waits behind the person's draft goes in once they submit it, though their Enter
/// key comes up, and their terminal reports its focus, while it goes in.
#[test]
fn a_message_goes_in_behind_the_draft_the_person_submits() {
    let home = TestHome::new("sendbehind");
    let worker = home.start_named_fake("worker", &[]);
    let term = attached(&home, "worker");
    let mut wire = connect(&home);
    term.send(b"my own prompt");
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯ my own prompt")),
        "{}",
        term.text()
    );
    let send = begin_send(&home, "worker", "hello", None);
    wait_pending(&home, 1);
    term.send(b"\r");
    for _ in 0..12 {
        type_raw(&mut wire, &worker.id, "\x1b[13;28;13;0;0;1_");
        term.send(b"\x1b[I");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let receipt = send.receipt();
    assert_eq!(delivery_of(&receipt), typed_in(), "{receipt}");
    wait_until(secs(30), || home.submitted_messages().len() >= 2);
    assert_eq!(
        home.submitted_messages(),
        ["my own prompt", "📨 Message m1 from command line\nhello "]
    );
}

/// What the person types while a message goes in follows it: the message is submitted alone, and
/// their text is their own draft afterwards, every key in order, Ctrl+C with its effect.
#[test]
fn text_typed_while_a_message_goes_in_stays_the_person_s_own() {
    let home = TestHome::new("sendtyped");
    let keys = home.folder().join("keys");
    let worker = home.start_named_fake("worker", &[("FAKECLI_KEYS", keys.to_str().unwrap())]);
    let mut wire = connect(&home);
    let inspected = wire.call_ok("agent.inspect", json!({ "target": worker.id }));
    let target = &inspected["agent"]["reference"];
    let paused_at = std::time::Instant::now();
    pause_process(worker.pid);
    let send = begin_paste(&home, "worker", "hello", 1);
    // Typing calls on one connection reach this target in order. Send the burst before
    // polling for replies so the CLI can resume within the paste's bounded hold.
    // The CSI-u Escape stays a separate key even when the CLI reads it together with Enter.
    let requests = [
        "w", "r", "o", "n", "g", "\x03", "m", "i", "n", "e", "\x1b[27u",
    ]
    .map(|key| {
        let raw = facade_base::base64::encode(key.as_bytes());
        wire.send(
            "call",
            json!({ "op": "agent.type", "args": {
                "target": target, "input": { "kind": "raw", "raw": raw }
            } }),
        )
    });
    for id in requests {
        let typed = wire
            .wait_for_response(id, LOADED_TIMEOUT)
            .expect("the agent accepted a key");
        assert!(typed["result"].is_object(), "{typed}");
    }
    let paused_for = paused_at.elapsed();
    resume_process(worker.pid);
    let receipt = send.receipt();
    assert_eq!(
        delivery_of(&receipt),
        typed_in(),
        "{receipt}\nCLI paused for {paused_for:?}, keys read: {:?}\n{}",
        std::fs::read_to_string(&keys),
        home.screen("worker")
    );
    assert!(
        wait_for_screen_text(&home, "worker", "❯ mine"),
        "{}",
        home.screen("worker")
    );
    let message = "📨 Message m1 from command line\nhello ";
    assert_eq!(home.submitted_messages(), [message], "the message alone");
    assert!(
        wait_until(secs(5), || std::fs::read(&keys)
            .unwrap()
            .ends_with(b"\rwrong\x03mine\x1b[27u")),
        "{:?}",
        String::from_utf8_lossy(&std::fs::read(&keys).unwrap())
    );
    type_raw(&mut wire, &worker.id, "\r");
    assert!(
        wait_until(secs(5), || home.submitted_messages().len() == 2),
        "{}",
        home.screen("worker")
    );
    assert_eq!(home.submitted_messages(), [message, "mine"]);
}

/// Messages keep going in between the lines a person types and submits, each alone, and every line
/// is submitted as it was typed.
#[test]
fn messages_and_a_person_s_lines_go_in_one_at_a_time() {
    let home = TestHome::new("sendlines");
    home.start_named_fake("worker", &[]);
    let term = attached(&home, "worker");
    let sends: Vec<Sending> = (0..12)
        .map(|n| begin_send(&home, "worker", &format!("message {n}"), None))
        .collect();
    let lines: Vec<String> = (0..4).map(|n| format!("line {n} of mine")).collect();
    for line in &lines {
        for key in line.bytes() {
            term.send(&[key]);
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        term.send(b"\r");
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    for send in sends {
        let receipt = send.receipt();
        assert_eq!(delivery_of(&receipt), typed_in(), "{receipt}");
    }
    wait_until(secs(30), || home.submitted_messages().len() >= 16);
    let submitted = home.submitted_messages();
    let typed: Vec<&String> = submitted
        .iter()
        .filter(|text| !text.starts_with("📨"))
        .collect();
    assert_eq!(typed, lines.iter().collect::<Vec<_>>(), "{submitted:?}");
    let messages = submitted
        .iter()
        .filter(|text| text.starts_with("📨") && !text.contains("of mine"))
        .count();
    assert_eq!(messages, 12, "{submitted:?}");
}

/// Reading a message that waits for the input delivers it: its sender learns it was read, and it is
/// never typed.
#[test]
fn a_read_delivers_a_waiting_message_so_it_is_never_typed() {
    let home = TestHome::new("sendread");
    let worker = home.start_named_fake("worker", &[]);
    let other = home.start_named_fake("other", &[]);
    type_draft(&home, "worker", "my draft");
    let mut tools = tools_of(&home, &worker.id);
    // A message to another agent is not in this inbox.
    assert_eq!(
        home.run_facade_ok(&["send", "other", "not for a1", "-w"])
            .trim(),
        delivered(&home, &other.id, "m1")
    );
    let send = begin_send(&home, "worker", "read me", None);
    wait_pending(&home, 2);
    let refused = tools.call("read_messages", json!({ "timeout_seconds": 30 }));
    assert_eq!(refused["status"], "failure", "{refused}");
    assert_eq!(refused["reason"], "unsupported", "{refused}");
    assert_eq!(
        refused["message"],
        "read_messages cannot wait in this managed run. This call did not check your inbox. \
         End this turn so Facade can deliver incoming messages to your input."
    );
    let read = read_messages(&mut tools, json!({}));
    assert_eq!(
        read,
        [json!({ "id": "m2", "from": "command_line", "at": read[0]["at"], "text": "read me" })]
    );
    let receipt = send.receipt();
    assert_eq!(
        delivery_of(&receipt),
        (json!("success"), Value::Null, json!("none"), json!("read")),
        "{receipt}"
    );
    // The draft clears and a later message goes in alone: the one read was dropped from the typist.
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "next", "-w"]).trim(),
        delivered(&home, &worker.id, "m3")
    );
    assert_eq!(
        home.submitted_messages(),
        [
            "📨 Message m1 from command line\nnot for a1 ",
            "📨 Message m3 from command line\nnext "
        ]
    );
    assert!(
        read_messages(&mut tools, json!({})).is_empty(),
        "nothing is returned twice"
    );
    assert_eq!(
        ids(&read_messages(&mut tools, json!({ "last": 10 }))),
        ["m2", "m3"],
        "the inbox holds what was read and what was typed, and nothing sent elsewhere"
    );
}

#[test]
fn rename_trims_a_name_and_gives_a_blank_one_a_default() {
    let home = TestHome::new("rename");
    let worker = home.start_named_fake("worker", &[]);
    home.start_named_fake("other", &[]);
    let worker_address = address(&home, &worker.id);
    let original = home.inspect_agent(&worker_address);
    let reference = &original["agent"]["reference"];
    let mut agents = DaemonTestClient::open(&home);
    agents.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    let watch =
        agents.request("watch", json!({ "topic": "agents", "args": {} }))["result"]["watch"]
            .as_u64()
            .unwrap();
    assert_eq!(
        home.run_facade_ok(&["rename", &worker_address, "  Neo  "]),
        format!("Renamed \"worker\" to \"Neo\" ({worker_address}).\n")
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
    let table = home.list_table();
    assert!(
        table
            .row("NAME", "Neo")
            .is_some_and(|row| table.cell(row, "REFERENCE") == worker_address),
        "{table:?}"
    );
    let shell_readback = home.run_facade_ok(&["status", &worker_address]);
    assert_eq!(
        shell_readback.lines().next().unwrap(),
        format!("Neo ({worker_address})")
    );
    let sent = tools_of(&home, &worker.id).call(
        "send_message",
        json!({ "to": "other", "text": "hi", "wait_for": "delivery", "timeout_seconds": 30 }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(
        home.submitted_messages(),
        [format!("📨 Message m1 from Neo ({worker_address})\nhi ")],
        "a message carries its sender's name when it was sent"
    );
    let blank = home.run_facade(&["rename", "a1", " "]);
    assert_eq!(blank.status.code(), Some(2));
    assert!(blank.stdout.is_empty());
    assert!(
        stderr(&blank).contains("Agent name cannot be empty."),
        "{}",
        stderr(&blank)
    );
    assert_eq!(home.agent_record("a1").unwrap()["name"], "Neo");

    let chosen = agents.call_ok(
        "agent.rename",
        json!({ "target": reference, "name": "Renamed over the API" }),
    );
    assert_eq!(chosen["agent"]["reference"], *reference, "{chosen}");
    assert_eq!(chosen["agent"]["name"], "Renamed over the API", "{chosen}");
    let read_back = agents.call_ok("agent.inspect", json!({ "target": reference }));
    assert_eq!(read_back["agent"]["reference"], *reference, "{read_back}");
    assert_eq!(read_back["agent"]["address"], worker_address, "{read_back}");
    assert_eq!(
        read_back["agent"]["name"], "Renamed over the API",
        "{read_back}"
    );
    assert_eq!(read_back["agent"]["pid"], worker.pid, "{read_back}");
    let renamed = agents.call_ok("agent.rename", json!({ "target": "a1", "name": " " }));
    let name = renamed["agent"]["name"]
        .as_str()
        .expect("the replacement name");
    assert!(
        !name.is_empty() && name != "Neo" && name != "Renamed over the API",
        "{renamed}"
    );
    assert_eq!(
        home.agent_from_watch(name).unwrap()["reference"]["agent_id"],
        "a1"
    );
    let unknown = home.run_facade(&["rename", "nobody", "x"]);
    assert!(
        unknown.status.code() == Some(1)
            && stderr(&unknown)
                == "error: No agent or guest matches \"nobody\".\nRun 'facade list' to find an agent.\n",
        "{}",
        stderr(&unknown)
    );
}

/// Message records live in the daemon's memory, but their numbers come from the store: a new daemon
/// never gives one twice.
#[test]
fn message_numbers_are_never_given_twice_across_daemons() {
    let home = TestHome::new("sendnumbers");
    let worker = home.start_named_fake("worker", &[]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "first", "-w"])
            .trim(),
        delivered(&home, &worker.id, "m1")
    );
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "second", "-w"])
            .trim(),
        delivered(&home, &worker.id, "m2")
    );
}

/// A `facade` command run in an agent's terminal acts as the command line, whatever of the agent it
/// finds there: its `FACADE_AGENT`, or the session its CLI names. Its message is signed by the
/// command line.
#[test]
fn a_command_in_an_agent_s_terminal_acts_as_the_command_line() {
    let home = TestHome::new("actsfor");
    let session = "0a1b2c3d-1111-2222-3333-444455556666";
    let worker = home.start_named_fake("worker", &[("FAKECLI_SESSION", session)]);
    home.start_named_fake("other", &[]);
    assert!(
        wait_until(secs(10), || home
            .agent_record(&worker.id)
            .is_some_and(|agent| agent["session"] == session)),
        "{:?}",
        home.agent_record(&worker.id)
    );
    let sent = home
        .command(&test_binaries().facade)
        .env("FACADE_AGENT", &worker.id)
        .env("CODEX_SESSION_ID", session)
        .args(["send", "other", "from a terminal", "-w"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(sent.status.success(), "{}", stderr(&sent));
    assert!(
        wait_until(secs(30), || !home.submitted_messages().is_empty()),
        "the receiving CLI records the submitted message"
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message m1 from command line\nfrom a terminal "]
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

#[test]
fn shell_send_saves_behind_a_draft_and_waits_for_delivery_when_requested() {
    let home = TestHome::new("shell-send-modes");
    let worker = home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");

    let saved = home.run_facade(&["send", "worker", "saved behind the draft"]);
    assert_eq!(saved.status.code(), Some(0), "{}", stderr(&saved));
    assert!(saved.stderr.is_empty(), "{}", stderr(&saved));
    let id = receipt_id(&home, &worker.id, "m1");
    let recipient = address(&home, &worker.id);
    assert_eq!(
        stdout(&saved),
        format!("Saved {id} in worker ({recipient})'s inbox.\n")
    );
    assert!(home.submitted_messages().is_empty());
    assert!(home.screen("worker").contains("my draft"));

    home.run_facade_ok(&["type", "worker", "-k", "Ctrl+C"]);
    let waited = home.run_facade(&["send", "worker", "waited for delivery", "-w"]);
    assert_eq!(waited.status.code(), Some(0), "{}", stderr(&waited));
    assert!(waited.stderr.is_empty(), "{}", stderr(&waited));
    assert_eq!(
        stdout(&waited),
        format!("{}\n", delivered(&home, &worker.id, "m2"))
    );
    assert!(wait_for_screen_text(&home, "worker", "waited for delivery"));
    assert_eq!(
        home.submitted_messages(),
        [
            "📨 Message m1 from command line\nsaved behind the draft ",
            "📨 Message m2 from command line\nwaited for delivery ",
        ]
    );
}

#[test]
fn shell_receives_only_the_first_linked_reply_from_the_managed_recipient() {
    let home = TestHome::new("shell-send-managed-reply");
    let worker = home.start_named_fake("worker", &[]);
    let other = home.start_named_fake("other", &[]);
    let machine = home.hello_result().unwrap()["machine_id"]
        .as_str()
        .unwrap()
        .to_owned();
    home.run_facade_ok(&["machine", "rename", &machine, "desk"]);
    let mut worker_tools = tools_of(&home, &worker.id);
    let mut other_tools = tools_of(&home, &other.id);

    let request = "请检查构建\n\n  Keep the indentation.";
    let shell = send_in_background(&home, &["worker", request, "-r"]);
    // Wait for the terminal submission and the inbox entry before sending a linked reply.
    let mut inbox = Vec::new();
    assert!(
        wait_until(secs(10), || {
            if home.submitted_messages().is_empty() {
                return false;
            }
            inbox = read_messages(&mut worker_tools, json!({"last": 1}));
            !inbox.is_empty()
        }),
        "{}",
        home.daemon_log()
    );
    assert_eq!(inbox.len(), 1, "{inbox:?}");
    let original = &inbox[0];
    assert_eq!(original["id"], "m1", "{original}");
    assert_eq!(original["from"], "#c1@desk", "{original}");
    assert_eq!(original["text"], request, "{original}");
    assert_eq!(
        home.submitted_messages(),
        [format!(
            "📨 Message m1 from command line (#c1@desk)\n{request} "
        )]
    );

    let reply = "完成 ✓\n\n  Second line";
    let linked = json!({"to": original["from"], "reply_to": original["id"], "text": reply});
    let wrong_actor = other_tools.call("send_message", linked.clone());
    assert_eq!(wrong_actor["status"], "failure", "{wrong_actor}");
    let mismatched = worker_tools.call(
        "send_message",
        json!({
            "to": "#c2@desk", "reply_to": original["id"], "text": "wrong link",
        }),
    );
    assert_eq!(mismatched["reason"], "invalid_argument", "{mismatched}");

    let sent = worker_tools.call("send_message", linked.clone());
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["delivery"], "returned_to_request", "{sent}");
    let output = output_within(shell, secs(10)).expect("the linked reply ends the command");
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert!(output.stderr.is_empty(), "{}", stderr(&output));
    assert_eq!(output.stdout, reply.as_bytes());

    let duplicate = worker_tools.call("send_message", linked);
    assert_eq!(duplicate["status"], "failure", "{duplicate}");
    assert_eq!(duplicate["reason"], "ended", "{duplicate}");
}

#[test]
fn a_guest_can_answer_shell_and_a_late_reply_exceeds_the_same_delivery_and_reply_budget() {
    use std::time::Instant;

    let home = TestHome::new("shell-send-guest");
    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let roster = guest.call("list_agents", json!({}));
    assert_eq!(roster["status"], "success", "{roster}");
    let guest_address = roster["data"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["type"] == "guest")
        .expect("the isolated Guest")["id"]
        .as_str()
        .unwrap();
    let machine = home.hello_result().unwrap()["machine_id"]
        .as_str()
        .unwrap()
        .to_owned();
    home.run_facade_ok(&["machine", "rename", &machine, "desk"]);
    let (guest_id, _) = guest_address.split_once('@').unwrap();
    let target = format!("{guest_id}@desk");

    let mut shell = send_in_background(&home, &[&target, "answer in UTF-8", "-r"]);
    let inbox = read_messages(&mut guest, json!({"timeout_seconds": 10}));
    assert_eq!(inbox.len(), 1, "{inbox:?}");
    assert_eq!(inbox[0]["id"], "m1");
    assert_eq!(inbox[0]["from"], "#c1@desk");
    assert_eq!(inbox[0]["text"], "answer in UTF-8");
    assert!(
        shell.try_wait().unwrap().is_none(),
        "reading only completes delivery"
    );
    let reply = "café ☕\n下一行\n";
    let sent = guest.call(
        "send_message",
        json!({
            "to": inbox[0]["from"], "reply_to": inbox[0]["id"], "text": reply,
        }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["delivery"], "returned_to_request", "{sent}");
    let output = output_within(shell, secs(10)).expect("the Guest reply ends the command");
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert!(output.stderr.is_empty(), "{}", stderr(&output));
    assert_eq!(output.stdout, reply.as_bytes());

    let began = Instant::now();
    let shell = send_in_background(
        &home,
        &[&target, "read late in the budget", "-r", "-t", "6"],
    );
    // Leave half of the six seconds for delivery, then read without answering.
    std::thread::sleep(secs(3));
    let inbox = read_messages(&mut guest, json!({"timeout_seconds": 2}));
    assert_eq!(inbox.len(), 1, "{inbox:?}");
    assert_eq!(inbox[0]["from"], "#c3@desk");
    assert_eq!(inbox[0]["id"], "m3");
    assert_eq!(inbox[0]["text"], "read late in the budget");
    let remaining = secs(8).saturating_sub(began.elapsed());
    let output =
        output_within(shell, remaining).expect("delivery and reply share the six-second budget");
    assert!(
        began.elapsed() >= secs(5),
        "the reply wait ended before its deadline"
    );
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(output.stdout.is_empty(), "{}", stdout(&output));
    assert_eq!(
        stderr(&output),
        format!("error: No reply to m3@{machine} within 6 seconds. The message was delivered.\n")
    );
    let late = guest.call(
        "send_message",
        json!({
            "to": inbox[0]["from"], "reply_to": inbox[0]["id"], "text": "too late",
        }),
    );
    assert_eq!(late["status"], "failure", "{late}");
    assert_eq!(late["reason"], "ended", "{late}");
}

fn cancel_send_at(home: &TestHome, gate: &str, wait_for: Option<&str>) -> Value {
    home.start_facade_with(&[("FACADE_TEST_GATES", gate)]);
    home.start_named_fake("worker", &[]);
    let mut args = json!({
        "to": "worker", "text": "cancel the send", "request_id": "cancel-send", "time_left_ms": 15_000,
    });
    if let Some(wait_for) = wait_for {
        args["wait_for"] = json!(wait_for);
    }
    let mut shell = connect(home);
    let send = shell.send("call", json!({"op": "agent.send", "args": args}));
    home.wait_for_gate(gate);
    let cancelled = shell.request("cancel", json!({"id": send}));
    home.release_gate(gate);
    assert_eq!(cancelled["result"], json!({}), "{cancelled}");
    let reply = shell
        .wait_for_response(send, secs(10))
        .expect("the interrupted send answers");
    assert_eq!(error_reason(&reply), "cancelled", "{reply}");
    reply
}

#[test]
fn an_explicit_send_cancelled_before_paste_keeps_its_assigned_reference() {
    let home = TestHome::new("shell-send-early-cancel");
    let reply = cancel_send_at(&home, "before-paste-begins", Some("delivery"));
    let machine = &home.hello_result().unwrap()["machine_id"];
    let details = &reply["error"]["data"]["details"];
    assert!(home.submitted_messages().is_empty());
    assert!(details.get("delivered_via").is_none(), "{reply}");
    assert_eq!(
        details["message_ref"],
        json!({"message_id": "m1", "machine_id": machine}),
        "{reply}"
    );
}

#[test]
fn a_legacy_send_cancelled_before_paste_omits_delivery_facts() {
    let home = TestHome::new("legacy-send-early-cancel");
    let reply = cancel_send_at(&home, "before-paste-begins", None);
    let details = &reply["error"]["data"]["details"];
    assert!(home.submitted_messages().is_empty());
    assert!(details.get("message_ref").is_none(), "{reply}");
    assert!(details.get("delivered_via").is_none(), "{reply}");
}

#[test]
fn a_result_wait_interrupted_after_delivery_reports_both_facts() {
    let home = TestHome::new("shell-send-late-cancel");
    let reply = cancel_send_at(&home, "before-send-answer", Some("result"));
    let machine = &home.hello_result().unwrap()["machine_id"];
    let details = &reply["error"]["data"]["details"];
    assert_eq!(
        details["message_ref"],
        json!({"message_id": "m1", "machine_id": machine}),
        "{reply}"
    );
    assert_eq!(details["delivered_via"], "terminal", "{reply}");
    assert_eq!(home.submitted_messages().len(), 1);
}

#[test]
fn a_result_wait_that_times_out_after_delivery_reports_both_facts() {
    let home = TestHome::new("shell-send-wire-timeout");
    home.start_named_fake("worker", &[]);
    let machine = &home.hello_result().unwrap()["machine_id"];
    let answer = connect(&home).call(
        "agent.send",
        json!({
            "to": "worker", "text": "deliver without an answer", "wait_for": "result",
            "request_id": "no-reply", "time_left_ms": 3_000,
        }),
    );
    assert_eq!(error_reason(&answer), "reply_timeout", "{answer}");
    let details = &answer["error"]["data"]["details"];
    assert_eq!(
        details["message_ref"],
        json!({"message_id": "m1", "machine_id": machine}),
        "{answer}"
    );
    assert_eq!(details["delivered_via"], "terminal", "{answer}");
    assert_eq!(home.submitted_messages().len(), 1);
}

/// A delivery to a CLI that never reads its input fails by its deadline without Enter. Saturated
/// Unix input leaves the first paste unissued, while ConPTY accepts it into the host. The second
/// message withdraws without typing. If the CLI starts reading again, the next message goes in
/// only after any paste that reached the terminal is erased.
#[test]
fn a_message_to_a_cli_that_reads_no_input_fails_within_30_seconds_and_is_never_submitted() {
    let home = TestHome::new("sendunread");
    let deaf = home.start_named_fake("deaf", &[("FAKECLI_IGNORE_INPUT", "1")]);
    let mut wire = connect(&home);
    let target = home.inspect_agent(&deaf.id)["agent"]["reference"].clone();
    let waiting = wire.call(
        "agent.type",
        json!({
            "target": target, "input": {
                "kind": "raw", "raw": facade_base::base64::encode(&vec![b'w'; 960 * 1024]),
            },
        }),
    );
    assert!(waiting["result"].is_object(), "{waiting}");
    let started = std::time::Instant::now();
    let send = begin_send(&home, "deaf", &"x".repeat(4000), None);
    // A second message waits behind the first's stuck paste: nothing of it is typed, so it is
    // withdrawn at its deadline.
    std::thread::sleep(secs(1));
    let second_started = std::time::Instant::now();
    let second = begin_send(&home, "deaf", "behind", None);
    let sent = send.receipt();
    let delivery = &sent["message"]["delivery"];
    let took = started.elapsed();
    assert!(
        sent["message"]["message_id"] == "m1"
            && delivery["status"] == "failure"
            && took < std::time::Duration::from_millis(30_500),
        "answered after {took:?}: {sent}"
    );
    let behind = second.receipt();
    let took = second_started.elapsed();
    assert!(
        took < std::time::Duration::from_millis(30_500),
        "answered after {took:?}: {behind}"
    );
    assert_eq!(
        (
            &behind["withdrawn"],
            &behind["message"]["message_id"],
            &behind["message"]["delivery"]["status"],
            &behind["message"]["delivery"]["text_written"]
        ),
        (
            &json!(true),
            &json!("m2"),
            &json!("failure"),
            &json!("none")
        ),
        "m1 delivery: {delivery}, m2 receipt: {behind}"
    );
    #[cfg(unix)]
    let first = (json!(true), json!("timeout"), json!("none"));
    #[cfg(windows)]
    let first = (Value::Null, json!("submission_unconfirmed"), json!("full"));
    assert_eq!(
        (
            &sent["withdrawn"],
            &delivery["reason"],
            &delivery["text_written"],
            &delivery["enter_written"],
        ),
        (&first.0, &first.1, &first.2, &json!(false)),
        "{sent}"
    );
    assert!(home.submitted_messages().is_empty());
    a_late_paste_is_erased_before_the_next_message();
}

fn a_late_paste_is_erased_before_the_next_message() {
    let home = TestHome::new("sendlateread");
    home.start_facade_with(&[("FACADE_TEST_DELIVERY_MS", "5000")]);
    let read_gate = home.folder().join("read-input");
    let keys = home.folder().join("keys");
    home.start_named_fake(
        "worker",
        &[
            ("FAKECLI_READ_GATE", read_gate.to_str().unwrap()),
            ("FAKECLI_KEYS", keys.to_str().unwrap()),
        ],
    );
    let first_text = "expired first message";
    let second_text = "the next message";
    let first = begin_send(&home, "worker", first_text, None).receipt();
    assert_eq!(
        (
            &first["message"]["message_id"],
            &first["message"]["delivery"]["status"],
            &first["message"]["delivery"]["enter_written"],
        ),
        (&json!("m1"), &json!("failure"), &json!(false)),
        "{first}"
    );
    assert!(std::fs::read(&keys).unwrap().is_empty());

    let second = begin_send(&home, "worker", second_text, None);
    wait_pending(&home, 2);
    std::fs::write(read_gate, []).unwrap();
    let second = second.receipt();
    assert_eq!(second["message"]["message_id"], "m2", "{second}");
    assert_eq!(delivery_of(&second), typed_in(), "{second}");
    assert!(wait_until(secs(5), || !home
        .submitted_messages()
        .is_empty()));
    assert_eq!(
        home.submitted_messages(),
        [format!("📨 Message m2 from command line\n{second_text} ")]
    );

    let keys = std::fs::read(keys).unwrap();
    let position = |text: &str| {
        keys.windows(text.len())
            .position(|bytes| bytes == text.as_bytes())
            .expect("the fake read the paste")
    };
    let after_first = position(first_text) + first_text.len();
    let before_second = position(second_text);
    assert!(
        after_first < before_second
            && keys[after_first..before_second]
                .iter()
                .any(|key| matches!(key, 0x7f | 0x08)),
        "the fake must read the first paste and its erasure before the second paste"
    );
}

/// A recipient removed while a send waits for its answer takes the message's record with it: the
/// send still answers, with the message as it was settled.
#[test]
fn a_send_whose_recipient_is_removed_before_its_answer_still_answers() {
    let home = TestHome::new("sendremoved");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-send-answer")]);
    let worker = home.start_named_fake("worker", &[]);
    let receipt = delivered(&home, &worker.id, "m1");
    let send = send_in_background(&home, &["worker", "hello", "-w"]);
    home.wait_for_gate("before-send-answer");
    home.remove_agent("worker");
    home.release_gate("before-send-answer");
    let sent = output_within(send, secs(10)).expect("facade send answers");
    assert_eq!(stdout(&sent).trim(), receipt, "{}", stderr(&sent));
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
        .args(["start", "-d", "--name", "slow", "agy"])
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    home.start_named_fake("quick", &[]);
    let lines = |count: usize| vec!["x"; count].join("\n");
    for agent in ["slow", "quick"] {
        let refused = home.run_facade(&["send", agent, &lines(541)]);
        assert_eq!(refused.status.code(), Some(2), "{}", stdout(&refused));
        assert!(
            stderr(&refused).contains(
                "Message is too long (1,081 characters, 541 lines). Maximum is 8,000 characters and 540 lines."
            ),
            "{}",
            stderr(&refused)
        );
    }
    // The longest is taken, under the first number: the refusals kept none and took no number.
    let taken = begin_send(&home, "slow", &lines(540), None);
    assert!(
        !taken.answered_within(std::time::Duration::from_millis(100)),
        "it is being delivered"
    );
    let receipt = taken.receipt();
    assert_eq!(receipt["message"]["message_id"], "m1", "{receipt}");
}

/// What the store keeps of message `number`: its status, its reason, how much of it was typed, how
/// it was delivered, and the paste it went in. None where it is not kept, or only its outcome is,
/// for a repeat of its send. Read from `facade.db` itself, since a read through Facade would
/// deliver the message.
type Kept = (String, Option<String>, String, Option<String>, Option<i64>);

fn kept(home: &TestHome, number: u64) -> Option<Kept> {
    let connection = rusqlite::Connection::open(home.path.join("framework/facade.db")).ok()?;
    connection
        .query_row(
            "SELECT status, reason, text_written, delivered_via, paste FROM messages \
             WHERE number = ?1 AND withdrawn = 0 AND private_receipt = 0",
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
/// it keeps while the message is pending. A send's receipt omits the deadline once it is settled.
fn time_to_deliver(home: &TestHome, number: u64) -> Option<std::time::Duration> {
    let connection = rusqlite::Connection::open(home.path.join("framework/facade.db")).ok()?;
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

/// Waits until the daemon stopped itself at debug pause point `point`, kills it there as a crash
/// would, and waits for the next daemon the keeper starts.
fn crash_at(home: &TestHome, point: &str) {
    assert!(
        wait_until(secs(30), || home
            .path
            .join(format!("framework/paused-at-{point}"))
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

/// Messages outlive their daemon. A read message and a typed one keep what became of them across a
/// crash, the inbox pages on from a message read before, and numbers go on. A message to a custom
/// program is refused before it is kept or numbered.
#[test]
fn messages_and_what_became_of_them_outlive_their_daemon() {
    let home = TestHome::new("restartkept");
    // A send, a crash and the next daemon's recovery can take a loaded machine longer than a send's
    // 29.5 seconds.
    home.start_facade_with(&[("FACADE_TEST_DELIVERY_MS", "120000")]);
    let worker = home.start_named_fake("worker", &[]);
    let mut wire = connect(&home);
    start_script(&mut wire, &home, "plain", "sleep 600");
    type_draft(&home, "worker", "my draft");
    let mut tools = tools_of(&home, &worker.id);
    let read = begin_send(&home, "worker", "read me", None);
    wait_pending(&home, 1);
    assert_eq!(ids(&read_messages(&mut tools, json!({}))), ["m1"]);
    assert_eq!(delivery_of(&read.receipt()).3, "read");
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "typed", "-w"])
            .trim(),
        delivered(&home, &worker.id, "m2")
    );
    let refused = wire.call("agent.send", json!({ "to": "plain", "text": "no reader" }));
    assert_eq!(error_reason(&refused), "unsupported", "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cannot receive messages"),
        "{refused}"
    );
    let before = read_messages(&mut tools, json!({ "last": 10 }));
    assert_eq!(ids(&before), ["m1", "m2"]);
    drop(tools);
    crash(&home);
    let mut tools = tools_of(&home, &worker.id);
    assert_eq!(
        read_messages(&mut tools, json!({ "last": 10 })),
        before,
        "every message as it was"
    );
    assert_eq!(
        ids(&read_messages(&mut tools, json!({ "after": "m1" }))),
        ["m2"]
    );
    // The daemon the keeper started after the crash gives a send the test's two minutes too, as a
    // draft holds it pending.
    type_draft(&home, "worker", "a draft");
    let after = begin_send(&home, "worker", "after", None);
    let mut given = None;
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            given = time_to_deliver(&home, 3);
            given.is_some()
        }),
        "#m3 is kept pending: {:?}",
        kept(&home, 3)
    );
    assert!(
        given.is_some_and(|given| given > secs(119) && given < secs(121)),
        "#m3 had {given:?} to be delivered"
    );
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    let receipt = after.receipt();
    assert_eq!(
        (&receipt["id"], delivery_of(&receipt)),
        (&json!(receipt_id(&home, &worker.id, "m3")), typed_in()),
        "{receipt}"
    );
}

/// A message waiting behind a draft when its daemon crashes is typed by the next daemon once the
/// draft clears: once, and within the deadline it was given when it was sent. Its send, cut off,
/// is repeated by its request ID and answers what became of it.
#[test]
fn a_message_waiting_when_its_daemon_crashes_is_typed_once_by_the_next() {
    let home = TestHome::new("restartwaiting");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let send = begin_send(&home, "worker", "hello", Some("r1"));
    wait_pending(&home, 1);
    crash(&home);
    drop(send);
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    let receipt = repeat_send(&home, "worker", "hello", "r1");
    assert_eq!(delivery_of(&receipt), typed_in(), "{receipt}");
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message m1 from command line\nhello "],
        "typed once"
    );
    let time = |field: &Value| facade_base::time::parse_iso_time(field.as_str().unwrap()).unwrap();
    let deadline = time(&receipt["message"]["at"]) + std::time::Duration::from_millis(29_500);
    assert!(
        time(&receipt["message"]["delivery"]["delivered_at"]) < deadline,
        "delivered too late: {receipt}"
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
    let store = rusqlite::Connection::open(home.path.join("framework/facade.db")).unwrap();
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
    let send = begin_send(&home, "worker", "hello", Some("r1"));
    crash_at(&home, "before-message-enter");
    drop(send);
    let receipt = repeat_send(&home, "worker", "hello", "r1");
    assert_eq!(delivery_of(&receipt), typed_in(), "{receipt}");
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message m1 from command line\nhello "],
        "submitted once"
    );
    assert!(
        home.daemon_log()
            .contains("a1's CLI may still be inside a paste"),
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
    // Two messages too long to go in one paste of 32 KiB: the first is pasted alone, and the second
    // waits behind it.
    let (long, short) = ("😀".repeat(8000), "😀".repeat(300));
    let first = begin_send(&home, "worker", &long, Some("r1"));
    wait_pending(&home, 1);
    let second = begin_send(&home, "worker", &short, Some("r2"));
    wait_pending(&home, 2);
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    crash_at(&home, "before-message-enter");
    drop((first, second));
    for (text, request) in [(&long, "r1"), (&short, "r2")] {
        let receipt = repeat_send(&home, "worker", text, request);
        assert_eq!(delivery_of(&receipt), typed_in(), "{receipt}");
    }
    let pasted = [
        format!("📨 Message m1 from command line\n{long} "),
        format!("📨 Message m2 from command line\n{short} "),
    ];
    assert_eq!(home.submitted_messages(), pasted, "each once, in order");
}

/// A message whose paste's beginning was recorded when its daemon crashed, but none of it written,
/// is never typed: the next daemon holds the input for it until its deadline, when it fails as
/// unconfirmed, what of it was typed unknown. As its paste began, no read takes it.
#[test]
fn a_paste_recorded_but_not_written_when_its_daemon_crashes_is_never_typed() {
    let home = TestHome::new("restartrecorded");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-paste-commit")]);
    let worker = home.start_named_fake("worker", &[]);
    let send = begin_send(&home, "worker", "hello", Some("r1"));
    crash_at(&home, "after-paste-commit");
    drop(send);
    let receipt = repeat_send(&home, "worker", "hello", "r1");
    assert_eq!(
        delivery_of(&receipt),
        (
            json!("failure"),
            json!("submission_unconfirmed"),
            json!("unknown"),
            Value::Null
        ),
        "{receipt}"
    );
    assert!(home.submitted_messages().is_empty(), "never typed");
    assert!(
        !home.screen("worker").contains("hello"),
        "{}",
        home.screen("worker")
    );
    assert!(
        read_messages(&mut tools_of(&home, &worker.id), json!({})).is_empty(),
        "a read takes only what has not begun to be typed"
    );
}

/// A read stopped between its record and its answer when its daemon crashes delivered the message:
/// the next daemon never types it, and the next message goes in alone once the draft holding the
/// input clears.
#[test]
fn a_message_read_when_its_daemon_crashes_is_never_typed_by_the_next() {
    let home = TestHome::new("restartread");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-read-commit")]);
    let worker = home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let send = begin_send(&home, "worker", "read me", Some("r1"));
    wait_pending(&home, 1);
    // Keep the read on the connection that is about to die. The relay program would reopen an
    // unanswered read on the next daemon.
    let mut reader = McpTestClient::relay_configured(&home, &worker.id);
    reader.send(
        "tools/call",
        json!({ "name": "read_messages", "arguments": {} }),
    );
    crash_at(&home, "after-read-commit");
    drop((send, reader));
    let receipt = repeat_send(&home, "worker", "read me", "r1");
    assert_eq!(
        delivery_of(&receipt).3,
        "read",
        "the read delivered it before it answered: {receipt}"
    );
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "next", "-w"]).trim(),
        delivered(&home, &worker.id, "m2")
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message m2 from command line\nnext "],
        "the read message is never typed"
    );
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test pause of debug builds")]
fn the_relay_reports_the_interrupted_read_and_leaves_the_rest_unread() {
    let home = TestHome::new("relay-restart-read");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-read-commit")]);
    let worker = home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let old_send = begin_send(&home, "worker", "committed before interruption", Some("r1"));
    wait_pending(&home, 1);
    let mut relay = McpTestClient::open_configured(&home, &worker.id);
    let id = relay.send(
        "tools/call",
        json!({"name": "read_messages", "arguments": {}}),
    );
    crash_at(&home, "after-read-commit");
    drop(old_send);
    let interrupted = relay.tool_answer(id);
    assert_eq!(interrupted["reason"], "unavailable", "{interrupted}");
    assert!(
        interrupted["message"]
            .as_str()
            .unwrap()
            .contains("use last")
    );
    let history = read_messages(&mut relay, json!({"last": 1}));
    assert_eq!(history[0]["text"], "committed before interruption");
    let next_send = begin_send(&home, "worker", "unread after interruption", Some("r2"));
    wait_pending(&home, 2);
    let unread = read_messages(&mut relay, json!({}));
    assert_eq!(unread.len(), 1, "{unread:?}");
    assert_eq!(unread[0]["text"], "unread after interruption");
    drop(next_send);
}

/// A message whose recipient ended while no daemon ran fails as ended in the next daemon. The
/// keeper, holding no CLI once the recipient ended, exits with the daemon; the next command starts
/// Facade again, and the agent is ended there, its terminal closed.
#[test]
fn a_message_whose_recipient_ended_while_no_daemon_ran_fails_as_ended() {
    let home = TestHome::new("restartended");
    let worker = home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let send = begin_send(&home, "worker", "hello", Some("r1"));
    wait_pending(&home, 1);
    let (daemon, _) = home.lock_record("daemon").unwrap();
    pause_process(daemon);
    kill_process(worker.pid);
    kill_process(daemon);
    drop(send);
    let receipt = repeat_send(&home, "worker", "hello", "r1");
    assert_eq!(
        delivery_of(&receipt),
        (json!("failure"), json!("ended"), json!("none"), Value::Null),
        "{receipt}"
    );
}

/// Removing an agent deletes its inbox and keeps what it sent in its recipients' inboxes, across a
/// restart too.
#[test]
fn a_removed_agent_s_inbox_goes_and_what_it_sent_stays() {
    let home = TestHome::new("removedinbox");
    let worker = home.start_named_fake("worker", &[]);
    let other = home.start_named_fake("other", &[]);
    let worker_address = address(&home, &worker.id);
    assert_eq!(
        home.run_facade_ok(&["send", "worker", "to worker", "-w"])
            .trim(),
        delivered(&home, &worker.id, "m1")
    );
    let sent = tools_of(&home, &worker.id).call(
        "send_message",
        json!({ "to": "other", "text": "from worker", "wait_for": "delivery", "timeout_seconds": 30 }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    home.remove_agent("worker");
    // The removed agent has no tools left to read its inbox with: the store shows it is gone.
    assert!(kept(&home, 1).is_none() && kept(&home, 2).is_some());
    crash(&home);
    let all = read_messages(&mut tools_of(&home, &other.id), json!({ "last": 10 }));
    assert_eq!(
        (&all[0]["id"], &all[0]["from"], all.len()),
        (&json!("m2"), &json!(worker_address), 1),
        "{all:?}"
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
    let connection = rusqlite::Connection::open(home.path.join("framework/facade.db")).unwrap();
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
    let results = home.path.join("framework/results");
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
    let next: i64 = rusqlite::Connection::open(home.path.join("framework/facade.db"))
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
    let send = begin_send(&home, "worker", "hello", None);
    wait_pending(&home, 1);
    let store = rusqlite::Connection::open(home.path.join("framework/facade.db")).unwrap();
    store
        .execute(
            "UPDATE agents SET pid = 'unreadable' WHERE agent_id = 'a1'",
            [],
        )
        .unwrap();
    crash(&home);
    drop(send);
    assert!(
        home.agents().is_empty(),
        "an agent whose record this build cannot read is not listed"
    );
    // Nothing lists the recipient, so no read or receipt shows the message: the store does.
    assert!(
        wait_until(secs(40), || kept(&home, 1).is_none()),
        "{:?}",
        kept(&home, 1)
    );
    assert!(home.submitted_messages().is_empty());
}

/// `facade send` takes its options before the text or after it, and a usage error shows them
/// first, as its help does.
#[test]
fn send_takes_its_options_before_or_after_the_text() {
    let home = TestHome::new("send-options");
    let refused = home.run_facade(&["send", "--bogus", "ada", "hi"]);
    assert_eq!(
        (refused.status.code(), stderr(&refused)),
        (
            Some(2),
            "error: Unknown option '--bogus'.\n\
             Usage: facade send [OPTIONS] <RECIPIENT> <TEXT>\n\
             Run 'facade send --help' for all options.\n"
                .into()
        )
    );
    let ada = home.start_named_fake("ada", &[]);
    for (args, number) in [
        (&["send", "-w", "ada", "options first"][..], "m1"),
        (&["send", "ada", "options last", "-w"], "m2"),
    ] {
        assert_eq!(
            home.run_facade_ok(args).trim(),
            delivered(&home, &ada.id, number),
            "facade {args:?}"
        );
    }
}

/// A CLI that reads its keys as a console gives them, as Codex does on Windows, takes no paste: its
/// Enter submits, and Shift+Enter breaks the line. A message's line breaks never act as its Enter:
/// the message reaches it whole, once.
#[cfg(windows)]
#[test]
fn a_message_s_line_breaks_are_not_the_enter_of_a_cli_that_reads_console_keys() {
    let home = TestHome::new("consolekeys");
    let programs = home.folder().join("programs");
    install_program(&programs, "codex", &test_binaries().fakecli);
    let path = format!("{}{PATH_SEPARATOR}{}", programs.display(), home.test_path());
    let relay = home
        .path
        .join("framework/bin")
        .join(program_name("facade-mcp"));
    let started = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .env("FAKECLI_CODEX_INPUT", "working")
        .env("FAKECLI_CONSOLE_KEYS", "1")
        .env("FAKECLI_MCP", &relay)
        .args(["start", "-d", "--name", "codex", "codex"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    home.started_agent(&stdout(&started));

    let body = "one\nrun: cargo test\n\nlast line, 📨";
    let sent = home.run_facade(&["send", "codex", body, "-w"]);
    assert_eq!(
        home.submitted_messages(),
        [format!("📨 Message m1 from command line\n{body} ")],
        "submitted once and whole; the send said {}{}",
        stdout(&sent),
        stderr(&sent)
    );
    assert!(sent.status.success(), "{}", stderr(&sent));
}
