//! Commands that run the published Facade installer.

use std::process::Command;

const RELEASES: &str = "https://github.com/y5ez3g/facadecode/releases";

/// Runs the stable installer with the environment of the calling Facade command.
pub fn upgrade_command() -> Command {
    #[cfg(unix)]
    {
        let mut command = Command::new("sh");
        command.args(["-c", UNIX_INSTALL, "facade-install", &latest("sh")]);
        command
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("powershell.exe");
        command
            .args(POWERSHELL_OPTIONS)
            .args(["-Command", &powershell_install(&latest("ps1"), "", "")]);
        command
    }
}

fn latest(extension: &str) -> String {
    format!("{RELEASES}/latest/download/install.{extension}")
}

pub(super) fn pinned(version: &str, extension: &str) -> String {
    format!("{RELEASES}/download/extension%2F{version}/install.{extension}")
}

#[cfg(unix)]
const UNIX_INSTALL: &str = r#"script=$(curl -fsSL "$1") && sh -c "$script" --"#;

pub(super) const POWERSHELL_OPTIONS: [&str; 3] = ["-NoLogo", "-NoProfile", "-NonInteractive"];

pub(super) fn powershell_install(url: &str, prefix: &str, arguments: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; \
         {prefix}$response = Invoke-WebRequest -UseBasicParsing '{url}'; \
         & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString(\
         $response.RawContentStream.ToArray()))){arguments}"
    )
}
