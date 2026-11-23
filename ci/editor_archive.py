"""Fetch and stage the official editor used by the Linux acceptance pilot."""

import hashlib
import subprocess
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory

from catalog import AcceptanceError

EDITOR = {'version': '1.105.1', 'commit': '7d842fb85a0275a4a8e4d7e040d2625abbf7f084'}
ARCHIVE_NAME = 'vscode-1.105.1-linux-x64.tar.gz'
ARCHIVE_URL = (
    'https://vscode.download.prss.microsoft.com/dbazure/download/stable/'
    '7d842fb85a0275a4a8e4d7e040d2625abbf7f084/code-stable-x64-1760482455.tar.gz'
)
ARCHIVE_SIZE = 161_336_861
ARCHIVE_SHA256 = '32a650f1a111df00354ad9571f57d12268376777677dd5af2162ead921067a89'


def matches_archive(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != ARCHIVE_SIZE:
        return False
    with path.open('rb') as archive:
        return hashlib.file_digest(archive, 'sha256').hexdigest() == ARCHIVE_SHA256


def stage_editor(cache, stage, log_path, env):
    """Use the verified archive, even when a cache restore or another run provided it."""
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / ARCHIVE_NAME
    with log_path.open('w') as log:
        if matches_archive(archive):
            print(f'Using cached editor archive {ARCHIVE_SHA256}', file=log)
        else:
            if archive.exists() or archive.is_symlink():
                print('Cached editor archive failed verification. Fetching the pinned archive.', file=log)
            print(f'Fetching {ARCHIVE_URL}', file=log, flush=True)
            with TemporaryDirectory(prefix='.editor-download-', dir=cache) as scratch:
                incoming = Path(scratch) / ARCHIVE_NAME
                command = [
                    'curl', '--disable', '--fail', '--no-progress-meter', '--show-error', '--location',
                    '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15',
                    '--max-time', '120', '--retry', '1', '--retry-connrefused', '--retry-delay', '2',
                    '--max-filesize', str(ARCHIVE_SIZE), '--output', str(incoming), ARCHIVE_URL,
                ]
                try:
                    subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   check=True, timeout=250)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                    raise AcceptanceError(f'editor archive fetch failed. See {log_path}') from error
                if not matches_archive(incoming):
                    raise AcceptanceError(f'editor archive checksum or size mismatch. See {log_path}')
                incoming.replace(archive)
        with archive.open('rb') as data:
            if hashlib.file_digest(data, 'sha256').hexdigest() != ARCHIVE_SHA256:
                raise AcceptanceError(f'editor archive changed before extraction. See {log_path}')
            print(f'Verified editor archive SHA-256 {ARCHIVE_SHA256}', file=log)
            data.seek(0)
            try:
                with tarfile.open(fileobj=data, mode='r:gz') as files:
                    files.extractall(stage, filter='data')
            except tarfile.TarError as error:
                raise AcceptanceError(f'editor archive extraction failed. See {log_path}') from error
        print(f'Extracted official VS Code {EDITOR["version"]} ({EDITOR["commit"]})', file=log)
    return stage / 'VSCode-linux-x64' / 'code'
