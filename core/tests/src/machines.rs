//! The direct transport for a scenario whose machines are isolated Facade homes.

use std::fmt::Write;
use std::path::Path;

use facade_base::ssh::{SshMode, machine_ssh_args};

use crate::{TestHome, install_script};

/// Installs the SSH substitute for these homes before their daemons start.
/// Each destination must be called with its explicit home. The substitute runs the tested
/// facade's `machine serve` on the original stdin, stdout, and stderr.
pub fn install_machine_ssh(machines: &[(&str, &TestHome)], facade: &Path) {
    let mut targets = String::new();
    for (destination, home) in machines {
        let path = home.path.to_str().expect("the test home must be UTF-8");
        let args = machine_ssh_args(destination, Some(path), SshMode::Connect, None)
            .expect("the test machine must have a valid destination and home");
        let encoded_home = args.last().unwrap().to_str().unwrap();
        let target = shell_literal(&format!("{destination}:{encoded_home}"));
        let offline = home.folder().join("ssh-offline");
        let offline = shell_literal(offline.to_str().expect("the test home must be UTF-8"));
        let login = home.folder().join("ssh-needs-login");
        let login = shell_literal(login.to_str().expect("the test home must be UTF-8"));
        writeln!(
            targets,
            "  {target})
    if [ -e {login} ]; then
      printf '%s\\n' 'Permission denied (publickey).' >&2
      exit 255
    fi
    [ ! -e {offline} ] || exit 255 ;;"
        )
        .unwrap();
    }
    let facade = shell_literal(
        facade
            .to_str()
            .expect("the test program path must be UTF-8"),
    );
    let script = format!(
        r#"#!/bin/sh
set -eu
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
  shift
done
if [ "$#" -ne 7 ] || [ "$3 $4 $5 $6" != 'facade machine serve --home-hex' ]; then
  printf '%s\n' 'expected an explicit machine serve home' >&2
  exit 64
fi
case "$2:$7" in
{targets}  *) printf '%s\n' 'SSH destination and home do not name a test machine' >&2; exit 64 ;;
esac
exec {facade} machine serve --home-hex "$7"
"#
    );
    for (_, home) in machines {
        install_script(&home.fixture_bin(), "ssh", &script);
    }
}

fn shell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
