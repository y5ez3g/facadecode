//! Machine commands and the foreground SSH connection.

use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::net::Shutdown;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Context as _;
use facade_base::address::short_machine_id;
use facade_base::daemon::{display_name, methods};
use facade_base::daemon_client::{DaemonClient, transient_transport};
use facade_base::jsonrpc::{
    ErrorBody, MAX_LINE_BYTES, RequestRead, ServerMessage, decode_arguments, read_request,
    read_server_message,
};
use facade_base::machine::{
    ConnectedParams, ConnectionOutcome, MachineRemoveArgs, MachineRenameArgs,
};
use facade_base::operations::NoArgs;
use facade_base::paths::ClientSocket;
use facade_base::ssh::{self, BootstrapAction, RemoteLoginShell, RemoteProbe, SshMode};
use facade_base::v3::{
    ClientKind, ConnectionKind, ConnectionState, DAEMON_PROTOCOL_RANGE, HelloParams, HelloResult,
    MachineConnect, MachineConnectArgs, MachineConnection, MachineHello, MachineInfo, MachineList,
    MachineListResult, MachineRemove, MachineRename, MachineState, MachineTransport,
};
use serde_json::Value;

use crate::cli::{MachineAction, ServeArgs, SshTarget};
use crate::errors::{self, Problem, ServeFailure, about_connection, about_machine, repair_tip};
use crate::table;

// Leave time for the person's SSH prompts before the daemon's machine handshake starts.
const SSH_LOGIN_PROBE_TIMEOUT: Duration = Duration::from_secs(120);

impl ServeArgs {
    fn home(self) -> anyhow::Result<Option<PathBuf>> {
        let home = match self.home_hex {
            Some(hex) => Some(PathBuf::from(ssh::decode_home_hex(&hex)?)),
            None => self.home,
        };
        if let Some(path) = &home {
            anyhow::ensure!(
                path.is_absolute() && !path.as_os_str().as_encoded_bytes().contains(&0),
                ServeFailure::RelativeHome
            );
        }
        Ok(home)
    }
}

/// Runs the machine command with the local connection it needs.
pub(crate) fn run(
    action: MachineAction,
    connect: &dyn Fn() -> anyhow::Result<DaemonClient>,
    serve_socket: &dyn Fn(Option<PathBuf>, bool) -> anyhow::Result<Option<ClientSocket>>,
) -> anyhow::Result<i32> {
    match action {
        MachineAction::Add(target) => return add(target),
        MachineAction::Link(target) => return foreground(target, ConnectionKind::Saved, connect),
        MachineAction::Connect(target) => {
            return foreground(target, ConnectionKind::Temporary, connect);
        }
        MachineAction::List { json } => {
            let mut daemon = connect()?;
            let listed = daemon.call::<MachineList>(NoArgs {})?;
            if json {
                let json = machine_list_json(&listed)?;
                println_or_end!("{}", serde_json::to_string_pretty(&json)?);
            } else {
                print_table(&listed.machines, &daemon.hello_result.machine_id);
            }
        }
        MachineAction::Remove { machine } => {
            let removed = connect()?
                .call::<MachineRemove>(MachineRemoveArgs {
                    machine: machine.clone(),
                })
                .map_err(|error| about_machine(&machine, None, error))?;
            let machine = display_name(&machine);
            println_or_end!("Removed the saved connection to {machine}.");
            if removed.reachable {
                eprintln!("note: {machine} still has a route through another machine");
            }
        }
        MachineAction::Rename { machine, name } => {
            let renamed = connect()?
                .call::<MachineRename>(MachineRenameArgs {
                    machine: machine.clone(),
                    name,
                })
                .map_err(|error| about_machine(&machine, None, error))?;
            println_or_end!(
                "{} {}",
                short_machine_id(&renamed.machine_id),
                display_name(&renamed.name)
            );
        }
        MachineAction::Serve(args) => {
            let wake = !args.no_start;
            let home = args
                .home()
                .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
            let mut input = BufReader::new(io::stdin());
            let (id, first) = read_machine_hello(&mut input)?;
            let Some(mut socket) = serve_socket(home, wake)? else {
                return Ok(3);
            };
            socket.write_all(&first)?;
            return serve_stdio(input, socket, id);
        }
    }
    Ok(0)
}

/// Gives the CLI the machine's reachability and the public state of each direct connection.
pub(crate) fn machine_list_json(listed: &MachineListResult) -> serde_json::Result<Value> {
    serde_json::to_value(listed)
}

/// Reads the exact first frame and checks that it selects the daemon's machine protocol.
fn read_machine_hello(input: &mut impl BufRead) -> anyhow::Result<(u64, Vec<u8>)> {
    const EXPECTED: ServeFailure = ServeFailure::NotMachineHello;
    let mut first = Vec::new();
    let request = match read_request(input, &mut first)? {
        RequestRead::Request(request) => request,
        RequestRead::Malformed(error) | RequestRead::LineTooLong(error) => {
            return Err(anyhow::Error::new(error).context(EXPECTED));
        }
        RequestRead::Eof => anyhow::bail!(EXPECTED),
    };
    // The daemon dispatches a hello with a relay field to the MCP relay before it checks kind.
    anyhow::ensure!(
        first.ends_with(b"\n")
            && request.jsonrpc == "2.0"
            && request.method == methods::HELLO
            && ["agent", "sessions", "window", "numbers_given", "relay"]
                .iter()
                .all(|key| request.params.get(*key).is_none()),
        EXPECTED
    );
    let id = request.id.context(EXPECTED)?;
    let hello: HelloParams = decode_arguments(request.params).context(EXPECTED)?;
    anyhow::ensure!(
        hello.kind == ClientKind::Machine && hello.machine.is_some(),
        EXPECTED
    );
    Ok((id, first))
}

/// Forwards the daemon's reply verbatim, then carries the session after a successful hello.
fn serve_stdio(
    input: impl BufRead + Send + 'static,
    socket: ClientSocket,
    id: u64,
) -> anyhow::Result<i32> {
    let mut from_daemon = BufReader::new(socket.try_clone()?);
    let mut reply = Vec::new();
    let Some(ServerMessage::Response(response)) =
        read_server_message(&mut from_daemon, &mut reply)?
    else {
        anyhow::bail!(ServeFailure::NoHelloAnswer);
    };
    anyhow::ensure!(
        reply.ends_with(b"\n") && response.jsonrpc == "2.0" && response.id == Some(id),
        ServeFailure::InvalidHelloAnswer
    );
    let accepted = response.error.is_none();
    if accepted {
        let hello: HelloResult = decode_arguments(response.result.unwrap_or_default())?;
        anyhow::ensure!(
            hello.protocol == DAEMON_PROTOCOL_RANGE[1] && hello.machine.is_some(),
            ServeFailure::NoSession
        );
    }
    let mut stdout = io::stdout().lock();
    stdout.write_all(&reply)?;
    stdout.flush()?;
    if !accepted {
        return Ok(0);
    }

    let input_result = copy_to_daemon(socket.try_clone()?, move |to_daemon| {
        copy_serve(input, to_daemon, true)
    });
    let result = copy_serve(from_daemon, stdout, false);
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

/// Runs the input copy on its own thread. EOF in either direction ends this session.
fn copy_to_daemon(
    mut to_daemon: ClientSocket,
    copy: impl FnOnce(&mut ClientSocket) -> io::Result<()> + Send + 'static,
) -> mpsc::Receiver<io::Result<()>> {
    let (input_done, input_result) = mpsc::channel();
    std::thread::spawn(move || {
        let result = copy(&mut to_daemon);
        let _ = input_done.send(result);
        let _ = to_daemon.shutdown(Shutdown::Both);
    });
    input_result
}

/// Whether the foreground work saved a connection, took a temporary connection to the machine it
/// names to its end, or ended before the machines connected.
enum ForegroundEnd {
    Saved,
    Disconnected(String),
    BeforeHandshake,
}

struct SshSession {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    stderr: std::thread::JoinHandle<String>,
}

impl SshSession {
    fn spawn(words: &[std::ffi::OsString]) -> anyhow::Result<Self> {
        let mut command = Command::new("ssh");
        command.args(words).stderr(Stdio::piped());
        let (mut child, input, output) = ssh::spawn_ssh(command).context(errors::NO_OPENSSH)?;
        let stderr = pass_on_stderr(child.stderr.take());
        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
            stderr,
        })
    }

    fn finish(self, kill: bool) -> io::Result<(ExitStatus, String)> {
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
        Ok((status, stderr.join().unwrap_or_default()))
    }
}

fn bootstrap_ssh(
    ssh_args: &[String],
    destination: &str,
    home: Option<&str>,
    mode: SshMode,
    build: &str,
) -> anyhow::Result<SshSession> {
    let command = |shell| {
        ssh::remote_login_bootstrap_command(shell, home, build, true).map_err(|error| {
            if error == ssh::SshArgumentError::Home {
                anyhow::Error::new(ErrorBody::invalid_argument(error.to_string()))
            } else {
                error.into()
            }
        })
    };
    // Validate the home and release before asking SSH to log in.
    let unix_command = command(RemoteLoginShell::Unix)?;
    let control_dir = if mode == SshMode::Add {
        ssh::ssh_control_dir(&facade_base::paths::facade_home()?)?
    } else {
        None
    };
    let words = ssh::ssh_login_args(ssh_args, mode, control_dir.as_deref())
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
    let mut session = SshSession::spawn(&words)?;
    let probe_login = |input: &mut ChildStdin,
                       output: &mut BufReader<ChildStdout>|
     -> anyhow::Result<_> {
        if !send_ssh(input, ssh::REMOTE_PLATFORM_PROBE)? {
            return Ok(None);
        }
        let Some(shell) = read_login_marker(output, ssh::parse_remote_platform)? else {
            return Ok(None);
        };
        let system = shell.system();
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
        let probe = ssh::parse_remote_probe(std::str::from_utf8(&line)?).map_err(|error| {
            if error == ssh::SshArgumentError::Probe {
                Problem::StartupPrints {
                    destination: display_name(destination),
                }
                .into()
            } else {
                anyhow::Error::new(error).context(format!(
                    "invalid Facade version on {}",
                    display_name(destination)
                ))
            }
        })?;
        let action = ssh::bootstrap_action(&probe, build, true)?;
        if let (BootstrapAction::UpgradeLocal, RemoteProbe::Installed(remote)) = (action, probe) {
            anyhow::bail!(
                "{} runs Facade {}. Run 'facade upgrade' on this machine and try again.",
                display_name(destination),
                facade_base::build_version(&remote)
            );
        }
        Ok(Some((system, action)))
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
    let (system, action) = match prelude {
        Ok(Some(setup)) => setup,
        Ok(None) => {
            let (status, stderr) = session.finish(false)?;
            return Err(ssh_failure(destination, status, stderr));
        }
        Err(error) => {
            let _ = session.finish(true);
            return Err(error);
        }
    };
    let directive = match action {
        BootstrapAction::Serve => ssh::BOOTSTRAP_SERVE,
        BootstrapAction::Install => ssh::BOOTSTRAP_INSTALL,
        _ => unreachable!("the active connection can serve or install"),
    };
    let ready = match send_ssh(&mut session.input, directive) {
        Ok(true) => read_bootstrap_line(&mut session.output),
        Ok(false) => Ok(None),
        Err(error) => Err(error.into()),
    };
    let error = match ready {
        Ok(Some(line)) if line.as_slice() == ssh::BOOTSTRAP_READY.as_bytes() => return Ok(session),
        Ok(Some(_)) => {
            let _ = session.finish(true);
            anyhow::anyhow!("expected the remote Facade bootstrap to report ready")
        }
        Ok(None) => {
            let (status, stderr) = session.finish(false)?;
            if action == BootstrapAction::Serve {
                return Err(ssh_failure(destination, status, stderr));
            }
            let reason = ssh_reason(status, stderr);
            anyhow::anyhow!("{reason}")
        }
        Err(error) => {
            let _ = session.finish(true);
            error
        }
    };
    if action == BootstrapAction::Install {
        let install = ssh::remote_install_command(system, build, home)?;
        Err(anyhow::anyhow!(
            "could not install Facade {} on {} ({error:#})\n  \
             tip: run this command on that machine\n{install}",
            facade_base::build_version(build),
            display_name(destination)
        ))
    } else {
        Err(error)
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
        "expected a complete remote Facade bootstrap line"
    );
    line.pop();
    if line.ends_with(b"\r") {
        line.pop();
    }
    Ok(Some(line))
}

fn ssh_failure(destination: &str, status: ExitStatus, stderr: String) -> anyhow::Error {
    let destination = display_name(destination);
    if stderr.is_empty() && status.success() {
        return Problem::SshClosed { destination }.into();
    }
    Problem::SshFailed {
        destination,
        why: ssh_reason(status, stderr),
    }
    .into()
}

fn ssh_reason(status: ExitStatus, stderr: String) -> String {
    if stderr.is_empty() {
        errors::ssh_exit(status.code())
    } else {
        stderr
    }
}

/// Leaves the saved connection with the process that opened it once the daemon confirms it.
fn add(target: SshTarget) -> anyhow::Result<i32> {
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
    let mut receipt = String::new();
    let received = BufReader::new(stdout)
        .read_line(&mut receipt)
        .context("could not read the saved machine connection result")
        .and_then(|_| {
            if receipt.ends_with('\n') {
                serde_json::from_str::<ConnectedParams>(&receipt)
                    .map(Some)
                    .context("machine link returned an invalid connection result")
            } else {
                Ok(None)
            }
        });
    if let Ok(Some(connected)) = &received {
        if connected.first_connection {
            print_trust(&connected.machine);
        }
        println_or_end!(
            "Saved the connection to {}.",
            display_name(&connected.machine.name)
        );
        print_logout_cleanup(&connected.machine);
        return Ok(0);
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
    kind: ConnectionKind,
    connect: &dyn Fn() -> anyhow::Result<DaemonClient>,
) -> anyhow::Result<i32> {
    let save = kind == ConnectionKind::Saved;
    let given = ssh::parse_ssh_destination(&target.ssh_args)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?
        .to_owned();
    let mut daemon = connect()?;
    let session = bootstrap_ssh(
        &target.ssh_args,
        &given,
        target.home.as_deref(),
        if save { SshMode::Add } else { SshMode::Connect },
        &facade_base::build_id(),
    )?;
    // MachineConnect starts the daemon's handshake clock. SSH is ready to carry the hello now.
    let streams = (|| -> anyhow::Result<_> {
        let authorized = daemon
            .call::<MachineConnect>(MachineConnectArgs {
                transport: MachineTransport::Ssh {
                    ssh_destination: given.clone(),
                    ssh_args: target.ssh_args,
                    remote_home: target.home,
                },
                kind,
            })
            .map_err(|error| about_connection(&given, error))?;
        let destination = authorized
            .ssh_destination
            .ok_or(Problem::NoSshDestination)?;
        let (from_daemon, to_daemon) = daemon.into_stream();
        let connection = to_daemon.try_clone()?;
        Ok((destination, from_daemon, to_daemon, connection))
    })();
    let (destination, mut from_daemon, to_daemon, connection) = match streams {
        Ok(streams) => streams,
        Err(error) => {
            let _ = session.finish(true);
            return Err(error);
        }
    };
    let SshSession {
        mut child,
        input: mut to_ssh,
        output: from_ssh,
        stderr: ssh_said,
    } = session;
    let input_result = copy_to_daemon(to_daemon, move |socket| copy_stream(from_ssh, socket));

    let result = (|| -> anyhow::Result<ForegroundEnd> {
        let Some(connected) = forward_hello(&mut from_daemon, &mut to_ssh)
            .map_err(|error| about_connection(&destination, error))?
        else {
            return Ok(ForegroundEnd::BeforeHandshake);
        };
        let end = if save {
            // The Connected reply follows persistence of the verified machine ID and original SSH
            // arguments. Report success, then keep carrying the same SSH session.
            let mut stdout = io::stdout().lock();
            serde_json::to_writer(&mut stdout, &connected)?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
            ForegroundEnd::Saved
        } else {
            if connected.first_connection {
                print_trust(&connected.machine);
            }
            let name = display_name(&connected.machine.name);
            eprintln!("Connected to {name}. Press Ctrl-C to disconnect.");
            print_logout_cleanup(&connected.machine);
            ForegroundEnd::Disconnected(name)
        };
        copy_to_ssh(from_daemon, to_ssh)?;
        Ok(end)
    })();

    let ssh_closed = matches!(input_result.try_recv(), Ok(Ok(_)));
    let _ = connection.shutdown(Shutdown::Both);
    if !ssh_closed {
        let _ = child.kill();
    }
    let status = child.wait()?;
    match result? {
        ForegroundEnd::Saved => Ok(0),
        ForegroundEnd::Disconnected(machine) => Err(Problem::ConnectionLost {
            machine,
            destination: display_name(&destination),
        }
        .into()),
        ForegroundEnd::BeforeHandshake => Err(ssh_failure(
            &destination,
            status,
            ssh_said.join().unwrap_or_default(),
        )),
    }
}

/// Copies what SSH writes on standard error to this command's, as it comes, and gives its last
/// line that is not blank once SSH closes it.
fn pass_on_stderr(stderr: Option<std::process::ChildStderr>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut last = String::new();
        let Some(stderr) = stderr else {
            return last;
        };
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            // A saved link may still be running after its foreground command closes the pipe.
            let _ = writeln!(io::stderr(), "{line}");
            let line = line.trim();
            if !line.is_empty() {
                last = line.to_owned();
            }
        }
        last
    })
}

/// Passes machine frames unchanged and handles the local daemon's handshake outcome.
fn forward_hello(
    from_daemon: &mut BufReader<ClientSocket>,
    to_ssh: &mut impl Write,
) -> anyhow::Result<Option<ConnectedParams>> {
    let mut line = Vec::new();
    while let Some(frame) = read_server_message(from_daemon, &mut line)? {
        if let ServerMessage::Notification(notification) = frame
            && let Some(outcome) = ConnectionOutcome::from_notification(notification)?
        {
            return match outcome {
                ConnectionOutcome::Connected(connected) => Ok(Some(connected)),
                ConnectionOutcome::Failed(failed) => Err(failed.error.into()),
            };
        }
        if let Err(error) = to_ssh.write_all(&line) {
            if transient_transport(&error) {
                return Ok(None);
            }
            return Err(error.into());
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

fn print_trust(machine: &MachineHello) {
    eprintln!(
        "note: with YOLO on, agents on {} and any machine with a route from it can now control the \
         agents on this machine",
        display_name(&machine.name)
    );
}

/// Warns where systemd on the other machine ends this user's processes when SSH disconnects.
fn print_logout_cleanup(machine: &MachineHello) {
    if machine.ssh_cleans_processes == Some(true) {
        eprintln!(
            "warning: systemd on {} ends this user's processes when SSH disconnects; add the user \
             to KillExcludeUsers in logind.conf there",
            display_name(&machine.name)
        );
    }
}

/// Prints one row per machine, this one first, and a warning for each saved connection that needs
/// an SSH login.
fn print_table(machines: &[MachineInfo], local_machine_id: &str) {
    let label = |id: &str| {
        machines
            .iter()
            .find(|machine| machine.machine_id == id)
            .map_or_else(|| short_machine_id(id), |machine| machine.selector.clone())
    };
    let mut ordered: Vec<&MachineInfo> = machines.iter().collect();
    ordered.sort_by_key(|machine| machine.machine_id != local_machine_id);
    let saved_here = ordered
        .first()
        .filter(|machine| machine.machine_id == local_machine_id)
        .map_or(&[][..], |machine| machine.connections.as_slice());
    let mut logins = Vec::new();
    let mut ssh_errors = Vec::new();
    let rows: Vec<Vec<String>> = ordered
        .iter()
        .map(|machine| {
            let saved = saved_here
                .iter()
                .filter(|connection| {
                    connection.kind == ConnectionKind::Saved
                        && connection.initiator_machine_id == local_machine_id
                        && connection.machine_id == machine.machine_id
                        && connection.ssh_destination.is_some()
                })
                .map(|connection| {
                    let arguments = saved_arguments(connection);
                    if connection.state == ConnectionState::SshInteractionRequired {
                        let mut repair = ["facade", "machine", "add"].map(str::to_owned).to_vec();
                        repair.extend(arguments.iter().cloned());
                        logins.push((&machine.selector, repair));
                    }
                    errors::repair_command(&arguments).unwrap_or_else(|words| words.join(" "))
                })
                .collect::<Vec<_>>()
                .join(", ");
            if let Some(error) = &machine.ssh_error {
                ssh_errors.push((&machine.selector, error));
            }
            let route = match machine.route.as_deref() {
                Some([]) => "this machine".to_string(),
                Some([_]) => "direct".to_string(),
                Some(hops) => format!(
                    "via {}",
                    hops[..hops.len() - 1]
                        .iter()
                        .map(|id| label(id))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                None => String::new(),
            };
            let state = match machine.state {
                MachineState::Online => "online",
                MachineState::Connecting => "connecting",
                MachineState::Sleeping => "sleeping",
                MachineState::Unreachable => "unreachable",
                MachineState::SshInteractionRequired => "needs SSH login",
            };
            vec![
                machine.name.clone(),
                short_machine_id(&machine.machine_id),
                machine.selector.clone(),
                machine
                    .build
                    .as_deref()
                    .map_or("", facade_base::build_version)
                    .to_owned(),
                state.to_owned(),
                route,
                machine.last_seen.clone().unwrap_or_default(),
                saved,
            ]
        })
        .collect();
    println_or_end!(
        "{}",
        table(
            &[
                "NAME",
                "ID",
                "SELECTOR",
                "VERSION",
                "STATE",
                "ROUTE",
                "LAST SEEN",
                "SAVED"
            ],
            &rows,
        )
    );
    for (machine, error) in ssh_errors {
        eprintln!("warning: SSH to {}: {error}", display_name(machine));
    }
    for (machine, repair) in logins {
        eprintln!(
            "warning: {} needs an SSH login; {}",
            display_name(machine),
            repair_tip(&repair)
        );
    }
    if machines.len() == 1 {
        eprintln!("No other machines. Run 'facade machine add <DESTINATION>' to connect one.");
    }
}

fn saved_arguments(connection: &MachineConnection) -> Vec<String> {
    let mut arguments = Vec::new();
    if let Some(home) = &connection.remote_home {
        arguments.extend(["--home".to_owned(), home.clone()]);
    }
    if connection.ssh_args.is_empty() {
        arguments.extend(connection.ssh_destination.iter().cloned());
    } else {
        arguments.extend(connection.ssh_args.iter().cloned());
    }
    arguments
}

#[cfg(test)]
mod tests {
    use super::{MachineListResult, machine_list_json};
    use serde_json::json;

    #[test]
    fn machine_list_json_preserves_routes_and_connection_details_from_the_same_v3_reply() {
        let wire = json!({ "machines": [
            {
                "machine_id": "here", "boot_id": "boot", "name": "local", "build": "0.1.6+test",
                "selector": "local", "state": "online", "route": [],
                "connections": [{
                    "machine_id": "peer", "initiator_machine_id": "here", "kind": "temporary",
                    "state": "connected",
                }],
            },
            {
                "machine_id": "peer", "name": "reachable", "selector": "reachable",
                "state": "online", "route": ["relay", "peer"],
                "connections": [{
                    "machine_id": "here", "initiator_machine_id": "here", "kind": "saved",
                    "ssh_destination": "qa@peer", "ssh_args": ["-p", "2222", "qa@peer"],
                    "remote_home": "/home/qa/facade", "state": "unavailable",
                }],
            },
            {
                "machine_id": "closed", "name": "offline", "selector": "offline",
                "state": "ssh_interaction_required", "last_seen": "2026-11-18T20:00:55.123Z",
                "ssh_error": "qa@closed: Permission denied (publickey,password).",
                "connections": [{
                    "machine_id": "here", "initiator_machine_id": "here", "kind": "saved",
                    "ssh_destination": "qa@closed", "state": "ssh_interaction_required",
                    "ssh_interaction": { "reason": "needs a login", "command": ["ssh", "qa@closed"] },
                }],
            },
        ] });
        let list: MachineListResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(machine_list_json(&list).unwrap(), wire);
    }
}
