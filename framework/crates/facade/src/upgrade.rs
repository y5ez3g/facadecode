//! Selects a release, runs its standalone installer and presents the result.

use std::cmp::Ordering;
use std::io::{self, IsTerminal as _, Write as _};
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
        return install_version(&build, &home, selected.as_deref());
    }

    let current = selected.clone().unwrap_or_else(facade_base::build_id);
    if let Some(build) = install::latest_stable(&current)
        .context("Could not check for updates from GitHub or facadecode.com")?
    {
        return install_version(&build, &home, selected.as_deref());
    }

    up_to_date(&current, &launcher)
}

fn up_to_date(current: &str, launcher: &Path) -> anyhow::Result<()> {
    if io::stdout().is_terminal() {
        present(
            launcher,
            &format!(
                "Facade {} is already installed{}",
                facade_base::build_version(current),
                build_note(current)
            ),
        );
        return Ok(());
    }
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

fn install_version(build: &str, home: &Path, previous: Option<&str>) -> anyhow::Result<()> {
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
        match receipt_parts(receipt) {
            Some((installed, selected, bin)) if io::stdout().is_terminal() => {
                let launcher = Path::new(bin).join(if cfg!(windows) {
                    "facade.exe"
                } else {
                    "facade"
                });
                let headline = if installed {
                    updated(previous, selected)
                } else {
                    format!(
                        "Facade {} is already installed{}",
                        facade_base::build_version(selected),
                        build_note(selected)
                    )
                };
                present(&launcher, &headline);
            }
            _ => println_or_end!("{receipt}"),
        }
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
    receipt_parts(line).is_some()
}

/// The installer's receipt: whether it installed, the BUILD the home selects and its program folder.
fn receipt_parts(line: &str) -> Option<(bool, &str, &str)> {
    let line = line.strip_suffix('.')?;
    let (installed, (build, bin)) = match line.strip_prefix("Installed Facade ") {
        Some(rest) => (true, rest.split_once(" in ")?),
        None => (
            false,
            line.strip_prefix("Facade ")?
                .split_once(" is already up to date in ")?,
        ),
    };
    (facade_base::compare_builds(build, build).is_some() && !bin.is_empty())
        .then_some((installed, build, bin))
}

/// The check mark and arrow the installer draws: plain ones in an older Windows console window.
fn marks() -> (&'static str, &'static str) {
    if cfg!(windows) && std::env::var_os("WT_SESSION").is_none() {
        ("OK", "->")
    } else {
        ("\u{2714}", "\u{2192}")
    }
}

/// What the installer tells a person: a check mark and its headline, then where the Shell is.
fn present(launcher: &Path, headline: &str) {
    println_or_end!("\n{} {headline}", marks().0);
    if launcher.is_file() {
        println_or_end!("  Location: {}", facade_base::settings::shown(launcher));
    }
}

/// `Facade updated 0.1.5 → 0.1.6 (build e13e14f)`, or for the same version, its two builds.
fn updated(previous: Option<&str>, selected: &str) -> String {
    let version = facade_base::build_version(selected);
    let arrow = marks().1;
    match previous.map(|previous| (previous, facade_base::build_version(previous))) {
        None => format!("Facade {version} installed{}", build_note(selected)),
        Some((_, before)) if before != version => {
            format!(
                "Facade updated {before} {arrow} {version}{}",
                build_note(selected)
            )
        }
        Some((previous, _)) => format!(
            "Facade {version} updated (build {} {arrow} {})",
            short_build(previous),
            short_build(selected)
        ),
    }
}

/// `e13e14f` for the BUILD 0.1.6+1795665988.e13e14faa…, or nothing for a bare version.
fn short_build(build: &str) -> &str {
    let Some((_, tail)) = build.split_once('+') else {
        return "";
    };
    let id = tail.rsplit('.').next().unwrap_or(tail);
    id.get(..7).unwrap_or(id)
}

/// ` (build e13e14f)`, or nothing for a bare version.
fn build_note(build: &str) -> String {
    match short_build(build) {
        "" => String::new(),
        id => format!(" (build {id})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "0.1.6+1795665988.e13e14faa8be46ae69e192c8c0a175959185aeab";

    #[test]
    fn a_person_reads_which_version_and_build_the_upgrade_selected() {
        let arrow = marks().1;
        assert_eq!(updated(None, NEW), "Facade 0.1.6 installed (build e13e14f)");
        assert_eq!(
            updated(Some("0.1.5+1795000000.aaaaaaa1111"), NEW),
            format!("Facade updated 0.1.5 {arrow} 0.1.6 (build e13e14f)")
        );
        assert_eq!(
            updated(
                Some("0.1.6+1795524945.af9bb4b8c35ab61974e71bd9a2b515a4dc5c25bd"),
                NEW
            ),
            format!("Facade 0.1.6 updated (build af9bb4b {arrow} e13e14f)")
        );
        assert_eq!(build_note("0.1.6"), "");
        let receipt = format!("Installed Facade {NEW} in /home/a/.facade/framework/bin.");
        assert_eq!(
            receipt_parts(&receipt),
            Some((true, NEW, "/home/a/.facade/framework/bin"))
        );
    }
}
