//! Which operating system this build runs on. Outside platform, only rules reads it, to choose the
//! rule data that differs by system.

use std::collections::BTreeMap;
use std::io;
use std::time::Duration;

/// The operating systems Facade Code Framework builds for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum System {
    /// macOS and Linux.
    Unix,
    Windows,
}

/// The system this build runs on.
#[cfg(unix)]
pub const SYSTEM: System = System::Unix;

/// The system this build runs on.
#[cfg(windows)]
pub const SYSTEM: System = System::Windows;

/// The system hostname, used to derive a new Facade Code Framework machine's name.
pub fn hostname() -> io::Result<String> {
    #[cfg(unix)]
    {
        let mut name = [0u8; 256];
        // SAFETY: name points to a writable buffer of the advertised length.
        if unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let name = std::ffi::CStr::from_bytes_until_nul(&name).map_err(io::Error::other)?;
        Ok(name.to_string_lossy().into_owned())
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{
            ComputerNameDnsHostname, GetComputerNameExW,
        };

        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        // SAFETY: name has space for length UTF-16 units and length is writable.
        if unsafe { GetComputerNameExW(ComputerNameDnsHostname, name.as_mut_ptr(), &mut length) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(String::from_utf16_lossy(&name[..length as usize]))
    }
}

/// The user's login environment on the running machine. The caller filters it for the run.
pub async fn login_environment(timeout: Duration) -> anyhow::Result<BTreeMap<String, String>> {
    #[cfg(unix)]
    {
        use anyhow::Context as _;
        use std::process::Stdio;

        let account = nix::unistd::User::from_uid(nix::unistd::geteuid())?
            .context("the current user has no login account")?;
        // The marker separates the environment from anything a login file prints before it.
        const COMMAND: &str = r"/usr/bin/printf '\0FACADE-LOGIN-ENV\0'; exec /usr/bin/env -0";
        const MARKER: &[u8] = b"\0FACADE-LOGIN-ENV\0";
        let mut command = tokio::process::Command::new(&account.shell);
        if let Some(shell @ ("csh" | "tcsh")) = account.shell.file_name().and_then(|s| s.to_str()) {
            // The C shells take -l only as their sole option. A leading dash on argv[0]
            // selects their login files while still allowing -c.
            command.arg0(format!("-{shell}"));
        } else {
            command.arg("-l");
        }
        command
            .args(["-c", COMMAND])
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(timeout, command.output())
            .await
            .context("the login shell did not return its environment in time")??;
        anyhow::ensure!(
            output.status.success(),
            "the login shell exited with {}",
            output.status
        );
        let start = output
            .stdout
            .windows(MARKER.len())
            .position(|bytes| bytes == MARKER)
            .context("the login shell did not return its environment")?
            + MARKER.len();
        Ok(output.stdout[start..]
            .split(|byte| *byte == 0)
            .filter_map(|entry| {
                let (key, value) = std::str::from_utf8(entry).ok()?.split_once('=')?;
                Some((key.to_owned(), value.to_owned()))
            })
            .collect())
    }
    #[cfg(windows)]
    {
        let _ = timeout;
        // Native OpenSSH and the daemon already run in the user's Windows environment.
        Ok(std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect())
    }
}

/// Whether Linux logind cleans up this user's SSH processes. Returns none when the platform
/// has no such policy to report or the running policy cannot be read.
pub async fn ssh_cleans_processes(timeout: Duration) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        tokio::time::timeout(timeout, logind_cleans_processes())
            .await
            .ok()
            .flatten()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = timeout;
        None
    }
}

#[cfg(target_os = "linux")]
async fn logind_cleans_processes() -> Option<bool> {
    let properties = command_output(
        "busctl",
        &[
            "--system",
            "get-property",
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
            "KillUserProcesses",
            "KillOnlyUsers",
            "KillExcludeUsers",
        ],
    )
    .await?;
    let mut lines = properties.lines();
    let kill_all = match lines.next()? {
        "b true" => true,
        "b false" => false,
        _ => return None,
    };
    let only = logind_users(lines.next()?)?;
    let excluded = logind_users(lines.next()?)?;
    // NSS can consult a network service. Resolve the effective user in a child so the same
    // deadline covers the lookup and can stop it.
    let user = command_output("id", &["-un"]).await?;
    let user = user
        .strip_suffix('\n')
        .filter(|name| !name.is_empty() && !name.contains('\n'))?;
    let covered = if only.is_empty() {
        kill_all
    } else {
        only.contains(&user)
    };
    // Linger holds the user manager open. The session scope follows the kill policy.
    Some(covered && !excluded.contains(&user))
}

#[cfg(target_os = "linux")]
fn logind_users(line: &str) -> Option<Vec<&str>> {
    let mut fields = line.strip_prefix("as ")?.split_whitespace();
    let count: usize = fields.next()?.parse().ok()?;
    let users: Vec<&str> = fields
        .map(|name| {
            let name = name.strip_prefix('"')?.strip_suffix('"')?;
            (!name.contains(['\\', '"'])).then_some(name)
        })
        .collect::<Option<_>>()?;
    (users.len() == count).then_some(users)
}

#[cfg(target_os = "linux")]
async fn command_output(program: &'static str, args: &'static [&'static str]) -> Option<String> {
    use std::process::Stdio;

    // Starting the process can also block before the first asynchronous read.
    let child = tokio::task::spawn_blocking(move || {
        tokio::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
    })
    .await
    .ok()?
    .ok()?;
    let output = child.wait_with_output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// The value of the variable `name` in `env`. Windows compares names without regard to case, as
/// it gives `Path` where Unix gives `PATH`; Unix compares them exactly.
pub fn env_var<'a>(
    env: &'a std::collections::BTreeMap<String, String>,
    name: &str,
) -> Option<&'a str> {
    #[cfg(unix)]
    return env.get(name).map(String::as_str);
    #[cfg(windows)]
    env.iter()
        .find(|(each, _)| each.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// The user's home folder as programs on this system find it in the environment `env`, as Node's
/// `os.homedir()` does: `USERPROFILE` on Windows, `HOME` on Unix; None where it is unset or empty.
pub fn home_folder_in(
    env: &std::collections::BTreeMap<String, String>,
) -> Option<std::path::PathBuf> {
    #[cfg(unix)]
    let name = "HOME";
    #[cfg(windows)]
    let name = "USERPROFILE";
    env_var(env, name)
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from)
}
