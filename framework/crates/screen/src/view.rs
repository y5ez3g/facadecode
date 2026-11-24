//! What the screen shows right now, cell by cell: enough to find a CLI's input box and state.

use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

use crate::Screen;
use crate::read::{cell_text, is_spacer, wraps};

/// A cell as drawn. A wide character spans two columns, and its spacer is not listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisibleCell {
    /// What the cell draws, combining characters included; a space when empty.
    pub text: String,
    /// The cell's first column.
    pub column: usize,
    pub bold: bool,
    pub dim: bool,
    pub inverse: bool,
    /// The foreground is not the default one.
    pub colored: bool,
}

/// The screen as drawn, with the cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenView {
    /// Each visible row's cells, from the top.
    pub rows: Vec<Vec<VisibleCell>>,
    /// How many columns the screen has.
    pub cols: usize,
    /// For each visible row, whether the row above wrapped into it; for the top row, that can be
    /// a scrollback row.
    pub continues: Vec<bool>,
    /// Column and row.
    pub cursor: (usize, usize),
    /// Whether the cursor is shown.
    pub cursor_visible: bool,
    /// Whether a synchronized update is open, so that the rows are still the previous frame.
    pub synchronized_update: bool,
}

fn visible_cells(row: &Row<Cell>, cols: usize) -> Vec<VisibleCell> {
    let mut cells = Vec::with_capacity(cols);
    for column in 0..cols {
        let cell = &row[Column(column)];
        if is_spacer(cell) {
            continue;
        }
        let flagged = |flag| cell.flags.contains(flag);
        cells.push(VisibleCell {
            text: cell_text(cell),
            column,
            bold: flagged(Flags::BOLD),
            dim: flagged(Flags::DIM),
            inverse: flagged(Flags::INVERSE),
            colored: cell.fg != Color::Named(NamedColor::Foreground),
        });
    }
    cells
}

impl Screen {
    /// The visible rows with how their cells are drawn, and the cursor.
    pub fn view(&self) -> ScreenView {
        let grid = self.terminal.grid();
        let (cols, height) = (grid.columns(), grid.screen_lines() as i32);
        let oldest = -(grid.history_size() as i32);
        let mut rows = Vec::new();
        let mut continues = Vec::new();
        for line in 0..height {
            rows.push(visible_cells(&grid[Line(line)], cols));
            continues.push(line > oldest && wraps(&grid[Line(line - 1)], cols));
        }
        let (column, row) = self.cursor();
        ScreenView {
            rows,
            cols,
            continues,
            cursor: (column.into(), row.into()),
            cursor_visible: self.terminal.has(TermMode::SHOW_CURSOR),
            synchronized_update: self.synchronized_update_deadline().is_some(),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::Screen;

    #[test]
    fn a_view_shows_cells_by_column_with_their_attributes_and_the_cursor() {
        let mut screen = Screen::new(10, 3, 0);
        screen.feed("a\x1b[2mb\x1b[0;7mc\x1b[0;31md\x1b[0m你e\r\n\x1b[?25l".as_bytes());
        let view = screen.view();
        let first: Vec<(&str, usize, bool, bool, bool)> = view.rows[0]
            .iter()
            .take(6)
            .map(|cell| {
                (
                    cell.text.as_str(),
                    cell.column,
                    cell.dim,
                    cell.inverse,
                    cell.colored,
                )
            })
            .collect();
        assert_eq!(
            first,
            [
                ("a", 0, false, false, false),
                ("b", 1, true, false, false),
                ("c", 2, false, true, false),
                ("d", 3, false, false, true),
                ("你", 4, false, false, false),
                ("e", 6, false, false, false)
            ],
            "the wide character's spacer is left out and the next cell keeps its column"
        );
        assert_eq!(view.rows[0].len(), 9, "ten columns less one spacer");
        assert_eq!(
            (view.cursor, view.cursor_visible, view.synchronized_update),
            ((0, 1), false, false)
        );
        assert_eq!((view.cols, view.continues), (10, vec![false, false, false]));
        screen.feed(b"\x1b[?25h\x1b[?2026hhidden");
        let view = screen.view();
        assert!(view.cursor_visible && view.synchronized_update);
        assert!(
            view.rows[1].iter().all(|cell| cell.text == " "),
            "an open synchronized update shows the frame before it"
        );
    }

    #[test]
    fn a_view_marks_each_row_that_continues_a_wrapped_one_even_above_the_screen() {
        let mut screen = Screen::new(4, 2, 10);
        screen.feed(b"abcdefgh");
        assert_eq!(screen.view().continues, [false, true]);
        screen.feed(b"ij");
        assert_eq!(
            screen.view().continues,
            [true, true],
            "the first row continues the row scrolled out above"
        );
        screen.feed(b"\r\nkl");
        assert_eq!(screen.view().continues, [true, false]);
        screen.feed(b"\x1b[?1049h");
        assert_eq!(
            screen.view().continues,
            [false, false],
            "the alternate screen has no rows above it"
        );
    }
}
