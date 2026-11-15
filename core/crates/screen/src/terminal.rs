//! alacritty's side of a screen: its grid and modes, its parser, and what it asks to send back.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};

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
            parser: Processor::new(),
            outbox,
        }
    }

    pub(crate) fn parse(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    /// Applies the output an open synchronized update holds back, and closes the update.
    pub(crate) fn end_update(&mut self) {
        self.parser.stop_sync(&mut self.term);
    }

    pub(crate) fn update_deadline(&self) -> Option<Instant> {
        self.parser.sync_timeout().sync_timeout()
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

    /// Takes what alacritty asked for. Colour queries are left unanswered: a viewer's theme is
    /// unknown.
    pub(crate) fn take_requests(&self) -> Requests {
        let queued = match self.outbox.0.lock() {
            Ok(mut queued) => std::mem::take(&mut *queued),
            Err(_) => return Requests::default(),
        };
        let mut requests = Requests::default();
        for event in queued {
            match event {
                Event::PtyWrite(text) => requests.replies.extend(text.into_bytes()),
                Event::Title(title) => requests.title = Some(title),
                Event::ResetTitle => requests.title = Some(String::new()),
                _ => {}
            }
        }
        requests
    }
}
