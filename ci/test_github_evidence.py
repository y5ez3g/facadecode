from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from catalog import AcceptanceError
from github_evidence import artifact_manifest, check_jobs, unpack_artifact


class HostedEvidence(unittest.TestCase):
    def test_requires_this_attempts_product_and_artifact_identity(self):
        run = {'run_attempt': 2, 'id': 7, 'head_sha': 'a' * 40, 'repository': {'id': 3}}
        core = {
            'name': 'shadow-pilot-core-2', 'id': 31, 'expired': False, 'digest': 'sha256:' + 'b' * 64,
            'workflow_run': {'id': 7, 'head_sha': 'a' * 40, 'repository_id': 3},
        }
        with patch('github_evidence.gh_json') as gh:
            gh.return_value = [{'total_count': 1, 'artifacts': [core]}]
            self.assertEqual(artifact_manifest('run', run, ('core',)), {'core': core})
            with self.assertRaisesRegex(AcceptanceError, 'missing artifacts'):
                artifact_manifest('run', run, ('core', 'extension'))
            for changed in (
                {**core, 'name': 'shadow-pilot-core-1'},
                {**core, 'digest': None},
                {**core, 'expired': True},
                {**core, 'workflow_run': {**core['workflow_run'], 'head_sha': 'c' * 40}},
                {**core, 'workflow_run': {**core['workflow_run'], 'id': 8}},
            ):
                gh.return_value = [{'total_count': 1, 'artifacts': [changed]}]
                with self.subTest(changed=changed), self.assertRaises(AcceptanceError):
                    artifact_manifest('run', run, ('core',))
            gh.return_value = [{'total_count': 2, 'artifacts': [core, core]}]
            with self.assertRaisesRegex(AcceptanceError, 'duplicate'):
                artifact_manifest('run', run, ('core',))

    def test_requires_each_selected_job_to_pass(self):
        reports = [
            {'name': name, 'status': 'completed', 'conclusion': 'success'}
            for name in ('Shadow catalog and policy tests', 'Shadow pilot (extension)', 'Shadow pilot evidence')
        ]
        check_jobs(reports, ('extension',))
        with self.assertRaisesRegex(AcceptanceError, 'Shadow pilot \\(core\\)'):
            check_jobs(reports, ('core', 'extension'))
        for status, conclusion in (('completed', 'failure'), ('completed', 'skipped'), ('queued', None)):
            bad = {**reports[1], 'status': status, 'conclusion': conclusion}
            with self.subTest(status=status, conclusion=conclusion), self.assertRaises(AcceptanceError):
                check_jobs([reports[0], bad, reports[2]], ('extension',))

    def test_rehashes_zip_and_refuses_entries_outside_the_receipt_directory(self):
        with TemporaryDirectory(prefix='hosted-artifact-') as folder:
            root = Path(folder)
            archive = root / 'job.zip'
            with ZipFile(archive, 'w') as package:
                package.writestr('receipt.json', '{}')
            expected = 'sha256:' + sha256(archive.read_bytes()).hexdigest()
            unpack_artifact(archive, root / 'valid', expected)
            self.assertEqual((root / 'valid/receipt.json').read_text(), '{}')
            archive.write_bytes(archive.read_bytes() + b'changed')
            with self.assertRaisesRegex(AcceptanceError, 'does not match the GitHub digest'):
                unpack_artifact(archive, root / 'changed', expected)
            self.assertFalse((root / 'changed').exists())
            with ZipFile(archive, 'w') as package:
                package.writestr('../outside', '{}')
            expected = 'sha256:' + sha256(archive.read_bytes()).hexdigest()
            with self.assertRaisesRegex(AcceptanceError, 'invalid archive entry'):
                unpack_artifact(archive, root / 'outside-test', expected)
            self.assertFalse((root / 'outside').exists())
