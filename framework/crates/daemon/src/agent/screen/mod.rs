//! Durable screen changes and the lifetime of an agent's in-memory terminal.
mod codec;
mod disk;
mod recovery;

use std::fs::File;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use facade_screen::{ParsedOutput, Screen, TerminalColors};
use tokio::task::JoinHandle;

use super::SCROLLBACK_ROWS;
use crate::blocking_in_place;
pub(crate) use codec::Checkpoint;
use codec::*;
use disk::*;
pub(crate) use recovery::{load, recover, recover_after_clean_end, saved_size};

/// The most bytes one feed takes; used to bound a complete disk record.
pub(crate) const MAX_FEED_BYTES: usize = 64 * 1024;
/// Maximum bytes in a screen log, including its header and record framing.
pub(crate) const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;
const CHECKPOINT_AFTER_BYTES: u64 = 4 * 1024 * 1024;
const FALLBACK_SIZE: (u16, u16) = (80, 24);
static SCREEN_WRITERS: AtomicUsize = AtomicUsize::new(0);

/// The checkpoint task's publication and cleanup result; waiting holds no lock.
pub(crate) type Written = Result<io::Result<Cleanup>, tokio::task::JoinError>;

/// Number of active checkpoint writers, read without waiting or taking a lock.
pub(crate) fn screen_writes() -> usize {
    SCREEN_WRITERS.load(Ordering::SeqCst)
}

struct Writing;
impl Writing {
    fn start() -> Self {
        SCREEN_WRITERS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}
impl Drop for Writing {
    fn drop(&mut self) {
        SCREEN_WRITERS.fetch_sub(1, Ordering::SeqCst);
    }
}
fn warn(text: &str) {
    facade_base::log::write("daemon", "warn", text);
}

/// Appends records and owns the pending checkpoint; all synchronous methods may touch disk.
pub(crate) struct ScreenLog {
    dir: PathBuf,
    agent_id: String,
    generation: u64,
    published: u64,
    file: Option<File>,
    log_bytes: u64,
    pending: Option<Arc<Checkpoint>>,
    writer: Option<JoinHandle<io::Result<Cleanup>>>,
    output_since_capture: u64,
    cleanup_after_sync: Option<u64>,
    follows_gap: bool,
    failure_logged: Option<bool>,
    /// Passed with a recovered screen and taken when the actor installs it.
    pub(super) recovered_title: Option<String>,
}

impl ScreenLog {
    fn open(
        dir: PathBuf,
        agent_id: &str,
        generation: u64,
        file: Option<File>,
        log_bytes: u64,
    ) -> Self {
        Self {
            dir,
            agent_id: agent_id.into(),
            generation,
            published: generation,
            file,
            log_bytes,
            pending: None,
            writer: None,
            output_since_capture: 0,
            cleanup_after_sync: None,
            follows_gap: false,
            failure_logged: None,
            recovered_title: None,
        }
    }

    /// Creates private files and publishes the initial checkpoint synchronously, without locks.
    /// A disk failure returns a sealed log that later checkpoint attempts can repair.
    pub(crate) fn create(dir: PathBuf, agent_id: &str, checkpoint: Checkpoint) -> ScreenLog {
        let initial = || -> io::Result<(File, u64, Cleanup)> {
            create_agent_dir(&dir)?;
            let opened = create_log(&dir, 1, false)?;
            write_checkpoint(&dir, 1, &checkpoint)?;
            Ok((opened.0, opened.1, publish(&dir, 1, 1)?))
        };
        match initial() {
            Err(e) => {
                let mut journal = Self::open(dir, agent_id, 1, None, 0);
                journal.published = 0;
                journal.log_failure(&format!(
                    "could not create the initial checkpoint and screen log: {e}"
                ));
                journal
            }
            Ok((handle, length, cleanup)) => {
                let mut journal = Self::open(dir, agent_id, 1, Some(handle), length);
                journal.cleaned_up(1, cleanup);
                journal
            }
        }
    }

    fn job(&self) -> Option<CheckpointJob> {
        Some(CheckpointJob {
            checkpoint: self.pending.clone()?,
            dir: self.dir.clone(),
            keep_from: self.published,
            generation: self.generation,
        })
    }
    fn start_writer(&mut self, job: Option<CheckpointJob>, guard: Writing) {
        if let Some(job) = job {
            self.writer = Some(tokio::task::spawn_blocking(move || {
                let _guard = guard;
                job.run()
            }));
        }
    }
    fn begin_checkpoint(&mut self, captured: Checkpoint) {
        let writing = Writing::start();
        let job = self.prepare_checkpoint(captured);
        self.start_writer(job, writing);
    }
    fn retry_checkpoint_if_due(&mut self) {
        let writing = Writing::start();
        let job = self.prepare_retry();
        self.start_writer(job, writing);
    }
    fn prepare_retry(&mut self) -> Option<CheckpointJob> {
        if self.writer.is_some()
            || self.pending.is_none()
            || self.output_since_capture < CHECKPOINT_AFTER_BYTES
        {
            return None;
        }
        self.output_since_capture = 0;
        match published_generation(&self.dir) {
            Ok(Some(number)) if number == self.generation => {
                self.cleanup_after_sync = Some(self.mark_published());
                None
            }
            Ok(_) => self.job(),
            Err(e) => {
                self.log_failure(&format!(
                    "could not determine whether checkpoint {} was published: {e}",
                    self.generation
                ));
                None
            }
        }
    }
    fn prepare_checkpoint(&mut self, captured: Checkpoint) -> Option<CheckpointJob> {
        self.output_since_capture = 0;
        if let Some(keep) = self.cleanup_after_sync {
            match clean_up(&self.dir, self.published, keep) {
                Cleanup::Done => self.cleanup_after_sync = None,
                Cleanup::FolderNotSynced(e) => {
                    self.log_failure(&format!(
                        "could not sync the folder for checkpoint {}: {e}",
                        self.published
                    ));
                    return None;
                }
            }
        }
        let next = self.generation + 1;
        let gap = self.file.is_none();
        let opening = create_agent_dir(&self.dir).and_then(|()| create_log(&self.dir, next, gap));
        match opening {
            Err(e) => {
                let _ = remove_file(&log_path(&self.dir, next));
                self.log_failure(&format!("could not create screen log {next}: {e}"));
                None
            }
            Ok((handle, bytes)) => {
                self.file = Some(handle);
                self.log_bytes = bytes;
                self.generation = next;
                self.follows_gap = gap;
                self.pending = Some(Arc::new(captured));
                self.job()
            }
        }
    }

    fn append_output(&mut self, data: &[u8]) {
        self.output_since_capture += data.len() as u64;
        self.append(&output_record(data));
    }
    fn append_resize(&mut self, cols: u16, rows: u16) {
        self.append(&resize_record(cols, rows));
    }
    fn append_sync_end(&mut self) {
        self.append(SYNC_END_RECORD);
    }
    fn write_record(output: &mut impl Write, data: &[u8]) -> io::Result<()> {
        output.write_all(data)
    }
    fn append(&mut self, record: &[u8]) {
        if self.file.is_none() {
            return;
        }
        let length = self.log_bytes + record.len() as u64;
        let result = if length > MAX_LOG_BYTES {
            Err(format!(
                "screen log {} reached its {} MiB limit",
                self.generation,
                MAX_LOG_BYTES / (1024 * 1024)
            ))
        } else {
            Self::write_record(self.file.as_mut().unwrap(), record)
                .map_err(|e| format!("could not write screen log {}: {e}", self.generation))
        };
        match result {
            Ok(()) => self.log_bytes = length,
            Err(message) => {
                self.seal();
                self.log_failure(&message);
            }
        }
    }
    fn seal(&mut self) {
        self.file.take();
        self.output_since_capture = 0;
    }
    fn log_failure(&mut self, detail: &str) {
        let sealed = self.file.is_none();
        match self.failure_logged {
            Some(true) => return,
            Some(false) if !sealed => return,
            _ => self.failure_logged = Some(sealed),
        }
        let recovery = if sealed {
            "recovery uses output logged before the failure until a later checkpoint is published"
        } else {
            "records continue in the current log; recovery can replay them, and checkpoint publication will be retried after more output"
        };
        warn(&format!(
            "screen log of {}: {detail}; the agent keeps running, and {recovery}",
            self.agent_id
        ));
    }
    fn cleaned_up(&mut self, keep: u64, result: Cleanup) {
        match result {
            Cleanup::Done => (),
            Cleanup::FolderNotSynced(e) => {
                self.cleanup_after_sync = Some(keep);
                self.log_failure(&format!(
                    "checkpoint {} is published, but its folder could not be synced: {e}",
                    self.published
                ));
            }
        }
    }
    fn mark_published(&mut self) -> u64 {
        let fallback = std::mem::replace(&mut self.published, self.generation);
        self.pending.take();
        self.follows_gap = false;
        self.failure_logged = None;
        fallback
    }
    fn wants_checkpoint(&self) -> bool {
        self.pending.is_none() && self.output_since_capture >= CHECKPOINT_AFTER_BYTES
    }
    fn near_cap(&self) -> bool {
        self.file.is_some() && MAX_LOG_BYTES < self.log_bytes + MAX_RECORD_BYTES
    }
    fn must_force_checkpoint(&self) -> bool {
        self.pending.is_none() && self.near_cap()
    }
    fn backpressured(&self) -> bool {
        self.writer.is_some() && self.near_cap()
    }
    fn checkpoint_running(&self) -> bool {
        self.writer.is_some()
    }
    async fn checkpoint_written(&mut self) -> Written {
        if let Some(task) = &mut self.writer {
            task.await
        } else {
            std::future::pending().await
        }
    }
    fn finish_checkpoint(&mut self, result: Written) {
        self.writer.take();
        let failure = match result {
            Ok(Ok(cleanup)) => {
                let keep = self.mark_published();
                self.cleaned_up(keep, cleanup);
                facade_base::service::mark_for_test(&format!(
                    "checkpoint-published-{}",
                    self.agent_id
                ));
                return;
            }
            Ok(Err(e)) => e,
            Err(join) => {
                match published_generation(&self.dir) {
                    Err(e) => {
                        self.output_since_capture = 0;
                        self.log_failure(&format!("could not determine whether checkpoint {} was published after its writer failed ({join}): {e}", self.generation));
                        return;
                    }
                    Ok(Some(number)) if number == self.generation => {
                        let keep = self.mark_published();
                        self.cleanup_after_sync = Some(keep);
                        self.log_failure(&format!("checkpoint {} is published, but its writer failed before cleanup: {join}", self.published));
                        return;
                    }
                    Ok(_) => io::Error::other(join),
                }
            }
        };
        self.output_since_capture = 0;
        if self.follows_gap {
            self.pending.take();
            let _ = remove_file(&checkpoint_path(&self.dir, self.generation));
            let _ = remove_file(&log_path(&self.dir, self.generation));
            self.seal();
        } else if self.file.is_none() || self.near_cap() {
            self.seal();
        }
        self.log_failure(&format!(
            "could not publish checkpoint {}: {failure}",
            self.generation
        ));
    }
    async fn finish(mut self) {
        if let Some(task) = self.writer.take() {
            let _ = task.await;
        }
    }
}

/// An agent's screen and log; changes reach disk before they reach the terminal engine.
pub(crate) struct LoggedScreen {
    folder: PathBuf,
    id: String,
    held: bool,
    log_closed: bool,
    screen: Screen,
    title: Option<String>,
    colors: TerminalColors,
    log: Option<ScreenLog>,
}
impl LoggedScreen {
    /// Creates a screen, waiting for its initial files on a blocking thread; holds no lock.
    pub(crate) async fn create(
        folder: PathBuf,
        agent_id: &str,
        cols: u16,
        rows: u16,
    ) -> LoggedScreen {
        let screen = Screen::new(cols, rows, SCROLLBACK_ROWS);
        let capture = Checkpoint::capture(&screen);
        let (path, id) = (folder.clone(), agent_id.to_owned());
        let log = tokio::task::spawn_blocking(move || ScreenLog::create(path, &id, capture))
            .await
            .ok();
        Self::recovered(folder, agent_id, screen, log)
    }
    /// Takes an already recovered screen and optional log, without I/O or locks.
    pub(crate) fn recovered(
        folder: PathBuf,
        agent_id: &str,
        screen: Screen,
        mut log: Option<ScreenLog>,
    ) -> LoggedScreen {
        let title = log.as_mut().and_then(|log| log.recovered_title.take());
        Self {
            folder,
            id: agent_id.into(),
            held: true,
            log_closed: false,
            screen,
            title,
            colors: TerminalColors::default(),
            log,
        }
    }
    /// Represents an ended screen kept only in its files; does no I/O and takes no lock.
    pub(crate) fn released(folder: PathBuf, agent_id: &str) -> LoggedScreen {
        Self {
            folder,
            id: agent_id.into(),
            held: false,
            log_closed: true,
            screen: Screen::new(2, 1, 0),
            title: None,
            colors: TerminalColors::default(),
            log: None,
        }
    }
    /// Keeps the supplied colors on the current screen and every screen loaded later.
    pub(crate) fn set_colors(&mut self, colors: TerminalColors) {
        self.colors = colors;
        self.screen.set_colors(colors);
    }
    /// Updates the named colors while keeping the current indexed palette.
    pub(crate) fn set_named_colors(&mut self, colors: TerminalColors) {
        self.set_colors(TerminalColors {
            ansi: self.colors.ansi,
            ..colors
        });
    }
    /// Sets the viewer title's status glyph and returns its update bytes without logging them.
    pub(crate) fn set_status_glyph(&mut self, glyph: Option<String>) -> Vec<u8> {
        self.screen.set_status_glyph(glyph)
    }
    /// Borrows the held screen, or the two-column placeholder; takes no lock.
    pub(crate) fn screen(&self) -> &Screen {
        &self.screen
    }
    pub(crate) fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
    /// Whether the screen is held in memory; does not wait or take a lock.
    pub(crate) fn is_held(&self) -> bool {
        self.held
    }
    /// Appends output in a blocking region before parsing it; takes no lock.
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> ParsedOutput {
        if let Some(journal) = &mut self.log {
            blocking_in_place(|| journal.append_output(bytes));
        }
        let parsed = self.screen.feed(bytes);
        self.record_title(&parsed);
        parsed
    }
    /// Logs a changed size before applying it; may block on disk and takes no lock.
    pub(crate) fn resize(&mut self, cols: u16, rows: u16) {
        if (cols, rows) == (self.screen.cols(), self.screen.rows()) {
            return;
        }
        self.checkpoint_if_due();
        if let Some(journal) = &mut self.log {
            blocking_in_place(|| journal.append_resize(cols, rows));
        }
        self.screen.resize(cols, rows);
    }
    /// Logs an overdue synchronized update's end before applying it; takes no lock.
    pub(crate) fn end_synchronized_update(&mut self) -> ParsedOutput {
        self.checkpoint_if_due();
        if let Some(journal) = &mut self.log {
            blocking_in_place(|| journal.append_sync_end());
        }
        let parsed = self.screen.end_synchronized_update();
        self.record_title(&parsed);
        parsed
    }

    fn record_title(&mut self, parsed: &ParsedOutput) {
        if let Some(title) = &parsed.title_change {
            self.title = (!title.is_empty()).then(|| title.clone());
        }
    }
    /// Schedules due, forced, or failed checkpoints; disk setup may block, with no locks held.
    pub(crate) fn checkpoint_if_due(&mut self) {
        let Some(journal) = &mut self.log else {
            return;
        };
        journal.retry_checkpoint_if_due();
        let clean = journal.wants_checkpoint() && self.screen.at_clean_point();
        if !clean && !journal.must_force_checkpoint() {
            return;
        }
        if !clean {
            warn(&format!(
                "the screen log of {} reached {} MiB without a clean point; forcing a checkpoint; recovery from it loses {}",
                self.id,
                MAX_LOG_BYTES / (1024 * 1024),
                forced_checkpoint_losses(&self.screen).join(" and ")
            ));
        }
        blocking_in_place(|| {
            journal.begin_checkpoint(Checkpoint::capture_with_title(
                &self.screen,
                self.title.as_deref(),
            ));
        });
    }
    /// Whether output must wait for the checkpoint; takes no lock and never waits.
    pub(crate) fn is_full(&self) -> bool {
        self.log.as_ref().is_some_and(ScreenLog::backpressured)
    }
    /// Whether a checkpoint task exists; takes no lock and never waits.
    pub(crate) fn checkpoint_running(&self) -> bool {
        self.log.as_ref().is_some_and(ScreenLog::checkpoint_running)
    }
    /// Waits for the checkpoint task without locks; cancellation leaves the task available.
    pub(crate) async fn checkpoint_written(&mut self) -> Written {
        match &mut self.log {
            Some(journal) => journal.checkpoint_written().await,
            None => std::future::pending().await,
        }
    }
    /// Consumes a task result, recording publication or failure; may block on disk, without locks.
    pub(crate) fn finish_checkpoint(&mut self, written: Written) {
        if let Some(journal) = &mut self.log {
            journal.finish_checkpoint(written);
        }
    }
    /// Drops the in-memory screen and waits for any writer before closing its log; takes no lock.
    pub(crate) async fn let_go(&mut self) {
        self.screen = Screen::new(2, 1, 0);
        self.screen.set_colors(self.colors);
        self.held = false;
        if let Some(journal) = self.log.take() {
            journal.finish().await;
            self.log_closed = true;
        }
        facade_base::service::mark_for_test(&format!("screen-dropped-{}", self.id));
    }
    /// Loads a released screen on a blocking thread; takes no lock.
    pub(crate) async fn hold(&mut self) -> bool {
        self.restore(false).await
    }
    /// Loads a released screen and reopens its log on a blocking thread; takes no lock.
    pub(crate) async fn hold_with_log(&mut self) -> bool {
        self.restore(true).await
    }
    async fn restore(&mut self, with_log: bool) -> bool {
        let (folder, id) = (self.folder.clone(), self.id.clone());
        if with_log && self.log_closed {
            match tokio::task::spawn_blocking(move || recover(&folder, &id, None, &|| {})).await {
                Ok(recovered) => {
                    self.screen = recovered.screen;
                    self.screen.set_colors(self.colors);
                    self.log = recovered.log;
                    self.title = self.log.as_mut().and_then(|log| log.recovered_title.take());
                    self.held = true;
                    self.log_closed = false;
                }
                Err(e) => warn(&format!("could not recover the screen of {}: {e}", self.id)),
            }
        } else if !self.held {
            let read = tokio::task::spawn_blocking(move || load(&folder, &id)).await;
            match read {
                Ok(Ok((screen, title))) => {
                    self.screen = screen;
                    self.title = title;
                    self.screen.set_colors(self.colors);
                    self.held = true;
                    facade_base::service::mark_for_test(&format!("screen-loaded-{}", self.id));
                }
                result => {
                    let failure = match result {
                        Ok(Err(e)) => e.to_string(),
                        Err(e) => e.to_string(),
                        _ => unreachable!(),
                    };
                    warn(&format!(
                        "could not read the screen of {} from its files: {failure}",
                        self.id
                    ));
                }
            }
        }
        self.held
    }
    /// Waits for any writer and closes the log, without taking a lock.
    pub(crate) async fn finish(&mut self) {
        if let Some(journal) = self.log.take() {
            journal.finish().await;
        }
    }
}

fn forced_checkpoint_losses(screen: &Screen) -> Vec<&'static str> {
    let mut losses = Vec::new();
    for (missing, explanation) in [
        (screen.on_alternate_screen(), "the hidden main screen"),
        (
            screen.has_unfinished_unit(),
            "the unfinished character or sequence",
        ),
        (
            screen.synchronized_update_deadline().is_some(),
            "the frame buffered by its open synchronized update",
        ),
    ] {
        if missing {
            losses.push(explanation);
        }
    }
    losses
}

#[cfg(test)]
#[path = "tests.rs"]
mod test_suite;
