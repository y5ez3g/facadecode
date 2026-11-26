//! Reads a CLI's input box from the cells its screen shows. Each reader knows one layout a CLI
//! was recorded drawing. It uses the terminal cursor or a drawn cursor recognized by the rule to
//! find the input box and tell whether it is empty or holds a draft. A menu or question of the
//! CLI's own can read `interaction` when there is no input box. A rule can also recognize a
//! live notice next to its input box as `interaction`. Other unrecognized screens read `unknown`.
//! A reading comes from the screen alone and never means that input may be typed.

mod paste;
mod probe;

use facade_base::model::terminal::{HiddenRows, InputInfo, InputState};
use facade_screen::{ScreenView, VisibleCell};
use regex::Regex;

use crate::{
    BoxInput, CountedScroll, Editor, EditorBand, EditorLiveNotice, EditorNoticeContext, EditorRail,
    Frame, InputRule, Menu, Prompt, Scrolled,
};

pub use paste::{
    is_legacy_split_paste, is_own_draft, is_own_paste_tail, is_same_draft, settle_time,
    with_paste_text,
};
pub use probe::{ProbeVerdict, restored, shape_of, space_taken, verdict_of};

/// Reads the input box `rule` describes from `view`. Never waits. An open synchronized update
/// reads `unknown`. When the terminal cursor is hidden, a prompt-row rule that opts in uses a
/// unique drawn cursor in its input box. A frame rule that opts in can use a hidden terminal
/// cursor inside a complete frame. Other readings need an on-screen terminal cursor position,
/// with an inverse cell there if the cursor is hidden. A matching menu or question can read
/// `interaction` if the reader cannot locate the input box. An editor rule can also recognize
/// a live notice above its input box as `interaction`.
pub fn read_input(rule: &InputRule, view: &ScreenView) -> InputInfo {
    read_draft(rule, view).0
}

/// Reads the input box as [`read_input`] does, with a draft's text as its rows draw it: each row
/// after the input's margin, without trailing spaces, one line per row; for a CLI that shows a
/// long paste as a placeholder, that placeholder. Scroll marks are left out.
/// A draft whose rows the reader cannot tell apart has no text. The text stays inside Facade:
/// inspect never shows it and nothing saves it.
pub fn read_draft(rule: &InputRule, view: &ScreenView) -> (InputInfo, Option<String>) {
    let read = read_box(rule, view);
    (read.info, read.draft)
}

/// An input box as its reader found it: what [`read_draft`] gives, with its first row and whether
/// that row may be a hint or a draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoxReading {
    pub info: InputInfo,
    pub draft: Option<String>,
    /// Visible text ending at the caret of a full viewport that has no scroll markers.
    /// Only a paste just made into an observed empty input can use it for confirmation.
    pub paste_tail: Option<String>,
    /// The input's first row and the cursor, where the reader found the input.
    pub line: Option<InputLine>,
    /// Unknown because the only input row may be a hint or a draft. A space typed and taken back
    /// tells them apart.
    pub unsure: bool,
}

impl BoxReading {
    /// A reading without captured input geometry or probe evidence.
    pub fn new(info: InputInfo, draft: Option<String>) -> Self {
        Self {
            info,
            draft,
            paste_tail: None,
            line: None,
            unsure: false,
        }
    }
}

/// An input's first row from the column its input starts at to its last cell that draws
/// something, and the cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputLine {
    pub row: usize,
    pub start: usize,
    pub cells: Vec<LineCell>,
    /// A row of the input under the first draws something.
    pub rest: bool,
    /// Column and row.
    pub cursor: (usize, usize),
}

/// One cell of an input's first row.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LineCell {
    pub text: String,
    pub dim: bool,
    pub colored: bool,
}

/// Reads the input box as [`read_draft`] does, with its first row and whether it is unsure of it.
pub fn read_box(rule: &InputRule, view: &ScreenView) -> BoxReading {
    read_box_for_typing(rule, view, false)
}

/// Reads the input for automatic delivery. A fresh input that has received no external edits
/// can try a probe where its rule allows an unstyled hint.
pub fn read_box_for_typing(
    rule: &InputRule,
    view: &ScreenView,
    untouched_input: bool,
) -> BoxReading {
    let screen = Screen::new(view, rule.menus());
    let Reading {
        state,
        evidence,
        hidden,
        draft,
        paste_tail,
        line,
        unsure,
    } = screen.read(rule, view, untouched_input);
    let info = InputInfo {
        state,
        evidence,
        mechanism: Some(rule.mechanism()),
        hidden,
    };
    BoxReading {
        info,
        draft,
        paste_tail,
        line,
        unsure,
    }
}

/// What a reader found, before the rule's mechanism is added.
struct Reading {
    state: InputState,
    evidence: String,
    hidden: Option<HiddenRows>,
    /// The draft as its rows draw it.
    draft: Option<String>,
    paste_tail: Option<String>,
    line: Option<InputLine>,
    unsure: bool,
}

impl Reading {
    fn with_line(self, line: InputLine) -> Reading {
        Reading {
            line: Some(line),
            ..self
        }
    }
}

fn reading(state: InputState, evidence: impl Into<String>) -> Reading {
    Reading {
        state,
        evidence: evidence.into(),
        hidden: None,
        draft: None,
        paste_tail: None,
        line: None,
        unsure: false,
    }
}

/// The input line of `cells`, row `row` from column `start`, `rest` saying whether the input's
/// other rows draw something.
fn line_of(
    cells: &Cells,
    row: usize,
    start: usize,
    rest: bool,
    cursor: (usize, usize),
) -> InputLine {
    let from: Vec<&VisibleCell> = cells.iter().filter(|cell| cell.column >= start).collect();
    let end = from
        .iter()
        .rposition(|cell| draws(cell))
        .map_or(0, |at| at + 1);
    InputLine {
        row,
        start,
        rest,
        cursor,
        cells: from[..end]
            .iter()
            .map(|cell| LineCell {
                text: cell.text.clone(),
                dim: cell.dim,
                colored: cell.colored,
            })
            .collect(),
    }
}

fn unknown(evidence: impl Into<String>) -> Reading {
    reading(InputState::Unknown, evidence)
}

fn usable(evidence: impl Into<String>) -> Reading {
    reading(InputState::Usable, evidence)
}

type Cells = [VisibleCell];

/// A draft drawn on `lines`, each a row's cells after the input's margin. `marks` counts the rows
/// its CLI marks scrolled out above and below.
fn drafted(place: &str, marks: (Option<u32>, Option<u32>), lines: &[&Cells]) -> Reading {
    let mut text = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            text.push('\n');
        }
        text.push_str(joined(line).trim_end());
    }
    let hidden = match marks {
        (None, None) => None,
        (above, below) => Some(HiddenRows {
            above: above.unwrap_or_default(),
            below: below.unwrap_or_default(),
        }),
    };
    let scrolled = if hidden.is_some() { ", scrolled" } else { "" };
    Reading {
        hidden,
        draft: Some(text.trim_end().to_owned()),
        ..reading(InputState::Draft, format!("{place} holds text{scrolled}"))
    }
}

fn joined(cells: &Cells) -> String {
    cells.iter().map(|cell| cell.text.as_str()).collect()
}

/// A cell that draws something other than space.
fn draws(cell: &VisibleCell) -> bool {
    !cell.text.trim().is_empty()
}

fn all_space(cells: &Cells) -> bool {
    cells.iter().all(|cell| !draws(cell))
}

/// Text a person or the CLI wrote, as opposed to a dim hint.
fn written(cell: &VisibleCell) -> bool {
    draws(cell) && !cell.dim
}

/// A row without what its CLI predicts the person types next: drawn from the cursor on, all in
/// another color than the text before it.
fn without_prediction(row: &Cells, column: usize) -> &Cells {
    let (typed, rest) = row.split_at(row.partition_point(|cell| cell.column < column));
    let predicted = typed
        .iter()
        .rev()
        .find(|cell| draws(cell))
        .is_some_and(|last| {
            rest.iter()
                .filter(|cell| draws(cell))
                .all(|cell| cell.foreground != last.foreground)
        });
    if predicted { typed } else { row }
}

fn holds_writing(lines: &[&Cells]) -> bool {
    lines.iter().any(|line| line.iter().any(written))
}

/// Dim and colored text only, with some colored: a hint some CLIs draw where their input starts,
/// which a colored draft looks just like until a space typed and taken back tells them apart.
fn hint_like(cells: &Cells) -> bool {
    let colored = |cell: &VisibleCell| written(cell) && cell.colored;
    cells.iter().any(colored)
        && cells
            .iter()
            .filter(|cell| draws(cell))
            .all(|cell| cell.dim || colored(cell))
}

/// `row 7` or `rows 5-7`, counted from 1.
fn row_span(first: usize, last: usize) -> String {
    match first == last {
        true => format!("row {first}"),
        false => format!("rows {first}-{last}"),
    }
}

/// The number the one capture of `pattern` holds in `line`.
fn counted(pattern: &Regex, line: &str) -> Option<u32> {
    let found = pattern.captures(line)?;
    found[1].parse().ok()
}

/// The screen as the readers look at it.
struct Screen<'a> {
    cells: &'a [Vec<VisibleCell>],
    cols: usize,
    continues: &'a [bool],
    /// Each row's text.
    lines: Vec<String>,
    /// Column and row.
    cursor: (usize, usize),
    menus: &'a [Menu],
}

impl<'a> Screen<'a> {
    fn new(view: &'a ScreenView, menus: &'a [Menu]) -> Screen<'a> {
        Screen {
            cells: &view.rows,
            cols: view.cols,
            continues: &view.continues,
            lines: view.rows.iter().map(|row| joined(row)).collect(),
            cursor: view.cursor,
            menus,
        }
    }

    fn read(mut self, rule: &InputRule, view: &ScreenView, untouched_input: bool) -> Reading {
        if view.synchronized_update {
            return unknown("the CLI is in the middle of a synchronized update");
        }
        if let InputRule::PromptRow {
            prompt,
            alternate_prompt,
            placeholder: Some(_),
            drawn_cursor: true,
            ..
        } = rule
            && !view.cursor_visible
        {
            let Some(cursor) = self.drawn_prompt_cursor(prompt, alternate_prompt.as_deref()) else {
                return self.elsewhere("no unique drawn cursor in the input box");
            };
            self.cursor = cursor;
        } else {
            let (column, row) = self.cursor;
            if row >= self.height() {
                return unknown("the cursor is not on the screen");
            }
            if !view.cursor_visible && !self.own_cursor(row, column) {
                if let InputRule::Frame(frame) = rule
                    && frame.hidden_cursor_in_frame
                {
                    return self.in_frame(frame, untouched_input, true);
                }
                return self.elsewhere(format!(
                    "the terminal cursor is hidden and the CLI draws no cursor at row {}",
                    row + 1
                ));
            }
        }
        match rule {
            InputRule::Frame(frame) => self.in_frame(frame, untouched_input, false),
            InputRule::Prompt(prompt) => self.in_prompt(prompt),
            InputRule::Editor(editor) => self.in_editor(editor, view.cursor_visible),
            InputRule::Box(input) => self.in_box(input),
            InputRule::PromptRow {
                prompt,
                alternate_prompt,
                placeholder,
                dim_draft,
                ..
            } => match placeholder {
                Some(placeholder) => self.in_prompt_rows(
                    prompt,
                    alternate_prompt.as_deref(),
                    placeholder,
                    dim_draft.as_deref(),
                    untouched_input,
                ),
                None => self.on_prompt_row(prompt),
            },
        }
    }

    fn height(&self) -> usize {
        self.cells.len()
    }

    fn row(&self, y: usize) -> &'a Cells {
        &self.cells[y]
    }

    /// Row `y` from cell `index` on; nothing past its end.
    fn from(&self, y: usize, index: usize) -> &'a Cells {
        self.cells[y].get(index..).unwrap_or_default()
    }

    /// The text of cell `index` of row `y`, a space past the row's end or the screen's. A row
    /// starts at column 0, so its first cells' indexes are their columns.
    fn char(&self, y: usize, index: usize) -> &str {
        match self.cells.get(y).and_then(|row| row.get(index)) {
            Some(cell) => &cell.text,
            None => " ",
        }
    }

    fn blank(&self, y: usize) -> bool {
        all_space(self.row(y))
    }

    /// A wrapped row of input: two blank columns, under the prompt and its gap.
    fn wrapped(&self, y: usize) -> bool {
        self.char(y, 0) == " " && self.char(y, 1) == " "
    }

    /// The CLI draws its own cursor, an inverse cell, at `column` of row `y`.
    fn own_cursor(&self, y: usize, column: usize) -> bool {
        self.row(y)
            .iter()
            .any(|cell| cell.column == column && cell.inverse)
    }

    fn cursor_at(&self, column: usize, row: usize) -> bool {
        self.cursor == (column, row)
    }

    /// The row a menu or question of the CLI's shows its selected item or question on.
    fn menu_row(&self, menu: &Menu) -> Option<usize> {
        let row = |y: usize| self.lines[y].trim_end_matches(' ');
        let below_matches =
            |y: usize, pattern: &Regex| y + 1 < self.lines.len() && pattern.is_match(row(y + 1));
        let hinted = |y: usize, pattern: &Regex, within: usize| {
            (y + 1..self.lines.len())
                .take(within)
                .any(|next| pattern.is_match(row(next)))
        };
        (0..self.lines.len()).find(|&y| {
            let line = row(y);
            if !menu.selected.is_match(line) {
                return false;
            }
            if let Some(not) = &menu.not_selected
                && not.is_match(line)
            {
                return false;
            }
            let next_fits = menu.next.as_ref().is_none_or(|next| below_matches(y, next));
            let hint_fits = menu
                .hint
                .as_ref()
                .is_none_or(|hint| hinted(y, &hint.pattern, hint.within));
            next_fits && hint_fits
        })
    }

    /// No input box where the cursor is, because of `why`: `interaction` while a menu or question
    /// of the CLI's own shows, otherwise `unknown`.
    fn elsewhere(&self, why: impl Into<String>) -> Reading {
        let why = why.into();
        for menu in self.menus {
            let Some(y) = self.menu_row(menu) else {
                continue;
            };
            let what = match menu.next {
                Some(_) => "a menu's selected item",
                None => "a question",
            };
            return reading(
                InputState::Interaction,
                format!("{why}; the CLI shows {what} at row {}", y + 1),
            );
        }
        unknown(why)
    }

    /// Reads the box after the prompt and its gap up to row `end`, with the first row for a probe.
    fn after_prompt(
        &self,
        prompt: usize,
        end: usize,
        what: &str,
        scrolled: Option<&CountedScroll>,
        probe_unstyled_hint: bool,
        column: usize,
    ) -> Reading {
        let rest_blank = (prompt + 1..end).all(|y| self.blank(y));
        let line = line_of(self.row(prompt), prompt, column, !rest_blank, self.cursor);
        self.prompt_reading(prompt, end, what, scrolled, probe_unstyled_hint, column)
            .with_line(line)
    }

    fn prompt_reading(
        &self,
        prompt: usize,
        end: usize,
        what: &str,
        scrolled: Option<&CountedScroll>,
        probe_unstyled_hint: bool,
        column: usize,
    ) -> Reading {
        let place = format!("{what} at {}", row_span(prompt + 1, end));
        // Wrapped rows start under the first input cell.
        let lines: Vec<&Cells> = (prompt..end).map(|y| self.from(y, column)).collect();
        let first = self.from(prompt, column);
        let rest_blank = (prompt + 1..end).all(|y| self.blank(y));
        let at_start = self.cursor_at(column, prompt);
        let first_holds_writing = first.iter().any(written);
        if at_start
            && rest_blank
            && (hint_like(first) || probe_unstyled_hint && first_holds_writing)
        {
            return Reading {
                unsure: true,
                ..unknown(format!(
                    "{place} shows text where its input starts, a hint or a draft"
                ))
            };
        }
        if first_holds_writing || (prompt + 1..end).any(|y| holds_writing(&[self.row(y)])) {
            let (above, below) = match scrolled {
                Some(scrolled) if lines.len() > 1 => (
                    counted(&scrolled.above, joined(lines[0]).trim()),
                    counted(&scrolled.below, joined(lines[lines.len() - 1]).trim()),
                ),
                _ => (None, None),
            };
            let from = usize::from(above.is_some());
            let to = lines.len() - usize::from(below.is_some());
            return drafted(&place, (above, below), &lines[from..to]);
        }
        if !rest_blank {
            return unknown(format!(
                "{place} holds dim text under its prompt row, which is no hint"
            ));
        }
        if !at_start {
            return unknown(format!(
                "{place} is empty, but the cursor is not where the input starts"
            ));
        }
        match all_space(first) {
            true => usable(format!("{place} is empty")),
            false => usable(format!("{place} is empty but for its dim hint")),
        }
    }

    /// A draft whose scroll marks are outside the given input cells.
    fn scrolled_draft(
        &self,
        first: usize,
        what: &str,
        marks: (Option<u32>, Option<u32>),
        lines: &[&Cells],
        column: usize,
    ) -> Reading {
        let place = format!("{what} at {}", row_span(first + 1, first + lines.len()));
        let rest = lines[1..].iter().any(|line| !all_space(line));
        drafted(&place, marks, lines).with_line(line_of(lines[0], first, column, rest, self.cursor))
    }

    /// `frame`: input between two rules, with a prompt row unless it scrolled out.
    fn in_frame(
        &self,
        frame: &Frame,
        untouched_input: bool,
        hidden_hardware_caret: bool,
    ) -> Reading {
        let (cursor_column, cursor_row) = self.cursor;
        let missing = || {
            self.elsewhere(format!(
                "no input frame around the cursor at row {}",
                cursor_row + 1
            ))
        };
        let column = frame.indent + 2;
        if hidden_hardware_caret && !(column..self.cols).contains(&cursor_column) {
            return missing();
        }
        let blank_prefix = |y, width| all_space(self.row(y).get(..width).unwrap_or(self.row(y)));
        let wrapped = |y| blank_prefix(y, column);
        let prompt_at = |y: usize| {
            let gap = frame.indent + 1;
            let glyph = self.char(y, frame.indent);
            blank_prefix(y, frame.indent)
                && (glyph == frame.prompt || frame.alternate_prompt.as_deref() == Some(glyph))
                && (self.char(y, gap) == frame.gap || all_space(self.from(y, gap)))
        };
        let (row_marks, rule_marks) = match &frame.scrolled {
            Scrolled::Rows(marks) => (Some(marks), None),
            Scrolled::Rules(marks) => (None, Some(marks)),
            Scrolled::LastColumn { .. } | Scrolled::Unmarked(_) => (None, None),
        };
        // Up from the cursor over wrapped rows to the prompt or a marked upper rule.
        let upper = (0..=cursor_row)
            .rev()
            .find(|&y| prompt_at(y) || !wrapped(y))
            .and_then(|y| {
                if prompt_at(y) {
                    y.checked_sub(1)
                } else {
                    Some(y)
                }
            });
        let Some(upper) = upper else {
            return missing();
        };
        let first = upper + 1;
        let above = rule_marks.and_then(|marks| counted(&marks.above, &self.lines[upper]));
        if first > cursor_row
            || !(!hidden_hardware_caret && above.is_some()
                || prompt_at(first) && frame.upper.is_match(&self.lines[upper]))
        {
            return missing();
        }
        // Down over wrapped rows to the lower rule.
        let below_at =
            |y: usize| rule_marks.and_then(|marks| counted(&marks.below, &self.lines[y]));
        let lower_at = |y: usize| {
            frame.lower.is_match(&self.lines[y]) || !hidden_hardware_caret && below_at(y).is_some()
        };
        let lower = (first + 1..self.height())
            .find(|&y| lower_at(y) || !wrapped(y))
            .filter(|&y| lower_at(y));
        let Some(lower) = lower else {
            return missing();
        };
        if hidden_hardware_caret && cursor_row >= lower {
            return missing();
        }
        let below = below_at(lower);
        if above.is_some() || below.is_some() {
            let lines: Vec<&Cells> = (first..lower).map(|y| self.from(y, column)).collect();
            return self.scrolled_draft(first, "the input frame", (above, below), &lines, column);
        }
        if let Some(mode) = &frame.placeholder {
            let one_row = lower == first + 1;
            let footer = self
                .lines
                .get(lower + 1)
                .is_some_and(|line| mode.footer.is_match(line));
            let shown = joined(self.from(first, column));
            let shown = shown.trim_end();
            if one_row && footer && mode.texts.iter().any(|text| names_mode(shown, text)) {
                let place = format!("the input frame at row {}", first + 1);
                return match self.cursor_at(column, first) {
                    true => usable(format!(
                        "{place} shows its mode placeholder above its empty-input footer"
                    )),
                    false => unknown(format!(
                        "{place} shows its mode placeholder, but the cursor is not where the \
                         input starts"
                    )),
                };
            }
        }
        self.after_prompt(
            first,
            lower,
            "the input frame",
            row_marks,
            untouched_input && frame.probe_unstyled_hint,
            column,
        )
    }

    /// `prompt`: a prompt row above a model line, or a scrolled input without the model line.
    fn in_prompt(&self, rule: &Prompt) -> Reading {
        let cursor_row = self.cursor.1;
        let missing_model =
            || self.elsewhere("no model line with a blank row above it at the bottom");
        let Some(bottom) = (0..self.height()).rev().find(|&y| !self.blank(y)) else {
            return missing_model();
        };
        let model_at = |y: usize| y >= 2 && rule.model_line.is_match(&self.lines[y]);
        let model = [Some(bottom), bottom.checked_sub(1)]
            .into_iter()
            .flatten()
            .find(|&y| model_at(y))
            .filter(|&y| self.blank(y - 1))
            .or_else(|| {
                let hint = rule.wrapped_footer_hint.as_ref()?;
                if !hint.is_match(self.lines[bottom].trim_end()) {
                    return None;
                }
                // A wrapped footer begins at the top of the indented block before the hint.
                (0..bottom)
                    .rev()
                    .take_while(|&y| self.wrapped(y) && !self.blank(y))
                    .last()
                    .filter(|&y| model_at(y) && self.blank(y - 1))
            });
        // The input ends before the blank row above the model line, or after the last row with text.
        let last = model.map_or(bottom, |model| model - 2);
        let end = last + 1;
        let prompt_at = |y: usize| {
            let glyph = self.char(y, 0);
            (glyph == rule.prompt || rule.alternate_prompt.as_deref() == Some(glyph))
                && self.char(y, 1) == " "
        };
        let start = cursor_row.min(last);
        let prompt = (0..=start)
            .rev()
            .find(|&y| prompt_at(y) || !(self.wrapped(y) || self.blank(y)))
            .filter(|&y| prompt_at(y));
        let Some(prompt) = prompt else {
            if model.is_none() {
                return missing_model();
            }
            return self.elsewhere("no prompt row above the cursor in the input");
        };
        let marked = |y: usize, mark: &str| {
            self.row(y)
                .last()
                .is_some_and(|cell| cell.column + 1 == self.cols && cell.dim && cell.text == mark)
        };
        let (above, below) = match &rule.scrolled {
            Scrolled::LastColumn { above, below } if model.is_none() => {
                (marked(prompt, above), marked(last, below))
            }
            _ => (false, false),
        };
        if model.is_none() && !above && !below {
            return missing_model();
        }
        if !(prompt..end).contains(&cursor_row) {
            return if model.is_some() {
                self.elsewhere(format!(
                    "the cursor at row {} is not in the input above the model line",
                    cursor_row + 1
                ))
            } else {
                missing_model()
            };
        }
        let stranger = (cursor_row + 1..end).find(|&y| !self.wrapped(y) && !self.blank(y));
        if let Some(y) = stranger {
            return self.elsewhere(format!(
                "row {} under the cursor is not part of the input",
                y + 1
            ));
        }
        if model.is_some() {
            return self.after_prompt(prompt, end, "the input", None, false, 2);
        }
        let lines: Vec<&Cells> = (prompt..end)
            .map(|y| {
                let row = self.row(y);
                let marked = (y == prompt && above) || (y == last && below);
                row.get(2..row.len() - usize::from(marked))
                    .unwrap_or_default()
            })
            .collect();
        self.scrolled_draft(
            prompt,
            "the input",
            (above.then_some(1), below.then_some(1)),
            &lines,
            2,
        )
    }

    /// `editor`: rows under a status band, beside a rail, or between two rules.
    fn in_editor(&self, rule: &Editor, cursor_visible: bool) -> Reading {
        if let Some(rail) = &rule.rail {
            return self.in_editor_rail(rule, rail, cursor_visible);
        }
        let (column, cursor_row) = self.cursor;
        let limit = match &rule.scrolled {
            Scrolled::Unmarked(height) => Some(height.visible_rows(self.height(), rule.most_rows)),
            _ => None,
        };
        if let (Some(band), Some(limit)) = (&rule.band, limit)
            && let Some(reading) = self.in_editor_band(band, cursor_visible, limit + 1)
        {
            return reading;
        }
        let tallest = (self.height() as f64 * rule.most_share).floor() as usize;
        let tallest = limit.unwrap_or_else(|| tallest.max(rule.most_rows));
        let upper = (0..cursor_row)
            .rev()
            .find(|&y| rule.upper.is_match(&self.lines[y]));
        let lower = (cursor_row..self.height()).find(|&y| rule.lower.is_match(&self.lines[y]));
        let rules = upper
            .zip(lower)
            .filter(|(upper, lower)| (1..=tallest).contains(&(lower - upper - 1)));
        let Some((upper, lower)) = rules else {
            return self.elsewhere(format!(
                "no editor between two rules around the cursor at row {}",
                cursor_row + 1
            ));
        };
        let place = format!("the editor at {}", row_span(upper + 2, lower));
        let cursor_in_editor =
            self.own_cursor(cursor_row, column) || (rule.hardware_cursor && cursor_visible);
        if cursor_row == lower || !cursor_in_editor {
            return unknown(format!(
                "{place} has no cursor of its own where the cursor is, at row {}",
                cursor_row + 1
            ));
        }
        let lines: Vec<&Cells> = (upper + 1..lower).map(|y| self.row(y)).collect();
        if limit == Some(lines.len()) {
            return self.full_editor(lower, column, lines, &place);
        }
        let marks = match &rule.scrolled {
            Scrolled::Rules(marks) => (
                counted(&marks.above, &self.lines[upper]),
                counted(&marks.below, &self.lines[lower]),
            ),
            _ => (None, None),
        };
        self.editor_reading(upper + 1, 0, &lines, &place, marks, column <= 3)
    }

    fn in_editor_rail(&self, rule: &Editor, rail: &EditorRail, cursor_visible: bool) -> Reading {
        let (column, cursor_row) = self.cursor;
        let missing = || self.elsewhere("no complete interactive input box around the cursor");
        if !cursor_visible {
            return missing();
        }

        let (bounds, start, end) = if self.char(cursor_row, 0) == "┃" {
            (
                self.editor_rail_bounds(cursor_row),
                2,
                self.cols.saturating_sub(1),
            )
        } else {
            let start = unicode_width::UnicodeWidthStr::width(rail.fallback_prompt.as_str());
            (
                self.editor_fallback_bounds(rule, rail, cursor_row, start),
                start,
                self.cols.saturating_sub(3),
            )
        };
        let Some((upper, lower)) = bounds else {
            return missing();
        };
        let first = upper + 1;
        let limit = (self.height().saturating_sub(4) / 2).max(3);
        if !(start..end).contains(&column) || lower - first > limit {
            return missing();
        }

        // The rail can also enclose shell input, so both layouts need the native mode footer.
        let interactive = self.lines.get(lower + 1).is_some_and(|footer| {
            rail.footer.is_match(footer)
                && !footer.split(" · ").any(|segment| {
                    matches!(
                        segment.trim(),
                        "Shell"
                            | "Plan"
                            | "Autopilot"
                            | "Autopilot (limited)"
                            | "esc exit shell mode"
                    )
                })
        });
        if !interactive {
            return missing();
        }

        let mut lines = Vec::new();
        for row in first..lower {
            let cells = self.row(row);
            let from = cells.partition_point(|cell| cell.column < start);
            let to = cells.partition_point(|cell| cell.column < end);
            if !all_space(&cells[to..]) {
                return missing();
            }
            lines.push(&cells[from..to]);
        }
        let place = format!("the editor at {}", row_span(first + 1, lower));
        if rail
            .live_notice
            .as_ref()
            .is_some_and(|notice| self.editor_live_notice(notice, upper))
        {
            return reading(
                InputState::Interaction,
                format!("the CLI shows a live notice above {place}"),
            );
        }
        if lines.len() == limit {
            let at = lines[cursor_row - first].partition_point(|cell| cell.column < column);
            return self.full_editor(lower, at, lines, &place);
        }
        self.editor_reading(first, start, &lines, &place, (None, None), column == start)
    }

    fn editor_live_notice(&self, notice: &EditorLiveNotice, upper: usize) -> bool {
        let single_row = upper
            .checked_sub(notice.rows_above_upper.get())
            .and_then(|row| self.editor_notice_text(row));
        single_row == Some(notice.text.as_str())
            || notice
                .wrapped_context
                .as_ref()
                .is_some_and(|context| self.editor_notice_with_context(notice, context, upper))
    }

    fn editor_notice_text(&self, row: usize) -> Option<&str> {
        let cells = self.cells.get(row)?;
        if !self.editor_notice_row_complete(row) {
            return None;
        }
        let last = cells.iter().rposition(|cell| cell.text != " ")?;
        let literal = &cells[..=last];
        (literal[0].column == 0 && literal.iter().all(|cell| cell.bold && cell.colored))
            .then(|| self.lines[row].trim_end_matches(' '))
    }

    fn editor_notice_with_context(
        &self,
        notice: &EditorLiveNotice,
        context: &EditorNoticeContext,
        upper: usize,
    ) -> bool {
        let Some(last) = upper.checked_sub(1) else {
            return false;
        };
        let is_context = |row| {
            self.editor_notice_row_complete(row)
                && self.lines[row].starts_with(' ')
                && !self.lines[row].trim().is_empty()
        };
        if !is_context(last)
            || !context
                .last
                .is_match(self.lines[last].trim_end_matches(' '))
        {
            return false;
        }
        let preceding = (0..last)
            .rev()
            .take(context.max_rows.get() - 1)
            .take_while(|&row| is_context(row))
            .count();
        let Some(bottom) = last.checked_sub(preceding + 1) else {
            return false;
        };

        // Each adjacent row must consume whole words from the end of the literal.
        let mut remaining = notice.text.as_str();
        for row in (0..=bottom).rev() {
            let Some(text) = self.editor_notice_text(row) else {
                return false;
            };
            let Some(prefix) = remaining.strip_suffix(text) else {
                return false;
            };
            if prefix.is_empty() {
                return row != bottom;
            }
            let Some(unmatched) = prefix.strip_suffix(' ') else {
                return false;
            };
            remaining = unmatched;
        }
        false
    }

    fn editor_notice_row_complete(&self, row: usize) -> bool {
        self.continues
            .get(row..=row + 1)
            .is_some_and(|wraps| wraps == [false, false])
    }

    fn editor_rail_bounds(&self, cursor_row: usize) -> Option<(usize, usize)> {
        let interior = |row| {
            self.row(row).first().is_some_and(|cell| {
                cell.column == 0 && cell.text == "┃" && cell.colored && self.char(row, 1) == " "
            })
        };
        if !interior(cursor_row) {
            return None;
        }
        let upper = (0..cursor_row).rev().find(|&row| !interior(row))?;
        let lower = (cursor_row + 1..self.height()).find(|&row| !interior(row))?;
        let cap = |row, glyph, fill| {
            let cells = self.row(row);
            cells.len() == self.cols
                && cells.iter().enumerate().all(|(column, cell)| {
                    cell.column == column
                        && cell.colored
                        && cell.text == if column == 0 { glyph } else { fill }
                })
        };
        (cap(upper, "╻", "▄") && cap(lower, "╹", "▀")).then_some((upper, lower))
    }

    fn editor_fallback_bounds(
        &self,
        rule: &Editor,
        rail: &EditorRail,
        cursor_row: usize,
        start: usize,
    ) -> Option<(usize, usize)> {
        let border = |row, pattern: &Regex| {
            self.row(row)
                .iter()
                .map(|cell| cell.column)
                .eq(0..self.cols)
                && pattern.is_match(&self.lines[row])
        };
        let upper = (0..cursor_row)
            .rev()
            .find(|&row| border(row, &rule.upper))?;
        let lower = (cursor_row + 1..self.height()).find(|&row| border(row, &rule.lower))?;
        let first = upper + 1;
        let wrapped = |row| {
            self.row(row).get(..start).is_some_and(|cells| {
                cells
                    .iter()
                    .enumerate()
                    .all(|(column, cell)| cell.column == column && cell.text == " ")
            })
        };
        (self.lines[first].starts_with(&rail.fallback_prompt) && (first + 1..lower).all(wrapped))
            .then_some((upper, lower))
    }

    /// Once the status and prompt identify a band, declines any incomplete input box there.
    fn in_editor_band(
        &self,
        band: &EditorBand,
        cursor_visible: bool,
        limit: usize,
    ) -> Option<Reading> {
        let (column, cursor_row) = self.cursor;
        let first = (1..=cursor_row).rev().find(|&row| {
            self.lines[row].starts_with(&band.prompt) && band.top.is_match(&self.lines[row - 1])
        })?;
        let incomplete = || Some(self.elsewhere("the editor band has no complete input box"));
        let start = unicode_width::UnicodeWidthStr::width(band.prompt.as_str());
        let split_row = |row| {
            let cells = self.row(row);
            cells.split_at(cells.partition_point(|cell| cell.column < start))
        };
        let status_text = self
            .row(first - 1)
            .iter()
            .skip_while(|cell| cell.text != " ")
            .nth(1);
        let (prompt, _) = split_row(first);
        if !cursor_visible
            || !(start..self.cols).contains(&column)
            || !status_text.is_some_and(|cell| cell.colored && draws(cell))
            || !prompt.iter().all(|cell| cell.colored)
        {
            return incomplete();
        }

        // The painted margin identifies continuation rows even when their input is blank.
        let end = (first + 1..self.height())
            .find(|&row| {
                let (gutter, _) = split_row(row);
                gutter.len() != start || !gutter.iter().all(|cell| cell.colored && cell.text == " ")
            })
            .unwrap_or_else(|| self.height());
        if cursor_row >= end
            || end - first > limit
            || (end..self.height())
                .any(|row| !self.blank(row) || split_row(row).0.iter().any(|cell| cell.colored))
        {
            return incomplete();
        }

        let place = format!("the editor at {}", row_span(first + 1, end));
        let mut lines: Vec<&Cells> = (first..end).map(|row| split_row(row).1).collect();
        let typed = &mut lines[cursor_row - first];
        *typed = without_prediction(typed, column);
        if lines.len() == limit {
            let at = split_row(cursor_row)
                .1
                .partition_point(|cell| cell.column < column);
            return Some(self.full_editor(end, at, lines, &place));
        }
        Some(self.editor_reading(
            first,
            start,
            &lines,
            &place,
            (None, None),
            column <= start + 3,
        ))
    }

    fn full_editor(&self, end: usize, at: usize, mut lines: Vec<&Cells>, place: &str) -> Reading {
        let mut reading = unknown(format!(
            "{place} fills its viewport and may have scrolled rows"
        ));
        let last_row = lines.len() - 1;
        let last = lines[last_row];
        let at = at.min(last.len());
        if self.cursor.1 + 1 == end && !last[at..].iter().any(written) && holds_writing(&lines) {
            lines[last_row] = &last[..at];
            reading.paste_tail = drafted(place, (None, None), &lines).draft;
        }
        reading
    }

    fn editor_reading(
        &self,
        first: usize,
        start: usize,
        lines: &[&Cells],
        place: &str,
        marks: (Option<u32>, Option<u32>),
        near_start: bool,
    ) -> Reading {
        let column = self.cursor.0;
        // One row, with the cursor in its first columns and nothing drawn before it.
        let at_start = lines.len() == 1
            && near_start
            && !lines[0]
                .iter()
                .any(|cell| cell.column < column && draws(cell));
        let reading = if at_start && hint_like(lines[0]) {
            Reading {
                unsure: true,
                ..unknown(format!(
                    "{place} shows colored text where its input starts, a hint or a draft"
                ))
            }
        } else if holds_writing(lines) {
            drafted(place, marks, lines)
        } else if lines.len() > 1 || !near_start {
            unknown(format!(
                "{place} is empty, but the cursor is not where the input starts"
            ))
        } else {
            usable(format!("{place} is empty"))
        };
        let rest = lines[1..].iter().any(|line| !all_space(line));
        reading.with_line(line_of(lines[0], first, start, rest, self.cursor))
    }

    /// `box`: rows that start with a bar, above a half-block border.
    fn in_box(&self, rule: &BoxInput) -> Reading {
        let (column, cursor_row) = self.cursor;
        let missing = || {
            self.elsewhere(format!(
                "no input box around the cursor at row {}",
                cursor_row + 1
            ))
        };
        let Some(bar) = self.row(cursor_row).iter().position(draws) else {
            return missing();
        };
        let gap_width = if self.cols < rule.narrow_below { 1 } else { 2 };
        let text_from = bar + 1 + gap_width;
        // A row that starts with the bar.
        let barred = |y: usize| self.char(y, bar) == rule.bar && all_space(&self.row(y)[..bar]);
        // A row of the box: the bar, then its interior gap.
        let inside =
            |y: usize| barred(y) && (bar + 1..text_from).all(|column| self.char(y, column) == " ");
        // A row of the box with nothing after its bar.
        let gap = |y: usize| barred(y) && all_space(self.from(y, bar + 1));
        if !inside(cursor_row) || column < text_from {
            return missing();
        }
        let border = (cursor_row + 1..self.height())
            .find(|&y| !barred(y))
            .unwrap_or(self.height());
        if border >= self.height() || border < 2 {
            return missing();
        }
        // Under the text, a blank box row, then the box's last row over the border.
        let pad = border - 2;
        let closed = self.char(border, bar) == rule.corner
            && self.char(border, bar + 1) == rule.edge
            && pad > cursor_row
            && gap(pad)
            && inside(border - 1)
            && !all_space(self.from(border - 1, text_from));
        if !closed {
            return missing();
        }
        // Up from the cursor over the box's text rows to the blank row that opens it.
        let top = (0..cursor_row)
            .rev()
            .find(|&y| gap(y) || !inside(y))
            .filter(|&y| gap(y));
        let Some(top) = top else {
            return missing();
        };
        let place = format!("the input box at {}", row_span(top + 2, pad));
        if top > 0 && inside(top - 1) {
            return match gap(top - 1) {
                true => unknown(format!(
                    "{place} has the bar of something else right above it"
                )),
                false => reading(
                    InputState::Draft,
                    format!("{place} holds text above an empty line"),
                ),
            };
        }
        let lines: Vec<&Cells> = (top + 1..pad).map(|y| self.from(y, text_from)).collect();
        let empty = |tail: &str| match lines.len() == 1 && self.cursor_at(text_from, top + 1) {
            true => usable(format!("{place} is empty{tail}")),
            false => unknown(format!(
                "{place} is empty, but the cursor is not where the input starts"
            )),
        };
        if lines.len() == 1 && rule.placeholder.is_match(&joined(lines[0])) {
            empty(" but for its placeholder")
        } else if holds_writing(&lines) {
            drafted(&place, (None, None), &lines)
        } else {
            empty("")
        }
    }

    /// Finds the prompt row and its input start for a cursor on that row or a wrapped row.
    fn prompt_row_at(
        &self,
        (column, row): (usize, usize),
        prompt: &str,
        alternate: Option<&str>,
    ) -> Option<(usize, usize)> {
        for y in (0..=row).rev() {
            let line = self.lines[y].trim_start_matches(' ');
            let indent = self.lines[y].len() - line.len();
            if let Some(marker) = std::iter::once(prompt)
                .chain(alternate)
                .find(|marker| line.starts_with(marker) || line == marker.trim_end())
            {
                let start = indent + unicode_width::UnicodeWidthStr::width(marker);
                return (column >= start
                    && (y + 1..=row).all(|next| self.wrapped_under_prompt(next, start)))
                .then_some((y, start));
            }
            if indent == 0 && !line.is_empty() {
                break;
            }
        }
        None
    }

    fn wrapped_under_prompt(&self, row: usize, start: usize) -> bool {
        self.row(row).iter().take(start).all(|cell| !draws(cell))
    }

    fn drawn_prompt_cursor(&self, prompt: &str, alternate: Option<&str>) -> Option<(usize, usize)> {
        let mut candidates = self
            .cells
            .iter()
            .enumerate()
            .flat_map(|(row, cells)| {
                cells
                    .iter()
                    .filter(|cell| cell.inverse)
                    .map(move |cell| (cell.column, row))
            })
            .filter(|&cursor| self.prompt_row_at(cursor, prompt, alternate).is_some());
        let cursor = candidates.next()?;
        candidates.next().is_none().then_some(cursor)
    }

    /// Reads an input box with a prompt row and any wrapped rows under it.
    fn in_prompt_rows(
        &self,
        prompt: &str,
        alternate: Option<&str>,
        placeholder: &Regex,
        dim_draft: Option<&Regex>,
        untouched_input: bool,
    ) -> Reading {
        let Some((y, start)) = self.prompt_row_at(self.cursor, prompt, alternate) else {
            return self.elsewhere("no native prompt around the cursor");
        };
        let row = self.cursor.1;
        let end = (row + 1..self.height())
            .find(|&next| {
                !self.wrapped_under_prompt(next, start)
                    || !self.from(next, start).iter().any(written)
            })
            .unwrap_or_else(|| self.height());
        let first = self.from(y, start);
        if y + 1 == end && dim_draft.is_some_and(|pattern| pattern.is_match(joined(first).trim())) {
            let place = format!("the prompt at row {}", y + 1);
            return drafted(&place, (None, None), &[first]).with_line(line_of(
                self.row(y),
                y,
                start,
                false,
                self.cursor,
            ));
        }
        let mut probe_unstyled_hint = false;
        if y + 1 == end && self.cursor_at(start, y) && placeholder.is_match(joined(first).trim()) {
            if first
                .iter()
                .filter(|cell| draws(cell))
                .all(|cell| cell.dim || cell.inverse)
            {
                return usable(format!("the prompt at row {} shows its hint", y + 1))
                    .with_line(line_of(self.row(y), y, start, false, self.cursor));
            }
            probe_unstyled_hint = untouched_input;
        }
        self.after_prompt(y, end, "the prompt", None, probe_unstyled_hint, start)
    }

    /// `prompt_row`: the last row that starts with the prompt holds the input.
    fn on_prompt_row(&self, prompt: &str) -> Reading {
        let Some(y) = self.lines.iter().rposition(|line| line.starts_with(prompt)) else {
            return unknown("no row starts with the prompt");
        };
        let place = format!("the prompt row at row {}", y + 1);
        let typed = self.lines[y][prompt.len()..].trim();
        if typed.is_empty() {
            return usable(format!("{place} is empty"));
        }
        Reading {
            draft: Some(typed.to_owned()),
            ..reading(InputState::Draft, format!("{place} holds text"))
        }
    }
}

/// Whether `shown` names the mode placeholder `text`: all of it, or cut short with an ellipsis,
/// but never before the mode's name.
fn names_mode(shown: &str, text: &str) -> bool {
    if shown == text {
        return true;
    }
    let Some(kept) = shown.strip_suffix("...") else {
        return false;
    };
    let shown_chars = shown.chars().count();
    let name_end = text.find(':').unwrap_or(0);
    text.starts_with(kept) && shown_chars > name_end + 4 && shown_chars < text.chars().count()
}
