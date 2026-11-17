use std::collections::BTreeMap;

use super::{procargs_environment, variable};

/// Pi setting its process title leaves the original argc and a NUL gap before envp.
/// The fixture preserves the observed layout, with every path and value synthetic.
#[test]
fn a_cli_that_sets_its_process_title_keeps_its_launch_environment() {
    let buffer = include_bytes!("../../tests/fixtures/procargs2-retitled-cli.bin");
    let entries =
        procargs_environment(buffer).expect("the retitled CLI's procargs buffer is readable");
    let env: BTreeMap<_, _> = entries.into_iter().filter_map(variable).collect();

    assert_eq!(
        env.get("FACADE_AGENT").map(String::as_str),
        Some("a999"),
        "the launch identity survives the CLI changing its process title (read {} keys)",
        env.len()
    );
    for (name, value) in [
        ("HOME", "/qa/home"),
        ("PATH", "/usr/bin:/bin"),
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
    ] {
        assert_eq!(env.get(name).map(String::as_str), Some(value), "{name}");
    }
}
