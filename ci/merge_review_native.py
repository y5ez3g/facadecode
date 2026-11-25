"""Replay the native evidence exported by the expanded PR workflows."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import shutil
import subprocess

from catalog import (
    AcceptanceError, NATIVE_INSTALL_CASES, NATIVE_REMOTE_EDITOR_CASE, NATIVE_SSH_CASE,
    RELEASE_FIXTURE_CASES, read_json,
)
from check_keeper_recovery import ARTIFACT as KEEPER_ARTIFACT, CASE as KEEPER_CASE, verify_keeper
from check_native_install import SHA256, verified_install
import check_real_ssh_route as ssh
from evidence import PRIOR_VSIX
from github_evidence import download_artifact
from native_framework import hash_file, read_markers, verify_native_cleanup
import remote_editor_evidence as remote


NATIVE_EDITOR_MINIMUM = 61
RELEASED_CUTOVER_CASES = ('exited', 'live', 'uncertain', 'two-windows', 'prior-owner', 'separate-workspaces')
CUTOVER_TYPED_CASES = (
    'extension/p0/vsix-upgrade/upgrade-pair', 'extension/p0/vsix-upgrade/cutover-live',
    'extension/p0/vsix-upgrade/cutover-uncertain',
)
TYPED_NATIVE_CASES = sorted((*NATIVE_INSTALL_CASES, NATIVE_REMOTE_EDITOR_CASE,
                             NATIVE_SSH_CASE, KEEPER_CASE, *CUTOVER_TYPED_CASES))


def file_digests(recorded, names):
    return recorded.keys() == set(names) and all(SHA256.fullmatch(sha) for sha in recorded.values())


def check_ssh(folder, source):
    receipt = read_json(folder / 'receipt.json')
    verify_native_cleanup(receipt)
    if (receipt['source'] != source or not file_digests(receipt['program_sha256'], ssh.PROGRAMS)
            or receipt['success'] != ssh.ssh_success(receipt)
            or read_markers(folder / 'console.log', ssh.SUCCESS_MARKER) != [receipt['success']]):
        raise AcceptanceError('native Framework SSH receipt does not match the original route and attempt')
    return NATIVE_SSH_CASE


def check_remote(root, folder, source):
    receipt = read_json(folder / 'receipt.json')
    inputs = receipt['inputs']
    commit, assets = remote.pinned_assets()
    if (inputs['source'] != source or inputs['assets'] != assets or inputs['editor']['commit'] != commit
            or not SHA256.fullmatch(inputs['editor']['sha256'])
            or not file_digests(inputs['compiled_sha256'], remote.COMPILED)
            or inputs['harness_sha256'] != {name: hash_file(root / name) for name in remote.HARNESS}
            or receipt != remote.completed_receipt(folder, inputs)):
        raise AcceptanceError('native Remote SSH receipt does not match the original editor and cleanup')
    return NATIVE_REMOTE_EDITOR_CASE


def editor_passes(path):
    log = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', path.read_text())
    counts = [int(count) for count in re.findall(r'^\s*(\d+) passing\b', log, re.M)]
    if (not counts or min(counts) < 1 or sum(counts) < NATIVE_EDITOR_MINIMUM
            or re.search(r'^\s*[1-9][0-9]* failing\b', log, re.M)
            or log.count('Isolated editor profile cleanup finished.') != 1):
        raise AcceptanceError(f'{path}: absent, failed or incomplete native editor journeys')
    return sum(counts)


def check_published_cutover(folder, version, candidate):
    expected = {
        'prior': {name: sha for name, (_, sha) in PRIOR_VSIX.items()},
        'candidate': {p.name: hash_file(p) for p in sorted(candidate.glob('*.vsix'))},
    }
    if len(expected['candidate']) != 2 or read_json(folder / 'packages.json') != expected:
        raise AcceptanceError('the cutover used a different prior or candidate pair')
    for variant in RELEASED_CUTOVER_CASES:
        path = folder / f'{variant}.log'
        lines = path.read_text().splitlines()
        reports = [json.loads(line.removeprefix('Facade acceptance test '))
                   for line in lines if line.startswith('Facade acceptance test ')]
        passed = any(line.strip().startswith(f'✔ legacy cutover ({variant}) from 0.1.5 to {version}: ') for line in lines)
        if (not passed or reports != [{'name': f'cutover-{variant}', 'implementation': 'framework'}]
                or lines.count('Isolated editor profile cleanup finished.') != 1):
            raise AcceptanceError(f'{path}: absent, failed or incomplete published cutover evidence')
    return CUTOVER_TYPED_CASES


def verify_node_evidence(root, script, folder, source, *arguments):
    node = shutil.which('node')
    if node is None:
        raise AcceptanceError('Node is needed to verify the reviewed release and package evidence')
    result = subprocess.run([
        node, str(root / 'extension/scripts' / script), 'verify', str(folder),
        '--revision', source['revision'], '--tree', source['tree'],
        '--run', source['run'].split('/')[1], '--attempt', '1', *arguments,
    ], cwd=root, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, check=True,
       stdout=subprocess.PIPE, text=True, timeout=180)
    return result.stdout


def replay_native(root, repo, candidate, records, output):
    output.mkdir()
    packages = output / 'packages'
    packages.mkdir()
    with ThreadPoolExecutor(max_workers=4) as workers:
        downloads = {
            name: workers.submit(download_artifact, repo, record,
                                 packages if re.fullmatch(r'extension-(linux|darwin|win32)-(x64|arm64)', name)
                                 else output, name)
            for name, record in records.items()
        }
        paths = {name: download.result() for name, download in downloads.items()}

    def source(name):
        run = records[name]['workflow_run']['id']
        return {'revision': candidate['merge'], 'tree': candidate['tree'], 'run': f'github/{run}/1'}

    observed = []
    name = 'framework-ssh-route-1'
    observed.append(check_ssh(paths[name], source(name)))
    programs = read_json(paths[name] / 'receipt.json')['program_sha256']
    name = f'{KEEPER_ARTIFACT}-1'
    observed.append(verify_keeper(paths[name], read_json(paths[name] / 'receipt.json'), source(name),
                                  program_sha256=programs))
    name = 'extension-remote-ssh-1'
    observed.append(check_remote(root, paths[name], source(name)))

    if (paths['tested-extension-tree'] / 'extension-tested-tree.txt').read_text().splitlines() != [candidate['tree']]:
        raise AcceptanceError('the native Extension jobs reported a different tested tree')
    version = read_json(root / 'extension/package.json')['version']
    verify_node_evidence(root, 'native-package-evidence.mjs', packages, source('tested-extension-tree'),
                         '--version', version)
    name = 'release-fixture-linux-x64-1'
    release = json.loads(verify_node_evidence(root, 'release-fixture-evidence.mjs', paths[name], source(name)))
    if set(release['cases']) != set(RELEASE_FIXTURE_CASES):
        raise AcceptanceError('the release fixture does not cover the expected release contracts')
    name = 'native-install-linux-x64-1'
    install, package = paths[name], packages / 'extension-linux-x64/framework'
    sidecar = install / 'SHA256SUMS'
    if sidecar.read_bytes() != (package / 'SHA256SUMS').read_bytes():
        raise AcceptanceError('the installed candidate checksum differs from the tested package set')
    project = repo.split('/')[1]
    installed_source = source(name)
    verified_install(package / 'facade-framework-linux-x64.tar.gz', sidecar, install / 'receipt.json',
                     install / 'output.log', installed_source['run'], source=installed_source,
                     producer_checkout=Path('/home/runner/work') / project / project)
    observed.extend(NATIVE_INSTALL_CASES)
    observed.extend(check_published_cutover(paths['published-cutover-linux-x64'], version,
                                           packages / 'extension-linux-x64/vsix'))

    return {
        'typed_cases': sorted(observed),
        'release_fixture_cases': sorted(release['cases']),
        'package_targets': sum(path.is_dir() for path in packages.iterdir()),
        'editor_passes': {name: editor_passes(path / 'integration.log') for name, path in sorted(paths.items())
                          if name.startswith('editor-tests-')},
    }
