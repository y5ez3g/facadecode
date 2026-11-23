import hashlib
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from catalog import AcceptanceError
from editor_archive import ARCHIVE_NAME, ARCHIVE_URL, stage_editor


class EditorArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.archive = self.cache / ARCHIVE_NAME
        self.stage = self.root / 'editor'
        self.stage.mkdir()
        self.log = self.root / 'download.log'
        data = io.BytesIO()
        self.contents = b'editor binary fixture'
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            entry = tarfile.TarInfo('VSCode-linux-x64/code')
            entry.size = len(self.contents)
            entry.mode = 0o755
            archive.addfile(entry, io.BytesIO(self.contents))
        self.pinned = data.getvalue()
        self.enterContext(patch('editor_archive.ARCHIVE_SIZE', len(self.pinned)))
        self.enterContext(patch('editor_archive.ARCHIVE_SHA256', hashlib.sha256(self.pinned).hexdigest()))

    def test_verified_cache_stages_with_no_fetch(self):
        self.archive.write_bytes(self.pinned)
        with patch('editor_archive.subprocess.run') as fetch:
            self.assertEqual(stage_editor(self.cache, self.stage, self.log, {}).read_bytes(), self.contents)
            fetch.assert_not_called()
        self.assertIn('Using cached editor archive', self.log.read_text())

    def test_wrong_digest_in_cache_needs_a_fresh_verified_fetch(self):
        self.archive.write_bytes(bytes(len(self.pinned)))

        def fetch(command, **_):
            self.assertEqual(command[-1], ARCHIVE_URL)
            self.assertEqual(command[command.index('--retry') + 1], '1')
            Path(command[command.index('--output') + 1]).write_bytes(self.pinned)

        with patch('editor_archive.subprocess.run', side_effect=fetch) as fetch_call:
            self.assertEqual(stage_editor(self.cache, self.stage, self.log, {}).read_bytes(), self.contents)
            fetch_call.assert_called_once()
        self.assertEqual(self.archive.read_bytes(), self.pinned)
        self.assertIn('Cached editor archive failed verification', self.log.read_text())

    def test_wrong_download_is_never_staged_or_cached(self):
        def fetch(command, **_):
            Path(command[command.index('--output') + 1]).write_bytes(bytes(len(self.pinned)))

        with patch('editor_archive.subprocess.run', side_effect=fetch):
            with self.assertRaisesRegex(AcceptanceError, 'checksum or size mismatch'):
                stage_editor(self.cache, self.stage, self.log, {})
        self.assertEqual(list(self.cache.iterdir()), [])
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_fetch_failure_leaves_no_published_archive(self):
        with patch('editor_archive.subprocess.run', side_effect=subprocess.CalledProcessError(28, 'curl')):
            with self.assertRaisesRegex(AcceptanceError, 'editor archive fetch failed'):
                stage_editor(self.cache, self.stage, self.log, {})
        self.assertEqual(list(self.cache.iterdir()), [])
        self.assertEqual(list(self.stage.iterdir()), [])
