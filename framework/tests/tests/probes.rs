//! Probes: an input whose only row may be a hint or a draft, colored text with the cursor where the
//! input starts as Muse 1.4.20 draws both, is tried once a run with a space. A hint, which the
//! space replaces, takes the message; a draft, which the space goes in front of, holds it; anything
//! else reads unknown. Each Backspace puts the row back, a run remembers each row it tried, and the
//! person's key during a probe stops it. The test CLI runs as Muse, whose input it draws, and
//! writes every byte it reads to a file.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use facade_scenarios::serde_json::json;

use facade_scenarios::*;

const SESSION: &str = "5a7c1e42-9d3b-4f60-8a21-0c4b7d9e6f13";
const DRAFT: &str = "hello there";
// The explicit Shell delivery wait uses the command budget, including time for its receipt.
const SEND_TIMEOUT: &str = "9";

/// The file the test CLI of agent `name` writes the bytes it reads to.
fn keys_file(home: &TestHome, name: &str) -> PathBuf {
    home.project.parent().unwrap().join(format!("{name}.keys"))
}

/// The keys the test CLI read outside bracketed pastes: what Facade pressed and the person typed,
/// without the messages it pasted.
fn pressed(file: &Path) -> Vec<u8> {
    let bytes = std::fs::read(file).unwrap_or_default();
    let (mut out, mut at) = (Vec::new(), 0);
    while at < bytes.len() {
        if bytes[at..].starts_with(b"\x1b[200~") {
            at = bytes[at..]
                .windows(6)
                .position(|end| end == b"\x1b[201~")
                .map_or(bytes.len(), |end| at + end + 6);
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    out
}

/// Starts the test CLI as Muse, agent `name`, with `env`, its keys going to its file, and waits
/// until it shows `shown` after its prompt. Returns the agent's ID.
fn start(home: &TestHome, name: &str, env: &[(&str, &str)], shown: &str) -> String {
    let entry = json!({ "type": "muse", "command": test_binaries().fakecli });
    std::fs::create_dir_all(&home.path).unwrap();
    std::fs::write(
        home.path.join("facade.json"),
        json!({ "clis": { "fake muse": entry } }).to_string(),
    )
    .unwrap();
    let started = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .env("FAKECLI_KEYS", keys_file(home, name))
        .env("FAKECLI_LOOK", "muse")
        .envs(env.iter().copied())
        .args(["start", "-d", "--name", name, "fake muse"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let id = started_id(&stdout(&started));
    assert!(
        wait_for_screen_text(home, name, &format!("❯ {shown}")),
        "{}",
        home.screen(name)
    );
    id
}

/// Reports `SESSION` as the session of the run of agent `agent`, named `name`, as Muse's
/// session-start hook does.
fn report_session(home: &TestHome, agent: &str, name: &str) {
    let runs: Vec<_> = std::fs::read_dir(home.path.join("framework/runs").join(agent))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(runs.len(), 1, "{runs:?}");
    let mut hook = home
        .command(&test_binaries().facade)
        .args(["hook", "session-start"])
        .arg(runs[0].join("session"))
        .env("MUSE_SESSION_ID", SESSION)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let input = format!(r#"{{"hook_event_name":"SessionStart","session_id":"{SESSION}"}}"#);
    let _ = hook.stdin.take().unwrap().write_all(input.as_bytes());
    assert!(hook.wait().unwrap().success());
    assert!(
        wait_until(secs(10), || home
            .agent_from_watch(name)
            .is_some_and(|listed| listed["session"] == SESSION)),
        "the run's session is recorded"
    );
}

/// `facade send <name> <text> -w`: whether it was delivered, and what it said.
fn send(home: &TestHome, name: &str, text: &str) -> (bool, String) {
    let sent = home.run_facade(&["send", name, text, "-w", "-t", SEND_TIMEOUT]);
    (
        sent.status.success(),
        format!("{}{}", stdout(&sent), stderr(&sent)),
    )
}

/// A hint is tried once a run: the space replaces it, the Backspace brings it back, and the
/// message goes in. The run's next message finds the hint remembered and presses nothing; a new run
/// of the CLI tries it again.
#[test]
fn a_hint_is_probed_once_a_run_and_the_message_goes_in() {
    let home = TestHome::new("probehint");
    let file = keys_file(&home, "muse");
    let id = start(
        &home,
        "muse",
        &[("FAKECLI_HINT", "review my changes")],
        "review my changes",
    );
    report_session(&home, &id, "muse");
    // A delivery receipt can precede the fake CLI's read and submission log.
    let wait_for_submissions = |count| {
        assert!(
            wait_until(LOADED_TIMEOUT, || home.submitted_messages().len() >= count),
            "submissions: {:?}",
            home.submitted_messages()
        );
    };
    let (sent, said) = send(&home, "muse", "first message");
    assert!(sent, "{said}");
    wait_for_submissions(1);
    assert_eq!(
        pressed(&file),
        b" \x7f\r",
        "space, Backspace, then the message"
    );
    let (sent, said) = send(&home, "muse", "second message");
    assert!(sent, "{said}");
    wait_for_submissions(2);
    assert_eq!(pressed(&file), b" \x7f\r\r", "the run remembers the hint");
    let messages = home.submitted_messages();
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert!(
        messages
            .iter()
            .all(|message| !message.starts_with(' ') && message.contains(" message")),
        "no space of the probe's went in: {messages:?}"
    );
    // A resume is a new launch, with the environment of the command that resumes it.
    home.run_facade_ok(&["stop", "muse"]);
    let resumed = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .env("FAKECLI_KEYS", &file)
        .env("FAKECLI_LOOK", "muse")
        .env("FAKECLI_HINT", "review my changes")
        .args(["resume", "-d", "muse"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert!(wait_for_screen_text(&home, "muse", "❯ review my changes"));
    let (sent, said) = send(&home, "muse", "third message");
    assert!(sent, "{said}");
    wait_for_submissions(3);
    assert_eq!(
        pressed(&file),
        b" \x7f\r\r \x7f\r",
        "a new run of the CLI tries the hint again"
    );
}

/// A draft with the cursor where the input starts is tried once: the space goes in front of it,
/// the Backspace takes it out again, and the draft holds the message until the deadline. Retries
/// in the meantime press nothing.
#[test]
fn a_draft_before_the_cursor_is_probed_once_and_holds_the_message() {
    let home = TestHome::new("probedraft");
    let file = keys_file(&home, "muse");
    start(&home, "muse", &[("FAKECLI_DRAFT_AT_START", DRAFT)], DRAFT);
    let (sent, said) = send(&home, "muse", "a message");
    assert!(
        !sent && said.contains("Its terminal has an unfinished draft."),
        "{said}"
    );
    assert_eq!(pressed(&file), b" \x7f", "one probe, through every retry");
    assert!(home.submitted_messages().is_empty());
    assert!(
        home.screen("muse").contains(&format!("❯ {DRAFT}")),
        "the draft as it was: {}",
        home.screen("muse")
    );
}

/// A space that goes in but leaves the row neither empty nor the draft behind it, such as a CLI
/// that suggests something after it, is taken out again, and the row reads unknown from then on,
/// with no other probe.
#[test]
fn a_probe_that_finds_neither_takes_its_space_out_and_reads_unknown() {
    let home = TestHome::new("probeother");
    let file = keys_file(&home, "muse");
    let env = [
        ("FAKECLI_DRAFT_AT_START", DRAFT),
        ("FAKECLI_SPACE_SUGGESTS", " (suggested)"),
    ];
    start(&home, "muse", &env, DRAFT);
    let (sent, said) = send(&home, "muse", "a message");
    let probes: Vec<String> = home
        .daemon_log()
        .lines()
        .filter(|line| line.contains("probe"))
        .map(String::from)
        .collect();
    assert!(
        !sent && said.contains("The delivery deadline passed before its terminal was ready."),
        "{said}\n{probes:#?}"
    );
    assert_eq!(pressed(&file), b" \x7f");
    assert!(
        home.screen("muse").contains(&format!("❯ {DRAFT}")),
        "{}",
        home.screen("muse")
    );
}

/// A space the CLI does not take, or takes without drawing it, gets no Backspace: the row reads
/// unknown, and no retry presses another key.
#[test]
fn a_space_that_does_not_show_gets_no_backspace() {
    for (label, env) in [
        ("ignored", ("FAKECLI_IGNORE_KEYS", "space")),
        ("undrawn", ("FAKECLI_NO_LEADING_SPACE", "1")),
    ] {
        let home = TestHome::new(&format!("probe{label}"));
        let file = keys_file(&home, "muse");
        start(
            &home,
            "muse",
            &[("FAKECLI_DRAFT_AT_START", DRAFT), env],
            DRAFT,
        );
        let (sent, said) = send(&home, "muse", "a message");
        assert!(
            !sent && said.contains("The delivery deadline passed before its terminal was ready."),
            "{label}: {said}"
        );
        assert_eq!(pressed(&file), b" ", "{label}: the space alone");
    }
}

/// A Backspace that does not put the row back as it was ends the probe: no other key goes in. The
/// space left in front of the draft, with the cursor after it, reads as the draft it now is.
#[test]
fn a_probe_whose_backspace_does_not_restore_the_row_presses_nothing_more() {
    let home = TestHome::new("probenorestore");
    let file = keys_file(&home, "muse");
    let env = [
        ("FAKECLI_DRAFT_AT_START", DRAFT),
        ("FAKECLI_IGNORE_KEYS", "backspace"),
    ];
    start(&home, "muse", &env, DRAFT);
    let (sent, said) = send(&home, "muse", "a message");
    assert!(
        !sent && said.contains("Its terminal has an unfinished draft."),
        "{said}"
    );
    assert_eq!(pressed(&file), b" \x7f", "nothing after the Backspace");
    assert!(home.submitted_messages().is_empty());
}

/// A key the person presses after the probe's space and before its Backspace stops the probe: no
/// Backspace takes out what the person typed.
#[test]
fn the_person_s_key_during_a_probe_stops_it_before_its_backspace() {
    let home = TestHome::new("probeperson");
    let file = keys_file(&home, "muse");
    let id = start(&home, "muse", &[("FAKECLI_DRAFT_AT_START", DRAFT)], DRAFT);
    let mut wire = connect(&home);
    // Resolve the exact Agent before the probe gives us a short window to type.
    let inspected = wire.call_ok("agent.inspect", json!({ "target": id }));
    let key = json!({
        "target": inspected["agent"]["reference"],
        "input": { "kind": "raw", "raw": facade_base::base64::encode(b"x") }
    });
    let mut sending = home
        .command(&test_binaries().facade)
        .args(["send", "muse", "a message", "-w", "-t", SEND_TIMEOUT])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    assert!(
        wait_until(secs(10), || pressed(&file) == b" "),
        "the probe's space: {:?}",
        pressed(&file)
    );
    let typed = wire.call("agent.type", key);
    assert!(typed["result"].is_object(), "{typed}");
    let status = sending.wait().unwrap();
    assert!(!status.success(), "the draft holds the message");
    assert_eq!(pressed(&file), b" x", "no Backspace after the person's key");
    let log = home.daemon_log();
    assert!(
        log.contains("the person typed after its space"),
        "the person must type while the probe is active: {log}"
    );
    assert!(
        home.screen("muse").contains(&format!("❯  x{DRAFT}")),
        "{}",
        home.screen("muse")
    );
}
