//! Shared arguments for a foreground or saved machine connection.

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command};

use base64::{Engine as _, engine::general_purpose::STANDARD};

use super::install;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshMode {
    /// Authorize a saved connection in the person's terminal.
    Add,
    /// Run a saved connection with no interaction.
    Saved,
    /// Keep this connection only while the person's foreground command runs.
    Connect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshArgumentError {
    Destination,
    Option,
    RemoteCommand,
    Home,
    Version,
    Probe,
}

impl fmt::Display for SshArgumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Destination => "supply one SSH destination, such as a host or user@host",
            Self::Option => {
                "give SSH login options with their values and keep the session open with standard input and no TTY"
            }
            Self::RemoteCommand => "supply SSH login arguments without a remote command",
            Self::Home => "the remote home must be a nonempty UTF-8 path",
            Self::Version => "supply a stable release version for the remote installer",
            Self::Probe => "expected a missing or version response from the remote Facade probe",
        })
    }
}

impl std::error::Error for SshArgumentError {}

/// Native Windows OpenSSH does not support ControlMaster.
pub const fn ssh_supports_control_master() -> bool {
    cfg!(not(windows))
}

/// Creates the current user's private, short control directory for this Facade home.
/// Returns no directory on systems without support for OpenSSH connection reuse.
pub fn ssh_control_dir(home: &Path) -> anyhow::Result<Option<PathBuf>> {
    #[cfg(unix)]
    {
        use std::fs::{DirBuilder, symlink_metadata};
        use std::io::ErrorKind;
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};

        let directory = super::socket_paths::socket_dir()?
            .join(format!("ssh-{}", crate::paths::home_key(home)));
        if let Err(error) = DirBuilder::new().mode(0o700).create(&directory)
            && error.kind() != ErrorKind::AlreadyExists
        {
            return Err(error.into());
        }
        let metadata = symlink_metadata(&directory)?;
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        anyhow::ensure!(
            metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
            "the SSH control directory {} must be private to this user",
            directory.display()
        );
        Ok(Some(directory))
    }
    #[cfg(windows)]
    {
        let _ = home;
        Ok(None)
    }
}

/// Arguments for OpenSSH. The remote home is encoded so every remote shell sees it as one word.
pub fn machine_ssh_args(
    ssh_destination: &str,
    remote_home: Option<&str>,
    mode: SshMode,
    control_dir: Option<&Path>,
) -> Result<Vec<OsString>, SshArgumentError> {
    if !valid_destination(ssh_destination) {
        return Err(SshArgumentError::Destination);
    }
    let mut args = connection_args(mode, control_dir);
    args.extend(["--", ssh_destination, "facade", "machine", "serve"].map(OsString::from));
    if let Some(home) = remote_home {
        args.extend([
            OsString::from("--home-hex"),
            OsString::from(home_hex(home)?),
        ]);
    }
    Ok(args)
}

fn valid_destination(destination: &str) -> bool {
    !destination.is_empty()
        && !destination.starts_with('-')
        && !destination
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
}

fn connection_args(mode: SshMode, control_dir: Option<&Path>) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-T",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    if mode == SshMode::Saved {
        args.extend(["-o", "BatchMode=yes"].map(OsString::from));
    }
    if ssh_supports_control_master() {
        if mode == SshMode::Connect {
            args.extend(["-o", "ControlMaster=no", "-o", "ControlPath=none"].map(OsString::from));
        } else if let Some(control_dir) = control_dir {
            let mut path = OsString::from("ControlPath=");
            path.push(control_dir.join("%C"));
            args.extend([
                OsString::from("-o"),
                OsString::from("ControlMaster=auto"),
                OsString::from("-o"),
                path,
            ]);
            args.extend(["-o", "ControlPersist=60s"].map(OsString::from));
        }
    }
    args
}

/// Finds the destination in one OpenSSH login invocation. OpenSSH accepts options on either
/// side of the destination until it sees a remote command or an explicit end of options.
pub fn parse_ssh_destination(args: &[String]) -> Result<&str, SshArgumentError> {
    let mut args = args.iter().map(String::as_str);
    let mut destination = None;
    let mut options = true;
    while let Some(word) = args.next() {
        if options && word == "--" {
            options = false;
        } else if let Some(flags) = word.strip_prefix('-').filter(|s| options && !s.is_empty()) {
            for (at, flag) in flags.bytes().enumerate() {
                // OpenSSH's options that take a value. The rest of a cluster can be the value.
                if b"BDEFIJLPRSbceilmopw".contains(&flag) {
                    let attached = &flags[at + 1..];
                    let value = if attached.is_empty() {
                        args.next().ok_or(SshArgumentError::Option)?
                    } else {
                        attached
                    };
                    if flag == b'o' {
                        check_login_option(value)?;
                    }
                    break;
                }
                // Leave terminal input and output available for the machine protocol.
                if !b"246AaCKkMgqTvXxYy".contains(&flag) {
                    return Err(SshArgumentError::Option);
                }
            }
        } else if destination.is_some() {
            return Err(SshArgumentError::RemoteCommand);
        } else if valid_destination(word) {
            destination = Some(word);
        } else {
            return Err(SshArgumentError::Destination);
        }
    }
    destination.ok_or(SshArgumentError::Destination)
}

fn check_login_option(option: &str) -> Result<(), SshArgumentError> {
    let option = option.trim_start();
    let boundary = option
        .find(|c: char| c.is_ascii_whitespace() || c == '=')
        .ok_or(SshArgumentError::Option)?;
    let (key, rest) = option.split_at(boundary);
    let rest = rest.trim_start();
    let value = rest.strip_prefix('=').unwrap_or(rest).trim();
    // Shell quoting is gone by now. Leave quotes inside an option's value for OpenSSH.
    if key.is_empty() || key.contains('"') || value.is_empty() {
        return Err(SshArgumentError::Option);
    }
    let allowed = match key.to_ascii_lowercase().as_str() {
        "remotecommand" => {
            return if value.eq_ignore_ascii_case("none") {
                Ok(())
            } else {
                Err(SshArgumentError::RemoteCommand)
            };
        }
        "localcommand" => {
            return value
                .eq_ignore_ascii_case("none")
                .then_some(())
                .ok_or(SshArgumentError::Option);
        }
        "sessiontype" => "default",
        "stdinnull" | "forkafterauthentication" | "requesttty" | "permitlocalcommand" => "no",
        _ => return Ok(()),
    };
    if !value
        .trim_matches(['"', '\''])
        .eq_ignore_ascii_case(allowed)
    {
        return Err(SshArgumentError::Option);
    }
    Ok(())
}

/// Gives OpenSSH the caller's login arguments and one Facade command for the remote shell.
pub fn ssh_command_args(
    args: &[String],
    mode: SshMode,
    control_dir: Option<&Path>,
    remote_command: &str,
) -> Result<Vec<OsString>, SshArgumentError> {
    ssh_args(args, mode, control_dir, Some(remote_command))
}

/// Starts the login shell, leaving the authenticated stream open for platform selection.
pub fn ssh_login_args(
    args: &[String],
    mode: SshMode,
    control_dir: Option<&Path>,
) -> Result<Vec<OsString>, SshArgumentError> {
    ssh_args(args, mode, control_dir, None)
}

fn ssh_args(
    args: &[String],
    mode: SshMode,
    control_dir: Option<&Path>,
    remote_command: Option<&str>,
) -> Result<Vec<OsString>, SshArgumentError> {
    parse_ssh_destination(args)?;
    let mut words = connection_args(mode, control_dir);
    if remote_command.is_none() {
        words.extend(["-o", "RemoteCommand=none"].map(OsString::from));
    }
    words.extend(args.iter().map(OsString::from));
    words.extend(remote_command.map(OsString::from));
    Ok(words)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteSystem {
    Unix,
    Windows,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteLoginShell {
    Unix,
    Cmd,
    PowerShell,
}

impl RemoteLoginShell {
    pub fn system(self) -> RemoteSystem {
        match self {
            Self::Unix => RemoteSystem::Unix,
            Self::Cmd | Self::PowerShell => RemoteSystem::Windows,
        }
    }
}

pub const REMOTE_PLATFORM_PROBE: &[u8] = b"echo \"facade-platform-%OS%-$PSHOME\"\n";

const LOGIN_BEGIN: &str = "facade-bootstrap-begin";
pub const REMOTE_BOOTSTRAP_BEGIN: &[u8] = LOGIN_BEGIN.as_bytes();

/// Recognizes one complete probe response. Login banners can contain arbitrary bytes.
pub fn parse_remote_platform(line: &[u8]) -> Option<RemoteLoginShell> {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if let Some(prefix) = line.strip_suffix(b"\"facade-platform-Windows_NT-$PSHOME\"") {
        // CMD may put its directory prompt on the same line. An echoed command has
        // its command text between the prompt and the quoted argument.
        let prompt = prefix.trim_ascii_end().strip_suffix(b">");
        if prefix.is_empty() || prompt.is_some_and(is_windows_absolute_path) {
            return Some(RemoteLoginShell::Cmd);
        }
    }
    let pshome = line.strip_prefix(b"facade-platform-%OS%-")?;
    if pshome.is_empty() {
        return Some(RemoteLoginShell::Unix);
    }
    is_windows_absolute_path(pshome).then_some(RemoteLoginShell::PowerShell)
}

fn is_windows_absolute_path(path: &[u8]) -> bool {
    if path.contains(&b'>') || path.iter().any(u8::is_ascii_control) {
        return false;
    }
    match path {
        [drive, b':', b'\\' | b'/', ..] => drive.is_ascii_alphabetic(),
        [b'\\', b'\\', unc @ ..] => {
            let mut components = unc.splitn(3, |&byte| byte == b'\\');
            components.next().is_some_and(|host| !host.is_empty())
                && components.next().is_some_and(|share| !share.is_empty())
        }
        _ => false,
    }
}

const UNIX_PROGRAM: &str = r#""$HOME/.local/bin/facade""#;
const WINDOWS_PROGRAM: &str = r#"(Join-Path $env:LOCALAPPDATA 'Facade\bin\facade.exe')"#;

fn unix_probe_script(installed: &str, missing: &str) -> String {
    format!(
        r#"for dir in "$HOME" "$HOME/.local" "$HOME/.local/bin"; do
            if [ -d "$dir" ] && [ -x "$dir" ]; then continue; fi
            if [ "$dir" != "$HOME" ] && [ ! -e "$dir" ] && [ ! -L "$dir" ]; then break; fi
            printf 'Cannot access Facade installation directory: %s\n' "$dir" >&2
            exit 1
        done
        if [ -e {UNIX_PROGRAM} ] || [ -L {UNIX_PROGRAM} ]; then
            {installed}
        else
            {missing}
        fi"#
    )
}

fn windows_probe_script(installed: &str, missing: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; $program = {WINDOWS_PROGRAM}; \
         try {{ $item = Get-Item -LiteralPath $program -Force -ErrorAction Stop }} \
         catch [System.Management.Automation.ItemNotFoundException] {{ $item = $null }}; \
         if ($null -ne $item) {{ {installed} }} else {{ {missing} }}"
    )
}

/// Runs the fixed installation's machine protocol with the requested wake behavior.
pub fn remote_serve_command(
    system: RemoteSystem,
    remote_home: Option<&str>,
    wake: bool,
) -> Result<String, SshArgumentError> {
    let arguments = serve_arguments(remote_home, wake)?;
    Ok(match system {
        RemoteSystem::Unix => sh_command(&format!("exec {UNIX_PROGRAM} {arguments}"), &[]),
        RemoteSystem::Windows => powershell_command(&format!(
            "$ErrorActionPreference = 'Stop'; & {WINDOWS_PROGRAM} {arguments}; exit $LASTEXITCODE"
        )),
    })
}

fn serve_arguments(remote_home: Option<&str>, wake: bool) -> Result<String, SshArgumentError> {
    let mut arguments = String::from("machine serve");
    if !wake {
        arguments.push_str(" --no-start");
    }
    if let Some(home) = remote_home {
        arguments.push_str(" --home-hex ");
        arguments.push_str(&home_hex(home)?);
    }
    Ok(arguments)
}

/// Runs the installer pinned to the release part of the build version.
pub fn remote_install_command(
    system: RemoteSystem,
    version: &str,
    remote_home: Option<&str>,
) -> Result<String, SshArgumentError> {
    let version = release_version(version)?;
    if let Some(home) = remote_home {
        check_home(home)?;
    }
    Ok(match system {
        RemoteSystem::Unix => {
            unix_pinned_command(&unix_install_script(remote_home), version, remote_home)
        }
        RemoteSystem::Windows => powershell_command(&windows_install_script(version, remote_home)),
    })
}

fn release_version(version: &str) -> Result<&str, SshArgumentError> {
    if crate::version_of(version).is_none() {
        return Err(SshArgumentError::Version);
    }
    Ok(crate::build_version(version))
}

fn unix_pinned_command(script: &str, version: &str, remote_home: Option<&str>) -> String {
    let url = install::pinned(version, "sh");
    let mut arguments = vec![url.as_str(), version];
    arguments.extend(remote_home);
    sh_command(script, &arguments)
}

fn unix_install_script(remote_home: Option<&str>) -> String {
    let home = if remote_home.is_some() {
        r#"export FACADE_HOME="$3"; "#
    } else {
        ""
    };
    format!(r#"{home}script=$(curl -fsSL "$1") && sh -c "$script" -- --version "$2" >&2"#)
}

fn windows_install_script(version: &str, remote_home: Option<&str>) -> String {
    let url = install::pinned(version, "ps1");
    let prefix = remote_home.map_or_else(String::new, |home| {
        let bytes = STANDARD.encode(home);
        format!(
            "$env:FACADE_HOME = [Text.Encoding]::UTF8.GetString(\
             [Convert]::FromBase64String('{bytes}')); "
        )
    });
    let arguments = format!(
        " -Version '{version}' | ForEach-Object {{ \
         [Console]::Error.WriteLine($_) }}"
    );
    install::powershell_install(&url, &prefix, &arguments)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteProbe {
    Missing,
    Installed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootstrapAction {
    Serve,
    Install,
    UpgradeLocal,
    NeedsInstall,
}

pub const BOOTSTRAP_SERVE: &[u8] = b"serve\n";
pub const BOOTSTRAP_INSTALL: &[u8] = b"install\n";
pub const BOOTSTRAP_READY: &str = "ready";

/// Reads the bootstrap's first line, before the caller sends its decision.
pub fn parse_remote_probe(line: &str) -> Result<RemoteProbe, SshArgumentError> {
    match line.trim_end_matches(['\r', '\n']) {
        "missing" => Ok(RemoteProbe::Missing),
        line => {
            let version = line
                .strip_prefix("version ")
                .ok_or(SshArgumentError::Probe)?;
            if version.is_empty() || version.chars().any(char::is_whitespace) {
                return Err(SshArgumentError::Version);
            }
            Ok(RemoteProbe::Installed(version.to_owned()))
        }
    }
}

/// Chooses what can run after the probe. A passive caller leaves installation to an active one.
pub fn bootstrap_action(
    probe: &RemoteProbe,
    local_build: &str,
    wake: bool,
) -> Result<BootstrapAction, SshArgumentError> {
    use std::cmp::Ordering;

    let local = crate::version_of(local_build).ok_or(SshArgumentError::Version)?;
    if let RemoteProbe::Installed(version) = probe {
        let remote = crate::version_of(version).ok_or(SshArgumentError::Version)?;
        match remote.cmp(&local) {
            Ordering::Equal => return Ok(BootstrapAction::Serve),
            Ordering::Greater => return Ok(BootstrapAction::UpgradeLocal),
            Ordering::Less => {}
        }
    }
    Ok(if wake {
        BootstrapAction::Install
    } else {
        BootstrapAction::NeedsInstall
    })
}

/// Probes, optionally installs, and hands the same SSH streams to machine serve.
pub fn remote_bootstrap_command(
    system: RemoteSystem,
    remote_home: Option<&str>,
    version: &str,
    wake: bool,
) -> Result<String, SshArgumentError> {
    bootstrap_command(system, remote_home, version, wake, false)
}

/// Sends the bootstrap to the selected login shell and returns serve's exit status through it.
pub fn remote_login_bootstrap_command(
    shell: RemoteLoginShell,
    remote_home: Option<&str>,
    version: &str,
    wake: bool,
) -> Result<String, SshArgumentError> {
    let command = bootstrap_command(shell.system(), remote_home, version, wake, true)?;
    Ok(match shell {
        RemoteLoginShell::Unix => format!("exec {command}\n"),
        RemoteLoginShell::Cmd => format!("{command} & exit\n"),
        RemoteLoginShell::PowerShell => format!("{command}; exit $LASTEXITCODE\n"),
    })
}

fn bootstrap_command(
    system: RemoteSystem,
    remote_home: Option<&str>,
    version: &str,
    wake: bool,
    from_login: bool,
) -> Result<String, SshArgumentError> {
    let version = release_version(version)?;
    let arguments = serve_arguments(remote_home, wake)?;
    Ok(match system {
        RemoteSystem::Unix => {
            let begin = if from_login {
                format!("printf '\\n%s\\n' {LOGIN_BEGIN} || exit 1\n")
            } else {
                String::new()
            };
            let probe = unix_probe_script(
                &format!(
                    r#"report=$({UNIX_PROGRAM} --version) || exit 1
                    case "$report" in
                        'facade '*) printf 'version %s\n' "${{report#facade }}" ;;
                        *) printf 'Unexpected version from %s\n' {UNIX_PROGRAM} >&2; exit 1 ;;
                    esac"#
                ),
                "printf '%s\\n' missing",
            );
            let install = if wake {
                format!("{} || exit 1", unix_install_script(remote_home))
            } else {
                "printf '%s\\n' 'Facade installation requires an active connection' >&2; exit 1"
                    .to_owned()
            };
            let script = format!(
                r#"{begin}{probe}
                IFS= read -r action || exit 1
                case "$action" in
                    serve) ;;
                    install) {install} ;;
                    *) printf '%s\n' 'Expected a Facade bootstrap decision' >&2; exit 1 ;;
                esac
                printf '%s\n' {BOOTSTRAP_READY} || exit 1
                exec {UNIX_PROGRAM} {arguments}"#
            );
            if wake {
                unix_pinned_command(&script, version, remote_home)
            } else {
                sh_command(&script, &[])
            }
        }
        RemoteSystem::Windows => {
            let begin = if from_login {
                format!("[Console]::WriteLine(); [Console]::WriteLine('{LOGIN_BEGIN}'); ")
            } else {
                String::new()
            };
            let probe = windows_probe_script(
                "$report = & $program --version; if ($LASTEXITCODE -ne 0) { exit 1 }; \
                 if ($report -isnot [string] -or -not $report.StartsWith('facade ')) { \
                     throw \"Unexpected version from $program\" \
                 }; [Console]::WriteLine('version ' + $report.Substring(7))",
                "[Console]::WriteLine('missing')",
            );
            let install = if wake {
                windows_install_script(version, remote_home)
            } else {
                "throw 'Facade installation requires an active connection'".to_owned()
            };
            powershell_command(&format!(
                "{begin}{probe}; \
                 $action = [Console]::ReadLine(); if ($null -eq $action) {{ exit 1 }}; \
                 switch -CaseSensitive ($action) {{ \
                     'serve' {{ }} \
                     'install' {{ {install} }} \
                     default {{ throw 'Expected a Facade bootstrap decision' }} \
                 }}; \
                 [Console]::WriteLine('{BOOTSTRAP_READY}'); \
                 & $program {arguments}; exit $LASTEXITCODE"
            ))
        }
    })
}

fn sh_command(script: &str, arguments: &[&str]) -> String {
    let mut command = format!("sh -c {}", sh_word(script));
    if !arguments.is_empty() {
        command.push_str(" facade-install");
        for argument in arguments {
            command.push(' ');
            command.push_str(&sh_word(argument));
        }
    }
    command
}

fn sh_word(value: &str) -> String {
    format!(
        "'{}'",
        value.replace('\'', "'\"'\"'").replace('\\', "'\"\\\\\"'")
    )
}

fn powershell_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe {} -EncodedCommand {}",
        install::POWERSHELL_OPTIONS.join(" "),
        STANDARD.encode(bytes)
    )
}

fn check_home(home: &str) -> Result<(), SshArgumentError> {
    if home.is_empty() || home.contains('\0') {
        return Err(SshArgumentError::Home);
    }
    Ok(())
}

fn home_hex(home: &str) -> Result<String, SshArgumentError> {
    check_home(home)?;
    Ok(home.bytes().map(|byte| format!("{byte:02x}")).collect())
}

pub fn decode_home_hex(hex: &str) -> Result<String, SshArgumentError> {
    if hex.is_empty()
        || !hex.len().is_multiple_of(2)
        || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(SshArgumentError::Home);
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).map_err(|_| SshArgumentError::Home))
        .collect::<Result<Vec<_>, _>>()?;
    let home = String::from_utf8(bytes).map_err(|_| SshArgumentError::Home)?;
    if home.contains('\0') {
        return Err(SshArgumentError::Home);
    }
    Ok(home)
}

/// Keeps a long-lived SSH link from inheriting the caller's output capture pipes.
/// Call this before starting the link. Its explicitly configured streams still work normally.
pub fn keep_redirected_output_private() -> io::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
        };
        use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType};
        use windows_sys::Win32::System::Console::{
            GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
        };

        for slot in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // SAFETY: slot identifies a standard handle. The process still owns the result.
            let handle = unsafe { GetStdHandle(slot) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                continue;
            }
            // SAFETY: these calls inspect the open standard handle and change only inheritance.
            if unsafe {
                GetFileType(handle) == FILE_TYPE_PIPE
                    && SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) == 0
            } {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(())
}

/// Starts OpenSSH with pipes for its input and output and the caller's choice of standard error.
pub fn spawn_ssh(mut command: Command) -> io::Result<(Child, ChildStdin, ChildStdout)> {
    #[cfg(windows)]
    {
        let stdio = ssh_stdio()?;
        let child = command.stdin(stdio.stdin).stdout(stdio.stdout).spawn()?;
        Ok((child, stdio.to_ssh, stdio.from_ssh))
    }
    #[cfg(unix)]
    {
        use std::process::Stdio;

        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let to_ssh = child.stdin.take().expect("stdin was piped");
        let from_ssh = child.stdout.take().expect("stdout was piped");
        Ok((child, to_ssh, from_ssh))
    }
}

/// Standard input and output for OpenSSH on Windows.
///
/// The ssh.exe that ships with Windows passes on data through a synchronous pipe only when more
/// arrives behind it, in both directions, so a session stalls one frame behind. Rust gives a
/// child synchronous pipe ends, so these pipes are overlapped at both ends; Git for Windows'
/// ssh.exe accepts either.
#[cfg(windows)]
pub struct SshStdio {
    /// OpenSSH's standard input.
    pub stdin: std::process::Stdio,
    /// OpenSSH's standard output.
    pub stdout: std::process::Stdio,
    pub to_ssh: std::process::ChildStdin,
    pub from_ssh: std::process::ChildStdout,
}

#[cfg(windows)]
pub fn ssh_stdio() -> std::io::Result<SshStdio> {
    use windows_sys::Win32::Storage::FileSystem::{PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND};

    let (to_ssh, stdin) = ssh_pipe(PIPE_ACCESS_OUTBOUND)?;
    let (from_ssh, stdout) = ssh_pipe(PIPE_ACCESS_INBOUND)?;
    Ok(SshStdio {
        stdin: stdin.into(),
        stdout: stdout.into(),
        to_ssh: to_ssh.into(),
        from_ssh: from_ssh.into(),
    })
}

/// A one-instance local pipe that only this user can open: this process's end with `access`, and
/// OpenSSH's end for the other direction, both overlapped.
#[cfg(windows)]
fn ssh_pipe(access: u32) -> std::io::Result<(std::os::windows::io::OwnedHandle, std::fs::File)> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_OUTBOUND,
    };
    use windows_sys::Win32::System::Pipes::{
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    let name = format!(
        r"\\.\pipe\facade-ssh-{}-{:016x}",
        std::process::id(),
        super::random_u64()
    );
    let ours = super::sockets::owner_only_pipe(
        std::ffi::OsStr::new(&name),
        access | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,
    )?;
    let outbound = access == PIPE_ACCESS_OUTBOUND;
    let theirs = std::fs::OpenOptions::new()
        .read(outbound)
        .write(!outbound)
        .custom_flags(FILE_FLAG_OVERLAPPED)
        .open(&name)?;
    Ok((ours, theirs))
}
