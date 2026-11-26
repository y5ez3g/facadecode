//! The input readers against screens recorded from each CLI, in `tests/input/<cli>.json`. A label
//! names the recording: the CLI's version and the screen, such as `claude-2.1.312/typed`. Each
//! screen keeps its rows' text, the cells drawn dim, inverse, or coloured, and the cursor; a wide
//! character takes two columns. A screen whose only input row may be a hint or a draft, as Muse
//! draws both in colour, says `"unsure": true`: it reads unknown, with that row.

mod recorded;

use facade_base::model::{
    agent::WaitKind,
    terminal::{HiddenRows, InputState},
};
use facade_rules::{
    Pattern, ProbeVerdict, find, is_own_draft, read_box, read_box_for_typing, read_draft,
    read_input, restored, space_taken, verdict_of,
};
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
        let unsure = screen["unsure"] == true;
        let boxed = read_box(&rule.input, &view_of(screen));
        if boxed.unsure != unsure || unsure && boxed.line.is_none() {
            wrong.push(format!(
                "{}: unsure {}, with a row {}, expected unsure {unsure}",
                screen["label"],
                boxed.unsure,
                boxed.line.is_some()
            ));
        }
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
    // The recordings also show Codex search and selection, Muse drafts at the input start,
    // Cursor frames before the cursor is hidden, and Pi startup tool downloads as unknown.
    let shown: &[&str] = if matches!(cli, "codex" | "muse" | "agent" | "pi") {
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
fn qoder_waits_for_its_resumed_composer() {
    let rule = find("qoder").unwrap().unwrap();
    let frames: [serde_json::Value; 4] = recorded("qoder").try_into().unwrap();
    let [resuming, restored, space, draft] = frames.map(|frame| view_of(&frame));

    let restored_input = read_box(&rule.input, &restored);
    assert!(restored_input.unsure);
    let before = restored_input.line.as_ref().unwrap();
    assert_eq!((before.row, before.cursor), (18, (3, 18)));
    let space = read_box(&rule.input, &space);
    assert_eq!(space.line.as_ref().unwrap().cursor, (4, 18));
    assert!(space_taken(before, &space));
    assert_eq!(verdict_of(before, &space), ProbeVerdict::Hint);
    assert_eq!(read_box(&rule.input, &draft).info.state, InputState::Draft);

    let mut history = restored;
    history.rows[9] = resuming.rows[9].clone();
    assert!(read_box(&rule.input, &history).unsure);

    for untouched in [false, true] {
        let input = read_box_for_typing(&rule.input, &resuming, untouched);
        assert_eq!(input.info.state, InputState::Unknown);
        assert!(!input.unsure && input.line.is_none(), "{input:?}");
    }
}

#[test]
fn qoder_reads_either_terminal_setup_choice_as_interaction() {
    let rule = find("qoder").unwrap().unwrap();
    let screens: [serde_json::Value; 2] = recorded("qoder-startup").try_into().unwrap();
    let [yes, no] = screens.map(|screen| view_of(&screen));

    let mut without_footer = no.clone();
    without_footer.rows[17].clear();
    assert_eq!(
        read_input(&rule.input, &without_footer).state,
        InputState::Unknown
    );

    for (choice, screen) in [("Yes", &yes), ("No", &no)] {
        let input = read_input(&rule.input, screen);
        assert_eq!(
            input.state,
            InputState::Interaction,
            "{choice} selected. {}",
            input.evidence
        );
    }
}

#[test]
fn copilot_reads_a_one_line_login_notice_above_wrapped_context() {
    let rule = find("copilot").unwrap().unwrap();
    let screen = recorded("copilot")
        .into_iter()
        .find(|screen| screen["label"] == "copilot-1.0.116/login-above-wrapped-context")
        .unwrap();
    let read = read_box(&rule.input, &view_of(&screen));
    assert_eq!(
        read.info.state,
        InputState::Interaction,
        "{}",
        read.info.evidence
    );
    assert_eq!(read.wait_kind, Some(WaitKind::Auth));
}

/// The live question reads as one, by its selected option and key help. Answered, it stays on the
/// screen above a fresh input, which then reads by itself.
#[test]
fn cursor_screens_read_as_recorded() {
    reads_as_recorded("agent");
}

fn cursor_screen(label: &str) -> ScreenView {
    let label = format!("cursor-2026.11.22/{label}");
    let screen = recorded("agent")
        .into_iter()
        .find(|screen| screen["label"] == label)
        .unwrap();
    view_of(&screen)
}

fn kiro_screen(label: &str) -> ScreenView {
    let label = format!("kiro-3.6.2/{label}");
    let screen = recorded("kiro-cli")
        .into_iter()
        .find(|screen| screen["label"] == label)
        .unwrap();
    view_of(&screen)
}

#[test]
fn kiro_recognizes_the_trust_warning_when_its_heading_scrolls_out() {
    let rule = find("kiro-cli").unwrap().unwrap();
    let question = rule.yolo.question.as_ref().unwrap();
    for (label, accepting) in [("decline-selected", false), ("accept-selected", true)] {
        let view = kiro_screen(label);
        let rows: Vec<String> = view
            .rows
            .iter()
            .map(|row| row.iter().map(|cell| cell.text.as_str()).collect())
            .collect();
        let shows = |pattern: &Pattern| rows.iter().any(|row| pattern.is_match(row.trim_end()));
        assert!(shows(&question.shown) && shows(&question.answer), "{label}");
        assert_eq!(shows(&question.selected), accepting, "{label}");
        assert_eq!(
            read_input(&rule.input, &view).state,
            InputState::Interaction
        );
    }
}

#[test]
fn kiro_reads_workspace_trust_without_its_heading() {
    let rule = find("kiro-cli").unwrap().unwrap();
    for label in ["workspace-trust-selected", "workspace-decline-selected"] {
        assert_eq!(
            read_input(&rule.input, &kiro_screen(label)).state,
            InputState::Interaction,
            "{label}"
        );
    }
}

#[test]
fn kiro_waits_for_the_ready_prompt_after_working() {
    let rule = find("kiro-cli").unwrap().unwrap();
    let working = kiro_screen("work-hint");
    let ready = kiro_screen("ready-after-work");
    for untouched in [false, true] {
        let waiting = read_box_for_typing(&rule.input, &working, untouched);
        assert_eq!(waiting.info.state, InputState::Unknown);
        assert!(!waiting.unsure && waiting.line.is_none(), "{waiting:?}");

        let ready = read_box_for_typing(&rule.input, &ready, untouched);
        assert!(ready.unsure && ready.line.is_some(), "{ready:?}");
    }
}

#[test]
fn kiro_waits_for_the_composer_before_probing_its_hint() {
    let rule = find("kiro-cli").unwrap().unwrap();
    let reading = read_box_for_typing(&rule.input, &kiro_screen("initializing"), true);
    assert_eq!(reading.info.state, InputState::Unknown);
    assert!(!reading.unsure, "{}", reading.info.evidence);

    let copied = read_box_for_typing(&rule.input, &kiro_screen("initializer-copy"), true);
    assert_eq!(copied.info.state, InputState::Draft);
}

/// Changes the cells of row `y` at columns `columns`.
fn mark(
    view: &mut ScreenView,
    y: usize,
    columns: std::ops::Range<usize>,
    change: impl Fn(&mut VisibleCell),
) {
    for cell in &mut view.rows[y] {
        if columns.contains(&cell.column) {
            change(cell);
        }
    }
}

/// Where Cursor hides the terminal cursor, the one inverse cell of its input is the cursor: none
/// there, or a second one, says nothing.
#[test]
fn only_one_drawn_cursor_in_cursor_s_input_reads_it() {
    let rule = &find("agent").unwrap().unwrap().input;
    let state = |view: &ScreenView| read_input(rule, view).state;
    let empty = cursor_screen("empty");
    assert_eq!(state(&empty), InputState::Usable);
    let line = read_box(rule, &empty).line.unwrap();
    assert_eq!(line.cursor, (4, 9), "probes compare the drawn cursor");

    let mut two = empty.clone();
    mark(&mut two, 9, 8..9, |cell| cell.inverse = true);
    assert_eq!(state(&two), InputState::Unknown);

    let mut elsewhere = empty.clone();
    mark(&mut elsewhere, 9, 4..5, |cell| cell.inverse = false);
    mark(&mut elsewhere, 4, 2..3, |cell| cell.inverse = true);
    assert_eq!(state(&elsewhere), InputState::Unknown);

    // Inverse text outside the input beside the drawn cursor changes nothing.
    let mut beside = empty.clone();
    mark(&mut beside, 4, 2..3, |cell| cell.inverse = true);
    assert_eq!(state(&beside), InputState::Usable);

    let mut written = empty;
    mark(&mut written, 9, 5..32, |cell| cell.dim = false);
    assert_ne!(
        state(&written),
        InputState::Usable,
        "a draft of the hint's words"
    );
}

/// A visible terminal cursor in Cursor's input reads it as before, and another CLI's prompt row
/// takes no drawn cursor.
#[test]
fn a_drawn_cursor_counts_only_for_cursor_behind_a_hidden_terminal_cursor() {
    let cursor = &find("agent").unwrap().unwrap().input;
    let mut visible = cursor_screen("empty");
    visible.cursor_visible = true;
    mark(&mut visible, 9, 4..5, |cell| {
        cell.inverse = false;
        cell.dim = true;
    });
    assert_eq!(read_input(cursor, &visible).state, InputState::Unknown);
    visible.cursor = (4, 9);
    assert_eq!(read_input(cursor, &visible).state, InputState::Usable);

    let kiro = &find("kiro-cli").unwrap().unwrap().input;
    let mut other = cursor_screen("typed");
    mark(&mut other, 9, 2..3, |cell| cell.text = "›".into());
    assert_eq!(read_input(kiro, &other).state, InputState::Unknown);
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
    // Claude Code counts its hidden rows in its frame's rules; Codex marks them without a count,
    // which reads as 1 for a marked side.
    let marked = |label: &str, above, below| (label.to_string(), HiddenRows { above, below });
    assert_eq!(
        scrolled,
        [
            marked("claude-2.1.330/draft-40-lines", 30, 0),
            marked("claude-2.1.330/draft-40-lines-cursor-middle", 14, 16),
            marked("claude-2.1.330/draft-40-lines-cursor-top", 0, 30),
            marked("codex-0.170.0/draft-24-lines-default-effort", 1, 0),
            marked(
                "codex-0.170.0/draft-24-lines-cursor-top-default-effort",
                0,
                1
            ),
            marked("codex-0.170.0-20rows/draft-24-lines-default-effort", 1, 0),
            marked(
                "codex-0.170.0-20rows/draft-24-lines-cursor-top-default-effort",
                0,
                1
            ),
            marked("codex-0.170.0/draft-24-lines-ultra-effort", 1, 0),
            marked("codex-0.170.0/draft-24-lines-cursor-top-ultra-effort", 0, 1),
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
                        foreground: 0,
                    })
                    .collect();
                cells.extend((line.chars().count()..80).map(|column| VisibleCell {
                    text: " ".into(),
                    column,
                    bold: false,
                    dim: false,
                    inverse: false,
                    colored: false,
                    foreground: 0,
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

/// Synthetic cells from the native Oh My Pi band layout, including the colored blank gutter.
#[test]
fn oh_my_pi_reads_the_native_band_and_guards_the_full_viewport() {
    use std::fmt::Write;

    let rule = &find("omp").unwrap().unwrap().input;
    let band = |lines: &[&str], cursor: Option<(usize, usize)>| {
        let mut vt = String::from("\x1b[4;1H\x1b[38;5;75m π  Example model\x1b[39m");
        for (index, line) in lines.iter().enumerate() {
            let gutter = if index == 0 { "╰─ " } else { "   " };
            write!(
                vt,
                "\x1b[{};1H\x1b[38;5;75m{gutter}\x1b[39m{line}",
                index + 5
            )
            .unwrap();
        }
        if let Some((row, col)) = cursor {
            write!(vt, "\x1b[{row};{col}H").unwrap();
        }
        let mut screen = facade_screen::Screen::new(80, 24, 0);
        screen.feed(vt.as_bytes());
        screen.view()
    };

    let empty = read_box(rule, &band(&[""], None));
    assert_eq!(
        empty.info.state,
        InputState::Usable,
        "{}",
        empty.info.evidence
    );
    assert_eq!(empty.line.unwrap().cursor, (3, 4));

    let draft = read_box(rule, &band(&["first", "", "last"], None));
    assert_eq!(
        draft.info.state,
        InputState::Draft,
        "{}",
        draft.info.evidence
    );
    assert_eq!(draft.draft.as_deref(), Some("first\n\nlast"));

    // Oh My Pi draws what it predicts from the cursor on, in another color.
    let predicted = read_box(
        rule,
        &band(&["comm\x1b[38;5;240mands\x1b[39m"], Some((5, 8))),
    );
    assert_eq!(predicted.draft.as_deref(), Some("comm"));
    let typed = read_box(rule, &band(&["commands"], Some((5, 8))));
    assert_eq!(typed.draft.as_deref(), Some("commands"));

    let content: Vec<_> = (1..=11).map(|n| format!("line {n}")).collect();
    let lines: Vec<_> = content.iter().map(String::as_str).collect();
    let full = read_box_for_typing(rule, &band(&lines, None), true);
    assert_eq!(
        full.info.state,
        InputState::Unknown,
        "{}",
        full.info.evidence
    );
    assert!(full.draft.is_none());
    assert_eq!(
        full.paste_tail.as_deref(),
        Some(content.join("\n").as_str())
    );
    let before_end = read_box_for_typing(rule, &band(&lines, Some((15, 5))), true);
    assert!(before_end.paste_tail.is_none());
}

#[test]
fn claude_plain_hint_and_same_text_draft_need_the_probe() {
    let claude = &find("claude").unwrap().unwrap().input;
    let text = r#"Try "refactor <filepath>""#;
    let border = "─".repeat(40);
    let frame = |text: &str, column: usize| {
        let output = format!("{border}\r\n❯\u{a0}{text}\r\n{border}\x1b[2;{column}H");
        screen_after(output.as_bytes())
    };
    let read = |text: &str, column: usize| read_box_for_typing(claude, &frame(text, column), true);

    // Claude Code 2.1.326 under NO_COLOR draws the hint as plain text.
    let initial = read(text, 3);
    let before = initial.line.as_ref().expect("the first row of the frame");

    let hint_after_space = read(" ", 4);
    assert!(space_taken(before, &hint_after_space));
    assert_eq!(verdict_of(before, &hint_after_space), ProbeVerdict::Hint);

    let draft_after_space = read(&format!(" {text}"), 4);
    assert!(space_taken(before, &draft_after_space));
    let verdict = verdict_of(before, &draft_after_space);
    assert_eq!(verdict, ProbeVerdict::Draft);
    assert!(!restored(verdict, before, &read("", 3)));
    assert!(restored(verdict, before, &read(text, 3)));

    assert!(initial.unsure, "{}", initial.info.evidence);
    assert_eq!(initial.info.state, InputState::Unknown);

    let ordinary = read_box(claude, &frame(text, 3));
    assert_eq!(ordinary.info.state, InputState::Draft);
    assert_eq!(ordinary.draft.as_deref(), Some(text));
    assert!(!ordinary.unsure);
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
    for label in [
        "codex-0.170.0/narrow-wrapped-working-draft",
        "codex-0.170.0/narrow-wrapped-warning-draft",
    ] {
        assert_eq!(
            draft("codex", label),
            "📨 Message m4 from example-helper (a2@testbox) · in reply to m2\nExample reply body"
        );
    }
    assert_eq!(
        draft(
            "codex",
            "codex-0.172.0/42x18-idle-shell-paste-with-wrapped-footer"
        ),
        "📨 Message m1 from command line\nNARROW42SEND. Reply with the single\nword OK."
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
            is_own_draft(paste(cli), &draft(cli, label), &text, None),
            "{label}"
        );
    }
    assert!(
        !is_own_draft(
            paste("claude"),
            &draft("claude", "claude-2.1.312/long-pasted"),
            &lines(32),
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
    // Codex's marks in the last column and Claude Code's in its frame's rules are no draft text.
    for (cli, label) in [
        ("claude", "claude-2.1.330/draft-40-lines-cursor-middle"),
        ("codex", "codex-0.170.0/draft-24-lines-default-effort"),
        (
            "codex",
            "codex-0.170.0/draft-24-lines-cursor-top-ultra-effort",
        ),
    ] {
        let scrolled = draft(cli, label);
        assert!(
            scrolled.starts_with("draft line")
                && !scrolled.contains(['↑', '↓'])
                && !scrolled.contains(" more"),
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

/// The paste the screen `label` of `cli` recorded, and the draft its rule reads there, or why it
/// reads none.
fn recorded_paste(cli: &str, label: &str) -> (String, Result<String, String>) {
    let rule = find(cli).unwrap().unwrap();
    let screen = recorded(cli)
        .into_iter()
        .find(|screen| screen["label"] == label)
        .unwrap_or_else(|| panic!("no screen {label}"));
    let text = screen["paste"].as_str().unwrap().to_string();
    let (info, draft) = read_draft(&rule.input, &view_of(&screen));
    let draft = match draft {
        Some(draft) if info.state == InputState::Draft => Ok(draft),
        _ => Err(format!("{} ({})", info.state.as_str(), info.evidence)),
    };
    (text, draft)
}

/// The installed CLIs draw a paste as a placeholder Facade takes for the draft of that message:
/// Claude Code's `[Pasted text #N]` for one line of over 800 characters, Antigravity's `[Pasted
/// text #N M chars]` once a line passes about 1000 characters, and OpenCode's `[Pasted ~N lines]`,
/// which counts the lines of the message trimmed, at 40 columns as at 120.
#[test]
fn the_installed_clis_placeholders_are_the_drafts_of_their_pastes() {
    let mut wrong = Vec::new();
    for (cli, label) in [
        ("claude", "claude-2.1.330/one-line-paste-1222-chars"),
        ("agy", "agy-1.5.14/one-line-paste-1100-chars"),
        ("agy", "agy-1.5.14/one-line-paste-1222-chars"),
        ("agy", "agy-1.5.14/one-line-paste-6110-chars"),
        ("agy", "agy-1.5.14/paste-3-lines-one-long"),
        ("opencode", "opencode-2.2.4/pasted-3-lines-final-break"),
        ("opencode", "opencode-2.2.4/pasted-5-lines-final-break"),
        ("opencode", "opencode-2.2.4-40cols/pasted-3-lines"),
        (
            "opencode",
            "opencode-2.2.4-40cols/pasted-3-lines-final-break",
        ),
        (
            "opencode",
            "opencode-2.2.4-40cols/pasted-5-lines-final-break",
        ),
    ] {
        let paste = &find(cli).unwrap().unwrap().paste;
        match recorded_paste(cli, label) {
            (text, Ok(draft)) if is_own_draft(paste, &draft, &text, None) => {}
            (_, Ok(draft)) => wrong.push(format!("{label}: {draft:?} is not its paste's draft")),
            (_, Err(read)) => wrong.push(format!("{label}: reads {read}")),
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// A placeholder stands for no other message: Claude Code's uncounted one for no message with a
/// line break, Antigravity's for no message of another length.
#[test]
fn a_placeholder_is_no_other_message_s_draft() {
    let (text, draft) = recorded_paste("claude", "claude-2.1.330/one-line-paste-1222-chars");
    let draft = draft.unwrap();
    let broken = format!("{}\n{}", &text[..600], &text[600..]);
    assert!(!is_own_draft(
        &find("claude").unwrap().unwrap().paste,
        &draft,
        &broken,
        None
    ));
    let (text, draft) = recorded_paste("agy", "agy-1.5.14/one-line-paste-1100-chars");
    let draft = draft.unwrap();
    assert!(!is_own_draft(
        &find("agy").unwrap().unwrap().paste,
        &draft,
        &text[..1099],
        None
    ));
}
