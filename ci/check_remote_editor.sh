#!/usr/bin/env bash
set -euo pipefail

stage=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
fixture="$stage/ci/fixtures/remote-ssh"
if [[ $# != 3 || ! -x "$2" || $(uname -sm) != 'Linux x86_64' ]]; then
  echo "Usage on Linux x64: check_remote_editor.sh ASSET_DIR OFFICIAL_VSCODE_EXECUTABLE NEW_OUTPUT_DIR" >&2
  exit 2
fi
inputs=$(realpath -e -- "$1")
editor=$(realpath -e -- "$2")
attempt=$(realpath -m -- "$3")
mkdir -- "$attempt"
for input in ci/evidence.py core/scripts/leftovers.sh extension/build/out/test/integration/remote.js extension/build/extension-it/package.json extension/build/window/package.json; do
  if [[ ! -f "$stage/$input" ]]; then
    printf 'Build the editor fixtures first. Missing %s\n' "$input" >&2
    exit 2
  fi
done
scope=$(mktemp -d /tmp/fssh-XXXXXX)
chmod 700 "$scope"
docker=(docker -H unix:///var/run/docker.sock)
guest=''
guest_name=${scope##*/}
guest_requested=false
guest_clean=true
cleanup() {
  local status=$?
  trap - EXIT
  if "$guest_requested"; then
    local remaining
    if ! remaining=$("${docker[@]}" ps -aq --no-trunc --filter "name=^/$guest_name$" \
      --filter label=org.facadecode.fixture=remote-ssh-test); then
      guest_clean=false
    elif [[ -n "$remaining" ]]; then
      if [[ "$remaining" =~ ^[0-9a-f]{64}$ && ( -z "$guest" || "$guest" == "$remaining" ) ]]; then
        "${docker[@]}" logs "$remaining" > "$attempt/sshd.log" 2>&1 || status=1
        "${docker[@]}" rm -f "$remaining" > "$attempt/guest-cleanup.log" 2>&1 || guest_clean=false
        local removed=$remaining
        if ! remaining=$("${docker[@]}" ps -aq --filter "id=$removed") || [[ -n "$remaining" ]]; then
          guest_clean=false
        else
          printf '%s\n' "$removed" > "$attempt/guest-absence.txt"
        fi
      else
        guest_clean=false
      fi
    elif [[ "$status" == 0 ]]; then
      status=1
    fi
  fi
  "$guest_clean" || status=1
  if ! env -u TMPDIR -u CI_ACCEPTANCE_ROOT -u XDG_RUNTIME_DIR python3 -B - "$stage" "$scope" "$status" "$editor" > "$attempt/cleanup.log" 2>&1 <<'PY'
import os
from pathlib import Path
import sys
root, scope, status = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
sys.path.insert(0, str(root / 'ci'))
from evidence import clean_scope
editor = Path(sys.argv[4])
passed = clean_scope(root, scope, os.environ.copy(), sys.stdout, status != 0, editor=editor)
raise SystemExit(0 if passed == 'pass' else 1)
PY
  then
    printf 'Kept fixture scope %s after cleanup failure.\n' "$scope" >&2
    exit 1
  fi
  if ! "$guest_clean"; then
    printf 'Kept fixture scope %s because Docker did not establish guest removal.\n' "$scope" >&2
    exit 1
  fi
  if [[ "$status" == 0 ]]; then
    if ! python3 -B "$stage/ci/remote_editor_evidence.py" complete "$attempt" "$scope" "$editor" \
      > "$attempt/receipt.json.tmp"; then
      status=1
      rm -f -- "$attempt/receipt.json.tmp"
    fi
  fi
  rm -r -- "$scope"
  if [[ "$status" == 0 ]]; then
    mv -- "$attempt/receipt.json.tmp" "$attempt/receipt.json"
    printf 'Remote SSH connect passed after guest and process cleanup (%s)\n' "$(sha256sum "$attempt/receipt.json" | cut -d ' ' -f 1)"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
printf '%s\n' "$scope" > "$attempt/scope.path"
assets="$scope/assets"
mkdir "$assets"
server="$assets/vscode-server-linux-x64-1.147.0.tar.gz"
cp --reflink=auto "$inputs/${server##*/}" "$server"
[[ -s "$server" ]]
expected=$(jq -er .sha256hash "$fixture/official-server-linux-x64.json")
printf '%s  %s\n' "$expected" "$server" | sha256sum --check | tee "$attempt/server-sha.log"
while IFS=$'\t' read -r id version expected; do
  cp --reflink=auto "$inputs/$id-$version.vsix" "$assets/$id-$version.vsix"
  printf '%s  %s\n' "$expected" "$assets/$id-$version.vsix"
done < <(jq -r '.[]|[.id,.version,.sha256]|@tsv' "$fixture/pinned-marketplace.json") | sha256sum --check | tee "$attempt/vsix-sha.log"
node - "$stage" "$editor" <<'JS'
const { editorBuildCommit } = require(process.argv[2] + '/extension/build/out/test/integration/editors.js');
if (editorBuildCommit(process.argv[3], '1.147.0') !== '8a14f0cc1b08d531eb83255ea3764ae22aa932b5') {
  throw new Error('The VS Code desktop build does not match the pinned server.');
}
JS
mkdir "$scope/build" "$scope/keys" "$scope/runtime"
chmod 700 "$scope/runtime"
cp "$fixture/Dockerfile" "$scope/build/"
timeout --kill-after=10s 260s "${docker[@]}" build --label org.facadecode.fixture=remote-ssh-test \
  --iidfile "$scope/image.id" -f "$scope/build/Dockerfile" "$scope/build" > "$attempt/guest-build.log" 2>&1
printf '%s\n' "$(cat "$scope/image.id")" > "$attempt/image.id"

for key in client host; do
  /usr/bin/ssh-keygen -q -t ed25519 -N '' -f "$scope/keys/$key"
done
cp "$scope/keys/client.pub" "$scope/keys/authorized_keys"
/usr/bin/ssh-keygen -lf "$scope/keys/client.pub" | awk '{print $2}' > "$attempt/client-fingerprint.txt"
cat > "$scope/keys/sshd_config" <<'CONFIG'
Port 2222
ListenAddress 0.0.0.0
HostKey /fixture/keys/host
PidFile /run/sshd-fixture.pid
AuthorizedKeysFile /fixture/keys/authorized_keys
StrictModes no
PermitRootLogin no
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowUsers node
AllowTcpForwarding local
PermitOpen 127.0.0.1:* localhost:* [::1]:*
GatewayPorts no
PermitUserRC no
PermitUserEnvironment no
AllowAgentForwarding no
X11Forwarding no
PrintMotd no
PrintLastLog no
LogLevel VERBOSE
CONFIG
guest_requested=true
guest=$("${docker[@]}" run -d --name "$guest_name" --label org.facadecode.fixture=remote-ssh-test \
  --publish 127.0.0.1::2222 \
  --mount "type=bind,src=$scope/keys,dst=/fixture/keys,readonly" \
  --mount "type=bind,src=$server,dst=/fixture/vscode-server.tar.gz,readonly" \
  --mount "type=bind,src=$stage/extension/build,dst=/opt/facade/build,readonly" \
  "$(cat "$scope/image.id")" /usr/sbin/sshd -D -e -f /fixture/keys/sshd_config)
printf '%s\n' "$guest" > "$attempt/guest.id"
"${docker[@]}" exec "$guest" install -d -m 0700 -o node -g node -- "$scope"
port=$("${docker[@]}" port "$guest" 2222/tcp)
[[ "$port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]
port=${BASH_REMATCH[1]}
printf '127.0.0.1:%s\n' "$port" > "$attempt/loopback-listener.txt"
printf '[127.0.0.1]:%s %s\n' "$port" "$(cut -d ' ' -f 1-2 "$scope/keys/host.pub")" > "$scope/known_hosts"
cat > "$scope/ssh_config" <<CONFIG
Host facade-fixture
    HostName 127.0.0.1
    Port $port
    User node
    IdentityFile $scope/keys/client
    IdentitiesOnly yes
    IdentityAgent none
    UserKnownHostsFile $scope/known_hosts
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    BatchMode yes
    ConnectTimeout 3
CONFIG
for _ in 1 2 3; do
  if /usr/bin/ssh -F "$scope/ssh_config" facade-fixture \
    'printf "%s\n" "$HOME"; uname -sm; /usr/local/bin/node --version; git --version; test -r /fixture/vscode-server.tar.gz' > "$attempt/guest-preflight.log" 2>&1; then break; fi
  sleep 1
done
grep -Fx 'Linux x86_64' "$attempt/guest-preflight.log"
grep -Fx 'v24.18.0' "$attempt/guest-preflight.log"
grep -Fx '/home/node' "$attempt/guest-preflight.log"

while IFS= read -r key; do
  unset "$key"
done < <(compgen -e FACADE_IT_ || true)
unset WAYLAND_DISPLAY WAYLAND_SOCKET SSH_AUTH_SOCK
export TMPDIR="$scope" XDG_RUNTIME_DIR="$scope/runtime" CI_ACCEPTANCE_ROOT="$scope"
export XDG_SESSION_TYPE=x11 ELECTRON_OZONE_PLATFORM_HINT=x11
export VSCODE_EXECUTABLE="$editor" FACADE_IT_ENGINE=rust FACADE_IT_ONLY=ssh-connect
export FACADE_IT_REMOTE_ROOT="$scope" FACADE_IT_SSH_HOST=facade-fixture FACADE_IT_SSH_CONFIG="$scope/ssh_config"
export FACADE_IT_REMOTE_EXTENSION=/opt/facade FACADE_IT_REMOTE_SERVER_TAR=/fixture/vscode-server.tar.gz
FACADE_IT_REMOTE_VSIXS=$(jq -r --arg assets "$assets" 'map($assets + "/" + .id + "-" + .version + ".vsix") | join(",")' "$fixture/pinned-marketplace.json")
FACADE_IT_REMOTE_ATTEMPT=$(python3 -B "$stage/ci/remote_editor_evidence.py" prepare "$attempt" "$scope" "$editor")
export FACADE_IT_REMOTE_VSIXS FACADE_IT_REMOTE_ATTEMPT
(cd "$stage/extension" && timeout --kill-after=10s 300s xvfb-run -a node build/out/test/integration/remote.js) \
  2>&1 | tee "$attempt/editor.log"
[[ $(grep -c '^Facade native SSH connect observation ' "$attempt/editor.log") == 1 ]]
