//! How a screen keeps its scrollback: the newest rows in alacritty, the older ones in a store.

use std::sync::{Arc, Mutex};

use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::term::cell::Cell;

use crate::SHORT_HISTORY;
use crate::store::{SCROLLBACK_BUDGET, Store, StoreFeed, lock};
use crate::terminal::Terminal;

/// The rows alacritty sets up ahead each time its scrollback grows: `MAX_CACHE_SIZE` in the
/// vendored copy.
pub(crate) const RESERVED_ROWS: usize = 32;

/// What one row of alacritty's grid takes at `cols` columns.
pub(crate) fn row_bytes(cols: usize) -> usize {
    size_of::<Row<Cell>>() + size_of::<Cell>() * cols
}

/// The share of `budget` the store gets: what is left after alacritty's `in_alacritty` rows and
/// the rows it reserves ahead.
pub(crate) fn store_bytes(budget: usize, in_alacritty: usize, cols: usize) -> usize {
    let alacritty = row_bytes(cols) * (in_alacritty + RESERVED_ROWS);
    budget.saturating_sub(alacritty)
}

/// See the module documentation.
pub(crate) struct Scrollback {
    /// How many rows a read may see. One more row is kept, so that a read can tell whether any
    /// row was let go of.
    pub(crate) readable: usize,
    /// How many rows alacritty keeps: [`SHORT_HISTORY`], or every row when there is no store.
    pub(crate) in_alacritty: usize,
    /// The older rows, when the scrollback is longer than alacritty's part.
    pub(crate) store: Option<Arc<Mutex<Store>>>,
    /// The memory the scrollback may take.
    pub(crate) budget: usize,
}

impl Scrollback {
    /// A scrollback of `readable` rows, of which alacritty keeps up to `in_alacritty`, for a screen
    /// `cols` wide.
    pub(crate) fn new(readable: usize, in_alacritty: usize, cols: usize) -> Self {
        let max_rows = max_rows(readable);
        let in_alacritty = in_alacritty.min(max_rows);
        let budget = SCROLLBACK_BUDGET;
        let store = (in_alacritty < max_rows).then(|| {
            let bytes = store_bytes(budget, in_alacritty, cols);
            Arc::new(Mutex::new(Store::new(max_rows - in_alacritty, bytes)))
        });
        Scrollback {
            readable,
            in_alacritty,
            store,
            budget,
        }
    }

    /// The default split: alacritty keeps [`SHORT_HISTORY`] rows.
    pub(crate) fn with_default_split(readable: usize, cols: usize) -> Self {
        Self::new(readable, SHORT_HISTORY, cols)
    }

    /// What alacritty passes the rows it lets go of to.
    pub(crate) fn feed(&self) -> Option<StoreFeed> {
        self.store.clone().map(StoreFeed)
    }

    /// The most rows kept: one more than a read sees.
    pub(crate) fn max_rows(&self) -> usize {
        max_rows(self.readable)
    }

    pub(crate) fn rows(&self, terminal: &Terminal) -> usize {
        let stored = self.store.as_deref().map_or(0, |store| lock(store).len());
        stored + terminal.main_grid().history_size()
    }

    /// alacritty's rows and the ones it reserved ahead, as full cells, and the store's rows.
    pub(crate) fn bytes(&self, terminal: &Terminal) -> usize {
        let grid = terminal.main_grid();
        let stored = self.store.as_deref().map_or(0, |store| lock(store).bytes());
        match grid.history_size() {
            0 => stored,
            rows => stored + row_bytes(grid.columns()) * (rows + RESERVED_ROWS),
        }
    }
}

fn max_rows(readable: usize) -> usize {
    if readable == 0 { 0 } else { readable + 1 }
}
