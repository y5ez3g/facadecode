//! Terminal I/O and the ordered input waiting to reach the CLI.

use std::collections::VecDeque;
use std::future::{Future, pending, poll_fn};
use std::io;
use std::sync::OnceLock;
use std::task::Poll;

use facade_base::terminal::{PtyIo, PtyMaster};
use tokio::time::Instant;

/// The most bytes one read takes from the terminal.
pub(crate) const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_WRITE_BYTES: usize = 64 * 1024;

/// What the terminal did while the actor waited on it.
pub(crate) enum TerminalEvent {
    /// Output arrived; `Terminal::output` holds it.
    Read,
    /// The CLI side closed: nothing more to read.
    Closed,
    /// Queued input was written.
    Wrote,
    /// Writing failed: the terminal takes no more input.
    WriteFailed(std::io::Error),
}

/// What `Terminal::ready` waits for.
pub(crate) enum TerminalWait {
    ReadAndWrite,
    WriteOnly,
}

/// A selected input byte and the end of the output already readable when its write was issued.
struct OutputBoundary {
    input: u64,
    before: Option<u64>,
}

impl OutputBoundary {
    fn in_write(&self, sent: u64, end: u64) -> bool {
        self.input > sent && self.input <= end
    }
}

/// The first later key that may change a pending submission's input.
struct FollowingEdit {
    boundary: OutputBoundary,
    provisional: bool,
}

struct SubmissionOrder {
    enter: OutputBoundary,
    following_edit: Option<FollowingEdit>,
}

enum IoReady {
    Issued(Option<usize>),
    Written(io::Result<usize>, Option<Option<usize>>),
    Read(io::Result<usize>),
}

/// An agent's terminal and the input waiting for it. Owned by its actor, without locks.
pub(crate) struct Terminal {
    /// None between runs and once the run's output ended.
    master: Option<PtyIo>,
    input: VecDeque<u8>,
    /// The bytes at the head of `input` that a write under way was given: the terminal may still
    /// take them, so they stay at the head until a write returns.
    writing: usize,
    sent: u64,
    last_write: Option<Instant>,
    buffer: Vec<u8>,
    received: usize,
    output_read: u64,
    paste: Option<OutputBoundary>,
    submissions: VecDeque<SubmissionOrder>,
}

impl Terminal {
    /// The terminal of `master`; none for an agent whose terminal closed.
    pub(crate) fn new(master: Option<PtyMaster>) -> anyhow::Result<Terminal> {
        let mut terminal = Self {
            master: None,
            input: VecDeque::new(),
            writing: 0,
            sent: 0,
            last_write: None,
            buffer: Vec::new(),
            received: 0,
            output_read: 0,
            paste: None,
            submissions: VecDeque::new(),
        };
        if let Some(master) = master {
            terminal.install(master)?;
        }
        Ok(terminal)
    }

    /// Takes a resumed run's master in place of none, without waiting or taking locks.
    pub(crate) fn install(&mut self, master: PtyMaster) -> anyhow::Result<()> {
        self.master = Some(PtyIo::new(master)?);
        self.received = 0;
        self.output_read = 0;
        self.paste = None;
        self.stop_observing_submission();
        Ok(())
    }

    /// Lets go of the master, as the run's output ends or a resume begins, and of what the run
    /// left: its queued input is dropped.
    pub(crate) fn detach(&mut self) {
        self.master = None;
        self.writing = 0;
        self.input = VecDeque::new();
        self.buffer = Vec::new();
        self.received = 0;
        self.output_read = 0;
        self.paste = None;
        self.stop_observing_submission();
    }

    /// Waits until output can be read (only with `ReadAndWrite`) or queued input can be written, and does one of them.
    /// Pending forever while there is nothing to do. Safe to cancel in `select!`; takes no locks.
    pub(crate) async fn ready(&mut self, wait: TerminalWait) -> TerminalEvent {
        let read = matches!(wait, TerminalWait::ReadAndWrite);
        loop {
            let read_size = self.read_limit();
            let Some(master) = self.master.as_ref() else {
                return pending().await;
            };
            if read {
                self.buffer.resize(read_size, 0);
            }
            // A write under way is given the same bytes again until it returns.
            if self.input.as_slices().0.len() < self.writing {
                self.input.make_contiguous();
            }
            let (head, _) = self.input.as_slices();
            let head = match self.writing {
                0 => &head[..head.len().min(MAX_WRITE_BYTES)],
                writing => &head[..writing],
            };
            self.writing = head.len();
            let end = self.sent + head.len() as u64;
            let watch = self
                .output_boundaries()
                .any(|boundary| boundary.in_write(self.sent, end));
            let started = OnceLock::new();
            let write = async {
                let mut writing = std::pin::pin!(master.write(head, watch.then_some(&started)));
                poll_fn(|cx| match writing.as_mut().poll(cx) {
                    Poll::Ready(result) => {
                        Poll::Ready(IoReady::Written(result, started.get().copied()))
                    }
                    Poll::Pending => started.get().map_or(Poll::Pending, |&prefix| {
                        Poll::Ready(IoReady::Issued(prefix))
                    }),
                })
                .await
            };
            let event = tokio::select! {
                // A write that is done counts before the output's end lets go of the terminal.
                biased;
                event = write, if !head.is_empty() => event,
                result = master.read(&mut self.buffer), if read => IoReady::Read(result),
                else => pending().await,
            };
            match event {
                IoReady::Issued(prefix) => self.mark_output(end, prefix),
                IoReady::Written(result, prefix) => {
                    self.writing = 0;
                    let n = match result {
                        Ok(n) => n,
                        Err(error) => return TerminalEvent::WriteFailed(error),
                    };
                    let written = self.sent + n as u64;
                    if let Some(prefix) = prefix {
                        self.mark_output(written, prefix);
                    }
                    for boundary in
                        self.paste
                            .iter_mut()
                            .chain(self.submissions.iter_mut().flat_map(|submission| {
                                std::iter::once(&mut submission.enter).chain(
                                    submission
                                        .following_edit
                                        .iter_mut()
                                        .map(|edit| &mut edit.boundary),
                                )
                            }))
                    {
                        if boundary.in_write(written, end) {
                            boundary.before = None;
                        }
                    }
                    self.input.drain(..n);
                    self.sent = written;
                    self.last_write = Some(Instant::now());
                    return TerminalEvent::Wrote;
                }
                IoReady::Read(Ok(n)) if n > 0 => {
                    self.record_read(n);
                    return TerminalEvent::Read;
                }
                IoReady::Read(_) => {
                    self.detach();
                    return TerminalEvent::Closed;
                }
            }
        }
    }

    /// A read ends at an input write's output boundary before it starts on the other side.
    fn read_limit(&self) -> usize {
        self.output_boundaries()
            .filter_map(|boundary| boundary.before)
            .filter(|before| *before > self.output_read)
            .map(|before| (before - self.output_read).min(MAX_READ_BYTES as u64) as usize)
            .min()
            .unwrap_or(MAX_READ_BYTES)
    }

    fn output_boundaries(&self) -> impl Iterator<Item = &OutputBoundary> {
        self.paste
            .iter()
            .chain(self.submissions.iter().flat_map(|submission| {
                std::iter::once(&submission.enter)
                    .chain(submission.following_edit.iter().map(|edit| &edit.boundary))
            }))
    }

    fn mark_output(&mut self, end: u64, prefix: Option<usize>) {
        let before = prefix.map(|n| self.output_read + n as u64);
        if let Some(paste) = &mut self.paste
            && paste.in_write(self.sent, end)
        {
            paste.before = before;
        }
        for submission in &mut self.submissions {
            if submission.enter.in_write(self.sent, end) {
                submission.enter.before = before;
            }
            if let Some(edit) = &mut submission.following_edit
                && edit.boundary.in_write(self.sent, end)
            {
                // If the prefix could not be sampled, only output already read precedes the edit.
                edit.boundary.before = Some(before.unwrap_or(self.output_read));
            }
        }
    }

    fn record_read(&mut self, count: usize) {
        self.received = count;
        self.output_read += count as u64;
    }

    /// One read that does not wait: how many bytes it brought, or None when nothing is there or the terminal closed.
    pub(crate) fn read_now(&mut self) -> Option<usize> {
        let read_size = self.read_limit();
        let master = self.master.as_ref()?;
        self.buffer.resize(read_size, 0);
        match master.try_read(&mut self.buffer) {
            Ok(n) if n > 0 => {
                self.record_read(n);
                Some(n)
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => None,
            _ => {
                self.detach();
                None
            }
        }
    }

    /// Leaves no read under way: how many bytes the read it ended brought, which `output` then
    /// holds, or None once no read is under way and no byte is kept, or with no master. Called
    /// until it gives None. A failure lets go of the master, as a failed read does.
    pub(crate) async fn stop_reading(&mut self) -> Option<usize> {
        let read_size = self.read_limit();
        let master = self.master.as_mut()?;
        self.buffer.resize(read_size, 0);
        match master.stop_reading(&mut self.buffer).await {
            Ok(0) => None,
            Ok(n) => {
                self.record_read(n);
                Some(n)
            }
            Err(_) => {
                self.detach();
                None
            }
        }
    }

    /// Lets go of the terminal's signal pipe ahead of a stop; reading and writing go on. Nothing
    /// with no master.
    pub(crate) fn let_go_before_stop(&mut self) {
        if let Some(master) = &mut self.master {
            master.let_go_before_stop();
        }
    }

    /// What the last `TerminalEvent::Read`, `read_now` or `stop_reading` brought.
    pub(crate) fn output(&self) -> &[u8] {
        &self.buffer[..self.received]
    }

    /// Whether there is a master.
    pub(crate) fn is_open(&self) -> bool {
        self.master.is_some()
    }

    /// Whether nothing more can be read: no master.
    pub(crate) fn is_closed(&self) -> bool {
        !self.is_open()
    }

    /// Queues input after what waits, without writing or waiting.
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        self.input.extend(bytes);
    }

    /// Drops the queued input, but for what a write under way was given.
    pub(crate) fn clear(&mut self) {
        self.input.truncate(self.writing);
        self.paste = None;
        self.stop_observing_submission();
    }

    /// Bytes queued and not yet written.
    pub(crate) fn queued(&self) -> usize {
        self.input.len()
    }

    /// Bytes written since the actor started, including earlier runs.
    pub(crate) fn written(&self) -> u64 {
        self.sent
    }

    /// When input was last written.
    pub(crate) fn written_at(&self) -> Option<Instant> {
        self.last_write
    }

    /// Establish an output boundary when the write that starts a paste is issued.
    pub(crate) fn observe_paste_from(&mut self, first: u64) {
        debug_assert!(first > self.sent);
        self.paste = Some(OutputBoundary {
            input: first,
            before: None,
        });
    }

    /// Establish an output boundary when the write that includes the pending Enter is issued.
    pub(crate) fn observe_output_after(&mut self, through: u64) {
        debug_assert!(through > self.sent);
        self.submissions.push_back(SubmissionOrder {
            enter: OutputBoundary {
                input: through,
                before: None,
            },
            following_edit: None,
        });
    }

    pub(crate) fn stop_observing_submission(&mut self) {
        self.submissions.clear();
    }

    /// The oldest submitted Enter's eligible output has been considered.
    pub(crate) fn finish_observing_submission(&mut self, through: u64) {
        let done = self.submissions.pop_front();
        debug_assert!(done.is_none_or(|submission| submission.enter.input == through));
    }

    /// Keeps the prefix already readable at the first following edit's actual write issue.
    pub(crate) fn observe_following_edit(&mut self, first: u64, provisional: bool) {
        debug_assert!(first > self.sent);
        if let Some(submission) = self.submissions.back_mut() {
            submission.following_edit.get_or_insert(FollowingEdit {
                boundary: OutputBoundary {
                    input: first,
                    before: None,
                },
                provisional,
            });
        }
    }

    /// The pending sequence was classified as a key, including a standalone Escape.
    pub(crate) fn confirm_following_edit(&mut self) {
        if let Some(edit) = self
            .submissions
            .back_mut()
            .and_then(|s| s.following_edit.as_mut())
        {
            edit.provisional = false;
        }
    }

    /// The pending sequence was a report. Any subsequent edit gets its own boundary.
    pub(crate) fn forget_provisional_edit(&mut self) {
        if let Some(submission) = self.submissions.back_mut() {
            submission.following_edit.take_if(|edit| edit.provisional);
        }
    }

    pub(crate) fn next_edit_is_provisional(&self) -> bool {
        self.submissions
            .front()
            .and_then(|s| s.following_edit.as_ref())
            .is_some_and(|edit| edit.provisional)
    }

    pub(crate) fn output_before_following_edit(&self) -> Option<u64> {
        self.submissions
            .front()?
            .following_edit
            .as_ref()?
            .boundary
            .before
    }

    fn latest_output_follows(&self, boundary: &OutputBoundary) -> bool {
        boundary
            .before
            .is_some_and(|before| self.output_read - self.received as u64 >= before)
    }

    /// Whether the latest read is on this side of the active paste's write.
    pub(crate) fn output_follows_paste(&self) -> bool {
        self.paste
            .as_ref()
            .is_some_and(|paste| self.latest_output_follows(paste))
    }

    /// Whether the latest read lacks proof it follows the issue of the tracked Enter.
    pub(crate) fn output_precedes_submission(&self) -> bool {
        self.submissions
            .back()
            .is_some_and(|submission| !self.latest_output_follows(&submission.enter))
    }

    pub(crate) fn output_follows_first_submission(&self) -> bool {
        self.submissions
            .front()
            .is_some_and(|submission| self.latest_output_follows(&submission.enter))
    }

    /// A draft drawn between two Enters can be evidence for the later one.
    pub(crate) fn output_between_submissions(&self) -> bool {
        let Some(first) = self.submissions.front() else {
            return false;
        };
        self.submissions.get(1).is_some_and(|next| {
            first.following_edit.as_ref().is_some_and(|edit| {
                edit.boundary.input == next.enter.input
                    && self.latest_output_follows(&first.enter)
                    && edit
                        .boundary
                        .before
                        .is_none_or(|before| self.output_read <= before)
            })
        })
    }

    /// Marks an unfinished frame when this read starts just past an Enter's output prefix.
    pub(crate) fn read_starts_at_submission(&self) -> bool {
        let start = self.output_read - self.received as u64;
        self.submissions
            .iter()
            .any(|s| s.enter.before == Some(start))
    }

    pub(crate) fn output_position(&self) -> u64 {
        self.output_read
    }

    /// Whether the observed frame followed the issue of this Enter's write.
    pub(crate) fn submission_issued_before(&self, through: u64, frame: u64) -> bool {
        self.submissions.front().is_some_and(|submission| {
            let enter = &submission.enter;
            enter.input == through && enter.before.is_some_and(|before| frame > before)
        })
    }

    /// Sets the terminal's size immediately; nothing without a master. Takes no locks.
    pub(crate) fn set_size(&self, cols: u16, rows: u16) {
        if let Some(master) = &self.master {
            master.set_size(cols, rows);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use facade_base::terminal::{TestCli, test_terminal};

    use super::*;

    fn opened() -> (Terminal, TestCli) {
        let (master, cli) = test_terminal(80, 24).unwrap();
        (Terminal::new(Some(master)).unwrap(), cli)
    }

    /// Whether nothing of the run is left: no handle of its terminal, no input, no buffer.
    fn let_go(terminal: &Terminal) -> bool {
        !terminal.is_open()
            && terminal.is_closed()
            && (terminal.input.capacity(), terminal.buffer.capacity()) == (0, 0)
    }

    /// The terminal's next event, or a failure after 10 seconds.
    async fn next(terminal: &mut Terminal) -> TerminalEvent {
        let event = terminal.ready(TerminalWait::ReadAndWrite);
        tokio::time::timeout(Duration::from_secs(10), event)
            .await
            .expect("an event")
    }

    #[tokio::test]
    async fn a_terminal_is_let_go_of_as_its_output_ends() {
        let (mut terminal, mut cli) = opened();
        cli.write_output(b"last words").unwrap();
        terminal.push(b"never read");
        drop(cli);
        let mut read = Vec::new();
        loop {
            assert!(terminal.is_open(), "open until its output was read");
            match next(&mut terminal).await {
                TerminalEvent::Read => read.extend_from_slice(terminal.output()),
                TerminalEvent::Closed => break,
                TerminalEvent::Wrote => {}
                TerminalEvent::WriteFailed(_) => terminal.clear(),
            }
        }
        assert_eq!(read, b"last words");
        assert!(let_go(&terminal));
    }

    #[tokio::test]
    async fn queued_input_goes_on_while_earlier_output_waits_to_be_read() {
        let (mut terminal, mut cli) = opened();
        let waits = tokio::time::timeout(
            Duration::from_millis(10),
            terminal.ready(TerminalWait::ReadAndWrite),
        );
        assert!(waits.await.is_err(), "arm a read before the earlier output");
        cli.write_output(b"earlier output").unwrap();
        terminal.push(b"\r");
        terminal.observe_output_after(1);
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Wrote));
        cli.write_output(b"newer output").unwrap();

        terminal.push(b"new input");
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Wrote));
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Read));
        assert_eq!(terminal.output(), b"earlier output");
        assert!(terminal.output_precedes_submission());
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Read));
        assert_eq!(terminal.output(), b"newer output");
        assert!(!terminal.output_precedes_submission());
    }

    /// Issues a tracked Enter in a full pipe, drains it, and leaves the CLI's reply waiting.
    #[cfg(windows)]
    async fn pending_enter() -> (Terminal, TestCli) {
        let (mut terminal, mut cli) = opened();
        let mut input = vec![b'x'; 2 * MAX_WRITE_BYTES];
        *input.last_mut().unwrap() = b'\r';
        terminal.push(&input);
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Wrote));
        assert_eq!(terminal.written(), MAX_WRITE_BYTES as u64);
        terminal.observe_output_after(input.len() as u64);
        let waiting = tokio::time::timeout(
            Duration::from_millis(20),
            terminal.ready(TerminalWait::WriteOnly),
        );
        assert!(waiting.await.is_err(), "the marked write is pending");

        let mut received = vec![0; input.len()];
        let mut read = 0;
        while read < received.len() {
            let n = cli.read_input(&mut received[read..]).unwrap();
            assert!(n > 0);
            read += n;
        }
        assert_eq!(received, input);
        cli.write_output(b"\x1b[H\x1b[2K").unwrap();
        (terminal, cli)
    }

    /// The reply can already be readable when the original write result is collected.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_to_a_pending_enter_is_after_that_write() {
        let (mut terminal, _cli) = pending_enter().await;
        let completion = tokio::time::timeout(
            Duration::from_secs(5),
            terminal.ready(TerminalWait::WriteOnly),
        )
        .await
        .expect("the CLI took the tracked Enter");
        assert!(matches!(completion, TerminalEvent::Wrote));
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Read));
        assert_eq!(terminal.output(), b"\x1b[H\x1b[2K");
        assert!(!terminal.output_precedes_submission());
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_pending_enter_can_be_confirmed_before_collecting_its_write() {
        let (mut terminal, _cli) = pending_enter().await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while terminal.read_now().is_none() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the reply is readable without collecting the write");
        assert_eq!(terminal.written(), MAX_WRITE_BYTES as u64);
        assert_eq!(terminal.output(), b"\x1b[H\x1b[2K");
        assert!(
            terminal
                .submission_issued_before(2 * MAX_WRITE_BYTES as u64, terminal.output_position())
        );
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Wrote));
    }

    /// A write waits while the CLI reads nothing. What the CLI read before it closed was written.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_write_that_is_done_counts_before_the_output_s_end() {
        for _ in 0..20 {
            let (mut terminal, mut cli) = opened();
            // The terminal holds the first of two writes while the CLI reads nothing.
            terminal.push(&[b'x'; 2 * MAX_WRITE_BYTES]);
            assert!(matches!(next(&mut terminal).await, TerminalEvent::Wrote));
            let waits = tokio::time::timeout(
                Duration::from_millis(20),
                terminal.ready(TerminalWait::ReadAndWrite),
            );
            assert!(waits.await.is_err(), "the second write waits");
            let mut left = 2 * MAX_WRITE_BYTES;
            let mut input = vec![0; MAX_WRITE_BYTES];
            while left > 0 {
                left -= cli.read_input(&mut input).unwrap();
            }
            drop(cli);
            // Both the write and the output's end are there.
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(matches!(next(&mut terminal).await, TerminalEvent::Wrote));
            assert_eq!(terminal.written(), 2 * MAX_WRITE_BYTES as u64);
            assert!(matches!(next(&mut terminal).await, TerminalEvent::Closed));
            assert!(let_go(&terminal));
        }
    }

    #[tokio::test]
    async fn a_read_that_does_not_wait_lets_go_of_an_ended_terminal() {
        let (mut terminal, mut cli) = opened();
        cli.write_output(b"last words").unwrap();
        drop(cli);
        let mut read = Vec::new();
        let ended = async {
            while terminal.is_open() {
                if terminal.read_now().is_some() {
                    read.extend_from_slice(terminal.output());
                }
                tokio::task::yield_now().await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), ended)
            .await
            .expect("let go of at its end");
        assert_eq!(read, b"last words");
        assert!(let_go(&terminal));
    }
}
