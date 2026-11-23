//! Getting a terminal ready for a CLI that starts again in it.
//!
//! The new CLI sees a fresh terminal's modes, while the main screen's rows, the scrollback, the
//! title and the cursor's place stay as they were. The bytes go through the screen like any
//! output: into the log, through the parser, out to viewers.

use std::io::Write;

use crate::Screen;
use crate::sequences::TITLE_NEGOTIATION_RESET;

/// Each mode as a fresh terminal has it, in the order sent.
const FRESH_MODES: [&[u8]; 30] = [
    // Cursor keys and keypad.
    b"\x1b[?1l",
    b"\x1b>",
    // Bracketed paste, mouse reports in every encoding, focus reports.
    b"\x1b[?2004l",
    b"\x1b[?1000l",
    b"\x1b[?1002l",
    b"\x1b[?1003l",
    b"\x1b[?1005l",
    b"\x1b[?1006l",
    b"\x1b[?1015l",
    b"\x1b[?1004l",
    // Alternate scroll and urgency hints, both on.
    b"\x1b[?1007h",
    b"\x1b[?1042h",
    // Key encodings: modifyOtherKeys and the kitty keyboard flags.
    b"\x1b[>4m",
    b"\x1b[=0;1u",
    // A visible cursor of the default shape.
    b"\x1b[?25h",
    b"\x1b[0 q",
    // A plain pen without a link.
    b"\x1b[0m",
    b"\x1b]8;;\x1b\\",
    // Wrapping on, insert and newline modes off.
    b"\x1b[?7h",
    b"\x1b[4l",
    b"\x1b[20l",
    // ASCII in every charset, G0 in use.
    b"\x1b(B",
    b"\x1b)B",
    b"\x1b*B",
    b"\x1b+B",
    b"\x0f",
    // Origin mode off and the whole screen as scrolling region, which homes the cursor; saved
    // there.
    b"\x1b[?6l",
    b"\x1b[r",
    b"\x1b7",
    // No tab stops; the default ones are set after.
    b"\x1b[3g",
];

impl Screen {
    /// Output that closes what the last CLI left open: first a synchronized update, then the
    /// alternate screen. It goes before [`Screen::reset_for_restart`], which keeps the cursor
    /// where this leaves it. Anything half-written ends at the first escape, as it would anyway:
    /// a cut character is replaced, a string ends.
    pub fn leave_for_restart(&self) -> Vec<u8> {
        let open_update = self.synchronized_update_deadline().is_some();
        let parts: [(bool, &[u8]); 2] = [
            (open_update, b"\x1b[?2026l"),
            (self.on_alternate_screen(), b"\x1b[?1049l"),
        ];
        parts
            .into_iter()
            .filter(|(needed, _)| *needed)
            .flat_map(|(_, part)| part)
            .copied()
            .collect()
    }

    /// Output that gives a fresh terminal's modes and tab stops, puts the cursor back where it
    /// is, and keeps the native title with fresh status negotiation.
    pub fn reset_for_restart(&self) -> Vec<u8> {
        let mut out = FRESH_MODES.concat();
        let cols = usize::from(self.cols());
        for column in (0..cols).filter(|column| column.is_multiple_of(8)) {
            write!(out, "\x1b[1;{}H\x1bH", column + 1).unwrap();
        }
        let (column, row) = self.cursor();
        write!(out, "\x1b[{};{}H", row + 1, column + 1).unwrap();
        out.extend_from_slice(TITLE_NEGOTIATION_RESET);
        out
    }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::grid::Dimensions;

    use crate::Screen;
    use crate::kept_modes::{ActiveCharset, ModifyOtherKeys};

    /// Every mode a CLI can leave behind, then text and a cursor away from the top left, inside the
    /// scrolling region.
    const DIRTY: &[u8] =
        b"\x1b[?1h\x1b=\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?1007l\x1b[?1042l\x1b[>4;\
          2m\x1b[?25l\x1b[5 q\x1b[?7l\x1b[4h\x1b[20h\x1b(0\x1b)0\x1b*0\x1b+0\x0e\x1b[3g\x1b[1;\
          4H\x1bH\x1b[2;4r\x1b[?6h\x1b[2;2H\x1b[1;31m\x1b]8;;http://old\x1b\\\x1b7\x1b[0mold\x1b[1;\
          4;32m\x1b]8;;http://still\x1b\\\x1b[2;3H";

    /// The state a fresh terminal starts with and a restart must give back.
    fn modes(screen: &Screen) -> String {
        let term = &screen.terminal.term;
        let (cursor, saved) = (&term.grid().cursor, &term.grid().saved_cursor);
        format!(
            "mode {:?}; cursor style {:?}; pen {:?}; charsets {:?}; saved {:?} {:?} {:?}; region \
             {:?}; active {:?}; keys {:?}; tabs {:?}",
            term.mode(),
            term.cursor_style(),
            cursor.template,
            cursor.charsets,
            saved.point,
            saved.template,
            saved.charsets,
            screen.modes.scroll_region,
            screen.modes.active_charset,
            screen.modes.modify_other_keys,
            screen.tab_stops
        )
    }

    /// What a restart keeps: the rows, scrollback, title, and cursor position.
    fn kept(screen: &Screen) -> (Vec<String>, (u16, u16), usize) {
        (
            screen.text(100),
            screen.cursor(),
            screen.terminal.term.grid().history_size(),
        )
    }

    /// Feeds the restart as the actor does: the leaving part, then the reset that reads the cursor
    /// it leaves. Returns any title change the restart caused.
    fn restart(screen: &mut Screen) -> Option<String> {
        let leave = screen.leave_for_restart();
        let left = screen.feed(&leave).title_change;
        let reset = screen.reset_for_restart();
        left.or(screen.feed(&reset).title_change)
    }

    #[test]
    fn a_restart_gives_a_fresh_terminal_s_modes_and_keeps_the_screen() {
        let fresh = modes(&Screen::new(20, 6, 100));
        let mut screen = Screen::new(20, 6, 100);
        for n in 0..8 {
            screen.feed(format!("history {n}\r\n").as_bytes());
        }
        screen.feed(b"\x1b]0;the title\x07");
        screen.feed(DIRTY);
        assert_ne!(modes(&screen), fresh);
        let before = kept(&screen);
        assert_eq!(restart(&mut screen), None, "the title stays");
        assert_eq!(modes(&screen), fresh);
        assert_eq!(
            kept(&screen),
            before,
            "the rows, scrollback, and cursor stay"
        );
        assert_eq!(screen.modes.active_charset, ActiveCharset::G0);
        assert_eq!(screen.modes.modify_other_keys, ModifyOtherKeys::Initial);
    }

    #[test]
    fn a_restart_leaves_the_alternate_screen_and_what_was_unfinished_and_returns_to_the_main_cursor()
     {
        let fresh = modes(&Screen::new(20, 6, 100));
        let unfinished: [&[u8]; 3] = [b"\x1b[3", b"\x1b]0;half a title", b"\xe4\xbd"];
        for tail in unfinished {
            let mut screen = Screen::new(20, 6, 100);
            screen.feed(b"main row\r\n\x1b[4;7H");
            let main = kept(&screen);
            screen.feed(b"\x1b[?1049h\x1b[?1h\x1b[5;5Halternate\x1b[?2026hframe");
            screen.feed(tail);
            assert!(
                screen.on_alternate_screen()
                    && screen.has_unfinished_unit()
                    && screen.synchronized_update_deadline().is_some()
            );
            restart(&mut screen);
            assert!(
                !screen.on_alternate_screen() && screen.at_clean_point(),
                "{tail:?}"
            );
            assert_eq!(modes(&screen), fresh, "{tail:?}");
            assert_eq!(
                kept(&screen),
                main,
                "the main screen and its cursor come back: {tail:?}"
            );
            // On the main screen, the reset's own first escape ends what was unfinished.
            let mut screen = Screen::new(20, 6, 100);
            screen.feed(b"main row");
            screen.feed(tail);
            assert!(screen.leave_for_restart().is_empty());
            restart(&mut screen);
            assert!(screen.at_clean_point(), "{tail:?}");
            assert_eq!(modes(&screen), fresh, "{tail:?}");
        }
    }

    /// Mouse report modes replace one another, so each is checked alone.
    #[test]
    fn a_restart_turns_off_every_mouse_report_mode() {
        let fresh = modes(&Screen::new(20, 6, 100));
        for mode in ["1000", "1002", "1003", "1005", "1006"] {
            let mut screen = Screen::new(20, 6, 100);
            screen.feed(format!("\x1b[?{mode}h").as_bytes());
            assert_ne!(modes(&screen), fresh, "{mode}");
            restart(&mut screen);
            assert_eq!(modes(&screen), fresh, "{mode}");
            assert!(!screen.reports_mouse(), "{mode}");
            assert_eq!(screen.encode_wheel(1, 1, 120, 0), None, "{mode}");
        }
    }

    #[test]
    fn a_restart_on_the_main_screen_sends_no_alternate_screen_exit() {
        let mut screen = Screen::new(20, 6, 100);
        screen.feed(DIRTY);
        assert!(
            screen.leave_for_restart().is_empty(),
            "nothing to leave on the main screen between units"
        );
        assert!(!String::from_utf8_lossy(&screen.reset_for_restart()).contains("1049"));
    }

    /// Feeds the agent's screen and passes on to the viewer what the actor would: its output, or a
    /// redraw.
    fn follow(source: &mut Screen, viewer: &mut Screen, log: &mut Vec<u8>, bytes: &[u8]) {
        log.extend_from_slice(bytes);
        let fed = source.feed(bytes);
        if fed.redraw_viewers {
            viewer.feed(&source.redraw(false, false));
        } else {
            viewer.feed(&fed.viewer_output);
        }
    }

    /// A viewer that follows the agent, from a clean or a dirty terminal, ends in the same state as
    /// the agent's screen, and a screen replayed from the whole log ends there too. Writes after
    /// the restart land alike in all three.
    #[test]
    fn viewers_and_a_replayed_log_follow_a_restart() {
        let streams: [&[u8]; 2] = [
            DIRTY,
            b"\x1b[?1049h\x1b[?2004h\x1b[2;3r\x1b[?6hx\x1b[?2026hframe\x1b[3",
        ];
        let after = b"\x1b[1;1Hnew\tcli\x1b[10Gz\x1b[2;2r\x1b[?6h\x1b[1;1Hy";
        for stream in streams {
            for viewer_start in [&b""[..], b"\x1b[?1049h\x1b[33mviewer\x1b[2;3r"] {
                let mut source = Screen::new(20, 6, 100);
                let mut log = Vec::new();
                source.feed(b"before\r\n");
                log.extend_from_slice(b"before\r\n");
                // A viewer joins with a snapshot, then follows the agent.
                let mut viewer = Screen::new(20, 6, 100);
                viewer.feed(viewer_start);
                viewer.feed(&source.redraw(false, true));
                follow(&mut source, &mut viewer, &mut log, stream);
                let leave = source.leave_for_restart();
                follow(&mut source, &mut viewer, &mut log, &leave);
                let reset = source.reset_for_restart();
                follow(&mut source, &mut viewer, &mut log, &reset);
                follow(&mut source, &mut viewer, &mut log, after);
                let mut replayed = Screen::new(20, 6, 100);
                replayed.feed(&log);
                assert_eq!(
                    modes(&viewer),
                    modes(&source),
                    "viewer after {stream:?} from {viewer_start:?}"
                );
                assert_eq!(
                    (viewer.text(100), viewer.cursor()),
                    (source.text(100), source.cursor()),
                    "viewer after {stream:?} from {viewer_start:?}"
                );
                assert_eq!(modes(&replayed), modes(&source));
                assert_eq!(
                    (replayed.text(100), replayed.cursor()),
                    (source.text(100), source.cursor())
                );
            }
        }
    }
}
