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
    wire.hello("terminal", DAEMON_RANGE, json!({}));
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
                "params": { "op": "agent.type", "args": { "agent": worker.id, "raw": data } },
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
    let script = "echo READY; read go; stty raw -echo min 0 time 0; printf '\\033[6n'; sleep 1; \
                  printf 'REPLIES:'; cat -v; printf ':END\\r\\n'; sleep 60";
    for viewers in 0..3 {
        let agent = start_script(&mut wire, &home, &format!("q{viewers}"), script);
        assert!(wait_for_screen_text(&home, &agent, "READY"));
        let terms: Vec<TestTerminal> = (0..viewers)
            .map(|_| {
                TestTerminal::spawn(
                    home.command(&test_binaries().facade)
                        .args(["attach", &agent]),
                    80,
                    24,
                )
            })
            .collect();
        for term in &terms {
            assert!(
                term.wait_for(secs(10), |text| text.contains("READY")),
                "{}",
                term.text()
            );
        }
        type_raw(&mut wire, &agent, "go\r");
        assert!(
            wait_for_screen_text(&home, &agent, ":END"),
            "{}",
            home.screen(&agent)
        );
        let screen = home.screen(&agent);
        let replies = &screen[screen.find("REPLIES:").unwrap()..screen.find(":END").unwrap()];
        assert_eq!(
            replies.matches("^[[").count(),
            1,
            "{viewers} terminals showed it: {replies}"
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
    let mut accepted = Vec::new();
    let mut reasons = Vec::new();
    for chunk in 0..8u8 {
        let bytes = vec![b'a' + chunk; 256 * 1024];
        let response = wire.call(
            "agent.type",
            json!({ "agent": agent, "raw": facade_base::base64::encode(&bytes) }),
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
    let megabyte = facade_base::base64::encode(&vec![b'k'; 1024 * 1024]);
    let kilobyte = facade_base::base64::encode(&vec![b'c'; 1024]);
    for _ in 0..12 {
        let mut raw = ManualReadClient::open(&home);
        // Queue one megabyte and a trailing message. Neither waiting message may run after
        // disconnection.
        for bytes in [&megabyte, &kilobyte] {
            let call = json!({
                "jsonrpc": "2.0", "method": "call",
                "params": { "op": "agent.type", "args": { "agent": agent, "raw": bytes } },
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
    let mut raw = ManualReadClient::open(&home);
    let megabyte = facade_base::base64::encode(&vec![b'k'; 1024 * 1024]);
    // The first megabyte fills the agent's input and the second its lane; the third waits to be
    // read, and so do the resize and the screen read behind it.
    for _ in 0..3 {
        let call = json!({
            "jsonrpc": "2.0", "method": "call",
            "params": { "op": "agent.type", "args": { "agent": agent, "raw": megabyte } },
        });
        raw.writer
            .write_all(format!("{call}\n").as_bytes())
            .unwrap();
    }
    raw.send(
        7,
        "call",
        json!({ "op": "agent.resize", "args": { "agent": agent, "cols": 100, "rows": 30 } }),
    );
    raw.send(
        8,
        "call",
        json!({ "op": "agent.screen", "args": { "agent": agent, "lines": 1 } }),
    );
    raw.set_read_timeout(secs(1));
    assert!(raw.read_message().is_none(), "the connection was read on");
    std::fs::write(home.project.join("resume"), "").unwrap();
    // The answers come once the CLI has read the three megabytes before them, which a loaded
    // machine takes its time over.
    raw.set_read_timeout(secs(30));
    let answered: Vec<Value> = std::iter::from_fn(|| raw.read_message()).take(2).collect();
    assert!(
        answered.len() == 2
            && answered
                .iter()
                .all(|response| response["result"].is_object()),
        "the queued calls were not answered: {answered:?}"
    );
}

/// `facade type` pastes text and presses keys, each call answered once its input reached the
/// terminal: a multiline text is one message, keys edit the draft, and a call to an ended agent
/// says that nothing was typed.
#[test]
fn type_pastes_text_and_presses_keys() {
    let home = TestHome::new("type");
    home.start_fake("worker");
    home.run_facade_ok(&["type", "worker", "hello there", "--enter"]);
    home.run_facade_ok(&["type", "a1", "two\nlines", "--enter"]);
    home.run_facade_ok(&["type", "#a1", "abc"]);
    home.run_facade_ok(&["type", "1", "--key", "Backspace", "--key", "enter"]);
    home.run_facade_ok(&["type", "worker", "junk"]);
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    home.run_facade_ok(&["type", "worker", "ok", "--enter"]);
    let wanted = ["hello there", "two\nlines", "ab", "ok"];
    assert!(
        wait_until(secs(10), || home.submitted_messages().len() >= wanted.len()),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(home.submitted_messages(), wanted);

    let unknown = home.run_facade(&["type", "worker", "--key", "Esc", "--key", "F13"]);
    assert!(
        !unknown.status.success()
            && stderr(&unknown).contains("unknown keys: \"F13\"; keys are Enter"),
        "{}",
        stderr(&unknown)
    );
    let control = home.run_facade(&["type", "worker", "a\u{1b}b"]);
    assert!(
        !control.status.success() && stderr(&control).contains("control character U+001B"),
        "{}",
        stderr(&control)
    );
    home.run_facade_ok(&["stop", "worker"]);
    for given in ["a1", "#a1", "1", "worker"] {
        let ended = home.run_facade(&["type", given, "late", "--enter"]);
        assert!(
            ended.status.code() == Some(1)
                && stderr(&ended)
                    == "error: a1 has ended\n  tip: run 'facade inspect a1' to check for a saved \
                        session\n",
            "{given}: {}",
            stderr(&ended)
        );
    }
    assert_eq!(home.submitted_messages().len(), wanted.len());
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
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    let typed = wire.send(
        "call",
        json!({
            "op": "agent.type", "args": { "agent": worker.id, "text": "first", "enter": true },
        }),
    );
    let raw = facade_base::base64::encode(b"second\r");
    wire.write(&json!({
        "jsonrpc": "2.0", "method": "call",
        "params": { "op": "agent.type", "args": { "agent": worker.id, "raw": raw } },
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
        json!({ "agent": agent, "text": "x".repeat(limit + 1) }),
    );
    assert_eq!(error_reason(&over), "capacity_exceeded", "{over}");
    assert!(
        over["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("agent.type accepts at most 1024 KiB of input as written"),
        "{over}"
    );
    let at_limit = wire.call(
        "agent.type",
        json!({ "agent": agent, "text": "y".repeat(limit) }),
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
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    // More text than a terminal's input holds: the CLI reads none of it, so the call is not
    // answered while its CLI runs.
    let held = wire.send(
        "call",
        json!({ "op": "agent.type", "args": { "agent": deaf.id, "text": "x".repeat(512 * 1024) } }),
    );
    let typed = wire.call(
        "agent.type",
        json!({ "agent": worker.id, "text": "hello", "enter": true }),
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
        json!({ "agent": deaf.id, "text": "y".repeat(600 * 1024) }),
    );
    assert_eq!(error_reason(&refused), "capacity_exceeded", "{refused}");
    assert!(
        wire.wait_for_response(held, Duration::from_millis(200))
            .is_none(),
        "the CLI took the text"
    );
    let stopped = wire.call("agent.stop", json!({ "agent": deaf.id }));
    assert!(stopped["result"].is_object(), "{stopped}");
    let answered = wire
        .wait_for_response(held, secs(10))
        .expect("the stop answers the held call");
    assert_eq!(error_reason(&answered), "partial_input", "{answered}");
}
