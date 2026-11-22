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

from catalog import AcceptanceError, NATIVE_INSTALL_CASES, read_json
from evidence import run_identity
from native_core import (
    ROOT, SYSTEM_PATH, clean_native_scope, hash_file, interrupted, process_identity, query,
    read_markers, source_identity, verify_native_cleanup, wait_for, write_receipt,
)


ASSET = 'facade-core-linux-x64.tar.gz'
PROGRAMS = ('facade', 'facade-mcp')
CORE = ROOT / 'core'
SUCCESS_MARKER = 'Facade native install test '


def validate_inputs(archive, sidecar, fake):
    if not hasattr(os, 'uname') or (os.uname().sysname, os.uname().machine) != ('Linux', 'x86_64'):
        raise ValueError('this fixture requires native Linux x64')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise ValueError('this fixture requires Linux pidfds for scoped failure cleanup')
    os.close(os.pidfd_open(os.getpid()))
    if archive.name != ASSET or not archive.is_file():
        raise ValueError(f'expected a file named {ASSET}')
    if not sidecar.is_file():
        raise ValueError('the candidate checksum sidecar is missing')
    if not fake.is_file() or not os.access(fake, os.X_OK):
        raise ValueError('the fake CLI executable is missing or cannot run')
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


def verified_install(archive, sidecar, receipt_path, output, run):
    receipt = read_json(receipt_path)
    digest = hash_file(archive)
    expected = {'case_ids': list(NATIVE_INSTALL_CASES), 'archive_sha256': digest}
    if not isinstance(receipt, dict) or receipt.get('source') != source_identity(run):
        raise AcceptanceError('native install receipt does not match this source and attempt')
    if receipt.get('archive_sha256') != digest or receipt.get('sidecar_sha256') != hash_file(sidecar):
        raise AcceptanceError('native install receipt does not match the candidate archive and checksum file')
    if read_markers(output, SUCCESS_MARKER) != [expected] or receipt.get('success') != expected:
        raise AcceptanceError('native install did not observe the exact cases and archive')
    verify_native_cleanup(receipt)
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
        check_installed_programs(archive, sidecar, fake, isolated, sockets, receipt)
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
        return run(label, ['sh', CORE / 'install.sh', '--version', version, '--package', package,
                           '--install-root', install, '--no-path'], status=status)

    try:
        candidate = stage('candidate', archive, sidecar.read_bytes())
        if hash_file(candidate) != expected or hash_file(candidate.with_name('SHA256SUMS')) != receipt['sidecar_sha256']:
            raise AcceptanceError('candidate archive or checksum file changed while staging')
        installed = install_package('install candidate', candidate)
        assert f'Installed Facade {version}' in installed.stdout, installed
        assert os.readlink(install / 'share/facade/current') == f'versions/{version}'
        for program, digest in digests.items():
            launcher = install / 'bin' / program
            assert os.readlink(launcher) == f'../share/facade/current/{program}'
            assert hash_file(launcher) == digest and os.access(launcher, os.X_OK), program
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
                machine = store.execute('SELECT machine_id, name FROM machine').fetchall()
                agents = store.execute('SELECT agent_id, name, cli, cwd, pid, created_at, exit_at FROM agents').fetchall()
            assert len(machine) == 1 and machine[0][0] == reference['machine_id'], machine
            assert len(agents) == 1 and agents[0][:5] == (reference['agent_id'], 'installed-agent', 'qa-install', str(project), fake_pid)
            assert agents[0][6] is None, agents
            return {'reference': reference, 'address': target, 'cwd': str(project), 'fake': original,
                    'services': services, 'durable_machine': machine, 'durable_agents': agents}

        original = observe()
        receipt['original_runtime'] = original
        tree = install_tree(install)
        assert [entry.name for entry in (install / 'share/facade/versions').iterdir()] == [version]
        corrupt = stage('corrupted', candidate, f'{expected}  {ASSET}\n'.encode())
        with corrupt.open('r+b') as stream:
            offset = corrupt.stat().st_size // 2
            stream.seek(offset)
            byte = stream.read(1)
            stream.seek(offset)
            stream.write(bytes([byte[0] ^ 1]))
        wrong_digest = stage('wrong-digest', candidate, f'{"0" * 64}  {ASSET}\n'.encode())
        for label, package in (('corrupted-bytes', corrupt), ('wrong-digest', wrong_digest)):
            before_input = keys.read_bytes()
            before_screen = run(f'screen before {label}', [facade, 'screen', target]).stdout
            result = install_package(f'refuse {label}', package, status=1)
            assert result.stderr.strip() == f'facade install: SHA-256 verification failed for {ASSET}.', result
            assert install_tree(install) == tree and settings.read_bytes() == settings_before, label
            assert observe() == original and keys.read_bytes() == before_input, label
            assert run(f'screen survived {label}', [facade, 'screen', target]).stdout == before_screen, label
            marker = f'usable after {label}'
            run(f'use the same fake CLI after {label}', [facade, 'type', target, marker, '--enter'])
            wait_for(f'input after {label}', lambda: marker.encode() in keys.read_bytes()[len(before_input):])
            wait_for(f'the live screen after {label}', lambda: marker in run(
                f'read screen after {label}', [facade, 'screen', target]).stdout)
            assert observe() == original, label
            receipt['refusals'][label] = {'archive_sha256': hash_file(package), 'same_install_and_state': True, 'live_marker': marker}
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
        receipt['success'] = {'case_ids': list(NATIVE_INSTALL_CASES), 'archive_sha256': expected}
    finally:
        receipt['elapsed_seconds'] = round(time.monotonic() - started, 3)
        if args.receipt is not None:
            write_receipt(args.receipt, receipt)
    print(SUCCESS_MARKER + json.dumps(receipt['success'], separators=(',', ':')))


if __name__ == '__main__':
    main()
