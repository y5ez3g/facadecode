//! Reads a CLI's input box from the cells its screen shows. Each reader knows one layout a CLI
//! was recorded drawing. It uses the terminal cursor or a drawn cursor recognized by the rule to
//! find the input box and tell whether it is empty or holds a draft. A menu or question of the
//! CLI's own can read `interaction` when there is no input box. A rule can also recognize a
//! live notice next to its input box as `interaction`. Other unrecognized screens read `unknown`.
//! A reading comes from the screen alone and never means that input may be typed.

mod paste;
mod probe;

use std::borrow::Cow;
use std::ops::Range;

use facade_base::model::{
    agent::WaitKind,
    terminal::{HiddenRows, InputInfo, InputState},
};
use facade_screen::{CursorRowWrites, ScreenView, VisibleCell};
use regex::Regex;
use unicode_normalization::{UnicodeNormalization, is_nfc};

use crate::{
    BoxInput, CountedScroll, Editor, EditorBand, EditorLiveNotice, EditorNoticeContext, EditorRail,
    Frame, InputRule, Menu, MenuLinePattern, Prompt, Question, Scrolled,
};

pub use paste::{
    could_be_paste_prefix, draft_backspace_count, is_full_draft, is_legacy_split_paste,
    is_own_draft, is_own_paste_tail, is_own_recovered_draft, is_paste_placeholder, is_same_draft,
    settle_time, shows_original_text, shows_paste_end, shows_paste_placeholder, shows_whole,
    with_paste_text,
};
pub use probe::{ProbeVerdict, restored, shape_of, space_taken, verdict_of};

/// Canonical composition of terminal text. A cell can hold a base character and combining marks.
pub fn canonical_text(text: &str) -> Cow<'_, str> {
    if is_nfc(text) {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.nfc().collect())
    }
}

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
    /// The byte offset in the cursor's draft row and the row relative to the draft's start.
    pub draft_cursor: Option<(usize, usize)>,
    /// The reason given by a recognized interaction, when the rule knows it.
    pub wait_kind: Option<WaitKind>,
    /// The composer under a working footer, as evidence for an issued submission.
    pub working_editor: Option<InputState>,
    /// Visible text ending at the caret of a full viewport that has no scroll markers.
    /// Only a paste just made into an observed empty input can use it for confirmation.
    pub paste_tail: Option<String>,
    /// The input's first row and the cursor, where the reader found the input.
    pub line: Option<InputLine>,
    /// The visible draft and its logical end were painted during this paste.
    pub paste_drawing: Option<PasteDrawing>,
    /// Unknown because the only input row may be a hint or a draft. A space typed and taken back
    /// tells them apart.
    pub unsure: bool,
}

/// The end of an input the CLI painted during a paste.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PasteDrawing {
    pub final_spaces: usize,
    pub final_line_breaks: usize,
}

impl BoxReading {
    /// A reading without captured input geometry, paste evidence or probe evidence.
    pub fn new(info: InputInfo, draft: Option<String>) -> Self {
        Self {
            info,
            draft,
            draft_cursor: None,
            wait_kind: None,
            working_editor: None,
            paste_tail: None,
            line: None,
            paste_drawing: None,
            unsure: false,
        }
    }

    /// Reads the frame's writes at the caret found by the input rule. A CLI can draw its own
    /// caret in the composer while its hardware cursor stays outside the box.
    pub fn frame_writes(
        &self,
        screen: &facade_screen::Screen,
        terminal_writes: CursorRowWrites,
    ) -> CursorRowWrites {
        self.line
            .as_ref()
            .filter(|line| line.cursor.1 != usize::from(screen.cursor().1))
            .map_or(terminal_writes, |line| {
                screen.frame_row_writes(line.cursor.1)
            })
    }

    /// Joins displayed rows into a logical draft and maps the cursor to a byte offset in it.
    /// Keep the paste's line breaks and the spaces it left at wraps. Ignore horizontal padding
    /// at the very end, including the caret when the CLI draws those final paste spaces.
    /// Otherwise keep the visible text, including placeholder numbers.
    pub fn logical_draft<'a>(&'a self, paste: &'a str) -> Option<(Cow<'a, str>, usize)> {
        if self.draft_hidden().is_some() {
            return None;
        }
        let shown = self.draft.as_deref()?;
        let (byte, row) = self.draft_cursor?;
        let mut lines = shown.split('\n');
        let before = lines.by_ref().take(row).map(str::len).sum::<usize>();
        let line = lines.next()?;
        let text = paste.trim_end_matches([' ', '\t']);
        let padding = paste.len() - text.len();
        let byte = if lines.next().is_none() && byte.saturating_sub(line.len()) <= padding {
            byte.min(line.len())
        } else {
            byte
        };
        if !line.is_char_boundary(byte) {
            return None;
        }
        if let Some(at) = caret_in_paste(shown, (byte, row), text) {
            return Some((Cow::Borrowed(text), at));
        }
        // The cursor is already at a cell boundary. Map its complete prefix along with the
        // rendered rows, keeping the original logical line breaks when the paste aligns.
        let canonical_paste = canonical_text(text);
        let canonical_shown = canonical_text(shown);
        if matches!(canonical_paste, Cow::Owned(_)) || matches!(canonical_shown, Cow::Owned(_)) {
            let prefix = canonical_text(&line[..byte]);
            if canonical_shown
                .split('\n')
                .nth(row)?
                .starts_with(prefix.as_ref())
                && let Some(at) =
                    caret_in_paste(&canonical_shown, (prefix.len(), row), &canonical_paste)
            {
                return Some((canonical_paste, at));
            }
        }
        Some((Cow::Owned(shown.replace('\n', "")), before + byte))
    }

    /// The draft's rows out of sight, for telling a message's own draft: those its CLI marks, as
    /// `info.hidden` gives them, or, where the screen cut the input above its first row without a
    /// mark, one row above at least.
    pub fn draft_hidden(&self) -> Option<HiddenRows> {
        let cut = self.line.as_ref().is_some_and(|line| line.cut);
        (self.info.hidden).or(cut.then_some(HiddenRows { above: 1, below: 0 }))
    }

    /// Whether nothing of the input was read, as in the middle of a frame. It says nothing about what
    /// the input holds.
    pub fn is_unread(&self) -> bool {
        self.info.state == InputState::Unknown && self.line.is_none()
    }
}

fn caret_in_paste(shown: &str, cursor: (usize, usize), paste: &str) -> Option<usize> {
    let mut left = paste;
    let mut caret = None;
    for (row, shown) in shown.split('\n').enumerate() {
        if row != 0 {
            let trimmed = left.trim_start_matches([' ', '\t']);
            if let Some(next) = trimmed
                .strip_prefix("\r\n")
                .or_else(|| trimmed.strip_prefix(['\r', '\n']))
            {
                left = next;
            } else if !left.starts_with(shown) {
                left = trimmed;
            }
        }
        if row == cursor.1 {
            caret = Some(paste.len() - left.len() + cursor.0);
        }
        left = left.strip_prefix(shown)?;
    }
    if left.is_empty() { caret } else { None }
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
    read_box_in_frame(rule, view, untouched_input, BoxPaint::None, None).0
}

/// Reads a cleanup response only where the CLI has painted the displayed input since the write.
pub fn read_box_after_paint(rule: &InputRule, screen: &facade_screen::Screen) -> BoxReading {
    read_box_in_frame(rule, &screen.view(), false, BoxPaint::Cleanup(screen), None).0
}

enum BoxPaint<'a> {
    None,
    Paste(&'a facade_screen::Screen),
    Cleanup(&'a facade_screen::Screen),
}

/// Reads the current frame with any input painting tracked from the paste's write.
pub fn read_box_for_screen(
    rule: &InputRule,
    screen: &facade_screen::Screen,
    untouched_input: bool,
) -> BoxReading {
    read_box_in_frame(
        rule,
        &screen.view(),
        untouched_input,
        paste_paint(screen),
        None,
    )
    .0
}

fn paste_paint(screen: &facade_screen::Screen) -> BoxPaint<'_> {
    if screen.observes_paint() {
        BoxPaint::Paste(screen)
    } else {
        BoxPaint::None
    }
}

/// Reads the input and its redraw evidence using the caller's input boundary. For an interaction,
/// the flag covers the menu anchor. For a complete ordinary frame, it covers the borders, prompt
/// and visible text. The caller observes frames in output order.
pub fn read_box_with_redraw(
    rule: &InputRule,
    screen: &facade_screen::Screen,
    untouched_input: bool,
) -> (BoxReading, bool) {
    read_box_in_frame(
        rule,
        &screen.view(),
        untouched_input,
        paste_paint(screen),
        Some(screen),
    )
}

fn read_box_in_frame(
    rule: &InputRule,
    view: &ScreenView,
    untouched_input: bool,
    paint: BoxPaint<'_>,
    redraw: Option<&facade_screen::Screen>,
) -> (BoxReading, bool) {
    let mut screen = Screen::new(view, rule.menus());
    let mut reading = screen.read(rule, view, untouched_input);
    let cursor = screen.cursor;
    let wrapped_cursor = reading.wrapped_padding_cursor(view, cursor);
    let paste_drawing = match paint {
        BoxPaint::Paste(paint) => reading.paste_drawing(view, paint, cursor),
        BoxPaint::Cleanup(paint) => {
            if !reading.painted(rule, view, paint, wrapped_cursor.is_some(), cursor) {
                reading = unknown("the CLI has not redrawn the input box after the cleanup write");
            }
            None
        }
        BoxPaint::None => None,
    };
    let Reading {
        state,
        evidence,
        hidden,
        draft,
        draft_start,
        wait_kind,
        working_editor,
        paste_tail,
        line,
        unsure,
        redraw_rows,
        ..
    } = reading;
    let info = InputInfo {
        state,
        evidence,
        mechanism: Some(rule.mechanism()),
        hidden,
    };
    let draft_cursor = draft_start.and_then(|(left, top)| {
        if let Some(cursor) = wrapped_cursor {
            return Some(cursor);
        }
        let (column, row) = cursor;
        if column < left
            || (matches!(
                rule,
                InputRule::PromptRow {
                    placeholder: None,
                    ..
                }
            ) && row != top)
        {
            return None;
        }
        let before = view
            .rows
            .get(row)?
            .iter()
            .filter(|cell| (left..column).contains(&cell.column));
        Some((
            before.map(|cell| cell.text().len()).sum(),
            row.checked_sub(top)?,
        ))
    });
    let redrawn = redraw_rows.zip(redraw).is_some_and(|(rows, terminal)| {
        let mut drawn = false;
        for row in rows {
            for cell in screen.row(row).iter().filter(|cell| draws(cell)) {
                if !terminal.frame_printed_cell(row, cell.column) {
                    return false;
                }
                drawn = true;
            }
        }
        drawn
    });
    (
        BoxReading {
            info,
            draft,
            draft_cursor,
            wait_kind,
            working_editor,
            paste_tail,
            line,
            paste_drawing,
            unsure,
        },
        redrawn,
    )
}

/// What a reader found, before the rule's mechanism is added.
struct Reading {
    state: InputState,
    evidence: String,
    hidden: Option<HiddenRows>,
    /// The draft as its rows draw it.
    draft: Option<String>,
    /// Column and row of the first cell of the draft.
    draft_start: Option<(usize, usize)>,
    wait_kind: Option<WaitKind>,
    working_editor: Option<InputState>,
    paste_tail: Option<String>,
    line: Option<InputLine>,
    unsure: bool,
    /// The rows whose printed glyphs can prove the recognized menu or framed composer.
    redraw_rows: Option<Range<usize>>,
}

impl Reading {
    /// A blank soft continuation places the caret in the previous logical line's padding.
    /// A hard line or more text on the continuation has no such position.
    fn wrapped_padding_cursor(
        &self,
        view: &ScreenView,
        (column, row): (usize, usize),
    ) -> Option<(usize, usize)> {
        let ((_, top), draft) = self.draft_start.zip(self.draft.as_deref())?;
        if row <= top || column == 0 {
            return None;
        }
        let mut lines = draft.rsplit('\n');
        let last_line = lines.next()?;
        let last_offset = lines.count();
        let last_row = top + last_offset;
        let continuation = last_row + 1..=row;
        if row <= last_row
            || view.continues.get(row + 1) == Some(&true)
            || !view
                .continues
                .get(continuation.clone())?
                .iter()
                .all(|&wraps| wraps)
            || !view
                .rows
                .get(continuation)?
                .iter()
                .all(|cells| cells.iter().all(|cell| cell.text() == " "))
        {
            return None;
        }
        let trailing_cells = view
            .rows
            .get(last_row)?
            .iter()
            .rev()
            .take_while(|cell| cell.text() == " ")
            .count();
        let padding = trailing_cells + (row - last_row - 1) * view.cols + column;
        Some((last_line.len() + padding, last_offset))
    }

    fn painted(
        &self,
        rule: &InputRule,
        view: &ScreenView,
        screen: &facade_screen::Screen,
        wrapped_padding: bool,
        cursor: (usize, usize),
    ) -> bool {
        match self.state {
            InputState::Draft => {
                let Some(((start, top), draft)) = self.draft_start.zip(self.draft.as_deref())
                else {
                    return false;
                };
                if matches!(
                    rule,
                    InputRule::PromptRow {
                        placeholder: None,
                        ..
                    }
                ) && cursor.1 != top
                    && !wrapped_padding
                {
                    return false;
                }
                draft.split('\n').enumerate().all(|(index, line)| {
                    let row = top + index;
                    let Some(cells) = view.rows.get(row) else {
                        return false;
                    };
                    let mut bytes = line.len();
                    let last = cells
                        .iter()
                        .skip_while(|cell| cell.column < start)
                        .take_while(|cell| {
                            let remains = bytes != 0;
                            bytes = bytes.saturating_sub(cell.text().len());
                            remains
                        })
                        .last();
                    bytes == 0
                        && screen
                            .has_painted(row, start..last.map_or(start, |cell| cell.column) + 1)
                })
            }
            InputState::Usable => {
                let (column, row) = cursor;
                // A bare prompt-row rule can locate its prompt independently of the cursor.
                if let InputRule::PromptRow {
                    prompt,
                    placeholder: None,
                    ..
                } = rule
                    && view
                        .rows
                        .iter()
                        .rposition(|cells| joined(cells).starts_with(prompt))
                        != Some(row)
                {
                    return false;
                }
                screen.has_painted(row, column..column + 1)
            }
            _ => true,
        }
    }

    fn paste_drawing(
        &self,
        view: &ScreenView,
        screen: &facade_screen::Screen,
        cursor: (usize, usize),
    ) -> Option<PasteDrawing> {
        let ((start, top), draft) = self.draft_start.zip(self.draft.as_deref())?;
        let mut end = None;
        for (index, line) in draft.split('\n').enumerate() {
            let row = top + index;
            let cells = view.rows.get(row)?;
            let mut bytes = line.len();
            for cell in cells.iter().skip_while(|cell| cell.column < start) {
                if bytes == 0 {
                    break;
                }
                let text = cell.text();
                bytes = bytes.saturating_sub(text.len());
                // ConPTY can move over blanks between words without printing them. Every glyph
                // still needs paint from this paste. The tail counts printed spaces separately.
                if text != " " {
                    end = Some((cell.column + 1, row, screen.painted_at(row, cell.column)?));
                }
            }
            if bytes != 0
                || (line.is_empty()
                    && screen.line_feed_at(row).is_none()
                    && !screen.has_painted(row, start..start + 1))
            {
                return None;
            }
        }
        painted_paste_end(view, screen, cursor, start, end?)
    }

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
        draft_start: None,
        wait_kind: None,
        working_editor: None,
        paste_tail: None,
        line: None,
        unsure: false,
        redraw_rows: None,
    }
}

fn interaction(evidence: impl Into<String>, anchor: Range<usize>) -> Reading {
    Reading {
        redraw_rows: Some(anchor),
        ..reading(InputState::Interaction, evidence)
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
                text: cell.text().to_owned(),
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
fn drafted(
    place: &str,
    start: (usize, usize),
    marks: (Option<u32>, Option<u32>),
    lines: &[&Cells],
) -> Reading {
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
        draft: Some(draft_text(lines)),
        draft_start: Some(start),
        ..reading(InputState::Draft, format!("{place} holds text{scrolled}"))
    }
}

fn draft_text(lines: &[&Cells]) -> String {
    let mut text = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            text.push('\n');
        }
        text.push_str(joined(line).trim_end());
    }
    text.truncate(text.trim_end().len());
    text
}

/// Counts printed blanks and actual line feeds after the last glyph. Soft wraps join the same
/// logical line. Earlier padding and cursor motion supply neither witness.
fn painted_paste_end(
    view: &ScreenView,
    screen: &facade_screen::Screen,
    cursor: (usize, usize),
    left: usize,
    end: (usize, usize, u32),
) -> Option<PasteDrawing> {
    let (column, row) = cursor;
    let (last_column, last_row, mut after) = end;
    if row < last_row || (row == last_row && column.saturating_add(1) < last_column) {
        return None;
    }
    let mut drawing = PasteDrawing::default();
    let mut beginning = (last_column, last_row);
    for following in last_row + 1..=row {
        if !view.continues.get(following).copied()? {
            after = screen
                .line_feed_at(following)
                .filter(|&order| order > after)?;
            drawing.final_line_breaks += 1;
            beginning = (left, following);
        }
    }
    for current in beginning.1..=row {
        let from = if current == beginning.1 {
            beginning.0
        } else {
            0
        };
        let to = if current == row {
            column + usize::from(cursor == view.cursor && screen.cursor_wrap_pending())
        } else {
            view.cols
        };
        for cell in view
            .rows
            .get(current)?
            .iter()
            .filter(|cell| (from..to).contains(&cell.column))
        {
            let Some(order) = screen
                .printed_space_at(current, cell.column)
                .filter(|&order| order > after)
            else {
                return Some(drawing);
            };
            after = order;
            drawing.final_spaces += 1;
        }
    }
    Some(drawing)
}

fn joined(cells: &Cells) -> String {
    cells.iter().map(VisibleCell::text).collect()
}

/// A cell that draws something other than space.
fn draws(cell: &VisibleCell) -> bool {
    !cell.text().trim().is_empty()
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

/// A complete terminal line and the screen row it starts on.
struct LogicalLine<'a> {
    row: usize,
    text: Cow<'a, str>,
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

    fn read(&mut self, rule: &InputRule, view: &ScreenView, untouched_input: bool) -> Reading {
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
                unready_hint,
                dim_draft,
                ..
            } => match placeholder {
                Some(placeholder) => self.in_prompt_rows(
                    prompt,
                    alternate_prompt.as_deref(),
                    placeholder,
                    unready_hint.as_deref(),
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
            Some(cell) => cell.text(),
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

    fn logical_lines(&self) -> Vec<LogicalLine<'_>> {
        let mut lines: Vec<LogicalLine<'_>> = Vec::with_capacity(self.lines.len());
        for (row, text) in self.lines.iter().enumerate() {
            if self.continues.get(row) == Some(&true) {
                // A continuation at the top begins outside the visible screen.
                if let Some(line) = lines.last_mut() {
                    line.text.to_mut().push_str(text);
                }
            } else {
                lines.push(LogicalLine {
                    row,
                    text: Cow::Borrowed(text),
                });
            }
        }
        lines
    }

    /// The last logical line consumed by a menu pattern starting at `start`.
    fn menu_line_end(
        &self,
        pattern: &MenuLinePattern,
        lines: &[LogicalLine<'_>],
        start: usize,
    ) -> Option<usize> {
        let first = lines.get(start)?.text.as_ref();
        let wrapped = match pattern {
            MenuLinePattern::Regex(regex) => {
                return regex.is_match(first.trim_end_matches(' ')).then_some(start);
            }
            MenuLinePattern::Wrapped(wrapped) => wrapped,
        };
        let prefix = wrapped
            .prefix
            .find(first)
            .filter(|prefix| prefix.start() == 0)?;
        let first_text = first[prefix.end()..].trim_end_matches(' ');
        if first_text.is_empty() && prefix.as_str().trim().is_empty() {
            return None;
        }
        let mut expected = wrapped.text.strip_prefix(first_text)?;
        let mut end = start;
        // The display boundary determines the end, even after consuming the expected text.
        for (index, line) in lines.iter().enumerate().skip(start + 1) {
            let Some((indent, fragment)) = line.text.split_at_checked(wrapped.indent) else {
                break;
            };
            let fragment = fragment.trim_end_matches(' ');
            if fragment.is_empty()
                || indent.bytes().any(|byte| byte != b' ')
                || wrapped.stop_at_dim && self.dim_line(lines, index)
            {
                break;
            }
            // Word wrapping omits the space at a word boundary and can also split a word.
            expected = expected
                .strip_prefix(' ')
                .unwrap_or(expected)
                .strip_prefix(fragment)?;
            end = index;
        }
        expected.is_empty().then_some(end)
    }

    /// Every drawn cell of this logical line is dim, including its terminal continuations.
    fn dim_line(&self, lines: &[LogicalLine<'_>], index: usize) -> bool {
        let start = lines[index].row;
        let end = lines
            .get(index + 1)
            .map_or(self.cells.len(), |line| line.row);
        self.cells[start..end]
            .iter()
            .flatten()
            .filter(|cell| draws(cell))
            .all(|cell| cell.dim)
    }

    /// All screen rows of a menu or question's anchor, including continuations.
    fn menu_rows(&self, menu: &Menu, lines: &[LogicalLine<'_>]) -> Option<Range<usize>> {
        lines.iter().enumerate().find_map(|(start, line)| {
            let end = self.menu_line_end(&menu.selected, lines, start)?;
            if let Some(not) = &menu.not_selected
                && not.is_match(line.text.trim_end_matches(' '))
            {
                return None;
            }
            let after = end + 1;
            let next_fits = menu
                .next
                .as_ref()
                .is_none_or(|next| self.menu_line_end(next, lines, after).is_some());
            let hint_fits = menu.hint.as_ref().is_none_or(|hint| {
                (after..lines.len())
                    .take(hint.within)
                    .any(|start| self.menu_line_end(&hint.pattern, lines, start).is_some())
            });
            (next_fits && hint_fits)
                .then(|| line.row..lines.get(after).map_or(self.height(), |line| line.row))
        })
    }

    /// No input box where the cursor is, because of `why`: `interaction` while a menu or question
    /// of the CLI's own shows, otherwise `unknown`.
    fn elsewhere(&self, why: impl Into<String>) -> Reading {
        let why = why.into();
        if self.menus.is_empty() {
            return unknown(why);
        }
        let lines = self.logical_lines();
        for menu in self.menus {
            let Some(anchor) = self.menu_rows(menu, &lines) else {
                continue;
            };
            let what = match (&menu.selected, &menu.next) {
                (MenuLinePattern::Wrapped(_), _) => "a menu",
                (_, Some(_)) => "a menu's selected item",
                (_, None) => "a question",
            };
            return interaction(
                format!("{why}; the CLI shows {what} at row {}", anchor.start + 1),
                anchor,
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
            return drafted(
                &place,
                (column, prompt + from),
                (above, below),
                &lines[from..to],
            );
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
        drafted(&place, (column, first), marks, lines).with_line(line_of(
            lines[0],
            first,
            column,
            rest,
            self.cursor,
        ))
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
        // Up from the cursor over wrapped rows to the prompt, or to the upper rule over a draft that
        // scrolled.
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
        if first > cursor_row {
            return missing();
        }
        let upper_at = frame.upper.is_match(&self.lines[upper]);
        let prompt_in_frame = upper_at && prompt_at(first);
        let above = rule_marks.and_then(|marks| counted(&marks.above, &self.lines[upper]));
        // A complete frame must identify both rules and its prompt when the CLI hides the caret.
        let unmarked = !hidden_hardware_caret
            && frame.scrolls_unmarked
            && above.is_none()
            && upper_at
            && !prompt_in_frame;
        if !(prompt_in_frame || !hidden_hardware_caret && (above.is_some() || unmarked)) {
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
        if above.is_some() || below.is_some() || unmarked {
            let lines: Vec<&Cells> = (first..lower).map(|y| self.from(y, column)).collect();
            let draft =
                || self.scrolled_draft(first, "the input frame", (above, below), &lines, column);
            return match unmarked && below.is_none() {
                true => self.as_pasted(missing(), first, &lines, || draft().cut()),
                false => draft(),
            };
        }
        let framed = |reading: Reading| Reading {
            redraw_rows: matches!(reading.state, InputState::Usable | InputState::Draft)
                .then_some(upper..lower + 1),
            ..reading
        };
        if let Some(hint) = &frame.dim_cursor_hint
            && lower == first + 1
            && self.cursor_at(column, first)
        {
            let cells = self.from(first, column);
            let dim_after_cursor = cells.split_first().is_some_and(|(cursor, rest)| {
                cursor.column == column
                    && cursor.inverse
                    && draws(cursor)
                    && rest
                        .iter()
                        .all(|cell| !draws(cell) || cell.dim && !cell.inverse)
            });
            if dim_after_cursor && joined(cells).trim_end() == hint.as_str() {
                let line = line_of(self.row(first), first, column, false, self.cursor);
                return framed(
                    usable(format!(
                        "the input frame at row {} shows its dim hint",
                        first + 1
                    ))
                    .with_line(line),
                );
            }
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
                return framed(match self.cursor_at(column, first) {
                    true => usable(format!(
                        "{place} shows its mode placeholder above its empty-input footer"
                    )),
                    false => unknown(format!(
                        "{place} shows its mode placeholder, but the cursor is not where the \
                         input starts"
                    )),
                });
            }
        }
        let input = self.after_prompt(
            first,
            lower,
            "the input frame",
            row_marks,
            untouched_input && frame.probe_unstyled_hint,
            column,
        );
        let waiting = &frame.waiting_above;
        if (input.unsure || input.state == InputState::Usable)
            && !waiting.is_empty()
            && let Some(start) = upper.checked_sub(waiting.len())
            && self
                .continues
                .get(start..=upper)
                .is_some_and(|rows| rows.iter().all(|&wrapped| !wrapped))
            && waiting
                .iter()
                .zip(&self.lines[start..upper])
                .all(|(pattern, row)| pattern.is_match(row.trim_end_matches(' ')))
        {
            return unknown("the CLI is still preparing the input frame");
        }
        framed(input)
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
                let has_hint = rule
                    .wrapped_footer_hint
                    .as_ref()
                    .is_some_and(|hint| hint.is_match(self.lines[bottom].trim_end()));
                let footer_end = bottom + usize::from(!has_hint);
                // A draft can hide the hint. The colored model label still anchors the footer.
                (0..footer_end)
                    .rev()
                    .take_while(|&y| self.wrapped(y) && !self.blank(y))
                    .last()
                    .filter(|&y| {
                        model_at(y)
                            && self.blank(y - 1)
                            && (has_hint || self.row(y).get(2).is_some_and(|cell| cell.colored))
                    })
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
                .is_some_and(|cell| cell.column + 1 == self.cols && cell.dim && cell.text() == mark)
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
            self.scrolled_draft(prompt, "the input", (None, None), &lines, 2)
        })
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
            let none = self.elsewhere(format!(
                "no editor between two rules around the cursor at row {}",
                cursor_row + 1
            ));
            return self.cut_editor(rule, upper, lower, none);
        };
        let place = format!("the editor at {}", row_span(upper + 2, lower));
        if let Some(question) = &rule.question
            && let Some((row, certain)) = self.question_row(question, upper, lower)
        {
            return match certain {
                true => interaction(
                    format!(
                        "{place} answers a question of the CLI's, as row {} shows",
                        row + 1
                    ),
                    row..row + 1,
                ),
                false => unknown(format!(
                    "{place} may answer a question of the CLI's, as row {} may show over its \
                     footer",
                    row + 1
                )),
            };
        }
        let cursor_in_editor =
            self.own_cursor(cursor_row, column) || (rule.hardware_cursor && cursor_visible);
        if cursor_row == lower || !cursor_in_editor {
            return unknown(format!(
                "{place} has no cursor of its own where the cursor is, at row {}",
                cursor_row + 1
            ));
        }
        if self.editor_is_provisioning(rule, upper) {
            return unknown(format!("the CLI is still provisioning tools above {place}"));
        }
        let lines: Vec<&Cells> = (upper + 1..lower).map(|y| self.row(y)).collect();
        if limit == Some(lines.len()) {
            let at = self
                .row(cursor_row)
                .partition_point(|cell| cell.column < column);
            return self.full_editor(lower, at, lines, &place);
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

    fn editor_is_provisioning(&self, rule: &Editor, upper: usize) -> bool {
        // The CLI keeps the notices in its transcript. The newest notice for each tool
        // says whether it is still downloading.
        rule.provisioning.iter().any(|tool| {
            (0..upper).rev().find_map(|row| {
                let text = self.lines[row].trim_end_matches(' ');
                if self.continues[row] || !text.starts_with(' ') {
                    return None;
                }
                if tool.finished.is_match(text) {
                    return Some(false);
                }
                (tool.downloading.is_match(text)
                    && self
                        .row(row)
                        .iter()
                        .filter(|cell| draws(cell))
                        .all(|cell| cell.dim || cell.colored))
                .then_some(true)
            }) == Some(true)
        })
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

        // The rail can also enclose shell input, so both layouts need a recognized mode footer.
        let Some(footer) = self.lines.get(lower + 1) else {
            return missing();
        };
        let interactive = rail.footer.is_match(footer);
        if !interactive
            && rail
                .working_footer
                .as_ref()
                .is_none_or(|pattern| !pattern.is_match(footer))
        {
            return missing();
        }
        if footer.split(" · ").any(|segment| {
            matches!(
                segment.trim(),
                "Shell" | "Plan" | "Autopilot" | "Autopilot (limited)" | "esc exit shell mode"
            )
        }) {
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
        let notice = rail
            .live_notice
            .as_ref()
            .filter(|notice| self.editor_live_notice(notice, upper));
        if !interactive {
            let mut reading = missing();
            if reading.state == InputState::Unknown && notice.is_none() {
                reading.working_editor = if lines.iter().any(|line| !all_space(line)) {
                    Some(InputState::Draft)
                } else if lines.len() == 1 && column == start {
                    Some(InputState::Usable)
                } else {
                    None
                };
            }
            return reading;
        }
        if let Some(notice) = notice {
            return Reading {
                wait_kind: notice.wait_kind,
                ..reading(
                    InputState::Interaction,
                    format!("the CLI shows a live notice above {place}"),
                )
            };
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
        let last = cells.iter().rposition(|cell| cell.text() != " ")?;
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
                return true;
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
                cell.column == 0 && cell.text() == "┃" && cell.colored && self.char(row, 1) == " "
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
                        && cell.text() == if column == 0 { glyph } else { fill }
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
                    .all(|(column, cell)| cell.column == column && cell.text() == " ")
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
            .skip_while(|cell| cell.text() != " ")
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
                gutter.len() != start
                    || !gutter.iter().all(|cell| cell.colored && cell.text() == " ")
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
            reading.paste_tail = Some(draft_text(&lines));
        }
        reading
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
        let Some(least_rows) = rule.least_rows else {
            return none;
        };
        let under = cursor_row + 1;
        // The editor ends with the cursor's row: over its lower rule, the CLI's footer or the
        // screen's end.
        let ends = match lower {
            Some(lower) => lower == under && upper.is_none(),
            None => under == self.height() || styled_only(self.row(under)),
        };
        let kept = under.saturating_sub(least_rows);
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
            let draft = drafted(&place, (0, first), (above, None), &lines).with_line(line);
            match upper {
                Some(_) => draft,
                None => draft.cut(),
            }
        })
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
            drafted(place, (start, first), marks, lines)
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
        let drafted = || drafted(&place, (text_from, top + 1), (None, None), &lines);
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
        unready_hint: Option<&Regex>,
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
        if y + 1 == end
            && self.cursor_at(start, y)
            && unready_hint.is_some_and(|pattern| pattern.is_match(joined(first).trim()))
            && hint_like(first)
        {
            return unknown(format!(
                "the prompt at row {} shows a hint while its input is unavailable",
                y + 1
            ));
        }
        if y + 1 == end && dim_draft.is_some_and(|pattern| pattern.is_match(joined(first).trim())) {
            let place = format!("the prompt at row {}", y + 1);
            return drafted(&place, (start, y), (None, None), &[first]).with_line(line_of(
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
        let tail = &self.lines[y][prompt.len()..];
        let typed = tail.trim();
        if typed.is_empty() {
            return usable(format!("{place} is empty"));
        }
        let start = self.lines[y].len() - tail.trim_start().len();
        let mut bytes = 0;
        let column = self.row(y).iter().find(|cell| {
            let at = bytes;
            bytes += cell.text().len();
            at == start
        });
        let draft_start = column.map(|cell| (cell.column, y));
        let reading = Reading {
            draft: Some(typed.to_owned()),
            draft_start,
            ..reading(InputState::Draft, format!("{place} holds text"))
        };
        if let Some((start, _)) = draft_start {
            reading.with_line(line_of(self.row(y), y, start, false, self.cursor))
        } else {
            reading
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
