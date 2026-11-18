//! Machine commands and the foreground SSH connection.

use std::io::{self, BufRead, BufReader, Write};
use std::net::Shutdown;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;

use anyhow::Context as _;
use facade_base::address::{display_machine_selector, short_machine_id};
use facade_base::daemon::{ClientKind, HelloParams, HelloResult, display_name, methods};
use facade_base::daemon_client::{DaemonClient, transient_transport};
use facade_base::jsonrpc::{
    RequestRead, ServerMessage, decode_arguments, read_request, read_server_message,
};
use facade_base::machine::{
    ConnectFailedParams, ConnectedParams, ConnectionKind, ConnectionState, MachineAdd,
    MachineAddArgs, MachineConnect, MachineConnectArgs, MachineHello, MachineIdentity, MachineInfo,
    MachineList, MachineRemove, MachineRemoveArgs, MachineRename, MachineRenameArgs,
    MachineTransport,
};
use facade_base::operations::NoArgs;
use facade_base::paths::ClientSocket;
use facade_base::ssh::{self, SshMode};

#[derive(clap::Subcommand)]
pub(crate) enum MachineAction {
    /// Save an SSH connection and reconnect automatically. Run again to repair the connection.
    Add(SshTarget),
    /// Connect over SSH until you press Ctrl-C or close this terminal.
    Connect(SshTarget),
    /// List reachable machines and saved connections.
    List {
        /// Print the machine table as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Remove a saved connection from this machine.
    Remove { machine: String },
    /// Rename a machine.
    ///
    /// Addresses using the former name follow another machine if it takes that name.
    Rename { machine: String, name: String },
    /// Carry a machine connection over standard input and output.
    #[command(hide = true)]
    Serve(ServeArgs),
}

#[derive(clap::Args)]
pub(crate) struct SshTarget {
    /// An OpenSSH destination such as a configured Host or user@host.
    #[arg(value_name = "ssh-destination")]
    ssh_destination: String,
    /// The Facade home on the SSH destination. Defaults to that user's Facade home.
    #[arg(long, value_name = "path")]
    home: Option<String>,
}

#[derive(clap::Args)]
pub(crate) struct ServeArgs {
    /// Use this Facade home.
    #[arg(long, value_name = "path", conflicts_with = "home_hex")]
    home: Option<PathBuf>,
    #[arg(long, hide = true)]
    home_hex: Option<String>,
}

impl ServeArgs {
    fn home(self) -> anyhow::Result<Option<PathBuf>> {
        let home = match self.home_hex {
            Some(hex) => Some(PathBuf::from(ssh::decode_home_hex(&hex)?)),
            None => self.home,
        };
        if let Some(path) = &home {
            anyhow::ensure!(
                path.is_absolute() && !path.as_os_str().as_encoded_bytes().contains(&0),
                "the Facade home must be an absolute path"
            );
        }
        Ok(home)
    }
}

/// Runs the machine command with the local connection it needs.
pub(crate) fn run(
    action: MachineAction,
    connect: &dyn Fn() -> anyhow::Result<DaemonClient>,
    serve_socket: &dyn Fn(Option<PathBuf>) -> anyhow::Result<ClientSocket>,
) -> anyhow::Result<i32> {
    match action {
        MachineAction::Add(target) => return foreground(target, ConnectionKind::Saved, connect),
        MachineAction::Connect(target) => {
            return foreground(target, ConnectionKind::Temporary, connect);
        }
        MachineAction::List { json } => {
            let mut daemon = connect()?;
            let listed = daemon.call::<MachineList>(NoArgs {})?;
            if json {
                println_or_end!("{}", serde_json::to_string_pretty(&listed)?);
            } else {
                print_table(&listed.machines, &daemon.hello_result.machine_id);
            }
        }
        MachineAction::Remove { machine } => {
            let removed = connect()?.call::<MachineRemove>(MachineRemoveArgs { machine })?;
            let home = removed
                .remote_home
                .as_deref()
                .unwrap_or("default Facade home");
            let reach = if removed.reachable {
                "The machine is still reachable."
            } else {
                "The machine is unreachable."
            };
            println_or_end!(
                "Removed the saved SSH connection to {} ({}). {reach}",
                display_name(&removed.ssh_destination),
                display_name(home)
            );
        }
        MachineAction::Rename { machine, name } => {
            let renamed = connect()?.call::<MachineRename>(MachineRenameArgs { machine, name })?;
            println_or_end!(
                "Renamed machine id:{} to {}",
                short_machine_id(&renamed.machine_id),
                display_name(&renamed.name)
            );
        }
        MachineAction::Serve(args) => {
            let home = args.home()?;
            let mut input = BufReader::new(io::stdin());
            let (id, first) = read_machine_hello(&mut input)?;
            let mut socket = serve_socket(home)?;
            socket.write_all(&first)?;
            return serve_stdio(input, socket, id);
        }
    }
    Ok(0)
}

/// Reads the exact first frame and checks that it selects the daemon's machine protocol.
fn read_machine_hello(input: &mut impl BufRead) -> anyhow::Result<(u64, Vec<u8>)> {
    const EXPECTED: &str = "machine serve requires a machine hello as its first frame";
    let mut first = Vec::new();
    let request = match read_request(input, &mut first)? {
        RequestRead::Request(request) => request,
        RequestRead::Malformed(error) | RequestRead::LineTooLong(error) => {
            return Err(anyhow::Error::new(error).context(EXPECTED));
        }
        RequestRead::Eof => anyhow::bail!("{EXPECTED}"),
    };
    // The daemon dispatches a hello with a relay field to the MCP relay before it checks kind.
    anyhow::ensure!(
        first.ends_with(b"\n")
            && request.jsonrpc == "2.0"
            && request.method == methods::HELLO
            && request.params.get("relay").is_none(),
        "{EXPECTED}"
    );
    let id = request.id.context(EXPECTED)?;
    let hello: HelloParams = decode_arguments(request.params).context(EXPECTED)?;
    anyhow::ensure!(
        hello.kind == ClientKind::Machine
            && hello.machine.is_some()
            && hello.agent.is_none()
            && hello.sessions.is_empty()
            && hello.window.is_none()
            && hello.numbers_given.is_none(),
        "{EXPECTED}"
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
        anyhow::bail!("the daemon did not answer the machine hello");
    };
    anyhow::ensure!(
        reply.ends_with(b"\n") && response.jsonrpc == "2.0" && response.id == Some(id),
        "the daemon returned an invalid machine hello response"
    );
    let accepted = response.error.is_none();
    if accepted {
        let hello: HelloResult = decode_arguments(response.result.unwrap_or_default())?;
        anyhow::ensure!(
            hello.machine.is_some(),
            "the daemon did not open a machine session"
        );
    }
    let mut stdout = io::stdout().lock();
    stdout.write_all(&reply)?;
    stdout.flush()?;
    if !accepted {
        return Ok(0);
    }

    let input_result = copy_to_daemon(socket.try_clone()?, move |to_daemon| {
        copy_serve(input, to_daemon, "SSH input to daemon")
    });
    let result = copy_serve(from_daemon, stdout, "daemon output to SSH");
    let _ = socket.shutdown(Shutdown::Both);
    let input_failed = input_result.try_recv().is_ok_and(|result| result.is_err());
    Ok(i32::from(result.is_err() || input_failed))
}

fn copy_serve(source: impl BufRead, destination: impl Write, direction: &str) -> io::Result<()> {
    let result = copy_stream(source, destination);
    if let Err(error) = &result {
        eprintln!(
            "facade: machine serve {direction} ended with {:?} ({error})",
            error.kind()
        );
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

/// Whether the foreground work saved a connection or took a temporary connection to its end.
enum ForegroundEnd {
    Saved,
    Disconnected,
    BeforeHandshake,
}

fn foreground(
    target: SshTarget,
    kind: ConnectionKind,
    connect: &dyn Fn() -> anyhow::Result<DaemonClient>,
) -> anyhow::Result<i32> {
    let save = kind == ConnectionKind::Saved;
    let mut daemon = connect()?;
    let authorized = daemon.call::<MachineConnect>(MachineConnectArgs {
        transport: MachineTransport::Ssh {
            ssh_destination: target.ssh_destination,
            remote_home: target.home,
        },
        kind,
    })?;
    let destination = authorized
        .ssh_destination
        .context("the daemon did not supply the authorized SSH destination")?;
    let control_dir = if save {
        ssh::ssh_control_dir(&facade_base::paths::facade_home()?)?
    } else {
        None
    };
    let words = ssh::machine_ssh_args(
        &destination,
        authorized.remote_home.as_deref(),
        if save { SshMode::Add } else { SshMode::Connect },
        control_dir.as_deref(),
    )?;
    let (mut from_daemon, to_daemon) = daemon.into_stream();
    let connection = to_daemon.try_clone()?;
    let mut command = Command::new("ssh");
    command.args(words).stderr(Stdio::inherit());
    let (mut child, mut to_ssh, from_ssh) =
        spawn_ssh(command).context("could not start OpenSSH")?;
    let input_result = copy_to_daemon(to_daemon, move |socket| {
        copy_stream(BufReader::new(from_ssh), socket)
    });

    let result = (|| -> anyhow::Result<ForegroundEnd> {
        let Some(connected) = forward_hello(&mut from_daemon, &mut to_ssh)? else {
            return Ok(ForegroundEnd::BeforeHandshake);
        };
        if connected.first_connection {
            print_trust(&connected.machine);
        }
        if !save {
            print_connected(&connected.machine, "Connected");
            copy_to_ssh(from_daemon, to_ssh)?;
            return Ok(ForegroundEnd::Disconnected);
        }
        // Keep the foreground session alive while the daemon verifies its new saved session.
        std::thread::spawn(move || {
            let _ = copy_to_ssh(from_daemon, to_ssh);
        });
        let saved = connect()?.call::<MachineAdd>(MachineAddArgs {
            ssh_destination: destination.clone(),
            remote_home: authorized.remote_home,
            machine_id: connected.machine.machine_id,
        })?;
        if saved.first_connection && !connected.first_connection {
            print_trust(&saved.machine);
        }
        print_connected(&saved.machine, "Saved connection");
        Ok(ForegroundEnd::Saved)
    })();

    let ssh_closed = matches!(input_result.try_recv(), Ok(Ok(_)));
    let _ = connection.shutdown(Shutdown::Both);
    if !ssh_closed && !matches!(result, Ok(ForegroundEnd::Saved)) {
        let _ = child.kill();
    }
    let status = child.wait()?;
    match result? {
        ForegroundEnd::Saved => Ok(0),
        ForegroundEnd::Disconnected => Ok(status.code().unwrap_or(1)),
        ForegroundEnd::BeforeHandshake => match status.code() {
            Some(127 | 9009) => anyhow::bail!(
                "install Facade on {} and add the directory containing facade to the PATH for \
                 non-interactive SSH sessions",
                display_name(&destination)
            ),
            Some(0) => anyhow::bail!("SSH closed before the machines finished connecting"),
            code => Ok(code.unwrap_or(1)),
        },
    }
}

/// Starts OpenSSH with pipes for its standard input and output.
fn spawn_ssh(mut command: Command) -> io::Result<(Child, ChildStdin, ChildStdout)> {
    #[cfg(windows)]
    {
        let stdio = ssh::ssh_stdio()?;
        let child = command.stdin(stdio.stdin).stdout(stdio.stdout).spawn()?;
        Ok((child, stdio.to_ssh, stdio.from_ssh))
    }
    #[cfg(not(windows))]
    {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let to_ssh = child.stdin.take().expect("stdin was piped");
        let from_ssh = child.stdout.take().expect("stdout was piped");
        Ok((child, to_ssh, from_ssh))
    }
}

/// Passes machine frames unchanged and handles the local daemon's handshake outcome.
fn forward_hello(
    from_daemon: &mut BufReader<ClientSocket>,
    to_ssh: &mut impl Write,
) -> anyhow::Result<Option<ConnectedParams>> {
    let mut line = Vec::new();
    while let Some(frame) = read_server_message(from_daemon, &mut line)? {
        if let ServerMessage::Notification(notification) = frame {
            match notification.method.as_str() {
                methods::CONNECTED => {
                    return Ok(Some(serde_json::from_value(notification.params)?));
                }
                methods::CONNECT_FAILED => {
                    let failed: ConnectFailedParams = serde_json::from_value(notification.params)?;
                    return Err(failed.error.into());
                }
                _ => {}
            }
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
        "facade: After connecting to {}, agents with YOLO enabled on all reachable machines \
         can operate agents on this machine. This includes machines reached through other machines.",
        display_name(&machine.name)
    );
}

fn print_connected(machine: &MachineHello, action: &str) {
    let name = display_name(&machine.name);
    println_or_end!(
        "{action} to {name} (id:{})",
        short_machine_id(&machine.machine_id)
    );
    match machine.ssh_cleans_processes {
        Some(true) => eprintln!(
            "facade: KillUserProcesses applies to this user on {name}. Ending the SSH session \
             stops its processes even with lingering enabled. Add the user to KillExcludeUsers \
             in logind.conf on that machine."
        ),
        Some(false) => {
            println_or_end!("Systemd logout cleanup is inactive for this user on {name}.")
        }
        None => {}
    }
}

fn print_table(machines: &[MachineInfo], local_machine_id: &str) {
    let identities: Vec<_> = machines
        .iter()
        .map(|machine| MachineIdentity {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
        })
        .collect();
    let label = |id: &str| {
        identities
            .iter()
            .find(|machine| machine.machine_id == id)
            .map(|machine| display_machine_selector(machine, &identities))
            .unwrap_or_else(|| format!("id:{}", id.replace('-', "")))
    };
    for machine in machines {
        let route = match machine.route.as_deref() {
            Some([]) => "this machine".into(),
            Some([_]) => "direct".into(),
            Some(hops) => format!(
                "via {}",
                hops[..hops.len() - 1]
                    .iter()
                    .map(|id| label(id))
                    .collect::<Vec<_>>()
                    .join(" → ")
            ),
            None if machine
                .connections
                .iter()
                .any(|connection| connection.state == ConnectionState::SshInteractionRequired) =>
            {
                "SSH requires interaction".into()
            }
            None => "unreachable".into(),
        };
        let build = machine.build.as_deref().map_or_else(String::new, |build| {
            format!(" · Facade {}", display_name(build))
        });
        println_or_end!(
            "{} (id:{}){build} · {route}",
            display_name(&machine.name),
            short_machine_id(&machine.machine_id)
        );
        for connection in &machine.connections {
            let kind = match connection.kind {
                ConnectionKind::Saved => "saved",
                ConnectionKind::Temporary => "temporary",
            };
            let state = match connection.state {
                ConnectionState::Connected => "connected",
                ConnectionState::Unavailable => "unreachable",
                ConnectionState::SshInteractionRequired => "SSH requires interaction",
            };
            let destination =
                connection
                    .ssh_destination
                    .as_deref()
                    .map_or_else(String::new, |destination| {
                        let home = connection
                            .remote_home
                            .as_deref()
                            .unwrap_or("default Facade home");
                        format!(
                            " · SSH {} ({})",
                            display_name(destination),
                            display_name(home)
                        )
                    });
            println_or_end!(
                "  {kind} connection with {} · initiated by {} · {state}{destination}",
                label(&connection.machine_id),
                label(&connection.initiator_machine_id)
            );
            if let Some(interaction) = &connection.ssh_interaction {
                println_or_end!("    {}", display_name(&interaction.reason));
                if machine.machine_id == local_machine_id {
                    print_repair_command(&interaction.command);
                }
            }
        }
    }
}

fn print_repair_command(arguments: &[String]) {
    let windows = cfg!(windows);
    let explanation = if windows && arguments.iter().any(|word| word.contains('"')) {
        Some("A repair argument contains a double quote.")
    } else if arguments
        .iter()
        .any(|word| word.chars().any(char::is_control))
    {
        Some("A repair argument contains a control character.")
    } else if windows
        && arguments.iter().any(|word| {
            word.contains(['%', '!', '$', '`', '“', '”'])
                || (word.ends_with('\\') && !bare_repair_word(word, windows))
        })
    {
        Some("A repair argument needs shell-specific escaping.")
    } else {
        None
    };
    if let Some(explanation) = explanation {
        println_or_end!("    {explanation} Repair arguments in order");
        for word in arguments {
            if word.chars().any(char::is_control) {
                println_or_end!("      {word:?}");
            } else {
                println_or_end!("      {word}");
            }
        }
        return;
    }

    let command = arguments
        .iter()
        .map(|word| {
            if bare_repair_word(word, windows) {
                word.clone()
            } else if windows {
                format!("\"{word}\"")
            } else {
                format!("'{}'", word.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    println_or_end!("    Run {command}");
}

fn bare_repair_word(word: &str, windows: bool) -> bool {
    !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./@:".contains(&b) || (windows && b == b'\\'))
}
