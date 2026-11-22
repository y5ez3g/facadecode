from copy import deepcopy
from hashlib import sha256
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from catalog import AcceptanceError, NATIVE_INSTALL_CASES
from check_native_install import ASSET, REFUSALS, SUCCESS_MARKER, corrupted_archive, install_success, installer_args, verified_install
from evidence import digest
from native_core import hash_file, source_identity


def installed_observation(source, archive_sha, sidecar_sha, version, programs, corrupt_sha):
    scope = '/tmp/fci-install-policy-fixture'
    target = 'a1@fixture-host'
    cwd = scope + '/project'
    executable = f'{scope}/state/core/bin/{version}/facade'
    machine = 'e3969844-767b-4587-a5c6-08835541efd5'
    runtime = {
        'reference': {'machine_id': machine, 'agent_id': 'a1'}, 'address': target, 'cwd': cwd,
        'fake': {'pid': 3, 'start_ticks': 30, 'executable': scope + '/fixture-bin/facade-fakecli'},
        'services': {name: {'pid': pid, 'start_ticks': 20, 'executable': executable}
                     for name, pid in (('daemon', 1), ('keeper', 2))},
        'durable_machine': [[machine, 'fixture-host']],
        'durable_agents': [['a1', 'installed-agent', 'qa-install', cwd, 3, 'time', None]],
    }
    tree = {'share/facade/current': [511, 'link', f'versions/{version}']}
    for name, program in programs.items():
        tree[f'bin/{name}'] = [511, 'link', f'../share/facade/current/{name}']
        tree[f'share/facade/versions/{version}/{name}'] = [493, 'file', program]
    settings_sha = 'c' * 64
    stable = digest({'install_tree': tree, 'runtime': runtime, 'settings_sha256': settings_sha})
    commands = []
    shell = scope + '/install/bin/facade'
    installer = Path(__file__).resolve().parents[1] / 'core/install.sh'

    def record(label, args, stdout='', stderr='', status=0):
        commands.append({'label': label, 'args': args, 'status': status, 'stdout': stdout, 'stderr': stderr})

    def install(stage):
        return installer_args(installer, f'{scope}/{stage}/{ASSET}', f'{scope}/install', version)

    record('install candidate', install('candidate'), f'Installed Facade {version}\n')
    record('installed Shell version', [shell, '--version'], f'facade {version}\n')
    record('start fake CLI', [shell, 'start', '-d', '--name', 'installed-agent', '--workdir',
                              cwd, 'qa-install', '--', 'candidate argument'],
           f'Started installed-agent ({target}) in the background.\n')
    screen = [shell, 'screen', target]
    record('read original screen', screen, 'Native install fixture')
    record('list the installed candidate agent', [shell, 'list'], f'installed-agent {target} qa-install {cwd}')
    record('use installed MCP relay', [scope + '/install/bin/facade-mcp'], '\n'.join(map(json.dumps, [
        {'jsonrpc': '2.0', 'id': 1, 'result': {'serverInfo': {'name': 'facade', 'version': version}}},
        {'jsonrpc': '2.0', 'id': 2, 'result': {'tools': [{'name': 'start_agent'}, {'name': 'list_agents'}]}},
    ])))
    refusals = {}
    for label, stage in zip(REFUSALS, ('corrupted', 'wrong-digest')):
        marker = f'usable after {label}'
        manifest = archive_sha if label == 'corrupted-bytes' else '0' * 64
        refusals[label] = {'archive_sha256': corrupt_sha if label == 'corrupted-bytes' else archive_sha,
                           'sidecar_sha256': sha256(f'{manifest}  {ASSET}\n'.encode()).hexdigest(),
                           'state_sha256': stable, 'live_marker': marker}
        record(f'screen before {label}', screen, 'Original screen')
        record(f'refuse {label}', install(stage), stderr=f'facade install: SHA-256 verification failed for {ASSET}.\n', status=1)
        record(f'screen survived {label}', screen, 'Original screen')
        record(f'use the same fake CLI after {label}', [shell, 'type', target, marker, '--enter'])
        record(f'read screen after {label}', screen, marker)
    record('stop the fixture agent', [shell, 'stop', target])
    return {'source': source, 'archive_sha256': archive_sha, 'sidecar_sha256': sidecar_sha,
            'fixture': scope, 'version': version, 'program_sha256': programs, 'installer_sha256': hash_file(installer),
            'original_runtime': runtime, 'install_tree': tree, 'settings_sha256': settings_sha, 'fake_sha256': 'e' * 64,
            'commands': commands, 'refusals': refusals,
            'cleanup': {'status': 'pass', 'sockets_absent': True, 'log': 'no processes left\n'}}


class NativeInstallEvidence(unittest.TestCase):
    @patch('check_native_install.archive_metadata')
    def test_requires_current_candidate_and_both_cases_after_cleanup(self, metadata):
        with tempfile.TemporaryDirectory(prefix='native-install-evidence-') as directory:
            root = Path(directory)
            archive, sums, receipt, output = (root / name for name in ('archive', 'SHA256SUMS', 'receipt', 'output'))
            archive.write_bytes(b'archive bytes')
            sums.write_text('checksum input\n')
            attempt = 'local/install-1'
            version, programs = '0.1.6', {'facade': 'a' * 64, 'facade-mcp': 'b' * 64}
            archive_sha, sidecar_sha = hash_file(archive), hash_file(sums)
            corrupt_sha = sha256(corrupted_archive(archive)).hexdigest()
            metadata.return_value = (version, programs, archive_sha, sidecar_sha)
            saved = installed_observation(source_identity(attempt), archive_sha, sidecar_sha, version, programs, corrupt_sha)
            success = install_success(saved, version, programs, archive_sha, corrupt_sha)
            saved['success'] = success
            receipt.write_text(json.dumps(saved))
            marker = SUCCESS_MARKER + json.dumps(success) + '\n'
            output.write_text(marker)
            self.assertEqual(verified_install(archive, sums, receipt, output, attempt), 2)
            with self.assertRaisesRegex(AcceptanceError, 'source and attempt'):
                verified_install(archive, sums, receipt, output, 'local/install-2')
            for changed in ('', marker + marker, marker.replace(NATIVE_INSTALL_CASES[0], 'other-case')):
                with self.subTest(output=changed):
                    output.write_text(changed)
                    with self.assertRaisesRegex(AcceptanceError, 'exact cases and archive'):
                        verified_install(archive, sums, receipt, output, attempt)
            output.write_text(marker)
            receipt.write_text(json.dumps({**saved, 'cleanup': {**saved['cleanup'], 'log': 'scan failed\n'}}))
            with self.assertRaisesRegex(AcceptanceError, 'cleanup did not complete'):
                verified_install(archive, sums, receipt, output, attempt)
            for field in ('original_runtime', 'install_tree', 'commands', 'refusals'):
                altered = {key: value for key, value in saved.items() if key != field}
                receipt.write_text(json.dumps(altered))
                with self.subTest(missing=field), self.assertRaisesRegex(AcceptanceError, 'observations are incomplete'):
                    verified_install(archive, sums, receipt, output, attempt)
            changed_state = deepcopy(saved)
            changed_state['refusals']['wrong-digest']['state_sha256'] = '0' * 64
            receipt.write_text(json.dumps(changed_state))
            with self.assertRaisesRegex(AcceptanceError, 'preserve the working installation'):
                verified_install(archive, sums, receipt, output, attempt)
            duplicate = {**saved, 'commands': [*saved['commands'], saved['commands'][0]]}
            receipt.write_text(json.dumps(duplicate))
            with self.assertRaisesRegex(AcceptanceError, 'unexpected commands after stopping'):
                verified_install(archive, sums, receipt, output, attempt)
            changed_route = deepcopy(saved)
            changed_route['commands'][1]['args'] = ['/some/other/facade', '--version']
            receipt.write_text(json.dumps(changed_route))
            with self.assertRaisesRegex(AcceptanceError, 'exact command and outcome for installed Shell version'):
                verified_install(archive, sums, receipt, output, attempt)
            changed_installer = deepcopy(saved)
            for record in changed_installer['commands']:
                if record['args'][0] == 'sh':
                    record['args'][1] = '/wrong/checkout/core/install.sh'
            receipt.write_text(json.dumps(changed_installer))
            with self.assertRaisesRegex(AcceptanceError, 'exact command and outcome for install candidate'):
                verified_install(archive, sums, receipt, output, attempt)
            changed_digest = deepcopy(saved)
            changed_digest['refusals']['corrupted-bytes']['archive_sha256'] = 'd' * 64
            receipt.write_text(json.dumps(changed_digest))
            with self.assertRaisesRegex(AcceptanceError, 'preserve the working installation'):
                verified_install(archive, sums, receipt, output, attempt)
            receipt.write_text(json.dumps(saved))
            archive.write_bytes(b'different bytes')
            with self.assertRaisesRegex(AcceptanceError, 'candidate archive and checksum file'):
                verified_install(archive, sums, receipt, output, attempt)
