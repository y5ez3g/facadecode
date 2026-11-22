#!/usr/bin/env python3
"""Check the exact Linux x64 candidate with the shipped installer and a facade-fakecli executable."""

import argparse
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import time
from uuid import UUID

from catalog import AcceptanceError, NATIVE_INSTALL_CASES, read_json
from evidence import digest, run_identity
from native_core import (
    ROOT, SYSTEM_PATH, clean_native_scope, hash_file, interrupted, process_identity, query,
    read_markers, source_identity, verify_native_cleanup, wait_for, write_receipt,
)


ASSET = 'facade-core-linux-x64.tar.gz'
PROGRAMS = ('facade', 'facade-mcp')
CORE = ROOT / 'core'
SUCCESS_MARKER = 'Facade native install test '
REFUSALS = ('corrupted-bytes', 'wrong-digest')
SHA256 = re.compile(r'[0-9a-f]{64}')


def validate_inputs(archive, sidecar, fake):
    if not hasattr(os, 'uname') or (os.uname().sysname, os.uname().machine) != ('Linux', 'x86_64'):
        raise ValueError('this fixture requires native Linux x64')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise ValueError('this fixture requires Linux pidfds for scoped failure cleanup')
    os.close(os.pidfd_open(os.getpid()))
    if not fake.is_file() or not os.access(fake, os.X_OK):
        raise ValueError('the fake CLI executable is missing or cannot run')
    return archive_metadata(archive, sidecar)


def archive_metadata(archive, sidecar):
    if archive.name != ASSET or not archive.is_file():
        raise ValueError(f'expected a file named {ASSET}')
    if not sidecar.is_file():
        raise ValueError('the candidate checksum sidecar is missing')
    checksum_bytes = sidecar.read_bytes()
    hashes = []
    for line in checksum_bytes.decode('ascii').splitlines():
        match = re.fullmatch(r'([0-9a-fA-F]{64})  (\S+)', line)
        if match is None:
            raise ValueError('malformed candidate checksum sidecar')
        if match[2] == ASSET:
            hashes.append(match[1].lower())
    if len(hashes) != 1 or hash_file(archive) != hashes[0]:
        raise ValueError(f'candidate digest mismatch for {ASSET}')
    with tarfile.open(archive) as package:
        members = package.getmembers()
        if sorted(entry.name for entry in members) != sorted((*PROGRAMS, 'VERSION', 'LICENSE.txt')) or not all(entry.isfile() for entry in members):
            raise ValueError('unexpected native archive contents')
        version = package.extractfile('VERSION').read().decode('ascii')
        if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+\n?', version):
            raise ValueError('the package does not contain a release version')
        digests = {}
        for program in PROGRAMS:
            data = package.extractfile(program).read()
            if data[:6] != b'\x7fELF\x02\x01' or int.from_bytes(data[18:20], 'little') != 62:
                raise ValueError(f'{program} is not an ELF x86-64 executable for {ASSET}')
            digests[program] = sha256(data).hexdigest()
    return version.strip(), digests, hashes[0], sha256(checksum_bytes).hexdigest()


def installer_args(installer, package, install, version):
    return ['sh', str(installer), '--version', version, '--package', str(package),
            '--install-root', str(install), '--no-path']


def corrupted_archive(archive):
    contents = bytearray(archive.read_bytes())
    contents[len(contents) // 2] ^= 1
    return contents


def verify_install_commands(commands, scope, address, version, installer):
    install = scope / 'install'
    shell = str(install / 'bin/facade')
    project = str(scope / 'project')
    records = iter(commands)

    def observed(label, args, status=0):
        step = next(records, None)
        if step is None or (step['label'], step['args'], step['status']) != (label, args, status):
            raise AcceptanceError(f'native install did not record the exact command and outcome for {label}')
        return step

    def installed_package(label, stage, status=0):
        return observed(label, installer_args(installer, scope / stage / ASSET, install, version), status)

    screen = [shell, 'screen', address]

    def wait_for_screen(label, marker):
        while marker not in observed(label, screen)['stdout']:
            continue

    installed = installed_package('install candidate', 'candidate')
    version_result = observed('installed Shell version', [shell, '--version'])
    started = observed('start fake CLI', [shell, 'start', '-d', '--name', 'installed-agent', '--workdir',
                                          project, 'qa-install', '--', 'candidate argument'])
    wait_for_screen('read original screen', 'Native install fixture')
    listing = observed('list the installed candidate agent', [shell, 'list'])['stdout']
    relay = observed('use installed MCP relay', [str(install / 'bin/facade-mcp')])
    answers = [json.loads(line) for line in relay['stdout'].splitlines()]
    if (f'Installed Facade {version}' not in installed['stdout']
            or version_result['stdout'].strip() != f'facade {version}'
            or started['stdout'] != f'Started installed-agent ({address}) in the background.\n'
            or not any(all(value in line for value in ('installed-agent', address, 'qa-install', project))
                       for line in listing.splitlines())
            or [(line['jsonrpc'], line['id']) for line in answers] != [('2.0', 1), ('2.0', 2)]
            or answers[0]['result']['serverInfo'] != {'name': 'facade', 'version': version}
            or not {'start_agent', 'list_agents'} <= {tool['name'] for tool in answers[1]['result']['tools']}):
        raise AcceptanceError('native install did not observe the installed Shell and MCP relay')

    for label, stage in zip(REFUSALS, ('corrupted', 'wrong-digest')):
        before = observed(f'screen before {label}', screen)
        refusal = installed_package(f'refuse {label}', stage, status=1)
        after = observed(f'screen survived {label}', screen)
        if (refusal['stderr'].strip() != f'facade install: SHA-256 verification failed for {ASSET}.'
                or after['stdout'] != before['stdout']):
            raise AcceptanceError(f'native install did not refuse {label} and preserve the original screen')
        marker = f'usable after {label}'
        observed(f'use the same fake CLI after {label}', [shell, 'type', address, marker, '--enter'])
        wait_for_screen(f'read screen after {label}', marker)
    observed('stop the fixture agent', [shell, 'stop', address])
    if next(records, None) is not None:
        raise AcceptanceError('native install recorded unexpected commands after stopping the fixture agent')


def install_success(receipt, version, programs, archive_sha, corrupt_sha, *, installer=CORE / 'install.sh'):
    try:
        if (receipt['version'], receipt['program_sha256'], receipt['installer_sha256']) != (
                version, programs, hash_file(CORE / 'install.sh')):
            raise AcceptanceError('native install did not use the candidate program pair and installer')
        scope = Path(receipt['fixture'])
        if scope.parent != Path('/tmp') or not scope.name.startswith('fci-install-'):
            raise AcceptanceError('native install reported an invalid fixture scope')
        runtime = receipt['original_runtime']
        reference, address, fake = (runtime[key] for key in ('reference', 'address', 'fake'))
        try:
            machine_id = str(UUID(reference['machine_id']))
        except ValueError as error:
            raise AcceptanceError('native install recorded an invalid machine identity') from error
        agent_id, machine = address.split('@', 1)
        cwd = str(scope / 'project')
        if (agent_id != 'a1' or not machine or reference['agent_id'] != agent_id
                or machine_id != reference['machine_id']
                or runtime['cwd'] != cwd or runtime['durable_machine'] != [[reference['machine_id'], machine]]
                or len(runtime['durable_agents']) != 1):
            raise AcceptanceError('native install did not read the exact agent and machine records')
        row = runtime['durable_agents'][0]
        if row[:5] != [agent_id, 'installed-agent', 'qa-install', cwd, fake['pid']] or row[6] is not None:
            raise AcceptanceError('native install did not keep the original live agent record')
        services = runtime['services']
        executable = str(scope / 'state/core/bin' / version / 'facade')
        if (set(services) != {'daemon', 'keeper'} or {record['executable'] for record in services.values()} != {executable}
                or fake['executable'] != str(scope / 'fixture-bin/facade-fakecli')
                or len({record['pid'] for record in (*services.values(), fake)}) != 3
                or not all(type(record['pid']) is int and record['pid'] > 0
                           and type(record['start_ticks']) is int and record['start_ticks'] > 0
                           for record in (*services.values(), fake))):
            raise AcceptanceError('native install did not observe the two candidate services and original CLI')

        tree = receipt['install_tree']
        share = 'share/facade'
        if (tuple(tree[f'{share}/current'][1:]) != ('link', f'versions/{version}')
                or any(tuple(tree[f'bin/{name}'][1:]) != ('link', f'../{share}/current/{name}')
                       or tuple(tree[f'{share}/versions/{version}/{name}']) != (0o755, 'file', programs[name]) for name in PROGRAMS)):
            raise AcceptanceError('native install did not observe the candidate launchers and program bytes')
        settings_sha = receipt['settings_sha256']
        if not SHA256.fullmatch(settings_sha) or not SHA256.fullmatch(receipt['fake_sha256']):
            raise AcceptanceError('native install is missing the settings or fixture program digest')
        original = digest({'install_tree': tree, 'runtime': runtime, 'settings_sha256': settings_sha})
        verify_install_commands(receipt['commands'], scope, address, version, installer)
        refusals = receipt['refusals']
        if set(refusals) != set(REFUSALS):
            raise AcceptanceError('native install did not observe both corrupt-package refusals')
        for label, proof in refusals.items():
            manifest = archive_sha if label == 'corrupted-bytes' else '0' * 64
            if (proof['state_sha256'] != original or proof['live_marker'] != f'usable after {label}'
                    or proof['sidecar_sha256'] != sha256(f'{manifest}  {ASSET}\n'.encode()).hexdigest()
                    or proof['archive_sha256'] != (corrupt_sha if label == 'corrupted-bytes' else archive_sha)):
                raise AcceptanceError(f'native install did not refuse {label} and preserve the working installation')
    except (KeyError, TypeError, IndexError, json.JSONDecodeError) as error:
        raise AcceptanceError('native install observations are incomplete or malformed') from error
    return {'case_ids': list(NATIVE_INSTALL_CASES), 'archive_sha256': archive_sha,
            'evidence_sha256': digest({key: value for key, value in receipt.items() if key != 'success'})}


def verified_install(archive, sidecar, receipt_path, output, run, *, producer_checkout=ROOT):
    if not producer_checkout.is_absolute():
        raise AcceptanceError('supply the absolute path of the producer checkout')
    receipt = read_json(receipt_path)
    if not isinstance(receipt, dict) or receipt.get('source') != source_identity(run):
        raise AcceptanceError('native install receipt does not match this source and attempt')
    if receipt.get('archive_sha256') != hash_file(archive) or receipt.get('sidecar_sha256') != hash_file(sidecar):
        raise AcceptanceError('native install receipt does not match the candidate archive and checksum file')
    try:
        version, programs, archive_sha, sidecar_sha = archive_metadata(archive, sidecar)
    except tarfile.TarError as error:
        raise AcceptanceError('native install candidate is not a readable archive') from error
    if (receipt['archive_sha256'], receipt['sidecar_sha256']) != (archive_sha, sidecar_sha):
        raise AcceptanceError('native install candidate archive or checksum file changed during verification')
    verify_native_cleanup(receipt)
    expected = install_success(receipt, version, programs, archive_sha, sha256(corrupted_archive(archive)).hexdigest(),
                               installer=producer_checkout / 'core/install.sh')
    if read_markers(output, SUCCESS_MARKER) != [expected] or receipt.get('success') != expected:
        raise AcceptanceError('native install did not observe the exact cases and archive')
    return len(expected['case_ids'])


def install_tree(root):
    entries = {}
    for target in sorted(root.rglob('*')):
        mode = target.lstat().st_mode
        if stat.S_ISLNK(mode):
            value = ('link', os.readlink(target))
        elif stat.S_ISREG(mode):
            value = ('file', hash_file(target))
        else:
            assert stat.S_ISDIR(mode), target
            value = ('directory',)
        entries[str(target.relative_to(root))] = (stat.S_IMODE(mode), *value)
    return entries


def exercise(archive, sidecar, fake, receipt):
    isolated = Path(tempfile.mkdtemp(prefix='fci-install-', dir='/tmp')).resolve()
    receipt['fixture'] = str(isolated)
    key = sha256(os.fsencode(isolated / 'state')).hexdigest()[:10]
    directory = Path(f'/tmp/facade-core-{os.getuid()}')
    sockets = {role: directory / f'{role}-{key}.sock' for role in ('daemon', 'keeper')}
    if any(os.path.lexists(endpoint) for endpoint in sockets.values()):
        isolated.rmdir()
        raise RuntimeError('candidate fixture socket path was already in use')
    try:
        staged_fake = isolated / 'fixture-bin/facade-fakecli'
        staged_fake.parent.mkdir(mode=0o700)
        shutil.copy2(fake, staged_fake)
        if hash_file(staged_fake) != receipt['fake_sha256']:
            raise AcceptanceError('the fake CLI changed while staging')
        check_installed_programs(archive, sidecar, staged_fake, isolated, sockets, receipt)
    finally:
        clean_native_scope(isolated, sockets, receipt)


def check_installed_programs(archive, sidecar, fake, root, sockets, receipt):
    version, digests, expected = (receipt[key] for key in ('version', 'program_sha256', 'archive_sha256'))
    home, state, install, project, tmp, runtime = (root / name for name in ('home', 'state', 'install', 'project', 'tmp', 'runtime'))
    config, cache, data, state_dir = (home / name for name in ('config', 'cache', 'data', 'state'))
    for directory in (home, state, project, tmp, runtime, config, cache, data, state_dir):
        directory.mkdir(mode=0o700)
    env = {key: str(value) for key, value in {
        'CI_ACCEPTANCE_ROOT': root, 'HOME': home, 'FACADE_HOME': state, 'TMPDIR': tmp,
        'PATH': f'{install}/bin:{SYSTEM_PATH}',
        'XDG_CONFIG_HOME': config, 'XDG_CACHE_HOME': cache, 'XDG_DATA_HOME': data,
        'XDG_STATE_HOME': state_dir, 'XDG_RUNTIME_DIR': runtime, 'TERM': 'xterm-256color', 'LC_ALL': 'C.UTF-8',
    }.items()}
    args_file, starts, keys = (root / name for name in ('argv.json', 'starts', 'input'))
    settings = state / 'facade.json'
    settings.write_text(json.dumps({'clis': {'qa-install': {
        'type': 'custom', 'command': str(fake), 'args': ['--fixture', 'two words'],
        'env': {'FAKECLI_NAME': 'Native install fixture', 'FAKECLI_ARGS': str(args_file),
                'FAKECLI_STARTS': str(starts), 'FAKECLI_KEYS': str(keys)},
    }}}) + '\n')
    settings_before = settings.read_bytes()
    facade = install / 'bin/facade'
    target = None

    def run(label, argv, *, status=0, input_text=None, timeout=20):
        command = [str(item) for item in argv]
        stdin = {'input': input_text} if input_text is not None else {'stdin': subprocess.DEVNULL}
        result = subprocess.run(command, cwd=project, env=env, text=True, capture_output=True, timeout=timeout, **stdin)
        receipt['commands'].append({'label': label, 'args': command, 'status': result.returncode,
                                    'stdout': result.stdout, 'stderr': result.stderr})
        if status is not None:
            assert result.returncode == status, (label, result)
        return result

    def stage(name, package, manifest):
        folder = root / name
        folder.mkdir()
        staged = folder / ASSET
        shutil.copyfile(package, staged)
        (folder / 'SHA256SUMS').write_bytes(manifest)
        return staged

    def install_package(label, package, status=0):
        return run(label, installer_args(CORE / 'install.sh', package, install, version), status=status)

    try:
        candidate = stage('candidate', archive, sidecar.read_bytes())
        if hash_file(candidate) != expected or hash_file(candidate.with_name('SHA256SUMS')) != receipt['sidecar_sha256']:
            raise AcceptanceError('candidate archive or checksum file changed while staging')
        installed = install_package('install candidate', candidate)
        assert f'Installed Facade {version}' in installed.stdout, installed
        assert os.readlink(install / 'share/facade/current') == f'versions/{version}'
        for program, program_sha in digests.items():
            launcher = install / 'bin' / program
            assert os.readlink(launcher) == f'../share/facade/current/{program}'
            assert hash_file(launcher) == program_sha and os.access(launcher, os.X_OK), program
        assert run('installed Shell version', [facade, '--version']).stdout.strip() == f'facade {version}'
        started = run('start fake CLI', [facade, 'start', '-d', '--name', 'installed-agent', '--workdir', project,
                                          'qa-install', '--', 'candidate argument']).stdout
        match = re.fullmatch(r'Started installed-agent \((a\d+@[^)]+)\) in the background\.\n', started)
        assert match, started
        target = match[1]
        wait_for('the indexed fake CLI startup records', lambda: args_file.is_file() and starts.is_file() and keys.is_file())
        fake_pid = int(starts.read_text().strip())
        assert json.loads(args_file.read_text()) == ['--fixture', 'two words', '--', 'candidate argument']
        wait_for('the original fake CLI screen', lambda: 'Native install fixture' in run('read original screen', [facade, 'screen', target]).stdout)
        listing = run('list the installed candidate agent', [facade, 'list']).stdout
        assert any('installed-agent' in line and target in line and 'qa-install' in line and str(project) in line for line in listing.splitlines()), listing

        # Run the installed relay too, using only MCP stdio and its local default entry point.
        frames = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'qa', 'version': '1'},
            }},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
        ]
        mcp = run('use installed MCP relay', [install / 'bin/facade-mcp'],
                  input_text=''.join(json.dumps(frame) + '\n' for frame in frames))
        answers = [json.loads(line) for line in mcp.stdout.splitlines()]
        assert [answer['id'] for answer in answers] == [1, 2] and answers[1]['result']['tools'], answers

        def observe():
            hello, status = query(sockets['daemon'], 'daemon.status', {})
            _, inspected = query(sockets['daemon'], 'agent.inspect', {'target': target})
            row = inspected['agent']
            reference = {'machine_id': hello['machine_id'], 'agent_id': target.split('@', 1)[0]}
            assert (status['home'], status['build'], status['daemon_pid']) == (str(state), version, hello['pid'])
            assert (row['reference'], row['address'], row['pid'], row['cwd'], row['process']) == (
                reference, target, fake_pid, str(project), 'running')
            services = {role: process_identity(status[f'{role}_pid']) for role in ('daemon', 'keeper')}
            for service in services.values():
                executable = Path(service['executable'])
                assert executable.is_relative_to(root) and hash_file(executable) == digests['facade'], service
            original = process_identity(fake_pid)
            assert Path(original['executable']) == fake, original
            assert (Path('/proc') / str(fake_pid) / 'cwd').resolve(strict=True) == project
            assert starts.read_text().splitlines() == [str(fake_pid)]
            db = state / 'core/facade.db'
            with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as store:
                machine = [list(row) for row in store.execute('SELECT machine_id, name FROM machine')]
                agents = [list(row) for row in store.execute('SELECT agent_id, name, cli, cwd, pid, created_at, exit_at FROM agents')]
            assert len(machine) == 1 and machine[0][0] == reference['machine_id'], machine
            assert len(agents) == 1 and agents[0][:5] == [reference['agent_id'], 'installed-agent', 'qa-install', str(project), fake_pid]
            assert agents[0][6] is None, agents
            return {'reference': reference, 'address': target, 'cwd': str(project), 'fake': original,
                    'services': services, 'durable_machine': machine, 'durable_agents': agents}

        original = observe()
        receipt['original_runtime'] = original
        tree = install_tree(install)
        receipt['install_tree'] = tree
        receipt['settings_sha256'] = sha256(settings_before).hexdigest()
        assert [entry.name for entry in (install / 'share/facade/versions').iterdir()] == [version]
        corrupt = stage('corrupted', candidate, f'{expected}  {ASSET}\n'.encode())
        corrupt.write_bytes(corrupted_archive(candidate))
        wrong_digest = stage('wrong-digest', candidate, f'{"0" * 64}  {ASSET}\n'.encode())
        for label, package in (('corrupted-bytes', corrupt), ('wrong-digest', wrong_digest)):
            before_input = keys.read_bytes()
            before_screen = run(f'screen before {label}', [facade, 'screen', target]).stdout
            result = install_package(f'refuse {label}', package, status=1)
            assert result.stderr.strip() == f'facade install: SHA-256 verification failed for {ASSET}.', result
            current_tree, current_settings, current = install_tree(install), settings.read_bytes(), observe()
            assert current_tree == tree and current_settings == settings_before, label
            assert current == original and keys.read_bytes() == before_input, label
            assert run(f'screen survived {label}', [facade, 'screen', target]).stdout == before_screen, label
            marker = f'usable after {label}'
            run(f'use the same fake CLI after {label}', [facade, 'type', target, marker, '--enter'])
            wait_for(f'input after {label}', lambda: marker.encode() in keys.read_bytes()[len(before_input):])
            wait_for(f'the live screen after {label}', lambda: marker in run(
                f'read screen after {label}', [facade, 'screen', target]).stdout)
            assert observe() == original, label
            receipt['refusals'][label] = {'archive_sha256': hash_file(package), 'live_marker': marker,
                'sidecar_sha256': hash_file(package.with_name('SHA256SUMS')),
                'state_sha256': digest({'install_tree': current_tree, 'runtime': current,
                                        'settings_sha256': sha256(current_settings).hexdigest()})}
    finally:
        if target is not None:
            run('stop the fixture agent', [facade, 'stop', target], status=None, timeout=5)


def main():
    if not __debug__:
        raise SystemExit('run the installer test with Python assertions enabled')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('sha256sums', type=Path)
    parser.add_argument('fake_executable', type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--run-id', help='the local acceptance attempt ID')
    args = parser.parse_args()
    archive, sidecar = args.archive.absolute(), args.sha256sums.absolute()
    fake = args.fake_executable.resolve()
    try:
        source = source_identity(run_identity(args.run_id, os.environ))
        version, digests, expected, checksum = validate_inputs(archive, sidecar, fake)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(2, f'native install check: {error}\n')
    signal.signal(signal.SIGTERM, interrupted)
    receipt = {'source': source, 'archive': str(archive), 'archive_sha256': expected, 'sidecar_sha256': checksum,
               'installer_sha256': hash_file(CORE / 'install.sh'), 'fake_sha256': hash_file(fake),
               'version': version, 'program_sha256': digests,
               'commands': [], 'refusals': {}}
    started = time.monotonic()
    try:
        exercise(archive, sidecar, fake, receipt)
    finally:
        receipt['elapsed_seconds'] = round(time.monotonic() - started, 3)
        if args.receipt is not None:
            write_receipt(args.receipt, receipt)
    verify_native_cleanup(receipt)
    receipt['success'] = install_success(receipt, version, digests, expected, sha256(corrupted_archive(archive)).hexdigest())
    if args.receipt is not None:
        write_receipt(args.receipt, receipt)
    print(SUCCESS_MARKER + json.dumps(receipt['success'], separators=(',', ':')))


if __name__ == '__main__':
    main()
