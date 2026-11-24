//! Selects a release, runs its standalone installer and presents the result.

use std::cmp::Ordering;
use std::io::{self, Write as _};
use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, anyhow, bail, ensure};
use facade_base::api_v1::daemon::AgentLabel;
use facade_base::{install, paths, programs};

use crate::single_line;

pub(crate) fn run(version: Option<&str>) -> anyhow::Result<()> {
    let home = paths::facade_home()?;
    let launcher = programs::launcher("facade")?;
    let selected = programs::current_build().filter(|_| launcher.is_file());
    if let Some(version) = version {
        let build = install::release_build(version).with_context(|| {
            format!(
                "Could not verify the BUILD for release {version}. {}",
                matching_package()
            )
        })?;
        if let Some(current) = selected.as_deref() {
            let rank = facade_base::compare_builds(&build, current).with_context(|| {
                format!(
                    "Cannot compare the selected build {current} at {}",
                    launcher.display()
                )
            })?;
            if rank != Ordering::Greater {
                return up_to_date(current, &launcher);
            }
        }
        return install_version(&build, &home);
    }

    let current = selected.unwrap_or_else(facade_base::build_id);
    if let Some(build) = install::latest_stable(&current)
        .context("Could not check for updates from GitHub or facadecode.com")?
    {
        return install_version(&build, &home);
    }

    up_to_date(&current, &launcher)
}

fn up_to_date(current: &str, launcher: &Path) -> anyhow::Result<()> {
    if let Some(bin) = launcher.parent().filter(|_| launcher.is_file()) {
        println_or_end!(
            "Facade {current} is already up to date in {}.",
            bin.display()
        );
    } else {
        println_or_end!("Facade {current} is already up to date.");
    }
    Ok(())
}

fn matching_package() -> &'static str {
    if cfg!(windows) {
        "Use a current installer with -Package and the matching release archive."
    } else {
        "Use a current installer with --package and the matching release archive."
    }
}

fn install_version(build: &str, home: &Path) -> anyhow::Result<()> {
    let version = facade_base::build_version(build);
    ensure!(
        facade_base::takes_over(build, version),
        "Could not verify a dated BUILD for release {version}. {}",
        matching_package()
    );
    let output = install::upgrade_command(version, build, home)?
        .env("FACADE_UPGRADE_REPORT", "1")
        .env("FACADE_UPGRADE_ASSET_REPORT", "1")
        .stdin(Stdio::inherit())
        .output()
        .context("Could not upgrade Facade. Could not start installer")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut installed = None;
    let mut asset_error = None;
    let mut download_error = None;
    let mut refused = false;
    let mut blockers = Vec::new();
    let mut diagnostics = Vec::new();
    for line in stdout.lines() {
        if let Some(payload) = line.strip_prefix("facade-upgrade-asset-error ") {
            asset_error = payload
                .split_once(' ')
                .map(|(asset, status)| (asset, http_status(status)));
        } else if let Some(status) = line.strip_prefix("facade-upgrade-download-error ") {
            download_error = Some(status);
        } else if line == "facade-upgrade-installer-refused" {
            refused = true;
        } else if let Some(payload) = line.strip_prefix("facade-upgrade-blockers ") {
            if let Ok(agents) = serde_json::from_str::<Vec<AgentLabel>>(payload) {
                blockers = agents;
            }
        } else if is_install_receipt(line) {
            installed = Some(line);
        } else {
            diagnostics.push(line);
        }
    }

    if !output.status.success() {
        if refused {
            bail!(
                "Could not upgrade Facade to {build}. The installer cannot verify the exact BUILD. {}",
                matching_package()
            );
        }
        if let Some((asset, Some(status))) = asset_error {
            return Err(asset_http_error(version, asset, status));
        }
        if asset_error.is_none()
            && download_error.is_none()
            && blockers.is_empty()
            && let Some(failure) =
                install::legacy_package_failure(version, &String::from_utf8_lossy(&output.stderr))
            && let Some(status) = failure.http_status
        {
            return Err(asset_http_error(version, &failure.asset, status));
        }
    }

    let _ = io::stderr().write_all(&output.stderr);
    for line in diagnostics {
        eprintln!("{line}");
    }
    if output.status.success() {
        let receipt =
            installed.context("Could not upgrade Facade. Installer reported no result.")?;
        println_or_end!("{receipt}");
        return Ok(());
    }
    if let Some((asset, None)) = asset_error {
        bail!("Could not upgrade Facade to {version}: Could not download {asset}.");
    }
    if let Some(status) = download_error {
        if http_status(status).is_some() {
            bail!("Could not upgrade Facade. Could not download installer (HTTP {status}).");
        }
        bail!("Could not upgrade Facade. Could not download installer.");
    }
    if !blockers.is_empty() {
        let agents = blockers
            .iter()
            .map(|agent| {
                format!(
                    "{} ({})",
                    single_line(&agent.name),
                    single_line(&agent.address)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        bail!("Could not upgrade Facade. Stop incompatible running agents first: {agents}.");
    }
    bail!(
        "Could not upgrade Facade. Installer failed ({}).",
        output.status
    );
}

fn http_status(status: &str) -> Option<u16> {
    if matches!(status.as_bytes(), [b'1'..=b'5', b'0'..=b'9', b'0'..=b'9']) {
        status.parse().ok()
    } else {
        None
    }
}

fn asset_http_error(version: &str, asset: &str, status: u16) -> anyhow::Error {
    anyhow!("Could not upgrade Facade to {version}: {asset} returned HTTP {status}.")
}

fn is_install_receipt(line: &str) -> bool {
    let Some(line) = line.strip_suffix('.') else {
        return false;
    };
    let result = line
        .strip_prefix("Installed Facade ")
        .and_then(|line| line.split_once(" in "))
        .or_else(|| {
            line.strip_prefix("Facade ")?
                .split_once(" is already up to date in ")
        });
    result.is_some_and(|(build, bin)| {
        facade_base::compare_builds(build, build).is_some() && !bin.is_empty()
    })
}
