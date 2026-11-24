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
from github_evidence import download_artifact
from native_framework import hash_file, read_markers, verify_native_cleanup
import remote_editor_evidence as remote


NATIVE_EDITOR_MINIMUM = 61
LEGACY_WINDOW_GRACE_CASE = 'extension/p0/pin-reload/legacy-last-window-grace'
TYPED_NATIVE_CASES = sorted((*NATIVE_INSTALL_CASES, NATIVE_REMOTE_EDITOR_CASE,
                             NATIVE_SSH_CASE, KEEPER_CASE, LEGACY_WINDOW_GRACE_CASE))
LEGACY_IMMEDIATE_REOPEN = '✔ claude: real window close and immediate reopen preserve Pin, exact session and process, with one terminal: '
LEGACY_EXPIRED_REOPEN = '✔ claude: real window close and reopen after its grace restore the exact pinned session in a new process, with one terminal: '
LEGACY_NATURAL_EXIT = re.compile(r"✔ claude: the closed window's process ended after (\d+) ms, using the production grace period")


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


def check_legacy_window_grace(path):
    lines = path.read_text().splitlines()
    immediate = [(index, line.strip().removeprefix(LEGACY_IMMEDIATE_REOPEN)) for index, line in enumerate(lines)
                 if line.strip().startswith(LEGACY_IMMEDIATE_REOPEN)]
    expired = [(index, line.strip().removeprefix(LEGACY_EXPIRED_REOPEN)) for index, line in enumerate(lines)
               if line.strip().startswith(LEGACY_EXPIRED_REOPEN)]
    natural_exit = [(index, int(match[1])) for index, line in enumerate(lines)
                    if (match := LEGACY_NATURAL_EXIT.fullmatch(line.strip()))]
    cleanup = [index for index, line in enumerate(lines) if line.strip() == 'Isolated editor profile cleanup finished.']
    if not all(len(events) == 1 for events in (immediate, expired, natural_exit, cleanup)):
        raise AcceptanceError(f'{path}: missing or duplicate legacy window grace observations or cleanup')
    if (not immediate[0][0] < natural_exit[0][0] < expired[0][0] < cleanup[0] or natural_exit[0][1] < 60_000):
        raise AcceptanceError(f'{path}: legacy window grace did not end naturally between the two reopens')
    try:
        for keep_process, (_, payload) in ((True, immediate[0]), (False, expired[0])):
            records = json.loads(payload)
            if not isinstance(records, list) or len(records) != 3:
                raise AcceptanceError(f'{path}: invalid legacy window grace transcript')
            before, closed, after = records
            if ([item['phase'] for item in (before, closed, after)] != ['folder', 'closed', 'reopened']
                    or not all(type(pid) is int and pid > 0 for pid in (before['pid'], closed['host'], after['pid']))
                    or not all(re.fullmatch(r'run-[0-9a-f]{32}', item['runId']) for item in (before, after))
                    or not isinstance(before['session'], str) or not before['session']
                    or before['session'] != after['session'] or type(after['terminals']) is not int
                    or after['terminals'] != 1 or (before['pid'] == after['pid']) != keep_process
                    or (before['runId'] == after['runId']) != keep_process):
                raise AcceptanceError(f'{path}: wrong process, run or pinned session after legacy window close')
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise AcceptanceError(f'{path}: invalid legacy window grace transcript') from error
    return LEGACY_WINDOW_GRACE_CASE


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
    observed.append(check_legacy_window_grace(paths['editor-tests-linux-x64-legacy'] / 'integration.log'))

    return {
        'typed_cases': sorted(observed),
        'release_fixture_cases': sorted(release['cases']),
        'package_targets': sum(path.is_dir() for path in packages.iterdir()),
        'editor_passes': {name: editor_passes(path / 'integration.log') for name, path in sorted(paths.items())
                          if name.startswith('editor-tests-')},
    }
