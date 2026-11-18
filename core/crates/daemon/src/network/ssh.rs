//! The pipes of one background SSH session and the diagnostics it leaves on stderr.

use std::io;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;

const STDERR_BYTES: usize = 32 * 1024;
const EXIT_GRACE: Duration = Duration::from_millis(250);
pub(super) const RETRY_AFTER: Duration = Duration::from_secs(10);

pub(super) struct Pipes {
    pub(super) read: BufReader<ChildStdout>,
    pub(super) write: ChildStdin,
    pub(super) process: Process,
}

impl Pipes {
    pub(super) fn spawn(mut command: Command) -> io::Result<Self> {
        #[cfg(windows)]
        let (read, write) = {
            let stdio = facade_base::ssh::ssh_stdio()?;
            command.stdin(stdio.stdin).stdout(stdio.stdout);
            (
                ChildStdout::from_std(stdio.from_ssh)?,
                ChildStdin::from_std(stdio.to_ssh)?,
            )
        };
        #[cfg(not(windows))]
        command.stdin(Stdio::piped()).stdout(Stdio::piped());
        let mut child = command.stderr(Stdio::piped()).kill_on_drop(true).spawn()?;
        #[cfg(not(windows))]
        let (read, write) = (
            child.stdout.take().expect("piped SSH stdout"),
            child.stdin.take().expect("piped SSH stdin"),
        );
        let read = BufReader::new(read);
        let mut stderr = child.stderr.take().expect("piped SSH stderr");
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let output = diagnostics.clone();
        let drain = tokio::spawn(async move {
            let mut chunk = [0; 4096];
            while let Ok(count) = stderr.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                let mut output = output.lock().unwrap();
                let excess = (output.len() + count).saturating_sub(STDERR_BYTES);
                output.drain(..excess);
                output.extend_from_slice(&chunk[..count]);
            }
        });
        Ok(Self {
            read,
            write,
            process: Process {
                child,
                drain,
                diagnostics,
            },
        })
    }
}

pub(super) struct Process {
    child: Child,
    drain: JoinHandle<()>,
    diagnostics: Arc<Mutex<Vec<u8>>>,
}

impl Process {
    /// Lets an exiting client report its last error. The session's pipe ends have already closed.
    pub(super) async fn finish(mut self) -> Diagnostics {
        let status = match tokio::time::timeout(EXIT_GRACE, self.child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                let _ = self.child.start_kill();
                None
            }
        };
        let _ = tokio::time::timeout(EXIT_GRACE, &mut self.drain).await;
        let stderr = String::from_utf8_lossy(&self.diagnostics.lock().unwrap()).into_owned();
        Diagnostics { status, stderr }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.drain.abort();
    }
}

pub(super) struct Diagnostics {
    pub(super) status: Option<ExitStatus>,
    pub(super) stderr: String,
}

impl Diagnostics {
    pub(super) fn needs_interaction(&self) -> bool {
        let stderr = self.stderr.to_ascii_lowercase();
        [
            "permission denied (",
            "too many authentication failures",
            "no supported authentication methods",
            "host key verification failed",
            "remote host identification has changed",
            "no matching host key is known for",
        ]
        .iter()
        .any(|reason| stderr.contains(reason))
    }

    pub(super) fn missing_facade(&self) -> bool {
        let stderr = self.stderr.to_ascii_lowercase();
        matches!(self.status.and_then(|s| s.code()), Some(127 | 9009))
            || [
                "facade: command not found",
                "facade: not found",
                "'facade' is not recognized",
                "facade: the term",
            ]
            .iter()
            .any(|reason| stderr.contains(reason))
    }
}
