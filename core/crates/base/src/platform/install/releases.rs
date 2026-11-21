//! Stable Core metadata and HTTP evidence for older installers.

use std::path::PathBuf;

use anyhow::{Context, Result, bail, ensure};

use super::{RELEASES, WEBSITE};

const VERSION_FILE: &str = "facade-core-version.txt";
const CHECKSUMS: &str = "SHA256SUMS";

/// Selects a newer stable Core version, if either release origin confirms one.
pub fn latest_stable(current: [u64; 3]) -> Result<Option<String>> {
    let website = format!("{WEBSITE}/{VERSION_FILE}");
    let github = format!("{RELEASES}/latest/download/{VERSION_FILE}");
    let sources = [&website, &github];
    let responses = sources.map(|url| request(url, Request::Version));

    if responses.iter().all(|result| {
        result
            .as_ref()
            .is_ok_and(|response| response.http == Some(404))
    }) {
        let url = format!("{RELEASES}/latest");
        let response = request(&url, Request::LatestTag)?;
        if !response.exit.success() || response.http != Some(302) {
            bail!(
                "{url}: expected an HTTP 302 release redirect, {}",
                response.detail()
            );
        }
        let tag = response
            .text
            .strip_prefix(&format!("{RELEASES}/tag/"))
            .and_then(|tag| {
                tag.strip_prefix("extension/")
                    .or_else(|| tag.strip_prefix("extension%2F"))
                    .or_else(|| tag.strip_prefix("extension%2f"))
            });
        let Some((tag, numbers)) = tag.and_then(|tag| stable_version(tag).map(|n| (tag, n))) else {
            bail!("{url}: did not redirect to a stable extension release tag");
        };
        ensure!(
            numbers <= current,
            "{url}: release {tag} is newer than this build, but {VERSION_FILE} returned HTTP 404 from both origins"
        );
        return Ok(None);
    }

    let [website, github] = responses.map(|response| response.and_then(Response::version));
    let selected = match (website, github) {
        (Ok(one), Ok(two)) if two.0 > one.0 => two,
        (Ok(version), _) | (_, Ok(version)) => version,
        (Err(website), Err(github)) => bail!("facadecode.com: {website:#}. GitHub: {github:#}"),
    };
    Ok((selected.0 > current).then_some(selected.1))
}

pub(super) fn stable_version(version: &str) -> Option<[u64; 3]> {
    if !version.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    crate::version_of(version)
}

/// Which release asset failed and the HTTP status observed during acquisition.
pub struct UpgradeDownloadFailure {
    pub asset: String,
    pub http_status: Option<u16>,
}

/// Looks for corroborating HTTP failures after an older installer's generic package error.
pub fn legacy_package_failure(
    version: &str,
    installer_stderr: &str,
) -> Option<UpgradeDownloadFailure> {
    stable_version(version)?;
    let suffix = format!(" and its checksums for Facade {version} from GitHub or facadecode.com.");
    let archive = installer_stderr.lines().find_map(|line| {
        let line = line.strip_prefix("facade install: ").unwrap_or(line);
        let archive = line
            .strip_prefix("Could not download ")?
            .strip_suffix(&suffix)?;
        match archive {
            "facade-core-linux-x64.tar.gz"
            | "facade-core-linux-arm64.tar.gz"
            | "facade-core-darwin-x64.tar.gz"
            | "facade-core-darwin-arm64.tar.gz"
            | "facade-core-win32-x64.zip"
            | "facade-core-win32-arm64.zip" => Some(archive),
            _ => None,
        }
    })?;

    // Both origins must independently confirm a failure. Prefer the last attempted origin.
    missing_package_asset(
        &format!("{RELEASES}/download/extension%2F{version}"),
        archive,
    )?;
    missing_package_asset(&format!("{WEBSITE}/releases/{version}"), archive)
}

fn missing_package_asset(origin: &str, archive: &str) -> Option<UpgradeDownloadFailure> {
    for asset in [archive, CHECKSUMS] {
        let response = request(&format!("{origin}/{asset}"), Request::AssetStatus).ok()?;
        if matches!(response.http, Some(400..=599)) {
            return Some(UpgradeDownloadFailure {
                asset: asset.to_owned(),
                http_status: response.http,
            });
        }
        if !response.available() {
            return None;
        }
    }
    None
}

#[derive(Clone, Copy)]
enum Request {
    Version,
    LatestTag,
    AssetStatus,
}

struct Response {
    text: String,
    http: Option<u16>,
    exit: std::process::ExitStatus,
    stderr: String,
}

impl Response {
    fn available(&self) -> bool {
        self.exit.success() && matches!(self.http, Some(200..=299))
    }

    fn version(self) -> Result<([u64; 3], String)> {
        ensure!(self.available(), "{VERSION_FILE}: {}", self.detail());
        let version = self
            .text
            .strip_suffix("\r\n")
            .or_else(|| self.text.strip_suffix('\n'))
            .unwrap_or(&self.text);
        let numbers =
            stable_version(version).context("invalid stable version in facade-core-version.txt")?;
        Ok((numbers, version.to_owned()))
    }

    fn detail(&self) -> String {
        if let Some(http) = self.http.filter(|http| self.exit.success() || *http >= 400) {
            return format!("received HTTP {http}");
        }
        if let Some(detail) = self
            .stderr
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
        {
            return detail.to_owned();
        }
        format!("curl returned {}", self.exit)
    }
}

fn request(url: &str, request: Request) -> Result<Response> {
    let program = curl_program()?;
    let mut command = super::super::programs::command(&program);
    command.args([
        "-q",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "-fsS",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
    ]);
    if !matches!(request, Request::LatestTag) {
        command.arg("--location");
    }
    if !matches!(request, Request::Version) {
        let discard = if cfg!(windows) { "NUL" } else { "/dev/null" };
        command.args(["--head", "--output", discard]);
    }
    let write_out = if matches!(request, Request::LatestTag) {
        "%{redirect_url}\n%{http_code}"
    } else {
        "\n%{http_code}"
    };
    let output = command
        .args(["--write-out", write_out, url])
        .output()
        .with_context(|| format!("could not run {} for {url}", program.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (body, status) = stdout
        .trim_end_matches(['\r', '\n'])
        .rsplit_once('\n')
        .unwrap_or(("", stdout.trim()));
    let http = match status.as_bytes() {
        [b'1'..=b'5', b'0'..=b'9', b'0'..=b'9'] => status.parse().ok(),
        _ => None,
    };
    Ok(Response {
        text: body.to_owned(),
        http,
        exit: output.status,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

pub(super) fn test_curl_program() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    return std::env::var_os("FACADE_TEST_RELEASE_CURL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    #[cfg(not(debug_assertions))]
    None
}

fn curl_program() -> Result<PathBuf> {
    if let Some(program) = test_curl_program() {
        return Ok(program);
    }
    #[cfg(unix)]
    return Ok(PathBuf::from("curl"));
    #[cfg(windows)]
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .context("could not locate system curl: SystemRoot must be an absolute path")
        .map(|root| root.join(r"System32\curl.exe"))
}
