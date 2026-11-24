//! Reads a CLI's input box from the cells its screen shows. Each reader knows one layout a CLI
//! was recorded drawing: it finds the input box around the cursor, then tells whether the box is
//! empty, holds a draft, or gives way to a menu or question of the CLI's own. Any other screen
//! reads `unknown`. A reading comes from the screen alone and never means that input may be typed.

mod paste;
mod probe;

use facade_base::model::terminal::{HiddenRows, InputInfo, InputState};
use facade_screen::{ScreenView, VisibleCell};
use regex::Regex;

use crate::{BoxInput, CountedScroll, Editor, Frame, InputRule, Menu, Prompt, Question, Scrolled};

pub use paste::{is_legacy_split_paste, is_own_draft, is_same_draft, settle_time, with_paste_text};
pub use probe::{ProbeVerdict, restored, shape_of, space_taken, verdict_of};

/// Reads the input box `rule` describes from `view`. Never waits. An open synchronized update, a
/// cursor off the screen, or a hidden terminal cursor where the CLI draws no cursor of its own
/// reads `unknown`; behind a hidden cursor, a menu or question of the CLI's own reads
/// `interaction`.
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
    /// The input's first row and the cursor, where the reader found the input.
    pub line: Option<InputLine>,
    /// Unknown because the only input row may be a hint or a draft. A space typed and taken back
    /// tells them apart.
    pub unsure: bool,
}

impl BoxReading {
    /// The draft's rows out of sight, for telling a message's own draft: those its CLI marks, as
    /// `info.hidden` gives them, or, where the screen cut the input above its first row without a
    /// mark, one row above at least.
    pub fn draft_hidden(&self) -> Option<HiddenRows> {
        let cut = self.line.as_ref().is_some_and(|line| line.cut);
        (self.info.hidden).or(cut.then_some(HiddenRows { above: 1, below: 0 }))
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
    /// The screen cut the input above this row without a mark of its CLI's: the input's first rows
    /// may be out of sight.
    pub cut: bool,
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

    /// The reading of an input the screen cut above its first row without a mark.
    fn cut(mut self) -> Reading {
        if let Some(line) = &mut self.line {
            line.cut = true;
        }
        self
    }
}

fn reading(state: InputState, evidence: impl Into<String>) -> Reading {
    Reading {
        state,
        evidence: evidence.into(),
        hidden: None,
        draft: None,
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
        cut: false,
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

fn styled(cell: &VisibleCell) -> bool {
    cell.dim || cell.colored
}

/// Text, all of it dim or colored, as a CLI that draws its input plain writes around it.
fn styled_only(cells: &Cells) -> bool {
    cells.iter().any(draws) && cells.iter().all(|cell| !draws(cell) || styled(cell))
}

/// `row 7` or `rows 5-7`, counted from 1.
fn row_span(first: usize, last: usize) -> String {
    match first == last {
        true => format!("row {first}"),
        false => format!("rows {first}-{last}"),
    }
}

/// The number the one capture of `pattern` holds in `line`, 1 where it matches without one.
fn counted(pattern: &Regex, line: &str) -> Option<u32> {
    let found = pattern.captures(line)?;
    found
        .get(1)
        .map_or(Some(1), |number| number.as_str().parse().ok())
}

/// The screen as the readers look at it.
struct Screen<'a> {
    cells: &'a [Vec<VisibleCell>],
    cols: usize,
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
            lines: view.rows.iter().map(|row| joined(row)).collect(),
            cursor: view.cursor,
            menus,
        }
    }

    fn read(&self, rule: &InputRule, view: &ScreenView, untouched_input: bool) -> Reading {
        let (column, row) = self.cursor;
        if view.synchronized_update {
            return unknown("the CLI is in the middle of a synchronized update");
        }
        if row >= self.height() {
            return unknown("the cursor is not on the screen");
        }
        if !view.cursor_visible && !self.own_cursor(row, column) {
            return self.elsewhere(format!(
                "the terminal cursor is hidden and the CLI draws no cursor at row {}",
                row + 1
            ));
        }
        match rule {
            InputRule::Frame(frame) => self.in_frame(frame, untouched_input),
            InputRule::Prompt(prompt) => self.in_prompt(prompt),
            InputRule::Editor(editor) => self.in_editor(editor),
            InputRule::Box(input) => self.in_box(input),
            InputRule::PromptRow { prompt } => self.on_prompt_row(prompt),
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
        let below_matches = |y: usize, pattern: &Regex| {
            self.lines
                .get(y + 1)
                .is_some_and(|line| pattern.is_match(line))
        };
        let hinted = |y: usize, pattern: &Regex, within: usize| {
            self.lines[y + 1..]
                .iter()
                .take(within)
                .any(|line| pattern.is_match(line))
        };
        (0..self.lines.len()).find(|&y| {
            let line = &self.lines[y];
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
    ) -> Reading {
        let rest_blank = (prompt + 1..end).all(|y| self.blank(y));
        let line = line_of(self.row(prompt), prompt, 2, !rest_blank, self.cursor);
        self.prompt_reading(prompt, end, what, scrolled, probe_unstyled_hint)
            .with_line(line)
    }

    fn prompt_reading(
        &self,
        prompt: usize,
        end: usize,
        what: &str,
        scrolled: Option<&CountedScroll>,
        probe_unstyled_hint: bool,
    ) -> Reading {
        let place = format!("{what} at {}", row_span(prompt + 1, end));
        // Wrapped rows start under the prompt's two columns.
        let lines: Vec<&Cells> = (prompt..end).map(|y| self.from(y, 2)).collect();
        let first = self.from(prompt, 2);
        let rest_blank = (prompt + 1..end).all(|y| self.blank(y));
        let at_start = self.cursor_at(2, prompt);
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
    ) -> Reading {
        let place = format!("{what} at {}", row_span(first + 1, first + lines.len()));
        let rest = lines[1..].iter().any(|line| !all_space(line));
        drafted(&place, marks, lines).with_line(line_of(lines[0], first, 2, rest, self.cursor))
    }

    /// What shows of an input whose other rows do not, `lines` from row `first`: `draft` where the last
    /// of them is the cursor's row with the cursor behind its text, as a paste leaves it, and no menu
    /// shows; otherwise `none`.
    fn as_pasted(
        &self,
        none: Reading,
        first: usize,
        lines: &[&Cells],
        draft: impl FnOnce() -> Reading,
    ) -> Reading {
        let (column, cursor_row) = self.cursor;
        let behind_text =
            (self.row(cursor_row).iter()).all(|cell| cell.column < column || !draws(cell));
        let pasted = first + lines.len() == cursor_row + 1 && behind_text && holds_writing(lines);
        match none.state {
            InputState::Unknown if pasted => draft(),
            _ => none,
        }
    }

    /// `frame`: input between two rules, with a prompt row unless it scrolled out.
    fn in_frame(&self, frame: &Frame, untouched_input: bool) -> Reading {
        let cursor_row = self.cursor.1;
        let missing = || {
            self.elsewhere(format!(
                "no input frame around the cursor at row {}",
                cursor_row + 1
            ))
        };
        let prompt_at = |y: usize| {
            self.char(y, 0) == frame.prompt
                && (self.char(y, 1) == frame.gap || all_space(self.from(y, 1)))
        };
        let (row_marks, rule_marks) = match &frame.scrolled {
            Scrolled::Rows(marks) => (Some(marks), None),
            Scrolled::Rules(marks) => (None, Some(marks)),
            Scrolled::LastColumn { .. } => (None, None),
        };
        // Up from the cursor over wrapped rows to the prompt, or to the upper rule over a draft that
        // scrolled.
        let upper = (0..=cursor_row)
            .rev()
            .find(|&y| prompt_at(y) || !self.wrapped(y))
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
        let upper_at = frame.upper.is_match(&self.lines[upper]);
        let above = match &frame.scrolled {
            Scrolled::Rules(marks) => counted(&marks.above, &self.lines[upper]),
            Scrolled::Rows(_) | Scrolled::LastColumn { .. } => None,
        };
        // The prompt row scrolled out without a mark.
        let unmarked = frame.scrolls_unmarked && above.is_none() && upper_at && !prompt_at(first);
        if first > cursor_row || !(above.is_some() || unmarked || prompt_at(first) && upper_at) {
            return missing();
        }
        // Down over wrapped rows to the lower rule.
        let below_at =
            |y: usize| rule_marks.and_then(|marks| counted(&marks.below, &self.lines[y]));
        let lower_at = |y: usize| frame.lower.is_match(&self.lines[y]) || below_at(y).is_some();
        let lower = (first + 1..self.height())
            .find(|&y| lower_at(y) || !self.wrapped(y))
            .filter(|&y| lower_at(y));
        let Some(lower) = lower else {
            return missing();
        };
        let below = below_at(lower);
        if above.is_some() || below.is_some() || unmarked {
            let lines: Vec<&Cells> = (first..lower).map(|y| self.from(y, 2)).collect();
            let draft = || self.scrolled_draft(first, "the input frame", (above, below), &lines);
            return match unmarked && below.is_none() {
                true => self.as_pasted(missing(), first, &lines, || draft().cut()),
                false => draft(),
            };
        }
        if let Some(mode) = &frame.placeholder {
            let one_row = lower == first + 1;
            let footer = self
                .lines
                .get(lower + 1)
                .is_some_and(|line| mode.footer.is_match(line));
            let shown = joined(self.from(first, 2));
            let shown = shown.trim_end();
            if one_row && footer && mode.texts.iter().any(|text| names_mode(shown, text)) {
                let place = format!("the input frame at row {}", first + 1);
                return match self.cursor_at(2, first) {
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
            return self.without_model_line(prompt, prompt_at, missing_model());
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
            return self.after_prompt(prompt, end, "the input", None, false);
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
        )
    }

    /// A prompt input whose CLI left its model line out, as one does where a draft does not fit
    /// with it, from row `prompt`: a draft where its last row is the cursor's and holds text, and
    /// only blank rows are under it but for the screen's last, where the CLI keeps its status, and no
    /// menu shows; otherwise `none`. An empty input keeps its model line.
    fn without_model_line(
        &self,
        prompt: usize,
        prompt_at: impl Fn(usize) -> bool,
        none: Reading,
    ) -> Reading {
        let cursor_row = self.cursor.1;
        let under = cursor_row + 1;
        let status = |y: usize| y > under && y + 1 == self.height() && !prompt_at(y);
        let alone = (under..self.height()).all(|y| self.blank(y) || status(y));
        if prompt > cursor_row || self.blank(cursor_row) || !alone {
            return none;
        }
        let lines: Vec<&Cells> = (prompt..under).map(|y| self.from(y, 2)).collect();
        self.as_pasted(none, prompt, &lines, || {
            self.scrolled_draft(prompt, "the input", (None, None), &lines)
        })
    }

    /// `editor`: rows between two rules, with a cursor the CLI draws itself.
    fn in_editor(&self, rule: &Editor) -> Reading {
        let (column, cursor_row) = self.cursor;
        let tallest = (self.height() as f64 * rule.most_share).floor() as usize;
        let tallest = tallest.max(rule.most_rows);
        let upper = (0..cursor_row)
            .rev()
            .find(|&y| rule.upper.is_match(&self.lines[y]));
        let lower = (cursor_row..self.height()).find(|&y| rule.lower.is_match(&self.lines[y]));
        let rules = upper
            .zip(lower)
            .filter(|(upper, lower)| (1..=tallest).contains(&(lower - upper - 1)));
        let Some((upper, lower)) = rules else {
            let none = self.elsewhere(format!(
                "no editor between two rules around the cursor at row {}",
                cursor_row + 1
            ));
            return self.cut_editor(rule, upper, lower, none);
        };
        let place = format!("the editor at {}", row_span(upper + 2, lower));
        if let Some((row, certain)) = self.question_row(&rule.question, upper, lower) {
            return match certain {
                true => reading(
                    InputState::Interaction,
                    format!(
                        "{place} answers a question of the CLI's, as row {} shows",
                        row + 1
                    ),
                ),
                false => unknown(format!(
                    "{place} may answer a question of the CLI's, as row {} may show over its \
                     footer",
                    row + 1
                )),
            };
        }
        if cursor_row == lower || !self.own_cursor(cursor_row, column) {
            return unknown(format!(
                "{place} has no cursor of its own where the cursor is, at row {}",
                cursor_row + 1
            ));
        }
        let lines: Vec<&Cells> = (upper + 1..lower).map(|y| self.row(y)).collect();
        let rest = lines[1..].iter().any(|line| !all_space(line));
        let line = line_of(lines[0], upper + 1, 0, rest, self.cursor);
        self.editor_reading(rule, upper, lower, &lines, &place)
            .with_line(line)
    }

    /// The row that shows that the editor between these rules may answer a question of the CLI's,
    /// and whether it shows that for certain: its keys under it; or, where they are out of sight, the
    /// rule over the question, a blank row, the question and a blank row over it, for certain where
    /// the footer is cut too, as the CLI cuts its footer first. Over a whole footer, an extension's
    /// rows under the question or a footer of more rows may have taken the keys' place, and the CLI's
    /// own input may stand under such rows as well.
    fn question_row(
        &self,
        question: &Question,
        upper: usize,
        lower: usize,
    ) -> Option<(usize, bool)> {
        let shown = |y: usize| y < self.height() && !self.blank(y);
        let keys = lower + 2;
        if !shown(lower + 1) && shown(keys) && question.keys.is_match(&self.lines[keys]) {
            return Some((keys, true));
        }
        // The screen's first row is the transcript's.
        let top = (1..upper)
            .rev()
            .find(|&y| question.top.is_match(&self.lines[y]))?;
        let asked = top + 2 < upper - 1 && !shown(top + 1) && shown(top + 2) && !shown(upper - 1);
        let footer = (1..=question.footer_rows).all(|row| shown(lower + row));
        asked.then_some((top, !footer))
    }

    /// A draft in an editor the screen has no room for, otherwise `none`. The CLI keeps the cursor's
    /// row: it leaves out the rows after it, the lower rule with them, then the rows before it, the
    /// upper rule with them, or the editor's first rows lie above the screen's top. Only the rows that
    /// are the editor's however much was left out are read, and never as an empty input: an empty
    /// editor always has its room.
    fn cut_editor(
        &self,
        rule: &Editor,
        upper: Option<usize>,
        lower: Option<usize>,
        none: Reading,
    ) -> Reading {
        let (column, cursor_row) = self.cursor;
        let under = cursor_row + 1;
        // The editor ends with the cursor's row: over its lower rule, the CLI's footer or the
        // screen's end.
        let ends = match lower {
            Some(lower) => lower == under && upper.is_none(),
            None => under == self.height() || styled_only(self.row(under)),
        };
        let kept = under.saturating_sub(rule.least_rows);
        let upper = upper.filter(|&upper| upper >= kept);
        let first = upper.map_or(kept, |upper| upper + 1);
        let lines: Vec<&Cells> = (first..under).map(|y| self.row(y)).collect();
        let plain = lines
            .iter()
            .all(|line| !line.iter().any(|cell| draws(cell) && styled(cell)));
        if !ends || !plain || !self.own_cursor(cursor_row, column) {
            return none;
        }
        self.as_pasted(none, first, &lines, || {
            let above = match (upper, &rule.scrolled) {
                (Some(upper), Scrolled::Rules(marks)) => counted(&marks.above, &self.lines[upper]),
                _ => None,
            };
            let place = format!("the cut editor at {}", row_span(first + 1, under));
            let rest = lines[1..].iter().any(|line| !all_space(line));
            let line = line_of(lines[0], first, 0, rest, self.cursor);
            let draft = drafted(&place, (above, None), &lines).with_line(line);
            match upper {
                Some(_) => draft,
                None => draft.cut(),
            }
        })
    }

    fn editor_reading(
        &self,
        rule: &Editor,
        upper: usize,
        lower: usize,
        lines: &[&Cells],
        place: &str,
    ) -> Reading {
        let column = self.cursor.0;
        // One row, with the cursor in its first columns and nothing drawn before it.
        let at_start = lines.len() == 1
            && column <= 3
            && !lines[0]
                .iter()
                .any(|cell| cell.column < column && draws(cell));
        if at_start && hint_like(lines[0]) {
            return Reading {
                unsure: true,
                ..unknown(format!(
                    "{place} shows colored text where its input starts, a hint or a draft"
                ))
            };
        }
        if holds_writing(lines) {
            let marks = match &rule.scrolled {
                Scrolled::Rules(marks) => (
                    counted(&marks.above, &self.lines[upper]),
                    counted(&marks.below, &self.lines[lower]),
                ),
                _ => (None, None),
            };
            return drafted(place, marks, lines);
        }
        if lines.len() > 1 || column > 3 {
            return unknown(format!(
                "{place} is empty, but the cursor is not where the input starts"
            ));
        }
        usable(format!("{place} is empty"))
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
        let border = (cursor_row + 1..self.height()).find(|&y| !barred(y));
        // Under the text, a blank box row, then the box's last row over the border. Where the screen
        // ends within the box, the blank row is the last thing looked for.
        let under = cursor_row + 1;
        let pad = match border {
            Some(border) => border.checked_sub(2).filter(|&pad| {
                self.char(border, bar) == rule.corner
                    && self.char(border, bar + 1) == rule.edge
                    && pad > cursor_row
                    && gap(pad)
                    && inside(border - 1)
                    && !all_space(self.from(border - 1, text_from))
            }),
            None => (under == self.height() || gap(under)).then_some(under),
        };
        let Some(pad) = pad else {
            return missing();
        };
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
        let placeholder = lines.len() == 1 && rule.placeholder.is_match(&joined(lines[0]));
        let drafted = || drafted(&place, (None, None), &lines);
        if border.is_none() {
            return match placeholder {
                true => missing(),
                false => self.as_pasted(missing(), top + 1, &lines, drafted),
            };
        }
        let empty = |tail: &str| match lines.len() == 1 && self.cursor_at(text_from, top + 1) {
            true => usable(format!("{place} is empty{tail}")),
            false => unknown(format!(
                "{place} is empty, but the cursor is not where the input starts"
            )),
        };
        if placeholder {
            empty(" but for its placeholder")
        } else if holds_writing(&lines) {
            drafted()
        } else {
            empty("")
        }
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
