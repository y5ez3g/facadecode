//! Reading lines of text from the screen and its scrollback. Rows that wrap make one line.

use std::cell::RefCell;
use std::ops::Range;
use std::sync::MutexGuard;

use alacritty_terminal::grid::{Dimensions, Grid, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

use crate::Screen;
use crate::compact::{CARRIES, SHOWS, WRAPPED, carries, shows};
use crate::store::{Store, lock};

/// The readable retained primary rows in one Screen's current coordinate system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrimaryHistory {
    /// Changes when primary history is cleared or the canonical grid is resized.
    pub epoch: u64,
    /// Half-open source positions ending at the top of the primary viewport.
    pub rows: Range<usize>,
}

/// The last lines of the screen and scrollback as a reader is shown them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    /// The lines, separated by line feeds. `[[`…`]]` wraps inverse cells and `{{`…`}}` dim ones,
    /// the inverse marks outermost; a backslash goes before every backslash, bracket and brace that
    /// is the screen's own.
    pub text: String,
    /// The number of lines in `text`.
    pub lines: usize,
    /// Whether these are the alternate screen's lines.
    pub alternate: bool,
    /// Whether anything shows above the lines read.
    pub older: bool,
    /// Whether rows scrolled out of the scrollback for good: more scrolled into it than it keeps.
    pub trimmed: bool,
}

/// What a reader is shown of a cell.
struct Glyph {
    text: String,
    inverse: bool,
    dim: bool,
}

impl Glyph {
    /// Whether nothing shows: whitespace, not inverse.
    fn is_blank(&self) -> bool {
        self.text.trim().is_empty() && !self.inverse
    }
}

/// The text a cell draws: its character and any combining ones.
pub(crate) fn cell_text(cell: &Cell) -> String {
    let combining = cell.zerowidth().unwrap_or_default();
    std::iter::once(&cell.c).chain(combining).collect()
}

/// Whether `cell` only holds room for the wide character before or after it.
pub(crate) fn is_spacer(cell: &Cell) -> bool {
    let spacers = Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER;
    cell.flags.intersects(spacers)
}

/// Whether `cell` draws nothing at all: a plain space on the default background, without
/// inverse, underline, strikeout or hyperlink.
pub(crate) fn is_blank(cell: &Cell) -> bool {
    let drawing = Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT;
    let plain = cell.c == ' ' && cell.zerowidth().is_none() && cell.hyperlink().is_none();
    plain && !cell.flags.intersects(drawing) && cell.bg == Color::Named(NamedColor::Background)
}

/// Whether `row`, `cols` wide, wraps onto the row below.
pub(crate) fn wraps(row: &Row<Cell>, cols: usize) -> bool {
    row[Column(cols - 1)].flags.contains(Flags::WRAPLINE)
}

fn glyphs(row: &Row<Cell>, cols: usize) -> Vec<Glyph> {
    let cells = (0..cols)
        .map(|x| &row[Column(x)])
        .filter(|cell| !is_spacer(cell));
    let glyph = |cell: &Cell| Glyph {
        text: cell_text(cell),
        inverse: cell.flags.contains(Flags::INVERSE),
        dim: cell.flags.contains(Flags::DIM),
    };
    cells.map(glyph).collect()
}

/// Appends `glyphs` to `text`, marking inverse and dim runs and escaping the marks' characters.
fn write_marked(text: &mut String, glyphs: &[Glyph]) {
    for run in glyphs.chunk_by(|a, b| a.inverse == b.inverse && a.dim == b.dim) {
        let (open, close) = match (run[0].inverse, run[0].dim) {
            (true, true) => ("[[{{", "}}]]"),
            (true, false) => ("[[", "]]"),
            (false, true) => ("{{", "}}"),
            (false, false) => ("", ""),
        };
        text.push_str(open);
        for c in run.iter().flat_map(|glyph| glyph.text.chars()) {
            if "\\[]{}".contains(c) {
                text.push('\\');
            }
            text.push(c);
        }
        text.push_str(close);
    }
}

impl Screen {
    /// The one-based last physical row with content in the active viewport, or zero if blank.
    pub fn occupied_rows(&self) -> u16 {
        let grid = self.terminal.grid();
        (1..=self.rows())
            .rfind(|&row| {
                let line = Line(i32::from(row) - 1);
                (&grid[line]).into_iter().any(|cell| !is_blank(cell))
            })
            .unwrap_or(0)
    }

    /// The active grid's readable scrollback positions, ending at the top of the live viewport.
    /// The compact store counts the rows dropped at its front, keeping positions usable across
    /// feeds at the same size until history is cleared. The alternate grid has an empty range.
    pub fn scrollback_range(&self) -> Range<usize> {
        self.readable_rows().scrollback_range()
    }

    /// Gives retained primary positions, including when the alternate grid is active.
    /// An open synchronized update or a screen without a compact store has no available span.
    pub fn primary_history(&self) -> Option<PrimaryHistory> {
        self.primary_history_rows().map(|(history, _)| history)
    }

    pub(crate) fn primary_history_rows(&self) -> Option<(PrimaryHistory, AllRows<'_>)> {
        if self.synchronized_update_deadline().is_some() {
            return None;
        }
        let store = lock(self.scrollback.store.as_deref()?);
        let epoch = store.epoch();
        let mut rows = AllRows::new(self.terminal.main_grid(), Some(store));
        rows.keep_newest_scrollback(self.scrollback.readable);
        Some((
            PrimaryHistory {
                epoch,
                rows: rows.scrollback_range(),
            },
            rows,
        ))
    }

    /// Every row, oldest first: the store's, alacritty's scrollback, the screen. The alternate
    /// screen has no scrollback.
    pub(crate) fn all_rows(&self) -> AllRows<'_> {
        let grid = self.terminal.grid();
        let store = self.scrollback.store.as_deref();
        let store = store.filter(|_| !self.on_alternate_screen()).map(lock);
        AllRows::new(grid, store)
    }

    /// Only the primary viewport, including when the alternate grid is active.
    pub(crate) fn primary_viewport_rows(&self) -> AllRows<'_> {
        let mut rows = AllRows::new(self.terminal.main_grid(), None);
        rows.keep_newest_scrollback(0);
        rows
    }

    /// The visible rows and the scrollback within the configured readable limit.
    pub(crate) fn readable_rows(&self) -> AllRows<'_> {
        let mut rows = self.all_rows();
        rows.keep_newest_scrollback(self.scrollback.readable);
        rows
    }

    /// The last `count` lines as glyphs, with whether anything shows above them. Blank glyphs end
    /// no line, and empty lines end no reading.
    fn last_lines(&self, count: usize) -> (Vec<Vec<Glyph>>, bool) {
        let rows = self.readable_rows();
        let cols = rows.grid.columns();
        let empty_row = |row: &Row<Cell>| glyphs(row, cols).iter().all(Glyph::is_blank);
        let first = rows.start_of_last_lines(count, empty_row);

        let mut lines: Vec<Vec<Glyph>> = vec![Vec::new()];
        for y in first..rows.len() {
            let mut row = rows.with_row(y, |row| glyphs(row, cols));
            let ends_line = !rows.wraps(y);
            if ends_line {
                while row.last().is_some_and(Glyph::is_blank) {
                    row.pop();
                }
            }
            lines.last_mut().expect("a line being built").extend(row);
            if ends_line {
                lines.push(Vec::new());
            }
        }
        while lines.last().is_some_and(Vec::is_empty) {
            lines.pop();
        }
        let extra = lines.len().saturating_sub(count);
        let shown_above = (0..first).any(|y| rows.shows(y))
            || lines[..extra]
                .iter()
                .flatten()
                .any(|glyph| !glyph.is_blank());
        lines.drain(..extra);
        (lines, shown_above)
    }

    /// The last `lines` lines of the screen and scrollback, without styles.
    pub fn text(&self, lines: usize) -> Vec<String> {
        let (lines, _) = self.last_lines(lines);
        let plain = |line: &Vec<Glyph>| line.iter().map(|glyph| glyph.text.as_str()).collect();
        lines.iter().map(plain).collect()
    }

    /// The last `lines` lines of the screen and scrollback, with inverse and dim marked.
    pub fn read(&self, lines: usize) -> Reading {
        let (lines, older) = self.last_lines(lines);
        let mut text = String::new();
        for (number, line) in lines.iter().enumerate() {
            if number != 0 {
                text.push('\n');
            }
            write_marked(&mut text, line);
        }
        let readable = self.scrollback.readable;
        let rows = self.all_rows();
        let store_trimmed = rows.store.as_ref().is_some_and(|store| store.trimmed());
        let trimmed = readable != 0 && (store_trimmed || rows.scrollback() > readable);
        Reading {
            text,
            lines: lines.len(),
            alternate: self.on_alternate_screen(),
            older,
            trimmed,
        }
    }
}

/// Every row of a screen, oldest first: the store's, alacritty's scrollback, the visible screen.
pub(crate) struct AllRows<'a> {
    pub(crate) grid: &'a Grid<Cell>,
    /// The store, on the main screen of a scrollback longer than alacritty's part.
    store: Option<MutexGuard<'a, Store>>,
    stored: usize,
    /// alacritty's scrollback rows.
    held: usize,
    /// The oldest scrollback rows left out.
    left_out: usize,
    /// The store's block read last, built back, and the index of its first row.
    cached: RefCell<Option<(usize, Vec<Row<Cell>>)>>,
}

impl<'a> AllRows<'a> {
    fn new(grid: &'a Grid<Cell>, store: Option<MutexGuard<'a, Store>>) -> Self {
        Self {
            grid,
            stored: store.as_ref().map_or(0, |store| store.len()),
            store,
            held: grid.history_size(),
            left_out: 0,
            cached: RefCell::new(None),
        }
    }

    /// The scrollback rows included.
    pub(crate) fn scrollback(&self) -> usize {
        self.stored + self.held - self.left_out
    }

    fn scrollback_range(&self) -> Range<usize> {
        let start = self.store.as_deref().map_or(0, Store::discarded) + self.left_out;
        start..start + self.scrollback()
    }

    /// The first row of a viewport `offset` rows above the live grid.
    pub(crate) fn viewport_start(&self, offset: usize) -> usize {
        self.scrollback().saturating_sub(offset)
    }

    /// Leaves out all but the newest `rows` rows of scrollback.
    pub(crate) fn keep_newest_scrollback(&mut self, rows: usize) {
        self.left_out = (self.stored + self.held).saturating_sub(rows);
    }

    pub(crate) fn len(&self) -> usize {
        self.grid.screen_lines() + self.scrollback()
    }

    /// Where row `y` is in the store, if it is there.
    fn stored_index(&self, y: usize) -> Option<(&Store, usize)> {
        let index = y + self.left_out;
        match self.store.as_deref() {
            Some(store) if index < self.stored => Some((store, index)),
            _ => None,
        }
    }

    /// Gives row `y` to `read`.
    pub(crate) fn with_row<T>(&self, y: usize, read: impl FnOnce(&Row<Cell>) -> T) -> T {
        let Some((store, index)) = self.stored_index(y) else {
            let above_screen = self.stored + self.held;
            return read(&self.grid[Line((y + self.left_out) as i32 - above_screen as i32)]);
        };
        let mut cached = self.cached.borrow_mut();
        let (first, rows) = match &*cached {
            Some((first, rows)) if (*first..first + rows.len()).contains(&index) => (*first, rows),
            _ => {
                let (first, rows) = cached.insert(store.block_of(index));
                (*first, &*rows)
            }
        };
        read(&rows[index - first])
    }

    /// Whether row `y` wraps onto the next row.
    pub(crate) fn wraps(&self, y: usize) -> bool {
        if let Some((store, index)) = self.stored_index(y) {
            return store.marks(index) & WRAPPED != 0;
        }
        self.with_row(y, |row| wraps(row, self.grid.columns()))
    }

    /// Whether reflow can carry this row into the next one.
    pub(crate) fn carries(&self, y: usize) -> bool {
        if let Some((store, index)) = self.stored_index(y) {
            return store.marks(index) & CARRIES != 0;
        }
        self.with_row(y, carries)
    }

    /// Whether a reader sees anything in row `y`.
    fn shows(&self, y: usize) -> bool {
        if let Some((store, index)) = self.stored_index(y) {
            return store.marks(index) & SHOWS != 0;
        }
        self.with_row(y, shows)
    }

    /// The row the line through row `y` starts at.
    fn line_start(&self, mut y: usize) -> usize {
        while y > 0 && self.wraps(y - 1) {
            y -= 1;
        }
        y
    }

    /// The row the last `count` lines start at. Single empty rows at the end, which `empty` tells,
    /// don't count as lines.
    fn start_of_last_lines(&self, count: usize, empty: impl Fn(&Row<Cell>) -> bool) -> usize {
        let mut end = self.len();
        while end > 0 {
            let start = self.line_start(end - 1);
            let single_empty =
                start == end - 1 && !self.wraps(end - 1) && self.with_row(end - 1, &empty);
            if !single_empty {
                break;
            }
            end = start;
        }
        let mut start = end;
        for _ in 0..count {
            match start {
                0 => break,
                _ => start = self.line_start(start - 1),
            }
        }
        start
    }
}
