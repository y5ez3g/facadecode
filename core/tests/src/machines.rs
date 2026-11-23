//! The direct transport for a scenario whose machines are isolated Facade homes.

use std::fmt::Write;
use std::path::Path;

use crate::{TestHome, install_script};

/// Installs the SSH substitute for these homes before their daemons start.
/// A destination must name one of the test homes. The fixture runs the tested bootstrap and
/// installed Facade on the original standard streams. It can also serve the actual v2 fixture.
pub fn install_machine_ssh(machines: &[(&str, &TestHome)], facade: &Path) {
    let programs: Vec<_> = machines
        .iter()
        .map(|&(destination, home)| (destination, home, facade))
        .collect();
    install_machine_ssh_with_programs(&programs);
}

/// As [`install_machine_ssh`], selecting the installed program independently for each machine.
pub fn install_machine_ssh_with_programs(machines: &[(&str, &TestHome, &Path)]) {
    // The remote login shell runs the bootstrap. On Windows it is Git's own MSYS shell: Git's
    // bin\sh.exe is a Windows program, and the script would reach it through a command line that
    // MSYS reads without the script's inner quotes.
    #[cfg(unix)]
    let shell = crate::shell();
    #[cfg(windows)]
    let shell = crate::git_install().join("usr/bin/sh.exe");
    let utilities = shell_path(shell.parent().unwrap());
    let shell = shell_path(&shell);
    #[cfg(unix)]
    let pause = Path::new("/bin/sleep").to_path_buf();
    #[cfg(windows)]
    let pause = crate::git_install().join("usr/bin/sleep.exe");
    let pause = shell_path(&pause);
    #[cfg(unix)]
    let keygen = Path::new("/usr/bin/ssh-keygen").to_path_buf();
    #[cfg(windows)]
    let keygen = crate::git_install().join("usr/bin/ssh-keygen.exe");
    let keygen = shell_path(&keygen);
    let mut targets = String::new();
    let mut sources = String::new();
    for (index, &(destination, home, facade)) in machines.iter().enumerate() {
        assert!(
            facade.is_absolute() && facade.is_file(),
            "the SSH fixture needs the tested program: {}",
            facade.display()
        );
        let program = shell_path(facade);
        let path = home.path.to_str().expect("the test home must be UTF-8");
        #[cfg(unix)]
        let unix_home = path.to_owned();
        #[cfg(windows)]
        let unix_home = format!(
            "/{}{}",
            path[..1].to_ascii_lowercase(),
            path[2..].replace('\\', "/")
        );
        let encoded_home: String = path
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let target = shell_literal(destination);
        let ip = shell_literal(&format!("192.0.2.{}", index + 1));
        let source = shell_literal(path);
        let known_hosts = shell_path(&home.user_home().join(".ssh/known_hosts"));
        writeln!(
            sources,
            "  {source}) source_ip={ip}; source_known_hosts={known_hosts} ;;"
        )
        .unwrap();
        let offline = shell_path(&home.folder().join("ssh-offline"));
        let login = shell_path(&home.folder().join("ssh-needs-login"));
        let password_only = shell_path(&home.folder().join("ssh-password-only"));
        let hold = shell_path(&home.folder().join("ssh-hold"));
        let attempts = shell_path(&home.folder().join("ssh-attempts"));
        let serves = shell_path(&home.folder().join("ssh-serves"));
        let wrong_key = shell_path(&home.folder().join("ssh-proof-other-key"));
        let existing_key = shell_path(&home.folder().join("existing-login-key.pub"));
        let account_keys = shell_path(&home.user_home().join(".ssh/authorized_keys"));
        let administrator_keys = shell_path(
            &home
                .user_home()
                .join("ProgramData/ssh/administrators_authorized_keys"),
        );
        let host_keys = shell_path(&home.folder().join("ssh-host-keys"));
        let return_host_key =
            shell_path(&home.folder().join("ssh-host-keys/ssh_host_ed25519_key.pub"));
        let disconnected = shell_literal(&format!(
            "ssh: connect to host {destination}: Connection refused"
        ));
        let shim = format!("#!/bin/sh\nexport FACADE_HOME={source}\nexec {program} \"$@\"\n");
        for installed in [
            home.user_home().join(".local/bin/facade"),
            home.path.join("core/bin/facade"),
        ] {
            if installed.exists() {
                continue;
            }
            std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
            std::fs::write(&installed, &shim).unwrap();
            #[cfg(unix)]
            std::fs::set_permissions(
                &installed,
                std::os::unix::fs::PermissionsExt::from_mode(0o755),
            )
            .unwrap();
        }
        install_script(
            &home.fixture_bin(),
            "curl",
            "#!/bin/sh\necho 'The SSH fixture has no download' >&2\nexit 64\n",
        );
        let unix_home = shell_literal(&unix_home);
        let fixture_bin = shell_path(&home.fixture_bin());
        writeln!(
            targets,
            "  {target}|*@{target}|{ip}|*@{ip})
    if [ \"$effective_config\" = yes ]; then
      if [ \"$port\" = default ]; then port=22; fi
      test -n \"$source_known_hosts\"
      printf 'hostname %s\\nport %s\\nuserknownhostsfile %s\\nhashknownhosts false\\n' \"${{1#*@}}\" \"$port\" \"$source_known_hosts\"
      exit 0
    fi
    printf '%s %s %s\\n' \"$mode\" \"$port\" \"$entrypoint\" >> {attempts}
    while [ -e {hold} ]; do {pause} 0.05; done
    [ ! -e {login} ] || denied
    case \"$1\" in
      {ip}|*@{ip}) if [ -f {return_host_key} ]; then
        check_native_trust {ip} {return_host_key}
      fi ;;
    esac
    if [ -n \"$identity\" ]; then
      proof_key=\"$identity.pub\"
      if [ -e {wrong_key} ]; then proof_key={existing_key}; fi
      check_key \"$1\" {account_keys} {administrator_keys}
    elif [ -e {password_only} ] && [ \"$mode\" = batch ]; then
      denied
    fi
    if [ -e {offline} ]; then
      printf '%s\\n' {disconnected} >&2
      exit 255
    fi
    encoded_home={encoded_home}
    native_home={source}
    unix_home={unix_home}
    fixture_bin={fixture_bin}
    program={program}
    serves={serves}
    target_ip={ip}
    export FACADE_TEST_SSH_HOST_KEYS={host_keys}"
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
source_ip=
source_known_hosts=
source_home=$FACADE_HOME
case "$source_home" in
{sources}esac
mode=interactive
port=default
effective_config=no
identity=
proof=
identities_only=no
identity_agent=default
strict_host=no
fresh=no
denied() {{
  printf '%s\n' 'Permission denied (publickey).' >&2
  exit 255
}}
check_native_trust() {{
  host=$1
  IFS=' ' read -r key_type key_blob rest < "$2"
  if [ -f "$source_known_hosts" ]; then
    while IFS=' ' read -r candidate_host candidate_type candidate_blob rest; do
      if [ "$candidate_host" = "$host" ] && [ "$candidate_type" = "$key_type" ] && [ "$candidate_blob" = "$key_blob" ]; then
        return 0
      fi
    done < "$source_known_hosts"
  fi
  printf '%s\n' "No ED25519 host key is known for $host and you have requested strict checking." 'Host key verification failed.' >&2
  exit 255
}}
check_key() {{
  destination=$1
  shift
  [ "$mode" = batch ] && [ "$identities_only" = yes ] && [ "$identity_agent" = none ] && [ "$strict_host" = yes ] || exit 64
  case "$identity" in
    "$source_home"/*|"$source_home"\\*) ;;
    *) printf '%s\n' 'test SSH identity must stay inside the initiating Facade home' >&2; exit 64 ;;
  esac
  IFS=' ' read -r key_type key_blob rest < "$identity.pub" || denied
  accepted=no
  for keys do
    [ -f "$keys" ] || continue
    while IFS=' ' read -r candidate_type candidate_blob rest; do
      if [ "$candidate_type" = "$key_type" ] && [ "$candidate_blob" = "$key_blob" ]; then
        accepted=yes
      fi
    done < "$keys"
  done
  [ "$accepted" = yes ] || denied
  if [ -n "$proof" ]; then
    [ "$fresh" = yes ] || exit 64
    case "$proof" in
      "$source_home"/*|"$source_home"\\*) ;;
      *) printf '%s\n' 'test SSH proof must stay inside the initiating Facade home' >&2; exit 64 ;;
    esac
    fingerprint=$({keygen} -l -E sha256 -f "$proof_key")
    fingerprint=${{fingerprint#* }}
    fingerprint=${{fingerprint%% *}}
    printf '%s\n' "debug3: sign_and_send_pubkey: signing using ssh-ed25519 $fingerprint" \
      'debug3: send packet: type 50' 'debug3: receive packet: type 52' \
      "Authenticated to $destination using \"publickey\"." > "$proof"
  fi
}}
while [ "$#" -gt 0 ]; do
  case "$1" in
    -T|-v|-vv|-vvv) shift ;;
    -G) effective_config=yes; shift ;;
    -o) [ "$#" -ge 2 ] || exit 64
        case "$2" in
          BatchMode=yes) mode=batch ;;
          IdentitiesOnly=yes) identities_only=yes ;;
          IdentityAgent=none) identity_agent=none ;;
          StrictHostKeyChecking=yes) strict_host=yes ;;
          ControlPath=none) fresh=yes ;;
        esac
        shift 2 ;;
    -p) [ "$#" -ge 2 ] || exit 64; port=$2; shift 2 ;;
    -i) [ "$#" -ge 2 ] || exit 64; identity=$2; shift 2 ;;
    -E) [ "$#" -ge 2 ] || exit 64; proof=$2; shift 2 ;;
    -S) [ "$#" -ge 2 ] || exit 64; [ "$2" != none ] || fresh=yes; shift 2 ;;
    -b|-F) [ "$#" -ge 2 ] || exit 64; shift 2 ;;
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
if [ -n "$source_ip" ]; then export SSH_CONNECTION="$source_ip 22222 $target_ip 22"; fi
shift
if [ "$#" -eq 5 ] && [ "$1 $2 $3 $4 $5" = "facade machine serve --home-hex $encoded_home" ]; then
  printf '%s\n' wake >> "$serves"
  exec "$program" machine serve --home-hex "$encoded_home"
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
      *'exec "$program" machine serve'*|*'exec "$program" machine ssh-admin'*) break ;;
      *' machine serve '*"--home-hex $encoded_home"\'*|*' machine ssh-admin '*"--home-hex $encoded_home"\'*) break ;;
      *' machine serve '*|*' machine ssh-admin --home-hex '*) printf '%s\n' 'SSH command did not select the isolated Facade home' >&2; exit 64 ;;
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
  'sh -c '*"--home-hex $encoded_home"*|'sh -c '*'program="$FACADE_HOME/core/bin/facade"'*) ;;
  *) printf '%s\n' 'SSH command did not select the isolated Facade home' >&2; exit 64 ;;
esac
case "$1" in
  *' machine serve --no-start'*) printf '%s\n' no-start >> "$serves" ;;
  *' machine serve'*) printf '%s\n' wake >> "$serves" ;;
  *' machine ssh-admin'*) printf '%s\n' admin >> "$serves" ;;
esac
# Keep the bootstrap's utilities available and put the fixture's curl refusal first.
export PATH="$fixture_bin":{utilities}:"$PATH"
case "$1" in
  *'program="$FACADE_HOME/core/bin/facade"'*)
    # Unpack the generated sh -c words. The fixture simulates a Unix login on Windows too.
    eval "set -- $1"
    script=$3
    shift 3
    [ "$1" = facade-install ] || exit 64
    case "$2" in
      ''|"$native_home"|"$unix_home") ;;
      *) printf '%s\n' 'SSH command did not select the isolated Facade home' >&2; exit 64 ;;
    esac
    shift 2
    export FACADE_HOME="$unix_home"
    exec {shell} -c "$script" facade-install "$unix_home" "$@"
    ;;
  *) exec {shell} -c "exec {shell} ${{1#sh }}" ;;
esac
"#
    );
    for (_, home, _) in machines {
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
