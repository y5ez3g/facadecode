//! Locates the workspace programs used by scenario tests.

use std::env::consts::EXE_SUFFIX;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

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
