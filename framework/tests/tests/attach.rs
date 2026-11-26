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
    // The narrow test terminal can wrap the receipt. Check the emitted text and that the detach
    // notice is visible on the restored screen.
    assert!(
        term.wait_for_output(secs(2), &detached),
        "{}",
        term.text_with_scrollback()
    );
    assert!(
        term.wait_for(secs(2), |text| text.contains(&shown)),
        "{}",
        term.text()
    );
    assert_eq!(term.output_count(&detached), 1);
    assert_eq!(term.output_count("Reattach with 'facade attach"), 0);
}

fn wait_for_title(term: &TestTerminal, from: usize, title: &str) {
    // ConPTY can serialize the title as OSC 0 with BEL. A Unix PTY preserves OSC 2 with ST.
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            let bytes = term.output_since(from);
            let output = String::from_utf8_lossy(&bytes);
            [0, 2].into_iter().any(|osc| {
                ["\x07", "\x1b\\"]
                    .into_iter()
                    .any(|end| output.contains(&format!("\x1b]{osc};{title}{end}")))
            })
        }),
        "missing title {title:?}: {:?}",
        String::from_utf8_lossy(&term.output_since(from))
    );
}

#[test]
fn foreground_attach_returns_the_selected_process_exit_status() {
    let home = TestHome::new("attachexit");
    let other = home.start_fake("other");
    home.add_custom_cli_with("attach-exit", &test_binaries().fakecli, &["--attach-exit"]);
    // This scenario checks exit propagation. Keep the same geometry on both sides so
    // the first Attach does not also resize the managed console while input starts.
    let (cols, rows) = (100, 30);
    let started = connect(&home).call_ok(
        "agent.start",
        json!({
            "cli": "attach-exit", "name": "selected", "folder": home.project,
            "env": { "FACADE_HOME": home.path }, "size": { "cols": cols, "rows": rows },
        }),
    );
    let agent = started["agent"]["reference"]["agent_id"]
        .as_str()
        .expect("the selected agent has an ID");
    let selected = address(&home, agent);
    let mut terminal = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &selected]),
        cols,
        rows,
    );
    assert!(terminal.wait_for_output(LOADED_TIMEOUT, "ATTACH-READY"));
    terminal.send(b"finish\r");
    let exit = terminal
        .wait_exit(LOADED_TIMEOUT)
        .expect("the foreground Attach exited");
    assert_eq!(exit.code(), Some(23), "{}", terminal.text_with_scrollback());
    assert!(terminal.wait_for_output(secs(5), "ATTACH-FINISHED"));
    assert!(terminal.wait_for_output(
        secs(5),
        &format!("selected ({selected}) exited with code 23.")
    ));
    assert_eq!(home.agent_record(&other.id).unwrap()["process"], "running");
}

#[test]
fn foreground_alternate_first_start_hands_the_same_shell_page_back() {
    let home = TestHome::new("alternate-first");
    let _wire = connect(&home);
    let mut term = TestTerminal::spawn(
        home.command(shell()).args([
            "-c",
            "printf 'HOST-HISTORY\\n'; \
             i=0; while [ \"$i\" -lt 24 ]; do printf 'shell line %s\\n' \"$i\"; i=$((i + 1)); done; \
             printf 'HOST-PAGE\\nHOST-PROMPT\\n'; \
             facade start --name Alternate-first \"$@\"; result=$?; \
             printf 'HOST-RETURN\\n'; exit \"$result\"",
            "host",
            home.shell_cli(),
            "-c",
            "while [ ! -f title ]; do sleep 0.05; done; \
             printf '\\033]2;Before alternate\\007'; \
             while [ ! -f alternate ]; do sleep 0.05; done; \
             printf '\\033[?1049h\\033[3;1HALT-FIRST\\033]2;Alternate first\\007'; \
             while [ ! -f next ]; do sleep 0.05; done; \
             printf '\\033[3;1HALT-NEXT \\033]2;Alternate latest\\007'; \
             sleep 60",
        ]),
        100,
        24,
    );
    // The opening is printed only after the snapshot is received. Until then the fixture has
    // emitted no CLI output, so the snapshot is an empty primary buffer.
    assert!(
        term.wait_for_output(LOADED_TIMEOUT, "Started Alternate-first ("),
        "{}",
        term.text_with_scrollback()
    );
    std::fs::write(home.project.join("title"), b"").unwrap();
    wait_for_title(&term, 0, "Before alternate");
    assert!(!term.on_alternate_screen());
    assert!(
        term.text().contains("HOST-PAGE\nHOST-PROMPT"),
        "{}",
        term.text_with_scrollback()
    );

    for (gate, text, title) in [
        ("alternate", "ALT-FIRST", "Alternate first"),
        ("next", "ALT-NEXT", "Alternate latest"),
    ] {
        let from = term.output_len();
        std::fs::write(home.project.join(gate), b"").unwrap();
        wait_for_title(&term, from, title);
        assert!(
            term.wait_for(LOADED_TIMEOUT, |view| view.contains(text)) && term.on_alternate_screen(),
            "{}",
            term.text()
        );
    }

    let agent = home.inspect_agent("Alternate-first");
    let address = agent["agent"]["address"].as_str().expect("an address");
    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&term, "Alternate-first", address);
    assert!(term.wait_for(LOADED_TIMEOUT, |view| view.contains("HOST-RETURN")));
    assert!(!term.on_alternate_screen());
    let page = term.text();
    assert!(page.contains("HOST-PAGE\nHOST-PROMPT"), "{page}");
    assert!(!page.contains("ALT-NEXT"), "{page}");
    assert_eq!(
        term.text_with_scrollback().matches("HOST-HISTORY").count(),
        1
    );
    assert_eq!(home.inspect_agent(address)["agent"]["process"], "running");
    #[cfg(unix)]
    assert!(term.canonical_input_and_echo_enabled());
}

/// A CLI's output can arrive in parts. The one that brings the first draw can end inside a frame
/// that the CLI draws as one synchronized update.
#[test]
fn the_first_draw_shows_the_start_of_an_unfinished_frame() {
    let home = TestHome::new("unfinished-frame");
    let mut term = start_below_a_shell_page(
        &home,
        "Unfinished-frame",
        "while [ ! -f start ]; do sleep 0.05; done; \
         printf '\\033[?1049h\\033[?2026h\\033[HFIRST-PART '; \
         while [ ! -f rest ]; do sleep 0.05; done; \
         printf 'SECOND-PART\\033[?2026l'; sleep 60",
    );
    std::fs::write(home.project.join("start"), b"").unwrap();
    assert!(
        wait_until(LOADED_TIMEOUT, || term.on_alternate_screen()),
        "{}",
        term.text_with_scrollback()
    );
    std::fs::write(home.project.join("rest"), b"").unwrap();
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view
            .contains("FIRST-PART SECOND-PART")),
        "{}",
        term.text()
    );

    let agent = home.inspect_agent("Unfinished-frame");
    let address = agent["agent"]["address"].as_str().expect("an address");
    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&term, "Unfinished-frame", address);
}

/// Runs a Shell command below a shell page with history above it.
fn run_below_a_shell_page(home: &TestHome, args: &[&str]) -> TestTerminal {
    TestTerminal::spawn(
        home.command(shell())
            .args([
                "-c",
                "printf 'HOST-HISTORY\\n'; \
                 i=0; while [ \"$i\" -lt 24 ]; do printf 'shell line %s\\n' \"$i\"; i=$((i + 1)); done; \
                 printf 'HOST-PAGE\\nHOST-PROMPT\\n'; \
                 facade \"$@\"; result=$?; \
                 printf 'HOST-RETURN\\n'; exit \"$result\"",
                "host",
            ])
            .args(args)
            // As in an SSH session, what a test selects stays off this computer's clipboard.
            .env("SSH_TTY", "test"),
        100,
        24,
    )
}

/// Starts `cli -c script` in the foreground as `name`, below the host shell page.
fn start_below_a_shell_page(home: &TestHome, name: &str, script: &str) -> TestTerminal {
    let term = run_below_a_shell_page(
        home,
        &["start", "--name", name, home.shell_cli(), "-c", script],
    );
    assert!(
        term.wait_for_output(LOADED_TIMEOUT, &format!("Started {name} (")),
        "{}",
        term.text_with_scrollback()
    );
    term
}

/// After the attachment ends, the host is on its main screen and the shell page is as before,
/// followed by the opening line, `receipt` and the shell's next line, with none of `agent_text`.
fn assert_shell_page_returned(
    term: &TestTerminal,
    opening: &str,
    receipt: &str,
    agent_text: &[&str],
) {
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("HOST-RETURN")),
        "{}",
        term.text_with_scrollback()
    );
    assert!(!term.on_alternate_screen());
    let text = term.text_with_scrollback();
    assert_eq!(text.matches("HOST-HISTORY").count(), 1, "{text}");
    for shown in agent_text {
        assert!(!text.contains(shown), "{shown}: {text}");
    }
    let (_, after) = text
        .split_once("HOST-PAGE\nHOST-PROMPT\n")
        .unwrap_or_else(|| panic!("no shell page: {text}"));
    assert_eq!(
        after.trim_end(),
        format!("{opening}\n{receipt}\nHOST-RETURN"),
        "{text}"
    );
}

#[test]
fn foreground_exit_hands_the_shell_page_back() {
    let home = TestHome::new("exit-page");
    let _wire = connect(&home);
    // The kinds of CLI recorded: one drawing on its main screen that writes its resume hint twice,
    // one leaving its alternate screen to print a hint, and one leaving it to reprint a transcript
    // longer than the screen.
    let cases = [
        (
            "Main-hint",
            "quit-main",
            "printf 'MAIN-FRAME\\n'; \
             while [ ! -f quit-main ]; do sleep 0.05; done; \
             printf 'Resume with -c MAIN-HINT\\nMAIN-FRAME\\nResume with -c MAIN-HINT\\n'; exit 0",
            "MAIN-FRAME",
            &["MAIN-FRAME", "Resume with", "MAIN-HINT"][..],
        ),
        (
            "Alternate-hint",
            "quit-hint",
            "printf '\\033[?1049h\\033[1;1HALT-FRAME'; \
             while [ ! -f quit-hint ]; do sleep 0.05; done; \
             printf '\\033[?1049lTo continue this session, run:\\n  demo resume ALT-HINT\\n'; exit 0",
            "ALT-FRAME",
            &["ALT-FRAME", "To continue this session", "ALT-HINT"][..],
        ),
        (
            "Transcript",
            "quit-transcript",
            "printf '\\033[?1049h\\033[1;1HTRANSCRIPT-FRAME'; \
             while [ ! -f quit-transcript ]; do sleep 0.05; done; \
             printf '\\033[?1049l'; \
             i=0; while [ \"$i\" -lt 40 ]; do printf 'TRANSCRIPT-LINE %s\\n' \"$i\"; i=$((i + 1)); done; \
             exit 0",
            "TRANSCRIPT-FRAME",
            &["TRANSCRIPT-FRAME", "TRANSCRIPT-LINE"][..],
        ),
    ];
    for (name, gate, script, frame, agent_text) in cases {
        let mut term = start_below_a_shell_page(&home, name, script);
        assert!(
            term.wait_for(LOADED_TIMEOUT, |view| view.contains(frame))
                && term.on_alternate_screen(),
            "{name}: {}",
            term.text()
        );
        let address = home.inspect_agent(name)["agent"]["address"]
            .as_str()
            .expect("an address")
            .to_string();
        std::fs::write(home.project.join(gate), b"").unwrap();
        let status = term.wait_exit(LOADED_TIMEOUT);
        assert!(
            status.is_some_and(|status| status.success()),
            "{name}: {status:?}"
        );
        assert_shell_page_returned(
            &term,
            &format!("Started {name} ({address}). Press Ctrl+] to detach."),
            &format!("{name} ({address}) exited with code 0."),
            agent_text,
        );
    }
}

#[test]
fn detach_from_a_main_screen_cli_hands_the_shell_page_back() {
    let home = TestHome::new("detach-page");
    let _wire = connect(&home);
    let name = "Main-detach";
    let mut term = start_below_a_shell_page(
        &home,
        name,
        "printf 'MAIN-FRAME\\n'; while IFS= read -r line; do printf 'GOT-%s\\n' \"$line\"; done; sleep 60",
    );
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("MAIN-FRAME"))
            && term.on_alternate_screen(),
        "{}",
        term.text()
    );
    let address = home.inspect_agent(name)["agent"]["address"]
        .as_str()
        .expect("an address")
        .to_string();
    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&term, name, &address);
    assert_shell_page_returned(
        &term,
        &format!("Started {name} ({address}). Press Ctrl+] to detach."),
        &format!("Detached from {name} ({address}). The agent is still running."),
        &["MAIN-FRAME"],
    );
    assert_eq!(home.inspect_agent(&address)["agent"]["process"], "running");

    // Attach shows the agent again and takes input.
    let mut again = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &address]),
        100,
        24,
    );
    assert!(
        again.wait_for(LOADED_TIMEOUT, |view| view.contains("MAIN-FRAME"))
            && again.on_alternate_screen(),
        "{}",
        again.text()
    );
    again.send(b"hello\r");
    assert!(
        again.wait_for(LOADED_TIMEOUT, |view| view.contains("GOT-hello")),
        "{}",
        again.text()
    );
    again.send(b"\x1d");
    assert!(
        again
            .wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
}

/// Waits for `rows` at the top of the host's alternate screen, which shows the agent on either of
/// its screens for the whole attachment.
fn wait_for_viewport(term: &TestTerminal, rows: [&str; 3]) {
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            term.rows()[..rows.len()] == rows && term.on_alternate_screen()
        }),
        "expected {rows:?} in the host's alternate screen, got {:?}",
        term.rows()
    );
}

#[test]
fn shell_viewports_preserve_native_activity_and_repaint_only_on_transitions() {
    let home = TestHome::new("attach-viewport-output");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "Viewports",
        "printf '\\033[1;1HPRIMARY-TOP\\033[2;1Hprimary-stale-tail\\033[3;1HPRIMARY-BOTTOM\\033]2;Native snapshot\\007'; \
         while [ ! -f shorten ]; do sleep 0.05; done; \
         printf '\\033]9;4;1;21\\007\\033[2;1Hshort\\033[K\\033]2;Native steady\\007'; \
         while [ ! -f alternate ]; do sleep 0.05; done; \
         printf '\\033[?1049h\\033]9;4;1;42\\007\\033[1;1HALT-TOP\\033[2;1Halternate-stale-tail\\033[3;1HALT-BOTTOM\\033]2;Native alternate\\007'; \
         while [ ! -f update ]; do sleep 0.05; done; \
         printf '\\033]9;4;1;63\\007\\033[2;1Hsmall\\033[K\\033]2;Native alternate update\\007'; \
         while [ ! -f primary ]; do sleep 0.05; done; \
         printf '\\033[?1049l\\033]9;4;0;0\\007\\033[2;1Hback\\033[K\\033]2;Native primary return\\007'; \
         sleep 60",
    );
    assert!(wait_for_screen_text(&home, &agent, "primary-stale-tail"));
    let address = address(&home, &agent);
    let mut small = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &address]),
        80,
        24,
    );
    let initial_rows = ["PRIMARY-TOP", "primary-stale-tail", "PRIMARY-BOTTOM"];
    wait_for_title(&small, 0, "Native snapshot");
    wait_for_viewport(&small, initial_rows);
    let mut large = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &address]),
        120,
        35,
    );
    wait_for_title(&large, 0, "Native snapshot");
    wait_for_viewport(&large, initial_rows);
    let agent_info = home.inspect_agent(&address);
    let size = json!({ "cols": 80, "rows": 24 });
    assert_eq!(agent_info["agent"]["size"], size);
    // Observe the daemon's output and redraw order without changing the shared grid.
    let watch = {
        let opened = wire.request(
            "watch",
            json!({ "topic": "attach", "args": { "target": agent_info["agent"]["reference"], "size": size } }),
        );
        opened["result"]["watch"].as_u64().expect("an Attach watch")
    };

    let batches = [
        (
            "shorten",
            "\x1b]9;4;1;21\x07",
            "Native steady",
            ["PRIMARY-TOP", "short", "PRIMARY-BOTTOM"],
            false,
        ),
        (
            "alternate",
            "\x1b]9;4;1;42\x07",
            "Native alternate",
            ["ALT-TOP", "alternate-stale-tail", "ALT-BOTTOM"],
            true,
        ),
        (
            "update",
            "\x1b]9;4;1;63\x07",
            "Native alternate update",
            ["ALT-TOP", "small", "ALT-BOTTOM"],
            false,
        ),
        (
            "primary",
            "\x1b]9;4;0;0\x07",
            "Native primary return",
            ["PRIMARY-TOP", "back", "PRIMARY-BOTTOM"],
            true,
        ),
    ];
    let mut activity_counts = Vec::new();
    for (gate, activity, title, rows, full_draw) in batches {
        let starts = [small.output_len(), large.output_len()];
        std::fs::write(home.project.join(gate), b"").unwrap();
        let mut counts = [0; 2];
        for (index, (term, from)) in [&small, &large].into_iter().zip(starts).enumerate() {
            wait_for_title(term, from, title);
            wait_for_viewport(term, rows);
            counts[index] = String::from_utf8_lossy(&term.output_since(from))
                .matches(activity)
                .count();
        }
        activity_counts.push((gate, counts));
        let bytes = large.output_since(starts[1]);
        let frame = String::from_utf8_lossy(&bytes);
        let cleared = ["\x1b[J", "\x1b[0J", "\x1b[1J", "\x1b[2J", "\x1b[3J"]
            .iter()
            .any(|clear| frame.contains(clear));
        // Full draws stay on the agent's screen switches, and the host keeps its alternate screen.
        assert_eq!(cleared, full_draw, "{gate}: {frame:?}");
        assert!(!frame.contains("\x1b[?1049"), "{gate}: {frame:?}");
    }

    // Make the larger terminal larger still. The shared grid stays at 80×24, but the host
    // receives another frame in its new geometry with the last native title.
    let from = large.output_len();
    large.resize(130, 40);
    wait_for_title(&large, from, "Native primary return");
    assert!(String::from_utf8_lossy(&large.output_since(from)).contains("\x1b[J"));
    wait_for_viewport(&large, ["PRIMARY-TOP", "back", "PRIMARY-BOTTOM"]);
    assert_eq!(home.inspect_agent(&address)["agent"]["size"], size);

    for term in [&mut large, &mut small] {
        term.send(b"\x1d");
        assert!(
            term.wait_exit(LOADED_TIMEOUT)
                .is_some_and(|status| status.success())
        );
        assert_detach_receipt(term, "Viewports", &address);
    }
    let returned = batches[3].1;
    let changes = wire.changes(watch);
    let return_output = changes
        .iter()
        .filter(|event| event["change"]["kind"] == "output")
        .filter_map(|event| event["change"]["data"].as_str())
        .filter_map(|data| facade_base::base64::decode(data).ok())
        .filter(|bytes| {
            bytes
                .windows(returned.len())
                .any(|part| part == returned.as_bytes())
        })
        .count();
    assert_eq!(
        activity_counts,
        [
            ("shorten", [1, 1]),
            ("alternate", [1, 1]),
            ("update", [1, 1]),
            ("primary", [1, 1]),
        ],
        "complete activity per batch in small and large Shell viewers, with {return_output} on the public watch at primary return"
    );
    assert_eq!(return_output, 1);
    for term in [&small, &large] {
        assert_eq!(term.output_count("\x1b]9;4;"), batches.len());
    }
    #[cfg(unix)]
    assert!(
        changes.windows(2).any(|events| {
            events[0]["change"]
                == json!({
                    "kind": "output", "data": facade_base::base64::encode(returned.as_bytes())
                })
                && events[1]["change"]["kind"] == "redraw"
        }),
        "expected the replacement redraw after the primary return's activity"
    );
}

#[test]
fn attach_preserves_native_progress_without_injecting_its_own() {
    let home = TestHome::new("attachprogress");
    let agent = home.start_named_fake(
        "progress",
        &[
            ("FAKECLI_STATUS", "1"),
            ("FAKECLI_TURN_MS", "3000"),
            ("FAKECLI_PROGRESS", "1"),
        ],
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
    let busy = b"\x1b]9;4;1;37";
    let clear = b"\x1b]9;4;0;37";
    let first = term.output_len();
    term.send(b"first turn\r");
    assert!(term.wait_for_bytes(first, busy, secs(5)));
    assert!(term.wait_for_bytes(first, clear, secs(10)));

    let second = term.output_len();
    term.send(b"second turn\r");
    assert!(term.wait_for_bytes(second, busy, secs(5)));
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success())
    );
    // The CLI writes two progress starts and one clear. Attach emits no additional progress.
    assert_eq!(term.output_count("\x1b]9;4;"), 3);
    assert_detach_receipt(&term, "progress", &agent.address);
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
/// paste stays off, and the note is the last thing shown.
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
    let framework = home.path.join("framework");
    assert!(
        wait_until(secs(10), || framework
            .join("reached-attach-restored")
            .exists()),
        "the signal did not restore the terminal"
    );
    // The agent prints a line every few milliseconds: hundreds come while the exit is held.
    std::thread::sleep(std::time::Duration::from_millis(500));
    std::fs::write(framework.join("release-attach-restored"), b"").unwrap();
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
    let framework = home.path.join("framework");
    assert!(
        wait_until(secs(10), || framework
            .join("reached-attach-restored")
            .exists()),
        "the signal did not restore the terminal"
    );
    let daemon = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .expect("the daemon answers") as i32;
    kill_process(daemon);
    home.wait_for_daemon_after(daemon, secs(30))
        .expect("the keeper starts the next daemon");
    std::fs::write(framework.join("release-attach-restored"), b"").unwrap();
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

/// Attach follows a combined alternate-screen sequence, and detach returns the shell page.
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
    // The agent's screens leave with the view: the receipt follows the opening line.
    let rows = term.rows();
    assert!(
        rows.windows(2).any(|lines| {
            lines[0].ends_with("Press Ctrl+] to detach.")
                && lines[1].starts_with("Detached from mixed (")
        }),
        "the receipt should follow the opening line: {rows:?}"
    );
    for shown in ["SAVED-MAIN-CONTEXT", "ALT-READY"] {
        assert!(
            !rows.iter().any(|row| row.contains(shown)),
            "{shown}: {rows:?}"
        );
    }
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
fn attach_wheel_browses_main_screen_history_without_typing_into_the_cli() {
    let home = TestHome::new("attach-wheel");
    let transcript = home.folder().join("wheel-transcript");
    let keys = home.folder().join("wheel-input");
    // The CLI uses the main screen, enables alternate scroll, and leaves mouse reporting off.
    // The transcript is present before the viewer opens its watch.
    let mut history = String::from("\x1b[?1007h");
    for row in 1..=80 {
        use std::fmt::Write as _;
        writeln!(history, "\x1b[31mWHEEL-HISTORY-{row:02}\x1b[0m").unwrap();
    }
    std::fs::write(&transcript, history).unwrap();
    let name = "Wheel";
    let agent = home.start_fake_with(
        name,
        &[
            ("FAKECLI_SCREEN_FILE", transcript.to_str().unwrap()),
            ("FAKECLI_KEYS", keys.to_str().unwrap()),
            ("FAKECLI_NAME", "WHEEL-LIVE"),
        ],
    );
    let mut term = run_below_a_shell_page(&home, &["attach", &agent.address]);
    let shows_live = |text: &str| text.contains("WHEEL-LIVE") && text.contains("❯");
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            shows_live(&term.text()) && term.on_alternate_screen()
        }),
        "{}",
        term.text()
    );
    assert!(!term.text().contains("WHEEL-HISTORY-"), "{}", term.text());
    assert!(wait_until(LOADED_TIMEOUT, || keys.is_file()));
    let read_keys = || std::fs::read(&keys).unwrap();
    let before = read_keys();

    let wheel_up = b"\x1b[<64;6;8M".repeat(8);
    let wheel_down = b"\x1b[<65;6;8M".repeat(8);
    let shows_history = || {
        let view = term.view();
        !view.cursor_visible
            && view.rows.iter().any(|row| {
                row.first().is_some_and(|cell| cell.colored)
                    && row
                        .iter()
                        .map(|cell| cell.text.as_str())
                        .collect::<String>()
                        .starts_with("WHEEL-HISTORY-")
            })
    };
    term.send(&wheel_up);
    assert!(
        wait_until(secs(5), shows_history),
        "wheel up never showed the colored history; CLI bytes: {:?}; viewport:\n{}",
        read_keys(),
        term.text()
    );
    assert_eq!(read_keys(), before, "wheel up reached the CLI");

    term.send(&wheel_down);
    assert!(
        wait_until(secs(5), || {
            shows_live(&term.text()) && term.view().cursor_visible
        }),
        "{}",
        term.text()
    );
    assert_eq!(read_keys(), before, "wheel down reached the CLI");
    term.send(&wheel_up);
    assert!(wait_until(secs(5), shows_history), "{}", term.text());
    term.send(b"z");
    assert!(
        wait_until(secs(5), || {
            term.text().contains("❯ z") && term.view().cursor_visible
        }),
        "{}",
        term.text()
    );

    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&term, name, &agent.address);
    assert_shell_page_returned(
        &term,
        &format!(
            "Attached to {name} ({}). Press Ctrl+] to detach.",
            agent.address
        ),
        &format!(
            "Detached from {name} ({}). The agent is still running.",
            agent.address
        ),
        &["WHEEL-HISTORY-", "WHEEL-LIVE"],
    );
    assert_eq!(read_keys(), [before, b"z".to_vec()].concat());
    assert!(alive(&agent.process));
}

/// A CLI that asks for the mouse gets all of it. The host's mouse modes are set only when they change.
#[test]
fn attach_gives_the_mouse_to_a_cli_that_asks_for_it() {
    let home = TestHome::new("attach-mouse");
    let transcript = home.folder().join("fullscreen-screen");
    let keys = home.folder().join("fullscreen-keys");
    std::fs::write(
        &transcript,
        "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003;2004h\x1b[?1006h\x1b[?1007hFULLSCREEN-CLI",
    )
    .unwrap();
    let agent = home.start_fake_with(
        "Fullscreen",
        &[
            ("FAKECLI_SCREEN_FILE", transcript.to_str().unwrap()),
            ("FAKECLI_KEYS", keys.to_str().unwrap()),
            ("FAKECLI_NAME", "FULLSCREEN-PROMPT"),
        ],
    );
    let mut term = run_below_a_shell_page(&home, &["attach", &agent.address]);
    assert!(term.wait_for(LOADED_TIMEOUT, |text| text.contains("FULLSCREEN-PROMPT")));
    assert!(wait_until(LOADED_TIMEOUT, || term.reports_mouse() && keys.is_file()));
    let read_keys = || std::fs::read(&keys).unwrap();
    let mut expected = read_keys();
    let mut reaches = |event: &[u8]| {
        term.send(event);
        expected.extend_from_slice(event);
        assert!(
            wait_until(secs(5), || read_keys() == expected),
            "guest input: {:?}",
            read_keys()
        );
    };
    let settled = term.output_len();
    reaches(b"\x1b[<64;12;4M\x1b[<0;12;4M\x1b[<0;12;4m\x1b[<2;12;4M\x1b[<2;12;4m");
    reaches(b"\x1bOAz");
    // The command below goes into an empty input.
    reaches(b"\x7f");
    let modes = String::from_utf8_lossy(&term.output_since(settled)).into_owned();
    assert!(!modes.contains("\x1b[?1006"), "{modes:?}");

    // Once the CLI lets the mouse go, its clicks stay with Attach, and on its alternate screen the
    // wheel presses Up as the terminal app would, three rows for each step.
    std::fs::write(&transcript, "\x1b[?1003l\x1b[?1006l").unwrap();
    home.run_facade_ok(&["type", &agent.id, "/fake screen", "--enter"]);
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            String::from_utf8_lossy(&term.output_since(settled)).contains("\x1b[?1002h")
        }),
        "host received {:?}\nagent screen:\n{}",
        String::from_utf8_lossy(&term.output_since(settled)),
        home.screen(&agent.id)
    );
    let before = read_keys();
    term.send(b"\x1b[<64;12;4M\x1b[<0;12;4M\x1b[<0;12;4mq");
    assert!(
        wait_until(secs(5), || read_keys().ends_with(b"q")),
        "{:?}",
        read_keys()
    );
    assert_eq!(
        read_keys(),
        [before, b"\x1b[A".repeat(3), b"q".to_vec()].concat()
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(10))
            .is_some_and(|status| status.success())
    );
    assert!(!term.on_alternate_screen());
    assert!(
        !term.reports_mouse(),
        "detach returns the mouse to the host"
    );
}

/// A CLI that leaves the mouse alone leaves it to the terminal app, where the keyboard tells the
/// wheel from the arrow keys the app sends for it.
#[test]
fn the_wheel_scrolls_while_the_terminal_app_has_the_mouse() {
    let home = TestHome::new("attach-host-mouse");
    if !facade_base::desktop::sees_keys() {
        return;
    }
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["start", "--name", "Host-mouse", home.shell_cli(), "-c"])
            .arg(
                "i=1; while [ \"$i\" -le 60 ]; do printf 'LINE-%02d\\n' \"$i\"; i=$((i + 1)); done; \
                 printf 'READY\\n'; exec cat",
            )
            .env("TERM_PROGRAM", "Apple_Terminal"),
        100,
        24,
    );
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("READY")),
        "{}",
        term.text_with_scrollback()
    );
    assert!(term.on_alternate_screen() && !term.reports_mouse());
    assert!(
        term.wait_for_bytes(0, b"\x1b[?1h", secs(5)),
        "the host does not send the wheel as cursor keys"
    );
    assert!(!term.text().contains("LINE-35"), "{}", term.text());

    term.send(b"\x1bOA\x1bOA\x1bOA\x1bOA");
    assert!(
        term.wait_for(secs(5), |view| view.contains("LINE-35")
            && !view.contains("READY")),
        "{}",
        term.text()
    );
    term.send(b"\x1bOB\x1bOB\x1bOB\x1bOB");
    assert!(
        term.wait_for(secs(5), |view| view.contains("READY")),
        "{}",
        term.text()
    );
    // Other cursor keys reach the CLI as it asked for them.
    #[cfg(unix)]
    {
        term.send(b"\x1bOCx\r");
        assert!(
            term.wait_for(secs(5), |view| view.contains("^[[Cx")),
            "{}",
            term.text()
        );
        assert!(!term.text().contains("^[OA"), "{}", term.text());
    }
    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert!(!term.on_alternate_screen());
}

#[test]
fn attach_refuses_the_removed_mouse_option() {
    let home = TestHome::new("attach-mouse-option");
    let refused = home
        .command(&test_binaries().facade)
        .args(["attach", "--mouse", "ada"])
        .output()
        .unwrap();
    let error = stderr(&refused);
    assert_eq!(refused.status.code(), Some(2), "{error}");
    assert!(error.contains("Unknown option '--mouse'."), "{error}");
    assert!(error.contains("Usage: facade attach <AGENT>"), "{error}");
    assert!(
        !home.path.join("framework").exists(),
        "invalid arguments reached Facade"
    );
}

const SELECTION_WORD: &str = "é界";

fn attach_selection_fixture(
    home: &TestHome,
    keyboard: &str,
) -> (TestAgent, TestTerminal, std::path::PathBuf) {
    let transcript = home.folder().join("selection-transcript");
    let keys = home.folder().join("selection-input");
    let mut history = format!("\x1b[?1007h{keyboard}");
    for line in 1..=80 {
        use std::fmt::Write as _;
        writeln!(
            history,
            "\x1b[31mSEL-HISTORY-{line:02} A{SELECTION_WORD}Z\x1b[0m"
        )
        .unwrap();
    }
    std::fs::write(&transcript, history).unwrap();
    let agent = home.start_fake_with(
        "Selection",
        &[
            ("FAKECLI_SCREEN_FILE", transcript.to_str().unwrap()),
            ("FAKECLI_KEYS", keys.to_str().unwrap()),
            ("FAKECLI_NAME", "SEL-LIVE Aé界Z"),
        ],
    );
    let term = run_below_a_shell_page(home, &["attach", &agent.address]);
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            term.on_alternate_screen()
                && term.text().contains("SEL-LIVE")
                && term.text().contains("❯")
                && keys.is_file()
        }),
        "{}",
        term.text()
    );
    (agent, term, keys)
}

struct SelectionSpan {
    row: usize,
    cells: [facade_screen::VisibleCell; 4],
}

impl SelectionSpan {
    fn visible(term: &TestTerminal, prefix: &str) -> Self {
        for (number, row) in term.view().rows.into_iter().enumerate() {
            let text: String = row.iter().map(|cell| cell.text.as_str()).collect();
            if text.starts_with(prefix)
                && let Some(cells) = row.windows(4).find(|cells| {
                    cells
                        .iter()
                        .map(|cell| cell.text.as_str())
                        .eq(["A", "é", "界", "Z"])
                })
            {
                return Self {
                    row: number,
                    cells: std::array::from_fn(|index| cells[index].clone()),
                };
            }
        }
        panic!("no selectable span on {prefix:?} in:\n{}", term.text());
    }

    fn report(&self, term: &TestTerminal, button: u8, index: usize, release: bool) {
        let col = self.cells[index].column + 1;
        let row = self.row + 1;
        let end = if release { 'm' } else { 'M' };
        term.send(format!("\x1b[<{button};{col};{row}{end}").as_bytes());
    }

    fn displayed(&self, term: &TestTerminal, highlighted: bool) -> bool {
        let view = term.view();
        view.rows.get(self.row).is_some_and(|row| {
            self.cells.iter().enumerate().all(|(index, cell)| {
                let mut expected = cell.clone();
                if highlighted && matches!(index, 1 | 2) {
                    expected.inverse = !expected.inverse;
                }
                row.iter().find(|visible| visible.column == cell.column) == Some(&expected)
            })
        })
    }

    fn drag(&self, term: &TestTerminal, from: usize, to: usize) {
        self.report(term, 0, from, false);
        self.report(term, 32, to, false);
        assert!(
            wait_until(secs(5), || self.displayed(term, true)),
            "plain left drag did not highlight only {SELECTION_WORD:?}:\n{}",
            term.text()
        );
        let release = term.output_len();
        self.report(term, 0, to, true);
        assert_selection_copy(term, release, 1);
    }
}

fn clipboard_writes(output: &[u8]) -> Vec<Vec<u8>> {
    let prefix = b"\x1b]52;";
    let mut output = output;
    let mut writes = Vec::new();
    while let Some(start) = output.windows(prefix.len()).position(|part| part == prefix) {
        let record = &output[start + prefix.len()..];
        let Some(end) = record.iter().position(|&byte| matches!(byte, 0x07 | 0x1b)) else {
            break;
        };
        let terminator = if record[end] == 0x07 {
            1
        } else if record.get(end + 1) == Some(&b'\\') {
            2
        } else {
            break;
        };
        let record_text = std::str::from_utf8(&record[..end]).unwrap();
        let (destination, payload) = record_text.split_once(';').unwrap();
        assert!(
            destination == "c" || destination.is_empty(),
            "unexpected OSC 52 destination {destination:?}"
        );
        writes.push(facade_base::base64::decode(payload).expect("OSC 52 contains base64"));
        output = &record[end + terminator..];
    }
    writes
}

fn assert_selection_copy(term: &TestTerminal, from: usize, count: usize) {
    let expected = vec![SELECTION_WORD.as_bytes().to_vec(); count];
    assert!(
        wait_until(secs(5), || clipboard_writes(&term.output_since(from))
            == expected),
        "expected {count} OSC 52 writes of {SELECTION_WORD:?}, got {:?}",
        clipboard_writes(&term.output_since(from))
    );
}

fn detach_from_selection(term: &mut TestTerminal, agent: &TestAgent) {
    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(term, "Selection", &agent.address);
    assert_shell_page_returned(
        term,
        &format!(
            "Attached to Selection ({}). Press Ctrl+] to detach.",
            agent.address
        ),
        &format!(
            "Detached from Selection ({}). The agent is still running.",
            agent.address
        ),
        &["SEL-HISTORY-", "SEL-LIVE"],
    );
}

#[test]
fn attach_drag_selects_and_copies_live_text() {
    let home = TestHome::new("attach-selection-live");
    let (agent, mut term, keys) = attach_selection_fixture(&home, "");
    let read_keys = || std::fs::read(&keys).unwrap();
    let mut expected = read_keys();
    let span = SelectionSpan::visible(&term, "SEL-LIVE ");
    assert!(span.cells[1].bold);

    span.drag(&term, 1, 2);
    let copy = term.output_len();
    term.send(b"\x03");
    assert_selection_copy(&term, copy, 1);
    assert!(
        span.displayed(&term, true),
        "copy cleared the live selection"
    );

    #[cfg(windows)]
    {
        // A copy press, auto-repeat and its key-up share one input batch.
        let from = term.output_len();
        let copy_press = b"\x1b[67;46;3;1;8;1_";
        let copy_release = b"\x1b[67;46;0;0;8;1_";
        term.send(&[copy_press.as_slice(), copy_press, copy_release].concat());
        assert_selection_copy(&term, from, 2);
        assert!(
            span.displayed(&term, true),
            "Win32 copy cleared the selection"
        );
    }

    // Ordinary typing clears the highlight before the later Ctrl+C in the same batch.
    let after_copy = term.output_len();
    term.send(b"z\x03");
    expected.extend_from_slice(b"z\x03");
    assert!(wait_until(secs(5), || read_keys() == expected));
    assert!(wait_until(secs(5), || span.displayed(&term, false)));
    assert!(clipboard_writes(&term.output_since(after_copy)).is_empty());
    term.send(b"k");
    expected.push(b'k');
    assert!(term.wait_for(secs(5), |text| text.contains("❯ k")));
    detach_from_selection(&mut term, &agent);
    assert_eq!(read_keys(), expected);
}

#[test]
fn attach_kitty_ctrl_c_copies_only_a_completed_selection() {
    let home = TestHome::new("attach-selection-kitty");
    // Antigravity requests these Kitty flags and queries them at startup.
    let (agent, mut term, keys) = attach_selection_fixture(&home, "\x1b[>5u\x1b[?u");
    assert!(term.wait_for_bytes(0, b"\x1b[=5;1u", LOADED_TIMEOUT));
    let read_keys = || std::fs::read(&keys).unwrap();
    let mut expected = read_keys();
    let ctrl_c = b"\x1b[99;5u";

    let unselected = term.output_len();
    term.send(ctrl_c);
    expected.extend_from_slice(ctrl_c);
    assert!(
        wait_until(secs(5), || read_keys() == expected),
        "{:?}",
        read_keys()
    );
    assert!(clipboard_writes(&term.output_since(unselected)).is_empty());

    let span = SelectionSpan::visible(&term, "SEL-LIVE ");
    span.drag(&term, 1, 2);
    let selected = term.output_len();
    term.send(ctrl_c);
    assert!(
        wait_until(secs(5), || {
            !clipboard_writes(&term.output_since(selected)).is_empty() || read_keys() != expected
        }),
        "no selection copy or CLI input"
    );
    assert_eq!(
        clipboard_writes(&term.output_since(selected)),
        [SELECTION_WORD.as_bytes().to_vec()],
        "selected Kitty Ctrl+C reached ordinary input: {:?}",
        read_keys()
    );
    assert_eq!(read_keys(), expected);
    assert!(span.displayed(&term, true), "copy cleared the selection");

    let modified = term.output_len();
    let shift_ctrl_c = b"\x1b[99;6u";
    term.send(shift_ctrl_c);
    expected.extend_from_slice(shift_ctrl_c);
    assert!(
        wait_until(secs(5), || read_keys() == expected),
        "{:?}",
        read_keys()
    );
    assert!(clipboard_writes(&term.output_since(modified)).is_empty());
    assert!(wait_until(secs(5), || span.displayed(&term, false)));
    detach_from_selection(&mut term, &agent);
    assert_eq!(read_keys(), expected);
}

#[test]
fn attach_kitty_ctrl_c_owns_the_completed_selection_key_lifecycle() {
    let home = TestHome::new("attach-selection-kitty-events");
    let (agent, mut term, keys) = attach_selection_fixture(&home, "\x1b[>7u\x1b[?u");
    assert!(term.wait_for_bytes(0, b"\x1b[=7;1u", LOADED_TIMEOUT));
    let read_keys = || std::fs::read(&keys).unwrap();
    let mut expected = read_keys();
    let press = b"\x1b[99;5u";
    let explicit_press = b"\x1b[99;5:1u";
    let repeat = b"\x1b[99;5:2u";
    let release = b"\x1b[99;5:3u";

    let from = term.output_len();
    let ordinary = [explicit_press.as_slice(), repeat, release].concat();
    term.send(&ordinary);
    expected.extend_from_slice(&ordinary);
    assert!(
        wait_until(secs(5), || read_keys() == expected),
        "unselected Kitty key reports changed: {:?}",
        read_keys()
    );
    assert!(clipboard_writes(&term.output_since(from)).is_empty());

    let span = SelectionSpan::visible(&term, "SEL-LIVE ");
    span.drag(&term, 1, 2);
    let selected = term.output_len();
    term.send(press);
    assert_selection_copy(&term, selected, 1);
    term.send(repeat);
    assert!(
        wait_until(secs(5), || {
            clipboard_writes(&term.output_since(selected)).len() >= 2 || read_keys() != expected
        }),
        "no Kitty repeat copy or CLI input"
    );
    assert_eq!(
        clipboard_writes(&term.output_since(selected)),
        vec![SELECTION_WORD.as_bytes().to_vec(); 2],
        "selected Kitty repeat reached the CLI: {:?}",
        read_keys()
    );
    assert_eq!(read_keys(), expected);
    assert!(span.displayed(&term, true), "repeat cleared the selection");

    term.send(release);
    let next_press = term.output_len();
    term.send(explicit_press);
    assert_selection_copy(&term, next_press, 1);
    assert!(span.displayed(&term, true), "release cleared the selection");
    assert_eq!(read_keys(), expected);

    term.send(b"z");
    expected.push(b'z');
    assert!(wait_until(secs(5), || read_keys() == expected
        && span.displayed(&term, false)));
    // A matching C key-up belongs to the copy even after typing and releasing Control.
    term.send(b"\x1b[99;1:3uq");
    expected.push(b'q');
    assert!(
        wait_until(secs(5), || read_keys() == expected),
        "{:?}",
        read_keys()
    );
    assert_eq!(
        clipboard_writes(&term.output_since(selected)),
        vec![SELECTION_WORD.as_bytes().to_vec(); 3]
    );
    detach_from_selection(&mut term, &agent);
    assert_eq!(read_keys(), expected);
}

#[test]
fn attach_drag_selects_and_copies_scrollback() {
    let home = TestHome::new("attach-selection-history");
    let (agent, mut term, keys) = attach_selection_fixture(&home, "");
    let read_keys = || std::fs::read(&keys).unwrap();
    let mut expected = read_keys();

    term.send(&b"\x1b[<64;6;8M".repeat(8));
    assert!(
        wait_until(secs(5), || {
            !term.view().cursor_visible && term.rows()[0].starts_with("SEL-HISTORY-62 ")
        }),
        "{}",
        term.text()
    );
    let span = SelectionSpan::visible(&term, "SEL-HISTORY-");
    assert!(span.cells[1].colored);

    span.drag(&term, 2, 1);
    let copy = term.output_len();
    span.report(&term, 2, 1, false);
    assert_selection_copy(&term, copy, 1);
    assert!(
        span.displayed(&term, true),
        "copy cleared the history selection"
    );

    span.report(&term, 0, 1, false);
    span.report(&term, 0, 1, true);
    assert!(wait_until(secs(5), || span.displayed(&term, false)));
    assert!(!term.view().cursor_visible, "click left the history view");
    term.send(&b"\x1b[<65;6;8M".repeat(8));
    assert!(
        wait_until(secs(5), || {
            term.view().cursor_visible && term.text().contains("❯")
        }),
        "{}",
        term.text()
    );
    assert_eq!(read_keys(), expected);
    term.send(b"z");
    expected.push(b'z');
    assert!(term.wait_for(secs(5), |text| text.contains("❯ z")));
    detach_from_selection(&mut term, &agent);
    assert_eq!(read_keys(), expected);
}

#[test]
fn attach_wheel_keeps_its_place_when_full_history_receives_output() {
    let home = TestHome::new("attach-wheel-cap");
    let started = home.run_facade_ok(&[
        "start",
        "-d",
        "--name",
        "Wheel-cap",
        home.shell_cli(),
        "-c",
        "printf '\\033[?1007h'; \
         i=1; while [ \"$i\" -le 1050 ]; do printf 'CAP-%04d\\n' \"$i\"; i=$((i + 1)); done; \
         while [ ! -f append ]; do sleep 0.05; done; \
         while [ \"$i\" -le 1062 ]; do printf 'CAP-%04d\\n' \"$i\"; i=$((i + 1)); done; \
         printf '\\033]2;Cap appended\\007'; sleep 60",
    ]);
    let address = started_ref(&started);
    assert!(wait_for_screen_text(&home, address, "CAP-1050"));

    let mut term = run_below_a_shell_page(&home, &["attach", address]);
    assert!(term.wait_for(LOADED_TIMEOUT, |text| text.contains("CAP-1050")));
    let first_row = || {
        term.rows()[0]
            .strip_prefix("CAP-")
            .and_then(|line| line.trim_end().parse::<u32>().ok())
    };
    let live = first_row().expect("the live viewport has numbered rows");
    let held = live - 24;
    let wheel_up = b"\x1b[<64;6;8M";
    term.send(&wheel_up.repeat(8));
    assert!(
        wait_until(LOADED_TIMEOUT, || first_row() == Some(held)),
        "could not browse back to {held}: {:?}",
        first_row()
    );

    let from = term.output_len();
    std::fs::write(home.project.join("append"), b"").unwrap();
    wait_for_title(&term, from, "Cap appended");
    assert_eq!(first_row(), Some(held), "output moved the held viewport");
    term.send(wheel_up);
    assert!(
        wait_until(secs(5), || first_row() == Some(held - 3)),
        "expected three older rows from {held}, got {:?}",
        first_row()
    );

    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
}

#[cfg(windows)]
#[test]
fn attach_win32_modifiers_do_not_leave_held_history() {
    let home = TestHome::new("attach-wheel-native-shift");
    let started = home.run_facade_ok(&[
        "start",
        "-d",
        "--name",
        "Wheel-shift",
        home.shell_cli(),
        "-c",
        "trap '' INT; \
         i=1; while [ \"$i\" -le 80 ]; do printf 'SHIFT-%02d\\n' \"$i\"; i=$((i + 1)); done; \
         printf '\\033[?1007h'; \
         while [ ! -f win32 ]; do sleep 0.05; done; \
         printf '\\033[?9001h\\033]2;Win32 input active\\007'; \
         while :; do sleep 0.05; done",
    ]);
    let address = started_ref(&started);
    assert!(wait_for_screen_text(&home, address, "SHIFT-80"));
    let mut term = run_below_a_shell_page(&home, &["attach", address]);
    assert!(term.wait_for(LOADED_TIMEOUT, |text| text.contains("SHIFT-80")));
    let first_row = || {
        term.rows()[0]
            .strip_prefix("SHIFT-")
            .and_then(|line| line.trim_end().parse::<u32>().ok())
    };
    let live = first_row().expect("live rows are numbered");
    let held = live - 24;
    let wheel_up = b"\x1b[<64;6;8M";
    term.send(&wheel_up.repeat(8));
    assert!(
        wait_until(LOADED_TIMEOUT, || first_row() == Some(held)
            && !term.view().cursor_visible),
        "did not reach held row {held}: {:?}",
        first_row()
    );

    let from = term.output_len();
    std::fs::write(home.project.join("win32"), b"").unwrap();
    wait_for_title(&term, from, "Win32 input active");
    assert!(term.wait_for_bytes(from, b"\x1b[?9001h", LOADED_TIMEOUT));
    assert_eq!(first_row(), Some(held));
    term.send(b"\x1b[16;42;0;1;16;1_\x1b[16;42;0;0;0;1_");
    term.send(wheel_up);
    assert!(
        wait_until(secs(5), || first_row() == Some(held - 3)
            && !term.view().cursor_visible),
        "after native Shift and one wheel-up from row {held}, expected {}, got {:?}",
        held - 3,
        first_row()
    );
    eprintln!(
        "win32 input advertised; held row {held} advanced to {} after Shift and one wheel-up",
        held - 3
    );

    term.send(b"\x1b[88;45;120;1;0;1_\x1b[88;45;120;0;0;1_");
    assert!(
        wait_until(secs(5), || first_row() == Some(live)
            && term.view().cursor_visible),
        "a native printable key did not return to live"
    );
    term.send(b"\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m");
    assert!(wait_until(secs(5), || {
        let view = term.view();
        !view.cursor_visible && view.rows[0][..5].iter().all(|cell| cell.inverse)
    }));
    let copy = term.output_len();
    term.send(b"\x1b[67;46;3;1;8;1_\x1b[67;46;0;0;8;1_");
    assert!(wait_until(secs(5), || {
        clipboard_writes(&term.output_since(copy)) == [b"SHIFT".to_vec()]
    }));
    let from = term.output_len();
    term.send(b"\x1b[67;46;3;1;24;1_");
    assert!(wait_until(secs(5), || {
        term.view().cursor_visible || !clipboard_writes(&term.output_since(from)).is_empty()
    }));
    let copies = clipboard_writes(&term.output_since(from));
    assert!(
        copies.is_empty(),
        "Shift+Ctrl+C copied the selection in Win32 input mode: {copies:?}"
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&term, "Wheel-shift", address);
}

#[test]
fn attach_keeps_the_host_page_until_a_blank_main_screen_draws() {
    let home = TestHome::new("attach-blank-history");
    let name = "Blank-history";
    let started = home.run_facade_ok(&[
        "start",
        "-d",
        "--name",
        name,
        home.shell_cli(),
        "-c",
        "i=1; while [ \"$i\" -le 80 ]; do printf 'EMPTY-HISTORY-%02d\\n' \"$i\"; i=$((i + 1)); done; \
         printf '\\033[H\\033[2J\\033]2;Blank frame ready\\007'; \
         : > blank; while [ ! -f draw ]; do sleep 0.05; done; \
         printf 'FIRST-VISIBLE\\n'; sleep 60",
    ]);
    let address = started_ref(&started);
    assert!(wait_until(LOADED_TIMEOUT, || home
        .project
        .join("blank")
        .is_file()));
    assert!(wait_for_screen_text(&home, address, "EMPTY-HISTORY-40"));

    let mut term = run_below_a_shell_page(&home, &["attach", address]);
    wait_for_title(&term, 0, "Blank frame ready");
    assert!(
        !term.on_alternate_screen() && term.text().contains("HOST-PAGE\nHOST-PROMPT"),
        "blank main frame displaced the host page:\n{}",
        term.text()
    );

    std::fs::write(home.project.join("draw"), b"").unwrap();
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            term.on_alternate_screen() && term.text().contains("FIRST-VISIBLE")
        }),
        "{}",
        term.text()
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(LOADED_TIMEOUT)
            .is_some_and(|status| status.success())
    );
    assert_detach_receipt(&term, name, address);
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

/// The title a terminal shows after `output`: the last one set with OSC 0 or 2, where a title
/// saved with `CSI 22 t` comes back with `CSI 23 t`.
fn shown_title(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output);
    let (mut title, mut saved) = (String::new(), Vec::new());
    let mut rest = &*text;
    while let Some(at) = rest.find('\x1b') {
        rest = &rest[at + 1..];
        if let Some(osc) = rest.strip_prefix(']') {
            let end = osc.find(['\x07', '\x1b']).unwrap_or(osc.len());
            if let Some(set) = osc[..end]
                .strip_prefix("0;")
                .or_else(|| osc[..end].strip_prefix("2;"))
            {
                title = set.to_string();
            }
            rest = &osc[end..];
        } else if let Some(csi) = rest.strip_prefix('[') {
            let end = csi
                .find(|ch: char| ('@'..='~').contains(&ch))
                .unwrap_or(csi.len());
            if csi[end..].starts_with('t') {
                let mut params = csi[..end].split(';');
                let (operation, which) = (params.next(), params.next().unwrap_or("0"));
                match (operation, which) {
                    (Some("22"), "0" | "2") => saved.push(title.clone()),
                    (Some("23"), "0" | "2") => title = saved.pop().unwrap_or(title),
                    _ => {}
                }
            }
            rest = &csi[end..];
        }
    }
    title
}

/// Every title `output` sets with OSC 0 or 2, in order.
fn titles_set(output: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(output);
    text.split("\x1b]")
        .skip(1)
        .filter_map(|osc| {
            let end = osc.find(['\x07', '\x1b']).unwrap_or(osc.len());
            let osc = &osc[..end];
            osc.strip_prefix("0;")
                .or_else(|| osc.strip_prefix("2;"))
                .map(str::to_string)
        })
        .collect()
}

/// The status glyphs of Claude Code's rule: the resting one, and the working frames.
const RESTING: &str = "✳ ";
const WORKING: [&str; 2] = ["◐ ", "◑ "];
/// The title the reporting test CLI sets.
const TITLE: &str = "OC | Greeting";

/// Whether `title` starts with a status glyph.
fn has_glyph(title: &str) -> bool {
    [RESTING, WORKING[0], WORKING[1]]
        .iter()
        .any(|glyph| title.starts_with(glyph))
}

/// `TITLE` with `glyph` before it.
fn glyphed(glyph: &str) -> String {
    format!("{glyph}{TITLE}")
}

/// Whether `title` is the host's own title. An empty title is not: a console that gets one shows
/// a label of its own, such as a path.
fn host_s_own(title: &str) -> bool {
    title == "HOST-TITLE"
}

/// The environment of a test CLI titled `TITLE` that reports its state, first after `delay_ms`;
/// each message it takes is a turn that lasts until it reports something else.
fn reporting(delay_ms: &'static str) -> Vec<(&'static str, &'static str)> {
    vec![
        ("FAKECLI_TITLE", TITLE),
        ("FAKECLI_STATUS", "1"),
        ("FAKECLI_STATUS_DELAY_MS", delay_ms),
        ("FAKECLI_TURN_MS", "600000"),
    ]
}

/// Writes the settings that run the test CLI as `claude`, under Claude Code's rule, and connects to
/// the services.
fn claude_is_the_test_cli(home: &TestHome) -> DaemonTestClient {
    std::fs::write(
        home.path.join("facade.json"),
        json!({ "clis": { "claude": { "type": "claude", "program": test_binaries().fakecli } } })
            .to_string(),
    )
    .unwrap();
    connect(home)
}

/// Runs `facade <args>` in the background with `env`, and returns its output.
fn facade_with(home: &TestHome, args: &[&str], env: &[(&str, &str)]) -> String {
    let output = home
        .command(&test_binaries().facade)
        .args(args)
        .envs(env.iter().copied())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {}", stderr(&output));
    stdout(&output)
}

/// The Agent State `facade status` gives `agent`.
fn state_of(home: &TestHome, agent: &str) -> String {
    let status = home.run_facade_ok(&["status", agent]);
    status_field(&status, "State")
        .unwrap_or_default()
        .to_string()
}

/// The Agent State `facade list` gives the agent named `name`.
fn listed_state(home: &TestHome, name: &str) -> String {
    let list = home.run_facade_ok(&["list"]);
    let table = Table::parse(&list);
    let row = table
        .row("NAME", name)
        .unwrap_or_else(|| panic!("{name} is not listed: {list}"));
    table.cell(row, "STATE").to_string()
}

/// A host shell that sets its own title, then runs `facade <args>` in the foreground with `env`,
/// and says HOST-RETURN when it ends. Returned once the CLI's input box shows.
fn host_running(home: &TestHome, args: &[&str], env: &[(&str, &str)]) -> TestTerminal {
    let mut host = home.command(shell());
    host.args([
        "-c",
        "printf '\\033]2;HOST-TITLE\\007HOST-PROMPT\\n'; facade \"$@\"; printf 'HOST-RETURN\\n'",
        "host",
    ])
    .args(args)
    .envs(env.iter().copied());
    let term = TestTerminal::spawn(&mut host, 100, 24);
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("❯")) && term.on_alternate_screen(),
        "{args:?}: {}",
        term.text_with_scrollback()
    );
    term
}

/// Types `text` into the attached CLI and submits it.
fn submit(term: &TestTerminal, text: &str) {
    term.send(text.as_bytes());
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains(text)),
        "{text}: {}",
        term.text()
    );
    term.send(b"\r");
}

/// The title the host shows now.
fn shown(term: &TestTerminal) -> String {
    shown_title(&term.output_since(0))
}

/// Waits until the host shows `title`.
fn shows(term: &TestTerminal, title: &str, case: &str) {
    assert!(
        wait_until(LOADED_TIMEOUT, || shown(term) == title),
        "{case}: {title:?} not shown; titles {:?}",
        titles_set(&term.output_since(0))
    );
}

/// Asserts that the host showed the plain startup title before the first glyph.
fn plain_before_the_first_glyph(term: &TestTerminal, case: &str) {
    let titles = titles_set(&term.output_since(0));
    let plain = titles.iter().position(|title| title == TITLE);
    let glyph = titles.iter().position(|title| has_glyph(title));
    assert!(
        plain.is_some() && plain < glyph,
        "{case}: no plain startup title before the first glyph: {titles:?}"
    );
}

/// Whether `output` shows both working frames.
fn animates(output: &[u8]) -> bool {
    let titles = titles_set(output);
    WORKING.iter().all(|glyph| titles.contains(&glyphed(glyph)))
}

/// Waits until the host has shown both working frames since `mark`.
fn animates_since(term: &TestTerminal, mark: usize, case: &str) {
    assert!(
        wait_until(secs(10), || animates(&term.output_since(mark))),
        "{case}: working shows both frames; titles {:?}",
        titles_set(&term.output_since(mark))
    );
}

/// Asserts that the host shows `title` and gets no working frame in the next 3 seconds.
fn rests_on(term: &TestTerminal, title: &str, case: &str) {
    shows(term, title, case);
    let mark = term.output_since(0).len();
    std::thread::sleep(secs(3));
    let after = titles_set(&term.output_since(mark));
    assert!(
        !after
            .iter()
            .any(|title| WORKING.iter().any(|glyph| title.starts_with(glyph))),
        "{case}: working frames after {title:?}: {after:?}"
    );
}

/// Ends the attachment with `key`, then asserts that the host's own title is back and that no
/// title follows in the next 3 seconds.
fn ends_with_the_host_s_title(term: &mut TestTerminal, key: &[u8], case: &str) {
    term.send(key);
    assert!(
        term.wait_exit(LOADED_TIMEOUT).is_some(),
        "{case}: {}",
        term.text_with_scrollback()
    );
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("HOST-RETURN")),
        "{case}: {}",
        term.text_with_scrollback()
    );
    assert!(host_s_own(&shown(term)), "{case}: {:?}", shown(term));
    let end = term.output_since(0).len();
    std::thread::sleep(secs(3));
    let after = titles_set(&term.output_since(end));
    assert!(
        after.is_empty() && host_s_own(&shown(term)),
        "{case}: titles after the end: {after:?}"
    );
}

/// Attached to Claude Code, which reports its state through the Program Status Protocol, the host
/// shows its negotiated title with the glyph of its Agent State: `✳`
/// while idle or done, `◐` and `◑` in turn while working, `✳` for a turn whose background work
/// still runs (which `list` and `status` give as Idle), none while the title is empty or once the
/// report is taken back. The glyph stops at the end and the host's own title comes back, whether
/// the agent exits or the person detaches while it works.
#[test]
fn the_host_shows_the_status_glyph_of_the_attached_claude_code() {
    let home = TestHome::new("attach-glyph");
    let _wire = claude_is_the_test_cli(&home);
    for detach_while_working in [false, true] {
        let name = format!("glyph-{detach_while_working}");
        let case = format!("detach while working: {detach_while_working}");
        let mut term = host_running(
            &home,
            &["start", "--name", &name, "claude"],
            &reporting("5000"),
        );
        shows(&term, &glyphed(RESTING), &case);
        plain_before_the_first_glyph(&term, &case);

        let mark = term.output_since(0).len();
        submit(&term, "work");
        animates_since(&term, mark, &case);
        if detach_while_working {
            ends_with_the_host_s_title(&mut term, b"\x1d", &case);
            continue;
        }

        submit(&term, "/fake status done");
        rests_on(&term, &glyphed(RESTING), &case);

        submit(&term, "/fake title");
        shows(&term, "", &case);
        submit(&term, &format!("/fake title {TITLE}"));
        shows(&term, &glyphed(RESTING), &case);

        let mark = term.output_since(0).len();
        submit(&term, "work");
        animates_since(&term, mark, &case);
        submit(&term, "/fake status working 1 shell still running");
        rests_on(&term, &glyphed(RESTING), &case);
        assert_eq!(
            [listed_state(&home, &name), state_of(&home, &name)],
            ["Idle", "Idle"],
            "{case}: a turn whose background work still runs"
        );

        submit(&term, "/fake clear");
        shows(&term, TITLE, &case);
        ends_with_the_host_s_title(&mut term, b"\x04", &case);
    }
}

/// No glyph where one of its conditions is missing: Claude Code that never reports keeps its own
/// title, so does Claude Code without a title of its own, and a CLI that reports without a
/// `status_glyph` in its rule (the test CLI under its own rule) keeps its titles byte for byte.
#[test]
fn the_host_shows_no_glyph_without_the_rule_a_report_or_a_title() {
    let home = TestHome::new("attach-noglyph");
    let _wire = claude_is_the_test_cli(&home);
    let silent = [("FAKECLI_TITLE", TITLE), ("FAKECLI_TURN_MS", "600000")];
    let reports = reporting("0");
    let untitled: Vec<_> = reports
        .iter()
        .copied()
        .filter(|(variable, _)| *variable != "FAKECLI_TITLE")
        .collect();
    for (name, cli, env, title, reported) in [
        ("silent", "claude", &silent[..], Some(TITLE), false),
        ("untitled", "claude", &untitled[..], None, true),
        ("own-rule", "fake", &reports[..], Some(TITLE), true),
    ] {
        let mut term = host_running(&home, &["start", "--name", name, cli], env);
        submit(&term, "work");
        assert!(
            term.wait_for(LOADED_TIMEOUT, |view| view.contains("> work")),
            "{name}: {}",
            term.text()
        );
        if reported {
            assert!(
                wait_until(LOADED_TIMEOUT, || listed_state(&home, name) == "Working"),
                "{name} reports working: {}",
                home.run_facade_ok(&["list"])
            );
        }
        std::thread::sleep(secs(3));
        let titles = titles_set(&term.output_since(0));
        match title {
            Some(title) => {
                assert!(
                    titles.iter().all(|set| host_s_own(set) || set == title),
                    "{name}: {titles:?}"
                );
                assert_eq!(shown(&term), title, "{name}: {titles:?}");
            }
            None => assert!(
                titles.iter().all(|set| host_s_own(set)),
                "{name}: {titles:?}"
            ),
        }
        ends_with_the_host_s_title(&mut term, b"\x04", name);
    }
}

/// A resumed Claude Code starts with a plain title, then shows the new run's negotiated title
/// with the glyph of what it reports.
#[test]
fn a_resumed_claude_code_shows_no_glyph_until_it_reports_again() {
    const SESSION: &str = "3333cccc-2bae-4a45-b193-a5664c198263";
    let home = TestHome::new("attach-glyph-resume");
    let _wire = claude_is_the_test_cli(&home);
    home.save_claude_session(SESSION, "a reporting conversation");
    let env = reporting("5000");
    let receipt = facade_with(&home, &["resume", "-d", &SESSION[..8]], &env);
    let address = receipt
        .split_once(" (")
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(address, _)| address.to_string())
        .unwrap_or_else(|| panic!("no address in the receipt: {receipt:?}"));
    assert!(
        wait_until(LOADED_TIMEOUT, || state_of(&home, &address) == "Idle"),
        "{}",
        home.run_facade_ok(&["status", &address])
    );
    home.run_facade_ok(&["stop", &address]);
    assert!(
        wait_until(LOADED_TIMEOUT, || state_of(&home, &address)
            .starts_with("Ended")),
        "{}",
        home.run_facade_ok(&["status", &address])
    );
    let mut term = host_running(&home, &["resume", &address], &env);
    shows(&term, &glyphed(RESTING), "resume");
    plain_before_the_first_glyph(&term, "resume");
    ends_with_the_host_s_title(&mut term, b"\x04", "resume");
}

/// Claude Code that already set its negotiated title shows its glyph to each viewer: `facade attach`
/// and an editor watching the `attach` topic get it in the snapshot's title, and both see the
/// working frames and the resting glyph that follow.
#[test]
fn every_viewer_of_claude_code_that_already_reported_gets_its_glyph() {
    let home = TestHome::new("attach-glyph-viewers");
    let _wire = claude_is_the_test_cli(&home);
    facade_with(
        &home,
        &["start", "-d", "--name", "early", "claude"],
        &reporting("0"),
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || state_of(&home, "early") == "Idle"),
        "{}",
        home.run_facade_ok(&["status", "early"])
    );
    assert!(wait_for_screen_text(&home, "early", "negotiated title"));
    let mut editor = DaemonTestClient::open(&home);
    editor.hello("ide", DAEMON_API_VERSIONS, json!({}));
    let watching = editor.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": "early" } }),
    );
    let watch = watching["result"]["watch"]
        .as_u64()
        .unwrap_or_else(|| panic!("no watch: {watching}"));
    let snapshot = watching["result"]["snapshot"]["redraw"]
        .as_str()
        .and_then(|redraw| facade_base::base64::decode(redraw).ok())
        .unwrap_or_else(|| panic!("no redraw: {watching}"));
    assert_eq!(
        shown_title(&snapshot),
        glyphed(RESTING),
        "the editor's snapshot"
    );
    let editor_sees = || {
        let mut bytes = snapshot.clone();
        for change in editor.changes(watch) {
            if let Some(data) = change["change"]["data"].as_str() {
                bytes.extend(facade_base::base64::decode(data).unwrap_or_default());
            }
        }
        bytes
    };

    let mut term = host_running(&home, &["attach", "early"], &[]);
    shows(&term, &glyphed(RESTING), "attach");
    let titles = titles_set(&term.output_since(0));
    assert!(
        !titles.iter().any(|title| title == TITLE),
        "attach showed the title without its glyph: {titles:?}"
    );

    let (mark, editor_mark) = (term.output_since(0).len(), editor_sees().len());
    submit(&term, "work");
    animates_since(&term, mark, "attach");
    assert!(
        wait_until(secs(10), || animates(&editor_sees()[editor_mark..])),
        "the editor sees both frames; titles {:?}",
        titles_set(&editor_sees()[editor_mark..])
    );
    submit(&term, "/fake status done");
    shows(&term, &glyphed(RESTING), "attach");
    assert!(
        wait_until(LOADED_TIMEOUT, || shown_title(&editor_sees())
            == glyphed(RESTING)),
        "the editor: {:?}",
        shown_title(&editor_sees())
    );
    ends_with_the_host_s_title(&mut term, b"\x1d", "attach");
}

/// The console keeps its own title until the attached CLI sets one, as when the CLI runs alone: a
/// CLI that never sets a title leaves it alone through the attachment and after, and so does
/// Claude Code that reports before it has a title. Once Claude Code sets one, the console shows it
/// with its glyph, and its own title comes back at the end.
#[test]
fn the_console_keeps_its_own_title_until_the_attached_cli_sets_one() {
    let home = TestHome::new("attach-hosttitle");
    let _wire = claude_is_the_test_cli(&home);
    let silent = [("FAKECLI_TURN_MS", "600000")];
    let untitled: Vec<_> = reporting("0")
        .into_iter()
        .filter(|(variable, _)| *variable != "FAKECLI_TITLE")
        .collect();
    for (name, env, reports) in [
        ("never-titled", &silent[..], false),
        ("titled-later", &untitled[..], true),
    ] {
        let mut term = host_running(&home, &["start", "--name", name, "claude"], env);
        submit(&term, "work");
        assert!(
            term.wait_for(LOADED_TIMEOUT, |view| view.contains("> work")),
            "{name}: {}",
            term.text()
        );
        if reports {
            assert!(
                wait_until(LOADED_TIMEOUT, || state_of(&home, name) == "Working"),
                "{name} reports: {}",
                home.run_facade_ok(&["status", name])
            );
        }
        std::thread::sleep(secs(3));
        let titles = titles_set(&term.output_since(0));
        assert!(
            titles.iter().all(|set| host_s_own(set)),
            "{name}: the console's title while attached: {titles:?}"
        );
        if reports {
            submit(&term, "/fake status idle");
            submit(&term, &format!("/fake title {TITLE}"));
            shows(&term, &glyphed(RESTING), name);
        }
        ends_with_the_host_s_title(&mut term, b"\x04", name);
        if !reports {
            let titles = titles_set(&term.output_since(0));
            assert!(
                titles.iter().all(|set| host_s_own(set)),
                "{name}: the console's title through the end: {titles:?}"
            );
        }
    }
}

/// A CLI that sets back the title its console has, as Antigravity does on Windows, sets no title of
/// its own: its console starts with none, so the host keeps `HOST-TITLE` through the attachment and
/// after, as when the CLI runs alone.
#[cfg(windows)]
#[test]
fn a_cli_that_sets_back_its_console_s_title_leaves_the_host_s_title_alone() {
    let home = TestHome::new("attach-consoletitle");
    let _wire = connect(&home);
    let env = [
        ("FAKECLI_TITLE_FROM_CONSOLE", "1"),
        ("FAKECLI_TURN_MS", "600000"),
    ];
    let mut term = host_running(&home, &["start", "--name", "console", "fake"], &env);
    submit(&term, "work");
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("> work")),
        "{}",
        term.text()
    );
    std::thread::sleep(secs(3));
    let titles = titles_set(&term.output_since(0));
    assert!(
        titles.iter().all(|set| host_s_own(set)),
        "the console's title while attached: {titles:?}"
    );
    ends_with_the_host_s_title(&mut term, b"\x04", "console");
    let titles = titles_set(&term.output_since(0));
    assert!(
        titles.iter().all(|set| host_s_own(set)),
        "the console's title through the end: {titles:?}"
    );
}

/// An empty title from a CLI that has no title is no title: the host keeps `HOST-TITLE`. Once the
/// CLI has a title, an empty one is its reset, and the host gets it.
#[test]
fn an_empty_title_is_a_reset_only_after_a_title() {
    let home = TestHome::new("attach-emptytitle");
    let _wire = connect(&home);
    let mut term = host_running(
        &home,
        &["start", "--name", "resets", "fake"],
        &[("FAKECLI_TURN_MS", "600000")],
    );
    submit(&term, "/fake title");
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("> /fake title")),
        "{}",
        term.text()
    );
    std::thread::sleep(secs(2));
    let titles = titles_set(&term.output_since(0));
    assert!(
        titles.iter().all(|set| host_s_own(set)),
        "an empty first title reached the host: {titles:?}"
    );

    submit(&term, &format!("/fake title {TITLE}"));
    shows(&term, TITLE, "titled");
    submit(&term, "/fake title");
    shows(&term, "", "reset");
    ends_with_the_host_s_title(&mut term, b"\x04", "reset");
}

/// Claude Code starts with its own `✳` before its title, reports idle while Facade's tools still
/// connect, then sets its title without the glyph, in a later read. The console goes from its own
/// title to `✳ <title>` and stays there: never the title alone after the report, never two glyphs.
#[test]
fn claude_code_s_own_glyph_at_start_gives_way_to_facade_s_without_a_flicker() {
    let home = TestHome::new("attach-glyphstart");
    let _wire = claude_is_the_test_cli(&home);
    let mut env = reporting("0");
    env.extend([("FAKECLI_OWN_GLYPH", "✳"), ("FAKECLI_MCP_DELAY_MS", "3000")]);
    let mut term = host_running(&home, &["start", "--name", "starting", "claude"], &env);
    assert!(
        term.wait_for(LOADED_TIMEOUT, |view| view.contains("negotiated title")),
        "{}",
        term.text()
    );
    assert_eq!(
        state_of(&home, "starting"),
        "Starting",
        "the title came while Facade's tools still connect"
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || state_of(&home, "starting") == "Idle"),
        "{}",
        home.run_facade_ok(&["status", "starting"])
    );
    shows(&term, &glyphed(RESTING), "start");
    std::thread::sleep(secs(1));
    let titles = titles_set(&term.output_since(0));
    assert!(
        titles
            .iter()
            .all(|set| host_s_own(set) || *set == glyphed(RESTING)),
        "the console's titles at start: {titles:?}"
    );
    ends_with_the_host_s_title(&mut term, b"\x04", "start");
}

/// While attached, the host terminal shows the CLI's own title: the one it has when the
/// attachment begins, then each one it sets. Until the CLI has a title the host keeps its own, never
/// an empty one. When the agent exits or the person detaches, the host's own title comes back. The
/// same for a foreground start, a foreground resume and an attach.
#[test]
fn the_host_shows_the_attached_cli_s_title_and_gets_its_own_back() {
    const TITLED: &str = "1111aaaa-2bae-4a45-b193-a5664c198261";
    const UNTITLED: &str = "2222bbbb-2bae-4a45-b193-a5664c198262";
    let home = TestHome::new("attach-title");
    std::fs::write(
        home.path.join("facade.json"),
        json!({ "clis": { "claude": { "type": "claude", "program": test_binaries().fakecli } } })
            .to_string(),
    )
    .unwrap();
    home.save_claude_session(TITLED, "a titled conversation");
    home.save_claude_session(UNTITLED, "an untitled conversation");
    let _wire = connect(&home);
    for (entry, title, detach) in [
        ("start", Some("OC | Greeting"), false),
        ("start", None, true),
        ("resume", Some("OC | Greeting"), true),
        ("resume", None, false),
        ("attach", Some("OC | Greeting"), false),
        ("attach", None, true),
    ] {
        let case = format!("{entry}, title {title:?}, detach {detach}");
        let kind = if title.is_some() {
            "titled"
        } else {
            "untitled"
        };
        let name = format!("{entry}-{kind}");
        let args: Vec<String> = match entry {
            "start" => vec!["start".into(), "--name".into(), name, "claude".into()],
            "resume" => {
                let session = if title.is_some() { TITLED } else { UNTITLED };
                vec!["resume".into(), session[..8].into()]
            }
            _ => {
                let mut start = home.command(&test_binaries().facade);
                start.args(["start", "-d", "--name", &name, "claude"]);
                if let Some(title) = title {
                    start.env("FAKECLI_TITLE", title);
                }
                let started = start.stdin(std::process::Stdio::null()).output().unwrap();
                assert!(started.status.success(), "{case}: {}", stderr(&started));
                assert!(wait_for_screen_text(&home, &name, "❯"), "{case}");
                vec!["attach".into(), name]
            }
        };
        let mut host = home.command(shell());
        host.args([
            "-c",
            "printf '\\033]2;HOST-TITLE\\007HOST-PROMPT\\n'; facade \"$@\"; printf 'HOST-RETURN\\n'",
            "host",
        ])
        .args(&args);
        if let Some(title) = title {
            host.env("FAKECLI_TITLE", title);
        }
        let mut term = TestTerminal::spawn(&mut host, 100, 24);
        let shown = |term: &TestTerminal| shown_title(&term.output_since(0));
        assert!(
            term.wait_for(LOADED_TIMEOUT, |view| view.contains("❯")) && term.on_alternate_screen(),
            "{case}: {}",
            term.text_with_scrollback()
        );
        if let Some(title) = title {
            assert!(
                wait_until(LOADED_TIMEOUT, || shown(&term) == title),
                "{case}: {:?}",
                shown(&term)
            );
        }
        let titles = titles_set(&term.output_since(0));
        let before_the_cli_s: Vec<_> = titles
            .iter()
            .take_while(|set| Some(set.as_str()) != title)
            .collect();
        assert!(
            before_the_cli_s.iter().all(|set| host_s_own(set)),
            "{case}: the host's title until the CLI's: {titles:?}"
        );

        term.send(b"/fake title OC | Changed");
        assert!(
            term.wait_for(LOADED_TIMEOUT, |view| view
                .contains("/fake title OC | Changed")),
            "{case}: {}",
            term.text()
        );
        term.send(b"\r");
        assert!(
            wait_until(LOADED_TIMEOUT, || shown(&term) == "OC | Changed"),
            "{case}: {:?}",
            shown(&term)
        );

        term.send(if detach { b"\x1d" } else { b"\x04" });
        assert!(
            term.wait_exit(LOADED_TIMEOUT).is_some(),
            "{case}: {}",
            term.text_with_scrollback()
        );
        assert!(
            term.wait_for(LOADED_TIMEOUT, |view| view.contains("HOST-RETURN")),
            "{case}: {}",
            term.text_with_scrollback()
        );
        assert!(host_s_own(&shown(&term)), "{case}: {:?}", shown(&term));
    }
}
