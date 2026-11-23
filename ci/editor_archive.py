"""Stage a digest-pinned official VS Code archive before running editor checks."""

import argparse
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
from time import sleep
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from catalog import AcceptanceError, read_json


DOWNLOAD = 'https://vscode.download.prss.microsoft.com/dbazure/download/stable'


@dataclass(frozen=True)
class EditorArchive:
    target: str
    version: str
    commit: str
    asset: str
    size: int
    sha256: str
    executable: str
    metadata: str
    first_transfer_seconds: int = 210

    def __post_init__(self):
        if (not re.fullmatch(r'[0-9a-f]{40}', self.commit)
                or not re.fullmatch(r'[0-9a-f]{64}', self.sha256) or self.size <= 0):
            raise AcceptanceError(f'{self.target}: invalid official editor archive pin')

    @property
    def name(self):
        suffix = '.zip' if self.asset.endswith('.zip') else '.tar.gz'
        return f'vscode-{self.version}-{self.target}{suffix}'

    @property
    def url(self):
        return f'{DOWNLOAD}/{self.commit}/{self.asset}'


FLOOR = EditorArchive(
    'linux-x64', '1.105.1', '7d842fb85a0275a4a8e4d7e040d2625abbf7f084',
    'code-stable-x64-1760482455.tar.gz', 161_336_861,
    '32a650f1a111df00354ad9571f57d12268376777677dd5af2162ead921067a89',
    'VSCode-linux-x64/code', 'VSCode-linux-x64/resources/app', first_transfer_seconds=42,
)
EDITOR = {'version': FLOOR.version, 'commit': FLOOR.commit}

NATIVE_VERSION = '1.147.0'
NATIVE_COMMIT = '8a14f0cc1b08d531eb83255ea3764ae22aa932b5'
MAC_APP = 'Visual Studio Code.app/Contents'
WINDOWS_APP = f'{NATIVE_COMMIT[:10]}/resources/app'
# Archive sizes and SHA-256 values from Microsoft's versioned stable update redirects.
NATIVE = {
    pin.target: pin for pin in (
        EditorArchive('linux-x64', NATIVE_VERSION, NATIVE_COMMIT, 'code-stable-x64-1794902874.tar.gz',
                      414_438_586, '6fd8b14600f2a8ddb8b4833d8bf288f3dc4c34b2878d2c6c3fec7e16c81023bc',
                      'VSCode-linux-x64/code', 'VSCode-linux-x64/resources/app'),
        EditorArchive('linux-arm64', NATIVE_VERSION, NATIVE_COMMIT, 'code-stable-arm64-1794902859.tar.gz',
                      387_756_351, 'b137f53a29a1debf9fc30027823556863202f94c10d924dd70f2d2370795412d',
                      'VSCode-linux-arm64/code', 'VSCode-linux-arm64/resources/app'),
        EditorArchive('darwin-x64', NATIVE_VERSION, NATIVE_COMMIT, 'VSCode-darwin.zip',
                      399_023_878, 'a91677b96c1a73de366f54cb4a497c8095459e07e95457ffab985820f93fb298',
                      f'{MAC_APP}/MacOS/Code', f'{MAC_APP}/Resources/app'),
        EditorArchive('darwin-arm64', NATIVE_VERSION, NATIVE_COMMIT, 'VSCode-darwin-arm64.zip',
                      393_619_875, '149d944feb599b076b48406b174e1c3cd1d510e9d673854777a20a6f4116a59a',
                      f'{MAC_APP}/MacOS/Code', f'{MAC_APP}/Resources/app'),
        EditorArchive('win32-x64', NATIVE_VERSION, NATIVE_COMMIT, 'VSCode-win32-x64-1.147.0.zip',
                      406_984_775, '42d65f18009959964d7cff8ca6f33149a195d52c08622821c8c681a08469c26e',
                      'Code.exe', WINDOWS_APP),
        EditorArchive('win32-arm64', NATIVE_VERSION, NATIVE_COMMIT, 'VSCode-win32-arm64-1.147.0.zip',
                      383_687_834, 'd77737304e9856afb63ea240ddb164a065f83aad31aa4595fe4c685513755c26',
                      'Code.exe', WINDOWS_APP),
    )
}


def matches_archive(path, pin):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != pin.size:
        return False
    with path.open('rb') as archive:
        return hashlib.file_digest(archive, 'sha256').hexdigest() == pin.sha256


def transfer(pin, incoming, log, env):
    command = [
        'curl', '--disable', '--fail', '--no-progress-meter', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15',
        '--speed-limit', '131072', '--speed-time', '25', '--write-out', '%{response_code}',
        '--max-filesize', str(pin.size), '--output', str(incoming), pin.url,
    ]
    recovery = min(pin.first_transfer_seconds, 85)
    for attempt, limit in enumerate((pin.first_transfer_seconds, recovery), 1):
        try:
            result = subprocess.run(command[:2] + ['--max-time', str(limit)] + command[2:],
                                    env=env, stdout=subprocess.PIPE, stderr=log, text=True, timeout=limit + 3)
            status, http = result.returncode, result.stdout.strip()
        except subprocess.TimeoutExpired:
            status, http = 28, '000'
        if status == 0 and http == '200':
            return
        print(f'Editor transfer {attempt} failed for {pin.target} (curl {status}, HTTP {http}).',
              file=log, flush=True)
        transient = status in (5, 6, 7, 18, 28, 52, 55, 56) or (
            status == 22 and http in ('408', '429', '500', '502', '503', '504'))
        if attempt == 2 or not transient:
            raise AcceptanceError(f'editor archive fetch failed for {pin.target}')
        print(f'Retrying once within {recovery} seconds.', file=log, flush=True)
        incoming.unlink(missing_ok=True)
        sleep(2)


def fetch_archive(cache, archive, pin, log, env):
    if archive.exists() or archive.is_symlink():
        print('Cached editor archive failed verification. Fetching the pinned archive.', file=log)
    print(f'Fetching {pin.url}', file=log, flush=True)
    with TemporaryDirectory(prefix='.editor-download-', dir=cache) as scratch:
        incoming = Path(scratch) / pin.name
        transfer(pin, incoming, log, env)
        if not matches_archive(incoming, pin):
            raise AcceptanceError(f'editor archive checksum or size mismatch for {pin.target}')
        incoming.replace(archive)


def unpack_editor(archive, stage, pin, log, env):
    with archive.open('rb') as data:
        if hashlib.file_digest(data, 'sha256').hexdigest() != pin.sha256:
            raise AcceptanceError('editor archive changed before extraction')
        print(f'Verified editor archive SHA-256 {pin.sha256}', file=log, flush=True)
        data.seek(0)
        if pin.target.startswith('darwin-'):
            # ditto retains the signed app bundle's modes and framework symlinks.
            subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(stage)],
                           env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
        elif pin.target.startswith('win32-'):
            with ZipFile(data) as files:
                files.extractall(stage)
        else:
            with tarfile.open(fileobj=data, mode='r:gz') as files:
                files.extractall(stage, filter='data')


def stage_editor(cache, stage, log_path, env, *, pin=FLOOR):
    """Verify the official archive, then install it into an empty private stage."""
    cache.mkdir(parents=True, exist_ok=True)
    stage.mkdir(mode=0o700, parents=True, exist_ok=True)
    if stage.is_symlink() or next(stage.iterdir(), None) is not None:
        raise AcceptanceError(f'editor stage must be an empty directory: {stage}')
    archive = cache / pin.name
    with log_path.open('w', encoding='utf-8') as log:
        if matches_archive(archive, pin):
            print(f'Using cached editor archive {pin.sha256}', file=log)
        else:
            fetch_archive(cache, archive, pin, log, env)
        try:
            unpack_editor(archive, stage, pin, log, env)
        except (tarfile.TarError, BadZipFile, subprocess.SubprocessError) as error:
            raise AcceptanceError(f'editor archive extraction failed for {pin.target}') from error
        executable = stage / pin.executable
        metadata = stage / pin.metadata
        build = read_json(metadata / 'product.json')['commit']
        version = read_json(metadata / 'package.json')['version']
        if (version, build) != (pin.version, pin.commit) or not executable.is_file():
            raise AcceptanceError(f'{pin.target}: expected official VS Code {pin.version} ({pin.commit})')
        print(f'Extracted official VS Code {pin.version} ({pin.commit}) for {pin.target}', file=log)
    return executable.resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', choices=sorted(NATIVE))
    for option in ('cache', 'stage', 'log'):
        parser.add_argument(f'--{option}', type=Path, required=True)
    parser.add_argument('--github-env', type=Path)
    args = parser.parse_args()
    try:
        executable = stage_editor(args.cache, args.stage, args.log, os.environ, pin=NATIVE[args.target])
        if any(character in str(executable) for character in '\r\n'):
            raise AcceptanceError('the editor executable must have a one-line path')
        if args.github_env:
            with args.github_env.open('a', encoding='utf-8', newline='\n') as stream:
                stream.write(f'VSCODE_EXECUTABLE={executable}\n')
        else:
            print(executable)
    except (OSError, KeyError, ValueError) as error:
        print(f'Could not stage the pinned editor: {error}', file=sys.stderr)
        return 1
    finally:
        if args.log.is_file():
            print(args.log.read_text(encoding='utf-8', errors='replace'), end='', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
