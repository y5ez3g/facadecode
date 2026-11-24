//! Raw input ordering, queue limits, waiting notifications, terminal-query replies, and text and
//! keys typed by `facade type`.

#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

#[cfg(unix)]
use facade_scenarios::serde_json::Value;
use facade_scenarios::serde_json::json;
use facade_scenarios::*;

#[test]
fn input_from_one_connection_preserves_order() {
    let home = TestHome::new("keyorder");
    let worker = home.start_fake("worker");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    let target = home.inspect_agent(&worker.id)["agent"]["reference"].clone();
    let alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let mut sent = Vec::new();
    for round in 0..8 {
        let text: String = alphabet
            .chars()
            .cycle()
            .skip(round)
            .take(alphabet.len())
            .collect();
        for key in text
            .chars()
            .map(String::from)
            .chain(std::iter::once("\r".to_string()))
        {
            let data = facade_base::base64::encode(key.as_bytes());
            wire.write(&json!({
                "jsonrpc": "2.0", "method": "call",
                "params": { "op": "agent.type", "args": { "target": target, "input": { "kind": "raw", "raw": data } } },
            }));
        }
        sent.push(text);
    }
    assert!(
        wait_until(secs(30), || home.submitted_messages().len() >= sent.len()),
        "{:?}",
        home.submitted_messages()
    );
    std::thread::sleep(secs(1));
    assert_eq!(
        home.submitted_messages(),
        sent,
        "submitted lines must be complete and ordered"
    );
}

/// Only the daemon replies to terminal queries, regardless of viewer count.
#[test]
fn each_terminal_query_gets_one_reply_with_multiple_viewers() {
    let home = TestHome::new("query");
    let mut wire = connect(&home);
    let ask = "/fake cursor\r";
    for viewers in 0..3 {
        let keys = home.project.join(format!("keys-{viewers}"));
        let worker = home.start_fake_with(
            &format!("q{viewers}"),
            &[("FAKECLI_KEYS", keys.to_str().unwrap())],
        );
        let terms: Vec<TestTerminal> = (0..viewers)
            .map(|_| {
                TestTerminal::spawn(
                    home.command(&test_binaries().facade)
                        .args(["attach", &worker.address]),
                    80,
                    24,
                )
            })
            .collect();
        for term in &terms {
            assert!(
                term.wait_for(secs(10), |text| text.contains("Facade test CLI")),
                "{}",
                term.text()
            );
        }
        let inspected = home.inspect_agent(&worker.address);
        assert_eq!(
            inspected["attachments"].as_array().map_or(0, Vec::len),
            viewers,
            "{inspected}"
        );
        assert!(wait_until(secs(10), || keys.is_file()));
        let mut expected = std::fs::read(&keys).unwrap();
        expected.extend_from_slice(ask.as_bytes());
        expected.extend_from_slice(b"\x1b[2;3R");
        type_raw(&mut wire, &worker.address, ask);
        assert!(
            wait_until(secs(10), || std::fs::read(&keys)
                .is_ok_and(|bytes| bytes.len() >= expected.len())),
            "{viewers} viewers, received {:?}",
            std::fs::read(&keys)
        );
        // Keep all viewers attached while giving duplicate replies time to arrive.
        std::thread::sleep(secs(1));
        assert_eq!(
            std::fs::read(&keys).unwrap(),
            expected,
            "{viewers} viewers must result in exactly one cursor report"
        );
    }
}

/// Reject input that does not fit in the queue, while still allowing stop.
// A PTY whose buffer fills is Unix's: a pseudo console's host reads all its input.
#[cfg(unix)]
#[test]
fn input_limit_rejects_overflow_and_recovers_after_drain() {
    let home = TestHome::new("input");
    let mut wire = connect(&home);
    // The CLI waits for a file before reading its first million bytes.
    let script = "stty raw -echo; echo READY; while [ ! -e resume ]; do sleep 0.1; done; head -c \
                  1000000 > got; echo GOT; sleep 60";
    let agent = start_script(&mut wire, &home, "deaf", script);
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let target = home.inspect_agent(&agent)["agent"]["reference"].clone();
    let mut accepted = Vec::new();
    let mut reasons = Vec::new();
    for chunk in 0..8u8 {
        let bytes = vec![b'a' + chunk; 256 * 1024];
        let response = wire.call(
            "agent.type",
            json!({ "target": target, "input": { "kind": "raw", "raw": facade_base::base64::encode(&bytes) } }),
        );
        if response["result"].is_object() {
            accepted.extend(bytes);
        }
        reasons.push(error_reason(&response).to_string());
    }
    assert!(
        accepted.len() >= 512 * 1024,
        "input below the limit was refused: {reasons:?}"
    );
    assert!(
        reasons.iter().any(|reason| reason == "capacity_exceeded"),
        "{reasons:?}"
    );
    // Accepted bytes must arrive in order once reading resumes, and the queue must accept input
    // again.
    std::fs::write(home.project.join("resume"), "").unwrap();
    assert!(wait_for_screen_text(&home, &agent, "GOT"));
    let got = std::fs::read(home.project.join("got")).unwrap();
    assert!(
        got.len() == 1_000_000 && got[..] == accepted[..1_000_000],
        "{} bytes arrived",
        got.len()
    );
    type_raw(&mut wire, &agent, "again");
    let asked = Instant::now();
    home.run_facade_ok(&["stop", &agent]);
    assert!(
        asked.elapsed() < secs(5),
        "its stop took {:?}",
        asked.elapsed()
    );
}

/// Drop input notifications waiting for room when their connection closes. Repeated disconnected
/// clients must not accumulate input.
// Input waiting for room is Unix's: a pseudo console's host reads all its input.
#[cfg(unix)]
#[test]
fn disconnect_discards_waiting_input_and_following_requests() {
    let home = TestHome::new("waitinginput");
    let mut wire = connect(&home);
    let script = "stty raw -echo; echo READY; while [ ! -e resume ]; do sleep 0.1; done; stty min \
                  0 time 20; cat > got; wc -c < got > count; echo COUNTED; sleep 60";
    let agent = start_script(&mut wire, &home, "deaf", script);
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let target = home.inspect_agent(&agent)["agent"]["reference"].clone();
    let megabyte = facade_base::base64::encode(&vec![b'k'; 1024 * 1024]);
    let kilobyte = facade_base::base64::encode(&vec![b'c'; 1024]);
    for _ in 0..12 {
        let mut raw = ManualReadClient::open(&home);
        // Queue one megabyte and a trailing message. Neither waiting message may run after
        // disconnection.
        for bytes in [&megabyte, &kilobyte] {
            let call = json!({
                "jsonrpc": "2.0", "method": "call",
                "params": { "op": "agent.type", "args": { "target": target, "input": { "kind": "raw", "raw": bytes } } },
            });
            raw.writer
                .write_all(format!("{call}\n").as_bytes())
                .unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(secs(1));
    std::fs::write(home.project.join("resume"), "").unwrap();
    assert!(wait_for_screen_text(&home, &agent, "COUNTED"));
    let count: usize = std::fs::read_to_string(home.project.join("count"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        count <= 1024 * 1024 + 64 * 1024,
        "received {count} bytes; waiting input from closed connections was not dropped"
    );
}

/// Terminal-query replies count toward the input queue limit.
// Input waiting for room is Unix's: a pseudo console's host reads all its input.
#[cfg(unix)]
#[test]
fn query_replies_share_the_input_limit() {
    let home = TestHome::new("queryinput");
    let mut wire = connect(&home);
    let script = "stty raw -echo; awk 'BEGIN { for (i = 0; i < 400000; i++) printf \"\\033[6n\" \
                  }'; sleep 2; stty min 0 time 20; cat > replies; wc -c < replies > count; echo \
                  COUNTED; sleep 60";
    let agent = start_script(&mut wire, &home, "asker", script);
    assert!(
        wait_until(secs(60), || home.screen(&agent).contains("COUNTED")),
        "{}",
        home.screen(&agent)
    );
    let count: usize = std::fs::read_to_string(home.project.join("count"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        count > 0 && count <= 1024 * 1024 + 64 * 1024,
        "received {count} bytes of terminal-query replies"
    );
}

/// Input that waits for room holds its connection's reading once its agent's lane on that
/// connection is full too. After the waiting input fits, the requests behind it run without more
/// client traffic.
// A PTY whose buffer fills is Unix's: a pseudo console's host reads all its input.
#[cfg(unix)]
#[test]
fn queued_calls_resume_when_input_room_returns() {
    let home = TestHome::new("livepipeline");
    let mut wire = connect(&home);
    let script = "stty raw -echo; echo READY; while [ ! -e resume ]; do sleep 0.1; done; stty min \
                  0 time 20; cat > got; echo COUNTED; sleep 60";
    let agent = start_script(&mut wire, &home, "deaf", script);
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let target = home.inspect_agent(&agent)["agent"]["reference"].clone();
    let mut raw = ManualReadClient::open(&home);
    raw.send(
        1,
        "watch",
        json!({ "topic": "attach", "args": { "target": target, "size": { "cols": 80, "rows": 24 } } }),
    );
    let opened = raw.read_message().expect("the Attach snapshot");
    assert_eq!(opened["id"], 1, "{opened}");
    let watch = opened["result"]["watch"].as_u64().expect("the watch ID");
    let megabyte = facade_base::base64::encode(&vec![b'k'; 1024 * 1024]);
    // The first megabyte fills the agent's input and the second its lane; the third waits to be
    // read, and so do the resize and the screen read behind it.
    for _ in 0..3 {
        let call = json!({
            "jsonrpc": "2.0", "method": "call",
            "params": { "op": "agent.type", "args": { "target": target, "input": { "kind": "raw", "raw": megabyte } } },
        });
        raw.writer
            .write_all(format!("{call}\n").as_bytes())
            .unwrap();
    }
    raw.send(
        7,
        "call",
        json!({ "op": "attach.resize", "args": { "watch": watch, "size": { "cols": 100, "rows": 30 } } }),
    );
    raw.send(
        8,
        "call",
        json!({ "op": "agent.screen", "args": { "target": target, "lines": 1 } }),
    );
    raw.set_read_timeout(secs(1));
    assert!(
        std::iter::from_fn(|| raw.read_message()).all(|line| line.get("id").is_none()),
        "the connection answered work after the blocked input"
    );
    std::fs::write(home.project.join("resume"), "").unwrap();
    // The answers come once the CLI has read the three megabytes before them, which a loaded
    // machine takes its time over.
    raw.set_read_timeout(secs(30));
    let answered: Vec<Value> = std::iter::from_fn(|| raw.read_message())
        .filter(|line| matches!(line["id"].as_u64(), Some(7 | 8)))
        .take(2)
        .collect();
    assert!(
        answered.len() == 2
            && answered
                .iter()
                .all(|response| response["result"].is_object()),
        "the queued calls were not answered: {answered:?}"
    );
}

/// Shell pastes single-line text and presses keys. A multiline paste through v1 stays one
/// message, keys edit the draft, and a call to an ended agent says that nothing was typed.
#[test]
fn type_pastes_text_and_presses_keys() {
    let home = TestHome::new("type");
    home.start_fake("worker");
    let address = home.agent_record("a1").expect("a1 is recorded")["address"]
        .as_str()
        .expect("an address")
        .to_string();
    assert_eq!(
        home.run_facade_ok(&["type", "worker", "hello there", "--enter"]),
        format!("Typed into worker ({address})'s terminal and pressed Enter.\n")
    );
    let multiline = "two\nlines";
    for (args, control) in [
        (&["type", "a1", multiline, "--enter"][..], "U+000A"),
        (&["type", "worker", "a\u{1b}b"][..], "U+001B"),
    ] {
        let refused = home.run_facade(args);
        assert_eq!(
            (stdout(&refused), stderr(&refused), refused.status.code()),
            (
                String::new(),
                format!(
                    "error: Text contains the control character {control}. Use '-k' or '--key' to press a key.\n\
                     Example: facade type Nova --key Enter\n"
                ),
                Some(2),
            )
        );
    }
    connect(&home).call_ok(
        "agent.type",
        json!({ "target": "a1", "input": { "kind": "text", "text": multiline, "enter": true } }),
    );
    home.run_facade_ok(&["type", &address, "abc"]);
    home.run_facade_ok(&["type", "a1", "--key", "Backspace", "--key", "enter"]);
    home.run_facade_ok(&["type", "worker", "junk"]);
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    home.run_facade_ok(&["type", "worker", "ok", "--enter"]);
    let wanted = ["hello there", multiline, "ab", "ok"];
    assert!(
        wait_until(secs(10), || home.submitted_messages().len() >= wanted.len()),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(home.submitted_messages(), wanted);

    let unknown = home.run_facade(&["type", "worker", "--key", "Esc", "--key", "F13"]);
    assert!(
        unknown.status.code() == Some(2) && stderr(&unknown).contains("Unknown key \"F13\"."),
        "{}",
        stderr(&unknown)
    );
    home.run_facade_ok(&["stop", "worker"]);
    // Typing finds running agents alone: the error says the agent ended.
    for given in ["a1", address.as_str(), "worker"] {
        let ended = home.run_facade(&["type", given, "late", "--enter"]);
        assert!(
            ended.status.code() == Some(1)
                && stderr(&ended)
                    == format!("error: worker ({address}) has stopped and cannot accept input.\n"),
            "{given}: {}",
            stderr(&ended)
        );
    }
    assert_eq!(home.submitted_messages().len(), wanted.len());
}

/// Observe bytes from the public Shell command at the selected process, before and after Enter.
#[test]
fn shell_type_writes_exact_paste_and_enter_bytes_to_its_target() {
    let home = TestHome::new("shell-type-bytes");
    let keys = home.project.join("worker-input");
    let other_keys = home.project.join("other-input");
    let worker = home.start_fake_with("worker", &[("FAKECLI_KEYS", keys.to_str().unwrap())]);
    let other = home.start_fake_with("other", &[("FAKECLI_KEYS", other_keys.to_str().unwrap())]);
    assert!(wait_for_screen_text(&home, &worker.address, "❯"));
    assert!(wait_for_screen_text(&home, &other.address, "❯"));
    let before = std::fs::read(&keys).unwrap();
    let other_before = std::fs::read(&other_keys).unwrap();
    let draft = "界🙂 draft";
    let suffix = " + Enter";
    let mut expected = before;
    let expect_bytes = |expected: &[u8]| {
        assert!(wait_until(LOADED_TIMEOUT, || std::fs::read(&keys)
            .is_ok_and(|bytes| bytes.len() >= expected.len())));
        assert_eq!(std::fs::read(&keys).unwrap(), expected);
    };
    home.run_facade_ok(&["type", &worker.address, draft]);
    expected.extend(format!("\x1b[200~{draft}\x1b[201~").bytes());
    expect_bytes(&expected);
    assert!(wait_for_screen_text(
        &home,
        &worker.address,
        &format!("❯ {draft}")
    ));
    assert!(home.submitted_messages().is_empty());
    home.run_facade_ok(&["type", &worker.address, suffix, "--enter"]);
    expected.extend(format!("\x1b[200~{suffix}\x1b[201~\r").bytes());
    expect_bytes(&expected);
    let submitted = format!("{draft}{suffix}");
    assert!(wait_until(LOADED_TIMEOUT, || home.submitted_messages()
        == [submitted.as_str()]));

    // Explicit keys take the raw path: the Unicode key and Enter have no paste wrapper.
    home.run_facade_ok(&["type", &worker.address, "--key", "界", "--key", "Enter"]);
    expected.extend("界\r".bytes());
    expect_bytes(&expected);
    assert!(wait_until(LOADED_TIMEOUT, || home.submitted_messages()
        == [submitted.as_str(), "界"]));
    assert_eq!(std::fs::read(other_keys).unwrap(), other_before);
}

/// The CLI validates a whole batch, and Facade API v1's agent.type still types its legacy frames.
#[test]
fn public_keys_have_a_limit_and_api_v1_keeps_its_existing_keys() {
    let home = TestHome::new("publickeys");
    let pressed = home.project.join("pressed");
    let agent = home.start_fake_with("worker", &[("FAKECLI_KEYS", pressed.to_str().unwrap())]);
    assert!(wait_for_screen_text(&home, &agent.id, "❯"));

    let mut hundred = vec!["type", &agent.id, "-k", "eSc", "--key", "界"];
    hundred.extend(std::iter::repeat_n(["-k", "X"], 98).flatten());
    home.run_facade_ok(&hundred);

    let no_input = home.run_facade(&["type", &agent.id]);
    assert_eq!(no_input.status.code(), Some(2), "{}", stderr(&no_input));
    let mut too_many = vec!["type", &agent.id];
    too_many.extend(std::iter::repeat_n(["-k", "z"], 101).flatten());
    let refused = home.run_facade(&too_many);
    assert_eq!(refused.status.code(), Some(2), "{}", stderr(&refused));
    assert!(stderr(&refused).contains("accepts at most 100 keys, got 101"));
    for old in [
        "Escape",
        "Return",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
    ] {
        let refused = home.run_facade(&["type", &agent.id, "-k", "z", "-k", old]);
        let message = stderr(&refused);
        assert_eq!(refused.status.code(), Some(2), "{message}");
        assert!(
            message.contains(&format!("Unknown key {old:?}."))
                && message.contains("Supported keys: Enter, Esc"),
            "{message}"
        );
    }

    let empty = home.run_facade(&["type", &agent.id, ""]);
    assert_eq!(empty.status.code(), Some(2), "{}", stderr(&empty));
    let empty_with_enter = home.run_facade(&["type", &agent.id, "", "--enter"]);
    assert_eq!(
        empty_with_enter.status.code(),
        Some(2),
        "{}",
        stderr(&empty_with_enter)
    );
    home.run_facade_ok(&["type", &agent.id, "--key", "Enter"]);

    let mut wire = connect(&home);
    let empty = wire.call(
        "agent.type",
        json!({ "target": agent.id, "input": { "kind": "text", "text": "" } }),
    );
    assert_eq!(error_reason(&empty), "invalid_argument", "{empty}");
    let mut legacy = vec![
        "Escape",
        "Return",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
    ];
    legacy.extend(std::iter::repeat_n("v", 100));
    let typed = wire.call(
        "agent.type",
        json!({ "target": agent.id, "input": { "kind": "keys", "keys": legacy } }),
    );
    assert!(typed["result"].is_object(), "{typed}");
    let enter = wire.call(
        "agent.type",
        json!({ "target": agent.id, "input": { "kind": "text", "text": "", "enter": true } }),
    );
    assert!(enter["result"].is_object(), "{enter}");

    let mut expected = Vec::from(b"\x1b");
    expected.extend_from_slice("界".as_bytes());
    expected.extend_from_slice(&[b'X'; 98]);
    expected.extend_from_slice(b"\r\x1b\r\x1b[A\x1b[B\x1b[D\x1b[C");
    expected.extend_from_slice(&[b'v'; 100]);
    expected.push(b'\r');
    assert!(
        wait_until(secs(10), || std::fs::read(&pressed)
            .is_ok_and(|bytes| bytes == expected)),
        "{:?}",
        std::fs::read(&pressed)
    );
}

/// Keys go as the terminal sends them in the CLI's modes: cursor keys and Home change with
/// application cursor keys.
#[test]
fn keys_follow_the_cli_s_cursor_mode() {
    let home = TestHome::new("cursorkeys");
    let mut wire = connect(&home);
    let script = "stty raw -echo; echo READY; head -c 6 | cat -v > default; printf '\\033[?1h'; \
                  echo AGAIN; head -c 6 | cat -v > application; echo DONE; sleep 60";
    let agent = start_script(&mut wire, &home, "keys", script);
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    home.run_facade_ok(&["type", &agent, "--key", "Up", "--key", "Home"]);
    assert!(wait_for_screen_text(&home, &agent, "AGAIN"));
    home.run_facade_ok(&["type", &agent, "--key", "Up", "--key", "Home"]);
    assert!(
        wait_for_screen_text(&home, &agent, "DONE"),
        "{}",
        home.screen(&agent)
    );
    let read = |file: &str| std::fs::read_to_string(home.project.join(file)).unwrap();
    assert_eq!(
        (read("default").as_str(), read("application").as_str()),
        ("^[[A^[[H", "^[OA^[OH")
    );
}

/// A text call holds later typing into its agent on its connection until it is answered, so raw
/// keys sent after it follow its Enter.
#[test]
fn raw_keys_sent_after_text_follow_its_enter() {
    let home = TestHome::new("typeorder");
    let worker = home.start_fake("worker");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    let target = home.inspect_agent(&worker.id)["agent"]["reference"].clone();
    let typed = wire.send(
        "call",
        json!({
            "op": "agent.type", "args": { "target": target, "input": { "kind": "text", "text": "first", "enter": true } },
        }),
    );
    let raw = facade_base::base64::encode(b"second\r");
    wire.write(&json!({
        "jsonrpc": "2.0", "method": "call",
        "params": { "op": "agent.type", "args": { "target": target, "input": { "kind": "raw", "raw": raw } } },
    }));
    assert!(
        wire.wait_for_response(typed, secs(10))
            .is_some_and(|response| response["result"].is_object())
    );
    assert!(
        wait_until(secs(10), || home.submitted_messages().len() >= 2),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(home.submitted_messages(), ["first", "second"]);
}

#[test]
fn mixed_typing_keeps_all_five_steps_ahead_of_following_input() {
    let home = TestHome::new("typesequence");
    let keys = home.folder().join("keys");
    let worker = home.start_fake_with("worker", &[("FAKECLI_KEYS", keys.to_str().unwrap())]);
    let five_steps = b"\x1b[200~hello\x1b[201~\r\x1b[200~hello\x1b[201~\r\r";
    let read_keys = || std::fs::read(&keys).unwrap_or_default();
    let receipt = home.run_facade_ok(&[
        "type", "worker", "hello", "--key", "Enter", "hello", "-k", "Enter", "--key", "Enter",
    ]);
    assert_eq!(
        receipt,
        format!(
            "Typed text and pressed keys in worker ({})'s terminal.\n",
            worker.address
        )
    );
    assert!(wait_until(LOADED_TIMEOUT, || read_keys().len() >= five_steps.len()));
    assert_eq!(read_keys(), five_steps);

    let mut wire = connect(&home);
    let target = home.inspect_agent(&worker.id)["agent"]["reference"].clone();
    let watched = wire.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": target } }),
    );
    assert!(watched["result"].is_object(), "{watched}");
    let sequence = wire.send(
        "call",
        json!({
            "op": "agent.type", "args": { "target": target, "input": { "kind": "sequence", "steps": [
                { "kind": "text", "text": "hello" }, { "kind": "key", "key": "Enter" },
                { "kind": "text", "text": "hello" }, { "kind": "key", "key": "Enter" },
                { "kind": "key", "key": "Enter" }
            ] } }
        }),
    );
    // Send raw input from the viewer before reading the ordered call's reply.
    wire.write(&json!({
        "jsonrpc": "2.0", "method": "call",
        "params": { "op": "agent.type", "args": { "target": target, "input": {
            "kind": "raw", "raw": facade_base::base64::encode(b"later\r")
        } } },
    }));
    let receipt = wire.wait_for_response(sequence, LOADED_TIMEOUT).unwrap();
    assert!(receipt["result"].is_object(), "{receipt}");
    assert!(
        wait_until(LOADED_TIMEOUT, || home.submitted_messages().len() >= 5),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        read_keys(),
        [five_steps.as_slice(), five_steps, b"later\r"].concat()
    );

    for spelling in ["-key", "--Key"] {
        let refused = home.run_facade(&["type", "worker", "ignored", spelling, "Enter"]);
        assert_eq!(refused.status.code(), Some(2), "{}", stderr(&refused));
        assert!(
            stderr(&refused).contains(&format!(
                "Unknown option '{spelling}'. Use '-k' or '--key'."
            )),
            "{}",
            stderr(&refused)
        );
    }
    let quoted = r#"say "hello world" “again”"#;
    home.run_facade_ok(&["type", "worker", quoted, "--enter"]);
    assert!(wait_until(LOADED_TIMEOUT, || home
        .submitted_messages()
        .len()
        >= 6));
    assert_eq!(
        home.submitted_messages(),
        ["hello", "hello", "hello", "hello", "later", quoted]
    );
}

/// One `agent.type` call carries at most 1 MiB as written, a paste counted with its brackets: a
/// larger one is refused before anything is typed, and one at the limit is typed whole.
// Its stand-in is a sh script that reads keys, which MSYS sh under a pseudo console does not get.
#[cfg(unix)]
#[test]
fn one_typed_call_carries_at_most_1_mib() {
    let home = TestHome::new("typelimit");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "reader",
        "stty raw -echo; echo READY; cat > got",
    );
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    // The paste brackets, `\x1b[200~` and `\x1b[201~`, count toward the limit in any modes.
    let limit = 1024 * 1024 - 12;
    let over = wire.call(
        "agent.type",
        json!({ "target": agent, "input": { "kind": "text", "text": "x".repeat(limit + 1) } }),
    );
    assert_eq!(error_reason(&over), "capacity_exceeded", "{over}");
    assert_eq!(
        over["error"]["message"], "input is limited to 1 MiB a call",
        "{over}"
    );
    let at_limit = wire.call(
        "agent.type",
        json!({ "target": agent, "input": { "kind": "text", "text": "y".repeat(limit) } }),
    );
    assert!(at_limit["result"].is_object(), "{at_limit}");
    let got = || std::fs::read(home.project.join("got")).unwrap_or_default();
    assert!(
        wait_until(secs(10), || got().len() >= limit),
        "{} bytes arrived",
        got().len()
    );
    assert!(
        got().len() == limit && got().iter().all(|byte| *byte == b'y'),
        "nothing of the refused call was typed"
    );
}

/// A text call into an agent whose CLI takes no input holds nothing else on its connection: typing
/// into another agent goes on, a call for that agent that does not fit fails at once, and a stop of
/// that agent answers the held call with what was typed.
// A PTY whose buffer fills is Unix's: a pseudo console's host reads all its input.
#[cfg(unix)]
#[test]
fn a_text_call_held_by_one_agent_holds_nothing_else_on_its_connection() {
    let home = TestHome::new("typelanes");
    let deaf = home.start_named_fake("deaf", &[("FAKECLI_IGNORE_INPUT", "1")]);
    let worker = home.start_fake("worker");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    // More text than a terminal's input holds: the CLI reads none of it, so the call is not
    // answered while its CLI runs.
    let held = wire.send(
        "call",
        json!({ "op": "agent.type", "args": { "target": deaf.id, "input": { "kind": "text", "text": "x".repeat(512 * 1024) } } }),
    );
    let typed = wire.call(
        "agent.type",
        json!({ "target": worker.id, "input": { "kind": "text", "text": "hello", "enter": true } }),
    );
    assert!(typed["result"].is_object(), "{typed}");
    assert!(
        wait_until(secs(10), || home.submitted_messages() == ["hello"]),
        "{:?}",
        home.submitted_messages()
    );
    // A call whose input does not fit beside the held text fails at once.
    let refused = wire.call(
        "agent.type",
        json!({ "target": deaf.id, "input": { "kind": "text", "text": "y".repeat(600 * 1024) } }),
    );
    assert_eq!(error_reason(&refused), "capacity_exceeded", "{refused}");
    assert!(
        wire.wait_for_response(held, Duration::from_millis(200))
            .is_none(),
        "the CLI took the text"
    );
    let stopped = wire.call_ok(
        "agent.stop",
        json!({ "selection": { "kind": "targets", "targets": [deaf.id] } }),
    );
    assert_eq!(stopped["items"][0]["status"], "stopped", "{stopped}");
    let answered = wire
        .wait_for_response(held, secs(10))
        .expect("the stop answers the held call");
    assert_eq!(error_reason(&answered), "partial_input", "{answered}");
}
