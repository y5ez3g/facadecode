//! The machine roster and the receipts for changes to it.

use std::time::SystemTime;

use facade_base::address::short_machine_id;
use facade_base::daemon::display_name;
use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{MachineRemoveArgs, MachineRenameArgs};
use facade_base::operations::NoArgs;
use facade_base::time::parse_iso_time;
use facade_base::v3::{
    ConnectionKind, MachineConnection, MachineInfo, MachineList, MachineRemove, MachineRename,
    MachineState,
};

use crate::errors::{about_machine, repair_command};
use crate::{single_line, table};

pub(super) fn list(daemon: &mut DaemonClient) -> anyhow::Result<()> {
    let listed = daemon.call::<MachineList>(NoArgs {})?;
    let local_id = daemon.hello_result.machine_id.as_str();
    let mut ordered: Vec<_> = listed.machines.iter().collect();
    ordered.sort_by_key(|machine| machine.machine_id != local_id);
    let local_connections = ordered
        .first()
        .filter(|machine| machine.machine_id == local_id)
        .map_or(&[][..], |machine| machine.connections.as_slice());
    let mut diagnostics = Vec::new();
    let rows: Vec<_> = ordered
        .iter()
        .map(|machine| {
            let local = machine.machine_id == local_id;
            let saved = local_connections.iter().find(|connection| {
                connection.kind == ConnectionKind::Saved
                    && connection.initiator_machine_id == local_id
                    && connection.machine_id == machine.machine_id
                    && connection.ssh_destination.is_some()
            });
            let id = shown_id(&machine.machine_id, &listed.machines);
            if !local {
                diagnostics.extend(diagnostic(machine, &id, saved));
            }
            let route = match machine.route.as_deref() {
                Some([hop, .., _]) => {
                    let via = ordered
                        .iter()
                        .find(|row| row.machine_id == *hop)
                        .map_or(hop, |row| &row.selector);
                    format!("via {via}")
                }
                Some([_]) => "Direct".into(),
                _ if saved.is_some() => "Direct".into(),
                _ => "-".into(),
            };
            let version = machine
                .build
                .as_deref()
                .map_or("-", facade_base::build_version);
            vec![
                machine.name.clone(),
                id,
                state_label(machine.state, local).into(),
                version.into(),
                route,
                if local {
                    "-"
                } else if saved.is_some() {
                    "Yes"
                } else {
                    "No"
                }
                .into(),
            ]
        })
        .collect();
    println_or_end!(
        "{}",
        table(&["NAME", "ID", "STATE", "VERSION", "ROUTE", "SAVED"], &rows)
    );
    for diagnostic in diagnostics {
        eprintln!("{diagnostic}");
    }
    if matches!(ordered.as_slice(), [machine] if machine.machine_id == local_id) {
        eprintln!("No other machines. Connect one with 'facade machine add devbox'.");
    }
    Ok(())
}

pub(super) fn remove(daemon: &mut DaemonClient, machine: String) -> anyhow::Result<()> {
    let result = daemon.call::<MachineRemove>(MachineRemoveArgs {
        machine: machine.clone(),
    });
    let removed = result.map_err(|error| edit_error(daemon, &machine, None, error))?;
    let name = display_name(removed.name.as_deref().unwrap_or(&machine));
    println_or_end!("Removed the saved connection to {name}.");
    if let Some(via) = removed.via {
        println_or_end!("{name} is still reachable via {}.", display_name(&via));
    }
    Ok(())
}

pub(super) fn rename(
    daemon: &mut DaemonClient,
    machine: String,
    name: String,
) -> anyhow::Result<()> {
    // The local view supplies a copyable ID and the last known name for older peers.
    let listed = daemon.call::<MachineList>(NoArgs {}).ok();
    let result = daemon.call::<MachineRename>(MachineRenameArgs {
        machine: machine.clone(),
        name: name.clone(),
    });
    let renamed = result.map_err(|error| edit_error(daemon, &machine, Some(&name), error))?;
    let previous = renamed.previous_name.as_deref().or_else(|| {
        listed
            .as_ref()?
            .machines
            .iter()
            .find(|row| row.machine_id == renamed.machine_id)
            .map(|row| row.name.as_str())
    });
    let id = listed.as_ref().map_or_else(
        || renamed.machine_id.clone(),
        |listed| shown_id(&renamed.machine_id, &listed.machines),
    );
    let name = display_name(&renamed.name);
    if let Some(previous) = previous {
        println_or_end!(
            "Renamed machine \"{}\" to \"{name}\" ({id}).",
            display_name(previous)
        );
    } else {
        println_or_end!("Renamed machine to \"{name}\" ({id}).");
    }
    Ok(())
}

fn edit_error(
    daemon: &DaemonClient,
    given: &str,
    new_name: Option<&str>,
    error: anyhow::Error,
) -> anyhow::Error {
    let Some(body) = error.downcast_ref::<ErrorBody>() else {
        return error;
    };
    let machines = &body.data.machines;
    let name = display_name(machines.first().map_or(given, |row| &row.name));
    match (body.data.reason, body.message.as_str()) {
        (Reason::InvalidArgument, "cannot remove the local machine") => {
            anyhow::anyhow!("Cannot remove the local machine \"{name}\".")
        }
        (Reason::NotFound, "this machine has no saved connection to remove") => {
            anyhow::anyhow!("{name} has no saved SSH connection to remove.")
        }
        (Reason::NotFound, "no machine matches that address") => anyhow::anyhow!(
            "Unknown machine \"{name}\".\nRun 'facade machine list' to see known machines."
        ),
        (Reason::AmbiguousReference, _) if !machines.is_empty() => {
            use std::fmt::Write as _;

            let given_display = display_name(given);
            let mut message = if machines.iter().all(|row| row.name == given) {
                format!("More than one machine is named \"{given_display}\".")
            } else {
                format!("More than one machine matches \"{given_display}\".")
            };
            let local_id = &daemon.hello_result.machine_id;
            let mut example = None;
            for row in machines {
                let id = &row.short_id;
                let state = state_label(row.state, row.machine_id == *local_id);
                let _ = write!(message, "\n  {id}  {state}");
                if row.machine_id != *local_id {
                    example = Some(id);
                }
            }
            message.push_str("\nUse an exact machine ID from 'facade machine list'.");
            if let Some(id) = example {
                match new_name {
                    Some(name) => {
                        let _ = write!(
                            message,
                            "\nExample: facade machine rename {id} {}",
                            display_name(name)
                        );
                    }
                    None => {
                        let _ = write!(message, "\nExample: facade machine remove {id}");
                    }
                }
            }
            anyhow::anyhow!(message)
        }
        _ => about_machine(given, error),
    }
}

fn shown_id(machine_id: &str, machines: &[MachineInfo]) -> String {
    let short = short_machine_id(machine_id);
    if machines.iter().any(|machine| {
        machine.machine_id != machine_id
            && (short == short_machine_id(&machine.machine_id) || short == machine.name)
    }) {
        machine_id.to_owned()
    } else {
        short
    }
}

fn state_label(state: MachineState, local: bool) -> &'static str {
    if local {
        return "Local";
    }
    match state {
        MachineState::Online => "Online",
        MachineState::Connecting => "Connecting",
        MachineState::Sleeping => "Sleeping",
        MachineState::Unreachable => "Unreachable",
        MachineState::SshInteractionRequired => "Needs SSH login",
    }
}

fn diagnostic(
    machine: &MachineInfo,
    id: &str,
    saved: Option<&MachineConnection>,
) -> Option<String> {
    let name = display_name(&machine.name);
    let last_seen = machine
        .last_seen
        .as_deref()
        .and_then(parse_iso_time)
        .map(|at| {
            SystemTime::now()
                .duration_since(at)
                .unwrap_or_default()
                .as_secs()
        })
        .map_or_else(String::new, |seconds| {
            let (age, unit) = match seconds {
                0..60 => (seconds, "s"),
                60..3600 => (seconds / 60, "m"),
                3600..86400 => (seconds / 3600, "h"),
                _ => (seconds / 86400, "d"),
            };
            format!(" (last seen {age}{unit} ago)")
        });
    let ssh_error = machine.ssh_error.as_deref().map(single_line);
    let label = format!("{name} ({id})");
    match machine.state {
        MachineState::SshInteractionRequired => {
            let mut line = format!("{label}: SSH requires interactive login{last_seen}.");
            if let Some(connection) = saved {
                line.push(' ');
                line.push_str(&login_tip(connection));
            }
            if let Some(error) = ssh_error {
                line.push_str(&format!("\n{label}: {error}"));
            }
            Some(line)
        }
        MachineState::Unreachable if ssh_error.is_none() => {
            Some(format!("{label}: Unreachable{last_seen}."))
        }
        _ => ssh_error.map(|error| format!("{label}: {error}{last_seen}")),
    }
}

fn login_tip(connection: &MachineConnection) -> String {
    let prefix = ["facade", "machine", "add"];
    let mut words: Vec<_> = prefix.into_iter().map(str::to_owned).collect();
    if let Some(home) = &connection.remote_home {
        words.extend(["--home".into(), home.clone()]);
    }
    if connection.ssh_args.is_empty() {
        words.extend(connection.ssh_destination.iter().cloned());
    } else {
        words.extend(connection.ssh_args.iter().cloned());
    }
    match repair_command(&words) {
        Ok(command) => format!("Run '{command}'."),
        Err(words) => format!(
            "Run 'facade machine add' with these arguments, one per line:\n  {}",
            words[prefix.len()..].join("\n  ")
        ),
    }
}
