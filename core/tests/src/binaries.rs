//! Locates the workspace programs used by scenario tests.

use std::env::consts::EXE_SUFFIX;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::{TestHome, stderr};

const V2_SOURCE: &str = "1a1e07916babf5559a70f2df82dc0f1ce4378a4c";
pub const V2_TEST_BUILD: &str = "0.1.5+qa-v2";

/// Paths to the programs under test.
pub struct TestBinaries {
    pub facade: PathBuf,
    pub mcp: PathBuf,
    pub fakecli: PathBuf,
}

/// Builds facade, facade-mcp, and the fake CLI once per test process, using the test profile.
pub fn test_binaries() -> &'static TestBinaries {
    static TEST_BINARIES: OnceLock<TestBinaries> = OnceLock::new();
    TEST_BINARIES.get_or_init(|| {
        // Find the profile folder from target/<profile>/deps/<test> or target/<profile>/<program>.
        let exe = std::env::current_exe().expect("test executable path");
        let mut dir = exe
            .parent()
            .expect("test executable must have a parent folder")
            .to_path_buf();
        if dir.file_name().is_some_and(|name| name == "deps") {
            dir.pop();
        }
        let bins = TestBinaries {
            facade: dir.join(format!("facade{EXE_SUFFIX}")),
            mcp: dir.join(format!("facade-mcp{EXE_SUFFIX}")),
            fakecli: dir.join(format!("facade-fakecli{EXE_SUFFIX}")),
        };
        // When run through Cargo, build from this source unless test-all already built the programs.
        // When run directly, use adjacent binaries.
        if let Some(cargo) = std::env::var_os("CARGO")
            .filter(|_| std::env::var_os("FACADE_TEST_BINARIES_BUILT").is_none())
        {
            let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("the workspace folder")
                .to_path_buf();
            let mut build = Command::new(cargo);
            build.current_dir(&workspace).args([
                "build",
                "--quiet",
                "-p",
                "facade",
                "-p",
                "facade-relay",
                "-p",
                "facade-scenarios",
                "--bin",
                "facade",
                "--bin",
                "facade-mcp",
                "--bin",
                "facade-fakecli",
            ]);
            if dir.file_name().is_some_and(|name| name == "release") {
                build.arg("--release");
            }
            let status = build.status().expect("could not run cargo");
            assert!(
                status.success(),
                "building facade, facade-mcp, and facade-fakecli failed"
            );
        }
        assert!(
            bins.facade.exists() && bins.mcp.exists() && bins.fakecli.exists(),
            "build them first: cargo build -p facade -p facade-relay -p facade-scenarios --bin facade \
             --bin facade-mcp --bin facade-fakecli (with --release for {})",
            dir.display()
        );
        bins
    })
}

/// The real protocol-2 fixture. A prepared QA build can be supplied for an isolated scenario run.
/// A regular Cargo run builds the pinned source with its native relay and console dependencies.
pub fn v2_facade(home: &TestHome) -> PathBuf {
    let folder = std::env::var_os("FACADE_TEST_V2_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| build_v2_fixture(home));
    assert!(
        folder.is_absolute(),
        "use an absolute protocol-2 fixture directory"
    );
    let program = folder.join(format!("facade{EXE_SUFFIX}"));
    assert!(
        program.is_file(),
        "the v2 fixture is missing {}",
        program.display()
    );
    let build = folder.join(format!("facade{EXE_SUFFIX}.test-build"));
    assert_eq!(
        std::fs::read_to_string(build).unwrap().trim(),
        V2_TEST_BUILD
    );
    program
}

fn build_v2_fixture(home: &TestHome) -> PathBuf {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    let source = home.folder().join("v2");
    let target = home.folder().join("v2-target");
    std::fs::create_dir(&source).unwrap();
    let git = || {
        let mut command = home.command("git");
        command
            .current_dir(checkout)
            .env("GIT_TERMINAL_PROMPT", "0");
        command
    };
    let check = |step: &str, command: &mut Command| {
        let output = command
            .output()
            .unwrap_or_else(|error| panic!("{step}: {error}"));
        assert!(output.status.success(), "{step}: {}", stderr(&output));
    };
    if !git()
        .args(["cat-file", "-e", V2_SOURCE])
        .output()
        .unwrap()
        .status
        .success()
    {
        // The CI checkout can be shallow. Fetch just the fixture revision without changing a ref.
        check(
            "fetch the pinned v2 source",
            git().args([
                "fetch",
                "--no-write-fetch-head",
                "--no-tags",
                "--depth=1",
                "origin",
                V2_SOURCE,
            ]),
        );
    }
    let archive = home.folder().join("v2.tar");
    check(
        "archive the v2 source",
        git()
            .args(["archive", "--format=tar", "--output"])
            .arg(&archive)
            .args([V2_SOURCE, "core", "extension/src/base/names.ts"]),
    );
    check(
        "unpack the v2 source",
        home.command("tar")
            .current_dir(&source)
            .arg("-xf")
            .arg(archive),
    );

    let cargo = std::env::var_os("CARGO").expect("run with Cargo or supply FACADE_TEST_V2_BIN");
    let mut build = home.command(cargo);
    // Compiler tools need the build environment. Programs run by the scenario use TestHome's PATH.
    for name in [
        "PATH",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "RUSTUP_TOOLCHAIN",
        "RUSTC",
        "LIB",
        "LIBPATH",
        "INCLUDE",
        "VSCMD_SKIP_SENDTELEMETRY",
    ] {
        if let Some(value) = std::env::var_os(name) {
            build.env(name, value);
        }
    }
    check(
        "build the real protocol-2 Facade and relay",
        build
            .current_dir(source.join("core"))
            .env("CARGO_INCREMENTAL", "0")
            .env("CARGO_BUILD_JOBS", "2")
            .args([
                "build",
                "--locked",
                "-p",
                "facade",
                "-p",
                "facade-relay",
                "--bin",
                "facade",
                "--bin",
                "facade-mcp",
                "--target-dir",
            ])
            .arg(&target),
    );
    let bin = target.join("debug");
    for name in ["facade", "facade-mcp"] {
        std::fs::write(
            bin.join(format!("{name}{EXE_SUFFIX}.test-build")),
            V2_TEST_BUILD,
        )
        .unwrap();
    }
    bin
}
