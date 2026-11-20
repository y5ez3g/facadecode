//! Runs the standalone installer and presents its result.

use std::io::{self, Write as _};
use std::process::Stdio;

use anyhow::{Context, bail};
use facade_base::v3::AgentLabel;

use crate::single_line;

pub(crate) fn run() -> anyhow::Result<()> {
    let output = facade_base::install::upgrade_command()
        .env("FACADE_UPGRADE_REPORT", "1")
        .stdin(Stdio::inherit())
        .output()
        .context("Could not upgrade Facade. Could not start installer")?;
    let _ = io::stderr().write_all(&output.stderr);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut installed = None;
    let mut download_error = None;
    let mut blockers = Vec::new();
    for line in stdout.lines() {
        if let Some(status) = line.strip_prefix("facade-upgrade-download-error ") {
            download_error = Some(status);
        } else if let Some(payload) = line.strip_prefix("facade-upgrade-blockers ") {
            if let Ok(agents) = serde_json::from_str::<Vec<AgentLabel>>(payload) {
                blockers = agents;
            }
        } else if is_install_receipt(line) {
            installed = Some(line);
        } else {
            eprintln!("{line}");
        }
    }

    if output.status.success() {
        let receipt =
            installed.context("Could not upgrade Facade. Installer reported no result.")?;
        println_or_end!("{receipt}");
        return Ok(());
    }
    if let Some(status) = download_error {
        if matches!(status.as_bytes(), [b'1'..=b'5', b'0'..=b'9', b'0'..=b'9']) {
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
    result
        .is_some_and(|(version, bin)| facade_base::version_of(version).is_some() && !bin.is_empty())
}
