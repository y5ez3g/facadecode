//! A headless terminal: the screen Facade keeps for each agent.
//!
//! Everything the CLI writes goes through [`Screen::feed`]. The screen answers the terminal
//! queries it can, passes the rest of the output on for viewers with every query taken out, and
//! reports what the CLI said about its status ([`StatusEvent`]).
//!
//! A viewer joining late gets [`Screen::redraw`]: cells and styles, wraps, both cursors, pen,
//! charsets and modes, including the ones alacritty keeps private (scrolling region, tab stops,
//! active charset, modifyOtherKeys, kitty keyboard flags), which the screen follows itself. After
//! that the viewer takes [`ParsedOutput::viewer_output`], or a new redraw whenever
//! [`ParsedOutput::redraw_viewers`] asks for one.
//!
//! Reading: [`Screen::view`] for the visible cells and cursor, [`Screen::read`] and
//! [`Screen::text`] for the last lines. For a CLI started again in the same terminal,
//! [`Screen::leave_for_restart`] and [`Screen::reset_for_restart`] give an empty screen and a fresh
//! terminal's modes.
//!
//! The scrollback's newest [`SHORT_HISTORY`] rows live in alacritty; older ones are kept compact
//! within [`SCROLLBACK_BUDGET`]. Nothing a reader sees depends on where a row lives.

mod compact;
mod kept_modes;
mod mouse;
mod program_status;
mod read;
mod redraw;
mod resize;
mod restart;
mod scrollback;
mod selection;
mod sequences;
mod store;
mod terminal;
mod units;
mod view;

#[cfg(test)]
mod store_tests;
#[cfg(test)]
mod tests;

pub use program_status::{BlockKind, ReportedState, StatusEvent, StatusReport};
pub use read::{PrimaryHistory, Reading};
pub use redraw::HistoryAppend;
pub use selection::SelectionView;
pub use store::SCROLLBACK_BUDGET;
pub use view::{ScreenView, VisibleCell};

use std::time::Instant;

use alacritty_terminal::term::TermMode;

use kept_modes::{KeptModes, TabStops};
use scrollback::Scrollback;
use sequences::{Mark, TitleNegotiation};
use terminal::{Size, Terminal};
use units::Splitter;

/// How many scrollback rows a redraw for a newly opened viewer replays at most.
pub const REDRAW_SCROLLBACK_ROWS: usize = 1000;

/// How many scrollback rows alacritty itself holds, as full cells. Any older ones are kept compact.
pub const SHORT_HISTORY: usize = 100;

/// Colors supplied for replies to OSC 4, 10, 11 and 12 queries. An omitted color gets no reply.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerminalColors {
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
    pub cursor: Option<[u8; 3]>,
    /// The first 16 indexed colors.
    pub ansi: [Option<[u8; 3]>; 16],
}

/// What one call to [`Screen::feed`] produced.
#[derive(Debug, Default)]
pub struct ParsedOutput {
    /// The screen's replies to terminal queries, for the CLI's input.
    pub query_replies: Vec<u8>,
    /// The title the CLI set, if it set one; empty when it reset the title.
    pub title_change: Option<String>,
    /// The output for viewers: whole characters and sequences, with the status glyph in titles
    /// and queries taken out.
    pub viewer_output: Vec<u8>,
    /// The complete OSC 9;4 activity sequences in this batch's viewer output, in order.
    pub native_activity: Vec<u8>,
    /// Viewers need a redraw rather than `viewer_output`: the CLI went back to the main screen,
    /// which a viewer may have kept differently.
    pub redraw_viewers: bool,
    /// What the CLI said about its status, in order. These sequences never reach viewers.
    pub status: Vec<StatusEvent>,
}

/// One agent's terminal, without a window. It only computes; the one time it uses is the deadline
/// alacritty puts on a synchronized update.
pub struct Screen {
    terminal: Terminal,
    status_glyph: Option<String>,
    title_negotiation: TitleNegotiation,
    deferred_status_title: bool,
    splitter: Splitter,
    modes: KeptModes,
    tab_stops: TabStops,
    scrollback: Scrollback,
}

impl Screen {
    /// A `cols` by `rows` terminal whose reads see up to `scrollback` rows above the screen.
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        let size = Size::new(cols, rows);
        Self::with_scrollback(size, Scrollback::with_default_split(scrollback, size.cols))
    }

    fn with_scrollback(size: Size, scrollback: Scrollback) -> Self {
        Screen {
            terminal: Terminal::new(size, scrollback.in_alacritty, scrollback.feed()),
            status_glyph: None,
            title_negotiation: TitleNegotiation::default(),
            deferred_status_title: false,
            splitter: Splitter::default(),
            modes: KeptModes::default(),
            tab_stops: TabStops::new(size.cols),
            scrollback,
        }
    }

    /// Sets the colors used to reply to subsequent OSC 4, 10, 11 and 12 queries.
    pub fn set_colors(&mut self, colors: TerminalColors) {
        self.terminal.colors = colors;
    }

    /// Sets or clears the status glyph. When the glyph changes and the title is eligible,
    /// returns the title sequence viewers need now. This may repeat the title viewers already see.
    /// During a synchronized update the title sequence follows the output that closes it.
    pub fn set_status_glyph(&mut self, glyph: Option<String>) -> Vec<u8> {
        let glyph = glyph.and_then(|mut glyph| {
            glyph.retain(|ch| !ch.is_control());
            (!glyph.is_empty()).then_some(glyph)
        });
        if self.status_glyph == glyph {
            return Vec::new();
        }
        self.status_glyph = glyph;
        if self.synchronized_update_deadline().is_some() {
            self.deferred_status_title = true;
            return Vec::new();
        }
        self.status_title_output()
    }

    fn take_deferred_status_title(&mut self) -> Vec<u8> {
        if !self.deferred_status_title || self.synchronized_update_deadline().is_some() {
            return Vec::new();
        }
        self.deferred_status_title = false;
        self.status_title_output()
    }

    fn status_title_output(&self) -> Vec<u8> {
        if self.title_negotiation == TitleNegotiation::Eligible {
            self.title_output()
        } else {
            Vec::new()
        }
    }

    /// Seeds the native title saved alongside a checkpoint's redraw, keeping the eligibility
    /// recovered from that redraw.
    pub fn restore_title(&mut self, title: &str) {
        self.terminal.restore_title(title);
    }

    /// What the scrollback takes in memory.
    pub fn scrollback_bytes(&self) -> usize {
        self.scrollback.bytes(&self.terminal)
    }

    /// How many scrollback rows are kept.
    pub fn scrollback_rows(&self) -> usize {
        self.scrollback.rows(&self.terminal)
    }

    /// The number of columns.
    pub fn cols(&self) -> u16 {
        self.size().cols as u16
    }

    /// The number of rows.
    pub fn rows(&self) -> u16 {
        self.size().rows as u16
    }

    fn size(&self) -> Size {
        let grid = self.terminal.grid();
        Size {
            cols: alacritty_terminal::grid::Dimensions::columns(grid),
            rows: alacritty_terminal::grid::Dimensions::screen_lines(grid),
        }
    }

    /// Takes output the CLI wrote.
    pub fn feed(&mut self, bytes: &[u8]) -> ParsedOutput {
        let rows = self.rows();
        let filtered = sequences::filter(
            &mut self.splitter,
            &mut self.modes,
            bytes,
            rows,
            self.terminal.title.as_deref().is_some_and(title_has_text),
            &mut self.title_negotiation,
            self.status_glyph.as_deref(),
        );
        let mut status = Vec::new();
        let mut left_alternate = false;
        let mut parsed_to = 0;
        // alacritty parses up to each mark, so that the screen sees its state right there.
        for (at, mark) in filtered.marks {
            let on_alternate = self.on_alternate_screen();
            self.terminal.parse(&bytes[parsed_to..at]);
            parsed_to = at;
            // A tab stop goes where the cursor is: the frame an open synchronized update holds back
            // is drawn first, and the update opened again after, so that a redraw still waits.
            let tab_stop = matches!(mark, Mark::SetTabStop | Mark::ClearTabStop);
            let held_frame = tab_stop && self.synchronized_update_deadline().is_some();
            if held_frame {
                self.terminal.end_update();
            }
            left_alternate |= on_alternate && !self.on_alternate_screen();
            match mark {
                Mark::SwitchScreen => {}
                Mark::Reset => {
                    self.tab_stops = TabStops::new(self.size().cols);
                    status.push(StatusEvent::Reset);
                }
                Mark::SetTabStop => self.set_tab_stop(true),
                Mark::ClearTabStop => self.set_tab_stop(false),
                Mark::ClearAllTabStops => self.tab_stops.clear_all(),
                Mark::Status(event) => {
                    if event == StatusEvent::Asked {
                        // Queued with alacritty's replies, so that they keep the queries' order.
                        self.terminal.reply(program_status::STATUS_REPLY);
                    }
                    status.push(event);
                }
            }
            if held_frame {
                self.terminal.parse(b"\x1b[?2026h");
            }
        }
        let on_alternate = self.on_alternate_screen();
        self.terminal.parse(&bytes[parsed_to..]);
        left_alternate |= on_alternate && !self.on_alternate_screen();
        let requests = self.terminal.take_requests();
        let mut viewer_output = filtered.viewer_output;
        viewer_output.extend(self.take_deferred_status_title());
        ParsedOutput {
            query_replies: requests.replies,
            title_change: requests.title,
            viewer_output,
            native_activity: filtered.native_activity,
            redraw_viewers: left_alternate,
            status,
        }
    }

    fn set_tab_stop(&mut self, stop: bool) {
        let column = self.terminal.grid().cursor.point.column.0;
        self.tab_stops.set(column, stop);
    }

    /// Ends an open synchronized update, and gives what the output it held back produced.
    pub fn end_synchronized_update(&mut self) -> ParsedOutput {
        let on_alternate = self.on_alternate_screen();
        self.terminal.end_update();
        let requests = self.terminal.take_requests();
        ParsedOutput {
            query_replies: requests.replies,
            title_change: requests.title,
            viewer_output: self.take_deferred_status_title(),
            redraw_viewers: on_alternate && !self.on_alternate_screen(),
            ..ParsedOutput::default()
        }
    }

    /// The latest an open synchronized update can end, or None without one. A redraw waits for
    /// it, so that it shows the held-back output.
    pub fn synchronized_update_deadline(&self) -> Option<Instant> {
        self.terminal.update_deadline()
    }

    /// Whether a checkpoint taken now holds the whole state: the main screen shows, nothing is
    /// half-written and no synchronized update is open. The checkpoint's redraw followed by the
    /// later output then rebuilds the screen.
    pub fn at_clean_point(&self) -> bool {
        let open_update = self.synchronized_update_deadline().is_some();
        !(self.on_alternate_screen() || self.has_unfinished_unit() || open_update)
    }

    /// Whether output has stopped inside a character, escape sequence or string.
    pub fn has_unfinished_unit(&self) -> bool {
        self.splitter.is_inside_unit()
    }

    /// Whether pasted text must be bracketed.
    pub fn bracketed_paste(&self) -> bool {
        self.terminal.has(TermMode::BRACKETED_PASTE)
    }

    /// Whether cursor keys, Home and End send their application (SS3) sequences: DECCKM is on.
    pub fn application_cursor_keys(&self) -> bool {
        self.terminal.has(TermMode::APP_CURSOR)
    }

    /// Whether the CLI is on the alternate screen.
    pub fn on_alternate_screen(&self) -> bool {
        self.terminal.on_alternate()
    }

    /// The cursor, as column and row of the visible screen.
    pub fn cursor(&self) -> (u16, u16) {
        let point = self.terminal.grid().cursor.point;
        let row = point.line.0.max(0);
        (point.column.0 as u16, row as u16)
    }
}

fn title_has_text(title: &str) -> bool {
    title
        .chars()
        .any(|ch| !ch.is_control() && !ch.is_whitespace())
}

fn write_title_body(out: &mut Vec<u8>, title: &[u8], status_glyph: Option<&str>) {
    if let Some(glyph) = status_glyph
        && !title
            .strip_prefix(glyph.as_bytes())
            .is_some_and(|rest| rest.starts_with(b" "))
    {
        out.extend_from_slice(glyph.as_bytes());
        out.push(b' ');
    }
    out.extend_from_slice(title);
}
