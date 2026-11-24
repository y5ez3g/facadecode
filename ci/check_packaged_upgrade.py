#!/usr/bin/env python3
"""Rehearse a live upgrade between digest-pinned Linux x64 Framework archives."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
from uuid import UUID

from catalog import AcceptanceError
from check_native_install import (
    ASSET, PROGRAMS, archive_metadata, installer_args, relay_ready, run_installed_relay, validate_inputs,
)
from check_prior_build import binary_hashes
from evidence import digest, run_identity
from native_framework import (
    ROOT, SYSTEM_PATH, clean_native_scope, hash_file, interrupted, process_identity, query,
    source_identity, verify_native_cleanup, wait_for, write_receipt,
)


INSTALLER = ROOT / 'framework/install.sh'
SESSION = '065e033f-12fe-4bac-9870-dc4e3d4971af'
ORIGINAL = 'original receipt before packaged upgrade'
FRESH = 'fresh receipt after packaged upgrade'


def package_identity(role, archive, checksums, pin, metadata):
    build, programs, archive_sha, checksums_sha = metadata
    if archive_sha != pin:
        raise AcceptanceError(f'{role} archive does not match the supplied SHA-256 pin')
    return {'archive': str(archive), 'checksums': str(checksums), 'build': build,
            'version': build.split('+', 1)[0],
            'archive_sha256': archive_sha, 'checksums_sha256': checksums_sha, 'program_sha256': programs}


def stage_archive(folder, package):
    folder.mkdir(mode=0o700)
    archive, checksums = folder / ASSET, folder / 'SHA256SUMS'
    shutil.copyfile(package['archive'], archive)
    shutil.copyfile(package['checksums'], checksums)
    if (hash_file(archive), hash_file(checksums)) != (package['archive_sha256'], package['checksums_sha256']):
        raise AcceptanceError(f'{folder.name} archive or checksums changed while staging')
    return archive


def installed_programs(runtime, package):
    build = Path(package['build'])
    for name in PROGRAMS:
        assert (runtime / name).readlink() == build / name, name
    observed = {
        'external': binary_hashes(runtime), 'runtime': binary_hashes(runtime / build),
        'current': str(build),
    }
    assert observed['external'] == observed['runtime'] == package['program_sha256'], observed
    return observed


def exercise(scope, sockets, receipt, fake):
    home, state, project, tmp, runtime, transcripts = (
        scope / name for name in ('home', 'state', 'project', 'tmp', 'runtime', 'transcripts')
    )
    bin_dir = state / 'framework/bin'
    for folder in (home, state, project, tmp, runtime, transcripts):
        folder.mkdir(mode=0o700)
    key = sha256(os.fsencode(state)).hexdigest()[:10]
    for role in ('daemon', 'keeper'):
        endpoint = Path(f'/tmp/facade-framework-{os.getuid()}/{role}-{key}.sock')
        if os.path.lexists(endpoint):
            raise AcceptanceError(f'fixture socket path already exists: {endpoint}')
        sockets[role] = endpoint
    endpoint = sockets['daemon']
    staged_fake = scope / 'facade-fakecli'
    shutil.copy2(fake, staged_fake)
    if hash_file(staged_fake) != receipt['fake_sha256']:
        raise AcceptanceError('the fake CLI changed while staging')
    packages = {role: stage_archive(scope / role, receipt[role]) for role in ('prior', 'candidate')}
    env = {key: str(value) for key, value in {
        'CI_ACCEPTANCE_ROOT': scope, 'HOME': home, 'FACADE_HOME': state, 'TMPDIR': tmp,
        'XDG_RUNTIME_DIR': runtime, 'PATH': f'{bin_dir}:{SYSTEM_PATH}',
        'TERM': 'xterm-256color', 'LC_ALL': 'C.UTF-8',
    }.items()}
    keys, starts = scope / 'keys', scope / 'starts'
    settings = state / 'facade.json'
    # The stand-in reports a real session through the packaged Shell's session-start hook.
    settings.write_text(json.dumps({'clis': {'qa-upgrade': {
        'type': 'claude', 'command': str(staged_fake),
        'env': {'FAKECLI_LOOK': 'claude', 'FAKECLI_SESSION': SESSION, 'FAKECLI_STATUS': '1',
                'FAKECLI_KEYS': str(keys), 'FAKECLI_STARTS': str(starts),
                'FAKECLI_TRANSCRIPTS': str(transcripts)},
    }}}) + '\n')
    settings_sha = hash_file(settings)
    transcript = transcripts / f'{SESSION}.jsonl'
    facade = bin_dir / 'facade'

    def command(label, argv, *, relay=False):
        args = list(map(str, argv))
        if relay:
            result = run_installed_relay(args[0], project, env)
        else:
            result = subprocess.run(args, cwd=project, env=env, text=True, capture_output=True,
                                    timeout=45, stdin=subprocess.DEVNULL)
        receipt['commands'].append({'label': label, 'args': args, 'status': result.returncode,
                                    'stdout': result.stdout, 'stderr': result.stderr})
        assert result.returncode == 0, (label, result)
        return result.stdout

    def install_package(role):
        build = receipt[role]['build']
        installed = command(f'install {role}', installer_args(INSTALLER, packages[role], build))
        assert f'Installed Facade {build} in {bin_dir}.' in installed.splitlines(), installed

    def verify_shell_build(role):
        reported = command(f'read {role} Shell version', [facade, '--version'])
        build = receipt[role]['build']
        assert reported.strip() == f'facade {build}', reported

    def inspect(target):
        return query(endpoint, 'agent.inspect', {'target': target})[1]['agent']

    def observe(role, target):
        package = receipt[role]
        hello, status = query(endpoint, 'daemon.status', {})
        build = hello['build']
        assert build == package['build'], (role, hello)
        assert (status['home'], status['build'], status['daemon_pid'], status['agent_count']) == (
            str(state), build, hello['pid'], 1), status
        agent = inspect(target)
        reference = {'machine_id': str(UUID(hello['machine_id'])), 'agent_id': 'a1'}
        assert (agent['reference'], agent['address'], agent['name'], agent['cli'], agent['cwd'],
                agent['process'], agent['session']) == (
            reference, target, 'upgrade-agent', 'qa-upgrade', str(project), 'running', SESSION), agent
        processes = {name: process_identity(pid) for name, pid in (
            ('daemon', hello['pid']), ('keeper', status['keeper_pid']), ('cli', agent['pid']),
        )}
        assert processes['daemon']['executable'] == str(bin_dir / build / 'facade'), processes
        assert processes['cli']['executable'] == str(staged_fake), processes
        assert starts.read_text().splitlines() == [str(agent['pid'])], starts
        assert hash_file(settings) == settings_sha, settings
        return {'hello': hello, 'agent': agent, 'processes': processes,
                'programs': installed_programs(bin_dir, package), 'settings_sha256': settings_sha}

    def request(text, request_id):
        return {'to': reference, 'text': text, 'request_id': request_id}

    def send(params):
        return query(endpoint, 'agent.send', params)[1]

    def submitted(item, text, *, legacy_header=False):
        message = item['message']
        delivery = message['delivery']
        assert (item['recipient']['reference'], message['text'], delivery['status'],
                delivery['text_written'], delivery['enter_written']) == (
            reference, text, 'success', 'full', True), item
        message_id = message['message_id']
        if legacy_header:
            return f'📨 Message from the command line · {message_id}\n{text}'
        return f'📨 Message {message_id} from command line\n{text}'

    def submissions():
        return [json.loads(line)['message'] for line in transcript.read_text().splitlines()]

    install_package('prior')
    verify_shell_build('prior')
    started = command('start the fake CLI through the prior Shell', [
        facade, 'start', '-d', '--name', 'upgrade-agent', '--workdir', project, 'qa-upgrade',
    ])
    match = re.fullmatch(r'Started upgrade-agent \((a1@[^)]+)\) in the background\.\n', started)
    assert match, started
    target = match[1]
    reference = inspect(target)['reference']
    original_request = request(ORIGINAL, 'packaged-upgrade-original')
    original = receipt['original_receipt'] = send(original_request)
    assert 'repeated' not in original, original
    prior_headers = [[submitted(original, ORIGINAL)], [submitted(original, ORIGINAL, legacy_header=True)]]
    wait_for('the original submission', lambda: transcript.is_file() and submissions() in prior_headers)
    original_submission = submissions()[0]
    original_keys = keys.read_bytes()
    assert original_keys.count(ORIGINAL.encode()) == 1, original_keys

    # The CLI's hook reports the selected session at launch. Facade publishes it after
    # the CLI writes its transcript, which the first submitted message creates.
    wait_for('the original saved session', lambda: inspect(target).get('session') == SESSION)
    before = receipt['before'] = observe('prior', target)
    keeper = before['hello']['keeper']
    assert keeper == {'pid': before['processes']['keeper']['pid'], 'build': before['hello']['build']}, keeper
    assert before['processes']['keeper']['executable'] == before['processes']['daemon']['executable'], before

    old_daemon = os.pidfd_open(before['processes']['daemon']['pid'])
    try:
        install_package('candidate')
        # Only the installer may activate the upgrade. Observe through the raw socket
        # before any candidate Shell command that could initiate a takeover on connect.
        after = receipt['after'] = observe('candidate', target)
        assert after['processes']['daemon']['pid'] != before['processes']['daemon']['pid'], after
        assert select.select([old_daemon], [], [], 20)[0], 'the old daemon has not exited'
    finally:
        os.close(old_daemon)
    assert after['hello']['keeper'] == keeper, after
    assert all(after['processes'][role] == before['processes'][role] for role in ('keeper', 'cli')), after
    assert after['agent']['reference'] == before['agent']['reference'], after
    verify_shell_build('candidate')
    daemon_log = (state / 'framework/logs/daemon.log').read_text()
    receipt['keeper_api_versions'] = {}
    for role, observation in (('prior', before), ('candidate', after)):
        connected = re.search(
            rf'daemon\[{observation["hello"]["pid"]}\] info: connected to keeper {keeper["pid"]}'
            rf' \(Keeper API ([1-9][0-9]*), build {re.escape(keeper["build"])}\)', daemon_log,
        )
        assert connected, (role, daemon_log)
        receipt['keeper_api_versions'][role] = int(connected[1])
    assert keys.read_bytes() == original_keys and submissions() == [original_submission]

    screen = command('read the original screen through the candidate Shell', [facade, 'screen', target])
    assert ORIGINAL in screen, screen
    mcp = command('use the candidate MCP relay', [bin_dir / 'facade-mcp'], relay=True)
    assert relay_ready(mcp, receipt['candidate']['version']), mcp

    repeated = receipt['repeated_receipt'] = send(original_request)
    assert repeated['repeated'] is True and repeated['id'] == original['id'], repeated
    assert repeated['message'] == original['message'] and repeated['recipient']['reference'] == reference, repeated
    assert keys.read_bytes() == original_keys and submissions() == [original_submission]
    fresh = receipt['fresh_receipt'] = send(request(FRESH, 'packaged-upgrade-fresh'))
    assert fresh['id'] != original['id'], fresh
    expected = [original_submission, submitted(fresh, FRESH)]
    wait_for('one fresh submission', lambda: submissions() == expected)
    final_keys = keys.read_bytes()
    assert final_keys.startswith(original_keys) and final_keys[len(original_keys):].count(FRESH.encode()) == 1
    assert process_identity(after['agent']['pid']) == before['processes']['cli']
    receipt['submissions'], receipt['cli_input_hex'] = submissions(), final_keys.hex()
    command('stop the fixture agent', [facade, 'stop', target])


def main():
    if not __debug__:
        raise SystemExit('run the packaged upgrade check with Python assertions enabled')
    parser = argparse.ArgumentParser(description=__doc__)
    for role in ('prior', 'candidate'):
        parser.add_argument(f'--{role}-archive', type=Path, required=True)
        parser.add_argument(f'--{role}-checksums', type=Path, required=True)
        parser.add_argument(f'--{role}-sha256', required=True, help='independently pinned archive digest')
    parser.add_argument('--fake-executable', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--run-id', required=True, help='unique local QA attempt')
    args = parser.parse_args()
    try:
        source = source_identity(run_identity(args.run_id, {}))
        fake = args.fake_executable.resolve()
        prior = package_identity('prior', args.prior_archive.absolute(), args.prior_checksums.absolute(),
                                 args.prior_sha256, validate_inputs(args.prior_archive, args.prior_checksums, fake, local=True))
        candidate = package_identity('candidate', args.candidate_archive.absolute(), args.candidate_checksums.absolute(),
                                     args.candidate_sha256, archive_metadata(args.candidate_archive, args.candidate_checksums, local=True))
        if tuple(map(int, candidate['version'].split('.'))) <= tuple(map(int, prior['version'].split('.'))):
            raise AcceptanceError('live upgrade requires a candidate with a higher numeric version than the prior archive')
        receipt = {'source': source, 'mode': 'local-qa', 'target': 'linux-x64', 'prior': prior, 'candidate': candidate,
                   'installer_sha256': hash_file(INSTALLER), 'harness_sha256': hash_file(Path(__file__)),
                   'fake_sha256': hash_file(fake), 'commands': []}
        args.output_dir.mkdir(parents=True)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(2, f'packaged upgrade: {error}\n')

    signal.signal(signal.SIGTERM, interrupted)
    scope = Path(tempfile.mkdtemp(prefix='fci-package-upgrade-', dir='/tmp'))
    sockets = {}
    receipt['scope'] = str(scope)
    try:
        try:
            exercise(scope, sockets, receipt, fake)
        finally:
            try:
                logs = scope / 'state/framework/logs'
                receipt['service_logs'] = {log.name: log.read_text() for log in sorted(logs.glob('*.log'))}
            finally:
                clean_native_scope(scope, sockets, receipt)
        verify_native_cleanup(receipt)
        receipt['success'] = {'mode': receipt['mode'], 'evidence_sha256': digest(receipt)}
    except (AssertionError, OSError, RuntimeError, ValueError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        receipt['error'] = str(error)
        print(f'packaged upgrade: {error}', file=sys.stderr)
    finally:
        write_receipt(args.output_dir / 'receipt.json', receipt)
    if 'success' not in receipt:
        return 1
    print('Facade packaged upgrade QA ' + json.dumps(receipt['success'], separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
