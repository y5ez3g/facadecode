from dataclasses import replace
import hashlib
import json
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from catalog import AcceptanceError
from editor_archive import FLOOR, stage_editor


class EditorArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.archive = self.cache / FLOOR.name
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
            for file, record in (('product.json', {'commit': FLOOR.commit}), ('package.json', {'version': FLOOR.version})):
                payload = json.dumps(record).encode()
                entry = tarfile.TarInfo(f'{FLOOR.metadata}/{file}')
                entry.size = len(payload)
                archive.addfile(entry, io.BytesIO(payload))
        self.pinned = data.getvalue()
        self.pin = replace(FLOOR, size=len(self.pinned), sha256=hashlib.sha256(self.pinned).hexdigest())


    def test_verified_cache_stages_with_no_fetch(self):
        self.archive.write_bytes(self.pinned)
        with patch('editor_archive.subprocess.run') as fetch:
            self.assertEqual(stage_editor(self.cache, self.stage, self.log, {}, pin=self.pin).read_bytes(), self.contents)
            fetch.assert_not_called()
        self.assertIn('Using cached editor archive', self.log.read_text())

    def test_wrong_digest_in_cache_needs_a_fresh_verified_fetch(self):
        self.archive.write_bytes(bytes(len(self.pinned)))

        def fetch(command, **_):
            self.assertEqual(command[-1], FLOOR.url)
            Path(command[command.index('--output') + 1]).write_bytes(self.pinned)
            return subprocess.CompletedProcess(command, 0, stdout='200')

        with patch('editor_archive.subprocess.run', side_effect=fetch) as fetch_call:
            self.assertEqual(stage_editor(self.cache, self.stage, self.log, {}, pin=self.pin).read_bytes(), self.contents)
            fetch_call.assert_called_once()
        self.assertEqual(self.archive.read_bytes(), self.pinned)
        self.assertIn('Cached editor archive failed verification', self.log.read_text())

    def test_wrong_download_is_never_staged_or_cached(self):
        def fetch(command, **_):
            Path(command[command.index('--output') + 1]).write_bytes(bytes(len(self.pinned)))
            return subprocess.CompletedProcess(command, 0, stdout='200')

        with patch('editor_archive.subprocess.run', side_effect=fetch):
            with self.assertRaisesRegex(AcceptanceError, 'checksum or size mismatch'):
                stage_editor(self.cache, self.stage, self.log, {}, pin=self.pin)
        self.assertEqual(list(self.cache.iterdir()), [])
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_persistent_transient_failure_stops_after_one_recovery(self):
        failure = subprocess.CompletedProcess(['curl'], 22, stdout='503')
        with patch('editor_archive.subprocess.run', return_value=failure) as download, patch('editor_archive.sleep'):
            with self.assertRaisesRegex(AcceptanceError, 'editor archive fetch failed'):
                stage_editor(self.cache, self.stage, self.log, {}, pin=self.pin)
        self.assertEqual(download.call_count, 2)
        self.assertIn('HTTP 503', self.log.read_text())
        self.assertEqual(list(self.cache.iterdir()), [])
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_wrong_official_build_is_rejected_even_with_matched_archive_digest(self):
        self.archive.write_bytes(self.pinned)
        self.pin = replace(self.pin, commit='1' * 40)
        with self.assertRaisesRegex(AcceptanceError, 'expected official VS Code'):
            stage_editor(self.cache, self.stage, self.log, {}, pin=self.pin)
