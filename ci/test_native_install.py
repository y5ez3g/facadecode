import json
import tempfile
import unittest
from pathlib import Path

from catalog import AcceptanceError, NATIVE_INSTALL_CASES
from check_native_install import SUCCESS_MARKER, verified_install
from native_core import hash_file, source_identity


class NativeInstallEvidence(unittest.TestCase):
    def test_requires_current_candidate_and_both_cases_after_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='native-install-evidence-') as directory:
            root = Path(directory)
            archive, sums, receipt, output = (root / name for name in ('archive', 'SHA256SUMS', 'receipt', 'output'))
            archive.write_bytes(b'archive bytes')
            sums.write_text('checksum input\n')
            attempt = 'local/install-1'
            success = {'case_ids': list(NATIVE_INSTALL_CASES), 'archive_sha256': hash_file(archive)}
            saved = {
                'source': source_identity(attempt),
                'archive_sha256': hash_file(archive),
                'sidecar_sha256': hash_file(sums),
                'success': success,
                'cleanup': {'status': 'pass', 'sockets_absent': True, 'log': 'no processes left\n'},
            }
            receipt.write_text(json.dumps(saved))
            marker = SUCCESS_MARKER + json.dumps(success) + '\n'
            output.write_text(marker)
            self.assertEqual(verified_install(archive, sums, receipt, output, attempt), 2)
            with self.assertRaisesRegex(AcceptanceError, 'source and attempt'):
                verified_install(archive, sums, receipt, output, 'local/install-2')
            for changed in ('', marker + marker, marker.replace(NATIVE_INSTALL_CASES[0], 'other-case')):
                with self.subTest(output=changed):
                    output.write_text(changed)
                    with self.assertRaisesRegex(AcceptanceError, 'exact cases and archive'):
                        verified_install(archive, sums, receipt, output, attempt)
            output.write_text(marker)
            receipt.write_text(json.dumps({**saved, 'cleanup': {**saved['cleanup'], 'log': 'scan failed\n'}}))
            with self.assertRaisesRegex(AcceptanceError, 'cleanup did not complete'):
                verified_install(archive, sums, receipt, output, attempt)
            receipt.write_text(json.dumps(saved))
            archive.write_bytes(b'different bytes')
            with self.assertRaisesRegex(AcceptanceError, 'candidate archive and checksum file'):
                verified_install(archive, sums, receipt, output, attempt)
