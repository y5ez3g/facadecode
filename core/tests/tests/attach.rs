//! Terminal attachment and restoration on detach, exit, or termination signals.

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// The copyable address Facade gives the agent with this ID, such as `a1@host`.
fn address(home: &TestHome, id: &str) -> String {
    home.agent_record(id).expect("the agent is recorded")["address"]
        .as_str()
        .expect("an address")
        .to_string()
}

fn assert_detach_receipt(term: &TestTerminal, name: &str, address: &str) {
    let shown = format!("Detached from {name}");
    let detached = format!("{shown} ({address}). The agent is still running.");
    let reattach = format!("Reattach with 'facade attach {address}'.");
    // The narrow test terminal can wrap the receipt. Check the emitted text and that the detach
    // notice is visible on the restored screen.
    assert!(
        term.wait_for_output(secs(2), &detached) && term.wait_for_output(secs(2), &reattach),
        "{}",
        term.text_with_scrollback()
    );
    assert!(
        term.wait_for(secs(2), |text| text.contains(&shown)),
        "{}",
        term.text()
    );
}

#[test]
fn attach_reports_native_progress_during_work_and_clears_it_on_idle_and_detach() {
    let home = TestHome::new("attachprogress");
    let agent = home.start_named_fake(
        "progress",
        &[("FAKECLI_STATUS", "1"), ("FAKECLI_TURN_MS", "3000")],
    );
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &agent.address]),
        120,
        30,
    );
    assert!(term.wait_for(secs(10), |text| text.contains("❯")));
    assert!(wait_until(secs(5), || {
        home.agent_record(&agent.id)
            .is_some_and(|record| record["state"] == "idle")
    }));
    let busy = "\x1b]9;4;3";
    let clear = "\x1b]9;4;0";
    let first = term.output_len();
    term.send(b"first turn\r");
    assert!(wait_until(secs(10), || {
        let bytes = term.output_since(first);
        let text = String::from_utf8_lossy(&bytes);
        text.split_once(busy)
            .is_some_and(|(_, rest)| rest.contains(clear))
    }));

    let second = term.output_len();
    term.send(b"second turn\r");
    assert!(wait_until(secs(5), || {
        String::from_utf8_lossy(&term.output_since(second)).contains(busy)
    }));
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&term, "progress", &agent.address);
    let bytes = term.output_since(second);
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.find(clear)
            .zip(text.find("Detached from progress"))
            .is_some_and(|(cleared, detached)| cleared < detached),
        "{text:?}"
    );
}

#[cfg(unix)]
#[test]
fn attach_restores_bracketed_paste_and_cooked_mode_on_signal() {
    let home = TestHome::new("attachsignal");
    let agent = home.start_fake("w1");
    for (signal, name) in [(libc::SIGTERM, "SIGTERM"), (libc::SIGHUP, "SIGHUP")] {
        let mut term = TestTerminal::spawn(
            home.command(&test_binaries().facade).args(["attach", "w1"]),
            100,
            30,
        );
        assert!(
            term.wait_for(secs(10), |t| t.contains("❯")),
            "{}",
            term.text()
        );
        assert!(
            wait_until(secs(5), || term.bracketed_paste()
                && !term.canonical_input_and_echo_enabled()),
            "attachment must enable agent modes and raw input"
        );
        send_signal(term.pid(), signal);
        let status = term
            .wait_exit(secs(5))
            .unwrap_or_else(|| panic!("attachment did not end on {name}"));
        assert!(!status.success(), "{name}: {status:?}");
        assert!(
            term.wait_for(secs(5), |t| t
                .contains(&format!("Attachment ended by {name}."))),
            "{name}: {}",
            term.text()
        );
        assert!(
            !term.bracketed_paste(),
            "{name}: bracketed paste must be disabled"
        );
        assert!(
            term.canonical_input_and_echo_enabled(),
            "{name}: canonical input and echo must be restored"
        );
        assert!(alive(&agent.process), "{name}: the agent keeps running");
    }
}

/// Ctrl-], and on Unix SIGTERM and SIGHUP, must restore the main screen and cooked input.
#[test]
fn attach_restores_main_screen_on_detach_or_signal() {
    let home = TestHome::new("detach");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "fullscreen",
        "printf '\\033[?1049hALT-READY'; sleep 60",
    );
    assert!(wait_for_screen_text(&home, &agent, "ALT-READY"));
    let address = address(&home, &agent);
    // Termination signals reach attach on Unix alone.
    #[cfg_attr(windows, allow(unused_mut))]
    let mut ends = vec![("ctrl-]", None::<&str>, 0)];
    #[cfg(unix)]
    ends.extend([
        (
            "SIGTERM",
            Some("Attachment ended by SIGTERM."),
            128 + libc::SIGTERM,
        ),
        (
            "SIGHUP",
            Some("Attachment ended by SIGHUP."),
            128 + libc::SIGHUP,
        ),
    ]);
    for (end, note, code) in ends {
        let mut term = TestTerminal::spawn(
            home.command(&test_binaries().facade)
                .args(["attach", &agent]),
            80,
            24,
        );
        assert!(
            term.wait_for(secs(10), |text| text.contains("ALT-READY")),
            "{end}: {}",
            term.text()
        );
        match end {
            "ctrl-]" => term.send(b"\x1d"),
            #[cfg(unix)]
            "SIGTERM" => send_signal(term.pid(), libc::SIGTERM),
            #[cfg(unix)]
            _ => send_signal(term.pid(), libc::SIGHUP),
            #[cfg(windows)]
            _ => unreachable!("only Ctrl-] ends an attachment on Windows"),
        }
        let status = term
            .wait_exit(secs(5))
            .unwrap_or_else(|| panic!("{end} did not end the attachment"));
        assert_eq!(status.code(), Some(code), "{end}");
        if let Some(note) = note {
            assert!(
                term.wait_for(secs(2), |text| text.contains(note)),
                "{end}: {}",
                term.text()
            );
        } else {
            assert_detach_receipt(&term, "fullscreen", &address);
        }
        assert!(
            !term.on_alternate_screen(),
            "{end} left the terminal on its alternate screen"
        );
        #[cfg(unix)]
        assert!(
            term.canonical_input_and_echo_enabled(),
            "{end} left the terminal raw"
        );
    }
}

/// Nothing of the agent's reaches the person's terminal once a termination signal restored it,
/// though the agent prints all the time, turning bracketed paste on in each line, and the
/// attachment's exit is held after the restoration, as a loaded machine can hold it: bracketed
/// paste stays off, and the note is the last thing shown. Core Review's reproduction (S17).
#[cfg(unix)]
#[test]
fn nothing_of_the_agent_follows_the_note_of_a_signal() {
    let home = TestHome::new("attachlate");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "chatty",
        "i=0; while :; do printf 'line %s\\033[?2004h\\r\\n' $i; i=$((i+1)); sleep 0.002; done",
    );
    assert!(wait_for_screen_text(&home, &agent, "line 5"));
    let mut command = home.command(&test_binaries().facade);
    let mut term = TestTerminal::spawn(
        command
            .env("FACADE_TEST_GATES", "attach-restored")
            .args(["attach", &agent]),
        80,
        24,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("line")),
        "{}",
        term.text()
    );
    send_signal(term.pid(), libc::SIGTERM);
    let core = home.path.join("core");
    assert!(
        wait_until(secs(10), || core.join("reached-attach-restored").exists()),
        "the signal did not restore the terminal"
    );
    // The agent prints a line every few milliseconds: hundreds come while the exit is held.
    std::thread::sleep(std::time::Duration::from_millis(500));
    std::fs::write(core.join("release-attach-restored"), b"").unwrap();
    term.wait_exit(secs(5)).expect("the attachment ended");
    // The attachment writes the note last: once the screen shows it, it shows everything the
    // attachment wrote.
    assert!(
        term.wait_for(secs(5), |text| text
            .contains("Attachment ended by SIGTERM.")),
        "{}",
        term.text()
    );
    let rows = term.rows();
    let last = rows
        .iter()
        .rev()
        .find(|row| !row.trim().is_empty())
        .cloned()
        .unwrap_or_default();
    assert!(
        !term.bracketed_paste(),
        "the agent's output turned bracketed paste back on; last row {last:?}"
    );
    assert!(
        last.contains("Attachment ended by SIGTERM."),
        "the agent's output came after the note: {last:?}"
    );
}

/// A connection lost once a termination signal restored the person's terminal draws no reconnect
/// note over it: the attachment is ending. A test gate holds its exit after the restoration while
/// the daemon ends and the keeper starts the next.
#[cfg(unix)]
#[test]
fn no_reconnect_note_follows_the_note_of_a_signal() {
    let home = TestHome::new("attachnote");
    let mut wire = connect(&home);
    let agent = start_script(&mut wire, &home, "quiet", "echo READY; sleep 60");
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let mut command = home.command(&test_binaries().facade);
    let mut term = TestTerminal::spawn(
        command
            .env("FACADE_TEST_GATES", "attach-restored")
            .args(["attach", &agent]),
        80,
        24,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("READY")),
        "{}",
        term.text()
    );
    send_signal(term.pid(), libc::SIGTERM);
    let core = home.path.join("core");
    assert!(
        wait_until(secs(10), || core.join("reached-attach-restored").exists()),
        "the signal did not restore the terminal"
    );
    let daemon = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .expect("the daemon answers") as i32;
    kill_process(daemon);
    home.wait_for_daemon_after(daemon, secs(30))
        .expect("the keeper starts the next daemon");
    std::fs::write(core.join("release-attach-restored"), b"").unwrap();
    term.wait_exit(secs(5)).expect("the attachment ended");
    // The attachment writes the note last: once the screen shows it, it shows everything the
    // attachment wrote.
    assert!(
        term.wait_for(secs(5), |text| text
            .contains("Attachment ended by SIGTERM.")),
        "{}",
        term.text()
    );
    let rows = term.rows();
    let last = rows
        .iter()
        .rev()
        .find(|row| !row.trim().is_empty())
        .cloned()
        .unwrap_or_default();
    assert!(
        last.contains("Attachment ended by SIGTERM.")
            && !term.text().contains(ATTACH_RECONNECT_NOTE),
        "{}",
        term.text()
    );
}

/// Detach recognizes a combined alternate-screen sequence and restores the main-screen cursor.
#[test]
fn detach_leaves_alternate_screen_set_with_other_modes() {
    let home = TestHome::new("detachmixed");
    let mut wire = connect(&home);
    // Enter alternate-screen mode after the snapshot so the test exercises the combined sequence.
    let agent = start_script(
        &mut wire,
        &home,
        "mixed",
        "echo READY; read go; printf '\\033[6;1HSAVED-MAIN-CONTEXT\\r\\n'; \
         while [ ! -e alternate ]; do sleep 0.05; done; \
         printf '\\033[?1049;25hALT-READY'; sleep 60",
    );
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &agent]),
        80,
        24,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("READY")),
        "{}",
        term.text()
    );
    type_raw(&mut wire, &agent, "go\r");
    assert!(
        term.wait_for(secs(5), |text| text.contains("SAVED-MAIN-CONTEXT")),
        "{}",
        term.text()
    );
    std::fs::write(home.project.join("alternate"), b"").unwrap();
    assert!(
        term.wait_for(secs(10), |text| text.contains("ALT-READY")) && term.on_alternate_screen(),
        "{}",
        term.text()
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success())
    );
    let address = address(&home, &agent);
    assert_detach_receipt(&term, "mixed", &address);
    assert!(!term.on_alternate_screen(), "left on the alternate screen");
    let rows = term.rows();
    assert!(
        rows.windows(2).any(|lines| {
            lines[0].contains("SAVED-MAIN-CONTEXT") && lines[1].contains("Detached from mixed (")
        }),
        "the receipt should follow the saved main-screen context: {rows:?}"
    );
}

/// Termination during the initial redraw must restore a terminal whose reader is slow.
#[cfg(unix)]
#[test]
fn attach_restores_terminal_when_signalled_during_initial_redraw() {
    let home = TestHome::new("earlysignal");
    let mut wire = connect(&home);
    let agent = start_script(&mut wire, &home, "long", "seq 1 30000; echo DONE; sleep 60");
    assert!(wait_for_screen_text(&home, &agent, "DONE"));
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &agent]),
        80,
        24,
    );
    term.pause(true);
    std::thread::sleep(secs(1));
    send_signal(term.pid(), libc::SIGTERM);
    term.pause(false);
    let status = term
        .wait_exit(secs(10))
        .expect("attachment did not end on SIGTERM");
    assert_eq!(status.code(), Some(128 + libc::SIGTERM), "{status:?}");
    assert!(
        term.canonical_input_and_echo_enabled(),
        "the terminal was left raw"
    );
}

#[test]
fn attach_forwards_input_and_ctrl_bracket_detaches() {
    let home = TestHome::new("attach");
    let agent = home.start_fake("w1");
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade).args(["attach", "w1"]),
        100,
        30,
    );
    assert!(
        term.wait_for(secs(10), |t| t.contains("fakecli (Facade test CLI)")
            && t.contains("❯")),
        "{}",
        term.text()
    );
    term.send(b"typed by a person");
    assert!(
        term.wait_for(secs(5), |t| t.contains("❯ typed by a person")),
        "{}",
        term.text()
    );
    term.send(b"\r");
    assert!(
        wait_until(secs(5), || home.submitted_messages()
            == ["typed by a person"]),
        "{:?}",
        home.submitted_messages()
    );
    term.send(b"\x1d");
    let status = term
        .wait_exit(secs(5))
        .expect("attachment did not end on Ctrl-]");
    assert!(status.success(), "{status:?}");
    assert!(
        alive(&agent.process),
        "the agent keeps running after a detach"
    );
    assert!(home.agent_from_watch("w1").expect("w1 is recorded")["process"] == "running");
}

#[test]
fn attach_views_share_the_smallest_grid_and_resize_only_owned_watches() {
    let home = TestHome::new("attach-grid");
    let agent = home.start_fake_with("Viewer", &[("FAKECLI_WRAP_TRANSCRIPT", "1")]);
    let address = agent.address.as_str();
    let wait_for_grid = |cols, rows| {
        assert!(
            wait_until(LOADED_TIMEOUT, || {
                let agent = home.inspect_agent(address)["agent"].clone();
                agent["size"] == json!({ "cols": cols, "rows": rows })
            }),
            "the terminal did not become {cols}×{rows}: {}",
            home.inspect_agent(address)
        );
    };
    let mut editor = DaemonTestClient::open(&home);
    let hello = editor.hello("ide", DAEMON_API_VERSIONS, json!({}));
    assert_eq!(hello["result"]["api_version"], 1, "{hello}");
    let reference = home.inspect_agent(address)["agent"]["reference"].clone();
    let opened = editor.request(
        "watch",
        json!({
            "topic": "attach", "args": { "target": reference, "size": { "cols": 120, "rows": 40 } }
        }),
    );
    let watch = opened["result"]["watch"].as_u64().expect("an Attach watch");
    assert_eq!(
        opened["result"]["snapshot"]["reference"], reference,
        "{opened}"
    );
    assert_eq!(
        opened["result"]["snapshot"]["size"],
        json!({ "cols": 120, "rows": 40 }),
        "{opened}"
    );
    wait_for_grid(120, 40);

    let mut small = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", address]),
        80,
        24,
    );
    let mut large = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", address]),
        150,
        45,
    );
    for viewer in [&small, &large] {
        assert!(
            viewer.wait_for(LOADED_TIMEOUT, |text| text.contains("❯")),
            "{}",
            viewer.text()
        );
    }
    wait_for_grid(80, 24);
    let redraws = || {
        editor
            .changes(watch)
            .into_iter()
            .filter(|event| event["change"]["kind"] == "redraw")
            .collect::<Vec<Value>>()
    };
    assert!(wait_until(LOADED_TIMEOUT, || redraws().iter().any(
        |event| { event["change"]["size"] == json!({ "cols": 80, "rows": 24 }) }
    )));

    let before = large.output_len();
    small.send(b"live echo\r");
    assert!(
        large.wait_for_bytes(before, b"live echo", LOADED_TIMEOUT),
        "{}",
        large.text()
    );
    assert!(
        small.wait_for(LOADED_TIMEOUT, |text| text.contains("> live echo")),
        "{}",
        small.text()
    );

    // The test CLI prints a two-cell prefix before an entered line. The suffix belongs on the
    // next row of both terminals, including the wide one, whose outer right margin stays blank.
    let long_line = format!("{}Z\r", "v".repeat(80));
    small.send(long_line.as_bytes());
    let wraps_at_80 = |viewer: &TestTerminal| {
        let view = viewer.view();
        view.rows.windows(2).any(|rows| {
            rows[0][0].text == ">"
                && rows[0][2..80].iter().all(|cell| cell.text == "v")
                && rows[0][80..].iter().all(|cell| cell.text == " ")
                && rows[1][0].text == "v"
                && rows[1][1].text == "v"
                && rows[1][2].text == "Z"
        })
    };
    for viewer in [&small, &large] {
        assert!(
            wait_until(LOADED_TIMEOUT, || wraps_at_80(viewer)),
            "{}",
            viewer.text()
        );
    }

    let shared_redraws = redraws().len();
    let before = large.output_len();
    large.resize(155, 46);
    assert!(large.wait_for_bytes(before, b"Facade test CLI", LOADED_TIMEOUT));
    assert!(
        wait_until(LOADED_TIMEOUT, || wraps_at_80(&large)),
        "{}",
        large.text()
    );
    wait_for_grid(80, 24);
    assert_eq!(
        redraws().len(),
        shared_redraws,
        "growing the largest viewer redrew the shared grid"
    );

    small.send(b"\x1d");
    assert!(
        small
            .wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&small, "Viewer", address);
    wait_for_grid(120, 40);

    let mut other = connect(&home);
    let unowned = other.call(
        "attach.resize",
        json!({ "watch": watch, "size": { "cols": 10, "rows": 10 } }),
    );
    assert_eq!(error_reason(&unowned), "not_found", "{unowned}");
    wait_for_grid(120, 40);
    let opened = other.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": reference, "size": { "cols": 120, "rows": 40 } } }),
    );
    let other_watch = opened["result"]["watch"]
        .as_u64()
        .expect("a second Attach watch");
    assert_eq!(
        opened["result"]["snapshot"]["reference"], reference,
        "{opened}"
    );
    other.write(&json!({
        "jsonrpc": "2.0", "method": "call", "params": {
            "op": "attach.resize",
            "args": { "watch": other_watch, "size": { "cols": 95, "rows": 30 } },
        },
    }));
    wait_for_grid(95, 30);
    drop(other);
    wait_for_grid(120, 40);

    let closed = editor.request("unwatch", json!({ "watch": watch }));
    assert!(closed["result"].is_object(), "{closed}");
    wait_for_grid(155, 46);
    large.send(b"\x1d");
    assert!(
        large
            .wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert!(alive(&agent.process));
}

/// Input preceding Ctrl-] in the same read must reach the agent.
#[test]
fn detach_delivers_preceding_input() {
    let home = TestHome::new("detachinput");
    let typed = home.start_fake("w1");
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &typed.id]),
        100,
        30,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯")),
        "{}",
        term.text()
    );
    term.send(b"before detaching\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success())
    );
    assert!(
        wait_for_screen_text(&home, "w1", "❯ before detaching"),
        "{}",
        home.screen("w1")
    );
}

#[cfg(unix)]
#[test]
fn a_malformed_reconnect_ends_attach_and_keeps_the_unsent_count() {
    use std::io::{BufRead, BufReader, Read, Write};
    let home = TestHome::new("attachbadhello");
    // Use the fake terminal without its MCP relay, which would also try to start the lost daemon.
    home.add_custom_cli("attach-fixture", &test_binaries().fakecli);
    home.run_facade_ok(&["start", "-d", "--name", "held", "attach-fixture"]);
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["attach", "held"])
        .env("FACADE_TEST_GATES", "attach-evidence");
    let mut term = TestTerminal::spawn(&mut command, 110, 30);
    assert!(term.wait_for(secs(10), |text| text.contains("❯")));
    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    home.kill_daemon();
    std::fs::remove_file(home.daemon_socket()).unwrap();
    assert!(home.hello_result().is_none());
    // The socket is gone before the attachment's reader necessarily closes its input queue.
    home.wait_for_gate("attach-disconnected");
    term.send(b"held keys");
    home.wait_for_gate("attach-buffered-input");

    // The keys are already counted when the next connection starts its hello.
    let listener = std::os::unix::net::UnixListener::bind(home.daemon_socket()).unwrap();
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(LOADED_TIMEOUT)).unwrap();
        let mut hello = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut hello)
            .unwrap();
        let hello: serde_json::Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(hello["method"], "hello");
        stream.write_all(b"{malformed\n").unwrap();
        // End the reply without closing the read half while Attach handles it.
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(stream.read(&mut [0]).unwrap(), 0);
        listener
    });
    assert_eq!(
        term.wait_exit(LOADED_TIMEOUT)
            .and_then(|status| status.code()),
        Some(1),
        "{}",
        term.text_with_scrollback()
    );
    assert!(
        term.wait_for_output(secs(2), "error: Lost connection to held ("),
        "{}",
        term.text_with_scrollback()
    );
    assert!(
        term.wait_for_output(secs(2), "warning: 9 bytes you typed were not sent"),
        "{}",
        term.text_with_scrollback()
    );
    assert_eq!(term.output_count(ATTACH_RECONNECT_NOTE), 0);
    let listener = peer.join().unwrap();
    listener.set_nonblocking(true).unwrap();
    let extra = listener.accept();
    assert!(
        matches!(&extra, Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "a malformed hello must end Attach without another reconnect: {extra:?}"
    );
    resume_process(keeper);
}
