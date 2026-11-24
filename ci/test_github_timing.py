import unittest

from github_timing import job_sample


class HostedTiming(unittest.TestCase):
    def test_distinguishes_a_queued_cancellation_from_runner_time(self):
        job = {
            'name': 'Extension on darwin-arm64, Framework implementation',
            'html_url': 'https://github.com/owner/name/actions/runs/1/job/2',
            'created_at': '2026-11-22T08:57:38Z',
            'started_at': '2026-11-22T08:57:38Z',
            'completed_at': '2026-11-22T09:59:28Z',
            'runner_id': 0, 'status': 'completed', 'conclusion': 'cancelled', 'steps': [],
        }
        cancelled = job_sample(job)
        self.assertIsNone(cancelled['started_at'])
        self.assertEqual(cancelled['queue_seconds'], 3710)
        self.assertIsNone(cancelled['runner_seconds'])

        queued = job_sample({**job, 'completed_at': None, 'status': 'queued', 'conclusion': None})
        self.assertIsNone(queued['queue_seconds'])
        self.assertIsNone(queued['runner_seconds'])

        ran = job_sample({**job, 'runner_id': 3, 'conclusion': 'success', 'started_at': '2026-11-22T09:03:38Z'})
        self.assertEqual(ran['queue_seconds'], 360)
        self.assertEqual(ran['runner_seconds'], 3350)
