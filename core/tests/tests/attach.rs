//! Terminal attachment and restoration on detach, exit, or termination signals.

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

/// Detach must recognize alternate-screen mode inside a combined mode sequence.
#[test]
fn detach_leaves_alternate_screen_set_with_other_modes() {
    let home = TestHome::new("detachmixed");
    let mut wire = connect(&home);
    // Enter alternate-screen mode after the snapshot so the test exercises the combined sequence.
    let agent = start_script(
        &mut wire,
        &home,
        "mixed",
        "echo READY; read go; printf '\\033[?1049;25hALT-READY'; sleep 60",
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
