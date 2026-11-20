//! The direct transport for a scenario whose machines are isolated Facade homes.

use std::fmt::Write;
use std::path::Path;

use crate::{TestHome, install_script};

/// Installs the SSH substitute for these homes before their daemons start.
/// A destination must name one of the test homes. The fixture runs the tested bootstrap and
/// installed Facade on the original standard streams. It can also serve the actual v2 fixture.
pub fn install_machine_ssh(machines: &[(&str, &TestHome)], facade: &Path) {
    assert!(
        facade.is_absolute(),
        "the SSH fixture needs the tested program"
    );
    let program = shell_path(facade);
    // The remote login shell runs the bootstrap. On Windows it is Git's own MSYS shell: Git's
    // bin\sh.exe is a Windows program, and the script would reach it through a command line that
    // MSYS reads without the script's inner quotes.
    #[cfg(unix)]
    let shell = crate::shell();
    #[cfg(windows)]
    let shell = crate::git_install().join("usr/bin/sh.exe");
    let shell = shell_path(&shell);
    #[cfg(unix)]
    let pause = Path::new("/bin/sleep").to_path_buf();
    #[cfg(windows)]
    let pause = crate::git_install().join("usr/bin/sleep.exe");
    let pause = shell_path(&pause);
    let mut targets = String::new();
    for (destination, home) in machines {
        let path = home.path.to_str().expect("the test home must be UTF-8");
        let encoded_home: String = path
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let target = shell_literal(destination);
        let offline = shell_path(&home.folder().join("ssh-offline"));
        let login = shell_path(&home.folder().join("ssh-needs-login"));
        let password_only = shell_path(&home.folder().join("ssh-password-only"));
        let hold = shell_path(&home.folder().join("ssh-hold"));
        let attempts = shell_path(&home.folder().join("ssh-attempts"));
        let disconnected = shell_literal(&format!(
            "ssh: connect to host {destination}: Connection refused"
        ));
        let installed = home.user_home().join(".local/bin/facade");
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::write(
            &installed,
            format!(
                "#!/bin/sh\nexport PATH=\"$QA_SSH_PROGRAM_PATH\"\nunset QA_SSH_PROGRAM_PATH\nexec {program} \"$@\"\n"
            ),
        )
        .unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(
            &installed,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        writeln!(
            targets,
            "  {target})
    printf '%s %s %s\\n' \"$mode\" \"$port\" \"$entrypoint\" >> {attempts}
    while [ -e {hold} ]; do {pause} 0.05; done
    if [ -e {login} ] || {{ [ -e {password_only} ] && [ \"$mode\" = batch ]; }}; then
      printf '%s\\n' 'Permission denied (publickey).' >&2
      exit 255
    fi
    if [ -e {offline} ]; then
      printf '%s\\n' {disconnected} >&2
      exit 255
    fi
    encoded_home={encoded_home}"
        )
        .unwrap();
        for (name, value) in home.isolating_env() {
            if name != "PATH" {
                writeln!(
                    targets,
                    "    export {name}={}",
                    shell_path(Path::new(&value))
                )
                .unwrap();
            }
        }
        writeln!(
            targets,
            "    export FACADE_HOME={}\n    export FAKECLI_LOG={} ;;",
            shell_path(&home.path),
            shell_path(&home.fake_log)
        )
        .unwrap();
    }
    let script = format!(
        r#"#!/bin/sh
set -eu
mode=interactive
port=default
while [ "$#" -gt 0 ]; do
  case "$1" in
    -T) shift ;;
    -o) [ "$#" -ge 2 ] || exit 64
        [ "$2" != BatchMode=yes ] || mode=batch
        shift 2 ;;
    -p) [ "$#" -ge 2 ] || exit 64; port=$2; shift 2 ;;
    --) shift; break ;;
    -*) printf '%s\n' 'unexpected test SSH option' >&2; exit 64 ;;
    *) break ;;
  esac
done
[ "$#" -ge 1 ] || exit 64
entrypoint=command
[ "$#" -ne 1 ] || entrypoint=login
case "$1" in
{targets}  *) printf '%s\n' 'SSH destination does not name a test machine' >&2; exit 64 ;;
esac
shift
if [ "$#" -eq 5 ] && [ "$1 $2 $3 $4 $5" = "facade machine serve --home-hex $encoded_home" ]; then
  exec {program} machine serve --home-hex "$encoded_home"
fi
# In login mode the first line is the platform probe. The next command may span lines
# in its quoted script. Consume exactly through its verified machine-serve line so the
# bootstrap can read its own decision on this same stdin.
if [ "$#" -eq 0 ]; then
  IFS= read -r probe && [ "$probe" = 'echo "facade-platform-%OS%-$PSHOME"' ] || exit 64
  printf 'QA login\r\nfacade-platform-%%OS%%-\r\n'
  IFS= read -r line || exit 64
  case "$line" in
    'exec sh -c '*) command="$line" ;;
    *) printf '%s\n' 'expected the Unix login bootstrap' >&2; exit 64 ;;
  esac
  while :; do
    case "$line" in
      *' machine serve '*"--home-hex $encoded_home"\'*) break ;;
      *' machine serve '*) printf '%s\n' 'SSH command did not select the isolated Facade home' >&2; exit 64 ;;
    esac
    IFS= read -r line || exit 64
    command="$command
$line"
  done
  case "$command" in
    *facade-bootstrap-begin*) set -- "${{command#exec }}" ;;
    *) printf '%s\n' 'expected the login bootstrap marker' >&2; exit 64 ;;
  esac
fi
[ "$#" -eq 1 ] || exit 64
case "$1" in
  'sh -c '*"--home-hex $encoded_home"*) ;;
  *) printf '%s\n' 'SSH command did not select the isolated Facade home' >&2; exit 64 ;;
esac
# The fixed test installation restores the program PATH. With PATH empty during bootstrap,
# an unexpected download request fails inside the fixture.
export QA_SSH_PROGRAM_PATH="$PATH"
export PATH=
exec {shell} -c "exec {shell} ${{1#sh }}"
"#
    );
    for (_, home) in machines {
        install_script(&home.fixture_bin(), "ssh", &script);
    }
}

fn shell_path(path: &Path) -> String {
    let path = path.to_str().expect("the test SSH path must be UTF-8");
    #[cfg(windows)]
    let path = &path.replace('\\', "/");
    shell_literal(path)
}

fn shell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
