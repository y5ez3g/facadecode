//! Redraws: output that turns any viewer's terminal into a copy of the agent's screen.

use std::io::Write;

use alacritty_terminal::grid::{Charsets, Cursor, Dimensions, Row};
use alacritty_terminal::index::Column;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::vte::ansi::{CharsetIndex, Color, NamedColor, StandardCharset};

use crate::kept_modes::{ActiveCharset, ModifyOtherKeys};
use crate::read::{AllRows, cell_text, is_blank, is_spacer};
use crate::{REDRAW_SCROLLBACK_ROWS, Screen};

/// Brings any terminal to a known start: no synchronized update, main screen, plain pen without a
/// link, ASCII in G0 and G1 with G0 in use, whole-screen scrolling region, origin mode off,
/// wrapping on, insert and newline modes off, modifyOtherKeys as the terminal started. Then it
/// erases from the top left down, which no terminal moves into its scrollback (some do with ED 2),
/// and clears every tab stop.
const START: &[u8] = b"\x1b[?2026l\x1b[?1049l\x1b[0m\x1b]8;;\x1b\\\x1b(B\x1b)B\x0f\x1b[r\
    \x1b[?6l\x1b[?7h\x1b[4l\x1b[20l\x1b[>4m\x1b[H\x1b[J\x1b[3g";

/// DEC private modes a redraw sets as the CLI left them, on or off.
const DEC_MODES: [(u16, TermMode); 10] = [
    (25, TermMode::SHOW_CURSOR),
    (1, TermMode::APP_CURSOR),
    (2004, TermMode::BRACKETED_PASTE),
    (1004, TermMode::FOCUS_IN_OUT),
    (1000, TermMode::MOUSE_REPORT_CLICK),
    (1002, TermMode::MOUSE_DRAG),
    (1003, TermMode::MOUSE_MOTION),
    (1006, TermMode::SGR_MOUSE),
    (1005, TermMode::UTF8_MOUSE),
    (1007, TermMode::ALTERNATE_SCROLL),
];

impl Screen {
    /// A redraw. With `keep_scrollback` the viewer's own scrollback stays; with
    /// `include_scrollback` up to [`REDRAW_SCROLLBACK_ROWS`] rows of the agent's scrollback come
    /// before the screen.
    pub fn redraw(&self, keep_scrollback: bool, include_scrollback: bool) -> Vec<u8> {
        Redraw::build(
            self,
            keep_scrollback,
            replayed_scrollback(include_scrollback),
            Layout::SameSize,
        )
    }

    /// Draws the grid in the top left of a terminal with at least as many rows and columns.
    /// The outer margins are cleared and scrollback follows the same options as [`Self::redraw`].
    /// Feed later output to the canonical screen and draw from it again to keep its wrapping
    /// and scrolling geometry.
    pub fn redraw_in_viewport(&self, keep_scrollback: bool, include_scrollback: bool) -> Vec<u8> {
        Redraw::build(
            self,
            keep_scrollback,
            replayed_scrollback(include_scrollback),
            Layout::Viewport,
        )
    }

    /// A redraw with the whole scrollback, for a checkpoint. Taken at a clean point
    /// ([`Screen::at_clean_point`]), it rebuilds the rows, cursor, pen, charsets and modes on an
    /// empty screen of the same size and scrollback.
    pub fn redraw_with_all_scrollback(&self) -> Vec<u8> {
        Redraw::build(self, false, usize::MAX, Layout::SameSize)
    }
}

fn replayed_scrollback(include_scrollback: bool) -> usize {
    if include_scrollback {
        REDRAW_SCROLLBACK_ROWS
    } else {
        0
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Layout {
    SameSize,
    Viewport,
}

/// A redraw being written.
struct Redraw<'a> {
    screen: &'a Screen,
    out: Vec<u8>,
}

impl Redraw<'_> {
    fn build(screen: &Screen, keep_scrollback: bool, replayed: usize, layout: Layout) -> Vec<u8> {
        let grid = screen.terminal.grid();
        let capacity = 2 * grid.columns() * grid.screen_lines();
        let mut redraw = Redraw {
            screen,
            out: Vec::with_capacity(capacity),
        };
        redraw.start(keep_scrollback);
        let mut rows = screen.all_rows();
        rows.keep_newest_scrollback(replayed);
        match layout {
            Layout::SameSize => write_rows(&mut redraw.out, &rows),
            Layout::Viewport => write_viewport_rows(&mut redraw.out, &rows),
        }
        drop(rows);
        redraw.saved_cursor();
        redraw.cursor(layout);
        redraw.modes();
        redraw.out
    }

    fn put(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
    }

    /// The known start, the tab stops, and the alternate screen if it shows.
    fn start(&mut self, keep_scrollback: bool) {
        self.put(START);
        for column in self.screen.tab_stops.columns() {
            write!(self.out, "\x1b[1;{}H\x1bH", column + 1).unwrap();
        }
        self.put(b"\x1b[H");
        if !keep_scrollback {
            self.put(b"\x1b[3J");
        }
        if self.screen.on_alternate_screen() {
            self.put(b"\x1b[?1049h\x1b[H\x1b[J");
        }
    }

    /// The saved cursor: placed, given its pen and charsets, saved, and the pen reset after.
    fn saved_cursor(&mut self) {
        let saved: &Cursor<Cell> = &self.screen.terminal.grid().saved_cursor;
        let (line, column) = (saved.point.line.0.max(0) + 1, saved.point.column.0 + 1);
        write!(self.out, "\x1b[{line};{column}H").unwrap();
        write_pen(&mut self.out, &saved.template);
        write_charsets(&mut self.out, &saved.charsets);
        self.put(b"\x1b7\x1b[0m\x1b(B\x1b)B");
    }

    /// The scrolling region and origin mode, then the cursor, relative to the region when origin
    /// mode is on. A same-size redraw restores a pending wrap by writing the margin's cell again.
    fn cursor(&mut self, layout: Layout) {
        let screen = self.screen;
        let grid = screen.terminal.grid();
        let region = screen.modes.scroll_region.or_else(|| {
            let rows = grid.screen_lines();
            (layout == Layout::Viewport && rows > 1).then_some((1, rows as u16))
        });
        if let Some((top, bottom)) = region {
            write!(self.out, "\x1b[{top};{bottom}r").unwrap();
        }
        let origin = screen.terminal.has(TermMode::ORIGIN);
        if origin {
            self.put(b"\x1b[?6h");
        }
        let cursor = &grid.cursor;
        let top = if origin {
            region.map_or(1, |(top, _)| i32::from(top))
        } else {
            1
        };
        let line = cursor.point.line.0.max(0) + 2 - top;
        if layout == Layout::Viewport || !cursor.input_needs_wrap {
            write!(self.out, "\x1b[{line};{}H", cursor.point.column.0 + 1).unwrap();
            return;
        }
        let row = &grid[cursor.point.line];
        let mut margin = grid.columns() - 1;
        if row[Column(margin)].flags.contains(Flags::WIDE_CHAR_SPACER) {
            margin -= 1;
        }
        let cell = &row[Column(margin)];
        write!(self.out, "\x1b[{line};{}H", margin + 1).unwrap();
        self.put(sgr(cell).as_bytes());
        self.put(cell_text(cell).as_bytes());
    }

    /// Drawing, key and paste modes; the keyboard flags of the screen in use; modifyOtherKeys
    /// (START put it at the initial setting); the cursor's charsets; the pen.
    fn modes(&mut self) {
        let screen = self.screen;
        let terminal = &screen.terminal;
        if !terminal.has(TermMode::LINE_WRAP) {
            self.put(b"\x1b[?7l");
        }
        if terminal.has(TermMode::INSERT) {
            self.put(b"\x1b[4h");
        }
        if terminal.has(TermMode::LINE_FEED_NEW_LINE) {
            self.put(b"\x1b[20h");
        }
        for (number, mode) in DEC_MODES {
            let on_off = if terminal.has(mode) { 'h' } else { 'l' };
            write!(self.out, "\x1b[?{number}{on_off}").unwrap();
        }
        self.put(match terminal.has(TermMode::APP_KEYPAD) {
            true => b"\x1b=",
            false => b"\x1b>",
        });
        let keyboard = &screen.modes.keyboard;
        let flags = match screen.on_alternate_screen() {
            true => keyboard.alternate(),
            false => keyboard.main(),
        };
        write!(self.out, "\x1b[={flags};1u").unwrap();
        match screen.modes.modify_other_keys {
            ModifyOtherKeys::Initial => {}
            ModifyOtherKeys::Level(level) => write!(self.out, "\x1b[>4;{level}m").unwrap(),
            ModifyOtherKeys::Disabled => self.put(b"\x1b[>4n"),
        }
        let cursor = &terminal.grid().cursor;
        write_charsets(&mut self.out, &cursor.charsets);
        self.out.push(match screen.modes.active_charset {
            ActiveCharset::G0 => 0x0f,
            ActiveCharset::G1 => 0x0e,
        });
        write_pen(&mut self.out, &cursor.template);
    }
}

/// Every row in `rows`. A row that wraps is written to the right margin, so that the viewer's
/// terminal wraps into the next; the others end with a line break.
fn write_rows(out: &mut Vec<u8>, rows: &AllRows<'_>) {
    let cols = rows.grid.columns();
    let mut wrapped_into = false;
    for y in 0..rows.len() {
        let wraps = rows.wraps(y);
        // A row the one above wrapped into starts with a character, even a space, to make the wrap.
        let to_margin = wraps || wrapped_into;
        rows.with_row(y, |row| write_row(out, row, cols, to_margin));
        if !wraps && y + 1 < rows.len() {
            out.extend_from_slice(b"\x1b[0m\x1b]8;;\x1b\\\r\n");
        }
        wrapped_into = wraps;
    }
    out.extend_from_slice(b"\x1b[0m\x1b]8;;\x1b\\");
}

/// Place each visible row explicitly so the larger terminal's line endings never decide where
/// the grid wraps. Write scrollback rows at the top and scroll them out from the physical bottom.
fn write_viewport_rows(out: &mut Vec<u8>, rows: &AllRows<'_>) {
    let cols = rows.grid.columns();
    let scrollback = rows.scrollback();
    for y in 0..scrollback {
        out.extend_from_slice(b"\x1b[H");
        rows.with_row(y, |row| write_row(out, row, cols, false));
        // CUP clamps the row to the physical bottom, where Index scrolls the full screen.
        out.extend_from_slice(b"\x1b[0m\x1b[65535;1H\x1bD");
    }
    for y in scrollback..rows.len() {
        write!(out, "\x1b[{};1H", y - scrollback + 1).unwrap();
        rows.with_row(y, |row| write_row(out, row, cols, false));
    }
    out.extend_from_slice(b"\x1b[0m\x1b]8;;\x1b\\");
}

/// One row, with pen and link changes only where they change: to the margin, or to its last
/// cell that draws something.
fn write_row(out: &mut Vec<u8>, row: &Row<Cell>, cols: usize, to_margin: bool) {
    let end = match to_margin {
        true => cols,
        false => (0..cols)
            .rposition(|x| !is_blank(&row[Column(x)]))
            .map_or(0, |x| x + 1),
    };
    let mut pen = String::new();
    let mut link: Option<Hyperlink> = None;
    for x in 0..end {
        let cell = &row[Column(x)];
        if is_spacer(cell) {
            continue;
        }
        let cell_pen = sgr(cell);
        if cell_pen != pen {
            out.extend_from_slice(cell_pen.as_bytes());
            pen = cell_pen;
        }
        let cell_link = cell.hyperlink();
        if link_key(cell_link.as_ref()) != link_key(link.as_ref()) {
            write_link(out, cell_link.as_ref());
            link = cell_link;
        }
        out.extend_from_slice(cell_text(cell).as_bytes());
        // A tab holds the cell it started at; the viewer's tab stops may be elsewhere, so the next
        // cell is placed by column.
        if cell.c == '\t' {
            write!(out, "\x1b[{}G", x + 2).unwrap();
        }
    }
    if link.is_some() {
        write_link(out, None);
    }
}

/// The ID the CLI gave a link: the IDs alacritty makes up itself mean nothing to a viewer.
fn given_id(link: &Hyperlink) -> Option<&str> {
    let id = link.id();
    (!id.ends_with("_alacritty")).then_some(id)
}

/// What tells two links apart for a viewer.
fn link_key(link: Option<&Hyperlink>) -> Option<(Option<&str>, &str)> {
    link.map(|link| (given_id(link), link.uri()))
}

fn write_link(out: &mut Vec<u8>, link: Option<&Hyperlink>) {
    let Some(link) = link else {
        return out.extend_from_slice(b"\x1b]8;;\x1b\\");
    };
    let params = given_id(link)
        .map(|id| format!("id={id}"))
        .unwrap_or_default();
    write!(out, "\x1b]8;{params};{}\x1b\\", link.uri()).unwrap();
}

/// The pen of `template`: SGR and hyperlink.
fn write_pen(out: &mut Vec<u8>, template: &Cell) {
    out.extend_from_slice(sgr(template).as_bytes());
    write_link(out, template.hyperlink().as_ref());
}

fn write_charsets(out: &mut Vec<u8>, charsets: &Charsets) {
    let slots = [
        CharsetIndex::G0,
        CharsetIndex::G1,
        CharsetIndex::G2,
        CharsetIndex::G3,
    ];
    for (slot, designator) in slots.into_iter().zip(['(', ')', '*', '+']) {
        let final_byte = match charsets[slot] {
            StandardCharset::Ascii => 'B',
            StandardCharset::SpecialCharacterAndLineDrawing => '0',
        };
        write!(out, "\x1b{designator}{final_byte}").unwrap();
    }
}

/// The SGR sequence for a cell's look, from a reset pen.
fn sgr(cell: &Cell) -> String {
    let flags = cell.flags;
    let underline = [
        (Flags::UNDERLINE, "4"),
        (Flags::DOUBLE_UNDERLINE, "4:2"),
        (Flags::UNDERCURL, "4:3"),
        (Flags::DOTTED_UNDERLINE, "4:4"),
        (Flags::DASHED_UNDERLINE, "4:5"),
    ]
    .into_iter()
    .find(|&(flag, _)| flags.contains(flag));
    let attributes = [(Flags::BOLD, "1"), (Flags::DIM, "2"), (Flags::ITALIC, "3")]
        .into_iter()
        .chain(underline)
        .chain([
            (Flags::INVERSE, "7"),
            (Flags::HIDDEN, "8"),
            (Flags::STRIKEOUT, "9"),
        ])
        .filter(|&(flag, _)| flags.contains(flag));
    let mut parts = vec![String::from("0")];
    parts.extend(attributes.map(|(_, code)| code.to_owned()));
    parts.extend(colour(cell.fg, 30));
    parts.extend(colour(cell.bg, 40));
    parts.extend(
        cell.underline_color()
            .and_then(|underline| colour(underline, 50)),
    );
    format!("\x1b[{}m", parts.join(";"))
}

/// The SGR parameters for `colour`, where `base` is 30 (foreground), 40 (background) or 50
/// (underline); None for a default colour.
fn colour(colour: Color, base: usize) -> Option<String> {
    let palette = match colour {
        Color::Indexed(index) => return Some(format!("{};5;{index}", base + 8)),
        Color::Spec(rgb) => return Some(format!("{};2;{};{};{}", base + 8, rgb.r, rgb.g, rgb.b)),
        Color::Named(named) => named as usize,
    };
    // A dim named colour is drawn as the plain one.
    let first_dim = NamedColor::DimBlack as usize;
    let palette = match palette {
        0..=15 => palette,
        dim if (first_dim..first_dim + 8).contains(&dim) => dim - first_dim,
        _ => return None,
    };
    Some(match palette {
        _ if base == 50 => format!("58;5;{palette}"),
        0..=7 => (base + palette).to_string(),
        bright => (base + 52 + bright).to_string(),
    })
}
