// Facade (memory): Facade's, not upstream's (vendor/README.md). Runs upstream's 45 ref tests against this vendored source. The
// recordings (46 MB) are not vendored, so the test takes them, with the package's manifest and lock file, from the crates.io
// package in the cargo registry, which it fetches once if the registry lacks it. It builds in a folder of its own under the
// target folder, so a later run rebuilds only this crate.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

const PACKAGE: &str = "alacritty_terminal-0.26.0";
const REF_TESTS: usize = 45;

#[test]
fn upstream_s_ref_tests_pass_on_the_vendored_source() {
    let package = registry_package().unwrap_or_else(|| {
        fetch_package();
        registry_package().unwrap_or_else(|| panic!("no {PACKAGE} in the cargo registry after a fetch"))
    });
    let work = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("upstream-ref");
    let _ = fs::remove_dir_all(work.join("src"));
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &work.join("src"));
    if !work.join("tests/ref").is_dir() {
        copy_dir(&package.join("tests"), &work.join("tests"));
    }
    // Its own workspace: the folder is inside Facade's, under the target folder.
    let manifest = fs::read_to_string(package.join("Cargo.toml")).unwrap();
    fs::write(work.join("Cargo.toml"), format!("{manifest}\n[workspace]\n")).unwrap();
    fs::copy(package.join("Cargo.lock"), work.join("Cargo.lock")).unwrap();
    let output = Command::new(env!("CARGO"))
        .args(["test", "--locked", "--test", "ref"])
        .current_dir(&work)
        .env("CARGO_TARGET_DIR", work.join("target"))
        .output()
        .unwrap();
    let report = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{report}{}", String::from_utf8_lossy(&output.stderr));
    assert!(report.contains(&format!("test result: ok. {REF_TESTS} passed")), "{report}");
}

/// The crates.io package's folder in the cargo registry, if it is there.
fn registry_package() -> Option<PathBuf> {
    let home = env::var_os("CARGO_HOME").map(PathBuf::from).or_else(|| {
        env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")).map(|home| Path::new(&home).join(".cargo"))
    })?;
    fs::read_dir(home.join("registry").join("src"))
        .ok()?
        .flatten()
        .map(|index| index.path().join(PACKAGE))
        .find(|package| package.join("tests").join("ref").is_dir())
}

/// Fetches the crates.io package into the registry, through a manifest that depends on it without Facade's patch.
fn fetch_package() {
    let fetch = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("upstream-ref-fetch");
    fs::create_dir_all(fetch.join("src")).unwrap();
    let version = PACKAGE.trim_start_matches("alacritty_terminal-");
    let manifest = format!(
        "[package]\nname = \"fetch\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[dependencies]\nalacritty_terminal = \"={version}\"\n\n[workspace]\n"
    );
    fs::write(fetch.join("Cargo.toml"), manifest).unwrap();
    fs::write(fetch.join("src").join("lib.rs"), "").unwrap();
    let status = Command::new(env!("CARGO")).arg("fetch").current_dir(&fetch).status().unwrap();
    assert!(status.success(), "cargo fetch of {PACKAGE}");
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            copy_dir(&path, &to.join(entry.file_name()));
        } else {
            fs::copy(&path, to.join(entry.file_name())).unwrap();
        }
    }
}
