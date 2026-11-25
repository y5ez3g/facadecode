#[cfg(test)]
mod tests {
    use super::super::recovery::{RecoveredScreen, recover_with};
    use super::super::*;
    use crate::test_folder::TestFolder;
    use std::fs::OpenOptions;
    use std::io::Read;
    use std::path::Path;

    use tokio::sync::oneshot;

    impl ScreenLog {
        /// Starts a test checkpoint whose disk task waits for release; takes no lock.
        pub(crate) fn begin_stalled_checkpoint(
            &mut self,
            checkpoint: Checkpoint,
            released: oneshot::Receiver<()>,
        ) {
            if let Some(job) = self.prepare_checkpoint(checkpoint) {
                self.writer = Some(tokio::spawn(async move {
                    let _ = released.await;
                    tokio::task::spawn_blocking(move || job.run())
                        .await
                        .unwrap_or_else(|e| Err(io::Error::other(e)))
                }));
            }
        }
        /// Fills the test log until even the smallest record no longer fits; blocks without locks.
        pub(crate) fn fill_to_the_cap(&mut self) {
            let chunk = vec![b'x'; MAX_FEED_BYTES];
            while !self.near_cap() {
                self.append_output(&chunk);
            }
            loop {
                let room = MAX_LOG_BYTES - self.log_bytes;
                let overhead = 9 + room.to_string().len() as u64;
                if room < overhead {
                    break;
                }
                self.append_output(&vec![b'x'; (room - overhead) as usize]);
            }
        }
    }

    /// Agent a1's screen folder in a folder of the test's own.
    fn temp_dir(test: &str) -> (TestFolder, PathBuf) {
        let folder = TestFolder::new(&format!("screen-log-{test}"));
        let dir = folder.join("screens").join("a1");
        (folder, dir)
    }

    #[test]
    fn released_screens_share_the_read_only_placeholder() {
        let first = LoggedScreen::released(PathBuf::new(), "a1");
        let second = LoggedScreen::released(PathBuf::new(), "a2");
        assert!(!first.is_held() && !second.is_held());
        assert_eq!((first.screen().cols(), first.screen().rows()), (2, 1));
        assert!(std::ptr::eq(first.screen(), second.screen()));
    }

    /// Copies an agent folder, so each simulated crash recovers from the same files.
    fn copy_dir(from: &Path, to: &Path) {
        let _ = std::fs::remove_dir_all(to);
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }

    /// Logs output the way the actor does: each chunk to the log, then to the screen.
    struct Recorder {
        screen: Screen,
        log: ScreenLog,
    }

    impl Recorder {
        fn new(dir: &Path, cols: u16, rows: u16) -> Recorder {
            let screen = Screen::new(cols, rows, SCROLLBACK_ROWS);
            let log = ScreenLog::create(dir.to_path_buf(), "a1", Checkpoint::capture(&screen));
            Recorder { screen, log }
        }

        fn output(&mut self, bytes: &[u8]) {
            self.log.append_output(bytes);
            self.screen.feed(bytes);
        }

        fn resize(&mut self, cols: u16, rows: u16) {
            self.log.append_resize(cols, rows);
            self.screen.resize(cols, rows);
        }

        /// Ends a synchronized update the way the actor does when the CLI does not end it in time.
        fn end_sync(&mut self) {
            self.log.append_sync_end();
            self.screen.end_synchronized_update();
        }

        /// Takes a checkpoint and moves logging to the next generation without publishing it.
        fn capture(&mut self) -> CheckpointJob {
            self.log
                .prepare_checkpoint(Checkpoint::capture(&self.screen))
                .expect("expected a log for the checkpoint")
        }

        /// Runs a checkpoint job and records its result, as the actor does when the writer task
        /// ends.
        fn finish(&mut self, job: CheckpointJob) -> io::Result<()> {
            let result = job.run();
            let failed = result
                .as_ref()
                .map_err(|err| io::Error::new(err.kind(), err.to_string()))
                .err();
            self.log.finish_checkpoint(Ok(result));
            failed.map_or(Ok(()), Err)
        }
    }

    /// The state recovery must reproduce: every retained row, cursor, pen, and mode.
    #[derive(Debug, PartialEq)]
    struct State {
        redraw: Vec<u8>,
        text: Vec<String>,
        cursor: (u16, u16),
        alternate: bool,
    }

    fn state(screen: &Screen) -> State {
        State {
            redraw: screen.redraw_with_all_scrollback(),
            text: screen.text(usize::from(screen.rows()) + SCROLLBACK_ROWS),
            cursor: screen.cursor(),
            alternate: screen.on_alternate_screen(),
        }
    }

    fn recover_quietly(dir: &Path, live_size: Option<(u16, u16)>) -> RecoveredScreen {
        recover(dir, "a1", live_size, &|| {})
    }

    /// The generation numbers left in a folder.
    fn generations(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn numbered_lines(from: usize, to: usize) -> Vec<u8> {
        (from..to)
            .map(|n| format!("line {n:05} \x1b[3{}mcolour\x1b[0m\r\n", n % 8))
            .collect::<String>()
            .into_bytes()
    }

    #[test]
    fn a_record_is_written_whole_through_short_and_interrupted_writes() {
        /// Takes at most three bytes per write and fails every other write with EINTR.
        struct Stingy(Vec<u8>, bool);
        impl Write for Stingy {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.1 = !self.1;
                if self.1 {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                let taken = bytes.len().min(3);
                self.0.extend_from_slice(&bytes[..taken]);
                Ok(taken)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut out = Stingy(Vec::new(), false);
        let records = [
            output_record(b"\x1b[31mred\xe2\x82"),
            resize_record(40, 12),
            output_record(b"\xacx"),
        ];
        for record in &records {
            ScreenLog::write_record(&mut out, record).unwrap();
        }
        assert_eq!(out.0, records.concat());
    }

    #[test]
    fn a_crash_inside_the_last_record_drops_only_that_record() {
        let (_folder, dir) = temp_dir("truncated");
        let mut recorder = Recorder::new(&dir, 40, 6);
        // Older checkpoints kept the title in metadata alone.
        let checkpoint = Checkpoint::capture_with_title(&recorder.screen, Some("checkpoint title"));
        write_checkpoint(&dir, 1, &checkpoint).unwrap();
        let (screen, title) = load(&dir, "a1").unwrap();
        assert_eq!(title.as_deref(), Some("checkpoint title"));
        let mut viewer = Screen::new(40, 6, SCROLLBACK_ROWS);
        let drawn = viewer.feed(&screen.redraw(false, false));
        assert_eq!(drawn.title_change.as_deref(), Some("checkpoint title"));

        recorder.output(b"first line\r\n\x1b]0;a title\x07");
        recorder.resize(30, 6);
        recorder.output(b"second line\r\n");
        let complete = state(&recorder.screen);
        let length = std::fs::metadata(log_path(&dir, 1)).unwrap().len();
        recorder.output(b"third \xe2\x82\xac line\r\n");
        let last = std::fs::metadata(log_path(&dir, 1)).unwrap().len();
        let copy = dir.with_file_name("a1-copy");
        for cut in length..last {
            copy_dir(&dir, &copy);
            OpenOptions::new()
                .write(true)
                .open(log_path(&copy, 1))
                .unwrap()
                .set_len(cut)
                .unwrap();
            let recovered = recover_quietly(&copy, None);
            assert_eq!(
                state(&recovered.screen),
                complete,
                "log cut at byte {cut} of {last}"
            );
        }
        copy_dir(&dir, &copy);
        let recovered = recover_quietly(&copy, None);
        assert_eq!(state(&recovered.screen), state(&recorder.screen));
        assert_eq!(
            recovered.log.unwrap().recovered_title.as_deref(),
            Some("a title")
        );
        let (screen, title) = load(&copy, "a1").unwrap();
        assert_eq!(title.as_deref(), Some("a title"));
        let mut viewer = Screen::new(30, 6, SCROLLBACK_ROWS);
        let drawn = viewer.feed(&screen.redraw(false, false));
        assert_eq!(drawn.title_change.as_deref(), Some("a title"));
    }

    /// The log of agent a1 in `dir`'s generation `generation`, and its length.
    fn log_length(dir: &Path, generation: u64) -> u64 {
        std::fs::metadata(log_path(dir, generation)).unwrap().len()
    }

    #[test]
    fn after_a_clean_end_output_goes_on_in_the_published_log_and_a_crash_recovery_gives_the_same_screen()
     {
        let (_folder, dir) = temp_dir("cleanend");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(&numbered_lines(0, 20));
        recorder.resize(30, 6);
        recorder.output(b"before the takeover \xe2\x82\xac\r\n");
        let Recorder { screen, log } = recorder;
        drop(log);
        let (files, length) = (generations(&dir), log_length(&dir, 1));
        let recovered = recover_after_clean_end(&dir, "a1", None, &|| {});
        assert_eq!(state(&recovered.screen), state(&screen));
        assert_eq!(
            (generations(&dir), log_length(&dir, 1)),
            (files.clone(), length),
            "a clean end's recovery writes nothing"
        );
        let mut next = Recorder {
            screen: recovered.screen,
            log: recovered.log.expect("the log goes on"),
        };
        next.output(b"after the takeover\r\n");
        next.resize(40, 6);
        assert!(
            log_length(&dir, 1) > length && generations(&dir) == files,
            "the output goes on in the published log"
        );
        // A crash now: the next recovery replays both daemons' output from the same checkpoint.
        let copy = dir.with_file_name("a1-copy");
        copy_dir(&dir, &copy);
        assert_eq!(
            state(&recover_quietly(&copy, None).screen),
            state(&next.screen)
        );
        // A crash inside a record the new daemon appended drops only that record.
        let (complete, whole) = (state(&next.screen), log_length(&dir, 1));
        next.output(b"cut \xe2\x82\xac short\r\n");
        for cut in whole..log_length(&dir, 1) {
            copy_dir(&dir, &copy);
            OpenOptions::new()
                .write(true)
                .open(log_path(&copy, 1))
                .unwrap()
                .set_len(cut)
                .unwrap();
            assert_eq!(
                state(&recover_quietly(&copy, None).screen),
                complete,
                "log cut at byte {cut}"
            );
        }
    }

    #[test]
    fn files_a_clean_end_does_not_leave_are_folded_as_after_a_crash() {
        let (_folder, dir) = temp_dir("notclean");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"whole\r\n");
        let complete = state(&recorder.screen);
        let whole = log_length(&dir, 1);
        recorder.output(b"cut short\r\n");
        let copy = dir.with_file_name("a1-copy");
        // A log whose last record is cut: the new daemon appends nothing after it, and the fold
        // drops that record.
        copy_dir(&dir, &copy);
        OpenOptions::new()
            .write(true)
            .open(log_path(&copy, 1))
            .unwrap()
            .set_len(whole + 3)
            .unwrap();
        let recovered = recover_after_clean_end(&copy, "a1", None, &|| {});
        assert_eq!(state(&recovered.screen), complete);
        assert_eq!(
            recovered.log.as_ref().map(|log| log.generation),
            Some(2),
            "{:?}",
            generations(&copy)
        );
        // A log after the published one that follows unlogged output, which no replay reads: a fold
        // deletes it, so the published log is not appended to with that log after it.
        copy_dir(&dir, &copy);
        create_log(&copy, 2, true).unwrap();
        let recovered = recover_after_clean_end(&copy, "a1", None, &|| {});
        assert_eq!(
            recovered.log.as_ref().map(|log| log.generation),
            Some(3),
            "{:?}",
            generations(&copy)
        );
        assert!(!log_path(&copy, 2).exists(), "{:?}", generations(&copy));
        // A checkpoint under way when that daemon ended: its log goes on after the published one's,
        // and the two are folded.
        let _job = recorder.capture();
        recorder.output(b"in the next generation\r\n");
        let recovered = recover_after_clean_end(&dir, "a1", None, &|| {});
        assert_eq!(state(&recovered.screen), state(&recorder.screen));
        assert_eq!(
            recovered.log.as_ref().map(|log| log.generation),
            Some(3),
            "{:?}",
            generations(&dir)
        );
    }

    #[test]
    fn a_crash_at_any_step_of_publishing_a_checkpoint_loses_nothing() {
        let (_folder, dir) = temp_dir("publication");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(&numbered_lines(0, 50));
        let first = recorder.capture();
        recorder.finish(first).unwrap();
        recorder.output(&numbered_lines(50, 100));
        let second = recorder.capture();
        recorder.output(&numbered_lines(100, 120));
        let expected = state(&recorder.screen);
        let encoded = second.checkpoint.encode();
        // Simulate a crash before any write, after half or all of the checkpoint, after replacing
        // `current`, and after deleting the oldest generation.
        let steps: [&dyn Fn(&Path); 5] = [
            &|_| {},
            &|dir| std::fs::write(checkpoint_path(dir, 3), &encoded[..encoded.len() / 2]).unwrap(),
            &|dir| write_checkpoint(dir, 3, &second.checkpoint).unwrap(),
            &|dir| {
                write_checkpoint(dir, 3, &second.checkpoint).unwrap();
                // Generation 1 is the lowest: nothing is below it to delete.
                publish(dir, 3, 1).unwrap();
            },
            &|dir| {
                write_checkpoint(dir, 3, &second.checkpoint).unwrap();
                publish(dir, 3, 2).unwrap();
            },
        ];
        let copy = dir.with_file_name("a1-copy");
        for (step, crash_after) in steps.iter().enumerate() {
            copy_dir(&dir, &copy);
            crash_after(&copy);
            let recovered = recover_quietly(&copy, None);
            assert_eq!(
                state(&recovered.screen),
                expected,
                "crash after step {step}"
            );
            assert_eq!(
                generations(&copy).len(),
                3,
                "step {step}: one checkpoint, one log, and current remain: {:?}",
                generations(&copy)
            );
        }
    }

    #[test]
    fn a_damaged_published_checkpoint_falls_back_to_the_generation_before_it() {
        let (_folder, dir) = temp_dir("fallback");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(&numbered_lines(0, 40));
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(&numbered_lines(40, 80));
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(&numbered_lines(80, 90));
        // After the second publication, generations 2 and 3 remain: the fallback and the current
        // one.
        assert_eq!(
            generations(&dir),
            ["2.checkpoint", "2.log", "3.checkpoint", "3.log", "current"]
        );
        let mut damaged = std::fs::read(checkpoint_path(&dir, 3)).unwrap();
        let middle = damaged.len() / 2;
        damaged[middle] ^= 1;
        std::fs::write(checkpoint_path(&dir, 3), damaged).unwrap();
        let recovered = recover_quietly(&dir, None);
        assert_eq!(state(&recovered.screen), state(&recorder.screen));
        assert_eq!(
            generations(&dir),
            ["4.checkpoint", "4.log", "current"],
            "the fold leaves one checkpoint and one log"
        );
    }

    #[test]
    fn a_resize_after_a_checkpoint_replays_at_the_sizes_the_output_had() {
        let (_folder, dir) = temp_dir("resize");
        let mut recorder = Recorder::new(&dir, 80, 10);
        recorder.output(
            b"\x1b[2;70Hfar right\x1b[5;1Hwide line that is longer than forty columns, so it wraps \
              when narrow\r\n",
        );
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(b"\x1b[3;60Hlater\x1b[3;62H\x1b[K\x1b[8;1Hbefore resize");
        recorder.resize(40, 10);
        recorder.output(
            b"\x1b[1;35Hedge\x1b[6;1H\x1b[2Kafter resize, a line longer than forty columns",
        );
        let recovered = recover_quietly(&dir, None);
        assert_eq!(state(&recovered.screen), state(&recorder.screen));
    }

    #[test]
    fn saved_size_is_the_size_recovery_restores_with_resizes_logged_after_the_checkpoint() {
        // After a restart, an ended agent takes its size from `saved_size`, which follows the chain
        // `replay` follows on its own.
        let (_folder, dir) = temp_dir("savedsize");
        let mut recorder = Recorder::new(&dir, 80, 10);
        recorder.output(b"before\r\n");
        recorder.resize(60, 12);
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        assert_eq!(saved_size(&dir), (60, 12), "the checkpoint's size");
        recorder.resize(100, 30);
        recorder.output(b"after\r\n");
        recorder.resize(90, 25);
        assert_eq!(
            saved_size(&dir),
            (90, 25),
            "the last size logged after the checkpoint"
        );
        // A checkpoint taken and not yet published: the chain goes on into the next generation's
        // log.
        let _never_published = recorder.capture();
        recorder.resize(70, 20);
        assert_eq!(
            saved_size(&dir),
            (70, 20),
            "the last size logged in the next generation's log"
        );
        let recovered = recover_quietly(&dir, None);
        assert_eq!(
            (recovered.screen.cols(), recovered.screen.rows()),
            (70, 20),
            "the size recovery restores"
        );
    }

    #[test]
    fn the_logged_size_is_the_agent_s_size_and_the_terminal_s_counts_only_without_a_checkpoint() {
        let (_folder, dir) = temp_dir("loggedsize");
        let mut recorder = Recorder::new(&dir, 80, 10);
        recorder.output(b"some text\r\n");
        recorder.resize(60, 12);
        // A terminal left one column narrower by a recovery that ended inside its nudge does not
        // change the agent's size.
        for _ in 0..3 {
            let recovered = recover_quietly(&dir, Some((59, 12)));
            assert_eq!((recovered.screen.cols(), recovered.screen.rows()), (60, 12));
        }
        let empty = dir.with_file_name("a2");
        let recovered = recover_quietly(&empty, Some((59, 12)));
        assert_eq!(
            (recovered.screen.cols(), recovered.screen.rows()),
            (59, 12),
            "without a checkpoint, the terminal's size is all there is"
        );
    }

    #[test]
    fn crashes_before_a_fold_is_published_never_replay_a_line_twice() {
        let (_folder, dir) = temp_dir("refold");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(&numbered_lines(0, 60));
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(&numbered_lines(60, 90));
        // Leave an unfinished sequence so recovery must keep the records after its checkpoint.
        recorder.output(b"tail \x1b[3");
        let expected = state(&recorder.screen);
        let copy = dir.with_file_name("a1-copy");
        let mut candidate: Option<String> = None;
        for attempt in 0..4 {
            // Simulate a recovery that deletes an unpublished candidate, writes its replacement,
            // and ends before publishing it.
            copy_dir(&dir, &copy);
            let _ = recover_quietly(&copy, None);
            let folded = std::fs::read_to_string(copy.join("current"))
                .unwrap()
                .trim()
                .to_string();
            if let Some(earlier) = candidate.replace(folded.clone()) {
                assert!(
                    folded.parse::<u64>().unwrap() > earlier.parse::<u64>().unwrap(),
                    "recovery chooses a checkpoint number above every file on disk"
                );
                std::fs::remove_file(dir.join(format!("{earlier}.checkpoint"))).unwrap();
                std::fs::remove_file(dir.join(format!("{earlier}.log"))).unwrap();
            }
            for file in [format!("{folded}.checkpoint"), format!("{folded}.log")] {
                std::fs::copy(copy.join(&file), dir.join(&file)).unwrap();
            }
            copy_dir(&dir, &copy);
            let recovered = recover_quietly(&copy, None);
            assert_eq!(state(&recovered.screen), expected, "attempt {attempt}");
            assert_eq!(
                generations(&copy).len(),
                3,
                "the next recovery deletes the unpublished candidate: {:?}",
                generations(&copy)
            );
        }
        let recovered = recover_quietly(&dir, None);
        assert_eq!(state(&recovered.screen), expected);
        assert_eq!(generations(&dir).len(), 3, "{:?}", generations(&dir));
    }

    #[test]
    fn an_unfinished_state_is_kept_raw_so_a_third_recovery_equals_the_original_chain() {
        let cases: [(&[u8], &[u8]); 4] = [
            (
                b"main text\r\n\x1b[?1049h\x1b[2;3Halternate",
                b" more\x1b[?1049lback on main",
            ),
            (b"plain \x1b[3", b"1mRED\x1b[0m done"),
            (b"euro \xe2\x82", b"\xac sign"),
            (b"\x1b[?2026hhalf a fr", b"ame\x1b[?2026l shown"),
        ];
        for (case, (unfinished, continuation)) in cases.iter().enumerate() {
            let (_folder, dir) = temp_dir(&format!("unfinished{case}"));
            let mut recorder = Recorder::new(&dir, 40, 6);
            recorder.output(&numbered_lines(0, 30));
            let job = recorder.capture();
            recorder.finish(job).unwrap();
            recorder.output(&numbered_lines(30, 40));
            recorder.output(unfinished);
            let second = recover_quietly(&dir, None);
            drop(second);
            let mut third = recover_quietly(&dir, None);
            third.screen.feed(continuation);
            recorder.output(continuation);
            assert_eq!(state(&third.screen), state(&recorder.screen), "case {case}");
        }
    }

    #[test]
    fn a_write_error_seals_the_log_until_a_later_checkpoint_is_published() {
        let (_folder, dir) = temp_dir("sealed");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"before the failure\r\n");
        let sealed_point = state(&recorder.screen);
        // The disk refuses the next record before a single byte of it is written, as on a full
        // disk.
        recorder.log.file = Some(File::open(log_path(&dir, 1)).unwrap());
        recorder.output(b"not logged\r\n");
        assert!(recorder.log.file.is_none(), "a write error seals the log");
        recorder.output(b"not logged either\r\n");
        let job = recorder.capture();
        assert!(
            LogReader::open(&log_path(&dir, 2), &open_log_file)
                .unwrap()
                .unwrap()
                .requires_own_checkpoint,
            "the log after a gap says so"
        );
        recorder.output(b"logged again\r\n");
        let copy = dir.with_file_name("a1-copy");
        copy_dir(&dir, &copy);
        let recovered = recover_quietly(&copy, None);
        assert_eq!(
            state(&recovered.screen),
            sealed_point,
            "a log after a gap requires its own published checkpoint"
        );
        recorder.finish(job).unwrap();
        let recovered = recover_quietly(&dir, None);
        assert_eq!(state(&recovered.screen), state(&recorder.screen));
    }

    #[test]
    fn a_synchronized_update_the_daemon_ended_is_replayed_where_it_ended() {
        // Follow the synchronized-update end with a resize, a title change, or the rest of an
        // unfinished sequence.
        let after_end: [&[&[u8]]; 3] = [
            &[b"RESIZE"],
            &[b"\x1b]0;new title\x07", b"\x1b[?2026l"],
            &[b"\x1b[3", b"1mRED\x1b[0m"],
        ];
        for (case, steps) in after_end.iter().enumerate() {
            let (_folder, dir) = temp_dir(&format!("syncend{case}"));
            let mut recorder = Recorder::new(&dir, 80, 6);
            recorder.output(b"\x1b]0;old title\x07\x1b[?2026h\x1b[1;70HMARK");
            if case == 2 {
                recorder.output(steps[0]);
            }
            assert!(recorder.screen.synchronized_update_deadline().is_some());
            recorder.end_sync();
            match case {
                0 => recorder.resize(40, 6),
                1 => recorder.output(steps[0]),
                _ => recorder.output(steps[1]),
            }
            recorder.output(b"\x1b[?2026l tail");
            let recovered = recover_quietly(&dir, None);
            assert_eq!(
                state(&recovered.screen),
                state(&recorder.screen),
                "case {case}"
            );
        }
    }

    #[test]
    fn a_checkpoint_that_keeps_failing_is_written_again_for_the_same_generation() {
        // Fail checkpoint writing, `current` replacement, and syncing. Simulate failures with a
        // blocked path or an injected error.
        type Obstacle = dyn Fn(&Path) -> Option<io::Error>;
        let obstacles: [&Obstacle; 3] = [
            &|dir| {
                std::fs::create_dir(checkpoint_path(dir, 2)).unwrap();
                None
            },
            &|dir| {
                std::fs::create_dir(dir.join("current.next")).unwrap();
                None
            },
            &|_| Some(io::Error::other("the disk could not sync")),
        ];
        for (case, obstacle) in obstacles.iter().enumerate() {
            let (_folder, dir) = temp_dir(&format!("failing{case}"));
            let mut recorder = Recorder::new(&dir, 40, 6);
            recorder.output(b"FIRST\r\n");
            let synced = obstacle(&dir);
            let job = recorder.capture();
            let first_attempt = match &synced {
                Some(err) => Err(io::Error::new(err.kind(), err.to_string())),
                None => job.run(),
            };
            recorder.log.finish_checkpoint(Ok(first_attempt));
            for attempt in 0..6 {
                recorder.output(format!("line {attempt}\r\n").as_bytes());
                recorder.log.output_since_capture = CHECKPOINT_AFTER_BYTES;
                let retry = recorder
                    .log
                    .prepare_retry()
                    .expect("a failed checkpoint is written again after more output");
                assert_eq!(
                    retry.generation, 2,
                    "case {case}: retry the same checkpoint and log"
                );
                let result = match &synced {
                    Some(err) => Err(io::Error::new(err.kind(), err.to_string())),
                    None => retry.run(),
                };
                recorder.log.finish_checkpoint(Ok(result));
                let numbers = Generations::scan(&dir).unwrap().numbers;
                assert!(
                    numbers.len() <= 2,
                    "case {case}, attempt {attempt}: {:?}",
                    generations(&dir)
                );
                assert!(recorder.log.log_bytes <= MAX_LOG_BYTES);
            }
            let _ = std::fs::remove_dir(checkpoint_path(&dir, 2));
            let _ = std::fs::remove_dir(dir.join("current.next"));
            recorder.output(b"SECOND\r\n");
            recorder.log.output_since_capture = CHECKPOINT_AFTER_BYTES;
            let retry = recorder.log.prepare_retry().expect("a retry");
            recorder.finish(retry).unwrap();
            assert_eq!(recorder.log.published, 2, "case {case}");
            recorder.output(b"THIRD\r\n");
            let recovered = recover_quietly(&dir, None);
            assert_eq!(
                state(&recovered.screen),
                state(&recorder.screen),
                "case {case}"
            );
        }
    }

    #[test]
    fn a_full_log_after_a_failed_checkpoint_is_sealed_rather_than_holding_back_output() {
        let (_folder, dir) = temp_dir("failedfull");
        let mut recorder = Recorder::new(&dir, 80, 6);
        recorder.output(b"before\r\n");
        std::fs::create_dir(dir.join("current.next")).unwrap();
        let job = recorder.capture();
        recorder.finish(job).unwrap_err();
        let chunk = vec![b'x'; 64 * 1024];
        let mut written = 0;
        while recorder.log.file.is_some() {
            assert!(
                !recorder.log.backpressured(),
                "a failed checkpoint never holds back output"
            );
            assert!(
                written < 2 * MAX_LOG_BYTES,
                "the log must be sealed at the cap"
            );
            recorder.log.append_output(&chunk);
            written += chunk.len() as u64;
            assert!(recorder.log.log_bytes <= MAX_LOG_BYTES);
        }
        assert!(
            written >= MAX_LOG_BYTES - 2 * MAX_RECORD_BYTES,
            "sealed early, after {written} bytes"
        );
        // Output continues without logging. Retry the pending checkpoint with the same generation
        // number.
        for _ in 0..3 {
            recorder.log.append_output(&chunk);
            recorder.log.output_since_capture = CHECKPOINT_AFTER_BYTES;
            let retry = recorder
                .log
                .prepare_retry()
                .expect("the sealed log's checkpoint is written again");
            assert_eq!(retry.generation, 2);
            recorder.finish(retry).unwrap_err();
            assert!(
                Generations::scan(&dir).unwrap().numbers.len() <= 3,
                "{:?}",
                generations(&dir)
            );
        }
        std::fs::remove_dir(dir.join("current.next")).unwrap();
        recorder.log.output_since_capture = CHECKPOINT_AFTER_BYTES;
        let retry = recorder.log.prepare_retry().expect("a retry");
        recorder.finish(retry).unwrap();
        // The next checkpoint, at a clean point, starts a log after the gap and resumes logging.
        recorder.screen = Screen::new(80, 6, SCROLLBACK_ROWS);
        recorder.output(b"\x1b[H\x1b[Jafter the gap\r\n");
        let job = recorder.capture();
        assert!(
            job.generation == 3
                && LogReader::open(&log_path(&dir, 3), &open_log_file)
                    .unwrap()
                    .unwrap()
                    .requires_own_checkpoint
        );
        recorder.finish(job).unwrap();
        recorder.output(b"logged again\r\n");
        assert!(
            Generations::scan(&dir).unwrap().numbers.len() <= 3,
            "{:?}",
            generations(&dir)
        );
        let recovered = recover_quietly(&dir, None);
        assert_eq!(recovered.screen.text(10), recorder.screen.text(10));
    }

    #[test]
    fn a_fold_whose_unclean_records_would_fill_a_log_checkpoints_where_they_do() {
        let (_folder, dir) = temp_dir("foldcap");
        let mut recorder = Recorder::new(&dir, 80, 6);
        recorder.output(b"MAIN\r\n\x1b[?1049hALT");
        // Fill the first log without reaching a clean point. Test a crash there, then another after
        // an unpublished forced checkpoint and a second full log.
        let chunk = vec![0u8; 64 * 1024];
        while !recorder.log.must_force_checkpoint() {
            recorder.output(&chunk);
        }
        let one_log = dir.with_file_name("a1-one-log");
        copy_dir(&dir, &one_log);
        let _never_published = recorder.capture();
        while recorder.log.log_bytes + MAX_RECORD_BYTES <= MAX_LOG_BYTES {
            recorder.output(&chunk);
        }
        let two_logs = dir.with_file_name("a1-two-logs");
        copy_dir(&dir, &two_logs);
        for copy in [&one_log, &two_logs] {
            let recovered = recover_quietly(copy, None);
            assert_eq!(recovered.screen.text(6), recorder.screen.text(6));
            let folded =
                std::fs::metadata(log_path(copy, recovered.log.as_ref().unwrap().generation))
                    .unwrap()
                    .len();
            assert!(
                folded + MAX_RECORD_BYTES <= MAX_LOG_BYTES,
                "{}: the folded log holds {folded} bytes, too many for the next record",
                copy.display()
            );
            // The actor can keep appending without sealing the log. Recovery must include those
            // records and keep the combined log within its limit.
            let (mut log, mut screen) = (recovered.log.unwrap(), recovered.screen);
            log.append_output(b"\r\nAFTER");
            screen.feed(b"\r\nAFTER");
            assert!(log.file.is_some(), "the log was sealed");
            drop(log);
            let again = recover_quietly(copy, None);
            assert_eq!(again.screen.text(6), screen.text(6));
            let refolded = std::fs::metadata(log_path(copy, again.log.unwrap().generation))
                .unwrap()
                .len();
            assert!(
                refolded <= folded + output_record(b"\r\nAFTER").len() as u64,
                "the log grew from {folded} to {refolded} bytes"
            );
        }
        // Once the CLI is back on the main screen, the fold starts from that clean point instead,
        // and keeps the main screen.
        recorder.output(b"\x1b[?1049lBACK");
        recover_quietly(&dir, None);
        assert_eq!(
            recover_quietly(&dir, None).screen.text(6),
            recorder.screen.text(6)
        );
    }

    #[test]
    fn a_fold_that_cannot_be_published_is_removed_and_its_generation_created_again() {
        let (_folder, dir) = temp_dir("foldfailed");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"FIRST\r\n");
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(b"SECOND\r\n");
        std::fs::create_dir(dir.join("current.next")).unwrap();
        let recovered = recover_quietly(&dir, None);
        assert_eq!(recovered.screen.text(10), ["FIRST", "SECOND"]);
        // Recovery synced the folder first and deleted generation 1, below the one it started from;
        // the failed fold is removed.
        assert_eq!(
            generations(&dir),
            ["2.checkpoint", "2.log", "current", "current.next"]
        );
        std::fs::remove_dir(dir.join("current.next")).unwrap();
        let (mut log, mut screen) = (recovered.log.unwrap(), recovered.screen);
        assert!(log.file.is_none(), "the log starts sealed");
        screen.feed(b"THIRD\r\n");
        let job = log
            .prepare_checkpoint(Checkpoint::capture(&screen))
            .expect("expected a log for the checkpoint");
        assert_eq!(
            job.generation, 3,
            "retry the same checkpoint and log number"
        );
        let cleanup = job.run().unwrap();
        log.finish_checkpoint(Ok(Ok(cleanup)));
        assert_eq!(
            generations(&dir),
            ["2.checkpoint", "2.log", "3.checkpoint", "3.log", "current"],
            "the recovered checkpoint and log remain as the fallback"
        );
        let mut damaged = std::fs::read(checkpoint_path(&dir, 3)).unwrap();
        damaged[30] ^= 1;
        std::fs::write(checkpoint_path(&dir, 3), damaged).unwrap();
        assert_eq!(
            recover_quietly(&dir, None).screen.text(10),
            ["FIRST", "SECOND"]
        );
    }

    /// Puts a folder holding a file where `path` was, so that deleting it fails.
    fn make_undeletable(path: &Path) {
        let _ = std::fs::remove_file(path);
        std::fs::create_dir(path).unwrap();
        std::fs::write(path.join("kept"), b"").unwrap();
    }

    #[test]
    fn a_fold_published_before_its_cleanup_fails_stays_published() {
        let (_folder, dir) = temp_dir("foldcleanup");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"FIRST\r\n");
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(b"SECOND\r\n");
        // Prevent deletion of the oldest log. Cleanup must still delete the other obsolete
        // generations before returning the error.
        make_undeletable(&log_path(&dir, 1));
        let recovered = recover_quietly(&dir, None);
        assert_eq!(recovered.screen.text(10), ["FIRST", "SECOND"]);
        assert!(
            recovered.log.as_ref().is_some_and(|log| log.file.is_some()),
            "the fold is published, so the actor logs into it"
        );
        drop(recovered);
        assert_eq!(
            recover_quietly(&dir, None).screen.text(10),
            ["FIRST", "SECOND"]
        );
    }

    #[test]
    fn a_checkpoint_published_before_its_cleanup_fails_stays_published() {
        let (_folder, dir) = temp_dir("checkpointcleanup");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"FIRST\r\n");
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(b"SECOND\r\n");
        // Generation 1, which the next publication deletes, cannot be deleted.
        make_undeletable(&log_path(&dir, 1));
        // Seal the log with a write error. The next checkpoint follows a gap; treating it as
        // unpublished would discard it.
        recorder.log.file = Some(File::open(log_path(&dir, 2)).unwrap());
        recorder.output(b"not logged\r\n");
        let job = recorder.capture();
        recorder
            .finish(job)
            .expect("the checkpoint is published even though the cleanup after it failed");
        recorder.output(b"THIRD\r\n");
        for recovery in 1..=2 {
            assert_eq!(
                recover_quietly(&dir, None).screen.text(10),
                recorder.screen.text(10),
                "recovery {recovery}"
            );
        }
    }

    #[test]
    fn an_old_file_that_cannot_be_deleted_keeps_no_other_generation() {
        let (_folder, dir) = temp_dir("undeletableoldlog");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"FIRST\r\n");
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        make_undeletable(&log_path(&dir, 1));
        for step in 1..=6 {
            recorder.output(format!("STEP {step}\r\n").as_bytes());
            let job = recorder.capture();
            recorder.finish(job).unwrap();
            // The folder in place of 1.log stays; every generation older than the fallback is
            // deleted.
            let published = recorder.log.published;
            let numbers: Vec<u64> = Generations::scan(&dir)
                .unwrap()
                .numbers
                .into_iter()
                .collect();
            assert_eq!(
                numbers,
                [1, published - 1, published],
                "step {step}: {:?}",
                generations(&dir)
            );
        }
        std::fs::remove_dir_all(log_path(&dir, 1)).unwrap();
        assert_eq!(
            recover_quietly(&dir, None).screen.text(10),
            recorder.screen.text(10)
        );
    }

    #[test]
    fn replaying_a_long_run_of_resizes_reports_progress() {
        let (_folder, dir) = temp_dir("resizeprogress");
        let mut recorder = Recorder::new(&dir, 80, 24);
        let mut logged = 0;
        for rows in [24, 25].into_iter().cycle() {
            recorder.log.append_resize(80, rows);
            logged += resize_record(80, rows).len() as u64;
            if logged > CHECKPOINT_AFTER_BYTES {
                break;
            }
        }
        let reports = std::cell::Cell::new(0);
        recover(&dir, "a1", None, &|| reports.set(reports.get() + 1));
        assert!(
            reports.get() >= 1,
            "no progress over {logged} bytes of resizes"
        );
    }

    #[tokio::test]
    async fn a_writer_that_fails_after_publishing_still_counts_as_published() {
        let (_folder, dir) = temp_dir("writerfails");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"FIRST\r\n");
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        // Seal the log with a write error. The next checkpoint follows a gap; treating it as
        // unpublished would discard it.
        recorder.log.file = Some(File::open(log_path(&dir, 2)).unwrap());
        recorder.output(b"GAP\r\n");
        for step in 1..=6 {
            recorder.output(format!("STEP {step}\r\n").as_bytes());
            let job = recorder.capture();
            // The writer task publishes the checkpoint, then fails before it reports back.
            recorder.log.writer = Some(tokio::task::spawn_blocking(move || {
                job.run().expect("the checkpoint is published");
                panic!("the writer task fails after publishing");
            }));
            let written = recorder.log.checkpoint_written().await;
            assert!(written.is_err(), "{written:?}");
            recorder.log.finish_checkpoint(written);
            let current = published_generation(&dir).unwrap().unwrap();
            assert_eq!(
                recorder.log.published, current,
                "step {step}: the checkpoint `current` names counts as published"
            );
            assert!(
                checkpoint_path(&dir, current).is_file(),
                "step {step}: the published checkpoint was deleted"
            );
            assert!(
                Generations::scan(&dir).unwrap().numbers.len() <= 3,
                "step {step}: {:?}",
                generations(&dir)
            );
        }
        assert_eq!(
            recover_quietly(&dir, None).screen.text(10),
            recorder.screen.text(10)
        );
    }

    /// Reads `left` bytes from `inner`, then fails, to simulate a disk read failure.
    struct FailingAfter {
        inner: File,
        left: usize,
    }

    impl Read for FailingAfter {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.left == 0 {
                return Err(io::Error::other("a disk read failed"));
            }
            let wanted = buffer.len().min(self.left);
            let read = self.inner.read(&mut buffer[..wanted])?;
            self.left -= read;
            Ok(read)
        }
    }

    #[test]
    fn a_recovery_whose_log_fails_inside_a_record_leaves_the_files_to_the_next_one() {
        let (_folder, dir) = temp_dir("readfailure");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"FIRST\r\n");
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        recorder.output(b"SECOND\r\n");
        recorder.output(&vec![0u8; MAX_FEED_BYTES]);
        drop(recorder);
        let files = || {
            generations(&dir)
                .iter()
                .map(|name| (name.clone(), std::fs::read(dir.join(name)).unwrap()))
                .collect::<Vec<_>>()
        };
        let before = files();
        // Generation 2's log fails after its first 8192 bytes, inside the body of its second
        // record.
        let failing = log_path(&dir, 2);
        let recovered = recover_with(&dir, "a1", None, &|| {}, &|path| {
            let file = File::open(path)?;
            Ok(if path == failing {
                Box::new(FailingAfter {
                    inner: file,
                    left: 8192,
                }) as Box<dyn Read>
            } else {
                Box::new(file)
            })
        });
        assert!(
            recovered.screen.text(10).is_empty() && recovered.log.is_none(),
            "a read error is not a damaged record"
        );
        assert_eq!(files(), before);
        assert_eq!(
            recover_quietly(&dir, None).screen.text(10),
            ["FIRST", "SECOND"]
        );
    }

    #[test]
    fn a_record_length_too_large_to_add_to_is_a_bad_record() {
        let (_folder, dir) = temp_dir("hugelength");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"FIRST\r\n");
        let mut log = OpenOptions::new()
            .append(true)
            .open(log_path(&dir, 1))
            .unwrap();
        writeln!(log, "output {}", u64::MAX - 1).unwrap();
        drop((log, recorder));
        assert_eq!(recover_quietly(&dir, None).screen.text(10), ["FIRST"]);
    }

    #[tokio::test]
    async fn a_stalled_checkpoint_writer_stops_reading_only_at_the_cap() {
        let (_folder, dir) = temp_dir("stalled");
        let mut recorder = Recorder::new(&dir, 40, 6);
        let job = recorder.capture();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        recorder.log.writer = Some(tokio::task::spawn(async move {
            let _ = released.await;
            tokio::task::spawn_blocking(move || job.run())
                .await
                .unwrap()
        }));
        let chunk = vec![b'x'; 64 * 1024];
        let mut logged = 0;
        while !recorder.log.backpressured() {
            assert!(logged < MAX_LOG_BYTES, "the cap must stop reading");
            recorder.log.append_output(&chunk);
            logged += chunk.len() as u64;
        }
        assert!(
            logged + MAX_RECORD_BYTES > MAX_LOG_BYTES - 2 * MAX_RECORD_BYTES,
            "reading stops only near the cap, after {logged} bytes"
        );
        assert!(
            !recorder.log.wants_checkpoint() && !recorder.log.must_force_checkpoint(),
            "one checkpoint is pending at a time"
        );
        assert!(
            recorder.log.backpressured(),
            "a full log waits while its checkpoint is being written"
        );
        release.send(()).unwrap();
        let written = recorder.log.checkpoint_written().await;
        recorder.log.finish_checkpoint(written);
        assert!(
            !recorder.log.backpressured() && recorder.log.must_force_checkpoint(),
            "once published, a full log forces the next checkpoint"
        );
    }

    #[test]
    fn screen_files_are_private_to_the_user() {
        let (_folder, dir) = temp_dir("private");
        let mut recorder = Recorder::new(&dir, 40, 6);
        recorder.output(b"secret output\r\n");
        let job = recorder.capture();
        recorder.finish(job).unwrap();
        drop(recover_quietly(&dir, None));
        for folder in [dir.parent().unwrap(), &dir] {
            assert!(
                facade_base::files::is_private(folder).unwrap(),
                "{}",
                folder.display()
            );
        }
        for name in generations(&dir) {
            assert!(
                facade_base::files::is_private(&dir.join(&name)).unwrap(),
                "{name}"
            );
        }
    }
    #[test]
    fn a_forced_checkpoint_names_what_a_recovery_from_it_loses() {
        let lost = |bytes: &[u8]| {
            let mut screen = Screen::new(20, 4, 100);
            screen.feed(bytes);
            forced_checkpoint_losses(&screen)
        };
        assert_eq!(lost(b"\x1b[?1049halt"), ["the hidden main screen"]);
        assert_eq!(
            lost(b"\x1b]0;a long title that never ends"),
            ["the unfinished character or sequence"]
        );
        assert_eq!(
            lost(b"\x1b[?2026hhalf a frame"),
            ["the frame buffered by its open synchronized update"]
        );
        assert_eq!(
            lost(b"\x1b[?1049h\x1b[?2026h\x1b[3"),
            [
                "the hidden main screen",
                "the unfinished character or sequence",
                "the frame buffered by its open synchronized update"
            ]
        );
        assert!(lost(b"plain").is_empty(), "a clean screen loses nothing");
    }
}
