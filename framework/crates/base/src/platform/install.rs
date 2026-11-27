//! Looks up stable releases and runs the published Facade Code Framework installer.

use std::path::Path;
use std::process::Command;

mod releases;

pub use releases::{UpgradeDownloadFailure, latest_stable, legacy_package_failure, release_build};

const RELEASES: &str = "https://github.com/y5ez3g/facadecode/releases";
const WEBSITE: &str = "https://facadecode.com";

#[derive(Clone, Copy, Default)]
pub(super) struct InstallerOptions<'a> {
    pub(super) version: Option<&'a str>,
    pub(super) expected_build: Option<&'a str>,
    pub(super) use_facade_home: bool,
    pub(super) no_path: bool,
}

/// Runs the published installer for this home, with the numeric version for release routing and
/// the exact build for package verification.
pub fn upgrade_command(
    version: &str,
    expected_build: &str,
    home: &Path,
) -> anyhow::Result<Command> {
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
            .env("FACADE_HOME", home)
            .args([
                "-c",
                &format!("{curl}{UNIX_DOWNLOAD}{UNIX_UPGRADE}"),
                "facade-install",
            ])
            .args(script_urls(Some(version), "sh"))
            .args(["--version", version, "--no-path", "--install-root"])
            .arg(home)
            .args(["--expected-build", expected_build]);
        Ok(command)
    }
    #[cfg(windows)]
    {
        let temp = std::env::temp_dir();
        let resolved_temp = temp.canonicalize().unwrap_or_else(|_| temp.clone());
        let resolved_home = home.canonicalize().unwrap_or_else(|_| home.to_owned());
        let home_key = super::files::folder_key(&resolved_home);
        anyhow::ensure!(
            !resolved_temp
                .ancestors()
                .any(|ancestor| super::files::folder_key(ancestor) == home_key),
            "Installer temporary directory {} is inside the selected Facade home {}. Set TMP and TEMP to a directory outside it and retry.",
            temp.display(),
            home.display()
        );
        let mut command = super::programs::command("powershell.exe");
        let curl = if let Some(path) = releases::test_curl_program() {
            command.env("FACADE_TEST_RELEASE_CURL", path);
            "$env:FACADE_TEST_RELEASE_CURL"
        } else {
            POWERSHELL_SYSTEM_CURL
        };
        let installer = powershell_install_using(
            InstallerOptions {
                version: Some(version),
                expected_build: Some(expected_build),
                use_facade_home: true,
                no_path: true,
            },
            // Encode the captured receipt without changing the calling console's code page.
            "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
            WINDOWS_DOWNLOAD_ERROR,
            "",
            curl,
            WINDOWS_UPGRADE_PIN_CHECK,
        );
        command
            .env("FACADE_HOME", home)
            .env("TMP", &temp)
            .env("TEMP", &temp)
            .args(POWERSHELL_OPTIONS)
            .args(["-Command", &installer]);
        Ok(command)
    }
}

pub(super) fn script_urls(version: Option<&str>, extension: &str) -> [String; 2] {
    match version {
        Some(version) => tagged_asset_urls(version, &format!("install.{extension}")),
        None => [
            format!("{RELEASES}/latest/download/install.{extension}"),
            format!("{WEBSITE}/install.{extension}"),
        ],
    }
}

fn tagged_asset_urls(version: &str, asset: &str) -> [String; 2] {
    [
        format!("{RELEASES}/download/extension%2F{version}/{asset}"),
        format!("{WEBSITE}/releases/{version}/{asset}"),
    ]
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
case "$script" in
    *--expected-build*) ;;
    *) printf 'facade-upgrade-installer-refused\n'; exit 1 ;;
esac
sh -c "$script" -- "$@"
"#;

#[cfg(windows)]
const WINDOWS_UPGRADE_PIN_CHECK: &str = r#"
if ('ExpectedBuild' -notin @($installer.Ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })) {
    [Console]::WriteLine('facade-upgrade-installer-refused')
    exit 1
}
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

pub(super) fn powershell_install_with_options(
    options: InstallerOptions<'_>,
    prefix: &str,
    download_error: &str,
    output: &str,
) -> String {
    powershell_install_using(
        options,
        prefix,
        download_error,
        output,
        POWERSHELL_SYSTEM_CURL,
        "",
    )
}

fn powershell_install_using(
    options: InstallerOptions<'_>,
    prefix: &str,
    download_error: &str,
    output: &str,
    curl: &str,
    pin_check: &str,
) -> String {
    let [github, website] = script_urls(options.version, "ps1");
    let mut arguments = String::new();
    for (option, value) in [
        ("-Version", options.version),
        ("-ExpectedBuild", options.expected_build),
    ] {
        if let Some(value) = value {
            use std::fmt::Write as _;
            let _ = write!(arguments, " {option} '{}'", value.replace('\'', "''"));
        }
    }
    if options.use_facade_home {
        arguments.push_str(" -InstallRoot $env:FACADE_HOME");
    }
    if options.no_path {
        arguments.push_str(" -NoPath");
    }
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
{prefix}
$curl = {curl}
$script = $null
$observedHttp = '-'
$encoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {{
    foreach ($url in '{github}', '{website}') {{
        $http = '-'
        try {{
            $response = (& $curl -q --proto '=https' --proto-redir '=https' -fsL `
                --connect-timeout 10 --max-time 30 --write-out '%{{http_code}}' $url) -join "`n"
        }} catch {{
            continue
        }}
        if ($response.Length -ge 3) {{ $http = $response.Substring($response.Length - 3) }}
        if ($LASTEXITCODE -eq 0 -and $http -match '\A2[0-9]{{2}}\z') {{
            $script = $response.Substring(0, $response.Length - 3)
            break
        }}
        if ($http -match '\A[1-5][0-9]{{2}}\z') {{ $observedHttp = $http }}
    }}
}} finally {{
    [Console]::OutputEncoding = $encoding
}}
if ($null -eq $script) {{ {download_error} }}
$installer = [ScriptBlock]::Create($script)
{pin_check}
& $installer{arguments}{output}
if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}
"#
    )
}
