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

from catalog import AcceptanceError, NATIVE_PRIOR_CASE
from evidence import execute, git, observed_core_tests, run_identity
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
    receipt['commands'].append({'argv': argv, 'status': status, 'log': log.name})
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
        [*cargo, 'build', '--locked', '--release', '--target', TARGET, '-p', 'facade', '-p', 'facade-relay',
         '--bin', 'facade', '--bin', 'facade-mcp'],
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
    endpoints = {}
    if home_log.exists():
        for line in home_log.read_text().splitlines():
            home = Path(line)
            if not home.is_absolute() or not home.resolve().is_relative_to(test_tmp):
                raise AcceptanceError(f'scenario reported an unowned home {home}')
            key = sha256(os.fsencode(home)).hexdigest()[:10]
            for role in ('daemon', 'keeper'):
                endpoints[(home, role)] = Path(f'/tmp/facade-core-{os.getuid()}/{role}-{key}.sock')
    return endpoints


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
    log = output / 'cold-cutover.log'
    logged_command([staged_test, '--show-output', '--ignored', '--exact', '--test-threads=1', SELECTOR],
                   ROOT / 'core/tests', test_env, log, receipt, timeout=180)
    if not observed_core_tests([SELECTOR], log.read_text()):
        raise AcceptanceError('the cold-cutover command did not run exactly the expected ignored selector')
    if any(home.iterdir()):
        raise AcceptanceError('the scenario wrote to the fallback HOME')
    markers = read_markers(log, TRACE)
    if len(markers) != 1 or not isinstance(markers[0], dict):
        raise AcceptanceError('the selector did not publish its cold-cutover trace')
    receipt['observation'] = {'log': log.name, 'sha256': hash_file(log), 'trace': markers[0]}


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
        receipt['harness_sha256'] = {
            path: hash_file(ROOT / path) for path in (
                'ci/check_prior_build.py', 'core/tests/tests/machines.rs', 'core/tests/src/bin/facade-fakecli.rs')
        }
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
        receipt['success'] = {
            'case': NATIVE_PRIOR_CASE, 'selector': SELECTOR, 'role': args.role, 'source': receipt['source'],
            'prior_sha256': receipt['prior']['program_sha256'],
            'observation_sha256': receipt['observation']['sha256'],
        }
    except (AcceptanceError, OSError, RuntimeError, ValueError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        receipt['error'] = str(error)
        print(f'native prior build: {error}', file=sys.stderr)
    finally:
        receipt['elapsed_seconds'] = round(time.monotonic() - started, 3)
        write_receipt(args.output_dir / 'receipt.json', receipt)
    if 'success' not in receipt:
        return 1
    print(SUCCESS_MARKER + json.dumps(receipt['success'], separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
