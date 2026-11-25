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
pub use read::Reading;
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

/// Colors supplied for replies to OSC 10, 11 and 12 queries. An omitted color gets no reply.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerminalColors {
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
    pub cursor: Option<[u8; 3]>,
}

/// What one call to [`Screen::feed`] produced.
#[derive(Debug, Default)]
pub struct ParsedOutput {
    /// The screen's replies to terminal queries, for the CLI's input.
    pub query_replies: Vec<u8>,
    /// The title the CLI set, if it set one; empty when it reset the title.
    pub title_change: Option<String>,
    /// Output applied by this call wrote or erased cells on the cursor's current row.
    pub cursor_row_cells_written: bool,
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

/// What a complete frame wrote on the cursor's row.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CursorRowWrites {
    None,
    /// The input was drawn in a frame that began before the marked boundary.
    Earlier,
    Current,
}

/// Reads a complete frame and the provenance of any cursor row cell writes in it.
pub type FrameObserver<'a> = dyn FnMut(&Screen, CursorRowWrites) + 'a;

/// One agent's terminal, without a window. It only computes; the one time it uses is the deadline
/// alacritty puts on a synchronized update.
pub struct Screen {
    terminal: Terminal,
    status_glyph: Option<String>,
    title_negotiation: TitleNegotiation,
    deferred_status_title: bool,
    earlier_frame: bool,
    splitter: Splitter,
    modes: KeptModes,
    tab_stops: TabStops,
    scrollback: Scrollback,
    paint_waits_for_frame: bool,
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
            earlier_frame: false,
            splitter: Splitter::default(),
            modes: KeptModes::default(),
            paint_waits_for_frame: false,
            tab_stops: TabStops::new(size.cols),
            scrollback,
        }
    }

    /// Sets the colors used to reply to subsequent OSC 10, 11 and 12 queries.
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
        self.feed_observing(bytes, None)
    }

    /// Takes output and lets a reader see each complete frame, including changes away from the
    /// cursor row.
    pub fn feed_observing(
        &mut self,
        bytes: &[u8],
        mut observe: Option<&mut FrameObserver<'_>>,
    ) -> ParsedOutput {
        self.terminal.reset_damage();
        let earlier_sync = self.earlier_frame && self.is_drawing();
        let rows = self.rows();
        let filtered = sequences::filter(
            &mut self.splitter,
            &mut self.modes,
            bytes,
            rows,
            self.terminal.title.as_deref().is_some_and(title_has_text),
            &mut self.title_negotiation,
            self.status_glyph.as_deref(),
            observe.is_some() || self.paint_waits_for_frame,
        );
        let mut earlier_through = if earlier_sync {
            filtered.sync_ended_at
        } else if self.earlier_frame {
            filtered.carried_unit_ended_at
        } else {
            None
        };
        let mut status = Vec::new();
        let mut left_alternate = false;
        let mut parsed_to = 0;
        let mut new_frame = false;
        // alacritty parses up to each mark, so that the screen sees its state right there.
        for (at, mark) in filtered.marks {
            let on_alternate = self.on_alternate_screen();
            self.parse_output(bytes, parsed_to, at, &mut earlier_through, &mut observe);
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
                Mark::CarriedUnitEnd => self.finish_preexisting_frame(true),
                Mark::EndSync => {
                    self.finish_preexisting_frame(true);
                    if !self.is_drawing()
                        && let Some(observe) = &mut observe
                    {
                        new_frame |= self.observe_frame(observe, self.earlier_frame);
                        self.terminal.reset_damage();
                    }
                }
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
                self.terminal.reopen_update();
            }
        }
        let on_alternate = self.on_alternate_screen();
        self.parse_output(
            bytes,
            parsed_to,
            bytes.len(),
            &mut earlier_through,
            &mut observe,
        );
        left_alternate |= on_alternate && !self.on_alternate_screen();
        if let Some(observe) = observe
            && !self.is_drawing()
            && !self.has_unfinished_unit()
        {
            self.observe_frame(observe, self.earlier_frame);
        }
        let requests = self.terminal.take_requests();
        let mut viewer_output = filtered.viewer_output;
        viewer_output.extend(self.take_deferred_status_title());
        ParsedOutput {
            query_replies: requests.replies,
            title_change: requests.title,
            cursor_row_cells_written: self.take_input_drawing() || new_frame,
            viewer_output,
            native_activity: filtered.native_activity,
            redraw_viewers: left_alternate,
            status,
        }
    }

    /// The pending frame's bytes precede the input whose response the caller is observing.
    pub fn mark_pending_frame_earlier(&mut self) {
        self.earlier_frame = self.is_drawing() || self.has_unfinished_unit();
    }

    fn observe_frame(&self, observe: &mut FrameObserver<'_>, earlier: bool) -> bool {
        let writes = match (self.terminal.cursor_row_cells_written(), earlier) {
            (true, true) => CursorRowWrites::Earlier,
            (true, false) => CursorRowWrites::Current,
            (false, _) => CursorRowWrites::None,
        };
        observe(self, writes);
        writes == CursorRowWrites::Current
    }

    /// Parse any earlier frame up to its boundary before counting the later cell writes.
    fn parse_output(
        &mut self,
        bytes: &[u8],
        mut start: usize,
        end: usize,
        earlier_through: &mut Option<usize>,
        observe: &mut Option<&mut FrameObserver<'_>>,
    ) {
        if let Some(boundary) = earlier_through.take_if(|boundary| *boundary <= end) {
            self.terminal.parse(&bytes[start..boundary]);
            if !self.terminal.holds_output_back() {
                if let Some(observe) = observe {
                    self.observe_frame(observe, true);
                }
                self.earlier_frame = false;
                self.terminal.reset_damage();
            }
            start = boundary;
        }
        self.terminal.parse(&bytes[start..end]);
    }

    fn take_input_drawing(&mut self) -> bool {
        if self.earlier_frame {
            self.mark_pending_frame_earlier();
            return false;
        }
        self.terminal.cursor_row_cells_written()
    }

    fn set_tab_stop(&mut self, stop: bool) {
        let column = self.terminal.grid().cursor.point.column.0;
        self.tab_stops.set(column, stop);
    }

    /// Ends an open synchronized update, and gives what the output it held back produced.
    pub fn end_synchronized_update(&mut self) -> ParsedOutput {
        self.terminal.reset_damage();
        let on_alternate = self.on_alternate_screen();
        if self.synchronized_update_deadline().is_some() {
            self.terminal.end_update();
            // An update that ended at its timeout can still be shown to viewers.
            self.terminal.term.discard_observed_paint();
            self.finish_preexisting_frame(!self.has_unfinished_unit());
        }
        let requests = self.terminal.take_requests();
        ParsedOutput {
            query_replies: requests.replies,
            title_change: requests.title,
            cursor_row_cells_written: self.take_input_drawing(),
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

    /// Whether an open synchronized update holds a frame back: what shows is the one before it. An
    /// update opened after a frame, with nothing in it yet, holds none.
    pub fn is_drawing(&self) -> bool {
        self.terminal.holds_output_back()
    }

    /// Whether a checkpoint taken now holds the whole state: the main screen shows, nothing is
    /// half-written and no synchronized update is open. The checkpoint's redraw followed by the
    /// later output then rebuilds the screen.
    pub fn at_clean_point(&self) -> bool {
        !self.on_alternate_screen() && self.output_frame_complete()
    }

    fn output_frame_complete(&self) -> bool {
        !self.has_unfinished_unit() && self.synchronized_update_deadline().is_none()
    }

    /// Whether output has stopped inside a character, escape sequence or string.
    pub fn has_unfinished_unit(&self) -> bool {
        self.splitter.is_inside_unit()
    }

    /// Starts or stops tracking which cells the CLI paints from this point on. A synchronized
    /// frame or control sequence open at the boundary cannot supply the next observation.
    pub fn observe_paint(&mut self, enabled: bool) {
        self.paint_waits_for_frame = enabled && !self.output_frame_complete();
        self.terminal.term.observe_paint(enabled);
    }

    fn finish_preexisting_frame(&mut self, between_units: bool) {
        if self.paint_waits_for_frame
            && between_units
            && self.synchronized_update_deadline().is_none()
        {
            self.terminal.term.discard_observed_paint();
            self.paint_waits_for_frame = false;
        }
    }

    /// Whether the CLI painted the entire range since the boundary, in the visible frame.
    pub fn has_painted(&self, row: usize, columns: std::ops::Range<usize>) -> bool {
        !self.paint_waits_for_frame
            && self.output_frame_complete()
            && self.terminal.term.has_painted(row, columns)
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
