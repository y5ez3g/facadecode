#!/usr/bin/env python3
"""Run and verify the native Linux x64 Keeper recovery scenario."""

import argparse
from hashlib import sha256
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib

from catalog import AcceptanceError, read_cases, read_json
from evidence import git, observed_framework_tests, run_identity, runtime
from native_framework import (
    ROOT, SYSTEM_PATH, cargo_artifact, clean_native_scope, hash_file, interrupted, logged_command,
    owned_homes, read_markers, scenario_sockets, source_identity, verify_native_cleanup, write_receipt,
)


CASE = 'framework/p0/service-recovery/keeper-recovery'
ARTIFACT = 'framework-keeper-recovery'
SELECTOR = 'a_dead_keeper_is_replaced_and_the_daemon_keeps_every_terminal'
BINDING = {'runner': 'framework-scenario', 'target': 'keeper', 'name': SELECTOR}
FRAMEWORK = ROOT / 'framework'
PROGRAMS = ('facade', 'facade-mcp', 'facade-fakecli')
HOME_LOG = 'scenario-homes.txt'
SCENARIO_TIMEOUT = 300
OBSERVATION = 'Facade Keeper recovery observation '
PROGRAM_BUILD = ('-p', 'facade', '-p', 'facade-relay', '-p', 'facade-scenarios',
                 '--bin', 'facade', '--bin', 'facade-mcp', '--bin', 'facade-fakecli')
SCENARIO_BUILD = ('-p', 'facade-scenarios', '--test', 'keeper', '--no-run')
TEST_ARGS = ('--exact', '--show-output', '--test-threads=1', SELECTOR)


def candidate_identity(run):
    source = source_identity(run)
    hosted = run.startswith('github/')
    if hosted and source['revision'] != os.environ.get('GITHUB_SHA'):
        raise AcceptanceError('the Keeper checkout does not match GITHUB_SHA')
    paths = () if hosted else ('--', 'framework', 'ci/cases.json')
    dirty = git(ROOT, 'status', '--porcelain', '--untracked-files=normal', *paths)
    if dirty:
        raise AcceptanceError(f'Keeper evidence requires committed candidate inputs:\n{dirty}')
    return source


def harness_hashes():
    return {name: hash_file(ROOT / 'ci' / name) for name in (
        'check_keeper_recovery.py', 'native_framework.py', 'evidence.py', 'catalog.py',
    )}


def build_flags(target, workspace_build, offline):
    flags = ['--locked', '--message-format=json-render-diagnostics']
    if not workspace_build:
        flags.extend(['--target', target])
    if offline:
        flags.append('--offline')
    return flags


def run_scenario(scope, output, receipt):
    build_home, home, tmp = (scope / name for name in ('build-home', 'home', 'tmp'))
    for directory in (build_home, home, tmp):
        directory.mkdir(mode=0o700)
    test_env = {
        'PATH': SYSTEM_PATH, 'HOME': str(home), 'TMPDIR': str(tmp), 'LC_ALL': 'C.UTF-8',
        'CI_ACCEPTANCE_ROOT': str(scope), 'FACADE_HOME': str(home / '.facade'),
        'FACADE_SCENARIO_HOME_LOG': str(scope / HOME_LOG),
    }
    cargo = shutil.which('cargo')
    if cargo is None:
        raise AcceptanceError('cargo is unavailable')
    workspace_build = receipt['workspace_build']
    target_dir = ((FRAMEWORK / os.environ.get('CARGO_TARGET_DIR', 'target')).resolve()
                  if workspace_build else scope / 'target')
    build_env = {
        'PATH': f'{Path(cargo).parent}:{SYSTEM_PATH}', 'HOME': str(build_home), 'TMPDIR': str(tmp),
        'LC_ALL': 'C.UTF-8', 'CI_ACCEPTANCE_ROOT': str(scope), 'CARGO_TARGET_DIR': str(target_dir),
        'CARGO_HOME': os.environ.get('CARGO_HOME', str(Path.home() / '.cargo')),
        'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')),
        'CARGO_BUILD_JOBS': '2', 'CARGO_INCREMENTAL': '0',
    }
    rustc = subprocess.check_output(['rustc', '-vV'], cwd=FRAMEWORK, env=build_env, text=True, timeout=30)
    target = next((line.removeprefix('host: ') for line in rustc.splitlines() if line.startswith('host: ')), '')
    if not target.startswith('x86_64-'):
        raise AcceptanceError('expected a native x64 Rust host target')
    receipt['native'].update(target=target, rustc=rustc.strip(), cargo=subprocess.check_output(
        [cargo, '--version'], cwd=FRAMEWORK, env=build_env, text=True, timeout=30,
    ).strip())
    build_args = build_flags(target, workspace_build, receipt['offline'])
    compiled = output / 'keeper-build.log'
    logged_command([cargo, 'test', *build_args, *SCENARIO_BUILD], FRAMEWORK, build_env, compiled, receipt)
    keeper = cargo_artifact(compiled, 'keeper', test=True)
    # Cargo test can also update the standalone fake CLI under target/debug.
    build = output / 'programs.log'
    logged_command([cargo, 'build', *build_args, *PROGRAM_BUILD], FRAMEWORK, build_env, build, receipt)
    programs = {name: cargo_artifact(build, name, test=False) for name in PROGRAMS}
    profile = (target_dir if workspace_build else target_dir / target) / 'debug'
    if keeper.parent != profile / 'deps' or programs != {name: profile / name for name in PROGRAMS}:
        raise AcceptanceError('Cargo did not report the scenario and its adjacent native programs')
    executables = {**programs, 'keeper': keeper}
    digests = {name: hash_file(path) for name, path in executables.items()}
    private_bin = scope / 'bin'
    private_bin.mkdir(mode=0o700)
    staged = {name: Path(shutil.copy2(path, private_bin / name)) for name, path in executables.items()}
    receipt['executable_sha256'] = {name: hash_file(path) for name, path in staged.items()}
    if receipt['executable_sha256'] != digests:
        raise AcceptanceError('a Cargo artifact changed while staging the Keeper fixture')

    log = output / 'keeper.log'
    started = time.monotonic()
    try:
        logged_command([staged['keeper'], *TEST_ARGS], FRAMEWORK / 'tests', test_env, log, receipt, timeout=SCENARIO_TIMEOUT)
    finally:
        receipt['scenario_elapsed_seconds'] = round(time.monotonic() - started, 3)
    receipt['executable_sha256_after'] = {name: hash_file(path) for name, path in staged.items()}
    if receipt['executable_sha256_after'] != receipt['executable_sha256']:
        raise AcceptanceError('a native executable changed during the Keeper scenario')
    receipt['observation'] = keeper_observation(log)


def keeper_observation(log):
    if not observed_framework_tests([SELECTOR], log.read_text()):
        raise AcceptanceError('expected exactly one passing Keeper recovery selector')
    markers = read_markers(log, OBSERVATION)
    if len(markers) != 1:
        raise AcceptanceError('expected one Keeper recovery observation')
    observation = markers[0]
    try:
        identities = [observation[name] for name in ('daemon', 'keeper_before', 'keeper_after', 'cli', 'stopped_cli')]
        if (any(identity.keys() != {'pid', 'birth'} or type(identity['pid']) is not int or identity['pid'] <= 0
                or not re.fullmatch(r'[0-9]+', identity['birth']) for identity in identities)
                or len({identity['pid'] for identity in identities}) != len(identities)
                or identities[1]['birth'] == identities[2]['birth']):
            raise AcceptanceError('Keeper recovery did not identify the original and replacement processes')
        reference = observation['reference']
        exit_status = observation['exit']
        if (reference['agent_id'] != 'a1' or not re.fullmatch(r'[0-9a-f-]{36}', reference['machine_id'])
                or type(observation['api_version']) is not int or observation['api_version'] != 1
                or type(observation['watch']) is not int or observation['watch'] <= 0
                or observation['submissions'] != ['still here'] or exit_status.keys() != {'at'}
                or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', exit_status['at'])):
            raise AcceptanceError('Keeper recovery did not retain the original terminal and watch')
    except (KeyError, TypeError, AttributeError) as error:
        raise AcceptanceError('malformed Keeper recovery observation') from error
    return observation


def verify_keeper(output, receipt, source, *, program_sha256=None):
    try:
        if (receipt['case'], receipt['stage'], receipt['binding'], receipt['status']) != (CASE, 'native', BINDING, 'pass'):
            raise AcceptanceError('expected passing evidence for the exact Keeper case')
        if (receipt['source'] != source or receipt['source_after'] != source
                or receipt['harness_sha256'] != harness_hashes()):
            raise AcceptanceError('Keeper evidence is for a different candidate, attempt or harness')
        native = receipt['native']
        target = native['target']
        channel = tomllib.loads((FRAMEWORK / 'rust-toolchain.toml').read_text())['toolchain']['channel']
        if ((native['platform'], native['architecture']) != ('linux-x64', 'x86_64')
                or not re.fullmatch(r'x86_64-unknown-linux-(gnu|musl)', target) or not native['kernel']
                or f'host: {target}' not in native['rustc'].splitlines()
                or f'release: {channel}' not in native['rustc'].splitlines()):
            raise AcceptanceError('Keeper evidence did not run on Linux x64 with the pinned native toolchain')
        workspace_build = receipt['workspace_build']
        if (type(workspace_build) is not bool or type(receipt['offline']) is not bool
                or (source['run'].startswith('github/') and not workspace_build)):
            raise AcceptanceError('hosted Keeper evidence must revalidate the workspace build')
        if source['run'].startswith('github/') and program_sha256 is None:
            raise AcceptanceError('hosted Keeper evidence needs verified same-attempt SSH programs')
        digests = receipt['executable_sha256']
        if (digests.keys() != {*PROGRAMS, 'keeper'} or digests != receipt['executable_sha256_after']
                or not all(re.fullmatch(r'[0-9a-f]{64}', value) for value in digests.values())):
            raise AcceptanceError('Keeper evidence did not retain matching executable hashes')
        if program_sha256 is not None and {name: digests[name] for name in PROGRAMS} != program_sha256:
            raise AcceptanceError('Keeper and real SSH did not use the same candidate programs')
        if (receipt['scenario_timeout_seconds'] != SCENARIO_TIMEOUT
                or not 0 <= receipt['scenario_elapsed_seconds'] <= SCENARIO_TIMEOUT):
            raise AcceptanceError('Keeper evidence did not execute within the exact scenario deadline')

        commands = receipt['commands']
        names = ['keeper-build.log', 'programs.log', 'keeper.log']
        if [command['log'] for command in commands] != names:
            raise AcceptanceError('Keeper evidence is missing a build or scenario log')
        flags = build_flags(target, workspace_build, receipt['offline'])
        scope = Path(receipt['scope'])
        argv = [command['argv'] for command in commands]
        for actual, task, package in zip(argv[:2], ('test', 'build'), (SCENARIO_BUILD, PROGRAM_BUILD), strict=True):
            if Path(actual[0]).name != 'cargo' or actual[1:] != [task, *flags, *package]:
                raise AcceptanceError('Keeper evidence did not use the locked candidate Cargo build')
        if argv[2] != [str(scope / 'bin' / 'keeper'), *TEST_ARGS]:
            raise AcceptanceError('Keeper evidence used a different executable or selector')
        for command, name in zip(commands, names, strict=True):
            log = output / name
            if (command['status'] != 'pass' or hash_file(log) != command['sha256']
                    or log.read_text().splitlines()[:1] != ['$ ' + shlex.join(command['argv'])]):
                raise AcceptanceError(f'Keeper evidence log changed or failed: {name}')
        if receipt['observation'] != keeper_observation(output / 'keeper.log'):
            raise AcceptanceError('Keeper receipt does not match the original observation')

        verify_native_cleanup(receipt)
        teardown = receipt['scenario_teardown']
        home_log = output / HOME_LOG
        homes = owned_homes(home_log, scope / 'tmp')
        sockets = teardown['sockets']
        if (scope.parent != Path('/tmp') or not scope.name.startswith('fci-keeper-') or len(homes) != 1
                or homes[0].name != 'home' or teardown['homes'] != list(map(str, homes))
                or hash_file(home_log) != receipt['homes_sha256'] or len(sockets) != 2
                or not all(teardown[field] is True for field in ('homes_removed', 'sockets_absent', 'fallback_home_empty'))
                or receipt['cleanup']['log'] != 'no processes left\n'):
            raise AcceptanceError('Keeper evidence did not establish clean scoped teardown')
        directory = str(Path(sockets[0]).parent)
        home_key = sha256(os.fsencode(homes[0])).hexdigest()[:10]
        if not re.fullmatch(r'/tmp/facade-framework-[0-9]+', directory) or sockets != [
                f'{directory}/{role}-{home_key}.sock' for role in ('daemon', 'keeper')]:
            raise AcceptanceError('Keeper evidence did not identify both owned sockets')
    except (KeyError, TypeError, AttributeError, IndexError) as error:
        raise AcceptanceError('malformed Keeper recovery receipt') from error
    return CASE


def clean_fixture(scope, output, receipt, *, completed):
    home_log = scope / HOME_LOG
    sockets = {}
    try:
        sockets = scenario_sockets(home_log, scope / 'tmp')
        homes = owned_homes(home_log, scope / 'tmp')
        if home_log.is_file():
            shutil.copyfile(home_log, output / HOME_LOG)
            receipt['homes_sha256'] = hash_file(output / HOME_LOG)
        teardown = receipt['scenario_teardown'] = {
            'homes': list(map(str, homes)),
            'homes_removed': all(not os.path.lexists(home.parent) for home in homes),
            'sockets': sorted(map(str, sockets.values())),
            'sockets_absent': all(not os.path.lexists(path) for path in sockets.values()),
            'fallback_home_empty': not any((scope / 'home').iterdir()),
        }
    finally:
        clean_native_scope(scope, sockets, receipt)
    verify_native_cleanup(receipt)
    if completed and (len(homes) != 1 or not teardown['homes_removed'] or not teardown['sockets_absent']
                      or not teardown['fallback_home_empty'] or receipt['cleanup']['log'] != 'no processes left\n'):
        raise AcceptanceError('the Keeper scenario did not leave one fully removed fixture')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True, type=lambda path: Path(path).resolve())
    parser.add_argument('--run-id', help='unique local attempt ID, omitted on GitHub Actions')
    parser.add_argument('--offline', action='store_true', help='use cached Cargo dependencies')
    parser.add_argument('--reuse-workspace-build', action='store_true',
                        help='revalidate the current native debug build with locked Cargo commands')
    parser.add_argument('--ssh-receipt', type=Path, help='real SSH receipt from the same build and attempt')
    args = parser.parse_args()
    try:
        platform = runtime()
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise AcceptanceError('requires pidfds for scoped process cleanup')
        os.close(os.pidfd_open(os.getpid()))
        run = run_identity(args.run_id, os.environ)
        if run.startswith('github/') and (not args.reuse_workspace_build or args.ssh_receipt is None):
            raise AcceptanceError('hosted Keeper evidence requires the workspace build and same-attempt SSH receipt')
        source = candidate_identity(run)
        case = read_cases(ROOT)[0].get(CASE)
        if case is None or case.stage != 'native' or case.test != BINDING:
            raise AcceptanceError(f'{CASE}: expected the native Keeper recovery scenario binding')
        args.output_dir.mkdir(mode=0o700, parents=True)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(2, f'Keeper recovery: {error}\n')

    signal.signal(signal.SIGTERM, interrupted)
    started = time.monotonic()
    uname = os.uname()
    receipt = {
        'case': CASE, 'stage': case.stage, 'binding': BINDING, 'source': source, 'status': 'fail', 'commands': [],
        'native': {'platform': platform, 'kernel': uname.release, 'architecture': uname.machine},
        'harness_sha256': harness_hashes(), 'scenario_timeout_seconds': SCENARIO_TIMEOUT,
        'workspace_build': args.reuse_workspace_build, 'offline': args.offline,
    }
    scope = Path(tempfile.mkdtemp(prefix='fci-keeper-', dir='/tmp'))
    receipt['scope'] = str(scope)
    completed = False
    try:
        run_scenario(scope, args.output_dir, receipt)
        receipt['source_after'] = candidate_identity(run)
        if receipt['source_after'] != source:
            raise AcceptanceError('candidate source changed during the scenario')
        if harness_hashes() != receipt['harness_sha256']:
            raise AcceptanceError('the local evidence harness changed during the scenario')
        completed = True
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        receipt['error'] = str(error)
        print(f'Keeper recovery: {error}', file=sys.stderr)
    finally:
        cleanup_started = time.monotonic()
        try:
            try:
                clean_fixture(scope, args.output_dir, receipt, completed=completed)
            except (OSError, ValueError, RuntimeError, KeyboardInterrupt) as error:
                receipt['teardown_error'] = str(error)
                print(f'Keeper recovery cleanup: {error}', file=sys.stderr)
            finally:
                receipt['cleanup_elapsed_seconds'] = round(time.monotonic() - cleanup_started, 3)
            if completed and 'teardown_error' not in receipt:
                try:
                    programs = None
                    if args.ssh_receipt is not None:
                        ssh = read_json(args.ssh_receipt)
                        if not isinstance(ssh, dict) or ssh.get('source') != source or 'program_sha256' not in ssh:
                            raise AcceptanceError('Keeper and real SSH did not use the same candidate and attempt')
                        programs = ssh['program_sha256']
                    receipt['status'] = 'pass'
                    verify_keeper(args.output_dir, receipt, source, program_sha256=programs)
                except (OSError, ValueError, KeyboardInterrupt) as error:
                    receipt['status'] = 'fail'
                    receipt['error'] = str(error)
                    print(f'Keeper recovery evidence: {error}', file=sys.stderr)
        finally:
            receipt['elapsed_seconds'] = round(time.monotonic() - started, 3)
            write_receipt(args.output_dir / 'receipt.json', receipt)
    print(f"{CASE} {receipt['status']} ({args.output_dir / 'receipt.json'})")
    return int(receipt['status'] != 'pass')


if __name__ == '__main__':
    sys.exit(main())
