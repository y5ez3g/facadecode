#!/usr/bin/env python3
"""Run native Linux x64 Core cold cutover with an explicitly identified prior build."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib

from catalog import AcceptanceError, NATIVE_PRIOR_CASE, read_json
from evidence import digest, execute, git, observed_core_tests, run_identity
from native_core import (
    ROOT, SYSTEM_PATH, clean_native_scope, hash_file, interrupted, read_markers,
    source_identity, verify_native_cleanup, write_receipt,
)


SELECTOR = 'cold_cutover_keeps_prerelease_agent_records_and_saved_transport'
PRIOR_MAIN = '870891350e49c75dec316b9df37554557e257263'
TARGET = 'x86_64-unknown-linux-musl'
PROGRAMS = ('facade', 'facade-mcp')
TRACE = 'Facade cold cutover evidence '
SUCCESS_MARKER = 'Facade native prior build test '
RUN_LOG = 'cold-cutover.log'
HOME_LOG = 'scenario-homes.txt'
SESSION = '86da4482-2bae-4a45-b193-a5664c19826a'
DELIVERY_TEXT = 'cold cutover delivery from the old Daemon'
HEX_DIGEST = re.compile(r'[0-9a-f]{64}')
PRIOR_BUILD_ARGS = ('build', '--locked', '--release', '--target', TARGET, '-p', 'facade', '-p', 'facade-relay',
                    '--bin', 'facade', '--bin', 'facade-mcp')
PRIOR_BUILD_LOGS = ('prior-source.log', 'prior-rustc.log', 'prior-build.log')
CANDIDATE_BUILD_LOGS = ('candidate-facade-fakecli.log', 'candidate-machines.log')
TEST_ARGS = ('--show-output', '--ignored', '--exact', '--test-threads=1', SELECTOR)


def harness_hashes():
    return {path: hash_file(ROOT / path) for path in (
        'ci/check_prior_build.py', 'ci/native_core.py', 'ci/evidence.py',
        'core/tests/tests/machines.rs', 'core/tests/src/bin/facade-fakecli.rs',
    )}


def owned_homes(log, test_tmp):
    homes = []
    if log.is_file():
        for line in log.read_text().splitlines():
            home = Path(line)
            if not home.is_absolute() or not home.resolve().is_relative_to(test_tmp):
                raise AcceptanceError(f'scenario reported an unowned home {home}')
            homes.append(home)
    return homes


def cold_observation(output, scope):
    output_log = output / RUN_LOG
    home_log = output / HOME_LOG
    if not observed_core_tests([SELECTOR], output_log.read_text()):
        raise AcceptanceError('expected exactly one passing cold-cutover selector')
    markers = read_markers(output_log, TRACE)
    if len(markers) != 1:
        raise AcceptanceError('expected exactly one cold-cutover trace')
    homes = owned_homes(home_log, scope / 'tmp')
    if len(homes) != 2 or len({home.resolve() for home in homes}) != 2:
        raise AcceptanceError('expected two distinct scoped cold-cutover homes')
    trace = markers[0]
    validate_trace(trace, homes)
    return {'log': RUN_LOG, 'sha256': hash_file(output_log), 'trace': trace,
            'homes_sha256': hash_file(home_log), 'homes': [str(home) for home in homes]}


def validate_trace(trace, homes):
    def require(condition, label):
        if not condition:
            raise AcceptanceError(f'cold-cutover trace did not establish {label}')

    try:
        old, new = trace['prior'], trace['candidate']
        previous, current = old['agent'], new['agent']
        local, peer = previous['machine_id'], old['peer']['machine_id']
        reference = {'machine_id': local, 'agent_id': 'a1'}
        require(old['protocol'] == 3 and new['api_version'] == 1, 'the v3 and v1 handshakes')
        require(isinstance(local, str) and isinstance(peer, str) and local and peer and local != peer
                and previous['agent_id'] == 'a1' and current['reference'] == reference and new['peer']['machine_id'] == peer,
                'the original distinct machine and Agent identities')
        require((previous['address'], previous['name'], previous['cli']) == ('a1@laptop', 'kept', 'fake')
                and previous['cwd'] == str(homes[0].parent / 'project')
                and previous['process'] == 'ended' and isinstance(previous['exit'], dict) and previous['exit']
                and previous['session'] == SESSION
                and all(previous[key] == current[key] for key in ('address', 'name', 'cli', 'cwd', 'exit', 'process', 'session')),
                'the original ended record, working directory and saved session')

        saved, migrated = old['saved'], new['saved']
        route = {'machine_id': peer, 'initiator_machine_id': local, 'kind': 'saved'}
        transport = {'ssh_destination': 'devbox', 'ssh_args': ['-p', '2222', 'devbox'], 'remote_home': str(homes[1])}
        require(all(saved[key] == migrated[key] == value for key, value in route.items())
                and all(saved[key] == value for key, value in transport.items())
                and migrated['transport'] == {'kind': 'ssh', **transport}
                and new['peer']['state'] == 'disconnected'
                and trace['ssh_attempts']['before'] == trace['ssh_attempts']['after'] == 'interactive 2222 login\n',
                'the saved transport and no new dial')

        history = trace['receipt']
        original = history['original']
        message = original['message']
        delivered = message['delivery']
        require(message['message_id'] == 'm1' and original['id'] == 'm1@laptop' and 'repeated' not in original
                and message['to'] == 'a1'
                and message['from'] == 'command_line' and message['text'] == DELIVERY_TEXT
                and delivered['status'] == 'success' and delivered['text_written'] == 'full'
                and delivered['enter_written'] is True and delivered['delivered_via'] == 'terminal'
                and isinstance(delivered['delivered_at'], str) and bool(delivered['delivered_at']),
                'the original complete delivery and receipt')
        require(original['recipient']['reference'] == reference
                and all(history[role]['id'] == original['id'] and history[role]['repeated'] is True
                        and history[role]['message'] == message and history[role]['recipient']['reference'] == reference
                        for role in ('prior_replay', 'candidate_replay'))
                and trace['new_request']['error']['data']['reason'] == 'ended',
                'both replays of the same receipt and refusal of a fresh request')
        body = 'the command line · m1'
        expected = f'📨 Message from \x1b[200~{body}\r{DELIVERY_TEXT}\x1b[201~\r'.encode()
        require(bytes(trace['cli_bytes']) == expected
                and json.loads(trace['transcript']) == {'message': f'📨 Message from {body}\n{DELIVERY_TEXT}'},
                'one exact CLI delivery and one transcript entry')
    except AcceptanceError:
        raise
    except (KeyError, TypeError, ValueError) as error:
        raise AcceptanceError('cold-cutover trace is incomplete or malformed') from error


def prior_success(receipt):
    return {'case': NATIVE_PRIOR_CASE, 'selector': SELECTOR, 'role': receipt['prior']['role'],
            'evidence_sha256': digest({key: value for key, value in receipt.items() if key != 'success'})}


def verify_command_logs(receipt, output):
    prior = receipt['prior']
    build_prior = prior['role'] == 'prior-main'
    paths = (*PRIOR_BUILD_LOGS, *CANDIDATE_BUILD_LOGS, RUN_LOG) if build_prior else (*CANDIDATE_BUILD_LOGS, RUN_LOG)
    commands = receipt['commands']
    if tuple(record['log'] for record in commands) != paths:
        raise AcceptanceError('native prior-build command logs are incomplete')
    content = {}
    for record in commands:
        name = record['log']
        path = output / name
        lines = path.read_text().splitlines()
        if (record['status'] != 'pass' or record['sha256'] != hash_file(path)
                or lines[:1] != ['$ ' + shlex.join(record['argv'])]):
            raise AcceptanceError(f'native prior-build command log changed or failed: {name}')
        content[name] = lines[1:]
    scope = Path(receipt['scope'])
    if commands[-1]['argv'] != [str(scope / 'candidate-bin' / 'machines'), *TEST_ARGS]:
        raise AcceptanceError('native prior-build selector did not run from the staged candidate')
    if build_prior:
        source, rustc, build = (record['argv'] for record in commands[:3])
        channel = tomllib.loads(git(ROOT, 'show', f'{PRIOR_MAIN}:core/rust-toolchain.toml'))['toolchain']['channel']
        if (source[:2] != ['git', '-C']
                or source[3:] != ['archive', '--format=tar', '--output', str(scope / 'prior.tar'), PRIOR_MAIN, 'core']
                or rustc != ['rustc', '--version', '--verbose'] or f'release: {channel}' not in prior['rustc']
                or prior['rustc'] != content['prior-rustc.log']
                or Path(build[0]).name != 'cargo' or build[1:] != list(PRIOR_BUILD_ARGS)
                or not any(line.strip().startswith('Finished `release` profile') for line in content['prior-build.log'])):
            raise AcceptanceError('native prior-build logs did not establish the pinned source, toolchain and build')


def verified_prior(candidate_bin, output, console, run, prior_bin=None, manifest=None):
    receipt = read_json(output / 'receipt.json')
    if not isinstance(receipt, dict) or receipt.get('source') != source_identity(run):
        raise AcceptanceError('native prior-build receipt is for a different source or attempt')
    if receipt.get('harness_sha256') != harness_hashes():
        raise AcceptanceError('native prior-build receipt is for a different test harness')
    candidate = receipt['candidate']
    if (candidate['program_sha256'] != binary_hashes(candidate_bin) or not all(
            HEX_DIGEST.fullmatch(candidate[key]) for key in ('facade-fakecli_sha256', 'machines_sha256'))):
        raise AcceptanceError('native prior-build receipt is for a different candidate or test binaries')
    prior = receipt['prior']
    if prior['role'] == 'prior-main':
        expected = {'revision': PRIOR_MAIN, 'tree': git(ROOT, 'rev-parse', f'{PRIOR_MAIN}^{{tree}}'), 'run': run}
        digests = prior['program_sha256']
        if (prior['source'] != expected or prior['target'] != TARGET or set(digests) != set(PROGRAMS)
                or not all(HEX_DIGEST.fullmatch(value) for value in digests.values())):
            raise AcceptanceError('native prior-build evidence does not name the pinned source, target and programs')
    elif prior['role'] != 'pinned-binaries' or prior_bin is None or manifest is None or prior != pinned_programs(prior_bin, manifest):
        raise AcceptanceError('native prior-build evidence does not match the pinned binary inputs')
    verify_command_logs(receipt, output)
    verify_native_cleanup(receipt)
    if (receipt.get('fallback_home_empty') is not True
            or receipt.get('observation') != cold_observation(output, Path(receipt['scope']))):
        raise AcceptanceError('native prior-build receipt does not match the original observed output')
    expected = prior_success(receipt)
    if receipt.get('success') != expected or read_markers(console, SUCCESS_MARKER) != [expected]:
        raise AcceptanceError('native prior-build marker does not match the cleaned evidence record')


def binary_hashes(directory):
    programs = {name: directory / name for name in PROGRAMS}
    for path in programs.values():
        if not path.is_file() or not os.access(path, os.X_OK):
            raise AcceptanceError(f'missing executable {path}')
    return {name: hash_file(path) for name, path in programs.items()}


def pinned_programs(directory, manifest):
    expected = {}
    manifest_text = manifest.read_bytes()
    for line in manifest_text.decode('utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64}) [ *](\S+)', line)
        if not match:
            raise AcceptanceError(f'invalid SHA256SUMS entry in {manifest}')
        path = PurePosixPath(match[2])
        if path.is_absolute() or '..' in path.parts or path.name not in PROGRAMS or path.name in expected:
            raise AcceptanceError(f'unexpected or duplicate prior binary entry {path}')
        expected[path.name] = match[1]
    if expected != binary_hashes(directory):
        raise AcceptanceError('the prior Shell and MCP must both match the externally pinned manifest')
    return {'role': 'pinned-binaries', 'manifest_sha256': sha256(manifest_text).hexdigest(),
            'program_sha256': expected}


def stage_programs(source, target, expected):
    target.mkdir(mode=0o700)
    for name in PROGRAMS:
        shutil.copy2(source / name, target / name)
    if binary_hashes(target) != expected:
        raise AcceptanceError('staged programs changed after digest verification')


def logged_command(command, cwd, env, log, receipt, *, timeout=900):
    argv = list(map(str, command))
    with log.open('w') as stream:
        print('$ ' + shlex.join(argv), file=stream, flush=True)
        status = execute(argv, cwd, env, stream, timeout=timeout)
    receipt['commands'].append({'argv': argv, 'status': status, 'log': log.name, 'sha256': hash_file(log)})
    if status != 'pass':
        raise AcceptanceError(f'{status} running {argv[0]} ({log})')


def compile_prior(scope, cargo, env, output, receipt):
    prior = scope / 'prior-source'
    prior.mkdir(mode=0o700)
    tree = git(ROOT, 'rev-parse', f'{PRIOR_MAIN}^{{tree}}')
    provenance = {'role': 'prior-main', 'source': {
        'revision': PRIOR_MAIN, 'tree': tree, 'run': receipt['source']['run'],
    }, 'target': TARGET}
    receipt['prior'] = provenance
    snapshot = scope / 'prior.tar'
    command = ['git', '-C', str(ROOT), 'archive', '--format=tar', '--output', snapshot, PRIOR_MAIN, 'core']
    logged_command(command, ROOT, env, output / 'prior-source.log', receipt)
    with tarfile.open(snapshot) as archive:
        archive.extractall(prior, filter='data')
    snapshot.unlink()

    prior_target = scope / 'prior-target'
    prior_env = {**env, 'CARGO_TARGET_DIR': str(prior_target)}
    rust_log = output / 'prior-rustc.log'
    logged_command(['rustc', '--version', '--verbose'], prior / 'core', prior_env, rust_log, receipt)
    provenance['rustc'] = rust_log.read_text().splitlines()[1:]
    logged_command(
        [*cargo, *PRIOR_BUILD_ARGS],
        prior / 'core', prior_env, output / 'prior-build.log', receipt, timeout=1800,
    )
    programs = prior_target / TARGET / 'release'
    provenance['program_sha256'] = binary_hashes(programs)
    return programs


def cargo_artifact(log, name, *, test):
    matches = []
    for line in log.read_text().splitlines():
        if not line.startswith('{'):
            continue
        record = json.loads(line)
        if (record.get('reason') == 'compiler-artifact' and record['target']['name'] == name
                and record['profile']['test'] is test and record.get('executable')):
            matches.append(Path(record['executable']))
    if len(matches) != 1 or not matches[0].is_file() or not os.access(matches[0], os.X_OK):
        raise AcceptanceError(f'Cargo did not report exactly one executable for {name} ({log})')
    return matches[0]


def compile_candidate(cargo, env, output, receipt):
    commands = (
        ('facade-fakecli', False, ['build', '--bin', 'facade-fakecli']),
        ('machines', True, ['test', '--test', 'machines', '--no-run']),
    )
    artifacts = []
    for name, test, args in commands:
        log = output / f'candidate-{name}.log'
        logged_command([*cargo, *args, '--locked', '-p', 'facade-scenarios', '--message-format=json-render-diagnostics'],
                       ROOT / 'core', env, log, receipt)
        artifacts.append(cargo_artifact(log, name, test=test))
    return artifacts


def scenario_sockets(home_log, test_tmp):
    return {
        (home, role): Path(f'/tmp/facade-core-{os.getuid()}/{role}-{sha256(os.fsencode(home)).hexdigest()[:10]}.sock')
        for home in owned_homes(home_log, test_tmp) for role in ('daemon', 'keeper')
    }


def run_cold_cutover(args, output, receipt, scope, home_log, test_tmp):
    home, runtime, build_home, build_tmp = (
        scope / name for name in ('home', 'runtime', 'build-home', 'build-tmp')
    )
    for folder in (home, test_tmp, runtime, build_home, build_tmp):
        folder.mkdir(mode=0o700)
    cargo_exe = shutil.which('cargo')
    if cargo_exe is None:
        raise AcceptanceError('cargo is unavailable')
    cargo = [cargo_exe]
    env = {
        'PATH': f'{Path(cargo_exe).parent}:{SYSTEM_PATH}', 'HOME': str(build_home),
        'TMPDIR': str(build_tmp), 'CI_ACCEPTANCE_ROOT': str(scope),
        'CARGO_HOME': os.environ.get('CARGO_HOME', str(Path.home() / '.cargo')),
        'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')),
        'CARGO_BUILD_JOBS': '2', 'CARGO_INCREMENTAL': '0', 'GIT_CONFIG_NOSYSTEM': '1', 'LC_ALL': 'C.UTF-8',
        'CC_x86_64_unknown_linux_musl': 'musl-gcc',
    }
    if args.offline:
        env['CARGO_NET_OFFLINE'] = 'true'
    if args.role == 'prior-main':
        prior = compile_prior(scope, cargo, env, output, receipt)
    else:
        prior = args.prior_bin
    stage_programs(prior, scope / 'prior-bin', receipt['prior']['program_sha256'])
    stage_programs(args.candidate_bin, scope / 'candidate-bin', receipt['candidate']['program_sha256'])
    fake, test = compile_candidate(cargo, env, output, receipt)
    staged_fake, staged_test = (scope / 'candidate-bin' / name for name in ('facade-fakecli', 'machines'))
    for source, staged in ((fake, staged_fake), (test, staged_test)):
        shutil.copy2(source, staged)
        receipt['candidate'][f'{staged.name}_sha256'] = hash_file(staged)

    test_env = {
        'PATH': SYSTEM_PATH, 'HOME': str(home), 'TMPDIR': str(test_tmp),
        'CI_ACCEPTANCE_ROOT': str(scope), 'XDG_RUNTIME_DIR': str(runtime), 'LC_ALL': 'C.UTF-8',
        'FACADE_HOME': str(home / '.facade'), 'FACADE_SCENARIO_HOME_LOG': str(home_log),
        'FACADE_TEST_API_V1_PRERELEASE': str(scope / 'prior-bin/facade'),
    }
    log = output / RUN_LOG
    logged_command([staged_test, *TEST_ARGS],
                   ROOT / 'core/tests', test_env, log, receipt, timeout=180)
    if any(home.iterdir()):
        raise AcceptanceError('the scenario wrote to the fallback HOME')
    receipt['fallback_home_empty'] = True
    if not home_log.is_file():
        raise AcceptanceError('the fixture did not record its scoped homes')
    shutil.copyfile(home_log, output / HOME_LOG)
    receipt['observation'] = cold_observation(output, scope)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-bin', required=True, type=lambda path: Path(path).resolve())
    parser.add_argument('--output-dir', required=True, type=lambda path: Path(path).resolve())
    parser.add_argument('--run-id', help='unique local attempt ID')
    parser.add_argument('--offline', action='store_true', help='use cached Cargo dependencies')
    modes = parser.add_subparsers(dest='role', required=True)
    pinned = modes.add_parser('pinned-binaries', help='replay an externally pinned Shell/MCP pair')
    pinned.add_argument('--prior-bin', required=True, type=lambda path: Path(path).resolve())
    pinned.add_argument('--manifest', required=True, type=lambda path: Path(path).resolve())
    modes.add_parser('prior-main', help='compile the immutable prior main revision for this run')
    args = parser.parse_args()
    if (sys.platform != 'linux' or os.uname().machine != 'x86_64'
            or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal')):
        parser.error('requires Linux x64 and pidfds')
    try:
        os.close(os.pidfd_open(os.getpid()))
        receipt = {'source': source_identity(run_identity(args.run_id, os.environ)), 'commands': []}
        receipt['harness_sha256'] = harness_hashes()
        receipt['candidate'] = {'program_sha256': binary_hashes(args.candidate_bin)}
        if args.role == 'pinned-binaries':
            receipt['prior'] = pinned_programs(args.prior_bin, args.manifest)
        args.output_dir.mkdir(parents=True)
    except (AcceptanceError, OSError, ValueError) as error:
        parser.exit(2, f'native prior build: {error}\n')

    signal.signal(signal.SIGTERM, interrupted)
    started = time.monotonic()
    scope = Path(tempfile.mkdtemp(prefix='fci-prior-core-', dir='/tmp'))
    home_log, test_tmp = scope / 'scenario-homes', scope / 'tmp'
    receipt['scope'] = str(scope)
    passed = False
    try:
        try:
            run_cold_cutover(args, args.output_dir, receipt, scope, home_log, test_tmp)
        finally:
            sockets = {}
            try:
                sockets = scenario_sockets(home_log, test_tmp)
            finally:
                clean_native_scope(scope, sockets, receipt)
        verify_native_cleanup(receipt)
        passed = True
    except (AcceptanceError, OSError, RuntimeError, ValueError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        receipt['error'] = str(error)
        print(f'native prior build: {error}', file=sys.stderr)
    finally:
        receipt['elapsed_seconds'] = round(time.monotonic() - started, 3)
        if passed:
            receipt['success'] = prior_success(receipt)
        write_receipt(args.output_dir / 'receipt.json', receipt)
    if 'success' not in receipt:
        return 1
    print(SUCCESS_MARKER + json.dumps(receipt['success'], separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
