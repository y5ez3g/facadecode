//! alacritty reserves 32 rows ahead, not 1,000, when a CLI's first row leaves the screen for the
//! history: measured by counting what this test process allocates. It is the only test in this
//! binary, so that nothing else allocates meanwhile.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use facade_screen::Screen;

/// The bytes allocated and not yet freed.
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            ALLOCATED.fetch_add(layout.size(), Ordering::SeqCst);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        ALLOCATED.fetch_sub(layout.size(), Ordering::SeqCst);
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

#[test]
fn a_first_row_of_history_reserves_a_few_rows_not_a_thousand() {
    let mut screen = Screen::new(120, 30, 10_000);
    let before = ALLOCATED.load(Ordering::SeqCst);
    screen.feed(&b"\r\n".repeat(30));
    let grown = ALLOCATED.load(Ordering::SeqCst).saturating_sub(before);
    // A row of 120 cells takes 2,880 bytes: one row of history and 32 reserved come to about 95 KB,
    // 1,000 reserved to 2.9 MB.
    assert!(
        grown < 200 * 1024,
        "the first row of history allocated {grown} bytes"
    );
    assert_eq!(screen.scrollback_rows(), 1);
}
