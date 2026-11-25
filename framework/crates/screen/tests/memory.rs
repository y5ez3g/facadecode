//! What a screen takes in memory, in bytes allocated by the thread that uses it: the daemon holds a
//! screen for each running agent and a placeholder for each ended one.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell as Count;

use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::vte::ansi::{Handler, Processor};
use facade_screen::{Screen, VisibleCell};

thread_local! {
    /// The bytes this thread allocated and has not freed, so that tests side by side count apart.
    static ALLOCATED: Count<isize> = const { Count::new(0) };
    static PEAK: Count<isize> = const { Count::new(0) };
}

fn add(bytes: isize) {
    // A thread that is ending has no count any more.
    let _ = ALLOCATED.try_with(|allocated| {
        let total = allocated.get() + bytes;
        allocated.set(total);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(total)));
    });
}

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            add(layout.size() as isize);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        add(-(layout.size() as isize));
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// The bytes `make` allocated and what it made keeps.
fn kept<T>(make: impl FnOnce() -> T) -> (T, usize) {
    let before = ALLOCATED.get();
    let made = make();
    (made, (ALLOCATED.get() - before) as usize)
}

const COLS: u16 = 120;
const ROWS: u16 = 30;
/// The cells of the main and the alternate screen.
const CELLS: usize = 2 * COLS as usize * ROWS as usize * size_of::<Cell>();
/// What a screen keeps besides its cells: the rows' lengths, tab stops, modes and buffers.
const BESIDES: usize = 16 * 1024;

#[test]
fn a_new_screen_takes_its_cells_and_little_more() {
    let (_screen, bytes) = kept(|| Screen::new(COLS, ROWS, 10_000));
    assert!(
        bytes < CELLS + BESIDES,
        "{bytes} bytes for {CELLS} bytes of cells"
    );
}

#[test]
fn the_smallest_screen_takes_almost_nothing() {
    let (_screen, bytes) = kept(|| Screen::new(2, 1, 0));
    assert!(bytes < BESIDES, "{bytes} bytes");
}

#[test]
fn a_view_keeps_single_characters_inside_its_cells() {
    let mut screen = Screen::new(COLS, ROWS, 0);
    screen.feed("a界🤖".as_bytes());
    let (_view, bytes) = kept(|| screen.view());
    let cells = COLS as usize * ROWS as usize * size_of::<VisibleCell>();
    assert!(
        bytes <= cells + 1024,
        "{bytes} bytes for {cells} bytes of cells"
    );
}

/// The output a synchronized update holds back takes memory until the update ends, however it ends.
#[test]
fn a_synchronized_update_takes_memory_only_while_it_is_open() {
    let frame: Vec<u8> = (0..10_000)
        .flat_map(|at| {
            format!("\x1b[{};1H\x1b[3{}mframe {at:>6}", 1 + at % 30, at % 8).into_bytes()
        })
        .collect();
    assert!(frame.len() > 200 * 1024, "{} bytes", frame.len());
    let mut screen = Screen::new(COLS, ROWS, 10_000);
    screen.feed(&frame);
    let ((), bytes) = kept(|| {
        screen.feed(b"\x1b[?2026h");
        drop(screen.feed(&frame));
        assert!(screen.synchronized_update_deadline().is_some());
        drop(screen.feed(b"\x1b[?2026l"));
        assert!(screen.synchronized_update_deadline().is_none());
    });
    assert!(bytes < 4096, "{bytes} bytes after the CLI's own end");
    let ((), bytes) = kept(|| {
        screen.feed(b"\x1b[?2026h");
        drop(screen.feed(&frame));
        drop(screen.end_synchronized_update());
        assert!(screen.synchronized_update_deadline().is_none());
    });
    assert!(bytes < 4096, "{bytes} bytes after the end at its deadline");
}

/// The most output a synchronized update holds back: the parser's own limit, which it took at once
/// before.
const HELD_BACK: usize = 2 * 1024 * 1024;

// Drive the same parser as Screen with a handler that allocates nothing, so the peak counts only
// the update buffer and excludes Screen's output for viewers.
struct NoopHandler;

impl Handler for NoopHandler {}

/// Counts allocations from inside each feed, including a buffer's old and new allocations while
/// it grows. The allocator's default realloc allocates and copies before freeing the old buffer.
fn measure_peak() -> isize {
    let from = ALLOCATED.get();
    PEAK.set(from);
    from
}

fn expect_peak_within_limit(from: isize) {
    let peak = PEAK.get() - from;
    assert!(peak <= HELD_BACK as isize, "{peak} bytes at peak");
}

#[test]
fn an_update_in_one_read_does_not_take_a_sync_buffer() {
    let mut parser: Processor = Processor::new();
    let from = measure_peak();
    parser.advance(&mut NoopHandler, b"\x1b[?2026h\x1b[Hone frame\x1b[?2026l");
    assert!(parser.sync_timeout().sync_timeout().is_none());
    assert_eq!(PEAK.get() - from, 0, "complete frame heap bytes");
}

#[test]
fn a_small_update_split_across_reads_takes_only_the_first_block() {
    let mut parser: Processor = Processor::new();
    let from = measure_peak();
    parser.advance(&mut NoopHandler, b"\x1b[?2026h");
    parser.advance(&mut NoopHandler, &[b'x'; 3000]);
    assert_eq!(parser.sync_bytes_count(), 3000);
    parser.advance(&mut NoopHandler, b"\x1b[?2026l");
    assert!(parser.sync_timeout().sync_timeout().is_none());
    assert!(
        PEAK.get() - from <= 4096,
        "{} bytes at peak",
        PEAK.get() - from
    );
    assert_eq!(ALLOCATED.get(), from, "after the update");
}

/// Feeds uneven writes, as a CLI would. A buffer that doubles without a cap outgrows the parser's
/// limit before the update reaches it.
fn advance_in_uneven_chunks(parser: &mut Processor, mut output: &[u8]) {
    let mut sizes = [60_000, 4_099, 131_071, 1_023, 65_521].into_iter().cycle();
    while !output.is_empty() {
        let (write, rest) = output.split_at(sizes.next().unwrap().min(output.len()));
        parser.advance(&mut NoopHandler, write);
        output = rest;
    }
}

#[test]
fn an_update_up_to_the_parser_s_limit_holds_no_more_than_the_limit() {
    let mut parser = Processor::new();
    let output = vec![b'x'; HELD_BACK + 200_000];
    let from = measure_peak();
    parser.advance(&mut NoopHandler, b"\x1b[?2026h");
    advance_in_uneven_chunks(&mut parser, &output);
    assert!(
        parser.sync_timeout().sync_timeout().is_none(),
        "the parser ends the update at its limit"
    );
    expect_peak_within_limit(from);
    assert_eq!(ALLOCATED.get(), from, "after the update");
}

#[test]
fn large_updates_one_after_another_each_give_their_memory_back() {
    let mut parser = Processor::new();
    let output = vec![b'x'; HELD_BACK - 100_000];
    for update in 0..3 {
        let from = measure_peak();
        parser.advance(&mut NoopHandler, b"\x1b[?2026h");
        advance_in_uneven_chunks(&mut parser, &output);
        parser.advance(&mut NoopHandler, b"\x1b[?2026l");
        expect_peak_within_limit(from);
        assert!(parser.sync_timeout().sync_timeout().is_none());
        assert_eq!(ALLOCATED.get(), from, "after update {update}");
    }
}

/// One write ends an update and begins the next. Only that open update still needs the buffer.
#[test]
fn an_update_that_ends_inside_a_write_leaves_the_buffer_to_the_next_alone() {
    let mut parser: Processor = Processor::new();
    let first = vec![b'x'; 900_000];
    let mut write = vec![b'x'; 950_000];
    write.extend_from_slice(b"\x1b[?2026loutside\x1b[?2026h");
    write.resize(write.len() + 100_000, b'y');
    let from = measure_peak();
    parser.advance(&mut NoopHandler, b"\x1b[?2026h");
    parser.advance(&mut NoopHandler, &first);
    parser.advance(&mut NoopHandler, &write);
    assert!(
        parser.sync_timeout().sync_timeout().is_some(),
        "the next update is open"
    );
    parser.advance(&mut NoopHandler, b"before\x1b[?2026lafter");
    assert!(parser.sync_timeout().sync_timeout().is_none());
    expect_peak_within_limit(from);
    assert_eq!(ALLOCATED.get(), from, "after both updates");
}
