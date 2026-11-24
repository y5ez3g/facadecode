"""Shared process and evidence helpers for Linux native Framework checks."""

from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import stat
import time

from catalog import AcceptanceError, json_object
from evidence import clean_scope, execute, git


SYSTEM_PATH = '/usr/bin:/bin'
ROOT = Path(__file__).resolve().parents[1]


def hash_file(path):
    with path.open('rb') as data:
        return file_digest(data, 'sha256').hexdigest()


def source_identity(run):
    return {'run': run, 'revision': git(ROOT, 'rev-parse', 'HEAD'), 'tree': git(ROOT, 'rev-parse', 'HEAD^{tree}')}


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


def owned_homes(log, test_tmp):
    homes = []
    if log.is_file():
        for line in log.read_text().splitlines():
            home = Path(line)
            if not home.is_absolute() or not home.resolve().is_relative_to(test_tmp):
                raise AcceptanceError(f'scenario reported an unowned home {home}')
            homes.append(home)
    return homes


def scenario_sockets(home_log, test_tmp):
    return {
        (home, role): Path(f'/tmp/facade-framework-{os.getuid()}/{role}-{sha256(os.fsencode(home)).hexdigest()[:10]}.sock')
        for home in owned_homes(home_log, test_tmp) for role in ('daemon', 'keeper')
    }


def wait_for(description, condition, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if result := condition():
            return result
        time.sleep(0.1)
    raise AssertionError(f'timed out waiting for {description}')


def process_identity(pid):
    process = Path('/proc') / str(pid)
    fields = (process / 'stat').read_text().rsplit(') ', 1)[1].split()
    assert fields[0] != 'Z', pid
    return {'pid': pid, 'start_ticks': int(fields[19]), 'executable': str((process / 'exe').resolve(strict=True))}


def query(endpoint, operation, arguments):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(8)
        stream.connect(str(endpoint))
        with stream.makefile('rwb') as lines:
            def request(number, method, params):
                frame = {'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params}
                lines.write(json.dumps(frame).encode() + b'\n')
                lines.flush()
                result = json.loads(lines.readline())
                assert result.get('id') == number and 'result' in result, (frame, result)
                return result['result']

            hello = request(1, 'hello', {'api_versions': [1], 'kind': 'terminal', 'build': 'qa-install'})
            assert hello['api_version'] == 1, hello
            return hello, request(2, 'call', {'op': operation, 'args': arguments})


def clean_native_scope(isolated, sockets, receipt):
    with (isolated / 'cleanup.log').open('w+') as log:
        # The native checks finish while the services are live. Reclaim this test's scope
        # without waiting for the Daemon's production idle timer.
        status = clean_scope(ROOT, isolated, {'PATH': SYSTEM_PATH}, log, interrupted=True)
        log.seek(0)
        receipt['cleanup'] = {'status': status, 'log': log.read()}
    if status != 'pass':
        raise RuntimeError(f'cleanup {status}; kept {isolated} for diagnosis')
    try:
        for endpoint in sockets.values():
            if not os.path.lexists(endpoint):
                continue
            entry = endpoint.lstat()
            if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.getuid():
                raise RuntimeError(f'unexpected socket entry at {endpoint}')
            endpoint.unlink()
        shutil.rmtree(isolated)
    except (OSError, RuntimeError) as error:
        receipt['cleanup']['status'] = 'fail'
        raise RuntimeError(f'cleanup failed; kept {isolated} for diagnosis') from error
    receipt['cleanup']['sockets_absent'] = True


def interrupted(signum, _frame):
    raise KeyboardInterrupt(f'interrupted by signal {signum}')


def verify_native_cleanup(receipt):
    cleanup = receipt.get('cleanup')
    if (not isinstance(cleanup, dict) or cleanup.get('status') != 'pass'
            or cleanup.get('sockets_absent') is not True or not isinstance(cleanup.get('log'), str)
            or cleanup['log'].splitlines()[-1:] != ['no processes left']):
        raise AcceptanceError('native fixture cleanup did not complete')


def read_markers(path, prefix):
    return [
        json.loads(line.removeprefix(prefix), object_pairs_hook=json_object)
        for line in path.read_text().splitlines() if line.startswith(prefix)
    ]


def write_receipt(path, receipt):
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    try:
        temporary.write_text(json.dumps(receipt, indent=2) + '\n')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
