//! Styled viewport rows held for mouse selection and copying.

use std::ops::Range;

use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::index::Column;
use alacritty_terminal::term::cell::{Cell, Flags};

use crate::Screen;
use crate::read::{cell_text, is_spacer, wraps};
use crate::redraw::{HELD_VIEW_START, RESET_PEN, write_positioned_row};

/// A capture of one viewport, including its cell styles and soft wraps.
pub struct SelectionView {
    cols: usize,
    rows: Vec<Row<Cell>>,
}

impl Screen {
    /// Captures one viewport at the same readable offset as [`Self::redraw_scrollback_view`].
    pub fn selection_view(&self, offset: usize) -> SelectionView {
        let rows = self.readable_rows();
        let first = rows.viewport_start(offset);
        let viewport = first..first + rows.grid.screen_lines();
        SelectionView {
            cols: rows.grid.columns(),
            rows: viewport
                .map(|line| rows.with_row(line, Clone::clone))
                .collect(),
        }
    }
}

impl SelectionView {
    /// Paints the captured rows at the top left of the selected host buffer and clears its margins.
    /// Optional selection endpoints are inclusive one-based `(column, row)` coordinates inside the
    /// grid. The cursor is hidden and the host retains its input modes.
    pub fn redraw(&self, selected: Option<[(u16, u16); 2]>) -> Vec<u8> {
        let mut out = HELD_VIEW_START.to_vec();
        let selection = selected.map(SelectionRange::new);
        for (line, row) in self.rows.iter().enumerate() {
            let highlighted = selection
                .as_ref()
                .map_or(0..0, |range| range.columns(line, row, self.cols));
            write_positioned_row(&mut out, line, row, self.cols, highlighted);
        }
        out.extend_from_slice(RESET_PEN);
        out
    }

    /// Copies the inclusive stream selection between two one-based `(column, row)` endpoints
    /// inside the grid, without the blanks at the end of a line. A soft wrap joins adjacent rows in
    /// the text.
    pub fn text(&self, anchor: (u16, u16), end: (u16, u16)) -> String {
        let selection = SelectionRange::new([anchor, end]);
        let mut text = String::new();
        for line in selection.start.0..=selection.end.0 {
            let row = &self.rows[line];
            for column in selection.columns(line, row, self.cols) {
                let cell = &row[Column(column)];
                if is_spacer(cell) {
                    continue;
                }
                text.push_str(cell_text(cell).as_str());
            }
            if !wraps(row, self.cols) {
                text.truncate(text.trim_end_matches(' ').len());
                if line < selection.end.0 {
                    text.push('\n');
                }
            }
        }
        text
    }
}

/// Inclusive endpoints in row order, as zero-based `(row, column)` pairs.
struct SelectionRange {
    start: (usize, usize),
    end: (usize, usize),
}

impl SelectionRange {
    fn new(endpoints: [(u16, u16); 2]) -> Self {
        let [first, last] =
            endpoints.map(|(col, row)| (usize::from(row) - 1, usize::from(col) - 1));
        Self {
            start: first.min(last),
            end: first.max(last),
        }
    }

    fn columns(&self, line: usize, row: &Row<Cell>, cols: usize) -> Range<usize> {
        if !(self.start.0..=self.end.0).contains(&line) {
            return 0..0;
        }
        let mut start = if line == self.start.0 {
            self.start.1
        } else {
            0
        };
        let end = if line == self.end.0 {
            self.end.1 + 1
        } else {
            cols
        };
        // A selection beginning on the second column of a wide character includes its first.
        if row[Column(start)].flags.contains(Flags::WIDE_CHAR_SPACER) {
            start = start.saturating_sub(1);
        }
        start..end
    }
}
