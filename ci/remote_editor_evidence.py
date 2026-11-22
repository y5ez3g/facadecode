"""Record the observed Remote SSH workbench and its disposed Linux guest."""

import argparse
import json
from os import environ
from pathlib import Path
import re
import sys
from uuid import UUID

from catalog import AcceptanceError, NATIVE_REMOTE_EDITOR_CASE, read_json
from evidence import digest, run_identity
from native_core import ROOT, hash_file, read_markers, source_identity, write_receipt


OBSERVATION = 'Facade native SSH connect observation '
FIXTURE = ROOT / 'ci/fixtures/remote-ssh'


def capture_inputs(output, scope, editor):
    if (scope.parent != Path('/tmp') or not re.fullmatch(r'fssh-[A-Za-z0-9]{6}', scope.name)
            or (output / 'scope.path').read_text().splitlines() != [str(scope)]):
        raise AcceptanceError('Remote SSH fixture scope is invalid')
    official = read_json(FIXTURE / 'official-server-linux-x64.json')
    tools = read_json(FIXTURE / 'pinned-marketplace.json')
    assets = {f'vscode-server-linux-x64-{official["name"]}.tar.gz': official['sha256hash']}
    assets.update({f'{tool["id"]}-{tool["version"]}.vsix': tool['sha256'] for tool in tools})
    if {name: hash_file(scope / 'assets' / name) for name in assets} != assets:
        raise AcceptanceError('staged Remote SSH assets do not match the pinned inputs')
    build = ROOT / 'extension/build'
    stage = ('out/test/integration/remote.js', 'out/test/integration/editors.js',
             'out/test/integration/rustMultiWindow.js', 'out/test/integration/rustMultiWindowDriver.js',
             'extension-it/package.json', 'extension-it/dist/extension.js', 'extension-it/dist/webview/webview.js',
             'extension-it/bin/facade', 'extension-it/bin/facade-mcp', 'window/package.json', 'window/dist/window.js')
    return {
        'scope': str(scope), 'source': source_identity(run_identity(None if environ.get('GITHUB_RUN_ID') else scope.name, environ)),
        'guest_id': (output / 'guest.id').read_text().strip(), 'image_id': (output / 'image.id').read_text().strip(),
        'loopback': (output / 'loopback-listener.txt').read_text().strip(),
        'client_key': (output / 'client-fingerprint.txt').read_text().strip(),
        'editor': {'commit': official['version'], 'sha256': hash_file(editor)},
        'assets': assets, 'compiled_sha256': {path: hash_file(build / path) for path in stage},
        'harness_sha256': {path: hash_file(ROOT / path) for path in (
            'ci/check_remote_editor.sh', 'ci/remote_editor_evidence.py', 'ci/fixtures/remote-ssh/Dockerfile',
            'extension/src/test/integration/remote.ts', 'extension/src/test/integration/rustMultiWindowDriver.ts',
        )},
    }


def owned_window(output, inputs):
    scope = Path(inputs['scope'])
    markers = read_markers(output / 'editor.log', OBSERVATION)
    if len(markers) != 1:
        raise AcceptanceError('expected exactly one Remote SSH window observation')
    observed = markers[0]
    if observed['attempt'] != digest(inputs):
        raise AcceptanceError('Remote SSH observation is for a different source, inputs or attempt')
    ready, started, owner = (observed[key] for key in ('ready', 'started', 'owner'))
    cwd = Path(observed['guestCwd'])
    commit = inputs['editor']['commit']
    if (cwd.parent.parent != scope or not cwd.parent.name.startswith('fdrt-') or cwd.name != 'app'
            or ready['folder'] != str(cwd) or ready['home'] != str(cwd.parent / 'facade')
            or Path(observed['hostBinary']) != cwd.parent / 'server/.vscode-server/bin' / commit / 'node'
            or (ready['remote'], ready['platform'], observed['authority'], owner['viewers'])
            != ('ssh-remote', 'linux', 'facade-fixture', ['app [SSH: facade-fixture]'])):
        raise AcceptanceError('the workbench did not own the expected Remote SSH fixture')
    pid, host_pid = started['pid'], ready['hostPid']
    agent = owner['agent']
    if (type(pid) is not int or type(host_pid) is not int or min(pid, host_pid) <= 0 or pid == host_pid
            or observed['starts'] != str(pid) or started['id'] != 'a1'
            or agent != {'agent_id': started['id'], 'machine_id': ready['machineId']}
            or str(UUID(agent['machine_id'])) != agent['machine_id']
            or str(UUID(owner['session'])) != owner['session']
            or (owner['pid'], owner['session'], owner['cwd'], owner['process'])
            != (pid, started['session'], str(cwd), 'running') or started['cwd'] != str(cwd)):
        raise AcceptanceError('the remote Agent, terminal session or sole fake launch did not match')
    return observed


def completed_receipt(output, inputs):
    observed = owned_window(output, inputs)
    identifier, fingerprint, listener = (inputs[key] for key in ('guest_id', 'client_key', 'loopback'))
    sshd = (output / 'sshd.log').read_text().splitlines()
    if (not re.fullmatch(r'[0-9a-f]{64}', identifier) or not re.fullmatch(r'sha256:[0-9a-f]{64}', inputs['image_id'])
            or not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', fingerprint)
            or not re.fullmatch(r'127\.0\.0\.1:[1-9][0-9]{0,4}', listener)
            or sum('Accepted publickey for node ' in line and line.endswith(fingerprint) for line in sshd) < 2):
        raise AcceptanceError('the fixture did not observe real authenticated SSH sessions on the loopback guest')
    if ((output / 'guest-cleanup.log').read_text().splitlines() != [identifier]
            or (output / 'guest-absence.txt').read_text().splitlines() != [identifier]
            or (output / 'cleanup.log').read_text().splitlines()[-1:] != ['no processes left']):
        raise AcceptanceError('Remote SSH guest or local process cleanup did not complete')
    logs = ('editor.log', 'sshd.log', 'guest-build.log', 'guest-cleanup.log', 'guest-absence.txt', 'cleanup.log')
    return {'case': NATIVE_REMOTE_EDITOR_CASE, 'inputs': inputs, 'observation': observed,
            'logs': {file: hash_file(output / file) for file in logs}, 'cleanup': 'pass'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('prepare', 'complete'))
    for argument in ('output', 'scope', 'editor'):
        parser.add_argument(argument, type=Path)
    args = parser.parse_args()
    try:
        inputs = capture_inputs(args.output, args.scope, args.editor)
        frozen = args.scope / 'remote-editor-inputs.json'
        if args.phase == 'prepare':
            write_receipt(frozen, inputs)
            print(digest(inputs))
        else:
            if read_json(frozen) != inputs:
                raise AcceptanceError('Remote SSH inputs changed while the editor was running')
            print(json.dumps(completed_receipt(args.output, inputs), indent=2))
    except (OSError, TypeError, KeyError, ValueError) as error:
        print(f'Remote SSH evidence failed: {error}', file=sys.stderr)
        sys.exit(1)
