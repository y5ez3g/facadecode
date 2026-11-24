//! Where a screen keeps the scrollback rows alacritty no longer holds.
//!
//! alacritty holds only the newest [`SHORT_HISTORY`](crate::SHORT_HISTORY) rows of scrollback.
//! Each row it lets go of arrives through [`StoreFeed`] and is kept compact ([`crate::compact`]).
//! The store keeps at most as many rows as the scrollback may have, and, so that heavily styled
//! output cannot take more memory than plain text, lets go of whole blocks of its oldest rows
//! while they take more than their share of [`SCROLLBACK_BUDGET`].

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use alacritty_terminal::grid::{Dimensions, Grid, HistoryKeeper, Row};
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Cell;

use crate::compact::{BLOCK_ROWS, Block, carries};

/// The memory one screen's scrollback may take: alacritty's rows of scrollback with the rows it
/// reserves ahead, and the store's rows.
pub const SCROLLBACK_BUDGET: usize = 2 * 1024 * 1024;

/// About how many rows one scratch grid reflows at once.
const REFLOW_ROWS: usize = 256;

/// The scrollback rows older than alacritty's, oldest first.
pub(crate) struct Store {
    blocks: VecDeque<Block>,
    /// Rows at the front of the first block that were let go of.
    gone_in_first: usize,
    /// Rows let go of at the front since the scrollback was last cleared.
    discarded: usize,
    rows: usize,
    max_rows: usize,
    max_bytes: usize,
    /// What the blocks take, kept up to date.
    block_bytes: usize,
    /// Whether the byte bound let go of rows since the scrollback was last cleared.
    trimmed: bool,
    /// Set while the screen resizes: the rows alacritty lets go of then leave the whole scrollback.
    pub(crate) dropping: bool,
}

impl Store {
    pub(crate) fn new(max_rows: usize, max_bytes: usize) -> Self {
        Store {
            blocks: VecDeque::new(),
            gone_in_first: 0,
            discarded: 0,
            rows: 0,
            max_rows,
            max_bytes,
            block_bytes: 0,
            trimmed: false,
            dropping: false,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.rows
    }

    pub(crate) fn discarded(&self) -> usize {
        self.discarded
    }

    /// What the store takes: its blocks, by capacity, and the queue of them.
    pub(crate) fn bytes(&self) -> usize {
        self.blocks.capacity() * size_of::<Block>() + self.block_bytes
    }

    /// Whether the byte bound let go of rows since the scrollback was last cleared.
    pub(crate) fn trimmed(&self) -> bool {
        self.trimmed
    }

    pub(crate) fn set_max_rows(&mut self, rows: usize) {
        self.max_rows = rows;
    }

    pub(crate) fn set_max_bytes(&mut self, bytes: usize) {
        self.max_bytes = bytes;
        self.fit_bytes();
    }

    /// Adds `row` as the newest.
    pub(crate) fn push(&mut self, row: &Row<Cell>) {
        if self.dropping || self.max_rows == 0 {
            return;
        }
        let width = row.len() as u16;
        let fits = self.blocks.back().is_some_and(|last| last.fits(width));
        if !fits {
            self.seal_newest();
            let block = Block::new(width);
            self.block_bytes += block.bytes();
            self.blocks.push_back(block);
        }
        let full = self.update_newest(|block| {
            block.push(row);
            block.len() == BLOCK_ROWS
        });
        if full {
            self.seal_newest();
        }
        self.rows += 1;
        self.trim(self.max_rows);
        self.fit_bytes();
    }

    /// Runs `update` on the newest block and counts what it changes its size by.
    fn update_newest<R>(&mut self, update: impl FnOnce(&mut Block) -> R) -> R {
        let block = self.blocks.back_mut().expect("a newest block");
        let before = block.bytes();
        let result = update(block);
        self.block_bytes = self.block_bytes - before + block.bytes();
        result
    }

    fn seal_newest(&mut self) {
        if self.blocks.back().is_some_and(Block::is_open) {
            self.update_newest(Block::seal);
        }
    }

    /// Lets go of every row: alacritty cleared its scrollback.
    pub(crate) fn clear(&mut self) {
        self.let_go_of_all();
        self.trimmed = false;
        self.discarded = 0;
    }

    fn let_go_of_all(&mut self) {
        *self = Store {
            discarded: self.discarded,
            trimmed: self.trimmed,
            dropping: self.dropping,
            ..Store::new(self.max_rows, self.max_bytes)
        };
    }

    /// Lets go of the oldest rows past the newest `keep`.
    pub(crate) fn trim(&mut self, keep: usize) {
        let Some(extra) = self.rows.checked_sub(keep).filter(|&extra| extra > 0) else {
            return;
        };
        self.rows -= extra;
        self.gone_in_first += extra;
        self.discarded += extra;
        while self
            .blocks
            .front()
            .is_some_and(|first| first.len() <= self.gone_in_first)
        {
            let first = self.blocks.pop_front().expect("the oldest block");
            self.gone_in_first -= first.len();
            self.block_bytes -= first.bytes();
        }
        if self.rows == 0 {
            self.let_go_of_all();
        }
    }

    /// Lets go of whole oldest blocks while the store takes more than it may.
    fn fit_bytes(&mut self) {
        while self.bytes() > self.max_bytes {
            let Some(first) = self.blocks.pop_front() else {
                break;
            };
            let discarded = first.len() - std::mem::take(&mut self.gone_in_first);
            self.rows -= discarded;
            self.discarded += discarded;
            self.block_bytes -= first.bytes();
            self.trimmed = true;
        }
        if self.rows == 0 {
            self.let_go_of_all();
        }
    }

    /// The block holding row `index` (the oldest kept is 0), the row's place in it, and the place
    /// of the block's first kept row.
    fn locate(&self, index: usize) -> (usize, usize, usize) {
        let mut place = self.gone_in_first + index;
        for (number, block) in self.blocks.iter().enumerate() {
            if place < block.len() {
                let first_kept = if number == 0 { self.gone_in_first } else { 0 };
                return (number, place, first_kept);
            }
            place -= block.len();
        }
        panic!("no row {index}: the store keeps {}", self.rows)
    }

    pub(crate) fn marks(&self, index: usize) -> u8 {
        let (number, place, _) = self.locate(index);
        self.blocks[number].marks(place)
    }

    /// Every kept row of the block that holds row `index`, built back, and the index of the first.
    pub(crate) fn block_of(&self, index: usize) -> (usize, Vec<Row<Cell>>) {
        let (number, place, first_kept) = self.locate(index);
        let block = &self.blocks[number];
        let rows = (first_kept..block.len())
            .map(|place| block.row(place))
            .collect();
        (index + first_kept - place, rows)
    }

    /// Takes the newest `count` rows out, and gives them oldest first.
    pub(crate) fn take_newest(&mut self, count: usize) -> Vec<Row<Cell>> {
        let mut wanted = count.min(self.rows);
        let mut newest_first = Vec::with_capacity(wanted);
        while wanted > 0 {
            let first_kept = if self.blocks.len() == 1 {
                self.gone_in_first
            } else {
                0
            };
            let block = self.blocks.back().expect("a block holding the rows");
            let taken = wanted.min(block.len() - first_kept);
            let from = block.len() - taken;
            newest_first.extend((from..block.len()).rev().map(|place| block.row(place)));
            if from == first_kept {
                let emptied = self.blocks.pop_back().expect("that block");
                self.block_bytes -= emptied.bytes();
                if self.blocks.is_empty() {
                    self.gone_in_first = 0;
                }
            } else {
                self.update_newest(|block| block.truncate(from));
            }
            self.rows -= taken;
            wanted -= taken;
        }
        newest_first.reverse();
        newest_first
    }

    /// Takes every row out, to read back with [`TakenRows::for_each`]. `trimmed` stays.
    pub(crate) fn take_all(&mut self) -> TakenRows {
        let taken = TakenRows {
            gone_in_first: self.gone_in_first,
            blocks: std::mem::take(&mut self.blocks),
        };
        self.let_go_of_all();
        taken
    }
}

/// Rows taken out of a store, still compact.
pub(crate) struct TakenRows {
    gone_in_first: usize,
    blocks: VecDeque<Block>,
}

impl TakenRows {
    /// Builds every row back, oldest first, and gives it to `each`.
    fn for_each(self, mut each: impl FnMut(Row<Cell>)) {
        let skips = std::iter::once(self.gone_in_first).chain(std::iter::repeat(0));
        for (block, skip) in self.blocks.into_iter().zip(skips) {
            for place in skip..block.len() {
                each(block.row(place));
            }
        }
    }
}

/// The store in alacritty's grid: each row the grid's scrollback lets go of comes here.
pub(crate) struct StoreFeed(pub(crate) Arc<Mutex<Store>>);

impl HistoryKeeper<Cell> for StoreFeed {
    fn evicted(&mut self, row: &Row<Cell>) {
        lock(&self.0).push(row);
    }

    fn cleared(&mut self) {
        lock(&self.0).clear();
    }
}

/// The store, locked. A panic that poisoned the lock left no row half-written, so the store is
/// used as it is.
pub(crate) fn lock(store: &Mutex<Store>) -> MutexGuard<'_, Store> {
    match store.lock() {
        Ok(store) => store,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Reflows `rows` from `old` columns to `new` and gives each resulting row to `each`, oldest
/// first, exactly as alacritty reflows rows of its own scrollback.
///
/// alacritty reflows each line of scrollback by itself, so batches of whole lines, about
/// [`REFLOW_ROWS`] rows each, go through a scratch grid: one screen line high, the cursor at its
/// start, the batch in its scrollback, where the reflow cannot reach anything else.
pub(crate) fn reflow(rows: TakenRows, old: usize, new: usize, mut each: impl FnMut(&Row<Cell>)) {
    let mut reflow_batch = |batch: Vec<Row<Cell>>| {
        if batch.is_empty() {
            return;
        }
        let room = batch.len() * (old + 2) + 2;
        let mut scratch: Grid<Cell> = Grid::new(1, old, room);
        for row in batch {
            scratch[Line(0)] = row;
            scratch.scroll_up(&(Line(0)..Line(1)), 1);
        }
        scratch.resize(true, 1, new);
        let top = -(scratch.history_size() as i32);
        (top..0).for_each(|line| each(&scratch[Line(line)]));
    };
    let mut batch = Vec::with_capacity(REFLOW_ROWS);
    rows.for_each(|row| {
        let line_ends = !carries(&row);
        batch.push(row);
        if line_ends && batch.len() >= REFLOW_ROWS {
            reflow_batch(std::mem::replace(
                &mut batch,
                Vec::with_capacity(REFLOW_ROWS),
            ));
        }
    });
    reflow_batch(batch);
}
