//! Rows kept compact: what alacritty holds in 24 bytes a cell, in a few bytes a cell.
//!
//! A [`Block`] takes up to [`BLOCK_ROWS`] rows of one width. Each row keeps its characters as one
//! string, its cells as runs that share a [`Style`] from the block's palette, and the rare
//! combining characters apart. Default cells at a row's end take no room. [`Block::row`] builds a
//! row back exactly as it was.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use alacritty_terminal::grid::{GridCell, Row};
use alacritty_terminal::index::Column;
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::vte::ansi::Color;

/// The most rows in a block.
pub(crate) const BLOCK_ROWS: usize = 256;

/// The row's text goes on in the next row: its last cell has WRAPLINE.
pub(crate) const WRAPPED: u8 = 1 << 0;
/// A read sees something in the row (see [`shows`]).
pub(crate) const SHOWS: u8 = 1 << 1;
/// Reflowing the row reaches into the next one (see [`carries`]).
pub(crate) const CARRIES: u8 = 1 << 2;

/// Whether a read sees anything in `row`: a cell, not a wide character's spacer, that is inverse
/// or holds a character other than whitespace.
pub(crate) fn shows(row: &Row<Cell>) -> bool {
    let spacer = Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER;
    let visible = |c: &char| !c.is_whitespace();
    (0..row.len()).any(|x| {
        let cell = &row[Column(x)];
        let drawn = visible(&cell.c)
            || cell
                .zerowidth()
                .is_some_and(|extra| extra.iter().any(visible));
        !cell.flags.intersects(spacer) && (drawn || cell.flags.contains(Flags::INVERSE))
    })
}

/// Whether reflowing `row` reaches into the next row: its last cell that is not empty has
/// WRAPLINE. Besides a wrapped row, that is a row an earlier widening left a WRAPLINE inside, whose
/// overflow narrowing moves into the next row.
pub(crate) fn carries(row: &Row<Cell>) -> bool {
    let last_used = (0..row.len())
        .rev()
        .map(|x| &row[Column(x)])
        .find(|cell| !cell.is_empty());
    last_used.is_some_and(|cell| cell.flags.contains(Flags::WRAPLINE))
}

fn marks_of(row: &Row<Cell>) -> u8 {
    let wrapped = row.len() > 0 && row[Column(row.len() - 1)].flags.contains(Flags::WRAPLINE);
    [
        (wrapped, WRAPPED),
        (shows(row), SHOWS),
        (carries(row), CARRIES),
    ]
    .into_iter()
    .filter(|&(has, _)| has)
    .fold(0, |marks, (_, mark)| marks | mark)
}

/// A colour that hashes: vte's own type doesn't.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Colour(Color);

impl Hash for Colour {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match self.0 {
            Color::Named(named) => (0u8, named as u32).hash(state),
            Color::Spec(rgb) => (1u8, rgb.r, rgb.g, rgb.b).hash(state),
            Color::Indexed(index) => (2u8, index).hash(state),
        }
    }
}

/// All a cell holds but its characters.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Style {
    flags: Flags,
    link: Option<Hyperlink>,
    colours: [Colour; 2],
    underline_colour: Option<Colour>,
}

impl Style {
    fn of(cell: &Cell) -> Self {
        Style {
            flags: cell.flags,
            link: cell.hyperlink(),
            colours: [Colour(cell.fg), Colour(cell.bg)],
            underline_colour: cell.underline_color().map(Colour),
        }
    }

    /// A cell of this style showing `c`.
    fn paint(&self, c: char) -> Cell {
        let [fg, bg] = self.colours;
        let mut cell = Cell {
            c,
            fg: fg.0,
            bg: bg.0,
            flags: self.flags,
            extra: None,
        };
        if let Some(colour) = self.underline_colour {
            cell.set_underline_color(Some(colour.0));
        }
        if self.link.is_some() {
            cell.set_hyperlink(self.link.clone());
        }
        cell
    }
}

/// The styles of a block, each once, by number.
#[derive(Debug, Default)]
struct Palette {
    styles: Vec<Style>,
    /// Each style's number while the block still takes rows.
    numbers: Option<HashMap<Style, u16>>,
    /// About what the styles' hyperlinks hold on the heap.
    link_bytes: usize,
}

impl Palette {
    fn number(&mut self, cell: &Cell) -> u16 {
        let style = Style::of(cell);
        let numbers = self.numbers.get_or_insert_default();
        if let Some(&number) = numbers.get(&style) {
            return number;
        }
        let number = self.styles.len() as u16;
        if let Some(link) = &style.link {
            self.link_bytes += link.id().len() + link.uri().len() + 64;
        }
        numbers.insert(style.clone(), number);
        self.styles.push(style);
        number
    }

    fn bytes(&self) -> usize {
        let entry = size_of::<Style>() + size_of::<u16>() + 1;
        self.styles.capacity() * size_of::<Style>()
            + self
                .numbers
                .as_ref()
                .map_or(0, |numbers| numbers.capacity() * entry)
            + self.link_bytes
    }
}

/// A run of cells with one style.
#[derive(Clone, Copy, Debug)]
struct Run {
    style: u16,
    len: u16,
}

/// Combining characters drawn over the cell in `column`.
#[derive(Clone, Debug)]
struct Combining {
    column: u16,
    chars: Box<str>,
}

/// Where one row's characters, runs and combining characters end in its block, how many cells it
/// keeps (the rest are default cells), and its marks.
#[derive(Clone, Copy, Debug, Default)]
struct RowSpan {
    chars_end: u32,
    runs_end: u32,
    combining_end: u32,
    cells: u16,
    marks: u8,
}

/// Up to [`BLOCK_ROWS`] rows of one width, compact.
#[derive(Debug)]
pub(crate) struct Block {
    width: u16,
    spans: Vec<RowSpan>,
    chars: String,
    runs: Vec<Run>,
    combining: Vec<Combining>,
    palette: Palette,
    open: bool,
}

impl Block {
    pub(crate) fn new(width: u16) -> Self {
        Block {
            width,
            spans: Vec::new(),
            chars: String::new(),
            runs: Vec::new(),
            combining: Vec::new(),
            palette: Palette {
                numbers: Some(HashMap::new()),
                ..Palette::default()
            },
            open: true,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.spans.len()
    }

    pub(crate) fn marks(&self, row: usize) -> u8 {
        self.spans[row].marks
    }

    pub(crate) fn is_open(&self) -> bool {
        self.open
    }

    /// Whether a row of `width` fits: the block is open, as wide, not full, and has numbers left
    /// for as many new styles as a row has cells.
    pub(crate) fn fits(&self, width: u16) -> bool {
        let numbers_left = usize::from(u16::MAX) - usize::from(width);
        self.open
            && width == self.width
            && self.len() < BLOCK_ROWS
            && self.palette.styles.len() < numbers_left
    }

    /// The memory the block's rows take, by capacity.
    pub(crate) fn bytes(&self) -> usize {
        let combining: usize = self
            .combining
            .iter()
            .map(|combining| combining.chars.len())
            .sum();
        self.spans.capacity() * size_of::<RowSpan>()
            + self.chars.capacity()
            + self.runs.capacity() * size_of::<Run>()
            + self.combining.capacity() * size_of::<Combining>()
            + combining
            + self.palette.bytes()
    }

    pub(crate) fn push(&mut self, row: &Row<Cell>) {
        let default = Cell::default();
        let cells = (0..row.len())
            .rposition(|x| row[Column(x)] != default)
            .map_or(0, |x| x + 1);
        let row_runs = self.runs.len();
        for (column, cell) in (0..cells).map(|x| (x, &row[Column(x)])) {
            self.chars.push(cell.c);
            if let Some(extra) = cell.zerowidth().filter(|extra| !extra.is_empty()) {
                let chars = extra.iter().collect();
                self.combining.push(Combining {
                    column: column as u16,
                    chars,
                });
            }
            let style = self.palette.number(cell);
            let extends = |run: &Run| run.style == style && run.len < u16::MAX;
            let in_row = self.runs.len() > row_runs;
            match self.runs.last_mut().filter(|_| in_row) {
                Some(run) if extends(run) => run.len += 1,
                _ => self.runs.push(Run { style, len: 1 }),
            }
        }
        self.spans.push(RowSpan {
            chars_end: self.chars.len() as u32,
            runs_end: self.runs.len() as u32,
            combining_end: self.combining.len() as u32,
            cells: cells as u16,
            marks: marks_of(row),
        });
    }

    /// Takes no more rows: drops the style map and spare capacity.
    pub(crate) fn seal(&mut self) {
        self.open = false;
        self.palette.numbers = None;
        self.spans.shrink_to_fit();
        self.chars.shrink_to_fit();
        self.runs.shrink_to_fit();
        self.combining.shrink_to_fit();
        self.palette.styles.shrink_to_fit();
    }

    /// The span before row `row`'s, where `row` begins.
    fn begin(&self, row: usize) -> RowSpan {
        match row {
            0 => RowSpan::default(),
            _ => self.spans[row - 1],
        }
    }

    /// Row `row`, built back as alacritty held it.
    pub(crate) fn row(&self, row: usize) -> Row<Cell> {
        let (from, to) = (self.begin(row), self.spans[row]);
        let width = usize::from(self.width);
        let mut cells: Vec<Cell> = Vec::with_capacity(width.max(to.cells.into()));
        let mut chars = self.chars[from.chars_end as usize..to.chars_end as usize].chars();
        for run in &self.runs[from.runs_end as usize..to.runs_end as usize] {
            let style = &self.palette.styles[usize::from(run.style)];
            for _ in 0..run.len {
                cells.push(style.paint(chars.next().unwrap_or(' ')));
            }
        }
        let combining = &self.combining[from.combining_end as usize..to.combining_end as usize];
        for Combining { column, chars } in combining {
            let Some(cell) = cells.get_mut(usize::from(*column)) else {
                continue;
            };
            chars.chars().for_each(|c| cell.push_zerowidth(c));
        }
        if cells.len() < width {
            cells.resize(width, Cell::default());
        }
        let occupied = cells.len();
        Row::from_vec(cells, occupied)
    }

    /// Keeps the first `rows` rows only, and takes rows again.
    pub(crate) fn truncate(&mut self, rows: usize) {
        let end = self.begin(rows);
        self.spans.truncate(rows);
        self.chars.truncate(end.chars_end as usize);
        self.runs.truncate(end.runs_end as usize);
        self.combining.truncate(end.combining_end as usize);
        if !self.open {
            self.open = true;
            let numbered = self.palette.styles.iter().cloned().zip(0..);
            self.palette.numbers = Some(numbered.collect());
        }
    }
}
