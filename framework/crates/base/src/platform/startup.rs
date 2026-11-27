//! The current attempt to wake a home, and the facts each process can report about that attempt.
//! Claims and outcomes share a startup lock. A separate open file reference survives launch.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Context as _;
use serde::{Deserialize, Serialize};

use crate::process::ProcessIdentity;

use super::files;
use super::service::{self, Service};
use super::unix_process::{Presence, own_identity, presence};

mod wait;
pub use wait::StartupWait;

pub const NO_PROGRESS: Duration = Duration::from_secs(75);
pub const TOTAL: Duration = Duration::from_secs(180);
const MAX_RECORD: u64 = 16 * 1024;

pub(super) const GENERATION_ENV: &str = "FACADE_STARTUP_GENERATION";
pub(super) const LEASE_ENV: &str = "FACADE_STARTUP_LEASE";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Origin {
    started: u64,
    owner: ProcessIdentity,
}

#[derive(Clone, Debug)]
pub struct Attempt {
    directory: PathBuf,
    generation: String,
    origin: Origin,
}

pub(super) struct Reservation {
    pub(super) attempt: Attempt,
    pub(super) lease: File,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ticket {
    pub generation: String,
    pub pid: u32,
    pub birth: String,
    pub idle: u64,
    pub hard: u64,
}

impl Ticket {
    pub fn process(&self) -> ProcessIdentity {
        ProcessIdentity {
            pid: self.pid,
            birth: self.birth.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Progress {
    at: u64,
    writer: ProcessIdentity,
    stage: String,
    #[serde(default)]
    ready: bool,
}

#[derive(Serialize, Deserialize)]
struct Window {
    generation: String,
    progress: Progress,
    idle: u64,
    hard: u64,
}

#[derive(Serialize, Deserialize)]
struct DaemonRecord {
    process: ProcessIdentity,
    at: u64,
}

#[derive(Serialize, Deserialize)]
struct LaunchImage {
    build: String,
    path: String,
    may_drop_lease: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub generation: String,
    pub process: ProcessIdentity,
    pub stage: String,
    pub reason: String,
    pub log: PathBuf,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchedFailure {
    pub failure: Failure,
    serial: u64,
}

pub enum StartupFailure {
    Followed(Failure),
    Dispatched(DispatchedFailure),
}

#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub started: u64,
    pub advanced: u64,
}

impl Budget {
    pub fn fresh() -> Self {
        let now = now();
        Self {
            started: now,
            advanced: now,
        }
    }

    pub fn hard(self) -> u64 {
        self.started.saturating_add(nanos(TOTAL))
    }

    pub fn idle(self) -> u64 {
        self.advanced.saturating_add(nanos(NO_PROGRESS))
    }

    pub fn deadline(self) -> Instant {
        let sampled = Instant::now();
        let clock = now();
        if let Some(remaining) = self.end().checked_sub(clock) {
            sampled + Duration::from_nanos(remaining)
        } else {
            sampled
                .checked_sub(Duration::from_nanos(clock - self.end()))
                .unwrap_or(sampled)
        }
    }

    pub fn exhausted(self) -> bool {
        self.exhausted_at(now())
    }

    pub fn exhausted_at(self, at: u64) -> bool {
        at >= self.end()
    }

    pub fn end(self) -> u64 {
        self.hard().min(self.idle())
    }

    pub fn limit_reason(self) -> &'static str {
        if self.hard() <= self.idle() {
            "the 180-second startup limit elapsed"
        } else {
            "startup made no progress for 75 seconds"
        }
    }
}

/// Darwin's raw monotonic clock uses the editor's `mach_continuous_time` time base.
#[cfg(target_os = "macos")]
pub fn now() -> u64 {
    use nix::time::{ClockId, clock_gettime};
    let Ok(time) = clock_gettime(ClockId::from_raw(nix::libc::CLOCK_MONOTONIC_RAW)) else {
        return 0;
    };
    let seconds = u64::try_from(time.tv_sec()).unwrap_or(0);
    let nanos = u64::try_from(time.tv_nsec()).unwrap_or(0);
    seconds.saturating_mul(1_000_000_000).saturating_add(nanos)
}

#[cfg(not(target_os = "macos"))]
pub use super::unix_process::monotonic_now as now;

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

fn directory(framework: &Path) -> PathBuf {
    framework.join("startup")
}

fn valid_generation(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_birth(birth: &str) -> bool {
    !birth.is_empty()
        && birth.len() <= 128
        && birth
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn process_file(process: &ProcessIdentity) -> String {
    format!("{}-{}", process.pid, process.birth.replace(':', "_"))
}

fn read(path: &Path) -> io::Result<String> {
    let mut text = String::new();
    File::open(path)?
        .take(MAX_RECORD + 1)
        .read_to_string(&mut text)?;
    if text.len() as u64 > MAX_RECORD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "startup record is too large",
        ));
    }
    Ok(text)
}

fn load<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&read(path).ok()?).ok()
}

fn replace(path: &Path, data: &[u8]) -> io::Result<()> {
    let temp = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        crate::random_u64()
    ));
    let written = (|| {
        files::private_options()
            .write(true)
            .create_new(true)
            .open(&temp)?
            .write_all(data)?;
        fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn save(path: &Path, data: &impl Serialize) -> io::Result<()> {
    replace(path, &serde_json::to_vec(data)?)
}

fn secure_directory(path: &Path) -> io::Result<()> {
    files::create_private_folder_all(path)?;
    let metadata = path.symlink_metadata()?;
    let ordinary = metadata.is_dir() && !metadata.file_type().is_symlink();
    #[cfg(unix)]
    let ordinary = {
        use std::os::unix::fs::MetadataExt;
        ordinary
            && metadata.uid() == nix::unistd::Uid::current().as_raw()
            && files::is_private(path)?
    };
    #[cfg(windows)]
    let ordinary = {
        use std::os::windows::fs::MetadataExt;
        ordinary && metadata.file_attributes() & 0x400 == 0
    };
    if !ordinary {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "cannot use {} as the private startup folder",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn order_file(root: &Path) -> io::Result<File> {
    secure_directory(root)?;
    files::private_options()
        .read(true)
        .write(true)
        .create(true)
        .open(root.join("order.lock"))
}

struct StartupOrder(File);

impl Drop for StartupOrder {
    fn drop(&mut self) {
        // A concurrently forked child can hold a copy until it execs. End our lock at this scope.
        let _ = self.0.unlock();
    }
}

fn startup_order(root: &Path) -> io::Result<StartupOrder> {
    let file = order_file(root)?;
    file.lock()?;
    Ok(StartupOrder(file))
}

fn try_startup_order(root: &Path) -> io::Result<StartupOrder> {
    let file = order_file(root)?;
    match file.try_lock() {
        Ok(()) => Ok(StartupOrder(file)),
        Err(fs::TryLockError::WouldBlock) => Err(io::ErrorKind::WouldBlock.into()),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

impl Attempt {
    /// Reads the announced attempt. The record is an observation, not a service admission.
    pub fn current(framework: &Path) -> Option<Self> {
        let generation = read(&directory(framework).join("current")).ok()?;
        Self::of(framework, generation.trim())
    }

    pub fn of(framework: &Path, generation: &str) -> Option<Self> {
        if !valid_generation(generation) {
            return None;
        }
        let directory = directory(framework).join(generation);
        let origin: Origin = load(&directory.join("origin"))?;
        let now = now();
        (origin.started != 0 && origin.started <= now).then(|| Attempt {
            directory,
            generation: generation.to_owned(),
            origin,
        })
    }

    pub fn inherited(framework: &Path) -> Option<Self> {
        Self::of(framework, &std::env::var(GENERATION_ENV).ok()?)
    }

    /// A launch interrupted before a terminal result can resume under its original budget.
    pub fn can_continue(&self) -> bool {
        self.in_progress() && !self.status().0.exhausted()
    }

    pub fn in_progress(&self) -> bool {
        !self.directory.join("succeeded").is_file()
            && !self.directory.join("ended").is_file()
            && !self.directory.join("launch-failed").is_file()
    }

    pub fn belongs_to_keeper(&self, keeper: &ProcessIdentity) -> bool {
        self.progress("keeper")
            .is_some_and(|progress| progress.writer == *keeper)
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    /// Orders the previous result and a new claim before selecting programs.
    pub(super) fn reserve(framework: &Path) -> anyhow::Result<Option<Reservation>> {
        let root = directory(framework);
        let _ordering = startup_order(&root)?;
        if live(framework)? {
            return Ok(None);
        }
        let current = Self::current(framework);
        if let Some(previous) = &current
            && previous.launching()?
        {
            return Ok(None);
        }
        seal_unreported(framework, current.as_ref())?;
        if !pending_failures(&root)?.is_empty() {
            // The next active caller takes the old outcome before another Shell launch.
            return Ok(None);
        }
        let attempt = match current.filter(Self::can_continue) {
            Some(attempt) => attempt,
            None => Self::begin_locked(framework)?,
        };
        let lease = open_lease(&attempt.directory.join("launch"), true)?
            .context("a launcher still holds this startup attempt")?;
        Ok(Some(Reservation { attempt, lease }))
    }

    /// Starts a generation in a keeper that is replacing a previously ready daemon.
    pub fn begin(framework: &Path) -> io::Result<Self> {
        let root = directory(framework);
        let _ordering = startup_order(&root)?;
        seal_unreported(framework, Self::current(framework).as_ref())?;
        Self::begin_locked(framework)
    }

    fn begin_locked(framework: &Path) -> io::Result<Self> {
        let root = directory(framework);
        let generation = format!("{:016x}", crate::random_u64());
        let directory = root.join(&generation);
        files::create_private_folder(&directory)?;
        let origin = Origin {
            started: now(),
            owner: own_identity()?,
        };
        save(&directory.join("origin"), &origin)?;
        replace(&root.join("current"), generation.as_bytes())?;
        Ok(Self {
            directory,
            generation,
            origin,
        })
    }

    /// Whether a committed creation or one of its candidates still belongs to this attempt.
    pub fn launching(&self) -> io::Result<bool> {
        let candidate = self.progress("candidate");
        if candidate
            .as_ref()
            .is_some_and(|progress| !matches!(presence(&progress.writer), Ok(Presence::Ended)))
        {
            return Ok(true);
        }
        let lease_held = match open_lease(&self.directory.join("launch"), false) {
            Ok(None) => true,
            Ok(Some(_)) => false,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error),
        };
        // A legacy Unix keeper can close a descriptor it does not recognize before it locks.
        // In that window only observation is safe until the original budget is exhausted.
        Ok(lease_held
            || (candidate.is_none()
                && load::<LaunchImage>(&self.directory.join("image-keeper"))
                    .is_some_and(|image| image.may_drop_lease)
                && self.can_continue()))
    }

    /// Records the actual published image before asking the system to create it.
    pub(super) fn image(&self, service: Service, build: &str, image: &Path) -> io::Result<()> {
        let image = LaunchImage {
            build: build.to_owned(),
            path: image.to_string_lossy().into_owned(),
            may_drop_lease: cfg!(unix) && service == Service::Keeper && build != crate::build_id(),
        };
        save(
            &self.directory.join(format!("image-{}", service.command())),
            &image,
        )
    }

    pub fn accept_keeper_candidate(&self) -> io::Result<()> {
        let identity = own_identity()?;
        self.record_candidate(identity)
    }

    fn record_candidate(&self, identity: ProcessIdentity) -> io::Result<()> {
        if self
            .progress("candidate")
            .is_some_and(|previous| previous.writer == identity)
        {
            return Ok(());
        }
        self.write_progress("candidate", identity, "keeper process created", false)
            .map(drop)
    }

    fn progress(&self, file: &str) -> Option<Progress> {
        let progress: Progress = load(&self.directory.join(file))?;
        (self.origin.started <= progress.at && progress.at <= now()).then_some(progress)
    }

    fn root(&self) -> &Path {
        self.directory
            .parent()
            .expect("a generation is in the startup folder")
    }

    fn write_progress(
        &self,
        file: &str,
        writer: ProcessIdentity,
        stage: &str,
        ready: bool,
    ) -> io::Result<Progress> {
        let _ordering = startup_order(self.root())?;
        self.write_ordered_progress(file, writer, stage, ready)
    }

    fn write_ordered_progress(
        &self,
        file: &str,
        writer: ProcessIdentity,
        stage: &str,
        ready: bool,
    ) -> io::Result<Progress> {
        if let Some(previous) = self.progress(file)
            && (file == "launcher" || previous.writer == writer)
            && previous.stage == stage
            && previous.ready == ready
        {
            return Ok(previous);
        }
        let progress = Progress {
            at: now(),
            writer,
            stage: stage.to_owned(),
            ready,
        };
        if ready {
            let budget = self.status().0;
            if budget.exhausted_at(progress.at) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    budget.limit_reason(),
                ));
            }
        }
        save(&self.directory.join(file), &progress)?;
        self.publish_window(&progress)?;
        Ok(progress)
    }

    fn publish_window(&self, progress: &Progress) -> io::Result<()> {
        let previous = self.status().0;
        if progress.at < previous.advanced || previous.exhausted_at(progress.at) {
            return Ok(());
        }
        let budget = Budget {
            started: self.origin.started,
            advanced: progress.at,
        };
        save(
            &self.directory.join("window"),
            &Window {
                generation: self.generation.clone(),
                progress: progress.clone(),
                idle: budget.idle(),
                hard: budget.hard(),
            },
        )
    }

    pub fn record(&self, role: &str, stage: &str) -> io::Result<()> {
        self.write_progress(role, own_identity()?, stage, false)
            .map(drop)
    }

    pub fn candidate(&self, pid: u32) -> io::Result<()> {
        if let Some(birth) = super::unix_process::birth(pid)? {
            self.record_candidate(ProcessIdentity { pid, birth })?;
        }
        Ok(())
    }

    pub fn daemon_progress(
        &self,
        identity: &ProcessIdentity,
        stage: &str,
        ready: bool,
    ) -> io::Result<()> {
        if !valid_birth(&identity.birth) {
            return Ok(());
        }
        let name = format!("daemon-{}", process_file(identity));
        if self
            .progress(&name)
            .is_some_and(|previous| previous.stage == stage && previous.ready == ready)
        {
            return Ok(());
        }
        let progress = self.write_progress(&name, identity.clone(), stage, ready)?;
        if ready {
            save(&self.directory.join("succeeded"), identity)?;
        }
        self.write_view(
            identity,
            progress.at,
            if ready { "ready" } else { "starting" },
            stage,
        )
    }

    /// The keeper has created this exact process, which might die before it takes its lock.
    pub fn daemon_created(&self, daemon: &ProcessIdentity) -> io::Result<()> {
        let _ordering = startup_order(self.root())?;
        self.remember_daemon("created-daemon", daemon)
    }

    /// A replacement keeper inherits the first ping, independently of the public accept loop.
    pub fn keeper_has_first_ping(&self, daemon: &ProcessIdentity) -> bool {
        valid_birth(&daemon.birth)
            && self
                .daemon_record(&format!("pinged-{}", process_file(daemon)), "pinged-")
                .is_some_and(|record| record.process == *daemon)
    }

    /// Records the first authenticated ping before entering runtime supervision.
    pub fn accept_keeper_ping(&self, daemon: &ProcessIdentity) -> io::Result<bool> {
        let _ordering = startup_order(self.root())?;
        if self.keeper_has_first_ping(daemon) {
            return Ok(true);
        }
        let at = now();
        if self.status().0.exhausted_at(at) || !valid_birth(&daemon.birth) {
            return Ok(false);
        }
        save(
            &self
                .directory
                .join(format!("pinged-{}", process_file(daemon))),
            &DaemonRecord {
                process: daemon.clone(),
                at,
            },
        )?;
        self.publish_window(&Progress {
            at,
            writer: own_identity()?,
            stage: "keeper received the first daemon ping".into(),
            ready: false,
        })?;
        Ok(true)
    }

    fn daemon_progress_read(&self, identity: &ProcessIdentity) -> Option<Progress> {
        if !valid_birth(&identity.birth) {
            return None;
        }
        self.progress(&format!("daemon-{}", process_file(identity)))
            .filter(|item| &item.writer == identity)
    }

    pub fn daemon_ready(&self, identity: &ProcessIdentity) -> bool {
        self.daemon_progress_read(identity)
            .is_some_and(|progress| progress.ready)
    }

    pub fn follows(&self, identity: &ProcessIdentity) -> bool {
        self.daemon_progress_read(identity).is_some()
    }

    pub fn supervises(&self, identity: &ProcessIdentity) -> bool {
        self.follows(identity)
            || (valid_birth(&identity.birth)
                && self
                    .daemon_record(
                        &format!("created-daemon-{}", process_file(identity)),
                        "created-daemon-",
                    )
                    .is_some_and(|record| record.process == *identity))
    }

    /// The latest admitted progress remains valid over a handoff of either service.
    pub fn status(&self) -> (Budget, String) {
        let mut budget = Budget {
            started: self.origin.started,
            advanced: self.origin.started,
        };
        if let Some(window) = load::<Window>(&self.directory.join("window"))
            && window.generation == self.generation
            && budget.started <= window.progress.at
            && window.progress.at <= now()
        {
            budget.advanced = window.progress.at;
            if window.idle == budget.idle() && window.hard == budget.hard() {
                return (budget, window.progress.stage);
            }
            budget.advanced = budget.started;
        }
        // The claim records the first selection phase. Its next observation is the selected set.
        (budget, "selecting programs".to_owned())
    }

    pub fn ticket(&self, identity: &ProcessIdentity) -> Ticket {
        let budget = self.status().0;
        Ticket {
            generation: self.generation.clone(),
            pid: identity.pid,
            birth: identity.birth.clone(),
            idle: budget.idle(),
            hard: budget.hard(),
        }
    }

    #[cfg(test)]
    fn remember_detach(&self, identity: &ProcessIdentity) -> io::Result<()> {
        let _ordering = startup_order(self.root())?;
        self.remember_detach_locked(identity)
    }

    fn remember_detach_locked(&self, identity: &ProcessIdentity) -> io::Result<()> {
        if !self.daemon_ready(identity) && valid_birth(&identity.birth) {
            self.remember_daemon("accepted", identity)?;
            if let Some(failure) = self.candidate_failure(identity) {
                self.enqueue_failure(&failure)?;
            }
        }
        Ok(())
    }

    fn remember_daemon(&self, role: &str, identity: &ProcessIdentity) -> io::Result<()> {
        if valid_birth(&identity.birth) {
            let path = self
                .directory
                .join(format!("{role}-{}", process_file(identity)));
            if !path.is_file() {
                save(
                    &path,
                    &DaemonRecord {
                        process: identity.clone(),
                        at: now(),
                    },
                )?;
            }
        }
        Ok(())
    }

    fn daemon_record(&self, name: &str, prefix: &str) -> Option<DaemonRecord> {
        let encoded = name.strip_prefix(prefix)?;
        let record: DaemonRecord = load(&self.directory.join(name))?;
        (valid_birth(&record.process.birth)
            && encoded == process_file(&record.process)
            && self.origin.started <= record.at
            && record.at <= now())
        .then_some(record)
    }

    fn known_daemons(&self) -> io::Result<Vec<(ProcessIdentity, u64)>> {
        let mut known = HashMap::<ProcessIdentity, u64>::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let record = self
                .daemon_record(name, "accepted-")
                .or_else(|| self.daemon_record(name, "created-daemon-"))
                .or_else(|| {
                    let encoded = name.strip_prefix("daemon-")?;
                    let stage = self.progress(name)?;
                    (valid_birth(&stage.writer.birth) && encoded == process_file(&stage.writer))
                        .then_some(DaemonRecord {
                            process: stage.writer,
                            at: stage.at,
                        })
                });
            if let Some(record) = record {
                known
                    .entry(record.process)
                    .and_modify(|at| *at = (*at).min(record.at))
                    .or_insert(record.at);
            }
        }
        let mut known: Vec<_> = known.into_iter().collect();
        known.sort_unstable_by_key(|(process, at)| (*at, process.pid));
        Ok(known)
    }

    fn failure_path(&self, identity: &ProcessIdentity) -> PathBuf {
        self.directory
            .join(format!("failure-{}", process_file(identity)))
    }

    pub fn candidate_failure(&self, identity: &ProcessIdentity) -> Option<Failure> {
        if !valid_birth(&identity.birth) {
            return None;
        }
        let failure: Failure = load(&self.failure_path(identity))?;
        (failure.process == *identity && failure.generation == self.generation).then_some(failure)
    }

    /// Preserves a child's failure for the clients already following it.
    pub fn fail_daemon(
        &self,
        identity: &ProcessIdentity,
        log: PathBuf,
        reason: &str,
    ) -> io::Result<()> {
        let _ordering = startup_order(self.root())?;
        self.fail_daemon_locked(identity, log, reason)
    }

    fn fail_daemon_locked(
        &self,
        identity: &ProcessIdentity,
        log: PathBuf,
        reason: &str,
    ) -> io::Result<()> {
        if !valid_birth(&identity.birth) || self.daemon_ready(identity) {
            return Ok(());
        }
        let progress = self.daemon_progress_read(identity);
        let at = progress
            .as_ref()
            .map_or(self.origin.started, |stage| stage.at);
        let outcome = match self.candidate_failure(identity) {
            Some(outcome) => outcome,
            None => {
                let outcome = Failure {
                    generation: self.generation.clone(),
                    process: identity.clone(),
                    stage: progress.map_or_else(|| "starting the daemon".to_owned(), |p| p.stage),
                    reason: reason.chars().take(1024).collect(),
                    log,
                };
                save(&self.failure_path(identity), &outcome)?;
                outcome
            }
        };
        self.write_view(
            identity,
            at,
            "failed",
            &format!(
                "{}: {}\n{}",
                outcome.stage,
                outcome.reason,
                outcome.log.display()
            ),
        )?;
        if self
            .directory
            .join(format!("accepted-{}", process_file(identity)))
            .is_file()
        {
            self.enqueue_failure(&outcome)?;
        }
        Ok(())
    }

    pub fn finish(
        &self,
        framework: &Path,
        identity: &ProcessIdentity,
        fallback: &str,
    ) -> io::Result<()> {
        let _ordering = startup_order(self.root())?;
        if self.daemon_ready(identity) {
            return Ok(());
        }
        save(&self.directory.join("ended"), identity)?;
        self.fail_daemon_locked(identity, framework.join("logs/daemon.log"), fallback)?;
        if let Some(failure) = self.candidate_failure(identity) {
            self.enqueue_failure(&failure)?;
        }
        Ok(())
    }

    pub fn launch_failed(&self, framework: &Path, stage: &str, why: &str) -> io::Result<()> {
        let _ordering = startup_order(self.root())?;
        let failed = Failure {
            generation: self.generation.clone(),
            process: own_identity()?,
            stage: stage.to_owned(),
            reason: why.chars().take(1024).collect(),
            log: framework.join("logs/keeper.log"),
        };
        save(&self.directory.join("launch-failed"), &failed)?;
        self.enqueue_failure(&failed)
    }

    pub fn launch_failure(&self) -> Option<Failure> {
        load(&self.directory.join("launch-failed"))
    }

    fn enqueue_failure(&self, failure: &Failure) -> io::Result<()> {
        let dispatched = self
            .directory
            .join(format!("dispatched-{}", process_file(&failure.process)));
        if dispatched.is_file() {
            return Ok(());
        }
        let pending = pending_failures(self.root())?;
        if pending.iter().any(|(_, _, queued)| queued == failure) {
            return Ok(());
        }
        let serial = pending
            .last()
            .map_or(1, |(serial, _, _)| serial.saturating_add(1));
        let folder = self.root().join("pending");
        files::create_private_folder_all(&folder)?;
        save(&folder.join(format!("{serial:016x}")), failure)
    }

    fn write_view(
        &self,
        identity: &ProcessIdentity,
        at: u64,
        status: &str,
        text: &str,
    ) -> io::Result<()> {
        let name = format!("view-{}", process_file(identity));
        let data = format!(
            "2\t{}\t{}\t{}\t{}\t{}\n{}",
            self.generation, identity.pid, identity.birth, at, status, text
        );
        replace(&self.directory.join(name), data.as_bytes())
    }
}

#[derive(Clone)]
pub struct DaemonProgress {
    attempt: Attempt,
    identity: ProcessIdentity,
}

impl DaemonProgress {
    /// Called only after taking the daemon lock.
    pub fn start(framework: &Path) -> io::Result<Self> {
        let identity = own_identity()?;
        let attempt = match Attempt::inherited(framework) {
            Some(attempt) => attempt,
            None => Attempt::begin(framework)?,
        };
        let progress = Self { attempt, identity };
        progress.advance("daemon lock acquired")?;
        Ok(progress)
    }

    pub fn advance(&self, stage: &str) -> io::Result<()> {
        self.attempt.daemon_progress(&self.identity, stage, false)
    }

    pub fn ready(&self) -> io::Result<()> {
        self.attempt
            .daemon_progress(&self.identity, "daemon is accepting connections", true)
    }

    pub fn failed(&self, framework: &Path, reason: &str) -> io::Result<()> {
        self.attempt
            .fail_daemon(&self.identity, framework.join("logs/daemon.log"), reason)
    }

    pub fn budget(&self) -> Budget {
        self.attempt.status().0
    }
}
type QueuedFailure = (u64, PathBuf, Failure);

fn pending_failures(root: &Path) -> io::Result<Vec<QueuedFailure>> {
    let entries = match fs::read_dir(root.join("pending")) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut pending: Vec<_> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let serial = u64::from_str_radix(entry.file_name().to_str()?, 16).ok()?;
            let failure = load::<Failure>(&entry.path())?;
            Some((serial, entry.path(), failure))
        })
        .collect();
    pending.sort_unstable_by_key(|(serial, _, _)| *serial);
    Ok(pending)
}

/// Preserves proven candidates before an ordered claim can replace their generation.
fn seal_unreported(framework: &Path, attempt: Option<&Attempt>) -> io::Result<()> {
    let Some(attempt) = attempt else {
        return Ok(());
    };
    let keeper = attempt
        .progress("keeper")
        .or_else(|| attempt.progress("candidate"));
    let keeper_ended = match keeper {
        Some(previous) => matches!(presence(&previous.writer), Ok(Presence::Ended)),
        None => service::live_holder(framework, Service::Keeper)?.is_none(),
    };
    let candidates = attempt.known_daemons()?;
    let final_generation = keeper_ended
        && !attempt.launching()?
        && candidates
            .iter()
            .all(|(daemon, _)| matches!(presence(daemon), Ok(Presence::Ended)));
    let mut last_failed = None;
    for (daemon, _) in candidates {
        if attempt.daemon_ready(&daemon) {
            continue;
        }
        if final_generation && attempt.candidate_failure(&daemon).is_none() {
            attempt.fail_daemon_locked(
                &daemon,
                framework.join("logs/daemon.log"),
                &format!("daemon {} exited before reporting startup", daemon.pid),
            )?;
        }
        if let Some(failure) = attempt.candidate_failure(&daemon) {
            if attempt
                .daemon_record(&format!("accepted-{}", process_file(&daemon)), "accepted-")
                .is_some()
            {
                attempt.enqueue_failure(&failure)?;
            }
            last_failed = Some(failure);
        }
    }
    if final_generation
        && !attempt.directory.join("succeeded").is_file()
        && !attempt.directory.join("launch-failed").is_file()
        && let Some(terminal) = last_failed
    {
        save(&attempt.directory.join("ended"), &terminal.process)?;
        attempt.enqueue_failure(&terminal)?;
    }
    Ok(())
}

fn failures_by_priority(root: &Path) -> io::Result<Vec<QueuedFailure>> {
    let mut failures = pending_failures(root)?;
    failures.sort_by_cached_key(|(serial, _, failure)| {
        let accepted = valid_generation(&failure.generation)
            && valid_birth(&failure.process.birth)
            && root
                .join(&failure.generation)
                .join(format!("accepted-{}", process_file(&failure.process)))
                .is_file();
        (!accepted, *serial)
    });
    Ok(failures)
}

/// A lock-only invocation may show a queued failure without taking its dispatch.
pub fn peek_failure(framework: &Path) -> io::Result<Option<Failure>> {
    let root = directory(framework);
    if !root.join("pending").is_dir() {
        return Ok(None);
    }
    let _ordering = try_startup_order(&root)?;
    if service::live_holder(framework, Service::Daemon)?.is_some() {
        return Ok(None);
    }
    Ok(failures_by_priority(&root)?
        .into_iter()
        .next()
        .map(|(_, _, failure)| failure))
}

/// Orders the first handoff before the next Shell claim. The original outcome stays readable.
fn take_failure(
    framework: &Path,
    deadline: Option<Instant>,
) -> io::Result<Option<DispatchedFailure>> {
    let root = directory(framework);
    let waiting = root.join("pending");
    if !waiting.is_dir() {
        return Ok(None);
    }
    let _ordering = try_startup_order(&root)?;
    for (_, path, failure) in failures_by_priority(&root)? {
        if deadline.is_some_and(|until| Instant::now() >= until) {
            return Ok(None);
        }
        let Some(attempt) = Attempt::of(framework, &failure.generation) else {
            fs::remove_file(&path)?;
            continue;
        };
        let sent = attempt
            .directory
            .join(format!("dispatched-{}", process_file(&failure.process)));
        if valid_birth(&failure.process.birth) && !sent.is_file() {
            if deadline.is_some_and(|until| Instant::now() >= until) {
                return Ok(None);
            }
            let dispatch = DispatchedFailure {
                failure,
                serial: crate::random_u64(),
            };
            save(&sent, &dispatch)?;
            fs::remove_file(&path)?;
            let _ = fs::remove_dir(&waiting);
            return Ok(Some(dispatch));
        }
        fs::remove_file(&path)?;
    }
    let _ = fs::remove_dir(&waiting);
    Ok(None)
}

/// Bound callers only receive their own candidate's result.
pub fn next_failure(
    framework: &Path,
    followed: Option<(&Attempt, &ProcessIdentity)>,
    deadline: Option<Instant>,
) -> io::Result<Option<StartupFailure>> {
    if deadline.is_some_and(|until| Instant::now() >= until) {
        return Ok(None);
    }
    match followed {
        Some((attempt, daemon)) => Ok(attempt
            .candidate_failure(daemon)
            .map(StartupFailure::Followed)),
        None => Ok(take_failure(framework, deadline)?.map(StartupFailure::Dispatched)),
    }
}

pub struct AcceptedDaemon {
    pub ticket: Option<Ticket>,
}

/// Verifies and registers the actual lock holder before allowing detach to return.
pub fn accept_detach(framework: &Path) -> io::Result<Option<AcceptedDaemon>> {
    let Some(daemon) = service::lock_record(framework, Service::Daemon)? else {
        return Ok(None);
    };
    let running = || matches!(presence(&daemon), Ok(Presence::Running));
    let root = directory(framework);
    if !root.is_dir() {
        return Ok(running().then_some(AcceptedDaemon { ticket: None }));
    }
    let _ordering = try_startup_order(&root)?;
    if service::lock_record(framework, Service::Daemon)?.as_ref() != Some(&daemon) || !running() {
        return Ok(None);
    }
    let keeper = service::live_holder(framework, Service::Keeper)?;
    let attempt = Attempt::current(framework).filter(|attempt| {
        attempt.follows(&daemon)
            || keeper
                .as_ref()
                .is_some_and(|keeper| attempt.in_progress() && attempt.belongs_to_keeper(keeper))
    });
    let ticket = if let Some(attempt) = attempt {
        attempt.remember_detach_locked(&daemon)?;
        (!attempt.daemon_ready(&daemon)).then(|| attempt.ticket(&daemon))
    } else {
        None
    };
    Ok(Some(AcceptedDaemon { ticket }))
}

/// A late report can only acknowledge the exact dispatch, in its original generation.
pub fn acknowledge(framework: &Path, dispatch: &DispatchedFailure) -> io::Result<()> {
    let failure = &dispatch.failure;
    let Some(attempt) = Attempt::of(framework, &failure.generation) else {
        return Ok(());
    };
    if valid_birth(&failure.process.birth) {
        let process = process_file(&failure.process);
        let dispatched = attempt.directory.join(format!("dispatched-{process}"));
        if load::<DispatchedFailure>(&dispatched).as_ref() == Some(dispatch) {
            save(
                &attempt.directory.join(format!("reported-{process}")),
                dispatch,
            )?;
        }
    }
    Ok(())
}

pub fn live(framework: &Path) -> io::Result<bool> {
    Ok(service::live_holder(framework, Service::Keeper)?.is_some()
        || service::live_holder(framework, Service::Daemon)?.is_some())
}

fn open_lease(path: &Path, create: bool) -> io::Result<Option<File>> {
    let mut options: OpenOptions = files::private_options();
    options.read(true).write(true).create(create);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
        match options.open(path) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.raw_os_error() == Some(32) => Ok(None),
            Err(error) => Err(error),
        }
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let file = options.open(path)?;
        // SAFETY: flock operates on this open descriptor. Closing each inherited descriptor
        // releases its reference to the lock; an explicit unlock would release them all.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(file));
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Home(PathBuf);

    impl Home {
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("facade-startup-test-{:016x}", crate::random_u64())),
            )
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn startup_order_releases_its_lock_with_an_inherited_descriptor() {
        let home = Home::new();
        let order = startup_order(&home.0).unwrap();
        let inherited = order.0.try_clone().unwrap();
        assert!(matches!(
            try_startup_order(&home.0),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock
        ));
        drop(order);
        assert!(try_startup_order(&home.0).is_ok());
        drop(inherited);
    }

    #[test]
    fn two_accepted_failures_are_dispatched_in_order() {
        let home = Home::new();
        let attempt = Attempt::begin(&home.0).unwrap();
        let make = |pid| ProcessIdentity {
            pid,
            birth: format!("candidate-{pid}"),
        };
        let first = make(10_000_001);
        let second = make(10_000_002);
        attempt.remember_detach(&first).unwrap();
        attempt
            .fail_daemon(&first, home.0.join("daemon.log"), "first startup")
            .unwrap();
        attempt.remember_detach(&second).unwrap();
        attempt
            .fail_daemon(&second, home.0.join("daemon.log"), "second startup")
            .unwrap();
        assert_eq!(peek_failure(&home.0).unwrap().unwrap().process, first);
        let a = take_failure(&home.0, None).unwrap().unwrap();
        let b = take_failure(&home.0, None).unwrap().unwrap();
        assert_eq!(
            (a.failure.process.clone(), b.failure.process.clone()),
            (first, second)
        );
        acknowledge(&home.0, &a).unwrap();
        assert!(take_failure(&home.0, None).unwrap().is_none());
        assert_eq!(
            attempt.candidate_failure(&b.failure.process),
            Some(b.failure)
        );
    }

    #[test]
    fn an_accepted_candidate_precedes_an_earlier_generic_failure() {
        let home = Home::new();
        let first = Attempt::begin(&home.0).unwrap();
        first
            .launch_failed(&home.0, "starting the keeper", "failed creation")
            .unwrap();
        let second = Attempt::begin(&home.0).unwrap();
        let accepted = ProcessIdentity {
            pid: 10_000_001,
            birth: "accepted".into(),
        };
        second.remember_detach(&accepted).unwrap();
        second
            .fail_daemon(&accepted, home.0.join("daemon.log"), "after detach")
            .unwrap();
        let first_dispatched = take_failure(&home.0, None).unwrap().unwrap();
        let second_dispatched = take_failure(&home.0, None).unwrap().unwrap();
        assert_eq!(first_dispatched.failure.process, accepted);
        assert_eq!(first_dispatched.failure.reason, "after detach");
        assert_eq!(second_dispatched.failure.reason, "failed creation");
    }

    #[test]
    fn a_paused_follower_retains_its_result_after_the_global_dispatch_moves_on() {
        let home = Home::new();
        let attempt = Attempt::begin(&home.0).unwrap();
        let first = ProcessIdentity {
            pid: 10_000_001,
            birth: "old".into(),
        };
        let later = ProcessIdentity {
            pid: 10_000_002,
            birth: "later".into(),
        };
        attempt.remember_detach(&first).unwrap();
        attempt
            .fail_daemon(&first, home.0.join("daemon.log"), "original failure")
            .unwrap();
        assert_eq!(
            take_failure(&home.0, None)
                .unwrap()
                .unwrap()
                .failure
                .process,
            first
        );
        attempt.remember_detach(&later).unwrap();
        attempt
            .fail_daemon(&later, home.0.join("daemon.log"), "later failure")
            .unwrap();
        let Some(StartupFailure::Followed(failure)) =
            next_failure(&home.0, Some((&attempt, &first)), None).unwrap()
        else {
            panic!("the follower did not receive its own result")
        };
        assert_eq!(failure.reason, "original failure");
        assert_eq!(
            take_failure(&home.0, None)
                .unwrap()
                .unwrap()
                .failure
                .process,
            later
        );
    }

    #[test]
    fn failure_observation_returns_while_startup_order_is_held() {
        let home = Home::new();
        let attempt = Attempt::begin(&home.0).unwrap();
        attempt
            .launch_failed(&home.0, "starting the keeper", "failed creation")
            .unwrap();
        let order = startup_order(&directory(&home.0)).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let peek = peek_failure(&home.0).unwrap_err().kind();
                let take = take_failure(&home.0, None).unwrap_err().kind();
                let _ = send.send((peek, take));
            });
            let result = receive.recv_timeout(Duration::from_secs(2));
            drop(order);
            assert_eq!(
                result.unwrap(),
                (io::ErrorKind::WouldBlock, io::ErrorKind::WouldBlock)
            );
        });
        assert!(take_failure(&home.0, None).unwrap().is_some());
    }

    #[test]
    fn reserve_seals_a_proven_creation_that_never_took_the_daemon_lock() {
        let home = Home::new();
        let attempt = Attempt::begin(&home.0).unwrap();
        let daemon = ProcessIdentity {
            pid: 10_000_001,
            birth: "created".into(),
        };
        attempt.daemon_created(&daemon).unwrap();
        assert!(Attempt::reserve(&home.0).unwrap().is_none());
        assert!(!attempt.in_progress());
        let outcome = take_failure(&home.0, None).unwrap().unwrap().failure;
        assert_eq!(outcome.process, daemon);
        assert_eq!(attempt.candidate_failure(&daemon), Some(outcome));
        let next = Attempt::reserve(&home.0).unwrap().unwrap();
        assert_ne!(next.attempt.generation(), attempt.generation());
    }

    #[test]
    fn replacing_a_candidate_keeps_older_authenticated_progress_and_original_origin() {
        let home = Home::new();
        let mut attempt = Attempt::begin(&home.0).unwrap();
        attempt.origin.started = now().saturating_sub(nanos(Duration::from_secs(86)));
        save(&attempt.directory.join("origin"), &attempt.origin).unwrap();
        let at = |seconds| attempt.origin.started + nanos(Duration::from_secs(seconds));
        let phase = |seconds, name: &str| Progress {
            at: at(seconds),
            writer: own_identity().unwrap(),
            stage: name.into(),
            ready: false,
        };
        attempt.publish_window(&phase(5, "keeper created")).unwrap();
        attempt
            .publish_window(&phase(60, "recovering existing records"))
            .unwrap();
        let handoff = Attempt::current(&home.0).unwrap();
        let original = handoff.status().0;
        assert!(handoff.can_continue());
        assert_eq!(original.end(), at(135));
        assert_eq!(original.hard(), at(180));
        handoff
            .publish_window(&phase(5, "duplicated early snapshot"))
            .unwrap();
        assert_eq!(handoff.status().0.end(), original.end());
        assert!(original.exhausted_at(at(135)));
    }

    #[test]
    fn later_progress_moves_only_the_idle_deadline() {
        let t0 = 1_000_000_000;
        let elapsed = |seconds| t0 + nanos(Duration::from_secs(seconds));
        let budget = |advanced| Budget {
            started: t0,
            advanced: elapsed(advanced),
        };

        assert_eq!(budget(0).end(), elapsed(75));
        assert_eq!(budget(70).end(), elapsed(145));
        assert_eq!(budget(110).end(), elapsed(180));
        assert_eq!(
            budget(175).end() - elapsed(175),
            nanos(Duration::from_secs(5))
        );
        assert_eq!(
            budget(70).limit_reason(),
            "startup made no progress for 75 seconds"
        );
        assert_eq!(
            budget(110).limit_reason(),
            "the 180-second startup limit elapsed"
        );
    }

    #[test]
    fn converting_an_expired_startup_never_moves_its_deadline_into_the_future() {
        let budget = Budget {
            started: 1,
            advanced: 1,
        };
        let before = Instant::now();
        assert!(budget.exhausted() && budget.deadline() <= before);
    }
}
