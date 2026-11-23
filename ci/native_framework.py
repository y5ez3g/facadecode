"""Shared process and evidence helpers for Linux native Framework checks."""

from hashlib import file_digest
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import time

from catalog import AcceptanceError, json_object
from evidence import clean_scope, git


SYSTEM_PATH = '/usr/bin:/bin'
ROOT = Path(__file__).resolve().parents[1]


def hash_file(path):
    with path.open('rb') as data:
        return file_digest(data, 'sha256').hexdigest()


def source_identity(run):
    return {'run': run, 'revision': git(ROOT, 'rev-parse', 'HEAD'), 'tree': git(ROOT, 'rev-parse', 'HEAD^{tree}')}


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
