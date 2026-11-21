//! The machine roster and the receipts for changes to it.

use std::path::PathBuf;
use std::time::SystemTime;

use facade_base::api_v1::daemon::{
    ConnectionKind, MachineConnection, MachineIdentity, MachineInfo, MachineList, MachineQuery,
    MachineRemove, MachineRemoveArgs, MachineRemoveResult, MachineRename, MachineRenameArgs,
    MachineState, SshTransport,
};
use facade_base::api_v1::daemon_client::DaemonClient;
use facade_base::api_v1::{ErrorBody, NoArgs};
use facade_base::daemon::display_name;
use facade_base::ssh;
use facade_base::time::parse_iso_time;
use facade_base::v3::address::display_machine_id;
use serde::Deserialize;

use crate::errors::{about_machine, repair_command};
use crate::{single_line, table};

pub(super) fn list(daemon: &mut DaemonClient) -> anyhow::Result<()> {
    let listed = daemon.call::<MachineList>(NoArgs {})?;
    let visible = identities(&listed.machines);
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
            let saved = saved_ssh(local_connections, local_id, &machine.machine_id);
            let id =
                display_machine_id(&machine.machine_id, &visible).unwrap_or_else(|_| "-".into());
            if !local {
                diagnostics.extend(diagnostic(machine, &id, saved));
            }
            let route = match machine.route.as_deref() {
                _ if saved.is_some() => "Direct".into(),
                Some([hop, .., _]) => {
                    let via = ordered
                        .iter()
                        .find(|row| row.machine_id == *hop)
                        .map_or(hop, |row| &row.selector);
                    format!("via {via}")
                }
                Some([_]) => "Direct".into(),
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

pub(super) fn saved_ssh<'a>(
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

pub(super) fn ssh_args(transport: &SshTransport) -> &[String] {
    if transport.ssh_args.is_empty() {
        std::slice::from_ref(&transport.ssh_destination)
    } else {
        &transport.ssh_args
    }
}

pub(super) fn remove(daemon: &mut DaemonClient, machine: String) -> anyhow::Result<i32> {
    let removed = remove_route(daemon, &machine)
        .map_err(|error| edit_error(daemon, &machine, None, error))?;
    let authorization = revoke_key(&removed.machine_id);
    let name = print_removed(&removed, &machine);
    match authorization {
        Ok(_) => Ok(0),
        Err(RevocationFailure::Elevate(path)) => {
            eprintln!(
                "note: SSH authorization for {name} still needs cleanup in {}. \
                 Use an elevated Administrator terminal.",
                path.display()
            );
            Ok(0)
        }
        Err(RevocationFailure::Other(error)) => Err(error.context(format!(
            "Could not revoke SSH authorization for {name} on this machine"
        ))),
    }
}

fn remove_route(daemon: &mut DaemonClient, machine: &str) -> anyhow::Result<MachineRemoveResult> {
    daemon.call::<MachineRemove>(MachineRemoveArgs {
        machine: machine.to_owned(),
        expected_machine_id: None,
    })
}

pub(super) fn print_removed(removed: &MachineRemoveResult, given: &str) -> String {
    let name = display_name(removed.name.as_deref().unwrap_or(given));
    println_or_end!("Removed the saved connection to {name}.");
    if let Some(via) = &removed.via {
        println_or_end!("{name} is still reachable via {}.", display_name(via));
    }
    name
}

pub(super) enum RevocationFailure {
    Elevate(PathBuf),
    Other(anyhow::Error),
}

pub(super) fn revoke_key(machine_id: &str) -> Result<bool, RevocationFailure> {
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
        |listed| {
            display_machine_id(&renamed.machine_id, &identities(&listed.machines))
                .unwrap_or_else(|_| "-".into())
        },
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
    let machines = body
        .data
        .details
        .as_ref()
        .and_then(|details| details.get("machines"))
        .and_then(|rows| Vec::<MachineQuery>::deserialize(rows).ok())
        .unwrap_or_default();
    let name = display_name(machines.first().map_or(given, |row| &row.name));
    match (body.data.reason.as_str(), body.message.as_str()) {
        ("invalid_argument", "cannot remove the local machine") => {
            anyhow::anyhow!("Cannot remove the local machine \"{name}\".")
        }
        ("not_found", "this machine has no saved connection to remove") => {
            anyhow::anyhow!("{name} has no saved SSH connection to remove.")
        }
        ("not_found", "no machine matches that address") => anyhow::anyhow!(
            "Unknown machine \"{name}\".\nRun 'facade machine list' to see known machines."
        ),
        ("ambiguous_reference", _) if !machines.is_empty() => {
            use std::fmt::Write as _;

            let given_display = display_name(given);
            let mut message = if machines.iter().all(|row| row.name == given) {
                format!("More than one machine is named \"{given_display}\".")
            } else {
                format!("More than one machine matches \"{given_display}\".")
            };
            let local_id = &daemon.hello_result.machine_id;
            let mut example = None;
            for row in &machines {
                let id = &row.short_id;
                let state = state_label(row.state, row.machine_id == *local_id);
                let _ = write!(message, "\n  {id}  {state}");
                if row.machine_id != *local_id && id != "-" {
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

fn identities(machines: &[MachineInfo]) -> Vec<MachineIdentity> {
    machines
        .iter()
        .map(|machine| MachineIdentity {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
        })
        .collect()
}

fn state_label(state: MachineState, local: bool) -> &'static str {
    if local {
        return "Local";
    }
    match state {
        MachineState::Online => "Online",
        MachineState::Connecting => "Connecting",
        MachineState::Disconnected => "Disconnected",
        MachineState::Sleeping => "Sleeping",
        MachineState::Unreachable => "Unreachable",
        MachineState::SshInteractionRequired => "Needs SSH login",
        MachineState::Unknown => "-",
    }
}

fn diagnostic(machine: &MachineInfo, id: &str, saved: Option<&SshTransport>) -> Option<String> {
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

fn login_tip(transport: &SshTransport) -> String {
    let prefix = ["facade", "machine", "add"];
    let mut words: Vec<_> = prefix.into_iter().map(str::to_owned).collect();
    if let Some(home) = &transport.remote_home {
        words.extend(["--home".into(), home.clone()]);
    }
    words.extend(ssh_args(transport).iter().cloned());
    match repair_command(&words) {
        Ok(command) => format!("Run '{command}'."),
        Err(words) => format!(
            "Run 'facade machine add' with these arguments, one per line:\n  {}",
            words[prefix.len()..].join("\n  ")
        ),
    }
}
