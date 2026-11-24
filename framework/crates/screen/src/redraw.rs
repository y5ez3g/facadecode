//! Redraws: output that turns any viewer's terminal into a copy of the agent's screen.

use std::io::Write;
use std::ops::Range;

use alacritty_terminal::grid::{Charsets, Cursor, Dimensions, Row};
use alacritty_terminal::index::Column;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::vte::ansi::{CharsetIndex, Color, NamedColor, StandardCharset};

use crate::kept_modes::{ActiveCharset, ModifyOtherKeys};
use crate::program_status::STATUS_QUERY;
use crate::read::{AllRows, cell_text, is_blank, is_spacer};
use crate::sequences::TitleNegotiation;
use crate::{REDRAW_SCROLLBACK_ROWS, Screen, title_has_text, write_title_body};

/// Plain pen, ASCII in G0 and G1 with G0 in use, whole-screen scrolling region, origin mode off,
/// wrap on, insert and newline modes off, and the initial modifyOtherKeys setting.
const DRAW_SETTINGS: &[u8] = b"\x1b[0m\x1b]8;;\x1b\\\x1b(B\x1b)B\x0f\x1b[r\
    \x1b[?6l\x1b[?7h\x1b[4l\x1b[20l\x1b[>4m";

/// End host synchronization, hide the cursor, and clear the visible area using absolute positions.
pub(crate) const HELD_VIEW_START: &[u8] =
    b"\x1b[?2026l\x1b[?25l\x1b[0m\x1b]8;;\x1b\\\x1b(B\x0f\x1b[?6l\x1b[H\x1b[J";
pub(crate) const RESET_PEN: &[u8] = b"\x1b[0m\x1b]8;;\x1b\\";

/// DEC private modes a redraw sets as the CLI left them, on or off.
const DEC_MODES: [(u16, TermMode); 4] = [
    (25, TermMode::SHOW_CURSOR),
    (1, TermMode::APP_CURSOR),
    (2004, TermMode::BRACKETED_PASTE),
    (1004, TermMode::FOCUS_IN_OUT),
];

const MOUSE_TRACKING_MODES: [(u16, TermMode); 3] = [
    (1000, TermMode::MOUSE_REPORT_CLICK),
    (1002, TermMode::MOUSE_DRAG),
    (1003, TermMode::MOUSE_MOTION),
];

const MOUSE_OPTIONS: [(u16, TermMode); 3] = [
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
        .with_viewer_title()
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
        .with_viewer_title()
    }

    /// Draws a full frame in the buffer already selected by Attach, preserving host scrollback.
    /// A viewport draw places the grid at the top left of a larger terminal.
    pub fn redraw_for_attach(&self, viewport: bool, include_scrollback: bool) -> Vec<u8> {
        let layout = if viewport {
            Layout::Viewport
        } else {
            Layout::SameSize
        };
        let mut redraw = Redraw::new(self);
        redraw.put(b"\x1b[?2026l");
        redraw.start(true);
        redraw
            .draw(replayed_scrollback(include_scrollback), layout)
            .with_viewer_title()
    }

    /// Overwrites the visible rows in the active buffer of a terminal at least as large as the
    /// grid. Clears stale row tails and restores the grid's cursor and interactive modes.
    pub fn redraw_in_viewport_update(&self) -> Vec<u8> {
        let mut redraw = Redraw::new(self);
        redraw.put(DRAW_SETTINGS);
        let mut rows = self.all_rows();
        rows.keep_newest_scrollback(0);
        write_viewport_rows(&mut redraw.out, &rows, true);
        redraw.cursor(Layout::Viewport);
        redraw.modes();
        redraw.with_viewer_title()
    }

    /// Draws one viewport starting `offset` rows above the live view, clamped to the active
    /// grid's readable scrollback. Uses the selected host buffer and hides its cursor, leaving
    /// input modes in place. The host must be at least as large as the grid.
    pub fn redraw_scrollback_view(&self, offset: usize) -> Vec<u8> {
        let mut redraw = Redraw::new(self);
        let rows = self.readable_rows();
        redraw.put(HELD_VIEW_START);
        write_positioned_rows(&mut redraw.out, &rows, rows.viewport_start(offset), false);
        redraw.out
    }

    /// A redraw with the whole scrollback, for a checkpoint. Taken at a clean point
    /// ([`Screen::at_clean_point`]), it rebuilds the rows, cursor, pen, CLI title, title negotiation,
    /// charsets and modes on an empty screen of the same size and scrollback.
    pub fn redraw_with_all_scrollback(&self) -> Vec<u8> {
        let mut out = Redraw::build(self, false, usize::MAX, Layout::SameSize).out;
        // Their order restores whether the current title was set before or after the question.
        if self.title_negotiation == TitleNegotiation::Eligible {
            out.extend_from_slice(STATUS_QUERY);
        }
        self.write_title(&mut out, None);
        if self.title_negotiation == TitleNegotiation::Asked {
            out.extend_from_slice(STATUS_QUERY);
        }
        out
    }

    /// The viewer's title as a sanitized OSC sequence, or empty bytes without a nonblank title.
    pub fn title_output(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.write_viewer_title(&mut out);
        out
    }

    fn write_viewer_title(&self, out: &mut Vec<u8>) {
        let glyph = if self.title_negotiation == TitleNegotiation::Eligible {
            self.status_glyph.as_deref()
        } else {
            None
        };
        self.write_title(out, glyph);
    }

    fn write_title(&self, out: &mut Vec<u8>, status_glyph: Option<&str>) {
        if let Some(title) = &self.terminal.title
            && title_has_text(title)
        {
            let title = title.replace(char::is_control, "");
            out.extend_from_slice(b"\x1b]2;");
            write_title_body(out, title.as_bytes(), status_glyph);
            out.extend_from_slice(b"\x1b\\");
        }
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

impl<'a> Redraw<'a> {
    fn new(screen: &'a Screen) -> Self {
        let grid = screen.terminal.grid();
        let capacity = 2 * grid.columns() * grid.screen_lines();
        Redraw {
            screen,
            out: Vec::with_capacity(capacity),
        }
    }

    fn build(screen: &'a Screen, keep_scrollback: bool, replayed: usize, layout: Layout) -> Self {
        let mut redraw = Redraw::new(screen);
        redraw.put(b"\x1b[?2026l\x1b[?1049l");
        redraw.start(keep_scrollback);
        if screen.on_alternate_screen() {
            redraw.put(b"\x1b[?1049h\x1b[H\x1b[J");
        }
        redraw.draw(replayed, layout)
    }

    fn draw(mut self, replayed: usize, layout: Layout) -> Self {
        let mut rows = self.screen.all_rows();
        rows.keep_newest_scrollback(replayed);
        match layout {
            Layout::SameSize => write_rows(&mut self.out, &rows),
            Layout::Viewport => write_viewport_rows(&mut self.out, &rows, false),
        }
        self.saved_cursor();
        self.cursor(layout);
        self.modes();
        self
    }

    fn with_viewer_title(mut self) -> Vec<u8> {
        self.screen.write_viewer_title(&mut self.out);
        self.out
    }

    fn put(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
    }

    /// Erase from the top left down so the visible rows stay out of scrollback. Restore tab stops
    /// and optionally clear the viewer's existing scrollback.
    fn start(&mut self, keep_scrollback: bool) {
        self.put(DRAW_SETTINGS);
        self.put(b"\x1b[H\x1b[J\x1b[3g");
        for column in self.screen.tab_stops.columns() {
            write!(self.out, "\x1b[1;{}H\x1bH", column + 1).unwrap();
        }
        self.put(b"\x1b[H");
        if !keep_scrollback {
            self.put(b"\x1b[3J");
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
        self.put(sgr(cell, false).as_bytes());
        self.put(cell_text(cell).as_bytes());
    }

    /// Drawing, key and paste modes; the keyboard flags of the screen in use; modifyOtherKeys
    /// (DRAW_SETTINGS put it at the initial setting); the cursor's charsets; the pen.
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
        // Some terminals clear all tracking when any of the three modes is reset.
        let mut tracking = MOUSE_TRACKING_MODES;
        tracking.sort_by_key(|&(_, mode)| terminal.has(mode));
        for (number, mode) in DEC_MODES.into_iter().chain(tracking).chain(MOUSE_OPTIONS) {
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
        rows.with_row(y, |row| write_row(out, row, cols, to_margin, 0..0));
        if !wraps && y + 1 < rows.len() {
            out.extend_from_slice(b"\x1b[0m\x1b]8;;\x1b\\\r\n");
        }
        wrapped_into = wraps;
    }
    out.extend_from_slice(RESET_PEN);
}

/// Write scrollback rows at the top and scroll them out from the physical bottom, then draw the
/// viewport.
fn write_viewport_rows(out: &mut Vec<u8>, rows: &AllRows<'_>, erase_tail: bool) {
    let cols = rows.grid.columns();
    let scrollback = rows.scrollback();
    for y in 0..scrollback {
        out.extend_from_slice(b"\x1b[H");
        rows.with_row(y, |row| write_row(out, row, cols, false, 0..0));
        // CUP clamps the row to the physical bottom, where Index scrolls the full screen.
        out.extend_from_slice(b"\x1b[0m\x1b[65535;1H\x1bD");
    }
    write_positioned_rows(out, rows, scrollback, erase_tail);
}

/// Place one viewport explicitly so the host terminal's line endings never decide where the
/// grid wraps.
fn write_positioned_rows(out: &mut Vec<u8>, rows: &AllRows<'_>, first: usize, erase_tail: bool) {
    let cols = rows.grid.columns();
    for line in 0..rows.grid.screen_lines() {
        let end = rows.with_row(first + line, |row| {
            write_positioned_row(out, line, row, cols, 0..0)
        });
        // A full row on an equally wide terminal leaves the cursor on its last cell.
        if erase_tail && end < cols {
            out.extend_from_slice(b"\x1b[0m\x1b[K");
        }
    }
    out.extend_from_slice(RESET_PEN);
}

pub(crate) fn write_positioned_row(
    out: &mut Vec<u8>,
    line: usize,
    row: &Row<Cell>,
    cols: usize,
    highlighted: Range<usize>,
) -> usize {
    write!(out, "\x1b[{};1H", line + 1).unwrap();
    write_row(out, row, cols, false, highlighted)
}

/// One row, with pen and link changes only where they change: to the margin, or to its last
/// cell that draws something.
fn write_row(
    out: &mut Vec<u8>,
    row: &Row<Cell>,
    cols: usize,
    to_margin: bool,
    highlighted: Range<usize>,
) -> usize {
    let end = match to_margin {
        true => cols,
        false => (0..cols)
            .rposition(|x| highlighted.contains(&x) || !is_blank(&row[Column(x)]))
            .map_or(0, |x| x + 1),
    };
    let mut pen = String::new();
    let mut link: Option<Hyperlink> = None;
    let mut written = 0;
    for x in 0..end {
        let cell = &row[Column(x)];
        let selected = highlighted.contains(&x);
        // A leading wide spacer is an empty position at the right margin that can be highlighted.
        if is_spacer(cell) && !(selected && cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)) {
            continue;
        }
        let cell_pen = sgr(cell, selected);
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
        written = x + 1 + usize::from(cell.flags.contains(Flags::WIDE_CHAR));
    }
    if link.is_some() {
        write_link(out, None);
    }
    written
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
    out.extend_from_slice(sgr(template, false).as_bytes());
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

/// The SGR sequence for a cell's look, from a reset pen. Selection reverses its colours.
fn sgr(cell: &Cell, selected: bool) -> String {
    let mut flags = cell.flags;
    if selected {
        flags.toggle(Flags::INVERSE);
    }
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
