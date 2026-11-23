from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from catalog import AcceptanceError, NATIVE_INSTALL_CASES
from check_native_install import (
    ASSET, REFUSALS, REFUSAL_STAGES, SUCCESS_MARKER, archive_metadata, corrupted_archive, install_success,
    installer_args, verified_install, wrong_build,
)
from evidence import digest
from native_framework import ROOT, SYSTEM_PATH, hash_file, source_identity


def installed_observation(source, archive_sha, sidecar_sha, build, programs, corrupt_sha):
    scope = Path('/tmp/fci-install-policy-fixture')
    target = 'a1@fixture-host'
    cwd = str(scope / 'project')
    version = build.split('+', 1)[0]
    bin_dir = scope / 'state/framework/bin'
    executable = str(bin_dir / build / 'facade')
    machine = 'e3969844-767b-4587-a5c6-08835541efd5'
    runtime = {
        'reference': {'machine_id': machine, 'agent_id': 'a1'}, 'address': target, 'cwd': cwd,
        'fake': {'pid': 3, 'start_ticks': 30, 'executable': str(scope / 'fixture-bin/facade-fakecli')},
        'services': {name: {'pid': pid, 'start_ticks': 20, 'executable': executable}
                     for name, pid in (('daemon', 1), ('keeper', 2))},
        'durable_machine': [[machine, 'fixture-host']],
        'durable_agents': [['a1', 'installed-agent', 'qa-install', cwd, 3, 'time', None]],
    }
    tree = {build: [0o700, 'directory']}
    for name, program in programs.items():
        tree[name] = [0o777, 'link', f'{build}/{name}']
        tree[f'{build}/{name}'] = [0o700, 'file', program]
    settings_sha = 'c' * 64
    stable = digest({'install_tree': tree, 'runtime': runtime, 'settings_sha256': settings_sha})
    commands = []
    shell = str(bin_dir / 'facade')
    installer = Path(__file__).resolve().parents[1] / 'framework/install.sh'

    def record(label, args, stdout='', stderr='', status=0):
        commands.append({'label': label, 'args': args, 'status': status, 'stdout': stdout, 'stderr': stderr})

    def install(stage, expected=None):
        return installer_args(installer, scope / stage / ASSET, build, expected_build=expected)

    record('install candidate', install('candidate'), f'Installed Facade {build} in {bin_dir}.\n')
    record('select the same candidate again', install('candidate'), f'Facade {build} is already up to date in {bin_dir}.\n')
    record('installed Shell version', [shell, '--version'], f'facade {build}\n')
    record('start fake CLI', [shell, 'start', '-d', '--name', 'installed-agent', '--workdir',
                              cwd, 'qa-install', '--', 'candidate argument'],
           f'Started installed-agent ({target}) in the background.\n')
    screen = [shell, 'screen', target]
    record('read original screen', screen, 'Native install fixture')
    record('list the installed candidate agent', [shell, 'list'], f'installed-agent {target} qa-install {cwd}')
    record('use installed MCP relay', [str(bin_dir / 'facade-mcp')], '\n'.join(map(json.dumps, [
        {'jsonrpc': '2.0', 'id': 1, 'result': {'serverInfo': {'name': 'facade', 'version': version}}},
        {'jsonrpc': '2.0', 'id': 2, 'result': {'tools': [{'name': 'start_agent'}, {'name': 'list_agents'}]}},
    ])))
    refusals = {}
    for label, stage in zip(REFUSALS, REFUSAL_STAGES):
        marker = f'usable after {label}'
        manifest = '0' * 64 if label == 'wrong-digest' else archive_sha
        refusals[label] = {'archive_sha256': corrupt_sha if label == 'corrupted-bytes' else archive_sha,
                           'sidecar_sha256': sha256(f'{manifest}  {ASSET}\n'.encode()).hexdigest(),
                           'state_sha256': stable, 'live_marker': marker}
        record(f'screen before {label}', screen, 'Original screen')
        if label == 'wrong-build':
            pin = wrong_build(build)
            record(f'refuse {label}', install(stage, pin),
                   stderr=f'facade install: Expected Facade build {pin}, found {build} in the package.\n', status=1)
        else:
            record(f'refuse {label}', install(stage),
                   stderr=f'facade install: SHA-256 verification failed for {ASSET}.\n', status=1)
        record(f'screen survived {label}', screen, 'Original screen')
        record(f'use the same fake CLI after {label}', [shell, 'type', target, marker, '--enter'])
        record(f'read screen after {label}', screen, marker)
    record('stop the fixture agent', [shell, 'stop', target])
    return {'source': source, 'archive_sha256': archive_sha, 'sidecar_sha256': sidecar_sha,
            'fixture': str(scope), 'build': build, 'version': version, 'program_sha256': programs, 'installer_sha256': hash_file(installer),
            'original_runtime': runtime, 'install_tree': tree, 'settings_sha256': settings_sha, 'fake_sha256': 'e' * 64,
            'commands': commands, 'refusals': refusals,
            'cleanup': {'status': 'pass', 'sockets_absent': True, 'log': 'no processes left\n'}}


def write_candidate(archive, sums, marker, program):
    with tarfile.open(archive, 'w:gz') as package:
        for name, data in (('VERSION', marker.encode('ascii')), ('LICENSE.txt', b'license'),
                           ('facade', program), ('facade-mcp', program)):
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o755 if name.startswith('facade') else 0o644
            package.addfile(entry, BytesIO(data))
    sums.write_text(f'{hash_file(archive)}  {ASSET}\n')


class NativeInstallEvidence(unittest.TestCase):
    def test_candidate_marker_is_stamped_and_numeric_debug_archives_are_local(self):
        with tempfile.TemporaryDirectory(prefix='native-install-build-') as directory:
            root = Path(directory)
            archive, sums = root / ASSET, root / 'SHA256SUMS'
            program = bytearray(20)
            program[:6] = b'\x7fELF\x02\x01'
            program[18] = 62

            build = f"0.1.6+1700000000.{'a' * 40}"
            write_candidate(archive, sums, build + '\n', program)
            self.assertEqual(archive_metadata(archive, sums)[0], build)
            write_candidate(archive, sums, '0.1.6\n', program)
            with self.assertRaisesRegex(ValueError, 'build identity'):
                archive_metadata(archive, sums)
            self.assertEqual(archive_metadata(archive, sums, local=True)[0], '0.1.6')

    @unittest.skipUnless(hasattr(os, 'uname') and os.uname()[:1] == ('Linux',), 'exercises the Linux package fixture')
    def test_wrong_build_pin_is_refused_before_home_selection(self):
        with tempfile.TemporaryDirectory(prefix='native-install-pin-') as directory:
            root = Path(directory).resolve()
            archive, sums = root / ASSET, root / 'SHA256SUMS'
            target, profile, temp = (root / name for name in ('selected home', 'user', 'tmp'))
            profile.mkdir()
            temp.mkdir()
            build = f"0.1.6+1700000000.{'a' * 40}"
            pin = wrong_build(build)
            program = b'#!/bin/sh\nprintf "unexpected executable selection\\n" >&2\nexit 64\n'
            write_candidate(archive, sums, build + '\n', program)
            result = subprocess.run(
                installer_args(ROOT / 'framework/install.sh', archive, build, expected_build=pin),
                cwd=root, env={'PATH': SYSTEM_PATH, 'HOME': str(profile), 'FACADE_HOME': str(target), 'TMPDIR': str(temp)},
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(f'Expected Facade build {pin}, found {build} in the package.', result.stderr)
            self.assertFalse(target.exists())
            self.assertEqual(list(profile.iterdir()), [])

    @unittest.skipUnless(hasattr(os, 'uname') and os.uname()[:1] == ('Linux',), 'exercises Unix PATH profiles')
    def test_a_changed_selection_moves_its_home_to_the_front_of_unix_profiles(self):
        with tempfile.TemporaryDirectory(prefix='native-install-path-') as directory:
            root = Path(directory).resolve()
            archive, sums = root / ASSET, root / 'SHA256SUMS'
            profile, temp, tools = (root / name for name in ('user', 'tmp', 'tools'))
            for folder in (profile, temp, tools):
                folder.mkdir()
            fish = tools / 'fish'
            fish.write_text('#!/bin/sh\nexit 0\n')
            fish.chmod(0o755)
            initial_path = f'{tools}:{SYSTEM_PATH}'
            env = {'PATH': initial_path, 'HOME': str(profile), 'TMPDIR': str(temp)}
            sh_profile = profile / '.profile'
            sh_profile.write_text('export QA_PROFILE_MARKER=preserved\n')
            fish_config = profile / '.config/fish/conf.d/facade.fish'
            fish_config.parent.mkdir(parents=True)
            fish_config.write_text('# preserve this fish setting\n')
            first, second = root / 'first home', root / 'second home'
            for home, stamp in [(first, 1700000000), (second, 1700000000), (first, 1800000000)]:
                build = f"0.1.6+{stamp}.{'a' * 40}"
                program = f"""#!/bin/sh
set -eu
if [ "$1" = --version ]; then printf '%s\\n' 'facade {build}'; exit; fi
test "$1 $2" = 'daemon --takeover'
mkdir -p "$FACADE_HOME/framework/bin"
cp "$0" "$FACADE_HOME/framework/bin/facade"
""".encode()
                write_candidate(archive, sums, build + '\n', program)
                result = subprocess.run(
                    ['sh', str(ROOT / 'framework/install.sh'), '--package', str(archive), '--expected-build', build],
                    cwd=root, env={**env, 'FACADE_HOME': str(home)}, capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'Installed Facade {build} in {home}/framework/bin.', result.stdout)
            result = subprocess.run(
                ['sh', '-c', '. "$1"; printf "%s\\n" "$QA_PROFILE_MARKER" "$PATH"; command -v facade',
                 '--', str(sh_profile)], env=env, capture_output=True, text=True, check=True, timeout=10,
            )
            marker, resolved_path, launcher = result.stdout.splitlines()
            self.assertEqual(marker, 'preserved')
            self.assertEqual(resolved_path, f'{first}/framework/bin:{second}/framework/bin:{initial_path}')
            self.assertEqual(launcher, f'{first}/framework/bin/facade')
            fish_lines = [line for line in fish_config.read_text().splitlines() if line]
            self.assertEqual(fish_lines, [
                '# preserve this fish setting',
                f"fish_add_path --path --prepend --move '{second}/framework/bin'",
                f"fish_add_path --path --prepend --move '{first}/framework/bin'",
            ])

    @patch('check_native_install.archive_metadata')
    def test_requires_current_candidate_and_both_cases_after_cleanup(self, metadata):
        with tempfile.TemporaryDirectory(prefix='native-install-evidence-') as directory:
            root = Path(directory)
            archive, sums, receipt, output = (root / name for name in ('archive', 'SHA256SUMS', 'receipt', 'output'))
            archive.write_bytes(b'archive bytes')
            sums.write_text('checksum input\n')
            attempt = 'local/install-1'
            version, programs = '0.1.6', {'facade': 'a' * 64, 'facade-mcp': 'b' * 64}
            source = source_identity(attempt)
            build = f"{version}+1700000000.{source['revision']}"
            archive_sha, sidecar_sha = hash_file(archive), hash_file(sums)
            corrupt_sha = sha256(corrupted_archive(archive)).hexdigest()
            metadata.return_value = (build, programs, archive_sha, sidecar_sha)
            saved = installed_observation(source, archive_sha, sidecar_sha, build, programs, corrupt_sha)
            success = install_success(saved, build, programs, archive_sha, corrupt_sha)
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
            widened = deepcopy(saved)
            widened['install_tree'][f'{build}/facade'][0] = 0o755
            receipt.write_text(json.dumps(widened))
            with self.assertRaisesRegex(AcceptanceError, 'candidate launchers and program bytes'):
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
            next(record for record in changed_route['commands'] if record['label'] == 'installed Shell version')['args'] = [
                '/some/other/facade', '--version']
            receipt.write_text(json.dumps(changed_route))
            with self.assertRaisesRegex(AcceptanceError, 'exact command and outcome for installed Shell version'):
                verified_install(archive, sums, receipt, output, attempt)
            changed_pin = deepcopy(saved)
            wrong = next(record for record in changed_pin['commands'] if record['label'] == 'refuse wrong-build')
            wrong['args'][wrong['args'].index('--expected-build') + 1] = build
            receipt.write_text(json.dumps(changed_pin))
            with self.assertRaisesRegex(AcceptanceError, 'exact command and outcome for refuse wrong-build'):
                verified_install(archive, sums, receipt, output, attempt)
            changed_installer = deepcopy(saved)
            for record in changed_installer['commands']:
                if record['args'][0] == 'sh':
                    record['args'][1] = '/wrong/checkout/framework/install.sh'
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
