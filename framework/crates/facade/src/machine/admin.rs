//! The private request stream carried by an authenticated SSH login.

use std::io::{self, BufRead, Write};
use std::net::IpAddr;
use std::path::PathBuf;
use std::thread::JoinHandle;

use anyhow::{Context as _, ensure};
use facade_base::address::selector::{display_machine_id, parse_machine_selector};
use facade_base::api_v1::daemon::{
    ConnectedParams, MachineIdentity, MachineList, MachineRemove, MachineRemoveArgs,
    MachineRemoveResult,
};
use facade_base::api_v1::daemon_client::DaemonClient;
use facade_base::api_v1::{ErrorBody, NoArgs};
use facade_base::model::terminal::display_name;
use facade_base::paths;
use facade_base::ssh::{
    self, AuthorizationChange, AuthorizationFile, DedicatedIdentity, HostTrust,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::{
    Bootstrap, HelperUnavailable, LoginChallenge, RevocationFailure, SshSession, batch_serve,
    bootstrap_ssh, is_full_id, print_logout_cleanup, print_removed, print_trust, protected_login,
    proved_serve, read_bootstrap_line, reconnect_tip, revoke_key, save_ssh, saved_ssh, ssh_args,
    ssh_destination,
};
use crate::{SshTarget, single_line};

type Connect<'a> = dyn Fn() -> anyhow::Result<DaemonClient> + 'a;

#[derive(Clone, Serialize, Deserialize)]
struct Greeting {
    machine_id: String,
    name: String,
    account: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_ip: Option<IpAddr>,
}

impl Greeting {
    fn local(daemon: &mut DaemonClient) -> anyhow::Result<Self> {
        daemon.disable_auto_reconnect();
        let listed = daemon.call::<MachineList>(NoArgs {})?;
        let machine_id = daemon.hello_result.machine_id.clone();
        let name = listed
            .machines
            .into_iter()
            .find(|machine| machine.machine_id == machine_id)
            .context("the local machine is missing from the machine roster")?
            .name;
        Ok(Self {
            machine_id,
            name,
            account: ssh::ssh_account_name()?,
            source_ip: ssh::ssh_connection_source(),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Request {
    expected_machine_id: String,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    InstallKey {
        machine_id: String,
        name: String,
        public_key: String,
    },
    FinishKey {
        keep: bool,
    },
    PrepareReturn {
        machine_id: String,
        account: String,
        home: String,
        host_keys: Vec<String>,
    },
    SaveReturn,
    AbortReturn,
    Remove {
        machine_id: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Reply {
    Hello {
        #[serde(flatten)]
        machine: Greeting,
    },
    KeyInstalled {
        inserted: bool,
        scope: AuthorizationScope,
    },
    Complete,
    ReturnKey {
        destination: String,
        public_key: String,
    },
    ReturnSaved {
        destination: String,
    },
    ReturnFailed {
        detail: String,
        trust: TrustCleanup,
    },
    ReturnAborted {
        trust: TrustCleanup,
    },
    Removed {
        route: RouteOutcome,
        authorization: AuthorizationOutcome,
    },
    Error {
        detail: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AuthorizationScope {
    Account { account: String },
    Administrators { path: PathBuf },
}

impl AuthorizationScope {
    fn from_file(file: &AuthorizationFile, account: &str) -> Self {
        if file.administrators() {
            Self::Administrators {
                path: file.path().to_owned(),
            }
        } else {
            Self::Account {
                account: account.to_owned(),
            }
        }
    }

    fn target(&self, destination: &str) -> String {
        let address = destination.strip_prefix("ssh://").unwrap_or(destination);
        let host = address.rsplit_once('@').map_or(address, |(_, host)| host);
        let host = single_line(host);
        match self {
            Self::Account { account } => format!("{}@{host}", single_line(account)),
            Self::Administrators { path } => format!(
                "local Administrators on {host} via {}",
                single_line(&path.display().to_string())
            ),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum TrustCleanup {
    Confirmed,
    Failed { detail: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum RouteOutcome {
    Removed,
    Absent,
    Failed { detail: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum AuthorizationOutcome {
    Revoked,
    Absent,
    Failed { detail: String },
}

fn read_frame<T: DeserializeOwned>(input: &mut impl BufRead) -> anyhow::Result<Option<T>> {
    read_bootstrap_line(input)?
        .map(|line| serde_json::from_slice(&line).context("invalid SSH administration frame"))
        .transpose()
}

fn write_frame<T: Serialize>(output: &mut impl Write, frame: &T) -> anyhow::Result<()> {
    serde_json::to_writer(&mut *output, frame)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

struct AdminClient {
    machine: Greeting,
    session: Option<SshSession>,
}

impl AdminClient {
    fn open(
        target: &SshTarget,
        mode: ssh::SshMode,
        purpose: ssh::SshAdminMode,
    ) -> anyhow::Result<Self> {
        let mut session = bootstrap_ssh(
            target,
            &protected_login(target, mode)?,
            Bootstrap::Admin(purpose),
            mode == ssh::SshMode::Add,
        )?;
        let hello = read_frame(&mut session.output);
        match hello {
            Ok(Some(Reply::Hello { machine })) if is_full_id(&machine.machine_id) => Ok(Self {
                machine,
                session: Some(session),
            }),
            result => {
                session.finish(true)?;
                result?;
                anyhow::bail!(
                    "the SSH helper did not report a full Facade Code Framework machine ID"
                );
            }
        }
    }

    fn confirm(&self, machine_id: &str) -> anyhow::Result<()> {
        ensure!(
            self.machine.machine_id == machine_id,
            "the authenticated SSH machine ID did not match the expected machine ID"
        );
        Ok(())
    }

    fn call(&mut self, operation: Operation) -> anyhow::Result<Reply> {
        let session = self
            .session
            .as_mut()
            .expect("an open SSH administration stream");
        write_frame(
            &mut session.input,
            &Request {
                expected_machine_id: self.machine.machine_id.clone(),
                operation,
            },
        )?;
        match read_frame(&mut session.output)? {
            Some(Reply::Error { detail }) => anyhow::bail!("{detail}"),
            Some(reply) => Ok(reply),
            None => anyhow::bail!("SSH closed before Facade Code Framework confirmed the result"),
        }
    }

    fn finish_key(&mut self, keep: bool) -> anyhow::Result<()> {
        ensure!(
            matches!(self.call(Operation::FinishKey { keep })?, Reply::Complete),
            "the SSH helper did not confirm the key operation"
        );
        Ok(())
    }
}

impl Drop for AdminClient {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            // EOF lets the remote helper undo any insertion it still owns.
            let _ = session.finish(false);
        }
    }
}

fn different_machine(id: &str, local: &Greeting) -> anyhow::Result<()> {
    ensure!(
        is_full_id(id) && !id.eq_ignore_ascii_case(&local.machine_id),
        "expected the full ID of another Facade Code Framework machine"
    );
    Ok(())
}

pub(super) fn serve(connect: &Connect<'_>) -> anyhow::Result<()> {
    let mut daemon = connect()?;
    let greeting = Greeting::local(&mut daemon)?;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    write_frame(
        &mut output,
        &Reply::Hello {
            machine: greeting.clone(),
        },
    )?;
    let mut state = AdminState {
        local: greeting,
        forward_key: None,
        return_attempt: None,
    };
    let result = (|| -> anyhow::Result<()> {
        while let Some(request) = read_frame::<Request>(&mut input)? {
            let reply = state
                .handle(request, &mut daemon, connect)
                .unwrap_or_else(|error| Reply::Error {
                    detail: format!("{error:#}"),
                });
            write_frame(&mut output, &reply)?;
        }
        Ok(())
    })();
    let key = state.finish_key(false);
    let trust = rollback_trust(
        state
            .return_attempt
            .take()
            .and_then(|attempt| attempt.trust),
    );
    if let TrustCleanup::Failed { detail } = trust {
        eprintln!(
            "error: Could not roll back pending SSH host trust: {}",
            single_line(&detail)
        );
    }
    key?;
    result
}

struct AdminState {
    local: Greeting,
    forward_key: Option<AuthorizationChange>,
    return_attempt: Option<ReturnAttempt>,
}

impl AdminState {
    fn handle(
        &mut self,
        request: Request,
        daemon: &mut DaemonClient,
        connect: &Connect<'_>,
    ) -> anyhow::Result<Reply> {
        ensure!(
            request.expected_machine_id == self.local.machine_id,
            "unexpected Facade Code Framework machine ID"
        );
        match request.operation {
            Operation::InstallKey {
                machine_id,
                name,
                public_key,
            } => {
                different_machine(&machine_id, &self.local)?;
                ensure!(
                    self.forward_key.is_none(),
                    "a key installation is already pending"
                );
                let file = ssh::authorization_file()?;
                self.forward_key = file.authorize(&public_key, &name, &machine_id)?;
                Ok(Reply::KeyInstalled {
                    inserted: self.forward_key.is_some(),
                    scope: AuthorizationScope::from_file(&file, &self.local.account),
                })
            }
            Operation::FinishKey { keep } => {
                self.finish_key(keep)?;
                Ok(Reply::Complete)
            }
            Operation::PrepareReturn {
                machine_id,
                account,
                home,
                host_keys,
            } => {
                ensure!(
                    self.return_attempt.is_none(),
                    "a return connection is already pending"
                );
                let (reply, pending) =
                    prepare_return(&self.local, connect, machine_id, &account, home, &host_keys);
                self.return_attempt = pending;
                Ok(reply)
            }
            Operation::SaveReturn => {
                let attempt = self
                    .return_attempt
                    .take()
                    .context("no return connection is pending")?;
                Ok(attempt.save(connect))
            }
            Operation::AbortReturn => Ok(Reply::ReturnAborted {
                trust: rollback_trust(self.return_attempt.take().and_then(|attempt| attempt.trust)),
            }),
            Operation::Remove { machine_id } => {
                different_machine(&machine_id, &self.local)?;
                Ok(remove_here(daemon, &machine_id))
            }
        }
    }

    fn finish_key(&mut self, keep: bool) -> anyhow::Result<()> {
        if let Some(change) = self.forward_key.take()
            && !keep
        {
            change.rollback()?;
        }
        Ok(())
    }
}

fn rollback_trust(trust: Option<HostTrust>) -> TrustCleanup {
    match trust.map(HostTrust::rollback).transpose() {
        Ok(_) => TrustCleanup::Confirmed,
        Err(error) => TrustCleanup::Failed {
            detail: format!("{error:#}"),
        },
    }
}

struct ReturnAttempt {
    machine_id: String,
    target: SshTarget,
    destination: String,
    home: PathBuf,
    trust: Option<HostTrust>,
    identity: Option<DedicatedIdentity>,
}

fn prepare_return(
    local: &Greeting,
    connect: &Connect<'_>,
    machine_id: String,
    account: &str,
    home: String,
    host_keys: &[String],
) -> (Reply, Option<ReturnAttempt>) {
    let result = (|| {
        different_machine(&machine_id, local)?;
        let address = local
            .source_ip
            .context("SSH did not report the originating address")?;
        let destination = format!("{account}@{address}");
        let attempt = ReturnAttempt {
            machine_id,
            target: SshTarget {
                home: Some(home),
                ssh_args: vec![destination.clone()],
            },
            destination,
            home: paths::facade_home()?,
            trust: None,
            identity: None,
        };
        Ok::<_, anyhow::Error>((attempt, address))
    })();
    let (mut attempt, address) = match result {
        Ok(result) => result,
        Err(error) => return (return_failure(error, None), None),
    };
    match attempt.try_batch(connect, address, host_keys) {
        Ok(Some(public_key)) => (
            Reply::ReturnKey {
                destination: attempt.destination.clone(),
                public_key,
            },
            Some(attempt),
        ),
        Ok(None) => (
            Reply::ReturnSaved {
                destination: attempt.destination,
            },
            None,
        ),
        Err(error) => (return_failure(error, attempt.trust), None),
    }
}

impl ReturnAttempt {
    fn try_batch(
        &mut self,
        connect: &Connect<'_>,
        address: IpAddr,
        host_keys: &[String],
    ) -> anyhow::Result<Option<String>> {
        let daemon = connect()?;
        let return_args = std::mem::take(&mut self.target.ssh_args);
        self.target.ssh_args = ssh::trusted_login_args(&return_args, None)?;
        let words = ssh::ssh_login_args(&self.target.ssh_args, ssh::SshMode::Saved, None)?;
        let dial = || bootstrap_ssh(&self.target, &words, Bootstrap::InstalledServe, false);
        let mut session = dial();
        if matches!(
            session
                .as_ref()
                .err()
                .and_then(|error| error.downcast_ref()),
            Some(LoginChallenge::UnknownHost)
        ) {
            let trust = ssh::trust_host_keys(&self.target.ssh_args, address, host_keys)?;
            self.trust = Some(trust);
            let trust = self
                .trust
                .as_ref()
                .expect("the return host trust was retained");
            ssh::trusted_login_args(&return_args, Some(trust.path()))?;
            session = dial();
        }
        match session {
            Ok(session) => {
                save_ssh(&self.target, daemon, session, Some(self.machine_id.clone()))?;
                Ok(None)
            }
            Err(error) if matches!(error.downcast_ref(), Some(LoginChallenge::Credentials)) => {
                let identity = ssh::dedicated_identity(&self.home)?;
                let key = identity.public_key.clone();
                self.identity = Some(identity);
                Ok(Some(key))
            }
            Err(error) => Err(error),
        }
    }

    fn save(self, connect: &Connect<'_>) -> Reply {
        let result = (|| {
            let daemon = connect()?;
            let identity = self
                .identity
                .as_ref()
                .context("a dedicated return key was not prepared")?;
            let target = SshTarget {
                home: self.target.home,
                ssh_args: ssh::dedicated_login_args(
                    std::slice::from_ref(&self.destination),
                    &identity.key_path,
                    self.trust.as_ref().map(HostTrust::path),
                )?,
            };
            let session = proved_serve(&target, &self.home, identity)?;
            save_ssh(&target, daemon, session, Some(self.machine_id))?;
            Ok(())
        })();
        match result {
            Ok(()) => Reply::ReturnSaved {
                destination: self.destination,
            },
            Err(error) => return_failure(error, self.trust),
        }
    }
}

fn return_failure(error: anyhow::Error, trust: Option<HostTrust>) -> Reply {
    let detail = format!("{error:#}");
    let mut trust = rollback_trust(trust);
    if matches!(trust, TrustCleanup::Confirmed) && error.is::<ssh::HostTrustCleanupUnconfirmed>() {
        trust = TrustCleanup::Failed {
            detail: detail.clone(),
        };
    }
    Reply::ReturnFailed { detail, trust }
}

#[derive(Serialize, Deserialize)]
pub(super) struct Receipt {
    connected: ConnectedParams,
    destination: String,
    installed_key: Option<String>,
    forward_failure: Option<String>,
    returned: Option<ReturnReceipt>,
}

#[derive(Serialize, Deserialize)]
enum ReturnReceipt {
    Saved {
        local_name: String,
        destination: String,
        installed_key: Option<String>,
    },
    Failed(String),
}

impl Receipt {
    pub(super) fn print(&self) -> i32 {
        let remote_name = display_name(&self.connected.machine.name);
        if self.connected.first_connection {
            print_trust(&self.connected.machine);
        }
        if let Some(note) = &self.installed_key {
            println_or_end!("{note}");
        }
        if let Some(ReturnReceipt::Saved {
            installed_key: Some(note),
            ..
        }) = &self.returned
        {
            println_or_end!("{note}");
        }
        if self.returned.is_some() {
            println_or_end!(
                "Saved forward connection to {remote_name} ({}).",
                self.destination
            );
        } else {
            println_or_end!("Saved the connection to {remote_name}.");
        }
        print_logout_cleanup(&self.connected.machine);
        if let Some(failure) = &self.forward_failure {
            eprintln!("error: {failure}");
        }
        match &self.returned {
            Some(ReturnReceipt::Saved {
                local_name,
                destination,
                ..
            }) => {
                println_or_end!(
                    "Saved return connection from {remote_name} to {local_name} ({destination})."
                );
            }
            Some(ReturnReceipt::Failed(error)) => {
                eprintln!("error: {error}");
                return 1;
            }
            None => {}
        }
        i32::from(self.forward_failure.is_some())
    }
}

struct Forward {
    connected: ConnectedParams,
    relay: JoinHandle<()>,
    installed_key: Option<String>,
    authorization_failure: Option<String>,
    admin: Option<AdminClient>,
}

pub(super) fn link(
    target: SshTarget,
    bidirectional: bool,
    connect: &Connect<'_>,
) -> anyhow::Result<i32> {
    let destination = ssh_destination(&target)?;
    let forward = save_forward(&target, connect)?;
    let remote_name = display_name(&forward.connected.machine.name);
    let returned = bidirectional.then(|| {
        if forward.authorization_failure.is_some() {
            return ReturnReceipt::Failed(format!("Could not set up the return connection from {remote_name} because forward authorization is unconfirmed."));
        }
        match enroll_return(&target, &forward.connected.machine.machine_id, forward.admin, connect) {
            Ok(receipt) => receipt,
            Err(error) => ReturnReceipt::Failed(format!(
                "Could not set up the return connection from {remote_name}: {error:#}"
            )),
        }
    });
    let receipt = Receipt {
        connected: forward.connected,
        destination: single_line(destination),
        installed_key: forward.installed_key,
        forward_failure: forward.authorization_failure,
        returned,
    };
    write_frame(&mut io::stdout().lock(), &receipt)?;
    let _ = forward.relay.join();
    Ok(0)
}

fn save_forward(target: &SshTarget, connect: &Connect<'_>) -> anyhow::Result<Forward> {
    let mut daemon = connect()?;
    let challenge = match batch_serve(target) {
        Ok(session) => return ordinary_forward(target, daemon, session),
        Err(error) => match error.downcast_ref::<LoginChallenge>() {
            Some(challenge) => *challenge,
            None => return Err(error),
        },
    };
    // A host-key confirmation can make the original credentials usable in batch mode.
    let admin = match AdminClient::open(target, ssh::SshMode::Add, ssh::SshAdminMode::Enroll) {
        Err(error) if !error.is::<HelperUnavailable>() => return Err(error),
        result => result,
    };
    if challenge == LoginChallenge::UnknownHost {
        match batch_serve(target) {
            Ok(session) => return ordinary_forward(target, daemon, session),
            Err(error) if !matches!(error.downcast_ref(), Some(LoginChallenge::Credentials)) => {
                return Err(error);
            }
            Err(_) => {}
        }
    }
    let mut admin = admin?;

    let local = Greeting::local(&mut daemon)?;
    different_machine(&admin.machine.machine_id, &local)?;
    let home = paths::facade_home()?;
    let identity = ssh::dedicated_identity(&home)?;
    let verified_target = SshTarget {
        home: target.home.clone(),
        ssh_args: ssh::dedicated_login_args(&target.ssh_args, &identity.key_path, None)?,
    };
    let (inserted, scope) = match admin.call(Operation::InstallKey {
        machine_id: local.machine_id,
        name: local.name.clone(),
        public_key: identity.public_key.clone(),
    }) {
        Ok(Reply::KeyInstalled { inserted, scope }) => (inserted, scope),
        Ok(_) => anyhow::bail!("the SSH helper did not confirm the forward key installation"),
        Err(error) => {
            return Err(error.context("Could not confirm forward SSH key installation or rollback"));
        }
    };
    let saved = proved_serve(&verified_target, &home, &identity).and_then(|session| {
        save_ssh(
            &verified_target,
            daemon,
            session,
            Some(admin.machine.machine_id.clone()),
        )
    });
    let (connected, relay) = match saved {
        Ok(saved) => saved,
        Err(error) => {
            return match admin.finish_key(false) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(error.context(format!(
                    "Could not confirm forward SSH key rollback on {}: {cleanup:#}",
                    display_name(&admin.machine.name)
                ))),
            };
        }
    };
    let authorization_failure = admin.finish_key(true).err().map(|error| {
        format!(
            "Could not confirm forward SSH authorization on {}: {error:#}",
            display_name(&connected.machine.name)
        )
    });
    let installed_key = (inserted && authorization_failure.is_none()).then(|| {
        format!(
            "Installed Facade Code Framework SSH key on {} (allows {} on {} to log in to {} without a password).",
            display_name(&connected.machine.name),
            single_line(&local.account),
            display_name(&local.name),
            scope.target(ssh_destination(target).expect("the SSH destination was checked")),
        )
    });
    Ok(Forward {
        connected,
        relay,
        installed_key,
        authorization_failure,
        admin: Some(admin),
    })
}

fn ordinary_forward(
    target: &SshTarget,
    daemon: DaemonClient,
    session: SshSession,
) -> anyhow::Result<Forward> {
    let (connected, relay) = save_ssh(target, daemon, session, None)?;
    Ok(Forward {
        connected,
        relay,
        installed_key: None,
        authorization_failure: None,
        admin: None,
    })
}

fn enroll_return(
    target: &SshTarget,
    expected_id: &str,
    admin: Option<AdminClient>,
    connect: &Connect<'_>,
) -> anyhow::Result<ReturnReceipt> {
    let mut admin = match admin {
        Some(admin) => admin,
        None => AdminClient::open(target, ssh::SshMode::Saved, ssh::SshAdminMode::Remove)?,
    };
    admin.confirm(expected_id)?;
    let local = Greeting::local(&mut connect()?)?;
    let remote_name = display_name(&admin.machine.name);
    let local_name = display_name(&local.name);
    let source = admin
        .machine
        .source_ip
        .context("SSH did not report the local address for the return connection")?;
    let destination = format!("{}@{source}", local.account);
    let home = paths::facade_home()?;
    let home = home
        .to_str()
        .context("the local Facade home cannot be passed to SSH")?
        .to_owned();
    // Existing verified trust can work even when this user cannot read sshd's public keys.
    let host_keys = ssh::host_public_keys().unwrap_or_default();
    let reply = admin.call(Operation::PrepareReturn {
        machine_id: local.machine_id.clone(),
        account: local.account.clone(),
        home,
        host_keys,
    });
    let (reported_destination, public_key) = match reply {
        Ok(Reply::ReturnSaved {
            destination: confirmed,
        }) if confirmed == destination => {
            return Ok(ReturnReceipt::Saved {
                local_name,
                destination: single_line(&confirmed),
                installed_key: None,
            });
        }
        Ok(Reply::ReturnKey {
            destination,
            public_key,
        }) => (destination, public_key),
        reply => return Ok(return_diagnostic(reply, &remote_name, &destination, target)),
    };
    if reported_destination != destination {
        let reply = admin.call(Operation::AbortReturn);
        let mut detail = format!(
            "The SSH helper reported an unexpected destination for the return connection from {remote_name}."
        );
        note_trust(&mut detail, reply, &remote_name);
        return Ok(ReturnReceipt::Failed(detail));
    }

    let authorization = (|| {
        let file = ssh::authorization_file()?;
        let scope = AuthorizationScope::from_file(&file, &local.account);
        let change = file.authorize(&public_key, &admin.machine.name, expected_id)?;
        Ok::<_, anyhow::Error>((scope, change))
    })();
    let (scope, change) = match authorization {
        Ok(result) => result,
        Err(error) => {
            let error = single_line(&format!("{error:#}"));
            let mut detail = format!(
                "Could not authorize {remote_name}'s return SSH key on {local_name}: {}.",
                error.trim_end_matches('.')
            );
            if error.contains("requires an elevated Administrator terminal") {
                let add_tip = bidirectional_add_tip(target);
                detail.push_str(&format!(
                    "\n  tip: rerun {add_tip} in an Administrator terminal, or keep {} open when bidirectional access is needed.",
                    keep_connect_open(target)
                ));
            }
            note_trust(
                &mut detail,
                admin.call(Operation::AbortReturn),
                &remote_name,
            );
            return Ok(ReturnReceipt::Failed(detail));
        }
    };
    match admin.call(Operation::SaveReturn) {
        Ok(Reply::ReturnSaved {
            destination: confirmed,
        }) if confirmed == destination => {
            let installed_key = change.is_some().then(|| format!(
                "Installed {remote_name}'s Facade Code Framework SSH key on {local_name} (allows {} on {remote_name} to log in to {} without a password).",
                single_line(&admin.machine.account),
                scope.target(&destination)
            ));
            Ok(ReturnReceipt::Saved {
                local_name,
                destination: single_line(&confirmed),
                installed_key,
            })
        }
        reply => {
            let ReturnReceipt::Failed(mut detail) =
                return_diagnostic(reply, &remote_name, &destination, target)
            else {
                unreachable!("an unconfirmed return cannot yield a saved receipt");
            };
            if let Some(change) = change
                && let Err(error) = change.rollback()
            {
                detail.push_str(&format!(
                    "\nCould not roll back the SSH key on {local_name}: {}.",
                    single_line(&format!("{error:#}")).trim_end_matches('.')
                ));
            }
            Ok(ReturnReceipt::Failed(detail))
        }
    }
}

fn return_diagnostic(
    reply: anyhow::Result<Reply>,
    remote_name: &str,
    destination: &str,
    target: &SshTarget,
) -> ReturnReceipt {
    let (reason, trust) = match reply {
        Ok(Reply::ReturnFailed { detail, trust }) => (detail, Ok(Reply::ReturnAborted { trust })),
        Ok(_) => (
            "the SSH helper did not confirm the result".into(),
            Ok(Reply::Complete),
        ),
        Err(error) => (format!("{error:#}"), Err(error)),
    };
    let reason = ssh_reason(&reason);
    let mut detail = format!(
        "Could not connect from {remote_name} back to {} over SSH: {reason}\n  tip: keep {} open when agents on {remote_name} need to reach this machine, or run 'facade machine add <THIS_MACHINE>' on {remote_name} over a shared network (such as Tailscale or LAN).",
        single_line(destination),
        keep_connect_open(target)
    );
    note_trust(&mut detail, trust, remote_name);
    ReturnReceipt::Failed(detail)
}

fn note_trust(detail: &mut String, reply: anyhow::Result<Reply>, machine: &str) {
    let reason = match reply {
        Ok(Reply::ReturnAborted {
            trust: TrustCleanup::Confirmed,
        }) => return,
        Ok(Reply::ReturnAborted {
            trust: TrustCleanup::Failed { detail },
        }) => detail,
        Ok(_) => "the SSH helper did not confirm cleanup".into(),
        Err(error) => format!("{error:#}"),
    };
    detail.push_str(&format!(
        "\nCould not confirm SSH host trust cleanup on {machine}: {}.",
        single_line(&reason).trim_end_matches('.')
    ));
}

fn keep_connect_open(target: &SshTarget) -> String {
    let tip = reconnect_tip(target);
    tip.strip_prefix("Reconnect with ")
        .and_then(|tip| tip.strip_suffix('.'))
        .unwrap_or("'facade machine connect'")
        .to_owned()
}

fn bidirectional_add_tip(target: &SshTarget) -> String {
    let mut words = ["facade", "machine", "add", "--bidirectional"]
        .map(str::to_owned)
        .to_vec();
    if let Some(home) = &target.home {
        words.extend(["--home".into(), home.clone()]);
    }
    words.extend(target.ssh_args.iter().cloned());
    crate::errors::repair_command(&words)
        .map(|command| format!("'{command}'"))
        .unwrap_or_else(|_| "'facade machine add --bidirectional'".into())
}

fn ssh_reason(detail: &str) -> String {
    let first = detail.lines().next().unwrap_or(detail);
    let reason = first
        .split_once(" over SSH: ")
        .map_or(first, |(_, reason)| reason);
    let reason = if reason.starts_with("ssh: connect to host ") {
        reason.rsplit_once(": ").map_or(reason, |(_, cause)| cause)
    } else {
        reason
    };
    single_line(reason)
}

fn remove_exactly(
    daemon: &mut DaemonClient,
    machine_id: &str,
) -> anyhow::Result<Option<MachineRemoveResult>> {
    match daemon.call::<MachineRemove>(MachineRemoveArgs {
        machine: machine_id.to_owned(),
        expected_machine_id: Some(machine_id.to_owned()),
    }) {
        Ok(removed) => {
            ensure!(
                removed.machine_id == machine_id,
                "Facade Code Framework reported a different removed machine ID"
            );
            Ok(Some(removed))
        }
        Err(error)
            if error
                .downcast_ref::<ErrorBody>()
                .is_some_and(|body| body.data.reason == "not_found") =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn revoke(machine_id: &str) -> AuthorizationOutcome {
    match revoke_key(machine_id) {
        Ok(true) => AuthorizationOutcome::Revoked,
        Ok(false) => AuthorizationOutcome::Absent,
        Err(RevocationFailure::Elevate(path)) => AuthorizationOutcome::Failed {
            detail: format!(
                "writing {} requires an elevated Administrator terminal",
                path.display()
            ),
        },
        Err(RevocationFailure::Other(error)) => AuthorizationOutcome::Failed {
            detail: format!("{error:#}"),
        },
    }
}

fn remove_here(daemon: &mut DaemonClient, machine_id: &str) -> Reply {
    let route = match remove_exactly(daemon, machine_id) {
        Ok(Some(_)) => RouteOutcome::Removed,
        Ok(None) => RouteOutcome::Absent,
        Err(error) => RouteOutcome::Failed {
            detail: format!("{error:#}"),
        },
    };
    Reply::Removed {
        route,
        authorization: revoke(machine_id),
    }
}

pub(super) fn remove(daemon: &mut DaemonClient, machine: String) -> anyhow::Result<i32> {
    daemon.disable_auto_reconnect();
    let local_id = daemon.hello_result.machine_id.clone();
    let machines = daemon.call::<MachineList>(NoArgs {})?.machines;
    let identities = machines
        .iter()
        .map(|machine| MachineIdentity {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
        })
        .collect::<Vec<_>>();
    let selector = parse_machine_selector(&machine)?;
    let matches: Vec<_> = identities
        .iter()
        .enumerate()
        .filter(|(_, identity)| selector.matches(identity))
        .collect();
    let idx = match matches.as_slice() {
        [(idx, _)] => *idx,
        [] => anyhow::bail!(
            "Unknown machine \"{}\".\nRun 'facade machine list' to see known machines.",
            display_name(&machine)
        ),
        ambiguous => {
            let ids = ambiguous
                .iter()
                .filter_map(|(_, identity)| {
                    display_machine_id(&identity.machine_id, &identities).ok()
                })
                .collect::<Vec<_>>();
            anyhow::bail!(
                "More than one machine matches \"{}\".\nUse an exact machine ID from 'facade machine list': {}.",
                display_name(&machine),
                ids.join(", ")
            );
        }
    };
    let target = &machines[idx];
    let remote_name = display_name(&target.name);
    ensure!(
        target.machine_id != local_id,
        "Cannot remove the local machine \"{remote_name}\"."
    );
    let local = machines
        .iter()
        .find(|row| row.machine_id == local_id)
        .context("the local machine is missing from the machine roster")?;
    let local_name = display_name(&local.name);

    let remote = (|| {
        let saved = saved_ssh(&local.connections, &local_id, &target.machine_id)
            .context("there is no saved direct SSH connection")?;
        let ssh_target = SshTarget {
            home: saved.remote_home.clone(),
            ssh_args: ssh_args(saved).to_vec(),
        };
        let mut admin =
            AdminClient::open(&ssh_target, ssh::SshMode::Saved, ssh::SshAdminMode::Remove)?;
        admin.confirm(&target.machine_id)?;
        match admin.call(Operation::Remove {
            machine_id: local_id.clone(),
        })? {
            Reply::Removed {
                route,
                authorization,
            } => Ok((route, authorization)),
            _ => anyhow::bail!("the SSH helper did not confirm removal"),
        }
    })();

    let local_route = remove_exactly(daemon, &target.machine_id);
    let local_authorization = revoke(&target.machine_id);
    let mut failed = false;
    match local_route {
        Ok(Some(removed)) => {
            print_removed(&removed, &target.name);
        }
        Ok(None) => println_or_end!("No saved connection to {remote_name}."),
        Err(error) => {
            failed = true;
            eprintln!(
                "error: Could not remove the saved connection to {remote_name} on {local_name}: {}.",
                ssh_reason(&format!("{error:#}")).trim_end_matches('.')
            );
        }
    }
    if let AuthorizationOutcome::Failed { detail } = local_authorization {
        failed = true;
        eprintln!(
            "error: Could not revoke SSH authorization for {remote_name} on {local_name}: {}.",
            single_line(&detail).trim_end_matches('.')
        );
    }
    let mut route_unconfirmed = None;
    let mut authorization_unconfirmed = None;
    match remote {
        Ok((route, authorization)) => {
            match route {
                RouteOutcome::Removed => println_or_end!(
                    "Removed the saved return connection from {remote_name} to {local_name}."
                ),
                RouteOutcome::Absent => println_or_end!(
                    "No saved return connection from {remote_name} to {local_name}."
                ),
                RouteOutcome::Failed { detail } => route_unconfirmed = Some(detail),
            }
            if let AuthorizationOutcome::Failed { detail } = authorization {
                authorization_unconfirmed = Some(detail);
            }
        }
        Err(error) => route_unconfirmed = Some(format!("{error:#}")),
    }
    if let Some(detail) = route_unconfirmed {
        failed = true;
        let detail = ssh_reason(&detail);
        let detail = if detail.eq_ignore_ascii_case("connection timed out") {
            "SSH connection timed out"
        } else {
            &detail
        };
        eprintln!(
            "error: Could not confirm removal on {remote_name}: {}.",
            detail.trim_end_matches('.')
        );
        eprintln!("Check the return connection and SSH authorization on {remote_name}.");
        eprintln!(
            "On {remote_name}, use 'facade machine list' to verify the saved return connection to {local_name} (machine ID {local_id}). If confirmed, run 'facade machine remove <MACHINE>' with the ID shown for that row."
        );
    }
    if let Some(detail) = authorization_unconfirmed {
        failed = true;
        eprintln!(
            "error: Could not confirm SSH authorization cleanup on {remote_name}: {}.",
            single_line(&detail).trim_end_matches('.')
        );
    }
    Ok(i32::from(failed))
}

#[cfg(test)]
mod tests {
    use super::{Reply, TrustCleanup, return_failure};
    use facade_base::ssh::HostTrustCleanupUnconfirmed;

    #[test]
    fn a_failed_append_without_a_receipt_reports_unconfirmed_cleanup() {
        let append_error = "could not verify the native SSH trust write";
        let path = "/fixture/.ssh/known_hosts";
        let error = anyhow::anyhow!(append_error)
            .context(HostTrustCleanupUnconfirmed)
            .context(format!("updating {path}"));
        let Reply::ReturnFailed {
            detail,
            trust: TrustCleanup::Failed { detail: cleanup },
        } = return_failure(error, None)
        else {
            panic!("an unconfirmed append must report failed trust cleanup");
        };
        assert_eq!(cleanup, detail);
        assert!(cleanup.contains(path));
        assert!(cleanup.contains(append_error));

        let error = anyhow::anyhow!("could not open the native SSH trust file");
        assert!(matches!(
            return_failure(error, None),
            Reply::ReturnFailed {
                trust: TrustCleanup::Confirmed,
                ..
            }
        ));
    }
}
