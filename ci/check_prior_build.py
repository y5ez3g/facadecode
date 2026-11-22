#!/usr/bin/env python3
"""Replay Linux x64 Core compatibility with identified native program pairs."""

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

from catalog import AcceptanceError, NATIVE_HOT_CASE, NATIVE_PRIOR_CASE, read_json
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
HOT_TRACE = 'Facade hot takeover evidence '
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
HOT_SELECTOR = 'a_higher_v1_build_keeps_the_process_session_and_receipt_through_takeover'
HOT_SESSION = '065e033f-12fe-4bac-9870-dc4e3d4971af'
HOT_CONTROLS = (
    'the_daemon_refuses_a_takeover_by_its_own_version_and_an_older_one',
    'v1_takeover_refuses_disjoint_daemon_and_keeper_sets_before_installing',
)


def harness_hashes(target='machines'):
    return {path: hash_file(ROOT / path) for path in (
        'ci/check_prior_build.py', 'ci/native_core.py', 'ci/evidence.py',
        f'core/tests/tests/{target}.rs', 'core/tests/src/bin/facade-fakecli.rs',
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


def prior_success(receipt, *, role=None):
    hot = role == 'hot-qa'
    return {'case': NATIVE_HOT_CASE if hot else NATIVE_PRIOR_CASE,
            'selector': HOT_SELECTOR if hot else SELECTOR, 'role': role or receipt['prior']['role'],
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
        raise AcceptanceError(f'the Shell and MCP in {directory} must both match {manifest}')
    return {'role': 'pinned-binaries', 'manifest_sha256': sha256(manifest_text).hexdigest(),
            'program_sha256': expected}


def stage_programs(source, target, expected):
    target.mkdir(mode=0o700)
    for name in PROGRAMS:
        shutil.copy2(source / name, target / name)
    if binary_hashes(target) != expected:
        raise AcceptanceError('staged programs changed after digest verification')


def require_linux_programs(directory):
    for name in PROGRAMS:
        with (directory / name).open('rb') as executable:
            header = executable.read(20)
        if (header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[16:18], 'little') not in (2, 3)
                or int.from_bytes(header[18:20], 'little') != 62):
            raise AcceptanceError(f'{directory / name} is not a Linux x64 ELF executable')


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


def compile_candidate(cargo, env, output, receipt, target):
    commands = (
        ('facade-fakecli', False, ['build', '--bin', 'facade-fakecli']),
        (target, True, ['test', '--test', target, '--no-run']),
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


def observe_hot_takeover(output, home_log, test_tmp, receipt):
    log = output / 'hot-takeover.log'
    if not observed_core_tests([HOT_SELECTOR], log.read_text()):
        raise AcceptanceError('expected exactly one passing hot takeover selector')
    traces = read_markers(log, HOT_TRACE)
    homes = owned_homes(home_log, test_tmp)
    if len(traces) != 1 or len(homes) != 1:
        raise AcceptanceError('expected one hot takeover trace and one scoped fixture home')
    trace = traces[0]
    before, after = trace['from_build'], trace['to_build']
    if not all(isinstance(version, str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version)
               for version in (before, after)) or tuple(map(int, after.split('.'))) <= tuple(map(int, before.split('.'))):
        raise AcceptanceError('the hot takeover did not identify a higher numeric build')
    identities = [trace[key] for key in ('daemon_before', 'daemon_after', 'keeper', 'cli')]
    if (len({item['pid'] for item in identities}) != 4
            or not all(type(item['pid']) is int and item['pid'] > 0 and str(item['birth']).isdigit() for item in identities)
            or trace['daemon_api_version'] != 1 or trace['session'] != HOT_SESSION
            or trace['reference']['agent_id'] != 'a1' or not trace['reference']['machine_id']):
        raise AcceptanceError('the hot takeover did not establish the live process identities and session')
    label = trace['receipt'].removeprefix('m1@')
    if not label or trace['receipt'] != f'm1@{label}' or trace['fresh_receipt'] != f'm2@{label}':
        raise AcceptanceError('the hot takeover did not settle the original and fresh requests separately')

    bin_dir = homes[0] / 'core/bin'
    installed = {build: binary_hashes(bin_dir / build) for build in (before, after)}
    if any(installed[build] != receipt[role]['program_sha256'] for role, build in (('candidate', before), ('higher', after))):
        raise AcceptanceError('the installed programs did not match both pinned build pairs')
    if any((bin_dir / name).readlink() != Path(after) / name for name in PROGRAMS):
        raise AcceptanceError('the installed launchers did not switch to the higher build')
    daemon_log = output / 'hot-daemon.log'
    shutil.copy2(homes[0] / 'core/logs/daemon.log', daemon_log)
    daemon_text = daemon_log.read_text()
    for side in ('daemon_before', 'daemon_after'):
        handshake = (f'daemon[{trace[side]["pid"]}] info: connected to keeper {trace["keeper"]["pid"]}'
                     f' (Keeper API 1, build {before})')
        if handshake not in daemon_text:
            raise AcceptanceError(f'missing Keeper API 1 handshake for {side}')
    return {'log': log.name, 'sha256': hash_file(log), 'trace': trace,
            'installed_sha256': installed, 'keeper_api_version': 1, 'daemon_log_sha256': hash_file(daemon_log)}


def run_compatibility(args, output, receipt, scope, home_log, test_tmp, target):
    hot = args.role == 'hot-qa'
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
    if hot:
        stage_programs(args.higher_bin, scope / 'higher-bin', receipt['higher']['program_sha256'])
    else:
        prior = compile_prior(scope, cargo, env, output, receipt) if args.role == 'prior-main' else args.prior_bin
        stage_programs(prior, scope / 'prior-bin', receipt['prior']['program_sha256'])
    stage_programs(args.candidate_bin, scope / 'candidate-bin', receipt['candidate']['program_sha256'])
    fake, test = compile_candidate(cargo, env, output, receipt, target)
    staged_fake, staged_test = (scope / 'candidate-bin' / name for name in ('facade-fakecli', target))
    for source, staged in ((fake, staged_fake), (test, staged_test)):
        shutil.copy2(source, staged)
        receipt['candidate'][f'{staged.name}_sha256'] = hash_file(staged)

    test_env = {
        'PATH': SYSTEM_PATH, 'HOME': str(home), 'TMPDIR': str(test_tmp),
        'CI_ACCEPTANCE_ROOT': str(scope), 'XDG_RUNTIME_DIR': str(runtime), 'LC_ALL': 'C.UTF-8',
        'FACADE_HOME': str(home / '.facade'), 'FACADE_SCENARIO_HOME_LOG': str(home_log),
    }
    if hot:
        hot_env = {**test_env, 'FACADE_TEST_API_V1_NEXT': str(scope / 'higher-bin/facade'), 'FACADE_SCENARIO_KEEP': '1'}
        logged_command([staged_test, *TEST_ARGS[:-1], HOT_SELECTOR], ROOT / 'core/tests', hot_env,
                       output / 'hot-takeover.log', receipt, timeout=180)
        receipt['observation'] = observe_hot_takeover(output, home_log, test_tmp, receipt)
        control = output / 'hot-refusals.log'
        logged_command([staged_test, '--show-output', '--exact', '--test-threads=1', *HOT_CONTROLS],
                       ROOT / 'core/tests', test_env, control, receipt, timeout=180)
        if not observed_core_tests(HOT_CONTROLS, control.read_text()):
            raise AcceptanceError('the hot refusal controls did not run exactly the expected selectors')
        receipt['controls'] = {'log': control.name, 'sha256': hash_file(control), 'selectors': HOT_CONTROLS}
    else:
        cold_env = {**test_env, 'FACADE_TEST_API_V1_PRERELEASE': str(scope / 'prior-bin/facade')}
        logged_command([staged_test, *TEST_ARGS], ROOT / 'core/tests', cold_env, output / RUN_LOG, receipt, timeout=180)
        if not home_log.is_file():
            raise AcceptanceError('the fixture did not record its scoped homes')
        shutil.copyfile(home_log, output / HOME_LOG)
        receipt['observation'] = cold_observation(output, scope)
    if any(home.iterdir()):
        raise AcceptanceError('the scenario wrote to the fallback HOME')
    receipt['fallback_home_empty'] = True


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
    hot = modes.add_parser('hot-qa', help='replay two digest-pinned compatible Linux x64 QA builds')
    hot.add_argument('--candidate-manifest', required=True, type=Path)
    hot.add_argument('--higher-bin', required=True, type=lambda path: Path(path).resolve())
    hot.add_argument('--higher-manifest', required=True, type=Path)
    args = parser.parse_args()
    is_hot = args.role == 'hot-qa'
    target = 'upgrade' if is_hot else 'machines'
    if (sys.platform != 'linux' or os.uname().machine != 'x86_64'
            or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal')):
        parser.error('requires Linux x64 and pidfds')
    try:
        os.close(os.pidfd_open(os.getpid()))
        receipt = {'source': source_identity(run_identity(args.run_id, os.environ)), 'commands': []}
        receipt['harness_sha256'] = harness_hashes(target)
        if is_hot:
            receipt['candidate'] = pinned_programs(args.candidate_bin, args.candidate_manifest)
            receipt['higher'] = pinned_programs(args.higher_bin, args.higher_manifest)
            require_linux_programs(args.candidate_bin)
            require_linux_programs(args.higher_bin)
        else:
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
            run_compatibility(args, args.output_dir, receipt, scope, home_log, test_tmp, target)
        finally:
            sockets = {}
            try:
                sockets = scenario_sockets(home_log, test_tmp)
            finally:
                clean_native_scope(scope, sockets, receipt)
        verify_native_cleanup(receipt)
        passed = True
    except (AcceptanceError, OSError, KeyError, TypeError, RuntimeError, ValueError,
            subprocess.CalledProcessError, KeyboardInterrupt) as error:
        receipt['error'] = str(error)
        print(f'native prior build: {error}', file=sys.stderr)
    finally:
        receipt['elapsed_seconds'] = round(time.monotonic() - started, 3)
        if passed:
            receipt['success'] = prior_success(receipt, role=args.role)
        write_receipt(args.output_dir / 'receipt.json', receipt)
    if 'success' not in receipt:
        return 1
    print(SUCCESS_MARKER + json.dumps(receipt['success'], separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
