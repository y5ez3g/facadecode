"""Run native editor tests with overlapped cleanup in an owned Linux scope."""

import hashlib
import os
import shutil
import signal
import socket
import stat
import sys
import tempfile
from pathlib import Path
from threading import Event

from evidence import clean_scope, execute


def remove_stale_core_sockets(scope):
    socket_dir = Path('/tmp') / f'facade-core-{os.getuid()}'
    homes = {config.parent for config in scope.glob('fdit-*/home/*/facade.json')}
    for home in homes:
        key = hashlib.sha256(os.fsencode(home)).hexdigest()[:10]
        for prefix in ('daemon', 'keeper'):
            endpoint = socket_dir / f'{prefix}-{key}.sock'
            try:
                metadata = endpoint.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != os.getuid():
                raise OSError(f'Unexpected file at fixture endpoint {endpoint}')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                peer.settimeout(0.5)
                try:
                    peer.connect(str(endpoint))
                except FileNotFoundError:
                    continue
                except ConnectionRefusedError:
                    endpoint.unlink(missing_ok=True)
                else:
                    raise OSError(f'Fixture endpoint still accepts connections at {endpoint}')


def main(args):
    if not args or sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        print('Provide a native editor command on Linux with PID handles.', file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parents[1]
    scope = Path(tempfile.mkdtemp(prefix='fnative-', dir='/tmp')).resolve()
    env = os.environ.copy()
    runtime = scope / 'runtime'
    test_env = {
        **env, 'CI_ACCEPTANCE_ROOT': str(scope), 'TMPDIR': str(scope),
        'XDG_RUNTIME_DIR': str(runtime), 'FACADE_IT_OVERLAP_CORE_IDLE': '1',
    }
    cancelled = Event()
    received = None

    def interrupt(signum, _frame):
        nonlocal received
        received = signum
        cancelled.set()

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupt)
    print(f'Owned native editor scope {scope}', flush=True)
    status = 'interrupted'
    try:
        runtime.mkdir(mode=0o700)
        runtime.chmod(0o700)
        status = execute(args, root / 'extension', test_env, sys.stdout, timeout=60 * 60, cancelled=cancelled)
    finally:
        cleanup = clean_scope(root, scope, env, sys.stdout, status != 'pass' or cancelled.is_set())
        if cleanup != 'pass' and status == 'pass':
            status = 'cleanup-fail'
            cleanup = clean_scope(root, scope, env, sys.stdout, True)
        if cleanup == 'pass':
            try:
                remove_stale_core_sockets(scope)
                shutil.rmtree(scope)
                print('Isolated editor profile cleanup finished.', flush=True)
            except OSError as error:
                print(error, file=sys.stderr, flush=True)
                cleanup = 'fail'
        if cleanup != 'pass':
            print(f'Native fixture cleanup failed. Kept {scope} for diagnosis.', file=sys.stderr, flush=True)
    if received is not None:
        return 128 + received
    return 0 if status == 'pass' and cleanup == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
