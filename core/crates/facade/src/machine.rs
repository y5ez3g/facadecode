//! Machine commands and the foreground SSH connection.

use std::io::{self, BufRead, BufReader, Write};
use std::net::Shutdown;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;

use anyhow::Context as _;
use facade_base::address::{display_machine_selector, machine_id_selector, short_machine_id};
use facade_base::daemon::{ClientKind, HelloParams, HelloResult, display_name, methods};
use facade_base::daemon_client::{DaemonClient, transient_transport};
use facade_base::jsonrpc::{
    RequestRead, ServerMessage, decode_arguments, read_request, read_server_message,
};
use facade_base::machine::{
    ConnectFailedParams, ConnectedParams, ConnectionKind, ConnectionState, MachineAdd,
    MachineAddArgs, MachineConnect, MachineConnectArgs, MachineConnection, MachineHello,
    MachineIdentity, MachineInfo, MachineList, MachineListResult, MachineRemove, MachineRemoveArgs,
    MachineRename, MachineRenameArgs, MachineTransport,
};
use facade_base::operations::NoArgs;
use facade_base::paths::ClientSocket;
use facade_base::ssh::{self, SshMode};
use serde_json::Value;

use crate::cli::{MachineAction, ServeArgs, SshTarget};
use crate::errors::{self, Problem, ServeFailure, about_connection, about_machine, repair_tip};
use crate::table;

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
                "id:{} {}",
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

/// Gives the CLI the machine's reachability and the public state of each direct connection.
pub(crate) fn machine_list_json(listed: &MachineListResult) -> serde_json::Result<Value> {
    let mut json = serde_json::to_value(listed)?;
    let rows = json["machines"]
        .as_array_mut()
        .expect("machine list is an array");
    for (machine, row) in listed.machines.iter().zip(rows) {
        if machine.is_unreachable() {
            row["unreachable"] = Value::Bool(true);
        }
        let links = row["connections"]
            .as_array_mut()
            .expect("connections are an array");
        for (connection, link) in machine.connections.iter().zip(links) {
            if connection.state == ConnectionState::Disconnected {
                link["state"] = Value::String("disconnected".into());
            }
        }
    }
    Ok(json)
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
            && request.params.get("relay").is_none(),
        EXPECTED
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
        anyhow::ensure!(hello.machine.is_some(), ServeFailure::NoSession);
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

fn foreground(
    target: SshTarget,
    kind: ConnectionKind,
    connect: &dyn Fn() -> anyhow::Result<DaemonClient>,
) -> anyhow::Result<i32> {
    let save = kind == ConnectionKind::Saved;
    let given = target.ssh_destination.clone();
    let mut daemon = connect()?;
    let authorized = daemon
        .call::<MachineConnect>(MachineConnectArgs {
            transport: MachineTransport::Ssh {
                ssh_destination: target.ssh_destination,
                remote_home: target.home,
            },
            kind,
        })
        .map_err(|error| about_connection(&given, error))?;
    let destination = authorized
        .ssh_destination
        .ok_or(Problem::NoSshDestination)?;
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
    command.args(words).stderr(Stdio::piped());
    let (mut child, mut to_ssh, from_ssh) = spawn_ssh(command).context(errors::NO_OPENSSH)?;
    let ssh_said = pass_on_stderr(child.stderr.take());
    let input_result = copy_to_daemon(to_daemon, move |socket| {
        copy_stream(BufReader::new(from_ssh), socket)
    });

    let result = (|| -> anyhow::Result<ForegroundEnd> {
        let Some(connected) = forward_hello(&mut from_daemon, &mut to_ssh)
            .map_err(|error| about_connection(&destination, error))?
        else {
            return Ok(ForegroundEnd::BeforeHandshake);
        };
        if connected.first_connection {
            print_trust(&connected.machine);
        }
        if !save {
            let name = display_name(&connected.machine.name);
            eprintln!("Connected to {name}. Press Ctrl-C to disconnect.");
            print_logout_cleanup(&connected.machine);
            copy_to_ssh(from_daemon, to_ssh)?;
            return Ok(ForegroundEnd::Disconnected(name));
        }
        // Keep the foreground session alive while the daemon verifies its new saved session.
        std::thread::spawn(move || {
            let _ = copy_to_ssh(from_daemon, to_ssh);
        });
        let saved = connect()?
            .call::<MachineAdd>(MachineAddArgs {
                ssh_destination: destination.clone(),
                remote_home: authorized.remote_home,
                machine_id: connected.machine.machine_id,
            })
            .map_err(|error| about_connection(&destination, error))?;
        if saved.first_connection && !connected.first_connection {
            print_trust(&saved.machine);
        }
        println_or_end!(
            "Saved the connection to {}.",
            display_name(&saved.machine.name)
        );
        print_logout_cleanup(&saved.machine);
        Ok(ForegroundEnd::Saved)
    })();

    let ssh_closed = matches!(input_result.try_recv(), Ok(Ok(_)));
    let _ = connection.shutdown(Shutdown::Both);
    if !ssh_closed && !matches!(result, Ok(ForegroundEnd::Saved)) {
        let _ = child.kill();
    }
    let status = child.wait()?;
    let destination = display_name(&destination);
    match result? {
        ForegroundEnd::Saved => Ok(0),
        ForegroundEnd::Disconnected(machine) => Err(Problem::ConnectionLost {
            machine,
            destination,
        }
        .into()),
        ForegroundEnd::BeforeHandshake => match status.code() {
            Some(127 | 9009) => Err(Problem::NoFacade { destination }.into()),
            Some(0) => Err(Problem::SshClosed { destination }.into()),
            code => {
                let said = ssh_said.join().unwrap_or_default();
                let why = match said.is_empty() {
                    false => said,
                    true => errors::ssh_exit(code),
                };
                Err(Problem::SshFailed { destination, why }.into())
            }
        },
    }
}

/// Copies what SSH writes on standard error to this command's, as it comes, and gives its last
/// line that is not blank once SSH closes it.
fn pass_on_stderr(stderr: Option<std::process::ChildStderr>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let Some(stderr) = stderr else {
            return String::new();
        };
        let mut last = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("{line}");
            if !line.trim().is_empty() {
                last = line.trim().to_string();
            }
        }
        last
    })
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
            .unwrap_or_else(|| format!("id:{}", short_machine_id(id)))
    };
    let mut ordered: Vec<&MachineInfo> = machines.iter().collect();
    ordered.sort_by_key(|machine| machine.machine_id != local_machine_id);
    let saved_here = |machine: &MachineInfo| -> Vec<&MachineConnection> {
        machines
            .iter()
            .flat_map(|any| &any.connections)
            .filter(|connection| {
                connection.kind == ConnectionKind::Saved
                    && connection.initiator_machine_id == local_machine_id
                    && connection.machine_id == machine.machine_id
                    && connection.ssh_destination.is_some()
            })
            .fold(Vec::new(), |mut unique, connection| {
                if !unique.iter().any(|seen: &&MachineConnection| {
                    seen.ssh_destination == connection.ssh_destination
                        && seen.remote_home == connection.remote_home
                }) {
                    unique.push(connection);
                }
                unique
            })
    };
    let mut logins = Vec::new();
    let rows: Vec<Vec<String>> = ordered
        .iter()
        .map(|machine| {
            let saved = saved_here(machine);
            let needs_login = saved
                .iter()
                .find_map(|connection| connection.ssh_interaction.as_ref());
            if let Some(interaction) = needs_login {
                logins.push((label(&machine.machine_id), interaction.command.clone()));
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
                None if needs_login.is_some()
                    || machine.connections.iter().any(|connection| {
                        connection.state == ConnectionState::SshInteractionRequired
                    }) =>
                {
                    "needs SSH login".to_string()
                }
                None => "unreachable".to_string(),
            };
            let saved = saved
                .iter()
                .map(|connection| {
                    let destination = connection.ssh_destination.as_deref().unwrap_or_default();
                    match &connection.remote_home {
                        Some(home) => format!("{destination} --home {home}"),
                        None => destination.to_string(),
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            vec![
                machine.name.clone(),
                machine_id_selector(&machine.machine_id, &identities),
                machine
                    .build
                    .as_deref()
                    .map_or("", facade_base::build_version)
                    .to_owned(),
                route,
                saved,
            ]
        })
        .collect();
    println_or_end!(
        "{}",
        table(&["NAME", "ID", "VERSION", "ROUTE", "SAVED"], &rows)
    );
    for (machine, repair) in logins {
        eprintln!(
            "warning: {} needs an SSH login; {}",
            display_name(&machine),
            repair_tip(&repair)
        );
    }
    if machines.len() == 1 {
        eprintln!("No other machines. Run 'facade machine add <DESTINATION>' to connect one.");
    }
}
