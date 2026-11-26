//! The state readers against screens recorded from each CLI whose rule reads its screen, kept in
//! `tests/state/<cli>.json`. Each screen's label names the CLI's version, the system it ran on and
//! the screen; it expects `working`, `idle`, `blocked:<kind>`, `error:<the CLI's words>`, or `none`
//! where the screen is no evidence.

mod recorded;

use facade_rules::{ScreenState, StateRule, find, read_state, rules};

/// How a recording writes `state`.
fn written(state: Option<ScreenState>) -> String {
    match state {
        None => "none".into(),
        Some(ScreenState::Working) => "working".into(),
        Some(ScreenState::Idle) => "idle".into(),
        Some(ScreenState::Blocked(kind)) => format!("blocked:{kind:?}").to_lowercase(),
        Some(ScreenState::Error(words)) => format!("error:{words}"),
    }
}

/// Reads every recorded state screen of `cli` as it expects, and checks that its recordings
/// expect each of `shown` and nothing else.
fn reads_as_recorded(cli: &str, shown: &[&str]) {
    let rule = find(cli).unwrap().unwrap();
    let screens = recorded::screens("state", cli);
    let mut wrong = Vec::new();
    let mut expected: Vec<&str> = Vec::new();
    for screen in &screens {
        let expect = screen["expect"].as_str().unwrap();
        let read = written(read_state(rule, &recorded::view_of(screen)));
        if read != expect {
            wrong.push(format!("{}: {read}, expected {expect}", screen["label"]));
        }
        // An error's words differ from screen to screen; what counts is that it is one.
        expected.push(if expect.starts_with("error:") {
            "error"
        } else {
            expect
        });
    }
    assert!(
        wrong.is_empty(),
        "{} of {} screens of {cli} read wrong:\n{}",
        wrong.len(),
        screens.len(),
        wrong.join("\n")
    );
    expected.sort();
    expected.dedup();
    assert_eq!(
        expected, shown,
        "the recordings of {cli} show every reading"
    );
}

#[test]
fn muse_state_screens_read_as_recorded() {
    reads_as_recorded(
        "muse",
        &["blocked:auth", "blocked:permission", "idle", "working"],
    );
}

/// A CLI may move its cursor by tabs. One over a blank cell leaves it blank, and the screen reads as
/// it did.
#[test]
fn a_tab_over_blank_cells_changes_no_state() {
    let rule = find("muse").unwrap().unwrap();
    let border = "─".repeat(60);
    let state = |moved: &str| {
        let mut screen = facade_screen::Screen::new(60, 10, 0);
        screen.feed(
            format!(
                "\r\n  Muse Code 1.4.25\r\n\r\n{border}\r\n❯ \r\n{border}\r\n  \
                 muse-example-1.0 · /work/probe · Launch overrides\
                 \x1b[2;1H{moved}\x1b[7;1H{moved}\x1b[5;3H"
            )
            .as_bytes(),
        );
        read_state(rule, &screen.view())
    };
    assert_eq!(state(""), Some(ScreenState::Idle));
    assert_eq!(state("\t"), Some(ScreenState::Idle));
}

#[test]
fn codex_state_screens_read_as_recorded() {
    reads_as_recorded("codex", &["idle", "none"]);
}

#[test]
fn opencode_state_screens_read_as_recorded() {
    reads_as_recorded("opencode", &["error", "none"]);
}

#[test]
fn clis_with_screen_based_state_read_their_screens() {
    let reading: Vec<&str> = rules()
        .unwrap()
        .iter()
        .filter(|rule| match &rule.status {
            Some(
                StateRule::BackgroundCorrection(_)
                | StateRule::FrameTranscript(_)
                | StateRule::TurnError(_)
                | StateRule::Composer(_),
            ) => true,
            Some(StateRule::BackgroundReport(_)) | None => false,
        })
        .map(|rule| rule.cli.as_str())
        .collect();
    assert_eq!(
        reading,
        [
            "codex", "muse", "opencode", "devin", "agent", "kiro-cli", "qoder"
        ]
    );
}
