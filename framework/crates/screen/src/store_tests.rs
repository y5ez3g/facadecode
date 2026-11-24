//! A screen that keeps its older rows compact reads, redraws and reflows exactly as one that keeps
//! every row of its history in alacritty; and its scrollback stays within its bounds whatever is
//! printed.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Hyperlink;
use alacritty_terminal::vte::ansi::Color;

use alacritty_terminal::grid::Row;
use alacritty_terminal::term::cell::Cell;

use super::*;
use crate::scrollback::{RESERVED_ROWS, Scrollback, row_bytes, store_bytes};
use crate::store::lock;
use crate::terminal::Size;

impl Screen {
    /// A screen whose alacritty keeps at most `short` rows of scrollback; with `short` at least
    /// the whole scrollback, every row stays in alacritty.
    fn with_short_scrollback(cols: u16, rows: u16, scrollback: usize, short: usize) -> Self {
        let size = Size::new(cols, rows);
        Self::with_scrollback(size, Scrollback::new(scrollback, short, size.cols))
    }
}

/// A small deterministic generator, so that every failure can be run again by its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &[
    "alpha",
    "beta",
    "x",
    "[x]",
    "{a}",
    "back\\slash",
    "你好",
    "世界",
    "🙂",
    "e\u{301}",
    "a\u{300}\u{316}",
    "\t",
    "  ",
    "—",
    "ﾊﾞ",
    "z",
];

fn sgr(rng: &mut Rng) -> String {
    match rng.below(17) {
        0 => "\x1b[0m".into(),
        1 => "\x1b[1m".into(),
        2 => "\x1b[2m".into(),
        3 => "\x1b[7m".into(),
        4 => "\x1b[4m".into(),
        5 => "\x1b[4:3m".into(),
        6 => "\x1b[9m".into(),
        7 => format!("\x1b[3{}m", rng.below(8)),
        8 => format!("\x1b[4{}m", rng.below(8)),
        9 => format!("\x1b[9{}m", rng.below(8)),
        10 => format!("\x1b[38;5;{}m", rng.below(256)),
        11 => format!("\x1b[48;5;{}m", rng.below(256)),
        12 => format!(
            "\x1b[38;2;{};{};{}m",
            rng.below(256),
            rng.below(256),
            rng.below(256)
        ),
        13 => format!("\x1b[58;5;{}m", rng.below(256)),
        14 => format!(
            "\x1b[58;2;{};{};{}m",
            rng.below(256),
            rng.below(256),
            rng.below(256)
        ),
        15 => "\x1b[22;27;24;59m".into(),
        _ => "\x1b[3m\x1b[8m".into(),
    }
}

fn text(rng: &mut Rng, words: usize) -> String {
    let mut out = String::new();
    for _ in 0..words {
        if rng.chance(30) {
            out.push_str(&sgr(rng));
        }
        match rng.below(40) {
            0 => out.push_str("\x1b]8;;https://example.com/plain\x1b\\link\x1b]8;;\x1b\\"),
            1 => out.push_str(&format!(
                "\x1b]8;id=n{};https://example.com/{}\x1b\\named\x1b]8;;\x1b\\",
                rng.below(3),
                rng.below(3)
            )),
            2 => out.push_str("\x1b]8;;https://example.com/open\x1b\\"),
            3 => out.push_str("\x1b]8;;\x1b\\"),
            _ => {}
        }
        out.push_str(rng.pick(WORDS));
        if rng.chance(70) {
            out.push(' ');
        }
    }
    out
}

/// One step of varied output, or a resize: what a busy CLI does to its terminal.
fn step(rng: &mut Rng, cols: usize, rows: usize) -> Result<String, (u16, u16)> {
    Ok(match rng.below(24) {
        0..=5 => {
            let words = rng.below(12) as usize;
            format!(
                "{}{}",
                text(rng, words),
                if rng.chance(80) { "\r\n" } else { "\n" }
            )
        }
        6 | 7 => {
            // A line longer than the screen: soft wraps.
            let mut line = String::new();
            while line.chars().count() < cols * (1 + rng.below(4) as usize) {
                line.push_str(&text(rng, 3));
            }
            line.push_str("\r\n");
            line
        }
        8 | 9 => {
            // A burst of numbered lines: the history fills and rows leave it.
            let count = 20 + rng.below(250);
            let base = rng.below(1_000_000);
            (0..count)
                .map(|k| {
                    format!(
                        "{}line {} {}\x1b[0m\r\n",
                        if k % 7 == 0 { sgr(rng) } else { String::new() },
                        base + k,
                        if k % 5 == 0 { "你好🙂" } else { "" }
                    )
                })
                .collect()
        }
        10 => format!("\x1b[{}A{}", rng.below(rows as u64) + 1, text(rng, 2)),
        11 => format!(
            "\x1b[{};{}H{}",
            rng.below(rows as u64) + 1,
            rng.below(cols as u64) + 1,
            text(rng, 3)
        ),
        12 => format!("{}\x1b[K\x1b[0m", sgr(rng)),
        13 => format!("{}\x1b[{}J\x1b[0m", sgr(rng), rng.below(3)),
        14 => "\x1b[2J\x1b[H".into(),
        15 if rng.chance(25) => "\x1b[3J".into(),
        16 if rng.chance(10) => "\x1bc".into(),
        17 => {
            let enter = rng.chance(50);
            let lines = 1 + rng.below(40);
            let body: String = (0..lines)
                .map(|_| format!("{}\r\n", text(rng, 4)))
                .collect();
            if enter {
                format!("\x1b[?1049h{body}")
            } else {
                format!("\x1b[?1049l{body}")
            }
        }
        18 => {
            let top = 1 + rng.below(rows as u64 / 2 + 1);
            let bottom = (top + rng.below(rows as u64)).min(rows as u64);
            let body: String = (0..rng.below(30))
                .map(|k| format!("region {k}\r\n"))
                .collect();
            format!("\x1b[{top};{bottom}r\x1b[{bottom};1H{body}\x1b[r")
        }
        19 => format!("\x1b[{}S", rng.below(rows as u64 + 3) + 1),
        20 => format!("\x1b[{}T", rng.below(rows as u64) + 1),
        21 => format!("\x1b[{}L\x1b[{}M", rng.below(4) + 1, rng.below(4) + 1),
        _ => {
            let cols = if rng.chance(15) {
                2 + rng.below(12)
            } else {
                8 + rng.below(190)
            };
            let rows = 1 + rng.below(60);
            return Err((cols as u16, rows as u16));
        }
    })
}

/// A hyperlink as a read sees it: its ID where the program gave one (alacritty numbers the others
/// itself), and its URI.
fn link_of(link: Option<Hyperlink>) -> Option<(Option<String>, String)> {
    link.map(|link| {
        (
            Some(link.id().to_string()).filter(|id| !id.ends_with("_alacritty")),
            link.uri().to_string(),
        )
    })
}

type CellView = (
    char,
    Color,
    Color,
    u16,
    Vec<char>,
    Option<Color>,
    Option<(Option<String>, String)>,
);

fn cells_of_row(row: &Row<Cell>) -> Vec<CellView> {
    (0..row.len())
        .map(|x| {
            let cell = &row[Column(x)];
            let zero = cell.zerowidth().map(<[char]>::to_vec).unwrap_or_default();
            (
                cell.c,
                cell.fg,
                cell.bg,
                cell.flags.bits(),
                zero,
                cell.underline_color(),
                link_of(cell.hyperlink()),
            )
        })
        .collect()
}

/// Every cell of the rows a read or a redraw visits: the history of the screen shown, then the
/// screen.
fn cells(screen: &Screen) -> Vec<Vec<CellView>> {
    let rows = screen.all_rows();
    (0..rows.len())
        .map(|y| rows.with_row(y, cells_of_row))
        .collect()
}

/// Every cell of the primary screen's history and screen, also while the alternate screen shows:
/// what a later resize reflows and what the reads see once the program leaves the alternate screen.
fn primary_cells(screen: &Screen) -> Vec<Vec<CellView>> {
    let grid = screen.terminal.main_grid();
    let mut rows = Vec::new();
    if let Some(store) = &screen.scrollback.store {
        let store = lock(store);
        let mut y = 0;
        while y < store.len() {
            let (first, block) = store.block_of(y);
            rows.extend(block[y - first..].iter().map(cells_of_row));
            y = first + block.len();
        }
    }
    rows.extend(
        (-(grid.history_size() as i32)..grid.screen_lines() as i32)
            .map(|y| cells_of_row(&grid[Line(y)])),
    );
    rows
}

fn compare(compact: &Screen, reference: &Screen, context: &str, full: bool) {
    assert_eq!(compact.cursor(), reference.cursor(), "cursor: {context}");
    assert_eq!(
        compact.terminal.term.mode(),
        reference.terminal.term.mode(),
        "modes: {context}"
    );
    assert_eq!(
        compact.scrollback_rows(),
        reference.scrollback_rows(),
        "rows kept: {context}"
    );
    assert_eq!(compact.view(), reference.view(), "visible rows: {context}");
    let rows = usize::from(reference.rows());
    let counts: &[usize] = if full {
        &[0, 1, 2, 3, 7, 40, 150, 333, 1000, 2000, 4000, usize::MAX]
    } else {
        &[rows]
    };
    for &n in counts.iter().chain([rows + 1].iter()) {
        assert_eq!(compact.text(n), reference.text(n), "text({n}): {context}");
        assert_eq!(compact.read(n), reference.read(n), "read({n}): {context}");
    }
    if full {
        for (a, b, which) in [
            (cells(compact), cells(reference), "row"),
            (
                primary_cells(compact),
                primary_cells(reference),
                "primary screen's row",
            ),
        ] {
            if let Some(y) = (0..a.len().max(b.len())).find(|&y| a.get(y) != b.get(y)) {
                panic!("{which} {y} of {} differs: {context}", b.len());
            }
        }
        for (keep, include) in [(false, true), (true, false), (false, false)] {
            assert!(
                compact.redraw(keep, include) == reference.redraw(keep, include),
                "redraw({keep}, {include}): {context}"
            );
        }
        assert!(
            compact.redraw_with_all_scrollback() == reference.redraw_with_all_scrollback(),
            "redraw with all scrollback: {context}"
        );
    }
}

/// A screen keeping every row in alacritty, as before the store: what the compact one is compared
/// with.
fn reference(cols: u16, rows: u16, scrollback: usize) -> Screen {
    Screen::with_short_scrollback(cols, rows, scrollback, usize::MAX)
}

/// Sets the memory `screen`'s scrollback may take.
fn set_budget(screen: &mut Screen, budget: usize) {
    screen.scrollback.budget = budget;
    if let Some(store) = &screen.scrollback.store {
        lock(store).set_max_bytes(store_bytes(
            budget,
            screen.scrollback.in_alacritty,
            screen.size().cols,
        ));
    }
}

/// Feeds the same seeded output into a compacting screen and a reference, comparing every read
/// along the way.
fn equivalent(seed: u64, steps: usize, scrollback: usize, short: usize) {
    let (cols, rows) = (40 + (seed % 60) as u16, 6 + (seed % 20) as u16);
    let mut compact = Screen::with_short_scrollback(cols, rows, scrollback, short);
    set_budget(&mut compact, usize::MAX);
    assert!(
        compact.scrollback.store.is_some(),
        "the screen keeps its older rows compact"
    );
    let mut reference = reference(cols, rows, scrollback);
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    for number in 0..steps {
        let (cols, rows) = (usize::from(reference.cols()), usize::from(reference.rows()));
        match step(&mut rng, cols, rows) {
            Ok(bytes) => {
                // Fed in pieces as a terminal gives them, cut anywhere, even inside an escape or a
                // character.
                let bytes = bytes.into_bytes();
                let mut at = 0;
                while at < bytes.len() {
                    let end = (at + 1 + rng.below(700) as usize).min(bytes.len());
                    compact.feed(&bytes[at..end]);
                    reference.feed(&bytes[at..end]);
                    at = end;
                }
            }
            Err((cols, rows)) => {
                compact.resize(cols, rows);
                reference.resize(cols, rows);
            }
        }
        let context = format!(
            "seed {seed}, step {number}, {}x{}, short {short}",
            reference.cols(),
            reference.rows()
        );
        compare(
            &compact,
            &reference,
            &context,
            number % 8 == 7 || number + 1 == steps,
        );
    }
    // A viewer opening late is drawn the same screen from either.
    let mut seen = Screen::new(compact.cols(), compact.rows(), scrollback);
    seen.feed(&compact.redraw(false, true));
    let mut expected = Screen::new(reference.cols(), reference.rows(), scrollback);
    expected.feed(&reference.redraw(false, true));
    assert_eq!(seen.text(usize::MAX), expected.text(usize::MAX));
    assert_eq!(seen.cursor(), expected.cursor());
}

#[test]
fn a_compact_scrollback_reads_as_the_whole_history_in_alacritty() {
    for seed in 1..=10 {
        equivalent(seed, 260, 700, SHORT_HISTORY);
    }
}

#[test]
fn a_short_history_of_a_few_rows_still_reads_the_same() {
    for seed in 11..=20 {
        equivalent(seed, 260, 450, 7);
    }
    // A row whose WRAPLINE an earlier widening left inside it, at the seam of a one-row history:
    // narrowing carries its overflow into the next row, so the seam must keep the two together
    // (CARRIES).
    equivalent(254, 160, 300, 1);
}

#[test]
fn the_daemon_s_ten_thousand_rows_read_the_same() {
    equivalent(41, 160, 10_000, SHORT_HISTORY);
    equivalent(42, 160, 10_000, SHORT_HISTORY);
}

/// Every resize at once: the store's lines reflow apart from alacritty's, and must agree with them
/// at the seam.
#[test]
fn resizing_a_long_soft_wrapped_line_across_the_seam_reads_the_same() {
    let mut compact = Screen::with_short_scrollback(30, 5, 400, 10);
    let mut reference = reference(30, 5, 400);
    // One line far longer than alacritty's short history, wide characters at the wrap points, then
    // short lines below it.
    let long: String = (0..900)
        .map(|k| {
            if k % 29 == 0 {
                "你".to_string()
            } else {
                char::from(b'a' + (k % 26) as u8).to_string()
            }
        })
        .collect();
    for bytes in [
        format!("{long}\r\n"),
        (0..30).map(|k| format!("after {k}\r\n")).collect(),
        long.clone(),
    ] {
        compact.feed(bytes.as_bytes());
        reference.feed(bytes.as_bytes());
    }
    for (cols, rows) in [
        (61, 5),
        (17, 9),
        (17, 3),
        (120, 40),
        (3, 2),
        (2, 50),
        (77, 7),
        (31, 31),
    ] {
        compact.resize(cols, rows);
        reference.resize(cols, rows);
        compare(&compact, &reference, &format!("{cols}x{rows}"), true);
    }
}

/// Hyperlinks and underline colours of rows in the store come back in reads and redraws, as the
/// trunk's redraw draws them.
#[test]
fn a_row_in_the_store_keeps_its_hyperlinks_and_underline_colours() {
    let mut compact = Screen::with_short_scrollback(40, 4, 300, 2);
    let mut reference = reference(40, 4, 300);
    let bytes = "\x1b]8;id=doc;https://example.com/doc\x1b\\docs\x1b]8;;\x1b\\ \x1b[4;58;5;196mred \
                 line\x1b[0m \x1b]8;;file:///x\x1b\\x\x1b]8;;\x1b\\\r\n"
        .repeat(3)
        + &(0..20)
            .map(|k| format!("after {k}\r\n"))
            .collect::<String>();
    compact.feed(bytes.as_bytes());
    reference.feed(bytes.as_bytes());
    assert!(
        compact
            .scrollback
            .store
            .as_deref()
            .is_some_and(|store| lock(store).len() >= 3),
        "the linked rows are in the store"
    );
    compare(&compact, &reference, "links and underline colours", true);
    let redraw = String::from_utf8_lossy(&compact.redraw_with_all_scrollback()).into_owned();
    assert!(
        redraw.contains("\x1b]8;id=doc;https://example.com/doc\x1b\\")
            && redraw.contains("58;5;196"),
        "{redraw:?}"
    );
}

#[test]
fn clearing_the_history_clears_the_rows_kept_compact() {
    for clear in ["\x1b[3J", "\x1bc"] {
        let mut screen = Screen::new(40, 5, 1000);
        screen.feed(
            (0..600)
                .map(|k| format!("row {k}\r\n"))
                .collect::<String>()
                .as_bytes(),
        );
        assert!(
            screen
                .scrollback
                .store
                .as_deref()
                .is_some_and(|store| lock(store).len() > 0)
        );
        screen.feed(clear.as_bytes());
        assert_eq!(
            screen
                .scrollback
                .store
                .as_deref()
                .map(|store| lock(store).len()),
            Some(0),
            "{clear:?}"
        );
        assert_eq!(screen.scrollback_rows(), 0, "{clear:?}");
        screen.feed(
            (0..300)
                .map(|k| format!("again {k}\r\n"))
                .collect::<String>()
                .as_bytes(),
        );
        assert_eq!(screen.text(1), ["again 299"]);
        assert!(
            !screen.read(1000).trimmed,
            "{clear:?}: nothing let go since the clear"
        );
    }
}

/// The rows kept, the bytes they take and what a read says, after `lines` lines of `line(k)` on a
/// 120 x 40 screen keeping the daemon's 10,000 rows; and the reference's text of the rows the
/// compact screen kept.
fn flood(lines: usize, line: impl Fn(usize) -> String) -> (usize, usize, Reading) {
    let mut screen = Screen::new(120, 40, 10_000);
    let mut reference = reference(120, 40, 10_000);
    let mut most = 0;
    for chunk in (0..lines).collect::<Vec<_>>().chunks(1000) {
        let bytes: String = chunk.iter().map(|&k| line(k)).collect();
        screen.feed(bytes.as_bytes());
        reference.feed(bytes.as_bytes());
        most = most.max(screen.scrollback_bytes());
    }
    let rows = screen.scrollback_rows();
    let read = screen.read(usize::MAX);
    // The oldest line kept can be the end of a longer one; every line after it is whole.
    let lines = read.lines - 1;
    assert_eq!(
        screen.text(lines),
        reference.text(lines),
        "the rows kept read as the reference's newest rows"
    );
    (rows, most, read)
}

/// The bound: whatever a CLI prints, its scrollback takes at most [`SCROLLBACK_BUDGET`], and keeps
/// 10,000 rows unless that many would take more.
#[test]
fn a_flood_stays_within_two_megabytes_and_ten_thousand_rows() {
    let plain = |k: usize| {
        format!("flood {k:06} 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n")
    };
    let (rows, most, read) = flood(200_000, plain);
    assert!(most <= SCROLLBACK_BUDGET, "plain flood: {most} bytes");
    assert_eq!(
        rows, 10_001,
        "the 10,000 rows a read sees and the one more that tells a read whether any was let go"
    );
    assert!(read.trimmed);

    // Syntax-coloured code: ten colour changes in 80 characters.
    let code = |k: usize| {
        let words = ["fn", "main", "(", ")", "{", "let", "x", "=", "42", ";"];
        let line: String = words
            .iter()
            .enumerate()
            .map(|(n, word)| format!("\x1b[38;5;{}m{word:7}", (k + n * 3) % 16 + 1))
            .collect();
        format!("{line}\x1b[0m // {k}\r\n")
    };
    let (rows, most, read) = flood(100_000, code);
    assert!(most <= SCROLLBACK_BUDGET, "coloured code: {most} bytes");
    assert_eq!(rows, 10_001);
    assert!(read.trimmed);

    // A diff: rows with a background across the whole width.
    let diff = |k: usize| {
        format!(
            "\x1b[4{}m{}{:<119}\x1b[0m\r\n",
            if k.is_multiple_of(2) { 1 } else { 2 },
            if k.is_multiple_of(2) { '-' } else { '+' },
            format!(" line {k}")
        )
    };
    let (rows, most, _) = flood(100_000, diff);
    assert!(most <= SCROLLBACK_BUDGET, "diff: {most} bytes");
    assert_eq!(rows, 10_001);

    // Every cell another colour: fewer rows, still within the bound, and a read says rows were let
    // go.
    let rainbow = |k: usize| {
        (0..60)
            .map(|x| {
                format!(
                    "\x1b[38;5;{}m{}",
                    (k + x) % 256,
                    char::from(b'a' + ((k + x) % 26) as u8)
                )
            })
            .collect::<String>()
            + "\x1b[0m\r\n"
    };
    let (rows, most, read) = flood(100_000, rainbow);
    assert!(
        most <= SCROLLBACK_BUDGET,
        "every cell another colour: {most} bytes"
    );
    assert!(
        (2_000..10_001).contains(&rows),
        "every cell another colour kept {rows} rows"
    );
    assert!(read.trimmed);
}

/// Past the byte bound, the oldest rows go a block at a time; what is left reads as the newest rows
/// of the whole history.
#[test]
fn past_the_byte_bound_the_oldest_rows_go_and_the_rest_reads_the_same() {
    let mut screen = Screen::with_short_scrollback(40, 5, 5000, 20);
    set_budget(
        &mut screen,
        (20 + RESERVED_ROWS) * row_bytes(40) + 24 * 1024,
    );
    let mut reference = reference(40, 5, 5000);
    let bytes: String = (0..3000)
        .map(|k| format!("\x1b[3{}mrow {k} {}\x1b[0m\r\n", k % 8, "x".repeat(k % 30)))
        .collect();
    screen.feed(bytes.as_bytes());
    reference.feed(bytes.as_bytes());
    assert!(
        screen.scrollback_bytes() <= screen.scrollback.budget,
        "{} bytes",
        screen.scrollback_bytes()
    );
    let read = screen.read(usize::MAX);
    assert!(
        read.trimmed && read.lines < 3000,
        "{} lines kept",
        read.lines
    );
    // The oldest line kept can be the end of a longer one; every line after it is whole.
    assert_eq!(screen.text(read.lines - 1), reference.text(read.lines - 1));
    screen.resize(33, 8);
    reference.resize(33, 8);
    let read = screen.read(usize::MAX);
    assert!(screen.scrollback_bytes() <= screen.scrollback.budget);
    assert_eq!(
        screen.text(read.lines - 1),
        reference.text(read.lines - 1),
        "after a reflow"
    );
}

#[test]
fn a_row_of_inverse_spaces_in_the_store_is_output_a_read_sees_above_it() {
    // Inverse video spaces show on a terminal: below such a row in the store, the lines read are
    // not the oldest output. A screen that keeps every row in alacritty finds that with the same
    // function, so the answer is asserted, not compared.
    let mut screen = Screen::with_short_scrollback(20, 3, 100, 2);
    screen.feed(
        format!(
            "\x1b[7m{}\x1b[0m\r\n{}line",
            " ".repeat(10),
            "line\r\n".repeat(7)
        )
        .as_bytes(),
    );
    let read = screen.read(8);
    assert_eq!(read.lines, 8);
    assert!(
        read.older,
        "the row of inverse spaces lies above the lines read"
    );
    assert!(!screen.read(9).older, "and nothing lies above it");
}
