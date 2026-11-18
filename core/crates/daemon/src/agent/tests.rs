// Actor behavior tests carried from the agent unit suite.
use std::path::Path;

use facade_base::daemon::TextWritten;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_screen::TerminalColors;

use super::person::{Enter, PersonKeys};
use super::screen as screen_log;
use super::*;
use std::io;
use std::sync::mpsc as std_mpsc;

use super::typist::TypingAnswer;
use facade_base::daemon::{InputState, ToolsState};
use facade_base::terminal::{PtyMaster, TestCli, test_terminal};

/// A folder for one test's store and screens.
fn home(test: &str) -> crate::test_folder::TestFolder {
    crate::test_folder::TestFolder::new(&format!("actor-{test}"))
}

/// The CLI's side of a test terminal: what it writes goes out at once, and what reaches it is
/// read on a thread of its own, so that a test waits for it for a time. The thread reads only
/// as many bytes as the test asked for, so the rest stays in the terminal, as with a CLI that
/// reads no more.
struct Cli {
    side: TestCli,
    wants: std_mpsc::Sender<usize>,
    input: std_mpsc::Receiver<Vec<u8>>,
    /// Bytes asked of the thread and not yet brought.
    asked: usize,
    kept: Vec<u8>,
}

impl Cli {
    fn new(side: TestCli) -> Cli {
        let mut reader = side.try_clone().unwrap();
        let (wants, asks) = std_mpsc::channel::<usize>();
        let (tx, input) = std_mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            for mut left in asks {
                while left > 0 {
                    let Ok(n @ 1..) = reader.read_input(&mut buffer[..left.min(4096)]) else {
                        return;
                    };
                    left -= n;
                    if tx.send(buffer[..n].to_vec()).is_err() {
                        return;
                    }
                }
            }
        });
        Cli {
            side,
            wants,
            input,
            asked: 0,
            kept: Vec::new(),
        }
    }

    /// Writes all of `bytes` as the CLI's output.
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.side.write_output(bytes)
    }

    /// What reached the CLI within `time`, at most `count` bytes.
    fn reads_within(&mut self, count: usize, time: Duration) -> Vec<u8> {
        let until = std::time::Instant::now() + time;
        let more = count.saturating_sub(self.kept.len() + self.asked);
        if more > 0 && self.wants.send(more).is_ok() {
            self.asked += more;
        }
        while self.kept.len() < count {
            let left = until.saturating_duration_since(std::time::Instant::now());
            match self.input.recv_timeout(left) {
                Ok(bytes) => {
                    self.asked -= bytes.len();
                    self.kept.extend(bytes);
                }
                Err(_) => break,
            }
        }
        let taken = count.min(self.kept.len());
        self.kept.drain(..taken).collect()
    }

    /// Exactly `buf.len()` bytes that reached the CLI, waiting at most five seconds for them.
    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        let read = self.reads_within(buf.len(), Duration::from_secs(5));
        if read.len() < buf.len() {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.copy_from_slice(&read);
        Ok(())
    }

    /// The terminal size the CLI sees.
    fn size(&self) -> (u16, u16) {
        self.side.size()
    }
}

/// An agent's actor on a test terminal whose CLI side the test plays.
struct Harness {
    handle: AgentHandle,
    cli: Cli,
    dir: PathBuf,
    /// The messages the actor delivers from.
    messages: Arc<crate::messages::Messages>,
}

fn record(process: ProcessState, exit: Option<ProcessExit>, cols: u16, rows: u16) -> AgentInfo {
    AgentInfo {
        agent_id: "a1".into(),
        name: "Pixel".into(),
        cli: "sh".into(),
        cwd: "/".into(),
        machine_id: String::new(),
        windows: Vec::new(),
        location_source_window: None,
        window_id: "terminal".into(),
        location_id: facade_base::daemon::location_id("/"),
        pid: Some(1),
        process,
        cols: Some(cols),
        rows: Some(rows),
        created_at: "2026-11-09T17:22:05.123Z".into(),
        creator: None,
        creator_machine_id: None,
        root: "a1".into(),
        root_machine_id: None,
        yolo: true,
        exit,
        session: None,
        state: AgentState::Unknown,
        state_detail: None,
        said: None,
        tools_state: facade_base::daemon::ToolsState::NotInjected,
        tools_reason: None,
        guest: false,
    }
}

impl Harness {
    /// Starts an actor; `screen` builds its screen from the agent folder.
    fn start(home: &Path, info: AgentInfo, screen: impl FnOnce(PathBuf) -> ScreenStart) -> Harness {
        Harness::start_after_output(home, info, b"", screen)
    }

    /// Starts an actor for a CLI that wrote `output` while no daemon read its terminal.
    fn start_after_output(
        home: &Path,
        info: AgentInfo,
        output: &[u8],
        screen: impl FnOnce(PathBuf) -> ScreenStart,
    ) -> Harness {
        Harness::start_by_rule(home, info, output, None, screen)
    }

    /// Starts an actor for an agent started by CLI rule `rule`, whose CLI wrote `output` while
    /// no daemon read its terminal.
    fn start_by_rule(
        home: &Path,
        info: AgentInfo,
        output: &[u8],
        rule: Option<&str>,
        screen: impl FnOnce(PathBuf) -> ScreenStart,
    ) -> Harness {
        Harness::start_kept(
            home,
            info,
            output,
            rule,
            Kept::default(),
            Instant::now(),
            screen,
        )
    }

    /// Starts an actor as [`Harness::start_by_rule`] does, its run's facts `kept`, its run
    /// started at `started`.
    fn start_kept(
        home: &Path,
        info: AgentInfo,
        output: &[u8],
        rule: Option<&str>,
        kept: Kept,
        started: Instant,
        screen: impl FnOnce(PathBuf) -> ScreenStart,
    ) -> Harness {
        let (master, mut cli) = raw_terminal(info.cols.unwrap(), info.rows.unwrap());
        cli.write_all(output).unwrap();
        let dir = home.join("screens").join("a1");
        let (tx, rx) = mpsc::channel(MAX_QUEUED_COMMANDS);
        let state = StateStart {
            file: super::state::state_file(&dir),
            kept,
            started,
        };
        let messages = crate::messages::tests::messages().0;
        let screen = screen(dir.clone());
        let untouched_input = matches!(screen, ScreenStart::New(_));
        let start = ActorStart {
            colors: TerminalColors::default(),
            info,
            master: Some(master),
            screen,
            untouched_input,
            rule: rule.map(str::to_string),
            captures: false,
            deliveries: messages.delivery_handle(),
            state,
        };
        let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
        Harness {
            handle,
            cli,
            dir,
            messages,
        }
    }

    async fn text(&self) -> Vec<String> {
        self.answered_text().await.expect("the actor responds")
    }

    /// The screen's text, or None if the actor does not respond.
    async fn answered_text(&self) -> Option<Vec<String>> {
        let (reply, read) = oneshot::channel();
        self.handle
            .mailbox()
            .send(AgentCommand::ReadScreen { lines: 100, reply })
            .await
            .ok()?;
        Some(
            facade_base::daemon::plain(&read.await.ok()?.text)
                .lines()
                .map(str::to_string)
                .collect(),
        )
    }

    async fn shows(&self, wanted: &str, within: Duration) -> bool {
        let until = Instant::now() + within;
        while Instant::now() < until {
            if self.text().await.iter().any(|line| line.contains(wanted)) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    async fn type_bytes(&self, bytes: &[u8]) -> Result<(), InputRejection> {
        let (reply, taken) = oneshot::channel();
        let run = self.handle.run();
        self.handle
            .mailbox()
            .send(AgentCommand::WriteInput {
                input: Input::Raw(bytes.to_vec()),
                run,
                reply,
            })
            .await
            .unwrap();
        taken.await.unwrap()
    }

    /// Hands the typist a call. Returns its answer once accepted, or the refusal.
    async fn type_call(
        &self,
        (typing, answer): (Typing, TypingAnswer),
    ) -> Result<TypingAnswer, InputRejection> {
        let (reply, taken) = oneshot::channel();
        let run = self.handle.run();
        self.handle
            .mailbox()
            .send(AgentCommand::WriteInput {
                input: Input::Typed(typing),
                run,
                reply,
            })
            .await
            .unwrap();
        taken.await.unwrap().map(|()| answer)
    }

    /// Reads up to `count` bytes that reached the CLI, waiting at most five seconds for them.
    fn cli_reads(&mut self, count: usize) -> Vec<u8> {
        self.cli_reads_within(count, Duration::from_secs(5))
    }

    /// What the CLI reads within `time`, at most `count` bytes.
    fn cli_reads_within(&mut self, count: usize, time: Duration) -> Vec<u8> {
        self.cli.reads_within(count, time)
    }

    /// Writes CLI output that turns on terminal modes, then waits until the actor parsed it.
    async fn cli_sets_modes(&mut self, modes: &[u8]) {
        self.cli.write_all(modes).unwrap();
        self.cli.write_all(b"MODES SET").unwrap();
        assert!(self.shows("MODES SET", Duration::from_secs(5)).await);
    }

    /// The terminal size the CLI sees.
    fn cli_size(&self) -> (u16, u16) {
        self.cli.size()
    }

    /// Recovers a copy of the agent folder. Call only while the actor cannot append records and
    /// the checkpoint writer is paused.
    fn recovered_from_copy(&self) -> (Vec<String>, (u16, u16)) {
        let copy = self.dir.with_file_name("copy");
        let _ = std::fs::remove_dir_all(&copy);
        std::fs::create_dir_all(&copy).unwrap();
        for entry in std::fs::read_dir(&self.dir).unwrap() {
            let entry = entry.unwrap();
            std::fs::copy(entry.path(), copy.join(entry.file_name())).unwrap();
        }
        recovered(&copy)
    }

    /// Stops the actor and waits for its checkpoint writer. Returns the agent folder after all
    /// writes to it have ended.
    async fn stop(self) -> PathBuf {
        let (reply, removed) = oneshot::channel();
        self.handle
            .mailbox()
            .send(AgentCommand::Remove { reply })
            .await
            .unwrap();
        removed.await.unwrap();
        self.dir
    }
}

/// A typing call's answer, failing the test if none comes within five seconds.
async fn answered(answer: TypingAnswer) -> Result<(), ErrorBody> {
    tokio::time::timeout(Duration::from_secs(5), answer)
        .await
        .expect("the call is answered")
        .expect("the typist answers")
}

/// The screen and size recovered from `dir`.
fn recovered(dir: &Path) -> (Vec<String>, (u16, u16)) {
    let recovered = screen_log::recover(dir, "a1", None, &|| {});
    (
        recovered.screen.text(100),
        (recovered.screen.cols(), recovered.screen.rows()),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_log_waiting_for_its_checkpoint_holds_output_and_input_but_answers_commands() {
    let home = home("fulllog");
    let (release, released) = oneshot::channel();
    // The CLI wrote while no daemon read its terminal, and writes more once the actor runs.
    let mut harness = Harness::start_after_output(
        &home,
        record(ProcessState::Running, None, 80, 24),
        b"HELD BACK",
        |dir| {
            let screen = Screen::new(80, 24, SCROLLBACK_ROWS);
            let mut log = ScreenLog::create(dir, "a1", screen_log::Checkpoint::capture(&screen));
            log.begin_stalled_checkpoint(screen_log::Checkpoint::capture(&screen), released);
            log.fill_to_the_cap();
            ScreenStart::Recovered {
                handed_over_cleanly: false,
                screen: Box::new(screen),
                log: Some(log),
            }
        },
    );
    // While the full log waits for its writer, keep only the latest size. This resize also ends
    // the redraw nudge, so the terminal returns to the applied size until the request can take
    // effect.
    harness
        .handle
        .mailbox()
        .send(AgentCommand::Resize(100, 30))
        .await
        .unwrap();
    assert!(
        !harness.shows("HELD BACK", Duration::from_millis(300)).await,
        "a full log waiting for its checkpoint reads no pending output"
    );
    harness.cli.write_all(b" AND MORE").unwrap();
    assert!(
        !harness.shows("AND MORE", Duration::from_millis(300)).await,
        "nor output written after it starts"
    );
    harness
        .handle
        .mailbox()
        .send(AgentCommand::Resize(90, 28))
        .await
        .unwrap();
    let refused = harness.type_bytes(b"after the resize").await;
    assert!(
        matches!(
            &refused,
            Err(InputRejection::Backpressured(Input::Raw(back))) if back == b"after the resize"
        ),
        "input waits for the size: {refused:?}"
    );
    let answered = Instant::now();
    assert!(
        harness.text().await.is_empty() && answered.elapsed() < Duration::from_millis(200),
        "the actor still responds to commands"
    );
    assert_eq!(
        (harness.handle.info().cols, harness.cli_size()),
        (Some(80), (80, 24))
    );
    // The full log takes no record and the checkpoint writer is held, so nothing writes the
    // folder while it is copied.
    assert_eq!(
        harness.recovered_from_copy().1,
        (80, 24),
        "a crash before application recovers the last logged size"
    );
    release.send(()).unwrap();
    assert!(
        harness
            .shows("HELD BACK AND MORE", Duration::from_secs(5))
            .await,
        "reading resumes when the checkpoint writer finishes"
    );
    assert_eq!(
        (harness.handle.info().cols, harness.cli_size()),
        (Some(90), (90, 28)),
        "the latest size is applied"
    );
    harness.type_bytes(b"typed").await.unwrap();
    let mut typed = [0u8; 5];
    harness.cli.read_exact(&mut typed).unwrap();
    assert_eq!(&typed, b"typed");
    assert_eq!(recovered(&harness.stop().await).1, (90, 28));
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ended_run_whose_terminal_stays_open_tells_viewers_its_exit_after_the_drain_timeout() {
    let home = home("drain");
    let exit = ProcessExit {
        code: Some(3),
        signal: None,
        reason: None,
        at: "2026-11-09T17:25:40.017Z".into(),
    };
    // The test holds the CLI side open, as a process the CLI left behind would.
    let harness = Harness::start(
        &home,
        record(ProcessState::Ended, Some(exit.clone()), 80, 24),
        |_| ScreenStart::Recovered {
            handed_over_cleanly: false,
            screen: Box::new(Screen::new(80, 24, SCROLLBACK_ROWS)),
            log: None,
        },
    );
    let (tx, mut changes) = viewer_channel();
    let (reply, snapshot) = oneshot::channel();
    let added = Instant::now();
    harness
        .handle
        .mailbox()
        .send(AgentCommand::AddViewer {
            viewer: 1,
            tx,
            keep_scrollback: false,
            include_scrollback: true,
            reply,
        })
        .await
        .unwrap();
    assert_eq!(
        snapshot.await.unwrap().exit,
        None,
        "the exit follows the drain"
    );
    let told = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ViewerChange::Exit(told)) = changes.recv().await {
                return told;
            }
        }
    })
    .await
    .expect("the viewer is told the exit");
    assert_eq!(told, exit);
    assert!(
        added.elapsed() < Duration::from_millis(1000),
        "told after {:?}",
        added.elapsed()
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_synchronized_update_the_actor_ends_after_its_timeout_is_in_the_log() {
    let home = home("syncend");
    let mut harness = Harness::start(
        &home,
        record(ProcessState::Running, None, 80, 6),
        ScreenStart::New,
    );
    harness.cli.write_all(b"\x1b[?2026h\x1b[1;70HMARK").unwrap();
    // The mark shows only once the actor ends the update after its timeout.
    assert!(harness.shows("MARK", Duration::from_secs(5)).await);
    harness
        .handle
        .mailbox()
        .send(AgentCommand::Resize(40, 6))
        .await
        .unwrap();
    harness.cli.write_all(b"\x1b[?2026l tail").unwrap();
    assert!(harness.shows("tail", Duration::from_secs(5)).await);
    let shown = harness.text().await;
    assert_eq!(recovered(&harness.stop().await), (shown, (40, 6)));
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn resizes_alone_keep_the_log_within_its_cap() {
    let home = home("resizecap");
    let harness = Harness::start(&home, record(ProcessState::Running, None, 80, 24), |dir| {
        let screen = Screen::new(80, 24, SCROLLBACK_ROWS);
        let mut log = ScreenLog::create(dir, "a1", screen_log::Checkpoint::capture(&screen));
        log.fill_to_the_cap();
        ScreenStart::Recovered {
            handed_over_cleanly: false,
            screen: Box::new(screen),
            log: Some(log),
        }
    });
    for size in 0..40u16 {
        harness
            .handle
            .mailbox()
            .send(AgentCommand::Resize(80 + size % 2, 24))
            .await
            .unwrap();
    }
    harness
        .handle
        .mailbox()
        .send(AgentCommand::Resize(70, 20))
        .await
        .unwrap();
    // The full log got a checkpoint before the first resize record; the records went on in the
    // next generation.
    let dir = harness.stop().await;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        assert!(
            std::fs::metadata(&path).unwrap().len() <= screen_log::MAX_LOG_BYTES,
            "{}",
            path.display()
        );
    }
    assert_eq!(recovered(&dir).1, (70, 20), "every resize is logged");
    std::fs::remove_dir_all(&home).unwrap();
}

/// The person's pastes since their last Enter go with it, the earliest first, up to the input
/// limit in all: the earliest make room. The next Enter starts with none.
#[test]
fn the_pastes_before_an_enter_go_with_it_within_the_input_limit() {
    let pasted = |text: &[u8]| [PASTE_START, text, PASTE_END].concat();
    let mut keys = PersonKeys::default();
    assert_eq!(
        keys.enter(&[pasted(b"one\rtwo"), b" and ".to_vec(), pasted(b"three")].concat()),
        None
    );
    let Enter { at, pastes } = keys.enter(b"!\r").expect("an Enter");
    assert_eq!(
        (at, pastes),
        (1, vec!["one\rtwo".to_string(), "three".to_string()])
    );
    // Four bytes and the longest paste but three come to one byte over the limit.
    let long = vec![b'x'; MAX_INPUT_BYTES - 3];
    let keys_with_long = [pasted(b"four"), pasted(&long), b"\r".to_vec()].concat();
    let Enter { pastes, .. } = keys.enter(&keys_with_long).expect("an Enter");
    let sizes: Vec<usize> = pastes.iter().map(String::len).collect();
    assert_eq!(
        sizes,
        [MAX_INPUT_BYTES - 3],
        "the earliest paste makes room"
    );
    assert_eq!(
        keys.enter(b"\r"),
        Some(Enter {
            at: 0,
            pastes: Vec::new()
        }),
        "the next Enter starts with none"
    );
}

/// Text goes in as a terminal pastes it in the CLI's modes, its Enter after a pause; keys go in
/// the CLI's cursor mode, and the key after an Escape after a pause. Each call is answered once
/// all of it reached the terminal.
#[tokio::test(flavor = "multi_thread")]
async fn text_and_keys_reach_the_cli_as_a_terminal_sends_them_in_its_modes() {
    let home = home("typing");
    let mut harness = Harness::start(
        &home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    let accepted = Instant::now();
    let answer = harness
        .type_call(Typing::text("one\ntwo".into(), true, Sender::person()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        harness.cli_reads(8),
        b"one\ntwo\r",
        "without bracketed paste, the text goes as given, then its Enter"
    );
    assert_eq!(answered(answer).await, Ok(()));
    assert!(
        accepted.elapsed() >= Duration::from_millis(100),
        "the Enter waited after the text: {:?}",
        accepted.elapsed()
    );
    let answer = harness
        .type_call(Typing::keys(&["Up".into(), "Home".into()]).unwrap())
        .await
        .unwrap();
    assert_eq!(harness.cli_reads(6), b"\x1b[A\x1b[H");
    assert_eq!(answered(answer).await, Ok(()));

    harness.cli_sets_modes(b"\x1b[?2004h\x1b[?1h").await;
    let answer = harness
        .type_call(Typing::text("one\r\ntwo".into(), true, Sender::person()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        harness.cli_reads(20),
        b"\x1b[200~one\rtwo\x1b[201~\r",
        "bracketed, with each line break as a carriage return"
    );
    assert_eq!(answered(answer).await, Ok(()));
    let accepted = Instant::now();
    let answer = harness
        .type_call(Typing::keys(&["Esc".into(), "Up".into(), "PageUp".into()]).unwrap())
        .await
        .unwrap();
    assert_eq!(
        harness.cli_reads(1 + 3 + 4),
        b"\x1b\x1bOA\x1b[5~",
        "application cursor keys"
    );
    assert_eq!(answered(answer).await, Ok(()));
    assert!(
        accepted.elapsed() >= Duration::from_millis(50),
        "the key after the Escape waited: {:?}",
        accepted.elapsed()
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// An Enter typed into the agent asks its CLI to do something, also a CLI without a rule, whose
/// input Facade cannot read: the person's, though not one in a paste or after Escape, and a
/// call's. Other keys and text without Enter ask nothing.
#[tokio::test(flavor = "multi_thread")]
async fn an_enter_typed_into_the_agent_asks_its_cli_to_do_something() {
    let asked = |dir: &Path| {
        let kept = std::fs::read(super::state::state_file(dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        kept.is_some_and(|kept| kept["counts_turns"] == true)
    };
    let asked_within = |dir: &Path| {
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while !asked(dir) && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        asked(dir)
    };
    let person_home = home("asked-person");
    let mut person = Harness::start(
        &person_home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    let keys: &[u8] = b"\x1b[200~one\rtwo\x1b[201~\x1b\rkeys";
    person.type_bytes(keys).await.unwrap();
    assert_eq!(person.cli_reads(keys.len()), keys);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !asked(&person.dir),
        "a paste, Alt+Enter and keys ask nothing"
    );
    person.type_bytes(b"\r").await.unwrap();
    assert_eq!(person.cli_reads(1), b"\r");
    assert!(asked_within(&person.dir), "the person's Enter asks");
    person.stop().await;
    std::fs::remove_dir_all(&person_home).unwrap();

    let call_home = home("asked-call");
    let mut call = Harness::start(
        &call_home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    let answer = call
        .type_call(Typing::text("half".into(), false, Sender::person()).unwrap())
        .await
        .unwrap();
    assert_eq!(call.cli_reads(4), b"half");
    assert_eq!(answered(answer).await, Ok(()));
    let answer = call
        .type_call(Typing::keys(&["Up".into()]).unwrap())
        .await
        .unwrap();
    assert_eq!(call.cli_reads(3), b"\x1b[A");
    assert_eq!(answered(answer).await, Ok(()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!asked(&call.dir), "text without Enter and keys ask nothing");
    let answer = call
        .type_call(Typing::keys(&["Enter".into()]).unwrap())
        .await
        .unwrap();
    assert_eq!(call.cli_reads(1), b"\r");
    assert_eq!(answered(answer).await, Ok(()));
    assert!(asked_within(&call.dir), "a call's Enter asks, alone too");
    call.stop().await;
    std::fs::remove_dir_all(&call_home).unwrap();
}

/// Text and keys waiting in the typist count toward the agent's waiting input. When the agent
/// ends, the call being typed says what of it was typed, and a waiting call that nothing of it
/// was.
#[tokio::test(flavor = "multi_thread")]
async fn calls_cut_off_by_the_agent_s_end_say_what_was_typed() {
    let home = home("typingend");
    let mut harness = Harness::start(
        &home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    // The CLI reads only the paste's first bytes. The terminal takes at most tens of KiB more,
    // so most of the paste stays queued, and the next call waits in the typist.
    let typing = harness
        .type_call(Typing::text("x".repeat(500 * 1024), true, Sender::person()).unwrap())
        .await
        .unwrap();
    let waiting = harness
        .type_call(Typing::text("w".repeat(400 * 1024), false, Sender::person()).unwrap())
        .await
        .unwrap();
    assert_eq!(harness.cli_reads(6), b"xxxxxx");
    let refused = harness.type_bytes(&[b'r'; 300 * 1024]).await;
    assert!(
        matches!(&refused, Err(InputRejection::Backpressured(Input::Raw(_)))),
        "the queued paste and the waiting call leave no room: {refused:?}"
    );
    let refused = harness
        .type_call(Typing::text("y".repeat(300 * 1024), false, Sender::person()).unwrap())
        .await
        .err();
    assert!(
        matches!(
            &refused,
            Some(InputRejection::Backpressured(Input::Typed(_)))
        ),
        "{refused:?}"
    );
    let exit = ProcessExit {
        code: Some(0),
        signal: None,
        reason: None,
        at: "2026-11-10T00:00:00.000Z".into(),
    };
    harness
        .handle
        .mailbox()
        .send(AgentCommand::ProcessExited {
            run: FIRST_RUN,
            exit,
            stopped: false,
        })
        .await
        .unwrap();
    let cut_off = answered(typing).await.unwrap_err();
    assert_eq!(
        (cut_off.data.reason, cut_off.message.as_str()),
        (
            Reason::PartialInput,
            "#a1 ended; part of the text was typed"
        )
    );
    assert_eq!(
        (cut_off.data.text_written, cut_off.data.enter_written),
        (Some(TextWritten::Partial), Some(false))
    );
    let waited = answered(waiting).await.unwrap_err();
    assert_eq!(
        (waited.data.reason, waited.message.as_str()),
        (Reason::Ended, "#a1 ended; nothing was typed")
    );
    let refused = harness
        .type_call(Typing::keys(&["z".into()]).unwrap())
        .await
        .err();
    assert!(
        matches!(refused, Some(InputRejection::AgentExited)),
        "{refused:?}"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A test terminal whose CLI side the test plays, as a resumed run's terminal.
fn raw_terminal(cols: u16, rows: u16) -> (PtyMaster, Cli) {
    let (master, cli) = test_terminal(cols, rows).unwrap();
    (master, Cli::new(cli))
}

fn exit_with(code: i32) -> ProcessExit {
    ProcessExit {
        code: Some(code),
        signal: None,
        reason: None,
        at: "2026-11-10T00:00:00.000Z".into(),
    }
}

impl Harness {
    async fn send(&self, command: AgentCommand) {
        self.handle.mailbox().send(command).await.unwrap();
    }

    /// Ends run `run` and waits until viewers were told.
    async fn end_run(&self, run: u64, code: i32) {
        self.send(AgentCommand::ProcessExited {
            run,
            exit: exit_with(code),
            stopped: false,
        })
        .await;
        let mut settled = self.handle.settled();
        tokio::time::timeout(Duration::from_secs(5), settled.wait_for(|settled| *settled))
            .await
            .unwrap()
            .unwrap();
    }

    async fn prepare_restart(&self, run: u64, cols: u16, rows: u16) {
        let (reply, prepared) = oneshot::channel();
        self.send(AgentCommand::PrepareRestart {
            run,
            cols,
            rows,
            reply,
        })
        .await;
        prepared.await.unwrap();
    }

    async fn install(&self, run: u64, master: PtyMaster) -> AgentInfo {
        self.install_given(run, master, ToolsGiven::NotInjected)
            .await
    }

    /// Installs run `run` on `master`, its CLI given Facade's tools as `tools` says.
    async fn install_given(&self, run: u64, master: PtyMaster, tools: ToolsGiven) -> AgentInfo {
        let (reply, installed) = oneshot::channel();
        self.send(AgentCommand::InstallRun {
            run,
            master,
            pid: 4242,
            captures: false,
            version: None,
            tools,
            reply,
        })
        .await;
        installed.await.unwrap()
    }

    async fn type_for(&self, run: u64, bytes: &[u8]) -> Result<(), InputRejection> {
        let (reply, taken) = oneshot::channel();
        self.send(AgentCommand::WriteInput {
            input: Input::Raw(bytes.to_vec()),
            run,
            reply,
        })
        .await;
        taken.await.unwrap()
    }

    async fn round_trip(&self) {
        let (reply, answered) = oneshot::channel();
        self.send(AgentCommand::Inspect { reply }).await;
        answered.await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recovered_agent_s_input_reads_unknown_until_its_cli_writes() {
    let home = home("undrawn");
    let mut harness = Harness::start_by_rule(
        &home,
        record(ProcessState::Running, None, 40, 6),
        "❯ \r\n".as_bytes(),
        Some("fake"),
        |_| ScreenStart::Recovered {
            handed_over_cleanly: false,
            screen: Box::new(Screen::new(40, 6, SCROLLBACK_ROWS)),
            log: None,
        },
    );
    let inspect = |harness: &Harness| {
        let commands = harness.handle.mailbox();
        async move {
            let (reply, inspected) = oneshot::channel();
            commands
                .send(AgentCommand::Inspect { reply })
                .await
                .unwrap();
            inspected.await.unwrap().input
        }
    };
    // The output written while no daemon read the terminal is on the screen, but is not live.
    assert!(harness.shows("❯", Duration::from_secs(5)).await);
    tokio::time::sleep(REDRAW_NUDGE_TIMEOUT * 2).await;
    let read = inspect(&harness).await;
    assert_eq!(
        (read.state, read.evidence.as_str()),
        (
            InputState::Unknown,
            "the CLI has not written since Facade recovered it"
        ),
        "a timer alone does not count"
    );
    harness.cli.write_all("\x1b[H\x1b[2J❯ ".as_bytes()).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while inspect(&harness).await.state != InputState::Usable && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        inspect(&harness).await.state,
        InputState::Usable,
        "the CLI's own output makes the screen live"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Reports a recovered CLI wrote while no daemon read its terminal count as it is taken back.
#[tokio::test(flavor = "multi_thread")]
async fn a_recovered_agent_takes_the_reports_its_cli_wrote_while_no_daemon_read_them() {
    let home = home("pendingreports");
    let reported = b"\x1b]7501;state=blocked:kind=question\x07";
    let harness = Harness::start_after_output(
        &home,
        record(ProcessState::Running, None, 40, 6),
        reported,
        |_| ScreenStart::Recovered {
            handed_over_cleanly: false,
            screen: Box::new(Screen::new(40, 6, SCROLLBACK_ROWS)),
            log: None,
        },
    );
    let state = || harness.handle.info().state;
    let until = Instant::now() + Duration::from_secs(5);
    while state() != AgentState::WaitingForYou && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state(), AgentState::WaitingForYou);
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn input_and_exits_meant_for_an_ended_run_never_reach_the_run_that_resumes_it() {
    let home = home("runbinding");
    let harness = Harness::start(
        &home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    harness.end_run(FIRST_RUN, 1).await;
    harness.prepare_restart(2, 80, 24).await;
    assert_eq!(
        harness.handle.run(),
        2,
        "input admitted from now on is for the new run"
    );
    let (run, installed) = harness.handle.installed_record();
    assert_eq!(
        (run, installed.process, installed.exit),
        (FIRST_RUN, ProcessState::Ended, Some(exit_with(1)))
    );
    assert!(
        matches!(
            harness.type_for(2, b"early").await,
            Err(InputRejection::AgentExited)
        ),
        "the agent stays ended until its terminal is installed"
    );
    let (master, mut cli) = raw_terminal(80, 24);
    let installed = harness.install(2, master).await;
    assert_eq!(
        (installed.pid, installed.process, installed.exit.as_ref()),
        (Some(4242), ProcessState::Running, None)
    );
    assert_eq!(harness.handle.installed_record(), (2, installed));
    assert!(
        matches!(
            harness.type_for(FIRST_RUN, b"OLD").await,
            Err(InputRejection::AgentExited)
        ),
        "input admitted for the ended run is refused"
    );
    harness.type_for(2, b"NEW").await.unwrap();
    let mut typed = [0u8; 3];
    cli.read_exact(&mut typed).unwrap();
    assert_eq!(&typed, b"NEW");
    harness
        .send(AgentCommand::ProcessExited {
            run: FIRST_RUN,
            exit: exit_with(7),
            stopped: false,
        })
        .await;
    harness.round_trip().await;
    assert_eq!(
        harness.handle.info().process,
        ProcessState::Running,
        "a late exit of the ended run is ignored"
    );
    harness.end_run(2, 3).await;
    assert_eq!(harness.handle.info().exit, Some(exit_with(3)));
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_ends_before_its_terminal_is_installed_ends_the_agent_once_it_is() {
    let home = home("earlyexit");
    let harness = Harness::start(
        &home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    harness.end_run(FIRST_RUN, 1).await;
    harness.prepare_restart(2, 80, 24).await;
    harness
        .send(AgentCommand::ProcessExited {
            run: 2,
            exit: exit_with(9),
            stopped: false,
        })
        .await;
    harness.round_trip().await;
    assert_eq!(
        harness.handle.info().exit,
        Some(exit_with(1)),
        "the earlier exit stands until the new run is installed"
    );
    // The CLI's side closes at once.
    let master = test_terminal(80, 24).unwrap().0;
    harness.install(2, master).await;
    let mut exit = harness.handle.exit();
    let ended = tokio::time::timeout(
        Duration::from_secs(5),
        exit.wait_for(|exit| exit.as_ref().is_some_and(|exit| exit.code == Some(9))),
    )
    .await;
    assert!(ended.is_ok(), "the new run's exit is recorded");
    let (run, record) = harness.handle.installed_record();
    assert_eq!(
        (run, record.process, record.exit),
        (2, ProcessState::Ended, Some(exit_with(9)))
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resumed_run_starts_at_the_caller_s_size_and_a_crash_recovers_it_at_that_size() {
    let home = home("restartsize");
    let mut harness = Harness::start(
        &home,
        record(ProcessState::Running, None, 10, 6),
        ScreenStart::New,
    );
    harness.cli.write_all(b"\x1b[?1049h\x1b[?2004hold").unwrap();
    assert!(harness.shows("old", Duration::from_secs(5)).await);
    harness.end_run(FIRST_RUN, 0).await;
    harness.prepare_restart(2, 20, 6).await;
    let (master, mut cli) = raw_terminal(10, 6);
    harness.install(2, master).await;
    assert_eq!(
        cli.size(),
        (20, 6),
        "the new run's terminal has the caller's size"
    );
    cli.write_all(b"\x1b[1;17HX").unwrap();
    assert!(harness.shows("X", Duration::from_secs(5)).await);
    let live = harness.text().await;
    assert!(
        live.iter()
            .any(|line| line == &format!("{}X", " ".repeat(16))),
        "{live:?}"
    );
    assert!(
        !live.iter().any(|line| line.contains("old")),
        "the ended run's alternate screen is left"
    );
    let (recovered, size) = harness.recovered_from_copy();
    assert_eq!(
        (recovered, size),
        (live, (20, 6)),
        "the log recovers the reset, the size, and the new run's output"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn viewers_get_the_ended_run_before_the_next_and_one_that_never_reads_is_dropped() {
    let home = home("restartviewers");
    // The ended run's last screen is redrawn in more bytes than any read of output takes, so a
    // viewer that fell behind holds more than its budget once it has the ended run's end,
    // whatever sizes the terminal's reads had.
    let (cols, rows) = (300, 240);
    let mut harness = Harness::start(
        &home,
        record(ProcessState::Running, None, cols, rows),
        ScreenStart::New,
    );
    let add = |viewer: u64| {
        let (tx, rx) = viewer_channel();
        let (reply, snapshot) = oneshot::channel();
        (
            AgentCommand::AddViewer {
                viewer,
                tx,
                keep_scrollback: false,
                include_scrollback: false,
                reply,
            },
            rx,
            snapshot,
        )
    };
    let (command, mut reader, snapshot) = add(1);
    harness.send(command).await;
    snapshot.await.unwrap();
    let (command, mut never, snapshot) = add(2);
    harness.send(command).await;
    snapshot.await.unwrap();
    // Both viewers fall behind.
    let flood = vec![b'x'; 3 * VIEWER_BUDGET];
    harness.cli.write_all(&flood).unwrap();
    harness.cli.write_all(b"\r\nLAST LINE").unwrap();
    assert!(harness.shows("LAST LINE", Duration::from_secs(10)).await);
    harness.end_run(FIRST_RUN, 5).await;
    harness.prepare_restart(2, 80, 24).await;
    // What the viewer reads, each redraw with its size. Reading makes room, so the next run's
    // screen can come while it reads.
    let mut kinds = Vec::new();
    let (mut redrawn, mut last_redraw) = (Vec::new(), Vec::new());
    while let Ok(Some(change)) =
        tokio::time::timeout(Duration::from_millis(100), reader.recv()).await
    {
        match change {
            ViewerChange::Redraw { bytes, cols, rows } => {
                kinds.push(format!("redraw {cols}x{rows}"));
                redrawn = bytes;
            }
            ViewerChange::Output(_) => kinds.push("output".to_string()),
            ViewerChange::Exit(exit) => {
                assert_eq!(exit, exit_with(5));
                kinds.push("exit".to_string());
                last_redraw = std::mem::take(&mut redrawn);
            }
            ViewerChange::Removed => kinds.push("removed".to_string()),
        }
    }
    let exit = kinds
        .iter()
        .position(|kind| kind == "exit")
        .unwrap_or_else(|| panic!("the ended run's exit: {kinds:?}"));
    let ended = [format!("redraw {cols}x{rows}"), "exit".to_string()];
    assert_eq!(
        kinds[exit.saturating_sub(1)..=exit],
        ended,
        "the ended run's last screen and exit come before anything of the next run: {kinds:?}"
    );
    assert!(
        kinds[exit + 1..].iter().all(|kind| kind == "redraw 80x24"),
        "only the next run's screen follows: {kinds:?}"
    );
    assert!(
        last_redraw.len() > terminal::MAX_READ_BYTES,
        "the last screen takes more bytes than a read"
    );
    assert!(String::from_utf8_lossy(&last_redraw).contains("LAST LINE"));
    // The CLI's side closes at once.
    let master = test_terminal(80, 24).unwrap().0;
    harness.install(2, master).await;
    harness.end_run(2, 6).await;
    // The viewer that never read still holds the first run's end beyond its budget: it is
    // dropped, not grown.
    let stalled = never.stalled();
    harness.prepare_restart(3, 80, 24).await;
    tokio::time::timeout(Duration::from_secs(5), stalled)
        .await
        .expect("the stalled viewer's client is disconnected");
    let mut stalled_bytes = 0;
    while let Ok(Some(change)) =
        tokio::time::timeout(Duration::from_millis(100), never.recv()).await
    {
        stalled_bytes += viewer_bytes(&change);
    }
    assert!(stalled_bytes <= VIEWER_BUDGET + last_redraw.len());
    // The viewer that read stays. Where it had read all of the second run before that run
    // ended, the run's exit came to it at once, before the third run's screen.
    assert!(
        tokio::time::timeout(Duration::from_millis(20), reader.stalled())
            .await
            .is_err(),
        "the viewer that read stays"
    );
    let next = tokio::time::timeout(Duration::from_secs(5), reader.recv()).await;
    let changes = matches!(
        next,
        Ok(Some(
            ViewerChange::Redraw { .. } | ViewerChange::Output(_) | ViewerChange::Exit(_)
        ))
    );
    assert!(
        changes,
        "the viewer that read gets the runs' changes: {next:?}"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A viewer that is behind receives a redraw once it has room, even without further output.
/// Any missed exit follows the redraw.
#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_behind_gets_a_redraw_before_the_exit() {
    let home = home("viewerbehind");
    let mut harness = Harness::start(
        &home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    let (tx, mut feed) = viewer_channel();
    let (reply, snapshot) = oneshot::channel();
    harness
        .send(AgentCommand::AddViewer {
            viewer: 1,
            tx,
            keep_scrollback: false,
            include_scrollback: false,
            reply,
        })
        .await;
    snapshot.await.unwrap();
    harness
        .cli
        .write_all(&vec![b'x'; 3 * VIEWER_BUDGET])
        .unwrap();
    harness.cli.write_all(b"\r\nLAST LINE").unwrap();
    assert!(harness.shows("LAST LINE", Duration::from_secs(10)).await);
    harness.end_run(FIRST_RUN, 0).await;
    let mut incremental = 0;
    let mut redrawn = false;
    loop {
        let change = tokio::time::timeout(Duration::from_secs(5), feed.recv())
            .await
            .unwrap()
            .unwrap();
        match change {
            ViewerChange::Output(bytes) => incremental += bytes.len(),
            ViewerChange::Redraw { bytes, .. } => {
                assert!(String::from_utf8_lossy(&bytes).contains("LAST LINE"));
                redrawn = true;
            }
            ViewerChange::Exit(exit) => {
                assert!(redrawn, "the redraw precedes the missed exit");
                assert_eq!(exit, exit_with(0));
                break;
            }
            ViewerChange::Removed => panic!("the viewer stays connected"),
        }
    }
    assert!(
        incremental > 0 && incremental <= VIEWER_BUDGET,
        "incremental output stays within the viewer budget"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), feed.recv())
            .await
            .is_err(),
        "no further changes are expected"
    );
    harness.stop().await;
}

/// A Facade server that connects before its agent's actor first runs still counts: the actor
/// follows its connections from the moment the agent can be found.
#[tokio::test]
async fn a_server_that_connects_before_the_actor_first_runs_makes_the_tools_available() {
    let home = home("toolsearly");
    // The CLI's side stays open until the test ends.
    let (master, _cli) = test_terminal(80, 24).unwrap();
    let dir = home.join("screens").join("a1");
    let (tx, rx) = mpsc::channel(MAX_QUEUED_COMMANDS);
    let state = StateStart {
        file: super::state::state_file(&dir),
        kept: Kept::new_run(None, ToolsGiven::Injected),
        started: Instant::now(),
    };
    let start = ActorStart {
        colors: TerminalColors::default(),
        info: record(ProcessState::Running, None, 80, 24),
        master: Some(master),
        screen: ScreenStart::New(dir),
        untouched_input: false,
        rule: None,
        captures: false,
        deliveries: crate::messages::tests::messages().0.delivery_handle(),
        state,
    };
    let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
    // This runtime runs one task at a time: the actor has not run yet when the server connects.
    let _connection = handle.tools_connected();
    let tools = || handle.info().tools_state;
    let until = Instant::now() + Duration::from_secs(5);
    while tools() != facade_base::daemon::ToolsState::Available && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(tools(), facade_base::daemon::ToolsState::Available);
    let (reply, removed) = oneshot::channel();
    handle
        .mailbox()
        .send(AgentCommand::Remove { reply })
        .await
        .unwrap();
    removed.await.unwrap();
    std::fs::remove_dir_all(&home).unwrap();
}
/// A run's start prompt waits for its start to settle, the CLI's tools connected, and a message
/// sent meanwhile waits behind it as behind a draft. Once the prompt comes, it goes first, then
/// the message.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_prompt_waits_for_the_tools_and_messages_sent_meanwhile_wait_behind_it() {
    let home = home("startprompt");
    let (master, mut cli) = raw_terminal(40, 6);
    // The test CLI's empty input, with bracketed paste on.
    cli.write_all("\x1b[?2004h❯ ".as_bytes()).unwrap();
    let dir = home.join("screens").join("a1");
    let (tx, rx) = mpsc::channel(MAX_QUEUED_COMMANDS);
    let state = StateStart {
        file: super::state::state_file(&dir),
        kept: Kept::new_run(None, ToolsGiven::Injected),
        started: Instant::now(),
    };
    let post = crate::messages::tests::messages().0;
    let start = ActorStart {
        colors: TerminalColors::default(),
        info: record(ProcessState::Running, None, 40, 6),
        master: Some(master),
        screen: ScreenStart::New(dir),
        untouched_input: false,
        rule: Some("fake".into()),
        captures: false,
        deliveries: post.delivery_handle(),
        state,
    };
    let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
    let (ready, mut settled) = oneshot::channel();
    handle
        .mailbox()
        .send(AgentCommand::AwaitPrompt { ready })
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    // A message kept in the message store, for the actor to deliver as `text`.
    let kept = |text: &str, prompt: bool| {
        let number = crate::messages::number(
            &crate::messages::tests::post_new(&post, crate::messages::tests::message(0, "a1")).0,
        );
        let said = Submission {
            text: text.into(),
            sender: Sender::person(),
        };
        let typing = if prompt {
            MessageTyping::start_prompt
        } else {
            MessageTyping::new
        };
        (typing(text.into(), number, deadline, said), number)
    };
    let status = |number: u64| {
        post.message(&format!("m{number}"))
            .expect("a kept message")
            .delivery
            .status
    };
    let (message, message_number) = kept("a message", false);
    let (reply, taken) = oneshot::channel();
    handle
        .mailbox()
        .send(AgentCommand::WriteInput {
            input: Input::Message(message),
            run: FIRST_RUN,
            reply,
        })
        .await
        .unwrap();
    assert!(taken.await.unwrap().is_ok());
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        settled.try_recv(),
        Err(oneshot::error::TryRecvError::Empty),
        "the start settles once its tools connected"
    );
    let mut harness = Harness {
        handle,
        cli,
        dir: home.join("screens").join("a1"),
        messages: post.clone(),
    };
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty(),
        "the message waits behind the prompt to come"
    );
    let _connection = harness.handle.tools_connected();
    tokio::time::timeout(Duration::from_secs(5), &mut settled)
        .await
        .unwrap()
        .unwrap();
    let (prompt, prompt_number) = kept("fix it", true);
    harness
        .send(AgentCommand::StartPrompt {
            run: FIRST_RUN,
            prompt: Some(prompt),
        })
        .await;
    let paste = b"\x1b[200~fix it\x1b[201~";
    assert_eq!(
        harness.cli_reads(paste.len()),
        paste,
        "the prompt goes first"
    );
    harness
        .cli
        .write_all("\r\x1b[K❯ fix it".as_bytes())
        .unwrap();
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.cli.write_all("\r\x1b[K❯ ".as_bytes()).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while status(prompt_number) == facade_base::daemon::DeliveryStatus::Pending
        && Instant::now() < until
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        status(prompt_number),
        facade_base::daemon::DeliveryStatus::Success
    );
    let paste = b"\x1b[200~a message\x1b[201~";
    assert_eq!(harness.cli_reads(paste.len()), paste, "then the message");
    assert_eq!(
        status(message_number),
        facade_base::daemon::DeliveryStatus::Pending
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A daemon that recovers a run its Facade server connected to long ago waits the start's bound
/// from the recovery for the server to connect to it.
#[tokio::test]
async fn a_recovered_run_waits_for_its_server_from_the_recovery() {
    let home = home("toolsrecovered");
    // The CLI's side stays open until the test ends.
    let (master, _cli) = test_terminal(80, 24).unwrap();
    let dir = home.join("screens").join("a1");
    let (tx, rx) = mpsc::channel(MAX_QUEUED_COMMANDS);
    let long_ago = Instant::now()
        .checked_sub(START_TIMEOUT * 2)
        .expect("a clock that has run two minutes");
    let state = StateStart {
        file: super::state::state_file(&dir),
        kept: Kept::new_run(None, ToolsGiven::Injected),
        started: long_ago,
    };
    let screen = ScreenStart::Recovered {
        handed_over_cleanly: false,
        screen: Box::new(Screen::new(80, 24, SCROLLBACK_ROWS)),
        log: None,
    };
    let messages = crate::messages::tests::messages().0;
    let start = ActorStart {
        colors: TerminalColors::default(),
        info: record(ProcessState::Running, None, 80, 24),
        master: Some(master),
        screen,
        untouched_input: false,
        rule: None,
        captures: false,
        deliveries: messages.delivery_handle(),
        state,
    };
    let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
    assert_eq!(
        handle.info().tools_state,
        facade_base::daemon::ToolsState::Connecting
    );
    let (reply, removed) = oneshot::channel();
    handle
        .mailbox()
        .send(AgentCommand::Remove { reply })
        .await
        .unwrap();
    removed.await.unwrap();
    std::fs::remove_dir_all(&home).unwrap();
}
/// An Antigravity run given Facade's tools, at 80 by 24, whose CLI has drawn nothing yet.
fn antigravity(home: &Path) -> Harness {
    antigravity_started(home, Instant::now())
}

/// An Antigravity run as [`antigravity`] starts one, its run started at `started`.
fn antigravity_started(home: &Path, started: Instant) -> Harness {
    let kept = Kept::new_run(None, ToolsGiven::Injected);
    Harness::start_kept(
        home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("agy"),
        kept,
        started,
        ScreenStart::New,
    )
}

/// The agent's state, and why its CLI cannot use Facade's tools, once the actor published them.
fn tools_now(harness: &Harness) -> (AgentState, Option<facade_base::daemon::ToolsReason>) {
    let info = harness.handle.info();
    (info.state, info.tools_reason)
}

/// Waits up to five seconds for the agent's state and tools' reason to read `wanted`.
async fn tools_read(
    harness: &Harness,
    wanted: (AgentState, Option<facade_base::daemon::ToolsReason>),
) -> bool {
    tools_read_within(harness, wanted, Duration::from_secs(5)).await
}

/// Waits up to `time` for the agent's state and tools' reason to read `wanted`.
async fn tools_read_within(
    harness: &Harness,
    wanted: (AgentState, Option<facade_base::daemon::ToolsReason>),
    time: Duration,
) -> bool {
    let until = Instant::now() + time;
    while tools_now(harness) != wanted && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tools_now(harness) == wanted
}

impl Harness {
    /// Draws Antigravity's input frame as 1.4.12 does, its input holding `input`, with the
    /// cursor after it.
    fn agy_input(&mut self, input: &str) {
        let rule = "─".repeat(80);
        let frame = format!(
            "\x1b[2J\x1b[HAntigravity CLI 1.4.12\r\n\r\n{rule}\r\n> {input}\r\n{rule}\r\n? for \
             shortcuts\x1b[4;{}H",
            3 + input.chars().count()
        );
        self.cli.write_all(frame.as_bytes()).unwrap();
    }

    /// Draws a question of Antigravity's own in place of its input, such as its trust question
    /// in a new folder, with the terminal cursor hidden, as its questions hide it.
    fn agy_question(&mut self) {
        let question = "Do you trust the files in this folder?\r\n\r\n> 1. Trust folder\r\n  \
                        2. Exit\r\n\r\n  ↑/↓ Navigate · enter Select";
        self.cli
            .write_all(format!("\x1b[2J\x1b[H\x1b[?25l{question}").as_bytes())
            .unwrap();
    }

    /// Draws Antigravity's MCP panel, with Facade's server ready or still starting.
    fn agy_panel(&mut self, ready: bool) {
        let server = if ready {
            ">  ✓ facade_facade  Tools: list_agents"
        } else {
            ">  ⋯ facade_facade"
        };
        self.cli
            .write_all(
                format!("\x1b[2J\x1b[HMCP Servers\r\n\r\n{server}\r\n\r\nesc Exit\x1b[3;1H")
                    .as_bytes(),
            )
            .unwrap();
    }
}

/// A run's start readies Antigravity's tools before its first turn, as COLLABORATION-2.2 says:
/// `/mcp` once the input first reads empty, Enter once it shows alone, and Escape once the
/// panel shows the tools ready. A message sent meanwhile waits for it, as behind a draft, and
/// goes in after.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_readies_antigravity_s_tools_before_its_first_turn() {
    let home = home("readytools");
    let mut harness = antigravity(&home);
    let number = crate::messages::number(
        &crate::messages::tests::post_new(
            &harness.messages,
            crate::messages::tests::message(0, "a1"),
        )
        .0,
    );
    let hello = Submission {
        text: "hello".into(),
        sender: Sender::person(),
    };
    let typing = MessageTyping::new(
        "📨 hello".into(),
        number,
        Instant::now() + Duration::from_secs(29),
        hello,
    );
    let (reply, taken) = oneshot::channel();
    harness
        .send(AgentCommand::WriteInput {
            input: Input::Message(typing),
            run: FIRST_RUN,
            reply,
        })
        .await;
    assert!(taken.await.unwrap().is_ok());
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(300))
            .is_empty(),
        "nothing before the input reads"
    );
    harness.agy_input("");
    assert_eq!(harness.cli_reads(4), b"/mcp");
    // The screen still shows the input empty, before the CLI draws `/mcp`: the message waits
    // for the start all the same.
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty(),
        "the message waits for the panel step"
    );
    harness.agy_input("/mcp");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.agy_panel(false);
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty(),
        "the panel stays while the tools start"
    );
    harness.agy_panel(true);
    assert_eq!(harness.cli_reads(1), b"\x1b");
    harness.agy_input("");
    assert_eq!(
        String::from_utf8(harness.cli_reads("📨 hello".len())).unwrap(),
        "📨 hello",
        "the message goes in after"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A draft that the CLI draws away within a second, as a redraw to a new size does, is no draft
/// to give up on: the start types `/mcp` once the input reads empty.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_waits_for_a_draft_that_is_a_redraw_to_go() {
    let home = home("readyredraw");
    let mut harness = antigravity(&home);
    harness.agy_input("hello");
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(300))
            .is_empty()
    );
    harness.agy_input("");
    assert_eq!(harness.cli_reads(4), b"/mcp");
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// The start types nothing where the input first reads anything but empty, as a draft or a
/// question of the CLI's, or the CLI is working; and where `/mcp` does not show alone, it
/// presses no Enter and takes `/mcp` back. Each leaves the tools not started, an error, until
/// the first turn starts them.
#[tokio::test(flavor = "multi_thread")]
async fn a_start_readies_no_tools_over_other_input_or_a_turn_and_says_so() {
    let home = home("readynothing");
    let mut drafted = antigravity(&home.join("drafted"));
    drafted.agy_input("hello");
    let mut working = antigravity(&home.join("working"));
    working
        .cli
        .write_all(b"\x1b]7501;state=working\x07")
        .unwrap();
    working.agy_input("");
    let mut joined = antigravity(&home.join("joined"));
    joined.agy_input("");
    assert_eq!(joined.cli_reads(4), b"/mcp");
    // A completion shows beside it.
    joined.agy_input("/mcp facade_facade");
    for harness in [&mut drafted, &mut working] {
        assert!(
            harness
                .cli_reads_within(4, Duration::from_millis(2500))
                .is_empty()
        );
    }
    assert_eq!(
        joined.cli_reads_within(5, READY_TYPED + Duration::from_secs(2)),
        b"\x7f\x7f\x7f\x7f",
        "taken back, no Enter"
    );
    let not_started = (
        AgentState::Error,
        Some(facade_base::daemon::ToolsReason::NotStarted),
    );
    for harness in [&drafted, &working, &joined] {
        assert!(
            tools_read(harness, not_started).await,
            "{:?}",
            tools_now(harness)
        );
    }
    for harness in [drafted, working, joined] {
        harness.stop().await;
    }
    std::fs::remove_dir_all(&home).unwrap();
}

/// A question Antigravity asks at its start, such as its trust question in a new folder, is the
/// person's to answer: the keys held before it reach it once it shows, and so do the person's
/// keys while it shows, and the time it takes uses up none of the start's bound. Once it is
/// answered and the input reads empty, the start readies the tools, and they become available.
#[tokio::test(flavor = "multi_thread")]
async fn a_question_antigravity_asks_at_its_start_is_answered_first_and_takes_none_of_its_time() {
    let home = home("readyquestion");
    // The start's bound ends ten seconds from now, and the question shows from before then
    // until half a second after: a loaded machine has taken seconds to start the actor, and as
    // long to take the next screen.
    let started = Instant::now() - START_TIMEOUT + Duration::from_secs(10);
    let mut harness = antigravity_started(&home, started);
    harness
        .type_bytes(b"1")
        .await
        .expect("the person's keys are taken, to wait");
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(300))
            .is_empty(),
        "keys wait while the CLI shows nothing"
    );
    harness.agy_question();
    assert_eq!(
        harness.cli_reads(1),
        b"1",
        "the keys that waited reach the question"
    );
    tokio::time::sleep_until(started + START_TIMEOUT + Duration::from_millis(500)).await;
    harness.type_bytes(b"2").await.unwrap();
    assert_eq!(
        harness.cli_reads_within(1, Duration::from_millis(500)),
        b"2",
        "and so do the person's keys while it shows"
    );
    // Answered, the question goes, and the CLI draws its input half a second later.
    harness.cli.write_all(b"\x1b[?25h\x1b[2J\x1b[H").unwrap();
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty(),
        "nothing is typed while the CLI shows nothing"
    );
    harness.agy_input("");
    assert_eq!(
        harness.cli_reads(4),
        b"/mcp",
        "answered past the start's first bound, the start readies the tools"
    );
    harness.agy_input("/mcp");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.agy_panel(false);
    let waits = harness.cli_reads_within(1, Duration::from_millis(500));
    assert!(
        waits.is_empty(),
        "the panel waits for the tools, within the bound, which runs again from the \
         question's end"
    );
    harness.agy_panel(true);
    assert_eq!(harness.cli_reads(1), b"\x1b");
    harness.agy_input("");
    let _connection = harness.handle.tools_connected();
    let tools = || harness.handle.info().tools_state;
    let until = Instant::now() + Duration::from_secs(5);
    while tools() != facade_base::daemon::ToolsState::Available && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        (tools(), tools_now(&harness).1),
        (facade_base::daemon::ToolsState::Available, None),
        "the tools are ready"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// The Enter a start types to ready Antigravity's tools asks its CLI for nothing: its working
/// is no turn until someone asks.
#[tokio::test(flavor = "multi_thread")]
async fn readying_the_tools_asks_the_cli_for_nothing() {
    let home = home("readyasks");
    let mut harness = antigravity(&home);
    let asked = |dir: &Path| {
        let kept = std::fs::read(super::state::state_file(dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        kept.is_some_and(|kept| kept["counts_turns"] == true)
    };
    harness.agy_input("");
    assert_eq!(harness.cli_reads(4), b"/mcp");
    harness.agy_input("/mcp");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.agy_panel(true);
    assert_eq!(harness.cli_reads(1), b"\x1b");
    harness.agy_input("");
    tokio::time::sleep(ESCAPE_DELAY + Duration::from_millis(500)).await;
    assert!(!asked(&harness.dir), "the start's Enter asks nothing");
    let answer = harness
        .type_call(Typing::keys(&["Enter".into()]).unwrap())
        .await
        .unwrap();
    assert_eq!(harness.cli_reads(1), b"\r", "a call after it goes in");
    assert_eq!(answered(answer).await, Ok(()));
    let until = std::time::Instant::now() + Duration::from_secs(5);
    while !asked(&harness.dir) && std::time::Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(asked(&harness.dir), "the call's Enter asks");
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Keys from an attached terminal and calls that come while a start readies Antigravity's tools
/// wait until it is done, those typed before its input first shows too, so that its first turn
/// has the tools, however late the panel shows them ready; then they go in, in the order they
/// came.
#[tokio::test(flavor = "multi_thread")]
async fn keys_and_calls_wait_while_a_start_readies_the_tools() {
    let home = home("readyhold");
    let mut harness = antigravity(&home);
    harness
        .type_bytes(b"hi")
        .await
        .expect("the person's keys are taken, to wait");
    let answer = harness
        .type_call(Typing::text(" there".into(), false, Sender::person()).unwrap())
        .await
        .unwrap();
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(300))
            .is_empty(),
        "nothing goes in before the input shows"
    );
    harness.agy_input("");
    assert_eq!(harness.cli_reads(4), b"/mcp", "the start goes first");
    harness.agy_input("/mcp");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.agy_panel(false);
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(1500))
            .is_empty(),
        "the panel shows the tools late: the keys still wait"
    );
    harness.agy_panel(true);
    assert_eq!(harness.cli_reads(1), b"\x1b");
    assert_eq!(
        harness.cli_reads(8),
        b"hi there",
        "then the keys and the call, in the order they came"
    );
    assert_eq!(answered(answer).await, Ok(()));
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// The hold ends at the start's bound: a CLI that never shows its input lets the person's keys
/// in then, and its tools are not started.
#[tokio::test(flavor = "multi_thread")]
async fn the_hold_ends_at_the_start_s_bound() {
    let home = home("holdbound");
    let almost = Instant::now()
        .checked_sub(START_TIMEOUT - Duration::from_secs(1))
        .expect("a clock that has run a minute");
    let mut harness = antigravity_started(&home, almost);
    harness.type_bytes(b"hi").await.unwrap();
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty(),
        "held until the bound"
    );
    assert_eq!(
        harness.cli_reads_within(2, Duration::from_secs(3)),
        b"hi",
        "let in at the bound"
    );
    assert!(
        tools_read(
            &harness,
            (
                AgentState::Error,
                Some(facade_base::daemon::ToolsReason::NotStarted)
            )
        )
        .await,
        "{:?}",
        tools_now(&harness)
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A panel that does not show the tools ready within its wait is closed then, but only while it
/// still shows: once someone else closed it, the key could stop a turn of theirs.
#[tokio::test(flavor = "multi_thread")]
async fn a_panel_that_shows_no_ready_tools_is_closed_at_its_wait_only_while_it_shows() {
    let home = home("readybound");
    let (mut open, mut closed) = (
        antigravity(&home.join("open")),
        antigravity(&home.join("closed")),
    );
    for harness in [&mut open, &mut closed] {
        harness.agy_input("");
        assert_eq!(harness.cli_reads(4), b"/mcp");
        harness.agy_input("/mcp");
        assert_eq!(harness.cli_reads(1), b"\r");
    }
    open.agy_panel(false);
    closed.agy_input("");
    // Each wait ends READY_SHOWN after its Enter, with the tools not started, after any Escape.
    // The test waits for that outcome, not for a time: on a loaded machine the actor's timer
    // and the screen reader lag.
    let not_started = (
        AgentState::Error,
        Some(facade_base::daemon::ToolsReason::NotStarted),
    );
    for harness in [&open, &closed] {
        assert!(
            tools_read_within(harness, not_started, READY_SHOWN + Duration::from_secs(60)).await,
            "{:?}",
            tools_now(harness)
        );
    }
    assert_eq!(open.cli_reads(1), b"\x1b");
    assert!(
        closed
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty()
    );
    for harness in [open, closed] {
        harness.stop().await;
    }
    std::fs::remove_dir_all(&home).unwrap();
}

/// A run that a daemon recovers is under way: its tools are not readied again, and neither are
/// those of a run not given them.
#[tokio::test(flavor = "multi_thread")]
async fn only_a_start_given_the_tools_readies_them() {
    let home = home("readyonly");
    let kept = Kept::new_run(None, ToolsGiven::Injected);
    let recovered = |dir: PathBuf| ScreenStart::Recovered {
        handed_over_cleanly: false,
        screen: Box::new(Screen::new(80, 24, SCROLLBACK_ROWS)),
        log: Some(ScreenLog::create(
            dir,
            "a1",
            screen_log::Checkpoint::capture(&Screen::new(80, 24, SCROLLBACK_ROWS)),
        )),
    };
    let mut again = Harness::start_kept(
        &home.join("again"),
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("agy"),
        kept,
        Instant::now(),
        recovered,
    );
    let mut plain = Harness::start_by_rule(
        &home.join("plain"),
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("agy"),
        ScreenStart::New,
    );
    for harness in [&mut again, &mut plain] {
        harness.agy_input("");
    }
    for harness in [&mut again, &mut plain] {
        assert!(
            harness
                .cli_reads_within(4, Duration::from_millis(800))
                .is_empty()
        );
    }
    for harness in [again, plain] {
        harness.stop().await;
    }
    std::fs::remove_dir_all(&home).unwrap();
}

/// A resume readies its run's tools as a start does, where its CLI was given them.
#[tokio::test(flavor = "multi_thread")]
async fn a_resumed_run_readies_its_tools_too() {
    let home = home("readyresumed");
    let mut harness = antigravity(&home);
    // The first run's own step ends before the resume: its input first shows a draft.
    harness.agy_input("left over");
    assert!(
        tools_read(
            &harness,
            (
                AgentState::Error,
                Some(facade_base::daemon::ToolsReason::NotStarted)
            )
        )
        .await
    );
    harness.end_run(FIRST_RUN, 0).await;
    harness.prepare_restart(2, 80, 24).await;
    let (master, cli) = raw_terminal(80, 24);
    harness.install_given(2, master, ToolsGiven::Injected).await;
    harness.cli = cli;
    harness.agy_input("");
    assert_eq!(harness.cli_reads(4), b"/mcp");
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A Claude Code run given Facade's tools, at 80 by 24, with YOLO on or off, whose CLI has
/// drawn nothing yet.
fn claude(home: &Path, yolo: bool) -> Harness {
    let kept = Kept::new_run(None, ToolsGiven::Injected);
    let info = AgentInfo {
        yolo,
        ..record(ProcessState::Running, None, 80, 24)
    };
    Harness::start_kept(
        home,
        info,
        b"",
        Some("claude"),
        kept,
        Instant::now(),
        ScreenStart::New,
    )
}

impl Harness {
    /// Draws Claude Code 2.1.322's question about trusting the launch's folder, behind a hidden
    /// cursor, its selection on the answer that trusts or on the one that refuses, which it
    /// shows first.
    fn claude_trust(&mut self, trusting: bool) {
        let (refuse, trust) = if trusting {
            ("  ", "❯ ")
        } else {
            ("❯ ", "  ")
        };
        let question = format!(
            " Accessing workspace:\r\n\r\n /work/probe\r\n\r\n Quick safety check: Is this a \
             project you created or one you trust? (Like your own\r\n code, a \
             well-known open source project, or work from your team).\r\n\r\n Claude Code'll \
             be able to read, edit, and execute files here.\r\n\r\n \
             {refuse}No, exit\r\n {trust}Yes, I trust this folder\r\n\r\n Enter to confirm · \
             Esc to cancel"
        );
        self.cli
            .write_all(format!("\x1b[2J\x1b[H\x1b[?25l{question}").as_bytes())
            .unwrap();
    }

    /// Asks the trust question as Claude Code 2.1.322 does as it starts: it draws the question,
    /// its selection on the answer that refuses, asks the terminal what it supports, and draws
    /// the question again 150 ms later, its selection reset, losing the keys that came before.
    /// Returns what the CLI read before then, with all of the terminal's reply to its question,
    /// and when it drew the question again. The reply, which ends in `c`, comes before any key,
    /// as the actor answers the question as it reads it; a loaded machine can take longer than
    /// 150 ms over it.
    fn claude_trust_at_start(&mut self) -> (Vec<u8>, std::time::Instant) {
        self.claude_trust(false);
        self.cli.write_all(b"\x1b[c").unwrap();
        let mut before = self.cli_reads_within(64, Duration::from_millis(150));
        self.claude_trust(false);
        let drawn = std::time::Instant::now();
        while !before.contains(&b'c') {
            let more = self.cli_reads(1);
            assert!(
                !more.is_empty(),
                "the terminal replies to the CLI's question: {before:?}"
            );
            before.extend(more);
        }
        (before, drawn)
    }

    /// Draws Claude Code 2.1.322's question in Bypass Permissions mode, which another of its
    /// menus shows the same way.
    fn claude_bypass(&mut self) {
        let question = "  WARNING: Claude Code running in Bypass Permissions mode\r\n\
                        \r\n  ❯ No, exit\r\n    Yes, I accept\r\n\r\n  Enter to confirm \
                        · Esc to cancel";
        self.cli
            .write_all(format!("\x1b[2J\x1b[H\x1b[?25l{question}").as_bytes())
            .unwrap();
    }

    /// Draws Claude Code's empty input frame, with the cursor in it.
    fn claude_input(&mut self) {
        let rule = "─".repeat(80);
        self.cli
            .write_all(
                format!("\x1b[2J\x1b[H\x1b[?25h{rule}\r\n❯\u{a0}\r\n{rule}\x1b[2;3H").as_bytes(),
            )
            .unwrap();
    }
}

/// A run with YOLO on answers Claude Code's question about trusting the launch's folder as a
/// person would (CLIS-3.3), each key once the screen has been still for a moment, as Claude
/// Code 2.1.322 loses keys that come before it draws its question again: Down once the question
/// shows, then Enter once the selection shows on the answer that trusts, never Enter alone,
/// which would end the run. It answers once: the question coming back is the person's.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_with_yolo_on_answers_claude_code_s_trust_question_once_as_a_person_would() {
    let home = home("trustanswer");
    let mut harness = claude(&home, true);
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(300))
            .is_empty(),
        "nothing before the question shows"
    );
    let (before, drawn) = harness.claude_trust_at_start();
    assert!(
        !before.windows(3).any(|keys| keys == b"\x1b[B") && !before.contains(&b'\r'),
        "no key before it is drawn again: {before:?}"
    );
    assert_eq!(harness.cli_reads(3), b"\x1b[B", "Down first");
    assert!(
        drawn.elapsed() >= TRUST_STILL,
        "once the screen was still: {:?}",
        drawn.elapsed()
    );
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty(),
        "Enter waits for the selection to show on Yes"
    );
    harness.claude_trust(true);
    let selected = std::time::Instant::now();
    assert_eq!(harness.cli_reads(1), b"\r", "then Enter");
    assert!(
        selected.elapsed() >= TRUST_STILL,
        "once the screen was still: {:?}",
        selected.elapsed()
    );
    harness.claude_input();
    // The question left, which answered it once no read had shown it for TRUST_STILL; then it
    // comes back.
    std::thread::sleep(TRUST_STILL + Duration::from_millis(500));
    harness.claude_trust(false);
    assert!(
        harness
            .cli_reads_within(1, TRUST_STILL + Duration::from_secs(1))
            .is_empty(),
        "the question coming back is the person's"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A quiet agent, as a newer Facade taking over leaves it, presses no key of its start: the
/// start's steps read a screen it reads no more. Its trust question is left to the person, as
/// after a crash.
#[tokio::test(flavor = "multi_thread")]
async fn a_quiet_agent_presses_no_key_of_its_start() {
    let home = home("trustquiet");
    let mut harness = claude(&home, true);
    harness.claude_trust(false);
    assert!(
        harness
            .shows("Yes, I trust this folder", Duration::from_secs(5))
            .await,
        "{:?}",
        harness.text().await
    );
    let (reply, quiet) = tokio::sync::oneshot::channel();
    harness.send(AgentCommand::Quiesce { reply }).await;
    quiet.await.unwrap();
    assert!(
        harness
            .cli_reads_within(1, TRUST_STILL + Duration::from_secs(1))
            .is_empty(),
        "no key once quiet"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

const CLAUDE_PLAIN_HINT: &str = r#"Try "refactor <filepath>""#;

impl Harness {
    /// Draws Claude Code's plain input with the cursor between `before` and `after`.
    fn plain_claude_input(&mut self, before: &str, after: &str) {
        let border = "─".repeat(80);
        let column = 3 + before.chars().count();
        let frame = format!(
            "\x1b[?2004h\x1b[2J\x1b[H{border}\r\n❯\u{a0}{before}{after}\r\n{border}\x1b[2;{column}H"
        );
        self.cli.write_all(frame.as_bytes()).unwrap();
    }

    async fn queue_probe_message(
        &self,
        text: &str,
        deadline: Duration,
    ) -> watch::Receiver<Option<crate::messages::Settled>> {
        let (kept, settled) = crate::messages::tests::post_new(
            &self.messages,
            crate::messages::tests::message(0, "a1"),
        );
        let message = MessageTyping::new(
            text.into(),
            crate::messages::number(&kept),
            Instant::now() + deadline,
            Submission {
                text: text.into(),
                sender: Sender::person(),
            },
        );
        let (reply, taken) = oneshot::channel();
        self.send(AgentCommand::WriteInput {
            input: Input::Message(message),
            run: FIRST_RUN,
            reply,
        })
        .await;
        taken.await.unwrap().unwrap();
        settled
    }
}

async fn probe_message_settled(
    mut outcome: watch::Receiver<Option<crate::messages::Settled>>,
) -> crate::messages::Settled {
    let settled = tokio::time::timeout(Duration::from_secs(6), outcome.wait_for(Option::is_some))
        .await
        .expect("the message is settled")
        .unwrap();
    settled.as_ref().unwrap().clone()
}

async fn assert_plain_draft_held(
    harness: &mut Harness,
    outcome: watch::Receiver<Option<crate::messages::Settled>>,
    draft: &str,
) {
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(500))
            .is_empty(),
        "the person's draft gets no probe or paste"
    );
    let crate::messages::Settled::Withdrawn(message) = probe_message_settled(outcome).await else {
        panic!("the draft holds the message until its deadline");
    };
    assert_eq!(
        message.delivery.reason,
        Some(facade_base::daemon::DeliveryFailure::InputDraft)
    );
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(100))
            .is_empty()
    );
    let row = format!("❯\u{a0}{draft}");
    assert!(harness.text().await.contains(&row));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_draft_matching_a_probed_hint_holds_the_next_message() {
    let home = home("claudeprobedhint");
    let mut harness = claude(&home, false);
    let hint = CLAUDE_PLAIN_HINT;
    harness.plain_claude_input("", hint);
    let first = harness
        .queue_probe_message("first message", Duration::from_secs(15))
        .await;
    assert_eq!(harness.cli_reads(1), b" ", "the fresh hint is probed");
    harness.plain_claude_input(" ", "");
    assert_eq!(harness.cli_reads(1), b"\x7f");
    harness.plain_claude_input("", hint);
    let paste = b"\x1b[200~first message\x1b[201~";
    assert_eq!(harness.cli_reads(paste.len()), paste);
    harness.plain_claude_input("first message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", hint);
    let crate::messages::Settled::Kept(first) = probe_message_settled(first).await else {
        panic!("the first message is kept");
    };
    assert_eq!(
        first.delivery.status,
        facade_base::daemon::DeliveryStatus::Success
    );

    // The person types the same text and presses Home. The CLI draws the same row and cursor.
    let edit = format!("{hint}\x1b[H");
    harness.type_bytes(edit.as_bytes()).await.unwrap();
    assert_eq!(harness.cli_reads(edit.len()), edit.as_bytes());
    harness.plain_claude_input("", hint);
    let second = harness
        .queue_probe_message("second message", Duration::from_secs(3))
        .await;
    assert_plain_draft_held(&mut harness, second, hint).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_during_a_plain_claude_hint_probe_waits_for_its_backspace() {
    let home = home("claudehintpersonkey");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(5))
        .await;
    assert_eq!(harness.cli_reads(1), b" ");

    harness.type_bytes(b"x").await.unwrap();
    harness.plain_claude_input(" ", "");
    assert_eq!(harness.cli_reads(1), b"\x7f", "Backspace goes first");
    harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
    let key = harness.cli_reads(1);
    assert_eq!(key, b"x", "the person's key follows cleanup");
    harness.plain_claude_input(std::str::from_utf8(&key).unwrap(), "");
    assert_plain_draft_held(&mut harness, message, "x").await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_held_for_a_plain_claude_hint_probe_runs_after_withdrawal() {
    let home = home("claudehintcall");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(10))
        .await;
    assert_eq!(harness.cli_reads(1), b" ");

    let answer = harness
        .type_call(Typing::keys(&["x".into()]).unwrap())
        .await
        .unwrap();
    assert!(harness.messages.withdraw(1));
    assert!(matches!(
        probe_message_settled(message).await,
        crate::messages::Settled::Cancelled
    ));
    harness.plain_claude_input(" ", "");
    assert_eq!(harness.cli_reads(1), b"\x7f");
    harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
    assert_eq!(harness.cli_reads(1), b"x");
    answered(answer).await.unwrap();
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A quiet agent types no message, however one reaches it: the next daemon types what is left
/// of it, from the store.
#[tokio::test(flavor = "multi_thread")]
async fn a_quiet_agent_types_no_message() {
    let home = home("quiettypist");
    let mut harness = claude(&home, false);
    harness.claude_input();
    assert!(
        harness.shows("❯", Duration::from_secs(5)).await,
        "{:?}",
        harness.text().await
    );
    let (reply, quiet) = tokio::sync::oneshot::channel();
    harness.send(AgentCommand::Quiesce { reply }).await;
    quiet.await.unwrap();
    let post = harness.messages.clone();
    let number = crate::messages::number(
        &crate::messages::tests::post_new(&post, crate::messages::tests::message(0, "a1")).0,
    );
    let said = Submission {
        text: "a message".into(),
        sender: Sender::person(),
    };
    let message = MessageTyping::new(
        "a message".into(),
        number,
        Instant::now() + Duration::from_secs(30),
        said,
    );
    let (reply, taken) = tokio::sync::oneshot::channel();
    harness
        .send(AgentCommand::WriteInput {
            input: Input::Message(message),
            run: FIRST_RUN,
            reply,
        })
        .await;
    assert!(taken.await.unwrap().is_ok());
    assert!(
        harness
            .cli_reads_within(1, Duration::from_secs(2))
            .is_empty(),
        "nothing is typed once quiet"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Enter goes only while a still screen shows the selection on the answer that trusts: not on a
/// selection that showed there and was drawn back on the answer that refuses, which would end
/// the run, nor while the screen keeps changing. Nothing more is pressed for a question that
/// stays on after its answer.
#[tokio::test(flavor = "multi_thread")]
async fn enter_goes_only_while_a_still_screen_shows_the_selection_on_the_answer_that_trusts() {
    let home = home("trustenter");
    let mut first = claude(&home.join("first"), true);
    first.claude_trust(true);
    std::thread::sleep(Duration::from_millis(300));
    first.claude_trust(false);
    let mut reset = claude(&home.join("reset"), true);
    reset.claude_trust(false);
    assert_eq!(reset.cli_reads(3), b"\x1b[B");
    reset.claude_trust(true);
    std::thread::sleep(Duration::from_millis(300));
    reset.claude_trust(false);
    assert!(
        reset
            .cli_reads_within(1, TRUST_SELECTED + Duration::from_secs(1))
            .is_empty(),
        "no Enter on the answer that refuses"
    );
    assert_eq!(
        first.cli_reads(3),
        b"\x1b[B",
        "a question drawn first on Yes, then on No, gets Down, not Enter"
    );
    let mut busy = claude(&home.join("busy"), true);
    busy.claude_trust(false);
    assert_eq!(busy.cli_reads(3), b"\x1b[B");
    let moved = std::time::Instant::now();
    while moved.elapsed() < TRUST_SELECTED + Duration::from_millis(500) {
        busy.claude_trust(true);
        assert!(
            busy.cli_reads_within(1, Duration::from_millis(300))
                .is_empty(),
            "no Enter while the screen changes"
        );
    }
    assert!(
        busy.cli_reads_within(1, TRUST_STILL + Duration::from_secs(1))
            .is_empty(),
        "its wait for the selection is over"
    );
    let mut stays = claude(&home.join("stays"), true);
    stays.claude_trust(false);
    assert_eq!(stays.cli_reads(3), b"\x1b[B");
    stays.claude_trust(true);
    assert_eq!(stays.cli_reads(1), b"\r");
    assert!(
        stays
            .cli_reads_within(1, TRUST_GONE + Duration::from_secs(1))
            .is_empty(),
        "nothing more for a question that stays"
    );
    for harness in [first, reset, busy, stays] {
        harness.stop().await;
    }
    std::fs::remove_dir_all(&home).unwrap();
}

/// A CLI that draws slowly after Down, as Claude Code does on a machine starting several agents
/// at once, still gets its Enter: here the selection takes 5 seconds to show on the answer that
/// trusts.
#[tokio::test(flavor = "multi_thread")]
async fn a_selection_that_shows_slowly_after_down_still_gets_its_enter() {
    let home = home("trustslow");
    let mut slow = claude(&home, true);
    slow.claude_trust(false);
    assert_eq!(slow.cli_reads(3), b"\x1b[B", "Down first");
    std::thread::sleep(Duration::from_secs(5));
    slow.claude_trust(true);
    assert_eq!(slow.cli_reads(1), b"\r", "Enter once the selection shows");
    slow.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// An agent that ends says so in its record before anything that waits on the run learns it: a
/// start prompt that waited for the CLI's tools fails as ended only once the record shows the
/// run ended and its tools unavailable, so that the result the prompt writes says so. Here a
/// reader holds the record while the run ends: the prompt learns nothing until it lets go.
#[tokio::test(flavor = "multi_thread")]
async fn an_ended_run_is_in_its_record_before_its_waiting_prompt_learns_it_ended() {
    let home = home("endedorder");
    let harness = claude(&home, false);
    let (ready, mut started) = oneshot::channel();
    harness.send(AgentCommand::AwaitPrompt { ready }).await;
    // The actor has taken the command and its start's work is done: it waits for the next one,
    // the record free.
    let (reply, inspected) = oneshot::channel();
    harness.send(AgentCommand::Inspect { reply }).await;
    assert_eq!(
        inspected.await.unwrap().agent.tools_state,
        ToolsState::Connecting
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Exercise record-before-notification ordering by holding the shared leaf lock.
    let (shared, (locked, holding), (release, released)) = (
        harness.handle.shared.clone(),
        std::sync::mpsc::channel(),
        std::sync::mpsc::channel::<()>(),
    );
    let reader = std::thread::spawn(move || {
        let _held = shared.record.lock().unwrap();
        locked.send(()).unwrap();
        let _ = released.recv();
    });
    holding.recv().unwrap();
    harness
        .send(AgentCommand::ProcessExited {
            run: FIRST_RUN,
            exit: exit_with(0),
            stopped: false,
        })
        .await;
    let early = tokio::time::timeout(Duration::from_millis(500), &mut started).await;
    assert!(
        early.is_err(),
        "the prompt learned the run ended before its record said so"
    );
    release.send(()).unwrap();
    reader.join().unwrap();
    let learned = tokio::time::timeout(Duration::from_secs(5), &mut started)
        .await
        .expect("the prompt learns it once the record says so");
    assert!(learned.is_err(), "a run that ended takes no prompt");
    let info = harness.handle.info();
    let ended = (
        ProcessState::Ended,
        ToolsState::Unavailable,
        Some(facade_base::daemon::ToolsReason::Ended),
    );
    assert_eq!((info.process, info.tools_state, info.tools_reason), ended);
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A message the typist is typing, its paste begun, fails as ended only once the agent's record
/// shows the run ended, as a waiting start prompt does. Here a reader holds the record while
/// the run ends: the message learns nothing until it lets go.
#[tokio::test(flavor = "multi_thread")]
async fn an_ended_run_is_in_its_record_before_a_message_being_typed_learns_it_ended() {
    let home = home("endedtyping");
    let mut harness = Harness::start_by_rule(
        &home,
        record(ProcessState::Running, None, 40, 6),
        "\x1b[?2004h❯ ".as_bytes(),
        Some("fake"),
        ScreenStart::New,
    );
    let (kept, mut settled) = crate::messages::tests::post_new(
        &harness.messages,
        crate::messages::tests::message(0, "a1"),
    );
    let said = Submission {
        text: "a message".into(),
        sender: Sender::person(),
    };
    let typing = MessageTyping::new(
        "a message".into(),
        crate::messages::number(&kept),
        Instant::now() + Duration::from_secs(30),
        said,
    );
    let (reply, taken) = oneshot::channel();
    harness
        .send(AgentCommand::WriteInput {
            input: Input::Message(typing),
            run: FIRST_RUN,
            reply,
        })
        .await;
    assert!(taken.await.unwrap().is_ok());
    let paste = b"\x1b[200~a message\x1b[201~";
    assert_eq!(harness.cli_reads(paste.len()), paste);
    // The CLI does not draw the draft: the typist waits for it, the message being typed. The
    // actor waits for its next command.
    harness.round_trip().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Exercise record-before-notification ordering by holding the shared leaf lock.
    let (shared, (locked, holding), (release, released)) = (
        harness.handle.shared.clone(),
        std::sync::mpsc::channel(),
        std::sync::mpsc::channel::<()>(),
    );
    let reader = std::thread::spawn(move || {
        let _held = shared.record.lock().unwrap();
        locked.send(()).unwrap();
        let _ = released.recv();
    });
    holding.recv().unwrap();
    harness
        .send(AgentCommand::ProcessExited {
            run: FIRST_RUN,
            exit: exit_with(0),
            stopped: false,
        })
        .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        settled.borrow().is_none(),
        "the message learned the run ended before its record said so"
    );
    release.send(()).unwrap();
    reader.join().unwrap();
    tokio::time::timeout(Duration::from_secs(5), settled.wait_for(Option::is_some))
        .await
        .expect("the message learns it once the record says so")
        .unwrap();
    let Some(crate::messages::Settled::Kept(message)) = settled.borrow().clone() else {
        panic!("the message is kept")
    };
    let failed = (
        facade_base::daemon::DeliveryStatus::Failure,
        Some(facade_base::daemon::DeliveryFailure::Ended),
    );
    assert_eq!((message.delivery.status, message.delivery.reason), failed);
    let info = harness.handle.info();
    assert_eq!(
        (info.process, info.exit.is_some()),
        (ProcessState::Ended, true)
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A run with YOLO off answers nothing: Claude Code's trust question is the person's. A run
/// with YOLO on answers that question alone: not another menu drawn the same way, not the
/// question once the CLI showed its input first, and no Enter where the selection does not show
/// on the answer that trusts.
#[tokio::test(flavor = "multi_thread")]
async fn only_a_run_with_yolo_on_answers_and_only_the_trust_question_with_its_selection_on_yes() {
    let home = home("trustonly");
    let mut off = claude(&home.join("off"), false);
    off.claude_trust(false);
    let mut other = claude(&home.join("other"), true);
    other.claude_bypass();
    let mut later = claude(&home.join("later"), true);
    later.claude_input();
    let mut stuck = claude(&home.join("stuck"), true);
    stuck.claude_trust(false);
    assert_eq!(stuck.cli_reads(3), b"\x1b[B");
    for harness in [&mut off, &mut other, &mut later] {
        assert!(
            harness
                .cli_reads_within(1, Duration::from_millis(1000))
                .is_empty()
        );
    }
    later.claude_trust(false);
    assert!(
        later
            .cli_reads_within(1, TRUST_STILL + Duration::from_secs(1))
            .is_empty(),
        "the input showed first: the folder was trusted"
    );
    assert!(
        stuck
            .cli_reads_within(1, TRUST_SELECTED + Duration::from_secs(1))
            .is_empty(),
        "no Enter while the selection stays on No"
    );
    stuck.claude_trust(true);
    assert!(
        stuck
            .cli_reads_within(1, TRUST_STILL + Duration::from_secs(1))
            .is_empty(),
        "its wait for the selection is over"
    );
    for harness in [off, other, later, stuck] {
        harness.stop().await;
    }
    std::fs::remove_dir_all(&home).unwrap();
}

// The existing viewer queue budget, checked through its receiving interface.
const VIEWER_BUDGET: usize = 1024 * 1024;

fn viewer_bytes(change: &ViewerChange) -> usize {
    match change {
        ViewerChange::Output(bytes) => bytes.len(),
        ViewerChange::Redraw { bytes, .. } => bytes.len(),
        ViewerChange::Exit(_) | ViewerChange::Removed => 0,
    }
}

// Timing bounds remain behavioral expectations, independent of the module's private constants.
const REDRAW_NUDGE_TIMEOUT: Duration = Duration::from_millis(200);
const READY_TYPED: Duration = Duration::from_secs(2);
const READY_SHOWN: Duration = Duration::from_secs(10);
const TRUST_STILL: Duration = Duration::from_secs(1);
const TRUST_SELECTED: Duration = Duration::from_secs(10);
const TRUST_GONE: Duration = Duration::from_secs(5);
