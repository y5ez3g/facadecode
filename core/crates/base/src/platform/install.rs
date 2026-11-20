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
        // Encode the captured receipt without changing the calling console's code page.
        let mut command = super::programs::command("powershell.exe");
        let download = format!(
            "try {{ {} }} {WINDOWS_DOWNLOAD_ERROR}",
            powershell_download(&latest("ps1"))
        );
        let installer = run_powershell_installer(
            "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ",
            &download,
            "",
        );
        command
            .args(POWERSHELL_OPTIONS)
            .args(["-Command", &installer]);
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
const UNIX_INSTALL: &str = r#"
response=$(curl -fsSL -w '%{http_code}' "$1")
status=$?
script=${response%???}
if [ "$status" -ne 0 ]; then
    http=${response#"$script"}
    case "$http" in [1-5][0-9][0-9]) ;; *) http=- ;; esac
    printf 'facade-upgrade-download-error %s\n' "$http"
    exit "$status"
fi
sh -c "$script" --
"#;

#[cfg(windows)]
const WINDOWS_DOWNLOAD_ERROR: &str = r#"catch {
    $http = $_.Exception.Response.StatusCode
    if ($null -eq $http) { $http = '-' } else { $http = [int]$http }
    [Console]::WriteLine("facade-upgrade-download-error $http")
    throw
}"#;

pub(super) const POWERSHELL_OPTIONS: [&str; 3] = ["-NoLogo", "-NoProfile", "-NonInteractive"];

pub(super) fn powershell_install(url: &str, prefix: &str, arguments: &str) -> String {
    run_powershell_installer(prefix, &powershell_download(url), arguments)
}

fn powershell_download(url: &str) -> String {
    format!("$response = Invoke-WebRequest -UseBasicParsing '{url}'")
}

fn run_powershell_installer(prefix: &str, download: &str, arguments: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; \
         {prefix}{download}; \
         & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString(\
         $response.RawContentStream.ToArray()))){arguments}"
    )
}
