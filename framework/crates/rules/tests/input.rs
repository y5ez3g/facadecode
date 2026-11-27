//! The input readers against screens recorded from each CLI, in `tests/input/<cli>.json`. A label
//! names the recording: the CLI's version and the screen, such as `claude-2.1.312/typed`. Each
//! screen keeps its rows' text, the cells drawn dim, inverse, or coloured, and the cursor; a wide
//! character takes two columns. A screen whose only input row may be a hint or a draft, as Muse
//! draws both in colour, says `"unsure": true`: it reads unknown, with that row.

mod recorded;

use std::ops::Range;

use facade_base::model::{
    agent::WaitKind,
    terminal::{HiddenRows, InputState},
};
use facade_rules::{
    InputRule, PasteDrawing, Pattern, ProbeVerdict, find, is_own_draft, read_box,
    read_box_for_screen, read_box_for_typing, read_draft, read_input, restored, shows_paste_end,
    space_taken, verdict_of,
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
    // Recorded unknown states include a visible Cursor caret, Codex pickers,
    // Muse's unsure drafts, OpenCode's cut input, and Pi's provisioning and cut dialogs.
    let shown: &[&str] = match cli {
        "agent" | "codex" | "muse" | "opencode" | "pi" => {
            &["draft", "interaction", "unknown", "usable"]
        }
        _ => &["draft", "interaction", "usable"],
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

/// Antigravity moves along a draft's row by tabs to erase its end. A tab over a blank cell leaves
/// it blank, so the row stays the draft's.
#[test]
fn a_draft_row_antigravity_moves_along_by_tabs_reads_on() {
    let rule = find("agy").unwrap().unwrap();
    let border = "─".repeat(40);
    let first = "\x1b[94m>\x1b[m Message m2 from example-helper";
    let drawn = format!("{border}\r\n{first}\r\n  Line 2 of the message\r\n{border}\x1b[3;24H");
    // What Antigravity 1.5.16 writes as the draft's last word goes.
    let erased = format!(
        "{drawn}\x1b[?2026h\x1b[?7l\r\x1bM\x1b[K{first}\x1b[?7h\x1b[33G\r\n\t\t\x1b[K\x08\x1b[?2026l"
    );
    for (output, last) in [(drawn, "Line 2 of the message"), (erased, "Line 2 of the")] {
        let (info, draft) = read_draft(&rule.input, &screen_after(output.as_bytes()));
        assert_eq!(info.state, InputState::Draft, "{}", info.evidence);
        assert_eq!(
            draft,
            Some(format!("Message m2 from example-helper\n{last}"))
        );
    }
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

/// The screen `label` recorded from `cli`.
fn screen_of(cli: &str, label: &str) -> serde_json::Value {
    recorded(cli)
        .into_iter()
        .find(|screen| screen["label"] == label)
        .unwrap_or_else(|| panic!("no screen {label}"))
}

/// Whether `view` shows `text` as its own draft to `cli`'s rule, with what was read.
fn shows_own(cli: &str, view: &ScreenView, text: &str) -> (bool, String) {
    let rule = find(cli).unwrap().unwrap();
    let read = read_box(&rule.input, view);
    let hidden = read.draft_hidden();
    let own = read.info.state == InputState::Draft
        && (read.draft.as_deref())
            .is_some_and(|draft| is_own_draft(&rule.paste, draft, text, hidden));
    let shown = format!(
        "{} ({}) {:?} {hidden:?}",
        read.info.state.as_str(),
        read.info.evidence,
        read.draft
    );
    (own, shown)
}

/// Where Pi has no room for its whole editor, it leaves out the rows after the cursor's, the lower
/// rule with them, then those before it, the upper rule with them: queued messages take the room,
/// or the window is small.
const CUT_PI_SCREENS: [&str; 7] = [
    "pi-1.4.0-30rows/queue-30-pasted-2-lines",
    "pi-1.4.0-30rows/queue-30-pasted-3-lines",
    "pi-1.4.0-15rows/queue-10-pasted-2-lines",
    "pi-1.4.0-15rows/queue-10-pasted-9-lines",
    "pi-1.4.0-10rows/queue-10-pasted-9-lines",
    "pi-1.4.0-5rows/pasted-2-lines",
    "pi-1.4.0-5rows/pasted-placeholder",
];

/// While Pi works, its upper rule carries its status before the count of the rows above, or only
/// its spinner where both do not fit. A message taller than the editor scrolls under it.
const WORKING_PI_SCREENS: [&str; 5] = [
    "pi-1.4.0-30rows/working-pasted-10-lines",
    "pi-1.4.0-30rows/working-pasted-10-rows",
    "pi-1.4.0-30rows-60cols/working-pasted-10-lines",
    "pi-1.4.0-16rows-20cols/working-pasted-6-lines",
    "pi-1.4.0-16rows-20cols/working-pasted-10-rows",
];

#[test]
fn a_message_is_its_own_draft_in_an_editor_pi_cuts_short() {
    own_drafts(&CUT_PI_SCREENS);
}

#[test]
fn a_message_is_its_own_draft_under_pi_s_status() {
    own_drafts(&WORKING_PI_SCREENS);
    // The count after the status is the count of the rows above.
    let mut screen = screen_of("pi", WORKING_PI_SCREENS[0]);
    let rule = screen["rows"][17]["cells"].as_str().unwrap();
    assert!(
        rule.contains("Working") && rule.contains("↑ 1 more"),
        "{rule}"
    );
    screen["rows"][17]["cells"] = serde_json::json!(rule.replace("↑ 1 more", "↑ 7 more"));
    let read = read_input(&find("pi").unwrap().unwrap().input, &view_of(&screen));
    assert_eq!(read.hidden, Some(HiddenRows { above: 7, below: 0 }));
}

/// The message of each of `labels`, Pi's screens, is its draft's own, and none with a line more or
/// less.
fn own_drafts(labels: &[&str]) {
    let mut wrong = Vec::new();
    for &label in labels {
        let screen = screen_of("pi", label);
        let text = screen["paste"].as_str().unwrap();
        let (own, read) = shows_own("pi", &view_of(&screen), text);
        if !own {
            wrong.push(format!("{label}: reads {read}"));
        }
        let (shorter, _) = text.rsplit_once('\n').unwrap();
        for other in [format!("{text}\nagain"), shorter.to_string()] {
            let (own, read) = shows_own("pi", &view_of(&screen), &other);
            assert!(!own, "{label}: another message's draft, {read}");
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// `screen` as Pi's full-screen layout cuts it where it has room for only `kept` of the rows `whole`,
/// in which it draws its editor or a dialog in its place, and for `footer` rows of its footer: the
/// rows after the first `kept` go, or, so that the cursor's stays, those before and after it. The
/// transcript keeps one row over them, and queued messages fill the rows between.
fn cut_to(
    screen: &serde_json::Value,
    whole: Range<usize>,
    kept: usize,
    footer: usize,
) -> serde_json::Value {
    let rows = screen["rows"].as_array().unwrap();
    cut_over(
        screen,
        whole.clone(),
        kept,
        &rows[whole.end..whole.end + footer],
    )
}

/// `screen` cut as [`cut_to`] cuts it, with `under` under the rows kept: its footer's rows, or an
/// extension's.
fn cut_over(
    screen: &serde_json::Value,
    whole: Range<usize>,
    kept: usize,
    under: &[serde_json::Value],
) -> serde_json::Value {
    let rows = screen["rows"].as_array().unwrap();
    let cursor = screen["cursor"]["y"].as_u64().unwrap() as usize;
    let first = whole.start.max((cursor + 1).saturating_sub(kept));
    let queued = rows.len() - 1 - kept - under.len();
    let message = serde_json::json!({ "cells": " Steering: Reply with ok.", "dim": [[1, 25]] });
    let mut shown = vec![rows[0].clone()];
    shown.resize(1 + queued, message);
    shown.extend_from_slice(&rows[first..first + kept]);
    shown.extend_from_slice(under);
    let mut cut = screen.clone();
    cut["cursor"]["y"] = serde_json::json!(1 + queued + cursor - first);
    cut["rows"] = serde_json::Value::Array(shown);
    cut
}

/// Each cut Pi's layout can make of its editor shows the message that the whole editor shows as its
/// own draft, and not a message with another line after it.
#[test]
fn a_message_is_its_own_draft_in_every_cut_of_pi_s_editor() {
    let pi = find("pi").unwrap().unwrap();
    for (label, whole) in [
        ("pi-1.4.0/pasted", 33..38),
        ("pi-1.4.0-24rows/cjk-pasted", 16..22),
        ("pi-1.4.0-24rows/medium-pasted", 13..22),
    ] {
        let screen = screen_of("pi", label);
        let text = read_draft(&pi.input, &view_of(&screen)).1.unwrap();
        for kept in 3..=whole.len() {
            for footer in 0..=2 {
                let cut = view_of(&cut_to(&screen, whole.clone(), kept, footer));
                let shown = format!("{label}, {kept} rows, {footer} of the footer");
                let (own, read) = shows_own("pi", &cut, &text);
                assert!(own, "{shown}: {read}");
                let (own, read) = shows_own("pi", &cut, &format!("{text}\nagain"));
                assert!(!own, "{shown}, another message: {read}");
            }
        }
    }
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
    view_of(&screen_of("agent", &format!("cursor-2026.11.22/{label}")))
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
fn kiro_offers_tab_only_on_the_captured_collapse_cue() {
    let rule = find("kiro-cli").unwrap().unwrap();
    let view = kiro_screen("collapsed-multiline");
    let read = |view| read_box(&rule.input, view);
    let observed = read(&view);
    assert_eq!(observed.info.state, InputState::Draft);
    assert!(rule.paste.shows_tab_to_expand(&observed), "{observed:?}");

    let mut plain = view.clone();
    for cell in &mut plain.rows[plain.cursor.1] {
        cell.colored = false;
    }
    assert!(!rule.paste.shows_tab_to_expand(&read(&plain)));

    let mut other_caret = observed;
    other_caret.line.as_mut().unwrap().cursor.0 += 1;
    assert!(!rule.paste.shows_tab_to_expand(&other_caret));
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
            .map(|row| row.iter().map(|cell| cell.text()).collect())
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

/// No cut of the dialogs Pi draws in its editor's place, its search and text inputs among them, is an
/// empty input, or the draft of a message.
#[test]
fn no_cut_of_a_dialog_is_an_editor_to_type_in() {
    let pi = find("pi").unwrap().unwrap();
    let messages: Vec<String> = recorded("pi")
        .iter()
        .filter_map(|screen| screen["paste"].as_str().map(str::to_string))
        .collect();
    for (label, whole) in [
        ("pi-1.4.0/model-picker", 14..38),
        ("pi-1.4.0-30rows/thinking-picker", 14..28),
        ("pi-1.4.0-30rows/resume-picker", 17..28),
        ("pi-1.4.0-30rows/one-line-question", 19..28),
        ("pi-1.4.0-30rows/one-line-question-answered", 19..28),
    ] {
        let screen = screen_of("pi", label);
        for kept in 3..=whole.len() {
            for footer in 0..=2 {
                let view = view_of(&cut_to(&screen, whole.clone(), kept, footer));
                let read = read_box(&pi.input, &view);
                let hidden = read.draft_hidden();
                let typed_in = match read.info.state {
                    InputState::Usable => true,
                    InputState::Draft => read.draft.as_deref().is_some_and(|draft| {
                        (messages.iter()).any(|text| is_own_draft(&pi.paste, draft, text, hidden))
                    }),
                    _ => false,
                };
                assert!(
                    !typed_in,
                    "{label}, {kept} rows, {footer} of the footer: {} ({})",
                    read.info.state.as_str(),
                    read.info.evidence
                );
            }
        }
    }
}

/// Where Pi cut its editor short of the upper rule, nothing on the screen marks the rows out of
/// sight: the reading leaves `hidden` out, as its CLI marks nothing, and keeps one row above for
/// telling a message's own draft.
#[test]
fn a_cut_editor_keeps_its_unmarked_rows_to_its_reader() {
    let pi = find("pi").unwrap().unwrap();
    for label in [
        "pi-1.4.0-15rows/queue-10-pasted-9-lines",
        "pi-1.4.0-10rows/queue-10-pasted-9-lines",
        "pi-1.4.0-30rows/queue-30-pasted-3-lines",
        "pi-1.4.0-5rows/pasted-2-lines",
    ] {
        let read = read_box(&pi.input, &view_of(&screen_of("pi", label)));
        assert_eq!(read.info.hidden, None, "{label}");
        let above = HiddenRows { above: 1, below: 0 };
        assert_eq!(read.draft_hidden(), Some(above), "{label}");
    }
}

/// In an editor cut short, only text up to a cursor at its end, right over Pi's footer, is a
/// draft. Rows under the cursor may go on a person's draft, and other rows are no editor's.
#[test]
fn an_editor_pi_cuts_short_reads_as_nothing_else() {
    let label = "pi-1.4.0-15rows/queue-10-pasted-2-lines";
    let screen = screen_of("pi", label);
    let last = 12;
    let mut changed = Vec::new();
    let mut change = |what: &str, change: &dyn Fn(&mut serde_json::Value)| {
        let mut screen = screen.clone();
        change(&mut screen);
        changed.push((what.to_string(), view_of(&screen)));
    };
    change("the cursor a row up", &|screen| {
        screen["cursor"] = serde_json::json!({ "x": 0, "y": last - 1 });
        screen["rows"][last]["inverse"] = serde_json::json!([]);
        screen["rows"][last - 1]["inverse"] = serde_json::json!([[0, 1]]);
    });
    change("the cursor within its row", &|screen| {
        screen["cursor"] = serde_json::json!({ "x": 5, "y": last });
        screen["rows"][last]["inverse"] = serde_json::json!([[5, 6]]);
    });
    change("no cursor of Pi's own", &|screen| {
        screen["rows"][last]["inverse"] = serde_json::json!([]);
    });
    change("plain text under the cursor", &|screen| {
        screen["rows"][last + 1] = serde_json::json!({ "cells": "a third row" });
    });
    change("a blank row under the cursor", &|screen| {
        screen["rows"][last + 1] = serde_json::json!({ "cells": "" });
    });
    change("a dialog's dim words over its input", &|screen| {
        screen["rows"][last - 1]["dim"] = serde_json::json!([[0, 41]]);
    });
    change("no text", &|screen| {
        screen["rows"][last - 1] = serde_json::json!({ "cells": "" });
        screen["rows"][last] = serde_json::json!({ "cells": " ", "inverse": [[0, 1]] });
        screen["cursor"] = serde_json::json!({ "x": 0, "y": last });
    });
    for (what, view) in changed {
        let read = read_input(&find("pi").unwrap().unwrap().input, &view);
        assert_eq!(read.state, InputState::Unknown, "{what}: {}", read.evidence);
    }
}

/// Pi asks a question with an editor of its own, in place of its input. No cut of it is Pi's input,
/// under Pi's own footer of two rows, a footer an extension's status makes three rows, or an
/// extension's row under the question: Pi cuts its keys, and shows such rows whole. Where the keys
/// show, or Pi cut its footer too, it is a question. The real frame of Pi's own layout that a footer
/// of three rows made read as usable, `pi-1.4.0-15rows/question-under-3-row-footer`, is a recorded
/// screen.
#[test]
fn no_cut_of_a_question_is_an_input() {
    let pi = find("pi").unwrap().unwrap();
    for label in [
        "pi-1.4.0-30rows/question-empty",
        "pi-1.4.0-30rows/question-answered",
    ] {
        let screen = screen_of("pi", label);
        let rows = screen["rows"].as_array().unwrap();
        let whole = 17..28;
        let (pwd, stats) = (rows[28].clone(), rows[29].clone());
        let status = serde_json::json!({ "cells": " an extension's status" });
        let widget = serde_json::json!({ "cells": " an extension's widget" });
        let unders = [
            vec![],
            vec![pwd.clone()],
            vec![pwd.clone(), stats.clone()],
            vec![pwd.clone(), stats.clone(), status],
            vec![widget.clone(), pwd.clone(), stats.clone()],
            vec![widget, pwd],
        ];
        for kept in 3..=whole.len() {
            for under in &unders {
                let view = view_of(&cut_over(&screen, whole.clone(), kept, under));
                let read = read_input(&pi.input, &view);
                let what = format!("{label}, {kept} rows, {} under it", under.len());
                assert_ne!(read.state, InputState::Usable, "{what}: {}", read.evidence);
                if kept >= 9 || kept == 8 {
                    let asked = read.state == InputState::Interaction;
                    assert!(asked, "{what}: {} ({})", read.state.as_str(), read.evidence);
                }
            }
        }
    }
}

/// A command's output or a notice leaves a rule in the transcript over Pi's input, with words under
/// it. Unless they stand as a question's do, a blank row over and under the one row of words, they
/// ask nothing. Where they do, over Pi's whole footer, the input reads unknown: a question cut short
/// over a footer of more rows shows the same.
#[test]
fn a_rule_and_words_over_pi_s_input_ask_nothing() {
    let pi = find("pi").unwrap().unwrap();
    let empty = screen_of("pi", "pi-1.4.0-24rows/empty");
    let (upper, lower) = (19, 21);
    let rule = || serde_json::json!({ "cells": "─".repeat(120), "colored": [[0, 120]] });
    let words = || serde_json::json!({ "cells": " Model: example", "colored": [[1, 15]] });
    let blank = || serde_json::json!({ "cells": "" });
    let keys = || serde_json::json!({ "cells": " enter submit  escape cancel" });
    let mut asked = empty.clone();
    for (y, row) in [
        (upper - 4, rule()),
        (upper - 3, blank()),
        (upper - 2, words()),
        (upper - 1, blank()),
    ] {
        asked["rows"][y] = row;
    }
    let read = read_input(&pi.input, &view_of(&asked));
    assert_eq!(read.state, InputState::Unknown, "{}", read.evidence);
    for (what, changed) in [
        (
            "a rule with words right under it, over an input with one row under it",
            vec![
                (upper - 3, rule()),
                (upper - 2, words()),
                (upper - 1, blank()),
                (lower + 2, blank()),
            ],
        ),
        ("one row under the input", vec![(lower + 2, blank())]),
        ("a blank row under the input", vec![(lower + 1, blank())]),
        (
            "words like the keys right under the input",
            vec![(lower + 1, keys())],
        ),
    ] {
        let mut screen = empty.clone();
        for (y, row) in changed {
            screen["rows"][y] = row;
        }
        let read = read_input(&pi.input, &view_of(&screen));
        assert_eq!(read.state, InputState::Usable, "{what}: {}", read.evidence);
    }
}

/// No other CLI's screen is Pi's editor, whole or cut short.
#[test]
fn no_other_cli_s_screen_is_an_editor() {
    let pi = find("pi").unwrap().unwrap();
    for cli in ["claude", "codex", "agy", "muse", "opencode"] {
        for screen in recorded(cli) {
            let read = read_input(&pi.input, &view_of(&screen));
            assert!(
                !matches!(read.state, InputState::Usable | InputState::Draft),
                "{}: {} ({})",
                screen["label"],
                read.state.as_str(),
                read.evidence
            );
        }
    }
}

/// The messages of these screens are their inputs' own drafts though a small window cut the input:
/// Muse scrolls its prompt row out with a draft's first rows and ends its frame's title in `…`, Codex
/// ends its model line there or leaves the line out where a draft does not fit with it, and
/// OpenCode's box goes on below the screen.
#[test]
fn a_message_is_its_own_draft_in_an_input_a_small_window_cuts() {
    let mut wrong = Vec::new();
    for (cli, label) in [
        ("muse", "muse-1.4.25-15rows/pasted-13-rows"),
        ("muse", "muse-1.4.25-10rows/pasted-5-lines"),
        ("muse", "muse-1.4.25-20cols/typed"),
        ("muse", "muse-1.4.25-20cols/pasted-2-lines"),
        ("codex", "codex-0.170.0-20cols/typed"),
        ("codex", "codex-0.170.0-8rows/pasted-6-lines"),
        ("codex", "codex-0.170.0-30cols-10rows/pasted-6-lines"),
        ("codex", "codex-0.170.0-6rows/pasted-3-lines"),
        ("codex", "codex-0.170.0-20cols/pasted-2-lines"),
        ("opencode", "opencode-2.2.4-12rows/pasted-2-lines"),
        ("opencode", "opencode-2.2.4-40cols-15rows/pasted-2-lines"),
    ] {
        let screen = screen_of(cli, label);
        let text = screen["paste"].as_str().unwrap();
        let (own, read) = shows_own(cli, &view_of(&screen), text);
        if !own {
            wrong.push(format!("{label}: reads {read}"));
        }
        for other in [format!("{text} again"), text[..text.len() - 1].to_string()] {
            let (own, read) = shows_own(cli, &view_of(&screen), &other);
            assert!(!own, "{label}: another message's draft, {read}");
        }
        // Muse marks nothing: the row out of sight stays with the reading's first row.
        if label.contains("pasted-13-rows") || label.contains("pasted-5-lines") {
            let read = read_box(&find(cli).unwrap().unwrap().input, &view_of(&screen));
            assert_eq!(read.info.hidden, None, "{label}");
            let above = HiddenRows { above: 1, below: 0 };
            assert_eq!(read.draft_hidden(), Some(above), "{label}");
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// Codex keeps its model line under its popups and pickers in a small window, and draws them over its
/// input or in its place: they never read as an empty input, nor as any message's draft but for one
/// typed under them. Without a cursor, a picker reads as no input.
#[test]
fn codex_s_popups_and_pickers_in_a_small_window_are_no_message_s_draft() {
    let codex = find("codex").unwrap().unwrap();
    let messages: Vec<String> = ["claude", "codex", "agy", "muse", "opencode", "pi"]
        .into_iter()
        .flat_map(recorded)
        .filter_map(|screen| screen["paste"].as_str().map(str::to_string))
        .collect();
    for label in [
        "codex-0.170.0-8rows/slash-popup",
        "codex-0.170.0-30cols-10rows/at-popup",
        "codex-0.170.0-8rows/at-after-a-draft",
        "codex-0.170.0-30cols-10rows/at-after-a-draft",
        "codex-0.170.0-8rows/permissions-picker",
        "codex-0.170.0-30cols-10rows/permissions-picker",
    ] {
        let screen = screen_of("codex", label);
        let read = read_box(&codex.input, &view_of(&screen));
        let (state, evidence) = (read.info.state, &read.info.evidence);
        assert_ne!(state, InputState::Usable, "{label}: {evidence}");
        assert_eq!(read.draft_hidden(), None, "{label}: {evidence}");
        let typed = screen["paste"].as_str();
        for text in messages.iter().filter(|text| Some(text.as_str()) != typed) {
            let own = (read.draft.as_deref())
                .is_some_and(|draft| is_own_draft(&codex.paste, draft, text, read.draft_hidden()));
            assert!(!own, "{label} shows {text:?}");
        }
    }
}

/// Muse's frame with its prompt row scrolled out is nothing of another CLI's, whose screens have
/// rules of their own around the cursor. Codex's and OpenCode's inputs are no other CLI's either.
#[test]
fn no_other_cli_s_screen_is_an_input_a_small_window_cuts() {
    let mut wrong = Vec::new();
    for cli in ["muse", "codex", "opencode"] {
        let rule = find(cli).unwrap().unwrap();
        for other in ["agy", "claude", "codex", "muse", "opencode", "pi"] {
            for screen in recorded(other) {
                let read = read_input(&rule.input, &view_of(&screen));
                let cut = match cli {
                    "muse" => read.hidden.is_some(),
                    _ => matches!(read.state, InputState::Usable | InputState::Draft),
                };
                if cli != other && cut {
                    wrong.push(format!(
                        "{cli} reads {}: {} ({})",
                        screen["label"],
                        read.state.as_str(),
                        read.evidence
                    ));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// What a small window leaves of an input is a draft only while its last rows show, the cursor
/// behind them, and never an empty input.
#[test]
fn an_input_a_small_window_cuts_reads_as_nothing_else() {
    let read = |cli: &str, label: &str, change: &dyn Fn(&mut serde_json::Value)| {
        let mut screen = screen_of(cli, label);
        change(&mut screen);
        read_input(&find(cli).unwrap().unwrap().input, &view_of(&screen))
    };
    let opencode = "opencode-2.2.4-12rows/pasted-2-lines";
    let codex = "codex-0.170.0-8rows/pasted-6-lines";
    for (what, read) in [
        (
            "OpenCode's placeholder over the screen's end",
            read(
                "opencode",
                "opencode-2.2.4-40cols-15rows/empty",
                &|_screen| {},
            ),
        ),
        (
            "an empty box over the screen's end",
            read("opencode", opencode, &|screen| {
                screen["rows"][8] = serde_json::json!({ "cells": "  ┃" });
                screen["rows"][9] = serde_json::json!({ "cells": "  ┃" });
                screen["cursor"] = serde_json::json!({ "x": 5, "y": 9 });
            }),
        ),
        (
            "the cursor a row up in OpenCode's box",
            read("opencode", opencode, &|screen| {
                screen["cursor"] = serde_json::json!({ "x": 5, "y": 8 });
            }),
        ),
        (
            "the cursor within its row of OpenCode's box",
            read("opencode", opencode, &|screen| {
                screen["cursor"] = serde_json::json!({ "x": 6, "y": 9 });
            }),
        ),
        (
            "another line than Codex's model line, going on behind its mark",
            read("codex", "codex-0.170.0-20cols/typed", &|screen| {
                screen["rows"][3] = serde_json::json!({ "cells": "  esc to back · …and" });
            }),
        ),
        (
            "Codex's input over another line",
            read("codex", "codex-0.170.0-20cols/empty", &|screen| {
                screen["rows"][3] = serde_json::json!({ "cells": "  enter · esc to ba…" });
            }),
        ),
        (
            "a message of Codex's history over its input, the cursor in it",
            read("codex", codex, &|screen| {
                screen["rows"][5] = serde_json::json!({ "cells": "" });
                screen["rows"][6] = serde_json::json!({ "cells": "› check 4", "bold": [[0, 1]] });
                screen["cursor"] = serde_json::json!({ "x": 9, "y": 4 });
            }),
        ),
        (
            "a prompt row of Codex's last on the screen, under the cursor",
            read("codex", codex, &|screen| {
                screen["rows"][7] = serde_json::json!({ "cells": "› next", "bold": [[0, 1]] });
            }),
        ),
        (
            "the cursor a row up in Codex's input",
            read("codex", codex, &|screen| {
                screen["cursor"] = serde_json::json!({ "x": 9, "y": 5 });
            }),
        ),
        (
            "the cursor within its row of Codex's input",
            read("codex", codex, &|screen| {
                screen["cursor"] = serde_json::json!({ "x": 5, "y": 6 });
            }),
        ),
        (
            "the cursor under Codex's input",
            read("codex", codex, &|screen| {
                screen["cursor"] = serde_json::json!({ "x": 0, "y": 7 });
            }),
        ),
        (
            "a line right under Codex's input",
            read("codex", codex, &|screen| {
                screen["rows"][7] = serde_json::json!({ "cells": "  /model  choose what model" });
            }),
        ),
        (
            "a line under Codex's input, above its status",
            read("codex", "codex-0.170.0-6rows/pasted-3-lines", &|screen| {
                screen["rows"][4] = serde_json::json!({ "cells": "  enter insert · esc close" });
            }),
        ),
        (
            "no prompt row over Codex's input",
            read("codex", codex, &|screen| {
                screen["rows"][1] = serde_json::json!({ "cells": "  Message m2" });
            }),
        ),
        (
            "Codex's cursor hidden",
            read("codex", codex, &|screen| {
                screen["cursor_hidden"] = serde_json::json!(true);
            }),
        ),
        (
            "Muse's frame without its lower rule",
            read("muse", "muse-1.4.25-10rows/pasted-5-lines", &|screen| {
                screen["rows"][8] = serde_json::json!({ "cells": "" });
            }),
        ),
        (
            "the cursor a row up in Muse's frame",
            read("muse", "muse-1.4.25-10rows/pasted-5-lines", &|screen| {
                screen["cursor"] = serde_json::json!({ "x": 9, "y": 6 });
            }),
        ),
        (
            "the cursor within its row of Muse's frame",
            read("muse", "muse-1.4.25-10rows/pasted-5-lines", &|screen| {
                screen["cursor"] = serde_json::json!({ "x": 4, "y": 7 });
            }),
        ),
        (
            "blank rows in Muse's frame",
            read("muse", "muse-1.4.25-10rows/pasted-5-lines", &|screen| {
                for y in 1..8 {
                    screen["rows"][y] = serde_json::json!({ "cells": "" });
                }
                screen["cursor"] = serde_json::json!({ "x": 2, "y": 7 });
            }),
        ),
        (
            "Muse's frame under another line",
            read("muse", "muse-1.4.25-10rows/pasted-5-lines", &|screen| {
                screen["rows"][0] =
                    serde_json::json!({ "cells": "── Voice input (Alt+V to start)" });
            }),
        ),
    ] {
        assert_eq!(read.state, InputState::Unknown, "{what}: {}", read.evidence);
    }
    let permission = read("opencode", opencode, &|screen| {
        screen["rows"][7] = serde_json::json!({ "cells": "  ┃  △ Permission required" });
    });
    let trust = read("muse", "muse-1.4.25-15rows/pasted-13-rows", &|screen| {
        screen["rows"][0] = serde_json::json!({ "cells": "⟩ 1  Yes, I trust this folder" });
        screen["rows"][1] = serde_json::json!({ "cells": "  2  No, exit" });
        screen["rows"][2] = serde_json::json!({ "cells": "─".repeat(60) });
    });
    for asked in [permission, trust] {
        assert_eq!(asked.state, InputState::Interaction, "{}", asked.evidence);
    }
}

#[test]
fn a_painted_unicode_tail_can_finish_a_draft_cut_at_the_top() {
    let rule = find("codex").unwrap().unwrap();
    let screen = screen_of("codex", "codex-0.170.0/draft-24-lines-default-effort");
    let mut reading = read_box(&rule.input, &view_of(&screen));
    assert_eq!(
        reading.draft_hidden(),
        Some(HiddenRows { above: 1, below: 0 })
    );
    let visible = reading.draft.as_deref().unwrap();
    let text = format!("hidden header\n{visible}\u{a0}");
    let repeated = format!("{visible}\n{visible}\u{a0}");

    reading.paste_drawing = Some(PasteDrawing::default());
    assert!(
        !shows_paste_end(&reading, &text),
        "the visible last glyph precedes its tail"
    );
    reading.paste_drawing = Some(PasteDrawing {
        final_spaces: 1,
        final_line_breaks: 0,
    });
    assert!(
        shows_paste_end(&reading, &text),
        "the painted tail follows the unique visible end"
    );
    assert!(
        !shows_paste_end(&reading, &repeated),
        "the visible end also matches an earlier prefix"
    );

    reading.info.hidden = Some(HiddenRows { above: 1, below: 1 });
    assert!(
        !shows_paste_end(&reading, &text),
        "rows below are still hidden"
    );
}

#[test]
fn a_positioned_console_redraw_can_skip_the_blanks_between_fresh_words() {
    let rule = find("codex").unwrap().unwrap();
    let text = "first word\nsecond word ";
    for stale_word in [false, true] {
        let mut screen = facade_screen::Screen::new(80, 31, 0);
        screen.feed("\x1b[27;1H› \x1b[30;1H  model · C:\\fixture\x1b[27;3H".as_bytes());
        if stale_word {
            screen.feed(b"\x1b[27;9Hword");
        }
        screen.observe_paint(true);
        screen.feed(b"\x1b[?2026h\x1b[27;3Hfirst");
        if !stale_word {
            screen.feed(b"\x1b[27;9Hword");
        }
        screen.feed(b"\x1b[28;3Hsecond\x1b[28;10Hword\x1b[C\x1b[?2026l");

        let reading = read_box_for_screen(&rule.input, &screen, false);
        assert_eq!(reading.info.state, InputState::Draft, "{reading:?}");
        assert_eq!(reading.draft.as_deref(), Some(text.trim_end()));
        assert_eq!(
            shows_paste_end(&reading, text),
            !stale_word,
            "stale word: {stale_word}, frame: {reading:?}",
        );
        assert!(
            !shows_paste_end(&reading, "first word\nsecond word\u{a0}"),
            "cursor movement does not print trailing whitespace",
        );
    }
}

#[test]
fn a_unicode_paste_tail_is_counted_after_the_last_drawn_grapheme() {
    let rule = find("fake").unwrap().unwrap();
    let shows_end = |text: &str, chunks: &[&str]| {
        let mut screen = facade_screen::Screen::new(80, 24, 0);
        screen.feed("\u{276f} ".as_bytes());
        screen.observe_paint(true);
        for chunk in chunks {
            screen.feed(chunk.as_bytes());
        }
        shows_paste_end(&read_box_for_screen(&rule.input, &screen, false), text)
    };

    let final_space = "\u{a0}";
    for (text, displayed) in [
        ("done \u{200b}\u{a0}", &["done ", "done \u{200b}"][..]),
        (
            "done \u{200b} \u{2060}\u{a0}",
            &["done  ", "done \u{200b} "][..],
        ),
        (
            "done \u{200b} \u{200b}\u{a0}",
            &["done \u{200b} ", "done  \u{200b}", "done \u{200b} \u{200b}"][..],
        ),
    ] {
        for &body in displayed {
            let complete = format!("{body}{final_space}");
            assert!(!shows_end(text, &[body]), "missing NBSP after {body:?}");
            assert!(
                shows_end(text, &[&complete]),
                "complete drawing {complete:?}"
            );
            assert!(
                shows_end(text, &[body, final_space]),
                "split drawing {complete:?}"
            );
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

/// Only an opted-in rule with a hidden terminal cursor uses the drawn cursor.
#[test]
fn a_drawn_cursor_requires_an_opted_in_rule_with_a_hidden_terminal_cursor() {
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

    let rule: InputRule = serde_json::from_value(serde_json::json!({
        "mechanism": "prompt_row",
        "prompt": "› ",
        "placeholder": "^Type here$"
    }))
    .unwrap();
    let mut other = cursor_screen("typed");
    mark(&mut other, 9, 2..3, |cell| {
        *cell = VisibleCell::new(
            "›",
            cell.column,
            cell.bold,
            cell.dim,
            cell.inverse,
            cell.colored,
        );
    });
    assert_eq!(read_input(&rule, &other).state, InputState::Unknown);
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
            ),
            // Pi's status before the count of the rows above, or its spinner alone, which counts as
            // one.
            marked("pi-1.4.0-30rows/working-pasted-10-lines", 1, 0),
            marked("pi-1.4.0-30rows/working-pasted-10-rows", 1, 0),
            marked("pi-1.4.0-30rows-60cols/working-pasted-10-lines", 1, 0),
            marked("pi-1.4.0-16rows-20cols/working-pasted-6-lines", 1, 0),
            marked("pi-1.4.0-16rows-20cols/working-pasted-10-rows", 1, 0),
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
                    .map(|(column, c)| {
                        VisibleCell::new(
                            c.encode_utf8(&mut [0; 4]),
                            column,
                            false,
                            false,
                            false,
                            false,
                        )
                    })
                    .collect();
                cells.extend(
                    (line.chars().count()..80)
                        .map(|column| VisibleCell::new(" ", column, false, false, false, false)),
                );
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
fn menus_match_logical_lines_after_terminal_wrapping() {
    let claude = find("claude").unwrap().unwrap();
    let codex = find("codex").unwrap().unwrap();
    let first_row = format!(" ❯ {}", "a".repeat(37));
    let menu = format!("\x1b[?25l{first_row}continued choice\r\n   Another choice\r\n");
    let view = screen_after(menu.as_bytes());
    assert!(view.continues[1]);
    let read = read_input(&claude.input, &view);
    assert_eq!(read.state, InputState::Interaction, "{}", read.evidence);
    let read = read_input(&codex.input, &view);
    assert_eq!(read.state, InputState::Unknown, "{}", read.evidence);

    let line = format!("\x1b[?25l{first_row}   Only a continuation\r\n");
    let view = screen_after(line.as_bytes());
    assert!(view.continues[1]);
    let read = read_input(&claude.input, &view);
    assert_eq!(read.state, InputState::Unknown, "{}", read.evidence);
}

#[test]
fn claude_queue_notice_leaves_the_input_usable() {
    let claude = &find("claude").unwrap().unwrap().input;
    let frames: serde_json::Value =
        serde_json::from_str(include_str!("input/claude-queued-2.1.332.json")).unwrap();
    let border = "─".repeat(120);
    let empty = format!("\x1b[26;1H{border}\r\n❯\u{a0}\r\n{border}\x1b[27;3H");
    let replay = |queued: &str| {
        let mut screen = facade_screen::Screen::new(120, 30, 0);
        screen.feed(empty.as_bytes());
        screen.feed(frames["draft"].as_str().unwrap().as_bytes());
        let draft = read_box(claude, &screen.view());
        assert_eq!(
            draft.info.state,
            InputState::Draft,
            "{}",
            draft.info.evidence
        );
        screen.feed(queued.as_bytes());
        screen.view()
    };

    // Claude Code 2.1.332, a68's busy 5-to-1 run at 1905bd55, records 18 and 19.
    let queued = frames["queued"].as_str().unwrap();
    let typed = queued.replace("\x1b[27m\x1b[2mress", "\x1b[27mress");
    assert_ne!(typed, queued, "remove dim from the input text");
    let read = read_box(claude, &replay(&typed));
    assert_eq!(read.info.state, InputState::Draft, "{}", read.info.evidence);
    assert_eq!(
        read.draft.as_deref(),
        Some("Press up to edit queued messages")
    );

    let other = queued.replace("\x1b[27Gmessages", "\x1b[27Gmessages!");
    let read = read_box(claude, &replay(&other));
    assert_eq!(read.info.state, InputState::Draft, "{}", read.info.evidence);
    assert_eq!(
        read.draft.as_deref(),
        Some("Press up to edit queued messages!")
    );

    let view = replay(queued);
    for untouched in [false, true] {
        let read = read_box_for_typing(claude, &view, untouched);
        assert_eq!(
            read.info.state,
            InputState::Usable,
            "{}",
            read.info.evidence
        );
        assert!(read.draft.is_none());
        assert!(!read.unsure);
    }
}

#[test]
fn claude_plain_hint_and_same_text_draft_need_the_probe() {
    let claude = &find("claude").unwrap().unwrap().input;
    let text = r#"Try "fix typecheck errors""#;
    let border = "─".repeat(40);
    let frame = |text: &str, column: usize| {
        let output = format!("{border}\r\n❯\u{a0}{text}\r\n{border}\x1b[2;{column}H");
        screen_after(output.as_bytes())
    };
    let read = |text: &str, column: usize| read_box_for_typing(claude, &frame(text, column), true);

    // Claude Code 2.1.332 under NO_COLOR. Cursor moves leave the gaps between words.
    let view = frame("Try\x1b[7G\"fix\x1b[12Gtypecheck\x1b[22Gerrors\"", 3);
    let initial = read_box_for_typing(claude, &view, true);
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
    assert!(!initial.is_unread(), "it read a row");
    assert_eq!(initial.info.state, InputState::Unknown);

    let ordinary = read_box(claude, &frame(text, 3));
    assert_eq!(ordinary.info.state, InputState::Draft);
    assert_eq!(ordinary.draft.as_deref(), Some(text));
    assert!(!ordinary.unsure);
}

#[test]
fn a_dim_claude_startup_hint_is_usable_and_a_plain_muse_draft_is_held() {
    let border = "─".repeat(40);
    let claude = &find("claude").unwrap().unwrap().input;
    // Claude Code 2.1.331 with color enabled, with the cursor before its dim hint.
    let frame = format!(
        "{border}\r\n\x1b[39m❯\u{a0}\x1b[2mTry \"fix lint errors\"\r\n\x1b[22m{border}\x1b[2;3H"
    );
    let read = read_box_for_typing(claude, &screen_after(frame.as_bytes()), true);
    assert_eq!(
        read.info.state,
        InputState::Usable,
        "{}",
        read.info.evidence
    );
    assert!(!read.unsure);

    let muse = &find("muse").unwrap().unwrap().input;
    let text = r#"Try "fix typecheck errors""#;
    let frame = format!("{border}\r\n❯ {text}\r\n{border}\x1b[2;3H");
    let read = read_box_for_typing(muse, &screen_after(frame.as_bytes()), true);
    assert_eq!(read.info.state, InputState::Draft, "{}", read.info.evidence);
    assert_eq!(read.draft.as_deref(), Some(text));
    assert!(!read.unsure);
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
    let whole = read_box(fake, &screen_after("────\r\n❯ \r\n────".as_bytes()));
    assert_eq!(whole.info.state, InputState::Usable);
    assert!(!whole.is_unread());
    let half = read_box(
        fake,
        &screen_after("────\r\n❯ \r\n────\x1b[?2026h\x1b[2;3Hhalf".as_bytes()),
    );
    assert_eq!(half.info.state, InputState::Unknown);
    assert!(
        half.info.evidence.contains("synchronized update"),
        "{}",
        half.info.evidence
    );
    assert!(half.is_unread());
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
    let screen = screen_of(cli, label);
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
