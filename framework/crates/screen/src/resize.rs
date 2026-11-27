//! Resizing: alacritty reflows the screen and its own scrollback rows; the store's rows must come
//! out as if alacritty had reflowed them too.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;

use crate::Screen;
use crate::compact::{CARRIES, WRAPPED};
use crate::scrollback::store_bytes;
use crate::store::{self, Store, lock};
use crate::terminal::Size;

impl Screen {
    /// Changes the size. The scrollback reflows to the new width, the scrolling region becomes the
    /// whole screen, and tab stops stay, with the default ones in new columns.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (old, new) = (self.size(), Size::new(cols, rows));
        if old == new {
            return;
        }
        self.discard_cursor_restore();
        if self.scrollback.store.is_some() {
            self.resize_across_store(old, new);
        } else {
            self.terminal.term.resize(new);
        }
        self.tab_stops.resize(new.cols);
        self.modes.scroll_region = None;
    }

    /// Resizes a screen whose oldest scrollback rows are in the store.
    ///
    /// alacritty reflows each scrollback line by itself, except near the bottom, where the cursor's
    /// rows and how many rows its scrollback has change the result. So the store first hands
    /// alacritty the rows that decide that: the start of a line alacritty holds the rest of, the
    /// rows a taller screen pulls down, and on widening, whole lines enough to fill the screen
    /// twice once joined. alacritty resizes with those; the store's other rows reflow apart
    /// ([`store::reflow`]) and come back in front of what alacritty no longer keeps.
    fn resize_across_store(&mut self, old: Size, new: Size) {
        let store = self.scrollback.store.clone().expect("a store");
        let max_rows = self.scrollback.max_rows();
        let in_alacritty = self.scrollback.in_alacritty;
        let width_changes = old.cols != new.cols;

        let (handed_over, to_reflow) = {
            let mut store = lock(&store);
            let count = rows_for_alacritty(&mut store, self, old, new, max_rows);
            let handed_over = store.take_newest(count);
            let to_reflow = width_changes.then(|| store.take_all());
            store.dropping = true;
            store.set_max_rows(max_rows);
            (handed_over, to_reflow)
        };
        let grid = self.terminal.main_grid_mut();
        grid.update_history(max_rows);
        grid.restore_history(handed_over);
        self.terminal.term.resize(new);

        let given_back = {
            let mut store = lock(&store);
            store.dropping = false;
            if let Some(rows) = to_reflow {
                store::reflow(rows, old.cols, new.cols, |row| store.push(row));
            }
            // Past its share, alacritty's rows are the newest the store gets.
            let grid = self.terminal.main_grid();
            let held = grid.history_size();
            for line in -(held as i32)..-(held.min(in_alacritty) as i32) {
                store.push(&grid[Line(line)]);
            }
            store.take_newest(in_alacritty.saturating_sub(held))
        };
        let grid = self.terminal.main_grid_mut();
        grid.update_history(in_alacritty);
        grid.restore_history(given_back);
        grid.update_history(in_alacritty);
        let held = grid.history_size();

        let mut store = lock(&store);
        store.trim(max_rows - held);
        store.set_max_rows(max_rows - in_alacritty);
        store.set_max_bytes(store_bytes(self.scrollback.budget, in_alacritty, new.cols));
    }
}

/// Lets go of the store's rows the resize loses, then counts how many of its newest rows alacritty
/// must hold while it resizes.
fn rows_for_alacritty(
    store: &mut Store,
    screen: &Screen,
    old: Size,
    new: Size,
    max_rows: usize,
) -> usize {
    let grid = screen.terminal.main_grid();
    let held = grid.history_size();
    // Shrinking scrolls the cursor's row into view before anything reflows, which can push the
    // oldest rows out of a full scrollback.
    let scrolled = match new.rows < old.rows {
        true => (grid.cursor.point.line.0.max(0) as usize + 1).saturating_sub(new.rows),
        false => 0,
    };
    let excess = (store.len() + held + scrolled).saturating_sub(max_rows);
    let stored = store.len().saturating_sub(excess);
    store.trim(stored);

    // The marks of the store's row `from_end` rows before its newest.
    let marks = |store: &Store, from_end: usize| store.marks(stored - 1 - from_end);
    // `count` grown to reach the start of the line its oldest row belongs to.
    let to_line_start = |store: &Store, mut count: usize| {
        while old.cols != new.cols && count < stored && marks(store, count) & CARRIES != 0 {
            count += 1;
        }
        count
    };
    let pulled_down = new.rows.saturating_sub(old.rows).saturating_sub(held);
    let mut count = to_line_start(store, to_line_start(store, 0).max(pulled_down).min(stored));
    if new.cols <= old.cols {
        return count;
    }
    // Widening joins a line of k rows into at least (k - 1)(old - 1) / new rows: each row loses
    // at most a leading spacer.
    let mut joined_rows = 0;
    while joined_rows < 2 * new.rows && count < stored {
        let mut line_rows = 1;
        while count + line_rows < stored && marks(store, count + line_rows) & WRAPPED != 0 {
            line_rows += 1;
        }
        joined_rows += ((line_rows - 1) * (old.cols - 1)).div_ceil(new.cols).max(1);
        count = to_line_start(store, count + line_rows);
    }
    count
}
