#!/usr/bin/env python3
"""Check a real Facade Code Framework machine route with a private Linux OpenSSH peer.

Run beside framework/scripts/ssh-check.sh after it has built the three test binaries.
"""

import argparse
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from catalog import AcceptanceError, NATIVE_SSH_CASE, read_json
from evidence import digest, run_identity
from native_framework import (
    SYSTEM_PATH, clean_native_scope, hash_file, interrupted, process_identity, query,
    read_markers, source_identity, verify_native_cleanup, wait_for, write_receipt,
)


PROGRAMS = ('facade', 'facade-mcp', 'facade-fakecli')
INPUT = '界\r'.encode()
SSHD = '/usr/sbin/sshd'
SUCCESS_MARKER = 'Facade native SSH route test '
REFUSE_UNKNOWN_MACHINE = 'error: No machine matches "qa-absent".'


def program_files(bin_dir):
    programs = {name: (bin_dir / name).resolve() for name in PROGRAMS}
    for path in programs.values():
        if not path.is_file() or not os.access(path, os.X_OK):
            raise AcceptanceError(f'missing executable {path}')
    return programs


def verified_ssh(bin_dir, receipt_path, output, run):
    receipt = read_json(receipt_path)
    if not isinstance(receipt, dict) or receipt.get('source') != source_identity(run):
        raise AcceptanceError('native SSH receipt does not match this source and attempt')
    digests = {name: hash_file(path) for name, path in program_files(bin_dir).items()}
    if receipt.get('program_sha256') != digests:
        raise AcceptanceError('native SSH evidence did not match the case and the checked programs')
    verify_native_cleanup(receipt)
    expected = ssh_success(receipt)
    if receipt.get('success') != expected or read_markers(output, SUCCESS_MARKER) != [expected]:
        raise AcceptanceError('native SSH case marker did not match the original route observations')


def ssh_success(receipt):
    def require(condition, explanation):
        if not condition:
            raise AcceptanceError(f'native SSH did not observe {explanation}')

    try:
        scope = Path(receipt['scope'])
        programs = scope / 'bin'
        machines = receipt['machines']
        origin, peer = machines['origin'], machines['peer']
        route, inspect = receipt['route'], receipt['inspect']
        intended = inspect['peer']
        local = receipt['unrelated_before']
        decoy = local['agent']
        ref = intended['reference']
        require(isinstance(origin, str) and isinstance(peer, str) and origin and peer and origin != peer,
                'two distinct machine identities')
        require(route['machine_id'] == peer and route['route'] == [peer]
                and route['state'] == 'online' and route['name'] == 'qa-peer', 'the exact online SSH route')
        require(receipt['link'] == [
            str(programs / 'facade'), 'machine', 'connect', '--home', str(scope / 'peer-facade'),
            '-F', str(scope / 'ssh_config'), 'fixture-peer',
        ], 'the expected machine connect invocation')
        sshd = receipt['sshd.log']
        require('Server listening on 127.0.0.1 port ' in sshd
                and sum('Accepted publickey' in line and ' from 127.0.0.1 port ' in line
                        for line in sshd.splitlines()) >= 2, 'both authenticated OpenSSH sessions')
        require(inspect['origin'] == intended
                and ref['machine_id'] == peer and re.fullmatch(r'a[1-9][0-9]*', ref['agent_id'])
                and intended['address'] == f'{ref["agent_id"]}@qa-peer'
                and intended['cwd'] == str(scope / 'peer-work'), 'the same exact peer agent through both connections')
        require(decoy['reference'] == {'machine_id': origin, 'agent_id': ref['agent_id']}
                and decoy['address'] == f'{ref["agent_id"]}@qa-origin'
                and decoy['cwd'] == str(scope / 'origin-work') and decoy['pid'] != intended['pid'],
                'a different live local agent with the same agent number')
        for agent in (intended, decoy):
            require(type(agent['pid']) is int and agent['pid'] > 0
                    and type(agent['start_ticks']) is int and agent['start_ticks'] > 0
                    and agent['executable'] == str(programs / 'facade-fakecli'),
                    'the expected fake process and its birth identity')
        require(local['input_hex'] == '' and isinstance(local['settings'], list)
                and len(local['settings']) == 2 and all(re.fullmatch(r'[0-9a-f]{64}', item) for item in local['settings'])
                and receipt['unrelated_after'] == local
                and receipt['refusal'] == {'peer_input_hex': '', 'unrelated': local},
                'an unchanged local decoy and known-empty input after the refused route')
        require(receipt['peer_effect'] == {**intended, 'input_hex': INPUT.hex()}
                and receipt['peer_stopped'] == {'reference': ref, 'process': 'ended'},
                'the exact remote input and selected stop')
        commands = receipt['commands']
        by_label = {entry['label']: entry for entry in commands if entry['label'] != 'start the route fixture agent'}
        starts = [entry for entry in commands if entry['label'] == 'start the route fixture agent']
        start = [str(programs / 'facade'), 'start', '-d']
        worker = ['--name', 'route-worker', '--workdir']
        require([entry['argv'] for entry in starts] == [
            [*start, *worker, decoy['cwd'], 'qa-route'],
            [*start, '--machine', 'qa-peer', *worker, intended['cwd'], 'qa-route'],
        ] and len(by_label) == len(commands) - 2
                and all(command['status'] == (1 if command['label'] == 'refuse unmapped machine' else 0)
                        for command in commands), 'the expected command results')
        require('launch the peer over OpenSSH' in by_label and 'launch the origin' in by_label
                and REFUSE_UNKNOWN_MACHINE in by_label['refuse unmapped machine']['stderr'].splitlines()
                and by_label['type exact UTF-8 plus Enter on the SSH peer']['argv'][1:] == [
                    'type', intended['address'], '--key', '界', '--key', 'Enter',
                ]
                and by_label['stop the exact peer agent']['argv'][1:] == ['stop', intended['address']],
                'the recorded refusal, exact remote input command and selected stop command')
    except (AttributeError, KeyError, TypeError) as error:
        raise AcceptanceError('native SSH route observations are incomplete or malformed') from error
    return {
        'case_id': NATIVE_SSH_CASE,
        'program_sha256': receipt['program_sha256'],
        'observations_sha256': digest({key: value for key, value in receipt.items() if key != 'success'}),
    }


def machine(scope, name, programs, sockets):
    login, home, work, runtime = (scope / f'{name}-{part}' for part in ('login', 'facade', 'work', 'runtime'))
    for folder in (login, home, work, runtime):
        folder.mkdir(mode=0o700)
    install = home / 'framework/bin'
    install.mkdir(parents=True)
    for program in PROGRAMS[:2]:
        shutil.copy2(programs[program], install / program)

    settings = home / 'facade.json'
    settings.write_text(json.dumps({'clis': {'qa-route': {
        'type': 'custom',
        'command': str(programs['facade-fakecli']),
        'env': {'FAKECLI_STARTS': str(work / 'starts'), 'FAKECLI_KEYS': str(work / 'keys')},
    }}}) + '\n')
    env = {
        'PATH': SYSTEM_PATH, 'HOME': str(login), 'FACADE_HOME': str(home),
        'TMPDIR': str(scope), 'CI_ACCEPTANCE_ROOT': str(scope),
        'XDG_RUNTIME_DIR': str(runtime), 'LC_ALL': 'C.UTF-8',
    }
    key = hashlib.sha256(os.fsencode(home)).hexdigest()[:10]
    for role in ('daemon', 'keeper'):
        endpoint = Path(f'/tmp/facade-framework-{os.getuid()}/{role}-{key}.sock')
        if os.path.lexists(endpoint):
            raise ValueError(f'fixture socket already exists at {endpoint}')
        sockets[f'{name}-{role}'] = endpoint
    return env, work, settings


def ssh_configs(scope, peer, port, run):
    for key in ('client', 'host'):
        run(f'generate fixture {key} key', ['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', scope / key])
    shutil.copyfile(scope / 'client.pub', scope / 'authorized_keys')
    host_key = ' '.join((scope / 'host.pub').read_text().split()[:2])
    (scope / 'known_hosts').write_text(f'[127.0.0.1]:{port} {host_key}\n')
    exported = ' '.join(f'{name}={value}' for name, value in peer.items() if name != 'PATH')
    user = pwd.getpwuid(os.getuid()).pw_name
    server = scope / 'sshd_config'
    server.write_text(f'''Port {port}
ListenAddress 127.0.0.1
HostKey {scope}/host
PidFile {scope}/sshd.pid
AuthorizedKeysFile {scope}/authorized_keys
StrictModes no
PermitRootLogin no
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowUsers {user}
DisableForwarding yes
PermitUserRC no
PermitUserEnvironment no
PrintMotd no
PrintLastLog no
SetEnv {exported}
LogLevel VERBOSE
''')
    client = scope / 'ssh_config'
    client.write_text(f'''Host fixture-peer
    HostName 127.0.0.1
    Port {port}
    User {user}
    IdentityFile {scope}/client
    IdentitiesOnly yes
    IdentityAgent none
    UserKnownHostsFile {scope}/known_hosts
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    BatchMode yes
    ConnectTimeout 2
''')
    return server, client


def exercise(scope, programs, sockets, children, evidence):
    source, source_work, source_settings = machine(scope, 'origin', programs, sockets)
    peer, peer_work, peer_settings = machine(scope, 'peer', programs, sockets)
    origin_socket, peer_socket = sockets['origin-daemon'], sockets['peer-daemon']
    facade = programs['facade']

    def run(label, argv, env=source, status=0):
        command = list(map(str, argv))
        result = subprocess.run(command, cwd=scope, env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=20)
        evidence['commands'].append({'label': label, 'argv': command, 'status': result.returncode,
                                     'stdout': result.stdout, 'stderr': result.stderr})
        assert result.returncode == status, (label, result)
        return result

    def launch(argv, log):
        with log.open('w') as stream:
            child = subprocess.Popen(argv, cwd=scope, env=source, stdin=subprocess.DEVNULL,
                                     stdout=stream, stderr=subprocess.STDOUT)
        children.append(child)
        return child

    def start(work, remote=()):
        result = run('start the route fixture agent', [facade, 'start', '-d', *remote,
                     '--name', 'route-worker', '--workdir', work, 'qa-route'])
        started = re.fullmatch(r'Started route-worker \((a\d+@[^)]+)\) in the background\.\n', result.stdout)
        assert started, result
        starts = work / 'starts'
        wait_for('one fake CLI startup',
                 lambda: starts.is_file() and starts.read_text().strip().isdecimal() and (work / 'keys').is_file())
        return started[1]

    def inspect(endpoint, reference, work, address):
        _, result = query(endpoint, 'agent.inspect', {'target': reference})
        agent = result['agent']
        pid = int((work / 'starts').read_text().strip())
        assert (agent['reference'], agent['address'], agent['pid'], agent['cwd'], agent['process']) == (
            reference, address, pid, str(work), 'running'), agent
        identity = process_identity(pid)
        assert Path(identity['executable']) == programs['facade-fakecli'], identity
        assert (Path('/proc') / str(pid) / 'cwd').resolve(strict=True) == work
        return {**identity, 'reference': reference, 'address': address, 'cwd': str(work)}

    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    server_config, client_config = ssh_configs(scope, peer, port, run)
    ssh_log, link_log = (scope / name for name in ('sshd.log', 'link.log'))
    server = launch([SSHD, '-D', '-e', '-f', server_config], ssh_log)
    wait_for('the private sshd to listen', lambda: 'Server listening' in ssh_log.read_text(), seconds=5)
    assert server.poll() is None, ssh_log.read_text()
    remote = ('printf "%s\\n%s\\n" "$HOME" "$FACADE_HOME"; '
              'exec "$FACADE_HOME/framework/bin/facade" daemon --detach')
    boot = run('launch the peer over OpenSSH', ['/usr/bin/ssh', '-F', client_config, 'fixture-peer', remote])
    assert boot.stdout.splitlines()[:2] == [peer['HOME'], peer['FACADE_HOME']], boot
    run('launch the origin', [facade, 'daemon', '--detach'])
    ids = []
    for name, endpoint, env in (('origin', origin_socket, source), ('peer', peer_socket, peer)):
        hello, _ = query(endpoint, 'daemon.status', {})
        ids.append(hello['machine_id'])
        run(f'name the {name}', [facade, 'machine', 'rename', ids[-1].replace('-', ''), f'qa-{name}'], env)
    origin_id, peer_id = ids
    assert origin_id != peer_id
    evidence['machines'] = {'origin': origin_id, 'peer': peer_id}
    decoy_address = start(source_work)
    decoy = {'machine_id': origin_id, 'agent_id': decoy_address.split('@')[0]}

    command = [facade, 'machine', 'connect', '--home', peer['FACADE_HOME'], '-F', client_config, 'fixture-peer']
    evidence['link'] = list(map(str, command))
    link = launch(command, link_log)

    def route():
        assert link.poll() is None, link_log.read_text()
        _, roster = query(origin_socket, 'machine.list', {})
        return next((entry for entry in roster['machines'] if entry['machine_id'] == peer_id
                     and entry.get('route') == [peer_id] and entry['state'] == 'online'), None)

    evidence['route'] = wait_for('the exact online SSH peer', route)
    assert evidence['route']['name'] == 'qa-peer', evidence['route']
    assert ssh_log.read_text().count('Accepted publickey') >= 2, ssh_log.read_text()
    address = start(peer_work, ('--machine', 'qa-peer'))
    reference = {'machine_id': peer_id, 'agent_id': address.split('@')[0]}
    assert reference['agent_id'] == decoy['agent_id'] and address != decoy_address
    direct = inspect(peer_socket, reference, peer_work, address)
    routed = inspect(origin_socket, reference, peer_work, address)
    assert routed == direct
    evidence['inspect'] = {'peer': direct, 'origin': routed}

    def unrelated():
        local = inspect(origin_socket, decoy, source_work, decoy_address)
        return {'agent': local, 'input_hex': (source_work / 'keys').read_bytes().hex(),
                'settings': [hash_file(path) for path in (source_settings, peer_settings)]}

    before = unrelated()
    assert before['agent']['pid'] != direct['pid']
    assert not before['input_hex'] and (peer_work / 'keys').read_bytes() == b''
    rejected = run('refuse unmapped machine', [facade, 'type', f"{reference['agent_id']}@qa-absent",
                   '--key', 'x', '--key', 'Enter'], status=1)
    after_refusal, peer_input = unrelated(), (peer_work / 'keys').read_bytes()
    assert REFUSE_UNKNOWN_MACHINE in rejected.stderr.splitlines(), rejected
    assert peer_input == b'' and after_refusal == before
    evidence['refusal'] = {'peer_input_hex': peer_input.hex(), 'unrelated': after_refusal}

    run('type exact UTF-8 plus Enter on the SSH peer', [facade, 'type', address, '--key', '界', '--key', 'Enter'])
    wait_for('remote raw input bytes', lambda: (peer_work / 'keys').read_bytes() == INPUT)
    assert inspect(origin_socket, reference, peer_work, address) == direct
    evidence['peer_effect'] = {**direct, 'input_hex': (peer_work / 'keys').read_bytes().hex()}
    run('stop the exact peer agent', [facade, 'stop', address])
    _, stopped = query(peer_socket, 'agent.inspect', {'target': reference})
    ended = stopped['agent']
    assert (ended['reference'], ended['process']) == (reference, 'ended'), stopped
    evidence['peer_stopped'] = {'reference': ended['reference'], 'process': ended['process']}
    evidence['unrelated_before'], evidence['unrelated_after'] = before, unrelated()
    assert evidence['unrelated_after'] == before
    assert (source_work / 'starts').read_text().splitlines() == [str(before['agent']['pid'])]
    assert (peer_work / 'starts').read_text().splitlines() == [str(direct['pid'])]


def main():
    if not __debug__:
        raise SystemExit('run the SSH route test with Python assertions enabled')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, required=True,
                        help='directory with the facade, facade-mcp and facade-fakecli binaries used by ssh-check.sh')
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--run-id', help='the local acceptance attempt ID')
    args = parser.parse_args()
    if (sys.platform != 'linux' or os.uname().machine != 'x86_64' or os.getuid() == 0 or not hasattr(os, 'pidfd_open')
            or not hasattr(signal, 'pidfd_send_signal') or not os.access(SSHD, os.X_OK)):
        parser.error('requires unprivileged Linux x64, OpenSSH server and pidfds')
    try:
        os.close(os.pidfd_open(os.getpid()))
        programs = program_files(args.bin_dir)
        source = source_identity(run_identity(args.run_id, os.environ))
        digests = {name: hash_file(path) for name, path in programs.items()}
    except (AcceptanceError, OSError) as error:
        parser.exit(2, f'native SSH route check: {error}\n')

    signal.signal(signal.SIGTERM, interrupted)
    scope = Path(tempfile.mkdtemp(prefix='fci-ssh-route-', dir='/tmp'))
    evidence = {'source': source, 'scope': str(scope), 'program_sha256': digests, 'commands': []}
    sockets, children = {}, []
    started = time.monotonic()
    try:
        private_bin = scope / 'bin'
        private_bin.mkdir()
        staged = {name: Path(shutil.copy2(path, private_bin / name)) for name, path in programs.items()}
        if {name: hash_file(path) for name, path in staged.items()} != digests:
            raise AcceptanceError('the SSH route programs changed while making the fixture copies')
        exercise(scope, staged, sockets, children, evidence)
    finally:
        try:
            for child in reversed(children):
                if child.poll() is None:
                    child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    # The shared pidfd cleanup also covers the SSH children.
                    continue
            for name in ('sshd.log', 'link.log'):
                log = scope / name
                if log.exists():
                    evidence[name] = log.read_text()
        finally:
            try:
                clean_native_scope(scope, sockets, evidence)
            finally:
                evidence['elapsed_seconds'] = round(time.monotonic() - started, 3)
                write_receipt(args.receipt, evidence)
    evidence['success'] = ssh_success(evidence)
    write_receipt(args.receipt, evidence)
    print(SUCCESS_MARKER + json.dumps(evidence['success'], separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
