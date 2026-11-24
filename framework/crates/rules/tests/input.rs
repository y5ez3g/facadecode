//! The input readers against screens recorded from each CLI, in `tests/input/<cli>.json`. A label
//! names the recording: the CLI's version and the screen, such as `claude-2.1.312/typed`. Each
//! screen keeps its rows' text, the cells drawn dim, inverse, or coloured, and the cursor; a wide
//! character takes two columns. A screen whose only input row may be a hint or a draft, as Muse
//! draws both in colour, says `"unsure": true`: it reads unknown, with that row.

mod recorded;

use std::ops::Range;

use facade_base::model::terminal::{HiddenRows, InputState};
use facade_rules::{
    ProbeVerdict, find, is_own_draft, read_box, read_box_for_typing, read_draft, read_input,
    restored, space_taken, verdict_of,
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
    // Codex's recordings also show its search and selection screens, which read unknown, Muse's its
    // drafts with the cursor where the input starts, which read unknown as unsure, and Pi's its
    // dialogs in a small window.
    let shown: &[&str] = match cli {
        "codex" | "muse" | "pi" => &["draft", "interaction", "unknown", "usable"],
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
