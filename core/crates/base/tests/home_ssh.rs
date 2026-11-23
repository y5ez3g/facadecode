use base64::prelude::*;
use facade_base::ssh::{RemoteSystem, remote_bootstrap_command};

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
