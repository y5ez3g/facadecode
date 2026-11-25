use std::path::Path;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("segment-heap.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-bin=facade=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bin=facade=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
