//! Terminal I/O and the ordered input waiting to reach the CLI.

use std::collections::VecDeque;
use std::future::{Future, pending, poll_fn};
use std::io;
use std::sync::OnceLock;
use std::task::Poll;

use facade_base::terminal::{PtyIo, PtyMaster, WriteCheck};
use tokio::time::Instant;

/// The most bytes one read takes from the terminal.
pub(crate) const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_WRITE_BYTES: usize = 64 * 1024;

/// What the terminal did while the actor waited on it.
pub(crate) enum TerminalEvent {
    /// Output arrived; `Terminal::output` holds it.
    Read,
    /// The CLI side closed: nothing more to read.
    Closed { checking_delivery: bool },
    /// The terminal failed to return output.
    ReadFailed(io::Error),
    /// Queued input was written.
    Wrote,
    /// The candidate erase needs a new complete input reading before any write.
    ProbeEraseNeedsCheck { automatic: bool },
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

struct ProbeWrite {
    boundary: OutputBoundary,
    issued: bool,
    classifying_key: bool,
}

struct ProbeErase {
    through: u64,
    output_read: Option<u64>,
    issued: bool,
    automatic: bool,
    classifying_key: bool,
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

/// How far to read before deciding a delivery receipt.
#[derive(Clone, Copy)]
enum DeliveryOutput {
    Through(u64),
    ToEof,
}

enum IoReady {
    Issued(Option<usize>),
    Written(io::Result<Option<usize>>, Option<Option<usize>>),
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
    /// Position in the input queue, including an optional erase retired without a write.
    sent: u64,
    #[cfg(test)]
    written: u64,
    last_write: Option<Instant>,
    buffer: Vec<u8>,
    received: usize,
    output_read: u64,
    delivery_output: Option<DeliveryOutput>,
    paste: Option<OutputBoundary>,
    probe: Option<ProbeWrite>,
    probe_erase: Option<ProbeErase>,
    cleanup: Option<OutputBoundary>,
    submissions: VecDeque<SubmissionOrder>,
    /// The current automatic submission or erase, with the first external key after it.
    delivery_write: Option<SubmissionOrder>,
}

impl Terminal {
    /// The terminal of `master`; none for an agent whose terminal closed.
    pub(crate) fn new(master: Option<PtyMaster>) -> anyhow::Result<Terminal> {
        let mut terminal = Self {
            master: None,
            input: VecDeque::new(),
            writing: 0,
            sent: 0,
            #[cfg(test)]
            written: 0,
            last_write: None,
            buffer: Vec::new(),
            received: 0,
            output_read: 0,
            delivery_output: None,
            paste: None,
            probe: None,
            probe_erase: None,
            cleanup: None,
            submissions: VecDeque::new(),
            delivery_write: None,
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
        self.delivery_output = None;
        self.paste = None;
        self.probe = None;
        self.probe_erase = None;
        self.cleanup = None;
        self.delivery_write = None;
        self.stop_observing_submission();
        Ok(())
    }

    /// Lets go of the master and the run's input observations on failure or before a resume.
    pub(crate) fn detach(&mut self) {
        self.close_io();
        self.output_read = 0;
        self.clear();
    }

    /// Drops the closed terminal and its unwritten input. Already observed frames still use
    /// their original write boundaries until the actor settles them.
    fn close_io(&mut self) {
        self.master = None;
        self.writing = 0;
        self.input = VecDeque::new();
        self.buffer = Vec::new();
        self.received = 0;
        self.probe = None;
        self.probe_erase = None;
        self.delivery_output = None;
    }

    /// Waits until output can be read (only with `ReadAndWrite`) or queued input can be written, and does one of them.
    /// Pending forever with nothing to do. Safe to cancel in `select!`. The write fence can
    /// persist cleanup progress before the terminal issues any bytes.
    pub(crate) async fn ready(
        &mut self,
        wait: TerminalWait,
        mut before_write: impl FnMut(u64, usize) -> bool,
    ) -> TerminalEvent {
        let read = matches!(wait, TerminalWait::ReadAndWrite);
        loop {
            let read_size = self.read_limit();
            let Some(master) = self.master.as_ref() else {
                return pending().await;
            };
            if read {
                self.buffer.resize(read_size, 0);
            }
            let erasing = self
                .probe_erase
                .as_ref()
                .filter(|erase| erase.through == self.sent + 1);
            if let Some(erase) = erasing
                && !erase.issued
                && !erase.classifying_key
                && erase.output_read != Some(self.output_read)
            {
                return self.probe_erase_needs_check();
            }
            let guarded = erasing.is_some();
            // A write under way is given the same bytes again until it returns.
            if self.input.as_slices().0.len() < self.writing {
                self.input.make_contiguous();
            }
            let (head, _) = self.input.as_slices();
            let head = match self.writing {
                0 => &head[..head.len().min(self.write_limit())],
                writing => &head[..writing],
            };
            self.writing = head.len();
            let end = self.sent + head.len() as u64;
            let watch = self
                .output_boundaries()
                .any(|boundary| boundary.in_write(self.sent, end));
            let started = OnceLock::new();
            let offset = self.sent;
            let write = async {
                if !guarded && !before_write(offset, head.len()) {
                    return IoReady::Written(
                        Err(io::Error::other(
                            "could not save paste cleanup before writing",
                        )),
                        None,
                    );
                }
                let mut writing = std::pin::pin!(async {
                    if guarded {
                        master
                            .write_checked(
                                head,
                                WriteCheck {
                                    defer_for_output: true,
                                    issued: &started,
                                    deadline: None,
                                },
                            )
                            .await
                    } else {
                        master
                            .write(head, watch.then_some(&started))
                            .await
                            .map(Some)
                    }
                });
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
                IoReady::Issued(prefix) => {
                    if guarded {
                        self.issue_probe_erase();
                    }
                    self.mark_output(end, prefix);
                }
                IoReady::Written(result, prefix) => {
                    self.writing = 0;
                    let n = match result {
                        Ok(Some(n)) => n,
                        Ok(None) => return self.probe_erase_needs_check(),
                        Err(error) => return TerminalEvent::WriteFailed(error),
                    };
                    let written = self.sent + n as u64;
                    if let Some(prefix) = prefix {
                        if guarded && n > 0 {
                            self.issue_probe_erase();
                        }
                        self.mark_output(written, prefix);
                    }
                    if let Some(probe) = &mut self.probe
                        && probe.boundary.in_write(written, end)
                    {
                        probe.issued = false;
                        probe.boundary.before = None;
                    }
                    for boundary in self.paste.iter_mut().chain(&mut self.cleanup).chain(
                        self.submissions
                            .iter_mut()
                            .chain(self.delivery_write.iter_mut())
                            .flat_map(|submission| {
                                std::iter::once(&mut submission.enter).chain(
                                    submission
                                        .following_edit
                                        .iter_mut()
                                        .map(|edit| &mut edit.boundary),
                                )
                            }),
                    ) {
                        if boundary.in_write(written, end) {
                            boundary.before = None;
                        }
                    }
                    self.input.drain(..n);
                    self.sent = written;
                    if guarded && n > 0 {
                        self.probe_erase = None;
                    }
                    #[cfg(test)]
                    {
                        self.written += n as u64;
                    }
                    self.last_write = Some(Instant::now());
                    return TerminalEvent::Wrote;
                }
                IoReady::Read(result) => return self.take_read(result),
            }
        }
    }

    fn probe_erase_needs_check(&mut self) -> TerminalEvent {
        let erase = self.probe_erase.as_ref().expect("guarded probe erase");
        debug_assert!(!erase.issued);
        self.writing = 0;
        TerminalEvent::ProbeEraseNeedsCheck {
            automatic: erase.automatic,
        }
    }

    fn issue_probe_erase(&mut self) {
        let erase = self.probe_erase.as_mut().expect("guarded probe erase");
        debug_assert!(!erase.issued);
        erase.issued = true;
        let through = erase.through;
        if erase.automatic {
            self.observe_probe_from(through);
        }
    }

    pub(super) fn refresh_probe_erase(&mut self) {
        let erase = self.probe_erase.as_mut().expect("guarded probe erase");
        erase.output_read = Some(self.output_read);
    }

    /// Retires the offered byte without changing the positions of later keys.
    pub(super) fn cancel_probe_erase(&mut self) {
        if let Some(erase) = self.probe_erase.take() {
            debug_assert_eq!(erase.through, self.sent + 1);
            debug_assert!(!erase.issued);
            self.input.pop_front();
            self.sent = erase.through;
        }
    }

    /// A probe key is issued on its own, so a short write of earlier bytes cannot issue it.
    fn write_limit(&self) -> usize {
        let limit = self.probe_erase.as_ref().map_or(MAX_WRITE_BYTES, |erase| {
            let earlier = erase.through - self.sent - 1;
            if earlier == 0 {
                usize::from(!erase.classifying_key)
            } else {
                earlier.min(MAX_WRITE_BYTES as u64) as usize
            }
        });
        let Some(probe) = self.probe.as_ref().filter(|probe| !probe.issued) else {
            return limit;
        };
        let earlier = probe.boundary.input - self.sent - 1;
        if earlier == 0 {
            usize::from(!probe.classifying_key)
        } else {
            earlier.min(limit as u64) as usize
        }
    }

    fn take_read(&mut self, result: io::Result<usize>) -> TerminalEvent {
        match result {
            Ok(n) if n > 0 => {
                self.record_read(n);
                TerminalEvent::Read
            }
            Ok(_) => {
                let checking_delivery = self.delivery_output.is_some();
                self.close_io();
                TerminalEvent::Closed { checking_delivery }
            }
            Err(error) => {
                self.detach();
                TerminalEvent::ReadFailed(error)
            }
        }
    }

    /// A read ends at an input write's output boundary or the end of a sampled ready prefix.
    fn read_limit(&self) -> usize {
        let delivery_end = match self.delivery_output {
            Some(DeliveryOutput::Through(end)) => Some(end),
            _ => None,
        };
        self.output_boundaries()
            .filter_map(|boundary| boundary.before)
            .chain(delivery_end)
            .filter(|before| *before > self.output_read)
            .map(|before| (before - self.output_read).min(MAX_READ_BYTES as u64) as usize)
            .min()
            .unwrap_or(MAX_READ_BYTES)
    }

    fn output_boundaries(&self) -> impl Iterator<Item = &OutputBoundary> {
        self.paste
            .iter()
            .chain(self.probe.iter().map(|probe| &probe.boundary))
            .chain(&self.cleanup)
            .chain(
                self.submissions
                    .iter()
                    .chain(self.delivery_write.iter())
                    .flat_map(|submission| {
                        std::iter::once(&submission.enter)
                            .chain(submission.following_edit.iter().map(|edit| &edit.boundary))
                    }),
            )
    }

    fn mark_output(&mut self, end: u64, prefix: Option<usize>) {
        let before = prefix.map(|n| self.output_read + n as u64);
        for boundary in self.paste.iter_mut().chain(&mut self.cleanup) {
            if boundary.in_write(self.sent, end) {
                boundary.before = before;
            }
        }
        if let Some(probe) = &mut self.probe
            && probe.boundary.in_write(self.sent, end)
        {
            probe.issued = true;
            probe.boundary.before = before;
        }
        for submission in self
            .submissions
            .iter_mut()
            .chain(self.delivery_write.iter_mut())
        {
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

    /// Samples bytes already readable without waiting. A closed peer may have left output behind,
    /// so its remaining bytes are read through EOF.
    pub(super) fn sample_ready_delivery_output(&mut self) -> io::Result<()> {
        if self.delivery_output.is_none() {
            let ready = if self.is_open() {
                self.queued_output_bytes()
            } else {
                Ok(0)
            };
            self.delivery_output = Some(match ready {
                Ok(bytes) => DeliveryOutput::Through(self.output_read + bytes as u64),
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => DeliveryOutput::ToEof,
                Err(error) => return Err(error),
            });
        }
        Ok(())
    }

    pub(super) fn delivery_output_pending(&self) -> bool {
        match self.delivery_output {
            Some(DeliveryOutput::Through(end)) => self.output_read < end,
            Some(DeliveryOutput::ToEof) => true,
            None => false,
        }
    }

    pub(super) fn finish_delivery_output(&mut self) {
        self.delivery_output = None;
    }

    /// One read that does not wait: how many bytes it brought, or None when nothing is there or the terminal closed.
    pub(crate) fn read_now(&mut self) -> Option<usize> {
        self.try_read_now(MAX_READ_BYTES).ok().flatten()
    }

    pub(super) fn queued_output_bytes(&self) -> io::Result<usize> {
        self.master
            .as_ref()
            .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?
            .queued_output_bytes()
    }

    /// Reads at most the remainder of a previously sampled output prefix.
    pub(super) fn try_read_now(&mut self, limit: usize) -> io::Result<Option<usize>> {
        let read_size = self.read_limit().min(limit);
        let Some(master) = self.master.as_ref() else {
            return Ok(None);
        };
        self.buffer.resize(read_size, 0);
        match master.try_read(&mut self.buffer) {
            Ok(0) => {
                self.close_io();
                Ok(None)
            }
            Ok(n) => {
                self.record_read(n);
                Ok(Some(n))
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => {
                self.detach();
                Err(error)
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
        if self
            .probe_erase
            .as_ref()
            .is_some_and(|erase| erase.through == self.sent + 1 && !erase.issued)
        {
            self.writing = 0;
        }
        self.input.truncate(self.writing);
        self.delivery_output = None;
        self.paste = None;
        self.probe = None;
        self.probe_erase = None;
        self.cleanup = None;
        self.delivery_write = None;
        self.stop_observing_submission();
    }

    /// Bytes queued and not yet written.
    pub(crate) fn queued(&self) -> usize {
        self.input.len()
    }

    /// The input queue position, including any canceled probe erase.
    pub(crate) fn input_through(&self) -> u64 {
        self.sent
    }

    /// Bytes physically written since the actor started, including earlier runs.
    #[cfg(test)]
    pub(crate) fn written(&self) -> u64 {
        self.written
    }

    /// When input was last written.
    pub(crate) fn written_at(&self) -> Option<Instant> {
        self.last_write
    }

    /// Establish an output boundary when the write that starts a paste is issued.
    pub(crate) fn observe_paste_from(&mut self, first: u64) {
        debug_assert!(first > self.sent);
        self.delivery_write = None;
        self.paste = Some(OutputBoundary {
            input: first,
            before: None,
        });
    }

    /// Separates earlier output from frames drawn after the next probe key is issued.
    pub(super) fn observe_probe_from(&mut self, first: u64) {
        debug_assert!(first > self.sent);
        self.probe = Some(ProbeWrite {
            boundary: OutputBoundary {
                input: first,
                before: None,
            },
            issued: false,
            classifying_key: false,
        });
    }

    /// Schedules one Backspace before the next person's bytes. A new read or unread output
    /// revokes it up to the actual write attempt. Its slot keeps later input positions stable.
    pub(super) fn push_probe_erase(&mut self, key: u8, automatic: bool) {
        debug_assert!(self.probe_erase.is_none());
        self.input.push_back(key);
        self.probe_erase = Some(ProbeErase {
            through: self.sent + self.input.len() as u64,
            output_read: (!automatic).then_some(self.output_read),
            issued: false,
            automatic,
            classifying_key: false,
        });
    }

    pub(super) fn has_probe_erase(&self) -> bool {
        self.probe_erase.is_some()
    }

    /// Prevents a queued probe key from going ahead of a person's key still being classified.
    pub(super) fn classify_probe_key(&mut self, classifying: bool) {
        if let Some(erase) = self
            .probe_erase
            .as_mut()
            .filter(|erase| erase.automatic && !erase.issued)
        {
            erase.classifying_key = classifying;
            if classifying && erase.through == self.sent + 1 {
                self.writing = 0;
            }
        }
        if let Some(probe) = &mut self.probe {
            probe.classifying_key = classifying;
            if classifying && !probe.issued && probe.boundary.input == self.sent + 1 {
                // An offered probe byte may still be waiting for Unix write readiness.
                self.writing = 0;
            }
        }
    }

    /// Retires observation and revokes the probe byte if the system has not taken its write.
    pub(super) fn revoke_probe_key(&mut self) -> bool {
        if let Some(erase) = self
            .probe_erase
            .take_if(|erase| erase.automatic && !erase.issued)
        {
            self.probe = None;
            return self.revoke_queued_probe_key(erase.through);
        }
        let Some(probe) = self.probe.take().filter(|probe| !probe.issued) else {
            return false;
        };
        self.revoke_queued_probe_key(probe.boundary.input)
    }

    fn revoke_queued_probe_key(&mut self, through: u64) -> bool {
        let index = (through - self.sent - 1) as usize;
        if index < self.writing {
            self.writing = 0;
        }
        debug_assert!(self.output_boundaries().all(|b| b.input < through));
        self.input.remove(index).is_some()
    }

    pub(super) fn stop_observing_probe(&mut self) {
        self.probe = None;
    }

    pub(super) fn output_follows_probe(&self) -> bool {
        self.probe
            .as_ref()
            .is_some_and(|probe| self.latest_output_follows(&probe.boundary))
    }

    pub(super) fn read_starts_at_probe(&self) -> bool {
        self.probe.as_ref().and_then(|probe| probe.boundary.before)
            == Some(self.output_read_start())
    }

    /// Watches the output boundary of the write that finishes a batch of Backspaces.
    pub(crate) fn observe_cleanup_through(&mut self, through: u64) {
        debug_assert!(through > self.sent);
        self.cleanup = Some(OutputBoundary {
            input: through,
            before: None,
        });
    }

    pub(crate) fn stop_observing_cleanup(&mut self) {
        self.cleanup = None;
    }

    /// Whether an issued cleanup has actually been followed by readable output.
    pub(crate) fn cleanup_output_seen(&self) -> bool {
        self.cleanup.as_ref().is_none_or(|boundary| {
            boundary
                .before
                .is_some_and(|before| self.output_read > before)
        })
    }

    /// The screen can begin collecting fresh paint with this part of the stream.
    pub(crate) fn read_starts_at_cleanup(&self) -> bool {
        self.cleanup
            .as_ref()
            .is_some_and(|boundary| boundary.before == Some(self.output_read_start()))
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

    /// Tracks the last byte of the typist's submission or erase using the same write issue sample.
    pub(crate) fn observe_delivery_write(&mut self, through: u64) {
        debug_assert!(through > self.sent);
        self.delivery_write = Some(SubmissionOrder {
            enter: OutputBoundary {
                input: through,
                before: None,
            },
            following_edit: None,
        });
    }

    pub(crate) fn stop_observing_delivery(&mut self) {
        self.delivery_write = None;
    }

    pub(crate) fn observes_delivery_write(&self) -> bool {
        self.delivery_write.is_some()
    }

    pub(crate) fn output_follows_delivery_write(&self) -> bool {
        self.delivery_write
            .as_ref()
            .is_some_and(|delivery| self.latest_output_follows(&delivery.enter))
    }

    /// Whether the frame is after the automatic write and before the first following edit.
    pub(crate) fn delivery_frame_precedes_edit(&self, frame: u64) -> bool {
        self.delivery_write.as_ref().is_some_and(|delivery| {
            delivery.enter.before.is_some_and(|before| frame > before)
                && delivery
                    .following_edit
                    .as_ref()
                    .and_then(|edit| edit.boundary.before)
                    .is_none_or(|before| frame <= before)
        })
    }

    /// The next read starts on the other side of the edit following a delivery write.
    pub(super) fn delivery_read_reaches_edit(&self) -> bool {
        self.delivery_write
            .as_ref()
            .and_then(|delivery| delivery.following_edit.as_ref())
            .and_then(|edit| edit.boundary.before)
            == Some(self.output_read)
    }

    fn awaiting_following_edit(&mut self) -> impl Iterator<Item = &mut SubmissionOrder> {
        self.submissions
            .back_mut()
            .into_iter()
            .chain(self.delivery_write.iter_mut())
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
        for submission in self.awaiting_following_edit() {
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
        for edit in self
            .awaiting_following_edit()
            .filter_map(|order| order.following_edit.as_mut())
        {
            edit.provisional = false;
        }
    }

    /// The pending sequence was a report. Any subsequent edit gets its own boundary.
    pub(crate) fn forget_provisional_edit(&mut self) {
        for submission in self.awaiting_following_edit() {
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

    fn output_read_start(&self) -> u64 {
        self.output_read - self.received as u64
    }

    pub(super) fn read_starts_at_following_edit(&self) -> bool {
        self.output_before_following_edit() == Some(self.output_read_start())
    }

    fn latest_output_follows(&self, boundary: &OutputBoundary) -> bool {
        boundary
            .before
            .is_some_and(|before| self.output_read_start() >= before)
    }

    /// Whether the latest read is on this side of the active paste's write.
    pub(crate) fn output_follows_paste(&self) -> bool {
        self.paste
            .as_ref()
            .is_some_and(|paste| self.latest_output_follows(paste))
    }

    /// Whether this read starts at the output boundary of the paste's first write.
    pub(super) fn read_starts_at_paste(&self) -> bool {
        let start = self.output_read - self.received as u64;
        self.paste
            .as_ref()
            .is_some_and(|paste| paste.before == Some(start))
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

    /// Marks an unfinished frame when this read starts just past a tracked write's output prefix.
    pub(crate) fn read_starts_after_write(&self) -> bool {
        let start = self.output_read_start();
        self.submissions
            .iter()
            .chain(self.delivery_write.iter())
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
        let event = terminal.ready(TerminalWait::ReadAndWrite, |_, _| true);
        tokio::time::timeout(Duration::from_secs(10), event)
            .await
            .expect("an event")
    }

    #[test]
    fn a_probe_key_can_only_be_revoked_before_the_write_is_issued() {
        for issued in [false, true] {
            let mut terminal = Terminal::new(None).unwrap();
            terminal.observe_probe_from(1);
            terminal.push(b" x");
            terminal.writing = 1;
            if issued {
                // A failed output-prefix sample does not undo the input handoff.
                terminal.mark_output(1, None);
            }
            assert_eq!(terminal.revoke_probe_key(), !issued);
            assert_eq!(terminal.writing, usize::from(issued));
            assert_eq!(terminal.written(), 0);
            assert_eq!(
                terminal.input.make_contiguous(),
                if issued { &b" x"[..] } else { b"x" }
            );
        }
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
                TerminalEvent::Closed { .. } => break,
                TerminalEvent::ReadFailed(error) => {
                    panic!("terminal ended with a read error: {error}")
                }
                TerminalEvent::Wrote | TerminalEvent::ProbeEraseNeedsCheck { .. } => {}
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
            terminal.ready(TerminalWait::ReadAndWrite, |_, _| true),
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

    #[tokio::test]
    async fn an_earlier_queued_redraw_does_not_follow_the_cleanup_write() {
        let (mut terminal, mut cli) = opened();
        terminal.push_probe_erase(b'\x7f', true);
        terminal.cancel_probe_erase();
        assert_eq!(terminal.input_through(), 1);
        assert_eq!(terminal.written(), 0);
        let armed = tokio::time::timeout(
            Duration::from_millis(10),
            terminal.ready(TerminalWait::ReadAndWrite, |_, _| true),
        );
        assert!(armed.await.is_err());
        cli.write_output(b"earlier redraw").unwrap();
        terminal.push(b"\x7f");
        terminal.observe_cleanup_through(2);
        let mut fence = None;
        let event = tokio::time::timeout(
            Duration::from_secs(5),
            terminal.ready(TerminalWait::WriteOnly, |offset, count| {
                fence = Some((offset, count));
                true
            }),
        )
        .await
        .expect("the cleanup key reaches the terminal");
        assert!(matches!(event, TerminalEvent::Wrote));
        assert_eq!(fence, Some((1, 1)));
        assert_eq!(terminal.input_through(), 2);
        assert_eq!(terminal.written(), 1);
        assert!(!terminal.cleanup_output_seen());

        cli.write_output(b"new redraw").unwrap();
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Read));
        assert_eq!(terminal.output(), b"earlier redraw");
        assert!(!terminal.cleanup_output_seen());
        assert!(!terminal.read_starts_at_cleanup());

        assert!(matches!(next(&mut terminal).await, TerminalEvent::Read));
        assert_eq!(terminal.output(), b"new redraw");
        assert!(terminal.cleanup_output_seen());
        assert!(terminal.read_starts_at_cleanup());
    }

    #[tokio::test]
    async fn a_delivery_output_sample_ends_before_newly_arrived_bytes() {
        let (mut terminal, mut cli) = opened();
        cli.write_output(b"already readable").unwrap();
        terminal.sample_ready_delivery_output().unwrap();
        assert!(terminal.delivery_output_pending());
        cli.write_output(b"arrived after the sample").unwrap();
        terminal.sample_ready_delivery_output().unwrap();

        assert!(matches!(next(&mut terminal).await, TerminalEvent::Read));
        assert_eq!(terminal.output(), b"already readable");
        assert!(!terminal.delivery_output_pending());
        terminal.finish_delivery_output();
        assert!(matches!(next(&mut terminal).await, TerminalEvent::Read));
        assert_eq!(terminal.output(), b"arrived after the sample");
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
            terminal.ready(TerminalWait::WriteOnly, |_, _| true),
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
            terminal.ready(TerminalWait::WriteOnly, |_, _| true),
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
                terminal.ready(TerminalWait::ReadAndWrite, |_, _| true),
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
            assert!(matches!(
                next(&mut terminal).await,
                TerminalEvent::Closed { .. }
            ));
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
