#!/usr/bin/env python3
"""Check the exact Linux x64 candidate with the shipped installer and a facade-fakecli executable."""

import argparse
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import select
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
from native_framework import (
    ROOT, SYSTEM_PATH, clean_native_scope, hash_file, interrupted, process_identity, query,
    read_markers, source_identity, verify_native_cleanup, wait_for, write_receipt,
)


ASSET = 'facade-framework-linux-x64.tar.gz'
PROGRAMS = ('facade', 'facade-mcp')
FRAMEWORK = ROOT / 'framework'
SUCCESS_MARKER = 'Facade native install test '
REFUSALS = ('corrupted-bytes', 'wrong-digest', 'wrong-build')
REFUSAL_STAGES = ('corrupted', 'wrong-digest', 'wrong-build')
SHA256 = re.compile(r'[0-9a-f]{64}')
VERSION = r'[0-9]+\.[0-9]+\.[0-9]+'
BUILD = VERSION + r'\+[0-9]+\.[0-9a-f]{40}'


def validate_inputs(archive, sidecar, fake, *, local=False):
    if not hasattr(os, 'uname') or (os.uname().sysname, os.uname().machine) != ('Linux', 'x86_64'):
        raise ValueError('this fixture requires native Linux x64')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise ValueError('this fixture requires Linux pidfds for scoped failure cleanup')
    os.close(os.pidfd_open(os.getpid()))
    if not fake.is_file() or not os.access(fake, os.X_OK):
        raise ValueError('the fake CLI executable is missing or cannot run')
    return archive_metadata(archive, sidecar, local=local)


def archive_metadata(archive, sidecar, *, local=False):
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
        marker = package.extractfile('VERSION').read().decode('ascii')
        identity = f'(?:{BUILD}|{VERSION})' if local else BUILD
        if not re.fullmatch(identity + r'\n', marker):
            raise ValueError('the package does not contain a valid build identity')
        digests = {}
        for program in PROGRAMS:
            data = package.extractfile(program).read()
            if data[:6] != b'\x7fELF\x02\x01' or int.from_bytes(data[18:20], 'little') != 62:
                raise ValueError(f'{program} is not an ELF x86-64 executable for {ASSET}')
            digests[program] = sha256(data).hexdigest()
    return marker.removesuffix('\n'), digests, hashes[0], sha256(checksum_bytes).hexdigest()


def installer_args(installer, package, build, *, expected_build=None):
    return ['sh', str(installer), '--version', build.split('+', 1)[0], '--package', str(package),
            '--expected-build', expected_build or build, '--no-path']


def wrong_build(build):
    return f"{build.split('+', 1)[0]}+1.{'0' * 40}"


def refused_package(label, build, stderr):
    if label == 'wrong-build':
        return stderr.startswith(f'facade install: Expected Facade build {wrong_build(build)}, found {build} in the package.')
    return stderr.strip() == f'facade install: SHA-256 verification failed for {ASSET}.'


def corrupted_archive(archive):
    contents = bytearray(archive.read_bytes())
    contents[len(contents) // 2] ^= 1
    return contents


def run_installed_relay(executable, cwd, env, timeout=20):
    argv = [str(executable)]
    initialize = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
        'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'qa', 'version': '1'},
    }}
    follow_up = [
        {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
    ]
    deadline = time.monotonic() + timeout
    with subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE) as relay:
        try:
            relay.stdin.write((json.dumps(initialize) + '\n').encode())
            relay.stdin.flush()
            # Hold the next requests until the relay answers initialize. Read from the
            # pipe directly so communicate can collect any remaining bytes in order.
            first = bytearray()
            while b'\n' not in first:
                left = deadline - time.monotonic()
                if left <= 0 or not select.select([relay.stdout], [], [], left)[0]:
                    raise subprocess.TimeoutExpired(argv, timeout)
                chunk = os.read(relay.stdout.fileno(), 4096)
                if not chunk:
                    break
                first.extend(chunk)
            response = json.loads(first.partition(b'\n')[0]) if first else {}
            ready = isinstance(response, dict) and response.get('id') == 1 and 'result' in response
            payload = ''.join(json.dumps(frame) + '\n' for frame in follow_up).encode() if ready else None
            stdout, stderr = relay.communicate(payload, timeout=max(0, deadline - time.monotonic()))
        finally:
            if relay.poll() is None:
                relay.kill()
    return subprocess.CompletedProcess(argv, relay.returncode, (first + stdout).decode(), stderr.decode())


def relay_ready(stdout, version):
    answers = [json.loads(line) for line in stdout.splitlines()]
    return ([(line['jsonrpc'], line['id']) for line in answers] == [('2.0', 1), ('2.0', 2)]
            and answers[0]['result']['serverInfo'] == {'name': 'facade', 'version': version}
            and {'start_agent', 'list_agents'} <= {tool['name'] for tool in answers[1]['result']['tools']})


def verify_install_commands(commands, scope, address, build, installer):
    bin_dir = scope / 'state/framework/bin'
    shell = str(bin_dir / 'facade')
    project = str(scope / 'project')
    records = iter(commands)

    def observed(label, args, status=0):
        step = next(records, None)
        if step is None or (step['label'], step['args'], step['status']) != (label, args, status):
            raise AcceptanceError(f'native install did not record the exact command and outcome for {label}')
        return step

    def installed_package(label, stage, status=0, expected_build=None):
        return observed(label, installer_args(installer, scope / stage / ASSET, build,
                                              expected_build=expected_build), status)

    screen = [shell, 'screen', address]

    def wait_for_screen(label, marker):
        while marker not in observed(label, screen)['stdout']:
            continue

    installed = installed_package('install candidate', 'candidate')
    unchanged = installed_package('select the same candidate again', 'candidate')
    version_result = observed('installed Shell version', [shell, '--version'])
    started = observed('start fake CLI', [shell, 'start', '-d', '--name', 'installed-agent', '--workdir',
                                          project, 'qa-install', '--', 'candidate argument'])
    wait_for_screen('read original screen', 'Native install fixture')
    listing = observed('list the installed candidate agent', [shell, 'list'])['stdout']
    relay = observed('use installed MCP relay', [str(bin_dir / 'facade-mcp')])
    if (installed['stdout'] != f'Installed Facade {build} in {bin_dir}.\n'
            or unchanged['stdout'] != f'Facade {build} is already up to date in {bin_dir}.\n'
            or version_result['stdout'].strip() != f'facade {build}'
            or started['stdout'] != f'Started installed-agent ({address}) in the background.\n'
            or not any(all(value in line for value in ('installed-agent', address, 'qa-install', project))
                       for line in listing.splitlines())
            or not relay_ready(relay['stdout'], build.split('+', 1)[0])):
        raise AcceptanceError('native install did not observe the installed Shell and MCP relay')

    for label, stage in zip(REFUSALS, REFUSAL_STAGES):
        before = observed(f'screen before {label}', screen)
        pin = wrong_build(build) if label == 'wrong-build' else build
        refusal = installed_package(f'refuse {label}', stage, status=1, expected_build=pin)
        after = observed(f'screen survived {label}', screen)
        if (not refused_package(label, build, refusal['stderr'])
                or after['stdout'] != before['stdout']):
            raise AcceptanceError(f'native install did not refuse {label} and preserve the original screen')
        marker = f'usable after {label}'
        observed(f'use the same fake CLI after {label}', [shell, 'type', address, marker, '--enter'])
        wait_for_screen(f'read screen after {label}', marker)
    observed('stop the fixture agent', [shell, 'stop', address])
    if next(records, None) is not None:
        raise AcceptanceError('native install recorded unexpected commands after stopping the fixture agent')


def install_success(receipt, build, programs, archive_sha, corrupt_sha, *, installer=FRAMEWORK / 'install.sh'):
    try:
        if (receipt['build'], receipt['version'], receipt['program_sha256'], receipt['installer_sha256']) != (
                build, build.split('+', 1)[0], programs, hash_file(installer)):
            raise AcceptanceError('native install did not use the candidate program pair and installer')
        if not build.endswith('.' + receipt['source']['revision']):
            raise AcceptanceError('native install build names a different source revision')
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
        executable = str(scope / 'state/framework/bin' / build / 'facade')
        if (set(services) != {'daemon', 'keeper'} or {record['executable'] for record in services.values()} != {executable}
                or fake['executable'] != str(scope / 'fixture-bin/facade-fakecli')
                or len({record['pid'] for record in (*services.values(), fake)}) != 3
                or not all(type(record['pid']) is int and record['pid'] > 0
                           and type(record['start_ticks']) is int and record['start_ticks'] > 0
                           for record in (*services.values(), fake))):
            raise AcceptanceError('native install did not observe the two candidate services and original CLI')

        tree = receipt['install_tree']
        if any(tuple(tree[name][1:]) != ('link', f'{build}/{name}')
               or tuple(tree[f'{build}/{name}']) != (0o700, 'file', programs[name]) for name in PROGRAMS):
            raise AcceptanceError('native install did not observe the candidate launchers and program bytes')
        settings_sha = receipt['settings_sha256']
        if not SHA256.fullmatch(settings_sha) or not SHA256.fullmatch(receipt['fake_sha256']):
            raise AcceptanceError('native install is missing the settings or fixture program digest')
        original = digest({'install_tree': tree, 'runtime': runtime, 'settings_sha256': settings_sha})
        verify_install_commands(receipt['commands'], scope, address, build, installer)
        refusals = receipt['refusals']
        if set(refusals) != set(REFUSALS):
            raise AcceptanceError('native install did not observe every package refusal')
        for label, proof in refusals.items():
            manifest = '0' * 64 if label == 'wrong-digest' else archive_sha
            if (proof['state_sha256'] != original or proof['live_marker'] != f'usable after {label}'
                    or proof['sidecar_sha256'] != sha256(f'{manifest}  {ASSET}\n'.encode()).hexdigest()
                    or proof['archive_sha256'] != (corrupt_sha if label == 'corrupted-bytes' else archive_sha)):
                raise AcceptanceError(f'native install did not refuse {label} and preserve the working installation')
    except (KeyError, TypeError, IndexError, json.JSONDecodeError) as error:
        raise AcceptanceError('native install observations are incomplete or malformed') from error
    return {'case_ids': list(NATIVE_INSTALL_CASES), 'archive_sha256': archive_sha,
            'evidence_sha256': digest({key: value for key, value in receipt.items() if key != 'success'})}


def verified_install(archive, sidecar, receipt_path, output, run, *, producer_checkout=ROOT, source=None):
    if not producer_checkout.is_absolute():
        raise AcceptanceError('supply the absolute path of the producer checkout')
    receipt = read_json(receipt_path)
    expected = source_identity(run) if source is None else source
    if not isinstance(receipt, dict) or receipt.get('source') != expected or expected['run'] != run:
        raise AcceptanceError('native install receipt does not match this source and attempt')
    if receipt.get('archive_sha256') != hash_file(archive) or receipt.get('sidecar_sha256') != hash_file(sidecar):
        raise AcceptanceError('native install receipt does not match the candidate archive and checksum file')
    try:
        build, programs, archive_sha, sidecar_sha = archive_metadata(archive, sidecar)
    except tarfile.TarError as error:
        raise AcceptanceError('native install candidate is not a readable archive') from error
    if (receipt['archive_sha256'], receipt['sidecar_sha256']) != (archive_sha, sidecar_sha):
        raise AcceptanceError('native install candidate archive or checksum file changed during verification')
    verify_native_cleanup(receipt)
    expected = install_success(receipt, build, programs, archive_sha, sha256(corrupted_archive(archive)).hexdigest(),
                               installer=producer_checkout / 'framework/install.sh')
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
    directory = Path(f'/tmp/facade-framework-{os.getuid()}')
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
    build, digests, expected = (receipt[key] for key in ('build', 'program_sha256', 'archive_sha256'))
    home, state, project, tmp, runtime = (root / name for name in ('home', 'state', 'project', 'tmp', 'runtime'))
    bin_dir = state / 'framework/bin'
    config, cache, data, state_dir = (home / name for name in ('config', 'cache', 'data', 'state'))
    for directory in (home, state, project, tmp, runtime, config, cache, data, state_dir):
        directory.mkdir(mode=0o700)
    env = {key: str(value) for key, value in {
        'CI_ACCEPTANCE_ROOT': root, 'HOME': home, 'FACADE_HOME': state, 'TMPDIR': tmp,
        'PATH': f'{bin_dir}:{SYSTEM_PATH}',
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
    facade = bin_dir / 'facade'
    target = None

    def run(label, argv, *, status=0, relay=False, timeout=20):
        command = [str(item) for item in argv]
        if relay:
            result = run_installed_relay(command[0], project, env, timeout=timeout)
        else:
            result = subprocess.run(command, cwd=project, env=env, text=True, capture_output=True,
                                    timeout=timeout, stdin=subprocess.DEVNULL)
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

    def install_package(label, package, status=0, expected_build=None):
        return run(label, installer_args(FRAMEWORK / 'install.sh', package, build,
                                         expected_build=expected_build), status=status)

    try:
        candidate = stage('candidate', archive, sidecar.read_bytes())
        if hash_file(candidate) != expected or hash_file(candidate.with_name('SHA256SUMS')) != receipt['sidecar_sha256']:
            raise AcceptanceError('candidate archive or checksum file changed while staging')
        installed = install_package('install candidate', candidate)
        assert installed.stdout == f'Installed Facade {build} in {bin_dir}.\n', installed
        before_equal = install_tree(state)
        unchanged = install_package('select the same candidate again', candidate)
        assert unchanged.stdout == f'Facade {build} is already up to date in {bin_dir}.\n', unchanged
        assert install_tree(state) == before_equal
        assert not any(os.path.lexists(endpoint) for endpoint in sockets.values())
        for program, program_sha in digests.items():
            launcher = bin_dir / program
            assert os.readlink(launcher) == f'{build}/{program}'
            assert hash_file(launcher) == program_sha and os.access(launcher, os.X_OK), program
        assert run('installed Shell version', [facade, '--version']).stdout.strip() == f'facade {build}'
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

        mcp = run('use installed MCP relay', [bin_dir / 'facade-mcp'], relay=True)
        assert relay_ready(mcp.stdout, build.split('+', 1)[0]), mcp

        def observe():
            hello, status = query(sockets['daemon'], 'daemon.status', {})
            _, inspected = query(sockets['daemon'], 'agent.inspect', {'target': target})
            row = inspected['agent']
            reference = {'machine_id': hello['machine_id'], 'agent_id': target.split('@', 1)[0]}
            assert (status['home'], status['build'], status['daemon_pid']) == (str(state), build, hello['pid'])
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
            db = state / 'framework/facade.db'
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
        tree = install_tree(bin_dir)
        receipt['install_tree'] = tree
        receipt['settings_sha256'] = sha256(settings_before).hexdigest()
        corrupt = stage('corrupted', candidate, f'{expected}  {ASSET}\n'.encode())
        corrupt.write_bytes(corrupted_archive(candidate))
        wrong_digest = stage('wrong-digest', candidate, f'{"0" * 64}  {ASSET}\n'.encode())
        wrong_pin = stage('wrong-build', candidate, f'{expected}  {ASSET}\n'.encode())
        for label, package in zip(REFUSALS, (corrupt, wrong_digest, wrong_pin)):
            before_input = keys.read_bytes()
            before_screen = run(f'screen before {label}', [facade, 'screen', target]).stdout
            pin = wrong_build(build) if label == 'wrong-build' else build
            result = install_package(f'refuse {label}', package, status=1, expected_build=pin)
            assert refused_package(label, build, result.stderr), result
            current_tree, current_settings, current = install_tree(bin_dir), settings.read_bytes(), observe()
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
        build, digests, expected, checksum = validate_inputs(archive, sidecar, fake)
        if not build.endswith('.' + source['revision']):
            raise ValueError('candidate archive names a different source revision')
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(2, f'native install check: {error}\n')
    signal.signal(signal.SIGTERM, interrupted)
    receipt = {'source': source, 'archive': str(archive), 'archive_sha256': expected, 'sidecar_sha256': checksum,
               'installer_sha256': hash_file(FRAMEWORK / 'install.sh'), 'fake_sha256': hash_file(fake),
               'build': build, 'version': build.split('+', 1)[0], 'program_sha256': digests,
               'commands': [], 'refusals': {}}
    started = time.monotonic()
    try:
        exercise(archive, sidecar, fake, receipt)
    finally:
        receipt['elapsed_seconds'] = round(time.monotonic() - started, 3)
        if args.receipt is not None:
            write_receipt(args.receipt, receipt)
    verify_native_cleanup(receipt)
    receipt['success'] = install_success(receipt, build, digests, expected, sha256(corrupted_archive(archive)).hexdigest())
    if args.receipt is not None:
        write_receipt(args.receipt, receipt)
    print(SUCCESS_MARKER + json.dumps(receipt['success'], separators=(',', ':')))


if __name__ == '__main__':
    main()
