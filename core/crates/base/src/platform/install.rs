//! Looks up stable releases and runs the published Facade installer.

use std::path::{Path, PathBuf};
use std::process::Command;

mod releases;

pub use releases::{UpgradeDownloadFailure, latest_stable, legacy_package_failure};

const RELEASES: &str = "https://github.com/y5ez3g/facadecode/releases";
const WEBSITE: &str = "https://facadecode.com";

/// The default standalone installer's bin, if its Facade launcher names this executable.
pub fn installed_bin(program: &Path) -> Option<PathBuf> {
    use super::files::real_path;

    #[cfg(unix)]
    let (root, versions, name) = (
        PathBuf::from(std::env::var_os("HOME")?).join(".local"),
        "share/facade/versions",
        "facade",
    );
    #[cfg(windows)]
    let (root, versions, name) = (
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Facade"),
        "versions",
        "facade.exe",
    );
    if !root.is_absolute() {
        return None;
    }
    let bin = root.join("bin");
    let target = real_path(&bin.join(name)).ok()?;
    let version_dir = target.parent()?;
    releases::stable_version(version_dir.file_name()?.to_str()?)?;
    if target.file_name()? != name
        || version_dir.parent()? != real_path(&root.join(versions)).ok()?
        || !target.is_file()
        || real_path(program).ok()? != target
    {
        return None;
    }
    Some(bin)
}

/// Runs the published installer with the calling Facade command's environment.
/// A pin must have three nonempty ASCII decimal components.
pub fn upgrade_command(version: Option<&str>) -> Command {
    #[cfg(unix)]
    {
        let mut command = Command::new("sh");
        let curl = if let Some(path) = releases::test_curl_program() {
            command.env("FACADE_TEST_RELEASE_CURL", path);
            r#"curl() { command "$FACADE_TEST_RELEASE_CURL" "$@"; }"#
        } else {
            ""
        };
        command
            .args([
                "-c",
                &format!("{curl}{UNIX_DOWNLOAD}{UNIX_UPGRADE}"),
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
        let curl = if let Some(path) = releases::test_curl_program() {
            command.env("FACADE_TEST_RELEASE_CURL", path);
            "$env:FACADE_TEST_RELEASE_CURL"
        } else {
            POWERSHELL_SYSTEM_CURL
        };
        let installer = powershell_install_using(
            version,
            // Encode the captured receipt without changing the calling console's code page.
            "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
            WINDOWS_DOWNLOAD_ERROR,
            "",
            curl,
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
    observed_http=-
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
        case "$http" in [1-5][0-9][0-9]) observed_http=$http ;; esac
    done
    return "$status"
}
"#;

#[cfg(unix)]
const UNIX_UPGRADE: &str = r#"
fetch_installer "$1" "$2"
status=$?
if [ "$status" -ne 0 ]; then
    if [ "${FACADE_UPGRADE_REPORT:-}" = 1 ] && [ "${FACADE_UPGRADE_ASSET_REPORT:-}" = 1 ]; then
        printf 'facade-upgrade-asset-error install.sh %s\n' "$observed_http"
    else
        case "$http" in [1-5][0-9][0-9]) ;; *) http=- ;; esac
        printf 'facade-upgrade-download-error %s\n' "$http"
    fi
    exit "$status"
fi
shift 2
sh -c "$script" -- "$@"
"#;

#[cfg(windows)]
const WINDOWS_DOWNLOAD_ERROR: &str = r#"
    if ($env:FACADE_UPGRADE_REPORT -eq '1' -and $env:FACADE_UPGRADE_ASSET_REPORT -eq '1') {
        [Console]::WriteLine("facade-upgrade-asset-error install.ps1 $observedHttp")
    } else {
        if ($http -notmatch '\A[1-5][0-9][0-9]\z') { $http = '-' }
        [Console]::WriteLine("facade-upgrade-download-error $http")
    }
    exit 1
"#;

pub(super) const POWERSHELL_OPTIONS: [&str; 3] = ["-NoLogo", "-NoProfile", "-NonInteractive"];
const POWERSHELL_SYSTEM_CURL: &str = r"Join-Path $env:SystemRoot 'System32\curl.exe'";

pub(super) fn powershell_install(
    version: Option<&str>,
    prefix: &str,
    download_error: &str,
    output: &str,
) -> String {
    powershell_install_using(
        version,
        prefix,
        download_error,
        output,
        POWERSHELL_SYSTEM_CURL,
    )
}

fn powershell_install_using(
    version: Option<&str>,
    prefix: &str,
    download_error: &str,
    output: &str,
    curl: &str,
) -> String {
    let [github, website] = script_urls(version, "ps1");
    let arguments = version.map_or_else(String::new, |version| format!(" -Version '{version}'"));
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
{prefix}
$curl = {curl}
$download = [IO.Path]::GetTempFileName()
$script = $null
$observedHttp = '-'
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
        if ($http -match '\A[1-5][0-9]{{2}}\z') {{ $observedHttp = $http }}
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
