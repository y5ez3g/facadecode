//! alacritty's side of a screen: its grid and modes, its parser, and what it asks to send back.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Handler, NamedColor, Processor, Rgb, StdSyncHandler};

use crate::TerminalColors;
use crate::store::StoreFeed;

/// A screen's size. alacritty needs at least 2 columns and 1 row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Size {
    pub(crate) cols: usize,
    pub(crate) rows: usize,
}

impl Size {
    pub(crate) fn new(cols: u16, rows: u16) -> Self {
        let (cols, rows) = (cols.max(2), rows.max(1));
        Size {
            cols: cols.into(),
            rows: rows.into(),
        }
    }
}

impl Dimensions for Size {
    fn columns(&self) -> usize {
        self.cols
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn total_lines(&self) -> usize {
        self.screen_lines()
    }
}

/// What alacritty asks of its host while it parses: kept until the feed ends.
#[derive(Clone, Default)]
pub(crate) struct Outbox(Arc<Mutex<Vec<Event>>>);

impl EventListener for Outbox {
    fn send_event(&self, event: Event) {
        let Ok(mut queued) = self.0.lock() else {
            return;
        };
        queued.push(event);
    }
}

/// What alacritty asked for since the last time: replies to queries and the last title change.
#[derive(Default)]
pub(crate) struct Requests {
    pub(crate) replies: Vec<u8>,
    pub(crate) title: Option<String>,
}

/// alacritty's terminal and parser.
pub(crate) struct Terminal {
    pub(crate) term: Term<Outbox>,
    pub(crate) colors: TerminalColors,
    pub(crate) title: Option<String>,
    parser: Processor<StdSyncHandler>,
    outbox: Outbox,
}

impl Terminal {
    /// A terminal of `size` keeping up to `scrollback` rows itself, and handing the rows it lets go
    /// of to `feed`, if any.
    pub(crate) fn new(size: Size, scrollback: usize, feed: Option<StoreFeed>) -> Self {
        let outbox = Outbox::default();
        let config = Config {
            scrolling_history: scrollback,
            // A viewer's terminal may not take kitty keyboard reports.
            kitty_keyboard: false,
            ..Default::default()
        };
        let mut term = Term::new(config, &size, outbox.clone());
        if let Some(feed) = feed {
            term.grid_mut().set_history_keeper(Box::new(feed));
        }
        Terminal {
            term,
            colors: TerminalColors::default(),
            title: None,
            parser: Processor::new(),
            outbox,
        }
    }

    pub(crate) fn parse(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    pub(crate) fn reset_damage(&mut self) {
        self.term.reset_damage();
    }

    pub(crate) fn cursor_row_cells_written(&self) -> bool {
        self.term.cursor_row_cells_written()
    }

    pub(crate) fn restore_title(&mut self, title: &str) {
        // Seed alacritty too, so a subsequent native title-stack push sees the restored title.
        self.term.set_title(Some(title.to_owned()));
        self.take_requests();
    }

    /// Applies the output an open synchronized update holds back, and closes the update.
    pub(crate) fn end_update(&mut self) {
        self.parser.stop_sync(&mut self.term);
    }

    pub(crate) fn update_deadline(&self) -> Option<Instant> {
        self.parser.sync_timeout().sync_timeout()
    }

    /// Opens a synchronized update again behind a frame it was made to show before its end: what
    /// follows belongs to that frame.
    pub(crate) fn reopen_update(&mut self) {
        self.parser.resume_sync(&mut self.term);
    }

    /// Whether an open synchronized update holds output back.
    pub(crate) fn holds_output_back(&self) -> bool {
        self.parser.sync_holds_output()
    }

    pub(crate) fn has(&self, mode: TermMode) -> bool {
        self.term.mode().contains(mode)
    }

    pub(crate) fn on_alternate(&self) -> bool {
        self.has(TermMode::ALT_SCREEN)
    }

    /// The grid in use: the alternate one while it shows.
    pub(crate) fn grid(&self) -> &Grid<Cell> {
        self.term.grid()
    }

    /// The main screen's grid, the one with scrollback.
    pub(crate) fn main_grid(&self) -> &Grid<Cell> {
        self.term.primary_grid()
    }

    pub(crate) fn main_grid_mut(&mut self) -> &mut Grid<Cell> {
        self.term.primary_grid_mut()
    }

    /// Queues `reply` behind the replies alacritty has queued.
    pub(crate) fn reply(&self, reply: &str) {
        self.outbox.send_event(Event::PtyWrite(reply.to_owned()));
    }

    /// Takes what alacritty asked for, replying to color queries only with supplied colors.
    pub(crate) fn take_requests(&mut self) -> Requests {
        let queued = match self.outbox.0.lock() {
            Ok(mut queued) => std::mem::take(&mut *queued),
            Err(_) => return Requests::default(),
        };
        let mut requests = Requests::default();
        for event in queued {
            match event {
                Event::PtyWrite(text) => requests.replies.extend(text.into_bytes()),
                Event::ColorRequest(index, formatter) => {
                    let color = match index {
                        index if index == NamedColor::Foreground as usize => self.colors.foreground,
                        index if index == NamedColor::Background as usize => self.colors.background,
                        index if index == NamedColor::Cursor as usize => self.colors.cursor,
                        _ => None,
                    };
                    if let Some([r, g, b]) = color {
                        requests
                            .replies
                            .extend(formatter(Rgb { r, g, b }).into_bytes());
                    }
                }
                Event::Title(title) => requests.title = Some(title),
                Event::ResetTitle => requests.title = Some(String::new()),
                _ => {}
            }
        }
        if let Some(title) = &requests.title {
            self.title = Some(title.clone());
        }
        requests
    }
}
