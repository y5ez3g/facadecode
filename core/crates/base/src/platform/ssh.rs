//! Shared arguments for a foreground or saved machine connection.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

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
    Home,
}

impl fmt::Display for SshArgumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Destination => "supply one SSH destination, such as a host or user@host",
            Self::Home => "the remote home must be a nonempty UTF-8 path",
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
    if ssh_destination.is_empty()
        || ssh_destination.starts_with('-')
        || ssh_destination
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(SshArgumentError::Destination);
    }
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
    args.extend(["--", ssh_destination, "facade", "machine", "serve"].map(OsString::from));
    if let Some(home) = remote_home {
        if home.is_empty() || home.contains('\0') {
            return Err(SshArgumentError::Home);
        }
        let hex: String = home.bytes().map(|byte| format!("{byte:02x}")).collect();
        args.extend([OsString::from("--home-hex"), OsString::from(hex)]);
    }
    Ok(args)
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
