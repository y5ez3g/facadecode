//! Opens one saved SSH session and negotiates the remote Facade entry point.

use std::io;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::api_v1::{ErrorBody, MAX_LINE_BYTES};
use facade_base::machine::SshInteraction;
use facade_base::ssh::{
    BOOTSTRAP_INSTALL, BOOTSTRAP_READY, BOOTSTRAP_SERVE, BootstrapAction, REMOTE_BOOTSTRAP_BEGIN,
    REMOTE_PLATFORM_PROBE, RemoteLoginShell, RemoteProbe, SshMode, bootstrap_action,
    parse_remote_platform, parse_remote_probe, remote_install_command,
    remote_login_bootstrap_command, ssh_login_args,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;

use super::{SavedSsh, wire};

const STDERR_BYTES: usize = 32 * 1024;
const EXIT_GRACE: Duration = Duration::from_millis(250);

pub(super) struct FailedAttempt {
    pub(super) error: ErrorBody,
    pub(super) sleeping: bool,
    pub(super) ssh_error: Option<String>,
    pub(super) interaction: Option<SshInteraction>,
}

impl From<ErrorBody> for FailedAttempt {
    fn from(error: ErrorBody) -> Self {
        Self {
            error,
            sleeping: false,
            ssh_error: None,
            interaction: None,
        }
    }
}

impl FailedAttempt {
    pub(super) fn sleeping() -> Self {
        Self {
            error: wire::error("unavailable", "The machine is sleeping."),
            sleeping: true,
            ssh_error: None,
            interaction: None,
        }
    }

    pub(super) fn from_ssh(
        ssh: &SavedSsh,
        diagnostics: Diagnostics,
        error: ErrorBody,
        sleeping: bool,
    ) -> Self {
        let ssh_error = (!diagnostics.stderr.trim().is_empty()).then(|| diagnostics.stderr.clone());
        if sleeping {
            return Self {
                ssh_error,
                ..Self::sleeping()
            };
        }
        let (error, interaction) = ssh_failure(ssh, diagnostics, error);
        Self {
            error,
            interaction,
            sleeping: false,
            ssh_error,
        }
    }
}

pub(super) struct Pipes {
    pub(super) read: BufReader<ChildStdout>,
    pub(super) write: ChildStdin,
    pub(super) process: Process,
}

impl Pipes {
    pub(super) async fn open(
        ssh: &SavedSsh,
        build: &str,
        wake: bool,
        control_dir: Option<&Path>,
    ) -> Result<Self, FailedAttempt> {
        let home = ssh.config.remote_home.as_deref();
        let args = ssh_login_args(&ssh.argv, SshMode::Saved, control_dir)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let mut command = Command::from(facade_base::programs::command("ssh"));
        // Keep OpenSSH's diagnostics recognizable while retaining their original text.
        command.args(args).env("LC_ALL", "C");
        let mut pipes = Self::spawn(command).map_err(|error| {
            let reason = if error.kind() == io::ErrorKind::NotFound {
                "not_found"
            } else {
                "unavailable"
            };
            wire::error(reason, format!("Could not start SSH: {error}"))
        })?;
        let (shell, probe) = match wire::in_time(pipes.probe(home, build, wake)).await {
            Ok(probed) => probed,
            Err(error) => {
                return Err(FailedAttempt::from_ssh(
                    ssh,
                    pipes.finish().await,
                    error,
                    false,
                ));
            }
        };
        let action = bootstrap_action(&probe, wake);
        let ready = match action {
            BootstrapAction::Serve => wire::in_time(pipes.serve(BOOTSTRAP_SERVE)).await,
            BootstrapAction::Install => pipes.serve(BOOTSTRAP_INSTALL).await,
            BootstrapAction::NeedsInstall => {
                return Err(wire::error(
                    "not_found",
                    "Facade is not installed on the remote machine. Connect to it explicitly to install Facade.",
                ).into());
            }
        };
        match ready {
            Ok(()) => Ok(pipes),
            Err(error) => {
                let diagnostics = pipes.finish().await;
                let sleeping = !wake
                    && error.data.reason == "unavailable"
                    && diagnostics.exit_code() == Some(3);
                let mut failure = FailedAttempt::from_ssh(ssh, diagnostics, error, sleeping);
                if action == BootstrapAction::Install
                    && let Ok(command) = remote_install_command(shell.system(), build, home)
                {
                    failure.error.message.push_str(&format!(
                        "\nTo install Facade manually on {}, run:\n{command}",
                        ssh.config.ssh_destination,
                    ));
                }
                Err(failure)
            }
        }
    }

    fn spawn(mut command: Command) -> io::Result<Self> {
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

    async fn probe(
        &mut self,
        home: Option<&str>,
        build: &str,
        wake: bool,
    ) -> Result<(RemoteLoginShell, RemoteProbe), ErrorBody> {
        self.send(REMOTE_PLATFORM_PROBE).await?;
        let shell = find_login_line(
            &mut self.read,
            parse_remote_platform,
            "SSH closed before identifying the remote login shell.",
        )
        .await?;
        let command = remote_login_bootstrap_command(shell, home, build, wake)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        self.send(command.as_bytes()).await?;
        find_login_line(
            &mut self.read,
            |line| (line == REMOTE_BOOTSTRAP_BEGIN).then_some(()),
            "SSH closed before the remote Facade bootstrap began.",
        )
        .await?;
        let line = read_control(&mut self.read).await?.ok_or_else(|| {
            wire::error(
                "unavailable",
                "SSH closed before reporting the remote Facade version.",
            )
        })?;
        let line = std::str::from_utf8(&line)
            .map_err(|_| ErrorBody::invalid_argument("Expected a UTF-8 Facade version line."))?;
        let probe = parse_remote_probe(line)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        Ok((shell, probe))
    }

    async fn send(&mut self, bytes: &[u8]) -> Result<(), ErrorBody> {
        self.write.write_all(bytes).await.map_err(wire::io_error)?;
        self.write.flush().await.map_err(wire::io_error)
    }

    async fn serve(&mut self, action: &[u8]) -> Result<(), ErrorBody> {
        self.send(action).await?;
        match read_control(&mut self.read).await? {
            Some(line) if line == BOOTSTRAP_READY.as_bytes() => Ok(()),
            Some(_) => Err(ErrorBody::invalid_argument(
                "Expected the remote Facade bootstrap to report ready.",
            )),
            None => Err(wire::error(
                "unavailable",
                "SSH closed before the remote Facade bootstrap was ready.",
            )),
        }
    }

    async fn finish(self) -> Diagnostics {
        let Self {
            read,
            write,
            process,
        } = self;
        drop((read, write));
        process.finish().await
    }
}

async fn find_login_line<T>(
    read: &mut BufReader<ChildStdout>,
    parse: impl Fn(&[u8]) -> Option<T>,
    closed: &str,
) -> Result<T, ErrorBody> {
    while let Some(line) = read_control(read).await? {
        if let Some(value) = parse(&line) {
            return Ok(value);
        }
    }
    Err(wire::error("unavailable", closed))
}

async fn read_control(read: &mut BufReader<ChildStdout>) -> Result<Option<Vec<u8>>, ErrorBody> {
    let mut line = Vec::new();
    let bytes = read
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut line)
        .await
        .map_err(wire::io_error)?;
    if bytes == 0 {
        return Ok(None);
    }
    if bytes > MAX_LINE_BYTES {
        return Err(ErrorBody::line_too_long());
    }
    if line.pop() != Some(b'\n') {
        return Err(ErrorBody::invalid_argument(
            "Incomplete remote Facade bootstrap line.",
        ));
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Some(line))
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
    pub(super) fn exit_code(&self) -> Option<i32> {
        self.status.and_then(|status| status.code())
    }

    pub(super) fn needs_interaction(&self) -> bool {
        if self.exit_code() != Some(255) {
            return false;
        }
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
}

fn ssh_failure(
    ssh: &SavedSsh,
    diagnostics: Diagnostics,
    mut error: ErrorBody,
) -> (ErrorBody, Option<SshInteraction>) {
    let config = &ssh.config;
    if !matches!(
        error.data.reason.as_str(),
        "unavailable" | "invalid_argument"
    ) {
        return (error, None);
    }
    if diagnostics.needs_interaction() {
        let mut command = vec!["facade".to_owned(), "machine".to_owned(), "add".to_owned()];
        if let Some(home) = &config.remote_home {
            command.extend(["--home".to_owned(), home.clone()]);
        }
        command.extend(ssh.argv.iter().cloned());
        let interaction = SshInteraction {
            reason: diagnostics.stderr,
            command,
        };
        let mut error = wire::error("ssh_interaction_required", "SSH needs interaction.");
        wire::detail(&mut error, "message", serde_json::json!(interaction.reason));
        wire::detail(
            &mut error,
            "command",
            serde_json::json!(interaction.command),
        );
        return (error, Some(interaction));
    }
    if !diagnostics.stderr.trim().is_empty() {
        if error.data.reason == "unavailable"
            && diagnostics.status.is_some_and(|status| !status.success())
        {
            error.message = diagnostics.stderr;
        } else {
            error.message.push('\n');
            error.message.push_str(&diagnostics.stderr);
        }
    }
    (error, None)
}
