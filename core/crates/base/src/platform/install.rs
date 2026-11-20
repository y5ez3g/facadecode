//! Commands that run the published Facade installer.

use std::process::Command;

const RELEASES: &str = "https://github.com/y5ez3g/facadecode/releases";
const WEBSITE: &str = "https://facadecode.com";

/// Runs the published installer with the calling Facade command's environment.
/// A pin must have three nonempty ASCII decimal components.
pub fn upgrade_command(version: Option<&str>) -> Command {
    #[cfg(unix)]
    {
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                &format!("{UNIX_DOWNLOAD}{UNIX_UPGRADE}"),
                "facade-install",
            ])
            .args(script_urls(version, "sh"));
        if let Some(version) = version {
            command.args(["--version", version]);
        }
        command
    }
    #[cfg(windows)]
    {
        let mut command = super::programs::command("powershell.exe");
        let installer = powershell_install(
            version,
            // Encode the captured receipt without changing the calling console's code page.
            "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
            WINDOWS_DOWNLOAD_ERROR,
            "",
        );
        command
            .args(POWERSHELL_OPTIONS)
            .args(["-Command", &installer]);
        command
    }
}

pub(super) fn script_urls(version: Option<&str>, extension: &str) -> [String; 2] {
    match version {
        Some(version) => [
            format!("{RELEASES}/download/extension%2F{version}/install.{extension}"),
            format!("{WEBSITE}/releases/{version}/install.{extension}"),
        ],
        None => [
            format!("{RELEASES}/latest/download/install.{extension}"),
            format!("{WEBSITE}/install.{extension}"),
        ],
    }
}

pub(super) const UNIX_DOWNLOAD: &str = r#"
fetch_installer() {
    for url in "$@"; do
        response=$(curl -q --proto '=https' --proto-redir '=https' -fsL \
            --connect-timeout 10 --max-time 30 -w '%{http_code}' "$url")
        status=$?
        script=${response%???}
        http=${response#"$script"}
        if [ "$status" -eq 0 ]; then
            case "$http" in 2[0-9][0-9]) return 0 ;; esac
            status=22
        fi
    done
    return "$status"
}
"#;

#[cfg(unix)]
const UNIX_UPGRADE: &str = r#"
fetch_installer "$1" "$2"
status=$?
if [ "$status" -ne 0 ]; then
    case "$http" in [1-5][0-9][0-9]) ;; *) http=- ;; esac
    printf 'facade-upgrade-download-error %s\n' "$http"
    exit "$status"
fi
shift 2
sh -c "$script" -- "$@"
"#;

#[cfg(windows)]
const WINDOWS_DOWNLOAD_ERROR: &str = r#"
    if ($http -notmatch '\A[1-5][0-9][0-9]\z') { $http = '-' }
    [Console]::WriteLine("facade-upgrade-download-error $http")
    exit 1
"#;

pub(super) const POWERSHELL_OPTIONS: [&str; 3] = ["-NoLogo", "-NoProfile", "-NonInteractive"];

pub(super) fn powershell_install(
    version: Option<&str>,
    prefix: &str,
    download_error: &str,
    output: &str,
) -> String {
    let [github, website] = script_urls(version, "ps1");
    let arguments = version.map_or_else(String::new, |version| format!(" -Version '{version}'"));
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
{prefix}
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$download = [IO.Path]::GetTempFileName()
$script = $null
try {{
    foreach ($url in '{github}', '{website}') {{
        $http = '-'
        try {{
            $http = & $curl -q --proto '=https' --proto-redir '=https' -fsL `
                --connect-timeout 10 --max-time 30 --output $download --write-out '%{{http_code}}' $url
        }} catch {{
            continue
        }}
        if ($LASTEXITCODE -eq 0 -and $http -match '\A2[0-9]{{2}}\z') {{
            $script = [IO.File]::ReadAllText($download, [Text.Encoding]::UTF8)
            break
        }}
    }}
}} finally {{
    [IO.File]::Delete($download)
}}
if ($null -eq $script) {{ {download_error} }}
& ([ScriptBlock]::Create($script)){arguments}{output}
if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}
"#
    )
}
