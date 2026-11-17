//! Places the packaged console host beside Windows programs.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    assert_eq!(
        env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
        Ok("x86_64"),
        "the bundled ConPTY package supports Windows x64"
    );

    let source =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets the manifest path"))
            .join("../../vendor/conpty/1.25.260303002/win10-x64");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets the build output path"));
    let destination = out
        .ancestors()
        .nth(3)
        .expect("cargo build output is inside the target profile")
        .join("conpty");
    fs::create_dir_all(&destination).expect("create the build's ConPTY folder");
    for name in ["conpty.dll", "OpenConsole.exe"] {
        let file = source.join(name);
        println!("cargo:rerun-if-changed={}", file.display());
        fs::copy(&file, destination.join(name)).unwrap_or_else(|error| {
            panic!(
                "copy {} into {}: {error}",
                file.display(),
                destination.display()
            )
        });
    }
}
