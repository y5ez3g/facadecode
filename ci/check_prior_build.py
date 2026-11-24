#!/usr/bin/env python3
"""Replay Linux x64 Framework compatibility with identified native program pairs."""

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
import tempfile
import time

from catalog import AcceptanceError, NATIVE_HOT_CASE
from evidence import digest, execute, observed_framework_tests, run_identity
from native_framework import (
    ROOT, SYSTEM_PATH, clean_native_scope, hash_file, interrupted, read_markers,
    source_identity, verify_native_cleanup, write_receipt,
)


PROGRAMS = ('facade', 'facade-mcp')
HOT_TRACE = 'Facade hot takeover evidence '
SUCCESS_MARKER = 'Facade native prior build test '
HOT_SELECTOR = 'a_higher_v1_build_keeps_the_process_session_and_receipt_through_takeover'
HOT_SESSION = '065e033f-12fe-4bac-9870-dc4e3d4971af'
HOT_CONTROLS = (
    'the_daemon_refuses_a_takeover_by_an_equal_or_older_build',
    'v1_takeover_refuses_disjoint_daemon_and_keeper_sets_before_installing',
)


def harness_hashes(target):
    return {path: hash_file(ROOT / path) for path in (
        'ci/check_prior_build.py', 'ci/native_framework.py', 'ci/evidence.py',
        f'framework/tests/tests/{target}.rs', 'framework/tests/src/bin/facade-fakecli.rs',
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
                       ROOT / 'framework', env, log, receipt)
        artifacts.append(cargo_artifact(log, name, test=test))
    return artifacts


def scenario_sockets(home_log, test_tmp):
    return {
        (home, role): Path(f'/tmp/facade-framework-{os.getuid()}/{role}-{sha256(os.fsencode(home)).hexdigest()[:10]}.sock')
        for home in owned_homes(home_log, test_tmp) for role in ('daemon', 'keeper')
    }


def observe_hot_takeover(output, home_log, test_tmp, receipt):
    log = output / 'hot-takeover.log'
    if not observed_framework_tests([HOT_SELECTOR], log.read_text()):
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

    bin_dir = homes[0] / 'framework/bin'
    installed = {build: binary_hashes(bin_dir / build) for build in (before, after)}
    if any(installed[build] != receipt[role]['program_sha256'] for role, build in (('candidate', before), ('higher', after))):
        raise AcceptanceError('the installed programs did not match both pinned build pairs')
    if any((bin_dir / name).readlink() != Path(after) / name for name in PROGRAMS):
        raise AcceptanceError('the installed launchers did not switch to the higher build')
    daemon_log = output / 'hot-daemon.log'
    shutil.copy2(homes[0] / 'framework/logs/daemon.log', daemon_log)
    daemon_text = daemon_log.read_text()
    for side in ('daemon_before', 'daemon_after'):
        handshake = (f'daemon[{trace[side]["pid"]}] info: connected to keeper {trace["keeper"]["pid"]}'
                     f' (Keeper API 1, build {before})')
        if handshake not in daemon_text:
            raise AcceptanceError(f'missing Keeper API 1 handshake for {side}')
    return {'log': log.name, 'sha256': hash_file(log), 'trace': trace,
            'installed_sha256': installed, 'keeper_api_version': 1, 'daemon_log_sha256': hash_file(daemon_log)}


def run_compatibility(args, output, receipt, scope, home_log, test_tmp, target):
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
    stage_programs(args.higher_bin, scope / 'higher-bin', receipt['higher']['program_sha256'])
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
    hot_env = {**test_env, 'FACADE_TEST_API_V1_NEXT': str(scope / 'higher-bin/facade'), 'FACADE_SCENARIO_KEEP': '1'}
    logged_command([staged_test, '--show-output', '--ignored', '--exact', '--test-threads=1', HOT_SELECTOR], ROOT / 'framework/tests', hot_env,
                   output / 'hot-takeover.log', receipt, timeout=180)
    receipt['observation'] = observe_hot_takeover(output, home_log, test_tmp, receipt)
    control = output / 'hot-refusals.log'
    logged_command([staged_test, '--show-output', '--exact', '--test-threads=1', *HOT_CONTROLS],
                   ROOT / 'framework/tests', test_env, control, receipt, timeout=180)
    if not observed_framework_tests(HOT_CONTROLS, control.read_text()):
        raise AcceptanceError('the hot refusal controls did not run exactly the expected selectors')
    receipt['controls'] = {'log': control.name, 'sha256': hash_file(control), 'selectors': HOT_CONTROLS}
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
    hot = modes.add_parser('hot-qa', help='replay two digest-pinned compatible Linux x64 QA builds')
    hot.add_argument('--candidate-manifest', required=True, type=Path)
    hot.add_argument('--higher-bin', required=True, type=lambda path: Path(path).resolve())
    hot.add_argument('--higher-manifest', required=True, type=Path)
    args = parser.parse_args()
    target = 'upgrade'
    if (sys.platform != 'linux' or os.uname().machine != 'x86_64'
            or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal')):
        parser.error('requires Linux x64 and pidfds')
    try:
        os.close(os.pidfd_open(os.getpid()))
        receipt = {'source': source_identity(run_identity(args.run_id, os.environ)), 'commands': []}
        receipt['harness_sha256'] = harness_hashes(target)
        receipt['candidate'] = pinned_programs(args.candidate_bin, args.candidate_manifest)
        receipt['higher'] = pinned_programs(args.higher_bin, args.higher_manifest)
        require_linux_programs(args.candidate_bin)
        require_linux_programs(args.higher_bin)
        args.output_dir.mkdir(parents=True)
    except (AcceptanceError, OSError, ValueError) as error:
        parser.exit(2, f'native prior build: {error}\n')

    signal.signal(signal.SIGTERM, interrupted)
    started = time.monotonic()
    scope = Path(tempfile.mkdtemp(prefix='fci-prior-framework-', dir='/tmp'))
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
            receipt['success'] = {
                'case': NATIVE_HOT_CASE, 'selector': HOT_SELECTOR, 'role': args.role,
                'evidence_sha256': digest({key: value for key, value in receipt.items() if key != 'success'}),
            }
        write_receipt(args.output_dir / 'receipt.json', receipt)
    if 'success' not in receipt:
        return 1
    print(SUCCESS_MARKER + json.dumps(receipt['success'], separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
