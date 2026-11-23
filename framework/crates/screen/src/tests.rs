use super::*;

#[test]
fn reads_text_and_redraws_it_identically() {
    let mut screen = Screen::new(20, 5, 100);
    screen.feed(
        b"hello \x1b[1mworld\x1b[0m\r\n\x1b[31mred\x1b[0m line\r\nwide: \
          \xe4\xbd\xa0\xe5\xa5\xbd",
    );
    assert_eq!(
        screen.text(10),
        vec!["hello world", "red line", "wide: 你好"]
    );
    let mut copy = Screen::new(20, 5, 100);
    copy.feed(&screen.redraw(false, true));
    assert_eq!(copy.text(10), screen.text(10));
    assert_eq!(copy.cursor(), screen.cursor());
}

/// A read marks inverse cells `[[...]]` and dim cells `{{...}}`, escapes the screen's own
/// backslashes, brackets, and braces, and says whether output lies above the lines read and
/// whether the scrollback let go of rows.
#[test]
fn a_read_marks_styles_and_escapes_the_screen_s_own_marks() {
    let mut screen = Screen::new(30, 4, 3);
    screen.feed(
        b"plain \x1b[7mpicked\x1b[0m \x1b[2mhint\x1b[0m \x1b[7;2mboth\x1b[0m\r\n[a] {b} \\c\r\n\
          \x1b[7m \x1b[0m",
    );
    let read = screen.read(10);
    assert_eq!(
        read.text,
        "plain [[picked]] {{hint}} [[{{both}}]]\n\\[a\\] \\{b\\} \\\\c\n[[ ]]"
    );
    assert_eq!(
        (read.lines, read.alternate, read.older, read.trimmed),
        (3, false, false, false),
        "an inverse blank is content"
    );
    assert_eq!(
        screen.text(10),
        ["plain picked hint both", "[a] {b} \\c", " "]
    );
    assert!(screen.read(2).older, "a line above the two read");
    screen.feed(b"\r\n4\r\n5\r\n6\r\n7");
    let full = screen.read(100);
    assert_eq!(
        (full.lines, full.trimmed),
        (7, false),
        "three rows of scrollback are full, and none was let go"
    );
    screen.feed(b"\r\n8");
    let trimmed = screen.read(100);
    assert_eq!(
        (trimmed.lines, trimmed.trimmed),
        (7, true),
        "the oldest row was let go"
    );
    screen.feed(b"\x1b[?1049h\x1b[Hfull screen");
    let alternate = screen.read(10);
    assert_eq!(
        (
            alternate.text.as_str(),
            alternate.alternate,
            alternate.older,
            alternate.trimmed
        ),
        ("full screen", true, false, false)
    );
}

#[test]
fn soft_wraps_join_into_one_logical_line() {
    let mut screen = Screen::new(10, 4, 100);
    screen.feed(b"0123456789abcdef");
    assert_eq!(screen.text(10), vec!["0123456789abcdef"]);
}

#[test]
fn replies_to_device_queries_pass_none_on_and_guess_no_colour() {
    let mut screen = Screen::new(20, 5, 0);
    let fed = screen.feed(b"a\x1b[cb\x1b[6nc\x1b]11;?\x07d");
    let replies = String::from_utf8_lossy(&fed.query_replies);
    assert!(
        replies.contains("\x1b[?") && replies.contains("R"),
        "expected device-attribute and cursor-position replies: {replies:?}"
    );
    assert!(
        !replies.contains("]11;"),
        "colour queries must receive no reply without a viewer theme"
    );
    assert_eq!(
        fed.viewer_output, b"abcd",
        "queries must not reach viewers and cause duplicate replies"
    );
}

#[test]
fn a_status_query_is_answered_in_order_and_status_sequences_reach_only_the_daemon() {
    let mut screen = Screen::new(20, 5, 0);
    let fed =
        screen.feed(b"a\x1b]7501;?\x07b\x1b[6nc\x1b]7501;state=working\x1b\\d\x1b]7501;state=blo");
    let replies = String::from_utf8_lossy(&fed.query_replies).into_owned();
    let (status, position) = (
        replies
            .find("\x1b]7501;?:states=")
            .expect("the status query is answered"),
        replies.find('R').unwrap(),
    );
    assert!(
        status < position,
        "replies keep the order of the queries: {replies:?}"
    );
    assert_eq!(
        fed.viewer_output, b"abcd",
        "viewers see neither the query nor the report"
    );
    let working = StatusEvent::Report(StatusReport {
        state: Some(ReportedState::Working),
        kind: None,
        text: None,
    });
    assert_eq!(fed.status, [StatusEvent::Asked, working.clone()]);
    let fed = screen.feed(b"cked:kind=question\x07");
    let question = StatusEvent::Report(StatusReport {
        state: Some(ReportedState::Blocked),
        kind: Some(BlockKind::Question),
        text: None,
    });
    assert_eq!(fed.status, [question], "a report split across chunks");
    let fed = screen.feed(b"\x1b]7501;state=idle:id=tool\x07\x1b]7501;state=nap\x07e");
    assert!(
        fed.status.is_empty() && fed.viewer_output == b"e",
        "a part's report and an invalid one are dropped, and viewers see neither"
    );
}

#[test]
fn a_full_reset_and_a_shell_prompt_end_reports_in_the_order_they_come() {
    let mut screen = Screen::new(20, 5, 0);
    let fed =
        screen.feed(b"\x1b]7501;state=working\x07\x1bc\x1b]133;A\x07$ \x1b]7501;state=working\x07");
    let working = StatusEvent::Report(StatusReport {
        state: Some(ReportedState::Working),
        kind: None,
        text: None,
    });
    assert_eq!(
        fed.status,
        [
            working.clone(),
            StatusEvent::Reset,
            StatusEvent::ShellPrompt,
            working
        ]
    );
    assert!(
        fed.viewer_output.ends_with(b"\x1b]133;A\x07$ "),
        "viewers keep the prompt mark"
    );
    assert!(
        screen
            .feed(b"\x1b]133;B\x07\x1b]1337;A\x07")
            .status
            .is_empty(),
        "only a prompt's start marks a new prompt"
    );
}

#[test]
fn a_synchronized_update_is_one_frame() {
    let mut screen = Screen::new(20, 5, 0);
    screen.feed(b"\x1b[?2026hhalf");
    assert!(screen.synchronized_update_deadline().is_some());
    assert_eq!(
        screen.text(5),
        Vec::<String>::new(),
        "a synchronized update must not draw a partial frame"
    );
    screen.feed(b" frame\x1b[?2026l");
    assert!(screen.synchronized_update_deadline().is_none());
    assert_eq!(screen.text(5), vec!["half frame"]);
}

#[test]
fn redraw_carries_the_modes_a_viewer_needs() {
    let mut screen = Screen::new(20, 5, 0);
    screen.feed(b"\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[?1000h\x1b[?1006h");
    let redraw = String::from_utf8(screen.redraw(false, true)).unwrap();
    assert!(
        redraw.contains("\x1b[?2004h")
            && redraw.contains("\x1b[?1h")
            && redraw.contains("\x1b[?25l")
    );
    let mut viewer = Screen::new(20, 5, 0);
    viewer.feed(redraw.as_bytes());
    assert!(viewer.reports_mouse());
    assert_eq!(
        viewer.encode_wheel(20, 5, -240, 12).as_deref(),
        Some(&b"\x1b[<77;20;5M\x1b[<77;20;5M"[..])
    );
    assert_eq!(viewer.encode_wheel(21, 5, 120, 0), None);
    viewer.feed(b"\x1b[?1006l");
    assert_eq!(
        viewer.encode_wheel(20, 5, 120, 16).as_deref(),
        Some(&b"\x1b[Mp4%"[..])
    );
    viewer.resize(250, 5);
    assert_eq!(viewer.encode_wheel(250, 5, 120, 0), None);
    viewer.feed(b"\x1b[?1005h");
    assert_eq!(
        viewer.encode_wheel(250, 5, 120, 0).as_deref(),
        Some("\x1b[M`Ě%".as_bytes())
    );
}

#[test]
fn a_redraw_kept_over_the_viewer_s_scrollback_adds_no_rows_to_it() {
    let mut screen = Screen::new(20, 4, 100);
    assert!(screen.title_output().is_empty());
    for n in 0..10 {
        screen.feed(format!("line {n}\r\n").as_bytes());
    }
    let mut viewer = Screen::new(20, 4, 100);
    viewer.feed(&screen.redraw(false, true));
    let shown = viewer.text(100);
    // A reconnecting viewer that keeps its scrollback gets the visible rows only.
    viewer.feed(&screen.redraw(true, false));
    assert_eq!(
        viewer.text(100),
        shown,
        "redrawing the visible rows must not move them into the viewer's scrollback"
    );

    for (cols, rows) in [(20, 6), (24, 4)] {
        let mut viewer = Screen::new(cols, rows, 100);
        viewer.feed(&screen.redraw_in_viewport(true, true));
        let history = viewer.scrollback_rows();
        let main = viewer.text(100);
        screen.feed(b"\x1b[?1049h\x1b[H\x1b[44mold frame\x1b[0m\x1b]2;attach\x07");
        viewer.feed(b"\x1b[?1049h");
        let frame = screen.redraw_for_attach(true, false);
        assert!(frame.ends_with(&screen.title_output()));
        let attached = viewer.feed(&frame);
        assert_eq!(attached.title_change.as_deref(), Some("attach"));
        screen.feed(
            "\x1b[2;1H01234567890123456789\x1b[H\x1b[Ka\t界\x1b[?1h\x1b]2;updated\x07".as_bytes(),
        );
        let frame = screen.redraw_in_viewport_update();
        assert!(frame.ends_with(&screen.title_output()));
        let updated = viewer.feed(&frame);
        assert!(viewer.on_alternate_screen());
        assert!(viewer.application_cursor_keys());
        assert_eq!(viewer.cursor(), screen.cursor());
        assert_eq!(updated.title_change.as_deref(), Some("updated"));
        assert_eq!(viewer.text(10), vec!["a       界", "01234567890123456789"]);
        viewer.feed(b"\x1b[?1049l");
        assert_eq!(viewer.scrollback_rows(), history);
        assert_eq!(viewer.text(100), main);
        let return_to_main = b"\x1b]9;4;1;50\x07\x1b[?1049l\x1b]2;main\x07\x1b]9;4;0;0\x1b\\";
        let fed = screen.feed(return_to_main);
        assert!(fed.redraw_viewers);
        assert_eq!(fed.viewer_output, return_to_main);
        assert_eq!(fed.native_activity, b"\x1b]9;4;1;50\x07\x1b]9;4;0;0\x1b\\");
        assert_eq!(screen.title_output(), b"\x1b]2;main\x1b\\");
    }
}

#[test]
fn closing_a_synchronized_update_sends_the_glyph_with_the_applied_title() {
    let mut screen = Screen::new(20, 4, 100);
    screen.feed(b"\x1b]7501;?\x07\x1b]2;Old\x07");
    let opening = b"\x1b[?2026h\x1b]2;New\x07";
    let opened = screen.feed(opening);
    assert_eq!(opened.viewer_output, opening);
    assert!(opened.title_change.is_none());

    assert!(screen.set_status_glyph(Some("*".into())).is_empty());
    let closed = screen.feed(b"\x1b[?2026l");
    assert_eq!(closed.viewer_output, b"\x1b[?2026l\x1b]2;* New\x1b\\");
    assert_eq!(closed.title_change.as_deref(), Some("New"));
    assert!(screen.feed(b"").viewer_output.is_empty());
}

#[test]
fn ending_a_synchronized_update_at_its_deadline_sends_the_current_glyph_and_title() {
    let mut screen = Screen::new(20, 4, 100);
    screen.feed(b"\x1b]7501;?\x07\x1b]2;Old\x07");
    screen.feed(b"\x1b[?2026h");
    assert!(screen.set_status_glyph(Some("*".into())).is_empty());
    assert_eq!(screen.feed(b"\x1bH").viewer_output, b"\x1bH");
    assert!(screen.synchronized_update_deadline().is_some());
    let held = screen.feed(b"\x1b]2;New\x07");
    assert_eq!(held.viewer_output, b"\x1b]2;* New\x07");
    assert!(held.title_change.is_none());

    let ended = screen.end_synchronized_update();
    assert_eq!(ended.viewer_output, b"\x1b]2;* New\x1b\\");
    assert_eq!(ended.title_change.as_deref(), Some("New"));
    assert!(screen.synchronized_update_deadline().is_none());
    assert!(screen.end_synchronized_update().viewer_output.is_empty());
}

#[test]
fn viewer_output_decorates_each_title_with_the_current_status_glyph() {
    let mut screen = Screen::new(20, 4, 100);
    screen.feed(b"\x1b]7501;?\x07");
    let native = b"a\x1b]0;first\x07b\x1b]2;second;part\x1b\\c";
    let fed = screen.feed(native);
    assert_eq!(fed.viewer_output, native);
    assert_eq!(fed.title_change.as_deref(), Some("second;part"));

    assert_eq!(
        screen.set_status_glyph(Some("◐".into())),
        "\x1b]2;◐ second;part\x1b\\".as_bytes()
    );
    assert!(screen.set_status_glyph(Some("◐".into())).is_empty());
    let fed = screen.feed(native);
    assert_eq!(
        fed.viewer_output,
        "a\x1b]0;◐ first\x07b\x1b]2;◐ second;part\x1b\\c".as_bytes()
    );
    assert_eq!(fed.title_change.as_deref(), Some("second;part"));
    let fed = screen.feed(b"\x1b]2;split\x1b");
    assert!(fed.viewer_output.is_empty());
    assert_eq!(fed.title_change.as_deref(), Some("split"));
    let fed = screen.feed(b"\\");
    assert_eq!(fed.viewer_output, "\x1b]2;◐ split\x1b\\".as_bytes());
    assert!(fed.title_change.is_none());
    assert_eq!(screen.set_status_glyph(None), b"\x1b]2;split\x1b\\");
    assert!(screen.set_status_glyph(None).is_empty());
    assert_eq!(screen.feed(native).viewer_output, native);
}

#[test]
fn viewer_titles_use_one_status_glyph_when_the_cli_already_supplies_it() {
    let mut screen = Screen::new(20, 4, 100);
    screen.feed(b"\x1b]7501;?\x07");
    let native = "\x1b]2;✳ Claude Code\x1b\\".as_bytes();
    assert_eq!(screen.feed(native).viewer_output, native);
    assert_eq!(screen.set_status_glyph(Some("✳".into())), native);
    assert_eq!(screen.title_output(), native);
    for redraw in [
        screen.redraw(false, true),
        screen.redraw_for_attach(false, true),
        screen.redraw_in_viewport(false, true),
        screen.redraw_in_viewport_update(),
    ] {
        assert!(redraw.ends_with(native));
    }

    let matching = "\x1b]0;✳ Claude Code\x07\x1b]2;✳ Claude Code\x1b\\".as_bytes();
    assert_eq!(screen.feed(matching).viewer_output, matching);
    assert_eq!(screen.set_status_glyph(None), native);
    assert_eq!(screen.set_status_glyph(Some("✳".into())), native);

    let titles = "\x1b]0;◐ Claude Code\x07\x1b]2;✳Claude Code\x1b\\".as_bytes();
    assert_eq!(
        screen.feed(titles).viewer_output,
        "\x1b]0;✳ ◐ Claude Code\x07\x1b]2;✳ ✳Claude Code\x1b\\".as_bytes()
    );
    let plain = screen.feed(b"\x1b]2;Claude Code\x1b\\");
    assert_eq!(plain.viewer_output, native);
    assert_eq!(plain.title_change.as_deref(), Some("Claude Code"));
}

#[test]
fn blank_titles_leave_viewers_without_a_cli_title_alone() {
    let mut screen = Screen::new(20, 4, 100);
    assert!(screen.set_status_glyph(Some("✳".into())).is_empty());
    assert!(screen.title_output().is_empty());
    let fed = screen.feed(b"\x1b[22;0t\x1b]0;\x07\x1b]2;\x1b\\");
    assert_eq!(fed.viewer_output, b"\x1b[22;0t");
    assert_eq!(fed.title_change.as_deref(), Some(""));
    assert!(screen.title_output().is_empty());
    assert!(screen.set_status_glyph(Some("◐".into())).is_empty());

    let blank = b"\x1b]2;   \x1b\\";
    assert!(screen.feed(blank).viewer_output.is_empty());
    // Seeding a saved title keeps its spaces, which the OSC parser would trim.
    screen.restore_title("   ");
    assert!(screen.title_output().is_empty());
    for redraw in [
        screen.redraw(false, false),
        screen.redraw_for_attach(false, false),
        screen.redraw_in_viewport(false, false),
        screen.redraw_in_viewport_update(),
        screen.redraw_with_all_scrollback(),
    ] {
        assert!(!redraw.windows(4).any(|bytes| bytes == b"\x1b]2;"));
    }
    assert!(screen.set_status_glyph(Some("◑".into())).is_empty());

    screen.feed(b"\x1b]7501;?\x07");
    assert_eq!(
        screen.feed(b"\x1b]2;topic\x07").viewer_output,
        "\x1b]2;◑ topic\x07".as_bytes()
    );
    let reset = screen.feed(b"\x1b[23;0t");
    assert_eq!(reset.viewer_output, b"\x1b[23;0t");
    assert_eq!(reset.title_change.as_deref(), Some(""));
    assert!(screen.title_output().is_empty());
    assert!(screen.set_status_glyph(None).is_empty());
}

#[test]
fn a_blank_title_resets_a_live_viewer_after_a_nonblank_title() {
    let mut screen = Screen::new(20, 4, 100);
    let title = screen.feed(b"\x1b]0;\x07\x1b]2;topic\x07");
    assert_eq!(title.viewer_output, b"\x1b]2;topic\x07");

    let reset = screen.feed(b"\x1b]0;\x07\x1b]2;\x1b\\");
    assert_eq!(reset.viewer_output, b"\x1b]0;\x07");
    assert_eq!(reset.title_change.as_deref(), Some(""));
    assert!(screen.title_output().is_empty());

    assert!(screen.set_status_glyph(Some("*".into())).is_empty());
    screen.feed(b"\x1b]7501;?\x07");
    let batch = screen.feed(b"\x1b]0;topic\x07\x1b]2;   \x1b\\\x1b]0;\x07");
    assert_eq!(batch.viewer_output, b"\x1b]0;* topic\x07\x1b]2;   \x1b\\");
    assert_eq!(batch.title_change.as_deref(), Some(""));
}

#[test]
fn trust_title_stays_plain_until_the_cli_sets_a_title_after_negotiating() {
    let mut screen = Screen::new(20, 4, 100);
    let process_title = b"\x1b]0;claude\x07";
    let plain = b"\x1b]2;claude\x1b\\";
    assert_eq!(screen.feed(process_title).viewer_output, process_title);
    let reported = screen.feed(b"\x1b]7501;state=idle\x07");
    assert!(reported.viewer_output.is_empty());
    assert!(screen.set_status_glyph(Some("✳".into())).is_empty());
    let answered = screen.feed(b"\x1b]7501;?\x1b\\");
    assert!(answered.viewer_output.is_empty());
    assert!(!answered.query_replies.is_empty());
    assert_eq!(screen.title_output(), plain);
    let blocked = screen.feed(b"\x1b]7501;state=blocked:kind=permission\x07");
    assert!(blocked.viewer_output.is_empty());
    assert_eq!(screen.title_output(), plain);
    for redraw in [
        screen.redraw(false, true),
        screen.redraw_for_attach(false, true),
        screen.redraw_for_attach(true, true),
        screen.redraw_in_viewport(false, true),
        screen.redraw_in_viewport_update(),
    ] {
        assert!(redraw.ends_with(plain));
    }

    let checkpoint = screen.redraw_with_all_scrollback();
    let mut restored = Screen::new(20, 4, 100);
    restored.feed(&checkpoint);
    restored.restore_title("claude");
    assert!(restored.set_status_glyph(Some("✳".into())).is_empty());
    assert_eq!(restored.title_output(), plain);
    for screen in [&mut screen, &mut restored] {
        let fed = screen.feed(b"\x1b]0;Claude Code\x07");
        assert_eq!(fed.viewer_output, "\x1b]0;✳ Claude Code\x07".as_bytes());
        assert_eq!(fed.title_change.as_deref(), Some("Claude Code"));
    }
}

#[test]
fn titles_in_one_feed_follow_the_query_in_stream_order() {
    let mut screen = Screen::new(20, 4, 100);
    screen.set_status_glyph(Some("✳".into()));
    let fed = screen.feed(b"\x1b]0;claude\x07\x1b]7501;?\x07\x1b]2;Claude Code\x1b\\");
    assert_eq!(
        fed.viewer_output,
        "\x1b]0;claude\x07\x1b]2;✳ Claude Code\x1b\\".as_bytes()
    );
    assert_eq!(fed.title_change.as_deref(), Some("Claude Code"));
}

#[test]
fn replayed_restart_requires_fresh_title_negotiation() {
    let mut screen = Screen::new(20, 4, 100);
    screen.feed(b"\x1b]7501;?\x07\x1b]2;old topic\x07");
    let checkpoint = screen.redraw_with_all_scrollback();
    assert_eq!(
        screen.set_status_glyph(Some("✳".into())),
        "\x1b]2;✳ old topic\x1b\\".as_bytes()
    );
    let leave = screen.leave_for_restart();
    screen.feed(&leave);
    let reset = screen.reset_for_restart();
    let mut replay = Screen::new(20, 4, 100);
    replay.feed(&checkpoint);
    replay.feed(&leave);
    for screen in [&mut screen, &mut replay] {
        let restarted = screen.feed(&reset);
        assert!(restarted.query_replies.is_empty());
        assert!(restarted.status.is_empty());
        assert_eq!(screen.title_output(), b"\x1b]2;old topic\x1b\\");
        assert!(screen.set_status_glyph(Some("◑".into())).is_empty());
        let next_title = b"\x1b]0;claude\x07";
        assert_eq!(screen.feed(next_title).viewer_output, next_title);
        assert_eq!(screen.title_output(), b"\x1b]2;claude\x1b\\");
        let negotiated = screen.feed(b"\x1b]7501;?\x07\x1b]2;new topic\x07");
        assert_eq!(
            negotiated.viewer_output,
            "\x1b]2;◑ new topic\x07".as_bytes()
        );
    }
}

#[test]
fn viewer_redraws_write_the_glyph_and_a_checkpoint_keeps_the_cli_title() {
    let mut screen = Screen::new(20, 4, 100);
    screen.feed(b"\x1b]7501;?\x07");
    let mut before_title = Screen::new(20, 4, 100);
    before_title.feed(&screen.redraw_with_all_scrollback());
    assert!(before_title.set_status_glyph(Some("◑".into())).is_empty());
    assert_eq!(
        before_title.feed(b"\x1b]2;topic\x07").viewer_output,
        "\x1b]2;◑ topic\x07".as_bytes()
    );

    screen.feed(b"\x1b]2;topic\x07");
    let native = b"\x1b]2;topic\x1b\\";
    let checkpoint = screen.redraw_with_all_scrollback();

    let decorated = "\x1b]2;◑ topic\x1b\\".as_bytes();
    assert_eq!(screen.set_status_glyph(Some("◑".into())), decorated);
    assert_eq!(screen.title_output(), decorated);
    for redraw in [
        screen.redraw(false, true),
        screen.redraw_for_attach(false, true),
        screen.redraw_for_attach(true, true),
        screen.redraw_in_viewport(false, true),
        screen.redraw_in_viewport_update(),
    ] {
        assert!(redraw.ends_with(decorated));
    }
    assert_eq!(screen.redraw_with_all_scrollback(), checkpoint);
    let mut restored = Screen::new(20, 4, 100);
    let fed = restored.feed(&checkpoint);
    assert_eq!(fed.title_change.as_deref(), Some("topic"));
    restored.restore_title("topic");
    assert_eq!(restored.title_output(), native);
    assert_eq!(restored.set_status_glyph(Some("◑".into())), decorated);
    assert!(restored.feed(b"\x1b]7501;?\x07").viewer_output.is_empty());
    assert_eq!(restored.title_output(), decorated);
}

#[test]
fn a_redraw_with_all_scrollback_restores_every_retained_row() {
    let mut screen = Screen::new(20, 3, 2000);
    for n in 0..1500 {
        screen.feed(format!("row-{n:04} \x1b[3{}mcolour\x1b[0m\r\n", n % 8).as_bytes());
    }
    let old_checkpoint = screen.redraw_with_all_scrollback();
    screen.restore_title("native title");
    assert!(screen.feed(b"").title_change.is_none());
    let mut recovered = Screen::new(20, 3, 2000);
    recovered.feed(&old_checkpoint);
    recovered.restore_title("native title");
    let restored_title = recovered.feed(b"\x1b[22;0t\x1b]2;temporary\x07\x1b[23;0t");
    assert_eq!(restored_title.title_change.as_deref(), Some("native title"));
    let mut copy = Screen::new(20, 3, 2000);
    let restored = copy.feed(&recovered.redraw_with_all_scrollback());
    assert_eq!(restored.title_change.as_deref(), Some("native title"));
    assert_eq!(copy.text(2000), screen.text(2000));
    assert_eq!(
        copy.text(2000).first().map(String::as_str),
        Some("row-0000 colour"),
        "the oldest retained row must come back"
    );
    assert_eq!(
        copy.redraw_with_all_scrollback(),
        screen.redraw_with_all_scrollback()
    );
}

#[test]
fn a_clean_point_is_the_main_screen_between_units_outside_a_synchronized_update() {
    let mut screen = Screen::new(20, 4, 100);
    assert!(screen.at_clean_point());
    for (unfinished, rest) in [
        (&b"\x1b[3"[..], &b"1m"[..]),
        (b"\xe2\x82", b"\xac"),
        (b"\x1b]0;title", b"\x07"),
        (b"\x1b[?2026hframe", b"\x1b[?2026l"),
        (b"\x1b[?1049h", b"\x1b[?1049l"),
    ] {
        screen.feed(unfinished);
        assert!(!screen.at_clean_point(), "{unfinished:?}");
        screen.feed(rest);
        assert!(screen.at_clean_point(), "{unfinished:?}{rest:?}");
    }
}

#[test]
fn the_history_scrolled_off_the_screen_is_read_and_redrawn() {
    let mut screen = Screen::new(20, 3, 100);
    for n in 0..10 {
        screen.feed(format!("line {n}\r\n").as_bytes());
    }
    assert_eq!(screen.text(4), vec!["line 6", "line 7", "line 8", "line 9"]);
    let mut copy = Screen::new(20, 3, 100);
    copy.feed(&screen.redraw(false, true));
    assert_eq!(copy.text(20), screen.text(20));
}

/// Captures the screen state that a redraw must preserve.
fn state(
    screen: &Screen,
) -> (
    Vec<u8>,
    bool,
    Vec<String>,
    kept_modes::TabStops,
    kept_modes::ModifyOtherKeys,
) {
    let filter = &screen.modes;
    (
        screen.redraw(false, true),
        screen.on_alternate_screen(),
        screen.text(200),
        screen.tab_stops.clone(),
        filter.modify_other_keys,
    )
}

/// Checks that a redraw after `prefix`, followed by the remaining output, restores the agent's
/// state. `dirty` is the viewer's initial terminal content.
fn assert_redraw_continuation(prefix: &[u8], suffix: &[u8], cols: u16, rows: u16, dirty: &[u8]) {
    let mut source = Screen::new(cols, rows, 100);
    source.feed(prefix);
    // Do not redraw inside a synchronized update; the actor waits for the frame to finish.
    if source.synchronized_update_deadline().is_some() {
        return;
    }
    let mut viewer = Screen::new(cols, rows, 100);
    viewer.feed(dirty);
    viewer.feed(&source.redraw(false, true));
    let fed = source.feed(suffix);
    viewer.feed(
        if fed.redraw_viewers {
            source.redraw(false, true)
        } else {
            fed.viewer_output
        }
        .as_slice(),
    );
    let shown = |bytes: &[u8]| {
        String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(60)..]).into_owned()
    };
    assert_eq!(
        state(&viewer),
        state(&source),
        "after {:?}, then {:?}",
        shown(prefix),
        shown(suffix)
    );
    let mut whole = Screen::new(cols, rows, 100);
    whole.feed(&[prefix, suffix].concat());
    assert_eq!(
        state(&source),
        state(&whole),
        "source state differs after prefix {:?}",
        shown(prefix)
    );
}

/// Runs [`assert_redraw_continuation`] at every split of `stream`.
fn assert_redraw_at_every_split(stream: &[u8], cols: u16, rows: u16, dirty: &[u8]) {
    for split in 0..=stream.len() {
        assert_redraw_continuation(&stream[..split], &stream[split..], cols, rows, dirty);
    }
}

#[test]
fn redraw_preserves_state_for_continued_output() {
    let dirty: &[u8] =
        b"\x1b[>4;2m\x1b[3g\x1b[1;3H\x1bH\x1b[?1049h\x1b[33mold\x1b(0\x0e\x1b[2;3r\x1b[?\
          6h\x1b[4h\x1b]8;;http://old\x1b\\x";
    let streams: [&[u8]; 17] = [
        // The active pen must keep subsequent text red.
        b"hello \x1b[31mred \x1b[1;4;38;2;1;2;3;48;5;200mmore\x1b[0m plain",
        // Split an escape sequence or UTF-8 character.
        b"before\x1b[31mAFTER \xe4\xbd\xa0\xe5\xa5\xbd \x1b]0;title\x07 done",
        // Leave an alternate screen that the viewer never entered, then enter it again.
        b"main\x1b[?1049hALT\x1b[?1049lMAIN\x1b[?1049hagain",
        // Preserve soft wraps in the screen and scrollback, including a pending wrap at the
        // margin.
        b"0123456789abcdef\r\n0123456789",
        b"one\r\ntwo\r\n0123456789abcdefghijklmnopqrstuvwxyz\r\nend 0123456789",
        // Preserve the scrolling region and origin mode.
        b"\x1b[2;4rtop\x1b[4;1Hx\ny\nz\n\x1b[?6h\x1b[1;1Hin",
        // Preserve line-drawing charsets in G0 and G1, selected by SO and SI.
        b"\x1b(0lqqk\x1b(B \x1b)0\x0eabc\x0fdef",
        // Restore the saved cursor with its pen and charset.
        b"\x1b[3;3H\x1b[1m\x1b7\x1b[0m\x1b[5;5Hx\x1b8y",
        // Preserve insert and newline modes with wrapping disabled.
        b"abcdef\x1b[1;2H\x1b[4hXY\x1b[4l\x1b[20hl1\nl2\x1b[20l\x1b[?7l0123456789abcdef",
        // Preserve hyperlinks, including one open at the split.
        b"\x1b]8;id=1;http://a\x1b\\link\x1b]8;;\x1b\\ \x1b]8;;http://b\x1b\\open",
        // Filter terminal queries from viewer output.
        b"q\x1b[6nr\x1b[cs\x1b]11;?\x07t",
        // Preserve a synchronized update.
        b"\x1b[?2026hframe\r\nline\x1b[?2026l after",
        // Preserve tab stops after clearing, setting, and clearing them again.
        b"A\x1b[3g\tZ\r\x1b[5G\x1bH\x1b[8G\x1bH\r\tB\tC\x1b[5G\x1b[g\r\tD",
        // Apply a shift to G1 immediately, even inside a CSI sequence.
        b"\x1b)0\x1b[\x0emqq\x0fqq",
        // Preserve modifyOtherKeys through set, reset, and disable sequences.
        b"A\x1b[>4;2mB\x1b[>4mC\x1b[>4;1mD\x1b[>4nE\x1b[>4;2mF",
        // Set tab stops at the cursor position inside synchronized updates, including an update
        // that returns to the main screen.
        b"\x1b[?2026h\x1b[3g\x1b[1;6H\x1bH\x1b[?2026l\r\tZ",
        b"MAIN\x1b[?1049hALT\x1b[?2026h\x1b[?1049l\x1bH\x1b[?2026lTAIL",
    ];
    for stream in streams {
        assert_redraw_at_every_split(stream, 10, 5, b"");
        assert_redraw_at_every_split(stream, 10, 5, dirty);
    }
}

/// modifyOtherKeys distinguishes a level, including zero, from the terminal's initial setting
/// and from disabled. A redraw must preserve the selected state.
#[test]
fn a_redraw_restores_the_modify_other_keys_state_the_program_left() {
    use kept_modes::ModifyOtherKeys::{Disabled, Initial, Level};
    let cases: [(&[u8], kept_modes::ModifyOtherKeys, &[u8]); 7] = [
        (b"", Initial, b""),
        (b"\x1b[>4;2m", Level(2), b"\x1b[>4;2m"),
        (b"\x1b[>4;0m", Level(0), b"\x1b[>4;0m"),
        (b"\x1b[>4;2m\x1b[>4m", Initial, b""),
        (b"\x1b[>4;2m\x1b[>m", Initial, b""),
        (b"\x1b[>4;2m\x1b[>4n", Disabled, b"\x1b[>4n"),
        (b"\x1b[>4;2m\x1bc", Initial, b""),
    ];
    for (written, state, restored) in cases {
        let mut screen = Screen::new(20, 4, 100);
        screen.feed(written);
        assert_eq!(
            screen.modes.modify_other_keys,
            state,
            "{}",
            String::from_utf8_lossy(written)
        );
        let redraw = screen.redraw(false, false);
        // Reset to the viewer's initial setting, then restore the CLI's selected state.
        let reset = redraw
            .windows(5)
            .position(|w| w == b"\x1b[>4m")
            .expect("redraw must reset modifyOtherKeys before restoring its state");
        let after = &redraw[reset + 5..];
        let set: Vec<&[u8]> = [&b"\x1b[>4;"[..], &b"\x1b[>4n"[..]]
            .into_iter()
            .filter(|seq| after.windows(seq.len()).any(|w| w == *seq))
            .collect();
        if restored.is_empty() {
            assert!(
                set.is_empty(),
                "{}: redraw must preserve the initial modifyOtherKeys setting",
                String::from_utf8_lossy(written)
            );
        } else {
            assert!(
                after.windows(restored.len()).any(|w| w == restored),
                "{}: not restored",
                String::from_utf8_lossy(written)
            );
        }
    }
}

/// A redraw gives a viewer the kitty keyboard flags in force on the screen in use, as the CLI
/// left them with pushes, pops and changes, each screen keeping its own, so that a viewer that
/// comes later encodes keys as one that saw them. The CLI's query for the flags stays
/// unanswered and unseen, and its push reaches viewers.
#[test]
fn a_redraw_restores_the_kitty_keyboard_flags_the_program_left() {
    let cases: [(&[u8], u8, u8); 10] = [
        (b"", 0, 0),
        (b"\x1b[>7u", 7, 0),
        (b"\x1b[>7u\x1b[>1u\x1b[<u", 7, 0),
        (b"\x1b[>7u\x1b[<5u", 0, 0),
        (b"\x1b[=5u\x1b[>7u\x1b[<u", 5, 0),
        (b"\x1b[>1u\x1b[=4;2u", 5, 0),
        (b"\x1b[>7u\x1b[=2;3u", 5, 0),
        (b"\x1b[>7u\x1b[?1049h\x1b[>3u", 7, 3),
        (b"\x1b[>7u\x1b[?1049h\x1b[>3u\x1b[?1049l", 7, 3),
        (b"\x1b[>7u\x1b[?1049h\x1b[>3u\x1bc", 0, 0),
    ];
    for (written, main, alternate) in cases {
        let shown = String::from_utf8_lossy(written);
        let mut screen = Screen::new(20, 4, 100);
        screen.feed(written);
        let keyboard = &screen.modes.keyboard;
        assert_eq!(
            (keyboard.main(), keyboard.alternate()),
            (main, alternate),
            "{shown}"
        );
        let (in_force, viewer_in_force): (u8, fn(&Screen) -> u8) = if screen.on_alternate_screen() {
            (alternate, |viewer| viewer.modes.keyboard.alternate())
        } else {
            (main, |viewer| viewer.modes.keyboard.main())
        };
        let redraw = screen.redraw(false, false);
        let restored = format!("\x1b[={in_force};1u");
        assert!(
            redraw
                .windows(restored.len())
                .any(|w| w == restored.as_bytes()),
            "{shown}: {}",
            String::from_utf8_lossy(&redraw)
        );
        let mut viewer = Screen::new(20, 4, 100);
        viewer.feed(&redraw);
        assert_eq!(
            viewer_in_force(&viewer),
            in_force,
            "{shown}: a viewer of the redraw"
        );
    }
    let fed = Screen::new(20, 4, 100).feed(b"\x1b[>7u\x1b[?u");
    assert!(
        fed.query_replies.is_empty(),
        "{:?}",
        String::from_utf8_lossy(&fed.query_replies)
    );
    assert_eq!(fed.viewer_output, b"\x1b[>7u");
}

/// A tab-stop change inside a synchronized update must not expose a partial frame.
#[test]
fn a_tab_stop_inside_an_update_leaves_the_update_open() {
    let mut screen = Screen::new(20, 4, 100);
    screen.feed(b"\x1b[?2026hhalf\x1bH");
    assert!(
        screen.synchronized_update_deadline().is_some(),
        "the update must remain open after setting a tab stop"
    );
    screen.feed(b" frame\x1b[?2026l");
    assert!(screen.synchronized_update_deadline().is_none());
    assert_eq!(screen.text(1), vec!["half frame"]);
}

#[test]
fn a_redraw_inside_an_unfinished_sequence_continues_correctly() {
    let long = |start: &[u8], filler: u8, count: usize| [start, &vec![filler; count]].concat();
    let cases: Vec<(Vec<u8>, &[u8])> = vec![
        // Drop an oversized string as a whole.
        (long(b"\x1b]0;", b'a', 65_540), b"TAIL\x07Z"),
        (long(b"\x1b]52;c;", b'a', 1_100_000), b"TAIL\x1b\\Z"),
        // Hold a long CSI sequence until complete.
        (long(b"\x1b[", b'0', 300), b"mZ"),
        // Apply a C0 control inside a sequence exactly once.
        (b"A\x1b[31\n".to_vec(), b"mB"),
        (b"A\x1b(\n".to_vec(), b"0q"),
        // ESC abandons the pending sequence; CAN and SUB cancel it and take effect themselves.
        (b"A\x1b[31\x1b".to_vec(), b"[32mB"),
        (b"A\x1b[3\x18".to_vec(), b"1mB"),
        (b"A\x1b[3\x1a".to_vec(), b"1mB"),
        // ESC ends a string even without ST.
        (b"A\x1b]0;t\x1b".to_vec(), b"[1mZ"),
    ];
    for (prefix, suffix) in cases {
        assert_redraw_continuation(&prefix, suffix, 40, 8, b"");
        assert_redraw_continuation(&prefix, suffix, 40, 8, b"\x1b[?1049h\x1b[33mold");
    }
}
