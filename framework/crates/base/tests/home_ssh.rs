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
