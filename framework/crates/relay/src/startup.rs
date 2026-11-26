//! The local startup status published by Base. Relay keeps its own transport and MCP handshake.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};

use serde_json::Value;

#[cfg(not(target_os = "macos"))]
use crate::relay::monotonic_now;

/// Reads the same Darwin clock used for the startup deadlines published by Base.
#[cfg(target_os = "macos")]
fn monotonic_now() -> u64 {
    use nix::time::{ClockId, clock_gettime};
    let Ok(time) = clock_gettime(ClockId::from_raw(nix::libc::CLOCK_MONOTONIC_RAW)) else {
        return 0;
    };
    let seconds = u64::try_from(time.tv_sec()).unwrap_or(0);
    let nanos = u64::try_from(time.tv_nsec()).unwrap_or(0);
    seconds.saturating_mul(1_000_000_000).saturating_add(nanos)
}

const MAX_RECORD: u64 = 16 * 1024;

#[derive(Clone)]
pub(crate) struct Ticket {
    pub(crate) generation: String,
    pid: u32,
    birth: String,
    idle: u64,
    hard: u64,
    pub(crate) diagnosed: bool,
}

pub(crate) struct View {
    pub(crate) status: String,
    pub(crate) detail: String,
}

/// A temporary startup operation whose completion can wake the relay loop.
pub(crate) struct Task<T> {
    result: Receiver<io::Result<T>>,
    #[cfg(unix)]
    pub(crate) wake: std::io::PipeReader,
}

impl<T: Send + 'static> Task<T> {
    pub(crate) fn start(
        run: impl FnOnce() -> io::Result<T> + Send + 'static,
        #[cfg(windows)] wake: impl FnOnce() + Send + 'static,
    ) -> io::Result<Self> {
        #[cfg(unix)]
        let (wake, notify) = std::io::pipe()?;
        #[cfg(unix)]
        let notify = move || {
            use std::io::Write as _;
            let _ = (&notify).write_all(b"\n");
        };
        #[cfg(windows)]
        let notify = wake;

        let (send, result) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("relay-start".into())
            .spawn(move || {
                let _ = send.send(run());
                notify();
            })?;
        Ok(Self {
            result,
            #[cfg(unix)]
            wake,
        })
    }

    pub(crate) fn completed(&self) -> Option<io::Result<T>> {
        match self.result.try_recv() {
            Ok(result) => Some(result),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Err(io::Error::other("startup worker ended"))),
        }
    }
}

fn text(path: &Path) -> Option<String> {
    let mut contents = String::new();
    File::open(path)
        .ok()?
        .take(MAX_RECORD + 1)
        .read_to_string(&mut contents)
        .ok()?;
    (u64::try_from(contents.len()).ok()? <= MAX_RECORD).then_some(contents)
}

fn generation_is_valid(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn birth_is_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

impl Ticket {
    pub(crate) fn from_stdout(stdout: &str) -> Option<Self> {
        let line = stdout
            .lines()
            .find_map(|line| line.strip_prefix("facade-startup-locked "))?;
        let value: Value = serde_json::from_str(line).ok()?;
        let generation = value.get("generation")?.as_str()?.to_owned();
        let pid = u32::try_from(value.get("pid")?.as_u64()?).ok()?;
        let birth = value.get("birth")?.as_str()?.to_owned();
        let idle = value.get("idle")?.as_u64()?;
        let hard = value.get("hard")?.as_u64()?;
        (generation_is_valid(&generation) && birth_is_valid(&birth) && pid != 0).then_some(Self {
            generation,
            pid,
            birth,
            idle,
            hard,
            diagnosed: false,
        })
    }

    fn view_path(&self, framework: &Path) -> PathBuf {
        framework
            .join("startup")
            .join(&self.generation)
            .join(format!(
                "view-{}-{}",
                self.pid,
                self.birth.replace(':', "_")
            ))
    }

    pub(crate) fn refresh_window(&mut self, framework: &Path) -> Option<String> {
        let (idle, hard, detail) = window(framework, &self.generation)?;
        if hard != self.hard || idle < self.idle {
            return None;
        }
        self.idle = idle;
        Some(detail)
    }

    pub(crate) fn view(&self, framework: &Path) -> Option<View> {
        let contents = text(&self.view_path(framework))?;
        let (head, detail) = contents.split_once('\n')?;
        let mut fields = head.split('\t');
        let version = fields.next()?;
        let generation = fields.next()?;
        let pid = fields.next()?.parse::<u32>().ok()?;
        let birth = fields.next()?;
        let at = fields.next()?.parse::<u64>().ok()?;
        let status = fields.next()?.to_owned();
        (version == "2"
            && generation == self.generation
            && pid == self.pid
            && birth == self.birth
            && at <= monotonic_now()
            && matches!(status.as_str(), "starting" | "ready" | "failed")
            && fields.next().is_none())
        .then(|| View {
            status,
            detail: detail.to_owned(),
        })
    }

    pub(crate) fn lock_matches(&self, framework: &Path, peer: u32) -> bool {
        peer == self.pid
            && daemon_lock(framework).is_some_and(|(pid, birth)| pid == peer && birth == self.birth)
            && current_generation(framework).as_deref() == Some(self.generation.as_str())
    }

    pub(crate) fn replacement(&self, framework: &Path) -> Option<Ticket> {
        let generation = current_generation(framework)?;
        let (pid, birth) = daemon_lock(framework)?;
        if !generation_is_valid(&generation) || (pid == self.pid && birth == self.birth) {
            return None;
        }
        let (idle, hard, _) = window(framework, &generation)?;
        if generation == self.generation && hard != self.hard {
            return None;
        }
        Some(Self {
            generation,
            pid,
            birth,
            idle,
            hard,
            diagnosed: false,
        })
    }

    pub(crate) fn until(&self) -> Instant {
        Instant::now()
            + Duration::from_nanos(self.idle.min(self.hard).saturating_sub(monotonic_now()))
    }

    pub(crate) fn expired(&self) -> bool {
        monotonic_now() >= self.idle.min(self.hard)
    }

    pub(crate) fn ten_seconds_in(&self) -> bool {
        monotonic_now() >= self.hard.saturating_sub(170_000_000_000)
    }
}

fn window(framework: &Path, generation: &str) -> Option<(u64, u64, String)> {
    let file = framework.join("startup").join(generation).join("window");
    let value: Value = serde_json::from_str(&text(&file)?).ok()?;
    let progress = value.get("progress")?;
    let at = progress.get("at")?.as_u64()?;
    let idle = value.get("idle")?.as_u64()?;
    let hard = value.get("hard")?.as_u64()?;
    (value.get("generation")?.as_str()? == generation
        && at <= monotonic_now()
        && idle == at.saturating_add(75_000_000_000)
        && at < hard)
        .then_some((idle, hard, progress.get("stage")?.as_str()?.to_owned()))
}

fn current_generation(framework: &Path) -> Option<String> {
    let contents = text(&framework.join("startup/current"))?;
    let id = contents.trim();
    generation_is_valid(id).then(|| id.to_owned())
}

fn daemon_lock(framework: &Path) -> Option<(u32, String)> {
    let contents = text(&framework.join("daemon.lock"))?;
    let identity: Value = serde_json::from_str(&contents).ok()?;
    let pid = u32::try_from(identity.get("pid")?.as_u64()?).ok()?;
    let birth = identity.get("birth")?.as_str()?;
    birth_is_valid(birth).then(|| (pid, birth.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_expired_ticket_is_expired_on_every_observation() {
        let ticket = Ticket {
            generation: "0000000000000001".into(),
            pid: 1,
            birth: "holder".into(),
            idle: 1,
            hard: 2,
            diagnosed: false,
        };
        assert!((0..20).all(|_| ticket.expired()));
    }
}
