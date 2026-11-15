//! The input readers against screens recorded from each CLI, in `tests/input/<cli>.json`. A label
//! names the recording: the CLI's version and the screen, such as `claude-2.1.312/typed`. Each
//! screen keeps its rows' text, the cells drawn dim, inverse, or coloured, and the cursor; a wide
//! character takes two columns.

mod recorded;

use facade_base::daemon::{HiddenRows, InputState};
use facade_rules::{find, is_own_draft, read_draft, read_input};
use facade_screen::{ScreenView, VisibleCell};
use recorded::view_of;

fn recorded(cli: &str) -> Vec<serde_json::Value> {
    recorded::screens("input", cli)
}

/// Reads every recorded screen of `cli` with its rule, and checks that the recordings show every
/// state the rule reads.
fn reads_as_recorded(cli: &str) {
    let rule = find(cli).unwrap().unwrap();
    let mut wrong = Vec::new();
    let mut states = Vec::new();
    let screens = recorded(cli);
    for screen in &screens {
        let read = read_input(&rule.input, &view_of(screen));
        let expected = screen["expect"].as_str().unwrap();
        if read.state.as_str() != expected {
            wrong.push(format!(
                "{}: {} ({}), expected {expected}",
                screen["label"],
                read.state.as_str(),
                read.evidence
            ));
        }
        assert_eq!(read.mechanism, Some(rule.input.mechanism()));
        states.push(expected);
    }
    assert!(
        wrong.is_empty(),
        "{} of {} screens of {cli} read wrong:\n{}",
        wrong.len(),
        screens.len(),
        wrong.join("\n")
    );
    states.sort();
    states.dedup();
    // Codex's recordings also show its search and selection screens, which read unknown.
    let shown: &[&str] = if cli == "codex" {
        &["draft", "interaction", "unknown", "usable"]
    } else {
        &["draft", "interaction", "usable"]
    };
    assert_eq!(states, shown, "the recordings of {cli} show every state");
}

#[test]
fn claude_screens_read_as_recorded() {
    reads_as_recorded("claude");
}

#[test]
fn codex_screens_read_as_recorded() {
    reads_as_recorded("codex");
}

#[test]
fn agy_screens_read_as_recorded() {
    reads_as_recorded("agy");
}

/// Antigravity's command list under a draft that starts with `/` is no question of the CLI's, also
/// behind a hidden cursor: its selected row names a command, and the screen reads unknown there,
/// not as a menu waiting for the person.
#[test]
fn antigravity_s_command_list_behind_a_hidden_cursor_reads_as_no_menu() {
    let rule = find("agy").unwrap().unwrap();
    let mut screen = recorded("agy")
        .into_iter()
        .find(|screen| screen["label"] == "agy-1.4.12/slash")
        .unwrap();
    screen["cursor_hidden"] = serde_json::json!(true);
    let read = read_input(&rule.input, &view_of(&screen));
    assert_eq!(read.state, InputState::Unknown, "{}", read.evidence);
}

#[test]
fn muse_screens_read_as_recorded() {
    reads_as_recorded("muse");
}

#[test]
fn opencode_screens_read_as_recorded() {
    reads_as_recorded("opencode");
}

#[test]
fn pi_screens_read_as_recorded() {
    reads_as_recorded("pi");
}

#[test]
fn a_scrolled_draft_counts_the_rows_its_cli_marks_hidden() {
    let mut scrolled = Vec::new();
    for cli in ["claude", "codex", "agy", "muse", "opencode", "pi"] {
        let rule = find(cli).unwrap().unwrap();
        for screen in recorded(cli) {
            if let Some(hidden) = read_input(&rule.input, &view_of(&screen)).hidden {
                scrolled.push((screen["label"].as_str().unwrap().to_string(), hidden));
            }
        }
    }
    assert_eq!(
        scrolled,
        [
            (
                "agy-1.4.12-24rows/wide-pasted".to_string(),
                HiddenRows { above: 1, below: 0 }
            ),
            (
                "pi-1.4.0-24rows/medium-pasted".to_string(),
                HiddenRows { above: 2, below: 0 }
            )
        ]
    );
}

#[test]
fn evidence_names_rows_but_never_the_draft() {
    for cli in ["claude", "codex", "agy", "muse", "opencode", "pi"] {
        let rule = find(cli).unwrap().unwrap();
        for screen in recorded(cli)
            .iter()
            .filter(|screen| screen["label"].as_str().unwrap().ends_with("/typed"))
        {
            let read = read_input(&rule.input, &view_of(screen));
            assert_eq!(read.state, InputState::Draft);
            // The draft, `draft probe text` or `hello there`, is typed on the cursor's row.
            let typed = screen["rows"][screen["cursor"]["y"].as_u64().unwrap() as usize]["cells"]
                .as_str()
                .unwrap();
            let draft = ["draft probe text", "hello there"]
                .into_iter()
                .find(|draft| typed.contains(draft))
                .expect("a recorded draft");
            let words: Vec<&str> = draft
                .split(' ')
                .filter(|word| *word != "text")
                .chain([draft])
                .collect();
            assert!(
                !words.iter().any(|word| read.evidence.contains(word)),
                "{}: {}",
                screen["label"],
                read.evidence
            );
            assert!(
                read.evidence.contains("row"),
                "{}: {}",
                screen["label"],
                read.evidence
            );
        }
    }
}

/// A screen no reader was recorded reading, here update prompts drawn as several CLIs draw them,
/// reads `unknown` for every rule. While the person browses Codex's transcript, Codex hides the
/// cursor and marks a message of theirs, whose later lines it draws two columns in. A numbered
/// message there is no menu of Codex's, whose menus have a hint row below them.
#[test]
fn a_numbered_message_the_person_browses_in_codex_s_transcript_reads_as_no_menu() {
    let rule = find("codex").unwrap().unwrap();
    let mut screen = recorded("codex")
        .into_iter()
        .find(|screen| screen["label"] == "codex-0.166.0/active-browsing")
        .unwrap();
    screen["rows"][1] = serde_json::json!({
        "cells": "› 1. Isolated new activity delivery.", "dim": [[0, 2]], "inverse": [[2, 36]],
    });
    screen["rows"][2] = serde_json::json!({
        "cells": "  2. Keep this follow-up exactly once.", "inverse": [[2, 38]],
    });
    let read = read_input(&rule.input, &view_of(&screen));
    assert_eq!(read.state, InputState::Unknown, "{}", read.evidence);
}

#[test]
fn an_update_prompt_no_reader_knows_reads_unknown() {
    let prompts: [&[&str]; 3] = [
        &[
            "  Update available! 2.1.316 → 2.1.320",
            "  Press Enter to update now, or Esc to skip",
            "",
        ],
        &[
            "╭──────────────────────────────────────────╮",
            "│ ✨ A new version is available: 0.167.0    │",
            "│ Update now? (y/n)                        │",
            "╰──────────────────────────────────────────╯",
            "",
        ],
        &[
            "",
            "A new version of this CLI is ready.",
            "Restart to update? [Y/n] ",
        ],
    ];
    for prompt in prompts {
        let last = prompt.len() - 1;
        let rows: Vec<Vec<VisibleCell>> = prompt
            .iter()
            .map(|line| {
                let mut cells: Vec<VisibleCell> = line
                    .chars()
                    .enumerate()
                    .map(|(column, c)| VisibleCell {
                        text: c.to_string(),
                        column,
                        bold: false,
                        dim: false,
                        inverse: false,
                        colored: false,
                    })
                    .collect();
                cells.extend((line.chars().count()..80).map(|column| VisibleCell {
                    text: " ".into(),
                    column,
                    bold: false,
                    dim: false,
                    inverse: false,
                    colored: false,
                }));
                cells
            })
            .collect();
        let view = ScreenView {
            continues: vec![false; rows.len()],
            rows,
            cols: 80,
            cursor: (prompt[last].chars().count(), last),
            cursor_visible: true,
            synchronized_update: false,
        };
        for rule in facade_rules::rules().unwrap() {
            let read = read_input(&rule.input, &view);
            assert_eq!(
                read.state,
                InputState::Unknown,
                "{} read {prompt:?} as {}: {}",
                rule.cli,
                read.state.as_str(),
                read.evidence
            );
        }
    }
}

/// The screen a terminal shows after `output`.
fn screen_after(output: &[u8]) -> ScreenView {
    let mut screen = facade_screen::Screen::new(40, 8, 0);
    screen.feed(output);
    screen.view()
}

#[test]
fn a_hidden_terminal_cursor_reads_unknown_unless_the_cli_draws_its_own_there() {
    let claude = &find("claude").unwrap().unwrap().input;
    let typed = recorded("claude")
        .into_iter()
        .find(|screen| screen["label"] == "claude-2.1.312/typed")
        .unwrap();
    let mut view = view_of(&typed);
    assert_eq!(read_input(claude, &view).state, InputState::Draft);
    view.cursor_visible = false;
    let read = read_input(claude, &view);
    assert_eq!(read.state, InputState::Unknown, "{}", read.evidence);
    assert!(read.evidence.contains("hidden"), "{}", read.evidence);
    let (x, y) = view.cursor;
    view.rows[y]
        .iter_mut()
        .find(|cell| cell.column == x)
        .unwrap()
        .inverse = true;
    assert_eq!(
        read_input(claude, &view).state,
        InputState::Draft,
        "a cursor the CLI draws itself counts"
    );
}

#[test]
fn an_open_synchronized_update_reads_unknown() {
    let fake = &find("fake").unwrap().unwrap().input;
    assert_eq!(
        read_input(fake, &screen_after("────\r\n❯ \r\n────".as_bytes())).state,
        InputState::Usable
    );
    let read = read_input(
        fake,
        &screen_after("────\r\n❯ \r\n────\x1b[?2026h\x1b[2;3Hhalf".as_bytes()),
    );
    assert_eq!(read.state, InputState::Unknown);
    assert!(
        read.evidence.contains("synchronized update"),
        "{}",
        read.evidence
    );
}

#[test]
fn the_fake_cli_s_prompt_row_reads_empty_or_a_draft() {
    let fake = &find("fake").unwrap().unwrap().input;
    let read = read_input(
        fake,
        &screen_after("❯ old line\r\n────\r\n❯ \r\n────".as_bytes()),
    );
    assert_eq!(
        (read.state, read.evidence.as_str()),
        (InputState::Usable, "the prompt row at row 3 is empty"),
        "the last prompt row counts"
    );
    let read = read_input(fake, &screen_after("────\r\n❯ hello\r\n────".as_bytes()));
    assert_eq!(
        (read.state, read.evidence.as_str()),
        (InputState::Draft, "the prompt row at row 2 holds text")
    );
    assert_eq!(
        read_input(fake, &screen_after(b"no prompt here")).state,
        InputState::Unknown
    );
}

/// A draft reads as its rows draw it: typed text, a short paste row by row, or the placeholder its
/// CLI draws for a long paste, which the message of that size takes as its own draft. The rows that
/// mark a draft scrolled are left out.
#[test]
fn a_draft_reads_as_its_rows_draw_it_and_a_long_paste_as_its_placeholder() {
    let draft = |cli: &str, label: &str| {
        let rule = find(cli).unwrap().unwrap();
        let screen = recorded(cli)
            .into_iter()
            .find(|screen| screen["label"] == label)
            .unwrap();
        let (info, draft) = read_draft(&rule.input, &view_of(&screen));
        assert_eq!(info.state, InputState::Draft, "{label}");
        draft.unwrap_or_else(|| panic!("{label} has no draft text"))
    };
    let pasted = "first pasted line\nsecond pasted line\nthird pasted line";
    for (cli, version) in [
        ("claude", "2.1.312"),
        ("codex", "0.165.0"),
        ("agy", "1.4.12"),
        ("muse", "1.4.14"),
        ("pi", "1.4.0"),
    ] {
        assert_eq!(
            draft(cli, &format!("{cli}-{version}/typed")),
            "draft probe text"
        );
        assert_eq!(
            draft(cli, &format!("{cli}-{version}/pasted")),
            pasted,
            "{cli}"
        );
    }
    assert_eq!(
        draft("opencode", "opencode-2.1.4/typed"),
        "draft probe text"
    );
    let lines = |count: usize| {
        (1..=count)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let paste = |cli: &str| &find(cli).unwrap().unwrap().paste;
    for (cli, label, text) in [
        ("claude", "claude-2.1.312/long-pasted", lines(33)),
        ("codex", "codex-0.165.0/long-pasted", "x".repeat(3886)),
        ("agy", "agy-1.4.12/long-pasted", lines(33)),
        ("muse", "muse-1.4.14/long-pasted", "x".repeat(3886)),
        ("opencode", "opencode-2.1.4/pasted", lines(3)),
        ("pi", "pi-1.4.0/long-pasted", lines(33)),
        ("pi", "pi-1.4.0-24rows/wide-pasted", "y".repeat(1284)),
    ] {
        assert!(
            is_own_draft(paste(cli), &draft(cli, label), &text, None, None),
            "{label}"
        );
    }
    assert!(
        !is_own_draft(
            paste("claude"),
            &draft("claude", "claude-2.1.312/long-pasted"),
            &lines(32),
            None,
            None
        ),
        "a paste of another size"
    );
    for (cli, label) in [
        ("agy", "agy-1.4.12-24rows/wide-pasted"),
        ("pi", "pi-1.4.0-24rows/medium-pasted"),
    ] {
        let scrolled = draft(cli, label);
        assert!(
            !scrolled.contains('↑') && !scrolled.contains("more line"),
            "{label}: {scrolled}"
        );
    }
    let fake = &find("fake").unwrap().unwrap().input;
    assert_eq!(
        read_draft(
            fake,
            &screen_after("────\r\n❯ hello there\r\n────".as_bytes())
        )
        .1
        .as_deref(),
        Some("hello there")
    );
    assert_eq!(
        read_draft(fake, &screen_after("────\r\n❯ \r\n────".as_bytes())).1,
        None,
        "an empty input has no draft"
    );
}
