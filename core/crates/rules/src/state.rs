//! What a CLI's screen shows of its state, for the CLIs whose own reports leave it out. OpenCode
//! reports a turn whose model call failed as a turn that ended, so its screen gives the error;
//! Codex reports `working` while commands it started in the background run on after its turn, so
//! its screen says when the turn ended; some Muse Code builds send no reports, so its screen is
//! read until it reports.
//!
//! Each reader knows only the layout its CLI was recorded drawing, and works on logical lines:
//! rows joined by a soft wrap count as one line, rows a line break separates never do. A line that
//! began above the screen, and text in the input, are never evidence.

use facade_screen::{BlockKind, ScreenView, VisibleCell};

use crate::{
    BackgroundCorrection, BoxInput, Frame, FrameTranscript, InputRule, Pattern, Prompt, Rule,
    StateRule, TurnError,
};

/// What a CLI's screen shows it doing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScreenState {
    Working,
    Idle,
    /// Waiting for the person.
    Blocked(BlockKind),
    /// Its last turn failed, with the CLI's own words.
    Error(String),
}

/// Stands for the count in a background correction's footer.
pub(crate) const COUNT: &str = "${count}";
/// Stands for a plural's ending in a background correction's footer: `s`, or nothing for one.
pub(crate) const PLURAL: &str = "${s}";

/// Reads `rule`'s screen evidence of the CLI's state from `view`. None when the rule has no screen
/// evidence, or the screen shows nothing that evidence recognizes.
pub fn read_state(rule: &Rule, view: &ScreenView) -> Option<ScreenState> {
    let state = rule.status.as_ref()?;
    match (state, &rule.input) {
        (StateRule::TurnError(turn), InputRule::Box(input)) => {
            failed_turn(&Page::of(view), input, turn)
        }
        (StateRule::BackgroundCorrection(correction), InputRule::Prompt(input)) => {
            finished_turn(&Page::of(view), input, correction)
        }
        (StateRule::FrameTranscript(transcript), InputRule::Frame(frame)) => {
            let page = Page::of(view);
            match frame_upper_rule(&page, frame, transcript) {
                Some(upper) => over_frame(&page, upper, transcript),
                None => instead_of_frame(&page, frame, transcript),
            }
        }
        _ => None,
    }
}

/// `turn_error`: the last turn's error, at the end of the conversation over the input box. Its
/// words run from the line that begins the error down to the line just over the turn's summary,
/// with no blank line in between.
fn failed_turn(page: &Page, input: &BoxInput, turn: &TurnError) -> Option<ScreenState> {
    let border = [input.corner.as_str(), input.edge.as_str()].concat();
    let leads_with = |at: usize, start: &str| page.text(at).trim_start().starts_with(start);
    let box_bottom = (0..page.len()).rfind(|&at| leads_with(at, &border))?;
    let box_top = page.climb(box_bottom.checked_sub(1), |at| leads_with(at, &input.bar))?;
    let summary = page.climb(Some(box_top), |at| page.blank(at))?;
    if !turn.summary.is_match(page.text(summary)) {
        return None;
    }
    let end = page.climb(summary.checked_sub(1), |at| page.blank(at))?;
    let begin = (0..=end)
        .rev()
        .take_while(|&at| !page.blank(at))
        .find(|&at| turn.error.is_match(page.text(at)))?;
    if !page.whole(begin) {
        return None;
    }
    let opening = turn.error.captures(page.text(begin))?.get(1)?.as_str();
    let mut words = vec![opening];
    words.extend((begin + 1..=end).map(|at| page.text(at).trim()));
    Some(ScreenState::Error(words.join(" ")))
}

/// `background_correction`: idle when, from the bottom up, the screen has the model line (under
/// it at most its hints), a blank line, the input, the dim count of commands still running in the
/// background drawn just as the CLI draws it, and over that the dim summary of a finished turn.
fn finished_turn(
    page: &Page,
    input: &Prompt,
    correction: &BackgroundCorrection,
) -> Option<ScreenState> {
    let blank = |at: usize| page.blank(at);
    let bottom = page.climb(page.len().checked_sub(1), blank)?;
    let model = match correction.hints.is_match(page.text(bottom)) {
        true => bottom.checked_sub(1)?,
        false => bottom,
    };
    let spaced = model >= 2 && page.blank(model - 1);
    if !spaced || !input.model_line.is_match(page.text(model)) {
        return None;
    }
    let prompt = page.climb(Some(model - 2), |at| blank(at) || page.indented(at))?;
    if !is_prompt(page.text(prompt), &input.prompt, " ") {
        return None;
    }
    let footer = page.climb(prompt.checked_sub(1), blank)?;
    let shown = page.text(footer);
    let count = correction.background.captures(shown)?.get(1)?.as_str();
    if !page.lines[footer].dim || !is_drawn_footer(&correction.footer, count, shown, page.width) {
        return None;
    }
    let summary = page
        .climb(footer.checked_sub(1), blank)
        .filter(|&at| page.whole(at))?;
    let worked = page.lines[summary].dim && correction.worked.is_match(page.text(summary));
    worked.then_some(ScreenState::Idle)
}

/// Whether `shown` is the footer `template` with `count` filled in, whole or cut off at the
/// screen's right edge.
fn is_drawn_footer(template: &str, count: &str, shown: &str, width: usize) -> bool {
    let ending = if count == "1" { "" } else { "s" };
    let full = template.replace(COUNT, count).replace(PLURAL, ending);
    let cut: String = full.chars().take(width).collect();
    shown == full || shown == cut.trim_end()
}

/// The upper rule of a whole input frame. A frame is, from the bottom up: its footer, the only line
/// with text under it; its lower rule; blank or indented lines; its prompt line; its upper rule.
fn frame_upper_rule(page: &Page, frame: &Frame, transcript: &FrameTranscript) -> Option<usize> {
    for lower in (2..page.len()).rev() {
        if !frame.lower.is_match(page.text(lower)) {
            continue;
        }
        let under: Vec<&str> = (lower + 1..page.len())
            .filter(|&at| !page.blank(at))
            .map(|at| page.text(at))
            .collect();
        let footed = matches!(under.as_slice(), [footer] if transcript.footer.is_match(footer));
        let Some(prompt) = (1..lower).rfind(|&at| !page.blank(at) && !page.indented(at)) else {
            continue;
        };
        let upper = prompt - 1;
        if footed
            && is_prompt(page.text(prompt), &frame.prompt, &frame.gap)
            && frame.upper.is_match(page.text(upper))
        {
            return Some(upper);
        }
    }
    None
}

/// `frame_transcript` over a whole frame whose upper rule is line `upper`. Working while the
/// working line stands over it, with at most a usage warning and queued input between; idle under
/// the CLI's header, a question it answered, or the last line of an earlier conversation.
fn over_frame(page: &Page, upper: usize, transcript: &FrameTranscript) -> Option<ScreenState> {
    let passable = |at: usize| page.blank(at) || transcript.usage.is_match(page.text(at));
    let mut nearest = page.climb(upper.checked_sub(1), passable);
    let queue = page.climb(nearest, |at| {
        page.indented(at) || page.text(at).starts_with(&transcript.queue_continuation)
    });
    let queued = matches!(queue, Some(at) if transcript.queued.is_match(page.text(at)));
    if queued {
        nearest = page.climb(queue.and_then(|at| at.checked_sub(1)), passable);
    }
    let nearest = nearest.filter(|&at| page.whole(at))?;
    let answer = |at: usize| page.lines[at].bold && page.text(at).starts_with(&transcript.answer);
    let text = page.text(nearest);
    if transcript.working.is_match(text) && !answer(nearest) {
        return Some(ScreenState::Working);
    }
    if queued {
        return None;
    }
    let resting = [&transcript.header, &transcript.trust]
        .into_iter()
        .chain(&transcript.sign_in)
        .any(|pattern| pattern.is_match(text));
    if resting {
        return Some(ScreenState::Idle);
    }
    let start = page
        .climb(Some(nearest), |at| page.indented(at))
        .filter(|&at| page.whole(at))?;
    let marked =
        (transcript.idle_marks.iter()).any(|mark| page.text(start).starts_with(mark.as_str()));
    (marked || answer(start)).then_some(ScreenState::Idle)
}

/// `frame_transcript` with no whole frame: waiting for the person while the CLI asks them to sign
/// in or to trust the workspace. Part of a frame on the screen means such a question is left from
/// before.
fn instead_of_frame(
    page: &Page,
    frame: &Frame,
    transcript: &FrameTranscript,
) -> Option<ScreenState> {
    let shows = |pattern: &Pattern| page.lines.iter().any(|line| pattern.is_match(&line.text));
    let part_of_frame = page.lines.iter().any(|line| {
        frame.upper.is_match(&line.text) || is_prompt(&line.text, &frame.prompt, &frame.gap)
    });
    if part_of_frame {
        None
    } else if transcript.sign_in.iter().all(shows) {
        Some(ScreenState::Blocked(BlockKind::Auth))
    } else if shows(&transcript.trust) {
        Some(ScreenState::Blocked(BlockKind::Permission))
    } else {
        None
    }
}

/// Whether `text` is a prompt line: the prompt, alone or followed by `gap`.
fn is_prompt(text: &str, prompt: &str, gap: &str) -> bool {
    match text.strip_prefix(prompt) {
        Some(rest) => rest.is_empty() || rest.starts_with(gap),
        None => false,
    }
}

/// The screen as logical lines, from the top.
struct Page {
    lines: Vec<Line>,
    /// The top line began above the screen, so its start is not known.
    cut_at_top: bool,
    width: usize,
}

/// One logical line.
struct Line {
    /// What it shows, without trailing spaces.
    text: String,
    /// Its first cell is drawn bold.
    bold: bool,
    /// It shows something, and every cell from its first character to its last is drawn dim.
    dim: bool,
}

impl Page {
    fn of(view: &ScreenView) -> Page {
        let mut joined: Vec<Vec<&VisibleCell>> = Vec::with_capacity(view.rows.len());
        for (row, &continues) in view.rows.iter().zip(&view.continues) {
            match joined.last_mut() {
                Some(line) if continues => line.extend(row),
                _ => joined.push(row.iter().collect()),
            }
        }
        Page {
            lines: joined.iter().map(|cells| Line::of(cells)).collect(),
            cut_at_top: view.continues.first().copied().unwrap_or(false),
            width: view.cols,
        }
    }

    fn len(&self) -> usize {
        self.lines.len()
    }

    fn text(&self, at: usize) -> &str {
        &self.lines[at].text
    }

    fn blank(&self, at: usize) -> bool {
        self.lines[at].text.is_empty()
    }

    fn indented(&self, at: usize) -> bool {
        self.lines[at].text.starts_with("  ")
    }

    /// Whether all of line `at` is on the screen.
    fn whole(&self, at: usize) -> bool {
        !(at == 0 && self.cut_at_top)
    }

    /// The nearest line at or over `from` that `skip` does not skip; None past the top.
    fn climb(&self, from: Option<usize>, skip: impl Fn(usize) -> bool) -> Option<usize> {
        (0..=from?).rev().find(|&at| !skip(at))
    }
}

impl Line {
    fn of(cells: &[&VisibleCell]) -> Line {
        let drawn: Vec<usize> = (0..cells.len())
            .filter(|&at| !cells[at].text.trim().is_empty())
            .collect();
        let (text, dim) = match (drawn.first(), drawn.last()) {
            (Some(&first), Some(&last)) => (
                cells[..=last]
                    .iter()
                    .map(|cell| cell.text.as_str())
                    .collect(),
                cells[first..=last].iter().all(|cell| cell.dim),
            ),
            _ => (String::new(), false),
        };
        Line {
            text,
            bold: cells.first().is_some_and(|cell| cell.bold),
            dim,
        }
    }
}

#[cfg(test)]
mod tests {
    use facade_screen::Screen;

    use super::*;
    use crate::{FILES, find};

    fn view(cols: u16, rows: u16, output: &str) -> ScreenView {
        let mut screen = Screen::new(cols, rows, 100);
        screen.feed(output.as_bytes());
        screen.view()
    }

    fn state_of(cli: &str, view: &ScreenView) -> Option<ScreenState> {
        read_state(find(cli).unwrap().unwrap(), view)
    }

    #[test]
    fn a_rule_reads_state_only_around_the_input_its_mechanism_names() {
        let codex = FILES[1].1;
        let codex_rule: serde_json::Value = serde_json::from_str(codex).unwrap();
        let mut framed: serde_json::Value = serde_json::from_str(FILES[0].1).unwrap();
        framed["status"] = codex_rule["status"].clone();
        let error = |cli: &str, file: &str| Rule::parse(cli, file).unwrap_err();
        assert!(error("claude", &framed.to_string()).contains("above an input prompt"));
        let swapped = FILES[3].1.replace(
            "\"mechanism\": \"frame_transcript\"",
            "\"mechanism\": \"background_correction\"",
        );
        assert!(error("muse", &swapped).contains("unknown field"));
        let wrong = codex.replace("background terminal${s}", "background terminal${n}");
        assert!(error("codex", &wrong).contains("nothing else"));
        let uncounted = codex.replace(
            "^ {2}([1-9]\\\\d*) background",
            "^ {2}[1-9]\\\\d* background",
        );
        assert!(error("codex", &uncounted).contains("one capture"));
    }

    /// OpenCode's screen with `turn` as its conversation's last turn, over its input box.
    fn opencode(turn: &str) -> Option<ScreenState> {
        let output = format!(
            " • New session\r\n\r\n  ┃\r\n  ┃  say hi\r\n  ┃\r\n\r\n{turn}\r\n\r\n  ┃\r\n  ┃\r\n  \
             ┃  Build · m1 Stand-in\r\n  ╹{}\r\n  /work/probe  shift+tab agents  ctrl+p commands",
            "▀".repeat(60)
        );
        state_of("opencode", &view(80, 24, &output))
    }

    #[test]
    fn opencode_s_failed_turn_is_its_error_and_nothing_else_is() {
        let failed = |words: &str| Some(ScreenState::Error(words.into()));
        let cases = [
            (
                "     Error: stand-in model: recorded, not answered\r\n\r\n     Build · m1 · 113ms",
                failed("stand-in model: recorded, not answered"),
                "a failed turn",
            ),
            (
                "     Error: the first part\r\n     and the rest\r\n\r\n     Build · Claude Opus · \
                 1m 5s",
                failed("the first part and the rest"),
                "an error over two lines",
            ),
            (
                "     hi\r\n\r\n     Build · m1 · 23ms · 100.0 tok/s",
                None,
                "a turn that produced words shows its rate",
            ),
            (
                "     Error: the tests fail\r\n\r\n     Build · m1 · 2.5s · 42.0 tok/s",
                None,
                "an answer that begins with Error:",
            ),
            (
                "     Build · m1 · 3.0s · interrupted",
                None,
                "an interrupted turn",
            ),
            (
                "     Error: old\r\n\r\n     Build · m1 · 1ms\r\n  ┃\r\n  ┃  again\r\n  ┃\r\n\r\n     \
                 hi\r\n\r\n     Build · m1 · 5ms · 9.0 tok/s",
                None,
                "only the last turn counts",
            ),
            (
                "     Error: old\r\n\r\n     an answer\r\n\r\n     Build · m1 · 5ms",
                None,
                "an answer's summary without its rate, an older error above it",
            ),
        ];
        for (turn, state, case) in cases {
            assert_eq!(opencode(turn), state, "{case}");
        }
    }

    /// Codex's finished turn: its summary, the count of commands still running, its input, its
    /// model line and its hints, with the summary and the count drawn dim where asked.
    fn codex_finished(summary_dim: bool, count_dim: bool) -> String {
        let dim = |on: bool, text: &str| match on {
            true => format!("\x1b[2m{text}\x1b[22m"),
            false => text.to_string(),
        };
        let summary = dim(summary_dim, "  Worked for 3s • 12:50 PM");
        let count = dim(
            count_dim,
            "  1 background terminal running · /ps to view · /stop to close",
        );
        format!(
            "• Done.\r\n\r\n{summary}\r\n\r\n{count}\r\n\r\n› Ask Codex to do anything\r\n\r\n  \
             model · /work\r\n  ? for shortcuts"
        )
    }

    #[test]
    fn codex_s_finished_turn_is_drawn_dim() {
        let finished = |summary_dim, count_dim| {
            state_of(
                "codex",
                &view(80, 12, &codex_finished(summary_dim, count_dim)),
            )
        };
        assert_eq!(finished(true, true), Some(ScreenState::Idle));
        assert_eq!(
            finished(true, false),
            None,
            "a count not drawn dim is not Codex's"
        );
        assert_eq!(
            finished(false, true),
            None,
            "a summary not drawn dim is not Codex's"
        );
    }

    const MUSE_IDLE: &str =
        "  Muse Code 1.4.14\r\n\r\n────────\r\n❯ \r\n────────\r\n  model · effort · folder";

    #[test]
    fn a_clipped_line_above_muse_s_frame_is_no_evidence() {
        let working = "◈ Thinking (3s · esc to interrupt)\r\n────────\r\n❯ \r\n────────\r\n  model \
                       · effort · folder";
        assert_eq!(
            state_of("muse", &view(40, 8, MUSE_IDLE)),
            Some(ScreenState::Idle)
        );
        assert_eq!(
            state_of("muse", &view(40, 8, working)),
            Some(ScreenState::Working)
        );
        // The working line continues a row scrolled out above: its beginning is not known.
        let clipped = format!("{}{working}", "x".repeat(40));
        assert_eq!(state_of("muse", &view(40, 5, &clipped)), None);
        assert_eq!(
            state_of("claude", &view(40, 8, MUSE_IDLE)),
            None,
            "Claude Code's state is its own reports"
        );
    }

    #[test]
    fn a_page_joins_soft_wraps_and_knows_bold_starts_dim_text_and_a_cut_top_line() {
        let page = Page::of(&view(
            8,
            4,
            "\x1b[1m◆\x1b[22m answer wraps\r\n\x1b[2m  dim\x1b[22m  \r\n\x1b[2mdim\x1b[22m x",
        ));
        let read: Vec<(&str, bool, bool)> = page
            .lines
            .iter()
            .map(|line| (line.text.as_str(), line.bold, line.dim))
            .collect();
        assert_eq!(
            read,
            [
                ("◆ answer wraps", true, false),
                ("  dim", false, true),
                ("dim x", false, false)
            ]
        );
        assert!(!page.cut_at_top);
        assert_eq!(page.width, 8);
        let page = Page::of(&view(4, 2, "abcdefghij"));
        assert!(page.cut_at_top, "the first line began above the screen");
        let texts: Vec<&str> = page.lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, ["efghij"]);
    }
}
