//! The CLIs' integrations: Facade's entries in a CLI's user configuration, through which the
//! sessions the person starts join as guests.
//!
//! One integration is written or taken out at a time. For each file it writes, the store keeps
//! what the file held before Facade's entries and what Facade last wrote, so that taking them out
//! of a file nothing else changed since puts it back byte for byte, and taking them out of one the
//! person changed takes out only what is certainly Facade's. A CLI that rewrites its configuration
//! while it runs gets Facade's server through the CLI's own command
//! (`facade_rules::integration::command_program`).

mod command;
mod files;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use facade_base::daemon::{
    IntegrationArgs, IntegrationInfo, IntegrationPart, IntegrationsArgs, IntegrationsList,
    PartState,
};
use facade_base::jsonrpc::ErrorBody;
use facade_base::programs::Held;
use facade_rules::integration::{self, Held as Holds, Programs};

use crate::store::{IntegrationFile, IntegrationTable};

use super::log;
use command::Server;

pub(super) struct Integrations {
    table: IntegrationTable,
    held: Arc<Held>,
    /// Held while an integration is written or taken out.
    one_at_a_time: Arc<Mutex<()>>,
}

/// What a write or a removal works with, off the daemon's threads.
#[derive(Clone)]
struct Work {
    table: IntegrationTable,
    held: Arc<Held>,
    one_at_a_time: Arc<Mutex<()>>,
}

impl Integrations {
    pub(super) fn new(table: IntegrationTable, held: Arc<Held>) -> Integrations {
        Integrations {
            table,
            held,
            one_at_a_time: Arc::default(),
        }
    }

    fn work(&self) -> Work {
        Work {
            table: self.table.clone(),
            held: self.held.clone(),
            one_at_a_time: self.one_at_a_time.clone(),
        }
    }

    /// Writes Facade's entries for `args.cli`. Every file is read and its new text made first:
    /// where one cannot be, nothing is written.
    pub(super) async fn add(&self, args: IntegrationArgs) -> Result<IntegrationInfo, ErrorBody> {
        let work = self.work();
        off_thread(move || work.add(&args.cli, &args.env)).await
    }

    /// Takes Facade's entries for `args.cli` out, and says what of them stays.
    pub(super) async fn remove(&self, args: IntegrationArgs) -> Result<IntegrationInfo, ErrorBody> {
        let work = self.work();
        off_thread(move || work.remove(&args.cli, &args.env)).await
    }

    /// Each CLI Facade integrates, and whether its configuration holds Facade's entries.
    pub(super) async fn list(&self, args: IntegrationsArgs) -> Result<IntegrationsList, ErrorBody> {
        let work = self.work();
        off_thread(move || {
            let named = Named::of(&work.held, &args.env)?;
            let integrations = integration::CLIS
                .iter()
                .map(|cli| work.info(cli, &args.env, &named.programs()))
                .collect::<Result<_, _>>()?;
            Ok(IntegrationsList { integrations })
        })
        .await
    }

    /// Writes anew each integration an earlier version wrote, as after an upgrade: one whose files
    /// all still hold what Facade last wrote, and whose entries this version writes otherwise, is
    /// added again in the daemon's environment. One the person changed since stays as it is, and
    /// `facade integration list` shows it changed.
    pub(super) async fn bring_up_to_date(&self) {
        let env = facade_base::daemon_client::environment().0;
        for cli in integration::CLIS {
            let (work, check) = (self.work(), env.clone());
            let stale = off_thread(move || {
                let named = Named::of(&work.held, &check)?;
                work.written_earlier(cli, &check, &named.programs())
            })
            .await;
            let added = match stale {
                Ok(false) => continue,
                Ok(true) => {
                    let args = IntegrationArgs {
                        cli: cli.to_string(),
                        env: env.clone(),
                    };
                    self.add(args).await.map(drop)
                }
                Err(error) => Err(error),
            };
            match added {
                Ok(()) => log(
                    "info",
                    &format!("{cli}'s integration, which an earlier Facade wrote, is written anew"),
                ),
                Err(error) => log(
                    "warn",
                    &format!(
                        "{cli}'s integration, which an earlier Facade wrote, stays as it was: {}",
                        error.message
                    ),
                ),
            }
        }
    }
}

impl Work {
    fn add(&self, cli: &str, env: &BTreeMap<String, String>) -> Result<IntegrationInfo, ErrorBody> {
        let _one = self.lock();
        let named = Named::of(&self.held, env)?;
        let programs = named.programs();
        let kept = self.kept(cli)?;
        let mut planned = Vec::new();
        for target in integration::targets(cli, env).map_err(ErrorBody::invalid_argument)? {
            planned.push(files::plan(target, &programs)?);
        }
        let server = match Server::of(cli, env) {
            Some(server) => server.plan_add(&programs)?.map(|program| (server, program)),
            None => None,
        };
        let now = facade_base::time::iso_now();
        for write in planned.into_iter().filter(files::Write::changes) {
            let name = write.name();
            let before = files::before_of(write.kind(), write.current(), find(&kept, &name))?;
            self.table
                .keep_integration_file(cli, &name, before.as_deref(), write.bytes(), &now)
                .map_err(ErrorBody::internal)?;
            write.apply()?;
        }
        if let Some((server, program)) = server {
            let added = server.add(&program, &programs)?;
            self.table
                .keep_integration_file(cli, &server.part(), None, added.as_bytes(), &now)
                .map_err(ErrorBody::internal)?;
        }
        let mut info = self.info(cli, env, &programs)?;
        info.notes.extend(integration::note(cli).map(String::from));
        Ok(info)
    }

    fn remove(
        &self,
        cli: &str,
        env: &BTreeMap<String, String>,
    ) -> Result<IntegrationInfo, ErrorBody> {
        let _one = self.lock();
        let named = Named::of(&self.held, env)?;
        let programs = named.programs();
        let kept = self.kept(cli)?;
        let mut notes = Vec::new();
        for target in integration::targets(cli, env).map_err(ErrorBody::invalid_argument)? {
            let name = target.file.to_string_lossy().into_owned();
            let stays =
                files::take_out_of(&target.file, target.kind, find(&kept, &name), &programs)?;
            notes.extend(stays);
            self.forget(cli, &name)?;
        }
        if let Some(server) = Server::of(cli, env) {
            let part = server.part();
            notes.extend(server.remove(&programs, find(&kept, &part))?);
            self.forget(cli, &part)?;
        }
        let mut info = self.info(cli, env, &programs)?;
        info.notes = notes;
        Ok(info)
    }

    /// Whether `cli`'s integration is one an earlier version wrote: every file Facade wrote for
    /// it, where the daemon's environment finds it, still holds what Facade last wrote, and its
    /// entries are not as this version writes them.
    fn written_earlier(
        &self,
        cli: &str,
        env: &BTreeMap<String, String>,
        programs: &Programs,
    ) -> Result<bool, ErrorBody> {
        let kept = self.kept(cli)?;
        if kept.is_empty() {
            return Ok(false);
        }
        let targets: Vec<String> = integration::targets(cli, env)
            .map_err(ErrorBody::invalid_argument)?
            .iter()
            .map(|target| target.file.to_string_lossy().into_owned())
            .collect();
        let server = Server::of(cli, env);
        for file in &kept {
            let unchanged = match &server {
                Some(server) if file.file == server.part() => server.holds(&file.written)?,
                _ => {
                    targets.contains(&file.file)
                        && files::read(&files::real_path(Path::new(&file.file)))?.as_deref()
                            == Some(file.written.as_slice())
                }
            };
            if !unchanged {
                return Ok(false);
            }
        }
        let info = self.info(cli, env, programs)?;
        Ok(info
            .parts
            .iter()
            .any(|part| part.state != PartState::AsWritten))
    }

    /// What `cli`'s configuration holds of Facade's entries, with when Facade first wrote them.
    fn info(
        &self,
        cli: &str,
        env: &BTreeMap<String, String>,
        programs: &Programs,
    ) -> Result<IntegrationInfo, ErrorBody> {
        let mut parts = Vec::new();
        for target in integration::targets(cli, env).map_err(ErrorBody::invalid_argument)? {
            let holds = match files::read(&files::real_path(&target.file)) {
                Ok(Some(bytes)) => std::str::from_utf8(&bytes).map_or(Holds::Changed, |text| {
                    integration::held(target.kind, Some(text), programs)
                }),
                Ok(None) => Holds::Missing,
                Err(_) => Holds::Changed,
            };
            parts.push(IntegrationPart {
                file: target.file.to_string_lossy().into_owned(),
                state: part_state(holds),
            });
        }
        if let Some(server) = Server::of(cli, env) {
            parts.push(IntegrationPart {
                file: server.part(),
                state: server.state(programs)?,
            });
        }
        let added_at = self.kept(cli)?.into_iter().map(|kept| kept.added_at).min();
        Ok(IntegrationInfo {
            cli: cli.into(),
            added_at,
            parts,
            notes: Vec::new(),
        })
    }

    fn kept(&self, cli: &str) -> Result<Vec<IntegrationFile>, ErrorBody> {
        self.table
            .integration_files(cli)
            .map_err(ErrorBody::internal)
    }

    fn forget(&self, cli: &str, file: &str) -> Result<(), ErrorBody> {
        self.table
            .forget_integration_file(cli, file)
            .map_err(ErrorBody::internal)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.one_at_a_time
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn find<'a>(kept: &'a [IntegrationFile], file: &str) -> Option<&'a IntegrationFile> {
    kept.iter().find(|kept| kept.file == file)
}

fn part_state(holds: Holds) -> PartState {
    match holds {
        Holds::AsWritten => PartState::AsWritten,
        Holds::Changed => PartState::Changed,
        Holds::Missing => PartState::Missing,
    }
}

/// The programs and Facade home Facade's entries name: the launchers of `facade` and
/// `facade-mcp`, and this Facade home where it is not the caller's default.
struct Named {
    facade: String,
    mcp: String,
    home: Option<String>,
}

impl Named {
    fn of(held: &Held, env: &BTreeMap<String, String>) -> Result<Named, ErrorBody> {
        let home = facade_base::paths::facade_home().map_err(ErrorBody::internal)?;
        Ok(Named {
            facade: held.facade_launcher().to_string_lossy().into_owned(),
            mcp: held.facade_mcp().to_string_lossy().into_owned(),
            home: named_home(&home, env),
        })
    }

    fn programs(&self) -> Programs<'_> {
        Programs {
            facade: &self.facade,
            mcp: &self.mcp,
            home: self.home.as_deref(),
        }
    }
}

/// The Facade home the entries name: `home`, where it is not the default for the caller's HOME,
/// `~/.facade`.
fn named_home(home: &Path, env: &BTreeMap<String, String>) -> Option<String> {
    let default = env.get("HOME").map(|user| Path::new(user).join(".facade"));
    if default.as_deref() == Some(home) {
        None
    } else {
        Some(home.to_string_lossy().into_owned())
    }
}

async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ErrorBody> + Send + 'static,
) -> Result<T, ErrorBody> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(ErrorBody::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The entries name the Facade home only where it is not the default for the caller's HOME.
    #[test]
    fn the_entries_name_a_facade_home_that_is_not_the_default() {
        let env = BTreeMap::from([("HOME".to_string(), "/Users/ada".to_string())]);
        assert_eq!(named_home(Path::new("/Users/ada/.facade"), &env), None);
        assert_eq!(
            named_home(Path::new("/tmp/facade-try"), &env).as_deref(),
            Some("/tmp/facade-try")
        );
        assert_eq!(
            named_home(Path::new("/Users/ada/.facade"), &BTreeMap::new()).as_deref(),
            Some("/Users/ada/.facade")
        );
    }
}
