//! Keeps saved launchers usable after the move from Core to Framework.

use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, ensure};

use super::{Bin, LegacyStatus, LegacyUpgrade, PROGRAMS};
use crate::api_v1::daemon_client::core_active_agents;
use crate::paths::{connect_client_until, legacy_daemon_socket_for};
use crate::process::ProcessIdentity;
use crate::service::{self, Service};

const CORE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const CORE_LOCK_CHECK_INTERVAL: Duration = Duration::from_millis(20);

pub(super) fn repair(bin: &Bin) -> anyhow::Result<Option<LegacyUpgrade>> {
    let home = crate::paths::facade_home()?;
    let core = home.join("core");
    let previous = Bin(core.join("bin"));
    if !directory_exists(&core)? || !directory_exists(&previous.0)? {
        return Ok(None);
    }
    let report = |status| {
        Ok(Some(LegacyUpgrade {
            bin: previous.0.clone(),
            status,
        }))
    };

    let _core_locks = if let Some(locks) = reserve_core(&core)? {
        locks
    } else {
        let Some(daemon) = service::live_holder(&core, Service::Daemon)? else {
            return report(LegacyStatus::Deferred(
                "Could not check for active agents while the Core daemon is offline.".into(),
            ));
        };
        match active_agents(&home, &core, &daemon) {
            Ok(agents) if !agents.is_empty() => return report(LegacyStatus::Active(agents)),
            Ok(_) => {}
            Err(error) => {
                return report(LegacyStatus::Deferred(format!(
                    "Could not check for active Core agents: {error:#}."
                )));
            }
        }
        match retire_idle_core(&core, &daemon) {
            Ok(locks) => locks,
            Err(error) => return report(LegacyStatus::Deferred(error.to_string())),
        }
    };

    let _programs = bin.lock()?;
    let build = bin.current().context("no Framework build is selected")?;
    for name in PROGRAMS {
        let launcher = bin.0.join(name);
        ensure!(
            launcher.is_file(),
            "missing launcher {}",
            launcher.display()
        );
    }

    select_framework(&previous, bin, &build)
        .context("Fix the reported launcher error and rerun the installer")?;
    report(LegacyStatus::Migrated)
}

#[cfg(unix)]
type CoreLock = nix::fcntl::Flock<std::fs::File>;
#[cfg(windows)]
type CoreLock = std::fs::File;

fn reserve_core(core: &Path) -> anyhow::Result<Option<(CoreLock, CoreLock)>> {
    let Some(keeper) = service::try_lock_unowned(core, Service::Keeper)? else {
        return Ok(None);
    };
    Ok(service::try_lock_unowned(core, Service::Daemon)?.map(|daemon| (keeper, daemon)))
}

fn active_agents(
    home: &Path,
    core: &Path,
    daemon: &ProcessIdentity,
) -> anyhow::Result<Vec<String>> {
    let running_home = service::daemon_home(daemon).filter(|running| {
        running.is_absolute()
            && running.canonicalize().is_ok_and(|actual| {
                home.canonicalize()
                    .as_ref()
                    .is_ok_and(|expected| expected == &actual)
            })
    });
    let socket = legacy_daemon_socket_for(running_home.as_deref().unwrap_or(home));
    let until = Instant::now() + Duration::from_secs(2);
    let writer = connect_client_until(&socket, until).context("could not reach the Core daemon")?;
    let peer =
        service::authenticate_server(&writer, core, Service::Daemon).map_err(anyhow::Error::msg)?;
    ensure!(peer == *daemon, "Core's daemon changed while connecting");
    core_active_agents(writer, daemon.pid, until)
}

fn retire_idle_core(core: &Path, daemon: &ProcessIdentity) -> anyhow::Result<(CoreLock, CoreLock)> {
    ensure!(
        service::live_holder(core, Service::Daemon)?.as_ref() == Some(daemon),
        "Core's daemon changed while checking for active agents."
    );

    // An idle Core keeper exits when its daemon exits. If a run started between the roster
    // and shutdown, the keeper can still keep it and recover its daemon.
    stop_daemon(daemon).context("Could not stop the idle Core daemon")?;
    reserve_core_until(core, Instant::now() + CORE_SHUTDOWN_TIMEOUT)
}

fn reserve_core_until(core: &Path, until: Instant) -> anyhow::Result<(CoreLock, CoreLock)> {
    loop {
        // Process exit notification can precede the release of its file handles. Keep both
        // locks from the moment they are available through launcher publication.
        if let Some(locks) = reserve_core(core)? {
            return Ok(locks);
        }
        let remaining = until.saturating_duration_since(Instant::now());
        ensure!(
            !remaining.is_zero(),
            "Timed out waiting for the previous Core services to release their locks."
        );
        std::thread::park_timeout(remaining.min(CORE_LOCK_CHECK_INTERVAL));
    }
}

#[cfg(unix)]
fn stop_daemon(identity: &ProcessIdentity) -> io::Result<()> {
    use crate::unix_process::{Observed, ProcessObservation};
    if let Observed::Watching(process) = ProcessObservation::open(identity)? {
        process.signal(nix::sys::signal::Signal::SIGTERM)?;
    }
    Ok(())
}

#[cfg(windows)]
fn stop_daemon(identity: &ProcessIdentity) -> io::Result<()> {
    crate::unix_process::terminate(identity)
}

fn directory_exists(path: &Path) -> anyhow::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        found => found?,
    };
    #[cfg(unix)]
    super::check_owned_directory(path)?;
    #[cfg(windows)]
    super::windows::check_managed_directory(path)?;
    Ok(true)
}

/// Older installers read the build name from the launcher. Keep the same selection layout so
/// that starting a bundled Core cannot select an older build over a compatible Framework one.
fn select_framework(previous: &Bin, bin: &Bin, build: &str) -> anyhow::Result<()> {
    // An unstamped Framework build can have the same version as the original Core directory.
    let selection = if build.contains('+') {
        build.to_owned()
    } else {
        format!("{build}+framework")
    };
    let folder = previous.build(&selection)?;
    bin.validate_build(build)?;
    #[cfg(unix)]
    {
        let target = Path::new("../../framework/bin").join(build);
        point_at(&folder, &target)?;
        for name in PROGRAMS.into_iter().rev() {
            point_at(&previous.0.join(name), &Path::new(&selection).join(name))?;
        }
    }
    #[cfg(windows)]
    {
        previous.make_private(&folder)?;
        for name in PROGRAMS {
            super::place(&bin.0.join(name), &folder.join(name), false)?;
        }
        previous.link_launchers(&selection)?;
    }
    Ok(())
}

#[cfg(unix)]
fn point_at(path: &Path, target: &Path) -> anyhow::Result<()> {
    let update = || -> io::Result<()> {
        match std::fs::read_link(path) {
            Ok(link) if link == target => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        super::make_in_place(path, |fresh| super::symlink(target, fresh))
    };
    update().with_context(|| format!("could not update the previous launcher {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_folder::TestFolder;

    #[test]
    fn migration_waits_until_both_old_service_locks_are_available() {
        let core = TestFolder::new("core-launcher-locks");
        for service in [Service::Keeper, Service::Daemon] {
            let held = service::try_lock_unowned(&core, service).unwrap().unwrap();
            let deadline = Instant::now() + Duration::from_millis(40);
            let Err(error) = reserve_core_until(&core, deadline) else {
                panic!("reserved a lock still held after service shutdown");
            };
            assert!(Instant::now() >= deadline);
            assert!(error.to_string().contains("release their locks"));
            drop(held);
        }
        let locks = reserve_core_until(&core, Instant::now()).unwrap();
        assert!(reserve_core(&core).unwrap().is_none());
        drop(locks);
        assert!(reserve_core(&core).unwrap().is_some());
    }
}
