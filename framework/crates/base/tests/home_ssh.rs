use base64::prelude::*;
use facade_base::ssh::{
    RemoteLoginShell, RemoteSystem, SshAdminMode, remote_bootstrap_command,
    remote_login_admin_command,
};

#[test]
fn ssh_install_routes_by_version_and_pins_the_complete_build() {
    let version = "0.1.6";
    let build = format!("{version}+1700000000.{}", "d".repeat(40));
    let unix = remote_bootstrap_command(
        RemoteSystem::Unix,
        Some("/qa/selected home"),
        &build,
        true,
        true,
    )
    .unwrap();
    assert!(
        unix.contains(
            "--version \"$4\" --expected-build \"$5\" --install-root \"$FACADE_HOME\" --no-path"
        ),
        "{unix}"
    );
    assert!(
        unix.contains("'/qa/selected home'") && unix.contains("/releases/0.1.6/"),
        "{unix}"
    );
    assert!(unix.ends_with(&format!("'{version}' '{build}'")), "{unix}");
    assert!(unix.contains("\"$report\" != \"facade $5\""), "{unix}");

    let windows = remote_bootstrap_command(
        RemoteSystem::Windows,
        Some("C:\\qa\\selected home"),
        &build,
        true,
        true,
    )
    .unwrap();
    let encoded = windows
        .split_once("FromBase64String('")
        .unwrap()
        .1
        .split_once("')")
        .unwrap()
        .0;
    let script = String::from_utf8(BASE64_STANDARD.decode(encoded).unwrap()).unwrap();
    for expected in [
        "/releases/0.1.6/",
        "ExpectedBuild",
        "InstallRoot",
        "NoPath",
        &build,
    ] {
        assert!(script.contains(expected), "missing {expected}: {script}");
    }
    assert!(
        script.contains(&format!("$report -cne 'facade {build}'")),
        "{script}"
    );
}

#[test]
fn windows_login_keeps_a_long_bootstrap_inside_cmds_line_limit() {
    let home = format!("C:\\{}\\{}", "界".repeat(132), "界".repeat(134));
    let build = format!("0.1.6+1700000000.{}", "d".repeat(40));
    let login = |shell| {
        remote_login_admin_command(shell, Some(&home), &build, SshAdminMode::Enroll).unwrap()
    };
    let command = login(RemoteLoginShell::Cmd);
    assert!(command.lines().all(|line| line.len() <= 8_191));
    let (parts, powershell_command) = command.trim_end().rsplit_once('\n').unwrap();
    assert!(powershell_command.starts_with("powershell.exe "));
    assert!(powershell_command.contains("Remove-Item Env:FACADE_SSH_BOOTSTRAP_PART_0"));
    assert!(powershell_command.ends_with(" & exit"));
    let mut encoded = String::new();
    for (index, line) in parts.lines().enumerate() {
        let prefix = format!("set FACADE_SSH_BOOTSTRAP_PART_{index}=");
        encoded.push_str(line.strip_prefix(&prefix).expect("a CMD set command"));
    }
    let powershell = login(RemoteLoginShell::PowerShell);
    let direct = powershell
        .split_once("FromBase64String('")
        .unwrap()
        .1
        .split_once("')")
        .unwrap()
        .0;
    assert_eq!(encoded, direct);
}

#[cfg(windows)]
#[test]
fn windows_login_keeps_its_native_shell_on_the_open_stream() {
    use facade_base::ssh::REMOTE_LOGIN_COMMAND;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/d", "/c"])
        .raw_arg(format!("\"{REMOTE_LOGIN_COMMAND}\""));
    let mut powershell = Command::new("powershell.exe");
    powershell
        .args(["-NoLogo", "-NoProfile", "-Command", REMOTE_LOGIN_COMMAND])
        .env_remove("ComSpec");

    // Windows PowerShell can cache startup data even when profiles are skipped.
    let home = LoginHome::new();
    let roaming = home.0.join("AppData/Roaming");
    let local = home.0.join("AppData/Local");
    std::fs::create_dir_all(&roaming).unwrap();
    std::fs::create_dir_all(&local).unwrap();
    for command in [&mut cmd, &mut powershell] {
        command
            .env("USERPROFILE", &home.0)
            .env("HOME", &home.0)
            .env("APPDATA", &roaming)
            .env("LOCALAPPDATA", &local)
            .current_dir(&home.0);
    }

    check_open_login_stream(&mut cmd, RemoteLoginShell::Cmd);
    check_open_login_stream(&mut powershell, RemoteLoginShell::PowerShell);
}

#[cfg(target_os = "macos")]
#[test]
fn c_shell_login_keeps_its_profile_on_the_open_stream() {
    use facade_base::ssh::REMOTE_LOGIN_COMMAND;
    use std::process::Command;

    let home = LoginHome::new();
    // A Unix probe requires an empty PSHOME. Only a login shell reads this file.
    std::fs::write(home.0.join(".login"), "setenv PSHOME \"\"\n").unwrap();
    for shell in ["/bin/csh", "/bin/tcsh"] {
        let mut command = Command::new(shell);
        command
            .args(["-c", REMOTE_LOGIN_COMMAND])
            .env_clear()
            .env("HOME", &home.0)
            .env("SHELL", shell)
            .env("PATH", "/usr/bin:/bin")
            .env("PSHOME", "login-profile-not-loaded")
            .current_dir(&home.0);
        check_open_login_stream(&mut command, RemoteLoginShell::Unix);
    }
}

#[cfg(any(windows, target_os = "macos"))]
struct LoginHome(std::path::PathBuf);

#[cfg(any(windows, target_os = "macos"))]
impl LoginHome {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("facade-ssh-login-{}", facade_base::random_u64()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl Drop for LoginHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn check_open_login_stream(command: &mut std::process::Command, expected: RemoteLoginShell) {
    use facade_base::ssh::{REMOTE_PLATFORM_PROBE, parse_remote_platform};
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Duration;

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let report = BufReader::new(output)
            .split(b'\n')
            .map_while(Result::ok)
            .find_map(|line| parse_remote_platform(&line));
        let _ = send.send(report);
    });

    let written = input.write_all(REMOTE_PLATFORM_PROBE);
    let report = receive.recv_timeout(Duration::from_secs(10)).ok().flatten();
    let exit = input.write_all(b"exit 3\n");
    drop(input);
    if report != Some(expected) {
        let _ = child.kill();
    }
    let status = child.wait().unwrap();
    reader.join().unwrap();
    written.unwrap();
    assert_eq!(report, Some(expected), "{command:?}");
    exit.unwrap();
    assert_eq!(status.code(), Some(3), "{command:?}");
}
