// Actor behavior tests carried from the agent unit suite.
use std::path::Path;

use facade_base::model::error::{ErrorBody, Reason};
use facade_base::{model::agent::ManagedAgentState, model::message::TextWritten};
use facade_screen::TerminalColors;

use super::person::{Enter, PersonKeys};
use super::screen as screen_log;
use super::*;
use std::io;
use std::sync::mpsc as std_mpsc;

use super::typist::TypingAnswer;
use facade_base::terminal::{PtyMaster, TestCli, test_terminal};
use facade_base::{model::agent::ToolsState, model::terminal::InputState};

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

pub(super) fn record(
    process: ProcessState,
    exit: Option<ProcessExit>,
    cols: u16,
    rows: u16,
) -> ManagedAgent {
    ManagedAgent {
        address: None,
        label: None,
        unreachable: false,
        agent_id: "a1".into(),
        name: "Pixel".into(),
        cli: "sh".into(),
        cwd: "/".into(),
        machine_id: String::new(),
        windows: Vec::new(),
        location_source_window: None,
        location_id: facade_base::model::machine::location_id("/"),
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
        state: ManagedAgentState::Unknown,
        state_detail: None,
        said: None,
        tools_state: facade_base::model::agent::ToolsState::NotInjected,
        tools_reason: None,
        guest: false,
    }
}

impl Harness {
    /// Starts an actor; `screen` builds its screen from the agent folder.
    fn start(
        home: &Path,
        info: ManagedAgent,
        screen: impl FnOnce(PathBuf) -> ScreenStart,
    ) -> Harness {
        Harness::start_after_output(home, info, b"", screen)
    }

    /// Starts an actor for a CLI that wrote `output` while no daemon read its terminal.
    fn start_after_output(
        home: &Path,
        info: ManagedAgent,
        output: &[u8],
        screen: impl FnOnce(PathBuf) -> ScreenStart,
    ) -> Harness {
        Harness::start_by_rule(home, info, output, None, screen)
    }

    /// Starts an actor for an agent started by CLI rule `rule`, whose CLI wrote `output` while
    /// no daemon read its terminal.
    fn start_by_rule(
        home: &Path,
        info: ManagedAgent,
        output: &[u8],
        rule: Option<&str>,
        screen: impl FnOnce(PathBuf) -> ScreenStart,
    ) -> Harness {
        Harness::start_kept(
            home,
            info,
            output,
            rule,
            (Kept::default(), Instant::now()),
            false,
            screen,
        )
    }

    /// Starts an actor with kept run facts, its start time and an explicit trust decision.
    fn start_kept(
        home: &Path,
        info: ManagedAgent,
        output: &[u8],
        rule: Option<&str>,
        (kept, started): (Kept, Instant),
        allow_auto_trust: bool,
        screen: impl FnOnce(PathBuf) -> ScreenStart,
    ) -> Harness {
        let (master, mut cli) = raw_terminal(info.cols.unwrap(), info.rows.unwrap());
        cli.write_all(output).unwrap();
        let dir = home.join("screens").join("a1");
        let (tx, rx) = mpsc::channel(MAX_QUEUED_COMMANDS);
        let state = StateStart {
            tools_config: None,
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
            launch_command: None,
            observed_loss: false,
            deliveries: messages.delivery_handle(),
            state,
        };
        let handle =
            spawn_with_trust(start, rx, tx, broadcast::channel(16).0, allow_auto_trust).unwrap();
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
            facade_base::model::terminal::plain(&read.await.ok()?.0.text)
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
                restart_size: None,
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
        .send(AgentCommand::ResizeTerminal(100, 30))
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
        .send(AgentCommand::ResizeTerminal(90, 28))
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
            restart_size: None,
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
            if let Some(ViewerChange::Exit(told, _)) = changes.recv().await {
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
        .send(AgentCommand::ResizeTerminal(40, 6))
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
            restart_size: None,
            handed_over_cleanly: false,
            screen: Box::new(screen),
            log: Some(log),
        }
    });
    for size in 0..40u16 {
        harness
            .handle
            .mailbox()
            .send(AgentCommand::ResizeTerminal(80 + size % 2, 24))
            .await
            .unwrap();
    }
    harness
        .handle
        .mailbox()
        .send(AgentCommand::ResizeTerminal(70, 20))
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
        keys.read(&[pasted(b"one\rtwo"), b" and ".to_vec(), pasted(b"three")].concat())
            .enter,
        None
    );
    let Enter { at, pastes } = keys.read(b"!\r").enter.expect("an Enter");
    assert_eq!(
        (at, pastes),
        (1, vec!["one\rtwo".to_string(), "three".to_string()])
    );
    // Four bytes and the longest paste but three come to one byte over the limit.
    let long = vec![b'x'; MAX_INPUT_BYTES - 3];
    let keys_with_long = [pasted(b"four"), pasted(&long), b"\r".to_vec()].concat();
    let Enter { pastes, .. } = keys.read(&keys_with_long).enter.expect("an Enter");
    let sizes: Vec<usize> = pastes.iter().map(String::len).collect();
    assert_eq!(
        sizes,
        [MAX_INPUT_BYTES - 3],
        "the earliest paste makes room"
    );
    assert_eq!(
        keys.read(b"\r").enter,
        Some(Enter {
            at: 0,
            pastes: Vec::new()
        }),
        "the next Enter starts with none"
    );
}

/// Input is counted as the CLI's terminal takes it. Codex on Windows takes each line break as a
/// press of Shift+Enter, two records of 18 bytes, so a text of 28,339 lines of one character,
/// 1,048,555 bytes in its paste brackets, fits the 1 MiB that may wait, and one more line never
/// does: it is refused, not queued. The same text goes to a CLI that takes it as it is.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn input_that_takes_more_of_a_console_than_all_the_room_is_refused() {
    let lines = |count: usize| Typing::text("a\n".repeat(count), false, Sender::person()).unwrap();
    let home = home("consoleroom");
    let codex = Harness::start_by_rule(
        &home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("codex"),
        ScreenStart::New,
    );
    for (count, bytes) in [(30_000, 1_110_012), (28_340, 1_048_592)] {
        let refused = codex.type_call(lines(count)).await.err();
        assert!(
            matches!(refused, Some(InputRejection::TooLarge(taken)) if taken == bytes),
            "{count} lines: {refused:?}"
        );
    }
    assert!(codex.type_call(lines(28_339)).await.is_ok());
    codex.stop().await;

    let home = self::home("plainroom");
    let plain = Harness::start(
        &home,
        record(ProcessState::Running, None, 80, 24),
        ScreenStart::New,
    );
    assert!(plain.type_call(lines(30_000)).await.is_ok());
    plain.stop().await;
}

/// The first prompt's terminal bytes take room before ordinary messages wait behind it.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn the_start_prompt_reserves_encoded_input_room_before_other_messages() {
    let home = home("startpromptroom");
    let harness = Harness::start_by_rule(
        &home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("codex"),
        ScreenStart::New,
    );
    let text = format!("{}{}end", "😀".repeat(7_000), "\n".repeat(539));
    facade_base::model::message::check_message_text(&text).unwrap();
    let (ready, _started) = oneshot::channel();
    harness
        .send(AgentCommand::AwaitPrompt {
            text: text.clone(),
            ready,
        })
        .await;

    let deadline = Instant::now() + Duration::from_secs(30);
    let send = async |input| {
        let (reply, taken) = oneshot::channel();
        harness
            .send(AgentCommand::WriteInput {
                input,
                run: FIRST_RUN,
                reply,
            })
            .await;
        taken.await.unwrap()
    };
    let message = || {
        let number = crate::messages::number(
            &crate::messages::tests::post_new(
                &harness.messages,
                crate::messages::tests::message(0, "a1"),
            )
            .0,
        );
        Input::Message(MessageTyping::new(
            text.clone(),
            number,
            deadline,
            Submission {
                text: text.clone(),
                sender: Sender::person(),
            },
        ))
    };
    assert!(send(message()).await.is_ok());
    assert!(send(message()).await.is_ok());
    let Err(InputRejection::Backpressured(waiting)) = send(message()).await else {
        panic!("a third waiting message and the first prompt exceed 1 MiB");
    };

    harness
        .send(AgentCommand::StartPrompt {
            run: FIRST_RUN,
            prompt: None,
        })
        .await;
    assert!(send(waiting).await.is_ok(), "the prompt gave back its room");
    harness.stop().await;
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
            stopped_by: None,
        })
        .await
        .unwrap();
    let cut_off = answered(typing).await.unwrap_err();
    assert_eq!(
        (cut_off.data.reason, cut_off.message.as_str()),
        (Reason::PartialInput, "a1 ended; part of the text was typed")
    );
    assert_eq!(
        (cut_off.data.text_written, cut_off.data.enter_written),
        (Some(TextWritten::Partial), Some(false))
    );
    let waited = answered(waiting).await.unwrap_err();
    assert_eq!(
        (waited.data.reason, waited.message.as_str()),
        (Reason::Ended, "a1 ended; nothing was typed")
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
            stopped_by: None,
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

    async fn install(&self, run: u64, master: PtyMaster) -> ManagedAgent {
        self.install_given(run, master, ToolsGiven::NotInjected)
            .await
    }

    /// Installs run `run` on `master`, its CLI given Facade's tools as `tools` says.
    async fn install_given(&self, run: u64, master: PtyMaster, tools: ToolsGiven) -> ManagedAgent {
        let (reply, installed) = oneshot::channel();
        self.send(AgentCommand::InstallRun {
            run,
            master,
            pid: 4242,
            captures: false,
            launch_command: None,
            tools,
            tools_config: None,
            colors: Default::default(),
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
        self.inspect().await;
    }

    async fn inspect(&self) -> Inspection {
        let (reply, answered) = oneshot::channel();
        self.send(AgentCommand::Inspect { reply }).await;
        answered.await.unwrap()
    }

    async fn watch_screen(&self, viewer: u64) -> (ViewerSnapshot, viewers::ViewerReceiver) {
        let (tx, changes) = viewer_channel();
        let (reply, snapshot) = oneshot::channel();
        self.send(AgentCommand::AddViewer {
            viewer,
            tx,
            keep_scrollback: false,
            include_scrollback: false,
            reply,
        })
        .await;
        (snapshot.await.unwrap(), changes)
    }
}

/// Matches either kind of title output, from a redraw or a live viewer update.
fn has_title(bytes: &[u8], title: &str) -> bool {
    String::from_utf8_lossy(bytes).contains(&format!("\x1b]2;{title}\x1b\\"))
}

async fn next_title(changes: &mut viewers::ViewerReceiver, title: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let ViewerChange::Output(bytes) = changes.recv().await.unwrap() else {
                continue;
            };
            if has_title(&bytes, title) {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("viewer did not get title {title:?}"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_glyph_timer_runs_only_while_working_and_watched_even_during_output() {
    let home = home("glyph-timer");
    let mut harness = Harness::start_by_rule(
        &home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("claude"),
        ScreenStart::New,
    );
    harness
        .cli
        .write_all(b"\x1b]7501;?\x07\x1b]2;Title\x07\x1b]7501;state=working\x07Working")
        .unwrap();
    assert!(harness.shows("Working", Duration::from_secs(5)).await);
    assert_eq!(harness.handle.info().state, ManagedAgentState::Working);
    let one_frame = Duration::from_millis(1100);
    tokio::time::sleep(one_frame).await;
    let (snapshot, mut changes) = harness.watch_screen(1).await;
    assert!(has_title(&snapshot.redraw, "◐ Title"));

    let mut output = tokio::time::interval(Duration::from_millis(30));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            tokio::select! {
                _ = output.tick() => {
                    harness.cli.write_all(b"\x1b]7501;state=working\x07.").unwrap();
                }
                change = changes.recv() => {
                    if let ViewerChange::Output(bytes) = change.unwrap()
                        && has_title(&bytes, "◑ Title")
                    {
                        break;
                    }
                }
            }
        }
    })
    .await
    .expect("continuous output and repeated reports leave the glyph timer armed");

    harness.send(AgentCommand::RemoveViewer { viewer: 1 }).await;
    harness.round_trip().await;
    tokio::time::sleep(one_frame).await;
    let (snapshot, mut changes) = harness.watch_screen(2).await;
    assert!(has_title(&snapshot.redraw, "◑ Title"));

    harness
        .cli
        .write_all(b"\x1b]7501;state=blocked\x07")
        .unwrap();
    next_title(&mut changes, "✳ Title").await;
    assert!(
        tokio::time::timeout(one_frame, changes.recv())
            .await
            .is_err()
    );
    harness.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resumed_run_starts_without_a_status_glyph() {
    let home = home("glyph-resume");
    let mut harness = Harness::start_by_rule(
        &home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("claude"),
        ScreenStart::New,
    );
    let (_, mut changes) = harness.watch_screen(1).await;
    harness
        .cli
        .write_all(b"\x1b]7501;?\x07\x1b]2;First\x07\x1b]7501;state=working\x07")
        .unwrap();
    next_title(&mut changes, "◐ First").await;

    harness.end_run(FIRST_RUN, 0).await;
    harness.prepare_restart(2, 80, 24).await;
    let (master, mut cli) = raw_terminal(80, 24);
    let resumed = harness.install(2, master).await;
    assert_eq!(resumed.state, ManagedAgentState::Starting);
    cli.write_all(b"\x1b]7501;?\x07\x1b]2;Resumed\x1b\\")
        .unwrap();
    next_title(&mut changes, "Resumed").await;

    cli.write_all(b"\x1b]7501;state=working\x07").unwrap();
    next_title(&mut changes, "◐ Resumed").await;
    harness.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_synchronized_update_timing_out_sends_its_glyph_with_the_new_title() {
    let home = home("glyph-sync");
    let mut harness = Harness::start_by_rule(
        &home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("claude"),
        ScreenStart::New,
    );
    let (_, mut changes) = harness.watch_screen(1).await;
    harness.cli.write_all(b"\x1b]2;Old\x1b\\").unwrap();
    next_title(&mut changes, "Old").await;

    harness
        .cli
        .write_all(b"\x1b]7501;?\x07\x1b[?2026h\x1b]2;New\x1b\\\x1b]7501;state=idle\x07")
        .unwrap();
    next_title(&mut changes, "✳ New").await;
    harness.stop().await;
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
            restart_size: None,
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
            restart_size: None,
            handed_over_cleanly: false,
            screen: Box::new(Screen::new(40, 6, SCROLLBACK_ROWS)),
            log: None,
        },
    );
    let state = || harness.handle.info().state;
    let until = Instant::now() + Duration::from_secs(5);
    while state() != ManagedAgentState::WaitingForYou && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state(), ManagedAgentState::WaitingForYou);
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
            stopped_by: None,
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
            stopped_by: None,
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
    // Installing the replacement finishes the old viewers' frame. The CLI's side closes at once.
    let master = test_terminal(80, 24).unwrap().0;
    harness.install(2, master).await;
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
            ViewerChange::Activity(_) => panic!("the viewer did not request activity"),
            ViewerChange::Exit(exit, _) => {
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
    harness.end_run(2, 6).await;
    // The viewer that never read still holds the first run's end beyond its budget: it is
    // dropped, not grown.
    let stalled = never.stalled();
    harness.prepare_restart(3, 80, 24).await;
    let (master, _cli) = raw_terminal(80, 24);
    harness.install(3, master).await;
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
            ViewerChange::Redraw { .. } | ViewerChange::Output(_) | ViewerChange::Exit(..)
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
        .send(AgentCommand::AttachViewer {
            viewer: 1,
            name: Some("terminal one".into()),
            attachment: None,
            allow_ended: false,
            report_activity: false,
            size: None,
            tx,
            keep_scrollback: false,
            include_scrollback: false,
            reply,
        })
        .await;
    assert_eq!(snapshot.await.unwrap().process, ProcessState::Running);
    let (reply, inspection) = oneshot::channel();
    harness.send(AgentCommand::Inspect { reply }).await;
    assert_eq!(inspection.await.unwrap().viewers, ["terminal one"]);
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
            ViewerChange::Activity(_) => panic!("the viewer did not request activity"),
            ViewerChange::Redraw { bytes, .. } => {
                assert!(String::from_utf8_lossy(&bytes).contains("LAST LINE"));
                redrawn = true;
            }
            ViewerChange::Exit(exit, _) => {
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
        tokio::time::timeout(Duration::from_secs(1), feed.recv())
            .await
            .expect("the watch closes")
            .is_none(),
        "Attach ends with the run"
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
        tools_config: None,
        file: super::state::state_file(&dir),
        kept: Kept::new_run(ToolsGiven::Injected),
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
        launch_command: None,
        observed_loss: false,
        deliveries: crate::messages::tests::messages().0.delivery_handle(),
        state,
    };
    let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
    // This runtime runs one task at a time: the actor has not run yet when the server connects.
    let _connection = handle.tools_connected();
    let tools = || handle.info().tools_state;
    let until = Instant::now() + Duration::from_secs(5);
    while tools() != facade_base::model::agent::ToolsState::Available && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(tools(), facade_base::model::agent::ToolsState::Available);
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
        tools_config: None,
        file: super::state::state_file(&dir),
        kept: Kept::new_run(ToolsGiven::Injected),
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
        launch_command: None,
        observed_loss: false,
        deliveries: post.delivery_handle(),
        state,
    };
    let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
    let (ready, mut settled) = oneshot::channel();
    handle
        .mailbox()
        .send(AgentCommand::AwaitPrompt {
            text: "fix it".into(),
            ready,
        })
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
    while status(prompt_number) == facade_base::model::message::DeliveryStatus::Pending
        && Instant::now() < until
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        status(prompt_number),
        facade_base::model::message::DeliveryStatus::Success
    );
    let paste = b"\x1b[200~a message \x1b[201~";
    assert_eq!(harness.cli_reads(paste.len()), paste, "then the message");
    assert_eq!(
        status(message_number),
        facade_base::model::message::DeliveryStatus::Pending
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
        tools_config: None,
        file: super::state::state_file(&dir),
        kept: Kept::new_run(ToolsGiven::Injected),
        started: long_ago,
    };
    let screen = ScreenStart::Recovered {
        restart_size: None,
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
        launch_command: None,
        observed_loss: false,
        deliveries: messages.delivery_handle(),
        state,
    };
    let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
    assert_eq!(
        handle.info().tools_state,
        facade_base::model::agent::ToolsState::Connecting
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
    let kept = Kept::new_run(ToolsGiven::Injected);
    Harness::start_kept(
        home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("agy"),
        (kept, started),
        false,
        ScreenStart::New,
    )
}

/// The agent's state, and why its CLI cannot use Facade's tools, once the actor published them.
fn tools_now(
    harness: &Harness,
) -> (
    ManagedAgentState,
    Option<facade_base::model::agent::ToolsReason>,
) {
    let info = harness.handle.info();
    (info.state, info.tools_reason)
}

/// Waits up to five seconds for the agent's state and tools' reason to read `wanted`.
async fn tools_read(
    harness: &Harness,
    wanted: (
        ManagedAgentState,
        Option<facade_base::model::agent::ToolsReason>,
    ),
) -> bool {
    tools_read_within(harness, wanted, Duration::from_secs(5)).await
}

/// Waits up to `time` for the agent's state and tools' reason to read `wanted`.
async fn tools_read_within(
    harness: &Harness,
    wanted: (
        ManagedAgentState,
        Option<facade_base::model::agent::ToolsReason>,
    ),
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
    let paste = "\x1b[200~📨 hello \x1b[201~".as_bytes();
    assert_eq!(
        harness.cli_reads(paste.len()),
        paste,
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
/// question of the CLI's, or the CLI is working. A completion beside `/mcp` leaves its command
/// unsubmitted. The start reports that the first turn may run without the tools.
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
    let started = Instant::now() - START_TIMEOUT + Duration::from_secs(8);
    let mut joined = antigravity_started(&home.join("joined"), started);
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
    let until_expired = START_TIMEOUT.saturating_sub(started.elapsed());
    assert!(
        joined
            .cli_reads_within(1, until_expired + Duration::from_secs(1))
            .is_empty(),
        "the command and completion stay available to the person"
    );
    let not_started = (
        ManagedAgentState::Error,
        Some(facade_base::model::agent::ToolsReason::NotStarted),
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
    let answer = harness
        .type_call(Typing::keys(&["1".into()]).unwrap())
        .await
        .unwrap();
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(300))
            .is_empty(),
        "scripted keys wait while the CLI shows nothing"
    );
    harness.agy_question();
    assert_eq!(
        harness.cli_reads(1),
        b"1",
        "the keys that waited reach the question"
    );
    assert_eq!(answered(answer).await, Ok(()));
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
    while tools() != facade_base::model::agent::ToolsState::Available && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        (tools(), tools_now(&harness).1),
        (facade_base::model::agent::ToolsState::Available, None),
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
/// wait once it owns the composer or its panel. They go in, in the order they came,
/// after the panel is closed.
#[tokio::test(flavor = "multi_thread")]
async fn keys_and_calls_wait_while_a_start_readies_the_tools() {
    let home = home("readyhold");
    let mut harness = antigravity(&home);
    harness.agy_input("");
    assert_eq!(harness.cli_reads(4), b"/mcp", "the start goes first");
    harness.agy_input("/mcp");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.agy_panel(false);
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

/// A person's keystroke takes over a passive startup probe, even if the CLI has not yet
/// shown an input that Facade recognizes. No probe is typed after control passes to the person.
#[tokio::test(flavor = "multi_thread")]
async fn a_person_can_type_while_tool_startup_waits_for_an_input_box() {
    let home = home("type-before-tools");
    let mut harness = antigravity(&home);
    harness.type_bytes(b"hi").await.unwrap();
    assert_eq!(harness.cli_reads_within(2, Duration::from_secs(2)), b"hi");
    harness.agy_input("");
    assert!(
        harness
            .cli_reads_within(1, Duration::from_millis(300))
            .is_empty(),
        "no automatic command follows the person's keys"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// The hold on scripted input ends at the start's bound even if no composer was found.
#[tokio::test(flavor = "multi_thread")]
async fn the_hold_ends_at_the_start_s_bound() {
    let home = home("holdbound");
    let almost = Instant::now()
        .checked_sub(START_TIMEOUT - Duration::from_secs(1))
        .expect("a clock that has run a minute");
    let mut harness = antigravity_started(&home, almost);
    let answer = harness
        .type_call(Typing::keys(&["h".into(), "i".into()]).unwrap())
        .await
        .unwrap();
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
    assert_eq!(answered(answer).await, Ok(()));
    assert!(
        tools_read(
            &harness,
            (
                ManagedAgentState::Error,
                Some(facade_base::model::agent::ToolsReason::NotStarted)
            )
        )
        .await,
        "{:?}",
        tools_now(&harness)
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// An unready panel releases the person's keys at the startup bound and reports the outcome.
#[tokio::test(flavor = "multi_thread")]
async fn an_unready_tools_panel_releases_the_person_at_the_startup_deadline() {
    let home = home("readybound");
    let started = Instant::now() - START_TIMEOUT + Duration::from_secs(8);
    let (mut open, mut closed) = (
        antigravity_started(&home.join("open"), started),
        antigravity_started(&home.join("closed"), started),
    );
    for harness in [&mut open, &mut closed] {
        harness.agy_input("");
        assert_eq!(harness.cli_reads(4), b"/mcp");
        harness.agy_input("/mcp");
        assert_eq!(harness.cli_reads(1), b"\r");
    }
    open.agy_panel(false);
    closed.agy_input("");
    for harness in [&mut open, &mut closed] {
        harness.type_bytes(b"hi").await.unwrap();
        assert!(
            harness
                .cli_reads_within(1, Duration::from_millis(200))
                .is_empty(),
            "held while the tool panel can still become ready"
        );
    }
    let not_started = (
        ManagedAgentState::Error,
        Some(facade_base::model::agent::ToolsReason::NotStarted),
    );
    for harness in [&mut open, &mut closed] {
        assert!(
            tools_read_within(
                harness,
                not_started,
                START_TIMEOUT.saturating_sub(started.elapsed()) + Duration::from_secs(10)
            )
            .await,
            "{:?}",
            tools_now(harness)
        );
        assert_eq!(harness.cli_reads(2), b"hi");
    }
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
    let kept = Kept::new_run(ToolsGiven::Injected);
    let recovered = |dir: PathBuf| ScreenStart::Recovered {
        restart_size: None,
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
        (kept, Instant::now()),
        false,
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
                ManagedAgentState::Error,
                Some(facade_base::model::agent::ToolsReason::NotStarted)
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

/// A Claude Code run with Facade's tools and YOLO on, whose CLI has drawn nothing yet.
fn claude(home: &Path, allow_auto_trust: bool) -> Harness {
    let kept = Kept::new_run(ToolsGiven::Injected);
    Harness::start_kept(
        home,
        record(ProcessState::Running, None, 80, 24),
        b"",
        Some("claude"),
        (kept, Instant::now()),
        allow_auto_trust,
        ScreenStart::New,
    )
}

impl Harness {
    /// Draws Claude Code 2.1.322's question about trusting the launch's folder, behind a hidden
    /// cursor, its selection on the answer that trusts or on the one that refuses, which it
    /// shows first.
    fn claude_trust(&mut self, trusting: bool) {
        self.cli
            .write_all(claude_trust_frame(trusting).as_bytes())
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

/// A run with permission answers Claude Code's question about trusting the launch's folder as a
/// person would (CLIS-3.3), each key once the screen has been still for a moment, as Claude
/// Code 2.1.322 loses keys that come before it draws its question again: Down once the question
/// shows, then Enter once the selection shows on the answer that trusts, never Enter alone,
/// which would end the run. It answers once: the question coming back is the person's.
#[tokio::test(flavor = "multi_thread")]
async fn an_allowed_run_answers_claude_code_s_trust_question_once_as_a_person_would() {
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

/// A CLI at work draws frame after frame, each in two pieces: the message it shows gets its Enter
/// all the same, and no Backspace.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_gets_its_enter_while_its_cli_draws_frame_after_frame() {
    for (name, opens, closes) in [
        ("busysync", "\x1b[?2026h", "\x1b[?2026l"),
        ("busyplain", "", ""),
    ] {
        let home = home(name);
        let mut harness = claude(&home, false);
        harness.plain_claude_input("", "");
        let message = harness
            .queue_probe_message("a message", Duration::from_secs(20))
            .await;
        let paste = b"\x1b[200~a message \x1b[201~";
        assert_eq!(harness.cli_reads(paste.len()), paste);
        let border = "─".repeat(80);
        let until = Instant::now() + Duration::from_secs(3);
        let mut read = Vec::new();
        let mut frames = 0;
        while read.is_empty() && Instant::now() < until {
            frames += 1;
            let first = format!("{opens}\x1b[2J\x1b[Hworking {frames}");
            harness.cli.write_all(first.as_bytes()).unwrap();
            read.extend(harness.cli_reads_within(1, Duration::from_millis(10)));
            let rest = format!("\r\n{border}\r\n❯\u{a0}a message\r\n{border}\x1b[3;12H{closes}");
            harness.cli.write_all(rest.as_bytes()).unwrap();
            read.extend(harness.cli_reads_within(1, Duration::from_millis(20)));
        }
        assert_eq!(read, b"\r", "{name}: {frames} frames drawn");
        harness.plain_claude_input("", "");
        let crate::messages::Settled::Kept(message) = probe_message_settled(message).await else {
            panic!("the message is kept");
        };
        assert_eq!(
            message.delivery.status,
            facade_base::model::message::DeliveryStatus::Success
        );
        harness.stop().await;
        std::fs::remove_dir_all(&home).unwrap();
    }
}

const SHOW_CURSOR: &[u8] = b"\x1b[?25h";
const CLAUDE_PLAIN_HINT: &str = r#"Try "refactor <filepath>""#;

/// Claude Code's workspace trust question, with the cursor hidden.
pub(super) fn claude_trust_frame(trusting: bool) -> String {
    let (refuse, trust) = if trusting {
        ("  ", "❯ ")
    } else {
        ("❯ ", "  ")
    };
    format!(
        "\x1b[2J\x1b[H\x1b[?25l Accessing workspace:\r\n\r\n /work/probe\r\n\r\n Quick safety \
         check: Is this a project you created or one you trust? (Like your own\r\n code, a \
         well-known open source project, or work from your team).\r\n\r\n Claude Code'll \
         be able to read, edit, and execute files here.\r\n\r\n \
         {refuse}No, exit\r\n {trust}Yes, I trust this folder\r\n\r\n Enter to confirm · \
         Esc to cancel"
    )
}

/// A complete frame of Claude Code's plain input with the cursor between before and after.
pub(super) fn plain_claude_frame(before: &str, after: &str) -> String {
    // Repeat the border glyph with CSI REP so two frames fit in a Darwin PTY without a read.
    let border = "─\x1b[79b";
    let column = 3 + before.chars().count();
    format!(
        "\x1b[?2004h\x1b[2J\x1b[H{border}\r\n❯\u{a0}{before}{after}\r\n{border}\x1b[2;{column}H"
    )
}

impl Harness {
    /// Draws Claude Code's plain input with the cursor between before and after.
    fn plain_claude_input(&mut self, before: &str, after: &str) {
        let frame = plain_claude_frame(before, after);
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
        Some(facade_base::model::message::DeliveryFailure::InputDraft)
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
    assert!(harness.shows(hint, Duration::from_secs(5)).await);
    let unprobed = harness.inspect().await.input;
    let first = harness
        .queue_probe_message("first message", Duration::from_secs(15))
        .await;
    assert_eq!(harness.cli_reads(1), b" ", "the fresh hint is probed");
    harness.plain_claude_input(" ", "");
    assert_eq!(harness.cli_reads(1), b"\x7f");
    harness.plain_claude_input("", hint);
    let paste = b"\x1b[200~first message \x1b[201~";
    assert_eq!(harness.cli_reads(paste.len()), paste);
    harness.plain_claude_input("first message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", hint);
    let crate::messages::Settled::Kept(first) = probe_message_settled(first).await else {
        panic!("the first message is kept");
    };
    assert_eq!(
        first.delivery.status,
        facade_base::model::message::DeliveryStatus::Success
    );
    assert_eq!(unprobed.state, InputState::Unknown, "{}", unprobed.evidence);

    // The person types the same text and presses Home. The CLI draws the same row and cursor.
    let edit = format!("{hint}\x1b[H");
    harness.type_bytes(edit.as_bytes()).await.unwrap();
    assert_eq!(harness.cli_reads(edit.len()), edit.as_bytes());
    harness.plain_claude_input("", hint);
    let second = harness
        .queue_probe_message("second message", Duration::from_secs(3))
        .await;
    assert_plain_draft_held(&mut harness, second, hint).await;
    let edited = harness.inspect().await.input;
    assert_eq!(edited.state, InputState::Draft, "{}", edited.evidence);
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

fn finish_probe_before_key(harness: &mut Harness, echo: bool) {
    harness.nothing_reaches_the_cli(Duration::from_millis(150), "the Space echo is pending");
    if echo {
        harness.plain_claude_input(" ", "");
        assert_eq!(harness.cli_reads(1), b"\x7f");
        harness.nothing_reaches_the_cli(Duration::from_millis(150), "the erase echo is pending");
        harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
    }
    assert_eq!(harness.cli_reads(1), b"x", "Space echoed: {echo}");
    if !echo {
        harness.plain_claude_input(" ", "");
        harness.nothing_reaches_the_cli(Duration::from_millis(150), "the probe already expired");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_during_a_plain_claude_hint_probe_waits_for_its_resolution() {
    for echo in [true, false] {
        let home = home("claudehintpersonkey");
        let mut harness = claude(&home, false);
        harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
        let message = harness
            .queue_probe_message("a message", Duration::from_secs(5))
            .await;
        assert_eq!(harness.cli_reads(1), b" ");

        harness.type_bytes(b"x").await.unwrap();
        finish_probe_before_key(&mut harness, echo);
        harness.plain_claude_input("x", "");
        assert_plain_draft_held(&mut harness, message, "x").await;
        harness.stop().await;
        std::fs::remove_dir_all(&home).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_during_a_plain_claude_hint_probe_waits_and_replies() {
    for echo in [true, false] {
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
        finish_probe_before_key(&mut harness, echo);
        answered(answer).await.unwrap();
        assert!(harness.messages.withdraw(1));
        assert!(matches!(
            probe_message_settled(message).await,
            crate::messages::Settled::Cancelled
        ));
        harness.stop().await;
        std::fs::remove_dir_all(&home).unwrap();
    }
}

/// What a terminal reports with nothing typed: the wheel, a move and a click of the mouse, the older
/// mouse report, the focus, a key let go and a modifier alone, as win32-input-mode and as the kitty
/// keyboard encoding report them.
const REPORTS: [&[u8]; 10] = [
    b"\x1b[<64;20;8M",
    b"\x1b[<35;20;8M",
    b"\x1b[<0;20;8M\x1b[<0;20;8m",
    b"\x1b[M #(",
    b"\x1b[I",
    b"\x1b[O",
    b"\x1b[13;28;13;0;0;1_",
    b"\x1b[16;42;0;1;16;1_\x1b[16;42;0;0;0;1_",
    b"\x1b[97;1:3u",
    b"\x1b[57441;2u",
];

impl Harness {
    /// Queues a message of `text` and reads its paste off the terminal.
    async fn message_pasted(
        &mut self,
        text: &str,
    ) -> watch::Receiver<Option<crate::messages::Settled>> {
        let message = self
            .queue_probe_message(text, Duration::from_secs(20))
            .await;
        self.cli_reads_paste(text);
        message
    }

    fn cli_reads_paste(&mut self, text: &str) {
        let paste = format!("\x1b[200~{text} \x1b[201~");
        let read = self.cli_reads(paste.len());
        assert_eq!(String::from_utf8_lossy(&read), paste);
    }

    fn nothing_reaches_the_cli(&mut self, time: Duration, why: &str) {
        let read = self.cli_reads_within(1, time);
        assert!(read.is_empty(), "{why}: {read:?}");
    }
}

async fn assert_delivered(outcome: watch::Receiver<Option<crate::messages::Settled>>) {
    let settled = probe_message_settled(outcome).await;
    let crate::messages::Settled::Kept(message) = settled else {
        panic!("the message is delivered: {settled:?}");
    };
    assert_eq!(
        message.delivery.status,
        facade_base::model::message::DeliveryStatus::Success,
        "{message:?}"
    );
}

/// A message waits while the person's paste has only begun: the CLI has part of its start, and a
/// paste of the message's would go into the middle of it.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_waits_while_the_person_s_paste_has_only_begun() {
    let home = home("splitstart");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let begun = b"\x1b[20";
    harness.type_bytes(begun).await.unwrap();
    assert_eq!(harness.cli_reads(begun.len()), begun);
    let _message = harness
        .queue_probe_message("a message", Duration::from_secs(20))
        .await;
    harness.nothing_reaches_the_cli(
        Duration::from_millis(500),
        "the rest of the paste's start is on its way",
    );
    harness.stop().await;
}

/// Keys after a person's Enter over a message wait no longer than for the message's paste, though
/// it is not known yet whether the CLI took what the Enter went over.
#[tokio::test(flavor = "multi_thread")]
async fn keys_after_a_person_s_enter_over_a_message_wait_no_longer_than_for_its_paste() {
    let home = home("enterbound");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let _message = harness.message_pasted("a message").await;
    harness.type_bytes(b"!").await.unwrap();
    assert_eq!(
        harness.cli_reads(1),
        b"!",
        "the paste holds keys up to its bound"
    );
    harness.plain_claude_input("a message!", "");
    harness.type_bytes(b"\r").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.type_bytes(b"y").await.unwrap();
    let next = harness.cli_reads_within(1, Duration::from_millis(3000));
    assert_eq!(next, b"y", "no key waits past the paste's bound");
    harness.stop().await;
}

/// An Enter of the person's over a message delivers nothing where a key of theirs that may empty
/// the input went after it before the CLI showed the input empty.
#[tokio::test(flavor = "multi_thread")]
async fn an_enter_over_a_message_and_then_ctrl_c_deliver_nothing() {
    let home = home("enterctrlc");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let message = harness.message_pasted("a message").await;
    harness.type_bytes(b"!").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"!");
    harness.plain_claude_input("a message!", "");
    harness.type_bytes(b"\r").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.type_bytes(b"\x03").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"\x03");
    harness.plain_claude_input("", "");
    let settled = probe_message_settled(message).await;
    let (crate::messages::Settled::Kept(message) | crate::messages::Settled::Withdrawn(message)) =
        settled
    else {
        panic!("the message ends: {settled:?}");
    };
    assert_eq!(
        (message.delivery.status, message.delivery.reason),
        (
            facade_base::model::message::DeliveryStatus::Failure,
            Some(facade_base::model::message::DeliveryFailure::SubmissionUnconfirmed)
        ),
        "{message:?}"
    );
    harness.stop().await;
}

/// What the person's terminal reports by itself goes through at once while a message goes in, and
/// the message is submitted all the same.
#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_s_own_reports_neither_wait_for_a_message_nor_stop_it() {
    let home = home("reports");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    for (number, report) in REPORTS.into_iter().enumerate() {
        let text = format!("message {number}");
        let message = harness.message_pasted(&text).await;
        harness.type_bytes(report).await.unwrap();
        assert_eq!(harness.cli_reads(report.len()), report);
        harness.plain_claude_input(&text, "");
        assert_eq!(
            harness.cli_reads(1),
            b"\r",
            "Enter after {:?}",
            String::from_utf8_lossy(report)
        );
        harness.plain_claude_input("", "");
        assert_delivered(message).await;
    }
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// What the person types while a message goes in waits until the CLI took the message, so that
/// Enter submits the message alone, and then follows it in the order it came.
#[tokio::test(flavor = "multi_thread")]
async fn keys_typed_while_a_message_goes_in_follow_it_once_the_cli_took_it() {
    let home = home("keysfollow");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let message = harness.message_pasted("a message").await;
    for keys in [&b"x"[..], b"\x1b[<64;20;8M", b"y"] {
        harness.type_bytes(keys).await.unwrap();
    }
    harness.plain_claude_input("a message", "");
    assert_eq!(
        harness.cli_reads(1),
        b"\r",
        "Enter goes over the message alone"
    );
    harness.type_bytes(b"z").await.unwrap();
    harness.nothing_reaches_the_cli(
        Duration::from_millis(200),
        "the input still shows the message, so the CLI may not have read its Enter",
    );
    harness.plain_claude_input("", "");
    assert_eq!(harness.cli_reads(14), b"x\x1b[<64;20;8Myz");
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// The keys held for one message go before the next one's paste, which waits until the person's
/// own draft is gone.
#[tokio::test(flavor = "multi_thread")]
async fn keys_held_for_a_message_go_before_the_message_behind_it() {
    let home = home("keysbetween");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let first = harness.message_pasted("first").await;
    let second = harness
        .queue_probe_message("second", Duration::from_secs(20))
        .await;
    harness.type_bytes(b"x").await.unwrap();
    harness.plain_claude_input("first", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_eq!(harness.cli_reads(1), b"x");
    harness.nothing_reaches_the_cli(
        Duration::from_millis(100),
        "the input does not show the person's key yet",
    );
    harness.plain_claude_input("x", "");
    harness.nothing_reaches_the_cli(Duration::from_millis(600), "the person's draft");
    harness.plain_claude_input("", "");
    harness.cli_reads_paste("second");
    harness.plain_claude_input("second", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_delivered(first).await;
    assert_delivered(second).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Held keys go on as separate as they came: an Escape let go with the key after it would reach the
/// CLI as Alt and that key.
#[tokio::test(flavor = "multi_thread")]
async fn held_keys_go_on_as_far_apart_as_they_came() {
    let home = home("keysapart");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let message = harness.message_pasted("a message").await;
    for keys in [&b"x"[..], b"\x1b", b"\x03", b"y"] {
        harness.type_bytes(keys).await.unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    let mut came = Vec::new();
    for key in [&b"x"[..], b"\x1b", b"\x03", b"y"] {
        assert_eq!(harness.cli_reads(1), key, "in the order they came");
        came.push(std::time::Instant::now());
    }
    for pair in came.windows(2) {
        assert!(
            pair[1] - pair[0] >= Duration::from_millis(30),
            "a pause between them: {:?}",
            pair[1] - pair[0]
        );
    }
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A menu or question of the CLI's own takes the person's keys at once, held ones first.
#[tokio::test(flavor = "multi_thread")]
async fn keys_for_a_question_do_not_wait_for_a_message() {
    use facade_base::model::message::{DeliveryFailure, DeliveryStatus};

    let home = home("keysquestion");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let message = harness.message_pasted("a message").await;
    harness.type_bytes(b"x").await.unwrap();
    harness.nothing_reaches_the_cli(Duration::from_millis(50), "the message goes in");
    harness.claude_trust(false);
    assert!(harness.shows("Yes, I trust", Duration::from_secs(5)).await);
    harness.type_bytes(b"\x1b[B").await.unwrap();
    assert_eq!(harness.cli_reads(4), b"x\x1b[B");
    // They went to the question: the message is still alone in the input behind it.
    harness.cli.write_all(SHOW_CURSOR).unwrap();
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    let crate::messages::Settled::Kept(message) = probe_message_settled(message).await else {
        panic!("the written paste has a retained receipt");
    };
    assert_eq!(message.delivery.status, DeliveryStatus::Failure);
    assert_eq!(
        message.delivery.reason,
        Some(DeliveryFailure::InteractionAfterWrite)
    );
    assert_eq!(message.delivery.text_written, TextWritten::Full);
    assert_eq!(message.delivery.enter_written, Some(true));
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Keys wait only so long for a message the CLI never shows.
#[tokio::test(flavor = "multi_thread")]
async fn keys_wait_a_bounded_time_for_a_message_the_cli_never_shows() {
    let home = home("keysbound");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let _message = harness.message_pasted("a message").await;
    harness.type_bytes(b"x").await.unwrap();
    harness.nothing_reaches_the_cli(Duration::from_secs(1), "the message may still show");
    assert_eq!(harness.cli_reads(1), b"x", "let go at the bound");
    harness.type_bytes(b"y").await.unwrap();
    assert_eq!(
        harness.cli_reads_within(1, Duration::from_secs(1)),
        b"y",
        "nothing waits for this message any more"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A person who restores and submits the original message delivers it
/// when the CLI draws an empty frame with only Enter between the draft and the empty frame.
/// An intervening key still goes at the paste's bound, leaving the submission unconfirmed.
#[tokio::test(flavor = "multi_thread")]
async fn a_person_s_enter_over_a_message_that_stayed_in_the_input_delivers_it() {
    for intervening_key in [false, true] {
        let home = home("enterover");
        let mut harness = claude(&home, false);
        harness.plain_claude_input("", "");
        let message = harness.message_pasted("a message").await;
        harness.type_bytes(b"!").await.unwrap();
        assert_eq!(harness.cli_reads(1), b"!", "let go at the bound");
        harness.type_bytes(b"\x7f").await.unwrap();
        assert_eq!(harness.cli_reads(1), b"\x7f");
        harness.plain_claude_input("a message", "");
        harness.type_bytes(b"\r").await.unwrap();
        if intervening_key {
            harness.type_bytes(b"y").await.unwrap();
            assert_eq!(harness.cli_reads(2), b"\ry", "the paste's bound is over");
        } else {
            assert_eq!(harness.cli_reads(1), b"\r");
        }
        harness.plain_claude_input("", "");
        if intervening_key {
            let crate::messages::Settled::Kept(kept) = probe_message_settled(message).await else {
                panic!("a message whose paste began is kept");
            };
            assert_eq!(
                kept.delivery.reason,
                Some(facade_base::model::message::DeliveryFailure::SubmissionUnconfirmed)
            );
        } else {
            assert_delivered(message).await;
        }
        harness.stop().await;
        std::fs::remove_dir_all(&home).unwrap();
    }
}

/// A person may submit a draft they edited. The resulting text cannot confirm the original message.
#[tokio::test(flavor = "multi_thread")]
async fn a_person_s_enter_over_an_edited_message_does_not_confirm_the_original() {
    use facade_base::model::message::{DeliveryFailure, DeliveryStatus};

    let home = home("enterover-edited");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let message = harness.message_pasted("a message").await;
    harness.type_bytes(b"!").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"!", "let go at the bound");
    harness.plain_claude_input("a message!", "");
    harness.type_bytes(b"\r").await.unwrap();
    assert_eq!(
        harness.cli_reads(1),
        b"\r",
        "the person can submit their draft"
    );
    harness.plain_claude_input("", "");
    let crate::messages::Settled::Kept(message) = probe_message_settled(message).await else {
        panic!("the edited paste has a receipt");
    };
    assert_eq!(message.delivery.status, DeliveryStatus::Failure);
    assert_eq!(
        message.delivery.reason,
        Some(DeliveryFailure::SubmissionUnconfirmed)
    );
    assert_eq!(message.delivery.text_written, TextWritten::Full);
    assert_eq!(message.delivery.enter_written, Some(false));
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Keys held for a message go with a run that ends, and a run that takes its place gets none.
#[tokio::test(flavor = "multi_thread")]
async fn keys_held_for_a_message_end_with_their_run() {
    let home = home("keysend");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let message = harness.message_pasted("a message").await;
    harness.type_bytes(b"x").await.unwrap();
    harness.end_run(FIRST_RUN, 0).await;
    let crate::messages::Settled::Kept(ended) = probe_message_settled(message).await else {
        panic!("a message whose paste began is kept");
    };
    assert_eq!(
        ended.delivery.reason,
        Some(facade_base::model::message::DeliveryFailure::Ended)
    );
    harness.prepare_restart(FIRST_RUN + 1, 80, 24).await;
    let (master, mut next) = raw_terminal(80, 24);
    harness.install(FIRST_RUN + 1, master).await;
    harness.type_for(FIRST_RUN + 1, b"y").await.unwrap();
    assert_eq!(
        next.reads_within(2, Duration::from_millis(500)),
        b"y",
        "the next run gets its own keys alone"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Before a newer Facade takes over, the keys held for a message reach the terminal.
#[tokio::test(flavor = "multi_thread")]
async fn held_keys_reach_the_terminal_before_a_takeover() {
    let home = home("keystakeover");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let _message = harness.message_pasted("a message").await;
    for keys in [&b"x"[..], b"\x1b", b"y"] {
        harness.type_bytes(keys).await.unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    let (reply, quiet) = oneshot::channel();
    harness.send(AgentCommand::Quiesce { reply }).await;
    tokio::time::timeout(Duration::from_secs(5), quiet)
        .await
        .expect("the agent goes quiet")
        .unwrap();
    assert_eq!(
        harness.cli_reads_within(3, Duration::from_millis(500)),
        b"x\x1by"
    );
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// Keys held for a message stay before a size the person gives after them, and keys after the size
/// stay behind them.
#[tokio::test(flavor = "multi_thread")]
async fn a_size_between_held_keys_keeps_their_order() {
    let home = home("keyssize");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let message = harness.message_pasted("a message").await;
    harness.type_bytes(b"x").await.unwrap();
    harness.send(AgentCommand::ResizeTerminal(80, 30)).await;
    harness.type_bytes(b"y").await.unwrap();
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_eq!(harness.cli_reads(2), b"xy");
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A message waits for what the person just typed to show: until then the input still reads empty.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_waits_for_keys_the_cli_has_not_drawn() {
    let home = home("keysundrawn");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    harness.type_bytes(b"x").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"x");
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(20))
        .await;
    harness.nothing_reaches_the_cli(Duration::from_millis(100), "the key is not drawn");
    harness.plain_claude_input("x", "");
    harness.nothing_reaches_the_cli(Duration::from_millis(600), "the person's draft");
    harness.plain_claude_input("", "");
    harness.cli_reads_paste("a message");
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A slow CLI still draws the line the person submitted, and then empties its input for it, while
/// their next line is on its way: a message waits for that one.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_waits_for_a_line_on_its_way_behind_the_one_shown() {
    let home = home("keysonway");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    harness.type_bytes(b"one").await.unwrap();
    assert_eq!(harness.cli_reads(3), b"one");
    harness.plain_claude_input("one", "");
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(20))
        .await;
    harness.nothing_reaches_the_cli(Duration::from_millis(100), "the person's draft");
    harness.type_bytes(b"\r").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.type_bytes(b"two").await.unwrap();
    assert_eq!(harness.cli_reads(3), b"two");
    for shown in ["one", ""] {
        harness.plain_claude_input(shown, "");
        harness.nothing_reaches_the_cli(Duration::from_millis(200), "two is on its way");
    }
    harness.plain_claude_input("two", "");
    harness.nothing_reaches_the_cli(Duration::from_millis(200), "the person's draft");
    harness.type_bytes(b"\r").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    harness.cli_reads_paste("a message");
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// An Enter of the person's that is held until its draft shows goes before a message's paste.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_waits_for_the_enter_the_person_pressed_with_their_text() {
    let home = home("enterfirst");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    harness.type_bytes(b"abc\r").await.unwrap();
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(20))
        .await;
    assert_eq!(harness.cli_reads(4), b"abc\r");
    harness.plain_claude_input("", "");
    harness.cli_reads_paste("a message");
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A message's paste never lands between the pieces of a paste of the person's.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_waits_for_the_rest_of_the_person_s_paste() {
    let home = home("pastepieces");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    let (first, rest) = (b"\x1b[200~one ", b"two\x1b[201~");
    harness.type_bytes(first).await.unwrap();
    assert_eq!(harness.cli_reads(first.len()), first);
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(20))
        .await;
    harness.nothing_reaches_the_cli(Duration::from_millis(100), "the paste goes on");
    harness.type_bytes(rest).await.unwrap();
    assert_eq!(harness.cli_reads(rest.len()), rest);
    harness.plain_claude_input("one two", "");
    harness.nothing_reaches_the_cli(Duration::from_millis(600), "the person's draft");
    harness.plain_claude_input("", "");
    harness.cli_reads_paste("a message");
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A message waiting behind the person's draft goes in as soon as the CLI took the draft.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_follows_the_person_s_submission_at_once() {
    let home = home("aftersubmission");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", "");
    harness.type_bytes(b"hi").await.unwrap();
    assert_eq!(harness.cli_reads(2), b"hi");
    harness.plain_claude_input("hi", "");
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(20))
        .await;
    harness.nothing_reaches_the_cli(Duration::from_millis(600), "the person's draft");
    harness.type_bytes(b"\r").await.unwrap();
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    let paste = b"\x1b[200~a message \x1b[201~";
    assert_eq!(
        harness.cli_reads_within(paste.len(), Duration::from_millis(250)),
        paste,
        "the empty input shows that the CLI took the person's Enter"
    );
    harness.plain_claude_input("a message", "");
    assert_eq!(harness.cli_reads(1), b"\r");
    harness.plain_claude_input("", "");
    assert_delivered(message).await;
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A report before the first message leaves a fresh run's hint to the probe: nothing was typed.
#[tokio::test(flavor = "multi_thread")]
async fn a_report_before_the_first_message_leaves_the_hint_to_the_probe() {
    let reports: &[&[&[u8]]] = &[&[b"\x1b[I"], &[b"\x1b", b"[", b"O"]];
    for packets in reports {
        let home = home("reportbeforehint");
        let mut harness = claude(&home, false);
        harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
        for packet in *packets {
            harness.type_bytes(packet).await.unwrap();
            assert_eq!(harness.cli_reads(packet.len()), *packet);
        }
        let message = harness
            .queue_probe_message("a message", Duration::from_secs(20))
            .await;
        assert_eq!(
            harness.cli_reads(1),
            b" ",
            "the hint is probed after {packets:?}"
        );
        harness.plain_claude_input(" ", "");
        assert_eq!(harness.cli_reads(1), b"\x7f");
        harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
        harness.cli_reads_paste("a message");
        harness.plain_claude_input("a message", "");
        assert_eq!(harness.cli_reads(1), b"\r");
        harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
        assert_delivered(message).await;
        harness.stop().await;
        std::fs::remove_dir_all(&home).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_report_in_the_same_packet_as_a_key_leaves_the_first_draft_alone() {
    let home = home("reportandkeybeforehint");
    let mut harness = claude(&home, false);
    harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
    let input = b"\x1b[Ix";
    harness.type_bytes(input).await.unwrap();
    assert_eq!(harness.cli_reads(input.len()), input);
    harness.plain_claude_input("", CLAUDE_PLAIN_HINT);
    let message = harness
        .queue_probe_message("a message", Duration::from_secs(3))
        .await;
    assert_plain_draft_held(&mut harness, message, CLAUDE_PLAIN_HINT).await;
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
    harness
        .send(AgentCommand::AwaitPrompt {
            text: "fix it".into(),
            ready,
        })
        .await;
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
            stopped_by: None,
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
        Some(facade_base::model::agent::ToolsReason::Ended),
    );
    assert_eq!((info.process, info.tools_state, info.tools_reason), ended);
    harness.stop().await;
    std::fs::remove_dir_all(&home).unwrap();
}

/// A recovered title changes the screen's status without showing whether cleanup reached the box.
#[tokio::test(flavor = "multi_thread")]
async fn a_status_only_read_after_a_crash_does_not_repeat_issued_cleanup() {
    recover_after_cleanup_write(CleanupRecovery {
        written: 5,
        redraw: "hello",
        expected_keys: 0,
        ..CleanupRecovery::default()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redrawn_literal_draft_gets_only_the_confirmed_cleanup_difference() {
    recover_after_cleanup_write(CleanupRecovery::default()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_confirmed_partial_cleanup_survives_the_receipt_grace() {
    recover_after_cleanup_write(CleanupRecovery {
        redraw_after_ms: 420,
        ..CleanupRecovery::default()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draw_outside_the_input_box_cannot_authorize_more_backspaces() {
    recover_after_cleanup_write(CleanupRecovery {
        outside_draw: true,
        ..CleanupRecovery::default()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_before_the_write_receipt_leaves_the_remaining_draft_alone() {
    recover_after_cleanup_write(CleanupRecovery {
        confirm_write: false,
        expected_keys: 0,
        ..CleanupRecovery::default()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unissued_cleanup_waits_for_a_full_composer_frame() {
    recover_after_cleanup_write(CleanupRecovery {
        written: 0,
        redraw: "hello",
        expected_keys: 5,
        outside_draw: true,
        ..CleanupRecovery::default()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_confirmed_unicode_short_write_keeps_its_character_count() {
    recover_after_cleanup_write(CleanupRecovery {
        text: "héllo",
        redraw: "hél",
        redraw_after_ms: 420,
        ..CleanupRecovery::default()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_next_complete_composer_frame_follows_an_unfinished_title() {
    for coalesced in [false, true] {
        recover_after_cleanup_write(CleanupRecovery {
            unfinished_title: Some(coalesced),
            ..CleanupRecovery::default()
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pi_recovery_uses_the_editors_grapheme_boundaries() {
    for (text, confirm_write, expected_keys) in [
        ("hello\u{e9}!", true, 5),
        ("helloe\u{301}!", true, 5),
        ("helloe\u{301}!", false, 0),
    ] {
        recover_after_cleanup_write(CleanupRecovery {
            cli_rule: "pi",
            text,
            redraw: "hello",
            redraw_after_ms: 420,
            confirm_write,
            initial_keys: Some(7),
            expected_keys,
            ..CleanupRecovery::default()
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pi_recovery_matches_a_canonically_equivalent_redrawn_prefix() {
    for (text, redraw) in [
        ("he\u{301}llo!", "h\u{e9}ll"),
        ("h\u{e9}llo!", "he\u{301}ll"),
    ] {
        recover_after_cleanup_write(CleanupRecovery {
            cli_rule: "pi",
            text,
            redraw,
            redraw_after_ms: 420,
            initial_keys: Some(6),
            expected_keys: 4,
            ..CleanupRecovery::default()
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_editor_finishes_a_combining_remainder_after_redraw() {
    for (text, written) in [("hello\u{e9}!?", 2), ("hello\u{e9}", 0)] {
        recover_after_cleanup_write(CleanupRecovery {
            text,
            written,
            redraw: "helloe\u{301}",
            redraw_after_ms: 420,
            expected_keys: 6,
            after_redraw: Some(("h", 1)),
            ..CleanupRecovery::default()
        })
        .await;
    }
}

struct CleanupRecovery<'a> {
    cli_rule: &'a str,
    text: &'a str,
    initial_keys: Option<usize>,
    written: usize,
    confirm_write: bool,
    redraw_after_ms: u64,
    outside_draw: bool,
    unfinished_title: Option<bool>,
    redraw: &'a str,
    expected_keys: usize,
    after_redraw: Option<(&'a str, usize)>,
}

impl Default for CleanupRecovery<'_> {
    fn default() -> Self {
        Self {
            cli_rule: "fake",
            text: "hello",
            initial_keys: None,
            written: 2,
            confirm_write: true,
            redraw_after_ms: 100,
            outside_draw: false,
            unfinished_title: None,
            redraw: "hel",
            expected_keys: 3,
            after_redraw: None,
        }
    }
}

async fn recover_after_cleanup_write(case: CleanupRecovery<'_>) {
    use super::terminal::{Terminal, TerminalEvent, TerminalWait};
    use super::typist::{BoxWrites, InputObservation, Modes, Typist};
    use crate::messages::tests::{message, messages, post_new};

    let CleanupRecovery {
        cli_rule,
        text,
        initial_keys,
        written,
        confirm_write,
        redraw_after_ms,
        outside_draw,
        unfinished_title,
        redraw,
        expected_keys,
        after_redraw,
    } = case;
    let wire = format!("{text} ");
    // The first Backspace deletes the delivery's transport space before the message body.
    let written = if written == 0 { 0 } else { written + 1 };
    let (redraw, expected_keys) = if written == 0 {
        (
            format!("{redraw} "),
            expected_keys + usize::from(expected_keys != 0),
        )
    } else {
        (redraw.to_owned(), expected_keys)
    };
    let home = home("issued-cleanup");
    let (master, mut cli) = raw_terminal(80, 24);
    let mut terminal = Terminal::new(Some(master.try_clone().unwrap())).unwrap();
    let post = messages().0;
    let (message, mut settled) = post_new(&post, message(0, "a1"));
    let number = crate::messages::number(&message);
    let start = Instant::now();
    let typing = |deadline| {
        MessageTyping::new(
            text.into(),
            number,
            deadline,
            Submission {
                text: text.into(),
                sender: Sender::person(),
            },
        )
    };
    let rule = facade_rules::find(cli_rule).unwrap().unwrap();
    let border = "─".repeat(80);
    let draw = |text: &str| {
        if cli_rule == "pi" {
            format!(
                "\x1b[1;1H\x1b[K{border}\x1b[3;1H\x1b[K{border}\x1b[2;1H\x1b[K{text}\x1b[7m \x1b[27m\x1b[D"
            )
        } else {
            format!("\r\x1b[K❯ {text}")
        }
    };
    let mut old = Typist::new("a1", Some(rule), None, post.delivery_handle());
    let mut screen = Screen::new(80, 24, SCROLLBACK_ROWS);
    let modes = Modes {
        bracketed_paste: true,
        application_cursor_keys: false,
        working_for_submission: false,
        reveal_ready: false,
    };
    let step = |old: &mut Typist, now, terminal: &mut Terminal, screen: &Screen| {
        let written = terminal.written();
        old.note_erasure_write(written);
        let step = old.step(now, written, written, modes, BoxWrites::Allowed, &|| {
            InputObservation {
                current: facade_rules::read_box(&rule.input, &screen.view()),
                native_wait: None,
                waits_for_frame: false,
                can_probe: true,
                submitted: None,
                after_write: false,
                empty_after_write: None,
                awaiting_after_interaction: false,
            }
        });
        if let Some(kind) = step.delivery {
            old.delivery_issued(kind, written, step.write.len());
        }
        step.write
    };
    let deadline = start + Duration::from_secs(1);
    old.deliver(typing(deadline));
    screen.feed(draw("").as_bytes());
    let paste = step(&mut old, start, &mut terminal, &screen);
    assert_eq!(paste, format!("\x1b[200~{wire}\x1b[201~").as_bytes());
    terminal.push(&paste);
    assert!(matches!(
        terminal
            .ready(TerminalWait::WriteOnly, |offset, count| old
                .before_write(offset, count))
            .await,
        TerminalEvent::Wrote
    ));
    assert_eq!(cli.reads_within(paste.len(), Duration::from_secs(5)), paste);

    screen.feed(draw(&wire).as_bytes());
    assert!(
        step(
            &mut old,
            start + Duration::from_millis(1),
            &mut terminal,
            &screen
        )
        .is_empty()
    );
    let cleanup = step(&mut old, deadline, &mut terminal, &screen);
    assert_eq!(
        cleanup,
        vec![0x7f; initial_keys.unwrap_or_else(|| text.chars().count()) + 1]
    );
    if written != 0 {
        terminal.push(&cleanup[..written]);
        assert!(matches!(
            terminal
                .ready(TerminalWait::WriteOnly, |offset, count| old
                    .before_write(offset, count))
                .await,
            TerminalEvent::Wrote
        ));
        if confirm_write {
            old.wrote(terminal.written());
        }
        assert_eq!(
            cli.reads_within(written, Duration::from_secs(5)),
            cleanup[..written]
        );
    }
    let saved = post.paste_messages(number).unwrap().draft.unwrap();
    let progress = saved.cleanup.unwrap();
    assert_eq!(progress.writing, !confirm_write);
    assert_eq!(
        progress.written as usize,
        if confirm_write { written } else { 0 }
    );
    assert!(settled.borrow().is_none());
    drop((terminal, old));

    // The CLI has taken the write, but the screen log still shows the full old draft.
    if outside_draw {
        // A partial repaint was in the old snapshot, before the new actor could read the box.
        screen.feed(draw(&redraw).as_bytes());
    }
    if unfinished_title.is_some() {
        screen.feed(b"\x1b]2;old title");
        assert!(screen.has_unfinished_unit());
    }
    let dir = home.join("screens").join("a1");
    let (tx, rx) = mpsc::channel(MAX_QUEUED_COMMANDS);
    let start = ActorStart {
        colors: TerminalColors::default(),
        info: record(ProcessState::Running, None, 80, 24),
        master: Some(master),
        screen: ScreenStart::Recovered {
            restart_size: None,
            handed_over_cleanly: false,
            screen: Box::new(screen),
            log: None,
        },
        untouched_input: false,
        rule: Some(cli_rule.into()),
        captures: false,
        launch_command: None,
        observed_loss: false,
        deliveries: post.delivery_handle(),
        state: StateStart {
            tools_config: None,
            file: super::state::state_file(&dir),
            kept: Kept::default(),
            started: Instant::now(),
        },
    };
    let handle = spawn(start, rx, tx, broadcast::channel(16).0).unwrap();
    let (reply, taken) = oneshot::channel();
    handle
        .mailbox()
        .send(AgentCommand::WriteInput {
            input: Input::BegunPaste {
                messages: vec![typing(Instant::now())],
                previous_text: None,
                draft: Some(saved),
            },
            run: FIRST_RUN,
            reply,
        })
        .await
        .unwrap();
    assert!(taken.await.unwrap().is_ok());
    match unfinished_title {
        None => cli.write_all(b"\x1b]2;working\x07").unwrap(),
        Some(false) => cli.write_all(b"\x07").unwrap(),
        Some(true) => {}
    }
    assert_eq!(
        cli.reads_within(5, Duration::from_millis(redraw_after_ms)),
        b"",
        "a title alone cannot show the old backspaces' effect"
    );

    if redraw_after_ms == 100 {
        assert!(settled.borrow().is_none(), "the receipt still has time");
    } else {
        tokio::time::timeout(Duration::from_secs(5), settled.wait_for(Option::is_some))
            .await
            .expect("the receipt settles before the redraw")
            .unwrap();
    }
    if outside_draw {
        cli.write_all(b"\x1b7\x1b[20;1H*\x1b8").unwrap();
        assert_eq!(
            cli.reads_within(5, Duration::from_millis(180)),
            b"",
            "painting another row cannot make the cached input box current"
        );
        cli.write_all(format!("\x1b[1;3Hhe\x1b[1;{}H", 3 + redraw.len()).as_bytes())
            .unwrap();
        assert_eq!(
            cli.reads_within(5, Duration::from_millis(40)),
            b"",
            "a partial redraw of the input cannot borrow the last letter from the snapshot"
        );
    }
    let id = format!("m{number}");
    let delivery = || post.message(&id).unwrap().delivery;
    let receipt_before_redraw = settled.borrow().is_some().then(delivery);
    let close = if unfinished_title == Some(true) {
        "\x07"
    } else {
        ""
    };
    cli.write_all(format!("{close}{}", draw(&redraw)).as_bytes())
        .unwrap();
    if expected_keys == 0 {
        assert!(cli.reads_within(5, Duration::from_millis(40)).is_empty());
    } else {
        assert_eq!(
            cli.reads_within(expected_keys, Duration::from_secs(5)),
            vec![0x7f; expected_keys],
        );
    }
    if let Some((remaining, keys)) = after_redraw {
        cli.write_all(b"\x1b]2;cleanup in progress\x07").unwrap();
        assert!(cli.reads_within(1, Duration::from_millis(100)).is_empty());
        cli.write_all(draw(&redraw).as_bytes()).unwrap();
        assert!(
            cli.reads_within(1, Duration::from_millis(100)).is_empty(),
            "a repaint of the old text cannot confirm the new keys' effect"
        );
        cli.write_all(draw(remaining).as_bytes()).unwrap();
        assert_eq!(
            cli.reads_within(keys, Duration::from_secs(5)),
            vec![0x7f; keys],
            "the current drawing proves the rest of the same paste"
        );
    }
    let empty = draw("");
    if cli_rule == "pi" && receipt_before_redraw.is_some() {
        // Split the redraw before it can paint the empty box.
        let prefix = "\x1b[1;";
        let rest = empty.strip_prefix(prefix).unwrap();
        cli.write_all(prefix.as_bytes()).unwrap();
        assert!(cli.reads_within(5, Duration::from_millis(100)).is_empty());
        assert!(post.paste_messages(number).unwrap().draft.is_some());
        cli.write_all(rest.as_bytes()).unwrap();
    } else {
        cli.write_all(empty.as_bytes()).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while post.paste_messages(number).unwrap().draft.is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a complete empty frame retires the saved cleanup");
    tokio::time::timeout(Duration::from_secs(5), settled.wait_for(Option::is_some))
        .await
        .unwrap()
        .unwrap();
    assert!(cli.reads_within(5, Duration::from_millis(100)).is_empty());
    if let Some(before) = receipt_before_redraw {
        assert_eq!(before, delivery());
    }
    Harness {
        handle,
        cli,
        dir,
        messages: post,
    }
    .stop()
    .await;
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
    let paste = b"\x1b[200~a message \x1b[201~";
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
            stopped_by: None,
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
        facade_base::model::message::DeliveryStatus::Failure,
        Some(facade_base::model::message::DeliveryFailure::Ended),
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

/// A run without permission leaves Claude Code's trust question for the person, even with YOLO on.
/// An allowed run answers that question alone: not another menu drawn the same way, not the
/// question once the CLI showed its input first, and no Enter where the selection does not show
/// on the answer that trusts.
#[tokio::test(flavor = "multi_thread")]
async fn only_an_allowed_run_answers_and_only_the_trust_question_with_its_selection_on_yes() {
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
        ViewerChange::Activity(_) | ViewerChange::Exit(..) | ViewerChange::Removed => 0,
    }
}

// Timing bounds remain behavioral expectations, independent of the module's private constants.
const REDRAW_NUDGE_TIMEOUT: Duration = Duration::from_millis(200);
const TRUST_STILL: Duration = Duration::from_secs(1);
const TRUST_SELECTED: Duration = Duration::from_secs(10);
const TRUST_GONE: Duration = Duration::from_secs(5);
