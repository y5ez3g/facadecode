//! Reads a CLI's input box from the cells its screen shows. Each reader knows one layout a CLI
//! was recorded drawing: it finds the input box around the cursor, then tells whether the box is
//! empty, holds a draft, or gives way to a menu or question of the CLI's own. Any other screen
//! reads `unknown`. A reading comes from the screen alone and never means that input may be typed.

mod paste;

use facade_base::daemon::{HiddenRows, InputInfo, InputState};
use facade_screen::{ScreenView, VisibleCell};
use regex::Regex;

use crate::{BoxInput, Editor, Frame, InputRule, Menu, Prompt, Scrolled};

pub use paste::{is_own_draft, is_same_draft, settle_time, with_paste_text};

/// Reads the input box `rule` describes from `view`. Never waits. An open synchronized update, a
/// cursor off the screen, or a hidden terminal cursor where the CLI draws no cursor of its own
/// reads `unknown`; behind a hidden cursor, a menu or question of the CLI's own reads
/// `interaction`.
pub fn read_input(rule: &InputRule, view: &ScreenView) -> InputInfo {
    read_draft(rule, view).0
}

/// Reads the input box as [`read_input`] does, with a draft's text as its rows draw it: each row
/// after the input's margin, without trailing spaces, one line per row; for a CLI that shows a
/// long paste as a placeholder, that placeholder. The rows that mark a draft scrolled are left out.
/// A draft whose rows the reader cannot tell apart has no text. The text stays inside Facade:
/// inspect never shows it and nothing saves it.
pub fn read_draft(rule: &InputRule, view: &ScreenView) -> (InputInfo, Option<String>) {
    let screen = Screen::new(view, rule.menus());
    let Reading {
        state,
        evidence,
        hidden,
        draft,
    } = screen.read(rule, view);
    let info = InputInfo {
        state,
        evidence,
        mechanism: Some(rule.mechanism()),
        hidden,
    };
    (info, draft)
}

/// What a reader found, before the rule's mechanism is added.
struct Reading {
    state: InputState,
    evidence: String,
    hidden: Option<HiddenRows>,
    /// The draft as its rows draw it.
    draft: Option<String>,
}

fn reading(state: InputState, evidence: impl Into<String>) -> Reading {
    Reading {
        state,
        evidence: evidence.into(),
        hidden: None,
        draft: None,
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

/// Text a person or the CLI wrote, as opposed to a dim placeholder.
fn written(cell: &VisibleCell) -> bool {
    draws(cell) && !cell.dim
}

fn holds_writing(lines: &[&Cells]) -> bool {
    lines.iter().any(|line| line.iter().any(written))
}

/// Dim and coloured text only, with some coloured: a hint some CLIs draw where their input starts,
/// which a coloured draft looks just like.
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
            lines: view.rows.iter().map(|row| joined(row)).collect(),
            cursor: view.cursor,
            menus,
        }
    }

    fn read(&self, rule: &InputRule, view: &ScreenView) -> Reading {
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
            InputRule::Frame(frame) => self.in_frame(frame),
            InputRule::Prompt(prompt) => self.over_model_line(prompt),
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

    /// The input box that starts on row `prompt`, after the prompt and its gap, and ends before
    /// row `end`. Written text anywhere is a draft; at most a dim placeholder on the prompt row,
    /// with the cursor where the input starts, is empty.
    fn after_prompt(&self, prompt: usize, end: usize, what: &str, scrolled: &Scrolled) -> Reading {
        let place = format!("{what} at {}", row_span(prompt + 1, end));
        // Wrapped rows start under the prompt's two columns.
        let lines: Vec<&Cells> = (prompt..end).map(|y| self.from(y, 2)).collect();
        let first = self.from(prompt, 2);
        let rest_blank = (prompt + 1..end).all(|y| self.blank(y));
        let at_start = self.cursor_at(2, prompt);
        if at_start && rest_blank && hint_like(first) {
            return unknown(format!(
                "{place} shows coloured text where its input starts, which can be a hint or a draft"
            ));
        }
        if holds_writing(&[first]) || (prompt + 1..end).any(|y| holds_writing(&[self.row(y)])) {
            let mark = |line: &Cells, pattern: &Regex| match lines.len() {
                1 => None,
                _ => counted(pattern, joined(line).trim()),
            };
            let above = mark(lines[0], &scrolled.above);
            let below = mark(lines[lines.len() - 1], &scrolled.below);
            let from = usize::from(above.is_some());
            let to = lines.len() - usize::from(below.is_some());
            return drafted(&place, (above, below), &lines[from..to]);
        }
        if !rest_blank {
            return unknown(format!(
                "{place} holds dim text under its prompt row, which is no placeholder"
            ));
        }
        if !at_start {
            return unknown(format!(
                "{place} is empty, but the cursor is not where the input starts"
            ));
        }
        match all_space(first) {
            true => usable(format!("{place} is empty")),
            false => usable(format!("{place} is empty but for its dim placeholder")),
        }
    }

    /// `frame`: a prompt row between two rules.
    fn in_frame(&self, frame: &Frame) -> Reading {
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
        // Up from the cursor over wrapped rows to the prompt row, with the upper rule above it.
        let prompt = (0..=cursor_row)
            .rev()
            .find(|&y| prompt_at(y) || !self.wrapped(y))
            .filter(|&y| prompt_at(y) && y > 0 && frame.upper.is_match(&self.lines[y - 1]));
        let Some(prompt) = prompt else {
            return missing();
        };
        // Down over wrapped rows to the lower rule.
        let lower_at = |y: usize| frame.lower.is_match(&self.lines[y]);
        let lower = (prompt + 1..self.height())
            .find(|&y| lower_at(y) || !self.wrapped(y))
            .filter(|&y| lower_at(y));
        let Some(lower) = lower else {
            return missing();
        };
        if let Some(mode) = &frame.placeholder {
            let one_row = lower == prompt + 1;
            let footer = self
                .lines
                .get(lower + 1)
                .is_some_and(|line| mode.footer.is_match(line));
            let shown = joined(self.from(prompt, 2));
            let shown = shown.trim_end();
            if one_row && footer && mode.texts.iter().any(|text| names_mode(shown, text)) {
                let place = format!("the input frame at row {}", prompt + 1);
                return match self.cursor_at(2, prompt) {
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
        self.after_prompt(prompt, lower, "the input frame", &frame.scrolled)
    }

    /// `prompt`: a prompt row above a model line at the bottom.
    fn over_model_line(&self, rule: &Prompt) -> Reading {
        let cursor_row = self.cursor.1;
        let Some(bottom) = (0..self.height()).rev().find(|&y| !self.blank(y)) else {
            return self.elsewhere("no model line with a blank row above it at the bottom");
        };
        let model = [Some(bottom), bottom.checked_sub(1)]
            .into_iter()
            .flatten()
            .find(|&y| y >= 2 && rule.model_line.is_match(&self.lines[y]))
            .filter(|&y| self.blank(y - 1));
        let Some(model) = model else {
            return self.elsewhere("no model line with a blank row above it at the bottom");
        };
        // The input ends at the blank row above the model line.
        let end = model - 1;
        let prompt_at = |y: usize| self.char(y, 0) == rule.prompt && self.char(y, 1) == " ";
        let start = cursor_row.min(end.saturating_sub(1));
        let prompt = (0..=start)
            .rev()
            .find(|&y| prompt_at(y) || !(self.wrapped(y) || self.blank(y)))
            .filter(|&y| prompt_at(y));
        let Some(prompt) = prompt else {
            return self.elsewhere("no prompt row above the cursor in the input");
        };
        if !(prompt..end).contains(&cursor_row) {
            return self.elsewhere(format!(
                "the cursor at row {} is not in the input above the model line",
                cursor_row + 1
            ));
        }
        let stranger = (cursor_row + 1..end).find(|&y| !self.wrapped(y) && !self.blank(y));
        if let Some(y) = stranger {
            return self.elsewhere(format!(
                "row {} under the cursor is not part of the input",
                y + 1
            ));
        }
        self.after_prompt(prompt, end, "the input", &rule.scrolled)
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
            return self.elsewhere(format!(
                "no editor between two rules around the cursor at row {}",
                cursor_row + 1
            ));
        };
        let place = format!("the editor at {}", row_span(upper + 2, lower));
        if cursor_row == lower || !self.own_cursor(cursor_row, column) {
            return unknown(format!(
                "{place} has no cursor of its own where the cursor is, at row {}",
                cursor_row + 1
            ));
        }
        let lines: Vec<&Cells> = (upper + 1..lower).map(|y| self.row(y)).collect();
        // One row, with the cursor in its first columns and nothing drawn before it.
        let at_start = lines.len() == 1
            && column <= 3
            && !lines[0]
                .iter()
                .any(|cell| cell.column < column && draws(cell));
        if at_start && hint_like(lines[0]) {
            return unknown(format!(
                "{place} shows coloured text where its input starts, which can be a hint or a draft"
            ));
        }
        if holds_writing(&lines) {
            let marks = (
                counted(&rule.above, &self.lines[upper]),
                counted(&rule.below, &self.lines[lower]),
            );
            return drafted(&place, marks, &lines);
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
        let text_from = bar + 3;
        // A row that starts with the bar.
        let barred = |y: usize| self.char(y, bar) == rule.bar && all_space(&self.row(y)[..bar]);
        // A row of the box: the bar, then two blank columns.
        let inside =
            |y: usize| barred(y) && self.char(y, bar + 1) == " " && self.char(y, bar + 2) == " ";
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
