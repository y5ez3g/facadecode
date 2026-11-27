//! Machine commands and the foreground SSH connection.

use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::net::Shutdown;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Context as _;
use facade_base::api_v1::daemon::{
    ClientKind, ConnectFailedParams, ConnectedMachine, ConnectedParams, ConnectionKind,
    MachineConnect, MachineConnectArgs, MachineConnection, MachineRemoveResult, MachineTransport,
    MachineTransportInput, SshTransport, decode_hello, decode_hello_result, methods,
    select_version,
};
use facade_base::api_v1::daemon_client::{DaemonClient, transient_transport};
use facade_base::api_v1::{
    ApiVersions, ErrorBody, MAX_LINE_BYTES, MachineMessage, RequestRead, Response, ResponseBody,
    decode_arguments, encode_line, read_machine_message, read_request,
};
use facade_base::model::terminal::display_name;
use facade_base::paths::{ClientSocket, shutdown_write_if_supported};
use facade_base::ssh::{self, BootstrapAction, RemoteLoginShell, SshMode};

use crate::errors::{self, Problem, ServeFailure, about_connection, repair_command};
use crate::{MachineAction, ServeArgs, SshTarget};

mod admin;
mod roster;

// The wire representation is also checked by the existing protocol round-trip test.
#[cfg(test)]
use facade_base::api_v1::daemon::MachineListResult;

// Leave time for the person's SSH prompts before the daemon's machine handshake starts.
const SSH_LOGIN_PROBE_TIMEOUT: Duration = Duration::from_secs(120);

/// The native console interruption status Windows reports if SSH takes Ctrl+C first.
const CONSOLE_INTERRUPTED: i32 = 0xC000_013A_u32 as i32;

#[derive(Debug)]
struct ConsoleInterrupted;

impl std::fmt::Display for ConsoleInterrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("console interrupted")
    }
}

impl std::error::Error for ConsoleInterrupted {}

fn decode_home(hex: Option<String>, home: Option<PathBuf>) -> anyhow::Result<Option<PathBuf>> {
    let home = match hex {
        Some(hex) => Some(PathBuf::from(
            ssh::decode_home_hex(&hex)
                .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?,
        )),
        None => home,
    };
    if let Some(path) = &home
        && (!path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0))
    {
        return Err(ErrorBody::invalid_argument(ServeFailure::RelativeHome.to_string()).into());
    }
    Ok(home)
}

/// Runs the machine command with the local connection it needs.
pub(crate) fn run(
    action: MachineAction,
    connect: &dyn Fn() -> anyhow::Result<DaemonClient>,
    serve_socket: &dyn Fn(bool) -> anyhow::Result<Option<ClientSocket>>,
    select_home: &dyn Fn(Option<PathBuf>),
) -> anyhow::Result<i32> {
    match action {
        MachineAction::Add {
            target,
            bidirectional,
        } => return add(target, bidirectional),
        MachineAction::Link {
            target,
            bidirectional,
        } => return admin::link(target, bidirectional, connect).or_else(interrupted_exit),
        MachineAction::Connect(target) => {
            return foreground(target, connect).or_else(interrupted_exit);
        }
        MachineAction::List => roster::list(&mut connect()?)?,
        MachineAction::Remove {
            machine,
            bidirectional,
        } => {
            let mut daemon = connect()?;
            return if bidirectional {
                admin::remove(&mut daemon, machine)
            } else {
                roster::remove(&mut daemon, machine)
            };
        }
        MachineAction::Rename { machine, name } => roster::rename(&mut connect()?, machine, name)?,
        MachineAction::Serve(ServeArgs {
            home,
            home_hex,
            no_start,
        }) => {
            select_home(decode_home(home_hex, home)?);
            return serve_stdio(
                BufReader::new(io::stdin()),
                io::stdout().lock(),
                !no_start,
                serve_socket,
            );
        }
        MachineAction::SshAdmin { home_hex, probe } => {
            select_home(decode_home(home_hex, None)?);
            if probe {
                println_or_end!("facade-ssh-admin");
                return Ok(0);
            }
            admin::serve(connect)?;
        }
    }
    Ok(0)
}

#[cfg(test)]
fn machine_list_json(listed: &MachineListResult) -> serde_json::Result<serde_json::Value> {
    serde_json::to_value(listed)
}

fn saved_ssh<'a>(
    connections: &'a [MachineConnection],
    local_id: &str,
    machine_id: &str,
) -> Option<&'a SshTransport> {
    connections
        .iter()
        .filter(|connection| {
            connection.kind == ConnectionKind::Saved
                && connection.initiator_machine_id == local_id
                && connection.machine_id == machine_id
        })
        .find_map(|connection| connection.transport.as_ref())
}

fn ssh_args(transport: &SshTransport) -> &[String] {
    if transport.ssh_args.is_empty() {
        std::slice::from_ref(&transport.ssh_destination)
    } else {
        &transport.ssh_args
    }
}

fn print_removed(removed: &MachineRemoveResult, given: &str) -> String {
    let name = display_name(removed.name.as_deref().unwrap_or(given));
    println_or_end!("Removed the saved connection to {name}.");
    if let Some(via) = &removed.via {
        println_or_end!("{name} is still reachable via {}.", display_name(via));
    }
    name
}

enum RevocationFailure {
    Elevate(PathBuf),
    Other(anyhow::Error),
}

fn revoke_key(machine_id: &str) -> Result<bool, RevocationFailure> {
    let file = ssh::authorization_file().map_err(RevocationFailure::Other)?;
    file.revoke_peer(machine_id).map_err(|error| {
        let elevation = format!(
            "writing {} requires an elevated Administrator terminal",
            file.path().display()
        );
        if file.administrators() && error.to_string() == elevation {
            RevocationFailure::Elevate(file.path().to_owned())
        } else {
            RevocationFailure::Other(error)
        }
    })
}

struct MachinePrelude {
    id: u64,
    offered: ApiVersions,
    line: Vec<u8>,
}

/// Reads the exact first frame and checks that it can open a machine session.
fn read_machine_hello(
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> anyhow::Result<Option<MachinePrelude>> {
    const EXPECTED: ServeFailure = ServeFailure::NotMachineHello;
    let mut line = Vec::new();
    let request = match read_request(input, &mut line)? {
        RequestRead::Request(request) => request,
        RequestRead::Malformed(malformed) => {
            return write_machine_refusal(output, malformed.id, malformed.error);
        }
        RequestRead::LineTooLong(error) => return write_machine_refusal(output, None, error),
        RequestRead::Eof => anyhow::bail!(EXPECTED),
    };
    anyhow::ensure!(
        line.ends_with(b"\n") && request.method == methods::HELLO,
        EXPECTED
    );
    let id = request.id.context(EXPECTED)?;
    let hello = match decode_hello(request.params) {
        Ok(hello) => hello,
        Err(error) => return write_machine_refusal(output, Some(id), error),
    };
    anyhow::ensure!(
        hello.kind == ClientKind::Machine && hello.machine.is_some(),
        EXPECTED
    );
    if let Err(error) = select_version(&hello.api_versions) {
        return write_machine_refusal(output, Some(id), error);
    }
    Ok(Some(MachinePrelude {
        id,
        offered: hello.api_versions,
        line,
    }))
}

fn write_machine_refusal(
    output: &mut impl Write,
    id: Option<u64>,
    error: ErrorBody,
) -> anyhow::Result<Option<MachinePrelude>> {
    output.write_all(&encode_line(&Response::failed(id, error)))?;
    output.flush()?;
    Ok(None)
}

/// Forwards the daemon's reply verbatim, then carries the session after a successful hello.
fn serve_stdio(
    mut input: impl BufRead + Send + 'static,
    mut output: impl Write,
    wake: bool,
    serve_socket: &dyn Fn(bool) -> anyhow::Result<Option<ClientSocket>>,
) -> anyhow::Result<i32> {
    let Some(MachinePrelude { id, offered, line }) = read_machine_hello(&mut input, &mut output)?
    else {
        return Ok(0);
    };
    let Some(mut socket) = serve_socket(wake)? else {
        return Ok(3);
    };
    socket.write_all(&line)?;
    let mut from_daemon = BufReader::new(socket.try_clone()?);
    let mut reply = Vec::new();
    let Some(MachineMessage::Response(response)) =
        read_machine_message(&mut from_daemon, &mut reply)?
    else {
        anyhow::bail!(ServeFailure::NoHelloAnswer);
    };
    anyhow::ensure!(
        reply.ends_with(b"\n") && response.id == Some(id),
        ServeFailure::InvalidHelloAnswer
    );
    let accepted = if let ResponseBody::Result(result) = response.body {
        decode_hello_result(result, &offered, ClientKind::Machine)
            .context(ServeFailure::NoSession)?;
        true
    } else {
        false
    };
    output.write_all(&reply)?;
    output.flush()?;
    if !accepted {
        return Ok(0);
    }

    let input_result = copy_to_daemon(socket.try_clone()?, None, move |to_daemon| {
        copy_serve(input, to_daemon, true)
    });
    let result = copy_serve(from_daemon, output, false);
    let _ = socket.shutdown(Shutdown::Both);
    let input_failed = input_result.try_recv().is_ok_and(|result| result.is_err());
    Ok(i32::from(result.is_err() || input_failed))
}

fn copy_serve(source: impl BufRead, destination: impl Write, to_daemon: bool) -> io::Result<()> {
    let result = copy_stream(source, destination);
    if let Err(error) = &result {
        eprintln!("{}", errors::serve_copy_ended(to_daemon, error));
    }
    result
}

/// Keeps both sides moving while the session is open. Forward any bytes already buffered, then
/// flush each new chunk as it arrives.
fn copy_stream(mut source: impl BufRead, mut destination: impl Write) -> io::Result<()> {
    loop {
        let chunk = match source.fill_buf() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if chunk.is_empty() {
            return Ok(());
        }
        destination.write_all(chunk)?;
        destination.flush()?;
        let copied = chunk.len();
        source.consume(copied);
    }
}

/// Runs the input copy on its own thread. During a foreground handshake, leave the read side
/// open until it receives the daemon's outcome, even if SSH has already closed.
fn copy_to_daemon(
    mut to_daemon: ClientSocket,
    handshake_end: Option<mpsc::Receiver<()>>,
    copy: impl FnOnce(&mut ClientSocket) -> io::Result<()> + Send + 'static,
) -> mpsc::Receiver<io::Result<()>> {
    let (input_done, input_result) = mpsc::channel();
    std::thread::spawn(move || {
        let result = copy(&mut to_daemon);
        let _ = input_done.send(result);
        if let Some(handshake_end) = handshake_end {
            // The daemon's handshake deadline also bounds the wait on Windows.
            let _ = shutdown_write_if_supported(&to_daemon);
            let _ = handshake_end.recv();
        }
        let _ = to_daemon.shutdown(Shutdown::Both);
    });
    input_result
}

struct SshSession {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    stderr: std::thread::JoinHandle<SshDiagnostics>,
}

impl SshSession {
    fn spawn(words: &[OsString], interactive: bool) -> anyhow::Result<Self> {
        let mut command = Command::new("ssh");
        command.args(words).stderr(Stdio::piped());
        let (mut child, input, output) = ssh::spawn_ssh(command).context(errors::NO_OPENSSH)?;
        let stderr = read_ssh_stderr(child.stderr.take(), interactive);
        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
            stderr,
        })
    }

    fn finish(self, kill: bool) -> anyhow::Result<(ExitStatus, SshDiagnostics)> {
        let Self {
            mut child,
            input,
            output,
            stderr,
        } = self;
        drop((input, output));
        if kill {
            let _ = child.kill();
        }
        let status = child.wait()?;
        check_interrupted(status)?;
        Ok((status, stderr.join().unwrap_or_default()))
    }
}

#[derive(Clone, Copy)]
enum Bootstrap {
    Serve,
    InstalledServe,
    Admin(ssh::SshAdminMode),
}

fn bootstrap_ssh(
    target: &SshTarget,
    words: &[OsString],
    bootstrap: Bootstrap,
    interactive: bool,
) -> anyhow::Result<SshSession> {
    let ssh_args = &target.ssh_args;
    let destination = ssh_destination(target)?;
    let home = target.home.as_deref();
    let build = &facade_base::build_id();
    let may_install = matches!(
        bootstrap,
        Bootstrap::Serve | Bootstrap::Admin(ssh::SshAdminMode::Enroll)
    );
    let command = |shell| {
        let command = match bootstrap {
            Bootstrap::Serve | Bootstrap::InstalledServe => {
                ssh::remote_login_bootstrap_command(shell, home, build, true, may_install)
            }
            Bootstrap::Admin(mode) => ssh::remote_login_admin_command(shell, home, build, mode),
        };
        command.map_err(|error| {
            if error == ssh::SshArgumentError::Home {
                anyhow::Error::new(ErrorBody::invalid_argument(error.to_string()))
            } else {
                error.into()
            }
        })
    };
    // Validate the home and release before asking SSH to log in.
    let unix_command = command(RemoteLoginShell::Unix)?;
    let mut session = SshSession::spawn(words, interactive)
        .map_err(|error| ssh_failure(destination, ssh_args, &format!("{error:#}")))?;
    let probe_login = |input: &mut ChildStdin,
                       output: &mut BufReader<ChildStdout>|
     -> anyhow::Result<_> {
        if !send_ssh(input, ssh::REMOTE_PLATFORM_PROBE)? {
            return Ok(None);
        }
        let Some(shell) = read_login_marker(output, ssh::parse_remote_platform)? else {
            return Ok(None);
        };
        let remote = match shell {
            RemoteLoginShell::Unix => unix_command,
            _ => command(shell)?,
        };
        if !send_ssh(input, remote.as_bytes())?
            || read_login_marker(output, |line| {
                (line == ssh::REMOTE_BOOTSTRAP_BEGIN).then_some(())
            })?
            .is_none()
        {
            return Ok(None);
        }
        let Some(line) = read_bootstrap_line(output)? else {
            return Ok(None);
        };
        let parse_error = |error| {
            if error == ssh::SshArgumentError::Probe {
                Problem::StartupPrints {
                    destination: display_name(destination),
                }
                .into()
            } else {
                anyhow::Error::new(error).context(format!(
                    "invalid Facade Code Framework bootstrap report from {}",
                    display_name(destination)
                ))
            }
        };
        let home = ssh::parse_remote_home(shell.system(), &line).map_err(parse_error)?;
        let Some(line) = read_bootstrap_line(output)? else {
            return Ok(None);
        };
        let probe = ssh::parse_remote_probe(std::str::from_utf8(&line)?).map_err(parse_error)?;
        let action = ssh::bootstrap_action(&probe, build, may_install).map_err(parse_error)?;
        Ok(Some((shell, home, action)))
    };
    let prelude = std::thread::scope(|scope| {
        let (report, result) = mpsc::sync_channel(1);
        let input = &mut session.input;
        let output = &mut session.output;
        scope.spawn(move || {
            let _ = report.send(probe_login(input, output));
        });
        match result.recv_timeout(SSH_LOGIN_PROBE_TIMEOUT) {
            Ok(result) => result,
            Err(error) => {
                // End this SSH process before joining the blocked probe reader.
                let _ = session.child.kill();
                match error {
                    mpsc::RecvTimeoutError::Timeout => anyhow::bail!(
                        "SSH to {} did not finish its login probe within {} seconds",
                        display_name(destination),
                        SSH_LOGIN_PROBE_TIMEOUT.as_secs()
                    ),
                    mpsc::RecvTimeoutError::Disconnected => Err(error.into()),
                }
            }
        }
    });
    let (shell, home, action) = match prelude {
        Ok(Some(setup)) => setup,
        Ok(None) => {
            let (status, stderr) = session.finish(false)?;
            return Err(stderr.login_error(status, target, destination));
        }
        Err(error) => {
            session.finish(true)?;
            return Err(error);
        }
    };
    let directive = match action {
        BootstrapAction::Serve => ssh::BOOTSTRAP_SERVE,
        BootstrapAction::Install => ssh::BOOTSTRAP_INSTALL,
        BootstrapAction::NeedsInstall => {
            session.finish(true)?;
            let destination = display_name(destination);
            return match bootstrap {
                Bootstrap::Admin(_) => Err(HelperUnavailable(destination).into()),
                _ => Err(anyhow::anyhow!(
                    "The installed Facade Code Framework on {destination} cannot open this verified connection. Update Facade Code Framework there and try again."
                )),
            };
        }
        BootstrapAction::UpgradeLocal => {
            session.finish(true)?;
            let destination = display_name(destination);
            anyhow::bail!(
                "Facade Code Framework on {destination} is newer than local build {build}. Upgrade local Facade Code Framework and retry."
            );
        }
    };
    match send_ssh(&mut session.input, directive) {
        Ok(true) => {}
        Ok(false) => {
            let (status, stderr) = session.finish(false)?;
            return Err(ssh_failure(destination, ssh_args, &stderr.reason(status)));
        }
        Err(error) => {
            session.finish(true)?;
            return Err(ssh_failure(destination, ssh_args, &error.to_string()));
        }
    }
    let reason = match read_bootstrap_line(&mut session.output) {
        Ok(Some(line)) if line.as_slice() == ssh::BOOTSTRAP_READY.as_bytes() => return Ok(session),
        Ok(Some(line)) if line.as_slice() == ssh::BOOTSTRAP_UNSUPPORTED.as_bytes() => {
            session.finish(false)?;
            return Err(HelperUnavailable(display_name(destination)).into());
        }
        Ok(Some(_)) => {
            session.finish(true)?;
            "Expected the remote Facade Code Framework bootstrap to report ready.".into()
        }
        Ok(None) => {
            let (status, stderr) = session.finish(false)?;
            if status.code() == Some(255) {
                return Err(ssh_failure(destination, ssh_args, &stderr.reason(status)));
            }
            match stderr.installer_http_status {
                Some(code) => format!("The installer download returned HTTP {code}."),
                None => stderr.reason(status),
            }
        }
        Err(error) => {
            session.finish(true)?;
            format!("{error:#}")
        }
    };
    let destination = display_name(destination);
    if action == BootstrapAction::Install {
        let command = ssh::remote_install_command(shell.system(), build, &home)?;
        Err(anyhow::anyhow!(
            "Could not install Facade Code Framework {build} on {destination}.\n{reason}\n\
             To install Facade Code Framework {build} manually on {destination}, run:\n{command}\n\
             For offline installation, use the matching release archive and SHA256SUMS with the installer's package option."
        ))
    } else {
        Err(anyhow::anyhow!(
            "Could not start Facade Code Framework on {destination}: {reason}"
        ))
    }
}

fn send_ssh(input: &mut ChildStdin, bytes: &[u8]) -> io::Result<bool> {
    match input.write_all(bytes).and_then(|()| input.flush()) {
        Ok(()) => Ok(true),
        Err(error) if transient_transport(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn read_login_marker<T>(
    source: &mut impl BufRead,
    recognize: impl Fn(&[u8]) -> Option<T>,
) -> anyhow::Result<Option<T>> {
    while let Some(line) = read_bootstrap_line(source)? {
        if let Some(marker) = recognize(&line) {
            return Ok(Some(marker));
        }
    }
    Ok(None)
}

fn read_bootstrap_line(source: &mut impl BufRead) -> anyhow::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let bytes = source
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut line)?;
    if bytes == 0 {
        return Ok(None);
    }
    anyhow::ensure!(
        bytes <= MAX_LINE_BYTES && line.ends_with(b"\n"),
        "expected a complete remote Facade Code Framework bootstrap line"
    );
    line.pop();
    if line.ends_with(b"\r") {
        line.pop();
    }
    Ok(Some(line))
}

fn check_interrupted(status: ExitStatus) -> anyhow::Result<()> {
    // Unix delivers SIGINT to the foreground process group and terminates this process directly.
    // An ordinary SSH exit (including 130 or 255) only describes the connection.
    anyhow::ensure!(
        status.code() != Some(CONSOLE_INTERRUPTED),
        ConsoleInterrupted
    );
    Ok(())
}

fn ssh_destination(target: &SshTarget) -> anyhow::Result<&str> {
    ssh::parse_ssh_destination(&target.ssh_args)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()).into())
}

fn protected_login(target: &SshTarget, mode: SshMode) -> anyhow::Result<Vec<OsString>> {
    ssh::admin_login_args(&target.ssh_args, mode)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()).into())
}

fn batch_serve(target: &SshTarget) -> anyhow::Result<SshSession> {
    batch_session(target, Bootstrap::Serve)
}

fn batch_session(target: &SshTarget, bootstrap: Bootstrap) -> anyhow::Result<SshSession> {
    bootstrap_ssh(
        target,
        &protected_login(target, SshMode::Saved)?,
        bootstrap,
        false,
    )
}

fn proved_serve(
    target: &SshTarget,
    home: &std::path::Path,
    identity: &ssh::DedicatedIdentity,
) -> anyhow::Result<SshSession> {
    let proof = ssh::SshKeyProof::new(home, identity)?;
    let session = bootstrap_ssh(
        target,
        &proof.login_args(&target.ssh_args)?,
        Bootstrap::InstalledServe,
        false,
    )?;
    if let Err(error) = proof.verify() {
        session.finish(true)?;
        return Err(error);
    }
    Ok(session)
}

fn is_full_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(at, byte)| {
            if matches!(at, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn interrupted_exit(error: anyhow::Error) -> anyhow::Result<i32> {
    if error.is::<ConsoleInterrupted>() {
        Ok(CONSOLE_INTERRUPTED)
    } else {
        Err(error)
    }
}

fn ssh_failure(destination: &str, ssh_args: &[String], why: &str) -> anyhow::Error {
    let why = why
        .strip_prefix(destination)
        .and_then(|rest| rest.strip_prefix(": "))
        .unwrap_or(why);
    let words: Vec<_> = std::iter::once("ssh".to_owned())
        .chain(ssh_args.iter().cloned())
        .collect();
    let tip = match repair_command(&words) {
        Ok(command) => format!("Check your SSH access with '{command}' and try again."),
        Err(words) => format!(
            "Check your SSH access by running 'ssh' with these arguments, one per line:\n  {}",
            words[1..].join("\n  ")
        ),
    };
    anyhow::anyhow!(
        "Could not connect to {} over SSH: {why}\n{tip}",
        display_name(destination)
    )
}

fn reconnect_tip(target: &SshTarget) -> String {
    let prefix = ["facade", "machine", "connect"];
    let mut words = prefix.map(str::to_owned).to_vec();
    if let Some(home) = &target.home {
        words.extend(["--home".into(), home.clone()]);
    }
    words.extend(target.ssh_args.iter().cloned());
    match repair_command(&words) {
        Ok(command) => format!("Reconnect with '{command}'."),
        Err(words) => format!(
            "Reconnect with 'facade machine connect' and these arguments, one per line:\n  {}",
            words[prefix.len()..].join("\n  ")
        ),
    }
}

/// Leaves the saved connection with the process that opened it once the daemon confirms it.
fn add(target: SshTarget, bidirectional: bool) -> anyhow::Result<i32> {
    let mut command = Command::new(std::env::current_exe()?);
    // Keep terminal diagnostics live, and let callers capturing this command see EOF when it
    // returns. The link can outlive the command's redirected output.
    let stderr = if io::stderr().is_terminal() {
        Stdio::inherit()
    } else {
        Stdio::piped()
    };
    command
        .args(["machine", "link"])
        .stdin(Stdio::inherit())
        .stderr(stderr)
        .stdout(Stdio::piped());
    if bidirectional {
        command.arg("--bidirectional");
    }
    if let Some(home) = target.home {
        command.arg(format!("--home={home}"));
    }
    command.args(target.ssh_args);
    ssh::keep_redirected_output_private().context("could not keep the caller's output private")?;
    let mut link = command
        .spawn()
        .context("could not start the saved machine connection")?;
    let diagnostics = link.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let _ = io::copy(&mut stderr, &mut io::stderr());
        })
    });
    let stdout = link.stdout.take().expect("machine link stdout was piped");
    let received = read_bootstrap_line(&mut BufReader::new(stdout))
        .context("could not read the saved machine connection result")
        .and_then(|receipt| {
            receipt
                .map(|line| {
                    serde_json::from_slice::<admin::Receipt>(&line)
                        .context("machine link returned an invalid connection result")
                })
                .transpose()
        });
    if let Ok(Some(receipt)) = &received {
        return Ok(receipt.print());
    }
    if received.is_err() {
        let _ = link.kill();
    }
    let status = link.wait();
    if let Some(diagnostics) = diagnostics {
        let _ = diagnostics.join();
    }
    received?;
    let status = status?;
    anyhow::ensure!(
        !status.success(),
        "machine link ended before confirming the saved connection"
    );
    Ok(status.code().unwrap_or(1))
}

fn foreground(
    target: SshTarget,
    connect: &dyn Fn() -> anyhow::Result<DaemonClient>,
) -> anyhow::Result<i32> {
    let words = ssh::ssh_login_args(&target.ssh_args, SshMode::Connect, None)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
    let daemon = connect()?;
    let session = bootstrap_ssh(&target, &words, Bootstrap::Serve, true)?;
    let mut machine = String::new();
    relay_machine(
        &target,
        ConnectionKind::Temporary,
        None,
        daemon,
        session,
        |connected| {
            if connected.first_connection {
                print_trust(&connected.machine);
            }
            machine = display_name(&connected.machine.name);
            eprintln!("Connected to {machine}. Press Ctrl+C to disconnect.");
            print_logout_cleanup(&connected.machine);
            Ok(())
        },
    )?;
    Err(anyhow::anyhow!(
        "The connection to {machine} was lost.\n{}",
        reconnect_tip(&target)
    ))
}

fn save_ssh(
    target: &SshTarget,
    daemon: DaemonClient,
    session: SshSession,
    expected: Option<String>,
) -> anyhow::Result<(ConnectedParams, std::thread::JoinHandle<()>)> {
    let target = SshTarget {
        home: target.home.clone(),
        ssh_args: target.ssh_args.clone(),
    };
    let (report, result) = mpsc::sync_channel(1);
    let runner = std::thread::spawn(move || {
        let sent = relay_machine(
            &target,
            ConnectionKind::Saved,
            expected,
            daemon,
            session,
            |connected| {
                let _ = report.send(Ok(connected));
                Ok(())
            },
        );
        if let Err(error) = sent {
            let _ = report.send(Err(error));
        }
    });
    Ok((
        result
            .recv()
            .context("machine connection ended before its result")??,
        runner,
    ))
}

fn relay_machine(
    target: &SshTarget,
    kind: ConnectionKind,
    expected_machine_id: Option<String>,
    mut daemon: DaemonClient,
    session: SshSession,
    report: impl FnOnce(ConnectedParams) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    // MachineConnect starts the daemon's handshake clock. SSH is ready to carry the hello now.
    let streams = (|| -> anyhow::Result<_> {
        let given = ssh_destination(target)?;
        daemon.disable_auto_reconnect();
        let authorized = daemon
            .call::<MachineConnect>(MachineConnectArgs {
                transport: MachineTransportInput::Ssh {
                    ssh_destination: given.to_owned(),
                    ssh_args: Some(target.ssh_args.clone()),
                    remote_home: target.home.clone(),
                },
                kind,
                expected_machine_id: expected_machine_id.clone(),
            })
            .map_err(|error| about_connection(given, error))?;
        if let Some(expected) = &expected_machine_id {
            anyhow::ensure!(
                authorized.expected_machine_id.as_ref() == Some(expected),
                "Facade Code Framework did not confirm the expected machine ID"
            );
        }
        let MachineTransport::Ssh(transport) = authorized.transport else {
            anyhow::bail!(Problem::NoSshDestination);
        };
        let (from_daemon, to_daemon) = daemon.into_stream();
        let connection = to_daemon.try_clone()?;
        Ok((
            transport.ssh_destination,
            authorized.expected_machine_id,
            from_daemon,
            to_daemon,
            connection,
        ))
    })();
    let (destination, expected_machine_id, mut from_daemon, to_daemon, connection) = match streams {
        Ok(streams) => streams,
        Err(error) => {
            session.finish(true)?;
            return Err(error);
        }
    };
    let SshSession {
        mut child,
        input: mut to_ssh,
        output: from_ssh,
        stderr: ssh_said,
    } = session;
    let (handshake_end, handshake_pending) = mpsc::channel();
    let input_result = copy_to_daemon(to_daemon, Some(handshake_pending), move |socket| {
        copy_stream(from_ssh, socket)
    });

    let result = (|| -> anyhow::Result<bool> {
        let connected = forward_hello(&mut from_daemon, &mut to_ssh);
        drop(handshake_end);
        let Some(connected) = connected.map_err(|error| about_connection(&destination, error))?
        else {
            return Ok(false);
        };
        let machine_id = &connected.machine.machine_id;
        anyhow::ensure!(
            is_full_id(machine_id)
                && expected_machine_id
                    .as_ref()
                    .is_none_or(|expected| expected == machine_id),
            "the connected machine ID did not match the expected machine ID"
        );
        report(connected)?;
        copy_to_ssh(from_daemon, to_ssh)?;
        Ok(true)
    })();

    let ssh_closed = matches!(input_result.try_recv(), Ok(Ok(_)));
    let _ = connection.shutdown(Shutdown::Both);
    if !ssh_closed {
        let _ = child.kill();
    }
    let status = child.wait()?;
    check_interrupted(status)?;
    let end = match result {
        // If the peer disappeared without a specific protocol error, explain what SSH reported.
        Err(error)
            if ssh_closed
                && error.downcast_ref::<ErrorBody>().is_some_and(|body| {
                    body.data.reason == "unavailable"
                        && body
                            .data
                            .details
                            .as_ref()
                            .is_none_or(serde_json::Map::is_empty)
                }) =>
        {
            false
        }
        result => result?,
    };
    if end {
        Ok(())
    } else {
        let why = ssh_said.join().unwrap_or_default().reason(status);
        Err(ssh_failure(&destination, &target.ssh_args, &why))
    }
}

#[derive(Default)]
struct SshDiagnostics {
    last: String,
    installer_http_status: Option<u16>,
    unknown_host: bool,
    changed_host: bool,
    authentication_denied: bool,
}

impl SshDiagnostics {
    fn note(&mut self, line: &[u8]) {
        let line = String::from_utf8_lossy(line);
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        self.unknown_host |= line.starts_with("No ")
            && line.contains(" host key is known for ")
            && line.contains("you have requested strict checking");
        self.changed_host |= line.contains("HOST IDENTIFICATION HAS CHANGED")
            || line.contains("HOST KEY HAS CHANGED");
        self.authentication_denied |= line.contains("Permission denied (");
        // curl and Windows PowerShell report the downloader's status in these forms. PowerShell
        // follows it with the call site and other details.
        let http_status = line
            .strip_prefix("curl: (22) The requested URL returned error: ")
            .or_else(|| {
                line.strip_prefix("Invoke-WebRequest : The remote server returned an error: (")
            })
            .and_then(|text| text.get(..3))
            .and_then(|code| code.parse().ok());
        if http_status.is_some() {
            self.installer_http_status = http_status;
        }
        self.last = crate::single_line(line);
    }

    fn reason(self, status: ExitStatus) -> String {
        if !self.last.is_empty() {
            self.last
        } else if status.success() {
            "SSH closed before Facade Code Framework connected.".into()
        } else {
            errors::ssh_exit(status.code())
        }
    }

    fn login_error(
        self,
        status: ExitStatus,
        target: &SshTarget,
        destination: &str,
    ) -> anyhow::Error {
        let challenge = if status.code() != Some(255) || self.changed_host {
            None
        } else if self.unknown_host {
            Some(LoginChallenge::UnknownHost)
        } else if self.authentication_denied {
            Some(LoginChallenge::Credentials)
        } else {
            None
        };
        let error = ssh_failure(destination, &target.ssh_args, &self.reason(status));
        if let Some(challenge) = challenge {
            return error.context(challenge);
        }
        error
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LoginChallenge {
    UnknownHost,
    Credentials,
}

impl std::fmt::Display for LoginChallenge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnknownHost => "SSH requires confirmation of the host key",
            Self::Credentials => "SSH requires interactive login",
        })
    }
}

#[derive(Debug)]
struct HelperUnavailable(String);

impl std::fmt::Display for HelperUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} does not support SSH administration. Update Facade Code Framework on {} and try again.",
            self.0, self.0
        )
    }
}

impl std::error::Error for HelperUnavailable {}

/// Copies SSH's stderr as it arrives, including prompts without a newline, and keeps the last
/// diagnostic for the stage that failed.
fn read_ssh_stderr(
    stderr: Option<std::process::ChildStderr>,
    interactive: bool,
) -> std::thread::JoinHandle<SshDiagnostics> {
    std::thread::spawn(move || {
        let mut diagnostic = SshDiagnostics::default();
        let Some(mut stderr) = stderr else {
            return diagnostic;
        };
        let mut line = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let read = match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let bytes = &buffer[..read];
            // A saved link may still be running after its foreground command closes the pipe.
            if interactive {
                let _ = io::stderr().write_all(bytes);
            }
            for part in bytes.split_inclusive(|&byte| byte == b'\n') {
                line.extend_from_slice(part);
                if part.ends_with(b"\n") {
                    diagnostic.note(&line);
                    line.clear();
                }
            }
        }
        diagnostic.note(&line);
        diagnostic
    })
}

/// Passes machine frames unchanged and handles the local daemon's handshake outcome.
fn forward_hello(
    from_daemon: &mut impl BufRead,
    to_ssh: &mut impl Write,
) -> anyhow::Result<Option<ConnectedParams>> {
    let mut line = Vec::new();
    let mut to_ssh = Some(to_ssh);
    while let Some(frame) = read_machine_message(from_daemon, &mut line)? {
        anyhow::ensure!(line.ends_with(b"\n"), ServeFailure::InvalidHelloAnswer);
        if let MachineMessage::Request(request) = frame
            && request.id.is_none()
        {
            match request.method.as_str() {
                methods::CONNECTED => return Ok(Some(decode_arguments(request.params)?)),
                methods::CONNECT_FAILED => {
                    let failure: ConnectFailedParams = decode_arguments(request.params)?;
                    return Err(failure.error.into());
                }
                _ => {}
            }
        }
        if let Some(writer) = to_ssh.as_mut()
            && let Err(error) = writer.write_all(&line).and_then(|()| writer.flush())
        {
            if !transient_transport(&error) {
                return Err(error.into());
            }
            to_ssh = None;
        }
    }
    Ok(None)
}

fn copy_to_ssh(from_daemon: impl BufRead, to_ssh: impl Write) -> io::Result<()> {
    match copy_stream(from_daemon, to_ssh) {
        Ok(()) => Ok(()),
        Err(error) if transient_transport(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn print_trust(machine: &ConnectedMachine) {
    eprintln!(
        "note: with YOLO on, agents on {} and any machine with a route from it can now control the \
         agents on this machine",
        display_name(&machine.name)
    );
}

/// Warns where systemd on the other machine ends this user's processes when SSH disconnects.
fn print_logout_cleanup(machine: &ConnectedMachine) {
    if let Some(warning) = logout_cleanup_warning(machine) {
        eprintln!("{warning}");
    }
}

fn logout_cleanup_warning(machine: &ConnectedMachine) -> Option<String> {
    (machine.ssh_cleans_processes == Some(true)).then(|| {
        format!(
            "warning: systemd on {} ends this user's processes when SSH disconnects; add the user \
             to KillExcludeUsers in logind.conf there",
            display_name(&machine.name)
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{
        MachineListResult, copy_stream, forward_hello, logout_cleanup_warning, machine_list_json,
        read_machine_hello, serve_stdio,
    };
    use facade_base::api_v1::{ErrorBody, encode_line};
    use serde_json::json;
    use std::io::{self, BufReader, Write};

    const MACHINE_ID: &str = "67cafe12-9a12-4b73-8e9f-cc2d44289832";
    const BOOT_ID: &str = "833b79e1-0fca-44f9-b480-1d8072f3d975";

    #[test]
    fn machine_serve_refuses_bad_offers_before_opening_a_socket() {
        let invalid = [
            (None, None),
            (None, Some(json!([3, 3]))),
            (Some(json!([])), None),
            (Some(json!(null)), None),
            (Some(json!("1")), None),
            (Some(json!([0])), None),
            (Some(json!([-1])), None),
        ];
        let run = |offer: Option<serde_json::Value>, protocol: Option<serde_json::Value>| {
            let mut params = json!({
                "kind": "machine", "build": "test",
                "machine": { "machine_id": MACHINE_ID, "boot_id": BOOT_ID, "name": "peer" },
            });
            if let Some(offer) = offer {
                params["api_versions"] = offer;
            }
            if let Some(protocol) = protocol {
                params["protocol"] = protocol;
            }
            let input = encode_line(&json!({
                "jsonrpc": "2.0", "id": 42, "method": "hello", "params": params,
            }));
            let mut output = Vec::new();
            let exit = serve_stdio(io::Cursor::new(input), &mut output, true, &|_| {
                panic!("a refused hello must not open a daemon socket")
            })
            .unwrap();
            assert_eq!(exit, 0);
            assert_eq!(output.iter().filter(|&&byte| byte == b'\n').count(), 1);
            serde_json::from_slice::<serde_json::Value>(&output).unwrap()
        };
        for (offer, protocol) in invalid {
            assert_eq!(
                run(offer, protocol),
                json!({
                    "jsonrpc": "2.0", "id": 42,
                    "error": {
                        "code": -32602,
                        "message": "Provide hello.params.api_versions as a non-empty array of positive integers. Use a Facade API v1 build.",
                        "data": { "reason": "invalid_argument" },
                    },
                })
            );
        }
        let disjoint = run(Some(json!([2, 2])), None);
        assert_eq!(disjoint["id"], 42);
        assert_eq!(disjoint["error"]["code"], -32000);
        assert_eq!(disjoint["error"]["data"]["reason"], "protocol_incompatible");
        assert_eq!(
            disjoint["error"]["data"]["details"]["supported_api_versions"],
            json!([1])
        );
    }

    #[test]
    fn machine_serve_keeps_the_hello_and_buffered_continuation_bytes() {
        let first = format!(
            r#"{{"method":"hello", "jsonrpc":"2.0","id":7,"params":{{"kind":"machine","api_versions":[1],"build":"test","machine":{{"machine_id":"{MACHINE_ID}","boot_id":"{BOOT_ID}","name":"peer"}}}}}}"#
        ) + "\r\n";
        let continuation =
            b"{ \"jsonrpc\":\"2.0\", \"method\":\"machine.sleeping\", \"params\":{} }\r\n";
        let mut frames = first.as_bytes().to_vec();
        frames.extend_from_slice(continuation);
        let mut input = BufReader::new(frames.as_slice());
        let mut reply = Vec::new();
        let hello = read_machine_hello(&mut input, &mut reply).unwrap().unwrap();
        assert_eq!(hello.id, 7);
        assert_eq!(hello.line, first.as_bytes());
        assert!(reply.is_empty());
        assert_eq!(input.buffer(), continuation);
        let mut copied = Vec::new();
        copy_stream(input, &mut copied).unwrap();
        assert_eq!(copied, continuation);
    }

    #[test]
    fn ssh_closing_during_the_handshake_preserves_the_daemon_conflict() {
        struct ClosedSsh;
        impl Write for ClosedSsh {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let conflict = json!({
            "jsonrpc": "2.0", "method": "connect_failed",
            "params": { "error": {
                "code": -32000, "message": "Conflicting machine ID.",
                "data": { "reason": "machine_id_conflict" },
            }},
        });
        let mut frames = encode_line(&json!({ "jsonrpc": "2.0", "id": 1, "result": {} }));
        frames.extend(encode_line(&conflict));

        let error = forward_hello(&mut frames.as_slice(), &mut ClosedSsh).unwrap_err();
        assert_eq!(
            error.downcast::<ErrorBody>().unwrap().data.reason,
            "machine_id_conflict"
        );
    }

    #[test]
    fn forward_hello_preserves_peer_frames_and_uses_the_confirmed_logout_flag() {
        // The peer's hello is a request, and its logout flag must not drive the local warning.
        let hello = format!(
            r#"{{"method":"hello", "jsonrpc":"2.0","id":7,"params":{{"kind":"machine","api_versions":[1],"build":"test","machine":{{"machine_id":"{MACHINE_ID}","boot_id":"{BOOT_ID}","name":"peer","ssh_cleans_processes":true}}}}}}"#
        ) + "\r\n";
        let reply = b"{ \"jsonrpc\":\"2.0\", \"id\":7, \"result\":{} }\r\n";
        let mut peer = hello.into_bytes();
        peer.extend_from_slice(reply);
        for flag in [Some(true), Some(false), None] {
            let mut machine = json!({
                "machine_id": MACHINE_ID, "boot_id": BOOT_ID, "name": "peer", "build": "test",
            });
            if let Some(flag) = flag {
                machine["ssh_cleans_processes"] = json!(flag);
            }
            let mut frames = peer.clone();
            frames.extend(encode_line(&json!({
                "jsonrpc": "2.0", "method": "connected",
                "params": { "machine": machine, "first_connection": false },
            })));
            let after =
                b"{ \"jsonrpc\":\"2.0\", \"method\":\"machine.sleeping\", \"params\":{} }\n";
            frames.extend_from_slice(after);
            let mut input = BufReader::new(frames.as_slice());
            let mut forwarded = Vec::new();
            let connected = forward_hello(&mut input, &mut forwarded).unwrap().unwrap();
            assert_eq!(forwarded, peer);
            assert_eq!(input.buffer(), after);
            assert_eq!(connected.machine.ssh_cleans_processes, flag);
            assert_eq!(
                logout_cleanup_warning(&connected.machine).as_deref(),
                (flag == Some(true)).then_some(
                    "warning: systemd on peer ends this user's processes when SSH disconnects; add the user to KillExcludeUsers in logind.conf there"
                ),
            );
        }
    }

    #[test]
    fn machine_list_json_preserves_routes_and_connection_details_from_the_same_reply() {
        let wire = json!({ "machines": [
            {
                "machine_id": "here", "short_id": "here", "boot_id": "boot", "name": "local", "build": "0.1.6+test",
                "selector": "local", "state": "online", "route": [],
                "connections": [{
                    "machine_id": "peer", "initiator_machine_id": "here", "kind": "temporary",
                    "state": "connected",
                }],
            },
            {
                "machine_id": "peer", "short_id": "peer", "name": "reachable", "selector": "reachable",
                "state": "online", "route": ["relay", "peer"],
                "connections": [{
                    "machine_id": "here", "initiator_machine_id": "here", "kind": "saved",
                    "transport": { "kind": "ssh", "ssh_destination": "qa@peer",
                        "ssh_args": ["-p", "2222", "qa@peer"], "remote_home": "/home/qa/facade" },
                    "state": "disconnected",
                }],
            },
            {
                "machine_id": "saved", "short_id": "saved", "name": "saved", "selector": "saved",
                "state": "disconnected",
                "connections": [{
                    "machine_id": "here", "initiator_machine_id": "here", "kind": "saved",
                    "transport": { "kind": "ssh", "ssh_destination": "qa@saved", "ssh_args": ["qa@saved"] },
                    "state": "disconnected",
                }],
            },
            {
                "machine_id": "closed", "short_id": "closed", "name": "offline", "selector": "offline",
                "state": "ssh_interaction_required", "last_seen": "2026-11-18T20:00:55.123Z",
                "ssh_error": "qa@closed: Permission denied (publickey,password).",
                "connections": [{
                    "machine_id": "here", "initiator_machine_id": "here", "kind": "saved",
                    "transport": { "kind": "ssh", "ssh_destination": "qa@closed", "ssh_args": ["qa@closed"] },
                    "state": "ssh_interaction_required",
                    "ssh_interaction": { "message": "needs a login", "command": ["ssh", "qa@closed"] },
                }],
            },
        ] });
        let list: MachineListResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(machine_list_json(&list).unwrap(), wire);
    }
}
