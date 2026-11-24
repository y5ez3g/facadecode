//! What processes use: CPU, memory, handles, threads and how often their threads were switched to.

use std::time::Instant;

use facade_scenarios::serde_json::{Value, json};

/// One process at one moment.
#[derive(Clone, Copy, Debug, Default)]
pub struct Usage {
    pub cpu_s: f64,
    /// Its commit charge.
    pub private_mb: f64,
    pub handles: u32,
    pub threads: u32,
    /// How often its running threads were switched to, in all: each wake is one.
    pub switches: u64,
}

/// What `pids` use now, in their order.
pub fn usage(pids: &[i32]) -> Vec<Option<Usage>> {
    let all = imp::all();
    pids.iter()
        .map(|pid| {
            all.iter()
                .find(|(each, _)| each == pid)
                .map(|(_, usage)| *usage)
        })
        .collect()
}

pub fn one(pid: i32) -> Usage {
    usage(&[pid])[0].unwrap_or_default()
}

/// What a process used over a while.
pub struct Over {
    pid: i32,
    began: Instant,
    before: Usage,
}

impl Over {
    pub fn start(pid: i32) -> Over {
        Over {
            pid,
            began: Instant::now(),
            before: one(pid),
        }
    }

    /// Seconds of CPU since the start.
    pub fn cpu_s(&self) -> f64 {
        one(self.pid).cpu_s - self.before.cpu_s
    }

    pub fn end(&self) -> Value {
        let after = one(self.pid);
        let seconds = self.began.elapsed().as_secs_f64();
        json!({
            "seconds": round(seconds),
            "cpu_percent": round(100.0 * (after.cpu_s - self.before.cpu_s) / seconds),
            "cpu_ms": round(1000.0 * (after.cpu_s - self.before.cpu_s)),
            "switches_per_s": round(after.switches.saturating_sub(self.before.switches) as f64 / seconds),
            "private_mb": round(after.private_mb),
            "private_mb_grew": round(after.private_mb - self.before.private_mb),
            "handles": after.handles, "threads": after.threads,
        })
    }
}

pub fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(windows)]
mod imp {
    use super::Usage;

    #[link(name = "ntdll", kind = "raw-dylib")]
    unsafe extern "system" {
        fn NtQuerySystemInformation(
            class: u32,
            buffer: *mut core::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }

    const SYSTEM_PROCESS_INFORMATION: u32 = 5;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
    /// Where the fields read below lie in a 64-bit system's entry, and its threads' entries.
    const THREADS: usize = 256;
    const THREAD: usize = 80;

    pub fn all() -> Vec<(i32, Usage)> {
        let mut buffer = vec![0u8; 1 << 21];
        loop {
            let mut needed = 0u32;
            // SAFETY: the system writes at most `buffer.len()` bytes into it.
            let status = unsafe {
                NtQuerySystemInformation(
                    SYSTEM_PROCESS_INFORMATION,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut needed,
                )
            };
            if status == STATUS_INFO_LENGTH_MISMATCH {
                buffer = vec![0u8; (needed as usize).max(buffer.len()) * 2];
                continue;
            }
            if status != 0 {
                return Vec::new();
            }
            break;
        }
        let u32_at = |at: usize| u32::from_le_bytes(buffer[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(buffer[at..at + 8].try_into().unwrap());
        let mut out = Vec::new();
        let mut at = 0usize;
        loop {
            let threads = u32_at(at + 4);
            let switches = (0..threads as usize)
                .map(|n| u64::from(u32_at(at + THREADS + n * THREAD + 64)))
                .sum();
            out.push((
                u64_at(at + 80) as i32,
                Usage {
                    cpu_s: (u64_at(at + 40) + u64_at(at + 48)) as f64 / 10_000_000.0,
                    private_mb: u64_at(at + 200) as f64 / (1024.0 * 1024.0),
                    handles: u32_at(at + 96),
                    threads,
                    switches,
                },
            ));
            match u32_at(at) {
                0 => break,
                next => at += next as usize,
            }
        }
        out
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Usage;

    /// Storms run on Windows; elsewhere nothing is measured.
    pub fn all() -> Vec<(i32, Usage)> {
        Vec::new()
    }
}
